# Собирается из КОРНЯ репозитория (build context = repo root), т.к. переиспользует web/.
# docker-compose.yml в этой папке уже настроен на это (context: ..).
FROM node:20-alpine
WORKDIR /app
COPY local-server/package*.json ./
RUN npm install --omit=dev
COPY local-server/src ./src
COPY web ./public
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "src/server.js"]
