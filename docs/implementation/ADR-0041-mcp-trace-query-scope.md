# ADR-0041：MCP `order.trace_document` 与 `doc.query` 按单据解析器表判归属

日期：2026-10-23。收口 ADR-0039「边界」留下的两项（Z2 审计）。状态：开发实现，尚非产品上线验收。

## 问题

ADR-0039 把 `doc.get` 改成 `docInScope`（`DOC_SCOPE_RESOLVERS`，ADR-0032）后，同一文件里还有两个读工具沿用「按表上有无 `org_id / store_id / dealer_id / warehouse_id` 列推断归属」的旧口径：

- `order.trace_document`：对 PO / SO / TF / MO / WW 五张表按固定归属列做 `entityRowVisible`，SO 上 `dealer_id` 命中即可见——「经销商属本组织、出货仓属他组织」的销售订单会连同其库存流水一起返回，而 HTTP 的 `salesScopeSql` 判不可见。
- `doc.query`：先 `LIMIT n×3` 取回，再按列推断逐行过滤；既有同样的 dealer 放大，也让「前 3n 行都越界」时返回条数不足（limit 不准）。

## 决定

- **判据唯一化**：两个工具的归属都走 `docflow.docScopeOf / docInScope`（即 `/api/docflow/history`、`doc.get` 用的同一份解析器表）。入参由新的 `docScopeCtx(db, ctx)` 组装：`orgScope = ctx.scope`（令牌范围 ∩ 所有者当前范围，ADR-0011 `effectiveScope`），`user` = 令牌所有者行（`store` 型解析器需要 `store_id`；无主令牌为 null）。
- **`doc.query`**：解析器给出的谓词（写在别名 `t` 上）直接 AND 进 SQL，`ORDER BY t.id DESC LIMIT ?` 里的 `?` 就是 `limit`，不再多取再滤。全局范围不加谓词；类型对该范围完全不可见（全局类 AR / RCP / VOUCHER / RFD / CA / OM、未登记类型、空 / `dealer` / `none` 范围）⇒ `1=0`，返回空列表。Y6 的门店 / 经销商 / 订货主体绑定（`bindingWhere`）与类型级查看权限（`assertCanViewDocType`）原样叠加。响应的 `total_scanned` 现等于返回行数（不再有被丢弃的越界行）。
- **`order.trace_document`**：按单号探测**全部**已登记单据类型（`doc_types`，含停用；Codex 审计 P1：只探测 PO / SO / TF / MO / WW 时，其他类型如门店发货单 SH 的越界单据会经货主在所有者组织的库存流水泄露），逐张叠加三道判据——类型级查看权限（`canViewDocType`，含外部主体拦截与绑定）、`docInScope`、`rowInBinding`——任一不过即不计入命中。**单据存在但无一张可见时，连同其库存流水一并返回 `NOT_FOUND`**（与不存在同形；否则货主在所有者组织的流水会泄露越界单据的存在）。单号跨表不唯一、流水只记单号，所以同号单据里只要有一张不可见（被范围 / 类型权限 / 绑定挡掉），就**不返回任何库存流水**，只返回可见单据本身（Codex 复审 P1 两项：停用类型绕过探测、同号可见单据解锁他单流水，均已修并有回归用例）。仅有库存流水、没有任何同号单据（盘点 / 手工调整类流水）的行为不变，流水仍按货主组织过滤。
- 工具本身的 `perms`（三选一）不变；改变的是：持有 `purchase.order.view` 但没有 `sales.order.view` 的所有者，trace 不再能看到销售订单（当作不存在）。

## 契约变化

MCP 行为收紧，无 HTTP / OpenAPI 变化：
- `doc.query SO`（及 QT / DL / SR 等销售类型）此前凭 `dealer_id` 推断可见的他组织单据现在不出现；全局类型对受限范围由「按列推断」变为空列表。
- `order.trace_document` 对越界单据由 200（含单据与流水）变为 404 `NOT_FOUND`。
- 全局数据范围 / 无主全局令牌行为不变。

## 守卫与矩阵

- `tests/mcp-doc-perms.test.mjs` 新增 AA1 用例：dealer 推断的越界 SO、9 条更新的越界噪声单据下 `limit=2` 仍返回 2 条范围内单据；全局类型 VOUCHER 对受限范围为空、对无主全局令牌不空；`order.trace_document` 越界单据（即使有所有者组织货主的流水）与不存在响应同形；缺 `sales.order.view` 时 trace 当作不存在。新用例在旧实现下 4 项红；另加门店发货单 SH 经库存流水泄露的回归用例（审计 P1，上一版实现下为红）（已用旧 `tools.js` 复核）。
- `tests/mcp-tool-matrix.test.mjs` 新增「状态 6（AA1）」：两工具 × {范围外 SO、范围内 SO、缺类型级查看权限、全局类型}，写入 `trace_query_scope_state`，断言无 `LEAK` 且零写；原三态、Y6 绑定态、Z2 历史态不变（两工具仍在原三态矩阵里逐一覆盖）。该态在旧实现下为红。
- `scripts/check-mcp-coverage.mjs` 的「归属列推断一致」断言仍成立（`doc.get` 以外的工具仍有使用推断的路径，见边界）。

## 边界（诚实写明）

- 本 ADR 只动这两个工具。`entityRowVisible / ownershipColumnsOf` 仍被其他 MCP 工具使用（库存、销售汇总等；库存类见 AA2、低库存见 AA5）。
- `order.trace_document` 的库存流水仍按 `owner_org_id`（货主）过滤，而不是按流水所属仓的组织；流水不是单据，两者口径不同是现有设计。
- 解析器表对每次 `doc.query` 增加一个 `IN (子查询)` 谓词；大库下未做 EXPLAIN 评估（未纳入 `explain-audit` 语句表）。
- MCP 在生产被 `agent_access` 门禁 503；Mac mini Node 22 本地验证，不等于目标平台验收。

## 验证入口

`node --test --test-concurrency=1 tests/mcp-doc-perms.test.mjs tests/mcp-tool-matrix.test.mjs`；同时 `tests/oms-scope.test.mjs`、`tests/docflow-scope.test.mjs`、`tests/quote-scope.test.mjs` 保持绿；传统脚本 `check-mcp-coverage.mjs cosmetic`、`test-mcp.mjs`、`test-mcp-validation.mjs`。
