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
// Evidence/archive options must never silently turn into a manifest-only check.
// Normalize the space form before the existing consumers read the equals form.
for (const flag of ['--evidence', '--artifact']) {
  const hits = process.argv.map((value, index) => value === flag || value.startsWith(`${flag}=`) ? index : -1).filter(index => index >= 0)
  if (hits.length > 1) throw new Error(`${flag} given more than once`)
  if (!hits.length) continue
  const index = hits[0]
  const spaced = process.argv[index] === flag
  const value = spaced ? process.argv[index + 1] : process.argv[index].slice(flag.length + 1)
  if (!value || value.startsWith('--')) throw new Error(`${flag} needs a value`)
  if (spaced) process.argv.splice(index, 2, `${flag}=${value}`)
}
if (process.argv.some(a => a.startsWith('--artifact=')) && !process.argv.some(a => a.startsWith('--evidence='))) throw new Error('--artifact requires --evidence')
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'))
let failed = 0
const fail = message => { console.error(message); failed++ }
// 来源与第三方声明：baseCommit 必须是提交 SHA，通知文件必须在清单里（且下面逐文件校验哈希）。
if (!/^[0-9a-f]{7,64}$/.test(String(manifest.baseCommit ?? ''))) fail('MANIFEST.baseCommit missing or not a git sha')
if (!manifest.files?.['THIRD_PARTY_NOTICES.md']) fail('THIRD_PARTY_NOTICES.md is not listed in MANIFEST.json')
for (const required of ['CHANGELOG.md', 'release/sbom.cdx.json']) {
  if (!manifest.files?.[required]) fail(`${required} is not listed in MANIFEST.json`)
}
// SBOM 不只是“在清单里”：内容必须是结构合理的 CycloneDX（格式标记、1.x 版本号、非空组件且各有 name/version/唯一 bom-ref）。
// 这是结构检查，不是完整 JSON Schema 校验；哈希另在下面逐文件校验。
try {
  const sbom = JSON.parse(fs.readFileSync(path.join(root, 'release/sbom.cdx.json'), 'utf8'))
  if (sbom.bomFormat !== 'CycloneDX') fail('release/sbom.cdx.json: bomFormat is not CycloneDX')
  else if (!/^1\.\d+$/.test(String(sbom.specVersion))) fail('release/sbom.cdx.json: CycloneDX specVersion missing or not 1.x')
  else if (!Array.isArray(sbom.components) || !sbom.components.length) fail('release/sbom.cdx.json: no components')
  else {
    const refs = new Set()
    for (const c of sbom.components) {
      const ok = c && typeof c === 'object' && typeof c.name === 'string' && c.name && typeof c.version === 'string' && c.version
      if (!ok) { fail('release/sbom.cdx.json: component without name/version'); break }
      const ref = c['bom-ref']
      if (ref !== undefined && (typeof ref !== 'string' || refs.has(ref))) { fail(`release/sbom.cdx.json: invalid or duplicate bom-ref ${String(ref)}`); break }
      refs.add(ref)
    }
  }
} catch (error) { fail(`release/sbom.cdx.json: cannot read SBOM (${error.message})`) }
try {
  if (!fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8').includes('<!-- generated -->')) fail('CHANGELOG.md: generated marker missing')
} catch (error) { fail(`CHANGELOG.md: ${error.message}`) }
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
// 证据包（Z5）：仅在给出 --evidence=<EVIDENCE.json> 时校验。证据必须与本包的 MANIFEST 一致，且不得自称未产生的结果。
const evidenceArg = process.argv.find(a => a.startsWith('--evidence='))?.slice(11)
if (evidenceArg) {
  const bad = (field, why) => fail(`EVIDENCE.${field}: ${why}`)
  try {
    const ev = JSON.parse(fs.readFileSync(path.resolve(evidenceArg), 'utf8'))
    const RESULT = new Set(['passed', 'failed', 'not run'])
    const ORIGIN = new Set(['produced', 'operator-attested'])
    for (const k of ['version', 'commit', 'built_at', 'node', 'artifact', 'focused_tests', 'guards', 'regression', 'ci_run_id', 'synthetic_drill', 'verify_release', 'acceptance', 'secret_scan']) {
      if (!(k in ev)) bad(k, 'missing')
    }
    if (ev.not_a_release !== true) bad('not_a_release', 'must be true; a candidate is not a published release')
    if (ev.version !== manifest.version) bad('version', `${ev.version} != MANIFEST.version ${manifest.version}`)
    if (ev.commit !== manifest.baseCommit) bad('commit', `${ev.commit} != MANIFEST.baseCommit ${manifest.baseCommit}`)
    if (typeof ev.built_at !== 'string' || Number.isNaN(Date.parse(ev.built_at))) bad('built_at', 'not an ISO timestamp')
    if (typeof ev.node !== 'string' || !/^v\d+\./.test(ev.node)) bad('node', 'not a node version')
    if (ev.ci_run_id !== null && !/^\d{1,20}$/.test(String(ev.ci_run_id))) bad('ci_run_id', 'must be null or a numeric run id')
    const result = (field, v, { needSource }) => {
      if (!v || typeof v !== 'object' || !RESULT.has(v.result)) return bad(field, 'result must be passed, failed or not run')
      if (v.result === 'failed') return bad(field, 'a candidate cannot carry a failed result')
      if (v.result === 'passed') {
        if (!ORIGIN.has(v.origin)) bad(field, 'a passed result must say origin: produced or operator-attested')
        if (needSource && !String(v.source ?? '').trim()) bad(field, 'a passed result must name its source')
      }
    }
    // 只有这两项可以是人工声明；其余必须由脚本亲自产生（origin=produced）。
    const produced = (field, v) => { if (v && v.result === 'passed' && v.origin !== 'produced') bad(field, 'must have origin: produced') }
    result('focused_tests', ev.focused_tests, { needSource: true })
    result('regression', ev.regression, { needSource: true })
    if (!ev.guards || typeof ev.guards !== 'object' || !Object.keys(ev.guards).length) bad('guards', 'missing guard entries')
    else {
      const expected = ['tsc', 'check-file-header', 'check-bizcode-shape', 'check-data-paths', 'check-api-contract']
      if (Object.keys(ev.guards).sort().join() !== [...expected].sort().join()) bad('guards', `must contain exactly: ${expected.join(', ')}`)
      for (const [name, g] of Object.entries(ev.guards)) { result(`guards.${name}`, g, { needSource: false }); produced(`guards.${name}`, g) }
    }
    for (const f of ['verify_release', 'secret_scan']) { result(f, ev[f], { needSource: false }); if (ev[f]?.result !== 'passed') bad(f, 'must be passed'); produced(f, ev[f]) }
    result('acceptance', ev.acceptance, { needSource: false })
    produced('acceptance', ev.acceptance)
    if (ev.acceptance?.result !== 'passed' || ev.acceptance?.mode !== 'production') bad('acceptance', 'must be a passed production-mode run')
    if (!ev.artifact || !/^[0-9a-f]{64}$/.test(String(ev.artifact.sha256 ?? '')) || !/^RC-.+\.zip$/.test(String(ev.artifact.name ?? ''))) bad('artifact', 'needs an RC-*.zip name and sha256')
    else {
      if (ev.artifact.files !== Object.keys(manifest.files).length) bad('artifact', `files ${ev.artifact.files} != MANIFEST file count ${Object.keys(manifest.files).length}`)
      const zipArg = process.argv.find(a => a.startsWith('--artifact='))?.slice(11)
      if (zipArg) { // 把证据绑定到真实的 zip：文件名、哈希、字节数都要一致
        try {
          const bytes = fs.readFileSync(path.resolve(zipArg))
          if (path.basename(zipArg) !== ev.artifact.name) bad('artifact', `name ${ev.artifact.name} != ${path.basename(zipArg)}`)
          if (createHash('sha256').update(bytes).digest('hex') !== ev.artifact.sha256) bad('artifact', 'sha256 does not match the archive')
          if (bytes.length !== ev.artifact.bytes) bad('artifact', 'bytes does not match the archive')
        } catch (error) { bad('artifact', `cannot read ${zipArg} (${error.message})`) }
      }
    }
    const files = ev.synthetic_drill?.files
    if (!Array.isArray(files) || !files.length) bad('synthetic_drill', 'must reference capacity evidence files')
    else for (const f of files) {
      const target = path.resolve(root, String(f?.path ?? ''))
      try {
        if (!target.startsWith(root + path.sep)) throw new Error('path escapes the package')
        if (createHash('sha256').update(fs.readFileSync(target)).digest('hex') !== f.sha256) throw new Error('hash mismatch')
      } catch (error) { bad('synthetic_drill', `${f?.path}: ${error.message}`) }
    }
  } catch (error) { fail(`EVIDENCE: cannot read ${evidenceArg} (${error.message})`) }
}
console.log(`[verify] ${Object.keys(manifest.files).length} files; ${failed} errors`)
process.exitCode = failed ? 1 : 0
