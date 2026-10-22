/**
 * ============================================================================
 * 文件标识：scripts/test-local-delivery.mjs | 对全新解压副本执行安装验收，不得指向正在使用的副本。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import net from 'node:net'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const root = path.resolve(arg('package') || '')
const evidence = path.resolve(arg('evidence') || fs.mkdtempSync(path.join(os.tmpdir(), 'banyuan-install-evidence-')))
if (!arg('package') || !fs.existsSync(path.join(root, 'MANIFEST.json'))) throw new Error('--package must point to a fresh extracted release')
for (const dir of ['data', '.local', 'node_modules']) if (fs.existsSync(path.join(root, dir))) throw new Error(`Not a fresh package: ${dir} exists`)
fs.mkdirSync(evidence, { recursive: true })
const log = fs.createWriteStream(path.join(evidence, 'install-smoke.log'))
const report = { startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.version, checks: [] }
function check(name, fn) { fn(); report.checks.push(name); console.log(`[PASS] ${name}`) }
const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }) })
const base = `http://127.0.0.1:${port}`
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}`, GML_LOCAL_PORT: String(port),
  GML_DATA_DIR: path.join(evidence, 'must-not-create'), GML_DB: path.join(evidence, 'must-not-create.db'), GML_JWT_SECRET: 'must-not-use' }
function child(argv, extra = {}) {
  const p = spawn(process.execPath, argv, { cwd: root, env: { ...env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
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
  server = child(['scripts/local-manage.mjs', 'start', '--no-browser'])
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
  check('source, tests, reusable modules and built frontend included', () => {
    for (const f of ['src/App.tsx', 'server/index.js', 'scripts/regress-isolated.mjs', 'scripts/test-access-boundaries.mjs', 'reusable/README.md', 'dist/index.html', 'package-lock.json']) assert.ok(fs.existsSync(path.join(root, f)), f)
  })
  assert.equal(await run(['scripts/verify-release.mjs']), 0); check('pristine package hashes pass', () => {})
  assert.equal(await run(['scripts/local-manage.mjs', 'setup']), 0); check('fresh npm runtime installation succeeds', () => {})
  check('runtime installation excludes build-only vulnerable dependency chain', () => {
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
  await login(username, 'cosmetic', 'Test-only-123456')
  check('restart preserves user data and signing configuration', () => assert.deepEqual(fs.readFileSync(path.join(root, '.local/config.json')), originalConfig))
  await stop()
  const dataBefore = path.join(root, 'data-before-restore')
  fs.renameSync(path.join(root, 'data'), dataBefore); fs.mkdirSync(path.join(root, 'data'))
  for (const file of fs.readdirSync(lastBackup).filter(name => name.endsWith('.db'))) fs.copyFileSync(path.join(lastBackup, file), path.join(root, 'data', file))
  fs.copyFileSync(path.join(lastBackup, 'config.json'), path.join(root, '.local/config.json'))
  await start(); await login(username, 'cosmetic', 'Test-only-123456')
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
  report.result = 'passed'
} catch (error) { report.result = 'failed'; report.error = error.stack; console.error(error); process.exitCode = 1 }
finally {
  await stop(); report.completedAt = new Date().toISOString()
  fs.writeFileSync(path.join(evidence, 'install-smoke.json'), JSON.stringify(report, null, 2))
  await new Promise(resolve => log.end(resolve))
  console.log(`[result] ${report.result}; ${report.checks.length} checks; ${evidence}`)
}
