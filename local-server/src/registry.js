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

  clearCloudSession() {
    this.at = null;
    this.appid = null;
    this.region = null;
    this.cloudConfigured = false;
    this.cloudDevices.clear();
  }

  /** Загрузить devicekey всех устройств из облака.
   *  При неудаче НЕ очищаем предыдущий список — иначе облачный релей
   *  «проседает» до кучки mDNS-устройств, когда eWeLink временно недоступен. */
  async refreshCloud() {
    if (!this.cloudConfigured) return;
    let devices;
    try {
      devices = await fetchEWelinkDevices(this.at, this.appid, this.region);
    } catch (err) {
      console.error('[registry] ошибка получения устройств из облака:', err.message);
      return;
    }
    this.cloudDevices.clear();
    for (const d of devices) {
      this.cloudDevices.set(d.deviceid, d);
    }
    this.emit('cloud-updated');
  }

  /** mDNS-скан локальной сети. НЕ стирает предыдущие находки сразу:
   *  mDNS-ответы иногда теряются (multicast-isolation), поэтому оставляем
   *  последний известный адрес и фиксируем lastSeen. offline выставляется
   *  по зашкаливанию lastSeen, а не по факту одного неудачного скана. */
  async scanLan() {
    const now = Date.now();
    try {
      const found = await discoverDevices(8000);
      for (const d of found) {
        const prev = this.lanDevices.get(d.deviceid);
        this.lanDevices.set(d.deviceid, { ...(prev || {}), ...d, lastSeen: now });
      }
      this.emit('lan-updated');
    } catch (err) {
      console.error('[registry] ошибка mDNS-скана:', err.message);
    }
  }

  /** Метаданные из mDNS (даже без devicekey): обновляет ip и lastSeen.
   *  RF-мосты игнорируем — это ретрансляторы, переключить их нельзя. */
  markSeen(deviceid, info = {}) {
    if (!deviceid) return;
    if (info.type === 'rf') return;
    const prev = this.lanDevices.get(deviceid) || {};
    this.lanDevices.set(deviceid, { ...prev, ...info, deviceid, lastSeen: Date.now() });
  }

  /** Тип протокола для устройства: ewelink-lan или mqtt (если известен) */
  _protocol(device) {
    if (device.type && device.type.startsWith('ewelink')) return 'ewelink-lan';
    // TODO: Tasmota не имеет mDNS ewelink-записи; когда-нибудь добавим MQTT-обнаружение
    return 'ewelink-lan';
  }

  /** Слить облачные + LAN данные в единое живое устройство */
  merge() {
    const now = Date.now();
    const LAN_STALE_MS = 2 * 60 * 1000; // считаем «не в сети», если не видели 2 минуты
    const result = [];
    for (const [deviceid, lan] of this.lanDevices) {
      const cloud = this.cloudDevices.get(deviceid);
      const offline = !lan.lastSeen || (now - lan.lastSeen > LAN_STALE_MS);
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
        home: cloud?.home || null,
        room: cloud?.room || null,
        offline,
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
        home: cloud.home || null,
        room: cloud.room || null,
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