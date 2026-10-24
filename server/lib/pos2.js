/**
 * ============================================================================
 * 文件标识：server/lib/pos2.js ｜ 模块 17：门店交班、核款与长短款
 * ============================================================================
 * 【职责】模块 17：门店交班、核款与长短款
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 模块 17：门店交班、核款与长短款
//
// 这个文件只做一件事：把「钱对不对得上」变成一个能被推导、能被追责的数字。
//
// ============================================================================
// 一、三条口径（写死在代码里，不靠界面记得）
// ============================================================================
//
// 1) **长短款 = 实点 − 系统应收**。正数长款、负数短款。
//    方向不能反 —— 它决定「差异单上是 +50 还是 −50」，而这两个字在报表上
//    完全是两回事：一个是店长该表扬的、一个是该追责的。
//
// 2) **长短款按支付方式拆分，不合并成一个总额**。
//    同一个「系统 1000、实数 995」：在现金渠道是**人的问题**（钱被谁拿走了），
//    在移动支付渠道几乎不可能发生；而「系统 800、实数 1000」在现金侧是找零出错，
//    在移动支付侧是**平台流水漏传了一笔**（钱在平台账上，POS 单没上传）。
//    合并成一个总额，这张差异单交上去没人知道该找谁。
//
// 3) **备用金不参与长短款**。`opening_float` 单列。
//    理由：备用金是期初就有的固定金额，混进长短款会让每次核款都要先确认
//    「备用金有没有被动过」；而备用金被挪用恰恰是**另一类问题**，
//    不该让它有机会躲在「长短款」这个笼统的词后面。
//
// ============================================================================
// 二、三段钱（缺一段就问不出「差了多少」）
// ============================================================================
//
//   sys_cash        系统按本班次订单汇总出来的应收
//   declared_cash   收银员数出来报的（declare）
//   counted_cash    店长再数一遍的（approve）
//
// 只留「实点」答不上差了多少；只留「系统」等于认了系统的账。
// 报数与核款是**两个不同的人做的两件事**，所以是两个状态、两步操作。
//
//   · 报数阶段：现金行 diff 恒为 0（店长还没数，此时没有「差异」可言）；
//              非现金行 diff 立即成立（平台流水对不上就是立刻可见的）。
//   · 核款阶段：写入店长实点，`variance = counted_cash − sys_cash` 才出生。
//
// ============================================================================
// 三、几条硬拦（写库之前拦，不靠事后对账）
// ============================================================================
//
//   · 有差异必须有原因：`|variance| ≥ 0.005` 时 `variance_note` 必填。
//   · 有差异必须有归属：`variance_handled ∈ {charge 责任人承担, absorb 门店承担, pending 挂账待查}`。
//   · **超过阈值的差异门店不能自己结案**：必须挂 `pending` 交总部，
//     再由总部（结算端点）改成 charge / absorb。阈值取 `settings.pos_variance_limit`，默认 500。
//   · **一个班次的现金只能缴一次**（`UNIQUE (shift_id)`，写在表结构里）。
//     支持"部分缴款"会让「钱交到一半」变成常态，而这条约束正好表达不了它，
//     于是同一笔钱能被交两遍 —— 在账上看起来只是"钱交多了"，很难反推是操作重复。
//   · **缴款人与接收人不能是同一人**。自己的钱自己收等于没有交接。
//   · **有订单挂靠的班次不能作废**。否则订单会变成不属于任何班次的孤儿，
//     而孤儿订单在长短款里表现为「系统应收凭空少一截」，查不出来。
//   · **未核款不得日结**。日结把货与钱一起交总部，货按订单过账、钱按实点过账；
//     若班次还没核款，钱这一边没有数字可过。

import { nextDocNo } from './docno.js'
import { advanceStatus, logEvent, nowText } from './docflow.js'
import { applyStockIn, applyStockOut, applyStockGain, pickBatches } from './stock.js'
// A09b：门店退货与销售退货共用同一份"退货计划"（来源行绑定 + 退量上限 + 成本追溯）
import { planReturn, ReturnError } from './returns.js'
// A14：门店开单接入**结算域**（会员等级折扣 / 促销 / 券 / 积分抵现）。
// 与商城走的是同一个 `checkout.quote` / `settle` —— **同一份算钱判据**。
import * as K from './checkout.js'
import * as M from './member.js'
// 门店业务日一律走 dates.js 的本地口径。原来这五处都是 `toISOString()`（UTC），
// 而「按业务日」恰恰是门店 POS 的核心口径：本地 00:00–08:00 之间开店，
// 交班日期、日结批次、退货与盘点的业务日全都会落到**昨天**，
// 于是「今天的班次」在日结里找不到、长短款对不上，而且不报任何错。
import { localDate } from './dates.js'
import { readSetting, SETTING_RULES } from './settings.js'

// ---------------------------------------------------------------------------

/** 参与长短款的支付方式。与 `POST /api/pos/orders` 的取值集必须一致 */
export const PAY_METHODS = ['cash', 'wxpay', 'alipay', 'unionpay', 'balance', 'other']

export const PAY_METHOD_LABEL = {
  cash: '现金',
  wxpay: '微信支付',
  alipay: '支付宝',
  unionpay: '银联卡',
  balance: '会员储值',
  other: '其他'
}

export const CASH_METHOD = 'cash'

/** 差异的判定门槛：半分钱。小于它视为「没有差异」 */
export const VARIANCE_EPS = 0.005

/** 长短款处置方式。`pending` 是唯一允许「先挂起来再说」的取值 */
export const HANDLE_TYPES = {
  charge: '责任人承担',
  absorb: '门店承担',
  pending: '挂账待查'
}

/** 差异阈值的默认值（元）。**只是转发** —— 定义在 `SETTING_RULES`，本文件不留第二份定义 */
export const DEFAULT_VARIANCE_LIMIT = Number(SETTING_RULES.pos_variance_limit.default)

export const DROP_STATUS = { pending: '待接收', received: '已接收', cancelled: '已取消' }

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 金额一律 2 位小数（分）。数量用 4 位（见 lib/costing.js 的同一口径） */
export const round2 = (n) => Math.round((Number(n || 0) + Number.EPSILON) * 100) / 100

/** 数字化，非数字一律 0（前端常传空串） */
const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

/** 视为无差异 */
export const isZero = (v) => Math.abs(num(v)) < VARIANCE_EPS

function bad(message, code = 'BAD_REQUEST', httpStatus = 400) {
  const e = new Error(message)
  e.status = httpStatus
  e.code = code
  return e
}

/** 差异阈值（元）。唯一读取点走 `readSetting`（值域"不能为负"定义在 `SETTING_RULES`） */
export function getVarianceLimit(db) {
  return readSetting(db, 'pos_variance_limit')
}

// ---------------------------------------------------------------------------
// 一、系统应收：从订单推出来，不由人选
// ---------------------------------------------------------------------------

/**
 * 本班次的系统应收，按支付方式拆分。
 *
 * 单据来源限定 `shift_id = ?`。**不能用「同门店 + 同营业日 + 同收银员」现算归属** ——
 * 同一个收银员一天开两个班（午班/晚班）时，两个班会算出同一批订单，
 * 现金应收直接翻倍，而长短款跟着错一倍，界面上完全看不出来。
 *
 * 状态限定 `local / synced`：作废单（`voided`）不算钱。
 * 退款单（`pay_amount < 0`）自然冲减 —— 它本来就是负的，不需要额外分支。
 */
export function computeShiftSystem(db, shiftId) {
  const rows = db
    .prepare(
      `SELECT pay_method, COUNT(*) AS order_count, COALESCE(SUM(pay_amount),0) AS amount
         FROM pos_orders
        WHERE shift_id = ? AND status IN ('local','synced')
        GROUP BY pay_method`
    )
    .all(Number(shiftId))
  const byMethod = {}
  for (const code of PAY_METHODS) byMethod[code] = { sys_amount: 0, order_count: 0 }
  let orderCount = 0
  let orderAmount = 0
  for (const r of rows) {
    const m = PAY_METHODS.includes(r.pay_method) ? r.pay_method : 'other'
    byMethod[m].sys_amount = round2(byMethod[m].sys_amount + num(r.amount))
    byMethod[m].order_count += Number(r.order_count)
    orderCount += Number(r.order_count)
    orderAmount += num(r.amount)
  }
  return {
    byMethod,
    sys_cash: round2(byMethod[CASH_METHOD].sys_amount),
    order_count: orderCount,
    order_amount: round2(orderAmount)
  }
}

/** 门店资金在途（门店 / 总部同一口径，读视图，保证只有一处定义） */
export function cashInflight(db, { storeId = null } = {}) {
  const where = storeId ? 'WHERE store_id = ?' : ''
  const rows = db
    .prepare(`SELECT * FROM v_pos_cash_inflight ${where} ORDER BY store_id`)
    .all(...(storeId ? [Number(storeId)] : []))
  if (storeId) return rows[0] || { store_id: Number(storeId), to_drop: 0, variance_total: 0, pending_review_count: 0, open_count: 0 }
  return rows
}

// ---------------------------------------------------------------------------
// 二、班次与交班三段链
// ---------------------------------------------------------------------------

function loadShift(db, shiftId) {
  const s = db.prepare('SELECT * FROM pos_shifts WHERE id=?').get(Number(shiftId))
  if (!s) throw bad(`班次 #${shiftId} 不存在`, 'SHIFT_NOT_FOUND', 404)
  return s
}

function storeWarehouse(db, storeId) {
  return db
    .prepare("SELECT * FROM warehouses WHERE store_id=? AND status='active' ORDER BY id LIMIT 1")
    .get(Number(storeId))
}

/**
 * 开班。单号走编码规则（PSF），并返回本班的初始状态。
 * 一个收银员同一天不能同时有两个营业中的班次 —— 否则订单归哪个班次就成了运气。
 */
export function openShift(db, { storeId, cashierId = null, cashierName = null, businessDate, openingFloat = 0, deviceNo = null, remark = null }) {
  const bizDate = businessDate || localDate()
  // 同一收银员同一天不能同时有两个**未结清**的班次（营业中或已报数待核款）。
  // 判据是「收银员」不是「门店」—— 一家店同时有几个收银员各管一个钱箱是正常的。
  // 而同一收银员两个未结清班次会让「这笔订单属于哪个班次」变成运气，
  // 于是两个班的现金应收互相串，长短款谁都说不清。
  const exist =
    cashierId != null
      ? db
          .prepare("SELECT id, doc_no, status FROM pos_shifts WHERE store_id=? AND biz_date=? AND cashier_id=? AND status IN ('open','declared') ORDER BY id LIMIT 1")
          .get(Number(storeId), bizDate, Number(cashierId))
      : db
          .prepare("SELECT id, doc_no, status FROM pos_shifts WHERE store_id=? AND biz_date=? AND COALESCE(cashier_name,'')=? AND status IN ('open','declared') ORDER BY id LIMIT 1")
          .get(Number(storeId), bizDate, cashierName || '')
  if (exist) {
    const st = exist.status === 'declared' ? '已报数待核款' : '营业中'
    throw bad(`本日已有${st}的班次（${exist.doc_no || '#' + exist.id}），不能重复开班`, 'SHIFT_ALREADY_OPEN', 409)
  }

  const docNo = nextDocNo(db, 'PSF', 'pos_shifts', 'doc_no', bizDate)
  const info = db
    .prepare(
      `INSERT INTO pos_shifts (doc_no,store_id,cashier_id,cashier_name,biz_date,opened_at,status,opening_float,device_no,remark)
       VALUES (?,?,?,?,?,?,'open',?,?,?)`
    )
    .run(docNo, Number(storeId), cashierId ?? null, cashierName ?? null, bizDate, nowText(), round2(openingFloat), deviceNo ?? null, remark ?? null)
  const id = Number(info.lastInsertRowid)
  logEvent({
    db,
    docType: 'PSF',
    id,
    docNo,
    action: 'open',
    actionName: '开班',
    to: 'open',
    actor: { id: cashierId ?? null, name: cashierName ?? null },
    remark: '开班'
  })
  return loadShift(db, id)
}

/**
 * 交班报数（open → declared）。
 *
 * `payments` 形如 `[{ method:'cash', declared_amount: 1234.5 }, { method:'wxpay', declared_amount: 800 }]`。
 * 收银员**不必**把所有支付方式都报一遍；没报的按 0 记 ——
 * 但系统若有金额而报 0，差异就会立刻出现在 `pos_shift_payments` 上，这正是想要的效果。
 */
export function declareShift(db, req, { shiftId, payments = [], remark = null }) {
  const s = loadShift(db, shiftId)
  if (s.status !== 'open') throw bad(`班次 ${s.doc_no || '#' + s.id} 当前状态为「${s.status}」，只有营业中的班次可以报数`, 'SHIFT_NOT_OPEN', 409)

  const sys = computeShiftSystem(db, s.id)
  if (sys.order_count === 0) {
    throw bad('本班次没有任何有效订单，没有可核对的钱；请直接作废班次', 'SHIFT_NO_ORDERS', 400)
  }

  // 报数金额非负。允许小数（分），不允许负数 —— 负数要么是退款没走单，要么是录错了
  const declared = {}
  for (const p of payments) {
    const m = String(p?.method || '')
    if (!PAY_METHODS.includes(m)) throw bad(`支付方式无效：${m}`, 'PAY_METHOD_INVALID', 400)
    const v = round2(p?.declared_amount)
    if (v < 0) throw bad(`${PAY_METHOD_LABEL[m]} 报数不能为负`, 'DECLARED_NEGATIVE', 400)
    declared[m] = v
  }

  const cashDeclared = round2(declared[CASH_METHOD] || 0)

  db.transaction(() => {
    // 重新报数时先清掉上一次的行，避免残留半套（退回重报会走到这里）
    db.prepare('DELETE FROM pos_shift_payments WHERE shift_id=?').run(s.id)
    const ins = db.prepare(
      `INSERT INTO pos_shift_payments (shift_id,method,sys_amount,declared_amount,counted_amount,diff,order_count,remark)
       VALUES (?,?,?,?,?,?,?,?)`
    )
    for (const m of PAY_METHODS) {
      const sysAmount = round2(sys.byMethod[m].sys_amount)
      const declaredAmount = round2(declared[m] || 0)
      const isCash = m === CASH_METHOD
      // 现金：店长还没数，此时不存在「差异」，diff 记 0（待核款写出）
      // 非现金：没有实物可数，实点即平台流水；差异立刻成立
      const countedAmount = isCash ? 0 : declaredAmount
      const diff = isCash ? 0 : round2(countedAmount - sysAmount)
      if (!isCash && sysAmount === 0 && declaredAmount === 0) continue
      ins.run(s.id, m, sysAmount, declaredAmount, countedAmount, diff, sys.byMethod[m].order_count, null)
    }
    advanceStatus(db, req, {
      docType: 'PSF',
      id: s.id,
      action: 'declare',
      set: { declared_cash: cashDeclared, counted_cash: 0, variance: 0, sys_cash: sys.sys_cash },
      remark: remark || '交班报数'
    })
  })()

  return shiftDetail(db, s.id)
}

/**
 * 核款 / 退回的"第二人"判据（ADR-0025，沿用 ADR-0018 的自审拒绝思路）：
 * 开班人（cashier_id）、历次报数人（doc_events 里 open / declare 的 actor）都算"做账的人"，
 * 他们不能自己核款或退回自己的班 → 409 `POS_SELF_APPROVE`。
 * 历史班次只有名字没有 id（cashier_id 与事件 actor_id 皆空）时按名字兜底。
 * 只有路由传 `separateChecker: true` 才启用：种子数据与 `scripts/test-pos2.mjs` 直接调库函数、
 * 用同一个 req 走完全程，不属于"一个人批自己的班"的授权问题。
 */
export function assertShiftChecker(db, req, shift) {
  const uid = req?.user?.uid ?? null
  const names = new Set([req?.user?.name, req?.user?.username].filter((n) => n && String(n).trim()))
  const makers = db
    .prepare("SELECT actor_id, actor_name FROM doc_events WHERE doc_type='PSF' AND doc_id=? AND action IN ('open','declare')")
    .all(Number(shift.id))
  makers.push({ actor_id: shift.cashier_id ?? null, actor_name: shift.cashier_name ?? null })
  const hit = makers.some((m) =>
    m.actor_id != null ? uid != null && Number(m.actor_id) === Number(uid) : m.actor_name != null && names.has(m.actor_name)
  )
  if (hit) {
    throw bad(`班次 ${shift.doc_no || '#' + shift.id} 由你开班或报数，不能由你自己核款 / 退回`, 'POS_SELF_APPROVE', 409)
  }
}

/**
 * 退回重报（declared → open）。
 * 店长数出来与报表差太多（比如差一整个数量级）时用 —— 先退回收银员自己再数一遍，
 * 比当场批一张「长短款 XXX 元」合理得多。
 */
export function rejectShift(db, req, { shiftId, remark = null, separateChecker = false }) {
  const s = loadShift(db, shiftId)
  if (separateChecker) assertShiftChecker(db, req, s)
  if (s.status !== 'declared') throw bad(`班次 ${s.doc_no || '#' + s.id} 当前状态为「${s.status}」，只有已报数的班次可以退回`, 'SHIFT_NOT_DECLARED', 409)
  if (!String(remark || '').trim()) throw bad('退回必须写明原因（否则收银员不知道该重数什么）', 'REMARK_REQUIRED', 400)
  db.transaction(() => {
    db.prepare('DELETE FROM pos_shift_payments WHERE shift_id=?').run(s.id)
    advanceStatus(db, req, {
      docType: 'PSF',
      id: s.id,
      action: 'reject',
      set: { declared_cash: 0, counted_cash: 0, variance: 0 },
      remark
    })
  })()
  return shiftDetail(db, s.id)
}

/**
 * 店长核款（declared → closed）。差异在这里出生。
 *
 * `countedCash` 是店长自己数出来的现金，**必填** —— 允许不填就等于允许
 * 「用收银员报的数当实点核过去」，长短款永远是 0，核款就成了走形式。
 */
export function approveShift(db, req, { shiftId, countedCash, varianceNote = null, varianceHandled = null, floatReturned = true, remark = null, separateChecker = false }) {
  const s = loadShift(db, shiftId)
  if (separateChecker) assertShiftChecker(db, req, s)
  if (s.status !== 'declared') throw bad(`班次 ${s.doc_no || '#' + s.id} 当前状态为「${s.status}」，只有已报数的班次可以核款`, 'SHIFT_NOT_DECLARED', 409)
  if (countedCash === undefined || countedCash === null || String(countedCash).trim() === '') {
    throw bad('核款必须填写店长实点现金（不能直接沿用收银员的报数）', 'COUNTED_REQUIRED', 400)
  }
  const counted = round2(countedCash)
  if (counted < 0) throw bad('实点现金不能为负', 'COUNTED_NEGATIVE', 400)

  const sysCash = round2(s.sys_cash)
  const variance = round2(counted - sysCash)
  const limit = getVarianceLimit(db)

  let handled = null
  if (!isZero(variance)) {
    if (!String(varianceNote || '').trim()) {
      throw bad(`存在长短款 ${variance > 0 ? '+' : ''}${variance} 元，必须填写差异原因`, 'VARIANCE_NOTE_REQUIRED', 400)
    }
    if (!HANDLE_TYPES[varianceHandled]) {
      throw bad(`存在长短款 ${variance > 0 ? '+' : ''}${variance} 元，必须选择责任归属（charge 责任人承担 / absorb 门店承担 / pending 挂账待查）`, 'VARIANCE_HANDLE_REQUIRED', 400)
    }
    if (Math.abs(variance) > limit && varianceHandled !== 'pending') {
      throw bad(
        `长短款 ${variance > 0 ? '+' : ''}${variance} 元已超过门店可自结上限 ${limit} 元，必须选择「挂账待查」由总部处理`,
        'VARIANCE_LIMIT_EXCEEDED',
        400
      )
    }
    handled = varianceHandled
  }

  db.transaction(() => {
    // 现金行的实点与差异在这里写入；非现金行的 diff 在报数时就已经成立，不再动
    db.prepare(
      `UPDATE pos_shift_payments
          SET counted_amount = ?, diff = ?, remark = COALESCE(?, remark)
        WHERE shift_id = ? AND method = ?`
    ).run(counted, variance, varianceNote, s.id, CASH_METHOD)
    // 现金行可能因为「系统与报数都为 0」在报数时被跳过；核款时若店长数出了钱，补一行
    const hasCash = db.prepare('SELECT 1 AS hit FROM pos_shift_payments WHERE shift_id=? AND method=?').get(s.id, CASH_METHOD)
    if (!hasCash) {
      db.prepare(
        `INSERT INTO pos_shift_payments (shift_id,method,sys_amount,declared_amount,counted_amount,diff,order_count,remark)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(s.id, CASH_METHOD, sysCash, round2(s.declared_cash), counted, variance, 0, varianceNote)
    }
    advanceStatus(db, req, {
      docType: 'PSF',
      id: s.id,
      action: 'approve',
      set: {
        counted_cash: counted,
        variance,
        variance_note: varianceNote ?? null,
        variance_handled: handled,
        approved_by: req?.user?.uid ?? null,
        approved_by_name: req?.user?.name || req?.user?.username || null,
        approved_at: nowText(),
        closed_at: s.closed_at || nowText(),
        opening_float_done: floatReturned === false ? 0 : 1
      },
      remark: remark || (isZero(variance) ? '店长核款：账实相符' : `店长核款：长短款 ${variance > 0 ? '+' : ''}${variance}`)
    })
  })()

  return shiftDetail(db, s.id)
}

/**
 * 总部落案（把 `pending` 改成 charge / absorb）。
 *
 * 这一步**不是状态流转** —— 班次停在 `closed` 是终态，内核不变量「终态不能有出边」
 * 不允许再挂一条 `closed → closed` 的边。所以这里直接改字段 + `logEvent` 补留痕：
 * 结论是「谁在什么时候把这笔差异从挂账改成谁承担」，而这条信息本来就属于事件流。
 */
export function settleVariance(db, req, { shiftId, handled, note = null }) {
  const s = loadShift(db, shiftId)
  if (s.status !== 'closed') throw bad('只有已核款的班次可以处理挂账差异', 'SHIFT_NOT_CLOSED', 409)
  if (s.variance_handled !== 'pending') throw bad('该班次没有挂账待查的差异', 'NO_PENDING_VARIANCE', 400)
  if (!['charge', 'absorb'].includes(handled)) throw bad('结案结论只能是 charge（责任人承担）或 absorb（门店承担）', 'HANDLE_INVALID', 400)
  const from = s.variance_handled
  db.prepare('UPDATE pos_shifts SET variance_handled=?, variance_note=?, updated_at=? WHERE id=?').run(
    handled,
    note ? `${s.variance_note || ''}${s.variance_note ? '；' : ''}${note}` : s.variance_note,
    nowText(),
    s.id
  )
  logEvent({
    db,
    docType: 'PSF',
    id: s.id,
    docNo: s.doc_no,
    action: 'settle',
    actionName: '差异结案',
    from: s.status,
    to: s.status,
    actor: { id: req?.user?.uid ?? null, name: req?.user?.name || req?.user?.username || null },
    remark: `长短款 ${round2(s.variance)} 元：${HANDLE_TYPES[from]} → ${HANDLE_TYPES[handled]}${note ? '；' + note : ''}`
  })
  return shiftDetail(db, s.id)
}

/** 作废班次。有订单挂靠时不允许 —— 否则订单变成没有班次的孤儿 */
export function cancelShift(db, req, { shiftId, remark = null }) {
  const s = loadShift(db, shiftId)
  if (!['open', 'declared'].includes(s.status)) {
    throw bad(`班次 ${s.doc_no || '#' + s.id} 当前状态为「${s.status}」，只有营业中或已报数的班次可以作废`, 'SHIFT_NOT_CANCELLABLE', 409)
  }
  const cnt = db.prepare("SELECT COUNT(*) c FROM pos_orders WHERE shift_id=? AND status IN ('local','synced')").get(s.id).c
  if (cnt > 0) {
    throw bad(`本班次已发生 ${cnt} 笔有效交易，不能作废；请先完成交班核款`, 'SHIFT_HAS_ORDERS', 409)
  }
  db.transaction(() => {
    db.prepare('DELETE FROM pos_shift_payments WHERE shift_id=?').run(s.id)
    advanceStatus(db, req, {
      docType: 'PSF',
      id: s.id,
      action: 'cancel',
      set: { closed_at: nowText(), declared_cash: 0, counted_cash: 0, variance: 0 },
      remark: remark || '作废班次'
    })
  })()
  return shiftDetail(db, s.id)
}

/** 门店补一个「未开班」的班次回来（历史数据修复用，走内核留痕） */
export function attachLegacyShiftNo(db, shiftId) {
  const s = loadShift(db, shiftId)
  if (s.doc_no) return s.doc_no
  const docNo = nextDocNo(db, 'PSF', 'pos_shifts', 'doc_no', s.biz_date)
  db.prepare('UPDATE pos_shifts SET doc_no=? WHERE id=?').run(docNo, s.id)
  return docNo
}

// ---------------------------------------------------------------------------
// 三、缴款单
// ---------------------------------------------------------------------------

/**
 * 创建缴款单（一次可汇总多个班次 —— 打烊时把当班几个人的钱一起交给店长）。
 *
 * 每个班次**必须一次性缴清** `counted_cash`，不做部分缴款：
 * `UNIQUE (shift_id)` 表达不了"缴了一半"，于是部分缴款会让同一笔钱能被交两遍，
 * 而「重复缴款」在账上看起来只是"钱交多了"。
 */
export function createCashDrop(db, req, { storeId, shiftIds = [], dropDate, handedBy = null, handedByName = null, referenceNo = null, remark = null }) {
  const ids = [...new Set((shiftIds || []).map(Number).filter(Boolean))]
  if (!ids.length) throw bad('请至少选择一个班次缴款', 'NO_SHIFT_SELECTED', 400)
  const date = dropDate || localDate()

  const shifts = ids.map((id) => loadShift(db, id))
  for (const s of shifts) {
    if (Number(s.store_id) !== Number(storeId)) throw bad(`班次 ${s.doc_no} 不属于本门店`, 'SHIFT_STORE_MISMATCH', 400)
    if (s.status !== 'closed') throw bad(`班次 ${s.doc_no} 尚未核款（状态 ${s.status}），不能缴款`, 'SHIFT_NOT_CLOSED', 409)
    if (isZero(s.counted_cash) || num(s.counted_cash) <= 0) throw bad(`班次 ${s.doc_no} 实点现金为 0，无需缴款`, 'NOTHING_TO_DROP', 400)
    if (num(s.cash_drop_amount) + VARIANCE_EPS >= num(s.counted_cash)) throw bad(`班次 ${s.doc_no} 的现金已缴过款`, 'ALREADY_DROPPED', 409)
    const dup = db.prepare('SELECT drop_id FROM pos_cash_drop_items WHERE shift_id=?').get(s.id)
    if (dup) throw bad(`班次 ${s.doc_no} 已在缴款单 #${dup.drop_id} 中`, 'ALREADY_DROPPED', 409)
  }

  const amount = round2(shifts.reduce((n, s) => n + (num(s.counted_cash) - num(s.cash_drop_amount)), 0))
  if (amount <= 0) throw bad('缴款金额必须大于 0', 'AMOUNT_INVALID', 400)

  const docNo = nextDocNo(db, 'JKD', 'pos_cash_drops', 'doc_no', date)
  const dropId = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO pos_cash_drops (doc_no,store_id,drop_date,amount,handed_by,handed_by_name,reference_no,status,remark,created_by,created_by_name)
         VALUES (?,?,?,?,?,?,?,'pending',?,?,?)`
      )
      .run(docNo, Number(storeId), date, amount, handedBy ?? null, handedByName ?? null, referenceNo ?? null, remark ?? null, req?.user?.uid ?? null, req?.user?.name || null)
    const id = Number(info.lastInsertRowid)
    const insItem = db.prepare('INSERT INTO pos_cash_drop_items (drop_id,shift_id,shift_no,amount,remark) VALUES (?,?,?,?,?)')
    for (const s of shifts) {
      const amt = round2(num(s.counted_cash) - num(s.cash_drop_amount))
      insItem.run(id, s.id, s.doc_no, amt, null)
      db.prepare('UPDATE pos_shifts SET cash_drop_amount = COALESCE(cash_drop_amount,0) + ?, updated_at=? WHERE id=?').run(amt, nowText(), s.id)
    }
    return id
  })()

  return { id: dropId, doc_no: docNo, amount, shift_count: shifts.length }
}

/** 店长接收缴款（pending → received）。缴款人与接收人不能是同一人 */
export function receiveCashDrop(db, req, { dropId, referenceNo = null, remark = null }) {
  const d = db.prepare('SELECT * FROM pos_cash_drops WHERE id=?').get(Number(dropId))
  if (!d) throw bad(`缴款单 #${dropId} 不存在`, 'DROP_NOT_FOUND', 404)
  if (d.status !== 'pending') throw bad(`缴款单 ${d.doc_no} 当前状态为「${DROP_STATUS[d.status] || d.status}」，不能接收`, 'DROP_NOT_PENDING', 409)
  const uid = req?.user?.uid ?? null
  if (uid != null && d.handed_by != null && Number(d.handed_by) === Number(uid)) {
    throw bad('缴款人与接收人不能是同一人（自己的钱自己收等于没有交接）', 'SAME_PERSON', 400)
  }
  db.prepare(
    `UPDATE pos_cash_drops SET status='received', received_by=?, received_by_name=?, received_at=?,
       reference_no=COALESCE(?, reference_no), remark=COALESCE(?, remark), updated_at=? WHERE id=?`
  ).run(uid, req?.user?.name || null, nowText(), referenceNo, remark, nowText(), d.id)
  return db.prepare('SELECT * FROM pos_cash_drops WHERE id=?').get(d.id)
}

/**
 * 取消缴款单（pending → cancelled）。
 *
 * **必须把班次的 `cash_drop_amount` 退回去、并删掉明细** ——
 * 否则钱既留在缴款单里、又算在班次的「已缴」上，那个班次永远缴不了第二次，
 * 而界面上只显示"这笔钱已交"，看不出是张作废单占着位置。
 */
export function cancelCashDrop(db, req, { dropId, remark = null }) {
  const d = db.prepare('SELECT * FROM pos_cash_drops WHERE id=?').get(Number(dropId))
  if (!d) throw bad(`缴款单 #${dropId} 不存在`, 'DROP_NOT_FOUND', 404)
  if (d.status !== 'pending') throw bad(`缴款单 ${d.doc_no} 当前状态为「${DROP_STATUS[d.status] || d.status}」，不能取消`, 'DROP_NOT_PENDING', 409)
  db.transaction(() => {
    const items = db.prepare('SELECT * FROM pos_cash_drop_items WHERE drop_id=?').all(d.id)
    for (const it of items) {
      db.prepare('UPDATE pos_shifts SET cash_drop_amount = MAX(0, COALESCE(cash_drop_amount,0) - ?), updated_at=? WHERE id=?').run(
        round2(it.amount),
        nowText(),
        it.shift_id
      )
    }
    db.prepare('DELETE FROM pos_cash_drop_items WHERE drop_id=?').run(d.id)
    db.prepare("UPDATE pos_cash_drops SET status='cancelled', remark=COALESCE(?, remark), updated_at=? WHERE id=?").run(remark, nowText(), d.id)
  })()
  return db.prepare('SELECT * FROM pos_cash_drops WHERE id=?').get(d.id)
}

// ---------------------------------------------------------------------------
// 四、日结门禁与现金汇总
// ---------------------------------------------------------------------------

/**
 * 日结门禁。返回 `{ ok, blocking }`：`blocking` 是拦下来的班次（未核款 / 营业中）。
 *
 * **未核款不得日结**：日结把货与钱一起交总部，货按订单过账、钱按实点过账；
 * 若班次还没核款，钱这一边根本没有数字可过，而"先上传货、钱以后再说"
 * 会让这个营业日的现金永远对不上（上传那一刻的账面是对的，事后没人会回来补）。
 */
export function dailyCloseGate(db, { storeId, bizDate }) {
  const rows = db
    .prepare("SELECT id, doc_no, status, cashier_name, counted_cash, variance FROM pos_shifts WHERE store_id=? AND biz_date=? AND status NOT IN ('closed','cancelled') ORDER BY id")
    .all(Number(storeId), bizDate)
  if (!rows.length) return { ok: true, blocking: [] }
  const open = rows.filter((r) => r.status === 'open')
  const declared = rows.filter((r) => r.status === 'declared')
  const parts = []
  if (declared.length) parts.push(`${declared.length} 个班次已报数但店长未核款（${declared.map((r) => r.doc_no).join('、')}）`)
  if (open.length) parts.push(`${open.length} 个班次仍在营业中（${open.map((r) => r.doc_no).join('、')}）`)
  return { ok: false, blocking: rows, message: `${bizDate} 尚不能日结：${parts.join('；')}` }
}

/** 该营业日的现金汇总（日结单的现金字段来源，唯一口径） */
export function computeDailyCash(db, { storeId, bizDate }) {
  const rows = db
    .prepare("SELECT id, doc_no, sys_cash, counted_cash, variance, cash_drop_amount FROM pos_shifts WHERE store_id=? AND biz_date=? AND status='closed' ORDER BY id")
    .all(Number(storeId), bizDate)
  const sum = (k) => round2(rows.reduce((n, r) => n + num(r[k]), 0))
  return {
    shift_ids: rows.map((r) => r.id),
    shift_nos: rows.map((r) => r.doc_no),
    closed_shift_count: rows.length,
    sys_cash: sum('sys_cash'),
    counted_cash: sum('counted_cash'),
    cash_variance: sum('variance'),
    drop_amount: sum('cash_drop_amount')
  }
}

// ---------------------------------------------------------------------------
// 六、收银开单（供路由与 seed 共用，保证「开单必绑班次」只有一处实现）
// ---------------------------------------------------------------------------

/**
 * 开单收银（本地单：不扣库存、不写总部，日结时统一上传）。
 *
 * `shiftId` **必填** —— 见文件头：靠「同门店 + 同业务日 + 同收银员」现算归属，
 * 会在同一收银员一天两个班时把两个班的现金应收算成同一批订单（直接翻倍）。
 * 开单那一刻就把归属写下来，这个错误在结构上不可能发生。
 */
/**
 * 门店开单的**算钱**部分（唯一实现）—— 试算端点与落单共用它。
 *
 * 为什么必须抽出来：收银台上"应收"这个数是给收银员看、给客户付的，
 * 一旦试算与落单各算一次，就会出现在"页面 ¥128、收款 ¥126"这种差异 ——
 * 它不报错，只会每天在交班核款时长短款两块钱。
 *
 * 基准单价 = 取价引擎的出口（会员带手机号则用会员价），营销域只在这个基准**之上**
 * 做等级折扣 / 促销 / 券 / 积分；**手工让利**（店长现场决定）不参与促销预算，
 * 作为整单减项叠加在最后。
 */
export function posQuote(db, {
  items = [],
  memberPhone = '',
  couponCodes = [],
  usePoints = 0,
  autoCoupon = false,
  discountAmount = 0
} = {}) {
  if (!Array.isArray(items) || !items.length) throw bad('至少一条商品明细', 'NO_ITEMS', 400)
  let totalQty = 0
  let totalCents = 0
  const lines = []
  for (const it of items) {
    const sku = db
      .prepare('SELECT s.*, p.name AS product_name FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
      .get(Number(it.sku_id))
    if (!sku) throw bad(`SKU#${it.sku_id} 不存在`, 'SKU_NOT_FOUND', 404)
    const qty = num(it.qty)
    if (!(qty > 0)) throw bad('数量必须大于 0', 'QTY_INVALID', 400)
    const unitCents = Math.round(round2(memberPhone && sku.price_member ? sku.price_member : sku.price_retail) * 100)
    if (!(unitCents > 0)) throw bad(`SKU#${it.sku_id} 单价异常`, 'PRICE_INVALID', 400)
    totalQty += qty
    totalCents += unitCents * qty
    lines.push({ sku, qty, unitCents })
  }
  const totalAmount = round2(totalCents / 100)
  // 会员身份：POS 单没有会话（收银员是员工、客户是顾客），客户身份来自**会员手机号** ——
  // 那是收银员当场输入的、属于业务输入而不是凭据，所以按 `mall_customers.phone` 查档，
  // 查不到就按散客结算（**不建档**：建档是登录的职责）。
  const cust = memberPhone
    ? db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(String(memberPhone))
    : null
  const customerId = cust ? M.ensureAccount(db, cust.id).customer_id : null

  const quote = K.quote(db, {
    items: K.buildItems(db, lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty, unit_price_cents: l.unitCents }))),
    customerId,
    couponCodes,
    autoCoupon: !!autoCoupon,
    usePoints: Number(usePoints) || 0
  })
  const manualDiscount = round2(Math.max(0, Number(discountAmount) || 0))
  const promoDiscount = round2(quote.discount_total / 100)
  const discount = round2(promoDiscount + manualDiscount)
  const payAmount = round2(Math.max(0, quote.payable / 100 - manualDiscount))
  return {
    lines,
    customerId,
    customer: cust || null,
    totalQty,
    totalAmount,
    quote,
    promoDiscount,
    manualDiscount,
    discount,
    payAmount,
    // 手工让利把单减到 0 以下：不静默截断，交给调用方如实记录
    overDiscounted: quote.payable / 100 - manualDiscount < 0
  }
}

export function createPosOrder(db, {
  storeId,
  warehouseId = null,
  shiftId,
  cashierId = null,
  cashierName = null,
  items = [],
  memberPhone = '',
  payMethod = CASH_METHOD,
  discountAmount = 0,
  remark = null,
  couponCodes = [],
  usePoints = 0,
  autoCoupon = false
}) {
  const shift = loadShift(db, shiftId)
  if (shift.status !== 'open') throw bad(`班次 ${shift.doc_no || '#' + shift.id} 不是营业中状态，不能开单`, 'SHIFT_NOT_OPEN', 409)
  if (Number(shift.store_id) !== Number(storeId)) throw bad('班次不属于本门店', 'SHIFT_STORE_MISMATCH', 400)
  if (!PAY_METHODS.includes(payMethod)) throw bad(`支付方式无效：${payMethod}`, 'PAY_METHOD_INVALID', 400)

  const calc = posQuote(db, { items, memberPhone, couponCodes, usePoints, autoCoupon, discountAmount })
  const { totalQty, totalAmount, manualDiscount, lines, customerId } = calc
  const bizDate = shift.biz_date

  return db.transaction(() => {
    const docNo = nextDocNo(db, 'POS', 'pos_orders', 'doc_no', bizDate)
    const info = db
      .prepare(
        `INSERT INTO pos_orders (doc_no,store_id,warehouse_id,cashier_id,cashier_name,biz_date,member_phone,
                                  total_qty,total_amount,discount_amount,pay_amount,pay_method,status,shift_id,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'local',?,?)`
      )
      .run(
        docNo, Number(storeId), warehouseId ?? null, cashierId ?? shift.cashier_id ?? null, cashierName ?? shift.cashier_name ?? null,
        // 先按"商品额 − 手工让利"落一个初值，事务末尾会**用结算结果覆盖**成最终值。
        // 不直接用 totalAmount 是因为窗口里有 NOT NULL / 正数约束，留空会让插入失败得莫名其妙。
        bizDate, memberPhone || null, totalQty, totalAmount, manualDiscount, round2(Math.max(0, totalAmount - manualDiscount)),
        payMethod, shift.id, remark ?? null
      )
    const posId = Number(info.lastInsertRowid)

    // 先插明细拿到行 id，再让结算层按**真实行 id** 落优惠留痕（与商城同一条路径）
    const ins = db.prepare(
      'INSERT INTO pos_order_items (pos_order_id,sku_id,sku_code,sku_name,price,qty,amount) VALUES (?,?,?,?,?,?,?)'
    )
    for (const { sku, qty, unitCents } of lines) {
      ins.run(posId, sku.id, sku.sku_code, `${sku.product_name} ${sku.name}`,
        unitCents / 100, qty, (unitCents * qty) / 100)
    }

    // 结算：留痕 + 使用登记 + 券核销 + 积分扣/送，全部在一个事务里
    const settled = K.settle(db, {
      source: 'pos',
      orderId: posId,
      items: K.buildItems(db, lines.map((l) => ({ sku_id: l.sku.id, qty: l.qty, unit_price_cents: l.unitCents }))),
      customerId,
      couponCodes,
      autoCoupon: !!autoCoupon,
      usePoints: Number(usePoints) || 0
    })
    // 行级优惠三段回写（同商城）：`pos_orders.discount_amount` 只有一个整单数，
    // 回答不了"减在哪几行"，退货时就算不出"这一行实付多少"
    const itemIds = db.prepare('SELECT id FROM pos_order_items WHERE pos_order_id=? ORDER BY id').all(posId)
    const updItem = db.prepare(
      'UPDATE pos_order_items SET member_discount_cents=?, promo_discount_cents=?, points_discount_cents=? WHERE id=?'
    )
    settled.line_discounts.forEach((l, i) => {
      if (itemIds[i]) updItem.run(l.member_discount, l.promotion_discount, l.points_discount, itemIds[i].id)
    })
    // 落单金额一律以**结算结果**为准（`settle` 内部自己 re-quote，它是权威）。
    // 试算（`posQuote`）与结算走的是同一个 `K.quote`，两边若出现分歧说明有人
    // 在其中一条路径上加了自己的算法 —— 那种错只会表现为"页面一个数、收款另一个数"，
    // 所以这里做一条**显式对照**，把它变成当场可见的失败。
    const promoDiscount = round2(settled.discount_total / 100)
    const discount = round2(promoDiscount + manualDiscount)
    const payAmount = round2(Math.max(0, settled.payable / 100 - manualDiscount))
    if (calc.discount !== discount || calc.payAmount !== payAmount) {
      throw bad(
        `门店结算与试算不一致（试算 优惠 ${calc.discount} / 应收 ${calc.payAmount}，结算 优惠 ${discount} / 应收 ${payAmount}）`,
        'SETTLE_PREVIEW_MISMATCH', 500,
        { preview: { discount: calc.discount, payAmount: calc.payAmount }, settled: { discount, payAmount } }
      )
    }
    // 手工让利把单减到 0 以下：把差额如实写进备注 ——
    // 静默截断会让"这一单为什么只收了 3 块"永远查不出来。
    if (settled.payable / 100 - manualDiscount < 0) {
      db.prepare('UPDATE pos_orders SET remark=? WHERE id=?').run(
        `${remark ?? ''}${remark ? '；' : ''}手工让利 ¥${manualDiscount} 超出结算后应付 ¥${round2(settled.payable / 100)}，已按 0 收取`,
        posId
      )
    }
    db.prepare('UPDATE pos_orders SET discount_amount=?, pay_amount=? WHERE id=?').run(discount, payAmount, posId)

    return {
      id: posId,
      doc_no: docNo,
      pay_amount: payAmount,
      total_amount: totalAmount,
      discount_amount: discount,
      promo_discount: promoDiscount,
      manual_discount: manualDiscount,
      member_discount: round2(settled.member_discount / 100),
      promotion_discount: round2(settled.promotion_discount / 100),
      points_discount: round2(settled.points_discount / 100),
      points_used: settled.points_used,
      points_earned: settled.points_earned?.earned ?? 0,
      shift_id: shift.id,
      shift_no: shift.doc_no,
      biz_date: bizDate
    }
  })()
}

/**
 * 作废本机订单（`local`）。
 *
 * 作废是"A14 渠道闭环"里**最容易漏掉的那一半**：开单时结算层落了
 * 优惠留痕 / 使用登记 / 券核销 / 积分，作废时若只想把单据状态改成 `voided`，
 * 那些留痕就永远留在账上 —— 限量券的名额被一张作废单占着、客户的积分白扣，
 * 而两张表分别在两个模块里，任何单表检查都发现不了。
 *
 * 所以状态流转与 `checkout.unsettle` **必须在同一个事务里**：
 * 只成功一半的后果是"单废了、优惠没退"，且不像任何一条报错。
 */
export function voidPosOrder(db, { id, storeId = null, remark = '门店作废本机订单', actor = null }) {
  const o = db
    .prepare("SELECT * FROM pos_orders WHERE id=? AND status='local'" + (storeId != null ? ' AND store_id=?' : ''))
    .get(...(storeId != null ? [Number(id), Number(storeId)] : [Number(id)]))
  if (!o) throw bad('仅本机未上传的订单可作废', 'NOT_VOIDABLE', 400)
  if (o.shift_id) {
    const sh = db.prepare('SELECT status FROM pos_shifts WHERE id=?').get(o.shift_id)
    if (sh && sh.status === 'closed') {
      throw bad('该订单所属班次已核款，不能作废（否则现金口径对不上）', 'SHIFT_CLOSED', 409)
    }
  }
  return db.transaction(() => {
    // 用 `advanceStatus` 的显式 `actor` 参数（D5 加的），而不是伪造一个 req 对象 ——
    // 伪造出来的 req 会让"谁做的这次流转"失真，而留痕的第一要素是人。
    advanceStatus(db, null, { docType: 'PS', id: Number(id), action: 'void', remark, actor })
    // 撤单要回退的"累计消费"= 结算时计入的实付金额（分）
    const rev = K.unsettle(db, {
      source: 'pos',
      orderId: Number(id),
      reason: `${remark}（${o.doc_no}）`,
      orderAmountCents: Math.round(Number(o.pay_amount) * 100)
    })
    return { id: Number(id), doc_no: o.doc_no, ...rev }
  })()
}

// ---------------------------------------------------------------------------
// 七、日结（含核款门禁与现金口径）
// ---------------------------------------------------------------------------

/**
 * 日结：把本营业日的本地单集中上传总部。
 *
 * 与改前的三点差异，全部是**为了钱能对上**：
 *  ① **核款门禁**：该营业日该店只要还有未核款的班次，一律不许日结。
 *     日结把货与钱一起交总部：货按订单过账、钱按实点过账。班次没核款，
 *     钱这一边没有数字可过，而"先上传货、钱以后再说"会让这个营业日的现金永远对不上。
 *  ② **只上传本营业日的本地单**。此前是「本店所有 local 单」，
 *     跨营业日打包会让日结单的现金汇总与实际上传的货不是同一天。
 *  ③ **日结单落现金三段数**（系统应收 / 实点 / 长短款）与已缴款金额。
 *     只存订单口径，长短款就永远在账上出现不了 —— 而它恰恰是要被看见的东西。
 */
export function dailyClose(db, req, { storeId, warehouseId, storeName = null, bizDate, operatorUid = null, operatorName = null }) {
  const date = bizDate || localDate()
  if (!warehouseId) throw bad('该门店未绑定门店仓库，无法日结上传', 'NO_STORE_WAREHOUSE', 400)

  const gate = dailyCloseGate(db, { storeId, bizDate: date })
  if (!gate.ok) {
    const e = bad(gate.message, 'SHIFT_NOT_REVIEWED', 409)
    e.detail = { blocking: gate.blocking.map((b) => ({ id: b.id, doc_no: b.doc_no, status: b.status })) }
    throw e
  }

  const locals = db
    .prepare("SELECT * FROM pos_orders WHERE store_id=? AND biz_date=? AND status='local' ORDER BY id")
    .all(Number(storeId), date)
  if (!locals.length) throw bad('没有待上传的本机订单，无需日结', 'NO_LOCAL_ORDERS', 400)

  const cash = computeDailyCash(db, { storeId, bizDate: date })
  const batchNo = nextDocNo(db, 'RBJ', 'pos_daily_closes', 'batch_no', date)

  return db.transaction(() => {
    const soIds = []
    let salesAmount = 0
    let refundAmount = 0
    const payMap = {}
    for (const po of locals) {
      const items = db.prepare('SELECT * FROM pos_order_items WHERE pos_order_id=?').all(po.id)
      const docNo = nextDocNo(db, 'XS', 'sales_orders', 'doc_no', date)
      const info = db
        .prepare(
          `INSERT INTO sales_orders
           (doc_no,channel,store_id,order_date,status,total_qty,goods_amount,discount_amount,freight,
            receivable_amount,paid_amount,receiver,receiver_phone,salesperson,remark,created_by,warehouse_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          docNo, 'store', Number(storeId), po.biz_date, 'completed',
          po.total_qty, po.total_amount, po.discount_amount, 0,
          po.pay_amount, po.pay_amount,
          po.member_phone ? `会员 ${po.member_phone}` : '散客', po.member_phone || null,
          po.cashier_name || operatorName, `POS 日结上传 ${po.doc_no}`, operatorUid, warehouseId
        )
      const soId = Number(info.lastInsertRowid)
      soIds.push(soId)
      const insItem = db.prepare(
        'INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,remark) VALUES (?,?,?,?,?,?,?)'
      )
      for (const it of items) {
        insItem.run(soId, it.sku_id, it.qty, it.price, 0, it.amount, null)
        // 门店仓出库：按批次先进先出 + 临期优先（与销售发货同口径）。
        // 退款单（负额）不动库存 —— 货已经由退货单入回去了，这里再出一次就是重复扣减。
        if (num(po.pay_amount) >= 0) {
          const { picks, shortage } = pickBatches(db, warehouseId, it.sku_id, it.qty)
          if (shortage > 0) {
            const err = bad(`库存不足，无法日结上传：SKU#${it.sku_id} 缺 ${shortage}。请先补货或调整数量。`, 'INSUFFICIENT_STOCK', 400)
            throw err
          }
          for (const pk of picks) {
            applyStockOut(db, {
              warehouseId, skuId: it.sku_id, qty: pk.qty, batchNo: pk.batchNo,
              bizDate: po.biz_date, docType: 'SAL_OUT', docNo, docId: soId,
              counterparty: storeName, operator: po.cashier_name || operatorName
            })
          }
        }
      }
      if (num(po.pay_amount) >= 0) {
        salesAmount += num(po.pay_amount)
        payMap[po.pay_method] = round2((payMap[po.pay_method] || 0) + num(po.pay_amount))
      } else {
        refundAmount += -num(po.pay_amount)
      }
      advanceStatus(db, req, {
        docType: 'PS',
        id: po.id,
        action: 'sync',
        set: { sync_batch: batchNo, sync_at: nowText() },
        remark: `日结批次 ${batchNo}`
      })
    }
    const net = round2(salesAmount - refundAmount)
    const closeInfo = db
      .prepare(
        `INSERT INTO pos_daily_closes (batch_no,store_id,warehouse_id,biz_date,order_count,sales_amount,refund_amount,
                                        net_amount,pay_breakdown,uploaded_orders,status,hq_sales_order_ids,operator,
                                        shift_ids,closed_shift_count,sys_cash,counted_cash,cash_variance,drop_amount,
                                        created_by,created_by_name)
         VALUES (?,?,?,?,?,?,?,?,?,?,'uploaded',?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        batchNo, Number(storeId), warehouseId, date, locals.length,
        round2(salesAmount), round2(refundAmount), net,
        JSON.stringify(payMap), locals.length, soIds.join(','), operatorName,
        cash.shift_ids.join(','), cash.closed_shift_count, cash.sys_cash, cash.counted_cash,
        cash.cash_variance, cash.drop_amount, operatorUid, operatorName
      )
    const closeId = Number(closeInfo.lastInsertRowid)
    for (const sid of cash.shift_ids) {
      db.prepare('UPDATE pos_shifts SET daily_close_id=?, updated_at=? WHERE id=?').run(closeId, nowText(), sid)
    }
    return {
      batchNo, closeId, soIds,
      salesAmount: round2(salesAmount), refundAmount: round2(refundAmount),
      net, netAmount: net, orderCount: locals.length, cash
    }
  })()
}

// ---------------------------------------------------------------------------
// 八、班次详情 / 列表（前端与总部共用同一份口径）
// ---------------------------------------------------------------------------

/** 班次全景：头 + 各支付方式差异 + 归属订单数 + 该店该日的门禁状态 */
export function shiftDetail(db, shiftId) {
  const head = db
    .prepare(
      `SELECT v.*, (SELECT COUNT(*) FROM pos_orders o WHERE o.shift_id = v.shift_id AND o.status IN ('local','synced')) AS live_order_count,
              (SELECT COALESCE(SUM(o.pay_amount),0) FROM pos_orders o WHERE o.shift_id = v.shift_id AND o.status IN ('local','synced')) AS live_order_amount
         FROM v_pos_shift_variance v WHERE v.shift_id = ?`
    )
    .get(Number(shiftId))
  if (!head) throw bad(`班次 #${shiftId} 不存在`, 'SHIFT_NOT_FOUND', 404)
  const payments = db.prepare('SELECT * FROM pos_shift_payments WHERE shift_id=? ORDER BY id').all(Number(shiftId))
  const dropItem = db
    .prepare(
      `SELECT i.*, d.doc_no, d.status AS drop_status, d.drop_date, d.handed_by_name, d.received_by_name
         FROM pos_cash_drop_items i JOIN pos_cash_drops d ON d.id=i.drop_id WHERE i.shift_id=?`
    )
    .get(Number(shiftId))
  const limit = getVarianceLimit(db)
  return {
    shift: head,
    payments,
    cash_drop: dropItem || null,
    variance_limit: limit,
    // 前端用它决定「核款」按钮点下去之后该不该出现「挂账待查」这一项
    must_pending: Math.abs(num(head.variance)) > limit,
    can_settle: head.status === 'closed' && head.variance_handled === 'pending'
  }
}

/** 班次列表（门店视角 / 总部视角共用） */
export function listShifts(db, { storeId = null, bizDate = null, status = null, from = null, to = null, limit = 100 } = {}) {
  const where = []
  const params = []
  if (storeId) { where.push('s.store_id = ?'); params.push(Number(storeId)) }
  if (bizDate) { where.push('s.biz_date = ?'); params.push(bizDate) }
  if (from) { where.push('s.biz_date >= ?'); params.push(from) }
  if (to) { where.push('s.biz_date <= ?'); params.push(to) }
  if (status) { where.push('s.status = ?'); params.push(status) }
  const sql = `SELECT s.*, st.name AS store_name,
                      (SELECT COUNT(*) FROM pos_shift_payments p WHERE p.shift_id=s.id) AS pay_method_count,
                      (SELECT COALESCE(SUM(p.diff),0) FROM pos_shift_payments p WHERE p.shift_id=s.id) AS pay_diff_total,
                      (SELECT COUNT(*) FROM pos_orders o WHERE o.shift_id=s.id AND o.status IN ('local','synced')) AS order_count
                 FROM pos_shifts s LEFT JOIN stores st ON st.id=s.store_id
                ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
                ORDER BY s.biz_date DESC, s.id DESC LIMIT ?`
  params.push(Number(limit))
  return db.prepare(sql).all(...params)
}

// ---------------------------------------------------------------------------
// 九、门店退货（顾客退货 → 门店仓入库 + 退款登记）
// ---------------------------------------------------------------------------

/**
 * 门店退货。
 *
 * 两件事必须同时发生，否则账实会分叉：
 *   ① **货回门店仓**（`sales_returns` + 门店仓入库）。入库成本取该 SKU 在门店仓的
 *      当前成本 —— 不是售价。用售价当退货成本会让门店库存金额虚增一整块毛利，
 *      而这笔虚增会一路带进库存报表，看起来"门店赚钱了"。
 *   ② **钱退出去**。退款写一条**负数 `pos_orders`**，自动冲减该班次的系统应收
 *      （`computeShiftSystem` 对负额是天生的净额），因此退款会自然地进入长短款口径，
 *      不需要在核款时手工减一遍 —— 手工减一次就少一次对不上的机会。
 *
 * 退款必须挂在**当前营业班次**上；没有营业班次时不允许退货（否则这笔退款
 * 不属于任何班次，长短款里表现为「系统应收凭空少一笔」）。
 */
export function storeReturn(db, req, { storeId, shiftId, items = [], reason = null, returnDate = null, refundMethod = CASH_METHOD, orderId = null }) {
  const shift = loadShift(db, shiftId)
  if (shift.status !== 'open') throw bad(`班次 ${shift.doc_no} 当前状态为「${shift.status}」，只有营业中的班次可以办理退货`, 'SHIFT_NOT_OPEN', 409)
  if (Number(shift.store_id) !== Number(storeId)) throw bad('班次不属于本门店', 'SHIFT_STORE_MISMATCH', 400)
  if (!Array.isArray(items) || !items.length) throw bad('请添加退货明细', 'NO_ITEMS', 400)
  if (!PAY_METHODS.includes(refundMethod)) throw bad(`退款方式无效：${refundMethod}`, 'PAY_METHOD_INVALID', 400)

  const wh = storeWarehouse(db, storeId)
  if (!wh) throw bad('该门店未绑定门店仓库，无法办理退货', 'NO_STORE_WAREHOUSE', 400)

  const date = String(returnDate || '').trim() || localDate()

  // A09b：**关联了订单就必须走同一份退货计划**（退量上限 + 成本追溯）。
  // 门店退货与销售退货是"同一个动作的两个入口"——上限只写在其中一个入口上，等于没写。
  // 计划算在事务外只是为了早点拿到错误（它是纯计算 + 只读校验，不写库）。
  let plan = null
  if (orderId) {
    try {
      plan = planReturn(db, { orderId, sourceType: 'order', items, warehouseId: wh.id })
    } catch (e) {
      if (e instanceof ReturnError) throw bad(e.message, e.code, e.status)
      throw e
    }
  }

  const skuCache = new Map()
  const skuOf = (id) => {
    if (!skuCache.has(Number(id))) {
      skuCache.set(
        Number(id),
        db
          .prepare('SELECT s.*, p.name AS product_name FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
          .get(Number(id))
      )
    }
    return skuCache.get(Number(id))
  }

  const result = db.transaction(() => {
    const docNo = nextDocNo(db, 'SRT', 'sales_returns', 'doc_no', date)
    const info = db
      .prepare(
        `INSERT INTO sales_returns (doc_no,order_id,source_type,channel,dealer_id,store_id,warehouse_id,return_date,reason,status,total_qty,total_amount,created_by)
         VALUES (?,?,?,'store',NULL,?,?,?,?,'confirmed',0,0,?)`
      )
      .run(
        docNo,
        orderId || null,
        orderId ? 'order' : 'walkin',
        Number(storeId),
        wh.id,
        date,
        reason || '门店退货',
        req?.user?.uid ?? null
      )
    const retId = Number(info.lastInsertRowid)
    const insItem = db.prepare(
      'INSERT INTO sales_return_items (return_id,order_item_id,sku_id,batch_no,qty,price,amount) VALUES (?,?,?,?,?,?,?)'
    )
    const refundItems = []
    let qtySum = 0
    let amountSum = 0

    // 有单退货 → 用计划里的行（含来源行 / 原出库批次 / 追溯成本）
    // 无单退货 → 按请求行现算，成本取门店仓当前成本（**不用售价**，理由见函数头）
    const rows = plan
      ? plan.lines
      : items.map((it) => {
          const qty = num(it.qty)
          if (qty <= 0) throw bad('退货数量必须大于 0', 'QTY_INVALID', 400)
          const sku = skuOf(it.sku_id)
          if (!sku) throw bad(`SKU#${it.sku_id} 不存在`, 'SKU_NOT_FOUND', 404)
          const price = round2(it.price !== undefined ? it.price : sku.price_retail)
          if (price < 0) throw bad('退款单价不能为负', 'PRICE_INVALID', 400)
          const costRow = db
            .prepare(
              'SELECT COALESCE(SUM(cost_amount),0) a, COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?'
            )
            .get(wh.id, sku.id)
          const unitCost = num(costRow.q) > 0 ? round2(num(costRow.a) / num(costRow.q)) : round2(sku.cost_std)
          return {
            order_item_id: null,
            sku_id: sku.id,
            batch_no: it.batch_no || '',
            qty: round2(qty),
            price,
            amount: round2(qty * price),
            unit_cost: unitCost,
            cost_source: 'current'
          }
        })

    for (const l of rows) {
      const sku = skuOf(l.sku_id)
      insItem.run(retId, l.order_item_id ?? null, l.sku_id, l.batch_no || '', l.qty, l.price, l.amount)
      applyStockIn(db, {
        bizDate: date,
        docType: 'SAL_RET',
        docNo,
        docId: retId,
        warehouseId: wh.id,
        skuId: l.sku_id,
        batchNo: l.batch_no || '',
        qty: l.qty,
        // 成本来自计划（追溯原出库）或门店仓当前成本 —— **从来不来自请求体**
        unitCost: l.unit_cost,
        operator: req?.user?.name || null,
        remark: `门店退货入库 ${docNo}`
      })
      refundItems.push({ sku_id: l.sku_id, sku, qty: l.qty, price: l.price, amount: l.amount })
      qtySum += l.qty
      amountSum += l.amount
    }
    db.prepare('UPDATE sales_returns SET total_qty=?, total_amount=? WHERE id=?').run(qtySum, round2(amountSum), retId)

    // 退款登记：一条负数 POS 单，自然冲减本班次系统应收
    const refundDocNo = nextDocNo(db, 'POS', 'pos_orders', 'doc_no', date)
    const rfInfo = db
      .prepare(
        `INSERT INTO pos_orders (doc_no,store_id,warehouse_id,cashier_id,cashier_name,biz_date,member_phone,
                                  total_qty,total_amount,discount_amount,pay_amount,pay_method,status,shift_id,remark)
         VALUES (?,?,?,?,?,?,NULL,?,?,0,?,?,'local',?,?)`
      )
      .run(
        refundDocNo, Number(storeId), wh.id, shift.cashier_id ?? null, shift.cashier_name ?? null, date,
        -qtySum, -round2(amountSum), -round2(amountSum), refundMethod, shift.id, `门店退货退款 ${docNo}`
      )
    const refundOrderId = Number(rfInfo.lastInsertRowid)
    const insRf = db.prepare(
      'INSERT INTO pos_order_items (pos_order_id,sku_id,sku_code,sku_name,price,qty,amount) VALUES (?,?,?,?,?,?,?)'
    )
    for (const r of refundItems) {
      insRf.run(refundOrderId, r.sku_id, r.sku.sku_code, `${r.sku.product_name} ${r.sku.name}`, r.price, -r.qty, -r.amount)
    }

    // 建单留痕（铁律：留痕须与改动同生共死、写在改动旁边 —— 整段在**同一个事务**里）。
    //
    // 门店退货建出来的 SR 单**建出来就是 `confirmed`**（同一事务里已把货回门店仓、
    // 并生成了那张负数 POS 单），所以没有一次 `SR.confirm`（draft→confirmed）的流转可记：
    // 记 `create` 而不是 `confirm`（后者是内核里那条**边**的动作码，本单从没处于 draft，
    // 冒用等于伪造一次没发生过的流转）；`from_state` 留空、`to_state='confirmed'`。
    // 与 `lib/returns.js`（有单退货）那处是**同一口径、同一形状** —— 两条建单入口必须都留痕，
    // 只补一处就是"列表挡得住、详情挡不住"那种半拉子。
    //
    // 放在这一段（而不是紧跟 SR 的 INSERT）是为了把**两个对账锚点**都带上：
    //   ① 退货入库流水（`doc_type='SAL_RET'`、`doc_no` = 本退货单号）
    //   ② 同时生成的那张负数 POS 单（`refundDocNo`）—— 它到上面这一行才写完。
    logEvent({
      db,
      docType: 'SR',
      id: retId,
      docNo,
      action: 'create',
      actionName: '建单',
      to: 'confirmed',
      actor: { id: req?.user?.uid ?? null, name: req?.user?.name || req?.user?.username || null },
      source: 'api',
      remark: orderId ? `门店退货建单（有单退货，来源订单 #${orderId}）` : '门店退货建单（无单退货）',
      payload: {
        created_via: 'pos_store_return',
        source_type: orderId ? 'order' : 'walkin',
        order_id: orderId || null,
        store_id: Number(storeId),
        warehouse_id: wh.id,
        qty: qtySum,
        amount: round2(amountSum),
        reason: reason || '门店退货',
        return_date: date,
        shift_id: shift?.id ?? null,
        inventory_doc_type: 'SAL_RET',
        inventory_doc_no: docNo,
        pos_refund_order_id: refundOrderId,
        pos_refund_order_no: refundDocNo
      }
    })
    return { returnId: retId, docNo, refundOrderId, refundDocNo, qty: qtySum, amount: round2(amountSum) }
  })()

  return result
}

// ---------------------------------------------------------------------------
// 十、门店盘点（复用 stock_checks，只改范围与权限）
// ---------------------------------------------------------------------------

/**
 * 建门店盘点单。
 *
 * 复用 `stock_checks` 而不是另建一张表：门店盘点是**同一个动作、不同的范围与权限**。
 * 另建一张表意味着"盘点明细"的结构要维护两套，迟早分叉 ——
 * 而分叉的表现是「总部盘出来的差异和门店盘出来的对不上」，很难解释。
 */
export function createStoreCheck(db, req, { storeId, skuIds = null, checker = null, remark = null, checkDate = null }) {
  const wh = storeWarehouse(db, storeId)
  if (!wh) throw bad('该门店未绑定门店仓库，无法盘点', 'NO_STORE_WAREHOUSE', 400)
  let stocks = db
    .prepare('SELECT sku_id, batch_no, qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND qty_on_hand <> 0')
    .all(wh.id)
  if (Array.isArray(skuIds) && skuIds.length) {
    const set = new Set(skuIds.map(Number))
    stocks = stocks.filter((s) => set.has(Number(s.sku_id)))
  }
  if (!stocks.length) throw bad('该门店仓没有可盘点的库存', 'NO_STOCK', 400)
  const date = String(checkDate || '').trim() || localDate()

  const cid = db.transaction(() => {
    const docNo = nextDocNo(db, 'SC', 'stock_checks', 'doc_no', date)
    const info = db
      .prepare(
        `INSERT INTO stock_checks (doc_no,warehouse_id,check_date,status,checker,remark,created_by,scope,store_id)
         VALUES (?,?,?,'draft',?,?,?,'store',?)`
      )
      .run(docNo, wh.id, date, checker || req?.user?.name || null, remark || '门店盘点', req?.user?.uid ?? null, Number(storeId))
    const id = Number(info.lastInsertRowid)
    const ins = db.prepare('INSERT INTO stock_check_items (check_id,sku_id,batch_no,book_qty,actual_qty,diff_qty) VALUES (?,?,?,?,?,0)')
    for (const s of stocks) ins.run(id, s.sku_id, s.batch_no || '', s.qty_on_hand, s.qty_on_hand)
    return id
  })()
  return { id: cid }
}

/** 录入实盘数量并转「盘点中」（与总部盘点同一套内核动作） */
export function submitStoreCheckItems(db, req, { checkId, items = [] }) {
  const head = loadStoreCheck(db, checkId)
  if (head.status === 'adjusted') throw bad('已调整的盘点单不能修改', 'CHECK_ADJUSTED', 409)
  db.transaction(() => {
    for (const it of items) {
      const id = Number(it.id)
      // **账面数一律从库里取，不信客户端传来的 book_qty**。
      // 信它的后果不是"算错一次"：客户端只要把 book_qty 报成 actual_qty，
      // 差异就恒为 0 —— 盘点单上看不出任何异常，货却已经对不上了。
      const row = db.prepare('SELECT book_qty FROM stock_check_items WHERE id=? AND check_id=?').get(id, head.id)
      if (!row) continue
      const actual = num(it.actual_qty)
      db.prepare('UPDATE stock_check_items SET actual_qty=?, diff_qty=?, reason=? WHERE id=? AND check_id=?').run(
        actual,
        round2(actual - num(row.book_qty)),
        it.reason || null,
        id,
        head.id
      )
    }
    const diff = db.prepare('SELECT COALESCE(SUM(diff_qty),0) d FROM stock_check_items WHERE check_id=?').get(head.id).d
    advanceStatus(db, req, { docType: 'CK', id: head.id, action: 'start', set: { total_diff_qty: round2(diff) }, remark: '门店录入实盘数量' })
  })()
  return { id: head.id }
}

/** 门店盘点差异过账（盘盈入库 / 盘亏出库），只允许落在门店仓 */
export function adjustStoreCheck(db, req, { checkId }) {
  const head = loadStoreCheck(db, checkId)
  if (head.status === 'adjusted') throw bad('该盘点单已经调整过', 'CHECK_ADJUSTED', 409)
  const items = db.prepare('SELECT * FROM stock_check_items WHERE check_id=?').all(head.id)
  const u = req?.user?.name || null
  db.transaction(() => {
    for (const it of items) {
      if (isZero(it.diff_qty)) continue
      if (num(it.diff_qty) > 0) {
        applyStockGain(db, {
          bizDate: head.check_date, docType: 'ADJ_IN', docNo: head.doc_no, docId: head.id,
          warehouseId: head.warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: num(it.diff_qty),
          operator: u, remark: `门店盘盈 ${it.reason || ''}`
        })
      } else {
        applyStockOut(db, {
          bizDate: head.check_date, docType: 'ADJ_OUT', docNo: head.doc_no, docId: head.id,
          warehouseId: head.warehouse_id, skuId: it.sku_id, batchNo: it.batch_no, qty: Math.abs(num(it.diff_qty)),
          operator: u, remark: `门店盘亏 ${it.reason || ''}`
        })
      }
    }
    advanceStatus(db, req, { docType: 'CK', id: head.id, action: 'adjust', remark: '门店盘点差异入账' })
  })()
  return { id: head.id }
}

function loadStoreCheck(db, checkId) {
  const head = db.prepare('SELECT * FROM stock_checks WHERE id=?').get(Number(checkId))
  if (!head) throw bad(`盘点单 #${checkId} 不存在`, 'CHECK_NOT_FOUND', 404)
  if ((head.scope || 'hq') !== 'store') throw bad('该盘点单不是门店盘点单', 'NOT_STORE_CHECK', 400)
  return head
}

export default {
  PAY_METHODS,
  PAY_METHOD_LABEL,
  CASH_METHOD,
  VARIANCE_EPS,
  HANDLE_TYPES,
  DROP_STATUS,
  getVarianceLimit,
  computeShiftSystem,
  cashInflight,
  openShift,
  declareShift,
  rejectShift,
  approveShift,
  settleVariance,
  cancelShift,
  attachLegacyShiftNo,
  createCashDrop,
  receiveCashDrop,
  cancelCashDrop,
  dailyCloseGate,
  computeDailyCash,
  posQuote,
  createPosOrder,
  voidPosOrder,
  dailyClose,
  shiftDetail,
  listShifts,
  storeReturn,
  createStoreCheck,
  submitStoreCheckItems,
  adjustStoreCheck
}
