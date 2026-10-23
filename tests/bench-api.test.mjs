import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { percentile, summarize } from '../scripts/bench-api.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const BENCH = path.join(ROOT, 'scripts/bench-api.mjs')
const run = (args, env) => spawnSync(process.execPath, [BENCH, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 150000, env: { PATH: process.env.PATH, HOME: tmpdir(), ...env }
})

test('percentile uses nearest-rank and handles tiny samples', () => {
  const s = Array.from({ length: 100 }, (_, i) => i + 1)
  assert.equal(percentile(s, 50), 50)
  assert.equal(percentile(s, 95), 95)
  assert.equal(percentile(s, 99), 99)
  assert.equal(percentile([7], 99), 7)
  assert.equal(percentile([], 50), null)
  assert.equal(percentile([1, 2, 3, 4], 50), 2)
})

test('summarize counts 4xx/5xx and network failures as errors', () => {
  const r = summarize('x', 'GET', '/x', [1, 2, 3, 4], [200, 200, 500, 404], { network: 1 })
  assert.equal(r.requests, 5)
  assert.equal(r.errors, 3)
  assert.equal(r.error_rate, 0.6)
  assert.deepEqual(r.status_histogram, { 200: 2, 404: 1, 500: 1, network_error: 1 })
  assert.equal(r.latency_ms.p50, 2)
  assert.equal(r.latency_ms.max, 4)
})

test('refuses without explicit absolute data dir, with repository data/, or in production mode', () => {
  assert.equal(run([], { GML_RUNTIME_MODE: 'demo' }).status, 2)
  assert.equal(run([], { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: 'relative/dir' }).status, 2)
  const repo = run([], { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: path.resolve(ROOT, 'data') })
  assert.equal(repo.status, 2)
  assert.match(repo.stderr, /data/)
  const dir = mkdtempSync(path.join(tmpdir(), 'os-bench-refuse-'))
  try {
    assert.equal(run([], { GML_DATA_DIR: dir }).status, 2)
    assert.equal(run([], { GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir }).status, 2)
    assert.equal(run([], { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: dir, }).status, 2) // empty dir: no .db
    assert.equal(run(['--out', path.resolve(ROOT, 'data', 'x.json')], { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: dir }).status, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('shortest profile runs against a freshly seeded demo DB and emits the fixed schema', { timeout: 180000 }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-bench-'))
  try {
    const seed = spawnSync(process.execPath, ['scripts/reseed-all.mjs', '--force'], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { PATH: process.env.PATH, HOME: dir, GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: dir }
    })
    assert.equal(seed.status, 0, seed.stderr)
    const out = path.join(dir, 'result.json')
    const r = run(['--concurrency', '2', '--iterations', '2', '--login-iterations', '2', '--out', out], { GML_RUNTIME_MODE: 'demo', GML_DATA_DIR: dir })
    assert.equal(r.status, 0, r.stdout + r.stderr)
    assert.ok(existsSync(out))
    const j = JSON.parse(readFileSync(out, 'utf8'))
    assert.deepEqual(Object.keys(j), ['schema_version', 'generated_at', 'scope_notice', 'host', 'config', 'endpoints', 'totals', 'sqlite_busy_count'])
    assert.equal(j.schema_version, 1)
    assert.equal(j.endpoints.length, 10)
    assert.deepEqual(j.endpoints.map(e => e.name), ['login', 'dashboard_summary', 'purchase_order_list', 'purchase_order_detail', 'stock_query', 'receivable_receipt_list', 'report_operating', 'meta_health', 'order_center_overview', 'notify_meta'])
    for (const e of j.endpoints) {
      assert.deepEqual(Object.keys(e), ['name', 'method', 'route', 'requests', 'errors', 'error_rate', 'status_histogram', 'latency_ms'])
      assert.deepEqual(Object.keys(e.latency_ms), ['min', 'p50', 'p95', 'p99', 'max', 'mean'])
      assert.equal(e.requests, 2)
      assert.equal(e.errors, 0, `${e.name}: ${JSON.stringify(e.status_histogram)}`)
      assert.ok(e.latency_ms.p50 <= e.latency_ms.p95 && e.latency_ms.p95 <= e.latency_ms.p99 && e.latency_ms.p99 <= e.latency_ms.max)
    }
    assert.equal(j.totals.requests, 20)
    assert.equal(j.sqlite_busy_count, 0)
    assert.match(j.scope_notice, /NOT a target-host/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
