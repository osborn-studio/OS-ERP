/**
 * ============================================================================
 * 文件标识：server/lib/im-sync.js ｜ 钉钉 / 飞书 组织与审批同步 —— **唯一实现**
 * ============================================================================
 * 【职责】钉钉 / 飞书 组织与审批同步 —— **唯一实现**
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
 * 钉钉 / 飞书 组织与审批同步 —— **唯一实现**
 *
 * 把「外部平台上的人和部门」与「本系统里的用户和组织」对应起来，并把外部审批的结果
 * 落到本地审批实例上。**真实 HTTP 调用**与**同步语义**在这里被刻意分开：
 *   · 同步语义（映射、幂等、缺失判定、冲突、留痕、重放）—— 与租户无关，可测、可自证；
 *   · 真实调用 —— 由可注入的 `transport` 负责；没有凭据时**明确拒绝**，不静默返回空。
 *
 * ===========================================================================
 * 三条硬口径（每条都由一次"看起来成功"的失败换来）
 * ===========================================================================
 * ① **空快照 ≠ 大家都离职了。**
 *    transport 必须声明 `complete:true` 才允许做"缺失判定"。没有这个前提时，
 *    一次网络抖动拉回空列表，会把**全公司的人标记为 missing** ——
 *    破坏性、且看起来完全正常（同步 status=ok，missing=137）。
 *    这条与批次 O 的「没有期初登记 ≠ 从零开始」是同一个病。
 *
 * ② **映射与流水同生共死。**
 *    每次落映射都在**同一个事务**里写一条 `im_sync_runs`，并把 `sync_batch` 记到映射行上。
 *    于是"这一行是哪一次同步写下的"永远答得出来 —— 否则事后看见一行孤儿映射，
 *    既不知道谁写的、也不知道该不该删。写入点当场断言 `db.inTransaction`。
 *
 * ③ **不代替人签字。**
 *    外部审批通过了，本地要执行 `decideApproval`，而它要一个真实用户当 actor
 *    （`canApproveStep` 会核他的角色）。所以：外部操作人**必须**先映射到本地用户；
 *    映射不上就记一条冲突、**不决策**。用"系统"或"任意管理员"顶替，
 *    会让审批记录里出现一个从没点过同意的人的名字 —— 那比不同步更糟。
 */
import { getDb } from '../db/index.js'
import { localNow } from './dates.js'
import { decideApproval } from './approval.js'

export class ImError extends Error {
  constructor(code, message, httpStatus = 400, detail = null) {
    super(message)
    this.name = 'ImError'
    this.code = code
    this.httpStatus = httpStatus
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 定义（**唯一出处**）
// ---------------------------------------------------------------------------

/** 平台注册表。加一个平台 = 这里加一行，其余代码不动。 */
export const IM_PLATFORMS = {
  dingtalk: {
    code: 'dingtalk',
    label: '钉钉',
    // 外部状态 → 本地决策。**收起来的字典**：认不出来的状态一律拒绝（不"看起来像通过"就往通过上猜）
    decisionMap: {
      agree: 'approve',
      refuse: 'reject',
      running: null,
      terminated: null,
      canceled: null
    },
    secretEnvHint: 'DINGTALK_APP_SECRET'
  },
  feishu: {
    code: 'feishu',
    label: '飞书',
    decisionMap: {
      APPROVED: 'approve',
      REJECTED: 'reject',
      PENDING: null,
      CANCELED: null,
      DELETED: null
    },
    secretEnvHint: 'FEISHU_APP_SECRET'
  }
}
export const IM_PLATFORM_CODES = Object.keys(IM_PLATFORMS)

/** 同步种类 */
export const SYNC_KINDS = ['org', 'approval']
/** 运行状态 */
export const RUN_STATUS = ['ok', 'partial', 'failed', 'not_configured']
/** 映射实体的存活状态 */
export const MAP_STATUS = ['active', 'missing']

/**
 * 冲突码封闭字典。**每一条都要能回答"人该做什么"**：
 * 只有码没有话的冲突，排障的人得去读代码才知道发生了什么。
 */
export const CONFLICT_CODES = {
  SNAPSHOT_INCOMPLETE: '外部快照不完整（拉取中断或未声明 complete）—— 本次不做"谁已离职"的判定',
  DEPT_UNMAPPED: '外部部门拉回来了，但没有对应的本地组织，人员会挂空',
  DEPT_PARENT_UNMAPPED: '外部部门的上级部门不在本次快照里，树还原不完整',
  USER_UNMAPPED: '外部成员拉回来了，但没有对应的本地用户（未开户）',
  USER_DUPLICATE_MOBILE: '两个外部成员映射到同一个本地用户 —— 需要人工确认谁是谁',
  USER_DEPT_UNMAPPED: '外部成员所属部门没有映射到本地组织',
  EXTERNAL_DEPT_MISSING: '本地映射指向的外部部门已不在快照里（对端可能已删除）',
  APPROVAL_INSTANCE_NOT_FOUND: '外部审批单在本地找不到对应的待审实例',
  APPROVAL_NOT_PENDING: '本地审批实例已经不是 pending，外部结果不覆盖',
  APPROVER_UNMAPPED: '外部审批人没有映射到本地用户，无法代他签字（刻意不代替）',
  APPROVER_NOT_ASSIGNED: '映射到的本地用户不是当前级审批人，拒绝越权决策',
  APPROVAL_DECISION_UNKNOWN: '外部审批状态认不出来 —— 不猜，留冲突给人看'
}
export const CONFLICT_CODE_LIST = Object.keys(CONFLICT_CODES)

// ---------------------------------------------------------------------------
// 传输层（可注入）。默认实现读配置 + 环境变量；没配就**明确拒绝**。
// ---------------------------------------------------------------------------

let injectedTransport = null
/** 注入一个 transport（自检 / 测试用）。传 null 恢复默认。 */
export function setImTransport(fn) {
  injectedTransport = fn
}

/**
 * 取本次要用的 transport。
 * @returns {(req:{platform:string, kind:string, cursor?:string}) => object}
 */
export function getImTransport(db = getDb(), platform = null) {
  if (injectedTransport) return injectedTransport
  return (req) => {
    const cfg = db.prepare('SELECT * FROM im_platform_cfg WHERE platform=?').get(req.platform)
    if (!cfg) {
      throw new ImError('IM_PLATFORM_UNKNOWN', `未登记的平台「${req.platform}」（可选：${IM_PLATFORM_CODES.join(' / ')}）`, 400)
    }
    if (!cfg.enabled) {
      throw new ImError(
        'IM_NOT_CONFIGURED',
        `${cfg.label}未启用：请在系统设置的 IM 同步里填入凭据的环境变量名并启用。` +
          `（密钥**不落库**，库里只存环境变量名，例如 ${cfg.secret_ref || IM_PLATFORMS[req.platform]?.secretEnvHint || 'XXX_APP_SECRET'}）`,
        409,
        { platform: req.platform, hint: cfg.secret_ref || null }
      )
    }
    const secret = cfg.secret_ref ? process.env[cfg.secret_ref] : null
    if (!secret) {
      throw new ImError(
        'IM_NOT_CONFIGURED',
        `${cfg.label}已启用，但环境变量 \`${cfg.secret_ref}\` 里没有值 —— 同步**没有发起**（不会返回空快照，那会被误读成"所有人都离职了"）`,
        409,
        { platform: req.platform, env: cfg.secret_ref }
      )
    }
    // 真实调用留在这里：本项目当前**没有**可用的租户凭据，所以这一段是唯一未被执行的分支。
    // 刻意不写一个"看起来能跑"的假实现 —— 那会让"未测"变成"测过了"。
    throw new ImError(
      'IM_REAL_CALL_NOT_IMPLEMENTED',
      `${cfg.label}的真实 HTTP 调用尚未实现（本机无可用租户凭据）。组织与审批同步的**映射、幂等、缺失判定、冲突与留痕**均已可用，可用「自检」跑通全链路。`,
      501,
      {
        platform: req.platform,
        base_url: cfg.base_url || null,
        next_step: '填入真实凭据后实现 transport，并在 IM_PLATFORMS 里补上接口路径'
      }
    )
  }
}

// ---------------------------------------------------------------------------
// 自检用的固定快照（**不依赖真实租户**）
// ---------------------------------------------------------------------------
// 这些数据是**虚构**的（铁律：演示数据不得影射真实组织）。它们存在的意义是：
// 「映射 → 幂等 → 缺失判定 → 冲突 → 留痕」这一整条链**可以被真的跑一遍**，
// 而不是靠"纸上看过"。
export const SELF_TEST_SNAPSHOT = {
  complete: true,
  cursor: 'self-test-1',
  departments: [
    { id: 'D-ROOT', parent_id: null, name: '演示总部' },
    { id: 'D-EAST', parent_id: 'D-ROOT', name: '演示华东区' },
    { id: 'D-STORE-1', parent_id: 'D-EAST', name: '演示门店一' },
    { id: 'D-GHOST', parent_id: 'D-NOT-IN-SNAPSHOT', name: '演示孤儿部门' }
  ],
  users: [
    { id: 'U-A', union_id: 'UN-A', name: '演示成员甲', mobile: '13000000001', dept_id: 'D-EAST' },
    { id: 'U-B', union_id: 'UN-B', name: '演示成员乙', mobile: '13000000002', dept_id: 'D-GHOST' },
    { id: 'U-C', union_id: 'UN-C', name: '演示成员丙', mobile: null, dept_id: 'D-ROOT' }
  ]
}

// ---------------------------------------------------------------------------
// 快照拉取
// ---------------------------------------------------------------------------
export function fetchOrgSnapshot(db = getDb(), { platform, transport = null } = {}) {
  assertPlatform(platform)
  const t = transport || getImTransport(db, platform)
  const snap = t({ platform, kind: 'org' })
  if (!snap || typeof snap !== 'object') {
    throw new ImError('IM_BAD_SNAPSHOT', 'transport 没有返回快照对象', 500)
  }
  return {
    complete: snap.complete === true,
    cursor: snap.cursor ?? null,
    departments: Array.isArray(snap.departments) ? snap.departments : [],
    users: Array.isArray(snap.users) ? snap.users : []
  }
}

export function fetchApprovalRows(db = getDb(), { platform, transport = null } = {}) {
  assertPlatform(platform)
  const t = transport || getImTransport(db, platform)
  const out = t({ platform, kind: 'approval' })
  return {
    complete: out?.complete === true,
    cursor: out?.cursor ?? null,
    rows: Array.isArray(out?.rows) ? out.rows : []
  }
}

function assertPlatform(platform) {
  if (!IM_PLATFORMS[platform]) {
    throw new ImError('IM_PLATFORM_UNKNOWN', `未登记的平台「${platform}」（可选：${IM_PLATFORM_CODES.join(' / ')}）`, 400)
  }
}

// ---------------------------------------------------------------------------
// 组织同步：计划（**纯函数**）
// ---------------------------------------------------------------------------
/**
 * 把外部快照与本地映射对照，产出"要做什么"。**不落库** —— 想先看结果再决定要不要写，就该能看。
 *
 * 只做三件事：认出「新的」「变了的」「不在快照里的」。
 * 刻意**不**决定"新部门该建成什么 type 的 org" —— 那需要人的判断（是门店还是仓库？），
 * 所以新部门只落映射（`org_id` 留空），并记一条 `DEPT_UNMAPPED` 冲突等人挂接。
 */
export function planOrgSync(db = getDb(), { platform, snapshot } = {}) {
  assertPlatform(platform)
  const snap = snapshot || { complete: false, departments: [], users: [] }
  const deptMap = new Map(
    db.prepare('SELECT * FROM im_dept_map WHERE platform=?').all(platform).map((r) => [r.external_dept_id, r])
  )
  const userMap = new Map(
    db.prepare('SELECT * FROM im_user_map WHERE platform=?').all(platform).map((r) => [r.external_user_id, r])
  )
  const seenDept = new Set(snap.departments.map((d) => String(d.id)))
  const seenUser = new Set(snap.users.map((u) => String(u.id)))

  const plan = { departments: { create: [], update: [], missing: [] }, users: { create: [], update: [], missing: [] }, conflicts: [] }

  for (const d of snap.departments) {
    const extId = String(d.id)
    const cur = deptMap.get(extId)
    if (!cur) plan.departments.create.push(d)
    else if (cur.external_name !== (d.name ?? null) || cur.external_parent_id !== (d.parent_id ?? null)) plan.departments.update.push(d)
    if (d.parent_id && !seenDept.has(String(d.parent_id))) {
      plan.conflicts.push({
        reason_code: 'DEPT_PARENT_UNMAPPED',
        external_id: extId,
        message: `部门「${d.name ?? extId}」的上级 ${d.parent_id} 不在本次快照里 —— 树的这一段还原不出来`
      })
    }
  }
  for (const u of snap.users) {
    const extId = String(u.id)
    const cur = userMap.get(extId)
    if (!cur) plan.users.create.push(u)
    else if (
      cur.external_name !== (u.name ?? null) ||
      cur.mobile !== (u.mobile ?? null) ||
      cur.external_dept_id !== (u.dept_id ?? null)
    ) plan.users.update.push(u)
  }

  // 缺失判定：**只有声明 complete 的快照才允许**（口径 ①）
  if (snap.complete) {
    for (const [extId, row] of deptMap) {
      if (!seenDept.has(extId) && row.status !== 'missing') plan.departments.missing.push(row)
    }
    for (const [extId, row] of userMap) {
      if (!seenUser.has(extId) && row.status !== 'missing') plan.users.missing.push(row)
    }
  } else {
    plan.conflicts.push({
      reason_code: 'SNAPSHOT_INCOMPLETE',
      external_id: null,
      message: CONFLICT_CODES.SNAPSHOT_INCOMPLETE
    })
  }
  return plan
}

// ---------------------------------------------------------------------------
// 组织同步：落库（单事务 + 留痕）
// ---------------------------------------------------------------------------
export function applyOrgSync(db = getDb(), { platform, snapshot, actor = null, trigger = 'web', transport = null } = {}) {
  assertPlatform(platform)
  if (!db.inTransaction) {
    // 与 `logSettingChange` / `logReportConfigChange` 同一族的当场断言：
    // "写映射"与"写流水"必须同生共死。写成文档没人记得，写成断言才拦得住。
    return db.transaction(() => applyOrgSync(db, { platform, snapshot, actor, trigger, transport }))()
  }
  const snap = snapshot || fetchOrgSnapshot(db, { platform, transport })
  const plan = planOrgSync(db, { platform, snapshot: snap })
  const startedAt = localNow()

  const runId = db
    .prepare(
      `INSERT INTO im_sync_runs (platform, kind, trigger_by, status, cursor_before, pulled, started_at, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(platform, 'org', trigger, 'ok', cursorOf(db, platform, 'org'), snap.departments.length + snap.users.length, startedAt, actor?.id ?? null, actor?.name ?? null)
    .lastInsertRowid
  const batch = `${platform}-org-${runId}`

  let created = 0
  let updated = 0
  let skipped = 0

  for (const d of plan.departments.create) {
    db.prepare(
      `INSERT INTO im_dept_map (platform, external_dept_id, external_parent_id, external_name, org_id, status, sync_batch, synced_at)
       VALUES (?,?,?,?,NULL,'active',?,?)`
    ).run(platform, String(d.id), d.parent_id ?? null, d.name ?? null, batch, startedAt)
    created += 1
    plan.conflicts.push({
      reason_code: 'DEPT_UNMAPPED',
      external_id: String(d.id),
      message: `外部部门「${d.name ?? d.id}」已建档但**没有挂到本地组织** —— 请指定它对应哪个主体（门店/仓库/经销商），否则挂在它下面的人会指向空组织`
    })
  }
  for (const d of plan.departments.update) {
    db.prepare(
      `UPDATE im_dept_map SET external_parent_id=?, external_name=?, status='active', sync_batch=?, synced_at=?
       WHERE platform=? AND external_dept_id=?`
    ).run(d.parent_id ?? null, d.name ?? null, batch, startedAt, platform, String(d.id))
    updated += 1
  }
  for (const row of plan.departments.missing) {
    db.prepare("UPDATE im_dept_map SET status='missing', sync_batch=?, synced_at=? WHERE id=?").run(batch, startedAt, row.id)
    updated += 1
    plan.conflicts.push({
      reason_code: 'EXTERNAL_DEPT_MISSING',
      external_id: row.external_dept_id,
      message: `外部部门「${row.external_name ?? row.external_dept_id}」已不在快照里 —— 本地映射标记为 missing（**不删**：历史要留下）`
    })
  }
  for (const d of plan.departments.update.concat(plan.departments.create)) {
    if (!d.parent_id) skipped += 0
  }

  for (const u of plan.users.create) {
    db.prepare(
      `INSERT INTO im_user_map (platform, external_user_id, union_id, external_name, mobile, external_dept_id, gml_user_id, status, sync_batch, synced_at)
       VALUES (?,?,?,?,?,?,NULL,'active',?,?)`
    ).run(platform, String(u.id), u.union_id ?? null, u.name ?? null, u.mobile ?? null, u.dept_id ?? null, batch, startedAt)
    created += 1
  }
  for (const u of plan.users.update) {
    db.prepare(
      `UPDATE im_user_map SET union_id=?, external_name=?, mobile=?, external_dept_id=?, status='active', sync_batch=?, synced_at=?
       WHERE platform=? AND external_user_id=?`
    ).run(u.union_id ?? null, u.name ?? null, u.mobile ?? null, u.dept_id ?? null, batch, startedAt, platform, String(u.id))
    updated += 1
  }
  for (const row of plan.users.missing) {
    db.prepare("UPDATE im_user_map SET status='missing', sync_batch=?, synced_at=? WHERE id=?").run(batch, startedAt, row.id)
    updated += 1
  }

  // 未挂接 / 未开户 —— 这两个是"必须被人看见"的状态，不能只是 NULL 躺在库里
  for (const r of db.prepare("SELECT * FROM im_dept_map WHERE platform=? AND status='active' AND org_id IS NULL").all(platform)) {
    if (!plan.conflicts.some((c) => c.reason_code === 'DEPT_UNMAPPED' && c.external_id === r.external_dept_id)) {
      plan.conflicts.push({
        reason_code: 'DEPT_UNMAPPED',
        external_id: r.external_dept_id,
        message: `外部部门「${r.external_name ?? r.external_dept_id}」没有挂到本地组织（org_id 为空）—— 请指定它对应哪个主体`
      })
    }
  }
  for (const r of db.prepare("SELECT * FROM im_user_map WHERE platform=? AND status='active' AND gml_user_id IS NULL").all(platform)) {
    plan.conflicts.push({
      reason_code: 'USER_UNMAPPED',
      external_id: r.external_user_id,
      message: `外部成员「${r.external_name ?? r.external_user_id}」还没有对应的本地用户（未开户）—— 需要建立用户并回填 gml_user_id`
    })
  }
  // 同名/同手机号撞到同一个人：靠手机号排重，撞上就报出来（不做自动合并）
  const dup = db
    .prepare(
      `SELECT mobile, COUNT(*) c FROM im_user_map
       WHERE platform=? AND mobile IS NOT NULL AND mobile<>'' AND gml_user_id IS NOT NULL
       GROUP BY mobile HAVING c > 1`
    )
    .all(platform)
  for (const d of dup) {
    plan.conflicts.push({
      reason_code: 'USER_DUPLICATE_MOBILE',
      external_id: d.mobile,
      message: `手机号 ${d.mobile} 上有 ${d.c} 个外部成员映射到同一个本地用户 —— 需要人工确认谁是谁`
    })
  }

  let conflicts = 0
  for (const c of dedupeConflicts(plan.conflicts)) {
    db.prepare(
      `INSERT INTO im_sync_conflicts (run_id, platform, kind, reason_code, external_id, local_id, message, payload)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(runId, platform, 'org', c.reason_code, c.external_id ?? null, c.local_id ?? null, c.message, c.payload ? JSON.stringify(c.payload) : null)
    conflicts += 1
  }

  const status = conflicts > 0 ? 'partial' : 'ok'
  db.prepare(
    `UPDATE im_sync_runs SET status=?, cursor_after=?, created=?, updated=?, skipped=?, conflicts=?, finished_at=?, detail=?
     WHERE id=?`
  ).run(
    status,
    snap.cursor ?? null,
    created,
    updated,
    skipped,
    conflicts,
    localNow(),
    JSON.stringify({ departments: plan.departments.create.length + plan.departments.update.length, users: plan.users.create.length + plan.users.update.length, complete: snap.complete }),
    runId
  )
  db.prepare("UPDATE im_platform_cfg SET last_sync_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE platform=?").run(platform)

  return { run_id: runId, batch, status, created, updated, conflicts, plan: summarize(plan) }
}

// ---------------------------------------------------------------------------
// 审批同步
// ---------------------------------------------------------------------------
/**
 * 把外部审批结果映射成本地的批准/驳回。**不落库**，返回逐条的计划与冲突。
 *
 * 外部行形状：`{ instance_id, process_code, status, operator_id, comment, doc_no }`
 */
export function planApprovalSync(db = getDb(), { platform, rows = [] } = {}) {
  assertPlatform(platform)
  const map = IM_PLATFORMS[platform].decisionMap || {}
  const out = { decide: [], unmapped: [], conflicts: [] }

  for (const r of rows) {
    const extId = String(r.instance_id ?? r.id ?? '')
    const decision = map[r.status]
    if (!decision) {
      out.conflicts.push({
        reason_code: 'APPROVAL_DECISION_UNKNOWN',
        external_id: extId,
        message: `外部审批状态「${r.status}」在 ${IM_PLATFORMS[platform].label} 的字典里认不出来 —— **不猜**，请人工确认该判成通过还是驳回`,
        payload: r
      })
      continue
    }
    // 找本地实例：优先用既有映射，其次按 doc_no 找 pending
    const mapped = db.prepare('SELECT * FROM im_approval_map WHERE platform=? AND external_instance_id=?').get(platform, extId)
    let inst = mapped?.approval_id ? getInstanceRow(db, mapped.approval_id) : null
    if (!inst && r.doc_no) {
      inst = db.prepare("SELECT * FROM approval_instances WHERE doc_no=? AND status='pending' ORDER BY id DESC LIMIT 1").get(String(r.doc_no))
    }
    if (!inst) {
      out.conflicts.push({
        reason_code: 'APPROVAL_INSTANCE_NOT_FOUND',
        external_id: extId,
        message: `外部审批单 ${extId}（单据 ${r.doc_no ?? '未提供'}）在本地找不到待审实例 —— 可能本地没提交过审批，或单号对不上`,
        payload: r
      })
      continue
    }
    if (inst.status !== 'pending') {
      out.conflicts.push({
        reason_code: 'APPROVAL_NOT_PENDING',
        external_id: extId,
        local_id: inst.id,
        message: `本地审批实例 #${inst.id} 已经是 ${inst.status}，外部结果不再覆盖（外部的结论不追溯已决的事）`,
        payload: r
      })
      continue
    }
    // 外部操作人 → 本地用户。**映射不上就不决策**（口径 ③）
    const who = r.operator_id ? db.prepare('SELECT * FROM im_user_map WHERE platform=? AND external_user_id=?').get(platform, String(r.operator_id)) : null
    if (!who || !who.gml_user_id) {
      out.conflicts.push({
        reason_code: 'APPROVER_UNMAPPED',
        external_id: extId,
        local_id: inst.id,
        message: `外部审批人 ${r.operator_id ?? '未提供'} 没有映射到本地用户，**不代替他签字** —— 请先完成该成员的组织同步并开户`,
        payload: r
      })
      continue
    }
    out.decide.push({
      instance_id: inst.id,
      external_instance_id: extId,
      external_status: r.status,
      local_status: decision,
      decision,
      // `who` 这里是**已经确认过**的（上面那道闸门保证），但仍然写成可选链：
      // 反例注入时要把这道闸门拆掉，而"拆掉之后崩在 TypeError"会让反例变成
      // "崩在无关位置"（铁律 21①）—— 那就分不清是断言抓到的还是代码自己炸的。
      actor_id: who?.gml_user_id ?? null,
      comment: r.comment ?? `来自${IM_PLATFORMS[platform].label}的审批结论：${r.status}`,
      doc_type: inst.doc_type,
      doc_no: inst.doc_no
    })
  }
  return out
}

export function applyApprovalSync(db = getDb(), { platform, rows = null, actor = null, trigger = 'web', transport = null } = {}) {
  assertPlatform(platform)
  if (!db.inTransaction) {
    return db.transaction(() => applyApprovalSync(db, { platform, rows, actor, trigger, transport }))()
  }
  const fetched = rows ? { complete: true, cursor: null, rows } : fetchApprovalRows(db, { platform, transport })
  const plan = planApprovalSync(db, { platform, rows: fetched.rows })
  const startedAt = localNow()
  const runId = db
    .prepare(
      `INSERT INTO im_sync_runs (platform, kind, trigger_by, status, cursor_before, pulled, started_at, actor_id, actor_name)
       VALUES (?,?,?,?,?,?,?,?,?)`
    )
    .run(platform, 'approval', trigger, 'ok', cursorOf(db, platform, 'approval'), fetched.rows.length, startedAt, actor?.id ?? null, actor?.name ?? null)
    .lastInsertRowid
  const batch = `${platform}-approval-${runId}`

  let created = 0
  let updated = 0
  let decided = 0

  for (const d of plan.decide) {
    // 末位取值一律兜底：**映射行指向的用户可能已经不存在**（跨代引用 / 手工删过用户）。
    // 第一版这里直接 `u.id`，于是"用户不见了"变成一次 TypeError 崩溃 ——
    // 而崩溃发生在事务里、报的是 SQLite 的栈，排查方向会被完全带偏。
    // 现在它是一条**可读的冲突**：谁没映射上、该做什么，写清楚。
    const u = db.prepare('SELECT id, name, role, is_super FROM users WHERE id=?').get(d.actor_id)
    if (!u) {
      plan.conflicts.push({
        reason_code: 'APPROVER_UNMAPPED',
        external_id: d.external_instance_id,
        local_id: d.instance_id,
        message: `映射指向的本地用户 #${d.actor_id} 不存在（可能被删除）—— 无法代他签字，请修好映射后重试`
      })
      continue
    }
    const actorObj = { id: u.id, name: u.name }
    let localStatus = d.local_status
    try {
      decideApproval(db, { instanceId: d.instance_id, decision: d.decision, comment: d.comment, actor: actorObj })
      decided += 1
    } catch (e) {
      // 决策被引擎拒了（例如映射到的人不是当前级审批人）—— 记冲突，不改本地状态。
      localStatus = `rejected_by_engine:${e.code}`
      plan.conflicts.push({
        reason_code: e.code === 'APPROVAL_NOT_ASSIGNED' ? 'APPROVER_NOT_ASSIGNED' : 'APPROVAL_NOT_PENDING',
        external_id: d.external_instance_id,
        local_id: d.instance_id,
        message: `外部结论未能落到本地实例 #${d.instance_id}：${e.message}`
      })
    }
    const exist = db.prepare('SELECT * FROM im_approval_map WHERE platform=? AND external_instance_id=?').get(platform, d.external_instance_id)
    if (exist) {
      db.prepare('UPDATE im_approval_map SET external_status=?, local_status=?, approval_id=?, sync_batch=?, synced_at=? WHERE id=?').run(
        d.external_status, localStatus, d.instance_id, batch, startedAt, exist.id
      )
      updated += 1
    } else {
      db.prepare(
        `INSERT INTO im_approval_map (platform, external_instance_id, external_status, local_status, approval_id, doc_type, doc_no, sync_batch, synced_at)
         VALUES (?,?,?,?,?,?,?,?,?)`
      ).run(platform, d.external_instance_id, d.external_status, localStatus, d.instance_id, d.doc_type ?? null, d.doc_no ?? null, batch, startedAt)
      created += 1
    }
  }

  let conflicts = 0
  for (const c of dedupeConflicts(plan.conflicts)) {
    db.prepare(
      `INSERT INTO im_sync_conflicts (run_id, platform, kind, reason_code, external_id, local_id, message, payload)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(runId, platform, 'approval', c.reason_code, c.external_id ?? null, c.local_id ?? null, c.message, c.payload ? JSON.stringify(c.payload) : null)
    conflicts += 1
  }

  const status = conflicts > 0 ? 'partial' : 'ok'
  db.prepare(
    `UPDATE im_sync_runs SET status=?, cursor_after=?, created=?, updated=?, conflicts=?, finished_at=?, detail=? WHERE id=?`
  ).run(status, fetched.cursor ?? null, created, updated, conflicts, localNow(), JSON.stringify({ decided, pulled: fetched.rows.length }), runId)
  db.prepare("UPDATE im_platform_cfg SET last_sync_at=datetime('now','localtime'), updated_at=datetime('now','localtime') WHERE platform=?").run(platform)

  return { run_id: runId, batch, status, created, updated, decided, conflicts, plan: { decide: plan.decide.length, conflicts: plan.conflicts.length } }
}

// ---------------------------------------------------------------------------
// 查询 / 自证
// ---------------------------------------------------------------------------
export function listPlatforms(db = getDb()) {
  return db.prepare('SELECT * FROM im_platform_cfg ORDER BY id').all().map((r) => ({
    ...r,
    secret_present: !!(r.secret_ref && process.env[r.secret_ref]),
    adapter_ready: false // 真实 transport 未实现（见 IM_REAL_CALL_NOT_IMPLEMENTED）
  }))
}

export function listMappings(db = getDb(), { platform = null, limit = 200 } = {}) {
  const where = platform ? 'WHERE platform=?' : ''
  const args = platform ? [platform] : []
  return {
    departments: db.prepare(`SELECT * FROM im_dept_map ${where} ORDER BY platform, external_dept_id LIMIT ?`).all(...args, limit),
    users: db.prepare(`SELECT * FROM im_user_map ${where} ORDER BY platform, external_user_id LIMIT ?`).all(...args, limit),
    approvals: db.prepare(`SELECT * FROM im_approval_map ${where} ORDER BY id DESC LIMIT ?`).all(...args, limit)
  }
}

export function listRuns(db = getDb(), { platform = null, limit = 50, offset = 0 } = {}) {
  const where = platform ? 'WHERE platform=?' : ''
  const args = platform ? [platform] : []
  const total = db.prepare(`SELECT COUNT(*) c FROM im_sync_runs ${where}`).get(...args).c
  const list = db.prepare(`SELECT * FROM im_sync_runs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
  return { list, total }
}

export function listConflicts(db = getDb(), { platform = null, reason_code = null, limit = 50, offset = 0 } = {}) {
  const conds = []
  const args = []
  if (platform) { conds.push('platform=?'); args.push(platform) }
  if (reason_code) { conds.push('reason_code=?'); args.push(reason_code) }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM im_sync_conflicts ${where}`).get(...args).c
  const list = db.prepare(`SELECT * FROM im_sync_conflicts ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset)
  return { list, total }
}

export function imStatus(db = getDb()) {
  const pend = db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE status='active' AND gml_user_id IS NULL").get().c
  return {
    platforms: listPlatforms(db).map((p) => ({ platform: p.platform, label: p.label, enabled: !!p.enabled, secret_present: p.secret_present, adapter_ready: p.adapter_ready, last_sync_at: p.last_sync_at })),
    maps: {
      departments: db.prepare('SELECT COUNT(*) c FROM im_dept_map').get().c,
      departments_unmapped: db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE org_id IS NULL AND status='active'").get().c,
      departments_missing: db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE status='missing'").get().c,
      users: db.prepare('SELECT COUNT(*) c FROM im_user_map').get().c,
      users_unmapped: pend,
      users_missing: db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE status='missing'").get().c,
      approvals: db.prepare('SELECT COUNT(*) c FROM im_approval_map').get().c
    },
    runs: db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c,
    open_conflicts: db.prepare('SELECT COUNT(*) c FROM im_sync_conflicts').get().c,
    conflict_codes: CONFLICT_CODE_LIST.length,
    real_call_ready: false,
    real_call_note: '真实租户调用未实现（无凭据）。映射 / 幂等 / 缺失判定 / 冲突 / 留痕均已可用，用「自检」可跑通全链路。'
  }
}

/**
 * 自证。七条探针，每一条都回答一个"这里有没有可能悄悄不对"的问题。
 * 与 `auditReportConfigTrail` 同族：**探针要放在会被定期调用的地方**，
 * 不然它只是"一个可以跑的脚本"，不会有人跑。
 */
export function auditImTrail(db = getDb()) {
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  // ① 没有未结束的同步 —— 进程死在半路必须可见
  const unfinished = db.prepare('SELECT id, platform, kind, started_at FROM im_sync_runs WHERE finished_at IS NULL').all()
  if (unfinished.length) {
    push('IM_RUN_UNFINISHED', `有 ${unfinished.length} 次同步没有结束时间（进程中途死了）—— 游标可能已被推进，但集合没拉全`, unfinished)
  }

  // ② 映射必须有出处：每一行的 sync_batch 都要能在流水里找到。
  //    ⚠️ 这里**同时查"批次为空"** —— 只查"批次对不上"会留一个盲区：
  //    绕过唯一写入点直接 INSERT 的行，`sync_batch` 通常是 NULL，而 NULL 不会"对不上"，
  //    它会安静地跳过整条检查。（第一版就是这么写的，被反例 C 撞出来。）
  const orphanMaps = []
  for (const [tbl, col] of [['im_dept_map', 'external_dept_id'], ['im_user_map', 'external_user_id'], ['im_approval_map', 'external_instance_id']]) {
    const rows = db.prepare(`SELECT id, platform, ${col} AS ext, sync_batch FROM ${tbl}`).all()
    for (const r of rows) {
      if (r.sync_batch === null || r.sync_batch === '') {
        orphanMaps.push({ table: tbl, id: r.id, batch: null, ext: r.ext, why: '没有来源批次' })
        continue
      }
      const hit = db.prepare('SELECT 1 FROM im_sync_runs WHERE id=?').get(Number(String(r.sync_batch).split('-').pop()))
      if (!hit) orphanMaps.push({ table: tbl, id: r.id, batch: r.sync_batch, ext: r.ext, why: '批次指向不存在的同步' })
    }
  }
  if (orphanMaps.length) {
    push('IM_MAP_WITHOUT_RUN', `有 ${orphanMaps.length} 行映射找不到它属于哪一次同步 —— 不知道谁写的、也不知道该不该删`, orphanMaps.slice(0, 5))
  }

  // ③ 冲突码必须是封闭字典里的（防有人绕过写入点直接 INSERT）
  const badCodes = db
    .prepare(`SELECT DISTINCT reason_code FROM im_sync_conflicts`)
    .all()
    .map((r) => r.reason_code)
    .filter((c) => !CONFLICT_CODE_LIST.includes(c))
  if (badCodes.length) push('IM_CONFLICT_CODE_UNKNOWN', `冲突台账里有字典外的码：${badCodes.join('、')}`, badCodes)

  // ④ 未挂接的部门 / 未开户的成员**必须**在冲突里有对应的一条 —— 不能只是 NULL 躺在库里
  const unmappedDept = db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE status='active' AND org_id IS NULL").get().c
  if (unmappedDept > 0) {
    const reported = db.prepare("SELECT COUNT(DISTINCT external_id) c FROM im_sync_conflicts WHERE reason_code='DEPT_UNMAPPED'").get().c
    if (reported === 0) push('IM_UNMAPPED_SILENT', `有 ${unmappedDept} 个部门没有挂到本地组织，但冲突台账里一条 DEPT_UNMAPPED 都没有 —— "挂空"被静默了`)
  }
  const unmappedUser = db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE status='active' AND gml_user_id IS NULL").get().c
  if (unmappedUser > 0) {
    const reported = db.prepare("SELECT COUNT(DISTINCT external_id) c FROM im_sync_conflicts WHERE reason_code='USER_UNMAPPED'").get().c
    if (reported === 0) push('IM_UNMAPPED_SILENT', `有 ${unmappedUser} 个外部成员没有对应本地用户，但冲突台账里一条 USER_UNMAPPED 都没有`)
  }

  // ⑤ 悬空引用：映射指向的本地行必须还在
  const danglingUser = db
    .prepare('SELECT m.id, m.gml_user_id FROM im_user_map m LEFT JOIN users u ON u.id=m.gml_user_id WHERE m.gml_user_id IS NOT NULL AND u.id IS NULL')
    .all()
  if (danglingUser.length) push('IM_USER_DANGLING', `有 ${danglingUser.length} 行成员映射指向不存在的本地用户`, danglingUser.slice(0, 5))
  const danglingOrg = db
    .prepare('SELECT m.id, m.org_id FROM im_dept_map m LEFT JOIN orgs o ON o.id=m.org_id WHERE m.org_id IS NOT NULL AND o.id IS NULL')
    .all()
  if (danglingOrg.length) push('IM_ORG_DANGLING', `有 ${danglingOrg.length} 行部门映射指向不存在的本地组织`, danglingOrg.slice(0, 5))
  const danglingApv = db
    .prepare('SELECT m.id, m.approval_id FROM im_approval_map m LEFT JOIN approval_instances a ON a.id=m.approval_id WHERE m.approval_id IS NOT NULL AND a.id IS NULL')
    .all()
  if (danglingApv.length) push('IM_APPROVAL_DANGLING', `有 ${danglingApv.length} 行审批映射指向不存在的本地审批实例`, danglingApv.slice(0, 5))

  // ⑥ 状态取值域（与迁移 verify 同一份判据，但运行时也要守一遍）
  const badStatus = db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE status NOT IN ('active','missing')").get().c
    + db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE status NOT IN ('active','missing')").get().c
  if (badStatus > 0) push('IM_MAP_STATUS_INVALID', `映射表里有 ${badStatus} 行状态不在 active / missing 里`)

  // ⑦ 审批映射的"外部原文"不能丢：没有 external_status 就无法还原"当时我们把它读成了什么"
  const noRaw = db.prepare("SELECT COUNT(*) c FROM im_approval_map WHERE external_status IS NULL").get().c
  if (noRaw > 0) push('IM_APPROVAL_RAW_MISSING', `有 ${noRaw} 行审批映射没记外部原始状态 —— 事后无法核对翻译对不对`)

  return {
    ok: problems.length === 0,
    problems,
    checked: {
      runs: db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c,
      dept_maps: db.prepare('SELECT COUNT(*) c FROM im_dept_map').get().c,
      user_maps: db.prepare('SELECT COUNT(*) c FROM im_user_map').get().c,
      approval_maps: db.prepare('SELECT COUNT(*) c FROM im_approval_map').get().c,
      conflicts: db.prepare('SELECT COUNT(*) c FROM im_sync_conflicts').get().c
    }
  }
}

/** 运行时初始化：保证两个平台各有一行配置（与 `ensureSettings` 同构） */
export function ensureImPlatforms(db = getDb()) {
  const tx = db.transaction(() => {
    let added = 0
    for (const [platform, meta] of Object.entries(IM_PLATFORMS)) {
      const hit = db.prepare('SELECT 1 FROM im_platform_cfg WHERE platform=?').get(platform)
      if (hit) continue
      db.prepare('INSERT INTO im_platform_cfg (platform, label, secret_ref, enabled, remark) VALUES (?,?,?,0,?)').run(
        platform, meta.label, meta.secretEnvHint, '运行时补齐：默认停用'
      )
      added += 1
    }
    return added
  })
  return { added: tx() }
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------
function cursorOf(db, platform, kind) {
  const r = db.prepare('SELECT cursor_after FROM im_sync_runs WHERE platform=? AND kind=? AND cursor_after IS NOT NULL ORDER BY id DESC LIMIT 1').get(platform, kind)
  return r?.cursor_after || null
}
function getInstanceRow(db, id) {
  return db.prepare('SELECT * FROM approval_instances WHERE id=?').get(Number(id)) || null
}
function dedupeConflicts(list) {
  const seen = new Set()
  const out = []
  for (const c of list) {
    const k = `${c.reason_code}|${c.external_id ?? ''}|${c.local_id ?? ''}`
    if (seen.has(k)) continue
    seen.add(k)
    out.push(c)
  }
  return out
}
function summarize(plan) {
  return {
    dept_create: plan.departments.create.length,
    dept_update: plan.departments.update.length,
    dept_missing: plan.departments.missing.length,
    user_create: plan.users.create.length,
    user_update: plan.users.update.length,
    user_missing: plan.users.missing.length,
    conflicts: plan.conflicts.length
  }
}

export default {
  ImError,
  IM_PLATFORMS,
  IM_PLATFORM_CODES,
  SYNC_KINDS,
  RUN_STATUS,
  MAP_STATUS,
  CONFLICT_CODES,
  CONFLICT_CODE_LIST,
  SELF_TEST_SNAPSHOT,
  setImTransport,
  getImTransport,
  fetchOrgSnapshot,
  fetchApprovalRows,
  planOrgSync,
  applyOrgSync,
  planApprovalSync,
  applyApprovalSync,
  listPlatforms,
  listMappings,
  listRuns,
  listConflicts,
  imStatus,
  auditImTrail,
  ensureImPlatforms
}
