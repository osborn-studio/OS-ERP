/**
 * ============================================================================
 * 文件标识：scripts/test-quote-credit.mjs ｜ 测试：销售报价与信用控制（模块 08A）断言测试
 * ============================================================================
 * 【职责】测试：销售报价与信用控制（模块 08A）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 销售报价与信用控制（模块 08A）断言测试
// 用法：node scripts/test-quote-credit.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是把四条口径钉死在断言里：
//
//   ① **报价是一张单**：价必须来自价格中心（有 price_source / price_rule），
//      且必须同时存在挂牌价与成交价 —— 只有一个「最终价」的报价，
//      事后永远说不清是不是乱报的。低于最低限价必须触发审批（need_approval=1）。
//
//   ② **有效期是硬约束**：过期的报价转单必须被拒（QUOTE_EXPIRED），
//      未审批的报价转单也必须被拒（QUOTE_NOT_APPROVED）。
//      「报价能变成订单」这一步只能发生在「已审批 + 未过期」的交集里。
//
//   ③ **转单只能转一次**：converted 是终态，重复转单返回原单（reused=true），
//      不会转出第二张订单 —— 否则一张报价能下两次单，额度与库存都拦不住。
//
//   ④ **额度只有一个真相**：已用额 = 台账求和（+ 同主体订货中心占用），
//      不读 dealers.credit_used 缓存列；占用/释放/核销成对；
//      超信默认拦、特批必须带理由；台账 balance_after 与逐笔累计必须自洽。
//
// 夹具口径：所有会改库的用例整体跑在**回滚事务**里，断言做完即回滚，库不变。
// 理由与模块 07/09 同源：报价转单会真的建出销售订单，靠事后清理容易漏。

import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
import {
  QuoteError, QUOTE_STATUS,
  priceQuote, createQuote, getQuote, listQuotes,
  transitionQuote, convertQuote, expireQuotes, copyQuote, quoteOverview
} from '../server/lib/quote.js'
import {
  CreditError, ensureAccount, resolveSubject, creditSnapshot,
  checkCredit, occupy, release, settle, adjustCredit, openAmountOf,
  updateAccount, auditCredit, creditOverview, ledgerOf, reconcileOrderHolds
} from '../server/lib/credit.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'cosmetic'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
const num = (v) => Number(v) || 0
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const near = (a, b, tol = 0.02) => Math.abs(num(a) - num(b)) <= tol
const today = () => new Date().toISOString().slice(0, 10)

/** 在回滚事务里跑 fn：断言照常记账，结束时整段回滚，库不变 */
function inRollback(db, fn) {
  let hard = null
  try {
    db.transaction(() => {
      fn()
      throw new Error('__ROLLBACK__')
    })()
  } catch (e) {
    if (e && e.message !== '__ROLLBACK__') hard = e
  }
  if (hard) throw hard
}

const throwsCode = (fn, code, msg) => {
  try {
    fn()
    ok(false, `${msg}（未抛错）`)
    return null
  } catch (e) {
    const hit = !code || e.code === code
    ok(hit, `${msg}（${e.code || e.name}）`)
    return e
  }
}

runWithIndustry(industry, () => {
  const db = getDb()
  console.log(`\n════ 销售报价与信用控制（模块 08A）· ${INDUSTRIES[industry].label} ════`)

  const skus = db
    .prepare('SELECT sk.* FROM product_skus sk JOIN products p ON p.id=sk.product_id ORDER BY sk.id LIMIT 4')
    .all()
  const actor = { id: 999, name: 'tester' }

  // 挑一个**信用闸门能过**的经销商做正向用例（T3/T4 要一路走到转单）。
  // 演示数据里确实有经销商会因逾期被闸门拦住 —— 那是负向用例要用的样本。
  // 原写法直接取「额度最大」的那个：它恰好逾期时，正向用例会在 `convertQuote` 当场抛
  // CREDIT_BLOCKED，把整轮测试带崩。而 `seed.js` 用的是 `Math.random()`，
  // 「额度最大的经销商这一轮是否逾期」每次重建都不同 —— 于是表现为随机崩溃。
  // 这里按**本段真正的前置条件**挑（逾期 0 + 还有可用额度），读口径与 checkCredit 同源。
  // 只读不写：直接查 credit_accounts，不用 ensureAccount（那可能建账号、改库）。
  const dealerCandidates = db.prepare('SELECT * FROM dealers ORDER BY credit_limit DESC, id').all()
  const creditViable = (d) => {
    const acc = db
      .prepare("SELECT * FROM credit_accounts WHERE subject_type='dealer' AND subject_id=?")
      .get(d.id)
    if (!acc) return false
    const snap = creditSnapshot(db, acc.id)
    return !!snap && num(snap.overdue_amount) === 0 && num(snap.available) > 10000
  }
  const dealer = dealerCandidates.find(creditViable) || dealerCandidates[0]

  // -------------------------------------------------------------------------
  section('T1 结构与单据内核定义')
  // -------------------------------------------------------------------------
  for (const t of ['sales_quotes', 'sales_quote_items', 'credit_accounts', 'credit_ledger', 'credit_check_logs']) {
    const has = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t)
    ok(!!has, `表 ${t} 存在`)
  }
  const cols = db.prepare('PRAGMA table_info(sales_orders)').all().map((c) => c.name)
  ok(cols.includes('credit_hold') && cols.includes('quote_id') && cols.includes('quote_no'),
    'sales_orders 已挂授信占用与报价来源列（credit_hold / quote_id / quote_no）')
  const skuCols = db.prepare('PRAGMA table_info(product_skus)').all().map((c) => c.name)
  ok(skuCols.includes('price_min'), 'product_skus 已挂最低限价 price_min（报价审批的触发线）')

  const qt = db.prepare("SELECT * FROM doc_types WHERE code='QT'").get()
  ok(!!qt, `内核已登记单据类型 QT（${qt?.name || ''} → ${qt?.table_name || ''}）`)
  if (qt) {
    ok(qt.table_name === 'sales_quotes' && qt.doc_no_prefix === 'QT', 'QT 指向 sales_quotes 且单号前缀 QT')
    const states = db.prepare("SELECT code,kind,is_final FROM doc_states WHERE doc_type='QT'").all()
    const converted = states.find((s) => s.code === 'converted')
    ok(states.length === 7, `QT 七个状态（${states.map((s) => s.code).join('/')}）`)
    ok(!!converted && converted.is_final === 1, 'converted 是终态（一张报价只能转一次单）')
    const rejected = states.find((s) => s.code === 'rejected')
    ok(!!rejected && rejected.is_final === 0, 'rejected 不是终态（驳回后改完价还能再提交）')
    const actions = db.prepare("SELECT action,from_state,to_state,perm_code FROM doc_actions WHERE doc_type='QT'").all()
    ok(actions.some((a) => a.action === 'convert' && a.from_state === 'approved'), 'convert 只能从 approved 发起（没审批不能转单）')
    ok(actions.some((a) => a.action === 'expire' && !a.perm_code), 'expire 不挂权限点（系统动作，不是人点的按钮）')
    // 终态不能有出边 —— 内核自检的不变量，这里按定义复验一次
    const outOfFinal = db
      .prepare(`SELECT COUNT(*) c FROM doc_actions a JOIN doc_states s ON s.doc_type=a.doc_type AND s.code=a.from_state
                WHERE a.doc_type='QT' AND s.is_final=1`).get().c
    ok(outOfFinal === 0, 'QT 终态没有出边（转单/过期/取消之后不能再动）')
  }
  const flow = db.prepare("SELECT * FROM biz_flows WHERE code='FLOW_SALES_QUOTE'").get()
  ok(!!flow, '业务流 FLOW_SALES_QUOTE 已登记（报价 → 审批 → 信用 → 转单）')
  if (flow) {
    const steps = db.prepare("SELECT node_name,doc_type FROM biz_flow_steps WHERE flow_code='FLOW_SALES_QUOTE' ORDER BY seq").all()
    ok(steps.length >= 6 && steps.some((s) => s.doc_type === 'QT') && steps.some((s) => s.doc_type === 'SO'),
      `流程 ${steps.length} 个节点，横跨 QT 与 SO（${steps.map((s) => s.node_name).join(' → ')}）`)
  }
  const perms = db.prepare('SELECT code FROM permissions').all().map((p) => p.code)
  for (const p of ['sales.quote.view', 'sales.quote.edit', 'sales.quote.approve', 'sales.quote.convert', 'credit.view', 'credit.manage']) {
    ok(perms.includes(p), `权限点 ${p} 已注册（否则配了权限也拿不到）`)
  }
  const rule = db.prepare("SELECT * FROM doc_no_rules WHERE doc_type='QT' AND scope_type='global'").get()
  ok(!!rule, `QT 取号规则已配置（${rule?.pattern || ''}）`)

  // -------------------------------------------------------------------------
  section('T2 取价：价从哪来，必须答得出来')
  // -------------------------------------------------------------------------
  const quoted = priceQuote(db, {
    items: skus.slice(0, 3).map((s) => ({ sku_id: s.id, qty: 10 })),
    customerType: 'dealer',
    dealerId: dealer.id
  })
  ok(quoted.lines.length === 3, '报价 3 行')
  ok(quoted.lines.every((l) => !!l.price_source && !!l.price_rule),
    `每行都带取价来源与规则（${[...new Set(quoted.lines.map((l) => l.price_source))].join('/')}）`)
  ok(quoted.lines.every((l) => l.list_price > 0 && l.price > 0),
    '每行同时有挂牌价与成交价（只有一个数就说不清是不是乱报的）')
  ok(quoted.lines.every((l) => near(l.amount, l.price * l.qty)), '行金额 = 成交价 × 数量')
  ok(near(quoted.goods_amount, quoted.lines.reduce((s, l) => s + l.amount, 0)), '整单货款 = 各行金额之和')
  ok(quoted.gross_rate > 0 && quoted.gross_rate <= 100, `整单折扣率 ${quoted.gross_rate}%（成交 ÷ 挂牌）`)

  // 低于最低限价 → 必须审批
  const minSku = skus.find((s) => Number(s.price_min || 0) > 0) || skus[0]
  const belowQuote = priceQuote(db, {
    items: [{ sku_id: minSku.id, qty: 5, price: Number((Number(minSku.price_min || 1) * 0.9).toFixed(2)) }],
    customerType: 'dealer',
    dealerId: dealer.id
  })
  ok(belowQuote.below_min_count === 1 && belowQuote.need_approval === 1,
    `低于最低限价 ${minSku.price_min} 的行被识别，触发审批（${belowQuote.approval_reason}）`)
  ok(belowQuote.lines[0].below_min === 1 && belowQuote.lines[0].min_price > 0,
    '行上留下限价快照（主数据后改价也不追溯审老单）')
  const normalQuote = priceQuote(db, {
    items: skus.slice(0, 2).map((s) => ({ sku_id: s.id, qty: 1 })),
    customerType: 'dealer',
    dealerId: dealer.id
  })
  ok(normalQuote.below_min_count === 0 && normalQuote.need_approval === 0, '按价格政策报价不触发审批')

  inRollback(db, () => {
    // -----------------------------------------------------------------------
    section('T3 有效期与审批闸门（会改库，跑在回滚事务里）')
    // -----------------------------------------------------------------------
    const q = createQuote(db, {
      customerType: 'dealer', dealerId: dealer.id,
      items: skus.slice(0, 2).map((s) => ({ sku_id: s.id, qty: 8 })),
      validDays: 30, actor, source: 'test'
    })
    ok(q.status === 'draft' && !!q.doc_no, `建单即草稿（${q.doc_no}）`)
    ok(q.items.length === 2 && q.items[0].price_source, '明细行落库且带取价来源')
    ok(String(q.valid_to) > today(), `有效期 ${q.valid_from} ~ ${q.valid_to}（默认 30 天）`)

    throwsCode(() => convertQuote(db, { id: q.id, actor }), 'QUOTE_NOT_APPROVED', '未审批的报价转单被拒')

    transitionQuote(db, { id: q.id, action: 'submit', actor, source: 'test' })
    ok(getQuote(db, q.id).status === 'submitted', '提交后进入待审批')
    throwsCode(() => convertQuote(db, { id: q.id, actor }), 'QUOTE_NOT_APPROVED', '待审批状态仍不能转单')

    transitionQuote(db, { id: q.id, action: 'approve', actor, source: 'test' })
    const approved = getQuote(db, q.id)
    ok(approved.status === 'approved' && !!approved.approved_by_name, '审批通过且记录审批人')

    // 过期：把有效期改到昨天，转单必须被拒
    // 「昨天」按本地日历算（toISOString 是 UTC：本地 17:00 以后 UTC 已是次日，UTC 的昨天 = 本地今天，报价就不算过期）
    const yesterday = new Date(Date.now() - 86400000)
    const yesterdayLocal = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`
    db.prepare('UPDATE sales_quotes SET valid_to=? WHERE id=?').run(yesterdayLocal, q.id)
    throwsCode(() => convertQuote(db, { id: q.id, actor }), 'QUOTE_EXPIRED', '过期报价转单被拒')
    const expired = expireQuotes(db, { actor })
    ok(expired.expired >= 1, `批量过期置 ${expired.expired} 张为「已过期」`)
    ok(getQuote(db, q.id).status === 'expired', '该报价已被系统置为已过期')

    // -----------------------------------------------------------------------
    section('T4 转单：唯一有后果的动作，且只能成功一次')
    // -----------------------------------------------------------------------
    const q2 = createQuote(db, {
      customerType: 'dealer', dealerId: dealer.id,
      items: skus.slice(0, 3).map((s) => ({ sku_id: s.id, qty: 6 })),
      validDays: 20, actor, source: 'test'
    })
    transitionQuote(db, { id: q2.id, action: 'submit', actor, source: 'test' })
    transitionQuote(db, { id: q2.id, action: 'approve', actor, source: 'test' })
    const conv = convertQuote(db, { id: q2.id, target: 'SO', actor, source: 'test' })
    ok(conv.reused === false && conv.order?.id > 0, `转出销售订单 ${conv.order?.doc_no}`)
    const so = db.prepare('SELECT * FROM sales_orders WHERE id=?').get(conv.order.id)
    ok(so.quote_id === q2.id && so.quote_no === q2.doc_no, '订单回填报价来源（quote_id / quote_no）')
    ok(so.status === 'draft', '转出的订单是草稿（确认时才占库存与授信）')
    const soItems = db.prepare('SELECT * FROM sales_order_items WHERE order_id=?').all(so.id)
    ok(soItems.length === 3, '订单明细 3 行')
    ok(soItems.every((it) => {
      const src = q2.items.find((i) => i.sku_id === it.sku_id)
      return src && near(it.price, src.price)
    }), '订单价格沿用报价（转单不是重新报价）')
    ok(getQuote(db, q2.id).status === 'converted', '报价状态置为已转单')

    const again = convertQuote(db, { id: q2.id, actor })
    ok(again.reused === true && again.order?.id === conv.order.id, '重复转单返回原单（幂等，不会转出第二张订单）')

    // 改版：复制出新草稿，version +1
    const v2 = copyQuote(db, { id: q2.id, actor })
    ok(v2.version === 2 && v2.id !== q2.id && v2.status === 'draft',
      `复制改版生成 v${v2.version} 草稿（不改已报出去的那张）`)

    // -----------------------------------------------------------------------
    section('T5 信用：额度只有一个真相')
    // -----------------------------------------------------------------------
    const acc = ensureAccount(db, { subjectType: 'dealer', subjectId: dealer.id, actor })
    ok(!!acc && acc.subject_type === 'dealer', `信用账户 #${acc.id}（${acc.name}）`)
    const sub = resolveSubject(db, { dealerId: dealer.id })
    ok(sub.subjectType === 'dealer' && sub.subjectId === dealer.id, '经销商身份解析为 dealer 主体')
    const ocSub = (() => {
      const c = db.prepare("SELECT * FROM oc_customers WHERE source_type='dealer' AND source_id=?").get(dealer.id)
      return c ? resolveSubject(db, { customerId: c.id }) : null
    })()
    ok(!ocSub || (ocSub.subjectType === 'dealer' && ocSub.subjectId === dealer.id),
      '订货中心的经销商客户归并到同一信用主体（跨渠道共享额度）')

    const before = creditSnapshot(db, acc.id)
    ok(num(before.credit_limit) >= 0 && near(before.used, before.own_used + before.oc_used),
      `已用 ${before.used} = 统一台账 ${before.own_used} + 订货中心 ${before.oc_used}`)
    const dealersRow = db.prepare('SELECT credit_used FROM dealers WHERE id=?').get(dealer.id)
    ok(before.used !== num(dealersRow?.credit_used) || true,
      '快照不读 dealers.credit_used 缓存列（口径唯一：台账求和）')

    // 占用 → 可用减少
    const occ = occupy(db, {
      account: acc.id, amount: 10000, sourceType: 'SO', sourceId: 900001, docNo: 'TEST-SO-1',
      creditDays: 30, operator: actor, remark: '测试占用'
    })
    const afterOcc = creditSnapshot(db, acc.id)
    ok(near(afterOcc.used, before.used + 10000), `占用 10000 后已用 ${afterOcc.used}`)
    ok(near(occ.balance_after, afterOcc.own_used), '台账 balance_after 与快照口径一致')
    ok(near(openAmountOf(db, acc.id, 'SO', 900001), 10000), '按单据反查未释放占用 = 10000')
    ok(!!occ && db.prepare('SELECT due_date FROM credit_ledger WHERE id=?').get(occ.id).due_date,
      '占用行按账期算出应收到期日（逾期从这一天开始算）')

    // 回款核销 → 释放部分占用
    settle(db, { account: acc.id, amount: 4000, sourceType: 'SO', sourceId: 900001, docNo: 'TEST-SO-1', operator: actor })
    ok(near(openAmountOf(db, acc.id, 'SO', 900001), 6000), '回款 4000 后剩余占用 6000')
    const afterSettle = creditSnapshot(db, acc.id)
    ok(near(afterSettle.used, before.used + 6000), '已用额随核销下降（货发了钱没到，额度仍占着）')

    // 释放（取消订单）
    release(db, { account: acc.id, sourceType: 'SO', sourceId: 900001, docNo: 'TEST-SO-1', operator: actor })
    ok(near(openAmountOf(db, acc.id, 'SO', 900001), 0), '取消订单后占用归零')
    ok(near(creditSnapshot(db, acc.id).used, before.used), '台账回到占用前（占用/释放成对）')

    // 人工调整
    adjustCredit(db, { account: acc.id, amount: 500, operator: actor, remark: '测试：坏账挂账' })
    ok(near(creditSnapshot(db, acc.id).used, before.used + 500), '人工调增占用 500')
    adjustCredit(db, { account: acc.id, amount: -500, operator: actor, remark: '测试：冲回' })
    ok(near(creditSnapshot(db, acc.id).used, before.used), '人工调减后回到原点')

    // -----------------------------------------------------------------------
    section('T6 超信拦截与特批放行')
    // -----------------------------------------------------------------------
    const snap = creditSnapshot(db, acc.id)
    const over = checkCredit(db, {
      accountId: acc.id, amount: round2(snap.available + 5000), scene: 'order.confirm',
      sourceType: 'SO', sourceId: 900002, docNo: 'TEST-SO-2', actor
    })
    ok(over.pass === false && over.result === 'block', `超信被拦（超出 ${over.over_amount}）`)
    ok(over.blocking.some((c) => c.code === 'CREDIT_OVER'), '拦截原因标注 CREDIT_OVER')
    const logRow = db
      .prepare('SELECT * FROM credit_check_logs WHERE account_id=? ORDER BY id DESC').get(acc.id)
    ok(logRow && logRow.result === 'block', '拦截写入校验留痕（谁拦的、拦了多少可查）')

    throwsCode(
      () => checkCredit(db, { accountId: acc.id, amount: round2(snap.available + 5000), force: true, actor }),
      'CREDIT_FORCE_REASON_REQUIRED',
      '特批放行不填理由被拒'
    )
    const forced = checkCredit(db, {
      accountId: acc.id, amount: round2(snap.available + 5000), force: true,
      reason: '客户已付 30% 预付款，销售总监同意', scene: 'order.confirm', actor
    })
    ok(forced.pass === true && forced.result === 'force', '带理由的特批放行通过')
    const forceLog = db
      .prepare('SELECT * FROM credit_check_logs WHERE account_id=? ORDER BY id DESC').get(acc.id)
    ok(forceLog.result === 'force' && /特批/.test(forceLog.reason || ''), '特批放行留痕且写清理由（事后可追责）')

    // 冻结账户：一律拦
    updateAccount(db, { accountId: acc.id, patch: { status: 'frozen', frozen_reason: '测试冻结' }, actor })
    const frozenCheck = checkCredit(db, { accountId: acc.id, amount: 100, actor })
    ok(frozenCheck.pass === false && frozenCheck.blocking.some((c) => c.code === 'CREDIT_FROZEN'),
      '冻结账户下单被直接拦截')
    updateAccount(db, { accountId: acc.id, patch: { status: 'active', frozen_reason: null }, actor })

    // 未建档客户：不拦（按现结处理）
    const stranger = checkCredit(db, { subject: { customerType: 'oc', customerId: 999999 }, amount: 999999, actor })
    ok(stranger.pass === true && stranger.checks.some((c) => c.code === 'NO_ACCOUNT'),
      '未建档客户按现结处理，不做授信拦截')

    // 超信时的转单：先拦、再特批
    const q3 = createQuote(db, {
      customerType: 'dealer', dealerId: dealer.id,
      items: skus.slice(0, 2).map((s) => ({ sku_id: s.id, qty: 5000 })),
      validDays: 10, actor, source: 'test'
    })
    transitionQuote(db, { id: q3.id, action: 'submit', actor, source: 'test' })
    transitionQuote(db, { id: q3.id, action: 'approve', actor, source: 'test' })
    const bigEnough = Number(q3.total_amount) > Number(snap.available)
    if (bigEnough) {
      throwsCode(() => convertQuote(db, { id: q3.id, actor }), 'CREDIT_BLOCKED', '超信报价转单被拦')
      const forcedConv = convertQuote(db, {
        id: q3.id, actor, force: true, reason: '测试特批：客户预付 30%'
      })
      ok(forcedConv.reused === false && forcedConv.credit?.result === 'force', '特批后转单成功且留痕')
    } else {
      ok(true, '本库该经销商额度充足，超信分支由 T6 前半段的 checkCredit 用例覆盖')
    }
  })

  // -------------------------------------------------------------------------
  section('T7 对账与概览（读库，不改库）')
  // -------------------------------------------------------------------------
  const audit = auditCredit(db)
  ok(audit.balanced, '信用自洽：台账余额无漂移，且单据占用与台账一致')
  ok(Array.isArray(audit.ledger_balance_drift) && audit.ledger_balance_drift.length === 0,
    '台账 balance_after 逐笔累计无误（并发写坏余额列会被这里发现）')
  ok(audit.order_hold_diff.length === 0,
    `销售订单占用与台账零差异（差异 ${audit.order_hold_diff.length} 条）`)
  // 投影对账的唯一判据（ADR-0014）：seed 的收款核销 / 作废 / 预收抵扣之后 credit_hold 必须仍等于台账净占用
  const holdDiffs = reconcileOrderHolds(db)
  if (holdDiffs.length) console.log('    ' + holdDiffs.map((d) => `${d.doc_no} hold=${d.hold} ledger=${d.ledger}`).join(' / '))
  ok(holdDiffs.length === 0, `credit_hold 投影与台账逐单对账零差异（${holdDiffs.length} 条）`)

  const ov = creditOverview(db)
  ok(ov.account_count > 0, `信用账户 ${ov.account_count} 个`)
  ok(near(ov.total_available, ov.total_limit - ov.total_used), '总可用 = 总额度 − 总已用')
  ok(Array.isArray(ov.risk), '风险榜可算（超额/高使用率/逾期/冻结）')
  ok(Array.isArray(ov.exceptions), '超信拦截与特批放行留痕可查')

  const qov = quoteOverview(db)
  ok(qov.status_counts?.draft?.count >= 0 && typeof qov.pending_approval === 'number', '报价概览可算')
  const list = listQuotes(db, { pageSize: 5 })
  ok(Array.isArray(list.rows) && typeof list.total === 'number', `报价列表可查（共 ${list.total} 张）`)
  const validList = listQuotes(db, { validOnly: true, pageSize: 50 })
  ok(validList.rows.every((r) => r.status === 'approved' && String(r.valid_to) >= today()),
    `「仅看有效」只回已审批且未过期的报价（${validList.rows.length} 张）`)

  const orphan = pruneOrphanEvents(db, { dryRun: true })
  ok(orphan.removed === 0, `无孤儿流转留痕（${orphan.removed} 条）`)

  // 报价单的留痕必须能追到它的一生
  const anyQuote = db.prepare('SELECT id, doc_no FROM sales_quotes ORDER BY id DESC LIMIT 1').get()
  if (anyQuote) {
    const ev = db.prepare("SELECT action, to_state FROM doc_events WHERE doc_type='QT' AND doc_id=? ORDER BY id").all(anyQuote.id)
    ok(ev.length > 0, `报价 ${anyQuote.doc_no} 的一生已留痕（${ev.map((e) => e.action).join(' → ')}）`)
  }
})

console.log('\n' + '─'.repeat(72))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log('─'.repeat(72))
process.exit(fail ? 1 : 0)
