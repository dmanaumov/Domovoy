// Хранилище инсталляций веб-клиента.
// Раньше все клиенты входили по одному общему CLIENT_TOKEN из .env.
// Теперь каждый браузер/устройство при первом запуске сам создаёт себе
// токен через POST /api/register и дальше входит под ним — вводить
// ничего вручную не нужно. Здесь же держим alias и дату последней
// активности каждой инсталляции (см. GET /api/installations).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// По умолчанию — ./data/installations.json относительно WORKDIR (/app в контейнере).
// В docker-compose.yml на этот путь примонтирован volume, чтобы список
// не терялся при передеплое.
const FILE = process.env.INSTALLATIONS_FILE || './data/installations.json';

function load() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

const installations = load();

function persist() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(installations, null, 2));
  } catch (err) {
    console.error('[relay] не смог сохранить installations.json:', err.message);
  }
}

export function register(alias) {
  const token = crypto.randomBytes(24).toString('hex');
  installations[token] = {
    alias: (alias || 'Устройство').toString().slice(0, 60),
    createdAt: new Date().toISOString(),
    lastSeen: new Date().toISOString(),
  };
  persist();
  return token;
}

export function isValid(token) {
  return Boolean(token && installations[token]);
}

export function touch(token) {
  if (!installations[token]) return;
  installations[token].lastSeen = new Date().toISOString();
  persist();
}

export function list() {
  return Object.entries(installations)
    .map(([token, info]) => ({ id: token.slice(0, 8), ...info }))
    .sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}
