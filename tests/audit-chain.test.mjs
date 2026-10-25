/**
 * ============================================================================
 * 文件标识：tests/audit-chain.test.mjs ｜ AB6 审计日志哈希链（ADR-0049）：写入、规范化、并发、迁移回填、校验脚本、归档脚本、受控改链
 * 全部在系统临时目录里建库；子进程只用 --data-dir / GML_DATA_DIR 指向临时目录，不监听端口，不碰仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash, createPublicKey } from 'node:crypto'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, copyFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { insertAuditRow, auditStrictRow, deleteAuditRowsAnchored, rehashAuditRow, GENESIS } from '../server/lib/audit-trail.js'
import { verifyChain, verifyJsonlSegment } from '../server/lib/audit-chain-verify.js'
import { applyPlan } from '../scripts/lib/privacy-common.mjs'
import { resolveKeyIdRequirement } from '../server/lib/audit-anchor-intent.js'
import { buildSignedAnchor } from '../scripts/lib/offbox-anchor.mjs'
import { loadSigningKey } from '../scripts/lib/evidence-sign.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: 'a'.repeat(48), ...extra })

function tmp(t, prefix = 'os-ab6-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** 建库：schema + 全部迁移（或除 068 外的迁移，用来模拟升级前的库） */
function mkDb(dir, { skip068 = false, file = 'gml_cosmetic.db' } = {}) {
  const db = new Database(path.join(dir, file))
  db.pragma('journal_mode = WAL')
  db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)
  if (skip068) {
    const legacy = path.join(dir, 'mig-legacy')
    mkdirSync(legacy)
    for (const f of readdirSync(MIGRATIONS_DIR)) if (f !== '068_audit_hash_chain.cjs' && !f.startsWith('.')) copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(legacy, f))
    runMigrations(db, { mode: 'test', migrationsDir: legacy })
  } else runMigrations(db, { mode: 'test' })
  return db
}
const row = (i, extra = {}) => ({ userId: 1 + (i % 5), userName: `u${i % 5}`, action: i % 2 ? 'UPDATE' : 'CREATE', module: 'sales', entity: 'order', entityId: i, detail: { n: i }, ip: '127.0.0.1', ...extra })
const fill = (db, n, start = 0) => db.transaction(() => { for (let i = start; i < start + n; i++) insertAuditRow(db, row(i)) })()
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
/** 独立于实现的哈希（按规格手写）：八个分量先转字符串，JSON 数组序列化 */
const spec = (r, prev) => sha(JSON.stringify([r.id, r.created_at, r.user_id, r.action, r.entity, r.entity_id, r.detail, prev].map((v) => (v === null || v === undefined ? null : String(v)))))
const cli = (script, args, dir, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 120000 })

test('every inserted row carries prev_hash/row_hash computed per the ADR-0049 spec; genesis is 64 zeros', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 5)
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  assert.equal(GENESIS, '0'.repeat(64))
  assert.equal(rows[0].prev_hash, GENESIS)
  rows.forEach((r, i) => {
    if (i) assert.equal(r.prev_hash, rows[i - 1].row_hash, 'prev_hash = previous row_hash')
    assert.equal(r.row_hash, spec(r, r.prev_hash), `row ${r.id} hash matches the spec formula`)
  })
  const v = verifyChain(db)
  assert.deepEqual([v.ok, v.rows, v.tipHash], [true, 5, rows[4].row_hash])
})

test('canonical form: NULL differs from "null", field boundaries cannot collide, value types are normalised', (t) => {
  const db = mkDb(tmp(t))
  insertAuditRow(db, { action: 'a|b', entity: 'c' })
  insertAuditRow(db, { action: 'a', entity: 'b|c' })
  insertAuditRow(db, { action: 'X', detail: null })
  insertAuditRow(db, { action: 'X', detail: 'null' })
  insertAuditRow(db, { action: 'N', userId: '5', entityId: 42 }) // 文本 '5' 经 INTEGER 亲和性存成 5
  insertAuditRow(db, { action: 'N2', userId: '005', entityId: '007' }) // '005' → 5（前导零被亲和性吃掉），entity_id 是 TEXT 保持 '007'
  insertAuditRow(db, { action: 'U', detail: { s: '含中文 \u{1F600} \ud800' } })
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  assert.equal(new Set(rows.map((r) => r.row_hash)).size, 7)
  assert.equal(rows[4].user_id, 5)
  assert.equal(rows[5].user_id, 5)
  assert.equal(rows[5].entity_id, '007')
  assert.equal(verifyChain(db).ok, true, 'bound-value hash equals read-back hash')
})

test('tampering is located: edited detail, edited hash, deleted middle/first row, restored row; tip truncation needs --expect-tip', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 40)
  const ids = db.prepare('SELECT id FROM audit_logs ORDER BY id').all().map((r) => r.id)
  const tip = db.prepare('SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get().row_hash
  const brk = () => verifyChain(db).brk
  // 1 改明细
  db.prepare("UPDATE audit_logs SET detail='{\"n\":999}' WHERE id=?").run(ids[10])
  assert.deepEqual([brk().id, brk().kind], [ids[10], 'content'])
  db.prepare("UPDATE audit_logs SET detail='{\"n\":10}' WHERE id=?").run(ids[10])
  assert.equal(verifyChain(db).ok, true)
  // 2 改动 user_name/module/ip 不在哈希内（已知限制，写进 ADR）
  db.prepare("UPDATE audit_logs SET user_name='x', module='y', ip='z' WHERE id=?").run(ids[11])
  assert.equal(verifyChain(db).ok, true)
  // 3 改 row_hash（连同下一行 prev 不动）⇒ 该行 content
  db.prepare("UPDATE audit_logs SET row_hash=? WHERE id=?").run('f'.repeat(64), ids[12])
  assert.deepEqual([brk().id, brk().kind], [ids[12], 'content'])
  db.prepare('UPDATE audit_logs SET row_hash=? WHERE id=?').run(spec(db.prepare('SELECT * FROM audit_logs WHERE id=?').get(ids[12]), db.prepare('SELECT prev_hash FROM audit_logs WHERE id=?').get(ids[12]).prev_hash), ids[12])
  assert.equal(verifyChain(db).ok, true)
  // 4 删中间行 ⇒ 下一行 link
  const gone = db.prepare('SELECT * FROM audit_logs WHERE id=?').get(ids[20])
  db.prepare('DELETE FROM audit_logs WHERE id=?').run(ids[20])
  assert.deepEqual([brk().id, brk().kind], [ids[21], 'link'])
  db.prepare('INSERT INTO audit_logs (id,user_id,user_name,action,module,entity,entity_id,detail,ip,created_at,prev_hash,row_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(gone.id, gone.user_id, gone.user_name, gone.action, gone.module, gone.entity, gone.entity_id, gone.detail, gone.ip, gone.created_at, gone.prev_hash, gone.row_hash)
  assert.equal(verifyChain(db).ok, true, 'restoring the exact row heals the break')
  // 5 删第一行 ⇒ 新的第一行 prev 不是 genesis
  db.prepare('DELETE FROM audit_logs WHERE id=?').run(ids[0])
  assert.deepEqual([brk().id, brk().kind], [ids[1], 'link'])
  // 6 尾部截断：链本身看不出，--expect-tip 看得出
  const db2 = mkDb(tmp(t))
  fill(db2, 10)
  const tip2 = db2.prepare('SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get().row_hash
  db2.prepare('DELETE FROM audit_logs WHERE id > (SELECT MAX(id)-3 FROM audit_logs)').run()
  assert.equal(verifyChain(db2).ok, true)
  const cut = verifyChain(db2, { expectTip: tip2 })
  assert.deepEqual([cut.ok, cut.brk.kind], [false, 'tip'])
  assert.ok(tip.length === 64)
})

test('unchained raw INSERT is reported as the first break (kind unchained)', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 3)
  db.prepare("INSERT INTO audit_logs (user_name, action) VALUES ('raw','RAW')").run()
  const v = verifyChain(db)
  assert.equal(v.ok, false)
  assert.equal(v.brk.kind, 'unchained')
})

test('rolled-back writes leave no gap; strict audit inside a failing business tx rolls the chain row back too', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 3)
  assert.throws(() => db.transaction(() => { insertAuditRow(db, row(100)); throw new Error('boom') })())
  fill(db, 2, 3)
  assert.equal(verifyChain(db).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 5)
  assert.throws(() => auditStrictRow(db, row(1)), { code: 'AUDIT_OUTSIDE_TX' })
  db.exec("CREATE TRIGGER swallow BEFORE INSERT ON audit_logs WHEN NEW.action='SWALLOW' BEGIN SELECT RAISE(IGNORE); END")
  assert.throws(() => db.transaction(() => auditStrictRow(db, { action: 'SWALLOW' }))(), { code: 'SECURITY_AUDIT_UNAVAILABLE' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 5)
  fill(db, 1, 9)
  assert.equal(verifyChain(db).ok, true)
})

test('concurrency: stale deferred snapshot cannot fork the chain (SQLITE_BUSY_SNAPSHOT), autocommit writers on two connections interleave cleanly', (t) => {
  const dir = tmp(t)
  const a = mkDb(dir)
  const b = new Database(path.join(dir, 'gml_cosmetic.db'))
  b.pragma('busy_timeout = 5000')
  fill(a, 3)
  // A 在 DEFERRED 事务里先读（取得读快照），B 随后提交一条审计 ⇒ A 再写必须失败而不是分叉
  a.exec('BEGIN')
  a.prepare('SELECT COUNT(*) FROM audit_logs').get()
  insertAuditRow(b, row(50))
  assert.throws(() => insertAuditRow(a, row(51)), (e) => /SQLITE_BUSY/.test(e.code))
  a.exec('ROLLBACK')
  insertAuditRow(a, row(51))
  // 交错的 autocommit 写入
  for (let i = 0; i < 100; i++) { insertAuditRow(i % 2 ? a : b, row(100 + i)) }
  const v = verifyChain(a)
  assert.deepEqual([v.ok, v.rows], [true, 105])
  b.close()
})

test('concurrency across processes: two writers hammering one file produce one unbroken chain', { timeout: 120000 }, async (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  db.close()
  const code = `
    import Database from 'better-sqlite3'
    import { insertAuditRow } from './server/lib/audit-trail.js'
    const db = new Database(process.argv[1]); db.pragma('busy_timeout = 30000'); db.pragma('journal_mode = WAL')
    for (let i = 0; i < 300; i++) insertAuditRow(db, { userName: 'p'+process.argv[2], action: 'LOAD', module: 'load', entity: 'e', entityId: i, detail: { i } })
  `
  const run = (tag) => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code, path.join(dir, 'gml_cosmetic.db'), tag], { cwd: ROOT, env: envFor(dir), stdio: ['ignore', 'pipe', 'pipe'] })
    let err = ''
    p.stderr.on('data', (d) => { err += d })
    p.on('exit', (c) => (c === 0 ? resolve() : reject(new Error(err))))
  })
  await Promise.all([run('A'), run('B')])
  const check = new Database(path.join(dir, 'gml_cosmetic.db'), { readonly: true })
  const v = verifyChain(check)
  assert.deepEqual([v.ok, v.rows], [true, 600])
  check.close()
})

test('migration 068 backfills existing rows in id order, is idempotent, heals orphan rows, and coexists with other audit_logs triggers', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir, { skip068: true })
  assert.ok(!db.prepare('PRAGMA table_info(audit_logs)').all().some((c) => c.name === 'row_hash'))
  // 一个 AB3 风格的影子表 + 触发器：迁移必须照常工作
  db.exec(`CREATE TABLE shadow (id INTEGER, detail TEXT);
    CREATE TRIGGER shadow_ai AFTER INSERT ON audit_logs BEGIN INSERT INTO shadow VALUES (NEW.id, NEW.detail); END;
    CREATE TRIGGER shadow_au AFTER UPDATE ON audit_logs BEGIN UPDATE shadow SET detail=NEW.detail WHERE id=NEW.id; END;`)
  const ins = db.prepare("INSERT INTO audit_logs (user_id,user_name,action,module,entity,entity_id,detail,created_at) VALUES (?,?,?,?,?,?,?,?)")
  for (let i = 0; i < 250; i++) ins.run(i % 7, 'legacy', 'OLD', 'm', 'e', String(i), i % 3 ? `{"i":${i}}` : null, `2024-01-01 00:00:${String(i % 60).padStart(2, '0')}`)
  const res = runMigrations(db, { mode: 'test' })
  assert.deepEqual(res.applied, ['068_audit_hash_chain'])
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  assert.equal(rows[0].prev_hash, GENESIS)
  rows.forEach((r, i) => { if (i) assert.equal(r.prev_hash, rows[i - 1].row_hash); assert.equal(r.row_hash, spec(r, r.prev_hash)) })
  assert.equal(verifyChain(db).ok, true)
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name='audit_chain_anchors'").get())
  const snapshot = JSON.stringify(rows)
  const mig = (await_import()).up
  mig(db); mig(db)
  assert.equal(JSON.stringify(db.prepare('SELECT * FROM audit_logs ORDER BY id').all()), snapshot, 'up() twice changes nothing')
  assert.equal((await_import()).verify(db), true)
  // 之后的新行照常接链，与触发器共存
  insertAuditRow(db, row(1))
  assert.equal(verifyChain(db).ok, true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM shadow').get().n, 251)
  // 孤儿行（裸 INSERT 留在表尾）⇒ verify 为假 ⇒ 下次 runMigrations 自愈接上
  db.prepare("INSERT INTO audit_logs (user_name, action) VALUES ('raw','RAW')").run()
  assert.equal((await_import()).verify(db), false)
  assert.equal(verifyChain(db).brk.kind, 'unchained')
  const heal = runMigrations(db, { mode: 'test' })
  assert.deepEqual(heal.healed, ['068_audit_hash_chain'])
  assert.deepEqual([verifyChain(db).ok, verifyChain(db).rows], [true, 252])
})

test('tail orphans are adopted by the next insertAuditRow; a NULL row_hash in the MIDDLE of the chain is never re-hashed (no self-healing of tampering)', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 10)
  db.prepare("INSERT INTO audit_logs (user_name, action) VALUES ('raw1','RAW')").run()
  db.prepare("INSERT INTO audit_logs (user_name, action) VALUES ('raw2','RAW')").run()
  insertAuditRow(db, row(1)) // 先把两条尾部孤儿接上，再追加
  assert.deepEqual([verifyChain(db).ok, verifyChain(db).rows], [true, 13])
  // 篡改者把中间一行改掉并把 row_hash 置空，指望下次启动"自愈"把它洗成合法
  db.prepare("UPDATE audit_logs SET detail='{\"forged\":true}', row_hash=NULL WHERE id=5").run()
  assert.equal(verifyChain(db).brk.kind, 'unchained')
  assert.equal((await_import()).verify(db), true, 'nothing healable: the NULL row is mid-chain')
  const res = runMigrations(db, { mode: 'test' })
  assert.deepEqual(res.healed, [])
  assert.equal(db.prepare('SELECT row_hash FROM audit_logs WHERE id=5').get().row_hash, null, 'not re-hashed')
  insertAuditRow(db, row(2))
  assert.deepEqual([verifyChain(db).ok, verifyChain(db).brk.id], [false, 5], 'still reported after more writes')
})
import { createRequire } from 'node:module'
function await_import() { return createRequire(import.meta.url)(path.join(MIGRATIONS_DIR, '068_audit_hash_chain.cjs')) }

test('verify() is consistent with up(): missing anchors table or a tail orphan makes it false and up() repairs it', (t) => {
  const db = mkDb(tmp(t))
  const mig = await_import()
  assert.equal(mig.verify(db), true)
  db.exec('DROP TABLE audit_chain_anchors')
  assert.equal(mig.verify(db), false)
  mig.up(db)
  assert.equal(mig.verify(db), true)
  db.exec("INSERT INTO audit_logs (user_name, action) VALUES ('raw','RAW')") // 表尾孤儿
  assert.equal(mig.verify(db), false)
  mig.up(db)
  assert.equal(mig.verify(db), true)
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='audit_logs' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name),
    ['idx_audit_entity', 'idx_audit_module_created', 'idx_audit_user_created'], 'migration 068 adds no index on audit_logs')
})

test('insertAuditRow still works on a pre-068 audit_logs (plain INSERT, no chain columns)', () => {
  const db = new Database(':memory:')
  db.exec('CREATE TABLE audit_logs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, user_name TEXT, action TEXT NOT NULL, module TEXT, entity TEXT, entity_id TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL DEFAULT (datetime(\'now\',\'localtime\')))')
  assert.equal(insertAuditRow(db, row(1)).changes, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 1)
})

test('audit-verify-chain.mjs: OK exit 0, first break exit 1 with id and kind, absent industries are not created, usage errors exit 2', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  fill(db, 30)
  const ok = cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic'], dir)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /OK\s+cosmetic: 30 行/)
  const tip = db.prepare('SELECT row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get().row_hash
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--expect-tip', tip], dir).status, 0)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--expect-tip', 'a'.repeat(64)], dir).status, 1)
  db.prepare("UPDATE audit_logs SET action='HACKED' WHERE id=7").run()
  const bad = cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--json'], dir)
  assert.equal(bad.status, 1)
  const j = JSON.parse(bad.stdout)
  assert.deepEqual([j.ok, j.industries.cosmetic.break.id, j.industries.cosmetic.break.kind], [false, 7, 'content'])
  const all = cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir], dir)
  assert.equal(all.status, 1)
  assert.match(all.stdout, /BREAK cosmetic: 第一个断点 id=7/)
  assert.equal(readdirSync(dir).filter((f) => /^gml_.*\.db$/.test(f)).length, 1, 'no other industry db created')
  assert.equal(cli('scripts/audit-verify-chain.mjs', [], dir, { GML_DATA_DIR: '' }).status, 2)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', 'relative/dir'], dir).status, 2)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--bogus'], dir).status, 2)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', path.resolve(ROOT, 'data')], dir).status, 2, 'repository data/ is refused')
  db.close()
})

function archiveFixture(t) {
  const dir = tmp(t)
  const out = tmp(t, 'os-ab6-out-')
  const db = mkDb(dir)
  const ins = db.prepare("UPDATE audit_logs SET created_at=? WHERE id=?")
  fill(db, 60)
  // 前 40 行是旧的（2024-01-xx），后 20 行是新的
  db.transaction(() => { for (let id = 1; id <= 60; id++) ins.run(id <= 40 ? '2024-01-15 10:00:00' : '2026-06-01 10:00:00', id) })()
  return { dir, out, db }
}

test('audit-verify: created_at rewrite is detected (created_at is inside the hash)', (t) => {
  const { dir, db } = archiveFixture(t)
  // archiveFixture 直接改了 created_at ⇒ 链当然断；这里证明哈希覆盖 created_at
  const r = cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--json'], dir)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).industries.cosmetic.break.id, 1)
  db.close()
})

/** 归档夹具：用 insertAuditRow 写入，并把时间写在 created_at 里之前先写（时间在插入时给定）——这里直接重建链 */
function archiveReady(t) {
  const dir = tmp(t)
  const out = tmp(t, 'os-ab6-out-')
  const db = mkDb(dir)
  fill(db, 60)
  // 通过受控重建：把 created_at 改好后重新回填整条链（等价于这些行在当时就带着这些时间写入）
  db.transaction(() => {
    for (let id = 1; id <= 60; id++) db.prepare('UPDATE audit_logs SET created_at=?, row_hash=NULL, prev_hash=NULL WHERE id=?').run(id <= 40 ? '2024-01-15 10:00:00' : '2026-06-01 10:00:00', id)
  })()
  const mig = await_import()
  mig.up(db)
  assert.equal(verifyChain(db).ok, true)
  return { dir, out, db }
}

test('audit-archive.mjs: dry-run changes nothing and prints a token; wrong token refused; right token exports, verifies, deletes, re-anchors', (t) => {
  const { dir, out, db } = archiveReady(t)
  const A = (extra = []) => cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, ...extra], dir)
  const dry = A()
  assert.equal(dry.status, 0, dry.stderr)
  assert.match(dry.stdout, /将归档 40 行（id 1\.\.40）/)
  const token = dry.stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.equal(readdirSync(out).length, 0, 'dry run writes no files')
  const wrong = A(['--confirm', 'ARCHIVE-0000000000000000'])
  assert.equal(wrong.status, 2)
  assert.match(wrong.stderr, /CONFIRM_MISMATCH/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  const tip40 = db.prepare('SELECT row_hash FROM audit_logs WHERE id=40').get().row_hash
  const first = db.prepare('SELECT row_hash FROM audit_logs WHERE id=1').get().row_hash
  const done = A(['--confirm', token])
  assert.equal(done.status, 0, done.stderr + done.stdout)
  const files = readdirSync(out).sort()
  assert.equal(files.length, 2)
  const jsonl = files.find((f) => f.endsWith('.jsonl'))
  const digest = JSON.parse(readFileSync(path.join(out, files.find((f) => f.endsWith('.digest.json'))), 'utf8'))
  assert.deepEqual([digest.rows, digest.first_id, digest.last_id, digest.first_row_hash, digest.tip_row_hash, digest.boundary_id], [40, 1, 40, first, tip40, 41])
  assert.equal(digest.file_sha256, sha(readFileSync(path.join(out, jsonl), 'utf8')))
  assert.equal(readFileSync(path.join(out, jsonl), 'utf8').trim().split('\n').length, 40)
  // 库：41 行（20 + 旧段已删 + 归档审计行 = 60-40+1）、锚点、链仍通过
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 21)
  assert.equal(db.prepare('SELECT MIN(id) m FROM audit_logs').get().m, 41)
  const anchor = db.prepare('SELECT * FROM audit_chain_anchors').get()
  assert.deepEqual([anchor.kind, anchor.at_row_id, anchor.anchor_hash, anchor.prev_id, anchor.prev_row_hash], ['archive', 41, tip40, null, null])
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get().n, 1)
  const v = verifyChain(db)
  assert.deepEqual([v.ok, v.anchorsUsed], [true, 1])
  insertAuditRow(db, row(1))
  assert.equal(verifyChain(db).ok, true)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 0)
  // 同一个口令不能重放（数据已变）
  assert.equal(A(['--confirm', token]).status, 0, 'second run has nothing to archive')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 22)
  db.close()
})

test('audit-archive.mjs refuses a tampered segment (exit 1, nothing deleted, nothing exported) and an out dir inside the data dir', (t) => {
  const { dir, out, db } = archiveReady(t)
  db.prepare("UPDATE audit_logs SET action='HACKED' WHERE id=12").run()
  const r = cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, '--confirm', 'ARCHIVE-0000000000000000'], dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /CHAIN_BROKEN/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.equal(readdirSync(out).length, 0)
  const inside = cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', path.join(dir, 'exports')], dir)
  assert.equal(inside.status, 2)
  assert.match(inside.stderr, /OUT_DIR_INVALID/)
  assert.equal(cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--before', 'yesterday', '--out', out], dir).status, 2)
  db.close()
})

test('audit-archive.mjs never empties the table: a cutoff newer than every row keeps the last row as the chain tip', (t) => {
  const { dir, out, db } = archiveReady(t)
  const dry = cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2030-01-01', '--out', out], dir)
  const token = dry.stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  assert.match(dry.stdout, /将归档 59 行/)
  assert.equal(cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2030-01-01', '--out', out, '--confirm', token], dir).status, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 2, 'last original row + AUDIT_ARCHIVE row')
  assert.equal(verifyChain(db).ok, true)
  db.close()
})

test('controlled mutations stay verifiable: retention-style anchored delete and privacy-style rehash', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 30)
  // 删除两段不相邻的区间（含第一行）
  const n = db.transaction(() => deleteAuditRowsAnchored(db, '(id <= 3 OR id BETWEEN 10 AND 14)', [], { kind: 'retention', reason: 't' }))()
  assert.equal(n, 8)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_chain_anchors').get().n, 2)
  assert.deepEqual([verifyChain(db).ok, verifyChain(db).anchorsUsed], [true, 2])
  assert.throws(() => deleteAuditRowsAnchored(db, 'id = 20', []), { code: 'AUDIT_OUTSIDE_TX' })
  // 未锚点的删除仍然被抓到
  db.prepare('DELETE FROM audit_logs WHERE id=20').run()
  assert.equal(verifyChain(db).brk.id, 21)
  // 隐私抹除：改 detail 并 rehash，后一行得到锚点；二次改写同一行仍通过
  const db2 = mkDb(tmp(t))
  fill(db2, 10)
  db2.transaction(() => {
    applyPlan(db2, { ops: [{ table: 'audit_logs', id: 5, set: { detail: '{"erased":true}' } }, { table: 'audit_logs', id: 6, set: { detail: '{"erased":true}' } }, { table: 'audit_logs', id: 5, set: { detail: '{"erased":2}' } }] })
  })()
  assert.equal(verifyChain(db2).ok, true)
  assert.equal(db2.prepare('SELECT detail FROM audit_logs WHERE id=5').get().detail, '{"erased":2}')
  // 没有 applyPlan 的裸改仍被抓到
  db2.prepare("UPDATE audit_logs SET detail='x' WHERE id=8").run()
  assert.equal(verifyChain(db2).brk.id, 8)
  assert.equal(rehashAuditRow.length >= 2, true)
})

test('retention.mjs --execute keeps the chain verifiable (anchors for purged runs) (also covers the retention.mjs wiring)', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  const at = (days) => db.prepare(`SELECT datetime('now','localtime','-${days} days') AS t`).get().t
  fill(db, 20)
  // 把中间几行改成"旧的、可清理的 master 模块"，再重建链（等价于它们当时就是这样写入的）
  db.transaction(() => {
    for (const id of [3, 4, 5, 9, 15]) db.prepare("UPDATE audit_logs SET module='master', created_at=?, row_hash=NULL, prev_hash=NULL WHERE id=?").run(at(900), id)
    for (const id of [1, 2]) db.prepare("UPDATE audit_logs SET module='master', created_at=?, row_hash=NULL, prev_hash=NULL WHERE id=?").run(at(900), id)
    db.prepare('UPDATE audit_logs SET row_hash=NULL, prev_hash=NULL').run() // 整表重建（等价于这些行当时就这样写入）：自愈只接尾部，所以必须全空
  })()
  await_import().up(db)
  assert.equal(verifyChain(db).ok, true)
  const r = cli('scripts/retention.mjs', ['cosmetic', '--execute', '--json'], dir)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).industries.cosmetic.counts.audit_logs, 7)
  const v = verifyChain(db)
  assert.deepEqual([v.ok, v.rows], [true, 14], JSON.stringify(v.brk))
  assert.ok(v.anchorsUsed >= 3)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 0)
  db.close()
})

test('only insertAuditRow inserts into audit_logs in server code (bootstrap included)', () => {
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : /\.(js|cjs|mjs)$/.test(e.name) ? [path.join(d, e.name)] : []))
  const offenders = walk(path.join(ROOT, 'server')).filter((f) => /INSERT\s+INTO\s+audit_logs/i.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f))
  assert.deepEqual(offenders, ['server/lib/audit-trail.js'])
})

test('anchors are bound to the surviving predecessor: deleting extra rows next to an anchored gap is still caught', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 30)
  db.transaction(() => deleteAuditRowsAnchored(db, 'id BETWEEN 10 AND 12', [], { kind: 'retention' }))()
  assert.equal(verifyChain(db).ok, true)
  db.prepare('DELETE FROM audit_logs WHERE id = 9').run() // 额外多删紧挨着缺口的前一行
  const v = verifyChain(db)
  assert.deepEqual([v.ok, v.brk.id, v.brk.kind], [false, 13, 'link'])
  // 隐私抹除改写后再删被改写的那一行，同样被抓到
  const db2 = mkDb(tmp(t))
  fill(db2, 12)
  db2.transaction(() => applyPlan(db2, { ops: [{ table: 'audit_logs', id: 3, set: { detail: '{"erased":true}' } }] }))()
  assert.equal(verifyChain(db2).ok, true)
  db2.prepare('DELETE FROM audit_logs WHERE id = 3').run()
  assert.equal(verifyChain(db2).ok, false)
})

test('a row rewritten twice, then deleted by retention, stays verifiable (anchors accumulate per predecessor)', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 12)
  db.transaction(() => {
    applyPlan(db, { ops: [{ table: 'audit_logs', id: 5, set: { detail: '{"a":1}' } }] })
    applyPlan(db, { ops: [{ table: 'audit_logs', id: 5, set: { detail: '{"a":2}' } }] })
  })()
  assert.equal(verifyChain(db).ok, true)
  db.transaction(() => deleteAuditRowsAnchored(db, 'id = 5', [], { kind: 'retention' }))()
  assert.equal(verifyChain(db).ok, true)
})

test('audit-archive.mjs handles segments that contain retention/erase anchors and an anchored boundary', (t) => {
  const { dir, out, db } = archiveReady(t)
  // 段内：先做一次受控删除（id 10..12）和一次抹除改写（id 20）；边界：改写段尾行 id 40
  db.transaction(() => {
    deleteAuditRowsAnchored(db, 'id BETWEEN 10 AND 12', [], { kind: 'retention' })
    applyPlan(db, { ops: [{ table: 'audit_logs', id: 20, set: { detail: '{"erased":1}' } }, { table: 'audit_logs', id: 40, set: { detail: '{"erased":2}' } }] })
  })()
  assert.equal(verifyChain(db).ok, true)
  const A = (extra = []) => cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, ...extra], dir)
  const dry = A()
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  const token = dry.stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  const done = A(['--confirm', token])
  assert.equal(done.status, 0, done.stdout + done.stderr)
  const digest = JSON.parse(readFileSync(path.join(out, readdirSync(out).find((f) => f.endsWith('.digest.json'))), 'utf8'))
  assert.ok(digest.anchors.length >= 2, 'segment anchors travel with the digest')
  assert.equal(verifyChain(db).ok, true)
  assert.equal(cli('scripts/audit-verify-chain.mjs', ['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 0)
  db.close()
})

test('audit-archive.mjs failure after export removes its files so a retry is not blocked', (t) => {
  const { dir, out, db } = archiveReady(t)
  // 让写 AUDIT_ARCHIVE 严格审计失败：BEFORE INSERT 触发器吞掉它 ⇒ 事务回滚 ⇒ 导出文件必须被删
  db.exec("CREATE TRIGGER no_archive_audit BEFORE INSERT ON audit_logs WHEN NEW.action='AUDIT_ARCHIVE' BEGIN SELECT RAISE(IGNORE); END")
  const A = (extra = []) => cli('scripts/audit-archive.mjs', ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, ...extra], dir)
  const token = A().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  const r = A(['--confirm', token])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /SECURITY_AUDIT_UNAVAILABLE/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60, 'rolled back')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_chain_anchors').get().n, 0)
  assert.equal(readdirSync(out).length, 0, 'no leftover export files')
  db.exec('DROP TRIGGER no_archive_audit')
  assert.equal(A(['--confirm', token]).status, 0, 'retry succeeds')
  db.close()
})

test('controlled delete / rewrite refuse to launder an existing unauthorised gap', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 8)
  db.prepare('DELETE FROM audit_logs WHERE id = 2').run() // 未登记的删除
  assert.equal(verifyChain(db).ok, false)
  assert.throws(() => db.transaction(() => deleteAuditRowsAnchored(db, 'id = 4', [], { kind: 'retention' }))(), { code: 'AUDIT_CHAIN_BROKEN' })
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE id = 4').get().n, 1, 'nothing deleted')
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_chain_anchors').get().n, 0)
  // 改写某行时，它与下一行之间若本来就断了，不登记锚点
  const db2 = mkDb(tmp(t))
  fill(db2, 8)
  db2.prepare('DELETE FROM audit_logs WHERE id = 4').run()
  assert.throws(() => db2.transaction(() => applyPlan(db2, { ops: [{ table: 'audit_logs', id: 3, set: { detail: '{"x":1}' } }] }))(), { code: 'AUDIT_CHAIN_BROKEN' })
  assert.equal(db2.prepare('SELECT detail FROM audit_logs WHERE id = 3').get().detail, '{"n":2}', 'rolled back')
})

test('insertAuditRow inside a caller transaction is all-or-nothing even when the hash-correction UPDATE aborts and the caller swallows the error', (t) => {
  const db = mkDb(tmp(t))
  fill(db, 3)
  db.exec("CREATE TRIGGER no_fix BEFORE UPDATE OF row_hash ON audit_logs BEGIN SELECT RAISE(ABORT,'no hash updates'); END")
  db.transaction(() => {
    try { insertAuditRow(db, { action: 'N', userId: '005' }) } catch { /* 调用方吞掉异常继续提交 */ }
  })()
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 3, 'the half-written row was rolled back with its savepoint')
  assert.equal(verifyChain(db).ok, true)
})

test('verifyJsonlSegment streams: lines straddling 1 MiB read chunks verify, a flipped byte is caught', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  db.transaction(() => { for (let i = 0; i < 700; i++) insertAuditRow(db, { action: 'BIG', module: 'm', entity: 'e', entityId: i, detail: { pad: 'x'.repeat(3000 + (i % 7) * 211), i } }) })()
  const rows = db.prepare('SELECT * FROM audit_logs ORDER BY id').all()
  const file = path.join(dir, 'seg.jsonl')
  writeFileSync(file, rows.map((r) => JSON.stringify(r) + '\n').join(''))
  assert.ok(readFileSync(file).length > 2 * 1024 * 1024, 'spans several read chunks')
  const ok = verifyJsonlSegment(file)
  assert.deepEqual([ok.ok, ok.rows, ok.firstId, ok.lastId], [true, 700, rows[0].id, rows[699].id])
  const bytes = readFileSync(file)
  const at = Math.floor(bytes.length / 2)
  bytes[at] = bytes[at] === 0x78 ? 0x79 : 0x78
  writeFileSync(file, bytes)
  assert.equal(verifyJsonlSegment(file).ok, false)
})

// ============================================================================
// AC7（ADR-0049 补充）：链尾 / 锚点离机保存、`--against-backup`、`audit-archive --resume` 与崩溃窗口
// ============================================================================
const VERIFY = 'scripts/audit-verify-chain.mjs'
const ARCHIVE = 'scripts/audit-archive.mjs'
const BACKUP = 'scripts/db-backup.mjs'
const BKEY = 'k'.repeat(40) + '-ac7-backup-key-material'
const tipOf = (db) => db.prepare('SELECT id, row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get()
const backupDirOf = (dir) => path.join(dir, 'backups')
const newestBackup = (dir) => readdirSync(backupDirOf(dir)).filter((f) => /^gml_cosmetic_.*\.db(\.enc)?$/.test(f)).sort().at(-1)
/** 把整条链从 fromId 起重算（等价于能写库的攻击者改内容后整链重算），可选给 fromId 之后的行改内容 */
function attackerRewrite(db, fromId, mutate) {
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM audit_logs WHERE id >= ? ORDER BY id').all(fromId)
    let prev = fromId === 1 ? GENESIS : db.prepare('SELECT row_hash FROM audit_logs WHERE id=?').get(fromId - 1).row_hash
    for (const r of rows) {
      if (r.id === fromId && mutate) mutate(r)
      const h = spec(r, prev)
      db.prepare('UPDATE audit_logs SET detail=?, prev_hash=?, row_hash=? WHERE id=?').run(r.detail, prev, h, r.id)
      prev = h
    }
  })()
}
function backedUp(t, { key } = {}) {
  const dir = tmp(t)
  const db = mkDb(dir)
  fill(db, 12)
  const env = key ? { GML_BACKUP_KEY: key } : {}
  const b = cli(BACKUP, ['cosmetic'], dir, env)
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const set = path.join(backupDirOf(dir), newestBackup(dir))
  const V = (extra = [], e = {}) => cli(VERIFY, ['--data-dir', dir, '--against-backup', set, '--json', ...extra], dir, { ...env, ...e })
  return { dir, db, set, V, tip: tipOf(db), env }
}
const cos = (r) => JSON.parse(r.stdout).industries.cosmetic

test('AC7 --against-backup: a live chain that only advanced since the backup is accepted (plain and encrypted backups)', (t) => {
  for (const key of [undefined, BKEY]) {
    const { db, V, tip } = backedUp(t, { key })
    assert.equal(V().status, 0)
    assert.equal(cos(V()).against_backup.status, 'ok')
    fill(db, 5, 100)
    const r = V()
    assert.equal(r.status, 0, r.stdout + r.stderr)
    const ab = cos(r).against_backup
    assert.deepEqual([ab.status, ab.backup_tip_id, ab.backup_tip_hash, ab.advanced_rows, ab.manifest_source], ['ok', tip.id, tip.row_hash, 5, key ? 'encrypted' : 'plain'])
    db.close()
  }
})

test('AC7 --against-backup: whole-chain recompute after an edit is a rewrite even though the live chain verifies; truncation is reported too', (t) => {
  const { dir, db, V } = backedUp(t)
  attackerRewrite(db, 4, (r) => { r.detail = '{"forged":true}' })
  assert.equal(cli(VERIFY, ['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 0, 'plain verify is fooled by a full recompute')
  const r = V()
  assert.equal(r.status, 1)
  assert.equal(cos(r).against_backup.status, 'rewrite')
  assert.equal(cos(r).against_backup.kind, 'tip-row-differs')
  db.close()
  const b = backedUp(t)
  b.db.prepare('DELETE FROM audit_logs WHERE id > ?').run(b.tip.id - 3)
  const r2 = b.V()
  assert.equal(r2.status, 1)
  assert.deepEqual([cos(r2).against_backup.status, cos(r2).against_backup.kind], ['rewrite', 'behind'])
  b.db.close()
})

test('AC7 --against-backup: forged anchors are listed (and, since AF5, an in-range one without an intent fails the run; --strict-anchors fails it too)', (t) => {
  const { db, V } = backedUp(t)
  // 攻击者改第 3 行内容、重算它，再给第 4 行伪造一个锚点把断口"登记"掉
  const before = db.prepare('SELECT * FROM audit_logs WHERE id IN (3,4) ORDER BY id').all()
  const newHash = spec({ ...before[0], detail: '{"x":1}' }, before[0].prev_hash)
  db.transaction(() => {
    db.prepare("UPDATE audit_logs SET detail='{\"x\":1}', row_hash=? WHERE id=3").run(newHash)
    db.prepare("INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES ('erase', 4, ?, 3, ?, 'forged')").run(before[1].prev_hash, newHash)
  })()
  assert.equal(verifyChain(db).ok, true)
  const ok = V()
  assert.equal(ok.status, 1, 'AF5: the forged anchor is inside the backed-up range and has no intent')
  assert.equal(cos(ok).against_backup.kind, 'anchor-without-intent')
  assert.equal(cos(ok).against_backup.anchors_added.length, 1)
  assert.equal(cos(ok).against_backup.anchors_added[0].reason, 'forged')
  assert.equal(V(['--strict-anchors']).status, 1)
  db.close()
})

test('AC7 --against-backup: a tampered plaintext manifest is caught against the backup content and against the encrypted manifest', (t) => {
  const p = backedUp(t)
  const mf = p.set + '.audit-manifest.json'
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.audit_chain.tip_hash = '1'.repeat(64)
  writeFileSync(mf, JSON.stringify(m))
  const r = p.V()
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).against_backup.status, 'manifest-mismatch')
  p.db.close()
  const e = backedUp(t, { key: BKEY })
  const mf2 = e.set + '.audit-manifest.json'
  const m2 = JSON.parse(readFileSync(mf2, 'utf8'))
  m2.audit_chain.tip_hash = '2'.repeat(64)
  writeFileSync(mf2, JSON.stringify(m2))
  const r2 = e.V()
  assert.equal(r2.status, 1)
  assert.equal(JSON.parse(r2.stdout).against_backup.status, 'manifest-mismatch')
  assert.equal(cli(VERIFY, ['--data-dir', e.dir, '--against-backup', e.set + '.nope'], e.dir).status, 1, 'missing manifest is a failure, not a pass')
  e.db.close()
})

/** 备份时尾行是旧行；之后追加新行并归档旧段 ⇒ 备份尾已被归档 */
function archivedTipFixture(t) {
  const dir = tmp(t)
  const out = tmp(t, 'os-ac7-out-')
  const db = mkDb(dir)
  fill(db, 30)
  db.transaction(() => { for (let id = 1; id <= 30; id++) db.prepare('UPDATE audit_logs SET created_at=?, row_hash=NULL, prev_hash=NULL WHERE id=?').run('2024-01-15 10:00:00', id) })()
  await_import().up(db)
  const b = cli(BACKUP, ['cosmetic'], dir)
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const set = path.join(backupDirOf(dir), newestBackup(dir))
  const tip = tipOf(db)
  fill(db, 10, 100)
  return { dir, out, db, set, tip }
}
const archiveArgs = (dir, out, extra = []) => ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, ...extra]
const archiveNow = (f) => {
  const token = cli(ARCHIVE, archiveArgs(f.dir, f.out), f.dir).stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  const r = cli(ARCHIVE, archiveArgs(f.dir, f.out, ['--confirm', token]), f.dir)
  assert.equal(r.status, 0, r.stdout + r.stderr)
}

test('AC7 --against-backup: a backup tip that was archived needs the archive digests; with them the descent is proven', (t) => {
  const f = archivedTipFixture(t)
  archiveNow(f)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE id=?').get(f.tip.id).n, 0, 'tip row is gone from the live db')
  const V = (extra = []) => cli(VERIFY, ['--data-dir', f.dir, '--against-backup', f.set, '--json', ...extra], f.dir)
  const no = V()
  assert.equal(no.status, 1)
  assert.equal(cos(no).against_backup.status, 'unverifiable')
  const yes = V(['--archive-dir', f.out])
  assert.equal(yes.status, 0, yes.stdout + yes.stderr)
  assert.deepEqual([cos(yes).against_backup.status, cos(yes).against_backup.via], ['ok', 'archive'])
  // 摘要对应的 JSONL 被改 ⇒ 不认
  const jsonl = readdirSync(f.out).find((n) => n.endsWith('.jsonl'))
  const bytes = readFileSync(path.join(f.out, jsonl))
  bytes[10] = bytes[10] === 0x78 ? 0x79 : 0x78
  writeFileSync(path.join(f.out, jsonl), bytes)
  assert.equal(V(['--archive-dir', f.out]).status, 1)
  f.db.close()
})

/** 归档 + 在导出 fsync 之后、删除之前 SIGKILL 子进程 */
async function crashedArchive(t) {
  const f = archiveReady(t)
  const A = (extra = []) => cli(ARCHIVE, archiveArgs(f.dir, f.out, extra), f.dir)
  const token = A().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  const child = spawn(process.execPath, [ARCHIVE, ...archiveArgs(f.dir, f.out, ['--confirm', token])], { cwd: ROOT, env: envFor(f.dir, { GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT: '1' }), stdio: 'ignore' })
  t.after(() => { try { child.kill('SIGKILL') } catch { /* 已退出 */ } })
  const marker = path.join(f.out, '.archive-paused')
  for (let i = 0; i < 600 && !existsSync(marker); i++) await new Promise((r) => setTimeout(r, 50))
  assert.ok(existsSync(marker), 'child reached the pause point after the export fsync')
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })))
  child.kill('SIGKILL')
  const ex = await exited
  assert.equal(ex.signal, 'SIGKILL')
  rmSync(marker)
  return { ...f, A, token }
}
const outFiles = (out) => readdirSync(out).sort()

test('AC7 archive crash window: SIGKILL after export fsync leaves the db untouched and the export complete; --resume finishes it idempotently', { timeout: 120000 }, async (t) => {
  const f = await crashedArchive(t)
  const { dir, out, db, A, token } = f
  // 库：事务未提交 ⇒ 全部还在、没有锚点 / 归档审计、链完好
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_chain_anchors').get().n, 0)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get().n, 0)
  assert.equal(verifyChain(db).ok, true)
  // 文件：两个都在且完整
  const files = outFiles(out)
  assert.equal(files.length, 2)
  const jsonl = path.join(out, files.find((n) => n.endsWith('.jsonl')))
  const digestFile = path.join(out, files.find((n) => n.endsWith('.digest.json')))
  const digest = JSON.parse(readFileSync(digestFile, 'utf8'))
  assert.equal(digest.file_sha256, sha(readFileSync(jsonl, 'utf8')))
  assert.equal(verifyJsonlSegment(jsonl, digest.anchors).rows, 40)
  const before = [readFileSync(jsonl), readFileSync(digestFile)]
  // 不带 --resume 重跑：不覆盖，明确指向 --resume
  const again = A(['--confirm', token])
  assert.equal(again.status, 1)
  assert.match(again.stdout, /OUT_EXISTS.*--resume/s)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  // --resume 演练：不改任何东西，给出口令
  const dry = A(['--resume'])
  assert.equal(dry.status, 0, dry.stdout + dry.stderr)
  assert.match(dry.stdout, /可续做/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.equal(A(['--resume', '--confirm', 'ARCHIVE-0000000000000000']).status, 2)
  const done = A(['--resume', '--confirm', dry.stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]])
  assert.equal(done.status, 0, done.stdout + done.stderr)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 21)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get().n, 1)
  const anchor = db.prepare("SELECT * FROM audit_chain_anchors WHERE kind='archive'").get()
  assert.deepEqual([anchor.at_row_id, anchor.anchor_hash], [41, digest.tip_row_hash])
  assert.equal(verifyChain(db).ok, true)
  assert.deepEqual([readFileSync(jsonl), readFileSync(digestFile)], before, 'resume does not rewrite the export')
  assert.deepEqual(outFiles(out), files)
  // 幂等：再来一次不会再删、不会再写审计
  const rows = db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n
  const second = A(['--resume', '--confirm', token])
  assert.equal(second.status, 0, second.stdout + second.stderr)
  assert.match(second.stdout, /already-archived/)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, rows)
  assert.equal(db.prepare("SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get().n, 1)
  assert.equal(cli(VERIFY, ['--data-dir', dir, '--industry', 'cosmetic'], dir).status, 0)
  db.close()
})

test('AC7 --resume refuses an export that is not exactly the db segment, an altered digest, and an incomplete export', { timeout: 120000 }, async (t) => {
  // 1) 库里不进哈希的列（user_name）在崩溃后被改：链仍通过，但导出文件已不是库里的那一段
  let f = await crashedArchive(t)
  f.db.prepare("UPDATE audit_logs SET user_name='mallory' WHERE id=7").run()
  assert.equal(verifyChain(f.db).ok, true)
  let r = f.A(['--resume', '--confirm', f.token])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /EXPORT_DB_MISMATCH/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  f.db.close()
  // 2) 导出文件被改一个字节
  f = await crashedArchive(t)
  const jsonl = path.join(f.out, outFiles(f.out).find((n) => n.endsWith('.jsonl')))
  const b = readFileSync(jsonl)
  b[20] = b[20] === 0x78 ? 0x79 : 0x78
  writeFileSync(jsonl, b)
  r = f.A(['--resume', '--confirm', f.token])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /EXPORT_(DIGEST|VERIFY)_MISMATCH/)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.ok(existsSync(jsonl), 'a refused resume never deletes the evidence')
  f.db.close()
  // 3) 摘要里的 file_sha256 被改
  f = await crashedArchive(t)
  const dg = path.join(f.out, outFiles(f.out).find((n) => n.endsWith('.digest.json')))
  const d = JSON.parse(readFileSync(dg, 'utf8'))
  d.file_sha256 = '0'.repeat(64)
  writeFileSync(dg, JSON.stringify(d))
  r = f.A(['--resume', '--confirm', f.token])
  assert.equal(r.status, 1)
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  f.db.close()
  // 4) 只有 JSONL、没有摘要（崩在导出途中）：不续做
  f = await crashedArchive(t)
  rmSync(path.join(f.out, outFiles(f.out).find((n) => n.endsWith('.digest.json'))))
  r = f.A(['--resume', '--confirm', f.token])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /RESUME_INCOMPLETE/)
  f.db.close()
  // 5) 什么都没导出过：--resume 不偷偷当成新归档
  const g = archiveReady(t)
  r = cli(ARCHIVE, archiveArgs(g.dir, g.out, ['--resume']), g.dir)
  assert.equal(r.status, 1)
  assert.match(r.stdout, /RESUME_NOTHING/)
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  g.db.close()
})

test('AC7 the pause hook is refused outside test mode', (t) => {
  const g = archiveReady(t)
  const r = cli(ARCHIVE, archiveArgs(g.dir, g.out), g.dir, { GML_RUNTIME_MODE: 'production', GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT: '1' })
  assert.equal(r.status, 2)
  assert.match(r.stderr, /GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT/)
  g.db.close()
})

// ---- AC7 Codex 审计后的加固回归 ----
test('AC7 hardening: encrypted artifacts without the key are not trusted via the plaintext manifest', (t) => {
  const e = backedUp(t, { key: BKEY })
  const r = cli(VERIFY, ['--data-dir', e.dir, '--against-backup', e.set, '--json'], e.dir)
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).against_backup.status, 'key-required')
  // 只拿到明文清单（离机副本）也不能当作已认证：.enc 清单不在旁边时，明文清单可用但会注明未认证
  const only = cli(VERIFY, ['--data-dir', e.dir, '--against-backup', e.set + '.audit-manifest.json', '--json'], e.dir)
  assert.equal(only.status, 1, 'the .enc sibling exists, so the key is required')
  e.db.close()
})

test('AC7 hardening: swapping the manifest anchor list while keeping the digest is caught; a backup whose chain was already broken is no baseline', (t) => {
  const p = backedUp(t)
  const mf = p.set + '.audit-manifest.json'
  const m = JSON.parse(readFileSync(mf, 'utf8'))
  m.audit_chain.anchors = [{ kind: 'erase', at_row_id: 2, anchor_hash: 'a'.repeat(64), prev_id: 1, prev_row_hash: 'b'.repeat(64), reason: 'x', created_at: '2026-01-01 00:00:00' }]
  writeFileSync(mf, JSON.stringify(m))
  assert.equal(JSON.parse(p.V().stdout).against_backup.status, 'manifest-mismatch')
  p.db.close()
  const dir = tmp(t)
  const db = mkDb(dir)
  fill(db, 8)
  db.prepare("UPDATE audit_logs SET detail='{\"edited\":1}' WHERE id=3").run() // 备份前链就已经断了
  assert.equal(cli(BACKUP, ['cosmetic'], dir).status, 0, 'a broken chain does not block the backup')
  const set = path.join(backupDirOf(dir), newestBackup(dir))
  assert.equal(JSON.parse(readFileSync(set + '.audit-manifest.json', 'utf8')).audit_chain.verified, false)
  const r = cli(VERIFY, ['--data-dir', dir, '--against-backup', set, '--json'], dir)
  assert.equal(r.status, 1)
  db.close()
})

test('AC7 hardening: archive digests are re-verified row by row, so a re-signed (sha256 updated) tampered JSONL does not prove descent', (t) => {
  const f = archivedTipFixture(t)
  archiveNow(f)
  const jsonl = path.join(f.out, readdirSync(f.out).find((n) => n.endsWith('.jsonl')))
  const digestFile = path.join(f.out, readdirSync(f.out).find((n) => n.endsWith('.digest.json')))
  const lines = readFileSync(jsonl, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
  lines[3].detail = '{"forged":true}' // 内容改了，row_hash 不动
  const text = lines.map((l) => JSON.stringify(l) + '\n').join('')
  writeFileSync(jsonl, text)
  const d = JSON.parse(readFileSync(digestFile, 'utf8'))
  d.file_sha256 = sha(text)
  writeFileSync(digestFile, JSON.stringify(d))
  const r = cli(VERIFY, ['--data-dir', f.dir, '--against-backup', f.set, '--archive-dir', f.out, '--json'], f.dir)
  assert.equal(r.status, 1)
  assert.equal(cos(r).against_backup.status, 'unverifiable')
  f.db.close()
})

test('AC7 hardening: --resume after a completed archive is idempotent even when every row predated the cutoff (the retained last row forms a new segment)', (t) => {
  const g = archiveReady(t)
  const A = (extra = []) => cli(ARCHIVE, ['--data-dir', g.dir, '--industry', 'cosmetic', '--before', '2027-01-01', '--out', g.out, ...extra], g.dir)
  const token = A().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  assert.equal(A(['--confirm', token]).status, 0)
  const rows = g.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n
  const r = A(['--resume', '--confirm', token])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /already-archived/)
  assert.equal(g.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, rows)
  g.db.close()
})

// ============================================================================
// AE5（ADR-0055 补充）：锚点操作对账——保留清理 / 归档 / 隐私抹除在新增锚点的同一事务里写 audit_anchor_intents 意图行，
// 并在操作审计行里引用它；`--offbox` 校验要求已锚定范围内每个新锚点都有匹配意图且意图被审计行印证。迁移 072。
// ============================================================================
import { anchorMark, recordAnchorIntent, INTENT_FORMAT } from '../server/lib/audit-anchor-intent.js'

const OFFBOX = 'scripts/offbox-anchor.mjs'
const KEYGEN = 'scripts/release-keygen.mjs'
function ae5Keys(t) {
  const dir = path.join(tmp(t, 'os-ae5-keys-'), 'keys')
  const r = cli(KEYGEN, ['--out', dir], dir.replace(/keys$/, ''))
  assert.equal(r.status, 0, r.stderr)
  return { priv: path.join(dir, 'release-sign.key.pem'), pub: path.join(dir, 'release-sign.pub.pem') }
}
/** 60 行（前 40 行是 2024 年）+ 已写好一份签名离机锚点 */
function ae5World(t) {
  const f = archiveReady(t)
  const dest = tmp(t, 'os-ae5-dest-')
  const k = ae5Keys(t)
  const anchored = cli(OFFBOX, ['--data-dir', f.dir, '--dest', dest, '--key', k.priv], f.dir) // 不带 --log：用仓库内默认日志路径
  assert.equal(anchored.status, 0, anchored.stderr)
  const file = path.join(dest, readdirSync(dest).find((n) => /^anchor-.*\.json$/.test(n)))
  // AF5：基线之后做过归档时，对账需要归档摘要目录，所以默认带 --archive-dir；`blind` 是不带的版本
  const verify = (extra = [], env = {}) => cli(VERIFY, ['--data-dir', f.dir, '--industry', 'cosmetic', '--offbox', file, '--pubkey', k.pub, '--json', ...(extra.includes('--archive-dir') ? [] : ['--archive-dir', f.out]), ...extra], f.dir, env)
  const blind = (extra = [], env = {}) => cli(VERIFY, ['--data-dir', f.dir, '--industry', 'cosmetic', '--offbox', file, '--pubkey', k.pub, '--json', ...extra], f.dir, env)
  const archive = (env = {}) => {
    const A = (extra = []) => cli(ARCHIVE, ['--data-dir', f.dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', f.out, ...extra], f.dir, env)
    const token = A().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
    return A(['--confirm', token])
  }
  return { ...f, dest, k, file, verify, blind, archive }
}
const off = (r) => cos(r).offbox
/** 攻击者：改第 1 行并重算它，再登记一条把新哈希接回第 2 行原 prev_hash 的桥锚点；返回锚点前的 mark */
function forgeBridge(db) {
  const r1 = db.prepare('SELECT * FROM audit_logs WHERE id=1').get()
  const r2 = db.prepare('SELECT * FROM audit_logs WHERE id=2').get()
  const newHash = spec({ ...r1, detail: '{"forged":true}' }, GENESIS)
  const mark = anchorMark(db)
  db.transaction(() => {
    db.prepare("UPDATE audit_logs SET detail='{\"forged\":true}', row_hash=? WHERE id=1").run(newHash)
    db.prepare("INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES ('retention', 2, ?, 1, ?, 'forged bridge')").run(r2.prev_hash, newHash)
  })()
  assert.equal(verifyChain(db).ok, true, 'the live chain verifies on its own')
  return mark
}

test('AE5 forged bridge anchor without an intent is a rewrite, and --accept-new-anchors no longer waves it through', (t) => {
  const w = ae5World(t)
  assert.equal(w.verify().status, 0, 'baseline: nothing changed since the offbox anchor')
  forgeBridge(w.db)
  for (const extra of [[], ['--accept-new-anchors']]) {
    const r = w.verify(extra)
    assert.equal(r.status, 1, r.stdout)
    assert.deepEqual([off(r).status, off(r).kind], ['rewrite', 'anchor-without-intent'])
  }
  w.db.close()
})

test('AE5 legitimate archive writes an intent in the same transaction as its anchor, references it from AUDIT_ARCHIVE, and verifies ok without any opt-in flag', (t) => {
  const w = ae5World(t)
  const r = w.archive()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const intents = w.db.prepare('SELECT * FROM audit_anchor_intents').all()
  assert.equal(intents.length, 1)
  const [it] = intents
  assert.equal(it.operation, 'archive')
  assert.match(it.range_desc, /ids 1\.\.40/)
  assert.match(it.intent_hash, /^[0-9a-f]{64}$/)
  assert.equal(it.signature, null, 'unsigned when no signing key is configured')
  const arch = w.db.prepare("SELECT id, detail FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get()
  assert.deepEqual([JSON.parse(arch.detail).anchor_intent.id, JSON.parse(arch.detail).anchor_intent.hash, it.audit_row_id], [it.id, it.intent_hash, arch.id])
  const anchor = w.db.prepare("SELECT * FROM audit_chain_anchors WHERE kind='archive'").get()
  assert.ok(JSON.parse(it.anchors_json).some((a) => a[1] === anchor.at_row_id && a[2] === anchor.anchor_hash))
  const v = w.verify()
  assert.equal(v.status, 0, v.stdout)
  assert.equal(off(v).status, 'ok')
  assert.equal(off(v).anchors_added_in_range, 1)
  w.db.close()
})

test('AE5 an intent without a corroborating audit-log row is a rewrite (forged intent, wrong action, wrong hash, row predating the offbox anchor)', (t) => {
  const w = ae5World(t)
  const mark = forgeBridge(w.db)
  // 1) 伪造一条哈希正确的意图，但没有任何审计行
  const intent = w.db.transaction(() => recordAnchorIntent(w.db, mark, { operation: 'retention', range: 'forged', operatorName: 'mallory' })).immediate()
  assert.ok(intent.id)
  let r = w.verify()
  assert.equal(r.status, 1, r.stdout)
  assert.deepEqual([off(r).status, off(r).kind], ['rewrite', 'intent-uncorroborated'])
  assert.equal(w.verify(['--accept-new-anchors']).status, 1, 'the opt-in flag does not cover an intent whose audit row never existed')
  // 2) 审计行存在但 action 与意图的操作不符
  const lie = (action, hash = intent.hash, id = intent.id) => {
    insertAuditRow(w.db, { userName: 'mallory', action, module: 'audit', entity: 'audit_logs', entityId: 'cosmetic', detail: { anchor_intent: { id, hash } } })
    w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=(SELECT MAX(id) FROM audit_logs) WHERE id=?').run(intent.id)
  }
  lie('LOGIN')
  r = w.verify()
  assert.deepEqual([r.status, off(r).kind], [1, 'intent-uncorroborated'], 'wrong action')
  // 3) action 对，但引用的哈希不是这条意图的
  lie('RETENTION_PURGE', 'f'.repeat(64))
  r = w.verify()
  assert.deepEqual([r.status, off(r).kind], [1, 'intent-uncorroborated'], 'wrong hash')
  // 4) 一切对得上 ⇒ 通过（说明前面的失败确实来自缺失的印证）
  lie('RETENTION_PURGE')
  r = w.verify()
  assert.equal(r.status, 0, r.stdout)
  // 5) 意图被改（范围描述）⇒ 哈希对不上
  w.db.prepare("UPDATE audit_anchor_intents SET range_desc='something else' WHERE id=?").run(intent.id)
  r = w.verify()
  assert.deepEqual([r.status, off(r).kind], [1, 'intent-hash-mismatch'])
  w.db.close()
})

test('AE5 an audit row that predates the offbox anchor cannot corroborate a later anchor', (t) => {
  const w = ae5World(t)
  const mark = forgeBridge(w.db)
  const intent = w.db.transaction(() => recordAnchorIntent(w.db, mark, { operation: 'erase', range: 'forged', operatorName: 'mallory' })).immediate()
  // 指向锚定链尾之前就存在的一条真实行，并把引用写进…… 无法写进（哈希覆盖明细）：只能借用一条已有的行，它的 detail 不含引用
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=5 WHERE id=?').run(intent.id)
  const r = w.verify()
  assert.deepEqual([r.status, off(r).kind], [1, 'intent-uncorroborated'])
  w.db.close()
})

test('AE5 signed intents: archive signs with GML_ANCHOR_INTENT_KEY, verification checks the signature, tampering and missing signatures are caught under --require-signed-intents', (t) => {
  const w = ae5World(t)
  const r = w.archive({ GML_ANCHOR_INTENT_KEY: w.k.priv })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const it = w.db.prepare('SELECT * FROM audit_anchor_intents').get()
  assert.match(it.signature, /^[A-Za-z0-9+/]{86}==$/)
  assert.match(it.key_id, /^[0-9a-f]{64}$/)
  assert.equal(w.verify(['--require-signed-intents']).status, 0)
  // 签名被换成另一个有效签名位置的垃圾 ⇒ 失败
  w.db.prepare('UPDATE audit_anchor_intents SET signature=? WHERE id=?').run(it.signature.slice(0, 80) + 'AAAAAA==', it.id)
  let v = w.verify()
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-signature-invalid'])
  // 去掉签名：默认放行（签名可选），--require-signed-intents 失败
  w.db.prepare('UPDATE audit_anchor_intents SET signature=NULL, key_id=NULL WHERE id=?').run(it.id)
  assert.equal(w.verify().status, 0)
  v = w.verify(['--require-signed-intents'])
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-unsigned'])
  w.db.close()
})

test('AE5 an invalid configured signing key fails the archive closed (nothing deleted)', (t) => {
  const w = ae5World(t)
  const r = w.archive({ GML_ANCHOR_INTENT_KEY: path.join(w.dir, 'missing.pem') })
  assert.notEqual(r.status, 0)
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 60)
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM audit_anchor_intents').get().n, 0)
  w.db.close()
})

test('AE5 retention writes the intent and the RETENTION_PURGE reference in one transaction; a failing audit write rolls the intent back too', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  const ins = (i) => insertAuditRow(db, { userName: 'u', action: 'UPDATE', module: i % 2 ? 'master' : 'sales', entity: 'e', entityId: i, detail: { i } })
  for (let i = 0; i < 13; i++) ins(i) // 最后一行（i=12）是 sales 模块：不可清理，保证锚定链尾仍在库里
  db.exec("UPDATE audit_logs SET created_at='2020-01-01 00:00:00', row_hash=NULL, prev_hash=NULL")
  await_import().up(db)
  assert.equal(verifyChain(db).ok, true)
  const k = ae5Keys(t)
  const dest = tmp(t, 'os-ae5-dest-')
  assert.equal(cli(OFFBOX, ['--data-dir', dir, '--dest', dest, '--key', k.priv], dir).status, 0)
  const file = path.join(dest, readdirSync(dest)[0])
  const run = (env = {}) => cli('scripts/retention.mjs', ['cosmetic', '--execute', '--json', '--actor', 'ae5'], dir, env)
  // 审计写不进（BEFORE INSERT 触发器吞掉）⇒ 整个事务回滚，意图行也不留
  db.exec("CREATE TRIGGER no_purge_audit BEFORE INSERT ON audit_logs WHEN NEW.action='RETENTION_PURGE' BEGIN SELECT RAISE(IGNORE); END")
  assert.equal(run().status, 1)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_anchor_intents').get().n, 0)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_logs').get().n, 13)
  db.exec('DROP TRIGGER no_purge_audit')
  const r = run()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const its = db.prepare('SELECT * FROM audit_anchor_intents').all()
  assert.equal(its.length, 1)
  assert.equal(its[0].operation, 'retention')
  assert.equal(its[0].operator_name, 'ae5')
  const purge = db.prepare("SELECT id, detail FROM audit_logs WHERE action='RETENTION_PURGE'").get()
  assert.deepEqual([JSON.parse(purge.detail).anchor_intent.id, its[0].audit_row_id], [its[0].id, purge.id])
  const v = cli(VERIFY, ['--data-dir', dir, '--industry', 'cosmetic', '--offbox', file, '--pubkey', k.pub, '--json'], dir)
  assert.equal(v.status, 0, v.stdout)
  assert.equal(cos(v).offbox.status, 'ok')
  db.close()
})

test('AE5 migration 072: up() is idempotent, verify() matches up() (missing table or column ⇒ false, up repairs), intents table has no FK to audit_logs', (t) => {
  const db = mkDb(tmp(t))
  const mig = createRequire(import.meta.url)(path.join(MIGRATIONS_DIR, '072_audit_anchor_intents.cjs'))
  assert.equal(mig.verify(db), true)
  mig.up(db); mig.up(db)
  assert.equal(mig.verify(db), true)
  const cols = db.prepare('PRAGMA table_info(audit_anchor_intents)').all().map((c) => c.name)
  for (const c of ['id', 'created_at', 'operation', 'range_desc', 'operator_user_id', 'operator_name', 'anchors_json', 'intent_hash', 'key_id', 'signature', 'audit_row_id']) assert.ok(cols.includes(c), c)
  assert.throws(() => db.prepare("INSERT INTO audit_anchor_intents (operation, range_desc, operator_name, anchors_json, intent_hash) VALUES ('bogus','x','y','[]','h')").run(), /CHECK/)
  db.exec('DROP TABLE audit_anchor_intents')
  assert.equal(mig.verify(db), false)
  mig.up(db)
  assert.equal(mig.verify(db), true)
  db.exec('DROP TABLE audit_anchor_intents; CREATE TABLE audit_anchor_intents (id INTEGER PRIMARY KEY)') // 列不全的残表
  assert.equal(mig.verify(db), false)
  assert.equal(INTENT_FORMAT, 'os-erp-audit-anchor-intent/1')
})

test('AE5 migration 072 repairs a populated partial table (constant defaults only, CHECK restored, rows kept) and refuses to call a table without id healthy', (t) => {
  const db = mkDb(tmp(t))
  const mig = createRequire(import.meta.url)(path.join(MIGRATIONS_DIR, '072_audit_anchor_intents.cjs'))
  db.exec('DROP TABLE audit_anchor_intents; CREATE TABLE audit_anchor_intents (id INTEGER PRIMARY KEY, operation TEXT)')
  db.prepare("INSERT INTO audit_anchor_intents (operation) VALUES ('archive')").run()
  assert.equal(mig.verify(db), false)
  mig.up(db)
  assert.equal(mig.verify(db), true)
  assert.equal(db.prepare('SELECT COUNT(*) n FROM audit_anchor_intents').get().n, 1, 'rows survive the rebuild')
  assert.throws(() => db.prepare("INSERT INTO audit_anchor_intents (operation, range_desc, operator_name, anchors_json, intent_hash) VALUES ('bogus','x','y','[]','h')").run(), /CHECK/)
  // 没有 id 列的表不能算健康（校验读 id）
  db.exec('DROP TABLE audit_anchor_intents; CREATE TABLE audit_anchor_intents (operation TEXT)')
  assert.equal(mig.verify(db), false)
  mig.up(db)
  assert.equal(mig.verify(db), true)
})

test('AE5 an audit row that is missing without any archive evidence is uncorroborated even under --accept-new-anchors (Codex AE5-M1)', (t) => {
  const w = ae5World(t)
  const mark = forgeBridge(w.db)
  const intent = w.db.transaction(() => recordAnchorIntent(w.db, mark, { operation: 'retention', range: 'forged', operatorName: 'mallory' })).immediate()
  // 指向一个从未存在的审计行 id（库里没有任何 archive 锚点可以解释它的消失）
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=61 WHERE id=?').run(intent.id)
  let r = w.verify(['--accept-new-anchors'])
  assert.deepEqual([r.status, off(r).kind], [1, 'intent-uncorroborated'], 'row 61 does not exist and nothing was archived')
  w.db.close()
})


// ============================================================================
// AF5（ADR-0055 补充 2）：`--against-backup` 同样做锚点意图对账；"印证行被归档"路径不可达 ⇒ 删除，旧开关变成无效果；密钥保管见 release-signing 测试
// ============================================================================
/** 60 行（前 40 行是 2024 年）+ 一份刚做的备份；备份链尾 = id 60 */
function af5World(t, { env = {} } = {}) {
  const f = archiveReady(t)
  const b = cli(BACKUP, ['cosmetic'], f.dir)
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const set = path.join(backupDirOf(f.dir), newestBackup(f.dir))
  const verify = (extra = [], e = {}) => cli(VERIFY, ['--data-dir', f.dir, '--against-backup', set, '--json', ...(extra.includes('--archive-dir') ? [] : ['--archive-dir', f.out]), ...extra], f.dir, { ...env, ...e })
  const blind = (extra = [], e = {}) => cli(VERIFY, ['--data-dir', f.dir, '--against-backup', set, '--json', ...extra], f.dir, { ...env, ...e })
  const archive = (e = {}) => {
    const A = (extra = []) => cli(ARCHIVE, ['--data-dir', f.dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', f.out, ...extra], f.dir, e)
    const token = A().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
    return A(['--confirm', token])
  }
  return { ...f, set, verify, blind, archive }
}
const ab = (r) => cos(r).against_backup

test('AF5 --against-backup: a forged bridge anchor inside the backed-up range without an intent is a rewrite, even though it is only "listed" by --strict-anchors', (t) => {
  const w = af5World(t)
  assert.equal(w.verify().status, 0, 'baseline')
  forgeBridge(w.db)
  for (const extra of [[], ['--accept-new-anchors'], ['--strict-anchors']]) {
    const r = w.verify(extra)
    assert.equal(r.status, 1, r.stdout)
    assert.deepEqual([ab(r).status, ab(r).kind], ['rewrite', 'anchor-without-intent'])
    assert.equal(ab(r).anchors_added.length, 1, 'still listed')
    assert.equal(ab(r).intent_problems[0].anchor, 'retention@2')
  }
  w.db.close()
})

test('AF5 --against-backup: a legitimate archive after the backup passes through its intent without any flag, and signatures are checked with --intent-pubkey', (t) => {
  const k = ae5Keys(t)
  const w = af5World(t)
  const r = w.archive({ GML_ANCHOR_INTENT_KEY: k.priv })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const v = w.verify()
  assert.equal(v.status, 0, v.stdout)
  assert.equal(ab(v).anchors_added_in_range, 1)
  assert.equal(ab(v).intents_checked, 1)
  const signed = w.verify(['--require-signed-intents', '--intent-pubkey', k.pub])
  assert.equal(signed.status, 0, signed.stdout)
  // 另一把公钥：明确给的意图公钥集合里没有签名者的 key_id ⇒ intent-key-unknown（AG5；AE5 时是 unverifiable，且只在要求签名时才失败）
  const other = ae5Keys(t)
  const wrongKey = w.verify(['--require-signed-intents', '--intent-pubkey', other.pub])
  assert.deepEqual([wrongKey.status, ab(wrongKey).kind], [1, 'intent-key-unknown'])
  // 篡改签名
  const it = w.db.prepare('SELECT * FROM audit_anchor_intents').get()
  w.db.prepare('UPDATE audit_anchor_intents SET signature=? WHERE id=?').run(it.signature.slice(0, 80) + 'AAAAAA==', it.id)
  const bad = w.verify(['--intent-pubkey', k.pub])
  assert.deepEqual([bad.status, ab(bad).kind], [1, 'intent-signature-invalid'])
  w.db.close()
})

test('AF5 --against-backup: --require-signed-intents needs --intent-pubkey, and an unsigned intent fails under it', (t) => {
  const k = ae5Keys(t)
  const w = af5World(t)
  assert.equal(w.archive().status, 0)
  const noKey = w.verify(['--require-signed-intents'])
  assert.equal(noKey.status, 2, 'there is no --pubkey to fall back to in this mode')
  assert.match(noKey.stderr, /--intent-pubkey/)
  const unsigned = w.verify(['--require-signed-intents', '--intent-pubkey', k.pub])
  assert.deepEqual([unsigned.status, ab(unsigned).kind], [1, 'intent-unsigned'])
  const plain = w.verify()
  assert.equal(plain.status, 0)
  assert.ok(ab(plain).notes.some((n) => /签名未验证|未验证签名/.test(n)), 'says that signatures were not verified when no public key was given')
  w.db.close()
})

test('AF5 --against-backup: an intent whose audit row predates the backup tip cannot corroborate (and a forged one with a later row but wrong action fails)', (t) => {
  const w = af5World(t)
  const mark = forgeBridge(w.db)
  const intent = w.db.transaction(() => recordAnchorIntent(w.db, mark, { operation: 'erase', range: 'forged', operatorName: 'mallory' })).immediate()
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=5 WHERE id=?').run(intent.id)
  let r = w.verify()
  assert.deepEqual([r.status, ab(r).kind], [1, 'intent-uncorroborated'])
  insertAuditRow(w.db, { userName: 'mallory', action: 'UPDATE', module: 'audit', entity: 'audit_logs', entityId: 'cosmetic', detail: { anchor_intent: { id: intent.id, hash: intent.hash } } })
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=(SELECT MAX(id) FROM audit_logs) WHERE id=?').run(intent.id)
  r = w.verify()
  assert.deepEqual([r.status, ab(r).kind], [1, 'intent-uncorroborated'], 'wrong action')
  w.db.close()
})

test('AF5 anchors appended after the backup tip are normal growth and are not reconciled (same range rule as --offbox)', (t) => {
  const w = af5World(t)
  // 备份之后追加一行，再在其上做一次"保留清理式"受控删除：锚点落在备份链尾之后
  fill(w.db, 3, 500)
  const mark = anchorMark(w.db)
  w.db.transaction(() => deleteAuditRowsAnchored(w.db, 'id = ?', [62], { kind: 'retention', reason: 'retention test' }))()
  assert.ok(anchorMark(w.db) > mark)
  const v = w.verify()
  assert.equal(v.status, 0, v.stdout)
  assert.equal(ab(v).anchors_added_in_range, 0)
  assert.equal(ab(v).anchors_added.length, 1)
  w.db.close()
})

test('AF5 the "corroborating row was archived" path is unreachable, so it is gone: --accept-new-anchors is inert, a later archive deletes the in-range anchor together with the row', (t) => {
  const w = ae5World(t)
  assert.equal(w.archive().status, 0)
  const a1 = w.db.prepare("SELECT id, at_row_id FROM audit_chain_anchors WHERE kind='archive'").get()
  const corroborating = w.db.prepare("SELECT id FROM audit_logs WHERE action='AUDIT_ARCHIVE'").get().id
  assert.ok(a1.at_row_id <= 60 && corroborating > 60, 'anchor is in the anchored range, its corroborating row is after the offbox tip')
  // 第二次归档把印证行也搬出库（需要它后面还有一行）：同一事务里 at_row_id <= 段尾 的全部旧锚点（含上面这条）一起删除
  fill(w.db, 1, 1000)
  const A2 = (extra = []) => cli(ARCHIVE, ['--data-dir', w.dir, '--industry', 'cosmetic', '--before', '2099-01-01', '--out', w.out, ...extra], w.dir)
  const token = A2().stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  const r2 = A2(['--confirm', token])
  assert.equal(r2.status, 0, r2.stdout + r2.stderr)
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM audit_logs WHERE id=?').get(corroborating).n, 0, 'corroborating row is archived')
  assert.equal(w.db.prepare('SELECT COUNT(*) n FROM audit_chain_anchors WHERE id=?').get(a1.id).n, 0, 'and the in-range anchor went with it: the two never coexist')
  const ok = w.verify()
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  // 库内已没有范围内的锚点；第一次归档的锚点现在只存在于第二次归档的摘要里，由摘要 + 归档 JSONL 里的印证行对账（通过）
  assert.equal(off(ok).anchors_added_in_range, 1)
  assert.equal(off(ok).archived_anchors_in_range, 1)
  assert.equal(off(ok).intents_checked, 1)
  // 攻击者补回一条在范围内的锚点 + 指向已归档行的意图：以前 --accept-new-anchors 会放行它
  const mark = anchorMark(w.db)
  const intent = w.db.transaction(() => {
    w.db.prepare("INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES ('retention', 5, ?, 4, ?, 'forged')").run('a'.repeat(64), 'b'.repeat(64))
    return recordAnchorIntent(w.db, mark, { operation: 'archive', range: 'forged', operatorName: 'mallory' })
  }).immediate()
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=? WHERE id=?').run(corroborating, intent.id)
  for (const extra of [[], ['--accept-new-anchors']]) {
    const r = w.verify([...extra])
    assert.equal(r.status, 1, r.stdout)
    assert.deepEqual([off(r).status, off(r).kind], ['rewrite', 'intent-uncorroborated'])
  }
  const flagged = w.verify(['--accept-new-anchors'])
  assert.match(flagged.stderr, /accept-new-anchors.*(无效|不再)/, 'the removed flag says so instead of silently doing nothing')
  assert.doesNotMatch(readFileSync(path.join(ROOT, 'server/lib/audit-anchor-intent.js'), 'utf8'), /corroboration-archived|acceptArchived/)
  w.db.close()
})

/** 攻击者先伪造桥锚点（备份 / 离机锚点之后），再跑一次合法归档把它连同被改写的行搬进摘要，库里只剩 archive 锚点 */
function launderThroughArchive(w) {
  forgeBridge(w.db)
  const r = w.archive()
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.equal(w.db.prepare("SELECT COUNT(*) n FROM audit_chain_anchors WHERE kind='retention'").get().n, 0, 'the forged bridge is gone from the live table')
  const digest = JSON.parse(readFileSync(path.join(w.out, readdirSync(w.out).find((n) => n.endsWith('.digest.json'))), 'utf8'))
  assert.ok(digest.anchors.some((a) => a.kind === 'retention' && a.at_row_id === 2), 'but the digest still carries it')
}

test('AF5 --against-backup: a forged bridge laundered out of the live table by a later archive is still reconciled from the archive digest (Codex AF5-H1)', (t) => {
  const w = af5World(t)
  launderThroughArchive(w)
  const r = w.verify()
  assert.equal(r.status, 1, r.stdout)
  assert.deepEqual([ab(r).status, ab(r).kind], ['rewrite', 'anchor-without-intent'])
  assert.equal(ab(r).archived_anchors_in_range, 1)
  assert.equal(ab(r).intent_problems[0].anchor, 'retention@2')
  // 没给 --archive-dir：看不到摘要，不能假装对账过——失败闭合（unverifiable），不是静默通过
  const blind = w.blind()
  assert.equal(blind.status, 1)
  assert.deepEqual([ab(blind).status, ab(blind).kind], ['unverifiable', 'archive-evidence-missing'])
  // 给了目录但里面没有验证通过的摘要（JSONL 被损坏）也一样
  const damaged = tmp(t, 'os-af5-damaged-')
  for (const n of readdirSync(w.out)) copyFileSync(path.join(w.out, n), path.join(damaged, n))
  const jsonl = readdirSync(damaged).find((n) => n.endsWith('.jsonl'))
  writeFileSync(path.join(damaged, jsonl), readFileSync(path.join(damaged, jsonl), 'utf8').replace('"forged', '"forgeD'))
  const bad = w.blind(['--archive-dir', damaged])
  assert.deepEqual([bad.status, ab(bad).kind], [1, 'archive-evidence-missing'])
  const empty = w.blind(['--archive-dir', tmp(t, 'os-af5-empty-')])
  assert.deepEqual([empty.status, ab(empty).kind], [1, 'archive-evidence-missing'])
  w.db.close()
})

test('AF5 --offbox: the same laundering is caught from the archive digest', (t) => {
  const w = ae5World(t)
  launderThroughArchive(w)
  const r = w.verify()
  assert.equal(r.status, 1, r.stdout)
  assert.deepEqual([off(r).status, off(r).kind], ['rewrite', 'anchor-without-intent'])
  assert.equal(off(r).archived_anchors_in_range, 1)
  w.db.close()
})

test('AF5 a legitimate retention-style anchor that was later archived verifies via the archived corroborating row, and archives from before the baseline are not mistaken for new anchors', (t) => {
  const w = af5World(t)
  // 基线之前的归档：做过一次，再做备份——它的锚点在摘要里、不在备份清单里，但行号早于备份的 first_id
  assert.equal(w.archive().status, 0)
  const b = cli(BACKUP, ['cosmetic'], w.dir)
  assert.equal(b.status, 0, b.stdout)
  const set2 = path.join(backupDirOf(w.dir), newestBackup(w.dir))
  const V2 = (extra = []) => cli(VERIFY, ['--data-dir', w.dir, '--against-backup', set2, '--archive-dir', w.out, '--json', ...extra], w.dir)
  const v = V2()
  assert.equal(v.status, 0, v.stdout + v.stderr)
  assert.equal(ab(v).anchors_added_in_range ?? 0, 0, 'the pre-baseline archive is baseline, not growth')
  w.db.close()
})

test('AF5 --against-backup --strict-anchors: an empty-chain baseline still reports added anchors (Codex AF5-M1)', (t) => {
  const dir = tmp(t)
  const db = mkDb(dir)
  const b = cli(BACKUP, ['cosmetic'], dir)
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const set = path.join(backupDirOf(dir), newestBackup(dir))
  fill(db, 4)
  db.transaction(() => deleteAuditRowsAnchored(db, 'id = ?', [2], { kind: 'retention', reason: 'x' }))()
  const V = (extra = []) => cli(VERIFY, ['--data-dir', dir, '--against-backup', set, '--json', ...extra], dir)
  const plain = V()
  assert.equal(plain.status, 0, plain.stdout)
  assert.equal(ab(plain).anchors_added.length, 1, 'listed even for an empty baseline')
  const strict = V(['--strict-anchors'])
  assert.equal(strict.status, 1)
  assert.equal(ab(strict).status, 'anchors-changed')
  db.close()
})

/** 往归档目录里放一份自洽但不属于本库的单行摘要 + JSONL（Codex AF5 二轮：不连在用库的摘要不能提供锚点清单或印证行） */
function plantSegment(dir, { id = 9999, action = 'RETENTION_PURGE', detail = '{}', anchors = [] } = {}) {
  const prev = 'f'.repeat(64)
  const r = { id, user_id: null, user_name: 'x', action, module: 'audit', entity: 'audit_logs', entity_id: 'c', detail, ip: null, created_at: '2026-10-24 10:00:00', prev_hash: prev }
  r.row_hash = spec(r, prev)
  const text = JSON.stringify(r) + '\n'
  const file = `audit-archive-cosmetic-planted-${id}-${id}.jsonl`
  writeFileSync(path.join(dir, file), text)
  writeFileSync(path.join(dir, file.replace(/\.jsonl$/, '.digest.json')), JSON.stringify({ format: 'os-erp-audit-archive/1', industry: 'cosmetic', before: 'planted', rows: 1, first_id: id, last_id: id, first_row_hash: r.row_hash, first_prev_hash: prev, tip_row_hash: r.row_hash, boundary_id: id + 1, file, file_sha256: sha(text), anchors }, null, 2))
}

test('AF5 a planted, self-consistent archive segment that does not connect to the live database cannot corroborate a forged intent (Codex AF5 round 2)', (t) => {
  const w = af5World(t)
  const mark = forgeBridge(w.db)
  const intent = w.db.transaction(() => recordAnchorIntent(w.db, mark, { operation: 'retention', range: 'forged', operatorName: 'mallory' })).immediate()
  w.db.prepare('UPDATE audit_anchor_intents SET audit_row_id=9999 WHERE id=?').run(intent.id)
  plantSegment(w.out, { detail: JSON.stringify({ anchor_intent: { id: intent.id, hash: intent.hash } }) })
  const r = w.verify()
  assert.equal(r.status, 1, r.stdout)
  assert.deepEqual([ab(r).status, ab(r).kind], ['rewrite', 'intent-uncorroborated'])
  w.db.close()
})

test('AF5 a planted digest carrying an unrelated anchor does not make a legitimate archive fail (only digests connected to the live database count)', (t) => {
  const w = af5World(t)
  assert.equal(w.archive().status, 0)
  plantSegment(w.out, { anchors: [{ kind: 'retention', at_row_id: 5, anchor_hash: 'a'.repeat(64), prev_id: 4, prev_row_hash: 'b'.repeat(64), reason: 'noise', created_at: '2026-01-01 00:00:00' }] })
  const r = w.verify()
  assert.equal(r.status, 0, r.stdout)
  assert.equal(ab(r).anchors_added_in_range, 1, 'only the real archive anchor')
  w.db.close()
})


// ============================================================================
// AG5（ADR-0055 补充 3）：意图签名密钥轮换——公钥集合（多次 --intent-pubkey / 目录）、按 key_id 选钥、未知 key_id、过渡规则（无 key_id 的旧意图）
// ============================================================================
/** 一把初始密钥 + 一次 --rotate：同一保管目录里有两对 anchor-intent 密钥（A = 旧，B = 新） */
function ag5Keys(t) {
  const base = tmp(t, 'os-ag5-keys-')
  const dir = path.join(base, 'keys')
  const a = cli(KEYGEN, ['--out', dir, '--purpose', 'anchor-intent'], base)
  assert.equal(a.status, 0, a.stderr)
  const b = cli(KEYGEN, ['--out', dir, '--purpose', 'anchor-intent', '--rotate'], base)
  assert.equal(b.status, 0, b.stderr)
  const A = JSON.parse(a.stdout)
  const B = JSON.parse(b.stdout)
  return { dir, A: { priv: A.private_key, pub: A.public_key, id: A.key_id }, B: { priv: B.private_key, pub: B.public_key, id: B.key_id } }
}
const pubs = (...files) => files.flatMap((f) => ['--intent-pubkey', f])

test('AG5 an intent signed with the rotated key records that key\'s key_id and verifies against a key set given as repeated flags or as a directory, in any order', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  const it = w.db.prepare('SELECT * FROM audit_anchor_intents').get()
  assert.equal(it.key_id, ks.B.id, 'key_id is the fingerprint of the signing public key')
  assert.equal(it.key_id, createHash('sha256').update(createPublicKey(readFileSync(ks.B.pub)).export({ type: 'spki', format: 'der' })).digest('hex'))
  for (const set of [pubs(ks.A.pub, ks.B.pub), pubs(ks.B.pub, ks.A.pub), pubs(ks.dir), pubs(ks.B.pub)]) {
    const v = w.verify(['--require-signed-intents', ...set])
    assert.equal(v.status, 0, v.stdout)
  }
  w.db.close()
})

test('AG5 an intent whose key_id is not in the supplied key set is intent-key-unknown (rewrite), with or without --require-signed-intents', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  for (const extra of [[], ['--require-signed-intents']]) {
    const v = w.verify([...extra, ...pubs(ks.A.pub)])
    assert.deepEqual([v.status, off(v).status, off(v).kind], [1, 'rewrite', 'intent-key-unknown'])
    assert.match(off(v).intent_problems[0].message, new RegExp(ks.B.id.slice(0, 16)))
  }
  // 不是 64 位十六进制的 key_id 也只是“未知”
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=?').run('zz')
  assert.equal(off(w.verify(pubs(ks.A.pub, ks.B.pub))).kind, 'intent-key-unknown')
  w.db.close()
})

test('AG5 the key is selected by key_id, not by trying every key: a key_id spoofed to another trusted key fails verification', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=?').run(ks.A.id)
  const v = w.verify(pubs(ks.A.pub, ks.B.pub))
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-signature-invalid'])
  w.db.close()
})

test('AG5 transition rule: an intent without key_id (written before rotation support) verifies against any supplied key; --require-intent-key-id ends the transition', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.A.priv }).status, 0)
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=NULL').run()
  let v = w.verify(['--require-signed-intents', ...pubs(ks.B.pub, ks.A.pub)])
  assert.equal(v.status, 0, v.stdout)
  // 集合里没有签名者 ⇒ 签名不对
  v = w.verify(pubs(ks.B.pub))
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-signature-invalid'])
  // 过渡结束：不再接受没有 key_id 的签名意图
  v = w.verify(['--require-intent-key-id', ...pubs(ks.A.pub)])
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-key-id-missing'])
  // 一个带 key_id 的意图不受影响
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=?').run(ks.A.id)
  assert.equal(w.verify(['--require-intent-key-id', ...pubs(ks.A.pub)]).status, 0)
  w.db.close()
})

test('AG5 without an explicit --intent-pubkey the offbox --pubkey is only an implicit fallback: a signed intent from another key keeps the AE5 behaviour (skipped, or unverifiable under --require-signed-intents)', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  assert.equal(w.verify().status, 0)
  const v = w.verify(['--require-signed-intents'])
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-signature-unverifiable'])
  w.db.close()
})

test('AG5 --against-backup takes the same key set; an unknown key_id is intent-key-unknown there too', (t) => {
  const w = af5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  const ok = w.verify(['--require-signed-intents', ...pubs(ks.dir)])
  assert.equal(ok.status, 0, ok.stdout)
  const bad = w.verify(pubs(ks.A.pub))
  assert.deepEqual([bad.status, ab(bad).kind], [1, 'intent-key-unknown'])
  w.db.close()
})

test('AG5 a key directory only contributes *.pub.pem files; empty directories, private keys named *.pub.pem and missing paths are usage errors', (t) => {
  const w = ae5World(t)
  const ks = ag5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: ks.B.priv }).status, 0)
  // 保管目录里还躺着私钥与别的文件：只读 *.pub.pem
  writeFileSync(path.join(ks.dir, 'notes.txt'), 'not a key')
  assert.equal(w.verify(pubs(ks.dir)).status, 0)
  const empty = tmp(t, 'os-ag5-empty-')
  const e = w.verify(pubs(empty))
  assert.equal(e.status, 2, e.stdout)
  assert.match(e.stderr, /\.pub\.pem/)
  const sneaky = tmp(t, 'os-ag5-sneaky-')
  copyFileSync(ks.B.priv, path.join(sneaky, 'x.pub.pem'))
  const s = w.verify(pubs(sneaky))
  assert.equal(s.status, 2)
  assert.match(s.stderr, /private key/)
  assert.equal(w.verify(pubs(path.join(empty, 'nope'))).status, 2)
  w.db.close()
})

// ============================================================================
// AH5（ADR-0055 补充 4）：--require-intent-key-id 的默认随运行模式；baseline-anchor-list-missing 分支
// ============================================================================
test('AH5 resolveKeyIdRequirement: the flag always wins; demo/test never enforce by date; production enforces from the (validated) date, inclusive, in UTC', () => {
  const at = (s) => new Date(s)
  const R = (o) => resolveKeyIdRequirement(o)
  assert.deepEqual([R({ flag: true, env: { GML_RUNTIME_MODE: 'test' } }).required, R({ flag: true, env: { GML_RUNTIME_MODE: 'test' } }).rule], [true, 'flag'])
  assert.equal(R({ flag: true, env: { GML_RUNTIME_MODE: 'production', GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2999-01-01' } }).required, true, 'flag beats a future date')
  for (const mode of ['demo', 'test']) {
    const r = R({ env: { GML_RUNTIME_MODE: mode, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2000-01-01' }, now: at('2030-01-01T00:00:00Z') })
    assert.deepEqual([r.required, r.rule, r.mode], [false, 'mode-not-enforcing', mode], 'a date in the environment does not turn enforcement on in demo/test')
  }
  // 缺省日期 2026-12-01（UTC 零点，含当天）
  const prod = { GML_RUNTIME_MODE: 'production' }
  assert.equal(R({ env: prod, now: at('2026-11-30T23:59:59Z') }).required, false)
  const on = R({ env: prod, now: at('2026-12-01T00:00:00Z') })
  assert.deepEqual([on.required, on.rule, on.after], [true, 'production-date-reached', '2026-12-01'])
  assert.equal(R({ env: {}, now: at('2027-01-01T00:00:00Z') }).required, true, 'GML_RUNTIME_MODE unset means production, as in runtimeMode()')
  assert.equal(R({ env: { ...prod, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2027-06-01' }, now: at('2027-05-31T23:59:59Z') }).required, false)
  assert.equal(R({ env: { ...prod, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2027-06-01' }, now: at('2027-06-01T00:00:00Z') }).required, true)
  assert.equal(R({ env: { ...prod, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '' }, now: at('2027-01-01T00:00:00Z') }).after, '2026-12-01', 'empty means unset')
  // 非法值一律抛错（失败闭合，不回落到“不强制”）
  for (const bad of ['tomorrow', '2026-13-01', '2026-02-30', '2026-12-1', '2026-12-01T00:00:00Z', ' 2026-12-01', '20261201', '0000-00-00', '2026-12-01\n']) {
    assert.throws(() => R({ env: { ...prod, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: bad }, now: at('2030-01-01T00:00:00Z') }), { code: 'INTENT_KEY_ID_AFTER_INVALID' }, JSON.stringify(bad))
  }
  assert.throws(() => R({ env: { GML_RUNTIME_MODE: 'staging' } }), { code: 'RUNTIME_MODE_INVALID' })
  assert.throws(() => R({ env: prod, now: new Date('nope') }), { code: 'INTENT_KEY_ID_AFTER_INVALID' }, 'an unusable clock does not silently disable enforcement')
})

/** 一条已签名但没有 key_id 的过渡期意图 + 对应基线 */
function ah5World(t) {
  const w = ae5World(t)
  const k = ae5Keys(t)
  assert.equal(w.archive({ GML_ANCHOR_INTENT_KEY: k.priv }).status, 0)
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=NULL').run()
  const intentArgs = ['--intent-pubkey', k.pub, '--require-signed-intents']
  return { ...w, ik: k, intentArgs }
}
const rule = (r) => JSON.parse(r.stdout).intent_key_id_rule

test('AH5 production enforces key_id from GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER; before that date (and in demo/test) the transition rule still applies; the output says which rule applied', (t) => {
  const w = ah5World(t)
  const prod = (after) => ({ GML_RUNTIME_MODE: 'production', ...(after ? { GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: after } : {}) })
  // 缺省日期（2026-12-01）在此刻之前或之后都由日期决定，测试用显式日期避免与时钟耦合
  let v = w.verify(w.intentArgs, prod('2000-01-01'))
  assert.deepEqual([v.status, off(v).kind], [1, 'intent-key-id-missing'])
  assert.deepEqual([rule(v).required, rule(v).rule, rule(v).mode, rule(v).after], [true, 'production-date-reached', 'production', '2000-01-01'])
  v = w.verify(w.intentArgs, prod('2999-12-31'))
  assert.equal(v.status, 0, v.stdout)
  assert.deepEqual([rule(v).required, rule(v).rule, rule(v).after], [false, 'production-date-not-reached', '2999-12-31'])
  // demo / test：日期被忽略
  for (const mode of ['test', 'demo']) {
    v = w.verify(w.intentArgs, { GML_RUNTIME_MODE: mode, GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2000-01-01' })
    assert.equal(v.status, 0, v.stdout)
    assert.deepEqual([rule(v).required, rule(v).rule, rule(v).mode], [false, 'mode-not-enforcing', mode])
  }
  // 显式开关永远生效：test 模式、production 的未来日期都一样
  for (const env of [{ GML_RUNTIME_MODE: 'test' }, prod('2999-12-31')]) {
    v = w.verify(['--require-intent-key-id', ...w.intentArgs], env)
    assert.deepEqual([v.status, off(v).kind, rule(v).rule], [1, 'intent-key-id-missing', 'flag'])
  }
  // 带 key_id 的意图在强制下通过
  w.db.prepare('UPDATE audit_anchor_intents SET key_id=?').run(createHash('sha256').update(createPublicKey(readFileSync(w.ik.pub)).export({ type: 'spki', format: 'der' })).digest('hex'))
  v = w.verify(w.intentArgs, prod('2000-01-01'))
  assert.equal(v.status, 0, v.stdout)
  assert.equal(rule(v).required, true)
  w.db.close()
})

test('AH5 an invalid GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER or runtime mode is a usage error (exit 2) in production, never a silent pass; plain-text output states the rule', (t) => {
  const w = ah5World(t)
  for (const bad of ['soon', '2026-02-30', '2026-12-1']) {
    const v = w.verify(w.intentArgs, { GML_RUNTIME_MODE: 'production', GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: bad })
    assert.equal(v.status, 2, bad)
    assert.match(v.stderr, /INTENT_KEY_ID_AFTER_INVALID/)
  }
  assert.equal(w.verify(w.intentArgs, { GML_RUNTIME_MODE: 'staging' }).status, 2)
  // 在 test 模式下日期没用到，所以不校验（避免无关配置挡住测试环境）
  assert.equal(w.verify(w.intentArgs, { GML_RUNTIME_MODE: 'test', GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: 'soon' }).status, 0)
  // 文本输出
  const text = cli(VERIFY, ['--data-dir', w.dir, '--industry', 'cosmetic', '--offbox', w.file, '--pubkey', w.k.pub, '--archive-dir', w.out, ...w.intentArgs], w.dir, { GML_RUNTIME_MODE: 'production', GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: '2999-12-31' })
  assert.equal(text.status, 0, text.stdout)
  assert.match(text.stdout, /intent key_id: not enforced \(production-date-not-reached, after 2999-12-31, mode production\)/)
  w.db.close()
})

test('AH5 the key_id rule is not evaluated (and not reported) for plain chain verification without --offbox / --against-backup', (t) => {
  const w = ah5World(t)
  const v = cli(VERIFY, ['--data-dir', w.dir, '--industry', 'cosmetic', '--json'], w.dir, { GML_RUNTIME_MODE: 'production', GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER: 'soon' })
  assert.equal(v.status, 0, v.stdout + v.stderr)
  assert.equal(JSON.parse(v.stdout).intent_key_id_rule, undefined)
  w.db.close()
})

test('AH5 baseline-anchor-list-missing: an offbox anchor entry that has a chain tip but no anchor list fails closed (unverifiable), never silently passes', (t) => {
  const w = ae5World(t)
  assert.equal(w.verify().status, 0, 'baseline with the anchor list is fine')
  // 旧格式 / 精简的锚点：同一份内容去掉 entry.anchors，用同一把钥重新签名（签名有效，所以走到的是对账分支而不是 OFFBOX-INVALID）
  const doc = JSON.parse(readFileSync(w.file, 'utf8'))
  const { signature, ...base } = doc.anchor
  const entry = { ...base.audit.cosmetic }
  assert.equal(entry.status, 'chain')
  delete entry.anchors
  const stripped = path.join(w.dest, 'anchor-stripped.json')
  writeFileSync(stripped, buildSignedAnchor({ createdAt: base.created_at, log: base.log, audit: { ...base.audit, cosmetic: entry } }, loadSigningKey(w.k.priv)))
  const run = (file) => cli(VERIFY, ['--data-dir', w.dir, '--industry', 'cosmetic', '--offbox', file, '--pubkey', w.k.pub, '--archive-dir', w.out, '--json'], w.dir)
  const r = run(stripped)
  assert.equal(r.status, 1, r.stdout)
  assert.deepEqual([off(r).status, off(r).kind], ['unverifiable', 'baseline-anchor-list-missing'])
  assert.match(off(r).message, /锚点清单/)
  // 对照：同样的库、带清单的锚点通过
  assert.equal(run(w.file).status, 0)
  // 即使库里什么都没变，缺清单也不放行；伪造的桥锚点在缺清单时同样无法被放过
  forgeBridge(w.db)
  const r2 = run(stripped)
  assert.deepEqual([r2.status, off(r2).kind], [1, 'baseline-anchor-list-missing'])
  w.db.close()
})
