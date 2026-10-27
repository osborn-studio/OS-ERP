/**
 * ============================================================================
 * 文件标识：tests/test-tree-policy.test.mjs ｜ 测试树策略：tests/slow 只含带 `// slow:` 理由头的文件，门禁与 slow-tests 互不重叠（AH1）
 * ============================================================================
 * 便宜、诚实的静态断言（不跑测试、不联网）：
 *   · tests/slow/ 下每个 *.test.mjs 的前 5 行内有 `// slow: <理由>`（理由非空、≥ 10 字符），且该目录无其他种类的文件；
 *   · 焦点套件命令（package.json test:focused、ci.yml checks job）只含 `tests/*.test.mjs`，不含 tests/slow；
 *   · ci.yml 有 `slow-tests` job，且它跑的是 tests/slow、上传 test-timings artifact；
 *   · docs/implementation/test-timings.json 与目录一致（没有 > 阈值的非 slow 文件）；
 *   · 负载常量文件存在，且被所有 slow 文件之外的"已迁移"测试使用（见 LOAD_TOLERANT）。
 * 不证明托管 runner 上耗时一定在阈值内——那是 `scripts/test-timings.mjs --run` 的度量，不是本文件的断言。
 * ============================================================================
 */
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { checkTimings } from '../scripts/test-timings.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SLOW_DIR = path.join(ROOT, 'tests/slow')
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const ciCode = ci.replace(/^\s*#.*$/gm, '')
const slowEntries = fs.existsSync(SLOW_DIR) ? fs.readdirSync(SLOW_DIR) : []

test('slow wait budgets preserve default deadlines and scale only waits in a fresh process', () => {
  const script = `import { SLOW_WAIT, WRITE_BENCH } from './tests/lib/load-tolerance.mjs'; console.log(JSON.stringify({ waits: SLOW_WAIT, retry: WRITE_BENCH }))`
  const read = factor => {
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { PATH: process.env.PATH, GML_TEST_LOAD_FACTOR: factor }, encoding: 'utf8', timeout: 10000 })
    assert.equal(r.status, 0, r.stderr); return JSON.parse(r.stdout)
  }
  const normal = read('1'), loaded = read('2'), capped = read('100')
  assert.deepEqual(normal.waits, {
    probeMs: 5000, bootstrapMs: 30000, cliMs: 120000, httpShortMs: 10000,
    httpCaseMs: 90000, serverCaseMs: 300000, candidateCaseMs: 290000,
    extendedReadyAttempts: 2400, productionReadyAttempts: 250, archivePauseAttempts: 600, profileAttempts: 100
  })
  for (const [key, value] of Object.entries(normal.waits)) {
    assert.equal(loaded.waits[key], value * 2, key)
    assert.equal(capped.waits[key], value * 20, key)
  }
  assert.deepEqual(loaded.retry, normal.retry, 'contention behaviour/retry budget is never scaled')
})

test('tests/slow contains only *.test.mjs files and each starts with a `// slow: <reason>` header line', () => {
  assert.ok(slowEntries.length > 0, 'tests/slow must exist and hold the >60 s files')
  for (const f of slowEntries) {
    assert.match(f, /\.test\.mjs$/, `tests/slow/${f}: only *.test.mjs files belong here`)
    const head = fs.readFileSync(path.join(SLOW_DIR, f), 'utf8').split('\n').slice(0, 5)
    const line = head.find((l) => /^\/\/ slow:/.test(l))
    assert.ok(line, `tests/slow/${f}: needs a "// slow: <reason>" line within its first 5 lines`)
    assert.ok(line.replace(/^\/\/ slow:\s*/, '').trim().length >= 10, `tests/slow/${f}: the slow reason is too short`)
  }
})

test('files outside tests/slow do not carry a `// slow:` header (the header means "lives in tests/slow")', () => {
  for (const f of fs.readdirSync(path.join(ROOT, 'tests')).filter((x) => x.endsWith('.test.mjs'))) {
    const head = fs.readFileSync(path.join(ROOT, 'tests', f), 'utf8').split('\n').slice(0, 5)
    assert.ok(!head.some((l) => /^\/\/ slow:/.test(l)), `tests/${f} has a slow header but is not under tests/slow`)
  }
})

test('the focused suite command excludes tests/slow; slow-tests runs only tests/slow', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))
  assert.match(pkg.scripts['test:focused'], /tests\/\*\.test\.mjs/)
  assert.doesNotMatch(pkg.scripts['test:focused'], /tests\/slow|tests\/\*\*/)
  assert.match(pkg.scripts['test:slow'] || '', /tests\/slow\/\*\.test\.mjs/)
  const checks = ciCode.match(/^  checks:\n[\s\S]*?(?=^  \S)/m)?.[0] || ''
  assert.ok(checks, 'checks job exists')
  assert.match(checks, /npm run test:focused/)
  assert.doesNotMatch(checks, /tests\/slow/)
})

test('ci.yml slow-tests job: ubuntu, time-boxed, runs tests/slow with the timing script, uploads the timings artifact, appended after the other jobs', () => {
  const job = ciCode.match(/^  slow-tests:\n[\s\S]*?(?=^  \S|(?![\s\S]))/m)?.[0] || ''
  assert.ok(job, 'jobs.slow-tests must exist')
  assert.match(job, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.ok(Number(job.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]) <= 120)
  assert.match(job, /scripts\/test-timings\.mjs --run/)
  assert.match(job, /tests\/slow\/\*\.test\.mjs/)
  assert.match(job, /actions\/upload-artifact@[0-9a-f]{40}/)
  assert.match(job, /test-timings/)
  const names = [...ciCode.matchAll(/^  ([a-z][a-z0-9-]*):\n(?=    )/gm)].map((x) => x[1])
  assert.ok(names.indexOf('slow-tests') > names.indexOf('checks'))
  for (const u of job.matchAll(/^\s+-?\s*uses:\s*(\S+)/gm)) assert.match(u[1], /@[0-9a-f]{40}$/, u[1])
})

test('docs/implementation/test-timings.json agrees with the directory layout', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/implementation/test-timings.json'), 'utf8'))
  assert.deepEqual(checkTimings(doc, ROOT), [])
  for (const f of slowEntries) assert.ok(doc.slow_files.includes(`tests/slow/${f}`), `${f} is in tests/slow but not in slow_files`)
})

test('docs/implementation/testing.md exists and names the slow directory, the timing script and the load factor', () => {
  const md = fs.readFileSync(path.join(ROOT, 'docs/implementation/testing.md'), 'utf8')
  for (const needle of ['tests/slow', 'scripts/test-timings.mjs', 'GML_TEST_LOAD_FACTOR', 'tests/lib/load-tolerance.mjs']) assert.ok(md.includes(needle), needle)
})

test('every ../ import in the scanned test files resolves (a moved file with a stale path fails here, not in CI)', () => {
  const files = [...slowEntries.map((f) => path.join(SLOW_DIR, f)), ...fs.readdirSync(path.join(ROOT, 'tests/lib')).map((f) => path.join(ROOT, 'tests/lib', f)), path.join(ROOT, 'tests/write-contention.test.mjs'), path.join(ROOT, 'tests/release-signing.test.mjs')]
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8')
    // only `../` specifiers (a `./` inside a fixture string is not an import) at the start of a statement or call: `from '…'`, `import('…')`, `require('…')`
    for (const m of text.matchAll(/(?:\bfrom\s+|\bimport\(\s*|\brequire\(\s*)(['"])(\.\.\/[^'"]+)\1/g)) {
      // ESM specifiers are URLs: a cache-busting query/fragment is not part of the filename.
      // CommonJS require still resolves a literal filesystem path.
      const target = m[0].startsWith('require')
        ? path.resolve(path.dirname(file), m[2])
        : fileURLToPath(new URL(m[2], pathToFileURL(file)))
      assert.ok(fs.existsSync(target), `${path.relative(ROOT, file)}: ${m[2]} does not resolve (${path.relative(ROOT, target)})`)
    }
  }
})

test('the isolated regression runner (regress-all) discovers tests/slow as well as tests/', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/regress-all.mjs'), 'utf8')
  assert.match(src, /\['tests', 'tests\/slow'\]/)
})

test('the timing runner forwards GML_TEST_LOAD_FACTOR to the test processes', () => {
  assert.match(fs.readFileSync(path.join(ROOT, 'scripts/test-timings.mjs'), 'utf8'), /env\.GML_TEST_LOAD_FACTOR = process\.env\.GML_TEST_LOAD_FACTOR/)
})

test('the required regression status fails when focused or slow/no-FTS testing fails or is cancelled', () => {
  const job = ciCode.match(/^  regression:\n[\s\S]*?(?=^  \S)/m)?.[0] || ''
  assert.match(job, /needs: \[checks, slow-tests\]/)
  assert.match(job, /if: \$\{\{ always\(\) \}\}/)
  assert.match(job, /test '\$\{\{ needs.checks.result \}\}' = success/)
  assert.match(job, /test '\$\{\{ needs.slow-tests.result \}\}' = success/)
  assert.ok(job.indexOf('Require focused and slow test success') < job.indexOf('actions/checkout@'))
})
