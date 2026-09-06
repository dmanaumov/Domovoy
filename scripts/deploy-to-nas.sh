#!/usr/bin/env bash
# Собирает local-server и mosquitto на этой машине (linux/amd64 — под NAS,
# даже если сам Мак на Apple Silicon) и разворачивает их на QNAP через SSH.
# Без registry и без GitHub Actions — образ просто "перегоняется" по SSH.
#
# Использование:
#   ./scripts/deploy-to-nas.sh admin@192.168.1.50
#
# Требования на NAS: включён SSH (Control Panel → Telnet/SSH),
# у пользователя есть доступ к docker (Container Station).
set -euo pipefail

NAS_HOST="${1:?Использование: ./scripts/deploy-to-nas.sh user@nas-ip}"
ENV_FILE="${2:-local-server/.env}"

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

echo "==> Собираю образы (linux/amd64)..."
docker buildx build --platform linux/amd64 -t domovoy-local-server:latest -f local-server/Dockerfile . --load
docker buildx build --platform linux/amd64 -t domovoy-mosquitto:latest   -f mosquitto/Dockerfile   . --load

echo "==> Отправляю образы на NAS ($NAS_HOST) — docker save | ssh docker load..."
docker save domovoy-local-server:latest domovoy-mosquitto:latest | ssh "$NAS_HOST" docker load

DEVICES_MOUNT=""
if [ -f "local-server/devices.json" ]; then
  echo "==> Нашёл local-server/devices.json — переношу на NAS вместо заглушки из образа..."
  scp local-server/devices.json "$NAS_HOST:~/domovoy-devices.json"
  DEVICES_MOUNT="-v ~/domovoy-devices.json:/app/devices.json:ro"
else
  echo "==> local-server/devices.json не найден — в образе останется devices.example.json (заглушка)."
fi

echo "==> Перезапускаю контейнеры на NAS..."
ssh "$NAS_HOST" bash -s <<EOF
set -e
docker network inspect domovoy >/dev/null 2>&1 || docker network create domovoy
docker rm -f domovoy-mosquitto domovoy-local-server >/dev/null 2>&1 || true

docker run -d --name domovoy-mosquitto --network domovoy --restart unless-stopped \\
  -p 1883:1883 \\
  -v domovoy-mosquitto-data:/mosquitto/data \\
  domovoy-mosquitto:latest

docker run -d --name domovoy-local-server --network domovoy --restart unless-stopped \\
  -p 3000:3000 \\
  -e PORT=3000 \\
  -e MQTT_URL=mqtt://domovoy-mosquitto:1883 \\
  -e LOCAL_TOKEN="$LOCAL_TOKEN" \\
  -e RELAY_URL="${RELAY_URL:-}" \\
  -e RELAY_TOKEN="${RELAY_TOKEN:-}" \\
  $DEVICES_MOUNT \\
  domovoy-local-server:latest
EOF

echo "==> Готово: http://<IP-NAS>:3000"
