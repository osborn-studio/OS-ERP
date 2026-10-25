#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-audit-logs.mjs ｜ 审计日志检索基准：在合成百万行 audit_logs 上对比迁移 065 前后（roadmap-v6 AA6）
 * ============================================================================
 * 【职责】给 AA6 的三棵索引与"封顶计数 / 导出 5 万行"提供可重复的计时与 EXPLAIN 证据。
 *   · 在**全新临时目录**建库（schema.sql + 真实迁移运行器，但**不含 065**），用 `insertAuditRow`（audit_logs 的唯一 INSERT 点）
 *     写入 N 行合成审计（确定性：mulberry32 种子；module/user 偏斜分布、entity_id 高基数），再统一回填 created_at（默认 30 秒/行）；
 *   · "前"：无二级索引，跑一组代表性列表 / 封顶计数 / 导出 5 万行；"后"：执行迁移 065 的 `up`（记录建索引耗时），同一组再跑一遍；
 *   · 每项取 REPEAT 次的中位数，附 EXPLAIN QUERY PLAN；另测写路径（追加 WRITES 行）的写放大。
 * 【SQL 来源】"后"的 WHERE / ORDER BY / COUNT / 导出批语句全部来自 server/lib/audit-view.js（路由用的同一份），不是镜像。
 *   "前"= Z7 的**旧代码路径**（整表 COUNT(*)、ORDER BY id DESC、user 数字 OR user_name、导出游标 id < ?），由本脚本的 legacy* 函数逐字重现：
 *   这样比较的是"迁移 065 + AA6 代码改动 前 / 后"的整体效果，而不是"新 SQL 在没有索引的库上"这种从未上线过的组合。
 * 【诚实边界】进程内计时（不含 HTTP、鉴权、网络），单机单连接，机器有负载只看量级；导出计时包含读出 + 读取侧脱敏 + CSV 编码，
 *   不含写 socket。合成数据不代表生产分布；SQLite 的页缓存会让"后"测量更热——"前"后"各自先预热一次再计。
 * 【用法】node scripts/bench-audit-logs.mjs [--rows 1000000] [--export 50000] [--repeat 3] [--writes 20000] [--out result.json]
 *   临时库在系统临时目录，结束即删；不碰仓库 data/ 与任何在用库。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'
import { runMigrations, MIGRATIONS_DIR } from '../server/db/migrations/runner.js'
import { insertAuditRow } from '../server/lib/audit-trail.js'
import { buildWhere, orderOf, countSql, exportChunks, parseFilters, viewRow, csvLine, AUDIT_COUNT_CAP } from '../server/lib/audit-view.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}

export const MODULES = ['sales', 'purchase', 'inventory', 'finance', 'master', 'auth', 'oms', 'pos', 'approval', 'report', 'settings', 'rare_mod']
export const ENTITIES = Array.from({ length: 40 }, (_, i) => `ent${i}`)

/** 合成审计行（偏斜：前几个 module/user 占大头，最后一个 module 与大号 user 极稀少） */
export function syntheticRow(rnd, i) {
  const skew = (n) => Math.floor(Math.pow(rnd(), 2.2) * n)
  const mod = i % 50000 === 49999 ? MODULES[MODULES.length - 1] : MODULES[skew(MODULES.length - 1)]
  const uid = i % 40000 === 39999 ? 499 : 1 + skew(480)
  return {
    userId: uid, userName: `user${uid}`, action: ['CREATE', 'UPDATE', 'APPROVE', 'DELETE', 'LOGIN', 'EXPORT'][skew(6)],
    module: mod, entity: ENTITIES[skew(ENTITIES.length)], entityId: String(Math.floor(rnd() * 200000)),
    detail: { before: { qty: Math.floor(rnd() * 100) }, after: { qty: Math.floor(rnd() * 100) }, note: `synthetic ${i}` }, ip: `10.0.${i % 250}.${i % 200}`
  }
}

/** 通过唯一 INSERT 点写 n 行；返回耗时 ms */
export function seed(db, n, rnd, start = 0) {
  const t0 = performance.now()
  const BATCH = 20000
  for (let b = start; b < start + n; b += BATCH) {
    db.transaction(() => { for (let i = b; i < Math.min(b + BATCH, start + n); i++) insertAuditRow(db, syntheticRow(rnd, i)) })()
  }
  return performance.now() - t0
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]
function time(fn, repeat) {
  fn() // 预热（页缓存、语句缓存）
  const xs = []
  let last
  for (let i = 0; i < repeat; i++) { const t = performance.now(); last = fn(); xs.push(performance.now() - t) }
  return { ms: Number(median(xs).toFixed(2)), all: xs.map(x => Number(x.toFixed(2))), value: last }
}
const planOf = (db, sql, params) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map(r => r.detail)

/** Z7 旧版 buildWhere（仅本脚本用到的过滤项；user 纯数字时 OR user_name） */
function legacyWhere(f) {
  const c = []; const a = []
  if (f.module) { c.push('module = ?'); a.push(f.module) }
  if (f.entity) { c.push('entity = ?'); a.push(f.entity) }
  if (f.entity_id) { c.push('entity_id = ?'); a.push(f.entity_id) }
  if (f.user) { c.push('(user_id = ? OR user_name = ?)'); a.push(Number(f.user), f.user) }
  if (f.from) { c.push('created_at >= ?'); a.push(`${f.from} 00:00:00`) }
  if (f.to) { c.push('created_at <= ?'); a.push(`${f.to} 23:59:59`) }
  return { where: c.length ? `WHERE ${c.join(' AND ')}` : '', args: a }
}

/** Z7 旧路径：整表 COUNT(*) + ORDER BY id DESC 列表 + id 游标导出 */
export function legacyCases(db, exportRows) {
  return caseFilters().map(c => {
    const { where, args } = legacyWhere(c.filters)
    const listSql = `SELECT * FROM audit_logs ${where} ORDER BY id DESC LIMIT ? OFFSET ?`
    const countSqlText = `SELECT COUNT(*) c FROM audit_logs ${where}`
    return {
      name: c.name,
      list: () => db.prepare(listSql).all(...args, 50, 0).map(viewRow).length,
      listSql: [listSql, [...args, 50, 0]],
      count: () => db.prepare(countSqlText).get(...args).c,
      countSql: [countSqlText, args],
      exportRun: () => {
        const rows = db.prepare(`SELECT COUNT(*) c FROM (SELECT 1 FROM audit_logs ${where} LIMIT ?)`).get(...args, exportRows + 1).c
        const exported = Math.min(rows, exportRows)
        const snapshotMax = db.prepare('SELECT COALESCE(MAX(id),0) m FROM audit_logs').get().m
        const step = db.prepare(`SELECT * FROM audit_logs ${where ? `${where} AND` : 'WHERE'} id < ? ORDER BY id DESC LIMIT ?`)
        let cursor = snapshotMax + 1; let sent = 0; let bytes = 0; let lines = 0
        while (sent < exported) {
          const batch = step.all(...args, cursor, Math.min(1000, exported - sent))
          if (!batch.length) break
          let chunk = ''
          for (const row of batch) chunk += csvLine(viewRow(row))
          cursor = batch[batch.length - 1].id; sent += batch.length; bytes += chunk.length; lines += batch.length
        }
        return { rows: lines, bytes }
      }
    }
  })
}

function caseFilters() {
  const mk = (name, query) => ({ name, filters: parseFilters(query) })
  return [
    mk('common module', { module: 'sales' }),
    mk('rare module', { module: 'rare_mod' }),
    mk('module + date range', { module: 'purchase', from: '2026-03-01', to: '2026-03-31' }),
    mk('rare user_id', { user: '499' }),
    mk('entity + entity_id', { entity: 'ent3', entity_id: '12345' }),
    mk('no filter', {})
  ]
}

export function cases(db, exportRows) {
  return caseFilters().map(c => {
    const { where, args } = buildWhere(c.filters)
    const order = orderOf(c.filters)
    return {
      ...c,
      list: () => db.prepare(`SELECT * FROM audit_logs ${where} ORDER BY ${order.sql} LIMIT ? OFFSET ?`).all(...args, 50, 0).map(viewRow).length,
      listSql: [`SELECT * FROM audit_logs ${where} ORDER BY ${order.sql} LIMIT ? OFFSET ?`, [...args, 50, 0]],
      count: () => db.prepare(countSql(where)).get(...args, AUDIT_COUNT_CAP + 1).c,
      countSql: [countSql(where), [...args, AUDIT_COUNT_CAP + 1]],
      exportRun: () => {
        const snapshotMax = db.prepare('SELECT COALESCE(MAX(id),0) m FROM audit_logs').get().m
        const rows = db.prepare(countSql(where)).get(...args, exportRows + 1).c
        const exported = Math.min(rows, exportRows)
        let bytes = 0
        let lines = 0
        for (const chunk of exportChunks(db, { where, args, order, snapshotMax, exported })) { bytes += chunk.length; lines += chunk.split('\r\n').length - 1 }
        return { rows: lines, bytes }
      }
    }
  })
}

function measure(db, repeat, exportRows, set) {
  const out = []
  for (const c of set(db, exportRows)) {
    const list = time(c.list, repeat)
    const count = time(c.count, repeat)
    const exp = time(c.exportRun, Math.max(1, Math.min(repeat, 2)))
    out.push({
      case: c.name,
      list_ms: list.ms, list_plan: planOf(db, ...c.listSql),
      count_ms: count.ms, count_value: count.value, count_plan: planOf(db, ...c.countSql),
      export_ms: exp.ms, export_rows: exp.value.rows, export_mb: Number((exp.value.bytes / 1048576).toFixed(1))
    })
  }
  return out
}

export async function main(argv = process.argv.slice(2)) {
  const o = { rows: 1000000, export: 50000, repeat: 3, writes: 20000, out: null }
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i].replace(/^--/, '')
    if (!(k in o) || argv[i + 1] === undefined) throw new Error(`未知或缺值参数 ${argv[i]}`)
    o[k] = k === 'out' ? argv[i + 1] : Number(argv[i + 1])
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-aa6-bench-'))
  const migDir = path.join(dir, 'migrations')
  fs.cpSync(MIGRATIONS_DIR, migDir, { recursive: true })
  fs.rmSync(path.join(migDir, '065_audit_log_indexes.cjs'))
  const db = new Database(path.join(dir, 'bench.db'))
  try {
    db.pragma('journal_mode=WAL'); db.pragma('synchronous=NORMAL'); db.pragma('foreign_keys=ON')
    db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
    runMigrations(db, { mode: 'test', warn: () => {}, migrationsDir: migDir })
    db.exec('DELETE FROM audit_logs')
    const rnd = mulberry32(20261023)
    const seedMs = seed(db, o.rows, rnd)
    db.exec(`UPDATE audit_logs SET created_at = datetime('2026-01-01', '+' || (id * 30) || ' seconds')`)
    const rows = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
    const sizeMb = (fs.statSync(path.join(dir, 'bench.db')).size / 1048576).toFixed(0)
    console.error(`[bench] seeded ${rows} rows in ${(seedMs / 1000).toFixed(1)}s (db ${sizeMb} MB, no 065 indexes)`)

    const wBefore = seed(db, o.writes, rnd, rows)
    const before = measure(db, o.repeat, o.export, legacyCases)
    const tIdx = performance.now()
    require('../server/db/migrations/065_audit_log_indexes.cjs').up(db)
    const indexBuildMs = performance.now() - tIdx
    const sizeIdx = (fs.statSync(path.join(dir, 'bench.db')).size / 1048576).toFixed(0)
    const wAfter = seed(db, o.writes, rnd, rows + o.writes)
    const after = measure(db, o.repeat, o.export, cases)
    const result = {
      generated_by: 'scripts/bench-audit-logs.mjs', node: process.version, platform: `${process.platform}-${process.arch}`,
      rows, export_rows: o.export, repeat: o.repeat, seed_ms: Math.round(seedMs),
      index_build_ms: Math.round(indexBuildMs), db_mb_before: Number(sizeMb), db_mb_after_indexes: Number(sizeIdx),
      write_ms_per_1k_before: Number((wBefore / o.writes * 1000).toFixed(2)), write_ms_per_1k_after: Number((wAfter / o.writes * 1000).toFixed(2)),
      before, after
    }
    if (o.out) fs.writeFileSync(path.resolve(o.out), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({ ...result, before: undefined, after: undefined }, null, 2))
    const row = (r) => `${r.case.padEnd(22)} list ${String(r.list_ms).padStart(9)}  count ${String(r.count_ms).padStart(9)} (=${r.count_value})  export ${String(r.export_ms).padStart(9)} (${r.export_rows} rows, ${r.export_mb} MB)`
    console.log('--- before 065'); before.forEach(r => console.log(row(r)))
    console.log('--- after 065'); after.forEach(r => console.log(row(r)))
    return result
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
}
