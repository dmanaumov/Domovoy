import { EventEmitter } from 'node:events';
import { discoverDevices } from './discovery.js';
import { fetchEWelinkDevices } from './ewelink-api.js';

/**
 * Динамический реестр устройств. Лёгкий, держит всё в памяти, реагирует
 * на mDNS (что в сети прямо сейчас) + облако eWeLink (devicekey, имена).
 *
 * Устройства НЕ хранятся в файле: на каждой первичной настройке/перезапуске
 * сервер сам находит и решает как подключаться.
 *
 * flow:
 *   1. mDNS-скан -> найдено в LAN (deviceid, ip, type, encrypt)
 *   2. eWeLink Cloud (по логину из setup) -> devicekey + имя по deviceid
 *   3. merge -> живое устройство, известно КАК управлять
 */

class DeviceRegistry extends EventEmitter {
  constructor() {
    super();
    this.cloudDevices = new Map(); // deviceid -> {devicekey, uiid, name, ...}
    this.lanDevices = new Map();   // deviceid -> {ip, port, type, encrypt}
    this.scanTimer = null;
    this.scanIntervalMs = 30000;
    this.cloudConfigured = false;
  }

  setCloudSession({ at, appid, region }) {
    this.at = at;
    this.appid = appid;
    this.region = region;
    this.cloudConfigured = true;
  }

  /** Загрузить devicekey всех устройств из облака */
  async refreshCloud() {
    if (!this.cloudConfigured) return;
    try {
      const devices = await fetchEWelinkDevices(this.at, this.appid, this.region);
      this.cloudDevices.clear();
      for (const d of devices) {
        this.cloudDevices.set(d.deviceid, d);
      }
      this.emit('cloud-updated');
    } catch (err) {
      console.error('[registry] ошибка получения устройств из облака:', err.message);
    }
  }

  /** mDNS-скан локальной сети */
  async scanLan() {
    try {
      const found = await discoverDevices(8000);
      this.lanDevices.clear();
      for (const d of found) {
        this.lanDevices.set(d.deviceid, d);
      }
      this.emit('lan-updated');
    } catch (err) {
      console.error('[registry] ошибка mDNS-скана:', err.message);
    }
  }

  /** Тип протокола для устройства: ewelink-lan или mqtt (если известен) */
  _protocol(device) {
    if (device.type && device.type.startsWith('ewelink')) return 'ewelink-lan';
    // TODO: Tasmota не имеет mDNS ewelink-записи; когда-нибудь добавим MQTT-обнаружение
    return 'ewelink-lan';
  }

  /** Слить облачные + LAN данные в единое живое устройство */
  merge() {
    const result = [];
    for (const [deviceid, lan] of this.lanDevices) {
      const cloud = this.cloudDevices.get(deviceid);
      result.push({
        deviceid,
        id: `ew-${deviceid}`,
        name: cloud?.name || lan.name || deviceid,
        type: 'ewelink',
        ip: lan.ip,
        port: lan.port,
        encrypt: lan.encrypt !== false,
        uiid: cloud?.uiid ?? null,
        devicekey: cloud?.devicekey || null, // null = не удалось получить ключ
        // как подключаться:
        protocol: 'ewelink-lan',
      });
    }
    // устройства из облака, которые прямо сейчас не в mDNS (offline)
    for (const [deviceid, cloud] of this.cloudDevices) {
      if (this.lanDevices.has(deviceid)) continue;
      result.push({
        deviceid,
        id: `ew-${deviceid}`,
        name: cloud.name || deviceid,
        type: 'ewelink',
        ip: null,
        port: 8081,
        encrypt: true,
        uiid: cloud.uiid,
        devicekey: cloud.devicekey,
        protocol: 'ewelink-lan',
        offline: true,
      });
    }
    return result;
  }

  getDevices() {
    return this.merge();
  }

  getDevice(deviceId) {
    return this.merge().find((d) => d.id === deviceId || d.deviceid === deviceId);
  }

  /** Периодический mDNS-скан (без немедленного запуска — обычно уже сканировали) */
  startScanning() {
    this.scanTimer = setInterval(() => {
      this.scanLan();
    }, this.scanIntervalMs);
  }

  stop() {
    if (this.scanTimer) clearInterval(this.scanTimer);
  }
}

export function createRegistry() {
  return new DeviceRegistry();
}