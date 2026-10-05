# syntax=docker/dockerfile:1

# ---- 依赖层（含 Chromium 系统依赖，供 verify 一次性服务使用）----
FROM node:20-bookworm-slim AS deps
WORKDIR /app
# Playwright 仅需 Chromium 运行 e2e
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=0 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci
# Chromium 运行所需的最小系统库集合（bookworm/arm64 与 amd64 同名）
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
        libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
        libgbm1 libasound2 libpango-1.0-0 libcairo2 libatspi2.0-0 \
        libdbus-1-3 libwayland-server0 \
    && rm -rf /var/lib/apt/lists/*
RUN npx playwright install chromium

# ---- 构建层 ----
FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

# ---- 验收层：一次性运行 vitest + 构建 + Playwright ----
FROM build AS verify
WORKDIR /app
ENV CI=true \
    APP_PORT=4173
# verify 服务的入口：全部通过则退出码 0
CMD ["npm", "run", "verify"]

# ---- 运行层：仅提供静态构建产物（vite preview）----
FROM node:20-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
# vite preview 仅需生产依赖 + vite（preview 命令）
RUN npm install --omit=dev && npm install vite@^5.4.10
COPY --from=build /app/dist ./dist
# 宿主端口由 APP_PORT 覆盖；容器内固定监听该端口
ARG APP_PORT=4173
ENV APP_PORT=${APP_PORT}
EXPOSE ${APP_PORT}
CMD ["sh", "-c", "npx vite preview --host 0.0.0.0 --port ${APP_PORT:-4173} --strictPort"]
