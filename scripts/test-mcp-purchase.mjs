/**
 * ============================================================================
 * 文件标识：scripts/test-mcp-purchase.mjs ｜ 测试：采购域写型 MCP 工具（批次 K · D5 收口）
 * ============================================================================
 * 【职责】测试：采购域写型 MCP 工具（批次 K · D5 收口）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 采购域写型 MCP 工具（批次 K · D5 收口）
//
// 这一批补的是**能力缺口**：D5 把 `sales.cancel_order` / `approval.approve` /
// `pricing.update_price` 改成"调领域服务"之后，采购那条链（请购 → 订单 → 收货 →
// 发票 → 结算 → 付款）在 MCP 上**一个写型工具都没有**。
// 补齐的同时立四条硬口径，本脚本逐条验：
//
//   ① **工具不复用领域服务就是缺陷** —— 每个写型工具只做「校验入参 / 校验归属 / 交给领域服务」，
//      所以断言方式是"看后果"：建单真的落库、转单真的出 PO、收货真的进库存、付款真的核销。
//   ② **组织归属的判据读与写只有一份** —— 受限令牌既看不到范围外的单，也推不动它；
//      越权按 404 处理（不泄露"它存在但不是你的"）。
//   ③ **"是谁在办"必须答得出来** —— write 级 = 令牌所有者，danger 级 = 人工确认人；
//      无主令牌一律 403 `AGENT_OWNER_REQUIRED`。采购单据要落 created_by/approved_by，
//      空着就等于没有责任人。
//   ④ **简化入口驱动不了"后果在参数上"的动作** —— PRQ.convert / PO.receive 走简化入口
//      会造出「状态对了、账不对」的单，必须 409 `EFFECT_REQUIRES_BUSINESS_API` 并指路。
//
// 另外验一条**入口一致性**：同一个动作在 HTTP 与 MCP 上被拒时，业务码必须相同
// （`PERM_DENIED` + 同一个 `perm_code`）—— 否则"界面点不动、Agent 能动"这扇后门永远关不上。
//
// 运行：node scripts/test-mcp-purchase.mjs [cosmetic|food|apparel]
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { applyTransition } from '../server/lib/docflow.js'
import { createToken } from '../server/mcp/tokens.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'
// 子进程回收的**唯一实现**（`test-guards.mjs:166-205` 的同一形状，抽出来避免各写一版）
import { stopAndReport, installReapFallback } from './lib/reap.mjs'

const ROOT = path.resolve(__dirname, '..')
// ---------- 落点自证：这一跑会读写哪个数据目录 ----------
// 库路径一律从 db/index.js 的 `dbPathFor` 取，不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}
const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` / `getDbFor` 会把**未知行业码静默归一成 cosmetic**
// （`server/db/index.js:28-30`），于是一个字母打错（`fodd`）会安静地跑另一个库，
// 拿到的"绿"是假的。调用侧自己把住"错名要响"。
if (process.argv[2] && !INDUSTRIES[process.argv[2]]) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}
const PORT = 3193
const BASE = `http://127.0.0.1:${PORT}`
const TAG = 'K批MCP采购测试'
const TBATCH = 'KTEST-MCP-BATCH'
const RUN = Date.now()

let pass = 0
let fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failed.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + String(detail).slice(0, 300) : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const ph = (n) => new Array(n).fill('?').join(',')
/**
 * 安全序列化：`JSON.stringify(undefined)` 返回 **undefined**（不是字符串），
 * 后面接 `.slice()` 就直接抛 TypeError —— 断言详情里的一个"顺手写的表达式"
 * 会把整套测试崩掉，而且崩的位置离真正的失败点很远（food 库实测踩到）。
 * 断言详情**永远不能成为新的失败源**。`safeJson` 对 fetch body 也等价可用。
 */
const safeJson = (v) => {
  try {
    return JSON.stringify(v) ?? 'undefined'
  } catch {
    return String(v)
  }
}

// ---------- 起服务 ----------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  // `GML_DATA_DIR` 显式给出：父子同源、不靠 `{...process.env}` 继承 ——
  // 否则"父进程读 /tmp 副本、子进程去 boot 开发库"这种**半隔离**会静悄悄发生
  // （而它一次会把三个行业库全 boot 一遍）。
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))
const started = Date.now()
const ready = await new Promise((res) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) {
      clearInterval(t)
      res(true)
    } else if (Date.now() - started > 180000) {
      clearInterval(t)
      res(false)
    }
  }, 300)
})
if (!ready) {
  console.log('❌ 服务启动失败：\n' + log.split('\n').slice(-30).join('\n'))
  srv.kill('SIGKILL')
  process.exit(1)
}
console.log(`✅ 服务已启动（${INDUSTRY}）`)

// ---------- 库连接 ----------
const DB_PATH = dbPathFor(INDUSTRY)
const db = new Database(DB_PATH)
const one = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)

// ---------- 清理本轮与上一轮的残留（可重复跑）----------
// 判据一律基于**标记**（remark / reason / 批次号），不基于 id —— 上一轮残留的 id 无从得知。
// 顺序：子表 → 父表；库存按标记批次精确删（不碰演示数据的账）。
function purgeTestData() {
  const t = `%${TAG}%`
  const ids = (sql, ...p) => db.prepare(sql).all(...p).map((r) => r.id)
  const orders = ids('SELECT id FROM purchase_orders WHERE remark LIKE ?', t)
  const reqs = ids('SELECT id FROM purchase_requisitions WHERE remark LIKE ?', t)
  const invs = ids('SELECT id FROM purchase_invoices WHERE remark LIKE ?', t)
  const sts = ids('SELECT id FROM purchase_settlements WHERE remark LIKE ?', t)
  const pays = ids('SELECT id FROM purchase_payments WHERE remark LIKE ?', t)
  const rets = ids('SELECT id FROM purchase_returns WHERE reason LIKE ?', t)
  const receipts = ids(
    `SELECT id FROM purchase_receipts WHERE remark LIKE ? ${orders.length ? `OR order_id IN (${ph(orders.length)})` : ''}`,
    t,
    ...orders
  )
  const counts = { orders: orders.length, reqs: reqs.length, receipts: receipts.length, txns: 0, stocks: 0 }
  db.transaction(() => {
    // 库存回滚：只删标记批次，不碰演示账
    counts.txns = db.prepare('DELETE FROM inventory_transactions WHERE batch_no=?').run(TBATCH).changes
    db.prepare('DELETE FROM stock_cost_ledger WHERE batch_no=?').run(TBATCH)
    counts.stocks = db.prepare('DELETE FROM inventory_stocks WHERE batch_no=?').run(TBATCH).changes
    db.prepare('DELETE FROM inventory_batches WHERE batch_no=?').run(TBATCH)

    if (pays.length) {
      db.prepare(`DELETE FROM purchase_payment_items WHERE payment_id IN (${ph(pays.length)})`).run(...pays)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PAY' AND doc_id IN (${ph(pays.length)})`).run(...pays)
      db.prepare(`DELETE FROM purchase_payments WHERE id IN (${ph(pays.length)})`).run(...pays)
    }
    if (sts.length) {
      db.prepare(`DELETE FROM purchase_settlement_items WHERE settle_id IN (${ph(sts.length)})`).run(...sts)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PST' AND doc_id IN (${ph(sts.length)})`).run(...sts)
      db.prepare(`DELETE FROM purchase_settlements WHERE id IN (${ph(sts.length)})`).run(...sts)
    }
    if (invs.length) {
      db.prepare(`DELETE FROM purchase_invoice_items WHERE invoice_id IN (${ph(invs.length)})`).run(...invs)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PI' AND doc_id IN (${ph(invs.length)})`).run(...invs)
      db.prepare(`DELETE FROM purchase_invoices WHERE id IN (${ph(invs.length)})`).run(...invs)
    }
    if (rets.length) {
      db.prepare(`DELETE FROM purchase_return_items WHERE return_id IN (${ph(rets.length)})`).run(...rets)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PRT' AND doc_id IN (${ph(rets.length)})`).run(...rets)
      db.prepare(`DELETE FROM purchase_returns WHERE id IN (${ph(rets.length)})`).run(...rets)
    }
    if (receipts.length) {
      db.prepare(`DELETE FROM purchase_receipt_items WHERE receipt_id IN (${ph(receipts.length)})`).run(...receipts)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='GR' AND doc_id IN (${ph(receipts.length)})`).run(...receipts)
      db.prepare(`DELETE FROM purchase_receipts WHERE id IN (${ph(receipts.length)})`).run(...receipts)
    }
    if (orders.length) {
      db.prepare(`DELETE FROM purchase_order_items WHERE order_id IN (${ph(orders.length)})`).run(...orders)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PO' AND doc_id IN (${ph(orders.length)})`).run(...orders)
      db.prepare(`DELETE FROM purchase_orders WHERE id IN (${ph(orders.length)})`).run(...orders)
    }
    if (reqs.length) {
      db.prepare(`DELETE FROM purchase_requisition_items WHERE req_id IN (${ph(reqs.length)})`).run(...reqs)
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PRQ' AND doc_id IN (${ph(reqs.length)})`).run(...reqs)
      db.prepare(`DELETE FROM purchase_requisitions WHERE id IN (${ph(reqs.length)})`).run(...reqs)
    }
    // 幂等缓存：本轮的键一次性，但上一轮遗留的键会占位，一并清掉自己造的
    db.prepare("DELETE FROM mcp_idempotency WHERE idempotency_key LIKE 'k-%'").run()
  })()
  return counts
}
const cleaned0 = purgeTestData()
console.log(
  `  （已清理上一轮残留：采购单 ${cleaned0.orders} / 请购 ${cleaned0.reqs} / 收货 ${cleaned0.receipts} / 库存行 ${cleaned0.stocks} / 流水 ${cleaned0.txns}）`
)

// ---------- HTTP / MCP 封装 ----------
let seq = 0
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-industry': INDUSTRY, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : safeJson(body)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}
async function mcp(name, args, token) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // ⚠️ 必须带 `x-industry`：MCP 端点不登录，**行业由这个头决定"去哪个库查令牌"**
      // （`server/index.js` 的中间件 → `runWithIndustry`）。漏了它的症状是
      // 「Agent Token 无效」而不是「行业不匹配」—— 因为令牌是**分库**存的，
      // 在 cosmetic 库里查 food 的令牌就是查不到（token 表本来三库各一份）。
      'x-industry': INDUSTRY,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: safeJson({ jsonrpc: '2.0', id: ++seq, method: 'tools/call', params: { name, arguments: args } })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const mcpErr = (r) => !!r.body?.error || r.body?.result?.isError === true
const mcpData = (r) => {
  const t = r.body?.result?.content?.[0]?.text ?? r.body?.error?.message
  if (t === undefined) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}
const loginAs = async (u, p) => (await api('POST', '/api/auth/login', { body: { username: u, password: p, industry: INDUSTRY } })).body?.data?.token || null

const adminJwt = await loginAs('admin', '12345')
const purchaseJwt = await loginAs('purchase', '123456')
const salesJwt = await loginAs('sales', '123456')
const financeJwt = await loginAs('finance', '123456')
ok('角色账号登录成功（admin / purchase / sales / finance）', !!(adminJwt && purchaseJwt && salesJwt && financeJwt))

/**
 * 令牌签发有**两种**，这里必须都用上 —— 差别本身就是一条口径：
 *   · 走 `POST /api/mcp/tokens`：`orgId: org_id ?? req.user.org_id` ⇒ **被绑到签发人的组织**
 *     （admin 属总部 `/1/`，于是可见范围是总部子树的 36 个组织）；
 *   · 直接 `createToken({ orgId: null })`：**真正全局**（`buildContext` 给 `scope:'all'`）。
 *
 * 本批踩到的坑正在这里：我一开始以为 API 签出来的就是全局令牌，
 * 配上"供应商组织必须在范围内"的归属判据 ⇒ 建单全部 403。
 * **供应商主体的组织是总部子树的兄弟**（`/37/` vs `/1/…`），
 * 拿它判"这单归不归我管"对所有内部令牌恒为假（正向误伤，判据已废）。
 */
async function issueToken(name, { scopes = 'read,write', org_id } = {}) {
  const r = await api('POST', '/api/mcp/tokens', { token: adminJwt, body: { name, scopes, ...(org_id ? { org_id } : {}) } })
  if (!r.body?.data?.token) throw new Error('签发失败: ' + safeJson(r.body))
  return r.body.data.token
}
/** 真正全局的令牌（不绑组织）—— 直接建，绕开 API 的"绑签发人组织"行为。
 *  `ownerUserId` 必须给：写型采购工具要能答出"是谁在办"（无主令牌 403 AGENT_OWNER_REQUIRED）。 */
const uidOf = (name) => db.prepare('SELECT id FROM users WHERE username=?').get(name)?.id ?? null
const OWNER_UID = uidOf('admin')
const globalToken = (name, scopes = 'read,write,danger') =>
  createToken(db, { name: `${name}${RUN}`, industry: INDUSTRY, ownerUserId: OWNER_UID, scopes, remark: '测试用全局令牌（不绑组织）' }).token

const tkWrite = globalToken('K批·事务', 'read,write')
const tkDanger = globalToken('K批·全权', 'read,write,danger')
const tkDanger2 = globalToken('K批·全权2', 'read,write,danger')
const tkRead = globalToken('K批·只读', 'read')
// 无主令牌：直接建（不走 API —— API 一律写 owner_user_id）。用来反证"无主令牌办不了采购单"
const ownerless = createToken(db, { name: `K批·无主${RUN}`, industry: INDUSTRY, scopes: 'read,write,danger', remark: '测试用无主令牌' })

/** 走人工二次确认执行一个 danger 工具；返回最终执行结果 */
async function confirmedCall(name, args, token, approverJwt) {
  const first = await mcp(name, args, token)
  const cfm = mcpData(first)?.confirm_token
  if (!cfm) return { first, approved: false, final: first, conf: null }
  const appr = await api('POST', `/mcp/confirmations/${cfm}/approve`, { token: approverJwt })
  if (appr.body?.data?.status !== 'confirmed') return { first, approved: false, final: null, conf: cfm, appr }
  const final = await mcp(name, { ...args, confirm_token: cfm }, token)
  return { first, approved: true, final, conf: cfm }
}

// ---------- 取样 ----------
const wh = one("SELECT id, org_id, name FROM warehouses WHERE status='active' ORDER BY id LIMIT 1")
const supplier = one("SELECT id, org_id, name FROM suppliers WHERE status='active' ORDER BY id LIMIT 1")
const sku = one("SELECT id, sku_code FROM product_skus WHERE price_retail > 0 ORDER BY id LIMIT 1")
const tmp = {
  po: one("SELECT id FROM purchase_orders ORDER BY id LIMIT 1"),
  prqTables: !!one("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_requisitions'")
}
const uidStore = one("SELECT id FROM users WHERE role='store' ORDER BY id LIMIT 1")?.id
console.log(`取样：仓#${wh.id}(org ${wh.org_id}) 供应商#${supplier.id} SKU#${sku.id} 首个采购单#${tmp.po?.id}`)

// ============================================================
section('K1 工具清单：采购域写型工具必须存在且级别正确')
{
  const listAs = async (token) => {
    const res = await fetch(`${BASE}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-industry': INDUSTRY, Authorization: `Bearer ${token}` },
      body: safeJson({ jsonrpc: '2.0', id: ++seq, method: 'tools/list', params: {} })
    })
    return (await res.json())?.result?.tools || []
  }
  const tools = await listAs(tkDanger)
  const byName = new Map(tools.map((t) => [t.name, t]))
  const WRITE = ['purchase.create_requisition', 'purchase.create_order', 'purchase.create_invoice', 'purchase.build_settlement', 'purchase.create_payment', 'purchase.create_return']
  const DANGER = ['purchase.advance_requisition', 'purchase.convert_requisition', 'purchase.advance_order', 'purchase.receive_order', 'purchase.advance_invoice', 'purchase.advance_settlement', 'purchase.advance_payment']
  ok(`全权令牌可见 ${tools.length} 个工具`, tools.length >= 35, `实际 ${tools.length}`)
  ok('6 个采购 write 工具全部在册', WRITE.every((n) => byName.has(n)), WRITE.filter((n) => !byName.has(n)).join(','))
  ok('7 个采购 danger 工具全部在册', DANGER.every((n) => byName.has(n)), DANGER.filter((n) => !byName.has(n)).join(','))
  ok('write 工具标注为 write 级', WRITE.every((n) => byName.get(n)?.annotations?.level === 'write'))
  ok('danger 工具标注为 danger 级（推进/动货/动钱一律人工确认）', DANGER.every((n) => byName.get(n)?.annotations?.level === 'danger'))
  const readNames = (await listAs(tkRead)).map((t) => t.name)
  ok(
    '只读令牌看不到任何采购写型工具',
    !readNames.some((n) => n.startsWith('purchase.') && n !== 'purchase.list_orders'),
    readNames.filter((n) => n.startsWith('purchase.')).join(',')
  )
}

// ============================================================
section('K2 建采购订单（write）：复用领域服务，负价/未知参数一律拦')
const PO = { remark: `${TAG}·建单${RUN}` }
let orderId = null
let orderNo = null
{
  const before = one('SELECT COUNT(*) c FROM purchase_orders').c
  const r = await mcp('purchase.create_order', {
    supplier_id: supplier.id,
    warehouse_id: wh.id,
    fulfill_type: 'hq',
    remark: PO.remark,
    items: [{ sku_id: sku.id, qty: 3, price: 12.5, tax_rate: 13 }],
    idempotency_key: `k-co-${RUN}`
  }, tkWrite)
  ok('建采购订单成功', !mcpErr(r), safeJson(r.body).slice(0, 220))
  const d = mcpData(r)
  orderId = d?.id
  orderNo = d?.doc_no
  ok('返回单号与草稿状态', !!d?.doc_no && d?.status === 'draft', safeJson(d))
  ok('金额由领域服务算出（3 × 12.5 = 37.5）', Number(d?.total_amount) === 37.5, String(d?.total_amount))
  ok('确实落库了（采购单数 +1）', one('SELECT COUNT(*) c FROM purchase_orders').c === before + 1)
  ok('组织过滤后草稿单可被自己看到', !!one('SELECT id FROM purchase_orders WHERE id=?', orderId))

  // 负价：与 HTTP 建单**同一个**校验器
  const neg = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, remark: PO.remark,
    items: [{ sku_id: sku.id, qty: 3, price: -5 }], idempotency_key: `k-neg-${RUN}`
  }, tkWrite)
  ok('负价被拒（PO_LINE_BAD_PRICE）', mcpErr(neg) && mcpData(neg)?.error === 'PO_LINE_BAD_PRICE', safeJson(mcpData(neg)).slice(0, 180))
  ok('被拒的负价单没有落库', one("SELECT COUNT(*) c FROM purchase_orders WHERE total_amount < 0").c === 0)

  // 缺行
  const empty = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, items: [], idempotency_key: `k-empty-${RUN}`
  }, tkWrite)
  ok('空明细被拒', mcpErr(empty), safeJson(mcpData(empty)).slice(0, 160))

  // 未知参数（validate.js 的"未知字段"闸门对采购工具同样生效）
  const unknown = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, items: [{ sku_id: sku.id, qty: 1, price: 1 }],
    nope: 1, idempotency_key: `k-unknown-${RUN}`
  }, tkWrite)
  ok('未知参数被拒（ARG_UNKNOWN）', mcpErr(unknown) && mcpData(unknown)?.error === 'ARG_UNKNOWN', safeJson(mcpData(unknown)).slice(0, 160))
}

// ============================================================
section('K3 组织归属：读与写只有一份判据，越权按"不存在"处理')
{
  const scopeOrgIds = all("SELECT id FROM orgs WHERE id=? OR path LIKE (SELECT path FROM orgs WHERE id=?) || '%'", wh.org_id, wh.org_id).map((r) => r.id)
  const scopedWhIds = all(`SELECT id FROM warehouses WHERE org_id IN (${ph(scopeOrgIds.length)})`, ...scopeOrgIds).map((r) => r.id)
  const outWh = one(
    `SELECT id, org_id FROM warehouses WHERE org_id IS NOT NULL AND id NOT IN (${scopedWhIds.length ? ph(scopedWhIds.length) : 'NULL'}) ORDER BY id LIMIT 1`,
    ...scopedWhIds
  )
  const tokOrg = await issueToken(`K批·组织边界${RUN}`, { scopes: 'read,write,danger', org_id: wh.org_id })
  ok('受限令牌签发成功（绑到仓库所属组织）', !!tokOrg)
  ok('存在范围外的仓库样本（越权用例前提）', !!outWh, safeJson(outWh))

  if (outWh) {
    const bad = await mcp('purchase.create_order', {
      supplier_id: supplier.id, warehouse_id: outWh.id, remark: `${TAG}·越权建单`,
      items: [{ sku_id: sku.id, qty: 1, price: 1 }], idempotency_key: `k-out-${RUN}`
    }, tokOrg)
    ok(
      '往范围外仓库建采购单 → 403 ORG_OUT_OF_SCOPE',
      mcpErr(bad) && mcpData(bad)?.error === 'ORG_OUT_OF_SCOPE',
      safeJson(mcpData(bad)).slice(0, 200)
    )
    ok('越权建单没有落库', one("SELECT COUNT(*) c FROM purchase_orders WHERE remark LIKE ?", `%越权建单%`).c === 0)
  }

  // 范围外的**已有单据**：推进它 → 404（不确认"它存在但不是你的"）
  // 样本要**自己造**：库里现成的草稿单可能全在范围内的仓库上（"挑第一个"就会挑到不可用的样本）。
  // 用全局令牌往范围外的仓库建一张草稿单 —— 它一定落在受限令牌的可见范围之外。
  let outPo = null
  if (outWh) {
    const made = await mcp('purchase.create_order', {
      supplier_id: supplier.id,
      warehouse_id: outWh.id,
      remark: `${TAG}·范围外样本${RUN}`,
      items: [{ sku_id: sku.id, qty: 1, price: 1 }],
      idempotency_key: `k-outsample-${RUN}`
    }, tkWrite)
    outPo = mcpData(made)?.id ? { id: mcpData(made).id } : null
  }
  ok('造出范围外的草稿采购单样本', !!outPo, safeJson(outWh))
  if (outPo) {
    const adv = await confirmedCall('purchase.advance_order', { order_id: outPo.id, action: 'submit', remark: `${TAG}·越权推进` }, tokOrg, purchaseJwt)
    ok(
      '推进范围外的采购单 → 404 DOC_NOT_FOUND（不是 403：不泄露存在性）',
      mcpErr(adv.final) && mcpData(adv.final)?.error === 'DOC_NOT_FOUND',
      safeJson(mcpData(adv.final)).slice(0, 200)
    )
    ok('被拒后那张单状态未变', one('SELECT status FROM purchase_orders WHERE id=?', outPo.id)?.status === 'draft')
  }
}

// ============================================================
section('K4 "是谁在办"必须答得出来：无主令牌办不了采购单')
{
  const r = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, remark: `${TAG}·无主`,
    items: [{ sku_id: sku.id, qty: 1, price: 1 }], idempotency_key: `k-ownerless-${RUN}`
  }, ownerless.token)
  ok(
    '无主令牌建采购单 → 403 AGENT_OWNER_REQUIRED',
    mcpErr(r) && mcpData(r)?.error === 'AGENT_OWNER_REQUIRED',
    safeJson(mcpData(r)).slice(0, 200)
  )
  ok('无主令牌没有造出单据', one('SELECT COUNT(*) c FROM purchase_orders WHERE remark LIKE ?', `%·无主%`).c === 0)
  // 有主令牌的建单人必须落库
  const by = one('SELECT created_by FROM purchase_orders WHERE id=?', orderId)?.created_by
  ok('建单落了 created_by（令牌所有者）', by != null, `created_by=${by}`)
}

// ============================================================
section('K5 请购单：建单 → 提交 → 转单（简化入口驱动不了 convert）')
let prqId = null
let prqNo = null
{
  const r = await mcp('purchase.create_requisition', {
    supplier_id: supplier.id,
    warehouse_id: wh.id,
    purpose: `${TAG}·请购`,
    remark: `${TAG}·请购${RUN}`,
    lines: [{ sku_id: sku.id, qty: 4 }],
    idempotency_key: `k-prq-${RUN}`
  }, tkWrite)
  ok('建请购单成功', !mcpErr(r), safeJson(r.body).slice(0, 220))
  const d = mcpData(r)
  prqId = d?.id
  prqNo = d?.doc_no
  ok('请购单是草稿态', d?.status === 'draft', String(d?.status))
  ok('未给价的行走了取价链并回报来源', typeof d?.price_trace?.[0]?.source === 'string' && d.price_trace[0].source.length > 0, safeJson(d?.price_trace))

  // 提交（danger + 人工确认）
  const sub = await confirmedCall('purchase.advance_requisition', { requisition_id: prqId, action: 'submit' }, tkDanger, purchaseJwt)
  ok('人工确认后提交成功', !mcpErr(sub.final), safeJson(mcpData(sub.final)).slice(0, 200))
  ok('请购单状态 → submitted', one('SELECT status FROM purchase_requisitions WHERE id=?', prqId)?.status === 'submitted')
  ok('流转留痕写了 submit', one("SELECT COUNT(*) c FROM doc_events WHERE doc_type='PRQ' AND doc_id=? AND action='submit'", prqId).c >= 1)

  // 审批通过（无审批模板 → 直接放行）
  const apr = await confirmedCall('purchase.advance_requisition', { requisition_id: prqId, action: 'approve' }, tkDanger, purchaseJwt)
  ok('审批通过成功', !mcpErr(apr.final), safeJson(mcpData(apr.final)).slice(0, 200))
  ok('请购单状态 → approved', one('SELECT status FROM purchase_requisitions WHERE id=?', prqId)?.status === 'approved')
  ok('审批人落库（= 确认人，不是令牌）', one('SELECT approved_by FROM purchase_requisitions WHERE id=?', prqId)?.approved_by != null)

  // ★ 简化入口驱动 convert：必须 409 并指路
  const poBefore = one('SELECT COUNT(*) c FROM purchase_orders').c
  const cv = await confirmedCall('purchase.advance_requisition', { requisition_id: prqId, action: 'convert' }, tkDanger, purchaseJwt)
  ok(
    '简化入口 convert → 409 EFFECT_REQUIRES_BUSINESS_API（指路 convert_requisition）',
    mcpErr(cv.final) && mcpData(cv.final)?.error === 'EFFECT_REQUIRES_BUSINESS_API',
    safeJson(mcpData(cv.final)).slice(0, 240)
  )
  ok('被拒后请购单没有变成已转单', one('SELECT status FROM purchase_requisitions WHERE id=?', prqId)?.status === 'approved')
  ok('被拒后没有凭空多出采购订单', one('SELECT COUNT(*) c FROM purchase_orders').c === poBefore)

  // ★ 同一条口径也要盖住 **HTTP 通用流转入口**（§23.3 的实测残留）
  const g = await api('POST', '/api/docflow/transition', { token: adminJwt, body: { doc_type: 'PRQ', id: prqId, action: 'convert' } })
  const gcode = g.body?.detail?.code || g.body?.error
  ok('通用流转入口 convert 同样 409 效果归属（原来 200 且只改状态）', g.status === 409 && gcode === 'EFFECT_REQUIRES_BUSINESS_API', `${g.status}/${gcode}`)
  ok('通用入口被拒后请购单状态仍是 approved', one('SELECT status FROM purchase_requisitions WHERE id=?', prqId)?.status === 'approved')
}

// ============================================================
section('K6 转单工具：真的生成采购订单（不是只改状态）')
let convPoId = null
{
  const poBefore = one('SELECT COUNT(*) c FROM purchase_orders').c
  const r = await confirmedCall('purchase.convert_requisition', { requisition_id: prqId, remark: `${TAG}·转单${RUN}` }, tkDanger, purchaseJwt)
  ok('转单成功', !mcpErr(r.final), safeJson(mcpData(r.final)).slice(0, 220))
  const d = mcpData(r.final)
  convPoId = d?.order_id
  ok('返回了新的采购订单号', !!d?.order_no, safeJson(d))
  ok('采购订单数 +1', one('SELECT COUNT(*) c FROM purchase_orders').c === poBefore + 1)
  ok('请购单状态 → converted', one('SELECT status FROM purchase_requisitions WHERE id=?', prqId)?.status === 'converted')
  const poRow = one('SELECT id, status, supplier_id, warehouse_id FROM purchase_orders WHERE id=?', convPoId)
  ok('生成的采购订单真的存在且是草稿', !!poRow && poRow.status === 'draft', safeJson(poRow))
  ok('转出的行数量被记住（converted_qty > 0）', one('SELECT COALESCE(SUM(converted_qty),0) q FROM purchase_requisition_items WHERE req_id=?', prqId).q > 0)
}

// ============================================================
section('K7 收货：真的写库存与成本；简化入口驱动不了 receive')
{
  // 先让订单走到 submitted（PO.submit 无审批模板）
  const sub = await confirmedCall('purchase.advance_order', { order_id: convPoId, action: 'submit' }, tkDanger, purchaseJwt)
  ok('采购订单提交成功', !mcpErr(sub.final), safeJson(mcpData(sub.final)).slice(0, 200))
  ok('采购订单状态 → submitted', one('SELECT status FROM purchase_orders WHERE id=?', convPoId)?.status === 'submitted')

  // ★ 简化入口 receive 必须被拦
  const badRecv = await confirmedCall('purchase.advance_order', { order_id: convPoId, action: 'receive', remark: `${TAG}·简化收货` }, tkDanger, purchaseJwt)
  ok(
    '简化入口 receive → 409 EFFECT_REQUIRES_BUSINESS_API（指路 receive_order）',
    mcpErr(badRecv.final) && mcpData(badRecv.final)?.error === 'EFFECT_REQUIRES_BUSINESS_API',
    safeJson(mcpData(badRecv.final)).slice(0, 220)
  )
  ok('被拒后订单没有变成已收货', one('SELECT status FROM purchase_orders WHERE id=?', convPoId)?.status === 'submitted')

  // 真正收货
  const items = one('SELECT sku_id, qty - received_qty AS open, price FROM purchase_order_items WHERE order_id=? AND qty - received_qty > 0 ORDER BY id', convPoId)
  ok('存在可收的订单行样本', !!items, safeJson(items))
  if (!items) {
    ok('收货用例可继续（需订单行样本）', false, '无样本，跳过收货断言')
  } else {
  const open = Number(items.open)
  // 分两次收：先收一半（订单应停在"部分收货"），再收满（订单应到"已收货"）。
  // 一次收满只能验到 happy path；而 `pend <= 0.0001 ? 'receive' : 'partial'` 这个分支
  // 是"收货推进订单状态"里唯一会分叉的地方 —— 不测它就等于没测这条口径。
  const q1 = open >= 0.02 ? Math.round((open / 2) * 10000) / 10000 : open
  for (const [idx, qty] of [[1, q1], [2, Math.round((open - q1) * 10000) / 10000]].filter(([, q]) => q > 0)) {
    const stockBefore = one("SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE batch_no=?", TBATCH).q
    const recv = await confirmedCall('purchase.receive_order', {
      order_id: convPoId,
      items: [{ sku_id: items.sku_id, qty, price: Number(items.price), batch_no: TBATCH }],
      inspector: `${TAG}·检验`,
      remark: `${TAG}·收货${idx}${RUN}`
    }, tkDanger, purchaseJwt)
    ok(`第 ${idx} 次收货成功（${qty} 件）`, !mcpErr(recv.final), safeJson(mcpData(recv.final)).slice(0, 240))
    const rd = mcpData(recv.final)
    ok(`第 ${idx} 次返回了收货单 id`, !!rd?.receipt_id, safeJson(rd))
    const stockAfter = one("SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE batch_no=?", TBATCH).q
    ok(`第 ${idx} 次库存真的增加（+${qty}）`, Math.abs(stockAfter - stockBefore - qty) < 1e-6, `${stockBefore} → ${stockAfter}`)
    if (idx === 1 && open - q1 > 0) {
      ok('收一半时订单停在 submitted（仍有欠交）', one('SELECT status FROM purchase_orders WHERE id=?', convPoId)?.status === 'submitted')
    }
  }
  ok('写了库存流水', one("SELECT COUNT(*) c FROM inventory_transactions WHERE batch_no=? AND doc_type='PUR_IN'", TBATCH).c >= 1)
  ok('写了成本流水', one('SELECT COUNT(*) c FROM stock_cost_ledger WHERE batch_no=?', TBATCH).c >= 1)
  ok('批次主档落库（批次能追到供应商）', one('SELECT supplier_id FROM inventory_batches WHERE batch_no=?', TBATCH)?.supplier_id != null)
  ok('收满后订单状态 → received', one('SELECT status FROM purchase_orders WHERE id=?', convPoId)?.status === 'received')
  ok('订单行 received_qty 被回写', one('SELECT received_qty FROM purchase_order_items WHERE order_id=? ORDER BY id LIMIT 1', convPoId).received_qty > 0)
  ok('收货单走内核留痕', one("SELECT COUNT(*) c FROM doc_events WHERE doc_type='GR' AND action='confirm'").c >= 1)
  }
}

// ============================================================
section('K8 入口一致性：HTTP 与 MCP 的拒绝理由必须同码')
{
  // 同一动作、同一"没有权限的人"：
  //   HTTP 走 `POST /api/purchase/requisitions/:id/submit`（assertActionPermitted）
  //   MCP  走 `purchase.advance_requisition`（assertEdgePermitted + 确认人权限）
  // sales 有 system.mcp.confirm（能批确认单）但没有 purchase 域权限 —— 正好用来验这道闸。
  const fresh = await mcp('purchase.create_requisition', {
    warehouse_id: wh.id, purpose: `${TAG}·权限闸`, remark: `${TAG}·权限闸${RUN}`,
    lines: [{ sku_id: sku.id, qty: 1 }], idempotency_key: `k-perm-${RUN}`
  }, tkWrite)
  const pid = mcpData(fresh)?.id
  ok('造出待提交请购单样本', !!pid)

  const httpDeny = await api('POST', `/api/purchase/requisitions/${pid}/submit`, { token: salesJwt, body: {} })
  ok('HTTP：sales 提交请购单 → 403 PERM_DENIED', httpDeny.status === 403 && httpDeny.body?.detail?.code === 'PERM_DENIED', `${httpDeny.status}/${safeJson(httpDeny.body?.detail || httpDeny.body?.message).slice(0, 140)}`)

  // MCP：确认人 = sales（有 mcp.confirm、无 purchase.req.edit）
  const mcpDeny = await confirmedCall('purchase.advance_requisition', { requisition_id: pid, action: 'submit' }, tkDanger2, salesJwt)
  ok(
    'MCP：确认人（sales）无该动作权限 → 403 PERM_DENIED',
    mcpErr(mcpDeny.final) && mcpData(mcpDeny.final)?.error === 'PERM_DENIED',
    safeJson(mcpData(mcpDeny.final)).slice(0, 220)
  )
  ok('MCP 拒绝时给出了同一个权限码', mcpData(mcpDeny.final)?.detail?.permCode === 'purchase.req.edit', safeJson(mcpData(mcpDeny.final)?.detail))
  ok('两个入口都拒绝后请购单仍是 draft', one('SELECT status FROM purchase_requisitions WHERE id=?', pid)?.status === 'draft')

  // 对照：换 purchase 用户确认 → 成功（证明前一条不是"谁都过不去"）
  const mcpAllow = await confirmedCall('purchase.advance_requisition', { requisition_id: pid, action: 'submit' }, tkDanger2, purchaseJwt)
  ok('对照：换成有权限的确认人 → 成功', !mcpErr(mcpAllow.final), safeJson(mcpData(mcpAllow.final)).slice(0, 200))
  ok('对照用例确实推进了状态', one('SELECT status FROM purchase_requisitions WHERE id=?', pid)?.status === 'submitted')
}

// ============================================================
section('K9 发票 → 结算 → 付款核销：动钱的链条也要复用领域服务')
{
  // 找一条**真的还能开票**的**订单行**：可开数量 = 该订单该 SKU 的已入库 − 已开票。
  //
  // ⚠️ 口径必须与闸门（`lib/purchase.js` 的 `matchInvoiceToReceipts`）**同源**：
  // 闸门的 `recv` / `otherInvoiced` 都**按 `order_item_id` 反查 `order_id` 收窄**（P1-5 的修法），
  // 所以夹具也必须**按订单行**算。按「供应商 × SKU」汇总挑样本，会挑到
  // "该供应商该商品整体还有额度、但**这张订单**已经开满"的行 —— 然后正当卡在三单匹配上
  // （apparel 库实测：`本票 1，已开 407，本订单 12 已入库 407`，闸门判对了、夹具挑错了）。
  // **改这里时两处一起改**：判据是"挑一条业务上真的能开票的**订单行**"，
  // 不是"挑一个供应商 × SKU 组合"。
  const cands = all(`
    SELECT oi.id AS order_item_id, oi.order_id, o.supplier_id, oi.sku_id,
           oi.price AS price,
           COALESCE((SELECT SUM(ri.qty) FROM purchase_receipt_items ri
                       JOIN purchase_receipts rc ON rc.id=ri.receipt_id
                      WHERE rc.order_id=oi.order_id AND rc.status <> 'draft'
                        AND ri.sku_id=oi.sku_id),0) AS recv_qty,
           COALESCE((SELECT SUM(ii.qty) FROM purchase_invoice_items ii
                       JOIN purchase_invoices i ON i.id=ii.invoice_id
                       JOIN purchase_order_items oi2 ON oi2.id=ii.order_item_id
                      WHERE oi2.order_id=oi.order_id AND ii.sku_id=oi.sku_id
                        AND i.status NOT IN ('voided','draft')),0) AS invoiced_qty
      FROM purchase_order_items oi
      JOIN purchase_orders o ON o.id=oi.order_id
     WHERE o.status <> 'cancelled'`)
  const openOf = (c) => Number(c.recv_qty) - Number(c.invoiced_qty)
  // 取可开额度最大的那一条（额度 ≥ 1 才够开 1 件；不足 1 也允许，qty 会跟着收窄）
  const pick = cands.filter((c) => openOf(c) > 0.01).sort((a, b) => openOf(b) - openOf(a))[0] || null
  const recvLine = pick
    ? {
        supplier_id: pick.supplier_id, sku_id: pick.sku_id, price: pick.price,
        order_item_id: pick.order_item_id, order_id: pick.order_id, open: openOf(pick)
      }
    : null
  ok(
    '存在"已收货且未开满票"的**订单行**样本（与闸门同口径）',
    !!recvLine,
    recvLine
      ? `订单#${recvLine.order_id} 行#${recvLine.order_item_id} 供应商#${recvLine.supplier_id} SKU#${recvLine.sku_id} 可开 ${recvLine.open}`
      : `候选订单行 ${cands.length} 条，无可开`
  )
  if (recvLine) {
    const inv = await mcp('purchase.create_invoice', {
      supplier_id: recvLine.supplier_id,
      invoice_type: 'vat_special',
      remark: `${TAG}·发票${RUN}`,
      // 数量取 1 或该行的可开额度（取小者）。**必须 round 到 4 位**：
      // 可开额度是"已入库 − 已开票"的差，可能是 0.3333… 这类无限小数，
      // 而 `numQty` 要求最多 4 位小数 —— 不 round 会以一个与业务无关的校验错失败。
      lines: [{ sku_id: recvLine.sku_id, order_item_id: recvLine.order_item_id, qty: Math.round(Math.min(recvLine.open, 1) * 10000) / 10000, price: Number(recvLine.price) }],
      idempotency_key: `k-pi-${RUN}`
    }, tkWrite)
    ok('录发票成功', !mcpErr(inv), safeJson(inv.body).slice(0, 200))
    const invId = mcpData(inv)?.id
    const v1 = await confirmedCall('purchase.advance_invoice', { invoice_id: invId, action: 'submit' }, tkDanger, purchaseJwt)
    ok('发票提交成功', !mcpErr(v1.final), safeJson(mcpData(v1.final)).slice(0, 200))
    const v2 = await confirmedCall('purchase.advance_invoice', { invoice_id: invId, action: 'verify' }, tkDanger, purchaseJwt)
    ok('发票校验通过（三单匹配）', !mcpErr(v2.final), safeJson(mcpData(v2.final)).slice(0, 200))
    ok('发票状态 → verified', one('SELECT status FROM purchase_invoices WHERE id=?', invId)?.status === 'verified')
    ok('发票校验人落库', one('SELECT verify_by FROM purchase_invoices WHERE id=?', invId)?.verify_by != null)

    // 负向：**跨订单串用入库量**（P1-5 的原始复现）。
    //
    // 做法：把数量挂在本行（订单 A）上，但这个数量**超过 A 自己的额度、却仍在
    // "该供应商该 SKU 的全部入库量"之内** —— 按 (供应商,SKU) 汇总的老口径会**放行**，
    // 按订单行口径必然拒绝。**这才是 P1-5 要守的那一件事**，比"同订单再开一张"更强：
    // 后者对"退回供应商级汇总"这个注入**不敏感**（实测：把闸门的 orderId 置 null 后它仍然通过），
    // 因为那种注入下"供应商总额"也恰好只比订单 A 多一点。
    //
    // 数量 = 本行**原**可开额度（`recvLine.open`）：上面的正向票已吃掉 1 件 ⇒ A 的当前额度是
    // `open − 1` ⇒ 开 `open` 必然超 1 件；而 A 之外只要还有别的订单为这个 SKU 入过 ≥1 件，
    // 供应商总额就还容得下它。下面用两条断言把"夹具确实是跨订单串用"钉住。
    const otherOrder = one(
      `SELECT oi.order_id AS oid, COALESCE((SELECT SUM(ri.qty) FROM purchase_receipt_items ri
                                              JOIN purchase_receipts rc ON rc.id=ri.receipt_id
                                             WHERE rc.order_id=oi.order_id AND ri.sku_id=oi.sku_id),0) AS recv_b
         FROM purchase_order_items oi JOIN purchase_orders o ON o.id=oi.order_id
        WHERE o.supplier_id=? AND oi.sku_id=? AND oi.order_id<>? AND o.status<>'cancelled'
        ORDER BY recv_b DESC LIMIT 1`,
      recvLine.supplier_id, recvLine.sku_id, recvLine.order_id
    )
    const suppRoom = Number(
      one(
        `SELECT COALESCE((SELECT SUM(ri.qty) FROM purchase_receipt_items ri
                            JOIN purchase_receipts rc ON rc.id=ri.receipt_id
                           WHERE rc.supplier_id=? AND ri.sku_id=? AND rc.status<>'draft'),0)
              - COALESCE((SELECT SUM(ii.qty) FROM purchase_invoice_items ii
                            JOIN purchase_invoices i ON i.id=ii.invoice_id
                           WHERE i.supplier_id=? AND ii.sku_id=? AND i.status NOT IN ('voided','draft')),0) AS room`,
        recvLine.supplier_id, recvLine.sku_id, recvLine.supplier_id, recvLine.sku_id
      )?.room || 0
    )
    // 跨订单串用的数量：
    //   · 有跨订单样本 ⇒ 开本行**原**可开额度（对 A 超 1 件，但供应商级仍容得下）；
    //   · 没有（种子库里该供应商该 SKU 只有一张订单）⇒ 只能退回"同订单行超开"（open + 1），
    //     并**显式 SKIP 并打印原因**（不伪绿、不假红）。
    const openRounded = Math.max(1, Math.round(recvLine.open * 10000) / 10000)
    const hasCross = !!otherOrder && Number(otherOrder.recv_b) > 0
    if (hasCross) {
      ok('夹具确实是「跨订单串用」：别的订单为同一供应商同一 SKU 也有入库量',
        true, `另一订单#${otherOrder.oid} 入库 ${otherOrder.recv_b}；供应商级可开 ${suppRoom}`)
      ok('该数量在「供应商 × SKU」口径下是允许的（⇒ 老口径会放行、正是 P1-5 的洞）',
        suppRoom >= openRounded, `供应商级可开 ${suppRoom} vs 本次开 ${openRounded}`)
    } else {
      console.log(
        `  ⚠️ SKIP 跨订单串用样本：本库该供应商#${recvLine.supplier_id} 该 SKU#${recvLine.sku_id} ` +
          `只有订单#${recvLine.order_id} 一张（供应商级可开 ${suppRoom} = 本行原可开 ${openRounded}）⇒ ` +
          '造不出"别的订单的入库量"；本段改用「同订单行超开」形式。' +
          '（跨订单串用被拒另由 `scripts/verify-purchase-chain.mjs` 的 P1-5 用例守：A/B 两单各入 100、为 A 开 200 ⇒ 被拒）'
      )
    }
    const exploitQty = hasCross ? openRounded : Math.round((openRounded + 1) * 10000) / 10000

    const inv2 = await mcp('purchase.create_invoice', {
      supplier_id: recvLine.supplier_id,
      invoice_type: 'vat_special',
      remark: `${TAG}·跨单串用${RUN}`,
      lines: [{ sku_id: recvLine.sku_id, order_item_id: recvLine.order_item_id, qty: exploitQty, price: Number(recvLine.price) }],
      idempotency_key: `k-pi-over-${RUN}`
    }, tkWrite)
    const inv2Id = mcpData(inv2)?.id
    const v3a = await confirmedCall('purchase.advance_invoice', { invoice_id: inv2Id, action: 'submit' }, tkDanger, purchaseJwt)
    const v3 = await confirmedCall('purchase.advance_invoice', { invoice_id: inv2Id, action: 'verify' }, tkDanger, purchaseJwt)
    ok(`${hasCross ? '跨订单串用' : '同订单行超开'}（挂订单#${recvLine.order_id}，开 ${exploitQty}）→ 被拒（PI_MATCH_FAILED）`,
      mcpErr(v3.final) && mcpData(v3.final)?.error === 'PI_MATCH_FAILED',
      `${safeJson(mcpData(v3a.final)).slice(0, 60)} | ${safeJson(mcpData(v3.final)).slice(0, 200)}`)
    ok('被拒的发票停在 submitted（不会被置成 verified）',
      one('SELECT status FROM purchase_invoices WHERE id=?', inv2Id)?.status === 'submitted',
      one('SELECT status FROM purchase_invoices WHERE id=?', inv2Id)?.status)
  }

  const st = await mcp('purchase.build_settlement', {
    supplier_id: supplier.id, remark: `${TAG}·结算${RUN}`, idempotency_key: `k-pst-${RUN}`
  }, tkWrite)
  ok('生成结算单成功', !mcpErr(st), safeJson(st.body).slice(0, 220))
  const stId = mcpData(st)?.id
  ok('结算单是草稿态', mcpData(st)?.status === 'draft', safeJson(mcpData(st)))
  const s1 = await confirmedCall('purchase.advance_settlement', { settlement_id: stId, action: 'submit' }, tkDanger, purchaseJwt)
  ok('结算单提交成功', !mcpErr(s1.final), safeJson(mcpData(s1.final)).slice(0, 200))
  const s2 = await confirmedCall('purchase.advance_settlement', { settlement_id: stId, action: 'audit' }, tkDanger, purchaseJwt)
  ok('结算单审核成功', !mcpErr(s2.final), safeJson(mcpData(s2.final)).slice(0, 200))
  ok('结算单状态 → audited', one('SELECT status FROM purchase_settlements WHERE id=?', stId)?.status === 'audited')

  const paidBefore = Number(one('SELECT paid_amount FROM purchase_settlements WHERE id=?', stId)?.paid_amount || 0)
  const pay = await mcp('purchase.create_payment', {
    supplier_id: supplier.id, amount: 10, remark: `${TAG}·付款${RUN}`,
    allocations: [{ settle_id: stId, amount: 10 }], idempotency_key: `k-pay-${RUN}`
  }, tkWrite)
  ok('登记付款单成功', !mcpErr(pay), safeJson(pay.body).slice(0, 220))
  const payId = mcpData(pay)?.id
  const p1 = await confirmedCall('purchase.advance_payment', { payment_id: payId, action: 'submit' }, tkDanger, purchaseJwt)
  ok('付款单提交成功', !mcpErr(p1.final), safeJson(mcpData(p1.final)).slice(0, 200))
  const paidMid = Number(one('SELECT paid_amount FROM purchase_settlements WHERE id=?', stId)?.paid_amount || 0)
  ok(`提交即核销（结算单已付 ${paidBefore} → ${paidMid}）`, paidMid - paidBefore === 10)
  const p2 = await confirmedCall('purchase.advance_payment', { payment_id: payId, action: 'pay' }, tkDanger, purchaseJwt)
  ok('执行付款成功', !mcpErr(p2.final), safeJson(mcpData(p2.final)).slice(0, 240))
  ok('付款单状态 → paid', one('SELECT status FROM purchase_payments WHERE id=?', payId)?.status === 'paid')
  ok('核销明细落库（金额与结算单一致）', Number(one('SELECT COALESCE(SUM(amount),0) a FROM purchase_payment_items WHERE payment_id=?', payId).a) === 10)
  // 核销上限：再给同一张结算单核销超过未付余额 → 被拒（四道闸的第四道）
  const over = await mcp('purchase.create_payment', {
    supplier_id: supplier.id, amount: 999999, remark: `${TAG}·超额核销${RUN}`,
    allocations: [{ settle_id: stId, amount: 999999 }], idempotency_key: `k-over-${RUN}`
  }, tkWrite)
  ok(
    '核销超过未付余额 → 被拒（PAY_ALLOC_OVER_BALANCE）',
    mcpErr(over) && String(mcpData(over)?.error || '').startsWith('PAY_ALLOC'),
    safeJson(mcpData(over)).slice(0, 200)
  )
  ok('超额核销的付款单没有落库', one('SELECT COUNT(*) c FROM purchase_payments WHERE remark LIKE ?', `%超额核销%`).c === 0)
}

// ============================================================
section('K10 幂等与确认单绑定')
{
  // 同键重放 → 返回首次结果，不新建
  const k = `k-idem-${RUN}`
  const a1 = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, remark: `${TAG}·幂等${RUN}`,
    items: [{ sku_id: sku.id, qty: 1, price: 9 }], idempotency_key: k
  }, tkWrite)
  const cnt = one('SELECT COUNT(*) c FROM purchase_orders').c
  const a2 = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, remark: `${TAG}·幂等${RUN}`,
    items: [{ sku_id: sku.id, qty: 1, price: 9 }], idempotency_key: k
  }, tkWrite)
  ok('同键重放返回首次结果', mcpData(a2)?.id === mcpData(a1)?.id, `${mcpData(a1)?.id} / ${mcpData(a2)?.id}`)
  ok('同键重放没有新建单据', one('SELECT COUNT(*) c FROM purchase_orders').c === cnt)
  ok('重放被标注为幂等命中', a2.body?.result?._idempotent_replay === true, safeJson(a2.body?.result).slice(0, 160))

  // 另一个令牌复用同一个键 + 不同参数 → 冲突
  const conf = await mcp('purchase.create_order', {
    supplier_id: supplier.id, warehouse_id: wh.id, remark: `${TAG}·幂等冲突${RUN}`,
    items: [{ sku_id: sku.id, qty: 2, price: 9 }], idempotency_key: k
  }, tkDanger)
  ok('换令牌/换参数复用同一键 → IDEMPOTENCY_CONFLICT', mcpErr(conf) && mcpData(conf)?.error === 'IDEMPOTENCY_CONFLICT', safeJson(mcpData(conf)).slice(0, 200))

  // 确认单不能重放 / 且失败不应被消费
  const cfmArgs = { requisition_id: 0, action: 'submit' }
  const c1 = await mcp('purchase.advance_requisition', cfmArgs, tkDanger)
  const ct = mcpData(c1)?.confirm_token
  ok('不存在的单据在确认**前**就返回待确认单（闸门顺序：先确认、后业务）', !!ct, safeJson(mcpData(c1)).slice(0, 200))
  if (ct) {
    await api('POST', `/mcp/confirmations/${ct}/approve`, { token: purchaseJwt })
    const ex1 = await mcp('purchase.advance_requisition', { ...cfmArgs, confirm_token: ct }, tkDanger)
    ok('用确认单执行不存在单据 → 业务错误（DOC_NOT_FOUND）', mcpErr(ex1) && mcpData(ex1)?.error === 'DOC_NOT_FOUND', safeJson(mcpData(ex1)).slice(0, 160))
    const ex2 = await mcp('purchase.advance_requisition', { ...cfmArgs, confirm_token: ct }, tkDanger)
    ok('执行失败后确认单没有被消费（同一事务回滚），可安全重试', !mcpData(ex2)?.error?.includes('ALREADY_USED'), safeJson(mcpData(ex2)).slice(0, 160))
  }
}

// ============================================================
section('K11 清理与自洽')
{
  const cleaned = purgeTestData()
  ok(`清理本轮单据（采购单 ${cleaned.orders} / 请购 ${cleaned.reqs} / 收货 ${cleaned.receipts}）`, cleaned.orders > 0 && cleaned.reqs > 0)
  ok(`清理标记批次的库存行（${cleaned.stocks}）与流水（${cleaned.txns}）`, cleaned.stocks > 0 && cleaned.txns > 0)
  ok('清理后标记库存已归零', one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE batch_no=?', TBATCH).q === 0)
  ok('清理后标记批次已消失', !one('SELECT id FROM inventory_batches WHERE batch_no=?', TBATCH))
  ok('清理后没有残留的测试采购单', one('SELECT COUNT(*) c FROM purchase_orders WHERE remark LIKE ?', `%${TAG}%`).c === 0)
  // 演示数据没被碰：首个采购单仍在、状态未变
  if (tmp.po?.id) {
    ok('演示库既有采购单未被破坏', !!one('SELECT id FROM purchase_orders WHERE id=?', tmp.po.id))
  }
  void uidStore
}

console.log('\n' + '─'.repeat(64))
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failed) console.log('  - ' + f)
}
db.close()
// 子进程必须回收并**说出来**：留下的一只 `node server/index.js` 会一直监听端口、
// 继续持有库文件。判据与形状见 `scripts/lib/reap.mjs`（唯一出处）。
installReapFallback(srv)
await stopAndReport(srv, { port: PORT })
process.exit(fail ? 1 : 0)
