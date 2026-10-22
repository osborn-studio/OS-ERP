/**
 * ============================================================================
 * 文件标识：scripts/verify-purchase-entry.mjs ｜ 数据校验：采购链「入口层」守卫：HTTP ↔ MCP ↔ 通用流转入口 **同一份实现**（真实端口 + 隔离库）
 * ============================================================================
 * 【职责】数据校验：采购链「入口层」守卫：HTTP ↔ MCP ↔ 通用流转入口 **同一份实现**（真实端口 + 隔离库）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购链「入口层」守卫：HTTP ↔ MCP ↔ 通用流转入口 **同一份实现**（真实端口 + 隔离库）
//
// 用法：node scripts/verify-purchase-entry.mjs
//   （不设 GML_DATA_DIR 时会**自落**到 /tmp 并从仓库 data/ 只读备份一份；本脚本会建单/收货/开票）
//
// 判据（P0-1 / P0-2 / P1-5）：
//   A. 同一个动作在 **HTTP 与 MCP 上被拒时，码与文案逐字相同** —— 这才证明是同一份实现，
//      而不是"两个入口各判一套、只是恰好都对"（改前实测：HTTP 200 而 MCP 409；
//      PRQ.convert 在通用入口与 MCP 上是**两句不同的文案**）。
//   B. `warehouse` 越权推采购订单，两条入口都要 403 `PERM_DENIED`。
//   C. `/invoices-available-lines` 必须按**订单行**给行：同订单开票通、跨订单开票被拒。
//
// ---- 隔离落点（本项目硬纪律；形状与 scripts/test-kernel-*.mjs 的 requireIsolatedDataDir 一致）----
//   · 未设 `GML_DATA_DIR` ⇒ **自落**到 /tmp/gml-verify-<脚本名>，并从仓库 data/ **只读**备份三库进去。
//     为什么不是"未设 ⇒ exit 2"：`regress-all` **不设任何 env**，那种写法会把整轮回归自己拦死
//     （本项目真实踩过：三库全"退出码 2"）。本脚本今天不在跑批清单里（`verify-` 前缀、opt-in），
//     但只要哪天有人把它改回 `test-`，自落就是唯一不炸的形状。
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑。
//   · ⚠️ 顺序要点：`server/db/index.js:11` 的 `DATA_DIR` 是**模块加载时**求值的，而 `mcp/tokens.js`
//     静态引了它 ⇒ 其 import 必须挪到"钉 env"之后（改动态 import），否则钉 env 会被抢在前面。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'   // 不读 GML_DATA_DIR

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')
const SELF_NAME = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
const RAW_ENV = process.env.GML_DATA_DIR || ''
const ISOLATED_DIR = RAW_ENV ? path.resolve(RAW_ENV) : path.join('/tmp', `gml-verify-${SELF_NAME}`)
if (ISOLATED_DIR === REPO_DATA || ISOLATED_DIR.startsWith(REPO_DATA + path.sep)) {
  console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${ISOLATED_DIR}）。本脚本会建单/收货/开票，只允许在 /tmp 下的副本上跑。`)
  process.exit(2)
}
if (!ISOLATED_DIR.startsWith('/tmp/')) {
  console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${ISOLATED_DIR}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-verify-${SELF_NAME}。`)
  process.exit(2)
}
// ⚠️ **先钉 env、再 import**：下面任何触到 db/index.js 的 import 都不能在此之前发生
process.env.GML_DATA_DIR = ISOLATED_DIR

const INDUSTRY = 'cosmetic'
const PORT = Number(process.env.TEST_PORT || 44131)
const BASE = `http://127.0.0.1:${PORT}`

if (!RAW_ENV) {
  // 自落时目录里是空的 ⇒ 从仓库 data/ **只读**备份三库（缺了夹具：供应商/仓库/SKU/用户 全没有）
  fs.mkdirSync(ISOLATED_DIR, { recursive: true })
  for (const c of ['cosmetic', 'food', 'apparel']) {
    const src = new Database(path.join(REPO_DATA, `gml_${c}.db`), { readonly: true })
    const dst = path.join(ISOLATED_DIR, `gml_${c}.db`)
    for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
    await src.backup(dst)
    src.close()
  }
  console.log(`[落点] 未设 GML_DATA_DIR ⇒ 自落到 ${ISOLATED_DIR}（已从仓库 data/ 只读备份三库；仓库 data/ 不会被写）`)
} else {
  console.log(`[落点] GML_DATA_DIR=${ISOLATED_DIR}`)
}

// 静态 import 会抢在"钉 env"之前求值 ⇒ 必须动态引（tokens.js → db/index.js）
const { createToken } = await import('../server/mcp/tokens.js')

const DB_PATH = path.join(ISOLATED_DIR, `gml_${INDUSTRY}.db`)
const db = new Database(DB_PATH)
console.log(`[落点] 父进程只连 ${DB_PATH}（不 import db/index.js 的 getDb）`)

const srv = spawn(process.execPath, ['server/index.js'], {
  // ⚠️ 显式注入 `GML_DATA_DIR`：这行是"子进程一定跑在隔离库上"的承重点（别改成只靠继承）
  cwd: ROOT, env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: ISOLATED_DIR }, stdio: ['ignore', 'pipe', 'pipe']
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
console.log(`服务已启动（落点：${log.split('\n').find((l) => l.includes('美妆')) || '?'}）`)

// 闸门（启动即验）：判据取自**子进程自报的实际库路径**（`server/index.js:123` 的那句
// `[gml] <版本> 数据库：<真实路径>`），不是自己再算一遍 —— "报告与实际必须同源"。
// ⚠️ 这里**不能**复用文件末尾的 `stopAndReport`：那是个 `const` 箭头函数，此刻还在 TDZ 里，
//    调它会抛 ReferenceError 而不是干净地 exit 2。拒跑路径自己 kill 子进程即可。
const gateFail = (msg) => {
  console.error(msg)
  try { srv.kill('SIGKILL') } catch { /* 已经退了 */ }
  process.exit(2)
}
const dbPaths = [...log.matchAll(/数据库：(\S+)/g)].map((m) => m[1])
if (!dbPaths.length) gateFail('✗ 拒绝运行：子进程没有自报库路径（`数据库：` 一行都没抓到），无法确认隔离是否生效。')
const outside = [...new Set(dbPaths)].filter((p) => !p.startsWith(ISOLATED_DIR + '/'))
if (outside.length) gateFail(`✗ 拒绝运行：子进程实际使用的库不在隔离目录下：${outside.join(' / ')}（期望前缀 ${ISOLATED_DIR}/）`)
console.log(`[落点自证] 子进程自报 ${new Set(dbPaths).size} 个库路径，全部在 ${ISOLATED_DIR}/ 下`)

const api = async (method, path, { token, body } = {}) => {
  const r = await fetch(BASE + path, {
    method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const login = async (u, p) => (await api('POST', '/api/auth/login', { body: { username: u, password: p, industry: INDUSTRY } })).body?.data?.token
let seq = 0
const mcp = async (name, args, token) => {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-industry': INDUSTRY, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: (seq += 1), method: 'tools/call', params: { name, arguments: args } })
  })
  return { status: r.status, body: await r.json().catch(() => ({})) }
}
const mcpErr = (r) => !!r.body?.error || r.body?.result?.isError === true
const mcpText = (r) => r.body?.result?.content?.[0]?.text ?? r.body?.error?.message
const mcpData = (r) => { const t = mcpText(r); try { return JSON.parse(t) } catch { return t } }
/** danger 级：先拿 confirm_token → 管理员确认 → 再调一次 */
async function confirmed(name, args, token, approverJwt) {
  const first = await mcp(name, args, token)
  const cfm = mcpData(first)?.confirm_token
  if (!cfm) return { first, final: first }
  const appr = await api('POST', `/mcp/confirmations/${cfm}/approve`, { token: approverJwt })
  return { first, appr, final: await mcp(name, { ...args, confirm_token: cfm }, token) }
}

const R = []
const ok = (n, cond, d) => R.push({ n, ok: !!cond, d: String(d) })

const adminJwt = await login('admin', '12345')
const whJwt = await login('warehouse', '123456')
const uidOf = (u) => db.prepare('SELECT id FROM users WHERE username=?').get(u)?.id ?? null
const tkAdmin = createToken(db, { name: `VP·admin${Date.now()}`, industry: INDUSTRY, ownerUserId: uidOf('admin'), scopes: 'read,write,danger' }).token
const tkWh = createToken(db, { name: `VP·wh${Date.now()}`, industry: INDUSTRY, ownerUserId: uidOf('warehouse'), scopes: 'read,write,danger' }).token
ok('登录 + 两个令牌（admin 属主 / warehouse 属主）', !!adminJwt && !!tkAdmin && !!tkWh, `${!!adminJwt}/${!!tkAdmin}/${!!tkWh}`)

// ---- 夹具：一张被合法提交的采购订单 ----
const sup = db.prepare('SELECT sp.supplier_id, sp.sku_id, sp.price FROM supplier_products sp WHERE sp.is_available=1 AND sp.price>0 LIMIT 1').get()
const wh = db.prepare("SELECT id FROM warehouses WHERE type IN ('central','region','kitchen') ORDER BY id LIMIT 1").get()
const mkPo = async () => {
  const c = await api('POST', '/api/purchase/orders', {
    token: adminJwt,
    body: { supplier_id: sup.supplier_id, warehouse_id: wh.id, order_date: '2026-10-16', items: [{ sku_id: sup.sku_id, qty: 10, price: sup.price, tax_rate: 13 }] }
  })
  const id = c.body?.data?.id
  await api('POST', `/api/purchase/orders/${id}/status`, { token: adminJwt, body: { action: 'submit' } })
  return id
}
const poForRecv = await mkPo()
const poForAppr = await mkPo()

// ============ A. PO.receive：HTTP vs MCP 必须同码同文案 ============
const hRecv = await api('POST', `/api/purchase/orders/${poForRecv}/status`, { token: adminJwt, body: { action: 'receive' } })
ok('A1 HTTP status{receive} → 409 EFFECT_REQUIRES_BUSINESS_API',
  hRecv.status === 409 && hRecv.body?.error === 'EFFECT_REQUIRES_BUSINESS_API',
  `http=${hRecv.status} err=${hRecv.body?.error}`)
const mRecv = await confirmed('purchase.advance_order', { order_id: poForRecv, action: 'receive' }, tkAdmin, whJwt)
ok('A2 MCP purchase.advance_order{receive} → 409 EFFECT_REQUIRES_BUSINESS_API',
  mcpErr(mRecv.final) && mcpData(mRecv.final)?.error === 'EFFECT_REQUIRES_BUSINESS_API',
  `err=${mcpData(mRecv.final)?.error || JSON.stringify(mcpData(mRecv.final)).slice(0, 120)}`)
const httpMsg = hRecv.body?.message || ''
const mcpMsg = mcpData(mRecv.final)?.message || mcpData(mRecv.final)?.summary || ''
ok('A3 HTTP 与 MCP 的**文案逐字相同**', httpMsg && httpMsg === mcpMsg, `HTTP「${httpMsg}」 vs MCP「${mcpMsg}」`)
const stAfterRecv = db.prepare('SELECT status FROM purchase_orders WHERE id=?').get(poForRecv).status
ok('A4 两条路都没有改动订单状态', stAfterRecv === 'submitted', `status=${stAfterRecv}`)

// ============ B. P0-2：warehouse 属主令牌 approve → 403 PERM_DENIED ============
const hAppr = await api('POST', `/api/purchase/orders/${poForAppr}/status`, { token: whJwt, body: { action: 'approve' } })
ok('B1 HTTP warehouse approve → 403 PERM_DENIED', hAppr.status === 403 && hAppr.body?.error === 'PERM_DENIED',
  `http=${hAppr.status} err=${hAppr.body?.error} perm=${hAppr.body?.detail?.permCode}`)
// danger 级「执行人 = 确认单上的真人」：要验 warehouse 越权，就得让 **warehouse 当确认人**
const mAppr = await confirmed('purchase.advance_order', { order_id: poForAppr, action: 'approve' }, tkAdmin, whJwt)
ok('B2 MCP warehouse 属主令牌 approve → 403 PERM_DENIED',
  mcpErr(mAppr.final) && mcpData(mAppr.final)?.error === 'PERM_DENIED',
  `err=${mcpData(mAppr.final)?.error} perm=${mcpData(mAppr.final)?.detail?.permCode}`)

// ============ C. PRQ.convert：MCP 与通用流转入口同码同文案 ============
const prq = db.prepare("SELECT id FROM purchase_requisitions WHERE status='approved' ORDER BY id LIMIT 1").get()
if (!prq) {
  ok('C 需要一张 approved 请购单', false, '库里没有 approved 请购单，C 段跳过')
} else {
  const gConv = await api('POST', '/api/docflow/transition', { token: adminJwt, body: { doc_type: 'PRQ', id: prq.id, action: 'convert' } })
  ok('C1 通用流转入口 PRQ.convert → 409 EFFECT_REQUIRES_BUSINESS_API',
    gConv.status === 409 && (gConv.body?.detail?.code || gConv.body?.error) === 'EFFECT_REQUIRES_BUSINESS_API',
    `http=${gConv.status} code=${gConv.body?.detail?.code || gConv.body?.error}`)
  const mConv = await confirmed('purchase.advance_requisition', { requisition_id: prq.id, action: 'convert' }, tkAdmin, whJwt)
  ok('C2 MCP purchase.advance_requisition{convert} → 409 EFFECT_REQUIRES_BUSINESS_API',
    mcpErr(mConv.final) && mcpData(mConv.final)?.error === 'EFFECT_REQUIRES_BUSINESS_API',
    `err=${mcpData(mConv.final)?.error}`)
  const gm = gConv.body?.message || ''
  const mm = mcpData(mConv.final)?.message || ''
  ok('C3 通用入口与 MCP 的**文案逐字相同**', gm && gm === mm, `通用「${gm}」 vs MCP「${mm}」`)
  const prqAfter = db.prepare('SELECT status FROM purchase_requisitions WHERE id=?').get(prq.id).status
  ok('C4 两条路都没有把请购单推成 converted', prqAfter === 'approved', `status=${prqAfter}`)
}

// ============ D. P1-5：/invoices-available-lines 必须按订单行给行 ============
const mkReceivedPo = async (qty) => {
  const c = await api('POST', '/api/purchase/orders', {
    token: adminJwt,
    body: { supplier_id: sup.supplier_id, warehouse_id: wh.id, order_date: '2026-10-16', items: [{ sku_id: sup.sku_id, qty, price: sup.price, tax_rate: 13 }] }
  })
  const id = c.body?.data?.id
  await api('POST', `/api/purchase/orders/${id}/status`, { token: adminJwt, body: { action: 'submit' } })
  const rc = await api('POST', `/api/purchase/orders/${id}/receive`, { token: adminJwt, body: { items: [{ sku_id: sup.sku_id, qty }] } })
  const oi = db.prepare('SELECT id FROM purchase_order_items WHERE order_id=? AND sku_id=?').get(id, sup.sku_id)
  return { orderId: id, receiptId: rc.body?.data?.receipt_id, orderItemId: oi?.id }
}
const mkInv = async (invoiceNo, qty, orderItemId) => {
  const c = await api('POST', '/api/purchase/invoices', {
    token: adminJwt,
    body: { supplier_id: sup.supplier_id, invoice_no: invoiceNo, invoice_date: '2026-10-16', tax_rate: 13, lines: [{ sku_id: sup.sku_id, qty, price: sup.price, order_item_id: orderItemId }] }
  })
  const iid = c.body?.data?.id
  if (iid) { await api('POST', `/api/purchase/invoices/${iid}/submit`, { token: adminJwt }) }
  return iid
}
{
  const a = await mkReceivedPo(10)
  const lines = (await api('GET', `/api/purchase/invoices-available-lines?supplier_id=${sup.supplier_id}`, { token: adminJwt })).body?.data?.list || []
  const mine = lines.find((x) => Number(x.order_id) === a.orderId && Number(x.sku_id) === sup.sku_id)
  ok('D1 /invoices-available-lines 按订单行给行（带 order_id，且挂的是本单的行）',
    !!mine && Number(mine.order_item_id) === Number(a.orderItemId) && Number(mine.open_qty) === 10,
    `line=${JSON.stringify(mine)}`)
  const okInv = await mkInv(`VIUOK${Date.now()}`, 10, a.orderItemId)
  const v1 = await api('POST', `/api/purchase/invoices/${okInv}/verify`, { token: adminJwt })
  // `/invoices/:id/:action` 返回的是流转结果（`to`），不是发票行本身 —— 两种都接受
  const v1to = v1.body?.data?.to ?? v1.body?.data?.status
  ok('D2 同订单开票（10 件）→ 校验通过', v1.status === 200 && v1to === 'verified', `http=${v1.status} to=${v1to}`)

  // 跨订单串用：b 单收 10，却把 20 件挂到 a 单的行上 —— 按供应商汇总时 20 ≤ 20 会放行
  const b = await mkReceivedPo(10)
  const badInv = await mkInv(`VIUBAD${Date.now()}`, 20, a.orderItemId)
  const v2 = await api('POST', `/api/purchase/invoices/${badInv}/verify`, { token: adminJwt })
  ok('D3 跨订单串用入库量开票（20 > 本单已入 10）→ 被拒 PI_MATCH_FAILED',
    v2.status === 409 && (v2.body?.detail?.code || v2.body?.error) === 'PI_MATCH_FAILED',
    `http=${v2.status} code=${v2.body?.detail?.code || v2.body?.error} msg=${String(v2.body?.message || '').slice(0, 90)}`)
  ok('D4 b 单的入库量没有被动过（跨订单串用不影响他人额度）',
    Number(db.prepare('SELECT COALESCE(SUM(received_qty),0) q FROM purchase_order_items WHERE order_id=?').get(b.orderId).q) === 10,
    `b.received=${db.prepare('SELECT COALESCE(SUM(received_qty),0) q FROM purchase_order_items WHERE order_id=?').get(b.orderId).q}`)
}

// ============ E. HTTP 正向：合法角色可推进（P0-2 的"不许误伤"） ============
{
  const c = await api('POST', '/api/purchase/orders', {
    token: adminJwt,
    body: { supplier_id: sup.supplier_id, warehouse_id: wh.id, order_date: '2026-10-16', items: [{ sku_id: sup.sku_id, qty: 1, price: sup.price, tax_rate: 13 }] }
  })
  const purchaseJwt = await login('purchase', '123456')
  const r = await api('POST', `/api/purchase/orders/${c.body?.data?.id}/status`, { token: purchaseJwt, body: { action: 'submit' } })
  ok('E1 HTTP purchase（有 purchase.order.edit）提交 → 200', r.status === 200 && r.body?.data?.status === 'submitted', `http=${r.status}`)
}

const pass = R.filter((x) => x.ok).length
for (const x of R) console.log(`${x.ok ? 'GREEN' : '  red'}  ${x.n}   [${x.d}]`)
console.log(`\n通过 ${pass} / ${R.length}`)

// 回收：**等 exit 事件再下结论**（SIGKILL 刚发出就探活必然报"仍在"，那是假红）
const stopAndReport = () => new Promise((resolve) => {
  const pid = srv.pid
  if (srv.exitCode !== null || srv.signalCode !== null) { console.log(`已回收 pid ${pid}（结束时已退出）`); return resolve() }
  const timer = setTimeout(() => {
    let alive = false
    try { process.kill(pid, 0); alive = true } catch { /* 已退出 */ }
    console.log(alive ? `⚠️ 回收失败，pid ${pid} 仍在（SIGKILL 后 2s 仍存活；请 lsof -p ${pid} 复查）` : `已回收 pid ${pid}（2s 内退出）`)
    resolve()
  }, 2000)
  srv.once('exit', () => { clearTimeout(timer); console.log(`已回收 pid ${pid}`); resolve() })
  try { srv.kill('SIGKILL') } catch { /* ignore */ }
})
process.on('exit', () => { try { srv.kill('SIGKILL') } catch { /* 静默兜底 */ } })
await stopAndReport()
process.exit(pass === R.length ? 0 : 1)
