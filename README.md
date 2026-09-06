# Домовой

Управление умным домом (Sonoff на прошивке Tasmota) — из любой точки и локально, без интернета.

Подробности архитектуры: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Что именно где крутится

| Где | Что | Файлы |
|---|---|---|
| **Сервер (VPS, Dokploy)** | только `cloud-relay` — прокси между клиентом и домом + раздаёт веб-клиент | `cloud-relay/docker-compose.yml` |
| **Дома (Raspberry Pi/мини-ПК)** | `local-server` + Mosquitto (MQTT-брокер) | `local-server/docker-compose.yml` |

MQTT и логика устройств живут **только дома**. На сервере в облаке — ничего, кроме прокси-слоя: если дома выключат интернет, сервер просто скажет клиенту "дом офлайн", а сама розетка по-прежнему управляется локально.

## Быстрый старт — облачный релей (Dokploy)

1. В Dokploy: **Create → Application → Docker Compose** (не "Dockerfile"), источник — этот git-репозиторий.
2. Compose Path: `cloud-relay/docker-compose.yml`
   (в нём `build.context: ..` — сборка идёт из корня репозитория, потому что образу нужен `../web`, общий с домашним сервером).
3. Environment (переменные) — на основе `cloud-relay/.env.example`:
   - `PORT=8080`
   - `RELAY_TOKEN` — придумать секрет, он же пойдёт в `.env` домашнего сервера.
   - `CLIENT_TOKEN` — придумать секрет для входа в веб-клиент.
   Создать `cloud-relay/.env` на сервере (или задать через Environment Settings в Dokploy) — сервис ждёт `env_file: .env`.
4. Domains: указать сервис `cloud-relay`, порт контейнера `8080` — Dokploy сам поднимет Traefik/HTTPS.
5. Deploy. После деплоя открыть домен — увидишь welcome-заставку "Домовой" (5 сек) и главный экран (пока без устройств — они появятся, когда домашний сервер подключится).

## Быстрый старт — домашний сервер (Raspberry Pi/мини-ПК)

1. `git clone` этот репозиторий на домашний сервер.
2. `cd local-server`
3. `cp .env.example .env` и заполнить: `LOCAL_TOKEN`, `RELAY_URL` (адрес облачного релея, `wss://...`), `RELAY_TOKEN` (тот же, что в облаке).
4. `cp devices.example.json devices.json` и заполнить реальными устройствами (см. ниже).
5. `docker compose up -d --build`
6. Открыть `http://<IP-адрес-сервера>:3000` в браузере локальной сети — должен появиться список устройств.

### Настройка устройства в `devices.json`
Поле `topic` — это `%topic%` из веб-интерфейса Tasmota (Configuration → MQTT):
```json
[{ "id": "kitchen-light", "name": "Свет на кухне", "topic": "tasmota_kitchen" }]
```

## Быстрый старт — домашний сервер на QNAP NAS

Самый быстрый путь — собрать образы прямо на своей машине и перегнать на NAS по SSH (без registry, без GitHub Actions, занимает секунды):

1. На NAS: Control Panel → Network & File Services → **Telnet/SSH** → включить SSH.
2. `cp local-server/.env.example local-server/.env` и заполнить `LOCAL_TOKEN`, `RELAY_URL`, `RELAY_TOKEN`.
3. (Опционально) положить реальный список устройств в `local-server/devices.json` (по образцу `devices.example.json`) — скрипт сам перенесёт его на NAS вместо заглушки.
4. Запустить:
   ```bash
   ./scripts/deploy-to-nas.sh admin@<IP-адрес-NAS>
   ```
   Скрипт соберёт `local-server` и `mosquitto` под `linux/amd64` (важно, если сам собираешь на Apple Silicon Mac — NAS на Intel/Celeron), перельёт образы через `docker save | ssh ... docker load` и перезапустит контейнеры.
5. Проверить `http://<IP-адрес-NAS>:3000` в браузере локальной сети.

Если `docker` на NAS недоступен из SSH-сессии напрямую — проверь `ssh admin@NAS_IP 'which docker'`; если пусто, найди бинарник (`find /share -name docker -type f 2>/dev/null | grep container-station`) и либо добавь его в `PATH`, либо поправь вызовы `docker` в `scripts/deploy-to-nas.sh` на полный путь.

### Альтернатива — через QNAP Container Station (GUI)
Если предпочитаешь разворачивать через GUI, а не SSH: образы также автоматически собираются и публикуются в `ghcr.io/dmanaumov/domovoy-*` при каждом пуше в `main` (`.github/workflows/build-images.yml`). Тогда в Container Station → Create Application вставляется `local-server/docker-compose.qnap.yml` (не забыть сделать пакеты в GitHub Packages публичными). Это медленнее (ждать сборку в Actions) и требует лишних телодвижений с видимостью пакетов — используй, если хочешь автодеплой без своего ноутбука под рукой.

## Веб-клиент на iPhone

## Веб-клиент на iPhone
Открыть адрес (локальный или облачный) в Safari → «Поделиться» → «На экран Домой». В настройках (⚙ в правом нижнем углу) указать адрес локального сервера, облачного релея и токен.

## Статус
v0.1 — MVP-скелет: welcome-заставка, главный экран со списком устройств и переключателями, локальный/облачный режимы. Прошивка устройств в Tasmota и первое реальное подключение — следующий шаг.
