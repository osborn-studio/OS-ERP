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
 * 【诚实边界】进程内计时、单机单连接、机器有负载只看量级；合成数据不代表生产分布；不碰仓库 data/ 与任何在用库，临时目录结束即删。
 * 【用法】node scripts/bench-oms-order-time.mjs [--rows 200000] [--span 365] [--writes 5000] [--rounds 5] [--repeat 21] [--out result.json]
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

const SHIPPED = createRequire(import.meta.url)('../server/db/migrations/070_oms_order_time_index.cjs').INDEXES[0] // 迁移 070 发布的索引定义
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SCHEMA = fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : def
}
const ROWS = Number(arg('rows', 200000)), SPAN = Number(arg('span', 365)), WRITES = Number(arg('writes', 5000)), ROUNDS = Number(arg('rounds', 5)), REPEAT = Number(arg('repeat', 21))
const OUT = arg('out', null)

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
function genRow(rnd, i, platforms, spanDays, now) {
  const t = new Date(now - Math.floor(rnd() * spanDays * 86400000))
  const amt = Number((20 + rnd() * 400).toFixed(2))
  return [1 + (i % platforms), `BN${i}`, `buyer${i % 5000}`, ymdhms(t), ymdhms(t), STATUS[i % 5], amt, 0, 0, amt, `r${i % 900}`, '13800000000', `addr ${i % 4000}`, ymdhms(t), 'bench']
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
function time(fn, n) { fn(); const xs = []; for (let i = 0; i < n; i++) { const t = process.hrtime.bigint(); fn(); xs.push(Number(process.hrtime.bigint() - t) / 1e6) } return median(xs) }
const plan = (db, sql, params = []) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params).map((r) => r.detail)

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-ad3-bench-'))
try {
  const result = { rows: ROWS, span_days: SPAN, node: process.version, load1: os.loadavg()[0], queries: {}, build: {}, write: {} }
  const now = Date.now()
  const { db, file } = newDb(dir, 'main.db')
  db.exec('DROP INDEX IF EXISTS idx_oms_order_time') // "迁移 070 之前"的状态
  // AE3：平台绑定仓库 / 组织，受限范围（org 1 = 平台 1、2）才有可测的形态
  db.prepare("INSERT INTO warehouses (code, name, org_id) VALUES ('BW1','bw1',1),('BW2','bw2',2)").run()
  const [bw1, bw2] = db.prepare("SELECT id FROM warehouses WHERE code IN ('BW1','BW2') ORDER BY code").all().map((x) => x.id)
  db.prepare("INSERT INTO platforms (code, name, warehouse_id) VALUES ('B1','b1',?),('B2','b2',?),('B3','b3',?),('B4','b4',?),('B5','b5',?)").run(bw1, bw1, bw2, bw2, bw2)
  const pfs = db.prepare('SELECT COUNT(*) c FROM platforms').get().c
  const rnd = mulberry32(20261024)
  const ins = db.prepare(INS)
  db.transaction(() => { for (let i = 0; i < ROWS; i++) ins.run(...genRow(rnd, i, pfs, SPAN, now)) })()
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
        const same = JSON.stringify(db.prepare(olds[k][0]).all(...olds[k][1])) === JSON.stringify(db.prepare(st.sql).all(...st.params))
        if (!same) { result.ae3.results_identical = false; result.ae3.mismatches.push(`${k}.${sname}.${days}d`) }
      }
    }
  }
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
  for (let r = 0; r < ROUNDS; r++) {
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
  const txt = JSON.stringify(result, null, 2)
  if (OUT) fs.writeFileSync(path.resolve(OUT), txt + '\n')
  console.log(txt)
  if (!result.results_identical || !result.ae3.results_identical) { console.error(`新旧 SQL 结果不一致：${result.ae3.mismatches.join(', ') || 'trend/channel'}`); process.exitCode = 1 }
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}
