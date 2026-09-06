import crypto from 'node:crypto';
import http from 'node:http';

/**
 * Управление Sonoff-устройствами по зашифрованному eWeLink LAN-протоколу.
 * Протокол: POST http://<ip>:8081/zeroconf/<command>
 *   body: { sequence, deviceid, selfApikey, iv, encrypt, data }
 *   data = AES-128-CBC( PKCS7(JSON(params)), key=MD5(devicekey), iv=random )
 *
 * Протестировано на Sonoff Mini R2 (uiid=1, type=plug):
 *   - switch {"switch":"on"/"off"}  → error:0
 *   - getState  → 422 (не поддерживается на plug)
 *   - Требуется User-Agent: eWeLink_Android/v5.21.1
 *   - selfApikey="123" совместимо с SonoffLAN
 */

const UA = 'eWeLink_Android/v5.21.1';
const TIMEOUT_MS = 5000;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1500;

function aesEncrypt(plaintext, devicekey) {
  const key = crypto.createHash('md5').update(devicekey).digest();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-128-cbc', key, iv);
  cipher.setAutoPadding(false);
  const buf = Buffer.from(plaintext, 'utf-8');
  const padLen = 16 - (buf.length % 16);
  const padded = Buffer.concat([buf, Buffer.alloc(padLen, padLen)]);
  const ct = Buffer.concat([cipher.update(padded), cipher.final()]);
  return { ctB64: ct.toString('base64'), ivB64: iv.toString('base64') };
}

function aesDecrypt(ctB64, ivB64, devicekey) {
  const key = crypto.createHash('md5').update(devicekey).digest();
  const iv = Buffer.from(ivB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
  decipher.setAutoPadding(false);
  const padded = Buffer.concat([decipher.update(ct), decipher.final()]);
  const padLen = padded[padded.length - 1];
  return padded.subarray(0, padded.length - padLen).toString('utf-8');
}

function sequence() {
  return String(Date.now());
}

function postJSON(host, path, body) {
  const data = JSON.stringify(body);
  const options = {
    hostname: host,
    port: 8081,
    path: `/zeroconf/${path}`,
    method: 'POST',
    timeout: TIMEOUT_MS,
    headers: {
      'Content-Type': 'application/json;charset=UTF-8',
      'Content-Length': Buffer.byteLength(data),
      'Connection': 'close',
      'User-Agent': UA,
      'Accept': 'application/json',
      'Cache-Control': 'no-store',
    },
  };
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: raw }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

/**
 * Отправить команду на eWeLink-устройство в LAN (с ретраями).
 * @returns {{ ok: boolean, error?: number, body?: string }}
 */
export async function ewelinkCommand(device, command, params) {
  const { ip, deviceid, devicekey } = device;
  const { ctB64, ivB64 } = aesEncrypt(JSON.stringify(params), devicekey);
  const payload = {
    sequence: sequence(),
    deviceid,
    selfApikey: '123',
    iv: ivB64,
    encrypt: true,
    data: ctB64,
  };

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const { status, body } = await postJSON(ip, command, payload);
      if (status === 200) {
        try {
          const resp = JSON.parse(body);
          if (resp.error === 0) return { ok: true, error: 0, body };
          return { ok: false, error: resp.error, body };
        } catch {
          return { ok: false, error: -1, body };
        }
      }
    } catch (err) {
      if (attempt === MAX_RETRIES) return { ok: false, error: -1, body: err.message };
    }
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
  }
  return { ok: false, error: -1, body: 'all retries failed' };
}

/**
 * Переключить relay/switch (plug, uiid=1).
 * @param {object} device - { ip, deviceid, devicekey }
 * @param {'on'|'off'} state
 */
export async function setSwitch(device, state) {
  return ewelinkCommand(device, 'switch', { switch: state });
}

/**
 * Однократный зашифрованный LAN-опрос устройства (без ретраев).
 * Используется для ИДЕНТИФИКАЦИИ: если устройство расшифровало пакет
 * правильным devicekey — оно отвечает структурированным JSON
 * ({"seq":..., "sequence":..., "error":...}). С чужим ключом — молчит.
 * Команда «switch» c {getState:true} на plug не переключает реле,
 * а возвращает error:400 «not supported» — но сам факт ответа = наш deviceid.
 *
 * @param {...} device - { ip, deviceid, devicekey }
 * @returns {Promise<{identified: boolean, body?: string}>}
 */
export function probeIdentity(device, timeoutMs = 2000) {
  const { ip, deviceid, devicekey } = device;
  const { ctB64, ivB64 } = aesEncrypt(JSON.stringify({ getState: true }), devicekey);
  const payload = {
    sequence: sequence(),
    deviceid,
    selfApikey: '123',
    iv: ivB64,
    encrypt: true,
    data: ctB64,
  };
  return new Promise((resolve) => {
    const req = http.request({
      hostname: ip,
      port: 8081,
      path: '/zeroconf/switch',
      method: 'POST',
      timeout: timeoutMs,
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(JSON.stringify(payload)),
        'Connection': 'close',
        'User-Agent': UA,
        'Accept': 'application/json',
        'Cache-Control': 'no-store',
      },
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => resolve({ identified: isStructuredResponse(raw), body: raw }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ identified: false, body: '' }); });
    req.on('error', () => resolve({ identified: false, body: '' }));
    req.write(JSON.stringify(payload));
    req.end();
  });
}

function isStructuredResponse(raw) {
  try {
    const json = JSON.parse(raw);
    return json && typeof json === 'object' && ('seq' in json || 'sequence' in json);
  } catch {
    return false;
  }
}

/**
 * Расшифровать mDNS data-поля (concat data1..data4 + iv) с состоянием.
 * @returns {object|null} - расшифрованный JSON или null
 */
export function decryptMdnsData(dataB64, ivB64, devicekey) {
  try {
    return JSON.parse(aesDecrypt(dataB64, ivB64, devicekey));
  } catch {
    return null;
  }
}

/**
 * Пассивный mDNS-мониторинг eWeLink-устройств.
 * Устройства периодически (и при смене состояния) броадкастят TXT-записи
 * с зашифрованным состоянием (data1..data4 + iv). Модуль собирает поля и
 * возвращает сырые данные (devicekey hub подставляет сам, расшифровывая).
 *
 * @param {(deviceId: string, dataB64: string, ivB64: string, type?: string) => void} onRaw
 * @returns {() => void} stop-функция
 */
export function startMdnsMonitor(onRaw) {
  let mdns = null;
  let stopped = false;
  let stop = () => {};

  createMdns().then((m) => {
    if (stopped || !m) return;
    mdns = m;

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

    mdns.on('response', (res) => {
      const all = [...res.answers, ...(res.additionals || [])];
      for (const rec of all) {
        if (rec.type !== 'TXT' || !rec.name?.toLowerCase().includes('ewelink')) continue;
        const txt = parseTxt(rec.data);
        if (!txt.id || !txt.iv) continue;
        const raw = ''.concat(txt.data1 || '', txt.data2 || '', txt.data3 || '', txt.data4 || '');
        if (!raw) continue;
        try {
          onRaw(txt.id, raw, txt.iv, txt.type);
        } catch { /* не роняем mDNS из-за ошибки обработчика */ }
      }
    });

    mdns.query({ questions: [{ name: '_ewelink._tcp.local', type: 'PTR' }] });
    stop = () => mdns.destroy();
  });

  return () => {
    stopped = true;
    stop();
  };
}

async function createMdns() {
  try {
    // ESM-совместимый импорт multicast-dns
    const module = await import('multicast-dns');
    return module.default();
  } catch (err) {
    console.error('[ewelink] mDNS-мониторинг недоступен:', err.message);
    return null;
  }
}
