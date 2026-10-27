/**
 * ============================================================================
 * 文件标识：tests/test-timings.test.mjs ｜ scripts/test-timings.mjs 的单元测试（TAP 解析、阈值归类、--check，AH1）
 * ============================================================================
 * 【范围】纯函数 parseTap / summarize / checkTimings，以及对一个临时夹具测试文件跑一次 `--run`（隔离输出目录）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { parseTap, summarize, checkTimings, DEFAULT_THRESHOLD_S } from '../scripts/test-timings.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'test-timings.mjs')

const TAP = `TAP version 13
# Subtest: first
ok 1 - first
  ---
  duration_ms: 51.5
  type: 'test'
  ...
# Subtest: suite
    # Subtest: inner
    ok 1 - inner
      ---
      duration_ms: 9999
      type: 'test'
      ...
    1..1
ok 2 - suite
  ---
  duration_ms: 12.25
  type: 'suite'
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP no fts5
  ---
  duration_ms: 0.1
  ...
# Subtest: broken
not ok 4 - broken
  ---
  duration_ms: 300
  ...
1..4
# tests 5
# suites 1
# pass 3
# fail 1
# cancelled 0
# skipped 1
# todo 0
`

test('parseTap reads only top-level cases, their durations, skip flags and the summary counts', () => {
  const { cases, counts } = parseTap(TAP)
  assert.deepEqual(cases.map((c) => c.name), ['first', 'suite', 'skipped one', 'broken'])
  assert.equal(cases[0].duration_ms, 51.5)
  assert.equal(cases[2].skipped, true)
  assert.equal(cases[3].ok, false)
  assert.equal(counts.pass, 3)
  assert.equal(counts.fail, 1)
  assert.equal(counts.skipped, 1)
})

test('summarize puts only files over the threshold into slow_files', () => {
  const files = [{ file: 'tests/a.test.mjs', duration_ms: 59999 }, { file: 'tests/b.test.mjs', duration_ms: 60001 }]
  const s = summarize(files, DEFAULT_THRESHOLD_S)
  assert.deepEqual(s.slow_files, ['tests/b.test.mjs'])
  assert.equal(s.total_ms, 120000)
})

test('checkTimings flags a slow file outside tests/slow, a vanished file and an untimed slow file', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-'))
  fs.mkdirSync(path.join(root, 'tests/slow'), { recursive: true })
  fs.writeFileSync(path.join(root, 'tests/a.test.mjs'), '')
  fs.writeFileSync(path.join(root, 'tests/slow/z.test.mjs'), '')
  const ok = { threshold_s: 60, files: [{ file: 'tests/a.test.mjs', duration_ms: 1000 }, { file: 'tests/slow/z.test.mjs', duration_ms: 90000 }] }
  assert.deepEqual(checkTimings(ok, root), [])
  const bad = { threshold_s: 60, files: [{ file: 'tests/a.test.mjs', duration_ms: 61000 }, { file: 'tests/gone.test.mjs', duration_ms: 1 }] }
  const problems = checkTimings(bad, root).join('\n')
  assert.match(problems, /tests\/a\.test\.mjs took 61 s/)
  assert.match(problems, /gone\.test\.mjs is listed .* no longer exists/)
  assert.match(problems, /tests\/slow\/z\.test\.mjs has no recorded timing/)
})

test('--run on a fixture file writes the JSON and exits 1 when a file fails; the committed timings file passes --check', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-run-'))
  const fx = path.join(dir, 'fx.test.mjs')
  fs.writeFileSync(fx, "import test from 'node:test'\ntest('slowish', async () => { await new Promise((r) => setTimeout(r, 120)) })\ntest('fails', () => { throw new Error('x') })\n")
  const out = path.join(dir, 'out.json')
  const r = spawnSync(process.execPath, [SCRIPT, '--run', '--output', out, '--threshold-s', '0.05', fx], { cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir } })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const doc = JSON.parse(fs.readFileSync(out, 'utf8'))
  assert.equal(doc.files.length, 1)
  assert.equal(doc.files[0].fail, 1)
  assert.equal(doc.files[0].slowest[0].name, 'slowish')
  assert.equal(doc.slow_files.length, 1)
  const c = spawnSync(process.execPath, [SCRIPT, '--check'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(c.status, 0, c.stdout + c.stderr)
})

test('timing children receive disposable data paths and cleaned-up temporary storage', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-isolation-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const result = path.join(dir, 'paths.json')
  const fx = path.join(dir, 'isolated.test.mjs')
  fs.writeFileSync(fx, `import test from 'node:test'; import fs from 'node:fs'; import assert from 'node:assert/strict';
    test('isolated data', () => { assert.ok(process.env.GML_DATA_DIR); fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({data: process.env.GML_DATA_DIR, home: process.env.HOME})); });`)
  const r = spawnSync(process.execPath, [SCRIPT, '--run', '--output', path.join(dir, 'out.json'), fx], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const dirs = JSON.parse(fs.readFileSync(result, 'utf8'))
  assert.ok(path.relative(ROOT, dirs.data).startsWith('..' + path.sep), 'data stays outside the checkout')
  assert.equal(fs.existsSync(dirs.data), false, 'the timing runner cleans its own data path')
  assert.equal(fs.existsSync(dirs.home), false)
})

test('timing failures expose bounded redacted case names and process failure codes', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-diagnostics-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const fx = path.join(dir, 'failed.test.mjs')
  const opaque = 'x'.repeat(48)
  fs.writeFileSync(fx, `import test from 'node:test'; test('repro ${opaque}', () => { throw Error('private payload must not be printed') });`)
  const out = path.join(dir, 'out.json')
  const r = spawnSync(process.execPath, [SCRIPT, '--run', '--output', out, fx], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 1)
  assert.match(r.stdout, /repro \[REDACTED\]/)
  assert.ok(!r.stdout.includes(opaque))
  assert.ok(!r.stdout.includes('private payload'))
  assert.deepEqual(JSON.parse(fs.readFileSync(out)).files[0].failed_cases, ['repro [REDACTED]'])
})
