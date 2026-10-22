import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes, createHmac } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import net from 'node:net'
import http from 'node:http'
import Database from 'better-sqlite3'
import bcrypt from 'bcryptjs'
import { isBlockedAddress, validateOutboundUrl, resolveOutboundTarget, outboundRequest } from '../server/lib/outbound-url.js'
import { sealSecret, openSecret, isSealed, maskSecret, SEALED_PREFIX } from '../server/lib/secret-box.js'

// ADR-0008 notify hardening (F05 / F08 / F09).
// Every HTTP target in this file is a controlled listener on 127.0.0.1; no real external network calls.
// Production-mode servers must REJECT those loopback targets by policy; the positive send path runs
// on a GML_RUNTIME_MODE=test server, where the outbound policy explicitly allows loopback + http.

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const secret = () => randomBytes(24).toString('base64url')
const PROD = { GML_RUNTIME_MODE: 'production' }
const TEST = { GML_RUNTIME_MODE: 'test' }

async function freePort() {
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening')
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port
}

async function listener(t, handler) {
  const hits = []
  const srv = http.createServer((req, res) => {
    let body = ''
    req.on('data', c => { body += c })
    req.on('end', () => { hits.push({ url: req.url, headers: req.headers, body }); handler(req, res, body) })
  })
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  t.after(() => { srv.closeAllConnections(); return new Promise(resolve => srv.close(resolve)) })
  return { hits, url: `http://127.0.0.1:${srv.address().port}` }
}

function serverProcess(t, dir, env) {
  let child, stopped
  const stop = async () => { if (child && child.exitCode === null) child.kill('SIGTERM'); if (stopped) await stopped; child = null }
  t.after(async () => { await stop(); rmSync(dir, { recursive: true, force: true }) })
  return async (port) => {
    child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, env: { ...env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''; child.stdout.on('data', d => { output += d }); child.stderr.on('data', () => {})
    stopped = once(child, 'close')
    for (let i = 0; i < 1200 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
    assert.ok(output.includes('服务已启动'), `isolated ${env.GML_RUNTIME_MODE} server must become ready`)
  }
}

function caller(port) {
  return async (route, { token, body, method = body === undefined ? 'GET' : 'POST', headers = {} } = {}) => {
    const res = await fetch(`http://127.0.0.1:${port}${route}`, { method,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000) })
    return { status: res.status, body: await res.json() }
  }
}

/** Production fixture: bootstrap-admin owner, hand-built users through the account API. */
async function productionServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-notify-'))
  const password = secret(), jwtSecret = secret()
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', NODE_ENV: 'production',
    GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: jwtSecret }
  const bootstrap = spawnSync(process.execPath, ['scripts/bootstrap-admin.mjs', '--industry=cosmetic', '--company-code=NOTIFY',
    '--company-name=通知测试', '--username=owner', '--name=Owner'], { cwd: ROOT, env, input: password + '\n', encoding: 'utf8', timeout: 30000 })
  assert.equal(bootstrap.status, 0, bootstrap.stderr)
  const start = serverProcess(t, dir, env)
  const port = await freePort(); await start(port)
  const db = new Database(path.join(dir, 'gml_cosmetic.db')); t.after(() => db.close())
  const call = caller(port)
  const login = async (username = 'owner', pass = password) => {
    const r = await call('/api/auth/login', { body: { username, password: pass, industry: 'cosmetic' } })
    assert.equal(r.status, 200, r.body.message); return r.body.data.token
  }
  const admin = await login()
  const account = async (username, role, extra = {}) => {
    const pass = secret()
    const r = await call('/api/auth/users', { token: admin, body: { username, name: username, role, password: pass, ...extra } })
    assert.equal(r.status, 200, r.body.message)
    return { id: r.body.data.id, username, password: pass, token: await login(username, pass) }
  }
  return { dir, db, env, jwtSecret, call, login, admin, account }
}

/** Test-mode fixture: demo-seeded isolated data dir, hand-inserted administrator (no production seed commands). */
async function testModeServer(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-notify-test-'))
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', NODE_ENV: 'test',
    GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex') }
  const start = serverProcess(t, dir, env)
  const port = await freePort(); await start(port)
  const db = new Database(path.join(dir, 'gml_cosmetic.db')); t.after(() => db.close())
  const password = secret()
  db.prepare("INSERT INTO users (username,password_hash,name,role,is_super) VALUES (?,?,?,'admin',1)")
    .run('notify_admin', bcrypt.hashSync(password, 10), 'Notify test administrator')
  const call = caller(port)
  const login = await call('/api/auth/login', { body: { username: 'notify_admin', password, industry: 'cosmetic' } })
  assert.equal(login.status, 200, login.body.message)
  return { dir, db, env, call, admin: login.body.data.token }
}

const forbidden = (r, code) => { assert.equal(r.status, 403, JSON.stringify(r.body)); if (code) assert.equal(r.body.code, code) }
const okData = (r) => { assert.equal(r.status, 200, JSON.stringify(r.body)); return r.body.data }

// ---------------------------------------------------------------------------
// F08 unit: address classes, URL policy, DNS pinning
// ---------------------------------------------------------------------------

test('F08 address classification blocks loopback, private, link-local, multicast, unspecified and mapped ranges', () => {
  const blocked = ['127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254',
    '0.0.0.0', '0.1.2.3', '100.64.0.1', '224.0.0.1', '239.1.1.1', '240.0.0.1', '255.255.255.255', '192.0.0.1', '192.0.2.1',
    '198.18.0.1', '198.51.100.7', '203.0.113.9', '::1', '::', 'fe80::1', 'fc00::1', 'fd12:3456::1', 'ff02::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:c0a8:101', '64:ff9b::7f00:1', '64:ff9b::0a00:0001', '2001:db8::1', '::127.0.0.1']
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} must be blocked`)
  for (const ip of ['8.8.8.8', '1.1.1.1', '203.0.112.1', '2606:4700::1111', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isBlockedAddress(ip), false, `${ip} must be allowed`)
  }
  assert.equal(isBlockedAddress('not-an-ip'), true)
})

test('F08 production policy accepts only public https targets and the allowlist never widens it', () => {
  const reject = (url, env, code) => assert.throws(() => validateOutboundUrl(url, { env }), e => e.code === code, `${url} expected ${code}`)
  reject('http://open.feishu.cn/open-apis/bot/v2/hook/x', PROD, 'OUTBOUND_SCHEME')
  reject('ftp://open.feishu.cn/x', PROD, 'OUTBOUND_SCHEME')
  reject('not a url', PROD, 'OUTBOUND_URL_INVALID')
  reject('https://user:pw@open.feishu.cn/x', PROD, 'OUTBOUND_URL_INVALID')
  for (const url of ['https://localhost/x', 'https://LOCALHOST./x', 'https://api.localhost/x', 'https://127.0.0.1/x', 'https://[::1]/x',
    'https://10.1.2.3/x', 'https://169.254.169.254/latest/meta-data', 'https://[::ffff:127.0.0.1]/x', 'https://0x7f.1/x', 'https://2130706433/x', 'https://0/x']) {
    reject(url, PROD, 'OUTBOUND_PRIVATE_ADDRESS')
  }
  const accepted = validateOutboundUrl('https://open.feishu.cn/open-apis/bot/v2/hook/abc', { env: PROD })
  assert.equal(accepted.hostname, 'open.feishu.cn'); assert.equal(accepted.port, 443); assert.equal(accepted.protocol, 'https:')

  const allow = { ...PROD, GML_WEBHOOK_ALLOWED_HOSTS: ' oapi.dingtalk.com , 127.0.0.1, localhost ' }
  reject('https://open.feishu.cn/x', allow, 'OUTBOUND_HOST_NOT_ALLOWED')
  assert.equal(validateOutboundUrl('https://oapi.dingtalk.com/robot/send?access_token=x', { env: allow }).hostname, 'oapi.dingtalk.com')
  reject('https://127.0.0.1/x', allow, 'OUTBOUND_PRIVATE_ADDRESS')
  reject('https://localhost/x', allow, 'OUTBOUND_PRIVATE_ADDRESS')
  reject('http://oapi.dingtalk.com/robot/send', allow, 'OUTBOUND_SCHEME')

  for (const env of [TEST, { GML_RUNTIME_MODE: 'demo' }]) {
    const local = validateOutboundUrl('http://127.0.0.1:9/hook', { env })
    assert.equal(local.hostname, '127.0.0.1'); assert.equal(local.port, 9)
    reject('http://127.0.0.1:9/hook', { ...env, GML_WEBHOOK_ALLOWED_HOSTS: 'oapi.dingtalk.com' }, 'OUTBOUND_HOST_NOT_ALLOWED')
    reject('ftp://127.0.0.1/x', env, 'OUTBOUND_SCHEME')
  }
  assert.throws(() => validateOutboundUrl('https://open.feishu.cn/x', { env: { GML_RUNTIME_MODE: 'prod' } }), { code: 'RUNTIME_MODE_INVALID' })
})

test('F08 every DNS answer is checked before connecting and the chosen address is pinned', async () => {
  const lookup = (answers) => async () => answers
  await assert.rejects(resolveOutboundTarget('https://rebind.example/x', { env: PROD, lookup: lookup([{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }]) }), { code: 'OUTBOUND_PRIVATE_ADDRESS' })
  await assert.rejects(resolveOutboundTarget('https://rebind.example/x', { env: PROD, lookup: lookup([{ address: '::ffff:127.0.0.1', family: 6 }]) }), { code: 'OUTBOUND_PRIVATE_ADDRESS' })
  await assert.rejects(resolveOutboundTarget('https://rebind.example/x', { env: PROD, lookup: lookup([]) }), { code: 'OUTBOUND_DNS' })
  await assert.rejects(resolveOutboundTarget('https://rebind.example/x', { env: PROD, lookup: async () => { throw new Error('ENOTFOUND') } }), { code: 'OUTBOUND_DNS' })
  const target = await resolveOutboundTarget('https://hooks.example/x', { env: PROD, lookup: lookup([{ address: '93.184.216.34', family: 4 }]) })
  assert.equal(target.address, '93.184.216.34'); assert.equal(target.family, 4); assert.equal(target.hostname, 'hooks.example')
  let lookups = 0
  const literal = await resolveOutboundTarget('https://8.8.8.8/x', { env: PROD, lookup: async () => { lookups++; return [] } })
  assert.equal(literal.address, '8.8.8.8'); assert.equal(lookups, 0, 'IP literals are not resolved again')
  const local = await resolveOutboundTarget('http://127.0.0.1:9/x', { env: TEST })
  assert.equal(local.address, '127.0.0.1')
})

test('F08 outbound request refuses redirects, caps the body, enforces a total timeout, and production never connects', async t => {
  const big = 'x'.repeat(64 * 1024)
  const { hits, url } = await listener(t, (req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { Location: `${url}/ok` }); return res.end() }
    if (req.url === '/big') { res.writeHead(200, { 'Content-Type': 'text/plain' }); for (let i = 0; i < 40; i++) res.write(big); return res.end() }
    if (req.url === '/slow') { res.writeHead(200); res.write('{'); const timer = setInterval(() => res.write(' '), 50); res.on('close', () => clearInterval(timer)); return }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ code: 0, echo: req.headers['x-probe'] || null }))
  })
  const ok = await outboundRequest(`${url}/ok`, { env: TEST, method: 'POST', body: '{}', headers: { 'X-Probe': 'yes' } })
  assert.equal(ok.status, 200); assert.equal(JSON.parse(ok.bodyText).echo, 'yes'); assert.equal(hits.length, 1)
  await assert.rejects(outboundRequest(`${url}/redirect`, { env: TEST, method: 'POST', body: '{}' }), { code: 'OUTBOUND_REDIRECT' })
  assert.equal(hits.length, 2, 'the redirect target must not be fetched')
  await assert.rejects(outboundRequest(`${url}/big`, { env: TEST, method: 'POST', body: '{}', maxBodyBytes: 4096 }), { code: 'OUTBOUND_BODY_TOO_LARGE' })
  const started = Date.now()
  await assert.rejects(outboundRequest(`${url}/slow`, { env: TEST, method: 'POST', body: '{}', timeoutMs: 400 }), { code: 'OUTBOUND_TIMEOUT' })
  assert.ok(Date.now() - started < 5000, 'the deadline must cover body reading')
  const before = hits.length
  await assert.rejects(outboundRequest(`${url}/ok`, { env: PROD, method: 'POST', body: '{}' }), { code: 'OUTBOUND_SCHEME' })
  await assert.rejects(outboundRequest(`https://127.0.0.1:${new URL(url).port}/ok`, { env: PROD, method: 'POST', body: '{}' }), { code: 'OUTBOUND_PRIVATE_ADDRESS' })
  await assert.rejects(outboundRequest(`https://localhost:${new URL(url).port}/ok`, { env: PROD, method: 'POST', body: '{}' }), { code: 'OUTBOUND_PRIVATE_ADDRESS' })
  assert.equal(hits.length, before, 'production policy rejects loopback before any connection')
})

// ---------------------------------------------------------------------------
// F09 unit: secret box
// ---------------------------------------------------------------------------

test('F09 secret box seals with a versioned prefix, reads legacy plaintext, rejects tampering and rotates keys', () => {
  const keyA = { GML_SECRET_KEY: 'a'.repeat(32) }, keyB = { GML_SECRET_KEY: 'b'.repeat(32) }
  const sealed = sealSecret('top-secret-1234', keyA)
  assert.ok(sealed.startsWith(SEALED_PREFIX)); assert.ok(!sealed.includes('top-secret')); assert.equal(isSealed(sealed), true)
  assert.equal(openSecret(sealed, keyA), 'top-secret-1234')
  assert.notEqual(sealSecret('top-secret-1234', keyA), sealed, 'random IV per seal')
  assert.equal(openSecret('legacy-plaintext', keyA), 'legacy-plaintext'); assert.equal(isSealed('legacy-plaintext'), false)
  assert.equal(openSecret('', keyA), ''); assert.equal(openSecret(null, keyA), '')
  assert.throws(() => openSecret(sealed, keyB), { code: 'SECRET_BOX_UNREADABLE' })
  assert.equal(openSecret(sealed, { ...keyB, GML_SECRET_KEY_PREVIOUS: keyA.GML_SECRET_KEY }), 'top-secret-1234')
  const at = sealed.length - 10
  const tampered = sealed.slice(0, at) + (sealed[at] === 'A' ? 'B' : 'A') + sealed.slice(at + 1)
  assert.throws(() => openSecret(tampered, keyA), { code: 'SECRET_BOX_UNREADABLE' })
  assert.throws(() => openSecret(`${SEALED_PREFIX}garbage`, keyA), { code: 'SECRET_BOX_UNREADABLE' })
  const jwtOnly = { GML_JWT_SECRET: 'j'.repeat(40) }
  assert.equal(openSecret(sealSecret('from-jwt', jwtOnly), jwtOnly), 'from-jwt')
  assert.throws(() => openSecret(sealSecret('from-jwt', jwtOnly), keyA), { code: 'SECRET_BOX_UNREADABLE' })
  assert.throws(() => sealSecret('x', { GML_SECRET_KEY: 'short' }), { code: 'SECRET_BOX_KEY_WEAK' })
  assert.deepEqual(maskSecret('abcdefghijkl'), { has_secret: true, secret_last4: 'ijkl' })
  assert.deepEqual(maskSecret('abcdef'), { has_secret: true, secret_last4: null }, 'short secrets reveal nothing')
  assert.deepEqual(maskSecret(''), { has_secret: false, secret_last4: null })
})

// ---------------------------------------------------------------------------
// F05 / F08 / F09 on an isolated production server
// ---------------------------------------------------------------------------

test('F05 digest endpoints require an internal role, a notify permission and global data scope', { timeout: 120000 }, async t => {
  const f = await productionServer(t)
  const preview = okData(await f.call('/api/notify/preview', { token: f.admin }))
  assert.ok(preview.digest && Array.isArray(preview.digest.groups))
  const routes = ['/api/notify/preview', '/api/notify/overview', '/api/notify/logs']

  const storeId = Number(f.db.prepare("INSERT INTO stores (code,name) VALUES ('NS1','Notify store')").run().lastInsertRowid)
  const dealerId = Number(f.db.prepare("INSERT INTO dealers (code,name) VALUES ('ND1','Notify dealer')").run().lastInsertRowid)
  const store = await f.account('store_user', 'store', { store_id: storeId })
  const dealer = await f.account('dealer_user', 'dealer', { dealer_id: dealerId })
  for (const u of [store, dealer]) {
    for (const route of routes) forbidden(await f.call(route, { token: u.token }))
    forbidden(await f.call('/api/notify/push', { token: u.token, body: { dry_run: true } }))
    assert.equal((await f.call('/api/notify/meta', { token: u.token })).status, 200, 'metadata stays available')
  }

  // Built-in purchase role: has system:notify:push but only subtree data scope → fail closed.
  const purchase = await f.account('purchase_user', 'purchase')
  for (const route of routes) forbidden(await f.call(route, { token: purchase.token }), 'GLOBAL_DATA_FORBIDDEN')
  forbidden(await f.call('/api/notify/push', { token: purchase.token, body: { dry_run: true } }), 'GLOBAL_DATA_FORBIDDEN')

  // Same person granted explicit global data scope → digest allowed (gate is scope-based, not role-hardcoded).
  okData(await f.call(`/api/auth/users/${purchase.id}`, { token: f.admin, method: 'PUT', body: { data_scope: 'all' } }))
  const globalPurchase = await f.login(purchase.username, purchase.password)
  okData(await f.call('/api/notify/preview', { token: globalPurchase }))
  const dry = okData(await f.call('/api/notify/push', { token: globalPurchase, body: { dry_run: true } }))
  assert.ok(Array.isArray(dry.results))

  // Sales: no notify permission at all.
  const sales = await f.account('sales_user', 'sales', { data_scope: 'all' })
  for (const route of routes) forbidden(await f.call(route, { token: sales.token }))
  // Viewer: read permission + global scope → preview allowed, push still needs system:notify:push.
  const viewer = await f.account('viewer_user', 'viewer')
  okData(await f.call('/api/notify/preview', { token: viewer.token }))
  forbidden(await f.call('/api/notify/push', { token: viewer.token, body: { dry_run: true } }))
  assert.equal((await f.call('/api/notify/preview')).status, 401)
})

test('F09 channel secrets are never returned, are sealed at rest, and legacy plaintext is upgraded on write', { timeout: 120000 }, async t => {
  const f = await productionServer(t)
  const plain = 'top-secret-value-1234'
  const created = okData(await f.call('/api/notify/channels', { token: f.admin, body: { code: 'sec', name: '密钥渠道', provider: 'generic', webhook_url: 'https://hooks.example.com/x', secret: plain } }))
  assert.equal(created.secret, undefined); assert.equal(created.has_secret, true); assert.equal(created.secret_last4, '1234')
  const stored = () => f.db.prepare("SELECT secret FROM notify_channels WHERE code='sec'").get().secret
  assert.ok(stored().startsWith(SEALED_PREFIX)); assert.ok(!stored().includes(plain))
  const list = okData(await f.call('/api/notify/channels', { token: f.admin })).list
  assert.ok(list.length > 0); assert.ok(list.every(c => !('secret' in c)))
  assert.equal(list.find(c => c.code === 'sec').has_secret, true)
  for (const c of list) if (c.code !== 'sec') assert.equal(c.has_secret, false)

  const sealedBefore = stored()
  const kept = okData(await f.call('/api/notify/channels', { token: f.admin, body: { code: 'sec', remark: 'touch' } }))
  assert.equal(kept.has_secret, true); assert.equal(kept.secret, undefined); assert.equal(stored(), sealedBefore, 'omitting secret keeps it')
  const toggled = okData(await f.call(`/api/notify/channels/${created.id}/toggle`, { token: f.admin, method: 'POST', body: {} }))
  assert.equal(toggled.secret, undefined); assert.equal(toggled.has_secret, true)
  const cleared = okData(await f.call('/api/notify/channels', { token: f.admin, body: { code: 'sec', secret: '' } }))
  assert.equal(cleared.has_secret, false); assert.equal(stored(), '')

  f.db.prepare("UPDATE notify_channels SET secret='legacy-plain-9876' WHERE code='sec'").run()
  const legacy = okData(await f.call('/api/notify/channels', { token: f.admin })).list.find(c => c.code === 'sec')
  assert.equal(legacy.secret, undefined); assert.equal(legacy.has_secret, true); assert.equal(legacy.secret_last4, '9876')
  okData(await f.call('/api/notify/channels', { token: f.admin, body: { code: 'sec', name: 'renamed' } }))
  assert.ok(stored().startsWith(SEALED_PREFIX), 'next write re-seals legacy plaintext')
  assert.equal(openSecret(stored(), { GML_JWT_SECRET: f.jwtSecret }), 'legacy-plain-9876', 'key derives from the configured JWT secret')
  assert.throws(() => openSecret(stored(), { GML_JWT_SECRET: 'another' }), { code: 'SECRET_BOX_UNREADABLE' })
})

test('F08 channel URLs are validated on save and the push path refuses policy violations without connecting', { timeout: 120000 }, async t => {
  const f = await productionServer(t)
  const save = (webhook_url) => f.call('/api/notify/channels', { token: f.admin, body: { code: 'hook', name: '出站', provider: 'generic', webhook_url } })
  for (const [url, code] of [['http://127.0.0.1:1/hook', 'OUTBOUND_SCHEME'], ['https://localhost/hook', 'OUTBOUND_PRIVATE_ADDRESS'], ['https://10.0.0.1/hook', 'OUTBOUND_PRIVATE_ADDRESS'],
    ['https://[::1]/hook', 'OUTBOUND_PRIVATE_ADDRESS'], ['https://169.254.169.254/latest', 'OUTBOUND_PRIVATE_ADDRESS'], ['https://user:pw@hooks.example.com/x', 'OUTBOUND_URL_INVALID']]) {
    const r = await save(url)
    assert.equal(r.status, 400, url); assert.equal(r.body.detail?.code, code, url)
  }
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM notify_channels WHERE code='hook'").get().n, 0, 'rejected URLs are never stored')
  const saved = okData(await save('https://hooks.example.com/x'))
  assert.equal(saved.webhook_url, 'https://hooks.example.com/x')

  const { hits, url } = await listener(t, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"code":0}') })
  f.db.prepare("UPDATE notify_channels SET webhook_url=?, enabled=1 WHERE code='hook'").run(`${url}/hook`)
  const push = okData(await f.call('/api/notify/push', { token: f.admin, body: { channel_ids: [saved.id] } }))
  assert.equal(push.sent, 0); assert.equal(push.failed, 1)
  assert.equal(push.results[0].status, 'fail'); assert.match(String(push.results[0].error), /OUTBOUND_SCHEME|OUTBOUND_PRIVATE_ADDRESS/)
  assert.equal(hits.length, 0, 'policy violations never reach the socket')
  const log = f.db.prepare('SELECT status,error FROM notify_logs WHERE channel_id=? ORDER BY id DESC').get(saved.id)
  assert.equal(log.status, 'fail'); assert.match(log.error, /OUTBOUND_/)
  f.db.prepare("UPDATE notify_channels SET webhook_url=? WHERE code='hook'").run(`https://127.0.0.1:${new URL(url).port}/hook`)
  const again = okData(await f.call('/api/notify/push', { token: f.admin, body: { channel_ids: [saved.id] } }))
  assert.equal(again.results[0].status, 'fail'); assert.match(String(again.results[0].error), /OUTBOUND_PRIVATE_ADDRESS/)
  assert.equal(hits.length, 0)
})

// ---------------------------------------------------------------------------
// Positive send path on a test-mode server (policy allowance: http + loopback only in demo/test)
// ---------------------------------------------------------------------------

test('F08/F09 test mode: local listener receives signed payloads, redirects fail, logs never contain secrets', { timeout: 120000 }, async t => {
  const f = await testModeServer(t)
  const { hits, url } = await listener(t, (req, res) => {
    if (req.url.startsWith('/redirect')) { res.writeHead(302, { Location: `${url}/hook` }); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"code":0,"msg":"ok"}')
  })
  const channel = async (body) => okData(await f.call('/api/notify/channels', { token: f.admin, body }))
  const generic = await channel({ code: 'gen', name: 'generic', provider: 'generic', webhook_url: `${url}/hook`, secret: 'generic-secret-0001', enabled: 1 })
  const ding = await channel({ code: 'ding', name: 'dingtalk', provider: 'dingtalk', webhook_url: `${url}/hook?access_token=abc`, secret: 'ding-secret-0002', enabled: 1 })
  const feishu = await channel({ code: 'fs', name: 'feishu', provider: 'feishu', webhook_url: `${url}/hook`, secret: 'feishu-secret-0003', enabled: 1 })
  const redirect = await channel({ code: 'redir', name: 'redirect', provider: 'generic', webhook_url: `${url}/redirect`, enabled: 1 })
  for (const c of [generic, ding, feishu, redirect]) assert.equal(c.secret, undefined)

  const out = okData(await f.call('/api/notify/push', { token: f.admin, body: { channel_ids: [generic.id, ding.id, feishu.id, redirect.id] } }))
  const byCode = Object.fromEntries(out.results.map(r => [r.channel_code, r]))
  assert.equal(byCode.gen.status, 'success'); assert.equal(byCode.ding.status, 'success'); assert.equal(byCode.fs.status, 'success')
  assert.equal(byCode.redir.status, 'fail'); assert.match(String(byCode.redir.error), /OUTBOUND_REDIRECT/)
  assert.equal(out.sent, 3); assert.equal(out.failed, 1)
  assert.equal(hits.length, 4, 'three deliveries plus the refused redirect; its target was never followed')

  const genericHit = hits.find(h => h.headers['x-gml-signature'])
  assert.ok(genericHit, 'generic webhook carries an HMAC signature')
  const ts = genericHit.headers['x-gml-timestamp']
  assert.equal(genericHit.headers['x-gml-signature'], 'sha256=' + createHmac('sha256', 'generic-secret-0001').update(`${ts}.${genericHit.body}`).digest('hex'))
  assert.equal(genericHit.headers['content-type'], 'application/json')

  const dingHit = hits.find(h => h.url.includes('access_token=abc'))
  const q = new URL(dingHit.url, url).searchParams
  assert.ok(q.get('timestamp') && q.get('sign'))
  assert.equal(q.get('sign'), createHmac('sha256', 'ding-secret-0002').update(`${q.get('timestamp')}\nding-secret-0002`).digest('base64'))

  const fsHit = hits.find(h => h.body.includes('"msg_type":"interactive"'))
  const fsBody = JSON.parse(fsHit.body)
  assert.ok(fsBody.timestamp && fsBody.sign)
  assert.equal(fsBody.sign, createHmac('sha256', `${fsBody.timestamp}\nfeishu-secret-0003`).update('').digest('base64'))

  const logs = f.db.prepare('SELECT payload,error FROM notify_logs').all()
  for (const row of logs) for (const s of ['generic-secret-0001', 'ding-secret-0002', 'feishu-secret-0003']) assert.ok(!String(row.payload || '').includes(s) && !String(row.error || '').includes(s))
  for (const row of f.db.prepare('SELECT secret FROM notify_channels WHERE secret<>\'\'').all()) assert.ok(row.secret.startsWith(SEALED_PREFIX))
  const logged = okData(await f.call('/api/notify/logs', { token: f.admin }))
  assert.ok(logged.total >= 4)
})
