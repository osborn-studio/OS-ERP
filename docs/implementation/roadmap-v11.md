# OS ERP 商用整改详细方案 v11（第十五批）

日期：2026-10-24。基线：`batch-fourteen`（PR #10 候选，含 v2–v10 全部工作流）。承接 backlog "第十四批后仍 open" 节与各 AE 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`check-audit-allowlist`（含 `--include-dev`）、`gen-role-matrix --check`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`；提示词用"防御性审查"措辞，否则可能被拒）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；不得从单个 Bash 调用里启动无硬超时的常驻服务；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`；给 `ci.yml` 加 job 时整块追加在文件末尾；前端"槽位"约定：数据层工作流只改数据与 props 来源，布局工作流只改布局；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AF8 例外）。ADR 从 0058 起，迁移从 074 起。`gen-changelog.mjs` 第十四批范围为 ADR 57–68；第一个用到 0058 的工作流把第十四批改为 57、新增 `{ id: 15, title: '第十五批（进行中）：见 roadmap-v11', from: 58, to: 70 }`。

---

## AF1 标签专用发行工作流（取代 ci.yml 的按标签跳过）
- 现状：`ci.yml` 对标签推送用 `if` 跳过四个 job，跳过的 job 可能被当作同一 SHA 的通过状态（AE10 审计高）。
- 改动：新建 `.github/workflows/release-candidate.yml`（仅 `push.tags: v*` 与 `workflow_dispatch`），把 `candidate` job 整体搬过去；`ci.yml` 删除标签触发与四个 `if`，恢复原语义；`resolveCiRun` 只认 `ci.yml` 的 `pull_request`/`push` 事件 run；策略测试：`ci.yml` 不含标签逻辑，发行工作流不含发布步骤、动作 SHA 固定、权限只读；README 更新。
- 文件：两个工作流、`scripts/release-candidate.mjs`、`tests/candidate-ci-policy.test.mjs`（改名为 release-candidate-policy）、`docs/release/README.md`。

## AF2 销售/OMS/订货中心指标的范围语义（ADR-0057 补充）
- 现状：这些指标无 `scopeAware`，`hide` 模式下对受限账号整体隐藏。
- 改动：为销售（按 `sales_orders.warehouse_id`/门店）、OMS（按平台履约仓）、订货中心（按客户归属组织）指标接入已有范围谓词（复用 `stockScopeSql`、`ocScope`、Y4 规则），标 `scopeAware: true`；受限账号得到按范围计算的值而非隐藏；`metrics-perms` 测试覆盖每组一条。
- 文件：`server/lib/metrics.js`、`tests/metrics-perms.test.mjs`、ADR。

## AF3 OMS 平台维度与受限范围语句走索引（ADR-0044 补充 5）
- 改动：`oms.stats_by_platform`/`stats_top_skus` 与受限范围变体改写为先按 `order_time` 区间取候选再按平台/范围过滤（或新增 `(platform_id, order_time)` 复合索引，迁移 074，按 AD3 方法量化写放大后二选一）；explain-audit 去掉对应 ALLOW；capacity-baseline 记录。
- 文件：`server/lib/oms-sql.js`、可能的迁移、`scripts/explain-audit.mjs`、`tests/oms-sql.test.mjs`、文档。

## AF4 审计 FTS 开关的在途请求与并发自愈
- 改动：`audit-view` 查询对 `no such table: audit_logs_fts` 做一次 LIKE 路径重试（并计数到指标）；启动自愈与维护脚本的重叠用 `BEGIN IMMEDIATE` + 有限重试并加重叠测试（两个进程同时 `--enable`/启动）；ADR-0054 补充 2。
- 文件：`server/lib/audit-view.js`、`server/routes/meta.js`、`server/db/migrations/runner.js`（只在自愈处）、`scripts/audit-fts-maintain.mjs`、测试。

## AF5 意图对账覆盖 `--against-backup` 与密钥保管
- 改动：`audit-verify-chain --against-backup` 对备份后新增锚点同样要求意图与佐证行；补"佐证行被归档"的正向测试（构造归档段末尾恰在佐证行之后的夹具）；`GML_ANCHOR_INTENT_KEY` 的 keygen/custody 写进 `audit-integrity.md`；`--require-signed-intents` 进 `offbox-anchor` 的每日流程。
- 文件：`scripts/audit-verify-chain.mjs`、`tests/audit-chain.test.mjs`、文档。

## AF6 备份持久性收口
- 现状：加密备份改名后未 fsync 目录、明文清单未 fsync（AE6 审计中）。
- 改动：`db-backup.mjs` 在加密路径改名后 fsync 目录、对 `.audit-manifest.json` 写后 fsync；`fs-fault` 增对应注入点；文档的持久性声明随之更新；Linux CI 日志里的 fs-fault 结果摘要登记到 capacity-baseline（若 PR 已跑过）。
- 文件：`scripts/db-backup.mjs`、`scripts/lib/fs-fault.mjs`、`tests/fs-fault.test.mjs`、文档。

## AF7 候选包供应链自检
- 改动：`candidate`（或 AF1 的新工作流）增 `npm audit signatures` 与"SBOM 对比上次候选"步骤（组件增删表进 artifact）；`verify-release` 增 `--sbom-diff <prev.cdx.json>`；策略测试覆盖。
- 文件：工作流、`scripts/verify-release.mjs`、`tests/*policy*.test.mjs`、文档。

## AF8 托管 runner 首跑（视 PR 合入情况，重复项）
- 同 AE8 规则：只在 `main` 已含对应工作流/job 时各派发一次并登记；否则只更新等待说明。

## AF9 `db` 限速模式的运行观测
- 改动：清理定时器的真实触发测试（把窗口与定时器周期做成可注入的 `GML_TEST_*`，测试模式下缩短到秒级）；`os_erp_mcp_rate_store_wait_seconds` 直方图记录写锁等待；在并发业务写（synth 写压测）下测 p95；文档写明 `synchronous` 建议。
- 文件：`server/lib/mcp-rate-limit.js`、`server/index.js`、`tests/mcp-rate-store-db.test.mjs`、`docs/operations/monitoring.md`、capacity-baseline。

## AF10 权限上下文忽略停用角色（ADR-0051 补充 3）
- 现状：`permContext` 计入停用角色的权限，矩阵只列启用角色。
- 改动：`permContext` 只合并 `roles.status='active'` 的角色；停用角色的账号若因此失去全部权限，登录后收到明确提示码；`authz-followups` 测试覆盖；角色矩阵生成器断言两者一致。
- 文件：`server/middleware/auth.js`（或权限解析处）、`server/lib/role-matrix.js`、测试、ADR。

## AF11 前端补齐第十四批
- 改动：指标目录按 `hidden_count` 之外再显示"按范围计算"标记（AF2）；MCP 令牌页在 `db` 模式下显示每令牌最近 429（来自 `mcp_rate_buckets`，管理员）；审计页 FTS 状态卡加"维护中"态（AF4 重试计数）；两个浏览器场景；本机只做 `tsc`/`vite build`/策略测试。
- 文件：`src/pages/system/*`、`tests/browser/*`、`scripts/browser-ci.mjs`。

## AF12 操作/安装手册补第十四批功能
- 改动：手册增指标隐藏模式与 `hidden_count`、自定义角色矩阵、`oms-sql`/查询计划说明、FTS 回路、锚点意图与 `--require-signed-intents`、`db` 限速模式与迁移 073、`evidence-log-ingest`、`dependency-review`、`GML_MCP_RATE_STORE`、`GML_ANCHOR_INTENT_KEY`；每条命令对照脚本参数；`docs:build` 并提交。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AF1 | feat/af1-release-workflow | — | — |
| AF2 | feat/af2-metrics-scope-aware | 0057 补充 | — |
| AF3 | feat/af3-oms-platform-index | 0044 补充 5 | 074（如需） |
| AF4 | feat/af4-audit-fts-races | 0054 补充 2 | — |
| AF5 | feat/af5-intents-against-backup | 0055 补充 2 | — |
| AF6 | feat/af6-backup-durability | — | — |
| AF7 | feat/af7-candidate-supply-chain | — | — |
| AF8 | feat/af8-hosted-first-runs-3 | — | — |
| AF9 | feat/af9-rate-db-observability | 0056 补充 2 | — |
| AF10 | feat/af10-permcontext-active-roles | 0051 补充 3 | — |
| AF11 | feat/af11-frontend-batch-fourteen | — | — |
| AF12 | feat/af12-operator-docs-7 | — | — |

冲突提示：AF1/AF7/AF8 都碰工作流文件（AF1 搬 job，AF7 只加步骤，AF8 只删过渡 job 或不动）；AF2 与 AF11 都碰指标页（数据层 / 布局）；AF4 与 AF11 都碰审计页（数据字段 / 布局）；AF5 与 AF6 都碰 `audit-integrity.md`（各自小节）；AF9 与 AF11 都碰 MCP 页（数据 / 布局）；AF10 只改权限解析与矩阵断言；AF12 只增文档。
