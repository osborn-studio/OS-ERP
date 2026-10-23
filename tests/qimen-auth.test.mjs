/**
 * ============================================================================
 * 文件标识：tests/qimen-auth.test.mjs ｜ 测试：奇门网关每平台密钥、HMAC 签名、时间窗、nonce 防重放、能力清单权限（ADR-0033）
 * ============================================================================
 * 【职责】守住 Y3：
 *   · 迁移 060 可重复执行、verify 通过；平台密钥只以 `enc:v1:` 封存值落库，签发响应是明文唯一出现处；
 *   · 签发/轮换需要 `oms.platform.manage`（非管理员 403、匿名 401）；已有密钥不带 rotate ⇒ 409；轮换后旧密钥立即失效；
 *   · 网关：独立密钥 HMAC 通过；公开演示常量 / 旧 MD5 / 明文落库值 / 他平台密钥 / 篡改 request / 过期或未来时间戳 / 坏 nonce / 重放 一律 401；
 *   · `/capabilities` 要求管理权限且任何读接口（capabilities、/oms/platforms、/master/platforms）、同步日志、审计都不含密钥或封存值；
 *   · 通用主数据接口不能写封存列。
 * 【夹具口径】同 authz-misc.test.mjs：test 运行时、临时数据目录、随机回环端口，签名在测试里按契约独立实现（不调被测函数）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, createHmac, randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const require = createRequire(import.meta.url)
const rnd = () => randomBytes(24).toString('base64url')

// ---- 契约的独立实现（刻意不引用 server/lib/qimen-auth.js 的 signQimen）----
const canon = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`
}
const signWith = (secret, { appKey, method, timestamp, nonce, request = {} }) =>
  createHmac('sha256', secret)
    .update([appKey, method, timestamp, nonce, createHash('sha256').update(canon(request)).digest('hex')].join('\n'))
    .digest('hex').toUpperCase()
const md5 = (s) => createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

async function server(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-qimen-auth-'))
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const env = {
    PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: String(port),
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', (d) => { output += d })
  child.stderr.on('data', (d) => { output += d })
  const stopped = once(child, 'close')
  t.after(async () => {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
    rmSync(dir, { recursive: true, force: true })
  })
  for (let i = 0; i < 2400 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
  assert.ok(output.includes('服务已启动'), `test-mode server must become ready:\n${output.slice(-2000)}`)
  const base = `http://127.0.0.1:${port}`
  const api = async (route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const res = await fetch(`${base}${route}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000)
    })
    const text = await res.text()
    return { status: res.status, text, body: JSON.parse(text), headers: res.headers }
  }
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  t.after(() => db.close())
  const login = async (username, password) => {
    const r = await api('/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
    assert.equal(r.status, 200, r.text)
    return r.body.data.token
  }
  const admin = await login('admin', '12345')
  const account = async (username, role, extra = {}) => {
    const password = rnd()
    const r = await api('/api/auth/users', { token: admin, body: { username, name: username, role, password, ...extra } })
    assert.equal(r.status, 200, r.text)
    return { id: r.body.data.id, username, password, token: await login(username, password) }
  }
  return { dir, api, db, admin, login, account }
}

/** 两个 active 平台，保证有 app_key */
function twoPlatforms(db) {
  const rows = db.prepare("SELECT id, app_key FROM platforms WHERE app_key IS NOT NULL AND app_key<>'' AND status='active' ORDER BY id LIMIT 2").all()
  assert.equal(rows.length, 2)
  return rows
}

const METHOD = 'taobao.qimen.itemmapping.query'
let seq = 0
const stamp = (over = {}) => ({ timestamp: String(Date.now()), nonce: `n${Date.now()}${seq++}${rnd()}`.slice(0, 40), ...over })

function gatewayBody(secret, platform, { method = METHOD, request = { itemCode: 'X' }, ...over } = {}) {
  const s = stamp(over)
  return { method, app_key: platform.app_key, timestamp: s.timestamp, nonce: s.nonce, request, sign: signWith(secret, { appKey: platform.app_key, method, request, ...s }) }
}

test('migration 060 is idempotent, verifies, and platforms start without a secret', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const m060 = require('../server/db/migrations/060_qimen_secrets.cjs')
  assert.equal(m060.verify(f.db), true)
  m060.up(f.db)
  m060.up(f.db)
  assert.equal(m060.verify(f.db), true)
  const cols = f.db.prepare('PRAGMA table_info(platforms)').all().map((c) => c.name)
  assert.ok(cols.includes('app_secret_sealed') && cols.includes('app_secret_rotated_at'))
  assert.equal(f.db.prepare("SELECT COUNT(*) c FROM platforms WHERE app_secret_sealed IS NOT NULL").get().c, 0, 'no platform gets a secret implicitly')
  assert.ok(f.db.prepare("SELECT 1 FROM permissions WHERE code='oms.platform.manage'").get())
  assert.ok(f.db.prepare("SELECT 1 FROM role_permissions WHERE role_code='admin' AND perm_code='oms.platform.manage'").get())
  assert.equal(f.db.prepare("SELECT COUNT(*) c FROM role_permissions WHERE perm_code='oms.platform.manage' AND role_code<>'admin'").get().c, 0)
  assert.ok(f.db.prepare("SELECT 1 FROM schema_migrations WHERE id LIKE '060_%'").get())
  // 一次性授权：管理员收回后，verify 不会因此失败（ADR-0007）
  f.db.prepare("DELETE FROM role_permissions WHERE role_code='admin' AND perm_code='oms.platform.manage'").run()
  assert.equal(m060.verify(f.db), true)
})

test('canonical contract: key order does not matter, content does', () => {
  const a = signWith('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n', request: { b: 1, a: { d: [1, 2], c: 'x' } } })
  const b = signWith('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n', request: { a: { c: 'x', d: [1, 2] }, b: 1 } })
  assert.equal(a, b)
  assert.notEqual(a, signWith('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n', request: { b: 2, a: { d: [1, 2], c: 'x' } } }))
  return import('../server/lib/qimen-auth.js').then(({ signQimen }) => {
    // 服务端实现与测试里的独立实现一致（含缺省 request = {}）
    assert.equal(signQimen('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n', request: { b: 1, a: { d: [1, 2], c: 'x' } } }), a)
    assert.equal(signQimen('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n' }), signWith('s', { appKey: 'k', method: 'm', timestamp: '1', nonce: 'n', request: {} }))
  })
})

test('issue and rotate: permission, once-only plaintext, sealed storage, immediate invalidation', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const [pf, other] = twoPlatforms(db)
  const sales = await f.account('qa_sales', 'sales', { data_scope: 'all' })
  const url = (id) => `/api/qimen/platforms/${id}/secret`

  assert.equal((await api(url(pf.id), { body: {} })).status, 401)
  assert.equal((await api(url(pf.id), { token: sales.token, body: {} })).status, 403)
  assert.equal(db.prepare('SELECT app_secret_sealed s FROM platforms WHERE id=?').get(pf.id).s, null)
  assert.equal((await api(url(0), { token: f.admin, body: {} })).status, 400)
  assert.equal((await api(url(999999), { token: f.admin, body: {} })).status, 404)

  const first = await api(url(pf.id), { token: f.admin, body: {} })
  assert.equal(first.status, 200, first.text)
  assert.equal(first.headers.get('cache-control'), 'no-store')
  const s1 = first.body.data.secret
  assert.match(s1, /^qsk_[0-9a-f]{64}$/)
  assert.equal(first.body.data.rotated, false)
  const stored = db.prepare('SELECT app_secret_sealed s, app_secret_rotated_at r, app_secret_masked m FROM platforms WHERE id=?').get(pf.id)
  assert.ok(stored.s.startsWith('enc:v1:'))
  assert.ok(!stored.s.includes(s1))
  assert.ok(stored.r)
  assert.equal(stored.m, `****${s1.slice(-4)}`)

  // 再点一次不带 rotate：409，旧密钥不变
  const dup = await api(url(pf.id), { token: f.admin, body: {} })
  assert.equal(dup.status, 409, dup.text)
  assert.equal(dup.body.error, 'QIMEN_SECRET_EXISTS')
  assert.ok(!dup.text.includes(s1))
  assert.equal((await api('/api/qimen', { body: gatewayBody(s1, pf) })).status, 200)

  const rot = await api(url(pf.id), { token: f.admin, body: { rotate: true } })
  assert.equal(rot.status, 200, rot.text)
  assert.equal(rot.body.data.rotated, true)
  const s2 = rot.body.data.secret
  assert.notEqual(s1, s2)
  assert.equal((await api('/api/qimen', { body: gatewayBody(s1, pf) })).status, 401, 'old secret dies immediately')
  assert.equal((await api('/api/qimen', { body: gatewayBody(s2, pf) })).status, 200)
  // 他平台未签发：凭据未签发 1005
  const none = await api('/api/qimen', { body: gatewayBody(s2, other) })
  assert.equal(none.status, 401)
  assert.equal(none.body.code, '1005')

  // 审计与同步日志都不含密钥/封存值/签名
  const audits = JSON.stringify(db.prepare("SELECT * FROM audit_logs WHERE action LIKE 'QIMEN_SECRET_%'").all())
  assert.ok(audits.includes('QIMEN_SECRET_ISSUE') && audits.includes('QIMEN_SECRET_ROTATE'))
  const logs = JSON.stringify(db.prepare('SELECT * FROM oms_sync_logs').all())
  const everything = audits + logs + JSON.stringify(db.prepare('SELECT * FROM audit_logs').all())
  for (const needle of [s1, s2, 'enc:v1:']) assert.ok(!everything.includes(needle), `secret material leaked into logs: ${needle.slice(0, 10)}`)
  assert.ok(!logs.includes('"sign"'))
})

test('gateway verifies per-platform HMAC, time window and replay', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const [pf, other] = twoPlatforms(db)
  const issue = async (p) => (await api(`/api/qimen/platforms/${p.id}/secret`, { token: f.admin, body: {} })).body.data.secret
  const s1 = await issue(pf)
  const s2 = await issue(other)
  const gw = (body) => api('/api/qimen', { body })
  const rejected = async (body, code, why) => {
    const r = await gw(body)
    assert.equal(r.status, 401, `${why}: ${r.text}`)
    assert.equal(r.body.success, false)
    assert.equal(r.body.code, code, why)
    assert.equal(r.body.mappings, undefined, why)
  }

  const good = gatewayBody(s1, pf)
  const ok1 = await gw(good)
  assert.equal(ok1.status, 200, ok1.text)
  assert.equal(ok1.body.success, true)
  await rejected(good, '1008', 'exact replay')
  // 同 nonce 换新签名也不行（nonce 已被占用）
  const again = { ...gatewayBody(s1, pf, { nonce: good.nonce }) }
  await rejected(again, '1008', 'reused nonce with fresh signature')
  // 同 nonce 在另一个平台是另一把锁
  assert.equal((await gw(gatewayBody(s2, other, { nonce: good.nonce }))).status, 200)

  await rejected({ ...gatewayBody(s1, pf), request: { itemCode: 'TAMPERED' } }, '1004', 'tampered request')
  await rejected({ ...gatewayBody(s1, pf), method: 'taobao.qimen.inventory.query' }, '1004', 'method swapped')
  await rejected(gatewayBody(s2, pf), '1004', "other platform's secret")
  await rejected(gatewayBody('GML-DEMO-SECRET', pf), '1004', 'public demo constant as secret')
  const legacy = { method: METHOD, request: {}, app_key: pf.app_key, ...stamp(), sign: md5(`${pf.app_key}${METHOD}GML-DEMO-SECRET`) }
  await rejected(legacy, '1004', 'legacy md5 signature')
  await rejected({ method: METHOD, request: {}, app_key: pf.app_key, sign: md5(`${pf.app_key}${METHOD}GML-DEMO-SECRET`) }, '1006', 'legacy body without timestamp')
  await rejected(gatewayBody(s1, pf, { timestamp: String(Date.now() - 5 * 60 * 1000 - 5000) }), '1006', 'stale timestamp')
  await rejected(gatewayBody(s1, pf, { timestamp: String(Date.now() + 5 * 60 * 1000 + 5000) }), '1006', 'future timestamp')
  await rejected(gatewayBody(s1, pf, { timestamp: '12345' }), '1006', 'malformed timestamp')
  await rejected(gatewayBody(s1, pf, { nonce: 'short' }), '1007', 'short nonce')
  await rejected(gatewayBody(s1, pf, { nonce: 'bad nonce with spaces!!' }), '1007', 'bad nonce charset')
  await rejected({ ...gatewayBody(s1, pf), sign: undefined }, '1004', 'missing sign')
  // 窗口边缘以内仍然通过
  assert.equal((await gw(gatewayBody(s1, pf, { timestamp: String(Date.now() - 4 * 60 * 1000) }))).status, 200)
  assert.equal((await gw(gatewayBody(s1, pf, { timestamp: String(Date.now() + 4 * 60 * 1000) }))).status, 200)
  // 签名使用小写十六进制也接受（比较大小写不敏感），但内容必须对
  const lower = gatewayBody(s1, pf)
  assert.equal((await gw({ ...lower, sign: lower.sign.toLowerCase() })).status, 200)

  // 失败的请求不占用 nonce：同一 nonce 用正确签名还能通过
  const nonce = `n-keep-${rnd()}`.slice(0, 30)
  await rejected({ ...gatewayBody(s1, pf, { nonce }), sign: 'DEADBEEF' }, '1004', 'bad sign does not burn nonce')
  assert.equal((await gw(gatewayBody(s1, pf, { nonce }))).status, 200)

  // 明文落库（例如被人绕过 API 直写）不被信任：必须是封存值
  db.prepare('UPDATE platforms SET app_secret_sealed=? WHERE id=?').run('plain-text-secret', pf.id)
  const plain = await gw(gatewayBody('plain-text-secret', pf))
  assert.equal(plain.status, 401)
  assert.equal(plain.body.code, '1005')
  // 停用平台不再通过
  db.prepare("UPDATE platforms SET status='disabled' WHERE id=?").run(other.id)
  await rejected(gatewayBody(s2, other), '1003', 'disabled platform')
})

test('nonce table is pruned on accept and survives as the replay authority', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const [pf] = twoPlatforms(db)
  const s = (await api(`/api/qimen/platforms/${pf.id}/secret`, { token: f.admin, body: {} })).body.data.secret
  db.prepare('INSERT INTO qimen_nonces (platform_id, nonce, seen_at) VALUES (?,?,?)').run(pf.id, 'old-nonce-0000000000', Date.now() - 12 * 60 * 1000)
  db.prepare('INSERT INTO qimen_nonces (platform_id, nonce, seen_at) VALUES (?,?,?)').run(pf.id, 'recent-nonce-00000000', Date.now() - 6 * 60 * 1000)
  assert.equal((await api('/api/qimen', { body: gatewayBody(s, pf) })).status, 200)
  const rows = db.prepare('SELECT nonce FROM qimen_nonces WHERE platform_id=?').all(pf.id).map((r) => r.nonce)
  assert.ok(!rows.includes('old-nonce-0000000000'))
  assert.ok(rows.includes('recent-nonce-00000000'), 'inside the retention window stays')
  assert.equal(rows.length, 2)
})

test('capabilities needs the manage permission and no read surface exposes secret material', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const [pf] = twoPlatforms(db)
  const sales = await f.account('qc_sales', 'sales', { data_scope: 'all' })
  const secret = (await api(`/api/qimen/platforms/${pf.id}/secret`, { token: f.admin, body: {} })).body.data.secret
  const sealed = db.prepare('SELECT app_secret_sealed s FROM platforms WHERE id=?').get(pf.id).s

  assert.equal((await api('/api/qimen/capabilities')).status, 401)
  assert.equal((await api('/api/qimen/capabilities', { token: sales.token })).status, 403)
  const cap = await api('/api/qimen/capabilities', { token: f.admin })
  assert.equal(cap.status, 200, cap.text)
  assert.ok(!/GML-DEMO-SECRET/.test(cap.text), 'demo constant is gone')
  const row = cap.body.data.platforms.find((p) => p.id === pf.id)
  assert.equal(row.app_key, pf.app_key)
  assert.equal(row.has_secret, 1)
  assert.equal(Object.keys(row).filter((k) => /secret/i.test(k)).sort().join(), 'has_secret,secret_rotated_at')

  // 授予后管理权限的非管理员可读（权限点是唯一判据）
  db.prepare("INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES ('sales','oms.platform.manage')").run()
  assert.equal((await api('/api/qimen/capabilities', { token: sales.token })).status, 200)
  db.prepare("DELETE FROM role_permissions WHERE role_code='sales' AND perm_code='oms.platform.manage'").run()
  assert.equal((await api('/api/qimen/capabilities', { token: sales.token })).status, 403)

  for (const route of ['/api/oms/platforms', '/api/master/platforms?all=1', `/api/master/platforms/${pf.id}`, '/api/qimen/capabilities']) {
    const r = await api(route, { token: f.admin })
    assert.equal(r.status, 200, route)
    assert.ok(!r.text.includes(secret), `${route} leaks the secret`)
    assert.ok(!r.text.includes(sealed), `${route} leaks the sealed value`)
    assert.ok(!r.text.includes('app_secret_sealed'), `${route} exposes the sealed column`)
  }
  const list = await api('/api/oms/platforms', { token: f.admin })
  const mine = list.body.data.find((p) => p.id === pf.id)
  assert.equal(mine.has_secret, true)
  assert.ok(mine.secret_rotated_at)

  // 通用主数据接口不能写封存列，也不能按它过滤
  const put = await api(`/api/master/platforms/${pf.id}`, { token: f.admin, method: 'PUT', body: { app_secret_sealed: 'enc:v1:x', app_secret_rotated_at: '2000-01-01', app_secret_masked: 'hacked', remark: 'ok' } })
  assert.equal(put.status, 200, put.text)
  const after = db.prepare('SELECT app_secret_sealed s, app_secret_rotated_at r, app_secret_masked m, remark FROM platforms WHERE id=?').get(pf.id)
  assert.equal(after.s, sealed)
  assert.notEqual(after.r, '2000-01-01')
  assert.notEqual(after.m, 'hacked')
  assert.equal(after.remark, 'ok')
  const created = await api('/api/master/platforms', { token: f.admin, body: { code: 'QZ9', name: 'Q9', app_key: 'qz9-key', app_secret_sealed: 'plain' } })
  assert.equal(created.status, 200, created.text)
  assert.equal(db.prepare("SELECT app_secret_sealed s FROM platforms WHERE code='QZ9'").get().s, null)
})

test('warehouse binding and protocol errors still work behind the new signature', { timeout: 300000 }, async (t) => {
  const f = await server(t)
  const { api, db } = f
  const [pf] = twoPlatforms(db)
  const s = (await api(`/api/qimen/platforms/${pf.id}/secret`, { token: f.admin, body: {} })).body.data.secret
  const whRows = db.prepare('SELECT id, code FROM warehouses ORDER BY id LIMIT 2').all()
  db.prepare('UPDATE platforms SET warehouse_id=? WHERE id=?').run(whRows[0].id, pf.id)
  const inv = async (request) => (await api('/api/qimen', { body: gatewayBody(s, pf, { method: 'taobao.qimen.inventory.query', request }) })).body
  assert.deepEqual((await inv({ warehouseCode: whRows[1].code })).items, [])
  assert.equal((await inv({})).warehouseCode, whRows[0].code)
  const unknown = await api('/api/qimen', { body: gatewayBody(s, pf, { method: 'bogus.method', request: {} }) })
  assert.equal(unknown.status, 200)
  assert.equal(unknown.body.code, '1002')
})

test('front-end debug signer (src/utils/qimen-sign.ts) matches the server contract byte for byte', async () => {
  const src = readFileSync(fileURLToPath(new URL('../src/utils/qimen-sign.ts', import.meta.url)), 'utf8')
  const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
  const { signQimen: clientSign, canonicalJson, newNonce } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
  const { signQimen: serverSign, canonicalJson: serverCanon } = await import('../server/lib/qimen-auth.js')
  const request = { z: [3, { b: '中文', a: null }], a: { y: 1.5, x: true }, n: undefined }
  const parts = { appKey: 'ak', method: METHOD, timestamp: '1700000000000', nonce: 'abcdefabcdefabcd', request }
  assert.equal(canonicalJson(request), serverCanon(request))
  assert.equal(await clientSign('qsk_test', parts), serverSign('qsk_test', parts))
  assert.equal(await clientSign('qsk_test', parts), signWith('qsk_test', { ...parts, request: { z: [3, { b: '中文', a: null }], a: { y: 1.5, x: true } } }))
  assert.match(newNonce(), /^[0-9a-f]{32}$/)
})
