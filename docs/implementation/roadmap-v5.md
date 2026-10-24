# OS ERP 商用整改详细方案 v5（第九批）

日期：2026-10-23。基线：`integration`（PR #4 head，含 roadmap v2–v4 全部工作流）。承接 backlog "第八批后仍 open" 节与各 ADR 残留。通用约束、TDD、守卫清单、Codex 审计方式与 [roadmap-v2](roadmap-v2.md) 相同；新增约束：**不得对其他工作树的进程执行 `pkill`/`kill`**，等待端口释放即可。ADR 从 0038 起，迁移从 061 起。

---

## Z1 采购订单状态/收货路由与库存路由范围（ADR-0038）
- 现状：`server/routes/purchase.js` 的 `/orders/:id/status`、`/orders/:id/receive` 无单据范围判定（Y1 审计）；`server/routes/inventory.js` 的库存查询/调拨/盘点读写未按仓库所属组织过滤。
- 改动：采购两条路由取单后 `assertPurchaseDocInScope`；库存域在 `server/lib/stock.js` 增 `stockScopeSql(orgScope)`（按 `warehouses.org_id`），库存查询、流水、调拨（两端）、盘点、调整路由统一接入；越权 404；写目标仓不在范围 403。更新守卫登记。
- 文件：`server/routes/purchase.js`、`server/routes/inventory.js`、`server/lib/stock.js`、`server/lib/transfer.js`、`tests/inventory-scope.test.mjs`。

## Z2 OMS 读接口与 MCP 单据历史范围（ADR-0039）
- 改动：`server/routes/oms.js` `GET /orders`、`/orders/:id` 按平台履约仓组织过滤（Y4 规则）；MCP `tools.js` 的单据历史/事件读工具改用 Y2 的 `DOC_SCOPE_RESOLVERS` 判定；矩阵测试覆盖。
- 文件：`server/routes/oms.js`、`server/mcp/tools.js`（仅历史读工具）、`tests/oms-scope.test.mjs`。

## Z3 大库热点查询改造（迁移 061）
- 现状（Y10）：`dash.todo_counts` 对 `product_skus`/`dealers` 全表扫描；`stock.below_safe` 扫 `product_skus`；`GET /api/inventory/stocks` 随行数线性。
- 改动：补索引（`product_skus(status, safe_qty)` 等按 EXPLAIN 结果）；`stock.below_safe` 改为预聚合查询；库存列表强制分页（默认 50，上限 500）并支持游标 `after_id`；前端库存页改用分页；`explain-audit` 在合成 large 库上 0 违规；用 `bench-api` 记录前后 p95。
- 文件：`server/db/migrations/061_hot_query_indexes.cjs`、`server/lib/stock.js`、`server/lib/metrics.js`、`server/routes/inventory.js`、`src/pages/inventory/*`、`docs/implementation/capacity-baseline.md`。

## Z4 受信代理配置（ADR-0040）
- 改动：`GML_TRUST_PROXY`（off | loopback | <CIDR 列表>）统一驱动 Express `trust proxy`、节流来源 IP、request-id 透传、HSTS 与 Cookie Secure；默认 off；配置文档与 compose 示例；测试覆盖伪造头在 off 下无效、在 CIDR 命中时生效。
- 文件：`server/index.js`、`server/lib/trust-proxy.js`（新）、`server/lib/login-throttle.js`（读统一判定）、`server/lib/logger.js`、`server/middleware/security-headers.js`、`server/middleware/session-transport.js`、`tests/trust-proxy.test.mjs`。

## Z5 发行候选打包与证据包
- 改动：`scripts/release-candidate.mjs`：在干净检出上执行 `npm run release`，生成 `release/RC-<version>-<sha>.zip`、`.sha256`、`EVIDENCE.json`（焦点测试/守卫/回归/合成演练结果引用、CI run id）、CHANGELOG 节选；`verify-release` 校验 EVIDENCE 字段；文档 `docs/release/README.md` 说明"候选 ≠ 发布"。
- 文件：`scripts/release-candidate.mjs`、`scripts/verify-release.mjs`、`tests/release-candidate.test.mjs`、`docs/release/README.md`。

## Z6 当前用户有效范围页（前端 + 1 个只读接口）
- 改动：`GET /api/auth/my-scope` 返回解析后的组织范围、门店/经销商绑定、角色默认、是否管理员；`src/pages/system/MyScope.tsx` 展示并解释"为什么我看不到某数据"，链接到 ScopeNotice；守卫登记为 self 类。
- 文件：`server/routes/auth.js`、`src/pages/system/MyScope.tsx`、`tests/my-scope.test.mjs`。

## Z7 审计日志查看器（前端 + 过滤接口）
- 先检查是否已有：若 `server/routes/meta.js` 或 system 页面已有审计查询则增强，否则新增 `GET /api/meta/audit-logs`（admin 或 `system:audit:view`，分页、按模块/动作/用户/时间过滤、detail 已脱敏）与 `src/pages/system/AuditLogs.tsx`；导出 CSV 走同一过滤且受 ADR-0030 保留策略提示。
- 文件：`server/routes/meta.js`、`src/pages/system/AuditLogs.tsx`、`tests/audit-logs-view.test.mjs`。

## Z8 MCP 幂等缓存命中前重验（ADR-0011 补充）
- 现状：同幂等键重放在所有者失权后仍返回缓存结果。
- 改动：缓存命中前重跑凭据/权限/范围闸门，失败则返回当前错误而非缓存；审计记录"缓存拒绝"；矩阵测试加重放状态。
- 文件：`server/mcp/server.js`（仅幂等分支）、`tests/mcp-delegation.test.mjs`、ADR-0011 补充。

## Z9 审批管理员范围开关（ADR-0037 补充）
- 改动：设置 `approval_manager_global`（危险键，默认 1 保持现状）；为 0 时 `system:approval:manage` 只见范围内实例；更新 `tests/authz-followups.test.mjs` 为两种设置各断言一次；`test-setting-audit` 危险键 17→18。
- 文件：`server/lib/approval.js`、`server/lib/settings.js`、`scripts/test-setting-audit.mjs`、测试。

## Z10 夜间容量基线工作流
- 改动：`.github/workflows/nightly-capacity.yml`（schedule + dispatch，ubuntu-latest，SHA 固定 actions）：`synth-pipeline.mjs` medium 规模 → `explain-audit` → `bench-api`（读+写档），只上传 JSON 摘要；失败只在 explain 违规或错误率 >0 时标红；文档说明托管 runner 数字非目标主机。
- 文件：工作流、`docs/implementation/ci.md`、`tests/nightly-capacity-policy.test.mjs`。

## Z11 依赖刷新与公告处理
- 改动：在不升大版本的前提下 `npm update` 补丁/次版本（锁文件重生），逐包列出变化；评估 braces 链（Tailwind 3 → 评估 3.4 最新是否仍带 braces 3.0.3；若无修复则维持并记录）；`npm audit --omit=dev` 保持 0；`tests/dependency-security` 与 W9 声明/SBOM 重新生成；全部测试绿。
- 文件：`package.json`、`package-lock.json`、`THIRD_PARTY_NOTICES.md`、`docs/implementation/dependency-alerts.md`。

## Z12 架构导航与代码地图
- 改动：`docs/CODEMAPS/`（server 路由→lib→表的映射表，自动从 `check-route-authz --list` 与 openapi 生成：`scripts/gen-codemap.mjs`）；`docs/implementation/ADR-INDEX.md` 自动索引（标题、状态、批次）；`docs/implementation/development.md` 增"新人 30 分钟路径"；生成脚本带 `--check` 并入 CI checks job。
- 文件：`scripts/gen-codemap.mjs`、`docs/CODEMAPS/*`、`docs/implementation/ADR-INDEX.md`、`.github/workflows/ci.yml`（仅加一步）、`tests/codemap.test.mjs`。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| Z1 | feat/z1-inventory-scope | 0038 | — |
| Z2 | feat/z2-oms-mcp-history-scope | 0039 | — |
| Z3 | feat/z3-hot-queries | — | 061 |
| Z4 | feat/z4-trust-proxy | 0040 | — |
| Z5 | feat/z5-release-candidate | — | — |
| Z6 | feat/z6-my-scope | — | — |
| Z7 | feat/z7-audit-log-viewer | — | — |
| Z8 | feat/z8-mcp-idempotency-recheck | 0011 补充 | — |
| Z9 | feat/z9-approval-manager-switch | 0037 补充 | — |
| Z10 | feat/z10-nightly-capacity | — | — |
| Z11 | feat/z11-dependency-refresh | — | — |
| Z12 | feat/z12-codemaps | — | — |

冲突提示：Z1/Z3 都改 `server/lib/stock.js`（Z1 只加范围谓词与接入，Z3 只改 below_safe 与分页查询）与 `server/routes/inventory.js`（Z1 加闸门，Z3 加分页参数）——各自限定函数；Z6/Z7 都加 system 页面与路由，文件不同；Z10/Z12 都改 `ci.yml`（Z10 新文件，Z12 加一步）；Z11 的锁文件变化与 Z5 的打包测试在集成时一并重跑。
