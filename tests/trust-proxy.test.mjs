import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import express from 'express'
import { parseTrustProxy, trustProxyFn, isTrustedPeer, assertTrustProxyConfig } from '../server/lib/trust-proxy.js'
import { requestLogger } from '../server/lib/logger.js'
import { securityHeaders } from '../server/middleware/security-headers.js'
import { issueSessionCookies } from '../server/middleware/session-transport.js'
import { consumeLoginAttempt } from '../server/lib/login-throttle.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const trusts = (value, ip) => parseTrustProxy(value).fn(ip)
const bad = (value) => assert.throws(() => parseTrustProxy(value), (e) => e.code === 'TRUST_PROXY_INVALID', `expected invalid: ${JSON.stringify(value)}`)

test('parser: off is the default and trusts nothing', () => {
  for (const v of [undefined, '', '  ', 'off', 'OFF']) {
    const p = parseTrustProxy(v)
    assert.equal(p.mode, 'off')
    assert.equal(p.fn('127.0.0.1'), false)
    assert.equal(p.fn('::1'), false)
  }
})

test('parser: loopback trusts only 127/8 and ::1 (including mapped forms)', () => {
  assert.equal(parseTrustProxy('Loopback').mode, 'loopback')
  for (const ip of ['127.0.0.1', '127.9.9.9', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '0:0:0:0:0:0:0:1']) assert.equal(trusts('loopback', ip), true, ip)
  for (const ip of ['10.0.0.1', '::2', '::ffff:10.0.0.1', '128.0.0.1']) assert.equal(trusts('loopback', ip), false, ip)
})

test('parser: IPv4 / IPv6 CIDR lists, bare hosts, whitespace', () => {
  const v = ' 10.0.0.0/8 , 192.168.1.5, 2001:db8::/32 ,fd00::1/128 '
  assert.equal(parseTrustProxy(v).mode, 'cidr')
  for (const ip of ['10.255.255.255', '192.168.1.5', '2001:db8:ffff::1', 'fd00::1']) assert.equal(trusts(v, ip), true, ip)
  for (const ip of ['11.0.0.1', '192.168.1.6', '2001:db9::1', 'fd00::2', '127.0.0.1']) assert.equal(trusts(v, ip), false, ip)
  assert.equal(trusts('10.1.2.0/24', '10.1.2.255'), true)
  assert.equal(trusts('10.1.2.0/24', '10.1.3.0'), false)
  assert.equal(trusts('10.1.2.0/25', '10.1.2.128'), false)
})

test('parser: IPv4-mapped IPv6 peers match IPv4 CIDRs, and mapped CIDRs fold to IPv4', () => {
  assert.equal(trusts('10.0.0.0/8', '::ffff:10.1.2.3'), true)
  assert.equal(trusts('10.0.0.0/8', '::ffff:0a01:0203'), true)
  assert.equal(trusts('10.0.0.0/8', '::ffff:11.1.2.3'), false)
  assert.equal(trusts('::ffff:10.0.0.0/104', '10.9.9.9'), true)
  assert.equal(trusts('::ffff:10.0.0.0/104', '11.9.9.9'), false)
  assert.equal(trusts('0:0:0:0:0:ffff:10.0.0.0/104', '10.9.9.9'), true, 'expanded mapped spelling folds identically')
  assert.equal(trusts('0:0:0:0:0:ffff:10.0.0.0/104', '11.9.9.9'), false)
  // a v6 rule never matches v4 and vice versa
  assert.equal(trusts('2001:db8::/32', '10.0.0.1'), false)
})

test('parser: peer values that are not clean IPs are never trusted (zone ids, garbage, non-strings)', () => {
  const v = '10.0.0.0/8,fe80::/10'
  for (const ip of ['fe80::1%en0', '10.0.0.1%eth0', 'unknown', '', '10.0.0.1, 10.0.0.2', '10.0.0.256', '1e1.0.0.1', '010.0.0.1x', undefined, null, 123, {}, 'x'.repeat(200)]) assert.equal(trusts(v, ip), false, String(ip))
})

test('parser: invalid configuration fails with TRUST_PROXY_INVALID', () => {
  for (const v of ['true', 'false', '1', '2', '*', 'yes', 'loopback,10.0.0.0/8', 'off,10.0.0.0/8', '10.0.0.0/8,', ',10.0.0.0/8', '10.0.0.0/33', '10.0.0.0/-1', '10.0.0.0/8/8',
    '10.0.0.0/abc', '10.0.0.0/', '2001:db8::/129', '0.0.0.0/0', '::/0', '10.0.0.0/0', 'fe80::1%eth0/64', 'fe80::1%eth0', '300.0.0.0/8', 'example.com', '10.0.0/8',
    '::ffff:10.0.0.0/64', '::ffff:10.0.0.0/129', '0:0:0:0:0:ffff:10.1.2.3/8', '0:0:0:0:0:ffff:a01:203/95', '::FFFF:10.0.0.0/8', Array.from({ length: 65 }, (_, i) => `10.0.${i}.0/24`).join(','), 5, {}]) bad(v)
})

test('parser: legacy-looking truthy values do not silently trust everything', () => {
  // Express would treat "true" as trust-all; we refuse it instead.
  bad('true')
  bad('loopback, linklocal, uniquelocal')
})

test('trustProxyFn / assertTrustProxyConfig read GML_TRUST_PROXY live', (t) => {
  const prev = process.env.GML_TRUST_PROXY
  t.after(() => { if (prev === undefined) delete process.env.GML_TRUST_PROXY; else process.env.GML_TRUST_PROXY = prev })
  delete process.env.GML_TRUST_PROXY
  assert.equal(assertTrustProxyConfig(), 'off')
  assert.equal(trustProxyFn('127.0.0.1'), false)
  process.env.GML_TRUST_PROXY = 'loopback'
  assert.equal(trustProxyFn('127.0.0.1'), true)
  process.env.GML_TRUST_PROXY = '203.0.113.0/24'
  assert.equal(trustProxyFn('127.0.0.1'), false)
  process.env.GML_TRUST_PROXY = 'bogus'
  assert.throws(() => assertTrustProxyConfig(), { code: 'TRUST_PROXY_INVALID' })
})

// ------------------------------------------------------------------ in-process wiring (same wiring as server/index.js)
async function serve(t, trustValue, { cookieEnv = {} } = {}) {
  const prev = process.env.GML_TRUST_PROXY
  if (trustValue === undefined) delete process.env.GML_TRUST_PROXY; else process.env.GML_TRUST_PROXY = trustValue
  t.after(() => { if (prev === undefined) delete process.env.GML_TRUST_PROXY; else process.env.GML_TRUST_PROXY = prev })
  const app = express()
  app.set('trust proxy', trustProxyFn)
  app.use(requestLogger)
  app.use(securityHeaders({ env: { GML_RUNTIME_MODE: 'test' } }))
  app.get('/probe', (req, res) => {
    issueSessionCookies(req, res, 'jwt', 'secret', { GML_SESSION_TRANSPORT: 'cookie', ...cookieEnv })
    res.json({ ip: req.ip, secure: req.secure, protocol: req.protocol, trusted: isTrustedPeer(req), reqId: res.getHeader('x-request-id') })
  })
  app.post('/login/:user', (req, res) => {
    try { consumeLoginAttempt({ industry: 'retail', username: req.params.user, ip: req.ip }); res.json({ ok: 1, ip: req.ip }) } catch (e) { res.status(e.status || 500).json({ code: e.code }) }
  })
  const srv = app.listen(0, '127.0.0.1')
  await once(srv, 'listening')
  t.after(() => srv.close())
  return `http://127.0.0.1:${srv.address().port}`
}
const spoof = { 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https', 'x-request-id': 'spoofed-request-id-1' }
const probe = async (base, headers) => {
  const r = await fetch(`${base}/probe`, { headers })
  return { body: await r.json(), hsts: r.headers.get('strict-transport-security'), cookies: r.headers.getSetCookie() }
}

test('off: spoofed X-Forwarded-For / -Proto / X-Request-Id are ignored; no HSTS, cookies not Secure', async (t) => {
  const base = await serve(t, undefined)
  const r = await probe(base, spoof)
  assert.equal(r.body.trusted, false)
  assert.match(r.body.ip, /127\.0\.0\.1$/)
  assert.equal(r.body.secure, false)
  assert.equal(r.body.protocol, 'http')
  assert.notEqual(r.body.reqId, 'spoofed-request-id-1')
  assert.equal(r.hsts, null)
  assert.ok(r.cookies.length >= 2 && r.cookies.every(c => !/;\s*secure/i.test(c)), r.cookies.join('|'))
})

test('loopback: headers from the loopback peer are honoured (client IP, https, HSTS, Secure cookies, request id)', async (t) => {
  const base = await serve(t, 'loopback')
  const r = await probe(base, spoof)
  assert.equal(r.body.trusted, true)
  assert.equal(r.body.ip, '198.51.100.7')
  assert.equal(r.body.secure, true)
  assert.equal(r.body.reqId, 'spoofed-request-id-1')
  assert.match(r.hsts, /max-age=/)
  assert.ok(r.cookies.length >= 2 && r.cookies.every(c => /;\s*secure/i.test(c)), r.cookies.join('|'))
  const http = await probe(base, { 'x-forwarded-proto': 'http' })
  assert.equal(http.hsts, null)
  assert.ok(http.cookies.every(c => !/;\s*secure/i.test(c)))
})

test('CIDR not covering the peer behaves like off; CIDR covering the peer (incl. mapped/v6 loopback rules) honours headers', async (t) => {
  const miss = await probe(await serve(t, '203.0.113.0/24,2001:db8::/32'), spoof)
  assert.equal(miss.body.trusted, false)
  assert.match(miss.body.ip, /127\.0\.0\.1$/)
  assert.equal(miss.hsts, null)
  const hit = await probe(await serve(t, '10.0.0.0/8,127.0.0.0/8'), spoof)
  assert.equal(hit.body.trusted, true)
  assert.equal(hit.body.ip, '198.51.100.7')
  assert.ok(hit.hsts)
})

test('trusted peer: X-Forwarded-For chain is walked from the right; leftmost forged hops are not the client', async (t) => {
  const base = await serve(t, '127.0.0.0/8,198.51.100.0/24')
  // client forged "1.2.3.4"; our proxy appended the real peer 203.0.113.9; 198.51.100.7 is another trusted proxy
  const r = await probe(base, { 'x-forwarded-for': '1.2.3.4, 203.0.113.9, 198.51.100.7' })
  assert.equal(r.body.ip, '203.0.113.9')
})

test('GML_COOKIE_SECURE=always still forces Secure under off, but never forces HSTS', async (t) => {
  const r = await probe(await serve(t, undefined, { cookieEnv: { GML_COOKIE_SECURE: 'always' } }), spoof)
  assert.ok(r.cookies.every(c => /;\s*secure/i.test(c)))
  assert.equal(r.hsts, null)
})

test('login throttle IP key: XFF ignored under off, used only when the peer is trusted', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-z4-'))
  const saved = {}
  for (const [k, v] of Object.entries({ GML_DATA_DIR: dir, GML_RUNTIME_MODE: 'test', GML_LOGIN_IP_LIMIT: '2', GML_LOGIN_IP_WINDOW_MS: '60000' })) { saved[k] = process.env[k]; process.env[k] = v }
  t.after(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v }; rmSync(dir, { recursive: true, force: true }) })
  const hit = (base, user, ip) => fetch(`${base}/login/${user}`, { method: 'POST', headers: { 'x-forwarded-for': ip } }).then(async r => ({ status: r.status, body: await r.json() }))
  // off: rotating XFF cannot dodge the per-IP limit (limit 2 ⇒ third distinct-user attempt from one socket IP is 429)
  const off = await serve(t, undefined)
  assert.equal((await hit(off, 'a1', '192.0.2.1')).status, 200)
  assert.equal((await hit(off, 'a2', '192.0.2.2')).status, 200)
  assert.equal((await hit(off, 'a3', '192.0.2.3')).status, 429)
  // trusted: each client IP from XFF gets its own bucket (different fresh IPs are not limited by the loopback bucket above)
  const on = await serve(t, 'loopback')
  const r1 = await hit(on, 'b1', '192.0.2.11'); assert.equal(r1.status, 200); assert.equal(r1.body.ip, '192.0.2.11')
  assert.equal((await hit(on, 'b2', '192.0.2.12')).status, 200)
  assert.equal((await hit(on, 'b3', '192.0.2.13')).status, 200)
  assert.equal((await hit(on, 'b4', '192.0.2.11')).status, 200)
  assert.equal((await hit(on, 'b5', '192.0.2.11')).status, 429, 'same forwarded client IP shares one bucket')
})

// ------------------------------------------------------------------ startup gate
test('server refuses to start on invalid GML_TRUST_PROXY, naming TRUST_PROXY_INVALID', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-z4s-'))
  try {
    const run = (value) => spawnSync(process.execPath, ['server/index.js'], {
      cwd: ROOT, encoding: 'utf8', timeout: 30000,
      env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, HOST: '127.0.0.1', PORT: '0', GML_RUNTIME_MODE: 'test', GML_DB: '', GML_DATA_DIR: dir, GML_JWT_SECRET: 'a'.repeat(48), GML_TRUST_PROXY: value }
    })
    const r = run('true')
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /TRUST_PROXY_INVALID/)
    assert.match(r.stderr, /GML_TRUST_PROXY/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
