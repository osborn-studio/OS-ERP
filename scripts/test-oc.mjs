/**
 * ============================================================================
 * 文件标识：scripts/test-oc.mjs ｜ 测试：订货中心（模块 12A）断言测试
 * ============================================================================
 * 【职责】测试：订货中心（模块 12A）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 订货中心（模块 12A）断言测试
// 用法：node scripts/test-oc.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是六条硬设计点有没有真的落地：
//   ① 价格因人而异      ④ 对账是主功能
//   ② 下单前必须校验    ⑤ 智能分仓
//   ③ 审批是有条件的    ⑥ 多端多种下单方式（含历史复制）
// 外加两条账实一致性：授信台账 = 单据占用；状态流转不可绕过。
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { seedOrderCenter } from '../server/db/oc-seed.js'
import {
  ensureCustomer, getCustomer, customerTree, creditSnapshot,
  visibleSkus, quoteItems, checkOrder, decideApproval, pickWarehouse, customerWarehouseIds,
  createOrder, getOrder, transitionOrder, buildStatement, getStatement,
  settleStatement, confirmStatement, statementBalance, closeStatement, voidStatement,
  OC_SETTLE_TOLERANCE,
  overview, OrderCenterError
} from '../server/lib/order-center.js'
// 仓库类型的**权威值域**（`lib/warehouse.js` 是唯一出处）。
// 本测试用它来断言"候选仓的类型合法" —— 守的正是"手写白名单里拼错字面量"那一类缺陷
// （`customerWarehouseIds` 原来把 `region` 写成 `regional`，于是区域仓被整类漏掉且不报错）。
import { WAREHOUSE_TYPE_CODES, isIsolationWarehouseType } from '../server/lib/warehouse.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'food'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
// 调一个**应当成功**的业务函数：失败不抛到顶层，返回 { ok, value, error }。
// 为什么要它：`ok()` 记红后**不会终止**，若后面直接调一个已经不该成立的动作
// （例如反例注入后，同一张对账单被结清了两次），未捕获异常会让整个脚本崩在堆栈上，
// 断言的红反而被堆栈盖住 —— 崩溃看起来像"脚本写错了"，而不是"实现被改坏了"。
const tryCall = (fn) => {
  try {
    return { ok: true, value: fn() }
  } catch (e) {
    return { ok: false, error: e }
  }
}

await runWithIndustry(industry, () => {
  const db = getDb()
  const actor = { id: null, name: 'tester' }

  // 保证有数据（幂等重灌）
  seedOrderCenter(db, { industry, silent: true })

  console.log(`\n订货中心测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))

  // ---------------------------------------------------------------
  section('T1 订货主体与多级渠道')
  const customers = db.prepare('SELECT * FROM oc_customers ORDER BY id').all()
  ok(customers.length > 0, `订货主体已建立（${customers.length} 个）`)
  ok(customers.every((c) => c.source_type), '每个主体都有来源类型')
  const dealers = customers.filter((c) => c.source_type === 'dealer')
  const direct = customers.filter((c) => c.channel === 'direct')
  const franchise = customers.filter((c) => c.channel === 'franchise')
  ok(dealers.length > 0, `经销商主体（${dealers.length} 个）`)
  ok(direct.length > 0, `直营门店主体（${direct.length} 个）`)
  ok(franchise.length > 0, `加盟门店主体（${franchise.length} 个）`)
  const children = customers.filter((c) => c.parent_customer_id)
  ok(children.length > 0, `多级渠道：下游终端门店（${children.length} 个）挂在经销商下`)
  if (children.length) {
    const tree = customerTree(db)
    const hasChild = JSON.stringify(tree).includes('"children":[{')
    ok(hasChild, '客户树能展开出下级')
  }
  // 直营门店走内部往来，不适用对外授信
  ok(direct.every((c) => c.settle_type === 'internal'), '直营门店口径为「内部往来」（不适用对外授信）')
  ok(franchise.every((c) => c.settle_type === 'credit'), '加盟门店口径为「账期客户」')

  // ---------------------------------------------------------------
  section('T2 价格因人而异（同一 SKU 不同客户不同价）')
  const skuId = db.prepare("SELECT id FROM product_skus WHERE price_retail>0 ORDER BY id LIMIT 1").get().id
  const groupByChannel = new Map()
  for (const c of customers) {
    const q = quoteItems(db, { customerId: c.id, items: [{ sku_id: skuId, qty: 1 }] })
    groupByChannel.set(c.channel, (groupByChannel.get(c.channel) || new Set()).add(q.lines[0].price))
  }
  const distinctChannels = [...groupByChannel.keys()]
  ok(distinctChannels.length >= 2, `至少两种订货渠道（${distinctChannels.join(' / ')}）`)
  const priceSets = distinctChannels.map((k) => [...groupByChannel.get(k)])
  const hasDiff = priceSets.some((s, i) => priceSets.some((t, j) => i !== j && s[0] !== t[0]))
  ok(hasDiff || distinctChannels.length === 1,
    hasDiff ? '不同渠道取到不同价格（取价引擎按客户维度生效）' : '各渠道同价（价格组未按渠道分裂，属可接受）')
  const q1 = quoteItems(db, { customerId: customers[0].id, items: [{ sku_id: skuId, qty: 1 }] })
  ok(q1.lines[0].price_source, `价格来源可追溯（${q1.lines[0].price_source}）`)
  ok(Array.isArray(q1.lines[0].price_trace) && q1.lines[0].price_trace.length > 0, '取价过程留痕（trace）')

  // ---------------------------------------------------------------
  section('T3 下单前必须校验')
  // 必须挑一个**账期客户**来测授信拦截 —— 现结/内部往来客户本就不该被额度拦，
  // 拿第一个经销商去测会在「现结为主」的行业里测出假失败。
  const creditCust =
    customers.find((c) => c.source_type === 'dealer' && c.settle_type === 'credit') ||
    customers.find((c) => c.settle_type === 'credit')
  ok(!!creditCust, `存在账期客户可测授信（${creditCust?.name}）`)
  const q = quoteItems(db, { customerId: creditCust.id, items: [{ sku_id: skuId, qty: 5 }] })
  const ck = checkOrder(db, { customerId: creditCust.id, quote: q })
  ok(Array.isArray(ck.checks), `校验返回检查项（${ck.checks.length} 项）`)
  ok(ck.checks.some((c) => c.code === 'INTERNAL' || c.code === 'PREPAY') || ck.creditHold > 0,
    '授信口径被识别（内部/现结/账期三选一）')
  // 硬拦：把客户额度改成 0，必须拒绝下单
  const originalLimit = creditCust.credit_limit
  db.prepare('UPDATE oc_customers SET credit_limit=0 WHERE id=?').run(creditCust.id)
  const ckZero = checkOrder(db, { customerId: creditCust.id, quote: q })
  ok(!ckZero.pass && ckZero.blocking.some((c) => c.code === 'NO_CREDIT'), '额度为 0 时被硬拦（NO_CREDIT）')
  let blocked = false
  try {
    createOrder(db, { customerId: creditCust.id, items: [{ sku_id: skuId, qty: 5 }], actor })
  } catch (e) {
    blocked = e instanceof OrderCenterError && e.code === 'PRE_CHECK_FAILED'
  }
  ok(blocked, '校验未通过时下单被拒绝（不可绕过）')
  // 还原成原值，不要写死一个数 —— 原额度可能是 120 万，写 100 万等于把客户额度改小了
  db.prepare('UPDATE oc_customers SET credit_limit=? WHERE id=?').run(originalLimit, creditCust.id)

  // 未准入也必须拦
  db.prepare("UPDATE oc_customers SET admit_status='frozen', frozen_reason='测试冻结' WHERE id=?").run(creditCust.id)
  const ckFrozen = checkOrder(db, { customerId: creditCust.id, quote: q })
  ok(ckFrozen.blocking.some((c) => c.code === 'FROZEN'), '冻结客户被硬拦（FROZEN）')
  db.prepare("UPDATE oc_customers SET admit_status='active', frozen_reason=NULL WHERE id=?").run(creditCust.id)

  // 起订金额
  db.prepare('UPDATE oc_customers SET min_order_amount=99999999 WHERE id=?').run(creditCust.id)
  const ckMin = checkOrder(db, { customerId: creditCust.id, quote: q })
  ok(ckMin.blocking.some((c) => c.code === 'MIN_AMOUNT'), '未达最小起订金额被拦（MIN_AMOUNT）')
  db.prepare('UPDATE oc_customers SET min_order_amount=0 WHERE id=?').run(creditCust.id)

  // ---------------------------------------------------------------
  section('T4 审批是有条件的')
  const bigQuote = {
    totalAmount: 300000, totalQty: 1000,
    lines: [{ line_no: 1, sku_id: skuId, qty: 1000, available_qty: 1000, sku_name: 'x' }]
  }
  const bigCheck = { creditHold: 300000, credit: { creditAvailable: 100000, overdueDays: 0 }, shortage: { lines: [] } }
  const apBig = decideApproval(db, { customerId: creditCust.id, quote: bigQuote, check: bigCheck })
  ok(apBig.needApproval, '大额订单触发审批')
  ok(apBig.chain.length >= 2, `命中多级审批链（${apBig.chain.map((c) => c.node).join(' → ')}）`)
  const smallQuote = {
    totalAmount: 100, totalQty: 1,
    lines: [{ line_no: 1, sku_id: skuId, qty: 1, available_qty: 1, sku_name: 'x' }]
  }
  const smallCheck = { creditHold: 100, credit: { creditAvailable: 100000, overdueDays: 0 }, shortage: { lines: [] } }
  const apSmall = decideApproval(db, { customerId: creditCust.id, quote: smallQuote, check: smallCheck })
  ok(!apSmall.needApproval, '小额订单免审批直通（审批不是「下单即成立」）')
  // 超授信必须触发特批
  const overCheck = { creditHold: 500000, credit: { creditAvailable: 100000, overdueDays: 0 }, shortage: { lines: [] } }
  const apOver = decideApproval(db, { customerId: creditCust.id, quote: bigQuote, check: overCheck })
  ok(apOver.chain.some((c) => c.node.includes('授信')), '超授信命中「授信特批」节点')

  // ---------------------------------------------------------------
  section('T5 智能分仓')
  const pick = pickWarehouse(db, { customerId: creditCust.id, quote: q })
  ok(pick && pick.warehouseId, `选出候选仓（${pick?.name}）`)
  ok(typeof pick.score === 'number' && pick.score >= 0 && pick.score <= 1, `打分为 0~1（${pick.score}）`)
  ok(Array.isArray(pick.detail) && pick.detail.length === q.lines.length, '分行给出可满足量明细')
  const sameCity = pick.proximity > 0.5
  ok(pick.proximity !== undefined, `就近度已计入（proximity=${pick.proximity}${sameCity ? ' 同城/同区' : ''}）`)

  // ---- 候选仓的**类型合法性**（守"手写白名单里拼错字面量"这一类）----
  // `customerWarehouseIds` 原来是 `WHERE type IN ('normal','regional','central','kitchen','consignment')`：
  // `regional` 拼错（真值 `region`）、`consignment` 不在值域 ⇒ **区域仓被整类漏掉**且不报错。
  // 现在它从 `lib/warehouse.js` 的值域派生，下面四条断言把这个口径钉住：
  const candIds = customerWarehouseIds(db, creditCust)
  ok(candIds.length > 0, `客户可达仓非空（${candIds.length} 个）`)
  const candTypes = candIds.length
    ? db.prepare(`SELECT DISTINCT type FROM warehouses WHERE id IN (${candIds.map(() => '?').join(',')})`).all(...candIds).map((r) => r.type)
    : []
  const badType = candTypes.filter((t) => !WAREHOUSE_TYPE_CODES.includes(t))
  ok(badType.length === 0, `候选仓类型都在权威值域里（异常：${badType.join(',') || '无'}）`)
  ok(!candTypes.some((t) => isIsolationWarehouseType(t)), `候选仓不含隔离仓（实得 ${candTypes.join('/') || '—'}）`)
  // ③ **区域仓不能被整类漏掉** —— 但要让这条**真跑**：库里确有 `type='region'` 的仓，
  //    它的 `region` 未必与本次客户一致 ⇒ 先临时对齐（**测完还原**），否则这条会被"跳过"而无牙
  //    （跳过 = 看着绿、其实什么都没验 —— 那正是我们不想要的断言形态）。
  const anyRegion = db.prepare("SELECT id, region FROM warehouses WHERE type='region' LIMIT 1").get()
  let candForRegion = candIds
  let restoredRegion = null
  if (anyRegion && anyRegion.region !== creditCust.region) {
    db.prepare('UPDATE warehouses SET region=? WHERE id=?').run(creditCust.region, anyRegion.id)
    restoredRegion = { id: anyRegion.id, region: anyRegion.region }
    candForRegion = customerWarehouseIds(db, creditCust)
  }
  try {
    if (anyRegion) {
      ok(candForRegion.includes(anyRegion.id),
        `区域仓（type='region'）在候选里（旧白名单把它拼成 'regional' ⇒ 会整类漏掉）`)
    } else {
      console.log('  （库里没有 type=region 的仓，第 ③ 条跳过）')
    }
  } finally {
    if (restoredRegion) db.prepare('UPDATE warehouses SET region=? WHERE id=?').run(restoredRegion.region, restoredRegion.id)
  }

  // ---------------------------------------------------------------
  section('T6 下单 → 流转 → 授信占用与释放')
  const before = creditSnapshot(db, creditCust.id)
  const created = createOrder(db, {
    customerId: creditCust.id, items: [{ sku_id: skuId, qty: 3 }], actor, source: 'test'
  })
  const oid = created.order.id
  ok(created.order.doc_no?.startsWith('OC'), `单号由编码规则生成（${created.order.doc_no}）`)
  ok(created.order.status === 'submitted', '提交后状态为已提交')
  const after = creditSnapshot(db, creditCust.id)
  ok(Math.abs((after.creditUsed - before.creditUsed) - created.order.total_amount) < 0.01,
    `下单占用授信 ${created.order.total_amount}（${before.creditUsed} → ${after.creditUsed}）`)

  // 非法流转被拒
  let illegal = false
  try { transitionOrder(db, { id: oid, action: 'ship', actor }) } catch { illegal = true }
  ok(illegal, '未审批不能直接发货（状态机拦住跳跃流转）')

  const approver = { id: null, name: 'approver' }
  for (let i = 0; i < 6; i += 1) {
    const r = transitionOrder(db, { id: oid, action: 'approve', actor: approver })
    if (!r.partial) break
  }
  ok(getOrder(db, oid).status === 'approved', '多级审批逐节点通过后 → 已审核')
  transitionOrder(db, { id: oid, action: 'allocate', actor })
  ok(getOrder(db, oid).status === 'allocated', '分仓 → 已分仓')
  ok(!!getOrder(db, oid).ship_warehouse_id, '分仓结果落到单据上')
  transitionOrder(db, { id: oid, action: 'ship', actor })
  transitionOrder(db, { id: oid, action: 'receive', actor })
  const afterRecv = creditSnapshot(db, creditCust.id)
  ok(Math.abs(afterRecv.creditUsed - after.creditUsed) < 0.01,
    '收货不释放授信（货发了钱没回，额度仍被占）')
  ok(getOrder(db, oid).credit_hold > 0, '收货后单据仍持有授信占用')
  transitionOrder(db, { id: oid, action: 'complete', actor })
  ok(getOrder(db, oid).status === 'completed', '完成 → 已完成（终态）')

  // 取消要释放授信
  const c2 = createOrder(db, { customerId: creditCust.id, items: [{ sku_id: skuId, qty: 2 }], actor, source: 'test' })
  const usedMid = creditSnapshot(db, creditCust.id).creditUsed
  transitionOrder(db, { id: c2.order.id, action: 'cancel', actor, remark: '测试取消' })
  const usedAfter = creditSnapshot(db, creditCust.id).creditUsed
  ok(Math.abs((usedMid - usedAfter) - c2.order.total_amount) < 0.01,
    `取消释放授信 ${c2.order.total_amount}（${usedMid} → ${usedAfter}）`)
  ok(getOrder(db, c2.order.id).credit_hold === 0, '取消后单据占用清零')

  // ---------------------------------------------------------------
  section('T7 账实一致：授信台账 = 单据占用')
  const ledgerSum = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger').get().s
  const holdSum = db.prepare('SELECT COALESCE(SUM(credit_hold),0) s FROM oc_orders WHERE credit_hold>0').get().s
  ok(Math.abs(ledgerSum - holdSum) < 0.01,
    `台账合计 ${Number(ledgerSum).toFixed(2)} = 在途占用合计 ${Number(holdSum).toFixed(2)}`)
  const mismatch = db
    .prepare(
      `SELECT COUNT(*) c FROM oc_customers c
       WHERE ABS(COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0)
               - COALESCE((SELECT SUM(credit_hold) FROM oc_orders o WHERE o.customer_id=c.id AND o.credit_hold>0),0)) > 0.01`
    )
    .get().c
  ok(mismatch === 0, `逐客户也一致（不一致客户数 ${mismatch}）`)
  const balanceOk = db
    .prepare(
      `SELECT COUNT(*) c FROM oc_credit_ledger l
       WHERE ABS(l.balance_after - (SELECT COALESCE(SUM(amount),0) FROM oc_credit_ledger x
                                    WHERE x.customer_id=l.customer_id AND x.id<=l.id)) > 0.01`
    )
    .get().c
  ok(balanceOk === 0, `台账逐行余额快照自洽（异常行 ${balanceOk}）`)

  // ---------------------------------------------------------------
  section('T8 对账（B2B 主功能）')
  const billable = db
    .prepare(
      `SELECT customer_id, COUNT(*) c FROM oc_orders WHERE status IN ('received','completed')
       GROUP BY customer_id HAVING c>=1 ORDER BY c DESC LIMIT 1`
    )
    .get()
  ok(!!billable, '存在可对账的已收货/已完成单据')
  if (billable) {
    const st = buildStatement(db, {
      customerId: billable.customer_id,
      periodStart: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
      actor
    })
    ok(st.id && st.order_count > 0, `对账单生成（${st.doc_no}，${st.order_count} 张单，${st.total_amount}）`)
    ok(Math.abs(st.total_amount - st.items.reduce((a, i) => a + i.amount, 0)) < 0.01, '对账单金额 = 明细行合计')
    const confirmed = confirmStatement(db, { id: st.id, actor })
    ok(confirmed.to === 'confirmed', '确认对账 → 已确认')
    let refused = false
    try {
      // 已确认过的单再确认应被状态机拒绝
      confirmStatement(db, { id: st.id, actor })
    } catch { refused = true }
    ok(refused, '重复确认被状态机拒绝')

    // 回款核销：一半
    const half = Number((st.total_amount * 0.5).toFixed(2))
    const usedBeforeRound = creditSnapshot(db, billable.customer_id).creditUsed
    const paidSt = settleStatement(db, { id: st.id, amount: half, actor, remark: '测试回款' })
    ok(Math.abs(paidSt.paid_amount - half) < 0.01, `登记回款 ${half} 后已收金额正确`)
    ok(Math.abs(paidSt.diff_amount - (st.total_amount - half)) < 0.01, '未收差额 = 总额 − 已收')
    const custRow = getCustomer(db, billable.customer_id)
    if (custRow.settle_type === 'credit') {
      const usedAfterRound = creditSnapshot(db, billable.customer_id).creditUsed
      ok(Math.abs((usedBeforeRound - usedAfterRound) - Math.min(half, usedBeforeRound)) < 0.01,
        `账期客户回款同步释放授信（${usedBeforeRound} → ${usedAfterRound}）`)
    } else {
      ok(creditSnapshot(db, billable.customer_id).creditUsed === usedBeforeRound,
        '非账期客户回款不动授信台账（避免凭空负余额）')
    }
    const ledgerSum2 = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger').get().s
    const holdSum2 = db.prepare('SELECT COALESCE(SUM(credit_hold),0) s FROM oc_orders WHERE credit_hold>0').get().s
    ok(Math.abs(ledgerSum2 - holdSum2) < 0.01, '回款后账实仍一致')

    // -------------------------------------------------------------
    // 终局动作：结清（必须收齐）/ 作废（不动底层台账）
    //
    // 前端「对账」页签**早就在渲染这两个按钮**（按钮来自内核 `allowedActions('OCS', status)`，
    // 而内核里 close/void 两条边本来就有），后端却一直没有路由 ⇒ 点了必然 404。
    // 下面同时守两条口径：①"钱没收齐也能标已结清"走不通；②作废只动凭证。
    // -------------------------------------------------------------
    const balHalf = statementBalance(db, st.id)
    ok(balHalf.diff_amount > OC_SETTLE_TOLERANCE, `样本未收齐（未收差额 ${balHalf.diff_amount}）`)

    // ① 未收齐且不 force ⇒ 拒绝
    let notSettled = false
    try { closeStatement(db, { id: st.id, actor }) } catch (e) { notSettled = e.code === 'STATEMENT_NOT_SETTLED' }
    ok(notSettled, '未收齐且不 force：结清被拒绝（STATEMENT_NOT_SETTLED）')
    ok(db.prepare('SELECT status FROM oc_statements WHERE id=?').get(st.id).status === 'confirmed', '被拒后状态不变')

    // ② force 但不写理由 ⇒ 仍拒绝（手动结清是显式越权，必须留理由）
    let needReason = false
    try { closeStatement(db, { id: st.id, actor, force: true }) } catch (e) { needReason = e.code === 'REASON_REQUIRED' }
    ok(needReason, '手动结清不写理由：被拒绝（REASON_REQUIRED）')

    // ③ 把剩下的收齐 ⇒ 自动结清（`settleStatement` 里 `diff <= 0.001` 的那条边）
    const rSettle = tryCall(() =>
      settleStatement(db, { id: st.id, amount: Number(balHalf.diff_amount.toFixed(2)), actor, remark: '测试：结清剩余' })
    )
    ok(rSettle.ok, `把剩余收齐${rSettle.ok ? '' : '：' + rSettle.error?.message}`)
    const stClosed = getStatement(db, st.id)
    ok(stClosed.status === 'closed', `收齐后自动结清（状态 ${stClosed.status}）`)

    // ④ 作废：另建一张，**先确认再作废**（守住本轮新加的 `confirmed → voided` 边）
    const st2 = buildStatement(db, {
      customerId: billable.customer_id,
      periodStart: new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10),
      periodEnd: new Date().toISOString().slice(0, 10),
      actor
    })
    confirmStatement(db, { id: st2.id, actor })
    const ORDSUM = "SELECT COALESCE(SUM(total_amount),0) s FROM oc_orders WHERE customer_id=? AND status IN ('received','completed')"
    const orderOpenBefore = db.prepare(ORDSUM).get(billable.customer_id).s
    const ledgerBefore = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger').get().s
    const itemsBefore = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM oc_statement_items WHERE statement_id=?').get(st2.id)

    let voidNeedReason = false
    try { voidStatement(db, { id: st2.id, actor }) } catch (e) { voidNeedReason = e.code === 'REASON_REQUIRED' }
    ok(voidNeedReason, '作废不写理由：被拒绝（REASON_REQUIRED）')

    const VOID_WHY = '测试：期间录错，重开一张'
    const voided = voidStatement(db, { id: st2.id, actor, reason: VOID_WHY })
    ok(voided.status === 'voided', `作废后状态 → voided（实际 ${voided.status}）`)
    ok(!!voided.voided_at && voided.voided_by === actor.name, '作废人与时间已落库')
    ok(voided.void_reason === VOID_WHY, '作废理由落在单据上（不只是事件流）')

    // 作废**只作废这份对账单凭证**：底层台账分毫不动
    ok(db.prepare(ORDSUM).get(billable.customer_id).s === orderOpenBefore, '作废不动订货单金额')
    ok(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger').get().s === ledgerBefore, '作废不动授信台账')
    const itemsAfter = db.prepare('SELECT COUNT(*) n, COALESCE(SUM(amount),0) s FROM oc_statement_items WHERE statement_id=?').get(st2.id)
    ok(itemsAfter.n === itemsBefore.n && itemsAfter.s === itemsBefore.s, '作废不动对账单明细')

    // 终态不可再流转 + 留痕
    let twice = false
    try { voidStatement(db, { id: st2.id, actor, reason: '再作废一次试试' }) } catch (e) { twice = e.code === 'TRANSITION_NOT_ALLOWED' }
    ok(twice, '已作废的对账单不能再作废（终态无出边）')
    const ocsEvents = db.prepare("SELECT * FROM doc_events WHERE doc_type='OCS' AND doc_id=? ORDER BY id").all(st2.id)
    ok(ocsEvents.some((e) => e.action === 'void' && e.from_state === 'confirmed' && e.to_state === 'voided'),
      '作废在 doc_events 留痕（confirmed → voided）')

    // ⑤ 终态守卫：已结清 / 已作废的对账单**不能再登记回款**，且报的是**业务话**。
    //   没有这道守卫时，它会一路走到末尾的自动结清、撞内核终态，报出
    //   「状态「已结清」已是终态，不能继续流转」—— 状态机的话，用户看不懂。
    const paidBefore5 = db.prepare('SELECT COALESCE(SUM(paid_amount),0) s FROM oc_statement_items WHERE statement_id=?').get(st.id).s
    const headBefore5 = db.prepare('SELECT paid_amount, diff_amount FROM oc_statements WHERE id=?').get(st.id)
    let errClosed = null
    try { settleStatement(db, { id: st.id, amount: 1, actor }) } catch (e) { errClosed = e }
    ok(errClosed?.code === 'TRANSITION_NOT_ALLOWED', `已结清的对账单登记回款 → 409（code=${errClosed?.code}）`)
    ok(/已结清/.test(errClosed?.message || '') && /登记回款/.test(errClosed?.message || ''),
      `文案是业务话（${errClosed?.message}）`)
    ok(!/已是终态，不能继续流转/.test(errClosed?.message || ''), '不再是状态机的话（"已是终态，不能继续流转"）')
    const headAfter5 = db.prepare('SELECT paid_amount, diff_amount FROM oc_statements WHERE id=?').get(st.id)
    ok(headBefore5.paid_amount === headAfter5.paid_amount, '被拒后对账单已收未变')
    ok(headBefore5.diff_amount === headAfter5.diff_amount, '被拒后对账单未收差额未变')
    ok(paidBefore5 === db.prepare('SELECT COALESCE(SUM(paid_amount),0) s FROM oc_statement_items WHERE statement_id=?').get(st.id).s,
      '被拒后明细已收未变（事务回滚）')

    let errVoided = null
    try { settleStatement(db, { id: st2.id, amount: 1, actor }) } catch (e) { errVoided = e }
    ok(errVoided?.code === 'TRANSITION_NOT_ALLOWED' && /已作废/.test(errVoided?.message || ''),
      `已作废的对账单登记回款同样是业务话（${errVoided?.message}）`)
  }

  // ---------------------------------------------------------------
  section('T9 多端下单方式与商品可见性')
  const rep = db.prepare("SELECT id FROM oc_orders WHERE status IN ('received','completed') LIMIT 1").get()
  if (rep) {
    const src = getOrder(db, rep.id)
    const items2 = src.items.map((i) => ({ sku_id: i.sku_id, qty: i.qty }))
    const again = createOrder(db, { customerId: src.customer_id, items: items2, actor, source: 'repeat', sourceRef: src.doc_no })
    ok(again.order.source === 'repeat' && again.order.source_ref === src.doc_no,
      `历史订单复制下单（source=${again.order.source}，引用 ${again.order.source_ref}）`)
    ok(again.order.status === 'submitted' || again.order.status === 'draft', '复制单为草稿或已提交')
  }
  const vis = visibleSkus(db, direct[0].id, { limit: 5 })
  ok(vis.length > 0, `商品目录按客户可见（${vis.length} 条）`)
  ok(vis.every((v) => v.price > 0), '目录内每行都带该客户的价格')
  const rules = db.prepare('SELECT * FROM oc_visibility_rules').all()
  if (rules.length) {
    const fr = franchise[0]
    const visFr = visibleSkus(db, fr.id, { limit: 500 })
    const visDirect = visibleSkus(db, direct[0].id, { limit: 500 })
    ok(visFr.length <= visDirect.length,
      `加盟店可见商品不多于直营（${visFr.length} ≤ ${visDirect.length}，可见性规则生效）`)
  }

  // ---------------------------------------------------------------
  section('T10 看板与业务流')
  const ov = overview(db)
  ok(ov.totals.orders > 0, `看板统计到订货单（${ov.totals.orders} 张 / ${ov.totals.amount}）`)
  ok(ov.totals.byStatus.length > 1, `状态分布跨多个状态（${ov.totals.byStatus.length} 种）`)
  ok(ov.customers.total > 0, `客户统计（${ov.customers.total} 个，其中已准入 ${ov.customers.active}）`)
  ok(Array.isArray(ov.pendingApproval), '待审批清单可读')
  ok(ov.flow && ov.flow.steps.length >= 6, `订货中心业务流已登记（${ov.flow?.steps.length} 个环节）`)
  ok(ov.types.some((t) => t.code === 'OC') && ov.types.some((t) => t.code === 'OCS'),
    '单据内核已登记 OC / OCS 两个类型')
  ok(Array.isArray(ov.creditRisk) && ov.creditRisk.every((r) => r.utilization >= 0), '授信风险榜可读')

  // ---------------------------------------------------------------
  section('T11 存量单据统一视图')
  const view = db.prepare("SELECT name FROM sqlite_master WHERE type='view' AND name='oc_orders_history'").get()
  ok(!!view, 'oc_orders_history 视图存在')
  if (view) {
    const h = db.prepare('SELECT origin, COUNT(*) c FROM oc_orders_history GROUP BY origin').all()
    ok(h.length > 0, `历史订货单可统一查看（${h.map((r) => `${r.origin}=${r.c}`).join(' ')}）`)
  }

  // ---------------------------------------------------------------
  section('T12 单据一生可查')
  const ev = db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='OC'").get().c
  ok(ev > 0, `订货单流转留痕（${ev} 条）`)
  const badEvents = db
    .prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='OC' AND to_state IS NULL")
    .get().c
  ok(badEvents === 0, '每条留痕都有目标状态')
  const lastOrder = db.prepare('SELECT id FROM oc_orders ORDER BY id DESC LIMIT 1').get()
  const detail = getOrder(db, lastOrder.id)
  ok(Array.isArray(detail.events) && detail.events.length > 0, '单张单据可追出完整流转轨迹')
  ok(Array.isArray(detail.actions), '单据返回当前可执行动作（供界面渲染按钮）')

  console.log('\n' + '─'.repeat(64))
  console.log(`通过 ${pass} / 失败 ${fail}`)
  if (fail) process.exitCode = 1
})
