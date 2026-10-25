# ADR-0057：指标按业务查看权限过滤，受限范围默认隐藏无范围语义的指标（AE1）

日期：2026-10-24。收口 ADR-0053（AD1）Codex 审计留下的两条 open 高项（roadmap-v10 AE1）。状态：开发实现，尚非产品上线验收。

## 问题

- `/api/metrics`、`/values`、`/catalog` 只要求 `system:metrics:view`，没有逐指标要求对应的业务查看权限：持有该权限但没有采购 / 销售 / 库存成本查看权限的角色仍能取到采购金额、库存成本等数值。
- 没有组织范围语义的指标（销售、线上 OMS、应付、订货中心、POS、经销商信用、审批）对受限范围角色返回**全局数字**，AD1 只标注 `scoped:false`，不是 fail-closed。

## 决定

- **每条指标登记 `perms`**（`server/lib/metrics.js`，该指标揭示的业务查看权限，**任一命中**即可）。25 条全覆盖，测试逐条校验非空且都是库里已有的权限点：销售类 `sales.order.view`（`unpaid` 另可 `finance.receivable.view`）；线上 `oms.order.view`；库存 `inventory.stock.view`，库存金额 `inventory.cost.view`；采购订单类复用 `PO_READ_PERMS`（与采购订单读路由、dealer summary 同一常量）；应付 `finance.payable.view` / `purchase.settle.view` / `purchase.payment.view`；订货中心 `order.view`；POS `pos.view`；经销商信用 `credit.view`；审批 `approval.instance.view` / `system:approval:view` / `system:approval:manage`。`perms` 不进 `metricDefinitions()`，因此 `metric_defs` 指纹与定义视图不变。
- **三个端点按可见集合过滤**：缺权限的指标**缺席**（不是 403），`system:metrics:view` 仍是到达端点的前置条件。`/values` 里被隐藏的 key 既不在 `values`/`scoped`，也不进 `unknown`（`unknown` 只表示字典里没有）。响应新增 `hidden_count`（被隐藏的条数；`/values` 带 `keys` 时只统计所请求的已知 key）；`/` 的 `total` 与 `modules` 随可见集合收缩。可见性判据只有一份：`metricVisibility()`，路由用 `permContext`/`hasPerm`（超管 / admin 恒真）构造 `canPerm`。
- **新增危险设置键 `metrics_global_for_restricted`**（enum `hide` | `label`，默认 `hide`，`is_danger`，改动要写理由）：`hide` = 数据范围非"全部"（含 `none`、`dealer`、无组织账号）的调用者不返回 `scopeAware !== true` 的指标；`label` = AD1 行为（返回全局数字并带 `scoped:false`）。全局范围调用者不受该键影响。**绑定了门店 / 经销商（或 role=dealer|store）的账号视同受限，即使 `data_scope=all`**（Codex 审计高项，见下）；admin / 超管豁免。库里存了不合法值时 `readSetting` 回落默认 `hide`（fail-closed）；只有精确的 `label` 才放宽。
- **fail-closed 细节**：`metricValues` 的 `keys` 空数组原本等于"全部"；新增的 `allow` 集合与之取交集，**空集合得到空结果**而不是回落到全部。
- **前端**：`Metrics.tsx` 渲染接口返回的集合（指标数 / 模块数 / Tab 计数取自响应），`hidden_count > 0` 时在统计卡下显示一行说明（`hiddenMetricsNote`）。布局由 AE11 负责，本处只改数据层与该说明。

## 契约变化

- 受限范围调用者默认少收到无范围语义的指标；缺业务权限的调用者少收到对应指标。此前依赖这些数的受限账号需要管理员把设置改为 `label`（并保留其业务权限）。
- 响应新增 `hidden_count`（附加字段）；`/` 的 `total` 变为可见条数。`npm run gen:api` 产物无变化。
- `GET /api/metrics/defs`、`/stale` 只含定义，未改。

## 测试

先红后绿：`tests/metrics-perms.test.mjs`（`perms` 全覆盖且为已知权限点；撤销销售 / 采购权限后三个端点精确缺席这些指标且 `hidden_count` 一致；任一权限即可；无 `system:metrics:view` 仍 403；admin 全见；设置键登记 / 默认 / 非法值 400；默认 `hide` 下受限账号只得到按范围收窄的指标；`label` 还原 `scoped:false`；无组织账号只得到范围内指标且全为 0）。`tests/inventory-scope.test.mjs` 的 AD1 用例改为先给仓管角色补足各指标权限并切到 `label`（其断言的是 AD1 的标注行为）。`scripts/test-setting-audit.mjs` 危险键 20 → 21。MCP 工具矩阵不受影响（`report.dashboard_kpi` 未改）。

## 仍 open / 边界

- `hide` 只看 `scopeAware`；销售 / OMS / 订货等本身有组织谓词，若将来按范围收窄再逐条把 `scopeAware` 置真即可在默认模式下对受限账号放出。
- `hidden_count` 不区分隐藏原因（缺权限 / 无范围口径），避免向受限账号暴露其角色以外的权限配置细节；说明文案如实写两种可能。
- `/defs` 的指标名称与公式仍对所有持有 `system:metrics:view` 者可见（不含数值）。
- 未做浏览器验证；校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。

## Codex 审计

`codex exec -m gpt-6.1-sol --sandbox read-only`，静态审查，对象 `batch-thirteen...HEAD`。发现与处理：

- **高** 门店 / 经销商绑定账号若 `data_scope=all`，`isScopeRestricted` 判为不受限，默认 `hide` 对其不生效（例如持 `pos.view` 的门店账号拿到全公司 `pos_sales`）：**已修**。`metricVisibility` / `metricScopedFlags` 新增 `subjectBound`，路由按 `store-binding.js` 的同一判据（`boundStoreId` / `boundDealerId` / `isExternalSubject`，`storeBindingExempt` 豁免）传入；`tests/metrics-perms.test.mjs` 增"绑定账号即使 data_scope=all 也受限"用例（先红后绿）。
- 设置默认安全与前端渲染：审计未发现问题。

仍保留的边界：绑定主体账号视同受限后，按范围收窄的库存 / 采购订单类指标仍按其 `orgScope`（可能是"全部"）计算——这与改动前一致，不属于本 ADR。

## 验证入口

`node --test --test-concurrency=1 tests/metrics-perms.test.mjs && node --test --test-name-pattern=AD1 tests/inventory-scope.test.mjs`

## 补充 1：销售 / 线上 OMS / 订货中心 / POS 指标按范围计算（AF2）

日期：2026-10-24。收口上面"仍 open / 边界"第一条：这些指标本身有组织谓词，改为复用路由里的**同一份**谓词并标 `scopeAware: true`，受限账号在默认 `hide` 下得到按范围计算的值，而不是被摘掉。

### 逐指标决定

| 组 | 指标 | 谓词（单一来源） | `scopeAware` | 绑定主体（`bound`） |
|---|---|---|---|---|
| 销售 | `sales_amount` `sales_qty` `sales_order_count` `avg_order_value` `attach_rate` `unpaid` | `salesScopeSql(orgScope,'order','so')`（ADR-0026：出货仓或门店所属组织任一在范围内） | 是 | `deny` |
| 销售 | `return_rate` | 分子 `salesScopeSql(...,'return','sr')`（有来源订单经订单，无单退货用自己的仓 / 门店），分母同销售额 | 是 | `deny` |
| 线上 | `gmv` `oms_order_count` | `omsOrderScopeSql`（ADR-0039 / Y4：平台履约仓 `platforms.warehouse_id` 所属组织；无履约仓的平台对受限范围不可见） | 是 | `deny` |
| 订货中心 | `oc_order_amount` `oc_fill_rate` | `ocScope(db, {user, orgScope}, 'o.customer_id')`（ADR-0027：客户自身组织，下游继承上级；外部订货主体只算自己的客户） | 是 | `self-customer` |
| POS | `pos_sales` | 绑定门店的账号 `store_id = 本店`；其余受限账号取 `stores.org_id` 落在范围内的门店（与销售"门店方"同一判据；POS 路由本身没有组织谓词，这是为指标补的最小口径，NULL 组织对受限范围不可见） | 是 | `own-store` |
| 经销商信用 | `credit_usage` `over_credit_dealers` | — | **否（保持无范围语义）** | — |
| 应付 | `payable_open` | — | 否 | — |
| 审批 | `approval_pending` | — | 否 | — |

不接入的理由：经销商档案路由（`dealers.js`）本身没有组织谓词（经销商是客户而不是本方组织，ADR-0026），指标不另造一套；应付结算单没有可靠的组织归属列；审批实例按审批人 / 单据流转可见，不是组织维度。这三组在受限范围下仍按 `metrics_global_for_restricted` 处理（默认 `hide`，`label` 带 `scoped:false`），前端"另有 N 项指标未显示"文案已覆盖，未改前端。

### 机制

- `compute(db, p)` 的 `p` 增加 `user` 与 `subjectBound`；`metricValues` / `metricCatalog` / `metricGroups` / `metricVisibility` 透传，路由传 `req.user` 与既有 `subjectBoundOf(req)`。内部调用（看板、`orgScope` 为空）口径不变：全局恒 `1=1`。
- **全局调用者不变**：`orgScope` 为 `all` / 空且非绑定主体时谓词为 `1=1`，值与改动前逐字相同（测试对 admin 与未绑定的 `data_scope=all` 账号逐项对 SQL）。
- **空范围失败关闭**：无组织 / `none` / `dealer` / 空 `orgIds` ⇒ `1=0` ⇒ 0，绝不回落到全局数。
- **绑定主体即使 `data_scope=all` 也不拿全局数**（沿用 AE1 Codex 高项的思路）。新增指标字段 `bound` 与判据 `boundAllows(m, user)`（可见性只有这一处）：`deny` 对绑定主体不可见，compute 兜底也是空范围；`self-customer` 仅 `role=dealer|store` 的外部订货主体可见且只算自己的客户，订货主体档案缺失时 `selfCustomerId` 抛错被接成空范围；`own-store` 仅绑定了门店的账号可见且只算本店。每条 `scopeAware` 指标现在都显式声明 `bound`（测试断言无遗漏）。

### 契约变化

- 受限范围账号（持有对应业务权限）默认多收到 12 条指标，值为其范围内的数；`hidden_count` 相应减少。`scoped` 对这些指标为 `true`。
- 绑定了门店 / 经销商的账号：存货 / 采购订单类（9 条）不再可见（此前 `data_scope=all` 的绑定账号会拿到全局库存 / 采购数，标 `scoped:true`）；销售 / 线上不可见（此前在 `hide` 下也不可见，`label` 下是全局数）；`label` 下这些指标现在同样对绑定主体不可见（`bound` 在两种模式下都生效，因为全局数对绑定主体不可接受）。
- `metric_defs` 指纹与 `gen:api` 产物不变（`scopeAware` / `bound` / `perms` 不进定义视图）。

### 测试

`tests/metrics-perms.test.mjs`（先红后绿）：每组一条受限范围用例——值等于独立写出的范围 SQL 且不同于全局（销售 7 项含退货率 / 未回款，OMS 含"无履约仓平台 5000 不泄漏"，订货中心含下游继承，POS）；`hide` 下这些指标在场、应付 / 审批 / 信用仍缺席；`label` 下数值与 `hide` 相同；空范围全为 0；admin 与未绑定 `data_scope=all` 账号与全局 SQL 逐项相等；绑定门店的 `role=store` 账号只得本店 POS 与本人客户的订货数、销售 / OMS 不可见，绑了门店但不是外部主体的内部账号订货中心不可见。AE1 / AD1 里原先假设"销售 / OMS 为全局口径"的断言同步改为应付 / 审批。

### 仍 open / 边界

- 存货 / 采购订单类（AD1）对绑定主体的保留边界已在本补充内收口（见下 Codex 高项）：9 条一律 `bound: 'deny'`，compute 兜底为空范围。
- POS 的非绑定受限口径是指标侧的最小定义（门店所属组织），POS 路由本身无组织谓词；若将来 POS 读路由补组织谓词，应改为复用它。
- 未做浏览器验证；校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。

### Codex 审计（AF2）

`codex exec -m gpt-6.1-sol --sandbox read-only`，静态审查，对象为 AF2 提交。发现与处理：

- **高** 存货 / 采购订单类指标未声明 `bound`，绑定主体（`data_scope=all`）在默认 `hide` 下仍能拿到全公司库存 / 采购数并带 `scoped:true`（AE1 保留边界，AF2 之前即存在）：**已修**。9 条指标 `bound: 'deny'`，`stockSc` / `poSc` / `below_safe` 对 `subjectBound` 取空范围；测试断言所有 `scopeAware` 指标都声明 `bound`，且绑定门店账号拿不到 `stock_qty` / `stock_amount` / `purchase_amount`。副作用：门店账号不再在指标页看到库存数（此前看到的是全局数，不是本店数）；如需本店库存口径应另开一条 `own-store` 的库存指标，不在本次范围。
- **中** 订货中心指标读路径经 `ocScope → selfCustomerId → ensureCustomer`，绑定主体缺订货档案时会在 GET 里建档（active 客户 + 默认地址，且两条 INSERT 无事务）：**已修**。新增 `selfCustomerIdReadOnly`（`order-center.js`，判据与 `selfCustomerId` 同一份），指标侧只读查询，无档案 ⇒ 空范围 ⇒ 0；非绑定的受限内部账号向 `ocScope` 传空 `user`，不会走建档路径。测试断言读完后 `oc_customers` 行数不变。
- 其余：销售 / OMS / 订货中心谓词与路由一致（退货率的"有来源订单 / 无单退货"两支均覆盖），派生指标（客单价 / 连带率 / 退货率）正确透传 `p`，`keys` 过滤 / 空 `allow` / `/catalog` 无绕过，参数顺序无误，空 / `none` / `dealer` 范围失败关闭：未发现问题。
- `label` 模式下，持有业务权限的受限账号（含绑定主体）仍可取得 `payable_open` / `approval_pending` / `credit_usage` / `over_credit_dealers` 的全局数并带 `scoped:false`：这是 `label` 的既定语义（ADR-0057 原文），非回归，未改。

## 补充 2：范围声明覆盖率守卫与应付未结接入范围（AG2）

日期：2026-10-24。AF2 之后"哪些指标没有范围语义"靠约定：新指标忘了接范围既不报错也没有测试露出来。本补充把它变成常驻守卫，并对剩下的无范围指标逐个重新评估。

### 守卫

`scripts/check-metrics-scope.mjs`（CI checks job 一步 `Metrics declare their scope semantics`；登记进 `check-file-header`）：字典里每条指标必须**恰有其一**——`scopeAware: true`，或 `scopeless: '<理由，trim 后 ≥ 20 字>'`。未声明、理由过短、两者并存、`scopeAware` 不是严格的 `true`（`'yes'` / `false` 也算错）一律退出 1，并逐条打印原因；`--list` 只打印当前分类表。守卫不打开数据库。

守卫与运行时读**同一个判据**：`isScopeAware(m)`（`m.scopeAware === true`，`server/lib/metrics.js` 导出）。`metricVisibility` 的 hide 过滤与 `metricScopedFlags` 的 `scoped` 都改为调用它（原先是两处各写 `scopeAware !== true` / `=== true`），测试断言 `--list` 的分类与 `metricScopedFlags` 逐条一致。

### 逐指标分类（全部 25 条以 `--list` 为准，下表为本次变动与保留项）

| 指标 | 分类 | 说明 |
|---|---|---|
| `payable_open` | **scopeAware（新）**，`bound: 'deny'` | 结算单自带 `org_id`，采购链读接口 / 应付台账本来就用 `purchaseScopeSql(...).org`；指标复用这一份谓词（AF2 当时误判"没有可靠的组织归属列"）。NULL 组织对受限范围不可见，空范围 ⇒ 0，绑定主体失败关闭并不可见 |
| `credit_usage` | scopeless | 经销商是客户而非本方组织（ADR-0026），`dealers` 与经销商档案路由都没有组织谓词，不另造口径 |
| `over_credit_dealers` | scopeless | 与 `credit_usage` 同源 |
| `approval_pending` | scopeless | 审批可见性是"提交人 ∪ 当前审批人 ∪ 管理员全见 ∪ 单据范围"（ADR-0015），不是单一组织维度；按单据类型逐一套范围会得到与列表接口不一致的第二套口径 |
| 其余 | scopeAware | AD1 / AF2 既有，不变 |

### 契约变化

- 受限范围账号（持有 `finance.payable.view` / `purchase.settle.view` / `purchase.payment.view` 任一）默认多收到 `payable_open`，值为其组织内结算单的未结金额，`scoped: true`，`hidden_count` 相应减 1；`label` 与 `hide` 下该指标数值相同。
- 绑定了门店 / 经销商的账号：`payable_open` 不可见（此前 `data_scope=all` 的绑定账号在 `label` 下能拿到全局应付数）。
- `metric_defs` 指纹与 `gen:api` 产物不变（`scopeless` / `scopeAware` / `bound` 不进定义视图）。

### 测试

`tests/metrics-perms.test.mjs`（先红后绿）：守卫脚本退出 0；`--list` 与运行时一致；`classifyMetrics` 对未声明 / 短理由 / 并存 / 非严格 true 全部报错；`payable_open` 受限范围等于独立写出的范围 SQL（作废单、他组织、NULL 组织均不泄漏），空范围 0，绑定账号不可见。`tests/inventory-scope.test.mjs` 里关于 `payable_open` 的 `scoped:false` 断言同步改为 `true`。

### 仍 open / 边界

- 三条 scopeless 指标在受限范围下仍按 `metrics_global_for_restricted` 处理（默认隐藏；`label` 为全局数并带 `scoped:false`）。
- 守卫只管"是否声明"，不证明 `scopeAware: true` 的谓词正确；那由各指标的受限范围用例负责。
- 校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收；未做浏览器验证。

### Codex 审计（AG2）

`codex exec -m gpt-6.1-sol --sandbox read-only`，静态审查加只读 mock 校验（32 种可见性组合、12 个应付谓词 / 参数用例），对象为 AG2 提交。结论：**无高 / 中项**。谓词与结算单 / 应付台账路由同源（含 `voided` 排除、NULL 组织与空 / none / dealer 范围）；守卫、`hide` 过滤与 `scoped` 标记共用严格的 `isScopeAware`，无重复 key 或漏声明；`values` / `catalog` / 字典 / `keys` 过滤 / 空 `allow` 均无全局数绕过；绑定主体在 `label` 下也看不到 `payable_open`。其余两点是已记录的边界：守卫只验声明不验谓词；`label` 下受限账号仍可取三条 scopeless 指标的全局数（带 `scoped:false`，既定语义）。

## 补充 3：scopeless 清单逐条评估、可机读分类与 `hide` 模式的"已隐藏 N 项"（AH2）

日期：2026-10-24。AG2 之后还剩 3 条 `scopeless` 指标，理由是自由文本；`hide` 模式下它们与"缺业务权限"的指标一起笼统计入 `hidden_count`。本补充逐条评估、把理由变成可机读分类，并让页面把"折叠的全局口径指标"与"缺权限"分开说明。

### 评估结果（与路线图预期不同）

路线图预期"至少再接入 5 个"，但评估时字典 25 条里只剩 3 条 `scopeless`（其余 22 条已在 AD1 / AF2 / AG2 接入），没有 5 个可接。实际：

| 指标 | 结论 | 理由 |
|---|---|---|
| `approval_pending` | **接入范围**（`scopeAware: true`、`bound: 'deny'`） | 审批中心概览 / 列表在受限范围下用 `instanceVisibleTo`（提交人 ∪ 当前级审批人 ∪ 管理员全见 ∪ 范围内单据，ADR-0015 / 0037）。指标对 pending 实例逐条套同一个函数，不另写第二份判据；只扫 pending（概览会扫全表）。AG2 当时"按单据类型逐一套范围会得到与列表不一致的第二套口径"的顾虑，用"直接复用 `instanceVisibleTo`"消解。全局范围仍是一条 `COUNT(*)`；绑定主体一律 0 且不可见 |
| `credit_usage` / `over_credit_dealers` | 保持 `scopeless`，分类 `no_org_column` | `dealers` 没有组织列（经销商是客户而非本方组织，ADR-0026）。用"有订单的经销商"反推归属是派生关系，同一经销商可同时挂在多个组织的订单上，会得到与档案路由不一致的口径。登记 backlog：若产品要给经销商指定归属组织，需迁移加列 + 档案路由补谓词 + 指标复用 |

### 契约

- `scopeless` 改为对象 `{ category, reason, backlog? }`：`category` ∈ `global_by_nature`（口径天然全公司）/ `no_org_column`（业务上有归属但没有可用组织列）/ `pending`（能接入、尚未做）；`reason` trim 后 ≥ 20 字；**`pending` 必须带 `backlog`**（`docs/…` 路径或 http(s) 链接），其余分类可选。旧的字符串写法一律红。
- `check-metrics-scope.mjs --report`（`--json` 机读）：只列 scopeless 指标的 key / 分类 / 模块 / 权限点 / backlog / 理由，并按分类汇总。
- `pending` 超过阈值（默认 2，`--max-pending N` / `METRICS_MAX_PENDING`）时**只告警不失败**：CI 上输出 `::warning ::` 注解，本机输出 `warning:` 行，退出码不变。当前 `pending` 为 0。
- `GET /api/metrics`、`/values`、`/catalog` 新增 `hidden_scopeless`：`hidden_count` 中"调用者有权限、只因无范围语义被 `hide` 折叠"的条数（`label` 模式与全局调用者为 0；`/values?keys=` 按所请求 key 统计）。旧字段不变。
- 页面：受限账号在 `hide` 模式下**从不整页隐藏**——有范围口径的指标照常显示、标"按范围计算"，无范围口径的折叠成顶部说明里的一句"其中已隐藏 N 项全局口径指标…"（`Metrics.tsx` 只改说明块的 `reason` 入参，版式与 `data-count` 钩子不变）。
- 审批管理员（`admin` / 超管 / 持 `system:approval:manage`）在受限范围下按审批中心既有契约（ADR-0015，设置 `approval_manager_global` 默认开）仍见全部 pending，指标与其概览一致；关掉该设置后与普通账号同口径。这不是新泄漏：同一数字本来就在其审批中心概览里。
- 受限范围账号（持有 `approval.instance.view` / `system:approval:view` / `system:approval:manage` 任一）在默认 `hide` 下多收到 `approval_pending`，值与其审批中心概览的"待审批"一致，`scoped: true`；绑定门店 / 经销商账号不可见。`label` 与 `hide` 数值相同。

### 测试

`tests/metrics-scopeless-report.test.mjs`（先红后绿）：分类 / 理由 / `pending` 需 backlog / 旧字符串被拒；`--report` 与 `--json`；阈值只告警不失败。`tests/metrics-perms.test.mjs`：`approval_pending` 受限值 = 范围内单据 + 本人提交（他组织、无解析器类型、非 pending 均不计）、等于同账号审批概览、空范围不增加、绑定账号不可见；`hide` 下 `hidden_scopeless` 与"缺权限"分开计数。`tests/inventory-scope.test.mjs` 里 `approval_pending` 的 `scoped` 断言由 `false` 改为 `true`。

### 仍 open / 边界

- 经销商信用两条仍是全局口径（`no_org_column`）。
- 本机未跑浏览器：说明块文案变化未被场景覆盖（既有场景只断言 testid / `data-count`）；Linux CI 验证。
- 校验在 Mac mini Node 22 上，不等于 Linux / 目标平台验收。

### Codex 审计（AH2）

`codex exec -m gpt-6.1-sol --sandbox read-only`，静态审查，对象为 `batch-sixteen...HEAD`。发现与处理：

- **中（P2）** `--report --json` 在 `pending` 超阈值时把预警打到 stdout，JSON 后面多一行，输出不再可解析：**已修**。预警在 `--json` 下改走 stderr（`renderOutput` 纯函数），新增测试用 3 条伪造 `pending` 指标断言 stdout 可 `JSON.parse`、stderr 带 `::warning`、阈值内无预警。
- 未发现授权 / 数据范围泄漏；审批管理员全见与审批中心既有契约（ADR-0015）一致。
- 未覆盖（审计指出，**未补**）：`approval_manager_global=false` 与"当前级审批人"两条可见性分支没有指标侧用例——两者都由 `instanceVisibleTo` 本身（已有审批域测试）决定，指标只是直接调用它；记入 backlog 的后续测试项。数据库集成与浏览器测试审计沙箱内未运行，由本分支本机测试与 Linux CI 承担。
