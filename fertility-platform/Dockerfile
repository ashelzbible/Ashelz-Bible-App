# Single-container demo image: Node API + web app + recalculation worker, and the Python engine.
# Build context: this directory (fertility-platform/).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/sync-protocol/package.json packages/sync-protocol/
COPY services/api-gateway/package.json services/api-gateway/
RUN npm ci
COPY packages packages
COPY services/api-gateway services/api-gateway
COPY apps apps
COPY scripts scripts
RUN npm run build && npm prune --omit=dev

FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 && rm -rf /var/lib/apt/lists/*
COPY --from=build /usr/local/bin/node /usr/local/bin/node
# The engine's runtime needs only these (numpy/scipy are listed in pyproject but not imported by the code).
RUN pip install --no-cache-dir "fastapi>=0.110" "uvicorn>=0.29" "pydantic>=2.6"
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/sync-protocol/package.json packages/sync-protocol/package.json
COPY --from=build /app/packages/sync-protocol/dist packages/sync-protocol/dist
COPY --from=build /app/services/api-gateway/package.json services/api-gateway/package.json
COPY --from=build /app/services/api-gateway/dist services/api-gateway/dist
COPY --from=build /app/apps/pwa apps/pwa
COPY services/biochem-engine/core services/biochem-engine/core
COPY services/biochem-engine/app services/biochem-engine/app
COPY infrastructure/db/migrations infrastructure/db/migrations
COPY deploy deploy
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 TRUST_PROXY=true RUN_WORKER=true PWA_DIR=/app/apps/pwa \
    ASSAY_PROFILE=spec-provisional-1 PYTHONDONTWRITEBYTECODE=1
EXPOSE 8080
CMD ["sh", "deploy/start.sh"]
