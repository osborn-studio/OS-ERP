/**
 * ============================================================================
 * 文件标识：tests/changelog.test.mjs ｜ CHANGELOG.md 生成器（Y9）：确定性、幂等、手写头保留、批次映射完整
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { generate, extractDecision, decisionSection, batchOf, MARKER, BATCHES } from '../scripts/gen-changelog.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fixture(adrs, changelog) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'y9-changelog-'))
  fs.mkdirSync(path.join(d, 'docs/implementation'), { recursive: true })
  for (const [name, body] of Object.entries(adrs)) fs.writeFileSync(path.join(d, 'docs/implementation', name), body)
  if (changelog !== undefined) fs.writeFileSync(path.join(d, 'CHANGELOG.md'), changelog)
  return d
}

test('extractDecision: first paragraph under the decision heading, markdown stripped, headings/tables skipped', () => {
  assert.equal(extractDecision('# T\n\n## 背景\n\nbg\n\n## 决定\n\n### 子标题\n\n**加固**：做 `X`。\n第二行。\n\n后一段\n'), '加固：做 `X`。 第二行。')
  assert.equal(extractDecision('# T\n\n## 决策\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n真正的段落\n'), '真正的段落')
  assert.equal(extractDecision('# T\n\n## 问题与决定\n\n正文\n'), '正文')
  assert.equal(decisionSection('# T\n\n## 问题与决定\n\n正文\n').heading, '问题与决定')
  assert.equal(extractDecision('# T\n\n## 会话契约\n\n无决定段\n'), null)
  assert.equal(extractDecision('# T\n\n## 决定\n\n## 下一节\n\n不属于决定\n'), null)
  const long = extractDecision(`# T\n\n## 决定\n\n${'字'.repeat(500)}\n`)
  assert.ok(long.length <= 241 && long.endsWith('…'))
})

test('fixture: grouped by batch, ordered by ADR number, hand-written head preserved, idempotent', () => {
  const d = fixture({
    'ADR-0013-b.md': '# ADR-0013：乙\n\n## 决定\n\n乙的决定。\n',
    'ADR-0002-a.md': '# ADR-0002：甲\n\n## 决定\n\n甲的决定。\n',
    'ADR-0004-x.md': '# ADR-0004：无决定\n\n## 契约\n\n正文\n',
    'ADR-0004-y.md': '# ADR-0004：另一个\n\n## 决定\n\n另一个决定。\n',
    'notes.md': '# not an ADR\n'
  }, `# 变更记录\n手写头\n\n${MARKER}\n\n旧的生成内容\n`)
  try {
    const { text, unmapped } = generate({ root: d })
    assert.deepEqual(unmapped, [])
    assert.ok(text.startsWith('# 变更记录\n手写头\n'))
    assert.equal(text.split(MARKER).length, 2)
    assert.ok(!text.includes('旧的生成内容') && !text.includes('not an ADR'))
    const pos = s => text.indexOf(s)
    assert.ok(pos('ADR-0002') < pos('ADR-0004-另一个') || pos('甲的决定') > -1)
    // 新批次在前、同批内编号升序；同号按文件名升序
    assert.ok(pos(BATCHES.find(b => b.id === 3).title) < pos(BATCHES.find(b => b.id === 2).title))
    assert.ok(pos(BATCHES.find(b => b.id === 2).title) < pos(BATCHES.find(b => b.id === 1).title))
    assert.ok(pos('ADR-0004：无决定') < pos('ADR-0004：另一个'))
    assert.ok(text.includes('（ADR 未写出“决定”段，仅列标题）'))
    assert.ok(!text.includes('甲的决定。（摘自'), 'plain 决定 section is not relabelled')
    fs.writeFileSync(path.join(d, 'CHANGELOG.md'), text)
    assert.equal(generate({ root: d }).text, text, 'idempotent')
    assert.ok(!/\d{4}-\d{2}-\d{2}T|\/tmp|os-erp/i.test(text.slice(text.indexOf(MARKER))), 'no timestamps or absolute paths')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('fixture: without an existing file the default head is used; unmapped ADR numbers go to an explicit group, not dropped', () => {
  const d = fixture({ 'ADR-0999-z.md': '# ADR-0999：未来\n\n## 决定\n\n某决定。\n' })
  try {
    const { text, unmapped } = generate({ root: d })
    assert.deepEqual(unmapped, ['ADR-0999-z.md'])
    assert.ok(text.includes(MARKER) && text.includes('未归批') && text.includes('ADR-0999'))
    assert.equal(batchOf(999), null)
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('--check: exits 1 on drift with a clear message, 0 when current', () => {
  const d = fixture({ 'ADR-0001-a.md': '# ADR-0001：甲\n\n## 决定\n\n甲。\n' })
  try {
    const run = (...a) => spawnSync(process.execPath, [path.join(ROOT, 'scripts/gen-changelog.mjs'), `--root=${d}`, ...a], { encoding: 'utf8' })
    assert.equal(run().status, 0)
    assert.equal(run('--check').status, 0)
    fs.appendFileSync(path.join(d, 'CHANGELOG.md'), '\n手动改动\n')
    const r = run('--check')
    assert.equal(r.status, 1)
    assert.match(r.stderr, /CHANGELOG\.md is stale/)
    fs.rmSync(path.join(d, 'CHANGELOG.md'))
    assert.equal(run('--check').status, 1, 'missing file is drift')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('repo: CHANGELOG.md is current, every ADR is mapped to a batch, claims no readiness', () => {
  const { text, unmapped, count } = generate({ root: ROOT })
  assert.deepEqual(unmapped, [])
  assert.equal(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), text, 'run: node scripts/gen-changelog.mjs')
  const adrs = fs.readdirSync(path.join(ROOT, 'docs/implementation')).filter(f => /^ADR-\d{4}-.*\.md$/.test(f))
  assert.equal(count, adrs.length)
  for (const f of adrs) assert.ok(text.includes(f), `${f} is linked`)
  const head = text.slice(0, text.indexOf(MARKER))
  assert.match(head, /不是.*(生产|商用)/, 'head states the pre-release boundary')
  assert.doesNotMatch(text.slice(text.indexOf(MARKER)), /生产就绪|商用就绪|production[- ]ready|已通过验收/i)
})
