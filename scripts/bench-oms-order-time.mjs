#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-oms-order-time.mjs ｜ oms_orders.order_time 索引基准：计划 / 延迟前后对比与写放大（roadmap-v9 AD3）
 * ============================================================================
 * 【职责】给迁移 070 提供可重复的证据：在**全新临时目录**建库（schema.sql + 真实迁移运行器，随后删掉 idx_oms_order_time 造出"迁移前"状态），
 *   灌入 N 行合成 OMS 订单（确定性 mulberry32；时间分布在最近 --span 天，状态五种轮换，若干平台），然后
 *   · "前"：旧 SQL（`date(order_time) >= …`）在无索引库上的 EXPLAIN 与中位耗时；"后"：建索引（记录耗时与库增量），新 SQL（dashboard-sql.js 同一份）再测；
 *   · 写放大：独立库交替追加 --writes 行（逐行自动提交，与 H5 商城 / 平台同步的单行写入同形），无索引 / 迁移 070 的索引 / 单列索引变体各 --rounds 轮，取最小值与中位数（µs/行）。
 *   · 同时核对新旧 SQL 返回相同行（trend / channel）。
 *   · AE3：同样的前 / 后对比扩到 `oms-sql.js` 的 /stats 四条（全局与受限组织范围）与 AI 平台分析，结果放在输出的 `ae3` 键下（计划、中位耗时、新旧是否相同）。
 *   · AF3（ADR-0044 补充 5）：在同一张合成表上比较三种状态——S0（仅迁移 070）、S1（+迁移 074 的 `idx_oms_items_order`，已发布）、被否决的备选 B（+`oms_orders(platform_id, order_time, status, pay_amount)`）——
 *     下的 AE3 写法与 AF3 写法（p50 / p95、计划），核对 AF3 写法与最初的 `date(order_time)` 旧 SQL 在整数 / 文本 / 行序上逐项相同、浮点列相对误差，以及各索引的体积与写放大（订单 + 两行明细的 µs/单）。结果在 `af3` 键下。
 * 【诚实边界】进程内计时、单机单连接、机器有负载只看量级；合成数据不代表生产分布；不碰仓库 data/ 与任何在用库，临时目录结束即删。
 * 【用法】node scripts/bench-oms-order-time.mjs [--rows 200000] [--span 365] [--writes 5000] [--rounds 5] [--repeat 21] [--no-write] [--ordered] [--out result.json]
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { createRequire } from 'node:module'
import { runMigrations } from '../server/db/migrations/runner.js'
import { trendOnlineSql, channelOnlineSql, onlineWindow } from '../server/lib/dashboard-sql.js'
import { omsStatsByPlatformStmt, omsStatsTrendStmt, omsStatsTotalStmt, omsStatsTopSkusStmt, aiPlatformAnalysisStmt } from '../server/lib/oms-sql.js'
import { omsPlatformScopeSql, omsOrderScopeSql } from '../server/lib/sales-order.js'

const ITEMS_IX = createRequire(import.meta.url)('../server/db/migrations/074_oms_items_order_index.cjs').INDEXES[0] // 迁移 074 发布的索引定义（AF3）
const SHIPPED = createRequire(import.meta.url)('../server/db/migrations/070_oms_order_time_index.cjs').INDEXES[0] // 迁移 070 发布的索引定义
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const ROWS = Number(arg('rows', 200000)), SPAN = Number(arg('span', 365)), WRITES = Number(arg('writes', 5000)), ROUNDS = Number(arg('rounds', 5)), REPEAT = Number(arg('repeat', 21))
const OUT = arg('out', null)
const ORDERED = process.argv.includes('--ordered') // 订单时间随 id 单调（±6h 抖动）：更接近真实落库顺序；默认（时间与 id 无关）对"按时间窗口取订单"的索引计划偏不利
const NO_WRITE = process.argv.includes('--no-write') // 只做读基准（写放大与 --span 无关，换分布重跑时不必重复）

function mulberry32(a) {
  return () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
}
const pad = (n) => String(n).padStart(2, '0')
const ymdhms = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
const STATUS = ['pending', 'shipped', 'completed', 'refunded', 'closed']

const OLD = (days) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    trend: `SELECT date(order_time) AS date, COALESCE(SUM(pay_amount),0) amount FROM oms_orders WHERE date(order_time) >= ${from} GROUP BY date(order_time) ORDER BY date`,
    channel: `SELECT COALESCE(pf.name,'未知平台') AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount FROM oms_orders o LEFT JOIN platforms pf ON pf.id=o.platform_id WHERE date(o.order_time) >= ${from} AND o.status NOT IN ('refunded','closed') GROUP BY pf.id`
  }
}

/** AE3：旧写法（逐字取自 AE3 之前的 oms.js / ai.js），scope 为 { ps, os, os0 } */
const OLD_AE3 = (days, sc) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    stats_by_platform: [`SELECT pf.name AS platform_name, pf.code, COUNT(o.id) orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('refunded','closed') THEN o.pay_amount ELSE 0 END),0) gmv,
                COALESCE(SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN o.status='refunded' THEN o.pay_amount ELSE 0 END),0) refund_amount
         FROM platforms pf LEFT JOIN oms_orders o ON o.platform_id=pf.id AND date(o.order_time) >= ${from}
         WHERE ${sc.ps.sql} GROUP BY pf.id ORDER BY gmv DESC`, sc.ps.params],
    stats_trend: [`SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${sc.os0.sql} GROUP BY date(order_time) ORDER BY date`, sc.os0.params],
    stats_total: [`SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv,
                COALESCE(AVG(pay_amount),0) avg_amount,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) refunded
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${sc.os0.sql}`, sc.os0.params],
    stats_top_skus: [`SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE date(o.order_time) >= ${from} AND ${sc.os.sql}
         GROUP BY i.title ORDER BY amount DESC LIMIT 10`, sc.os.params],
    ai_platform: [`SELECT pf.name AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount FROM oms_orders o
             JOIN platforms pf ON pf.id=o.platform_id WHERE date(o.order_time) >= ${from} GROUP BY pf.id ORDER BY amount DESC`, []]
  }
}
const NEW_AE3 = (days, sc) => ({
  stats_by_platform: omsStatsByPlatformStmt(days, sc.ps), stats_trend: omsStatsTrendStmt(days, sc.os0), stats_total: omsStatsTotalStmt(days, sc.os0),
  stats_top_skus: omsStatsTopSkusStmt(days, sc.os), ai_platform: aiPlatformAnalysisStmt(days)
})
/** AF3 之前（AE3）的写法，逐字取自当时的 oms-sql.js：byPlatform 平台驱动 + ON 里的窗口谓词，受限范围谓词不加 likely() */
const AE3_FORM = (days, sc) => {
  const w = onlineWindow(days)
  return {
    stats_by_platform: { sql: `SELECT pf.name AS platform_name, pf.code, COUNT(o.id) orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('refunded','closed') THEN o.pay_amount ELSE 0 END),0) gmv,
                COALESCE(SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN o.status='refunded' THEN o.pay_amount ELSE 0 END),0) refund_amount
         FROM platforms pf LEFT JOIN oms_orders o ON o.platform_id=pf.id AND o.order_time >= ? AND date(o.order_time) >= ?
         WHERE ${sc.ps.sql} GROUP BY pf.id ORDER BY gmv DESC`, params: [...w, ...sc.ps.params] },
    stats_trend: { sql: `SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${sc.os0.sql} GROUP BY date(order_time) ORDER BY date`, params: [...w, ...sc.os0.params] },
    stats_total: { sql: `SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv,
                COALESCE(AVG(pay_amount),0) avg_amount,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) refunded
         FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ? AND ${sc.os0.sql}`, params: [...w, ...sc.os0.params] },
    stats_top_skus: { sql: `SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE o.order_time >= ? AND date(o.order_time) >= ? AND ${sc.os.sql}
         GROUP BY i.title ORDER BY amount DESC LIMIT 10`, params: [...w, ...sc.os.params] }
  }
}
/** 浮点列相对误差上界；非数值列（文本 / 整数键）必须严格相等，行序必须一致。返回 { same, maxRel } */
function compareRows(got, want) {
  if (got.length !== want.length) return { same: false, maxRel: Infinity }
  let maxRel = 0
  for (let i = 0; i < got.length; i++) {
    for (const k of Object.keys(want[i])) {
      const a = got[i][k], b = want[i][k]
      if (typeof a === 'number' && typeof b === 'number') maxRel = Math.max(maxRel, Math.abs(a - b) / Math.max(1, Math.abs(a), Math.abs(b)))
      else if (a !== b) return { same: false, maxRel: Infinity }
    }
  }
  return { same: maxRel <= 1e-9, maxRel }
}
const scopeOf = (orgScope) => ({ ps: omsPlatformScopeSql(orgScope, 'pf'), os: omsOrderScopeSql(orgScope, 'o'), os0: omsOrderScopeSql(orgScope, 'oms_orders') })

function newDb(dir, name) {
  const file = path.join(dir, name)
  const db = new Database(file)
  db.pragma('journal_mode=WAL')
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.pragma('foreign_keys=OFF')
  return { db, file }
}
const INS = 'INSERT INTO oms_orders (platform_id, platform_order_no, buyer_nick, order_time, pay_time, status, goods_amount, freight, discount_amount, pay_amount, receiver, receiver_phone, receiver_address, sync_at, remark) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)'
function genRow(rnd, i, platforms, spanDays, now, orderedTotal = 0) {
  const t = new Date(orderedTotal
    ? now - Math.floor((1 - i / orderedTotal) * spanDays * 86400000 + (rnd() - 0.5) * 12 * 3600000)
    : now - Math.floor(rnd() * spanDays * 86400000))
  const amt = Number((20 + rnd() * 400).toFixed(2))
  return [1 + (i % platforms), `BN${i}`, `buyer${i % 5000}`, ymdhms(t), ymdhms(t), STATUS[i % 5], amt, 0, 0, amt, `r${i % 900}`, '13800000000', `addr ${i % 4000}`, ymdhms(t), 'bench']
}
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
function time(fn, n) { fn(); const xs = []; for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); fn(); xs.push(Number(process.hrtime.bigint() - t) / 1e6) } return median(xs) }
/** p50 / p95 / 最小值（ms）；先热一次 */
function timeStats(fn, n) { fn(); const xs = []; for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); fn(); xs.push(Number(process.hrtime.bigint() - t) / 1e6) } return { p50: median(xs), p95: pct(xs, 0.95), min: Math.min(...xs) } }
const plan = (db, sql, params = []) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ad3-bench-'))
try {
  const result = { rows: ROWS, span_days: SPAN, ordered: ORDERED, node: process.version, load1: os.loadavg()[0], queries: {}, build: {}, write: {} }
  const now = Date.now()
  const { db, file } = newDb(dir, 'main.db')
  db.exec('DROP INDEX IF EXISTS idx_oms_order_time') // "迁移 070 之前"的状态
  db.exec(`DROP INDEX IF EXISTS ${ITEMS_IX.name}`) // 迁移 074（AF3）之前的状态：AE3 的前后对比不应夹带 074
  // AE3：平台绑定仓库 / 组织，受限范围（org 1 = 平台 1、2）才有可测的形态
  db.prepare("INSERT INTO warehouses (code, name, org_id) VALUES ('BW1','bw1',1),('BW2','bw2',2)").run()
  const [bw1, bw2] = db.prepare("SELECT id FROM warehouses WHERE code IN ('BW1','BW2') ORDER BY code").all().map((x) => x.id)
  db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('B1','b1',?),('B2','b2',?),('B3','b3',?),('B4','b4',?),('B5','b5',?)").run(bw1, bw1, bw2, bw2, bw2)
  const pfs = db.prepare('SELECT COUNT(*) c FROM platforms').get().c
  const rnd = mulberry32(20261024)
  const ins = db.prepare(INS)
  db.transaction(() => { for (let i = 0; i < ROWS; i++) ins.run(...genRow(rnd, i, pfs, SPAN, now, ORDERED ? ROWS : 0)) })()
  // AE3：每单一行明细（/stats topSkus 要连明细表），标题 200 种
  db.exec(`INSERT INTO oms_order_items (oms_order_id, title, qty, price, amount) SELECT id, 'sku-' || (id % 200), 1 + (id % 3), pay_amount, pay_amount FROM oms_orders`)
  // 刻意不跑 ANALYZE：应用本身从不跑（同 synth-data.mjs），统计表会让规划器改选 idx_oms_status 的 skip-scan，测到的就不是应用真实会选的计划
  const sizeBefore = fs.statSync(file).size
  for (const days of [30, 90]) {
    const old = OLD(days)
    const before = { trend: time(() => db.prepare(old.trend).all(), REPEAT), channel: time(() => db.prepare(old.channel).all(), REPEAT) }
    result.queries[`before_${days}d`] = { ms: before, plan: { trend: plan(db, old.trend), channel: plan(db, old.channel) } }
  }
  // AE3 "前"：/stats 四条与 AI 平台分析的旧 SQL，无索引；全局与受限组织范围（org 1 = 平台 1、2）
  const SCOPES = { global: scopeOf({ scope: 'all' }), org1: scopeOf({ orgIds: [1] }) }
  result.ae3 = { before: {}, after: {}, results_identical: true, mismatches: [] }
  for (const [sname, sc] of Object.entries(SCOPES)) {
    for (const days of [30, 90]) {
      for (const [k, [sql, params]] of Object.entries(OLD_AE3(days, sc))) {
        if (k === 'ai_platform' && sname !== 'global') continue
        result.ae3.before[`${k}.${sname}.${days}d`] = { ms: time(() => db.prepare(sql).all(...params), Math.min(REPEAT, 11)), plan: plan(db, sql, params) }
      }
    }
  }
  const t0 = process.hrtime.bigint()
  db.exec(`CREATE INDEX ${SHIPPED.name} ON oms_orders(${SHIPPED.cols})`)
  result.build = { create_index_ms: Number(process.hrtime.bigint() - t0) / 1e6, db_bytes_before: sizeBefore }
  db.pragma('wal_checkpoint(TRUNCATE)')
  result.build.db_bytes_after = fs.statSync(file).size
  let equal = true
  for (const days of [30, 90]) {
    const w = onlineWindow(days)
    const after = { trend: time(() => db.prepare(trendOnlineSql()).all(...w), REPEAT), channel: time(() => db.prepare(channelOnlineSql()).all(...w), REPEAT) }
    result.queries[`after_${days}d`] = { ms: after, plan: { trend: plan(db, trendOnlineSql(), w), channel: plan(db, channelOnlineSql(), w) } }
    const old = OLD(days)
    equal = equal && JSON.stringify(db.prepare(old.trend).all()) === JSON.stringify(db.prepare(trendOnlineSql()).all(...w))
    equal = equal && JSON.stringify(db.prepare(old.channel).all()) === JSON.stringify(db.prepare(channelOnlineSql()).all(...w))
  }
  result.results_identical = equal
  // AE3 "后"：oms-sql.js 的新 SQL + 迁移 070 索引；逐条核对与旧 SQL 结果相同
  for (const [sname, sc] of Object.entries(SCOPES)) {
    for (const days of [30, 90]) {
      const olds = OLD_AE3(days, sc), news = NEW_AE3(days, sc)
      for (const k of Object.keys(olds)) {
        if (k === 'ai_platform' && sname !== 'global') continue
        const st = news[k]
        result.ae3.after[`${k}.${sname}.${days}d`] = { ms: time(() => db.prepare(st.sql).all(...st.params), Math.min(REPEAT, 11)), plan: plan(db, st.sql, st.params) }
        // AF3 起浮点列的累加顺序随计划变化：整数 / 文本 / 行序严格相等，浮点列相对误差 <= 1e-9
        const same = compareRows(db.prepare(st.sql).all(...st.params), db.prepare(olds[k][0]).all(...olds[k][1])).same
        if (!same) { result.ae3.results_identical = false; result.ae3.mismatches.push(`${k}.${sname}.${days}d`) }
      }
    }
  }
  // ---- AF3：S0（仅 070）/ S1（+074 items 索引，已发布）/ 备选 B（+ (platform_id, order_time, status, pay_amount)）下的 AE3 写法与 AF3 写法 ----
  // 四种索引状态各用一份库副本、各开一个连接；计时时对每条语句**轮转**所有（状态 × 写法）配置，每轮每个配置跑一次——整机负载漂移同时落在所有配置上，比逐配置连续计时可比得多。
  result.af3 = { states: {}, identical: true, max_rel_diff: 0, mismatches: [], build: {}, note: 'configs interleaved round-robin per repetition; p50/p95 over --repeat runs' }
  const AF3_KEYS = ['stats_by_platform', 'stats_trend', 'stats_total', 'stats_top_skus']
  const B_COLS = 'platform_id, order_time, status, pay_amount'
  db.pragma('wal_checkpoint(TRUNCATE)')
  // S1cov：被否决的覆盖版明细索引 (oms_order_id, title, qty, amount)，与已发布的单列版对比
  const stateDefs = { S0: { items: false, b: false }, 'S0+B': { items: false, b: true }, S1: { items: true, b: false }, 'S1+B': { items: true, b: true }, S1cov: { items: 'cover', b: false } }
  const conns = {}
  const dbPages = (c, name) => { try { return c.prepare('SELECT SUM(pgsize) b FROM dbstat WHERE name=?').get(name).b } catch { return null } }
  for (const [name, def] of Object.entries(stateDefs)) {
    const f = path.join(dir, `af3-${name.replace('+', '_')}.db`)
    fs.copyFileSync(file, f)
    const c = new Database(f); c.pragma('journal_mode=WAL'); c.pragma('foreign_keys=OFF')
    c.exec(`DROP INDEX IF EXISTS ${ITEMS_IX.name}; DROP INDEX IF EXISTS idx_bench_platform_time`)
    const b = {}
    if (def.items) { const t = process.hrtime.bigint(); c.exec(`CREATE INDEX ${ITEMS_IX.name} ON ${ITEMS_IX.table}(${def.items === 'cover' ? 'oms_order_id, title, qty, amount' : ITEMS_IX.cols})`); b.items_create_ms = Number(process.hrtime.bigint() - t) / 1e6; b.items_index_bytes = dbPages(c, ITEMS_IX.name) }
    if (def.b) { const t = process.hrtime.bigint(); c.exec(`CREATE INDEX idx_bench_platform_time ON oms_orders(${B_COLS})`); b.b_create_ms = Number(process.hrtime.bigint() - t) / 1e6; b.b_index_bytes = dbPages(c, 'idx_bench_platform_time') }
    c.pragma('wal_checkpoint(TRUNCATE)')
    conns[name] = c
    result.af3.build[name] = b
    result.af3.states[name] = {}
  }
  for (const [sname, sc] of Object.entries(SCOPES)) {
    for (const days of [30, 90]) {
      const olds = OLD_AE3(days, sc), ae3 = AE3_FORM(days, sc)
      const af3 = { stats_by_platform: omsStatsByPlatformStmt(days, sc.ps), stats_trend: omsStatsTrendStmt(days, sc.os0), stats_total: omsStatsTotalStmt(days, sc.os0), stats_top_skus: omsStatsTopSkusStmt(days, sc.os) }
      for (const k of AF3_KEYS) {
        const cfgs = []
        for (const state of Object.keys(stateDefs)) for (const form of ['ae3', 'af3']) cfgs.push({ state, form, st: form === 'ae3' ? ae3[k] : af3[k], xs: [], cpu: [] })
        for (const c of cfgs) {
          const cn = conns[c.state]
          const cmp = compareRows(cn.prepare(c.st.sql).all(...c.st.params), cn.prepare(olds[k][0]).all(...olds[k][1]))
          if (cmp.maxRel !== Infinity) result.af3.max_rel_diff = Math.max(result.af3.max_rel_diff, cmp.maxRel)
          if (!cmp.same) { result.af3.identical = false; result.af3.mismatches.push(`${c.state}:${k}.${sname}.${days}d.${c.form}`) }
        }
        for (let rep = 0; rep <= REPEAT; rep++) { // rep 0 预热
          for (const c of cfgs) {
            const u0 = process.cpuUsage(), t = process.hrtime.bigint()
            conns[c.state].prepare(c.st.sql).all(...c.st.params)
            if (rep > 0) { c.xs.push(Number(process.hrtime.bigint() - t) / 1e6); const u = process.cpuUsage(u0); c.cpu.push((u.user + u.system) / 1e3) }
          }
        }
        for (const c of cfgs) result.af3.states[c.state][`${k}.${sname}.${days}d.${c.form}`] = { p50: median(c.xs), p95: pct(c.xs, 0.95), min: Math.min(...c.xs), cpu_p50: median(c.cpu), cpu_p95: pct(c.cpu, 0.95), plan: plan(conns[c.state], c.st.sql, c.st.params) }
      }
    }
  }
  for (const c of Object.values(conns)) c.close()
  if (!result.af3.identical) result.ae3.results_identical = false
  // 仅供对比、不随迁移发布：单列 (order_time) 索引——每命中一行都要回表，窗口覆盖的行占比高时比整表扫描更慢
  db.exec('DROP INDEX idx_oms_order_time')
  db.exec('CREATE INDEX tmp_plain ON oms_orders(order_time)')
  db.pragma('wal_checkpoint(TRUNCATE)')
  result.plain_variant = {} // 文件大小不在此比较：DROP INDEX 后空闲页留在文件里，量不准；索引体积见 build.db_bytes_after - db_bytes_before（迁移 070 的索引）
  for (const days of [30, 90]) {
    const w = onlineWindow(days)
    result.plain_variant[`${days}d`] = {
      ms: { trend: time(() => db.prepare(trendOnlineSql()).all(...w), REPEAT), channel: time(() => db.prepare(channelOnlineSql()).all(...w), REPEAT) },
      plan: { trend: plan(db, trendOnlineSql(), w), channel: plan(db, channelOnlineSql(), w) }
    }
  }
  db.exec('DROP INDEX tmp_plain')
  db.close()

  // 写放大：独立库交替，逐行自动提交（单行写入同形）
  const perRow = { without: [], with: [], plain: [] }
  for (let r = 0; r < (NO_WRITE ? 0 : ROUNDS); r++) {
    const modes = ['without', 'with', 'plain']
    for (const mode of modes.slice(r % 3).concat(modes.slice(0, r % 3))) {
      const w = newDb(dir, `w-${mode}-${r}.db`)
      if (mode !== 'with') w.db.exec('DROP INDEX IF EXISTS idx_oms_order_time')
      if (mode === 'plain') w.db.exec('CREATE INDEX tmp_plain ON oms_orders(order_time)')
      w.db.prepare("INSERT INTO platforms (code, name) VALUES ('B1','b1'),('B2','b2'),('B3','b3'),('B4','b4'),('B5','b5')").run()
      const wi = w.db.prepare(INS)
      const g = mulberry32(7 + r)
      const seed = Math.min(ROWS, 100000)
      w.db.transaction(() => { for (let i = 0; i < seed; i++) wi.run(...genRow(g, i, 5, SPAN, now)) })()
      const t1 = process.hrtime.bigint()
      for (let i = 0; i < WRITES; i++) wi.run(...genRow(g, seed + i, 5, 30, now))
      perRow[mode].push(Number(process.hrtime.bigint() - t1) / 1e3 / WRITES)
      w.db.close()
      for (const suf of ['', '-wal', '-shm']) fs.rmSync(w.file + suf, { force: true })
    }
  }
  result.write = {
    seed_rows: Math.min(ROWS, 100000), writes_per_round: WRITES, rounds: ROUNDS,
    us_per_row_without: { min: Math.min(...perRow.without), median: median(perRow.without) },
    us_per_row_with: { min: Math.min(...perRow.with), median: median(perRow.with) },
    us_per_row_plain_variant: { min: Math.min(...perRow.plain), median: median(perRow.plain) },
    ratio_min: Math.min(...perRow.with) / Math.min(...perRow.without),
    ratio_min_plain_variant: Math.min(...perRow.plain) / Math.min(...perRow.without)
  }
  if (NO_WRITE) result.write = { skipped: '--no-write' }
  // AF3 写放大：一单 = 1 行 oms_orders + 2 行 oms_order_items，逐单自动提交；四种索引状态交替，各 --rounds 轮
  {
    const MODES = { base: [], items: [ITEMS_IX], items_cover: ['COVER'], b: ['B'], items_b: [ITEMS_IX, 'B'] }
    const perOrder = Object.fromEntries(Object.keys(MODES).map((m) => [m, []]))
    const perOrderCpu = Object.fromEntries(Object.keys(MODES).map((m) => [m, []]))
    const insItem = 'INSERT INTO oms_order_items (oms_order_id, title, qty, price, amount) VALUES (?,?,?,?,?)'
    for (let r = 0; r < (NO_WRITE ? 0 : ROUNDS); r++) {
      const names = Object.keys(MODES)
      for (const mode of names.slice(r % names.length).concat(names.slice(0, r % names.length))) {
        const w = newDb(dir, `w3-${mode}-${r}.db`)
        w.db.exec(`DROP INDEX IF EXISTS ${ITEMS_IX.name}`) // 迁移 074 已建，先还原到 S0 再按 mode 加
        for (const ix of MODES[mode]) w.db.exec(ix === 'B' ? 'CREATE INDEX tmp_b ON oms_orders(platform_id, order_time, status, pay_amount)' : ix === 'COVER' ? `CREATE INDEX ${ITEMS_IX.name} ON ${ITEMS_IX.table}(oms_order_id, title, qty, amount)` : `CREATE INDEX ${ix.name} ON ${ix.table}(${ix.cols})`)
        w.db.prepare("INSERT INTO platforms (code, name) VALUES ('B1','b1'),('B2','b2'),('B3','b3'),('B4','b4'),('B5','b5')").run()
        const wi = w.db.prepare(INS), wit = w.db.prepare(insItem)
        const g = mulberry32(31 + r)
        const seed = Math.min(ROWS, 100000)
        w.db.transaction(() => { for (let i = 0; i < seed; i++) { const row = genRow(g, i, 5, SPAN, now); const id = Number(wi.run(...row).lastInsertRowid); wit.run(id, `sku-${i % 200}`, 1, row[9], row[9]); wit.run(id, `sku-${(i + 7) % 200}`, 1, row[9], row[9]) } })()
        const rows = Array.from({ length: WRITES }, (_, i) => genRow(g, seed + i, 5, 30, now)) // 行先生成好，计时只含写入
        const c0 = process.cpuUsage(), t1 = process.hrtime.bigint()
        for (let i = 0; i < WRITES; i++) { const row = rows[i]; const id = Number(wi.run(...row).lastInsertRowid); wit.run(id, `sku-${i % 200}`, 1, row[9], row[9]); wit.run(id, `sku-${(i + 7) % 200}`, 1, row[9], row[9]) }
        perOrder[mode].push(Number(process.hrtime.bigint() - t1) / 1e3 / WRITES)
        const cu = process.cpuUsage(c0); perOrderCpu[mode].push((cu.user + cu.system) / WRITES)
        w.db.close()
        for (const suf of ['', '-wal', '-shm']) fs.rmSync(w.file + suf, { force: true })
      }
    }
    result.af3.write = { unit: 'us per order (1 oms_orders row + 2 oms_order_items rows, autocommit per statement); wall-clock and CPU (user+sys) both recorded', seed_orders: Math.min(ROWS, 100000), orders_per_round: WRITES, rounds: ROUNDS }
    if (!NO_WRITE) for (const m of Object.keys(MODES)) result.af3.write[m] = { min: Math.min(...perOrder[m]), median: median(perOrder[m]), cpu_min: Math.min(...perOrderCpu[m]), cpu_median: median(perOrderCpu[m]) }
    if (!NO_WRITE) for (const m of ['items', 'items_cover', 'b', 'items_b']) { result.af3.write[`ratio_min_${m}`] = result.af3.write[m].min / result.af3.write.base.min; result.af3.write[`ratio_cpu_median_${m}`] = result.af3.write[m].cpu_median / result.af3.write.base.cpu_median }
  }
  const txt = JSON.stringify(result, null, 2)
  if (OUT) fs.writeFileSync(path.resolve(OUT), txt + '\n')
  console.log(txt)
  if (!result.results_identical || !result.ae3.results_identical || !result.af3.identical) { console.error(`新旧 SQL 结果不一致：${[...result.ae3.mismatches, ...result.af3.mismatches].join(', ') || 'trend/channel'}`); process.exitCode = 1 }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
