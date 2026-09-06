import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { discoverDevices } from './discovery.js';
import { fetchEWelinkDevices } from './ewelink-api.js';

/**
 * Динамический реестр устройств. Держит всё в памяти (быстрый доступ для
 * hub/API), а также периодически сохраняет снапшот на диск (path можно
 * задать через env REGISTRY_FILE) — чтобы после перезапуска сервер сразу
 * знал devicekey и IP устройств, не опрашивая eWeLink-облако заново.
 *
 * Источники данных:
 *   1. mDNS-скан -> что есть в локальной сети (deviceid, ip, type)
 *   2. eWeLink Cloud (по сессии из setup) -> devicekey, имена, комнаты
 *   3. merge() -> живое устройство: известно КАК им управлять
 *
 * Кеш на диск (REGISTRY_FILE, по умолчанию ./data/ewelink-registry.json) —
 * это НЕ ручная настройка, а просто «память процесса на диске»: при старте
 * читаем, дальше обновляем из облака/mDNS, потом снова пишем.
 */

const REGISTRY_FILE = process.env.REGISTRY_FILE || './data/ewelink-registry.json';

class DeviceRegistry extends EventEmitter {
  constructor() {
    super();
    this.cloudDevices = new Map(); // deviceid -> {devicekey, uiid, name, ...}
    this.lanDevices = new Map();   // deviceid -> {ip, port, type, encrypt, lastSeen}
    this.scanTimer = null;
    this.scanIntervalMs = 30000;
    this.cloudConfigured = false;
    this._loadCache();
  }

  /* --- кеш на диск ------------------------------------------------ */

  _cachePath() {
    return path.resolve(REGISTRY_FILE);
  }

  _loadCache() {
    try {
      const raw = JSON.parse(fs.readFileSync(this._cachePath(), 'utf-8'));
      if (raw.cloudConfigured) this.cloudConfigured = true;
      for (const [id, d] of Object.entries(raw.cloudDevices || {})) {
        this.cloudDevices.set(id, d);
      }
      for (const [id, d] of Object.entries(raw.lanDevices || {})) {
        this.lanDevices.set(id, d);
      }
      console.log(`[registry] кеш загружен: облако=${this.cloudDevices.size}, LAN=${this.lanDevices.size}`);
    } catch {
      /* кеша ещё нет — начинаем с чистого листа */
    }
  }

  _saveCache() {
    try {
      fs.mkdirSync(path.dirname(this._cachePath()), { recursive: true });
      const snapshot = {
        cloudConfigured: this.cloudConfigured,
        savedAt: new Date().toISOString(),
        cloudDevices: Object.fromEntries(this.cloudDevices),
        lanDevices: Object.fromEntries(this.lanDevices),
      };
      fs.writeFileSync(this._cachePath(), JSON.stringify(snapshot, null, 2));
    } catch (err) {
      console.error(`[registry] не смог сохранить кеш (${this._cachePath()}):`, err.message);
    }
  }

  setCloudSession({ at, appid, region }) {
    this.at = at;
    this.appid = appid;
    this.region = region;
    this.cloudConfigured = true;
    this._saveCache();
  }

  clearCloudSession() {
    this.at = null;
    this.appid = null;
    this.region = null;
    this.cloudConfigured = false;
    this.cloudDevices.clear();
    this._saveCache();
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
    this._saveCache();
    this.emit('cloud-updated');
  }

  /** Проверяем, жив ли хост по TCP (Sonoff отвечает на 8081), а не только по mDNS.
   *  mDNS в Docker/Wi-Fi-изоляции часто теряет announce, а TCP-порт надёжен. */
  _tcpProbe(device, timeoutMs = 1200) {
    return new Promise((resolve) => {
      const host = device?.ip;
      const port = device?.port || 8081;
      if (!host) return resolve(false);
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);
      socket.once('connect', () => { socket.destroy(); resolve(true); });
      socket.once('timeout', () => { socket.destroy(); resolve(false); });
      socket.once('error', () => { socket.destroy(); resolve(false); });
      socket.connect(port, host);
    });
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
        this.emit('lan-updated');
      }
      // Живость известных устройств подтверждаем TCP-пробой — mDNS может молчать
      await Promise.all(
        [...this.lanDevices.values()].map(async (dev) => {
          const alive = await this._tcpProbe(dev);
          if (alive) {
            const prev = this.lanDevices.get(dev.deviceid);
            this.lanDevices.set(dev.deviceid, { ...(prev || {}), ...dev, lastSeen: Date.now() });
          }
        }),
      );
      this._saveCache();
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
    this._saveCache();
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
      // Устройство «в сети», если его недавно видели в LAN (mDNS/TCP)
      // ЛИБО облако eWeLink подтверждает online. Облачный флаг — резерв
      // для случаев, когда mDNS в Docker не успел/не может отработать.
      const lanAlive = !!lan.lastSeen && (now - lan.lastSeen <= LAN_STALE_MS);
      const offline = !lanAlive && cloud?.online !== true;
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
    // устройства из облака, которых нет в mDNS (offline/ещё не обнаружили)
    for (const [deviceid, cloud] of this.cloudDevices) {
      if (this.lanDevices.has(deviceid)) continue;
      const offline = cloud.online !== true;
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
        offline,
        stateNote: offline ? null : 'online-в-облаке',
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