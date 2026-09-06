# Собирается из КОРНЯ репозитория (build context = repo root), т.к. переиспользует web/.
# docker-compose.yml в этой папке уже настроен на это (context: ..).
FROM node:20-alpine
WORKDIR /app
# Версия сборки приходит из GH Actions (0.1.<число коммитов>).
# Локальная сборка без аргумента — пустая, тогда сервер берёт version из package.json.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
COPY local-server/package*.json ./
RUN npm install --omit=dev
COPY local-server/src ./src
COPY web ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
