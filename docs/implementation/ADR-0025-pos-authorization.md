# ADR-0025：门店 POS 路由按动作授权、跨店 404、交班核款二人分离

日期：2026-10-23。关联路线图 v3 的 X1 与路由授权守卫（ADR-0021）里 `pos.js` 的 19 条"待评估"登记。

## 问题

`server/routes/pos.js` 的 19 条读写路由只有 `requireAuth` + 处理器里的 `storeCtx`（要求账号绑了 `store_id`）。结果是任何绑定门店的账号都能：核款与退回交班、接收与取消缴款、查看任何班次详情；而且核款 / 退回 / 接收缴款 / 取消缴款**没有核对单据属于本店** —— 门店 A 的账号拿到门店 B 的班次号就能核款。核款人与开班人 / 报数人可以是同一个人，"店长数钱"这道复核形同虚设。

## 决定

### 一、每条门店路由 = `requireAuth` + `requireStore()` + `requirePerm(动作权限点)`

`requireStore()` 仍只放行 `store` 角色和 `admin`；`requirePerm` 校验权限点（admin / 超管恒真）。权限点沿用 005 / 024 已登记的字典项，**不另造同义词**，只补两处缺口：

| 权限点 | 覆盖的路由 |
|---|---|
| `pos.view`（新） | 全部门店读接口：`/context`、`/products`、`/orders`、`/orders/:id`、`/shifts`、`/shifts/open`、`/shifts/:id`、`/cash-drops`、`/cash-drops/pending-shifts`、`/daily-closes`、`/returns`、`/stock-checks`、`/stock-checks/:id` |
| `pos.store.stock` | `GET /stocks` |
| `pos.cashier` | `POST /orders`、`POST /quote` |
| `pos.refund` | `POST /orders/:id/void`、`POST /returns` |
| `pos.shift` | `POST /shifts/open`、`/shifts/:id/declare`、`/shifts/close`、`/shifts/:id/cancel` |
| `pos.shift.review` | `POST /shifts/:id/approve`、`/shifts/:id/reject` |
| `pos.cashdrop` | `POST /cash-drops`、`/cash-drops/:id/cancel` |
| `pos.cashdrop.receive`（新） | `POST /cash-drops/:id/receive`（交钱与收钱是两个动作，分开授权） |
| `pos.dailyclose` | `POST /daily-close` |
| `pos.store.check` | `POST /stock-checks`、`PUT /stock-checks/:id/items`、`POST /stock-checks/:id/adjust` |

总部侧 `/hq/*` 与 `POST /daily-closes/:id/confirm` 沿用原有 `requireRole(HQ_ROLES)`，`POST /shifts/:id/settle-variance` 沿用 `requireRole('admin','finance')`，不在本条改动内。

### 二、迁移 058（`058_pos_permissions.cjs`）

写入 `pos.view`、`pos.cashdrop.receive` 两个字典项；授予 `admin` 与内置 `store`（店长）角色这两项，并补上 024 当年漏给 `store` 的 `pos.cashdrop`（否则门店账号接上权限闸后发起不了缴款）。其他内置角色不授予。授权只在 `up()` 首次执行时给，`verify()` 只查字典，不查授权集合（ADR-0007）：管理员事后削减 `store` 角色的授权，正常重启不会被恢复 —— 测试里实际削减后连跑两次迁移检查来证明。

内置角色里只有一个 `store`（店长，本店收银 / 库存 / 要货），没有单独的"店员"角色，所以日常权限与审批权限目前都给了它。要把店员和店长分开，需要管理员建一个只带日常权限的自定义角色（不含 `pos.shift.review` / `pos.cashdrop.receive`）；自审拒绝（下一节）保证即使同一角色里也不是同一个人批自己的班。

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
