/**
 * ============================================================================
 * 文件标识：tests/sbom-diff.test.mjs ｜ SBOM 对比库与 CLI 的单元测试（AF7）
 * ============================================================================
 * 用内联夹具 SBOM 证明 diffSboms 的增 / 删 / 版本变化 / 完整性哈希变化 / 同名多版本语义、
 * 前一份 SBOM 畸形时的拒绝、表格输出的控制字符清洗，以及 scripts/sbom-diff.mjs 的退出码约定。不联网。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { diffSboms, parseSbom, renderTable, loadSbomFile } from '../scripts/lib/sbom-diff.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const comp = (name, version, extra = {}) => ({ type: 'library', name, version, 'bom-ref': `${name}@${version}`, ...extra })
const bom = (...components) => ({ bomFormat: 'CycloneDX', specVersion: '1.5', components })
const sha = (c) => [{ alg: 'SHA-512', content: c }]

test('identical SBOMs produce an empty diff', () => {
  const b = bom(comp('a', '1.0.0'), comp('b', '2.0.0'))
  const d = diffSboms(b, JSON.parse(JSON.stringify(b)))
  assert.deepEqual(d.added, [])
  assert.deepEqual(d.removed, [])
  assert.deepEqual(d.changed, [])
  assert.deepEqual(d.summary, { previous: 2, current: 2, added: 0, removed: 0, changed: 0 })
})

test('added, removed and version-changed components are classified and sorted', () => {
  const prev = bom(comp('keep', '1.0.0'), comp('gone', '1.0.0'), comp('up', '1.0.0'))
  const cur = bom(comp('keep', '1.0.0'), comp('up', '1.1.0'), comp('zeta', '3.0.0'), comp('alpha', '0.1.0'))
  const d = diffSboms(prev, cur)
  assert.deepEqual(d.added.map((x) => `${x.name}@${x.version}`), ['alpha@0.1.0', 'zeta@3.0.0'])
  assert.deepEqual(d.removed.map((x) => `${x.name}@${x.version}`), ['gone@1.0.0'])
  assert.deepEqual(d.changed, [{ name: 'up', kind: 'version', from: ['1.0.0'], to: ['1.1.0'] }])
  assert.equal(d.summary.added, 2)
})

test('same name@version with a different integrity hash is reported as an integrity change', () => {
  const d = diffSboms(bom(comp('x', '1.0.0', { hashes: sha('aaa') })), bom(comp('x', '1.0.0', { hashes: sha('bbb') })))
  assert.deepEqual(d.changed, [{ name: 'x', kind: 'integrity', version: '1.0.0', from: ['1.0.0'], to: ['1.0.0'], previousHashes: ['SHA-512:aaa'], currentHashes: ['SHA-512:bbb'] }])
})

test('a missing hash on one side only is not reported as a change', () => {
  const d = diffSboms(bom(comp('x', '1.0.0')), bom(comp('x', '1.0.0', { hashes: sha('bbb') })))
  assert.deepEqual(d.changed, [])
})

test('several versions of one package are compared as version sets', () => {
  const prev = bom(comp('ms', '2.0.0'), comp('ms', '2.1.3'))
  const cur = bom(comp('ms', '2.1.3'), comp('ms', '2.1.4'))
  const d = diffSboms(prev, cur)
  assert.deepEqual(d.added, [])
  assert.deepEqual(d.removed, [])
  assert.deepEqual(d.changed, [{ name: 'ms', kind: 'version', from: ['2.0.0', '2.1.3'], to: ['2.1.3', '2.1.4'] }])
})

test('scoped names keep their group so @scope/pkg and pkg do not collide', () => {
  const d = diffSboms(bom(comp('pkg', '1.0.0')), bom(comp('pkg', '1.0.0'), { type: 'library', group: '@scope', name: 'pkg', version: '1.0.0', 'bom-ref': '@scope/pkg@1.0.0' }))
  assert.deepEqual(d.added.map((x) => x.name), ['@scope/pkg'])
})

test('a malformed SBOM is rejected with a reason', () => {
  for (const bad of [null, [], { bomFormat: 'SPDX' }, { bomFormat: 'CycloneDX', specVersion: '2.0', components: [comp('a', '1')] },
    { bomFormat: 'CycloneDX', specVersion: '1.5' }, bom({ name: 'a' }), bom(comp('a', '1'), comp('a', '1'))]) {
    assert.throws(() => parseSbom(bad, 'prev.json'), /prev\.json/, JSON.stringify(bad))
  }
  assert.doesNotThrow(() => parseSbom(bom(), 'empty.json'), 'an empty component list is a valid (if odd) previous SBOM')
})

test('loadSbomFile rejects unreadable, non-JSON and oversized files', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbomdiff-'))
  try {
    assert.throws(() => loadSbomFile(path.join(dir, 'missing.json')), /cannot read/)
    writeFileSync(path.join(dir, 'x.json'), '{nope')
    assert.throws(() => loadSbomFile(path.join(dir, 'x.json')), /not valid JSON/)
    writeFileSync(path.join(dir, 'big.json'), '0'.repeat(64))
    assert.throws(() => loadSbomFile(path.join(dir, 'big.json'), { maxBytes: 10 }), /too large/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the table neutralises control characters and workflow-command prefixes from component names', () => {
  const d = diffSboms(bom(), bom(comp('evil\n::set-output name=x::y\u001b[31m', '1.0.0')))
  const t = renderTable(d)
  assert.doesNotMatch(t, /[\u0000-\u0009\u000b-\u001f\u007f]/)
  for (const line of t.split('\n')) assert.doesNotMatch(line, /^::/)
  assert.match(t, /Added \(1\)/)
  assert.match(renderTable(diffSboms(bom(comp('a', '1')), bom(comp('a', '1')))), /No component changes/)
})

test('CLI: exit 0 with a diff, writes json/table outputs; exit 1 for a malformed previous file', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'sbomdiff-'))
  try {
    const prev = path.join(dir, 'prev.json'); const cur = path.join(dir, 'cur.json')
    writeFileSync(prev, JSON.stringify(bom(comp('a', '1.0.0'))))
    writeFileSync(cur, JSON.stringify(bom(comp('a', '1.0.1'), comp('b', '1.0.0'))))
    const run = (...args) => spawnSync(process.execPath, ['scripts/sbom-diff.mjs', ...args], { cwd: ROOT, encoding: 'utf8' })
    let r = run(prev, cur, `--json-out=${path.join(dir, 'd.json')}`, `--table-out=${path.join(dir, 'd.txt')}`)
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /Added \(1\)/)
    const j = JSON.parse(readFileSync(path.join(dir, 'd.json'), 'utf8'))
    assert.equal(j.summary.added, 1); assert.equal(j.summary.changed, 1)
    assert.match(readFileSync(path.join(dir, 'd.txt'), 'utf8'), /Changed \(1\)/)
    writeFileSync(prev, '{"bomFormat":"nope"}')
    r = run(prev, cur)
    assert.equal(r.status, 1)
    assert.match(r.stderr, /prev\.json/)
    r = run()
    assert.equal(r.status, 2)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('review fixes: integrity change survives a version-set change; identity and version encodings do not collide', () => {
  let d = diffSboms(bom(comp('x', '1', { hashes: sha('A') })), bom(comp('x', '1', { hashes: sha('B') }), comp('x', '2')))
  assert.deepEqual(d.changed.map((c) => `${c.kind}:${c.version ?? ''}`), ['integrity:1', 'version:'])
  d = diffSboms(bom(comp('pkg', '1', { group: '@a' })), bom(comp('@a/pkg', '1')))
  assert.equal(d.summary.added + d.summary.removed, 2, 'group+name and a literal scoped name are different identities')
  d = diffSboms(bom(comp('v', 'a'), comp('v', 'b')), bom(comp('v', 'a\u0000b')))
  assert.equal(d.summary.changed, 1, 'version sets are compared element-wise')
})

test('review fixes: malformed hashes are rejected, huge component lists are capped, workflow commands are neutralised even after indentation', () => {
  assert.throws(() => parseSbom(bom(comp('a', '1', { hashes: [{ alg: 'SHA-512', content: 7 }] })), 'p.json'), /hash/)
  assert.throws(() => parseSbom({ bomFormat: 'CycloneDX', specVersion: '1.5', components: new Array(50001).fill(0) }, 'p.json'), /more than/)
  const t = renderTable(diffSboms(bom(), bom(comp('::error::x', '1'), comp('a##[warning]b', '1'))))
  assert.doesNotMatch(t, /::/)
  assert.doesNotMatch(t, /##\[/)
  assert.throws(() => parseSbom(bom(comp('a', '1', { 'bom-ref': 'r' }), comp('b', '1', { 'bom-ref': 'r' })), 'p.json'), /duplicate bom-ref/)
  assert.throws(() => parseSbom(bom(comp('a', '1', { 'bom-ref': 'r\n::error::z' }), comp('b', '1', { 'bom-ref': 'r\n::error::z' })), 'p.json'), (e) => !/\n::|::error/.test(e.message) && /duplicate bom-ref/.test(e.message))
})
