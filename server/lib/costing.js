/**
 * ============================================================================
 * 文件标识：server/lib/costing.js ｜ 存货核算与成本服务层（模块 09）
 * ============================================================================
 * 【职责】存货核算与成本服务层（模块 09）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 存货核算与成本服务层（模块 09）
//
// 成本层此前只有「实时结存」这一层：stock.js 做移动加权（入库加权、出库按均价、
// 结存金额可回溯），采购域把暂估差异算出来落进 purchase_settlements.diff_amount。
// 但**差异只是被记下来，没人把它回写到存货成本** ——
// 「发票来了、实际价高 8%」这件事在库存金额上完全看不出来。
//
// 本模块补三件事，对应三条硬口径：
//
//   ① **三层成本要能闭合**：期初 + 本期入库 − 本期出库 = 期末（数量与金额都要对得上）。
//      为什么非要引入「期间」：不划期间就只能算「截止今天的累计」，而累计数**永远闭合** ——
//      误差会被下一笔在途或补单一直吃掉，看上去从来没有问题。划了期间，误差无处可藏。
//
//   ② **结转要有约束力**：期间一旦结转，就不允许再往里写流水（错误码 PERIOD_CLOSED）。
//      否则「结转」只是一张随时会被后续单据推翻的快照，等于没结。
//      这条约束在 stock.js 的出入库入口执行 —— 闸门放在入口，而不是靠事后对账。
//
//   ③ **暂估差异必须回写，且不能追溯已售出部分**：只调「仍在该批次库存里的数量」，
//      已出库那部分单列 sold_amount 计入本期损益。
//      理由与模块 07「宁可少算，绝不重复算」同源：已售出部分对应的收入已按旧成本算过毛利，
//      追溯会让历史毛利变化，而且无法可靠分摊到客户。
//
// 一处**已知边界**（写清楚比含糊过去好）：
//   本模块只做「成本算得出 + 差异回写 + 期末可结」，**不生成会计凭证**
//   （与口径确认第一轮的定案一致：成本按移动加权 + 毛利可查，不做凭证）。
//   所以 cost_adjustments 是**成本单据**，不是记账凭证；它没有借贷方向与科目。
//
// 另一处边界：批次级库存行本身带自己的 cost_price，所以「分批实际成本」是可以表达的
//   （由 pickBatches 按 fifo/fefo 选中批次、出库取该批次成本）。但**同一批次内**
//   仍然是移动加权（批次内多次入库会加权）。这不是缺陷，是口径：本系统的成本颗粒度
//   是「仓库 × SKU × 批次」，批次内再分层需要引入成本层表，属下一步。

import { applyTransition, DocFlowError } from './docflow.js'
import { localDate, localNow } from './dates.js'

const nowStr = () => localNow()
// 业务日一律本地口径（dates.js）。这里尤其要紧：存货核算是**按期间闸门**判定的，
// 「今天」若按 UTC 算，东八区凌晨开的调整单会落到上一个期间，跨月时直接算错期间。
const ymd = (d = new Date()) => localDate(d)
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const round4 = (n) => Math.round((Number(n) || 0) * 10000) / 10000
const num = (v) => Number(v) || 0

/** 金额容差：分位级。低于这个数不报错（四舍五入必然产生分位残差） */
export const AMOUNT_TOL = 0.05

export class CostError extends Error {
  constructor(message, { code = 'COST_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'CostError'
    this.code = code
    // 全局错误中间件读的是 err.status，不赋值会被当成 500 —— 与 DocFlowError / QCError 同一约定
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 一、计价方式：支持集合由代码声明，不支持的显式拒绝
// ---------------------------------------------------------------------------

export const COST_METHODS = {
  moving_avg: '移动加权平均',
  batch_actual: '分批实际成本'
}

/**
 * 取当前库的计价方式，并**校验它在支持集合里**。
 *
 * 为什么不能像以前那样 `getInvParam(db,'cost_method','moving_avg')` 直接拿来用：
 * 那样等于「库里写什么就按什么算」，而算法只有一种 ——
 * 一旦有人把参数改成 `fifo`，出库仍然按移动加权算，报表上却写着先进先出。
 * 这种错不会报错，只会让所有成本报表的口径变成假的。
 */
export function costMethod(db) {
  const row = db
    .prepare("SELECT param_value FROM inv_params WHERE param_key='cost_method' LIMIT 1")
    .get()
  const v = row?.param_value || 'moving_avg'
  if (!COST_METHODS[v]) {
    throw new CostError(
      `不支持的计价方式「${v}」：本系统只实现了 ${Object.keys(COST_METHODS).join(' / ')}。` +
        `继续按移动加权算会让成本报表的口径变成假的，所以这里直接拒绝。`,
      { code: 'COST_METHOD_UNSUPPORTED', httpStatus: 409, detail: { value: v, supported: Object.keys(COST_METHODS) } }
    )
  }
  return v
}

// ---------------------------------------------------------------------------
// 二、期间
// ---------------------------------------------------------------------------

/** 日期 → 期间号（YYYY-MM）。接受 Date / 'YYYY-MM-DD' / 'YYYY-MM-DD HH:mm:ss' / 'YYYY-MM' */
export function periodOf(date) {
  if (!date) return ymd(new Date()).slice(0, 7)
  // Date 对象必须先转成 YYYY-MM-DD：直接 String(date) 得到的是
  // 「Thu Oct 15 2026 ...」，slice(0,7) 就成了「Thu Oct」——
  // 一个一眼看不出错、但会一路传到 SQL 里变成空结果的期间号。
  const s = date instanceof Date ? ymd(date) : String(date).trim()
  if (/^\d{4}-\d{2}$/.test(s)) return s
  const m = /^(\d{4})-(\d{2})/.exec(s)
  if (!m) {
    throw new CostError(`无法从「${s}」解析出会计期间（应形如 2026-10 或 2026-10-15）`, {
      code: 'COST_PERIOD_INVALID'
    })
  }
  return `${m[1]}-${m[2]}`
}

/** 期间起止 */
export function periodRange(period) {
  const [y, m] = String(period).split('-').map(Number)
  if (!y || !m || m < 1 || m > 12) {
    throw new CostError(`期间格式应为 YYYY-MM，收到「${period}」`, { code: 'COST_PERIOD_INVALID' })
  }
  const last = new Date(Date.UTC(y, m, 0))
  return { start: `${period}-01`, end: `${period}-${String(last.getUTCDate()).padStart(2, '0')}` }
}

/** 取期间记录；不存在则按需创建（open） */
export function ensurePeriod(db, period, { create = true } = {}) {
  const found = db.prepare('SELECT * FROM cost_periods WHERE period=?').get(period)
  if (found) return found
  if (!create) return null
  const { start, end } = periodRange(period)
  db.prepare(
    `INSERT INTO cost_periods (period, start_date, end_date, status) VALUES (?,?,?,'open')`
  ).run(period, start, end)
  return db.prepare('SELECT * FROM cost_periods WHERE period=?').get(period)
}

/** 期间是否已结转 */
export function isPeriodClosed(db, period) {
  const row = db.prepare("SELECT status FROM cost_periods WHERE period=?").get(period)
  return row?.status === 'closed'
}

/**
 * 出入库闸门：禁止往已结转期间补流水。
 *
 * 这是「结转有约束力」的唯一实现点，必须是**硬拦**：
 * 允许补单会让上一期已经结出来的期末金额与今天算出来的不一致，
 * 而两张报表都能打开、都像是对的 —— 这类不一致在演示现场是没法解释的。
 *
 * 由 stock.js 在 applyStockIn / applyStockOut 开头调用（放在入口，不靠事后对账）。
 */
export function assertPeriodOpen(db, bizDate) {
  const period = periodOf(bizDate)
  const row = db.prepare('SELECT status, closed_at FROM cost_periods WHERE period=?').get(period)
  if (row?.status === 'closed') {
    throw new CostError(
      `成本期间 ${period} 已结转（${row.closed_at || ''}），不能再往这个期间补单据。` +
        `要纠正请开一张归属当前期间的成本调整单 —— 让差异留在它真正被发现的期间。`,
      { code: 'PERIOD_CLOSED', httpStatus: 409, detail: { period } }
    )
  }
}

/** 期间是否已经走完（期末日 < 今天）。没走完的期间不能结转 —— 见 closePeriod */
export function periodFinished(period, today = null) {
  const { end } = periodRange(period)
  const t = today ? ymd(today) : ymd(new Date())
  return end < t
}

export function listPeriods(db, { limit = 36 } = {}) {
  return db
    .prepare('SELECT * FROM cost_periods ORDER BY period DESC LIMIT ?')
    .all(limit)
}

// ---------------------------------------------------------------------------
// 三、三层成本：期初 / 本期入 / 本期出 / 期末
// ---------------------------------------------------------------------------

/**
 * 按维度（仓库 / SKU / 批次 / 货主 / 币种）算三层成本。
 *
 * 口径（这三段是本模块最要紧的一段注释）：
 *
 *   期初  = 上一期结转时落下的快照；本期之前没有已结转期间时，
 *          取「本期起始日之前的流水累计 + 期初之前的成本调整」倒推（并在 opening_source 里写明来源）。
 *   本期入/出 = direction='in'/'out' 在本期间内的合计。
 *   本期调整（adj）= stock_cost_ledger 里 direction='adj' 的行（amount_after − amount_before）
 *          在本期间内的合计 —— 成本调整单确认后只改金额不改数量，**不写 inventory_transactions**；
 *          不把它算进来，任何一次真实的调整都会让现存量比「截至期末 + 之后流水」多出回写金额，
 *          残差从此永远不归零、结转被禁用（实测就是这么发现的）。
 *   截至期末（as_of_end）= 期初 + 入 − 出 + 调整。这是「那一天关账时账上应该有多少」。
 *   期末之后（later）  = 期末日之后的流水净额 + 期末之后的调整。
 *   现存量（closing）  = inventory_stocks 里此刻的数量金额 —— **它是「今天」的，不是「期末」的**。
 *
 * 为什么要区分 as_of_end 与 closing：两者本来就该不一样。
 *   实测服装库有 2 笔日期为 2026-11-03 的入库单，净 29 件 / 22,980.80 ——
 *   现存量比 10 月期末多出的正是这笔「下月的货」。
 *   如果不把它归因出来，它就会变成一个没人解释得清的残差（最初就是这么发现的）；
 *   而把它归因出来之后，残差恒为 0，**非 0 才是真有账实不符**。
 *
 * 所以最终的残差恒等式是：现存量 − (截至期末 + 期末之后的流水) = 0。
 */
export function threeLayers(db, q = {}) {
  const { period = periodOf(new Date()), warehouseId = null, skuId = null, batchNo = null,
    ownerOrgId = null, currency = null } = q
  const { start, end } = periodRange(period)

  const dim = (alias) => {
    const w = []
    const a = []
    if (warehouseId) { w.push(`${alias}.warehouse_id = ?`); a.push(warehouseId) }
    if (skuId) { w.push(`${alias}.sku_id = ?`); a.push(skuId) }
    if (batchNo != null && batchNo !== '') { w.push(`${alias}.batch_no = ?`); a.push(batchNo) }
    if (ownerOrgId) { w.push(`${alias}.owner_org_id = ?`); a.push(ownerOrgId) }
    if (currency) { w.push(`${alias}.currency = ?`); a.push(currency) }
    return { sql: w.length ? ' AND ' + w.join(' AND ') : '', args: a }
  }
  const dT = dim('t')
  const dS = dim('s')
  const dB = dim('b')

  const one = (sql, args) => db.prepare(sql).get(...args) || {}

  /** 流水在某段日期区间的净额与分方向合计 */
  const flowBetween = (fromOp, date, alias = 't') =>
    one(
      `SELECT
         COALESCE(SUM(CASE WHEN ${alias}.direction='in'  THEN ${alias}.qty    ELSE 0 END),0) in_qty,
         COALESCE(SUM(CASE WHEN ${alias}.direction='in'  THEN ${alias}.amount ELSE 0 END),0) in_amount,
         COALESCE(SUM(CASE WHEN ${alias}.direction='out' THEN ${alias}.qty    ELSE 0 END),0) out_qty,
         COALESCE(SUM(CASE WHEN ${alias}.direction='out' THEN ${alias}.amount ELSE 0 END),0) out_amount,
         COUNT(*) line_count
       FROM inventory_transactions ${alias}
       WHERE ${alias}.biz_date ${fromOp} ? ${dim(alias).sql}`,
      [date, ...dim(alias).args]
    )

  /**
   * 成本调整在某段日期区间的净额。调整走 stock_cost_ledger（direction='adj'）而不写
   * inventory_transactions —— 它只改金额不动数量。签名与 flowBetween 对齐，
   * 三处（期初倒推 / 本期 / 期末之后）都由它提供「调整维度」的那一段。
   */
  const adjBetween = (fromOp, date, toOp = null, toDate = null) => {
    const dL = dim('l')
    const w = [`l.biz_date ${fromOp} ?`]
    const a = [date]
    if (toOp) { w.push(`l.biz_date ${toOp} ?`); a.push(toDate) }
    return one(
      `SELECT COALESCE(SUM(l.amount_after - l.amount_before),0) adj_amount,
              COUNT(*) line_count
         FROM stock_cost_ledger l
        WHERE l.direction='adj' AND ${w.join(' AND ')}${dL.sql}`,
      [...a, ...dL.args]
    )
  }

  // 本期入 / 出：BIZ_DATE BETWEEN start AND end
  const inPeriod = one(
    `SELECT
       COALESCE(SUM(CASE WHEN t.direction='in'  THEN t.qty    ELSE 0 END),0) in_qty,
       COALESCE(SUM(CASE WHEN t.direction='in'  THEN t.amount ELSE 0 END),0) in_amount,
       COALESCE(SUM(CASE WHEN t.direction='out' THEN t.qty    ELSE 0 END),0) out_qty,
       COALESCE(SUM(CASE WHEN t.direction='out' THEN t.amount ELSE 0 END),0) out_amount,
       COUNT(*) line_count
     FROM inventory_transactions t
     WHERE t.biz_date >= ? AND t.biz_date <= ? ${dT.sql}`,
    [start, end, ...dT.args]
  )
  // 期末之后的流水：**必须单独归因**，否则残差说不清
  const afterPeriod = one(
    `SELECT
       COALESCE(SUM(CASE WHEN t.direction='in'  THEN t.qty    ELSE 0 END),0) in_qty,
       COALESCE(SUM(CASE WHEN t.direction='out' THEN t.qty    ELSE 0 END),0) out_qty,
       COALESCE(SUM(CASE WHEN t.direction='in'  THEN t.amount ELSE 0 END),0) in_amount,
       COALESCE(SUM(CASE WHEN t.direction='out' THEN t.amount ELSE 0 END),0) out_amount,
       COUNT(*) line_count
     FROM inventory_transactions t
     WHERE t.biz_date > ? ${dT.sql}`,
    [end, ...dT.args]
  )
  // 本期 / 期末之后的成本调整（只改金额，不改数量）
  const adjInPeriod = adjBetween('>=', start, '<=', end)
  const adjAfter = adjBetween('>', end)

  // 期末（现存量）
  const closing = one(
    `SELECT COALESCE(SUM(s.qty_on_hand),0) qty,
            COALESCE(SUM(COALESCE(s.cost_amount, s.qty_on_hand * COALESCE(s.cost_price,0))),0) amount,
            COUNT(*) line_count
     FROM inventory_stocks s
     WHERE s.qty_on_hand <> 0 ${dS.sql}`,
    dS.args
  )

  // 期初：优先取上期快照；没有则用「期初之前的流水累计」倒推
  const prev = db
    .prepare("SELECT period FROM cost_periods WHERE status='closed' AND period < ? ORDER BY period DESC LIMIT 1")
    .get(period)
  let opening
  let openingSource
  if (prev) {
    opening = one(
      `SELECT COALESCE(SUM(b.qty),0) qty, COALESCE(SUM(b.amount),0) amount, COUNT(*) line_count
         FROM cost_period_balances b WHERE b.period = ? ${dB.sql}`,
      [prev.period, ...dB.args]
    )
    openingSource = `上期结转快照 ${prev.period}`
  } else {
    const before = flowBetween('<', start)
    const adjBefore = adjBetween('<', start)
    opening = {
      qty: num(before.in_qty) - num(before.out_qty),
      amount: round2(num(before.in_amount) - num(before.out_amount) + num(adjBefore.adj_amount)),
      line_count: 0
    }
    openingSource = '按本期起始日之前的流水累计倒推（本期之前没有已结转期间）'
  }

  // **数量用 4 位小数、金额用 2 位（分）** —— 这条不对称是有意为之，也必须守住：
  //   金额的最小单位是分，多留小数只是噪声；而本系统的**数量不是整数** ——
  //   BOM 展开（用量 × 损耗 × 数量 ÷ 基准批量）、生产领料（kg 级）、完工入库
  //   都会产生 4 位小数的量。用 2 位小数收敛数量，等于把「期末之后净额」
  //   砍掉末尾两位后去和原始流水比 —— 恒等式会出现 0.00x 的残差，
  //   而残差恒等于 0 正是本模块唯一的账实自证手段（残差非 0 才有账实不符）。
  //   实测：批次 D 引入带小数的领料/完工流水后，这一条立刻在三库同时挂掉。
  const oQty = round4(num(opening.qty))
  const oAmt = round2(num(opening.amount))
  const iQty = round4(num(inPeriod.in_qty))
  const iAmt = round2(num(inPeriod.in_amount))
  const uQty = round4(num(inPeriod.out_qty))
  const uAmt = round2(num(inPeriod.out_amount))
  const aAmt = round2(num(adjInPeriod.adj_amount))
  const lQty = round4(num(afterPeriod.in_qty) - num(afterPeriod.out_qty))
  // 期末之后的金额 = 流水净额 + 期末之后的调整净额
  const lAmt = round2(num(afterPeriod.in_amount) - num(afterPeriod.out_amount) + num(adjAfter.adj_amount))
  // 截至期末 = 期初 + 本期入 − 本期出 + 本期调整（调整不动数量，数量恒等式不变）
  const eQty = round4(oQty + iQty - uQty)
  const eAmt = round2(oAmt + iAmt - uAmt + aAmt)
  const cQty = round4(num(closing.qty))
  const cAmt = round2(num(closing.amount))

  const layerRow = (qty, amount) => ({
    qty, amount, unit_cost: qty ? round4(amount / qty) : 0
  })

  return {
    period,
    range: { start, end },
    finished: periodFinished(period),
    opening_source: openingSource,
    cost_method: costMethodSafe(db),
    opening: layerRow(oQty, oAmt),
    in: { ...layerRow(iQty, iAmt), line_count: num(inPeriod.line_count) },
    out: layerRow(uQty, uAmt),
    /** 本期成本调整净额（只改金额）：暂估差异回写等。不进这一层，调整一旦生效残差就永不归零 */
    adj: { qty: 0, amount: aAmt, line_count: num(adjInPeriod.line_count) },
    as_of_end: layerRow(eQty, eAmt),
    later: { ...layerRow(lQty, lAmt), line_count: num(afterPeriod.line_count) + num(adjAfter.line_count) },
    closing: { ...layerRow(cQty, cAmt), line_count: num(closing.line_count) },
    closing_line_count: num(closing.line_count),
    // 残差 = 现存量 − (截至期末 + 期末之后的流水)。归因正确时恒为 0；非 0 才有账实不符。
    residual: {
      qty: round4(cQty - (eQty + lQty)),
      amount: round2(cAmt - (eAmt + lAmt))
    },
    balanced: Math.abs(cQty - (eQty + lQty)) < 1e-6 && Math.abs(cAmt - (eAmt + lAmt)) <= AMOUNT_TOL
  }
}

/** 计价方式取值，但**不抛错**（给报表用：算不出来也要能显示页面） */
function costMethodSafe(db) {
  try {
    return costMethod(db)
  } catch (e) {
    return { error: e.message, code: e.code }
  }
}

// ---------------------------------------------------------------------------
// 四、期末结转
// ---------------------------------------------------------------------------

/**
 * 期末结转：算三层 → 落期末快照（作为下期期初）→ 标记期间 closed。
 *
 * 三条约束，每条都有它挡住的真实问题：
 *
 *   ① **没走完的期间不能结**。本期还没结束就关账，等于用一个中途的数字宣布期末 ——
 *      后面每天的入库出库都会让这个「期末」看起来是错的。所以只允许结 end_date < 今天的期间。
 *
 *   ② **期末快照取「截至期末日的流水累计」，不是抄今天的 inventory_stocks**。
 *      两者差的是「期末之后发生的流水」。抄现存量会把下月的货算进本月期末，
 *      下期期初跟着虚增 —— 而这类错只会表现为「两个月的数加起来对不上」。
 *
 *   ③ **不重复结转**（除非 reopen）。重结会让同一期间出现两份不同的期末数字，
 *      两份都能打开、都像是对的。reopen 会先删掉该期快照，让重算结果覆盖它。
 */
export function closePeriod(db, { period, actor = {}, reopen = false, remark = null, today = null } = {}) {
  const p = period || periodOf(new Date())
  const tx = db.transaction(() => {
    const row = ensurePeriod(db, p)
    if (!periodFinished(p, today)) {
      const { end } = periodRange(p)
      throw new CostError(
        `期间 ${p} 还没走完（期末日 ${end} 尚未到），不能结转。` +
          `本期还没结束就关账，等于用一个中途的数字宣布期末 —— ` +
          `后面每一天的出入库都会让这个「期末」看起来是错的。`,
        { code: 'PERIOD_NOT_FINISHED', httpStatus: 409, detail: { period: p, end } }
      )
    }
    if (row.status === 'closed' && !reopen) {
      throw new CostError(
        `期间 ${p} 已于 ${row.closed_at || ''} 结转，不能重复结转。` +
          `重结会让同一期间出现两份不同的期末数字，两份都能打开、都像是对的。` +
          `确需重算请显式传 reopen（会先删掉该期快照）。`,
        { code: 'PERIOD_ALREADY_CLOSED', httpStatus: 409, detail: { period: p } }
      )
    }
    if (reopen && row.status === 'closed') {
      db.prepare('DELETE FROM cost_period_balances WHERE period=?').run(p)
    }

    const layers = threeLayers(db, { period: p })
    const { end } = layers.range

    // 期末快照：逐维度取「截至期末日的流水累计（净额）+ 截至期末日的成本调整净额」。
    // 用流水累计而不是现存量，是为了让快照与「期初+入−出+调整」同源 ——
    // 同源才能保证下期期初与本期的期末是同一个数。调整净额来自 stock_cost_ledger
    // 的 adj 行（调整不写 inventory_transactions，缺了它快照会比三层少一块回写金额）。
    const rows = db
      .prepare(
        `SELECT t.warehouse_id, t.owner_org_id, t.currency, t.sku_id, COALESCE(t.batch_no,'') batch_no,
                SUM(CASE WHEN t.direction='in' THEN t.qty ELSE -t.qty END) qty,
                SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END) amount
           FROM inventory_transactions t
          WHERE t.biz_date <= ?
          GROUP BY t.warehouse_id, t.owner_org_id, t.currency, t.sku_id, COALESCE(t.batch_no,'')
         HAVING ABS(SUM(CASE WHEN t.direction='in' THEN t.qty ELSE -t.qty END)) > 1e-9`
      )
      .all(end)
    const adjRows = db
      .prepare(
        `SELECT l.warehouse_id, l.owner_org_id, l.currency, l.sku_id, COALESCE(l.batch_no,'') batch_no,
                SUM(l.amount_after - l.amount_before) adj
           FROM stock_cost_ledger l
          WHERE l.direction='adj' AND l.biz_date <= ?
          GROUP BY l.warehouse_id, l.owner_org_id, l.currency, l.sku_id, COALESCE(l.batch_no,'')`
      )
      .all(end)
    // 调整净额按「同维度」并回流水组。数量已全部消耗的批次不进流水组（HAVING 拦掉），
    // 它的调整金额也一并不进快照 —— 那批货已经不在账上，带着金额反而是错；
    // 若真出现口径裂缝，下面对快照与三层的同源校验会直接结账失败，不会静默。
    const adjMap = new Map(adjRows.map((x) => [`${x.warehouse_id}|${x.owner_org_id ?? ''}|${x.currency}|${x.sku_id}|${x.batch_no}`, round2(num(x.adj))]))
    const insBal = db.prepare(
      `INSERT INTO cost_period_balances
         (period, warehouse_id, owner_org_id, sku_id, batch_no, currency, qty, unit_cost, amount)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    let snapQty = 0
    let snapAmt = 0
    for (const r of rows) {
      // 快照数量与三层同精度（4 位小数）：快照是下一期的期初，
      // 这里少留两位，下一期的期初就会与上一期的期末差 0.00x —— 结转白做。
      const q = round4(num(r.qty))
      const adj = adjMap.get(`${r.warehouse_id}|${r.owner_org_id ?? ''}|${r.currency}|${r.sku_id}|${r.batch_no}`) || 0
      const amt = round2(num(r.amount) + adj)
      snapQty = round4(snapQty + q)
      snapAmt = round2(snapAmt + amt)
      insBal.run(p, r.warehouse_id, r.owner_org_id ?? null, r.sku_id, r.batch_no || '', r.currency || 'CNY',
        q, q ? round4(amt / q) : 0, amt)
    }

    // 快照合计必须等于「期初 + 本期入 − 本期出」。不等说明上面的分组口径与三层口径不一致，
    // 这是内部一致性错误，宁可结账失败也不能把不一致的快照落下去当下一期的期初。
    const snapDrift = {
      qty: round4(snapQty - layers.as_of_end.qty),
      amount: round2(snapAmt - layers.as_of_end.amount)
    }
    const snapOk = Math.abs(snapDrift.qty) < 1e-6 && Math.abs(snapDrift.amount) <= AMOUNT_TOL
    if (!snapOk) {
      throw new CostError(
        `期末快照与三层口径不一致：快照 ${snapQty} 件 / ${snapAmt} 元，` +
          `而「期初 + 本期入 − 本期出」是 ${layers.as_of_end.qty} 件 / ${layers.as_of_end.amount} 元。` +
          `两者必须同源，否则下一期的期初就是个错的起点。`,
        { code: 'COST_SNAPSHOT_DRIFT', httpStatus: 409, detail: { snapshot: { qty: snapQty, amount: snapAmt }, layers: layers.as_of_end, drift: snapDrift } }
      )
    }

    db.prepare(
      `UPDATE cost_periods SET
         status='closed',
         opening_qty=?, opening_amount=?, in_qty=?, in_amount=?,
         out_qty=?, out_amount=?, closing_qty=?, closing_amount=?,
         residual_qty=?, residual_amount=?, line_count=?,
         closed_by=?, closed_by_name=?, closed_at=?,
         remark=COALESCE(?, remark), updated_at=?
       WHERE period=?`
    ).run(
      layers.opening.qty, layers.opening.amount, layers.in.qty, layers.in.amount,
      layers.out.qty, layers.out.amount, layers.as_of_end.qty, layers.as_of_end.amount,
      layers.residual.qty, layers.residual.amount, rows.length,
      actor.id ?? null, actor.name ?? null, nowStr(), remark, nowStr(), p
    )

    return {
      period: p,
      reopened: !!reopen,
      lines: rows.length,
      // 残差的口径：现存量 −（截至期末 + 期末之后的流水）。归因正确时恒为 0。
      balanced: layers.balanced,
      snapshot: { qty: snapQty, amount: snapAmt },
      layers
    }
  })
  return tx()
}

// ---------------------------------------------------------------------------
// 五、暂估差异：台账与回写
// ---------------------------------------------------------------------------

/**
 * 暂估差异台账：入库按订单价（暂估）入账，结算后真实成本是 settlement_items.final_cost。
 *
 * ⚠ 这里**必须分清两个不同的差异口径**，混用会让整个模块的核心动作变成空转
 *   （本项目实测踩过：界面显示「待调整 566,866.88」，点进去建出来一张 0 元调整单）：
 *
 *   ① **发票口径 invoice_diff** = purchase_settlements.diff_amount
 *      = 入库暂估金额 − 已开票金额。它是**供应商-期间级**的数，
 *      回答的是「这期还有多少货没拿到票」。**它下不到批次**：
 *      结算单里的发票行（source_type='invoice'）只有 sku 与数量单价，
 *      没有任何字段指回它冲的是哪一批入库 —— 所以它**不能**用来回写库存成本。
 *
 *   ② **成本口径 cost_diff** = Σ(入库行 qty × final_cost) − Σ(入库行 amount)
 *      = 结算时摊到入库行上的费用等净额。它是**批次级**的，因为入库行带着
 *      仓库与批次，能精确落到 inventory_stocks 的那一行上 —— 只有它能回写。
 *
 * 于是：**待调整金额以 cost_diff 为准**（待办只列「能做的」），
 * 发票口径的差额单独作为 invoice_diff 展示，不参与待办、也不参与回写。
 * 这与模块 07「宁可少算，绝不重复算」同源：做不到的事不要在待办里承诺。
 *
 * 还有第三条：**已售出那部分的差异永远不进待办**。
 * 差异 = 已回写（进库存）+ 已售出不追溯（进本期损益）+ 仍未处理。
 * 少了这一项，只要一张单涉及已售出数量，待办里就会永久挂着一截谁也做不掉的尾巴。
 *
 * 第四条：草稿调整单只表示「意图」，**不能算进已回写**。界面上要单列
 * 「草稿待确认」，让用户知道有一张单还没生效、点进去可以确认或取消。
 * 若把草稿混进「已回写」，取消草稿时会发现「已回写」数字又涨回去，极容易误导。
 *
 * 每张结算单一行，带出：
 *   est_amount   入库暂估金额（= Σ 入库行 amount）
 *   act_amount   实际入库成本（= Σ 入库行 qty × final_cost，含摊入费用）
 *   cost_diff    可回写差异（= act − est）
 *   invoice_diff 发票口径差额（仅展示）
 *   adjusted_*   已确认调整单回写金额（status='adjusted'）
 *   draft_*      草稿调整单的金额（尚未生效）
 *   sold_amount  已售出、按口径不追溯的部分（计入本期损益）
 */
export function estimateVariances(db, { status = null, limit = 200, onlyAdjustable = false } = {}) {
  const args = []
  let statusSql = ''
  if (status) {
    statusSql = 'AND st.status = ?'
    args.push(status)
  }
  args.push(limit)
  const rows = db
    .prepare(
      `SELECT st.id, st.doc_no, st.supplier_id, st.settle_date, st.status, st.settle_mode,
              st.receipt_amount, st.invoice_amount, st.fee_amount, st.settle_amount, st.diff_amount,
              s.name AS supplier_name,
              COALESCE((SELECT SUM(si.amount) FROM purchase_settlement_items si
                         WHERE si.settle_id = st.id AND si.source_type = 'receipt'), 0) AS cost_est,
              COALESCE((SELECT SUM(si.qty * COALESCE(si.final_cost,0)) FROM purchase_settlement_items si
                         WHERE si.settle_id = st.id AND si.source_type = 'receipt'), 0) AS cost_act,
              COALESCE((SELECT COUNT(*) FROM purchase_settlement_items si
                         WHERE si.settle_id = st.id AND si.source_type = 'receipt'), 0) AS source_lines,
              COALESCE((SELECT SUM(ad.adjusted_amount) FROM cost_adjustments ad
                         WHERE ad.settle_id = st.id AND ad.status = 'adjusted'), 0) AS adjusted_amount,
              COALESCE((SELECT SUM(ad.sold_amount) FROM cost_adjustments ad
                         WHERE ad.settle_id = st.id AND ad.status = 'adjusted'), 0) AS sold_amount,
              COALESCE((SELECT SUM(ad.adjusted_amount) FROM cost_adjustments ad
                         WHERE ad.settle_id = st.id AND ad.status = 'draft'), 0) AS draft_amount,
              COALESCE((SELECT SUM(ad.sold_amount) FROM cost_adjustments ad
                         WHERE ad.settle_id = st.id AND ad.status = 'draft'), 0) AS draft_sold,
              COALESCE((SELECT COUNT(*) FROM cost_adjustments ad
                         WHERE ad.settle_id = st.id AND ad.status <> 'cancelled'), 0) AS adjust_count
         FROM purchase_settlements st
         LEFT JOIN suppliers s ON s.id = st.supplier_id
        WHERE st.status <> 'voided' AND st.status <> 'draft' ${statusSql}
        ORDER BY st.id DESC LIMIT ?`
    )
    .all(...args)

  const out = rows.map((r) => {
    const est = round2(num(r.cost_est))
    const act = round2(num(r.cost_act))
    const costDiff = round2(act - est)
    const invoiceDiff = round2(num(r.diff_amount))
    const adjusted = round2(num(r.adjusted_amount))
    const sold = round2(num(r.sold_amount))
    const draftAdj = round2(num(r.draft_amount))
    const draftSold = round2(num(r.draft_sold))
    const sourceLines = num(r.source_lines)
    const adjustable = Math.abs(costDiff) > AMOUNT_TOL && sourceLines > 0
    // 待办 = 差异 − 已确认回写 − 已售不追溯 − 草稿待确认（草稿一旦确认就会结平这部分）
    const left = round2(costDiff - adjusted - sold - draftAdj - draftSold)
    return {
      ...r,
      est_amount: est,
      act_amount: act,
      // diff_amount 保留原字段名（下游与前端已按它渲染），语义即「可回写差异」
      diff_amount: costDiff,
      cost_diff: costDiff,
      invoice_diff: invoiceDiff,
      adjusted_amount: adjusted,
      sold_not_traced: sold,
      draft_amount: draftAdj,
      draft_sold: draftSold,
      draft_total: round2(draftAdj + draftSold),
      source_lines: sourceLines,
      pending_amount: adjustable && Math.abs(left) > AMOUNT_TOL ? left : 0,
      /** 能不能做：有可回写差异 + 有能落批次的入库行 */
      adjustable,
      /** 发票口径是否已经对齐（与「能不能回写成本」是两件事，别混着看） */
      invoice_settled: Math.abs(invoiceDiff) <= AMOUNT_TOL,
      fully_adjusted: !adjustable || Math.abs(left) <= AMOUNT_TOL,
      diff_label: Math.abs(costDiff) <= AMOUNT_TOL
        ? '无成本差异'
        : costDiff > 0 ? '需补计成本' : '需冲减成本',
      /** 差异为什么不能回写 —— 界面上要能直接答出来，而不是给个 0 元单让人猜 */
      blocked_reason: adjustable
        ? null
        : sourceLines === 0
          ? '本结算单只有发票行、没有入库来源行，差异落不到具体批次'
          : '入库行的暂估成本与最终成本一致（结算单上的差额来自发票口径的「还没拿到票」，没有批次落点）'
    }
  })
  return onlyAdjustable ? out.filter((x) => x.adjustable) : out
}

/** 单张结算单的「可回写成本差异」= Σ(入库行 qty × final_cost) − Σ(入库行 amount) */
export function settleCostDiff(db, settleId) {
  const r = db
    .prepare(
      `SELECT COALESCE(SUM(si.amount),0) est,
              COALESCE(SUM(si.qty * COALESCE(si.final_cost,0)),0) act,
              COUNT(*) lines
         FROM purchase_settlement_items si
        WHERE si.settle_id = ? AND si.source_type = 'receipt'`
    )
    .get(settleId)
  return {
    est: round2(num(r.est)),
    act: round2(num(r.act)),
    diff: round2(num(r.act) - num(r.est)),
    lines: num(r.lines)
  }
}

/**
 * 结算单 → 逐行明细（暂估 vs 实际）。差异的**颗粒度是「入库单行」**，
 * 因为回写要落到具体批次上，而批次是跟着收货行走的。
 */
export function settlementLines(db, settleId) {
  return db
    .prepare(
      `SELECT si.id, si.source_type, si.source_id, si.source_doc_no, si.sku_id, si.qty,
              si.price, si.amount, si.fee_amount, si.final_cost
         FROM purchase_settlement_items si
        WHERE si.settle_id = ? AND si.source_type = 'receipt'
        ORDER BY si.line_no`
    )
    .all(settleId)
}

/** 入库行的实际落点（仓库/批次/货主/币种），回写成本必须按这些维度加锁 */
function locateReceiptLine(db, receiptId, skuId) {
  const rc = db.prepare('SELECT id, doc_no, warehouse_id, supplier_id FROM purchase_receipts WHERE id=?').get(receiptId)
  if (!rc) return null
  const item = db
    .prepare('SELECT id, batch_no, qty, price FROM purchase_receipt_items WHERE receipt_id=? AND sku_id=? LIMIT 1')
    .get(receiptId, skuId)
  if (!item) return null
  return { receipt: rc, item }
}

/**
 * 定位「某条入库行」对应的**库存行** —— 必须按五维（含货主与币种）定位，
 * 不能只按 (仓库, SKU, 批次) 取 `LIMIT 1`。
 *
 * 为什么：五维模型下同一 (仓, SKU, 批次) **可以有多行**（不同货主 / 不同币种）。
 * 只按三维 + `LIMIT 1` 取到的是"随机那一行"（实测命中 rowid 最小的那行）：
 * 成本差异就回写到**别人的货主**头上，该调的那一行一分不动 —— 两边的账都错，且不报错。
 *
 * 货主与币种从**这条入库行自己的流水**里取（入库那一刻由库存引擎写进去的，是权威值）；
 * 流水缺失（历史数据）时退回仓库默认货主 / 本位币，口径与 `lib/stock.js` 的解析一致。
 * 取不到行时**由调用方显式报错**，不许静默跳过 —— 静默跳过的表现是
 * "调整单建出来了、金额是 0"，差异就这么消失了（这正是本模块存在的意义）。
 */
function locateStockRow(db, { warehouseId, skuId, batchNo, receiptNo }) {
  const bn = batchNo || ''
  let owner = null
  let currency = null
  if (receiptNo) {
    const t = db
      .prepare(
        `SELECT owner_org_id, currency FROM inventory_transactions
          WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,'')=? AND doc_no=? AND direction='in'
          ORDER BY id LIMIT 1`
      )
      .get(warehouseId, skuId, bn, receiptNo)
    if (t) {
      owner = t.owner_org_id
      currency = t.currency
    }
  }
  if (owner == null || !currency) {
    const wh = db
      .prepare('SELECT COALESCE(default_owner_org_id, org_id) AS owner, currency FROM warehouses WHERE id=?')
      .get(warehouseId)
    if (owner == null) owner = wh?.owner ?? 0
    if (!currency) currency = wh?.currency || 'CNY'
  }
  return db
    .prepare(
      `SELECT * FROM inventory_stocks
        WHERE warehouse_id=? AND IFNULL(owner_org_id,0)=? AND sku_id=? AND IFNULL(batch_no,'')=? AND currency=?`
    )
    .get(warehouseId, Number(owner), skuId, bn, currency)
}

/**
 * 建成本调整单（草稿）。**不直接改成本** —— 改成本是 adjust() 的动作，
 * 与质检同一设计：建单是记录意图，提交才有后果。
 */
export function createAdjustment(db, { settleId, adjustDate = null, actor = {}, remark = null, source = 'api' } = {}) {
  if (!settleId) throw new CostError('缺少结算单', { code: 'COST_NO_SETTLE' })
  const st = db.prepare('SELECT * FROM purchase_settlements WHERE id=?').get(settleId)
  if (!st) throw new CostError('结算单不存在', { code: 'COST_SETTLE_NOT_FOUND', httpStatus: 404 })
  if (['draft', 'voided'].includes(st.status)) {
    throw new CostError(
      `结算单 ${st.doc_no} 当前为「${st.status}」，只有已提交/已审核/已结清的结算单才有暂估差异可调`,
      { code: 'COST_SETTLE_NOT_READY', httpStatus: 409 }
    )
  }
  // 校验必须用**行级口径**（能落到批次的那一份），不能用结算单头部的 diff_amount。
  // 两者不是一回事：头部是「入库暂估 vs 已开票」（供应商-期间级，下不到批次）。
  // 实测拿头部校验会出现「界面说待调整 56 万，建出来的单是 0 元」——
  // 差异就这么被静默丢掉了，正是本模块存在的意义。
  const cost = settleCostDiff(db, settleId)
  if (!cost.lines) {
    throw new CostError(
      `结算单 ${st.doc_no} 没有入库来源行（只有发票行），差异属于发票口径，落不到具体批次，无法回写库存成本。` +
        `发票口径的差 ${round2(num(st.diff_amount))} 元请走应付核销，不要调库存成本。`,
      { code: 'COST_NO_SOURCE_LINE', httpStatus: 409, detail: { invoice_diff: round2(num(st.diff_amount)) } }
    )
  }
  if (Math.abs(cost.diff) <= AMOUNT_TOL) {
    throw new CostError(
      `结算单 ${st.doc_no} 的入库行暂估成本与最终成本一致（${cost.est} → ${cost.act}），没有需要回写的库存成本差异。` +
        (Math.abs(num(st.diff_amount)) > AMOUNT_TOL
          ? `结算单上另有 ${round2(num(st.diff_amount))} 元的差额，那是「入库暂估 vs 已开票」的发票口径数（还有货没拿到票），` +
            `它没有对应的批次落点，改不了库存成本。`
          : ''),
      { code: 'COST_NO_VARIANCE', httpStatus: 409, detail: { cost_diff: cost.diff, invoice_diff: round2(num(st.diff_amount)) } }
    )
  }
  const exist = db
    .prepare("SELECT id, doc_no, status FROM cost_adjustments WHERE settle_id=? AND status <> 'cancelled'")
    .get(settleId)
  if (exist) {
    // 已有一张草稿 → 直接把它拿出来让人继续核对/确认/取消；
    // 已有一张已确认 → 不允许第二张生效单（要纠正请开反向调整单）。
    if (exist.status === 'draft') {
      return getAdjustment(db, exist.id)
    }
    throw new CostError(`该结算单已有生效的成本调整单 ${exist.doc_no}（${exist.status}）`, {
      code: 'COST_ADJ_DUPLICATE', httpStatus: 409, detail: { adjustment_id: exist.id, doc_no: exist.doc_no }
    })
  }

  const date = ymd(adjustDate || new Date())
  const period = periodOf(date)
  // 归属期间必须是打开的：往已结转期间塞调整，等于推翻已经结出来的期末数字
  assertPeriodOpen(db, date)

  const lines = settlementLines(db, settleId)
  if (!lines.length) {
    throw new CostError(`结算单 ${st.doc_no} 没有入库来源行，无法定位成本落点`, { code: 'COST_NO_SOURCE_LINE' })
  }

  const tx = db.transaction(() => {
    const no = nextAdjNo(db, date)
    const estTotal = round2(lines.reduce((a, l) => a + num(l.amount), 0))
    const actTotal = round2(lines.reduce((a, l) => a + num(l.qty) * num(l.final_cost), 0))
    const info = db
      .prepare(
        `INSERT INTO cost_adjustments
           (doc_no, adjust_date, adjust_type, period, settle_id, settle_no, supplier_id,
            est_amount, act_amount, diff_amount, status, remark, created_by, created_by_name, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,'draft',?,?,?,?,?)`
      )
      .run(no, date, 'estimate_variance', period, settleId, st.doc_no, st.supplier_id,
        estTotal, actTotal, round2(actTotal - estTotal), remark, actor.id ?? null, actor.name ?? null, nowStr(), nowStr())
    const id = info.lastInsertRowid

    const insItem = db.prepare(
      `INSERT INTO cost_adjustment_items
         (adjustment_id, line_no, warehouse_id, sku_id, batch_no, receipt_no,
          qty_total, qty_on_hand, qty_sold, price_est, price_act, amount_est, amount_act, adj_amount,
          unit_before, unit_after, amount_before, amount_after, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    let lineNo = 0
    let soldQty = 0
    let soldAmt = 0
    let adjAmt = 0
    for (const l of lines) {
      const loc = locateReceiptLine(db, l.source_id, l.sku_id)
      if (!loc) continue
      lineNo += 1
      const qtyTotal = round4(num(l.qty))
      const pEst = round4(num(l.price))
      const pAct = round4(num(l.final_cost))
      // **本行的差异总额**（精确到分）：单价是分位、数量是 4 位小数，
      // 乘出来再 round2 就落在分上（金额的最小单位是分）。
      // 整单的 diff 就是各行 lineDiff 之和 ——
      // 用「行」做计算单元而不是用「单价差 × 数量」现算，是为了让
      // 回写（在库）+ 不追溯（已售出）**恰好**等于本行差异，不留说不清的尾差。
      const lineDiff = round2(qtyTotal * (pAct - pEst))
      // 仍在库数量：**这是本模块最关键的一个数** —— 只调它，不去追已售出部分
      // 定位必须带**货主与币种**（见 locateStockRow 的注释）：同 (仓, SKU, 批次) 多行时，
      // 只按三维取一行会把差异回写到别人的货主头上。
      const stock = locateStockRow(db, {
        warehouseId: loc.receipt.warehouse_id,
        skuId: l.sku_id,
        batchNo: loc.item.batch_no,
        receiptNo: loc.receipt.doc_no
      })
      // 取不到行 = 这条入库行没有落点。**必须报错，不能跳过**：
      // 跳过（含旧实现的 `stock?.` 可选链）的表现是"调整单建出来了、金额是 0"，
      // 差异就这么静默消失 —— 报表上还会显示"已调整"。
      if (!stock) {
        throw new CostError(
          `入库行（${loc.receipt.doc_no} / SKU#${l.sku_id} / 批次 ${loc.item.batch_no || '-'}）对应的库存行不存在，无法定位成本落点。` +
            `请先确认这批货确实入过库（货主与币种按该入库单的库存流水定位）。`,
          {
            code: 'COST_STOCK_NOT_FOUND',
            httpStatus: 409,
            detail: { receipt_no: loc.receipt.doc_no, sku_id: l.sku_id, batch_no: loc.item.batch_no || '' }
          }
        )
      }
      const stockUnit = num(stock.cost_price)
      const stockAmount = stock.cost_amount != null ? num(stock.cost_amount) : num(stock.qty_on_hand) * stockUnit
      // 可调整数量**不得超过本行的入库总量**。
      // 为什么不能直接用批次现存量：一个批次可能被多张入库单共用（批次号会撞），
      // 那时批次现存量 > 本行入库量 —— 直接拿它乘单价差，等于**替别的入库单多调了一部分成本**，
      // 而且「在库 + 已售出 = 入库总量」这条闭合式会当场不成立（实测食品库 24 行里有若干行中招）。
      const qtyOnHand = round4(Math.min(Math.max(0, num(stock.qty_on_hand)), qtyTotal))
      const qtySold = round4(qtyTotal - qtyOnHand)
      // 按数量占比拆本行差异；已售出那一份用**减法**得到，保证两份之和恰好等于 lineDiff
      const lineAdj = qtyTotal > 0 ? round2(lineDiff * (qtyOnHand / qtyTotal)) : 0
      const lineSold = round2(lineDiff - lineAdj)
      soldQty = round4(soldQty + qtySold)
      // 已售出部分的差异不追，但要**算出来并露出来**，否则「差异去哪了」没人答得上
      soldAmt = round2(soldAmt + lineSold)
      adjAmt = round2(adjAmt + lineAdj)
      insItem.run(id, lineNo, loc.receipt.warehouse_id, l.sku_id, loc.item.batch_no || '', loc.receipt.doc_no,
        qtyTotal, qtyOnHand, qtySold, pEst, pAct, round2(qtyTotal * pEst), round2(qtyTotal * pAct), lineAdj,
        stockUnit, stockUnit, round2(stockAmount), round2(stockAmount),
        loc.item.batch_no ? `批次 ${loc.item.batch_no}` : null)
    }
    if (!lineNo) {
      throw new CostError(`结算单 ${st.doc_no} 的来源入库行已不存在（单据可能被重建），无法回写成本`, {
        code: 'COST_SOURCE_GONE', httpStatus: 409
      })
    }
    db.prepare(
      'UPDATE cost_adjustments SET line_count=?, adjusted_amount=?, sold_qty=?, sold_amount=?, updated_at=? WHERE id=?'
    ).run(lineNo, adjAmt, soldQty, soldAmt, nowStr(), id)
    return id
  })
  return getAdjustment(db, tx())
}

/**
 * 提交成本调整单：**这是唯一有后果的动作**。
 *
 * 顺序固定：
 *   ① 逐行把差异按「仍在库数量」回写批次结存金额与单价
 *   ② 写成本台账（stock_cost_ledger），让成本变动可回溯
 *   ③ 走内核把调整单推进到 adjusted
 *
 * 为什么必须先改成本再改状态：反过来一旦中途失败，会留下一张「已调整但金额没动」的单 ——
 * 报表会认为差异已处理，而库存金额没变，差异就凭空消失了。走内核的一致性由 applyTransition 保证。
 */
export function adjustCost(db, { id, actor = {}, remark = null, source = 'api' } = {}) {
  const head = db.prepare('SELECT * FROM cost_adjustments WHERE id=?').get(id)
  if (!head) throw new CostError('成本调整单不存在', { code: 'COST_ADJ_NOT_FOUND', httpStatus: 404 })
  if (head.status !== 'draft') {
    throw new CostError(`成本调整单当前为「${head.status}」，只有草稿可以确认调整`, {
      code: 'COST_ADJ_NOT_DRAFT', httpStatus: 409
    })
  }
  // 期间闸门再查一次：建单到提交之间期间可能被结转了
  assertPeriodOpen(db, head.adjust_date)

  const tx = db.transaction(() => {
    const items = db
      .prepare('SELECT * FROM cost_adjustment_items WHERE adjustment_id=? ORDER BY line_no')
      .all(id)
    const updStock = db.prepare(
      'UPDATE inventory_stocks SET cost_price=?, cost_amount=?, updated_at=? WHERE id=?'
    )
    const updItem = db.prepare(
      'UPDATE cost_adjustment_items SET unit_after=?, amount_after=? WHERE id=?'
    )
    const insLedger = db.prepare(
      `INSERT INTO stock_cost_ledger
         (biz_date, warehouse_id, owner_org_id, sku_id, batch_no, currency, direction, qty,
          unit_cost_before, unit_cost_after, amount_before, amount_after, cost_method, doc_type, doc_no, remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    const method = costMethod(db)
    let adjusted = 0
    for (const it of items) {
      // 提交回写也要按**五维**（货主与币种来自本单建单时记下的入库单号对应的流水）定位，
      // 与建单取数同一套口径 —— 两处各取一次，取到不同的行就等于"钱调给了别人"。
      const stock = locateStockRow(db, {
        warehouseId: it.warehouse_id,
        skuId: it.sku_id,
        batchNo: it.batch_no,
        receiptNo: it.receipt_no
      })
      // 取不到行**必须抛错**（事务整体回滚），不能 `continue`：
      // 静默跳过的后果是"单子显示已调整、库存金额没动"，差异凭空消失，事后无从追。
      if (!stock) {
        throw new CostError(
          `成本调整单 ${head.doc_no} 第 ${it.line_no} 行的库存行不存在` +
            `（仓 ${it.warehouse_id} / SKU#${it.sku_id} / 批次 ${it.batch_no || '-'}），无法回写成本。`,
          {
            code: 'COST_STOCK_NOT_FOUND',
            httpStatus: 409,
            detail: { line_no: it.line_no, sku_id: it.sku_id, batch_no: it.batch_no || '' }
          }
        )
      }
      const before = round2(num(stock.cost_amount))
      const after = round2(before + num(it.adj_amount))
      const qty = num(stock.qty_on_hand)
      const unitAfter = qty !== 0 ? round4(after / qty) : num(stock.cost_price)
      updStock.run(unitAfter, after, nowStr(), stock.id)
      updItem.run(unitAfter, after, it.id)
      insLedger.run(
        head.adjust_date, it.warehouse_id, stock.owner_org_id ?? null, it.sku_id, it.batch_no || '',
        stock.currency || 'CNY', 'adj', 0,
        num(stock.cost_price), unitAfter, before, after,
        method, 'CA', head.doc_no,
        `暂估差异回写（${head.settle_no || ''}，${it.receipt_no || ''}）`
      )
      adjusted = round2(adjusted + num(it.adj_amount))
    }

    db.prepare('UPDATE cost_adjustments SET adjusted_amount=?, updated_at=? WHERE id=?')
      .run(adjusted, nowStr(), id)

    // 走内核推进状态：不直接 UPDATE status —— 否则这张单没有留痕、也不能被统一查询
    applyTransition({
      db, docType: 'CA', id, action: 'adjust',
      actor: { id: actor.id ?? null, name: actor.name ?? null },
      remark: remark || `暂估差异回写 ${adjusted}（已售出部分 ${head.sold_amount} 计入本期损益，不追溯）`,
      source
    })
    return adjusted
  })
  const adjusted = tx()
  return { ...getAdjustment(db, id), adjusted_amount: adjusted }
}

/** 关闭/取消：取消只允许在草稿态（已调整的单不允许作废，见 008 的 CA 定义） */
export function transitionAdjustment(db, { id, action, actor = {}, remark = null, source = 'api' }) {
  const head = db.prepare('SELECT * FROM cost_adjustments WHERE id=?').get(id)
  if (!head) throw new CostError('成本调整单不存在', { code: 'COST_ADJ_NOT_FOUND', httpStatus: 404 })
  return applyTransition({
    db, docType: 'CA', id, action,
    actor: { id: actor.id ?? null, name: actor.name ?? null },
    remark, source
  })
}

export function getAdjustment(db, id) {
  const head = db
    .prepare(
      `SELECT a.*, s.name AS supplier_name
         FROM cost_adjustments a LEFT JOIN suppliers s ON s.id = a.supplier_id
        WHERE a.id = ?`
    )
    .get(id)
  if (!head) return null
  const items = db
    .prepare(
      `SELECT i.*, sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name
         FROM cost_adjustment_items i
         LEFT JOIN product_skus sk ON sk.id = i.sku_id
         LEFT JOIN warehouses w ON w.id = i.warehouse_id
        WHERE i.adjustment_id = ? ORDER BY i.line_no`
    )
    .all(id)
  const events = db
    .prepare(
      `SELECT action, action_name, from_state, to_state, actor_name, remark, created_at
         FROM doc_events WHERE doc_type='CA' AND doc_id=? ORDER BY id`
    )
    .all(id)
  return { ...head, items, events, status_label: ADJ_STATUS[head.status] || head.status }
}

export const ADJ_STATUS = { draft: '草稿', adjusted: '已调整', cancelled: '已取消' }

export function listAdjustments(db, q = {}) {
  const { page = 1, pageSize = 20, status = null, period = null, settleId = null } = q
  const where = []
  const args = []
  if (status) { where.push('a.status = ?'); args.push(status) }
  if (period) { where.push('a.period = ?'); args.push(period) }
  if (settleId) { where.push('a.settle_id = ?'); args.push(settleId) }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM cost_adjustments a ${w}`).get(...args).c
  const offset = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(
      `SELECT a.*, s.name AS supplier_name FROM cost_adjustments a
         LEFT JOIN suppliers s ON s.id = a.supplier_id
        ${w} ORDER BY a.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, offset)
  return {
    rows: rows.map((r) => ({ ...r, status_label: ADJ_STATUS[r.status] || r.status })),
    total, page: Math.max(1, page), pageSize
  }
}

function nextAdjNo(db, date) {
  const key = `CA${String(date).replace(/-/g, '')}`
  const row = db
    .prepare('SELECT doc_no FROM cost_adjustments WHERE doc_no LIKE ? ORDER BY doc_no DESC LIMIT 1')
    .get(`${key}%`)
  let seq = 1
  if (row?.doc_no) {
    const n = parseInt(String(row.doc_no).slice(key.length), 10)
    if (!Number.isNaN(n)) seq = n + 1
  }
  const exists = db.prepare('SELECT 1 AS hit FROM cost_adjustments WHERE doc_no=? LIMIT 1')
  const build = (n) => `${key}${String(n).padStart(4, '0')}`
  let no = build(seq)
  let guard = 0
  while (exists.get(no) && guard++ < 9999) no = build(++seq)
  return no
}

// ---------------------------------------------------------------------------
// 六、成本重算与自洽审计
// ---------------------------------------------------------------------------

/**
 * 成本自洽审计：把流水累计与结存金额对一遍。
 *
 * 判据：对每个 (仓库, SKU, 批次)，`Σ入库金额 − Σ出库金额` 应等于结存 `cost_amount`。
 * 这条等式之所以成立，是因为移动加权下**每一笔出入库都写了自己的金额**，
 * 结存金额就是用这些金额加减出来的（见 stock.js 的 applyInWithCost / applyOutWithCost）。
 *
 * 一处**口径边界**（必须写清，否则会报出一堆假错）：
 *   数量归零时按 inv_params.zero_qty_cost=keep_last 的口径，**金额被强制归零、单价保留**。
 *   此时「流水累计」还剩一个残值，而结存金额是 0 —— 两者不等是**设计如此**，不是错。
 *   所以本函数对 qty_on_hand = 0 的行只统计不判错，单独列在 zero_qty 里。
 *
 * 「流水累计」的完整口径 = 出入库流水净额 + 成本调整净额（adj 台账）。
 *   调整只改金额不写 inventory_transactions —— 少加这一项，任何一次真实的成本调整
 *   都会被本函数报成 broken（实测：回写 1504.9 元后 7 行全部误报）。
 *
 * 返回 broken（真错）+ zero_qty（口径差异），并把差异最大的前若干条带出来方便定位。
 */
export function auditCostIntegrity(db, { limit = 20 } = {}) {
  const rows = db
    .prepare(
      `SELECT s.id, s.warehouse_id, s.sku_id, s.batch_no, s.qty_on_hand,
              COALESCE(s.cost_price,0) unit_cost,
              COALESCE(s.cost_amount, s.qty_on_hand * COALESCE(s.cost_price,0)) amount,
              COALESCE((SELECT SUM(t.amount) FROM inventory_transactions t
                         WHERE t.direction='in' AND t.warehouse_id=s.warehouse_id
                           AND t.sku_id=s.sku_id AND t.batch_no=s.batch_no),0)
            - COALESCE((SELECT SUM(t.amount) FROM inventory_transactions t
                         WHERE t.direction='out' AND t.warehouse_id=s.warehouse_id
                           AND t.sku_id=s.sku_id AND t.batch_no=s.batch_no),0)
            + COALESCE((SELECT SUM(l.amount_after - l.amount_before) FROM stock_cost_ledger l
                         WHERE l.direction='adj' AND l.warehouse_id=s.warehouse_id
                           AND l.sku_id=s.sku_id AND l.batch_no=s.batch_no),0) AS ledger_amount,
              sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name
         FROM inventory_stocks s
         LEFT JOIN product_skus sk ON sk.id = s.sku_id
         LEFT JOIN warehouses w ON w.id = s.warehouse_id`
    )
    .all()

  const broken = []
  const zeroQty = []
  for (const r of rows) {
    const diff = round2(num(r.ledger_amount) - num(r.amount))
    if (Math.abs(diff) <= AMOUNT_TOL) continue
    const item = { ...r, ledger_amount: round2(num(r.ledger_amount)), amount: round2(num(r.amount)), diff }
    if (Math.abs(num(r.qty_on_hand)) < 1e-6) zeroQty.push(item)
    else broken.push(item)
  }
  broken.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))
  zeroQty.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff))

  return {
    checked: rows.length,
    broken_count: broken.length,
    zero_qty_count: zeroQty.length,
    broken_amount: round2(broken.reduce((a, x) => a + x.diff, 0)),
    zero_qty_amount: round2(zeroQty.reduce((a, x) => a + x.diff, 0)),
    broken: broken.slice(0, limit),
    zero_qty: zeroQty.slice(0, limit)
  }
}

/**
 * 按流水重算某个维度的结存（只算不改），用来验证「结存金额可回溯」这句话是真的。
 * 返回 recomputed 与 current 的对比；调用方决定是否接受差异。
 */
export function recompute(db, { warehouseId, skuId, batchNo = '' }) {
  const r = db
    .prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN direction='in'  THEN qty ELSE 0 END),0)
       - COALESCE(SUM(CASE WHEN direction='out' THEN qty ELSE 0 END),0) qty,
         COALESCE(SUM(CASE WHEN direction='in'  THEN amount ELSE 0 END),0)
       - COALESCE(SUM(CASE WHEN direction='out' THEN amount ELSE 0 END),0)
       + COALESCE((SELECT SUM(l.amount_after - l.amount_before) FROM stock_cost_ledger l
                    WHERE l.direction='adj' AND l.warehouse_id=? AND l.sku_id=? AND l.batch_no=?),0) amount
       FROM inventory_transactions WHERE warehouse_id=? AND sku_id=? AND batch_no=?`
    )
    .get(warehouseId, skuId, batchNo, warehouseId, skuId, batchNo)
  const cur = db
    .prepare('SELECT qty_on_hand, cost_price, cost_amount FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
    .get(warehouseId, skuId, batchNo)
  const rQty = round4(num(r.qty))
  const rAmt = round2(num(r.amount))
  const cQty = round4(num(cur?.qty_on_hand))
  const cAmt = round2(num(cur?.cost_amount))
  return {
    recomputed: { qty: rQty, amount: rAmt, unit_cost: rQty ? round4(rAmt / rQty) : 0 },
    current: { qty: cQty, amount: cAmt, unit_cost: round4(num(cur?.cost_price)) },
    diff: { qty: round4(rQty - cQty), amount: round2(rAmt - cAmt) },
    consistent: Math.abs(rQty - cQty) < 1e-6 && Math.abs(rAmt - cAmt) <= AMOUNT_TOL
  }
}

// ---------------------------------------------------------------------------
// 七、概览
// ---------------------------------------------------------------------------

export function costingOverview(db, { period = null } = {}) {
  const p = period || periodOf(new Date())
  const layers = threeLayers(db, { period: p })
  // 待调整统计必须按**行级口径**（可回写的）算，并且：
  // ① 只算 status='adjusted' 的已回写，草稿不能算「已回写」；
  // ② 要减掉「已售出不追溯」那部分；
  // ③ 草稿待确认的金额也要从待办扣掉（它一旦确认就会结平这部分）。
  const pending = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(ABS(t.open_amt)),0) amt FROM (
         SELECT (si.act - si.est)
                - COALESCE(adj.adjusted, 0) - COALESCE(adj.sold, 0)
                - COALESCE(draft.adjusted, 0) - COALESCE(draft.sold, 0) AS open_amt
           FROM purchase_settlements st
           JOIN (SELECT settle_id, SUM(amount) est, SUM(qty * COALESCE(final_cost,0)) act
                   FROM purchase_settlement_items WHERE source_type='receipt' GROUP BY settle_id) si
             ON si.settle_id = st.id
           LEFT JOIN (SELECT settle_id, SUM(adjusted_amount) adjusted, SUM(sold_amount) sold
                        FROM cost_adjustments WHERE status = 'adjusted' GROUP BY settle_id) adj
             ON adj.settle_id = st.id
           LEFT JOIN (SELECT settle_id, SUM(adjusted_amount) adjusted, SUM(sold_amount) sold
                        FROM cost_adjustments WHERE status = 'draft' GROUP BY settle_id) draft
             ON draft.settle_id = st.id
          WHERE st.status NOT IN ('voided','draft')
       ) t
       WHERE ABS(t.open_amt) > 0.05`
    )
    .get()
  // 发票口径的差单列 —— 它是财务要看的数，但**不是**成本待办
  const invoiceGap = db
    .prepare(
      `SELECT COUNT(*) c, COALESCE(SUM(ABS(diff_amount)),0) amt FROM purchase_settlements
        WHERE status NOT IN ('voided','draft') AND ABS(diff_amount) > 0.05`
    )
    .get()
  const cur = db.prepare("SELECT * FROM cost_periods WHERE period=?").get(p)
  const audit = auditCostIntegrity(db, { limit: 5 })
  return {
    period: p,
    period_status: cur?.status || 'open',
    period_closed_at: cur?.closed_at || null,
    cost_method: costMethodSafe(db),
    layers,
    variance: {
      // 待调整：只有能回写到批次的差异才进这里（可操作性为准）
      pending_settlements: num(pending.c),
      pending_amount: round2(num(pending.amt)),
      // 发票口径的差：入库暂估 vs 已开票，仅展示。混进待办会造出做不掉的条目
      invoice_gap_settlements: num(invoiceGap.c),
      invoice_gap_amount: round2(num(invoiceGap.amt))
    },
    integrity: {
      checked: audit.checked,
      broken_count: audit.broken_count,
      broken_amount: audit.broken_amount,
      zero_qty_count: audit.zero_qty_count
    },
    adjusted_this_period: round2(
      num(db.prepare("SELECT COALESCE(SUM(adjusted_amount),0) v FROM cost_adjustments WHERE period=? AND status='adjusted'").get(p).v)
    ),
    sold_not_traced: round2(
      num(db.prepare("SELECT COALESCE(SUM(sold_amount),0) v FROM cost_adjustments WHERE period=? AND status='adjusted'").get(p).v)
    )
  }
}

export default {
  CostError, COST_METHODS, AMOUNT_TOL,
  costMethod, periodOf, periodRange, ensurePeriod, isPeriodClosed, assertPeriodOpen, periodFinished, listPeriods,
  threeLayers, closePeriod,
  estimateVariances, settleCostDiff, settlementLines, createAdjustment, adjustCost, transitionAdjustment,
  getAdjustment, listAdjustments, ADJ_STATUS,
  auditCostIntegrity, recompute, costingOverview
}
