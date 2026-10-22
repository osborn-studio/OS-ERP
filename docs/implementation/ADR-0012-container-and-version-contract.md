# ADR-0012：最小运行镜像与版本 / 状态契约

日期：2026-10-22。状态：开发实现，尚非生产部署验收。对应商用审阅 F14（P1，容器与供应链）与 F16（P2，API 状态与版本契约）。

## 决策

### 容器（F14）

`Dockerfile` 改为三阶段，规则由 `tests/dockerfile-policy.test.mjs` 静态守卫：

| 阶段 | 内容 | 目的 |
|---|---|---|
| `build` | `npm ci --ignore-scripts` + 显式 `npm rebuild better-sqlite3 esbuild`，`npm run build` | 完整依赖只在这里出现；与 `.github/workflows/ci.yml` 的安装方式一致 |
| `runtime-deps` | `npm ci --omit=dev --ignore-scripts` + 只重编 `better-sqlite3` | 产出不含任何 devDependencies 的 `node_modules` |
| `runtime` | 只复制 `server/`、`public/`、`dist/`、`package.json`、`package-lock.json` 与 `runtime-deps` 的 `node_modules` | 运行镜像不含 `src/`、`scripts/`、`tests/`、`docs/`、构建工具链 |

- 基础镜像固定为多架构索引摘要 `node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`（2026-10-22 由 `docker buildx imagetools inspect` 读取；linux/amd64 与 linux/arm64 共用该索引）。升级时重新读取摘要并在此记录，不手写。
- 运行镜像以系统用户 `gml`（uid/gid 10001）运行；`/data` 预建并归属该用户；`USER` 在最后一次 `COPY` 之后、`CMD` 之前。
- `ENV` 固定 `GML_RUNTIME_MODE=production`、`GML_DATA_DIR=/data`、`NODE_ENV=production`。`GML_JWT_SECRET` 不在镜像内：缺失或等于公开已知值时 `server/middleware/auth.js` 的 `assertJwtSecretPosture` 在监听前抛错退出；`GML_DATA_DIR` 由 `server/runtime.js` 的 `requireDataDirectory` 要求为绝对路径。两者都是既有闸门，本 ADR 只是不再绕过它们。
- `VOLUME ["/data"]`、`EXPOSE 3001`、`HEALTHCHECK` 请求 `/api/meta/health`；`tini` 作为 PID 1。
- 构建参数 `GML_BUILD_SHA` 写入运行时环境变量，供版本契约使用（见下）。
- `public/docs/*.html` 已随仓库提交（`scripts/build-docs-wiki.mjs` 头注要求提交产物），镜像内不执行 `docs:build`，因此 `docs/` 与 `scripts/` 都不进入构建上下文。
- `reusable/` 不被 `server/` 在运行时加载（静态检索无 import/require），不复制进运行镜像；它仍随源码发行包（`scripts/package-release.mjs`）交付。

`docker-compose.yml`：端口只发布到 `127.0.0.1:3001`；`read_only: true` 根文件系统，`/tmp` 为 tmpfs，程序只写 `/data` 命名卷 `os-erp-data`；`cap_drop: [ALL]`、`no-new-privileges`；密钥只经 `${GML_JWT_SECRET:?}` 从环境或可选 `.env`（`.env.example` 只有空值）读取，文件内没有任何真实或默认密钥。

`.dockerignore` 排除 `node_modules`、`.git`、`.github`、`data`、`tests`、`docs`、`scripts`、`artifacts`、`deliverables`、`test-evidence`、`.local`、`backups`、`release`、`.env*`、`*.md`、`*.db*` 等；`public/` 保留。

### 依赖公告（F14 延续 `dependency-alerts.md`）

`braces` GHSA-vfj7-8cjw-p6xm 仍无上游修复版本（`npm audit` 给出的"修复"是升级到 `tailwindcss 4.3.3` 这一破坏性大版本，本 ADR 不采纳）。核查结果（2026-10-22，`--registry=https://registry.npmjs.org`，本机默认镜像源不提供 audit 端点）：

- `npm audit --omit=dev`：**0 条**（prod 130 个包）。
- `npm audit`（含 dev）：5 条 high，全部为 `tailwindcss → chokidar / micromatch / fast-glob → braces` 一条开发链。

因此运行镜像按 `--omit=dev` 安装时不含该链；`tests/dockerfile-policy.test.mjs` 断言锁文件中这五个包均为 `dev: true`。告警本身**不关闭**：开发机与 CI 仍安装它，后续跟踪见 `dependency-alerts.md`。`scripts/test-dependency-security.mjs` 保持通过（14/14）。

### 版本契约（F16）

新增 `server/version.js` 作为唯一出处：`VERSION` 读 `package.json`；`buildSha()` 优先 `GML_BUILD_SHA` 环境变量，其次发行包根目录 `MANIFEST.json.baseCommit`（`scripts/package-release.mjs` 生成），都没有则 `null`；只接受 7–64 位十六进制，非法值视为无。`versionInfo()` 返回 `{ version, build_sha }`，以下四处统一展开它：

| 接口 | 改前 | 改后 |
|---|---|---|
| `GET /api` | `version: '1.2.0'` | `version` = package.json，新增 `build_sha` |
| `GET /api/meta/health` | `version: '1.0.0'` | 同上，新增 `build_sha` |
| `GET /api/ai/manifest` → `system` | `version: '1.0.0'` | 同上，新增 `build_sha` |
| `POST /mcp initialize` → `serverInfo` | `version: '1.0.0'` | 同上，新增 `build_sha` |

`server/openapi.js` 的 `info.version`（1.31.0）是 API 规格版本，已镜像到生成类型 `src/types/api-routes.ts`，与应用版本语义不同，本 ADR 不合并。

### 状态契约（F16）

`POST /api/mall/orders/:id/cancel` 原来在事务内经内核落 `cancelled`，却返回字面量 `status: 'closed'`。现改为事务后重读 `oms_orders.status` 返回持久化值（`cancelled`）。`src/` 没有依赖返回值 `'closed'` 的消费者（`MallApp.tsx` 撤单后只重新拉列表；`oms/Orders.tsx` 对 `closed` 的排除是历史数据兼容，保留）；`meta/dict` 的 `oms_status` 仍保留 `closed` 文案以显示历史库中的旧值。

### 开发代理（F16）

`vite.config.ts` 注释声称代理 `/api` 与 `/mcp`，实际只有 `/api`。现补上 `/mcp → http://localhost:3001`；MCP 仅在 demo/test 模式启用（ADR-0002），生产模式下该路径仍返回 503 `FEATURE_DISABLED`。

## 边界

- 这是运行制品的缩小，不是对 F02/F03 等业务安全问题的修复；也不是 Linux 目标机或生产部署验收。
- 只读根文件系统依赖"程序只写 `GML_DATA_DIR`"这一事实（`server/db/index.js`、`server/lib/login-throttle.js`）；新增任何写盘路径都必须落在数据目录内，否则容器内会报 `EROFS`。
- HEALTHCHECK 成功只表示 HTTP 层可用与 schema 已初始化，不表示业务正确。
- `build_sha` 为 `null` 时表示构建方没有注入，不表示"开发版"；接口不会猜测或自行执行 `git`。
- 镜像摘要固定意味着基础镜像安全更新**不会自动进入**；需要有人定期重新读取摘要并更新本文件。

## 验证

专项命令：`node --test tests/version-contract.test.mjs tests/dockerfile-policy.test.mjs`（Node 22）。

- `tests/version-contract.test.mjs`：`server/version.js` 的取值与非法 SHA 拒绝；test 模式真实服务上 `/api`、`/api/meta/health`、`/api/ai/manifest`、MCP `initialize` 四处版本等于 package.json 且 `build_sha` 等于注入值；手工构造 H5 平台与待发货订单后，商城撤单返回的 `status` 等于库内重读值 `cancelled`，重复撤单 409 且状态不变。反例验证：恢复旧的 `status: 'closed'` 字面量后该测试明确失败（expected `cancelled`，actual `closed`），随后已恢复修复。
- `tests/dockerfile-policy.test.mjs`：多阶段与摘要固定、非 root 且 `USER` 位于最后一次 `COPY` 之后、无 `npm install`、`npm ci` 均带 `--ignore-scripts`、运行阶段无 `--include=dev` 且不复制 build 阶段 `node_modules`、运行契约（模式 / 卷 / 健康检查 / 端口 / 无内置密钥）、compose 回环发布与只读根、`.env.example` 无真实值、`.dockerignore` 必列项、braces 链 `dev: true`。改回旧 `Dockerfile` 时 7/8 项失败。

2026-10-22 Mac mini 开发验证结果（Node 22.22.1；Docker Engine 29.8.0，linux/arm64）：

- `npm run test:focused`：115/115 通过，0 失败，0 跳过（183.8 秒），含本批新增 11 个用例；`npx tsc --noEmit`、`npm run build`、`node scripts/check-file-header.mjs`（4/4，顺带为 `src/components/SessionBoundary.tsx` 的既有标识块补上分隔线，否则棘轮在 HEAD 即为 99.8%）、`node scripts/check-api-contract.mjs`（全部通过）、`node scripts/check-contract-routes.mjs`（① 方向一致；② 方向 71 条历史欠账不计退出码，与 ADR-0002 时相同）、`node scripts/test-dependency-security.mjs`（14/14）、`git diff --check` 均通过。
- **镜像实际构建并运行**：`docker build --build-arg GML_BUILD_SHA=$(git rev-parse HEAD) -t os-erp:adr0012 .` 退出 0，解析到的基础镜像即上述摘要；镜像 403 MB，`Config.User=gml`。镜像内 `node_modules` 129 个包，`tailwindcss / braces / chokidar / micromatch / fast-glob / vite / react / typescript` 全部不存在，`better_sqlite3.node` 存在，无 `src/`、`scripts/`，`public/docs/install.html` 存在。
- 运行验证（`--read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges`，端口发布到 127.0.0.1）：不给 `GML_JWT_SECRET` ⇒ 启动即以 `JWT_SECRET_MISSING_IN_PRODUCTION` 退出；给公开已知值 `gml-demo-secret-change-me` ⇒ 同样拒绝启动；给随机密钥 ⇒ `/api`、`/api/meta/health`、`/api/ai/manifest` 均返回 `version=0.1.0-alpha.1`、`build_sha=36f8c56d…`（等于构建时 HEAD），`runtime_mode=production`，`/mcp` 返回 503；容器内进程 uid 10001，`touch /app/x` 报只读文件系统，三个行业库写入 `/data`；Docker HEALTHCHECK 进入 healthy。
- 本次只在 Mac mini 的 linux/arm64 Docker 上构建与运行；未在 Linux 目标机、linux/amd64 或 compose 整栈（`docker compose up`）上验收，`docker compose config` 仅证明文件可解析且端口绑定解析为 `host_ip: 127.0.0.1`。不构成生产部署验收。
