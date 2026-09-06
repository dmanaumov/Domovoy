import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { WebSocketServer } from 'ws';
import { URL } from 'node:url';
import * as installations from './installations.js';

const PORT = Number(process.env.PORT || 8080);
const RELAY_TOKEN = process.env.RELAY_TOKEN || ''; // должен совпадать с local-server .env

const app = express();
app.use(express.json());
app.use(express.static(path.resolve('public'))); // веб-клиент (web/), скопированный в образ как ./public

let homeSocket = null;
let lastState = { devices: [] };
const clientSockets = new Set();

app.get('/api/status', (_req, res) => {
  res.json({ homeOnline: homeSocket !== null, lastState });
});

// Клиент сам регистрируется при первом запуске — получает свой токен,
// вводить ничего не нужно. Алиас — просто подпись для списка ниже.
app.post('/api/register', (req, res) => {
  const alias = typeof req.body?.alias === 'string' ? req.body.alias : '';
  const token = installations.register(alias);
  res.json({ token });
});

// Список инсталляций (алиас, последняя активность) — своя мини-админка.
// Защищена тем же RELAY_TOKEN, что и подключение домашнего сервера.
app.get('/api/installations', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!RELAY_TOKEN || token !== RELAY_TOKEN) return res.status(401).json({ error: 'unauthorized' });
  res.json({ installations: installations.list() });
});

// Пользователь может задать своей инсталляции читаемое имя (⚙ → "Алиас
// этого устройства"). Аутентификация здесь — собственный installToken
// клиента: он же и есть id записи, которую меняем.
app.post('/api/installations/alias', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!installations.isValid(token)) return res.status(401).json({ error: 'unauthorized' });
  const alias = typeof req.body?.alias === 'string' ? req.body.alias : '';
  installations.setAlias(token, alias);
  res.json({ ok: true });
});

const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get('token');

  if (url.pathname === '/home') {
    if (!RELAY_TOKEN || token !== RELAY_TOKEN) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handleHome(ws));
  } else if (url.pathname === '/client') {
    if (!installations.isValid(token)) return socket.destroy();
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, token));
  } else {
    socket.destroy();
  }
});

function handleHome(ws) {
  console.log('[relay] дом подключился');
  if (homeSocket) homeSocket.close(); // разрешаем только одно активное домашнее соединение
  homeSocket = ws;
  broadcastHomeStatus(true);

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'state') {
      lastState = { devices: msg.devices };
      broadcastToClients(msg);
    }
  });

  ws.on('close', () => {
    console.log('[relay] дом отключился');
    if (homeSocket === ws) homeSocket = null;
    broadcastHomeStatus(false);
  });
}

function handleClient(ws, token) {
  installations.touch(token);
  clientSockets.add(ws);
  ws.send(JSON.stringify({ type: 'state', devices: lastState.devices }));
  ws.send(JSON.stringify({ type: 'home-status', online: homeSocket !== null }));

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.type === 'command') {
      if (!homeSocket) {
        ws.send(JSON.stringify({ type: 'error', error: 'home_offline' }));
        return;
      }
      homeSocket.send(JSON.stringify(msg));
    }
  });

  ws.on('close', () => clientSockets.delete(ws));
}

function broadcastToClients(msg) {
  const payload = JSON.stringify(msg);
  clientSockets.forEach((ws) => {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  });
}

function broadcastHomeStatus(online) {
  broadcastToClients({ type: 'home-status', online });
}

server.listen(PORT, () => {
  console.log(`[relay] Домовой (облачный релей) слушает на порту ${PORT}`);
});
