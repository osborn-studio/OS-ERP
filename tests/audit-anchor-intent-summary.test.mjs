/**
 * ============================================================================
 * 文件标识：tests/audit-anchor-intent-summary.test.mjs ｜ AH11 anchorIntentSummary：key_id 分布与信息暴露边界
 * 只用内存库与合成数据；不涉及任何真实密钥。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import { anchorIntentSummary } from '../server/lib/audit-anchor-intent.js'

const mk = () => {
  const db = new Database(':memory:')
  db.exec(`CREATE TABLE audit_anchor_intents (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT, operation TEXT, range_desc TEXT, operator_user_id INTEGER, operator_name TEXT, anchors_json TEXT, intent_hash TEXT, key_id TEXT, signature TEXT, audit_row_id INTEGER)`)
  return db
}
const add = (db, op, keyId, sig, at) => db.prepare("INSERT INTO audit_anchor_intents (created_at,operation,range_desc,operator_name,anchors_json,intent_hash,key_id,signature) VALUES (?,?,'SECRET-RANGE','SECRET-OPERATOR','[]','SECRET-HASH',?,?)").run(at, op, keyId, sig)

test('no table: empty summary; empty table: zero counts', () => {
  const none = anchorIntentSummary(new Database(':memory:'))
  assert.deepEqual(none, { table_present: false, total: 0, signed: 0, unsigned: 0, signed_without_key_id: 0, key_ids: [], recent: [] })
  assert.equal(anchorIntentSummary(mk()).table_present, true)
})

test('counts signed / unsigned / legacy signed without key_id and groups by key_id (fingerprints truncated to 16)', () => {
  const db = mk()
  const K1 = 'a'.repeat(64)
  const K2 = 'b'.repeat(64)
  add(db, 'retention', null, null, '2026-10-01 10:00:00')
  add(db, 'archive', null, 'LEGACYSIG', '2026-10-02 10:00:00')
  add(db, 'erase', K1, 'SIG1', '2026-10-03 10:00:00')
  add(db, 'retention', K1, 'SIG2', '2026-10-04 10:00:00')
  add(db, 'retention', K2, 'SIG3', '2026-10-05 10:00:00')
  const s = anchorIntentSummary(db)
  assert.equal(s.total, 5)
  assert.equal(s.signed, 4)
  assert.equal(s.unsigned, 1)
  assert.equal(s.signed_without_key_id, 1)
  assert.deepEqual(s.key_ids, [
    { key_id: 'b'.repeat(16), count: 1, last_at: '2026-10-05 10:00:00' },
    { key_id: 'a'.repeat(16), count: 2, last_at: '2026-10-04 10:00:00' }
  ])
  assert.equal(s.recent.length, 5)
  assert.deepEqual(s.recent[0], { id: 5, created_at: '2026-10-05 10:00:00', operation: 'retention', key_id: 'b'.repeat(16), signed: true })
  assert.equal(s.recent.at(-1).signed, false)
})

test('never exposes signature, hash, range, operator or anchors', () => {
  const db = mk()
  add(db, 'retention', 'c'.repeat(64), 'SECRET-SIGNATURE', '2026-10-01 10:00:00')
  const text = JSON.stringify(anchorIntentSummary(db))
  for (const bad of ['SECRET', 'SIGNATURE', 'anchors_json', 'intent_hash', 'range_desc', 'operator']) assert.ok(!text.includes(bad), bad)
  assert.ok(!text.includes('c'.repeat(17)), 'only the 16-char fingerprint prefix is returned')
})
