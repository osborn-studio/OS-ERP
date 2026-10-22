/**
 * ============================================================================
 * 文件标识：server/routes/im.js ｜ 钉钉 / 飞书 组织与审批同步路由
 * ============================================================================
 * 【职责】钉钉 / 飞书 组织与审批同步路由
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 钉钉 / 飞书 组织与审批同步路由
//
// 挂载点：/api/im
//
// 分工（三条，别混）：
//   POST /sync/org       —— **真同步**：拉外部快照 → 落映射 → 写流水。需要凭据。
//   POST /sync/approval  —— **真同步**：把外部审批结论落到本地审批实例上。需要凭据。
//   POST /self-test      —— **不碰外部、也不留痕**：用固定快照在**一个会回滚的事务里**
//                            把"映射 → 幂等 → 缺失判定 → 冲突 → 留痕"整条链跑一遍。
//
// 为什么要有 self-test：这一批的边界是"真实租户不做"，那么**必须有一个入口**能证明
// "除了那一次 HTTP 调用之外，其余全都真的能跑"。否则"未测"会连"没写"一起盖住。
// 它在一个 `db.transaction` 里跑完然后**主动抛异常回滚** —— 自检不得往库里留任何东西
// （铁律 5：假表只活事务里 + finally ROLLBACK + 收尾断言真表还在）。
//
// 一条刻意的约束（与通知中心的 `enabled` 默认 0 同一条理由）：
//   平台配置默认**停用**。同步会改组织与审批状态，误同步的代价远大于漏同步，
//   所以它必须是"显式配置 + 显式打开"的。没配置时**明确拒绝**并给一句人话，
//   绝不静默返回空快照 —— 空快照会被缺失判定读成"全公司的人都离职了"。

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, paged, pageParams, bizFail } from '../lib/http.js'
import { requireAuth, requirePerm } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import {
  IM_PLATFORMS, IM_PLATFORM_CODES, SYNC_KINDS, RUN_STATUS, CONFLICT_CODES, CONFLICT_CODE_LIST,
  SELF_TEST_SNAPSHOT, ImError,
  setImTransport, planOrgSync, applyOrgSync, planApprovalSync, applyApprovalSync,
  listPlatforms, listMappings, listRuns, listConflicts, imStatus, auditImTrail, ensureImPlatforms
} from '../lib/im-sync.js'

const r = Router()

function guard(fn) {
  return wrap((req, res, next) => {
    try {
      return fn(req, res, next)
    } catch (e) {
      if (e) {
        // 形状统一交给唯一构造点 `bizFail`。两处与别处不同，必须在调用点补齐：
        //   ① 这里兜的是**任意**异常（不只是 ImError），落不到具体 4xx 时沿用原来的 400；
        //   ② `ImError` 的 code 是位置参数、允许传空，空时沿用原来的 'IM_ERROR'。
        // 刻意不写成 `{ ...e }`：Error 的 message 是不可枚举属性，展开会把它丢掉。
        return bizFail(res, {
          status: e.httpStatus || e.status || 400,
          code: e.code || 'IM_ERROR',
          message: e.message,
          detail: e.detail
        })
      }
      throw e
    }
  })
}

const actorOf = (req) => ({ id: req.user?.uid ?? null, name: req.user?.name || req.user?.username || null })

// ---------------------------------------------------------------------------
// 元数据 / 状态
// ---------------------------------------------------------------------------
r.get('/meta', requireAuth, guard((_req, res) =>
  ok(res, {
    platforms: Object.values(IM_PLATFORMS).map((p) => ({ code: p.code, label: p.label, secret_env_hint: p.secretEnvHint, decision_map: p.decisionMap })),
    kinds: SYNC_KINDS,
    run_status: RUN_STATUS,
    conflict_codes: CONFLICT_CODES,
    real_call_ready: false,
    real_call_note: '真实租户调用未实现（本机无凭据）。组织与审批同步的映射、幂等、缺失判定、冲突与留痕均已可用，用 /self-test 可跑通全链路。'
  })
))

r.get('/status', requireAuth, requirePerm('system.im.view'), guard((_req, res) => ok(res, imStatus(getDb()))))

r.get('/audit', requireAuth, requirePerm('system.im.view'), guard((_req, res) => ok(res, auditImTrail(getDb()))))

r.get('/platforms', requireAuth, requirePerm('system.im.view'), guard((_req, res) => ok(res, listPlatforms(getDb()))))

r.get('/mappings', requireAuth, requirePerm('system.im.view'), guard((req, res) => {
  const platform = req.query.platform || null
  if (platform && !IM_PLATFORMS[platform]) return fail(res, `未知平台「${platform}」`, 400)
  return ok(res, listMappings(getDb(), { platform, limit: Number(req.query.limit || 200) }))
}))

r.get('/runs', requireAuth, requirePerm('system.im.view'), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = listRuns(getDb(), { platform: req.query.platform || null, limit: pageSize, offset: (page - 1) * pageSize })
  return paged(res, { rows: out.list, total: out.total, page, pageSize })
}))

r.get('/conflicts', requireAuth, requirePerm('system.im.view'), guard((req, res) => {
  const { page, pageSize } = pageParams(req)
  const out = listConflicts(getDb(), {
    platform: req.query.platform || null,
    reason_code: req.query.reason_code || null,
    limit: pageSize, offset: (page - 1) * pageSize
  })
  return paged(res, { rows: out.list, total: out.total, page, pageSize })
}))

// ---------------------------------------------------------------------------
// 真同步（需要凭据；没配就明确拒绝）
// ---------------------------------------------------------------------------
r.post('/sync/org', requireAuth, requirePerm('system.im.sync'), guard((req, res) => {
  const db = getDb()
  const platform = String(req.body?.platform || '')
  if (!IM_PLATFORMS[platform]) return fail(res, `未登记的平台「${platform}」（可选：${IM_PLATFORM_CODES.join(' / ')}）`, 400)
  const out = applyOrgSync(db, { platform, actor: actorOf(req), trigger: 'web' })
  audit(req, { action: 'SYNC_ORG', module: 'im', entity: 'im_sync_runs', entityId: out.run_id, detail: `${platform} 新建 ${out.created} / 冲突 ${out.conflicts}` })
  return ok(res, out)
}))

r.post('/sync/approval', requireAuth, requirePerm('system.im.sync'), guard((req, res) => {
  const db = getDb()
  const platform = String(req.body?.platform || '')
  if (!IM_PLATFORMS[platform]) return fail(res, `未登记的平台「${platform}」（可选：${IM_PLATFORM_CODES.join(' / ')}）`, 400)
  const out = applyApprovalSync(db, { platform, actor: actorOf(req), trigger: 'web' })
  audit(req, { action: 'SYNC_APPROVAL', module: 'im', entity: 'im_sync_runs', entityId: out.run_id, detail: `${platform} 决策 ${out.decided} / 冲突 ${out.conflicts}` })
  return ok(res, out)
}))

// ---------------------------------------------------------------------------
// 自检：跑通全链路，然后**回滚**
// ---------------------------------------------------------------------------
r.post('/self-test', requireAuth, requirePerm('system.im.view'), guard((_req, res) => {
  const db = getDb()
  const before = snapshotCounts(db)
  let captured = null
  const marked = Symbol('im-self-test-rollback')

  // 固定快照 → 强制走 mock transport，**不碰外部**
  const mockSnapshot = SELF_TEST_SNAPSHOT
  setImTransport(() => ({ ...mockSnapshot, departments: mockSnapshot.departments, users: mockSnapshot.users }))
  try {
    db.transaction(() => {
      const first = applyOrgSync(db, { platform: 'dingtalk', snapshot: mockSnapshot, actor: { id: null, name: '自检' }, trigger: 'system' })
      // 第二次跑同一份快照：**幂等** —— 新建必须是 0
      const second = applyOrgSync(db, { platform: 'dingtalk', snapshot: mockSnapshot, actor: { id: null, name: '自检' }, trigger: 'system' })
      // 不完整快照：**不许**做缺失判定
      const partialPlan = planOrgSync(db, { platform: 'dingtalk', snapshot: { complete: false, departments: [], users: [] } })
      // 审批：未知状态必须留冲突而不是猜
      const apvPlan = planApprovalSync(db, {
        platform: 'dingtalk',
        rows: [
          { instance_id: 'X-1', status: 'something_new', operator_id: 'U-A', doc_no: 'NOPE' },
          { instance_id: 'X-2', status: 'agree', operator_id: 'U-A', doc_no: 'NOPE' }
        ]
      })
      captured = {
        first: { created: first.created, updated: first.updated, conflicts: first.conflicts, status: first.status },
        second: { created: second.created, updated: second.updated, conflicts: second.conflicts, status: second.status },
        second_is_idempotent: second.created === 0,
        partial_missing_count: partialPlan.departments.missing.length + partialPlan.users.missing.length,
        partial_has_snapshot_conflict: partialPlan.conflicts.some((c) => c.reason_code === 'SNAPSHOT_INCOMPLETE'),
        approval_unknown_status: apvPlan.conflicts.filter((c) => c.reason_code === 'APPROVAL_DECISION_UNKNOWN').length,
        approval_instance_missing: apvPlan.conflicts.filter((c) => c.reason_code === 'APPROVAL_INSTANCE_NOT_FOUND').length,
        audit: auditImTrail(db)
      }
      throw marked
    })()
  } catch (e) {
    if (e !== marked) throw e
  } finally {
    setImTransport(null)
  }

  const after = snapshotCounts(db)
  const clean = JSON.stringify(before) === JSON.stringify(after)
  return ok(res, {
    dry_run: true,
    rolled_back: clean,
    counts_before: before,
    counts_after: after,
    steps: captured,
    note: clean
      ? '全链路在一个会回滚的事务里跑过：映射 → 幂等 → 缺失判定 → 冲突 → 留痕。库里一行都没多。'
      : '⚠️ 自检没有完全回滚 —— 这是缺陷，请立刻查看 counts_before / counts_after 的差异'
  })
}))

function snapshotCounts(db) {
  const t = (sql) => db.prepare(sql).get().c
  return {
    im_dept_map: t('SELECT COUNT(*) c FROM im_dept_map'),
    im_user_map: t('SELECT COUNT(*) c FROM im_user_map'),
    im_approval_map: t('SELECT COUNT(*) c FROM im_approval_map'),
    im_sync_runs: t('SELECT COUNT(*) c FROM im_sync_runs'),
    im_sync_conflicts: t('SELECT COUNT(*) c FROM im_sync_conflicts'),
    orgs: t('SELECT COUNT(*) c FROM orgs'),
    users: t('SELECT COUNT(*) c FROM users')
  }
}

export default r
