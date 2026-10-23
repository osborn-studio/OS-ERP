/**
 * ============================================================================
 * 文件标识：scripts/test-local-delivery.mjs | 对全新解压副本执行安装验收，不得指向正在使用的副本。
 * ============================================================================
 * 两种模式（显式选择，缺省 = production）：
 *   --mode=production（默认）：与真实交付一致 —— setup --instance → bootstrap-admin（密码只走 stdin）→ start →
 *       用 bootstrap 出来的管理员登录 → 健康/版本/build_sha → 受限能力 503 → 无演示账号/数据 → 备份 → 恢复演练。
 *       实例目录在 evidence 下，发行包目录保持原样（哈希清单始终有效）。
 *   --mode=demo：保留旧的样本数据流程（GML_RUNTIME_MODE=demo，admin/12345 等演示账号），仅用于演示验收。
 * 额外开关 --reuse-node-modules：包内已有 node_modules（测试用的最小包会软链仓库依赖）时跳过"全新包"的
 *   node_modules 检查、npm 安装与"构建链不在运行时依赖里"检查；真实发行包验收不得使用。
 * 用法：node scripts/test-local-delivery.mjs --package=/abs/extracted/release [--mode=production|demo] [--evidence=/abs/dir]
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('package') || '')
const evidence = path.resolve(arg('evidence') || fs.mkdtempSync(path.join(os.tmpdir(), 'banyuan-install-evidence-')))
const mode = arg('mode') || 'production'
if (!['production', 'demo'].includes(mode)) throw new Error('--mode must be production or demo')
const reuseNodeModules = process.argv.includes('--reuse-node-modules')
if (!arg('package') || !fs.existsSync(path.join(root, 'MANIFEST.json'))) throw new Error('--package must point to a fresh extracted release')
for (const dir of ['data', '.local', ...(reuseNodeModules ? [] : ['node_modules'])]) if (fs.existsSync(path.join(root, dir))) throw new Error(`Not a fresh package: ${dir} exists`)
fs.mkdirSync(evidence, { recursive: true })
const log = fs.createWriteStream(path.join(evidence, 'install-smoke.log'))
const report = { mode, startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version, checks: [] }
function check(name, fn) { fn(); report.checks.push(name); console.log(`[PASS] ${name}`) }
const timings = {}
async function timed(name, fn) { const t = performance.now(); try { return await fn() } finally { timings[name] = Math.round(performance.now() - t) } }
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const instance = mode === 'production' ? path.join(evidence, 'instance') : null
let currentInstance = instance // 恢复验收会把服务切到第二个实例目录
const manage = (...argv) => ['scripts/local-manage.mjs', ...argv, ...(currentInstance ? [`--instance=${currentInstance}`] : [])]
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, GML_LOCAL_PORT: String(port),
  ...(mode === 'demo' ? { GML_RUNTIME_MODE: 'demo' } : {}), GML_DATA_DIR: path.join(evidence, 'must-not-create'), GML_DB: path.join(evidence, 'must-not-create.db'), GML_JWT_SECRET: 'must-not-use' }
function child(argv, extra = {}, stdin = 'ignore') {
  const p = spawn(process.execPath, argv, { cwd: root, env: { ...env, ...extra }, stdio: [stdin, 'pipe', 'pipe'] })
  p.stdout.on('data', d => log.write(d)); p.stderr.on('data', d => log.write(d))
  p.done = new Promise((resolve, reject) => { p.once('error', reject); p.once('close', code => resolve(code)) })
  return p
}
async function run(argv, extra) {
  const p = child(argv, extra)
  const timer = setTimeout(() => p.kill('SIGTERM'), 240000)
  try { return await p.done } finally { clearTimeout(timer) }
}
let server
async function stop() {
  if (!server) return
  server.kill('SIGTERM')
  await server.done
  server = null
}
async function start() {
  server = child(manage('start', '--no-browser'))
  let closed = false
  server.done.then(() => { closed = true })
  for (let i = 0; i < 360; i++) {
    if (closed) throw new Error('Server exited before healthy')
    try { const r = await fetch(`${base}/api/meta/health`, { signal: AbortSignal.timeout(1000) }); if ((await r.json()).data?.status === 'ok') return } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  throw new Error('Startup timeout')
}
async function api(url, token, body, expected = 200, method = body ? 'POST' : 'GET') {
  const r = await fetch(`${base}${url}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) })
  assert.equal(r.status, expected, `${method} ${url}`)
  return r.json()
}
async function login(username, industry = 'cosmetic', password = username === 'admin' ? '12345' : '123456') {
  const b = await api('/api/auth/login', null, { username, password, industry })
  assert.ok(b.data?.token)
  return b.data.token
}
try {
  if (mode === 'demo') {
  check('source, tests, reusable modules and built frontend included', () => {
    for (const f of ['src/App.tsx', 'server/index.js', 'scripts/regress-isolated.mjs', 'scripts/test-access-boundaries.mjs', 'reusable/README.md', 'dist/index.html', 'package-lock.json']) assert.ok(fs.existsSync(path.join(root, f)), f)
  })
  assert.equal(await run(['scripts/verify-release.mjs']), 0); check('pristine package hashes pass', () => {})
  assert.equal(await run(['scripts/local-manage.mjs', 'setup']), 0); check('fresh npm runtime installation succeeds', () => {})
  if (!reuseNodeModules) check('runtime installation excludes build-only vulnerable dependency chain', () => {
    for (const name of ['braces', 'tailwindcss', 'vite']) assert.ok(!fs.existsSync(path.join(root, 'node_modules', name)), name)
  })
  const originalConfig = fs.readFileSync(path.join(root, '.local/config.json'))
  check('unique secret generated without copying external configuration', () => assert.equal(JSON.parse(originalConfig).jwtSecret.length, 96))
  assert.equal(await run(['scripts/local-manage.mjs', 'setup']), 0)
  check('repeat setup preserves secret and does not seed database', () => { assert.deepEqual(fs.readFileSync(path.join(root, '.local/config.json')), originalConfig); assert.equal(fs.readdirSync(path.join(root, 'data')).length, 0) })
  await start(); check('first launch creates fresh sample databases and serves health', () => {
    for (const name of ['cosmetic', 'food', 'apparel']) assert.ok(fs.statSync(path.join(root, 'data', `gml_${name}.db`)).size > 1000)
    assert.ok(!fs.existsSync(env.GML_DATA_DIR)); assert.ok(!fs.existsSync(env.GML_DB))
  })
  for (const route of ['/login', '/pos', '/mall', '/docs/install.html', '/docs/manual.html', '/docs/demo-flow.html', '/docs/dev.html', '/docs/security.html']) {
    const r = await fetch(base + route); const html = await r.text()
    check(`web route ${route}`, () => { assert.equal(r.status, 200); assert.ok(html.includes('<html')) })
    if (route === '/login') {
      const js = html.match(/src="([^"]+\.js)"/)[1]
      const asset = await fetch(base + js)
      check('built application JavaScript asset loads', () => assert.equal(asset.status, 200))
    }
  }
  const tokens = {}
  for (const role of ['admin', 'boss', 'scm', 'purchase', 'sales', 'warehouse', 'finance', 'viewer', 'store01', 'dealer01']) {
    tokens[role] = await login(role); check(`demo account ${role} logs in`, () => {})
  }
  const food = await login('admin', 'food')
  await api('/api/dashboard/summary', food); check('food industry admin queries its dashboard', () => {})
  await api('/api/dashboard/summary', tokens.admin); check('HQ dashboard loads', () => {})
  await api('/api/pos/context', tokens.store01); check('store POS context loads', () => {})
  const self = await api('/api/order-center/overview', tokens.dealer01)
  check('dealer self order center loads', () => assert.ok(self.data.self))
  await api('/api/dashboard/summary', tokens.dealer01, null, 403); check('dealer cannot access HQ dashboard', () => {})
  await api('/api/mall/home'); check('consumer mall product home loads', () => {})
  const missing = await fetch(`${base}/api/not-a-real-endpoint`)
  check('unknown API stays JSON 404 instead of SPA HTML', () => { assert.equal(missing.status, 404); assert.ok(missing.headers.get('content-type').includes('json')) })
  const issued = await api('/api/mcp/tokens', tokens.admin, { name: 'installation-readonly-check', scopes: 'read', rate_limit: 100 })
  const agent = issued.data.token
  const tools = await api('/mcp', agent, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
  check('MCP authenticated tool discovery', () => assert.ok(tools.result.tools.length > 0))
  const types = await api('/mcp', agent, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'doc.list_types', arguments: {} } })
  check('MCP read-only document discovery executes', () => { assert.ok(types.result); assert.ok(!types.result.isError) })
  assert.equal(await run(['scripts/mcp-readonly-demo.mjs'], { GML_AGENT_TOKEN: agent, GML_MCP_URL: `${base}/mcp` }), 0)
  check('shipped MCP read-only example runs', () => {})
  const username = 'delivery-persistence-check'
  await api('/api/auth/users', tokens.admin, { username, name: 'Installation test user', password: 'Test-only-123456-long!', role: 'viewer' })
  check('sample user can be created through business API', () => {})
  const collision = await run(['scripts/local-manage.mjs', 'start', '--no-browser'])
  check('port conflict fails without stopping existing instance', () => assert.notEqual(collision, 0))
  await api('/api/meta/health')
  assert.equal(await run(['scripts/local-manage.mjs', 'doctor']), 0); check('doctor passes on installed instance', () => {})
  await stop()
  assert.equal(await run(['scripts/local-manage.mjs', 'backup']), 0)
  const backups = fs.readdirSync(path.join(root, 'backups')); const lastBackup = path.join(root, 'backups', backups[0])
  check('stopped-service backup contains all databases and configuration', () => {
    for (const f of ['gml_cosmetic.db', 'gml_food.db', 'gml_apparel.db', 'config.json']) assert.ok(fs.existsSync(path.join(lastBackup, f)))
  })
  await start()
  await login(username, 'cosmetic', 'Test-only-123456-long!')
  check('restart preserves user data and signing configuration', () => assert.deepEqual(fs.readFileSync(path.join(root, '.local/config.json')), originalConfig))
  await stop()
  const dataBefore = path.join(root, 'backups', 'data-before-restore') // 放在 backups/ 下：包根其余位置不允许出现清单外文件
  fs.mkdirSync(path.join(root, 'backups'), { recursive: true }); fs.renameSync(path.join(root, 'data'), dataBefore); fs.mkdirSync(path.join(root, 'data'))
  for (const file of fs.readdirSync(lastBackup).filter(name => name.endsWith('.db'))) fs.copyFileSync(path.join(lastBackup, file), path.join(root, 'data', file))
  fs.copyFileSync(path.join(lastBackup, 'config.json'), path.join(root, '.local/config.json'))
  await start(); await login(username, 'cosmetic', 'Test-only-123456-long!')
  check('manual restore procedure succeeds in a new data directory', () => {})
  await stop()
  const readme = path.join(root, 'README.md'); const before = fs.readFileSync(readme)
  try {
    fs.appendFileSync(readme, '\nTamper test\n')
    assert.notEqual(await run(['scripts/verify-release.mjs']), 0)
    check('integrity check detects modified release file', () => {})
  } finally { fs.writeFileSync(readme, before) }
  assert.equal(await run(['scripts/verify-release.mjs']), 0)
  check('generated data and backups do not invalidate release hashes', () => {})
  } else {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'MANIFEST.json'), 'utf8'))
  const require = createRequire(path.join(root, 'package.json'))
  const adminName = 'owner'
  const adminPassword = randomBytes(24).toString('base64url') // 每次验收随机生成，只经 stdin 传入，不写进日志/报告
  const prodEnv = { GML_RUNTIME_MODE: 'production', GML_DATA_DIR: path.join(instance, 'data'), GML_DB: '' }
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

  check('package carries provenance (baseCommit, third-party notices) and the required source/frontend files', () => {
    for (const f of ['src/App.tsx', 'server/index.js', 'scripts/bootstrap-admin.mjs', 'scripts/db-restore-drill.mjs', 'reusable/README.md', 'dist/index.html', 'package-lock.json', 'THIRD_PARTY_NOTICES.md']) assert.ok(fs.existsSync(path.join(root, f)), f)
    assert.match(String(manifest.baseCommit), /^[0-9a-f]{7,64}$/, 'MANIFEST.baseCommit must be a git sha')
    assert.ok(manifest.files['THIRD_PARTY_NOTICES.md'], 'notices must be hash-listed')
  })
  // 已知缺口（W10 重写手册）：随包手册仍以演示口径写着默认账号。只记入报告，不让验收假装它们不存在。
  report.warnings = []
  for (const rel of ['docs/本地交付', '手册']) {
    const walk = dir => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(`${dir}/${e.name}`) : [`${dir}/${e.name}`])
    if (fs.existsSync(path.join(root, rel))) for (const f of walk(rel)) if (/admin\s*\/\s*12345/.test(read(f))) report.warnings.push(`${f} advertises demo credentials admin/12345 (docs rewrite pending, roadmap W10)`)
  }
  check('package ships no database, secret, instance state or default credentials', () => {
    const bad = Object.keys(manifest.files).filter(f => /(^|\/)(\.local|backups|data)(\/|$)|\.db(-|$)|(^|\/)\.env(\.|$)/i.test(f) && !/^\.gitignore$/.test(f))
    assert.deepEqual(bad, [])
    for (const f of ['README.md', '00_先读我.md']) assert.ok(!/12345/.test(read(f)), `${f} must not advertise a default password`)
  })
  assert.equal(await timed('verify', () => run(['scripts/verify-release.mjs'])), 0); check('pristine package hashes pass', () => {})
  assert.equal(await timed('setup', () => run(manage('setup'))), 0); check('setup --instance succeeds', () => {})
  if (!reuseNodeModules) check('runtime installation excludes build-only vulnerable dependency chain', () => {
    for (const name of ['braces', 'tailwindcss', 'vite']) assert.ok(!fs.existsSync(path.join(root, 'node_modules', name)), name)
  })
  const configFile = path.join(instance, '.local', 'config.json')
  const originalConfig = fs.readFileSync(configFile)
  check('instance secret generated inside the instance, package root untouched, no database seeded', () => {
    assert.equal(JSON.parse(originalConfig).jwtSecret.length, 96)
    assert.equal(fs.readdirSync(path.join(instance, 'data')).length, 0)
    assert.ok(!fs.existsSync(path.join(root, 'data')) && !fs.existsSync(path.join(root, '.local')))
  })
  assert.equal(await run(manage('setup')), 0)
  check('repeat setup preserves the secret', () => assert.deepEqual(fs.readFileSync(configFile), originalConfig))

  const boot = child(['scripts/bootstrap-admin.mjs', `--industry=cosmetic`, '--company-code=ACCEPT', '--company-name=Acceptance Co', `--username=${adminName}`, '--name=Owner'], prodEnv, 'pipe')
  let bootOut = ''
  boot.stdout.on('data', d => { bootOut += d }); boot.stderr.on('data', d => { bootOut += d })
  boot.stdin.end(adminPassword + '\n')
  assert.equal(await timed('bootstrap', () => boot.done), 0, bootOut)
  check('bootstrap-admin (password via stdin) creates the first administrator without echoing secrets', () => {
    assert.ok(JSON.parse(bootOut.trim().split('\n').at(-1)).success)
    assert.ok(!bootOut.includes(adminPassword))
  })

  await timed('start', start); check('production start serves health', () => assert.ok(!fs.existsSync(env.GML_DATA_DIR) && !fs.existsSync(env.GML_DB)))
  const health = (await api('/api/meta/health')).data
  check('health reports package version and MANIFEST build_sha', () => {
    assert.equal(health.status, 'ok'); assert.equal(health.version, manifest.version); assert.equal(health.build_sha, manifest.baseCommit)
  })
  const token = await login(adminName, 'cosmetic', adminPassword)
  check('the bootstrapped administrator logs in and reaches the dashboard', () => {})
  await api('/api/dashboard/summary', token); 
  const demoLogin = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' }) })
  check('demo credentials admin/12345 are rejected', () => assert.equal(demoLogin.status, 401))
  check('production databases hold only the bootstrapped admin and no demo business rows or agent tokens', () => {
    const Database = require('better-sqlite3')
    for (const name of ['cosmetic', 'food', 'apparel']) {
      const db = new Database(path.join(instance, 'data', `gml_${name}.db`), { readonly: true })
      try {
        assert.equal(db.prepare('SELECT mode FROM os_egp_runtime').get().mode, 'production')
        assert.deepEqual(db.prepare('SELECT username FROM users').all().map(u => u.username), name === 'cosmetic' ? [adminName] : [])
        for (const table of ['products', 'sales_orders', 'purchase_orders', 'agent_tokens']) assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${name}.${table}`)
      } finally { db.close() }
    }
  })
  for (const route of ['/login', '/docs/install.html', '/docs/manual.html']) {
    const r = await fetch(base + route); const html = await r.text()
    check(`web route ${route}`, () => { assert.equal(r.status, 200); assert.ok(html.includes('<html')) })
    if (route === '/login') {
      const asset = await fetch(base + html.match(/src="([^"]+\.js)"/)[1])
      check('built application JavaScript asset loads', () => assert.equal(asset.status, 200))
    }
  }
  for (const [method, url, body] of [['GET', '/api/mall/home'], ['GET', '/api/qimen/ping'], ['POST', '/api/oms/sync', {}], ['POST', '/api/im/sync', {}], ['POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' }], ['GET', '/api/mcp/tokens']]) {
    const r = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const b = await r.json()
    check(`restricted surface ${method} ${url} is 503 FEATURE_DISABLED`, () => { assert.equal(r.status, 503); assert.equal(b.error, 'FEATURE_DISABLED') })
  }
  const missing = await fetch(`${base}/api/not-a-real-endpoint`)
  check('unknown API stays JSON 404 instead of SPA HTML', () => { assert.equal(missing.status, 404); assert.ok(missing.headers.get('content-type').includes('json')) })
  assert.notEqual(await run(manage('start', '--no-browser')), 0)
  check('port conflict fails without stopping the running instance', () => {})
  await api('/api/meta/health')
  assert.equal(await run(manage('doctor')), 0); check('doctor passes on the installed instance', () => {})
  await stop()

  assert.equal(await timed('backup', () => run(manage('backup'))), 0)
  const backupRoot = path.join(instance, 'backups'); const lastBackup = path.join(backupRoot, fs.readdirSync(backupRoot)[0])
  check('local-manage backup holds all production databases and configuration', () => {
    for (const f of ['gml_cosmetic.db', 'gml_food.db', 'gml_apparel.db', 'config.json']) assert.ok(fs.existsSync(path.join(lastBackup, f)), f)
  })
  assert.equal(await run(['scripts/db-backup.mjs', 'cosmetic'], prodEnv), 0)
  const drillBackups = path.join(instance, 'data', 'backups')
  check('db-backup produces a verified backup set with a report', () => assert.ok(fs.readdirSync(drillBackups).some(f => /^backup-report-.*\.json$/.test(f))))
  const drillTarget = path.join(evidence, 'restore-drill')
  const drill = child(['scripts/db-restore-drill.mjs', `--backup-dir=${drillBackups}`, `--target-dir=${drillTarget}`, `--drill-username=${adminName}`, '--industry=cosmetic'], prodEnv, 'pipe')
  drill.stdin.end(adminPassword + '\n')
  assert.equal(await timed('restore_drill', () => drill.done), 0)
  check('restore drill logs in as the bootstrapped admin and all probes match', () => {
    const file = fs.readdirSync(drillTarget).find(f => /^restore-drill-.*\.json$/.test(f))
    const text = fs.readFileSync(path.join(drillTarget, file), 'utf8')
    assert.equal(JSON.parse(text).passed, true); assert.ok(!text.includes(adminPassword))
  })

  // 把 local-manage 的备份真正恢复到全新实例：配置（签名密钥）与三个库都回来，bootstrap 管理员能登录
  const restored = path.join(evidence, 'instance-restored')
  assert.equal(await run(manage('setup').map(a => a.startsWith('--instance=') ? `--instance=${restored}` : a)), 0)
  fs.mkdirSync(path.join(restored, 'data'), { recursive: true })
  for (const f of fs.readdirSync(lastBackup).filter(n => n.endsWith('.db'))) fs.copyFileSync(path.join(lastBackup, f), path.join(restored, 'data', f))
  fs.copyFileSync(path.join(lastBackup, 'config.json'), path.join(restored, '.local', 'config.json'))
  currentInstance = restored
  await start()
  await login(adminName, 'cosmetic', adminPassword)
  check('local-manage backup restores into a fresh instance: all three databases, signing config, admin can log in', () => {
    assert.deepEqual(fs.readdirSync(path.join(restored, "data")).filter(n => n.endsWith(".db")).sort(), ['gml_apparel.db', 'gml_cosmetic.db', 'gml_food.db'])
    assert.deepEqual(fs.readFileSync(path.join(restored, '.local', 'config.json')), originalConfig)
  })
  await stop(); currentInstance = instance

  const readme = path.join(root, 'README.md'); const before = fs.readFileSync(readme)
  try {
    fs.appendFileSync(readme, '\nTamper test\n')
    assert.notEqual(await run(['scripts/verify-release.mjs']), 0)
    check('integrity check detects modified release file', () => {})
  } finally { fs.writeFileSync(readme, before) }
  fs.writeFileSync(path.join(root, 'planted.env'), 'X=1')
  try { assert.notEqual(await run(['scripts/verify-release.mjs']), 0); check('integrity check detects an unlisted file planted in the package', () => {}) } finally { fs.rmSync(path.join(root, 'planted.env')) }
  assert.equal(await run(['scripts/verify-release.mjs']), 0)
  check('instance data and backups (outside the package) do not invalidate release hashes', () => {})
  report.timings_ms = timings
  }
  report.result = 'passed'
} catch (error) { report.result = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1 }
finally {
  await stop(); report.completedAt = new Date().toISOString()
  fs.writeFileSync(path.join(evidence, 'install-smoke.json'), JSON.stringify(report, null, 2))
  await new Promise(resolve => log.end(resolve))
  console.log(`[result] ${report.result}; mode=${mode}; ${report.checks.length} checks; ${evidence}`)
}
