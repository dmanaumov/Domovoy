// Домовой — веб-клиент.
import { APP_VERSION } from './version.js';
import { DEFAULT_CLOUD_URL } from './config.js';
// Логика: сначала пробуем достучаться до локального сервера в LAN (быстро, работает
// без интернета). Если не вышло за короткий таймаут — идём через облачный релей.

// Если открыли ссылку вида .../#pair=ТОКЕН (например, отсканировав QR с уже
// настроенного устройства — см. кнопку ⇄) — подхватываем токен сами, без
// ручного ввода, и убираем хэш из адресной строки.
(function applyPairingHashIfPresent() {
  const match = location.hash.match(/^#pair=(.+)$/);
  if (!match) return;
  localStorage.setItem('domovoy.token', decodeURIComponent(match[1]));
  history.replaceState(null, '', location.pathname + location.search);
})();

const settings = {
  get localUrl() { return localStorage.getItem('domovoy.localUrl') || ''; },
  // Известный адрес облачного релея — вписывать вручную не нужно. Важно:
  // location.origin для этого не годится, потому что эта же страница
  // открывается и с домашнего сервера (там origin — локальный, не облачный).
  get cloudUrl() { return localStorage.getItem('domovoy.cloudUrl') || DEFAULT_CLOUD_URL; },
  // Токен ЛОКАЛЬНОГО сервера (LAN) — общий для всех устройств в доме,
  // задаётся один раз (вручную или через QR-пейринг ⇄) и не меняется.
  get token() { return localStorage.getItem('domovoy.token') || ''; },
  // Токен ОБЛАЧНОЙ инсталляции — свой у каждого браузера/устройства,
  // создаётся автоматически при первом обращении к облаку (см. ensureInstallToken).
  get installToken() { return localStorage.getItem('domovoy.installToken') || ''; },
  set installToken(value) { localStorage.setItem('domovoy.installToken', value || ''); },
  save({ localUrl, cloudUrl, token }) {
    localStorage.setItem('domovoy.localUrl', localUrl || '');
    localStorage.setItem('domovoy.cloudUrl', cloudUrl || '');
    localStorage.setItem('domovoy.token', token || '');
  },
};

const statusEl = document.getElementById('status');
const devicesEl = document.getElementById('devices');

document.getElementById('version').textContent = `v${APP_VERSION}`;

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

// --- авто-регистрация инсталляции в облаке ---
// Раньше для облака был один общий CLIENT_TOKEN, который приходилось
// вводить руками. Теперь каждое устройство при первом обращении к облаку
// само создаёт себе токен через /api/register и сохраняет его у себя —
// вводить ничего не нужно. Локального (LAN) токена это не касается.
function guessAlias() {
  const ua = navigator.userAgent || '';
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android';
  if (/Macintosh/.test(ua)) return 'Mac';
  return 'Устройство';
}

async function ensureInstallToken() {
  if (settings.installToken) return;
  try {
    const res = await fetch(`${settings.cloudUrl.replace(/\/$/, '')}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ alias: guessAlias() }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.token) settings.installToken = data.token;
  } catch {
    /* нет сети — попробуем зарегистрироваться при следующем connect() */
  }
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

  await ensureInstallToken();

  if (!settings.installToken) {
    setStatus('offline');
    devicesEl.innerHTML = '<p class="hint">Не удалось зарегистрироваться в облаке — проверь адрес облачного релея (⚙) и соединение с интернетом.</p>';
    return;
  }

  currentConn = new CloudConnection(settings.cloudUrl, settings.installToken);
  currentConn.onUpdate(
    (devices) => { currentDevices = devices; rerender(); },
    (online) => setStatus(online ? 'cloud' : 'offline'),
  );
  currentConn.onAuthFailure(() => {
    // Токен могли сбросить на сервере (например, очистили installations.json) —
    // регистрируемся заново при следующей попытке.
    settings.installToken = '';
    setStatus('offline');
    devicesEl.innerHTML = '<p class="hint">Соединение с облаком сброшено — пробую переподключиться…</p>';
  });
  setStatus('cloud');
}

// --- настройки ---
const dialog = document.getElementById('settings-dialog');
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('local-url').value = settings.localUrl;
  document.getElementById('cloud-url').value = settings.cloudUrl;
  document.getElementById('token').value = settings.token;
  dialog.showModal();
});

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'default') return;
  settings.save({
    localUrl: document.getElementById('local-url').value.trim(),
    cloudUrl: document.getElementById('cloud-url').value.trim(),
    token: document.getElementById('token').value.trim(),
  });
  connect();
});

// --- QR для добавления нового устройства (часть А) ---
// Токен уже есть в этом браузере (устройство уже настроено) — рисуем QR
// со ссылкой вида <cloudUrl>/#pair=<token>. Сканирование камерой открывает
// ссылку в Safari/Chrome, и токен подставляется сам (см. applyPairingHashIfPresent выше).
const shareDialog = document.getElementById('share-dialog');
document.getElementById('share-btn').addEventListener('click', () => {
  const qrContainer = document.getElementById('qr-container');
  if (!settings.token) {
    qrContainer.innerHTML = '<p class="hint">Сначала настрой это устройство (⚙) — нечего передавать.</p>';
  } else {
    const pairUrl = `${settings.cloudUrl}/#pair=${encodeURIComponent(settings.token)}`;
    const qr = qrcode(0, 'M');
    qr.addData(pairUrl);
    qr.make();
    qrContainer.innerHTML = qr.createSvgTag(6);
  }
  shareDialog.showModal();
});
document.getElementById('share-close').addEventListener('click', () => shareDialog.close());

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

connect();
setInterval(connect, 15000); // периодически перепроверяем локально/облако (например, вернулись домой)
