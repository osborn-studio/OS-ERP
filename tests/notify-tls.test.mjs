import test from 'node:test'
import assert from 'node:assert/strict'
import https from 'node:https'
import tls from 'node:tls'
import { readFileSync } from 'node:fs'
import { once } from 'node:events'
import { isBlockedAddress, outboundRequest } from '../server/lib/outbound-url.js'

// ADR-0008 "TLS 联调": real outboundRequest over a local HTTPS listener with a throwaway
// self-signed certificate (tests/fixtures, test only). No external network; DNS is injected.

const CERT = readFileSync(new URL('./fixtures/notify-tls-test-cert.pem', import.meta.url), 'utf8')
const KEY = readFileSync(new URL('./fixtures/notify-tls-test-key.pem', import.meta.url), 'utf8')
const HOST = 'hook.example.test'
const TEST = { GML_RUNTIME_MODE: 'test' }
const lookupLoopback = async () => [{ address: '127.0.0.1', family: 4 }]

async function tlsServer(t, handler) {
  const sni = []
  const srv = https.createServer({
    key: KEY, cert: CERT,
    SNICallback: (name, cb) => { sni.push(name); cb(null, tls.createSecureContext({ key: KEY, cert: CERT })) }
  }, handler)
  srv.listen(0, '127.0.0.1'); await once(srv, 'listening')
  t.after(() => { srv.closeAllConnections(); return new Promise(r => srv.close(r)) })
  return { sni, port: srv.address().port }
}

const opts = (extra = {}) => ({ env: TEST, lookup: lookupLoopback, testTrustedCa: CERT, method: 'POST', body: '{}', ...extra })

test('pinned address + SNI = hostname, self-signed accepted via test CA only', async (t) => {
  const s = await tlsServer(t, (req, res) => res.end('ok'))
  const r = await outboundRequest(`https://${HOST}:${s.port}/hook`, opts())
  assert.equal(r.status, 200); assert.equal(r.bodyText, 'ok'); assert.equal(r.address, '127.0.0.1')
  assert.deepEqual(s.sni, [HOST])
})

test('self-signed certificate is rejected without the test CA', async (t) => {
  const s = await tlsServer(t, (req, res) => res.end('ok'))
  await assert.rejects(outboundRequest(`https://${HOST}:${s.port}/`, opts({ testTrustedCa: undefined })), { code: 'OUTBOUND_NETWORK' })
})

test('certificate hostname verification: wrong name is rejected even with the CA trusted', async (t) => {
  const s = await tlsServer(t, (req, res) => res.end('ok'))
  await assert.rejects(outboundRequest(`https://other.example.test:${s.port}/`, opts()), (e) => e.code === 'OUTBOUND_NETWORK' && /altname|match|hostname/i.test(e.message))
})

test('test CA is refused outside test runtime mode (before any lookup or connection)', async (t) => {
  const s = await tlsServer(t, (req, res) => res.end('ok'))
  for (const mode of ['production', 'demo', undefined]) {
    let looked = false
    const env = mode ? { GML_RUNTIME_MODE: mode } : {}
    await assert.rejects(
      outboundRequest(`https://${HOST}:${s.port}/`, opts({ env, lookup: async () => { looked = true; return [{ address: '8.8.8.8', family: 4 }] } })),
      { code: 'OUTBOUND_TEST_CA_FORBIDDEN' }
    )
    assert.equal(looked, false)
  }
  assert.deepEqual(s.sni, [])
})

test('redirect refused, body cap and total timeout (slow body) over TLS', async (t) => {
  const s = await tlsServer(t, (req, res) => {
    if (req.url === '/redir') { res.writeHead(302, { location: 'https://hook.example.test/x' }); return res.end() }
    if (req.url === '/big') return res.end('x'.repeat(5000))
    res.writeHead(200); res.write('start'); setTimeout(() => res.end('late'), 3000)
  })
  const base = `https://${HOST}:${s.port}`
  await assert.rejects(outboundRequest(`${base}/redir`, opts()), { code: 'OUTBOUND_REDIRECT' })
  await assert.rejects(outboundRequest(`${base}/big`, opts({ maxBodyBytes: 1000 })), { code: 'OUTBOUND_BODY_TOO_LARGE' })
  const t0 = Date.now()
  await assert.rejects(outboundRequest(`${base}/slow`, opts({ timeoutMs: 400 })), { code: 'OUTBOUND_TIMEOUT' })
  assert.ok(Date.now() - t0 < 2000)
})

test('Teredo 2001::/32 is blocked, neighbouring public 2001: space is not', () => {
  for (const ip of ['2001::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:0:ffff:ffff::1']) assert.equal(isBlockedAddress(ip), true, ip)
  assert.equal(isBlockedAddress('2001:4860:4860::8888'), false)
})
