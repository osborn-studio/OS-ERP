import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Node-focused contract checks for the actual TypeScript modules; no browser claims.
const compile = file => ts.transpileModule(readFileSync(new URL(file, import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const clientUrl = asModule(compile('../src/api/client.ts'))
const client = await import(clientUrl)
const session = await import(asModule(compile('../src/store/session.ts').replace("'../api/client'", JSON.stringify(clientUrl))))

class Storage {
  values = new Map()
  getItem(k) { return this.values.get(k) ?? null }
  setItem(k, v) { this.values.set(k, String(v)) }
  removeItem(k) { this.values.delete(k) }
}
function setup(t) {
  const original = { window: globalThis.window, localStorage: globalThis.localStorage, fetch: globalThis.fetch, document: globalThis.document }
  globalThis.window = Object.assign(new EventTarget(), { location: { origin: 'https://erp.example.test' } })
  globalThis.localStorage = new Storage()
  globalThis.document = { createElement() { throw Error('unexpected file download') } }
  t.after(() => { for (const [k, v] of Object.entries(original)) v === undefined ? delete globalThis[k] : globalThis[k] = v })
  client.setSession('test-backoffice-token', { id: 1, role: 'admin' }, 'cosmetic')
}
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const revoked = () => json(401, { success: false, code: 'SESSION_REVOKED', error: 'Unauthorized', message: 'invalid session' })
const operations = [
  ['JSON', () => client.api.get('/auth/me')],
  ['download', () => client.api.download('/reports/export')],
  ['rawPost', () => client.api.rawPost('/qimen', {})]
]

test('top-level business code survives a detail object without its own code', async t => {
  setup(t)
  globalThis.fetch = async () => json(401, { code: 'SESSION_REVOKED', detail: { reason: 'version' } })
  await assert.rejects(() => client.api.get('/auth/me'), error => error.code === 'SESSION_REVOKED' && error.detail.reason === 'version')
})

for (const [name, request] of operations) {
  test(`${name}: 401 revokes current backend session and preserves mall session`, async t => {
    setup(t); client.setMallToken('test-mall-token')
    globalThis.fetch = async () => revoked()
    await assert.rejects(request, { status: 401 })
    assert.equal(client.getToken(), '')
    assert.equal(client.getUser(), null)
    assert.equal(client.getMallToken(), 'test-mall-token')
    assert.match(client.getSessionNotice(), /已被撤销/)
  })
  test(`${name}: a stale 401 cannot erase a later login, even if its token string is identical`, async t => {
    setup(t)
    let respond
    globalThis.fetch = () => new Promise(resolve => { respond = resolve })
    const pending = request()
    client.setSession('test-backoffice-token', { id: 2, role: 'viewer' }, 'food')
    respond(revoked())
    await assert.rejects(pending, { status: 401 })
    assert.equal(client.getToken(), 'test-backoffice-token')
    assert.equal(client.getUser().id, 2)
    assert.equal(client.getSessionNotice(), '')
  })
  test(`${name}: FEATURE_DISABLED emits one refresh event and never retries`, async t => {
    setup(t)
    let calls = 0, events = 0
    window.addEventListener(client.FEATURE_DISABLED_EVENT, event => { events++; assert.equal(event.detail.capability, 'agent_access') })
    globalThis.fetch = async () => { calls++; return json(503, { success: false, detail: { code: 'FEATURE_DISABLED', capability: 'agent_access' } }) }
    await assert.rejects(request, { status: 503 })
    assert.equal(calls, 1); assert.equal(events, 1); assert.notEqual(client.getToken(), '')
  })
}

test('login failure never clears an existing backend session and does not send its credential', async t => {
  setup(t)
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/auth/login')
    assert.equal(options.headers.has('Authorization'), false)
    return revoked()
  }
  await assert.rejects(() => client.api.post('/auth/login', { username: 'wrong', password: 'wrong' }), { status: 401 })
  assert.equal(client.getToken(), 'test-backoffice-token')
})

test('mall request never receives backend credential and its 401 only clears its own session', async t => {
  setup(t); client.setMallToken('test-mall-token')
  globalThis.fetch = async (_url, options) => {
    assert.equal(options.headers.get('Authorization'), null)
    assert.equal(options.headers.get('x-mall-token'), 'test-mall-token')
    return revoked()
  }
  await assert.rejects(() => client.api.get('/mall/me'), { status: 401 })
  assert.equal(client.getToken(), 'test-backoffice-token'); assert.equal(client.getMallToken(), '')
})

test('malformed 401 response still clears current session', async t => {
  setup(t); globalThis.fetch = async () => new Response('not JSON', { status: 401 })
  await assert.rejects(() => client.api.get('/auth/me'), { status: 401 })
  assert.equal(client.getToken(), '')
})

test('external URLs, protocol-relative URLs and path escapes are rejected before fetch', async t => {
  setup(t); let calls = 0
  globalThis.fetch = async () => { calls++; return json(200, {}) }
  for (const path of ['https://elsewhere.test/path', '//elsewhere.test/path', '/../private', '/%2e%2e/private', '/\\elsewhere', '/path#fragment']) {
    await assert.rejects(() => client.api.get(path), { status: 0 })
    await assert.rejects(() => client.api.rawPost(path, {}), { status: 0 })
    await assert.rejects(() => client.api.download(path), { status: 0 })
  }
  assert.equal(calls, 0)
})

test('API requests are same-origin and refuse redirect credential forwarding', async t => {
  setup(t)
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).origin, window.location.origin)
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'same-origin')
    assert.equal(options.headers.get('x-mall-token'), null)
    return json(200, { success: true })
  }
  await client.api.get('/auth/me')
})

test('logout confirms revocation only when the server explicitly confirms it', async t => {
  setup(t)
  globalThis.fetch = async (url, options) => {
    assert.equal(new URL(url).pathname, '/api/auth/logout-all'); assert.equal(options.method, 'POST')
    return json(200, { success: true, data: { revoked: true } })
  }
  const result = await session.logoutAll()
  assert.equal(result.revoked, true); assert.equal(client.getToken(), '')
  assert.match(client.getSessionNotice(), /服务端已撤销/)
})

for (const failure of ['offline', '401', 'unconfirmed']) {
  test(`logout ${failure}: local exit remains possible without claiming remote revocation`, async t => {
    setup(t)
    globalThis.fetch = async () => {
      if (failure === 'offline') throw new TypeError('network error')
      return failure === '401' ? revoked() : json(200, { success: true, data: {} })
    }
    const result = await session.logoutAll()
    assert.equal(result.revoked, false); assert.equal(client.getToken(), '')
    assert.match(result.message, /未能确认/); assert.match(client.getSessionNotice(), /未能确认/)
  })
}

test('late logout response preserves a newly established session', async t => {
  setup(t); let respond
  globalThis.fetch = () => new Promise(resolve => { respond = resolve })
  const pending = session.logoutAll()
  client.setSession('new-token', { id: 2 }, 'food')
  respond(json(200, { success: true, data: { revoked: true } }))
  await pending
  assert.equal(client.getToken(), 'new-token'); assert.equal(client.getSessionNotice(), '')
})

test('password change clears session only after explicit changed and reauthenticate confirmation', async t => {
  setup(t)
  globalThis.fetch = async () => json(200, { success: true, data: { changed: true } })
  await assert.rejects(() => session.changePassword('old', 'new'), /未确认/)
  assert.notEqual(client.getToken(), '')
  globalThis.fetch = async (_url, options) => {
    assert.deepEqual(JSON.parse(options.body), { oldPassword: 'old', newPassword: 'new' })
    return json(200, { success: true, data: { changed: true, reauthenticate: true } })
  }
  await session.changePassword('old', 'new')
  assert.equal(client.getToken(), ''); assert.match(client.getSessionNotice(), /密码已修改/)
})

test('same-tab changes and other-tab storage events synchronize subscribers without credential event payloads', t => {
  setup(t); let calls = 0
  const stop = client.subscribeAuth(() => { calls++ })
  window.addEventListener(client.AUTH_CHANGED_EVENT, event => assert.equal(event.detail, null))
  client.clearToken(); assert.equal(calls, 1)
  const event = new Event('storage')
  Object.defineProperties(event, { key: { value: 'gml_token' }, storageArea: { value: localStorage } })
  window.dispatchEvent(event); assert.equal(calls, 2)
  stop(); window.dispatchEvent(event); assert.equal(calls, 2)
})
