/**
 * ============================================================================
 * 文件标识：server/lib/qimen-auth.js ｜ 奇门网关鉴权：每平台独立密钥（封存）、HMAC-SHA256 签名、5 分钟时间窗、nonce 防重放（ADR-0033）
 * ============================================================================
 * 【这块解决什么问题】网关原来用公开演示常量验签，且 `/capabilities` 向任意登录用户列出 app_key。
 *   本模块是签名契约与凭据生命周期的**唯一出处**：路由只调 `verifyQimenRequest` / `issuePlatformSecret`。
 *
 * 【签名契约（v2，破坏性变更）】请求体 `{ method, app_key, timestamp, nonce, sign, request }`：
 *   · `timestamp`：UTC 毫秒时间戳（13 位整数或数字串），与服务器时间相差不得超过 5 分钟（±）；
 *   · `nonce`：16–64 位 `[A-Za-z0-9_-]`，同一平台在窗口内只能用一次；
 *   · `sign` = 大写十六进制 `HMAC-SHA256(平台密钥, canonical)`；
 *   · `canonical` = 以 `\n` 连接：`app_key`、`method`、`timestamp`、`nonce`、`sha256hex(canonicalJson(request))`；
 *   · `canonicalJson`：递归按键名升序、无空白的 JSON（即 `JSON.stringify` 语义）；缺省 `request` 视为 `{}`。
 *   旧版 `MD5(app_key+method+secret)` 不再接受。
 *
 * 【防重放语义】nonce 只在**签名通过之后**写入 `qimen_nonces`（主键 platform_id+nonce），所以未持有密钥的人既无法
 *   占用 nonce，也无法撑大表。保留 11 分钟（窗口 ±5 分钟 ⇒ 一个 nonce 最长可能被接受 10 分钟），之后在每次接受时顺带清理。
 *   表在库里，重启不丢；多实例共库也成立。
 *
 * 【密钥】`qsk_` + 32 随机字节十六进制，签发时只在响应里出现一次；库里是 `secret-box` 封存值。读取时**要求**带
 *   `enc:v1:` 前缀 —— 旧明文（例如被人经通用主数据接口写进去的值）一律视为未签发，避免"写个明文就能签名"。
 *
 * 【改它要注意什么】不要把 `openSecret` 的结果写进日志/响应；公开形态只有 `publicPlatform`（has_secret、末 4 位掩码）。
 * ============================================================================
 */
import crypto from 'node:crypto'
import { isSealed, sealSecret, openSecret, maskSecret } from './secret-box.js'
import { localNow } from './dates.js'
import { runtimeMode } from '../runtime.js'

export const WINDOW_MS = 5 * 60 * 1000
export const NONCE_RETAIN_MS = 11 * 60 * 1000
const MAX_DEPTH = 32
const RETIRED_PUBLIC_DEMO_CONSTANT = 'GML-DEMO-SECRET' // 仅用于拒绝；迁移 069 会把库内同值清空
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/
const TS_RE = /^\d{13}$/

/** 网关 401 的稳定协议码 */
export const QIMEN_CODES = {
  APP_KEY_MISSING: '1003',
  SIGN_INVALID: '1004',
  SECRET_NOT_ISSUED: '1005',
  TIMESTAMP_INVALID: '1006',
  NONCE_INVALID: '1007',
  REPLAY: '1008'
}

/** 递归键名排序的紧凑 JSON；超深或含循环返回 null（调用方按验签失败处理）。 */
export function canonicalJson(value, depth = 0) {
  if (depth > MAX_DEPTH) return null
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) {
    const parts = value.map((v) => canonicalJson(v, depth + 1))
    return parts.includes(null) ? null : `[${parts.join(',')}]`
  }
  const parts = []
  for (const k of Object.keys(value).sort()) {
    if (value[k] === undefined) continue
    const c = canonicalJson(value[k], depth + 1)
    if (c === null) return null
    parts.push(`${JSON.stringify(k)}:${c}`)
  }
  return `{${parts.join(',')}}`
}

export function canonicalString({ appKey, method, timestamp, nonce, request }) {
  const body = canonicalJson(request ?? {})
  if (body === null) return null
  const digest = crypto.createHash('sha256').update(body, 'utf8').digest('hex')
  return [appKey, method, timestamp, nonce, digest].join('\n')
}

/** 客户端与服务端共用的签名函数（测试与调试台按同一契约）。 */
export function signQimen(secret, parts) {
  const canon = canonicalString(parts)
  if (canon === null) return null
  return crypto.createHmac('sha256', secret).update(canon, 'utf8').digest('hex').toUpperCase()
}

const fail = (code, message) => ({ ok: false, code, message })

/**
 * 校验一次网关请求（平台已按 app_key 查到且 active）。成功才消耗 nonce。
 * @returns {{ok:true}|{ok:false,code:string,message:string}}
 */
export function verifyQimenRequest(db, platform, body, now = Date.now()) {
  const stored = platform.app_secret_sealed
  if (!stored || !isSealed(stored)) return fail(QIMEN_CODES.SECRET_NOT_ISSUED, '平台尚未签发密钥，请联系管理员')
  const tsText = typeof body.timestamp === 'number' ? String(body.timestamp) : body.timestamp
  if (typeof tsText !== 'string' || !TS_RE.test(tsText)) return fail(QIMEN_CODES.TIMESTAMP_INVALID, 'timestamp 必须是 13 位毫秒时间戳')
  if (Math.abs(now - Number(tsText)) > WINDOW_MS) return fail(QIMEN_CODES.TIMESTAMP_INVALID, 'timestamp 超出允许的 5 分钟窗口')
  if (typeof body.nonce !== 'string' || !NONCE_RE.test(body.nonce)) return fail(QIMEN_CODES.NONCE_INVALID, 'nonce 必须是 16-64 位字母数字/下划线/连字符')
  if (typeof body.sign !== 'string' || !body.sign) return fail(QIMEN_CODES.SIGN_INVALID, '缺少签名')
  let secret
  try {
    secret = openSecret(stored)
  } catch {
    return fail(QIMEN_CODES.SECRET_NOT_ISSUED, '平台密钥无法读取，请重新签发')
  }
  // 兜底（审计）：已退役的公开演示常量即使被写进库里也永不接受
  if (secret === RETIRED_PUBLIC_DEMO_CONSTANT) return fail(QIMEN_CODES.SECRET_NOT_ISSUED, '平台尚未签发密钥，请联系管理员')
  const expected = signQimen(secret, {
    appKey: platform.app_key,
    method: typeof body.method === 'string' ? body.method : '',
    timestamp: tsText,
    nonce: body.nonce,
    request: body.request
  })
  const given = Buffer.from(body.sign.toUpperCase())
  const want = Buffer.from(expected || '')
  if (!expected || given.length !== want.length || !crypto.timingSafeEqual(given, want)) return fail(QIMEN_CODES.SIGN_INVALID, '签名校验失败')
  // 签名已通过：占用 nonce（主键冲突 = 重放）。清理放在占用之后，失败请求不触发写。
  try {
    db.prepare('INSERT INTO qimen_nonces (platform_id, nonce, seen_at) VALUES (?,?,?)').run(platform.id, body.nonce, now)
  } catch (e) {
    if (String(e?.code || '').startsWith('SQLITE_CONSTRAINT')) return fail(QIMEN_CODES.REPLAY, 'nonce 已使用（疑似重放）')
    throw e
  }
  db.prepare('DELETE FROM qimen_nonces WHERE seen_at < ?').run(now - NONCE_RETAIN_MS)
  return { ok: true }
}

export class QimenCredentialError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.httpStatus = status
    this.code = code
  }
}

/**
 * 签发或轮换平台密钥。已有密钥且未显式 rotate ⇒ 409（防止重复点击把刚发出的密钥作废）。
 * 返回值里的 `secret` 是唯一一次明文出现。
 */
export function issuePlatformSecret(db, platformId, { rotate = false, env = process.env } = {}) {
  const pf = db.prepare('SELECT id, app_key, app_secret_sealed FROM platforms WHERE id=?').get(platformId)
  if (!pf) throw new QimenCredentialError(404, 'PLATFORM_NOT_FOUND', '平台不存在')
  if (!pf.app_key) throw new QimenCredentialError(409, 'QIMEN_APP_KEY_MISSING', '平台尚未设置 app_key，请先在平台档案里填写')
  const had = !!pf.app_secret_sealed
  if (had && rotate !== true) throw new QimenCredentialError(409, 'QIMEN_SECRET_EXISTS', '平台已有密钥；如需轮换请显式确认（旧密钥立即失效）')
  const secret = `qsk_${crypto.randomBytes(32).toString('hex')}`
  const rotatedAt = localNow()
  db.prepare('UPDATE platforms SET app_secret_sealed=?, app_secret_rotated_at=?, app_secret_masked=? WHERE id=?')
    .run(sealSecret(secret, env), rotatedAt, `****${maskSecret(secret).secret_last4}`, pf.id)
  // 轮换后旧密钥签出的请求本就验不过；清掉该平台旧 nonce 只是回收空间
  db.prepare('DELETE FROM qimen_nonces WHERE platform_id=?').run(pf.id)
  return { id: pf.id, app_key: pf.app_key, secret, rotated: had, rotated_at: rotatedAt, secret_last4: maskSecret(secret).secret_last4 }
}

/**
 * 演示/测试模式启动时的"按安装"密钥（AB8）：演示平台 = id 最小且有 app_key 的 active 平台；它还没有密钥时，
 * 生成一个随机 `qsk_` 密钥封存进 `platforms`。明文**不返回、不记录、不落仓库** —— 这个密钥只是让演示平台"不是空的也不是公开常量"，
 * 要联调的人用 `scripts/qimen-issue-key.mjs --rotate` 拿一个自己看得见的。已有密钥（含管理员签发的）一律不动，重启不换。
 * 生产模式一律不生成（缺密钥的平台继续 401 `1005`，且网关本身由能力闸门 503 关闭）。
 * @returns {{created:false, reason:string}|{created:true, platform_id:number, app_key_prefix:string, secret_last4:string}}
 */
export function ensureDemoQimenSecret(db, { env = process.env } = {}) {
  if (runtimeMode(env) === 'production') return { created: false, reason: 'production' }
  const pf = db
    .prepare("SELECT id, app_key, app_secret_sealed FROM platforms WHERE app_key IS NOT NULL AND app_key<>'' AND status='active' ORDER BY id LIMIT 1")
    .get()
  if (!pf) return { created: false, reason: 'no-platform' }
  if (pf.app_secret_sealed) return { created: false, reason: 'exists' }
  const secret = `qsk_${crypto.randomBytes(32).toString('hex')}`
  const last4 = maskSecret(secret).secret_last4
  db.prepare('UPDATE platforms SET app_secret_sealed=?, app_secret_rotated_at=?, app_secret_masked=? WHERE id=?')
    .run(sealSecret(secret, env), localNow(), `****${last4}`, pf.id)
  return { created: true, platform_id: pf.id, app_key_prefix: String(pf.app_key).slice(0, 4), secret_last4: last4 }
}

/** app_key 对外只给前 4 位（AB8）：足够管理员对号入座，不足以冒充调用方。 */
export const APP_KEY_PREFIX_LEN = 4
export const appKeyPrefix = (appKey) => String(appKey ?? '').slice(0, APP_KEY_PREFIX_LEN)

/** 平台行的对外形态：去掉封存值，换成 has_secret / rotated_at。 */
export function publicPlatform(row) {
  if (!row) return row
  const { app_secret_sealed: sealed, app_secret_rotated_at: rotatedAt, ...rest } = row
  return { ...rest, has_secret: !!sealed, secret_rotated_at: rotatedAt || null }
}

/** 通用主数据接口（crudRouter）读取平台时的列清单：不含封存值。 */
export const PLATFORM_PUBLIC_SELECT =
  `platforms.id, platforms.code, platforms.platform_code, platforms.name, platforms.shop_name, platforms.type, platforms.adapter,
   platforms.app_key, platforms.app_secret_masked, platforms.qimen_url, platforms.qimen_wh, platforms.shop_code,
   platforms.sync_stock, platforms.sync_order, platforms.warehouse_id, platforms.status, platforms.last_sync_at, platforms.remark,
   (platforms.app_secret_sealed IS NOT NULL AND platforms.app_secret_sealed<>'') AS has_secret,
   platforms.app_secret_rotated_at AS secret_rotated_at`
export const PLATFORM_PROTECTED_FIELDS = ['app_secret_sealed', 'app_secret_rotated_at', 'app_secret_masked']

export default { WINDOW_MS, NONCE_RETAIN_MS, QIMEN_CODES, canonicalJson, canonicalString, signQimen, verifyQimenRequest, issuePlatformSecret, ensureDemoQimenSecret, appKeyPrefix, publicPlatform }
