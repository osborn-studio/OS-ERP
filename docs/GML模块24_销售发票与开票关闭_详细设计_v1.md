# GML 模块 24：销售发票与开票关闭 — 详细设计（v1）

> 版本：v1（2026-10-15）
> 依赖：模块 04 单据内核、模块 21 应收与收款核销、模块 06 编码规则
> 迁移：`021_sales_invoice.cjs`（三库已执行，伴随 008 内核扩表）
> 契约：OpenAPI 1.10.0 · `/api/invoices` 共 14 个端点
> 截图：`docs/shots/si-01` ~ `si-07`

## 0. 一句话定位

销售链到此才闭合。此前这条链断在发货之后：

```
订单（要卖什么） → 发货单（货走了） → 出库（库存减了） → ❌ ？？？ → 收款（钱回来了）
```

`sales_orders.ar_id` 让应收直接挂在订单上，于是三个问题**都答不了**：

| 问题 | 为什么答不了 |
| --- | --- |
| 这批货到底开没开票？ | 发货与开票是两件事，常常错期（月结开票、汇总开票）。没有票的载体，就无法表达"货发了、票没开" |
| 开错票怎么改？ | 没有红冲的载体，只能删单重开 —— 历史就断了 |
| 哪些发货还没开票？ | 没有"待开票队列"，靠人记 |

模块 24 补的就是这一环，并且把"货发了 / 票开了 / 钱收了"这三件事**第一次拆成三个可分别追踪的事实**。

## 1. 三条硬口径

这三条是全部设计的出发点，其它都是推论。

1. **开票不动库存。** 它只产生债权。库存的唯一入口是库存引擎（`lib/stock.js`）。任何试图在开票里改库存的写法都是错的 —— 测试里用 `inventory_transactions` 行数前后一致来钉死这条。
2. **开票关闭是可推导的，不是人工点的。** `invoice_status` 由「**已确认蓝字发票**的行数量 SUM」与发货/订单数量比对得出（`none` / `partial` / `invoiced`）。人工状态迟早和事实对不上，所以界面上**没有"关闭"按钮**。
3. **红冲不删原票。** 原票置 `red_charted`、关联应收置 `voided`、另生成一张**负数红字票**（`invoice_type='red'`、`red_chart_of_id` 指回原票）。两张都在。账要能追回来，靠的不是"删干净"，而是"留全"。

两条衍生口径：

- **草稿不产生后果。** `draft` / `pending` 的票不参与开票关闭、不生成应收。与核销口径同源：没生效的动作不算数。
- **应收来源口径落库。** `settings.ar_source_of_truth` 决定开票时是**关联**订单既有应收（`SO`，默认）还是**新建** `source_type='SI'` 的应收（`SI`）。切换不需要改代码。

## 2. 数据模型（迁移 021）

### 2.1 三张表

| 表 | 作用 | 关键列 |
| --- | --- | --- |
| `sales_invoices` | 发票头 | `doc_no`、`subject_type/id`、`source_type(DL/SO/MANUAL)`、`source_id`、`order_id`、`invoice_date`、`invoice_no`、`invoice_type(normal/red)`、`tax_rate`、`amount/tax_amount/total_amount`、`status`、`ar_id/ar_doc_no`、`red_chart_of_id` |
| `sales_invoice_items` | 发票行 | `invoice_id`、`line_no`、`sku_id`、`qty`、`price`、`amount`、`tax_amount`、`total_amount`、`source_delivery_id`、`source_line_no` |
| `invoice_ar_links` | 发票 ↔ 应收关联 | `invoice_id`、`ar_id`、`delivery_id`、`amount`、`relation(created/linked)`，`UNIQUE(invoice_id, ar_id)` |

**金额为什么拆三列**（不含税 / 税额 / 价税合计）：财务要按不含税确认收入、按税额做进销项。只存一个合计数就拆不回来了。

**为什么关联单独一张表**：分批开票时一张发票会对应多张应收，一张应收也可能由多张发票凑成 —— 一对多要能双向查。

**`source_line_no` 为什么要存**：它是发票行与发货行的对应关系，分批开票时靠它把票与货对上，不用靠数量猜。

### 2.2 订单 / 发货单扩列

| 表 | 新增列 |
| --- | --- |
| `sales_orders` | `invoice_status`、`invoice_qty_sum`、`invoice_id`、`invoice_no` |
| `sales_deliveries` | 同上四列 |

两处都要挂，因为"订单开完票"与"某张发货单开完票"是不同粒度的问题（一张订单可能分多批发货，各批开票进度不同）。

### 2.3 索引与权限

- 索引：`idx_si_status(status, invoice_date)`、`idx_si_subject`、`idx_si_source`、`idx_si_order`、`idx_sii_invoice`、`idx_sii_sku`、`idx_ial_ar`、`idx_ial_invoice`
- 权限点：`sales.invoice.view` / `sales.invoice.edit` / `sales.invoice.approve`
- 编号规则：`SI` → `{PREFIX}{YYYYMMDD}{SEQ:4}`（日流水）

## 3. 单据内核与状态机

`008_doc_kernel.cjs` 新增单据类型 `SI`（销售发票），这是内核第 **34** 种单据类型。

**五状态**

| 状态 | 名称 | 类型 | 说明 |
| --- | --- | --- | --- |
| `draft` | 草稿 | draft | 可改可删，无任何后果 |
| `pending` | 待确认 | active | 已提交，等确认 |
| `confirmed` | 已开票 | done | **非终态** —— 开错票必须能红冲回来 |
| `red_charted` | 已红冲 | void | 终态 |
| `voided` | 已作废 | void | 终态 |

**四动作**

| 动作 | 名称 | 流转 | 权限 | 危险 |
| --- | --- | --- | --- | --- |
| `submit` | 提交开票 | draft→pending | `sales.invoice.edit` | |
| `confirm` | 确认开票 | pending→confirmed | `sales.invoice.approve` | |
| `red_chart` | 红冲 | confirmed→red_charted | `sales.invoice.approve` | ✔（必须填原因） |
| `void` | 作废 | draft→voided | `sales.invoice.edit` | ✔ |

**业务流**

- `FLOW_SALES`（销售主流程）在"发货出库"与"订单完成"之间插入一步「开具销售发票」。
- 新增 `FLOW_SALES_INVOICE`：`发货出库 → 开具发票 → 确认开票（债权成立）→ 生成/关联应收 → 收款核销 → 红冲（可选）→ 开票关闭（可选）`。

## 4. 核心流程

### 4.1 由发货单开票（`createInvoiceFromDelivery`）

1. 校验发货单存在、未取消；
2. 取 `pendingLinesOfDelivery`（逐行算出"还剩多少没开"）—— 判据是**已确认蓝字发票**的行 SUM，草稿不算；
3. 不传 `items` = 整单未开行一次开完；传了 `items` = 按指定行与数量开（**分批开票**）；
4. 含税单价反推价税：`不含税 = 含税 ÷ (1 + 税率)`，`税额 = 含税 − 不含税`（销售价通常按含税谈）；
5. 事务内：取号 → 写头 → 写行（带 `source_line_no`）。**落草稿**，不碰开票关闭。

### 4.2 手工开票（`createManualInvoice`）

无来源单据（补开历史票 / 特殊业务）。`source_type='MANUAL'`，同样落草稿。

### 4.3 确认开票（`confirmInvoice`，唯一有后果的动作）

事务内依次：

1. 内核流转留痕（`applyTransition`）；
2. 写 `status='confirmed'` + 确认人 / 确认时间；
3. **找/建应收**：
   - 口径 `SO` 且发票有 `order_id` → 关联该订单的 `source_type='SO'` 应收（`relation='linked'`）；
   - 否则新建 `source_type='SI'`（`relation='created'`）；
   - **零金额票（赠品 / 全额折让）不建应收** —— 债权为 0 时没有账可记，硬建会被金额校验挡在门外（见 §11 缺陷二）；
4. 写 `invoice_ar_links`（`ON CONFLICT(invoice_id, ar_id) DO UPDATE`，可重复跑）；
5. `refreshCloseStatus` 回写发货单与订单的开票关闭状态。

### 4.4 红冲（`redChartInvoice`）

前置校验：必须 `confirmed`、必须填原因、**关联应收若已有收款（`allocated_amount > 0.005`）则拒绝**（要先把对应收款单作废）。

事务内：

1. 内核流转留痕（reason 写入留痕与红字票备注）；
2. 原票 → `red_charted`；
3. 关联应收 → `voided`（**不是删记录**，是标作废并留痕）；
4. 生成红字票：负数金额、`invoice_type='red'`、`red_chart_of_id` 指回原票，行数量与金额全部取负；
5. `refreshCloseStatus`（红字票不计入已开票量，关闭状态自动回落）。

### 4.5 开票关闭（`refreshCloseStatus`，**派生**）

```
某发货单已开票量 = Σ(该发货单下 status='confirmed' AND invoice_type='normal' 的发票行 qty)
invoice_status = none     (已开 0)
               = invoiced (已开 ≥ 发货量)
               = partial  (其余)
```

订单层同理，用 `sales_orders` 下所有已确认蓝字发票行 SUM 与 `sales_order_items` 的总量比对。这是**派生值不是真相**，任何时候都可以整库重推（`POST /api/invoices/refresh-close`）。

## 5. 接口清单（OpenAPI 1.10.0，`/api/invoices` 共 14 个端点）

| 方法 | 路径 | 权限 | 作用 |
| --- | --- | --- | --- |
| GET | `/meta` | `sales.invoice.view` | 状态字典、开票口径、当前应收来源口径（SO/SI） |
| GET | `/overview` | `sales.invoice.view` | 已开票额 / 税额 / 待确认 / 待开票发货单 / 按状态分布 |
| GET | `/pending` | `sales.invoice.view` | 待开票队列（默认排除已开完票的） |
| GET | `/pending/:deliveryId` | `sales.invoice.view` | 某发货单的逐行待开数量 |
| GET | `/list` | `sales.invoice.view` | 发票列表（状态/客户/订单/蓝红字/日期区间/关键字分页） |
| GET | `/audit` | `sales.invoice.view` | 五查自洽审计 |
| GET | `/:id` | `sales.invoice.view` | 详情（行 + 应收关联 + 红字票 + 原票） |
| POST | `/from-delivery` | `sales.invoice.edit` | 由发货单开票（支持分批） |
| POST | `/manual` | `sales.invoice.edit` | 手工开票 |
| POST | `/:id/submit` | `sales.invoice.edit` | 提交 |
| POST | `/:id/confirm` | `sales.invoice.approve` | 确认开票（唯一有后果） |
| POST | `/:id/red-chart` | `sales.invoice.approve` | 红冲 |
| POST | `/:id/void` | `sales.invoice.edit` | 作废 |
| POST | `/refresh-close` | `sales.invoice.approve` | 重推开票关闭（运维兜底） |

> 路由顺序：`/meta`、`/overview`、`/pending`、`/list`、`/audit`、`/refresh-close` 必须注册在 `/:id` 之前，否则会被当成 id 匹配走详情分支（本项目已两次踩到）。

## 6. 演示数据（`invoice-seed.js`，三库同构）

| 样本 | 形态 | 讲故事 |
| --- | --- | --- |
| 7 张 | `confirmed/normal` | 由发货单开票并确认；SO 口径下关联订单既有应收（其中新建 SI 应收若干） |
| 1 张 | `pending/normal` | 停在待确认 —— 界面上能演示"确认开票"这个动作 |
| 1 张 | `confirmed/red` | 红冲产生的负数红字票 |
| 1 张 | `red_charted/normal` | 原票，与上面那张红字票构成"红冲关系" |

**红冲演示为什么用手工票而不是发货票**：发货票在 SO 口径下会关联订单已有的应收，红冲会把那张应收置为作废，从而破坏模块 21（应收）的演示数据。手工票确认时新建一张 SI 应收，红冲只影响它自己，干净利落。

演示结果（cosmetic）：已开票 8 张 / ¥159,700.23、税额 ¥18,372.61、待确认 1 张、待开票发货单 98 张、红字票 1 张 / ¥−3,390.00。

## 7. 测试与验收

`scripts/test-invoice.mjs`，**三库各 77 项断言**，全部通过且可重复跑（自带残留自愈）。

| 组 | 覆盖 |
| --- | --- |
| 0 内核注册 | SI 类型 / 五状态 / 四动作 / 两条业务流 / `confirmed` 非终态 |
| 1 口径硬约束 | 开票不动库存（`inventory_transactions` / `inventory_batches` 前后一致） |
| 2 手工开票 | 价税拆分（含税 1130 → 不含税 1000 / 税 130）、全生命周期、红冲（原票留痕 + 应收作废 + 红字负数票）、已开票不可直接作废 |
| 3 由发货单开票 | 草稿不参与关闭、分批（partial → 开满）、剩余量递减、超开被拒、不存在的发货单被拒、已收款不能红冲、**零金额赠品票可确认但不建应收** |
| 4 作废 | 草稿可作废、已确认不可作废 |
| 5 列表与总览 | 关键字查询、红字票计入总览 |
| 6 开票不动库存 | 复核 |
| 7 自洽审计 | 五类检查全部零漂移 |
| 8 清理 | 零残票 / 零残行 / 零残关联 / 零孤儿留痕，且清理后仍自洽 |

**自洽审计五查**（`auditInvoice`）：

| 检查 | 判据 |
| --- | --- |
| `headDrift` | 头金额 = 行 SUM（含税、不含税、税额三项） |
| `overQty` | 逐发货行：已确认蓝字发票数量 SUM ≤ 发货数量 |
| `missingAr` | 已确认**有金额**蓝字票必须有应收关联（零金额票豁免） |
| `orphanLinks` | 关联表的发票与应收都必须存在 |
| `badClose` | 发货单的 `invoice_qty_sum` 与事实一致 |

**回归**：`test-ar` 92/92（应收未被破坏）、`verify-seed` 三库全通过、`smoke-api` 2xx 240 / 4xx 20 / 5xx 0、契约 286 路径 + 前端 212 处调用全覆盖、`tsc --noEmit` 无错、`vite build` 通过。

## 8. 前端页面（`/sales/invoices`，三个页签）

| 页签 | 内容 |
| --- | --- |
| 总览 | 6 张 KPI（已开票额 / 税额 / 待确认 / 待开票发货单 / 红字票张数与金额）+ 按状态分布 + 自洽审计（附"重推开票关闭状态"） |
| 待开票队列 | 已发货未开完票的发货单；行内「开票」打开弹窗（逐行填本次开票数量、含税反推、生成草稿） |
| 发票列表 | 全部发票（蓝/红字分色、关联应收、状态）；行内 提交/确认/红冲/作废；「手工开票」弹窗 |

详情弹窗分四块：基本信息、**发票行**、**关联应收**（债权落点）、**红冲关系**（原票 + 红字票并排，负数红字票标红）。

界面上钉死的三条：没有"改库存"入口、没有手工"关闭"按钮、红冲不隐藏任何一张票。

## 9. 与模块 21 的衔接

| 场景 | 行为 |
| --- | --- |
| 口径 `SO`（默认） | 确认开票时关联订单已有应收，`invoice_ar_links.relation='linked'`；不重复造一笔 |
| 口径 `SI` | 确认开票时新建 `source_type='SI'` 的应收（债权成立于开票） |
| 红冲 | 关联应收置 `voided`；若已有收款则拒绝，提示先作废收款单 |
| 零金额票 | 不建应收，也不写关联（审计的 `missingAr` 对零金额票豁免） |

两个模块共用 `ar_documents` 与 `receipt_allocations`，所以红冲对收款的影响走的是应收自身的口径，不另立一套。

## 10. 数据库加固：整库重建的"清单漂移"（本轮最重要的一次修复）

`resetDatabase()` 用一份**硬编码的表清单**决定整库重建时清哪些表。021 新增的三张发票表**没有加进这份清单**，后果是：

- `npm run reseed --force` 之后，上一代的发票残留在库里；
- 它们指向的发货行 id 已被**复用**，所以任何按 id 的孤儿检查都发现不了；
- 表现为 `auditInvoice` 误报 **3 处「超开发票」+ 5 处「孤儿关联」**，且查出原因是"重建不彻底"要花很久。

**修复**：把 `invoice_ar_links`、`sales_invoice_items`、`sales_invoices` 加入清单（附理由注释，顺序：先子表后父表）。

**防复发**：`verify-seed.mjs` 新增第 9 节「跨代引用自洽」，直接调用 `auditInvoice` 与 `auditAr`。重建不彻底会在这里**当场现形**，而不是等到某次演示现场。

> 教训：**"新增模块的表" 与 "加进重建清单" 是一件事的两半**。单据类型注册要改 `008_doc_kernel.cjs`（项目既有约定），清理清单同样要改 `seed.js` 的 `TABLES`。

## 11. 已知边界与下一步

1. **不作废已确认票**：已开票只能红冲，不能直接作废（口径上"撤销债权"必须留红字痕迹）。
2. **不处理税务系统对接**：`invoice_no` 是人工录入的票面号，未与开票软件/电子发票平台打通。
3. **红字票不走审批**：当前红冲只需权限 + 原因；若客户要求"红冲需主管审批"，可挂在模块 08B 审批引擎上（`doc_actions.require_approval`）。
4. **退货冲减开票**：销售退货（`sales_returns`）目前不自动红冲对应发票，需要人工在发票页红冲。这是一个**已知缺口**，下一步可做成"退货确认时提示红冲"。
5. **跨期开票的期间闸门**：目前未按会计期间限制开票日期（模块 09 的成本期间闸门只管库存）。若要做，复用 `cost_periods` 的思路即可。
