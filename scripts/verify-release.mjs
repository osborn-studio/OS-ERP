/**
 * ============================================================================
 * 文件标识：scripts/verify-release.mjs | 验证交付源码与前端的 SHA256 清单，不读取用户数据。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'))
let failed = 0
const fail = message => { console.error(message); failed++ }
// 来源与第三方声明：baseCommit 必须是提交 SHA，通知文件必须在清单里（且下面逐文件校验哈希）。
if (!/^[0-9a-f]{7,64}$/.test(String(manifest.baseCommit ?? ''))) fail('MANIFEST.baseCommit missing or not a git sha')
if (!manifest.files?.['THIRD_PARTY_NOTICES.md']) fail('THIRD_PARTY_NOTICES.md is not listed in MANIFEST.json')
for (const file of Object.keys(manifest.files)) {
  if (/(^|\/)(\.local|backups|data)(\/|$)|\.(?:db|db3|sqlite3?)(?:-|\.|$)|(^|\/)\.env(\.|$)/i.test(file)) fail(`${file}: databases, instance state and secrets must not be part of a release`)
}
// 包根下清单之外的文件（例如事后放进去的 .env / 演示库）同样不允许；运行态目录（实例默认在包根）除外。
const RUNTIME_DIRS = new Set(['node_modules', 'data', '.local', 'backups'])
const listed = new Set(Object.keys(manifest.files))
function walk(dir, prefix = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (!prefix && RUNTIME_DIRS.has(item.name)) continue
    if (item.isDirectory()) walk(path.join(dir, item.name), rel)
    else if (rel !== 'MANIFEST.json' && !listed.has(rel)) fail(`${rel}: file is not listed in MANIFEST.json`)
  }
}
walk(root)
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.resolve(root, file)
  if (!target.startsWith(root + path.sep)) throw new Error(`Invalid manifest path: ${file}`)
  try {
    if (createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== expected) throw new Error('hash mismatch')
  } catch (error) { fail(`${file}: ${error.message}`) }
}
console.log(`[verify] ${Object.keys(manifest.files).length} files; ${failed} errors`)
process.exitCode = failed ? 1 : 0
