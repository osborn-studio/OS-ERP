/**
 * ============================================================================
 * 文件标识：tests/upgrade-rehearsal.test.mjs ｜ 测试：迁移升级演练（AA11）——逐迁移耗时/写锁探针、基线截断不绕过校验和、注入必败迁移走回退、拒绝清单
 * ============================================================================
 * 【职责】真实子进程跑 scripts/upgrade-rehearsal.mjs（小夹具：生产迁移库 + db-backup 备份集；合成库用 synth-data 最小规模）：
 *   · 从 `--from=58` 重放 059–062：每步 status=ok、有 duration_ms/net_ms/lock，建索引类迁移 `structure_preexisting=false`，
 *     版本表覆盖全部迁移且校验和无空值，源备份 sha256 不变，夹具里的哨兵数据保留；
 *   · 注入必败迁移（--extra-migrations-dir）⇒ 退出码 1、报告记录失败步骤、回退（进程内 + ADR-0016 回退演练）通过、工作副本退回升级前版本表；
 *   · 校验和保护没被绕过：备份里被篡改的已登记校验和（编号 ≤ 基线 与 > 基线 各一例）⇒ PRE_UPGRADE_CHECKSUM_MISMATCH、不升级；
 *   · 拒绝：相对路径、非空目标、目标 = 备份来源 data_dir / 调用方 GML_DATA_DIR / 仓库 data/、--from 高于库内真实版本或超过最高编号、
 *     非合成 --synth-dir、未知参数、两个输入同时给、非法追加迁移 ⇒ 退出码 2 且不创建任何文件；
 *   · 写锁探针：持有写事务的连接能被量到阻塞窗口，无锁时为 0。
 * 【改它要注意什么】每个目录都是 mkdtemp 的新目录，用后删除；子进程环境白名单。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import Database from 'better-sqlite3'
import { startLockProbe } from '../scripts/lib/lock-probe.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCRIPT = 'scripts/upgrade-rehearsal.mjs'
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const envFor = (dir, extra = {}) => ({ PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', ...extra })
const REPO_MIGRATIONS = readdirSync(path.join(ROOT, 'server/db/migrations')).filter((f) => /^\d{3}_.*\.cjs$/.test(f)).sort().map((f) => f.replace(/\.cjs$/, ''))
const REPLAY = REPO_MIGRATIONS.filter((id) => Number(id.slice(0, 3)) > 58)

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 生产迁移库（真实 production boot）+ 哨兵表 + db-backup 备份集；mutate(db) 在备份前改库（用来造"版本表被篡改/缺行"的备份）。 */
function fixture(t, mutate = null) {
  const dir = tempDir(t, 'os-egp-rehearsal-src-')
  const boot = spawnSync(process.execPath, ['--input-type=module', '-e', "const {bootAll}=await import('./server/db/production-boot.js');bootAll()"], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 120000 })
  assert.equal(boot.status, 0, boot.stderr)
  const db = new Database(path.join(dir, 'gml_cosmetic.db'))
  db.exec("CREATE TABLE keep_customer_data (value TEXT); INSERT INTO keep_customer_data VALUES ('retain-me')")
  if (mutate) mutate(db)
  db.close()
  const backup = spawnSync(process.execPath, ['scripts/db-backup.mjs', 'cosmetic'], { cwd: ROOT, env: envFor(dir), encoding: 'utf8', timeout: 60000 })
  assert.equal(backup.status, 0, backup.stderr + backup.stdout)
  const backupDir = path.join(dir, 'backups')
  const file = readdirSync(backupDir).filter((f) => f.endsWith('.db'))[0]
  return { dir, backupDir, backupFile: path.join(backupDir, file) }
}

function rehearse(t, fx, { target = path.join(tempDir(t, 'os-egp-rehearsal-t-'), 'run'), args = ['--from=58'], env = {}, input = true } = {}) {
  const base = input && fx ? [`--backup-dir=${fx.backupDir}`] : []
  const r = spawnSync(process.execPath, [SCRIPT, ...base, `--target-dir=${target}`, ...args], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), ...env }, encoding: 'utf8', timeout: 300000 })
  return { ...r, target }
}
const readReport = (dir) => JSON.parse(readFileSync(path.join(dir, readdirSync(dir).find((f) => /^upgrade-rehearsal-.*\.json$/.test(f))), 'utf8'))

test('replays 059+ one by one on an isolated copy: per-migration timing, lock probe, checksums intact, source untouched', { timeout: 300000 }, (t) => {
  const fx = fixture(t)
  const before = sha256(fx.backupFile)
  const r = rehearse(t, fx)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const rep = readReport(r.target)
  assert.equal(rep.passed, true)
  assert.deepEqual(rep.failures, [])
  assert.equal(rep.rollback, null, 'no rollback on success')
  assert.deepEqual(rep.warnings, [])
  assert.deepEqual(rep.baseline.replay, REPLAY)
  const db0 = rep.databases[0]
  assert.equal(db0.passed, true)
  assert.deepEqual(db0.steps.map((s) => s.id), REPLAY)
  for (const s of db0.steps) {
    assert.equal(s.status, 'ok', s.id)
    assert.deepEqual(s.applied, [s.id])
    assert.equal(typeof s.duration_ms, 'number')
    assert.equal(typeof s.overhead_ms, 'number')
    assert.ok(s.net_ms >= 0 && s.net_ms <= s.duration_ms)
    assert.equal(typeof s.lock.max_blocked_ms, 'number')
    assert.equal(s.lock.other_errors, 0, JSON.stringify(s.lock))
  }
  // 059 / 061 create indexes: they were dropped from the copy first, so the replay really builds them.
  assert.ok(db0.indexes_dropped.length > 0)
  assert.ok(db0.indexes_dropped.some((n) => n === 'idx_poi_order'))
  for (const id of REPLAY.filter((x) => x.startsWith('059') || x.startsWith('061'))) {
    assert.equal(db0.steps.find((s) => s.id === id).structure_preexisting, false, id)
  }
  // The registry rows that were truncated recorded the same checksums as today's files (nothing hidden by truncation).
  assert.equal(db0.baseline_registry.truncation, 'applied', 'a latest-structure database still takes the truncation path')
  assert.ok(db0.baseline_registry.max > 58)
  assert.deepEqual(db0.registry_truncated.map((x) => x.id), REPLAY)
  assert.ok(db0.registry_truncated.every((x) => x.matches_current_file))
  for (const name of ['all_steps_applied', 'checksums_verified', 'repo_files_match_registry', 'production_rerun_is_noop', 'registry_covers_all_migrations', 'replayed_rows_recorded_as_applied', 'integrity_ok', 'foreign_keys_not_worse', 'probes_retained', 'seed_invariants_not_regressed']) {
    const inv = db0.invariants.find((i) => i.name === name)
    assert.ok(inv, name)
    assert.equal(inv.passed, true, JSON.stringify(inv))
  }
  assert.equal(sha256(fx.backupFile), before, 'the source backup is never modified')
  const work = new Database(path.join(r.target, 'work/gml_cosmetic.db'), { readonly: true })
  assert.equal(work.prepare('SELECT value FROM keep_customer_data').get().value, 'retain-me')
  const reg = work.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()
  assert.deepEqual(reg.map((x) => x.id), REPO_MIGRATIONS)
  assert.ok(reg.every((x) => x.checksum))
  assert.ok(work.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='idx_poi_order'").get(), 'index rebuilt by the replayed migration 059')
  work.close()
  assert.doesNotMatch(JSON.stringify(rep), /password|bearer|jwt_secret/i)
  assert.ok(!existsSync(path.join(r.target, 'stage')), 'staging directory removed')
  assert.match(r.stdout, /升级演练通过/)
})

test('an injected failing migration fails the rehearsal, exercises rollback (in-process + ADR-0016 drill) and leaves the previous version restorable', { timeout: 420000 }, (t) => {
  const fx = fixture(t)
  const extra = tempDir(t, 'os-egp-rehearsal-extra-')
  writeFileSync(path.join(extra, '900_rehearsal_failing.cjs'), `module.exports = { name: 'rehearsal failing', up(db) { db.exec('CREATE TABLE rehearsal_partial (id INTEGER)'); db.prepare('INSERT INTO rehearsal_partial VALUES (1)').run(); throw new Error('REHEARSAL_INJECTED_FAILURE') } }\n`)
  const before = sha256(fx.backupFile)
  const r = rehearse(t, fx, { args: ['--from=58', `--extra-migrations-dir=${extra}`] })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const rep = readReport(r.target)
  assert.equal(rep.passed, false)
  assert.ok(rep.databases[0], JSON.stringify(rep.failures) + r.stdout)
  const steps = rep.databases[0].steps
  assert.deepEqual(steps.map((s) => s.id), [...REPLAY, '900_rehearsal_failing'])
  assert.equal(steps.at(-1).status, 'failed')
  assert.match(steps.at(-1).error, /REHEARSAL_INJECTED_FAILURE/)
  assert.ok(steps.slice(0, -1).every((s) => s.status === 'ok'))
  assert.ok(rep.failures.some((f) => /900_rehearsal_failing/.test(f)))
  // Rollback was really exercised.
  assert.ok(rep.rollback, 'rollback section present')
  assert.equal(rep.rollback.in_process.passed, true, JSON.stringify(rep.rollback.in_process))
  for (const name of ['rollback_sha256_verified', 'rollback_registry_restored[cosmetic]', 'rollback_integrity_ok[cosmetic]', 'rollback_probes_retained[cosmetic]']) {
    assert.ok(rep.rollback.in_process.checks.some((c) => c.name === name && c.passed), name)
  }
  assert.equal(rep.rollback.drill.exit_code, 0, JSON.stringify(rep.rollback.drill))
  assert.equal(rep.rollback.drill.report_passed, true)
  assert.match(rep.rollback.drill.invariants, /^(\d+)\/\1$/)
  assert.equal(rep.rollback.ok, true)
  // The working copy is back at the pre-upgrade version: no partial table, no 900 row, every original row present, sentinel intact.
  const work = new Database(path.join(r.target, 'work/gml_cosmetic.db'), { readonly: true })
  assert.equal(work.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='rehearsal_partial'").get().n, 0)
  assert.equal(work.prepare("SELECT count(*) AS n FROM schema_migrations WHERE id LIKE '900_%'").get().n, 0)
  assert.deepEqual(work.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((x) => x.id), REPO_MIGRATIONS)
  assert.equal(work.prepare('SELECT value FROM keep_customer_data').get().value, 'retain-me')
  work.close()
  assert.equal(sha256(fx.backupFile), before)
  assert.ok(!existsSync(path.join(ROOT, 'server/db/migrations/900_rehearsal_failing.cjs')), 'injected migration never lands in the repo')
})

test('checksum protection is not bypassed: a tampered registry checksum fails before any write, for rows below and above the baseline', { timeout: 420000 }, (t) => {
  for (const [label, id] of [['below baseline', REPO_MIGRATIONS.find((x) => x.startsWith('001'))], ['above baseline (row the truncation would delete)', REPLAY[0]]]) {
    const fx = fixture(t, (db) => db.prepare("UPDATE schema_migrations SET checksum='00deadbeef' WHERE id=?").run(id))
    const r = rehearse(t, fx)
    assert.equal(r.status, 1, `${label}: ${r.stdout}${r.stderr}`)
    const rep = readReport(r.target)
    assert.equal(rep.passed, false)
    assert.ok(rep.failures.some((f) => /PRE_UPGRADE_CHECKSUM_MISMATCH/.test(f) && f.includes(id)), `${label}: ${JSON.stringify(rep.failures)}`)
    assert.deepEqual(rep.databases[0].steps, [], `${label}: no migration was attempted`)
    assert.equal(rep.rollback.in_process.passed, true)
  }
})

test('refusals exit 2 and create nothing', { timeout: 300000 }, (t) => {
  const fx = fixture(t)
  const parent = tempDir(t, 'os-egp-rehearsal-ref-')
  const refuse = (name, { target = path.join(parent, name), args = ['--from=58'], input = true, env = {}, pattern }) => {
    const r = rehearse(t, fx, { target, args, input, env })
    assert.equal(r.status, 2, `${name}: ${r.stdout}${r.stderr}`)
    assert.match(r.stderr, pattern, name)
    if (target.startsWith(parent)) assert.equal(existsSync(target), false, `${name}: target must not be created`)
    return r
  }
  refuse('relative', { target: 'relative/run', pattern: /绝对路径/ })
  refuse('unknown-flag', { args: ['--from=58', '--no-such-flag'], pattern: /DRILL_USAGE/ })
  refuse('missing-from', { args: [], pattern: /--from/ })
  refuse('bad-from', { args: ['--from=abc'], pattern: /--from/ })
  refuse('no-input', { input: false, pattern: /二选一/ })
  refuse('both-inputs', { args: ['--from=58', `--synth-dir=${fx.dir}`], pattern: /二选一/ })
  const maxMigration = Number(REPO_MIGRATIONS[REPO_MIGRATIONS.length - 1].slice(0, 3))
  refuse('above-max', { args: [`--from=${maxMigration}`], pattern: /REHEARSAL_NOTHING_TO_APPLY/ })
  refuse('way-above-max', { args: ['--from=999'], pattern: /REHEARSAL_NOTHING_TO_APPLY/ })
  refuse('repo-data', { target: path.join(ROOT, 'data', 'rehearsal-never-created'), pattern: /DRILL_TARGET_IS_LIVE/ })
  assert.equal(existsSync(path.join(ROOT, 'data', 'rehearsal-never-created')), false)
  // target = the backup's source data_dir, = the caller's GML_DATA_DIR, non-empty
  refuse('source-data-dir', { target: fx.dir, pattern: /DRILL_TARGET_IS_LIVE/ })
  const live = tempDir(t, 'os-egp-rehearsal-live-')
  refuse('caller-data-dir', { target: live, env: { GML_DATA_DIR: live }, pattern: /DRILL_TARGET_IS_LIVE/ })
  writeFileSync(path.join(live, 'keep.txt'), 'x')
  refuse('non-empty', { target: live, pattern: /DRILL_TARGET_NOT_EMPTY/ })
  assert.deepEqual(readdirSync(live), ['keep.txt'])
  // the synth input only accepts synth-data databases
  const realLike = tempDir(t, 'os-egp-rehearsal-reallike-')
  copyFileSync(fx.backupFile, path.join(realLike, 'gml_cosmetic.db'))
  refuse('not-synthetic', { input: false, args: ['--from=58', `--synth-dir=${realLike}`], pattern: /REHEARSAL_SOURCE_NOT_SYNTHETIC/ })
  refuse('multi-industry-dir', { input: false, args: ['--from=58', `--synth-dir=${fx.dir}`], pattern: /REHEARSAL_SYNTH_MULTI_INDUSTRY/ })
  refuse('synth-is-caller-data-dir', { input: false, args: ['--from=58', `--synth-dir=${fx.dir}`], env: { GML_DATA_DIR: fx.dir }, pattern: /REHEARSAL_SOURCE_IS_LIVE/ })
  // injected migrations must be numbered above the repo's and live outside it
  const bad = tempDir(t, 'os-egp-rehearsal-badextra-')
  writeFileSync(path.join(bad, '050_too_low.cjs'), 'module.exports = { up() {} }\n')
  refuse('extra-too-low', { args: ['--from=58', `--extra-migrations-dir=${bad}`], pattern: /REHEARSAL_EXTRA_INVALID/ })
  refuse('extra-in-repo', { args: ['--from=58', `--extra-migrations-dir=${path.join(ROOT, 'server/db/migrations')}`], pattern: /REHEARSAL_EXTRA_INVALID/ })
})

test('a baseline above the highest version the backup actually has is refused (the copy cannot claim that baseline)', { timeout: 120000 }, (t) => {
  const fx = fixture(t, (db) => db.prepare("DELETE FROM schema_migrations WHERE id LIKE '058_%'").run())
  const target = path.join(tempDir(t, 'os-egp-rehearsal-t-'), 'run')
  const r = rehearse(t, fx, { target })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /REHEARSAL_BASELINE_NOT_APPLIED/)
  assert.match(r.stderr, /058_/)
  assert.equal(existsSync(target), false)
})

test('synthetic database directory: copied, backed up, restored and rehearsed through the same path', { timeout: 420000 }, (t) => {
  const synth = path.join(tempDir(t, 'os-egp-rehearsal-synth-'), 'data')
  const gen = spawnSync(process.execPath, ['scripts/synth-data.mjs', '--skus', '24', '--txns', '240', '--docs', '60', '--quiet'], {
    cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), GML_RUNTIME_MODE: 'production', GML_DATA_DIR: synth, GML_DB: '', GML_SYNTH_ADMIN_PASSWORD: 'Synthetic-Pass-0123456789' }
  })
  assert.equal(gen.status, 0, gen.stderr + gen.stdout)
  const sourceBefore = sha256(path.join(synth, 'gml_cosmetic.db'))
  const filesBefore = readdirSync(synth).sort()
  const r = rehearse(t, null, { args: ['--from=58', `--synth-dir=${synth}`], input: false })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const rep = readReport(r.target)
  assert.equal(rep.passed, true)
  assert.equal(rep.input.mode, 'synth-dir')
  assert.deepEqual(rep.warnings, [], 'no baseline migration was self-healed by the preparation of the copy')
  assert.ok(rep.input.synth_backup.stamp)
  assert.deepEqual(rep.databases[0].steps.map((s) => s.id), REPLAY)
  assert.equal(rep.databases[0].pre.seed_checks_available, true)
  assert.ok(rep.databases[0].invariants.some((i) => i.name === 'seed_invariants_not_regressed' && i.passed))
  assert.equal(sha256(path.join(synth, 'gml_cosmetic.db')), sourceBefore, 'the synthetic source directory is never modified')
  assert.deepEqual(readdirSync(synth).sort(), filesBefore, 'the rehearsal does not even open the source directory with SQLite (no -shm/-wal side files appear)')
})

test('a migration whose verify() disagrees with its up() is not silently healed by the follow-up check', { timeout: 420000 }, (t) => {
  const fx = fixture(t)
  const extra = tempDir(t, 'os-egp-rehearsal-extra-')
  writeFileSync(path.join(extra, '900_rehearsal_inconsistent.cjs'), `module.exports = { name: 'inconsistent', up(db) { db.exec('CREATE TABLE IF NOT EXISTS rehearsal_x (i INTEGER)') }, verify() { return false } }\n`)
  const r = rehearse(t, fx, { args: ['--from=58', `--extra-migrations-dir=${extra}`] })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const rep = readReport(r.target)
  assert.equal(rep.passed, false)
  assert.ok(rep.failures.some((f) => /no_self_heal_after_apply/.test(f) && /900_rehearsal_inconsistent/.test(f)), JSON.stringify(rep.failures))
  assert.equal(rep.rollback.in_process.passed, true)
  assert.equal(rep.rollback.drill.exit_code, 0)
})

test('a registry row without a migration file is refused before truncation can erase it', { timeout: 420000 }, (t) => {
  const fx = fixture(t, (db) => db.prepare("INSERT INTO schema_migrations (id, name, checksum, checksum_origin) VALUES ('070_ghost_migration', 'ghost', 'abc', 'applied')").run())
  const r = rehearse(t, fx)
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const rep = readReport(r.target)
  assert.ok(rep.failures.some((f) => /PRE_UPGRADE_REGISTRY_FILE_MISSING/.test(f) && /070_ghost_migration/.test(f)), JSON.stringify(rep.failures))
  assert.deepEqual(rep.databases[0].steps, [])
  assert.ok(rep.rollback)
})

test('a synthetic database whose settings point backup_dir elsewhere cannot make the rehearsal write or prune outside the target', { timeout: 420000 }, (t) => {
  const base = tempDir(t, 'os-egp-rehearsal-synth-')
  const synth = path.join(base, 'data')
  const gen = spawnSync(process.execPath, ['scripts/synth-data.mjs', '--skus', '24', '--txns', '240', '--docs', '60', '--quiet'], {
    cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), GML_RUNTIME_MODE: 'production', GML_DATA_DIR: synth, GML_DB: '', GML_SYNTH_ADMIN_PASSWORD: 'Synthetic-Pass-0123456789' }
  })
  assert.equal(gen.status, 0, gen.stderr + gen.stdout)
  const outside = path.join(base, 'real-backups')
  mkdirSync(outside)
  const precious = ['gml_cosmetic_19990101-000000.db', 'gml_cosmetic_19990102-000000.db', 'gml_cosmetic_19990103-000000.db']
  for (const f of precious) writeFileSync(path.join(outside, f), 'precious backup bytes')
  const db = new Database(path.join(synth, 'gml_cosmetic.db'))
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_dir', ?)").run(outside)
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('backup_keep', '1')").run()
  db.close()
  const r = rehearse(t, null, { args: ['--from=58', `--synth-dir=${synth}`], input: false })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.deepEqual(readdirSync(outside).sort(), precious, 'nothing was written to or pruned from the directory named by the copy\'s settings')
  assert.ok(readdirSync(path.join(r.target, 'synth-source/backups')).some((f) => /^backup-report-/.test(f)))
}
)

test('a synthetic directory holding more than one industry database is refused instead of silently rehearsing only one', { timeout: 120000 }, (t) => {
  const dir = tempDir(t, 'os-egp-rehearsal-multi-')
  writeFileSync(path.join(dir, 'gml_cosmetic.db'), '')
  writeFileSync(path.join(dir, 'gml_food.db'), '')
  const r = rehearse(t, null, { args: ['--from=58', `--synth-dir=${dir}`], input: false })
  assert.equal(r.status, 2, r.stdout + r.stderr)
  assert.match(r.stderr, /REHEARSAL_SYNTH_MULTI_INDUSTRY/)
  assert.equal(existsSync(r.target), false)
})

test('lock probe measures how long another writer is blocked, and reports zero when nothing holds the lock', { timeout: 60000 }, async (t) => {
  const dir = tempDir(t, 'os-egp-lockprobe-')
  const file = path.join(dir, 'probe.db')
  const holder = new Database(file)
  holder.pragma('journal_mode = WAL')
  holder.exec('CREATE TABLE t (x)')
  const idle = await startLockProbe(file)
  await delay(40)
  const quiet = await idle.stop()
  assert.equal(quiet.busy_attempts, 0)
  assert.equal(quiet.max_blocked_ms, 0)
  assert.ok(quiet.ok_attempts > 0)
  const probe = await startLockProbe(file)
  await delay(20)
  holder.exec('BEGIN IMMEDIATE')
  holder.exec('INSERT INTO t VALUES (1)')
  await delay(250)
  holder.exec('COMMIT')
  await delay(40)
  const res = await probe.stop()
  holder.close()
  assert.ok(res.busy_attempts > 0, JSON.stringify(res))
  assert.ok(res.max_blocked_ms >= 150 && res.max_blocked_ms < 1500, `blocked window ${res.max_blocked_ms}ms`)
  // The lock was held for 250 ms: the lower bound (first to last failed attempt) cannot exceed it, the sampled upper bound cannot be below it.
  assert.ok(res.max_busy_span_ms >= 150 && res.max_busy_span_ms <= 260, `busy span ${res.max_busy_span_ms}ms`)
  assert.ok(res.max_busy_span_ms <= res.max_blocked_ms)
  assert.equal(res.other_errors, 0)
})
