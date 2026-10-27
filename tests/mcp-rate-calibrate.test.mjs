// AH9（ADR-0056 补充 4）：scripts/mcp-rate-calibrate.mjs —— 读 Prometheus 文本导出，给出 OsErpMcpRateStoreWaitHigh 的建议阈值与推导；只读，不改任何配置。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseWaitHistogram, quantile, suggestThreshold, assertLoopbackUrl } from '../scripts/mcp-rate-calibrate.mjs'
import { renderPrometheus } from '../server/lib/metrics-export.js'
import { HISTOGRAM_DEFS } from '../server/lib/process-counters.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = path.join(ROOT, 'scripts/mcp-rate-calibrate.mjs')
const BOUNDS = HISTOGRAM_DEFS.mcp_rate_store_wait_seconds.buckets

/** 由「每个桶内的样本数」造一份真实格式的导出（走真正的渲染器，不手写文本） */
function exportText(perBucket, infCount = 0, sum = 1) {
  let acc = 0
  const buckets = BOUNDS.map((le, i) => { acc += perBucket[i] ?? 0; return { le, count: acc } })
  const count = acc + infCount
  return renderPrometheus({
    ops: { last_backup: { result: 'none' }, migration_checksums: {}, login_throttle: 'ok', disk_free_bytes: 1, db_sizes: {} },
    retry: {}, counters: {}, histograms: { mcp_rate_store_wait_seconds: { buckets, count, sum } }, version: 'v', mcpDeniedRows: 0
  })
}
const fast = () => { const a = BOUNDS.map(() => 0); a[BOUNDS.indexOf(0.0005)] = 10_000; return a } // 全部 ≤ 0.5 ms
const run = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env }, timeout: 30000 })

test('parseWaitHistogram: reads cumulative buckets, +Inf, count and sum from a real export; ignores other families', () => {
  const per = fast(); per[BOUNDS.indexOf(0.025)] = 40
  const h = parseWaitHistogram(exportText(per, 3, 12.5))
  assert.equal(h.count, 10_043)
  assert.equal(h.inf, 3)
  assert.equal(h.sum, 12.5)
  assert.deepEqual(h.buckets.map((b) => b.le), BOUNDS)
  assert.equal(h.buckets.at(-1).count, 10_040)
  assert.equal(parseWaitHistogram('# nothing\nos_erp_other 1\n'), null)
  assert.equal(parseWaitHistogram(''), null)
})

test('parseWaitHistogram: rejects non-monotonic buckets and malformed values instead of guessing', () => {
  const bad = exportText(fast()).replace(/(os_erp_mcp_rate_store_wait_seconds_bucket\{le="0.001"\}) \d+/, '$1 3')
  assert.throws(() => parseWaitHistogram(bad), /单调|monotonic/i)
  assert.throws(() => parseWaitHistogram('os_erp_mcp_rate_store_wait_seconds_bucket{le="0.5"} abc\n'), /数值|invalid/i)
})

test('quantile: histogram_quantile interpolation; q in the +Inf bucket reports Infinity', () => {
  const per = BOUNDS.map(() => 0); per[BOUNDS.indexOf(0.01)] = 100 // 全部落在 (0.005, 0.01]
  const h = parseWaitHistogram(exportText(per))
  assert.ok(Math.abs(quantile(h, 0.5) - 0.0075) < 1e-9)
  assert.ok(Math.abs(quantile(h, 1) - 0.01) < 1e-9)
  const slow = parseWaitHistogram(exportText(BOUNDS.map(() => 0), 100))
  assert.equal(quantile(slow, 0.95), Infinity)
  assert.ok(Number.isNaN(quantile(parseWaitHistogram(exportText(BOUNDS.map(() => 0))), 0.5)), 'no samples => NaN')
})

test('suggestThreshold: too few samples => no suggestion; healthy (p99.9 <= 20 ms) => keep 100 ms; slow host => 4x p99.9 (>= 50 ms)', () => {
  const few = BOUNDS.map(() => 0); few[0] = 200
  assert.equal(suggestThreshold(parseWaitHistogram(exportText(few))).verdict, 'insufficient_samples')

  const healthy = suggestThreshold(parseWaitHistogram(exportText(fast())))
  assert.equal(healthy.verdict, 'keep')
  assert.equal(healthy.suggested_ms, 100)
  assert.ok(healthy.p999_ms <= 20)

  const slowPer = BOUNDS.map(() => 0); slowPer[BOUNDS.indexOf(0.001)] = 9_000; slowPer[BOUNDS.indexOf(0.05)] = 1_000 // p99.9 落在 (25, 50] ms
  const slow = suggestThreshold(parseWaitHistogram(exportText(slowPer)))
  assert.equal(slow.verdict, 'raise')
  assert.ok(slow.p999_ms > 25 && slow.p999_ms <= 50)
  assert.equal(slow.suggested_ms, Math.round(slow.p999_ms * 4))
  assert.ok(slow.suggested_ms >= 100 && slow.derivation.length >= 3)

  const mid = BOUNDS.map(() => 0); mid[BOUNDS.indexOf(0.001)] = 9_990; mid[BOUNDS.indexOf(0.025)] = 10 // p99.9 约 21~25 ms 之间
  const m = suggestThreshold(parseWaitHistogram(exportText(mid)))
  assert.ok(m.suggested_ms >= 50, 'never below the 50 ms floor')
})

test('suggestThreshold: p99.9 in the +Inf bucket => escalate (investigate), never a number to paper over it', () => {
  const per = fast()
  const r = suggestThreshold(parseWaitHistogram(exportText(per, 50)))
  assert.equal(r.verdict, 'investigate')
  assert.equal(r.suggested_ms, null)
})

test('assertLoopbackUrl: only http(s) to localhost / 127.0.0.0/8 / [::1]; everything else (incl. lookalikes, userinfo, other schemes) is refused', () => {
  for (const ok of ['http://127.0.0.1:3000/api/meta/metrics?format=prometheus', 'http://localhost:3000/x', 'https://[::1]:8443/x', 'http://127.1.2.3/x']) assert.doesNotThrow(() => assertLoopbackUrl(ok), ok)
  for (const bad of ['http://example.com/x', 'http://127.0.0.1.evil.com/x', 'http://evil.com@127.0.0.1/x', 'http://localhost.evil.com/', 'ftp://127.0.0.1/x', 'file:///etc/passwd', 'http://0.0.0.0/x', 'http://192.168.1.5/x', 'http://[::ffff:8.8.8.8]/x', 'javascript:1', 'not a url', 'http://user:pw@127.0.0.1/x']) {
    assert.throws(() => assertLoopbackUrl(bad), /loopback|回环|URL/i, bad)
  }
})

test('CLI: file input prints the suggestion with derivation, exits 0, writes nothing', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ah9-cal-'))
  try {
    const f = path.join(dir, 'm.prom')
    const slowPer = BOUNDS.map(() => 0); slowPer[BOUNDS.indexOf(0.001)] = 9_000; slowPer[BOUNDS.indexOf(0.05)] = 1_000
    writeFileSync(f, exportText(slowPer))
    const before = readdirSync(dir).map((n) => [n, statSync(path.join(dir, n)).mtimeMs])
    const r = run([f])
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /OsErpMcpRateStoreWaitHigh/)
    assert.match(r.stdout, /p99\.9/)
    assert.match(r.stdout, /建议阈值/)
    assert.match(r.stdout, /不修改任何配置|changes nothing/i)
    assert.deepEqual(readdirSync(dir).map((n) => [n, statSync(path.join(dir, n)).mtimeMs]), before, 'input untouched, no new files')
    const j = run([f, '--json'])
    const out = JSON.parse(j.stdout)
    assert.equal(out.verdict, 'raise')
    assert.ok(Number.isFinite(out.suggested_ms) && Array.isArray(out.derivation))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('CLI: usage errors and refusals exit 2 without touching the network (remote URL, missing arg, unreadable file, no histogram)', () => {
  assert.equal(run([]).status, 2)
  const remote = run(['http://example.com/api/meta/metrics?format=prometheus'])
  assert.equal(remote.status, 2)
  assert.match(remote.stderr, /回环|loopback/i)
  assert.equal(run(['/nonexistent/file.prom']).status, 2)
  const dir = mkdtempSync(path.join(tmpdir(), 'os-erp-ah9-cal-'))
  try {
    const f = path.join(dir, 'empty.prom'); writeFileSync(f, '# HELP x y\n')
    const r = run([f])
    assert.equal(r.status, 2)
    assert.match(r.stderr, /os_erp_mcp_rate_store_wait_seconds/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const runAsync = (args, env = {}) => new Promise((resolve) => {
  const c = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...env } })
  let stdout = ''; let stderr = ''
  c.stdout.on('data', (d) => { stdout += d }); c.stderr.on('data', (d) => { stderr += d })
  c.on('close', (status) => resolve({ status, stdout, stderr }))
})

test('CLI: a loopback URL is fetched with the bearer token from GML_METRICS_TOKEN; redirects are refused', async () => {
  const seen = []
  const srv = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization })
    if (req.url.startsWith('/redir')) { res.writeHead(302, { location: 'http://example.com/steal' }); return res.end() }
    res.writeHead(200, { 'content-type': 'text/plain' }); res.end(exportText(fast()))
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    const token = 'x'.repeat(40)
    const ok = await runAsync([`http://127.0.0.1:${port}/api/meta/metrics?format=prometheus`], { GML_METRICS_TOKEN: token })
    assert.equal(ok.status, 0, ok.stderr)
    assert.match(ok.stdout, /keep|保持/)
    assert.deepEqual(seen, [{ url: '/api/meta/metrics?format=prometheus', auth: `Bearer ${token}` }])
    assert.ok(!ok.stdout.includes(token) && !ok.stderr.includes(token), 'token never printed')
    seen.length = 0
    const redir = await runAsync([`http://127.0.0.1:${port}/redir`], { GML_METRICS_TOKEN: token })
    assert.equal(redir.status, 2)
    assert.equal(seen.length, 1, 'the redirect target was not requested')
    assert.ok(!redir.stderr.includes(token))
  } finally { srv.close() }
})

test('CLI: the script only reads - no fs writes, no env/config mutation APIs in its source', () => {
  const src = readFileSync(SCRIPT, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.ok(!/writeFile|appendFile|mkdir|rmSync|unlink|rename\(|copyFile|createWriteStream|execSync|spawn\(|process\.env\.\w+\s*=[^=]/.test(src))
})
