#!/usr/bin/env python3
"""Получить devicekey Sonoff через eWeLink API (прямой логин, EU).
Запускать локально в своём терминале:  python3 get_keys2.py
Пароль вводится скрыто (getpass) и нигде не сохраняется/не логируется.
"""
import base64, getpass, hashlib, hmac, json, ssl, sys, urllib.request, urllib.error

# Рабочий публичный ключ (проверено: прямой login доступен)
APP = [
    ("Uw83EKZFxdif7XFXEsrpduz5YyjP7nTl", "mXLOjea0woSMvK9gw7Fjsy7YlFO4iSu6"),
    ("4s1FXKC9FaGfoqXhmXSJneb3qcm1gOak", "oKvCM06gvwkRbfetd6qWRrbC3rFrbIpV"),
]
HOSTS = {
    "eu": "https://eu-apia.coolkit.cc",
    "cn": "https://cn-apia.coolkit.cn",
    "us": "https://us-apia.coolkit.cc",
    "as": "https://as-apia.coolkit.cc",
}
TARGET = {"1000899b68", "100098e08b", "10008a158b"}

ctx = ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE

def sign(appsecret, data):
    return base64.b64encode(hmac.new(appsecret.encode(), data.encode(), hashlib.sha256).digest()).decode()

def http(method, url, headers=None, body=None, timeout=12):
    req = urllib.request.Request(url, method=method)
    for k, v in (headers or {}).items(): req.add_header(k, v)
    if body is not None: req.data = body
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try: return e.code, json.loads(raw)
        except: return e.code, {"raw": raw[:200]}
    except Exception as e:
        return 0, {"msg": str(e)[:200]}

def login(host, appid, appsecret, user, password):
    if "@" in user:
        payload = {"email": user, "password": password, "countryCode": "+86"}
    else:
        payload = {"phoneNumber": user if user.startswith("+") else "+"+user,
                   "password": password, "countryCode": "+86"}
    body = json.dumps(payload, separators=(",", ":")).encode()
    headers = {"Authorization": "Sign "+sign(appsecret, body.decode()),
               "X-CK-Appid": appid, "Content-Type": "application/json"}
    st, resp = http("POST", host+"/v2/user/login", headers, body)
    return resp

def get_things(host, at, appid, familyid=None):
    url = host+"/v2/device/thing?num=0"
    if familyid: url += "&familyid="+familyid
    headers = {"Authorization": "Bearer "+at, "X-CK-Appid": appid}
    st, resp = http("GET", url, headers)
    out = []
    if isinstance(resp, dict) and resp.get("error")==0:
        for t in resp["data"].get("thingList", []):
            d = t.get("itemData")
            if d and "deviceid" in d: out.append(d)
    return out

def get_families(host, at, appid):
    headers = {"Authorization": "Bearer "+at, "X-CK-Appid": appid}
    st, resp = http("GET", host+"/v2/family", headers)
    if isinstance(resp, dict) and resp.get("error")==0:
        return resp["data"].get("familyList", [])
    return []

def main():
    print("=== eWeLink devicekey (прямой логин) ===")
    user = input("eWeLink login (email или телефон): ").strip()
    password = getpass.getpass("eWeLink password: ").strip()
    region = input("Регион аккаунта [eu/cn/us/as] (Enter=eu): ").strip().lower() or "eu"
    host = HOSTS.get(region, HOSTS["eu"])

    for appid, appsecret in APP:
        resp = login(host, appid, appsecret, user, password)
        err = resp.get("error")
        if err == 0:
            print(f"LOGIN OK (app {appid[:8]}, region {region})")
            at = resp["data"].get("at")
            fams = get_families(host, at, appid)
            print(f"families: {[f.get('name') for f in fams]}")
            all_dev = []
            for f in fams:
                all_dev += get_things(host, at, appid, f.get("id"))
            all_dev += get_things(host, at, appid)
            seen = set(); devs=[]
            for d in all_dev:
                if d["deviceid"] not in seen: seen.add(d["deviceid"]); devs.append(d)
            print(f"\nВсего устройств: {len(devs)}")
            for d in devs:
                did = d.get("deviceid"); tag = "  <== НАШ Sonoff" if did in TARGET else ""
                print(f"  deviceid={did} name={d.get('name')} uiid={d.get('extra',{}).get('uiid')} devicekey={'***' if d.get('devicekey') else '(нет)'}{tag}")
            print("\nДля сохранения в devices.json выполни с devicekey:")
            for d in devs:
                if d["deviceid"] in TARGET and d.get("devicekey"):
                    print(f"  {d['deviceid']} -> {d['devicekey']}")
            return
        else:
            print(f"app {appid[:8]}: error={err} msg={resp.get('msg')}")
    print("\nНе удалось войти с публичными ключами. Понадобится свой APP на dev.ewelink.cc.")

if __name__ == "__main__":
    try:
        main()
    except (EOFError, KeyboardInterrupt):
        print("\nПрервано.")
