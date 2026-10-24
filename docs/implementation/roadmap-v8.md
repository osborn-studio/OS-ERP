# OS ERP 商用整改详细方案 v8（第十二批）

日期：2026-10-23。基线：`batch-eleven`（PR #7 候选，含 v2–v7 全部工作流）。承接 backlog "第十一批后仍 open" 节与各 AB 报告的"未验证"项。通用约束、TDD、守卫清单（`check-route-authz`、`check-data-paths`、`check-file-header`、`check-bizcode-shape`、`check-api-contract`、`check-mcp-coverage`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式（`codex exec -m gpt-6.1-sol --sandbox read-only … </dev/null`）与 [roadmap-v2](roadmap-v2.md) 相同。**硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs && node scripts/gen-changelog.mjs && npm run gen:api` 并提交生成物；解决合并冲突时**不要**对非生成文件整文件 `checkout --ours/--theirs`（第十一批曾因此丢掉 AB3 的路由改动）；登录节流环境变量上限 10000；只在隔离临时目录与随机 loopback 端口上测试；不触发 GitHub 工作流、不改仓库设置（AC8 例外，见其说明）。ADR 从 0050 起，迁移从 070 起。`gen-changelog.mjs` 第十二批范围已登记为 ADR 53–64；**0050–0052 落在第十一批区间**，第一个用到 0050 的工作流把第十一批改为 46–49、第十二批改为 50–64（其余工作流遇冲突以已有范围为准）。

---

## AC1 MCP 采购工具与剩余聚合读口与 HTTP 对齐（ADR-0050）
- 现状：MCP `purchase.list_orders`、`report.dashboard_kpi` 按"仓库或目标门店在范围内"放行，宽于 HTTP 仅按仓库（AB1 审计高）；`POST /api/demand/dealer/summary` 接受范围外仓库、`GET /api/master/products(/:id)` 的 `stock_qty` 汇总全部仓库、`/api/master/overview` 仓库计数全局。
- 改动：MCP 两工具改用与 HTTP 相同的采购单范围谓词（抽成 `lib/purchase.js` 的单一函数，HTTP 与 MCP 同调）；三处 HTTP 读口接入 `stockScopeSql`/`assertWarehouseInScope`；矩阵测试与 `inventory-scope` 测试覆盖。
- 文件：`server/mcp/tools.js`（仅这两工具）、`server/lib/purchase.js`、`server/routes/demand.js`、`server/routes/master.js`、`tests/mcp-tool-matrix.test.mjs`、`tests/inventory-scope.test.mjs`。

## AC2 总部角色名单统一与 docflow 严格绑定（ADR-0051）
- 现状：`pos.js` 的 `HQ_ROLES` 与 `requisitions.js` 的 `HQ` 名单不同；`/api/docflow/*` 未开 `strictBinding`，未绑定门店、非总部角色、`data_scope=all` 的内部账号仍可读 RC/YQ/SH（AB7 审计高，既有）。
- 改动：新 `server/lib/hq-roles.js` 为唯一名单来源（取两处并集并在 ADR 中逐角色说明理由），三处改调；docflow 上下文开 `strictBinding`，总部角色豁免；新增设置键 `docflow_strict_store_binding`（危险键，默认开，可关以回退）；`authz-followups`/`docflow-scope` 测试覆盖开关两态。
- 文件：上述 lib、`server/routes/pos.js`、`server/routes/requisitions.js`、`server/routes/docflow.js`、`server/lib/doc-scope-registry.js`、`server/lib/settings.js`、测试。

## AC3 解析表剩余类型绑定规则（ADR-0011 补充 2）
- 现状：PS/PSF（仅受限范围时绑定）、DR（无 dealer_id 判定）、OC/OCS（`all` 快捷路径绕过 `ocScope`）、DS/RB（无自视）在 `DOC_SCOPE_RESOLVERS` 中无绑定规则，MCP 靠 `doc-perms.js` 兜底。
- 改动：逐类型补 `binding`（store/dealer/subject）并去掉 `scope=all` 对绑定的绕过；`check-mcp-coverage` 的双向漂移检查改为"所有 `DOC_VIEW_PERMS` 绑定类型都有解析表规则、无残留白名单"；矩阵测试每类型 × 绑定/未绑定/管理员。
- 文件：`server/lib/doc-scope-registry.js`、`scripts/check-mcp-coverage.mjs`、`tests/mcp-doc-perms.test.mjs`、`tests/mcp-tool-matrix.test.mjs`。

## AC4 看板剩余接口与 explain-audit 登记（ADR-0044 补充 2）
- 改动：`/dashboard/channel`、`/recent` 剖析（`GML_PROFILE=1`）并按 AB2 方式缓存或记录不缓存理由；`scripts/explain-audit.mjs` 登记 AB2 新写法的 `/top`（CROSS JOIN）与 `/inventory-dist`（单遍扫描）语句并声明 `expectIndex`；缓存命中率指标在 `monitoring.md` 给出告警阈值依据；capacity-baseline 补表。
- 文件：`server/routes/dashboard.js`、`scripts/explain-audit.mjs`、`tests/dashboard-perf.test.mjs`、文档。

## AC5 审计 FTS 维护与无 FTS5 路径的真实验证
- 改动：`scripts/audit-fts-maintain.mjs --optimize|--rebuild|--integrity-check --data-dir`（持锁时间写报告，`check-data-paths` 登记）；夜间工作流可选步骤（默认关）；`GML_AUDIT_FTS=0` 环境开关强制走 LIKE 路径，`ci.yml` 的 checks job 以该开关再跑一次 `tests/audit-logs-view.test.mjs`（真实无 FTS 路径，不再只靠模拟）；在合成 100 万行库上测 `rebuild` 持锁时间并写 capacity-baseline。
- 文件：脚本、`server/lib/audit-view.js`、`.github/workflows/ci.yml`（只加一步）、`tests/audit-logs-view.test.mjs`、文档。

## AC6 发行证据透明日志与 CI 签名口径（ADR-0052）
- 现状：证据签名无时间戳/透明日志；托管 CI 无密钥，CI 产出候选未签名。
- 改动：`docs/release/EVIDENCE-LOG.jsonl`（仓库内追加式日志，每行 = 候选名、EVIDENCE 哈希、签名摘要、前一行哈希，哈希链），`release-candidate.mjs --log` 追加、`verify-release --log` 校验链与包含关系；CI 候选明确标 `signature: null, built_by: 'hosted-ci'`，`verify-release` 对无签名候选输出醒目警告而非静默通过；README 说明"正式发行必须由持钥者在受控机器重签"。
- 文件：`scripts/release-candidate.mjs`、`scripts/verify-release.mjs`、`scripts/lib/evidence-sign.mjs`、`tests/release-signing.test.mjs`、`docs/release/README.md`。

## AC7 审计链锚点离机保存与归档崩溃恢复
- 现状：锚点/链尾摘要只在库内，对持写权限者无效；归档崩溃恢复未测。
- 改动：`db-backup.mjs` 把链尾哈希与锚点表摘要写入备份清单（加密备份内外各一份），`audit-verify-chain --against-backup <set>` 比对；`audit-archive` 加 `--resume`：导出文件完整但删除未提交时能安全重做，用测试在导出后、删除前以 `SIGKILL` 杀子进程并验证库与文件状态（复用 `tests/audit-chain.test.mjs` 的夹具）；运维手册写明离机保存流程。
- 文件：`scripts/db-backup.mjs`、`scripts/audit-verify-chain.mjs`、`scripts/audit-archive.mjs`、`tests/audit-chain.test.mjs`、`docs/operations/audit-integrity.md`。

## AC8 托管 runner 首次实跑夜间步骤与结果回写
- 改动：`capacity-summary.mjs` 对 `large-ci` 显示 `partial`/`reached`/`scale`；本工作流**允许且仅允许**用 `gh workflow run nightly-capacity.yml` 手动触发三次（`rehearsal=true snapshot_upto=58`；`scale=large-ci`；默认），等待完成后用 `gh run view --log` 取摘要行，把结果（含 partial 与耗时）写入 capacity-baseline "托管 runner" 小节；失败则记录失败原因与修复建议，不改仓库设置、不重跑超过三次。
- 文件：`scripts/capacity-summary.mjs`、`tests/nightly-capacity-policy.test.mjs`、`docs/implementation/capacity-baseline.md`。

## AC9 监控规则校验与 MCP 指标端到端
- 改动：`ci.yml` docker job 增一步用 `prom/prometheus` 镜像的 `promtool check rules` 校验 `docs/operations/alerts/*.yml`（把 `monitoring.md` 中的规则抽成真实 YAML 文件，文档引用它）；`tests/metrics-export.test.mjs` 增端到端：真实 `tools/call` 后 `/metrics` 中 `os_erp_mcp_tool_calls_total{tool,code}` 递增；`SIGTERM` 时指标快照写入日志（便于重启前后对账）。
- 文件：`docs/operations/alerts/*.yml`、`docs/operations/monitoring.md`、`.github/workflows/ci.yml`（只加一步）、`tests/metrics-export.test.mjs`、`server/lib/metrics-export.js`。

## AC10 依赖链处置与 CI 审计门禁
- 改动：联网复核 GHSA-vfj7-8cjw-p6xm 状态（撤回则更新 `dependency-notes.md` 与 `06_依赖安全说明.md`，去掉"保留告警"）；评估 `npm overrides` 或升级 tailwind/chokidar 以消除 `braces` 旧链（只动 devDependencies，`npm ci` 后跑 `npm run build` 与浏览器策略测试）；`ci.yml` checks job 增 `npm audit --omit=dev --audit-level=high` 并以 `docs/security/audit-allowlist.json`（带到期日与理由）豁免；`gen-third-party-notices --check` 仍须通过。
- 文件：`package.json`/`package-lock.json`、`docs/security/*`、`.github/workflows/ci.yml`（只加一步）、`scripts/check-audit-allowlist.mjs`（新，登记守卫）。

## AC11 前端补齐第十一批功能
- 改动：审计页关键词 ≥3 字符走 FTS 的提示与"仅 action 需 module"交互；看板四接口显示"数据截至 hh:mm:ss（缓存 30 s）"并提供刷新；主数据仓库下拉范围为空时的空状态提示；指标端点 429 的运维页提示；为审计 FTS 与看板缓存各加一个浏览器场景（Linux CI）；本机只做 `tsc`、`vite build` 与策略测试。
- 文件：`src/pages/system/AuditLogs.tsx`、`src/pages/dashboard/*`、`src/components/*`、`tests/browser/*`、`scripts/browser-ci.mjs`、`tests/browser-ci-policy.test.mjs`。

## AC12 操作/安装手册补第十一批功能
- 改动：操作手册增证据签名与密钥保管、哈希链校验与归档流程、旧结构快照演练、FTS 维护、奇门密钥签发 CLI、指标节流与令牌轮换；安装手册增 `GML_RELEASE_SIGN_KEY`、`GML_METRICS_TOKEN_NEXT`、`GML_METRICS_IP_LIMIT`、`GML_AUDIT_FTS`；每条命令对照脚本参数解析；`docs:build` 并提交生成物。
- 文件：`docs/本地交付/*.md`、`docs/operations/*.md`、`public/docs/*`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AC1 | feat/ac1-mcp-purchase-parity | 0050 | — |
| AC2 | feat/ac2-hq-roles-docflow-binding | 0051 | — |
| AC3 | feat/ac3-resolver-remaining-bindings | 0011 补充 2 | — |
| AC4 | feat/ac4-dashboard-rest-explain | 0044 补充 2 | — |
| AC5 | feat/ac5-audit-fts-maintain | — | — |
| AC6 | feat/ac6-evidence-log | 0052 | — |
| AC7 | feat/ac7-chain-anchors-offbox | 0049 补充 | — |
| AC8 | feat/ac8-hosted-nightly-run | — | — |
| AC9 | feat/ac9-promtool-mcp-metrics | 0045 补充 2 | — |
| AC10 | feat/ac10-dependency-audit-gate | — | — |
| AC11 | feat/ac11-frontend-batch-eleven | — | — |
| AC12 | feat/ac12-operator-docs-4 | — | — |

冲突提示：AC2 与 AC3 都改 `doc-scope-registry.js`（AC2 只加 `strictBinding` 的 HQ 豁免与设置键，AC3 只加各类型 `binding` 规则）；AC5/AC9/AC10 都给 `ci.yml` 加一步（各自独立 step，按名字排序叠加）；AC6 与 AC7 不碰同一脚本；AC4 只改 dashboard 与 explain-audit；AC11 只改前端与浏览器场景；AC12 只增文档。
