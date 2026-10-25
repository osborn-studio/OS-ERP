/**
 * ============================================================================
 * 文件标识：server/lib/secret-box.js ｜ 配置型密钥的静态加密盒：AES-256-GCM + 版本前缀，旧明文可读、写时升级、支持轮换（ADR-0008 / F09）
 * ============================================================================
 * 【这块解决什么问题】
 *   通知渠道的签名密钥（钉钉加签、飞书加签、通用 webhook HMAC）原来按明文写进 SQLite，
 *   并且会原样出现在 GET 响应里。数据库文件、备份、日志导出、任何一个有渠道管理权限的账号，
 *   都能把它拿走。本模块只负责"落库前封、取用时开"，**不负责**决定谁能看（那是路由与 publicChannel 的事）。
 *
 * 【为什么这样设计】
 *   · 密钥来源只有一条优先链：`GML_SECRET_KEY`（专用）→ 否则由 JWT 密钥（`jwtSecretPosture` 的唯一出处）
 *     经 HKDF 派生。生产环境 JWT 密钥缺失/公开值时服务根本起不来，所以生产不会用公开值封存。
 *   · 封存格式带版本前缀 `enc:v1:`：没有前缀的值视为**旧明文**，照常可读；下一次写入该行时重新封存。
 *     不做一次性迁移脚本去碰生产库，升级发生在业务自己的写路径上，可回滚、可观察。
 *   · 轮换：`GML_SECRET_KEY_PREVIOUS`（逗号分隔）里的旧密钥只用于**解**，新写入一律用当前密钥。
 *     运维步骤：把旧值挪到 PREVIOUS、设新 GML_SECRET_KEY、重启；让每个渠道被保存一次（或等自然写入）；
 *     确认库里没有旧密钥能解而新密钥不能解的行后，再清掉 PREVIOUS。
 *
 * 【改它要注意什么】
 *   · 不要把 `openSecret` 的结果写进日志或响应；只允许 `maskSecret` 的形态外露。
 *   · 改格式必须升版本号（enc:v2:），并保留 v1 的解法；绝不能让旧行变成不可读。
 *   · 本模块只依赖 node:crypto 与 middleware/auth.js 的密钥姿态函数，可在单元测试里直接导入。
 * ============================================================================
 */

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, createHmac } from 'node:crypto'
import { jwtSecretPosture } from '../middleware/auth.js'

export const SEALED_PREFIX = 'enc:v1:'
const ALGO = 'aes-256-gcm'
const IV_BYTES = 12
const HKDF_SALT = 'gml-secret-box-v1'
const HKDF_INFO = 'notify-channel-secret'
/** 专用密钥的最小长度：短于这个值等于没加密 */
const MIN_KEY_CHARS = 16
/** 掩码只在密钥足够长时露出末 4 位，短密钥一位都不露 */
const LAST4_MIN_CHARS = 12

export class SecretBoxError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
    this.httpStatus = 500
    this.status = 500
  }
}

const derive = (ikm) => Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, HKDF_INFO, 32))

/** 当前密钥在前，轮换中的旧密钥在后。纯函数（只看 env），可单测。 */
function keyRing(env = process.env) {
  const explicit = String(env.GML_SECRET_KEY ?? '').trim()
  if (explicit && explicit.length < MIN_KEY_CHARS) {
    throw new SecretBoxError('SECRET_BOX_KEY_WEAK', `GML_SECRET_KEY 至少 ${MIN_KEY_CHARS} 个字符`)
  }
  const current = explicit || jwtSecretPosture(env).secret
  const previous = String(env.GML_SECRET_KEY_PREVIOUS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
  return [current, ...previous].map(derive)
}

export const isSealed = (stored) => typeof stored === 'string' && stored.startsWith(SEALED_PREFIX)

/** 封存明文；空值封存为空串（"没有密钥"就是没有，不造一个加密后的空）。 */
export function sealSecret(plain, env = process.env) {
  const text = String(plain ?? '')
  if (!text) return ''
  const [key] = keyRing(env)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const ct = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${SEALED_PREFIX}${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`
}

/** 取出明文：带前缀的逐把钥匙试解；不带前缀的按旧明文原样返回。 */
export function openSecret(stored, env = process.env) {
  if (stored == null) return ''
  const s = String(stored)
  if (!isSealed(s)) return s
  const parts = s.slice(SEALED_PREFIX.length).split('.')
  if (parts.length !== 3) throw new SecretBoxError('SECRET_BOX_UNREADABLE', '密文格式不正确')
  const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64url'))
  for (const key of keyRing(env)) {
    try {
      const decipher = createDecipheriv(ALGO, key, iv)
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
    } catch {
      /* 换下一把钥匙 */
    }
  }
  throw new SecretBoxError('SECRET_BOX_UNREADABLE', '无法用当前或轮换中的密钥解开该值（密钥已更换？）')
}

/** 已封存的保持原样；旧明文重新封存 —— "写时升级"的唯一实现。 */
export function resealIfLegacy(stored, env = process.env) {
  if (stored == null || stored === '') return ''
  return isSealed(stored) ? String(stored) : sealSecret(stored, env)
}

/** 对外只允许的形态：有没有、末 4 位（仅足够长时）。 */
export function maskSecret(plain) {
  const s = String(plain ?? '')
  return { has_secret: s.length > 0, secret_last4: s.length >= LAST4_MIN_CHARS ? s.slice(-4) : null }
}

/**
 * 脱敏用的带钥哈希（ADR-0030）：HMAC-SHA256(由当前密钥按 `purpose` 派生的子钥, 输入)，取前 `bytes` 字节十六进制。
 * 与封存用的子钥**不同 info**，两者互不可推；只用**当前**密钥（不用轮换中的旧钥）。
 * 生产模式下密钥若是公开值 / 缺失（`jwtSecretPosture` 为 public-default / fallback）直接抛 —— 手机号空间只有 10^10，
 * 拿公开密钥做的"哈希"等于没脱敏。
 */
export function keyedPseudonym(purpose, input, { env = process.env, bytes = 12 } = {}) {
  const explicit = String(env.GML_SECRET_KEY ?? '').trim()
  if (explicit && explicit.length < MIN_KEY_CHARS) {
    throw new SecretBoxError('SECRET_BOX_KEY_WEAK', `GML_SECRET_KEY 至少 ${MIN_KEY_CHARS} 个字符`)
  }
  let ikm = explicit
  if (!ikm) {
    const posture = jwtSecretPosture(env)
    if (env.GML_RUNTIME_MODE === undefined || env.GML_RUNTIME_MODE === 'production') {
      if (posture.source !== 'env') {
        throw new SecretBoxError('PSEUDONYM_KEY_UNSAFE', '生产模式做不可逆脱敏需要显式 GML_SECRET_KEY 或非公开的 GML_JWT_SECRET')
      }
    }
    ikm = posture.secret
  }
  const sub = Buffer.from(hkdfSync('sha256', ikm, HKDF_SALT, `pseudonym:${purpose}`, 32))
  return createHmac('sha256', sub).update(String(input)).digest('hex').slice(0, bytes * 2)
}

export default { SEALED_PREFIX, SecretBoxError, isSealed, sealSecret, openSecret, resealIfLegacy, maskSecret, keyedPseudonym }
