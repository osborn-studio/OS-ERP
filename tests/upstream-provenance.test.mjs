/**
 * ============================================================================
 * 文件标识：tests/upstream-provenance.test.mjs ｜ 上游来源锁定记录的完整性与相似度脚本的夹具测试（X12）
 * ============================================================================
 * 【做什么】断言 docs/legal/upstream/<project>/SOURCE.json 字段齐全、LICENSE 非空且文本与登记的 sha256 一致、
 *   PROVENANCE.md 引用了每个项目的 commit 与每个被引用文件；并在夹具上验证 scripts/upstream-similarity.mjs。
 * 【不做什么】不联网、不重新抓取上游；不对相似度数值作法律解读。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { similarity, tokenize, sharedShingleList } from '../scripts/upstream-similarity.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PROJECTS = { medusa: 'medusajs/medusa', medici: 'flash-oss/medici', casbin: 'casbin/node-casbin' }
const REQUIRED = ['repo', 'tag', 'commit', 'fetched_at', 'license_spdx_as_declared', 'files_referenced']
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const provenance = fs.readFileSync(path.join(ROOT, 'docs/legal/PROVENANCE.md'), 'utf8')
const notices = fs.readFileSync(path.join(ROOT, 'THIRD_PARTY_NOTICES.md'), 'utf8')

for (const [dir, repo] of Object.entries(PROJECTS)) {
  const base = path.join(ROOT, 'docs/legal/upstream', dir)
  test(`${dir}: SOURCE.json complete and consistent`, () => {
    const src = JSON.parse(fs.readFileSync(path.join(base, 'SOURCE.json'), 'utf8'))
    for (const k of REQUIRED) assert.ok(src[k] !== undefined && src[k] !== '' && src[k] !== null, `missing ${k}`)
    assert.equal(src.repo, repo)
    assert.match(src.commit, /^[0-9a-f]{40}$/)
    assert.match(src.fetched_at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/)
    assert.ok(src.tag_published_at <= '2026-10-15T23:59:59Z', 'tag must not be later than the 2026-10-15 cutoff')
    assert.ok(Array.isArray(src.files_referenced) && src.files_referenced.length > 0)
    for (const f of src.files_referenced) {
      assert.ok(f.path && f.fetch_status, `file entry incomplete: ${JSON.stringify(f.path)}`)
      if (f.fetch_status === 'ok') {
        assert.match(f.sha256, /^[0-9a-f]{64}$/)
        assert.match(f.git_blob_sha, /^[0-9a-f]{40}$/)
        assert.ok(f.bytes > 0)
        assert.ok(Array.isArray(f.similarity) && f.similarity.length > 0)
      }
      assert.ok(provenance.includes(f.path), `PROVENANCE.md does not mention ${f.path}`)
    }
    assert.ok(provenance.includes(src.commit), 'PROVENANCE.md does not cite the pinned commit')
    assert.ok(notices.includes(src.commit), 'THIRD_PARTY_NOTICES.md head does not cite the pinned commit')
    assert.ok(Array.isArray(src.failures))
  })

  test(`${dir}: LICENSE files are non-empty and match the recorded hash`, () => {
    const src = JSON.parse(fs.readFileSync(path.join(base, 'SOURCE.json'), 'utf8'))
    assert.ok(src.license_files.length > 0)
    for (const l of src.license_files) {
      const buf = fs.readFileSync(path.join(base, l.file))
      assert.ok(buf.toString('utf8').trim().length > 100, `${l.file} is empty or truncated`)
      assert.equal(sha256(buf), l.sha256)
      assert.equal(buf.length, l.bytes)
    }
    assert.ok(fs.statSync(path.join(base, 'LICENSE')).size > 0)
  })
}

test('medusa: Enterprise license text is stored', () => {
  assert.ok(fs.statSync(path.join(ROOT, 'docs/legal/upstream/medusa/ENTERPRISE-LICENSE.md')).size > 0)
})

test('similarity script: fixtures', () => {
  const a = 'export function applyDiscount(itemTotal, appliedMap) { const done = appliedMap.get(itemTotal.id) ?? 0; return Math.max(0, itemTotal.amount - done) }'
  const same = similarity(a, a)
  assert.equal(same.localInUpstream, 1)
  assert.equal(same.unigramJaccard, 1)
  // renamed identifiers + snake_case + different language syntax keep sub-word overlap
  const snake = 'function apply_discount(item_total, applied_map) { const done = applied_map.get(item_total.id) || 0; return Math.max(0, item_total.amount - done) }'
  const r = similarity(a, snake)
  assert.ok(r.unigramJaccard > 0.7, `got ${r.unigramJaccard}`)
  assert.ok(r.localInUpstream > 0.3, `got ${r.localInUpstream}`)
  // unrelated text
  const other = 'SELECT name FROM users WHERE created_at > now() ORDER BY name; -- unrelated report query'
  const u = similarity(a, other)
  assert.equal(u.localInUpstream, 0)
  assert.ok(u.unigramJaccard < 0.2)
  // comments are ignored
  assert.deepEqual(tokenize('// only a comment\n/* block */ foo_bar'), ['foo', 'bar'])
  assert.deepEqual(sharedShingleList(a, a, 2).length, 2)
  // empty input does not divide by zero
  assert.equal(similarity('', '').localInUpstream, 0)
})

test('similarity script: CLI runs and prints JSON', async () => {
  const { execFileSync } = await import('node:child_process')
  const tmp = fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'x12-sim-'))
  try {
    fs.writeFileSync(path.join(tmp, 'a.js'), 'const alpha = beta + gamma + delta + epsilon + zeta\n')
    fs.writeFileSync(path.join(tmp, 'b.ts'), 'const alpha: number = beta + gamma + delta + epsilon + zeta\n')
    const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'scripts/upstream-similarity.mjs'), path.join(tmp, 'a.js'), path.join(tmp, 'b.ts'), '--json']).toString())
    assert.ok(out.unigramJaccard > 0.8)
    assert.ok(out.sharedShingles >= 1)
  } finally { fs.rmSync(tmp, { recursive: true, force: true }) }
})
