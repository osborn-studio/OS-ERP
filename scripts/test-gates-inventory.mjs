#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-gates-inventory.mjs ｜ 测试：常驻守卫：库存域四条「已在册、却没人能触发」的流转边现在真的开了门。
 * ============================================================================
 * 【职责】测试：常驻守卫：库存域四条「已在册、却没人能触发」的流转边现在真的开了门。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 常驻守卫：库存域四条「已在册、却没人能触发」的流转边现在真的开了门。
//
// 背景：单据内核 `server/db/migrations/008_doc_kernel.cjs` 的 ACTIONS 里早就登记了这几条边，
// 但后端从来没有对应路由 ⇒ 系统认为这一步合法，却没有任何人能触发它，单据永远卡在草稿/中间态。
// 本轮只加**路由 + 前端按钮**（不改内核、不加表/权限点/单据类型）。本脚本守的就是"门真的开了"。
//
// 覆盖的 4 条边（写在 EXPECT_EDGES 里，逐字对齐内核 008 的定义）：
//   · TF.submit  draft     → submitted   POST /api/inventory/transfers/:id/submit
//   · TF.cancel  draft     → cancelled   POST /api/inventory/transfers/:id/cancel
//   · TF.cancel  submitted → cancelled   同上（**一个路由管两条边**，由内核按当前状态选边）
//   · CK.cancel  draft     → cancelled   POST /api/inventory/checks/:id/cancel
//   · AS.cancel  draft     → cancelled   POST /api/inventory/assembly/:id/cancel
//
// 每组断言三件事（缺一条这门就等于没开）：
//   ① HTTP 200 + 响应里的新状态；
//   ② 库里状态**确实**变了；
//   ③ `doc_events` 里落了**那条边**（from/to 与内核一致）——状态变了但没留痕 = 又回到了裸 UPDATE。
// 另有三类负例：
//   ④ 非法来源态 ⇒ 必须被拒，且断言**具体 HTTP 码 + 业务码**（不是"失败了就行"）；
//   ⑤ 不存在的 id ⇒ 404；
//   ⑥ **副作用判据（最重要）**：这 4 条边**都不许动库存** ——
//      inventory_transactions / inventory_stocks 的**行数与结存金额一字未变**（作废/提交不该动账）。
//
// 用法：node scripts/test-gates-inventory.mjs [cosmetic|food|apparel]   （缺省 cosmetic）
//
// 隔离纪律（本项目最硬的一条）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-gates-inv-<脚本名>
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ **当场 exit 2 拒跑**
//   · 三库副本是**纯文件拷贝**（copyFileSync，含 -wal）—— 用 sqlite 打开仓库 data/ 去导
//     会把开发库的 WAL 合并掉，那是**写**仓库 data/
//   · 夹具按 `GIT-` 前缀命名，跑前跑后各清一次（含 doc_events 留痕），可重复跑
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { stopAndReport } from './lib/reap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const require = createRequire(import.meta.url)

const INDUSTRIES = ['cosmetic', 'food', 'apparel']
const DB_FILE = { cosmetic: 'gml_cosmetic.db', food: 'gml_food.db', apparel: 'gml_apparel.db' }

// ---------- 参数自证：不认识的输入**拒**，不静默忽略 ----------
// （`node scripts/test-gates-inventory.mjs fot` 若被当成行业名吞掉，脚本会照样打
//   「通过 N / 失败 0」并退出 0 —— 与"真的跑过了"输出同形。）
const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const industryArgs = argv.filter((a) => !a.startsWith('-'))
const badArgs = [...flags, ...industryArgs.filter((a) => !INDUSTRIES.includes(a))]
if (badArgs.length) {
  console.error(`✗ 未知参数：${badArgs.join(' ')}`)
  console.error('用法：node scripts/test-gates-inventory.mjs [cosmetic|food|apparel]')
  process.exit(2)
}
const INDUSTRY = process.argv[2] || 'cosmetic'

// ---------- 隔离目录 ----------
function resolveIsolatedDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-gates-inv-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本会建单/流转，只允许在 /tmp 下的副本上跑。`)
    process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）。`)
    process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  console.log(`隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}
const DIR = resolveIsolatedDir()

// 三库都拷（不止目标行业）：服务启动时 `bootAll` 会对**没库存文件的**行业现场灌种子，
// 每个行业要跑一遍完整 seed —— 只拷一个库等于每轮白跑两次 seed。
let copied = 0
for (const ind of INDUSTRIES) {
  const src = path.join(REPO_DATA, DB_FILE[ind])
  const dst = path.join(DIR, DB_FILE[ind])
  if (fs.existsSync(dst)) continue
  if (!fs.existsSync(src)) {
    console.error(`✗ 找不到源库 ${src} —— 请先在仓库里把三行业库建出来（npm run seed / reseed）`)
    process.exit(2)
  }
  fs.copyFileSync(src, dst)
  // -wal 必须一起拷：只拷 .db 会丢掉还留在 WAL 里、尚未 checkpoint 的事务
  if (fs.existsSync(src + '-wal')) fs.copyFileSync(src + '-wal', dst + '-wal')
  copied += 1
}
console.log(copied ? `已从仓库 data/ 纯文件拷贝 ${copied} 个行业库（含 -wal）到隔离目录` : '隔离目录里已有三库副本（不重复拷贝）')

const PORT = Number(process.env.PORT) || 44572
const BASE = `http://127.0.0.1:${PORT}`
const DB_PATH = path.join(DIR, DB_FILE[INDUSTRY])

let pass = 0
let fail = 0
const failures = []
const ok = (cond, msg, detail) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) }
  else { fail += 1; failures.push(msg); console.log(`  ✗ ${msg}${detail !== undefined && detail !== '' ? '  → ' + String(detail).slice(0, 300) : ''}`) }
}
const section = (t) => console.log(`\n${t}`)

const Database = require('better-sqlite3')
const openDb = () => new Database(DB_PATH)
const scalar = (db, sql, ...args) => db.prepare(sql).get(...args)

// ---------- 期望边（逐字对齐内核 008 的 ACTIONS）----------
// 这张表就是判据本身：**不许**从库里读回来再比 —— 那样内核定义被改坏时本脚本会跟着一起变绿。
const EXPECT_EDGES = [
  { docType: 'TF', action: 'submit', table: 'stock_transfers', seed: 'draft', fromState: 'draft', toState: 'submitted', path: (id) => `/inventory/transfers/${id}/submit` },
  { docType: 'TF', action: 'cancel', table: 'stock_transfers', seed: 'draft', fromState: 'draft', toState: 'cancelled', path: (id) => `/inventory/transfers/${id}/cancel` },
  { docType: 'TF', action: 'cancel', table: 'stock_transfers', seed: 'submitted', fromState: 'submitted', toState: 'cancelled', path: (id) => `/inventory/transfers/${id}/cancel` },
  { docType: 'CK', action: 'cancel', table: 'stock_checks', seed: 'draft', fromState: 'draft', toState: 'cancelled', path: (id) => `/inventory/checks/${id}/cancel` },
  { docType: 'AS', action: 'cancel', table: 'assembly_orders', seed: 'draft', fromState: 'draft', toState: 'cancelled', path: (id) => `/inventory/assembly/${id}/cancel` }
]

// ---------- 非法来源态（每条边各自的"不该放行的入口"）----------
const NEG_CASES = [
  { name: 'TF.submit 从 received（终态）', table: 'stock_transfers', seed: 'received', path: (id) => `/inventory/transfers/${id}/submit` },
  { name: 'TF.cancel 从 shipped（已出库）', table: 'stock_transfers', seed: 'shipped', path: (id) => `/inventory/transfers/${id}/cancel` },
  { name: 'CK.cancel 从 adjusted（已过账）', table: 'stock_checks', seed: 'adjusted', path: (id) => `/inventory/checks/${id}/cancel` },
  { name: 'AS.cancel 从 confirmed（已过账）', table: 'assembly_orders', seed: 'confirmed', path: (id) => `/inventory/assembly/${id}/cancel` }
]

let fixtureSeq = 0
const nextDocNo = (tag) => `GIT-${INDUSTRY.toUpperCase()}-${tag}-${Date.now()}-${fixtureSeq++}`

/** 直接 INSERT 造一张指定状态的单（夹具只用于触发流转；表结构以外的一切由被测路由自己走） */
function makeFixture(db, { table, seed, docNo }) {
  const wh = scalar(db, 'SELECT id FROM warehouses ORDER BY id LIMIT 1')?.id
  if (!wh) throw new Error('夹具不足：库里没有仓库')
  if (table === 'stock_transfers') {
    const [from, to] = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 2').all()
    const toWh = to?.id ?? wh
    const info = db
      .prepare(`INSERT INTO stock_transfers (doc_no,from_warehouse_id,to_warehouse_id,transfer_date,type,status)
                VALUES (?,?,?,?,'normal',?)`)
      .run(docNo, from.id, toWh, '2026-10-17', seed)
    return Number(info.lastInsertRowid)
  }
  if (table === 'stock_checks') {
    const info = db
      .prepare(`INSERT INTO stock_checks (doc_no,warehouse_id,check_date,status) VALUES (?,?,?,?)`)
      .run(docNo, wh, '2026-10-17', seed)
    return Number(info.lastInsertRowid)
  }
  if (table === 'assembly_orders') {
    const bundle = scalar(db, 'SELECT id FROM bundles ORDER BY id LIMIT 1')?.id
    if (!bundle) throw new Error('夹具不足：库里没有组合装（bundles）')
    const info = db
      .prepare(`INSERT INTO assembly_orders (doc_no,type,bundle_id,warehouse_id,biz_date,status,qty)
                VALUES (?,'assemble',?,?,?,?,1)`)
      .run(docNo, bundle, wh, '2026-10-17', seed)
    return Number(info.lastInsertRowid)
  }
  throw new Error(`未知夹具表 ${table}`)
}

/** 清理夹具与它产生的留痕（按 `GIT-` 前缀 + 留痕的 doc_no）—— 跑前跑后各一次，保证可重跑 */
function cleanup(db) {
  for (const t of ['stock_transfers', 'stock_checks', 'assembly_orders']) {
    db.prepare(`DELETE FROM ${t} WHERE doc_no LIKE 'GIT-%'`).run()
  }
  db.prepare("DELETE FROM doc_events WHERE doc_no LIKE 'GIT-%'").run()
}

/** 库存两张表的"行数 + 结存金额"快照：作废/提交**不该**动账，所以它必须逐字段不变 */
const snapInventory = (db) => ({
  txn: scalar(db, 'SELECT COUNT(*) c, COALESCE(SUM(amount),0) amt FROM inventory_transactions'),
  stk: scalar(db, 'SELECT COUNT(*) c, COALESCE(SUM(qty_on_hand*cost_price),0) amt FROM inventory_stocks')
})
const snapEq = (a, b) =>
  a.txn.c === b.txn.c && a.txn.amt === b.txn.amt && a.stk.c === b.stk.c && a.stk.amt === b.stk.amt
const snapShow = (s) => `txn=${s.txn.c}行/${s.txn.amt} · stk=${s.stk.c}行/${s.stk.amt}`

// ---------- 起服务（GML_DATA_DIR 由 env 传给子进程） ----------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))

async function main() {
  const started = Date.now()
  await new Promise((res, rej) => {
    const t = setInterval(() => {
      if (log.includes('服务已启动')) { clearInterval(t); res(true) }
      else if (srv.exitCode !== null) { clearInterval(t); rej(new Error(`服务提前退出：\n${log.slice(-2000)}`)) }
      else if (Date.now() - started > 120000) { clearInterval(t); rej(new Error(`服务启动超时：\n${log.slice(-2000)}`)) }
    }, 100)
  })
  console.log(`服务已启动：${BASE}（pid ${srv.pid}，行业 ${INDUSTRY}）`)

  // 落点自证：子进程自报的实际库路径必须全在隔离目录下（判据取自它自己打的那一行，不是我另算一遍）
  const dbPaths = [...log.matchAll(/数据库：(\S+)/g)].map((m) => m[1])
  const outside = [...new Set(dbPaths)].filter((p) => !p.startsWith(DIR + '/'))
  ok(dbPaths.length > 0 && outside.length === 0,
    `落点自证：子进程自报 ${new Set(dbPaths).size} 个库路径，全部在隔离目录下`,
    outside.length ? `越界：${outside.join(' / ')}` : `抓到 ${dbPaths.length} 条`)

  const log0 = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345', industry: INDUSTRY })
  })
  const login = await log0.json().catch(() => ({}))
  const adminJwt = login.data?.token
  ok(!!adminJwt, 'admin 登录拿到令牌', `${log0.status} ${JSON.stringify(login).slice(0, 200)}`)
  if (!adminJwt) throw new Error('拿不到令牌，后面的用例无从谈起')

  const loginAs = async (u, p) => {
    const r = await fetch(`${BASE}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p, industry: INDUSTRY })
    })
    return (await r.json().catch(() => ({}))).data?.token || null
  }
  const whJwt = await loginAs('warehouse', '123456')
  const purchaseJwt = await loginAs('purchase', '123456')

  const hpost = async (p, token) => {
    const r = await fetch(`${BASE}/api${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token || adminJwt}`, 'x-industry': INDUSTRY },
      body: '{}'
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const codeOf = (b) => b?.error || b?.detail?.code || null

  const db = openDb()
  cleanup(db)

  // ---------------- ① 内核里这些边确实在册（不在册说明轮次跑错了库/内核被改过）----------------
  section('⓪ 内核在册自证（EXPECT_EDGES 逐条对 doc_actions）')
  for (const e of EXPECT_EDGES) {
    const row = scalar(db, 'SELECT to_state FROM doc_actions WHERE doc_type=? AND from_state=? AND action=?', e.docType, e.fromState, e.action)
    const dup = scalar(db, 'SELECT COUNT(*) c FROM doc_actions WHERE doc_type=? AND from_state=? AND action=?', e.docType, e.fromState, e.action).c
    ok(!!row && row.to_state === e.toState && dup === 1,
      `⓪ ${e.docType}.${e.action}  ${e.fromState} → ${e.toState} 在内核 doc_actions 里唯一存在`,
      `查到 to_state=${row?.to_state} 条数=${dup}`)
  }

  // ---------------- ② 正例 × 5 条边 ----------------
  section('① 正例：200 + 库里状态变了 + doc_events 落了那条边 + 库存一字未动')
  for (const e of EXPECT_EDGES) {
    const tag = `${e.docType}-${e.action}-${e.seed}`
    const docNo = nextDocNo(tag)
    const id = makeFixture(db, { table: e.table, seed: e.seed, docNo })
    const before = snapInventory(db)
    const r = await hpost(e.path(id), adminJwt)
    const after = snapInventory(db)
    const st = scalar(db, `SELECT status FROM ${e.table} WHERE id=?`, id)?.status
    const evs = db.prepare('SELECT action,from_state,to_state,doc_no FROM doc_events WHERE doc_type=? AND doc_id=? ORDER BY id').all(e.docType, id)
    const ev = evs[0]

    ok(r.status === 200 && r.body?.data?.status === e.toState && Number(r.body?.data?.id) === id,
      `① ${tag} → 200 且响应 data.status=${e.toState}`,
      `http=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`)
    ok(st === e.toState, `① ${tag} 库里 ${e.table}#${id}.status 确实变成 ${e.toState}（原 ${e.seed}）`, `实得 ${st}`)
    ok(!!ev && ev.action === e.action && ev.from_state === e.fromState && ev.to_state === e.toState && ev.doc_no === docNo,
      `① ${tag} doc_events 落了那条边 ${e.fromState} → ${e.toState}（action=${e.action}，带单号）`,
      `实得 ${JSON.stringify(evs)}`)
    ok(evs.length === 1, `① ${tag} 只落了一条留痕（不是"顺带写了几条"）`, `实得 ${evs.length} 条`)
    ok(snapEq(before, after),
      `① ${tag} 库存零副作用：inventory_transactions / inventory_stocks 行数与结存金额一字未变`,
      `前 ${snapShow(before)} ⇒ 后 ${snapShow(after)}`)
  }

  // ---------------- ③ 一条路由管两条边（TF.cancel 的判据在核心里，不在路由里）----------------
  section('② TF.cancel 的两条边都由同一个路由走通，且选边由内核决定')
  {
    // 判据按**边**（doc_type/action/from/to）数，不按单号前缀拼字符串 —— 前者是内核的定义，后者是夹具命名约定
    const cnt = (from) => scalar(db,
      "SELECT COUNT(*) c FROM doc_events WHERE doc_type='TF' AND action='cancel' AND from_state=? AND to_state='cancelled' AND doc_no LIKE 'GIT-%'", from).c
    const a = cnt('draft')
    const b = cnt('submitted')
    ok(a === 1 && b === 1, '② draft→cancelled 与 submitted→cancelled 两条边都真的走过（同一 POST 路径）', `draft=${a} submitted=${b}`)
  }

  // ---------------- ④ 负例：非法来源态 ----------------
  section('③ 负例：非法来源态必须被拒（断言具体 HTTP 码 + 业务码）')
  for (const c of NEG_CASES) {
    const docNo = nextDocNo(`NEG-${c.table}`)
    const id = makeFixture(db, { table: c.table, seed: c.seed, docNo })
    const before = snapInventory(db)
    const beforeEv = scalar(db, 'SELECT COUNT(*) c FROM doc_events WHERE doc_id=?', id).c
    const r = await hpost(c.path(id), adminJwt)
    const after = snapInventory(db)
    const st = scalar(db, `SELECT status FROM ${c.table} WHERE id=?`, id)?.status
    const afterEv = scalar(db, 'SELECT COUNT(*) c FROM doc_events WHERE doc_id=?', id).c

    ok(r.status === 409 && codeOf(r.body) === 'TRANSITION_NOT_ALLOWED',
      `③ ${c.name} → 409 TRANSITION_NOT_ALLOWED`,
      `http=${r.status} code=${codeOf(r.body)} msg=${String(r.body?.message || '').slice(0, 120)}`)
    ok(st === c.seed, `③ ${c.name} 被拒后状态仍是 ${c.seed}（不是"报了错但还是改了"）`, `实得 ${st}`)
    ok(afterEv === beforeEv, `③ ${c.name} 被拒后**没有**写任何留痕`, `${beforeEv} ⇒ ${afterEv}`)
    ok(snapEq(before, after), `③ ${c.name} 被拒后库存也没动`, `前 ${snapShow(before)} ⇒ 后 ${snapShow(after)}`)
  }

  // ---------------- ⑤ 负例：不存在的 id ----------------
  section('④ 负例：不存在的 id ⇒ 404')
  {
    const maxId = {
      stock_transfers: scalar(db, 'SELECT COALESCE(MAX(id),0) m FROM stock_transfers').m,
      stock_checks: scalar(db, 'SELECT COALESCE(MAX(id),0) m FROM stock_checks').m,
      assembly_orders: scalar(db, 'SELECT COALESCE(MAX(id),0) m FROM assembly_orders').m
    }
    const probes = [
      { name: 'TF.submit', p: `/inventory/transfers/${maxId.stock_transfers + 100000}/submit` },
      { name: 'TF.cancel', p: `/inventory/transfers/${maxId.stock_transfers + 100000}/cancel` },
      { name: 'CK.cancel', p: `/inventory/checks/${maxId.stock_checks + 100000}/cancel` },
      { name: 'AS.cancel', p: `/inventory/assembly/${maxId.assembly_orders + 100000}/cancel` }
    ]
    for (const p of probes) {
      const r = await hpost(p.p, adminJwt)
      ok(r.status === 404 && r.body?.success === false && /不存在/.test(String(r.body?.message || '')),
        `④ ${p.name} 不存在的 id → 404（且说的是人话）`,
        `http=${r.status} body=${JSON.stringify(r.body).slice(0, 200)}`)
    }
  }

  // ---------------- ⑥ 权限面：不是 admin 专属，也不给不相干角色 ----------------
  section('⑤ 权限面：warehouse 能推 / 不相干角色不能推')
  {
    const docNo = nextDocNo('PERM')
    const id = makeFixture(db, { table: 'stock_transfers', seed: 'draft', docNo })
    const w = await hpost(`/inventory/transfers/${id}/submit`, whJwt)
    ok(w.status === 200 && w.body?.data?.status === 'submitted',
      '⑤ warehouse（角色在 requireRole 白名单内）提交成功 —— 这门不是 admin 专属',
      `http=${w.status} ${JSON.stringify(w.body).slice(0, 160)}`)

    const docNo2 = nextDocNo('PERM2')
    const id2 = makeFixture(db, { table: 'stock_transfers', seed: 'draft', docNo: docNo2 })
    const p = await hpost(`/inventory/transfers/${id2}/submit`, purchaseJwt)
    const st2 = scalar(db, 'SELECT status FROM stock_transfers WHERE id=?', id2)?.status
    ok(p.status === 403 && st2 === 'draft',
      '⑤ purchase（不在白名单）提交 → 403 且状态未变',
      `http=${p.status} status=${st2} msg=${String(p.body?.message || '').slice(0, 120)}`)
  }

  cleanup(db)
  db.close()
}

try {
  await main()
} catch (e) {
  fail += 1
  failures.push('脚本异常')
  console.error(`\n✗ 脚本异常：${e && e.stack ? e.stack : e}`)
} finally {
  await stopAndReport(srv, { port: PORT })
  console.log(`\n${'─'.repeat(60)}`)
  console.log(`[${INDUSTRY}] 通过 ${pass} / 失败 ${fail}`)
  if (fail) console.log('失败项：\n - ' + failures.join('\n - '))
}
process.exit(fail ? 1 : 0)
