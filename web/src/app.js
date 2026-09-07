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
const discoverBtn = document.getElementById('discover-btn');
let mode = 'local'; // 'local' | 'cloud' — от mode зависит, что показываем
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

// --- иконки (инлайн SVG, без внешних шрифтов — офлайн-режим не должен зависеть от сети) ---
const HOME_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v9a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1v-9"/></svg>';
const PLUG_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0V8z"/><path d="M12 17v5"/></svg>';

// Единая заготовка «пусто»: иконка + текст + (опционально) кнопка поиска устройств.
// Кнопка поиска — один и тот же DOM-узел (объявлен в index.html), а не копия:
// он просто переносится в нужное место при каждом рендере, поэтому его
// видимость управляется надёжно, а не теряется после первой перерисовки.
function buildEmptyState(text, { withDiscover = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'empty-state';
  const icon = document.createElement('div');
  icon.className = 'empty-state__icon';
  icon.innerHTML = HOME_ICON;
  const p = document.createElement('p');
  p.textContent = text;
  wrap.append(icon, p);
  // mDNS-поиск и eWeLink живут на ЛОКАЛЬНОМ сервере — в облаке их не показываем
  if (withDiscover && mode === 'local') {
    discoverBtn.hidden = false;
    wrap.append(discoverBtn);
  } else {
    discoverBtn.hidden = true;
  }
  return wrap;
}

function showHint(text, { showDiscover = false } = {}) {
  widgetPatches = {};
  devicesEl.innerHTML = '';
  devicesEl.append(buildEmptyState(text, { withDiscover: showDiscover }));
}

function buildDeviceCard(device, onToggle) {
  const offline = device.offline === true;
  const noKey = !device.devicekey;
  const isOn = device.state?.power === 'ON';
  const card = document.createElement('div');
  card.className = `device-card${offline ? ' device-card--offline' : ''}${isOn ? ' is-on' : ''}`;

  const icon = document.createElement('div');
  icon.className = 'device-card__icon';
  icon.innerHTML = PLUG_ICON;

  const info = document.createElement('div');
  info.className = 'device-card__body';
  const name = document.createElement('div');
  name.className = 'name';
  name.textContent = device.name;
  if (device.ip) {
    const ip = document.createElement('span');
    ip.className = 'device-ip';
    ip.textContent = device.ip;
    name.append(ip);
  }
  const lastSeen = document.createElement('span');
  lastSeen.className = 'last-seen';
  if (offline) {
    lastSeen.textContent = 'нет в сети';
  } else {
    lastSeen.textContent = device.state?.lastSeen
      ? `обновлено ${new Date(device.state.lastSeen).toLocaleTimeString('ru-RU')}`
      : noKey ? 'ждёт настройки eWeLink'
        : 'нет данных';
  }
  info.append(name, lastSeen);

  const toggle = document.createElement('button');
  toggle.className = `toggle${isOn ? ' on' : ''}`;
  toggle.setAttribute('aria-label', `Переключить ${device.name}`);
  toggle.disabled = offline;
  toggle.addEventListener('click', () => onToggle(device.id, isOn ? 'OFF' : 'ON'));

  card.append(icon, info, toggle);
  return card;
}

function renderDevices(devices, onToggle) {
  if (!devices?.length) {
    return buildEmptyState(
      'Устройства не найдены. Найди их в сети (mDNS) или настрой eWeLink — это даст устройствам имена и ключи управления.',
      { withDiscover: true },
    );
  }

  const root = document.createElement('div');
  root.className = 'devices-inner';
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
    root.append(homeSection);
  }
  return root;
}

async function tryLocal(localUrl, timeoutMs = 800) {
  if (!localUrl) return null; // null = локальный сервер недоступен
  try {
    const res = await fetch(`${localUrl.replace(/\/$/, '')}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    try {
      const data = await res.json();
      return data?.version || '';
    } catch {
      return '';
    }
  } catch {
    return null;
  }
}

function updateVersionLabel(serverVersion = '') {
  const versionEl = document.getElementById('version');
  versionEl.textContent = `v${APP_VERSION}${serverVersion ? ` · сервер v${serverVersion}` : ''}`;
}

class LocalConnection {
  constructor(baseUrl, token) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.token = token;
    this.ws = new WebSocket(this.baseUrl.replace(/^http/, 'ws') + '/ws');
  }

  onMessage(cb) {
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      cb(msg);
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

// Раньше здесь жил ещё виджет «Система» (мини-копия загрузки CPU/RAM прямо
// на вкладке «Устройства») — убрал: с появлением отдельной вкладки
// «Загрузка ресурсов» это был дублирующий кусок интерфейса.
const WIDGETS = {
  devices: { title: 'Устройства', build: renderDevicesWidget },
};
const DASH_KEY = 'domovoy.dashboard';

function loadWidgetOrder() {
  try {
    const order = JSON.parse(localStorage.getItem(DASH_KEY));
    if (Array.isArray(order) && order.length) return order.filter((id) => WIDGETS[id]);
  } catch { /* битый кеш */ }
  return Object.keys(WIDGETS);
}
function saveWidgetOrder(order) {
  localStorage.setItem(DASH_KEY, JSON.stringify(order));
}
let widgetOrder = loadWidgetOrder();

function renderDevicesWidget() {
  return renderDevices(currentDevices, (id, action) => currentConn?.sendCommand(id, action));
}

function fmtBytes(n) {
  if (n == null) return '…';
  const u = ['Б', 'КБ', 'МБ', 'ГБ'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${u[i]}`;
}
function formatUptime(sec) {
  sec = Math.floor(sec);
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м ${sec % 60}с`;
}

function buildWidgetCard(id) {
  const w = WIDGETS[id];
  const card = document.createElement('section');
  card.className = 'dash-widget';
  card.dataset.widget = id;

  const title = document.createElement('div');
  title.className = 'dash-widget__title';
  const label = document.createElement('span');
  label.textContent = w.title;
  const more = document.createElement('button');
  more.className = 'dash-widget__menu';
  more.setAttribute('aria-label', `Меню виджета ${w.title}`);
  more.textContent = '⋯';
  more.addEventListener('click', (e) => openWidgetMenu(id, more));
  title.append(label, more);
  card.append(title);

  const body = document.createElement('div');
  body.append(w.build());
  card.append(body);
  return { card, body };
}

function openWidgetMenu(id, anchor) {
  const existing = document.querySelector('.dash-menu');
  if (existing) existing.remove();

  const menu = document.createElement('div');
  menu.className = 'dash-menu';
  const pos = widgetOrder.indexOf(id);
  const up = document.createElement('button');
  up.disabled = pos <= 0;
  up.textContent = '↑ вверх';
  up.addEventListener('click', () => { moveWidget(id, -1); menu.remove(); });
  const down = document.createElement('button');
  down.disabled = pos >= widgetOrder.length - 1;
  down.textContent = '↓ вниз';
  down.addEventListener('click', () => { moveWidget(id, 1); menu.remove(); });
  const hide = document.createElement('button');
  hide.textContent = 'скрыть';
  hide.addEventListener('click', () => { toggleWidget(id); menu.remove(); });
  menu.append(up, down, hide);
  anchor.after(menu);
  menu.style.position = 'fixed';
  const r = anchor.getBoundingClientRect();
  menu.style.top = `${r.bottom + 4}px`;
  menu.style.left = `${Math.max(4, r.left - 40)}px`;
  const dismiss = (ev) => { if (!menu.contains(ev.target) && ev.target !== anchor) { menu.remove(); document.removeEventListener('click', dismiss); } };
  setTimeout(() => document.addEventListener('click', dismiss), 0);
}

function moveWidget(id, delta) {
  const i = widgetOrder.indexOf(id);
  const j = i + delta;
  if (j < 0 || j >= widgetOrder.length) return;
  [widgetOrder[i], widgetOrder[j]] = [widgetOrder[j], widgetOrder[i]];
  saveWidgetOrder(widgetOrder);
  rerender();
}
function toggleWidget(id) {
  if (widgetOrder.length === 1) return; // не даём скрыть последний
  widgetOrder = widgetOrder.filter((w) => w !== id);
  saveWidgetOrder(widgetOrder);
  rerender();
}

let widgetPatches = {}; // id -> () => перерисовать «живое» содержимое виджета
function renderDashboard() {
  devicesEl.innerHTML = '';
  discoverBtn.hidden = true;
  widgetPatches = {};

  // Сейчас виджет всего один («Устройства») — без карточки-обвязки и меню
  // реорганизации, это просто список устройств. Обвязка (buildWidgetCard)
  // осталась в коде на будущее, если виджетов снова станет больше одного.
  if (widgetOrder.length <= 1) {
    const id = widgetOrder[0] || 'devices';
    widgetPatches[id] = () => { devicesEl.innerHTML = ''; devicesEl.append(WIDGETS[id].build()); };
    widgetPatches[id]();
    return;
  }

  widgetOrder.forEach((id) => {
    const { card, body } = buildWidgetCard(id);
    widgetPatches[id] = () => { body.innerHTML = ''; body.append(WIDGETS[id].build()); };
    devicesEl.append(card);
    widgetPatches[id]();
  });
}

// Перерисовывает «живой» контент устройств без пересоздания каркаса.
function rerender() {
  if (Object.keys(widgetPatches).length) {
    widgetOrder.forEach((id) => widgetPatches[id]?.());
    return;
  }
  renderDashboard();
}
function setSystemStatus(status) {
  // Обновляем вкладку «Загрузка ресурсов» и, заодно, версию сервера в шапке,
  // если она изменилась (например, после передеплоя local-server).
  updateResources(status);
  if (status?.version) updateVersionLabel(status.version);
}

function updateResources(s) {
  if (!s) return;
  const cpuPct = s.load?.[0] != null ? Math.min(100, Math.round((s.load[0] / (s.cpus || 1)) * 100)) : 0;
  const ramUsed = s.mem?.used != null && s.mem?.total ? Math.round((s.mem.used / s.mem.total) * 100) : 0;

  resCpuValue.textContent = `${cpuPct}%`;
  resCpuBar.style.width = `${cpuPct}%`;
  resCpuBar.style.background = pctColor(cpuPct);
  resCpuSub.textContent = s.load?.length ? `загрузка: ${s.load.map((v) => v.toFixed(2)).join(' / ')} · ${s.cpus} ядер` : '';

  resRamValue.textContent = `${ramUsed}%`;
  resRamBar.style.width = `${ramUsed}%`;
  resRamBar.style.background = pctColor(ramUsed);
  resRamSub.textContent = s.mem ? `${fmtBytes(s.mem.used)} / ${fmtBytes(s.mem.total)}` : '';

  resUptimeValue.textContent = s.uptime != null ? formatUptime(s.uptime) : '—';
  resUptimeSub.textContent = 'с момента запуска сервера';

  cpuHist.push(cpuPct); cpuHist.shift();
  ramHist.push(ramUsed); ramHist.shift();
  redrawResourceGraphs();
}

// --- ЛОГИ (панель внизу во всю ширину) ---
const logPanelEl = document.getElementById('logpanel');
const logsOutputEl = document.getElementById('logs-output');
const logsFilterEl = document.getElementById('logs-filter');
const logsLiveEl = document.getElementById('logs-live');
let allLogLines = [];
let logPanelOpen = false;

// Лог включён на локальном сервере всегда (там и живут логи). Панель показываем
// при старте свёрнутой, но подключаем поток независимо от табов.
function openLogPanel() {
  logPanelOpen = true;
  logPanelEl.hidden = false;
  applyLogFilter();
}
// Кликабельна вся шапка (не только маленькая стрелка) — легче попасть пальцем.
document.getElementById('logs-toggle-head').addEventListener('click', () => {
  const collapsed = logPanelEl.classList.toggle('logpanel--min');
  if (!collapsed) applyLogFilter();
});
document.getElementById('logs-clear').addEventListener('click', () => {
  allLogLines = [];
  logsOutputEl.textContent = '';
});
logsFilterEl.addEventListener('input', applyLogFilter);
logsFilterEl.addEventListener('focus', () => { logsLiveEl.checked = false; });

function handleLogLines(lines, reset) {
  if (reset) allLogLines = [];
  allLogLines.push(...lines);
  if (allLogLines.length > 2000) allLogLines = allLogLines.slice(-2000);
  if (logPanelOpen) applyLogFilter();
}

function applyLogFilter() {
  const q = logsFilterEl.value.trim().toLowerCase();
  const shown = q ? allLogLines.filter((l) => l.toLowerCase().includes(q)) : allLogLines;
  logsOutputEl.textContent = shown.length ? shown.join('\n') : '(нет совпадений)';
  if (logsLiveEl.checked) logsOutputEl.scrollTop = logsOutputEl.scrollHeight;
}

// --- Загрузка ресурсов (CPU/RAM) + графики ---
const resCpuValue = document.getElementById('res-cpu-value');
const resCpuBar = document.getElementById('res-cpu-bar');
const resCpuSub = document.getElementById('res-cpu-sub');
const resRamValue = document.getElementById('res-ram-value');
const resRamBar = document.getElementById('res-ram-bar');
const resRamSub = document.getElementById('res-ram-sub');
const resUptimeValue = document.getElementById('res-uptime-value');
const resUptimeSub = document.getElementById('res-uptime-sub');
const cpuCtx = document.getElementById('res-cpu-chart').getContext('2d');
const ramCtx = document.getElementById('res-ram-chart').getContext('2d');
const CPU_HISTORY = 60;
const cpuHist = new Array(CPU_HISTORY).fill(0);
const ramHist = new Array(CPU_HISTORY).fill(0);

function pctColor(p) {
  return p < 60 ? 'var(--on)' : p < 85 ? 'var(--accent)' : '#e07a72';
}

// Canvas не умеет var(...) в fillStyle/strokeStyle — читаем реальное значение
// переменной темы, чтобы график не оставался «жёстко оранжевым» в тёмной теме.
function cssVar(name, fallback) {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

// Плавный спарклайн (линия + мягкая заливка градиентом), а не блочные столбики —
// компактно ложится прямо внутрь карточки метрики.
function renderResourceGraph(ctx, data, colorStyle) {
  const canvas = ctx.canvas;
  const cssW = canvas.clientWidth || 200;
  const cssH = canvas.clientHeight || 40;
  const dpr = window.devicePixelRatio || 1;
  const pxW = Math.round(cssW * dpr);
  const pxH = Math.round(cssH * dpr);
  if (canvas.width !== pxW || canvas.height !== pxH) {
    canvas.width = pxW;
    canvas.height = pxH;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);
  if (cssW <= 0 || cssH <= 0 || data.length < 2) return;

  const pad = 2;
  const stepX = (cssW - pad * 2) / (data.length - 1);
  const points = data.map((v, i) => [
    pad + i * stepX,
    pad + (1 - Math.min(1, Math.max(0, v / 100))) * (cssH - pad * 2),
  ]);

  const gradient = ctx.createLinearGradient(0, 0, 0, cssH);
  gradient.addColorStop(0, colorStyle);
  gradient.addColorStop(1, 'transparent');

  ctx.beginPath();
  ctx.moveTo(points[0][0], cssH);
  points.forEach(([x, y]) => ctx.lineTo(x, y));
  ctx.lineTo(points[points.length - 1][0], cssH);
  ctx.closePath();
  ctx.globalAlpha = 0.22;
  ctx.fillStyle = gradient;
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = colorStyle;
  ctx.lineWidth = 1.75;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.stroke();
}

function redrawResourceGraphs() {
  renderResourceGraph(cpuCtx, cpuHist, cssVar('--accent', '#c96f2e'));
  renderResourceGraph(ramCtx, ramHist, cssVar('--on', '#2f8f56'));
}

// --- Вкладки: Устройства / Загрузка ресурсов ---
function showTabs() { document.getElementById('tabs').hidden = false; }
function hideTabs() { document.getElementById('tabs').hidden = true; switchTab('devices'); }

function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === name));
  document.getElementById('panel-devices').hidden = name !== 'devices';
  document.getElementById('panel-resources').hidden = name !== 'resources';
  if (name === 'resources') redrawResourceGraphs();
}
document.querySelectorAll('.tab-btn').forEach((b) => {
  b.addEventListener('click', () => switchTab(b.dataset.tab));
});

async function connect() {
  currentConn?.close();

  const localVer = await tryLocal(settings.localUrl);

  if (localVer !== null) {
    setStatus('local');
    mode = 'local';
    updateVersionLabel(localVer);
    document.getElementById('admin-btn').hidden = false;
    showTabs();
    openLogPanel();
    currentConn = new LocalConnection(settings.localUrl, settings.token);
    currentConn.onMessage((msg) => {
      if (msg.type === 'state') { currentDevices = msg.devices; rerender(); }
      if (msg.type === 'logs') handleLogLines(msg.lines, msg.reset);
      if (msg.type === 'status') setSystemStatus(msg.status);
    });
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
  mode = 'cloud';
  // В облаке eWeLink/mDNS настраивается ТОЛЬКО на локальном сервере —
  // тут админка не нужна, показываем лишь то, что шлёт локальный сервер.
  document.getElementById('admin-btn').hidden = true;
  hideTabs();
  logPanelEl.hidden = true;
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
