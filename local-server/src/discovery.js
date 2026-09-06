import net from 'node:net';
import multicastDNS from 'multicast-dns';

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
const SCAN_TIMEOUT_MS = 10000;
const QUERY_INTERVAL_MS = 2000;

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