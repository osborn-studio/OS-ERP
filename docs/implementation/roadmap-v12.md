# OS ERP 商用整改详细方案 v12（第十六批）

日期：2026-10-24。基线：`batch-fifteen`（PR #11 候选，含 v2–v11 全部工作流）。承接 backlog "第十五批后仍 open" 节与各 AF 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`check-audit-allowlist`（含 `--include-dev`）、`gen-role-matrix --check`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`，防御性措辞）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；不得从单个 Bash 调用里启动无硬超时的常驻服务；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`；工作流文件：`ci.yml` 只放 PR/main 门禁 job，发行相关步骤放 `release-candidate.yml`，新 job 整块追加文件末尾；前端"槽位"约定不变；`tests/offbox-anchor.test.mjs` 的最小发行包夹具列出了 `scripts/lib` 的文件白名单——给 `verify-release` 新增 lib 依赖时同步补该正则；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AG8 例外）。ADR 从 0058 起（第十五批未新增 ADR 编号），迁移从 075 起。`gen-changelog.mjs` 第十五批范围为 ADR 58–70；第一个用到 0058 的工作流把第十五批改为"无新 ADR"占位或删除该行、新增 `{ id: 16, title: '第十六批（进行中）：见 roadmap-v12', from: 58, to: 70 }`（以生成结果与 `release-candidate` 测试通过为准）。

---

## AG1 发行工作流首跑前置：从分支触发的演练（release-candidate.yml）
- 现状：`release-candidate.yml`、`capacity-smoke`、`dependency-review`、`audit-no-fts5` 都未在托管 runner 上跑过；PR #4–#10 待批准，main 上没有这些文件。
- 改动：在工作流里加 `workflow_dispatch` 输入 `dry_run`（默认 false）：为 true 时跳过 `--run-tests` 的焦点套件（只跑守卫与验收）并把 artifact 标为 `dry-run`，便于合入后首跑快速发现 runner 环境问题；策略测试覆盖；README 说明首跑步骤。
- 文件：`.github/workflows/release-candidate.yml`、`scripts/release-candidate.mjs`（`--skip-focused` 仅在 `GITHUB_ACTIONS` 下允许并写进证据）、`tests/release-candidate-policy.test.mjs`、`docs/release/README.md`。

## AG2 指标：范围语义的覆盖率守卫与"全局口径"清零（ADR-0057 补充 2）
- 改动：`scripts/check-metrics-scope.mjs`：每个指标必须声明 `scopeAware: true` 或带理由的 `scopeless: '<reason>'`，否则守卫红；登记进 `check-file-header` 与 CI checks job 一步；对仍为 scopeless 的指标逐个评估并尽量接入范围（AF2 未覆盖者）；`metrics-perms` 测试断言守卫与运行时一致。
- 文件：新脚本、`server/lib/metrics.js`、`.github/workflows/ci.yml`（只加一步）、测试、ADR。

## AG3 OMS/AI 查询计划回归守卫
- 现状：AF3 选定的方案（改写或迁移 074）需要防止回退；`ANALYZE` 政策只在文档。
- 改动：`explain-audit` 增 `--snapshot <file>` / `--compare <file>`：把每条语句的计划指纹（去掉参数）存档为 `docs/implementation/explain-plans.json`，CI 以 `--compare` 守卫计划漂移（白名单理由）；`tests/explain-plan-guard.test.mjs`；若应用某处调用 `ANALYZE`/`PRAGMA optimize`，守卫红（源码扫描）。
- 文件：`scripts/explain-audit.mjs`、`docs/implementation/explain-plans.json`、`.github/workflows/ci.yml`（只加一步）、测试、`docs/operations/query-planner.md`。

## AG4 审计写路径与 FTS 触发器并发压力测试
- 现状：AF4 未做审计 INSERT 触发器与 `--disable` 的并发压测。
- 改动：`scripts/bench-audit-toggle-under-write.mjs`：一个写入者进程持续经 `insertAuditRow` 写入（每秒 N 行），同时执行 `--disable`/`--enable` 若干轮，统计写失败、重试与 `fallback_total`；加入 `tests/audit-fts-races.test.mjs` 一个缩小版用例（秒级）；capacity-baseline 记录。
- 文件：新脚本、`tests/audit-fts-races.test.mjs`、`docs/implementation/capacity-baseline.md`。

## AG5 锚点意图的签名密钥轮换与多密钥校验（ADR-0055 补充 3）
- 改动：`--intent-pubkey` 可传多次或传目录（历史公钥集合），意图记录 `key_id`（公钥指纹）；`release-keygen --purpose anchor-intent --rotate` 生成新对并保留旧公钥；`audit-verify-chain`/`offbox-anchor` 按 `key_id` 选公钥；运维手册写轮换流程。
- 文件：`server/lib/audit-anchor-intent.js`、`scripts/lib/anchor-intent-signer.mjs`、`scripts/release-keygen.mjs`、`scripts/audit-verify-chain.mjs`、`scripts/offbox-anchor.mjs`、测试、文档、ADR。

## AG6 备份报告与清理删除的持久性收口
- 现状：AF6 记录报告文件与清理删除未 fsync。
- 改动：`db-backup.mjs` 报告文件写入走 write-fsync-rename，清理（prune）删除后 fsync 目录；`fs-fault` 增两个注入点与测试；§5b 表更新；`restore-runbook.md` 补"报告缺失但备份完整"的恢复语义。
- 文件：`scripts/db-backup.mjs`、`scripts/lib/fs-fault.mjs`、`tests/fs-fault.test.mjs`、文档。

## AG7 供应链：npmmirror 解析包的签名覆盖
- 现状：锁文件里 341 个包解析自 npmmirror，`npm audit signatures` 很可能不覆盖它们。
- 改动：评估把 `.npmrc` 改为 npmjs 官方源（或在 CI 用 `--registry` 重解析 lockfile 生成临时 lock 做签名核验）；`scripts/check-lock-registry.mjs` 报告每个 registry 的包数并在 CI 输出；若切换源，重生成 lockfile 并验证 `npm ci`、构建、通知清单；文档记录决定。
- 文件：`.npmrc`、`package-lock.json`（如切换）、新脚本、`.github/workflows/release-candidate.yml`（只加一步）、`docs/security/dependency-notes.md`。

## AG8 托管 runner 首跑（视 PR 合入情况，重复项）
- 同 AE8/AF8 规则；若 `release-candidate.yml` 已在 main，用 AG1 的 `dry_run=true` 先跑一次再跑完整一次。

## AG9 MCP 限速的告警阈值校准与配额用量接口
- 改动：用 AF9 的基准数据为 `OsErpMcpRateStoreWaitHigh` 给出阈值推导（写进 `monitoring.md`）；新增 `GET /api/mcp/limits/quota`（管理员）：每令牌今日配额用量与剩余；前端卡片显示；`db` 模式下的每令牌 429 精确计数：迁移 075 给 `mcp_rate_buckets.kind` 增 `denied` 并在拒绝时记一行（不参与限额判定），AF11 的 `rate_limited_recent` 改为精确值。
- 文件：迁移、`server/lib/mcp-rate-limit.js`、`server/mcp/admin.js`、`src/pages/system/McpCenter.tsx`、测试、文档、ADR-0056 补充 3。

## AG10 角色停用的前端提示与数据范围说明随状态
- 现状：AF10 的 `ROLE_INACTIVE_NOTICE` 前端未显示；数据范围说明仍按主角色字段不看状态。
- 改动：登录后与"我的数据范围"页显示停用角色提示；`my-scope` 的范围说明按生效角色（活跃）计算；浏览器场景一个。
- 文件：`src/pages/system/MyScope.tsx`、登录后布局组件、`server/routes/auth.js`（范围说明处）、`tests/browser/*`、测试。

## AG11 前端补齐第十五批
- 改动：指标页"按范围计算"标记接 AF2 的 `scoped` 字段并去掉推断逻辑；审计页 FTS 回退槽位接 AF4 的 `fallback_total`；MCP 页接 AG9 配额接口（槽位先留）；两个浏览器场景；本机只做 `tsc`/`vite build`/策略测试。
- 文件：`src/pages/system/*`、`tests/browser/*`、`scripts/browser-ci.mjs`。

## AG12 操作/安装手册补第十五批功能
- 改动：手册增 `release-candidate.yml` 的触发与 `dry_run`、供应链步骤（签名核验、SBOM 对比）、意图签名密钥与轮换、FTS 回退计数、`db` 限速观测直方图与告警、停用角色提示、`GML_TEST_*` 新增变量；每条命令对照脚本参数；`docs:build` 并提交。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AG1 | feat/ag1-release-dry-run | — | — |
| AG2 | feat/ag2-metrics-scope-guard | 0057 补充 2 | — |
| AG3 | feat/ag3-explain-plan-guard | 0044 补充 6 | — |
| AG4 | feat/ag4-audit-toggle-under-write | — | — |
| AG5 | feat/ag5-intent-key-rotation | 0055 补充 3 | — |
| AG6 | feat/ag6-backup-report-durability | — | — |
| AG7 | feat/ag7-lock-registry | — | — |
| AG8 | feat/ag8-hosted-first-runs-4 | — | — |
| AG9 | feat/ag9-mcp-quota-denied | 0056 补充 3 | 075 |
| AG10 | feat/ag10-inactive-role-ui | 0051 补充 4 | — |
| AG11 | feat/ag11-frontend-batch-fifteen | — | — |
| AG12 | feat/ag12-operator-docs-8 | — | — |

冲突提示：AG1/AG7/AG8 都碰 `release-candidate.yml`（AG1 加输入与条件，AG7 只加一步，AG8 不改）；AG2/AG3 各给 `ci.yml` checks job 加一步；AG9 与 AG11 都碰 MCP 页（数据 / 布局）；AG10 与 AG11 都碰系统页（各自页面）；AG5 与 AG6 不碰同一脚本；AG4 只加脚本与一个测试用例；AG12 只增文档。
