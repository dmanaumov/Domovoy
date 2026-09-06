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

## Быстрый старт — домашний сервер на QNAP NAS (Container Station)

QNAP Container Station разворачивает docker-compose, но **не собирает образы из Dockerfile** — только тянет готовые. Поэтому образы `local-server` и `mosquitto` (с уже запечённым конфигом) собираются автоматически в GitHub Actions при каждом пуше в `main` и публикуются в `ghcr.io/dmanaumov/domovoy-local-server` и `ghcr.io/dmanaumov/domovoy-mosquitto` (см. `.github/workflows/build-images.yml`).

1. После первого пуша с этим workflow — зайти на GitHub в **Packages**, найти оба пакета (`domovoy-local-server`, `domovoy-mosquitto`) и в их настройках выставить видимость **Public** (иначе Container Station не сможет их скачать без логина в registry).
2. На NAS: **Container Station → Create → Create Application (Docker Compose)**.
3. Вставить содержимое `local-server/docker-compose.qnap.yml`, заменить плейсхолдеры (`LOCAL_TOKEN`, `RELAY_URL`, `RELAY_TOKEN`) на реальные значения.
4. Deploy. Проверить `http://<IP-адрес-NAS>:3000` в браузере локальной сети.
5. Свои устройства вместо примера — положить `devices.json` через File Station на NAS и подключить его volume-строкой из комментария в `docker-compose.qnap.yml` (путь зависит от структуры шар твоего NAS).

Если на NAS есть SSH и реальный `docker compose` (не через GUI) — можно использовать обычный `local-server/docker-compose.yml` (со сборкой из исходников), как на любом Linux-хосте.

## Веб-клиент на iPhone
Открыть адрес (локальный или облачный) в Safari → «Поделиться» → «На экран Домой». В настройках (⚙ в правом нижнем углу) указать адрес локального сервера, облачного релея и токен.

## Статус
v0.1 — MVP-скелет: welcome-заставка, главный экран со списком устройств и переключателями, локальный/облачный режимы. Прошивка устройств в Tasmota и первое реальное подключение — следующий шаг.
