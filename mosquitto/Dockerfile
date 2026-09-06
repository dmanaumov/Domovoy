# Собирается из КОРНЯ репозитория (build context = repo root) —
# переиспользует local-server/mosquitto.conf, чтобы не дублировать файл.
# Нужен отдельным образом, потому что QNAP Container Station разворачивает
# только готовые образы, а не Dockerfile — конфиг нужно "запечь" внутрь.
FROM eclipse-mosquitto:2
COPY local-server/mosquitto.conf /mosquitto/config/mosquitto.conf
