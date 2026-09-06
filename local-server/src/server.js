import express from 'express';
import { WebSocketServer } from 'ws';
import http from 'node:http';
import path from 'node:path';
import { config } from './config.js';
import { createMqttHub } from './mqtt.js';
import { discoverDevices } from './discovery.js';
import { connectRelay } from './relay-client.js';

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public'))); // веб-клиент (web/), скопированный в образ как ./public

function checkToken(req, res, next) {
  if (!config.localToken) return next(); // токен не задан — доступ открыт (для разработки в LAN)
  const header = req.get('authorization') || '';
  const token = header.replace(/^Bearer\s+/i, '');
  if (token !== config.localToken) return res.status(401).json({ error: 'unauthorized' });
  next();
}

const hub = createMqttHub();

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// mDNS-разведка: найти eWeLink-устройства в локальной сети
// (devicekey не передаётся в mDNS — будет заполнен из devices.json / настройки)
app.get('/api/discover', checkToken, async (_req, res) => {
  try {
    const found = await discoverDevices();
    const known = new Set(config.devices.map((d) => d.deviceid));
    res.json({
      found: found.map((d) => ({
        ...d,
        known: known.has(d.deviceid), // уже добавлено в систему?
      })),
    });
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

server.listen(config.port, () => {
  console.log(`[server] Домовой (локальный сервер) слушает на порту ${config.port}`);
  console.log(`[server] LOCAL_TOKEN: ${config.localToken}`);
  console.log('[server] Впиши этот токен в настройки (⚙) первого клиента — дальше остальные');
  console.log('[server] устройства подключаются через QR-пейринг (⇄), без повторного ввода.');
});
