# GML 模块 10B：BOM 与报工领料 — 详细设计（v1）

> 版本：v1（2026-10-15）
> 依赖：模块 02 主数据、模块 03 库存引擎、模块 04 单据内核、模块 06 编码规则、模块 09 存货核算、模块 13 质量检验
> 迁移：`023_bom_and_work.cjs`（三库已执行，伴随 `008_doc_kernel.cjs` 扩表）
> 契约：OpenAPI 1.12.0 · `/api/manufacture` 共 24 条路径（28 个端点）
> 截图：`docs/shots/mfg-01` ~ `mfg-08b`（共 9 张）

## 0. 一句话定位

此前生产域只有一张 `production_orders`：能开单、能改状态，但**没有任何地方记录「料是怎么出的、工是怎么算的」**。

- 点「完工入库」只改状态，**库存一分不动**；
- 材料成本靠人工往 `material_cost` 字段里填，填多填少没人校验；
- 同一张「投入产出」在采购供货目录、委外发料清单、促销组合装、成本料工费归集**四处各描述一遍**，改一处漏三处。

本模块补的是**「投入什么、产出什么」的账**：

```
       BOM（唯一口径）              领料 MR（真的有出库）          完工入库 MO（真的有入库）
 产出 1 件母件要投什么料、多少 → 照 BOM 领、审批后出库  →  按良品入库 + 料工费归集
     用量 / 损耗率 / 替代组          一张可审批、可反查流水的单        成本落到订单与批次上
```

一句话：**让「完工入库」真的入库，让「料工费」真的算得出来。**

## 1. 七条硬口径

这七条同时落在 `GET /api/manufacture/meta` 的 `rules` 里，前端不需要猜；后端每一处校验都对应它们。

| # | 口径 | 落地位置 |
| --- | --- | --- |
| ① | **一个母件 + 一个用途只能有一个 BOM** | 库结构 `UNIQUE (product_sku_id, usage)`，不靠人记得 |
| ② | **展开用量已含损耗**：`单件用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量` | `lib/bom.js` 的 `expandBom`，返回值即最终量 |
| ③ | **替代料取舍必须可解释**：同组内库存够的优先、其次优先级高；未选主料时一并返回原因 | `expandBom` 的 `groups[].reason` |
| ④ | **领料单一经出库即为终态**；退料另开单据 | 内核状态机 `MR`：`issued` 标 `is_final` |
| ⑤ | **限额领料不得超过 BOM 需求**；确需多领必须改成「补料」并填原因 | `assertNoOverIssue` + `MFG_SUPPLEMENT_REASON_REQUIRED` |
| ⑥ | **材料成本按订单数量分摊**：`单位材料 = 已出库领料总额 ÷ 订单数量` | `completeOrder`，不按实际领料分摊 |
| ⑦ | **按第三轮口径 G4「生产不报工」**：完工汇报不推进单据状态，只作为完工入库的依据 | `work_reports` 不注册内核类型 |

其中三条值得展开说，因为它们都是**「跑起来不报错、账却是错的」**那一类：

### ① 为什么「一个母件一个用途只能有一个 BOM」要写进库结构

第二轮原话是「母件 BOM 只有一个版本」。如果这只是一句约定，就会出现两个人都建了一版、**各领各的料，而系统两个都认**。
唯一约束让「换版」只能表现为**作废旧版 + 新建新版**，取料口径永远只有一个答案，历史单据引用的也始终是当时那一版。
配套的护栏还有两条：**已审批的 BOM 不能原地改**（`BOM_APPROVED_IMMUTABLE`，改了用量却不留痕，「上月按什么用量发的料」就查不出来了）、**只有草稿能删**（审批过就被引用过，删掉会让历史单据指向空）。

### ② 为什么损耗必须在展开函数里乘，而不是让调用点自己乘

让每个调用点各自乘 `(1 + loss_rate)`，意味着每个调用点都要记得这件事；漏乘的表现是「料总是不够用」——
**一个不会报错、只会让人以为库存不准的失效**。所以 `expandBom` 返回的 `qty` 就是最终要领的量，调用点不再做算术。
反过来，`bom_items.qty` 存的是**产出 `base_qty` 件母件的用量**，不是「每件母件的用量」：
两者差一个除法，而除法在整数场景下会产生「每件 0.333 个」这种没法发料的结果。基准批量把小数收敛在 BOM 里。

### ⑥ 为什么材料成本按「订单数量」分摊，不按「实际领料」分摊

口径写死在 `completeOrder`：分母是 `po.qty`（订单数量），不是本次良品、也不是实际领料量。

| 分摊基准 | 后果 |
| --- | --- |
| 按实际领料分摊 | 「多领了料」直接变成「单件成本变高」——**超领是损耗异常，应该单独暴露，不该摊进成本里被平均掉** |
| 按订单数量分摊 | 累计归集 = 领料总额 × 累计入库 ÷ 订单数量 ≤ 领料总额，天然不会出现「完工入完库、材料成本却超过领料总额」这种怪事 |

## 2. 数据模型（迁移 023）

### 2.1 五张表

| 表 | 作用 | 关键字段 |
| --- | --- | --- |
| `boms` | BOM 主档（**三种用途共用一张表**） | `code` / `product_sku_id` / `usage` / `version` / `base_qty` / `produce_way` / `status` / `effective_from` / `effective_to` / `item_count` |
| `bom_items` | BOM 组件行 | `line_no` / `sku_id` / `qty`（**产出 base_qty 件的用量**）/ `loss_rate` / `substitute_group` / `priority` / `issue_way` |
| `material_issues` | MR 生产领料单头 | `doc_no` / `order_id` / `warehouse_id` / `issue_type` / `status` / `plan_qty` / `total_qty` / `total_amount` |
| `material_issue_items` | 领料行 | `batch_no` / `plan_qty`（BOM 展开值）/ `qty`（本次申请）/ `issued_qty`（实际出库）/ `unit_cost` / `amount` / `substitute_for` |
| `work_reports` | 完工汇报（**多行**，不注册内核类型） | `order_id` / `issue_id` / `good_qty` / `defect_qty` / `work_hours` / `labor_rate` / `labor_cost` / `overhead_cost` / `material_cost` / `unit_cost` / `stock_done` / `batch_no` |

三处刻意的字段设计：

- **`usage` 三值（`self_made` / `outsourced` / `combo`）合并成一张表**：取料只有一个入口，
  展开算法不关心母件是自制还是组合，只看用量与损耗率。第二轮已定案「组合装并入统一 BOM」，
  否则每加一处取料口径就要写四遍。
- **领料行的 `plan_qty` 与 `qty` 都保留**：只留实发的话，「该领 100 只领了 60」这件事
  在完成之后就查不出来了，而这正是「**为什么这批成本偏低**」的答案。
- **`work_reports` 是「多行」而不是一张订单一行**：一张订单可以分多次完工（分批复检、分批入库）。
  `good_qty` 是入库依据，`defect_qty` 不入库但**必须留痕** ——「做 100 个坏了 8 个」与「做了 92 个」
  是两件完全不同的事：前者要归因、要看不良率，后者只能看到一个偏低的产量。

### 2.2 两个视图：把口径下沉到库里

| 视图 | 作用 | 为什么是视图 |
| --- | --- | --- |
| `v_bom_effective` | **已审批的 BOM 清单**（含组件数、替代组数） | 「取哪个 BOM」必须只有一处口径。写在 JS 里意味着每个调用点都要各写一遍 `status='approved'`，漏一处就会把**草稿 BOM 拿去发料**（草稿的用量是还没审的） |
| `v_production_progress` | 在制进度与料工费归集一屏 | 领了多少、完工多少、料工费各多少分散在四张表，而界面上要看的永远是它们的**对比**（领了 100、完工 80 ⇒ 还有 20 件在制）。各查各的再在前端相减，界面一改口径就不一致 |

### 2.3 索引 / 权限 / 编码规则

- 索引：`idx_boms_sku`、`idx_boms_status`、`idx_bomit_bom`、`idx_bomit_sku`、**`idx_bomit_sub`**（替代组，展开时按组取候选）、
  `idx_mi_order`、`idx_mi_status`、`idx_mi_wh`、`idx_mii_issue`、`idx_mii_sku`、`idx_wr_order`、`idx_wr_date`、`idx_wr_stock`
- 权限点 2 个：`produce.bom.view`（查询，`menu`）、`produce.bom.edit`（维护）
- 编码规则：`MR`，`{PREFIX}{YYYYMMDD}{SEQ:4}`，按日重置
- **BOM 编号走 `nextDocNo(db,'BOM','boms','code')`**，不单独建规则 —— 它是资料不是业务单据

> `verify()` 会同时自检五张表、两个视图、五个关键索引、`boms` 表定义里的
> `UNIQUE (product_sku_id, usage)` 正则、两个权限点，以及定义指纹。
> 视图必须一起查 —— 整库重建会先 DROP 所有视图，只查表存在会把「视图凭空消失」误判成「已迁移」，
> 而依赖它的查询要到运行时才炸。

## 3. 单据内核与状态机

### 3.1 内核登记：新增 `MR`，**不注册报工单**

内核注册类型 **37 → 38 种**（新增 `MR` 生产领料单）；业务流仍是 11 条，但 `FLOW_PRODUCE` 由 5 步扩为 **7 步**。

| 类型 | 表 | 状态 | 动作 |
| --- | --- | --- | --- |
| `MR` 生产领料单 | `material_issues` | `draft` 草稿 → `submitted` 已提交 → `approved` 已审批 → `issued` 已出库（**终态**）/ `cancelled` 已取消 | `submit`、`approve`、`issue`（**确认出库**，唯一扣库存）、`cancel`（draft/submitted/approved 三处均可取消） |

**`WR` 撞码这件事必须说清楚。** 计划书原写「内核注册 MR（领料单）、WR（报工单）」，但 `WR` 早已被
**「委外收货单」**占用（见 `008_doc_kernel.cjs` 的 `DOC_TYPES`）。按原计划注册会**静默覆盖** ——
委外收货单与报工单共用一个类型码。这正是计划书风险表里「新增类型前全库检索短码」要防的事。

同时第三轮口径确认 G4 已定案：**生产不报工**（只做领料 + 完工入库）。两条合起来，本模块**不注册独立报工类型**：
`work_reports` 定位为**完工汇报明细** —— 有单号、可追溯，但**不推进状态、不进审批**，
它是「完工入库」这一动作的输入与凭证。这样「不报工」的口径守住了，「料工费可归集」也不至于无处落账。

### 3.2 `FLOW_PRODUCE` 七步

```
start 生产/委外订单 → bom BOM 展开需求 → approve 订单审批
  → issue 生产领料(MR) → issue-out 委外发料(WM) → complete 完工入库(MO) → inspect 质量检验(QCR)
```

三处修正：

- 新增 **`bom` 节点**：BOM 展开是**生产相对于委外的独有前置**——不知道用多少料就不知道该领多少。委外可以只带供货目录，故本步对委外不强制（`required=1` 但类型是 MO）。
- **领料与发料拆成两个节点**：生产领料（MR）是送到自己的车间、进生产成本；委外发料（WM）是送给供应商加工、进委外加工费。原来两步共用 `'WM'` 一步，导致**自制生产的领料在流程图上被画成「委外发料」**。
- **质检指向 `QCR`（报检单，模块 13）而非原来的 `WR`（委外收货单）** —— WR 是委外到货，与「生产完工后检验」根本不是一件事。

### 3.3 为什么领料单不复用委外发料单（WM）

两者都是「把料送出去」，但一个是送给自己的车间、一个是送给供应商加工；
**成本归属与后续环节完全不同**，合并后「本期委外加工费」这类口径就再也拆不开。

## 4. 核心流程

### 4.1 BOM 展开（`expandBom`）—— 本模块的核心

```
用量 = bom_items.qty × (1 + loss_rate) × 生产数量 ÷ boms.base_qty
```

替代料规则（同 `substitute_group` 内互为替代）：

| 情形 | 取谁 | `reason` |
| --- | --- | --- |
| 有仓上下文、有能满足整笔需求的 | 其中**优先级最高**的 | `主料库存充足` / `主料不足（可用 X < 需求 Y），改用替代料` |
| 有仓上下文、谁都不够 | **可用量最大**的（至少让部分开工） | `所有替代料库存均不足，取可用量最大者（可用 X < 需求 Y）` |
| 无仓上下文（如只做报价试算） | 优先级最高的 | `主料（优先级最高）` |
| 非替代料 | 它自己 | `非替代料` |

**为什么取替代不能按字母序或插入顺序**：那种取法在演示时看着对、在生产时**不可解释**。
展开结果同时返回 `groups[].candidates`（每个候选的 `need_qty` / `available` / `enough`），
让「为什么没选主料」变成一张能给人看的表。

输出顺序按**组的首个行号**排序，不依赖 Map 迭代顺序 —— 否则每次展开的行序可能不同，
而「展开结果可复现」是本项目所有测试的前提。

> 一个容易被误读的现象：**替代组只输出 1 行**。所以「主料行 1 + 替代行 2」的组展开后只出现 `line_no = 1`，
> 下一个非替代组的行号是 3 —— 展开结果是 `[1, 3]` 而不是 `[1, 2]`。这不是漏行，是**替代的语义**。

### 4.2 待领量（`planRequirement`）

```
待领量 = BOM 需求（含损耗） − 已出库累计（按 SKU 汇总，跨批次）
```

已出库累计取 `material_issues.status='issued'` 的行，口径与展开的「按 SKU 一行」对齐。
生产订单没有 BOM 时不报错，而是返回 `bom: null` 与一句人话提示（`该成品尚未维护自制 BOM，无法自动展开需求，请手工添加领料行`）。

### 4.3 领料出库（`issueOut`）—— 本模块唯一扣库存的动作

逐行调库存引擎 `applyStockOut`，把实际批次与出库单价回写到行上。

**出库单价不在这里算**：移动加权 / FIFO / FEFO 的计价规则全在库存引擎里，这里只负责把结果记下来 ——
两处各算一遍必然对不上。

两处具体实现必须留意：

- **行金额 = `qty × unitCost`，不要用库存引擎返回的 `costAmount`。**
  引擎返回的 `costAmount` 是**出库之后的结存金额**（`after.amount`），不是本次出库额。
  拿它当出库额会让领料金额随「这个仓还剩多少钱」而变：同一个批次领两次一样多的料，
  第二次记的金额会和第一次不同，而两张单的单价数量完全一样 —— **这种错误在单据上看不出、只在成本账上错**。
- **未指定批次时回写实际批次**：单批次直接写回 `batch_no`（一行 → 一行流水，可逐行核对）；
  跨批次则把各批次明细留在**单据备注**里，行上保持空 —— 凭空写一个批次会让「这行扣的是哪批」变成假话。
  另外 `material_issue_items` **没有 `updated_at` 列**（行只在出库那一刻写一次），
  顺手带上它会伪装成偶发错误：同一张单换种领料方式就炸、换回去又不炸。

出库完成后**手工补一条 `doc_events` 留痕**（`issue` / `确认出库` / `approved→issued`）：
状态是手写的（为了把金额回写与出库放进同一个事务），但「单据走了哪些环节」这条线不能断。

### 4.4 完工入库（`completeOrder`）—— 本模块唯一给库存做加法的动作

```
材料成本 = (已出库领料总额 ÷ 订单数量) × 本次良品数     ← 口径⑥
转换成本 = 人工 + 制造费用
本次单位成本 = (材料成本 + 转换成本) ÷ 本次良品数
```

四条设计点：

1. **良品为 0 的汇报标记为已处理但不入库**，否则每次完工都会反复捞到这条「永远入不了库」的汇报。
2. **成品批次号**默认 `母件码末 6 位 + 日期`（如 `SP1001` + `261008`），可手工指定。
3. **入库批次的 `qc_status = 'pending'`** —— 完工入库的成品**未质检**，这是模块 13 报检链的入口
   （`v_qc_pending_source` 取 `production_orders.status='completed'`）。
   直接标 `qualified` 等于把「没检」说成「检合格了」。
4. **全部完工才推进订单状态**：`newCompleted >= orderQty` 时才 `applyTransition(action='complete')`。
   只入了一部分就标 `completed`，会让「在制」这件事从界面上消失。

### 4.5 开工（`startOrder`）是领料与完工的共同前置

**领料与完工入库都要求订单状态为 `in_progress`**（未开工抛 `MO_NOT_STARTED`）。
理由分两半：一张「已审批但没开工」的订单若能领料，**料就挂在库外且单据上看不出异常**；
一张没开工的订单若能完工入库，意味着**库里凭空多出一批货而没有对应的料出库**，成本会全部落到「无材料成本」上。

### 4.6 完工入库试算（`previewCompletion`）

纯读、不落库。返回七项归集：`已出库领料总额` / `单位材料` / `材料成本` / `转换成本` / `入库总成本` /
`入库单位成本` / `本次后是否全部完工`。界面上的「完工入库试算」按钮直接展示这七项，
让用户在点「确认入库」**之前**就能看到会归集多少钱。

## 5. 自洽审计（`auditMfg`）七项不变量

都是「跑起来不报错、账却是错的」那一类，只有专职检查才抓得到。

| # | 判据 | 级别 |
| --- | --- | --- |
| ① | 已出库且数量 > 0，但金额 ≤ 0（库存成本未回写） | error |
| ② | 状态为 `issued` 但**找不到 `doc_type='MR'` 的出库流水** —— 本模块最严重的失效 | error |
| ③ | 已出库单的**行合计 ≠ 表头数量**（头行不平） | error |
| ④ | `stock_done=1` 且良品 > 0 的汇报，找不到对应的 `doc_type='MO'` 入库流水 | error |
| ⑤ | 订单 `completed_qty` ≠ 已入库汇报的良品合计（两个口径必须同源） | error |
| ⑥ | 订单 `material_cost` ≠ 其汇报材料成本归集之和 | warn |
| ⑦ | 限额领料单存在超领记录 | warn |

两处实现细节：

- ⑥ 的条件写在 **WHERE** 而不是 HAVING：该查询没有 GROUP BY，用 HAVING 会被 SQLite 判为
  「非聚合查询上的 HAVING」直接抛错，而**审计函数抛错会让整个审计页打不开 —— 一处写错等于这项检查不存在**。
- ④ 的流水反查同时按 `doc_id = wr.order_id` 与 `doc_no = wr.order_no` 匹配：
  完工入库挂的是**订单**（不是汇报），只按汇报单号找会永远查不到，于是审计恒绿而实际什么都没验。

## 6. 接口契约

`/api/manufacture` 独立前缀（**不并进 `/api/demand`**：`demand` 管「要做什么」的计划，本模块管「照什么做、领什么料、入什么库」的执行；两者授权粒度也不同）。共 **24 条路径 / 28 个端点**。

| 分组 | 端点 |
| --- | --- |
| 元数据 | `GET /meta`（字典 + 七条口径原文）、`GET /overview`、`GET /audit` |
| BOM | `GET /boms`、`POST /boms`、`GET /boms/by-sku`、`GET /boms/{id}`、`PUT /boms/{id}`、`POST /boms/{id}/audit`、`POST /boms/{id}/obsolete`、`DELETE /boms/{id}`、`POST /boms/{id}/expand` |
| 生产订单 | `GET /orders`、`GET /orders/{id}`、`GET /orders/{id}/requirement`、`POST /orders/{id}/start`、`GET /orders/{id}/complete-preview`、`POST /orders/{id}/complete` |
| 领料单 | `GET /issues`、`POST /issues`、`GET /issues/{id}`、`POST /issues/{id}/submit`、`/approve`、`/issue`、`/cancel` |
| 完工汇报 | `GET /reports`、`POST /reports`、`GET /reports/{id}`、`PUT /reports/{id}`、`DELETE /reports/{id}` |

`components.schemas` 新增 7 个：`RemarkOnly`、`BomCreate`、`BomUpdate`、`BomExpand`、`IssueCreate`、`WorkReportCreate`、`OrderComplete`。

> **路径顺序**：所有静态段（`/meta`、`/overview`、`/audit`、`/boms/by-sku`…）必须注册在 `/:id` 之前，
> 否则会被当成 id 匹配 —— 本项目踩过两次，这里一律先静态后动态。

**前端动作函数刻意不拼接路径。** `src/api/manufacture.ts` 里四个动作各写一个字面量路径：

```ts
export const MFG_ISSUE_SUBMIT  = (id, remark?) => data(api.post(`/manufacture/issues/${id}/submit`,  { remark }))
export const MFG_ISSUE_APPROVE = (id, remark?) => data(api.post(`/manufacture/issues/${id}/approve`, { remark }))
export const MFG_ISSUE_OUT     = (id, remark?) => data(api.post(`/manufacture/issues/${id}/issue`,   { remark }))
export const MFG_ISSUE_CANCEL  = (id, remark?) => data(api.post(`/manufacture/issues/${id}/cancel`,  { remark }))
```

再由内部分派表 `ISSUE_ACTIONS_FN` 提供给统一的 `MFG_ISSUE_TRANSITION`。
**为什么不写 `${action}` 模板串**：契约检查脚本靠静态扫描比对「前端调了什么 / OpenAPI 登记了什么」，
拼接会变成动态段、被误报为「未登记接口」（实测就是这个原因拆开的）。

## 7. 前端（`/manufacture` 制造中心）

四个页签，路由挂在「计划与生产」组下（`/plan/production` 之后）：

| 页签 | 内容 |
| --- | --- |
| `overview` 总览 | 在制订单与在制数量、已出库领料额、累计良品与不良率、待完工入库数、BOM 总览（含**「能生产但没 BOM」的成品数**）+ 七项审计的人话映射 + 六条硬口径卡片 |
| `bom` BOM | 清单（筛选：状态 / 用途 / 关键字）、新建与编辑（组件行支持替代组与优先级）、详情、**展开试算**（含替代组候选表与取舍理由） |
| `issue` 领料 | 台账、新建（**选订单后按 BOM 自动装填待领量**，自动带出建议批次）、详情（行级实际批次与出库单价） |
| `complete` 完工 | 订单执行表（计划 / 已完工 / 在制 / 领料额 / 良品 / 不良 / 不良率）、订单详情抽屉（BOM / 领料单 / 汇报一屏）、登记汇报、**完工入库试算** |

「能生产但没 BOM 的成品数」是总览里最该被看见的一个数：净需求算出要自产，点进去却没有 BOM，只能靠人临时手填用量。

## 8. 测试与截图

### 8.1 `scripts/test-mfg.mjs`（731 行，三库 160/160）

七个段落：BOM 维护与唯一约束 → 展开（损耗 / 替代 / 顺序）→ 需求与待领量 → 领料单状态机与出库 → 完工汇报与入库归集 → 总览与列表 → 清理与回滚。

**测试必须能重复跑**，所以 `purgeTestData()` 是重点：

- 完工入库流水挂的是**订单号**（`t.doc_no = wr.order_no`），按汇报单号删会每轮漏 2 条 MO 流水；
- 台账 `stock_cost_ledger` **必须一起清**（本模块第一次跑时完全没清）；
- 加**孤儿兜底**（按「引用的单据还在不在」找渣）+ **孤儿留痕兜底**（`doc_type='MR'` 与 `'MO'` 两个类型都要清）；
- 收尾做**精确计数断言**（`txns === 5`、`ledger === 5`、`batches >= 1`），而不是「按流水反查删除」。

一处必须说明的测试设计：**审计的故障注入要破坏审计真正依赖的字段**。
起初写的是 `UPDATE inventory_transactions SET doc_no='__BROKEN__'`，而审计按 `doc_id` 找流水 ——
于是断言**永远为绿**，等于这项检查不存在。改成 `SET doc_id = -1` 之后才真的验到东西。

### 8.2 截图 `scripts/shot-mfg.mjs`（468 行，9 张）

复用 `shot-qc.mjs` 骨架（headless Chrome + CDP），新增三处能力：

- `Page.javascriptDialogOpening` **自动应答 confirm** —— 否则「确认出库 / 完工入库」前的 confirm 会卡死页面；
- `apiGet()` 用同一 token 直查接口 + **数据驱动选样**（`pickBomWithSubstitute` / `pickOrderWithPendingReport` / `pickOrderWithPendingRequirement`）；
- `clickButton(text, { exact })` **精确匹配按钮文本**（模糊匹配会命中同名字段标签），
  以及 `setSelect` 走 React 的 `nativeSetter` + `dispatchEvent(new Event('change', { bubbles: true }))`。

实测内容：展开试算显示「替代组 主料替代 选中第 1 行，需 10.5 主料库存充足」+ 候选表；
领料详情显示行级实际批次与出库单价；完工入库试算七项归集齐全。
收尾按 `favicon.ico` 过滤误报，浏览器 **0 运行时异常 / 0 console.error**。

## 9. 本轮修掉的缺陷

| 缺陷 | 后果 | 修法 |
| --- | --- | --- |
| `makeBom` 的原料窗口 `slice(offset, offset+4)` **不回绕** | 排到后面的成品只剩 1 种原料 → 静默返回 `null` → 该在制订单的成品成了「草稿样本」，且 `issue_only` 模式把它全领满 → **全库再无「有待领量」的样本** | 环形取窗 `pool[(offset + i) % pool.length]`；`offset: i` → `i * 3`；失败记入 `out.bom_misses` 并告警 |
| **成本层的「数量」用 2 位小数** | 批次 D 第一次往库存写入了 4 位小数的数量（BOM 展开 / 领料 kg / 完工），`later.qty` 被砍到 2 位后与原始流水净额差 0.0038 → **残差恒等式在三库同时失效** | `threeLayers` / `closePeriod` 快照 / 暂估在库量 / `recompute` 的**数量**统一改 `round4`（金额仍 `round2`＝分） |
| 测试行校验**假绿** | 样本母件已有 seed 的委外 BOM，`createBom` 先撞 `BOM_ALREADY_EXISTS`，行校验根本没跑到 | 新增「任何用途都没有 BOM」的样本专用于行校验 |
| 审计故障注入**假绿** | 改 `doc_no` 而审计按 `doc_id` 找，断言永远为绿 | 改 `doc_id = -1` |
| 测试清理漏台账、按错单号删流水 | 每轮残留 2 条 MO 流水 + 5 条台账，第二轮起失败点随机 | 重写 `purgeTestData` + 孤儿兜底 + 精确计数断言 |
| `test-costing` 的样本选择 | 「第一张能回写的结算单」不一定含售出行，分支没被走到 | 选择条件写成**本段的先决条件本身**（挑「行里真的有售出」的那张） |
| `test-costing` 的 `issuedAmount` 重复相加 | 断言恒差一点 | 去掉 `+ num(sup.total_amount)` |
| `test-docflow` 单据类型数写死 37 | 新增 MR 后失败 | 更新为 38 并写明「没有 WR、原因是什么」 |

## 10. 边界与不做的事

- **不做生产报工 / 工序级工时采集**（第三轮口径 G4）：完工汇报只到「良品 / 不良 / 工时 / 人工 / 制费」这一级，不展开工序。
- **不做多级 BOM 递归展开**：当前只展开一层（母件的直接组件）。多级需引入层级与低层码，属下一步。
- **不做产能排产与 APS**：`production_orders.plan_date` 只作记录，不参与排程。
- **不做联副产品的成本分摊**：一次投料出一个成品的假设。
- **BOM 不参与自动核价**：`produce_way` 只作为生产订单带出默认值，不驱动取价。
