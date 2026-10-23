# ADR-0015：待办接口按权限与范围收口；Agent Token 列表报告有效状态

日期：2026-10-22。收口 ADR-0008「相关但不在范围内」与 ADR-0011「未做与边界」各一条：`/api/purchase/chain/todos`、`/api/approval/todos` 只 `requireAuth`；所有者 `auth_version` 变化后的有主令牌在列表里仍显示 `active`。状态：开发实现，尚非产品上线验收。

## 决定一：两个待办接口与对应页面同一道门，内容按调用者收窄

| 接口 | 门（任一不过即 403） | 内容 | 范围为空时 |
|---|---|---|---|
| `GET /api/purchase/chain/todos` | `requireInternal`（dealer / store 403）→ `requirePerm(...PO_READ_PERMS)`（与采购订单读接口**同一份**清单，现由 `lib/purchase.js` 导出） | 请购 / 发票 / 结算 / 付款按自身 `org_id`、采购订单按 `warehouses.org_id` 过滤到调用者 `resolveOrgScope` 的组织集合；再按每条待办声明的动作权限 `perm` 过滤（看得到却点不动的不算待办） | **200 + 空列表**。`dealer` / `none` / 无组织归属的 `org`/`subtree` 账号，以及归属列为 NULL 的单据，一律不可见（与 `orgScopeFilter` 同口径：空范围不许变成全库） |
| `GET /api/approval/todos` | 路由级 `requireInternal` → `requirePerm(system:approval:view \| decide \| manage)`（与审批中心菜单同一组权限点） | 只统计 `pendingInstancesFor` 认为调用者能处理的 pending 实例：admin / 超管 / 持 `system:approval:manage` 全见，其余只保留当前级指到本人（用户 / 角色 / 权限点，判据 `canApproveStep`）的实例；响应多一个 `scope: 'mine'` | **200 + `count: 0`**（例如只有 `system:approval:view` 的仓管、访客） |

为什么这两处选"按范围缩小"而不是 ADR-0008 的 403：采购后段四张单有 `org_id`，采购订单可经仓库取组织，审批实例有"当前级审批人"——都能**诚实**地算出"我的那一份"。ADR-0008 的通知摘要仍是全库口径（`purchaseTodos(db)` 不传范围、`approvalTodos`），由其 `requireGlobalData` 把守，本 ADR 不改它。

「待我审批」列表（`pendingForMe`）与审批待办现在共用 `pendingInstancesFor`，顺带让持 `system:approval:manage` 的非 admin 账号在「待我审批」里也全见（原来只有 admin）。

行为变化：内置 `purchase` 角色默认 `subtree` 范围且演示账号无组织归属 ⇒ 升级后采购工作台待办为空，需管理员给账号挂组织或设 `data_scope=all`；与 ADR-0008 的 F05 同属"收口的直接后果，不是回归"。

## 决定二：令牌列表 / 详情报告 `effective_status`，清扫让行状态追上现状，调用判据不变

- 迁移 `055_agent_token_revoke_reason.cjs`：`agent_tokens` 增 `revoked_reason`（稳定码 `admin` / `owner_inactive` / `owner_auth_changed` / `owner_missing`）与 `revoked_at`；存量 `revoked` 行原因未知，保持 NULL。054 预留给并行的授信冻结分支。
- `GET /api/mcp/tokens`、新增 `GET /api/mcp/tokens/{id}`：每行带 `effective_status`（`active` / `revoked` / `expired` / `owner_missing` / `owner_inactive` / `revoked_by_owner_change`）、`effective_reason`、`revoked_reason`、`revoked_at`、`owner_user_id` / `owner_username` / `owner_name` / `owner_auth_version`。`status` 是行历史，读路径**不改库**。判定顺序与调用路径一致（令牌自身 → 所有者存在 → active → 版本对照），实现为 `effectiveTokenStatus`（纯函数）。
- 新增 `POST /api/mcp/tokens/sweep`（`system.mcp.manage`，幂等）：把行仍 `active` 但 `effective_status` 为 `revoked_by_owner_change` / `owner_missing` 的令牌置 `revoked`，记原因与时间，`remark` 追加"由谁清扫"。停用联动吊销（ADR-0011）与管理员吊销也写原因。过期令牌不改写（`expires_at` 本身就是事实）。
- **每次调用仍以 `delegation.js` 为准**：清扫前旧令牌报 `TOKEN_OWNER_REVOKED`，清扫后报凭据层 `TOKEN_REVOKED`；两者都拒，只是层次不同。不做自动清扫：读接口不该有副作用，定时任务另行决定。
- 前端 `src/pages/system/McpCenter.tsx`「人工确认与审计」页新增令牌表：状态 / 有效状态两列并列，清扫按钮只在有可清扫行时可用，吊销走既有 `DELETE`。

## 契约变化

1. `/api/purchase/chain/todos`、`/api/approval/todos` 新增 403；后者响应增 `scope`。
2. `/api/mcp/tokens` 列表字段增 `effective_status` / `effective_reason` / `revoked_reason` / `revoked_at` / `owner_*`；新增 `GET /api/mcp/tokens/{id}`、`POST /api/mcp/tokens/sweep`；`POST /api/mcp/tokens`、`DELETE /api/mcp/tokens/{id}` 补登记进 OpenAPI（此前路由存在但契约未登记）。OpenAPI 版本 1.31.0 → 1.32.0。

## 边界

- `/api/purchase/chain/overview`、`/chain/flow`、后段四张单的列表接口仍只 `requireAuth`，与本 ADR 同族，未在本批处理。
- 审批待办不含"我提交的、正在等别人批"的实例；提交人看自己的进度走 `GET /api/approval/instances?mine=1`。
- 备份恢复回退 `auth_version` 后，已清扫的令牌不会复活（行状态已落库）；未清扫的会重新显示 `active`，与 ADR-0004 / 0011 同样需要轮换或全局吊销。

## 验证入口

`node --test tests/authz-followups.test.mjs`（test 运行时、临时数据目录、随机回环端口）：采购待办对 store / dealer / sales 403、未登录 401、admin 全库、A/B 组织账号各见各的（订单经仓库组织、NULL 归属不可见）、无组织的受限账号空列表、viewer 进门但空、warehouse 只见"待到货"；审批待办 admin 3 / 审批人各见自己的 2 与 1 / 持 manage 的 sales 3 / 仓管 0 / store、dealer 403 / 拿掉 viewer 的权限点后 403；令牌签发 → 列表 `active` → 所有者改密 → 列表与详情 `revoked_by_owner_change`、行仍 `active`、调用 `TOKEN_OWNER_REVOKED` → 清扫 `swept:1` 且幂等、行 `revoked` / `owner_auth_changed`、调用 `TOKEN_REVOKED` → 重签可用 → 管理员吊销记 `admin` → 过期 `expired`、绕过 API 停用 `owner_inactive` → 非管理员清扫 / 列表 403。

另需通过：`npm run test:focused`、`npx tsc --noEmit`、`node scripts/check-file-header.mjs`、`node scripts/check-api-contract.mjs`、`node scripts/check-mcp-coverage.mjs`，以及全新演示目录上的 `scripts/test-mcp.mjs`、`scripts/test-mcp-purchase.mjs cosmetic`。Mac mini Node 22 本地验证，不等于目标平台验收。
