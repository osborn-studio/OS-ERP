/**
 * ============================================================================
 * 文件标识：scripts/qimen-issue-key.mjs ｜ 命令行签发 / 轮换奇门平台密钥（AB8 / ADR-0033 补充：取得密钥的唯一途径之一）
 * 与 `POST /api/qimen/platforms/:id/secret` 共用 `lib/qimen-auth.js` 的 `issuePlatformSecret`（判据只有一处）。
 * 明文只在本命令的标准输出里出现一次；库里只有封存值；审计 `QIMEN_SECRET_ISSUE/ROTATE`（只记 app_key）与凭据变更同事务。
 * ============================================================================
 * 用法：GML_RUNTIME_MODE=demo|test|production GML_DATA_DIR=/绝对路径 [GML_JWT_SECRET / GML_SECRET_KEY]
 *       node scripts/qimen-issue-key.mjs --industry cosmetic|food|apparel --platform <id|平台编码> [--rotate]
 * 已有密钥而没有 --rotate ⇒ 退出码 1（旧密钥不变）；--rotate 后旧密钥立即失效。
 * 注意：封存密钥取自环境（GML_SECRET_KEY，缺省由 JWT 密钥派生），必须与运行服务时一致，否则网关读不出该密钥。
 * ============================================================================
 */
import { parseArgs } from 'node:util'
import { initSchemaFor, assertIndustry } from '../server/db/index.js'
import { requireDataDirectory } from '../server/runtime.js'
import { issuePlatformSecret } from '../server/lib/qimen-auth.js'
import { auditStrictRow } from '../server/lib/audit-trail.js'

const help = `Usage: GML_RUNTIME_MODE=... GML_DATA_DIR=/absolute/path node scripts/qimen-issue-key.mjs
  --industry cosmetic|food|apparel --platform <id|code> [--rotate]
Prints the plaintext secret once to stdout. It is never stored in clear text, logged, or written to the repository.`

let db
try {
  const { values } = parseArgs({
    options: { industry: { type: 'string' }, platform: { type: 'string' }, rotate: { type: 'boolean' }, help: { type: 'boolean' } },
    allowPositionals: false, strict: true
  })
  if (values.help) {
    console.log(help)
  } else {
    requireDataDirectory()
    if (!values.industry || !values.platform) throw Object.assign(new Error('--industry and --platform are required'), { code: 'QIMEN_CLI_INPUT' })
    db = initSchemaFor(assertIndustry(values.industry))
    const ref = String(values.platform)
    const row = /^\d+$/.test(ref)
      ? db.prepare('SELECT id FROM platforms WHERE id=?').get(Number(ref))
      : db.prepare('SELECT id FROM platforms WHERE code=? ORDER BY id LIMIT 1').get(ref)
    if (!row) throw Object.assign(new Error('Platform not found'), { code: 'PLATFORM_NOT_FOUND' })
    const issued = db.transaction(() => {
      const out = issuePlatformSecret(db, row.id, { rotate: values.rotate === true })
      auditStrictRow(db, {
        userName: 'cli:qimen-issue-key', action: out.rotated ? 'QIMEN_SECRET_ROTATE' : 'QIMEN_SECRET_ISSUE',
        module: 'oms', entity: 'platforms', entityId: row.id, detail: out.app_key
      })
      return out
    })()
    console.log(JSON.stringify({ success: true, platform_id: issued.id, app_key: issued.app_key, rotated: issued.rotated, secret: issued.secret }))
  }
} catch (error) {
  const known = typeof error.code === 'string' && /^(QIMEN_|PLATFORM_|DATA_DIRECTORY_|RUNTIME_MODE_|INDUSTRY_)/.test(error.code)
  console.error(JSON.stringify({ success: false, code: known ? error.code : 'QIMEN_CLI_FAILED', message: known ? error.message : 'Issuance failed. Check arguments, runtime/data-directory configuration and schema.' }))
  process.exitCode = 1
} finally {
  db?.close()
}
