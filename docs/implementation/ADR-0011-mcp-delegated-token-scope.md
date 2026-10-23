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
| 失去权限 | 只删该工具 `perms` 里的权限点；`perms` 为空的工具撤掉角色全部权限 | 声明了 `perms` 的 27 个：`tools/list` 不再列出，调用 `TOKEN_OWNER_PERM_DENIED`；`perms` 为空的 8 个（7 个采购推进 + `doc.transition`）：边权限实时判（`PERM_DENIED`，执行人 = 确认单签字人，用"被撤权的所有者"做签字人来证明）；另 5 个读工具见下 |
| 范围排除 | 所有者改为一个全新的、无任何数据的单组织 | 写 / 高危工具 `ORG_OUT_OF_SCOPE` 或"越界当作不存在"（`NOT_FOUND` / `DOC_NOT_FOUND` / `ORDER_NOT_FOUND` / `APPROVAL_NOT_FOUND`）；列表类读工具只返回空集；主数据类读工具与 HTTP 同口径不按组织收窄 |

### 矩阵发现并修复的工具级漏洞（`server/mcp/tools.js`）

1. `sales.cancel_order`：没有任何范围判定——列表里看不到的订单，范围受限的所有者经人工确认后仍能作废（实测写入 `doc_events`）。现与 `sales.list_orders` 同一份范围映射（门店 / 经销商 / 发货仓），越界按 `ORDER_NOT_FOUND`。
2. `purchase.create_requisition` / `create_invoice` / `build_settlement` / `create_payment`：归属目标（`org_id`、令牌组织、仓库、门店）全为空时 `assertPurchaseWriteScope` 直接放行，受限所有者可以建出范围内永远看不到的无主单据。现受限范围下"没有任何归属"一律 `ORG_OUT_OF_SCOPE`（fail-closed，与读侧 `AND 1=0` 同口径）。
3. `approval.approve`：只靠确认人的审批身份，不看审批对象是否在调用范围内。现通过 `assertDocInScope` 校验审批实例所挂单据，越界 `APPROVAL_NOT_FOUND`。

### 明确记录的边界（矩阵中不是漏判）

- `report.dashboard_kpi` / `org.tree` / `doc.list_types` / `doc.query` / `doc.get` 没有功能权限点（`perms: []`），与 HTTP 侧同类接口"只要登录、按范围收窄"一致，矩阵里记为 `NO_PERM_POINT`；它们的停用与范围两格照常断言。若要给通用单据读工具加按类型的查看权限点，是新的产品决定，不在本次验收内。
- `pricing.update_price` 改的是全局价格主数据，HTTP 的 `master.price.edit` 也只验权限点；范围外状态下它仍执行（矩阵记 `GLOBAL_PARITY`，且只允许改价格表与留痕）。
- 幂等重放发生在领域范围判定之前：同一令牌、同一幂等键、同一参数的重放会返回**首次执行时**缓存的结果，不会再次写业务行。所有者随后被撤权 / 缩范围时，这一重放仍会回放旧结果（凭据层的停用 / 版本失效 / 权限闸门仍先于重放生效）。矩阵每次调用换新幂等键，以免把"命中缓存"误判成"范围放行"。
