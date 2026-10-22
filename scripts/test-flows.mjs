/**
 * ============================================================================
 * 文件标识：scripts/test-flows.mjs ｜ 测试：真实业务链路测试：起真实服务，按单据链路一路点下去，验证「状态机 + 留痕」真的生效
 * ============================================================================
 * 【职责】测试：真实业务链路测试：起真实服务，按单据链路一路点下去，验证「状态机 + 留痕」真的生效
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 真实业务链路测试：起真实服务，按单据链路一路点下去，验证「状态机 + 留痕」真的生效
//
// 与 smoke-api.mjs 的分工：
//   smoke-api 扫的是 GET（只读接口是否还活着）；
//   本脚本扫的是 POST 流转链路（写接口 + 状态推进 + 非法流转拦截 + 留痕）。
// 两者都过，才说明单据内核接进路由后没写坏任何一条主链路。
//
// 运行：node scripts/test-flows.mjs [industry]   默认 cosmetic
// 隔离（推荐）：GML_DATA_DIR=/tmp/<副本目录> PORT=436xx node scripts/test-flows.mjs cosmetic
//   启动处会自报"数据目录 / 三个库的绝对路径 / 监听端口"，落在 `<项目>/data/` 时额外打一行醒目标警。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
// 落点自证：库路径从 db/index.js 取（`dbPathFor`），不另写一份 `ROOT/data` ——
// 否则"打印的落点"与"真正打开的文件"会分家（`GML_DATA_DIR` 会看着生效、实际没生效）。
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.execPath
// 端口不写死：写死的话"独立端口"这条纪律落不了地。默认仍是 3198（与改动前一致）。
const PORT = Number(process.env.PORT) || 3198
const BASE = `http://127.0.0.1:${PORT}`
const INDUSTRY = process.argv[2] || 'cosmetic'

// ---------- 落点自证 ----------
const DB_PATH = dbPathFor(INDUSTRY)
const ALL_DB_PATHS = Object.keys(INDUSTRIES).map((c) => dbPathFor(c))
const isDevDataDir = (dir) => path.resolve(String(dir)) === path.join(ROOT, 'data')
const AT_DEV_DATA = isDevDataDir(path.dirname(DB_PATH))
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
for (const c of Object.keys(INDUSTRIES)) {
  console.log(`[落点] ${String(c).padEnd(8)} ${dbPathFor(c)}${c === INDUSTRY ? '   ← 本次读写' : ''}`)
}
console.log(`[落点] 监听端口：${PORT}${process.env.PORT ? '（来自环境变量 PORT）' : '（默认 3198，可用 PORT=436xx 覆盖）'}`)
if (AT_DEV_DATA) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail ? '→ ' + String(detail).slice(0, 220) : ''}`)
  }
}
function eq(name, actual, expected) {
  ok(name, String(actual) === String(expected), `实际 ${actual} / 期望 ${expected}`)
}
function section(t) {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

// ---------- 落点自证的可断言面（与 test-guards 同一判据） ----------
// 只有一行 console.log 的可见性没法证否：判据改坏了（例如永远不告警）也不会红。
section('落点自证（本次读写哪个库 / 何时必须告警）')
ok(
  '告警判据：`<项目>/data/` 被判为开发库（落在其上必须告警）',
  isDevDataDir(path.join(ROOT, 'data')) === true,
  `isDevDataDir(${path.join(ROOT, 'data')}) = ${isDevDataDir(path.join(ROOT, 'data'))}`
)
ok('告警判据：/tmp 隔离目录不被误判为开发库', isDevDataDir(path.join('/tmp', 'gml_isolated', 'data')) === false)
ok(
  '落点：本次将打开的文件 ∈ 上面打印的三个路径（打印即真相）',
  ALL_DB_PATHS.some((p) => path.resolve(p) === path.resolve(DB_PATH)),
  `DB_PATH=${DB_PATH}`
)

// ---------- 起服务 ----------
// `env` 带 `process.env` 是必要的：`GML_DATA_DIR` 靠它传给子进程。
const srv = spawn(NODE, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))

// ---------- 子进程回收（含异常路径），**不许静默** ----------
// ★ 本段**照抄** `scripts/test-guards.mjs` 的回收段（唯一出处在那里，判据理由见那段注释）：
//   ① 快路径 `exitCode/signalCode !== null`；② SIGKILL 后 50ms 轮询到 1.5s；
//   ③ 轮询结束才下结论；④ `exit` 钩子只发信号、不打字。
//   **两处必须同步改**；冻结后建议抽成共享函数（本批只做到"同形 + 互相指路"，不新造第二套判据）。
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}
/** 回收 spawn 的服务端；返回"是否确认已消失"。等待是真的等（信号 ≠ 进程没了）。 */
async function reclaim(timeoutMs = 1500) {
  if (srv.exitCode !== null || srv.signalCode !== null) return true
  try {
    srv.kill('SIGKILL')
  } catch {
    /* 已经没了 */
  }
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(srv.pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return !pidAlive(srv.pid)
}
async function reclaimAndExit(code) {
  const gone = await reclaim()
  console.log(gone ? `[回收] 已回收 pid ${srv.pid}` : `[回收] 回收失败，pid ${srv.pid} 仍在`)
  process.exit(code)
}
process.on('SIGINT', () => reclaimAndExit(130))
process.on('uncaughtException', (e) => {
  console.error(e)
  reclaimAndExit(1)
})
process.on('exit', () => {
  try {
    if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL')
  } catch {
    /* ignore */
  }
})

const started = Date.now()
const ready = await new Promise((resolve) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) {
      clearInterval(t)
      resolve(true)
    } else if (Date.now() - started > 240000) {
      clearInterval(t)
      resolve(false)
    }
  }, 400)
})
if (!ready) {
  console.log('❌ 服务未能启动，日志尾部：')
  console.log(log.split('\n').slice(-30).join('\n'))
  reclaimAndExit(1)
}
console.log('✅ 服务已启动')

let token = ''
async function api(method, p, body, tk = token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      'x-industry': INDUSTRY
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    /* 非 JSON */
  }
  return { status: res.status, body: json }
}

// ---------- 登录 ----------
const login = await api('POST', '/api/auth/login', { username: 'admin', password: '12345', industry: INDUSTRY }, '')
ok('主管理员登录', login.status === 200 && !!login.body?.data?.token, JSON.stringify(login.body).slice(0, 160))
token = login.body?.data?.token || ''

// ---------- 取演示主数据（直连库读，只为测试构造入参） ----------
const db = new Database(DB_PATH, { readonly: true })
const supplier = db.prepare("SELECT id FROM suppliers WHERE status='active' ORDER BY id LIMIT 1").get()
const wh =
  db.prepare("SELECT id FROM warehouses WHERE status='active' AND type='central' LIMIT 1").get() ||
  db.prepare("SELECT id FROM warehouses WHERE status='active' LIMIT 1").get()
const wh2 = db.prepare('SELECT id FROM warehouses WHERE id<>? ORDER BY id LIMIT 1').get(wh.id)
const richSku = db
  .prepare(
    `SELECT sku_id, SUM(qty_on_hand - qty_reserved) free
     FROM inventory_stocks WHERE warehouse_id=? GROUP BY sku_id ORDER BY free DESC LIMIT 1`
  )
  .get(wh.id)
const anySku = db.prepare('SELECT id FROM product_skus WHERE status=? ORDER BY id LIMIT 1').get('active')
const store = db.prepare("SELECT id FROM stores WHERE status='active' AND type<>'franchise' ORDER BY id LIMIT 1").get()
const skuId = richSku?.sku_id || anySku?.id
console.log(
  `主数据：供应商#${supplier?.id} 仓#${wh?.id}/${wh2?.id} 门店#${store?.id} SKU#${skuId}（可用 ${richSku?.free ?? '-'}）`
)
db.close()

// ===========================================================================
section('一、采购链路：建单 → 提交 → 审批 → 收货 → 关闭')
// ===========================================================================
const poCreate = await api('POST', '/api/purchase/orders', {
  supplier_id: supplier.id,
  warehouse_id: wh.id,
  order_date: '2026-10-15',
  expect_date: '2026-10-20',
  items: [{ sku_id: skuId, qty: 10, price: 20 }],
  remark: '链路测试采购单'
})
ok('创建采购订单', poCreate.status === 200 && !!poCreate.body?.data?.id, JSON.stringify(poCreate.body).slice(0, 200))
const poId = poCreate.body?.data?.id
const poNo = poCreate.body?.data?.doc_no
ok('新建单号走规则引擎（PO+日期+4位序号）', /^PO\d{8}\d{4}$/.test(String(poNo)), poNo)

const poSubmit = await api('POST', `/api/purchase/orders/${poId}/status`, { action: 'submit' })
eq('提交采购单 → 已提交', poSubmit.body?.data?.status, 'submitted')
const poApprove = await api('POST', `/api/purchase/orders/${poId}/status`, { action: 'approve' })
eq('审批采购单 → 已审批', poApprove.body?.data?.status, 'approved')

// 收货
const poDetail = await api('GET', `/api/purchase/orders/${poId}`)
const lines = (poDetail.body?.data?.items || []).map((i) => ({
  id: i.id,
  sku_id: i.sku_id,
  qty: i.qty,
  price: i.price
}))
const poRecv = await api('POST', `/api/purchase/orders/${poId}/receive`, {
  receipt_date: '2026-10-15',
  items: lines,
  inspector: '测试员'
})
ok('收货成功', poRecv.status === 200, JSON.stringify(poRecv.body).slice(0, 200))
const poAfter = await api('GET', `/api/purchase/orders/${poId}`)
eq('收货后采购单 → 已收货', poAfter.body?.data?.status, 'received')

const poClose = await api('POST', `/api/purchase/orders/${poId}/status`, { action: 'close' })
eq('关闭采购单 → 已关闭', poClose.body?.data?.status, 'closed')

const poIllegal = await api('POST', `/api/purchase/orders/${poId}/status`, { action: 'approve' })
eq('已关闭再审批被拒（409）', poIllegal.status, 409)
eq('拒绝码为 TRANSITION_NOT_ALLOWED', poIllegal.body?.detail?.code, 'TRANSITION_NOT_ALLOWED')

const poHist = await api('GET', `/api/docflow/history/PO/${poId}`)
const poActions = (poHist.body?.data || []).map((e) => e.action)
ok(
  '采购单留痕完整（submit/approve/receive/close）',
  ['submit', 'approve', 'receive', 'close'].every((a) => poActions.includes(a)),
  poActions.join(',')
)
ok('留痕记录了操作人', (poHist.body?.data || []).every((e) => e.actor_name), JSON.stringify(poHist.body?.data?.[0]).slice(0, 160))

// ===========================================================================
section('二、销售链路：建单 → 确认 → 发货 → 完成')
// ===========================================================================
const soCreate = await api('POST', '/api/sales/orders', {
  channel: 'store',
  store_id: store?.id,
  order_date: '2026-10-15',
  warehouse_id: wh.id,
  items: [{ sku_id: skuId, qty: 2, price: 99 }],
  remark: '链路测试销售单'
})
ok('创建销售订单', soCreate.status === 200 && !!soCreate.body?.data?.id, JSON.stringify(soCreate.body).slice(0, 200))
const soId = soCreate.body?.data?.id
const soNo = soCreate.body?.data?.doc_no
ok('销售单号走规则引擎', /^SO\d{8}\d{4}$/.test(String(soNo)), soNo)

const soConfirm = await api('POST', `/api/sales/orders/${soId}/confirm`)
ok('确认销售单 → 已确认', soConfirm.body?.data?.status === 'confirmed', JSON.stringify(soConfirm.body).slice(0, 240))

const soDeliver = await api('POST', `/api/sales/orders/${soId}/deliver`, { delivery_date: '2026-10-15', warehouse_id: wh.id })
ok('发货成功', soDeliver.status === 200, JSON.stringify(soDeliver.body).slice(0, 220))
const soAfter = await api('GET', `/api/sales/orders/${soId}`)
eq('发货后 → 已发货', soAfter.body?.data?.status, 'shipped')

const soComplete = await api('POST', `/api/sales/orders/${soId}/complete`)
ok('完成销售单 → 已完成', soComplete.body?.data?.status === 'completed', JSON.stringify(soComplete.body).slice(0, 240))

const soHist = await api('GET', `/api/docflow/history/SO/${soId}`)
const soActions = (soHist.body?.data || []).map((e) => e.action)
ok('销售单留痕完整（confirm/ship/complete）', ['confirm', 'ship', 'complete'].every((a) => soActions.includes(a)), soActions.join(','))

// ===========================================================================
section('三、库存链路：调拨（出库 → 入库）与盘点（草稿 → 盘点中 → 已调整）')
// ===========================================================================
const tfCreate = await api('POST', '/api/inventory/transfers', {
  from_warehouse_id: wh.id,
  to_warehouse_id: wh2.id,
  transfer_date: '2026-10-15',
  items: [{ sku_id: skuId, qty: 1 }],
  remark: '链路测试调拨单'
})
ok('创建调拨单', tfCreate.status === 200 && !!tfCreate.body?.data?.id, JSON.stringify(tfCreate.body).slice(0, 200))
const tfId = tfCreate.body?.data?.id
const tfDetail = await api('GET', `/api/inventory/transfers/${tfId}`)
const tfNo = tfDetail.body?.data?.doc_no
ok('调拨单号前缀与代码一致（TR）', String(tfNo).startsWith('TR'), tfNo)

const tfShip = await api('POST', `/api/inventory/transfers/${tfId}/ship`)
ok('调拨出库成功', tfShip.status === 200, JSON.stringify(tfShip.body).slice(0, 200))
const tfRecv = await api('POST', `/api/inventory/transfers/${tfId}/receive`, { receive_date: '2026-10-15' })
ok('调拨入库成功', tfRecv.status === 200, JSON.stringify(tfRecv.body).slice(0, 200))
const tfAgain = await api('POST', `/api/inventory/transfers/${tfId}/ship`)
eq('已入库的调拨单再出库被拒（409）', tfAgain.status, 409)

const ckCreate = await api('POST', '/api/inventory/checks', { warehouse_id: wh.id, check_date: '2026-10-15', checker: '测试员' })
ok('创建盘点单', ckCreate.status === 200 && !!ckCreate.body?.data?.id, JSON.stringify(ckCreate.body).slice(0, 200))
const ckId = ckCreate.body?.data?.id
const ck1 = await api('GET', `/api/inventory/checks/${ckId}`)
eq('盘点单建单为草稿态', ck1.body?.data?.status, 'draft')

const ckItems = (ck1.body?.data?.items || []).slice(0, 3).map((i) => ({
  id: i.id,
  book_qty: i.book_qty,
  actual_qty: Number(i.book_qty),
  reason: '链路测试实盘'
}))
if (ckItems.length) {
  const ckInput = await api('PUT', `/api/inventory/checks/${ckId}/items`, { items: ckItems })
  ok('录入实盘成功', ckInput.status === 200, JSON.stringify(ckInput.body).slice(0, 200))
  const ck2 = await api('GET', `/api/inventory/checks/${ckId}`)
  eq('录入实盘后 → 盘点中', ck2.body?.data?.status, 'checking')
  const ckAdj = await api('POST', `/api/inventory/checks/${ckId}/adjust`)
  ok('盘差调整成功', ckAdj.status === 200, JSON.stringify(ckAdj.body).slice(0, 200))
  const ck3 = await api('GET', `/api/inventory/checks/${ckId}`)
  eq('调整后 → 已调整', ck3.body?.data?.status, 'adjusted')
  const ckHist = await api('GET', `/api/docflow/history/CK/${ckId}`)
  const ckActions = (ckHist.body?.data || []).map((e) => e.action)
  ok('盘点留痕完整（start/adjust）', ckActions.includes('start') && ckActions.includes('adjust'), ckActions.join(','))
} else {
  ok('盘点单无库存行（跳过实盘用例）', false, '该仓库无库存明细')
}

// ===========================================================================
section('四、单据内核元数据接口')
// ===========================================================================
const ov = await api('GET', '/api/docflow/overview')
ok('内核总览可读', ov.status === 200 && ov.body?.data?.docTypes >= 22, JSON.stringify(ov.body?.data)?.slice(0, 160))
ok('总览含真实状态分布', Array.isArray(ov.body?.data?.distribution) && ov.body.data.distribution.length > 0)
const machine = await api('GET', '/api/docflow/types/SO/machine')
ok('状态机接口可读', machine.status === 200 && machine.body?.data?.states?.length === 7, JSON.stringify(machine.body).slice(0, 160))
const acts = await api('GET', '/api/docflow/actions?doc_type=SO&status=confirmed')
ok('动作查询返回可执行动作', (acts.body?.data || []).map((a) => a.action).includes('ship'))
const flows = await api('GET', '/api/docflow/flows')
ok(`业务流已登记（${flows.body?.data?.length ?? 0} 条）`, (flows.body?.data || []).length >= 6)
const ev = await api('GET', '/api/docflow/events?limit=5')
ok('流转日志可查', ev.status === 200 && (ev.body?.data?.list || []).length > 0)
const tr = await api('GET', `/api/docflow/trace?doc_no=${encodeURIComponent(String(poNo))}`)
ok('全链路联查可读', tr.status === 200 && (tr.body?.data || []).length > 0)
const noRules = await api('GET', '/api/docflow/no-rules')
ok(`编码规则可读（${noRules.body?.data?.length ?? 0} 条）`, (noRules.body?.data || []).length >= 18)
const noIssue = await api('POST', '/api/docflow/no-issue', { doc_type: 'PO', dry: true })
ok('试取号（预览）可用', noIssue.status === 200 && /^PO\d{8}\d{4}$/.test(String(noIssue.body?.data?.docNo)), JSON.stringify(noIssue.body).slice(0, 160))

// 先回收服务端再打收尾：这样"回收"本身也能进判据
const reclaimedOk = await reclaim()
console.log(reclaimedOk ? `[回收] 已回收 pid ${srv.pid}` : `[回收] 回收失败，pid ${srv.pid} 仍在`)
// 判据取**独立观测量**（直接探测 pid），不取 reclaim() 的返回值
ok('子进程回收：服务端进程已消失（直接探测 pid，不看 kill() 的返回值）', !pidAlive(srv.pid), `pid ${srv.pid}`)
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}合计：${pass} 通过 / ${fail} 失败\x1b[0m`)
if (failures.length) console.log('失败项：' + failures.join('、'))
if (fail) console.log('\n服务日志尾部：\n' + log.split('\n').slice(-25).join('\n'))
process.exit(fail ? 1 : 0)
