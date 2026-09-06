// Домовой — веб-клиент.
// Логика: сначала пробуем достучаться до локального сервера в LAN (быстро, работает
// без интернета). Если не вышло за короткий таймаут — идём через облачный релей.

const settings = {
  get localUrl() { return localStorage.getItem('domovoy.localUrl') || ''; },
  // Если облачный адрес не задан явно — используем адрес, с которого сама
  // страница загружена. Так работает из коробки: страницу отдаёт cloud-relay,
  // значит именно он и есть облачный сервер, вручную вписывать нечего.
  get cloudUrl() { return localStorage.getItem('domovoy.cloudUrl') || location.origin; },
  get token() { return localStorage.getItem('domovoy.token') || ''; },
  save({ localUrl, cloudUrl, token }) {
    localStorage.setItem('domovoy.localUrl', localUrl || '');
    localStorage.setItem('domovoy.cloudUrl', cloudUrl || '');
    localStorage.setItem('domovoy.token', token || '');
  },
};

const statusEl = document.getElementById('status');
const devicesEl = document.getElementById('devices');

// --- welcome-заставка: показываем 5 секунд при каждом входе ---
const SPLASH_DURATION_MS = 5000;
const splashEl = document.getElementById('splash');
setTimeout(() => {
  splashEl.classList.add('splash--hide');
  setTimeout(() => splashEl.remove(), 500); // после fade-out убираем из DOM
}, SPLASH_DURATION_MS);

function setStatus(mode) {
  const map = {
    local: ['status--local', 'Локально'],
    cloud: ['status--cloud', 'Через облако'],
    offline: ['status--offline', 'Офлайн'],
  };
  const [cls, label] = map[mode] || map.offline;
  statusEl.className = `status ${cls}`;
  statusEl.textContent = label;
}

function renderDevices(devices, onToggle) {
  if (!devices?.length) {
    devicesEl.innerHTML = '<p class="hint">Устройства не найдены. Проверь devices.json на сервере.</p>';
    return;
  }
  devicesEl.innerHTML = '';
  for (const device of devices) {
    const card = document.createElement('div');
    card.className = 'device-card';

    const info = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = device.name;
    const lastSeen = document.createElement('span');
    lastSeen.className = 'last-seen';
    lastSeen.textContent = device.state?.lastSeen
      ? `обновлено ${new Date(device.state.lastSeen).toLocaleTimeString('ru-RU')}`
      : 'нет данных';
    info.append(name, lastSeen);

    const toggle = document.createElement('button');
    const isOn = device.state?.power === 'ON';
    toggle.className = `toggle${isOn ? ' on' : ''}`;
    toggle.setAttribute('aria-label', `Переключить ${device.name}`);
    toggle.addEventListener('click', () => onToggle(device.id, isOn ? 'OFF' : 'ON'));

    card.append(info, toggle);
    devicesEl.append(card);
  }
}

async function tryLocal(localUrl, timeoutMs = 800) {
  if (!localUrl) return false;
  try {
    const res = await fetch(`${localUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}

class LocalConnection {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.ws = new WebSocket(this.baseUrl.replace(/^http/, 'ws') + '/ws');
  }

  onUpdate(cb) {
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') cb(msg.devices);
    });
  }

  async sendCommand(deviceId, action) {
    await fetch(`${this.baseUrl}/api/devices/${deviceId}/power`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: JSON.stringify({ action }),
    });
  }

  close() { this.ws.close(); }
}

class CloudConnection {
  constructor(baseUrl, token) {
    const wsUrl = baseUrl.replace(/\/$/, '').replace(/^http/, 'ws');
    this.ws = new WebSocket(`${wsUrl}/client?token=${encodeURIComponent(token)}`);
    this._connected = false;
    this.ws.addEventListener('open', () => { this._connected = true; });
  }

  onUpdate(cb, onHomeStatus) {
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'state') cb(msg.devices);
      if (msg.type === 'home-status' && onHomeStatus) onHomeStatus(msg.online);
    });
  }

  // Срабатывает, если соединение так и не открылось (неверный токен / адрес) —
  // сервер обрывает handshake, браузер даёт это увидеть только через error/close.
  onAuthFailure(cb) {
    this.ws.addEventListener('close', () => { if (!this._connected) cb(); });
    this.ws.addEventListener('error', () => { if (!this._connected) cb(); });
  }

  async sendCommand(deviceId, action) {
    this.ws.send(JSON.stringify({ type: 'command', deviceId, action }));
  }

  close() { this.ws.close(); }
}

let currentConn = null;
let currentDevices = [];

function rerender() {
  renderDevices(currentDevices, (id, action) => currentConn?.sendCommand(id, action));
}

async function connect() {
  currentConn?.close();

  const localOk = await tryLocal(settings.localUrl);

  if (localOk) {
    setStatus('local');
    currentConn = new LocalConnection(settings.localUrl, settings.token);
    currentConn.onUpdate((devices) => { currentDevices = devices; rerender(); });
    // первичная загрузка через REST, дальше — по WS
    try {
      const res = await fetch(`${settings.localUrl.replace(/\/$/, '')}/api/devices`, {
        headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {},
      });
      const data = await res.json();
      currentDevices = data.devices;
      rerender();
    } catch { /* дождёмся данных по WS */ }
    return;
  }

  if (!settings.token) {
    setStatus('offline');
    devicesEl.innerHTML = '<p class="hint">Открой настройки (⚙) и вставь токен — тот самый CLIENT_TOKEN, который задан в переменных окружения cloud-relay в Dokploy.</p>';
    return;
  }

  if (settings.cloudUrl) {
    currentConn = new CloudConnection(settings.cloudUrl, settings.token);
    currentConn.onUpdate(
      (devices) => { currentDevices = devices; rerender(); },
      (online) => setStatus(online ? 'cloud' : 'offline'),
    );
    currentConn.onAuthFailure(() => {
      setStatus('offline');
      devicesEl.innerHTML = '<p class="hint">Не удалось подключиться к облаку — проверь токен в настройках (⚙) и что он совпадает с CLIENT_TOKEN в Dokploy.</p>';
    });
    setStatus('cloud');
    return;
  }

  setStatus('offline');
  devicesEl.innerHTML = '<p class="hint">Не задан адрес ни локального, ни облачного сервера — открой настройки (⚙).</p>';
}

// --- настройки ---
const dialog = document.getElementById('settings-dialog');
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('local-url').value = settings.localUrl;
  document.getElementById('cloud-url').value = settings.cloudUrl;
  document.getElementById('token').value = settings.token;
  dialog.showModal();
});

document.getElementById('settings-form').addEventListener('close', () => {
  if (dialog.returnValue !== 'default') return;
  settings.save({
    localUrl: document.getElementById('local-url').value.trim(),
    cloudUrl: document.getElementById('cloud-url').value.trim(),
    token: document.getElementById('token').value.trim(),
  });
  connect();
});

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

connect();
setInterval(connect, 15000); // периодически перепроверяем локально/облако (например, вернулись домой)
