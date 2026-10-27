/**
 * ============================================================================
 * 文件标识：tests/metrics-scopeless-report.test.mjs ｜ 测试：scopeless 指标的可机读分类、--report 与 pending 预警（ADR-0057 补充 3 / AH2）
 * ============================================================================
 * 【职责】守住：
 *     · `scopeless` 必须是 `{ category, reason, backlog? }`，category ∈ global_by_nature / no_org_column / pending，
 *       reason ≥ 20 字，pending 必须带 backlog 链接；旧的字符串写法一律红（退出 1）；
 *     · `check-metrics-scope --report` 逐条列出 scopeless 指标（含分类 / 理由 / 权限点），`--json` 可机读；
 *     · pending 超过阈值只告警不失败（CI 上是 `::warning::` 注解），退出码仍为 0；
 *     · 真实字典：没有 pending 之外的悬空项，且分类与运行时 `isScopeAware` 一致。
 * 【夹具口径】不开服务、不碰数据库；脚本以子进程运行，环境最小化。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { METRICS, isScopeAware } from '../server/lib/metrics.js'
import {
  classifyMetrics, SCOPELESS_CATEGORIES, pendingWarning, DEFAULT_MAX_PENDING, buildReport, renderOutput
} from '../scripts/check-metrics-scope.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const run = (args = [], env = {}) =>
  spawnSync(process.execPath, ['scripts/check-metrics-scope.mjs', ...args], {
    cwd: ROOT, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }
  })
const REASON = 'a long enough written reason for the guard'
const problems = (m) => classifyMetrics([{ key: 'x', perms: ['a'], ...m }]).problems.map((p) => p.issue)

test('AH2: scopeless must be an object with a known category and a reason of at least 20 characters', () => {
  assert.deepEqual([...SCOPELESS_CATEGORIES].sort(), ['global_by_nature', 'no_org_column', 'pending'])
  assert.equal(problems({ scopeless: { category: 'no_org_column', reason: REASON } }).length, 0)
  assert.equal(problems({ scopeless: { category: 'global_by_nature', reason: REASON } }).length, 0)
  assert.equal(problems({ scopeless: { category: 'made_up', reason: REASON } }).length, 1, 'unknown category')
  assert.equal(problems({ scopeless: { reason: REASON } }).length, 1, 'missing category')
  assert.equal(problems({ scopeless: { category: 'no_org_column', reason: 'too short' } }).length, 1, 'short reason')
  assert.equal(problems({ scopeless: { category: 'no_org_column', reason: '   ' + 'x'.repeat(10) } }).length, 1, 'trimmed length counts')
  assert.equal(problems({ scopeless: REASON }).length, 1, 'the legacy free-text string is no longer accepted')
  assert.equal(problems({ scopeAware: true, scopeless: { category: 'no_org_column', reason: REASON } }).length, 1, 'both declared')
  assert.equal(problems({}).length, 1, 'undeclared')
  assert.equal(problems({ scopeAware: true }).length, 0)
})

test('AH2: pending must carry a backlog link (repo doc anchor or http(s) URL); other categories may', () => {
  const ok = (backlog) => problems({ scopeless: { category: 'pending', reason: REASON, backlog } }).length === 0
  assert.equal(ok(undefined), false, 'pending without backlog')
  assert.equal(ok(''), false)
  assert.equal(ok('someday'), false, 'not a link')
  assert.equal(ok('docs/implementation/backlog.md#第十七批'), true)
  assert.equal(ok('https://github.com/osborn-studio/OS-ERP/issues/1'), true)
  assert.equal(problems({ scopeless: { category: 'no_org_column', reason: REASON, backlog: 'docs/implementation/backlog.md#x' } }).length, 0)
})

test('AH2: classifyMetrics reports category, reason and backlog per scopeless metric and counts pending', () => {
  const { rows } = classifyMetrics([
    { key: 'a', perms: ['p'], scopeAware: true },
    { key: 'b', perms: ['p'], scopeless: { category: 'pending', reason: REASON, backlog: 'docs/implementation/backlog.md#b' } },
    { key: 'c', perms: ['p'], scopeless: { category: 'global_by_nature', reason: REASON } }
  ])
  assert.deepEqual(rows.map((r) => [r.key, r.cls, r.category ?? null]), [['a', 'scopeAware', null], ['b', 'scopeless', 'pending'], ['c', 'scopeless', 'global_by_nature']])
  assert.equal(rows[1].backlog, 'docs/implementation/backlog.md#b')
})

test('AH2: pending above the threshold warns (GitHub annotation on CI) and never fails', () => {
  assert.equal(pendingWarning(2, 2), null)
  assert.match(pendingWarning(3, 2, { ci: true }), /^::warning /)
  assert.match(pendingWarning(3, 2, { ci: false }), /^warning:/)
  assert.match(pendingWarning(3, 2), /3/)
  assert.ok(Number.isInteger(DEFAULT_MAX_PENDING) && DEFAULT_MAX_PENDING >= 0)
})

test('AH2: the real dictionary passes, every scopeless metric has a machine-readable category, runtime agrees', () => {
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const { rows, problems: ps } = classifyMetrics(METRICS)
  assert.deepEqual(ps, [])
  for (const m of METRICS) {
    if (isScopeAware(m)) { assert.equal(m.scopeless, undefined, m.key); continue }
    assert.ok(SCOPELESS_CATEGORIES.includes(m.scopeless.category), m.key)
    if (m.scopeless.category === 'pending') assert.ok(m.scopeless.backlog, `${m.key} pending needs backlog`)
  }
  assert.equal(rows.filter((x) => x.cls === 'scopeless').length, METRICS.filter((m) => !isScopeAware(m)).length)
})

test('AH2: --report lists each scopeless metric with category and reason; --json is parseable; exit code stays 0', () => {
  const r = run(['--report'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const scopeless = METRICS.filter((m) => !isScopeAware(m))
  assert.ok(scopeless.length > 0)
  for (const m of scopeless) {
    assert.ok(r.stdout.includes(m.key), `${m.key} in report`)
    assert.ok(r.stdout.includes(m.scopeless.category), `${m.key} category in report`)
    assert.ok(r.stdout.includes(m.scopeless.reason.slice(0, 12)), `${m.key} reason in report`)
  }
  const j = run(['--report', '--json'])
  assert.equal(j.status, 0, j.stderr)
  const doc = JSON.parse(j.stdout)
  assert.equal(doc.total, METRICS.length)
  assert.equal(doc.scopeless.length, scopeless.length)
  assert.deepEqual(doc.scopeless.map((x) => x.key).sort(), scopeless.map((m) => m.key).sort())
  for (const x of doc.scopeless) assert.ok(SCOPELESS_CATEGORIES.includes(x.category) && x.reason && Array.isArray(x.perms), x.key)
  assert.deepEqual(Object.keys(doc.by_category).sort(), [...SCOPELESS_CATEGORIES].sort())
  assert.equal(doc.pending, doc.by_category.pending)
})

test('AH2: a pending threshold of 0 does not turn the guard red; unknown flags still exit 2', () => {
  const r = run(['--max-pending', '0'], { GITHUB_ACTIONS: 'true' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(run(['--bogus']).status, 2)
  assert.equal(run(['--max-pending', 'abc']).status, 2)
})

test('AH2: with pending over the threshold, --report --json stays pure JSON (warning goes to stderr) and the table mode appends it', () => {
  const pend = (k) => ({ key: k, perms: ['p'], module: 'm', scopeless: { category: 'pending', reason: REASON, backlog: 'docs/implementation/backlog.md#x' } })
  const { rows, problems: ps } = classifyMetrics([pend('a'), pend('b'), pend('c'), { key: 'd', perms: ['p'], scopeAware: true }])
  assert.deepEqual(ps, [])
  const rep = buildReport(rows, 2)
  assert.equal(rep.pending, 3)
  const j = renderOutput(rows, rep, { report: true, json: true, max: 2, ci: true })
  assert.equal(JSON.parse(j.out).pending, 3, 'stdout is parseable JSON')
  assert.match(j.err, /^::warning /)
  const t = renderOutput(rows, rep, { report: true, json: false, max: 2, ci: false })
  assert.match(t.out, /warning: 3/)
  assert.equal(t.err, '')
  assert.equal(renderOutput(rows, buildReport(rows, 3), { report: true, json: true, max: 3, ci: true }).err, '', 'at the threshold: no warning')
})
