/**
 * ============================================================================
 * 文件标识：tests/evidence-log-ingest.test.mjs ｜ scripts/evidence-log-ingest.mjs 的单元测试（AE10）
 * ============================================================================
 * 覆盖：接受链尾衔接的 hosted-ci 行（含空日志 genesis）；拒绝 prev 不符、重名、非 hosted-ci、带签名、非规范化、多行、CRLF、
 * 被占用的锁；拒绝时日志字节不变；追加后 verify 链仍有效。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { GENESIS_PREV, entryLine, verifyLog } from '../scripts/lib/evidence-log.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const sha = s => createHash('sha256').update(s).digest('hex')
const dir = t => { const d = mkdtempSync(path.join(tmpdir(), 'os-erp-ingest-')); return d }
const entry = (n, prev, over = {}) => ({ schema: 1, name: `RC-1.0.0-${n.repeat(7)}`, evidence_sha256: sha(n), signature: null, built_by: 'hosted-ci', timestamp: '2026-10-24T00:00:00.000Z', prev, ...over })
const run = (line, log) => spawnSync(process.execPath, ['scripts/evidence-log-ingest.mjs', '--line', line, '--log', log], { cwd: ROOT, encoding: 'utf8' })
function setup(t, { existing = true } = {}) {
  const d = dir(t)
  const log = path.join(d, 'log.jsonl')
  const first = entry('a', GENESIS_PREV)
  if (existing) writeFileSync(log, entryLine(first) + '\n')
  return { d, log, first, tip: existing ? sha(entryLine(first)) : GENESIS_PREV }
}
const put = (d, text) => { const f = path.join(d, 'line.jsonl'); writeFileSync(f, text); return f }

test('ingest appends a hosted-ci line that extends the current tail, and the chain stays valid', t => {
  const { d, log, tip } = setup(t)
  const next = entry('b', tip)
  const r = run(put(d, entryLine(next) + '\n'), log)
  assert.equal(r.status, 0, r.stderr)
  const v = verifyLog(readFileSync(log, 'utf8'))
  assert.equal(v.ok, true)
  assert.equal(v.entries.length, 2)
  assert.equal(v.entries[1].name, next.name)
  assert.ok(!existsSync(`${log}.lock`), 'lock released')
})

test('ingest into an empty or missing log needs the genesis prev', t => {
  const { d, log } = setup(t, { existing: false })
  assert.equal(run(put(d, entryLine(entry('a', sha('x'))) + '\n'), log).status, 1)
  assert.equal(run(put(d, entryLine(entry('a', GENESIS_PREV)) + '\n'), log).status, 0)
})

test('ingest refuses and leaves the log byte-identical for every invalid line', t => {
  const { d, log, first, tip } = setup(t)
  const before = readFileSync(log)
  const good = entry('b', tip)
  const cases = [
    ['prev mismatch', entryLine(entry('b', sha('other'))) + '\n', /prev|chain/],
    ['duplicate name', entryLine({ ...entry('c', tip), name: first.name }) + '\n', /duplicate/],
    ['key-holder', entryLine(entry('b', tip, { built_by: 'key-holder', signature: sha('s') })) + '\n', /hosted-ci/],
    ['local', entryLine(entry('b', tip, { built_by: 'local' })) + '\n', /hosted-ci/],
    ['signed hosted-ci', entryLine(entry('b', tip, { signature: sha('s') })) + '\n', /signature/],
    ['backwards timestamp', entryLine(entry('b', tip, { timestamp: '2026-10-23T00:00:00.000Z' })) + '\n', /timestamp/],
    ['digest as array', entryLine({ ...good, evidence_sha256: [good.evidence_sha256] }) + '\n', /evidence_sha256/],
    ['extra field', entryLine({ ...good, extra: 1 }) + '\n', /field/],
    ['not canonical', JSON.stringify(good, null, 2).replace(/\n/g, ' ') + '\n', /canonical/],
    ['no trailing newline', entryLine(good), /exactly one line/],
    ['two lines', entryLine(good) + '\n' + entryLine(good) + '\n', /exactly one line/],
    ['CRLF', entryLine(good) + '\r\n', /exactly one line/],
    ['not json', 'garbage\n', /not JSON/],
    ['array', '[]\n', /hosted-ci/],
    ['empty', '', /exactly one line/]
  ]
  for (const [label, text, re] of cases) {
    const r = run(put(d, text), log)
    assert.equal(r.status, 1, label)
    assert.match(r.stderr, re, label)
    assert.deepEqual(readFileSync(log), before, `${label}: log unchanged`)
  }
})

test('ingest refuses while the log lock is held, and refuses a broken existing chain', t => {
  const { d, log, tip } = setup(t)
  const line = put(d, entryLine(entry('b', tip)) + '\n')
  writeFileSync(`${log}.lock`, '')
  assert.match(run(line, log).stderr, /lock/)
  const before = readFileSync(log)
  assert.deepEqual(readFileSync(log), before)
  const { log: log2 } = setup(t)
  writeFileSync(log2, 'broken\n')
  assert.match(run(line, log2).stderr, /chain is broken|invalid/)
  assert.equal(readFileSync(log2, 'utf8'), 'broken\n')
})

test('ingest requires --line and rejects unknown arguments', () => {
  assert.equal(spawnSync(process.execPath, ['scripts/evidence-log-ingest.mjs'], { cwd: ROOT, encoding: 'utf8' }).status, 1)
  assert.equal(spawnSync(process.execPath, ['scripts/evidence-log-ingest.mjs', '--bogus'], { cwd: ROOT, encoding: 'utf8' }).status, 1)
})
