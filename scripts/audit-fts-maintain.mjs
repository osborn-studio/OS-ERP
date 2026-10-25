#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-fts-maintain.mjs ｜ 审计日志 FTS5 索引维护：optimize / 分批 rebuild + resume / integrity-check，报告持写锁时间（roadmap-v8 AC5，roadmap-v13 AH4）
 * ============================================================================
 * 【职责】迁移 067 的 `audit_logs_fts`（FTS5 外部内容表，trigram）是影子索引：触发器漏维护（裸 SQL 写入、触发器被删）、
 *   崩溃或升级后可能与 `audit_logs` 不一致。本脚本提供三个运维动作，都在**一个显式写事务**里完成，并用 `scripts/lib/lock-probe.mjs`
 *   （另一个线程、自己的连接，反复 `BEGIN IMMEDIATE`）量出"别的写入者被挡住多久"：
 *   · `--integrity-check`：FTS5 `integrity-check`（rank=1，同时与 audit_logs 内容表对账）。不一致 → status=corrupt，退出 1；表不存在 → status=absent，退出 0（无 FTS5 的构建上本来就没有）。
 *   · `--optimize`：合并索引段（`optimize`），不改变内容。
 *   · `--rebuild`（AH4 起分批）：先在一个事务里 `delete-all` 清空索引并建检查点表 `audit_fts_rebuild_state`，再按 id 升序**每批一个 `BEGIN IMMEDIATE` 事务**回填（`--batch-rows`，默认 5000），
 *     批与批之间释放写锁（`--pause-ms`，默认 5）让业务写入进来；每批打印一行进度；最后一批与"删检查点"同一事务。收到 SIGTERM / SIGINT 只在批边界停止（退出 3，status=interrupted），
 *     检查点留在库里；`--resume` 从检查点续跑。检查点存在 = 索引未完成：查询路径（`audit-view.js` 的 `ftsAvailable`）不用它，`--integrity-check` / `--optimize` 报 `rebuild_in_progress`。
 *     `--rebuild` 遇到已有检查点拒绝（`checkpoint_exists`），`--rebuild --restart` 丢弃它从头来；`--resume` 无检查点（`no_checkpoint`）或检查点属于别的库（`checkpoint_mismatch`：行业或指纹不符）拒绝。
 *     重建期间被删除的"尚未入索引"的行会让触发器对索引发出无效 delete：续跑到末尾若剩余行数对不上 → `interfered`（检查点保留，索引仍不被查询使用），用 `--rebuild --restart` 修复。
 *     触发器缺失时分批会漏掉高水位之后的新行：初始化事务在写锁内补齐触发器并做一次完整 `rebuild`（报告 `repaired_triggers`）；批间触发器被删 → `triggers_missing`。设计与边界见 ADR-0054 补充 4。
 *   `optimize` / `rebuild` 在表不存在时退出 1（没有东西可维护；建表是迁移 067 的事，不在这里）。
 *
 * 【AD4 开关】`--disable` / `--enable`（必须带 `--reason`）：在**同一个写事务**里改设置 `audit_fts_enabled`（危险键，留痕到 setting_audit_log）并删除 / 重建 FTS 表与触发器
 *   （重建 = 迁移 067 的 up：建表、触发器、回填存量行，大库上持写锁到结束）。幂等；构建不支持 FTS5 时 `--enable` 报 status=unsupported、退出 1 且设置不改。ADR-0054。
 * 【用法】node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--resume|--integrity-check|--disable|--enable) [--reason <理由>] [--out <报告.json>] [--busy-ms <n>] [--batch-rows <n>] [--pause-ms <n>] [--restart]
 *   · `--batch-rows`（1..1000000，默认 5000；`--resume` 缺省沿用检查点里的值）、`--pause-ms`（0..60000，默认 5）只用于 `--rebuild` / `--resume`；`--restart` 只用于 `--rebuild`。
 *   · 必须显式 `--data-dir`（走 `requireExplicitDataDir()`，拒绝仓库 data/，symlink 也认）与 `--industry`；环境里的 `GML_DB` 被忽略。
 *   · 报告（JSON，0600）默认写到 `<data-dir>/audit-fts-maintain-<行业>-<动作>-<时间戳>.json`；`--out` 必须是绝对路径，物理位置（解开符号链接，含尚不存在的子目录）在仓库 data/ 之外，不能是库文件或其 -wal / -shm / -journal，且不覆盖已有文件（退出 2）。行业库文件本身是符号链接则拒绝（退出 2）。报告不含绝对路径。
 *   · 退出码：0 成功；1 操作失败（corrupt / busy / absent+写操作 / 检查点拒绝 / 其它错误）；2 参数 / 环境错误；3 分批重建在批边界被信号中断（可 `--resume`）。
 *   · `--busy-ms`（默认 5000，0..300000）：等写锁的上限；拿不到则 status=busy、退出 1，索引不被改动（事务未开始）。
 *
 * 【AF4 并发】两个维护动作（或维护脚本与启动自愈）重叠时：都用 `BEGIN IMMEDIATE` 取写锁（BUSY / BUSY_SNAPSHOT 有上限地重试，总等待不超过 `--busy-ms`），
 *   拿到锁后**重读**设置与对象（`--busy-ms` 是「取写锁」阶段的总预算，重试的退避不超出它；提交阶段另算一份同样的预算）；状态已与目标一致 → 什么都不做（报告 `already_in_state: true`、`changed_objects`/`setting_changed` 为 false，退出 0）。
 *   测试暂停点 `GML_TEST_FTS_MAINTAIN_PAUSE=<目录>`（仅 `GML_RUNTIME_MODE=test`）在"已读状态、未开事务"处暂停，见 `server/lib/test-pause.js`。
 *
 * 【诚实边界】持锁探针是**写入者**视角（WAL 下读者不被挡）；`max_blocked_ms` 近似上界、`max_busy_span_ms` 下界，见 lock-probe.mjs。
 *   `elapsed_ms` 是本进程从 BEGIN 到 COMMIT 的墙钟，是持写锁时间的粗上界。脚本不创建缺失的库、不跑迁移、不碰 `GML_AUDIT_FTS` 开关
 *   （该开关只影响查询路径，不影响本脚本；维护索引与是否使用索引是两件事）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import crypto from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'
import { startLockProbe } from './lib/lock-probe.mjs'
import { ensureSettings, writeSetting } from '../server/lib/settings.js'
import { testPause } from '../server/lib/test-pause.js'
import { REBUILD_STATE_TABLE as STATE, REBUILD_STATE_DDL, rebuildInProgress } from '../server/lib/audit-fts-state.js'

const m071 = createRequire(import.meta.url)('../server/db/migrations/071_audit_fts_optional.cjs')
const m067 = createRequire(import.meta.url)('../server/db/migrations/067_audit_fts.cjs')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const FTS = 'audit_logs_fts'
const TRIGGERS = ['audit_logs_fts_ai', 'audit_logs_fts_ad', 'audit_logs_fts_au']
const MODES = ['optimize', 'rebuild', 'resume', 'integrity-check', 'disable', 'enable']
const BATCHED = ['rebuild', 'resume'] // AH4：分批重建与续跑
const TOGGLES = ['disable', 'enable'] // AD4：同事务改设置 audit_fts_enabled 并删除/重建 FTS 表与触发器
const SQL_REBUILD = `INSERT INTO ${FTS}(${FTS}) VALUES ('rebuild')`
const SQL = {
  optimize: `INSERT INTO ${FTS}(${FTS}) VALUES ('optimize')`,
  'integrity-check': `INSERT INTO ${FTS}(${FTS}, rank) VALUES ('integrity-check', 1)`
}
/** 物理路径（解开符号链接）。路径不存在时：解析最近的已存在祖先，再接上缺失的尾部，所以"符号链接 + 尚不存在的子目录"也认得出来 */
function canonical(p, depth = 0) {
  if (depth > 32) throw Object.assign(new Error('符号链接层数过多'), { code: 'ELOOP' })
  let cur = path.resolve(p)
  const tail = []
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...tail.reverse()) } catch (e) {
      if (e.code === 'EACCES') throw e
      let target = null
      try { target = fs.readlinkSync(cur) } catch { /* 不是（悬空的）符号链接 */ }
      if (target !== null) return canonical(path.join(path.resolve(path.dirname(cur), target), ...tail.reverse()), depth + 1) // 悬空链接：跟着目标走
      const up = path.dirname(cur)
      if (up === cur) throw e
      tail.push(path.basename(cur))
      cur = up
    }
  }
}
const within = (dir, p) => p === dir || p.startsWith(dir + path.sep)

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--out', '--busy-ms', '--reason', '--batch-rows', '--pause-ms'], flags: [...MODES.map((m) => `--${m}`), '--restart'] })
const chosen = MODES.filter((m) => args[m])
if (chosen.length !== 1) die('USAGE', '用法：audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> (--optimize|--rebuild|--resume|--integrity-check|--disable|--enable) [--reason <理由>] [--out <报告.json>] [--busy-ms <n>] [--batch-rows <n>] [--pause-ms <n>] [--restart]（动作必须且只能选一个；--disable/--enable 必须带 --reason）')
const action = chosen[0]
if (TOGGLES.includes(action) && !String(args.reason || '').trim()) die('USAGE', `--${action} 改的是危险设置 audit_fts_enabled，必须带 --reason <理由>`)
if (args.restart && action !== 'rebuild') die('USAGE', '--restart 只用于 --rebuild（丢弃已有检查点从头重建）')
if (!BATCHED.includes(action) && (args['batch-rows'] !== undefined || args['pause-ms'] !== undefined)) die('USAGE', '--batch-rows / --pause-ms 只用于 --rebuild / --resume')
let batchRows = null // null = 沿用检查点（--resume）或默认值（--rebuild）
if (args['batch-rows'] !== undefined) {
  if (!/^\d+$/.test(args['batch-rows']) || Number(args['batch-rows']) < 1 || Number(args['batch-rows']) > 1000000) die('USAGE', '--batch-rows 必须是 1..1000000 的整数')
  batchRows = Number(args['batch-rows'])
}
let pauseMs = 5
if (args['pause-ms'] !== undefined) {
  if (!/^\d+$/.test(args['pause-ms']) || Number(args['pause-ms']) > 60000) die('USAGE', '--pause-ms 必须是 0..60000 的整数毫秒')
  pauseMs = Number(args['pause-ms'])
}
if (!args['data-dir']) die('USAGE', '--data-dir <绝对路径> 必填')
if (!args.industry) die('USAGE', '--industry <行业> 必填')
let busyMs = 5000
if (args['busy-ms'] !== undefined) {
  if (!/^\d+$/.test(args['busy-ms']) || Number(args['busy-ms']) > 300000) die('USAGE', '--busy-ms 必须是 0..300000 的整数毫秒')
  busyMs = Number(args['busy-ms'])
}
// 环境里的 GML_DB 会让 dbPathFor() 绕过显式数据目录：本脚本只认 --data-dir
delete process.env.GML_DB
const { targets } = await locateDatabases(args)
if (!targets.length) die('DB_ABSENT', `行业库 ${args.industry} 在 --data-dir 下不存在（本脚本不创建库）`)
const file = targets[0].file

// 库文件本身不许是符号链接（它可能指回仓库 data/）；在打开任何连接之前拒绝
if (fs.lstatSync(file).isSymbolicLink()) die('DB_IS_SYMLINK', '行业库文件是符号链接；请把真实库复制到隔离目录后再维护')
const repoData = canonical(path.join(ROOT, 'data'))
if (within(repoData, canonical(file))) die('DATA_DIRECTORY_IS_REPOSITORY', '行业库的物理路径在仓库 data/ 下')

const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')
if (args.out && !path.isAbsolute(args.out)) die('USAGE', '--out 必须是绝对路径')
const outFile = args.out ? path.resolve(args.out) : path.join(path.dirname(file), `audit-fts-maintain-${args.industry}-${action}-${stamp}.json`)
{
  const outReal = canonical(outFile)
  if (within(repoData, outReal)) die('DATA_DIRECTORY_IS_REPOSITORY', '--out 不能写进仓库 data/（含经符号链接）')
  const dbReal = canonical(file)
  if ([dbReal, `${dbReal}-wal`, `${dbReal}-shm`, `${dbReal}-journal`].includes(outReal)) die('OUT_IS_DATABASE', '--out 不能是库文件或它的 -wal / -shm / -journal')
  if (fs.existsSync(outFile)) die('OUT_EXISTS', '--out 已存在；本脚本不覆盖已有文件')
}

const exists = (db, type, name) => !!db.prepare('SELECT 1 FROM sqlite_master WHERE type=? AND name=?').get(type, name)
const sizeOf = (f) => ['', '-wal'].reduce((n, s) => { try { return n + fs.statSync(f + s).size } catch { return n } }, 0)
const isBusy = (e) => e && (/^SQLITE_(BUSY|LOCKED)/.test(String(e.code)) || /database is locked/.test(String(e.message)))
const DEFAULT_BATCH_ROWS = 5000
const MAX_ATTEMPTS = 5 // AF4：取写锁 / 事务内遇 BUSY 的总尝试次数上限（同时受 --busy-ms 总预算约束）

const readStoredSetting = (db) => db.prepare("SELECT value FROM settings WHERE key='audit_fts_enabled'").get()?.value ?? null
const report = {
  schema_version: 1, action, industry: args.industry, data_file: path.basename(file), started_at: new Date().toISOString(),
  ok: false, status: 'error', error: null, already_in_state: false, rows: null, rows_indexed: 0, batches: 0, batch_rows: null, resumed: false, signal: null, max_batch_ms: null, fts_present: null, triggers_present: null, busy_timeout_ms: busyMs,
  bytes_before: sizeOf(file), bytes_after: null, elapsed_ms: null, lock_probe: null
}

let db
let probe

/** AH4：写事务 helper——`BEGIN IMMEDIATE` + 有上限的 BUSY 重试（总等待不超过 --busy-ms）；fn 必须可重放（失败整体回滚） */
async function writeTx(fn) {
  const deadline = Date.now() + busyMs
  for (let attempt = 1; ; attempt++) {
    db.pragma(`busy_timeout = ${Math.max(0, deadline - Date.now())}`)
    try {
      db.exec('BEGIN IMMEDIATE')
    } catch (e) {
      if (isBusy(e) && attempt < MAX_ATTEMPTS && Date.now() < deadline) { await delay(Math.min(25 * 2 ** (attempt - 1), 200, Math.max(0, deadline - Date.now()))); continue }
      throw e
    }
    try {
      const r = fn()
      db.pragma(`busy_timeout = ${busyMs}`)
      db.exec('COMMIT')
      return r
    } catch (e) {
      try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ }
      if (isBusy(e) && attempt < MAX_ATTEMPTS && Date.now() < deadline) { await delay(Math.min(25 * 2 ** (attempt - 1), 200, Math.max(0, deadline - Date.now()))); continue }
      throw e
    }
  }
}

/** 检查点指纹：高水位及其之前最近 5 行的内容摘要。不同的库（行业、内容）算出不同的值；老行被归档删除不影响它（取的是高水位一侧） */
function fingerprintOf(hw) {
  const rows = db.prepare('SELECT id, action, entity, user_name, created_at FROM audit_logs WHERE id <= ? ORDER BY id DESC LIMIT 5').all(hw)
  return crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
}
/** 触发器缺失 → 在写锁内补齐（067 的 up：建缺失的触发器并一次性 rebuild）并删检查点；返回补齐的触发器名（无缺失返回 null）。调用方在 writeTx 里 */
function repairTriggers() {
  const missing = TRIGGERS.filter((n) => !exists(db, 'trigger', n))
  if (!missing.length) return null
  m067.up(db)
  if (rebuildInProgress(db)) db.exec(`DROP TABLE ${STATE}`)
  return missing
}
const stateRowOf = () => db.prepare(`SELECT * FROM ${STATE}`).get() ?? null
const nowIso = () => new Date().toISOString()

/**
 * AH4：分批重建 / 续跑。每批一个 BEGIN IMMEDIATE 事务；索引批间残缺，靠检查点表标记（查询路径不用它）。信号只置标志，批边界检查。
 * 状态：ok / interrupted（exit 3）/ checkpoint_exists / no_checkpoint / checkpoint_mismatch / interfered / busy / error。
 */
async function batchedRebuild() {
  const resume = action === 'resume'
  let stopSignal = null
  const onSignal = (sig) => { if (!stopSignal) stopSignal = sig }
  const handlers = { SIGTERM: () => onSignal('SIGTERM'), SIGINT: () => onSignal('SIGINT') }
  for (const [sig, h] of Object.entries(handlers)) process.on(sig, h)
  probe = await startLockProbe(file)
  const t0 = performance.now()
  try {
    // 第一步：建立（或校验）检查点，同一个事务里完成——绝不出现"索引已清空却没有标记"的瞬间
    const init = await writeTx(() => {
      if (resume) {
        if (!rebuildInProgress(db)) return { refuse: 'no_checkpoint', msg: `没有未完成的分批重建（${STATE} 不存在）：无可续跑；需要重建请用 --rebuild` }
        const st = stateRowOf()
        if (!st) return { refuse: 'no_checkpoint', msg: '检查点表为空：无可续跑；请用 --rebuild --restart' }
        if (st.industry !== args.industry) return { refuse: 'checkpoint_mismatch', msg: `检查点属于行业 ${st.industry}，不是 ${args.industry}：拒绝续跑；确认后用 --rebuild --restart 清除` }
        if (fingerprintOf(st.high_water) !== st.fingerprint) return { refuse: 'checkpoint_mismatch', msg: '检查点指纹与本库不符（别的库的检查点，或高水位附近的行已变）：拒绝续跑；确认后用 --rebuild --restart 清除' }
        if (st.last_id > st.high_water || st.remaining < 0) return { refuse: 'checkpoint_mismatch', msg: '检查点内容自相矛盾：拒绝续跑；用 --rebuild --restart 清除' }
        const fixed = repairTriggers()
        if (fixed) return { oneShot: fixed }
        return { state: st }
      }
      const has = rebuildInProgress(db)
      if (has && !args.restart) return { refuse: 'checkpoint_exists', msg: `已有未完成的分批重建：用 --resume 续跑，或 --rebuild --restart 丢弃它从头来` }
      const fixed = repairTriggers()
      if (fixed) return { oneShot: fixed }
      if (has) db.exec(`DROP TABLE ${STATE}`)
      db.exec(`INSERT INTO ${FTS}(${FTS}) VALUES ('delete-all')`)
      const hw = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM audit_logs').get().m
      const total = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
      const ts = nowIso()
      db.exec(REBUILD_STATE_DDL)
      db.prepare(`INSERT INTO ${STATE} (id, industry, fingerprint, high_water, last_id, total_rows, remaining, batch_rows, batches, started_at, updated_at) VALUES (1,?,?,?,0,?,?,?,0,?,?)`)
        .run(args.industry, fingerprintOf(hw), hw, total, total, batchRows ?? DEFAULT_BATCH_ROWS, ts, ts)
      return { state: stateRowOf() }
    })
    if (init.refuse) { report.status = init.refuse; report.error = init.msg; return }
    if (init.oneShot) { // 触发器缺失：高水位之后的新行没人索引，分批会漏行——补齐触发器并做一次完整 rebuild（与 AH4 之前的行为相同，持写锁到结束）
      report.repaired_triggers = init.oneShot
      report.status = 'ok'
      report.resumed = resume
      report.rows_indexed = report.rows
      return
    }
    const size = batchRows ?? init.state.batch_rows
    report.batch_rows = size
    report.resumed = resume
    const total = init.state.total_rows
    const startRemaining = init.state.remaining
    const totalBatches = Math.max(1, Math.ceil(startRemaining / size))
    let finished = false // 空表 / 已扫完的检查点也要进循环：由"没有更多行"那一支在事务里删检查点
    let interfered = false
    let triggersGone = false
    const triggerCount = db.prepare(`SELECT COUNT(*) c FROM sqlite_master WHERE type='trigger' AND name IN (${TRIGGERS.map(() => '?').join(',')})`).bind(...TRIGGERS)
    const batchSql = db.prepare(`INSERT INTO ${FTS}(rowid, action, entity, user_name) SELECT id, action, entity, user_name FROM audit_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`)
    const edge = db.prepare('SELECT MAX(id) m, COUNT(*) n FROM (SELECT id FROM audit_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT ?)')
    const more = db.prepare('SELECT 1 FROM audit_logs WHERE id > ? AND id <= ? LIMIT 1')
    let maxBatch = 0
    while (!finished) {
      if (stopSignal) break
      const tb = performance.now()
      const r = await writeTx(() => {
        const st = stateRowOf()
        if (!st) return { gone: true } // 别的进程已经收尾
        if (triggerCount.get().c !== TRIGGERS.length) return { triggersGone: true } // 批间有人删了触发器：继续下去新行会漏索引
        const e = edge.get(st.last_id, st.high_water, size)
        if (!e.n) { // 没有更多行：剩余数必须归零，否则是中途有"尚未入索引"的行被删
          if (st.remaining === 0) { db.exec(`DROP TABLE ${STATE}`); return { n: 0, done: true, remaining: 0 } }
          return { n: 0, interfered: true, remaining: st.remaining }
        }
        batchSql.run(st.last_id, st.high_water, size)
        // 测试暂停点（仅 test 模式）：批事务**已写入、未提交**——测试在这里 SIGKILL，验证崩溃后回滚到上一个检查点
        if (process.env.GML_TEST_FTS_MAINTAIN_PAUSE && process.env.GML_TEST_FTS_REBUILD_PAUSE_IN_BATCH === String(report.batches + 1)) testPause('GML_TEST_FTS_MAINTAIN_PAUSE', 'fts-rebuild-in-tx')
        const remaining = st.remaining - e.n
        const end = !more.get(e.m, st.high_water)
        if (end && remaining === 0) db.exec(`DROP TABLE ${STATE}`)
        else db.prepare(`UPDATE ${STATE} SET last_id=?, remaining=?, batches=batches+1, batch_rows=?, updated_at=? WHERE id=1`).run(e.m, remaining, size, nowIso())
        return { n: e.n, done: end && remaining === 0, interfered: end && remaining !== 0, remaining, last: e.m }
      })
      const ms = performance.now() - tb
      if (r.gone) { finished = true; break }
      if (r.triggersGone) { triggersGone = true; break }
      maxBatch = Math.max(maxBatch, ms)
      report.max_batch_ms = Math.round(maxBatch * 10) / 10
      if (r.n) {
        report.batches++
        report.rows_indexed += r.n
        const done = total - r.remaining
        console.log(`audit-fts-maintain progress ${action} batch=${report.batches}/${totalBatches} rows=${done}/${total} pct=${(total ? (done / total) * 100 : 100).toFixed(1)} batch_ms=${Math.round(ms)} elapsed_ms=${Math.round(performance.now() - t0)}`)
      }
      if (r.interfered) { interfered = true; break }
      if (r.done) { finished = true; break }
      // 测试暂停点（仅 GML_RUNTIME_MODE=test）：第 k 批提交之后、检查停止标志之前——测试在这里发信号
      if (process.env.GML_TEST_FTS_MAINTAIN_PAUSE && process.env.GML_TEST_FTS_REBUILD_PAUSE_AFTER_BATCH === String(report.batches)) testPause('GML_TEST_FTS_MAINTAIN_PAUSE', 'fts-rebuild-batch')
      await delay(Math.max(pauseMs, 2)) // 让出写锁，也让事件循环有机会处理信号
    }
    if (triggersGone) {
      report.status = 'triggers_missing'
      report.error = '重建期间审计表上的 FTS 触发器被删除：继续会漏索引；检查点保留（索引仍不被查询使用）。请用 --rebuild --restart 重来（会先补齐触发器）'
    } else if (interfered) {
      report.status = 'interfered'
      report.error = '重建期间有"尚未入索引"的行被删除（审计归档 / 清理？）：触发器对索引发出了无效的 delete，索引不可信；检查点保留（索引仍不被查询使用）。请用 --rebuild --restart 从头重建'
    } else if (finished) {
      report.status = 'ok'
    } else {
      report.status = 'interrupted'
      report.signal = stopSignal
      report.error = `收到 ${stopSignal}，在批边界停止；检查点已保存，用 --resume 续跑`
    }
  } catch (e) {
    report.status = isBusy(e) ? 'busy' : 'error'
    report.error = String(e.message).slice(0, 300)
  } finally {
    for (const [sig, h] of Object.entries(handlers)) process.off(sig, h)
    report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
    report.lock_probe = await probe.stop()
    try { report.checkpoint = rebuildInProgress(db) ? (() => { const c = stateRowOf(); return c && { last_id: c.last_id, high_water: c.high_water, remaining: c.remaining, total_rows: c.total_rows } })() : null } catch { report.checkpoint = null }
    report.fts_present = exists(db, 'table', FTS)
    report.triggers_present = Object.fromEntries(TRIGGERS.map((n) => [n, exists(db, 'trigger', n)]))
    report.bytes_after = sizeOf(file)
    report.ok = report.status === 'ok' // finally 里统一收尾：提前 return 的拒绝 / 一次性重建路径也走这里
  }
}
try {
  db = new Database(file, { fileMustExist: true })
  db.pragma(`busy_timeout = ${busyMs}`)
  report.fts_present = exists(db, 'table', FTS)
  report.triggers_present = Object.fromEntries(TRIGGERS.map((n) => [n, exists(db, 'trigger', n)]))
  report.rows = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  if (TOGGLES.includes(action)) {
    // AD4：设置值与对象在同一个写事务里一起改——要么都改要么都不改。禁用 = 删表 + 触发器；启用 = 067 的 up（建表、触发器、回填）。
    report.setting_before = readStoredSetting(db)
    if (action === 'enable' && !m067.ftsSupported(db)) {
      report.status = 'unsupported'
      report.error = '本构建没有 FTS5 / trigram：无法建索引，设置未改动'
    } else {
      probe = await startLockProbe(file)
      const t0 = performance.now()
      try {
        // 测试暂停点（仅 GML_RUNTIME_MODE=test）：已读到当前状态、尚未开事务——让另一个进程确定性地先提交
        testPause('GML_TEST_FTS_MAINTAIN_PAUSE', 'fts-maintain')
        const want = action === 'enable' ? '1' : '0'
        const actor = { id: null, name: 'audit-fts-maintain', source: 'script' }
        // AF4：BEGIN IMMEDIATE + 有上限的重试（SQLITE_BUSY / BUSY_SNAPSHOT；总等待不超过 --busy-ms）；拿到写锁后**重读**设置与对象，
        // 状态已与目标一致（并发的另一次 --enable/--disable、或启动自愈已经做完）就什么都不做。
        const deadline = Date.now() + busyMs
        for (let attempt = 1; ; attempt++) {
          db.pragma(`busy_timeout = ${Math.max(0, deadline - Date.now())}`)
          try {
            db.exec('BEGIN IMMEDIATE')
          } catch (e) {
            if (isBusy(e) && attempt < MAX_ATTEMPTS && Date.now() < deadline) { await delay(Math.min(25 * 2 ** (attempt - 1), 200, Math.max(0, deadline - Date.now()))); continue }
            throw e
          }
          try {
            const present = exists(db, 'table', FTS) && TRIGGERS.every((n) => exists(db, 'trigger', n))
            const absent = !exists(db, 'table', FTS) && TRIGGERS.every((n) => !exists(db, 'trigger', n))
            const hadState = rebuildInProgress(db) // AH4：未完成的分批重建；开关动作要把它收敛掉
            if (readStoredSetting(db) === want && !hadState && (action === 'enable' ? present : absent)) {
              report.already_in_state = true; report.changed_objects = false; report.setting_changed = false
              db.exec('ROLLBACK')
              break
            }
            // 补键 + 基线放在同一个事务里：后面任何一步失败都整体回滚，不留下半截设置行
            ensureSettings(db, { actor })
            if (action === 'disable') { report.changed_objects = m071.dropFts(db) || hadState; if (hadState) db.exec(`DROP TABLE ${STATE}`) }
            else {
              const had = exists(db, 'table', FTS)
              m071.enableFts(db) // 表不存在 → 建表 + 触发器 + 回填
              if (hadState) { db.exec(`DROP TABLE ${STATE}`); if (had) db.exec(SQL_REBUILD) } // 索引在但残缺：一次性完整重建（持写锁到结束，与 --enable 回填同量级）
              report.changed_objects = !had || hadState
            }
            const w = writeSetting(db, { key: 'audit_fts_enabled', value: want, reason: args.reason.trim(), actor, source: 'script' })
            report.setting_changed = w.changed
            db.pragma(`busy_timeout = ${busyMs}`) // 提交阶段单独一份 --busy-ms 预算（回填耗时不应让提交以 0 超时失败）
            db.exec('COMMIT')
            break
          } catch (e) {
            try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ }
            if (isBusy(e) && attempt < MAX_ATTEMPTS && Date.now() < deadline) { await delay(Math.min(25 * 2 ** (attempt - 1), 200, Math.max(0, deadline - Date.now()))); continue }
            throw e
          }
        }
        report.status = 'ok'
      } catch (e) {
        report.status = isBusy(e) ? 'busy' : 'error'
        report.error = String(e.message).slice(0, 300)
      } finally {
        report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
        report.lock_probe = await probe.stop()
      }
      report.setting_after = readStoredSetting(db)
      report.fts_present = exists(db, 'table', FTS)
      report.triggers_present = Object.fromEntries(TRIGGERS.map((n) => [n, exists(db, 'trigger', n)]))
      report.bytes_after = sizeOf(file)
    }
    report.ok = report.status === 'ok'
  } else if (!report.fts_present) {
    report.status = 'absent'
    report.ok = action === 'integrity-check'
    report.error = report.ok ? null : `${FTS} 不存在（无 FTS5 的构建，或迁移 067 未执行）：没有可维护的索引`
  } else if (BATCHED.includes(action)) {
    await batchedRebuild()
  } else if (rebuildInProgress(db)) {
    report.status = 'rebuild_in_progress'
    report.error = `分批重建未完成（检查点表 ${STATE} 在）：索引残缺，${action} 无意义；先 --resume，或 --rebuild --restart 从头来`
  } else {
    probe = await startLockProbe(file)
    const t0 = performance.now()
    try {
      db.exec('BEGIN IMMEDIATE')
      try { db.exec(SQL[action]); db.exec('COMMIT') } catch (e) { try { db.exec('ROLLBACK') } catch { /* 没有打开的事务 */ } throw e }
      report.status = 'ok'
    } catch (e) {
      report.status = isBusy(e) ? 'busy' : /CORRUPT|malformed|integrity/i.test(`${e.code} ${e.message}`) ? 'corrupt' : 'error'
      report.error = String(e.message).slice(0, 300)
    } finally {
      report.elapsed_ms = Math.round((performance.now() - t0) * 10) / 10
      report.lock_probe = await probe.stop()
    }
    report.ok = report.status === 'ok' // 只在探针也正常收尾之后才算成功（探针 stop 抛错 → 外层 catch → ok 保持 false）
    report.bytes_after = sizeOf(file)
  }
} catch (e) {
  report.ok = false
  report.status = isBusy(e) ? 'busy' : 'error'
  report.error = String(e.message).slice(0, 300)
} finally {
  try { db?.close() } catch { /* ignore */ }
}

fs.mkdirSync(path.dirname(outFile), { recursive: true })
const tmp = `${outFile}.${process.pid}.tmp`
fs.writeFileSync(tmp, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
fs.renameSync(tmp, outFile)
const lp = report.lock_probe
console.log(`audit-fts-maintain ${action} ${report.ok ? 'ok' : 'FAILED'} status=${report.status} industry=${report.industry} rows=${report.rows} elapsed_ms=${report.elapsed_ms ?? '-'}` +
  (lp ? ` lock_blocked_ms<=${lp.max_blocked_ms} lock_busy_span_ms>=${lp.max_busy_span_ms}` : '') + (report.error ? ` error=${report.error}` : ''))
process.exit(report.ok ? 0 : report.status === 'interrupted' ? 3 : 1)
