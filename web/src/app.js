// Домовой — веб-клиент.
import { APP_VERSION } from './version.js';
import { DEFAULT_CLOUD_URL, DEFAULT_LOCAL_URL, DEFAULT_LOCAL_TOKEN } from './config.js';
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
  // Известный IP локального сервера в домашней сети — вписывать руками не
  // нужно (см. config.js). Токен для него всё же придётся ввести один раз:
  // его генерирует сам сервер при первом запуске (см. ниже).
  get localUrl() { return localStorage.getItem('domovoy.localUrl') || DEFAULT_LOCAL_URL; },
  // Известный адрес облачного релея — вписывать вручную не нужно. Важно:
  // location.origin для этого не годится, потому что эта же страница
  // открывается и с домашнего сервера (там origin — локальный, не облачный).
  get cloudUrl() { return localStorage.getItem('domovoy.cloudUrl') || DEFAULT_CLOUD_URL; },
  // Токен ЛОКАЛЬНОГО сервера (LAN) — общий для всех устройств в доме.
  // Известное значение зашито в config.js, вводить руками не нужно;
  // поле в настройках остаётся на случай, если сервер сгенерирует новый.
  get token() { return localStorage.getItem('domovoy.token') || DEFAULT_LOCAL_TOKEN; },
  // Токен ОБЛАЧНОЙ инсталляции — свой у каждого браузера/устройства,
  // создаётся автоматически при первом обращении к облаку (см. ensureInstallToken).
  get installToken() { return localStorage.getItem('domovoy.installToken') || ''; },
  set installToken(value) { localStorage.setItem('domovoy.installToken', value || ''); },
  // Алиас инсталляции — как эта установка подписана в списке на сервере
  // (GET /api/installations). Пользователь может задать своё название
  // в настройках (⚙) — иначе используется угаданное по User-Agent.
  get installAlias() { return localStorage.getItem('domovoy.installAlias') || ''; },
  set installAlias(value) { localStorage.setItem('domovoy.installAlias', value || ''); },
  // eWeLink-креды для админки — хранятся ТОЛЬКО в localStorage браузера
  // (на сервер уходят один раз при настройке и там не сохраняются).
  get ewelinkLogin() { return localStorage.getItem('domovoy.ewelinkLogin') || ''; },
  set ewelinkLogin(value) { localStorage.setItem('domovoy.ewelinkLogin', value || ''); },
  get ewelinkPassword() { return localStorage.getItem('domovoy.ewelinkPassword') || ''; },
  set ewelinkPassword(value) { localStorage.setItem('domovoy.ewelinkPassword', value || ''); },
  save({ localUrl, cloudUrl, token }) {
    localStorage.setItem('domovoy.localUrl', localUrl || '');
    localStorage.setItem('domovoy.cloudUrl', cloudUrl || '');
    localStorage.setItem('domovoy.token', token || '');
  },
};

const statusEl = document.getElementById('status');
const devicesEl = document.getElementById('devices');
const devicesHintEl = document.getElementById('devices-hint');
const discoverBtn = document.getElementById('discover-btn');
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

function showHint(text, { showDiscover = false } = {}) {
  devicesEl.innerHTML = '';
  devicesHintEl.textContent = text;
  devicesEl.append(devicesHintEl);
  discoverBtn.hidden = !showDiscover;
}

function buildDeviceCard(device, onToggle) {
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
  if (device.offline) toggle.disabled = true;
  toggle.addEventListener('click', () => onToggle(device.id, isOn ? 'OFF' : 'ON'));

  card.append(info, toggle);
  return card;
}

function renderDevices(devices, onToggle) {
  // ПЕРЕД рисовкой всегда очищаем контейнер — иначе каждый rerender (connect раз в 15с)
  // дописывает ещё одну полную пачку карточек к уже существующим.
  devicesEl.innerHTML = '';

  if (!devices?.length) {
    showHint(
      'Устройства не найдены. Найди их в сети (mDNS) или настрой eWeLink — это даст устройствам имена и ключи управления.',
      { showDiscover: true },
    );
    return;
  }
  discoverBtn.hidden = true;

  // Деление по домам и комнатам: группируем из метаданных облака eWeLink.
  const homes = new Map(); // homeName -> roomName -> [device]
  for (const device of devices) {
    const home = device.home || 'Дом';
    if (!homes.has(home)) homes.set(home, new Map());
    const rooms = homes.get(home);
    const room = device.room || 'Прочие';
    if (!rooms.has(room)) rooms.set(room, []);
    rooms.get(room).push(device);
  }

  for (const [homeName, rooms] of homes) {
    const homeSection = document.createElement('section');
    homeSection.className = 'home-section';

    const homeEl = document.createElement('h2');
    homeEl.className = 'home-title';
    homeEl.textContent = homeName;
    homeSection.append(homeEl);

    for (const [roomName, roomDevices] of rooms) {
      if (roomName !== 'Прочие') {
        const roomEl = document.createElement('h3');
        roomEl.className = 'room-title';
        roomEl.textContent = roomName;
        homeSection.append(roomEl);
      }
      for (const device of roomDevices) {
        homeSection.append(buildDeviceCard(device, onToggle));
      }
    }
    devicesEl.append(homeSection);
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
      body: JSON.stringify({ alias: settings.installAlias || guessAlias() }),
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.token) settings.installToken = data.token;
  } catch {
    /* нет сети — попробуем зарегистрироваться при следующем connect() */
  }
}

// Пользователь поменял алиас в настройках уже после регистрации —
// сообщаем об этом серверу (аутентификация — сам installToken, он же id).
async function updateInstallAlias(alias) {
  if (!settings.installToken || !alias) return;
  try {
    await fetch(`${settings.cloudUrl.replace(/\/$/, '')}/api/installations/alias`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.installToken}`,
      },
      body: JSON.stringify({ alias }),
    });
  } catch { /* не критично, попробуем в другой раз */ }
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
    showHint('Не удалось зарегистрироваться в облаке — проверь адрес облачного релея (⚙) и соединение с интернетом.');
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
    showHint('Соединение с облаком сброшено — пробую переподключиться…');
  });
  setStatus('cloud');
}

// --- настройки ---
const dialog = document.getElementById('settings-dialog');

function openSettingsDialog() {
  document.getElementById('local-url').value = settings.localUrl;
  document.getElementById('cloud-url').value = settings.cloudUrl;
  document.getElementById('token').value = settings.token;
  document.getElementById('install-alias').value = settings.installAlias;
  document.getElementById('install-alias').placeholder = guessAlias();
  dialog.showModal();
}

document.getElementById('settings-btn').addEventListener('click', openSettingsDialog);

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'default') return;
  settings.save({
    localUrl: document.getElementById('local-url').value.trim(),
    cloudUrl: document.getElementById('cloud-url').value.trim(),
    token: document.getElementById('token').value.trim(),
  });
  const alias = document.getElementById('install-alias').value.trim();
  if (alias !== settings.installAlias) {
    settings.installAlias = alias;
    updateInstallAlias(alias);
  }
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

// --- кнопка «Найти устройства» над подсказкой ---
discoverBtn.addEventListener('click', () => runDiscover());

// --- диалог администратора ---
const adminDialog = document.getElementById('admin-dialog');
const adminResultEl = document.getElementById('admin-result');

document.getElementById('admin-btn').addEventListener('click', () => {
  adminDialog.showModal();
  updateAdminUi();
});

async function updateAdminUi() {
  const formEl = document.getElementById('admin-form');
  const configuredEl = document.getElementById('admin-configured');
  const configuredTitle = document.getElementById('admin-configured-title');
  const configuredDesc = document.getElementById('admin-configured-desc');
  const resetBtn = document.getElementById('admin-reset');
  let hasSession = false;
  try {
    const res = await fetch(`${settings.localUrl.replace(/\/$/, '')}/api/setup`, {
      headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {},
    });
    const data = await res.json();
    hasSession = data.configured === true;
    if (hasSession) {
      configuredTitle.textContent = 'Домовой подключён к eWeLink';
      configuredDesc.textContent = `Токен доступа сохранён на сервере${data.login ? ` для ${data.login}` : ''}${data.region ? ` (${data.region})` : ''}. Устройства уже есть — можно делиться по сети.`;
    }
  } catch {
    /* сервер недоступен — покажем форму */
  }
  configuredEl.hidden = !hasSession;
  formEl.hidden = hasSession;
  resetBtn.hidden = !hasSession;
  if (hasSession) {
    const loginEl = document.getElementById('ewelink-login');
    const passwordEl = document.getElementById('ewelink-password');
    if (!loginEl.value && settings.ewelinkLogin) loginEl.value = settings.ewelinkLogin;
    if (!passwordEl.value && settings.ewelinkPassword) passwordEl.value = settings.ewelinkPassword;
  }
}

document.getElementById('admin-close').addEventListener('click', () => adminDialog.close());

// Сбросить eWeLink-сессию на сервере (стереть токен доступа)
document.getElementById('admin-reset').addEventListener('click', async () => {
  adminResultEl.textContent = 'Удаляю токен eWeLink…';
  try {
    const res = await fetch(`${settings.localUrl.replace(/\/$/, '')}/api/setup`, {
      method: 'DELETE',
      headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {},
    });
    const data = await res.json();
    if (data.error) {
      adminResultEl.textContent = `Ошибка: ${data.error}`;
    } else {
      settings.ewelinkLogin = '';
      settings.ewelinkPassword = '';
      document.getElementById('ewelink-password').value = '';
      adminResultEl.textContent = 'Сессия eWeLink удалена. При необходимости введи логин и пароль заново.';
      updateAdminUi();
    }
  } catch (err) {
    adminResultEl.textContent = `Не удалось обратиться к серверу: ${err.message}`;
  }
});

// --- eWeLink: сохранение логина/пароля (пароль не сохраняется на сервере) ---
document.getElementById('admin-save').addEventListener('click', async () => {
  const login = document.getElementById('ewelink-login').value.trim();
  const password = document.getElementById('ewelink-password').value.trim();
  const region = document.getElementById('ewelink-region').value;

  if (!login || !password) {
    adminResultEl.textContent = 'Заполни логин и пароль eWeLink.';
    return;
  }
  settings.ewelinkLogin = login;
  settings.ewelinkPassword = password;
  adminResultEl.textContent = 'Подключаюсь к eWeLink…';
  try {
    const res = await fetch(`${settings.localUrl.replace(/\/$/, '')}/api/setup`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(settings.token ? { Authorization: `Bearer ${settings.token}` } : {}),
      },
      body: JSON.stringify({ login, password, region }),
    });
    const data = await res.json();
    if (data.error) {
      adminResultEl.textContent = `Ошибка: ${data.message || data.error}`;
    } else {
      adminResultEl.textContent = `Готово! Получено устройств: ${data.devices?.length ?? 0}. Теперь нажми «Найти устройства».`;
      document.getElementById('ewelink-password').value = '';
      settings.ewelinkPassword = '';
    }
  } catch (err) {
    adminResultEl.textContent = `Не удалось обратиться к серверу: ${err.message}`;
  }
});

// --- mDNS-разведка ---
async function runDiscover() {
  discoverBtn.hidden = true;
  showHint('Сканирую сеть…');
  try {
    const res = await fetch(`${settings.localUrl.replace(/\/$/, '')}/api/discover`, {
      headers: settings.token ? { Authorization: `Bearer ${settings.token}` } : {},
    });
    const data = await res.json();
    currentDevices = data.devices || [];
    rerender();
    if (!currentDevices.length) {
      showHint('В локальной сети ничего не найдено. Убедись, что устройства в одной Wi-Fi сети с сервером.', { showDiscover: true });
    }
  } catch (err) {
    showHint(`Не удалось связаться с сервером: ${err.message}`, { showDiscover: true });
  }
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Первый запуск на этом устройстве: адрес локального сервера уже известен
// (см. config.js), но токен для него сервер генерирует сам при старте и
// его нужно один раз вписать вручную (см. лог local-server). Без него
// открывать настройки самим пользователем незачем было бы объяснять —
// поэтому открываем их сразу.
if (!settings.token) openSettingsDialog();

connect();
setInterval(connect, 15000); // периодически перепроверяем локально/облако (например, вернулись домой)
