#!/usr/bin/env bash
# Собирает local-server и mosquitto ПРЯМО НА NAS через docker context
# domovoy-nas (см. scripts/setup-nas-docker-context.sh — выполнить один раз
# перед первым запуском этого скрипта) и (пере)запускает контейнеры.
# Без ssh, без docker save/load — сборка идёт прямо в докере NAS через
# Docker Remote API.
set -euo pipefail

CONTEXT="domovoy-nas"
ENV_FILE="${1:-local-server/.env}"

if ! docker context inspect "$CONTEXT" >/dev/null 2>&1; then
  echo "Нет docker context '$CONTEXT'. Сначала один раз:" >&2
  echo "  ./scripts/setup-nas-docker-context.sh admin@<IP-адрес-NAS>" >&2
  exit 1
fi

if [ ! -f "$ENV_FILE" ]; then
  echo "Не найден $ENV_FILE — скопируй local-server/.env.example и заполни токены." >&2
  exit 1
fi
set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a
: "${LOCAL_TOKEN:?LOCAL_TOKEN не задан в $ENV_FILE}"

cd "$(dirname "$0")/.."
export DOCKER_CONTEXT="$CONTEXT"

echo "==> Собираю образы (билд идёт на NAS, не на этой машине)..."
docker build -t domovoy-local-server:latest -f local-server/Dockerfile .
docker build -t domovoy-mosquitto:latest   -f mosquitto/Dockerfile   .

echo "==> (Пере)запускаю контейнеры на NAS..."
docker network inspect domovoy >/dev/null 2>&1 || docker network create domovoy
docker rm -f domovoy-mosquitto domovoy-local-server >/dev/null 2>&1 || true

docker run -d --name domovoy-mosquitto --network domovoy --restart unless-stopped \
  -p 1883:1883 \
  -v domovoy-mosquitto-data:/mosquitto/data \
  domovoy-mosquitto:latest

docker run -d --name domovoy-local-server --network domovoy --restart unless-stopped \
  -p 3000:3000 \
  -e PORT=3000 \
  -e MQTT_URL=mqtt://domovoy-mosquitto:1883 \
  -e LOCAL_TOKEN="$LOCAL_TOKEN" \
  -e RELAY_URL="${RELAY_URL:-}" \
  -e RELAY_TOKEN="${RELAY_TOKEN:-}" \
  domovoy-local-server:latest

echo "==> Готово: http://<IP-адрес-NAS>:3000"
echo "    Свой список устройств вместо примера — см. README, раздел про devices.json."
