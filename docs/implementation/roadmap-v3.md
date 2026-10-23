# OS ERP 商用整改详细方案 v3（第七批）

日期：2026-10-23。基线：`integration`（PR #3 head，含 roadmap-v2 W1–W12）。v2 的 12 条全部完成；本方案承接 W2 路由守卫揭出的授权缺口、各 ADR 的"未做"段落和 backlog 剩余 open 项。通用约束、TDD、守卫清单、Codex 审计方式与 [roadmap-v2](roadmap-v2.md) 完全相同（含新守卫 `check-route-authz`：收口任何路由后必须同步更新其 allowlist，守卫的过期登记检查会红）。ADR 编号从 0025 起，迁移从 058 起。

---

## X1 POS 路由授权（ADR-0025）

- 现状：`server/routes/pos.js` 19 条路由只靠 `storeCtx` 要求门店绑定；任何门店账号都能做交班批准/驳回、缴款、日结。
- 改动：按动作定义权限码（如 `pos.sale`, `pos.shift.open/close`, `pos.shift.approve`, `pos.cash.deposit`, `pos.daily_close`），路由链加 `requireStore` + `requirePerm`；交班批准/驳回要求与开班/交班人不是同一人（复用 ADR-0018 的自审拒绝思路，`POS_SELF_APPROVE`）；门店账号只能操作自己绑定门店的单据（`storeCtx` 已有，补断言测试）。权限码加入权限字典与内置角色（store 角色得日常权限，store 管理角色得审批），走迁移 058 按 ADR-0007 政策。
- 文件：`server/routes/pos.js`、`server/lib/pos2.js`、`server/db/migrations/058_pos_permissions.cjs`、`scripts/check-route-authz.mjs`（删除 pos 组登记）、`tests/pos-authz.test.mjs`。
- 验收：无权限门店账号 403；跨门店 404；自审 409；admin 正常；legacy `node scripts/test-pos2.mjs cosmetic` 绿。

## X2 销售域内部账号组织范围（ADR-0026）

- 现状：`server/routes/sales.js` 的订单/发货/退货/统计读，`scopeFilter`/`assertCanRead` 只按经销商/门店绑定限制，内部 `data_scope=org/subtree` 账号可读其他组织。
- 改动：在 `server/lib/sales-order.js` 增加一处组织范围谓词（销售订单经 `store_id→stores.org_id` 或 `warehouse_id→warehouses.org_id`，发货单/退货单经订单），所有读路由与统计用同一谓词；详情越权 404；写路由（创建/发货/取消）校验目标组织在范围内。更新 `check-route-authz` 的 sales 组登记。
- 文件：`server/routes/sales.js`、`server/lib/sales-order.js`、`server/lib/returns.js`（只读取谓词）、`tests/sales-scope.test.mjs`。
- 验收：org A 用户看不到 B 的订单/发货/退货，统计只含 A；经销商/门店绑定行为不变；legacy `test-flows`、`test-guards` 相关段绿。

## X3 订货中心组织范围（ADR-0027）

- 现状：`server/routes/order-center.js` 16 条路由总览/客户树对内部账号返回全局数据。
- 改动：客户（经销商/门店）归属组织作为范围键；总览、客户树、订单列表、授信、对账单统一走 `server/lib/order-center.js` 的一处范围谓词；外部主体（经销商/门店）保持只看自己。更新 `check-route-authz` 的 order-center 组登记。
- 文件：`server/routes/order-center.js`、`server/lib/order-center.js`、`server/lib/oc-credit.js`（只读）、`tests/order-center-scope.test.mjs`。
- 验收：同 X2；legacy `test-oc.mjs food` 绿。

## X4 杂项授权缺口（ADR-0028）

- `docflow.js POST /no-issue`：要求该单据类型的创建权限（从 `doc_types` 映射到权限码，缺映射则拒绝），干跑除外。
- `auth.js GET /orgs`：admin/super 全量；其他账号按 `resolveOrgScope` 裁剪。
- `qimen.js POST /`：缺 `app_key` 或签名直接 401，不再放行（生产仍 503）。
- `purchase-chain.js POST /payments`、`POST /settlements`：自动分配与来源选择按调用者组织范围（复用 `purchaseScopeSql`）。
- 更新 `check-route-authz` 对应登记。文件：上述 4 个路由文件 + `server/lib/purchase.js`（仅 `buildSettlement`/payment 自动分配处）+ `tests/authz-misc.test.mjs`。

## X5 MCP 文档读工具权限点（ADR-0011 补充）

- 现状：`doc.query`/`doc.get`/`doc.list_types` 无按单据类型的查看权限，只按范围。
- 改动：在 `server/mcp/catalog.js`/`tools.js` 为每个单据类型声明查看权限码（复用 HTTP 侧同类型列表路由的 `requirePerm` 码，建立单一映射表），`doc.query`/`doc.get` 按类型校验所有者当前权限，`doc.list_types` 只返回有权限的类型；无映射的类型默认拒绝并在 `check-mcp-coverage` 中报出。
- 文件：`server/mcp/catalog.js`、`server/mcp/tools.js`、`scripts/check-mcp-coverage.mjs`、`tests/mcp-doc-perms.test.mjs`、矩阵测试更新。
- 验收：矩阵"权限移除"状态下这 3 个工具不再是 `NO_PERM_POINT`；legacy `test-mcp*.mjs` 绿。

## X6 托管 CI 浏览器场景（Linux）

- 现状：`tests/browser/*.mjs` 要求 Linux + `GML_PLAYWRIGHT_MODULE`，从未在 CI 跑过。
- 改动：`ci.yml` 新增 `browser` job（ubuntu-latest，`needs: checks`）：`npm ci`、安装 playwright chromium（devDependency 加入锁文件，版本固定；或用 `npx playwright@<ver> install chromium` 并记录），构建前端，启动 test 模式服务，运行现有 4 个场景 + 新增 2 个：资金复核（发起人确认→待复核→另一人批准→授信效果面板出现）、范围提示（无组织账号看到空范围提示、外部角色 403 提示）。只上传白名单摘要与失败截图（脱敏文件名）。
- 文件：`.github/workflows/ci.yml`、`package.json`/`package-lock.json`、`tests/browser/funds-review.mjs`、`tests/browser/scope-notice.mjs`、`docs/implementation/ci.md`。
- 验收：本机无法跑 Linux 浏览器，静态校验 + 用 `node --check`；CI 实际结果由托管 runner 给出。

## X7 登录节流语义修订（ADR-0005 修订）

- 现状：成功登录也计入账号桶，10 次/5 分钟即锁，正常多设备使用会误伤。
- 改动：账号桶只计失败，成功即清零该账号桶；IP 桶继续计全部尝试（抗洪泛）；失败阈值与窗口保持；回归台的 `LEGACY_LOGIN_ENV` 保留。更新 ADR-0005 与测试 A08/A09。
- 文件：`server/lib/login-throttle.js`、`server/routes/auth.js`、`tests/login-throttle.test.mjs`、`tests/auth-session.test.mjs`。
- 验收：10 次成功登录不锁；10 次失败锁；成功后失败计数清零；IP 洪泛仍限。

## X8 运维健康与告警（ADR-0029）

- 改动：`GET /api/meta/health` 增加 `ops` 块：最近备份时间/结果/加密标志（读备份目录最新 `backup-report-*.json`，路径由 `backup-dir.js` 解析）、迁移校验和状态、节流存储可用性、磁盘可用空间；`scripts/db-backup.mjs` 失败时通过通知渠道（ADR-0008 的出站策略）发送告警（可选 `GML_ALERT_CHANNEL`），成功静默；`/api/meta/metrics` 加 counters。健康端点对匿名只返回 `status`，详情需 admin。
- 文件：`server/routes/meta.js`、`server/lib/metrics.js`、`server/lib/ops-status.js`（新）、`scripts/db-backup.mjs`（仅告警钩子）、`tests/ops-health.test.mjs`。

## X9 数据保留与个人信息处理（ADR-0030）

- 改动：`scripts/retention.mjs`：按设置 `retention_audit_days`/`retention_notify_log_days`/`retention_mcp_log_days`（默认 365/90/90，危险键）清理过期审计/通知/MCP 日志，默认 `--dry-run`，执行时在同事务写一条审计摘要；`scripts/privacy-export.mjs <phone>` 导出商城客户及其订单/地址为 JSON，`scripts/privacy-erase.mjs <phone>` 按规则脱敏（保留财务必需字段，手机号/地址/姓名置为哈希），需 `--confirm` 与 admin 账号审计。
- 文件：上述脚本、`server/lib/settings.js`（3 键，更新 setting-audit 的危险键集合 14→17）、`tests/retention.test.mjs`、`tests/privacy-tools.test.mjs`、运维手册段落。

## X10 索引审计与查询优化（迁移 059）

- 改动：对 W11 基线脚本的 10 条接口及采购/库存/应收主查询跑 `EXPLAIN QUERY PLAN`，列出全表扫描；迁移 059 补缺失索引（含外键列、状态+日期组合）；`scripts/explain-audit.mjs` 把计划写入 JSON 并在出现 `SCAN` 于指定表时报红（allowlist 小表）；用 `bench-api.mjs` 记录前后 p95。
- 文件：`server/db/migrations/059_indexes.cjs`、`scripts/explain-audit.mjs`、`docs/implementation/capacity-baseline.md`（追加前后对比）、`tests/explain-audit.test.mjs`。
- 验收：`verify-seed`、`verify-migrations`、焦点测试绿；p95 不变差。

## X11 用户管理页组织与数据范围（前端）

- 现状：W10 发现 Users 页没有 `org_id`/`data_scope` 编辑入口，运维只能调 API。
- 改动：`src/pages/system/Users.tsx` 增加组织选择（`/api/auth/org-tree`）与数据范围下拉（all/subtree/org/dealer/store/none，说明文案），与 `PUT /api/auth/users/:id` 契约一致（`tests/user-form-contract.test.mjs` 扩展）；修改这两个字段触发会话撤销的提示（ADR-0004）。
- 文件：`src/pages/system/Users.tsx`、`src/api/*`、`tests/user-form-contract.test.mjs`、`tests/browser/user-editor.mjs`（扩展，供 X6 跑）。

## X12 上游复用来源锁定（docs/legal）

- 现状：`reusable/` 声明参考 Medusa/Medici/node-casbin，但未锁定上游版本与许可副本。
- 改动：用 `gh api` 取三处上游在 2026-10-15 之前最近 tag 的 LICENSE 原文与 commit SHA，存入 `docs/legal/upstream/<project>/{LICENSE,SOURCE.json}`；逐文件比对 `reusable/*` 与上游对应文件的相似度（简单 token 重合率脚本 `scripts/upstream-similarity.mjs`），把结论写入 `docs/legal/PROVENANCE.md`（"参考设计"还是"复制改写"，按文件说明）；`THIRD_PARTY_NOTICES.md` 手写头部补上游声明引用。不作法律结论。
- 文件：上述；`tests/upstream-provenance.test.mjs`（SOURCE.json 字段完整、LICENSE 非空）。

---

## 分配

| 工作流 | 分支 | ADR | 迁移 |
|---|---|---|---|
| X1 | feat/x1-pos-authz | 0025 | 058 |
| X2 | feat/x2-sales-scope | 0026 | — |
| X3 | feat/x3-order-center-scope | 0027 | — |
| X4 | feat/x4-authz-misc | 0028 | — |
| X5 | feat/x5-mcp-doc-perms | 0011 补充 | — |
| X6 | feat/x6-browser-ci | — | — |
| X7 | feat/x7-login-throttle-semantics | 0005 修订 | — |
| X8 | feat/x8-ops-health | 0029 | — |
| X9 | feat/x9-retention-privacy | 0030 | — |
| X10 | feat/x10-index-audit | — | 059 |
| X11 | feat/x11-users-org-scope-ui | — | — |
| X12 | feat/x12-upstream-provenance | — | — |

冲突提示：X1–X4 都会编辑 `scripts/check-route-authz.mjs` 的 allowlist（各自删除自己收口的组），集成者合并时按组取舍即可；X2/X3 不要互相改对方的 lib；X4 对 `server/lib/purchase.js` 只改自动分配与来源选择两处。
