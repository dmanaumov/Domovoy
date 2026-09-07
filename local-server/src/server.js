import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { config } from './config.js';
import { initLogBuffer, logBus } from './log-buffer.js';
import pkg from '../package.json' with { type: 'json' };

// Версия сборки: GH Actions задаёт APP_VERSION = 0.1.<число коммитов>.
// Локально (вне образа) версия просто берётся из package.json.
const APP_VERSION = process.env.APP_VERSION || pkg.version;
import { createRegistry } from './registry.js';
import { createHub } from './hub.js';
import { ewelinkLogin } from './ewelink-api.js';
import { connectRelay } from './relay-client.js';

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public'))); // веб-клиент (web/), скопированный в образ как ./public

const SESSION_FILE = process.env.EWELINK_SESSION_FILE || './data/ewelink-session.json';

function checkToken(req, res, next) {
  if (!config.localToken) return next(); // токен не задан — доступ открыт (для разработки в LAN)
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token !== config.localToken) return res.status(401).json({ error: 'unauthorized' });
  next();
}

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_FILE, 'utf-8'));
  } catch {
    return null;
  }
}

function saveSession(session) {
  try {
    fs.mkdirSync(path.dirname(SESSION_FILE), { recursive: true });
    fs.writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  } catch (err) {
    console.error(`[server] не смог сохранить сессию eWeLink (${SESSION_FILE}):`, err.message);
  }
}

const registry = createRegistry();
const hub = createHub(registry);

// первичная настройка:
// 1) mDNS-скан -> что есть в локальной сети
// 2) логин eWeLink -> devicekey и имена для найденных deviceid
async function bootstrap() {
  logBuffer = initLogBuffer();
  const session = loadSession();
  if (session?.at && session?.appid) {
    registry.setCloudSession(session);
    await registry.refreshCloud();
  }
  registry.startScanning();
  await registry.scanLan();
  console.log(`[setup] найдено устройств в LAN: ${registry.getDevices().length}`);
}

// Сброс eWeLink-настройки: забыть сохранённый токен (остальные устройства/сессии не трогаем)
async function deleteSetup() {
  try {
    fs.unlinkSync(SESSION_FILE);
    try {
      fs.unlinkSync(SESSION_FILE + '.bak');
    } catch { /* не обязательно */ }
    registry.clearCloudSession();
  } catch {
    /* файла нет — и не надо */
  }
  return { status: 200, body: { ok: true } };
}

// Ставим eWeLink-аккаунт (email/пароль) при первичной настройке.
// Сохраняем только сессию (at/appid/region), НЕ пароль. Устройства не храним.
async function doSetup(body) {
  const { login, password, region = 'eu' } = body || {};
  if (!login || !password) {
    return { status: 400, body: { error: 'нужны login и password' } };
  }
  const result = await ewelinkLogin(String(login), String(password), String(region));
  if (!result.ok) {
    return { status: 401, body: { error: 'не удалось войти в eWeLink', detail: result } };
  }
  const session = { at: result.at, appid: result.appid, region: result.region, login: String(login) };
  saveSession(session);
  registry.setCloudSession(session);
  await registry.refreshCloud();
  await registry.scanLan();
  return { status: 200, body: { ok: true, devices: registry.getDevices() } };
}

// Статус eWeLink-настройки (чтобы веб не просил логин/пароль заново,
// если сессия уже сохранена на сервере)
function getSetup() {
  const session = loadSession();
  if (session?.at && session?.appid) {
    return { status: 200, body: { configured: true, login: session.login || null, region: session.region || null } };
  }
  return { status: 200, body: { configured: false } };
}

// mDNS-разведка прямо сейчас
async function doDiscover() {
  try {
    await registry.scanLan();
    return { status: 200, body: { found: registry.getDevices() } };
  } catch (err) {
    return { status: 500, body: { error: 'discover failed', detail: err.message } };
  }
}

app.delete('/api/setup', checkToken, async (_req, res) => {
  const { status, body } = await deleteSetup();
  res.status(status).json(body);
});

app.get('/api/health', (_req, res) => res.json({ ok: true, version: APP_VERSION }));

app.post('/api/setup', checkToken, async (req, res) => {
  const { status, body } = await doSetup(req.body);
  res.status(status).json(body);
});

app.get('/api/setup', checkToken, (_req, res) => {
  const { status, body } = getSetup();
  res.status(status).json(body);
});

app.get('/api/discover', checkToken, async (_req, res) => {
  const { status, body } = await doDiscover();
  res.status(status).json(body);
});

app.get('/api/devices', checkToken, (_req, res) => {
  res.json({ devices: hub.listDevices() });
});

// Логи сервера (последние N строк). Без токена тоже можно — утечки нет,
// но чтобы не плодить открытые endpoint'ы, закрываем той же проверкой.
app.get('/api/logs', checkToken, (_req, res) => {
  res.json({ lines: logBuffer.lines() });
});

// Метрики системы для дашборда.
app.get('/api/status', checkToken, (_req, res) => {
  res.json(collectStatus());
});

app.post('/api/devices/:id/power', checkToken, async (req, res) => {
  const { id } = req.params;
  const action = (req.body?.action || '').toUpperCase();
  if (!['ON', 'OFF', 'TOGGLE'].includes(action)) {
    return res.status(400).json({ error: 'action должен быть ON, OFF или TOGGLE' });
  }
  try {
    const result = await hub.setPower(id, action);
    if (result && !result.ok) {
      return res.status(502).json({ error: 'устройство не ответило', detail: result });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// --- метрики системы (uptime, RAM, CPU) для виджета «Система» ---
function collectStatus() {
  const mem = os.totalmem();
  const cpus = os.cpus();
  // средняя загрузка за 1 мин приходит от os.loadavg() только на *nix;
  // на Windows вернёт 0-подобные значения — это ок, не критично.
  return {
    version: APP_VERSION,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    uptime: process.uptime(),        // сек, с момента старта процесса
    hostUptime: os.uptime(),         // сек, аптайм ОС
    load: os.loadavg(),
    cpus: cpus.length,
    cpuModel: cpus[0]?.model || '',
    mem: {
      total: mem,
      free: os.freemem(),
      // прикидка «используемой» памяти процессом + система
      used: mem - os.freemem(),
    },
  };
}

function broadcastNewLogLine(line) {
  const payload = JSON.stringify({ type: 'logs', lines: [line], reset: false });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

// Каждую новую строку лога пересылаем всем подключённым клиентам (append).
// Полный кеп (snapshot) клиент получает один раз при подключении.
let logBuffer = { lines: () => [] };
logBus.on('line', (line) => broadcastNewLogLine(line));

wss.on('connection', (ws) => {
  // при новом подключении отдаём и текущие устройства, и кеп логов
  ws.send(JSON.stringify({ type: 'state', devices: hub.listDevices() }));
  ws.send(JSON.stringify({ type: 'logs', lines: logBuffer.lines(), reset: true }));
  ws.send(JSON.stringify({ type: 'status', status: collectStatus() }));
});

function broadcastState() {
  const payload = JSON.stringify({ type: 'state', devices: hub.listDevices() });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

hub.on('change', broadcastState);

// Периодически обновляем метрики в дашборде (раз в 5 сек).
setInterval(() => {
  const payload = JSON.stringify({ type: 'status', status: collectStatus() });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}, 5000);

connectRelay(hub);

bootstrap().then(() => {
  server.listen(config.port, () => {
    console.log(`[server] Домовой (локальный сервер) слушает на порту ${config.port}`);
    console.log(`[server] LOCAL_TOKEN: ${config.localToken}`);
    console.log('[server] eWeLink-настройка: POST /api/setup {login, password, region}');
  });
});