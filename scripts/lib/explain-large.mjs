/**
 * ============================================================================
 * 文件标识：scripts/lib/explain-large.mjs ｜ 大合成库的构建 / 复用与 OMS 密集窗口灌数（roadmap-v13 AH3，ADR-0044 补充 7）
 * ============================================================================
 * 【职责】给 `explain-audit --scale large` 提供"大库"：
 *   · buildLargeDb：在全新临时目录里跑 `synth-data.mjs`（生产模式、固定种子）造 LARGE_PROFILE 规模的库，再 `fillOms` 灌 OMS 订单（合成生成器不产生 OMS 单，
 *     不灌的话 oms_* 语句面对的是空表，AF3 的"密集窗口"最坏情形也就无从谈起）；
 *   · resolveLargeDir：复用现成的大库目录（夜间工作流里 synth-pipeline 的 `$CAP_RUN/data`），只做路径判据，不改库；
 *   · fillOms：确定性（mulberry32）灌 N 个 OMS 订单 + 每单一行明细，订单时间落在锚点之前最近 spanDays 天且随 id 递增（±6 h），
 *     即 AF3 的 `--span 60 --ordered` 密集窗口；**从不执行统计收集语句**（库里不得出现 sqlite_stat1，否则快照不可比）。
 * 【诚实边界】LARGE_PROFILE 取夜间工作流的 `large`（2 万 SKU / 5 万单据 / 25 万流水）+ 20 万 OMS 单——是"大"，不是生产规模；
 *   计划指纹不依赖数据量（无 sqlite_stat1），大库的价值在于：①行数阈值 200 之上的裸 SCAN 真的会被判违规；②真实数据量下计划与小库一致这件事被实测而不是推断。
 * 【改它要注意】fillOms 的输出进入大库快照的 dataset.table_rows，改分布不改计划；改 LARGE_PROFILE 要重取 explain-plans.large.json。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const LARGE_PROFILE = Object.freeze({ skus: 20000, docs: 50000, txns: 250000, oms_orders: 200000, oms_span_days: 60, seed: 20261023, anchor: '2026-10-01' })
/** 写进大库快照 dataset.table_rows 的表 */
export const DATASET_TABLES = ['products', 'product_skus', 'inventory_transactions', 'purchase_orders', 'sales_orders', 'oms_orders', 'oms_order_items', 'audit_logs', 'platforms']

const phys = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } }
function withinRepoData(p) {
  const rel = path.relative(phys(path.resolve(ROOT, 'data')), phys(p))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pad = (n) => String(n).padStart(2, '0')
const ymdhms = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
const STATUS = ['pending', 'shipped', 'completed', 'refunded', 'closed']
const INS = 'INSERT INTO oms_orders (platform_id, platform_order_no, buyer_nick, order_time, pay_time, status, goods_amount, freight, discount_amount, pay_amount, receiver, receiver_phone, receiver_address, sync_at, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'

/**
 * 向 dbFile（可写打开）灌 OMS 订单。platforms 不足 5 个时补到 5 个；订单时间落在 anchor 之前的最近 spanDays 天，随 id 递增 ±6 h；每单一行明细。
 * 返回 { orders, platforms, items }。
 */
export function fillOms(dbFile, { rows, spanDays = LARGE_PROFILE.oms_span_days, seed = LARGE_PROFILE.seed, anchor = LARGE_PROFILE.anchor } = {}) {
  if (!Number.isInteger(rows) || rows < 0) throw new Error('rows 必须是非负整数')
  const end = Date.parse(`${anchor}T00:00:00Z`)
  if (!Number.isFinite(end)) throw new Error('anchor 非法')
  const db = new Database(dbFile, { fileMustExist: true })
  try {
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = OFF')
    const have = db.prepare('SELECT COUNT(*) c FROM platforms').get().c
    // 平台绑定仓库 / 组织（org 1 = 平台 1、2；org 2 = 其余），受限组织范围（AE3 的 omsPlatformScopeSql）才有可测的形态——与 bench-oms-order-time 同口径
    let wh = null
    if (have < 5) {
      const ins = db.prepare('INSERT INTO warehouses (code, name, org_id) VALUES (?, ?, ?)')
      wh = [ins.run('AHW1', 'ah3-warehouse-1', 1).lastInsertRowid, ins.run('AHW2', 'ah3-warehouse-2', 2).lastInsertRowid]
    }
    for (let i = have; i < 5; i++) db.prepare('INSERT INTO platforms (code, name, warehouse_id) VALUES (?, ?, ?)').run(`AHP${i + 1}`, `ah3-platform-${i + 1}`, wh[i < 2 ? 0 : 1])
    const ids = db.prepare('SELECT id FROM platforms ORDER BY id').all().map((r) => r.id)
    const rnd = mulberry32(seed)
    const ins = db.prepare(INS)
    const first = db.prepare('SELECT COALESCE(MAX(id), 0) m FROM oms_orders').get().m
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const t = new Date(end - Math.floor((1 - i / Math.max(rows, 1)) * spanDays * 86400000 + (rnd() - 0.5) * 12 * 3600000))
        const amt = Number((20 + rnd() * 400).toFixed(2))
        const ts = ymdhms(t)
        ins.run(ids[i % ids.length], `AH${seed}-${i}`, `buyer${i % 5000}`, ts, ts, STATUS[i % 5], amt, 0, 0, amt, `r${i % 900}`, '13800000000', `addr ${i % 4000}`, ts, 'ah3')
      }
    })()
    const items = db.prepare("INSERT INTO oms_order_items (oms_order_id, title, qty, price, amount) SELECT id, 'sku-' || (id % 200), 1 + (id % 3), pay_amount, pay_amount FROM oms_orders WHERE id > ?").run(first).changes
    db.pragma('wal_checkpoint(TRUNCATE)')
    return { orders: rows, platforms: ids.length, items }
  } finally { db.close() }
}

/** 复用现成大库：目录必须是绝对路径、不在仓库 data/ 内，里面有 gml_<industry>.db（不是符号链接）。返回库文件路径。 */
export function resolveLargeDir(dir, industry = 'cosmetic') {
  if (!dir || !path.isAbsolute(dir)) throw new Error('--large-dir 必须是绝对路径')
  if (withinRepoData(dir)) throw new Error('--large-dir 位于仓库 data/ 之内；请使用独立副本')
  const file = path.join(dir, `gml_${industry}.db`)
  let st
  try { st = fs.lstatSync(file) } catch { throw new Error(`找不到大库 ${file}`) }
  if (st.isSymbolicLink()) throw new Error('大库文件是符号链接')
  return file
}

/** 每张关键表的行数（只读句柄）；表不存在记 null */
export function datasetRows(db, tables = DATASET_TABLES) {
  const out = {}
  for (const t of tables) { try { out[t] = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c } catch { out[t] = null } }
  return out
}

/**
 * 在全新临时目录里造大库。返回 { dir, file, cleanup, synth }；调用方用完调 cleanup()。
 * 子进程只带最小环境（PATH / HOME / TMPDIR + 生产模式变量），管理员密码随机生成、用完随目录删除。
 */
export function buildLargeDb({ profile = LARGE_PROFILE, log = () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ah3-large-'))
  const dataDir = path.join(root, 'synth')
  const cleanup = () => fs.rmSync(root, { recursive: true, force: true })
  try {
    const summary = path.join(root, 'synth-summary.json')
    const args = ['scripts/synth-data.mjs', '--quiet', '--skus', String(profile.skus), '--txns', String(profile.txns), '--docs', String(profile.docs), '--seed', String(profile.seed), '--anchor', profile.anchor, '--out', summary]
    log(`生成大合成库（${profile.skus} SKU / ${profile.docs} 单据 / ${profile.txns} 流水）…`)
    const t0 = Date.now()
    const r = spawnSync(process.execPath, args, {
      cwd: ROOT, encoding: 'utf8', timeout: 3 * 3600 * 1000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, HOME: process.env.HOME || os.tmpdir(), TMPDIR: process.env.TMPDIR || os.tmpdir(), GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dataDir, GML_DB: '', TZ: 'UTC', GML_SYNTH_ADMIN_PASSWORD: crypto.randomBytes(18).toString('hex') }
    })
    if (r.status !== 0) throw new Error(`synth-data 退出码 ${r.status}`)
    const synth = JSON.parse(fs.readFileSync(summary, 'utf8'))
    log(`合成库完成（${((Date.now() - t0) / 1000).toFixed(0)} s）；灌 ${profile.oms_orders} 个 OMS 订单…`)
    const file = path.join(dataDir, 'gml_cosmetic.db')
    fillOms(file, { rows: profile.oms_orders, spanDays: profile.oms_span_days, seed: profile.seed, anchor: profile.anchor })
    return { dir: dataDir, file, cleanup, synth }
  } catch (e) { cleanup(); throw e }
}
