'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/069_qimen_clear_demo_secret.cjs ｜ 清除库内的公开奇门演示签名常量（AB8 / ADR-0033 补充）
 * ============================================================================
 * 【为什么】早期奇门网关用公开常量 `GML-DEMO-SECRET` 验签（ADR-0028 "边界"节）。060 之后代码里已没有这个常量，但**库**里
 *   仍可能留有它：旧库里 `app_secret_sealed` 被人经通用主数据接口写入明文，或把常量封存后写入。任何持有同一常量的人
 *   都能给这些平台签名，所以本迁移把这类行的密钥、签发时间、掩码一并清空（平台回到"未签发"，网关 401 `1005`），
 *   并清掉这些平台的 nonce；之后唯一的取得密钥的方式是 `scripts/qimen-issue-key.mjs`（或管理接口）。
 * 【事实记录】至少清掉一行时，写入 `settings` 的 `qimen_demo_secret_cleared`（JSON：次数与时间，**不含**任何密钥）。
 *   一行都没有清掉时不写（干净库不产生配置噪音）。该键由 `lib/settings.js` 的审计显式放行（内部标记，非可配项）。
 * 【判据只有一处】下面的 `isDemoConstant`；up() 与 verify() 共用它。封存值需要当前密钥才打得开：打不开（密钥已更换、
 *   或运行环境不支持 require(esm)）就当作"不是演示常量"，不会误清真实密钥。
 * 【不引入常量】常量不写进别处；这里为了比对必须出现一次，且仅此一次。
 * 【编号】068 属于并行工作流（AB6），缺号不影响运行器。
 * ============================================================================
 */
const { tableExists, hasColumn } = require('./_helpers.cjs')

module.exports.name = '清除库内公开奇门演示签名常量并记录事实'

const PUBLIC_DEMO_CONSTANT = 'GML-DEMO-SECRET'
const FACT_KEY = 'qimen_demo_secret_cleared'

let secretBox = null
function box() {
  if (secretBox === null) {
    try {
      secretBox = require('../../lib/secret-box.js')
    } catch {
      secretBox = false
    }
  }
  return secretBox || null
}

/** 该库值是否就是公开演示常量（明文，或能用当前密钥打开的封存值）。 */
function isDemoConstant(stored) {
  if (typeof stored !== 'string' || stored === '') return false
  if (stored === PUBLIC_DEMO_CONSTANT) return true
  const b = box()
  if (!b || !b.isSealed(stored)) return false
  try {
    return b.openSecret(stored) === PUBLIC_DEMO_CONSTANT
  } catch {
    return false
  }
}

function affectedIds(db) {
  if (!tableExists(db, 'platforms') || !hasColumn(db, 'platforms', 'app_secret_sealed')) return []
  return db
    .prepare("SELECT id, app_secret_sealed FROM platforms WHERE app_secret_sealed IS NOT NULL AND app_secret_sealed<>''")
    .all()
    .filter((r) => isDemoConstant(r.app_secret_sealed))
    .map((r) => r.id)
}

module.exports.up = (db) => {
  const ids = affectedIds(db)
  if (!ids.length) return
  const clear = db.prepare('UPDATE platforms SET app_secret_sealed=NULL, app_secret_rotated_at=NULL, app_secret_masked=NULL WHERE id=?')
  const nonces = tableExists(db, 'qimen_nonces') ? db.prepare('DELETE FROM qimen_nonces WHERE platform_id=?') : null
  for (const id of ids) {
    clear.run(id)
    if (nonces) nonces.run(id)
  }
  if (!tableExists(db, 'settings')) return
  const prev = db.prepare('SELECT value FROM settings WHERE key=?').get(FACT_KEY)
  let total = ids.length
  try {
    total += Number(JSON.parse(prev?.value || '{}').cleared) || 0
  } catch {
    /* 旧值不可解析就从本次重新计 */
  }
  db.prepare(
    `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
  ).run(FACT_KEY, JSON.stringify({ cleared: total, at: new Date().toISOString(), migration: '069' }))
}

module.exports.verify = (db) => affectedIds(db).length === 0
