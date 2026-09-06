import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './config.js';
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
app.delete('/api/setup', checkToken, (_req, res) => {
  try {
    fs.unlinkSync(SESSION_FILE);
    try {
      fs.unlinkSync(SESSION_FILE + '.bak');
    } catch { /* не обязательно */ }
    registry.clearCloudSession();
  } catch {
    /* файла нет — и не надо */
  }
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// Свободы: ставим eWeLink-аккаунт (email/пароль) при первичной настройке.
// Сохраняем только сессию (at/appid/region), НЕ пароль. Устройства не храним.
app.post('/api/setup', checkToken, async (req, res) => {
  const { login, password, region = 'eu' } = req.body || {};
  if (!login || !password) {
    return res.status(400).json({ error: 'нужны login и password' });
  }
  const result = await ewelinkLogin(String(login), String(password), String(region));
  if (!result.ok) {
    return res.status(401).json({ error: 'не удалось войти в eWeLink', detail: result });
  }
  const session = { at: result.at, appid: result.appid, region: result.region, login: String(login) };
  saveSession(session);
  registry.setCloudSession(session);
  await registry.refreshCloud();
  await registry.scanLan();
  res.json({ ok: true, devices: registry.getDevices() });
});

// Статус eWeLink-настройки (чтобы веб не просил логин/пароль заново,
// если сессия уже сохранена на сервере)
app.get('/api/setup', checkToken, (_req, res) => {
  const session = loadSession();
  if (session?.at && session?.appid) {
    res.json({ configured: true, login: session.login || null, region: session.region || null });
  } else {
    res.json({ configured: false });
  }
});

// mDNS-разведка прямо сейчас
app.get('/api/discover', checkToken, async (_req, res) => {
  try {
    await registry.scanLan();
    res.json({ found: registry.getDevices() });
  } catch (err) {
    res.status(500).json({ error: 'discover failed', detail: err.message });
  }
});

app.get('/api/devices', checkToken, (_req, res) => {
  res.json({ devices: hub.listDevices() });
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

function broadcastState() {
  const payload = JSON.stringify({ type: 'state', devices: hub.listDevices() });
  wss.clients.forEach((client) => {
    if (client.readyState === client.OPEN) client.send(payload);
  });
}

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'state', devices: hub.listDevices() }));
});

hub.on('change', broadcastState);

connectRelay(hub);

bootstrap().then(() => {
  server.listen(config.port, () => {
    console.log(`[server] Домовой (локальный сервер) слушает на порту ${config.port}`);
    console.log(`[server] LOCAL_TOKEN: ${config.localToken}`);
    console.log('[server] eWeLink-настройка: POST /api/setup {login, password, region}');
  });
});