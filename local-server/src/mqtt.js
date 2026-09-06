import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { setSwitch, decryptMdnsData, startMdnsMonitor } from './ewelink.js';

/**
 * Мост между устройствами (MQTT/Tasmota + eWeLink LAN) и остальным приложением.
 *
 * Tasmota:
 *   публикует в stat/<topic>/POWER ("ON"/"OFF") и tele/<topic>/STATE (JSON)
 *   команды в                  cmnd/<topic>/POWER ("ON"/"OFF"/"TOGGLE")
 *
 * eWeLink LAN:
 *   POST http://<ip>:8081/zeroconf/switch  (зашифровано devicekey)
 *   getState не поддерживается (422) — состояние отслеживается оптимистично
 */
class DeviceHub extends EventEmitter {
  constructor(devices) {
    super();
    this.devicesById = new Map(devices.map((d) => [d.id, d]));
    this.state = new Map(devices.map((d) => [d.id, { power: 'UNKNOWN', lastSeen: null }]));
  }

  listDevices() {
    return [...this.devicesById.values()].map((d) => ({
      ...d,
      state: this.state.get(d.id),
    }));
  }

  deviceById(id) {
    return this.devicesById.get(id);
  }

  _applyPower(deviceId, power) {
    const prev = this.state.get(deviceId);
    this.state.set(deviceId, { power, lastSeen: new Date().toISOString() });
    if (!prev || prev.power !== power) {
      this.emit('change', { deviceId, power });
    }
  }

  /* ---- MQTT / Tasmota ---- */

  handleMqttMessage(topic, payload) {
    const parts = topic.split('/');
    if (parts.length < 3) return;
    const [prefix, name, suffix] = parts;
    const device = this.deviceById(name);
    if (!device || device.type === 'ewelink') return;

    if (prefix === 'stat' && suffix === 'POWER') {
      this._applyPower(device.id, payload.toString().trim());
    } else if (prefix === 'tele' && suffix === 'STATE') {
      try {
        const data = JSON.parse(payload.toString());
        if (data.POWER) this._applyPower(device.id, data.POWER);
      } catch { /* ignore */ }
    }
  }

  /* ---- eWeLink LAN ---- */

  async _ewelinkPower(device, action) {
    const state = this.state.get(device.id);
    let target;
    if (action === 'TOGGLE') {
      target = state?.power === 'ON' ? 'off' : 'on';
    } else {
      target = action === 'ON' ? 'on' : 'off';
    }
    const result = await setSwitch(device, target);
    if (result.ok) {
      this._applyPower(device.id, target.toUpperCase());
    }
    return result;
  }

  /* ---- publik API (вызывается из server.js / relay-client.js) ---- */

  async setPower(deviceId, action) {
    const device = this.deviceById(deviceId);
    if (!device) throw new Error(`Устройство ${deviceId} не найдено`);

    if (device.type === 'ewelink') {
      return this._ewelinkPower(device, action);
    }

    // Tasmota / MQTT (синхронно — MQTT publish не ждёт ответа)
    this._mqttClient?.publish(`cmnd/${device.topic}/POWER`, action);
  }
}

export function createMqttHub() {
  const hub = new DeviceHub(config.devices);

  // MQTT-клиент только если есть mqttUrl и есть mqtt-устройства
  const hasMqtt = config.devices.some((d) => d.type !== 'ewelink');
  if (hasMqtt) {
    const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 2000 });
    hub._mqttClient = client;

    client.on('connect', () => {
      console.log(`[mqtt] подключен к ${config.mqttUrl}`);
      client.subscribe(['stat/+/POWER', 'tele/+/STATE'], (err) => {
        if (err) console.error('[mqtt] ошибка подписки', err);
      });
    });
    client.on('message', (topic, payload) => hub.handleMqttMessage(topic, payload));
    client.on('error', (err) => console.error('[mqtt] ошибка соединения', err.message));
  }

  const ewCount = config.devices.filter((d) => d.type === 'ewelink').length;
  const mqttCount = config.devices.length - ewCount;
  console.log(`[hub] ${config.devices.length} устройств: ${mqttCount} MQTT/Tasmota + ${ewCount} eWeLink LAN`);

  // mDNS-мониторинг eWeLink: получаем реальный статус (data1..data4 + iv)
  if (ewCount > 0) {
    const byId = new Map(config.devices.map((d) => [d.deviceid, d]));
    startMdnsMonitor((deviceId, dataB64, ivB64) => {
      const device = byId.get(deviceId);
      if (!device) return;
      const state = decryptMdnsData(dataB64, ivB64, device.devicekey);
      if (state && typeof state.switch === 'string') {
        hub._applyPower(device.id, state.switch.toUpperCase());
      }
    });
  }

  return hub;
}
