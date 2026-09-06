import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { config } from './config.js';
import { setSwitch, decryptMdnsData, startMdnsMonitor } from './ewelink.js';

/**
 * Hub управляет устройствами. Список устройств живёт в DeviceRegistry
 * (mDNS + eWeLink Cloud), а здесь — состояние и посылка команд.
 *
 * Различные протоколы:
 *   - ewelink-lan: setSwitch(device, 'on'/'off') по HTTP 8081
 *   - mqtt/tasmota: MQTT publish cmnd/<topic>/POWER
 */
class DeviceHub extends EventEmitter {
  constructor(registry) {
    super();
    this.registry = registry;
    this.state = new Map(); // deviceid -> { power, lastSeen }
    this.mqttClient = null;
  }

  listDevices() {
    return this.registry.getDevices().map((d) => ({
      ...d,
      state: this.state.get(d.deviceid) || { power: 'UNKNOWN', lastSeen: null },
    }));
  }

  deviceById(id) {
    const dev = this.registry.getDevice(id);
    if (!dev) return null;
    return { ...dev, state: this.state.get(dev.deviceid) || { power: 'UNKNOWN', lastSeen: null } };
  }

  _applyPower(deviceId, power) {
    const prev = this.state.get(deviceId);
    this.state.set(deviceId, { power, lastSeen: new Date().toISOString() });
    if (!prev || prev.power !== power) {
      this.emit('change', { deviceId, power });
    }
  }

  /**
   * Включить/выключить/переключить.
   * @returns {Promise<{ok: boolean, error?: number, body?: string}>}
   */
  async setPower(deviceId, action) {
    const dev = this.registry.getDevice(deviceId);
    if (!dev) throw new Error(`Устройство ${deviceId} не найдено`);

    if (dev.protocol === 'ewelink-lan') {
      if (!dev.devicekey || !dev.ip) {
        throw new Error(`Для ${dev.name} нет devicekey/ip — устройство offline или не настроено`);
      }
      const target = action === 'TOGGLE'
        ? (this.state.get(dev.deviceid)?.power === 'ON' ? 'off' : 'on')
        : (action === 'ON' ? 'on' : 'off');
      const result = await setSwitch({ ip: dev.ip, deviceid: dev.deviceid, devicekey: dev.devicekey }, target);
      if (result.ok) {
        this._applyPower(dev.deviceid, target.toUpperCase());
      }
      return result;
    }

    // Tasmota / MQTT
    if (!this.mqttClient) throw new Error('MQTT не настроен');
    this.mqttClient.publish(`cmnd/${dev.topic}/POWER`, action);
    return { ok: true };
  }
}

export function createHub(registry) {
  const hub = new DeviceHub(registry);

  // MQTT-клиент: подписка на состояние Tasmota-устройств
  try {
    const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 2000 });
    hub.mqttClient = client;
    client.on('connect', () => {
      client.subscribe(['stat/+/POWER', 'tele/+/STATE'], (err) => {
        if (err) console.error('[mqtt] ошибка подписки', err);
      });
    });
    client.on('message', (topic, payload) => hub._handleMqttMessage(topic, payload));
    client.on('error', (err) => console.error('[mqtt] ошибка соединения', err.message));
  } catch (err) {
    console.error('[mqtt] не удалось создать клиент:', err.message);
  }

  hub._handleMqttMessage = (topic, payload) => {
    const parts = topic.split('/');
    if (parts.length < 3) return;
    const [, name, suffix] = parts;
    // Tasmota топики: stat/<name>/POWER, tele/<name>/STATE
    const device = registry.getDevices().find((d) => d.topic === name);
    if (!device) return;

    if (suffix === 'POWER') {
      hub._applyPower(device.deviceid, payload.toString().trim());
    } else if (suffix === 'STATE') {
      try {
        const data = JSON.parse(payload.toString());
        if (data.POWER) hub._applyPower(device.deviceid, data.POWER);
      } catch { /* ignore */ }
    }
  };

  // mDNS-мониторинг: получаем реальный статус eWeLink-устройств
  // (data1..data4 + iv, расшифрованные devicekey из реестра)
  hub.stopMdns = startMdnsMonitor((deviceId, dataB64, ivB64) => {
    registry.markSeen(deviceId); // даже если это просто announce — устройство живо
    const device = registry.getDevice(deviceId);
    if (!device?.devicekey) return;
    const state = decryptMdnsData(dataB64, ivB64, device.devicekey);
    if (state && typeof state.switch === 'string') {
      hub._applyPower(deviceId, state.switch.toUpperCase());
    }
  });

  return hub;
}