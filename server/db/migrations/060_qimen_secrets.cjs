'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/060_qimen_secrets.cjs ｜ 奇门网关每平台独立密钥（封存存储）、防重放 nonce 表、oms.platform.manage 权限点（ADR-0033）
 * ============================================================================
 * 【为什么】奇门签名原来用公开演示常量 `GML-DEMO-SECRET`，任何知道 app_key 的人都能签。本迁移只加存储：
 *   · `platforms.app_secret_sealed`     用 `server/lib/secret-box.js` 封存的平台密钥（`enc:v1:` 前缀；明文不落库）；
 *   · `platforms.app_secret_rotated_at` 最近一次签发/轮换时间（本地时间串）；
 *   · `qimen_nonces`                    已接受请求的 nonce（主键 platform_id + nonce），用于 5 分钟窗口内拒绝重放；
 *   · 权限点 `oms.platform.manage`      签发/轮换平台密钥与读取 `/api/qimen/capabilities`。
 * 【ADR-0007 口径】授权只在 `up()` 首次执行时给 admin；`verify()` 只查列/表/权限字典是否存在，不查角色授权集合。
 * 【迁移安全】全部为加法：加列（可空）、`CREATE TABLE IF NOT EXISTS`、权限 upsert；不改旧列，不碰旧数据。
 *   已有平台的 `app_secret_sealed` 为 NULL ⇒ 网关一律 401（凭据未签发），需管理员显式签发。
 * 【编号】059 之后。
 * ============================================================================
 */
const { tableExists, hasColumn, addColumn, hasIndex } = require('./_helpers.cjs')

module.exports.name = '奇门网关每平台密钥（封存）、防重放 nonce 表与 oms.platform.manage 权限点'

const PERM = ['oms.platform.manage', '平台店铺管理（签发/轮换奇门密钥、查看奇门接入清单）', 'oms', 'action', 4100]

module.exports.up = (db) => {
  if (tableExists(db, 'platforms')) {
    addColumn(db, 'platforms', 'app_secret_sealed', 'TEXT')
    addColumn(db, 'platforms', 'app_secret_rotated_at', 'TEXT')
  }
  db.exec(`CREATE TABLE IF NOT EXISTS qimen_nonces (
    platform_id INTEGER NOT NULL,
    nonce TEXT NOT NULL,
    seen_at INTEGER NOT NULL,
    PRIMARY KEY (platform_id, nonce)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS idx_qimen_nonces_seen ON qimen_nonces(seen_at)')
  if (!tableExists(db, 'permissions')) return
  db.prepare(
    `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
     ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
  ).run(...PERM)
  if (!tableExists(db, 'role_permissions')) return
  const hasRole = db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get('admin')
  if (hasRole) db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)').run('admin', PERM[0])
}

module.exports.verify = (db) => {
  if (tableExists(db, 'platforms')) {
    if (!hasColumn(db, 'platforms', 'app_secret_sealed') || !hasColumn(db, 'platforms', 'app_secret_rotated_at')) return false
  }
  if (!tableExists(db, 'qimen_nonces') || !hasIndex(db, 'idx_qimen_nonces_seen')) return false
  if (tableExists(db, 'permissions') && !db.prepare('SELECT 1 FROM permissions WHERE code=?').get(PERM[0])) return false
  return true
}
