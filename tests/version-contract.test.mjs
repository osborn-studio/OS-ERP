import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomBytes, randomInt } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { VERSION, buildSha, versionInfo } from '../server/version.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PACKAGE_VERSION = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const BUILD_SHA = 'f'.repeat(40)

async function server(t, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-version-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex'),
    ...extraEnv
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let ready = false
  let stderr = ''
  child.stdout.on('data', data => { ready ||= data.toString().includes('服务已启动') })
  child.stderr.on('data', data => { stderr += data.toString() })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 1200 && !ready && child.exitCode === null; i++) await delay(50)
  assert.ok(ready, `server must start in test mode\n${stderr}`)
  const request = (route, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${port}${route}`, {
    method, headers: { 'content-type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(5000)
  })
  return { request, dir }
}

test('server/version.js is the single version source and validates the build SHA', () => {
  assert.equal(VERSION, PACKAGE_VERSION)
  assert.match(VERSION, /^\d+\.\d+\.\d+/)
  assert.equal(buildSha({ GML_BUILD_SHA: BUILD_SHA }), BUILD_SHA)
  assert.equal(buildSha({ GML_BUILD_SHA: ' AbCdEf0123 ' }), 'abcdef0123')
  for (const bad of ['', '  ', 'not a sha', 'abc', 'g'.repeat(40), '0'.repeat(65)]) {
    assert.equal(buildSha({ GML_BUILD_SHA: bad }), null, JSON.stringify(bad))
  }
  const info = versionInfo({ GML_BUILD_SHA: BUILD_SHA })
  assert.deepEqual(Object.keys(info).sort(), ['build_sha', 'version'])
  assert.equal(info.version, PACKAGE_VERSION)
  assert.equal(info.build_sha, BUILD_SHA)
})

test('/api, /api/meta/health, the AI manifest and MCP serverInfo report one version and build SHA', { timeout: 180000 }, async t => {
  const { request } = await server(t, { GML_BUILD_SHA: BUILD_SHA })

  const root = await request('/api')
  assert.equal(root.status, 200)
  const rootData = (await root.json()).data
  assert.equal(rootData.version, PACKAGE_VERSION)
  assert.equal(rootData.build_sha, BUILD_SHA)

  const health = await request('/api/meta/health')
  assert.equal(health.status, 200)
  const healthData = (await health.json()).data
  assert.equal(healthData.status, 'ok')
  assert.equal(healthData.version, PACKAGE_VERSION)
  assert.equal(healthData.build_sha, BUILD_SHA)

  const manifest = await request('/api/ai/manifest')
  assert.equal(manifest.status, 200)
  const manifestData = (await manifest.json()).data
  assert.equal(manifestData.system.version, PACKAGE_VERSION)
  assert.equal(manifestData.system.build_sha, BUILD_SHA)

  const mcp = await request('/mcp', 'POST', { jsonrpc: '2.0', id: 1, method: 'initialize' })
  assert.equal(mcp.status, 200)
  const serverInfo = (await mcp.json()).result.serverInfo
  assert.equal(serverInfo.version, PACKAGE_VERSION)
  assert.equal(serverInfo.build_sha, BUILD_SHA)
})

test('mall order cancel returns the persisted status', { timeout: 180000 }, async t => {
  const { request, dir } = await server(t)
  const phone = `139${String(randomInt(0, 1e8)).padStart(8, '0')}`
  const login = await request('/api/mall/login', 'POST', { phone, code: '1234' })
  assert.equal(login.status, 200)
  const mallHeaders = { 'x-mall-token': (await login.json()).data.token }

  // Hand-built fixture rows only: an active H5 platform and one pending order owned by this session.
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  let platform = db.prepare("SELECT id FROM platforms WHERE code='H5' AND status='active'").get()?.id
  if (!platform) {
    platform = db.prepare("INSERT INTO platforms (code,name,type,status) VALUES ('H5','Version contract H5','self','active')").run().lastInsertRowid
  }
  const orderNo = `VC-${randomBytes(6).toString('hex')}`
  const orderId = Number(db.prepare(
    `INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,goods_amount,freight,pay_amount,receiver,receiver_phone,receiver_address)
     VALUES (?,?,?,datetime('now','localtime'),datetime('now','localtime'),'pending',100,0,100,'Version contract',?,'Contract street 1')`
  ).run(platform, orderNo, `会员${phone}`, phone).lastInsertRowid)

  const cancel = await request(`/api/mall/orders/${orderId}/cancel`, 'POST', {}, mallHeaders)
  assert.equal(cancel.status, 200)
  const result = await cancel.json()
  assert.equal(result.success, true)
  const persisted = db.prepare('SELECT status FROM oms_orders WHERE id=?').get(orderId).status
  assert.equal(persisted, 'cancelled')
  assert.equal(result.data.id, orderId)
  assert.equal(result.data.status, persisted, 'response status must be the persisted status, not a literal')

  const again = await request(`/api/mall/orders/${orderId}/cancel`, 'POST', {}, mallHeaders)
  assert.equal(again.status, 409)
  assert.equal(db.prepare('SELECT status FROM oms_orders WHERE id=?').get(orderId).status, 'cancelled')
})
