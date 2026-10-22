import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'
import { createLoginThrottle } from '../server/lib/login-throttle.js'

const request = { ip: '192.0.2.1', industry: 'retail', username: 'SyntheticUser' }
const moduleUrl = new URL('../server/lib/login-throttle.js', import.meta.url).href

function fixture(t, policy = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'os-egp-throttle-'))
  const connections = []
  let timestamp = 1000000
  t.after(() => {
    for (const connection of connections.reverse()) connection.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  const open = (overrides = {}) => {
    const limiter = createLoginThrottle({ dataDir, mode: 'test', now: () => timestamp, policy, ...overrides })
    connections.push(limiter)
    return limiter
  }
  const inspect = fn => {
    const db = new Database(path.join(dataDir, 'login-throttle.sqlite'))
    try { return fn(db) } finally { db.close() }
  }
  return { dataDir, open, inspect, advance: ms => { timestamp += ms }, get now() { return timestamp } }
}

function rateLimited(fn, retryAfter) {
  assert.throws(fn, error => error.status === 429 && error.code === 'LOGIN_RATE_LIMITED' &&
    Number.isSafeInteger(error.retryAfter) && error.retryAfter > 0 &&
    (retryAfter === undefined || error.retryAfter === retryAfter))
}

function child(code, args = [], env = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e', code, ...args], {
      env: { ...process.env, GML_RUNTIME_MODE: 'test', ...env }, stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = '', err = ''
    const timer = setTimeout(() => { proc.kill('SIGKILL') }, 15000)
    proc.stdout.on('data', chunk => { out += chunk })
    proc.stderr.on('data', chunk => { err += chunk })
    proc.on('error', reject)
    proc.on('close', (status, signal) => {
      clearTimeout(timer)
      if (status !== 0) reject(new Error(`Test child failed: status=${status}, signal=${signal}; ${err}`))
      else resolve(JSON.parse(out))
    })
  })
}

test('default limits apply in test mode and successful attempts also consume the budget', t => {
  const f = fixture(t)
  const limiter = f.open()
  for (let n = 0; n < 10; n++) assert.deepEqual(limiter.consumeLoginAttempt(request), { allowed: true })
  rateLimited(() => limiter.consumeLoginAttempt(request), 300)
  assert.deepEqual(f.inspect(db => db.prepare('SELECT attempts FROM login_throttle_buckets ORDER BY attempts').all()),
    [{ attempts: 10 }, { attempts: 10 }])
})

test('IP budget is shared across industries and randomly chosen usernames', t => {
  const f = fixture(t, { ipLimit: 3, accountLimit: 10 })
  const limiter = f.open()
  for (let n = 0; n < 3; n++) limiter.consumeLoginAttempt({ ...request, industry: `industry${n}`, username: `user${n}` })
  rateLimited(() => limiter.consumeLoginAttempt({ ...request, industry: 'other', username: 'unused' }), 60)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 4)
})

test('account budget crosses IPs while preserving industry and exact account case semantics', t => {
  const f = fixture(t, { accountLimit: 2 })
  const limiter = f.open()
  limiter.consumeLoginAttempt(request)
  limiter.consumeLoginAttempt({ ...request, ip: '192.0.2.2' })
  rateLimited(() => limiter.consumeLoginAttempt({ ...request, ip: '192.0.2.3' }), 300)
  limiter.consumeLoginAttempt({ ...request, username: 'syntheticuser' })
  limiter.consumeLoginAttempt({ ...request, industry: 'manufacturing' })
})

test('equivalent IPv4-mapped and IPv6 spellings cannot split IP limits', t => {
  const f = fixture(t, { ipLimit: 1 })
  const limiter = f.open()
  limiter.consumeLoginAttempt(request)
  rateLimited(() => limiter.consumeLoginAttempt({ ...request, ip: '::ffff:c000:201', username: 'other' }))
  limiter.consumeLoginAttempt({ ...request, ip: '2001:db8::1', username: 'v6a' })
  rateLimited(() => limiter.consumeLoginAttempt({ ...request, ip: '2001:0db8:0000:0000:0000:0000:0000:0001', username: 'v6b' }))
})

test('fixed-window expiry uses ceil seconds and blocked requests never extend a lockout', t => {
  const f = fixture(t, { accountLimit: 1, accountWindowMs: 2500 })
  const limiter = f.open()
  limiter.consumeLoginAttempt(request)
  rateLimited(() => limiter.consumeLoginAttempt(request), 3)
  f.advance(1501)
  rateLimited(() => limiter.consumeLoginAttempt(request), 1)
  f.advance(998)
  rateLimited(() => limiter.consumeLoginAttempt(request), 1)
  f.advance(1)
  limiter.consumeLoginAttempt(request)
  assert.equal(f.inspect(db => db.prepare('SELECT MAX(attempts) AS n FROM login_throttle_buckets').get().n), 2)
})

test('closing/reopening a connection preserves restrictions and the original expiry', t => {
  const f = fixture(t, { accountLimit: 1 })
  const first = f.open()
  first.consumeLoginAttempt(request)
  first.close()
  f.advance(1000)
  const reopened = f.open()
  rateLimited(() => reopened.consumeLoginAttempt(request), 299)
})

test('independent simultaneous processes atomically share the same account budget', async t => {
  const policy = { accountLimit: 5, ipLimit: 100 }
  const f = fixture(t, policy)
  f.open().close()
  const code = `
    import { createLoginThrottle } from ${JSON.stringify(moduleUrl)};
    const [dataDir, policy, input, timestamp] = process.argv.slice(1);
    const limiter = createLoginThrottle({dataDir,mode:'test',policy:JSON.parse(policy),now:()=>Number(timestamp)});
    let result;
    try { limiter.consumeLoginAttempt(JSON.parse(input)); result='allowed' }
    catch(error) { result=error.code }
    finally { limiter.close() }
    process.stdout.write(JSON.stringify(result));
  `
  const results = await Promise.all(Array.from({ length: 12 }, () => child(code,
    [f.dataDir, JSON.stringify(policy), JSON.stringify(request), String(f.now)])))
  assert.equal(results.filter(result => result === 'allowed').length, 5)
  assert.equal(results.filter(result => result === 'LOGIN_RATE_LIMITED').length, 7)
  rateLimited(() => f.open().consumeLoginAttempt(request))
  assert.equal(f.inspect(db => db.prepare('SELECT MAX(attempts) AS n FROM login_throttle_buckets').get().n), 5)
})

test('capacity saturation cannot evict an active restriction and expiry reclaims space', t => {
  const f = fixture(t, { maxBuckets: 4, accountLimit: 1, ipWindowMs: 1000, accountWindowMs: 2000 })
  const limiter = f.open()
  limiter.consumeLoginAttempt(request)
  limiter.consumeLoginAttempt({ ...request, ip: '192.0.2.2', username: 'second' })
  for (let n = 3; n < 30; n++) {
    rateLimited(() => limiter.consumeLoginAttempt({ ...request, ip: `192.0.2.${n}`, username: `random${n}` }), 1)
  }
  rateLimited(() => limiter.consumeLoginAttempt(request), 2)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 4)
  f.advance(1000)
  limiter.consumeLoginAttempt({ ...request, ip: '192.0.2.3', username: 'new' })
  rateLimited(() => limiter.consumeLoginAttempt(request), 1)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 4)
  f.advance(2000)
  limiter.consumeLoginAttempt(request)
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 2)
})

test('stored data contains only opaque keys, never raw identities or ignored credentials', t => {
  const f = fixture(t)
  const limiter = f.open()
  const sentinels = ['198.51.100.241', 'SensitiveSyntheticUsername', 'FakePasswordNeverStore_7X', 'eySynthetic.JWTNeverStore.signature']
  limiter.consumeLoginAttempt({ ...request, ip: sentinels[0], username: sentinels[1], password: sentinels[2], token: sentinels[3] })
  const rows = f.inspect(db => db.prepare('SELECT * FROM login_throttle_buckets').all())
  assert.equal(rows.length, 2)
  for (const row of rows) assert.match(row.key, /^[a-f0-9]{64}$/)
  for (const file of readdirSync(f.dataDir)) {
    const bytes = readFileSync(path.join(f.dataDir, file))
    for (const value of sentinels) assert.equal(bytes.includes(Buffer.from(value)), false, `identity leaked to ${file}`)
  }
  assert.equal(statSync(path.join(f.dataDir, 'login-throttle.sqlite')).mode & 0o777, 0o600)
})

test('runtime mismatch and unclassified old databases are refused without destructive changes', t => {
  const f = fixture(t)
  f.open().consumeLoginAttempt(request)
  assert.throws(() => f.open({ mode: 'production' }), { code: 'DATABASE_MODE_MISMATCH' })
  const old = fixture(t)
  const db = new Database(path.join(old.dataDir, 'login-throttle.sqlite'))
  db.exec('CREATE TABLE existing_data(value TEXT); INSERT INTO existing_data VALUES (\'preserve\')')
  db.close()
  assert.throws(() => old.open(), { code: 'DATABASE_UNCLASSIFIED' })
  assert.deepEqual(old.inspect(conn => conn.prepare('SELECT * FROM existing_data').all()), [{ value: 'preserve' }])
})

test('a failed write rolls back both dimensions; unavailable and closed stores fail closed', t => {
  const f = fixture(t)
  const limiter = f.open()
  f.inspect(db => db.exec(`CREATE TRIGGER fail_second_bucket BEFORE INSERT ON login_throttle_buckets
    WHEN (SELECT count(*) FROM login_throttle_buckets)=1 BEGIN SELECT RAISE(ABORT,'synthetic write failure'); END`))
  assert.throws(() => limiter.consumeLoginAttempt(request), { status: 503, code: 'LOGIN_THROTTLE_UNAVAILABLE' })
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 0)
  f.inspect(db => db.exec('DROP TRIGGER fail_second_bucket'))
  limiter.consumeLoginAttempt(request)
  limiter.close()
  assert.throws(() => limiter.consumeLoginAttempt(request), { status: 503, code: 'LOGIN_THROTTLE_UNAVAILABLE' })
})

test('database contention fails closed without partially consuming a budget', t => {
  const f = fixture(t)
  const limiter = f.open()
  f.inspect(db => {
    db.exec('BEGIN IMMEDIATE')
    try {
      assert.throws(() => limiter.consumeLoginAttempt(request), { status: 503, code: 'LOGIN_THROTTLE_UNAVAILABLE' })
    } finally { db.exec('ROLLBACK') }
  })
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 0)
  limiter.consumeLoginAttempt(request)
})

test('active policy cannot be changed; after expiry old connections cannot apply stale policy', t => {
  const f = fixture(t, { accountLimit: 1, accountWindowMs: 1000, ipWindowMs: 1000 })
  const old = f.open()
  old.consumeLoginAttempt(request)
  const changed = { accountLimit: 5, accountWindowMs: 1000, ipWindowMs: 1000 }
  assert.throws(() => f.open({ policy: changed }), /Cannot change throttle policy/)
  rateLimited(() => old.consumeLoginAttempt(request))
  f.advance(1000)
  f.open({ policy: changed }).consumeLoginAttempt(request)
  assert.throws(() => old.consumeLoginAttempt(request), { status: 503, code: 'LOGIN_THROTTLE_UNAVAILABLE' })
})

test('invalid keys and invalid configuration never silently disable protection', t => {
  const f = fixture(t)
  const limiter = f.open()
  for (const value of [null, { ...request, ip: 'forged-xff' }, { ...request, industry: '../retail' },
    { ...request, username: '' }, { ...request, username: 'a'.repeat(65) }]) {
    assert.throws(() => limiter.consumeLoginAttempt(value), { status: 400, code: 'LOGIN_THROTTLE_INPUT_INVALID' })
  }
  assert.equal(f.inspect(db => db.prepare('SELECT count(*) AS n FROM login_throttle_buckets').get().n), 0)
  for (const policy of [{ accountLimit: 0 }, { accountLimit: NaN }, { maxBuckets: Infinity }, { disabled: true }]) {
    assert.throws(() => f.open({ policy }), /login throttle policy/i)
  }
})

test('route API maps missing data directory and invalid environment policy to 503', async t => {
  const f = fixture(t)
  const code = `
    import { consumeLoginAttempt } from ${JSON.stringify(moduleUrl)};
    let result;
    try { consumeLoginAttempt(${JSON.stringify(request)}); result={allowed:true} }
    catch(error) { result={status:error.status,code:error.code,message:error.message} }
    process.stdout.write(JSON.stringify(result));
  `
  for (const env of [{ GML_DATA_DIR: '' }, { GML_DATA_DIR: f.dataDir, GML_LOGIN_IP_LIMIT: '0' }]) {
    const result = await child(code, [], env)
    assert.equal(result.status, 503)
    assert.equal(result.code, 'LOGIN_THROTTLE_UNAVAILABLE')
    assert.equal(result.message.includes(f.dataDir), false)
  }
})
