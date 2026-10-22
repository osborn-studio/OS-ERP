'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/027_transition_policy.cjs ｜ 迁移：流转入口闸门（通用流转默认拒绝 + 效果归属声明）
 * ============================================================================
 * 【职责】迁移：流转入口闸门（通用流转默认拒绝 + 效果归属声明）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 027 流转入口闸门：每个单据类型「能不能被通用流转入口直接驱动」要写成数据
//
// 背景（验收复核 A01，P0）：
//   `POST /api/docflow/transition` 是一个**通用**的状态变更入口 —— 传 doc_type + id + action
//   就能改任何单据的状态。它只有 `requireAuth`，而内核 `applyTransition()` 只做三件事：
//   校验这条边存在、改状态字段、写留痕。**它不知道这条边有没有业务后果**。
//
//   于是这个入口可以做出一批「状态对了、账不对」的单据：
//     · SO 直接 ship   —— 库存没出库、成本没结转，单子却是「已发货」；
//     · RCP 直接 confirm —— 应收没核销，钱「收了」但账上还挂着；
//     · MR 直接 issue  —— 材料没出库，生产成本凭空少一截；
//     · POS 直接核款   —— 现金长短款没记。
//   更麻烦的是这些单**不会报错**：它们只是一批看起来正常的单据，而所有下游报表
//   都建立在这个状态上。等发现时已经无法分辨「哪几张是走正门进来的」。
//
// 为什么不能"在代码里列一张危险动作清单"：
//   ① 清单会过期 —— 新增单据类型 / 新增流转边时没人会想起来改它，漏了就是静默开口子；
//   ② 判定分散 —— "哪些边有后果"这件事会被写成散落的 if，与内核
//      「合法流转是数据，不是散落的 if」这条既有设计相冲突。
//   所以做成一张**策略表**：默认拒绝、逐类型放开。新增单据类型不写策略 = 自动拒绝（fail-closed）。
//
// 判定次序（由 lib/docflow.js 的 dispatchTransition 执行）：
//   ① 代码里登记了「效果归属」→ **委托给归属的业务服务**（与从前门进来的那次执行完全同一段代码）；
//   ② 策略表 allow_generic=1 → 走内核（仅限**纯状态、无业务后果**的单据类型）；
//   ③ 其余 → 409，并在报错里指出应当走哪个业务入口。
//
// 为什么单开一张表、而不是给 doc_types 加列：
//   `doc_types` 是定义表，008 的 up() 是「先 DELETE 再 INSERT」的同步写法，
//   整库重建或 008 自愈重跑时**会把行整行替换掉** —— 加在它上面的策略列会被连值一起抹掉。
//   策略必须活在它自己的表里，才不会被别人的同步重灌顺手清掉。

const { tableExists, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '流转入口闸门（通用流转默认拒绝 + 效果归属声明）'

// ---------------------------------------------------------------------------
// 策略数据：[doc_type, allow_generic, effect_owner, note]
//
// allow_generic 的语义要写清楚：**"这个单据类型的流转是纯状态变更，改了它不会让任何账目/库存/额度失衡"**。
//   判据不是"这条边看起来简单"，而是"少做这件事，系统里没有任何数字会因此变错"。
//   所以目前三库**一条都没有放开** —— 连 PRQ 的 `convert`（转采购订单）也在内：
//   走通用入口把状态改成 converted 并不会真的生成 PO，PRQ 会显示"已转单"而 PO 不存在。
//   这是个刻意的、偏严的起点：要放开某个类型，把 allow_generic 置 1 即可（数据配置，不改代码）。
//
// effect_owner 用于**报错指路**。一个"功能被拒绝"却没有指路消息的接口，等于把坑丢给调用方；
//   写清归属入口，调用方（人或其他 Agent）才知道该走哪扇门。
//
// ⚠️ **本表与 008 是一对**：008 的 `DOC_TYPES` 里每多一个类型，这里就必须多一行 POLICY。
//   漏补的后果**不是报错、而是每次启动一次无意义的自愈**：
//   `verify()` 的不变量一要求「内核已注册的每个类型都有策略行」，而 `up()` 只会把 POLICY 里的行 upsert 进去 ——
//   补不出缺失那一行 ⇒ `verify()` 恒假 ⇒ runner 每启动一次就重跑一次 `up()`（A3 实测形状）。
//   所以「改一处必须改两处」；带审批的边还要再补 `014_approval.cjs` 的 `GATED_EDGES`。
//   本表的 `up()` 用的是 `ON CONFLICT(doc_type) DO UPDATE`（upsert），所以在**已迁移过的库**上
//   改策略内容是能收敛的（改完重跑一次即可）；这也正是它没有踩 041 那个 `OR IGNORE` 坑的原因。
// ---------------------------------------------------------------------------
const POLICY = [
  // ---- 采购域 ----
  ['PO', 0, '采购订单接口 POST /api/purchase/orders/:id/:action', '审批占额度、close 关闭未收量'],
  ['GR', 0, '采购入库接口 POST /api/purchase/receipts/:id/:action', '确认即入库，产生库存与成本流水'],
  ['PRT', 0, '采购退货接口 POST /api/purchase/returns/:id/:action', '完成即出库，冲减库存与暂估'],
  ['PRQ', 0, '请购单接口 POST /api/purchase/requisitions/:id/:action', 'convert 必须真的生成采购订单，不能只改状态'],
  ['PI', 0, '采购发票接口 POST /api/purchase/invoices/:id/:action', '过账形成应付、作废要冲销'],
  ['PST', 0, '采购结算接口 POST /api/purchase/settlements/:id/:action', '审核/结清会重算已付与暂估差异'],
  ['PAY', 0, '付款单接口 POST /api/purchase/payments/:id/:action', 'pay 即核销，直接改写结算单已付金额'],
  ['INS', 0, '到货检验接口（采购域 /api/purchase）', '判定结果决定批次可用性与是否入库'],
  // ---- 销售域 ----
  ['QT', 0, '报价单接口 /api/sales（报价）', 'convert 生成订单并占用额度'],
  ['SO', 0, '销售订单接口 /api/sales/orders', '确认占库存与授信、发货出库、取消释放——三条边都有后果'],
  ['DL', 0, '发货单接口 /api/sales/deliveries', '发货出库并结转成本'],
  ['SR', 0, '销售退货接口 /api/sales/returns', '退货入库并冲减应收'],
  ['SI', 0, '销售发票接口 POST /api/invoices/:id/:action', '开票与红冲改写应收'],
  // ---- 质量域 ----
  ['QCR', 0, '质检接口 /api/qc', '报检关闭决定后续检验'],
  ['QCI', 0, '质检接口 /api/qc', '检验结论决定合格/不合格处置'],
  ['DH', 0, '质检接口 /api/qc', '处置必须有库存后果（退货/报废/让步）'],
  // ---- 库存域 ----
  ['TF', 0, '库存接口 /api/inventory（调拨）', '调拨出库+入库两步，跨仓数量守恒'],
  ['CK', 0, '库存接口 /api/inventory（盘点）', '差异调整直接入账，改账面数量'],
  ['AS', 0, '库存接口 /api/inventory（组装拆卸）', '拆装即库存形态变换'],
  ['CA', 0, '成本接口 /api/costing（成本调整）', '确认才有效果，回写出库成本'],
  // ---- 财务域 ----
  ['AR', 0, '应收接口 /api/ar', '分配/作废改写债权'],
  ['RCP', 0, '应收接口 /api/ar（收款）', '确认即核销应收、回收授信'],
  // ---- 要货 / 门店 ----
  ['YQ', 0, '要货接口 /api/requisitions', 'transfer/allocate 要真的生成采购/调拨单'],
  ['SH', 0, '要货接口 /api/requisitions（门店发货）', '发货出库并推进要货单'],
  // ---- 生产 / 委外 ----
  ['MO', 0, '生产接口 /api/manufacture', '完工入库、关闭余量'],
  ['WW', 0, '委外接口 /api/outsourcing', '发料出库、收货入库'],
  ['WM', 0, '委外接口 /api/outsourcing（委外发料）', '发料即出库'],
  ['WR', 0, '委外接口 /api/outsourcing（委外收货）', '收货即入库'],
  ['MR', 0, '生产接口 /api/manufacture（领料）', '领料出库并归集材料成本'],
  // ---- 平台 / 门店零售 ----
  ['OM', 0, 'OMS 接口 /api/oms', '退款/取消回写平台与库存'],
  ['PS', 0, 'POS 接口 /api/pos', '作废要退库存与支付'],
  ['PSF', 0, 'POS 接口 /api/pos（交班）', '长短款结账写入现金账'],
  ['RC', 0, 'POS 接口 /api/pos（日结）', '确认即封账，当日不再变动'],
  // ---- 经销商 ----
  ['DR', 0, '经销商接口 /api/dealers', 'convert 生成订货单'],
  ['DS', 0, '经销商接口 /api/dealers（对账单）', '确认即对账成立'],
  ['RB', 0, '经销商接口 /api/dealers（返利）', '支付即核销返利余额'],
  // ---- 订货中心 ----
  ['OC', 0, '订货中心接口 /api/order-center/orders/:id/:action', '占用/释放授信、分仓、收货并应收'],
  ['OCS', 0, '订货中心接口 /api/order-center（对账）', '结清/作废改写货款状态'],
  // ---- 财务凭证（模块 27 · 批次 H）----
  // 它是本项目里唯一**由别人产生**的单据：来源由 (biz_type, source_type, source_id) 唯一决定，
  // 没有"新建"入口。所以策略行的写法是"过账即入账、作废即出账"。
  ['VOUCHER', 0, '财务中心接口 POST /api/accounting/vouchers/:id/(post|void)', '过账才计入试算平衡；作废会改变当期发生额且必须写理由'],
  // ---- 退款单（模块财务 · 批次 J）----
  // 它与收款单同属"动钱"的单据，但方向相反（钱出去）。策略行必须写清
  // "确认即出账"这条后果，否则状态流转会被当成改个字段。
  ['RFD', 0, '退款单接口 POST /api/refunds/:id/(confirm|void)', '确认即出账（终态）；作废已退款会改变账务且必须写理由']
]

// 放开通用入口的白名单（当前为空）。留在这里是为了：
// ① 让"要放开哪一类"这件事有唯一的落点；② 自检能断言它是**显式**的少数派（见 verify 的不变量二）。
const GENERIC_ALLOWED = []

module.exports.up = function up(db) {
  if (!tableExists(db, 'doc_types')) {
    throw new Error('doc_types 不存在，无法建立流转策略；迁移顺序有误，应先执行 008_doc_kernel')
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_transition_policy (
      doc_type      TEXT PRIMARY KEY,
      allow_generic INTEGER NOT NULL DEFAULT 0,
      effect_owner  TEXT,
      note          TEXT,
      updated_at    TEXT
    )
  `)
  const upsert = db.prepare(
    `INSERT INTO doc_transition_policy (doc_type, allow_generic, effect_owner, note, updated_at)
     VALUES (?,?,?,?,datetime('now','localtime'))
     ON CONFLICT(doc_type) DO UPDATE SET
       allow_generic=excluded.allow_generic,
       effect_owner=excluded.effect_owner,
       note=excluded.note,
       updated_at=excluded.updated_at`
  )
  for (const [code, allow, owner, note] of POLICY) upsert.run(code, allow ? 1 : 0, owner || null, note || null)

  // 策略表里出现、但内核没注册的单据类型 = 拼写错误，会静默失效。
  // 这类错不会报错、只会"这条策略从来没生效"，所以在这里直接拦住。
  const unknown = db
    .prepare(
      `SELECT p.doc_type FROM doc_transition_policy p
        WHERE NOT EXISTS (SELECT 1 FROM doc_types t WHERE t.code=p.doc_type)`
    )
    .all()
  if (unknown.length) {
    throw new Error(`流转策略引用了未注册的单据类型：${unknown.map((r) => r.doc_type).join(', ')}`)
  }

  stampDef(db, '027_transition_policy', { POLICY, GENERIC_ALLOWED })
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'doc_transition_policy')) return false

  // 不变量一：内核已注册的每个单据类型都必须有策略行。
  // 漏一行的后果是"这个类型永远走不了通用入口"（fail-closed，安全），
  // 但会让人把"策略没写"误读成"策略禁止" —— 所以这里要求写全，让拒绝是**声明过的**拒绝。
  const missing = db
    .prepare(
      `SELECT t.code FROM doc_types t
        WHERE NOT EXISTS (SELECT 1 FROM doc_transition_policy p WHERE p.doc_type=t.code)`
    )
    .all()
  if (missing.length) return false

  // 不变量二：放开通用入口的必须是**显式声明的少数派**，且不能是带 dangerous 边的类型。
  // 这条防的是"顺手把某个类型放开"——一旦放开，那个类型的所有边都能只改状态不动账。
  const allowed = db
    .prepare('SELECT doc_type FROM doc_transition_policy WHERE allow_generic=1 ORDER BY doc_type')
    .all()
    .map((r) => r.doc_type)
  if (allowed.join(',') !== [...GENERIC_ALLOWED].sort().join(',')) return false
  for (const code of allowed) {
    const danger = db
      .prepare('SELECT COUNT(*) c FROM doc_actions WHERE doc_type=? AND is_danger=1')
      .get(code).c
    if (danger > 0) return false
  }

  // 不变量三：没有归属入口的类型也不该被放开（否则报错文案会指向空）
  const noOwner = db
    .prepare("SELECT COUNT(*) c FROM doc_transition_policy WHERE effect_owner IS NULL AND allow_generic=0")
    .get().c
  if (noOwner > 0) return false

  if (defStale(db, '027_transition_policy', { POLICY, GENERIC_ALLOWED })) return false
  return true
}
