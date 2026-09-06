import mqtt from 'mqtt';
import { EventEmitter } from 'node:events';
import { config } from './config.js';

/**
 * Мост между MQTT (Tasmota) и остальным приложением.
 * Tasmota по умолчанию:
 *   - публикует состояние в  stat/<topic>/POWER   ("ON"/"OFF")
 *   - и периодически в       tele/<topic>/STATE   (JSON, включая POWER)
 *   - принимает команды в    cmnd/<topic>/POWER   ("ON"/"OFF"/"TOGGLE")
 */
class DeviceHub extends EventEmitter {
  constructor(devices) {
    super();
    this.devicesByTopic = new Map(devices.map((d) => [d.topic, d]));
    this.state = new Map(devices.map((d) => [d.id, { power: 'UNKNOWN', lastSeen: null }]));
  }

  listDevices() {
    return [...this.devicesByTopic.values()].map((d) => ({
      ...d,
      state: this.state.get(d.id),
    }));
  }

  deviceById(id) {
    return [...this.devicesByTopic.values()].find((d) => d.id === id);
  }

  _applyPower(deviceId, power) {
    const prev = this.state.get(deviceId);
    this.state.set(deviceId, { power, lastSeen: new Date().toISOString() });
    if (!prev || prev.power !== power) {
      this.emit('change', { deviceId, power });
    }
  }

  handleMqttMessage(topic, payload) {
    // topic вида stat/<name>/POWER  или  tele/<name>/STATE
    const parts = topic.split('/');
    if (parts.length < 3) return;
    const [prefix, name, suffix] = parts;
    const device = this.devicesByTopic.get(name);
    if (!device) return;

    if (prefix === 'stat' && suffix === 'POWER') {
      this._applyPower(device.id, payload.toString().trim());
    } else if (prefix === 'tele' && suffix === 'STATE') {
      try {
        const data = JSON.parse(payload.toString());
        if (data.POWER) this._applyPower(device.id, data.POWER);
      } catch {
        // игнорируем неразбираемый payload
      }
    }
  }
}

export function createMqttHub() {
  const hub = new DeviceHub(config.devices);
  const client = mqtt.connect(config.mqttUrl, { reconnectPeriod: 2000 });

  client.on('connect', () => {
    console.log(`[mqtt] подключен к ${config.mqttUrl}`);
    client.subscribe(['stat/+/POWER', 'tele/+/STATE'], (err) => {
      if (err) console.error('[mqtt] ошибка подписки', err);
    });
  });

  client.on('message', (topic, payload) => hub.handleMqttMessage(topic, payload));
  client.on('error', (err) => console.error('[mqtt] ошибка соединения', err.message));

  hub.setPower = (deviceId, action) => {
    const device = hub.deviceById(deviceId);
    if (!device) throw new Error(`Устройство ${deviceId} не найдено`);
    client.publish(`cmnd/${device.topic}/POWER`, action);
  };

  return hub;
}
