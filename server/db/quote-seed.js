/**
 * ============================================================================
 * 文件标识：server/db/quote-seed.js ｜ 销售报价与信用控制演示数据（模块 08A）
 * ============================================================================
 * 【职责】销售报价与信用控制演示数据（模块 08A）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 销售报价与信用控制演示数据（模块 08A）
//
// 为什么不放在 seed.js 里：报价单引用经销商与商品、信用账户从经销商档案派生，
// 而 seed.js 会 DROP 这两张表；放进去会让「谁先谁后」变成隐式依赖。
// 独立脚本在 seedAll + seedOrgs + seedPricing + seedOrderCenter 之后跑，顺序是显式的。
//
// 幂等：每次先清空本次管辖的表再重建（结构不动，行重灌）。
// 清空顺序必须是「先留痕、后台账、再报价行、最后报价单」—— 反过来会留下一批
// 指向已删除单据的孤儿留痕（doc_events 跨表指向，删了主表它还在）。
//
// 演示要讲的四件事，每件事都在数据里留了一条证据：
//   ① 低于最低限价的报价必须审批 —— 一张 need_approval=1 的单，走完 submit → approve → convert
//   ② 过期的报价不能转单        —— 一张 valid_to 已过、状态仍是「已审批」的单（expired 由系统置）
//   ③ 超信会被拦住              —— 转换失败留痕（credit_check_logs.result='block'）
//   ④ 特批放行要署名            —— 同一张单带 force+reason 再转一次，留痕 result='force'

import { requireDemoDatabase } from './runtime-policy.js'
import { ensureAccount, updateAccount, occupy, settle, creditSnapshot, reprojectOrderHolds } from '../lib/credit.js'
import { createQuote, priceQuote, transitionQuote, convertQuote, expireQuotes, copyQuote } from '../lib/quote.js'
import { pruneOrphanEvents } from '../lib/docflow.js'
import { seedNow } from './seed-clock.js'
import { resetSequences } from './seq.js'

const ymd = (d) => new Date(d).toISOString().slice(0, 10)
const dayAgo = (n) => ymd(new Date(seedNow().getTime() - n * 86400000))

function clear(db) {
  const tables = ['credit_check_logs', 'credit_ledger', 'credit_accounts', 'sales_quote_items', 'sales_quotes']
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t}`).run() } catch { /* 表可能尚未建 */ }
  }
  // DELETE 不重置自增序列：credit_accounts.id 会被经销商侧引用（credit_accounts.subject_id
  // 与信用台账、报价单的 account_id），一轮一轮往上长会让整库不可复现。清表后一并重置。
  resetSequences(db, tables)
  // 销售订单上的授信占用列也一并归零：整批信用数据重灌后，
  // 上一代订单还记着「我占了 8 万」，对账会立刻报出差额。
  // 台账已清，按台账重投影自然全部归零（投影的唯一写入者在 credit.js，ADR-0014）。
  try {
    db.prepare('UPDATE sales_orders SET credit_checked_at=NULL').run()
    reprojectOrderHolds(db)
  } catch { /* 列可能尚未加 */ }
  pruneOrphanEvents(db)
}

export function seedQuoteCredit(db, { industry = 'food', silent = false, log } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) (log ? log(m) : console.log(m)) }
  const has = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sales_quotes'").get()
  if (!has) {
    say('[quote] 报价与信用表不存在，跳过（先跑迁移 018）')
    return { skipped: true }
  }

  clear(db)
  const stat = { accounts: 0, quotes: 0, converted: 0, blocked: 0, forced: 0, expired: 0, ledger: 0 }

  const dealers = db.prepare('SELECT * FROM dealers ORDER BY credit_limit DESC, id').all()
  const skus = db
    .prepare(
      `SELECT sk.id, sk.sku_code, sk.name, sk.price_retail, sk.price_dealer, sk.price_min
       FROM product_skus sk JOIN products p ON p.id=sk.product_id
       ORDER BY sk.id LIMIT 6`
    )
    .all()
  if (!dealers.length || !skus.length) {
    say('[quote] 缺少经销商或商品 SKU，跳过')
    return { skipped: true, reason: 'no-dealer-or-sku' }
  }
  const actor = { id: null, name: 'seed' }

  // ---------- 1. 信用账户：每个经销商一个，额度与账期从档案带出 ----------
  const accounts = dealers.map((d) => {
    const acc = ensureAccount(db, { subjectType: 'dealer', subjectId: d.id, actor })
    stat.accounts += 1
    return acc
  })

  // 额度最大的那家：给一笔临时额度（促销旺季），让界面能看到「临时额度 + 到期日」
  const main = accounts[0]
  if (main) {
    const temp = Math.round(Number(main.credit_limit || 0) * 0.3 / 1000) * 1000
    if (temp > 0) {
      updateAccount(db, {
        accountId: main.id,
        patch: {
          temp_limit: temp,
          temp_expire_at: dayAgo(-45),
          credit_days: Number(main.credit_days || 0) || 30,
          remark: '促销旺季临时额度'
        },
        actor
      })
    }
  }
  // 最后一家冻结：演示「冻结客户下单直接被拦」
  const frozen = accounts[accounts.length - 1]
  if (frozen && accounts.length > 1) {
    updateAccount(db, {
      accountId: frozen.id,
      patch: { status: 'frozen', frozen_reason: '上季度货款逾期超 60 天，暂停授信' },
      actor
    })
  }
  // 第二家保持小额度：用于演示超信拦截（下面第 4 步会故意报一个超额度的大单）
  const small = accounts[1] || accounts[0]

  // ---------- 2. 占用流水：用已经发货/完成的销售订单补历史占用 ----------
  // 为什么不直接 INSERT 台账：占用必须能与「单据认为占了多少」对上，
  // 否则 audit 立刻报出差额。`sales_orders.credit_hold` 由 occupy / settle 在台账写入时
  // 自动投影（ADR-0014）—— 这里**不再**另写一遍，后面 ar-seed 的收款核销 / 作废才能跟着同步。
  // 已确认的订单同样占着授信：货还没发、钱更没到，额度不能当成没用。
  // （seed 里的订单是直接以这些状态落库的，没走过确认动作，所以这里补上占用）
  const openOrders = db
    .prepare(
      `SELECT o.id, o.doc_no, o.dealer_id, o.receivable_amount, o.paid_amount, o.status
       FROM sales_orders o
       WHERE o.dealer_id IS NOT NULL AND o.status IN ('confirmed','shipped','completed')
         AND COALESCE(o.receivable_amount,0) - COALESCE(o.paid_amount,0) > 0.01
       ORDER BY o.id DESC LIMIT 4`
    )
    .all()
  openOrders.forEach((o, i) => {
    const acc = accounts.find((a) => a.subject_id === o.dealer_id)
    if (!acc) return
    if (Number(acc.credit_limit || 0) <= 0) return
    const open = Math.max(0, Number((Number(o.receivable_amount) - Number(o.paid_amount || 0)).toFixed(2)))
    if (open <= 0) return
    const hold = i === 0 ? open : Number((open * 0.5).toFixed(2))
    const row = occupy(db, {
      account: acc.id,
      amount: hold,
      sourceType: 'SO',
      sourceId: o.id,
      docNo: o.doc_no,
      creditDays: Number(acc.credit_days || 0),
      operator: actor,
      remark: '历史应收占用（演示数据）'
    })
    stat.ledger += row ? 1 : 0
    db.prepare("UPDATE sales_orders SET credit_checked_at=datetime('now','localtime') WHERE id=?").run(o.id)

    // 第一笔做成「已逾期」：真实业务里逾期是常态，界面上必须能看到逾期天数与金额。
    // due_date 只能由账期从今天往后推，所以这里显式回写一个历史到期日 —— seed 特权，
    // 目的是让「逾期」这件事在演示数据里真实存在，而不是靠文案描述。
    if (i === 0 && row) {
      db.prepare('UPDATE credit_ledger SET due_date=? WHERE id=?').run(dayAgo(45), row.id)
    }
    // 第二笔做一次部分回款核销：展示「钱到了才释放额度」
    if (i === 1 && row) {
      const paid = Number((hold * 0.4).toFixed(2))
      settle(db, {
        account: acc.id,
        amount: paid,
        sourceType: 'SO',
        sourceId: o.id,
        docNo: o.doc_no,
        operator: actor,
        remark: '演示回款核销'
      })
      stat.ledger += 1
    }
  })

  // ---------- 3. 报价单：四种典型状态各一张 ----------
  const mainDealer = dealers[0]
  const items = (n, qtyEach = 20) =>
    skus.slice(0, n).map((s) => ({ sku_id: s.id, qty: qtyEach }))

  // ① 草稿：还没提交
  const q1 = createQuote(db, {
    customerType: 'dealer',
    dealerId: mainDealer.id,
    items: items(3, 12),
    validDays: 30,
    remark: '常规补货报价（草稿）',
    actor,
    source: 'seed'
  })
  stat.quotes += 1

  // ② 低于最低限价 → 需审批 → 审批通过 → 转销售订单
  //    手工把第一行的价压到最低限价以下，制造「必须有人签字」的场景
  const belowItems = skus.slice(0, 3).map((s, i) => ({
    sku_id: s.id,
    qty: 10,
    price: i === 0 && Number(s.price_min || 0) > 0 ? Number((Number(s.price_min) * 0.9).toFixed(2)) : undefined
  }))
  const q2 = createQuote(db, {
    customerType: 'dealer',
    dealerId: mainDealer.id,
    items: belowItems,
    validDays: 15,
    remark: '大客户专项报价（低于限价，需审批）',
    actor,
    source: 'seed'
  })
  stat.quotes += 1
  transitionQuote(db, { id: q2.id, action: 'submit', actor, source: 'seed' })
  transitionQuote(db, { id: q2.id, action: 'approve', actor, source: 'seed', remark: '低于最低限价，销售总监特批' })
  try {
    convertQuote(db, { id: q2.id, target: 'SO', actor, source: 'seed' })
    stat.converted += 1
  } catch (e) {
    say(`[quote] 转单失败（保留现场）：${e.message}`)
  }

  // ③ 已审批但已过期：演示「过期报价不能转单」
  const q3 = createQuote(db, {
    customerType: 'dealer',
    dealerId: (dealers[1] || mainDealer).id,
    items: items(2, 30),
    validFrom: dayAgo(40),
    validTo: dayAgo(10),
    remark: '上季度报价（已过期）',
    actor,
    source: 'seed'
  })
  stat.quotes += 1
  transitionQuote(db, { id: q3.id, action: 'submit', actor, source: 'seed' })
  transitionQuote(db, { id: q3.id, action: 'approve', actor, source: 'seed' })
  stat.expired += expireQuotes(db, { actor }).expired

  // ④ 超信拦截 + 特批放行：同一张报价先被拦、再被放行，两次都留下证据。
  //    数量是**算出来的**：三个行业的单价与额度都不一样，写死 400 会出现
  //    「这一行根本没超信」的假演示（餐饮库就中过招）。所以要按「可用额度」反推，
  //    报出一个明确超过额度 25% 的金额。
  const smallDealer = dealers.find((d) => d.id === small.subject_id) || mainDealer
  const unitQuote = priceQuote(db, {
    items: skus.slice(0, 4).map((s) => ({ sku_id: s.id, qty: 1 })),
    customerType: 'dealer',
    dealerId: smallDealer.id
  })
  const smallSnap = creditSnapshot(db, small.id)
  const unitTotal = Number(unitQuote.total_amount || 0)
  const overQty = unitTotal > 0
    ? Math.max(1, Math.ceil(((Number(smallSnap?.available || 0) + 1) * 1.25) / unitTotal))
    : 1
  const bigItems = skus.slice(0, 4).map((s) => ({ sku_id: s.id, qty: overQty }))
  const q4 = createQuote(db, {
    customerType: 'dealer',
    dealerId: smallDealer.id,
    items: bigItems,
    validDays: 20,
    remark: '旺季大单（超授信，需特批）',
    actor,
    source: 'seed'
  })
  stat.quotes += 1
  transitionQuote(db, { id: q4.id, action: 'submit', actor, source: 'seed' })
  transitionQuote(db, { id: q4.id, action: 'approve', actor, source: 'seed' })
  try {
    // 第一次：不带 force —— 应当被拦住
    convertQuote(db, { id: q4.id, target: 'SO', actor, source: 'seed' })
  } catch (e) {
    stat.blocked += 1
    say(`[quote] 超信拦截（预期内）：${e.message}`)
  }
  try {
    // 第二次：带 force + reason —— 特批放行，留痕里能查到是谁放的
    convertQuote(db, {
      id: q4.id, target: 'SO', actor, source: 'seed',
      force: true, reason: '客户已付 30% 预付款，销售总监口头同意，节后补审批单'
    })
    stat.converted += 1
    stat.forced += 1
  } catch (e) {
    say(`[quote] 特批放行失败：${e.message}`)
  }

  // ⑤ 复制改版：报价改价不改原单
  copyQuote(db, { id: q1.id, actor, remark: '按新价格政策改版（v2）' })
  stat.quotes += 1

  say(
    `[quote] 信用账户 ${stat.accounts} / 报价单 ${stat.quotes}（转单 ${stat.converted}，其中特批 ${stat.forced}）/ 超信拦截 ${stat.blocked} / 过期 ${stat.expired} / 台账 ${stat.ledger}`
  )
  return { ...stat, main_account: main ? creditSnapshot(db, main.id) : null }
}

export default seedQuoteCredit
