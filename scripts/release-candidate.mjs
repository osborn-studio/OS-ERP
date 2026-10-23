/**
 * ============================================================================
 * 文件标识：scripts/release-candidate.mjs | 发行候选包（Z5）：干净检出 → npm run release → RC 命名 → 证据包
 * ============================================================================
 * 【这是什么】把"可审阅的候选包"固定下来：RC-<version>-<shortsha>.zip + .sha256 + <name>.evidence/{EVIDENCE.json,
 *   RELEASE-NOTES.md}。**候选包不是已发布版本**：不创建 tag/GitHub release，不部署；人工步骤见 docs/release/README.md。
 * 【流程】拒绝脏工作树（含已暂存与未跟踪文件）→ `npm run release`（输出到临时目录）→ 构建后再次确认树仍干净、
 *   MANIFEST.baseCommit 等于 HEAD 且未含"未提交修复" → 以 RC 名落盘 → 对**这个 zip 的全新解压**依次执行
 *   verify-release、密钥扫描、生产验收（test-local-delivery）→ 全部通过才写 EVIDENCE.json 与 RELEASE-NOTES.md →
 *   用 `verify-release --evidence` 校验证据本身。任何一步失败：删除本次产物并以非零退出。
 * 【证据诚实性】EVIDENCE 里的结果只有两种来路：本脚本亲自执行并记录（origin=produced：verify_release、acceptance、
 *   secret_scan、--run-guards 的守卫、synthetic_drill 文件哈希），或操作者经 --focused-result/--regression-result
 *   声明且必须附 --*-source（origin=operator-attested，仅是声明，脚本不替他验证）。未提供即为 "not run"。
 *   ci_run_id 只是操作者提供的引用，脚本不联网核实。
 * 【选项】--output=<dir>（默认 release/）  --skip-build --skip-docs（透传给 package-release，仅最小包测试使用）
 *   --reuse-node-modules（验收复用仓库依赖而不联网安装；会如实写入证据）  --run-guards  --ci-run=<数字>
 *   --focused-result=passed|failed --focused-source=<说明>  --regression-result=… --regression-source=<说明>
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { unzipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = new Set(['passed', 'failed'])
const KNOWN = new Set(['output', 'skip-build', 'skip-docs', 'reuse-node-modules', 'run-guards', 'ci-run',
  'focused-result', 'focused-source', 'regression-result', 'regression-source'])
const GUARDS = [
  ['tsc', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['check-file-header', ['scripts/check-file-header.mjs']],
  ['check-bizcode-shape', ['scripts/check-bizcode-shape.mjs']],
  ['check-data-paths', ['scripts/check-data-paths.mjs']],
  ['check-api-contract', ['scripts/check-api-contract.mjs']]
]

/** 从 CHANGELOG 取"本版本"的说明：标题含该版本号的节；没有就取标记行之后最新的一节并明说。 */
export function extractNotes(changelog, version, { commit, builtAt }) {
  const marker = changelog.indexOf('<!-- generated -->')
  const body = marker >= 0 ? changelog.slice(marker + '<!-- generated -->'.length) : changelog
  const sections = body.split(/^(?=## )/m).filter(s => s.startsWith('## '))
  if (!sections.length) throw new Error('No changelog section found in CHANGELOG.md')
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const exact = sections.find(s => new RegExp(`(^|[^0-9A-Za-z.])v?${escaped}($|[^0-9A-Za-z.])`).test(s.split('\n', 1)[0]))
  const chosen = (exact ?? sections[0]).trim()
  const head = [
    `# Release notes: OS-ERP ${version} (release candidate)`,
    '',
    `Commit ${commit.slice(0, 7)} (${commit}), built ${builtAt}.`,
    '',
    '**This is a release candidate, not a published release.** No tag, GitHub release or deployment exists for it; acceptance status is in docs/implementation/backlog.md and EVIDENCE.json. Manual steps that remain: docs/release/README.md.',
    ''
  ]
  if (!exact) head.push(`CHANGELOG.md has no section for version ${version}; the newest batch section is shown instead.`, '')
  return { matched: exact ? 'version' : 'latest-batch', text: `${head.join('\n')}\n${chosen}\n` }
}

function parseArgs(argv) {
  const opts = {}
  for (const a of argv) {
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m || !KNOWN.has(m[1])) throw new Error(`Unknown or malformed argument: ${a}`)
    opts[m[1]] = m[2] ?? true
  }
  const flagOnly = ['skip-build', 'skip-docs', 'reuse-node-modules', 'run-guards']
  for (const k of Object.keys(opts)) if (flagOnly.includes(k) === (typeof opts[k] !== 'boolean')) throw new Error(`--${k} ${flagOnly.includes(k) ? 'takes no value' : 'needs a value'}`)
  if (opts['ci-run'] !== undefined && !/^\d{1,20}$/.test(opts['ci-run'])) throw new Error('--ci-run must be a numeric GitHub Actions run id')
  for (const k of ['focused', 'regression']) {
    const r = opts[`${k}-result`]
    if (r !== undefined && !RESULTS.has(r)) throw new Error(`--${k}-result must be passed or failed (omit it for "not run")`)
    if (r !== undefined && !String(opts[`${k}-source`] ?? '').trim()) throw new Error(`--${k}-result requires --${k}-source describing where it was run`)
    if (r === undefined && opts[`${k}-source`] !== undefined) throw new Error(`--${k}-source without --${k}-result`)
    if (r === 'failed') throw new Error(`--${k}-result=failed: refusing to build a candidate from a failing ${k} run`)
  }
  return opts
}

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
function sh(cmd, argv, options = {}) {
  return spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', ...options })
}
function git(...argv) {
  const r = sh('git', argv)
  if (r.status !== 0) throw new Error(`git ${argv.join(' ')} failed: ${r.stderr.trim()}`)
  return r.stdout.trim()
}
function assertClean(when) {
  const status = git('status', '--porcelain', '--untracked-files=all')
  if (status) throw new Error(`Working tree is dirty ${when}; commit or stash first (a candidate must be built from a clean, committed tree):\n${status.split('\n').slice(0, 10).join('\n')}`)
}

function extractZip(zipFile, dest) {
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(fs.readFileSync(zipFile))))) {
    if (name.endsWith('/')) continue
    const rel = name.split('/').slice(1).join('/')
    const target = path.resolve(dest, rel)
    if (!rel || !target.startsWith(dest + path.sep)) throw new Error(`Unsafe archive entry: ${name}`)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(target, bytes)
  }
}

// 模式写成片段拼接，避免本文件自身被扫描命中。
const SECRET_PATTERNS = [
  ['private key block', new RegExp('-----BEGIN [A-Z ]*PRIVATE ' + 'KEY-----')],
  ['AWS access key id', new RegExp('\\bAK' + 'IA[0-9A-Z]{16}\\b')],
  ['GitHub token', new RegExp('\\bgh[pousr]_' + '[A-Za-z0-9]{30,}')],
  ['API secret key', new RegExp('\\bsk-' + '[A-Za-z0-9_-]{32,}')]
]
const SECRET_NAMES = /(^|\/)\.env(\.|$)|\.(?:pem|p12|pfx|key)$|(^|\/)id_(?:rsa|ed25519)$|\.(?:db|db3|sqlite3?)(?:-|\.|$)/i
function scanSecrets(dir) {
  const findings = []
  let scanned = 0
  const walk = (d, prefix = '') => {
    for (const item of fs.readdirSync(d, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${item.name}` : item.name
      if (!prefix && item.name === 'node_modules') continue
      const full = path.join(d, item.name)
      if (item.isDirectory()) { walk(full, rel); continue }
      if (!item.isFile()) continue
      scanned++
      if (SECRET_NAMES.test(rel)) findings.push(`${rel}: forbidden file name`)
      const bytes = fs.readFileSync(full)
      if (bytes.length > 8 * 1024 * 1024 || bytes.includes(0)) continue
      const text = bytes.toString('utf8')
      for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) findings.push(`${rel}: ${label}`)
    }
  }
  walk(dir)
  return { result: findings.length ? 'failed' : 'passed', origin: 'produced', files_scanned: scanned, findings }
}

function drillReference() {
  const dir = 'docs/implementation/capacity-evidence'
  const rels = [...fs.readdirSync(path.join(ROOT, dir)).filter(f => f.endsWith('.json')).sort().map(f => `${dir}/${f}`), 'docs/implementation/capacity-baseline.md']
  const files = rels.filter(r => fs.existsSync(path.join(ROOT, r))).map(r => ({ path: r, sha256: sha256(fs.readFileSync(path.join(ROOT, r))) }))
  return { note: 'Synthetic large-database rehearsal on a development host; not target-host (dmserver) acceptance. Hashes pin the committed files shipped inside the package.', files }
}

function main() {
  const opts = parseArgs(process.argv.slice(2))
  assertClean('before building')
  const commit = git('rev-parse', 'HEAD')
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const name = `RC-${version}-${commit.slice(0, 7)}`
  const output = path.resolve(opts.output || path.join(ROOT, 'release'))
  const zipFile = path.join(output, `${name}.zip`)
  const evidenceDir = path.join(output, `${name}.evidence`)
  for (const f of [zipFile, evidenceDir]) if (fs.existsSync(f)) throw new Error(`${f} already exists; remove it first`) // 在可清理区之前判断，绝不删除已有候选
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-rc-'))
  const cleanupOutputs = () => { for (const f of [zipFile, `${zipFile}.sha256`]) fs.rmSync(f, { force: true }); fs.rmSync(evidenceDir, { recursive: true, force: true }) }
  try {
    // 1. 构建（输出到临时目录，不污染 release/）
    const built = sh('npm', ['run', 'release', '--', `--output=${path.join(work, 'build')}`, ...(opts['skip-build'] ? ['--skip-build'] : []), ...(opts['skip-docs'] ? ['--skip-docs'] : [])], { stdio: 'inherit' })
    if (built.status !== 0) throw new Error('npm run release failed')
    assertClean('after building (the build modified tracked files or left untracked ones)')
    if (git('rev-parse', 'HEAD') !== commit) throw new Error('HEAD moved during the build')
    const zips = fs.readdirSync(path.join(work, 'build')).filter(f => f.endsWith('.zip'))
    if (zips.length !== 1) throw new Error(`Expected exactly one archive from npm run release, found ${zips.length}`)
    // 2. 以 RC 名落盘
    fs.mkdirSync(output, { recursive: true })
    fs.copyFileSync(path.join(work, 'build', zips[0]), zipFile)
    const zipBytes = fs.readFileSync(zipFile)
    const zipHash = sha256(zipBytes)
    fs.writeFileSync(`${zipFile}.sha256`, `${zipHash}  ${name}.zip\n`)
    // 3. 全新解压并校验清单
    const pkg = path.join(work, 'pkg')
    fs.mkdirSync(pkg)
    extractZip(zipFile, pkg)
    const manifest = JSON.parse(fs.readFileSync(path.join(pkg, 'MANIFEST.json'), 'utf8'))
    if (manifest.baseCommit !== commit) throw new Error(`MANIFEST.baseCommit ${manifest.baseCommit} != HEAD ${commit}`)
    if (manifest.includesUncommittedFixes !== false) throw new Error('MANIFEST says the package includes uncommitted changes')
    if (manifest.version !== version) throw new Error(`MANIFEST.version ${manifest.version} != package.json ${version}`)
    const runNode = (cwd, argv, label) => {
      const r = spawnSync(process.execPath, argv, { cwd, encoding: 'utf8', stdio: ['ignore', 'inherit', 'inherit'] })
      if (r.status !== 0) throw new Error(`${label} failed (exit ${r.status})`)
    }
    runNode(pkg, ['scripts/verify-release.mjs'], 'verify-release on the fresh extraction')
    const secretScan = scanSecrets(pkg)
    if (secretScan.result !== 'passed') throw new Error(`Secret scan failed:\n${secretScan.findings.join('\n')}`)
    // 4. 守卫（可选，亲自运行才记录）
    const guards = {}
    for (const [label, argv] of GUARDS) {
      if (!opts['run-guards']) { guards[label] = { result: 'not run' }; continue }
      const r = sh(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] })
      guards[label] = { result: r.status === 0 ? 'passed' : 'failed', origin: 'produced' }
      if (r.status !== 0) throw new Error(`Guard ${label} failed`)
    }
    // 5. 生产验收（在解压目录上）
    if (opts['reuse-node-modules']) fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(pkg, 'node_modules'), 'dir')
    const accDir = path.join(work, 'acceptance')
    runNode(ROOT, ['scripts/test-local-delivery.mjs', `--package=${pkg}`, `--evidence=${accDir}`, ...(opts['reuse-node-modules'] ? ['--reuse-node-modules'] : [])], 'production acceptance (test-local-delivery)')
    const smoke = JSON.parse(fs.readFileSync(path.join(accDir, 'install-smoke.json'), 'utf8'))
    if (smoke.result !== 'passed' || smoke.mode !== 'production') throw new Error('Acceptance report is not a passing production run')
    runNode(pkg, ['scripts/verify-release.mjs'], 'verify-release after acceptance')
    // 6. 证据与说明
    const builtAt = new Date().toISOString()
    const attested = k => opts[`${k}-result`] === undefined ? { source: 'not run', result: 'not run' } : { source: opts[`${k}-source`], result: opts[`${k}-result`], origin: 'operator-attested' }
    const evidence = {
      schema: 1, version, commit, built_at: builtAt, node: process.version,
      artifact: { name: `${name}.zip`, sha256: zipHash, bytes: zipBytes.length, files: Object.keys(manifest.files).length },
      focused_tests: attested('focused'), guards, regression: attested('regression'),
      ci_run_id: opts['ci-run'] ?? null,
      synthetic_drill: drillReference(),
      verify_release: { result: 'passed', origin: 'produced' },
      acceptance: { result: smoke.result, origin: 'produced', mode: smoke.mode, checks: smoke.checks.length, reuse_node_modules: Boolean(opts['reuse-node-modules']) },
      secret_scan: secretScan,
      not_a_release: true
    }
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'EVIDENCE.json'), JSON.stringify(evidence, null, 2) + '\n')
    fs.writeFileSync(path.join(evidenceDir, 'RELEASE-NOTES.md'), extractNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version, { commit, builtAt }).text)
    runNode(pkg, ['scripts/verify-release.mjs', `--evidence=${path.join(evidenceDir, 'EVIDENCE.json')}`], 'verify-release --evidence')
    console.log(JSON.stringify({ candidate: zipFile, sha256: zipHash, evidence: path.join(evidenceDir, 'EVIDENCE.json'), notes: path.join(evidenceDir, 'RELEASE-NOTES.md'), not_a_release: true }, null, 2))
  } catch (error) {
    cleanupOutputs()
    console.error(`[release-candidate] ${error.message}`)
    process.exitCode = 1
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// 先判定再运行：被测试 import 时只导出 extractNotes。
try { if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main() } catch (error) { console.error(`[release-candidate] ${error.message}`); process.exitCode = 1 }
