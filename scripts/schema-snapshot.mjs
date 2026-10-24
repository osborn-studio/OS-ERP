#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/schema-snapshot.mjs ｜ 旧结构备份集生成器：用 schema.sql + 迁移 ≤ N 在隔离目录建三个行业库（可灌合成数据）并经 db-backup.mjs 产出"版本 N 备份集"（roadmap-v7 AB5 / ADR-0048）
 * ============================================================================
 * 【职责】AA11 的升级演练只能把"最新结构"的库截断成旧版本表（表/列仍是新结构）。要演练**真正的旧库**，需要一份由旧结构产生的备份集。
 *   本脚本产出它，并让 `upgrade-rehearsal.mjs --from N --backup-dir <set>/data/backups` 无需截断：
 *   1. 在 `--out`（显式绝对路径、新建或空目录）里建暂存迁移目录：`_helpers` 与编号 ≤ N 的迁移文件**字节级复制**并逐个核对 sha256；
 *   2. cosmetic / food / apparel 三库各自：空库先写 production 分类标记（与线上同一函数）→ `schema.sql` → 真实运行器 `runMigrations(db, { migrationsDir: 暂存目录, mode: 'production' })`
 *      （校验和按暂存文件登记，origin=applied，与生产启动同一路径）→ 写入 SYNTHCO 指纹（orgs.code='SYNTHCO'）；
 *   3. 可选 `--synth=tiny|small|medium`：先用 `synth-data.mjs` 在**最新结构**的临时目录生成合成库（只在 `--out/synth-src`，随后删除），再把业务数据**拷进旧结构库**：
 *      · 迁移 >N 会改动内容的表（典型：permissions / role_permissions 的字典行）视为"迁移所有"，**不拷**，保持 ≤N 的内容——否则 062/063/066 的权限行会提前出现，演练就成了空转；
 *      · 其余表按**两边都有的列**拷（旧结构缺的列留空，新结构多出的列丢弃），关外键、`INSERT OR REPLACE`；之后逐表核对行数与源相同、`foreign_key_check` 必须为 0、
 *        synth-data 的 verify-seed 风格不变量必须全绿，否则整次失败。合成数据只进 cosmetic（synth-data 只产出 cosmetic）；food / apparel 只带结构与指纹。
 *   4. 三库在同一次 `scripts/db-backup.mjs`（子进程，生产模式，明文）里备份并校验；随后擦除在用的 .db，只留 `--out/data/backups`（备份集）与 `--out/snapshot-manifest.json`。
 *   · 校验和**不绕过**：库里登记的校验和就是运行器按暂存文件算出的；演练前的 PRE_UPGRADE_CHECKSUM_MISMATCH 判据照常对备份集生效（tests/schema-snapshot.test.mjs 有篡改用例）。
 * 【安全判据】`--out` 必须是显式绝对路径；不得位于仓库 data/ 内（穿过符号链接解析，含悬空链接）；不得等于或位于调用方 GML_DATA_DIR；必须不存在或是空目录且本身不是符号链接。
 *   违反 ⇒ 退出码 2，且不创建任何文件。子进程环境是白名单（不继承 GML_*、不带 GML_BACKUP_KEY，备份集明文，因为内容是合成/空库）。运行期失败 ⇒ 清掉本次在 `--out` 里创建的全部内容。
 * 【诚实边界】
 *   · "旧结构"只由仓库里的迁移文件与当前 schema.sql 决定：schema.sql 若在 N 之后被改过，快照反映的是**今天的 schema.sql + 迁移 ≤N**，不是历史上 N 版本当时的 schema.sql。
 *   · 业务数据由**今天的**领域函数写入，再拷进旧结构；只含两边都存在的列。它回答"在这个体量上 >N 的迁移要多久"，不回答"旧版本代码写出的历史数据长什么样"。
 *   · 合成数据不是客户数据，耗时是运行它的这台机器的单次墙钟。
 * 【用法】node scripts/schema-snapshot.mjs --upto=58 --out=/abs/new-dir [--synth=tiny|small|medium]
 *   （也接受 `--upto 58 --out /abs/new-dir`）。随后：`node scripts/upgrade-rehearsal.mjs --from=58 --backup-dir=/abs/new-dir/data/backups --target-dir=/abs/empty`
 *   规模：tiny＝synth-data 缺省（测试用）；small＝2000 SKU / 3000 单 / 15000 流水；medium＝20000 SKU / 30000 单 / 150000 流水（与夜间 capacity 工作流同一口径）。
 *   退出码：0 完成；1 运行失败（已清理）；2 参数/目录被拒绝（未创建任何文件）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { classifyEmptyDatabase } from '../server/db/runtime-policy.js'
import { ensureSettings } from '../server/lib/settings.js'
import { resolveBackupDir } from '../server/lib/backup-dir.js'
import { ROOT, INDUSTRY_DB, loadBackupSet, childEnv } from './lib/drill-common.mjs'
import { isWithin } from './lib/safe-path.mjs'

const SYNTH_ORG = 'SYNTHCO'
const FILE_RE = /^\d{3}_[A-Za-z0-9_.-]+\.cjs$/
const PROFILES = {
  none: null,
  tiny: [],
  small: ['--skus', '2000', '--docs', '3000', '--txns', '15000'],
  medium: ['--skus', '20000', '--docs', '30000', '--txns', '150000']
}
const INTERNAL_TABLES = new Set(['schema_migrations', 'os_egp_runtime', 'sqlite_sequence'])
const usage = (message) => Object.assign(new Error(message), { exitCode: 2 })
const sha256Of = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const round1 = (n) => Math.round(n * 10) / 10
const q = (name) => `"${String(name).replace(/"/g, '""')}"`
const tail = (r) => ((r.stdout || '') + (r.stderr || '')).slice(-600)

/** `--k=v` 与 `--k v` 两种写法；未知参数、位置参数一律拒绝。 */
function parseArgs(argv) {
  const known = new Set(['upto', 'out', 'synth'])
  const o = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) throw usage(`不支持的位置参数：${a}`)
    const eq = a.indexOf('=')
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq)
    if (!known.has(key)) throw usage(`未知参数：--${key}（可用：--upto、--out、--synth）`)
    let value
    if (eq !== -1) value = a.slice(eq + 1)
    else { value = argv[++i]; if (value === undefined || value.startsWith('--')) throw usage(`参数 --${key} 缺值`) }
    if (Object.hasOwn(o, key)) throw usage(`参数 --${key} 重复`)
    o[key] = value
  }
  return o
}

/** 仓库迁移文件 ≤ N，且 N 必须恰是一个现有迁移编号（保证快照版本表的最高编号 = N）。 */
function resolveUpto(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) throw usage('--upto 必须是迁移编号（如 58 或 058）')
  const n = Number(raw)
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => FILE_RE.test(f)).sort()
  if (!files.some((f) => Number(f.slice(0, 3)) === n)) throw usage(`--upto=${raw} 不是现有迁移编号（仓库最高 ${files.at(-1).slice(0, 3)}；编号有空号，如 044/051/054/064）`)
  return { n, files }
}

/** `--out` 判据：全部在创建任何文件之前判定。 */
function checkOut(outArg) {
  if (typeof outArg !== 'string' || !path.isAbsolute(outArg)) throw usage('--out 必须是显式绝对路径')
  const out = path.resolve(outArg)
  if (isWithin(path.resolve(ROOT, 'data'), out)) throw usage('--out 位于仓库 data/ 之内（含经符号链接），拒绝')
  const dataEnv = process.env.GML_DATA_DIR
  if (dataEnv && path.isAbsolute(dataEnv) && isWithin(path.resolve(dataEnv), out)) throw usage('--out 等于或位于调用方的 GML_DATA_DIR（可能是在用实例），拒绝')
  let st = null
  try { st = fs.lstatSync(out) } catch { /* 不存在 */ }
  if (st) {
    if (st.isSymbolicLink()) throw usage('--out 本身是符号链接，拒绝')
    if (!st.isDirectory()) throw usage('--out 已存在且不是目录')
    if (fs.readdirSync(out).length) throw usage(`--out 非空（${out}）：只在新建/空目录里生成，不覆盖任何已有文件`)
  }
  return { out, existed: !!st }
}

/** 暂存迁移目录：_helpers 与编号 ≤ upto（或全部）的迁移文件，字节级复制并逐个核对。 */
function makeStage(dir, files) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const copy = (f) => {
    const src = path.join(MIGRATIONS_DIR, f)
    const dest = path.join(dir, f)
    fs.copyFileSync(src, dest)
    if (sha256Of(src) !== sha256Of(dest)) throw new Error(`暂存的 ${f} 与源文件不一致`)
  }
  for (const f of fs.readdirSync(MIGRATIONS_DIR).filter((x) => /^_.*\.cjs$/.test(x))) copy(f)
  for (const f of files) copy(f)
}

function openNew(file) {
  const db = new Database(file)
  classifyEmptyDatabase(db, 'production')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
  return db
}

function addFingerprint(db) {
  db.prepare('INSERT OR IGNORE INTO orgs (code, name, type, level, is_legal) VALUES (?,?,?,?,1)').run(SYNTH_ORG, 'Synthetic Co', 'group', 1)
}

const userTables = (db, schema = 'main') => db.prepare(`SELECT name, sql FROM ${schema}.sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()
const columnsOf = (db, table, schema = 'main') => db.prepare(`PRAGMA ${schema}.table_xinfo(${q(table)})`).all().filter((c) => !c.hidden).map((c) => c.name)
const tableSignature = (db, table, cols) => {
  const rows = db.prepare(`SELECT ${cols.map(q).join(',')} FROM ${q(table)}`).all().map((r) => JSON.stringify(cols.map((c) => r[c]))).sort()
  return createHash('sha256').update(rows.join('\n')).digest('hex')
}

/** 迁移 >N 会改动内容的表：把旧结构库克隆（VACUUM INTO 到暂存目录的临时文件），跑完全部仓库迁移，比较每张旧表在旧列上的行内容。 */
function migrationOwnedTables(db, allStage, cloneFile) {
  db.exec(`VACUUM INTO '${cloneFile.replace(/'/g, "''")}'`)
  const clone = new Database(cloneFile)
  try {
    runMigrations(clone, { migrationsDir: allStage, mode: 'production', warn: () => {} })
    const owned = []
    for (const { name } of userTables(db)) {
      if (INTERNAL_TABLES.has(name)) continue
      if (!clone.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) continue
      const cols = columnsOf(db, name)
      if (tableSignature(db, name, cols) !== tableSignature(clone, name, cols)) owned.push(name)
    }
    return owned
  } finally {
    clone.close()
    fs.rmSync(cloneFile, { force: true })
  }
}

/** 把合成库（最新结构）的业务数据拷进旧结构库。 */
function loadSynth(db, synthFile, owned) {
  const report = { owned_tables_skipped: [...owned].sort(), tables_copied: 0, rows_copied: 0, table_rows: {}, foreign_key_violations: null, invariants_failed: [], invariants_total: null }
  db.pragma('foreign_keys = OFF')
  db.exec(`ATTACH DATABASE '${synthFile.replace(/'/g, "''")}' AS s`)
  try {
    db.exec('BEGIN')
    for (const { name } of userTables(db)) {
      if (INTERNAL_TABLES.has(name) || owned.includes(name)) continue
      if (!db.prepare("SELECT 1 FROM s.sqlite_master WHERE type='table' AND name=?").get(name)) continue
      const have = new Set(columnsOf(db, name, 's'))
      const cols = columnsOf(db, name).filter((c) => have.has(c))
      if (!cols.length) continue
      const list = cols.map(q).join(',')
      db.exec(`INSERT OR REPLACE INTO main.${q(name)} (${list}) SELECT ${list} FROM s.${q(name)}`)
      const want = db.prepare(`SELECT COUNT(*) c FROM s.${q(name)}`).get().c
      const got = db.prepare(`SELECT COUNT(*) c FROM main.${q(name)}`).get().c
      if (got !== want) throw new Error(`合成数据拷贝后表 ${name} 行数 ${got} 与源 ${want} 不一致`)
      report.tables_copied += 1
      report.rows_copied += want
      if (want) report.table_rows[name] = want
    }
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch { /* ignore */ }
    throw e
  } finally {
    db.exec('DETACH DATABASE s')
    db.pragma('foreign_keys = ON')
  }
  report.foreign_key_violations = db.pragma('foreign_key_check').length
  return report
}

const t0 = performance.now()
const phases = {}
const phase = async (name, fn) => { const t = performance.now(); try { return await fn() } finally { phases[name] = Math.round(performance.now() - t) } }
let out = null
let outExisted = true
let exitCode = 1

try {
  const args = parseArgs(process.argv.slice(2))
  if (args.upto === undefined || args.out === undefined) throw usage('必须给出 --upto=<迁移编号> 与 --out=<绝对路径>')
  const synthName = args.synth ?? 'none'
  if (!Object.hasOwn(PROFILES, synthName)) throw usage(`未知 --synth=${synthName}（可选：${Object.keys(PROFILES).join(' / ')}）`)
  const { n: upto, files } = resolveUpto(args.upto)
  const chk = checkOut(args.out)
  out = chk.out
  outExisted = chk.existed
  fs.mkdirSync(out, { recursive: true, mode: 0o700 })
  const uptoFiles = files.filter((f) => Number(f.slice(0, 3)) <= upto)
  const dataDir = path.join(out, 'data')
  const stage = path.join(out, 'stage')
  fs.mkdirSync(dataDir, { mode: 0o700 })
  makeStage(path.join(stage, 'upto'), uptoFiles)
  makeStage(path.join(stage, 'all'), files)

  // ---- 三库：schema.sql + 迁移 ≤ N ----
  const codes = Object.keys(INDUSTRY_DB)
  const built = {}
  await phase('build_ms', () => {
    for (const code of codes) {
      const file = path.join(dataDir, INDUSTRY_DB[code])
      const db = openNew(file)
      try {
        const warnings = []
        runMigrations(db, { migrationsDir: path.join(stage, 'upto'), mode: 'production', warn: (m) => warnings.push(m) })
        if (warnings.length) throw new Error(`迁移运行器告警：${warnings[0]}`)
        ensureSettings(db)
        addFingerprint(db)
        const reg = db.prepare('SELECT id, checksum, checksum_origin FROM schema_migrations ORDER BY id').all()
        const want = uptoFiles.map((f) => f.replace(/\.cjs$/, ''))
        if (JSON.stringify(reg.map((r) => r.id)) !== JSON.stringify(want)) throw new Error(`${code} 版本表与编号 ≤ ${upto} 的仓库迁移不一致`)
        for (const r of reg) if (r.checksum !== sha256Of(path.join(MIGRATIONS_DIR, `${r.id}.cjs`)) || r.checksum_origin !== 'applied') throw new Error(`${code} ${r.id} 的登记校验和与仓库文件不一致`)
        built[code] = { file, registry_rows: reg.length }
      } finally {
        db.close()
      }
    }
  })

  // ---- 可选：合成数据（最新结构里生成，再拷进旧结构）----
  let synthLoad = null
  if (PROFILES[synthName] !== null) {
    const srcDir = path.join(out, 'synth-src')
    await phase('synth_generate_ms', () => {
      const r = spawnSync(process.execPath, ['scripts/synth-data.mjs', '--no-verify', '--quiet', ...PROFILES[synthName]], { cwd: ROOT, env: childEnv(srcDir), encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 })
      if (r.status !== 0) throw new Error(`合成库生成失败（exit ${r.status}）：${tail(r)}`)
    })
    const synthFile = path.join(srcDir, INDUSTRY_DB.cosmetic)
    if (!fs.existsSync(synthFile)) throw new Error('合成库生成后没有 gml_cosmetic.db')
    await phase('synth_load_ms', async () => {
      const db = new Database(built.cosmetic.file)
      try {
        db.pragma('journal_mode = WAL')
        const owned = migrationOwnedTables(db, path.join(stage, 'all'), path.join(stage, 'clone.db'))
        synthLoad = loadSynth(db, synthFile, owned)
        const { verifyInvariants } = await import('./synth-data.mjs')
        const inv = await verifyInvariants(db)
        synthLoad.invariants_total = inv.checks.length
        synthLoad.invariants_failed = inv.checks.filter((c) => !c.ok).map((c) => c.name)
        if (synthLoad.foreign_key_violations) throw new Error(`合成数据拷进旧结构后外键违规 ${synthLoad.foreign_key_violations} 条`)
        if (synthLoad.invariants_failed.length) throw new Error(`合成数据拷进旧结构后不变量失败：${synthLoad.invariants_failed.join(', ')}`)
        // 合成库副本的 settings 可能带别的 backup_dir：改回迁移 020 的缺省值，备份只落在 --out 内（与 upgrade-rehearsal 同一做法）
        db.prepare("INSERT INTO settings (key, value) VALUES ('backup_dir', 'data/backups') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
        db.prepare("INSERT INTO settings (key, value) VALUES ('backup_keep', '10') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run()
        db.pragma('wal_checkpoint(TRUNCATE)')
      } finally {
        db.close()
      }
    })
    fs.rmSync(srcDir, { recursive: true, force: true })
  }

  // ---- 备份目录必须解析到 --out 之内，再备份 ----
  const backupDir = resolveBackupDir(null, dataDir)
  if (backupDir !== path.join(dataDir, 'backups') || !isWithin(out, backupDir)) throw new Error('备份目录没有解析到 --out 之内')
  await phase('backup_ms', () => {
    const r = spawnSync(process.execPath, ['scripts/db-backup.mjs'], { cwd: ROOT, env: childEnv(dataDir), encoding: 'utf8', timeout: 3600000, maxBuffer: 64 * 1024 * 1024 })
    if (r.status !== 0) throw new Error(`db-backup 失败（exit ${r.status}）：${tail(r)}`)
  })
  const set = loadBackupSet(backupDir, null)
  if (JSON.stringify(set.entries.map((e) => e.code).sort()) !== JSON.stringify([...codes].sort())) throw new Error(`备份集的行业 [${set.entries.map((e) => e.code)}] 不完整`)
  for (const e of set.entries) {
    if (sha256Of(e.file) !== e.sha256) throw new Error(`备份 ${path.basename(e.file)} 的 sha256 与报告不一致`)
    if (e.encrypted) throw new Error('备份集不应加密（子进程环境不含 GML_BACKUP_KEY）')
  }

  // ---- 擦除在用库，只留备份集 + 清单 ----
  for (const code of codes) for (const suffix of ['', '-wal', '-shm']) fs.rmSync(`${built[code].file}${suffix}`, { force: true })
  fs.rmSync(stage, { recursive: true, force: true })
  const manifest = {
    script: 'scripts/schema-snapshot.mjs',
    schema_version: 1,
    generated_at: new Date().toISOString(),
    upto,
    registry_max: upto,
    registry_rows: uptoFiles.length,
    migrations: uptoFiles.map((f) => f.replace(/\.cjs$/, '')),
    industries: codes,
    fingerprint: { orgs_code: SYNTH_ORG, all_databases: true },
    synth: synthName,
    synth_load: synthLoad,
    backup_dir: backupDir,
    backup_stamp: set.stamp,
    backups: set.entries.map((e) => ({ code: e.code, file: path.basename(e.file), sha256: e.sha256, size: e.size })),
    rehearsal_hint: `node scripts/upgrade-rehearsal.mjs --from=${upto} --backup-dir=${backupDir} --target-dir=<空目录>`,
    host: { node: process.version, platform: process.platform, arch: process.arch },
    timing: { ...phases, total_ms: Math.round(performance.now() - t0) },
    scope_notice: '合成/空库。结构 = 今天的 schema.sql + 迁移 ≤ upto；业务数据由今天的领域函数写入后拷入。不是客户数据，不是目标主机（dmserver）结果。'
  }
  fs.writeFileSync(path.join(out, 'snapshot-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 })
  console.log(`  快照：版本 ${upto}（版本表 ${uptoFiles.length} 行）× ${codes.length} 库，合成数据 ${synthName}${synthLoad ? `（拷入 ${synthLoad.rows_copied} 行 / ${synthLoad.tables_copied} 张表，跳过迁移所有的表 ${synthLoad.owned_tables_skipped.join('、') || '无'}）` : ''}`)
  console.log(`  备份集：${backupDir}（stamp ${set.stamp}）`)
  console.log(`  耗时：${Object.entries(phases).map(([k, v]) => `${k.replace(/_ms$/, '')} ${round1(v / 1000)}s`).join(' / ')}`)
  console.log('快照完成')
  exitCode = 0
} catch (e) {
  exitCode = e.exitCode ?? 1
  console.error(exitCode === 2 ? e.message : `schema-snapshot: ${e.message}`)
  if (exitCode !== 2 && !e.exitCode) console.error(e.stack)
  // 本次在 --out 里创建的全部内容都是新建的（判据保证它开始时为空）：失败即清空，不留半成品
  if (out) {
    try {
      if (outExisted) for (const f of fs.readdirSync(out)) fs.rmSync(path.join(out, f), { recursive: true, force: true })
      else fs.rmSync(out, { recursive: true, force: true })
    } catch { /* best effort */ }
  }
}
process.exit(exitCode)
