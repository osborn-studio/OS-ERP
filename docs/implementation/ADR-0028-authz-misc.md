# ADR-0028：杂项授权缺口收口（no-issue / orgs / qimen / 付款与结算范围）

日期：2026-10-23。收口 ADR-0021（路由授权守卫）登记在册、仍是真实缺口的四处。状态：开发实现，尚非产品上线验收。

## 决定

1. **`POST /api/docflow/no-issue`**（真实取号会消耗序号）：非干跑要求调用者持有该单据类型的**创建权限**。映射表是 `server/lib/docflow.js` 的 `DOC_CREATE_PERMS`（唯一出处，`createPermOf(code)` 取值）。类型没有映射（含未注册类型、原型链键）⇒ `403 DOC_TYPE_PERM_UNMAPPED`，**管理员同样**：映射缺项是工程缺口，不是权限问题。缺权限 ⇒ `403 DOC_CREATE_PERM_DENIED`（`detail.permCode` 给出所需权限点）。权限判定在取号之前，被拒绝的调用不消耗序号。`dry` 只读预览不消耗序号，保持豁免。顺带修正：规则命中时原实现为了回填 `byRule` 又调用一次 `nextDocNoByRule`，每次取号会多烧一个序号；现在只取一次。
2. **`GET /api/auth/orgs`**：admin / 全局范围全量；其余账号按 `resolveOrgScope` 裁剪（本组织 / 子树；经销商另含挂靠组织；空范围 ⇒ 空列表）。与 `/org-tree` 不同，平铺档案**不补祖先**——补祖先等于交出范围外上级组织的档案。仓库内没有前端调用方。
3. **`POST /api/qimen`**：`app_key` 与 `sign` 必填。缺 `app_key`、未知或停用平台、缺签名、错签名一律 **401**（协议体仍是 `{success:false, code, message}`，码 `1003` / `1004`），鉴权先于 `method` 校验；签名比较用 `timingSafeEqual`；`app_key` 必须是字符串（对象载荷不进 SQL 绑定）。方法未知等协议内错误仍为 HTTP 200。生产运行时本网关仍由 capabilities 关闭（503）。
4. **`POST /api/purchase/payments`、`POST /api/purchase/settlements`**（`purchase-chain.js`，原已有 `requirePerm`）：加 `attachOrgScope`，并把范围下沉到 `lib/purchase.js`：
   - `planAllocation(db, supplierId, amount, { orgScope })`：受限范围只在范围内的结算单（自身 `org_id`）上做 FIFO；
   - `createPayment({ orgScope })`：自动核销走上面的范围化 FIFO；**手工核销**指向范围外结算单 ⇒ `404 DOC_NOT_FOUND`（与不存在同形，写入前拒绝，沿用 ADR-0020 `assertPurchaseDocInScope`）；
   - `buildSettlement({ orgScope })`：来源选择只取范围内的入库（经仓归属）、发票（自身 `org_id`）与退货抵减（经仓归属）；空范围 ⇒ 谓词恒假 ⇒ `409 PST_NOTHING`，不会变成全库。
   不传 `orgScope`（脚本、种子、MCP 调用）= 不限，行为不变。判据一律复用 `purchaseScopeSql`，不另抄条件。

## 单据类型 → 创建权限（`DOC_CREATE_PERMS`）

| 域 | 映射 |
| --- | --- |
| 采购 | PO `purchase.order.edit`；GR `purchase.inbound`；PRT `purchase.return`；PRQ `purchase.req.edit`；PI `purchase.invoice.edit`；PST `purchase.settle.edit`；PAY `purchase.payment.edit`；INS `quality.inspect.edit` |
| 销售 | QT `sales.quote.edit`；SO `sales.order.edit`；DL `sales.outbound`；SR `sales.return`；SI `sales.invoice.edit` |
| 质检 | QCR `quality.request.create`；QCI `quality.inspect`；DH `quality.handle.approve` |
| 库存 / 成本 | TF `inventory.transfer`；CK `inventory.check`；AS `inventory.adjust`；CA `cost.adjust` |
| 财务 | AR、RCP `finance.receipt.edit`；VOUCHER `finance.voucher.gen`；RFD `finance.refund.edit` |
| 门店 / POS | YQ、SH `pos.store.requisition`；PS `pos.cashier`；PSF `pos.shift`；RC `pos.dailyclose` |
| 生产 / 委外 | MO、WW `produce.order.edit`；WM、MR `produce.issue`；WR `produce.receipt` |
| 电商 / 经销商 / 订货中心 | OM `oms.order.route`；DR、OC `order.place`；DS、RB `finance.settle.edit`；OCS `order.statement.view` |

取值口径：与该类型 HTTP 创建路由挂的权限码一致；创建路由用角色闸门（`requireRole`）的类型（PO、PRT、SO、DL、SR、TF、CK、AS、OM、DR、DS、RB 等）取同域的编辑 / 状态机首条出边权限码。这是权限点口径，不改变那些路由自己的角色闸门。映射表与 `doc_types`、`permissions` 的一致性由 `tests/authz-misc.test.mjs` 守：新增 doc_types 缺映射、映射指向不存在的权限码、映射里有过期类型，测试都会变红。

## 契约变化

- `POST /api/docflow/no-issue`：新增 403（`DOC_TYPE_PERM_UNMAPPED` / `DOC_CREATE_PERM_DENIED`）。外部主体与无创建权限的角色由 200 变 403；管理员取未映射类型由原来的取号或 500 变 403。
- `GET /api/auth/orgs`：非全局范围账号结果变少（含外部角色）。
- `POST /api/qimen`：缺 / 错 `app_key`、缺 / 错签名由 HTTP 200（或放行）变 **401**。后台调试页 `src/pages/oms/Qimen.tsx` 改为不带后台令牌直发 `fetch` 并新增 `sign` 输入框：网关的 401 是协议鉴权失败，经 `api` 客户端发出会被当作后台会话失效而登出当前账号。`tests/capabilities.test.mjs` 对 `POST /api/qimen {}` 的期望由 200 改为 401（仍断言不是 `FEATURE_DISABLED`）。
- `POST /payments`、`/settlements`：受限账号的自动核销 / 来源选择变少；手工核销到范围外结算单新增 404。
- OpenAPI：`/docflow/no-issue` 的 summary 写明创建权限与 DOC_TYPE_PERM_UNMAPPED 并声明 403，版本号不动（避免与同批其他工作流的契约版本冲突），`gen:api` 重新生成后 `src/types/api-routes.ts` 内容无变化。

## 边界

- MCP 工具 `purchase.settlement.build` / `purchase.payment.create`（`server/mcp/tools.js`）仍不传 `orgScope`，按供应商全量；它们受 MCP 工具矩阵与所有者权限约束，范围化另批处理。
- 其余 `purchase-chain.js` 动作路由（`/:id/:action`）的单据级组织范围判定仍未做，登记在 `check-route-authz` 的 handler-scope 例外里（`unassigned`）。
- 奇门签名密钥仍是演示常量 `GML-DEMO-SECRET`；真实对接需按平台配置独立密钥，不在本批。

## 验证入口

`node --test tests/authz-misc.test.mjs`：映射表总量 / 权限码存在性；`no-issue` 的外部主体与缺权限 403、被拒不烧序号、一次取号只烧一个序号、干跑豁免、未映射 / 未注册类型 403（含 admin）；`/orgs` 在 admin / 本组织 / 子树 / 全局 / 无组织 / 经销商下的精确集合；qimen 九种坏输入 401、正确签名 200、停用平台 401；付款自动核销、手工越权核销、结算来源按 A / B / NULL 三种归属精确对账。`node scripts/check-route-authz.mjs`：`/no-issue`、`/orgs` 由 gap 改为 handler-scope，qimen 不再带 `unassigned`。Mac mini Node 22 本地验证，不等于目标平台验收。
