/**
 * ============================================================================
 * 文件标识：tests/check-lock-registry.test.mjs ｜ 锁文件 registry 守卫的单元测试（固定夹具，不联网，AG7）
 * ============================================================================
 * 【范围】纯函数 analyseLock / normalizeAllowHost，以及用临时夹具锁文件跑 CLI 的退出码。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { analyseLock, normalizeAllowHost, DEFAULT_ALLOWED } from '../scripts/check-lock-registry.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCRIPT = path.join(ROOT, 'scripts', 'check-lock-registry.mjs')
const INT = 'sha512-' + 'A'.repeat(86) + '=='
const pkg = (host, name = 'a', extra = {}) => ({ version: '1.0.0', resolved: `https://${host}/${name}/-/${name}-1.0.0.tgz`, integrity: INT, ...extra })
const lock = (packages) => ({ lockfileVersion: 3, packages: { '': { name: 'root' }, ...packages } })

function runCli(doc, args = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockreg-'))
  const f = path.join(dir, 'package-lock.json')
  fs.writeFileSync(f, typeof doc === 'string' ? doc : JSON.stringify(doc))
  const r = spawnSync(process.execPath, [SCRIPT, '--lock', f, ...args], { encoding: 'utf8' })
  fs.rmSync(dir, { recursive: true, force: true })
  return r
}

test('all npmjs entries pass and are counted per host', () => {
  const r = analyseLock(lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/b': pkg('registry.npmjs.org', 'b') }))
  assert.deepEqual(r.violations, [])
  assert.deepEqual(r.hosts, { 'registry.npmjs.org': 2 })
})

test('a mirror host fails by default and passes with --allow', () => {
  const doc = lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/b': pkg('registry.npmmirror.com', 'b') })
  const bad = analyseLock(doc)
  assert.equal(bad.violations.length, 1)
  assert.match(bad.violations[0], /registry\.npmmirror\.com not in allowlist/)
  assert.deepEqual(analyseLock(doc, [...DEFAULT_ALLOWED, 'registry.npmmirror.com']).violations, [])
})

test('lookalike hosts, credentials, http and non-URL values are rejected', () => {
  const cases = {
    'registry.npmjs.org.evil.example': pkg('registry.npmjs.org.evil.example'),
    'evil@': { ...pkg('registry.npmjs.org'), resolved: 'https://user:pw@registry.npmjs.org/a/-/a-1.0.0.tgz' },
    'http': { ...pkg('registry.npmjs.org'), resolved: 'http://registry.npmjs.org/a/-/a-1.0.0.tgz' },
    'git': { ...pkg('registry.npmjs.org'), resolved: 'git+ssh://git@github.com/x/y.git#abc' },
    'garbage': { ...pkg('registry.npmjs.org'), resolved: 'not a url' },
    'port': pkg('registry.npmjs.org:8443')
  }
  for (const [k, e] of Object.entries(cases)) {
    const r = analyseLock(lock({ [`node_modules/${k}`]: e }))
    assert.ok(r.violations.length >= 1, `case ${k} must fail`)
  }
  // an allowed bare host does not allow the same host with another port
  assert.ok(analyseLock(lock({ 'node_modules/p': pkg('registry.npmjs.org:8443') })).violations.length >= 1)
})

test('missing integrity, missing resolved, empty and malformed locks fail closed; links are tolerated', () => {
  assert.ok(analyseLock(lock({ 'node_modules/a': pkg('registry.npmjs.org', 'a', { integrity: undefined }) })).violations.length >= 1)
  assert.ok(analyseLock(lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/b': { version: '1.0.0' } })).violations.length >= 1)
  const withLink = analyseLock(lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/l': { resolved: 'packages/l', link: true } }))
  assert.deepEqual(withLink.violations, [])
  assert.equal(withLink.noResolved, 1)
  assert.ok(analyseLock(lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/l': { resolved: 'https://evil.example/a.tgz', link: true } })).violations.length >= 1, 'URL-valued link')
  assert.ok(analyseLock(lock({})).violations.length >= 1)
  assert.ok(analyseLock({ lockfileVersion: 1, dependencies: {} }).violations.length >= 1)
  assert.ok(analyseLock(null).violations.length >= 1)
})

test('--allow host validation rejects wildcards, schemes and paths', () => {
  assert.equal(normalizeAllowHost('Registry.NpmMirror.com'), 'registry.npmmirror.com')
  assert.equal(normalizeAllowHost('localhost:4873'), 'localhost:4873')
  for (const bad of ['*', '*.npmjs.org', 'https://x.example', 'x.example/path', '', ' ', 'a b']) assert.throws(() => normalizeAllowHost(bad), /invalid --allow host/)
})

test('CLI: exit codes, report lines and summary file', () => {
  const ok = runCli(lock({ 'node_modules/a': pkg('registry.npmjs.org') }))
  assert.equal(ok.status, 0)
  assert.match(ok.stdout, /1 {2}registry\.npmjs\.org|\s1\s+registry\.npmjs\.org/)
  const mixed = lock({ 'node_modules/a': pkg('registry.npmjs.org'), 'node_modules/b': pkg('registry.npmmirror.com', 'b') })
  const bad = runCli(mixed)
  assert.equal(bad.status, 1)
  assert.match(bad.stdout, /registry\.npmmirror\.com.*NOT ALLOWED/)
  assert.equal(runCli(mixed, ['--allow', 'registry.npmmirror.com']).status, 0)
  assert.equal(runCli('{not json').status, 1)
  assert.equal(runCli(mixed, ['--allow', '*']).status, 2)
  assert.equal(runCli(mixed, ['--bogus']).status, 2)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lockreg-s-'))
  const sum = path.join(dir, 's.json')
  runCli(mixed, ['--summary', sum])
  const s = JSON.parse(fs.readFileSync(sum, 'utf8'))
  fs.rmSync(dir, { recursive: true, force: true })
  assert.equal(s.pass, false)
  assert.equal(s.hosts['registry.npmmirror.com'], 1)
})

test('real lockfile: report runs and every host is allowed once the registry switch (AG7a) is in place', () => {
  const r = spawnSync(process.execPath, [SCRIPT], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(r.status, 0, r.stdout + r.stderr)
})

test('release-candidate.yml runs the guard once, without --allow, after the AF7 steps', () => {
  const y = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'release-candidate.yml'), 'utf8')
  const hits = y.match(/node scripts\/check-lock-registry\.mjs[^\n]*/g) || []
  assert.equal(hits.length, 2, 'repo lockfile and candidate-package lockfile')
  for (const h of hits) assert.doesNotMatch(h, /--allow/)
  assert.ok(y.indexOf('Lock registry guard') > y.indexOf('SBOM diff vs the previous candidate artifact'))
  assert.ok(y.indexOf('Lock registry guard') > y.indexOf('npm audit signatures --registry'))
  assert.equal(fs.readFileSync(path.join(ROOT, '.npmrc'), 'utf8').trim(), 'registry=https://registry.npmjs.org')
})
