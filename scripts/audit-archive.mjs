#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-archive.mjs ｜ 审计日志归档（危险操作）：导出 JSONL + 链头/链尾摘要 → 验证导出段 → 删除并重锚定（ADR-0049）
 * ============================================================================
 * 【职责】把 `created_at` 早于 `--before` 的**最长 id 前缀**搬出库：
 *   1. 在 `audit_logs` 里找第一条 `created_at >= <before> 00:00:00` 的行作为边界；其前所有行（id 小于边界）是待归档段。
 *      （按 id 前缀而不是按时间筛：哈希链是按 id 串起来的，只有前缀被拿走，剩下的链才仍是一条连续的链。时钟回拨造成的"id 靠前但时间更晚"
 *      的行会让前缀在它那里停住——宁可少归档，不拆链。）所有行都早于 `--before` 时**保留最后一行**，库里永远至少剩一行链尾。
 *   2. 先对待归档段跑一遍链校验，不通过 ⇒ 拒绝（退出 1，什么都不动）：不归档已被篡改的段，免得篡改被"洗"成合法归档。
 *   3. 导出 `audit-archive-<行业>-<before>-<首id>-<末id>.jsonl`（含 prev_hash / row_hash 与全部列），同名 `.digest.json` 记录
 *      首行 / 末行 id 与 row_hash、首行 prev_hash、行数、JSONL 文件 SHA-256、边界 id；**读回刚写出的文件再验一遍链**。
 *   4. 同一个 IMMEDIATE 事务内：删除待归档段、在 `audit_chain_anchors` 登记锚点（边界行 id ↔ 段尾 row_hash）、写一条 `AUDIT_ARCHIVE` 严格审计
 *      （不含行内容，只有计数与摘要）。任何一步失败 ⇒ 事务回滚，已写出的导出文件被删除。
 *
 * 【崩溃窗口与 `--resume`】（AC7，ADR-0049 补充）导出在 `IMMEDIATE` 事务内完成并 fsync，之后才删除。进程在这之间被杀（SIGKILL / 断电）时，SQLite 回滚未提交的删除：
 *   库原样不动，导出的 JSONL 与摘要完整落盘。此时重跑会因“不覆盖已有文件”报 `OUT_EXISTS`；用 `--resume` 续做：同样先演练取口令、再 `--confirm`，但**不重写导出**，
 *   而是在写锁内逐项核对——摘要字段与重算的计划一致、JSONL 的 SHA-256 等于摘要、读回链校验通过、**且 JSONL 与库里这一段逐字节相同**（把库里的段按同一序列化重算 SHA-256；
 *   user_name / module / ip 不进哈希，只有这一步能发现它们在崩溃后被改）、段内锚点与摘要一致——全部通过才删除并登记锚点 / 审计。任何一项不符 ⇒ 退出 1、什么都不动、
 *   也不删除导出文件（它们是证据）。幂等：已经归档完成（库里有对应 `archive` 锚点）时 `--resume` 报 `already-archived` 并退出 0，不重复删除、不重复写审计。
 *   只有 JSONL 没有摘要（崩在导出途中）⇒ `RESUME_INCOMPLETE`；根本没有导出 ⇒ `RESUME_NOTHING`（不会悄悄当成新归档）。
 *   测试钩子：`GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT=1`（仅 GML_RUNTIME_MODE=test）在导出 fsync 之后、删除之前写 `<out>/.archive-paused` 并等待 `<out>/.archive-continue` 出现。
 *
 *   故障注入（AD6）：`GML_TEST_FS_FAULT=archive.{after-export-write,after-export-fsync,before-delete,after-delete,after-anchor}`（scripts/lib/fs-fault.mjs，仅 test 模式）；各点之后的状态与恢复见 docs/operations/audit-integrity.md §5b。
 *
 * 【危险操作确认】默认只演练：打印每个行业的计划与确认口令，不写任何东西。口令 = 对"行业 + 行数 + 首末 id + 段尾哈希"的摘要；
 *   `--confirm <口令>` 必须与执行时重新算出的完全一致（演练后数据又变了 ⇒ 口令失效，需重新演练）。
 *   执行期间持写锁（单事务，含导出与读回校验），其它写入等 busy_timeout——请在低峰执行；百万行耗时见 capacity-baseline "AB6"。
 *
 * 【用法】node scripts/audit-archive.mjs --data-dir <绝对路径> --before <YYYY-MM-DD> --out <目录> [--industry <行业>] [--confirm <口令>] [--actor <名字>] [--resume]
 *   退出码：0 演练完成 / 归档完成 / 无可归档；1 链校验失败或事务失败；2 参数、口令或环境错误。
 * 【改它要注意什么】锚点语义见 ADR-0049：归档后剩余链的第一行 prev_hash 指向已被搬走的段尾，靠锚点被校验器承认；
 *   导出文件与摘要是**唯一**保留被归档内容的地方，运维必须先把它们转存到带外介质再删本机副本。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'
import { sha256FileSync } from '../server/lib/audit-anchor-manifest.js'
import { faultPoint, assertFsFaultAllowed } from './lib/fs-fault.mjs'
import { loadIntentSigner } from './lib/anchor-intent-signer.mjs'

const { anchorAccepts } = createRequire(import.meta.url)('../server/db/migrations/_audit_chain.cjs')

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--before', '--out', '--confirm', '--actor'], flags: ['--resume'] })
if (!args['data-dir'] && !process.env.GML_DATA_DIR) die('USAGE', '用法：audit-archive.mjs --data-dir <绝对路径> --before <YYYY-MM-DD> --out <目录> [--industry <行业>] [--confirm <口令>] [--actor <名字>] [--resume]')
if (!/^\d{4}-\d{2}-\d{2}$/.test(args.before || '') || Number.isNaN(Date.parse(args.before))) die('USAGE', '--before 必须是 YYYY-MM-DD')
if (!args.out) die('USAGE', '--out 必须给出导出目录')
const pauseHook = process.env.GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT === '1'
if (process.env.GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT && (!pauseHook || process.env.GML_RUNTIME_MODE !== 'test')) die('PAUSE_HOOK_FORBIDDEN', 'GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT 只允许在 GML_RUNTIME_MODE=test 下取值 1')
try { assertFsFaultAllowed() } catch (e) { die(e.code, e.message) }
const actor = args.actor || 'audit-archive-script'
const outDir = path.resolve(args.out)

const { verifyChain, verifyJsonlSegment, chainColumnsPresent } = await import('../server/lib/audit-chain-verify.js')
const { auditStrictRow } = await import('../server/lib/audit-trail.js')
const { anchorMark, recordAnchorIntent, linkIntentAuditRow, intentRef } = await import('../server/lib/audit-anchor-intent.js')

// AE5：执行时才需要意图签名私钥；配置了却读不出来 ⇒ 动手前退出（不写出没签名的意图）
let intentSigner = null
if (args.confirm) {
  try { intentSigner = loadIntentSigner() } catch (e) { die(e.code || 'USAGE', e.message) }
}
const { targets, absent } = await locateDatabases(args)
{
  // 目录可能还不存在：对最近的已存在祖先取 realpath 再接回尾部（macOS 的 /var → /private/var 等符号链接）
  const real = (p) => {
    const rest = []
    let cur = path.resolve(p)
    while (!fs.existsSync(cur) && path.dirname(cur) !== cur) { rest.unshift(path.basename(cur)); cur = path.dirname(cur) }
    return path.join(fs.realpathSync(cur), ...rest)
  }
  const dataDir = real(process.env.GML_DATA_DIR)
  const o = real(outDir)
  if (o === dataDir || o.startsWith(dataDir + path.sep)) die('OUT_DIR_INVALID', '--out 不能在数据目录内（归档文件要转存到带外介质，不该和在用库放在一起）')
}
const cutoff = `${args.before} 00:00:00`
const COLS = 'id, user_id, user_name, action, module, entity, entity_id, detail, ip, created_at, prev_hash, row_hash'

/** 计算某库的归档计划（只读）；失败返回 { error } */
function plan(db) {
  if (!chainColumnsPresent(db)) return { error: 'NOT_MIGRATED', message: 'audit_logs 没有哈希链列（迁移 068 未执行）' }
  const last = db.prepare('SELECT MAX(id) AS id FROM audit_logs').get().id
  if (last === null) return { count: 0 }
  const firstNew = db.prepare('SELECT MIN(id) AS id FROM audit_logs WHERE created_at >= ?').get(cutoff).id
  const boundary = firstNew === null ? last : firstNew
  const seg = db.prepare('SELECT COUNT(*) AS n, MIN(id) AS firstId, MAX(id) AS lastId FROM audit_logs WHERE id < ?').get(boundary)
  if (!seg.n) return { count: 0 }
  const v = verifyChain(db, { maxId: seg.lastId })
  if (!v.ok) return { error: 'CHAIN_BROKEN', message: `待归档段链校验失败：id=${v.brk.id} 类型=${v.brk.kind}；拒绝归档（先查清篡改）`, brk: v.brk }
  const next = db.prepare('SELECT id, prev_hash FROM audit_logs WHERE id >= ? ORDER BY id LIMIT 1').get(seg.lastId + 1)
  // 边界行与段尾要么直接衔接，要么在边界处有绑定"前驱 = 段尾"的锚点（段尾行刚好被隐私抹除改写过等合法情形）
  const joined = next && (next.prev_hash === v.tipHash || anchorAccepts(
    db.prepare('SELECT anchor_hash, prev_id, prev_row_hash FROM audit_chain_anchors WHERE at_row_id=?').all(next.id), next, seg.lastId, v.tipHash))
  if (!joined) return { error: 'BOUNDARY_MISMATCH', message: '边界行的 prev_hash 与段尾 row_hash 不衔接且无对应锚点（请先运行 audit-verify-chain.mjs）' }
  const firstRow = db.prepare('SELECT row_hash, prev_hash FROM audit_logs WHERE id=?').get(seg.firstId)
  return { count: seg.n, firstId: seg.firstId, lastId: seg.lastId, boundaryId: next.id, boundaryPrevHash: next.prev_hash, tipHash: v.tipHash, firstHash: firstRow.row_hash, firstPrevHash: firstRow.prev_hash }
}

const tokenOf = (code, p) => 'ARCHIVE-' + createHash('sha256').update(JSON.stringify([code, args.before, p.count, p.firstId, p.lastId, p.tipHash])).digest('hex').slice(0, 16).toUpperCase()

/** fsync 一个目录（让新建文件 / 子目录的目录项落盘）。失败必须上抛（删除一旦提交就不可逆）；Windows 不支持目录 fsync，直接跳过 */
function fsyncDir(dir) {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}

/** `mkdir -p` 并返回本次新建的目录（由浅到深），之后对它们及其父目录逐个 fsync */
function mkdirpTracked(dir) {
  const missing = []
  for (let cur = dir; !fs.existsSync(cur) && path.dirname(cur) !== cur; cur = path.dirname(cur)) missing.unshift(cur)
  fs.mkdirSync(dir, { recursive: true })
  return missing
}

const exportBase = (code, p) => `audit-archive-${code}-${args.before}-${p.firstId}-${p.lastId}`

/** 库里这一段按导出同一序列化（逐行 JSON + 换行）算出的 SHA-256 与段内锚点：续做时与导出文件比对 */
function dbSegmentFingerprint(db, p) {
  const hash = createHash('sha256')
  let cursor = 0
  for (;;) {
    const rows = db.prepare(`SELECT ${COLS} FROM audit_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT 20000`).all(cursor, p.lastId)
    if (!rows.length) break
    hash.update(rows.map((r) => JSON.stringify(r) + '\n').join(''), 'utf8')
    cursor = rows[rows.length - 1].id
  }
  const anchors = db.prepare('SELECT kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason, created_at FROM audit_chain_anchors WHERE at_row_id BETWEEN ? AND ? ORDER BY id').all(p.firstId, p.lastId)
  return { sha256: hash.digest('hex'), anchors }
}

/**
 * 续做前的核对（只读）：导出文件 + 摘要必须完整、自洽，并且与库里待归档的这一段逐字节相同。失败抛带 code 的错误（调用方绝不删导出文件）。
 */
function checkResume(db, code, p) {
  const base = exportBase(code, p)
  const file = path.join(outDir, `${base}.jsonl`)
  const digestFile = path.join(outDir, `${base}.digest.json`)
  const fail = (c, m) => { throw Object.assign(new Error(m), { code: c }) }
  const hasFile = fs.existsSync(file)
  const hasDigest = fs.existsSync(digestFile)
  if (!hasFile && !hasDigest) fail('RESUME_NOTHING', `${outDir} 里没有 ${base}.*：没有可续做的导出（去掉 --resume 做一次新归档）`)
  if (!hasFile || !hasDigest) fail('RESUME_INCOMPLETE', `导出不完整（缺 ${hasFile ? '摘要' : 'JSONL'}）：上次崩在导出途中。人工确认后删除残留文件再做新归档`)
  let digest
  try { digest = JSON.parse(fs.readFileSync(digestFile, 'utf8')) } catch (e) { fail('EXPORT_DIGEST_MISMATCH', `摘要无法解析：${e.message}`) }
  const want = { format: 'os-erp-audit-archive/1', industry: code, before: args.before, rows: p.count, first_id: p.firstId, last_id: p.lastId, first_row_hash: p.firstHash, first_prev_hash: p.firstPrevHash, tip_row_hash: p.tipHash, boundary_id: p.boundaryId, file: path.basename(file) }
  for (const [k, v] of Object.entries(want)) if (digest[k] !== v) fail('EXPORT_DIGEST_MISMATCH', `摘要字段 ${k} 与当前计划不符（摘要 ${JSON.stringify(digest[k])}，计划 ${JSON.stringify(v)}）`)
  if (sha256FileSync(file) !== digest.file_sha256) fail('EXPORT_DIGEST_MISMATCH', 'JSONL 的 SHA-256 与摘要不符（文件被改或写坏）')
  const back = verifyJsonlSegment(file, Array.isArray(digest.anchors) ? digest.anchors : [])
  if (!back.ok || back.rows !== p.count || back.firstId !== p.firstId || back.lastId !== p.lastId || back.tipHash !== p.tipHash) fail('EXPORT_VERIFY_MISMATCH', `导出文件读回校验失败：${JSON.stringify(back)}`)
  const fp = dbSegmentFingerprint(db, p)
  if (fp.sha256 !== digest.file_sha256 || JSON.stringify(fp.anchors) !== JSON.stringify(digest.anchors)) fail('EXPORT_DB_MISMATCH', '导出文件与库里这一段不一致（崩溃之后库里的行 / 锚点被改过？未进哈希的列 user_name / module / ip 只有这一步能发现）')
  // 续做之后紧接着就是提交删除：导出文件刚被读过不等于已落盘（上次可能崩在 fsync 之前），这里补 fsync 文件与目录项；做不到就上抛，不删
  for (const f of [file, digestFile]) {
    const fd = fs.openSync(f, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  fsyncDir(outDir)
  fsyncDir(path.dirname(outDir))
  return { file, digestFile, digest }
}

/** 已经归档完成？（`--resume` 幂等）：out 目录里有本行业 / 本日期的摘要，且库里有对应的 archive 锚点 */
function findCompleted(db, code) {
  if (!fs.existsSync(outDir)) return null
  for (const f of fs.readdirSync(outDir).sort()) {
    if (!f.startsWith(`audit-archive-${code}-${args.before}-`) || !f.endsWith('.digest.json')) continue
    try {
      const d = JSON.parse(fs.readFileSync(path.join(outDir, f), 'utf8'))
      if (d.industry === code && d.before === args.before && db.prepare("SELECT 1 FROM audit_chain_anchors WHERE kind='archive' AND at_row_id=? AND anchor_hash=?").get(d.boundary_id, d.tip_row_hash)) return path.join(outDir, f)
    } catch { /* 不是摘要 */ }
  }
  return null
}

/** 测试钩子：导出已 fsync、删除尚未执行——写标记并等放行（只会被 SIGKILL 或放行文件结束） */
function pauseAfterExport() {
  if (!pauseHook) return
  fs.writeFileSync(path.join(outDir, '.archive-paused'), String(process.pid))
  const wait = new Int32Array(new SharedArrayBuffer(4))
  while (!fs.existsSync(path.join(outDir, '.archive-continue'))) Atomics.wait(wait, 0, 0, 50)
}

/** 导出 + 读回校验 + 落盘（文件与目录项都 fsync）；任何一步失败都删掉本次创建的文件再抛，不挡重试 */
function exportSegment(db, code, p) {
  const createdDirs = mkdirpTracked(outDir)
  const base = exportBase(code, p)
  const file = path.join(outDir, `${base}.jsonl`)
  const digestFile = path.join(outDir, `${base}.digest.json`)
  if (fs.existsSync(file) || fs.existsSync(digestFile)) throw Object.assign(new Error(`导出文件已存在：${file}（不覆盖）。若上次是在导出后、删除前被中断，用 --resume 续做（会先核对文件与库一致）`), { code: 'OUT_EXISTS' })
  const owned = []
  try {
    const fd = fs.openSync(file, 'wx', 0o600)
    owned.push(file)
    const hash = createHash('sha256')
    try {
      let cursor = 0
      for (;;) {
        const rows = db.prepare(`SELECT ${COLS} FROM audit_logs WHERE id > ? AND id <= ? ORDER BY id LIMIT 20000`).all(cursor, p.lastId)
        if (!rows.length) break
        const chunk = rows.map((r) => JSON.stringify(r) + '\n').join('')
        hash.update(chunk, 'utf8')
        fs.writeSync(fd, chunk)
        cursor = rows[rows.length - 1].id
      }
      faultPoint('archive.after-export-write')
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
    faultPoint('archive.after-export-fsync')
    // 段内被锚点承认的断口（保留清理 / 隐私抹除留下的）随摘要一起导出，读回校验和以后离线复核都要用
    const anchors = db.prepare('SELECT kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason, created_at FROM audit_chain_anchors WHERE at_row_id BETWEEN ? AND ? ORDER BY id').all(p.firstId, p.lastId)
    const back = verifyJsonlSegment(file, anchors)
    if (!back.ok || back.rows !== p.count || back.firstId !== p.firstId || back.lastId !== p.lastId || back.tipHash !== p.tipHash) {
      throw Object.assign(new Error(`导出文件读回校验失败：${JSON.stringify(back)}`), { code: 'EXPORT_VERIFY_FAILED' })
    }
    const digest = {
      format: 'os-erp-audit-archive/1', industry: code, before: args.before, rows: p.count, first_id: p.firstId, last_id: p.lastId,
      first_row_hash: p.firstHash, first_prev_hash: p.firstPrevHash, tip_row_hash: p.tipHash, boundary_id: p.boundaryId,
      file: path.basename(file), file_sha256: hash.digest('hex'), anchors, created_by: actor
    }
    const dfd = fs.openSync(digestFile, 'wx', 0o600)
    owned.push(digestFile)
    try {
      fs.writeSync(dfd, JSON.stringify(digest, null, 2) + '\n')
      fs.fsyncSync(dfd)
    } finally {
      fs.closeSync(dfd)
    }
    // 删除一旦提交就不可逆：先让导出文件和它们的目录项（含刚创建的目录及其父目录）落盘
    fsyncDir(outDir)
    for (const d of createdDirs) fsyncDir(path.dirname(d)) // 每个新建目录的目录项都在它父目录里
    return { file, digestFile, digest }
  } catch (e) {
    for (const f of owned) fs.rmSync(f, { force: true })
    throw e
  }
}

const report = { mode: args.confirm ? 'execute' : 'dry-run', before: args.before, industries: {} }
for (const code of absent) report.industries[code] = { status: 'absent' }
let failed = false
let usageError = false

// ---- 演练 / 口令计算（只读）----
const plans = new Map()
for (const { code, file } of targets) {
  const db = new Database(file, { readonly: true })
  try {
    const p = plan(db)
    plans.set(code, p)
    if (p.error) { failed = true; report.industries[code] = { status: 'refused', error: `${p.error}: ${p.message}` } }
    else if (!p.count) {
      const done = args.resume ? findCompleted(db, code) : null
      report.industries[code] = done ? { status: 'already-archived', digest_file: done } : { status: 'nothing-to-archive' }
    } else if (args.resume) {
      try {
        checkResume(db, code, p)
        report.industries[code] = { status: 'resumable', rows: p.count, first_id: p.firstId, last_id: p.lastId, tip_hash: p.tipHash, token: tokenOf(code, p) }
      } catch (e) {
        // 全部行都早于 --before 时首轮归档会保留最后一行；归档审计行写入后这一行又成了新的可归档段。此时 --resume 找不到它的导出，
        // 但对应的原归档已经完成（摘要 + 库里的 archive 锚点）⇒ 幂等地报告 already-archived，而不是 RESUME_NOTHING
        const done = e.code === 'RESUME_NOTHING' ? findCompleted(db, code) : null
        if (done) {
          plans.set(code, { count: 0 })
          report.industries[code] = { status: 'already-archived', digest_file: done }
        } else {
          failed = true
          report.industries[code] = { status: 'refused', error: `${e.code || 'ERROR'}: ${e.message}` }
        }
      }
    } else report.industries[code] = { status: 'planned', rows: p.count, first_id: p.firstId, last_id: p.lastId, tip_hash: p.tipHash, token: tokenOf(code, p) }
  } finally {
    db.close()
  }
}

if (args.confirm && !failed) {
  const planned = [...plans].filter(([, p]) => p.count)
  const expected = planned.map(([code, p]) => tokenOf(code, p))
  const combined = planned.length === 1 ? expected[0] : 'ARCHIVE-' + createHash('sha256').update(expected.join(',')).digest('hex').slice(0, 16).toUpperCase()
  if (!planned.length) { /* 无事可做 */ }
  else if (args.confirm !== combined) {
    usageError = true
    console.error(`CONFIRM_MISMATCH: --confirm 口令与当前计划不符（数据已变化或口令抄错）。先不带 --confirm 重新演练取口令。`)
  } else {
    for (const [code, p0] of planned) {
      const file = targets.find((t) => t.code === code).file
      const db = new Database(file)
      db.pragma('busy_timeout = 5000')
      let made = null
      let resumed = false
      try {
        const done = db.transaction(() => {
          const p = plan(db) // 锁内重算：与口令绑定的段必须与演练时一致
          if (p.error || tokenOf(code, p) !== tokenOf(code, p0)) throw Object.assign(new Error(p.error ? p.message : '加锁后计划与演练不一致'), { code: p.error || 'PLAN_CHANGED' })
          if (args.resume) { made = checkResume(db, code, p); resumed = true } else { made = exportSegment(db, code, p); pauseAfterExport() }
          faultPoint('archive.before-delete')
          const mark = anchorMark(db)
          const removed = db.prepare('DELETE FROM audit_logs WHERE id <= ?').run(p.lastId).changes
          if (removed !== p.count) throw Object.assign(new Error(`删除行数 ${removed} 与计划 ${p.count} 不一致`), { code: 'DELETE_COUNT_MISMATCH' })
          faultPoint('archive.after-delete')
          // 被归档行上的旧锚点已随摘要导出，库里不再有对应行；边界行成为表里第一行（前驱 = 无）
          db.prepare('DELETE FROM audit_chain_anchors WHERE at_row_id <= ?').run(p.lastId)
          db.prepare('INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES (?,?,?,NULL,NULL,?)')
            .run('archive', p.boundaryId, p.boundaryPrevHash, `archive before ${args.before}: ids ${p.firstId}..${p.lastId}`)
          // AE5：归档锚点与操作意图同事务；意图由 AUDIT_ARCHIVE 审计行引用并回填该行 id
          const intent = recordAnchorIntent(db, mark, { operation: 'archive', operatorName: actor, signer: intentSigner, range: `archive before ${args.before}: ids ${p.firstId}..${p.lastId} (${p.count} rows)` })
          auditStrictRow(db, {
            userName: actor, action: 'AUDIT_ARCHIVE', module: 'audit', entity: 'audit_logs', entityId: code,
            detail: { before: args.before, rows: p.count, first_id: p.firstId, last_id: p.lastId, tip_row_hash: p.tipHash, file_sha256: made.digest.file_sha256, file: made.digest.file, ...(intent ? { anchor_intent: intentRef(intent) } : {}) }
          })
          linkIntentAuditRow(db, intent)
          faultPoint('archive.after-anchor')
          const after = verifyChain(db)
          if (!after.ok) throw Object.assign(new Error(`归档后剩余链校验失败：id=${after.brk.id} ${after.brk.kind}`), { code: 'POST_VERIFY_FAILED' })
          return { rows: p.count, file: made.file, digest_file: made.digestFile, tip_hash: p.tipHash }
        }).immediate()
        report.industries[code] = { status: 'archived', ...done }
      } catch (e) {
        failed = true
        for (const f of resumed ? [] : [made?.file, made?.digestFile]) if (f) fs.rmSync(f, { force: true }) // 续做时导出文件是证据，永不删；否则事务回滚（导出之后的步骤失败）时一并删除导出文件
        report.industries[code] = { status: 'failed', error: `${e.code || 'ERROR'}: ${e.message}` }
      } finally {
        db.close()
      }
    }
  }
}

console.log(args.confirm ? '[执行] 审计归档' : '[演练] 仅计划，未改库、未写文件（带 --confirm <口令> 才执行）')
for (const [code, r] of Object.entries(report.industries)) {
  if (r.status === 'resumable') console.log(`  ${code}: 可续做 ${r.rows} 行（id ${r.first_id}..${r.last_id}），导出文件已核对与库一致，段尾 ${r.tip_hash}\n    口令：${r.token}`)
  else if (r.status === 'planned') console.log(`  ${code}: 将归档 ${r.rows} 行（id ${r.first_id}..${r.last_id}），段尾 ${r.tip_hash}\n    口令：${r.token}`)
  else console.log(`  ${code}: ${r.status}${r.error ? ' — ' + r.error : ''}${r.file ? `\n    ${r.file}\n    ${r.digest_file}` : ''}`)
}
const planned = Object.values(report.industries).filter((r) => r.status === 'planned' || r.status === 'resumable' || r.status === 'archived')
if (!args.confirm && planned.length > 1) {
  const tokens = Object.values(report.industries).filter((r) => r.status === 'planned' || r.status === 'resumable').map((r) => r.token)
  console.log(`  多个行业：总口令 ${'ARCHIVE-' + createHash('sha256').update(tokens.join(',')).digest('hex').slice(0, 16).toUpperCase()}（或用 --industry 逐个归档，使用各自口令）`)
}
if (usageError) process.exit(2)
process.exit(failed ? 1 : 0)
