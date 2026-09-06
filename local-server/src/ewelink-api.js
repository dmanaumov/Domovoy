import crypto from 'node:crypto';

/**
 * Клиент eWeLink Cloud API (ботаем как мобильное приложение).
 * Логин по e-mail/телефону, дальше тянем семьи + устройства (thing list).
 *
 * Используется только при первичной настройке:
 * сервер логинится один раз, получает devicekey всех устройств
 * и сопоставляет с найденными по mDNS — больше к облаку не обращается.
 */

const APPS = [
  // Публичные appid/appsecret (как в fetch-скрипте)
  { appid: 'Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl', appsecret: 'mXLOjea0woSMvK9gw7Fjsy7YlFO4iSu6' },
  { appid: '4s1FXKC9FaGfoqXhmXSJneb3qcm1gOak', appsecret: 'oKvCM06gvwkRbfetd6qWRrbC3rFrbIpV' },
];

const HOSTS = {
  eu: 'https://eu-apia.coolkit.cc',
  cn: 'https://cn-apia.coolkit.cn',
  us: 'https://us-apia.coolkit.cc',
  as: 'https://as-apia.coolkit.cc',
};

function sign(appsecret, data) {
  return crypto.createHmac('sha256', appsecret).update(data).digest('base64');
}

async function httpJson(method, url, headers = {}, body = null, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(url, {
      method,
      headers,
      body: body !== null ? body : undefined,
      signal: controller.signal,
    });
    const raw = await res.text();
    let json;
    try { json = JSON.parse(raw); } catch { json = { raw: raw.slice(0, 200) }; }
    return { status: res.status, json };
  } catch (err) {
    return { status: 0, json: { msg: String(err.message.slice?.(0, 200) || err) } };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Логин пользователя в eWeLink Cloud.
 * @param {string} user - email или телефон
 * @param {string} password
 * @param {string} region - eu | cn | us | as
 * @returns {Promise<{ok: boolean, at?: string, apikey?: string, error?: number, msg?: string}>}
 */
export async function ewelinkLogin(user, password, region = 'eu') {
  const host = HOSTS[region] || HOSTS.eu;
  const payload = user.includes('@')
    ? { email: user, password, countryCode: '+86' }
    : { phoneNumber: user.startsWith('+') ? user : `+${user}`, password, countryCode: '+86' };
  const bodyText = JSON.stringify(payload);

  for (const { appid, appsecret } of APPS) {
    const headers = {
      Authorization: `Sign ${sign(appsecret, bodyText)}`,
      'X-CK-Appid': appid,
      'Content-Type': 'application/json',
    };
    const { json } = await httpJson('POST', `${host}/v2/user/login`, headers, bodyText);
    if (json.error === 0) {
      return { ok: true, appid, at: json.data.at, apikey: json.data.user?.apikey, region };
    }
    if (json.error !== 400) {
      return { ok: false, error: json.error, msg: json.msg || `app ${appid.slice(0, 8)}` };
    }
  }
  return { ok: false, error: -1, msg: 'не удалось войти с публичными ключами' };
}

async function apiGet(host, at, appid, path) {
  return httpJson('GET', `${host}${path}`, {
    Authorization: `Bearer ${at}`,
    'X-CK-Appid': appid,
  });
}

/**
 * Получить список устройств аккаунта (все семьи).
 * @returns {Promise<Array<object>>} [{ deviceid, name, uiid, devicekey, ... }]
 */
export async function fetchEWelinkDevices(at, appid, region = 'eu') {
  const host = HOSTS[region] || HOSTS.eu;
  const devices = [];
  const seen = new Set();

  const { json: famJson } = await apiGet(host, at, appid, '/v2/family');
  const families = famJson.error === 0 ? famJson.data?.familyList || [] : [];

  const list = [];
  for (const f of families) {
    const { json } = await apiGet(host, at, appid, `/v2/device/thing?num=0&familyid=${f.id}`);
    if (json.error === 0) {
      for (const t of json.data?.thingList || []) {
        t._familyId = f.id;
        list.push(t);
      }
    }
  }
  const { json: allJson } = await apiGet(host, at, appid, '/v2/device/thing?num=0');
  if (allJson.error === 0) list.push(...(allJson.data?.thingList || []));

  const familyById = new Map(families.map((f) => [f.id, f]));

  for (const t of list) {
    const d = t.itemData;
    if (!d || !d.deviceid) continue;
    if (seen.has(d.deviceid)) continue;
    seen.add(d.deviceid);

    // Дом/комната: берём из семьи (по familyid запроса) или из тегов устройства
    const tagGroup = d.tags?.group?.[0] || t.tags?.group?.[0];
    const tagFamily = d.tags?.family?.[0] || t.tags?.family?.[0];
    const family = familyById.get(t._familyId) || (tagFamily ? { name: tagFamily.name } : null);

    devices.push({
      deviceid: d.deviceid,
      name: d.name || d.deviceid,
      uiid: d.extra?.uiid,
      devicekey: d.devicekey || null,
      online: d.online || false,
      apikey: d.apikey,
      home: family?.name || tagFamily?.name || 'Дом',
      room: tagGroup?.name || null,
    });
  }
  return devices;
}