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
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkTimings } from '../scripts/test-timings.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SLOW_DIR = path.join(ROOT, 'tests/slow')
const ci = fs.readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const ciCode = ci.replace(/^\s*#.*$/gm, '')
const slowEntries = fs.existsSync(SLOW_DIR) ? fs.readdirSync(SLOW_DIR) : []

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
