#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/upgrade-rehearsal.mjs ｜ 迁移升级演练：备份集/合成库的隔离副本从 `--from N` 基线起逐个重放后续迁移，记录每个迁移耗时与写锁等待，失败即回退演练（roadmap-v6 AA11）
 * ============================================================================
 * 【职责】回答"上线 059–062 这类迁移时，在大库上要多久、会把写入者挡多久、失败了能不能退回去"。
 *   1. 输入二选一：`--backup-dir`（db-backup 备份集，缺省最新，`--stamp` 指定）或 `--synth-dir`（synth-data.mjs 造的合成库目录，
 *      必须带合成指纹 org=SYNTHCO；会先复制再用 db-backup.mjs 备份成备份集，之后与真实备份集走同一条路径）。
 *   2. 在 `--target-dir`（显式绝对路径、空目录）里 sha256 核对并恢复一份工作副本。源备份 / 源目录永不改动。
 *   3. **基线截断**（见下）：把版本表 `schema_migrations` 中编号 > N 的行删掉，并（缺省）删除这些迁移在仓库里创建的索引，
 *      使后续迁移**真的**重新应用而不是对现成结构做空转。
 *   4. 在一个**暂存迁移目录**里逐个加入编号 > N 的迁移文件（字节级复制，校验和不变），每加一个就以生产模式调用一次
 *      `runMigrations(db, { migrationsDir: 暂存目录, mode: 'production' })`，记录该步耗时；同时在 worker 线程里用另一个连接
 *      反复 `BEGIN IMMEDIATE` 探测写锁（scripts/lib/lock-probe.mjs），得到该步的最长写入者阻塞窗口。
 *   5. 升级后核对：校验和全部登记且与文件一致、生产模式再跑一遍是空操作、integrity_check、foreign_key_check 不变坏、
 *      业务探针（drill-common 的 PROBES）前后相同、verify-seed 风格不变量（synth-data 的 verifyInvariants）没有从绿变红。
 *   6. **任一失败 ⇒ 回退**：进程内删掉工作副本并从备份集重新核对 sha256 复制、证明版本表/探针/integrity 与升级前逐项相同；
 *      然后调用 `scripts/upgrade-rollback-drill.mjs`（ADR-0016，真实迁移入口 + 真实服务 + 必败迁移 + 篡改拒绝）并把结论写进报告。
 *   报告 `upgrade-rehearsal-<stamp>.json`（0600）写在 `--target-dir`。不含密码/密钥。
 *
 * 【基线截断：精确语义，校验和与自愈为什么不被绕过】
 *   · `--from N` = "编号 ≤ N 的迁移视为已应用的基线，编号 > N 的要重放"。`--from=58` 重放 059、060、061、062。
 *   · 截断只做两件事，且只在工作副本上：`DELETE FROM schema_migrations WHERE 编号 > N`；
 *     `DROP INDEX` 那些**仓库里编号 > N 的迁移创建、而基线迁移不创建**的索引（算法：内存库跑 schema.sql + 迁移 ≤N 得到索引集 A，
 *     再跑全部迁移得到 B，只删 B−A 且存在于副本里的索引；表/列不删，因为删列有损数据）。索引是纯派生结构，删了不丢数据。
 *   · **不改任何校验和**。编号 ≤ N 的行保留原校验和，运行器第一遍照常与暂存目录里的文件比对，不一致 ⇒ 生产模式在任何写入前
 *     以 MIGRATION_CHECKSUM_MISMATCH 拒绝（演练判失败）。被删掉的行（编号 > N）本来登记的校验和，在删除**之前**先与当前文件比对，
 *     不一致同样判失败 `PRE_UPGRADE_CHECKSUM_MISMATCH` —— 否则截断会把"生产上这个库启动会被拒绝"的事实抹掉。
 *     重放的迁移由运行器按当前文件重新登记（origin=applied）。永不调用 adopt。
 *   · **自愈**（运行器对已登记迁移 verify() 失败就重跑 up()）：每步都记录 `healed`。编号 > N 的迁移被自愈 = 迁移的 up 与 verify 不自洽，判失败；
 *     编号 ≤ N 的被自愈只记警告（生产启动也会发生同样的自愈）。
 *   · 诚实边界：被截断的迁移里，**表/列/数据变更类**的结构在副本里原本就存在（来自当前代码生成的合成库或新备份），所以它们的 up() 是
 *     对现成结构的幂等重放，耗时偏低。每步的 `structure_preexisting`（重放前该迁移 verify() 的结果）如实标明：false = 真正新建，
 *     true = 空转重放，null = 迁移没有 verify。**只有 structure_preexisting=false 的步骤耗时才代表真实升级成本**；
 *     若要演练真正的旧库，应拿旧版本代码产出的备份集（它的版本表本来就缺这些行），此时 `--from` 取其最高已应用编号。
 *
 * 【耗时与锁时间的口径】`duration_ms` = 一次 `runMigrations` 调用的墙钟（含对暂存目录的校验和核对与对已登记迁移的 verify()）；
 *   `overhead_ms` = 紧接着再调用一次（此时是空操作）的墙钟；`net_ms = max(0, duration_ms - overhead_ms)` 近似该迁移 up() + 登记 + 提交。
 *   `lock.max_busy_span_ms`（下界）与 `lock.max_blocked_ms`（近似上界）见 lock-probe.mjs：真实持锁时长落在两者之间、外加线程调度噪声，写入者视角；单个迁移一个事务，迁移期间持有写事务的粗上界是 `duration_ms`。
 *   全部是运行它的这台机器、当时负载下的单次墙钟，不是目标主机（dmserver）结果，不是容量承诺。
 *
 * 【扩展：演练尚未合入的迁移】`--extra-migrations-dir=/abs/dir`：目录里编号大于仓库现有最大编号的 `NNN_名称.cjs` 追加到演练序列末尾
 *   （只复制进暂存目录，永不写进 server/db/migrations/）。测试用它注入必败迁移来走回退路径；运维可用它在大库上预演 063。
 *
 * 【安全判据】`--target-dir` 必须是显式绝对路径的空目录（drill-common 的同一套判据：不是备份来源 data_dir、不是调用方 GML_DATA_DIR、
 *   不与备份目录互相包含），且不得位于仓库 data/ 内；`--synth-dir` 同样不得位于仓库 data/、不得等于调用方 GML_DATA_DIR、必须带合成指纹。
 *   违反 ⇒ 退出码 2，且不创建/不改动任何文件。每个被打开的库文件都先断言位于 `--target-dir` 内。只接受运行模式标记为 production 的库（同 ADR-0016）。
 *
 * 【用法】node scripts/upgrade-rehearsal.mjs --from=58 --target-dir=/abs/empty (--backup-dir=/abs/backups [--stamp=…] | --synth-dir=/abs/synth-data-dir)
 *          [--extra-migrations-dir=/abs/dir] [--keep-post-baseline-indexes]
 *   退出码：0 升级与全部核对通过；1 升级或核对失败（已执行回退，见报告 `rollback`）；2 参数/目录/基线被拒绝。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { runMigrations, checkMigrationChecksums, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import {
  EXIT_OK, EXIT_FAILED, EXIT_USAGE, DrillError, ROOT, INDUSTRY_DB,
  parseArgs, loadBackupSet, prepareTargetDir, verifyAndRestore, materializeEntry, runtimeMarkerOf,
  sqlProbes, writeReport, stampNow, backupAgeSeconds, childEnv
} from './lib/drill-common.mjs'
import { resolveBackupDir } from '../server/lib/backup-dir.js'
import { isWithin } from './lib/safe-path.mjs'
import { startLockProbe } from './lib/lock-probe.mjs'

const require = createRequire(import.meta.url)
const KNOWN = ['from', 'target-dir', 'backup-dir', 'stamp', 'synth-dir', 'extra-migrations-dir', 'keep-post-baseline-indexes']
const FILE_RE = /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/
const SYNTH_ORG = 'SYNTHCO'
const idOf = (file) => file.replace(/\.cjs$/, '')
const numOf = (idOrFile) => Number(idOrFile.slice(0, 3))
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const round1 = (n) => Math.round(n * 10) / 10
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const withinRepoData = (p) => isWithin(path.resolve(ROOT, 'data'), p)
const usage = (code, message) => new DrillError(code, message, EXIT_USAGE)

const t0 = performance.now()
const since = (from) => Math.round(performance.now() - from)

const report = {
  script: 'scripts/upgrade-rehearsal.mjs',
  schema_version: 1,
  generated_at: new Date().toISOString(),
  stamp: stampNow(),
  runtime_mode: 'production',
  passed: false,
  failures: [],
  warnings: [],
  scope_notice: '单次墙钟，运行它的这台机器、当时负载下的数字；不是目标主机（dmserver）结果，不是容量承诺，不是验收证据。',
  host: { platform: os.platform(), arch: os.arch(), cpus: os.cpus().length, cpu_model: os.cpus()[0]?.model ?? null, total_mem_mb: Math.round(os.totalmem() / 1048576), node: process.version, loadavg_start: os.loadavg().map(round1) },
  input: null,
  baseline: null,
  target_dir: null,
  restored: [],
  databases: [],
  rollback: null,
  timing: {},
  notes: [
    '被截断的迁移里，表/列/数据变更类的结构在副本里原本就存在，其 up() 是对现成结构的幂等重放；只有 structure_preexisting=false 的步骤耗时才代表真实升级成本。',
    '写锁等待是采样区间而不是精确值：lock.max_busy_span_ms 是下界、lock.max_blocked_ms 是含调度噪声的近似上界（高负载下可能明显偏大），写入者视角；迁移期间持有写事务的粗上界是 duration_ms。WAL 模式下读者不被写锁挡住，本演练不量读者。'
  ]
}

function listRepoMigrations() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => FILE_RE.test(f)).sort()
}

/** 解析 --from：非负十进制整数。 */
function parseFrom(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw usage('DRILL_USAGE', '--from 必须是迁移编号（如 58 或 058）：编号 ≤ 它的迁移视为已应用，编号 > 它的重放')
  return Number(raw)
}

/** 追加迁移（--extra-migrations-dir）：编号必须大于仓库最大编号、不重复、不是符号链接。 */
function loadExtras(dirArg, repoFiles) {
  if (!dirArg) return []
  if (typeof dirArg !== 'string' || !path.isAbsolute(dirArg)) throw usage('DRILL_USAGE', '--extra-migrations-dir 必须是显式绝对路径')
  const dir = path.resolve(dirArg)
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw usage('REHEARSAL_EXTRA_INVALID', `--extra-migrations-dir 不存在或不是目录：${dir}`)
  if (isWithin(MIGRATIONS_DIR, dir)) throw usage('REHEARSAL_EXTRA_INVALID', '--extra-migrations-dir 不得位于 server/db/migrations/ 之内')
  const maxRepo = numOf(repoFiles.at(-1))
  const files = fs.readdirSync(dir).filter((f) => FILE_RE.test(f)).sort()
  const seen = new Set()
  for (const f of files) {
    if (fs.lstatSync(path.join(dir, f)).isSymbolicLink()) throw usage('REHEARSAL_EXTRA_INVALID', `${f} 是符号链接`)
    if (numOf(f) <= maxRepo) throw usage('REHEARSAL_EXTRA_INVALID', `${f} 的编号必须大于仓库最大迁移编号 ${String(maxRepo).padStart(3, '0')}`)
    if (seen.has(numOf(f))) throw usage('REHEARSAL_EXTRA_INVALID', `编号重复：${f}`)
    seen.add(numOf(f))
  }
  if (!files.length) throw usage('REHEARSAL_EXTRA_INVALID', '--extra-migrations-dir 里没有 NNN_名称.cjs 迁移')
  return files.map((f) => ({ file: f, src: path.join(dir, f), extra: true }))
}

/** 只读打开备份/合成库文件，返回已登记迁移 id 集合与合成指纹。 */
function inspectDb(file) {
  const db = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const hasRegistry = !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_migrations'").get()
    const applied = hasRegistry ? db.prepare('SELECT id FROM schema_migrations').all().map((r) => r.id) : []
    let synthetic = false
    try { synthetic = !!db.prepare('SELECT 1 FROM orgs WHERE code=?').get(SYNTH_ORG) } catch { /* 无 orgs 表 */ }
    return { applied: new Set(applied), synthetic }
  } finally {
    db.close()
  }
}

/** 基线必须与库吻合：编号 ≤ N 的仓库迁移全部已登记；且至少有一个迁移要重放。 */
function assertBaseline(inspected, label, from, steps) {
  const missing = listRepoMigrations().filter((f) => numOf(f) <= from && !inspected.applied.has(idOf(f))).map(idOf)
  if (missing.length) throw usage('REHEARSAL_BASELINE_NOT_APPLIED', `${label} 的版本表缺少编号 ≤ ${from} 的迁移：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}；--from 取值高于这个库真实的已应用版本`)
  if (!steps.length) throw usage('REHEARSAL_NOTHING_TO_APPLY', `没有编号 > ${from} 的迁移可演练（仓库最高编号 ${listRepoMigrations().at(-1).slice(0, 3)}）`)
}

/** 工作副本里的迁移暂存目录：只含 _helpers 与已加入的迁移文件（字节级复制）。 */
function makeStage(root, name, files) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^_.*\.cjs$/.test(x))) fs.copyFileSync(path.join(MIGRATIONS_DIR, f), path.join(dir, f))
  for (const f of files) addToStage(dir, f)
  return dir
}
function addToStage(dir, step) {
  const dest = path.join(dir, step.file)
  fs.copyFileSync(step.src, dest)
  if (sha256Of(dest) !== sha256Of(step.src)) throw new DrillError('REHEARSAL_STAGE_CORRUPT', `暂存的 ${step.file} 与源文件不一致`)
  return dest
}

/** 内存库上跑 schema.sql + 给定迁移，返回索引名集合（带 SQL 的，即非自动索引）。 */
function indexSetFor(root, name, files) {
  const dir = makeStage(root, name, files)
  const mem = new Database(':memory:')
  try {
    mem.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
    runMigrations(mem, { migrationsDir: dir, mode: 'production', warn: () => {} })
    return new Set(mem.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map((r) => r.name))
  } finally {
    mem.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

const snapshot = (db) => ({
  migrations: db.prepare('SELECT id, name, checksum, checksum_origin FROM schema_migrations ORDER BY id').all(),
  objects: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all()
})

async function seedChecks(db) {
  try {
    const { verifyInvariants } = await import('./synth-data.mjs')
    const r = await verifyInvariants(db)
    return { available: true, checks: r.checks.map((c) => ({ name: c.name, ok: c.ok })) }
  } catch (e) {
    return { available: false, error: String(e.message).slice(0, 200), checks: [] }
  }
}

function openWork(file, workDir) {
  if (!isWithin(workDir, file)) throw new DrillError('REHEARSAL_PATH_ESCAPE', `拒绝打开目标目录之外的库文件：${file}`)
  const db = new Database(file, { fileMustExist: true })
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('busy_timeout = 5000')
  return db
}

/** 一个行业库的完整演练。返回库级报告；失败写进 dbr.failures，不抛（让其它库也跑完并统一回退）。 */
async function rehearseDb(r, ctx) {
  const dbr = {
    code: r.code, db_file: path.basename(r.restored_as), size_bytes_before: fs.statSync(r.restored_as).size, size_bytes_after: null,
    pre: null, registry_truncated: [], indexes_dropped: [], steps: [], invariants: [], failures: [], warnings: [], passed: false, timing: {}
  }
  const fail = (name, detail) => { dbr.failures.push(`${name}: ${detail}`); dbr.invariants.push({ name, passed: false, detail }) }
  const ok = (name, detail) => dbr.invariants.push({ name, passed: true, detail })
  const check = (name, cond, detail) => (cond ? ok(name, detail) : fail(name, detail))
  const stageRoot = path.join(ctx.stageRoot, r.code)
  let db = null
  try {
    db = openWork(r.restored_as, ctx.workDir)
    // ---- 升级前状态 ----
    const before = snapshot(db)
    const probesBefore = sqlProbes(r.restored_as)
    const tInv0 = performance.now()
    const invBefore = await seedChecks(db)
    dbr.timing.seed_checks_before_ms = since(tInv0)
    const fkBefore = db.pragma('foreign_key_check').length
    dbr.pre = { migrations: before.migrations.length, objects: before.objects.length, integrity: db.pragma('integrity_check', { simple: true }), foreign_key_violations: fkBefore, probes: probesBefore, seed_checks: invBefore.checks.filter((c) => c.ok).length + '/' + invBefore.checks.length, seed_checks_available: invBefore.available }
    ctx.pre.set(r.code, { registry: before.migrations, probes: probesBefore })
    if (dbr.pre.integrity !== 'ok') { fail('pre_integrity_ok', `升级前 integrity_check=${dbr.pre.integrity}`); return dbr }

    // ---- 截断之前：被删行的登记校验和先与当前文件比对（否则截断会抹掉"生产启动会被拒绝"的事实）----
    const preCheck = checkMigrationChecksums(db, { migrationsDir: MIGRATIONS_DIR })
    if (preCheck.mismatched.length) { fail('PRE_UPGRADE_CHECKSUM_MISMATCH', `升级前就有已登记迁移与当前文件校验和不一致：${preCheck.mismatched.join(', ')}（生产模式启动会拒绝）`); return dbr }
    if (preCheck.missing.length) { fail('PRE_UPGRADE_REGISTRY_FILE_MISSING', `版本表登记了但当前仓库没有对应迁移文件：${preCheck.missing.join(', ')}（无法核对其校验和；截断会把它们的历史一并抹掉）`); return dbr }
    if (preCheck.unrecorded.length) dbr.warnings.push(`无校验和的旧登记行（运行器会按当前文件收养）：${preCheck.unrecorded.join(', ')}`)

    // ---- 基线截断 ----
    const dropRows = before.migrations.filter((m) => numOf(m.id) > ctx.from)
    for (const m of dropRows) {
      const file = path.join(MIGRATIONS_DIR, `${m.id}.cjs`)
      const current = fs.existsSync(file) ? sha256Of(file) : null
      dbr.registry_truncated.push({ id: m.id, recorded_checksum: m.checksum, recorded_origin: m.checksum_origin, current_file_checksum: current, matches_current_file: !!m.checksum && m.checksum === current })
    }
    db.transaction(() => {
      const del = db.prepare('DELETE FROM schema_migrations WHERE id=?')
      for (const m of dropRows) del.run(m.id)
    })()
    if (!ctx.keepIndexes) {
      const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL").all().map((x) => x.name))
      const toDrop = [...ctx.postBaselineIndexes].filter((n) => present.has(n)).sort()
      db.transaction(() => { for (const n of toDrop) db.exec(`DROP INDEX IF EXISTS "${n.replace(/"/g, '""')}"`) })()
      dbr.indexes_dropped = toDrop
    }

    // ---- 逐个重放 ----
    const stage = makeStage(stageRoot, 'stage', ctx.baselineFiles)
    // 对暂存的基线目录先空跑一次：登记行是否都与文件一致、有无自愈，并量出"纯核对"开销的参考值
    const tBase = performance.now()
    const baseRun = runMigrations(db, { migrationsDir: stage, mode: 'production', warn: (m) => dbr.warnings.push(m) })
    dbr.timing.baseline_pass_ms = since(tBase)
    if (baseRun.applied.length) { fail('baseline_stage_no_apply', `基线暂存目录不应再应用任何迁移，却应用了 ${baseRun.applied.join(', ')}`); return dbr }
    if (baseRun.healed.length) dbr.warnings.push(`基线迁移自愈：${baseRun.healed.join(', ')}`)

    const tSteps = performance.now()
    for (const step of ctx.steps) {
      const id = idOf(step.file)
      const rec = { id, extra: !!step.extra, status: 'pending', structure_preexisting: null, duration_ms: null, overhead_ms: null, net_ms: null, applied: [], healed: [], lock: null, error: null, db_bytes_before: fs.statSync(r.restored_as).size }
      dbr.steps.push(rec)
      const dest = addToStage(stage, step)
      let mod = null
      try { mod = require(dest) } catch (e) { rec.status = 'failed'; rec.error = `加载失败：${e.message}`; fail('migration_step_applied', `${id}: ${rec.error}`); break }
      if (mod && typeof mod.verify === 'function') { try { rec.structure_preexisting = mod.verify(db) === true } catch { rec.structure_preexisting = false } }
      const probe = await startLockProbe(r.restored_as)
      const ts = performance.now()
      let res = null
      let err = null
      try { res = runMigrations(db, { migrationsDir: stage, mode: 'production', warn: (m) => dbr.warnings.push(m) }) } catch (e) { err = e }
      rec.duration_ms = round1(performance.now() - ts)
      rec.lock = await probe.stop()
      if (err) {
        rec.status = 'failed'
        rec.error = String(err.message).slice(0, 400)
        fail('migration_step_applied', `${id}: ${rec.error}`)
        break
      }
      rec.applied = res.applied
      rec.healed = res.healed
      const to = performance.now()
      const noop = runMigrations(db, { migrationsDir: stage, mode: 'production', warn: () => {} })
      rec.overhead_ms = round1(performance.now() - to)
      if (noop.applied.length || noop.healed.length || noop.adopted.length) {
        rec.status = 'failed'
        rec.error = `紧接着的核对调用不是空操作：applied=[${noop.applied}] healed=[${noop.healed}] adopted=[${noop.adopted}]（${id} 的 verify() 与 up() 不自洽？）`
        fail('no_self_heal_after_apply', `${id}: ${rec.error}`)
        break
      }
      rec.net_ms = round1(Math.max(0, rec.duration_ms - rec.overhead_ms))
      rec.db_bytes_after = fs.statSync(r.restored_as).size
      rec.status = same(res.applied, [id]) ? 'ok' : 'unexpected'
      if (rec.status !== 'ok') { fail('migration_step_applied', `${id}: 本步应用了 [${res.applied.join(', ')}]，期望只有它自己`); break }
      if (res.healed.length) {
        const bad = res.healed.filter((h) => numOf(h) > ctx.from)
        if (bad.length) { fail('no_self_heal_after_apply', `${id}: 编号 > ${ctx.from} 的迁移被自愈重跑：${bad.join(', ')}（up 与 verify 不自洽）`); break }
        dbr.warnings.push(`${id} 步骤中基线迁移被自愈：${res.healed.join(', ')}`)
      }
    }
    dbr.timing.steps_ms = since(tSteps)
    if (dbr.failures.length) return dbr
    ok('all_steps_applied', `${dbr.steps.length} 个迁移逐个应用成功`)

    // ---- 升级后核对 ----
    const afterChecks = checkMigrationChecksums(db, { migrationsDir: stage })
    const allIds = [...ctx.baselineFiles, ...ctx.steps].map((s) => idOf(s.file))
    check('checksums_verified', afterChecks.mismatched.length === 0 && afterChecks.unrecorded.length === 0 && afterChecks.missing.length === 0 && afterChecks.verified === allIds.length,
      `verified=${afterChecks.verified}/${allIds.length} mismatched=${afterChecks.mismatched.length} unrecorded=${afterChecks.unrecorded.length} missing=${afterChecks.missing.length}`)
    const real = checkMigrationChecksums(db, { migrationsDir: MIGRATIONS_DIR })
    const extraIds = new Set(ctx.steps.filter((s) => s.extra).map((s) => idOf(s.file)))
    check('repo_files_match_registry', real.mismatched.length === 0 && real.unrecorded.length === 0 && real.missing.every((m) => extraIds.has(m)),
      `仓库迁移文件与登记校验和：mismatched=${real.mismatched.length} unrecorded=${real.unrecorded.length}`)
    const rerun = runMigrations(db, { migrationsDir: stage, mode: 'production', warn: () => {} })
    check('production_rerun_is_noop', rerun.applied.length === 0 && rerun.healed.length === 0 && rerun.adopted.length === 0, `applied=${rerun.applied.length} healed=${rerun.healed.length} adopted=${rerun.adopted.length}`)
    const reg = db.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()
    check('registry_covers_all_migrations', same(reg.map((x) => x.id), [...allIds].sort()) && reg.every((x) => x.checksum), `登记 ${reg.length} 行 / 文件 ${allIds.length} 个，校验和无空值`)
    const replayed = reg.filter((x) => numOf(x.id) > ctx.from)
    check('replayed_rows_recorded_as_applied', replayed.length === ctx.steps.length && replayed.every((x) => x.checksum_origin === 'applied'), `重放行 ${replayed.length}，origin=${[...new Set(replayed.map((x) => x.checksum_origin))].join('/')}`)
    const integrity = db.pragma('integrity_check', { simple: true })
    check('integrity_ok', integrity === 'ok', `integrity_check=${integrity}`)
    const fkAfter = db.pragma('foreign_key_check').length
    check('foreign_keys_not_worse', fkAfter <= fkBefore, `foreign_key_check ${fkBefore} → ${fkAfter}`)
    db.pragma('wal_checkpoint(TRUNCATE)')
    const probesAfter = sqlProbes(r.restored_as)
    check('probes_retained', same(probesBefore, probesAfter), same(probesBefore, probesAfter) ? `探针前后相同：${JSON.stringify(probesAfter)}` : `探针变化：${JSON.stringify(probesBefore)} → ${JSON.stringify(probesAfter)}`)
    const tInv1 = performance.now()
    const invAfter = await seedChecks(db)
    dbr.timing.seed_checks_after_ms = since(tInv1)
    const regressed = invBefore.checks.filter((c) => c.ok && !invAfter.checks.find((a) => a.name === c.name)?.ok).map((c) => c.name)
    if (invBefore.available && !invAfter.available) regressed.push('seed_checks_unavailable_after')
    check('seed_invariants_not_regressed', regressed.length === 0, regressed.length ? `从绿变红：${regressed.join(', ')}` : `升级前 ${dbr.pre.seed_checks} 绿，升级后 ${invAfter.checks.filter((c) => c.ok).length}/${invAfter.checks.length} 绿`)
    if (!invBefore.available) dbr.warnings.push(`升级前 verify-seed 风格不变量不可用：${invBefore.error}`)
    dbr.post = { migrations: reg.length, integrity, foreign_key_violations: fkAfter, probes: probesAfter }
  } catch (e) {
    dbr.failures.push(`${e instanceof DrillError ? e.message : `REHEARSAL_UNEXPECTED: ${e.message}`}`)
  } finally {
    try { db?.close() } catch { /* ignore */ }
    dbr.size_bytes_after = fs.existsSync(r.restored_as) ? fs.statSync(r.restored_as).size : null
    dbr.passed = dbr.failures.length === 0
    fs.rmSync(stageRoot, { recursive: true, force: true })
  }
  return dbr
}

/** 回退：进程内重新恢复并证明与升级前相同，再跑 ADR-0016 的回退演练。 */
function rollback(set, ctx, restored) {
  const t = performance.now()
  const out = { reason: 'upgrade or verification failed', in_process: { passed: false, checks: [] }, drill: null, timing: {} }
  const note = (name, passed, detail) => { out.in_process.checks.push({ name, passed: !!passed, detail }); if (!passed) report.failures.push(`ROLLBACK_CHECK_FAILED: ${name} — ${detail}`) }
  try {
    for (const r of restored) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${r.restored_as}${suffix}`, { force: true })
    const rolled = verifyAndRestore(set, ctx.workDir)
    note('rollback_sha256_verified', rolled.length === set.entries.length && rolled.every((x) => x.sha256_verified), `${rolled.length} 个库从备份重新复制并核对 sha256`)
    for (const r of rolled) {
      const pre = ctx.pre.get(r.code)
      const db = new Database(r.restored_as, { readonly: true })
      try {
        const reg = db.prepare('SELECT id, name, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()
        note(`rollback_registry_restored[${r.code}]`, !pre || same(reg, pre.registry), `版本表 ${reg.length} 行${!pre || same(reg, pre.registry) ? '与升级前逐字段相同' : '与升级前不同'}`)
        note(`rollback_integrity_ok[${r.code}]`, db.pragma('integrity_check', { simple: true }) === 'ok', 'integrity_check')
      } finally {
        db.close()
      }
      if (pre) {
        const probes = sqlProbes(r.restored_as)
        note(`rollback_probes_retained[${r.code}]`, same(probes, pre.probes), same(probes, pre.probes) ? '探针与升级前相同' : `探针不符 ${JSON.stringify(probes)} / ${JSON.stringify(pre.probes)}`)
      }
    }
  } catch (e) {
    note('rollback_in_process', false, e.message)
  }
  out.in_process.passed = out.in_process.checks.length > 0 && out.in_process.checks.every((c) => c.passed)
  out.timing.in_process_ms = since(t)

  // ---- ADR-0016 回退演练（真实迁移入口 + 真实服务 + 必败迁移 + 篡改拒绝）----
  const t1 = performance.now()
  const drillTarget = path.join(ctx.target, 'rollback-drill')
  const env = { PATH: process.env.PATH, HOME: ctx.target, TMPDIR: ctx.target }
  if (process.env.GML_BACKUP_KEY) env.GML_BACKUP_KEY = process.env.GML_BACKUP_KEY
  const r = spawnSync(process.execPath, ['scripts/upgrade-rollback-drill.mjs', `--backup-dir=${set.dir}`, `--target-dir=${drillTarget}`, `--stamp=${set.stamp}`], { cwd: ROOT, env, encoding: 'utf8', timeout: 1200000 })
  let drillReport = null
  try {
    const f = fs.readdirSync(drillTarget).find((x) => /^upgrade-rollback-drill-.*\.json$/.test(x))
    if (f) drillReport = JSON.parse(fs.readFileSync(path.join(drillTarget, f), 'utf8'))
  } catch { /* 没有报告 */ }
  out.drill = {
    script: 'scripts/upgrade-rollback-drill.mjs', exit_code: r.status, target_dir: drillTarget, report_passed: drillReport?.passed ?? null,
    invariants: drillReport ? `${drillReport.invariants.filter((i) => i.passed).length}/${drillReport.invariants.length}` : null,
    failures: drillReport?.failures ?? null, timing: drillReport?.timing ?? null, output_tail: r.status === 0 ? undefined : ((r.stdout || '') + (r.stderr || '')).slice(-1500)
  }
  out.timing.drill_ms = since(t1)
  if (r.status !== 0) report.failures.push(`ROLLBACK_DRILL_FAILED: upgrade-rollback-drill 退出码 ${r.status}`)
  out.ok = out.in_process.passed && r.status === 0
  return out
}

let target = null
let targetPreexisted = true
let rollbackCtx = null
let exitCode = EXIT_FAILED
const cleanup = []

try {
  const args = parseArgs(process.argv.slice(2), KNOWN)
  if (!args['target-dir'] || args.from === undefined) throw usage('DRILL_USAGE', '必须给出 --from=<迁移编号> 与 --target-dir=<绝对路径>')
  if (!!args['backup-dir'] === !!args['synth-dir']) throw usage('DRILL_USAGE', '--backup-dir 与 --synth-dir 必须二选一')
  const from = parseFrom(args.from)
  const repoFiles = listRepoMigrations()
  const extras = loadExtras(args['extra-migrations-dir'], repoFiles)
  const allSteps = [...repoFiles.map((f) => ({ file: f, src: path.join(MIGRATIONS_DIR, f) })), ...extras]
  const baselineFiles = allSteps.filter((s) => numOf(s.file) <= from)
  const steps = allSteps.filter((s) => numOf(s.file) > from)
  if (!steps.length) assertBaseline({ applied: new Set(repoFiles.map(idOf)) }, '仓库', from, steps)
  report.baseline = { from, replay: steps.map((s) => idOf(s.file)), extra_migrations: extras.map((s) => idOf(s.file)), keep_post_baseline_indexes: !!args['keep-post-baseline-indexes'] }

  const targetArg = args['target-dir']
  if (typeof targetArg === 'string' && path.isAbsolute(targetArg) && withinRepoData(targetArg)) throw usage('DRILL_TARGET_IS_LIVE', '--target-dir 位于仓库 data/ 之内，拒绝')

  // ---- 输入：先在不创建任何文件的前提下做全部拒绝判定 ----
  let set = null
  let synthSourceDir = null
  const synthCodes = []
  if (args['synth-dir']) {
    const dir = args['synth-dir']
    if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw usage('DRILL_USAGE', '--synth-dir 必须是显式绝对路径')
    synthSourceDir = path.resolve(dir)
    if (withinRepoData(synthSourceDir)) throw usage('REHEARSAL_SOURCE_IS_LIVE', '--synth-dir 位于仓库 data/ 之内，拒绝')
    if (process.env.GML_DATA_DIR && path.resolve(process.env.GML_DATA_DIR) === synthSourceDir) throw usage('REHEARSAL_SOURCE_IS_LIVE', '--synth-dir 等于调用方的 GML_DATA_DIR（可能是在用实例），拒绝')
    if (!fs.existsSync(synthSourceDir) || !fs.statSync(synthSourceDir).isDirectory()) throw usage('DRILL_BACKUP_DIR_MISSING', `--synth-dir 不存在：${synthSourceDir}`)
    // 源目录只做文件复制，不用 SQLite 打开它（只读打开 WAL 库也会在源目录创建/改动 -shm）；合成指纹与基线在**副本**上核对
    for (const [code, name] of Object.entries(INDUSTRY_DB)) if (fs.existsSync(path.join(synthSourceDir, name))) synthCodes.push(code)
    if (!synthCodes.length) throw usage('DRILL_BACKUP_EMPTY', `--synth-dir 里没有 gml_*.db：${synthSourceDir}`)
    report.input = { mode: 'synth-dir', dir: synthSourceDir, industries: synthCodes }
  } else {
    set = loadBackupSet(args['backup-dir'], args.stamp || null)
    for (const e of set.entries) {
      const m = materializeEntry(e)
      try {
        const marker = runtimeMarkerOf(m.file)
        if (marker !== 'production') throw usage('DRILL_BACKUP_NOT_PRODUCTION', `备份 ${path.basename(e.file)} 的运行模式标记为 ${marker ?? '缺失'}，演练只接受 production 库`)
        assertBaseline(inspectDb(m.file), path.basename(e.file), from, steps)
      } finally {
        m.cleanup()
      }
    }
    report.input = { mode: 'backup-dir', dir: set.dir, report: path.basename(set.reportFile), stamp: set.stamp, generated_at: set.report.generated_at ?? null, age_seconds: backupAgeSeconds(set.report), data_dir: set.report.data_dir ?? null, industries: set.entries.map((e) => e.code) }
  }

  // ---- 目标目录判据（空目录、不是线上目录、不与备份/来源重叠）----
  targetPreexisted = typeof targetArg === 'string' && fs.existsSync(targetArg)
  target = prepareTargetDir(targetArg, { backupDir: set ? set.dir : synthSourceDir, sourceDataDir: set ? set.report.data_dir : synthSourceDir })
  report.target_dir = target
  const workDir = path.join(target, 'work')
  fs.mkdirSync(workDir, { mode: 0o700 })
  const stageRoot = path.join(target, 'stage')
  fs.mkdirSync(stageRoot, { mode: 0o700 })
  cleanup.push(stageRoot)

  // ---- 合成库：复制 → db-backup 成备份集（之后与真实备份集同一路径）----
  if (synthSourceDir) {
    const tb = performance.now()
    const copyDir = path.join(target, 'synth-source')
    fs.mkdirSync(copyDir, { mode: 0o700 })
    for (const code of synthCodes) {
      const name = INDUSTRY_DB[code]
      fs.copyFileSync(path.join(synthSourceDir, name), path.join(copyDir, name), fs.constants.COPYFILE_EXCL)
      if (fs.existsSync(path.join(synthSourceDir, `${name}-wal`))) fs.copyFileSync(path.join(synthSourceDir, `${name}-wal`), path.join(copyDir, `${name}-wal`), fs.constants.COPYFILE_EXCL)
    }
    for (const code of synthCodes) {
      const name = INDUSTRY_DB[code]
      const copy = path.join(copyDir, name)
      let info
      try { info = inspectDb(copy) } catch (e) { throw usage('REHEARSAL_SOURCE_NOT_SYNTHETIC', `${name} 无法只读打开：${e.message}`) }
      if (!info.synthetic) throw usage('REHEARSAL_SOURCE_NOT_SYNTHETIC', `${name} 没有合成指纹（org ${SYNTH_ORG}）；--synth-dir 只接受 synth-data.mjs 生成的库，真实库请先备份再用 --backup-dir`)
      const marker = runtimeMarkerOf(copy)
      if (marker !== 'production') throw usage('DRILL_BACKUP_NOT_PRODUCTION', `${name} 的运行模式标记为 ${marker ?? '缺失'}，只接受 production 库`)
      assertBaseline(info, name, from, steps)
    }
    // db-backup.mjs 读副本 settings 里的 backup_dir / backup_keep：绝对路径会让备份（以及按 keep 裁剪旧备份）落到副本之外。
    // 只在**副本**里删掉这两个键，使备份目录退回 <副本>/backups，并断言解析结果确实在副本内。
    for (const code of synthCodes) {
      const copy = path.join(copyDir, INDUSTRY_DB[code])
      const sdb = new Database(copy, { fileMustExist: true })
      try {
        sdb.prepare("DELETE FROM settings WHERE key IN ('backup_dir','backup_keep')").run()
        sdb.pragma('wal_checkpoint(TRUNCATE)')
      } finally {
        sdb.close()
      }
    }
    if (resolveBackupDir(null, copyDir) !== path.join(copyDir, 'backups')) throw new DrillError('REHEARSAL_BACKUP_DIR_ESCAPE', '合成库副本的备份目录没有解析到副本之内')
    for (const code of synthCodes) {
      const b = spawnSync(process.execPath, ['scripts/db-backup.mjs', code], { cwd: ROOT, env: childEnv(copyDir), encoding: 'utf8', timeout: 1800000 })
      if (b.status !== 0) throw new DrillError('REHEARSAL_SYNTH_BACKUP_FAILED', `合成库备份失败（${code}，exit ${b.status}）：${((b.stdout || '') + (b.stderr || '')).slice(-600)}`)
    }
    const synthBackupDir = path.join(copyDir, 'backups')
    set = loadBackupSet(synthBackupDir, null)
    report.input.synth_backup = { dir: synthBackupDir, stamp: set.stamp, ms: since(tb), note: '合成库副本经 scripts/db-backup.mjs 备份后作为备份集（演练源），与真实备份集同一路径' }
    report.timing.synth_backup_ms = since(tb)
  }

  // ---- 恢复工作副本 ----
  const tr = performance.now()
  try {
    report.restored = verifyAndRestore(set, workDir)
  } catch (e) {
    if (e.restored) report.restored = e.restored
    throw e
  }
  report.timing.restore_ms = since(tr)
  // 恢复成功之后的任何异常（不只是某个库的核对失败）都必须走回退：ctx 先建好，供外层 catch 使用
  const ctx = { from, steps, baselineFiles, workDir, stageRoot, target, keepIndexes: !!args['keep-post-baseline-indexes'], postBaselineIndexes: new Set(), pre: new Map() }
  rollbackCtx = { set, ctx }

  // ---- 仓库里"编号 > N 的迁移创建的索引"（A = 基线索引集，B = 全部）----
  const ti = performance.now()
  const idxBase = indexSetFor(stageRoot, 'idx-base', baselineFiles)
  // 追加迁移（可能是必败的候选）不参与：它们的产物不会出现在副本里，也不该因为候选写坏了就让演练在开始前就崩
  const idxFull = indexSetFor(stageRoot, 'idx-full', allSteps.filter((s) => !s.extra))
  const postBaselineIndexes = new Set([...idxFull].filter((n) => !idxBase.has(n)))
  report.timing.index_diff_ms = since(ti)
  report.baseline.post_baseline_indexes = [...postBaselineIndexes].sort()

  // ---- 逐库演练 ----
  ctx.postBaselineIndexes = postBaselineIndexes
  const tu = performance.now()
  for (const r of report.restored) {
    const dbr = await rehearseDb(r, ctx)
    report.databases.push(dbr)
    for (const f of dbr.failures) report.failures.push(`[${dbr.code}] ${f}`)
    for (const w of dbr.warnings) report.warnings.push(`[${dbr.code}] ${w}`)
  }
  report.timing.upgrade_ms = since(tu)

  // ---- 失败 ⇒ 回退演练 ----
  if (report.failures.length) report.rollback = rollback(set, ctx, report.restored)
  report.passed = report.failures.length === 0
  exitCode = report.passed ? EXIT_OK : EXIT_FAILED
} catch (e) {
  report.failures.push(e instanceof DrillError ? e.message : `REHEARSAL_UNEXPECTED: ${e.message}`)
  exitCode = e instanceof DrillError ? e.exitCode : EXIT_FAILED
  if (rollbackCtx && !report.rollback && exitCode !== EXIT_USAGE) {
    try {
      report.rollback = rollback(rollbackCtx.set, rollbackCtx.ctx, report.restored)
    } catch (e2) {
      report.failures.push(`ROLLBACK_UNEXPECTED: ${e2.message}`)
    }
  }
} finally {
  for (const d of cleanup) fs.rmSync(d, { recursive: true, force: true })
  // 退出码 2 = 拒绝：演练开始前的拒绝不留任何文件（目标目录在判据通过时一定是空的，所以其内容全是本次创建的）
  if (exitCode === EXIT_USAGE && target) {
    try {
      if (targetPreexisted) for (const f of fs.readdirSync(target)) fs.rmSync(path.join(target, f), { recursive: true, force: true })
      else fs.rmSync(target, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
}
report.timing.total_ms = since(t0)
report.host.loadavg_end = os.loadavg().map(round1)

if (exitCode === EXIT_USAGE) {
  console.error(report.failures.join('\n'))
  process.exit(EXIT_USAGE)
}

const file = target ? writeReport(target, 'upgrade-rehearsal', report) : null
for (const d of report.databases) {
  console.log(`  [${d.code}] ${d.db_file} ${Math.round(d.size_bytes_before / 1048576)}MB → ${d.size_bytes_after != null ? Math.round(d.size_bytes_after / 1048576) : '-'}MB，删除登记行 ${d.registry_truncated.length}、删除索引 ${d.indexes_dropped.length}`)
  for (const s of d.steps) console.log(`    ${s.id.padEnd(34)} ${String(s.status).padEnd(6)} ${String(s.duration_ms).padStart(9)}ms (净 ${s.net_ms}ms)  写锁 ${s.lock?.max_busy_span_ms ?? '-'}–${s.lock?.max_blocked_ms ?? '-'}ms  结构原本存在=${s.structure_preexisting}`)
  for (const i of d.invariants) console.log(`    ${i.passed ? '✓' : '✗'} ${i.name} — ${i.detail}`)
}
if (report.rollback) console.log(`  回退：进程内 ${report.rollback.in_process.passed ? '通过' : '失败'}；回退演练 exit ${report.rollback.drill?.exit_code}（不变量 ${report.rollback.drill?.invariants ?? '-'}）`)
if (report.failures.length) console.log(`  失败：\n    ${report.failures.join('\n    ')}`)
console.log(`  耗时：恢复 ${report.timing.restore_ms ?? '-'}ms / 升级 ${report.timing.upgrade_ms ?? '-'}ms / 总 ${report.timing.total_ms}ms`)
if (file) console.log(`  报告：${file}`)
console.log(report.passed ? '升级演练通过' : '升级演练失败')
process.exit(exitCode)
