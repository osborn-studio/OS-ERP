/**
 * ============================================================================
 * 文件标识：server/lib/ar.js ｜ 应收与收款核销（模块 21 · 第一阶段）
 * ============================================================================
 * 【职责】应收与收款核销（模块 21 · 第一阶段）
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
 * 应收与收款核销（模块 21 · 第一阶段）
 *
 * 这一层只回答三个问题，其它一概不管：
 *   ① 谁欠我多少（ar_documents）—— 按客户 + 来源单据，一单一行；
 *   ② 这笔钱抵了哪几笔（receipt_allocations）—— 收款单与应收单多对多；
 *   ③ 逾期多久（aging）—— 到期日由「业务日期 + 账期」推，不靠手工填。
 *
 * 两条硬口径（与模块 07 付款侧严格对称，改一处就要改另一处）：
 *   ① **已收金额永远由核销明细 SUM 算出，不累加**。付款侧踩过的坑是
 *      paid_amount 自加，作废一笔就对不上账；这里 allocated_amount 一律重算。
 *   ② **核销生效点 = 收款单确认**。草稿上的核销明细只是「打算怎么抵」，
 *      确认后才真正抵减应收、才释放授信。钱没到账，额度就得继续占着。
 *
 * 与信用的接缝：确认收款 → credit.settle 释放占用；作废收款 → 重新计算，
 * 被释放的额度不会自动回来（要显式 release），因为作废本身是一次会计事件，
 * 由调用方决定要不要补一笔反向占用。
 */
import { nextDocNoAuto } from './docno.js'
// S-10：改一笔应收（冲减金额 / 作废）必须留痕，与流转同一套 `logEvent`。
import { applyTransition, logEvent } from './docflow.js'
import { settle as creditSettle } from './credit.js'
// 「今天」只有一个出处，详见 dates.js 的模块注释。
// 本模块曾经用 `new Date().toISOString().slice(0,10)`（**UTC 日期**）算账龄，
// 而 v_ar_aging_detail 视图用的是 `date('now','localtime')` ——
// 东八区本地 00:00–08:00 之间两者差一天，一张「本地今天到期」的应收单
// 在逐笔账龄里算逾期、在汇总账龄里不算，合计对不上且不报错。
import { localDate, localNow, addDays } from './dates.js'
// 订货中心的授信占用存在另一本台账（oc_credit_ledger），回款时要同步释放。
// 两本台账的分工：credit_accounts 是「全公司授信」（模块 08），
// oc_credit_ledger 是「订货中心专用占用」（模块 12A）；一张 OC 订单只占后者。
import { releaseByOrder as ocReleaseByOrder, reoccupyByOrder as ocReoccupyByOrder } from './oc-credit.js'

/** 应收来源类型：SO 销售订单 / OC 订货单 / SI 销售发票 / MANUAL 手工补账 */
export const AR_SOURCE_SO = 'SO'
export const AR_SOURCE_OC = 'OC'
export const AR_SOURCE_SI = 'SI'
export const AR_SOURCE_MANUAL = 'MANUAL'

export class ArError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = http
    this.detail = detail
  }
}

const nowText = () => localNow()
const money = (n) => Number((Number(n) || 0).toFixed(2))

export const AR_STATUS_LABEL = {
  open: '待收款',
  partial: '部分收款',
  closed: '已结清',
  voided: '已作废'
}
export const RC_STATUS_LABEL = { draft: '草稿', confirmed: '已收款', voided: '已作废' }
export const PAY_METHOD_LABEL = { transfer: '银行转账', cash: '现金', bill: '票据', online: '在线支付' }

/** 到期日 = 业务日期 + 账期天数（账期 0 视为当天到期＝现结） */
export function dueDateOf(bizDate, creditDays = 0) {
  // 日期加法只此一处（dates.js 的 addDays，本地整数运算，不经过 toISOString）——
  // 曾经在这里手写一份，结果 credit.js 自己又写了一份、还带着 toISOString 的老毛病。
  return addDays(bizDate, Math.max(0, Number(creditDays) || 0))
}

// ---------------------------------------------------------------------------
// S-8：往来主体归并（对账 / 账龄必须把同一个客户的两套标合成一套）
//
// 同一个经销商在应收台账里会被记成两套主体标：
//   · 销售侧 `dealer`（subject_id = dealers.id）—— 订单应收走这条；
//   · 订货中心侧 `oc`（subject_id = oc_customers.id）—— `ensureOcAr` 走这条。
// 两者是**同一个往来对象**。`statement`/`agingBySubject` 原来按
// (subject_type, subject_id) 精确匹配 ⇒ 余额被拆成两行、对账单少列
// （实测：华南经销丙 dealer 主体 63,666.10 + oc 主体 13,253.10，statement 只返 63,666.10）。
//
// 归并口径与 `lib/credit.js` 的 `resolveSubject` **同源**：
// `oc_customers.source_type='dealer'` 的客户就是那个经销商（`source_id` = dealers.id）。
// 这里只在**读**的时候归并 —— 不回头改 `ensureOcAr` 的写入主体：
// 那会让库里已有的一批 `oc` 行与新的 `dealer` 行两种形态并存，
// 而本批不允许加迁移/加表，历史数据无从校正（详见修复报告"取舍"）。
// ---------------------------------------------------------------------------

/** oc_customers.id → 它真正对应的往来主体（与 credit.js resolveSubject 同口径） */
function ocSubjectMap(db) {
  const m = new Map()
  for (const r of db
    .prepare("SELECT id, source_id FROM oc_customers WHERE source_type='dealer' AND source_id IS NOT NULL")
    .all()) {
    m.set(Number(r.id), { subject_type: 'dealer', subject_id: Number(r.source_id) })
  }
  return m
}

/** 一个记账主体归并后落在哪个往来主体上 */
function canonicalSubject(map, type, id) {
  if (type === 'oc') {
    const hit = map.get(Number(id))
    if (hit) return hit
  }
  return { subject_type: type, subject_id: Number(id) }
}

/** 某往来主体 = 哪些记账主体（含订货中心并入的那套） */
function subjectsOf(db, subjectType, subjectId) {
  const out = [{ subject_type: String(subjectType), subject_id: Number(subjectId) }]
  if (subjectType === 'dealer' || subjectType === 'store') {
    for (const r of db
      .prepare('SELECT id FROM oc_customers WHERE source_type=? AND source_id=?')
      .all(subjectType, Number(subjectId))) {
      out.push({ subject_type: 'oc', subject_id: Number(r.id) })
    }
  }
  return out
}

/** 把「某主体」展开成 SQL 谓词（'col' 传表别名前缀，如 'd.'） */
const subjectWhere = (pairs, col = '') => '(' + pairs.map(() => `${col}subject_type=? AND ${col}subject_id=?`).join(' OR ') + ')'
const subjectWhereArgs = (pairs) => pairs.flatMap((x) => [x.subject_type, x.subject_id])

/** 逾期天数：未到期为 0。`today` 默认取**本地**日期，与 v_ar_aging_detail 视图同源 */
export function overdueDaysOf(row, today = localDate()) {
  if (!row?.due_date) return 0
  const due = new Date(`${row.due_date}T00:00:00`).getTime()
  const now = new Date(`${today}T00:00:00`).getTime()
  if (Number.isNaN(due) || Number.isNaN(now)) return 0
  return Math.max(0, Math.floor((now - due) / 86400000))
}

/**
 * 由来源单据生成应收单（幂等：同一来源只生成一次）。
 * 幂等不是偷懒 —— 订单确认、发货、补单都会调它，重复生成等于凭空多一笔应收。
 */
export function ensureAr(db, p = {}) {
  const {
    subjectType,
    subjectId,
    subjectName = null,
    sourceType = 'SO',
    sourceId = null,
    sourceDocNo = null,
    bizDate = localDate(),
    amount = 0,
    creditDays = 0,
    currency = 'CNY',
    remark = null,
    actor = null
  } = p
  if (!subjectType || !subjectId) throw new ArError('AR_SUBJECT_REQUIRED', '应收单必须指定往来对象', 400)
  const amt = money(amount)
  if (!(amt > 0)) throw new ArError('AR_AMOUNT_INVALID', '应收金额必须大于 0', 400)

  const exist = db
    .prepare('SELECT * FROM ar_documents WHERE source_type=? AND source_id=?')
    .get(sourceType, sourceId)
  if (exist) return exist

  const docNo = nextDocNoAuto(db, { docType: 'AR', table: 'ar_documents', field: 'doc_no', bizDate })
  const info = db
    .prepare(
      `INSERT INTO ar_documents
       (doc_no,subject_type,subject_id,subject_name,source_type,source_id,source_doc_no,
        biz_date,due_date,credit_days,amount,allocated_amount,status,currency,remark,
        created_by,created_by_name,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,0,'open',?,?,?,?,?,?)`
    )
    .run(
      docNo,
      subjectType,
      subjectId,
      subjectName,
      sourceType,
      sourceId,
      sourceDocNo,
      String(bizDate).slice(0, 10),
      dueDateOf(bizDate, creditDays),
      Number(creditDays) || 0,
      amt,
      currency,
      remark,
      actor?.id || null,
      actor?.name || null,
      nowText(),
      nowText()
    )
  return db.prepare('SELECT * FROM ar_documents WHERE id=?').get(info.lastInsertRowid)
}

/**
 * 这张**销售订单**名下的全部应收（**按订单聚合，不分来源**）—— 「这张订单的应收」的唯一口径。
 *
 * 为什么必须唯一：一笔订单的债权在库里可能挂两种来源标 ——
 *   · `SO`：订单口径下按订单建的；
 *   · `SI`：开票口径（`ar_source_of_truth='SI'`）下按发票建的，
 *     或 SO 口径下"订单还没建应收就先开了票"时的兜底。
 * 三个调用方（开票关联 / 订单回款 / 退货冲减）若各自只认一种来源，同一订单就会长出两笔应收
 * ——**实测：订单应收 200 → 开票建 SI 200 → 订单回款又建 SO 200 ⇒ 累计 400（债权凭空翻倍）**。
 * 所以「这张订单的应收」只此一处。
 */
export function arOfOrder(db, orderId) {
  const id = Number(orderId)
  if (!id) return []
  return db
    .prepare(
      `SELECT * FROM ar_documents
        WHERE (source_type=? AND source_id=?)
           OR (source_type=? AND source_id IN (SELECT id FROM sales_invoices WHERE order_id=?))
        ORDER BY id`
    )
    .all(AR_SOURCE_SO, id, AR_SOURCE_SI, id)
}

/** An invoice can own the receivable while its sales order owns the credit hold. */
function creditSourceOfAr(db, ar) {
  if (ar.source_type === AR_SOURCE_SI && ar.source_id) {
    const order = db.prepare(`SELECT so.id, so.doc_no
      FROM sales_invoices si JOIN sales_orders so ON so.id=si.order_id
      WHERE si.id=?`).get(ar.source_id)
    if (order) return { sourceType: AR_SOURCE_SO, sourceId: order.id, docNo: order.doc_no }
  }
  return { sourceType: ar.source_type, sourceId: ar.source_id, docNo: ar.source_doc_no || ar.doc_no }
}

/** 重算一张应收单的已收与状态：明细是唯一真相，状态由它推导 */
export function recalcAr(db, arId) {
  const row = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(arId)
  if (!row) return null
  if (row.status === 'voided') return row
  const alloc = db
    .prepare(
      `SELECT COALESCE(SUM(a.amount),0) AS s
       FROM receipt_allocations a
       JOIN receipts r ON r.id=a.receipt_id
       WHERE a.ar_id=? AND r.status='confirmed'`
    )
    .get(arId).s
  // ⚠️ A07：这里原来是 `Math.min(alloc, row.amount)` —— **把超核销悄悄裁掉**。
  // 后果：两张草稿各核 80 同一张 100 的应收，确认之后库里明细合计 160，
  // 而界面上显示 `allocated=100 / closed`，**看上去完全正常**。
  // 明细是唯一真相（文件头口径 ①），所以这里**不裁**：超了就是超了，让它显示出来。
  // 真正的闸门在 confirmReceipt（确认那一刻拒绝），这里只是"不掩盖"。
  const allocated = money(alloc)
  const status = allocated >= row.amount - 0.005 ? 'closed' : allocated > 0.005 ? 'partial' : 'open'
  db.prepare('UPDATE ar_documents SET allocated_amount=?, status=?, updated_at=? WHERE id=?').run(
    allocated,
    status,
    nowText(),
    arId
  )
  return db.prepare('SELECT * FROM ar_documents WHERE id=?').get(arId)
}

/**
 * 记一条「**谁触发了这次应收状态重算**」的痕。
 *
 * 为什么它**不是**一条"边流转痕"（所以 `from_state` 留空）：
 *   应收单的状态是 **由核销明细 SUM 推导**的（见 `recalcAr` 的文件头口径"明细即真相"），
 *   它不由边驱动。而且重算的方向**可以是回退** —— 作废一张收款单时 `closed → partial`，
 *   而内核里**没有**这条反向边（只有 `allocate: open→partial / partial→closed`）。
 *   若强行写一个 `from`，就是在时间线上声称一次**内核不认的流转** ⇒ 痕会说谎。
 *   所以这里如实记：`from` 留空、`to` 是重算后的真实状态，payload 里带 before/after 与触发者。
 *
 * 状态**没变**时不记（只是金额重算 ⇒ 不造"伪流转"）；`from=null` 的痕由
 * `scripts/check-doc-events-edges.mjs` 的规则天然豁免（那条规则只管"from 非空 ⇒ (from,to) 必须是边"）。
 */
function traceRecalc(db, { before, after, trigger, actor = null, payload = {} }) {
  if (!before || !after) return
  if (String(before.status) === String(after.status)) return
  logEvent({
    db,
    docType: 'AR',
    id: after.id,
    docNo: after.doc_no,
    action: 'recalc',
    actionName: '应收状态重算',
    from: null,
    to: after.status,
    actor: { id: actor?.id ?? null, name: actor?.name ?? null },
    source: 'api',
    remark: `应收状态重算（${trigger}）：${before.status} → ${after.status}`,
    payload: {
      ...payload,
      trigger,
      before: before.status,
      after: after.status,
      allocated_amount: money(after.allocated_amount),
      ar_amount: money(after.amount)
    }
  })
}

/** 重算某客户（或全部）应收单 —— 收款单作废后必须调一次 */
export function recalcArBySubject(db, { subjectType = null, subjectId = null } = {}) {
  const rows =
    subjectType && subjectId
      ? db.prepare('SELECT id FROM ar_documents WHERE subject_type=? AND subject_id=?').all(subjectType, subjectId)
      : db.prepare('SELECT id FROM ar_documents').all()
  for (const r of rows) recalcAr(db, r.id)
  return rows.length
}

/**
 * **冲减应收（唯一实现）** —— 销售退货与返利核销都走这里。
 *
 * 口径（与"退货不生成负数应收"是同一条）：
 *   · 只减少 `ar_documents.amount`，**绝不生成负数应收**；
 *   · 可冲额度 = 未核销余额（`amount - allocated_amount`）；
 *   · 冲不下的部分**如实回报** `unoffset`，由调用方登记成"待退/待处理"，不静默吞掉。
 *
 * 两种定位方式：
 *   · 给了 `arId` → 只冲这一张（销售退货：按来源订单找到的那张）；
 *   · 只给 `subjectType/subjectId` → 多张按「到期日 → id」顺序分摊
 *     （返利核销：返利不属于任何一张具体订单，是**对这个客户的债权**）。
 *
 * 为什么必须共用：`ar_documents.amount` 是账龄与客户汇总的共同基数，
 * 两处各自写一套手法的后果是「逐笔账龄」与「按客户汇总」当场分叉 ——
 * 而这两处对负余额的处理本来就不一致（逐笔跳过负值、汇总照算）。
 */
export function offsetAr(db, { arId = null, subjectType = null, subjectId = null, amount, reason = null } = {}) {
  let left = money(amount)
  const result = { offset: 0, unoffset: money(amount), ars: [] }
  if (!(left > 0)) return { ...result, unoffset: 0 }

  let rows
  if (arId != null) {
    const one = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(Number(arId))
    rows = one ? [one] : []
    // 显式指定了一张单，冲不下的就不再去找别的单 ——
    // "抵到这笔订单上"是一个明确的业务意图，替它换一张单是另一种口径。
    if (!rows.length) return result
  } else {
    rows = subjectType && subjectId
      ? db
          .prepare(
            `SELECT * FROM ar_documents
              WHERE subject_type=? AND subject_id=? AND status<>'voided'
                AND amount - allocated_amount > 0.005
              ORDER BY COALESCE(due_date, biz_date), id`
          )
          .all(subjectType, subjectId)
      : []
  }

  for (const ar of rows) {
    if (!(left > 0)) break
    if (ar.status === 'voided') continue
    const available = money(Math.max(Number(ar.amount) - Number(ar.allocated_amount), 0))
    const hit = money(Math.min(left, available))
    if (!(hit > 0)) continue
    db.prepare('UPDATE ar_documents SET amount=?, updated_at=? WHERE id=?').run(
      money(Number(ar.amount) - hit),
      nowText(),
      ar.id
    )
    const after = recalcAr(db, ar.id)
    // S-10：**改了应收就要留痕**。原来这里是一条裸 UPDATE ——
    // 退货冲减后应收金额变了，而 `doc_events` 里一条记录都没有（16 类单据零留痕共因之一）。
    // 留痕与流转共用同一套 `logEvent`（不改表、不新增字段）。
    logEvent({
      db,
      docType: 'AR',
      id: ar.id,
      docNo: ar.doc_no,
      action: 'offset',
      actionName: '冲减应收',
      from: ar.status,
      to: after?.status ?? ar.status,
      source: 'system',
      remark: reason || '冲减应收',
      payload: { before: money(ar.amount), offset: hit, after: money(after?.amount ?? ar.amount - hit) }
    })
    result.ars.push({ ar_id: ar.id, ar_no: ar.doc_no, offset: hit, reason })
    result.offset = money(result.offset + hit)
    result.unoffset = money(left - hit)
    left = money(left - hit)
  }
  result.unoffset = money(Math.max(0, Number(amount) - result.offset))
  return result
}

export function listAr(db, q = {}) {
  const where = []
  const args = []
  if (q.subjectType && q.subjectId) {
    where.push('subject_type=? AND subject_id=?')
    args.push(q.subjectType, q.subjectId)
  }
  if (q.status) {
    where.push('status=?')
    args.push(q.status)
  }
  if (q.openOnly) where.push("status IN ('open','partial')")
  if (q.overdueOnly) where.push("status IN ('open','partial') AND due_date < date('now','localtime')")
  if (q.keyword) {
    where.push('(doc_no LIKE ? OR source_doc_no LIKE ? OR IFNULL(subject_name,?) LIKE ?)')
    args.push(`%${q.keyword}%`, `%${q.keyword}%`, q.keyword, `%${q.keyword}%`)
  }
  const sql = `SELECT * FROM ar_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY due_date, id DESC LIMIT ? OFFSET ?`
  const pageSize = Number(q.pageSize) || 20
  const page = Number(q.page) || 1
  const rows = db.prepare(sql).all(...args, pageSize, (page - 1) * pageSize)
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM ar_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
    .get(...args).c
  return { rows, total, page, pageSize }
}

export function getAr(db, id) {
  const row = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(id)
  if (!row) return null
  const allocs = db
    .prepare(
      `SELECT a.*, r.doc_no AS receipt_no, r.receipt_date, r.status AS receipt_status, r.method
       FROM receipt_allocations a JOIN receipts r ON r.id=a.receipt_id
       WHERE a.ar_id=? ORDER BY a.id`
    )
    .all(id)
  return { ...row, overdue_days: overdueDaysOf(row), allocations: allocs }
}

// ---------------------------------------------------------------------------
// 收款单
// ---------------------------------------------------------------------------

/**
 * 登记收款单（草稿）+ 计划核销。
 * @param p.allocations 手工指定 [{ar_id, amount}]；不传则按 FIFO 自动摊（到期日在前）
 */
export function createReceipt(db, p = {}) {
  const {
    subjectType,
    subjectId,
    subjectName = null,
    receiptDate = localDate(),
    method = 'transfer',
    amount = 0,
    bankAccount = null,
    serialNo = null,
    remark = null,
    allocations = null,
    actor = null
  } = p
  if (!subjectType || !subjectId) throw new ArError('RC_SUBJECT_REQUIRED', '收款单必须指定往来对象', 400)
  const amt = money(amount)
  if (!(amt > 0)) throw new ArError('RC_AMOUNT_INVALID', '收款金额必须大于 0', 400)

  const tx = db.transaction(() => {
    const docNo = nextDocNoAuto(db, { docType: 'RCP', table: 'receipts', field: 'doc_no', bizDate: receiptDate })
    const info = db
      .prepare(
        `INSERT INTO receipts
         (doc_no,subject_type,subject_id,subject_name,receipt_date,method,amount,allocated_amount,
          status,bank_account,serial_no,remark,created_by,created_by_name,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,0,'draft',?,?,?,?,?,?,?)`
      )
      .run(
        docNo,
        subjectType,
        subjectId,
        subjectName,
        String(receiptDate).slice(0, 10),
        method,
        amt,
        bankAccount,
        serialNo,
        remark,
        actor?.id || null,
        actor?.name || null,
        nowText(),
        nowText()
      )
    const rid = Number(info.lastInsertRowid)

    const open = db
      .prepare(
        `SELECT * FROM ar_documents
         WHERE subject_type=? AND subject_id=? AND status IN ('open','partial')
         ORDER BY due_date, id`
      )
      .all(subjectType, subjectId)

    let left = amt
    // 逐条 INSERT（不用 INSERT OR REPLACE）：同一次请求里出现**同一个 ar_id** 时，
    // OR REPLACE 会静默把前一条盖掉 —— 用户以为自己核销了两笔，
    // 实际库里只有一条，而"计划核销"和"实收"对不上却不报错。
    // 所以这里改为先查重再插，重复直接拒绝。
    const insAlloc = db.prepare(
      'INSERT INTO receipt_allocations (receipt_id,ar_id,amount) VALUES (?,?,?)'
    )
    const plan = []
    // 显式给了 allocations（哪怕是空数组）= "就按这几条核销"，**不要 FIFO 兜底**。
    // 空数组是一个有意义的输入：客户多付的钱应当停在"预收"上，
    // 而不是被系统顺手抵到别的单去（A08：指定订单回款被 FIFO 串到同主体的另一张单）。
    if (Array.isArray(allocations)) {
      const seen = new Set()
      for (const a of allocations) {
        const arId = Number(a.ar_id)
        if (seen.has(arId)) {
          throw new ArError('RC_ALLOC_DUPLICATE_AR', `应收单 #${arId} 在同一次核销里出现了多次，请合并为一条`, 400)
        }
        seen.add(arId)
        const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(arId)
        if (!ar) throw new ArError('RC_AR_NOT_FOUND', `应收单 ${a.ar_id} 不存在`, 404)
        if (ar.status === 'voided') {
          throw new ArError('RC_AR_VOIDED', `应收单 ${ar.doc_no} 已作废，不能核销`, 409)
        }
        if (ar.subject_type !== subjectType || Number(ar.subject_id) !== Number(subjectId)) {
          throw new ArError('RC_SUBJECT_MISMATCH', '核销的应收单与该收款单不是同一往来对象', 409)
        }
        const want = money(Number(a.amount) || 0)
        const openOfAr = money(ar.amount - ar.allocated_amount)
        // ⚠️ 原来这里是 `Math.min(want, openOfAr)` —— **截平而不是拒绝**。
        // 截平的后果：用户填了 600、系统悄悄按 400 核销，收款单与应收单都不报错，
        // 而"我明明核了 600"这句话在库里找不到任何痕迹。宁可拒绝并让他改。
        if (want > openOfAr + 0.005) {
          throw new ArError(
            'RC_ALLOC_EXCEEDS_AR',
            `应收单 ${ar.doc_no} 未核销余额只有 ${openOfAr}，本次要核销 ${want}`,
            409,
            { ar_id: arId, open: openOfAr, want }
          )
        }
        // 收款单本身的钱也要够：一张 500 的收款单不能分摊出 1200（实测就是这样超收 700 的）
        if (want > left + 0.005) {
          throw new ArError(
            'RC_ALLOC_EXCEEDS_RECEIPT',
            `收款单金额 ${amt} 的剩余可分摊额只有 ${money(left)}，本次要分摊 ${want}`,
            409,
            { receiptAmount: amt, remaining: money(left), want }
          )
        }
        if (want > 0.005) {
          insAlloc.run(rid, ar.id, want)
          plan.push({ ar_id: ar.id, amount: want })
          left = money(left - want)
        }
      }
    } else {
      for (const ar of open) {
        if (left <= 0.005) break
        const can = money(Math.min(left, ar.amount - ar.allocated_amount))
        if (can <= 0.005) continue
        insAlloc.run(rid, ar.id, can)
        plan.push({ ar_id: ar.id, amount: can })
        left = money(left - can)
      }
    }
    const allocated = money(amt - left)
    db.prepare('UPDATE receipts SET allocated_amount=? WHERE id=?').run(allocated, rid)
    return { id: rid, doc_no: docNo, allocated_amount: allocated, unallocated: money(left), plan }
  })
  return tx()
}

/**
 * 确认收款：核销生效 + 释放授信。
 * 这是本模块唯一「有后果」的动作 —— 草稿阶段的一切都还是计划。
 */
export function confirmReceipt(db, { id, actor = null, releaseCredit = true, sourceType = 'SO' } = {}) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
  if (!r) throw new ArError('RC_NOT_FOUND', '收款单不存在', 404)
  if (r.status !== 'draft') throw new ArError('RC_NOT_DRAFT', `当前状态「${r.status}」不能确认`, 409)

  // ---------------------------------------------------------------------------
  // 确认前的硬校验（A07）：草稿阶段的"计划核销"不算数，所以两张草稿可以
  // **各自合法地**答应核销同一张应收 —— 真正冲突的是**确认的那一刻**。
  // 实测：AR 100 → 两张草稿各分配 80 → 依次确认都 200 ⇒ 已确认明细合计 160（超 60）。
  // 所以把判据放在这里：过不去就不许确认，而不是"先记下、后面裁剪显示"。
  // ---------------------------------------------------------------------------
  const allocsNow = db.prepare('SELECT * FROM receipt_allocations WHERE receipt_id=?').all(id)
  const confirmedSum = db.prepare(
    `SELECT COALESCE(SUM(a.amount),0) s FROM receipt_allocations a
      JOIN receipts rc ON rc.id=a.receipt_id
     WHERE a.ar_id=? AND rc.status='confirmed'`
  )
  let allocTotal = 0
  for (const a of allocsNow) {
    const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
    if (!ar) throw new ArError('RC_AR_NOT_FOUND', `应收单 #${a.ar_id} 不存在`, 404)
    // 作废的应收不能再被核销（原来只在**建单时**判，而建单之后应收可能被作废）
    if (ar.status === 'voided') {
      throw new ArError('RC_AR_VOIDED', `应收单 ${ar.doc_no} 已作废，不能核销`, 409, { ar_id: ar.id })
    }
    const already = money(confirmedSum.get(a.ar_id).s)
    if (already + money(a.amount) > money(ar.amount) + 0.005) {
      throw new ArError(
        'AR_OVER_ALLOCATED',
        `应收单 ${ar.doc_no} 金额 ${money(ar.amount)}，已确认核销 ${already}，本次再核 ${money(a.amount)} 会超应收`,
        409,
        { ar_id: ar.id, arAmount: money(ar.amount), confirmed: already, thisTime: money(a.amount) }
      )
    }
    allocTotal = money(allocTotal + money(a.amount))
  }
  if (allocTotal > money(r.amount) + 0.005) {
    throw new ArError(
      'RC_OVER_ALLOCATED',
      `收款单金额 ${money(r.amount)}，核销明细合计 ${allocTotal}，不能超收`,
      409,
      { receiptAmount: money(r.amount), allocTotal }
    )
  }

  const tx = db.transaction(() => {
    applyTransition({ db, 
      docType: 'RCP',
      id,
      action: 'confirm',
      actor,
      source: 'api',
      remark: '确认收款，核销生效'
    })
    db.prepare(
      `UPDATE receipts SET status='confirmed', confirmed_by=?, confirmed_by_name=?, confirmed_at=?, updated_at=? WHERE id=?`
    ).run(actor?.id || null, actor?.name || null, nowText(), nowText(), id)

    const allocs = db.prepare('SELECT * FROM receipt_allocations WHERE receipt_id=?').all(id)
    // 重算应收状态，并**如实留痕**：「谁触发了这次重算」（确认收款）+ 重算后的真实状态。
    // 见 `traceRecalc` 的说明 —— 记 `from:null` 而不是假装一次边流转（收款确认后应收
    // `open→partial/closed` 虽然确实是内核的 `allocate` 边，但重算的**方向可以相反**
    // （作废收款），两条路用同一种记法才不会被读成"一次流转"）。
    for (const a of allocs) {
      const before = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
      const after = recalcAr(db, a.ar_id)
      traceRecalc(db, {
        before,
        after,
        trigger: 'confirmReceipt',
        actor,
        payload: { receipt_id: id, receipt_doc_no: r.doc_no, allocation_amount: money(a.amount) }
      })
    }

    if (releaseCredit) {
      // 释放授信：只有确认收款才释放（口径见文件头 ②）
      //
      // ⚠️ A06：**占用在哪里，释放就在哪里。**
      // 授信占用是在「订单确认」那一刻按 `sourceType='SO'` 写进台账的（sales.js / order-center）
      // 而这里原来按 `sourceType='RCP'` 去释放 —— 那张收款单名下从来没有占用过，
      // `openAmountOf(…,'RCP',id)` 恒为 0 ⇒ 一条释放流水都写不出来 ⇒
      // **额度只减不增**：客户还了钱，可用额度却不回来。
      // 所以释放必须按**这笔核销对应应收单的来源**（SO / OC / 或没有来源）分别走。
      const acc = db
        .prepare('SELECT id FROM credit_accounts WHERE subject_type=? AND subject_id=?')
        .get(r.subject_type, r.subject_id)
      if (acc) {
        // 没有来源的应收（例如按发票新建）仍然按收款单本身释放，保留旧口径不误伤
        let releasedByRcp = 0
        for (const a of db.prepare('SELECT * FROM receipt_allocations WHERE receipt_id=?').all(id)) {
          const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
          if (ar?.source_type === AR_SOURCE_OC && ar.source_id) continue // 订货中心在下面的循环里释放自己那本台账
          if (ar?.source_type && ar.source_id) {
            // SI invoice debt is part of its SO's credit obligation. Release only this
            // allocation amount; creditSettle additionally caps it at remaining hold.
            const creditSource = creditSourceOfAr(db, ar)
            creditSettle(db, {
              account: acc.id,
              amount: a.amount,
              ...creditSource,
              operator: actor,
              remark: `收款核销释放授信（对应 ${ar.doc_no}）`
            })
          } else {
            releasedByRcp += Number(a.amount || 0)
          }
        }
        if (releasedByRcp > 0.005) {
          creditSettle(db, {
            account: acc.id,
            amount: releasedByRcp,
            sourceType: 'RCP',
            sourceId: id,
            docNo: r.doc_no,
            operator: actor,
            remark: '收款核销释放授信（无来源应收）'
          })
        }
      }
    }
    // 顺带把关联销售订单的已收金额对齐（订单侧仍保留 paid_amount，用于旧界面与报表）
    for (const a of allocs) {
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
      if (ar?.source_type === 'SO' && ar.source_id) {
        db.prepare('UPDATE sales_orders SET paid_amount = ? WHERE id=?').run(ar.allocated_amount, ar.source_id)
      }
    }
    // 订货中心订单（模块 12A）：回款必须同步释放它那本台账上的占用，
    // 否则订货中心看到的可用额度永远不回来 —— 这是「同一个客户两个数字」的根源
    for (const a of allocs) {
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
      if (ar?.source_type === AR_SOURCE_OC && ar.source_id) {
        ocReleaseByOrder(db, {
          orderId: ar.source_id,
          amount: a.amount,
          changeType: 'repay',
          operator: actor?.name || null,
          remark: `回款核销释放（${ar.source_doc_no || ar.doc_no}）`
        })
      }
    }
    return db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
  })
  return tx()
}

/** 作废收款：核销失效并重算应收（作废本身不自动回收额度，避免静默改账） */
export function voidReceipt(db, { id, actor = null, reason = null } = {}) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
  if (!r) throw new ArError('RC_NOT_FOUND', '收款单不存在', 404)
  if (r.status === 'voided') throw new ArError('RC_ALREADY_VOID', '收款单已作废', 409)
  const tx = db.transaction(() => {
    applyTransition({ db, 
      docType: 'RCP',
      id,
      action: 'void',
      actor,
      source: 'api',
      remark: reason || '作废收款单'
    })
    db.prepare(`UPDATE receipts SET status='voided', updated_at=? WHERE id=?`).run(nowText(), id)
    for (const a of db.prepare('SELECT ar_id FROM receipt_allocations WHERE receipt_id=?').all(id)) {
      const before = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
      const after = recalcAr(db, a.ar_id)
      // 同 `confirmReceipt`：记「谁触发了这次重算」。这里的方向常常是**回退**
      // （closed → partial / partial → open），内核没有这条反向边 —— 所以更要把 `from` 留空。
      traceRecalc(db, {
        before,
        after,
        trigger: 'voidReceipt',
        actor,
        payload: { receipt_id: id, receipt_doc_no: r.doc_no, reason: reason || null }
      })
    }
    // 订单侧已收金额跟着回退（核销失效了，订单就不能再显示已收）
    // 这里必须读核销明细的原始金额：recalcAr 之后 ar.allocated_amount 已经是新的余额，
    // 用它去回退订单会算错（作废不掉、或回退过头）
    for (const a of db.prepare('SELECT ar_id, amount FROM receipt_allocations WHERE receipt_id=?').all(id)) {
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(a.ar_id)
      if (ar?.source_type === 'SO' && ar.source_id) {
        db.prepare('UPDATE sales_orders SET paid_amount=? WHERE id=?').run(ar.allocated_amount, ar.source_id)
      }
      // 订货中心：作废收款 = 账又欠回去了，额度要占回来（不占回来等于白送授信）
      if (ar?.source_type === AR_SOURCE_OC && ar.source_id) {
        ocReoccupyByOrder(db, {
          orderId: ar.source_id,
          amount: a.amount,
          operator: actor?.name || null,
          remark: `核销作废恢复占用（${ar.source_doc_no || ar.doc_no}）`
        })
      }
    }
    return db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
  })
  return tx()
}

export function getReceipt(db, id) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(id)
  if (!r) return null
  const allocs = db
    .prepare(
      `SELECT a.*, d.doc_no AS ar_no, d.source_doc_no, d.due_date, d.amount AS ar_amount
       FROM receipt_allocations a JOIN ar_documents d ON d.id=a.ar_id
       WHERE a.receipt_id=? ORDER BY a.id`
    )
    .all(id)
  return { ...r, allocations: allocs }
}

export function listReceipts(db, q = {}) {
  const where = []
  const args = []
  if (q.subjectType && q.subjectId) {
    where.push('subject_type=? AND subject_id=?')
    args.push(q.subjectType, q.subjectId)
  }
  if (q.status) {
    where.push('status=?')
    args.push(q.status)
  }
  if (q.keyword) {
    where.push('(doc_no LIKE ? OR IFNULL(subject_name,?) LIKE ? OR IFNULL(serial_no,?) LIKE ?)')
    args.push(`%${q.keyword}%`, q.keyword, `%${q.keyword}%`, q.keyword, `%${q.keyword}%`)
  }
  const pageSize = Number(q.pageSize) || 20
  const page = Number(q.page) || 1
  const rows = db
    .prepare(
      `SELECT * FROM receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
       ORDER BY id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  const total = db
    .prepare(`SELECT COUNT(*) AS c FROM receipts ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`)
    .get(...args).c
  return { rows, total, page, pageSize }
}

// ---------------------------------------------------------------------------
// 账龄与对账
// ---------------------------------------------------------------------------

/** 账龄分桶：0-30 / 31-60 / 61-90 / 90+，按未结清余额计 */
export function aging(db, q = {}) {
  const where = ["status IN ('open','partial')"]
  const args = []
  if (q.subjectType && q.subjectId) {
    where.push('subject_type=? AND subject_id=?')
    args.push(q.subjectType, q.subjectId)
  }
  const rows = db
    .prepare(
      `SELECT * FROM ar_documents ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_date`
    )
    .all(...args)
  // 「今天」必须与视图里的 `date('now','localtime')` 同源，否则逐笔逾期合计 ≠ 汇总逾期
  const today = localDate()
  const buckets = { b0: 0, b1: 0, b2: 0, b3: 0 }
  let overdueTotal = 0
  for (const r of rows) {
    const bal = money(r.amount - r.allocated_amount)
    if (bal <= 0.005) continue
    const days = overdueDaysOf(r, today)
    if (days <= 0) buckets.b0 += bal
    else if (days <= 30) buckets.b1 += bal
    else if (days <= 60) buckets.b2 += bal
    else buckets.b3 += bal
    if (days > 0) overdueTotal += bal
  }
  for (const k of Object.keys(buckets)) buckets[k] = money(buckets[k])
  return { buckets, total_outstanding: money(buckets.b0 + buckets.b1 + buckets.b2 + buckets.b3), overdue: money(overdueTotal), count: rows.length }
}

/** 按客户汇总账龄（风险榜用）—— 同主体归并（S-8）后再汇总 */
export function agingBySubject(db) {
  const rows = db
    .prepare(
      `SELECT subject_type, subject_id, IFNULL(subject_name,'') AS subject_name,
              amount - allocated_amount AS balance, due_date
       FROM ar_documents WHERE status IN ('open','partial')`
    )
    .all()
  // 「今天」与 v_ar_aging_detail 视图同源（原实现用 SQL 的 date('now','localtime')，等价）
  const today = localDate()
  const map = ocSubjectMap(db)
  const agg = new Map()
  for (const r of rows) {
    const bal = money(r.balance)
    if (bal <= 0.005) continue
    const c = canonicalSubject(map, r.subject_type, r.subject_id)
    const k = `${c.subject_type}:${c.subject_id}`
    const cur =
      agg.get(k) ||
      { subject_type: c.subject_type, subject_id: c.subject_id, subject_name: '', balance: 0, overdue_amount: 0, earliest_due: null, ar_count: 0 }
    if (!cur.subject_name) cur.subject_name = r.subject_name
    cur.balance = money(cur.balance + bal)
    cur.ar_count += 1
    if (r.due_date && (!cur.earliest_due || r.due_date < cur.earliest_due)) cur.earliest_due = r.due_date
    if (r.due_date && r.due_date < today) cur.overdue_amount = money(cur.overdue_amount + bal)
    agg.set(k, cur)
  }
  return [...agg.values()]
    .filter((r) => r.balance > 0.005)
    .sort((a, b) => b.overdue_amount - a.overdue_amount || b.balance - a.balance)
}

/**
 * 客户对账单：期初 + 本期应收 + 本期收款 − 本期核销 = 期末。
 * 「期末余额」必须能由明细重算出来 —— 这是付款侧定下的同一条原则。
 *
 * S-8：往来对象是**归并后的主体**。同一个经销商的订货中心应收（`oc`）也要列进来，
 * 否则对账单少列（实测 63,666.10 + 13,253.10 只返 63,666.10）。合并后的行仍带
 * `source_type/source_doc_no`，能逐笔追回原单。
 */
export function statement(db, { subjectType, subjectId, from = null, to = null } = {}) {
  if (!subjectType || !subjectId) throw new ArError('STMT_SUBJECT_REQUIRED', '对账单必须指定往来对象', 400)
  const group = subjectsOf(db, subjectType, subjectId)
  const map = ocSubjectMap(db)
  const canon = (r) => ({ ...r, ...canonicalSubject(map, r.subject_type, r.subject_id) })

  const arWhere = [subjectWhere(group)]
  const arArgs = subjectWhereArgs(group)
  if (from) {
    arWhere.push('biz_date >= ?')
    arArgs.push(from)
  }
  if (to) {
    arWhere.push('biz_date <= ?')
    arArgs.push(to)
  }
  const ars = db
    .prepare(`SELECT * FROM ar_documents WHERE ${arWhere.join(' AND ')} ORDER BY biz_date, id`)
    .all(...arArgs)
    .map(canon)

  const rcWhere = [subjectWhere(group), "status='confirmed'"]
  const rcArgs = subjectWhereArgs(group)
  if (from) {
    rcWhere.push('receipt_date >= ?')
    rcArgs.push(from)
  }
  if (to) {
    rcWhere.push('receipt_date <= ?')
    rcArgs.push(to)
  }
  const rcs = db
    .prepare(`SELECT * FROM receipts WHERE ${rcWhere.join(' AND ')} ORDER BY receipt_date, id`)
    .all(...rcArgs)
    .map(canon)

  const allocs = db
    .prepare(
      `SELECT a.*, r.doc_no AS receipt_no, r.receipt_date, r.status
       FROM receipt_allocations a
       JOIN receipts r ON r.id=a.receipt_id
       JOIN ar_documents d ON d.id=a.ar_id
       WHERE ${subjectWhere(group, 'd.')} AND r.status='confirmed'
       ORDER BY r.receipt_date, a.id`
    )
    .all(...subjectWhereArgs(group))

  const arTotal = money(ars.reduce((s, r) => s + r.amount, 0))
  const rcTotal = money(rcs.reduce((s, r) => s + r.amount, 0))
  const allocTotal = money(allocs.reduce((s, a) => s + a.amount, 0))
  const name = ars[0]?.subject_name || rcs[0]?.subject_name || ''
  return {
    subject_type: subjectType,
    subject_id: subjectId,
    subject_name: name,
    from,
    to,
    ar_total: arTotal,
    receipt_total: rcTotal,
    allocated_total: allocTotal,
    balance: money(arTotal - allocTotal),
    unallocated_receipt: money(rcTotal - allocTotal),
    ars,
    receipts: rcs,
    allocations: allocs
  }
}

export function arOverview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const total = one(`SELECT COUNT(*) c, IFNULL(SUM(amount),0) amt, IFNULL(SUM(allocated_amount),0) alloc FROM ar_documents`)
  const open = one(`SELECT COUNT(*) c, IFNULL(SUM(amount - allocated_amount),0) amt FROM ar_documents WHERE status IN ('open','partial')`)
  const overdue = one(
    `SELECT COUNT(*) c, IFNULL(SUM(amount - allocated_amount),0) amt FROM ar_documents
     WHERE status IN ('open','partial') AND due_date < date('now','localtime')`
  )
  const rc = one(`SELECT COUNT(*) c, IFNULL(SUM(amount),0) amt FROM receipts WHERE status='confirmed'`)
  const draftRc = one(`SELECT COUNT(*) c, IFNULL(SUM(amount),0) amt FROM receipts WHERE status='draft'`)
  const ag = aging(db)
  return {
    ar_count: total?.c || 0,
    ar_amount: money(total?.amt || 0),
    ar_allocated: money(total?.alloc || 0),
    open_count: open?.c || 0,
    open_amount: money(open?.amt || 0),
    overdue_count: overdue?.c || 0,
    overdue_amount: money(overdue?.amt || 0),
    receipt_count: rc?.c || 0,
    receipt_amount: money(rc?.amt || 0),
    draft_receipt_count: draftRc?.c || 0,
    draft_receipt_amount: money(draftRc?.amt || 0),
    aging: ag
  }
}

/** 对账：明细 SUM 必须等于单据上的金额，任何漂移都要能被抓出来 */
export function auditAr(db) {
  const drift = db
    .prepare(
      `SELECT d.id, d.doc_no, d.amount, d.allocated_amount,
              IFNULL((SELECT SUM(a.amount) FROM receipt_allocations a
                      JOIN receipts r ON r.id=a.receipt_id
                      WHERE a.ar_id=d.id AND r.status='confirmed'),0) AS detail
       FROM ar_documents d`
    )
    .all()
    .filter((r) => Math.abs(money(r.detail) - r.allocated_amount) > 0.01)
  const badStatus = db
    .prepare(
      `SELECT id, doc_no, status, amount, allocated_amount FROM ar_documents
       WHERE status='closed' AND allocated_amount < amount - 0.01
          OR status='open' AND allocated_amount > 0.01
          OR status='partial' AND (allocated_amount <= 0.01 OR allocated_amount >= amount - 0.01)`
    )
    .all()
  const overAlloc = db
    .prepare(
      `SELECT d.id, d.doc_no FROM ar_documents d
       WHERE d.allocated_amount > d.amount + 0.01`
    )
    .all()
  const rcDrift = db
    .prepare(
      `SELECT r.id, r.doc_no, r.allocated_amount,
              IFNULL((SELECT SUM(amount) FROM receipt_allocations WHERE receipt_id=r.id),0) AS detail
       FROM receipts r`
    )
    .all()
    .filter((r) => Math.abs(money(r.detail) - r.allocated_amount) > 0.01)
  return { drift, badStatus, overAlloc, rcDrift, ok: !drift.length && !badStatus.length && !overAlloc.length && !rcDrift.length }
}

// ---------------------------------------------------------------------------
// 第二阶段：逐笔账龄 / 预收 / 订货中心并入
//
// 019 只做到「汇总」，回答不了三个现场问题：
//   · 这张单逾期几天了？（逐笔账龄）
//   · 客户多付的钱算什么？（预收）
//   · 订货中心的欠款为什么不在应收里？（OC 并入）
// 三个问题的口径全部下沉到 020 迁移建的视图，JS 侧只做筛选与组装，
// 保证「界面看到的数」与「库里能算的数」永远同源。
// ---------------------------------------------------------------------------

export const AGING_BUCKET_LABEL = {
  b0: '未到期',
  b1: '逾期 1-30 天',
  b2: '逾期 31-60 天',
  b3: '逾期 60 天以上',
  settled: '已结清'
}

/** 逐笔账龄：一行 = 一张应收单，带余额、逾期天数、账龄桶 */
export function agingDetail(db, q = {}) {
  const where = []
  const args = []
  if (q.subjectType && q.subjectId) {
    // S-8：问一个主体的逐笔账龄，也要把订货中心并入的那套（oc）算进来
    const group = subjectsOf(db, q.subjectType, q.subjectId)
    where.push(subjectWhere(group))
    args.push(...subjectWhereArgs(group))
  }
  if (q.sourceType) {
    where.push('source_type=?')
    args.push(q.sourceType)
  }
  if (q.bucket && q.bucket !== 'all') {
    if (q.bucket === 'settled') {
      where.push("status NOT IN ('open','partial')")
    } else {
      where.push('bucket=?')
      where.push("status IN ('open','partial')")
      args.push(q.bucket)
    }
  } else if (!q.includeSettled) {
    where.push("status IN ('open','partial')")
  }
  if (q.keyword) {
    where.push('(doc_no LIKE ? OR source_doc_no LIKE ? OR subject_name LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k, k)
  }
  const sql = `SELECT * FROM v_ar_aging_detail
               ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
               ORDER BY overdue_days DESC, due_date, id`
  const map = ocSubjectMap(db)
  const rows = db
    .prepare(sql)
    .all(...args)
    .map((r) => ({ ...r, ...canonicalSubject(map, r.subject_type, r.subject_id), open_amount: money(r.open_amount) }))

  const summary = { b0: 0, b1: 0, b2: 0, b3: 0, settled: 0 }
  let totalOpen = 0
  let totalOverdue = 0
  for (const r of rows) {
    const k = summary[r.bucket] === undefined ? 'b0' : r.bucket
    summary[k] = money(summary[k] + Number(r.open_amount || 0))
    if (r.status === 'open' || r.status === 'partial') {
      totalOpen = money(totalOpen + Number(r.open_amount || 0))
      if (r.overdue_days > 0) totalOverdue = money(totalOverdue + Number(r.open_amount || 0))
    }
  }
  return { rows, summary, total_open: totalOpen, total_overdue: totalOverdue, count: rows.length }
}

/** 按客户汇总的逐笔账龄风险榜（含最老一笔）—— 同主体归并（S-8）后再汇总 */
export function agingDetailBySubject(db) {
  const rows = db
    .prepare(
      `SELECT subject_type, subject_id, subject_name, status, open_amount, overdue_days, due_date
       FROM v_ar_aging_detail`
    )
    .all()
  const map = ocSubjectMap(db)
  const agg = new Map()
  for (const r of rows) {
    const c = canonicalSubject(map, r.subject_type, r.subject_id)
    const k = `${c.subject_type}:${c.subject_id}`
    const cur =
      agg.get(k) ||
      { subject_type: c.subject_type, subject_id: c.subject_id, subject_name: r.subject_name, ar_count: 0, balance: 0, overdue_amount: 0, max_overdue_days: 0, earliest_due: null }
    if (!cur.subject_name) cur.subject_name = r.subject_name
    cur.ar_count += 1
    const open = Number(r.open_amount || 0)
    if (r.status === 'open' || r.status === 'partial') {
      cur.balance = money(cur.balance + open)
      if (!cur.earliest_due || (r.due_date && r.due_date < cur.earliest_due)) cur.earliest_due = r.due_date || cur.earliest_due
    }
    if (Number(r.overdue_days) > 0) {
      cur.overdue_amount = money(cur.overdue_amount + open)
      cur.max_overdue_days = Math.max(cur.max_overdue_days, Number(r.overdue_days) || 0)
    }
    agg.set(k, cur)
  }
  return [...agg.values()]
    .filter((r) => r.balance > 0.005)
    .sort((a, b) => b.overdue_amount - a.overdue_amount || b.balance - a.balance)
}

/** 预收余额清单（按主体）：客户存在我这儿的钱 */
export function prepayList(db, q = {}) {
  const where = []
  const args = []
  if (q.subjectType && q.subjectId) {
    where.push('subject_type=? AND subject_id=?')
    args.push(q.subjectType, q.subjectId)
  }
  if (q.keyword) {
    where.push('subject_name LIKE ?')
    args.push(`%${q.keyword}%`)
  }
  const rows = db
    .prepare(`SELECT * FROM v_ar_prepay ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY prepay_balance DESC`)
    .all(...args)
    .map((r) => ({
      ...r,
      received_amount: money(r.received_amount),
      allocated_amount: money(r.allocated_amount),
      prepay_balance: money(r.prepay_balance)
    }))
  return { rows, total: money(rows.reduce((s, r) => s + r.prepay_balance, 0)), count: rows.length }
}

/** 某主体的预收明细：哪几张收款单还剩多少没抵，以及有哪些未结应收可以抵 */
export function prepayDetail(db, { subjectType, subjectId } = {}) {
  if (!subjectType || !subjectId) throw new ArError('PREPAY_SUBJECT_REQUIRED', '预收明细必须指定往来对象', 400)
  const leftovers = db
    .prepare(
      `SELECT r.id, r.doc_no, r.receipt_date, r.method, r.amount,
              IFNULL((SELECT SUM(a.amount) FROM receipt_allocations a WHERE a.receipt_id=r.id),0) AS allocated
       FROM receipts r
       WHERE r.subject_type=? AND r.subject_id=? AND r.status='confirmed'
       ORDER BY r.receipt_date, r.id`
    )
    .all(subjectType, subjectId)
    .map((r) => ({
      ...r,
      amount: money(r.amount),
      allocated: money(r.allocated),
      left_amount: money(money(r.amount) - money(r.allocated))
    }))
    .filter((r) => r.left_amount > 0.005)

  const openArs = db
    .prepare(
      `SELECT id, doc_no, source_doc_no, due_date, ROUND(amount - allocated_amount, 2) AS open_amount
       FROM ar_documents WHERE subject_type=? AND subject_id=? AND status IN ('open','partial')
       ORDER BY due_date, id`
    )
    .all(subjectType, subjectId)
    .map((r) => ({ ...r, open_amount: money(r.open_amount) }))

  return {
    receipts: leftovers,
    open_ars: openArs,
    prepay_total: money(leftovers.reduce((s, r) => s + r.left_amount, 0)),
    open_total: money(openArs.reduce((s, r) => s + r.open_amount, 0))
  }
}

/**
 * 预收转应收：把某张已确认收款单的未抵余额分摊到应收单。
 * 不指定 arId 时传 auto=true，按到期日 FIFO 自动抵扣（最老的一笔先抵）。
 * 与 createReceipt 的区别：那是在「钱刚到」时计划怎么抵；这里是「钱早到了、
 * 账后来才生出来」—— 订货中心并入、发票补开都会遇到这种情况。
 */
export function applyPrepay(db, { receiptId, arId = null, amount = null, auto = false, actor = null } = {}) {
  const r = db.prepare('SELECT * FROM receipts WHERE id=?').get(receiptId)
  if (!r) throw new ArError('RC_NOT_FOUND', '收款单不存在', 404)
  if (r.status !== 'confirmed') throw new ArError('RC_NOT_CONFIRMED', '只有已确认的收款单才有预收余额', 409)

  const tx = db.transaction(() => {
    const used = money(db.prepare('SELECT COALESCE(SUM(amount),0) s FROM receipt_allocations WHERE receipt_id=?').get(receiptId).s)
    let left = money(money(r.amount) - used)
    if (left <= 0.005) throw new ArError('PREPAY_EMPTY', '该收款单已全部核销，没有可用的预收余额', 409)

    const plan = []
    if (arId) {
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(arId)
      if (!ar) throw new ArError('AR_NOT_FOUND', `应收单 ${arId} 不存在`, 404)
      if (ar.subject_type !== r.subject_type || Number(ar.subject_id) !== Number(r.subject_id)) {
        throw new ArError('PREPAY_SUBJECT_MISMATCH', '预收与应收不是同一往来对象', 409)
      }
      if (ar.status === 'voided') throw new ArError('AR_VOIDED', '应收单已作废，不能抵扣', 409)
      const want = amount == null ? left : money(Math.min(Number(amount) || 0, left))
      const can = money(Math.min(want, money(money(ar.amount) - money(ar.allocated_amount))))
      if (can <= 0.005) throw new ArError('PREPAY_NOTHING', '该应收单已结清，或预收余额不足以抵扣', 409)
      plan.push({ ar_id: ar.id, amount: can })
    } else if (auto) {
      const open = db
        .prepare(
          `SELECT * FROM ar_documents WHERE subject_type=? AND subject_id=? AND status IN ('open','partial')
           ORDER BY due_date, id`
        )
        .all(r.subject_type, r.subject_id)
      for (const ar of open) {
        if (left <= 0.005) break
        const can = money(Math.min(left, money(money(ar.amount) - money(ar.allocated_amount))))
        if (can <= 0.005) continue
        plan.push({ ar_id: ar.id, amount: can })
        left = money(left - can)
      }
      if (!plan.length) throw new ArError('PREPAY_NO_TARGET', '该客户没有未结清的应收单可抵', 409)
    } else {
      throw new ArError('PREPAY_TARGET_REQUIRED', '请指定要抵的应收单，或传 auto=true 按账龄自动抵扣', 400)
    }

    // 同一张收款单可能对同一应收单分多次抵，用累加而不是覆盖
    const ins = db.prepare(
      `INSERT INTO receipt_allocations (receipt_id, ar_id, amount) VALUES (?,?,?)
       ON CONFLICT(receipt_id, ar_id) DO UPDATE SET amount = ROUND(receipt_allocations.amount + excluded.amount, 2)`
    )
    for (const p of plan) ins.run(receiptId, p.ar_id, p.amount)

    const allocTotal = money(
      db.prepare('SELECT COALESCE(SUM(amount),0) s FROM receipt_allocations WHERE receipt_id=?').get(receiptId).s
    )
    db.prepare('UPDATE receipts SET allocated_amount=?, updated_at=? WHERE id=?').run(allocTotal, nowText(), receiptId)
    for (const p of plan) recalcAr(db, p.ar_id)

    // 抵账同样要放授信 / 回写订单已收 —— 与确认收款走同一套口径
    for (const p of plan) {
      const ar = db.prepare('SELECT * FROM ar_documents WHERE id=?').get(p.ar_id)
      if (ar?.source_type === AR_SOURCE_OC && ar.source_id) {
        ocReleaseByOrder(db, {
          orderId: ar.source_id,
          amount: p.amount,
          changeType: 'repay',
          operator: actor?.name || null,
          remark: `预收抵账释放（${ar.source_doc_no || ar.doc_no}）`
        })
      }
      if (ar?.source_type === 'SO' && ar.source_id) {
        db.prepare('UPDATE sales_orders SET paid_amount=? WHERE id=?').run(ar.allocated_amount, ar.source_id)
      }
    }

    return {
      receipt: db.prepare('SELECT * FROM receipts WHERE id=?').get(receiptId),
      plan,
      applied: money(plan.reduce((s, p) => s + p.amount, 0)),
      remaining: money(money(r.amount) - allocTotal)
    }
  })
  return tx()
}

/** 订货中心待并入应收的订单（口径视图 v_oc_ar_pending） */
export function pendingOcAr(db, q = {}) {
  const where = []
  const args = []
  if (q.customerId) {
    where.push('customer_id=?')
    args.push(q.customerId)
  }
  if (q.keyword) {
    where.push('(doc_no LIKE ? OR customer_name LIKE ?)')
    args.push(`%${q.keyword}%`, `%${q.keyword}%`)
  }
  const rows = db
    .prepare(`SELECT * FROM v_oc_ar_pending ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY order_date DESC, id DESC`)
    .all(...args)
    .map((r) => ({ ...r, total_amount: money(r.total_amount) }))
  return { rows, total: money(rows.reduce((s, r) => s + r.total_amount, 0)), count: rows.length }
}

/** 单张订货单生成应收（幂等：ensureAr 按 source_type + source_id 去重） */
export function ensureOcAr(db, order, actor = null) {
  if (!order) throw new ArError('OC_ORDER_REQUIRED', '必须提供订货单', 400)
  const cust = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(order.customer_id)
  return ensureAr(db, {
    subjectType: 'oc',
    subjectId: order.customer_id,
    subjectName: order.customer_name || cust?.name || null,
    sourceType: AR_SOURCE_OC,
    sourceId: order.id,
    sourceDocNo: order.doc_no,
    bizDate: order.order_date,
    amount: order.total_amount,
    creditDays: cust?.credit_days || 0,
    remark: '订货中心并入应收',
    actor
  })
}

/** 批量并入：把「已收货但没生成应收」的订货单补齐（幂等，可重复跑） */
export function syncOcAr(db, { actor = null, limit = 500, customerId = null } = {}) {
  const rows = customerId
    ? db.prepare('SELECT id FROM v_oc_ar_pending WHERE customer_id=? ORDER BY order_date, id LIMIT ?').all(customerId, limit)
    : db.prepare('SELECT id FROM v_oc_ar_pending ORDER BY order_date, id LIMIT ?').all(limit)
  const created = []
  const tx = db.transaction(() => {
    for (const row of rows) {
      const full = db.prepare('SELECT * FROM oc_orders WHERE id=?').get(row.id)
      if (!full) continue
      const ar = ensureOcAr(db, full, actor)
      created.push({ order_id: full.id, order_no: full.doc_no, ar_id: ar.id, ar_no: ar.doc_no, amount: money(ar.amount) })
    }
  })
  tx()
  return { created, count: created.length, total_amount: money(created.reduce((s, c) => s + c.amount, 0)) }
}

export default {
  ensureAr,
  arOfOrder,
  recalcAr,
  recalcArBySubject,
  offsetAr,
  listAr,
  getAr,
  createReceipt,
  confirmReceipt,
  voidReceipt,
  getReceipt,
  listReceipts,
  aging,
  agingBySubject,
  agingDetail,
  agingDetailBySubject,
  prepayList,
  prepayDetail,
  applyPrepay,
  pendingOcAr,
  ensureOcAr,
  syncOcAr,
  statement,
  arOverview,
  auditAr,
  dueDateOf,
  overdueDaysOf,
  AR_STATUS_LABEL,
  RC_STATUS_LABEL,
  PAY_METHOD_LABEL,
  AGING_BUCKET_LABEL,
  AR_SOURCE_SO,
  AR_SOURCE_OC,
  AR_SOURCE_SI,
  AR_SOURCE_MANUAL
}
