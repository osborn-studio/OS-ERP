'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/008_doc_kernel.cjs ｜ 迁移：单据内核 doc_types / doc_states / doc_actions / doc_events / biz_flows
 * ============================================================================
 * 【职责】迁移：单据内核 doc_types / doc_states / doc_actions / doc_events / biz_flows
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 008 单据内核：单据类型注册表 + 状态机 + 业务流 + 流转留痕
//
// 背景（模块 04 要解决的 P0）：
//   现状 30 种状态取值散落在 46 张表，流转判断硬编码在各路由里
//   （例：purchase.js 里直接写 { submit:['draft','submitted'], approve:['submitted','approved'] }）。
//   后果：① 同一种状态在不同单据里语义不同、无法统一查询；
//        ② 非法流转只能靠每处 if 拦，漏一处就写坏数据；
//        ③ 单据走了哪些环节、谁操作的、什么时候，事后查不到。
//
// 本迁移只做「定义与留痕」，不强制改造既有代码：
//   状态值仍是各表原有的 status 字段（零数据迁移风险），
//   内核负责把「合法状态」与「合法流转」变成数据，并提供统一流转入口。
//   各路由可逐步迁到 applyTransition()，未迁的照旧工作。
//
// 状态来源：2026-10-15 对三个行业库的实测取值 + 路由代码里的流转分支，不是凭设计想象。

const { stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '单据内核 doc_types / doc_states / doc_actions / doc_events / biz_flows'

// ---------------------------------------------------------------------------
// 一、单据类型注册表
//
// ⚠️ **新增/删除一个单据类型，要同时改两处（否则下次启动会陷入无意义自愈）**：
//   ① 本文件 `DOC_TYPES`（真实来源）；
//   ② `027_transition_policy.cjs` 的 `POLICY`（流转入口闸门的策略行）。
//   漏改 ② 的后果不是报错，而是 `027.verify()` **恒假** —— runner 每次启动都判定
//   「027 结构缺失 → 重跑 027.up()」，而 `up()` 又补不出那一行，于是**每次启动都白跑一次自愈**
//   （A3 实测就是这个形状）。若这个新类型还有 `require_approval=1` 的边，
//   第三处 `014_approval.cjs` 的 `GATED_EDGES` 也要一并补。
//   两个文件的 `verify()` 都靠 `stampDef` 的**定义指纹**；改定义后重跑一次 `up()` 即可收敛到库里
//   （008 是 `DELETE + INSERT` 全量重灌 states/actions、doc_types 用 upsert；027 的 POLICY 用 upsert）。
// ---------------------------------------------------------------------------
const DOC_TYPES = [
  // code, 名称, 模块, 表名, 单号前缀, 是否有行表, 排序
  ['PO', '采购订单', 'purchase', 'purchase_orders', 'PO', 1, 10],
  ['GR', '采购到货单', 'purchase', 'purchase_receipts', 'PR', 1, 11],
  ['PRT', '采购退货单', 'purchase', 'purchase_returns', 'RT', 1, 12],
  // 模块 07 补齐采购主链路的前段与后段：请购在前，发票/结算/付款在后
  ['PRQ', '请购单', 'purchase', 'purchase_requisitions', 'PRQ', 1, 13],
  ['PI', '采购发票', 'purchase', 'purchase_invoices', 'PI', 1, 14],
  ['PST', '采购结算单', 'purchase', 'purchase_settlements', 'PST', 1, 15],
  ['PAY', '付款单', 'purchase', 'purchase_payments', 'PAY', 1, 16],
  // 采购到货与质检**分成两张单**：
  //   到货单（GR）记「送来了什么」——数量、批次、效期，是**事实**；
  //   质检单（INS）记「收不收、收多少、为什么」——合格/让步接收/退货，是**判断**。
  //   合成一张单的后果是：质检结论无处落，只能塞进到货单的备注里，
  //   于是「判退了多少」既算不出、也追不到责，退货单也不会被生成。
  ['INS', '采购质检单', 'purchase', 'purchase_inspections', 'QC', 1, 17],
  // 销售报价单（模块 08A）：报价必须先于订单成为一张「有有效期、可审批、能转单」的单。
  // 「转单」是它唯一有后果的动作 —— 一张已审批报价只能转一次单（converted 是终态），
  // 要改价只能复制出新版本，不能回头改已经报出去的价。
  ['QT', '销售报价单', 'sales', 'sales_quotes', 'QT', 1, 19],
  // 模块 21 应收与收款核销：
  //   AR 应收单 —— 由销售订单/订货单生成，是「谁欠我多少」的账，不是单据草稿；
  //   RC 收款单 —— 钱到账才生效，核销明细决定它抵了哪几笔应收。
  //   两者分开是为了回答两个不同的问题：对账问 AR，回款问 RC。
  ['AR', '应收单', 'finance', 'ar_documents', 'AR', 0, 40],
  ['RCP', '收款单', 'finance', 'receipts', 'RCP', 1, 41],
  ['SO', '销售订单', 'sales', 'sales_orders', 'SO', 1, 20],
  ['DL', '销售发货单', 'sales', 'sales_deliveries', 'SD', 1, 21],
  // 销售发票（模块 24）：销售链的最后一环 —— 发货出库 → 开票 → 应收 → 收款。
  // 它同时是「开票关闭」的载体：一张发货单/订单开完票就不再出现在待开票队列，
  // 于是「货发了、票没开、钱没收」这三件事第一次能被分别追踪。
  ['SI', '销售发票', 'sales', 'sales_invoices', 'SI', 0, 23],
  // 质量检验（模块 13）：把质检从「采购到货的附属动作」提升为**独立三段链**。
  //   报检 QCR（请人来判）→ 检验 QCI（判的结果）→ 不良品处理 DH（对不良品做什么）。
  //   三段的责任人、时间、后果都不同，合成一张单就只能共用一个状态。
  // 与模块 07 的 INS（到货单绑定的轻量质检）并存：INS 管存量，新单一律走这条链。
  ['QCR', '报检单', 'quality', 'qc_requests', 'QCR', 1, 24],
  ['QCI', '检验单', 'quality', 'qc_inspections', 'QCI', 0, 25],
  ['DH', '不良品处理单', 'quality', 'qc_defect_handlings', 'DH', 0, 26],
  ['SR', '销售退货单', 'sales', 'sales_returns', 'SRT', 1, 22],
  ['TF', '库存调拨单', 'inventory', 'stock_transfers', 'TR', 1, 30],
  ['CK', '库存盘点单', 'inventory', 'stock_checks', 'SC', 1, 31],
  ['AS', '组装拆卸单', 'inventory', 'assembly_orders', 'AS', 1, 32],
  // 成本调整单（模块 09）：把「暂估与实际的差异」回写到存货成本。
  // 它是一张**有后果**的单 —— 提交即改结存金额，所以必须在内核里有状态与留痕，
  // 不能像以前的成本调整那样直接在库存表上 UPDATE 一把了事。
  ['CA', '存货成本调整单', 'inventory', 'cost_adjustments', 'CA', 1, 33],
  ['YQ', '门店要货单', 'requisition', 'store_requisitions', 'SQ', 1, 40],
  ['SH', '门店发货单', 'requisition', 'store_shipments', 'FH', 1, 41],
  ['MO', '生产订单', 'produce', 'production_orders', 'MO', 1, 50],
  ['WW', '委外订单', 'outsource', 'outsourcing_orders', 'WW', 1, 51],
  ['WM', '委外发料单', 'outsource', 'outsourcing_materials', 'WWF', 1, 52],
  ['WR', '委外收货单', 'outsource', 'outsourcing_receipts', 'WWS', 1, 53],
  // 生产领料单（模块 10B）：领料是**真的出库**，必须有单据、有审批、能反查库存流水。
  // 与 WM（委外发料单）分开而不是复用一个类型：两者都是「把料送出去」，
  // 但一个是送给自己的车间、一个是送给供应商加工 —— 成本归属与后续环节完全不同，
  // 合并后「本期委外加工费」这类口径就再也拆不开。
  // 注意：**没有报工单**。计划书原写的 `WR` 已被「委外收货单」占用，
  // 且第三轮口径确认 G4 定案「生产不报工」—— 完工汇报落 `work_reports`，
  // 不注册独立类型、不推进状态（见 023_bom_and_work 文件头）。
  ['MR', '生产领料单', 'produce', 'material_issues', 'MR', 1, 54],
  ['OM', '商城订单', 'oms', 'oms_orders', 'H5', 1, 60],  // 单号字段为 platform_order_no
  ['PS', '门店零售单', 'pos', 'pos_orders', 'POS', 1, 70],
  // 收银交班单（PSF）：班组交班 + 核款 + 长短款。**必须有自己的单号** ——
  // 缴款单与日结单都要指回它，而此前 `pos_shifts` 连一个对外标识都没有（只有自增 id），
  // 「这张缴款单是给哪个班次的」在界面上根本没得显示。
  // 注意：这里补 `doc_no_prefix='PSF'` 的同时，`pos_shifts` 也要补 `doc_no` 列 ——
  // 内核早就把 `doc_no_field` 登记成 `doc_no`，而表里没有这一列，
  // 属于「登记与结构不符」的隐患（024 迁移负责补列，见该文件头）。
  ['PSF', '收银交班单', 'pos', 'pos_shifts', 'PSF', 0, 71],
  // 门店日结单（RC）的对外标识是**批次号** `batch_no`（RBJ 前缀），
  // 不是 `doc_no`。把 `doc_no_field` 指对，而不是再加一个同义的 `doc_no` 列 ——
  // 两个名字指同一个东西，迟早有人只更新其中一个。
  ['RC', '门店日结单', 'pos', 'pos_daily_closes', 'RBJ', 0, 72],
  ['DR', '经销商要货单', 'dealer', 'dealer_requisitions', 'DR', 1, 80],
  ['DS', '经销商对账单', 'dealer', 'dealer_statements', 'DS', 1, 81],
  ['RB', '经销商返利单', 'dealer', 'dealer_rebates', 'RB', 1, 82],
  // 订货中心（模块 12A）：门店要货与经销商订货走同一张单，不再分两处演进
  ['OC', '订货单', 'order-center', 'oc_orders', 'OC', 1, 90],
  ['OCS', '订货对账单', 'order-center', 'oc_statements', 'OCS', 1, 91],
  // 记账凭证（模块 27 · 批次 H）：把业务事实翻译成借贷分录。
  // 它和其他单据有一个根本区别：**不能人工编**。
  // 一张凭证的来源由 (biz_type, source_type, source_id) 唯一决定，界面上没有"新建"入口。
  ['VOUCHER', '记账凭证', 'finance', 'vouchers', 'PZ', 0, 45],
  // 退款单（批次 J）：把退货时登记下来的「待退款」（`sales_returns.refund_due`）兑现成一次真实出账。
  // 此前那个数字**永远停在界面上** —— 没有单据、没有状态、没有账务后果，
  // 于是它既不能被核销（"这笔退了吗"答不出来），也不能被审计（"谁放的这笔钱"答不出来）。
  // `confirmed` 是**终态**：钱出去了就是出去了，要纠正只能作废后重退（作废必须写理由）。
  ['RFD', '退款单', 'finance', 'refunds', 'RFD', 1, 46]
]

// ---------------------------------------------------------------------------
// 二、状态定义：每类型一张状态清单
//     kind: draft 未生效 / active 流转中 / done 已完成 / void 已作废
// ---------------------------------------------------------------------------
const STATES = {
  PO: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['received', '已收货', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  GR: [
    ['draft', '待收货', 'draft', 1, 0],
    ['received', '已收货', 'active', 0, 0],
    ['inspected', '已质检', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1]
  ],
  // 质检单（INS）：草稿 → 已质检 → 已关闭。
  // inspected 是**业务终点**（结论已下、退货单已生成），closed 只是归档动作 ——
  // 所以 inspected 不是终态：结论下了之后还可能要看、要引用、要关闭。
  INS: [
    ['draft', '待质检', 'draft', 1, 0],
    ['inspected', '已质检', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  PRT: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已确认', 'active', 0, 0],
    ['completed', '已完成', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // —— 模块 07 采购域前段：请购单 ——
  // converted（已转单）不标终态：一张请购单可以分次转采购订单（见 items.converted_qty），
  // 全部转完后才 close。若标终态则「部分转单后还想再转」会在界面上没有按钮。
  PRQ: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['converted', '已转单', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['rejected', '已驳回', 'void', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // —— 模块 07 采购域后段：发票 → 结算 → 付款 ——
  // verified（已认证）与 posted（已入账）分开：认证是税务动作、入账是财务动作，
  // 两者由不同角色完成（采购对票 / 财务入账），合成一个状态就没法分工。
  PI: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['verified', '已认证', 'active', 0, 0],
    ['posted', '已入账', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  PST: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['audited', '已审核', 'active', 0, 0],
    ['settled', '已结清', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  PAY: [
    ['draft', '草稿', 'draft', 1, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['paid', '已付款', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 销售报价单（模块 08A）：
  //   rejected 不是终态 —— 驳回的报价改完价要能再提交，否则只能复制一张新的，
  //   报出去的价与「改了几次」就断了线；
  //   expired 也不是 void —— 过期只是「这份价失效了」，它仍是一份可查的历史报价，
  //   与 cancelled（主动作废）不是一回事，界面上要分开显示；
  //   converted 是终态且唯一出口：一张报价只能转成一张订单，要改价走复制改版。
  QT: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '待审批', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['rejected', '已驳回', 'draft', 0, 0],
    ['converted', '已转单', 'done', 0, 1],
    ['expired', '已过期', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 应收单（模块 21）：状态由核销金额推导，closed 是终态；void 只给「开错了」用
  AR: [
    ['open', '待收款', 'active', 1, 0],
    ['partial', '部分收款', 'active', 0, 0],
    ['closed', '已结清', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 收款单（模块 21）：confirm 才生效（核销写入、授信释放），void 自动回退核销
  RCP: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已收款', 'done', 0, 0], // 非终态：还能作废（作废是会计事件，不能因为「已收款」就封死）
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 销售订单：`returned` 保留为终态，但**它不是「作废」**（S-4 的内核侧结论，见下方注释）。
  SO: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已确认', 'active', 0, 0],
    ['picking', '拣货中', 'active', 0, 0],
    ['shipped', '已发货', 'active', 0, 0],
    ['completed', '已完成', 'done', 0, 0],   // 可退货，故非终态
    // `returned`（已退货）是**全退之后真正的收口状态**，所以保留 is_final=1：
    //   ① 全退意味着这张单再也不会发货，没有一个"后面还要做的事"（退款走独立的 RFD 单，
    //      不依赖 SO 还能不能流转）—— 给它造一条出边，只会造出「注册了到不了」的假边（与 A1 同一坑）；
    //   ② 业务侧的「部分退货不许推 returned」由 `lib/returns.js` 负责（只在全退时推这条边），
    //      内核这一层拿不到数量，无从判断"是否全退"，硬拦只会拦错。
    // 但 kind 必须从 `void` 改成 `done`：`void` 的内核语义是「已作废」（cancelled / red_charted /
    // 被红冲掉的作废态），而「已退货」是一次**正常业务的完结**。标错 kind 的后果是
    // 界面与统计把它归进"作废单"那一栏（`getMachine().kinds` 直接按 kind 分组），
    // 于是"退了多少单"与"废了多少单"两个数永远互相污染。
    ['returned', '已退货', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // ⚠️ **声明必须与实际一致**（口径见 `docs/GML总体设计_第0层_配置底座与策略层_v1_20261016.md`
  // 的 §3「每条配置必须满足的七条不变量」与 §4「把配置改成另一个值 ⇒ 系统行为必须真的跟着变」）：
  //   `DL` 的**真实起点是 `shipped`** —— 发货单由 `POST /api/sales/orders/:id/deliver`
  //   建单那一刻就已出库并落 `shipped`（`routes/sales.js`），运行期**没有任何生产者**产出 `draft`。
  //   把 `is_initial` 放在 `draft` 上就是"声明与实际不符"：内核页会给它挂「· 初始」徽标、
  //   lifecycle 文本会写「初始状态：待发货」，而三库一张 draft 都没有（实测 115/55/52 全 `shipped`）。
  //   所以这里把 `is_initial` **移动**到真实起点 `shipped`（不是摘掉 —— `verify()` 的不变量三
  //   要求每个类型**恰有一个** `is_initial`，`008:1311` 与 `scripts/test-docflow.mjs:91` 都守着它）。
  //   ⚠️ **`draft` 状态与它那三条边（`ship` / `confirm` / `cancel`）本轮不删**：移除它们属
  //   **内核语义变更**（且 `cancel` 只从 `draft` 出发 ⇒ 已发货单取消不了，是另一个待裁决的洞），
  //   需单独开窗口，见该文档 §7「口径裁决记录」。
  DL: [
    ['draft', '待发货', 'draft', 0, 0],
    ['shipped', '已发货', 'active', 1, 0],
    ['received', '已签收', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 销售发票（模块 24）：confirm 才真正「开了票」（生成/关联应收、参与开票关闭），
  // 红冲是它的反向动作，所以 confirmed 不能标终态 —— 开错票必须能改回来。
  SI: [
    ['draft', '草稿', 'draft', 1, 0],
    ['pending', '待确认', 'active', 0, 0],
    ['confirmed', '已开票', 'done', 0, 0],
    ['red_charted', '已红冲', 'void', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 报检单（QCR）：submitted 之后还可能被关闭；取消只在草稿期允许 ——
  // 报了检又不想检，应该由检验单给出结论（哪怕结论是「撤回」），而不是让报检单凭空消失。
  QCR: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已报检', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 检验单（QCI）：inspected 是业务终点（结论已下），但不标终态 —— 结论下了之后
  // 还要被引用、被关闭；标了终态界面就会把按钮全禁掉。
  QCI: [
    ['draft', '待检', 'draft', 1, 0],
    ['inspected', '已检', 'active', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 不良品处理单（DH）：confirmed 是终态，因为它是**有库存后果**的动作 ——
  // 出库一旦发生就没有「取消」可言。要纠正只能再开一张反向单（与成本调整单 CA 同一哲学）。
  DH: [
    ['draft', '待处理', 'draft', 1, 0],
    ['confirmed', '已执行', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 同一口径（见上面 `DL` 的说明）：`SR` 的**真实起点是 `confirmed`** —— 退货单在
  // `POST /api/sales/returns`（`lib/returns.js`）与门店退货（`lib/pos2.js`）里都是
  // **建单即回库、即 `confirmed`**，运行期同样没有生产者产出 `draft`。
  // 所以 `is_initial` 从 `draft` **移动**到 `confirmed`（移动、不是摘掉：不变量三要求恰有一个）。
  // `draft` 与它的三条边（`confirm` / `complete` / `cancel`）本轮保留 —— 移除属内核语义变更，待裁决。
  SR: [
    ['draft', '草稿', 'draft', 0, 0],
    ['confirmed', '已确认', 'active', 1, 0],
    ['completed', '已完成', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  TF: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['shipped', '已出库', 'active', 0, 0],
    ['received', '已入库', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  CK: [
    ['draft', '草稿', 'draft', 1, 0],
    ['checking', '盘点中', 'active', 0, 0],
    ['adjusted', '已调整', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  AS: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已执行', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 成本调整单（模块 09）：**不设作废**。
  // 调整一旦提交就已经改了结存金额，「作废」要么得整单反算、要么留下一个说不清的状态；
  // 而成本反算过一次，报表与已出库毛利就再也回不到原样。
  // 要纠正就再开一张反向调整单 —— 每张都留痕、可追溯，比「作废」诚实得多。
  CA: [
    ['draft', '草稿', 'draft', 1, 0],
    ['adjusted', '已调整', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  YQ: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['processing', '处理中', 'active', 0, 0],
    ['allocated', '已分配', 'active', 0, 0],
    ['transferred', '已转单', 'active', 0, 0],
    ['shipped', '已发货', 'active', 0, 0],
    ['received', '已收货', 'done', 0, 0],    // 可继续推进到已完成，故非终态
    ['completed', '已完成', 'done', 0, 1],
    ['rejected', '已驳回', 'void', 0, 1]
  ],
  SH: [
    ['draft', '草稿', 'draft', 1, 0],
    ['shipped', '已发货', 'active', 0, 0],
    ['partial', '部分收货', 'active', 0, 0],
    ['received', '已收货', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  MO: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['in_progress', '生产中', 'active', 0, 0],
    ['completed', '已完工', 'done', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 委外订单（WW）：**部分收货必须是一个在册状态**。
  // 现场一张委外订单很少一次收完 —— `routes/outsourcing.js` 一直在写 `part_received`，
  // 但 STATES.WW 里没有它、ACTIONS.WW 里也没有它的出边。后果不是报错，而是
  // 「部分收货之后这张单永久卡死」：`applyTransition` 找不到 (part_received, *) 的任何边，
  // 于是 `/orders/:id/status {action:'close'}` 得到 409「已是终态，不能继续流转」，
  // 而它其实还有 556 件没收到。这是「定义与实现两套口径」的典型（G3/A5）。
  // `part_received` **不是终态**：还有欠交就要能继续收、能关闭（与 SH 的 `partial` 同形）。
  WW: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['issued', '已发料', 'active', 0, 0],
    ['part_received', '部分收货', 'active', 0, 0],
    ['received', '已收货', 'done', 0, 0],
    ['closed', '已关闭', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  WM: [
    ['draft', '草稿', 'draft', 1, 0],
    ['issued', '已发料', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  WR: [
    ['draft', '草稿', 'draft', 1, 0],
    ['received', '已收货', 'active', 0, 0],
    ['inspected', '已质检', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 生产领料单（MR）：出了库就是终态 —— 库存已经动了，
  // 允许往回退等于要给「已发出去的料再收回来」造一个反向单据，
  // 而现场的真实做法是「退料」另开一张单，不是把原单改回去。
  MR: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['issued', '已出库', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  OM: [
    ['pending', '待处理', 'draft', 1, 0],
    ['shipped', '已发货', 'active', 0, 0],
    ['completed', '已完成', 'done', 0, 1],
    ['refunded', '已退款', 'void', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  PS: [
    ['local', '本店未上传', 'draft', 1, 0],
    ['synced', '已上传总部', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 收银交班单（PSF）：四态，比原来的「营业中 / 已交班」多一个 `declared`。
  // 为什么要那个中间态：**报数**与**核款**是两个不同的人做的两件事 ——
  //   收银员数一遍钱报上来（declare），店长再数一遍确认（approve）。
  // 合成一步就只能共用一个状态，「谁数的、数出来多少、店长认不认」三问合一会互相淹没；
  // 而长短款恰恰是这三问的差额，必须两边都留下数字才对得出来。
  PSF: [
    ['open', '营业中', 'active', 1, 0],
    ['declared', '已报数', 'active', 0, 0],     // 收银员交了报表，等店长核款
    ['closed', '已核款', 'done', 0, 1],         // 核款通过：长短款落账、可参与日结
    ['cancelled', '已作废', 'void', 0, 1]       // 未营业直接作废（开了班却没人来）
  ],
  RC: [
    ['draft', '待上传', 'draft', 1, 0],
    ['uploaded', '已上传', 'done', 0, 0],    // 总部可再确认，故非终态
    ['confirmed', '总部已确认', 'done', 0, 1]
  ],
  // 经销商要货单（DR）：**`cancelled` 是真实存在的终态** —— `routes/demand.js` 的
  // `PUT /dealer/requisitions/:id/status` 一直允许把单据置成 `cancelled`，但内核里从来没有这个状态，
  // 于是那条路只能是**裸 UPDATE**：写出来的值 `allowedActions('DR','cancelled')` 返回空、
  // 不进任何按内核状态的统计 ⇒ **内核看不见这张单**（与 `OM` 曾写 `closed` 同族：
  // "数据里有这个状态" ≠ "这个状态内核认得"）。
  // 本批把它补成真状态（kind=void / is_final=1），与同族的 YQ / SH / TF / CK / AS 的 `cancelled` 对齐。
  DR: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approved', '已审批', 'active', 0, 0],
    ['rejected', '已驳回', 'void', 0, 1],
    ['converted', '已转单', 'done', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  // 经销商对账单（DS）：内核必须覆盖**表里真实存在**的每一个状态，否则「代码里有的状态、
  // 内核里不是状态」——界面上按钮出不来、流转被判成「状态不支持动作」，且不报错。
  //   · `sent`（已发送）来自前端「发送客户」按钮与 `POST /statements/:id/status`
  //     （`routes/dealers.js`）：库里真会出现这个值，内核原来没有它 ⇒ 一张「已发送」
  //     的对账单在内核视角下等于**不存在**，`close` 边（只从 confirmed 出发）也就永远走不到。
  //   · `voided`（已作废）是本轮补的动作（作废这份对账单凭证），与 OCS 的 `voided` 对齐。
  DS: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已确认', 'active', 0, 0],
    ['sent', '已发送', 'active', 0, 0],
    ['closed', '已结清', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 经销商返利单（RB）：**内核状态必须对齐真实流转 `pending → confirmed → paid`**。
  // 真实实现（`lib/rebate.js:316-323` 的 confirmRebate、`:339` 的 settleRebates）
  // 与表注释（`schema.sql:633`：pending待核算/confirmed已确认/paid已发放）都是三段；
  // 而这里原来只认 `pending → paid`，于是 `confirmed` 在内核里**根本不是一个状态**，
  // 一笔已确认、待核销的返利在状态机视角下等于「不存在」—— RB 链在内核里永远是断的（A1）。
  // 取舍：**改内核去对齐代码**（而不是反过来）—— 因为代码那一侧才是账：
  //   ① `confirmed` 是「可入账」与「已核销」之间的真实分界（核销要真实冲应收）；
  //   ② 031 的存量回填把旧语义的 `paid` 降级成 `confirmed`，一旦内核不认 `confirmed`，
  //      这批存量行在内核里就是「未注册状态」，任何基于 `doc_states` 的界面/校验都会漏掉它们。
  // 名称也与 `lib/rebate.js` 的 REBATE_STATUS_LABEL 逐字对齐（pending 是「待核算」不是「待核销」：
  // 「待核销」是 confirmed 那一档的事，两个名字混用正是这次分叉的产物）。
  RB: [
    ['pending', '待核算', 'active', 1, 0],
    ['confirmed', '已确认', 'active', 0, 0],
    ['paid', '已核销', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 订货单：统一承载门店要货与经销商订货（模块 12A）
  // 「已收货」不设终态 —— 收货后还要走对账，与 YQ 同理
  OC: [
    ['draft', '草稿', 'draft', 1, 0],
    ['submitted', '已提交', 'active', 0, 0],
    ['approving', '审批中', 'active', 0, 0],
    ['approved', '已审核', 'active', 0, 0],
    ['allocated', '已分仓', 'active', 0, 0],
    ['shipped', '已发货', 'active', 0, 0],
    ['received', '已收货', 'done', 0, 0],
    ['completed', '已完成', 'done', 0, 1],
    ['rejected', '已驳回', 'void', 0, 1],
    ['cancelled', '已取消', 'void', 0, 1]
  ],
  OCS: [
    ['draft', '草稿', 'draft', 1, 0],
    ['confirmed', '已确认', 'active', 0, 0],
    ['closed', '已结清', 'done', 0, 1],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 记账凭证（批次 H）：draft 已生成未过账（**不计入试算平衡**）→ posted 已过账 → voided 已作废。
  // `posted` 刻意**不是终态**：一张过账的凭证写错了必须能作废（作废即从账上移除并留痕），
  // 否则"平不了的账"就只能靠再补一张反向凭证去硬凑。
  VOUCHER: [
    ['draft', '已生成', 'draft', 1, 0],
    ['posted', '已过账', 'active', 0, 0],
    ['voided', '已作废', 'void', 0, 1]
  ],
  // 退款单（批次 J）：draft 已登记未退款（**钱还没出去**）→ confirmed 已退款 → voided 已作废。
  // `confirmed` **刻意不登记为终态**（与本项目"终态不能有出边"的内核规则一致）：
  // 一笔钱退错了（账号错、金额错）必须能纠正 —— 能做的只有"作废后重退"。
  // 这与凭证 `posted` 可作废同构，也与"退货单已确认仍可再退"同构。
  RFD: [
    ['draft', '已登记', 'draft', 1, 0],
    ['confirmed', '已退款', 'done', 0, 0],
    ['voided', '已作废', 'void', 0, 1]
  ]
}

// ---------------------------------------------------------------------------
// 三、动作定义：[动作码, 动作名, 起始状态, 目标状态, 权限点, 是否高危]
//     同一动作可有多个起始状态（如 cancel 可从多态发起）→ 拆成多条边
// ---------------------------------------------------------------------------
const ACTIONS = {
  PO: [
    ['submit', '提交', 'draft', 'submitted', 'purchase.order.edit', 0],
    ['approve', '审批', 'submitted', 'approved', 'purchase.order.approve', 0],
    ['receive', '收货', 'approved', 'received', 'purchase.inbound', 0],
    ['receive', '收货', 'submitted', 'received', 'purchase.inbound', 0],
    ['partial', '部分收货', 'approved', 'approved', 'purchase.inbound', 0],
    ['partial', '部分收货', 'submitted', 'submitted', 'purchase.inbound', 0],
    ['close', '关闭', 'received', 'closed', 'purchase.order.approve', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'purchase.order.approve', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'purchase.order.approve', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'purchase.order.approve', 1]
  ],
  GR: [
    ['confirm', '确认收货', 'draft', 'received', 'purchase.inbound', 0],
    ['inspect', '质检', 'received', 'inspected', 'quality.inspect', 0],
    ['close', '关闭', 'inspected', 'closed', 'purchase.inbound', 0]
  ],
  PRT: [
    ['confirm', '确认', 'draft', 'confirmed', 'purchase.return', 0],
    ['complete', '完成', 'confirmed', 'completed', 'purchase.return', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'purchase.return', 1]
  ],
  // 质检单的动作只有一个真正有后果的：inspect（提交质检结论）。
  // 提交时会按「判退数量」自动生成采购退货单并把货退出去 —— 质检不能是一个只改状态的空动作。
  INS: [
    ['inspect', '提交质检结论', 'draft', 'inspected', 'quality.inspect', 0],
    ['close', '关闭', 'inspected', 'closed', 'quality.inspect', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'quality.inspect', 1]
  ],
  PRQ: [
    ['submit', '提交', 'draft', 'submitted', 'purchase.req.edit', 0],
    ['approve', '审批通过', 'submitted', 'approved', 'purchase.req.approve', 0],
    ['reject', '驳回', 'submitted', 'rejected', 'purchase.req.approve', 1],
    ['convert', '转采购订单', 'approved', 'converted', 'purchase.order.edit', 0],
    ['close', '关闭', 'converted', 'closed', 'purchase.req.approve', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'purchase.req.edit', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'purchase.req.approve', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'purchase.req.approve', 1]
  ],
  PI: [
    ['submit', '提交', 'draft', 'submitted', 'purchase.invoice.edit', 0],
    ['verify', '发票校验', 'submitted', 'verified', 'purchase.invoice.verify', 0],
    ['post', '入账', 'verified', 'posted', 'finance.settle.edit', 1],
    ['void', '作废', 'draft', 'voided', 'purchase.invoice.edit', 1],
    ['void', '作废', 'submitted', 'voided', 'purchase.invoice.verify', 1],
    // 已认证但未入账的票可以作废：认证只说明票与入库对得上，
    // 票本身开错（金额/税率/张冠李戴）在入账前必须能撤 —— 否则只能留着错票往下走。
    // 已入账（posted）不给出边：账已经记了，要改得走红字发票，不能一作废了事。
    ['void', '作废', 'verified', 'voided', 'finance.settle.edit', 1]
  ],
  PST: [
    ['submit', '提交', 'draft', 'submitted', 'purchase.settle.edit', 0],
    ['audit', '审核', 'submitted', 'audited', 'purchase.settle.audit', 0],
    ['settle', '结清', 'audited', 'settled', 'finance.settle.edit', 1],
    ['void', '作废', 'draft', 'voided', 'purchase.settle.edit', 1],
    ['void', '作废', 'submitted', 'voided', 'purchase.settle.edit', 1]
  ],
  PAY: [
    ['submit', '提交审批', 'draft', 'approved', 'purchase.payment.edit', 0],
    ['pay', '执行付款', 'approved', 'paid', 'purchase.payment.approve', 1],
    ['void', '作废', 'draft', 'voided', 'purchase.payment.edit', 1],
    ['void', '作废', 'approved', 'voided', 'purchase.payment.approve', 1]
  ],
  // 报价单（模块 08A）：convert 是唯一有后果的动作（生成销售订单/订货单并占用授信）。
  // expire 不挂权限点 —— 它是系统按有效期自动执行的，不是给人点的按钮。
  QT: [
    ['submit', '提交审批', 'draft', 'submitted', 'sales.quote.edit', 0],
    ['approve', '审批通过', 'submitted', 'approved', 'sales.quote.approve', 0],
    ['reject', '驳回', 'submitted', 'rejected', 'sales.quote.approve', 1],
    ['resubmit', '修改后再提交', 'rejected', 'submitted', 'sales.quote.edit', 0],
    ['convert', '转订单', 'approved', 'converted', 'sales.quote.convert', 0],
    ['expire', '过期失效', 'approved', 'expired', null, 0],
    ['expire', '过期失效', 'submitted', 'expired', null, 0],
    ['cancel', '取消', 'draft', 'cancelled', 'sales.quote.edit', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'sales.quote.edit', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'sales.quote.edit', 1],
    ['cancel', '取消', 'rejected', 'cancelled', 'sales.quote.edit', 1]
  ],
  AR: [
    ['allocate', '登记核销', 'open', 'partial', 'finance.receipt.edit', 0],
    ['allocate', '登记核销', 'open', 'closed', 'finance.receipt.edit', 0],
    ['allocate', '登记核销', 'partial', 'closed', 'finance.receipt.edit', 0],
    ['allocate', '登记核销', 'partial', 'partial', 'finance.receipt.edit', 0],
    ['void', '作废', 'open', 'voided', 'finance.receipt.approve', 1],
    ['void', '作废', 'partial', 'voided', 'finance.receipt.approve', 1]
  ],
  RCP: [
    ['confirm', '确认收款（核销生效）', 'draft', 'confirmed', 'finance.receipt.approve', 0],
    ['void', '作废', 'draft', 'voided', 'finance.receipt.edit', 1],
    ['void', '作废', 'confirmed', 'voided', 'finance.receipt.approve', 1]
  ],
  SO: [
    ['confirm', '确认订单', 'draft', 'confirmed', 'order.confirm', 0],
    ['pick', '开始拣货', 'confirmed', 'picking', 'sales.outbound', 0],
    ['pick', '继续拣货', 'picking', 'picking', 'sales.outbound', 0],
    ['ship', '发货出库', 'confirmed', 'shipped', 'sales.outbound', 0],
    ['ship', '发货出库', 'picking', 'shipped', 'sales.outbound', 0],
    ['complete', '完成', 'shipped', 'completed', 'sales.outbound', 0],
    ['return', '退货', 'shipped', 'returned', 'sales.return', 1],
    ['return', '退货', 'completed', 'returned', 'sales.return', 1],
    ['return', '退货', 'confirmed', 'returned', 'sales.return', 1],
    ['return', '退货', 'draft', 'returned', 'sales.return', 1],
    ['cancel', '取消', 'draft', 'cancelled', 'sales.order.approve', 1],
    ['cancel', '取消', 'confirmed', 'cancelled', 'sales.order.approve', 1]
  ],
  DL: [
    ['ship', '发货', 'draft', 'shipped', 'sales.outbound', 0],
    ['receive', '签收', 'shipped', 'received', 'sales.outbound', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'sales.outbound', 1]
  ],
  SI: [
    ['submit', '提交开票', 'draft', 'pending', 'sales.invoice.edit', 0],
    ['confirm', '确认开票', 'pending', 'confirmed', 'sales.invoice.approve', 0],
    // 红冲要理由（红字发票必须能说明为什么冲），所以 require_reason = 1
    ['red_chart', '红冲', 'confirmed', 'red_charted', 'sales.invoice.approve', 1],
    ['void', '作废', 'draft', 'voided', 'sales.invoice.edit', 1]
  ],
  // 报检单：提交后等检验；关闭是归档动作，不产生业务后果
  QCR: [
    ['submit', '提交报检', 'draft', 'submitted', 'quality.request.create', 0],
    ['close', '关闭', 'submitted', 'closed', 'quality.qc.view', 1],
    ['cancel', '取消', 'draft', 'cancelled', 'quality.request.create', 1]
  ],
  // 检验单：inspect 是唯一有后果的动作（判定 + 汇总 + 回写报检行）
  QCI: [
    ['inspect', '提交检验结论', 'draft', 'inspected', 'quality.inspect', 0],
    ['close', '关闭', 'inspected', 'closed', 'quality.inspect', 1],
    ['cancel', '取消', 'draft', 'cancelled', 'quality.inspect', 1]
  ],
  // 不良品处理单：confirm 会真的出库 / 生成退货单，故 is_danger=1
  DH: [
    ['confirm', '执行处理', 'draft', 'confirmed', 'quality.handle.approve', 1],
    ['cancel', '取消', 'draft', 'cancelled', 'quality.handle.approve', 1]
  ],
  SR: [
    ['confirm', '确认退货', 'draft', 'confirmed', 'sales.return', 0],
    ['complete', '完成入库', 'confirmed', 'completed', 'sales.return', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'sales.return', 1]
  ],
  TF: [
    ['submit', '提交', 'draft', 'submitted', 'inventory.transfer', 0],
    ['ship', '调拨出库', 'draft', 'shipped', 'inventory.transfer', 0],
    ['ship', '调拨出库', 'submitted', 'shipped', 'inventory.transfer', 0],
    ['receive', '调拨入库', 'shipped', 'received', 'inventory.transfer', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'inventory.transfer', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'inventory.transfer', 1]
  ],
  CK: [
    ['start', '开始盘点', 'draft', 'checking', 'inventory.check', 0],
    ['start', '更新实盘', 'checking', 'checking', 'inventory.check', 0],
    ['adjust', '盘点调整', 'checking', 'adjusted', 'inventory.adjust', 1],
    ['adjust', '盘点调整', 'draft', 'adjusted', 'inventory.adjust', 1],
    ['cancel', '取消', 'draft', 'cancelled', 'inventory.check', 1]
  ],
  AS: [
    ['confirm', '执行组装', 'draft', 'confirmed', 'inventory.adjust', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'inventory.adjust', 1]
  ],
  // adjust 是唯一有后果的动作：提交即把差异回写到结存金额（可逆性靠再开一张反向单）
  CA: [
    ['adjust', '确认调整', 'draft', 'adjusted', 'cost.adjust', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'cost.adjust', 1]
  ],
  YQ: [
    ['submit', '提交', 'draft', 'submitted', 'pos.store.requisition', 0],
    ['process', '受理', 'submitted', 'processing', 'pos.store.requisition', 0],
    ['reject', '驳回', 'submitted', 'rejected', 'pos.store.requisition', 0],
    ['reject', '驳回', 'processing', 'rejected', 'pos.store.requisition', 0],
    ['allocate', '分配库存', 'processing', 'allocated', 'pos.store.requisition', 0],
    ['allocate', '分配库存', 'submitted', 'allocated', 'pos.store.requisition', 0],
    ['transfer', '转采购/调拨', 'processing', 'transferred', 'pos.store.requisition', 0],
    ['ship', '发货', 'allocated', 'shipped', 'pos.store.requisition', 0],
    ['receive', '收货', 'shipped', 'received', 'pos.store.requisition', 0],
    ['complete', '完成', 'received', 'completed', 'pos.store.requisition', 0],
    ['complete', '完成', 'transferred', 'completed', 'pos.store.requisition', 0],
    ['complete', '完成', 'allocated', 'completed', 'pos.store.requisition', 0],
    ['complete', '完成', 'shipped', 'completed', 'pos.store.requisition', 0],
    ['complete', '完成', 'processing', 'completed', 'pos.store.requisition', 0]
  ],
  SH: [
    ['ship', '发货', 'draft', 'shipped', 'pos.store.requisition', 0],
    ['partial', '部分收货', 'shipped', 'partial', 'pos.store.requisition', 0],
    ['receive', '确认收货', 'shipped', 'received', 'pos.store.requisition', 0],
    ['receive', '确认收货', 'partial', 'received', 'pos.store.requisition', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'pos.store.requisition', 1]
  ],
  MO: [
    ['submit', '提交', 'draft', 'submitted', 'produce.order.edit', 0],
    ['approve', '审批', 'submitted', 'approved', 'produce.order.view', 0],
    ['start', '开工', 'approved', 'in_progress', 'produce.order.edit', 0],
    ['complete', '完工入库', 'in_progress', 'completed', 'produce.receipt', 0],
    ['close', '关闭', 'completed', 'closed', 'produce.order.edit', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'produce.order.edit', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'produce.order.edit', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'produce.order.edit', 1]
  ],
  // 委外订单：发料 → 收货（可分批）→ 关闭。
  // 注意 `UNIQUE (doc_type, action, from_state)` —— **同一对 (动作, 起始状态) 只能有一个目标状态**。
  // 所以「全部收完 → received」与「还欠交 → part_received」不能共用 `receive`：
  // 拆成 `receive`（收满那一票）/ `partial`（未收满那一票），与采购单 PO.partial、门店发货 SH.partial 同一手法。
  // 另补 `issue` / `receive` / `partial` 的**自环边**（X→X）：第二次发料、第二批收货都要留痕，
  // 否则一张分三次收完的委外单在 doc_events 里只有一条收货记录（A5 的「出生即终态、过程无痕」）。
  WW: [
    ['submit', '提交', 'draft', 'submitted', 'produce.order.edit', 0],
    ['approve', '审批', 'submitted', 'approved', 'produce.order.view', 0],
    ['issue', '发料', 'approved', 'issued', 'produce.issue', 0],
    ['issue', '继续发料', 'issued', 'issued', 'produce.issue', 0],
    ['issue', '继续发料', 'part_received', 'part_received', 'produce.issue', 0],
    ['receive', '收货', 'issued', 'received', 'produce.receipt', 0],
    ['receive', '收货', 'part_received', 'received', 'produce.receipt', 0],
    ['partial', '部分收货', 'issued', 'part_received', 'produce.receipt', 0],
    ['partial', '部分收货', 'part_received', 'part_received', 'produce.receipt', 0],
    ['close', '关闭', 'received', 'closed', 'produce.order.edit', 0],
    ['close', '关闭', 'part_received', 'closed', 'produce.order.edit', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'produce.order.edit', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'produce.order.edit', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'produce.order.edit', 1]
  ],
  WM: [
    ['issue', '确认发料', 'draft', 'issued', 'produce.issue', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'produce.issue', 1]
  ],
  WR: [
    ['receive', '确认收货', 'draft', 'received', 'produce.receipt', 0],
    ['inspect', '质检', 'received', 'inspected', 'quality.inspect', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'produce.receipt', 1]
  ],
  MR: [
    ['submit', '提交', 'draft', 'submitted', 'produce.issue', 0],
    ['approve', '审批', 'submitted', 'approved', 'produce.order.view', 0],
    ['issue', '确认出库', 'approved', 'issued', 'produce.issue', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'produce.issue', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'produce.issue', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'produce.issue', 1]
  ],
  OM: [
    ['ship', '发货', 'pending', 'shipped', 'oms.order.ship', 0],
    ['complete', '完成', 'shipped', 'completed', 'oms.order.route', 0],
    ['refund', '退款', 'pending', 'refunded', 'pos.refund', 1],
    ['refund', '退款', 'shipped', 'refunded', 'pos.refund', 1],
    ['cancel', '取消', 'pending', 'cancelled', 'oms.order.route', 1]
  ],
  PS: [
    ['sync', '上传总部', 'local', 'synced', 'pos.cashier', 0],
    ['void', '作废', 'local', 'voided', 'pos.refund', 1]
  ],
  // 收银交班单（PSF）。三步：报数（收银员）→ 核款（店长）→ 终态。
  // `reject` 是**退回重报**而不是取消：店长数出来与报表差太多（比如差一整个数量级），
  // 先退回收银员自己再数一遍，比当场批一张"长短款 XXX 元"合理得多。
  // 原来的 `close`（open → closed 一步到位）已删除 —— 它等于**绕过核款**，
  // 而本批次要立的正是「钱必须数两遍」。
  PSF: [
    ['declare', '交班报数', 'open', 'declared', 'pos.shift', 0],
    ['reject', '退回重报', 'declared', 'open', 'pos.shift.review', 0],
    ['approve', '店长核款', 'declared', 'closed', 'pos.shift.review', 0],
    ['cancel', '作废班次', 'open', 'cancelled', 'pos.shift', 1],
    ['cancel', '作废班次', 'declared', 'cancelled', 'pos.shift.review', 1]
  ],
  RC: [
    ['upload', '上传日结', 'draft', 'uploaded', 'pos.dailyclose', 0],
    ['confirm', '总部确认', 'uploaded', 'confirmed', 'pos.dailyclose', 0]
  ],
  DR: [
    ['submit', '提交', 'draft', 'submitted', 'order.place', 0],
    ['approve', '审批', 'submitted', 'approved', 'dms.dealer.approve', 0],
    ['reject', '驳回', 'submitted', 'rejected', 'dms.dealer.approve', 0],
    ['convert', '转销售订单', 'approved', 'converted', 'order.confirm', 0],
    ['convert', '转销售订单', 'submitted', 'converted', 'order.confirm', 0],
    // `cancel`（取消）只从 **draft / submitted / approved** 出发 ——
    //   · **不从 `rejected` / `converted`**：那两个是终态（`is_final=1`），内核的不变量
    //     「终态不能有出边」不允许（加了就会让 `verify()` 判红、每次启动白跑一次自愈）；
    //     语义上也成立：已驳回/已转单的要货申请不该再被取消，要改就重新提一张。
    //   · ⚠️ 这是**行为收紧**：改之前那条路由是裸 UPDATE，`rejected/converted → cancelled`
    //     也能写进去（只是没有任何校验与统一留痕）。内核化之后它会被 409 挡下 —— 这是**有意的**。
    //   · perm 复用 `dms.dealer.approve`（与 `reject` 同族：都是经销商要货单在总部侧被终止），
    //     **不新造权限点**；`is_danger=1`（与其它单据类型的 `cancel` 一致）。
    ['cancel', '取消', 'draft', 'cancelled', 'dms.dealer.approve', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'dms.dealer.approve', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'dms.dealer.approve', 1]
  ],
  // 经销商对账单（DS）的边。三条设计取舍，都要写清否则会被"顺手简化"掉：
  //   ① `close`（结清）**只能从 confirmed / sent 出发**，不能从 draft：
  //      草稿是"还没跟客户对过"，不能跳过对账直接结清。
  //      业务校验（同主体同期间应收是否真的收齐）在 `lib/dealer-statement.js` 里，
  //      内核只管"这条边合不合法"。
  //   ② `close` 与 `void` 都是 `is_danger=1`：它们改变对账单的终局结论，
  //      作废更是让一份"双方已经确认过的账"从系统里消失 —— 必须留痕且需要理由。
  //   ③ `void` 三条边覆盖 draft / confirmed / sent：**草稿也能作废**（录错了要能撤），
  //      已确认/已发送的作废更谨慎（对账结论已被客户看到过）。
  DS: [
    ['confirm', '确认对账', 'draft', 'confirmed', 'order.statement.view', 0],
    ['send', '发送客户', 'confirmed', 'sent', 'order.statement.view', 0],
    ['close', '结清', 'confirmed', 'closed', 'finance.settle.edit', 1],
    ['close', '结清', 'sent', 'closed', 'finance.settle.edit', 1],
    ['void', '作废', 'draft', 'voided', 'finance.settle.edit', 1],
    ['void', '作废', 'confirmed', 'voided', 'finance.settle.edit', 1],
    ['void', '作废', 'sent', 'voided', 'finance.settle.edit', 1]
  ],
  // RB 返利单：与上面的 STATES.RB 成对 —— `confirm`（可入账）与 `pay`（已核销、已冲应收）**必须分开**。
  // 原来直接把 `pay` 挂在 `pending` 上，等于「待核算的返利可以一步跳到已核销」，
  // 而真实实现里 `settleRebates` 只取 `status='confirmed'` 的行、`confirmRebate` 只接受 `pending`：
  // 内核给的那条 `pending → paid` 边**在这份代码里永远走不通**（注册了到不了）。
  // 作废同样两段：`pending` 可以作废（还没确认），`confirmed` 作废要更谨慎（它已可入账）。
  RB: [
    ['confirm', '确认', 'pending', 'confirmed', 'finance.settle.edit', 0],
    ['pay', '核销返利', 'confirmed', 'paid', 'finance.settle.edit', 1],
    ['void', '作废', 'pending', 'voided', 'finance.settle.edit', 1],
    ['void', '作废', 'confirmed', 'voided', 'finance.settle.edit', 1]
  ],
  // 订货单流转：提交 →（按规则）审批 → 分仓 → 发货 → 收货 → 完成
  // 免审批单由 submit 后直接走 approve 边完成「受理」，不额外开一条 draft→approved 的边
  OC: [
    ['submit', '提交订货', 'draft', 'submitted', 'order.place', 0],
    ['review', '进入审批', 'submitted', 'approving', 'order.confirm', 0],
    ['approve', '审核通过', 'submitted', 'approved', 'order.confirm', 0],
    ['approve', '审核通过', 'approving', 'approved', 'order.confirm', 0],
    ['reject', '驳回', 'submitted', 'rejected', 'order.confirm', 1],
    ['reject', '驳回', 'approving', 'rejected', 'order.confirm', 1],
    ['allocate', '智能分仓', 'approved', 'allocated', 'order.confirm', 0],
    ['ship', '发货出库', 'allocated', 'shipped', 'sales.outbound', 0],
    ['ship', '发货出库', 'approved', 'shipped', 'sales.outbound', 0],
    ['receive', '确认收货', 'shipped', 'received', 'order.view', 0],
    ['complete', '完成', 'received', 'completed', 'order.view', 0],
    ['complete', '完成', 'allocated', 'completed', 'order.view', 0],
    ['cancel', '取消', 'draft', 'cancelled', 'order.place', 1],
    ['cancel', '取消', 'submitted', 'cancelled', 'order.place', 1],
    ['cancel', '取消', 'approved', 'cancelled', 'order.confirm', 1]
  ],
  // 订货对账单（OCS）的边。与经销商对账单（DS）**同一套口径**，避免"两个对账单载体、
  // 两个作废语义"——客户会发现"经销商对账单确认过也能作废、订货对账单确认过就不能"，
  // 那是同一条业务的两条路径口径分叉。
  //   ① `confirm`：draft → confirmed（对账成立）；
  //   ② `close`  ：confirmed → closed（**只能从 confirmed**：草稿还没跟客户对过，
  //      不能跳过对账直接结清；"是否真的收齐"由 `lib/order-center.js` 的业务校验判，
  //      内核只管这条边合不合法）；
  //   ③ `void`   ：draft / confirmed → voided。`draft` 那条是原有的（录错了要能撤），
  //      **`confirmed` 这条是本轮补的** —— 真实场景恰恰是"发给客户之后客户不认"，
  //      只允许草稿作废的话，已确认的对账单就只能靠直接改库来撤（绕过内核）。
  //      两条 void 边都是 `is_danger=1`：作废让一份"双方确认过的账"从系统里消失，
  //      必须留痕且需要理由（`required_reason` 由业务入口强制）。
  OCS: [
    ['confirm', '确认对账', 'draft', 'confirmed', 'order.statement.view', 0],
    ['close', '结清', 'confirmed', 'closed', 'finance.settle.edit', 1],
    ['void', '作废', 'draft', 'voided', 'order.statement.view', 1],
    ['void', '作废', 'confirmed', 'voided', 'order.statement.view', 1]
  ],
  // 记账凭证（模块 27 · 批次 H）：把业务事实翻译成借贷分录。
  // 只有 `posted` 计入试算平衡；`void` 会改变当期发生额，所以登记为高危动作。
  VOUCHER: [
    ['post', '过账', 'draft', 'posted', 'finance.voucher.post', 0],
    ['void', '作废', 'draft', 'voided', 'finance.voucher.void', 1],
    ['void', '作废', 'posted', 'voided', 'finance.voucher.void', 1]
  ],
  // 退款单（批次 J）：登记（edit）与出账（approve）**分开授权** ——
  // 能录一张退款单的人，不该同时能把钱放出去。
  // 作废一张**已退款**的单是高危动作（它会让一笔已出的钱从账上消失）：
  // 从 draft 作废只需 edit；从 confirmed 作废需要 approve 且必须写理由。
  RFD: [
    ['confirm', '确认退款（出账）', 'draft', 'confirmed', 'finance.refund.approve', 1],
    ['void', '作废', 'draft', 'voided', 'finance.refund.edit', 0],
    ['void', '作废（已退款）', 'confirmed', 'voided', 'finance.refund.approve', 1]
  ]
}

// ---------------------------------------------------------------------------
// 四、业务流：跨单据的多环节串联（如 要货单 → 调拨单/采购单 → 发货单）
//     这里先落「主链路」定义，模块 07/08/12A 实施时按此驱动
// ---------------------------------------------------------------------------
const FLOWS = [
  {
    code: 'FLOW_PURCHASE',
    name: '采购主流程',
    doc_type: 'PO',
    module: 'purchase',
    remark: '请购 → 采购订单 → 到货单 → 质量检验 → 入库过账 → 采购发票 → 三单结算 → 付款核销（模块 07）',
    steps: [
      ['request', '请购申请', 'PRQ', 'purchase.req.edit', 1],
      ['req_approve', '请购审批', 'PRQ', 'purchase.req.approve', 1],
      ['order', '采购订单创建', 'PO', 'purchase.order.edit', 1],
      ['approve', '订单审批', 'PO', 'purchase.order.approve', 1],
      ['receipt', '到货收货', 'GR', 'purchase.inbound', 1],
      // 到货与质检**分成两张单**：到货单记事实（送来了什么），质检单记判断（收不收、收多少）。
      // 说明一处**已知边界**：既有链路的到货单在「确认收货」时就把货记进了库存
      // （收货即入库），因此质检判退在实现上表现为「生成退货单 + 反向出库」，
      // 而不是「入库前先扣掉判退量」。两条路都能走通，差别只在质检窗口期内
      // 待判货物是否计入可用库存；改成「质检后才入库」需要动收货→库存的整条链路，
      // 单独作为一步更安全，故此处先保证「单据分开 + 判退有后果」。
      ['inspect', '质量检验', 'INS', 'quality.inspect', 1],
      ['inbound', '库存过账', 'PO', 'purchase.inbound', 1],
      ['invoice', '采购发票校验', 'PI', 'purchase.invoice.verify', 1],
      ['settle', '三单匹配结算', 'PST', 'purchase.settle.edit', 1],
      ['payment', '付款核销', 'PAY', 'purchase.payment.approve', 0]
    ]
  },
  {
    // 模块 08A：报价不是「发个消息」，是订单的前置单据。
    // 这条流把「取价 → 有效期 → 审批 → 信用 → 转单」串成一条链，
    // 让「这个价是谁批的、按什么政策算的、什么时候过期、转成了哪张单」一次能查全。
    code: 'FLOW_SALES_QUOTE',
    name: '销售报价转订单流程',
    doc_type: 'QT',
    module: 'sales',
    remark: '报价取价 → 有效期与最低限价校验 → 审批 → 信用与账期校验 → 转销售订单/订货单 → 发货 → 回款释放授信',
    steps: [
      ['quote', '编制报价单（含有效期）', 'QT', 'sales.quote.view', 1],
      ['price', '按客户取价与最低限价校验', 'QT', 'sales.quote.edit', 1],
      ['approve', '报价审批（超折扣/低于限价）', 'QT', 'sales.quote.approve', 0],
      ['credit', '信用与账期校验', 'QT', 'credit.view', 1],
      ['convert', '转销售订单 / 订货单', 'SO', 'sales.quote.convert', 1],
      ['delivery', '发货出库', 'DL', 'sales.outbound', 1],
      ['settle', '回款核销并释放授信', 'SO', 'credit.manage', 0]
    ]
  },
  {
    // 模块 21：钱的路必须和货的路一样能追。
    // 销售订单确认时生成应收单（谁欠我多少），钱到账开收款单并核销（这笔钱抵了哪几笔），
    // 核销生效才释放授信 —— 「发了货钱没到，额度仍被占着」这条口径靠这条流落地。
    code: 'FLOW_RECEIVABLE',
    name: '应收与收款核销流程',
    doc_type: 'AR',
    module: 'finance',
    remark: '销售订单/订货单 → 应收单 → 收款单 → 核销分摊（FIFO） → 释放授信 → 账龄与对账',
    steps: [
      ['generate', '由销售订单生成应收', 'AR', 'finance.receipt.view', 1],
      ['due', '到期日与账期计算', 'AR', 'finance.receipt.view', 1],
      ['receipt', '登记收款单', 'RCP', 'finance.receipt.edit', 1],
      ['confirm', '收款确认（核销生效）', 'RCP', 'finance.receipt.approve', 1],
      ['release', '释放授信占用', 'RCP', 'credit.manage', 0],
      ['statement', '客户对账与账龄', 'AR', 'finance.receipt.view', 0]
    ]
  },
  {
    code: 'FLOW_SALES',
    name: '销售主流程',
    doc_type: 'SO',
    module: 'sales',
    remark: '报价 → 销售订单 → 发货单 → 出库过账 → 开票 → 退货',
    steps: [
      ['start', '销售订单创建', 'SO', 'order.place', 1],
      ['credit', '信用校验', 'SO', 'sales.order.view', 1],
      ['confirm', '订单确认', 'SO', 'order.confirm', 1],
      ['delivery', '发货出库', 'DL', 'sales.outbound', 1],
      ['invoice', '开具销售发票', 'SI', 'sales.invoice.edit', 1],
      ['complete', '订单完成', 'SO', 'sales.outbound', 1],
      ['return', '售后退货', 'SR', 'sales.return', 0]
    ]
  },
  {
    // 模块 24：把「货发了」与「票开了」分成两件事。
    // 发货出库确认了事实（货走了），开票确认了债权（可以收款了）。
    // 企业里这两件事常常错期（月结开票、汇总开票），所以必须各自有单据、各自有状态；
    // 应收的来源口径也因此多了一个选择：按订单确认生成（SO）还是按开票生成（SI）。
    code: 'FLOW_SALES_INVOICE',
    name: '销售开票流程',
    doc_type: 'SI',
    module: 'sales',
    remark: '发货出库 → 开具发票 → 确认开票 → 生成/关联应收 → 收款核销 → 开票关闭',
    steps: [
      ['deliver', '发货出库', 'DL', 'sales.outbound', 1],
      ['invoice', '开具销售发票', 'SI', 'sales.invoice.edit', 1],
      ['confirm', '确认开票（债权成立）', 'SI', 'sales.invoice.approve', 1],
      ['receivable', '生成/关联应收', 'AR', 'finance.receipt.edit', 1],
      ['receipt', '收款核销', 'RCP', 'finance.receipt.edit', 1],
      ['red_chart', '红冲（开错票的回头路）', 'SI', 'sales.invoice.approve', 0],
      ['close', '开票关闭', 'SO', 'sales.invoice.approve', 0]
    ]
  },
  {
    // 模块 13：质检第一次成为**独立流程**，而不是采购或生产的附属动作。
    // 三种来源（采购到货 / 生产完工 / 在库复检）汇总到同一条链上，
    // 于是「判退了多少、让步了多少、报废了多少」第一次能按供应商、按产品、
    // 按工序分别统计 —— 以前这些数字散在各自的单据备注里，谁也算不出来。
    code: 'FLOW_QUALITY',
    name: '质量检验流程',
    doc_type: 'QCR',
    module: 'quality',
    remark: '报检（采购到货/生产完工/在库复检）→ 抽样 → 检验判定 → 不良品分流（让步/退货/报废/返工）→ 关闭',
    steps: [
      ['request', '报检', 'QCR', 'quality.request.create', 1],
      ['sample', '抽样方案（n/Ac/Re）', 'QCR', 'quality.qc.view', 1],
      ['inspect', '检验与判定', 'QCI', 'quality.inspect', 1],
      ['handle', '不良品处理（有库存后果）', 'DH', 'quality.handle.approve', 0],
      ['close', '关闭报检单', 'QCR', 'quality.qc.view', 0]
    ]
  },
  {
    code: 'FLOW_STORE_REQ',
    name: '门店要货流程',
    doc_type: 'YQ',
    module: 'requisition',
    remark: '门店要货 → 总部受理 → 分配/转单 → 发货 → 门店收货',
    steps: [
      ['start', '门店要货单', 'YQ', 'pos.store.requisition', 1],
      ['process', '总部受理', 'YQ', 'pos.store.requisition', 1],
      ['branch', '分配库存或转采购', 'YQ', 'pos.store.requisition', 1],
      ['ship', '门店发货', 'SH', 'pos.store.requisition', 1],
      ['receive', '门店收货', 'YQ', 'pos.store.requisition', 1]
    ]
  },
  {
    code: 'FLOW_DEALER_ORDER',
    name: '经销商订货流程（订货中心）',
    doc_type: 'DR',
    module: 'dealer',
    remark: '渠道订货 → 取价/信用校验 → 审批 → 转销售订单 → 发货 → 对账',
    steps: [
      ['start', '渠道提交要货', 'DR', 'order.place', 1],
      ['price', '按渠道取价与信用校验', 'DR', 'master.price.view', 1],
      ['approve', '订货审批', 'DR', 'dms.dealer.approve', 1],
      ['convert', '转销售订单', 'SO', 'order.confirm', 1],
      ['ship', '发货', 'DL', 'sales.outbound', 1],
      ['statement', '对账', 'DS', 'order.statement.view', 1]
    ]
  },
  {
    code: 'FLOW_POS',
    name: '门店零售流程',
    doc_type: 'PS',
    module: 'pos',
    remark: '收银开单（可离线）→ 门店库存扣减 → 交班报数 → 店长核款 → 日结 → 上传总部',
    steps: [
      ['open', '开班', 'PSF', 'pos.shift', 1],
      ['sale', '扫码收银', 'PS', 'pos.cashier', 1],
      // 交班与核款**拆成两步**：原来只有「交班」一步，于是「钱数了两遍」这件事
      // 在流程图上根本不存在，长短款没有出生的地方。
      ['declare', '交班报数', 'PSF', 'pos.shift', 1],
      ['approve', '店长核款', 'PSF', 'pos.shift.review', 1],
      ['daily', '日结交款', 'RC', 'pos.dailyclose', 1],
      ['sync', '上传总部', 'PS', 'pos.cashier', 1]
    ]
  },
  {
    code: 'FLOW_PRODUCE',
    name: '生产与委外流程',
    doc_type: 'MO',
    module: 'produce',
    remark: '净需求 → BOM 展开 → 生产订单/委外订单 → 领料发料 → 完工入库 → 质检 → 成本归集',
    steps: [
      ['start', '生产/委外订单', 'MO', 'produce.order.edit', 1],
      // BOM 展开是**生产相对于委外的独有前置**：不知道用多少料就不知道该领多少。
      // 委外订单可以只带供货目录，所以本步对委外不强制。
      ['bom', 'BOM 展开需求', 'MO', 'produce.bom.view', 1],
      ['approve', '订单审批', 'MO', 'produce.order.view', 1],
      // 领料与发料拆成两个节点：生产领料（MR）是送到自己的车间，
      // 委外发料（WM）是送给供应商加工 —— 一个进生产成本、一个进委外加工费。
      // 原来两步共用 'WM' 一步，导致自制生产的领料在流程图上被画成「委外发料」。
      ['issue', '生产领料', 'MR', 'produce.issue', 1],
      ['issue-out', '委外发料', 'WM', 'produce.issue', 0],
      ['complete', '完工入库', 'MO', 'produce.receipt', 1],
      // 质检指向 QCR（报检单，模块 13）而非原来的 WR（委外收货单）——
      // WR 是委外到货，与「生产完工后检验」根本不是一件事。
      ['inspect', '质量检验', 'QCR', 'quality.inspect', 0]
    ]
  },
  {
    // 模块 12A：订货中心把「门店要货」与「经销商订货」合成一条流。
    // 两条旧流（FLOW_STORE_REQ / FLOW_DEALER_ORDER）保留，供存量单据追溯；
    // 新单一律走这条，避免同一件事在两条流里各有一套口径。
    code: 'FLOW_ORDER_CENTER',
    name: '订货中心主流程（门店 + 经销商统一订货）',
    doc_type: 'OC',
    module: 'order-center',
    remark: '客户准入 → 可见商品与取价 → 下单前校验（信用/账期/起订）→ 按规则审批 → 智能分仓 → 发货 → 签收 → 对账',
    steps: [
      ['admit', '客户准入', 'OC', 'dms.dealer.approve', 1],
      ['catalog', '可见商品与按客户取价', 'OC', 'master.price.view', 1],
      ['check', '下单前校验（授信/账期/起订量）', 'OC', 'order.place', 1],
      ['approve', '按规则审批', 'OC', 'order.confirm', 0],
      ['allocate', '智能分仓', 'OC', 'order.confirm', 1],
      ['ship', '发货出库', 'DL', 'sales.outbound', 1],
      ['receive', '客户签收', 'OC', 'order.view', 1],
      ['statement', '在线对账', 'OCS', 'order.statement.view', 0]
    ]
  },
  {
    // 模块 27（批次 H）：业财一体 —— 把业务事实翻译成借贷分录。
    // 这条流刻意**从"业务已完成"开始**：它不改业务，只把已经发生的事记账。
    // 所以它的每一步都必须是幂等的（同一张来源单不能入两次账）。
    code: 'FLOW_VOUCHER',
    name: '业财一体凭证流程',
    doc_type: 'VOUCHER',
    module: 'finance',
    remark: '业务事实成立（入库/出库/收付款）→ 按模板取数 → 借贷试算平衡 → 生成凭证 → 过账 → 计入试算平衡表',
    steps: [
      ['fact', '业务事实成立', 'VOUCHER', 'finance.voucher.view', 1],
      ['generate', '按模板生成凭证（不平即拒绝）', 'VOUCHER', 'finance.voucher.gen', 1],
      ['balance', '试算平衡校验', 'VOUCHER', 'finance.voucher.gen', 1],
      ['post', '凭证过账', 'VOUCHER', 'finance.voucher.post', 1],
      ['trial', '试算平衡表', 'VOUCHER', 'finance.voucher.view', 0]
    ]
  },
  {
    // 批次 J：退款单 —— 把退货时登记的「待退款」兑现成一次真实的出账。
    // 这条流补的是 D1 只做到一半的那一环：
    //   退货（冲应收 / 登记 refund_due）→ **登记退款单** → **确认退款（出账）** → 生成凭证。
    // 关键的两步分离：`登记` 与 `确认出账`。前者是录单，后者是放钱。
    code: 'FLOW_REFUND',
    name: '退款单流程（退货待退款兑现）',
    doc_type: 'RFD',
    module: 'finance',
    remark: '销售退货登记待退款 → 登记退款单（分摊到退货单）→ 校验不超过待退款额 → 确认退款（出账）→ 生成记账凭证',
    steps: [
      ['due', '退货登记待退款（refund_due）', 'RFD', 'finance.refund.view', 1],
      ['create', '登记退款单（分摊到退货单）', 'RFD', 'finance.refund.edit', 1],
      ['limit', '校验不超过待退款额', 'RFD', 'finance.refund.edit', 1],
      ['confirm', '确认退款（出账）', 'RFD', 'finance.refund.approve', 1],
      ['voucher', '生成记账凭证', 'VOUCHER', 'finance.voucher.gen', 0]
    ]
  }
]

module.exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_types (
      code          TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      module        TEXT NOT NULL,
      table_name    TEXT NOT NULL,
      doc_no_prefix TEXT,
      has_lines     INTEGER NOT NULL DEFAULT 1,
      status_field  TEXT NOT NULL DEFAULT 'status',
      doc_no_field  TEXT NOT NULL DEFAULT 'doc_no',
      sort_order    INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'active',
      remark        TEXT
    );

    CREATE TABLE IF NOT EXISTS doc_states (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type    TEXT NOT NULL,
      code        TEXT NOT NULL,
      name        TEXT NOT NULL,
      kind        TEXT NOT NULL,                  -- draft / active / done / void
      is_initial  INTEGER NOT NULL DEFAULT 0,
      is_final    INTEGER NOT NULL DEFAULT 0,
      sort_order  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (doc_type, code)
    );

    CREATE TABLE IF NOT EXISTS doc_actions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type         TEXT NOT NULL,
      action           TEXT NOT NULL,
      action_name      TEXT NOT NULL,
      from_state       TEXT NOT NULL,
      to_state         TEXT NOT NULL,
      perm_code        TEXT,
      require_approval INTEGER NOT NULL DEFAULT 0,
      is_danger        INTEGER NOT NULL DEFAULT 0,   -- 高危动作（对齐 MCP danger 级）
      sort_order       INTEGER NOT NULL DEFAULT 0,
      UNIQUE (doc_type, action, from_state)
    );

    CREATE TABLE IF NOT EXISTS biz_flows (
      code      TEXT PRIMARY KEY,
      name      TEXT NOT NULL,
      doc_type  TEXT,
      module    TEXT,
      status    TEXT NOT NULL DEFAULT 'active',
      remark    TEXT
    );

    CREATE TABLE IF NOT EXISTS biz_flow_steps (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_code      TEXT NOT NULL,
      seq            INTEGER NOT NULL,
      node_type      TEXT NOT NULL,
      node_name      TEXT NOT NULL,
      doc_type       TEXT,
      perm_code      TEXT,
      is_required    INTEGER NOT NULL DEFAULT 1,
      condition_json TEXT,
      remark         TEXT,
      UNIQUE (flow_code, seq)
    );

    -- 单据流转留痕：谁、何时、把哪张单从什么状态推到什么状态
    -- 这是「全链路可联查」的最小实现：单据上的 doc_events 就是它的一生
    CREATE TABLE IF NOT EXISTS doc_events (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type     TEXT NOT NULL,
      doc_id       INTEGER,
      doc_no       TEXT,
      action       TEXT NOT NULL,
      action_name  TEXT,
      from_state   TEXT,
      to_state     TEXT NOT NULL,
      actor_id     INTEGER,
      actor_name   TEXT,
      source       TEXT NOT NULL DEFAULT 'api',   -- api / mcp / seed / system
      remark       TEXT,
      payload_json TEXT,
      org_id       INTEGER,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE INDEX IF NOT EXISTS idx_doc_events_doc  ON doc_events(doc_type, doc_id, id);
    CREATE INDEX IF NOT EXISTS idx_doc_events_no   ON doc_events(doc_no);
    CREATE INDEX IF NOT EXISTS idx_doc_events_time ON doc_events(created_at);
    CREATE INDEX IF NOT EXISTS idx_doc_states_type ON doc_states(doc_type, sort_order);
    CREATE INDEX IF NOT EXISTS idx_doc_actions_typ ON doc_actions(doc_type, from_state);
  `)

  // ---------- 灌定义（幂等：先删后插，定义表无业务数据） ----------
  db.exec('DELETE FROM doc_states')
  db.exec('DELETE FROM doc_actions')
  db.exec('DELETE FROM biz_flow_steps')
  db.exec('DELETE FROM biz_flows')

  const insType = db.prepare(`
    INSERT INTO doc_types (code,name,module,table_name,doc_no_prefix,has_lines,doc_no_field,sort_order,remark)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name, module=excluded.module, table_name=excluded.table_name,
      doc_no_prefix=excluded.doc_no_prefix, has_lines=excluded.has_lines,
      doc_no_field=excluded.doc_no_field, sort_order=excluded.sort_order
  `)
  // 少数单据的单号字段不叫 doc_no（商城订单是平台单号、门店日结是批次号），单独声明
  const DOC_NO_FIELD = { OM: 'platform_order_no', RC: 'batch_no' }
  for (const [code, name, module, table, prefix, hasLines, sort] of DOC_TYPES) {
    insType.run(code, name, module, table, prefix, hasLines, DOC_NO_FIELD[code] || 'doc_no', sort, null)
  }

  const insState = db.prepare(`
    INSERT INTO doc_states (doc_type,code,name,kind,is_initial,is_final,sort_order)
    VALUES (?,?,?,?,?,?,?)
  `)
  for (const [docType, list] of Object.entries(STATES)) {
    list.forEach(([code, name, kind, isInit, isFinal], i) => {
      insState.run(docType, code, name, kind, isInit, isFinal, (i + 1) * 10)
    })
  }

  const insAction = db.prepare(`
    INSERT OR IGNORE INTO doc_actions
      (doc_type,action,action_name,from_state,to_state,perm_code,is_danger,sort_order)
    VALUES (?,?,?,?,?,?,?,?)
  `)
  for (const [docType, list] of Object.entries(ACTIONS)) {
    list.forEach(([action, actionName, from, to, perm, danger], i) => {
      insAction.run(docType, action, actionName, from, to, perm, danger, (i + 1) * 10)
    })
  }

  const insFlow = db.prepare(`
    INSERT OR REPLACE INTO biz_flows (code,name,doc_type,module,remark) VALUES (?,?,?,?,?)
  `)
  const insStep = db.prepare(`
    INSERT INTO biz_flow_steps (flow_code,seq,node_type,node_name,doc_type,perm_code,is_required)
    VALUES (?,?,?,?,?,?,?)
  `)
  for (const f of FLOWS) {
    insFlow.run(f.code, f.name, f.doc_type, f.module, f.remark)
    f.steps.forEach(([nodeType, nodeName, dt, perm, required], i) => {
      insStep.run(f.code, i + 1, nodeType, nodeName, dt, perm, required)
    })
  }

  // ---------- 权限点对齐 ----------
  // 状态机引用的权限码必须真实存在于 permissions 表，否则将来用 requirePerm
  // 校验流转时会「有定义、无权限点」而全部失配。这里把缺的补进注册表，
  // 已有权限点（模块 05 建立的 66 个）保持原样不动。
  const permExists = db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?')
  const permInsert = db.prepare(
    'INSERT INTO permissions (code,name,module,sort_order) VALUES (?,?,?,?)'
  )
  const permTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='permissions'")
    .get()
  let permAdded = 0
  if (permTable) {
    const used = new Set()
    for (const list of Object.values(ACTIONS)) for (const row of list) if (row[4]) used.add(row[4])
    for (const f of FLOWS) for (const s of f.steps) if (s[3]) used.add(s[3])
    for (const code of used) {
      if (permExists.get(code)) continue
      permInsert.run(code, code, code.split('.')[0], 900)
      permAdded += 1
    }
  }

  // 定义指纹：定义改了（哪怕不违反任何结构不变量）也能被自检发现并重跑，
  // 否则会出现「代码里加了流转边、库里没有」这种不报错的静默缺失
  const fingerprint = stampDef(db, '008_doc_kernel', { DOC_TYPES, STATES, ACTIONS, FLOWS })

  return {
    doc_types: DOC_TYPES.length,
    doc_states: Object.values(STATES).reduce((n, l) => n + l.length, 0),
    doc_actions: Object.values(ACTIONS).reduce((n, l) => n + l.length, 0),
    biz_flows: FLOWS.length,
    perms_added: permAdded,
    fingerprint
  }
}

// 结构自检：内核表存在、定义已灌且自洽（供 runner 自愈）
//
// 注意这里不只是「表在不在」，还校验一条**状态机不变量**：
//   被标为终态的状态不能有出边。
// 这不是洁癖 —— 定义本身写错时（例如把「已完成」标成终态，但它其实还能退货）
// 界面就会把按钮全禁掉，而这属于「数据错了」而非「代码错了」，只有自检能发现。
// 因此修改 STATES/ACTIONS 定义后，重跑迁移即可自动纠正库里的定义。
module.exports.verify = function verify(db) {
  const need = ['doc_types', 'doc_states', 'doc_actions', 'biz_flows', 'biz_flow_steps', 'doc_events']
  for (const t of need) {
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
    if (!row) return false
  }
  const n = db.prepare('SELECT COUNT(*) c FROM doc_actions').get().c
  if (!n) return false

  // 不变量一：终态不能有出边
  const badFinal = db
    .prepare(
      `SELECT COUNT(*) c FROM doc_actions a
       JOIN doc_states s ON s.doc_type=a.doc_type AND s.code=a.from_state
       WHERE s.is_final=1`
    )
    .get().c
  if (badFinal > 0) return false

  // 不变量二：每条边的起止状态都必须已定义
  const orphan = db
    .prepare(
      `SELECT COUNT(*) c FROM doc_actions a
       WHERE NOT EXISTS (SELECT 1 FROM doc_states s WHERE s.doc_type=a.doc_type AND s.code=a.from_state)
          OR NOT EXISTS (SELECT 1 FROM doc_states s WHERE s.doc_type=a.doc_type AND s.code=a.to_state)`
    )
    .get().c
  if (orphan > 0) return false

  // 不变量三：每个单据类型恰有一个初始状态
  const badInit = db
    .prepare(
      `SELECT COUNT(*) c FROM (
         SELECT doc_type, SUM(is_initial) s FROM doc_states GROUP BY doc_type HAVING s<>1
       )`
    )
    .get().c
  if (badInit > 0) return false

  // 不变量四：定义指纹一致（定义增删改后必须重跑同步到库里）
  if (defStale(db, '008_doc_kernel', { DOC_TYPES, STATES, ACTIONS, FLOWS })) return false

  return true
}
