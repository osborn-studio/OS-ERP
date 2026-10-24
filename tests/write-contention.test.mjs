/**
 * ============================================================================
 * 文件标识：tests/write-contention.test.mjs ｜ 测试：写事务重试包装与多进程写并发（ADR-0035）
 * ============================================================================
 * 【职责】守住 Y7：
 *   ① `GML_SQLITE_BUSY_MS` 校验（默认沿用 5000）；
 *   ② `withWriteRetry` 的契约：只重试 SqliteError 的 SQLITE_BUSY/LOCKED；非 BUSY 错误一次都不重试；
 *      每次重试之前 fn 的全部写入已随事务回滚（不会半截提交，也不会重复提交）；已在事务内则不重试；
 *      退避有上限且带抖动；次数用尽抛出原始错误；
 *   ③ 多进程并发：N 个独立写进程对同一个隔离库并发建采购单 + 调拨（autoShip），父进程先占住写锁迫使 BUSY，
 *      断言没有丢写、没有重复（单号唯一、库存守恒、流水条数与成功数一致）、重试被记录；
 *   ④ 热点写路由确实包了 `withWriteRetry`（静态断言，防止被改回去）。
 * 【夹具口径】全新临时目录里的 demo 种子库（reseed-all），随机 run id；不碰仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, cpSync, existsSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { sqliteBusyMs } from '../server/db/index.js'
import {
  withWriteRetry, isBusyError, backoffMs, writeRetryStats, resetWriteRetryStats, writeRetryMaxFromEnv
} from '../server/lib/tx.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const noSleep = () => {}

// 种子库只生成一次（约 10 秒），每个用例拷贝自己的副本
let seedTemplate = null
function seededCopy(t) {
  if (!seedTemplate) {
    seedTemplate = mkdtempSync(path.join(tmpdir(), 'os-y7-seed-'))
    const seed = spawnSync(process.execPath, ['scripts/reseed-all.mjs', '--force'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000,
      env: { PATH: process.env.PATH, HOME: seedTemplate, GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: seedTemplate }
    })
    assert.equal(seed.status, 0, seed.stderr)
  }
  const dir = mkdtempSync(path.join(tmpdir(), 'os-y7-'))
  cpSync(seedTemplate, dir, { recursive: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
test.after(() => { if (seedTemplate) rmSync(seedTemplate, { recursive: true, force: true }) })

function scratch(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-y7-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function openPair(t) {
  const dir = scratch(t)
  const file = path.join(dir, 't.db')
  const a = new Database(file)
  a.pragma('journal_mode = WAL')
  a.exec('CREATE TABLE w (id INTEGER PRIMARY KEY, k TEXT)')
  a.pragma('busy_timeout = 0')
  const b = new Database(file)
  b.pragma('busy_timeout = 0')
  t.after(() => { a.close(); b.close() })
  return { a, b, file }
}
const busyError = () => new Database.SqliteError('database is locked', 'SQLITE_BUSY')

test('GML_SQLITE_BUSY_MS: default keeps 5000, valid values pass, junk is rejected', () => {
  assert.equal(sqliteBusyMs({}), 5000)
  assert.equal(sqliteBusyMs({ GML_SQLITE_BUSY_MS: '' }), 5000)
  assert.equal(sqliteBusyMs({ GML_SQLITE_BUSY_MS: '250' }), 250)
  assert.equal(sqliteBusyMs({ GML_SQLITE_BUSY_MS: '0' }), 0)
  for (const bad of ['-1', '1.5', 'abc', '1e3', '300001', ' 5 ', '0x10']) {
    assert.throws(() => sqliteBusyMs({ GML_SQLITE_BUSY_MS: bad }), (e) => e.code === 'SQLITE_BUSY_MS_INVALID', bad)
  }
})

test('GML_WRITE_RETRY_MAX: default 4, 1..10 only', () => {
  assert.equal(writeRetryMaxFromEnv({}), 4)
  assert.equal(writeRetryMaxFromEnv({ GML_WRITE_RETRY_MAX: '1' }), 1)
  assert.equal(writeRetryMaxFromEnv({ GML_WRITE_RETRY_MAX: '10' }), 10)
  for (const bad of ['0', '11', 'x', '2.5']) {
    assert.throws(() => writeRetryMaxFromEnv({ GML_WRITE_RETRY_MAX: bad }), (e) => e.code === 'WRITE_RETRY_MAX_INVALID', bad)
  }
})

test('isBusyError only accepts better-sqlite3 SqliteError with BUSY/LOCKED codes', () => {
  for (const code of ['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_BUSY_RECOVERY', 'SQLITE_LOCKED', 'SQLITE_LOCKED_SHAREDCACHE']) {
    assert.equal(isBusyError(new Database.SqliteError('x', code)), true, code)
  }
  for (const code of ['SQLITE_CONSTRAINT_UNIQUE', 'SQLITE_FULL', 'SQLITE_READONLY', 'SQLITE_IOERR', 'SQLITE_BUSYX']) {
    assert.equal(isBusyError(new Database.SqliteError('x', code)), false, code)
  }
  // 业务错误即使 code 字符串相同、或 message 里提到 locked，也不是并发冲突
  assert.equal(isBusyError(Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' })), false)
  assert.equal(isBusyError(Object.assign(new Error('x'), { code: 'PO_NOT_FOUND', status: 404 })), false)
  assert.equal(isBusyError(null), false)
  assert.equal(isBusyError('SQLITE_BUSY'), false)
})

test('backoff is capped exponential with jitter inside [d/2, d]', () => {
  const o = { baseDelayMs: 20, maxDelayMs: 100 }
  assert.equal(backoffMs(1, o, () => 1), 20)
  assert.equal(backoffMs(1, o, () => 0), 10)
  assert.equal(backoffMs(2, o, () => 1), 40)
  assert.equal(backoffMs(3, o, () => 1), 80)
  assert.equal(backoffMs(4, o, () => 1), 100) // capped
  assert.equal(backoffMs(9, o, () => 1), 100)
  assert.equal(backoffMs(9, o, () => 0), 50)
})

test('BEGIN IMMEDIATE contention: retries until the other writer releases, fn runs once', (t) => {
  resetWriteRetryStats()
  const { a, b } = openPair(t)
  b.exec('BEGIN IMMEDIATE')
  let calls = 0
  const sleeps = []
  const out = withWriteRetry(a, () => { calls++; a.prepare("INSERT INTO w (k) VALUES ('x')").run(); return 'done' }, {
    maxAttempts: 5, baseDelayMs: 10, label: 't.begin',
    sleep: (ms) => { sleeps.push(ms); if (sleeps.length === 2) b.exec('COMMIT') }
  })
  assert.equal(out, 'done')
  assert.equal(calls, 1, 'fn must not run while the write lock is not held')
  assert.equal(sleeps.length, 2)
  assert.equal(a.prepare('SELECT COUNT(*) c FROM w').get().c, 1)
  const s = writeRetryStats()
  assert.equal(s.retries, 2)
  assert.equal(s.exhausted, 0)
})

test('BUSY thrown after fn already wrote: the write is rolled back, retry commits exactly once', (t) => {
  resetWriteRetryStats()
  const { a } = openPair(t)
  let calls = 0
  withWriteRetry(a, () => {
    calls++
    a.prepare('INSERT INTO w (k) VALUES (?)').run(`attempt-${calls}`)
    if (calls === 1) throw busyError()
  }, { maxAttempts: 3, sleep: noSleep })
  assert.equal(calls, 2)
  assert.deepEqual(a.prepare('SELECT k FROM w').all().map((r) => r.k), ['attempt-2'], 'attempt 1 rows must be gone')
  assert.equal(a.inTransaction, false)
})

test('non-BUSY errors are never retried and leave no rows behind', (t) => {
  resetWriteRetryStats()
  const { a } = openPair(t)
  a.exec('CREATE UNIQUE INDEX w_k ON w(k)')
  a.prepare("INSERT INTO w (k) VALUES ('dup')").run()
  const cases = [
    () => { a.prepare("INSERT INTO w (k) VALUES ('fresh')").run(); a.prepare("INSERT INTO w (k) VALUES ('dup')").run() }, // SQLITE_CONSTRAINT
    () => { a.prepare("INSERT INTO w (k) VALUES ('fresh2')").run(); throw Object.assign(new Error('biz'), { code: 'PO_NOT_FOUND', status: 404 }) },
    () => { a.prepare("INSERT INTO w (k) VALUES ('fresh3')").run(); throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' }) }, // not a SqliteError
    () => { throw new TypeError('bug') }
  ]
  for (const body of cases) {
    let calls = 0
    assert.throws(() => withWriteRetry(a, () => { calls++; body() }, { maxAttempts: 5, sleep: () => assert.fail('must not sleep') }))
    assert.equal(calls, 1)
    assert.equal(a.inTransaction, false)
  }
  assert.deepEqual(a.prepare('SELECT k FROM w').all().map((r) => r.k), ['dup'])
  const s = writeRetryStats()
  assert.equal(s.retries, 0)
  assert.equal(s.non_retryable, 4)
})

test('exhaustion rethrows the original BUSY error after maxAttempts and records it', (t) => {
  resetWriteRetryStats()
  const { a } = openPair(t)
  const err = busyError()
  let calls = 0
  const sleeps = []
  assert.throws(
    () => withWriteRetry(a, () => { calls++; throw err }, { maxAttempts: 4, baseDelayMs: 10, maxDelayMs: 25, random: () => 1, sleep: (ms) => sleeps.push(ms) }),
    (e) => e === err
  )
  assert.equal(calls, 4)
  assert.deepEqual(sleeps, [10, 20, 25])
  const s = writeRetryStats()
  assert.equal(s.retries, 3)
  assert.equal(s.exhausted, 1)
})

test('maxAttempts=1 disables retry; invalid options are rejected', (t) => {
  const { a } = openPair(t)
  let calls = 0
  assert.throws(() => withWriteRetry(a, () => { calls++; throw busyError() }, { maxAttempts: 1, sleep: noSleep }))
  assert.equal(calls, 1)
  for (const bad of [0, 11, 1.5, 'x']) {
    assert.throws(() => withWriteRetry(a, () => 1, { maxAttempts: bad }), (e) => e.code === 'WRITE_RETRY_OPTIONS_INVALID')
  }
})

test('already inside a transaction: runs once, never retries (caller owns atomicity)', (t) => {
  const { a } = openPair(t)
  let calls = 0
  const outer = a.transaction(() => withWriteRetry(a, () => { calls++; throw busyError() }, { maxAttempts: 5, sleep: () => assert.fail('no sleep') }))
  assert.throws(() => outer(), (e) => isBusyError(e))
  assert.equal(calls, 1)
})

test('async fn is rejected before it runs; promise-returning fn is rolled back', (t) => {
  const { a } = openPair(t)
  let ran = false
  assert.throws(() => withWriteRetry(a, async () => { ran = true; a.prepare("INSERT INTO w (k) VALUES ('a')").run() }), /async|同步/)
  assert.equal(ran, false, 'async fn must not start')
  assert.throws(() => withWriteRetry(a, () => { a.prepare("INSERT INTO w (k) VALUES ('b')").run(); return Promise.resolve() }), /Promise/)
  assert.throws(() => withWriteRetry(a, 'not a function'), /同步|function/)
  assert.equal(a.prepare('SELECT COUNT(*) c FROM w').get().c, 0)
  assert.equal(a.inTransaction, false)
})

test('hot write routes are wrapped in withWriteRetry', () => {
  const src = (f) => readFileSync(path.join(ROOT, f), 'utf8')
  const inv = src('server/routes/inventory.js')
  const pur = src('server/routes/purchase.js')
  const ar = src('server/routes/ar.js')
  for (const [name, text, needles] of [
    ['purchase', pur, ['createPurchaseOrder(db', 'transitionPurchaseOrder(db', 'receivePurchaseOrder(db']],
    ['ar', ar, ['confirmFunds(db', 'reviewFunds(db']],
    ['inventory', inv, ['createTransfer(db', 'shipTransfer(db', 'receiveTransfer(db']]
  ]) {
    assert.match(text, /withWriteRetry/, `${name} imports the wrapper`)
    for (const n of needles) {
      const i = text.indexOf(n)
      assert.ok(i > 0, `${name}: ${n} exists`)
      assert.match(text.slice(Math.max(0, i - 160), i), /withWriteRetry\(db,/, `${name}: ${n} is inside withWriteRetry`)
    }
  }
})

test('multi-process writers on one DB: no lost writes, no duplicates, retries recorded', { timeout: 240000 }, async (t) => {
  const dir = seededCopy(t)
  const dbPath = path.join(dir, 'gml_cosmetic.db')
  const probe = new Database(dbPath)
  probe.pragma('journal_mode = WAL')
  probe.pragma('busy_timeout = 5000')
  const supplierId = probe.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
  const poWarehouseId = probe.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get().id
  const poSkuId = probe.prepare('SELECT id FROM product_skus ORDER BY id LIMIT 1').get().id
  const src = probe.prepare('SELECT warehouse_id, sku_id, SUM(qty_on_hand) q FROM inventory_stocks GROUP BY 1,2 ORDER BY q DESC LIMIT 1').get()
  const toWh = probe.prepare("SELECT id FROM warehouses WHERE status='active' AND id<>? ORDER BY id LIMIT 1").get(src.warehouse_id).id
  const onHand = () => probe.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').get(src.warehouse_id, src.sku_id).q

  const N = 5
  const K = 12
  assert.ok(src.q > N * K + 10, 'fixture has enough stock')
  const runId = `y7${Date.now().toString(36)}`
  const before = { po: probe.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c, tr: probe.prepare('SELECT COUNT(*) c FROM stock_transfers').get().c, stock: onHand() }

  const workers = []
  for (let w = 0; w < N; w++) {
    const cfg = {
      dbPath, worker: w, iterations: K, runId, supplierId, poWarehouseId, poSkuId,
      fromWarehouseId: src.warehouse_id, toWarehouseId: toWh, trSkuId: src.sku_id,
      maxAttempts: 10, baseDelayMs: 15, maxDelayMs: 120
    }
    const child = spawn(process.execPath, [path.join(ROOT, 'tests/fixtures/write-contention-worker.mjs'), JSON.stringify(cfg)], {
      cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_SQLITE_BUSY_MS: '1' }
    })
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    const rl = readline.createInterface({ input: child.stdout })
    const lines = []
    let stderr = ''
    child.stderr.on('data', (d) => { stderr += d })
    const ready = new Promise((resolve) => rl.on('line', (l) => { lines.push(l); if (l === 'ready') resolve() }))
    const closed = once(child, 'close')
    workers.push({ child, ready, lines, closed, err: () => stderr })
  }
  await Promise.all(workers.map((w) => w.ready))

  // 父进程先占住写锁 400ms：busy_timeout 只有 1ms，所有写进程的第一次 BEGIN IMMEDIATE 必然 BUSY
  probe.exec('BEGIN IMMEDIATE')
  for (const w of workers) w.child.stdin.write('go\n')
  await delay(400)
  probe.exec('COMMIT')

  const results = []
  for (const w of workers) {
    const [code] = await w.closed
    assert.equal(code, 0, w.err())
    results.push(JSON.parse(w.lines.find((l) => l.startsWith('{"result"'))).result)
  }
  const sum = (f) => results.reduce((n, r) => n + f(r), 0)
  const failures = results.flatMap((r) => r.failures)
  // 机器很忙时个别写入可能把 10 次重试用尽——允许，但失败只能是 SQLITE_BUSY、且与"用尽"计数一一对应；
  // 不变量（无丢写 / 无重复 / 无半截提交）按**实际成功数**精确核对。
  assert.ok(failures.every((f) => String(f.code).startsWith('SQLITE_BUSY')), JSON.stringify(failures))
  assert.equal(sum((r) => r.stats.exhausted), failures.length)
  assert.equal(sum((r) => r.stats.non_retryable), 0)
  const okPo = sum((r) => r.okPo)
  const okTr = sum((r) => r.okTr)
  assert.equal(okPo + okTr + failures.length, 2 * N * K)
  assert.ok(okPo >= N * K * 0.9 && okTr >= N * K * 0.9, `most writes should succeed under retry: po=${okPo} tr=${okTr}`)

  // 没有丢写、没有重复：库里的行数恰好等于成功数
  const pos = probe.prepare("SELECT doc_no, remark FROM purchase_orders WHERE remark LIKE ?").all(`po:${runId}-%`)
  assert.equal(pos.length, okPo)
  assert.equal(new Set(pos.map((p) => p.remark)).size, okPo, 'one PO per request key')
  assert.equal(new Set(pos.map((p) => p.doc_no)).size, okPo, 'doc_no unique')
  assert.equal(probe.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c - before.po, okPo)
  const trs = probe.prepare("SELECT id, doc_no, status FROM stock_transfers WHERE remark LIKE ?").all(`tr:${runId}-%`)
  assert.equal(trs.length, okTr)
  assert.equal(new Set(trs.map((x) => x.doc_no)).size, okTr)
  assert.ok(trs.every((x) => x.status === 'shipped'))
  assert.equal(probe.prepare('SELECT COUNT(*) c FROM stock_transfers').get().c - before.tr, okTr)
  // 每张调拨单恰好一条 TR_OUT 流水（没有半截提交、也没有重复提交），库存恰好少成功数
  const ids = trs.map((x) => x.id)
  const outs = probe.prepare(`SELECT doc_id, COUNT(*) c FROM inventory_transactions WHERE doc_type='TR_OUT' AND doc_id IN (${ids.map(() => '?').join(',')}) GROUP BY doc_id`).all(...ids)
  assert.equal(outs.length, okTr)
  assert.ok(outs.every((o) => o.c === 1), 'exactly one TR_OUT per transfer')
  assert.equal(before.stock - onHand(), okTr, 'stock conserved: exactly one unit per successful transfer')

  // 重试被记录（父进程占锁，BUSY 必然发生）
  const retries = sum((r) => r.stats.retries)
  assert.ok(retries >= N, `expected at least one retry per worker, got ${retries}`)
  probe.close()
})

test('bench-api --profile=write: fixed schema, integrity verified, retries counted, bad flags refused', { timeout: 240000 }, (t) => {
  const BENCH = path.join(ROOT, 'scripts/bench-api.mjs')
  const bench = (args, env) => spawnSync(process.execPath, [BENCH, ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 150000, env: { PATH: process.env.PATH, HOME: tmpdir(), ...env }
  })
  const dir = seededCopy(t)
  const env = { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: dir }
  for (const bad of [['--profile=bogus'], ['--profile', 'write', '--retry-max', '0'], ['--profile', 'write', '--busy-ms', '-1'], ['--profile', 'write', '--contender-hold-ms', 'x']]) {
    assert.equal(bench(bad, env).status, 2, bad.join(' '))
  }
  const out = path.join(dir, 'write.json')
  // busy-ms 5 + 外部写者占锁 → BUSY 真实出现；retry-max 8 让写入最终都成功
  const r = bench(['--profile=write', '--iterations', '12', '--concurrency', '4', '--busy-ms', '5', '--retry-max', '8', '--contender-hold-ms', '25', '--contender-gap-ms', '10', '--out', out], env)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.ok(existsSync(out))
  const j = JSON.parse(readFileSync(out, 'utf8'))
  assert.deepEqual(Object.keys(j), ['schema_version', 'profile', 'generated_at', 'scope_notice', 'host', 'config', 'operations', 'contention', 'integrity', 'totals'])
  assert.equal(j.profile, 'write')
  assert.deepEqual(j.operations.map((o) => o.name), ['purchase_order_create', 'receipt_confirm', 'stock_transfer'])
  assert.deepEqual(Object.keys(j.contention), ['contender_cycles', 'contender_begin_failures', 'server_busy_log_lines', 'write_retry_log_lines', 'write_retry_exhausted_log_lines'])
  for (const o of j.operations) {
    assert.equal(o.requests, 12)
    assert.equal(o.errors, 0, `${o.name}: ${JSON.stringify(o.status_histogram)}`)
    assert.equal(o.ok, 12)
  }
  assert.equal(j.integrity.ok, true)
  assert.equal(j.integrity.purchase_order_create.duplicate_rows, 0)
  assert.equal(j.integrity.stock_transfer.stock_delta, 12)
  assert.equal(j.integrity.receipt_confirm.confirmed_rows, 12)
  assert.ok(j.contention.contender_cycles > 0, 'external writer actually ran')
  assert.equal(j.contention.write_retry_exhausted_log_lines, 0)
  assert.match(j.scope_notice, /NOT a target-host/)
})
