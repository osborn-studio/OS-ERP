# OS ERP 商用整改详细方案 v6（第十批）

日期：2026-10-23。基线：`batch-nine`（PR #5 候选，含 v2–v5 全部工作流）。承接 backlog "第九批后仍 open" 节与各 ADR 残留。通用约束、TDD、守卫清单（含 `check-route-authz`、`check-data-paths`、`explain-audit`、`gen-codemap --check`、`gen-changelog --check`、`gen-third-party-notices --check`）、Codex 审计方式与 [roadmap-v2](roadmap-v2.md) 相同。**新增硬约束**：不得对自己未启动的进程执行 `pkill`/`kill`；改动路由/模块/迁移/ADR 后运行 `node scripts/gen-codemap.mjs` 与 `node scripts/gen-changelog.mjs` 并提交生成物。ADR 从 0041 起，迁移从 063 起。`gen-changelog.mjs` 的第十批范围：ADR 41–52（第一个改到它的工作流负责加；其余工作流遇冲突以已有范围为准）。

---

## AA1 MCP 文档/订单追踪工具归属判定（ADR-0041）
- 现状：`order.trace_document`、`doc.query` 仍以 `dealer_id` 判归属（Z2 审计）。
- 改动：两工具改用 `DOC_SCOPE_RESOLVERS`（`docInScope`）+ Y6 绑定规则；`doc.query` 的 SQL 内嵌范围谓词而非取回后过滤；矩阵测试覆盖两工具四状态。
- 文件：`server/mcp/tools.js`（仅这两工具）、`tests/mcp-tool-matrix.test.mjs`、`tests/mcp-doc-perms.test.mjs`。

## AA2 OMS 写路由与 MCP 库存工具范围（ADR-0042）
- 改动：`oms.js` 的 ship/complete/refund/stock-push 按平台履约仓组织（Y4 规则），越权 404、目标仓不在范围 403（生产 503 不变）；MCP 库存工具（`inventory.*`/`stock.*`：查询、调拨、盘点相关）接入 `stockScopeSql`/`assertWarehouseInScope`（所有者范围）；矩阵测试覆盖。
- 文件：`server/routes/oms.js`、`server/mcp/tools.js`（仅库存工具）、`tests/oms-scope.test.mjs`（扩）、矩阵测试。

## AA3 审批模板维护权限（ADR-0043）
- 现状：受限管理员可把自己设为模板审批人，从而看到他组织待办（Z9 审计）。
- 改动：模板写路由要求全局数据范围或新权限 `system:approval:template`（迁移 063，只授 admin）；模板审批人只能是范围内组织的用户；审批人队列可见性叠加"实例目标单据在范围内 或 模板为全局模板"。更新 `authz-followups`/`approval-scope` 测试。
- 文件：`server/routes/approval.js`、`server/lib/approval.js`、`server/db/migrations/063_approval_template_perm.cjs`、测试、守卫登记。

## AA4 库存范围谓词覆盖剩余入口（ADR-0038 补充）
- 改动：`lib/qc.js` 处置调拨、`routes/warehouses.js`（主数据读按范围裁剪、写需全局）、采购收货/退货路由（`purchase.js` receipts/returns 取单后 `assertPurchaseDocInScope`）、POS 门店库存（门店绑定 + 门店仓）统一接入；更新守卫登记。
- 文件：上述路由/lib、`tests/inventory-scope.test.mjs`（扩）。

## AA5 低库存口径统一与看板瓶颈（ADR-0044）
- 改动：`metrics.js`、`routes/ai.js`、`mcp/tools.js` 的低库存查询全部改调 `listBelowSafe`/`countBelowSafe`（带范围）；对 `/dashboard/summary` 用 `explain-audit` 的语句表逐段计时（临时 `GML_PROFILE=1` 输出各块耗时），找出 ≥50 ms 的块并优化（索引/预聚合/缓存 30 s），目标合成 medium 库 p95 < 150 ms；记录到 capacity-baseline。
- 文件：`server/lib/metrics.js`、`server/routes/dashboard.js`、`server/routes/ai.js`、`server/mcp/tools.js`（仅低库存处）、可能的迁移 064、`tests/dashboard-perf.test.mjs`（口径等价 + 计时上限按夹具）。

## AA6 审计日志检索性能（迁移 065）
- 改动：`audit_logs(module, created_at)`、`(user_id, created_at)`、`(entity, entity_id)` 索引；关键词检索限定在 action/entity/user_name 并要求至少 2 字符；COUNT 改为"最多 10,001"估算 + `has_more`；在合成 large 库上计时导出 5 万行。
- 文件：`server/db/migrations/065_audit_log_indexes.cjs`、`server/lib/audit-view.js`、`tests/audit-logs-view.test.mjs`（扩）、capacity-baseline。

## AA7 发行候选证据自动化
- 改动：`release-candidate.mjs --run-tests` 实际运行焦点套件与守卫并写 `origin: produced`；`--ci-run auto` 用 `gh run list --commit <sha>` 取最新成功的 CI run id（无 gh 或无记录则 `null` 并说明）；`verify-release --evidence` 校验 `produced` 结果与当前仓库测试文件哈希一致。
- 文件：`scripts/release-candidate.mjs`、`scripts/verify-release.mjs`、`tests/release-candidate.test.mjs`。

## AA8 浏览器场景补齐（Linux CI）
- 改动：新增 `tests/browser/my-scope.mjs`、`audit-logs.mjs`（过滤、导出按钮出现、无权限 403 提示）、`inventory-paging.mjs`（游标翻页不重不漏）；`scripts/browser-ci.mjs` 登记；本机只做 `node --check` 与策略测试。
- 文件：`tests/browser/*`、`scripts/browser-ci.mjs`、`tests/browser-ci-policy.test.mjs`。

## AA9 POS 剩余权限点（ADR-0025 补充）
- 改动：`pos.refund` 门禁作废订单按钮；交班差异结算（settle variance）从角色名改为权限码 `pos.shift.settle`（迁移 066，授 store 管理角色与 admin），服务端路由同步；前端按权限显示。
- 文件：`server/routes/pos.js`、`server/lib/pos2.js`、`src/pages/pos/*`、`src/utils/pos-actions.ts`、迁移、测试。

## AA10 指标导出与告警（ADR-0045）
- 改动：`GET /api/meta/metrics?format=prometheus`（admin 令牌或 `GML_METRICS_TOKEN` Bearer）输出文本格式；新增 counters：登录节流命中、审计写失败、备份年龄、写重试、CSP 违规数（若报告端点存在）；`docs/operations/monitoring.md` 给出 Prometheus 抓取与告警规则样例。
- 文件：`server/routes/meta.js`、`server/lib/ops-status.js`、`tests/metrics-export.test.mjs`、文档。

## AA11 迁移升级演练与耗时（迁移 061/062 大库）
- 改动：`scripts/upgrade-rehearsal.mjs`：在合成 large 库副本上从指定旧版本号开始应用后续迁移，记录每个迁移耗时与锁时间，失败时验证回退（复用 Y 的 upgrade-rollback-drill）；加入夜间工作流为可选步骤；结果写 capacity-baseline。
- 文件：脚本、`tests/upgrade-rehearsal.test.mjs`、`.github/workflows/nightly-capacity.yml`（仅加一步，默认关闭）。

## AA12 操作/安装手册补第七至九批功能
- 改动：安装手册增 `GML_TRUST_PROXY`、`GML_SESSION_TRANSPORT`/CSP、`GML_BACKUP_KEY`；操作手册增奇门密钥签发、我的数据范围、审计日志查看/导出、保留清理与擦除、发行候选流程、夜间容量基线解读；每条命令对照脚本 flag；`docs:build`。
- 文件：`docs/本地交付/*.md`、`README.md`（如需）。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| AA1 | feat/aa1-mcp-trace-query-scope | 0041 | — |
| AA2 | feat/aa2-oms-write-mcp-inventory-scope | 0042 | — |
| AA3 | feat/aa3-approval-template-perm | 0043 | 063 |
| AA4 | feat/aa4-stock-scope-remaining | 0038 补充 | — |
| AA5 | feat/aa5-low-stock-dashboard | 0044 | 064（如需） |
| AA6 | feat/aa6-audit-log-indexes | — | 065 |
| AA7 | feat/aa7-rc-evidence | — | — |
| AA8 | feat/aa8-browser-scenarios | — | — |
| AA9 | feat/aa9-pos-remaining-perms | 0025 补充 | 066 |
| AA10 | feat/aa10-metrics-export | 0045 | — |
| AA11 | feat/aa11-upgrade-rehearsal | — | — |
| AA12 | feat/aa12-operator-docs-2 | — | — |

冲突提示：AA1/AA2/AA5 都改 `server/mcp/tools.js`（各自限定工具）；AA3/AA9 各自迁移编号已分配；AA4 与 AA9 都碰 `routes/pos.js`（AA4 只加门店库存范围，AA9 只改作废/差异结算门禁）；AA10 与 Z8 的 `ops-status.js` 无并行冲突；AA8 与 AA12 只增文档/测试文件。
