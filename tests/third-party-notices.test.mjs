import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, runtimePackages, MARKER, FALLBACK_MARKER, SPDX_CHOICES } from '../scripts/gen-third-party-notices.mjs'
import { normalizeSbom } from '../scripts/gen-sbom.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'w9-notices-'))
  const w = (rel, s) => { fs.mkdirSync(path.dirname(path.join(d, rel)), { recursive: true }); fs.writeFileSync(path.join(d, rel), s) }
  w('package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: {
    '': { name: 'fx' },
    'node_modules/with-lic': { version: '1.0.0', license: 'MIT' },
    'node_modules/no-lic': { version: '2.0.0', license: 'ISC' },
    'node_modules/dev-only': { version: '3.0.0', license: 'MIT', dev: true }
  } }))
  w('node_modules/with-lic/package.json', '{"name":"with-lic","version":"1.0.0"}')
  w('node_modules/with-lic/LICENSE', 'MIT License\r\nCopyright (c) Fixture\r\n')
  w('node_modules/no-lic/package.json', '{"name":"no-lic","version":"2.0.0","license":"ISC"}')
  w('THIRD_PARTY_NOTICES.md', `# head\nhand-written\n\n${MARKER}\n\nstale generated content\n`)
  return d
}

test('fixture: license text included, missing LICENSE gets fallback marker, dev excluded, head preserved', () => {
  const d = fixture()
  try {
    const { text, stats } = generate({ root: d })
    assert.ok(text.startsWith('# head\nhand-written\n'))
    assert.equal(text.split(MARKER).length, 2)
    assert.ok(!text.includes('stale generated content'))
    assert.ok(text.includes('### with-lic@1.0.0') && text.includes('Copyright (c) Fixture'))
    assert.ok(!text.includes('\r'))
    const noLic = text.slice(text.indexOf('### no-lic@2.0.0'))
    assert.ok(noLic.includes(FALLBACK_MARKER) && noLic.includes('`ISC`'))
    assert.ok(!text.includes('dev-only'))
    assert.deepEqual(stats.fallbacks, ['no-lic@2.0.0'])
    assert.equal(generate({ root: d }).text, text)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('fixture: unregistered OR expression fails instead of silently choosing', () => {
  const d = fixture()
  try {
    const lp = path.join(d, 'package-lock.json')
    const lock = JSON.parse(fs.readFileSync(lp, 'utf8'))
    lock.packages['node_modules/no-lic'].license = '(MIT OR GPL-3.0-only)'
    fs.writeFileSync(lp, JSON.stringify(lock))
    assert.throws(() => generate({ root: d }), /SPDX_CHOICES/)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('repo: every runtime dependency is present, marker preserved once, head intact, output deterministic', () => {
  const before = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')
  const a = generate({ root: ROOT })
  const b = generate({ root: ROOT })
  assert.equal(a.text, b.text)
  const lock = JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8'))
  const pkgs = runtimePackages(lock)
  assert.ok(pkgs.length > 50)
  for (const p of pkgs) assert.ok(a.text.includes(`### ${p.name}@${p.version}\n`), `missing ${p.name}@${p.version}`)
  assert.ok(!a.text.includes('### vite@') && !a.text.includes('### typescript@'), 'dev packages must not be listed')
  assert.equal(a.text.split(MARKER).length, 2)
  const head = before.slice(0, before.indexOf(MARKER))
  assert.ok(a.text.startsWith(head.replace(/\s+$/, '')))
  for (const s of ['Medusa', 'Medici', 'node-casbin', 'Apache-2.0']) assert.ok(a.text.includes(s), `head lost ${s}`)
  for (const k of Object.keys(SPDX_CHOICES)) assert.ok(a.text.includes(`### ${k}@`))
  assert.ok(!a.text.includes(ROOT), 'no absolute paths')
})

test('repo: committed THIRD_PARTY_NOTICES.md matches the generator output', () => {
  assert.equal(fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8'), generate({ root: ROOT }).text)
})

test('sbom normalization drops volatile fields and sorts', () => {
  const raw = { serialNumber: 'urn:uuid:x', metadata: { timestamp: 't', tools: [1], component: { name: 'dir' } },
    components: [{ 'bom-ref': 'b@1' }, { 'bom-ref': 'a@1' }], dependencies: [{ ref: 'b@1', dependsOn: ['z', 'y'] }, { ref: 'a@1', dependsOn: [] }] }
  const n = normalizeSbom(raw, 'os-erp')
  assert.equal(n.serialNumber, undefined)
  assert.equal(n.metadata.timestamp, undefined)
  assert.equal(n.metadata.component.name, 'os-erp')
  assert.deepEqual(n.components.map((c) => c['bom-ref']), ['a@1', 'b@1'])
  assert.deepEqual(n.dependencies[1].dependsOn, ['y', 'z'])
})

test('sbom: generated runtime SBOM covers every lock runtime package, is deterministic, has no absolute paths', async () => {
  const { generateSbom, runtimeRefs } = await import('../scripts/gen-sbom.mjs')
  const a = generateSbom(ROOT)
  assert.equal(a, generateSbom(ROOT))
  const bom = JSON.parse(a)
  const refs = runtimeRefs(JSON.parse(fs.readFileSync(path.join(ROOT, 'package-lock.json'), 'utf8')))
  const have = new Set(bom.components.map((c) => c['bom-ref']))
  for (const r of refs) assert.ok(have.has(r), `SBOM missing ${r}`)
  assert.equal(bom.components.length, refs.size)
  assert.ok(!a.includes(ROOT) && !a.includes('serialNumber'))
  assert.equal(bom.metadata.component.name, 'os-erp')
})
