# ADR-0051 总部角色名单单点与 docflow 严格门店绑定（AC2）

状态：开发实现，尚非产品上线验收｜相关：ADR-0011（AB7 补充：RC / YQ / SH 门店绑定与"已知残余"）、ADR-0025（POS 门店绑定）、ADR-0032（docflow 读范围）

## 背景

ADR-0011 AB7 补充登记过一条既有的高危发现：`/api/docflow/*` 的范围上下文不设 `strictBinding`，所以"未绑定门店、`data_scope=all`、非总部角色名"的内部账号仍能经 docflow 读到 RC（日结）/ YQ（门店要货）/ SH（门店发货）的单据与流转留痕——门店路由会拒它、总部路由因角色名拒它，只有 docflow 只看数据范围。当时没有收紧，是因为"总部角色名"有两份不同的名单：`routes/pos.js` 的 `HQ_ROLES`（admin / sales / finance / warehouse）与 `routes/requisitions.js` 的 `HQ`（purchase / warehouse / sales / scm / admin / finance），直接复刻其中一份会改变另一面的可见性。

## 决定

### 1. 名单单点：`server/lib/hq-roles.js`

一张表，三种派生，全部冻结：

| 导出 | 内容 | 用途 |
| --- | --- | --- |
| `HQ_ROLES`（并集） | admin / finance / sales / warehouse / purchase / scm | 不受门店绑定约束的总部角色；docflow 严格绑定的豁免名单；`isHqRole(role)` |
| `POS_HQ_ROLES` | admin / finance / sales / warehouse | POS 总部接口路由闸、跨店结算、`all=1` 查询——与改动前 `HQ_ROLES` 逐项相同 |
| `REQUISITION_HQ_ROLES` | admin / finance / sales / warehouse / purchase / scm | 门店要货 / 发货总部接口路由闸——与改动前 `HQ` 逐项相同 |

**为什么 POS 与要货各留一个面**：并集是"谁属于总部"的口径，但"谁能确认 POS 日结、看全部 POS 现金在途"是权限决定，不是身份事实。若 `pos.js` 直接用并集，采购主管与供应链主管（purchase / scm）会新获得 POS 日结确认与全店现金接口——那是一次静默的权限放宽。所以名单只有一份来源，两个路由面的放行标志在同一张表里各自声明，行为不变。

逐角色理由：

- `admin`：系统管理员，两份名单都有；总部本体。
- `finance`：财务，两份都有；结任意门店日结、对账要看全部门店单据。
- `sales`：销售主管，两份都有；总部销售侧要跨店看订货 / 要货。
- `warehouse`：仓储主管，两份都有；总部发货 / 收货要看全部门店要货与发货单。
- `purchase`：采购主管，只在要货名单；要货转采购需要读全部门店 YQ。不在 POS 名单（不参与门店现金），仅并入 docflow 豁免，使其继续读 YQ 留痕。
- `scm`：供应链主管，同 purchase（采购 + 库存 + 生产 + 质检 一人管，需读要货 / 发货）。
- **不在名单**：`boss`（老板 / 总经理）、`viewer`（只读访客）以及任何自定义角色；`dealer` / `store` 本就是外部主体，被 `requireInternal` 先挡。

### 2. docflow 严格绑定

- `routes/docflow.js` 的 `scopeCtx` 现在带 `strictBinding: true` 与 `hqExempt: true`（开关打开时）。`lib/docflow.js` 的 `docScopeOf`：带 `binding: 'store'` 的类型（RC / YQ / SH）对**未绑门店**的所有者，在 `strictBinding` 下返回 `null`（整类不可见），除非 `hqExempt` 且角色属于 `HQ_ROLES`。admin 与 `is_super` 仍由 `storeBindingExempt` 先行豁免；已绑门店的账号照旧收窄到本店（与 AB7 一致，总部角色绑了门店也只看本店）。
- 改动落在 `docScopeOf` 一处，`docEventScope`（events / overview / history / trace 共用）自动一致。MCP 的 `docScopeCtx` 仍是 `strictBinding: true` 不带 `hqExempt`，保持"MCP 比 HTTP 严"（Y6）。
- 文件落点说明：任务口径写作"doc-scope-registry.js"，但 `docScopeOf` 与 `DOC_SCOPE_RESOLVERS` 实际在 `lib/docflow.js`；`doc-scope-registry.js`（构建器登记表）未改，因此与 AC3 在该文件上无交集。

### 3. 危险设置键 `docflow_strict_store_binding`

`bool`、默认 `1`（开）、`is_danger: true`（改动必须写理由）。关闭 = 恢复本 ADR 之前的行为（docflow 只看数据范围）。读取走 `readSetting`（库里值非法时回落默认开，失败关闭）。危险键集合十八 → 十九（`scripts/test-setting-audit.mjs` 已同步）。

## 行为变化（需知悉）

1. 未绑门店、数据范围=全部、且**不是**总部角色（含 `boss`、`viewer`、自定义角色）的内部账号，经 `/api/docflow/{events,overview,history,trace}` 不再看到 RC / YQ / SH 的单据与留痕。**老板（`boss`）因此也不再看到这三类**——这是并集名单不含 `boss` 的直接后果。是否把 `boss` 作为总部角色并入，是产品决定（并入 = 往 `hq-roles.js` 表里加一行，POS / 要货两面各自声明是否放行），本 ADR 不替客户做；需要时可先关开关临时回退。
2. 总部角色、admin、超管、已绑门店账号的可见性不变。POS 与要货路由行为不变（测试断言两份派生名单与改动前逐项相同）。

## 验收

`tests/hq-roles.test.mjs`：名单并集 / 派生与旧字面量逐项一致、路由文件不再自带名单、设置键注册（危险、默认开）；docflow 集成：默认开（开关缺省）下 boss / viewer 看不到 RC 事件与历史、总部角色 / admin / 超管全可见、绑店账号仍限本店；开关置 `0` 回到旧行为、置 `1` 与非法值回到严格；overview 分布同口径。`scripts/test-setting-audit.mjs` 危险键集合 19。

## Codex 审计

（见下方"审计记录"。）
