/**
 * ============================================================================
 * 文件标识：tests/oms-sql.test.mjs ｜ 测试：OMS /stats 与 AI 平台分析的 order_time 区间谓词（roadmap-v10 AE3，ADR-0044 补充 4）
 * ============================================================================
 * 【职责】① 新 SQL（server/lib/oms-sql.js）与旧 `date(order_time) >= …` 写法在带边界数据的合成 OMS 表上返回逐项相同的结果
 *   （含时区后缀、脏文本、NULL、空串、未来日期、未知平台、受限组织范围）；② explain-audit 登记的就是路由执行的那份语句，
 *   且计划是 idx_oms_order_time 的带约束 SEARCH；③ 路由里不再内联 `date(…order_time) >=`。
 * 【夹具口径】内存库 + 真实迁移；HTTP 用例在 oms-scope / dashboard-perf 里已有，这里只补 AE3 新增面。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import * as oq from '../server/lib/oms-sql.js'
import { onlineWindow } from '../server/lib/dashboard-sql.js'
import { omsPlatformScopeSql, omsOrderScopeSql } from '../server/lib/sales-order.js'
import { STATEMENTS, ALLOW, auditStatements } from '../scripts/explain-audit.mjs'

const SCHEMA = readFileSync(new URL('../server/db/schema.sql', import.meta.url), 'utf8')
const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8')

/** 旧写法（逐字取自 AE3 之前的 oms.js / ai.js） */
const OLD = (days, ps, os, os0) => {
  const from = `date('now','localtime','-${days} day')`
  return {
    byPlatform: [`SELECT pf.name AS platform_name, pf.code, COUNT(o.id) orders,
                COALESCE(SUM(CASE WHEN o.status NOT IN ('refunded','closed') THEN o.pay_amount ELSE 0 END),0) gmv,
                COALESCE(SUM(CASE WHEN o.status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN o.status='refunded' THEN o.pay_amount ELSE 0 END),0) refund_amount
         FROM platforms pf LEFT JOIN oms_orders o ON o.platform_id=pf.id AND date(o.order_time) >= ${from}
         WHERE ${ps.sql} GROUP BY pf.id ORDER BY gmv DESC`, ps.params],
    trend: [`SELECT date(order_time) AS date, COUNT(*) orders, COALESCE(SUM(pay_amount),0) amount
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${os0.sql} GROUP BY date(order_time) ORDER BY date`, os0.params],
    total: [`SELECT COUNT(*) orders, COALESCE(SUM(pay_amount),0) gmv,
                COALESCE(AVG(pay_amount),0) avg_amount,
                COALESCE(SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END),0) pending,
                COALESCE(SUM(CASE WHEN status='refunded' THEN 1 ELSE 0 END),0) refunded
         FROM oms_orders WHERE date(order_time) >= ${from} AND ${os0.sql}`, os0.params],
    topSkus: [`SELECT i.title, SUM(i.qty) qty, SUM(i.amount) amount FROM oms_order_items i
         JOIN oms_orders o ON o.id=i.oms_order_id WHERE date(o.order_time) >= ${from} AND ${os.sql}
         GROUP BY i.title ORDER BY amount DESC LIMIT 10`, os.params],
    ai: [`SELECT pf.name AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount FROM oms_orders o
             JOIN platforms pf ON pf.id=o.platform_id WHERE date(o.order_time) >= ${from} GROUP BY pf.id ORDER BY amount DESC`, []]
  }
}

function fixture(t) {
  const db = new Database(':memory:')
  t.after(() => db.close())
  db.pragma('foreign_keys=ON')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test', warn: () => {} })
  db.pragma('foreign_keys=OFF')
  const wh = db.prepare('INSERT INTO warehouses (code, name, org_id) VALUES (?,?,?)')
  const w1 = Number(wh.run('AE3-W1', 'w1', 101).lastInsertRowid)
  const w2 = Number(wh.run('AE3-W2', 'w2', 202).lastInsertRowid)
  const pf = db.prepare('INSERT INTO platforms (code, name, warehouse_id) VALUES (?,?,?)')
  const pa = Number(pf.run('AE3-A', 'AE3甲', w1).lastInsertRowid)
  const pb = Number(pf.run('AE3-B', 'AE3乙', w2).lastInsertRowid)
  const pc = Number(pf.run('AE3-C', 'AE3丙', null).lastInsertRowid)
  const ins = db.prepare('INSERT INTO oms_orders (platform_id, platform_order_no, order_time, status, pay_amount) VALUES (?,?,?,?,?)')
  const item = db.prepare('INSERT INTO oms_order_items (oms_order_id, title, qty, price, amount) VALUES (?,?,?,?,?)')
  let n = 0
  const add = (p, time, status = 'completed', amt = 10.25) => {
    const id = Number(ins.run(p, `AE3-${++n}`, time, status, amt).lastInsertRowid)
    item.run(id, `sku-${n % 4}`, 1 + (n % 3), amt, amt)
    return id
  }
  const day = (d) => db.prepare(`SELECT date('now','localtime','${d < 0 ? '+' + -d : '-' + d} day') d`).get().d
  for (const days of [0, 1, 5, 29, 30, 31, 89, 90, 91, 200, -3]) {
    const d = day(days)
    add(pa, `${d} 00:00:00`); add(pa, `${d} 23:59:59`, 'shipped', 3.5); add(pb, `${d}T12:30:00`, 'refunded', 99); add(pb, d, 'pending', 1.1)
    add(pc, `${d} 08:00:00`, 'closed', 7); add(987654, `${d} 08:00:00`, 'completed', 7)
  }
  add(pa, null); add(pb, '', 'completed', 5)
  for (const days of [0, 29, 30, 31, 89, 90, 91]) {
    const d = day(days)
    add(pa, `${d}T01:00:00+08:00`, 'completed', 4.5); add(pb, `${d}T20:00:00-08:00`, 'shipped', 6.25); add(pa, `${d}T23:30:00Z`, 'completed', 8)
    add(pb, `${d} 12:00:00.123`, 'completed', 1.5)
  }
  add(pa, 'not-a-date', 'completed', 2); add(pb, 'null 00:00:00', 'completed', 3); add(pa, '2461000.5', 'completed', 4); add(pb, 'now', 'completed', 5)
  db.pragma('foreign_keys=ON')
  return { db, pa, pb, pc }
}

const SCOPES = [
  ['global', { scope: 'all' }],
  ['org 101', { orgIds: [101] }],
  ['org 202', { orgIds: [202] }],
  ['both', { orgIds: [101, 202] }],
  ['none', { scope: 'none' }]
]
test('AE3 /stats statements: new range SQL returns exactly the rows of the old date(order_time) SQL (windows x scopes x boundary data)', (t) => {
  const { db } = fixture(t)
  let nonEmpty = 0
  for (const [label, sc] of SCOPES) {
    const ps = omsPlatformScopeSql(sc, 'pf'), os = omsOrderScopeSql(sc, 'o'), os0 = omsOrderScopeSql(sc, 'oms_orders')
    for (const days of [0, 1, 7, 29, 30, 31, 90, 365, 1.5, -1, 1e9, 'abc', NaN]) {
      const old = OLD(days, ps, os, os0)
      const mk = {
        byPlatform: oq.omsStatsByPlatformStmt(days, ps), trend: oq.omsStatsTrendStmt(days, os0),
        total: oq.omsStatsTotalStmt(days, os0), topSkus: oq.omsStatsTopSkusStmt(days, os)
      }
      for (const k of Object.keys(mk)) {
        const want = db.prepare(old[k][0]).all(...old[k][1])
        const got = db.prepare(mk[k].sql).all(...mk[k].params)
        assert.deepEqual(got, want, `${label} days=${days} ${k}`)
        if (want.length && days === 30) nonEmpty++
      }
    }
  }
  assert.ok(nonEmpty >= 8, 'fixture actually exercises the statements')
})

test('AE3 AI platform analysis: new range SQL equals old SQL across windows', (t) => {
  const { db } = fixture(t)
  for (const days of [0, 1, 7, 30, 90, 365, 1.5, -1, 1e9, 'abc', NaN]) {
    const want = db.prepare(OLD(days, { sql: '1=1', params: [] }, { sql: '1=1', params: [] }, { sql: '1=1', params: [] }).ai[0]).all()
    const st = oq.aiPlatformAnalysisStmt(days)
    assert.deepEqual(db.prepare(st.sql).all(...st.params), want, `days=${days}`)
  }
  assert.ok(db.prepare(oq.aiPlatformAnalysisStmt(30).sql).all(...oq.aiPlatformAnalysisStmt(30).params).length >= 2)
})

test('AE3 statements bind the AD3 window [lo, since] first and keep the date() recheck', () => {
  const win = onlineWindow(30)
  const ps = { sql: '1=1', params: [] }
  for (const st of [oq.omsStatsByPlatformStmt(30, ps), oq.omsStatsTrendStmt(30, ps), oq.omsStatsTotalStmt(30, ps), oq.omsStatsTopSkusStmt(30, ps), oq.aiPlatformAnalysisStmt(30)]) {
    assert.deepEqual(st.params.slice(0, 2), win)
    assert.match(st.sql, /order_time >= \? AND date\((o\.)?order_time\) >= \?/)
  }
  const scoped = omsPlatformScopeSql({ orgIds: [101, 202] }, 'pf')
  assert.deepEqual(oq.omsStatsByPlatformStmt(30, scoped).params, [...win, ...scoped.params])
  // 无效窗口：lo / since 绑定 NULL，结果为空（与旧行为一致）
  assert.deepEqual(oq.omsStatsTrendStmt('abc', ps).params.slice(0, 2), [null, null])
})

test('AE3 mutation: dropping the date() recheck changes results (the fixture would catch it)', (t) => {
  const { db } = fixture(t)
  const st = oq.omsStatsTrendStmt(30, { sql: '1=1', params: [] })
  const noRecheck = st.sql.replace(/ AND date\(order_time\) >= \?/, '')
  const want = db.prepare(st.sql).all(...st.params)
  const got = db.prepare(noRecheck).all(st.params[0], ...st.params.slice(2))
  assert.notDeepEqual(got, want)
})

test('AE3 explain-audit: oms.stats_* / ai.platform_analysis registered with the router statements, expectIndex + expectSearch, no exemption', (t) => {
  const { db } = fixture(t)
  const byId = new Map(STATEMENTS.map((s) => [s.id, s]))
  const ids = ['oms.stats_trend', 'oms.stats_total', 'ai.platform_analysis']
  for (const id of ids) {
    const s = byId.get(id)
    assert.ok(s, `${id} registered`)
    assert.equal(s.expectIndex, 'idx_oms_order_time')
    assert.equal(s.expectSearch, true)
    assert.ok(!ALLOW.some((a) => a.statement === id), `${id} not exempt`)
  }
  // 平台驱动 / 受限范围 / 明细驱动的形态也登记（只守无裸 SCAN），不声明 idx_oms_order_time；top_skus 的明细表扫描有书面豁免
  for (const id of ['oms.stats_by_platform', 'oms.stats_by_platform_scoped', 'oms.stats_trend_scoped', 'oms.stats_total_scoped', 'oms.stats_top_skus', 'oms.stats_top_skus_scoped']) {
    assert.ok(byId.get(id), `${id} registered`)
    assert.equal(byId.get(id).expectIndex, undefined)
  }
  assert.ok(ALLOW.find((a) => a.statement === 'oms.stats_top_skus' && a.table === 'oms_order_items' && a.reason.length > 20))
  const mine = STATEMENTS.filter((s) => /^(oms\.stats|ai\.platform)/.test(s.id))
  const all = auditStatements(db, mine, { allow: ALLOW.filter((a) => mine.some((m) => m.id === a.statement)) })
  assert.deepEqual(all.violations, [])
  const g = { sql: '1=1', params: [] }
  assert.equal(byId.get('oms.stats_trend').sql, oq.omsStatsTrendStmt(30, g).sql)
  assert.deepEqual(byId.get('oms.stats_trend').params, oq.omsStatsTrendStmt(30, g).params)
  assert.equal(byId.get('ai.platform_analysis').sql, oq.aiPlatformAnalysisStmt(30).sql)
  const rep = auditStatements(db, ids.map((i) => byId.get(i)), { allow: [], threshold: 1 })
  assert.deepEqual(rep.violations, [])
  for (const id of ['oms.stats_trend', 'oms.stats_total', 'ai.platform_analysis']) {
    const plan = rep.statements.find((s) => s.id === id).plan
    assert.ok(plan.some((d) => /SEARCH \w+ USING COVERING INDEX idx_oms_order_time \(order_time>\?\)/.test(d)), `${id}: ${plan.join(' | ')}`)
  }
  db.exec('DROP INDEX idx_oms_order_time')
  const bad = auditStatements(db, ids.map((i) => byId.get(i)), { allow: [], threshold: 1 })
  assert.equal(bad.ok, false)
})

test('AE3 routes no longer inline date(order_time) predicates', () => {
  assert.doesNotMatch(read('server/routes/oms.js'), /date\(o?\.?order_time\) >=/)
  assert.doesNotMatch(read('server/routes/ai.js'), /date\(o\.order_time\) >=/)
  assert.match(read('server/routes/oms.js'), /oms-sql\.js/)
  assert.match(read('server/routes/ai.js'), /oms-sql\.js/)
})
