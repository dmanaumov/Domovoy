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

// Heartbeat «дома»: пока живой канал отвечает на ping, он не вытесняется
// (решает пинг-понг между NAS и dev-машиной с одним RELAY_TOKEN). Если же
// подключённый сервер реально умер/перезагрузился и перестал отвечать —
// закрываем его и освобождаем слот для настоящего «дома».
const HOME_PING_INTERVAL_MS = 5000;
setInterval(() => {
  if (!homeSocket) return;
  if (homeSocket.isAlive === false) {
    console.log('[relay] дом не отвечает на ping — закрываю соединение');
    homeSocket.terminate();
    return;
  }
  homeSocket.isAlive = false;
  homeSocket.ping();
}, HOME_PING_INTERVAL_MS);

// Простая админ-страница со списком зарегистрированных инсталляций.
// Сама страница не содержит секретов — токен (RELAY_TOKEN) вводится
// в браузере и хранится только в его localStorage, запросы идут к уже
// защищённому GET /api/installations.
const ADMIN_HTML = `<!doctype html>
<html lang="ru">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Домовой — админка</title>
<link rel="stylesheet" href="/src/style.css" />
<style>
  body { padding: 1.5rem; padding-bottom: 1.5rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { text-align: left; padding: 0.5rem 0.75rem; border-bottom: 1px solid var(--off); font-size: 0.9rem; }
  th { color: var(--muted); font-weight: 500; }
  #login { display: flex; gap: 0.5rem; max-width: 420px; }
  #login input { flex: 1; padding: 0.5rem; border-radius: 8px; border: 1px solid var(--off); background: var(--card); color: var(--text); }
  #login button, #logout { padding: 0.5rem 1rem; border-radius: 8px; border: none; background: var(--accent); color: #1a1512; cursor: pointer; }
  #logout { background: var(--off); color: var(--text); margin-top: 1rem; }
  .error { color: #e07a72; margin-top: 0.5rem; }
  .hint { color: var(--muted); }
</style>
</head>
<body>
  <h1>Домовой — зарегистрированные инсталляции</h1>
  <div id="login">
    <input type="password" id="relay-token" placeholder="RELAY_TOKEN" />
    <button id="login-btn">Войти</button>
  </div>
  <p id="error" class="error"></p>
  <div id="content" hidden>
    <table>
      <thead><tr><th>Alias</th><th>ID</th><th>Создана</th><th>Последняя активность</th></tr></thead>
      <tbody id="rows"></tbody>
    </table>
    <button id="logout">Выйти</button>
  </div>
<script>
  const KEY = 'domovoy.adminToken';
  const errorEl = document.getElementById('error');
  const loginEl = document.getElementById('login');
  const contentEl = document.getElementById('content');
  const rowsEl = document.getElementById('rows');

  function fmt(iso) {
    if (!iso) return '\u2014';
    return new Date(iso).toLocaleString('ru-RU');
  }

  async function load(token) {
    errorEl.textContent = '';
    try {
      const res = await fetch('/api/installations', { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 401) {
        localStorage.removeItem(KEY);
        loginEl.hidden = false;
        contentEl.hidden = true;
        errorEl.textContent = 'Неверный RELAY_TOKEN.';
        return;
      }
      const data = await res.json();
      rowsEl.innerHTML = '';
      for (const inst of data.installations) {
        const tr = document.createElement('tr');
        tr.innerHTML = \`<td>\${inst.alias}</td><td>\${inst.id}</td><td>\${fmt(inst.createdAt)}</td><td>\${fmt(inst.lastSeen)}</td>\`;
        rowsEl.append(tr);
      }
      loginEl.hidden = true;
      contentEl.hidden = false;
    } catch {
      errorEl.textContent = 'Не удалось загрузить список.';
    }
  }

  document.getElementById('login-btn').addEventListener('click', () => {
    const token = document.getElementById('relay-token').value.trim();
    if (!token) return;
    localStorage.setItem(KEY, token);
    load(token);
  });

  document.getElementById('logout').addEventListener('click', () => {
    localStorage.removeItem(KEY);
    loginEl.hidden = false;
    contentEl.hidden = true;
  });

  const saved = localStorage.getItem(KEY);
  if (saved) load(saved);
</script>
</body>
</html>`;

app.get('/admin', (_req, res) => res.type('html').send(ADMIN_HTML));

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
  // Разрешаем ОДНО активное соединение «дома». Раньше новое подключение
  // закрывало предыдущее — и если два сервера (например NAS и dev-машина)
  // используют один RELAY_TOKEN, они «пинг-понгом» выбивали друг друга:
  // релей каждые reconnectDelay переключался с одного списка на другой.
  // Теперь занятый живой канал не вытесняется — дубль просто закрываем.
  // Канал без ответа на ping (сервер умер/перезагрузился) освобождается
  // heartbeat-интервалом выше, и следующее подключение станет активным.
  if (homeSocket && homeSocket.readyState === homeSocket.OPEN) {
    console.log('[relay] дом уже подключён — игнорирую дублирующее соединение');
    ws.send(JSON.stringify({ type: 'error', error: 'home_already_connected' }));
    ws.close();
    return;
  }

  console.log('[relay] дом подключился');
  ws.isAlive = true;
  homeSocket = ws;
  broadcastHomeStatus(true);

  ws.on('pong', () => {
    ws.isAlive = true;
  });

  ws.on('message', (raw) => {
    ws.isAlive = true;
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
