import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DEVICES_FILE = process.env.DEVICES_FILE || path.resolve('devices.json');

// LOCAL_TOKEN больше не нужно придумывать и вписывать руками: если он не
// задан явно через переменную окружения, сервер сам генерирует случайный
// токен при первом запуске и сохраняет его в LOCAL_TOKEN_FILE (том/volume,
// см. docker-compose.yml), чтобы он не менялся при перезапуске/передеплое.
// Значение печатается в лог при старте (docker logs ...) — оттуда его
// нужно один раз вписать в настройки (⚙) первого клиента; дальше клиенты
// подключаются друг к другу через QR-пейринг (⇄), без повторного ввода.
const LOCAL_TOKEN_FILE = process.env.LOCAL_TOKEN_FILE || './data/local-token.json';

function loadOrCreateLocalToken() {
  if (process.env.LOCAL_TOKEN) return process.env.LOCAL_TOKEN; // явно задан — используем как есть
  try {
    const { token } = JSON.parse(fs.readFileSync(LOCAL_TOKEN_FILE, 'utf-8'));
    if (token) return token;
  } catch {
    /* файла ещё нет — создадим ниже */
  }
  const token = crypto.randomBytes(24).toString('hex');
  try {
    fs.mkdirSync(path.dirname(LOCAL_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(LOCAL_TOKEN_FILE, JSON.stringify({ token }, null, 2));
  } catch (err) {
    console.error(`[config] не смог сохранить ${LOCAL_TOKEN_FILE}:`, err.message);
  }
  return token;
}

function loadDevices() {
  if (!fs.existsSync(DEVICES_FILE)) {
    console.warn(`[config] ${DEVICES_FILE} не найден — используем пустой список устройств.`);
    return [];
  }
  const raw = fs.readFileSync(DEVICES_FILE, 'utf-8');
  return JSON.parse(raw);
}

export const config = {
  port: Number(process.env.PORT || 3000),
  mqttUrl: process.env.MQTT_URL || 'mqtt://localhost:1883',
  localToken: loadOrCreateLocalToken(),
  relayUrl: process.env.RELAY_URL || '', // например wss://domovoy.example.com — пусто = релей выключен
  relayToken: process.env.RELAY_TOKEN || '',
  devices: loadDevices(),
};
