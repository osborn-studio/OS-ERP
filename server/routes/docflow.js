/**
 * ============================================================================
 * 文件标识：server/routes/docflow.js ｜ 单据内核接口：状态机查询 / 统一流转 / 流转留痕 / 业务流 / 编码规则
 * ============================================================================
 * 【职责】单据内核接口：状态机查询 / 统一流转 / 流转留痕 / 业务流 / 编码规则
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 单据内核接口：状态机查询 / 统一流转 / 流转留痕 / 业务流 / 编码规则
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, bizFail } from '../lib/http.js'
import {
  requireAuth,
  requirePerm,
  requireInternal,
  permContext,
  hasPerm,
  assertCanRead,
  isExternalUser,
  attachOrgScope,
  resolveOrgScope,
  // 内部模块码的**唯一出处**已提到 middleware/auth.js（批次 T：审批提交入口也要用同一条判定）
  INTERNAL_MODULES
} from '../middleware/auth.js'
import {
  DocFlowError,
  listDocTypes,
  getDocType,
  getMachine,
  allowedActions,
  assertEdgePermitted,
  dispatchTransition,
  effectOwnerOf,
  historyOf,
  traceByDocNo,
  docEventScope,
  docScopeOf,
  docInScope,
  DOC_SCOPE_RESOLVERS,
  explainLifecycle,
  createPermOf
} from '../lib/docflow.js'
import { listDocNoRules, previewDocNo, nextDocNoAuto, nextDocNoByRule } from '../lib/docno.js'
import { audit } from '../middleware/audit.js'
import { readSetting } from '../lib/settings.js'
// 领域库在求值期把各自的范围谓词登记到 doc-scope-registry；本路由依赖它们，显式 import 保证一定已登记（ADR-0032）。
import '../lib/purchase.js'
import '../lib/sales-order.js'
import '../lib/order-center.js'

/** 读接口的范围上下文：req.orgScope 由 attachOrgScope 挂上；缺失 ⇒ 失败关闭（按无范围算）。 */
const scopeCtx = (req) => {
  const db = getDb()
  // ADR-0051：默认严格门店绑定（未绑门店的非总部账号读不到 RC / YQ / SH），总部角色豁免；设置键 docflow_strict_store_binding=0 回退
  const strict = readSetting(db, 'docflow_strict_store_binding') === true
  return { db, user: req.user, orgScope: req.orgScope || { scope: 'none', orgIds: [] }, strictBinding: strict, hqExempt: strict }
}

const r = Router()

/**
 * 外部主体（经销商/门店）不得驱动的内部单据域 —— 与"能不能看"同源，按模块判定。
 *
 * ⚠️ 这里**刻意不含 `order-center`**：订货中心正是外部主体该动的地方
 * （经销商下单、门店要货），把它们一起关掉就等于把功能砍了。
 * 那边的越权由它自己的口径管（`customer_id` 是不是自己的单，见 ocAccessCheck）。
 * 这一条与"数据范围"是两件事：范围管"哪些行"，这条管"这类单能不能碰"。
 *
 * ⚠️ 集合本身已提到 `middleware/auth.js`（批次 T 挪的）：审批提交入口也要用同一条判定，
 * 在两个文件里各写一份 const 就是"同一份判据有两个实现"。这里只留说明。
 */

/**
 * 把 DocFlowError 翻译成统一的失败响应；其它错误继续抛给全局错误处理。
 *
 * 形状不再在这里手写 —— 唯一出处是 `lib/http.js` 的 `bizFail`。
 * （这里原本把业务码两处都写，是对的，但"对的只有这一处"等于另外两个入口是歪的；
 *  现在三处共用同一份实现，见 `bizFail` 上的说明。）
 *
 * 导出是为了让 `scripts/check-bizcode-shape.mjs` 能在进程内直接驱动它，
 * 与 `errorHandler` / `failFromError` 对拍形状 —— 形状不一致是"读法对不上"的根因，
 * 光靠静态扫源码证不了三个入口真的产出同一份 JSON。
 */
export function handleFlowError(res, e) {
  if (e instanceof DocFlowError) return bizFail(res, e)
  throw e
}

// ---------------------------------------------------------------------------
// 一、单据内核总览
// ---------------------------------------------------------------------------

r.get(
  '/overview',
  requireAuth,
  attachOrgScope,
  requireInternal('全局单据总览'),
  wrap((req, res) => {
    const db = getDb()
    const c = (sql) => db.prepare(sql).get().c
    // ADR-0032：流转留痕与状态分布按账号数据范围统计；总数（类型 / 状态 / 动作 / 业务流 / 规则）是静态定义，不含单据数据。
    const ctx = scopeCtx(req)
    const evScope = docEventScope(ctx, 'e')
    const recent = db
      .prepare(
        `SELECT e.doc_type,e.doc_no,e.action_name,e.from_state,e.to_state,e.actor_name,e.source,e.created_at
         FROM doc_events e WHERE ${evScope.sql} ORDER BY e.id DESC LIMIT 12`
      )
      .all(...evScope.params)
    // 各单据类型的实际状态分布（用真实数据回答「现在系统里有多少单在什么状态」）；只统计范围内的单据
    const dist = []
    for (const t of db.prepare("SELECT code,name,table_name FROM doc_types WHERE status='active' ORDER BY sort_order").all()) {
      const p = docScopeOf(ctx, t.code)
      if (!p) continue
      try {
        const rows = db
          .prepare(`SELECT status s, COUNT(*) c FROM ${t.table_name} t WHERE ${p.all ? '1=1' : p.sql} GROUP BY status`)
          .all(...(p.all ? [] : p.params))
        if (!rows.length) continue
        dist.push({ docType: t.code, name: t.name, total: rows.reduce((n, x) => n + x.c, 0), states: rows.map((x) => ({ state: x.s, count: x.c })) })
      } catch {
        /* 表缺失则跳过 */
      }
    }
    return ok(res, {
      docTypes: c("SELECT COUNT(*) c FROM doc_types WHERE status='active'"),
      states: c('SELECT COUNT(*) c FROM doc_states'),
      actions: c('SELECT COUNT(*) c FROM doc_actions'),
      flows: c("SELECT COUNT(*) c FROM biz_flows WHERE status='active'"),
      events: db.prepare(`SELECT COUNT(*) c FROM doc_events e WHERE ${evScope.sql}`).get(...evScope.params).c,
      noRules: c("SELECT COUNT(*) c FROM doc_no_rules WHERE status='active'"),
      recent,
      distribution: dist
    })
  })
)

// ---------------------------------------------------------------------------
// 二、状态机查询
// ---------------------------------------------------------------------------

r.get(
  '/types',
  requireAuth,
  wrap((req, res) => ok(res, listDocTypes(getDb(), { module: req.query.module })))
)

/** 完整状态机（前端据此画流转图、生成按钮） */
r.get(
  '/types/:code/machine',
  requireAuth,
  wrap((req, res) => {
    try {
      return ok(res, getMachine(getDb(), req.params.code))
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

/** 文本版生命周期说明（技术文档 / 交付材料可直接引用） */
r.get(
  '/types/:code/lifecycle',
  requireAuth,
  wrap((req, res) => {
    try {
      return ok(res, { text: explainLifecycle(getDb(), req.params.code) })
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

/** 某状态下可做什么（前端按钮显隐直接读这个，不再各页写死） */
r.get(
  '/actions',
  requireAuth,
  wrap((req, res) => {
    const { doc_type: docType, status } = req.query
    if (!docType || !status) return fail(res, '需要 doc_type 与 status')
    try {
      const perms = new Set(req.user.perms || [])
      if (req.user.is_super) perms.add('*')
      return ok(res, allowedActions(getDb(), docType, status, { perms }))
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

// ---------------------------------------------------------------------------
// 三、统一流转（本模块的核心接口）
// ---------------------------------------------------------------------------
// ⚠️ 这个入口的语义在 027 之后**变了**，必须写清楚：
//
//   以前：传 doc_type + id + action 就能改任何单据的状态 —— 它只有 requireAuth，
//         内核只做「校验边 → 改状态 → 写留痕」三件事，**不知道这条边有没有业务后果**。
//         于是可以造出「状态对了、账不对」的单据：SO 直接 ship（库存没出）、
//         RCP 直接 confirm（应收没核销）、POS 直接核款（现金长短款没记）。
//         这些单不会报错，只是一批看起来正常的单，而所有下游报表都建立在这个状态上。
//
//   现在：入口只做四道判定，然后**把执行交给真正的归属方**：
//     ① 单据要在本主体的数据范围内（与列表/详情**同一份**判据 assertCanRead）
//     ② 外部主体不得驱动内部单据域（与"能不能看"同源按模块判定）
//     ③ 这条边的 perm_code 当前身份必须持有（与 requirePerm **同一份**判据 permContext）
//     ④ 执行：有归属服务 → 委托（与业务入口同一段代码）；显式放开的纯状态类型 → 内核；
//        其余 → 409 并指出该走哪个业务入口
//
//   语义收窄是**刻意的**。一个"能改任何单据状态"的接口在带账务的 ERP 里本就不该存在：
//   没有哪个报表能区分「走正门进来的已发货」和「只改了状态的已发货」。
//   要放开某个**纯状态**单据类型（改了不影响任何数字），把策略表
//   `doc_transition_policy.allow_generic` 置 1 即可 —— 数据配置，不改代码。

r.post(
  '/transition',
  requireAuth,
  attachOrgScope,
  wrap((req, res) => {
    const db = getDb()
    const { doc_type: docType, id, action, remark, set } = req.body || {}
    if (!docType || !id || !action) return fail(res, '需要 doc_type / id / action')
    try {
      const type = getDocType(db, docType)
      const row = db.prepare(`SELECT * FROM ${type.table_name} WHERE id=?`).get(Number(id))

      // ① 单据级越权判定
      //    有归属服务的单据用它自己那套口径（订货中心按 customer_id 判"是不是我的单"）；
      //    其余走通用的数据范围判据（与列表 scopeFilter / 详情 assertCanRead 同一份）。
      //    **不在这里另写第三套** —— "这一行的范围怎么算"必须只有一个定义处。
      const owner = effectOwnerOf(type.code)
      const access = owner && owner.canAccess ? owner.canAccess(db, req, row) : assertCanRead(req, row)
      if (!access.ok) return fail(res, access.message, access.status)
      // ADR-0051（Codex 审计）：带门店绑定的类型（RC / YQ / SH）在驱动前也过绑定闸，否则对未绑门店的非总部账号，
      // 错误响应（409 的 docNo 等）会泄露其不可见单据；与读接口同一份 docInScope，范围外与不存在同形 404
      if (row && DOC_SCOPE_RESOLVERS[type.code]?.binding && !docInScope(scopeCtx(req), type.code, row.id)) return fail(res, '记录不存在', 404)

      // ② 外部主体不得驱动内部单据域
      if (INTERNAL_MODULES.has(type.module) && isExternalUser(req)) {
        return fail(res, `当前角色无权操作「${type.name}」`, 403)
      }

      // ③ 功能权限门：这条边的 perm_code（唯一判据 assertEdgePermitted）
      const permCtx = permContext(db, req.user)
      assertEdgePermitted({
        db,
        docType: type.code,
        fromState: row[type.status_field || 'status'],
        action,
        permCtx,
        entry: 'POST /api/docflow/transition'
      })

      // ④ 执行：委托给归属服务 / 纯状态走内核 / 其余拒绝
      const out = dispatchTransition({
        db,
        docType: type.code,
        id: Number(id),
        action,
        set: set && typeof set === 'object' ? set : null,
        remark,
        actor: { id: req.user.uid, name: req.user.name || req.user.username },
        source: 'api',
        orgId: req.user.org_id ?? null
      })
      audit(req, { action: action.toUpperCase(), module: 'docflow', entity: type.code, entityId: Number(id) })
      return ok(res, out)
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

/** 单据一生：按时间正序的完整流转史 */
r.get(
  '/history/:docType/:id',
  requireAuth,
  attachOrgScope,
  requireInternal('总部单据历史；订货方请查看自己的业务单据'),
  wrap((req, res) => {
    try {
      const db = getDb()
      const ctx = scopeCtx(req)
      // ADR-0032：先解析类型（未注册 ⇒ 404），再核对单据在范围内；范围外与不存在同形 404，不泄漏存在性
      const type = getDocType(db, req.params.docType)
      if (!docInScope(ctx, type.code, req.params.id)) return fail(res, '单据不存在', 404)
      return ok(res, historyOf(db, { docType: type.code, id: Number(req.params.id), scope: docEventScope(ctx, 'doc_events') }))
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

/** 全链路联查：给一个单号，把关联单据的流转串起来 */
r.get(
  '/trace',
  requireAuth,
  attachOrgScope,
  requireInternal('总部单据联查'),
  wrap((req, res) => {
    if (!req.query.doc_no) return fail(res, '需要 doc_no')
    // ADR-0032：命中单号与 payload 关联的事件都只返回范围内单据的留痕（范围外 ⇒ 空列表，与无此单号同形）
    return ok(res, traceByDocNo(getDb(), String(req.query.doc_no), { scope: docEventScope(scopeCtx(req), 'doc_events') }))
  })
)

/** 全局流转日志（可按单据类型 / 来源过滤） */
r.get(
  '/events',
  requireAuth,
  attachOrgScope,
  requireInternal('全局单据日志'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    // ADR-0032：先套范围谓词（别名 doc_events），再叠加调用者的过滤条件
    const evScope = docEventScope(scopeCtx(req), 'doc_events')
    const conds = [evScope.sql]
    const args = [...evScope.params]
    if (req.query.doc_type) {
      conds.push('doc_type=?')
      args.push(String(req.query.doc_type))
    }
    if (req.query.source) {
      conds.push('source=?')
      args.push(String(req.query.source))
    }
    if (req.query.action) {
      conds.push('action=?')
      args.push(String(req.query.action))
    }
    const where = conds.join(' AND ')
    const total = db.prepare(`SELECT COUNT(*) c FROM doc_events WHERE ${where}`).get(...args).c
    const rows = db
      .prepare(`SELECT * FROM doc_events WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...args, pageSize, offset)
    return ok(res, { list: rows, total, page, pageSize })
  })
)

// ---------------------------------------------------------------------------
// 四、业务流
// ---------------------------------------------------------------------------

r.get(
  '/flows',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const flows = db.prepare("SELECT * FROM biz_flows WHERE status='active' ORDER BY code").all()
    const steps = db.prepare('SELECT * FROM biz_flow_steps ORDER BY flow_code, seq').all()
    return ok(
      res,
      flows.map((f) => ({ ...f, steps: steps.filter((s) => s.flow_code === f.code) }))
    )
  })
)

r.get(
  '/flows/:code',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const f = db.prepare('SELECT * FROM biz_flows WHERE code=?').get(req.params.code)
    if (!f) return fail(res, '业务流不存在', 404)
    const steps = db.prepare('SELECT * FROM biz_flow_steps WHERE flow_code=? ORDER BY seq').all(f.code)
    return ok(res, { ...f, steps })
  })
)

// ---------------------------------------------------------------------------
// 五、编码规则（模块 06）
// ---------------------------------------------------------------------------

r.get(
  '/no-rules',
  requireAuth,
  wrap((req, res) => ok(res, listDocNoRules(getDb())))
)

/** 规则效果预览（不消耗序号） */
r.post(
  '/no-preview',
  requireAuth,
  wrap((req, res) => {
    const { doc_type: docType, pattern, seq_pad: seqPad, seq, biz_date: bizDate, org_id: orgId, warehouse_id: whId } = req.body || {}
    if (!docType || !pattern) return fail(res, '需要 doc_type 与 pattern')
    const db = getDb()
    return ok(res, {
      sample: previewDocNo(db, {
        docType,
        pattern,
        seqPad: seqPad ? Number(seqPad) : 4,
        seq: seq ? Number(seq) : 1,
        bizDate,
        orgId: orgId ? Number(orgId) : null,
        warehouseId: whId ? Number(whId) : null
      }),
      tokens: ['{PREFIX}', '{TYPE}', '{YYYY}', '{YY}', '{MM}', '{DD}', '{HH}', '{mm}', '{SS}', '{ORG}', '{WH}', '{STORE}', '{SEQ}', '{SEQ:5}', '{RAND:3}']
    })
  })
)

/** 新增/修改规则（upsert） */
r.post(
  '/no-rules',
  requireAuth,
  requirePerm('system:docno:manage'),
  wrap((req, res) => {
    const db = getDb()
    const {
      doc_type: docType,
      name,
      scope_type: scopeType = 'global',
      scope_value: scopeValue = '',
      pattern,
      period = 'day',
      seq_pad: seqPad = 4,
      seq_start: seqStart = 1,
      remark
    } = req.body || {}
    if (!docType || !pattern) return fail(res, '需要 doc_type 与 pattern')
    try {
      getDocType(db, docType)
    } catch (e) {
      return handleFlowError(res, e)
    }
    db.prepare(
      `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(doc_type,scope_type,scope_value) DO UPDATE SET
         name=excluded.name, pattern=excluded.pattern, period=excluded.period,
         seq_pad=excluded.seq_pad, seq_start=excluded.seq_start,
         remark=excluded.remark, updated_at=excluded.updated_at`
    ).run(docType, name || null, String(scopeType), String(scopeValue ?? ''), pattern, period, Number(seqPad), Number(seqStart), remark || null)
    audit(req, { action: 'UPSERT', module: 'docflow', entity: 'doc_no_rules', entityId: docType })
    return ok(res, listDocNoRules(db).filter((x) => x.doc_type === docType))
  })
)

/**
 * 试取号：真实走一次取号链路（会消耗一个序号，用于联调）。
 *
 * ADR-0028：非干跑要求调用者持有该单据类型的**创建权限**（`DOC_CREATE_PERMS`，唯一映射表）；
 * 类型没有映射（含未注册类型）⇒ 403 `DOC_TYPE_PERM_UNMAPPED`，对管理员同样成立（映射缺项是工程缺口，不是权限问题）。
 * 干跑只读预览、不消耗序号，保持豁免。权限判定在取号**之前**，被拒绝的调用不消耗序号。
 */
r.post(
  '/no-issue',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { doc_type: docType, org_id: orgId, warehouse_id: whId, biz_date: bizDate, dry } = req.body || {}
    if (!docType) return fail(res, '需要 doc_type')
    try {
      if (dry) {
        const rule = db
          .prepare("SELECT * FROM doc_no_rules WHERE doc_type=? AND scope_type='global' AND status='active'")
          .get(docType)
        return ok(res, { docNo: rule ? previewDocNo(db, { docType, pattern: rule.pattern, seqPad: rule.seq_pad }) : null, dry: true })
      }
      const need = createPermOf(docType)
      if (!need) {
        throw new DocFlowError('该单据类型未配置创建权限映射，拒绝取号', { code: 'DOC_TYPE_PERM_UNMAPPED', httpStatus: 403 })
      }
      if (!hasPerm(permContext(db, req.user), need)) {
        throw new DocFlowError(`当前角色无权为该单据类型取号（需 ${need}）`, {
          code: 'DOC_CREATE_PERM_DENIED', httpStatus: 403, detail: { permCode: need }
        })
      }
      const args = {
        docType,
        orgId: orgId ? Number(orgId) : null,
        warehouseId: whId ? Number(whId) : null,
        bizDate
      }
      // 规则按 org / 仓分计数器：受限范围不得替范围外的组织 / 仓取号（会烧别人的序号）。
      const scope = resolveOrgScope(db, req.user)
      if (scope.scope !== 'all' && (args.orgId != null || args.warehouseId != null)) {
        const allowed = new Set((scope.orgIds || []).map(Number))
        const whOrg = args.warehouseId != null ? db.prepare('SELECT org_id FROM warehouses WHERE id=?').get(args.warehouseId)?.org_id : null
        if ((args.orgId != null && !allowed.has(args.orgId)) || (args.warehouseId != null && !allowed.has(Number(whOrg)))) {
          throw new DocFlowError('org_id / warehouse_id 超出当前账号的组织范围，拒绝取号', { code: 'DOC_NO_SCOPE_DENIED', httpStatus: 403 })
        }
      }
      // 先按规则取号；没有规则才回落旧逻辑。**只取一次**：规则命中时再调一次 nextDocNoByRule 会多烧一个序号。
      const byRuleNo = nextDocNoByRule(db, args)
      const no = byRuleNo || nextDocNoAuto(db, args)
      return ok(res, { docNo: no, byRule: !!byRuleNo })
    } catch (e) {
      return handleFlowError(res, e)
    }
  })
)

export default r
