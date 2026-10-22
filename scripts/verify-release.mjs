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
for (const [file, expected] of Object.entries(manifest.files)) {
  const target = path.resolve(root, file)
  if (!target.startsWith(root + path.sep)) throw new Error(`Invalid manifest path: ${file}`)
  try {
    if (createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== expected) throw new Error('hash mismatch')
  } catch (error) { console.error(`${file}: ${error.message}`); failed++ }
}
console.log(`[verify] ${Object.keys(manifest.files).length} files; ${failed} errors`)
process.exitCode = failed ? 1 : 0
