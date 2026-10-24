#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-audit-logs.mjs ｜ 审计日志检索基准：在合成百万行 audit_logs 上对比迁移 065 前后（roadmap-v6 AA6）
 * ============================================================================
 * 【职责】给 AA6 的三棵索引与"封顶计数 / 导出 5 万行"提供可重复的计时与 EXPLAIN 证据。
 *   · 在**全新临时目录**建库（schema.sql + 真实迁移运行器，但**不含 065 / 067**），用 `insertAuditRow`（audit_logs 的唯一 INSERT 点）
 *     写入 N 行合成审计（确定性：mulberry32 种子；module/user 偏斜分布、entity_id 高基数），再统一回填 created_at（默认 30 秒/行）；
 *   · "前"：无二级索引，跑一组代表性列表 / 封顶计数 / 导出 5 万行；"后"：执行迁移 065 的 `up`（记录建索引耗时），同一组再跑一遍；
 *   · 每项取 REPEAT 次的中位数，附 EXPLAIN QUERY PLAN；另测写路径（追加 WRITES 行）的写放大。
 * 【AB3】在 065 之后继续：应用迁移 067（FTS5）记录建表耗时 / 库增量 / 写放大，比较关键词 LIKE 与 FTS；再临时建 `created_at` 单列索引量化写放大与
 *   "只有日期区间"形态的收益（测完即删，不属于任何迁移）。
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
import { buildWhere, keywordUsesFts, orderOf, countSql, exportChunks, parseFilters, viewRow, csvLine, AUDIT_COUNT_CAP } from '../server/lib/audit-view.js'

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

/** AB3：关键词（LIKE vs FTS）与"只有日期区间"两类形态，列表（第 1 页）+ 封顶计数。fts=true 要求库里已有 audit_logs_fts */
export function keywordCases() {
  const mk = (name, query, fts) => ({ name, filters: parseFilters(query), fts })
  const out = []
  for (const fts of [false, true]) {
    const tag = fts ? 'fts' : 'like'
    out.push(mk(`keyword rare (user499) [${tag}]`, { keyword: 'user499' }, fts))
    out.push(mk(`keyword common (APPROVE) [${tag}]`, { keyword: 'APPROVE' }, fts))
    out.push(mk(`keyword entity (ent7) [${tag}]`, { keyword: 'ent7' }, fts))
    out.push(mk(`keyword absent (zzqq) [${tag}]`, { keyword: 'zzqq' }, fts))
    out.push(mk(`module+keyword (rare_mod, user) [${tag}]`, { module: 'rare_mod', keyword: 'user' }, fts))
  }
  return out
}
export function dateOnlyCases() {
  return [
    { name: 'date-only 1 day', filters: parseFilters({ from: '2026-06-01', to: '2026-06-01' }) },
    { name: 'date-only 1 month', filters: parseFilters({ from: '2026-06-01', to: '2026-06-30' }) }
  ]
}
export function measureShapes(db, repeat, set) {
  return set().map(c => {
    // fts 用例走与路由相同的选择：稀少命中 → FTS，命中很多 → LIKE（探测耗时计入每次计时，见 timedWhere）
    const pick = () => buildWhere(c.filters, { fts: !!c.fts && keywordUsesFts(db, c.filters.keyword) })
    const { where, args } = pick()
    const order = orderOf(c.filters)
    const listSql = `SELECT * FROM audit_logs ${where} ORDER BY ${order.sql} LIMIT ? OFFSET ?`
    const list = time(() => { const w = pick(); return db.prepare(`SELECT * FROM audit_logs ${w.where} ORDER BY ${order.sql} LIMIT ? OFFSET ?`).all(...w.args, 50, 0).map(viewRow).length }, repeat)
    const count = time(() => { const w = pick(); return db.prepare(countSql(w.where)).get(...w.args, AUDIT_COUNT_CAP + 1).c }, repeat)
    return { case: c.name, mode: where.includes('audit_logs_fts') ? 'fts' : 'like', list_ms: list.ms, list_rows: list.value, list_plan: planOf(db, listSql, [...args, 50, 0]), count_ms: count.ms, count_value: count.value, count_plan: planOf(db, countSql(where), [...args, AUDIT_COUNT_CAP + 1]) }
  })
}
/**
 * 写放大的对照实验：同一份种子分别建在**独立**的库里（仅 065 / 065+067 / 065+created_at 单列索引），交替执行若干轮
 * "逐行自动提交" 的 insertAuditRow（业务写入的真实形态：每个业务事务追加一两行审计），取每轮 µs/行的最小值与中位数。
 * 不在同一个库上顺序比较：大批量建索引/回填之后 WAL 与页缓存状态不同，会把"之后"的写入测慢（实测差几倍，与索引本身无关）。
 */
export function writeAmplification(o) {
  const seedRows = Math.min(o.rows, 200000)
  const perRound = Math.min(o.writes, 5000)
  const rounds = 5
  const m065 = require('../server/db/migrations/065_audit_log_indexes.cjs')
  const m067 = require('../server/db/migrations/067_audit_fts.cjs')
  const configs = {
    '065': () => {},
    '065+067(fts)': (d) => m067.up(d),
    '065+created_at': (d) => d.exec('CREATE INDEX idx_audit_created_probe ON audit_logs(created_at)')
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ab3-wamp-'))
  const handles = {}
  try {
    for (const [name, apply] of Object.entries(configs)) {
      const d = new Database(path.join(dir, `${name.replace(/\W/g, '_')}.db`))
      d.pragma('journal_mode=WAL'); d.pragma('synchronous=NORMAL')
      d.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
      d.exec('DELETE FROM audit_logs')
      seed(d, seedRows, mulberry32(1))
      m065.up(d); apply(d)
      handles[name] = { d, rnd: mulberry32(7), n: seedRows, us: [] }
    }
    for (let r = 0; r < rounds; r++) {
      for (const h of Object.values(handles)) {
        const t = performance.now()
        for (let i = 0; i < perRound; i++) insertAuditRow(h.d, syntheticRow(h.rnd, h.n + i))
        h.n += perRound
        h.us.push((performance.now() - t) * 1000 / perRound)
      }
    }
    const out = { seed_rows: seedRows, rows_per_round: perRound, rounds, mode: 'autocommit single-row insertAuditRow, rounds interleaved across separate DBs', configs: {} }
    for (const [name, h] of Object.entries(handles)) {
      const xs = [...h.us].sort((a, b) => a - b)
      out.configs[name] = { min_us_per_row: Number(xs[0].toFixed(1)), median_us_per_row: Number(xs[Math.floor(xs.length / 2)].toFixed(1)) }
    }
    return out
  } finally {
    for (const h of Object.values(handles)) h.d.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}
const mb = (dir) => Number((fs.statSync(path.join(dir, 'bench.db')).size / 1048576).toFixed(0))

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
  fs.rmSync(path.join(migDir, '067_audit_fts.cjs'))
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

    // ---- AB3：迁移 067（FTS5）----
    const likeKw = measureShapes(db, o.repeat, () => keywordCases().filter(c => !c.fts))
    const dateBefore = measureShapes(db, o.repeat, dateOnlyCases)
    const sizeBefore067 = mb(dir)
    const m067 = require('../server/db/migrations/067_audit_fts.cjs')
    const t067 = performance.now()
    db.transaction(() => m067.up(db))()
    const ftsBuildMs = performance.now() - t067
    const sizeFts = mb(dir)
    const ftsKw = measureShapes(db, o.repeat, () => keywordCases().filter(c => c.fts))
    // ---- AB3：created_at 单列索引的取舍（只测不装：测完删掉，保持库与生产迁移一致）----
    const tCreated = performance.now()
    db.exec('CREATE INDEX idx_audit_created_probe ON audit_logs(created_at)')
    const createdBuildMs = performance.now() - tCreated
    const sizeCreated = mb(dir)
    const dateAfter = measureShapes(db, o.repeat, dateOnlyCases)
    db.exec('DROP INDEX idx_audit_created_probe')
    const result = {
      generated_by: 'scripts/bench-audit-logs.mjs', node: process.version, platform: `${process.platform}-${process.arch}`,
      rows, export_rows: o.export, repeat: o.repeat, seed_ms: Math.round(seedMs),
      index_build_ms: Math.round(indexBuildMs), db_mb_before: Number(sizeMb), db_mb_after_indexes: Number(sizeIdx),
      write_ms_per_1k_before: Number((wBefore / o.writes * 1000).toFixed(2)), write_ms_per_1k_after: Number((wAfter / o.writes * 1000).toFixed(2)),
      ab3: {
        fts_build_ms: Math.round(ftsBuildMs), db_mb_before_067: sizeBefore067, db_mb_after_067: sizeFts,
        write_amplification: writeAmplification(o),
        keyword_like: likeKw, keyword_fts: ftsKw,
        created_at_index: { build_ms: Math.round(createdBuildMs), db_mb_after: sizeCreated, date_only_without: dateBefore, date_only_with: dateAfter }
      },
      before, after
    }
    if (o.out) fs.writeFileSync(path.resolve(o.out), `${JSON.stringify(result, null, 2)}\n`)
    console.log(JSON.stringify({ ...result, before: undefined, after: undefined, ab3: { ...result.ab3, keyword_like: undefined, keyword_fts: undefined, created_at_index: { ...result.ab3.created_at_index, date_only_without: undefined, date_only_with: undefined } } }, null, 2))
    const row = (r) => `${r.case.padEnd(22)} list ${String(r.list_ms).padStart(9)}  count ${String(r.count_ms).padStart(9)} (=${r.count_value})  export ${String(r.export_ms).padStart(9)} (${r.export_rows} rows, ${r.export_mb} MB)`
    console.log('--- before 065'); before.forEach(r => console.log(row(r)))
    console.log('--- after 065'); after.forEach(r => console.log(row(r)))
    const kwRow = (r) => `${r.case.padEnd(40)} list ${String(r.list_ms).padStart(9)}  count ${String(r.count_ms).padStart(9)} (=${r.count_value})`
    console.log('--- AB3 write amplification (µs/row, autocommit)'); for (const [k, v] of Object.entries(result.ab3.write_amplification.configs)) console.log(`${k.padEnd(18)} min ${v.min_us_per_row}  median ${v.median_us_per_row}`)
    console.log('--- AB3 keyword LIKE (065 only)'); likeKw.forEach(r => console.log(kwRow(r)))
    console.log('--- AB3 keyword FTS (067)'); ftsKw.forEach(r => console.log(kwRow(r)))
    console.log('--- AB3 date-only, no created_at index'); dateBefore.forEach(r => console.log(kwRow(r)))
    console.log('--- AB3 date-only, with created_at index'); dateAfter.forEach(r => console.log(kwRow(r)))
    return result
  } finally {
    db.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1) })
}
