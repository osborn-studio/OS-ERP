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

`bool`、默认 `1`（开）、`is_danger: true`（改动必须写理由）。关闭仅取消 HTTP docflow 对非总部内部账号的「未绑定则不可见」检查，仍按组织数据范围读取；不会取消已绑定账号的本店 / 本经销商限制，也不改变 MCP 的严格绑定。读取走 `readSetting`（库里值非法时回落默认开，失败关闭）。危险键集合十八 → 十九（`scripts/test-setting-audit.mjs` 已同步）。

与 AC3 集成后的范围：未绑定检查覆盖 RC / YQ / SH / PS / PSF（门店）及 DR（经销商）。OC / OCS 的订货主体限制与 DS / RB 的总部专属限制独立于此开关，关闭时仍生效。因此关闭不是将整个 docflow 恢复到第十一批的权限行为。AC2 最初只覆盖 RC / YQ / SH，以下历史验收描述应结合该集成范围阅读。

## 行为变化（需知悉）

1. 未绑门店、数据范围=全部、且**不是**总部角色（含 `boss`、`viewer`、自定义角色）的内部账号，经 `/api/docflow/{events,overview,history,trace}` 不再看到 RC / YQ / SH 的单据与留痕。**老板（`boss`）因此也不再看到这三类**——这是并集名单不含 `boss` 的直接后果。是否把 `boss` 作为总部角色并入，是产品决定（并入 = 往 `hq-roles.js` 表里加一行，POS / 要货两面各自声明是否放行），本 ADR 不替客户做；需要时可先关开关临时回退。
2. 总部角色、admin、超管、已绑门店账号的可见性不变。POS 与要货路由行为不变（测试断言两份派生名单与改动前逐项相同）。

## 验收

`tests/hq-roles.test.mjs`：名单并集 / 派生与旧字面量逐项一致、路由文件不再自带名单、设置键注册（危险、默认开）；docflow 集成：默认开（开关缺省）下 boss / viewer 看不到 RC 事件与历史、总部角色 / admin / 超管全可见、绑店账号仍限本店；开关置 `0` 回到旧行为、置 `1` 与非法值回到严格；overview 分布同口径。`scripts/test-setting-audit.mjs` 危险键集合 19。

## Codex 审计

`gpt-6.1-sol`（只读）审阅 `batch-eleven...HEAD`，无 high；HQ 名单与 POS / 要货路由闸"逐项不变"的结论被确认。

- **medium，已修**：`POST /api/docflow/transition` 对 RC / YQ / SH 只过 `assertCanRead`（不含绑定），未绑门店的非总部账号用不存在的 action 绕过权限点检查后，409 错误里会带出其不可见单据的 `docNo`。现在带 `binding` 的类型在驱动前先过 `docInScope`，范围外与不存在同形 404（`记录不存在`）；总部角色不受影响，已绑门店的账号在此入口同样收窄到本店（此前可跨店驱动，属有意收紧）。测试覆盖。
- **medium，接受**：`readSetting` 把空白 / 空串的 bool 值归一为 `'0'`，所以库里被写成空白会关闭严格绑定。bool 键写 `0 / false / no / off / 空串` 都是"明确关闭"的既有语义，写入走危险键流程（必须写理由并留痕）；缺失 / 空 JSON / 非法值仍回落默认开。不为单个键破坏 `normalizeSettingValue` 的统一口径。
- **low，已修**：测试里 `/trace` 返回数组，原断言读 `.events` 恒真；改为直接断言数组长度。

## AD2 补充：`boss` 并入总部名单，与角色矩阵文档（第十三批）

状态：开发实现，尚非产品上线验收。

### 决定：`boss` 进 `HQ_ROLES`（并集），POS / 要货两个面不放行

上文"行为变化 1"把 `boss` 排除在并集之外，并说明"是否并入是产品决定"。该决定现已作出：**老板 / 总经理看得到所有门店的单据**。理由：

- 老板的内置角色本就是 `data_scope=all`、持有 57 个权限点（含各模块查看权），业务上没有"只看自己门店"的口径；ADR-0051 落地后他经 docflow 看不到 RC / YQ / SH，是名单口径的副作用，不是设计意图（"总经理看不到门店日结"在客户场景里是缺陷）。
- 改动只是 `hq-roles.js` 表里加一行：`boss: { pos: false, requisition: false }`。`POS_HQ_ROLES`（admin / finance / sales / warehouse）与 `REQUISITION_HQ_ROLES`（admin / finance / sales / warehouse / purchase / scm）逐项不变，测试断言 boss 不在这两份里。所以老板**不会**因此获得 POS 日结确认、全店现金接口、要货 / 发货总部写入口——"看得见"和"能操作"是两件事，后者仍由权限点与各路由的角色闸决定。
- 后果（需知悉）：并集豁免的是 docflow 严格绑定闸的"未绑定"分支，对 `binding: 'store'`（RC / YQ / SH / PS / PSF）与 `binding: 'dealer'`（DR）一视同仁，所以未绑定的 boss 同时能经 docflow 读到全部经销商要货单（DR）的流转留痕；`binding: 'hq'`（DS / RB）与 `subject`（OC / OCS）本来就不挡 boss。已绑门店 / 经销商的 boss 账号仍只限本店 / 本经销商（与其它总部角色一致）。MCP 的 `docScopeCtx` 仍不带 `hqExempt`，boss 的 MCP 令牌读 RC / YQ / SH 仍需要所有者有门店绑定，并且 boss 没有 `pos.*` 的查看权限点，MCP 侧本来就读不到这些类型（矩阵第二节可见）。
- 回退：设置键 `docflow_strict_store_binding=0` 的语义不变；要撤销 boss 豁免，删掉表里这一行即可（矩阵会随之漂移，CI 提醒重新生成）。

### 角色矩阵：`docs/operations/role-matrix.md`（生成物）

`scripts/gen-role-matrix.mjs` 在临时库里跑迁移，对每个内置角色（10 个）× 每类单据（40 类）**调用真实门禁函数**求值，不手写任何结论：

- 单据流转（HTTP docflow）：`docScopeOf` + `resolveOrgScope` + `hq-roles.js` → G 全局｜O 组织范围｜B 仅绑定｜- 不可见（外部主体整体 403）。
- MCP 通用读工具：权限点（`permContext` / `hasPerm`）+ 外部主体闸 + `holdsBinding` → Y｜Y*（需门店 / 经销商 / 订货主体绑定）｜-；与 `canViewDocType` 逐格对拍，不一致则生成失败。
- 另列每类单据的查看权限点、`DOC_VIEW_PERMS` 绑定与 `DOC_SCOPE_RESOLVERS` 绑定 / 构建器，以及三份总部名单的角色标志。
- `--check` 用于 CI（`ci.yml` checks job 新增独立一步 "Role matrix is current"）：与生成结果逐字节比对，文件缺失、手改格子、尾部多字节、换行改写都判漂移；有任一在用单据类型缺 `DOC_VIEW_PERMS` / `DOC_SCOPE_RESOLVERS` 登记则直接失败而不是画成 `-`。`--file=<绝对路径>` 只给测试造漂移用。
- 诚实边界：矩阵描述"该角色的默认账号"（默认数据范围、放在某组织、未绑定）；单账号的 `data_scope` 覆盖、多角色叠加、自定义角色不在内；docflow 读接口本身不按查看权限点收口，权限点由 MCP 读工具和各业务路由把关（矩阵正文已写明）。

### 验收

- `tests/hq-roles.test.mjs`：并集 = 旧两份名单 ∪ {boss}；POS / 要货名单不含 boss；docflow 默认开关下 `viewer`（非总部）仍看不到 RC / 流转留痕，`boss` 与其它总部角色同视；overview 分布含 RC；开关置 0 / 1 / 非法值的行为不变。
- `tests/authz-followups.test.mjs`：抽样 10 格（boss×RC、boss×DR、viewer×RC、finance×VOUCHER、purchase×AR、warehouse×TF、sales×SO、scm×PO、store×PS、dealer×OC），期望字面值写死，分别断言生成器 JSON、已提交的 `role-matrix.md` 与真实 `/api/docflow/events` 响应三者一致（G = 全部、O = 严格子集且 TF 与独立 SQL 精确相等、B / - = 空、外部主体 403；另验同角色绑店后只见本店）；`--check` 对缺文件 / 手改 / 尾部字节 / CRLF 改写为红。

### Codex 审计（AD2）

`gpt-6.1-sol`（只读）审阅 `batch-twelve...HEAD`：无 high；boss 并入"不引入 POS / 要货扩权"的结论被确认（`isHqRole` 的唯一运行时消费者是 docflow 未绑定豁免，覆盖 PS / PSF / RC / YQ / SH 与 DR，已绑者仍收窄，DS / RB 仍挡绑定账号，MCP 无豁免）。

- **medium，已修**：生成器只设 `GML_DATA_DIR`，继承来的 `GML_DB` 优先，迁移与夹具用户可能写进别人的库。现在先清除 `GML_DB`，并校验解析出的库路径在临时目录内，否则拒绝；测试覆盖（传入外部 `GML_DB` 不产生文件）。
- **medium，已修**：生成器把 `strictBinding / hqExempt` 写死为 true，而路由取设置键 `docflow_strict_store_binding`；改默认值时矩阵不会漂移。现在与路由同一判据（`readSetting(...) === true`）。
- **medium，已修（缩小假阳性面）**：`O` 格把所有受限谓词折叠成一类，解析表的 `cols / via / kind` 变动不改变任何格子。第三节新增"范围谓词来源（表 · 归属列 / 形状）"列，任一变动都使文件漂移；仍然不是逐行谓词证据，文件头与上文"诚实边界"如实说明，具体行级收窄由 `docflow-scope` 等集成测试与本测试的 TF 精确断言兜底。
- **low，已修**：`--check --json` 因 `--json` 先退出而跳过比对。现在两者同用直接退出 2，测试覆盖。
