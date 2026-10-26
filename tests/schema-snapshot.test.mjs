/**
 * ============================================================================
 * 文件标识：tests/schema-snapshot.test.mjs ｜ 测试：旧结构备份集生成器 schema-snapshot 与"升级演练免截断"路径（AB5 / ADR-0048）
 * ============================================================================
 * 【职责】真实子进程跑 scripts/schema-snapshot.mjs 与 scripts/upgrade-rehearsal.mjs（小规模夹具）：
 *   · `--upto 58` 产出三库备份集：版本表恰为编号 ≤58 的仓库迁移、校验和等于文件 sha256；
 *     表/列/索引是真的旧结构（没有 qimen_nonces 表、platforms 没有 app_secret_sealed 列、没有 059 的索引）；
 *     三库都带 SYNTHCO 指纹与 production 标记；备份集 sha256 可核对；产出目录里没有留下在用的 .db；
 *   · `--synth tiny`：业务数据真的在旧结构里（products > 0），verify-seed 风格不变量全绿、外键无违规；
 *   · 用这份备份集跑 `upgrade-rehearsal.mjs --from=58`：不截断（registry_truncated / indexes_dropped 为空，报告标明 skipped），
 *     059/060/061/062 的 structure_preexisting 为 false（真正新建），升级后与全部迁移一致；
 *   · 校验和保护没被绕过：备份里 ≤58 的登记校验和被篡改 ⇒ PRE_UPGRADE_CHECKSUM_MISMATCH、不升级；
 *   · 拒绝（退出码 2、不创建任何文件）：相对路径、非空目录、仓库 data/ 内（含符号链接别名）、等于/位于调用方 GML_DATA_DIR、
 *     --upto 缺失/非数字/不是现有迁移编号（如 44 的空号、超过最高编号）、未知参数、未知 --synth。
 * 【改它要注意什么】每个目录都是 mkdtemp 的新目录，用后删除；子进程环境白名单，不碰仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, readdirSync, readFileSync, existsSync, mkdirSync, symlinkSync, copyFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const MIG_DIR = path.join(ROOT, 'server/db/migrations')
const sha256 = (file) => createHash('sha256').update(readFileSync(file)).digest('hex')
const REPO = readdirSync(MIG_DIR).filter((f) => /^\d{3}_.*\.cjs$/.test(f)).sort()
const ids = (max) => REPO.filter((f) => Number(f.slice(0, 3)) <= max).map((f) => f.replace(/\.cjs$/, ''))
const REPLAY = ids(999).filter((id) => Number(id.slice(0, 3)) > 58)

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const baseEnv = () => ({ PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir() })

function snapshot(t, args, { out = path.join(tempDir(t, 'os-egp-snap-'), 'set'), env = {} } = {}) {
  const r = spawnSync(process.execPath, ['scripts/schema-snapshot.mjs', ...args.map((a) => (a === '@out' ? `--out=${out}` : a))], { cwd: ROOT, env: { ...baseEnv(), ...env }, encoding: 'utf8', timeout: 600000 })
  return { ...r, out }
}
const backupsOf = (out) => path.join(out, 'data/backups')
const reportOf = (out) => JSON.parse(readFileSync(path.join(backupsOf(out), readdirSync(backupsOf(out)).find((f) => /^backup-report-.*\.json$/.test(f))), 'utf8'))
const manifestOf = (out) => JSON.parse(readFileSync(path.join(out, 'snapshot-manifest.json'), 'utf8'))
const dbEntries = (out) => reportOf(out).results.filter((r) => r.status === 'ok')

function openBackup(out, code) {
  const e = dbEntries(out).find((r) => r.code === code)
  assert.ok(e, `backup entry ${code}`)
  const file = path.isAbsolute(e.file) ? e.file : path.join(backupsOf(out), path.basename(e.file))
  assert.equal(sha256(file), e.sha256, `${code} sha256 matches the backup report`)
  return new Database(file, { readonly: true })
}

test('--upto 58 builds the three industry DBs from schema.sql + migrations <= 58 and backs them up', { timeout: 600000 }, (t) => {
  const r = snapshot(t, ['--upto=58', '@out'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const m = manifestOf(r.out)
  assert.equal(m.upto, 58)
  assert.equal(m.synth, 'none')
  assert.deepEqual(m.industries.sort(), ['apparel', 'cosmetic', 'food'])
  assert.equal(m.registry_max, 58)
  assert.deepEqual(dbEntries(r.out).map((e) => e.code).sort(), ['apparel', 'cosmetic', 'food'])
  for (const code of ['cosmetic', 'food', 'apparel']) {
    const db = openBackup(r.out, code)
    try {
      const reg = db.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()
      assert.deepEqual(reg.map((x) => x.id), ids(58), code)
      for (const x of reg) {
        assert.equal(x.checksum, sha256(path.join(MIG_DIR, `${x.id}.cjs`)), `${code} ${x.id} checksum equals the repository file`)
        assert.equal(x.checksum_origin, 'applied')
      }
      assert.ok(db.prepare('SELECT 1 FROM orgs WHERE code=?').get('SYNTHCO'), `${code} carries the SYNTHCO fingerprint`)
      assert.equal(db.prepare('SELECT mode FROM os_egp_runtime WHERE id=1').get().mode, 'production')
      // genuinely old structure: tables, columns and indexes created by 059+ are absent
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='qimen_nonces'").get(), undefined, 'table from 060 absent')
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_poi_order'").get(), undefined, 'index from 059 absent')
      assert.ok(!db.prepare('PRAGMA table_info(platforms)').all().some((c) => c.name === 'app_secret_sealed'), 'column from 060 absent')
      assert.equal(db.prepare("SELECT 1 FROM permissions WHERE code='oms.platform.manage'").get(), undefined, 'permission row from 060 absent')
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok')
    } finally {
      db.close()
    }
  }
  // the live database files are not left behind; only the backup set and manifest are the product
  const left = readdirSync(path.join(r.out, 'data')).filter((f) => /\.db(-wal|-shm)?$/.test(f))
  assert.deepEqual(left, [])
  assert.ok(!existsSync(path.join(r.out, 'stage')) && !existsSync(path.join(r.out, 'synth-src')))
  assert.doesNotMatch(readFileSync(path.join(r.out, 'snapshot-manifest.json'), 'utf8'), /password|secret/i)
  assert.equal(statSync(path.join(r.out, 'snapshot-manifest.json')).mode & 0o077, 0)
})

test('very old baselines work too (no setting_audit_log before 038): --upto=1 and --upto=37', { timeout: 600000 }, (t) => {
  for (const n of [1, 37]) {
    const r = snapshot(t, [`--upto=${n}`, '@out'])
    assert.equal(r.status, 0, `${n}: ${r.stdout}${r.stderr}`)
    assert.equal(manifestOf(r.out).registry_max, n)
    const db = openBackup(r.out, 'food')
    try { assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((x) => x.id), ids(n)) } finally { db.close() }
  }
})

test('--synth tiny loads business data into the OLD structure and keeps the seed invariants green', { timeout: 600000 }, async (t) => {
  const r = snapshot(t, ['--upto=58', '--synth=tiny', '@out'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const m = manifestOf(r.out)
  assert.equal(m.synth, 'tiny')
  assert.equal(m.synth_load.foreign_key_violations, 0)
  assert.equal(m.synth_load.invariants_failed.length, 0)
  const db = openBackup(r.out, 'cosmetic')
  try {
    assert.ok(db.prepare('SELECT COUNT(*) c FROM products').get().c > 0)
    assert.ok(db.prepare('SELECT COUNT(*) c FROM purchase_orders').get().c > 0)
    assert.ok(db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c >= 600)
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='qimen_nonces'").get(), undefined, 'still old structure')
    assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='idx_poi_order'").get(), undefined)
    assert.equal(db.prepare("SELECT 1 FROM permissions WHERE code='oms.platform.manage'").get(), undefined, 'permission rows added by 059+ were not copied in')
    assert.deepEqual(db.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((x) => x.id), ids(58))
    assert.equal(db.pragma('foreign_key_check').length, 0)
    const { verifyInvariants } = await import('../scripts/synth-data.mjs')
    const inv = await verifyInvariants(db)
    assert.deepEqual(inv.checks.filter((c) => !c.ok), [])
  } finally {
    db.close()
  }
  const food = openBackup(r.out, 'food')
  try { assert.equal(food.prepare('SELECT COUNT(*) c FROM products').get().c, 0, 'only the cosmetic database carries synthetic business data') } finally { food.close() }
})

test('upgrade-rehearsal --from=58 on a snapshot set skips truncation and replays genuinely new structure', { timeout: 900000 }, (t) => {
  const s = snapshot(t, ['--upto=58', '--synth=tiny', '@out'])
  assert.equal(s.status, 0, s.stdout + s.stderr)
  const before = sha256(path.join(backupsOf(s.out), path.basename(dbEntries(s.out)[0].file)))
  const target = path.join(tempDir(t, 'os-egp-snap-rh-'), 'run')
  const r = spawnSync(process.execPath, ['scripts/upgrade-rehearsal.mjs', '--from=58', `--backup-dir=${backupsOf(s.out)}`, `--target-dir=${target}`], { cwd: ROOT, env: baseEnv(), encoding: 'utf8', timeout: 900000 })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  const rep = JSON.parse(readFileSync(path.join(target, readdirSync(target).find((f) => /^upgrade-rehearsal-.*\.json$/.test(f))), 'utf8'))
  assert.equal(rep.passed, true)
  assert.deepEqual(rep.failures, [])
  assert.deepEqual(rep.warnings, [])
  assert.equal(rep.databases.length, 3)
  for (const d of rep.databases) {
    assert.equal(d.baseline_registry.max, 58)
    assert.equal(d.baseline_registry.truncation, 'skipped')
    assert.deepEqual(d.registry_truncated, [])
    assert.deepEqual(d.indexes_dropped, [])
    assert.deepEqual(d.steps.map((x) => x.id), REPLAY)
    assert.ok(d.steps.every((x) => x.status === 'ok'))
    for (const id of REPLAY.filter((x) => /^(059|060|061|062)_/.test(x))) assert.equal(d.steps.find((x) => x.id === id).structure_preexisting, false, `${d.code} ${id} really built, not an idempotent replay`)
    for (const name of ['all_steps_applied', 'checksums_verified', 'production_rerun_is_noop', 'registry_covers_all_migrations', 'integrity_ok', 'foreign_keys_not_worse', 'probes_retained', 'seed_invariants_not_regressed']) assert.equal(d.invariants.find((i) => i.name === name)?.passed, true, `${d.code} ${name}`)
  }
  const work = new Database(path.join(target, 'work/gml_cosmetic.db'), { readonly: true })
  try {
    assert.deepEqual(work.prepare('SELECT id FROM schema_migrations ORDER BY id').all().map((x) => x.id), ids(999))
    assert.ok(work.prepare("SELECT 1 FROM sqlite_master WHERE name='qimen_nonces'").get(), 'table created by the replayed 060')
    assert.ok(work.prepare("SELECT 1 FROM permissions WHERE code='oms.platform.manage'").get())
  } finally {
    work.close()
  }
  assert.equal(sha256(path.join(backupsOf(s.out), path.basename(dbEntries(s.out)[0].file))), before, 'source set untouched')
})

test('a snapshot whose registered checksum was altered is still refused before any migration runs (no checksum bypass)', { timeout: 900000 }, (t) => {
  const s = snapshot(t, ['--upto=58', '@out'])
  assert.equal(s.status, 0, s.stdout + s.stderr)
  // rebuild a tampered set: restore the cosmetic backup into a scratch data dir, alter a row <= 58, back it up again
  const scratch = tempDir(t, 'os-egp-snap-tamper-')
  const e = dbEntries(s.out).find((x) => x.code === 'cosmetic')
  copyFileSync(path.isAbsolute(e.file) ? e.file : path.join(backupsOf(s.out), path.basename(e.file)), path.join(scratch, 'gml_cosmetic.db'))
  const db = new Database(path.join(scratch, 'gml_cosmetic.db'))
  db.prepare("UPDATE schema_migrations SET checksum=? WHERE id=?").run('0'.repeat(64), ids(58).at(-1))
  db.close()
  const env = { ...baseEnv(), HOME: scratch, TMPDIR: scratch, GML_RUNTIME_MODE: 'production', GML_DATA_DIR: scratch, GML_DB: '' }
  const b = spawnSync(process.execPath, ['scripts/db-backup.mjs', 'cosmetic'], { cwd: ROOT, env, encoding: 'utf8', timeout: 120000 })
  assert.equal(b.status, 0, b.stdout + b.stderr)
  const target = path.join(tempDir(t, 'os-egp-snap-tamper-t-'), 'run')
  const r = spawnSync(process.execPath, ['scripts/upgrade-rehearsal.mjs', '--from=58', `--backup-dir=${path.join(scratch, 'backups')}`, `--target-dir=${target}`], { cwd: ROOT, env: baseEnv(), encoding: 'utf8', timeout: 600000 })
  assert.equal(r.status, 1, r.stdout + r.stderr)
  const rep = JSON.parse(readFileSync(path.join(target, readdirSync(target).find((f) => /^upgrade-rehearsal-.*\.json$/.test(f))), 'utf8'))
  assert.match(rep.failures.join('\n'), /PRE_UPGRADE_CHECKSUM_MISMATCH/)
  assert.deepEqual(rep.databases[0].steps, [])
})

test('refusals: exit code 2 and nothing is created', (t) => {
  const parent = tempDir(t, 'os-egp-snap-refuse-')
  const created = () => readdirSync(parent)
  const refuse = (args, label, env = {}) => {
    const r = snapshot(t, args, { env })
    assert.equal(r.status, 2, `${label}: ${r.stdout}${r.stderr}`)
    assert.deepEqual(created(), [], `${label}: nothing created`)
    return r
  }
  const out = path.join(parent, 'o')
  // missing / malformed / unknown --upto
  refuse(['--upto=58'], 'missing --out')
  refuse([`--out=${out}`], 'missing --upto')
  refuse(['--upto=abc', `--out=${out}`], 'non numeric')
  refuse(['--upto=44', `--out=${out}`], '044 is not a migration number')
  refuse(['--upto=999', `--out=${out}`], 'above the highest migration')
  refuse(['--upto=0', `--out=${out}`], 'zero')
  refuse(['--upto=58', `--out=${out}`, '--bogus=1'], 'unknown flag')
  refuse(['--upto=58', `--out=${out}`, '--synth=huge'], 'unknown profile')
  refuse(['--upto=58', '--out=relative/dir'], 'relative out')
  // never into the repository data/ (also through a symlink alias), never the caller's data dir
  refuse(['--upto=58', `--out=${path.join(ROOT, 'data', 'snap-x')}`], 'repo data/')
  const alias = path.join(parent, 'alias')
  symlinkSync(path.resolve(ROOT, 'data'), alias)
  const r1 = snapshot(t, ['--upto=58', `--out=${path.join(alias, 'snap-y')}`])
  assert.equal(r1.status, 2, r1.stdout + r1.stderr)
  assert.ok(!existsSync(path.join(ROOT, 'data', 'snap-y')))
  rmSync(alias)
  const live = path.join(parent, 'live')
  mkdirSync(live)
  const r2 = snapshot(t, ['--upto=58', `--out=${live}`], { env: { GML_DATA_DIR: live } })
  assert.equal(r2.status, 2, r2.stdout + r2.stderr)
  assert.deepEqual(readdirSync(live), [], 'caller data dir untouched')
  const r3 = snapshot(t, ['--upto=58', `--out=${path.join(live, 'inner')}`], { env: { GML_DATA_DIR: live } })
  assert.equal(r3.status, 2, r3.stdout + r3.stderr)
  assert.deepEqual(readdirSync(live), [])
  // non-empty target is never overwritten
  const full = path.join(parent, 'full')
  mkdirSync(full)
  writeFileSync(path.join(full, 'keep.txt'), 'keep')
  const r4 = snapshot(t, ['--upto=58', `--out=${full}`])
  assert.equal(r4.status, 2, r4.stdout + r4.stderr)
  assert.deepEqual(readdirSync(full), ['keep.txt'])
  rmSync(full, { recursive: true })
  rmSync(live, { recursive: true })
  assert.deepEqual(created(), [])
})
