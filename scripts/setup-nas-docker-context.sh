#!/usr/bin/env bash
# Одноразовая настройка: забирает TLS-сертификаты клиента с NAS
# (/etc/docker/tls/{ca,cert,key}.pem — QNAP генерирует их сам для
# Docker Remote API) и создаёт docker context, который направляет
# обычные docker-команды прямо на демон NAS (tcp://<NAS>:2376, TLS).
#
# После этого сборка и запуск идут БЕЗ ssh и БЕЗ docker save/load —
# образ строится сразу в докере на NAS.
#
# Использование: ./scripts/setup-nas-docker-context.sh admin@192.168.0.5
set -euo pipefail

NAS_HOST="${1:?Использование: ./scripts/setup-nas-docker-context.sh user@nas-ip}"
NAS_IP="${NAS_HOST#*@}"
CERT_DIR="$HOME/.docker/domovoy-nas"

mkdir -p "$CERT_DIR"
echo "==> Забираю TLS-сертификаты с NAS ($NAS_HOST:/etc/docker/tls/)..."
# -O форсирует старый scp-протокол (не требует включённого SFTP на NAS)
scp -O "$NAS_HOST:/etc/docker/tls/ca.pem" "$NAS_HOST:/etc/docker/tls/cert.pem" "$NAS_HOST:/etc/docker/tls/key.pem" "$CERT_DIR/"
chmod 600 "$CERT_DIR"/*.pem

echo "==> Создаю docker context 'domovoy-nas' (tcp://$NAS_IP:2376, TLS)..."
docker context rm -f domovoy-nas >/dev/null 2>&1 || true
docker context create domovoy-nas \
  --docker "host=tcp://${NAS_IP}:2376,ca=${CERT_DIR}/ca.pem,cert=${CERT_DIR}/cert.pem,key=${CERT_DIR}/key.pem"

echo "==> Проверяю подключение..."
docker --context domovoy-nas version

echo "==> Готово. Дальше используй: ./scripts/deploy-to-nas.sh"
