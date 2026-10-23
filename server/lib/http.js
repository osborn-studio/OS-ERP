/**
 * ============================================================================
 * 文件标识：server/lib/http.js ｜ HTTP 响应与错误归一：`ok` / `fail` / `wrap` 的**唯一实现**（统一 `{code,data,message}` 形状）
 * ============================================================================
 * 【职责】HTTP 响应与错误归一：`ok` / `fail` / `wrap` 的**唯一实现**（统一 `{code,data,message}` 形状）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { randomBytes } from 'node:crypto'
import { runtimeMode } from '../runtime.js'
import { redactValue } from './redact.js'

/** 5xx 事件号：16 位 hex，响应体与服务端 `[error]` 日志共用，运维凭它把两边对上 */
export function newIncidentId() {
  return randomBytes(8).toString('hex')
}

/** 生产环境 5xx 不回显内部错误文案（SQLite 表名 / 栈信息 / 配置细节）；demo / test 保留，便于联调 */
export const GENERIC_5XX_MESSAGE = '服务器内部错误，请联系管理员并提供事件号'
export function hidesInternals() {
  return runtimeMode() === 'production'
}

export function ok(res, data, extra = {}) {
  res.json({ code: 0, success: true, data, ...extra })
}

export function fail(res, message, status = 400, code = 1, detail) {
  res.status(status).json({ code, success: false, message, detail })
}

export function pageParams(req) {
  const page = Math.max(parseInt(req.query.page || '1', 10) || 1, 1)
  const pageSize = Math.min(Math.max(parseInt(req.query.pageSize || '20', 10) || 20, 1), 500)
  return { page, pageSize, offset: (page - 1) * pageSize }
}

export function paged(res, { rows, total, page, pageSize, ...extra }) {
  res.json({
    code: 0,
    success: true,
    data: {
      list: rows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize) || 1,
      // 透传 summary / statusLabels 等附加聚合字段
      ...extra
    }
  })
}

/**
 * HTTP 状态码的**唯一出处**：`.status` → `.httpStatus` → `.http` → 500。
 *
 * 为什么必须抽成一处（而不是各写各的兜底链）：
 *   `bizFail` 用它定**响应码**，`errorHandler` 用它决定**要不要打 `[error]` 日志**。
 *   这两处各算一遍、字段顺序还不一样时，会出现"**日志里的码 ≠ 用户看到的码**"：
 *   只有 `.httpStatus` / `.http` 的错误（`ImError` 只写 httpStatus，`ArError`/`InvoiceError`
 *   额外写 http），按 `err.status || 500` 会算成 500 → 日志记成 500，而响应实际是 400/404。
 *   一条 400 的参数错误在日志里写成 500，排查时会被带向"服务器挂了"——
 *   这正是当初要收敛业务码落点时想消灭的那类"错方向"。
 *
 * 这也解释了 `lib/agreement.js` / `lib/ar.js` 里那句注释的意义：各领域错误类**同时**写 `.status`
 * 就是为了让老口径也算得对。现在无论写哪个字段，算出来的都是同一个数。
 */
export function statusOf(err) {
  return err?.status || err?.httpStatus || err?.http || 500
}

/**
 * **带业务码的失败响应 —— 唯一构造点。**
 *
 * 各 lib（促销 / 会员 / 券 / 结算 / 退货 / 单据内核…）抛出的都是同一个形状：
 * `{ message, status, code, detail }`，`code` 是 `PERIOD_CLOSED` / `DOC_STATE_ILLEGAL`
 * 这类字符串业务码。
 *
 * 为什么必须只有这一处：同一个业务码会因**入口不同**而落在不同字段里 ——
 * 路由层的"翻译"只写 `detail.code`，全局兜底中间件只写顶层 `error`，
 * 单据流转两处都写。调用方（前端 / 测试）为了读一个码得写 `b.error || b.detail?.code`
 * 两套判断，少写一半就漏判；而"漏判"的表现是错误提示退化成一句中文，报障时无从定位。
 * 收敛到这里后，任何入口产出的形状都一致。
 *
 * 为什么 `error` 与 `detail.code` **两处都写**：这两个读法各自都已有使用者
 * （前端历史读法 + 三套测试里的 `detail?.code || error` 兜底），删任何一处都是破坏性改动。
 * 两处同值是最小代价的兼容，等读法统一后再收一处。
 * 顶层 `code` 保持数字 1（项目约定：顶层 code 是数字，业务码放字符串字段）；
 * 无业务码时顶层 `code` 退回 HTTP status —— 与旧的全局中间件行为一致。
 *
 * `status` 走 `statusOf`（与 `errorHandler` 的日志判定同源，见上）。
 * 第三参 `incidentId`：`errorHandler` 已为 5xx 打过日志时传入，让响应与日志用同一个事件号。
 */
export function bizFail(res, err, incidentId = null) {
  const status = statusOf(err)
  // **业务码 = 有 `code` 且自带 HTTP 状态**（与 `failFromError` 的门同源）。
  // 只有 `code` 没有状态的是**运行时错误**：better-sqlite3 的 `SqliteError.code='SQLITE_ERROR'`、
  // Node 的 `ENOENT` / `ERR_*`…… 它们原来也被当业务码回给客户端（`error:'SQLITE_ERROR'` + 表名文案），
  // 正是 F13 说的"错误响应泄露内部结构"。这类一律按无业务码的 5xx 处理。
  const code = err?.code && (err.status || err.httpStatus || err.http) ? err.code : null
  const body = {
    code: code ? 1 : status,
    success: false,
    message: err?.message || '服务器内部错误'
  }
  // 5xx 的 `detail` 一律脱敏（凭据键遮盖）；4xx 的 detail 是校验反馈（字段名 / 可选值），原样回。
  const detailOf = (d) => (status >= 500 ? redactValue(d) : d)
  if (code) {
    body.error = code
    // ⚠️ 展开**必须在 `code` 之前**：写反了（`{ code, ...err.detail }`）时，只要
    // `err.detail` 自己带 `code` 键，业务码就会被**静默覆盖** —— `agreement.js` 传的
    // `{ agreement_id, code: a.code }`（`a.code` 是**协议号** AG2026-xxx）就真的撞上了：
    // `error='AGREEMENT_BELOW_FLOOR'` 而 `detail.code='AG2026-001'`，同一份响应里
    // 两处读法拿到两个不同的东西，且没有任何报错。`code` 是**保留键**。
    body.detail = { ...detailOf(err.detail || {}), code }
  } else if (status >= 500) {
    // **无业务码的 5xx = 预期之外的内部错误**（SQLite 抛的、TypeError…）：
    //   · 事件号：`errorHandler` 已经打过日志就沿用它的；别的入口直接调 `bizFail` 时这里自己打，
    //     否则响应里的事件号在日志里找不到对应（事件号指向空处比没有事件号更误导）；
    //   · 生产：文案换成通用语 + 事件号，`detail` 不回（F13：错误响应泄露内部结构）；
    //   · demo / test：保留 `message` 与脱敏后的 `detail`，联调时能直接看到原因。
    // 带业务码的 5xx（`FEATURE_DISABLED` / `SECURITY_AUDIT_UNAVAILABLE`…）是各 lib **刻意**给出的
    // 文案，不在此列 —— 它们走上面那个分支，形状不变。
    const id = incidentId || newIncidentId()
    if (!incidentId) console.error('[error]', id, err)
    body.incident_id = id
    if (hidesInternals()) body.message = `${GENERIC_5XX_MESSAGE}：${id}`
    else if (err?.detail) body.detail = detailOf(err.detail)
  } else if (err?.detail) {
    // 无业务码时仍透传 detail（旧中间件的行为），只是不再有 code 可写
    body.detail = err.detail
  }
  res.status(status).json(body)
}

/**
 * 把**业务库抛出的错误**翻译成响应（`bizFail` 的薄封装）。
 *
 * 各 lib 抛出的都是同一个形状：`{ message, status, code, detail }`。不统一翻译的后果是
 * 用户看到 500「服务器错误」，而真实原因（券已用过 / 积分不足 / 超过退量上限）
 * 本来是可以直接告诉他的。
 *
 * 保留这个函数是因为它在各路由里已用了很多处，签名不动；形状构造已交给 `bizFail`，
 * 这里只剩"是不是业务错误"这一条判定。
 * 返回 `true` 表示已处理；返回 `false` 表示这不是业务错误，交给上层（500）。
 *
 * ⚠️ **这条门（`e.code && e.status`）故意比 `statusOf` 窄，不要"顺手统一"成
 * `e.code && statusOf(e)`。** 理由不是保守，而是**日志**：
 * 拓宽之后，"有 `code` + **只写了 httpStatus** 的 **5xx** 错误"会被这里**本地接管**，
 * 而 `failFromError` **不打日志** —— 于是 5xx 不再进 `errorHandler` 的 `[error]`，
 * 线上就没有任何痕迹。用"少一次异常穿越"去换"5xx 静默无日志"不划算。
 * 现在这条路径的代价只是多一次 throw（响应码由 `bizFail` 的 `statusOf` 定，是对的）。
 * 判据由 `scripts/check-bizcode-shape.mjs` 的动态断言守着（三入口形状一致 + 日志码同源）。
 */
export function failFromError(res, e) {
  if (e && e.code && e.status) {
    bizFail(res, e)
    return true
  }
  return false
}

export function wrap(handler) {
  return (req, res, next) => {
    try {
      const r = handler(req, res, next)
      if (r && typeof r.then === 'function') r.catch(next)
    } catch (e) {
      next(e)
    }
  }
}
