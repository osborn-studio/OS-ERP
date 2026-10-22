/**
 * ============================================================================
 * 文件标识：server/routes/accounting.js ｜ 财务中心（批次 H · 模块 27）：会计科目 / 凭证模板 / 凭证生成与过账 / 试算平衡表
 * ============================================================================
 * 【职责】财务中心（批次 H · 模块 27）：会计科目 / 凭证模板 / 凭证生成与过账 / 试算平衡表
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 财务中心（批次 H · 模块 27）：会计科目 / 凭证模板 / 凭证生成与过账 / 试算平衡表
//
// 本文件只做三件事：**取参数、调 lib、翻译错误**。
// 所有判据都在 `lib/accounting.js`（科目校验、取数、借贷试算、过账与作废）。
//
// 为什么凭证没有"新建"端点：
//   一张凭证的来源由 `(biz_type, source_type, source_id)` 唯一决定，
//   界面上只有"生成"。手工编分录的口子一开，"这张凭证是哪来的"就再也答不出来，
//   而编出来的账同样是平的 —— 平账骗得过所有不变量。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged, failFromError } from '../lib/http.js'
import { requireAuth, requireRole, requirePerm, requireGlobalData } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import * as A from '../lib/accounting.js'

const r = Router()
// This ledger is global; scoped ledgers need an ownership model before being exposed.
r.use(requireAuth, requireGlobalData('总部财务'), requirePerm('finance.subject.view', 'finance.voucher.view'))
const W = ['finance', 'admin']

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
  })
}

const actorOf = (req) => ({
  id: req.user?.uid ?? null,
  name: req.user?.name || req.user?.username || null,
  source: 'web'
})

// ===========================================================================
// 一、字典
// ===========================================================================
r.get('/meta', requireAuth, guard((_req, res) => ok(res, A.meta(getDb()))))

// ===========================================================================
// 二、会计科目
// ===========================================================================
r.get('/subjects', requireAuth, guard((req, res) => ok(res, {
  rows: A.listSubjects(getDb(), {
    keyword: req.query.keyword || null,
    onlyLeaf: req.query.only_leaf === '1'
  })
})))
r.get('/subjects/tree', requireAuth, guard((_req, res) => ok(res, { rows: A.subjectTree(getDb()) })))

r.post('/subjects', requireAuth, requireRole(...W), guard((req, res) => {
  const row = A.saveSubject(getDb(), req.body || {})
  audit(req, { action: 'finance.subject.save', target: `subject:${row.code}`, detail: { code: row.code, name: row.name } })
  ok(res, row)
}))

r.put('/subjects/:id', requireAuth, requireRole(...W), guard((req, res) => {
  const db = getDb()
  const row = db.prepare('SELECT * FROM accounting_subjects WHERE id=?').get(Number(req.params.id))
  if (!row) return fail(res, '科目不存在', 404)
  // 编码是历史凭证上的对外标识，改名可以、改码不行（改了历史凭证就指不到人了）
  const out = A.saveSubject(db, { ...req.body, code: row.code })
  audit(req, { action: 'finance.subject.save', target: `subject:${out.code}`, detail: { code: out.code } })
  ok(res, out)
}))

r.post('/subjects/:id/status', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.setSubjectStatus(getDb(), req.params.id, req.body?.status)
  audit(req, { action: 'finance.subject.status', target: `subject:${req.params.id}`, detail: { status: req.body?.status } })
  ok(res, out)
}))

// ===========================================================================
// 三、凭证模板
// ===========================================================================
r.get('/templates', requireAuth, guard((_req, res) => ok(res, { rows: A.listTemplates(getDb()) })))

r.get('/templates/:bizType', requireAuth, guard((req, res) => {
  const db = getDb()
  const t = A.templateOf(db, req.params.bizType)
  const fake = { total_amount: 10000, net_amount: 8849.56, tax_amount: 1150.44, cost_amount: 6000, settled_amount: 10000, offset_amount: 0 }
  ok(res, { ...t, sample_facts: fake })
}))

// ===========================================================================
// 四、凭证
// ===========================================================================
r.get('/vouchers', requireAuth, requirePerm('finance.voucher.view'), guard((req, res) => {
  const { page, pageSize, offset } = pageParams(req)
  const out = A.listVouchers(getDb(), {
    period: req.query.period || null,
    bizType: req.query.biz_type || null,
    status: req.query.status || null,
    sourceDocNo: req.query.source_doc_no || null,
    limit: pageSize,
    offset
  })
  return paged(res, { rows: out.rows, total: out.total, page, pageSize })
}))

r.get('/vouchers/:id', requireAuth, requirePerm('finance.voucher.view'), guard((req, res) => ok(res, A.getVoucher(getDb(), req.params.id))))

/** 试算：算出分录**但不落库**。与"生成"共用同一个函数，所以预览与落库必然一致。 */
r.post('/vouchers/plan', requireAuth, requirePerm('finance.voucher.gen'), guard((req, res) => {
  const { biz_type: bizType, source_id: sourceId } = req.body || {}
  ok(res, A.planVoucher(getDb(), { bizType, sourceId }))
}))

r.post('/vouchers/generate', requireAuth, requireRole(...W), guard((req, res) => {
  const { biz_type: bizType, source_type: sourceType = null, source_id: sourceId, memo = null } = req.body || {}
  const out = A.generateVoucher(getDb(), { bizType, sourceType, sourceId, actor: actorOf(req), memo })
  audit(req, { action: 'finance.voucher.generate', target: `voucher:${out.id}`, detail: { doc_no: out.doc_no, biz_type: bizType, source_id: sourceId, replayed: out.replayed } })
  ok(res, out)
}))

r.post('/vouchers/:id/post', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.postVoucher(getDb(), { id: req.params.id, actor: actorOf(req) })
  audit(req, { action: 'finance.voucher.post', target: `voucher:${req.params.id}`, detail: { replayed: out.replayed } })
  ok(res, out)
}))

r.post('/vouchers/:id/void', requireAuth, requireRole(...W), guard((req, res) => {
  const out = A.voidVoucher(getDb(), { id: req.params.id, reason: req.body?.reason, actor: actorOf(req) })
  audit(req, { action: 'finance.voucher.void', target: `voucher:${req.params.id}`, detail: { reason: req.body?.reason || null, was_posted: out.was_posted } })
  ok(res, out)
}))

/** 反查：某张来源单据生成过哪些凭证（"这笔记过账没有"） */
r.get('/vouchers/by-source/:sourceType/:sourceId', requireAuth, requirePerm('finance.voucher.view'), guard((req, res) => ok(res, {
  rows: A.vouchersOfSource(getDb(), { sourceType: req.params.sourceType, sourceId: req.params.sourceId })
})))

// ===========================================================================
// 五、试算平衡表与域自证
// ===========================================================================
r.get('/trial-balance', requireAuth, requirePerm('finance.voucher.view'), guard((req, res) => ok(res, A.trialBalance(getDb(), {
  period: req.query.period || null,
  from: req.query.from || null,
  to: req.query.to || null
}))))

// 逐行展开（批次 N）：某一科目在同一筛选条件下的**全部分录明细**。
// 与 `/trial-balance` 共用 `trialBalanceFilter`（同一个 where），所以"展开的合计"必须等于"汇总行"。
r.get('/trial-balance/detail', requireAuth, requirePerm('finance.voucher.view'), guard((req, res) => ok(res, A.trialBalanceDetail(getDb(), {
  period: req.query.period || null,
  from: req.query.from || null,
  to: req.query.to || null,
  subjectCode: req.query.subjectCode || req.query.subject_code || null,
  subjectId: req.query.subjectId || null,
  limit: req.query.limit || 500
}))))

r.get('/audit', requireAuth, requirePerm('finance.voucher.view'), guard((_req, res) => ok(res, A.auditVoucher(getDb()))))

export default r
