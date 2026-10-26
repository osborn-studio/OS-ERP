# OS ERP 商用整改详细方案 v10（第十四批）

日期：2026-10-24。基线：`batch-thirteen`（PR #9 候选，含 v2–v9 全部工作流）。承接 backlog "第十三批后仍 open" 节与各 AD 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`check-audit-allowlist`、`gen-role-matrix --check`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；不得从单个 Bash 调用里启动无硬超时的常驻服务；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`；给 `ci.yml` 加 job 时整块追加在文件末尾（第十三批两个 job 曾交错冲突）；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AE8 例外）。ADR 从 0057 起，迁移从 072 起。`gen-changelog.mjs` 第十三批范围为 ADR 53–64；第一个用到 0057 的工作流把第十三批改为 53–56、新增 `{ id: 14, title: '第十四批（进行中）：见 roadmap-v10', from: 57, to: 68 }`。

---

## AE1 指标按业务权限与受限角色口径（ADR-0057）
- 现状：`/api/metrics` 系列只需 `system:metrics:view`；无范围语义的指标对受限角色只是标注 `scoped:false`（AD1 审计高）。
- 改动：指标字典增 `perms`（对应业务查看权限），`/api/metrics`、`/values`、`/catalog` 按调用者权限过滤指标集合（缺权限的指标不出现而非 403）；新增危险设置键 `metrics_global_for_restricted`（默认 `hide`：受限角色不返回无范围语义指标；`label` 还原 AD1 行为）；前端目录页按返回集合渲染；矩阵与 `inventory-scope` 测试覆盖。
- 文件：`server/lib/metrics.js`、`server/routes/metrics.js`、`server/lib/settings.js`、`src/pages/system/Metrics.tsx`、测试、ADR。

## AE2 角色矩阵覆盖自定义角色、账号覆盖与多角色（ADR-0051 补充 2）
- 改动：`role-matrix.js`/`gen-role-matrix.mjs` 读取库内全部角色（含自定义）与 `users.data_scope` 覆盖分布（按值计数，不列账号），多角色账号按并集计算并单列"并集示例"；`/api/meta/role-matrix` 对管理员返回同样结构；页面增"自定义角色"分组与"我的并集"卡；`gen-role-matrix --check` 以内置角色为准，自定义角色只出现在 JSON 输出。
- 文件：`server/lib/role-matrix.js`、`scripts/gen-role-matrix.mjs`、`src/pages/system/RoleMatrix.tsx`、测试。

## AE3 OMS 统计与 AI 平台分析改走 order_time 索引（ADR-0044 补充 4）
- 改动：`oms.js` `/stats` 与 `ai.js` 平台分析的 `date(order_time)` 谓词改为区间谓词 + 复核（与 AD3 同法，SQL 抽到 `dashboard-sql.js` 或新 `oms-sql.js`）；explain-audit 登记并 `expectSearch`；`docs/operations/*.md` 写明"应用不执行 ANALYZE；若将来引入需复跑 explain-audit"；capacity-baseline 记录前后。
- 文件：`server/routes/oms.js`、`server/routes/ai.js`、`server/lib/oms-sql.js`（新）、`scripts/explain-audit.mjs`、测试、文档。

## AE4 审计 FTS 可选化的运维闭环与 Linux 真实无 FTS5 验证
- 改动：按 AD4 落地情况补齐：`audit-fts-maintain --disable|--enable` 的端到端操作手册与测试（含启用时回填 100 万行耗时写 capacity-baseline）；若 AD4 未能加无 FTS5 的 CI job，则在 `ci.yml` 增 job 以预编译参数 `--sqlite-omit-fts5`（或 `SQLITE_OMIT_FTS5` 经 `npm_config_*`）重建 `better-sqlite3` 并跑审计视图测试，超时 15 分钟即记录放弃原因。
- 文件：`scripts/audit-fts-maintain.mjs`、`.github/workflows/ci.yml`（整块追加）、`tests/audit-logs-view.test.mjs`、文档。

## AE5 锚点操作对账：预期锚点记录（ADR-0055 补充）
- 现状：`--accept-new-anchors` 后桥接锚点与合法锚点不可区分。
- 改动：保留清理、归档、擦除在新增锚点时同时写 `audit_anchor_intents`（迁移 072：操作类型、范围、操作者、签名后的意图哈希）；`audit-verify-chain` 对锚定区间内的新锚点要求存在匹配意图且意图在操作日志中有对应 `AUDIT_*` 行，否则仍判 `rewrite`；`--accept-new-anchors` 改为仅接受有意图记录的锚点。
- 文件：迁移、`server/lib/audit-trail.js`、`scripts/retention.mjs`、`scripts/audit-archive.mjs`、`scripts/lib/privacy-common.mjs`、`scripts/audit-verify-chain.mjs`、测试、ADR。

## AE6 故障注入矩阵上 Linux CI 与加密备份全覆盖
- 改动：`ci.yml` checks job 增一步跑 `tests/fs-fault.test.mjs`（已在焦点套件内则只确认），加密模式（`GML_BACKUP_KEY`）下覆盖 `backup.before-sidecar`/`after-sidecar` 注入点；记录 Linux 与 macOS 的差异（`rename` 原子性、`fsync` 目录语义）到 `audit-integrity.md`。
- 文件：`tests/fs-fault.test.mjs`、`scripts/db-backup.mjs`（如需）、文档。

## AE7 依赖卫生：开发依赖审计策略与定期检查入口
- 改动：`check-audit-allowlist` 增 `--include-dev` 模式与独立白名单段（开发依赖以 `critical` 为门槛、到期 180 天）；`ci.yml` 增手动 job `dependency-review`（`workflow_dispatch`，跑两种模式并上传 JSON 摘要）；`dependency-notes.md` 写复查节奏。
- 文件：`scripts/check-audit-allowlist.mjs`、`docs/security/audit-allowlist.json`、`.github/workflows/ci.yml`（整块追加）、测试、文档。

## AE8 托管 runner 首跑（视 PR 合入情况）
- 改动：若 `main` 已含 `nightly-capacity.yml`/`capacity-smoke`/`candidate`：各手动触发一次（最多三次），结果与 run id 写入 capacity-baseline 与 `docs/release/README.md`；通过后删除 `capacity-smoke` 过渡 job。若仍未合入：只更新文档说明等待项，不改工作流。
- 文件：`docs/implementation/capacity-baseline.md`、`docs/release/README.md`、可能的 `.github/workflows/ci.yml`。

## AE9 MCP 限速多进程共享与重启持久（ADR-0056 补充）
- 改动：`GML_MCP_RATE_STORE=memory|db`（默认 memory）；`db` 模式用 `mcp_rate_buckets` 表（迁移 073）按令牌 × 窗口原子累加（`INSERT … ON CONFLICT DO UPDATE`），跨进程一致、重启不清零；清理过期桶的后台任务复用现有定时器；基准：db 模式每次调用额外耗时写 capacity-baseline；告警规则补 `db` 模式写失败。
- 文件：`server/lib/mcp-rate-limit.js`、迁移、`tests/mcp-rate-limit.test.mjs`、文档。

## AE10 候选 job 收口：标签触发只跑候选，CI run 回退
- 改动：`ci.yml` 其余 job 对 `refs/tags/*` 加 `if` 跳过（候选 job 自带焦点套件与守卫）；`release-candidate --ci-run=auto` 在找不到成功 run 时回退记录当前 `GITHUB_RUN_ID`（标为 `self`，`origin: hosted-ci-self`）；新增 `scripts/evidence-log-ingest.mjs` 把 artifact 里的日志行校验后追加到仓库日志（本地执行，不在 CI）。
- 文件：`.github/workflows/ci.yml`、`scripts/release-candidate.mjs`、`scripts/evidence-log-ingest.mjs`（新）、`tests/candidate-ci-policy.test.mjs`、`tests/release-signing.test.mjs`、文档。

## AE11 前端补齐第十三批
- 改动：指标目录按 AE1 返回集合渲染并解释隐藏项；角色矩阵页自定义角色分组与"我的并集"（AE2）；审计页显示 FTS 启用状态（`audit_fts_enabled`）与维护提示；MCP 令牌页显示限速与配额设置、最近 429 计数；三个浏览器场景；本机只做 `tsc`/`vite build`/策略测试。
- 文件：`src/pages/system/*`、`tests/browser/*`、`scripts/browser-ci.mjs`。

## AE12 操作/安装手册补第十三批功能
- 改动：手册增角色矩阵与总部名单、离机锚点、FTS 可选化、MCP 限速与配额、候选 job、`capacity-smoke`、故障注入恢复表、`GML_MCP_*`/`GML_TEST_*`（测试专用）说明；每条命令对照脚本参数；`docs:build` 并提交。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AE1 | feat/ae1-metrics-perms-hide | 0057 | — |
| AE2 | feat/ae2-role-matrix-custom-roles | 0051 补充 2 | — |
| AE3 | feat/ae3-oms-ai-order-time | 0044 补充 4 | — |
| AE4 | feat/ae4-audit-fts-ops-loop | 0054 补充 | — |
| AE5 | feat/ae5-anchor-intents | 0055 补充 | 072 |
| AE6 | feat/ae6-fs-fault-linux | — | — |
| AE7 | feat/ae7-dev-dependency-audit | — | — |
| AE8 | feat/ae8-hosted-first-runs | — | — |
| AE9 | feat/ae9-mcp-rate-db-store | 0056 补充 | 073 |
| AE10 | feat/ae10-candidate-job-tags | — | — |
| AE11 | feat/ae11-frontend-batch-thirteen | — | — |
| AE12 | feat/ae12-operator-docs-6 | — | — |

冲突提示：AE4/AE6/AE7/AE8/AE10 都碰 `ci.yml`（各自整块追加 job 或只加一步，按名字叠加）；AE1 与 AE11 都碰 `Metrics.tsx`（AE1 只改数据层与隐藏项说明，AE11 只改布局）；AE2 与 AE11 都碰 `RoleMatrix.tsx`（AE2 只加数据字段，AE11 只加分组 UI）；AE5 与 AE9 迁移编号已分配；AE3 只改 OMS/AI 与 explain-audit；AE12 只增文档。
