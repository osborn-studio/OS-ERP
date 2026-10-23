# ADR-0027：订货中心按客户归属组织收口

日期：2026-10-23。收口 ADR-0021 登记的缺口：`server/routes/order-center.js` 的总览、客户列表 / 客户树、订货单列表、授信、对账单对内部账号返回全局数据，`data_scope=org/subtree` 的内部账号能读到他组织的客户、订单、额度与对账单。状态：开发实现，尚非产品上线验收。

## 归属键

`oc_customers.org_id`（迁移 010 注释：「客户自身组织（门店 / 经销商组织）」），由 `stores.org_id` / `dealers.org_id` 在建客户时带入。下游客户（`source_type='downstream'`，`org_id` 为 NULL）**继承上级客户**（`parent_customer_id`）的 `org_id`，只向上取一级。

订货单 / 对账单 / 授信流水没有自己的归属，一律跟着 `customer_id`。**不用** `oc_orders.org_id`：它写的是 `owner_org_id`（货主 / 供货方，门店取总部、经销商为 NULL），拿它收口会让总部组织的受限账号看到全部门店订单，也会让 NULL 的经销商订单对所有人可见（旧 `scopeCond` 的 `OR o.org_id IS NULL` 正是这个形状）。

## 唯一判据

`lib/order-center.js` 的 `ocScope(db, req, column)` 返回一段 SQL 谓词 + 参数，总览、客户列表、客户树、客户详情（children）、订货单列表、对账单列表、`ocAccessCheck`（单据 / 客户详情 / 流转 / 授信）全部调它：

- 外部主体（dealer / store）→ `column = 自己的客户 id`（自视图口径不变，别人的 id 仍是 403）。
- `all`（admin、`data_scope=all`）→ `1=1`；NULL 归属的客户只有它能看到。
- `org` / `subtree` → 客户归属组织 ∈ `orgIds`（`resolveOrgScope` 已展开子树）；NULL 归属不可见。
- `none` / 非经销商账号带 `dealer` 范围 / 空 `orgIds` / 缺 `req.orgScope` → `1=0`，失败关闭：**200 + 空 / 零**，不是 403，也不是全库。

`overview(db, { scopeFor })` 的每一块（订单计数与金额、客户数、阻断客户、授信风险榜、待审批）按同一个集合算；`customerIds` 参数保留给脚本与旧调用。`customerTree(db, root, { scope })` 只含范围内节点，上级不在范围内的节点自成一根（不借上级泄漏名字）；列表的 `parent_name` 同理。

## 范围外 = 不存在

内部账号对范围外客户 / 订单 / 对账单的详情、授信、目录、试算、写动作（流转、确认、作废、准入、改条件、以其为 `customer_id` 的下单 / 建对账单）统一 **404**，措辞与真实不存在一致（`订货主体 #n 不存在` 等），且发生在任何写之前。`r.param` 与路由器层 `customer_id` 预检共用 `ocAccessCheck`；docflow 通用流转入口经 `claimTransitionEffect` 登记的 `canAccess` 也走同一函数。

## 对 ADR-0021 登记的更新

`check-route-authz` 中 `order-center.js` 的整组由 `handler-scope` + `pending=unassigned` 改为无 pending（仍是 `handler-scope`：路由器层 requireAuth，范围在处理器与 lib 内落实；外部角色是本模块的正常用户，故不要求 perm 码）。pending 总数 49 → 33（本组 16 条）。

## 边界与已知后续

- 供货侧履约（受理 / 分仓 / 发货）的内部账号现在需要其数据范围覆盖客户的归属组织（或 `all`）；旧口径用的是货主列（多为 NULL ⇒ 人人可操作）。总部职能岗应使用 `subtree` 于总部节点或 `all`。
- `GET /policies`（审批规则 / 可见性规则）与 `GET /flow` 是全局配置，不含客户数据，沿用原门，不按组织过滤。
- 权限码门（如把订货中心读接口要求内部账号持 `order.*` 权限）不在本 ADR；写路由原有 `requirePerm` 不变。
- docflow 通用列表若暴露 `OC` / `OCS` 单据，其范围另批。
- 归属 NULL 的客户在演示种子里只有下游客户（会继承上级）；真实数据应补齐门店 / 经销商 `org_id`，否则受限账号看不到它们。

## 验证入口

`node --test tests/order-center-scope.test.mjs`：org / subtree / 下游继承 / NULL 归属 / 无组织 / 全局 / 范围外 404 且零写 / 经销商与门店自视图不变。Mac mini Node 22 本地验证，不等于目标平台验收。
