/**
 * ============================================================================
 * 文件标识：server/lib/dealer-statement.js ｜ 经销商对账单的生命周期动作：确认 / 发送 / 结清 / 作废 —— **唯一实现**
 * ============================================================================
 * 【职责】经销商对账单的生命周期动作：确认 / 发送 / 结清 / 作废 —— **唯一实现**
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 经销商对账单的生命周期动作：确认 / 发送 / 结清 / 作废 —— **唯一实现**
 *
 * ===========================================================================
 * 一、为什么单独成文件，而不是塞进 `routes/dealers.js`
 * ===========================================================================
 *   ① 与 `lib/rebate.js` 同族：**判据只有一份**，路由只做鉴权与转发。
 *      "结清必须收齐"这条校验如果写在路由里，任何第二个入口（MCP / 脚本 /
 *      将来的批量结清）都会绕过它 —— 本项目已经用两条缺陷证明过这个形状
 *      （列表挡得住、详情挡不住；create 拦得住、update 拦不住）。
 *      同一条理由把"确认/发送"也收在这里：它在 `routes/dealers.js` 里原来是
 *      一段**裸 `UPDATE`**（改状态但不写留痕），而它恰恰是"这份对账单什么时候
 *      发给了客户"的唯一记录点。
 *   ② 测试脚本（`scripts/test-ar.mjs`）要能**直接 import** 这些函数做断言，
 *      不必伪造一个 express `req`。伪造出来的 `req` 会让"谁做的这次流转"失真，
 *      而留痕的第一要素是人。
 *   ③ 对账单口径（`statementFigures`）与"收齐"判据必须同处一地：
 *      分成两处之后，将来改了生成口径、忘了改结清判据，就会出现
 *      "对账单说收齐了、结清却拒绝"这种自相矛盾且不报错的怪状。
 *
 * ===========================================================================
 * 二、这四个动作**只动对账单这一张凭证**
 * ===========================================================================
 *   · 确认（confirm）：把对账单从 `draft` 推到 `confirmed`；
 *   · 发送（send）   ：从 `confirmed` 推到 `sent`；
 *   · 结清（close）  ：推到 `closed`，并落下「谁、何时、为什么」；
 *   · 作废（void）   ：推到 `voided`，同样落痕。
 *
 *   ⚠️ **四个动作都不动底层应收台账** —— `sales_orders` / `ar_documents` / `receipts`
 *   分毫不动。这句话是刻意写死的，因为下一维护者很容易把"作废对账单"
 *   理解成"整条债权作废"：
 *     · 债权（客户欠我多少）由**销售订单与应收单**承载，它们的生命周期
 *       由开票 / 退货 / 收款核销驱动；
 *     · 对账单只是「某一期间，双方确认过的一份账目快照」——它是**结论的载体**，
 *       不是**债权的载体**。
 *   若真的要"这笔钱不要了"，那是坏账核销（动应收单 + 凭证），是另一个域的事。
 *   作废对账单之后，那笔钱照样挂在应收上、照样计入账龄 —— 这是**正确的**：
 *   客户不认这份对账单，不等于客户不用还钱。
 *
 * ===========================================================================
 * 三、"收齐"的判据（写出来，便于审计与反例）
 * ===========================================================================
 * 引用四个数（全部来自**同主体、同期间**）：
 *   期初 `opening`   = Σ(sales_orders.receivable_amount − paid_amount)
 *                      where dealer_id=? and order_date < period_start
 *                            and status not in ('cancelled','draft')
 *   本期销售 `sales` = Σ(receivable_amount)  where order_date ∈ [period_start, period_end]
 *   本期退货 `ret`   = Σ(sales_returns.total_amount) where return_date ∈ [period_start, period_end]
 *   本期回款 `paid`  = Σ(paid_amount)         where order_date ∈ [period_start, period_end]
 *   期末应收 `closing` = opening + sales − ret − paid
 * 判据：**|closing| ≤ 0.01** 即视为收齐。
 *   容差 0.01 的理由：本项目金额一律两位小数（1 分），`closing` 已按 0.01 取整，
 *   半分钱不可能出现，所以 0.01 是"一分钱尾差"而非"放宽"。
 *   ——与 `lib/ar.js` 的 `allocated >= amount − 0.005` 同族（那里多 0.005 是为了避开
 *   浮点比较；这里没有浮点，因为 closing 已经过 round2）。
 *
 * 判据用的是**当下重算**的值，不是对账单上存着的 `closing_amount`。
 * 理由：`closing_amount` 是「生成那一刻」的快照；生成之后又来了一笔回款或退货时，
 * 快照就过期了。用快照判"收齐"会放过一张"账上还挂着钱"的单（**这正是要防的**）。
 * 两个值都会在返回值里给出（`figures` 与 `snapshot`），便于对账时看清差异。
 *
 * ===========================================================================
 * 四、手动结清（force）：一条**显式的越权通道**
 * ===========================================================================
 * 业务上确实存在"钱没收齐但要结清"的正当场景：坏账核销后仍有尾差、
 * 以返利/预收抵扣后剩一分钱、客户走线下和解。所以留一条路，但它必须：
 *   ① 显式传 `force=true`（默认 `false`，**不传就走不通**）；
 *   ② 带上不少于 `MIN_REASON` 字的理由 —— 落在单据的 `close_reason` 上
 *      （不只是事件流的 remark，理由要跟着这张单走）；
 *   ③ 在留痕里被标成一次"手动结清"（remark 前缀），使它在事件流里一眼可辨。
 * 少了任何一条，`STATEMENT_NOT_SETTLED` 就会拦住 —— 于是"0 回款也能标已结清"
 * 这条路的**唯一入口**是"显式 force + 写明理由"，默认路径永远走不通。
 */

import { applyTransition } from './docflow.js'
import { localNow } from './dates.js'

export class StatementError extends Error {
  constructor(code, message, http = 409, detail = null) {
    super(message)
    this.name = 'StatementError'
    this.code = code
    // 同时写 `.status` / `.http`：HTTP 层的 `statusOf()` 三个字段都认，
    // 但只有 `.code` + `.status` 同时存在，`failFromError` 才会把它当业务错误处理
    // （否则会退化成 500，把"账没收齐"报成"服务器挂了"）。
    this.status = http
    this.http = http
    this.detail = detail
  }
}

/** 期末应收的收齐容差（元）。见文件头第三节。 */
export const SETTLE_TOLERANCE = 0.01

/** 手动结清的理由最短长度（去空白后）。见文件头第四节。 */
export const MIN_REASON = 5

/** 金额一律两位小数 */
const round2 = (n) => Number((Number(n) || 0).toFixed(2))

/**
 * 对账单口径（**业务侧唯一出处**）。
 *
 * `routes/dealers.js` 的 `POST /statements`（生成对账单）与 `closeStatement`
 * （判断收齐）都调这里 —— 生成口径与结清判据**必须同源**，否则会出现
 * "刚生成的对账单立刻就能被结清"或"永远结不了"。
 *
 * ⚠️ `db/seed.js` 里还有一份逐字相同的 SQL（造演示数据用，fixture 性质）。
 * 改动本函数时，必须同步核对那里；两边的口径漂移会让 seed 造的账
 * 在结清时被判成"没收齐"。
 *
 * @returns {{opening_amount:number,sales_amount:number,return_amount:number,received_amount:number,closing_amount:number}}
 */
export function statementFigures(db, { dealerId, periodStart, periodEnd }) {
  const opening = db
    .prepare(
      `SELECT COALESCE(SUM(receivable_amount - paid_amount),0) v FROM sales_orders
       WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND order_date < ?`
    )
    .get(dealerId, periodStart).v
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(paid_amount),0) paid FROM sales_orders
       WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND order_date BETWEEN ? AND ?`
    )
    .get(dealerId, periodStart, periodEnd)
  const ret = db
    .prepare('SELECT COALESCE(SUM(total_amount),0) v FROM sales_returns WHERE dealer_id=? AND return_date BETWEEN ? AND ?')
    .get(dealerId, periodStart, periodEnd).v
  const o = Number(opening) || 0
  const s = Number(agg.amount) || 0
  const r = Number(ret) || 0
  const p = Number(agg.paid) || 0
  return {
    opening_amount: o,
    sales_amount: s,
    return_amount: r,
    received_amount: p,
    closing_amount: round2(o + s - r - p)
  }
}

/** 取对账单，取不到抛 404（各动作共用） */
function loadStatement(db, id) {
  const st = db.prepare('SELECT * FROM dealer_statements WHERE id=?').get(Number(id))
  if (!st) throw new StatementError('STATEMENT_NOT_FOUND', `对账单 #${id} 不存在`, 404)
  return st
}

/**
 * 目标状态 → 内核动作。**只此一处**：路由不再自带一份映射。
 *
 * 只有两条边，因为它们是对账单**出具过程**里唯一合法的前进方向：
 *   `draft → confirmed`（确认对账）与 `confirmed → sent`（发送客户）。
 * ⚠️ `draft ← confirmed`（退回草稿）**刻意不在表里**：内核里它不是一条合法边 ——
 *   "回退"要有回退的语义与留痕，不该靠一个通用状态端点顺手做。
 *   实测调用方（`src/pages/dealers/Statements.tsx`）只传 confirmed / sent。
 */
export const STATUS_ACTION = { confirmed: 'confirm', sent: 'send' }

/**
 * 确认 / 发送对账单（`POST /api/dealers/statements/:id/status` 的唯一实现）。
 *
 * 为什么这件事必须走内核：它**曾经是一段裸 `UPDATE`** —— 状态变了、`doc_events` 里
 * 一条痕都没有。而"这份对账单什么时候发给了客户"是**下游一切的起点**
 * （客户收到 → 开始对账 → 据此结清/作废），查不到它怎么变成 `sent` 就等于这段历史不存在。
 *
 * @param {object} p
 * @param {Database} p.db
 * @param {number}  p.id     对账单 id
 * @param {string}  p.status 目标状态：`confirmed` | `sent`
 * @param {object}  [p.actor]
 * @param {string}  [p.remark]
 * @returns {{statement:object,transition:object}}
 */
export function setStatementStatus(db, { id, actor = null, status, remark = null }) {
  const st = loadStatement(db, id)
  const action = STATUS_ACTION[status]
  // 文案与原来那段的 `fail(res,'状态不合法')` 保持一致：前端只 toast `e.message`，
  // 换成别的措辞会让同一类错误在界面上前后不一。
  if (!action) {
    throw new StatementError('BAD_STATUS', '状态不合法', 400, {
      status,
      allowed: Object.keys(STATUS_ACTION)
    })
  }
  const transition = applyTransition({
    db,
    docType: 'DS',
    id: st.id,
    action,
    actor,
    remark,
    // 保留原字段语义：确认时记 `confirmed_at`（原实现写的就是它）。
    // 通过 `set` 与状态在同一次 UPDATE 里落库 ⇒ 不会出现"状态变了、时间没写"。
    set: status === 'confirmed' ? { confirmed_at: localNow() } : {}
  })
  return {
    statement: db.prepare('SELECT * FROM dealer_statements WHERE id=?').get(st.id),
    transition
  }
}

/**
 * 结清对账单。
 *
 * @param {object} p
 * @param {Database} p.db
 * @param {number}  p.id      对账单 id
 * @param {object}  [p.actor] { id, name }
 * @param {string}  [p.reason] 结清说明；**手动结清（force）时必填**
 * @param {boolean} [p.force]  是否允许"业务判断手动结清"（账未收齐时）
 * @returns {{statement:object,transition:object,figures:object,settled:boolean,forced:boolean}}
 */
export function closeStatement(db, { id, actor = null, reason = null, force = false }) {
  const st = loadStatement(db, id)
  const figures = statementFigures(db, {
    dealerId: st.dealer_id,
    periodStart: st.period_start,
    periodEnd: st.period_end
  })
  const settled = Math.abs(figures.closing_amount) <= SETTLE_TOLERANCE
  const why = String(reason || '').trim()
  const forced = !!force && !settled

  // ---- 校验一：账没还清，且不是显式手动结清 ⇒ 拒绝 ----
  // 这条就是"0 回款也能标已结清"那条路的闸门。去掉它，下面第 5 条断言立刻变红。
  if (!settled && !force) {
    throw new StatementError(
      'STATEMENT_NOT_SETTLED',
      `期末应收 ¥${figures.closing_amount.toFixed(2)} 未收齐，不能结清` +
        `（同主体同期间重算：期初 ${round2(figures.opening_amount)} + 本期销售 ${round2(figures.sales_amount)}` +
        ` − 退货 ${round2(figures.return_amount)} − 回款 ${round2(figures.received_amount)}）` +
        `。如需业务判断手动结清，请传 force=true 并写明理由`,
      409,
      { closing_amount: figures.closing_amount, figures, tolerance: SETTLE_TOLERANCE }
    )
  }

  // ---- 校验二：手动结清必须写明理由 ----
  if (forced && why.length < MIN_REASON) {
    throw new StatementError(
      'REASON_REQUIRED',
      `手动结清必须写明理由（不少于 ${MIN_REASON} 个字）：该对账单期末应收 ¥${figures.closing_amount.toFixed(2)} 尚未收齐`,
      400,
      { closing_amount: figures.closing_amount, min_reason: MIN_REASON }
    )
  }

  // ---- 落库：状态流转 + 终局列，**同一事务**（applyTransition 自带事务） ----
  // 状态与留痕走内核 applyTransition（DS 的 close 边：confirmed/sent → closed），
  // 终局列通过 `set` 一并写 —— 两者必须在同一事务里，否则会出现
  // "状态是已结清、但没有结清时间/人"（或反过来）。见 043 迁移文件头第二节。
  const transition = applyTransition({
    db,
    docType: 'DS',
    id: st.id,
    action: 'close',
    actor,
    remark: forced ? `[手动结清] ${why}` : why || `期末应收 ¥${figures.closing_amount.toFixed(2)}，已收齐`,
    payload: { figures, settled, forced },
    set: {
      closed_at: localNow(),
      closed_by: actor?.id ?? null,
      closed_by_name: actor?.name ?? null,
      // 自动结清（账真的收齐）也留一句说明，但**不伪装成人工理由**：
      // 它有明确的来源（期末应收为 0），所以写的是事实本身，不是"为什么"。
      close_reason: why || (settled ? `自动结清：期末应收 ${figures.closing_amount}` : null)
    }
  })

  return {
    statement: db.prepare('SELECT * FROM dealer_statements WHERE id=?').get(st.id),
    transition,
    figures,
    settled,
    forced
  }
}

/**
 * 作废对账单。
 *
 * ⚠️ **只作废"这份对账单凭证"，不动底层应收台账**：
 *   本函数只做两件事 —— 把 `dealer_statements.status` 推到 `voided`（并落 voided_* 列）、
 *   写一条 `doc_events`。它**不碰** `sales_orders` / `ar_documents` / `receipts`：
 *   客户不认这份对账单，不等于客户不用还钱。
 *
 * @param {object} p
 * @param {Database} p.db
 * @param {number}  p.id     对账单 id
 * @param {object}  [p.actor] { id, name }
 * @param {string}  p.reason  作废理由（**必填**）
 * @returns {{statement:object,transition:object}}
 */
export function voidStatement(db, { id, actor = null, reason = null }) {
  const st = loadStatement(db, id)
  const why = String(reason || '').trim()

  // 作废是高危动作（内核对 DS 的 void 边 `is_danger=1`）：必须留下"为什么"。
  // 一份"双方确认过的账"从系统里消失，事后必须能答得出是谁、为什么。
  if (why.length < MIN_REASON) {
    throw new StatementError(
      'REASON_REQUIRED',
      `作废对账单必须写明理由（不少于 ${MIN_REASON} 个字）`,
      400,
      { min_reason: MIN_REASON }
    )
  }

  const transition = applyTransition({
    db,
    docType: 'DS',
    id: st.id,
    action: 'void',
    actor,
    remark: why,
    payload: { reason: why },
    set: {
      voided_at: localNow(),
      voided_by: actor?.id ?? null,
      voided_by_name: actor?.name ?? null,
      void_reason: why
    }
  })

  return {
    statement: db.prepare('SELECT * FROM dealer_statements WHERE id=?').get(st.id),
    transition
  }
}
