import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';

const DEVICES_FILE = process.env.DEVICES_FILE || path.resolve('devices.json');

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
  localToken: process.env.LOCAL_TOKEN || '',
  relayUrl: process.env.RELAY_URL || '', // например wss://domovoy.example.com — пусто = релей выключен
  relayToken: process.env.RELAY_TOKEN || '',
  devices: loadDevices(),
};
