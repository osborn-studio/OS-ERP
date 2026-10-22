/**
 * ============================================================================
 * 文件标识：scripts/test-gates-other.mjs ｜ 测试：「把门开出来」· 其它域三条流转边（WR.inspect / OM.complete / RC.confirm）
 * ============================================================================
 * 【职责】测试：「把门开出来」· 其它域三条流转边（WR.inspect / OM.complete / RC.confirm）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 「把门开出来」· 其它域三条流转边（WR.inspect / OM.complete / RC.confirm）
 *
 * 这一批修的是同一个形状的缺陷：内核 `008_doc_kernel.cjs` 的 `ACTIONS` 里**早就登记了**这几条边
 * （含权限点、`is_danger`），但后端从来没有对应 HTTP 路由 ⇒ **系统认为这一步合法，却没有任何人
 * 能触发它**，单据永远卡在中间态：
 *   · `WR.inspect`  received → inspected —— 委外加工回来的货**质检没有入口**（三库停在 received：2 / 0 / 2）；
 *   · `OM.complete` shipped → completed  —— 平台侧早就完成了，系统里永远显示"已发货"（88 / 64 / 93）；
 *   · `RC.confirm`  uploaded → confirmed —— **总部确认日结从来没有入口**（10 / 40 / 10 全部停在 uploaded）。
 *
 * 本脚本按**判据**验，不按接口验。四条：
 *   ① **正例**：从合法来源态打到**真实 HTTP**（独立端口 + 独立隔离库），断言 200；
 *      **库里状态真的变了**；并且 `doc_events` 里落下了**那一条边** —— `from`/`to` 与内核
 *      （`doc_actions` 表，即内核写进去的那份定义）**逐字相同**。
 *      为什么必须对着 `doc_actions` 比而不是写死 'received'→'inspected'：写死等于把内核的定义
 *      在测试里**再抄一份**，两份迟早分叉，而分叉时测试会替错的那份背书。
 *   ② **负例**：从**非法来源态**打同一路由，必须被拒（409 `TRANSITION_NOT_ALLOWED`）；
 *      不存在的 id ⇒ 404；**RC 确认过再确认一次 ⇒ 必须被拒**（不能重复确认）。
 *      非法判定**只由内核做** —— 路由里如果自己又写一份状态白名单，判据就有两处，必然分叉。
 *   ③ **副作用零**：三条路由**都不许动库存**。入库那一步（`WR.receive`）已经 `applyStockIn` 过一次，
 *      质检再入一次就是把同一批货记两遍。断言 `inventory_transactions` / `inventory_stocks`
 *      的**行数与结存一字未变**。
 *   ④ **不留残留**：夹具以固定标记 `GOTEST-*` 建、跑完删（含留痕），所以本脚本可以反复跑。
 *      收尾有一行「通过 N / 失败 M」给跑批清单抓。
 *
 * ⚠️ 三库都要跑得动：`outsourcing_receipts` 在 **food 库是 0 行**（food 连 `outsourcing_orders`
 *    都是 0 行）—— 那种情况要**连委外订单一起造一张**，**不是跳过**。
 *    "跳过"与"通过"的输出一样，那是本项目的假绿，明令禁止。
 *
 * 用法：node scripts/test-gates-other.mjs [cosmetic|food|apparel]
 *   隔离：必须设 `GML_DATA_DIR=/tmp/...`（不设时**自落**到 /tmp/gml-test-gates-other 并从仓库
 *   data/ **只读**备份三库）；指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3' // 不受 GML_DATA_DIR 影响
import { stopAndReport, installReapFallback } from './lib/reap.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const SELF_NAME = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
const RAW_ENV = process.env.GML_DATA_DIR || ''
const ISOLATED_DIR = RAW_ENV ? path.resolve(RAW_ENV) : path.join('/tmp', `gml-${SELF_NAME}`)
if (ISOLATED_DIR === REPO_DATA || ISOLATED_DIR.startsWith(REPO_DATA + path.sep)) {
  console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${ISOLATED_DIR}）。本脚本会建单/推进状态，只允许在 /tmp 下的副本上跑。`)
  process.exit(2)
}
if (!ISOLATED_DIR.startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${ISOLATED_DIR}）；不设 GML_DATA_DIR 时自落到 /tmp/gml-${SELF_NAME}。`)
  process.exit(2)
}
// ⚠️ 先钉 env 再 import：`server/db/index.js` 的 DATA_DIR 是**模块加载时**求值的
process.env.GML_DATA_DIR = ISOLATED_DIR

if (!RAW_ENV) {
  fs.mkdirSync(ISOLATED_DIR, { recursive: true })
  for (const c of ['cosmetic', 'food', 'apparel']) {
    const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
    const dst = path.join(ISOLATED_DIR, `gml_${c}.db`)
    for (const ext of ['', '-wal', '-shm']) {
      const p = dst + ext
      if (fs.existsSync(p)) fs.rmSync(p)
    }
    await src.backup(dst)
    src.close()
  }
  console.log(`[落点] 未设 GML_DATA_DIR ⇒ 自落到 ${ISOLATED_DIR}（已从仓库 data/ 只读备份三库；仓库 data/ 不会被写）`)
} else {
  console.log(`[落点] GML_DATA_DIR=${ISOLATED_DIR}`)
}

const { dbPathFor, INDUSTRIES } = await import('../server/db/index.js')

const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` 会把**未知行业码静默归一成 cosmetic**，一个字母打错（`fodd`）
// 会安静地跑另一个库，拿到的"绿"是假的 ⇒ 调用侧自己把住"错名要响"。
if (process.argv[2] && !Object.hasOwn(INDUSTRIES, process.argv[2])) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}
const PORT = Number(process.env.TEST_PORT || 43917)
const BASE = `http://127.0.0.1:${PORT}`
const MARK = 'GOTEST' // 夹具标记：建/删都靠它，所以本脚本可重复跑
const TODAY = '2026-10-17'

let pass = 0
let fail = 0
const failedNames = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failedNames.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const safeJson = (v) => {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(v)
  }
}
const ph = (n) => new Array(n).fill('?').join(',')

// ---------------------------------------------------------------- 起服务
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  // GML_DATA_DIR 显式给出：父子同源、不靠继承 —— 否则"父进程读副本、子进程 boot 开发库"
  // 这种半隔离会静悄悄发生，而且一次会把三个行业库全 boot 一遍。
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: ISOLATED_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))
installReapFallback(srv)

const gateFail = async (msg) => {
  console.error(msg)
  await stopAndReport(srv, { port: PORT })
  process.exit(2)
}
const ready = await new Promise((res) => {
  const t0 = Date.now()
  const t = setInterval(() => {
    if (log.includes('服务已启动')) {
      clearInterval(t)
      res(true)
    } else if (Date.now() - t0 > 180000) {
      clearInterval(t)
      res(false)
    }
  }, 300)
})
if (!ready) await gateFail(`✗ 服务启动失败（180s 未就绪）：\n${log.split('\n').slice(-30).join('\n')}`)
// 落点自证：判据取自**子进程自报的实际库路径**，不是自己再算一遍
const dbPaths = [...log.matchAll(/数据库：(\S+)/g)].map((m) => m[1])
if (!dbPaths.length) await gateFail('✗ 拒绝运行：子进程没有自报库路径（`数据库：` 一行都没抓到），无法确认隔离是否生效。')
const outside = [...new Set(dbPaths)].filter((p) => !p.startsWith(ISOLATED_DIR + '/'))
if (outside.length) await gateFail(`✗ 拒绝运行：子进程实际使用的库不在隔离目录下：${outside.join(' / ')}`)
console.log(`[落点自证] 子进程自报 ${new Set(dbPaths).size} 个库路径，全部在 ${ISOLATED_DIR}/ 下`)
console.log(`✅ 服务已启动（行业=${INDUSTRY}，端口=${PORT}）`)

// ---------------------------------------------------------------- 库连接
const DB_PATH = dbPathFor(INDUSTRY)
const db = new Database(DB_PATH)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
const one = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)

const api = async (method, p, { token, body } = {}) => {
  const r = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const login = async (u, p) => (await api('POST', '/api/auth/login', { body: { username: u, password: p, industry: INDUSTRY } })).body?.data?.token

// ---------------------------------------------------------------- 夹具自清（可重复跑）
function purgeFixtures() {
  const ids = (sql) => all(sql).map((r) => r.id)
  const omIds = ids(`SELECT id FROM oms_orders WHERE platform_order_no LIKE '${MARK}-%'`)
  const wrIds = ids(`SELECT id FROM outsourcing_receipts WHERE doc_no LIKE '${MARK}-%'`)
  const woIds = ids(`SELECT id FROM outsourcing_orders WHERE doc_no LIKE '${MARK}-%'`)
  const rcIds = ids(`SELECT id FROM pos_daily_closes WHERE batch_no LIKE '${MARK}-%'`)
  // 留痕先删（doc_events 是跨类型的旁支表：主表删了它就成了"指向不存在单据的孤儿"）
  for (const [t, list] of [
    ['OM', omIds],
    ['WR', wrIds],
    ['RC', rcIds]
  ]) {
    if (list.length) db.prepare(`DELETE FROM doc_events WHERE doc_type=? AND doc_id IN (${ph(list.length)})`).run(t, ...list)
  }
  db.prepare(`DELETE FROM doc_events WHERE doc_no LIKE '${MARK}%'`).run()
  if (wrIds.length) db.prepare(`DELETE FROM outsourcing_receipt_items WHERE receipt_id IN (${ph(wrIds.length)})`).run(...wrIds)
  if (wrIds.length) db.prepare(`DELETE FROM outsourcing_receipts WHERE id IN (${ph(wrIds.length)})`).run(...wrIds)
  if (woIds.length) db.prepare(`DELETE FROM outsourcing_order_items WHERE order_id IN (${ph(woIds.length)})`).run(...woIds)
  if (woIds.length) db.prepare(`DELETE FROM outsourcing_orders WHERE id IN (${ph(woIds.length)})`).run(...woIds)
  if (omIds.length) db.prepare(`DELETE FROM oms_order_items WHERE oms_order_id IN (${ph(omIds.length)})`).run(...omIds)
  if (omIds.length) db.prepare(`DELETE FROM oms_orders WHERE id IN (${ph(omIds.length)})`).run(...omIds)
  if (rcIds.length) db.prepare(`DELETE FROM pos_daily_closes WHERE id IN (${ph(rcIds.length)})`).run(...rcIds)
}

purgeFixtures() // 清掉上一轮（若有）

/** 造一张委外收货单（含其委外订单 —— food 库连订单都没有） */
function mkReceipt(status) {
  let order = one(`SELECT id, supplier_id, warehouse_id FROM outsourcing_orders ORDER BY id LIMIT 1`)
  let woId
  if (order) {
    woId = order.id
  } else {
    const sup = one('SELECT id FROM suppliers ORDER BY id LIMIT 1')
    const wh = one("SELECT id FROM warehouses WHERE type IN ('central','region','kitchen','store') ORDER BY id LIMIT 1")
    if (!sup || !wh) throw new Error('夹具前置缺失：本库没有 suppliers / warehouses，无法造委外订单')
    woId = db
      .prepare(
        `INSERT INTO outsourcing_orders (doc_no,supplier_id,warehouse_id,order_date,status)
         VALUES (?,?,?,?, 'received')`
      )
      .run(`${MARK}-WO-${INDUSTRY}`, sup.id, wh.id, TODAY).lastInsertRowid
    order = one('SELECT id, supplier_id, warehouse_id FROM outsourcing_orders WHERE id=?', woId)
  }
  const rid = db
    .prepare(
      `INSERT INTO outsourcing_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,process_fee,total_amount)
       VALUES (?,?,?,?,?,?,1,1,2)`
    )
    .run(`${MARK}-WR-${INDUSTRY}-${status}`, order.id, order.supplier_id, order.warehouse_id, TODAY, status).lastInsertRowid
  return rid
}

/** 造一张商城订单 */
function mkOms(status) {
  const pf = one('SELECT id FROM platforms ORDER BY id LIMIT 1')
  if (!pf) throw new Error('夹具前置缺失：本库没有 platforms，无法造商城订单')
  return db
    .prepare(
      `INSERT INTO oms_orders (platform_id,platform_order_no,order_time,pay_time,status,pay_amount)
       VALUES (?,?,?,?,?,10)`
    )
    .run(pf.id, `${MARK}-OM-${INDUSTRY}-${status}`, `${TODAY} 10:00:00`, `${TODAY} 10:01:00`, status).lastInsertRowid
}

/** 造一张门店日结单 */
function mkClose(status) {
  const st = one(
    `SELECT s.id AS store_id, (SELECT w.id FROM warehouses w WHERE w.store_id=s.id ORDER BY w.id LIMIT 1) AS wh_id
       FROM stores s ORDER BY s.id LIMIT 1`
  )
  if (!st) throw new Error('夹具前置缺失：本库没有 stores，无法造日结单')
  const whId = st.wh_id || one('SELECT id FROM warehouses ORDER BY id LIMIT 1')?.id
  if (!whId) throw new Error('夹具前置缺失：本库没有 warehouses，无法造日结单')
  return db
    .prepare(
      `INSERT INTO pos_daily_closes (batch_no,store_id,warehouse_id,biz_date,status,uploaded_orders)
       VALUES (?,?,?,?,?,1)`
    )
    .run(`${MARK}-RC-${INDUSTRY}-${status}`, st.store_id, whId, TODAY, status).lastInsertRowid
}

/** 内核里这条边的定义（判据来源：内核写进 `doc_actions` 的那一份，不在这里抄一遍） */
const edgeOf = (docType, action) =>
  one('SELECT action, action_name, from_state, to_state FROM doc_actions WHERE doc_type=? AND action=?', docType, action)

/** 最近一条该单据该动作的留痕 */
const eventOf = (docType, id, action) =>
  one(
    `SELECT * FROM doc_events WHERE doc_type=? AND doc_id=? AND action=? ORDER BY id DESC LIMIT 1`,
    docType,
    id,
    action
  )

/** 库存快照：**行数 + 结存合计**（只比行数会漏掉"行数没变、数量被改"的那种动手） */
const invSnapshot = () => ({
  txnRows: one('SELECT COUNT(*) c FROM inventory_transactions').c,
  txnQty: one('SELECT COALESCE(SUM(qty),0) q FROM inventory_transactions').q,
  stockRows: one('SELECT COUNT(*) c FROM inventory_stocks').c,
  onHand: one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q,
  reserved: one('SELECT COALESCE(SUM(qty_reserved),0) q FROM inventory_stocks').q
})

const adminJwt = await login('admin', '12345')
ok('登录 admin（三库通用演示账号）', !!adminJwt, adminJwt ? '' : '登录失败')
if (!adminJwt) {
  await stopAndReport(srv, { port: PORT })
  process.exit(1)
}

const invBefore = invSnapshot()

// ================================================================ ① 正例
section('① 正例：合法来源态 → 真实 HTTP → 状态变了 + 留痕落了那条边')

const wrEdge = edgeOf('WR', 'inspect')
const omEdge = edgeOf('OM', 'complete')
const rcEdge = edgeOf('RC', 'confirm')
ok(
  '内核三条边在册（WR.inspect=received→inspected / OM.complete=shipped→completed / RC.confirm=uploaded→confirmed）',
  wrEdge?.from_state === 'received' &&
    wrEdge?.to_state === 'inspected' &&
    omEdge?.from_state === 'shipped' &&
    omEdge?.to_state === 'completed' &&
    rcEdge?.from_state === 'uploaded' &&
    rcEdge?.to_state === 'confirmed',
  `${safeJson(wrEdge)} / ${safeJson(omEdge)} / ${safeJson(rcEdge)}`
)

// —— WR.inspect
{
  const rid = mkReceipt('received')
  const r = await api('POST', `/api/outsourcing/receipts/${rid}/inspect`, { token: adminJwt, body: { inspector: '质检员甲', remark: '外观抽检合格' } })
  const st = one('SELECT status FROM outsourcing_receipts WHERE id=?', rid)?.status
  const ev = eventOf('WR', rid, 'inspect')
  ok(`WR.inspect 返回 200（实得 ${r.status}）`, r.status === 200, safeJson(r.body).slice(0, 200))
  ok(`WR.inspect 响应体 status=inspected（实得 ${r.body?.data?.status}）`, r.body?.data?.status === 'inspected')
  ok(`WR.inspect 库里状态确实变了 received→inspected（实得 ${st}）`, st === 'inspected')
  ok(
    `WR.inspect doc_events 落了那条边（from=${ev?.from_state} to=${ev?.to_state}，内核 from=${wrEdge?.from_state} to=${wrEdge?.to_state}）`,
    ev && ev.from_state === wrEdge.from_state && ev.to_state === wrEdge.to_state
  )
  ok(
    `WR.inspect 留痕带操作人 + payload 记了 inspector（actor=${ev?.actor_name} payload=${ev?.payload_json}）`,
    !!ev?.actor_name && String(ev?.payload_json || '').includes('质检员甲'),
    `actor_name=${ev?.actor_name} payload=${ev?.payload_json}`
  )
  // 在列表接口上真的看得到（前端挂的就是这个 GET）
  const list = await api('GET', '/api/outsourcing/receipts?pageSize=500', { token: adminJwt })
  const row = (list.body?.data?.list || []).find((x) => Number(x.id) === Number(rid))
  ok('WR 新状态在 `GET /outsourcing/receipts` 列表里可见（前端按钮就挂在这个列表上）', row?.status === 'inspected', safeJson(row).slice(0, 160))
}

// —— OM.complete
{
  const oid = mkOms('shipped')
  const r = await api('POST', `/api/oms/orders/${oid}/complete`, { token: adminJwt, body: {} })
  const st = one('SELECT status FROM oms_orders WHERE id=?', oid)?.status
  const ev = eventOf('OM', oid, 'complete')
  ok(`OM.complete 返回 200（实得 ${r.status}）`, r.status === 200, safeJson(r.body).slice(0, 200))
  ok(`OM.complete 响应体 status=completed（实得 ${r.body?.data?.status}）`, r.body?.data?.status === 'completed')
  ok(`OM.complete 库里状态确实变了 shipped→completed（实得 ${st}）`, st === 'completed')
  ok(
    `OM.complete doc_events 落了那条边（from=${ev?.from_state} to=${ev?.to_state}，内核 from=${omEdge?.from_state} to=${omEdge?.to_state}）`,
    ev && ev.from_state === omEdge.from_state && ev.to_state === omEdge.to_state
  )
  ok(`OM.complete 留痕带操作人（actor=${ev?.actor_name}）`, !!ev?.actor_name)
}

// —— RC.confirm
{
  const cid = mkClose('uploaded')
  const r = await api('POST', `/api/pos/daily-closes/${cid}/confirm`, { token: adminJwt, body: {} })
  const st = one('SELECT status FROM pos_daily_closes WHERE id=?', cid)?.status
  const ev = eventOf('RC', cid, 'confirm')
  ok(`RC.confirm 返回 200（实得 ${r.status}）`, r.status === 200, safeJson(r.body).slice(0, 200))
  ok(`RC.confirm 响应体 status=confirmed（实得 ${r.body?.data?.status}）`, r.body?.data?.status === 'confirmed')
  ok(`RC.confirm 库里状态确实变了 uploaded→confirmed（实得 ${st}）`, st === 'confirmed')
  ok(
    `RC.confirm doc_events 落了那条边（from=${ev?.from_state} to=${ev?.to_state}，内核 from=${rcEdge?.from_state} to=${rcEdge?.to_state}）`,
    ev && ev.from_state === rcEdge.from_state && ev.to_state === rcEdge.to_state
  )
  ok(`RC.confirm 留痕记下了"谁确认的"（actor_id=${ev?.actor_id} actor_name=${ev?.actor_name}）`, !!ev?.actor_name && ev?.actor_id != null, safeJson(ev).slice(0, 200))

  // 追加负例：**确认过再确认一次必须被拒**（不能重复确认）
  const again = await api('POST', `/api/pos/daily-closes/${cid}/confirm`, { token: adminJwt, body: {} })
  ok(
    `RC.confirm 再打一次 → 409 TRANSITION_NOT_ALLOWED（实得 http=${again.status} err=${again.body?.error || again.body?.detail?.code}）`,
    again.status === 409 && (again.body?.error || again.body?.detail?.code) === 'TRANSITION_NOT_ALLOWED',
    safeJson(again.body).slice(0, 220)
  )
  const st2 = one('SELECT status FROM pos_daily_closes WHERE id=?', cid)?.status
  ok(`RC.confirm 重复调用没有把状态改坏（仍为 ${st2}）`, st2 === 'confirmed')
  const evCount = one(`SELECT COUNT(*) c FROM doc_events WHERE doc_type='RC' AND doc_id=? AND action='confirm'`, cid).c
  ok(`RC.confirm 重复调用**没有多写一条留痕**（confirm 留痕条数=${evCount}，期望 1）`, evCount === 1, `实得 ${evCount}`)
}

// ================================================================ ② 负例
section('② 负例：非法来源态 / 不存在的 id')

// —— WR.inspect 从 draft（内核里 inspect 的出边只有 received→inspected）
{
  const rid = mkReceipt('draft')
  const r = await api('POST', `/api/outsourcing/receipts/${rid}/inspect`, { token: adminJwt, body: {} })
  const st = one('SELECT status FROM outsourcing_receipts WHERE id=?', rid)?.status
  ok(
    `WR.inspect 从 draft 打 → 409 TRANSITION_NOT_ALLOWED（实得 http=${r.status} err=${r.body?.error || r.body?.detail?.code}）`,
    r.status === 409 && (r.body?.error || r.body?.detail?.code) === 'TRANSITION_NOT_ALLOWED',
    safeJson(r.body).slice(0, 220)
  )
  ok(`WR.inspect 被拒后状态没被动（仍为 ${st}）`, st === 'draft')
  const ev = eventOf('WR', rid, 'inspect')
  ok('WR.inspect 被拒后**没有留痕**（留痕只在真的推进时才写）', !ev)
}

// —— OM.complete 从 pending
{
  const oid = mkOms('pending')
  const r = await api('POST', `/api/oms/orders/${oid}/complete`, { token: adminJwt, body: {} })
  const st = one('SELECT status FROM oms_orders WHERE id=?', oid)?.status
  ok(
    `OM.complete 从 pending 打 → 409 TRANSITION_NOT_ALLOWED（实得 http=${r.status} err=${r.body?.error || r.body?.detail?.code}）`,
    r.status === 409 && (r.body?.error || r.body?.detail?.code) === 'TRANSITION_NOT_ALLOWED',
    safeJson(r.body).slice(0, 220)
  )
  ok(`OM.complete 被拒后状态没被动（仍为 ${st}）`, st === 'pending')
}

// —— RC.confirm 从 draft
{
  const cid = mkClose('draft')
  const r = await api('POST', `/api/pos/daily-closes/${cid}/confirm`, { token: adminJwt, body: {} })
  const st = one('SELECT status FROM pos_daily_closes WHERE id=?', cid)?.status
  ok(
    `RC.confirm 从 draft 打 → 409 TRANSITION_NOT_ALLOWED（实得 http=${r.status} err=${r.body?.error || r.body?.detail?.code}）`,
    r.status === 409 && (r.body?.error || r.body?.detail?.code) === 'TRANSITION_NOT_ALLOWED',
    safeJson(r.body).slice(0, 220)
  )
  ok(`RC.confirm 被拒后状态没被动（仍为 ${st}）`, st === 'draft')
}

// —— 不存在的 id ⇒ 404
{
  const NOPE = 999999999
  const a = await api('POST', `/api/outsourcing/receipts/${NOPE}/inspect`, { token: adminJwt, body: {} })
  const b = await api('POST', `/api/oms/orders/${NOPE}/complete`, { token: adminJwt, body: {} })
  const c = await api('POST', `/api/pos/daily-closes/${NOPE}/confirm`, { token: adminJwt, body: {} })
  ok(`WR.inspect 不存在的 id → 404（实得 ${a.status}：${a.body?.message}）`, a.status === 404, safeJson(a.body).slice(0, 160))
  ok(`OM.complete 不存在的 id → 404（实得 ${b.status}：${b.body?.message}）`, b.status === 404, safeJson(b.body).slice(0, 160))
  ok(`RC.confirm 不存在的 id → 404（实得 ${c.status}：${c.body?.message}）`, c.status === 404, safeJson(c.body).slice(0, 160))
}

// ================================================================ ③ 副作用
section('③ 副作用判据：三条路由都不许动库存')
{
  const after = invSnapshot()
  ok(
    `inventory_transactions 行数未变（${invBefore.txnRows} → ${after.txnRows}）`,
    after.txnRows === invBefore.txnRows,
    safeJson({ invBefore, after })
  )
  ok(
    `inventory_transactions 数量合计未变（${invBefore.txnQty} → ${after.txnQty}）`,
    after.txnQty === invBefore.txnQty
  )
  ok(
    `inventory_stocks 行数未变（${invBefore.stockRows} → ${after.stockRows}）`,
    after.stockRows === invBefore.stockRows
  )
  ok(
    `inventory_stocks 结存合计未变（on_hand ${invBefore.onHand} → ${after.onHand}）`,
    after.onHand === invBefore.onHand
  )
  ok(
    `inventory_stocks 预留合计未变（${invBefore.reserved} → ${after.reserved}）`,
    after.reserved === invBefore.reserved
  )
}

// ================================================================ ④ 夹具自清
section('④ 夹具自清：回归不该消耗演示数据')
{
  purgeFixtures()
  const leftover =
    one(`SELECT COUNT(*) c FROM oms_orders WHERE platform_order_no LIKE '${MARK}-%'`).c +
    one(`SELECT COUNT(*) c FROM outsourcing_receipts WHERE doc_no LIKE '${MARK}-%'`).c +
    one(`SELECT COUNT(*) c FROM outsourcing_orders WHERE doc_no LIKE '${MARK}-%'`).c +
    one(`SELECT COUNT(*) c FROM pos_daily_closes WHERE batch_no LIKE '${MARK}-%'`).c
  ok(`没有残留的 GOTEST 夹具（${leftover} 条）`, leftover === 0)
  const orphan = one(
    `SELECT COUNT(*) c FROM doc_events WHERE doc_no LIKE '${MARK}%'`
  ).c
  ok(`没有残留的 GOTEST 留痕（${orphan} 条）`, orphan === 0)
}

// ---------------------------------------------------------------- 收尾
console.log('\n' + '='.repeat(72))
if (fail) {
  console.log(`失败项：${failedNames.join(' | ')}`)
}
console.log(`行业=${INDUSTRY} ｜ 通过 ${pass} / 失败 ${fail}`)
db.close()
await stopAndReport(srv, { port: PORT })
process.exit(fail ? 1 : 0)
