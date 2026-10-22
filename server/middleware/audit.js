/**
 * ============================================================================
 * 文件标识：server/middleware/audit.js ｜ 操作审计写入（`audit_logs`）：谁、在什么时候、对哪个对象做了什么
 * ============================================================================
 * 【职责】操作审计写入（`audit_logs`）：谁、在什么时候、对哪个对象做了什么
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { getDb } from '../db/index.js'
import { bizFail, statusOf, newIncidentId } from '../lib/http.js'
import { insertAuditRow, auditStrictRow } from '../lib/audit-trail.js'
import { redactUrl } from '../lib/redact.js'

// ===========================================================================
// 留痕：**存在性优先于明细**
// ===========================================================================
// 这一条是踩出来的，不是想出来的：
//   `audit_logs.detail` 是 TEXT 列，而 `audit()` 原来把 `detail` **原样绑进 SQL**。
//   项目里有 35 处调用点写的是 `detail: { ... }`（对象），而 better-sqlite3 见到对象会
//   把它当成**具名参数包**（`@key` 展开）⇒ 抛 `RangeError: Too few parameter values were provided`
//   ⇒ 又被 `audit()` 的 catch 吞掉 ⇒ **整条记录没有落库**，只在服务端日志留一行 `[audit]`。
//   后果：那些动作在审计上**根本不存在**，而调用点看起来完全正常。
//   实测（修前）：同一批调用"传对象时行数 0、改成 JSON.stringify 后 2 条"。
//
// 所以这里定两条口径，后面所有判断都从它们推：
//   ① **`detail` 必须是字符串**（或 null）—— 由本函数统一序列化，调用点不必操心；
//   ② **序列化失败也绝不能丢记录** —— `JSON.stringify` 自己会抛（循环引用、
//      BigInt、`toJSON` 里抛），那时把明细退化成一句标记串。
//      为什么不做成"失败就整条不写"：**明细丢了可以补（事件本身在别处还能查），
//      记录没了就永久没了** —— 审计链断一环，比链上少一条备注严重得多。
// 口径 ①② 的实现现在住在 `lib/audit-trail.js`（`normalizeDetail` / `insertAuditRow`）：
//   那是 `audit_logs` 的**唯一 INSERT 点**，`lib/account-security.js` 的严格安全审计也走它。
//   明细在那里统一**脱敏**（凭据键遮盖、手机号部分遮盖，见 `lib/redact.js`）—— 请求体原样进审计表
//   曾让密码 / 手机号落库（F13），所以脱敏不放在调用点，放在落库点。

/**
 * `entity` / `entityId` 的**单点兼容**：早年的调用点传的是 `target: 'period:2026-10'`。
 *
 * `audit()` 从来不认 `target`（16 处调用点因此把"改的是哪个对象"写成了空）——
 * 但**修在调用点上是错的**：那是同一件事的第二个实现，而且下一批还会有人这么写。
 * 所以在这里一次性兼容，调用点一行不动。
 *
 * 语义选择（为什么不"并入 detail"）：
 *   `entity` / `entity_id` 这两列的**本意**就是"这条记录改的是哪个对象"，
 *   而"按对象查日志"（这张表存在的主要用途）只能靠它们。塞进 detail 之后，
 *   那句话仍然查不出来，等于把问题从"丢失"降级成"不好用" —— 而我们能一次做对。
 *   16 处的 `target` 恰好都是 `kind:id` 的形状（`period:2026-10` / `opening:2026-10` /
 *   `year:2026` / `voucher:12`），按**第一个冒号**拆开即可，没有歧义。
 * 冲突时的优先级：**显式 `entity`/`entityId` 永远赢**（新写法是准确的那一份），
 *   此时 `target` 被忽略 —— 两份都给且不一致，说明调用点还没改干净，不该由这里替它猜。
 */
function entityOf(payload) {
  const { entity, entityId, target } = payload
  if (entity || entityId !== null && entityId !== undefined) {
    return { entity: entity || null, entityId: entityId === null || entityId === undefined ? null : String(entityId) }
  }
  const t = target === null || target === undefined ? '' : String(target).trim()
  if (!t) return { entity: null, entityId: null }
  const i = t.indexOf(':')
  return i > 0 ? { entity: t.slice(0, i), entityId: t.slice(i + 1) } : { entity: t, entityId: null }
}

/** `req` + 调用点载荷 → `lib/audit-trail.js` 认的行（唯一一处映射，`audit` / `auditStrict` 共用） */
function rowOf(req, payload) {
  const u = req.user || {}
  const { entity, entityId } = entityOf(payload)
  return {
    userId: u.uid || null,
    userName: u.name || 'anonymous',
    action: payload.action,
    module: payload.module || null,
    entity,
    entityId,
    detail: payload.detail,
    ip: req.ip || null
  }
}

/**
 * 记一条留痕。**调用方不需要 try/catch** —— 本函数保证不抛（留痕失败不该打断业务），
 * 但失败会打日志（`console.error('[audit]', ...)`），不会静默。
 */
export function audit(req, payload = {}) {
  try {
    const db = getDb()
    const row = rowOf(req, payload)
    try {
      insertAuditRow(db, row)
    } catch (e) {
      // 第二次机会：**去掉明细再写一次**。第一次失败可能是 detail 之外的任何原因
      // （列超长、库被锁、老库缺列…），但"记录必须存在"这条口径不变 ——
      // 写不进去就把明细让出去，而不是整条放弃。
      // 注意：单条 INSERT 是原子的，第一次失败不会留下半条，重试不会造成重复。
      console.error('[audit] 首次写入失败，去掉明细重试：', e.message)
      try {
        insertAuditRow(db, row, { withDetail: false })
      } catch (e2) {
        console.error('[audit]', e2.message)
      }
    }
  } catch (e) {
    // 连 getDb() 都拿不到（例如行业上下文没进请求）—— 同样只报不抛
    console.error('[audit]', e.message)
  }
}

/**
 * **严格**留痕：给安全相关的变更（配置、信用额度、账号/权限…）用，**必须在业务事务内调用**。
 *
 * 与 `audit()` 的区别只有一条：写不进去就**抛**（503 `SECURITY_AUDIT_UNAVAILABLE`），
 * 由包着它的 `db.transaction` 把业务写入一起回滚 —— "动作成功了但审计上不存在"对这类操作不可接受。
 * 不在事务里调用会抛 `AUDIT_OUTSIDE_TX`（编码错误，不是运行时不可用）。
 * 载荷形状与 `audit()` 完全相同；明细同样经过脱敏。实现见 `lib/audit-trail.js`。
 */
export function auditStrict(req, payload = {}) {
  return auditStrictRow(getDb(), rowOf(req, payload))
}

export function auditMiddleware(req, res, next) {
  res.locals.audit = (payload) => audit(req, payload)
  next()
}

export function errorHandler(err, req, res, _next) {
  // 状态码走 `statusOf` —— 与下面 `bizFail` 定响应码用的是**同一处口径**。
  // 为什么不能自己写 `err.status || 500`：`ImError` 只写 `.httpStatus`、`ArError` 额外写 `.http`，
  // 自己算会把这类错误算成 500 → **日志记 500、响应实发 400/404**，报障时被日志带偏。
  // 判据由 `scripts/check-bizcode-shape.mjs` 的动态断言守着（响应码 === 日志里的码）。
  const status = statusOf(err)
  // 5xx：先发一个事件号，日志与响应都带它 —— 生产环境响应体不再回显 `err.message`（见 `bizFail`），
  // 运维凭事件号到日志里找完整错误。URL 先脱敏（查询串里的 token= 之类不进日志）。
  const incidentId = status >= 500 ? newIncidentId() : null
  if (incidentId) console.error('[error]', incidentId, req.method, redactUrl(req.originalUrl), err)
  // 形状构造只有一处（http.js 的 bizFail）：这里曾经自己拼对象，结果是业务码只落在顶层
  // `error`、`detail` 里没有，与路由层的读法对不上。
  bizFail(res, err, incidentId)
}
