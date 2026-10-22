/**
 * ============================================================================
 * 文件标识：server/lib/login-throttle.js ｜ 持久化、有容量上限的登录尝试节流
 * IP 跨行业共享；账号键保留查询大小写语义。校验密码前原子消费，数据库失败时拒绝。
 * ============================================================================
 */
import Database from 'better-sqlite3'
import { createHmac, randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isIP } from 'node:net'
import { runtimeMode, requireDataDirectory } from '../runtime.js'
import { classifyEmptyDatabase } from '../db/runtime-policy.js'

export const DEFAULT_LOGIN_THROTTLE_POLICY = Object.freeze({
  ipLimit: 60, ipWindowMs: 60000,
  accountLimit: 10, accountWindowMs: 300000,
  maxBuckets: 10000
})
const ENV_POLICY = {
  ipLimit: 'GML_LOGIN_IP_LIMIT', ipWindowMs: 'GML_LOGIN_IP_WINDOW_MS',
  accountLimit: 'GML_LOGIN_ACCOUNT_LIMIT', accountWindowMs: 'GML_LOGIN_ACCOUNT_WINDOW_MS',
  maxBuckets: 'GML_LOGIN_MAX_BUCKETS'
}

function unavailable() {
  return Object.assign(new Error('Login protection is temporarily unavailable'), {
    status: 503, code: 'LOGIN_THROTTLE_UNAVAILABLE'
  })
}

function checkedPolicy(input = {}) {
  const policy = { ...DEFAULT_LOGIN_THROTTLE_POLICY, ...input }
  if (Object.keys(input).some(key => !Object.hasOwn(DEFAULT_LOGIN_THROTTLE_POLICY, key))) throw new Error('Unknown login throttle policy field')
  for (const [key, value] of Object.entries(policy)) {
    const [min, max] = key.endsWith('WindowMs') ? [1000, 86400000] : key === 'maxBuckets' ? [2, 100000] : [1, 10000]
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid login throttle policy: ${key}`)
  }
  return policy
}

function policyFromEnv(env) {
  const input = {}
  for (const [key, envKey] of Object.entries(ENV_POLICY)) {
    if (env[envKey] !== undefined) {
      if (!/^\d+$/.test(env[envKey])) throw new Error(`Invalid login throttle policy: ${key}`)
      input[key] = Number(env[envKey])
    }
  }
  return checkedPolicy(input)
}

function checkedTime(now) {
  const value = now()
  if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 86400000) throw new Error('Invalid login throttle clock')
  return value
}

function normalizedIp(value) {
  const version = typeof value === 'string' && value.length <= 128 ? isIP(value) : 0
  if (version === 4) return value
  if (version === 6) {
    const ip = new URL(`http://[${value.split('%')[0]}]/`).hostname.slice(1, -1)
    const mapped = ip.match(/^::ffff:([a-f0-9]{1,4}):([a-f0-9]{1,4})$/)
    if (mapped) {
      const high = Number.parseInt(mapped[1], 16), low = Number.parseInt(mapped[2], 16)
      return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`
    }
    return ip
  }
  throw Object.assign(new Error('Invalid login request source'), { status: 400, code: 'LOGIN_THROTTLE_INPUT_INVALID' })
}

/** Caller validates/normalizes industry and username exactly as used by the SQL query. */
function requestKeys(input, salt) {
  const { ip, industry, username } = input || {}
  if (typeof industry !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(industry) ||
      typeof username !== 'string' || !username.length || username.length > 64) {
    throw Object.assign(new Error('Invalid login request identity'), { status: 400, code: 'LOGIN_THROTTLE_INPUT_INVALID' })
  }
  const hash = value => createHmac('sha256', salt).update(JSON.stringify(value)).digest('hex')
  return [hash(['ip', normalizedIp(ip)]), hash(['account', industry, username])]
}

/**
 * Creates an independent connection to the data-directory-wide limiter. `now` and
 * explicit policy injection are for deterministic tests/configuration, never HTTP input.
 * No mode disables the limiter. Existing active buckets cannot be erased by a policy change.
 */
export function createLoginThrottle({ dataDir = requireDataDirectory(), mode = runtimeMode(), now = Date.now, policy: inputPolicy = {} } = {}) {
  if (!path.isAbsolute(dataDir)) throw new Error('Login throttle data directory must be absolute')
  runtimeMode({ GML_RUNTIME_MODE: mode })
  const policy = checkedPolicy(inputPolicy)
  const policyJson = JSON.stringify(policy)
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const file = path.join(dataDir, 'login-throttle.sqlite')
  const existed = fs.existsSync(file)
  const db = new Database(file, { timeout: 1000 })
  let salt
  try {
    if (!existed) fs.chmodSync(file, 0o600)
    classifyEmptyDatabase(db, mode)
    db.pragma('journal_mode=WAL')
    db.pragma('synchronous=FULL')
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS login_throttle_meta (
        id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL,
        policy_json TEXT NOT NULL, key_salt BLOB NOT NULL
      );
      CREATE TABLE IF NOT EXISTS login_throttle_buckets (
        key TEXT PRIMARY KEY, attempts INTEGER NOT NULL CHECK(attempts > 0), expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS login_throttle_expiry ON login_throttle_buckets(expires_at)`)
      db.prepare('DELETE FROM login_throttle_buckets WHERE expires_at<=?').run(checkedTime(now))
      const meta = db.prepare('SELECT * FROM login_throttle_meta WHERE id=1').get()
      if (!meta) {
        if (db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n) throw new Error('Throttle metadata missing')
        salt = randomBytes(32)
        db.prepare('INSERT INTO login_throttle_meta (id,schema_version,policy_json,key_salt) VALUES (1,1,?,?)').run(policyJson, salt)
      } else {
        if (meta.schema_version !== 1 || !Buffer.isBuffer(meta.key_salt) || meta.key_salt.length !== 32) throw new Error('Throttle metadata invalid')
        salt = meta.key_salt
        if (meta.policy_json !== policyJson) {
          if (db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n) throw new Error('Cannot change throttle policy while buckets are active')
          db.prepare('UPDATE login_throttle_meta SET policy_json=? WHERE id=1').run(policyJson)
        }
      }
    }).immediate()
  } catch (error) {
    db.close()
    throw error
  }
  const get = db.prepare('SELECT attempts,expires_at FROM login_throttle_buckets WHERE key=?')
  const insert = db.prepare('INSERT INTO login_throttle_buckets (key,attempts,expires_at) VALUES (?,1,?)')
  const increment = db.prepare('UPDATE login_throttle_buckets SET attempts=attempts+1 WHERE key=?')
  const consume = db.transaction(keys => {
    const timestamp = checkedTime(now)
    // Another process may only change policy after all buckets expire. A stale
    // connection must fail closed instead of applying its former limits afterward.
    if (db.prepare('SELECT policy_json FROM login_throttle_meta WHERE id=1').get()?.policy_json !== policyJson) throw new Error('Throttle policy changed')
    db.prepare('DELETE FROM login_throttle_buckets WHERE expires_at<=?').run(timestamp)
    const rules = [
      { key: keys[0], limit: policy.ipLimit, window: policy.ipWindowMs },
      { key: keys[1], limit: policy.accountLimit, window: policy.accountWindowMs }
    ].map(rule => ({ ...rule, row: get.get(rule.key) }))
    const blocked = rules.filter(rule => rule.row && rule.row.attempts >= rule.limit)
    if (blocked.length) return Math.max(...blocked.map(rule => Math.max(1, Math.ceil((rule.row.expires_at - timestamp) / 1000))))
    const missing = rules.filter(rule => !rule.row).length
    const count = db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n
    if (count + missing > policy.maxBuckets) {
      const earliest = db.prepare('SELECT MIN(expires_at) AS expiry FROM login_throttle_buckets').get().expiry
      return Math.max(1, Math.ceil((earliest - timestamp) / 1000))
    }
    for (const rule of rules) {
      if (rule.row) increment.run(rule.key)
      else insert.run(rule.key, timestamp + rule.window)
    }
    return 0
  })
  return {
    consumeLoginAttempt(input) {
      const keys = requestKeys(input, salt)
      let retryAfter
      try { retryAfter = consume.immediate(keys) } catch { throw unavailable() }
      if (retryAfter) throw Object.assign(new Error('Too many login attempts; try again later'), {
        status: 429, code: 'LOGIN_RATE_LIMITED', retryAfter
      })
      return { allowed: true }
    },
    close() { if (db.open) db.close() }
  }
}

let current
/** Production route API. req.ip comes from the socket unless an operator explicitly trusts a proxy. */
export function consumeLoginAttempt(input) {
  try {
    const options = { dataDir: requireDataDirectory(), mode: runtimeMode(), policy: policyFromEnv(process.env) }
    const signature = JSON.stringify(options)
    if (current?.signature !== signature) {
      current?.limiter.close()
      current = undefined
      current = { signature, limiter: createLoginThrottle(options) }
    }
    return current.limiter.consumeLoginAttempt(input)
  } catch (error) {
    if (['LOGIN_RATE_LIMITED', 'LOGIN_THROTTLE_INPUT_INVALID'].includes(error.code)) throw error
    throw unavailable()
  }
}
