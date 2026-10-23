/**
 * ============================================================================
 * 文件标识：server/lib/funds-review.js ｜ 收付款的证据闸与二人复核（maker-checker）—— 唯一实现（ADR-0018）
 * ============================================================================
 * 【职责】给"真正动钱"的两个动作 —— 收款单确认（`ar.confirmReceipt`）与付款单执行付款
 *   （`purchase.transitionPayment` 的 `pay`）—— 套同一道门：
 *     ① 证据：确认时必须带银行流水号 / 凭证号（`evidence_ref`），由 `funds_evidence_required` 控制；
 *     ② 二人复核：金额 ≥ `funds_review_threshold` 且 `funds_review_required` 打开时，发起人 A 的确认只把单据
 *        挂成「待复核」（`review_status='pending_review'`，**内核状态、应收、授信、结算单一分不动**），
 *        由另一人 B（持 `finance.funds.review`）批准后，在**同一个事务**里执行原来的确认逻辑；驳回退回原状态。
 *   本文件**不**重写任何确认逻辑：原确认函数由调用方以 `apply` 回调传进来，这里只决定"现在执行 / 挂起 / 拒绝"，
 *   并在同一事务里写严格审计（`auditStrictRow`，审计写不进去整笔回滚）。
 *
 * 【为什么是独立列而不是内核状态】单据内核（008）已执行且受迁移校验和保护，不能改；"待复核"也不是一次有后果的
 *   流转 —— 它是"确认动作被挂起"。所以用 `review_status` 列承载，内核 `status` 保持 ready 态
 *   （收款单 `draft` / 付款单 `approved`）。待复核期间任何其它动作（再次确认 / 作废）一律 409 `FUNDS_REVIEW_PENDING`。
 *
 * 【改它要注意什么】
 *   · 判据只有这里一份：阈值比较、证据必填、自审拒绝，路由层不得再抄一遍。
 *   · `actor.id` 是自审判据的依据；HTTP 路由必须传真实用户 id。两边 id 都缺时按名字比较（只为脚本 / 测试兜底）。
 *   · 新增一种单据类型 → 在 `KINDS` 加一行（表名 / ready 态 / 审计 module+entity），不要在路由里拼表名。
 * ============================================================================
 */
import { auditStrictRow } from './audit-trail.js'
import { readSetting } from './settings.js'
import { localNow } from './dates.js'

export const FUNDS_REVIEW_PERM = 'finance.funds.review'

export class FundsError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // 与 ArError / PurchaseError 同一条：HTTP 层的 `failFromError` 只认 `.status`
    this.status = http
    this.detail = detail
  }
}

/** 复核状态字典（界面与 meta 接口同源） */
export const FUNDS_REVIEW_LABEL = {
  pending_review: '待复核',
  approved: '复核通过',
  rejected: '复核驳回'
}

/**
 * 两类单据的落点。`readyStatus` = "可以确认"的内核状态，也是驳回后单据所处的状态
 * （驳回不改内核状态，所以天然"退回原状态"）。
 */
export const KINDS = {
  receipt: { table: 'receipts', module: 'finance', entity: 'receipts', readyStatus: 'draft', label: '收款单' },
  payment: { table: 'purchase_payments', module: 'purchase', entity: 'purchase_payments', readyStatus: 'approved', label: '付款单' }
}

function kindOf(kind) {
  const k = KINDS[kind]
  if (!k) throw new FundsError('FUNDS_BAD_KIND', `不支持的资金单据类型「${kind}」`, 500)
  return k
}

/** 当前策略（三个键一次读齐；读取点只有这里） */
export function fundsPolicy(db) {
  return {
    evidence_required: readSetting(db, 'funds_evidence_required'),
    review_required: readSetting(db, 'funds_review_required'),
    review_threshold: Number(readSetting(db, 'funds_review_threshold')) || 0
  }
}

/** 这笔金额要不要第二人复核（阈值判据的唯一出处；0 = 每笔都复核） */
export function needsReview(policy, amount) {
  if (!policy.review_required) return false
  return Number(amount || 0) + 1e-9 >= Number(policy.review_threshold || 0)
}

/** 行上的复核信息 → 响应里的 `review` 块（形状固定，没有发起过复核也返回同一形状） */
export function reviewOf(row) {
  if (!row) return null
  return {
    status: row.review_status || null,
    maker: row.review_maker_id || row.review_maker_name
      ? { id: row.review_maker_id ?? null, name: row.review_maker_name ?? null, at: row.review_requested_at ?? null }
      : null,
    checker: row.review_checker_id || row.review_checker_name
      ? { id: row.review_checker_id ?? null, name: row.review_checker_name ?? null }
      : null,
    decided_at: row.review_decided_at ?? null,
    comment: row.review_comment ?? null,
    evidence_ref: row.evidence_ref ?? null,
    evidence_note: row.evidence_note ?? null
  }
}

function loadRow(db, k, id) {
  const row = db.prepare(`SELECT * FROM ${k.table} WHERE id=?`).get(id)
  if (!row) throw new FundsError('FUNDS_DOC_NOT_FOUND', `${k.label} #${id} 不存在`, 404)
  return row
}

const trimOrNull = (v) => {
  const s = v === null || v === undefined ? '' : String(v).trim()
  return s ? s : null
}

const sameActor = (a, b) => {
  if (a.id !== null && a.id !== undefined && b.id !== null && b.id !== undefined) return String(a.id) === String(b.id)
  return !!a.name && !!b.name && String(a.name) === String(b.name)
}

function auditRow(actor, { action, k, id, detail }) {
  return {
    userId: actor?.id ?? null,
    userName: actor?.name || 'anonymous',
    action,
    module: k.module,
    entity: k.entity,
    entityId: id,
    detail,
    ip: actor?.ip ?? null
  }
}

/** 待复核期间别的动作一律拒绝（作废 / 再次确认都走这一道） */
export function assertNotPending(db, kind, id) {
  const k = kindOf(kind)
  const row = loadRow(db, k, id)
  if (row.review_status === 'pending_review') {
    throw new FundsError(
      'FUNDS_REVIEW_PENDING',
      `${k.label} ${row.doc_no} 正在等待第二人复核，复核通过或驳回前不能再做其它操作`,
      409, { kind, id, review: reviewOf(row) }
    )
  }
  return row
}

/**
 * 发起确认（maker 一侧）。
 *
 * @param apply  `(db) => result` —— 原来的确认逻辑（confirmReceipt / transitionPayment pay）。
 *               只在"直接生效"时被调用；挂起时**不调用**。
 * @returns `{ row, review, applied, result }`：`applied=false` 表示挂成待复核，`result` 为 null。
 */
export function confirmFunds(db, { kind, id, actor = {}, evidence = {}, apply }) {
  const k = kindOf(kind)
  if (typeof apply !== 'function') throw new FundsError('FUNDS_APPLY_REQUIRED', 'confirmFunds 需要 apply 回调', 500)
  const row = assertNotPending(db, kind, id)
  if (row.status !== k.readyStatus) {
    throw new FundsError(
      'FUNDS_NOT_READY',
      `${k.label} ${row.doc_no} 当前状态「${row.status}」不能确认（需为「${k.readyStatus}」）`,
      409, { kind, id, status: row.status }
    )
  }
  const policy = fundsPolicy(db)
  const evidenceRef = trimOrNull(evidence.ref) ?? trimOrNull(row.evidence_ref)
  const evidenceNote = trimOrNull(evidence.note) ?? trimOrNull(row.evidence_note)
  if (policy.evidence_required && !evidenceRef) {
    throw new FundsError(
      'FUNDS_EVIDENCE_REQUIRED',
      `${k.label} ${row.doc_no} 确认必须填写银行流水号 / 凭证号（evidence_ref）`,
      400, { kind, id }
    )
  }
  const amount = Number(row.amount || 0)
  const now = localNow()

  const tx = db.transaction(() => {
    db.prepare(`UPDATE ${k.table} SET evidence_ref=?, evidence_note=? WHERE id=?`).run(evidenceRef, evidenceNote, id)
    if (needsReview(policy, amount)) {
      db.prepare(
        `UPDATE ${k.table}
            SET review_status='pending_review', review_maker_id=?, review_maker_name=?, review_requested_at=?,
                review_checker_id=NULL, review_checker_name=NULL, review_decided_at=NULL, review_comment=NULL
          WHERE id=?`
      ).run(actor.id ?? null, actor.name ?? null, now, id)
      auditStrictRow(db, auditRow(actor, {
        action: 'FUNDS_REVIEW_REQUEST', k, id,
        detail: { doc_no: row.doc_no, amount, evidence_ref: evidenceRef, evidence_note: evidenceNote, threshold: policy.review_threshold }
      }))
      const after = loadRow(db, k, id)
      return { row: after, review: reviewOf(after), applied: false, result: null }
    }
    const result = apply(db)
    auditStrictRow(db, auditRow(actor, {
      action: 'FUNDS_CONFIRM', k, id,
      detail: { doc_no: row.doc_no, amount, evidence_ref: evidenceRef, evidence_note: evidenceNote, review: 'not_required' }
    }))
    const after = loadRow(db, k, id)
    return { row: after, review: reviewOf(after), applied: true, result }
  })
  return tx()
}

/**
 * 复核（checker 一侧）。`decision` 为 approve / reject；驳回必须写意见。
 * approve：在同一事务里执行 `apply`（原确认逻辑）+ 严格审计；任一步失败整笔回滚，单据仍是待复核。
 * reject：只改复核列 + 严格审计；内核状态本就没动，所以"退回原状态"不需要再做什么。
 */
export function reviewFunds(db, { kind, id, actor = {}, decision, comment = null, apply }) {
  const k = kindOf(kind)
  if (typeof apply !== 'function') throw new FundsError('FUNDS_APPLY_REQUIRED', 'reviewFunds 需要 apply 回调', 500)
  if (!['approve', 'reject'].includes(decision)) {
    throw new FundsError('FUNDS_BAD_DECISION', `复核结论只能是 approve / reject，收到「${decision}」`, 400, { decision })
  }
  const row = loadRow(db, k, id)
  if (row.review_status !== 'pending_review') {
    throw new FundsError('FUNDS_NOT_PENDING', `${k.label} ${row.doc_no} 不在待复核状态`, 409, { kind, id, review: reviewOf(row) })
  }
  const maker = { id: row.review_maker_id, name: row.review_maker_name }
  if (sameActor(actor, maker)) {
    throw new FundsError('FUNDS_SELF_REVIEW', `${k.label} ${row.doc_no} 由你发起，不能由你自己复核`, 409, { kind, id, maker })
  }
  const why = trimOrNull(comment)
  if (decision === 'reject' && !why) {
    throw new FundsError('FUNDS_COMMENT_REQUIRED', '驳回必须写明原因', 400, { kind, id })
  }
  const now = localNow()
  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE ${k.table}
          SET review_status=?, review_checker_id=?, review_checker_name=?, review_decided_at=?, review_comment=?
        WHERE id=?`
    ).run(decision === 'approve' ? 'approved' : 'rejected', actor.id ?? null, actor.name ?? null, now, why, id)
    let result = null
    if (decision === 'approve') result = apply(db)
    auditStrictRow(db, auditRow(actor, {
      action: decision === 'approve' ? 'FUNDS_REVIEW_APPROVE' : 'FUNDS_REVIEW_REJECT', k, id,
      detail: { doc_no: row.doc_no, amount: Number(row.amount || 0), maker, comment: why, evidence_ref: row.evidence_ref }
    }))
    const after = loadRow(db, k, id)
    return { row: after, review: reviewOf(after), applied: decision === 'approve', result }
  })
  return tx()
}

export default { FUNDS_REVIEW_PERM, FUNDS_REVIEW_LABEL, KINDS, fundsPolicy, needsReview, reviewOf, assertNotPending, confirmFunds, reviewFunds }
