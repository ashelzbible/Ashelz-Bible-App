FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:web && npm prune --omit=dev
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRUST_PROXY=true MEDIA_DIR=/data/media
EXPOSE 8080
CMD ["node", "server/src/main.ts"]
