# ADR-0011：MCP Agent Token 是所有者的委托，不是独立服务主体

日期：2026-10-22。范围：审阅报告 F07（P1）全部，F13 与 F09 的 MCP 部分。不包含通知渠道秘密、`middleware/audit.js`、`lib/http.js`、后台 JWT 的查询串取值（`middleware/auth.js`）以及生产上线验收。

## 决定

**有主令牌（`agent_tokens.owner_user_id IS NOT NULL`）是所有者本人的委托。** 它在任何时刻能做的事，等于「令牌自己声明的范围（scopes / allow / deny / 绑定组织）」与「所有者**此刻**在库里还有的权限点与数据范围」的交集；所有者不可用，委托随之不可用。判据与后台 JWT 的 A20 口径完全相同：凭据只是"谁签发过"的声明，可用性与权限每次回库核对（`permContext` / `resolveOrgScope`，不另写一份）。

**无主令牌（`owner_user_id IS NULL`）保持 A16/批次 K 文档的既有定义：** 它是只受令牌自身范围约束的独立服务主体，采购域写型工具对它一律 403 `AGENT_OWNER_REQUIRED`（无法归责的单据不能建）。本 ADR 不放宽也不收紧无主令牌；管理界面（`POST /api/mcp/tokens`）只签发有主令牌，无主令牌只能由代码路径直接 `createToken` 产生。是否彻底禁止无主令牌属于产品政策，留待后续决策。

## 每次调用的委托判定（`server/mcp/delegation.js`）

握手（`initialize` / `ping` / `notifications/initialized`）之后的**所有**方法——工具、资源、提示、`tools/list`——在验完令牌本身（状态 / 有效期 / 限速）后，立刻解析委托：

| 所有者状态 | 结果 | JSON-RPC `error.data.code` |
|---|---|---|
| 用户行不存在 | 拒绝 | `TOKEN_OWNER_MISSING` |
| `users.status <> 'active'` | 拒绝 | `TOKEN_OWNER_INACTIVE` |
| `agent_tokens.owner_auth_version` 为空或 ≠ `users.auth_version` | 拒绝 | `TOKEN_OWNER_REVOKED` |
| 正常 | 继续，取所有者当前权限点与数据范围 | — |

通过之后：

- **权限点**：每个工具声明 `perms`（任一命中即可，`server/mcp/tools.js`）。`tools/list`、`resources/list`、`resources/read`、`tools/call` 都走同一个 `checkToolAccess`：级别 → 白名单 → 黑名单 → 所有者当前权限点。所有者没有权限的工具**列不出也调不到**；调用返回工具级错误 `TOKEN_OWNER_PERM_DENIED`（`result.isError`，与 `SCOPE_DENIED` 同层）。权限码与 HTTP 入口对齐：入库 `purchase.inbound`、出库 `sales.outbound`、调拨 `inventory.transfer`、货权转移 `inventory.transfer.ownership`、库存调整 `inventory.adjust`、调价 `master.price.edit`、作废订单 `sales.order.edit`、审批通过 `approval.instance.act`、采购建单沿用各工具内已有的那一个码；只读工具用对应的 `*.view` / `inventory.stock.query` / `inventory.cost.view` / `inventory.batch.view`。字典、看板、组织树、通用单据查询、以及边权限由状态机在工具内判定的 `purchase.advance_*` / `doc.transition` 声明为 `[]`（仍受级别、数据范围交集与工具内闸门约束）。
- **数据范围**：`ctx.scope` = 令牌绑定组织的子树 ∩ 所有者 `resolveOrgScope` 的结果。任一方不受限则取另一方；都受限取 id 交集；所有者范围为 `dealer` / `none` / 无组织归属时视为**没有可见组织**，交集为空——读工具 `AND 1=0`、写工具 `ORG_OUT_OF_SCOPE`（宁可看不到，也不放行）。
- **高危（danger）工具**仍由人工确认人签字（D5）：边权限按确认人判定不变；本 ADR 只在其之上加了所有者门（所有者停用 / 版本变化 / 无该工具的 `perms` 即拒）。

## 撤权机制：版本对照 + 停用联动吊销

选用**签发时记录所有者 `auth_version`、每次调用对照**（迁移 053 新增 `agent_tokens.owner_auth_version`）。ADR-0004 已让改密、停用、角色 / 超管标记 / 组织 / 数据范围 / 归属变化、角色权限集变化递增所有者版本，因此这些事件**无需各自再加钩子**就会让此前签发的全部令牌永久失效（`TOKEN_OWNER_REVOKED`）；重新启用账号不会让旧令牌复活（版本只增不减），必须重新签发。

在此之上，**停用账号**（`updateAccount` 的 `status → inactive`）在同一 immediate 事务里调用 `revokeOwnerTokens`，把该所有者名下全部 `active` 令牌置为 `revoked`（安全审计明细新增 `agentTokensRevoked`，接口返回同名字段）。于是停用后旧令牌报的是凭据层的 `TOKEN_REVOKED`，且在令牌列表上可见；若有人绕过服务直接改库（不递增版本、不吊销），每次调用的状态复读仍会以 `TOKEN_OWNER_INACTIVE` 拒绝。

迁移 053 把存量有主令牌的 `owner_auth_version` 回填为所有者当前版本（它们在下一次撤权事件前照常可用），重跑不重置；`createToken` 要求所有者存在且 active，否则 400 `TOKEN_OWNER_INVALID` / `TOKEN_OWNER_INACTIVE`——停用的人不能再被签新令牌。

## 凭据只从 Authorization 头取

`extractToken` 只认 `Authorization: Bearer gml_…`；`?token=`、`body.token`、`x-agent-token` 一律当作缺失（`TOKEN_MISSING`），不做兼容回退。查询串会原样进入访问日志、代理日志与浏览器历史。后台 JWT 在 `middleware/auth.js` 的查询串取值不在本 ADR 范围内。

## 调用审计（F13 的 MCP 部分）

- 入库前按键名脱敏：`/password|secret|token|authorization|key/i` 命中的值递归替换为 `***`（`idempotency_key` 也会被打码，它有专用列）。
- **写型 / 高危工具**：成功路径的 `mcp_call_logs` 插入与业务过账、幂等缓存、确认单消费在同一个 `db.transaction` 里；插入失败或未落行 ⇒ 整个事务回滚，客户端得到工具级错误 `AUDIT_UNAVAILABLE`。故障排除后同一幂等键可以干净重试（缓存没有落下，不会命中"幂等重放"）。
- **只读工具**与所有"已经失败"的路径保持 best-effort，但失败不再静默：`console.error` 记录工具名与错误。
- 幂等（令牌 + 工具 + 键 + 参数指纹）与确认单（工具 + 参数 + 令牌三元组、原子占用）语义不变。

## 对客户端可见的契约变化

1. JSON-RPC 凭据层错误新增 `error.data.code`：`TOKEN_MISSING` / `TOKEN_INVALID` / `TOKEN_REVOKED` / `TOKEN_EXPIRED` / `TOKEN_RATE_LIMITED` / `TOKEN_OWNER_MISSING` / `TOKEN_OWNER_INACTIVE` / `TOKEN_OWNER_REVOKED`；`error.code` 仍为 `-32001`，`message` 文案可变。
2. 工具级错误新增 `TOKEN_OWNER_PERM_DENIED`、`AUDIT_UNAVAILABLE`。
3. `tools/list` / `resources/list` 只列所有者当前有权限的条目（原来只按令牌级别与白黑名单）。演示库里挂在「采购主管」名下的「演示·业务 Agent」因此看不到出库 / 调拨 / 货权转移——这正是 F07 要收掉的"界面点不动、Agent 能动"。
4. 查询串 / `x-agent-token` / `body.token` 传递的 Agent Token 不再被接受。
5. `PUT /api/auth/users/:id` 返回新增 `agentTokensRevoked`。

## 未做与边界

- 不防直接改库：直接 SQL 改状态会被每次复读挡住，但直接 SQL 改 `role_permissions` 不递增版本——此时权限仍按库里当前值每次生效（验证项 3），只是不会主动吊销令牌。
- 改密 / 退出全部会话 / 角色权限变更只靠版本对照使令牌失效，不改 `agent_tokens.status`；管理员在列表里看到的仍是 `active`，调用时才报 `TOKEN_OWNER_REVOKED`。若需要列表可见，再加"按所有者版本吊销"的展示即可，不改判据。
- 备份恢复会回退 `auth_version`，与 ADR-0004 同样需要轮换或全局吊销。
- F09 中"启动日志输出 Token"在当前树已改为不写日志；通知秘密明文持久化不在本 ADR 范围。

## 验证入口

`node --test tests/mcp-delegation.test.mjs`（`GML_RUNTIME_MODE=test`，临时数据目录 + 随机回环端口，约 25 s）：查询串 / 其他头拒收；基线读写与审计脱敏；直接删权限点后写拒 `TOKEN_OWNER_PERM_DENIED`、读照常、恢复后无需重签；API 改角色权限集 ⇒ 旧令牌 `TOKEN_OWNER_REVOKED`、新令牌按缩减后的权限；所有者改为单组织 ⇒ 令牌范围交集生效（`ORG_OUT_OF_SCOPE`，含"令牌绑仓库组织 ∩ 所有者绑别处 = 空"）；API 停用 ⇒ 全部令牌 `revoked`、业务行不变、不能再签、重新启用不复活；绕过钩子直接改状态 ⇒ `TOKEN_OWNER_INACTIVE`，直接递增版本 ⇒ `TOKEN_OWNER_REVOKED`；审计表触发器注入失败 ⇒ 写回滚、幂等缓存无行、读照常、同键可重试；无主只读令牌仍为独立主体（`SCOPE_DENIED`）。

另需通过：`npm run test:focused`、`npx tsc --noEmit`、`node scripts/check-mcp-coverage.mjs`，以及在全新演示数据目录上运行 `scripts/test-mcp.mjs`、`scripts/test-mcp-purchase.mjs`、`scripts/test-mcp-validation.mjs`。

## 矩阵验收（W5）

`tests/mcp-tool-matrix.test.mjs` 把上面的"代表工具"负向测试扩成**全量矩阵**：对 `tools/list` 枚举出的每一个工具（当前 40 个），用其 `inputSchema` 生成最小合法参数（`*_id` 等业务关联走夹具表，单据类走"当前状态下确有流转边"的真实单据；显式覆盖表只维护 schema 不够的工具），分别在三种所有者状态下调用，并对每一格断言稳定拒绝码与"除 MCP 审计 / 幂等 / 确认单表外，全部业务表行数不变"。矩阵以 JSON 写入测试临时目录并断言覆盖数 == 工具数；新增工具而没有进矩阵会让测试变红。

| 状态 | 做法 | 期望 |
|---|---|---|
| 所有者停用 | 直接改库（绕过吊销钩子） | 40/40 凭据层 `TOKEN_OWNER_INACTIVE` |
| 失去权限 | 只删该工具 `perms` 里的权限点；`perms` 为空的工具撤掉角色全部权限 | 声明了 `perms` 的 27 个：`tools/list` 不再列出，调用 `TOKEN_OWNER_PERM_DENIED`；`perms` 为空的 8 个（7 个采购推进 + `doc.transition`）：边权限实时判（`PERM_DENIED`；签字人用仍有全部权限的超管，证明拒绝来自所有者而非签字人）；另 5 个读工具见下 |
| 范围排除 | 所有者改为一个全新的、无任何数据的单组织 | 写 / 高危工具 `ORG_OUT_OF_SCOPE` 或"越界当作不存在"（`NOT_FOUND` / `DOC_NOT_FOUND` / `ORDER_NOT_FOUND` / `APPROVAL_NOT_FOUND`）；列表类读工具只返回空集；主数据类读工具与 HTTP 同口径不按组织收窄 |

### 矩阵发现并修复的工具级漏洞（`server/mcp/tools.js`）

1. `sales.cancel_order`：没有任何范围判定——列表里看不到的订单，范围受限的所有者经人工确认后仍能作废（实测写入 `doc_events`）。现与 `sales.list_orders` 同一份范围映射（门店 / 经销商 / 发货仓），越界按 `ORDER_NOT_FOUND`。
2. `purchase.create_requisition` / `create_invoice` / `build_settlement` / `create_payment`：归属目标（`org_id`、令牌组织、仓库、门店）全为空时 `assertPurchaseWriteScope` 直接放行，受限所有者可以建出范围内永远看不到的无主单据。现受限范围下"没有任何归属"一律 `ORG_OUT_OF_SCOPE`（fail-closed，与读侧 `AND 1=0` 同口径）。
3. `approval.approve`：只靠确认人的审批身份，不看审批对象是否在调用范围内。现通过 `assertDocInScope` 校验审批实例所挂单据，越界 `APPROVAL_NOT_FOUND`。

4. 采购推进 / 转单 / 收货共 7 个 danger 工具（`perms` 为空）：执行人是确认单签字人，原先只验签字人的权限——所有者被撤权后，别人点确认仍能执行。（Codex 独立审计指出，矩阵最初用"被撤权的所有者自签"掩盖了它。）现 `gatePurchaseEdge` / `assertMcpPerm` 对**所有者当前权限**再判一次，签字人有权限不能替所有者补权限；无主令牌仍不受此门约束。

### 明确记录的边界（矩阵中不是漏判）

- `report.dashboard_kpi` / `org.tree` 没有功能权限点（`perms: []`），与 HTTP 侧同类接口"只要登录、按范围收窄"一致，矩阵里记为 `NO_PERM_POINT`；它们的停用与范围两格照常断言。`doc.list_types` / `doc.query` / `doc.get` 原先同属此列，已由文末「X5 补充」改为按单据类型校验，不再记为 `NO_PERM_POINT`。
- `pricing.update_price` 改的是全局价格主数据，HTTP 的 `master.price.edit` 也只验权限点；范围外状态下它仍执行（矩阵记 `GLOBAL_PARITY`，且只允许改价格表与留痕）。
- （已由文末「Z8 补充」关闭）幂等重放发生在领域范围判定之前：同一令牌、同一幂等键、同一参数的重放会返回**首次执行时**缓存的结果，不会再次写业务行。所有者随后被撤权 / 缩范围时，这一重放仍会回放旧结果（凭据层的停用 / 版本失效 / 权限闸门仍先于重放生效）。矩阵每次调用换新幂等键，以免把"命中缓存"误判成"范围放行"。

## X5 补充：通用单据读工具按单据类型校验所有者查看权限

**缺口**：`doc.list_types` / `doc.query` / `doc.get` 以内核 `doc_types` 驱动，原先 `perms: []`，只受数据范围约束——仓库角色没有 `finance.voucher.view`，HTTP 查不了凭证，委托令牌却能 `doc.get VOUCHER`，违反"令牌能做的事 = 令牌范围 ∩ 所有者当前权限"。

**决定**：
1. 单一映射表 `DOC_VIEW_PERMS`（`server/mcp/doc-perms.js`）：`doc_type → 任一命中即可的权限点`。HTTP 侧有 `requirePerm` 的类型直接取同一码（采购链复用 `PO_READ_PERMS`）；HTTP 侧只有 `requireAuth` 或按角色名闸的类型，按模块「查看」权限点显式钉死（`explicit`，比 HTTP 严，委托不应比本人宽）。
2. `doc.query` / `doc.get`：先取类型，再校验所有者**此刻**权限（`TOKEN_OWNER_PERM_DENIED`，HTTP 403 语义），然后才取行与判范围——权限判定与单据是否存在无关，不构成存在性探测。
3. `doc.list_types`：只返回所有者有权查看的类型（及其动作）；有主令牌一个类型都看不了时直接 `TOKEN_OWNER_PERM_DENIED`。
4. 外部主体：所有者是经销商 / 门店身份时，`INTERNAL_MODULES`（purchase / inventory / produce / outsource / quality / finance，与 docflow、审批入口同一判据）及 oms / dealer 模块的类型一律拒绝，即使被授予了权限点（对应 HTTP 路由整体 `requireInternal`）。
5. 未映射类型 fail-closed：`doc.query` / `doc.get` 报 `DOC_TYPE_UNMAPPED`（对有主与无主令牌都拒绝），`doc.list_types` 不列出；`scripts/check-mcp-coverage.mjs` 的 ②b 节在映射缺类型、含不存在的权限点、含已删除类型、含空权限列表时报红。
6. 无主令牌（独立服务主体）没有所有者可对照，对已映射类型不查权限点（口径同 ADR-0011 既有约定）。
7. 工具本身保持 `perms: []`（`tools/list` 仍可见），类型级判定在 handler 内；`doc.transition` 不变（边权限 `assertEdgePermitted` 已按类型判定）。

**映射表**（`explicit` = HTTP 侧无 `requirePerm`，本表新定）：

| doc_type | 查看权限点 | 来源 |
|---|---|---|
| PRQ / PO / GR / PRT / PI / PST / PAY | purchase.order.view \| purchase.inbound \| purchase.return（`PO_READ_PERMS`，purchase-chain.js `readGate`） | http |
| INS | quality.inspect.view | http（qc.js） |
| QCI / DH / QCR | quality.qc.view | http（qc2.js） |
| SO / DL / SR | sales.order.view | explicit |
| QT | sales.quote.view | http |
| SI | sales.invoice.view | http |
| AR / RCP | finance.receipt.view | http（ar.js） |
| RFD | finance.refund.view | http |
| VOUCHER | finance.voucher.view | http |
| CA | cost.view | http |
| CK / TF / AS | inventory.stock.view | explicit |
| MO / MR | produce.bom.view | http（manufacture.js `P_VIEW`） |
| WW / WM / WR | produce.order.view | explicit |
| OC | order.view | explicit |
| OCS | order.statement.view | http |
| DR / DS / RB | dms.dealer.view | explicit |
| OM | oms.order.view | explicit |
| PS | pos.cashier | explicit |
| PSF | pos.shift | explicit |
| RC | pos.dailyclose | explicit |
| YQ / SH | pos.store.requisition | explicit |

**验收**：`tests/mcp-doc-perms.test.mjs`（映射完整性、逐类型拒绝/放行、权限实时回读、无存在性探测、未映射拒绝、无主令牌）；矩阵"权限移除"状态下这三个工具为 `DENIED` 且错误码精确为 `TOKEN_OWNER_PERM_DENIED`，不再出现 `NO_PERM_POINT`。

**Codex 审计（原文要点）**：映射初版有 4 处 P1——QCI/DH 用了 `quality.inspect.view`（HTTP 为 `quality.qc.view`）、PRQ/PI/PST/PAY 用了单据自己的 view 码（HTTP 为 `PO_READ_PERMS`）、MO/MR 用了 `produce.order.view`（HTTP 为 `produce.bom.view`）、未复刻 `requireInternal` 的外部主体限制。均已修正并补测试。

**已知残余（二审 P1，未修，说明）**：POS（`RC`）与门店要货（`YQ` / `SH`）的 HTTP 路由除权限点外还有按角色名 / 门店绑定的闸（`pos.js` 门店绑定或 HQ 角色、`requisitions.js` `requireRole(...HQ)`）。MCP 这里只复刻"权限点 + 内部/外部主体 + 实体范围"，不复刻按角色名的闸：角色名闸是旧机制，权限点矩阵才是委托口径（"令牌 ≤ 所有者权限点"），且受限所有者的门店 / 组织范围仍由 `scopeEntityIds` 收窄。无门店绑定又 `data_scope=all` 的所有者拿到 `pos.dailyclose` 即可读日结单，属于权限点授予过宽的配置问题，后续由角色权限收口（X 系列）统一处理，而非在 MCP 层再造第二套角色名判据。

**产品影响**：此前依赖 AI 令牌读取其角色无权查看的单据类型的集成会开始被拒绝；需要为该角色补授上表对应权限点。

## Y6 补充：门店 / 经销商 / 订货主体绑定（关闭 X5 的残余）

**缺口**：X5 只复刻"权限点 + 内部/外部主体 + 实体范围"。POS（PS/PSF/RC）、门店要货（YQ/SH）、经销商要货（DR）、订货中心（OC/OCS）的 HTTP 路由除权限点外还按**账号绑定**（`users.store_id` / `dealer_id`，ADR-0025 的 `requireStore` + `storeCtx`；`demand.js` 的 `dealerCtx`；`order-center.js` 的 `selfCustomerId` / `ocAccessCheck`）限定"只能看自己门店 / 自己经销商 / 自己订货主体的单据"。MCP 令牌的所有者即使没有任何绑定（`data_scope=all`、授予了 `pos.dailyclose` 之类权限点），也能经 `doc.query` / `doc.get` 读到**全部门店**的日结 / 要货 / 发货单。

**决定**（`server/mcp/doc-perms.js` 单一声明，`DOC_VIEW_PERMS[type].binding` + `bindCol`）：

| doc_type | binding | 归属列 | HTTP 依据 |
|---|---|---|---|
| PS（pos_orders）/ PSF（pos_shifts）/ RC（pos_daily_closes） | store | `store_id` | pos.js `requireStore` + `storeCtx`；跨店一律 404（ADR-0025） |
| YQ（store_requisitions）/ SH（store_shipments） | store | `store_id` | requisitions.js `storeCtx`；`head.store_id !== store.id` 403 |
| DR（dealer_requisitions） | dealer | `dealer_id` | demand.js `dealerCtx`（`WHERE dr.dealer_id=?`） |
| OC（oc_orders）/ OCS（oc_statements） | subject | `customer_id` | order-center.js：role=dealer 取经销商档案、role=store 取门店档案，对应 `oc_customers(source_type,source_id)`；内部账号走组织范围 |
| DS（dealer_statements）/ RB（dealer_rebates） | **不绑定** | — | dealers.js / dms.js 整体 `requireInternal` 的总部读，没有"经销商自视图"可绑；外部主体已被 X5 的 `dealer` 模块闸挡住（经销商看自己的对账走 OCS） |

**判定**（每次调用回库读 `users`）：
1. **豁免**：超管 / admin 所有者（`permContext.isSuper`，HTTP 侧 admin 不受绑定约束）与无主令牌（没有所有者可对照，ADR-0011 既有约定）。
2. **类型级**：其余所有者必须具备该类型要求的绑定（store → `store_id`；dealer → `dealer_id`；subject → 仅外部主体：role=dealer 需 `dealer_id`、role=store 需 `store_id`，内部账号不要求）。缺则 `doc.query` / `doc.get` 报 `TOKEN_OWNER_BINDING_REQUIRED`（403），`doc.list_types` 不列出该类型。该判定先于取行，与单据是否存在无关（无存在性探测）。
3. **单据级**：`doc.query` 把 `col = 所有者绑定` 下推进 SQL（subject 为 `customer_id IN (绑定档案)`），`limit` 准确；`doc.get` 取行后不属于绑定对象一律 `NOT_FOUND`（与"不存在"同形，不泄露存在性）。归属列取不到 ⇒ 拒绝（fail-closed）。叠加原有的令牌组织范围，二者取交集。
4. 顺序：类型权限点（`TOKEN_OWNER_PERM_DENIED`）→ 绑定（`TOKEN_OWNER_BINDING_REQUIRED`）→ 取行 → 范围 / 绑定行级（`NOT_FOUND`）。

**有意比 HTTP 严的一点（需知悉）**：HTTP 侧总部角色（`HQ_ROLES` / `HQ`，按角色名）可经 `/hq/*`、`requireRole(HQ)` 路由跨店读 POS / 要货 / 发货 / 经销商要货。MCP 不复刻角色名闸（X5 已说明），所以**非 admin 的总部角色所有者没有门店 / 经销商绑定时，读这些类型会被拒绝**；需要总部跨店读取的集成应使用 admin 所有者的令牌，或为所有者账号绑定具体门店 / 经销商。这是 fail-closed 的取舍，比 X5 时"权限点授予过宽即可读全部门店"的残余更安全。

**验收**：`tests/mcp-doc-perms.test.mjs`（绑定表与归属列存在；无绑定逐类型 query/get/不存在 id 均 `TOKEN_OWNER_BINDING_REQUIRED` 且 list_types 隐藏；门店 / 经销商 / 订货主体绑定后只见本方、他方 `NOT_FOUND`、改绑 / 撤绑下一次调用即生效；admin 与无主令牌豁免；缺权限点仍为 `TOKEN_OWNER_PERM_DENIED`）；`tests/mcp-tool-matrix.test.mjs` 新增第 4 态 `owner_lacks_binding`（所有门店 / 经销商绑定类型 × query/get/list_types，写入矩阵 JSON 的 `binding_state`）；`scripts/check-mcp-coverage.mjs` ②b 增加绑定声明合法性与读工具已接入绑定闸的检查。

**产品影响**：此前用"无绑定的非 admin 所有者"令牌读 POS / 要货 / 发货 / 日结 / 经销商要货 / 订货中心（外部主体）单据的集成会开始被拒绝；需为所有者账号绑定门店 / 经销商，或改用 admin 所有者令牌。

## Z8 补充：幂等缓存 / 二次确认命中前重验（关闭「矩阵验收」节记录的重放残余）

**缺口**：同令牌、同幂等键、同参数的重放命中 `mcp_idempotency` 后直接回放首次结果；凭据 / 级别 / 所有者权限点的闸门其实已在缓存查询之前重跑（失权时本来就返回当前错误），但工具在 handler 里做的**领域数据范围判定**（`ORG_OUT_OF_SCOPE` 等）不会被触达——所有者被缩范围后，旧结果仍被回放。

**决定**（只动 `server/mcp/server.js` 的幂等分支与 `delegation.js` 的两个纯函数，不碰 `tools.js`）：
1. **范围快照**：首次成功执行时，缓存行 `result_json` 写成 `{"__replay":1,"scope":{scope,orgIds},"data":…}`（首次执行的有效范围 = 令牌范围 ∩ 所有者当时范围）。无迁移、无新列；读取时兼容 Z8 之前的裸 data 行（范围记为未知）。
2. **命中前重验**：`scopeCovers(当前有效范围, 快照)`——当前不受限则放行；快照未知（旧行）或快照不受限而当前受限则拒；其余要求快照的组织集合是当前集合的子集。不覆盖 ⇒ 返回当前错误 `ORG_OUT_OF_SCOPE`，**不回放缓存**，也不进 handler。覆盖 ⇒ 缓存原样回放（`_idempotent_replay: true`，结果不变）。
3. **权限快照（Codex 审计 P1）**：`perms: []` 的工具（目前仅 `doc.transition`，权限点在 handler 内按边判）命中缓存时进不了 handler，因此缓存同时记下首次执行时所有者的权限集合，重放要求当前集合不少于它，否则 `TOKEN_OWNER_PERM_DENIED` + `cache_denied`；声明了 `perms` 的工具仍由 `ownerToolDenied` 精确重判。
4. **不重跑 handler**：重验是纯比较，没有任何业务写入，因此不可能重复过账；业务过账、缓存、确认消费、严格审计仍在原来那一个事务里。代价是偏保守：范围缩小但仍包含首次目标时重放也会被拒——被拒时错误信息要求先查询核对、不要换键重提（首次调用已提交，换键会重复执行）。
5. **审计标记**：凡是"本可命中缓存 / 确认单却被当前闸门挡下"的拒绝，`mcp_call_logs.result_summary` 以 `cache_denied` 开头（含幂等键列），`error_code` 为当前错误码（`TOKEN_OWNER_PERM_DENIED`、`SCOPE_DENIED`、`TOKEN_OWNER_*`、`ORG_OUT_OF_SCOPE`…）。旧行（Z8 前）在受限范围下一律不回放（fail-closed），不受限范围照常回放。
6. **二次确认**：确认单不是结果缓存——`used` 的确认单永远 `CONFIRM_NOT_APPROVED`，不会重复执行。`confirmed` 但未使用的确认单在使用时与其他调用同样重跑全部闸门（权限点在前、领域范围在 handler 内），被挡下时事务回滚、确认单保持 `confirmed`、审计带 `cache_denied`；闸门恢复后恰好执行一次。

**验收**：`tests/mcp-delegation.test.mjs` 新增五条（失权后重放返回 `TOKEN_OWNER_PERM_DENIED` + `cache_denied` + 业务行不变、恢复后回放缓存且不新增行；范围缩小后重放 `ORG_OUT_OF_SCOPE`；旧缓存行受限范围下 fail-closed；他令牌复用键仍 `IDEMPOTENCY_CONFLICT`；确认单失权 / 缩范围保持未消费、恢复后恰好执行一次、用过的不再执行）。`tests/mcp-tool-matrix.test.mjs` 增加 `replay_after_permission_loss` 状态：对每个首次成功的写型工具，用同一幂等键依次在"权限被撤""范围被缩""全部恢复"下重放，断言前两格得到当前错误、不带 `_idempotent_replay`、业务表行数不变，第三格回放缓存且行数不变。

**契约变化**：范围缩小后的幂等重放由"回放旧结果"变为 `ORG_OUT_OF_SCOPE`；`mcp_idempotency.result_json` 的内部格式带了范围快照（只被 `server.js` 读写）。

## AB7 补充：RC / YQ / SH 的门店绑定进入 DOC_SCOPE_RESOLVERS（与 HTTP 同一判据）

**缺口**：Y6 把门店 / 经销商绑定写在 `doc-perms.js` 一处（`bindingWhere` / `rowInBinding`），而 `DOC_SCOPE_RESOLVERS`（`/api/docflow/*`、`doc.get` / `doc.query` / `order.trace_document` 共用的范围注册表）对 RC（日结）/ YQ（门店要货）/ SH（门店发货）只按组织范围收口：账号绑了门店、`data_scope=all` 的非 admin 用户在注册表眼里是"全局范围"，别家门店的这三类单据（及其流转留痕）不会被挡。绑定因此只靠 MCP 读工具各自再调一次 `rowInBinding`，新增读路径漏调就泄露。

**决定**：
1. **判据单点**：新增 `server/lib/store-binding.js`（`boundStoreId(user)`、`storeBindingExempt(user)`，纯函数、不碰库、不拼 SQL）。POS 路由 `storeCtx`、门店要货路由 `storeCtx`、注册表的 `store` 构建器都调它；SQL 谓词仍只在 `docflow.js` 的 `store` 构建器里有一份（`t.store_id = 绑定门店`），没有复制。
2. **注册表声明**：`DOC_SCOPE_RESOLVERS` 的 RC / YQ / SH 行加 `binding: 'store'`。`docScopeOf` 对带 `binding` 的类型在**任何数据范围（含 all）**下先过绑定闸：admin 与无主上下文豁免（HTTP `requireStore` 对 admin 放行）；已绑门店 ⇒ 谓词收窄到本店；`docEventScope` 在全局范围下对被收窄的类型改为按谓词过滤、其余类型照旧整类放行。`doc.get` / `doc.query` / `order.trace_document` 的范围上下文统一为 `docScopeCtx`（`doc.get` 原来手写了一份），自动生效，各工具 handler 其余部分不动。
3. **未绑门店 = 严格模式**：HTTP 对未绑门店的总部角色按**角色名**放行（`HQ_ROLES` / `HQ`），MCP 仍不复刻角色名（见 Y6 "有意比 HTTP 严"）。注册表上下文带 `strictBinding: true`（仅 MCP 的 `docScopeCtx` 设置）时，未绑门店的非 admin 所有者在这三类上**整类不可见**（`docScopeOf` 返回 null，`docInScope` 为 false）；`/api/docflow/*` 不设该标志，行为不变（除第 2 点的"已绑门店 + 全局范围"收窄）。
4. **与 Y6 的关系**：`doc-perms.js` 的类型级 `TOKEN_OWNER_BINDING_REQUIRED` 与 `rowInBinding` 保留（错误码与 `doc.list_types` 隐藏仍由它负责），注册表是第二道、且是 `/api/docflow` 也共用的一道；`check-mcp-coverage` 校验两处声明不漂移。

**HTTP 行为变化（需知悉）**：`/api/docflow/{events,overview,history,trace}` 对"绑了门店的非 admin 账号 + `data_scope=all`"不再放行别家门店的 RC / YQ / SH 单据与留痕；此前该组合在注册表层面等同全局范围。未绑门店的总部角色不受影响。

**仍无绑定规则的类型（残余）**：PS / PSF 的 `store` 构建器已按 `ctx.user.store_id` 在受限范围内收窄，但全局范围下尚未带 `binding` 标记（读工具仍由 Y6 的 `rowInBinding` 挡住）；DR（经销商）、OC / OCS（订货主体）、DS / RB（无自视图）未并入注册表绑定。后续如要把它们并入，沿用同一个 `binding` 字段与 `strictBinding` 约定。

**验收**：`tests/mcp-doc-perms.test.mjs` 的 AB7 用例——三类 × {未绑定、绑本店、绑他店（改绑即时生效）、admin 所有者、无主令牌}：未绑 ⇒ query / get 为 `TOKEN_OWNER_BINDING_REQUIRED`、`order.trace_document` 与注册表 `docInScope` 为不可见；绑定 ⇒ 只见本店、他店 `NOT_FOUND`（get 与 trace）；全程业务表 / `audit_logs` / `doc_events` / 幂等 / 确认表行数不变（零写）；注册表单测覆盖 `data_scope=all` 的绑定收窄、admin 豁免、非严格模式保持 HTTP 角色名口径。`scripts/check-mcp-coverage.mjs` 增三项检查。
