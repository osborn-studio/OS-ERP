# ADR-0057：指标按业务查看权限过滤，受限范围默认隐藏无范围语义的指标（AE1）

日期：2026-10-24。收口 ADR-0053（AD1）Codex 审计留下的两条 open 高项（roadmap-v10 AE1）。状态：开发实现，尚非产品上线验收。

## 问题

- `/api/metrics`、`/values`、`/catalog` 只要求 `system:metrics:view`，没有逐指标要求对应的业务查看权限：持有该权限但没有采购 / 销售 / 库存成本查看权限的角色仍能取到采购金额、库存成本等数值。
- 没有组织范围语义的指标（销售、线上 OMS、应付、订货中心、POS、经销商信用、审批）对受限范围角色返回**全局数字**，AD1 只标注 `scoped:false`，不是 fail-closed。

## 决定

- **每条指标登记 `perms`**（`server/lib/metrics.js`，该指标揭示的业务查看权限，**任一命中**即可）。25 条全覆盖，测试逐条校验非空且都是库里已有的权限点：销售类 `sales.order.view`（`unpaid` 另可 `finance.receivable.view`）；线上 `oms.order.view`；库存 `inventory.stock.view`，库存金额 `inventory.cost.view`；采购订单类复用 `PO_READ_PERMS`（与采购订单读路由、dealer summary 同一常量）；应付 `finance.payable.view` / `purchase.settle.view` / `purchase.payment.view`；订货中心 `order.view`；POS `pos.view`；经销商信用 `credit.view`；审批 `approval.instance.view` / `system:approval:view` / `system:approval:manage`。`perms` 不进 `metricDefinitions()`，因此 `metric_defs` 指纹与定义视图不变。
- **三个端点按可见集合过滤**：缺权限的指标**缺席**（不是 403），`system:metrics:view` 仍是到达端点的前置条件。`/values` 里被隐藏的 key 既不在 `values`/`scoped`，也不进 `unknown`（`unknown` 只表示字典里没有）。响应新增 `hidden_count`（被隐藏的条数；`/values` 带 `keys` 时只统计所请求的已知 key）；`/` 的 `total` 与 `modules` 随可见集合收缩。可见性判据只有一份：`metricVisibility()`，路由用 `permContext`/`hasPerm`（超管 / admin 恒真）构造 `canPerm`。
- **新增危险设置键 `metrics_global_for_restricted`**（enum `hide` | `label`，默认 `hide`，`is_danger`，改动要写理由）：`hide` = 数据范围非"全部"（含 `none`、`dealer`、无组织账号）的调用者不返回 `scopeAware !== true` 的指标；`label` = AD1 行为（返回全局数字并带 `scoped:false`）。全局范围调用者不受该键影响。库里存了不合法值时 `readSetting` 回落默认 `hide`（fail-closed）；只有精确的 `label` 才放宽。
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

（见下，审计完成后填写。）

## 验证入口

`node --test --test-concurrency=1 tests/metrics-perms.test.mjs && node --test --test-name-pattern=AD1 tests/inventory-scope.test.mjs`
