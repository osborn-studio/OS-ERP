/**
 * ============================================================================
 * 文件标识：tests/logger.test.mjs ｜ W7 结构化日志：脱敏、格式开关、请求号信任策略、5xx 事件号与请求号贯通
 * 只用进程内 express 与随机 loopback 端口；合成凭据不输出。见 ADR-0023。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { logger, logFormat, requestLogger } from '../server/lib/logger.js'
import { errorHandler } from '../server/middleware/audit.js'

function capture(fn, env = {}) {
  const saved = {}
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k] }
  const lines = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log = console.warn = console.error = (...a) => lines.push(a)
  const restore = () => {
    Object.assign(console, orig)
    for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
  }
  return Promise.resolve().then(fn).then(() => { restore(); return lines }, (e) => { restore(); throw e })
}

async function serve(t, { trust } = {}) {
  const app = express()
  if (trust) app.set('trust proxy', trust)
  app.use(requestLogger)
  app.use((req, res, next) => { res.locals.industry = 'cosmetic'; next() })
  app.get('/ok', (_req, res) => res.json({ ok: 1 }))
  app.get('/api/meta/health', (_req, res) => res.json({ ok: 1 }))
  app.get('/boom', () => { throw new Error('db exploded password=hunter2') })
  app.use(errorHandler)
  const srv = app.listen(0, '127.0.0.1')
  await new Promise(r => srv.once('listening', r))
  t.after(() => srv.close())
  return `http://127.0.0.1:${srv.address().port}`
}

test('json line: fixed fields present and every field redacted', async () => {
  const lines = await capture(() => logger.info('hello token=abc', {
    password: 'p@ss', api_key: 'k', phone: '13812345678', note: 'see ?access_token=zzz', nested: { authorization: 'Bearer x' }
  }), { GML_LOG_FORMAT: 'json', GML_LOG_LEVEL: undefined })
  assert.equal(lines.length, 1)
  const raw = String(lines[0][0])
  const row = JSON.parse(raw)
  assert.match(row.ts, /^\d{4}-\d\d-\d\dT/)
  assert.equal(row.level, 'info')
  assert.equal(row.password, '[REDACTED]')
  assert.equal(row.api_key, '[REDACTED]')
  assert.equal(row.nested.authorization, '[REDACTED]')
  assert.equal(row.phone, '138****5678')
  for (const secret of ['p@ss', 'hunter2', 'abc', 'zzz', '12345678']) assert.ok(!raw.includes(secret), secret)
})

test('reserved keys cannot be overridden by fields', async () => {
  const [[line]] = await capture(() => logger.info('real', { msg: 'fake', level: 'debug', ts: 'x' }), { GML_LOG_FORMAT: 'json' })
  const row = JSON.parse(line)
  assert.equal(row.msg, 'real'); assert.equal(row.level, 'info'); assert.notEqual(row.ts, 'x')
})

test('format switch: explicit wins; production defaults json, demo/test default text; invalid falls back', () => {
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'production' }), 'json')
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'demo' }), 'text')
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'test' }), 'text')
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'test', GML_LOG_FORMAT: 'json' }), 'json')
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'production', GML_LOG_FORMAT: 'text' }), 'text')
  assert.equal(logFormat({ GML_RUNTIME_MODE: 'production', GML_LOG_FORMAT: 'xml' }), 'json')
})

test('text format is a readable bracketed line, errors keep the stack as a second argument', async () => {
  const lines = await capture(() => logger.error('request failed', { incident_id: 'abcd', err: new Error('boom') }), { GML_LOG_FORMAT: 'text' })
  assert.match(lines[0][0], /^\[error\] request failed incident_id=abcd/)
  assert.match(String(lines[0][1]), /boom/)
})

test('level filter: debug hidden by default', async () => {
  const lines = await capture(() => { logger.debug('d'); logger.info('i') }, { GML_LOG_FORMAT: 'json', GML_LOG_LEVEL: undefined })
  assert.equal(lines.length, 1)
})

test('request id: generated and echoed; untrusted inbound id is ignored', async (t) => {
  const base = await serve(t)
  let res
  const lines = await capture(async () => { res = await fetch(`${base}/ok`, { headers: { 'x-request-id': 'spoofed-id-12345' } }) }, { GML_LOG_FORMAT: 'json' })
  const id = res.headers.get('x-request-id')
  assert.match(id, /^[0-9a-f-]{36}$/)
  assert.notEqual(id, 'spoofed-id-12345')
  const access = lines.map(l => JSON.parse(l[0])).find(r => r.msg === 'request')
  assert.equal(access.req_id, id); assert.equal(access.status, 200); assert.equal(access.route, '/ok')
  assert.equal(access.industry, 'cosmetic'); assert.equal(typeof access.duration_ms, 'number')
})

test('request id: trusted proxy inbound id is propagated; malformed id is replaced', async (t) => {
  const base = await serve(t, { trust: 'loopback' })
  const good = await fetch(`${base}/ok`, { headers: { 'x-request-id': 'edge-req-0001' } })
  assert.equal(good.headers.get('x-request-id'), 'edge-req-0001')
  const bad = await fetch(`${base}/ok`, { headers: { 'x-request-id': 'a b"\\{x}' } })
  assert.notEqual(bad.headers.get('x-request-id'), 'a b"\\{x}')
  const short = await fetch(`${base}/ok`, { headers: { 'x-request-id': 'abc' } })
  assert.notEqual(short.headers.get('x-request-id'), 'abc')
})

test('health check logs at debug only; query strings never reach the access line', async (t) => {
  const base = await serve(t)
  const lines = await capture(async () => {
    await fetch(`${base}/api/meta/health`)
    await fetch(`${base}/ok?token=SECRETQS`)
  }, { GML_LOG_FORMAT: 'json', GML_LOG_LEVEL: undefined })
  const rows = lines.map(l => JSON.parse(l[0]))
  assert.equal(rows.length, 1)
  assert.equal(rows[0].route, '/ok')
  assert.ok(!JSON.stringify(rows).includes('SECRETQS'))
  const dbg = await capture(() => fetch(`${base}/api/meta/health`).then(r => r.text()), { GML_LOG_FORMAT: 'json', GML_LOG_LEVEL: 'debug' })
  assert.equal(dbg.length, 1)
})

test('5xx: log line carries incident_id and req_id matching the response and header; no secrets', async (t) => {
  const base = await serve(t)
  let res, body
  const lines = await capture(async () => { res = await fetch(`${base}/boom`); body = await res.json() }, { GML_LOG_FORMAT: 'json', GML_RUNTIME_MODE: 'production' })
  assert.equal(res.status, 500)
  const rows = lines.map(l => JSON.parse(l[0]))
  const err = rows.find(r => r.level === 'error')
  const headerId = res.headers.get('x-request-id')
  assert.equal(err.req_id, headerId)
  assert.match(err.incident_id, /^[0-9a-f]{16}$/)
  assert.ok(JSON.stringify(body).includes(err.incident_id))
  assert.equal(err.status, 500)
  assert.ok(!JSON.stringify(rows).includes('hunter2'))
  const access = rows.find(r => r.msg === 'request')
  assert.equal(access.status, 500); assert.equal(access.incident_id, err.incident_id); assert.equal(access.req_id, headerId)
})
