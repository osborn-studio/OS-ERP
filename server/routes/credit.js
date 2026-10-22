/**
 * ============================================================================
 * 文件标识：server/routes/credit.js ｜ 信用控制路由（模块 08A）
 * ============================================================================
 * 【职责】信用控制路由（模块 08A）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 信用控制路由（模块 08A）
//
// 挂载点：/api/credit
//
// 端点分工：
//   GET  /meta       —— 变更类型 / 校验结论的字典
//   GET  /overview   —— 信用总览（额度占用、风险榜、超信与特批留痕、自洽审计）
//   GET  /accounts   —— 信用账户列表（含快照）
//   GET  /accounts/:id —— 账户详情（台账 + 校验留痕）
//   POST /accounts   —— 建档（按主体自动带出额度与账期）
//   POST /accounts/:id —— 维护额度 / 账期 / 临时额度 / 冻结解冻
//   POST /check      —— **只校验不写单**：下单前问一句「够不够」
//   GET  /ledger     —— 信用台账流水
//   GET  /checks     —— 校验留痕（超信拦截与特批放行的全部记录）
//   POST /settle     —— 回款核销（释放占用）
//   POST /adjust     —— 人工调整占用（坏账核销等）
//   GET  /audit      —— 自洽审计（台账余额漂移 + 单据占用与台账差异）
//
// 路径顺序：/meta、/overview、/ledger、/checks、/audit、/check 必须注册在
// /accounts/:id 之前，否则会被当成 id 匹配走详情分支。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, currentUser } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  CreditError, ensureAccount, resolveSubject, creditSnapshot, snapshotFor,
  checkCredit, settle, adjustCredit, updateAccount, release,
  auditCredit, creditOverview, ledgerOf, openAmountOf,
  CHANGE_TYPE_LABEL, CHECK_RESULT_LABEL
} from '../lib/credit.js'

const r = Router()

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.uid || u.id || null, name: u.name || u.username || null }
}

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof CreditError) {
        return bizFail(res, e)
      }
      if (e && e.code && e.status) return bizFail(res, e)
      throw e
    }
  })
}

const dict = (obj) => Object.entries(obj).map(([value, label]) => ({ value, label }))

r.get(
  '/meta',
  requireAuth,
  wrap((_req, res) =>
    ok(res, {
      change_types: dict(CHANGE_TYPE_LABEL),
      check_results: dict(CHECK_RESULT_LABEL),
      account_status: [
        { value: 'active', label: '正常' },
        { value: 'frozen', label: '已冻结' }
      ],
      subject_types: [
        { value: 'dealer', label: '经销商' },
        { value: 'oc', label: '订货客户' },
        { value: 'store', label: '门店' }
      ]
    })
  )
)

r.get(
  '/overview',
  requireAuth,
  requirePerm('credit.view'),
  wrap((_req, res) => ok(res, creditOverview(getDb())))
)

r.get(
  '/accounts',
  requireAuth,
  requirePerm('credit.view'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.subject_type) { conds.push('subject_type=?'); params.push(req.query.subject_type) }
    if (req.query.status) { conds.push('status=?'); params.push(req.query.status) }
    if (req.query.keyword) { conds.push('(name LIKE ? OR code LIKE ?)'); params.push(`%${req.query.keyword}%`, `%${req.query.keyword}%`) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM credit_accounts ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT * FROM credit_accounts ${where} ORDER BY id LIMIT ? OFFSET ?`)
      .all(...params, pageSize, (page - 1) * pageSize)
      .map((a) => creditSnapshot(db, a))
    return ok(res, { rows, total, page, pageSize })
  })
)

r.get(
  '/accounts/:id',
  requireAuth,
  requirePerm('credit.view'),
  wrap((req, res) => {
    const db = getDb()
    const acc = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(Number(req.params.id))
    if (!acc) return fail(res, '信用账户不存在', 404)
    return ok(res, {
      account: creditSnapshot(db, acc),
      ledger: ledgerOf(db, { accountId: acc.id, limit: 200 }),
      checks: db
        .prepare('SELECT * FROM credit_check_logs WHERE account_id=? ORDER BY id DESC LIMIT 50')
        .all(acc.id)
    })
  })
)

r.post(
  '/accounts',
  requireAuth,
  requirePerm('credit.manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const acc = ensureAccount(db, {
      subjectType: b.subject_type,
      subjectId: b.subject_id,
      actor: actorOf(req)
    })
    audit(req, { action: 'CREATE', module: 'sales', entity: 'credit_accounts', entityId: acc.id, detail: `${acc.subject_type}#${acc.subject_id}` })
    return ok(res, creditSnapshot(db, acc))
  })
)

r.post(
  '/accounts/:id',
  requireAuth,
  requirePerm('credit.manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const before = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(Number(req.params.id))
    if (!before) return fail(res, '信用账户不存在', 404)
    const acc = updateAccount(db, { accountId: Number(req.params.id), patch: b, actor: actorOf(req) })
    audit(req, {
      action: 'UPDATE', module: 'sales', entity: 'credit_accounts', entityId: acc.id,
      detail: `额度 ${before.credit_limit}→${acc.credit_limit}，账期 ${before.credit_days}→${acc.credit_days}，状态 ${before.status}→${acc.status}`
    })
    return ok(res, creditSnapshot(db, acc))
  })
)

// 只校验不写单：给界面「这单能不能下」的判断，也用于报价转单前的预检
r.post(
  '/check',
  requireAuth,
  requirePerm('credit.view'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const out = checkCredit(db, {
      subject: { customerType: b.customer_type || null, dealerId: b.dealer_id || null, customerId: b.customer_id || null, storeId: b.store_id || null },
      accountId: b.account_id || null,
      amount: Number(b.amount || 0),
      scene: b.scene || 'api',
      sourceType: b.source_type || null,
      sourceId: b.source_id || null,
      docNo: b.doc_no || null,
      force: !!b.force,
      reason: b.reason || null,
      actor: actorOf(req)
    })
    return ok(res, out)
  })
)

r.get(
  '/ledger',
  requireAuth,
  requirePerm('credit.view'),
  wrap((req, res) => {
    const db = getDb()
    const rows = ledgerOf(db, {
      accountId: req.query.account_id ? Number(req.query.account_id) : null,
      sourceType: req.query.source_type || null,
      sourceId: req.query.source_id ? Number(req.query.source_id) : null,
      limit: Number(req.query.limit || 100)
    })
    return ok(res, rows)
  })
)

r.get(
  '/checks',
  requireAuth,
  requirePerm('credit.view'),
  wrap((req, res) => {
    const db = getDb()
    const conds = []
    const params = []
    if (req.query.account_id) { conds.push('l.account_id=?'); params.push(Number(req.query.account_id)) }
    if (req.query.result) { conds.push('l.result=?'); params.push(req.query.result) }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const rows = db
      .prepare(
        `SELECT l.*, a.name AS account_name, a.subject_type, a.subject_id
         FROM credit_check_logs l LEFT JOIN credit_accounts a ON a.id=l.account_id
         ${where} ORDER BY l.id DESC LIMIT ?`
      )
      .all(...params, Number(req.query.limit || 100))
    return ok(res, rows)
  })
)

// 回款核销：货发了钱没到，授信仍然占着 —— 只有钱到了才释放
r.post(
  '/settle',
  requireAuth,
  requirePerm('credit.manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const acc = accountFor(db, b)
    if (!acc) return fail(res, '未找到对应信用账户（该客户未授信）', 404)
    const row = settle(db, {
      account: acc,
      amount: Number(b.amount || 0),
      sourceType: b.source_type || 'SO',
      sourceId: b.source_id || null,
      docNo: b.doc_no || null,
      operator: actorOf(req),
      remark: b.remark || null
    })
    audit(req, { action: 'SETTLE', module: 'sales', entity: 'credit_ledger', entityId: row?.id || null, detail: `${b.amount} ${b.doc_no || ''}` })
    return ok(res, { ledger: row, account: creditSnapshot(db, acc) })
  })
)

// 人工调整占用：坏账核销、争议挂账等。正=加占用，负=减占用
r.post(
  '/adjust',
  requireAuth,
  requirePerm('credit.manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const acc = accountFor(db, b)
    if (!acc) return fail(res, '未找到对应信用账户（该客户未授信）', 404)
    if (!b.remark) return fail(res, '人工调整必须填写原因', 400)
    const row = adjustCredit(db, {
      account: acc,
      amount: Number(b.amount || 0),
      operator: actorOf(req),
      remark: b.remark
    })
    audit(req, { action: 'ADJUST', module: 'sales', entity: 'credit_ledger', entityId: row?.id || null, detail: `${b.amount} ${b.remark}` })
    return ok(res, { ledger: row, account: creditSnapshot(db, acc) })
  })
)

// 释放某张单据占用的授信（取消订单时由销售路由调用，这里也开放给人工处理）
r.post(
  '/release',
  requireAuth,
  requirePerm('credit.manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const acc = accountFor(db, b)
    if (!acc) return fail(res, '未找到对应信用账户（该客户未授信）', 404)
    const row = release(db, {
      account: acc,
      amount: b.amount != null ? Number(b.amount) : null,
      sourceType: b.source_type || 'SO',
      sourceId: b.source_id || null,
      docNo: b.doc_no || null,
      operator: actorOf(req),
      remark: b.remark || null
    })
    return ok(res, { ledger: row, account: creditSnapshot(db, acc) })
  })
)

r.get(
  '/audit',
  requireAuth,
  requirePerm('credit.view'),
  wrap((_req, res) => ok(res, auditCredit(getDb())))
)

/** 请求体 → 信用账户（subject 或 accountId 二选一） */
function accountFor(db, b) {
  if (b.account_id) {
    const acc = db.prepare('SELECT * FROM credit_accounts WHERE id=?').get(Number(b.account_id))
    if (acc) return acc
  }
  const sub = resolveSubject(db, {
    customerType: b.customer_type || null,
    customerId: b.customer_id || null,
    dealerId: b.dealer_id || null,
    storeId: b.store_id || null
  })
  if (!sub) return null
  return db.prepare('SELECT * FROM credit_accounts WHERE subject_type=? AND subject_id=?').get(sub.subjectType, sub.subjectId)
}

export { openAmountOf, snapshotFor }
export default r
