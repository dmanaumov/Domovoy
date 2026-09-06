import net from 'node:net';
import os from 'node:os';
import multicastDNS from 'multicast-dns';
import { probeIdentity } from './ewelink.js';

/**
 * mDNS-сканер eWeLink-устройств в локальной сети.
 * Ищет сервисы _ewelink._tcp, возвращает список найденных устройств.
 *
 * Надёжность: устройства сами периодически броадкастят mDNS-аннонсы
 * (state-обновления, heartbeat), а также отвечают на запросы. Из-за
 * multicast-isolation на WiFi-роутерах запросы иногда теряются, поэтому
 * сканер СЛУШАЕТ аннносы пассивно + шлёт периодические запросы.
 *
 * TXT-записи содержат:
 *   id       - deviceid (10-символьный hex)
 *   type     - тип устройства (plug, switch, rf, ...)
 *   encrypt  - true/false (нужно ли шифрование)
 *   iv       - текущий IV
 *   data1..data4 - зашифрованное состояние
 *   apivers  - версия API
 *   seq      - порядковый номер
 *
 * devicekey НЕ передаётся через mDNS — его получают из eWeLink API.
 */

const SERVICE_TYPE = '_ewelink._tcp.local';
const SCAN_TIMEOUT_MS = 4000;
const QUERY_INTERVAL_MS = 1500;

function parseTxt(data) {
  const result = {};
  const parts = Array.isArray(data)
    ? data.map((s) => s.toString())
    : Buffer.isBuffer(data)
      ? data.toString('utf-8').split('\0')
      : String(data).split('\0');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0) result[part.slice(0, eq)] = part.slice(eq + 1);
  }
  return result;
}

/**
 * Сканировать сеть и вернуть список найденных eWeLink-устройств.
 * Слушает mDNS-аннонсы SCAN_TIMEOUT_MS, периодически шлёт запросы.
 * @param {number} [timeoutMs=10000] - таймаут окна сканирования
 * @returns {Promise<Array<object>>}
 */
export function discoverDevices(timeoutMs = SCAN_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const mdns = multicastDNS();
    const services = new Map();
    const byHostname = new Map();

    function collect() {
      const found = [];
      for (const svc of services.values()) {
        if (!svc.id) continue;
        // RF-мосты/повторители (тип rf, ретрансляторы) переключить нашим
        // протоколом нельзя, а сами они «светятся» в mDNS как eWeLink —
        // в список управляемых устройств они не должны попадать.
        if (svc.type === 'rf') continue;
        const ip = svc.target ? byHostname.get(svc.target.toLowerCase()) : null;
        found.push({
          deviceid: svc.id,
          name: svc.id,
          type: svc.type || 'unknown',
          ip: ip || null,
          port: svc.port || 8081,
          encrypt: svc.encrypt,
          iv: svc.iv,
          apivers: svc.apivers,
          seq: svc.seq,
          devicekey: null, // нужен из eWeLink API
        });
      }
      return found;
    }

    mdns.on('response', (res) => {
      const all = [...res.answers, ...(res.additionals || [])];
      for (const rec of all) {
        if (!rec.name?.toLowerCase().includes('ewelink')) continue;
        if (rec.type === 'A') {
          byHostname.set(rec.name.toLowerCase(), rec.data);
          continue;
        }
        const svc = services.get(rec.name) || {};
        services.set(rec.name, svc);
        if (rec.type === 'TXT') {
          const txt = parseTxt(rec.data);
          svc.id = txt.id;
          svc.type = txt.type;
          svc.encrypt = txt.encrypt === 'true';
          svc.iv = txt.iv || null;
          svc.apivers = txt.apivers || '1';
          svc.seq = txt.seq || null;
        }
        if (rec.type === 'SRV') {
          svc.target = rec.data?.target;
          svc.port = rec.data?.port || 8081;
        }
      }
    });

    // периодические запросы, чтобы «достучаться» через multicast-isolation
    const queryTimer = setInterval(() => {
      mdns.query({ questions: [{ name: SERVICE_TYPE, type: 'PTR' }] });
    }, QUERY_INTERVAL_MS);
    mdns.query({ questions: [{ name: SERVICE_TYPE, type: 'PTR' }] });

    setTimeout(() => {
      clearInterval(queryTimer);
      mdns.destroy();
      resolve(collect());
    }, timeoutMs);
  });
}

/**
 * Быстрая проверка TCP-порта 8081.
 */
export function checkPort(ip, timeoutMs = 2000) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => { socket.destroy(); resolve(false); }, timeoutMs);
    socket.connect(8081, ip, () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/**
 * Прямое обнаружение eWeLink-устройств, НЕ зависящее от mDNS.
 * mDNS-мультикаст часто не пробивается в Docker/WiFi-изоляции, поэтому:
 *   1. сканируем свою подсеть TCP-коннектом на порт 8081 (Sonoff отвечает);
 *   2. для каждого открытого IP шлём зашифрованный LAN-опрос (getState) со
 *      всеми известными deviceid+devicekey — отвечает только то устройство,
 *      у которого совпал ключ. Так из «открыт порт» получаем deviceid.
 *
 * @param {Array<{deviceid: string, devicekey: string|null}>} knownDevices -
 *        devices, ключи которых известны (из eWeLink-облака/кеша)
 * @returns {Promise<Array<{deviceid: string, ip: string, port: number}>>}
 */
export async function discoverByTcpScan(knownDevices, { port = 8081, probeTimeoutMs = 2000 } = {}) {
  const keys = (knownDevices || []).filter((d) => d?.devicekey && d?.deviceid);

  // 1. определение локального IPv4 → подсеть /24
  const net4 = Object.values(os.networkInterfaces())
    .flat()
    .find((i) => i && i.family === 'IPv4' && !i.internal && /^192\.168\./.test(i.address));
  if (!net4) {
    console.log('[discovery] нет LAN IPv4 — TCP-обнаружение пропускаем');
    return [];
  }
  const base = net4.address.split('.').slice(0, 3).join('.');

  // 2. TCP-скан подсети
  const targets = [];
  for (let n = 1; n <= 254; n++) {
    const ip = `${base}.${n}`;
    if (ip === net4.address) continue;
    targets.push(ip);
  }

  const openIps = [];
  const CONCURRENCY = 60;
  let idx = 0;
  async function worker() {
    while (idx < targets.length) {
      const ip = targets[idx++];
      const ok = await new Promise((resolve) => {
        const t = setTimeout(() => { s.destroy(); resolve(false); }, 800);
        const s = net.createConnection({ port, host: ip });
        s.once('connect', () => { clearTimeout(t); s.destroy(); resolve(true); });
        s.once('error', () => { clearTimeout(t); resolve(false); });
      });
      if (ok) openIps.push(ip);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  console.log(`[discovery] TCP-скан: открытых портов ${port}: ${openIps.length}`);

  if (!openIps.length || !keys.length) return [];

  // 3. идентификация: чей IP, чей ключ
  const found = [];
  await Promise.all(
    openIps.map(async (ip) => {
      for (const k of keys) {
        const { identified } = await probeIdentity({ ip, deviceid: k.deviceid, devicekey: k.devicekey }, probeTimeoutMs);
        if (identified) {
          found.push({ deviceid: k.deviceid, ip, port });
          console.log(`[discovery] LAN-опрос: ${ip} → ${k.deviceid} (${identified})`);
          break; // один IP = одно устройство
        }
      }
    }),
  );
  return found;
}