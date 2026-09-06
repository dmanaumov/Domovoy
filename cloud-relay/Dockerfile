# Собирается из КОРНЯ репозитория (build context = repo root), т.к. переиспользует web/.
# В Dokploy: Build Type = Dockerfile, Dockerfile Path = cloud-relay/Dockerfile,
# Build Context = корень репозитория.
FROM node:20-alpine
WORKDIR /app
# Версия сборки (0.1.<число коммитов>) задаётся при билде; локально — из package.json.
ARG APP_VERSION=""
ENV APP_VERSION=$APP_VERSION
COPY cloud-relay/package*.json ./
RUN npm install --omit=dev
COPY cloud-relay/src ./src
COPY web ./public
ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "src/server.js"]
