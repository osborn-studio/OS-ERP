/**
 * ============================================================================
 * 文件标识：scripts/test-guards.mjs ｜ 守卫回归：越权读（D2）/ 负价（D3）/ MCP 安全闸（D4）
 * ============================================================================
 * 【职责】守卫回归：越权读（D2）/ 负价（D3）/ MCP 安全闸（D4）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 守卫回归：越权读（D2）/ 负价（D3）/ MCP 安全闸（D4）
// 对应文档：docs/GML验收阻断缺陷登记_v1_20261016.md
//
// 为什么要有这一套（而不是"再补几个接口用例"）：
//   本次 5 组阻断缺陷的形状高度一致 —— **漏了一个入口 / 一个分支 / 一个维度**：
//     · 销售订单列表挡得住、**详情**挡不住（详情手写了第二套判断，只判 dealer）
//     · 建单校验了价格、**改单**没校验
//     · tools/call 走了白黑名单、**resources/read** 没走
//   按接口逐个手写用例挡不住这类问题：**漏掉的那一个永远不会出现在用例清单里**。
//   所以这里按「矩阵」写：角色 × 接口、入口 × 入口、入参 × 边界。
//
// 运行：node scripts/test-guards.mjs [cosmetic|food|apparel]
// 隔离（推荐）：GML_DATA_DIR=/tmp/<副本目录> node scripts/test-guards.mjs cosmetic
//   本脚本会**真删真改**库存 / 流水 / 参数（见 :804 / :1090 / :1351 / :1594 / :1697 / :1772），
//   默认落在 `<项目>/data/`。启动处会自报"我打开了哪个库"，落在开发库时额外打一行醒目标警
//   （见下面的「落点自证」）—— 这一跑动的是哪儿，由脚本自己说，不靠人回忆。
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import Database from 'better-sqlite3'
// 落点自证：库路径一律从 db/index.js 取（`dbPathFor`），不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'
// 库存引擎直调（A11 跨批次成本 / A12 参数缓存 / A13 批次闸门）：
// 这几条要在**同一进程里直接调函数**才能验证到"函数返回什么"，
// 走 HTTP 只能看到结果、看不到中间量。
import { getInvParam, clearParamCache, pickBatches, applyStockIn, applyStockOut, resolveOwnerOrg, reserveForDoc } from '../server/lib/stock.js'
// 令牌口径**从服务端导入**，不在这里重写一份 ——
// 第 5 批给后台令牌加了 `audience`，如果测试自己硬编码一套，两边一旦不同步
// 就会出现"测试绿、线上红"（或者反过来）：**判据的定义处只能有一个**。
import { BACK_AUD, JWT_SECRET as SERVER_JWT_SECRET } from '../server/middleware/auth.js'
// D1 退货闭环：门店退货与销售退货共用同一份计划，测试直接调它来证明"同一份判据"
import { planReturn, ReturnError } from '../server/lib/returns.js'
// A14/A15（批次 I 第 10 批，重开 F 渠道闭环）：
//   · `checkout.settle/unsettle` = 结算域唯一入口（试算与落单共用同一条算钱判据）
//   · `member` = 积分/等级的**唯一**口径（用来证明"商城不再自己按 1 元 1 分"）
//   · `promotion` = 留痕/登记/回退（用来证明"oms 418 与 pos 418 不会串"）
import * as CO from '../server/lib/checkout.js'
import * as MB from '../server/lib/member.js'
import * as PR from '../server/lib/promotion.js'
import * as CP from '../server/lib/coupon.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// ---------- 丁 · 参数自证：不认识的参数**拒**，不静默忽略 ----------
// 为什么必须有（与 `scripts/check-inv-txn-dict.mjs` 同一条判据）：本脚本没有 flag 分支，
// 但 `node scripts/test-guards.mjs fot` 这种手误会**被当成行业名直接用** —— sqlite 会自己
// 建出一个空的 `gml_fot.db`，脚本照样跑完、照样打「通过 N / 失败 M」、退出码照样 0，
// 与"真的跑过了"**输出同形**。这正是「无意义的动作被静默接受」那一族。
// 判据：不认识的输入，要么被拒、要么被报，**不许被忽略**。
const USAGE = [
  '用法：node scripts/test-guards.mjs [cosmetic|food|apparel]',
  '  无参数 ：默认 cosmetic',
  '  本脚本没有其它 flag（--dry / --only / --keep 均不支持）',
  '  隔离  ：GML_DATA_DIR=/tmp/<副本目录> node scripts/test-guards.mjs cosmetic'
].join('\n')
const argv = process.argv.slice(2)
const flags = argv.filter((a) => a.startsWith('-'))
const industryArg = argv.find((a) => !a.startsWith('-'))
const badArgs = [...flags, ...(industryArg && !INDUSTRIES[industryArg] ? [industryArg] : [])]
if (badArgs.length) {
  console.error(`✗ 未知参数：${badArgs.join(' ')}\n`)
  console.error(USAGE)
  process.exit(2)
}
const INDUSTRY = industryArg || 'cosmetic'
// 端口不写死：写死的话"独立端口"这条纪律就落不了地（同一时间只能有一个 3196）。
// 默认仍是 3196（与改动前一致），需要并存时用 PORT=436xx 覆盖。
const PORT = Number(process.env.PORT) || 3196
const BASE = `http://127.0.0.1:${PORT}`

// ---------- 落点自证：本次运行打开的是哪个库 ----------
// 为什么必须有：本脚本的期望值**与库状态有关**（全新库 368 ↔ 开发库 374，是项目长期口径），
// 所以"这一跑动的是哪儿"必须由脚本自己说出来。判据是 **dbPathFor() 的落点**：
// 打印的就是下面真正会 `new Database(DB_PATH)` 的那个文件，不是另算的一个影子路径。
const DB_PATH = dbPathFor(INDUSTRY)
const ALL_DB_PATHS = Object.keys(INDUSTRIES).map((c) => dbPathFor(c))
const isDevDataDir = (dir) => path.resolve(String(dir)) === path.join(ROOT, 'data')
const AT_DEV_DATA = isDevDataDir(path.dirname(DB_PATH))
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
for (const c of Object.keys(INDUSTRIES)) {
  console.log(`[落点] ${String(c).padEnd(8)} ${dbPathFor(c)}${c === INDUSTRY ? '   ← 本次读写' : ''}`)
}
console.log(`[落点] 监听端口：${PORT}${process.env.PORT ? '（来自环境变量 PORT）' : '（默认 3196，可用 PORT=436xx 覆盖）'}`)
if (AT_DEV_DATA) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}

// 与 middleware/auth.js 同一口径：测试直接签 JWT 是为了构造「另一个门店 / 另一个经销商」，
// 而不是为了绕过登录 —— 真实账号（store01 / dealer01）只有一个，跨主体用例无从下手。
const JWT_SECRET = process.env.GML_JWT_SECRET || SERVER_JWT_SECRET

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
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + String(detail).slice(0, 260) : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

// ---------- 落点自证的可断言面 ----------
// 把"告警判据"与"落点路径"做成**能被断言**的两条，而不是只有一行 console.log：
// 只有 console.log 的可见性没法证否 —— 判据改坏了（例如永远不告警）也没有东西会红。
section('落点自证（本次读写哪个库 / 何时必须告警）')
ok(
  '告警判据：`<项目>/data/` 被判为开发库（落在其上必须告警）',
  isDevDataDir(path.join(ROOT, 'data')) === true,
  `isDevDataDir(${path.join(ROOT, 'data')}) = ${isDevDataDir(path.join(ROOT, 'data'))}`
)
ok(
  '告警判据：/tmp 隔离目录不被误判为开发库',
  isDevDataDir(path.join('/tmp', 'gml_isolated', 'data')) === false
)
ok(
  '落点：三个行业库路径互不相同（不与同名文件混跑）',
  new Set(ALL_DB_PATHS.map((p) => path.resolve(p))).size === 3,
  ALL_DB_PATHS.join(' | ')
)
{
  const dirs = new Set(ALL_DB_PATHS.map((p) => path.dirname(path.resolve(p))))
  ok('落点：三个行业库同处一个数据目录（不跨目录混跑）', dirs.size === 1, [...dirs].join(' | '))
}
ok(
  '落点：本次将打开的文件 ∈ 上面打印的三个路径（打印即真相）',
  ALL_DB_PATHS.some((p) => path.resolve(p) === path.resolve(DB_PATH)),
  `DB_PATH=${DB_PATH}`
)

// ---------- 起服务 ----------
// `env` 里带上 `process.env` 是**必要的**：`GML_DATA_DIR` 就是靠它传给子进程的
// （父进程只把它解析成 DATA_DIR 打印出来，并不会替子进程设值）。
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))

// ---------- 子进程回收（含异常路径），**不许静默** ----------
// ★ 本段是「回收 spawn 出来的服务端」在**本仓的唯一出处**。其它脚本要回收子进程，
//   请照此实现（或冻结后抽成共享函数），**不要另写一版** —— 同一个判据两份实现，
//   以后只会改一处（本批 `doc_type` / M18 就是这个形状）。
//   判据要点（顺序不能换）：
//     ① 快路径用 `srv.exitCode !== null || srv.signalCode !== null`（Node 只在**真的退出/reap**
//        后才置位，可靠）—— 不要用 `process.kill(pid,0)` 当快路径判据；
//     ② SIGKILL 之后**轮询**（50ms × 上限 1.5s）：子进程秒退时立刻下结论、不白等，
//        且"失败"来自多次重探 ⇒ 天然免疫瞬时假红（一位队友用 `setTimeout(2000)` 单次超时，
//        在"秒退"这个最常见情形下白等 2s，就是在 `exit` 钩子里探活才报出假红）；
//     ③ 结论只在轮询结束后下；
//     ④ `exit` 钩子**只发信号、不打字不下结论**（否则同一件事被说两遍、还说错一遍）。
//   为什么必须是"等"：`srv.kill()` 只表示"信号发出去了"，不等于"进程真的没了" ——
//   实测就留下过一个 `node server/index.js` 一直监听 3196（还持有库文件，下次再跑撞端口）。
//   后置条件首选"端口已释放"（`lsof -iTCP:$PORT` 空）比"pid 还在"更贴近"有没有把环境还回去"；
//   本处只判 pid（独立观测量），端口核对见下面收尾处的提示。
const pidAlive = (pid) => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM' // EPERM = 存在但无权限（这里不该发生，保守处理）
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
// 兜底：任何路径退出时都再补一发（这里不能 await，所以只发信号、不承诺结果 ——
// 上面那条会打字的路径才是"会说话"的那条）
process.on('exit', () => {
  try {
    if (srv.exitCode === null && srv.signalCode === null) srv.kill('SIGKILL')
  } catch {
    /* ignore */
  }
})

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
  reclaimAndExit(1)
}
console.log(`✅ 服务已启动（${INDUSTRY}）`)

// ---------- 库内取样（只读连接，仅用于构造入参与核对期望值） ----------
const db = new Database(DB_PATH, { readonly: true })
// 写连接在**用例开始前**就要有：A20 之后"令牌里的归属不再生效"，
// 跨主体用例必须自造真实的库内用户（见 makeProbeUser）。
const rw = new Database(DB_PATH)
const one = (sql, ...p) => db.prepare(sql).get(...p)
const all = (sql, ...p) => db.prepare(sql).all(...p)

const supplier = one("SELECT id FROM suppliers WHERE status='active' ORDER BY id LIMIT 1")
const wh = one("SELECT id FROM warehouses WHERE status='active' ORDER BY id LIMIT 1")
const sku = one("SELECT id FROM product_skus ORDER BY id LIMIT 1")
const soStore = one('SELECT id, store_id FROM sales_orders WHERE store_id IS NOT NULL ORDER BY id LIMIT 1')
const soDealer = one('SELECT id, dealer_id FROM sales_orders WHERE dealer_id IS NOT NULL ORDER BY id LIMIT 1')
const otherStoreId = one('SELECT id FROM stores WHERE id<>? ORDER BY id LIMIT 1', soStore.store_id)?.id
const otherDealerId = one('SELECT id FROM dealers WHERE id<>? ORDER BY id LIMIT 1', soDealer.dealer_id)?.id
const delivery = one(
  'SELECT sd.id, so.store_id, so.dealer_id FROM sales_deliveries sd JOIN sales_orders so ON so.id=sd.order_id WHERE so.store_id IS NOT NULL ORDER BY sd.id LIMIT 1'
)
const retStore = one('SELECT id, store_id FROM sales_returns WHERE store_id IS NOT NULL ORDER BY id LIMIT 1')
const retDealer = one('SELECT id, dealer_id FROM sales_returns WHERE dealer_id IS NOT NULL ORDER BY id LIMIT 1')
const po = one('SELECT id FROM purchase_orders ORDER BY id LIMIT 1')
const uidStore = one("SELECT id FROM users WHERE role='store' ORDER BY id LIMIT 1")?.id
const uidDealer = one("SELECT id FROM users WHERE role='dealer' ORDER BY id LIMIT 1")?.id
console.log(
  `取样：SO(store ${soStore.store_id} / dealer ${soDealer.dealer_id}) 发货单#${delivery.id} 采购单#${po.id} 仓#${wh.id} SKU#${sku.id}`
)

// ---------- 请求封装 ----------
async function api(method, p, { token, body } = {}) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-industry': INDUSTRY,
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function loginAs(username, password) {
  const r = await api('POST', '/api/auth/login', { body: { username, password, industry: INDUSTRY } })
  return r.body?.data?.token || null
}

/** 造一个「别的门店 / 别的经销商」的凭据（同一套 JWT 格式，走同一条 requireAuth） */
function forge(payload) {
  const user = one('SELECT auth_version FROM users WHERE id=?', payload.uid)
  return jwt.sign({ industry: INDUSTRY, auth_version: user?.auth_version, ...payload }, JWT_SECRET, { expiresIn: '1h', audience: BACK_AUD, algorithm: 'HS256' })
}

/**
 * 自造一个探针用户。
 *
 * A20 之后，**令牌里的 role / store_id / dealer_id 不再生效** —— `requireAuth` 一律以库为准。
 * 所以跨主体用例不能再靠"同一个 uid + 改 token 内容"：那正好是被修掉的那件事。
 * 需要"另一个门店/经销商"时，就在库里造一个真实用户（不走登录，所以不需要密码）。
 */
const probeUserIds = []
function makeProbeUser({ username, role, storeId = null, dealerId = null }) {
  const info = rw
    .prepare(
      "INSERT INTO users (username,password_hash,name,role,dealer_id,store_id,status,is_super) VALUES (?,?,?,?,?,?,'active',0)"
    )
    .run(username, 'probe', `守卫·${username}`, role, dealerId, storeId)
  const id = Number(info.lastInsertRowid)
  probeUserIds.push(id)
  return id
}

/**
 * 造一张**不带 audience 的旧式令牌**：用来反证"后台入口确实在校验 aud"。
 * 修复前 `jwt.verify(token, SECRET)` 不校 aud，这种令牌畅通无阻；
 * 修复后它必须被拒 —— 这条断言就是那半侧隔离的"变红过"的证据。
 */
function forgeNoAud(payload) {
  const user = one('SELECT auth_version FROM users WHERE id=?', payload.uid)
  return jwt.sign({ industry: INDUSTRY, auth_version: user?.auth_version, ...payload }, JWT_SECRET, { expiresIn: '1h', algorithm: 'HS256' })
}

const adminJwt = await loginAs('admin', '12345')
const viewerJwt = await loginAs('viewer', '123456')
const purchaseJwt = await loginAs('purchase', '123456')
const salesJwt = await loginAs('sales', '123456')
const warehouseJwt = await loginAs('warehouse', '123456')
const financeJwt = await loginAs('finance', '123456')
ok('角色账号全部登录成功', !!(adminJwt && viewerJwt && purchaseJwt && salesJwt && warehouseJwt && financeJwt))

const tokStoreA = forge({ uid: makeProbeUser({ username: 'guard_store_a', role: 'store', storeId: soStore.store_id }), username: 'guard_store_a', role: 'store', name: '守卫·门店A' })
const tokStoreB = forge({ uid: makeProbeUser({ username: 'guard_store_b', role: 'store', storeId: otherStoreId }), username: 'guard_store_b', role: 'store', name: '守卫·门店B' })
const tokDealerA = forge({ uid: makeProbeUser({ username: 'guard_dealer_a', role: 'dealer', dealerId: soDealer.dealer_id }), username: 'guard_dealer_a', role: 'dealer', name: '守卫·经销商A' })
const tokDealerB = forge({ uid: makeProbeUser({ username: 'guard_dealer_b', role: 'dealer', dealerId: otherDealerId }), username: 'guard_dealer_b', role: 'dealer', name: '守卫·经销商B' })

// ============================================================
section('G1 销售：列表与详情判据同源（D2）')
// 「列表看不到、详情却能打开」是本次 D2 的原形。所以两条路径必须一起验。
const listA = await api('GET', '/api/sales/orders', { token: tokStoreA })
const listB = await api('GET', '/api/sales/orders', { token: tokStoreB })
ok('门店 A 能看到自己的订单列表', listA.status === 200 && listA.body.data.list.length > 0)
ok('门店 B 列表里没有任何一条属于门店 A', (listB.body.data.list || []).every((r) => r.store_id === otherStoreId))
const storeACount = one('SELECT COUNT(*) c FROM sales_orders WHERE store_id=?', soStore.store_id).c
ok(
  `门店 A 列表条数与库内一致（${storeACount}）`,
  listA.body.data.total === storeACount,
  `接口 ${listA.body.data.total} / 库 ${storeACount}`
)

const detailA = await api('GET', `/api/sales/orders/${soStore.id}`, { token: tokStoreA })
ok('门店 A 读自己的订单详情 → 200', detailA.status === 200)
const detailB = await api('GET', `/api/sales/orders/${soStore.id}`, { token: tokStoreB })
ok('门店 B 读门店 A 的订单详情 → 403（原来返回 200）', detailB.status === 403, `实际 ${detailB.status}`)

const dDetailA = await api('GET', `/api/sales/orders/${soDealer.id}`, { token: tokDealerA })
ok('经销商 A 读自己的订单详情 → 200', dDetailA.status === 200)
const dDetailB = await api('GET', `/api/sales/orders/${soDealer.id}`, { token: tokDealerB })
ok('经销商 B 读经销商 A 的订单详情 → 403', dDetailB.status === 403, `实际 ${dDetailB.status}`)

// ============================================================
section('G2 发货单 / 退货单：同一条判据覆盖到"容易漏"的那几条路径（D2）')
const dlA = await api('GET', '/api/sales/deliveries', { token: tokStoreA })
const dlExpect = one(
  'SELECT COUNT(*) c FROM sales_deliveries sd JOIN sales_orders so ON so.id=sd.order_id WHERE so.store_id=?',
  soStore.store_id
).c
ok('门店发货单列表条数与库内该门店一致', dlA.body.data.total === dlExpect, `接口 ${dlA.body.data.total} / 库 ${dlExpect}`)
const dlDetailOther = await api('GET', `/api/sales/deliveries/${delivery.id}`, { token: tokStoreB })
ok(
  '门店 B 读门店 A 的发货单详情 → 403',
  delivery.store_id === otherStoreId ? dlDetailOther.status === 200 : dlDetailOther.status === 403,
  `实际 ${dlDetailOther.status}`
)

const rtA = await api('GET', '/api/sales/returns', { token: tokStoreA })
if (retStore) {
  ok('门店退货单列表只含本门店', (rtA.body.data.list || []).every((r) => r.store_id === soStore.store_id))
} else {
  ok('门店退货单列表可用（本库无门店退货样本，跳过范围断言）', rtA.status === 200)
}
const rtD = await api('GET', '/api/sales/returns', { token: tokDealerB })
ok(
  '经销商退货单列表只含本经销商',
  (rtD.body.data.list || []).every((r) => r.dealer_id === otherDealerId),
  JSON.stringify((rtD.body.data.list || []).slice(0, 2))
)

// 统计也是"读"：不能从汇总里看别家的结构
const stB = await api('GET', '/api/sales/stats', { token: tokStoreB })
ok('门店销售统计只含本门店维度', (stB.body.data.topStores || []).every((r) => r.name === one('SELECT name FROM stores WHERE id=?', otherStoreId)?.name))
const stOrdersB = one(
  "SELECT COUNT(*) c FROM sales_orders WHERE store_id=? AND status NOT IN ('cancelled','draft') AND order_date >= date('now','localtime','-30 day')",
  otherStoreId
).c
ok('门店销售统计单数与库内一致', Number(stB.body.data.totalOrders) === stOrdersB, `接口 ${stB.body.data.totalOrders} / 库 ${stOrdersB}`)

// ============================================================
section('G3 采购域：外部主体一律不可见（D2）')
// 财务报表的读取门：先取一个**真实存在**的期间再拼路径 ——
// 否则 400（期间格式/不存在）会和 403（没权限）混在一起，矩阵就白测了。
const reportMeta = await api('GET', '/api/reports/meta', { token: financeJwt })
const reportPeriod = (reportMeta.body?.data?.periods || [])[0]?.period
ok('财务报表字典可读且带可用期间（本节前提）', reportMeta.status === 200 && !!reportPeriod, `${reportMeta.status} / ${reportPeriod}`)
const REP_BS = `/api/reports/bs?period=${reportPeriod}`
const REP_TB = `/api/reports/subject-balances?period=${reportPeriod}`
const MATRIX = [
  // 路径, 角色名, 角色凭据, 期望状态
  // 财务报表：**内部财务数据**，外部主体（经销商 / 门店）一律不可见；
  // 连 viewer（访客）也不给 —— 三张主表能推出成本、毛利与负债结构，
  // 而"访客"这个角色在本系统里的定义是"能看业务单据，不看账"。
  [REP_BS, 'finance', financeJwt, 200],
  [REP_BS, 'sales', salesJwt, 403],
  [REP_BS, 'viewer', viewerJwt, 403],
  [REP_BS, 'dealer', tokDealerA, 403],
  [REP_BS, 'store', tokStoreA, 403],
  [REP_BS, '(未登录)', null, 401],
  [REP_TB, 'sales', salesJwt, 403],
  // 期末结转的**状态**与报表同门（它读的是科目余额）；写门（结转/撤销）另有权限点，
  // 见 G3b 之后那一条 —— 写门绝不放这里，否则矩阵会真的生成一张凭证。
  [`/api/reports/closing/${reportPeriod}`, 'finance', financeJwt, 200],
  [`/api/reports/closing/${reportPeriod}`, 'sales', salesJwt, 403],
  ['/api/reports/periods', 'sales', salesJwt, 403],
  ['/api/reports/audit', 'dealer', tokDealerA, 403],
  ['/api/purchase/orders', 'purchase', purchaseJwt, 200],
  ['/api/purchase/orders', 'warehouse', warehouseJwt, 200],
  ['/api/purchase/orders', 'finance', financeJwt, 200],
  ['/api/purchase/orders', 'viewer', viewerJwt, 200],
  ['/api/purchase/orders', 'sales', salesJwt, 403],
  ['/api/purchase/orders', 'dealer', tokDealerA, 403],
  ['/api/purchase/orders', 'store', tokStoreA, 403],
  ['/api/purchase/orders', '(未登录)', null, 401],
  ['/api/purchase/receipts', 'dealer', tokDealerA, 403],
  ['/api/purchase/receipts', 'store', tokStoreA, 403],
  ['/api/purchase/returns', 'dealer', tokDealerA, 403],
  ['/api/purchase/stats', 'dealer', tokDealerA, 403],
  [`/api/purchase/orders/${po.id}`, 'dealer', tokDealerA, 403],
  [`/api/purchase/orders/${po.id}/receive-suggest`, 'dealer', tokDealerA, 403],
  // 销售域对照：dealer / store 读**自己的**销售数据是允许的，别把两类单据搞混
  ['/api/sales/orders', 'dealer', tokDealerA, 200],
  ['/api/sales/orders', 'store', tokStoreA, 200],
  ['/api/sales/orders', 'viewer', viewerJwt, 200],
  ['/api/sales/orders', '(未登录)', null, 401]
]
for (const [p, role, token, want] of MATRIX) {
  const r = await api('GET', p, { token })
  ok(`${role.padEnd(9)} GET ${p} → ${want}`, r.status === want, `实际 ${r.status}`)
}

// ============================================================
section('G3b 域错误码：业务校验失败必须是 4xx，**不能是 500**（批次 L 修）')
//
// 起因（动态复现，A 级证据）：`POST /api/accounting/vouchers/generate` 传一个不支持的
// `biz_type`，返回的是 **500**，而不是 400。
// 根因是一条**系统性**的错配：域错误类只写 `this.http`，而 HTTP 层的统一翻译器
// `failFromError` 与全局兜底中间件都只认 `error.status` —— 于是**每一个业务错误都被报成 500**。
// 危害不是"码不好看"：500 会把排查方向从「我的参数不对」带偏到「服务器挂了」，
// 而且监控上的 5xx 曲线会一直响（真出事时反而分不清）。
// 修法是根因级的：7 个域错误类同时写 `status`（`http` 保留，路由里按 `http` 翻译的地方不受影响）。
//
// 这一节的判据：**错误码必须是 4xx，且响应里必须带得走排查的业务码**。
const ERR_CASES = [
  ['会计：未知业务场景', 'POST', '/api/accounting/vouchers/generate', { biz_type: 'no_such_biz', source_id: 1 }],
  ['会计：科目必填项缺失', 'POST', '/api/accounting/subjects', {}],
  ['报表：期间格式非法', 'GET', '/api/reports/bs?period=2026-13', null],
  ['报表：报表代码不存在', 'GET', '/api/reports/zzz?period=2026-10', null],
  ['报表：关账期间格式非法', 'POST', '/api/reports/periods/2026-13/close', {}],
  ['报表：期初余额缺参数', 'PUT', '/api/reports/opening', {}],
  // 批次 M（期末结转）的两条。第二条刻意挑**已结转**的期间（2026-07）：它的理由校验
  // 在删除之前，所以这条用例不会真的动演示数据 —— 而它同时证明了"撤销要走理由"这道闸在 HTTP 层是活的。
  ['结转：期间格式非法（结转）', 'POST', '/api/reports/periods/2026-13/carry-forward', {}],
  ['结转：期间格式非法（结转状态）', 'GET', '/api/reports/closing/2026-13', null],
  ['结转：撤销已结转期间但没写理由', 'POST', '/api/reports/periods/2026-07/reverse-closing', {}],
  ['DMS：协议不存在', 'POST', '/api/dms/agreements/999999/status', { status: 'x' }],
  ['退款：缺少分摊明细', 'POST', '/api/refunds', { customer_type: 'dealer', customer_id: 1, refund_date: '2026-10-16', amount: 1, idempotency_key: `probe-err-${Date.now()}` }]
]
for (const [label, method, path, body] of ERR_CASES) {
  const r = method === 'GET' ? await api('GET', path, { token: adminJwt }) : await api(method, path, { token: adminJwt, body })
  const b = r.body || {}
  ok(`${label} → 4xx（实际 ${r.status}）`, r.status >= 400 && r.status < 500, JSON.stringify(b).slice(0, 160))
  // 业务码有**两个落点**：路由层 `failFromError` 放 `detail.code`，
  // 全局兜底中间件放顶层 `error`。两条路径都算"带得走排查"，所以两处取其一即可 ——
  // 但不能两处都没有（那就只剩一句中文，用户报障时没法定位）。
  ok(`${label} 带业务码（便于排查）`, !!(b.error || b.detail?.code), JSON.stringify(b).slice(0, 160))
}

// 期末结转（批次 M）是**写门**：它生成一张已过账的凭证（真的动账）。
// 所以它与"关账"分开授权（`finance.period.carry` ≠ `finance.period.close`）——
// 能关账的人不一定能动账。这里用一个没有该权限点的角色试一次：
// 必须 403，且**不产生任何凭证**（下面那条断言盯的就是这个）。
const carryBefore = await api('GET', `/api/reports/closing/${reportPeriod}`, { token: financeJwt })
const carryAttempt = await api('POST', `/api/reports/periods/${reportPeriod}/carry-forward`, { token: salesJwt, body: {} })
ok('没有"期末结转"权限的角色不能结转 → 403', carryAttempt.status === 403, `实际 ${carryAttempt.status}`)
const carryAfter = await api('GET', `/api/reports/closing/${reportPeriod}`, { token: financeJwt })
ok(
  '越权结转没有产生任何副作用（期间结转状态未变）',
  carryBefore.body?.data?.carried === carryAfter.body?.data?.carried,
  `${carryBefore.body?.data?.carried} → ${carryAfter.body?.data?.carried}`
)

// ============================================================
section('G4 金额 / 数量入参边界（D3）')
const poBase = { supplier_id: supplier.id, warehouse_id: wh.id, items: [] }
const poItem = (over = {}) => ({ sku_id: sku.id, qty: 1, price: 10, ...over })

const bad = [
  ['采购单价 -5', poItem({ price: -5 })],
  ['采购单价 "-5"', poItem({ price: '-5' })],
  ['采购单价 0（允许）', poItem({ price: 0 }), 200],
  ['采购单价 "abc"', poItem({ price: 'abc' })],
  ['采购单价 "NaN"', poItem({ price: 'NaN' })],
  ['采购单价 "Infinity"', poItem({ price: 'Infinity' })],
  ['采购单价 "1e3"（只接受十进制字面量）', poItem({ price: '1e3' })],
  ['采购单价 1.005（3 位小数）', poItem({ price: 1.005 })],
  ['采购数量 0', poItem({ qty: 0 })],
  ['采购数量 -1', poItem({ qty: -1 })],
  ['采购数量 1.00005（5 位小数）', poItem({ qty: 1.00005 })],
  ['采购数量 "2"（字符串数字可接受）', poItem({ qty: '2' }), 200],
  ['税率 101', poItem({ tax_rate: 101 })],
  ['税率 -1', poItem({ tax_rate: -1 })]
]
for (const [label, item, want] of bad) {
  const r = await api('POST', '/api/purchase/orders', { token: purchaseJwt, body: { ...poBase, items: [item] } })
  ok(`POST /api/purchase/orders ${label} → ${want || 400}`, r.status === (want || 400), `实际 ${r.status} ${JSON.stringify(r.body?.message || '')}`)
}

const soOk = { channel: 'dealer', dealer_id: soDealer.dealer_id, items: [poItem()] }
const salesBad = [
  ['销售单价 -5', { ...soOk, items: [poItem({ price: -5 })] }],
  ['销售数量 0', { ...soOk, items: [poItem({ qty: 0 })] }],
  ['运费 -1', { ...soOk, freight: -1 }],
  ['整单折扣 -1', { ...soOk, discount_amount: -1 }],
  ['折扣超过货值（应收为负）', { ...soOk, items: [poItem({ qty: 1, price: 10 })], discount_amount: 999 }]
]
for (const [label, body] of salesBad) {
  const r = await api('POST', '/api/sales/orders', { token: salesJwt, body })
  ok(`POST /api/sales/orders ${label} → 400`, r.status === 400, `实际 ${r.status} ${JSON.stringify(r.body?.message || '')}`)
}

// 改单入口必须与建单同样严（"只在 create 上拦"等于没拦）
const draft = one("SELECT id FROM sales_orders WHERE status='draft' ORDER BY id LIMIT 1")
if (draft) {
  const r = await api('PUT', `/api/sales/orders/${draft.id}`, { token: salesJwt, body: { items: [poItem({ price: -5 })] } })
  ok('PUT /api/sales/orders/:id 负价 → 400（改单入口同样拦）', r.status === 400, `实际 ${r.status}`)
}
const poDraft = one("SELECT id FROM purchase_orders WHERE status='draft' ORDER BY id LIMIT 1")
if (poDraft) {
  const r = await api('PUT', `/api/purchase/orders/${poDraft.id}`, { token: purchaseJwt, body: { items: [poItem({ price: -5 })] } })
  ok('PUT /api/purchase/orders/:id 负价 → 400（改单入口同样拦）', r.status === 400, `实际 ${r.status}`)
}

// 库里不该有负金额单据 —— 这是"落库前最后一道闸"存在的意义
const negPo = one('SELECT COUNT(*) c FROM purchase_orders WHERE total_amount < 0').c
const negSo = one('SELECT COUNT(*) c FROM sales_orders WHERE receivable_amount < 0').c
ok('全库无负金额采购单', negPo === 0, `实际 ${negPo} 张`)
ok('全库无负应收销售单', negSo === 0, `实际 ${negSo} 张`)

// ============================================================
section('G5 MCP：tools 与 resources 走同一套白黑名单（D4-4d）')
async function issueToken(name, extra) {
  const r = await api('POST', '/api/mcp/tokens', { token: adminJwt, body: { name, scopes: 'read,write,danger', ...extra } })
  return r.body?.data?.token
}
const tkAllow = await issueToken('守卫·白名单', { allow_tools: ['master.search_products', 'report.dashboard_kpi'] })
const tkDeny = await issueToken('守卫·黑名单', { deny_tools: ['inventory.stock_alert'] })
const tkWriteA = await issueToken('守卫·事务A', { scopes: 'read,write' })
const tkWriteB = await issueToken('守卫·事务B', { scopes: 'read,write' })
const tkDangerB = await issueToken('守卫·全权B')
ok('五类守卫 Token 签发成功', !!(tkAllow && tkDeny && tkWriteA && tkWriteB && tkDangerB))

let seq = 0
async function mcp(method, params, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // MCP 端点不登录，行业由 x-industry 头解析（再退到 Token 自带的行业）
      'x-industry': INDUSTRY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...extraHeaders
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++seq, method, params })
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}
const isErr = (r) => !!r.body.error || r.body.result?.isError === true
const textOf = (r) => {
  const t = r.body?.result?.content?.[0]?.text ?? r.body?.error?.message
  if (t === undefined) return undefined
  try {
    return JSON.parse(t)
  } catch {
    return t
  }
}

// 白名单：不在名单里的工具，其"资源形态"同样拿不到
const alTool = await mcp('tools/call', { name: 'inventory.stock_alert', arguments: {} }, tkAllow)
ok('白名单外的 tools/call 被拒', isErr(alTool), String(textOf(alTool)?.error))
const alRes = await mcp('resources/read', { uri: 'gml://inventory/alert' }, tkAllow)
ok('白名单外的 resources/read 同样被拒（原来照样返回数据）', isErr(alRes), JSON.stringify(alRes.body).slice(0, 160))
const alMeta = await mcp('resources/read', { uri: 'gml://meta/params' }, tkAllow)
ok('白名单外的直读资源（inv_params）也被拒（原来连映射表都不经）', isErr(alMeta), JSON.stringify(alMeta.body).slice(0, 160))
const alKpi = await mcp('resources/read', { uri: 'gml://dashboard/kpi' }, tkAllow)
ok('白名单内的 resources/read 正常可用', !isErr(alKpi) && (alKpi.body.result?.contents?.[0]?.text || '').length > 10)
const alList = await mcp('resources/list', {}, tkAllow)
ok(
  'resources/list 只列本令牌拿得到的资源',
  (alList.body.result?.resources || []).every((x) => x.uri === 'gml://dashboard/kpi'),
  JSON.stringify((alList.body.result?.resources || []).map((x) => x.uri))
)

// 黑名单：同一件事在两个入口上判定一致
const dnTool = await mcp('tools/call', { name: 'inventory.stock_alert', arguments: {} }, tkDeny)
ok('黑名单内的 tools/call 被拒', isErr(dnTool) && textOf(dnTool)?.error === 'TOOL_DENIED', String(textOf(dnTool)?.error))
const dnRes = await mcp('resources/read', { uri: 'gml://inventory/alert' }, tkDeny)
ok('黑名单内的 resources/read 同样被拒', isErr(dnRes) && dnRes.body?.error?.message?.includes('禁止'), JSON.stringify(dnRes.body).slice(0, 160))
const dnList = await mcp('resources/list', {}, tkDeny)
ok('黑名单资源不出现在 resources/list', !(dnList.body.result?.resources || []).some((x) => x.uri === 'gml://inventory/alert'))
const dnMeta = await mcp('resources/read', { uri: 'gml://meta/params' }, tkDeny)
ok('黑名单只挡指定工具，其他资源不受牵连', !isErr(dnMeta), JSON.stringify(dnMeta.body).slice(0, 160))

// ============================================================
section('G6 MCP：幂等键不再"跨令牌跨载荷"命中（D4-4e）')
const K = `guard-idem-${Date.now()}`
const IN_BATCH = `GUARD-IN-${Date.now()}`
const inArgs = { warehouse_id: wh.id, sku_id: sku.id, qty: 1, unit_cost: 1, batch_no: IN_BATCH, idempotency_key: K }
const i1 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: inArgs }, tkWriteA)
ok('首次执行成功', !isErr(i1), JSON.stringify(i1.body).slice(0, 160))
const i2 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { ...inArgs, qty: 2 } }, tkWriteA)
ok('同令牌 + 同 key + 不同载荷 → 冲突（不命中旧结果）', isErr(i2) && textOf(i2)?.error === 'IDEMPOTENCY_CONFLICT', String(textOf(i2)?.error))
const i3 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: inArgs }, tkWriteB)
ok('不同令牌 + 同 key + 同载荷 → 冲突', isErr(i3) && textOf(i3)?.error === 'IDEMPOTENCY_CONFLICT', String(textOf(i3)?.error))
const i4 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: inArgs }, tkWriteA)
ok('同令牌 + 同 key + 同载荷 → 命中首次结果（幂等重放仍有效）', i4.body.result?._idempotent_replay === true, JSON.stringify(i4.body).slice(0, 160))

// ============================================================
section('G7 MCP：确认单绑定与一次性（D4-4b / 4c）')
const stockRow = one("SELECT warehouse_id, sku_id FROM inventory_stocks WHERE qty_on_hand > 0 ORDER BY id LIMIT 1")
const ADJ_BATCH = `GUARD-ADJ-${Date.now()}`
const adjArgs = {
  warehouse_id: stockRow.warehouse_id,
  sku_id: stockRow.sku_id,
  batch_no: ADJ_BATCH,
  delta: 1,
  reason: '守卫回归：确认单一次性验证'
}
const c1 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkWriteA)
ok('事务令牌调高危工具被拒（级别不足）', isErr(c1) && textOf(c1)?.error === 'SCOPE_DENIED', String(textOf(c1)?.error))

const c2 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDeny)
const cfm = textOf(c2)?.confirm_token
ok('高危工具返回待确认单', textOf(c2)?.status === 'confirmation_required' && !!cfm, JSON.stringify(c2.body).slice(0, 160))

const appr = await api('POST', `/mcp/confirmations/${cfm}/approve`, { token: financeJwt })
ok('由他人（finance）批准成功', appr.body?.data?.status === 'confirmed', JSON.stringify(appr.body).slice(0, 160))

// 4c：走 header 传递确认单 —— 原来这条路径下确认单永不置 used，可以无限重放
const c3 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDeny, { 'x-confirm-token': cfm })
ok('用 x-confirm-token 头执行成功', !isErr(c3), JSON.stringify(c3.body).slice(0, 200))
const confRow = one('SELECT status, used_at, used_by FROM mcp_confirmations WHERE confirm_token=?', cfm)
ok('确认单被实际置为 used（header 方式也置 used）', confRow?.status === 'used' && !!confRow.used_at, JSON.stringify(confRow))
ok('确认单记录了执行人（used_by）', !!confRow?.used_by, JSON.stringify(confRow))

const c4 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDeny, { 'x-confirm-token': cfm })
ok('同一确认单第二次执行（header 重放）被拒', isErr(c4), JSON.stringify(c4.body).slice(0, 160))

// 4b：换一个令牌执行同一张确认单
const c5 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDeny)
const cfm2 = textOf(c5)?.confirm_token
ok('再次发起得到一张待确认单', !!cfm2, JSON.stringify(c5.body).slice(0, 160))

// 4a：申请人本人 / 无权限角色都不能批准（趁这张单还是 pending，资格判据先答）
const selfApprove = await api('POST', `/mcp/confirmations/${cfm2}/approve`, { token: adminJwt })
ok('申请人本人批准自己的确认单 → 403（原来 200）', selfApprove.status === 403, `${selfApprove.status} ${JSON.stringify(selfApprove.body).slice(0, 120)}`)
const viewerApprove = await api('POST', `/mcp/confirmations/${cfm2}/approve`, { token: viewerJwt })
ok('viewer 批准 → 403（原来 200）', viewerApprove.status === 403, `${viewerApprove.status}`)
const dealerApprove = await api('POST', `/mcp/confirmations/${cfm2}/approve`, { token: tokDealerA })
ok('经销商批准 → 403（外部主体不得放行高危动作）', dealerApprove.status === 403, `${dealerApprove.status}`)

const appr2 = await api('POST', `/mcp/confirmations/${cfm2}/approve`, { token: financeJwt })
ok('换他人批准成功', appr2.body?.data?.status === 'confirmed', JSON.stringify(appr2.body).slice(0, 140))

const c6 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm2 } }, tkDangerB)
ok(
  '另一个同级别令牌执行同一张确认单 → 拒绝（确认单绑令牌）',
  isErr(c6) && textOf(c6)?.error === 'CONFIRM_TOKEN_MISMATCH',
  `${textOf(c6)?.error} / ${JSON.stringify(c6.body).slice(0, 140)}`
)
const c6b = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm2 } }, tkWriteA)
ok('级别不足的令牌即使持有效确认单也被拒', isErr(c6b) && textOf(c6b)?.error === 'SCOPE_DENIED', String(textOf(c6b)?.error))

// ============================================================
// G8 流转入口闸门（A01）
//
// 缺陷原形：`POST /api/docflow/transition` 传 doc_type + id + action 就能改任何单据的状态。
// 它只有 requireAuth，而内核只做「校验边 → 改状态 → 写留痕」—— **不知道这条边有没有业务后果**。
// 于是可以造出「状态对了、账不对」的单据：
//   SO 直接 ship（库存没出）· RCP 直接 confirm（应收没核销）· MR 直接 issue（成本凭空少一截）。
// 这些单不报错、看起来正常，而所有下游报表都建立在这个状态上。
//
// 这里按「矩阵」验三件事：
//   ① 有后果且没有归属服务的单据 → 通用入口**拒绝**，且**什么都没发生**（状态与留痕都不变）
//   ② 有归属服务的单据（OC）→ 通用入口**委托给同一段领域代码**，而不是只改状态
//   ③ 权限门与越权判定在**两个入口上是同一份判据**（不是各写一套）
section('G8 流转入口闸门：通用入口不驱动有业务后果的动作（A01）')

/** 该单据类型在"当前数据里真的存在"的一条 danger 边（挑不到返回 null） */
function pickDangerEdge(docType) {
  const t = one('SELECT table_name, status_field FROM doc_types WHERE code=?', docType)
  if (!t) return null
  const sf = t.status_field || 'status'
  for (const e of all('SELECT action, from_state FROM doc_actions WHERE doc_type=? AND is_danger=1 ORDER BY sort_order', docType)) {
    try {
      const row = one(`SELECT id FROM ${t.table_name} WHERE ${sf}=? ORDER BY id LIMIT 1`, e.from_state)
      if (row) return { id: row.id, action: e.action, fromState: e.from_state, table: t.table_name, sf }
    } catch { /* 表可能不存在 */ }
  }
  return null
}

// --- 8a 策略表不变量：拒绝必须是"声明过的"拒绝，而不是"忘了写" ---
const typeCount = one('SELECT COUNT(*) c FROM doc_types').c
const policyCount = one('SELECT COUNT(*) c FROM doc_transition_policy').c
ok(`每个单据类型都有流转策略行（${policyCount}/${typeCount}）`, policyCount === typeCount, `${policyCount} vs ${typeCount}`)
const allowedGeneric = all('SELECT doc_type FROM doc_transition_policy WHERE allow_generic=1 ORDER BY doc_type')
ok(
  '放开通用入口的是显式声明的少数派（当前应为空）',
  allowedGeneric.length === 0,
  allowedGeneric.map((r) => r.doc_type).join(',') || '空'
)
const noOwner = one("SELECT COUNT(*) c FROM doc_transition_policy WHERE effect_owner IS NULL AND allow_generic=0").c
ok('没有"既不放开、又没归属入口"的策略行（否则报错指不了路）', noOwner === 0, `实际 ${noOwner} 行`)
const polOrphan = one(
  `SELECT COUNT(*) c FROM doc_transition_policy p
    WHERE NOT EXISTS (SELECT 1 FROM doc_types t WHERE t.code=p.doc_type)`
).c
ok('策略表没有指向未注册单据类型的行', polOrphan === 0, `孤儿 ${polOrphan}`)

// --- 8b 矩阵：非归属类型 × danger 边 → 通用入口一律拒绝，且状态与留痕都不变 ---
const OWNED = new Set(['PRQ', 'PI', 'PST', 'PAY', 'OC']) // 代码里登记了效果归属的类型
const eventsBefore = one('SELECT COUNT(*) c FROM doc_events').c
const testedTypes = []
const wrongCode = []
const noPointer = []
const mutated = []
for (const t of all('SELECT code FROM doc_types ORDER BY sort_order')) {
  if (OWNED.has(t.code)) continue
  const e = pickDangerEdge(t.code)
  if (!e) continue
  testedTypes.push(`${t.code}.${e.action}`)
  const r = await api('POST', '/api/docflow/transition', {
    token: adminJwt,
    body: { doc_type: t.code, id: e.id, action: e.action }
  })
  const code = r.body?.detail?.code || r.body?.error
  if (r.status !== 409 || code !== 'EFFECT_REQUIRES_BUSINESS_API') wrongCode.push(`${t.code}.${e.action}→${r.status}/${code}`)
  // 指路消息里必须真的写出业务入口，否则"拒绝"等于把坑丢给调用方
  if (!String(r.body?.detail?.entry || '').trim()) noPointer.push(`${t.code}.${e.action}`)
  const after = one(`SELECT ${e.sf} s FROM ${e.table} WHERE id=?`, e.id)?.s
  if (after !== e.fromState) mutated.push(`${t.code}#${e.id} ${e.fromState}→${after}`)
}
ok(`矩阵覆盖到足够的单据类型（${testedTypes.length} 类）`, testedTypes.length >= 15, testedTypes.join(' '))
ok('通用入口对有后果的 danger 边一律 409 效果归属（EFFECT_REQUIRES_BUSINESS_API）', wrongCode.length === 0, wrongCode.slice(0, 8).join(' | '))
ok('拒绝时给出了应当走哪个业务入口', noPointer.length === 0, noPointer.slice(0, 8).join(' | '))
ok('被拒的请求没有改动任何单据状态（拒绝 = 什么都没发生）', mutated.length === 0, mutated.slice(0, 6).join(' | '))
ok('被拒的请求没有写入任何流转留痕', one('SELECT COUNT(*) c FROM doc_events').c === eventsBefore)

// --- 8c 委托：有归属服务的单据走通用入口 = 走正门那一段代码 ---
// 判据要能"分辨裸状态翻转"：OC.allocate 的领域实现会写 ship_warehouse_id / ship_warehouse，
// 而内核 applyTransition 只会改 status。所以"分仓字段被写入"就是"没有退化成裸翻转"的证据。
// 本段会改演示数据，所以先快照、后还原（用可写连接）—— 测试必须能重复跑。
rw.pragma('busy_timeout = 8000')
const ocApproved = one(
  "SELECT id, status, ship_warehouse_id, ship_warehouse, allocate_note, updated_at FROM oc_orders WHERE status='approved' ORDER BY id LIMIT 1"
)
ok('存在可委托的订货单样本（OC approved）', !!ocApproved, ocApproved ? `#${ocApproved.id}` : '无')
if (ocApproved) {
  const evCount = one("SELECT COUNT(*) c FROM doc_events WHERE doc_type='OC' AND doc_id=?", ocApproved.id).c
  const evMax = one("SELECT COALESCE(MAX(id),0) m FROM doc_events WHERE doc_type='OC' AND doc_id=?", ocApproved.id).m
  const r = await api('POST', '/api/docflow/transition', {
    token: adminJwt,
    body: { doc_type: 'OC', id: ocApproved.id, action: 'allocate' }
  })
  const after = one('SELECT status, ship_warehouse_id, ship_warehouse FROM oc_orders WHERE id=?', ocApproved.id)
  ok('通用入口对 OC.allocate → 200（委托成功，不是 409）', r.status === 200, `${r.status} ${JSON.stringify(r.body?.detail || r.body?.message || '').slice(0, 120)}`)
  ok('状态已前进到 allocated', after?.status === 'allocated', `实际 ${after?.status}`)
  ok(
    '分仓字段被写入（证明执行的是领域服务，不是裸改状态）',
    after?.ship_warehouse_id != null && !!after?.ship_warehouse,
    JSON.stringify(after)
  )
  ok('留痕记录了这次流转', one("SELECT COUNT(*) c FROM doc_events WHERE doc_type='OC' AND doc_id=?", ocApproved.id).c === evCount + 1)

  // 还原：本用例改了演示数据，必须自己擦干净
  rw.prepare(
    'UPDATE oc_orders SET status=?, ship_warehouse_id=?, ship_warehouse=?, allocate_note=?, updated_at=? WHERE id=?'
  ).run(ocApproved.status, ocApproved.ship_warehouse_id, ocApproved.ship_warehouse, ocApproved.allocate_note, ocApproved.updated_at, ocApproved.id)
  rw.prepare("DELETE FROM doc_events WHERE doc_type='OC' AND doc_id=? AND id>?").run(ocApproved.id, evMax)
  const restored = one('SELECT status, ship_warehouse_id FROM oc_orders WHERE id=?', ocApproved.id)
  ok(
    '用例自还原（可重复跑）',
    restored?.status === ocApproved.status && restored?.ship_warehouse_id === ocApproved.ship_warehouse_id,
    JSON.stringify(restored)
  )
}

// --- 8d 两个入口同一判据：功能权限门 ---
const prqApr = (() => {
  const t = one("SELECT table_name, status_field FROM doc_types WHERE code='PRQ'")
  for (const e of all("SELECT from_state FROM doc_actions WHERE doc_type='PRQ' AND action='approve'")) {
    const row = one(`SELECT id FROM ${t.table_name} WHERE ${t.status_field || 'status'}=? ORDER BY id LIMIT 1`, e.from_state)
    if (row) return { id: row.id, fromState: e.from_state }
  }
  return null
})()
ok('存在可审批的请购单样本', !!prqApr, prqApr ? `#${prqApr.id}（${prqApr.fromState}）` : '无')
if (prqApr) {
  const g = await api('POST', '/api/docflow/transition', { token: viewerJwt, body: { doc_type: 'PRQ', id: prqApr.id, action: 'approve' } })
  const b = await api('POST', `/api/purchase/requisitions/${prqApr.id}/approve`, { token: viewerJwt, body: {} })
  const gc = g.body?.detail?.code || g.body?.error
  const bc = b.body?.detail?.code || b.body?.error
  ok('viewer 走通用入口 → 403 PERM_DENIED（原来 200）', g.status === 403 && gc === 'PERM_DENIED', `${g.status}/${gc}`)
  ok('viewer 走业务入口 → 403 PERM_DENIED', b.status === 403 && bc === 'PERM_DENIED', `${b.status}/${bc}`)
  ok('两个入口返回同一个业务码（同一份判据）', gc === bc, `${gc} vs ${bc}`)
  const s = one('SELECT status FROM purchase_requisitions WHERE id=?', prqApr.id)?.status
  ok('两次拒绝都没有改变单据状态', s === prqApr.fromState, `${prqApr.fromState}→${s}`)
}

// --- 8e 越权：订货中心按 customer_id 判"是不是我的单"，两个入口同判据 ---
const ocCust = one(
  "SELECT c.id, c.source_id FROM oc_customers c WHERE c.source_type='dealer' AND EXISTS (SELECT 1 FROM oc_orders o WHERE o.customer_id=c.id) ORDER BY c.id LIMIT 1"
)
const tokDealerMine = ocCust
  ? forge({ uid: makeProbeUser({ username: 'guard_oc_dealer', role: 'dealer', dealerId: ocCust.source_id }), username: 'guard_oc_dealer', role: 'dealer', name: '守卫·订货方本人' })
  : null
const ocOther = one('SELECT id, status, customer_id FROM oc_orders WHERE customer_id<>? ORDER BY id LIMIT 1', ocCust?.id ?? -1)
ok('存在"别人家的"订货单样本（越权用例的前提）', !!ocOther, ocOther ? `#${ocOther.id} customer=${ocOther.customer_id}` : '无')
if (ocOther && tokDealerMine) {
  const g = await api('POST', '/api/docflow/transition', { token: tokDealerMine, body: { doc_type: 'OC', id: ocOther.id, action: 'submit' } })
  const b = await api('POST', `/api/order-center/orders/${ocOther.id}/submit`, { token: tokDealerMine, body: {} })
  ok('经销商走通用入口动别人的订货单 → 403', g.status === 403, `${g.status} ${JSON.stringify(g.body?.detail || g.body?.message || '').slice(0, 110)}`)
  ok('经销商走业务入口动别人的订货单 → 403（原来只有 requireAuth）', b.status === 403, `${b.status} ${JSON.stringify(b.body?.detail || b.body?.message || '').slice(0, 110)}`)
  const s = one('SELECT status FROM oc_orders WHERE id=?', ocOther.id)?.status
  ok('两次拒绝都没有改变别人订单的状态', s === ocOther.status, `${ocOther.status}→${s}`)
}
if (tokDealerMine) {
  const ocMine = one('SELECT id, status FROM oc_orders WHERE customer_id=? ORDER BY id LIMIT 1', ocCust.id)
  ok('存在自己的订货单样本', !!ocMine, ocMine ? `#${ocMine.id}` : '无')
  if (ocMine) {
    const g = await api('POST', '/api/docflow/transition', { token: tokDealerMine, body: { doc_type: 'OC', id: ocMine.id, action: 'submit' } })
    ok('经销商动自己的订货单不被越权判定挡住（不是 403）', g.status !== 403, `${g.status}`)
  }
}

// --- 8f 外部主体不得驱动内部单据域（与"能不能看"同源，按模块判定） ---
const poDraftG8 = one("SELECT id FROM purchase_orders WHERE status='draft' ORDER BY id LIMIT 1")
ok('存在采购草稿单样本', !!poDraftG8, poDraftG8 ? `#${poDraftG8.id}` : '无')
if (poDraftG8) {
  const g = await api('POST', '/api/docflow/transition', { token: tokDealerA, body: { doc_type: 'PO', id: poDraftG8.id, action: 'submit' } })
  ok('经销商走通用入口提交采购单 → 403（内部单据域对外部主体关闭）', g.status === 403, `${g.status} ${JSON.stringify(g.body?.detail || g.body?.message || '').slice(0, 120)}`)
  const s = one('SELECT status FROM purchase_orders WHERE id=?', poDraftG8.id)?.status
  ok('拒绝后采购单状态未变', s === 'draft', `实际 ${s}`)
}

// ============================================================
// G9 MCP：组织越界（A03）
//
// 缺陷原形：列表查询有 `orgFilter`，**写路径没有**。
// 写工具的货主来自调用方传参 —— `args.owner_org_id ?? ctx.orgId`，
// 显式传一个不属于本令牌子树的组织时**直接采信**。
// 验收侧独立复现：令牌 org=5 调 `inventory.stock_in` 传 `owner_org_id=3` → 成功落库。
// 也就是「我只能看 5 号组织，但能往 3 号组织里入库」。
//
// 这里覆盖三件事：① 写路径的货主/仓库闸门；② 列表与汇总的组织过滤；③ 全局令牌行为不回归。
section('G9 MCP：组织越界（A03）')

// 造一个**绑定了组织**的令牌：scope 由该组织的子树算出（buildContext）
const whOrgRow = one("SELECT id, org_id, default_owner_org_id FROM warehouses WHERE org_id IS NOT NULL ORDER BY id LIMIT 1")
ok('存在带组织的仓库样本（越界用例的前提）', !!whOrgRow, JSON.stringify(whOrgRow))
const tokOrg = whOrgRow ? await issueToken('守卫·组织边界', { org_id: whOrgRow.org_id, scopes: 'read,write,danger' }) : null
ok('组织受限令牌签发成功', !!tokOrg)

if (tokOrg && whOrgRow) {
  const scopeOrgIds = all("SELECT id FROM orgs WHERE id=? OR path LIKE (SELECT path FROM orgs WHERE id=?) || '%'", whOrgRow.org_id, whOrgRow.org_id).map((r) => r.id)
  ok(`令牌范围解析出 ${scopeOrgIds.length} 个组织`, scopeOrgIds.length > 0)
  const scopedWhIds = all(`SELECT id FROM warehouses WHERE org_id IN (${scopeOrgIds.map(() => '?').join(',')})`, ...scopeOrgIds).map((r) => r.id)
  const outWh = one(
    `SELECT id, org_id FROM warehouses WHERE org_id IS NOT NULL AND id NOT IN (${scopedWhIds.length ? scopedWhIds.map(() => '?').join(',') : 'NULL'}) ORDER BY id LIMIT 1`,
    ...scopedWhIds
  )
  const outOrg = one(
    `SELECT id FROM orgs WHERE id NOT IN (${scopeOrgIds.map(() => '?').join(',')}) ORDER BY id LIMIT 1`,
    ...scopeOrgIds
  )
  ok('存在范围外的仓库与组织样本', !!outWh && !!outOrg, `仓#${outWh?.id}(org ${outWh?.org_id}) / org#${outOrg?.id}`)
  const skuId = one('SELECT id FROM product_skus ORDER BY id LIMIT 1').id
  const batchIn = `GUARD-A03-${Date.now()}`

  // 9a：货主越界 —— 这就是验收侧复现的那条路径
  const stockBefore = one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q
  const badOwner = await mcp('tools/call', {
    name: 'inventory.stock_in',
    arguments: { warehouse_id: scopedWhIds[0] ?? whOrgRow.id, sku_id: skuId, qty: 1, unit_cost: 1, batch_no: batchIn, owner_org_id: outOrg.id, idempotency_key: `a03-${batchIn}-owner` }
  }, tokOrg)
  ok(
    'stock_in 传范围外的货主组织 → 403 ORG_OUT_OF_SCOPE（原来成功落库）',
    isErr(badOwner) && textOf(badOwner)?.error === 'ORG_OUT_OF_SCOPE',
    `${textOf(badOwner)?.error} / ${JSON.stringify(textOf(badOwner)?.detail || '').slice(0, 90)}`
  )
  ok('越界入库没有产生任何库存行', one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q === stockBefore)

  // 9b：仓库越界
  const badWh = await mcp('tools/call', {
    name: 'inventory.stock_in',
    arguments: { warehouse_id: outWh.id, sku_id: skuId, qty: 1, unit_cost: 1, batch_no: batchIn, idempotency_key: `a03-${batchIn}-wh` }
  }, tokOrg)
  ok('stock_in 传范围外的仓库 → 403 ORG_OUT_OF_SCOPE', isErr(badWh) && textOf(badWh)?.error === 'ORG_OUT_OF_SCOPE', String(textOf(badWh)?.error))

  // 9a2：**正向对照**（验收侧 §27.2）—— 收紧一条门必须先跑一遍「这条门原本该放谁进来」。
  // 我把该仓的**默认货主**临时改成范围外组织，这样"修复前/后"能真的区分开：
  //   · 修复前：`assertWarehouseInScope` 用 `resolveOwnerOrg(wh, null)` = 这个**本次根本不用**的
  //     默认货主来判定 ⇒ 「范围内仓 + 范围内显式货主」被误拒（ORG_OUT_OF_SCOPE）；
  //   · 修复后：判定对象是「本次实际要用的货主」= 显式传的那个 ⇒ 成功。
  // 同一个仓、同一张令牌，只差"传不传货主"，一放一拒 —— 这才叫对照。
  const inWh = scopedWhIds.length ? one('SELECT id, org_id, default_owner_org_id FROM warehouses WHERE id=?', scopedWhIds[0]) : null
  ok('存在范围内的仓库样本（正向对照的前提）', !!inWh, JSON.stringify(inWh))
  if (inWh) {
    const batchOk = `GUARD-A03-OK-${Date.now()}`
    rw.prepare('UPDATE warehouses SET default_owner_org_id=? WHERE id=?').run(outOrg.id, inWh.id)
    const okIn = await mcp('tools/call', {
      name: 'inventory.stock_in',
      arguments: { warehouse_id: inWh.id, sku_id: skuId, qty: 1, unit_cost: 1, batch_no: batchOk, owner_org_id: whOrgRow.org_id, idempotency_key: `a03-ok-${batchOk}` }
    }, tokOrg)
    ok(
      '范围内仓 + 显式范围内货主 → 成功（修复前被"本次不用的默认货主"误拒）',
      !isErr(okIn),
      JSON.stringify(textOf(okIn)).slice(0, 130)
    )
    const landed = one('SELECT owner_org_id, qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?', inWh.id, skuId, batchOk)
    ok(
      '入库落在**显式指定的货主**上（不是仓库默认货主）',
      Number(landed?.owner_org_id) === Number(whOrgRow.org_id),
      JSON.stringify(landed)
    )
    const batchBad2 = `GUARD-A03-BAD-${Date.now()}`
    const badOwner2 = await mcp('tools/call', {
      name: 'inventory.stock_in',
      arguments: { warehouse_id: inWh.id, sku_id: skuId, qty: 1, unit_cost: 1, batch_no: batchBad2, owner_org_id: outOrg.id, idempotency_key: `a03-bad2-${batchBad2}` }
    }, tokOrg)
    ok(
      '同一个仓 + 显式范围外货主 → 403（对照的另一半：不该放的仍然不放）',
      isErr(badOwner2) && textOf(badOwner2)?.error === 'ORG_OUT_OF_SCOPE',
      String(textOf(badOwner2)?.error)
    )
    ok('越界那次没有落库', !one('SELECT id FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?', inWh.id, skuId, batchBad2))
    // 还原：仓默认货主 + 本次入库产生的行（测试要能重复跑）
    rw.prepare('UPDATE warehouses SET default_owner_org_id=? WHERE id=?').run(inWh.default_owner_org_id, inWh.id)
    rw.prepare('DELETE FROM inventory_transactions WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?').run(inWh.id, skuId, batchOk)
    rw.prepare('DELETE FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?').run(inWh.id, skuId, batchOk)
    rw.prepare('DELETE FROM inventory_batches WHERE sku_id=? AND batch_no=?').run(skuId, batchOk)
    ok(
      'A03 正向对照：用例自还原（默认货主与本次库存行都已清）',
      !one('SELECT id FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?', inWh.id, skuId, batchOk)
    )
  }

  // 9c：货权转移两个货主都是显式传参 —— 最容易越界的工具
  const badOw = await mcp('tools/call', {
    name: 'inventory.ownership_transfer',
    arguments: {
      from_warehouse_id: scopedWhIds[0] ?? whOrgRow.id, from_owner_org_id: whOrgRow.org_id,
      to_warehouse_id: scopedWhIds[0] ?? whOrgRow.id, to_owner_org_id: outOrg.id,
      sku_id: skuId, qty: 1, idempotency_key: `a03-${batchIn}-ow`
    }
  }, tokOrg)
  ok('ownership_transfer 的调入货主越界 → 403 ORG_OUT_OF_SCOPE', isErr(badOw) && textOf(badOw)?.error === 'ORG_OUT_OF_SCOPE', String(textOf(badOw)?.error))

  // 9d：读路径也不能靠传参越界
  const badRead = await mcp('tools/call', { name: 'inventory.get_cost', arguments: { sku_id: skuId, owner_org_id: outOrg.id } }, tokOrg)
  ok('inventory.get_cost 传范围外货主 → 403 ORG_OUT_OF_SCOPE', isErr(badRead) && textOf(badRead)?.error === 'ORG_OUT_OF_SCOPE', String(textOf(badRead)?.error))

  // 9e：列表按组织过滤（原来 handler 连 ctx 都不接收）
  const poScoped = await mcp('tools/call', { name: 'purchase.list_orders', arguments: { limit: 200 } }, tokOrg)
  const poList = textOf(poScoped)?.list || []
  const poAllCount = one('SELECT COUNT(*) c FROM purchase_orders').c
  const inWhSet = new Set(scopedWhIds)
  const inStoreSet = new Set(all(`SELECT id FROM stores WHERE org_id IN (${scopeOrgIds.map(() => '?').join(',')})`, ...scopeOrgIds).map((r) => r.id))
  ok(
    '受限令牌看采购单列表：每条都在其范围内',
    poList.every((r) => (r.warehouse_id && inWhSet.has(r.warehouse_id)) || (r.target_store_id && inStoreSet.has(r.target_store_id))),
    `返回 ${poList.length} 条 / 全库 ${poAllCount} 条`
  )
  const outsidePo = one(
    `SELECT id FROM purchase_orders WHERE warehouse_id IS NOT NULL AND warehouse_id NOT IN (${scopedWhIds.length ? scopedWhIds.map(() => '?').join(',') : 'NULL'}) ORDER BY id LIMIT 1`,
    ...scopedWhIds
  )
  if (outsidePo) ok('范围外的采购单不出现在受限令牌的列表里', !poList.some((r) => r.id === outsidePo.id), `越界单 #${outsidePo.id}`)

  // 9f：汇总同样要过滤，且 A19 的列名错误必须已修（否则这里直接报 no such column）
  const sumScoped = textOf(await mcp('tools/call', { name: 'report.sales_summary', arguments: { group_by: 'channel' } }, tokOrg))
  const sumGlobal = textOf(await mcp('tools/call', { name: 'report.sales_summary', arguments: { group_by: 'channel' } }, tkWriteB))
  ok('report.sales_summary 可用（A19：原来 SUM(so.total_amount) 是不存在的列）', !!sumScoped && typeof sumScoped.total_amount === 'number', JSON.stringify(sumScoped)?.slice(0, 140))
  ok(
    '受限令牌的销售汇总不超过全局（汇总也按组织范围过滤）',
    Number(sumScoped?.total_amount ?? 0) + 1e-6 >= 0 && Number(sumScoped?.total_amount ?? 0) <= Number(sumGlobal?.total_amount ?? 0) + 1e-6,
    `受限 ${sumScoped?.total_amount} / 全局 ${sumGlobal?.total_amount}`
  )

  // 9g：追溯越界单据 → 当作不存在（报 403 等于确认"这张单存在，只是不是你的"）
  if (outsidePo) {
    const poNo = one('SELECT doc_no FROM purchase_orders WHERE id=?', outsidePo.id)?.doc_no
    const tr = await mcp('tools/call', { name: 'order.trace_document', arguments: { doc_no: poNo } }, tokOrg)
    ok('受限令牌追溯范围外的单据 → 404（不泄露存在性）', isErr(tr) && textOf(tr)?.error === 'NOT_FOUND', `${textOf(tr)?.error}`)
  }

  // 9h：全局令牌（未绑组织）行为不回归 —— 这是既有演示与测试的口径
  const poGlobal = await mcp('tools/call', { name: 'purchase.list_orders', arguments: { limit: 200 } }, tkWriteB)
  ok('未绑组织的令牌仍能看全量采购单（不回归）', (textOf(poGlobal)?.list || []).length >= poList.length, `全局 ${(textOf(poGlobal)?.list || []).length} / 受限 ${poList.length}`)
}

// ============================================================
// G10 商城 C 端身份（A16）
//
// 缺陷原形：整个 `/api/mall` 是免 token 的，"手机号即会员" —— 身份从 body/query 里取。
// 验收侧独立复现：未登录 `POST /api/mall/orders` 传一个手机号 → 200（单就成了）；
// 另一个手机号**未登录** `GET /api/mall/orders/:id` → 拿到完整订单详情。
// 手机号是**公开标识**（印在快递单上），不是凭据。
section('G10 商城 C 端：身份必须是会话，不能是手机号（A16）')

const mcA = one("SELECT phone FROM mall_customers WHERE phone GLOB '1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' ORDER BY id LIMIT 1")
const mcB = one("SELECT phone FROM mall_customers WHERE phone GLOB '1[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]' AND phone<>? ORDER BY id LIMIT 1", mcA?.phone ?? '')
ok('存在两个可登录的 C 端会员样本', !!mcA && !!mcB, `${mcA?.phone} / ${mcB?.phone}`)

const mallLogin = async (phone) => {
  const r = await api('POST', '/api/mall/login', { body: { phone, code: '1234' } })
  return r.body?.data?.token || null
}
const mk = (token, method, p, body) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-industry': INDUSTRY, ...(token ? { 'x-mall-token': token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))

if (mcA && mcB) {
  const tokenA = await mallLogin(mcA.phone)
  const tokenB = await mallLogin(mcB.phone)
  ok('C 端登录返回会话令牌（原来只返回手机号）', !!tokenA && !!tokenB)

  // 10a：未登录下单
  const anonOrder = await mk(null, 'POST', '/api/mall/orders', {
    phone: mcA.phone, receiver: '守卫', receiver_phone: mcA.phone, address: '守卫地址', items: [{ sku_id: one('SELECT id FROM product_skus ORDER BY id LIMIT 1').id, qty: 1 }]
  })
  ok('未登录下单 → 401（原来 200，单就成立了）', anonOrder.status === 401, `${anonOrder.status} ${JSON.stringify(anonOrder.body?.message || '').slice(0, 80)}`)

  // 10b：未登录读别人的订单详情
  const otherOrder = one('SELECT id, receiver_phone FROM oms_orders WHERE receiver_phone IS NOT NULL AND receiver_phone<>? ORDER BY id LIMIT 1', mcA.phone)
  ok('存在"别人的"OMS 订单样本', !!otherOrder, otherOrder ? `#${otherOrder.id}` : '无')
  if (otherOrder) {
    const anonRead = await mk(null, 'GET', `/api/mall/orders/${otherOrder.id}`)
    ok('未登录读订单详情 → 401（原来 200 且返回完整详情）', anonRead.status === 401, `${anonRead.status}`)
    const crossRead = await mk(tokenA, 'GET', `/api/mall/orders/${otherOrder.id}`)
    ok('已登录 A 读 B 的订单详情 → 404（不泄露存在性）', crossRead.status === 404, `${crossRead.status}`)
  }

  // 10c：用别人的手机号当身份 —— 服务端必须忽略请求里的 phone
  const skuX = one('SELECT id FROM product_skus ORDER BY id LIMIT 1').id
  const skuY = one('SELECT id FROM product_skus ORDER BY id LIMIT 1 OFFSET 1')?.id || skuX
  // 快照（然后精确还原）：购物车是**演示数据的一部分**，不能"清一片了事"——
  // 那会连 seed 灌进去的行一起删掉，破坏整库可复现。所以只动自己写的那几格。
  const snapRow = (phone, sku) => one('SELECT qty FROM mall_cart_items WHERE phone=? AND sku_id=?', phone, sku)
  const snapshots = [
    [mcB.phone, skuX, snapRow(mcB.phone, skuX)],
    [mcA.phone, skuY, snapRow(mcA.phone, skuY)],
    [mcB.phone, skuY, snapRow(mcB.phone, skuY)]
  ]
  rw.prepare('DELETE FROM mall_cart_items WHERE phone=? AND sku_id=?').run(mcB.phone, skuX)
  rw.prepare('INSERT INTO mall_cart_items (phone, sku_id, qty) VALUES (?,?,?)').run(mcB.phone, skuX, 7)
  const cartA = await mk(tokenA, 'GET', `/api/mall/cart?phone=${mcB.phone}`)
  ok(
    'A 的会话 + 传 B 的手机号 → 读到的是 A 的购物车（请求里的 phone 被忽略）',
    cartA.status === 200 && !(cartA.body?.data || []).some((x) => x.sku_id === skuX && x.qty === 7),
    JSON.stringify(cartA.body?.data || []).slice(0, 120)
  )
  const cartB = await mk(tokenB, 'GET', '/api/mall/cart')
  ok('B 的会话读到自己的购物车（对照：B 确实有那件货）', (cartB.body?.data || []).some((x) => x.sku_id === skuX && x.qty === 7))

  // 10d：写入也必须落在会话身份上
  rw.prepare('DELETE FROM mall_cart_items WHERE phone=? AND sku_id=?').run(mcA.phone, skuY)
  const addAsA = await mk(tokenA, 'POST', '/api/mall/cart', { phone: mcB.phone, sku_id: skuY, qty: 2 })
  const rowA = one('SELECT qty FROM mall_cart_items WHERE phone=? AND sku_id=?', mcA.phone, skuY)
  const rowB = one('SELECT qty FROM mall_cart_items WHERE phone=? AND sku_id=?', mcB.phone, skuY)
  ok('A 的会话写购物车 → 落在 A 名下（body 里的 phone 被忽略）', addAsA.status === 200 && !!rowA, JSON.stringify({ rowA }))
  ok('B 的购物车没有被别人写进去', !rowB, JSON.stringify(rowB || null))

  // 10e：会话隔离 —— 后台凭据不能当 C 端会话用
  const adminOnMall = await mk(adminJwt, 'GET', '/api/mall/cart')
  ok('后台 JWT 调 C 端接口 → 401（两套凭据不通用）', adminOnMall.status === 401, `${adminOnMall.status}`)
  const tampered = await mk(String(tokenA).slice(0, -3) + 'xyz', 'GET', '/api/mall/cart')
  ok('篡改过的 C 端令牌 → 401', tampered.status === 401, `${tampered.status}`)

  // 10f：公开页面不受影响
  const home = await mk(null, 'GET', '/api/mall/home')
  const prods = await mk(null, 'GET', '/api/mall/products')
  ok('商城首页 / 商品列表仍免登录可访问（不误伤公开页）', home.status === 200 && prods.status === 200, `${home.status}/${prods.status}`)

  // 还原：只把动过的几格恢复原样（原来是空的就删掉，原来有值就写回原值）
  for (const [phone, sku, before] of snapshots) {
    if (before == null) rw.prepare('DELETE FROM mall_cart_items WHERE phone=? AND sku_id=?').run(phone, sku)
    else rw.prepare('UPDATE mall_cart_items SET qty=? WHERE phone=? AND sku_id=?').run(before.qty, phone, sku)
  }
  ok(
    '用例自还原（购物车回到用例前状态）',
    snapshots.every(([phone, sku, before]) => {
      const now = one('SELECT qty FROM mall_cart_items WHERE phone=? AND sku_id=?', phone, sku)
      return before == null ? !now : now?.qty === before.qty
    })
  )
}

// ============================================================
// G11 预留与发货：占库要登记、发货要消费、取消要释放（A05）
//
// 缺陷原形：`reserveStock` / `releaseStock` 早就带了 `sourceDocType/sourceDocId`，
// **但没有任何调用方传过** —— `inventory_reservations` 从建成那天起一行都没写过。
// 于是预留只剩库存行上的一个 `qty_reserved` 数字：
//   · 说不出"这 10 件是替哪张单占的" ⇒ 发货时只能**重新按当前库存再拣一次**；
//   · 而"当前库存"已经不是"当时那批"（货被自己占着，free=0）⇒ 拣不到 ⇒
//     **一张 0 数量的发货单**，同时那 10 件预留**永远挂着**（幽灵预留）。
// 验收侧独立复现：库存 10、SO 10 件 confirm 后 `on_hand=10 / reserved=10`，
// 可追溯到该 SO 的 reservation 行 = 0；deliver = 200 但 `deliveredQty=0`。
section('G11 预留与发货：占库登记 / 发货消费 / 取消释放（A05）')

// 样本要挑"真的能拣出 2 件"的仓×SKU —— 不能只看 `qty_on_hand - qty_reserved`：
// 拣选还会跳过冻结/报废/过保/**检验不合格**的批次，而那些批次在库存行上照样"有货"。
// 实测踩到：质检回归（test-qc2）把某些批次判成 rejected 之后，
// 只看库存数字就会选中一个"账面上 2998 件、实际一件都拣不出来"的组合 ⇒ 确认时报库存不足。
// 所以用**拣选函数自己**来判定候选是否可用（与生产路径同一份判据）。
const stockCandidates = all(
  `SELECT s.warehouse_id, s.sku_id, SUM(s.qty_on_hand - s.qty_reserved) free
     FROM inventory_stocks s
    GROUP BY s.warehouse_id, s.sku_id
   HAVING SUM(s.qty_on_hand - s.qty_reserved) >= 5
    ORDER BY free DESC LIMIT 40`
)
let stockPick = null
for (const c of stockCandidates) {
  if (pickBatches(db, c.warehouse_id, c.sku_id, 2).shortage === 0) {
    stockPick = c
    break
  }
}
ok('存在"真的能拣出货"的仓×SKU 样本（A05 用例的前提）', !!stockPick, JSON.stringify(stockPick || stockCandidates[0]))
const soStoreId = one("SELECT id FROM stores WHERE status='active' ORDER BY id LIMIT 1")?.id

/** 建一张待确认的销售订单（守卫专用），返回 id */
async function mkOrder(qty, remark) {
  const r = await api('POST', '/api/sales/orders', {
    token: adminJwt,
    body: {
      channel: 'store', store_id: soStoreId, order_date: new Date().toISOString().slice(0, 10),
      warehouse_id: stockPick.warehouse_id,
      items: [{ sku_id: stockPick.sku_id, qty, price: 10 }],
      remark
    }
  })
  return r.body?.data?.id || null
}
const confirmOrder = (id) =>
  api('POST', `/api/sales/orders/${id}/confirm`, { token: adminJwt, body: { force: true, credit_reason: '守卫回归 A05' } })
const activeResv = (id) =>
  one("SELECT COALESCE(SUM(qty),0) q, COUNT(*) c FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=? AND status='active'", id)
const globalReserved = () => one('SELECT COALESCE(SUM(qty_reserved),0) q FROM inventory_stocks').q

if (stockPick && soStoreId) {
  const baseReserved = globalReserved()

  // --- 11a 正常闭环：确认登记预留 → 发货消费预留 ---
  const soA = await mkOrder(2, '【守卫A05-a】预留与发货闭环')
  ok('A05 用例订单已创建', !!soA, `SO#${soA}`)
  const cA = await confirmOrder(soA)
  ok('订单确认成功', cA.status === 200, JSON.stringify(cA.body?.message || '').slice(0, 120))
  const resvA = activeResv(soA)
  ok(
    '确认后登记了可追溯的预留明细（原来 0 行）',
    resvA.c > 0 && Number(resvA.q) === 2,
    JSON.stringify(resvA)
  )
  ok('全局 qty_reserved 增加了订单量（占库确实发生）', globalReserved() - baseReserved >= 2 - 1e-6, `${baseReserved} → ${globalReserved()}`)

  const dA = await api('POST', `/api/sales/orders/${soA}/deliver`, {
    token: adminJwt, body: { warehouse_id: stockPick.warehouse_id, delivery_date: new Date().toISOString().slice(0, 10) }
  })
  const delA = one('SELECT total_qty, status FROM sales_deliveries WHERE order_id=? ORDER BY id DESC LIMIT 1', soA)
  ok('发货成功', dA.status === 200, JSON.stringify(dA.body?.message || dA.body?.detail || '').slice(0, 140))
  ok('发货单数量 > 0（原来落一张 0 数量的发货单）', Number(delA?.total_qty || 0) > 0, JSON.stringify(delA))
  ok('订单状态推进到已发货', one('SELECT status FROM sales_orders WHERE id=?', soA)?.status === 'shipped', one('SELECT status FROM sales_orders WHERE id=?', soA)?.status)
  const resvA2 = activeResv(soA)
  ok('发货后该单的预留被消费掉（不留幽灵预留）', resvA2.c === 0, JSON.stringify(resvA2))
  ok('全局 qty_reserved 回到用例前基线', Math.abs(globalReserved() - baseReserved) < 1e-6, `${baseReserved} → ${globalReserved()}`)

  // --- 11b 两订单竞争同一批货：后来者必须被拒，且不抢先来者的预留 ---
  // 这里同样要用"真的能拣出多少"而不是库存行的差额（见上面样本选择的说明）
  const freeNow = pickBatches(db, stockPick.warehouse_id, stockPick.sku_id, 1e9).picks.reduce(
    (n, p) => n + Number(p.qty || 0), 0
  )
  const grab = Math.floor(Number(freeNow))
  if (grab >= 2) {
    const soB1 = await mkOrder(grab, '【守卫A05-b1】占满库存')
    const cB1 = await confirmOrder(soB1)
    ok(`先来的订单占满可用量（${grab}）`, cB1.status === 200, JSON.stringify(cB1.body?.message || '').slice(0, 120))
    const soB2 = await mkOrder(grab, '【守卫A05-b2】抢同一批货')
    const cB2 = await confirmOrder(soB2)
    ok('后来的订单确认 → 400 库存不足（不抢先到者的预留）', cB2.status === 400, `${cB2.status} ${JSON.stringify(cB2.body?.message || '').slice(0, 100)}`)
    ok('先到者的预留未被抢走', Number(activeResv(soB1).q) === grab, JSON.stringify(activeResv(soB1)))
    // 清场：取消先到者，释放预留
    const xB1 = await api('POST', `/api/sales/orders/${soB1}/cancel`, { token: adminJwt, body: { reason: '守卫回归清场' } })
    ok('取消先到者并释放预留', xB1.status === 200 && activeResv(soB1).c === 0, `${xB1.status} ${JSON.stringify(activeResv(soB1))}`)
    ok('清场后 qty_reserved 回到基线', Math.abs(globalReserved() - baseReserved) < 1e-6, `${baseReserved} → ${globalReserved()}`)
  } else {
    ok('可用量不足 2，跳过竞争用例（样本库库存偏低）', true, `free=${freeNow}`)
  }

  // --- 11c 取消按明细释放（不是"再拣一次"） ---
  const soC = await mkOrder(1, '【守卫A05-c】取消释放')
  await confirmOrder(soC)
  ok('取消前该单有 active 预留', activeResv(soC).c > 0, JSON.stringify(activeResv(soC)))
  const xC = await api('POST', `/api/sales/orders/${soC}/cancel`, { token: adminJwt, body: { reason: '守卫回归 A05-c' } })
  ok('取消成功', xC.status === 200, `${xC.status}`)
  ok('取消后该单 active 预留归零', activeResv(soC).c === 0, JSON.stringify(activeResv(soC)))
  ok('取消后 qty_reserved 回到基线', Math.abs(globalReserved() - baseReserved) < 1e-6, `${baseReserved} → ${globalReserved()}`)

  // --- 11d 没有可发的货时**必须拒绝**，不许落 0 数量发货单 ---
  const soD = await mkOrder(1, '【守卫A05-d】无可发量')
  await confirmOrder(soD)
  // 注入：把该单的预留"清空"（模拟预留被外部路径耗尽 —— 这正是原来 deliver 走到的现场）。
  // 注意要**同时**把库存行的 qty_reserved 减掉：预留的两半（明细 + 库存行数字）
  // 必须一起变，否则注入本身就制造了一处"数字对不上明细"的脏数据，
  // 用例结束时的基线断言会因为注入而失败（第一版就是这样，红在最后一条）。
  const resvRows = all(
    "SELECT warehouse_id, sku_id, batch_no, qty FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=? AND status='active'",
    soD
  )
  for (const r of resvRows) {
    rw.prepare('UPDATE inventory_stocks SET qty_reserved=MAX(qty_reserved-?,0) WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?')
      .run(Number(r.qty), r.warehouse_id, r.sku_id, r.batch_no || '')
  }
  rw.prepare("UPDATE inventory_reservations SET qty=0 WHERE source_doc_type='SO' AND source_doc_id=? AND status='active'").run(soD)
  const delBefore = one('SELECT COUNT(*) c FROM sales_deliveries WHERE order_id=?', soD).c
  const dD = await api('POST', `/api/sales/orders/${soD}/deliver`, {
    token: adminJwt, body: { warehouse_id: stockPick.warehouse_id, delivery_date: new Date().toISOString().slice(0, 10) }
  })
  ok('无货可发时发货 → 409 NOTHING_TO_SHIP', dD.status === 409, `${dD.status} ${JSON.stringify(dD.body?.message || '').slice(0, 110)}`)
  ok(
    '被拒后没有落下任何 0 数量发货单（原来落了一张"已发货、0 件"）',
    one('SELECT COUNT(*) c FROM sales_deliveries WHERE order_id=?', soD).c === delBefore
  )
  ok(
    '被拒后没有产生空出库流水',
    one("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_type='SAL_OUT' AND doc_no IN (SELECT doc_no FROM sales_deliveries WHERE order_id=?)", soD).c === 0
  )
  const xD = await api('POST', `/api/sales/orders/${soD}/cancel`, { token: adminJwt, body: { reason: '守卫回归清场' } })
  ok('清场：取消 D 单并释放', xD.status === 200, `${xD.status}`)
  ok('用例结束 qty_reserved 回到基线', Math.abs(globalReserved() - baseReserved) < 1e-6, `${baseReserved} → ${globalReserved()}`)
}

// ============================================================
// G12 货 / 债权 / 授信 / 核销 / 成本不变量（A06 / A07 / A08 / A11 / A12 / A13）
//
// 这一组缺陷的共同点：**账面上都"平"，错的是口径与归属。**
//   A06 授信按 SO 占用、却按 RCP 释放 ⇒ 还了钱额度不回来（差一笔流水，不报错）
//   A07 核销 `Math.min` 截平而不拒绝 ⇒ 用户说"我核了 600"、库里是 400
//   A08 指定订单回款被按主体 FIFO 串到另一张单 ⇒ 两张单状态都变了
//   A11 跨批次出库照抄末批单价 ⇒ 材料成本按错价算，账还平
//   A12 参数缓存不按库隔离 ⇒ 先读哪个库决定后面所有库的行为
//   A13 "指名要这个批次"绕过冻结/过保/检验 ⇒ 同一批货两套结论
section('G12 货 / 债权 / 授信 / 核销 / 成本不变量（A06–A08 / A11–A13）')

// ---------- 12a A06 + 12c A08：一次回款同时验"占用在哪释放在哪"与"只抵这一张单" ----------
const creditSo = one(
  `SELECT so.id, so.doc_no, so.dealer_id, so.store_id, so.receivable_amount, so.credit_hold, ca.id AS acc_id
     FROM sales_orders so
     JOIN credit_accounts ca
       ON ca.subject_type = CASE WHEN so.dealer_id IS NOT NULL THEN 'dealer' ELSE 'store' END
      AND ca.subject_id  = COALESCE(so.dealer_id, so.store_id)
    WHERE so.status='confirmed' AND so.credit_hold > 0 AND so.receivable_amount > 0
    ORDER BY so.id LIMIT 1`
)
ok('存在有授信占用的已确认销售订单样本（A06 前提）', !!creditSo, creditSo ? `SO#${creditSo.id}` : '无')
if (creditSo) {
  const soAr = one("SELECT * FROM ar_documents WHERE source_type='SO' AND source_id=?", creditSo.id)
  const arOpen = soAr ? Number(soAr.amount) - Number(soAr.allocated_amount) : null
  const payAmt = Math.min(1, arOpen ?? 1)
  const occSql = "SELECT COALESCE(SUM(amount),0) s FROM credit_ledger WHERE account_id=? AND source_type='SO' AND source_id=?"
  const occBefore = one(occSql, creditSo.acc_id, creditSo.id).s
  // 同主体的另一张未结应收 —— 用来验"没有被 FIFO 串过去"
  const otherAr = one(
    `SELECT * FROM ar_documents WHERE subject_type=(SELECT subject_type FROM ar_documents WHERE source_type='SO' AND source_id=?)
       AND subject_id=(SELECT subject_id FROM ar_documents WHERE source_type='SO' AND source_id=?)
       AND status IN ('open','partial') AND id<>COALESCE(?,0) ORDER BY due_date, id LIMIT 1`,
    creditSo.id, creditSo.id, soAr?.id ?? 0
  )
  const otherAllocBefore = otherAr ? Number(otherAr.allocated_amount) : null

  const pay = await api('POST', `/api/sales/orders/${creditSo.id}/payment`, {
    token: adminJwt, body: { amount: payAmt, remark: '守卫回归 A06/A08' }
  })
  ok('订单回款成功', pay.status === 200, JSON.stringify(pay.body?.message || '').slice(0, 120))
  const rcInfo = pay.body?.data?.receipt
  ok('回款回执说明了钱抵在哪张应收、多少是预收', !!rcInfo && rcInfo.ar_id != null, JSON.stringify(rcInfo))

  if (payAmt > 0.005) {
    const occAfter = one(occSql, creditSo.acc_id, creditSo.id).s
    ok(
      'A06：额度按**占用时的来源(SO)**释放（原来按 RCP 释放 ⇒ 一条流水都写不出来）',
      Number(occBefore) - Number(occAfter) > 0.005,
      `占用 ${occBefore} → ${occAfter}`
    )
  }
  if (otherAr) {
    const otherAfter = one('SELECT allocated_amount FROM ar_documents WHERE id=?', otherAr.id).allocated_amount
    ok(
      'A08：指定订单回款**只抵这一张**，同主体的另一张应收没被动过（原来按 FIFO 串过去）',
      Math.abs(Number(otherAfter) - Number(otherAllocBefore)) < 0.005,
      `AR#${otherAr.id} ${otherAllocBefore} → ${otherAfter}`
    )
  }
}

// ---------- 12b A07：核销要"拒绝"不要"截平" ----------
const arSubject = one("SELECT subject_type, subject_id FROM ar_documents WHERE status IN ('open','partial') ORDER BY id LIMIT 1")
ok('存在应收单样本（A07 前提）', !!arSubject, JSON.stringify(arSubject))
const throwawayArs = []
if (arSubject) {
  for (let i = 0; i < 2; i++) {
    const r = await api('POST', '/api/ar/documents', {
      token: adminJwt,
      body: {
        subject_type: arSubject.subject_type, subject_id: arSubject.subject_id,
        source_type: 'MANUAL', amount: 100, biz_date: new Date().toISOString().slice(0, 10),
        remark: `守卫回归 A07 临时应收 ${i + 1}`
      }
    })
    if (r.body?.data?.id) throwawayArs.push(r.body.data)
  }
  ok('临时应收单已建 2 张', throwawayArs.length === 2, throwawayArs.map((a) => a.id).join(','))
}
if (throwawayArs.length === 2) {
  const [X, Y] = throwawayArs
  const mkRc = (amount, allocations, remark) =>
    api('POST', '/api/ar/receipts', {
      token: adminJwt,
      body: { subject_type: X.subject_type, subject_id: X.subject_id, amount, allocations, remark }
    })

  const over = await mkRc(200, [{ ar_id: X.id, amount: 150 }], '守卫回归 A07 超应收')
  ok(
    '核销超过应收未结余额 → 拒绝（原来 Math.min 悄悄截平）',
    over.status === 409 && (over.body?.detail?.code || over.body?.error) === 'RC_ALLOC_EXCEEDS_AR',
    `${over.status} ${over.body?.detail?.code || over.body?.error}`
  )
  const overRc = await mkRc(50, [{ ar_id: X.id, amount: 80 }], '守卫回归 A07 超收款')
  ok(
    '分摊超过收款单金额 → 拒绝（原来能超收 700）',
    overRc.status === 409 && (overRc.body?.detail?.code || overRc.body?.error) === 'RC_ALLOC_EXCEEDS_RECEIPT',
    `${overRc.status} ${overRc.body?.detail?.code || overRc.body?.error}`
  )
  const dup = await mkRc(100, [{ ar_id: X.id, amount: 30 }, { ar_id: X.id, amount: 30 }], '守卫回归 A07 重复')
  ok(
    '同一次核销里重复同一个 ar_id → 拒绝（原来 INSERT OR REPLACE 静默合并）',
    dup.status === 400 && (dup.body?.detail?.code || dup.body?.error) === 'RC_ALLOC_DUPLICATE_AR',
    `${dup.status} ${dup.body?.detail?.code || dup.body?.error}`
  )

  // 两张草稿各抵同一张应收的 60% → 第一次确认成功、第二次必须被拒
  const d1 = await mkRc(100, [{ ar_id: Y.id, amount: 60 }], '守卫回归 A07 草稿一')
  const d2 = await mkRc(100, [{ ar_id: Y.id, amount: 60 }], '守卫回归 A07 草稿二')
  const c1 = await api('POST', `/api/ar/receipts/${d1.body?.data?.id}/confirm`, { token: adminJwt, body: {} })
  const c2 = await api('POST', `/api/ar/receipts/${d2.body?.data?.id}/confirm`, { token: adminJwt, body: {} })
  ok('两张草稿都能建（草稿上的核销只是计划）', d1.status === 200 && d2.status === 200)
  ok('第一张确认成功', c1.status === 200, JSON.stringify(c1.body?.message || '').slice(0, 110))
  ok(
    'A07：第二张确认被拒（确认那一刻才发现应收被核超，原来两张都 200 ⇒ 明细合计 160 超应收 60）',
    c2.status === 409,
    `${c2.status} ${c2.body?.detail?.code || c2.body?.error}`
  )
  const allocSum = one(
    "SELECT COALESCE(SUM(a.amount),0) s FROM receipt_allocations a JOIN receipts r ON r.id=a.receipt_id WHERE a.ar_id=? AND r.status='confirmed'",
    Y.id
  ).s
  ok('已确认核销合计没有超过应收金额（明细即真相）', Number(allocSum) <= 100 + 0.005, `合计 ${allocSum} / 应收 100`)
}

// ---------- 12d A12：库存参数缓存必须按库隔离 ----------
{
  // A12 需要**两个不同行业的库**才能证明"参数缓存按库隔离"，
  // 所以这两行刻意写死行业码 —— 但路径仍走 dbPathFor()，
  // 否则 `GML_DATA_DIR=/tmp/...` 只隔离了一半：主连接在副本、这两条还在写开发库。
  const dbA = new Database(dbPathFor('cosmetic'))
  const dbB = new Database(dbPathFor('food'))
  dbA.pragma('busy_timeout = 8000')
  dbB.pragma('busy_timeout = 8000')
  const origB = dbB.prepare("SELECT param_value v FROM inv_params WHERE param_key='pick_rule' AND scope='global'").get().v
  try {
    dbB.prepare("UPDATE inv_params SET param_value='fifo' WHERE param_key='pick_rule' AND scope='global'").run()
    clearParamCache()
    const a1 = getInvParam(dbA, 'pick_rule')
    const b1 = getInvParam(dbB, 'pick_rule')
    const a2 = getInvParam(dbA, 'pick_rule') // 交错再读一次
    const b2 = getInvParam(dbB, 'pick_rule')
    ok('A12：不同库的参数各自独立（改 B 库不影响 A 库）', String(a1) !== String(b1), `A=${a1} B=${b1}`)
    ok('A12：交错重复读结果稳定', a1 === a2 && b1 === b2, `${a1}/${a2} · ${b1}/${b2}`)
  } finally {
    dbB.prepare("UPDATE inv_params SET param_value=? WHERE param_key='pick_rule' AND scope='global'").run(origB)
    clearParamCache()
    const restored = dbB.prepare("SELECT param_value v FROM inv_params WHERE param_key='pick_rule' AND scope='global'").get().v
    ok('A12：用例自还原（B 库参数已写回原值）', String(restored) === String(origB), `${restored} vs ${origB}`)
    dbA.close()
    dbB.close()
  }
}

// ---------- 12d-bis A12b：同一 `global` 键出现多行时，读到的是**最新**那一行 ----------
// 这条不是"风格检查（有没有写 ORDER BY）"，而是**行为断言**：读到的是哪个值。
// 为什么它值一条常驻守卫：SQLite 在没有 ORDER BY 时按 rowid 升序返回，`LIMIT 1` 拿到
// **最早**那一行 ⇒ 「后来补了一行新配置」会**确定性地不生效**。这不是理论风险 ——
// 本批写 A13 的验收用例时当场踩到：插了第二行 `block_pending_qc`，读到的还是第一行，
// 参数看起来"没生效"，排查方向一度被带到"闸门没实现"上。
// 用种子里**不存在**的键做探针，避免动到任何真参数；收尾删干净。
{
  const wdb = new Database(dbPathFor('cosmetic'))
  wdb.pragma('busy_timeout = 8000')
  const PROBE = 'ACC_PARAM_ORDER_PROBE'
  try {
    wdb.prepare('DELETE FROM inv_params WHERE param_key=?').run(PROBE)
    wdb.prepare("INSERT INTO inv_params (scope,scope_value,param_key,param_value,remark) VALUES ('global',NULL,?,?,'用例·先写的旧值')").run(PROBE, 'OLD')
    wdb.prepare("INSERT INTO inv_params (scope,scope_value,param_key,param_value,remark) VALUES ('global',NULL,?,?,'用例·后写的新值')").run(PROBE, 'NEW')
    const rows = wdb.prepare("SELECT id, param_value FROM inv_params WHERE param_key=? AND scope='global' ORDER BY id").all(PROBE)
    ok(
      'A12b：造出同一 global 键的两行（rowid 升序 = 先 OLD 后 NEW）',
      rows.length === 2 && rows[0].param_value === 'OLD' && rows[1].param_value === 'NEW',
      JSON.stringify(rows)
    )
    clearParamCache(wdb)
    const got = getInvParam(wdb, PROBE, null)
    ok(
      'A12b：同一 global 键多行时读到**最新**那一行（NEW，不是最早那行 OLD）',
      got === 'NEW',
      `实际 ${JSON.stringify(got)} / 期望 "NEW"（读到 "OLD" 说明取值口径退回了 rowid 升序）`
    )
  } finally {
    wdb.prepare('DELETE FROM inv_params WHERE param_key=?').run(PROBE)
    clearParamCache(wdb)
    ok(
      'A12b：用例自还原（探针参数已删干净，没留行）',
      one('SELECT COUNT(*) c FROM inv_params WHERE param_key=?', PROBE).c === 0,
      `剩余 ${one('SELECT COUNT(*) c FROM inv_params WHERE param_key=?', PROBE).c} 行`
    )
    wdb.close()
  }
}

// ---------- 12e A11：跨批次出库的成本必须由各批次汇总 ----------
{
  // 找一个**当前没有任何库存**的 仓×SKU 组合，自己造两个不同价的批次 ——
  // 这样 FEFO 只会拣到我造的批次，且用例结束后可以精确删干净（回到用例前的状态）。
  const emptyCombo = one(
    `SELECT w.id AS warehouse_id, k.id AS sku_id
       FROM warehouses w, product_skus k
      WHERE w.status='active'
        AND NOT EXISTS (SELECT 1 FROM inventory_stocks s WHERE s.warehouse_id=w.id AND s.sku_id=k.id)
      ORDER BY w.id, k.id LIMIT 1`
  )
  ok('存在空闲的仓×SKU 组合（A11 用例前提）', !!emptyCombo, JSON.stringify(emptyCombo))
  if (emptyCombo) {
    const { warehouse_id: wId, sku_id: sId } = emptyCombo
    const tag = `GUARD-A11-${Date.now()}`
    const b1 = `${tag}-A`
    const b2 = `${tag}-B`
    try {
      applyStockIn(rw, { bizDate: '2026-10-16', docType: 'ADJ_IN', docNo: tag, warehouseId: wId, skuId: sId, batchNo: b1, qty: 5, unitCost: 10, source: 'test' })
      applyStockIn(rw, { bizDate: '2026-10-16', docType: 'ADJ_IN', docNo: tag, warehouseId: wId, skuId: sId, batchNo: b2, qty: 5, unitCost: 20, source: 'test' })
      const out = applyStockOut(rw, { bizDate: '2026-10-16', docType: 'MR', docNo: tag, warehouseId: wId, skuId: sId, qty: 10, source: 'test' })
      ok('跨批次出库返回的数量是各批次之和', Math.abs(Number(out.qty || 0) - 10) < 1e-6, `qty=${out.qty}`)
      ok(
        'A11：跨批次出库金额 = 各批次汇总（10 元×5 + 20 元×5 = 150，原来是照抄末批 200）',
        Math.abs(Number(out.outAmount || 0) - 150) < 0.01,
        `outAmount=${out.outAmount}`
      )
      ok(
        'A11：加权平均单价让 `数量 × 单价` 恰好等于总额（上游就是这么算整行成本的）',
        Math.abs(Number(out.qty) * Number(out.unitCost) - 150) < 0.01,
        `${out.qty} × ${out.unitCost} = ${Number(out.qty) * Number(out.unitCost)}`
      )
      ok(
        'A11：batches[] 逐批带上单价与金额（原来只有批次号与数量）',
        (out.batches || []).length === 2 && (out.batches || []).every((b) => b.unitCost != null && b.outAmount != null),
        JSON.stringify(out.batches)
      )
      const batchSum = (out.batches || []).reduce((n, b) => n + Number(b.outAmount || 0), 0)
      ok('A11：逐批金额之和 = 总出库额', Math.abs(batchSum - 150) < 0.01, `${batchSum}`)
    } finally {
      // 精确清理：只删这次造的那两条批次相关的行（组合原本没有任何库存，删完即回到原状）
      for (const t of ['inventory_transactions', 'stock_cost_ledger']) {
        try {
          rw.prepare(`DELETE FROM ${t} WHERE warehouse_id=? AND sku_id=?`).run(wId, sId)
        } catch { /* 表可能没有该列组合 */ }
      }
      rw.prepare('DELETE FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?').run(wId, sId)
      rw.prepare('DELETE FROM inventory_batches WHERE sku_id=? AND batch_no LIKE ?').run(sId, `${tag}%`)
      ok('A11：用例自还原（造的库存与流水已清干净）', !one('SELECT id FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?', wId, sId))
    }
  }
}

// ---------- 12f A13：指名批次也不能绕过"不可售"闸门 ----------
{
  const anyStock = one(
    "SELECT warehouse_id, sku_id, batch_no, qty_on_hand FROM inventory_stocks WHERE qty_on_hand > 0 AND IFNULL(batch_no,'')<>'' ORDER BY id LIMIT 1"
  )
  ok('存在可测的批次库存样本（A13 前提）', !!anyStock, JSON.stringify(anyStock))
  if (anyStock) {
    const had = one('SELECT qc_status FROM inventory_batches WHERE sku_id=? AND batch_no=?', anyStock.sku_id, anyStock.batch_no)
    rw.prepare("UPDATE inventory_batches SET qc_status='rejected' WHERE sku_id=? AND batch_no=?").run(anyStock.sku_id, anyStock.batch_no)
    clearParamCache(rw)
    try {
      const picked = pickBatches(rw, anyStock.warehouse_id, anyStock.sku_id, 1)
      ok(
        'A13：检验不合格的批次不再被自动拣出',
        !(picked.picks || []).some((p) => p.batchNo === anyStock.batch_no),
        JSON.stringify((picked.picks || []).map((p) => p.batchNo))
      )
      let thrown = null
      try {
        applyStockOut(rw, {
          bizDate: '2026-10-16', docType: 'SAL_OUT', docNo: `GUARD-A13-${Date.now()}`,
          warehouseId: anyStock.warehouse_id, skuId: anyStock.sku_id, batchNo: anyStock.batch_no, qty: 1, source: 'test'
        })
      } catch (e) {
        thrown = e
      }
      ok(
        'A13：显式指定该批次做销售出库 → 409 BATCH_NOT_SELLABLE（原来"指名要"是万能钥匙）',
        thrown?.code === 'BATCH_NOT_SELLABLE',
        thrown ? `${thrown.code}` : '没有抛错（说明还是扣了数）'
      )
      let thrown2 = null
      try {
        applyStockOut(rw, {
          bizDate: '2026-10-16', docType: 'SCRAP_OUT', docNo: `GUARD-A13S-${Date.now()}`,
          warehouseId: anyStock.warehouse_id, skuId: anyStock.sku_id, batchNo: anyStock.batch_no, qty: 1, source: 'test'
        })
      } catch (e) {
        thrown2 = e
      }
      const stockAfter = one('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?', anyStock.warehouse_id, anyStock.sku_id, anyStock.batch_no)
      ok(
        '对照：报废类出库仍然放行（否则"发现不合格→报废"会被自己拦住）',
        !thrown2 && Number(stockAfter?.qty_on_hand) === Number(anyStock.qty_on_hand) - 1,
        thrown2 ? `${thrown2.code}` : `qty ${anyStock.qty_on_hand} → ${stockAfter?.qty_on_hand}`
      )
      // 还原：把报废那一件加回去、批次状态写回原值
      applyStockIn(rw, {
        bizDate: '2026-10-16', docType: 'ADJ_IN', docNo: `GUARD-A13B-${Date.now()}`,
        warehouseId: anyStock.warehouse_id, skuId: anyStock.sku_id, batchNo: anyStock.batch_no, qty: 1, unitCost: null, source: 'test'
      })
    } finally {
      rw.prepare('UPDATE inventory_batches SET qc_status=? WHERE sku_id=? AND batch_no=?').run(
        had?.qc_status || 'pending', anyStock.sku_id, anyStock.batch_no
      )
      clearParamCache(rw)
      const back = one('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,\'\')=?', anyStock.warehouse_id, anyStock.sku_id, anyStock.batch_no)
      ok('A13：用例自还原（数量与检验状态回到用例前）', Number(back?.qty_on_hand) === Number(anyStock.qty_on_hand), `${anyStock.qty_on_hand} → ${back?.qty_on_hand}`)
    }
  }
}

// ============================================================
// G13 两套凭据的**双向**隔离 + C 端行业钉死（A16 反向 · 验收侧 §26/§27）
//
// 原形：`requireAuth` 只 `jwt.verify(token, SECRET)` —— **不校 aud**。
// C 端令牌用的是同一个签名密钥，于是「商城令牌当后台登录态用」畅通无阻：
//   GET /api/docflow/overview      → 200 且返回数据
//   GET /api/purchase/settlements  → 200 且返回数据
// 而且 `requireWrite` 只挡 `role === 'viewer'`，`role:'mall'` 连写闸都能过。
//
// 这条缺陷最值得记的地方：**我上一批只做了"后台令牌进不了商城"这一侧**，
// 另一侧（商城令牌进后台）没人问 —— 「双向隔离」只要有一侧不验，就还是单向的。
// 签发时标了 `audience` 不等于验签时会看它。
//
// 第二条：C 端 payload **不带 `industry`**，而行业解析是「头优先、令牌覆盖」——
// 令牌没这个字段 ⇒ 行业**完全由请求头决定**：一张令牌 + 任意 `x-industry` 指向任意库。
// 所以这里既验"拒绝"，也验"钉死"（用「只在当前库存在、另一个库不存在」的探针会员作证据）。
// ============================================================
section('G13 凭据双向隔离与 C 端行业钉死（A16 反向）')

const ALL_INDUSTRIES = ['cosmetic', 'food', 'apparel']
const OTHER_INDUSTRY = ALL_INDUSTRIES.find((x) => x !== INDUSTRY)
const PROBE_PHONE = '13900000005'
const probeDb = new Database(dbPathFor(OTHER_INDUSTRY))
probeDb.prepare('DELETE FROM mall_customers WHERE phone=?').run(PROBE_PHONE)
rw.prepare('DELETE FROM mall_customers WHERE phone=?').run(PROBE_PHONE)
rw.prepare(
  "INSERT INTO mall_customers (phone, points, total_orders, total_amount, last_active_at) VALUES (?,?,0,0,datetime('now','localtime'))"
).run(PROBE_PHONE, 98765)

const probeTok = await mallLogin(PROBE_PHONE)
ok('探针会员可在当前行业登录（C 端会话）', !!probeTok)

// 带任意头的请求封装（C 端令牌可以走 x-mall-token，也可以走 Authorization —— 两条都要验）
const reqWith = (token, method, p, { industry = INDUSTRY, bearer = false, body } = {}) =>
  fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-industry': industry,
      ...(bearer ? { Authorization: `Bearer ${token}` } : { 'x-mall-token': token })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  }).then(async (res) => ({ status: res.status, body: await res.json().catch(() => null) }))

// --- 13a C 端令牌当后台令牌用：读入口 ---
const back1 = await reqWith(probeTok, 'GET', '/api/docflow/overview', { bearer: true })
const back2 = await reqWith(probeTok, 'GET', '/api/purchase/settlements', { bearer: true })
ok('C 端令牌调 GET /api/docflow/overview → 401（原来 200 且返回数据）', back1.status === 401, `实际 ${back1.status}`)
ok('C 端令牌调 GET /api/purchase/settlements → 401（原来 200 且返回数据）', back2.status === 401, `实际 ${back2.status}`)

// --- 13b C 端令牌当后台令牌用：写入口 ---
const back3 = await reqWith(probeTok, 'POST', '/api/sales/orders', { bearer: true, body: {} })
ok(
  'C 端令牌调写入口 POST /api/sales/orders → 401（原来能过写闸）',
  back3.status === 401,
  `实际 ${back3.status}`
)

// --- 13c 反证「后台入口确实在校 aud」：不带 aud 的旧式令牌同样被拒 ---
const noAud = forgeNoAud({ uid: 1, username: 'admin', role: 'admin', name: '守卫·无 aud 令牌' })
const back4 = await api('GET', '/api/docflow/overview', { token: noAud })
ok('不带 audience 的旧式后台令牌 → 401（证明校验真的在跑，不是"恰好没命中"）', back4.status === 401, `实际 ${back4.status}`)
const back5 = await api('GET', '/api/docflow/overview', { token: adminJwt })
ok('正常后台令牌（带 audience）→ 200（对照：不能把后台也一起挡死）', back5.status === 200, `实际 ${back5.status}`)

// --- 13d 反方向（既有方向，保留）：后台令牌进 C 端 ---
const mallWithAdmin = await reqWith(adminJwt, 'GET', '/api/mall/session', { bearer: true })
ok('后台令牌调 C 端接口 → 401（两套凭据不通用）', mallWithAdmin.status === 401, `实际 ${mallWithAdmin.status}`)

// --- 13e 行业钉死在令牌：谎报 x-industry 也换不了库 ---
const s1 = await reqWith(probeTok, 'GET', '/api/mall/session', { industry: INDUSTRY })
ok('C 端会话自省返回签发时的行业', s1.body?.data?.industry === INDUSTRY, JSON.stringify(s1.body?.data))
const s2 = await reqWith(probeTok, 'GET', '/api/mall/session', { industry: OTHER_INDUSTRY })
ok(
  `C 端令牌 + 谎报 x-industry:${OTHER_INDUSTRY} → 行业仍是 ${INDUSTRY}（钉死在令牌）`,
  s2.status === 200 && s2.body?.data?.industry === INDUSTRY,
  `${s2.status} / ${JSON.stringify(s2.body?.data)}`
)
const s3 = await reqWith(probeTok, 'GET', '/api/mall/session', { industry: OTHER_INDUSTRY, bearer: true })
ok('同上，但令牌走 Authorization 头 → 行业同样被钉死', s3.body?.data?.industry === INDUSTRY, JSON.stringify(s3.body?.data))

// --- 13f 钉死的**实质后果**：读的是哪个库 ---
// 探针会员只在当前行业库里存在（另一库已被清空），所以"读得到 98765"就等于"读的是当前库"。
const mem = await reqWith(probeTok, 'GET', '/api/mall/member', { industry: OTHER_INDUSTRY })
ok(
  `谎报 x-industry:${OTHER_INDUSTRY} 读会员 → 仍读到当前库那一行（points=98765）`,
  Number(mem.body?.data?.points) === 98765,
  `${mem.status} / ${JSON.stringify(mem.body?.data)}`
)
const memOther = await reqWith(probeTok, 'GET', '/api/mall/member', { industry: INDUSTRY })
ok('对照：用本行业头读，同样读到那一行', Number(memOther.body?.data?.points) === 98765)

// --- 清理：探针会员在两个库都不留痕（测试要能重复跑） ---
probeDb.prepare('DELETE FROM mall_customers WHERE phone=?').run(PROBE_PHONE)
rw.prepare('DELETE FROM mall_customers WHERE phone=?').run(PROBE_PHONE)
probeDb.close()
ok(
  'G13：用例自还原（两个库的探针会员都已清除）',
  !one('SELECT id FROM mall_customers WHERE phone=?', PROBE_PHONE)
)

// ============================================================
// G14 共同事务：业务过账 + 结果缓存 + 确认消费 = 同一个原子单元（A04）
//
// 验收侧独立复现两条（同一脚本，结果 JSON 里两项都在）：
//   ① **调拨循环中断**（目标第二批 INSERT 失败）⇒ 第一批已落库、第二批源出库未回滚：
//      总库存 5→2、流水 2→5、幂等缓存 0 —— 库存与流水对不上，接口报错但什么都没退；
//   ② **业务成功之后** `mcp_idempotency` 写入失败 ⇒ 接口报错，而库存 +1 / 成本 10 / 流水都在、
//      缓存 0 行 ⇒ 调用方以为没成功，**重试会再执行一次**。
//
// 判据：三件事必须在**同一个事务边界**内 —— 要么全生效，要么全回滚；
// 且故障消除后重试能干净重跑（因为缓存也没落下），不重复执行。
// 只给 handler、或只给调拨循环加事务，都不够。
//
// 注入手法与验收侧一致：用同文件的**另一个连接**建触发器（DDL 对服务进程同样可见），用完立刻删。
// ============================================================
section('G14 共同事务：过账 / 缓存 / 确认 同一原子单元（A04）')

const dropGuardTriggers = () => {
  for (const n of ['guard_a04_idem', 'guard_a04_trin', 'guard_a04_adjin']) {
    try {
      rw.prepare(`DROP TRIGGER IF EXISTS ${n}`).run()
    } catch {
      /* 已删或不存在 */
    }
  }
}
dropGuardTriggers()

// --- 14a：结果缓存写失败 ⇒ 业务必须整体回滚（finding ②）---
{
  const s = one("SELECT warehouse_id, sku_id FROM inventory_stocks WHERE qty_on_hand > 0 ORDER BY id LIMIT 1")
  const inv0 = one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q
  const tx0 = one('SELECT COUNT(*) c FROM inventory_transactions').c
  const batch = `GUARD-A04-CACHE-${Date.now()}`
  const idem = `a04-cache-${batch}`
  const args = { warehouse_id: s.warehouse_id, sku_id: s.sku_id, qty: 3, unit_cost: 10, batch_no: batch, idempotency_key: idem }
  try {
    rw.prepare(
      "CREATE TRIGGER guard_a04_idem BEFORE INSERT ON mcp_idempotency BEGIN SELECT RAISE(ABORT, 'GUARD: 注入幂等缓存写失败'); END"
    ).run()
    const r1 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: args }, tkWriteA)
    ok('A04-② 幂等缓存写失败 → 接口报错', isErr(r1), JSON.stringify(textOf(r1)).slice(0, 140))
    ok(
      'A04-② 库存**没有**增加（原来业务已成功、只有缓存没写）',
      Number(one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q) === Number(inv0)
    )
    ok(
      'A04-② 没有留下任何库存流水',
      Number(one('SELECT COUNT(*) c FROM inventory_transactions').c) === Number(tx0)
    )
    ok('A04-② 没有留下幂等缓存行', !one('SELECT idempotency_key FROM mcp_idempotency WHERE idempotency_key=?', idem))

    // 故障消除后**用同一个幂等键**重试 —— 因为缓存没落下，应该能干净地重跑
    dropGuardTriggers()
    const r2 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: args }, tkWriteA)
    ok('A04-② 故障消除后同一幂等键重试 → 成功（不是"接口报错但业务已生效"）', !isErr(r2), JSON.stringify(textOf(r2)).slice(0, 140))
    ok(
      'A04-② 重试后库存恰好 +3（没有重复执行）',
      Number(one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q) === Number(inv0) + 3
    )
    ok('A04-② 重试后幂等缓存已落下', !!one('SELECT idempotency_key FROM mcp_idempotency WHERE idempotency_key=?', idem))
    const r3 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: args }, tkWriteA)
    ok(
      'A04-② 再调一次 → 幂等命中，返回首次结果（不再加库存）',
      textOf(r3)?._idempotent_replay === true || r3.body?.result?._idempotent_replay === true
    )
    ok(
      'A04-② 幂等命中时库存不再变化',
      Number(one('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').q) === Number(inv0) + 3
    )
  } finally {
    dropGuardTriggers()
    rw.prepare("DELETE FROM inventory_transactions WHERE IFNULL(batch_no,'')=?").run(batch)
    rw.prepare("DELETE FROM inventory_stocks WHERE IFNULL(batch_no,'')=?").run(batch)
    rw.prepare('DELETE FROM inventory_batches WHERE batch_no=?').run(batch)
    rw.prepare('DELETE FROM mcp_idempotency WHERE idempotency_key=?').run(idem)
    ok('A04-② 用例自还原', !one("SELECT id FROM inventory_stocks WHERE IFNULL(batch_no,'')=?", batch))
  }
}

// --- 14b：多步过账中途失败 ⇒ 前面已做的步骤也必须回滚（finding ①）---
//
// 关键做法：**用测试自己造的独立批次**做调拨，不用既有演示库存 ——
// 拿既有行做实验，还原时就必须把 `qty_on_hand` / 成本金额 / 批次表一起写回，
// 少还原一个字段就会让"成本自洽审计"出现残差（第一版就是这么把 test-costing 打红的）。
{
  const whA = one('SELECT id FROM warehouses ORDER BY id LIMIT 1')
  const skuId = one('SELECT id FROM product_skus ORDER BY id LIMIT 1')?.id
  const fromOwner = whA ? resolveOwnerOrg(db, whA.id, null) : null
  const whB = whA
    ? all('SELECT id FROM warehouses WHERE id<>? ORDER BY id', whA.id)
        .map((r) => r.id)
        .find((id) => resolveOwnerOrg(db, id, null) === fromOwner)
    : null
  ok('存在同货主的两个仓（调拨前提）', !!whA && !!whB && !!skuId, `A=${whA?.id} B=${whB} sku=${skuId}`)
  if (whA && whB && skuId) {
    const batch = `GUARD-A04-TR-${Date.now()}`
    const idem = `a04-transfer-${batch}`
    try {
      // 测试自造 5 件（独立批次，成本 10）—— 后续断言都围绕这一批
      applyStockIn(rw, {
        bizDate: '2026-10-16', docType: 'ADJ_IN', docNo: `GUARDTR-${Date.now()}`,
        warehouseId: whA.id, skuId, batchNo: batch, qty: 5, unitCost: 10, source: 'test'
      })
      const qA0 = one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", whA.id, skuId, batch).q
      const tx0 = one("SELECT COUNT(*) c FROM inventory_transactions WHERE warehouse_id IN (?,?) AND batch_no=?", whA.id, whB, batch).c
      ok('14b 前置：测试自造源库存 5 件', Number(qA0) === 5, `实际 ${qA0}`)

      const args = {
        from_warehouse_id: whA.id, to_warehouse_id: whB,
        sku_id: skuId, qty: 1, batch_no: batch, idempotency_key: idem
      }
      // 注入：让"调入"这一步失败 ⇒ 若第一段（调出）没被回滚，源仓会少 1 件
      rw.prepare(
        "CREATE TRIGGER guard_a04_trin BEFORE INSERT ON inventory_transactions WHEN NEW.doc_type='TR_IN' BEGIN SELECT RAISE(ABORT, 'GUARD: 注入调入过账失败'); END"
      ).run()
      const r1 = await mcp('tools/call', { name: 'inventory.transfer', arguments: args }, tkWriteA)
      ok('A04-① 调入失败 → 接口报错', isErr(r1), JSON.stringify(textOf(r1)).slice(0, 140))
      const qA1 = one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", whA.id, skuId, batch)?.q
      ok('A04-① 源仓库存**没有**被扣掉（原来第一段已落库）', Number(qA1) === 5, `5 → ${qA1}`)
      ok('A04-① 目标仓没有凭空多出库存', !one('SELECT id FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?', whB, skuId, batch))
      ok(
        'A04-① 没有留下部分流水（原来"2→5"就是这一步留下的）',
        Number(one("SELECT COUNT(*) c FROM inventory_transactions WHERE warehouse_id IN (?,?) AND batch_no=?", whA.id, whB, batch).c) === Number(tx0)
      )

      dropGuardTriggers()
      const r2 = await mcp('tools/call', { name: 'inventory.transfer', arguments: args }, tkWriteA)
      ok('A04-① 故障消除后重试 → 成功', !isErr(r2), JSON.stringify(textOf(r2)).slice(0, 140))
      const qA2 = one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", whA.id, skuId, batch)?.q
      const qB2 = one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", whB, skuId, batch)?.q
      ok('A04-① 重试后源仓恰好 -1（没有重复扣减）', Number(qA2) === 4, `5 → ${qA2}`)
      ok('A04-① 重试后目标仓恰好 +1（调拨是平移）', Number(qB2) === 1, `目标仓 ${qB2}`)
    } finally {
      dropGuardTriggers()
      rw.prepare("DELETE FROM inventory_transactions WHERE warehouse_id IN (?,?) AND batch_no=?", ).run(whA.id, whB, batch)
      rw.prepare('DELETE FROM inventory_stocks WHERE warehouse_id IN (?,?) AND sku_id=? AND batch_no=?').run(whA.id, whB, skuId, batch)
      rw.prepare('DELETE FROM inventory_batches WHERE sku_id=? AND batch_no=?').run(skuId, batch)
      rw.prepare('DELETE FROM mcp_idempotency WHERE idempotency_key=?').run(idem)
      ok(
        'A04-① 用例自还原（两个仓的测试批次行都已清）',
        !one('SELECT id FROM inventory_stocks WHERE warehouse_id IN (?,?) AND sku_id=? AND batch_no=?', whA.id, whB, skuId, batch)
      )
    }
  }
}

// --- 14c：高危操作执行失败 ⇒ 确认单回到 confirmed，且是**回滚的自然结果**不是手工补丁 ---
{
  const st = one('SELECT warehouse_id, sku_id FROM inventory_stocks WHERE qty_on_hand > 0 ORDER BY id LIMIT 1')
  const batch = `GUARD-A04-ADJ-${Date.now()}`
  const adjArgs2 = { warehouse_id: st.warehouse_id, sku_id: st.sku_id, batch_no: batch, delta: 1, reason: 'A04 共同事务验证' }
  const cAsk = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs2 }, tkDeny)
  const tok = textOf(cAsk)?.confirm_token
  ok('A04-③ 高危操作拿到待确认单', !!tok)
  if (tok) {
    await api('POST', `/mcp/confirmations/${tok}/approve`, { token: financeJwt })
    try {
      rw.prepare(
        "CREATE TRIGGER guard_a04_adjin BEFORE INSERT ON inventory_transactions WHEN NEW.doc_type='ADJ_IN' BEGIN SELECT RAISE(ABORT, 'GUARD: 注入调整过账失败'); END"
      ).run()
      const rFail = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs2, confirm_token: tok } }, tkDeny)
      ok('A04-③ 执行失败 → 接口报错', isErr(rFail), JSON.stringify(textOf(rFail)).slice(0, 140))
      const st1 = one('SELECT status FROM mcp_confirmations WHERE confirm_token=?', tok)?.status
      ok(
        'A04-③ 失败后确认单仍是 confirmed（回滚的自然结果，不必重找人批）',
        st1 === 'confirmed',
        `实际 ${st1}`
      )
      dropGuardTriggers()
      const rOk = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs2, confirm_token: tok } }, tkDeny)
      ok('A04-③ 故障消除后同一张确认单可成功执行', !isErr(rOk), JSON.stringify(textOf(rOk)).slice(0, 140))
      const st2 = one('SELECT status FROM mcp_confirmations WHERE confirm_token=?', tok)?.status
      ok('A04-③ 成功后才置 used', st2 === 'used', `实际 ${st2}`)
    } finally {
      dropGuardTriggers()
      rw.prepare("DELETE FROM inventory_transactions WHERE IFNULL(batch_no,'')=?").run(batch)
      rw.prepare("DELETE FROM inventory_stocks WHERE IFNULL(batch_no,'')=?").run(batch)
      rw.prepare('DELETE FROM inventory_batches WHERE batch_no=?').run(batch)
      ok('A04-③ 用例自还原', !one("SELECT id FROM inventory_stocks WHERE IFNULL(batch_no,'')=?", batch))
    }
  }
}

// ============================================================
// G15 销售退货闭环（D1）
//
// 缺陷原形（验收侧 A 级复现）：`POST /api/sales/returns` 只把 order_id 存进表头，
// 明细不绑销售订单行，也不查"已发多少 / 已退多少" ——
// **已发 94 件、一次退 189 件（94×2+1）→ 200 / code 0 / success true**；
// 同时退货入库成本直接取客户端传的 `price`（实测 9999 被写进库存成本层），
// 且函数体内没有任何应收逻辑（退货后原应收金额分毫未动）。
//
// 用例策略：**自造最小数据集**（一张已发货订单 + 一个原出库批次 + 一张应收），
// 只测退货这一段。不借既有演示数据做实验 —— 上一批的教训就是"借来的数据还原不干净"。
// 自造的东西删得干净：全部挂在同一个测试批次号 `RT_BATCH` 上。
// ============================================================
section('G15 销售退货闭环：来源行 / 退量上限 / 成本追溯 / 应收冲减（D1）')

{
  const rtSku = one('SELECT id FROM product_skus ORDER BY id LIMIT 1')
  const rtWh = one("SELECT id FROM warehouses WHERE type='central' LIMIT 1") || one('SELECT id FROM warehouses ORDER BY id LIMIT 1')
  const rtDealer = one('SELECT id FROM dealers ORDER BY id LIMIT 1')
  const RT_BATCH = `GUARD-D1-${Date.now()}`
  const RT_DOC = `GUARDSO${Date.now()}`
  const RT_COST = 7 // 原出库成本（刻意与售价 20 不同，用来证明"成本不采信客户端"）
  const RT_PRICE = 20 // 订单售价 → 净单价
  const RT_OUT_QTY = 5
  let rtOrderId = null
  let rtItemId = null
  let rtArId = null

  const cleanupD1 = () => {
    try {
      if (rtOrderId) {
        rw.prepare('DELETE FROM sales_return_items WHERE return_id IN (SELECT id FROM sales_returns WHERE order_id=?)').run(rtOrderId)
        rw.prepare('DELETE FROM sales_returns WHERE order_id=?').run(rtOrderId)
        rw.prepare('DELETE FROM sales_order_items WHERE order_id=?').run(rtOrderId)
        rw.prepare('DELETE FROM doc_events WHERE doc_type=? AND doc_id=?').run('SO', rtOrderId)
        rw.prepare('DELETE FROM sales_orders WHERE id=?').run(rtOrderId)
      }
      if (rtArId) rw.prepare('DELETE FROM ar_documents WHERE id=?').run(rtArId)
      rw.prepare("DELETE FROM inventory_transactions WHERE IFNULL(batch_no,'')=?").run(RT_BATCH)
      rw.prepare("DELETE FROM inventory_stocks WHERE IFNULL(batch_no,'')=?").run(RT_BATCH)
      rw.prepare('DELETE FROM inventory_batches WHERE batch_no=?').run(RT_BATCH)
    } catch {
      /* 清理尽力而为，断言在下面单独给出 */
    }
  }

  try {
    // ---- 前置数据（全部自造）----
    applyStockIn(rw, {
      bizDate: '2026-10-16', docType: 'ADJ_IN', docNo: `GUARDD1IN-${Date.now()}`,
      warehouseId: rtWh.id, skuId: rtSku.id, batchNo: RT_BATCH, qty: 10, unitCost: RT_COST, source: 'test'
    })
    const oInfo = rw
      .prepare(
        `INSERT INTO sales_orders (doc_no,channel,dealer_id,warehouse_id,order_date,status,total_qty,goods_amount,receivable_amount,created_by)
         VALUES (?,?,?,?,?,'shipped',?,?,?,1)`
      )
      .run(RT_DOC, 'dealer', rtDealer.id, rtWh.id, '2026-10-16', RT_OUT_QTY, RT_OUT_QTY * RT_PRICE, RT_OUT_QTY * RT_PRICE)
    rtOrderId = Number(oInfo.lastInsertRowid)
    const iInfo = rw
      .prepare(
        'INSERT INTO sales_order_items (order_id,sku_id,qty,price,discount,amount,shipped_qty) VALUES (?,?,?,?,0,?,?)'
      )
      .run(rtOrderId, rtSku.id, RT_OUT_QTY, RT_PRICE, RT_OUT_QTY * RT_PRICE, RT_OUT_QTY)
    rtItemId = Number(iInfo.lastInsertRowid)
    // 原出库流水（成本追溯的依据）
    rw.prepare(
      `INSERT INTO inventory_transactions (biz_date,doc_type,doc_no,warehouse_id,sku_id,batch_no,direction,qty,unit_cost,amount,counterparty,source)
       VALUES (?, 'SAL_OUT', ?, ?, ?, ?, 'out', ?, ?, ?, ?, 'test')`
    ).run('2026-10-16', `GUARDSD${Date.now()}`, rtWh.id, rtSku.id, RT_BATCH, RT_OUT_QTY, RT_COST, RT_OUT_QTY * RT_COST, RT_DOC)
    // 应收（退货要冲减的对象）
    const aInfo = rw
      .prepare(
        `INSERT INTO ar_documents (doc_no,subject_type,subject_id,source_type,source_id,source_doc_no,biz_date,due_date,credit_days,
                                   amount,allocated_amount,status,currency,created_at,updated_at)
         VALUES (?, 'dealer', ?, 'SO', ?, ?, '2026-10-16', '2026-10-16', 0, ?, 0, 'open', 'CNY',
                 datetime('now','localtime'), datetime('now','localtime'))`
      )
      .run(`GUARDAR${Date.now()}`, rtDealer.id, rtOrderId, RT_DOC, RT_OUT_QTY * RT_PRICE)
    rtArId = Number(aInfo.lastInsertRowid)
    rw.prepare('UPDATE sales_orders SET ar_id=? WHERE id=?').run(rtArId, rtOrderId)
    ok('G15 前置：自造已发货订单 + 原出库批次 + 应收', !!rtOrderId && !!rtArId, `SO#${rtOrderId} AR#${rtArId}`)

    const rt = (body) => api('POST', '/api/sales/returns', { token: salesJwt, body })

    // ---- 15a 超退必拒 ----
    const over = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: RT_OUT_QTY + 1 }] })
    ok(
      `超退（已发 ${RT_OUT_QTY}，退 ${RT_OUT_QTY + 1}）→ 409 RETURN_EXCEEDS_SHIPPED（原来 200 且照单全收）`,
      over.status === 409 && over.body?.detail?.code === 'RETURN_EXCEEDS_SHIPPED',
      `${over.status} / ${over.body?.detail?.code}`
    )
    ok('超退被拒后库存没有变化', Number(one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", rtWh.id, rtSku.id, RT_BATCH).q) === 10)

    // ---- 15b 有单退货必须绑来源行 ----
    const noSrc = await rt({ order_id: rtOrderId, items: [{ sku_id: rtSku.id, qty: 1 }] })
    ok(
      '有单退货不绑来源行 → 400 SOURCE_REQUIRED（不绑就等于给上限开后门）',
      noSrc.status === 400 && noSrc.body?.detail?.code === 'SOURCE_REQUIRED',
      `${noSrc.status} / ${noSrc.body?.detail?.code}`
    )

    // ---- 15c 正常退 2 件：成本追溯 + 应收冲减 ----
    // 客户端故意传一个离谱的 price —— 它不该影响任何东西
    const r1 = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: 2, price: 9999 }] })
    ok('有单退货 2 件 → 200', r1.status === 200, JSON.stringify(r1.body?.detail || r1.body?.message || '').slice(0, 160))
    const ret1 = r1.body?.data || {}
    const item1 = one('SELECT * FROM sales_return_items WHERE return_id=?', ret1.id)
    ok('退货明细绑定了来源订单行', Number(item1?.order_item_id) === Number(rtItemId), JSON.stringify(item1))
    ok(
      '退货单价用**订单净单价**（20），不是客户端传的 9999',
      Number(item1?.price) === RT_PRICE,
      `price=${item1?.price}`
    )
    const retTxn = one("SELECT * FROM inventory_transactions WHERE doc_type='SAL_RET' AND doc_id=? ORDER BY id DESC LIMIT 1", ret1.id)
    ok(
      `退货入库成本 = 原出库批次成本 ${RT_COST}（不是售价 20，更不是客户端传的 9999）`,
      Number(retTxn?.unit_cost) === RT_COST,
      `unit_cost=${retTxn?.unit_cost}`
    )
    ok('退货入库落回**原出库批次**', String(retTxn?.batch_no) === RT_BATCH, `batch_no=${retTxn?.batch_no}`)
    ok(
      '该批次库存 +2（原有 10 → 12）',
      Number(one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", rtWh.id, rtSku.id, RT_BATCH).q) === 12
    )
    const arAfter = one('SELECT * FROM ar_documents WHERE id=?', rtArId)
    ok(
      `退货后应收金额按退货额减少（100 → 60）`,
      Number(arAfter?.amount) === RT_OUT_QTY * RT_PRICE - 2 * RT_PRICE,
      `amount=${arAfter?.amount}`
    )
    const retHead = one('SELECT * FROM sales_returns WHERE id=?', ret1.id)
    ok('退货单记录了冲减了哪张应收', Number(retHead?.ar_id) === rtArId, `ar_id=${retHead?.ar_id}`)
    ok('退货单记录了冲减额', Number(retHead?.ar_offset_amount) === 2 * RT_PRICE, `offset=${retHead?.ar_offset_amount}`)
    ok('未结余额足够，没有产生待退款', Number(retHead?.refund_due) === 0, `refund_due=${retHead?.refund_due}`)

    // ---- 15d 幂等重放不重复冲减 ----
    const idemKey = `guard-d1-${Date.now()}`
    const beforeQty = one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", rtWh.id, rtSku.id, RT_BATCH).q
    const beforeAr = one('SELECT amount a FROM ar_documents WHERE id=?', rtArId).a
    const i1 = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: 1 }], idempotency_key: idemKey })
    const i2 = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: 1 }], idempotency_key: idemKey })
    ok('同幂等键的第二次提交返回同一张退货单', i1.body?.data?.id === i2.body?.data?.id && i2.body?.data?.replayed === true,
      `${i1.body?.data?.id} vs ${i2.body?.data?.id} / replayed=${i2.body?.data?.replayed}`)
    ok(
      '重放**没有**再回一次货',
      Number(one("SELECT qty_on_hand q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?", rtWh.id, rtSku.id, RT_BATCH).q) === Number(beforeQty) + 1
    )
    ok(
      '重放**没有**再冲一次应收',
      Number(one('SELECT amount a FROM ar_documents WHERE id=?', rtArId).a) === Number(beforeAr) - RT_PRICE
    )

    // ---- 15e 累计上限：把剩下的退完可以，再退就被拒 ----
    const rest = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: 2 }] })
    ok('累计退完剩余可退量（2 件）→ 200', rest.status === 200, `${rest.status}`)
    const over2 = await rt({ order_id: rtOrderId, items: [{ order_item_id: rtItemId, qty: 1 }] })
    ok(
      '累计已退 = 已发量后再退 → 409（多次部分退货累计不超发）',
      over2.status === 409 && over2.body?.detail?.code === 'RETURN_EXCEEDS_SHIPPED',
      `${over2.status} / ${over2.body?.detail?.code}`
    )
    const sumRet = one(
      'SELECT COALESCE(SUM(i.qty),0) q FROM sales_return_items i WHERE i.order_item_id=?',
      rtItemId
    ).q
    ok('该来源行的累计退量恰好等于已发量（5）', Number(sumRet) === RT_OUT_QTY, `已退 ${sumRet}`)

    // ---- 15f A09b：门店退货与销售退货共用**同一份**判据 ----
    let pe = null
    try {
      planReturn(rw, { orderId: rtOrderId, sourceType: 'order', items: [{ sku_id: rtSku.id, qty: 1 }], warehouseId: rtWh.id })
    } catch (e) {
      pe = e
    }
    ok(
      'A09b：门店退货走的是同一个 planReturn（未绑来源行 → 同一个业务码）',
      pe instanceof ReturnError && pe.code === 'SOURCE_REQUIRED',
      `${pe?.code}`
    )
  } finally {
    cleanupD1()
    ok(
      'G15 用例自还原（订单 / 应收 / 测试批次全部清除）',
      !one('SELECT id FROM sales_orders WHERE doc_no=?', RT_DOC) &&
        !one("SELECT id FROM inventory_stocks WHERE IFNULL(batch_no,'')=?", RT_BATCH)
    )
  }
}

// ============================================================
// G16 MCP 复用领域服务（D5）
//
// 缺陷原形：MCP 的 danger 工具里有三处"平行实现"——
//   · `sales.cancel_order`：只有一行 `UPDATE sales_orders SET status='cancelled'`
//     ⇒ 库存占用没释放（那批货永远卖不出去）、授信没还（额度只减不增），单子却"已作废"；
//   · `approval.approve`：裸 UPDATE 且用了**不存在的列** `finished_at`（只有 `decided_at`），
//     还绕开状态机 —— 不写审批记录、不判"该不该你批"、**审批通过后不执行业务流转**；
//   · `pricing.update_price`：改价不留痕，界面的"价格变更历史"里看不到 Agent 改过价。
//
// 修法：有领域服务的一律调领域服务（`cancelOrder` / `decideApproval` / `logPriceChange`），
// 并回答"Agent 凭什么代替人签字"—— **它不代替，它转呈**：确认单上的 `confirmed_by_id`
// 就是签字人（这一列由本批的迁移 029 补上）。
// ============================================================
section('G16 MCP 复用领域服务：作废 / 调价 / 审批（D5）')

// --- 16a MCP 作废订单 = 领域服务（释放预留 + 内核流转 + 释放授信）---
{
  const so = one("SELECT * FROM sales_orders WHERE status='confirmed' AND warehouse_id IS NOT NULL ORDER BY id LIMIT 1")
  const soItems = so ? all('SELECT * FROM sales_order_items WHERE order_id=?', so.id) : []
  ok('存在可作废的已确认订单样本', !!so && soItems.length > 0, `SO#${so?.id}`)
  if (so && soItems.length) {
    try {
      // 只占 1 件，且**必须用订单行里真的有的 SKU** ——
      // 取消时是按订单明细逐行释放的（`releaseForDoc` 按 SKU 匹配），
      // 用别的 SKU 造占用，取消当然释放不掉（这一条第一版就踩了）。
      const stk = one(
        `SELECT s.sku_id FROM inventory_stocks s
           JOIN sales_order_items i ON i.sku_id = s.sku_id AND i.order_id = ?
          WHERE s.warehouse_id = ? AND (s.qty_on_hand - s.qty_reserved) >= 1
          ORDER BY s.id LIMIT 1`,
        so.id,
        so.warehouse_id
      )
      ok('该仓存在可用库存（造占用的前提）', !!stk, JSON.stringify(stk))
      reserveForDoc(rw, {
        sourceDocType: 'SO',
        sourceDocId: so.id,
        warehouseId: so.warehouse_id,
        items: [{ skuId: stk.sku_id, qty: 1 }]
      })
      rw.prepare('UPDATE sales_orders SET credit_hold=? WHERE id=?').run(123.45, so.id)
      const resv0 = one(
        "SELECT COALESCE(SUM(qty),0) q FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=? AND status='active'",
        so.id
      ).q
      ok('前置：造出该单的库存占用', Number(resv0) > 0, `预留 ${resv0}`)

      const args = { order_id: so.id, reason: '守卫回归：MCP 作废' }
      const c1 = await mcp('tools/call', { name: 'sales.cancel_order', arguments: args }, tkDeny)
      const ct = textOf(c1)?.confirm_token
      ok('MCP 作废返回待确认单', !!ct)
      await api('POST', `/mcp/confirmations/${ct}/approve`, { token: financeJwt })
      const r = await mcp('tools/call', { name: 'sales.cancel_order', arguments: { ...args, confirm_token: ct } }, tkDeny)
      ok('MCP 作废订单 → 成功', !isErr(r), JSON.stringify(textOf(r)).slice(0, 150))
      const after = one('SELECT status, credit_hold FROM sales_orders WHERE id=?', so.id)
      ok('订单已作废', after?.status === 'cancelled', after?.status)
      const resv1 = one(
        "SELECT COALESCE(SUM(qty),0) q FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=? AND status='active'",
        so.id
      ).q
      ok(
        '**库存占用被释放**（旧版只有一行 UPDATE，占用永远挂着、那批货再也卖不出去）',
        Number(resv1) === 0,
        `残留 ${resv1}`
      )
      ok('授信占用标志被清零', Number(after?.credit_hold) === 0, `credit_hold=${after?.credit_hold}`)
      ok(
        '走了内核流转（doc_events 有 cancel 留痕，旧版没有）',
        !!one("SELECT id FROM doc_events WHERE doc_type='SO' AND doc_id=? AND action='cancel'", so.id)
      )
    } finally {
      rw.prepare("DELETE FROM inventory_reservations WHERE source_doc_type='SO' AND source_doc_id=?").run(so.id)
      rw.prepare("DELETE FROM doc_events WHERE doc_type='SO' AND doc_id=? AND action='cancel'").run(so.id)
      rw.prepare('UPDATE sales_orders SET status=?, credit_hold=? WHERE id=?').run(so.status, so.credit_hold, so.id)
      ok('G16a 用例自还原', one('SELECT status FROM sales_orders WHERE id=?', so.id)?.status === so.status)
    }
  }
}

// --- 16b 调价必须留痕 ---
{
  const sku = one('SELECT id, price_retail FROM product_skus ORDER BY id LIMIT 1')
  const logs0 = one('SELECT COUNT(*) c FROM price_change_logs').c
  const args = { sku_id: sku.id, price_retail: Number(sku.price_retail) + 1, reason: '守卫回归：MCP 调价' }
  try {
    const c1 = await mcp('tools/call', { name: 'pricing.update_price', arguments: args }, tkDeny)
    const ct = textOf(c1)?.confirm_token
    await api('POST', `/mcp/confirmations/${ct}/approve`, { token: financeJwt })
    const r = await mcp('tools/call', { name: 'pricing.update_price', arguments: { ...args, confirm_token: ct } }, tkDeny)
    ok('MCP 调价 → 成功', !isErr(r), JSON.stringify(textOf(r)).slice(0, 150))
    ok(
      '调价写入**价格变更留痕**（旧版不留痕：界面「价格变更历史」里看不到 Agent 改过价）',
      Number(one('SELECT COUNT(*) c FROM price_change_logs').c) === Number(logs0) + 1
    )
    const last = one("SELECT * FROM price_change_logs WHERE source='mcp' ORDER BY id DESC LIMIT 1")
    ok('留痕标注了来源与操作人（source=mcp）', !!last && Number(last.new_value) === Number(sku.price_retail) + 1, JSON.stringify(last))
  } finally {
    rw.prepare('UPDATE product_skus SET price_retail=? WHERE id=?').run(sku.price_retail, sku.id)
    rw.prepare("DELETE FROM price_change_logs WHERE source='mcp' AND entity_id=?").run(sku.id)
    ok('G16b 用例自还原', Number(one('SELECT price_retail p FROM product_skus WHERE id=?', sku.id)?.p) === Number(sku.price_retail))
  }
}

// --- 16c 审批：确认人 = 签字人（"Agent 凭什么代替人签字"的落点）---
{
  const tpl = one('SELECT * FROM approval_templates ORDER BY id LIMIT 1')
  const srcInst = one('SELECT template_code FROM approval_instances WHERE template_id=? LIMIT 1', tpl.id)
  const twoStep = one('SELECT template_id FROM approval_steps GROUP BY template_id HAVING COUNT(*)>=2 ORDER BY template_id LIMIT 1')
  ok('存在多级审批模板（用例前提）', !!twoStep, `template=${twoStep?.template_id}`)
  if (twoStep && srcInst) {
    const info = rw
      .prepare(
        `INSERT INTO approval_instances (template_id,template_code,doc_type,doc_id,doc_no,action,action_name,amount,
                                         total_steps,current_step,status,submitted_by_id,submitted_by,submitted_at,created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,2,1,'pending',1,'守卫',datetime('now','localtime'),datetime('now','localtime'),datetime('now','localtime'))`
      )
      .run(twoStep.template_id, srcInst.template_code, 'SO', 0, `GUARDAPPR${Date.now()}`, 'confirm', '确认订单', 100)
    const instId = Number(info.lastInsertRowid)
    try {
      const args = { instance_id: instId, comment: '守卫回归：MCP 审批' }
      const c1 = await mcp('tools/call', { name: 'approval.approve', arguments: args }, tkDeny)
      const ct = textOf(c1)?.confirm_token
      // 确认人必须**同时**是该级审批人（模板第 1 级是"采购员"），否则会因资格不足被拒 ——
      // 这条本身也说明审批没有绕开"该不该你批"的判断（旧版根本不判）。
      const purchaseUid = one("SELECT id FROM users WHERE username='purchase'")?.id
      await api('POST', `/mcp/confirmations/${ct}/approve`, { token: purchaseJwt })
      const r = await mcp('tools/call', { name: 'approval.approve', arguments: { ...args, confirm_token: ct } }, tkDeny)
      ok(
        'MCP 审批通过 → 成功（旧版因 `finished_at` 列不存在必然报错）',
        !isErr(r),
        JSON.stringify(textOf(r)).slice(0, 170)
      )
      const rec = one('SELECT * FROM approval_records WHERE instance_id=? ORDER BY id DESC LIMIT 1', instId)
      ok('写入了审批记录（旧版绕开状态机，不写记录）', !!rec, JSON.stringify(rec))
      ok(
        '**审批记录的签字人 = 确认人**（purchase 的 uid，不是 Agent 令牌）',
        Number(rec?.approver_id) === Number(purchaseUid),
        `approver_id=${rec?.approver_id} / confirmed by purchase(uid=${purchaseUid})`
      )
      const after = one('SELECT status, current_step FROM approval_instances WHERE id=?', instId)
      ok('按级次进级（1 → 2），不是一步"整单已批"', Number(after?.current_step) === 2 && after?.status === 'pending', JSON.stringify(after))
      const conf = one('SELECT confirmed_by_id FROM mcp_confirmations WHERE confirm_token=?', ct)
      ok('确认单落库了签字人 id（迁移 029 新增列）', Number(conf?.confirmed_by_id) === Number(purchaseUid), JSON.stringify(conf))
    } finally {
      rw.prepare('DELETE FROM approval_records WHERE instance_id=?').run(instId)
      rw.prepare('DELETE FROM approval_instances WHERE id=?').run(instId)
      ok('G16c 用例自还原', !one('SELECT id FROM approval_instances WHERE id=?', instId))
    }
  }
}

// ============================================================
// G17 令牌是"声明"，权限以库为准（A20）
//
// 缺陷原形：`requireAuth` 在 `jwt.verify` 之后**直接把 payload 当 `req.user`** ——
// 于是：用户被停用 → 旧令牌最长还能用 12 小时；角色被降级 → 旧令牌里仍是老角色，
// **权限跟着旧角色走**；用户被删除 → 令牌照样畅通。
// 撤权"不即时生效"在权限系统里是很重的问题：**撤了权却还能用，而且不报错**，
// 管理员以为已经撤掉了。
//
// 另一条：`docker-compose.yml` 配的是 `JWT_SECRET`，而代码只读 `GML_JWT_SECRET` ——
// 容器里**一直在用内置的演示回退密钥**，也不报错（有回退值就不会崩）。
// ============================================================
section('G17 权限以库为准，安全变更撤销旧会话（A20 / F06）')

{
  // 专用账号避免撤销后续用例共用的 viewerJwt；通过真实 API 变更并重新登录。
  const username = 'guard_session_probe'
  const password = 'Guard-session-test-2026!'
  const created = await api('POST', '/api/auth/users', {
    token: adminJwt, body: { username, password, name: '守卫·会话撤销', role: 'viewer' }
  })
  ok('G17 专用 viewer 创建成功', created.status === 200, String(created.status))
  const uid = created.body?.data?.id
  if (uid) {
    probeUserIds.push(uid)
    const writePath = (token) => api('POST', '/api/sales/orders', { token, body: {} })
    const change = (body) => api('PUT', '/api/auth/users/' + uid, { token: adminJwt, body })
    const revoked = async (token, label) => {
      const response = await writePath(token)
      ok(label, response.status === 401 && (response.body?.error || response.body?.detail?.code) === 'SESSION_REVOKED', String(response.status))
    }
    const initial = await loginAs(username, password)
    ok('基线：viewer 登录成功且写入口 → 403', !!initial && (await writePath(initial)).status === 403)

    ok('API 提权成功', (await change({ role: 'admin' })).status === 200)
    await revoked(initial, '提权撤销初始会话，旧 JWT 不自动获得新权限')
    const promoted = await loginAs(username, password)
    const promotedMe = await api('GET', '/api/auth/me', { token: promoted })
    ok('重新登录确认为 admin', !!promoted && promotedMe.status === 200 && promotedMe.body?.data?.role === 'admin')
    const promotedWrite = await writePath(promoted)
    ok('admin 新会话通过写权限门禁后被空业务参数拒绝', promotedWrite.status === 400, String(promotedWrite.status))

    ok('API 降权成功', (await change({ role: 'viewer' })).status === 200)
    await revoked(promoted, '降权撤销 admin 会话')
    const downgraded = await loginAs(username, password)
    ok('降权后重新登录写入口 → 403', !!downgraded && (await writePath(downgraded)).status === 403)

    ok('API 停用成功', (await change({ status: 'inactive' })).status === 200)
    await revoked(downgraded, '停用立即撤销会话')
    const disabledLogin = await api('POST', '/api/auth/login', { body: { username, password, industry: INDUSTRY } })
    ok('停用账号不能重新登录', disabledLogin.status === 401)
    ok('API 重新启用成功', (await change({ status: 'active' })).status === 200)
    await revoked(downgraded, '重新启用不会复活停用前的旧 JWT')
    await revoked(initial, '重新启用不会复活更早版本 JWT')
    const enabled = await loginAs(username, password)
    const enabledMe = await api('GET', '/api/auth/me', { token: enabled })
    ok('启用后重新登录可读本人资料', !!enabled && enabledMe.status === 200 && enabledMe.body?.data?.role === 'viewer')
    ok('启用后仍保留 viewer 写权限限制', (await writePath(enabled)).status === 403)
  }
  // 显式版本确保此负向用例验证的是账号不存在，而不是遗漏版本。
  const ghost = forge({ uid: 999999, username: 'ghost', role: 'admin', name: '守卫·幽灵', auth_version: 0 })
  const g = await api('GET', '/api/sales/orders', { token: ghost })
  ok('令牌指向一个不存在的用户 → 401', g.status === 401, String(g.status))
}

// ===========================================================================
// G18 真实渠道接入结算域（A14）——从**商城前端那条路**下单，不用 seed 造单
//
// 验收侧点名要求：A14 若复现须重开 F，且**不得用 seed 造单证明真实渠道已集成**。
// 所以这一段一律走 HTTP：login → cart → quote → orders。
//
// 为什么断言里要放"试算 = 落单"：这是"接入"与"另写一套"的分水岭 ——
// 旧实现商城自己算（会员价×数量 + 199 免运），落单后直接
// `UPDATE mall_customers SET points = points + FLOOR(实付)`（**1 元 1 分**），
// 而营销域的默认口径是 **10 分/元**。同一件事两套算法，界面上完全看不出来。
// ===========================================================================

/** 造一个探针会员（用完删干净）：等级走 `setMemberLevel`，所以等级门槛是自洽的 */
const probeCustomerIds = []
function makeProbeCustomer({ level = 'normal', points = 0 } = {}) {
  const phone = `139${String(Date.now() % 100000000).padStart(8, '0')}`
  const info = rw
    .prepare("INSERT INTO mall_customers (phone,name,level_code,points,total_orders,total_amount) VALUES (?,?,?,0,0,0)")
    .run(phone, `守卫会员${phone.slice(-4)}`, level)
  const id = Number(info.lastInsertRowid)
  probeCustomerIds.push(id)
  MB.ensureAccount(rw, id)
  // `setMemberLevel` 会把累计门槛一并抬到达标线 —— 否则下一单送完分，
  // 自动判定会依据旧门槛把刚设的等级改回去（这正是那个函数存在的原因）。
  if (level !== 'normal') MB.setMemberLevel(rw, { customerId: id, levelCode: level, remark: '守卫测试：预置等级' })
  rw.prepare('UPDATE mall_customers SET level_code=? WHERE id=?').run(
    rw.prepare('SELECT level_code FROM member_accounts WHERE customer_id=?').get(id).level_code, id)
  if (points > 0) MB.adjustPoints(rw, { customerId: id, change: points, remark: '守卫测试：预置积分' })
  return { id, phone }
}

// 探针促销：把库里所有自动促销**临时停用**，只留这一张，
// 断言才是确定的（否则命中的是哪几张取决于演示数据的规则，等于没断言）。
const probePromoCodes = []
// ⚠️ **必须 async + `await fn(code)`**：回调里是 HTTP 调用（异步）。
// 写成 `return fn(code)` 的话，`finally` 会在 Promise 还在飞的时候就把探针促销删掉 ——
// 表现是"断言一直看到的是演示数据里的那几张促销"，看起来像"探针没生效"，
// 其实是**清理跑在了业务之前**。
async function withProbePromotion(fn) {
  const snapshot = all("SELECT id, status FROM promotions WHERE status='active'")
  const code = `GUARD_A14_${Date.now() % 100000}`
  try {
    rw.prepare("UPDATE promotions SET status='inactive' WHERE status='active'").run()
    PR.createPromotion(rw, {
      code,
      name: '守卫测试·整单直减 50 元',
      status: 'active',
      is_automatic: 1,
      priority: 50,
      starts_at: null,
      ends_at: null,
      method: { type: 'fixed', target_type: 'order', allocation: 'across', value: 5000 },
      rules: {}
    })
    probePromoCodes.push(code)
    return await fn(code)
  } finally {
    rw.prepare('DELETE FROM promotion_campaign_budgets WHERE campaign_id IN (SELECT id FROM promotions WHERE code=?)').run(code)
    rw.prepare('DELETE FROM promotion_methods WHERE promotion_id IN (SELECT id FROM promotions WHERE code=?)').run(code)
    rw.prepare('DELETE FROM promotion_adjustments WHERE promotion_id IN (SELECT id FROM promotions WHERE code=?)').run(code)
    rw.prepare('DELETE FROM promotion_usages WHERE promotion_id IN (SELECT id FROM promotions WHERE code=?)').run(code)
    rw.prepare('DELETE FROM promotions WHERE code=?').run(code)
    for (const s of snapshot) rw.prepare('UPDATE promotions SET status=? WHERE id=?').run(s.status, s.id)
  }
}

section('G18 商城真实渠道接入结算域（A14）')
{
  const coveredIds = []
  try {
    const sku = one("SELECT id, price_retail, price_member FROM product_skus WHERE status='active' ORDER BY id LIMIT 1")
    const cust = makeProbeCustomer({ level: 'gold' })
    const token = await mallLogin(cust.phone)
    coveredIds.push(cust.id)
    ok('C 端会话登录成功（金卡探针会员）', !!token)
    // **下单前**的会员状态：后面要比的是"撤单后是否回到这里"
    const custBefore = one('SELECT points,total_orders,total_amount FROM mall_customers WHERE id=?', cust.id)

    await withProbePromotion(async (promoCode) => {
      const items = [{ sku_id: sku.id, qty: 2 }]
      const unit = Number(sku.price_member || sku.price_retail)
      const goods = Number((unit * 2).toFixed(2))

      // ① 试算（C 端会话）
      const q = await api('POST', '/api/mall/quote', { token, body: { items } })
      ok('试算接口可用（会话身份）', q.status === 200, `${q.status}`)
      ok('试算命中了探针促销', (q.body?.data?.applied_codes || []).includes(promoCode),
        JSON.stringify(q.body?.data?.applied_codes))
      ok('试算给出会员等级折扣（金卡 95 折）', q.body?.data?.member_discount > 0,
        `${q.body?.data?.member_discount}`)

      // ② 落单
      await api('POST', '/api/mall/cart', { token, body: { sku_id: sku.id, qty: 2 } })
      const o = await api('POST', '/api/mall/orders', {
        token, body: { receiver: '守卫', receiver_phone: cust.phone, address: '守卫测试地址 1 号', items }
      })
      ok('真实下单成功', o.status === 200 && o.body?.data?.id, `${o.status} ${o.body?.message || ''}`)
      const oid = o.body?.data?.id
      coveredIds.push({ oms: oid })

      // ③ **试算 = 落单**：同一份算钱判据，不然就会出现"页面一个数、收款另一个数"
      const qd = q.body?.data || {}
      const od = o.body?.data || {}
      ok('落单应付 = 试算应付（接入结算域，不是另写一套）',
        Number(od.pay_amount) === Number(qd.pay_amount),
        `落单 ${od.pay_amount} vs 试算 ${qd.pay_amount}`)
      ok('落单商品额 = price_member × 数量（基准价唯一来源）',
        Number(od.goods_amount) === goods, `${od.goods_amount} vs ${goods}`)
      ok('落单优惠 = 试算优惠', Number(od.discount_amount) === Number(qd.discount_amount),
        `${od.discount_amount} vs ${qd.discount_amount}`)

      // ④ 促销**真的参与**了：留痕 + 使用登记 + 计数器
      const adj = all("SELECT * FROM promotion_adjustments WHERE source='oms' AND order_id=? ORDER BY id", oid)
      const usg = all("SELECT * FROM promotion_usages WHERE source='oms' AND order_id=? ORDER BY id", oid)
      ok('优惠留痕落库（旧实现恒为 0）', adj.length > 0, `${adj.length} 条`)
      ok('使用登记落库', usg.length > 0, `${usg.length} 条`)
      const usedRow = one('SELECT used FROM promotions WHERE code=?', promoCode)
      ok('促销 used 计数器 +1（限量控制的前提）', Number(usedRow?.used) === 1, `${usedRow?.used}`)

      // ⑤ 行级可回溯：留痕合计 = 订单行优惠三段之和
      const lineSum = one('SELECT COALESCE(SUM(promo_discount_cents),0) s FROM oms_order_items WHERE oms_order_id=?', oid).s
      const adjSum = adj.reduce((s, a) => s + Number(a.amount), 0)
      ok('行优惠合计 = 留痕合计（优惠摊到行，退货时才算得出"这行实付多少"）',
        Number(lineSum) === adjSum, `${lineSum} vs ${adjSum}`)
      ok('每一条留痕都指向真实的订单行',
        adj.every((a) => one('SELECT id FROM oms_order_items WHERE id=?', a.item_id) != null))

      // ⑥ 积分**只有一套口径**：与 member 域一致，而不是"1 元 1 分"
      const ledger = one(
        "SELECT * FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND source='oms' AND source_id=? AND kind='earn'",
        cust.id, oid
      )
      // 送分基数是**商品实付**（不含运费）—— 运费是履约成本，不是客户消费。
      // 用 `pay_amount` 反推会在"不满 199 元要收运费"的行业库上差出一个运费
      // （餐饮库实测差 12 元 = 180 分），而抹平这个差距只需一条 `- freight`。
      const earnBaseCents = Math.round((Number(od.pay_amount) - Number(od.freight)) * 100)
      const expectPts = MB.pointsForOrder(rw, { orderAmountCents: earnBaseCents, levelCode: 'gold' })
      ok('积分按 member 域口径赠送（不是商城自己那套 1 元 1 分）',
        Number(ledger?.change_points) === expectPts,
        `实得 ${ledger?.change_points} vs 应得 ${expectPts}`)
      ok('赠送积分记下了消费基数（撤单要靠它把钱退干净）',
        Number(ledger?.base_cents) === earnBaseCents, `${ledger?.base_cents} vs ${earnBaseCents}`)
      if (expectPts !== Math.floor(Number(od.pay_amount))) {
        ok('两套口径确实不同（排除"恰好相等"的假对照）',
          Number(ledger?.change_points) !== Math.floor(Number(od.pay_amount)),
          `都等于 ${expectPts}`)
      }
      const mc = one('SELECT points FROM mall_customers WHERE id=?', cust.id)
      const ma = one('SELECT points FROM member_accounts WHERE customer_id=?', cust.id)
      ok('客户表积分 = 账户表积分（冗余列不再各说各话）',
        Number(mc?.points) === Number(ma?.points), `${mc?.points} vs ${ma?.points}`)
      ok('会员账仍然平衡（积分 = 流水合计）', MB.auditMember(rw).balanced)

      // ⑦ 撤单：**成对**回退（A15 的另一半在 G19）
      const before = custBefore
      const cc = await api('POST', `/api/mall/orders/${oid}/cancel`, { token })
      ok('C 端撤单成功', cc.status === 200, `${cc.status} ${cc.body?.message || ''}`)
      const after = one('SELECT points,total_orders,total_amount FROM mall_customers WHERE id=?', cust.id)
      const adjAfter = one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='oms' AND order_id=?", oid).c
      const usgAfter = one("SELECT COUNT(*) c FROM promotion_usages WHERE source='oms' AND order_id=?", oid).c
      ok('撤单后优惠留痕清空', Number(adjAfter) === 0, `${adjAfter}`)
      ok('撤单后使用登记清空', Number(usgAfter) === 0, `${usgAfter}`)
      ok('撤单后促销 used 回退', Number(one('SELECT used FROM promotions WHERE code=?', promoCode)?.used) === 0)
      ok('撤单后订单数与累计消费回退',
        Number(after?.total_orders) === Number(before?.total_orders) &&
        Number(after?.total_amount) === Number(before?.total_amount),
        `${JSON.stringify(before)} → ${JSON.stringify(after)}`)
    })
  } finally {
    // 用例自还原：订单/留痕/积分流水/购物车/会员 —— 一样不留
    for (const c of coveredIds) {
      if (typeof c === 'object' && c.oms) {
        rw.prepare('DELETE FROM promotion_adjustments WHERE source=\'oms\' AND order_id=?').run(c.oms)
        rw.prepare('DELETE FROM promotion_usages WHERE source=\'oms\' AND order_id=?').run(c.oms)
        rw.prepare('DELETE FROM oms_order_items WHERE oms_order_id=?').run(c.oms)
        rw.prepare('DELETE FROM oms_orders WHERE id=?').run(c.oms)
      }
    }
  }
}

// ===========================================================================
// G19 撤单的**逆向**必须成对（A15）：退抵现积分、扣回赠送、回退累计消费、可重复调用
//
// 旧实现只扣了"赠送"，**没有把抵现用掉的积分退回去** —— 客户撤单白丢一笔积分，
// 而且丢得没有任何痕迹；累计消费也不回退，于是一张撤掉的单继续顶着他的会员等级。
// ===========================================================================
section('G19 撤单逆向闭环与幂等（A15）')
{
  const covered = []
  try {
    const sku = one("SELECT id FROM product_skus WHERE status='active' ORDER BY id LIMIT 1")
    const cust = makeProbeCustomer({ level: 'silver', points: 200000 })
    const token = await mallLogin(cust.phone)
    const acc0 = one('SELECT points, points_total, total_spent_cents FROM member_accounts WHERE customer_id=?', cust.id)
    const cust0 = one('SELECT points,total_orders,total_amount FROM mall_customers WHERE id=?', cust.id)

    await withProbePromotion(async () => {
      const items = [{ sku_id: sku.id, qty: 1 }]
      const q0 = await api('POST', '/api/mall/quote', { token, body: { items } })
      const maxPts = q0.body?.data?.points_quote?.maxPoints ?? 0
      ok('试算给出积分抵扣上限（按优惠后金额推导）', maxPts > 0, `${maxPts}`)

      const o = await api('POST', '/api/mall/orders', {
        token, body: { receiver: '守卫', receiver_phone: cust.phone, address: '守卫测试地址 2 号', items, use_points: maxPts }
      })
      ok('带积分抵现下单成功', o.status === 200, `${o.status} ${o.body?.message || ''}`)
      const oid = o.body?.data?.id
      covered.push(oid)
      const acc1 = one('SELECT points FROM member_accounts WHERE customer_id=?', cust.id)
      ok('下单后积分确实被抵扣', Number(acc1.points) < Number(acc0.points), `${acc0.points} → ${acc1.points}`)

      // 撤单
      const cc = await api('POST', `/api/mall/orders/${oid}/cancel`, { token })
      ok('撤单成功', cc.status === 200, `${cc.status}`)
      const rev = cc.body?.data?.points_reverted || {}
      ok('**抵现积分被退回**（旧实现完全不退）', Number(rev.points_returned) > 0, JSON.stringify(rev))
      ok('赠送积分被扣回', Number(rev.points_clawed) < 0, JSON.stringify(rev))
      const acc2 = one('SELECT points, points_total, total_spent_cents FROM member_accounts WHERE customer_id=?', cust.id)
      ok('撤单后积分余额回到下单前', Number(acc2.points) === Number(acc0.points),
        `${acc0.points} → ${acc2.points}`)
      ok('撤单后累计消费回到下单前', Number(acc2.total_spent_cents) === Number(acc0.total_spent_cents),
        `${acc0.total_spent_cents} → ${acc2.total_spent_cents}`)
      ok('撤单后累计积分不后退（累计获得只增不减）',
        Number(acc2.points_total) >= Number(acc0.points_total), `${acc0.points_total} → ${acc2.points_total}`)
      const cust2 = one('SELECT total_orders,total_amount FROM mall_customers WHERE id=?', cust.id)
      ok('撤单后订单数与累计消费额回退',
        Number(cust2.total_orders) === Number(cust0.total_orders) &&
        Number(cust2.total_amount) === Number(cust0.total_amount),
        `${JSON.stringify(cust0)} → ${JSON.stringify(cust2)}`)
      ok('撤单后会员账仍然平衡', MB.auditMember(rw).balanced)
      ok('撤单标记落库（source_type=order_reverse）',
        Number(one("SELECT COUNT(*) c FROM member_points_ledger WHERE source_type='order_reverse' AND source='oms' AND source_id=?", oid).c) > 0)

      // 幂等：直接再调一次 unsettle（绕过状态门）——不得把积分退两遍
      const again = CO.unsettle(rw, { source: 'oms', orderId: oid, reason: '守卫测试：重复撤单', orderAmountCents: 0 })
      const acc3 = one('SELECT points FROM member_accounts WHERE customer_id=?', cust.id)
      ok('重复撤单被幂等挡住（不重复退分）',
        again.points_reverted?.skipped === 'already_reversed' && Number(acc3.points) === Number(acc2.points),
        `${again.points_reverted?.skipped} / ${acc3.points}`)
      // 口径变更而更新的断言（**不是为了让测试变绿而放松**，也不是回归 —— 见下面两个证明）。
      //
      // 原来这里是 `…status === 'closed'`。而 `'closed'` **不在 `STATES.OM` 里**
      // （OM = pending / shipped / completed / refunded / cancelled）——
      // 撤单当时是一句裸 `UPDATE oms_orders SET status='closed'`，于是这条断言
      // **把"写一个内核不认识的值"写成了判据**：它绿着，就没人再问那个值合不合法。
      // 后果是那张单从此**内核看不见**：`allowedActions('OM','closed')` 返回空、
      // 不进任何按内核状态驱动的口径。
      //
      // 现在撤单走内核（`pending --cancel--> cancelled`，同事务写 doc_events）。
      // 断言仍是**一条**（保持"回收段唯一出处"的既有结构），但判据换成三个：
      //   ① **具体期望值** = `cancelled`；
      //   ② 它必须是**内核认识**的值 —— 拿 `doc_states` 查，**不在断言里再写一份字面量清单**
      //      （再写一份就是"判据两处实现"：将来内核改状态名，这条断言又会替旧名字站岗）；
      //   ③ 撤单必须**留痕**（含操作人）—— 原来那条**只**看值、不看痕，
      //      而"无痕"正是这次缺陷的另一半（裸 UPDATE 不写 doc_events）。
      const stAfterCancel = one('SELECT status FROM oms_orders WHERE id=?', oid)?.status
      ok(
        '撤单后 oms 单状态是内核认识的 cancelled',
        stAfterCancel === 'cancelled' &&
          !!one("SELECT 1 AS hit FROM doc_states WHERE doc_type='OM' AND code=?", stAfterCancel) &&
          !!one(
            "SELECT 1 AS hit FROM doc_events WHERE doc_type='OM' AND doc_id=? AND action='cancel' AND from_state='pending' AND to_state='cancelled' AND actor_name IS NOT NULL",
            oid
          ),
        `${stAfterCancel}`
      )
    })
  } finally {
    for (const oid of covered) {
      rw.prepare("DELETE FROM promotion_adjustments WHERE source='oms' AND order_id=?").run(oid)
      rw.prepare("DELETE FROM promotion_usages WHERE source='oms' AND order_id=?").run(oid)
      rw.prepare('DELETE FROM oms_order_items WHERE oms_order_id=?').run(oid)
      rw.prepare('DELETE FROM oms_orders WHERE id=?').run(oid)
    }
  }
}

// ===========================================================================
// G20 来源通道（迁移 030）：`oms_orders.id` 与 `pos_orders.id` 会撞号
//
// 商城第 418 单与门店第 418 单在留痕表里长得一模一样 ——
// 只按 order_id 定位会让撤单撤到别人头上、让第二张单的送分被判成重复而**静默不送**。
// 这一组就是那四条串号路径的守卫。
// ===========================================================================
section('G20 留痕按「通道 + 单号」定位（迁移 030）')
{
  const covered = []
  try {
    const dup = one(`
      SELECT o.id FROM oms_orders o JOIN pos_orders p ON p.id = o.id ORDER BY o.id LIMIT 1`)
    ok('库内存在同号的商城单与门店单（撞号场景真实存在）', !!dup?.id, JSON.stringify(dup))
    if (dup?.id) {
      const X = Number(dup.id)
      const omsItems = all('SELECT id FROM oms_order_items WHERE oms_order_id=? ORDER BY id', X).map((r) => r.id)
      const posItems = all('SELECT id FROM pos_order_items WHERE pos_order_id=? ORDER BY id', X).map((r) => r.id)
      const cust = makeProbeCustomer({ level: 'normal' })
      covered.push({ cust: cust.id })

      await withProbePromotion(async (promoCode) => {
        // 单价必须用**真实零售价**：营销域有 `price_min` 地板，编一个低于地板的单价
        // 会让折扣被地板吃掉，结算出 0 条 action —— 看起来像"促销没生效"。
        const sku0 = one("SELECT id, price_retail FROM product_skus WHERE status='active' ORDER BY id LIMIT 1")
        const unitCents = Math.round(Number(sku0.price_retail) * 100)
        const mk = (ids) => ids.slice(0, 1).map((id) => ({ item_id: id, sku_id: sku0.id, qty: 1, unit_price_cents: unitCents }))
        // 两张同号的单各结算一次：幂等键带通道，所以**都该登记成功**
        const sOms = CO.settle(rw, {
          source: 'oms', orderId: X, items: CO.buildItems(rw, mk(omsItems)), customerId: cust.id
        })
        const sPos = CO.settle(rw, {
          source: 'pos', orderId: X, items: CO.buildItems(rw, mk(posItems)), customerId: cust.id
        })
        ok('同号的两张单都能登记使用（不带通道时第二张会被判重复而静默跳过）',
          Number(sOms.usage.registered) >= 1 && Number(sPos.usage.registered) >= 1,
          `oms=${sOms.usage.registered} pos=${sPos.usage.registered}`)
        const adjOms = Number(one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='oms' AND order_id=?", X).c)
        const adjPos = Number(one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='pos' AND order_id=?", X).c)
        ok('两张同号单各有自己的留痕', adjOms > 0 && adjPos > 0, `oms=${adjOms} pos=${adjPos}`)
        ok('同号的两张单都拿到了赠送积分',
          Number(one("SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source='oms' AND source_id=? AND kind='earn'", cust.id, X).c) > 0 &&
          Number(one("SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source='pos' AND source_id=? AND kind='earn'", cust.id, X).c) > 0)

        // 只撤 oms：pos 的留痕与积分必须原封不动
        const rv = PR.revertUsage(rw, { source: 'oms', orderId: X })
        const posLeft = Number(one("SELECT COUNT(*) c FROM promotion_usages WHERE source='pos' AND order_id=?", X).c)
        ok('只撤 oms 时 pos 的留痕不受影响（旧实现会把两张单一起撤掉）',
          posLeft > 0, `剩下 ${posLeft} 条；revert 报告 ${JSON.stringify(rv)}`)
        ok('oms 的留痕已清空',
          Number(one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='oms' AND order_id=?", X).c) === 0)

        // 券同样按通道定位
        const tpl = CP.createCoupon(rw, {
          code: `GUARD_SRC_${Date.now() % 100000}`, name: '守卫券（撞号用）',
          promotion_id: one("SELECT id FROM promotions WHERE code=?", promoCode).id,
          type: 'fixed', value: 1000, min_subtotal: 0, per_user_limit: 2, valid_days: 30
        })
        const iss = CP.issueCoupons(rw, { couponId: tpl.id, customerId: cust.id, qty: 2, remark: '守卫测试' })
        CP.redeemCoupon(rw, { code: iss.codes[0], source: 'oms', orderId: X, customerId: cust.id, amountCents: 1000 })
        CP.redeemCoupon(rw, { code: iss.codes[1], source: 'pos', orderId: X, customerId: cust.id, amountCents: 1000 })
        CP.releaseCoupon(rw, { source: 'pos', orderId: X, remark: '守卫测试退回' })
        ok('退券只退回本通道的那一张（旧实现按 order_id 会把两张一起退）',
          one('SELECT status FROM coupon_instances WHERE coupon_code=?', iss.codes[0]).status === 'used' &&
          one('SELECT status FROM coupon_instances WHERE coupon_code=?', iss.codes[1]).status === 'unused')
        rw.prepare('DELETE FROM coupon_instances WHERE coupon_id=?').run(tpl.id)
        rw.prepare('DELETE FROM promotion_methods WHERE promotion_id=?').run(tpl.promotion_id)
        rw.prepare('DELETE FROM coupons WHERE id=?').run(tpl.id)

        // 收尾：把 pos 侧的那次结算也撤掉，别给后续用例留残渣
        CO.unsettle(rw, { source: 'pos', orderId: X, reason: '守卫测试清理', orderAmountCents: 0 })
      })
      ok('G20 用例自还原：oms 侧留痕已清空',
        Number(one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='oms' AND order_id=?", X).c) === 0)
      ok('G20 用例自还原：pos 侧留痕已清空',
        Number(one("SELECT COUNT(*) c FROM promotion_adjustments WHERE source='pos' AND order_id=?", X).c) === 0)
    }
  } finally {
    for (const c of covered) {
      rw.prepare('DELETE FROM member_points_ledger WHERE customer_id=?').run(c.cust)
      rw.prepare('DELETE FROM member_balance_ledger WHERE customer_id=?').run(c.cust)
      rw.prepare('DELETE FROM member_accounts WHERE customer_id=?').run(c.cust)
      rw.prepare('DELETE FROM mall_cart_items WHERE phone IN (SELECT phone FROM mall_customers WHERE id=?)').run(c.cust)
      rw.prepare('DELETE FROM mall_customers WHERE id=?').run(c.cust)
    }
  }
}

dropGuardTriggers()

// ==========================================================================
section('信用拦截的应答形状（HTTP 级对外契约）')
// 为什么这条必须落在**守卫**文件里：`routes/sales.js` 那处把信用明细**展平**进 `detail`
// （原先塞在 `detail.detail` 里），而 `POST /api/sales/orders/:id/confirm` 在 `src/` 下
// **没有前端调用点**、`scripts/` 里也只有 lib 级的 `test-quote-credit.mjs`（它读的是
// `e.code`，不走 HTTP）⇒ **改回旧形状没有任何测试会红**。这条补的就是那个缺口：
// 形状是**对外契约**，契约没人看着就等于没有。
//
// 「证否替代解释」那一步（下面第 6 条：`credit_check_logs` 里有本次 `result='block'`）
// 不能省，也不能只在一次性探针里做过就算：**409 有很多来源**（状态不对、权限不足、
// 并发冲突…），只有这一条能证明"这个 409 确实是信用闸门拦的"，而不是另一个凑巧也返 409 的分支。
{
  const dealerId = soDealer.dealer_id
  let acc = one("SELECT * FROM credit_accounts WHERE subject_type='dealer' AND subject_id=?", dealerId)
  let accBackup = null
  if (acc) {
    // 复用既有账户：把额度压到 1 让"超信"必然命中，收尾**写回原值**
    accBackup = { id: acc.id, credit_limit: acc.credit_limit, temp_limit: acc.temp_limit, temp_expire_at: acc.temp_expire_at, status: acc.status }
    rw.prepare("UPDATE credit_accounts SET credit_limit=1, temp_limit=0, temp_expire_at=NULL, status='active' WHERE id=?").run(acc.id)
  } else {
    // 该经销商没建档（未授信 = 不拦），就自造一个探针账户；收尾删掉
    const info = rw
      .prepare(
        `INSERT INTO credit_accounts (subject_type,subject_id,code,name,credit_limit,credit_days,temp_limit,status)
         VALUES ('dealer',?,?,?,1,0,0,'active')`
      )
      .run(dealerId, `GUARD${dealerId}`, '守卫探针账户')
    acc = { id: Number(info.lastInsertRowid) }
  }
  const docNo = `GUARD-CREDIT-${Date.now()}`
  const soId = Number(
    rw
      .prepare(
        `INSERT INTO sales_orders (doc_no,channel,dealer_id,order_date,status,receivable_amount)
         VALUES (?,'dealer',?,date('now','localtime'),'draft',999999)`
      )
      .run(docNo, dealerId).lastInsertRowid
  )

  const resp = await api('POST', `/api/sales/orders/${soId}/confirm`, { token: adminJwt, body: {} })
  const b = resp.body || {}
  ok('信用拦截：HTTP 409', resp.status === 409, `${resp.status} ${JSON.stringify(b).slice(0, 200)}`)
  ok("信用拦截：顶层 error === 'CREDIT_BLOCKED'", b.error === 'CREDIT_BLOCKED', b.error)
  ok(
    "信用拦截：detail.code === 'CREDIT_BLOCKED' 且与顶层 error 同值",
    b.detail?.code === 'CREDIT_BLOCKED' && b.detail?.code === b.error,
    `${b.detail?.code} / ${b.error}`
  )
  ok(
    '信用拦截：**没有** detail.detail（明细已展平，不该再套一层）',
    !!b.detail && !Object.prototype.hasOwnProperty.call(b.detail, 'detail'),
    Object.keys(b.detail || {}).join(',')
  )
  ok(
    '信用拦截：detail.blocking[0].code 是已知拦截原因（展平没把明细吃掉）',
    ['CREDIT_OVER', 'CREDIT_FROZEN', 'CREDIT_OVERDUE'].includes(b.detail?.blocking?.[0]?.code),
    JSON.stringify(b.detail?.blocking?.[0] || null).slice(0, 160)
  )
  const clog = one(
    "SELECT result, reason FROM credit_check_logs WHERE source_type='SO' AND source_id=? ORDER BY id DESC LIMIT 1",
    soId
  )
  ok(
    "信用拦截：credit_check_logs 留下本次 result='block'（证否替代解释：409 确实来自信用闸门）",
    clog?.result === 'block',
    JSON.stringify(clog)
  )

  // 自还原：探针订单 / 检查日志一定删；账户按上面两种情形分别写回或删除
  rw.prepare("DELETE FROM credit_check_logs WHERE source_type='SO' AND source_id=?").run(soId)
  rw.prepare('DELETE FROM sales_order_items WHERE order_id=?').run(soId)
  rw.prepare('DELETE FROM sales_orders WHERE id=?').run(soId)
  if (accBackup) {
    rw.prepare('UPDATE credit_accounts SET credit_limit=?, temp_limit=?, temp_expire_at=?, status=? WHERE id=?').run(
      accBackup.credit_limit, accBackup.temp_limit, accBackup.temp_expire_at, accBackup.status, accBackup.id
    )
  } else {
    rw.prepare('DELETE FROM credit_accounts WHERE id=?').run(acc.id)
  }
  const restoredAcc = accBackup
    ? Number(one('SELECT credit_limit FROM credit_accounts WHERE id=?', accBackup.id)?.credit_limit) === Number(accBackup.credit_limit)
    : !one('SELECT id FROM credit_accounts WHERE id=?', acc.id)
  ok(
    '用例自还原：探针订单与信用检查日志已清除，信用账户回到用例前状态',
    !one('SELECT id FROM sales_orders WHERE id=?', soId) &&
      !one("SELECT id FROM credit_check_logs WHERE source_type='SO' AND source_id=?", soId) &&
      restoredAcc
  )
}

// A20 之后的用例自还原：把自造的探针用户删掉（本文件所有跨主体用例都依赖它们）
if (probeUserIds.length) {
  rw.prepare(`DELETE FROM users WHERE id IN (${probeUserIds.map(() => '?').join(',')})`).run(...probeUserIds)
}
ok('用例自还原：自造探针用户已清除', probeUserIds.every((id) => !one('SELECT id FROM users WHERE id=?', id)))

// 自造探针会员同理：会员是**派生余额**（= 两本流水之和），留一行就会让
// `auditMember` / `verify-seed` 在下一轮报"余额对不上流水"。整条链删干净。
for (const cid of probeCustomerIds) {
  rw.prepare('DELETE FROM member_points_ledger WHERE customer_id=?').run(cid)
  rw.prepare('DELETE FROM member_balance_ledger WHERE customer_id=?').run(cid)
  rw.prepare('DELETE FROM member_accounts WHERE customer_id=?').run(cid)
  rw.prepare('DELETE FROM mall_cart_items WHERE phone IN (SELECT phone FROM mall_customers WHERE id=?)').run(cid)
  rw.prepare('DELETE FROM mall_customers WHERE id=?').run(cid)
}
ok('用例自还原：自造探针会员已清除',
  probeCustomerIds.every((id) => !one('SELECT id FROM mall_customers WHERE id=?', id)))
ok('用例自还原：探针促销已清除', probePromoCodes.every((code) => !one('SELECT id FROM promotions WHERE code=?', code)))

rw.close()
db.close()
// 先回收服务端再打收尾：这样"回收"本身也能进判据（不只看我们自己 console.log 了一行）
const reclaimedOk = await reclaim()
console.log(reclaimedOk ? `[回收] 已回收 pid ${srv.pid}` : `[回收] 回收失败，pid ${srv.pid} 仍在`)
// 判据取**独立观测量**（直接探测 pid），不取 reclaim() 的返回值 ——
// 否则"kill 被删掉但仍旧返回 true"这种改坏方式不会被发现。
ok(
  '子进程回收：服务端进程已消失（直接探测 pid，不看 kill() 的返回值）',
  !pidAlive(srv.pid),
  `pid ${srv.pid}`
)
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
