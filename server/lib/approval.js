/**
 * ============================================================================
 * 文件标识：server/lib/approval.js ｜ 通用审批流引擎（模块 22）
 * ============================================================================
 * 【职责】通用审批流引擎（模块 22）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 通用审批流引擎（模块 22）
//
// 三条口径，写死在文件头：
//
// ① **闸门只做检查，不产生副作用。**
//    `applyTransition` 命中 `require_approval=1` 的边时，只是**抛错拦住**，不建实例。
//    原因：调用方经常把流转包在事务里（`db.transaction`）。若在抛错前写了一条实例，
//    事务一回滚实例就没了 —— 用户看到「请去审批中心处理」，审批中心里却什么都没有。
//    实例的创建必须由**显式动作**完成（前端/测试拿到 APPROVAL_PENDING 后调 submit）。
//
// ② **审批实例有独立状态，不进 `doc_events`。**
//    单据状态机不知道审批的存在，审批也不知道状态机的存在，两者只在一个点上握手：
//    「最后一级通过之后，放行那次业务流转」。换审批流不用动状态机，反之亦然。
//
// ③ **审批通过 ≠ 业务完成。**
//    最后一级通过只说明「有人批准了」。业务流转由 `apply` 真正执行，它**可能失败**
//    （比如单据在此期间被别人改过、状态已经变了）。这种失败必须原样抛出，不能吞 ——
//    「审批已通过但业务没发生」是必须让人看见的状态，静默吞掉会变成幽灵审批。
//
// ④ **放行必须走业务入口，不能只翻状态。**
//    `apply` 的默认实现按「效果归属优先 → 审批放行表（`APPROVAL_RELEASE`）兜底」取执行体，
//    两者都是**该动作正门那段代码**，不是 `applyTransition`；都没有则**拒绝放行**。
//    理由与后果见文件中部「口径④」一节 —— 一句话：只翻状态会留下"状态对了、账不对"的单。

import { getDb } from '../db/index.js'
import { userPermissions } from '../middleware/auth.js'
import { setApprovalGate, effectOwnerOf } from './docflow.js'
// 采购订单（PO）本体的业务入口实现。**这里 import 业务模块是刻意的**，理由见下方「口径④」：
// 审批放行必须走正门那段代码，而 PO 的效果归属只有域侧知道。
import { transitionPurchaseOrder } from './purchase.js'

export class ApprovalError extends Error {
  constructor(message, { code = 'APPROVAL_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'ApprovalError'
    this.code = code
    this.httpStatus = httpStatus
    // 全局错误中间件读的是 err.status（与 DocFlowError 同一约定），
    // 不赋值的话扣不到 4xx，会被当成 500 报出来
    this.status = httpStatus
    this.detail = detail
  }
}

const nowStr = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

/** 金额字段的取值优先级：不同单据的主金额列名不一样，按序取第一个存在的 */
const AMOUNT_FIELDS = ['total_amount', 'amount', 'settle_amount', 'pay_amount', 'invoice_amount']

export function amountOf(docType, row) {
  if (!row) return 0
  for (const f of AMOUNT_FIELDS) {
    if (row[f] != null && row[f] !== '') return Number(row[f]) || 0
  }
  return 0
}

// ---------------------------------------------------------------------------
// 模板匹配
// ---------------------------------------------------------------------------

/** 找匹配的审批模板：同 doc_type+action 的多个模板按 priority 降序，取金额区间命中的第一个 */
export function matchTemplate(db = getDb(), { docType, action, amount = 0 }) {
  const rows = db
    .prepare(
      `SELECT * FROM approval_templates
        WHERE doc_type=? AND action=? AND enabled=1
        ORDER BY priority DESC, id ASC`
    )
    .all(docType, action)
  const amt = Number(amount) || 0
  for (const t of rows) {
    const min = Number(t.min_amount || 0)
    const max = t.max_amount == null ? null : Number(t.max_amount)
    if (amt + 1e-6 < min) continue
    if (max != null && amt >= max) continue
    return t
  }
  return null
}

export function stepsOfTemplate(db, templateId) {
  return db.prepare('SELECT * FROM approval_steps WHERE template_id=? ORDER BY step_no').all(templateId)
}

/** 审批人的可读描述（列表与待办直接展示，不让人对着 role code 猜） */
export function describeApprover(db, type, value) {
  if (type === 'user') {
    const u = db.prepare('SELECT name, username FROM users WHERE id=?').get(Number(value))
    return u ? u.name || u.username : `用户#${value}`
  }
  if (type === 'role') {
    const r = db.prepare('SELECT name FROM roles WHERE code=?').get(value)
    return r?.name || value
  }
  if (type === 'perm') {
    const p = db.prepare('SELECT name FROM permissions WHERE code=?').get(value)
    return p?.name || value
  }
  return String(value)
}

// ---------------------------------------------------------------------------
// 闸门：给 applyTransition 调用（纯检查，无副作用）
// ---------------------------------------------------------------------------

/**
 * 判断某次流转是否需要走审批、以及是否已经批准过。
 * @param {object} [p.row] 单据行（已由 applyTransition 读好，传进来免一次查询；
 *                         金额字段各表列名不同，由 amountOf 统一解析）
 * @returns {{ required: true, template, amount, pending } | null}
 *          返回 null 表示不需要审批（或已批准），放行。
 */
export function approvalGate(db, { docType, docId, action, amount = null, row = null }) {
  const amt = amount != null ? Number(amount) || 0 : amountOf(docType, row)
  const tpl = matchTemplate(db, { docType, action, amount: amt })
  if (!tpl) return null

  // 已经批准过的实例 → 放行。取最近一条，避免历史批准被误用。
  const passed = db
    .prepare(
      `SELECT id FROM approval_instances
        WHERE doc_type=? AND doc_id=? AND action=? AND status='approved'
        ORDER BY id DESC LIMIT 1`
    )
    .get(docType, docId, action)
  if (passed) return null

  const pending = db
    .prepare(
      `SELECT id, current_step, total_steps, current_approver FROM approval_instances
        WHERE doc_type=? AND doc_id=? AND action=? AND status='pending'
        ORDER BY id DESC LIMIT 1`
    )
    .get(docType, docId, action)

  return { required: true, approved: false, template: tpl, amount: amt, pending: pending || null }
}

// 把闸门注册进单据内核。放在文件末尾、导出之前 —— 模块体执行到这里时
// docflow.js 已经加载完毕，挂点一定存在。
setApprovalGate((db, ctx) => approvalGate(db, ctx))

// ---------------------------------------------------------------------------
// 口径④：**审批放行必须走业务入口那一段代码，不能只翻状态。**（批次 V · A7）
// ---------------------------------------------------------------------------
// 原来的默认 `apply` 是 `applyTransition(...)` —— 纯状态转换。而 `routes/approval.js`
// 从不传 `apply`，于是**所有**走审批的动作都落到这条"只翻状态"的路上：
//   · `PAY.void`：付款单变 `voided`，而结算单 `paid_amount` 停在 43,771.20
//     （正门 `transitionPayment` 会 `syncSettlePaid` 重算为 0）⇒「付款单已作废、结算单显示已付」；
//   · `PI.post` / `PI.void`：不写应付、不冲销；`PST.audit` / `PST.void`：不重算已付与暂估差异；
//   · `PO.approve` / `PO.cancel` / `PRQ.approve`：下游（到货、额度、转单）全都不动。
// `014` 标记的 8 个动作共 **14 条边**全都中招，而且**不报错** ——
// 留下的是一批"状态对了、账不对"的单据，事后分不出哪张是走正门进来的。
//
// 修法：默认执行器改成「**先取效果归属的执行体，取不到再看审批引擎自己的放行表**」：
//   ① 该类型在代码里登记了「效果归属」（PRQ/PI/PST/PAY/OC）→ 委托给归属的业务服务
//      （与正门**同一段代码**；`MCP` 入口与通用入口也是这一段）；
//   ② 没有登记、但已在 `APPROVAL_RELEASE` 里配了正门实现（当前只有 `PO`）→ 调那一段；
//   ③ 两者都没有 → **拒绝放行**，报 `EFFECT_REQUIRES_BUSINESS_API` 并指出该走哪个入口。
// 兜底原则：**宁可拒绝放行，也不要静默只翻状态**（③ 就是为此存在的）。
// 另外 `PO.receive|partial` 这类"后果在参数上"的动作，即便被放到审批里也会被
// `transitionPurchaseOrder` 自己的 `assertNotParamOnly` 拒掉（收货要写库存与成本）——
// 这正是"派发到正门"的价值：正门的判据一条都不会漏。
// ---------------------------------------------------------------------------
// `PRQ / PI / PST / PAY` 在 `lib/purchase.js` 结尾自行登记了效果归属；`PO` 本体没登记，
// 而 `PO.approve` / `PO.cancel` 是**已标记需审批**的边（`014` 的 `GATED_EDGES`），
// 且 `APV-PO-CANCEL` 模板默认**启用** —— 不补就会「审批通过却拒绝放行」，把唯一一条默认启用的审批流堵死。
//
// ⚠️ **但这张表必须是审批引擎自己的一张「放行执行器」表，绝不能写进全局 `EFFECT_OWNERS`
// （即不能用 `claimTransitionEffect('PO', …)`）。** 理由：
//   `EFFECT_OWNERS` 是**通用流转入口** `/api/docflow/transition` 的分发表 ——
//   登记进去就等于把 `027` 策略表里 `PO.allow_generic=0` 这条**数据配置**用代码改掉了：
//     · `PO.approve`（模板默认停用）会从「409 拒绝并指路」变成**直接执行**；
//     · `PO.cancel`（模板默认启用）会从「409 EFFECT_REQUIRES_BUSINESS_API」变成「409 APPROVAL_PENDING」
//       （错误码与指路入口都没了）。
//   一个审批引擎的兜底顺手改掉另一个入口的治理姿态，正是本批要消灭的「同一件事两个出处」。
//   通用入口该不该驱动某类型是 `027` 的事，不由审批引擎代决。
//   所以：审批放行这边走正门实现（与归属类型同一条判据），**通用入口对 PO 的判据不受影响**。
//   域侧（`lib/purchase.js`）将来若自行登记 PO 归属，`effectOwnerOf` 会先命中，这张表自动失效。
const APPROVAL_RELEASE = new Map([
  ['PO', (db, p) => transitionPurchaseOrder(db, {
    id: p.id, action: p.action, actor: p.actor, set: p.set, remark: p.remark, source: p.source
  })]
])

/** 审批放行该由哪段代码执行：代码里的「效果归属」优先，其次审批引擎自己的放行表，都没有则 null（拒绝放行） */
function releaseExecutorOf(docType) {
  return effectOwnerOf(docType)?.run || APPROVAL_RELEASE.get(docType) || null
}

// ---------------------------------------------------------------------------
// 提交审批 / 审批决策
// ---------------------------------------------------------------------------

/**
 * 提交审批：显式动作，创建实例。
 * 幂等：同一单据同一动作若已有 pending 实例，直接复用（重复点「提交审批」不该产生两条）。
 */
export function submitApproval(db = getDb(), { docType, docId, docNo = null, action, actor = {}, remark = null }) {
  const type = db.prepare('SELECT code, name, table_name FROM doc_types WHERE code=?').get(docType)
  if (!type) throw new ApprovalError(`未知单据类型 ${docType}`, { code: 'DOC_TYPE_UNKNOWN', httpStatus: 400 })
  const doc = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(docId)
  if (!doc) throw new ApprovalError(`单据 #${docId} 不存在`, { code: 'DOC_NOT_FOUND', httpStatus: 404 })

  const actionName = db
    .prepare('SELECT action_name FROM doc_actions WHERE doc_type=? AND action=? LIMIT 1')
    .get(docType, action)?.action_name || action

  const amount = amountOf(docType, doc)
  const gate = approvalGate(db, { docType, docId, action, amount })
  if (!gate) {
    // 不需要审批（或已批准）——重复提交是调用方搞错了，如实告知，不假装成功
    throw new ApprovalError('该动作当前不需要审批（模板未启用或已审批通过）', {
      code: 'APPROVAL_NOT_REQUIRED',
      httpStatus: 400
    })
  }
  if (gate.pending) return getInstance(db, gate.pending.id)

  const steps = stepsOfTemplate(db, gate.template.id)
  if (!steps.length) {
    throw new ApprovalError(`审批模板「${gate.template.name}」未配置审批级次`, {
      code: 'APPROVAL_TEMPLATE_EMPTY',
      httpStatus: 500
    })
  }
  const first = steps[0]
  const approverText = describeApprover(db, first.approver_type, first.approver_value)

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO approval_instances
          (template_id,template_code,doc_type,doc_id,doc_no,action,action_name,amount,
           total_steps,current_step,status,current_approver,submitted_by_id,submitted_by,submitted_at,remark,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,1,'pending',?,?,?,?,?,?)`
      )
      .run(
        gate.template.id,
        gate.template.code,
        docType,
        docId,
        docNo || doc.doc_no || null,
        action,
        actionName,
        round2(amount),
        steps.length,
        approverText,
        actor.id ?? null,
        actor.name ?? null,
        nowStr(),
        remark,
        nowStr()
      )
    db.prepare(
      `INSERT INTO approval_records (instance_id,step_no,step_name,decision,approver_id,approver_name,comment,decided_at)
       VALUES (?,0,?,?,?,?,?,?)`
    ).run(info.lastInsertRowid, '提交审批', 'submit', actor.id ?? null, actor.name ?? null, remark, nowStr())
    return info.lastInsertRowid
  })
  const id = tx()

  // 提交审批本身也要留痕到单据时间线：否则单据上的 doc_events 会出现一段「空白期」，
  // 事后审计会以为单据卡住了。
  try {
    db.prepare(
      `INSERT INTO doc_events
        (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      docType, docId, docNo || doc.doc_no || null,
      '__approval_submit', '提交审批',
      doc.status || null, doc.status || null,
      actor.id ?? null, actor.name ?? null, 'approval',
      `审批实例 #${id}（${approverText}）`, nowStr()
    )
  } catch { /* 留痕失败不影响审批本身 */ }

  return getInstance(db, id)
}

export function getInstance(db = getDb(), id) {
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id=?').get(id)
  if (!inst) return null
  const records = db
    .prepare('SELECT * FROM approval_records WHERE instance_id=? ORDER BY id')
    .all(id)
  const steps = inst.template_id ? stepsOfTemplate(db, inst.template_id) : []
  return {
    ...inst,
    steps: steps.map((s) => ({ ...s, approver_text: describeApprover(db, s.approver_type, s.approver_value) })),
    records,
    doc_title: docTitleOf(db, inst.doc_type, inst.doc_id)
  }
}

function docTitleOf(db, docType, docId) {
  const t = db.prepare('SELECT table_name FROM doc_types WHERE code=?').get(docType)
  if (!t) return null
  const row = db.prepare(`SELECT * FROM ${t.table_name} WHERE id=?`).get(docId)
  if (!row) return null
  const partyName = row.supplier_id
    ? db.prepare('SELECT name FROM suppliers WHERE id=?').get(row.supplier_id)?.name
    : null
  return {
    doc_no: row.doc_no || null,
    status: row.status || null,
    amount: amountOf(docType, row),
    party: partyName || null,
    biz_date: row.order_date || row.biz_date || row.doc_date || row.created_at || null
  }
}

/** 判断某人能不能审当前这一级 */
export function canApproveStep(db, step, actor) {
  if (!step || !actor?.id) return false
  const u = db.prepare('SELECT id, role, is_super FROM users WHERE id=?').get(actor.id)
  if (u?.is_super || u?.role === 'admin') return true
  if (step.approver_type === 'user') return Number(step.approver_value) === Number(actor.id)
  if (step.approver_type === 'role') {
    if (u?.role === step.approver_value) return true
    const hit = db.prepare('SELECT 1 FROM user_roles WHERE user_id=? AND role_code=?').get(actor.id, step.approver_value)
    return !!hit
  }
  if (step.approver_type === 'perm') {
    return userPermissions(db, actor.id, u?.role).includes(step.approver_value)
  }
  return false
}

/**
 * 审批决策。
 * @param {function} [apply] 最后一级通过后要执行的业务流转。**必须由调用方传入** ——
 *        审批引擎不认识任何业务，它只负责「按级次放行」。
 */
export function decideApproval(db = getDb(), { instanceId, decision, comment = null, actor = {}, apply = null }) {
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id=?').get(instanceId)
  if (!inst) throw new ApprovalError(`审批实例 #${instanceId} 不存在`, { code: 'APPROVAL_NOT_FOUND', httpStatus: 404 })
  if (inst.status !== 'pending') {
    throw new ApprovalError(`该审批已${statusText(inst.status)}，不能重复处理`, {
      code: 'APPROVAL_NOT_PENDING',
      httpStatus: 409,
      detail: { status: inst.status }
    })
  }
  if (!['approve', 'reject'].includes(decision)) {
    throw new ApprovalError('decision 只能是 approve / reject', { code: 'DECISION_INVALID', httpStatus: 400 })
  }

  const steps = stepsOfTemplate(db, inst.template_id)
  const step = steps.find((s) => s.step_no === inst.current_step)
  if (!canApproveStep(db, step, actor)) {
    throw new ApprovalError(
      `当前级（${step?.step_name || inst.current_step}）不由你审批 —— 需要：${describeApprover(db, step?.approver_type, step?.approver_value)}`,
      { code: 'APPROVAL_NOT_ASSIGNED', httpStatus: 403, detail: { step: inst.current_step } }
    )
  }

  const stepName = step?.step_name || `第 ${inst.current_step} 级`

  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO approval_records (instance_id,step_no,step_name,decision,approver_id,approver_name,comment,decided_at)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(instanceId, inst.current_step, stepName, decision, actor.id ?? null, actor.name ?? null, comment, nowStr())

    if (decision === 'reject') {
      db.prepare(
        `UPDATE approval_instances SET status='rejected', decided_at=?, current_approver=NULL, updated_at=? WHERE id=?`
      ).run(nowStr(), nowStr(), instanceId)
      return { done: false, rejected: true, step: inst.current_step }
    }

    if (inst.current_step < inst.total_steps) {
      const nextStep = steps.find((s) => s.step_no === inst.current_step + 1)
      const nextText = describeApprover(db, nextStep?.approver_type, nextStep?.approver_value)
      db.prepare(
        `UPDATE approval_instances SET current_step=?, current_approver=?, updated_at=? WHERE id=?`
      ).run(inst.current_step + 1, nextText, nowStr(), instanceId)
      return { done: false, rejected: false, step: inst.current_step, nextStep: inst.current_step + 1, nextApprover: nextText }
    }

    // 最后一级：先落 approved，再放行 —— 顺序不能反。
    // 反过来（先放行再落状态）会给 applyTransition 里的闸门看到「还没批准」，
    // 于是它又把流转拦住，形成死循环。
    db.prepare(
      `UPDATE approval_instances SET status='approved', decided_at=?, current_approver=NULL, updated_at=? WHERE id=?`
    ).run(nowStr(), nowStr(), instanceId)
    return { done: true, rejected: false, step: inst.current_step }
  })
  const r = tx()

  let applied = null
  if (r.done) {
    // 审批通过 → 业务流转。**失败必须抛出去**（见文件头口径 ③）。
    // 默认执行器 = 「效果归属」优先、其次审批引擎自己的放行表（见口径④与 APPROVAL_RELEASE）：
    // 与该动作的**业务入口同一条路径**，不是 `applyTransition` 那种"只翻状态"。
    // 两种都找不到时**拒绝放行**并指路（`EFFECT_REQUIRES_BUSINESS_API`）——
    // 宁可拒绝放行，也不要静默只翻状态。
    const fn = apply || (() => {
      const run = releaseExecutorOf(inst.doc_type)
      if (!run) {
        // 拒绝放行时必须**指路**（027 策略表里写着该类型该走哪个业务入口）
        const pol = db.prepare('SELECT effect_owner FROM doc_transition_policy WHERE doc_type=?').get(inst.doc_type)
        const entry = pol?.effect_owner || `${inst.doc_type} 的业务接口`
        throw new ApprovalError(
          `「${inst.doc_type}」的流转带业务后果，审批放行不直接执行它。请走：${entry}`,
          {
            code: 'EFFECT_REQUIRES_BUSINESS_API', httpStatus: 409,
            detail: { docType: inst.doc_type, docId: inst.doc_id, action: inst.action, instanceId, entry }
          }
        )
      }
      return run(db, {
        db, docType: inst.doc_type, id: inst.doc_id, action: inst.action,
        actor, source: 'approval', remark: `审批实例 #${instanceId} 通过后自动执行`
      })
    })
    applied = fn()
    try {
      db.prepare(
        `INSERT INTO doc_events
          (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        inst.doc_type, inst.doc_id, inst.doc_no,
        '__approval_pass', '审批通过',
        applied?.from ?? null, applied?.to ?? null,
        actor.id ?? null, actor.name ?? null, 'approval',
        `审批实例 #${instanceId} 全部通过，业务动作「${inst.action_name || inst.action}」已执行`, nowStr()
      )
    } catch { /* 留痕失败不影响业务 */ }
  } else if (r.rejected) {
    try {
      db.prepare(
        `INSERT INTO doc_events
          (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        inst.doc_type, inst.doc_id, inst.doc_no,
        '__approval_reject', '审批驳回', null, null,
        actor.id ?? null, actor.name ?? null, 'approval',
        `审批实例 #${instanceId} 在第 ${inst.current_step} 级被驳回${comment ? `：${comment}` : ''}`, nowStr()
      )
    } catch { /* ignore */ }
  }

  return { ...r, instance: getInstance(db, instanceId), applied }
}

/** 撤回审批（提交人自己撤销，或管理员） */
export function cancelApproval(db = getDb(), { instanceId, actor = {}, comment = null }) {
  const inst = db.prepare('SELECT * FROM approval_instances WHERE id=?').get(instanceId)
  if (!inst) throw new ApprovalError(`审批实例 #${instanceId} 不存在`, { code: 'APPROVAL_NOT_FOUND', httpStatus: 404 })
  if (inst.status !== 'pending') {
    throw new ApprovalError(`该审批已${statusText(inst.status)}，不能撤回`, { code: 'APPROVAL_NOT_PENDING', httpStatus: 409 })
  }
  const u = db.prepare('SELECT is_super, role FROM users WHERE id=?').get(actor.id)
  const isOwner = Number(inst.submitted_by_id) === Number(actor.id)
  if (!isOwner && !u?.is_super && u?.role !== 'admin') {
    throw new ApprovalError('只有提交人本人或管理员可以撤回审批', { code: 'APPROVAL_CANCEL_FORBIDDEN', httpStatus: 403 })
  }
  db.prepare(
    `INSERT INTO approval_records (instance_id,step_no,step_name,decision,approver_id,approver_name,comment,decided_at)
     VALUES (?,?,?,'cancel',?,?,?,?)`
  ).run(instanceId, inst.current_step, '撤回审批', actor.id ?? null, actor.name ?? null, comment, nowStr())
  db.prepare(
    `UPDATE approval_instances SET status='canceled', decided_at=?, current_approver=NULL, updated_at=? WHERE id=?`
  ).run(nowStr(), nowStr(), instanceId)
  return getInstance(db, instanceId)
}

function statusText(s) {
  return { pending: '待审批', approved: '通过', rejected: '驳回', canceled: '撤回' }[s] || s
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function listInstances(db = getDb(), { status = null, docType = null, page = 1, pageSize = 20, mine = null } = {}) {
  const cond = []
  const args = []
  if (status) { cond.push('i.status=?'); args.push(status) }
  if (docType) { cond.push('i.doc_type=?'); args.push(docType) }
  if (mine) { cond.push('i.submitted_by_id=?'); args.push(mine) }
  const where = cond.length ? `WHERE ${cond.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM approval_instances i ${where}`).get(...args).c
  const list = db
    .prepare(
      `SELECT i.*, s.name AS template_name
         FROM approval_instances i
         LEFT JOIN approval_templates s ON s.id = i.template_id
         ${where}
        ORDER BY CASE i.status WHEN 'pending' THEN 0 ELSE 1 END, i.id DESC
        LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  return { list: list.map((r) => ({ ...r, doc_title: docTitleOf(db, r.doc_type, r.doc_id) })), total, page, pageSize }
}

/**
 * 「我能处理的 pending 实例」的**唯一**判据：admin / 超管 / 持有 `system:approval:manage`
 * 的审批管理员全见；其余只保留当前级指到本人头上的实例（`canApproveStep`）。
 * 「待我审批」列表与审批待办计数（ADR-0015）都从这里取，不各写一份过滤。
 */
export function pendingInstancesFor(db = getDb(), actor) {
  const u = db.prepare('SELECT id, role, is_super FROM users WHERE id=?').get(actor?.id)
  const seesAll = !!u?.is_super || u?.role === 'admin' || userPermissions(db, actor?.id, u?.role).includes('system:approval:manage')
  const rows = db
    .prepare(
      `SELECT i.*, t.name AS template_name
         FROM approval_instances i
         LEFT JOIN approval_templates t ON t.id = i.template_id
        WHERE i.status='pending'
        ORDER BY i.id DESC`
    )
    .all()
  if (seesAll) return rows
  const stepOf = db.prepare('SELECT * FROM approval_steps WHERE template_id=? AND step_no=?')
  return rows.filter((r) => canApproveStep(db, stepOf.get(r.template_id, r.current_step), actor))
}

/** 「待我审批」：当前级指到我头上的 pending 实例（admin / 审批管理员全见） */
export function pendingForMe(db = getDb(), actor, { page = 1, pageSize = 20 } = {}) {
  const mine = pendingInstancesFor(db, actor)
  const total = mine.length
  const slice = mine.slice((page - 1) * pageSize, page * pageSize)
  return { list: slice.map((r) => ({ ...r, doc_title: docTitleOf(db, r.doc_type, r.doc_id) })), total, page, pageSize }
}

export function listTemplates(db = getDb()) {
  const list = db.prepare('SELECT * FROM approval_templates ORDER BY doc_type, priority DESC, id').all()
  return list.map((t) => ({
    ...t,
    steps: stepsOfTemplate(db, t.id).map((s) => ({ ...s, approver_text: describeApprover(db, s.approver_type, s.approver_value) })),
    doc_type_name: db.prepare('SELECT name FROM doc_types WHERE code=?').get(t.doc_type)?.name || t.doc_type,
    action_name: db.prepare('SELECT action_name FROM doc_actions WHERE doc_type=? AND action=? LIMIT 1').get(t.doc_type, t.action)?.action_name || t.action
  }))
}

export function approvalOverview(db = getDb()) {
  const q = (sql, ...a) => db.prepare(sql).get(...a)
  const pending = q(`SELECT COUNT(*) c FROM approval_instances WHERE status='pending'`).c
  const approved = q(`SELECT COUNT(*) c FROM approval_instances WHERE status='approved'`).c
  const rejected = q(`SELECT COUNT(*) c FROM approval_instances WHERE status='rejected'`).c
  const canceled = q(`SELECT COUNT(*) c FROM approval_instances WHERE status='canceled'`).c
  const tplOn = q(`SELECT COUNT(*) c FROM approval_templates WHERE enabled=1`).c
  const tplAll = q(`SELECT COUNT(*) c FROM approval_templates`).c
  const pendingAmount = q(`SELECT COALESCE(SUM(amount),0) s FROM approval_instances WHERE status='pending'`).s
  const byType = db
    .prepare(
      `SELECT doc_type, COUNT(*) c FROM approval_instances WHERE status='pending' GROUP BY doc_type ORDER BY c DESC`
    )
    .all()
  const last = q(`SELECT MAX(decided_at) t FROM approval_instances WHERE status<>'pending'`).t
  return {
    pending, approved, rejected, canceled,
    total: pending + approved + rejected + canceled,
    templates_enabled: tplOn,
    templates_total: tplAll,
    pending_amount: round2(pendingAmount),
    by_doc_type: byType,
    last_decided_at: last
  }
}

/**
 * 扁平待办项（供消息推送 013 复用）。
 * 形状必须与 `purchaseTodos` 逐字一致（kind/doc_type/doc_no/amount）——
 * 推送侧的摘要组装对两者一视同仁，形状不同就得在那边写分支，
 * 而那种分支一旦漏改，表现是「推送里少了一类待办」，不会报错。
 */
export function approvalTodoItems(db = getDb()) {
  return db
    .prepare(
      `SELECT id, doc_type, doc_no, amount, action_name
         FROM approval_instances WHERE status='pending' ORDER BY id`
    )
    .all()
    .map((r) => ({
      kind: 'approval_pending',
      doc_type: r.doc_type,
      doc_no: r.doc_no,
      amount: round2(r.amount)
    }))
}

/** 把 pending 实例按「单据类型 · 动作」分组成待办摘要（全库与按人两条路共用同一个形状） */
function groupTodos(db, rows) {
  const groups = new Map()
  for (const r of rows) {
    const key = `${r.doc_type}|${r.action}|${r.action_name || ''}`
    const g = groups.get(key) || { doc_type: r.doc_type, action: r.action, action_name: r.action_name, c: 0, amt: 0 }
    g.c += 1
    g.amt += Number(r.amount) || 0
    groups.set(key, g)
  }
  const sorted = [...groups.values()].sort((a, b) => b.c - a.c)
  return {
    kind: 'approval_pending',
    label: '待审批单据',
    count: rows.length,
    groups: sorted.map((r) => ({
      name: `${db.prepare('SELECT name FROM doc_types WHERE code=?').get(r.doc_type)?.name || r.doc_type} · ${r.action_name || r.action}`,
      count: r.c,
      amount: round2(r.amt)
    }))
  }
}

/** 审批待办（供消息推送 013 使用）：**全库** pending，按单据类型分组。调用方须自行把住全局数据范围门（ADR-0008）。 */
export function approvalTodos(db = getDb()) {
  return groupTodos(db, db.prepare(`SELECT doc_type, action, action_name, amount FROM approval_instances WHERE status='pending'`).all())
}

/** 审批待办（按人，ADR-0015）：只统计 `pendingInstancesFor` 认为调用者能处理的实例，形状与 `approvalTodos` 一致。 */
export function approvalTodosFor(db = getDb(), actor) {
  return { ...groupTodos(db, pendingInstancesFor(db, actor)), scope: 'mine' }
}

export default {
  ApprovalError, amountOf, matchTemplate, stepsOfTemplate, describeApprover,
  approvalGate, submitApproval, getInstance, canApproveStep,
  decideApproval, cancelApproval, listInstances, pendingForMe, pendingInstancesFor,
  listTemplates, approvalOverview, approvalTodos, approvalTodosFor, approvalTodoItems
}
