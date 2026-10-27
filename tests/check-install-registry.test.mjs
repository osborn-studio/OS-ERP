/**
 * ============================================================================
 * 文件标识：tests/check-install-registry.test.mjs ｜ 安装树 / 锁文件一致性守卫的单元与 CLI 测试（固定夹具，不联网，AH7）
 * ============================================================================
 * 【范围】纯函数 compareInstalled，以及用临时夹具文件跑 CLI 的退出码；另有一条把真实 package-lock.json 当“已安装”自比较的断言。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compareInstalled } from '../scripts/check-install-registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-install-registry.mjs')
const INT = 'sha512-' + 'A'.repeat(86) + '=='
const ent = (name, o = {}) => ({ version: '1.0.0', resolved: `https://registry.npmjs.org/${name}/-/${name}-1.0.0.tgz`, integrity: INT, ...o })
const doc = (packages) => ({ lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } })

test('identical trees pass; lockfile entries that are not installed are only counted', () => {
  const lock = doc({ 'node_modules/a': ent('a'), 'node_modules/b': ent('b', { optional: true }) })
  const r = compareInstalled(lock, doc({ 'node_modules/a': ent('a') }))
  assert.deepEqual(r, { compared: 1, notInstalled: 1, violations: [] })
})

test('a different resolved host, version or integrity is a violation', () => {
  const lock = doc({ 'node_modules/a': ent('a') })
  for (const [field, val] of [['resolved', 'https://registry.npmmirror.com/a/-/a-1.0.0.tgz'], ['version', '1.0.1'], ['integrity', 'sha512-' + 'B'.repeat(86) + '==']]) {
    const r = compareInstalled(lock, doc({ 'node_modules/a': ent('a', { [field]: val }) }))
    assert.equal(r.violations.length, 1, field)
    assert.match(r.violations[0], new RegExp(`node_modules/a: ${field} differs`))
  }
})

test('an installed package missing from the lockfile, or a missing field on one side, is a violation', () => {
  const lock = doc({ 'node_modules/a': ent('a') })
  assert.match(compareInstalled(lock, doc({ 'node_modules/a': ent('a'), 'node_modules/x': ent('x') })).violations[0], /x: installed but not in package-lock/)
  const noRes = ent('a'); delete noRes.resolved
  assert.match(compareInstalled(lock, doc({ 'node_modules/a': noRes })).violations[0], /resolved differs/)
  assert.match(compareInstalled(doc({ 'node_modules/a': noRes }), doc({ 'node_modules/a': ent('a') })).violations[0], /resolved differs/)
})

test('bundled packages (no resolved on either side) and links compare cleanly; a changed link does not', () => {
  const b = { version: '2.0.0', inBundle: true }
  assert.deepEqual(compareInstalled(doc({ 'node_modules/b': b }), doc({ 'node_modules/b': b })).violations, [])
  const l = { resolved: 'packages/l', link: true }
  assert.deepEqual(compareInstalled(doc({ 'node_modules/l': l }), doc({ 'node_modules/l': l })).violations, [])
  assert.match(compareInstalled(doc({ 'node_modules/l': l }), doc({ 'node_modules/l': { resolved: 'elsewhere', link: true } })).violations[0], /link differs/)
})

test('fail closed on unusable input', () => {
  assert.match(compareInstalled({}, doc({})).violations.join('\n'), /no "packages" map/)
  assert.match(compareInstalled(doc({}), null).violations.join('\n'), /\.package-lock\.json has no "packages" map/)
  assert.match(compareInstalled(doc({ 'node_modules/a': ent('a') }), doc({})).violations[0], /no installed package entries/)
  assert.match(compareInstalled(doc({ 'node_modules/a': ent('a') }), doc({ 'node_modules/a': 'str' })).violations[0], /not an object/)
})

function runCli(lock, installed, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instreg-'))
  const l = path.join(dir, 'package-lock.json'), i = path.join(dir, 'hidden.json')
  fs.writeFileSync(l, typeof lock === 'string' ? lock : JSON.stringify(lock))
  if (installed !== null) fs.writeFileSync(i, typeof installed === 'string' ? installed : JSON.stringify(installed))
  const r = spawnSync(process.execPath, [SCRIPT, '--lock', l, '--installed', i, '--summary', path.join(dir, 's.json'), ...args], { encoding: 'utf8' })
  const summary = fs.existsSync(path.join(dir, 's.json')) ? JSON.parse(fs.readFileSync(path.join(dir, 's.json'), 'utf8')) : null
  fs.rmSync(dir, { recursive: true, force: true })
  return { ...r, summary }
}

test('CLI: exit 0 with an honest message when equal; 1 on mismatch, missing or garbage files; 2 on bad usage', () => {
  const lock = doc({ 'node_modules/a': ent('a') })
  let r = runCli(lock, lock)
  assert.equal(r.status, 0, r.stderr); assert.match(r.stdout, /does not show which host served the downloads/); assert.equal(r.summary.pass, true)
  r = runCli(lock, doc({ 'node_modules/a': ent('a', { resolved: 'https://registry.npmmirror.com/a/-/a-1.0.0.tgz' }) }))
  assert.equal(r.status, 1); assert.match(r.stderr, /resolved differs/); assert.equal(r.summary.pass, false)
  r = runCli(lock, null); assert.equal(r.status, 1); assert.match(r.stderr, /cannot read/)
  r = runCli(lock, '{not json'); assert.equal(r.status, 1)
  r = runCli(lock, lock, ['--bogus']); assert.equal(r.status, 2)
})

test('the real package-lock.json compares clean against itself (shape sanity for the repository lockfile)', () => {
  const real = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const r = compareInstalled(real, real)
  assert.deepEqual(r.violations, [])
  assert.ok(r.compared > 100)
})
