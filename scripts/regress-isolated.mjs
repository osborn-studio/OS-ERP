/**
 * ============================================================================
 * 文件标识：scripts/regress-isolated.mjs | 独立副本全量回归
 * 【职责】复制当前代码、创建全新样本库与独立运行库，保存代码指纹和回归日志。
 * ============================================================================
 */
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import Database from 'better-sqlite3'
import { resolvePythonRuntime } from './lib/python-runtime.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { values } = parseArgs({ options: {
  rounds: { type: 'string', default: '3' }, industries: { type: 'string', default: 'cosmetic,food' }, output: { type: 'string' }
} })
const rounds = Number(values.rounds)
const industries = values.industries.split(',').map(s => s.trim())
if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error('--rounds must be a positive integer')
if (!industries.length || industries.some(code => !['cosmetic', 'food', 'apparel'].includes(code))) throw new Error('Invalid industries')
// Verify the independent XLSX reader before creating or seeding any database.
// Explicitly record the actual interpreter, not just a PATH command that may resolve differently later.
if (process.env.GML_VERIFY_PLATFORM && process.platform !== process.env.GML_VERIFY_PLATFORM) {
  throw new Error(`Verification requires ${process.env.GML_VERIFY_PLATFORM}; current platform is ${process.platform}`)
}
const python = resolvePythonRuntime()
// XLSX verification also uses an independent ZIP integrity checker; missing it is
// an environment failure, not a reason to skip its assertions after an expensive run.
const unzipProbe = spawnSync('unzip', ['-v'], { encoding: 'utf8', timeout: 5000, maxBuffer: 64 * 1024 })
if (unzipProbe.error || unzipProbe.status !== 0) {
  throw Object.assign(new Error(`ZIP verifier unavailable: unzip -v (${unzipProbe.error?.code || `exit ${unzipProbe.status}`}). Install or expose unzip in the Linux test PATH before running regression.`), { code: 'UNZIP_VERIFIER_UNAVAILABLE' })
}
const unzip = unzipProbe.stdout.split('\n')[0].trim()
const workspace = mkdtempSync('/tmp/gml-regression-')
const repo = path.join(workspace, 'repo')
const runData = path.join(workspace, 'run-data')
const evidence = path.resolve(values.output || path.join(ROOT, 'docs/evidence', `regression-${Date.now()}`))
mkdirSync(repo)
mkdirSync(runData)
mkdirSync(evidence, { recursive: true })
const hashes = {}
function fingerprint(dir, relative = '') {
  for (const item of readdirSync(dir, { withFileTypes: true })) {
    const rel = path.join(relative, item.name)
    if (item.isDirectory()) fingerprint(path.join(dir, item.name), rel)
    else if (item.isFile()) hashes[rel] = createHash('sha256').update(readFileSync(path.join(dir, item.name))).digest('hex')
  }
}
// .github 也进副本：tests/docker-smoke-policy.test.mjs 静态核对 CI 工作流。
// docs/implementation 与 docs/legal 也进副本：浏览器 CI 策略测试与上游来源测试要读它们（evidence/图片等不复制）。
for (const name of ['server', 'src', 'scripts', 'tests', 'public', 'reusable', '.github', 'docs/implementation', 'docs/legal', 'docs/operations']) {
  if (existsSync(path.join(ROOT, name))) { mkdirSync(path.dirname(path.join(repo, name)), { recursive: true }); cpSync(path.join(ROOT, name), path.join(repo, name), { recursive: true }) }
}
for (const item of readdirSync(ROOT, { withFileTypes: true })) {
  // .env* 不进副本（可能含真实密钥）；.env.example 是无值模板，Docker 策略测试要读它。
  if (item.isFile() && (!item.name.startsWith('.env') || item.name === '.env.example')) cpSync(path.join(ROOT, item.name), path.join(repo, item.name))
}
fingerprint(repo)
symlinkSync(path.join(ROOT, 'node_modules'), path.join(repo, 'node_modules'))
const manifest = {
  source: ROOT, source_head: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
  copied_at: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  python, unzip, repo, runData, rounds, industries, hashes
}
writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2))
console.log(`Isolated code: ${repo}\nIsolated data: ${runData}\nEvidence: ${evidence}`)
const log = createWriteStream(path.join(evidence, 'regression.log'))
async function run(args, env = {}) {
  const child = spawn(process.execPath, args, { cwd: repo,
    env: { ...process.env, GML_RUNTIME_MODE: 'test', GML_DB: '', HOST: '127.0.0.1', GML_DATA_DIR: path.join(repo, 'data'), ...env, GML_PYTHON: python.executable },
    stdio: ['ignore', 'pipe', 'pipe'] })
  const forward = data => { process.stdout.write(data); log.write(data) }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  const code = await new Promise((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  if (code !== 0) throw new Error(`${args.join(' ')} exited ${code}`)
}
try {
  // 部分兼容性守卫需要三库样本；业务验收范围由 industries 显式决定。
  await run(['scripts/reseed-all.mjs', '--force'])
  for (const industry of industries) {
    const source = new Database(path.join(repo, 'data', `gml_${industry}.db`), { readonly: true })
    try { await source.backup(path.join(runData, `gml_${industry}.db`)) } finally { source.close() }
  }
  await run(['scripts/regress-all.mjs'], { GML_DATA_DIR: runData, GML_TEST_INDUSTRIES: industries.join(','), ROUNDS: String(rounds) })
  manifest.result = 'passed'
} catch (e) {
  manifest.result = 'failed'
  manifest.error = e.message
  process.exitCode = 1
  console.error(e.message)
} finally {
  manifest.completed_at = new Date().toISOString()
  writeFileSync(path.join(evidence, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await new Promise(resolve => log.end(resolve))
}
