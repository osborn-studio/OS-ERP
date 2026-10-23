# ADR-0025：门店 POS 路由按动作授权、跨店 404、交班核款二人分离

日期：2026-10-23。关联路线图 v3 的 X1 与路由授权守卫（ADR-0021）里 `pos.js` 的 19 条"待评估"登记。

## 问题

`server/routes/pos.js` 的 19 条读写路由只有 `requireAuth` + 处理器里的 `storeCtx`（要求账号绑了 `store_id`）。结果是任何绑定门店的账号都能：核款与退回交班、接收与取消缴款、查看任何班次详情；而且核款 / 退回 / 接收缴款 / 取消缴款**没有核对单据属于本店** —— 门店 A 的账号拿到门店 B 的班次号就能核款。核款人与开班人 / 报数人可以是同一个人，"店长数钱"这道复核形同虚设。

## 决定

### 一、每条门店路由 = `requireAuth` + `requireStore()` + `requirePerm(动作权限点)`

`requireStore()` 放行 `admin` 与**绑定了门店**（`store_id`）的账号，不再硬编码 `role==='store'`（独立审计 P2：否则只带日常权限的自定义角色用不了 POS）；真正的闸是紧随其后的 `requirePerm` 权限点（admin / 超管恒真）。未绑门店且非 admin 一律 403。权限点沿用 005 / 024 已登记的字典项，**不另造同义词**，只补两处缺口：

| 权限点 | 覆盖的路由 |
|---|---|
| `pos.view`（新） | 全部门店读接口：`/context`、`/products`、`/orders`、`/orders/:id`、`/shifts`、`/shifts/open`、`/shifts/:id`、`/cash-drops`、`/cash-drops/pending-shifts`、`/daily-closes`、`/returns`、`/stock-checks`、`/stock-checks/:id` |
| `pos.store.stock` | `GET /stocks` |
| `pos.cashier` | `POST /orders`、`POST /quote` |
| `pos.refund` | `POST /orders/:id/void`、`POST /returns` |
| `pos.shift` | `POST /shifts/open`、`/shifts/:id/declare`、`/shifts/close`、`/shifts/:id/cancel`（取消**已报数**的班次另需 `pos.shift.review`，因为状态机上这条边要核款权限而 `advanceStatus` 不校验边权限） |
| `pos.shift.review` | `POST /shifts/:id/approve`、`/shifts/:id/reject` |
| `pos.cashdrop` | `POST /cash-drops`、`/cash-drops/:id/cancel` |
| `pos.cashdrop.receive`（新） | `POST /cash-drops/:id/receive`（交钱与收钱是两个动作，分开授权） |
| `pos.dailyclose` | `POST /daily-close` |
| `pos.store.check` | `POST /stock-checks`、`PUT /stock-checks/:id/items`、`POST /stock-checks/:id/adjust` |

总部侧 `/hq/*` 与 `POST /daily-closes/:id/confirm` 沿用原有 `requireRole(HQ_ROLES)`，`POST /shifts/:id/settle-variance` 沿用 `requireRole('admin','finance')`，不在本条改动内。

### 二、迁移 058（`058_pos_permissions.cjs`）

写入 `pos.view`、`pos.cashdrop.receive` 两个字典项；授予 `admin` 与内置 `store`（店长）角色这两项，并补上 024 当年漏给 `store` 的 `pos.cashdrop`（否则门店账号接上权限闸后发起不了缴款）。其他内置角色不授予。授权只在 `up()` 首次执行时给，`verify()` 只查字典，不查授权集合（ADR-0007）：管理员事后削减 `store` 角色的授权，正常重启不会被恢复 —— 测试里实际削减后连跑两次迁移检查来证明。

内置角色里只有一个 `store`（店长，本店收银 / 库存 / 要货），没有单独的"店员"角色，所以日常权限与审批权限目前都给了它。要把店员和店长分开，需要管理员建一个只带日常权限的自定义角色（不含 `pos.shift.review` / `pos.cashdrop.receive`），并把店员账号的主角色设为它（主角色仍是 `store` 会继承 `store` 的全部授权）；自审拒绝（下一节）保证即使同一角色里也不是同一个人批自己的班。

### 三、跨店一律 404

核款 / 退回 / 报数 / 作废班次 / 接收缴款 / 取消缴款都先核对单据属于账号绑定的门店，不属于就返回 404（`SHIFT_NOT_FOUND` / `DROP_NOT_FOUND`，文案与"真的不存在"相同，不泄露存在性），不改任何状态。`GET /shifts/:id` 同理：门店账号看别家班次 404（原来是 403）；绑定了门店的 admin 保留跨店只读（总部可代查），但写操作仍限本店。原来 `assertShiftOfStore` 返回的 403 `SHIFT_STORE_MISMATCH` 改为 404。

### 四、交班核款 / 退回的二人分离（`POS_SELF_APPROVE`）

沿用 ADR-0018 的自审拒绝思路，判据只有一处：`lib/pos2.js` 的 `assertShiftChecker`。"做账的人"= 班次的 `cashier_id`（开班人）+ `doc_events` 里该班次 `open` / `declare` 事件的 actor（含代他人报数的人）；核款 / 退回的操作者在其中 → 409 `POS_SELF_APPROVE`，不改任何状态。历史班次只有名字没有 id 时按名字兜底。admin 不豁免。

`approveShift` / `rejectShift` 新增选项 `separateChecker`，**只有路由传 `true`**。种子（`pos-seed.js`、`demo-seed.js`）与 `scripts/test-pos2.mjs` 直接调库函数，用同一个 `req` 走完全程，那是造数 / 流程口径测试，不是授权问题；若默认开启会让这些调用全部 409。代价：库函数本身不强制二人分离，新增的调用方必须显式传参，评审时要看。

## 守卫登记

`scripts/check-route-authz.mjs` 删除 `pos.js` 的 19 条待评估登记（现在全部有 `requireStore` + `requirePerm`，守卫的"过期登记"检查会对遗留条目报红）。

## 已知边界（未在本条处理）

- `storeCtx` 对未绑定门店的 admin 仍返回 403：admin 要用门店 POS 路由必须账号绑定 `store_id`（演示口径）；总部监控走 `/hq/*`。
- 前端 POS 页面未做按权限点隐藏按钮；无权限时用户点击会得到 403 提示。
- `/shifts?all=1&store_id=` 对 HQ_ROLES 的跨店列表读取保持原样（现在只有 `admin` 能通过 `requireStore` 走到这里）。
- 接收缴款的"缴款人≠接收人"（`SAME_PERSON`，400）保持原状。

## 验证

`tests/pos-authz.test.mjs`：迁移字典与授权（含削减后不恢复）；31 条路由逐权限点"撤权 403 / 恢复不再 403"；非门店角色 403；跨店 6 种写 + 1 种读均 404 且状态不变；开班人 / 报数人 / 名字兜底 / admin 自批 409，另一人 200；绑定门店的 admin 正常。

## 补充（AA9，路线图 v6）：作废订单与差异结案的权限点、前端按权限显示

日期：2026-10-23。

- **作废订单**：`POST /api/pos/orders/:id/void` 服务端早已是 `requireStore()` + `requirePerm('pos.refund')`（见上表，`voidPosOrder` 是该路径唯一入口），本条补的是前端：`src/utils/pos-actions.ts` 新增 `order_void`（需 `pos.refund`），POS 本机单据列表的"作废"按钮无权限即隐藏（权限未加载也隐藏）。
- **差异结案**：`POST /api/pos/shifts/:id/settle-variance` 由 `requireRole('admin','finance')` 改为 `requirePerm('pos.shift.settle')`。迁移 066（`066_pos_settle_permission.cjs`）登记该权限点，**首次出现时**授予 `admin`、内置 `finance`（原按角色名放行者，保持其既有能力）与内置 `store`（店长，v6 AA9 指定）；`verify()` 只查字典，管理员事后削减不被恢复（ADR-0007）。063~065 由并行工作流占用，运行器按文件名排序，缺号无影响。
- **范围**：原路由借用 `storeCtx`，无门店绑定的 admin / finance 反而 403；现在不再要求门店绑定。为避免 `store` 角色获得该权限后能结别家门店的班次，绑了门店的非 admin 账号按 `assertShiftOfStore` 只能结本店班次，别家 404（`SHIFT_NOT_FOUND`，状态不动）；无门店绑定的总部账号持权限可结任意门店。`lib/pos2.js` 的 `settleVariance` 本身没有角色判断（库函数供种子与流程测试直接调用），闸只在路由，与 `separateChecker` 同口径。
- **前端**：`variance_settle`（需 `pos.shift.settle`）门控班次详情里的"长短款落案"与总部监控页的"责任人承担 / 公司承担"按钮。
- **已知边界**：持有 `pos.shift.settle` 的 `store` 账号可结案本店挂账差异，其中包括自己核款时选择"挂账待查"的那一笔——这是 v6 AA9 指定的授予范围；若要保持"门店挂账、总部落案"，管理员应从 `store` 角色收回该权限点。
- **验证**：`tests/pos-authz.test.mjs` 迁移 066（字典、授权、削减后不恢复）、撤权后 403 且状态不动、跨店 404、同店 200、总部 finance 200、无权限 sales 403、撤 `pos.refund` 后作废 403；`tests/pos-actions.test.mjs` 两个新选择器键。
