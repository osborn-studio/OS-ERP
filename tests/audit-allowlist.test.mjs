/**
 * ============================================================================
 * 文件标识：tests/audit-allowlist.test.mjs ｜ 审计白名单逻辑的单元测试（固定 JSON，不联网，AC10）
 * ============================================================================
 * 【范围】只测纯函数（白名单校验、公告提取、判定），不运行 npm audit。

 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluate, validateAllowlist, gatedFindings } from '../scripts/check-audit-allowlist.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NOW = new Date('2026-10-24T12:00:00Z')
const ID = 'GHSA-mrhx-c7xc-m3w5'
const reason = 'Not reachable: dependency is unused in server code paths.'
const audit = (extra = {}) => ({
  auditReportVersion: 2,
  vulnerabilities: {
    zod: { name: 'zod', severity: 'high', via: [{ name: 'zod', severity: 'high', url: `https://github.com/advisories/${ID}` }] },
    lowpkg: { name: 'lowpkg', severity: 'low', via: [{ name: 'lowpkg', severity: 'low', url: 'https://github.com/advisories/GHSA-aaaa-bbbb-cccc' }] },
    ...extra
  }
})
const allow = (over = {}) => ({ allow: [{ advisory: ID, package: 'zod', reason, expires: '2026-12-15', ...over }] })

test('listed finding passes; low severity is ignored', () => {
  const r = evaluate(audit(), allow(), NOW)
  assert.equal(r.ok, true)
  assert.deepEqual(r.covered, [ID])
})

test('unlisted high finding fails', () => {
  const r = evaluate(audit(), { allow: [] }, NOW)
  assert.equal(r.ok, false)
  assert.match(r.failures[0], /not in the allowlist/)
})

test('expired, today-expiring, malformed and too-far dates fail', () => {
  for (const expires of ['2026-10-01', '2026-10-24', '2026-13-40', '2026-02-30', 'soon', '', '2027-12-31']) {
    assert.equal(evaluate(audit(), allow({ expires }), NOW).ok, false, expires)
  }
  assert.equal(evaluate(audit(), allow({ expires: '2026-10-25' }), NOW).ok, true)
})

test('missing/short reason, bad advisory id, duplicate and wrong package fail', () => {
  assert.equal(evaluate(audit(), allow({ reason: 'ok' }), NOW).ok, false)
  assert.equal(evaluate(audit(), allow({ advisory: 'zod' }), NOW).ok, false)
  const dup = { allow: [allow().allow[0], allow().allow[0]] }
  assert.equal(evaluate(audit(), dup, NOW).ok, false)
  assert.equal(evaluate(audit(), allow({ package: 'other' }), NOW).ok, false)
})

test('a second unlisted advisory is not hidden by a listed one', () => {
  const extra = { bar: { name: 'bar', severity: 'critical', via: [{ name: 'bar', severity: 'critical', url: 'https://github.com/advisories/GHSA-xxxx-yyyy-zzzz' }] } }
  const r = evaluate(audit(extra), allow(), NOW)
  assert.equal(r.ok, false)
  assert.ok(r.failures.some((f) => f.includes('GHSA-xxxx-yyyy-zzzz')))
})

test('transitive high with no identifiable advisory fails closed; covered chain passes', () => {
  const orphan = { baz: { name: 'baz', severity: 'high', via: ['missing'] } }
  assert.equal(evaluate(audit(orphan), allow(), NOW).ok, false)
  const chain = { baz: { name: 'baz', severity: 'high', via: ['zod'] } }
  assert.equal(evaluate(audit(chain), allow(), NOW).ok, true)
})

test('error or malformed audit output fails closed', () => {
  assert.equal(evaluate({ error: { code: 'E404' } }, allow(), NOW).ok, false)
  assert.equal(evaluate({}, allow(), NOW).ok, false)
  assert.equal(evaluate(null, allow(), NOW).ok, false)
  assert.equal(evaluate({ auditReportVersion: 2 }, allow(), NOW).ok, false)
  assert.throws(() => gatedFindings({ vulnerabilities: {} }))
})

test('stale allowlist entry is reported but does not fail; bad allowlist shape fails', () => {
  const r = evaluate({ auditReportVersion: 2, vulnerabilities: {} }, allow(), NOW)
  assert.equal(r.ok, true)
  assert.deepEqual(r.unused, [ID])
  assert.ok(validateAllowlist([], NOW).errors.length)
  assert.ok(validateAllowlist({}, NOW).errors.length)
})

test('committed allowlist is structurally valid (expiry is time-dependent, so only shape is asserted)', () => {
  const doc = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/security/audit-allowlist.json'), 'utf8'))
  const { errors } = validateAllowlist(doc, new Date('2026-10-24T00:00:00Z'))
  assert.deepEqual(errors, [])
})
