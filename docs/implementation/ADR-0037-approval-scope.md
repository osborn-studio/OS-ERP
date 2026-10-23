# ADR-0037：审批域按指向单据的组织范围收口

日期：2026-10-23。收口路线图 v4 的 Y12：`server/routes/approval.js` 的实例列表 / 详情 / 总览 / 待办 / 闸门查询对内部账号返回全库，创建 / 撤回 / 决定只有处理器内检查。`data_scope=org|subtree` 的内部账号能读到、撤回甚至（作为角色型审批人）审批其他组织单据的审批实例。状态：开发实现，尚非产品上线验收。

## 决定

审批实例没有自己的归属，**一律跟着它指向的单据**（`doc_type` + `doc_id`）。唯一判据在 `server/lib/approval.js`：

- `approvalDocScope(db, docType, docId, scopeCtx)`：单据是否在调用者组织范围内。`scopeCtx = { orgScope, user }`（路由层取 `req.orgScope` / `req.user`）；不传 ⇒ 不收口（lib 内部、脚本、MCP 的既有口径不变，与 `purchaseScopeSql` 同约定）；`orgScope.scope === 'all'` ⇒ 全库；受限范围下**没有解析器的类型、已不存在的单据、空范围一律 false**（失败关闭，不是全库）。
- `instanceVisibleTo(db, inst, actor, scopeCtx)`：可见 = 全局范围 ∪ 提交人本人 ∪（`pending` 且当前级审批人是我，`canApproveStep`）∪ 单据在组织范围内。

### 内联解析器（待 Y2 替换）

Y2 在 `server/lib/docflow.js` 建 `DOC_SCOPE_RESOLVERS`；本工作流不得改该文件，故在 `approval.js` 内联最小映射 `approvalDocScope`（文件内标注"待 Y2 的 DOC_SCOPE_RESOLVERS 合入后替换"）。覆盖范围只含审批实例会指向的类型：

| 单据类型 | 表 | 谓词 |
|---|---|---|
| PRQ / PI / PST / PAY | 各自 `org_id` | `purchaseScopeSql(...).org`（ADR-0017/0020） |
| PO / GR / PRT | 经 `warehouses.org_id` | `purchaseScopeSql(...).wh` |
| SO / DL / SR | `sales_orders` 等 | `salesScopeSql`（ADR-0026，仓或门店任一在范围内） |
| OC / OCS | `oc_orders` / `oc_statements` | `ocScope(..., 'customer_id')`（ADR-0027；外部主体仍是自己的客户） |

其他类型（TF、CK、QT、AR 等）对受限范围一律不可见。Y2 合入后把 `approvalDocScope` 的三段分支换成 `DOC_SCOPE_RESOLVERS[docType]` 一次分发即可，调用点不变。

### 各入口

| 入口 | 口径 |
|---|---|
| `GET /instances` | 逐行 `instanceVisibleTo` 后再分页，`total` 是过滤后的数量（受限范围不下推 SQL：实例表是低量表） |
| `GET /instances/:id`（含 `records` 审批历史） | 不可见 ⇒ 404，与"不存在"同一句话 |
| `GET /pending`、`GET /todos` | 当前级是我 ⇒ 保留（自己的队列不受组织限制）；持 `system:approval:manage` 的"全见"在受限范围下收窄为范围内单据 |
| `GET /overview` | 计数 / 金额 / 分类按同一可见集合算 |
| `GET /check` | 闸门查询会回显待审实例；范围外单据 ⇒ 404 |
| `POST /instances` | 目标单据不在范围内 ⇒ 404，不建实例（在原 `assertCanRead` 与外部主体门之后，不替换它们） |
| `POST /instances/:id/cancel` | 先判可见（看不到 ⇒ 404，不让 403 泄漏存在性），再要求单据在范围内（提交人也不例外），最后才是原有"提交人本人或管理员"（否则 403） |
| `POST /instances/:id/decide` | 先要求单据在范围内（范围外 ⇒ 404，且零写），再走原有 `requirePerm` 与 `canApproveStep` |

## 取舍与已知边界

- **审批管理员（`system:approval:manage`）的 pending 队列同样不受组织限制**（ADR-0015 既有契约，`tests/authz-followups.test.mjs` 断言），列表 / 详情对其 pending 实例照此放行；非 pending 的历史实例与所有决定仍按单据范围。该权限点是模板维护级别，应只授予全局范围账号；若要收窄，在 `isApprovalManager` 分支加 `approvalDocScope` 即可（需同步改 authz-followups 的口径）。
- **审批人"自己的队列不受组织限制"是任务给定的口径**：角色型 / 权限型审批人（如角色 finance）仍能在列表 / 详情 / 待办里看到当前级指向自己的**其他组织**的 pending 实例；但**不能决定**它们（`decide` 要求单据在范围内，404）。结果是"看得到、批不了"。如需更严（审批人也只见范围内），把 `instanceVisibleTo` 的审批人分支改为仅 `approver_type='user'`（点名到个人）即可，是单点修改。
- **MCP 的 `approval.approve`**（`server/mcp/tools.js`，调用 `decideApproval`，未传 `scopeCtx`）不在本工作流文件范围内，仍是不收口口径；其组织范围由 MCP 令牌 / 委托层另行承担。`decideApproval` 已留 `scopeCtx` 参数，接入只需传参。
- 提交人读自己的实例不看组织（其范围之后收窄也不丢自己的单），但**撤回**要求单据仍在范围内。
- 模板 / 元数据（`/templates`、`/meta`）是全局配置，不含单据数据，沿用原门。
- 新增类型的审批实例若没有解析器，受限账号不可见——这是有意的失败关闭；加类型时须同时加解析器（Y2 分发表合入后即在那里加）。

## 对 ADR-0021 登记的更新

`check-route-authz` 中 `approval.js` 的 `handler-scope` 登记（`POST /instances`、`POST /instances/:id/cancel`）理由更新为含 `approvalDocScope`；条目与 pending 总数不变（GET 读路由本就在路由器层 `requireInternal` 之后，属 GATED，不需登记）。

## 验证入口

`node --test tests/approval-scope.test.mjs`：创建 / 列表 / 详情 / 总览 / 待办 / 闸门 / 撤回 / 决定 的范围内外断言、外部与无组织账号、无解析器类型失败关闭、销售与订货中心解析。Mac mini Node 22 本地验证，不等于目标平台验收。

## 补充（Z9，批次九）：审批管理员范围开关 `approval_manager_global`

上文"取舍与已知边界"的第一条把审批管理员（`system:approval:manage`）的 pending 全见当作 ADR-0015 既有契约保留。该权限点是模板维护级别，但现实里常被授予有组织归属的账号，使其越过组织边界看到他组织的待审单与金额。本补充把这个口径变成**显式、可审计的设置**，默认不改行为：

- 设置 `approval_manager_global`（bool，默认 `1`，`is_danger`，分组 `approval`；`lib/settings.js` 的 `SETTING_RULES` 登记，改动须写理由并进配置变更日志）。
- **1（默认）**：与上文完全一致——管理员 pending 全见。
- **0**：数据范围受限（`org` / `subtree` / 无组织）的审批管理员，可见集合 = 指向其组织范围内单据的实例 ∪ 提交人本人 ∪ 当前级审批人是本人的 pending 队列（`canApproveStep`，不变）。判据仍是同一份：`instanceVisibleTo` 的管理员分支与 `pendingInstancesFor` 都经 `managerSeesAll(db, actor, scopeCtx)` 取开关；`pendingInstancesFor` 在开关关闭时对受限管理员保留 `canApproveStep ∪ approvalDocScope`。
- **不受开关影响**：全局范围（`data_scope=all`，含 admin / 超管）账号；不传 `scopeCtx` 的 lib 内部 / 脚本 / 通知摘要（`approvalTodos`，仍由 ADR-0008 全局门把守）；决定（`decide`）与撤回本来就要求单据在范围内，与开关无关。
- **入口**：`GET /pending`、`GET /todos`（两者新增 `attachOrgScope` 并把 `scopeCtx` 传入 `pendingForMe` / `approvalTodosFor`）、`GET /instances`、`GET /instances/:id`、`GET /overview` 均走上述判据。
- **仍是已知边界**：角色型 / 权限型审批人"看得到、批不了"的口径不变（那是审批人队列，不是管理员全见）；MCP `approval.approve` 仍沿用其签字人范围；开关是全库单一值，不分角色。

验证：`tests/approval-scope.test.mjs`（组织 A/B/无组织管理员 × 开关 1/0，覆盖 pending / todos / instances / 详情 404 / overview / decide 404，审批人队列与全局账号不变）、`tests/authz-followups.test.mjs`（todos 口径，两种设置各断言）、`scripts/test-setting-audit.mjs`（危险键集合 17 → 18）。

**Codex 审计（Z9）与已知边界**：审计提出 P1——受限范围的审批管理员可经 `POST /api/approval/templates`（同样要求 `system:approval:manage`）把自己设为现有模板的审批人，使他组织的 pending 实例变成"自己的队列"而重新可见。这是任务给定的"审批人自己的队列不受组织限制"口径与"模板维护归审批管理员"两条既有契约叠加的结果，不是新增路由漏洞：**决定与撤回仍由单据范围拦截（404、零写）**，且模板修改有审计。开关为 0 并不能把 `system:approval:manage` 变成"无法自授权可见性"的角色；要达到该强度，需另行限制模板写入（例如仅全局范围账号可改模板、或审批人队列也按单据范围），留作后续项，未在本工作流实现。
