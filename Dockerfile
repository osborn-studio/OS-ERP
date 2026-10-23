# syntax=docker/dockerfile:1
# ============================================================================
# 文件标识：Dockerfile ｜ 最小运行镜像（多阶段；非 root；锁文件安装；只带生产依赖）
# ============================================================================
# 决策与边界见 docs/implementation/ADR-0012-container-and-version-contract.md；
# 文本规则由 tests/dockerfile-policy.test.mjs 静态守卫。
#
# 阶段：
#   build        —— 完整依赖（含 dev）+ 前端构建。只在这里出现 tailwind/vite 链（含无修复的 braces）。
#   runtime-deps —— `npm ci --omit=dev --ignore-scripts` + 只重编 better-sqlite3。不带任何 dev 包。
#   runtime      —— 只复制 server/ public/ dist/ package*.json 与 runtime-deps 的 node_modules。
#
# 基础镜像按**多架构索引摘要**固定（linux/amd64 与 linux/arm64 同一摘要）。
# 升级：`docker buildx imagetools inspect node:22-bookworm-slim` 取新 Digest，改这一行并记录到 ADR。
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

# ---------- 构建阶段：完整依赖 + 前端产物 ----------
FROM ${NODE_IMAGE} AS build
# better-sqlite3 需要本地编译工具链；esbuild 需要显式 rebuild 才会放下平台二进制（与 ci.yml 一致）
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 esbuild --no-audit --no-fund
COPY . .
# public/docs/*.html 已随仓库提交（见 scripts/build-docs-wiki.mjs 头注），镜像内不再重跑 docs:build
RUN npm run build

# ---------- 生产依赖阶段：只装 dependencies ----------
FROM ${NODE_IMAGE} AS runtime-deps
RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
    && npm rebuild better-sqlite3 --no-audit --no-fund \
    && npm cache clean --force

# ---------- 运行镜像 ----------
FROM ${NODE_IMAGE} AS runtime
ARG GML_BUILD_SHA=""
# GML_JWT_SECRET **不在这里**：生产模式缺它则启动即退出（server/middleware/auth.js）。
ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0 \
    GML_RUNTIME_MODE=production \
    GML_DATA_DIR=/data \
    GML_BUILD_SHA=${GML_BUILD_SHA}
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --system --gid 10001 gml \
    && useradd --system --uid 10001 --gid gml --home-dir /app --shell /usr/sbin/nologin gml \
    && mkdir -p /data && chown gml:gml /data
WORKDIR /app
COPY --from=runtime-deps /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/server ./server
COPY --from=build /app/public ./public
COPY --from=build /app/dist ./dist
USER gml
EXPOSE 3001
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/meta/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server/index.js"]
