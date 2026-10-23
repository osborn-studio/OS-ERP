/**
 * ============================================================================
 * 文件标识：server/routes/approval.js ｜ 通用审批流路由（模块 22）
 * ============================================================================
 * 【职责】通用审批流路由（模块 22）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 通用审批流路由（模块 22）
//
// 挂载点：/api/approval
//
// 四个端点分工要分清：
//   GET  /check      —— 这次动作要不要审批（前端点按钮前先问一句，别让用户白点）
//   POST /instances  —— **提交审批**。这是实例唯一的创建入口（闸门自己不建，见 approval.js 口径①）
//   POST /decide     —— 审批人做决定。最后一级通过会真正执行业务流转
//   GET  /pending    —— 「待我审批」
//
// 一条刻意的约束：**审批模板默认停用**。审批是唯一会卡住别人工作流的动作，
// 默认开启等于把所有既有链路一次性堵死。定义先建好、默认关，由管理者显式打开 ——
// 与待办推送（013）同一个取舍。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm, requireInternal, currentUser, assertCanRead, isExternalUser, attachOrgScope, INTERNAL_MODULES } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  ApprovalError, approvalGate, matchTemplate, amountOf,
  submitApproval, getInstance, decideApproval, cancelApproval,
  listInstances, pendingForMe, listTemplates,
  approvalOverview, approvalTodosFor, describeApprover, stepsOfTemplate,
  approvalDocScope, instanceVisibleTo
} from '../lib/approval.js'

const r = Router()
r.use((req, res, next) => {
  if (req.method !== 'GET') return next()
  return requireAuth(req, res, () => requireInternal('总部审批管理；订货方请查看自己的订货单审批记录')(req, res, next))
})

// 组织数据范围（ADR-0037）：审批实例跟着它指向的单据走。读路由用 attachOrgScope 取 req.orgScope，
// 判据在 lib/approval.js（approvalDocScope / instanceVisibleTo），路由不另写第二份。
const scopeOf = (req) => ({ orgScope: req.orgScope, user: req.user })

const actorOf = (req) => {
  const u = currentUser(req)
  return { id: u.id || u.uid || null, name: u.name || u.username || null }
}

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e instanceof ApprovalError) return bizFail(res, e)
      throw e
    }
  })
}

r.get('/meta', requireAuth, wrap((_req, res) => {
  const db = getDb()
  const docTypes = db
    .prepare(
      `SELECT DISTINCT a.doc_type, t.name
         FROM doc_actions a LEFT JOIN doc_types t ON t.code=a.doc_type
        WHERE a.require_approval=1 ORDER BY t.name`
    )
    .all()
  const docTypesAll = db.prepare('SELECT code, name, module FROM doc_types ORDER BY module, code').all()
  const roles = db.prepare('SELECT code, name FROM roles ORDER BY code').all()
  const users = db.prepare('SELECT id, name, username FROM users ORDER BY id').all()
  const perms = db.prepare('SELECT code, name FROM permissions ORDER BY code').all()
  return ok(res, {
    approver_types: [
      { code: 'role', label: '按角色' },
      { code: 'user', label: '指定人员' },
      { code: 'perm', label: '按权限点' }
    ],
    gated_doc_types: docTypes,
    doc_types: docTypesAll,
    roles,
    users,
    permissions: perms
  })
}))

r.get('/overview', requireAuth, attachOrgScope, wrap((req, res) => ok(res, approvalOverview(getDb(), { actor: actorOf(req), scopeCtx: scopeOf(req) }))))

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------

r.get('/templates', requireAuth, wrap((_req, res) => ok(res, { list: listTemplates(getDb()) })))

/** 新建/编辑模板（含级次整体重建） */
r.post(
  '/templates',
  requireAuth,
  requirePerm('system:approval:manage'),
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    if (!b.code) return fail(res, '模板编码必填', 400)
    if (!b.doc_type || !b.action) return fail(res, '单据类型与动作必填', 400)
    const steps = Array.isArray(b.steps) ? b.steps.filter((s) => s && s.approver_value) : []
    if (!steps.length) return fail(res, '至少需要一级审批人', 400)

    const tx = db.transaction(() => {
      db.prepare(
        `INSERT INTO approval_templates (code,name,doc_type,action,min_amount,max_amount,priority,enabled,remark)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET
           name=excluded.name, doc_type=excluded.doc_type, action=excluded.action,
           min_amount=excluded.min_amount, max_amount=excluded.max_amount,
           priority=excluded.priority, remark=excluded.remark,
           updated_at=datetime('now','localtime')`
      ).run(
        b.code, b.name || b.code, b.doc_type, b.action,
        Number(b.min_amount || 0), b.max_amount == null || b.max_amount === '' ? null : Number(b.max_amount),
        Number(b.priority || 0), b.enabled == null ? 0 : Number(b.enabled) ? 1 : 0,
        b.remark || null
      )
      const tpl = db.prepare('SELECT id FROM approval_templates WHERE code=?').get(b.code)
      db.prepare('DELETE FROM approval_steps WHERE template_id=?').run(tpl.id)
      const ins = db.prepare(
        `INSERT INTO approval_steps (template_id,step_no,step_name,approver_type,approver_value,remark)
         VALUES (?,?,?,?,?,?)`
      )
      steps.forEach((s, i) => {
        ins.run(tpl.id, i + 1, s.step_name || `第 ${i + 1} 级`, s.approver_type || 'role', String(s.approver_value), s.remark || null)
      })
      return tpl.id
    })
    const id = tx()
    audit(req, { action: 'UPSERT', module: 'approval', entity: 'approval_templates', entityId: id, detail: { code: b.code, steps: steps.length } })
    return ok(res, listTemplates(db).find((t) => t.id === id))
  })
)

/** 启停模板：单独一个动作，避免改配置时误把开关带上/带下 */
r.post(
  '/templates/:id/toggle',
  requireAuth,
  requirePerm('system:approval:manage'),
  guard((req, res) => {
    const db = getDb()
    const t = db.prepare('SELECT * FROM approval_templates WHERE id=?').get(Number(req.params.id))
    if (!t) return fail(res, '模板不存在', 404)
    const next = Number(t.enabled) ? 0 : 1
    // 打开前必须检查：这套模板挂的边是否真的有 require_approval。
    // 没有的话模板开着也不会生效 —— 与其让人以为配好了，不如当场说清。
    const gated = db
      .prepare('SELECT COUNT(*) c FROM doc_actions WHERE doc_type=? AND action=? AND require_approval=1')
      .get(t.doc_type, t.action).c
    if (next && !gated) {
      return fail(
        res,
        `单据「${t.doc_type}」的动作「${t.action}」未标记需要审批，模板启用后不会生效`,
        400
      )
    }
    db.prepare(`UPDATE approval_templates SET enabled=?, updated_at=datetime('now','localtime') WHERE id=?`).run(next, t.id)
    audit(req, { action: next ? 'ENABLE' : 'DISABLE', module: 'approval', entity: 'approval_templates', entityId: t.id })
    return ok(res, listTemplates(db).find((x) => x.id === t.id))
  })
)

// ---------------------------------------------------------------------------
// 闸门查询 / 提交审批
// ---------------------------------------------------------------------------

/** 这次动作要不要审批？已批准 / 待审批 / 需要新提交，三种情况返给前端 */
r.get(
  '/check',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const docType = String(req.query.doc_type || '')
    const action = String(req.query.action || '')
    const docId = Number(req.query.doc_id || 0)
    if (!docType || !action || !docId) return fail(res, 'doc_type / action / doc_id 必填', 400)
    const t = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(docType)
    if (!t) return fail(res, '未知单据类型', 400)
    const row = db.prepare(`SELECT * FROM ${t.table_name} WHERE id=?`).get(docId)
    if (!row) return fail(res, '单据不存在', 404)
    // ADR-0037：闸门查询会回显待审实例，范围外的单据与不存在同形
    if (!approvalDocScope(db, docType, docId, scopeOf(req))) return fail(res, '单据不存在', 404)
    const gate = approvalGate(db, { docType, docId, action, row })
    if (!gate) return ok(res, { need_approval: false })
    return ok(res, {
      need_approval: true,
      amount: gate.amount,
      template: { code: gate.template.code, name: gate.template.name, steps: stepsOfTemplate(db, gate.template.id).length },
      pending: gate.pending || null
    })
  })
)

/** 提交审批 —— 实例唯一的创建入口 */
r.post(
  '/instances',
  requireAuth,
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const actor = actorOf(req)
    // 这一道闸是批次 T 补的，理由与 A01 同族：**只有登录校验的写入口，等于没有入口守卫**。
    // `submitApproval` 会按调用方给的单据类型 + id 去建一条审批实例，而实例被批准之后
    // 会**真的执行那个业务动作**（`decideApproval` 最后一级通过 → `applyTransition`）。
    // 于是"能建实例"等于"能替别人把单据推到某个状态"——哪怕这个单据他从来没见过。
    // 判据与通用流转入口**同一份**（`assertCanRead` + 外部主体不得驱动内部单据域），
    // 不在这里另写第三套"这张单我能不能动"。
    const type = db.prepare('SELECT code, name, table_name, module FROM doc_types WHERE code=?').get(b.doc_type)
    if (!type) return fail(res, `未知单据类型「${b.doc_type}」`, 400)
    const row = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(Number(b.doc_id))
    if (!row) return fail(res, `单据 #${b.doc_id} 不存在`, 404)
    const access = assertCanRead(req, row)
    if (!access.ok) return fail(res, access.message, access.status)
    if (INTERNAL_MODULES.has(type.module) && isExternalUser(req)) {
      return fail(res, `当前角色无权操作「${type.name}」`, 403)
    }
    // ADR-0037：目标单据必须在调用者的组织范围内；范围外与不存在同形（404），且不建实例
    if (!approvalDocScope(db, b.doc_type, row.id, scopeOf(req))) return fail(res, `单据 #${b.doc_id} 不存在`, 404)
    const inst = submitApproval(db, {
      docType: b.doc_type,
      docId: Number(b.doc_id),
      docNo: b.doc_no || row.doc_no || null,
      action: b.action,
      actor,
      remark: b.remark || null
    })
    audit(req, { action: 'SUBMIT', module: 'approval', entity: 'approval_instances', entityId: inst.id, detail: { doc: inst.doc_no, action: inst.action } })
    return ok(res, inst)
  })
)

// ---------------------------------------------------------------------------
// 实例查询与决策
// ---------------------------------------------------------------------------

r.get(
  '/instances',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const { page, pageSize } = pageParams(req)
    return ok(res, listInstances(getDb(), {
      page,
      pageSize,
      actor: actorOf(req),
      scopeCtx: scopeOf(req),
      status: req.query.status || null,
      docType: req.query.doc_type || null,
      mine: req.query.mine === '1' ? (currentUser(req).id || null) : null
    }))
  })
)

r.get('/pending', requireAuth, attachOrgScope, wrap((req, res) => {
  const { page, pageSize } = pageParams(req)
  return ok(res, pendingForMe(getDb(), actorOf(req), { page, pageSize, scopeCtx: scopeOf(req) }))
}))

// 详情（含 records 即审批历史）：范围外与不存在同形（同一句 404），不泄漏存在性（ADR-0037）
r.get('/instances/:id', requireAuth, attachOrgScope, wrap((req, res) => {
  const db = getDb()
  const inst = getInstance(db, Number(req.params.id))
  if (!inst || !instanceVisibleTo(db, inst, actorOf(req), scopeOf(req))) return fail(res, '审批实例不存在', 404)
  return ok(res, inst)
}))

/**
 * 审批待办（ADR-0015）：进门要有审批中心的任一权限点（与页面菜单同一组），
 * 内容只统计**我能处理**的 pending 实例（判据 `pendingInstancesFor`，与「待我审批」同一份）。
 * 原来只 `requireAuth` 且全库计数 —— 任何登录账号都能数出全公司有多少待审单与总金额。
 * 全库口径只保留给通知摘要（`approvalTodos`，由 ADR-0008 的全局数据范围门把守）。
 */
r.get(
  '/todos',
  requireAuth,
  requirePerm('system:approval:view', 'system:approval:decide', 'system:approval:manage'),
  attachOrgScope,
  wrap((req, res) => ok(res, approvalTodosFor(getDb(), actorOf(req), scopeOf(req))))
)

r.post(
  '/instances/:id/decide',
  requireAuth,
  requirePerm('system:approval:decide'),
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const actor = actorOf(req)
    const out = decideApproval(db, {
      instanceId: Number(req.params.id),
      decision: String(b.decision || ''),
      comment: b.comment || null,
      actor,
      scopeCtx: scopeOf(req)
    })
    audit(req, {
      action: b.decision === 'reject' ? 'REJECT' : 'APPROVE',
      module: 'approval',
      entity: 'approval_instances',
      entityId: Number(req.params.id),
      detail: { step: out.step, done: out.done, doc: out.instance?.doc_no }
    })
    return ok(res, out)
  })
)

r.post(
  '/instances/:id/cancel',
  requireAuth,
  attachOrgScope,
  guard((req, res) => {
    const db = getDb()
    const inst = cancelApproval(db, {
      instanceId: Number(req.params.id),
      actor: actorOf(req),
      comment: (req.body || {}).comment || null,
      scopeCtx: scopeOf(req)
    })
    audit(req, { action: 'CANCEL', module: 'approval', entity: 'approval_instances', entityId: Number(req.params.id) })
    return ok(res, inst)
  })
)

export default r
