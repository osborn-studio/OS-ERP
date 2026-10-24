/**
 * ============================================================================
 * 文件标识：scripts/verify-release.mjs | 验证交付源码与前端的 SHA256 清单，不读取用户数据。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { loadPublicKey, verifyEvidenceSignature, SIG_FILE } from './lib/evidence-sign.mjs'
import { LOG_FILE, evidenceDigest, readLog, signatureDigest } from './lib/evidence-log.mjs'
import { loadAnchor, checkLogDescent } from './lib/offbox-anchor.mjs'
import { diffSboms, loadSbomFile, renderTable } from './lib/sbom-diff.mjs'
import { hashEntries, listTestsTree, TESTS_TREE_FILE } from './lib/tests-tree.mjs'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
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
// AB4（ADR-0047）：--pubkey <pem> | --pubkey=<pem>（只验签用的公钥，须带外获得）。没有 --evidence 就没有可验的东西：用法错误。
if (process.argv.filter(a => a === '--pubkey' || a.startsWith('--pubkey=')).length > 1) fail('--pubkey given more than once; refusing to guess which key to trust')
const pubkeyIdx = process.argv.findIndex(a => a === '--pubkey' || a.startsWith('--pubkey='))
const pubkeyArg = pubkeyIdx < 0 ? undefined : (process.argv[pubkeyIdx].startsWith('--pubkey=') ? process.argv[pubkeyIdx].slice(9) : process.argv[pubkeyIdx + 1])
if (pubkeyIdx >= 0 && (!pubkeyArg || pubkeyArg.startsWith('--'))) fail('--pubkey needs a public key PEM path')
else if (pubkeyIdx >= 0 && !evidenceArg && !process.argv.some(a => a === '--offbox' || a.startsWith('--offbox='))) fail('--pubkey is only meaningful together with --evidence=<EVIDENCE.json> or --offbox <anchor.json>')
// AC6（ADR-0052）：--log[=<file>] 校验透明日志链并要求本候选在其中；--require-signature 把"未签名"从警告升级为失败。两者都要求 --evidence。
const logIdx = process.argv.findIndex(a => a === '--log' || a.startsWith('--log='))
if (process.argv.filter(a => a === '--log' || a.startsWith('--log=')).length > 1) fail('--log given more than once')
const logArg = logIdx < 0 ? undefined : (process.argv[logIdx] === '--log' ? path.join(root, LOG_FILE) : path.resolve(process.argv[logIdx].slice(6)))
if (logIdx >= 0 && process.argv[logIdx] === '--log=') fail('--log= needs a file path')
const requireSignature = process.argv.includes('--require-signature')
// AD5（ADR-0055）：--offbox <anchor.json> | --offbox=<anchor.json>：验离机锚点签名（须 --pubkey）并要求 --log 的日志是锚定日志的后代。
if (process.argv.filter(a => a === '--offbox' || a.startsWith('--offbox=')).length > 1) fail('--offbox given more than once')
const offIdx = process.argv.findIndex(a => a === '--offbox' || a.startsWith('--offbox='))
const offboxArg = offIdx < 0 ? undefined : (process.argv[offIdx].startsWith('--offbox=') ? process.argv[offIdx].slice(9) : process.argv[offIdx + 1])
if (offIdx >= 0 && (!offboxArg || offboxArg.startsWith('--'))) fail('--offbox needs an anchor file path')
else if (offIdx >= 0 && !pubkeyArg) fail('--offbox needs --pubkey <pem>: an unverified anchor proves nothing')
else if (offIdx >= 0 && logArg === undefined) fail('--offbox needs --log: the anchored log tail can only be checked against a log')
if ((logArg !== undefined && !offboxArg || requireSignature) && !evidenceArg) fail('--log and --require-signature are only meaningful together with --evidence=<EVIDENCE.json> (--log may instead accompany --offbox)')
if (requireSignature && !pubkeyArg) fail('--require-signature needs --pubkey <pem>: an unverified signature is not a signature')
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
    // AA7：自动查到的 CI run 必须能追溯到 gh 查询（来源、结论 success）；查不到时必须写明原因。
    const cl = ev.ci_lookup
    if (cl !== undefined) {
      if (!cl || typeof cl !== 'object' || !['auto', 'operator-supplied', 'none'].includes(cl.mode)) bad('ci_lookup', 'mode must be auto, operator-supplied or none')
      else if (cl.mode === 'auto') {
        if (ev.ci_run_id === null && !String(cl.reason ?? '').trim()) bad('ci_lookup', 'an auto lookup that found no run must state the reason')
        if (ev.ci_run_id !== null && cl.ci_run_origin === 'hosted-ci-self') { // AE10：自指引用，不得声称 success
          if (cl.source !== 'GITHUB_RUN_ID' || cl.head_sha !== ev.commit || cl.conclusion !== undefined || ev.built_by !== 'hosted-ci' || !/SELF-REFERENTIAL/.test(String(cl.note ?? ''))) bad('ci_lookup', 'a hosted-ci-self run id must come from GITHUB_RUN_ID for exactly this commit, built_by hosted-ci, carry the self-referential note and no conclusion')
          console.warn('[verify] WARNING: ci_run_id is the building run itself (hosted-ci-self); it is not evidence of a passing ci.yml run')
        } else if (ev.ci_run_id !== null && (cl.conclusion !== 'success' || cl.source !== 'gh run list' || cl.head_sha !== ev.commit)) bad('ci_lookup', 'an auto-resolved run id must come from gh run list with conclusion success for exactly this commit (head_sha)')
        if (cl.gh_override) console.warn('[verify] WARNING: ci_lookup used the OS_ERP_GH override binary; this is not a genuine GitHub lookup')
      } else if (cl.mode === 'none' && ev.ci_run_id !== null) bad('ci_lookup', 'mode none cannot carry a run id')
    }
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
    result('focused_tests', ev.focused_tests, { needSource: ev.focused_tests?.origin !== 'produced' })
    // AA7：produced 的焦点测试必须带计数、耗时与测试树哈希，且哈希必须等于本包清单（release/tests-tree.json）重算的值。
    const ft = ev.focused_tests
    if (ft?.result === 'passed' && ft.origin === 'produced') {
      const c = ft.summary_counts
      const int = v => Number.isInteger(v) && v >= 0
      if (!c || typeof c !== 'object' || !['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo'].every(k => int(c[k]))) bad('focused_tests', 'a produced result needs integer summary_counts (tests, pass, fail, cancelled, skipped, todo)')
      else {
        if (c.tests < 1 || c.pass < 1) bad('focused_tests', 'a produced passed result must have run at least one passing test')
        if (c.fail !== 0 || c.cancelled !== 0) bad('focused_tests', 'a passed result cannot have failed or cancelled tests')
        if (c.tests !== c.pass + c.fail + c.cancelled + c.skipped + c.todo) bad('focused_tests', 'summary_counts are inconsistent: tests must equal pass + fail + cancelled + skipped + todo')
      }
      if (typeof ft.duration_ms !== 'number' || !(ft.duration_ms >= 0)) bad('focused_tests', 'a produced result needs duration_ms')
      if (!/^[0-9a-f]{64}$/.test(String(ft.tests_tree_sha256 ?? ''))) bad('focused_tests', 'a produced result needs tests_tree_sha256')
      else {
        try {
          const listing = JSON.parse(fs.readFileSync(path.join(root, TESTS_TREE_FILE), 'utf8'))
          if (!manifest.files?.[TESTS_TREE_FILE]) throw new Error(`${TESTS_TREE_FILE} is not listed in MANIFEST.json`)
          if (!Array.isArray(listing.files) || !listing.files.length) throw new Error('tests listing is empty')
          const recomputed = hashEntries(listing.files)
          if (listing.tree_sha256 !== recomputed) throw new Error('listing tree_sha256 does not match its own entries')
          if (recomputed !== ft.tests_tree_sha256) throw new Error(`tests tree ${recomputed} != EVIDENCE ${ft.tests_tree_sha256}`)
          // 若包根恰好带着 tests/，它也必须与清单一致（不一致说明事后改过）。
          const present = listTestsTree(root)
          if (present.length && hashEntries(present) !== recomputed) throw new Error('tests/ in the package differs from the listing')
        } catch (error) { bad('focused_tests', `tests tree binding failed: ${error.message}`) }
      }
    }
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
    // AG1：演练（--skip-focused）不是候选。dry_run 与 focused_tests.origin=skipped-dry-run 必须同时出现且互相印证；
    // 演练必须是托管 CI 未签名构建；它永远不具备进日志的资格，--log / --require-signature 对它一律失败。
    const skipped = ev.focused_tests?.origin === 'skipped-dry-run'
    if ('dry_run' in ev && ev.dry_run !== true) bad('dry_run', 'must be true when present (omit the field for a normal candidate)')
    if (ev.dry_run === true) {
      if (!skipped || ev.focused_tests?.result !== 'not run') bad('dry_run', 'a dry run must carry focused_tests {result: not run, origin: skipped-dry-run}')
      if (ev.built_by !== 'hosted-ci' || ev.signature !== null) bad('dry_run', 'a dry run is a hosted-ci build and is never signed')
      const banner = '#'.repeat(78)
      console.error(`${banner}\n[verify] DRY RUN, NOT A CANDIDATE: this evidence was produced with --skip-focused, so the focused test suite did NOT run.\n[verify] It rehearses the hosted runner only; it is never log-eligible (--log and --require-signature fail) and must not be\n[verify] ingested, signed or released.\n${banner}`)
      if (logArg !== undefined) bad('log', 'a dry run is never log-eligible: it must not appear in, or be verified against, the evidence log')
      if (requireSignature) bad('signature', '--require-signature: a dry run is never a candidate and cannot be signed')
    } else if (skipped) bad('focused_tests', 'origin skipped-dry-run requires dry_run: true')
    // 签名（AB4）：signature 是 null（未签名）或元数据对象；给了 --pubkey 就必须验过。降级（null/缺失/删 sig 文件）在给了公钥时一律失败。
    if (!('signature' in ev)) bad('signature', 'missing (null for an unsigned candidate)')
    else if (ev.signature !== null && (typeof ev.signature !== 'object' || Array.isArray(ev.signature))) bad('signature', 'must be null or an object')
    if (pubkeyArg && !pubkeyArg.startsWith('--')) {
      try {
        const pub = loadPublicKey(path.resolve(pubkeyArg))
        if (ev.signature === null || ev.signature === undefined) bad('signature', 'evidence is unsigned but a public key was supplied; refusing (a signed candidate cannot be downgraded)')
        else {
          let sigText = null
          try { sigText = fs.readFileSync(path.join(path.dirname(path.resolve(evidenceArg)), SIG_FILE), 'utf8') } catch { bad('signature', `${SIG_FILE} not found next to the evidence file`) }
          if (sigText !== null) {
            const v = verifyEvidenceSignature(ev, sigText, pub)
            if (v.ok) console.log(`[verify] signature verified (ed25519, key_id ${ev.signature.key_id.slice(0, 16)}…)`)
            else bad('signature', v.reason)
          }
        }
      } catch (error) { bad('signature', error.message) }
    }
    if (ev.signature === null) {
      const banner = '!'.repeat(78)
      console.error(`${banner}\n[verify] WARNING: UNSIGNED CANDIDATE (built_by: ${ev.built_by ?? 'unrecorded'}). EVIDENCE.json carries no signature, so nothing\n[verify] proves who approved this evidence. It is a development candidate only: a formal release must be re-signed by the\n[verify] key holder on a controlled machine (docs/release/README.md). Use --pubkey with --require-signature to enforce.\n${banner}`)
      if (requireSignature) bad('signature', '--require-signature: the candidate is unsigned')
    }
    if (ev.built_by !== undefined && !['hosted-ci', 'key-holder', 'local'].includes(ev.built_by)) bad('built_by', 'must be hosted-ci, key-holder or local')
    if (ev.built_by === 'hosted-ci' && ev.signature !== null) bad('built_by', 'a hosted-ci candidate cannot be signed (hosted CI holds no key)')
    if (logArg !== undefined && ev.dry_run !== true) {
      const lg = readLog(logArg)
      const name = String(ev.artifact?.name ?? '').replace(/\.zip$/, '')
      if (!lg.ok) bad('log', lg.reason)
      else {
        const entry = lg.entries.find(e => e.name === name)
        if (!entry) bad('log', `candidate ${name} is not present in the evidence log ${logArg}`)
        else {
          let sigDigest = null
          try { sigDigest = signatureDigest(fs.readFileSync(path.join(path.dirname(path.resolve(evidenceArg)), SIG_FILE), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') bad('log', `${SIG_FILE}: ${error.message}`) }
          let ed = null
          try { ed = evidenceDigest(ev) } catch (error) { bad('log', error.message) }
          if (ed !== null && entry.evidence_sha256 !== ed) bad('log', 'entry evidence_sha256 does not match the canonicalized evidence (evidence changed after it was logged)')
          if (entry.signature !== sigDigest) bad('log', `entry signature digest ${entry.signature ?? 'null'} does not match ${SIG_FILE} (${sigDigest ?? 'absent'})`)
          if ((entry.signature === null) !== (ev.signature === null)) bad('log', 'entry and evidence disagree on whether the candidate is signed')
          if (ev.built_by !== undefined && entry.built_by !== ev.built_by) bad('log', `entry built_by ${entry.built_by} != evidence built_by ${ev.built_by}`)
          if (failed === 0) console.log(`[verify] evidence log verified (${lg.entries.length} entries, chain intact, ${name} present, built_by ${entry.built_by}, ${entry.signature ? 'signed' : 'UNSIGNED'})`)
        }
      }
    }
    if (ev.signature && !(pubkeyArg && !pubkeyArg.startsWith('--'))) console.warn(`[verify] NOTE: evidence is signed (key_id ${String(ev.signature.key_id).slice(0, 16)}…) but signature not verified: no --pubkey given`)
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
if (offboxArg && !offboxArg.startsWith('--') && pubkeyArg && logArg !== undefined) {
  const bad = why => fail(`OFFBOX: ${why}`)
  try {
    const loaded = loadAnchor(path.resolve(offboxArg), loadPublicKey(path.resolve(pubkeyArg)))
    if (!loaded.ok) bad(loaded.reason)
    else {
      let text = null
      try { text = fs.readFileSync(logArg, 'utf8') } catch (error) { if (error.code !== 'ENOENT') bad(`evidence log cannot be read (${error.code || error.message})`) }
      const d = checkLogDescent(loaded.anchor, text)
      if (!d.ok) bad(d.reason)
      else console.log(`[verify] offbox anchor verified (key_id ${loaded.key_id.slice(0, 16)}…, made ${loaded.anchor.created_at}); ${d.note ?? `evidence log descends from the anchored tail (${loaded.anchor.log.lines} line(s) anchored, ${d.advanced} added since)`}`)
    }
  } catch (error) { bad(error.message) }
}
// AF7：--sbom-diff <prev.cdx.json> | --sbom-diff=<prev.cdx.json>：把本包的 SBOM 与上一份比较，打印组件增 / 删 / 变表格与一行 JSON。
// 只是信息：有差异不失败；只有 prev 缺失 / 畸形（或参数用法错误）才记为错误。prev 按不可信数据处理（见 scripts/lib/sbom-diff.mjs）。
if (process.argv.filter(a => a === '--sbom-diff' || a.startsWith('--sbom-diff=')).length > 1) fail('--sbom-diff given more than once')
const sdIdx = process.argv.findIndex(a => a === '--sbom-diff' || a.startsWith('--sbom-diff='))
if (sdIdx >= 0) {
  const prevArg = process.argv[sdIdx].startsWith('--sbom-diff=') ? process.argv[sdIdx].slice(12) : process.argv[sdIdx + 1]
  if (!prevArg || prevArg.startsWith('--')) fail('--sbom-diff needs the previous SBOM path (<prev.cdx.json>)')
  else {
    try {
      const diff = diffSboms(loadSbomFile(path.resolve(prevArg)), loadSbomFile(path.join(root, 'release/sbom.cdx.json')))
      process.stdout.write(renderTable(diff))
      console.log(`[verify] sbom-diff-json ${JSON.stringify(diff)}`)
    } catch (error) { fail(`SBOM-DIFF: ${error.message}`) }
  }
}
console.log(`[verify] ${Object.keys(manifest.files).length} files; ${failed} errors`)
process.exitCode = failed ? 1 : 0
