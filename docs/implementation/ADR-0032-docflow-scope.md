# ADR-0032：单据流读接口按账号数据范围过滤

日期：2026-10-23。关联路线图 v4 的 Y2；承接 ADR-0017/0020（采购）、ADR-0025（POS 门店）、ADR-0026（销售）、ADR-0027（订货中心）、ADR-0028（`DOC_CREATE_PERMS`）。

## 问题

`/api/docflow` 的 `GET /events`、`/overview`、`/history/:docType/:id`、`/trace` 只有 `requireAuth + requireInternal`：任何内部账号（包括 `data_scope=org` 的分公司销售 / 仓管）都能读到**全库**的流转留痕，包含其他组织的采购、销售、订货中心（OC / OCS）、POS 班次与财务单据的单号、操作人、状态变化和 `payload_json`；`/overview` 的事件总数、最近 12 条、各单据类型的状态分布也是全库口径；`/trace` 还会按 `payload_json LIKE '%单号%'` 把"提到该单号"的别组织事件一并带出。这与前面各领域已经收口的列表 / 详情形成旁路。

## 决定

### 一、单一分发表 `DOC_SCOPE_RESOLVERS`（`server/lib/docflow.js`，紧邻 `DOC_CREATE_PERMS`）

`doc_events` 行只有 `(doc_type, doc_id)`，没有统一的组织归属，所以"这条事件能不能给这个账号看"回到**它指向的单据**，用该单据领域已有的范围谓词判定。分发表按 `doc_types.code` 一行一项，冻结导出；Y12（审批实例范围）直接复用。

| 构建器 | 类型 | 判据 |
|---|---|---|
| `purchase` | PRQ PI PST PAY（`org`）；PO GR PRT INS（`wh`） | `purchaseScopeSql`（ADR-0017/0020），原样复用 |
| `sales` | QT SO（`order`）、DL（`delivery`）、SR（`return`） | `salesScopeSql`（ADR-0026）；报价与订单同形（仓 / 门店归属） |
| `order-center` | OC OCS | `ocScope(…, 't.customer_id')`（ADR-0027），客户归属组织，下游继承上级 |
| `store` | PS PSF RC YQ SH | `stores.org_id` 在范围内；账号绑了 `store_id`（内部自定义角色）则只限该门店（ADR-0025 的门店绑定） |
| `dealer` | DR DS RB | `dealers.org_id` 在范围内 |
| `warehouse` | TF（任一端仓，`from_warehouse_id` / `to_warehouse_id`）CK AS MO MR WW WM WR QCI DH | `warehouses.org_id` 在范围内 |
| `org` | SI QCR | 自身 `org_id` 在范围内 |
| `global` | AR RCP VOUCHER RFD CA OM | 无组织归属（总账 / 应收 / 收款 / 退款 / 成本调整 / 电商）：**仅全局范围**（admin 或 `data_scope=all`）可见 |

约定：归属列为 NULL 的单据对受限范围不可见；空 / `none` / `dealer`（非经销商账号）范围一律失败关闭；构建器未登记 ⇒ 不可见。`purchase` / `sales` / `order-center` 三个构建器由各自领域库在模块求值期登记到无依赖的 `server/lib/doc-scope-registry.js`（这三个库都反向 import `docflow.js`，`docflow.js` 若直接 import 它们会撞 `EFFECT_OWNERS` 暂时性死区；实测过）。`routes/docflow.js` 显式 import 这三个库保证已登记。通用构建器（`org` / `warehouse` / `store` / `dealer`）在 `docflow.js` 内，它们的判据在此之前没有别处的定义。

### 二、未登记类型

`doc_types` 里有而分发表里没有的类型：对受限范围**不可见**，全局范围可见（工程缺口不挡管理员）。`unmappedScopeDocTypes(db)` 列出缺项，`tests/docflow-scope.test.mjs` 的守卫用例要求它为空、没有陈旧项、表名与 `doc_types.table_name` 一致、每个归属列真实存在、领域构建器已登记；新增单据类型忘了登记会在那里红（与 `DOC_CREATE_PERMS` 同一套机制）。没有 `doc_types` 行的 `doc_type`（如残留事件）同样只有全局范围可见。

### 三、四个读接口

- 路由链加 `attachOrgScope`（缺 `req.orgScope` 按"无范围"失败关闭）。
- `/events`：`docEventScope(ctx, 'doc_events')` 生成"每个可见类型一段 `(doc_type=? AND doc_id IN (SELECT t.id FROM 主表 t WHERE 谓词))` 的并集"，与 `doc_type` / `source` / `action` 过滤取交集；`total` 与分页同一谓词。`doc_id` 为 NULL 或指向已不存在单据的事件对受限范围不可见。
- `/overview`：`events` 计数、`recent`、`distribution`（每类单据的状态分布，在主表上套同一谓词；全局类型整类不出现）都只统计范围内；`docTypes` / `states` / `actions` / `flows` / `noRules` 是静态定义计数，不含单据数据，不过滤。
- `/history/:docType/:id`：先解析类型（未注册 404），再核对该单据在范围内（`docInScope`）；范围外、NULL 归属、不存在**同形 404**（同一句话，不泄漏存在性）。全局范围行为不变。
- `/trace?doc_no=`：命中单号的事件与 `payload_json` 关联事件**都**过同一范围谓词；受限账号用别组织单号得到空列表，与"无此单号"同形。（联查按单号检索，没有"详情"可 404，沿用空列表语义。）

`/actions`、`/transition`、`/no-issue` 不在本条范围（ADR-0028 及此前已处理）。

## 守卫登记

四条路由链上本来就有 `requireInternal`（强闸门），守卫分类仍是 GATED，所以 `scripts/check-route-authz.mjs` 的登记表**无需改动**（增加 handler-scope 登记反而会被"过期登记"检查报红）。范围正确性由 `tests/docflow-scope.test.mjs` 守。

## 已知边界

- `global` 类型对受限账号整类不可见，其中 AR / RCP / VOUCHER / RFD 的财务用户若只有分公司范围也看不到这些单据的留痕；需要时应先给这些单据加组织归属，再把构建器从 `global` 改为 `org`。
- `warehouse` 构建器对调拨取"任一端仓在范围内"；与采购 / 销售的"仓归属"同一口径，不是"两端都在"。
- 外部主体（dealer / store 角色）仍由 `requireInternal` 在路由层 403，订货中心 `self` 分支对这四个读接口不可达。
- 事件自身的 `org_id` 列不参与判定（它是操作者所属组织，不是单据归属）。
- MCP 侧 `server/mcp/tools.js` 的单据流转史读取（`doc_events WHERE doc_type=? AND doc_id=?`）不在本条；其范围门禁见 Y6。

## 验证

`tests/docflow-scope.test.mjs`：守卫（缺项 / 陈旧项 / 表名 / 归属列 / 构建器登记）；夹具里 A / B / 门店组织、NULL 归属、全局类型、未登记类型、孤儿事件、`doc_id=NULL`、payload 交叉引用；admin / `data_scope=all` 全见，org-A / org-B / 门店组织 / 绑店账号 / 子树 / 无组织账号的 `/events` 精确集合；过滤叠加不放宽；`/overview` 的 events 与 distribution 对照测试自己的 JOIN 期望；`/history` 越权与不存在同形 404；`/trace` 不能经 payload 读到范围外事件；dealer / store 角色仍 403。
