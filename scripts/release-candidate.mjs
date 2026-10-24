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
 *   --reuse-node-modules（验收复用仓库依赖而不联网安装；会如实写入证据）  --run-guards  --ci-run=<数字|auto>
 *   --run-tests（AA7：亲自运行焦点套件 `node --test --test-concurrency=1 tests/*.test.mjs` 与五个守卫，记录
 *     {result, origin:'produced', duration_ms, summary_counts, tests_tree_sha256}；计数解析不出来就失败，绝不凭空写 produced；
 *     不能与 --focused-result 同用）
 *   --ci-run=auto（AA7：`gh run list --commit <HEAD> --workflow ci.yml --json …` 取最新 conclusion=success 的 run id；
 *     无 gh/未登录/无记录则 ci_run_id=null 并在 ci_lookup.reason 写明，绝不编造；OS_ERP_GH 仅为测试替身接缝）
 *   签名（AB4，ADR-0047）：环境变量 GML_RELEASE_SIGN_KEY=<Ed25519 私钥 PEM 的绝对路径> 时，对 EVIDENCE 的规范化 JSON 做 Ed25519 签名，
 *     EVIDENCE.sig（base64）写在 EVIDENCE.json 旁；未设置则 `signature: null` 且照常构建。设置了但密钥不可用（缺失、非 Ed25519、
 *     在 git 工作树内、权限对组/其它可读）⇒ 在构建前失败，绝不静默退回未签名。zip 本身不含证据（证据含 zip 哈希，会自指）。
 *   透明日志（AC6，ADR-0052）：--log[=<文件>]（默认 docs/release/EVIDENCE-LOG.jsonl）。构建前校验链并拒绝同名候选；
 *     证据通过自验后追加一行 {name, evidence_sha256, signature 摘要|null, built_by, timestamp, prev}。GITHUB_ACTIONS=true 记
 *     built_by: hosted-ci（此时拒绝配置签名密钥：托管 CI 不持钥）；有签名记 key-holder；否则 local。EVIDENCE 里也带 built_by。
 *     追加会修改被跟踪文件：下一次构建前须先提交该行。
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
import { hashTestsTree, TESTS_TREE_FILE } from './lib/tests-tree.mjs'
import { KEY_ENV, SIG_FILE, loadSigningKey, signEvidence } from './lib/evidence-sign.mjs'
import { createPublicKey } from 'node:crypto'
import { LOG_FILE, appendEntry, assertAppendable, builtByFor } from './lib/evidence-log.mjs'
import { assertFsFaultAllowed } from './lib/fs-fault.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const RESULTS = new Set(['passed', 'failed'])
const KNOWN = new Set(['output', 'skip-build', 'skip-docs', 'reuse-node-modules', 'run-guards', 'run-tests', 'ci-run', 'log',
  'focused-result', 'focused-source', 'regression-result', 'regression-source'])
export const GUARDS = [
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
  const flagOnly = ['skip-build', 'skip-docs', 'reuse-node-modules', 'run-guards', 'run-tests']
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const m = /^--([a-z-]+)(?:=(.*))?$/.exec(a)
    if (!m || !KNOWN.has(m[1])) throw new Error(`Unknown or malformed argument: ${a}`)
    // 值选项同时接受 `--k=v` 与 `--k v`；--log 的值可省略（默认路径），且只接受 `--log=<file>` 形式
    if (m[1] === 'log') { opts.log = m[2] === undefined ? true : m[2]; if (m[2] === '') throw new Error('--log= needs a file path'); continue }
    if (m[2] === undefined && !flagOnly.includes(m[1]) && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) opts[m[1]] = argv[++i]
    else opts[m[1]] = m[2] ?? true
  }
  for (const k of Object.keys(opts)) if (k !== 'log' && flagOnly.includes(k) === (typeof opts[k] !== 'boolean')) throw new Error(`--${k} ${flagOnly.includes(k) ? 'takes no value' : 'needs a value'}`)
  if (opts['ci-run'] !== undefined && opts['ci-run'] !== 'auto' && !/^\d{1,20}$/.test(opts['ci-run'])) throw new Error('--ci-run must be a numeric GitHub Actions run id or "auto"')
  if (opts['run-tests'] && opts['focused-result'] !== undefined) throw new Error('--run-tests produces the focused result itself; do not combine it with --focused-result')
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
// git status 看不到被 .gitignore 忽略的文件，而打包器按目录整体复制；所以另查忽略文件：只允许依赖目录与构建/输出目录。
const IGNORED_OK = /^(?:node_modules|dist|release)(?:\/|$)/
function assertClean(when) {
  const ignored = git('ls-files', '--others', '--ignored', '--exclude-standard').split('\n').filter(f => f && !IGNORED_OK.test(f))
  if (ignored.length) throw new Error(`Working tree is dirty ${when}: git-ignored files would be copied into the package (the packager copies whole directories):\n${ignored.slice(0, 10).join('\n')}`)
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
export function scanSecrets(dir) {
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
      const stat = fs.statSync(full)
      if (stat.size > 64 * 1024 * 1024) { findings.push(`${rel}: larger than 64 MiB, cannot be scanned`); continue }
      const text = fs.readFileSync(full).toString('latin1') // 模式都是 ASCII；二进制与大文件同样扫描，不跳过
      for (const [label, re] of SECRET_PATTERNS) if (re.test(text)) findings.push(`${rel}: ${label}`)
    }
  }
  walk(dir)
  return { result: findings.length ? 'failed' : 'passed', origin: 'produced', files_scanned: scanned, findings }
}

export const FOCUSED_CMD = ['--test', '--test-concurrency=1', 'tests/*.test.mjs']
/** 从 node --test 的 spec/TAP 汇总行解析计数；任何一项缺失返回 null（调用方必须据此失败，而不是写 produced）。 */
export function parseTestSummary(text) {
  const counts = {}
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const hits = [...String(text).matchAll(new RegExp(`^(?:ℹ|#) ${key} (\\d+)\\s*$`, 'gm'))]
    if (hits.length !== 1) return null
    counts[key] = Number(hits[0][1])
  }
  return counts
}
/** 运行焦点套件（展开 glob 由 node 自己做），返回 {result, origin:'produced', …}；失败也返回结果，由调用方决定是否中止。 */
function runFocused(cwd) {
  const files = fs.existsSync(path.join(cwd, 'tests')) ? fs.readdirSync(path.join(cwd, 'tests')).filter(f => f.endsWith('.test.mjs')).sort().map(f => `tests/${f}`) : []
  if (!files.length) throw new Error('--run-tests: no tests/*.test.mjs found; refusing to record an empty run')
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, env: { ...process.env, NO_COLOR: '1' } })
  const duration_ms = Date.now() - t0
  const out = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const counts = parseTestSummary(out)
  if (r.status !== 0) {
    const notOk = out.split('\n').filter(l => /^\s*(?:✖|not ok)\s/.test(l)).slice(0, 40).join('\n')
    throw new Error(`Focused suite failed (exit ${r.status}):\n${notOk || out.slice(-3000)}`)
  }
  if (!counts) throw new Error('Focused suite exited 0 but its summary counts could not be parsed; refusing to record a produced result')
  if (counts.tests < 1 || counts.pass < 1 || counts.fail !== 0 || counts.cancelled !== 0) throw new Error(`Focused suite summary is not a clean pass: ${JSON.stringify(counts)}`)
  return { result: 'passed', origin: 'produced', command: `node --test --test-concurrency=1 tests/*.test.mjs`, files: files.length, duration_ms, summary_counts: counts }
}

/** `--ci-run=auto`：用 gh 查 HEAD 对应 ci.yml 的最新成功 run。拿不到就 id=null 并写明原因。 */
export function resolveCiRun(commit, { gh = process.env.OS_ERP_GH || 'gh', cwd = ROOT } = {}) {
  const none = reason => ({ id: null, lookup: { mode: 'auto', source: 'gh run list', reason } })
  const r = spawnSync(gh, ['run', 'list', '--commit', commit, '--workflow', 'ci.yml', '--json', 'databaseId,conclusion,status,headSha,createdAt', '--limit', '30'], { cwd, encoding: 'utf8', timeout: 60000 })
  if (r.error) return none(`gh unavailable: ${r.error.code || r.error.message}`)
  if (r.status !== 0) return none(`gh run list failed (exit ${r.status}): ${String(r.stderr).trim().slice(0, 300)}`)
  let runs
  try { runs = JSON.parse(r.stdout) } catch { return none('gh run list returned unparseable output') }
  if (!Array.isArray(runs)) return none('gh run list returned unexpected output')
  if (!runs.length) return none(`no ci.yml run recorded for commit ${commit.slice(0, 7)}`)
  const ok = runs.filter(x => x && x.conclusion === 'success' && Number.isInteger(x.databaseId) && x.headSha === commit)
    .sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || b.databaseId - a.databaseId)
  if (!ok.length) return none(`${runs.length} ci.yml run(s) for ${commit.slice(0, 7)}, none with conclusion success (${[...new Set(runs.map(x => x?.conclusion || x?.status || 'unknown'))].join(', ')})`)
  return { id: String(ok[0].databaseId), lookup: { mode: 'auto', source: 'gh run list', conclusion: 'success', head_sha: commit, run_created_at: ok[0].createdAt ?? null, ...(process.env.OS_ERP_GH ? { gh_override: true } : {}) } }
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
  // 签名密钥在任何构建之前加载：配置了就必须可用，否则直接失败（不留产物）。
  const signKeyPath = process.env[KEY_ENV]
  if (signKeyPath !== undefined && signKeyPath === '') throw new Error(`${KEY_ENV} is set but empty; unset it to build an unsigned candidate`)
  let signKey = null
  if (signKeyPath !== undefined) { try { signKey = loadSigningKey(signKeyPath) } catch (error) { throw new Error(`${KEY_ENV}: ${error.message}`) } }
  const hosted = process.env.GITHUB_ACTIONS === 'true'
  if (hosted && signKeyPath !== undefined) throw new Error(`${KEY_ENV} is set on a hosted CI runner; hosted CI must not hold the signing key (formal releases are re-signed by the key holder on a controlled machine)`)
  const commit = git('rev-parse', 'HEAD')
  const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const name = `RC-${version}-${commit.slice(0, 7)}`
  const output = path.resolve(opts.output || path.join(ROOT, 'release'))
  const zipFile = path.join(output, `${name}.zip`)
  const evidenceDir = path.join(output, `${name}.evidence`)
  for (const f of [zipFile, evidenceDir]) if (fs.existsSync(f)) throw new Error(`${f} already exists; remove it first`) // 在可清理区之前判断，绝不删除已有候选
  const logFile = opts.log === undefined ? null : path.resolve(opts.log === true ? path.join(ROOT, LOG_FILE) : opts.log)
  if (logFile) { assertFsFaultAllowed(); assertAppendable(logFile, name) } // 链已坏或同名已入日志 ⇒ 构建前失败，不留产物
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
    // 3b. 焦点套件（--run-tests；先于守卫，失败最快暴露）：亲自运行并把测试树哈希与包内清单对上，再确认运行没有改动工作树。
    let focused = null
    if (opts['run-tests']) {
      const before = hashTestsTree(ROOT)
      const listing = JSON.parse(fs.readFileSync(path.join(pkg, TESTS_TREE_FILE), 'utf8'))
      if (listing.tree_sha256 !== before) throw new Error(`tests/ tree hash ${before} differs from the package listing ${listing.tree_sha256}`)
      focused = runFocused(ROOT)
      const after = hashTestsTree(ROOT)
      if (after !== before) throw new Error('tests/ changed while the suite was running')
      assertClean('after running the focused suite')
      if (git('rev-parse', 'HEAD') !== commit) throw new Error('HEAD moved while the focused suite was running')
      focused.tests_tree_sha256 = before
      focused.tests_files = listing.files.length
    }
    // 4. 守卫（可选，亲自运行才记录）
    const guards = {}
    for (const [label, argv] of GUARDS) {
      if (!opts['run-guards'] && !opts['run-tests']) { guards[label] = { result: 'not run' }; continue }
      const t0 = Date.now()
      const r = sh(process.execPath, argv, { stdio: ['ignore', 'inherit', 'inherit'] })
      guards[label] = { result: r.status === 0 ? 'passed' : 'failed', origin: 'produced', duration_ms: Date.now() - t0 }
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
    const ci = opts['ci-run'] === 'auto' ? resolveCiRun(commit)
      : opts['ci-run'] !== undefined ? { id: opts['ci-run'], lookup: { mode: 'operator-supplied', note: 'reference supplied by the operator; not looked up' } }
      : { id: null, lookup: { mode: 'none', reason: 'no --ci-run given' } }
    const builtAt = new Date().toISOString()
    const attested = k => opts[`${k}-result`] === undefined ? { source: 'not run', result: 'not run' } : { source: opts[`${k}-source`], result: opts[`${k}-result`], origin: 'operator-attested' }
    const evidence = {
      schema: 1, version, commit, built_at: builtAt, node: process.version,
      artifact: { name: `${name}.zip`, sha256: zipHash, bytes: zipBytes.length, files: Object.keys(manifest.files).length },
      focused_tests: focused ?? attested('focused'), guards, regression: attested('regression'),
      ci_run_id: ci.id,
      ci_lookup: ci.lookup,
      synthetic_drill: drillReference(),
      verify_release: { result: 'passed', origin: 'produced' },
      acceptance: { result: smoke.result, origin: 'produced', mode: smoke.mode, checks: smoke.checks.length, reuse_node_modules: Boolean(opts['reuse-node-modules']) },
      secret_scan: secretScan,
      not_a_release: true,
      built_by: builtByFor({ signed: Boolean(signKey) }),
      signature: null
    }
    // 签名覆盖整份证据（含 signature 元数据）；写出的 JSON 必须与被签对象逐字段一致（验签时按规范化字节，与缩进无关）。
    const signed = signKey ? signEvidence(evidence, signKey) : null
    const finalEvidence = signed ? signed.evidence : evidence
    fs.mkdirSync(evidenceDir, { recursive: true })
    fs.writeFileSync(path.join(evidenceDir, 'EVIDENCE.json'), JSON.stringify(finalEvidence, null, 2) + '\n')
    if (signed) fs.writeFileSync(path.join(evidenceDir, SIG_FILE), `${signed.sigBase64}\n`)
    const selfPub = signKey ? path.join(work, 'self-verify.pub.pem') : null
    if (selfPub) fs.writeFileSync(selfPub, createPublicKey(signKey).export({ type: 'spki', format: 'pem' }))
    fs.writeFileSync(path.join(evidenceDir, 'RELEASE-NOTES.md'), extractNotes(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), version, { commit, builtAt }).text)
    runNode(pkg, ['scripts/verify-release.mjs', `--evidence=${path.join(evidenceDir, 'EVIDENCE.json')}`, `--artifact=${zipFile}`, ...(selfPub ? [`--pubkey=${selfPub}`] : [])], 'verify-release --evidence')
    if (logFile) {
      const entry = appendEntry(logFile, { name, evidence: finalEvidence, sigText: signed ? signed.sigBase64 : null, builtBy: finalEvidence.built_by })
      console.log(`[release-candidate] evidence log: appended ${entry.name} to ${logFile} (commit this line before the next build)`)
    }
    console.log(JSON.stringify({ candidate: zipFile, sha256: zipHash, evidence: path.join(evidenceDir, 'EVIDENCE.json'), notes: path.join(evidenceDir, 'RELEASE-NOTES.md'), not_a_release: true }, null, 2))
  } catch (error) {
    if (error.committed) console.error(`[release-candidate] the evidence log line for ${name} is already durable; candidate outputs are kept (commit the log line)`)
    else cleanupOutputs()
    console.error(`[release-candidate] ${error.message}`)
    process.exitCode = 1
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

// 先判定再运行：被测试 import 时只导出 extractNotes。
try { if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url))) main() } catch (error) { console.error(`[release-candidate] ${error.message}`); process.exitCode = 1 }
