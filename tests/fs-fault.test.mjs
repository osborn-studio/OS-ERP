/**
 * ============================================================================
 * 文件标识：tests/fs-fault.test.mjs ｜ AD6 掉电模拟：audit-archive / db-backup / 证据日志追加在每个故障注入点后的磁盘状态与恢复
 * 每个注入点 × {throw, abort(SIGABRT)}：子进程带 GML_TEST_FS_FAULT 跑脚本，断言崩后状态属于文档（audit-integrity.md "写入序列的故障注入"）
 * 登记的可恢复状态之一，且下一次正常运行 / `--resume` 能安全、幂等地接续。全部在系统临时目录；只终止本测试自己启动的子进程。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync, existsSync, statSync, truncateSync, renameSync, openSync, closeSync, fsyncSync, mkdirSync, linkSync, readSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { insertAuditRow } from '../server/lib/audit-trail.js'
import { verifyChain } from '../server/lib/audit-chain-verify.js'
import { FAULT_POINTS, faultPoint, assertFsFaultAllowed } from '../scripts/lib/fs-fault.mjs'
import { decryptFile, MAGIC } from '../server/lib/backup-crypto.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const ARCHIVE = 'scripts/audit-archive.mjs'
const BACKUP = 'scripts/db-backup.mjs'
const MODES = ['throw', 'abort']
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dir, GML_DB: '', GML_JWT_SECRET: 'a'.repeat(48), ...extra })
const run = (script, args, dir, extra = {}) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: envFor(dir, extra), encoding: 'utf8', timeout: 120000 })
const fault = (name, mode) => ({ GML_TEST_FS_FAULT: name, GML_TEST_FS_FAULT_MODE: mode })
function tmp(t, prefix = 'os-ad6-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
/** abort ⇒ SIGABRT 终止；throw ⇒ 正常的非零退出（不是信号） */
function assertDied(r, mode, what) {
  if (mode === 'abort') assert.equal(r.signal, 'SIGABRT', `${what}: process.abort() kills with SIGABRT (status ${r.status}) ${r.stderr}`)
  else { assert.equal(r.signal, null, what); assert.notEqual(r.status, 0, `${what}: injected throw ends non-zero`) }
}

// ---------------------------------------------------------------- 库本身
test('fs-fault: unset env is a no-op; outside test mode any setting is refused; unknown point / bad mode refused', () => {
  const all = Object.values(FAULT_POINTS).flat()
  assert.equal(all.length, 11)
  for (const p of all) faultPoint(p, { GML_RUNTIME_MODE: 'test' })
  assert.equal(assertFsFaultAllowed({}), null)
  for (const mode of [undefined, 'production', 'demo']) {
    const env = { GML_TEST_FS_FAULT: all[0], ...(mode ? { GML_RUNTIME_MODE: mode } : {}) }
    assert.throws(() => assertFsFaultAllowed(env), { code: 'FS_FAULT_FORBIDDEN' })
    assert.throws(() => faultPoint('log.after-lock', env), { code: 'FS_FAULT_FORBIDDEN' }, 'even a non-matching point refuses, so a stray variable cannot hide')
  }
  assert.throws(() => assertFsFaultAllowed({ GML_TEST_FS_FAULT_MODE: 'abort' }), { code: 'FS_FAULT_FORBIDDEN' }, 'the mode variable alone is also refused outside test')
  assert.throws(() => assertFsFaultAllowed({ GML_RUNTIME_MODE: 'test', GML_TEST_FS_FAULT: 'archive.typo' }), { code: 'FS_FAULT_UNKNOWN' })
  assert.throws(() => assertFsFaultAllowed({ GML_RUNTIME_MODE: 'test', GML_TEST_FS_FAULT: all[0], GML_TEST_FS_FAULT_MODE: 'explode' }), { code: 'FS_FAULT_MODE_INVALID' })
  assert.throws(() => faultPoint('not.registered', { GML_RUNTIME_MODE: 'test' }), { code: 'FS_FAULT_UNKNOWN' })
  const env = { GML_RUNTIME_MODE: 'test', GML_TEST_FS_FAULT: 'log.after-lock' }
  faultPoint('archive.before-delete', env) // 不是本点 ⇒ 空操作
  assert.throws(() => faultPoint('log.after-lock', env), { code: 'FS_FAULT_INJECTED' })
})

test('fs-fault: abort mode really aborts the process (SIGABRT, no finally blocks)', () => {
  const code = `import { faultPoint } from './scripts/lib/fs-fault.mjs'; try { faultPoint('log.after-lock') } finally { console.log('FINALLY-RAN') }`
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env: envFor(tmpdir(), fault('log.after-lock', 'abort')), encoding: 'utf8' })
  assert.equal(r.signal, 'SIGABRT')
  assert.doesNotMatch(r.stdout, /FINALLY-RAN/)
})

test('fs-fault: every script refuses the hook outside test mode before touching anything', (t) => {
  const dir = tmp(t)
  const prod = { GML_RUNTIME_MODE: 'production', GML_TEST_FS_FAULT: 'archive.before-delete' }
  const a = run(ARCHIVE, ['--data-dir', dir, '--before', '2025-01-01', '--out', path.join(dir, 'out')], dir, prod)
  assert.equal(a.status, 2); assert.match(a.stderr, /FS_FAULT_FORBIDDEN/)
  assert.ok(!existsSync(path.join(dir, 'out')))
  const b = run(BACKUP, [], dir, { GML_RUNTIME_MODE: 'production', GML_TEST_FS_FAULT: 'backup.after-db-copy' })
  assert.equal(b.status, 2); assert.match(b.stderr, /FS_FAULT_FORBIDDEN/)
  assert.ok(!existsSync(path.join(dir, 'backups')))
  const c = spawnSync(process.execPath, ['--input-type=module', '-e', `const {appendEntry}=await import('./scripts/lib/evidence-log.mjs'); try { appendEntry(${JSON.stringify(path.join(dir, 'L.jsonl'))}, {name:'RC-1.0.0-aaaaaaa', evidence:{}, sigText:null, builtBy:'local'}) } catch (e) { console.log(e.code); process.exit(3) }`],
    { cwd: ROOT, env: envFor(dir, { GML_RUNTIME_MODE: 'production', GML_TEST_FS_FAULT: 'log.after-lock' }), encoding: 'utf8' })
  assert.equal(c.status, 3); assert.match(c.stdout, /FS_FAULT_FORBIDDEN/)
  assert.ok(!existsSync(path.join(dir, 'L.jsonl')) && !existsSync(path.join(dir, 'L.jsonl.lock')), 'refused before the lock is taken')
})

// ---------------------------------------------------------------- audit-archive
const mig = () => createRequire(import.meta.url)(path.join(MIGRATIONS_DIR, '068_audit_hash_chain.cjs'))
function archiveFixture(t) {
  const dir = tmp(t)
  const out = tmp(t, 'os-ad6-out-')
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.pragma('journal_mode = WAL'); db.pragma('busy_timeout = 5000')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test' })
  db.transaction(() => { for (let i = 0; i < 60; i++) insertAuditRow(db, { userId: 1, userName: 'u', action: 'UPDATE', module: 'sales', entity: 'order', entityId: i, detail: { n: i }, ip: '127.0.0.1' }) })()
  db.transaction(() => { for (let id = 1; id <= 60; id++) db.prepare('UPDATE audit_logs SET created_at=?, row_hash=NULL, prev_hash=NULL WHERE id=?').run(id <= 40 ? '2024-01-15 10:00:00' : '2026-06-01 10:00:00', id) })()
  mig().up(db)
  assert.equal(verifyChain(db).ok, true)
  const A = (extra = [], env = {}) => run(ARCHIVE, ['--data-dir', dir, '--industry', 'cosmetic', '--before', '2025-01-01', '--out', out, ...extra], dir, env)
  const token = (extra = []) => A(extra).stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]
  t.after(() => { try { db.close() } catch { /* 已关 */ } })
  return { dir, out, db, A, token }
}
const count = (db, sql) => db.prepare(sql).get().n
/** 崩后库必须原样：事务未提交 ⇒ 全部行还在、无锚点、无归档审计、链完好 */
function assertDbUntouched(db, what) {
  assert.equal(count(db, 'SELECT COUNT(*) n FROM audit_logs'), 60, what)
  assert.equal(count(db, 'SELECT COUNT(*) n FROM audit_chain_anchors'), 0, what)
  assert.equal(count(db, "SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'"), 0, what)
  assert.equal(verifyChain(db).ok, true, what)
}
function assertArchived(db, what) {
  assert.equal(count(db, 'SELECT COUNT(*) n FROM audit_logs'), 21, what)
  assert.equal(count(db, "SELECT COUNT(*) n FROM audit_logs WHERE action='AUDIT_ARCHIVE'"), 1, what)
  assert.equal(count(db, "SELECT COUNT(*) n FROM audit_chain_anchors WHERE kind='archive'"), 1, what)
  assert.equal(verifyChain(db).ok, true, what)
}
const exportsOf = (out) => readdirSync(out).sort()

for (const point of FAULT_POINTS.archive) {
  for (const mode of MODES) {
    test(`audit-archive fault ${point} (${mode}): db untouched, on-disk state is a documented recoverable one, recovery is safe and idempotent`, { timeout: 180000 }, (t) => {
      const { out, db, A, token } = archiveFixture(t)
      const r = A(['--confirm', token()], fault(point, mode))
      assertDied(r, mode, point)
      assertDbUntouched(db, point) // SQLite 回滚未提交的删除 / 锚点
      const files = exportsOf(out)
      const incompleteExport = point === 'archive.after-export-write' || point === 'archive.after-export-fsync'
      if (mode === 'throw') {
        // 抛错路径自己清理：没有任何残留，下一次正常运行直接成功
        assert.deepEqual(files, [], 'throw mode removes everything it created')
        const ok = A(['--confirm', token()])
        assert.equal(ok.status, 0, ok.stdout + ok.stderr)
        assertArchived(db, 'rerun after throw')
      } else if (incompleteExport) {
        // 状态 A：只有 JSONL（无摘要）。--resume 与正常运行都拒绝；人工确认后删除残留再做新归档
        assert.deepEqual(files.map((f) => path.extname(f)), ['.jsonl'], 'orphan JSONL without digest')
        const res = A(['--resume'])
        assert.equal(res.status, 1); assert.match(res.stdout, /RESUME_INCOMPLETE/)
        const plain = A(['--confirm', 'ARCHIVE-0000000000000000'])
        assert.notEqual(plain.status, 0)
        assertDbUntouched(db, 'refusals change nothing')
        assert.equal(exportsOf(out).length, 1, 'refusals never delete the orphan themselves')
        for (const f of exportsOf(out)) rmSync(path.join(out, f))
        const ok = A(['--confirm', token()])
        assert.equal(ok.status, 0, ok.stdout + ok.stderr)
        assertArchived(db, 'fresh archive after manual orphan cleanup')
      } else {
        // 状态 B：JSONL + 摘要完整、库未动。--resume 续做，且不重写导出；再来一次是 already-archived
        assert.equal(files.length, 2)
        const before = files.map((f) => readFileSync(path.join(out, f)))
        const normal = A(['--confirm', token()])
        assert.equal(normal.status, 1); assert.match(normal.stdout, /OUT_EXISTS.*--resume/s)
        const dry = A(['--resume'])
        assert.equal(dry.status, 0, dry.stdout + dry.stderr)
        assertDbUntouched(db, 'resume dry-run')
        const done = A(['--resume', '--confirm', dry.stdout.match(/口令：(ARCHIVE-[0-9A-F]{16})/)[1]])
        assert.equal(done.status, 0, done.stdout + done.stderr)
        assertArchived(db, 'resume')
        assert.deepEqual(exportsOf(out), files)
        assert.deepEqual(files.map((f) => readFileSync(path.join(out, f))), before, 'resume does not rewrite the export')
      }
      // 幂等：再 --resume 不删、不重复写审计、退出 0
      const second = A(['--resume', '--confirm', 'ARCHIVE-0000000000000000'])
      assert.equal(second.status, 0, second.stdout + second.stderr)
      assert.match(second.stdout, /already-archived/)
      assertArchived(db, 'idempotent second resume')
    })
  }
}

// ---------------------------------------------------------------- db-backup
function backupFixture(t) {
  const dir = tmp(t)
  const init = spawnSync(process.execPath, ['--input-type=module', '-e', `const {initSchemaFor}=await import('./server/db/index.js');initSchemaFor('cosmetic')`], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(init.status, 0, init.stderr)
  const bdir = path.join(dir, 'backups')
  const B = (extra = [], env = {}) => run(BACKUP, ['cosmetic', ...extra], dir, env)
  const names = () => (existsSync(bdir) ? readdirSync(bdir).sort() : [])
  const dbs = () => names().filter((f) => /^gml_cosmetic_.*\.db$/.test(f))
  const reports = () => names().filter((f) => /^backup-report-.*\.json$/.test(f))
  return { dir, bdir, B, names, dbs, reports }
}
function assertGoodBackup(f, file, what) {
  const side = `${path.join(f.bdir, file)}.audit-manifest.json`
  assert.ok(existsSync(side), `${what}: manifest sidecar exists`)
  const chk = new Database(path.join(f.bdir, file), { readonly: true })
  try { assert.equal(chk.pragma('integrity_check', { simple: true }), 'ok', what) } finally { chk.close() }
}

for (const point of FAULT_POINTS.backup) {
  for (const mode of MODES) {
    test(`db-backup fault ${point} (${mode}): earlier backups intact, no unverified .db, next run completes`, { timeout: 180000 }, (t) => {
      const f = backupFixture(t)
      assert.equal(f.B(['--keep=5']).status, 0)
      const good = f.dbs()
      assert.equal(good.length, 1)
      const reportsBefore = f.reports()
      const r = f.B(['--keep=5'], fault(point, mode))
      assertDied(r, mode, point)
      assert.deepEqual(f.dbs().slice(0, 1), good.slice(0, 1), 'the earlier verified backup is untouched')
      if (mode === 'abort') assert.deepEqual(f.reports(), reportsBefore, 'no report is written by a run that died before the report')
      else assert.match(JSON.parse(readFileSync(path.join(f.bdir, f.reports().at(-1)), 'utf8')).results[0].status, point === 'backup.after-sidecar' ? /ok|failed/ : /failed/, 'handled failures are reported (same-second runs may overwrite the earlier report)')
      const names = f.names()
      const partials = names.filter((n) => n.endsWith('.partial'))
      const failedFiles = names.filter((n) => n.endsWith('.failed'))
      if (point === 'backup.after-db-copy') {
        // 快照还没验过：终名 .db 不得出现。abort ⇒ 留下 .partial；throw ⇒ 被隔离成 .db.failed（快照失败路径）
        assert.equal(f.dbs().length, 1, 'no unverified snapshot carries the final .db name')
        if (mode === 'abort') { assert.equal(partials.length, 1); assert.equal(failedFiles.length, 0) } else {
          assert.equal(partials.length, 0); assert.equal(failedFiles.length, 1)
          assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /BACKUP_SNAPSHOT_FAILED/)
        }
      } else if (point === 'backup.before-sidecar') {
        // abort ⇒ 已验证的 .db 没有清单（孤儿，可用但缺链清单）；throw ⇒ 清单失败路径删掉它
        if (mode === 'abort') {
          assert.equal(f.dbs().length, 2)
          const orphan = f.dbs().find((n) => !good.includes(n))
          assert.ok(!existsSync(`${path.join(f.bdir, orphan)}.audit-manifest.json`), 'verified snapshot without its manifest')
        } else {
          assert.equal(f.dbs().length, 1, 'MANIFEST_FAILED removes the half-finished backup')
          assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /BACKUP_MANIFEST_FAILED/)
        }
        assert.equal(partials.length + failedFiles.length, 0)
      } else {
        // after-sidecar：备份与清单都完整，只缺报告
        assert.equal(f.dbs().length, 2)
        assertGoodBackup(f, f.dbs().find((n) => !good.includes(n)), point)
      }
      // 下一次正常运行完成：退出 0、报告 ok、新备份有清单；残留的 .partial / .failed / 孤儿不影响
      const next = f.B(['--keep=5'])
      assert.equal(next.status, 0, next.stdout + next.stderr)
      const report = JSON.parse(readFileSync(path.join(f.bdir, f.reports().at(-1)), 'utf8'))
      const entry = report.results.find((x) => x.code === 'cosmetic')
      assert.equal(entry.status, 'ok')
      assertGoodBackup(f, path.basename(entry.file), 'next run')
      assert.equal(entry.sha256, require_sha(entry.file))
      // 幂等：再跑一次不出错
      assert.equal(f.B(['--keep=5']).status, 0)
    })
  }
}
const require_sha = (file) => createRequire(import.meta.url)('node:crypto').createHash('sha256').update(readFileSync(file)).digest('hex')

test('db-backup fault (encrypted, abort after db copy): the plaintext temp is 0600 and never carries a backup name; next run completes and leaves no new temp', { timeout: 180000 }, (t) => {
  const f = backupFixture(t)
  const key = { GML_BACKUP_KEY: 'k'.repeat(40) }
  const r = f.B([], { ...key, ...fault('backup.after-db-copy', 'abort') })
  assert.equal(r.signal, 'SIGABRT')
  const tmps = f.names().filter((n) => n.endsWith('.plain.tmp'))
  assert.equal(tmps.length, 1, 'abort cannot run the exit-time shredder: the temp stays (documented; the operator shreds it)')
  assert.equal(statSync(path.join(f.bdir, tmps[0])).mode & 0o777, 0o600)
  assert.equal(f.names().filter((n) => n.endsWith('.db.enc')).length, 0)
  const ok = f.B([], key)
  assert.equal(ok.status, 0, ok.stdout + ok.stderr)
  assert.equal(f.names().filter((n) => n.endsWith('.db.enc')).length, 1)
  assert.equal(f.names().filter((n) => n.endsWith('.plain.tmp')).length, 1, 'only the stale one from the aborted run remains')
  // throw 模式走正常失败路径：exit 处理器擦除明文
  const f2 = backupFixture(t)
  const th = f2.B([], { ...key, ...fault('backup.after-db-copy', 'throw') })
  assert.equal(th.status, 1)
  assert.equal(f2.names().filter((n) => n.endsWith('.plain.tmp') || n.endsWith('.failed')).length, 0, 'encrypted mode never leaves plaintext after a handled failure')
})

// ---------------------------------------------------------------- db-backup 加密模式 × 每个注入点（AE6）
// 口径：任何注入点之后，备份目录里除“abort 于 after-db-copy 留下的 0600 .plain.tmp”外，不得有任何明文 SQLite 文件；
// .db.enc / .audit-manifest.enc 必须能用当前密钥解开（认证通过），明文清单 .audit-manifest.json 只含哈希元数据。
const KEY = { GML_BACKUP_KEY: 'k'.repeat(40) }
const KEY_BYTES = Buffer.from(KEY.GML_BACKUP_KEY, 'utf8')
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0')
const head = (file, n = 16) => { const fd = openSync(file, 'r'); try { const b = Buffer.alloc(n); return b.subarray(0, readSync(fd, b, 0, n, 0)) } finally { closeSync(fd) } }
const isPlainSqlite = (file) => head(file).equals(SQLITE_MAGIC)
/** 备份目录里所有明文 SQLite 文件（含点文件、.failed、.partial、.tmp） */
const plaintextSnapshots = (f) => f.names().filter((n) => statSync(path.join(f.bdir, n)).isFile() && isPlainSqlite(path.join(f.bdir, n)))
function decryptTo(t, file) {
  const out = path.join(tmp(t, 'os-ae6-dec-'), 'out')
  decryptFile(file, out, KEY_BYTES)
  return out
}

for (const point of FAULT_POINTS.backup) {
  for (const mode of MODES) {
    test(`db-backup fault ${point} (${mode}, encrypted): no plaintext survives except the documented abort temp; .enc/manifest states are recoverable; next run completes`, { timeout: 180000 }, (t) => {
      const f = backupFixture(t)
      assert.equal(f.B(['--keep=5'], KEY).status, 0)
      const good = f.names().filter((n) => n.endsWith('.db.enc'))
      assert.equal(good.length, 1)
      assert.deepEqual(plaintextSnapshots(f), [], 'baseline: encrypted mode leaves no plaintext')
      const r = f.B(['--keep=5'], { ...KEY, ...fault(point, mode) })
      assertDied(r, mode, point)
      assert.ok(f.names().includes(good[0]), 'the earlier encrypted backup is untouched')
      decryptFile(path.join(f.bdir, good[0]), null, KEY_BYTES)
      const names = f.names()
      const encs = names.filter((n) => n.endsWith('.db.enc') && !good.includes(n))
      const tmps = names.filter((n) => n.endsWith('.plain.tmp'))
      const plain = plaintextSnapshots(f)
      assert.equal(names.filter((n) => n.endsWith('.db') || n.endsWith('.partial') || n.endsWith('.failed')).length, 0, 'encrypted mode never writes a plaintext-named backup, partial or quarantine file')
      if (point === 'backup.after-db-copy') {
        assert.equal(encs.length, 0, 'no ciphertext yet')
        if (mode === 'abort') {
          // 断电最接近的情形：明文临时文件还在，这是文档登记的唯一明文窗口；必须是 0600 且是唯一的明文文件
          assert.equal(tmps.length, 1); assert.deepEqual(plain, tmps)
          assert.equal(statSync(path.join(f.bdir, tmps[0])).mode & 0o777, 0o600)
        } else {
          assert.equal(tmps.length, 0, 'handled failure shreds the plaintext'); assert.deepEqual(plain, [])
          assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /BACKUP_SNAPSHOT_FAILED/)
        }
      } else {
        // 密文已落盘并已擦除明文：任何模式下都不应有明文临时文件或明文快照
        assert.equal(tmps.length, 0, 'plaintext temp already shredded before the sidecar step'); assert.deepEqual(plain, [])
        const sidecars = names.filter((n) => n.includes('.audit-manifest.'))
        if (point === 'backup.before-sidecar') {
          if (mode === 'abort') {
            assert.equal(encs.length, 1, 'verified ciphertext without manifests (usable, chain manifest missing)')
            assert.equal(sidecars.filter((n) => n.startsWith(encs[0])).length, 0)
            const dec = decryptTo(t, path.join(f.bdir, encs[0]))
            const chk = new Database(dec, { readonly: true })
            try { assert.equal(chk.pragma('integrity_check', { simple: true }), 'ok') } finally { chk.close() }
          } else {
            assert.equal(encs.length, 0, 'MANIFEST_FAILED removes the half-finished ciphertext')
            assert.equal(r.status, 1); assert.match(r.stdout + r.stderr, /BACKUP_MANIFEST_FAILED/)
          }
        } else {
          assert.equal(encs.length, 1)
          const mj = path.join(f.bdir, `${encs[0]}.audit-manifest.json`); const me = path.join(f.bdir, `${encs[0]}.audit-manifest.enc`)
          assert.ok(existsSync(mj) && existsSync(me), 'both manifests are complete')
          assert.ok(!isPlainSqlite(mj) && head(me, 4).equals(MAGIC), 'json manifest is metadata, enc manifest is ciphertext')
          assert.equal(readFileSync(decryptTo(t, me), 'utf8'), readFileSync(mj, 'utf8'), 'the authenticated manifest equals the plain one')
          assert.equal(statSync(mj).mode & 0o777, 0o600)
          decryptFile(path.join(f.bdir, encs[0]), null, KEY_BYTES)
        }
      }
      // 下一次正常运行：退出 0、新密文可解、清单齐全；abort 遗留的明文临时文件仍在（运维擦除），本次不新增任何明文
      const staleTmps = tmps.length
      const next = f.B(['--keep=5'], KEY)
      assert.equal(next.status, 0, next.stdout + next.stderr)
      const entry = JSON.parse(readFileSync(path.join(f.bdir, f.reports().at(-1)), 'utf8')).results.find((x) => x.code === 'cosmetic')
      assert.equal(entry.status, 'ok'); assert.equal(entry.encrypted, true)
      decryptFile(entry.file, null, KEY_BYTES)
      assert.ok(existsSync(`${entry.file}.audit-manifest.json`) && existsSync(`${entry.file}.audit-manifest.enc`))
      assert.equal(f.names().filter((n) => n.endsWith('.plain.tmp')).length, staleTmps, 'a normal run adds no plaintext temp')
      assert.equal(plaintextSnapshots(f).length, staleTmps)
    })
  }
}

// ---------------------------------------------------------------- 平台差异（macOS / Linux）
// 脚本依赖的文件系统原语：同目录 rename 覆盖已有文件、目录 fsync、rename 到目录上的错误码、大小写折叠。
// 这些断言按 process.platform 分支：两平台共同保证的部分严格断言，已知差异按平台断言，未知平台只跑共同部分。
test('platform: rename over an existing file replaces it atomically for readers on both macOS and Linux (partial → final, report overwrite)', (t) => {
  const dir = tmp(t, 'os-ae6-plat-')
  const a = path.join(dir, 'a'); const b = path.join(dir, 'b')
  writeFileSync(a, 'new'); writeFileSync(b, 'old')
  const fd = openSync(b, 'r') // 持有旧 inode 的读者
  try {
    renameSync(a, b)
    assert.equal(readFileSync(b, 'utf8'), 'new', 'the destination name now resolves to the new content')
    assert.ok(!existsSync(a), 'the source name is gone')
    const buf = Buffer.alloc(3)
    assert.equal(readSync(fd, buf, 0, 3, 0), 3)
    assert.equal(buf.toString(), 'old', 'an already-open reader keeps the old inode (POSIX), no torn read')
  } finally { closeSync(fd) }
  assert.deepEqual(readdirSync(dir), ['b'], 'no stray temp left behind')
})

test('platform: rename of a file onto a directory (or a directory onto a non-empty one) is refused, never merged', (t) => {
  const dir = tmp(t, 'os-ae6-plat-')
  mkdirSync(path.join(dir, 'd')); writeFileSync(path.join(dir, 'd', 'x'), '1'); writeFileSync(path.join(dir, 'f'), '2')
  mkdirSync(path.join(dir, 'e')); writeFileSync(path.join(dir, 'e', 'y'), '3')
  // 文件 → 已存在的目录：Linux 与 macOS 都是 EISDIR
  assert.throws(() => renameSync(path.join(dir, 'f'), path.join(dir, 'd')), (e) => e.code === 'EISDIR', 'file over directory: EISDIR on Linux and macOS')
  // 目录 → 非空目录：POSIX 允许 ENOTEMPTY 或 EEXIST（Linux 与 macOS 常见为 ENOTEMPTY）；关键是被拒绝且不合并
  assert.throws(() => renameSync(path.join(dir, 'e'), path.join(dir, 'd')), (e) => ['ENOTEMPTY', 'EEXIST'].includes(e.code), 'directory over non-empty directory is refused')
  assert.equal(readFileSync(path.join(dir, 'd', 'x'), 'utf8'), '1'); assert.equal(readFileSync(path.join(dir, 'f'), 'utf8'), '2')
})

test('platform: directory fsync (the db-backup rename durability step) succeeds read-only on both; opening a directory for writing never does', (t) => {
  const dir = tmp(t, 'os-ae6-plat-')
  writeFileSync(path.join(dir, 'x'), '1')
  const dfd = openSync(dir, 'r')
  try { fsyncSync(dfd) } finally { closeSync(dfd) } // db-backup 的做法：只读打开目录再 fsync
  assert.throws(() => openSync(dir, 'r+'), (e) => e.code === 'EISDIR', 'a directory cannot be opened for writing')
  // 语义差异（只能文档化、不可在此断言）：macOS 的 fsync 只保证到达磁盘缓存，不保证落盘（需 F_FULLFSYNC，Node 不暴露）；
  // Linux 的目录 fsync 持久化目录项。两者对 abort（进程死、内核存活）模拟的结论相同。
})

test('platform: case sensitivity differs (APFS default folds case, Linux does not) and the backup/report names never depend on it', (t) => {
  const dir = tmp(t, 'os-ae6-plat-')
  writeFileSync(path.join(dir, 'Probe.tmp'), 'x')
  const folds = existsSync(path.join(dir, 'probe.tmp'))
  if (process.platform === 'linux') assert.equal(folds, false, 'Linux filesystems used by CI are case-sensitive')
  else if (process.platform === 'darwin') assert.equal(typeof folds, 'boolean', 'APFS is case-insensitive by default but may be formatted case-sensitive')
  // 备份文件名全部由小写库名 + 数字时间戳 + 固定后缀构成：同名冲突检测（existsSync）在两种文件系统上结论一致
  const f = ['gml_cosmetic_20261024-010203.db', 'gml_cosmetic_20261024-010203_1.db.enc', 'backup-report-20261024-010203.json']
  for (const n of f) assert.equal(n, n.toLowerCase())
})

test('platform: hard-linking over an existing name is refused (EEXIST) on both, so the wx sidecar write cannot clobber a stale manifest', (t) => {
  const dir = tmp(t, 'os-ae6-plat-')
  writeFileSync(path.join(dir, 'a'), '1'); writeFileSync(path.join(dir, 'b'), '2')
  assert.throws(() => linkSync(path.join(dir, 'a'), path.join(dir, 'b')), (e) => e.code === 'EEXIST')
  assert.throws(() => writeFileSync(path.join(dir, 'b'), 'z', { flag: 'wx' }), (e) => e.code === 'EEXIST', 'flag wx (used for the manifest sidecars) refuses to overwrite')
})

// ---------------------------------------------------------------- 证据日志追加
const logUrl = pathToFileURL(path.join(ROOT, 'scripts/lib/evidence-log.mjs')).href
const APPEND = (file, n, env = {}) => spawnSync(process.execPath, ['--input-type=module', '-e', `
const { appendEntry } = await import(${JSON.stringify(logUrl)})
try {
  const e = appendEntry(${JSON.stringify(file)}, { name: 'RC-1.0.0-' + String(${n}).padStart(7, '0'), evidence: { n: ${n} }, sigText: null, builtBy: 'local', timestamp: '2026-10-24T00:00:0${n}.000Z' })
  console.log('APPENDED ' + e.name)
} catch (e) { console.error('ERR ' + (e.code || '') + (e.committed ? ' committed' : '') + ' ' + e.message); process.exit(4) }`],
{ cwd: ROOT, env: envFor(path.dirname(file), env), encoding: 'utf8', timeout: 60000 })

for (const point of FAULT_POINTS.log) {
  for (const mode of MODES) {
    test(`evidence-log append fault ${point} (${mode}): log is a valid chain or recoverable, lock semantics documented, retry is safe`, async (t) => {
      const { verifyLog, readLog } = await import(logUrl)
      const dir = tmp(t)
      const file = path.join(dir, 'L.jsonl')
      assert.equal(APPEND(file, 1).status, 0)
      const base = readFileSync(file, 'utf8')
      const r = APPEND(file, 2, fault(point, mode))
      assertDied(r, mode, point)
      if (mode === 'throw') assert.equal(/committed/.test(r.stderr), point === 'log.after-fsync-before-unlock', 'only a post-fsync error is flagged committed')
      const text = readFileSync(file, 'utf8')
      assert.equal(verifyLog(text).ok, true, `${point}: the log is still a valid chain`)
      const lock = `${file}.lock`
      const entries = verifyLog(text).entries.map((e) => e.name)
      if (mode === 'throw') {
        assert.ok(!existsSync(lock), 'finally releases the lock')
        if (point === 'log.after-fsync-before-unlock') assert.equal(entries.length, 2, 'the line was durable before the fault: it counts')
        else assert.equal(text, base, 'failure before durability leaves the log exactly as it was (a written line is truncated back)')
      } else {
        assert.ok(existsSync(lock), 'abort leaves the lock behind')
        assert.equal(entries.length, point === 'log.after-lock' ? 1 : 2, 'written bytes survive a process abort (page cache)')
        // 持锁状态：新的追加拒绝，不抢锁、不改日志
        const blocked = APPEND(file, 3)
        assert.equal(blocked.status, 4); assert.match(blocked.stderr, /lock/)
        assert.equal(readFileSync(file, 'utf8'), text)
        rmSync(lock) // 运维确认没有进程在追加之后手工清除
      }
      // 下一次正常追加：链仍有效，名字唯一
      const had2 = readLog(file).entries.some((e) => e.name === 'RC-1.0.0-0000002')
      const retry = APPEND(file, 2)
      if (had2) { assert.equal(retry.status, 4); assert.match(retry.stderr, /already in the evidence log/) } else assert.equal(retry.status, 0, retry.stderr)
      const next = APPEND(file, 3)
      assert.equal(next.status, 0, next.stderr)
      const final = readLog(file)
      assert.equal(final.ok, true, final.reason)
      assert.deepEqual(final.entries.map((e) => e.name), ['RC-1.0.0-0000001', 'RC-1.0.0-0000002', 'RC-1.0.0-0000003'])
    })
  }
}

test('evidence-log: a torn tail (power loss between write and fsync) is rejected, never extended or repaired; restoring the committed file recovers', async (t) => {
  const { readLog } = await import(logUrl)
  const dir = tmp(t)
  const file = path.join(dir, 'L.jsonl')
  assert.equal(APPEND(file, 1).status, 0)
  const committed = readFileSync(file, 'utf8')
  assert.equal(APPEND(file, 2).status, 0)
  truncateSync(file, committed.length + 20) // 第二行只落了一半
  assert.equal(readLog(file).ok, false)
  const refused = APPEND(file, 3)
  assert.equal(refused.status, 4); assert.match(refused.stderr, /invalid/)
  assert.equal(statSync(file).size, committed.length + 20, 'a broken log is left untouched')
  writeFileSync(file, committed) // 等价于 git checkout 已提交的版本
  assert.equal(APPEND(file, 2).status, 0)
  assert.equal(readLog(file).ok, true)
})
