/**
 * ============================================================================
 * 文件标识：server/lib/credit.js ｜ 信用控制（模块 08A）
 * ============================================================================
 * 【职责】信用控制（模块 08A）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 信用控制（模块 08A）
//
// 三条口径，写死在文件头：
//
// ① **额度只有一个真相：台账求和，不是缓存列。**
//    dealers.credit_used 是历史遗留的缓存列（只有收款时顺手减一下），
//    它必然与真实占用越走越远。本模块一律不读它，已用额 = SUM(credit_ledger)
//    + 订货中心同主体未回款占用（oc_credit_ledger，只读）。
//
// ② **同主体跨渠道共享额度。**
//    同一个经销商，线下走销售订单、线上走订货中心，以前是两本账、两份额度。
//    现在归到一个 subject（dealer / oc）：oc_customers.source_type='dealer'
//    的订货客户，其占用并入对应经销商账户。
//    为什么不动订货中心自己的口径：OC 的授信已跑通且有 208 项断言守着，
//    统一层做**加法** —— OC 自身所见不变，只是统一视图多算了它。
//
// ③ **校验必须留痕，放行必须署名。**
//    超信有两种处理方式：拦住（默认）与特批放行（force + reason 必填）。
//    无论哪种都写 credit_check_logs —— 「这笔超信是谁放的」事后必须要能查到，
//    否则信用控制就退化成「谁嗓门大谁过」。
//
// ④ **sales_orders.credit_hold 是台账的投影，只有本文件写它。**
//    台账每写一行（占用 / 释放 / 核销 / 恢复）就在同一事务里重算该订单的投影；
//    订单确认、取消、seed、收款核销、作废都不许另写 `UPDATE sales_orders SET credit_hold`。
//    对账判据在 `reconcileOrderHolds`（ADR-0014）。

import { getDb } from '../db/index.js'
// 日期一律走 dates.js 的本地口径。本模块原来的 addDays 在本地零点上加天数、
// 再用 toISOString() 取日期，而 toISOString() 是 **UTC** —— 东八区下
// 「2026-10-15 + 30 天」算成 2026-11-13，**每一个账期都短一天**，
// 且因为只是"少一天"，任何断言都发现不了。到期日、有效期全走同一个函数。
import { localDate, localNow, addDays } from './dates.js'
import { readSetting } from './settings.js'

export class CreditError extends Error {
  constructor(message, { code = 'CREDIT_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'CreditError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const nowStr = () => localNow()
const todayStr = () => localDate()

// 逾期多久开始硬拦截：`settings.credit.overdue_block_days`（批次 R 起，
// 这个键**真的落在库里了** —— 在此之前它是"代码读、库里没有"的幽灵配置：
// 读不到就永远走默认值，界面上也看不见它，看起来可配、实际不可配）。
// 默认值不再写在这里：它的唯一出处是 `lib/settings.js` 的 `SETTING_RULES`。
/** 逾期几天开始硬拦截。唯一读取点走 `readSetting`（值域"不能为负"定义在 `SETTING_RULES`） */
export const overdueBlockDays = (db) => readSetting(db, 'credit.overdue_block_days')
/** 可用额度低于额度的这个比例时预警（不拦截） */
const TIGHT_RATE = 0.1

// ---------------------------------------------------------------------------
// 一、信用账户
// ---------------------------------------------------------------------------

/** 主体默认值：账户还没建档时，从来源档案取额度与账期 */
function profileOf(db, subjectType, subjectId) {
  if (subjectType === 'dealer') {
    const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(subjectId)
    if (!d) return null
    return {
      code: d.code,
      name: d.name,
      credit_limit: Number(d.credit_limit || 0),
      credit_days: Number(d.credit_days || 0),
      settle_type: d.settle_type || null
    }
  }
  if (subjectType === 'oc') {
    const c = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(subjectId)
    if (!c) return null
    return {
      code: c.code || c.customer_code || null,
      name: c.name || c.customer_name || null,
      credit_limit: Number(c.credit_limit || 0),
      credit_days: Number(c.credit_days || 0),
      settle_type: c.settle_type || null
    }
  }
  if (subjectType === 'store') {
    const s = db.prepare('SELECT * FROM stores WHERE id=?').get(subjectId)
    if (!s) return null
    return { code: s.code, name: s.name, credit_limit: 0, credit_days: 0, settle_type: 'internal' }
  }
  return null
}

/** 建/取账户。已存在则只更新名称类信息，额度与账期以账户为准（可被人工维护改过） */
export function ensureAccount(db, { subjectType, subjectId, actor = null } = {}) {
  if (!subjectType || !subjectId) {
    const e = new Error('subjectType 与 subjectId 必填')
    e.code = 'BAD_ARGS'
    e.status = 400
    throw e
  }
  const sid = Number(subjectId)
  const exist = db
    .prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?')
    .get(subjectType, sid)
  if (exist) return exist

  const p = profileOf(db, subjectType, sid)
  if (!p) {
    const e = new Error(`${subjectType}#${sid} 不存在，无法建立信用账户`)
    e.code = 'SUBJECT_NOT_FOUND'
    e.status = 404
    throw e
  }
  const info = db
    .prepare(
      `INSERT INTO credit_accounts (subject_type,subject_id,code,name,credit_limit,credit_days,settle_type,status,remark,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,'active',?,datetime('now','localtime'),datetime('now','localtime'))`
    )
    .run(
      subjectType, sid, p.code, p.name, round2(p.credit_limit), Number(p.credit_days || 0),
      p.settle_type, actor?.name ? `由 ${actor.name} 建档` : '自动建档'
    )
  return db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(info.lastInsertRowid)
}

/**
 * 客户身份 → 信用主体。
 *   dealer            → ('dealer', dealerId)
 *   oc customer       → 若来源档案是经销商 → ('dealer', source_id)，否则 ('oc', id)
 *   store             → ('store', storeId)
 */
export function resolveSubject(db, { customerType = null, customerId = null, dealerId = null, storeId = null } = {}) {
  if (dealerId) return { subjectType: 'dealer', subjectId: Number(dealerId) }
  if (storeId && customerType !== 'oc') return { subjectType: 'store', subjectId: Number(storeId) }
  if (customerId) {
    const c = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(Number(customerId))
    if (c && c.source_type === 'dealer' && c.source_id) {
      return { subjectType: 'dealer', subjectId: Number(c.source_id) }
    }
    return { subjectType: 'oc', subjectId: Number(customerId) }
  }
  if (customerType && customerId == null) return null
  return null
}

/** 与该主体归并的订货中心客户 id（用于把 OC 的占用并入统一视图） */
function ocIdsOf(db, subjectType, subjectId) {
  if (subjectType === 'oc') return [Number(subjectId)]
  if (subjectType === 'dealer') {
    return db
      .prepare("SELECT id FROM oc_customers WHERE source_type='dealer' AND source_id=?")
      .all(Number(subjectId))
      .map((r) => r.id)
  }
  return []
}

// ---------------------------------------------------------------------------
// 二、额度快照
// ---------------------------------------------------------------------------

/**
 * 信用快照。
 * 已用 = 统一台账（credit_ledger） + 订货中心同主体占用（oc_credit_ledger）
 * 可用 = 额度（含未过期的临时额度） − 已用
 */
export function creditSnapshot(db, account) {
  if (!account) return null
  const acc = typeof account === 'number'
    ? db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(account)
    : account
  if (!acc) return null

  const own = db
    .prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE account_id=?')
    .get(acc.id).s

  const ocIds = ocIdsOf(db, acc.subject_type, acc.subject_id)
  let ocUsed = 0
  if (ocIds.length && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='oc_credit_ledger'").get()) {
    const q = `SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger WHERE customer_id IN (${ocIds.map(() => '?').join(',')})`
    ocUsed = db.prepare(q).all(...ocIds)[0]?.s || 0
  }

  // 临时额度只在有效期内计入；过期即失效，不给人「看着还有额度」的错觉
  const today = todayStr()
  const tempActive = Number(acc.temp_limit || 0) > 0 && (!acc.temp_expire_at || String(acc.temp_expire_at) >= today)
  const baseLimit = Number(acc.credit_limit || 0)
  const limit = round2(baseLimit + (tempActive ? Number(acc.temp_limit || 0) : 0))
  const used = round2(Number(own) + Number(ocUsed))
  const available = round2(limit - used)

  // 逾期：取台账里**仍占用且已过应收到期日**的金额与最大逾期天数
  const openRows = db
    .prepare(
      `SELECT amount, due_date FROM credit_ledger
        WHERE account_id=? AND amount>0 AND change_type IN ('occupy','adjust')`
    )
    .all(acc.id)
  let overdueAmount = 0
  let overdueDays = 0
  for (const r of openRows) {
    if (!r.due_date) continue
    const days = Math.floor((new Date(today) - new Date(String(r.due_date).slice(0, 10))) / 86400000)
    if (days > 0) {
      overdueAmount = round2(overdueAmount + Number(r.amount || 0))
      overdueDays = Math.max(overdueDays, days)
    }
  }

  return {
    account_id: acc.id,
    subject_type: acc.subject_type,
    subject_id: acc.subject_id,
    code: acc.code,
    name: acc.name,
    status: acc.status,
    frozen_reason: acc.frozen_reason,
    credit_limit: baseLimit,
    temp_limit: tempActive ? Number(acc.temp_limit || 0) : 0,
    temp_expire_at: acc.temp_expire_at,
    limit,
    used,
    own_used: round2(Number(own)),
    oc_used: round2(Number(ocUsed)),
    available,
    credit_days: Number(acc.credit_days || 0),
    settle_type: acc.settle_type,
    overdue_amount: overdueAmount,
    overdue_days: overdueDays,
    usage_rate: limit > 0 ? Number((used / limit).toFixed(4)) : 0
  }
}

/** 按客户身份取快照（没建档时返回 null —— 未授信按现结处理，不拦） */
export function snapshotFor(db, ref) {
  const sub = resolveSubject(db, ref)
  if (!sub) return null
  const acc = db
    .prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?')
    .get(sub.subjectType, sub.subjectId)
  if (!acc) return null
  return { ...creditSnapshot(db, acc), subject: sub }
}

// ---------------------------------------------------------------------------
// 三、校验：能不能下单
// ---------------------------------------------------------------------------

/**
 * 下单前信用校验。
 * @returns { pass, blocking, warnings, checks, result, account, available, over_amount }
 *   result: pass / warn / block / force（force = 超信但被特批放行）
 */
export function checkCredit(db, {
  subject = null, accountId = null, amount = 0, scene = 'api',
  sourceType = null, sourceId = null, docNo = null,
  force = false, reason = null, actor = null, at = null
} = {}) {
  const amt = round2(amount)
  let acc = null
  if (accountId) acc = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(accountId)
  else if (subject) {
    const sub = resolveSubject(db, subject)
    if (sub) {
      acc = db.prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?').get(sub.subjectType, sub.subjectId)
    }
  }

  const checks = []
  // 没有信用账户 = 未授信，按现结处理：不拦，但要说清楚「为什么没拦」
  if (!acc) {
    checks.push({ code: 'NO_ACCOUNT', level: 'pass', message: '未建立信用账户，按现结处理（不做授信拦截）' })
    logCheck(db, { accountId: null, scene, sourceType, sourceId, docNo, amount: amt, available: 0, over: 0, overdue: 0, result: 'pass', reason: '未建档', actor })
    return { pass: true, blocking: [], warnings: [], checks, result: 'pass', account: null, available: 0, over_amount: 0 }
  }

  const snap = creditSnapshot(db, acc)
  const over = round2(Math.max(0, amt - snap.available))
  const blockDays = overdueBlockDays(db)

  if (acc.status === 'frozen') {
    checks.push({ code: 'CREDIT_FROZEN', level: 'block', message: `信用已冻结：${acc.frozen_reason || '未填原因'}` })
  }
  if (snap.limit <= 0) {
    checks.push({ code: 'NO_LIMIT', level: 'pass', message: '额度为 0（未授信），不占用授信' })
  } else if (over > 0) {
    checks.push({
      code: 'CREDIT_OVER',
      level: 'block',
      message: `本单 ${amt} 超出可用授信 ${snap.available}（额度 ${snap.limit}，已用 ${snap.used}），超出 ${over}`,
      data: { amount: amt, available: snap.available, over }
    })
  } else if (snap.available > 0 && snap.available / snap.limit < TIGHT_RATE) {
    checks.push({ code: 'CREDIT_TIGHT', level: 'warn', message: `可用授信仅剩 ${snap.available}（额度 ${snap.limit}），下单后将接近上限` })
  }
  if (snap.overdue_days > blockDays) {
    checks.push({ code: 'CREDIT_OVERDUE', level: 'block', message: `已逾期 ${snap.overdue_days} 天（逾期金额 ${snap.overdue_amount}），超过 ${blockDays} 天阈值` })
  } else if (snap.overdue_days > 0) {
    checks.push({ code: 'OVERDUE_WARN', level: 'warn', message: `存在逾期 ${snap.overdue_days} 天未回款（${snap.overdue_amount}）` })
  }

  const blocking = checks.filter((c) => c.level === 'block')
  const warnings = checks.filter((c) => c.level === 'warn')

  let result = 'pass'
  let pass = true
  if (warnings.length && !blocking.length) result = 'warn'
  if (blocking.length) {
    if (force) {
      // 特批放行必须带理由 —— 没理由就拦，这是信用控制最后一道底线
      const why = (reason || '').trim()
      if (!why) {
        const e = new Error('超信放行必须填写理由（reason），否则不予放行')
        e.code = 'CREDIT_FORCE_REASON_REQUIRED'
        e.status = 400
        throw e
      }
      result = 'force'
      pass = true
    } else {
      result = 'block'
      pass = false
    }
  }

  logCheck(db, {
    accountId: acc.id, scene, sourceType, sourceId, docNo,
    amount: amt, available: snap.available, over, overdue: snap.overdue_days,
    result, reason: force ? `特批放行：${reason || ''}` : (blocking[0]?.message || null),
    actor
  })

  return {
    pass,
    blocking,
    warnings,
    checks,
    result,
    account: snap,
    available: snap.available,
    over_amount: over,
    credit_days: snap.credit_days,
    due_date: snap.credit_days > 0 ? addDays(todayStr(), snap.credit_days) : null
  }
}

function logCheck(db, { accountId, scene, sourceType, sourceId, docNo, amount, available, over, overdue, result, reason, actor }) {
  db.prepare(
    `INSERT INTO credit_check_logs (account_id,scene,source_type,source_id,doc_no,amount,available,over_amount,overdue_days,result,reason,operator_id,operator,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    accountId, scene, sourceType, sourceId, docNo,
    round2(amount), round2(available), round2(over), Number(overdue || 0),
    result, reason || null, actor?.id || null, actor?.name || null, nowStr()
  )
}

// 日期加法已收敛到 dates.js 的 addDays（本地整数运算，不经过 toISOString）。
// 这里曾经自己写一份：在本地零点上加天数再用 toISOString() 取日期，
// 由于 toISOString() 是 UTC，东八区下每个账期都短一天，且不报错。

// ---------------------------------------------------------------------------
// 四、台账写入：占用 / 释放 / 核销 / 调整
// ---------------------------------------------------------------------------

function writeLedger(db, { accountId, changeType, sourceType, sourceId, docNo, amount, dueDate = null, operator = null, remark = null }) {
  const amt = round2(amount)
  const before = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE account_id=?').get(accountId).s
  const info = db
    .prepare(
      `INSERT INTO credit_ledger (account_id,change_type,source_type,source_id,doc_no,amount,balance_after,due_date,operator_id,operator,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      accountId, changeType, sourceType, sourceId || null, docNo || null, amt,
      round2(Number(before) + amt), dueDate || null,
      operator?.id || null, operator?.name || null, remark || null, nowStr()
    )
  // 单据视角的投影跟着台账走（ADR-0014）：同一事务、同一处写，调用方不再另写 credit_hold。
  projectOrderHold(db, { sourceType, sourceId })
  return { id: info.lastInsertRowid, balance_after: round2(Number(before) + amt) }
}

// ---------------------------------------------------------------------------
// 四之二、单据投影：sales_orders.credit_hold 是台账的派生值，只有这一个写入者
// ---------------------------------------------------------------------------
//
// 为什么要有投影：列表页与审批页要显示"这张订单还占着多少额度"，每行去 SUM 台账太慢；
// 为什么只能在这里写：原来订单确认 / 取消 / seed 各写一遍 `UPDATE sales_orders SET credit_hold=…`，
// 而收款核销、预收抵扣、作废恢复走的是 credit.js 的 settle / reoccupy —— 那三条路谁都没改投影，
// `auditCredit.order_hold_diff` 于是常年报差（test-quote-credit 的两条既有失败）。
// 台账每写一行就重算一次该来源的投影，四条路径自然同步，且与台账在同一事务里成败。

/** 某张销售订单在台账里的净占用（所有账户合计；正常只会落在一个账户名下） */
function netHoldOfOrder(db, orderId) {
  const row = db
    .prepare("SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE source_type='SO' AND source_id=?")
    .get(orderId)
  return round2(Math.max(0, Number(row?.s || 0)))
}

/**
 * 重算一张销售订单的 `credit_hold`（唯一写入者）。
 * 来源不是 SO 的台账行（SI / RCP / MANUAL / OC …）没有投影，直接返回 null。
 */
export function projectOrderHold(db, { sourceType, sourceId } = {}) {
  if (sourceType !== 'SO' || sourceId == null) return null
  const hold = netHoldOfOrder(db, sourceId)
  db.prepare('UPDATE sales_orders SET credit_hold=? WHERE id=? AND ROUND(COALESCE(credit_hold,0),2)<>?')
    .run(hold, Number(sourceId), hold)
  return hold
}

/** 整库重投影（seed 清台账之后用）：每一张订单都按台账重算，没有台账行的归零 */
export function reprojectOrderHolds(db) {
  const ids = db
    .prepare(`SELECT id FROM sales_orders WHERE credit_hold<>0
              UNION SELECT source_id AS id FROM credit_ledger WHERE source_type='SO' AND source_id IS NOT NULL`)
    .all()
    .map((r) => r.id)
  for (const id of ids) projectOrderHold(db, { sourceType: 'SO', sourceId: id })
  return ids.length
}

/**
 * 对账：单据投影 vs 台账净占用，返回差异行（空数组 = 一致）。
 * 判据与 `projectOrderHold` 故意**不是**同一条 SQL：投影按来源合计所有账户，
 * 对账按**订单往来对象解析出的账户**取占用 —— 占用挂错账户（跨客户）时投影能对上、对账会响。
 * 覆盖两种错：hold > 0 但台账不等（含台账为 0）；hold = 0 但台账仍有占用。
 */
export function reconcileOrderHolds(db) {
  const diffs = []
  const orders = db
    .prepare(
      `SELECT id, doc_no, dealer_id, store_id, status, credit_hold FROM sales_orders
        WHERE (credit_hold > 0 AND status NOT IN ('cancelled','returned'))
           OR id IN (SELECT source_id FROM credit_ledger WHERE source_type='SO' GROUP BY source_id HAVING SUM(amount) > 0.005)
        ORDER BY id`
    )
    .all()
  for (const o of orders) {
    const sub = resolveSubject(db, { dealerId: o.dealer_id, storeId: o.store_id })
    const acc = sub
      ? db.prepare('SELECT id FROM credit_accounts WHERE subject_type=? AND subject_id=?').get(sub.subjectType, sub.subjectId)
      : null
    const ledger = acc ? openAmountOf(db, acc.id, 'SO', o.id) : 0
    const hold = round2(o.credit_hold)
    if (Math.abs(ledger - hold) > 0.005) {
      diffs.push({ order_id: o.id, doc_no: o.doc_no, status: o.status, hold, ledger, diff: round2(hold - ledger) })
    }
  }
  return diffs
}

/** 占用（订单生效点）。金额 > 0 */
export function occupy(db, { account, amount, sourceType, sourceId, docNo, creditDays = null, operator = null, remark = null }) {
  const acc = ensureAcc(db, account)
  if (!(amount > 0)) return null
  const days = creditDays != null ? Number(creditDays) : Number(acc.credit_days || 0)
  return writeLedger(db, {
    accountId: acc.id, changeType: 'occupy', sourceType, sourceId, docNo,
    amount: round2(amount), dueDate: days > 0 ? addDays(todayStr(), days) : null,
    operator, remark: remark || '单据生效占用授信'
  })
}

/** 释放（取消 / 作废）。按单据已占用金额整笔回冲 */
export function release(db, { account, amount = null, sourceType, sourceId, docNo, operator = null, remark = null }) {
  const acc = ensureAcc(db, account)
  const amt = amount != null
    ? round2(amount)
    : openAmountOf(db, acc.id, sourceType, sourceId)
  if (!(amt > 0)) return null
  return writeLedger(db, {
    accountId: acc.id, changeType: 'release', sourceType, sourceId, docNo,
    amount: -round2(amt), operator, remark: remark || '单据取消，释放授信'
  })
}

/** 回款核销：占用随回款减少（不是发货减少 —— 货发了钱没到，授信仍被占着） */
export function settle(db, { account, amount, sourceType, sourceId, docNo, operator = null, remark = null }) {
  const acc = ensureAcc(db, account)
  const open = openAmountOf(db, acc.id, sourceType, sourceId)
  const amt = Math.min(round2(amount), round2(open))
  if (!(amt > 0)) return null
  // 回报 **实际释放额**（已按剩余占用封顶）：调用方要把它记进释放台账，
  // 作废时按这个数恢复 —— 不能按"核销了多少"恢复，那会把封顶掉的部分凭空占回来。
  const row = writeLedger(db, {
    accountId: acc.id, changeType: 'settle', sourceType, sourceId, docNo,
    amount: -amt, operator, remark: remark || '回款核销，释放授信'
  })
  return { ...row, amount: amt }
}

/**
 * 逆向恢复占用（作废收款 / 撤销预收抵扣）：把一笔已记录的释放按原来源占回去。
 *
 * 判据只有一处：**恢复额 ≤ 该来源历史占用总额 − 当前仍占用额**。
 * 超过说明别的路径已经把额度占回来了（或台账被改过），此时**拒绝而不是截平**（A07 同一条原则）。
 * 写成 `occupy` 行而不另立类型：快照的逾期统计、界面的类型字典都只认四类；
 * 到期日沿用该来源最近一条占用行的 due_date —— 作废收款不能把逾期"洗白"。
 */
export function reoccupy(db, { account, amount, sourceType, sourceId, docNo, operator = null, remark = null }) {
  const acc = ensureAcc(db, account)
  const amt = round2(amount)
  if (!(amt > 0)) return null
  const occupied = round2(
    db.prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM credit_ledger
        WHERE account_id=? AND source_type=? AND source_id=? AND amount>0`
    ).get(acc.id, sourceType, sourceId)?.s || 0
  )
  const room = round2(occupied - openAmountOf(db, acc.id, sourceType, sourceId))
  if (amt > room + 0.005) {
    throw new CreditError(
      `${sourceType}#${sourceId} 可恢复占用只有 ${room}，本次要恢复 ${amt}（历史占用 ${occupied}）`,
      { code: 'CREDIT_REVERSAL_EXCEEDS_SOURCE', httpStatus: 409, detail: { sourceType, sourceId, occupied, room, amount: amt } }
    )
  }
  const last = db
    .prepare(
      `SELECT due_date FROM credit_ledger
        WHERE account_id=? AND source_type=? AND source_id=? AND change_type='occupy' AND amount>0
        ORDER BY id DESC LIMIT 1`
    )
    .get(acc.id, sourceType, sourceId)
  const row = writeLedger(db, {
    accountId: acc.id, changeType: 'occupy', sourceType, sourceId, docNo,
    amount: amt, dueDate: last?.due_date || null, operator, remark: remark || '核销作废，恢复占用'
  })
  return { ...row, amount: amt }
}

/** 人工调整占用（坏账核销、争议挂账等）。金额可正可负 */
export function adjustCredit(db, { account, amount, operator = null, remark = null }) {
  const acc = ensureAcc(db, account)
  if (!round2(amount)) return null
  return writeLedger(db, {
    accountId: acc.id, changeType: 'adjust', sourceType: 'MANUAL', sourceId: null, docNo: null,
    amount: round2(amount), dueDate: null, operator,
    remark: remark || (round2(amount) > 0 ? '人工调增占用' : '人工调减占用')
  })
}

/** 某张单据在台账里仍占用的金额（occupy − release − settle） */
export function openAmountOf(db, accountId, sourceType, sourceId) {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(amount),0) s FROM credit_ledger
        WHERE account_id=? AND source_type=? AND source_id=?`
    )
    .get(accountId, sourceType, sourceId)
  return round2(Math.max(0, Number(row?.s || 0)))
}

function ensureAcc(db, account) {
  if (!account) throw new Error('缺少信用账户')
  if (typeof account === 'number') {
    const acc = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(account)
    if (!acc) throw new Error(`信用账户 #${account} 不存在`)
    return acc
  }
  if (account.id) return account
  return ensureAccount(db, account)
}

// ---------------------------------------------------------------------------
// 五、账户维护
// ---------------------------------------------------------------------------

export function updateAccount(db, { accountId = null, subject = null, patch = {}, actor = null }) {
  let acc = null
  if (accountId) acc = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(accountId)
  else if (subject) {
    const sub = resolveSubject(db, subject)
    if (sub) acc = db.prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?').get(sub.subjectType, sub.subjectId)
  }
  if (!acc) acc = ensureAccount(db, { ...(subject || {}), actor })

  const allow = ['credit_limit', 'credit_days', 'temp_limit', 'temp_expire_at', 'settle_type', 'status', 'frozen_reason', 'remark']
  const sets = []
  const vals = []
  for (const k of allow) {
    if (patch[k] === undefined) continue
    sets.push(`${k}=?`)
    vals.push(k === 'credit_limit' || k === 'temp_limit' ? round2(patch[k]) : patch[k])
  }
  if (!sets.length) return acc
  sets.push("updated_at=datetime('now','localtime')")
  vals.push(acc.id)
  db.prepare(`UPDATE credit_accounts SET ${sets.join(',')} WHERE id=?`).run(...vals)
  return db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(acc.id)
}

// ---------------------------------------------------------------------------
// 六、对账与概览
// ---------------------------------------------------------------------------

/**
 * 信用自洽审计：
 *   ① 台账逐笔的 balance_after 必须与「从头累计」一致（防止并发写坏余额列）；
 *   ② 销售订单上记的 credit_hold（单据视角）与台账里该单的净占用必须一致（`reconcileOrderHolds`）。
 * 前者错了说明写入有问题，后者错了说明「单据与台账没成对」—— 都是静默错账。
 */
export function auditCredit(db) {
  const drift = []
  let running = 0
  const rows = db.prepare('SELECT * FROM credit_ledger ORDER BY account_id, id').all()
  let lastAcc = null
  for (const r of rows) {
    if (lastAcc !== r.account_id) {
      lastAcc = r.account_id
      running = 0
    }
    running = round2(running + Number(r.amount || 0))
    if (Math.abs(running - Number(r.balance_after || 0)) > 0.005) {
      drift.push({ ledger_id: r.id, account_id: r.account_id, expect: running, actual: Number(r.balance_after || 0) })
    }
  }

  // 单据投影与台账的差异：判据只有一处（reconcileOrderHolds），legacy 探针与 verify-seed 都调它
  const holdDiff = reconcileOrderHolds(db)
  return {
    ledger_balance_drift: drift,
    order_hold_diff: holdDiff,
    balanced: drift.length === 0 && holdDiff.length === 0
  }
}

/** 信用概览：风险榜 + 额度使用率 + 最近的超信放行 */
export function creditOverview(db) {
  const accounts = db.prepare('SELECT * FROM credit_accounts ORDER BY id').all()
  const rows = accounts.map((a) => creditSnapshot(db, a))
  const risk = rows
    .filter((r) => r.limit > 0)
    .map((r) => {
      const reasons = []
      if (r.available < 0) reasons.push(`超额占用 ${Math.abs(r.available)}`)
      else if (r.usage_rate >= 0.9) reasons.push(`额度使用率 ${(r.usage_rate * 100).toFixed(1)}%`)
      if (r.overdue_days > 0) reasons.push(`逾期 ${r.overdue_days} 天`)
      if (r.status === 'frozen') reasons.push('已冻结')
      return { ...r, reasons }
    })
    .filter((r) => r.reasons.length)
    .sort((a, b) => b.usage_rate - a.usage_rate || b.overdue_days - a.overdue_days)

  const forces = db
    .prepare(
      `SELECT l.*, a.name AS account_name FROM credit_check_logs l
       LEFT JOIN credit_accounts a ON a.id=l.account_id
       WHERE l.result IN ('force','block') ORDER BY l.id DESC LIMIT 20`
    )
    .all()

  return {
    account_count: rows.length,
    total_limit: round2(rows.reduce((s, r) => s + r.limit, 0)),
    total_used: round2(rows.reduce((s, r) => s + r.used, 0)),
    total_available: round2(rows.reduce((s, r) => s + r.available, 0)),
    overdue_count: rows.filter((r) => r.overdue_days > 0).length,
    frozen_count: rows.filter((r) => r.status === 'frozen').length,
    risk,
    exceptions: forces,
    audit: auditCredit(db)
  }
}

/** 台账流水（可按账户/单据过滤） */
export function ledgerOf(db, { accountId = null, sourceType = null, sourceId = null, limit = 100 } = {}) {
  const conds = []
  const params = []
  if (accountId) { conds.push('account_id=?'); params.push(accountId) }
  if (sourceType) { conds.push('source_type=?'); params.push(sourceType) }
  if (sourceId != null) { conds.push('source_id=?'); params.push(sourceId) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  return db
    .prepare(
      `SELECT l.*, a.name AS account_name, a.subject_type, a.subject_id
       FROM credit_ledger l LEFT JOIN credit_accounts a ON a.id=l.account_id
       ${where} ORDER BY l.id DESC LIMIT ?`
    )
    .all(...params, limit)
}

export const CHANGE_TYPE_LABEL = {
  occupy: '占用',
  release: '释放',
  settle: '回款核销',
  adjust: '人工调整'
}

export const CHECK_RESULT_LABEL = {
  pass: '通过',
  warn: '预警放行',
  block: '拦截',
  force: '特批放行'
}

export default {
  CreditError, ensureAccount, resolveSubject, creditSnapshot, snapshotFor,
  checkCredit, occupy, release, settle, reoccupy, adjustCredit, openAmountOf,
  projectOrderHold, reprojectOrderHolds, reconcileOrderHolds,
  updateAccount, auditCredit, creditOverview, ledgerOf,
  CHANGE_TYPE_LABEL, CHECK_RESULT_LABEL
}
