#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-gates-purchase.mjs ｜ 测试：采购域「门」守卫：把内核里已登记、但后端从来没有路由的三条边开出来之后，逐条验证它们真的通了。
 * ============================================================================
 * 【职责】测试：采购域「门」守卫：把内核里已登记、但后端从来没有路由的三条边开出来之后，逐条验证它们真的通了。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购域「门」守卫：把内核里已登记、但后端从来没有路由的三条边开出来之后，逐条验证它们真的通了。
//
//   用法：GML_DATA_DIR=/tmp/xxx node scripts/test-gates-purchase.mjs [cosmetic|food|apparel]
//     （不设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-gates-test-gates-purchase，并从仓库 data/ 只读备份；
//      `regress-all` 不设任何 env，那种跑法必须能自己落地，否则整轮回归会被这个脚本拦死。）
//
// 补的三条边（`server/db/migrations/008_doc_kernel.cjs` 里早已登记，只是一直没有门）：
//   · PRT.cancel   draft     → cancelled   `POST /api/purchase/returns/:id/cancel`
//   · PRT.complete confirmed → completed   `POST /api/purchase/returns/:id/complete`
//   · GR.close     inspected → closed      `POST /api/purchase/receipts/:id/close`
//
// 每类动作都问三件事（缺一条都不算通过）：
//   ① HTTP 200；② **库里状态真的变了**；③ `doc_events` 里落下了**与内核定义逐字相同**的那条边。
// 外加两类**必须红**的：非法来源态 ⇒ 409 `TRANSITION_NOT_ALLOWED`（且状态一字未变）、不存在的 id ⇒ 404。
//
// 为什么还有一组"副作用判据"（本脚本最要紧的一段）：
//   `complete` 是**结案**、`cancel` 从 `draft` 出发、`close` 是**归档** —— 三者都必须是**零副作用**的纯状态推进。
//   而这三条边所属的两个单据类型，恰恰有一个"有后果"的兄弟动作：`PRT.confirm`（在 `createPurchaseReturn`
//   里）会把货**退出库存**、把采购订单的已收量**回退**、并重算到货关闭标记。若 `complete` 里再走一次那段逻辑，
//   就是把货退两遍、把量回退两遍，而且**不报错、账也平**（每张单看起来都正常）。
//   所以这里不"想当然只查库存表"，而是：**先实测 `confirm` 到底写了哪些表**（见文件末尾 `CONFIRM_WRITE_SET`
//   的来源说明），把那一组表钉成"不许动"的集合，再断言调用前后**逐字节未变**；
//   另外再做一遍**全库 193 张表**的差集，要求"变了哪些表"⊆ 允许变更的白名单。
//   两层都要：指定集合是"我知道该防什么"，全库差集是"我不知道的也不许动"。
//
// 隔离纪律（本项目硬纪律，形状与 scripts/verify-purchase-entry.mjs / test-kernel-a7.mjs 一致）：
//   · 未设 GML_DATA_DIR ⇒ 自落到 /tmp 并从仓库 data/ **只读**备份；指向仓库 data/ 或任何非 /tmp ⇒ exit 2。
//   · ⚠️ 顺序要点：`server/db/index.js` 的 DATA_DIR 是**模块加载时**求值的 ⇒ 本脚本**一个静态 import
//     都不许触到它**（下面全是 node: 内置 + better-sqlite3 裸包，两者都到不了 db/index.js），
//     子进程则显式注入 `GML_DATA_DIR`。这也是 `check-env-pinning.mjs` 的两格判据要求。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3' // 裸包：不读 GML_DATA_DIR，也不 import db/index.js

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const SELF = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
const RAW_ENV = process.env.GML_DATA_DIR || ''
const ISOLATED_DIR = RAW_ENV ? path.resolve(RAW_ENV) : path.join('/tmp', `gml-gates-${SELF}`)
if (ISOLATED_DIR === REPO_DATA || ISOLATED_DIR.startsWith(REPO_DATA + path.sep)) {
  console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${ISOLATED_DIR}）。本脚本会推进单据状态，只允许在 /tmp 下的副本上跑。`)
  process.exit(2)
}
if (!ISOLATED_DIR.startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${ISOLATED_DIR}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-gates-${SELF}。`)
  process.exit(2)
}
// ⚠️ **先钉 env、再碰任何会开库的东西**（下面没有静态 import 能到 db/index.js，子进程另行显式注入）
process.env.GML_DATA_DIR = ISOLATED_DIR

const INDUSTRY = ['cosmetic', 'food', 'apparel'].includes(process.argv[2]) ? process.argv[2] : 'cosmetic'
const PORT = Number(process.env.TEST_PORT || 44151 + Math.max(0, ['cosmetic', 'food', 'apparel'].indexOf(INDUSTRY)))
const BASE = `http://127.0.0.1:${PORT}`

fs.mkdirSync(ISOLATED_DIR, { recursive: true })
{
  // 每次都从仓库 data/ **只读**取一份干净夹具（SQLite backup API：与 WAL 一致的快照；不写 data/）
  const src = new Database(path.join(REPO_DATA, `gml_${INDUSTRY}.db`), { readonly: true })
  const dst = path.join(ISOLATED_DIR, `gml_${INDUSTRY}.db`)
  for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
  await src.backup(dst)
  src.close()
  console.log(`[落点] 行业=${INDUSTRY} 隔离目录=${ISOLATED_DIR}（已从仓库 data/ 只读备份一份；仓库 data/ 不会被写）`)
}

// ---------------------------------------------------------------------------
// 起真实服务（独立端口）
// ---------------------------------------------------------------------------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: ISOLATED_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d))
srv.stderr.on('data', (d) => (log += d))
await new Promise((res) => {
  const t0 = Date.now()
  const t = setInterval(() => {
    if (log.includes('服务已启动') || Date.now() - t0 > 60000) { clearInterval(t); res() }
  }, 200)
})

const gateFail = (msg) => {
  console.error(msg)
  try { srv.kill('SIGKILL') } catch { /* 已经退了 */ }
  process.exit(2)
}
// 闸门（启动即验）：判据取自**子进程自报的实际库路径**，不是自己再算一遍 —— 报告与实际必须同源
const dbPaths = [...log.matchAll(/数据库：(\S+)/g)].map((m) => m[1])
if (!dbPaths.length) gateFail('✗ 拒绝运行：子进程没有自报库路径（`数据库：` 一行都没抓到），无法确认隔离是否生效。')
const outside = [...new Set(dbPaths)].filter((p) => !p.startsWith(ISOLATED_DIR + '/'))
if (outside.length) gateFail(`✗ 拒绝运行：子进程实际使用的库不在隔离目录下：${outside.join(' / ')}（期望前缀 ${ISOLATED_DIR}/）`)
console.log(`[落点自证] 子进程自报 ${new Set(dbPaths).size} 个库路径，全部在 ${ISOLATED_DIR}/ 下`)

const db = new Database(path.join(ISOLATED_DIR, `gml_${INDUSTRY}.db`))

// ---------------------------------------------------------------------------
// HTTP 小工具
// ---------------------------------------------------------------------------
const api = async (method, p, { token, body } = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const login = async (u, p) =>
  (await api('POST', '/api/auth/login', { body: { username: u, password: p, industry: INDUSTRY } })).body?.data?.token
/** 业务码：本项目同时写在顶层 `error` 与 `detail.code` 两处（同一个构造点 bizFail），两个读法都要认 */
const codeOf = (b) => b?.error || b?.detail?.code || null

// ---------------------------------------------------------------------------
// 断言收集（形状 ok(name, cond, detail) —— 与 check-test-helper-shape.mjs 声明表一致）
// ---------------------------------------------------------------------------
const R = []
const ok = (name, cond, detail = '') => R.push({ name, ok: !!cond, detail: String(detail) })

// ---------------------------------------------------------------------------
// 全库快照 / 差集（副作用判据的底座）
// ---------------------------------------------------------------------------
const TABLES = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((r) => r.name)
const sha = (v) => createHash('sha256').update(v).digest('hex')
const snapAll = () => {
  const out = {}
  for (const t of TABLES) out[t] = sha(JSON.stringify(db.prepare(`SELECT * FROM "${t}"`).all()))
  return out
}
const diffTables = (a, b) => TABLES.filter((t) => a[t] !== b[t])

/** 单表快照：id → 整行（用来做**行级**差集，而不是只看"这张表动没动"） */
const snapTable = (t) => {
  const m = new Map()
  for (const r of db.prepare(`SELECT * FROM "${t}"`).all()) m.set(String(r.id), r)
  return m
}
/**
 * 行级差集。**为什么必须做到行级**：把整张表列进白名单只能证明"表被动过"，
 * 证明不了"只动了我造的那一张" —— 万一实现顺手把同表另一张单也推进了，全局差集照样全绿。
 * @returns {{added:string[], removed:string[], statusChanged:string[], otherChanged:string[]}}
 */
function tableDiff(before, after, statusCol) {
  const added = [...after.keys()].filter((k) => !before.has(k))
  const removed = [...before.keys()].filter((k) => !after.has(k))
  const statusChanged = []
  const otherChanged = []
  for (const k of before.keys()) {
    if (!after.has(k)) continue
    const a = before.get(k)
    const b = after.get(k)
    if (a[statusCol] !== b[statusCol]) statusChanged.push(k)
    const ca = { ...a }
    delete ca[statusCol]
    const cb = { ...b }
    delete cb[statusCol]
    if (JSON.stringify(ca) !== JSON.stringify(cb)) otherChanged.push(k)
  }
  return { added, removed, statusChanged, otherChanged }
}

// ---------------------------------------------------------------------------
// 夹具 —— **全部自己造，一律不用 seed 现成的单据**
// ---------------------------------------------------------------------------
// 为什么不用库里现成的行（team-lead 提醒的那条，理由充分）：
//   ① 现成行的构成取决于 seed，换一个库/重灌一次就变（"库里那 N 张 closed 是造的"不能当判据）；
//   ② 拿现成行当正例 = 测试会**改掉别人的数据**，而"被我改掉的那张"和"我造的那张"混在一起，
//      就没法干净地证明"我只动了该动的那一张"；
//   ③ 自己造 ⇒ 跑完能把自己造的东西（**连留痕一起**）删干净，不留孤儿留痕。
// 直接 INSERT 而不走建单接口：建单那一步自己有副作用（出库 / 回退已收量），
// 混进来就分不清"是这个门带出来的"还是"建单带出来的"。
const adminJwt = await login('admin', '12345')
const purchaseJwt = await login('purchase', '123456')
const viewerJwt = await login('viewer', '123456')
ok('登录：admin / purchase / viewer 三个身份都拿到 token', !!adminJwt && !!purchaseJwt && !!viewerJwt,
  `${!!adminJwt}/${!!purchaseJwt}/${!!viewerJwt}`)

const sup = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get().id
const wh = db.prepare("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get().id
const TAG = `GATE-${INDUSTRY.toUpperCase()}-${Date.now()}`
const mkReturn = (status, note) =>
  Number(
    db
      .prepare(
        `INSERT INTO purchase_returns (doc_no,supplier_id,warehouse_id,return_date,reason,status,total_qty,total_amount)
         VALUES (?,?,?,'2026-10-17',?,?,0,0)`
      )
      .run(`RT-${TAG}-${note}`, sup, wh, `门守卫夹具（${note}）`, status).lastInsertRowid
  )
const mkReceipt = (status, note) =>
  Number(
    db
      .prepare(
        `INSERT INTO purchase_receipts (doc_no,supplier_id,warehouse_id,receipt_date,status,remark)
         VALUES (?,?,?,'2026-10-17',?,?)`
      )
      .run(`PR-${TAG}-${note}`, sup, wh, status, `门守卫夹具（${status}/${note}）`).lastInsertRowid
  )

const draftId = mkReturn('draft', 'draft') // PRT.cancel 正例 / PRT.complete 负例
const confirmedA = mkReturn('confirmed', 'confirmed-a') // PRT.cancel 负例（必须一直留在 confirmed）
const confirmedB = mkReturn('confirmed', 'confirmed-b') // PRT.complete 正例
const inspectedId = mkReceipt('inspected', 'inspected') // GR.close 正例
const receivedId = mkReceipt('received', 'received') // GR.close 负例

const myReturns = [draftId, confirmedA, confirmedB]
const myReceipts = [inspectedId, receivedId]
/** 夹具落库**之前**的行数 —— 收尾时用它证明"我造的东西连留痕一起清干净了" */
const baseline = {
  returns: db.prepare('SELECT COUNT(*) c FROM purchase_returns').get().c - myReturns.length,
  receipts: db.prepare('SELECT COUNT(*) c FROM purchase_receipts').get().c - myReceipts.length
}
ok('夹具齐备（全部自造）：draft / confirmed×2 退货单 + inspected / received 到货单，起始状态正确',
  db.prepare(`SELECT status FROM purchase_returns WHERE id=?`).get(draftId).status === 'draft' &&
    db.prepare(`SELECT status FROM purchase_returns WHERE id=?`).get(confirmedA).status === 'confirmed' &&
    db.prepare(`SELECT status FROM purchase_returns WHERE id=?`).get(confirmedB).status === 'confirmed' &&
    db.prepare(`SELECT status FROM purchase_receipts WHERE id=?`).get(inspectedId).status === 'inspected' &&
    db.prepare(`SELECT status FROM purchase_receipts WHERE id=?`).get(receivedId).status === 'received',
  `returns#${myReturns.join(',')} receipts#${myReceipts.join(',')}`)

// ---------------------------------------------------------------------------
// 副作用判据的"不许动"集合 —— 由**实测**得来，不是想当然
// ---------------------------------------------------------------------------
// 来源：用 `createPurchaseReturn`（即 PRT.confirm）在 /tmp 的库副本上跑一次，前后对 193 张表做 sha256 差集，
// 实测变更集合 = purchase_returns / purchase_return_items / inventory_stocks / inventory_transactions /
//              stock_cost_ledger / purchase_order_items / purchase_orders / doc_no_counters / doc_events
// （不带上游订单来源时少 purchase_order_items 与 purchase_orders 两张）。
// ⇒ 去掉"本来就会变"的 (doc_events / 自身状态表 / 审计表)，其余 7 张就是 cancel / complete / close **都不该动**的。
// ⚠️ 注意：应付相关表（purchase_invoices / purchase_settlements / purchase_payments）实测**一张都没动** ——
//    本项目里采购退货的后果落在**库存与订单已收量**上，不落在应付上。
const NO_TOUCH = [
  'purchase_return_items',
  'inventory_stocks',
  'inventory_transactions',
  'stock_cost_ledger',
  'purchase_order_items',
  'purchase_orders',
  'doc_no_counters'
]
// 允许变更的**白名单**（全库差集判据用）：只许落这一条边的留痕、只许改这张单自己的状态字段
const ALLOW = {
  PRT: { docTable: 'purchase_returns', allow: ['purchase_returns', 'doc_events', 'audit_logs'] },
  GR: { docTable: 'purchase_receipts', allow: ['purchase_receipts', 'doc_events', 'audit_logs'] }
}

/**
 * 断言"这次调用除了我造的那一张的状态与留痕，什么都没动"。
 * @param beforeSnap 全库 sha 快照（表级）
 * @param beforeTable 目标单据表的行级快照（id → 整行）
 */
function assertNoSideEffect(label, kind, docTable, id, beforeSnap, beforeTable) {
  const afterSnap = snapAll()
  const changed = diffTables(beforeSnap, afterSnap).filter((t) => beforeSnap[t] !== afterSnap[t])
  const rule = ALLOW[kind]
  const extra = changed.filter((t) => !rule.allow.includes(t))
  ok(`${label}：变更的表 ⊆ 白名单〔${rule.allow.join(' / ')}〕`, extra.length === 0,
    extra.length ? `多动了 ${extra.length} 张：${extra.join(' / ')}` : `实测变更 ${changed.length} 张：${changed.join(' / ') || '（无）'}`)

  const touched = NO_TOUCH.filter((t) => changed.includes(t))
  ok(`${label}：confirm 会写的 ${NO_TOUCH.length} 张表**逐字节未变**（不许把货退两遍 / 回退两遍已收量）`,
    touched.length === 0, touched.length ? `被动了：${touched.join(' / ')}` : '全部未变')

  // 行级：整张表里**只有我造的那一张**该变，且只变 status
  const d = tableDiff(beforeTable, snapTable(docTable), 'status')
  ok(`${label}：${docTable} 没有新增 / 删除任何行`, d.added.length === 0 && d.removed.length === 0,
    `+${d.added.length} / -${d.removed.length}`)
  ok(`${label}：${docTable} 里**只有我造的那一张 #${id}** 的 status 变了（别的单一张都没被碰）`,
    d.statusChanged.length === 1 && d.statusChanged[0] === String(id),
    `status 变了 ${d.statusChanged.length} 行：${d.statusChanged.join(' / ') || '（无）'}`)
  ok(`${label}：${docTable} 其它字段一个都没动（金额 / 数量 / 单号 / 日期…）`,
    d.otherChanged.length === 0, `被改的行：${d.otherChanged.join(' / ') || '（无）'}`)
}

/** 断言 doc_events 落下的那条边与内核登记逐字一致（判据只有一份：读内核表，不抄常量） */
function assertEdge(docType, id, action, fromState, toState, label) {
  const ev = db
    .prepare('SELECT action, from_state, to_state, actor_name FROM doc_events WHERE doc_type=? AND doc_id=? ORDER BY id DESC LIMIT 1')
    .get(docType, id)
  const edge = db.prepare('SELECT to_state FROM doc_actions WHERE doc_type=? AND from_state=? AND action=?').get(docType, fromState, action)
  ok(`${label}：doc_events 落下留痕 ${fromState} → ${toState}（action=${action}）`,
    !!ev && ev.action === action && ev.from_state === fromState && ev.to_state === toState,
    ev ? `实测 ${ev.from_state} → ${ev.to_state}（${ev.action}）` : '没有任何留痕')
  ok(`${label}：留痕的边与内核 doc_actions 定义一致（${docType}.${action} → ${edge?.to_state}）`,
    !!edge && edge.to_state === toState, edge ? `内核 to_state=${edge.to_state}` : '内核里没有这条边')
}

// ===========================================================================
// 1. PRT.complete（confirmed → completed）—— 本轮最严重的一条：门没开时退货单永远停在「已确认」
// ===========================================================================
{
  const id = confirmedB
  const docNo = db.prepare('SELECT doc_no FROM purchase_returns WHERE id=?').get(id).doc_no
  const beforeSnap = snapAll()
  const beforeTable = snapTable('purchase_returns')
  const r = await api('POST', `/api/purchase/returns/${id}/complete`, { token: purchaseJwt, body: {} })
  ok('PRT.complete 正例：HTTP 200 + 返回新状态 completed',
    r.status === 200 && r.body?.data?.status === 'completed', `http=${r.status} body=${JSON.stringify(r.body)}`)
  const st = db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(id)?.status
  ok('PRT.complete 正例：库里状态确实变成 completed', st === 'completed', `status=${st}`)
  assertEdge('PRT', id, 'complete', 'confirmed', 'completed', 'PRT.complete 正例')
  assertNoSideEffect(`PRT.complete 正例（${docNo}）`, 'PRT', 'purchase_returns', id, beforeSnap, beforeTable)

  const again = await api('POST', `/api/purchase/returns/${id}/complete`, { token: purchaseJwt, body: {} })
  ok('PRT.complete 负例：已完成再 complete ⇒ 409 TRANSITION_NOT_ALLOWED',
    again.status === 409 && codeOf(again.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${again.status} code=${codeOf(again.body)} msg=${again.body?.message}`)
  ok('PRT.complete 负例：被拒后该单仍是 completed（终态没被推走）',
    db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(id)?.status === 'completed',
    `status=${db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(id)?.status}`)
}

// ===========================================================================
// 2. PRT.cancel（draft → cancelled）—— 从 draft 出发 ⇒ 什么都没发生 ⇒ 必须零副作用
// ===========================================================================
{
  const beforeSnap = snapAll()
  const beforeTable = snapTable('purchase_returns')

  // 负例先行（此时还是 draft）：complete 在 draft 上非法 ⇒ 必须被拒、且状态一字未变
  const badComplete = await api('POST', `/api/purchase/returns/${draftId}/complete`, { token: purchaseJwt, body: {} })
  ok('PRT.complete 负例：draft 上 complete ⇒ 409 TRANSITION_NOT_ALLOWED',
    badComplete.status === 409 && codeOf(badComplete.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${badComplete.status} code=${codeOf(badComplete.body)} msg=${badComplete.body?.message}`)
  ok('PRT.complete 负例：被拒后 draft 单状态一字未变（拒绝是真的拒绝）',
    db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(draftId)?.status === 'draft',
    `status=${db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(draftId)?.status}`)

  const r = await api('POST', `/api/purchase/returns/${draftId}/cancel`, { token: purchaseJwt, body: {} })
  ok('PRT.cancel 正例：HTTP 200 + 返回新状态 cancelled',
    r.status === 200 && r.body?.data?.status === 'cancelled', `http=${r.status} body=${JSON.stringify(r.body)}`)
  const st = db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(draftId)?.status
  ok('PRT.cancel 正例：库里状态确实变成 cancelled', st === 'cancelled', `status=${st}`)
  assertEdge('PRT', draftId, 'cancel', 'draft', 'cancelled', 'PRT.cancel 正例')
  assertNoSideEffect('PRT.cancel 正例', 'PRT', 'purchase_returns', draftId, beforeSnap, beforeTable)

  const again = await api('POST', `/api/purchase/returns/${draftId}/cancel`, { token: purchaseJwt, body: {} })
  ok('PRT.cancel 负例：已作废再 cancel ⇒ 409 TRANSITION_NOT_ALLOWED',
    again.status === 409 && codeOf(again.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${again.status} code=${codeOf(again.body)} msg=${again.body?.message}`)
}

// ===========================================================================
// 3. PRT.cancel 负例：confirmed 上 cancel（作废只从 draft 出发）
// ===========================================================================
{
  const r = await api('POST', `/api/purchase/returns/${confirmedA}/cancel`, { token: purchaseJwt, body: {} })
  ok('PRT.cancel 负例：confirmed 上 cancel ⇒ 409 TRANSITION_NOT_ALLOWED',
    r.status === 409 && codeOf(r.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${r.status} code=${codeOf(r.body)} msg=${r.body?.message}`)
  ok('PRT.cancel 负例：被拒后该单仍是 confirmed（我造的那张没被碰）',
    db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(confirmedA)?.status === 'confirmed',
    `status=${db.prepare('SELECT status FROM purchase_returns WHERE id=?').get(confirmedA)?.status}`)
}

// ===========================================================================
// 4. GR.close（inspected → closed）—— 归档动作，零副作用
// ===========================================================================
{
  const id = inspectedId
  const docNo = db.prepare('SELECT doc_no FROM purchase_receipts WHERE id=?').get(id).doc_no

  // 负例先行（用**另一张我造的** received 单）：更早的状态必须有门挡住
  const bad = await api('POST', `/api/purchase/receipts/${receivedId}/close`, { token: purchaseJwt, body: {} })
  ok('GR.close 负例：received（还没质检）上 close ⇒ 409 TRANSITION_NOT_ALLOWED',
    bad.status === 409 && codeOf(bad.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${bad.status} code=${codeOf(bad.body)} msg=${bad.body?.message}`)
  ok('GR.close 负例：被拒后该到货单仍是 received（我造的那张没被碰）',
    db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(receivedId)?.status === 'received',
    `status=${db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(receivedId)?.status}`)

  const beforeSnap = snapAll()
  const beforeTable = snapTable('purchase_receipts')
  const r = await api('POST', `/api/purchase/receipts/${id}/close`, { token: purchaseJwt, body: {} })
  ok('GR.close 正例：HTTP 200 + 返回新状态 closed',
    r.status === 200 && r.body?.data?.status === 'closed', `http=${r.status} body=${JSON.stringify(r.body)}`)
  const st = db.prepare('SELECT status FROM purchase_receipts WHERE id=?').get(id)?.status
  ok('GR.close 正例：库里状态确实变成 closed', st === 'closed', `status=${st}`)
  assertEdge('GR', id, 'close', 'inspected', 'closed', 'GR.close 正例')
  assertNoSideEffect(`GR.close 正例（${docNo}）`, 'GR', 'purchase_receipts', id, beforeSnap, beforeTable)

  const again = await api('POST', `/api/purchase/receipts/${id}/close`, { token: purchaseJwt, body: {} })
  ok('GR.close 负例：已关闭再 close ⇒ 409 TRANSITION_NOT_ALLOWED',
    again.status === 409 && codeOf(again.body) === 'TRANSITION_NOT_ALLOWED',
    `http=${again.status} code=${codeOf(again.body)} msg=${again.body?.message}`)
}

// ===========================================================================
// 5. 不存在的 id ⇒ 404（三个动作各一条）
// ===========================================================================
{
  const ghost = 99999999
  for (const [label, p] of [
    ['PRT.cancel', `/api/purchase/returns/${ghost}/cancel`],
    ['PRT.complete', `/api/purchase/returns/${ghost}/complete`],
    ['GR.close', `/api/purchase/receipts/${ghost}/close`]
  ]) {
    const r = await api('POST', p, { token: purchaseJwt, body: {} })
    ok(`${label} 负例：不存在的 id ⇒ 404`, r.status === 404, `http=${r.status} msg=${r.body?.message}`)
  }
}

// ===========================================================================
// 6. 角色门：viewer 不在写角色白名单里 ⇒ 403（证明这三条门不是"人人可推"）
// ===========================================================================
{
  const returnId = confirmedA
  const rcId = receivedId
  for (const [label, p] of [
    ['PRT.complete', `/api/purchase/returns/${returnId}/complete`],
    ['PRT.cancel', `/api/purchase/returns/${returnId}/cancel`],
    ['GR.close', `/api/purchase/receipts/${rcId}/close`]
  ]) {
    const r = await api('POST', p, { token: viewerJwt, body: {} })
    ok(`${label} 负例：viewer 角色 ⇒ 403`, r.status === 403, `http=${r.status} msg=${r.body?.message}`)
  }
}

// ===========================================================================
// 7. 收尾 · 把自己造的东西连**留痕**一起清干净
// ===========================================================================
// 为什么"删单据"必须连 `doc_events` 一起删：`doc_events` 是按 (doc_type, doc_id) 指向主表的旁支表，
// **没有外键**。只删单据会立刻留下孤儿留痕，而孤儿留痕最坏的一面不是体积：
// 主表自增 id 重新发放后，新单据会**复用旧 id**，于是某张刚建的草稿单的时间线里
// 挂着上一代单据的历史（"按错挂"，不报错、只看得出人不再相信这张单）。
// 本项目已因此被别的测试抓红过三次，所以这里把"清干净"也做成断言，而不是顺手一删。
{
  const qr = Array.from({ length: myReturns.length }, () => '?').join(',')
  const qc = Array.from({ length: myReceipts.length }, () => '?').join(',')
  const eventsOfMine = () =>
    db
      .prepare(`SELECT COUNT(*) c FROM doc_events
                 WHERE (doc_type='PRT' AND doc_id IN (${qr})) OR (doc_type='GR' AND doc_id IN (${qc}))`)
      .get(...myReturns, ...myReceipts).c
  const beforeClean = eventsOfMine()
  ok('收尾：清删之前，我造的单据**确实**留下了留痕（否则下一步"连痕一起删"就是空话）',
    beforeClean >= 3, `我造的单据名下留痕 ${beforeClean} 条`)

  db.transaction(() => {
    db.prepare(`DELETE FROM purchase_returns WHERE id IN (${qr})`).run(...myReturns)
    db.prepare(`DELETE FROM purchase_receipts WHERE id IN (${qc})`).run(...myReceipts)
    db.prepare(`DELETE FROM doc_events WHERE (doc_type='PRT' AND doc_id IN (${qr})) OR (doc_type='GR' AND doc_id IN (${qc}))`)
      .run(...myReturns, ...myReceipts)
    db.prepare(`DELETE FROM audit_logs WHERE module='purchase' AND entity IN ('purchase_returns','purchase_receipts')
                  AND entity_id IN (${qr},${qc})`)
      .run(...myReturns, ...myReceipts)
  })()

  const leftReturns = db.prepare(`SELECT COUNT(*) c FROM purchase_returns WHERE id IN (${qr})`).get(...myReturns).c
  const leftReceipts = db.prepare(`SELECT COUNT(*) c FROM purchase_receipts WHERE id IN (${qc})`).get(...myReceipts).c
  ok('收尾：我造的 5 张夹具彻底消失（退货 3 张 + 到货 2 张）',
    leftReturns === 0 && leftReceipts === 0,
    `残留 退货 ${leftReturns} 张 / 到货 ${leftReceipts} 张`)
  ok('收尾：不留**孤儿留痕**（我造的单据名下的 doc_events 已一并删除）', eventsOfMine() === 0,
    `残留 ${eventsOfMine()} 条`)
  ok('收尾：两张表的总行数回到夹具落库之前的基线（没有多也没有少）',
    db.prepare('SELECT COUNT(*) c FROM purchase_returns').get().c === baseline.returns &&
      db.prepare('SELECT COUNT(*) c FROM purchase_receipts').get().c === baseline.receipts,
    `returns ${db.prepare('SELECT COUNT(*) c FROM purchase_returns').get().c}/${baseline.returns} · ` +
      `receipts ${db.prepare('SELECT COUNT(*) c FROM purchase_receipts').get().c}/${baseline.receipts}`)
  // 顺带一条结构判据：库里其余单据的留痕一条都不能被我误删
  ok('收尾：误删检查 —— 我没有删掉任何"不属于我造的单据"的留痕',
    db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PRT'").get().c > 0 &&
      db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='GR'").get().c > 0,
    `PRT 留痕 ${db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PRT'").get().c} 条 / ` +
      `GR 留痕 ${db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='GR'").get().c} 条`)
}

// ===========================================================================
// 收尾
// ===========================================================================
const pass = R.filter((x) => x.ok).length
const failed = R.length - pass
console.log(`\n── 采购域门守卫（行业=${INDUSTRY}）──`)
for (const x of R) console.log(`${x.ok ? 'GREEN' : '  red'}  ${x.name}   [${x.detail}]`)
if (failed) console.log(`\n失败项：\n${R.filter((x) => !x.ok).map((x) => ` - ${x.name}`).join('\n')}`)
console.log(`\n通过 ${pass} / 失败 ${failed}`)

const stop = () =>
  new Promise((resolve) => {
    const pid = srv.pid
    if (srv.exitCode !== null || srv.signalCode !== null) return resolve()
    const timer = setTimeout(() => {
      let alive = false
      try { process.kill(pid, 0); alive = true } catch { /* 已退出 */ }
      if (alive) console.log(`⚠️ 回收失败，pid ${pid} 仍在（请 lsof -p ${pid} 复查）`)
      resolve()
    }, 2000)
    srv.once('exit', () => { clearTimeout(timer); resolve() })
    try { srv.kill('SIGKILL') } catch { /* ignore */ }
  })
process.on('exit', () => { try { srv.kill('SIGKILL') } catch { /* 静默兜底 */ } })
await stop()
db.close()
process.exit(failed ? 1 : 0)
