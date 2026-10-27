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

## AE2 补充：角色矩阵覆盖自定义角色、账号覆盖分布与多角色并集（第十四批）

### 决定

- **一份计算**：`server/lib/role-matrix.js` 的 `buildRoleMatrix(db, { aggregates })` 是唯一计算。`/api/meta/role-matrix`（管理员出口）与 `scripts/gen-role-matrix.mjs` 都调用它；生成器的 Markdown 新增第五节"可见度五档"，即内置角色在该函数下的结果，因此接口逻辑的变动也会让 `--check` 漂移。
- **全部 active 角色**：矩阵读库内所有 `status='active'` 的角色，`roles[].builtin`（`roles.is_builtin`）区分内置 / 自定义；停用角色不入列。自定义角色走与内置角色相同的 `accessOf`（权限点 x `DOC_VIEW_PERMS` x `DOC_SCOPE_RESOLVERS`；不是总部角色、不是外部主体）。
- **账号 `data_scope` 覆盖分布（仅管理员出口）**：`scope_overrides[roleCode] = { default_scope, total, overridden, by_scope{all,subtree,org,self,dealer,other} }`，只有计数。按主角色（`users.role`）归属；只计 `status='active'` 且非 admin / 超管的账号；非法取值并入 `other`，原值不外露；响应里没有任何账号标识。
- **多角色**：schema 支持（`user_roles` 多对多，`permContext` 取权限点并集）。管理员出口 `multi_role = { label:'并集示例', accounts, combos[{roles, accounts, cells}] }`，按角色组合聚合、取账号数最多的前 10 组；并集格取各角色在同一单据类型上最宽的一档（权限点判据本身是"任一命中"）。非管理员持有多个角色时多得 `my_union`（仅自己这几个角色的并集一列，不暴露其它角色），否则为 `null`；非管理员仍只拿自己主角色那一列，不含 `scope_overrides` / `multi_role`。
- **生成器边界**：`--check` 与 Markdown 只含内置角色（生成器用全新临时库，并显式 `WHERE is_builtin=1`），CI 不随租户数据漂移。自定义角色 / 覆盖分布 / 多角色只在 `--json --db=<绝对路径>` 的 `tenant` 字段（库以 `readonly` 打开，只读；`--db` 不能与 `--check` / 写入同用，退出 2；路径须为已存在文件的绝对路径）。
- **页面**：主表只列内置角色；新增"自定义角色"分组（自定义角色列 + 覆盖计数表 + 并集示例）与"我的并集"卡，位于 `RoleMatrixExtras.tsx`，`RoleMatrix.tsx` 只加两行挂载与类型。

### 诚实边界

- 并集示例是示例：外部主体闸（`store` / `dealer`）按各角色分别算后取最宽，而账号真实口径取决于其主角色；`permContext` 取权限点时不过滤停用角色，矩阵只列 active 角色，二者在"账号挂了已停用角色"时可能有差。
- 覆盖分布按主角色归属，不展开"多角色 + 覆盖"的交叉；账号数很少的组合（如 1 个账号）对管理员本就可经 `/auth/users` 查到，非管理员拿不到这些字段。

### 验收

- `tests/role-matrix.test.mjs`（红先）：管理员出口含自定义角色（`builtin:false`，格子与独立推演一致，停用角色不入列）；覆盖分布计数精确（停用账号不计、非法取值进 other、响应不含 `ae2_` 账号名与非法原值）；多角色组合计数与并集格；非管理员不含聚合字段、`my_union` 只对多角色账号非空且不泄漏其它角色；生成器 `--json --db=` 的 `tenant` 与接口管理员出口逐项相等，默认输出只含内置角色，`--db` 误用退出 2。

### Codex 审计（AE2）

`gpt-6.1-sol`（只读）审阅 `batch-thirteen...HEAD`：无 high / medium / low。确认：聚合字段仅管理员出口、不含账号标识；自定义角色走同一 `accessOf`，停用角色不入列；生成器与接口共用 `buildRoleMatrix`，`--check` 只用内置角色的隔离临时库，`--db` 只读打开；`my_union` 仅含调用者自己持有的 active 角色。仍属已记载的边界：小账号数组合对管理员可推断（管理员本就可查账号）、并集与主角色口径的差异、停用角色权限点仍生效而矩阵不列。

## AF10 补充 3：权限上下文只合并 active 角色（第十五批）

### 决定

- **单一规则**：`permContext` / `userPermissions`（`server/middleware/auth.js`）只合并 `roles.status='active'` 的角色，**主角色也不例外**：主角色停用时账号只保留其它 active 角色的权限点。判据是新增的 `splitRolesByStatus(db, userId, primary)`（user_roles 并上 users.role，再按 `roles.status` 拆 active / inactive；库里没有该角色行按停用处理）。MCP 委托、`requirePerm`、待办过滤、指标等所有 `permContext` 消费者自动跟随；按角色指派的审批步骤（`approval.canApproveStep`，原先直接查 `user_roles`）改用同一函数，停用角色不再能审。
- **无权限账号照常登录**：账号因此一个权限都没有时仍能登录（**不新增 4xx**），所有权限门照旧逐请求 403。理由：登录失败会让管理员停用一个角色就把持有者整号锁在门外（连看提示、改密码都做不到），而权限门本来就逐请求拒绝，登录拒绝没有增加任何保护，只会丢掉提示。
- **披露**：登录响应的 `data`、`/api/auth/me`、`/api/auth/my-scope` 带 `roles_inactive: [...]`（只含**调用者自己**被授予且已停用的角色码，按字典序）、`notice_code`（有停用角色时为 `ROLE_INACTIVE_NOTICE`，否则 `null`）、`notice_message`。它是成功响应里的提示字段，不是失败码，所以不经 `bizFail`；码常量 `ROLE_INACTIVE_NOTICE` 在 `auth.js`。
- **矩阵同口径**：`buildRoleMatrix` 只列 active 角色，多角色并集与 `my_union` 都按 `known`（= active 角色）过滤，所以矩阵本来就是 active-only；本次把差异的另一端（`permContext`）补齐，AE2 补充里"停用角色权限点仍生效而矩阵不列"的边界不再成立。
- **缓存审计**：权限上下文**没有任何缓存**——`permContext` 每次请求回库，令牌里只有 uid / role / auth_version。因此角色状态一改，旧令牌的下一次请求立刻按新状态判；没有需要失效的缓存。当前也没有改 `roles.status` 的 HTTP 路由（状态由库 / 种子 / 运维脚本改），所以不涉及 `auth_version` 递增；将来若加角色启停路由，不需要为本规则递增 `auth_version`，但应写审计。

### 诚实边界

- `roles_inactive` 只说"被授予但已停用"，不区分是主角色还是附加角色；`notice_message` 是固定中文提示，不含权限点。
- `describeCaller` / `/auth/my-scope` 的数据范围仍按主角色字段（`users.role`、`roles.data_scope`）解释，不随主角色停用改变；本次只改功能权限轴，不改数据范围轴。
- `agent_token_roles` 等令牌自带角色表不在本次范围（令牌权限已由所有者的 `permContext` 与令牌上限共同收窄）。

### 验收

- `tests/authz-followups.test.mjs`（红先）：附加角色停用 -> 权限点集合精确等于其余 active 角色的并集且受该角色独占权限的门 403；主角色停用 -> 只剩其它角色；只有一个角色且停用 -> 登录 200、`roles_inactive` / `ROLE_INACTIVE_NOTICE` 出现、`permissions=[]`、门全 403、`my-scope` 同带；管理员 / 无停用角色账号披露为空；按角色指派的审批步骤同口径；复活后立即恢复（证明无缓存）。
- `tests/role-matrix.test.mjs`（红先）：含一个停用角色的夹具上，`permContext` 推出的查看权限点、接口列、生成器 `tenant` 列逐单据类型一致；停用角色不入列、不入任何并集。

### Codex 审计（AF10）

`gpt-6.1-sol`（只读，防御性审阅 `batch-fourteen...HEAD`）：

- **high，已修**：旧闸 `requireRole`（只比对主角色名，例如 `POST /api/purchase/orders`）在主角色停用后仍放行，与"无权限账号所有闸都拒绝"的决定矛盾。现在 `requireRole` 对非 admin 要求主角色 `roles.status='active'`，否则 403；`requireWrite`（当前无路由使用）在账号所有角色都停用时拒写；admin 例外保留。测试覆盖（停用主角色的账号写采购订单 403、admin 不受影响、复活后恢复到不再是 403）。
- 无 medium / low：`permContext` / `userPermissions` / `canApproveStep` 只会收窄不会放宽；没有服务端权限缓存（MCP 重放结果在返回前复核所有者的当前权限）；`roles_inactive` / `notice_code` 仅在凭据校验成功后、且只含调用者自己的角色，无跨账号披露与枚举面。
- 记载的剩余边界：其它直接用 `req.user.role` 做业务分支（非闸）的代码（如数据范围解释、外部主体判定）仍按主角色字段，不随角色停用改变；前端暂不展示 `notice_message`。


## AG10 补充 4：停用角色的前端提示与数据范围说明随状态（第十六批）

### 决定

- **说明按生效角色生成**：`GET /api/auth/my-scope` 的 `explanations` 由 active 角色计算（`splitRolesByStatus`），响应新增 `roles_effective`（调用者自己的生效角色码）；`roles_inactive` / `notice_*` 沿用 AF10。说明里逐项写出贡献者：一行"你当前的生效角色：…"（没有生效角色时明说）、一行"已停用的角色：…"、数据范围的角色默认只来自**主角色**（附加角色只贡献功能权限，不改变数据范围）。
- **主角色停用要明说**：说明里有"你的主角色「X」已停用…"；`role_default_scope` 为 `null`，`data_scope_source` 新增取值 `role_inactive`（此时说明写明数据范围为空）。`role` / `role_name` 仍是账号的主角色字段，不改语义。
- **执行与说明同口径**：`resolveOrgScope` 的角色默认范围只取 `roles.status='active'` 的主角色；主角色停用且账号没有单独设置范围时**失败即收紧**为空范围 `none`（Codex 审计指出落到 `self` 可能比原来的 `dealer` 默认更宽，已改）。这是**只收窄不放宽**的改动（补充 3 记载的"数据范围仍按主角色字段"边界由此收口）；管理员 / 超管不受影响，账号级 `data_scope` 仍优先。
- **前端**：登录后（`Layout`）当 `notice_code === 'ROLE_INACTIVE_NOTICE'` 显示可关闭的横幅（文字取服务端 `notice_message`，登录响应的提示并入会话用户对象，随后 `/auth/me` 以同样字段刷新；按停用角色集合记住关闭，集合变化会重新出现）。"我的数据范围"页显示停用角色码和"以下说明由生效（启用）的角色生成"的说明。
- **浏览器场景** `tests/browser/inactive-role-notice.mjs`（已登记到 `browser-ci.mjs`，策略测试覆盖）：服务端没有"启停角色 / 加附加角色"的 HTTP 路由，所以场景只能经驱动传入的一次性 `GML_TEST_DATA_DIR`（驱动自己创建的临时数据目录，仅此一个新增环境变量）直接改库：加附加角色、置 inactive，`finally` 里恢复 active。没有新增管理接口，避免为了测试扩大攻击面。

### 诚实边界

- 浏览器场景本机未执行（Linux 托管 CI 才跑）；本机只做 `tsc`、`vite build`、`node --check`、策略测试与服务端测试。
- 附加角色不提供数据范围默认（现状如此），所以主角色停用后不会改由附加角色补默认范围。
- 横幅的"关闭"只在当前页面生命周期内有效，刷新后若仍有停用角色会再次出现（有意：提示不应静默消失）。

### 验收

- `tests/authz-followups.test.mjs`（红先，已确认回退服务端改动后失败）：附加角色停用 -> 不在生效角色行、单独的停用行点名；主角色停用 -> 明说、`role_default_scope=null`、来源不再是 `role_default`；唯一角色停用 -> 无生效角色；`resolveOrgScope` 与说明一致且只收窄；无停用角色账号无提示；不泄漏其它账号 / 角色名。
- `tests/my-scope.test.mjs`：精确键集合加入 `roles_effective`。

### Codex 审计（AG10）

`gpt-6.1-sol`（只读，防御性审阅 `HEAD~1..HEAD`）：

- **high，已修**：停用主角色后回落到 `self`，对默认范围为 `dealer` 的角色反而更宽（`dealer/orgIds:null` -> `self/orgIds:[org]`）。现在主角色停用且无账号级范围时返回空范围 `none`（`orgIds=[]`），账号级 `data_scope` 仍优先；回归用例覆盖内置 `dealer` 角色停用，以及 `purchase` 角色的 `none` / 说明 / 账号级范围仍生效。
- **medium，已修**：管理员 / 超管的说明不应声称"没有生效角色就没有权限"或"默认范围不再计入"；这些行现在仅对非管理员输出，并有"管理员说明不含失权措辞"用例。
- **low，已修**：场景清理——数据库与浏览器改为嵌套 `finally`（浏览器在受保护的 `try` 内启动），角色状态恢复为场景开始时记录的原值而不是写死 `active`。
- 调用者自己披露：未发现跨账号 / 未授予角色的披露（`my-scope` / `login` / `me`）；场景无选择器竞态。
