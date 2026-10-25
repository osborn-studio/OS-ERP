#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/bench-oms-dense-window.mjs ｜ 大库上 OMS /stats 语句在"密集窗口"下的延迟（p50 / p95），只读（roadmap-v13 AH3，ADR-0044 补充 7）
 * ============================================================================
 * 【职责】AF3 的最坏情形（订单几乎全在最近 60 天，窗口覆盖大部分行，订单窗口驱动要对每个窗口内订单随机探一次明细索引）在小库上看不出来。
 *   本脚本对 explain-audit 的大库（`--scale large` 灌的 20 万 OMS 单 + 每单一行明细，时间落在锚点前 60 天、随 id 递增）实测
 *   `oms-sql.js` 的 byPlatform / trend / total / topSkus 与 AI 平台分析：30 / 90 天窗口 × 全局 / 受限组织（org 1）。
 *   窗口的"现在"取锚点后一天（--now，默认 2026-10-02），所以 30 / 90 天窗口覆盖的是数据而不是空区间。
 * 【怎么测】库以 readonly 打开（不改文件）；所有语句轮转计时（每轮每条一次，rep 0 预热），整机负载漂移落在所有语句上；输出 p50 / p95 / 窗口内订单数（window_rows_all = 全部平台的订单数，受限组织语句实际处理的更少）/ 计划。
 * 【诚实边界】进程内计时、单连接、整机负载只看量级；合成数据；不是目标主机（dmserver）的结果，也不是容量承诺。库里有 sqlite_stat1 时照测但在结果里标 has_stat1（那时测的是"开了优化之后"的计划）。
 * 【用法】node scripts/bench-oms-dense-window.mjs --dir /abs/dir-with-gml_cosmetic.db [--industry cosmetic] [--repeat 31] [--now 2026-10-02] [--out result.json]
 *   退出码：0 完成；2 用法 / 路径拒绝。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { omsStatsByPlatformStmt, omsStatsTrendStmt, omsStatsTotalStmt, omsStatsTopSkusStmt, aiPlatformAnalysisStmt } from '../server/lib/oms-sql.js'
import { omsPlatformScopeSql, omsOrderScopeSql } from '../server/lib/sales-order.js'
import { onlineWindow } from '../server/lib/dashboard-sql.js'
import { resolveLargeDir } from './lib/explain-large.mjs'

const usage = (m) => { console.error(`bench-oms-dense-window: ${m}`); process.exit(2) }
const argv = process.argv.slice(2)
const o = { dir: null, industry: 'cosmetic', repeat: 31, now: '2026-10-02', out: null }
for (let i = 0; i < argv.length; i++) {
  const k = { '--dir': 'dir', '--industry': 'industry', '--repeat': 'repeat', '--now': 'now', '--out': 'out' }[argv[i]]
  if (!k || argv[i + 1] === undefined) usage(`未知或缺值参数 ${argv[i]}`)
  o[k] = argv[++i]
}
o.repeat = Number(o.repeat)
if (!Number.isInteger(o.repeat) || o.repeat < 1 || o.repeat > 1000) usage('--repeat 必须是 1..1000 的整数')
if (!/^[a-z]+$/.test(o.industry)) usage('--industry 非法')
const now = new Date(`${o.now}T00:00:00Z`)
if (Number.isNaN(now.getTime())) usage('--now 必须是 YYYY-MM-DD')
let file
try { file = resolveLargeDir(o.dir, o.industry) } catch (e) { usage(e.message) }

const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * q))] }
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)] }
const scopeOf = (orgScope) => ({ ps: omsPlatformScopeSql(orgScope, 'pf'), os: omsOrderScopeSql(orgScope, 'o'), os0: omsOrderScopeSql(orgScope, 'oms_orders') })
const SCOPES = { global: scopeOf({ scope: 'all' }), org1: scopeOf({ orgIds: [1] }) }

const db = new Database(file, { readonly: true, fileMustExist: true })
try {
  const cfgs = []
  for (const [sname, sc] of Object.entries(SCOPES)) {
    for (const days of [30, 90]) {
      const set = {
        stats_by_platform: omsStatsByPlatformStmt(days, sc.ps, now), stats_trend: omsStatsTrendStmt(days, sc.os0, now),
        stats_total: omsStatsTotalStmt(days, sc.os0, now), stats_top_skus: omsStatsTopSkusStmt(days, sc.os, now)
      }
      if (sname === 'global') set.ai_platform = aiPlatformAnalysisStmt(days, now)
      for (const [k, st] of Object.entries(set)) cfgs.push({ name: `${k}.${sname}.${days}d`, st, xs: [], window_rows_all: db.prepare('SELECT COUNT(*) c FROM oms_orders WHERE order_time >= ? AND date(order_time) >= ?').get(...onlineWindow(days, now)).c })
    }
  }
  for (let rep = 0; rep <= o.repeat; rep++) { // rep 0 预热
    for (const c of cfgs) {
      const t = process.hrtime.bigint()
      const got = db.prepare(c.st.sql).all(...c.st.params)
      c.rows_returned = got.length
      if (rep > 0) c.xs.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
  }
  const result = {
    scope_notice: 'Mac mini or whatever host ran this / synthetic large database / single connection under whatever load the machine had (see load1). NOT a target-host (dmserver) result and NOT a capacity commitment.',
    node: process.version, platform: `${process.platform}-${process.arch}`, load1: os.loadavg()[0], repeat: o.repeat, now: o.now,
    oms_orders: db.prepare('SELECT COUNT(*) c FROM oms_orders').get().c,
    has_stat1: !!db.prepare("SELECT 1 FROM sqlite_master WHERE name='sqlite_stat1'").get(),
    statements: {}
  }
  for (const c of cfgs) result.statements[c.name] = { p50: median(c.xs), p95: pct(c.xs, 0.95), min: Math.min(...c.xs), window_rows_all: c.window_rows_all, rows_returned: c.rows_returned, plan: db.prepare(`EXPLAIN QUERY PLAN ${c.st.sql}`).all(...c.st.params).map((r) => r.detail) }
  if (o.out) fs.writeFileSync(path.resolve(o.out), JSON.stringify(result, null, 2) + '\n')
  console.log(`bench-oms-dense-window: ${result.oms_orders} OMS orders, load1 ${result.load1.toFixed(1)}, repeat ${o.repeat}, stat1 ${result.has_stat1}`)
  for (const [k, v] of Object.entries(result.statements)) console.log(`  ${k.padEnd(34)} p50 ${v.p50.toFixed(1).padStart(7)}  p95 ${v.p95.toFixed(1).padStart(7)}  window_rows_all ${v.window_rows_all}`)
} finally { db.close() }
