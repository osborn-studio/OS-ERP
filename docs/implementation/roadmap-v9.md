# OS ERP 商用整改详细方案 v9（第十三批）

日期：2026-10-24。基线：`batch-twelve`（PR #8 候选，含 v2–v8 全部工作流）。承接 backlog "第十二批后仍 open" 节与各 AC 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`check-audit-allowlist`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；不得从单个 Bash 调用里启动无硬超时的常驻服务（AB9 曾因此卡住两小时）；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AD8 例外，见其说明）。ADR 从 0053 起，迁移从 070 起。`gen-changelog.mjs` 第十二批范围为 ADR 50–64；第一个用到 0053 的工作流把第十二批改为 50–52、新增 `{ id: 13, title: '第十三批（进行中）：见 roadmap-v9', from: 53, to: 64 }`（其余工作流遇冲突以已有范围为准）。

---

## AD1 指标接口与 KPI 工具的范围与权限（ADR-0053）
- 现状：`/api/metrics`、`/metrics/values`、`/catalog` 对受限角色仍返回全局 `stock_qty`/`purchase_amount*`；MCP `report.dashboard_kpi` 为 `perms: []`、`/dealer/summary` 无采购查看权限仍回在途量（AC1 审计）。
- 改动：指标函数（`server/lib/metrics.js`）接受 `orgScope` 并在库存/采购类指标上套 `stockScopeSql`/`purchaseOrderScopeSql`；没有范围语义的指标（全局财务）对受限角色返回 `scoped: false` 并由前端标注"全局口径"；`report.dashboard_kpi` 按子项要求对应查看权限，缺权限的子项省略而非 403；`/dealer/summary` 要求 `PO_READ_PERMS`。矩阵与 `inventory-scope` 测试覆盖。
- 文件：`server/lib/metrics.js`、`server/routes/metrics.js`、`server/mcp/tools.js`（仅 `report.dashboard_kpi`）、`server/routes/demand.js`、测试、ADR。

## AD2 总部角色产品决定落地与角色矩阵文档（ADR-0051 补充）
- 改动：把 `boss` 纳入 `HQ_ROLES`（总经理视角可见全部门店单据，ADR 记理由），POS/订货中心派生名单不变；新增 `docs/operations/role-matrix.md` 由脚本 `scripts/gen-role-matrix.mjs` 从权限字典与 `hq-roles.js` 生成（`--check` 入 CI），列出每个内置角色对 40 类单据的可见性与 MCP 绑定要求；`authz-followups` 测试断言矩阵与实际路由门禁一致（抽样 10 条）。
- 文件：`server/lib/hq-roles.js`、新脚本、文档、`.github/workflows/ci.yml`（只加一步）、测试。

## AD3 `oms_orders.order_time` 索引与 trend/channel 线上分支（迁移 070）
- 现状：`/channel`、`/trend` 线上分支对 `oms_orders` 整表读取（`date(order_time)` 套函数）；`dash.trend_*` 的 explain-audit 登记是人工镜像。
- 改动：迁移 070 加 `oms_orders(order_time)` 索引（写放大按 AA6 方法量化）；SQL 改为区间谓词 `order_time >= ? AND order_time < ?` 以用索引；`trend` 的 SQL 搬进 `dashboard-sql.js` 并登记 `expectIndex`；capacity-baseline 记录前后计划与耗时。
- 文件：迁移、`server/lib/dashboard-sql.js`、`server/routes/dashboard.js`、`scripts/explain-audit.mjs`、`tests/dashboard-perf.test.mjs`、文档。

## AD4 无 FTS5 构建的真实验证与 FTS 可选化（ADR-0054）
- 现状：`GML_AUDIT_FTS=0` 仍保留 067 的表与触发器，不等于无 FTS5 构建。
- 改动：迁移 071 `071_audit_fts_optional.cjs`：读取设置键 `audit_fts_enabled`（危险键，默认开）；关闭时删除 FTS 表与触发器（可逆：再开启即重建并回填）；`audit-fts-maintain --disable|--enable` 作为运维入口；CI 增一个 job 用 `better-sqlite3` 的无 FTS5 编译（`npm rebuild better-sqlite3 --build-from-source` + `SQLITE_OMIT_FTS5`，若 runner 上编译超过 10 分钟则改为仅文档说明并记录）跑 `audit-logs-view` 测试。
- 文件：迁移、`server/lib/audit-view.js`、`scripts/audit-fts-maintain.mjs`、`.github/workflows/ci.yml`、测试、ADR。

## AD5 透明日志与审计链的离机副本（ADR-0055）
- 现状：透明日志无法发现"删最新几行"或整文件替换；审计链锚点需离机保存。
- 改动：`scripts/offbox-anchor.mjs --dest <abs dir or ssh://host/path>`：把 `EVIDENCE-LOG.jsonl` 尾哈希、各库审计链尾、锚点摘要写成签名（Ed25519，复用 AB4 密钥）的 `anchor-<stamp>.json` 到目标目录（本地目录或经 `ssh`/`scp` 的远端，远端只用现有 SSH 别名、不改认证）；`verify-release --log --offbox <file>`、`audit-verify-chain --offbox <file>` 比对；运维手册写"每日锚点"流程。
- 文件：新脚本、`scripts/verify-release.mjs`、`scripts/audit-verify-chain.mjs`、测试、文档、ADR。

## AD6 真实掉电模拟与归档/备份原子性
- 现状：归档崩溃只测了 SIGKILL。
- 改动：用 `GML_TEST_FS_FAULT=<step>` 注入点在 `fsync` 之后、`rename` 之前等关键步骤抛错或 `process.abort()`，覆盖 `audit-archive`、`db-backup`、`release-candidate --log` 的写入序列；测试断言每个注入点后的目录状态都能被 `--resume`/下一次运行安全接续；文档列出各步骤的恢复语义。
- 文件：`scripts/lib/fs-fault.mjs`（新）、三个脚本、`tests/audit-chain.test.mjs`、`tests/db-backup.test.mjs`、`tests/release-signing.test.mjs`。

## AD7 `zod` 移除与 SBOM/声明回归
- 改动：删除未使用的 `zod` 依赖（确认 `server/lib/xlsx.js` 注释无运行时引用），`npm ci` 后重生成 SBOM 与 `THIRD_PARTY_NOTICES.md`，`check-audit-allowlist` 白名单项删除；`package-lock.json` 变更最小化；浏览器策略测试与构建通过。
- 文件：`package.json`、`package-lock.json`、`THIRD_PARTY_NOTICES.md`、`docs/security/audit-allowlist.json`、`docs/security/dependency-notes.md`。

## AD8 托管 runner 夜间步骤首跑（视 PR 合入情况）
- 改动：若 `main` 已含 `nightly-capacity.yml`（PR #7 合入后），按 AC8 登记的三条命令触发（最多三次），结果写入 capacity-baseline "托管 runner" 表；若仍未合入，改为在 `ci.yml` 增加 `workflow_dispatch` 入口的 `capacity-smoke` job（medium 规模、30 分钟内）作为过渡，并记录。不改仓库设置。
- 文件：`docs/implementation/capacity-baseline.md`、可能的 `.github/workflows/ci.yml`。

## AD9 MCP 工具级速率限制与配额（ADR-0056）
- 现状：MCP 令牌调用无速率限制；指标端点已有按 IP 节流（AB10）。
- 改动：按令牌的滑动窗口限制（`GML_MCP_TOKEN_RPM` 默认 600，写工具另有 `GML_MCP_WRITE_RPM` 默认 60），429 `MCP_RATE_LIMITED` 经 `bizFail`，计数进 `os_erp_mcp_tool_calls_total{code}`；令牌级日配额可选（设置键）；矩阵测试覆盖。
- 文件：`server/mcp/server.js`、`server/lib/metrics-throttle.js`（抽通用桶）、`server/lib/settings.js`、测试、ADR、监控文档。

## AD10 发行候选流水线：托管 CI 产出候选并记录透明日志
- 改动：`ci.yml` 增 `candidate` job（仅 `workflow_dispatch` 与 tag 推送触发）：`release-candidate --run-tests --ci-run auto --log`，上传 zip + evidence 为 artifact（不发布 Release），把透明日志行作为 PR 评论或 artifact 输出（不自动提交到仓库）；`verify-release` 在 job 内对产物自检。文档说明"托管候选未签名，正式发行须持钥者重签"。
- 文件：`.github/workflows/ci.yml`、`scripts/release-candidate.mjs`（仅 CI 友好的输出）、`docs/release/README.md`、`tests/release-candidate.test.mjs`。

## AD11 前端：角色矩阵页与范围说明
- 改动：系统管理下新增只读"角色与数据范围"页：展示 AD2 生成的矩阵、当前账号的范围与绑定（复用 `/api/auth/my-scope`）、指标页的"全局口径"标注（AD1）；浏览器场景一个；本机只做 `tsc`/`vite build`/策略测试。
- 文件：`src/pages/system/*`、`src/components/*`、`tests/browser/*`、`scripts/browser-ci.mjs`。

## AD12 操作/安装手册补第十二批功能
- 改动：手册增角色矢量与总部名单、离机锚点流程、FTS 可选化、MCP 速率限制、CI 候选产出、`GML_MCP_*` 环境变量；每条命令对照脚本参数；`docs:build` 并提交。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AD1 | feat/ad1-metrics-scope-perms | 0053 | — |
| AD2 | feat/ad2-hq-boss-role-matrix | 0051 补充 | — |
| AD3 | feat/ad3-oms-order-time-index | 0044 补充 3 | 070 |
| AD4 | feat/ad4-audit-fts-optional | 0054 | 071 |
| AD5 | feat/ad5-offbox-anchors | 0055 | — |
| AD6 | feat/ad6-fs-fault-injection | — | — |
| AD7 | feat/ad7-remove-zod | — | — |
| AD8 | feat/ad8-hosted-nightly-run-2 | — | — |
| AD9 | feat/ad9-mcp-rate-limit | 0056 | — |
| AD10 | feat/ad10-ci-candidate-job | — | — |
| AD11 | feat/ad11-frontend-role-matrix | — | — |
| AD12 | feat/ad12-operator-docs-5 | — | — |

冲突提示：AD2/AD4/AD8/AD10 都可能给 `ci.yml` 加 job 或 step（各自独立、按名字叠加）；AD1 与 AD9 都碰 `server/mcp/tools.js`/`server.js`（AD1 只改 `report.dashboard_kpi`，AD9 只改服务器入口的限流）；AD3 与 AD4 迁移编号已分配；AD5 与 AD6 都碰 `audit-archive.mjs`（AD5 不改它，只读锚点；AD6 只加注入点）；AD11 只改前端；AD12 只增文档。
