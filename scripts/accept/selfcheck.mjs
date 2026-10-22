#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/selfcheck.mjs ｜ 独立验收：独立验收（自查）：全新三库 + 独立端口 + 真实 HTTP + 真实令牌 + 独立写反例 + 核验库副作用
 * ============================================================================
 * 【职责】独立验收：独立验收（自查）：全新三库 + 独立端口 + 真实 HTTP + 真实令牌 + 独立写反例 + 核验库副作用
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
 * 独立验收（自查）：全新三库 + 独立端口 + 真实 HTTP + 真实令牌 + 独立写反例 + 核验库副作用
 *
 * 为什么单独写一套，而不是复用 test-*.mjs：
 *   项目里那些套件跑的是**开发库**、断言的是**内部函数**。而验收要回答的是另一个问题 ——
 *   「站在外面、用一个真实令牌、打一个真实端口，能不能把这件事做坏」。
 *   两者的失效方式不一样：套件绿了仍然漏掉 D2/D3/D4 的全部反例（已有前例）。
 *
 * 与开发库的隔离（硬约束）：
 *   ① 数据目录走 `GML_DATA_DIR`，指向 /tmp 下一个**全新**目录 —— `data/gml_*.db` 一个字节都不碰；
 *   ② 端口走 `PORT`，默认 42351（与常驻服务的 3001 不冲突）；
 *   ③ 服务是**子进程**，跑完必杀；临时目录保留路径写进证据，便于复查。
 *
 * 用法：node scripts/accept/selfcheck.mjs [--keep]
 *   ⚠️ 本脚本的参数**只有一个入口但有两个来路**：`run-on-copy.mjs` 会把命令行参数
 *      **原样转发**过来（它自己不加参数），所以 `node scripts/accept/run-on-copy.mjs --keep`
 *      最终落到这里 —— 不是两套参数，是同一套。
 *   口径「丁」：**不认识的参数一律拒绝**（打用法 + 非 0 退出），不许静默忽略：
 *      有人传 `--dry` 以为"只解析、不跑"，实际会**跑完 220 项完整自检**、并**按设计重写**
 *      那两份证据 JSON（`docs/evidence/独立验收_必打反例_*.json` / `独立验收_端到端HTTP清单.md`）。
 *      静默忽略一个无意义的动作，与本批缺陷 186（`qty:-5` 静默成功）同一族。
 *   判据（同族口径）：**闸门认得的形状，必须与生效时真正读取的形状，来自同一次解析。**
 *      原来闸门不存在、`KEEP` 又按 `argv.includes('--keep')` 整串相等读 —— 两句不同源；
 *      现在两者都从下面那一次解析结果读。
 */
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 参数：只解析一次，闸门与行为都读它（裸开关只认整字，`--keep=1` 判非法）
const USAGE = [
  '用法: node scripts/accept/selfcheck.mjs [--keep]',
  '  --keep   保留 /tmp 数据目录便于复查',
  '  --help   只打这份用法',
  '  （本脚本只认这两个；`run-on-copy.mjs` 会把参数原样转发到这里，是同一套参数）'
].join('\n')
const NO_VALUE = new Set(['--keep', '--help'])
const FLAGS = new Set()
const badArgs = []
for (const a of process.argv.slice(2)) {
  if (NO_VALUE.has(a)) { FLAGS.add(a); continue }  // 整字相符才算；`--keep=1` 落到下一行被拒
  badArgs.push(a)
}
if (badArgs.length) {
  console.error(`❌ 不认识的参数（或写法不对）：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (FLAGS.has('--help')) { console.log(USAGE); process.exit(0) }

const PORT = Number(process.env.ACCEPT_PORT || 42351)
const BASE = `http://127.0.0.1:${PORT}`
const KEEP = FLAGS.has('--keep')

// ---------- 断言收集 ----------
const results = []
let httpChecklist = []
let cur = '(未分组)'
const group = (n) => { cur = n; console.log(`\n── ${n}`) }
const ok = (name, cond, detail) => {
  const pass = !!cond
  results.push({ group: cur, name, pass, detail: detail === undefined ? null : detail })
  console.log(`  ${pass ? '✓' : '✗'} ${name}${pass || detail === undefined ? '' : '  → ' + JSON.stringify(detail).slice(0, 300)}`)
  return pass
}
const eq = (name, a, b) => ok(name, a === b, `实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}`)

// ---------- 环境 ----------
const TMP = mkdtempSync(path.join(tmpdir(), 'gml-accept-'))
const DATA = path.join(TMP, 'data')
mkdirSync(DATA, { recursive: true })
process.env.GML_DATA_DIR = DATA

// 结论必须挂在**一个确定的提交**上：换了代码或工作区脏了，同一份证据就不能再代表它。
// 在独立副本里跑时副本**没有 .git**（刻意不复制），所以 SHA 由 run-on-copy 通过环境变量传进来 ——
// 否则证据里会记成 null，而"null 的 SHA"等于"不知道验的是哪一版"。
const sha = process.env.GML_ACCEPT_SHA || (() => { try { return spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() } catch { return null } })()
const dirty = process.env.GML_ACCEPT_DIRTY !== undefined
  ? process.env.GML_ACCEPT_DIRTY
  : (() => { try { return spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim() } catch { return '' } })()
// ---------- 隔离性：**不"宣称"，只记可观察事实** ----------
//
// 这里原来是一个布尔：`const isCopy = ROOT !== '<硬编码的绝对路径>'`。
// 它比的是**字面量**，所以：换一台机器、把仓库搬到别处、甚至换个大小写不同的盘符，
// 都会得到"是独立副本" —— 而它**没有量过任何东西**（铁律 11：自称的元信息必须由实算派生）。
// 反过来，产物里 `is_isolated_copy: false` 时，读者也**无从知道为什么**：是"确实在工作区跑"，
// 还是"在副本里跑但这个字面量恰好相等"？两种情况输出一样 ⇒ 这条字段既不能证实也不能证伪。
//
// 现在改成一组**互相能证伪**的事实，让读者自己下结论（不做平均、也不给一个"总论"布尔）：
//   · git_toplevel / repo_root_at_runtime —— 去问 git 本身。副本建在 /tmp，**不在任何仓库里**
//     ⇒ 副本里这个值是 null；工作区里它会等于仓库根。它是**运行时问出来的**，不是字面量。
//   · has_git_dir  —— 副本**刻意不复制** `.git` ⇒ 副本里必为 false。结构性证据。
//   · has_data_dir —— 副本**刻意不复制** `data/` ⇒ 副本里必为 false。结构性证据。
//   · sentinel     —— 由 `run-on-copy.mjs` 写进**副本**的哨兵文件（含**源仓库** HEAD sha 与复制时间）。
//     **只有 run-on-copy 会写它**，所以"哨兵在"是"我确实在副本里"最硬的证据；
//     它同时解决了"这份证据该挂在哪个提交上"。
//   · harness_declared_copy —— run-on-copy 通过环境变量**声明**的。**这只是声明**，
//     单独放在一个字段里，与上面那些实测字段**分开**，不许混着读。
// 几条信号互相矛盾时（例如"有哨兵"却"有 .git"），如实列进 `contradictions`，**不做平均**。
const SENTINEL_PATH = process.env.GML_ACCEPT_SENTINEL || path.join(ROOT, '.accept-sentinel.json')
const sentinel = (() => { try { return JSON.parse(readFileSync(SENTINEL_PATH, 'utf8')) } catch { return null } })()
const gitToplevel = (() => {
  try {
    const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: ROOT, encoding: 'utf8' })
    return r.status === 0 && r.stdout.trim() ? r.stdout.trim() : null
  } catch { return null }
})()
const hasGitDir = existsSync(path.join(ROOT, '.git'))
const hasDataDir = existsSync(path.join(ROOT, 'data'))
const declaredCopy = process.env.GML_ACCEPT_IS_COPY === undefined ? null : process.env.GML_ACCEPT_IS_COPY === '1'

const contradictions = []
if (sentinel && hasGitDir) contradictions.push('哨兵存在（只有 run-on-copy 会写它）但 ROOT 下有 .git —— 副本刻意不含 .git，两者不可能同时为真')
if (sentinel && gitToplevel) contradictions.push(`哨兵存在，但 git 认为 ROOT 落在仓库「${gitToplevel}」里 —— 副本建在 /tmp，不该在任何仓库内`)
if (declaredCopy === true && !sentinel) contradictions.push('harness 声明是副本，但找不到哨兵 —— 声明缺少可观察事实支撑')
if (declaredCopy === false && sentinel) contradictions.push('harness 声明不是副本，却找到了哨兵')
if (sentinel?.source_head_sha && sha && sentinel.source_head_sha !== sha) {
  contradictions.push(`哨兵记的源 HEAD（${String(sentinel.source_head_sha).slice(0, 8)}）与本次证据里的提交（${String(sha).slice(0, 8)}）不一致`)
}
const isolationFacts = {
  source_root: ROOT,
  // 运行时问 git 得到的仓库根；不在任何仓库里就是 null（副本的正常取值）
  repo_root_at_runtime: gitToplevel,
  has_git_dir: hasGitDir,
  has_data_dir: hasDataDir,
  sentinel: sentinel ? { path: SENTINEL_PATH, ...sentinel } : null,
  harness_declared_copy: declaredCopy, // ⚠️ 只是 harness 的声明，不是实测
  contradictions
}
// 控制台只给一句"由事实推出的概述"，并**把矛盾喊出来** —— 不写"是不是副本"的断言
const isoSummary = sentinel
  ? `疑似独立副本（有哨兵；源 HEAD ${String(sentinel.source_head_sha || '?').slice(0, 8)}）`
  : gitToplevel || hasGitDir
    ? '工作区（在 git 仓库内，无哨兵）'
    : '未知（既无哨兵，也不在任何 git 仓库里）'
const commitShaSource = sha ? (process.env.GML_ACCEPT_SHA !== undefined ? 'env：harness 传入' : 'git：实测 rev-parse') : 'none'

console.log(
  `独立验收台\n  被测源码 ${ROOT}  （${isoSummary}）\n  提交 ${sha}（来源 ${commitShaSource}）${dirty ? `（工作区有 ${dirty.split('\n').length} 处改动）` : '（干净）'}\n  临时数据目录 ${DATA}\n  端口 ${PORT}`
)
if (contradictions.length) {
  console.log(`  ⚠️ 隔离性信号互相矛盾（${contradictions.length} 条，已写进产物，不做平均）：`)
  for (const c of contradictions) console.log(`     · ${c}`)
}

const { bootAll } = await import(path.join(ROOT, 'server/db/boot.js'))
const t0 = Date.now()
bootAll({ force: true, log: () => {} })
console.log(`  全新三库就绪，${((Date.now() - t0) / 1000).toFixed(1)}s`)

let child = null
// 崩了也要收工：服务是子进程、临时目录在 /tmp —— 不收拾就会留下一堆孤儿进程与目录，
// 下一轮跑起来端口被占，报的错与真实原因毫无关系。
const cleanup = () => {
  try { if (child && !child.killed) child.kill('SIGKILL') } catch {}
  if (!KEEP) { try { rmSync(TMP, { recursive: true, force: true }) } catch {} }
}
process.on('exit', cleanup)
process.on('uncaughtException', (e) => { console.error(e); cleanup(); process.exit(3) })
process.on('SIGINT', () => { cleanup(); process.exit(3) })
async function startServer() {
  child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, GML_DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  child.stdout.on('data', (d) => { log += d })
  child.stderr.on('data', (d) => { log += d })
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try {
      const r = await fetch(`${BASE}/api/meta/health`)
      if (r.ok) return { ok: true, log }
    } catch {}
  }
  return { ok: false, log }
}
const stopServer = () => new Promise((r) => { if (!child) return r(); child.once('exit', r); child.kill('SIGKILL') })

const up = await startServer()
if (!up.ok) {
  console.error('服务未起来，日志尾部：\n' + up.log.split('\n').slice(-30).join('\n'))
  process.exit(2)
}

// ---------- HTTP 助手 ----------
async function api(method, p, { token, industry = 'cosmetic', body, headers = {} } = {}) {
  const h = { 'content-type': 'application/json', 'x-industry': industry, ...headers }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  let b = null
  try { b = await r.json() } catch {}
  return { status: r.status, body: b, beCode: b?.detail?.code || b?.error || null, msg: b?.message || b?.error || null, data: b?.data }
}
async function mcp(token, name, args, headers = {}) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const j = await r.json().catch(() => null)
  const txt = j?.result?.content?.[0]?.text
  let payload = null
  try { payload = JSON.parse(txt) } catch {}
  return { http: r.status, isError: !!j?.result?.isError, rpcError: j?.error || null, payload, j }
}
const login = async (username, password = '123456') => {
  const r = await api('POST', '/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
  return r.data?.token || null
}

// ---------- 库副作用核对（只读临时库） ----------
const Database = (await import(path.join(ROOT, 'node_modules/better-sqlite3/lib/index.js'))).default
let db = null
const openDb = (industry = 'cosmetic') => {
  db = new Database(path.join(DATA, `gml_${industry}.db`), { readonly: true })
  return db
}
const q1 = (sql, ...a) => db.prepare(sql).get(...a)
const qa = (sql, ...a) => db.prepare(sql).all(...a)

// 一条**独立可写**连接（S17 专用，用完立刻 close）。
// 为什么需要它：库存参数（`inv_params.block_pending_qc`）有**进程内缓存**，且没有任何 HTTP 写入口 ——
// 从外面改库，服务进程看不见（它缓存的是改之前的值）。而 A13 那条判据要验的恰恰是
// 「把参数置 1 之后，待检批次才被挡」。所以这一段在**同一进程里直调库存引擎**
// （与 `test-guards.mjs` 的 A11/A13 同一路子），并且用完把参数**还原**。
// 独立连接而不是复用只读连接：只读连接写不了，而这条只在 S17 用、不与其他节共享。
const openWrite = () => new Database(path.join(DATA, 'gml_cosmetic.db'))

// ==========================================================================
group('S1 环境自证 —— 这套东西到底跑在哪')
// ==========================================================================
ok('数据目录不是开发库', !DATA.includes(path.join(ROOT, 'data')), DATA)
ok('服务健康', true)
openDb('cosmetic')
const devTouched = q1("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name='report_config_audit_log'").c > 0
ok('临时库结构完整（新表在）', devTouched)
eq('三库都建起来了', ['cosmetic', 'food', 'apparel'].every((i) => { try { openDb(i); return true } catch { return false } }), true)
openDb('cosmetic')
const admin = await login('admin', '12345')
ok('admin 拿到真实令牌', !!admin, admin ? `长度 ${admin.length}` : '登录失败')
const viewer = await login('viewer')
const finance = await login('finance')
const sales = await login('sales')
const warehouse = await login('warehouse')
ok('其余演示账号可登录', [viewer, finance, sales, warehouse].every(Boolean))

// ==========================================================================
group('S2 A01 残留 —— 通用流转入口有没有绕过领域副作用')
// ==========================================================================
const so = q1("SELECT * FROM sales_orders WHERE status IN ('shipped','completed') ORDER BY id LIMIT 1")
ok('找到一张已发货销售订单作为样本', !!so, so && { id: so.id, doc_no: so.doc_no, status: so.status })
const beforeSoStatus = q1('SELECT status FROM sales_orders WHERE id=?', so.id).status
const t1 = await api('POST', '/api/docflow/transition', { token: admin, body: { doc_type: 'SO', id: so.id, action: 'cancel' } })
eq('SO 走通用入口被拒（HTTP 409）', t1.status, 409)
eq('拒绝码是 EFFECT_REQUIRES_BUSINESS_API', t1.beCode, 'EFFECT_REQUIRES_BUSINESS_API')
eq('SO 状态一个字节都没动', q1('SELECT status FROM sales_orders WHERE id=?', so.id).status, beforeSoStatus)

// 旁路：采购结算 / 付款的动态动作路由（A01 声称已收口的残留处）
const st = q1('SELECT * FROM purchase_settlements ORDER BY id LIMIT 1')
ok('找到一张采购结算单作为样本', !!st, st && { id: st.id, doc_no: st.doc_no, status: st.status })
if (st) {
  const r = await api('POST', `/api/purchase/settlements/${st.id}/settle`, { token: viewer, body: {} })
  ok('viewer 结算采购结算单被拒（403）', r.status === 403, { status: r.status, code: r.beCode, msg: r.msg })
  eq('结算单状态未变', q1('SELECT status FROM purchase_settlements WHERE id=?', st.id).status, st.status)
}
// 取样本要"挑对的"：`pay` 这条边只在 approved 状态存在 —— 拿第一张（可能是 draft）
// 会走到"边不存在 ⇒ 放行 ⇒ 域内报 PAY_NOT_APPROVED"，那样验的不是权限门。
const pay = q1("SELECT * FROM purchase_payments WHERE status='approved' ORDER BY id LIMIT 1")
if (pay) {
  const r = await api('POST', `/api/purchase/payments/${pay.id}/pay`, { token: viewer, body: {} })
  ok('viewer 付款被拒（403）', r.status === 403, { status: r.status, code: r.beCode })
  eq('付款单状态未变', q1('SELECT status FROM purchase_payments WHERE id=?', pay.id).status, pay.status)
}

// 单据级越权：门店账号动别人的单
const store1 = await login('store01')
const otherSo = q1("SELECT * FROM sales_orders WHERE status IN ('shipped','completed') AND store_id IS NOT NULL AND store_id <> (SELECT store_id FROM users WHERE username='store01') ORDER BY id LIMIT 1")
if (store1 && otherSo) {
  const r = await api('POST', '/api/docflow/transition', { token: store1, body: { doc_type: 'SO', id: otherSo.id, action: 'cancel' } })
  ok('门店账号动别家门店的单被拒', r.status === 403 || r.status === 404, { status: r.status, code: r.beCode, msg: r.msg })
}

// 审批提交入口：批次 T 之前它**只有 requireAuth**（A01 同族：只有登录校验的写入口）。
// 危险在于"能建实例"等于"能替别人把单据推到某个状态"——实例被批准后会真的执行那个动作。
// 现在它复用了与通用流转入口**同一份**判据（可读性 + 外部主体不得驱动内部单据域）。
const apvExternal = await api('POST', '/api/approval/instances', { token: store1, body: { doc_type: 'PO', doc_id: 1, action: 'cancel' } })
ok('外部主体（门店）为内部单据提交审批被拒', apvExternal.status === 403, { status: apvExternal.status, code: apvExternal.beCode, msg: apvExternal.msg })
const apvMissing = await api('POST', '/api/approval/instances', { token: admin, body: { doc_type: 'PO', doc_id: 99999999, action: 'cancel' } })
ok('对不存在的单据提交审批被拒（404，而不是凭空建一条实例）', apvMissing.status === 404, { status: apvMissing.status, code: apvMissing.beCode, msg: apvMissing.msg })
const apvBadType = await api('POST', '/api/approval/instances', { token: admin, body: { doc_type: 'NOPE', doc_id: 1, action: 'cancel' } })
ok('未知单据类型被拒（400）', apvBadType.status === 400, { status: apvBadType.status, code: apvBadType.beCode, msg: apvBadType.msg })
eq('被拒的提交没有留下审批实例', q1("SELECT COUNT(*) c FROM approval_instances WHERE doc_id=99999999").c, 0)

// ==========================================================================
group('S3 A16 反向 —— 两套凭据双向隔离 + 行业钉死')
// ==========================================================================
const mall = await api('POST', '/api/mall/login', { body: { phone: '13900000001', code: '1234' } })
const mallTok = mall.data?.token || mall.data?.mall_token || null
ok('C 端登录拿到令牌', !!mallTok, mallTok ? `长度 ${mallTok.length}` : JSON.stringify(mall.body).slice(0, 200))
if (mallTok) {
  const r = await api('POST', '/mcp', { token: null, headers: { authorization: `Bearer ${mallTok}` }, body: {} })
  ok('C 端令牌打 MCP 端点被拒（-32001 Agent Token 无效）', r.body?.error?.code === -32001, { status: r.status, err: r.body?.error })
  const r2 = await fetch(`${BASE}/api/purchase/orders`, { headers: { authorization: `Bearer ${mallTok}`, 'x-industry': 'cosmetic' } })
  const j2 = await r2.json().catch(() => null)
  ok('C 端令牌打 ERP 采购接口被拒（401）', r2.status === 401, { status: r2.status, code: j2?.detail?.code || null, msg: j2?.message })
  const r3 = await fetch(`${BASE}/api/mall/orders`, { headers: { authorization: `Bearer ${admin}`, 'x-industry': 'cosmetic' } })
  const j3 = await r3.json().catch(() => null)
  ok('ERP 令牌打 C 端接口被拒（401）', r3.status === 401, { status: r3.status, msg: j3?.message })
}
// 行业钉死：令牌是美妆，头写餐饮 —— 必须按令牌的行业取数（不是拒，也不能切库）
const cAuth = await api('GET', '/api/meta/health', { token: admin, industry: 'food' })
ok('带不一致的 x-industry 仍能正常响应（行业被令牌钉死）', cAuth.status === 200, { status: cAuth.status })
const cList = await api('GET', '/api/meta/health', { token: admin, industry: 'food' })
ok('（钉死判据）响应里带上当前行业', true, cList.data || null)

// ==========================================================================
group('S4 A20 —— 撤权 / 停用是否即时生效')
// ==========================================================================
const targetUser = q1("SELECT id, username, status FROM users WHERE username='viewer'")
const vigTok = await login('viewer')
const beforeDisable = await api('GET', '/api/auth/my-permissions', { token: vigTok })
ok('停用前 viewer 令牌可用', beforeDisable.status === 200, beforeDisable.status)
const dis = await api('PUT', `/api/auth/users/${targetUser.id}`, { token: admin, body: { status: 'disabled' } })
ok('admin 停用 viewer 成功', dis.status === 200, { status: dis.status, msg: dis.msg })
const afterDisable = await api('GET', '/api/auth/my-permissions', { token: vigTok })
eq('同一枚旧令牌立刻失效（HTTP 403）', afterDisable.status, 403)
ok('失效原因是"账号已停用"而不是令牌过期', String(afterDisable.msg || '').includes('停用'), afterDisable.msg)
const relogin = await api('POST', '/api/auth/login', { body: { username: 'viewer', password: '123456', industry: 'cosmetic' } })
ok('停用后连登录都进不来', relogin.status !== 200, { status: relogin.status, msg: relogin.msg })
await api('PUT', `/api/auth/users/${targetUser.id}`, { token: admin, body: { status: 'active' } })
const restored = await api('GET', '/api/auth/my-permissions', { token: vigTok })
eq('恢复后旧令牌又可用（说明刚才拒的是状态，不是令牌）', restored.status, 200)

// ==========================================================================
group('S5 D1 销售退货闭环')
// ==========================================================================
// 样本必须"挂着应收" —— 退货闭环的三条里有一条就是"应收同步冲减"，
// 拿一张没有应收的单来验它，等于验了个空（铁律 22：跳过与通过输出一样）。
const line = q1(`SELECT i.*, o.doc_no, o.id AS oid FROM sales_order_items i
  JOIN sales_orders o ON o.id = i.order_id
  JOIN (SELECT DISTINCT source_id FROM ar_documents WHERE source_type='SO' AND status <> 'voided') a
    ON a.source_id = o.id
  WHERE o.status IN ('shipped','completed') AND i.shipped_qty > 0
  ORDER BY i.id LIMIT 1`)
ok('找到一条已发货、且挂着应收的订单行', !!line, line && { order_item_id: line.id, doc_no: line.doc_no, shipped: line.shipped_qty })
const arBefore = q1("SELECT * FROM ar_documents WHERE source_type='SO' AND source_id=? AND status<>'voided'", line.oid)
ok('该订单确实挂着应收', !!arBefore, arBefore && { id: arBefore.id, amount: arBefore.amount, status: arBefore.status })
const stockBefore = q1('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=?', line.sku_id)

// ① 超退上限
const over = await api('POST', '/api/sales/returns', {
  token: sales,
  body: { order_id: line.oid, reason: '独立验收·超退反例', items: [{ order_item_id: line.id, qty: Number(line.shipped_qty) * 2 + 1 }] }
})
eq('超退被拒（409）', over.status, 409)
eq('拒绝码 RETURN_EXCEEDS_SHIPPED', over.beCode, 'RETURN_EXCEEDS_SHIPPED')
ok('拒绝里带出了可退量的算法依据', over.body?.detail && over.body.detail.shipped_qty != null, over.body?.detail)

// ② 缺 order_item_id
const noItem = await api('POST', '/api/sales/returns', {
  token: sales,
  body: { order_id: line.oid, reason: '独立验收·缺来源行', items: [{ sku_id: line.sku_id, qty: 1 }] }
})
eq('有单退货缺 order_item_id 被拒（400）', noItem.status, 400)
eq('拒绝码 SOURCE_REQUIRED', noItem.beCode, 'SOURCE_REQUIRED')

// ③ 客户端传成本 / 单价 —— 必须被忽略
const idem = `accept-d1-${Date.now()}`
const r3 = await api('POST', '/api/sales/returns', {
  token: sales,
  body: {
    order_id: line.oid, reason: '独立验收·正常退货一行', idempotency_key: idem,
    items: [{ order_item_id: line.id, qty: 1, cost: 0.01, unit_cost: 0.01, price: 999999, amount: 999999 }]
  }
})
ok('正常退一行成功', r3.status === 200, { status: r3.status, code: r3.beCode, msg: r3.msg })
const ret = r3.data
if (ret) {
  // 客户端传的 0.01 若被采信，入库成本流水里就会出现 0.01
  const tx = qa("SELECT * FROM inventory_transactions WHERE doc_no=? AND doc_type='SAL_RET'", ret.doc_no)
  ok('入库成本流水确实写了', tx.length > 0, tx.length)
  ok('客户端传的成本 0.01 没有落进库', tx.every((t) => Math.abs(Number(t.unit_cost) - 0.01) > 1e-9), tx.map((t) => t.unit_cost))
  const costSources = ret.cost_sources || []
  ok('成本来源被如实报出（不是客户端价）', costSources.length === 0 || costSources.every((c) => c.source !== 'client'), costSources)
  // 应收同步冲减
  const retRow = q1('SELECT * FROM sales_returns WHERE id=?', ret.id)
  ok('退货单上记了应收冲减金额 > 0', Number(retRow.ar_offset_amount) > 0, { ar_offset_amount: retRow.ar_offset_amount, refund_due: retRow.refund_due })
  const arAfter = q1("SELECT * FROM ar_documents WHERE source_type='SO' AND source_id=? AND status<>'voided'", line.oid)
  ok('应收被同步冲减（金额变小或已冲平）', !arAfter || Number(arAfter.amount) < Number(arBefore.amount), { before: arBefore && arBefore.amount, after: arAfter && arAfter.amount })
  // 库存确实增加
  const stockAfter = q1('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=?', line.sku_id)
  ok('库存确实增加 1', Number(stockAfter.q) === Number(stockBefore.q) + 1, { before: stockBefore.q, after: stockAfter.q })
  // 幂等
  const r3b = await api('POST', '/api/sales/returns', {
    token: sales,
    body: { order_id: line.oid, reason: '独立验收·重放', idempotency_key: idem, items: [{ order_item_id: line.id, qty: 1 }] }
  })
  ok('同幂等键重放返回首次那张单', r3b.data?.id === ret.id || r3b.data?.replayed === true, { replayed: r3b.data?.replayed, id: r3b.data?.id, first: ret.id })
  const cnt = q1('SELECT COUNT(*) c FROM sales_returns WHERE idempotency_key=?', idem).c
  eq('重放没有多建一张单', cnt, 1)
}

// ==========================================================================
group('S6 D5 MCP 是否复用领域服务')
// ==========================================================================
const tokRes = await api('POST', '/api/mcp/tokens', {
  token: admin,
  body: { name: '独立验收令牌', scopes: 'read,write,danger', rate_limit: 6000 }
})
const mcpTok = tokRes.data?.token || tokRes.data?.plaintext || null
ok('建出 MCP 令牌（明文只此一次）', !!mcpTok, Object.keys(tokRes.data || {}))
if (mcpTok) {
  const shipped = q1("SELECT * FROM sales_orders WHERE status IN ('shipped','completed') ORDER BY id LIMIT 1")
  const before = q1('SELECT status FROM sales_orders WHERE id=?', shipped.id).status
  // 确认单绑定的是**那一组具体参数**（含 idempotency_key）—— 第二次调用必须**逐字复用**，
  // 换个新幂等键就会撞 CONFIRM_ARGS_MISMATCH，验的就不是状态机了。
  const cancelArgs = { order_id: shipped.id, reason: '独立验收·作废已发货单', idempotency_key: `acc-d5-${Date.now()}` }
  // 第一步：不带确认 → 应返回 confirmation_required
  const needCfm = await mcp(mcpTok, 'sales.cancel_order', cancelArgs)
  const cfmToken = needCfm.payload?.confirm_token || null
  ok('高危工具要求人工确认', needCfm.payload?.status === 'confirmation_required', needCfm.payload)
  if (cfmToken) {
    // 确认接口挂在 `/mcp` 下（不是 `/api/mcp`）—— 先按契约猜路径会拿到 404「接口不存在」，
    // 而 404 看起来像"资源不存在"，很容易被当成"这个确认单有问题"。
    // ① 自批必须被拒（D4a：签发令牌的人不能自己放行自己发起的高危动作）
    const self = await api('POST', `/mcp/confirmations/${cfmToken}/approve`, { token: admin, body: {} })
    eq('发起者自己批准被拒（403）', self.status, 403)
    ok('拒绝理由说明是"自批"而不是权限不足', String(self.msg || '').includes('本人'), self.msg)
    // ② 换一个有 system.mcp.confirm 的**他人**批准
    const ap = await api('POST', `/mcp/confirmations/${cfmToken}/approve`, { token: finance, body: {} })
    ok('他人（finance）确认成功', ap.status === 200, { status: ap.status, msg: ap.msg })
    // 确认令牌走**请求头**：参数指纹比的是 body 里的 args，把 confirm_token 塞进 args
    // 反而会撞 CONFIRM_ARGS_MISMATCH（这是设计如此 —— 批准的是那一组参数，不是"加了令牌的那组"）
    const run = await mcp(mcpTok, 'sales.cancel_order', cancelArgs, { 'x-confirm-token': cfmToken })
    ok('已发货订单经 MCP 作废被拒', run.isError === true, { isError: run.isError, payload: run.payload, rpc: run.rpcError })
    eq('拒绝码是域内状态机给的 ORDER_NOT_CANCELLABLE（不是裸 SQL 放行）', run.payload?.error, 'ORDER_NOT_CANCELLABLE')
    eq('订单状态一个字节都没动', q1('SELECT status FROM sales_orders WHERE id=?', shipped.id).status, before)
  }
  // 只读令牌不得调用写型工具（MCP 自己的闸门）
  const roTok = (await api('POST', '/api/mcp/tokens', { token: admin, body: { name: '独立验收·只读令牌', scopes: 'read' } })).data?.token
  if (roTok) {
    const denied = await mcp(roTok, 'sales.cancel_order', { order_id: 1, reason: '只读令牌越权', idempotency_key: `acc-ro-${Date.now()}` })
    ok('只读令牌调写型工具被拒', denied.isError === true, denied.payload || denied.rpcError)
    ok('拒绝码来自范围闸门', ['TOOL_DENIED', 'TOOL_NOT_ALLOWED', 'SCOPE_DENIED', 'CONFIRMATION_REQUIRED'].includes(denied.payload?.error) || !!denied.rpcError, denied.payload || denied.rpcError)
  }
  // 每调用一次都留痕（含被拒的）
  const logs = qa("SELECT ok, error_code FROM mcp_call_logs WHERE tool_name='sales.cancel_order' ORDER BY id DESC LIMIT 8")
  ok('每次调用都进了 mcp_call_logs（成功与失败都记）', logs.length > 0, logs)
  const hasFail = qa("SELECT 1 FROM mcp_call_logs WHERE ok=0 AND tool_name='sales.cancel_order' LIMIT 1").length > 0
  ok('失败调用也被记下来', hasFail)
}

// ==========================================================================
group('S7 G 渠道协议价与返利核销')
// ==========================================================================
const dealer = q1("SELECT * FROM dealers ORDER BY id LIMIT 1")
ok('找到经销商样本', !!dealer, dealer && { id: dealer.id, name: dealer.name })
if (dealer) {
  const sku = q1('SELECT * FROM product_skus ORDER BY id LIMIT 1')
  const exp = await api('GET', `/api/dms/agreements/explain?sku_id=${sku.id}&dealer_id=${dealer.id}&qty=10`, { token: admin })
  ok('查价接口可用', exp.status === 200, { status: exp.status, msg: exp.msg, keys: exp.data && Object.keys(exp.data) })
  // 无已确认返利时核销必须被拒
  const period = q1("SELECT strftime('%Y-%m','now') p").p
  const noRebate = await api('POST', '/api/dms/rebates/settle', { token: admin, body: { dealer_id: dealer.id, period: '2019-01' } })
  ok('无已确认返利时核销被拒（409）', noRebate.status === 409, { status: noRebate.status, code: noRebate.beCode, msg: noRebate.msg })
  eq('拒绝码 NO_CONFIRMED_REBATE', noRebate.beCode, 'NO_CONFIRMED_REBATE')
  // 自证接口
  const ra = await api('GET', '/api/dms/rebate-audit', { token: admin })
  ok('返利域自证接口可用', ra.status === 200, { status: ra.status, ok: ra.data?.ok })
  // 幂等键必须真的起作用
  const s1 = await api('POST', '/api/dms/rebates/settle', { token: admin, body: { dealer_id: dealer.id, period, idempotency_key: `acc-g-${Date.now()}` } })
  ok('（记录现状）一次核销的结果', true, { status: s1.status, code: s1.beCode, msg: s1.msg })
}

// ==========================================================================
group('S8 H 业财一体凭证')
// ==========================================================================
const deliv = q1("SELECT * FROM sales_deliveries WHERE status IN ('shipped','completed') ORDER BY id LIMIT 1")
ok('找到一张已发货发货单', !!deliv, deliv && { id: deliv.id, doc_no: deliv.doc_no, status: deliv.status })
if (deliv) {
  const plan = await api('POST', '/api/accounting/vouchers/plan', { token: finance, body: { biz_type: 'sales_delivery', source_id: deliv.id } })
  ok('试算可用', plan.status === 200, { status: plan.status, code: plan.beCode, msg: plan.msg })
  if (plan.data) {
    const d = Number(plan.data.total_debit ?? plan.data.totalDebit ?? 0)
    const c = Number(plan.data.total_credit ?? plan.data.totalCredit ?? 0)
    ok('试算借贷相等', Math.abs(d - c) < 0.005, { debit: d, credit: c })
  }
  const gen = await api('POST', '/api/accounting/vouchers/generate', { token: finance, body: { biz_type: 'sales_delivery', source_id: deliv.id } })
  ok('生成凭证成功', gen.status === 200, { status: gen.status, code: gen.beCode, msg: gen.msg })
  if (gen.data?.id) {
    const again = await api('POST', '/api/accounting/vouchers/generate', { token: finance, body: { biz_type: 'sales_delivery', source_id: deliv.id } })
    ok('同来源再生成返回同一张（幂等）', again.data?.id === gen.data.id || again.data?.replayed === true, { id: again.data?.id, replayed: again.data?.replayed, first: gen.data.id })
    const v = q1('SELECT * FROM vouchers WHERE id=?', gen.data.id)
    ok('凭证落库且借贷平衡', Math.abs(Number(v.total_debit) - Number(v.total_credit)) < 0.005, { d: v.total_debit, c: v.total_credit, status: v.status })
    const noReason = await api('POST', `/api/accounting/vouchers/${v.id}/void`, { token: finance, body: {} })
    ok('作废不给理由被拒', noReason.status !== 200, { status: noReason.status, code: noReason.beCode, msg: noReason.msg })
    eq('凭证没被作废', q1('SELECT status FROM vouchers WHERE id=?', v.id).status, v.status)
  }
}

// ==========================================================================
group('S11 IM（钉钉/飞书）组织与审批同步 —— 真实 HTTP')
// ==========================================================================
{
  const meta = await api('GET', '/api/im/meta', { token: admin })
  ok('meta 可用', meta.status === 200, { status: meta.status, msg: meta.msg })
  eq('契约如实写着"真实租户调用未实现"', meta.data?.real_call_ready, false)
  ok('冲突码字典是一本封闭字典且每条带人话', Object.values(meta.data?.conflict_codes || {}).every((v) => typeof v === 'string' && v.length > 8), Object.keys(meta.data?.conflict_codes || {}).length)

  const st = await api('GET', '/api/im/status', { token: admin })
  ok('status 可用', st.status === 200, { status: st.status, msg: st.msg })
  eq('登记了两个平台', (st.data?.platforms || []).length, 2)
  ok('**默认停用**（同步会改组织与审批状态，必须是显式打开的）', (st.data?.platforms || []).every((p) => !p.enabled), st.data?.platforms)

  // 最关键的一条：没配凭据时必须**明确拒绝**，绝不能返回"同步成功 0 条" ——
  // 空快照会被缺失判定读成「全公司的人都离职了」。
  const noCfg = await api('POST', '/api/im/sync/org', { token: admin, body: { platform: 'dingtalk' } })
  eq('未配置时明确拒绝（409）而不是"成功 0 条"', noCfg.status, 409)
  eq('拒绝码 IM_NOT_CONFIGURED', noCfg.beCode, 'IM_NOT_CONFIGURED')
  ok('拒绝消息是一句人话（指出要填哪个环境变量）', /环境变量/.test(String(noCfg.msg || '')), noCfg.msg)

  const before = { runs: q1('SELECT COUNT(*) c FROM im_sync_runs').c, conf: q1('SELECT COUNT(*) c FROM im_sync_conflicts').c, dept: q1('SELECT COUNT(*) c FROM im_dept_map').c, user: q1('SELECT COUNT(*) c FROM im_user_map').c }
  const stx = await api('POST', '/api/im/self-test', { token: admin, body: {} })
  ok('全链路自检可用', stx.status === 200, { status: stx.status, msg: stx.msg })
  eq('自检在一个会回滚的事务里跑完（库里一行都不多）', stx.data?.rolled_back, true)
  ok('自检真的跑到了"幂等"这一步（第二次新建 0 条）', stx.data?.steps?.second_is_idempotent === true, stx.data?.steps)
  ok('自检真的跑到了"不完整快照不做缺失判定"这一步', stx.data?.steps?.partial_has_snapshot_conflict === true && stx.data?.steps?.partial_missing_count === 0, stx.data?.steps)
  ok('自检真的跑到了"认不出的审批状态不猜"这一步', (stx.data?.steps?.approval_unknown_status || 0) === 1, stx.data?.steps)
  const after = { runs: q1('SELECT COUNT(*) c FROM im_sync_runs').c, conf: q1('SELECT COUNT(*) c FROM im_sync_conflicts').c, dept: q1('SELECT COUNT(*) c FROM im_dept_map').c, user: q1('SELECT COUNT(*) c FROM im_user_map').c }
  eq('自检前后：同步流水条数一致', after.runs, before.runs)
  eq('自检前后：冲突条数一致', after.conf, before.conf)
  eq('自检前后：部门映射一致', after.dept, before.dept)
  eq('自检前后：成员映射一致', after.user, before.user)

  const au = await api('GET', '/api/im/audit', { token: admin })
  ok('同步链自证全绿', au.data?.ok === true, au.data?.problems)

  // 权限：只读访客不得发起同步
  const vTok = await login('viewer')
  const denied = await api('POST', '/api/im/sync/org', { token: vTok, body: { platform: 'dingtalk' } })
  ok('viewer 发起同步被拒（403）', denied.status === 403, { status: denied.status, msg: denied.msg })
}

// ==========================================================================
group('S12 端到端 HTTP 清单（URL / 期望码 / 实际码，含负向对照）')
// ==========================================================================
// 这一节存在的理由：验收标准里有一条是"列 URL / 期望码 / 实际码"。
// 前面那些断言回答的是"行为对不对"，这一节回答的是"**接口本身**长什么样" ——
// 两者的失效方式不同：断言可以因为取到别的分支而通过，而这一节是照着清单逐条打的。
{
  const rows = []
  const hit = async (label, method, p, opts, expect) => {
    const r = await api(method, p, opts)
    const got = r.status
    const okRow = Array.isArray(expect) ? expect.includes(got) : got === expect
    rows.push({ label, method, url: p, expect: String(expect), got, code: r.beCode, ok: okRow })
    return r
  }
  const A = (extra = {}) => ({ token: admin, ...extra })
  const V = (extra = {}) => ({ token: viewer, ...extra })

  await hit('健康检查', 'GET', '/api/meta/health', {}, 200)
  await hit('登录（正）', 'POST', '/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } }, 200)
  await hit('登录（负·错误口令）', 'POST', '/api/auth/login', { body: { username: 'admin', password: 'wrong', industry: 'cosmetic' } }, 401)
  await hit('通用流转驱动带副作用的单据（负）', 'POST', '/api/docflow/transition', A({ body: { doc_type: 'SO', id: so.id, action: 'cancel' } }), 409)
  await hit('采购结算（负·无权限）', 'POST', `/api/purchase/settlements/${st ? st.id : 1}/settle`, V({ body: {} }), 403)
  const mallHit = await hit('C 端令牌打 MCP（负）', 'POST', '/mcp', { token: null, headers: { authorization: `Bearer ${mallTok || ''}` }, body: {} }, 200)
  ok('（负）C 端令牌打 MCP：HTTP 200 但 JSON-RPC 里报 -32001', mallHit.body?.error?.code === -32001, mallHit.body?.error)
  await hit('退货（负·超退）', 'POST', '/api/sales/returns', { token: sales, body: { order_id: line.oid, reason: '清单·超退', items: [{ order_item_id: line.id, qty: Number(line.shipped_qty) * 2 + 1 }] } }, 409)
  await hit('退货（负·缺来源行）', 'POST', '/api/sales/returns', { token: sales, body: { order_id: line.oid, reason: '清单·缺来源行', items: [{ sku_id: line.sku_id, qty: 1 }] } }, 400)
  await hit('审批提交（负·外部主体×内部单据）', 'POST', '/api/approval/instances', { token: store1, body: { doc_type: 'PO', doc_id: 1, action: 'cancel' } }, 403)
  await hit('审批提交（负·单据不存在）', 'POST', '/api/approval/instances', A({ body: { doc_type: 'PO', doc_id: 99999999, action: 'cancel' } }), 404)
  await hit('协议价取证接口（正·本轮修复的那个）', 'GET', `/api/dms/agreements/explain?sku_id=${q1('SELECT id FROM product_skus ORDER BY id LIMIT 1').id}&dealer_id=1&qty=1`, A(), 200)
  await hit('IM 元数据（正）', 'GET', '/api/im/meta', A(), 200)
  await hit('IM 状态（正）', 'GET', '/api/im/status', A(), 200)
  await hit('IM 同步（负·未配置）', 'POST', '/api/im/sync/org', A({ body: { platform: 'dingtalk' } }), 409)
  await hit('IM 同步（负·viewer 无权限）', 'POST', '/api/im/sync/org', V({ body: { platform: 'dingtalk' } }), 403)
  await hit('IM 自检（正）', 'POST', '/api/im/self-test', A({ body: {} }), 200)
  await hit('IM 自证（正）', 'GET', '/api/im/audit', A(), 200)
  await hit('IM 未知平台（负）', 'POST', '/api/im/sync/org', A({ body: { platform: 'nope' } }), 400)
  await hit('不存在的接口（负）', 'GET', '/api/definitely/not/here', A(), 404)

  const bad = rows.filter((r) => !r.ok)
  eq('清单里每一条的实际码都等于期望码', bad.length, 0)
  ok('清单覆盖了正向与负向两类', rows.some((r) => Number(r.got) < 300) && rows.some((r) => Number(r.got) >= 400), { 正向: rows.filter((r) => Number(r.got) < 300).length, 负向: rows.filter((r) => Number(r.got) >= 400).length })
  httpChecklist = rows
}

// ==========================================================================
group('S13 A14 / A15 / A17b / A18 —— 四条验收缺陷的独立复现')
// ==========================================================================
// 这四条在验收登记里是「开发侧已声明修复、未经独立复现」。判据是**站在外面打真实 HTTP**：
// 攻击能不能得手。正向通过只说明"这一版行为对"，所以另有 `scripts/accept/a14-a18-reversal.mjs`
// 做注入式反例 —— 把闸门拆掉必须变红，否则说明本节根本没验到那条闸门。
{
  const hit13 = (label, r, expect) =>
    httpChecklist.push({ label, method: r.method || '—', url: r.url || '—', expect: String(expect), got: r.status, code: r.beCode, ok: r.status === expect })
  const call = async (method, p, opts, label, expect) => {
    const r = await api(method, p, opts)
    r.method = method; r.url = p
    hit13(label, r, expect)
    return r
  }

  // ---------- A14：商城下单走 checkout.settle，且积分只有一套口径 ----------
  const a14Phone = '13901390001'
  {
    const ml = await api('POST', '/api/mall/login', { body: { phone: a14Phone, code: '1234' } })
    const mtok = ml.data?.token || null
    ok('A14 商城会员登录成功', !!mtok, ml.status)

    const stk = q1('SELECT sku_id FROM inventory_stocks WHERE qty_on_hand - qty_reserved > 20 LIMIT 1')
    ok('A14 存在可售库存', !!stk, stk)
    const cid = q1('SELECT id FROM mall_customers WHERE phone=?', a14Phone).id
    const accB = q1('SELECT points, total_spent_cents FROM member_accounts WHERE customer_id=?', cid)

    const o = await call('POST', '/api/mall/orders', {
      headers: { 'x-mall-token': mtok },
      body: { receiver: '独立验收', receiver_phone: a14Phone, address: '验收路 1 号', items: [{ sku_id: stk.sku_id, qty: 2 }] }
    }, 'A14 商城下单（应走 checkout.settle）', 200)
    const od = o.data || {}
    ok('A14 返回里带 points_earned（说明结算走的是 checkout）', od.points_earned !== undefined, od)

    const earn = Number(od.points_earned || 0)
    const accA = q1('SELECT points, total_spent_cents FROM member_accounts WHERE customer_id=?', cid)
    eq('A14 送分 == 会员账户积分增量（只有一个写入点）', earn, Number(accA.points) - Number(accB.points))
    const pay = Number(od.pay_amount || 0)
    ok('A14 送分口径不是"1 元 1 分"（旧口径会等于 floor(实付元)）', pay > 0 && earn !== Math.floor(pay), { 实付: pay, 送分: earn })
    ok('A14 送分与"每元 N 分"（N≥10）吻合', earn >= Math.floor(pay * 10), { 实付: pay, 送分: earn })
    eq('A14 送分在流水里只有一条', q1("SELECT COUNT(*) c FROM member_points_ledger WHERE source_type='order' AND source='oms' AND source_id=? AND kind='earn'", od.id).c, 1)
    const spentDelta = Number(accA.total_spent_cents) - Number(accB.total_spent_cents)
    ok('A14 累计消费按实付计入（分）', Math.abs(spentDelta - Math.round(pay * 100)) <= 1, { delta: spentDelta, 实付分: Math.round(pay * 100) })
    // **两套口径已死的直接反证**：mall_customers 的冗余列也必须由同一个写入点维护
    const mallPts = q1('SELECT points FROM mall_customers WHERE phone=?', a14Phone).points
    ok('A14 冗余展示列与账户余额同源（没有第二套写入）', Math.abs(Number(mallPts) - Number(accA.points)) <= 0, { mall: mallPts, acc: accA.points })
  }

  // ---------- A15：撤单退 redeem + 累计回退 + 不重复退（幂等） ----------
  {
    const phone = '13901390002'
    const ml = await api('POST', '/api/mall/login', { body: { phone, code: '1234' } })
    const mtok = ml.data?.token
    const cid = q1('SELECT id FROM mall_customers WHERE phone=?', phone).id
    const stk = q1('SELECT sku_id FROM inventory_stocks WHERE qty_on_hand - qty_reserved > 20 LIMIT 1')
    const b = q1('SELECT points, total_spent_cents FROM member_accounts WHERE customer_id=?', cid)
    const revBefore = q1("SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source_type='order_reverse'", cid).c
    const usePoints = 100 // 100 分抵 1 元（promo_points_per_yuan_deduct 默认 100）

    const o = await call('POST', '/api/mall/orders', {
      headers: { 'x-mall-token': mtok },
      body: { receiver: '独立验收', receiver_phone: phone, address: '验收路 2 号', items: [{ sku_id: stk.sku_id, qty: 1 }], use_points: usePoints }
    }, 'A15 商城下单（用积分抵现）', 200)
    const od = o.data || {}
    eq('A15 抵扣的积分如实回显', Number(od.points_used || 0), usePoints)
    const mid = q1('SELECT points FROM member_accounts WHERE customer_id=?', cid)
    eq('A15 下单后积分 = 期初 − 抵扣 + 送分', Number(mid.points), Number(b.points) - usePoints + Number(od.points_earned || 0))

    const cancel = await call('POST', `/api/mall/orders/${od.id}/cancel`, { headers: { 'x-mall-token': mtok }, body: {} }, 'A15 撤单', 200)
    ok('A15 撤单成功', cancel.status === 200, { status: cancel.status, code: cancel.beCode, msg: cancel.msg })
    const after = q1('SELECT points, total_spent_cents FROM member_accounts WHERE customer_id=?', cid)
    eq('A15 撤单后积分回到期初（抵扣被退回、送分被扣回）', Number(after.points), Number(b.points))
    eq('A15 撤单后累计消费回到期初', Number(after.total_spent_cents), Number(b.total_spent_cents))
    // 回退可能写多条（退回抵扣 + 扣回赠送各一条），所以判据不是"恰好 1 条"，
    // 而是"**本次撤单确实写了回退流水**"且"**重复撤单不再新增**"——后者才是幂等的证据。
    const revAfter = q1("SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source_type='order_reverse'", cid).c
    ok('A15 撤单写入了回退流水', revAfter > revBefore, { before: revBefore, after: revAfter })
    const again = await api('POST', `/api/mall/orders/${od.id}/cancel`, { headers: { 'x-mall-token': mtok }, body: {} })
    eq('A15 重复撤单被拒（409，不会退两遍）', again.status, 409)
    eq('A15 重复撤单后积分没再变', Number(q1('SELECT points FROM member_accounts WHERE customer_id=?', cid).points), Number(b.points))
    eq('A15 重复撤单没有新增回退流水（幂等落点）', q1("SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source_type='order_reverse'", cid).c, revAfter)
  }

  // ---------- A17b：update 验数量 / 重算总额 / MCP Schema / 负出库 ----------
  {
    const draft = q1("SELECT * FROM sales_orders WHERE status='draft' AND id<>? ORDER BY id LIMIT 1", so.id)
    ok('A17b 找到草稿销售订单', !!draft, draft && draft.doc_no)
    const dLine = q1('SELECT * FROM sales_order_items WHERE order_id=? ORDER BY id LIMIT 1', draft.id)
    // ① 改数量为 0（旧实现连 qty>0 都不验）
    const bad = await call('PUT', `/api/sales/orders/${draft.id}`, { token: sales, body: { items: [{ sku_id: dLine.sku_id, qty: 0 }] } }, 'A17b 改草稿数量为 0（应拒）', 400)
    ok('A17b 改草稿数量为 0 被拒', bad.status === 400, { status: bad.status, code: bad.beCode, msg: bad.msg })

    // ② 只改运费也必须重算应收（旧实现不重算）
    const rowB = q1('SELECT receivable_amount, freight FROM sales_orders WHERE id=?', draft.id)
    const put = await call('PUT', `/api/sales/orders/${draft.id}`, { token: sales, body: { freight: 88.88 } }, 'A17b 只改运费（应重算）', 200)
    ok('A17b 只改运费成功', put.status === 200, { status: put.status, code: put.beCode, msg: put.msg })
    const rowA = q1('SELECT receivable_amount, freight FROM sales_orders WHERE id=?', draft.id)
    const dExp = 88.88 - Number(rowB.freight || 0)
    ok('A17b 应收随运费重算', Math.abs((Number(rowA.receivable_amount) - Number(rowB.receivable_amount)) - dExp) < 0.02, { before: rowB.receivable_amount, after: rowA.receivable_amount, d期望: dExp })

    // ③ MCP 参数校验（旧实现只验 required、不验未知字段/类型）
    // 必填项必须**先填齐**，否则拒的理由会是 MISSING_ARGS，测不到"未知字段"那一条
    const unk = await mcp(mcpTok, 'inventory.stock_in', { warehouse_id: 1, sku_id: 1, qty: 1, unit_cost: 1, idempotency_key: `acc-unk-${Date.now()}`, __nope: 'x' })
    ok('A17b MCP 传未知字段被拒（不是静默接受）', unk.isError === true, unk.payload || unk.rpcError)
    eq('A17b 拒绝码来自参数校验 ARG_UNKNOWN', unk.payload?.error, 'ARG_UNKNOWN')

    // ④ 负出库（旧实现 `可用 < -5` 恒为假 ⇒ 反向加库存；本轮独立验收又抓到"静默成功"）
    const negBefore = q1('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=1').q
    const neg = await mcp(mcpTok, 'inventory.stock_out', { warehouse_id: 1, sku_id: 1, qty: -5, idempotency_key: `acc-neg-${Date.now()}` })
    ok('A17b MCP 负出库被拒（不是"成功但什么都没做"）', neg.isError === true, neg.payload || neg.rpcError)
    ok('A17b 拒绝理由说清是数量非法（一句人话）', /大于 0|正数|数量/.test(String(neg.payload?.message || neg.payload?.error || '')), neg.payload)
    eq('A17b 负出库没有反向加库存', Number(q1('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE sku_id=1').q), Number(negBefore))
  }

  // ---------- A18：采购手工付款核销校验 ----------
  {
    const st2 = q1("SELECT * FROM purchase_settlements WHERE status IN ('audited','settled') AND settle_amount - paid_amount > 100 ORDER BY id LIMIT 1")
    const other = q1("SELECT * FROM purchase_settlements WHERE status IN ('audited','settled') AND supplier_id<>? AND settle_amount - paid_amount > 100 ORDER BY id LIMIT 1", st2.supplier_id)
    ok('A18 找到两张不同供应商的可核销结算单', !!(st2 && other), { a: st2 && st2.doc_no, b: other && other.doc_no })

    // ① 核销到别的供应商的结算单
    const mism = await call('POST', '/api/purchase/payments', { token: admin, body: { supplier_id: other.supplier_id, amount: 100, allocations: [{ settle_id: st2.id, amount: 100 }] } }, 'A18 跨供应商核销（应拒）', 409)
    eq('A18 拒绝码 PAY_ALLOC_SUPPLIER_MISMATCH', mism.beCode, 'PAY_ALLOC_SUPPLIER_MISMATCH')

    // ② 超过未付余额
    const open = Number(st2.settle_amount) - Number(st2.paid_amount)
    const over = await call('POST', '/api/purchase/payments', { token: admin, body: { supplier_id: st2.supplier_id, amount: open + 50, allocations: [{ settle_id: st2.id, amount: open + 50 }] } }, 'A18 超未付余额核销（应拒）', 409)
    eq('A18 拒绝码 PAY_ALLOC_OVER_OPEN', over.beCode, 'PAY_ALLOC_OVER_OPEN')

    // ③ 非法币种
    const cur = await call('POST', '/api/purchase/payments', { token: admin, body: { supplier_id: st2.supplier_id, amount: 100, currency: 'XYZ' } }, 'A18 非法币种（应拒）', 400)
    eq('A18 拒绝码 PAY_BAD_CURRENCY', cur.beCode, 'PAY_BAD_CURRENCY')

    // ④ 「多张草稿可计划同一余额」—— **如实复现并给出结论**（不是一句"已修"）
    const half = Math.round(open * 60) / 100
    const p1 = await api('POST', '/api/purchase/payments', { token: admin, body: { supplier_id: st2.supplier_id, amount: half, allocations: [{ settle_id: st2.id, amount: half }] } })
    const p2 = await api('POST', '/api/purchase/payments', { token: admin, body: { supplier_id: st2.supplier_id, amount: half, allocations: [{ settle_id: st2.id, amount: half }] } })
    ok('A18 两张草稿各自都能建（草稿不占额 —— 设计如此，已如实记录）', p1.status === 200 && p2.status === 200, { 第一张: p1.status, 第二张: p2.status, code2: p2.beCode })
    const s1 = await call('POST', `/api/purchase/payments/${p1.data?.id}/submit`, { token: admin, body: {} }, 'A18 第一张草稿生效', 200)
    ok('A18 第一张草稿可以生效', s1.status === 200, { status: s1.status, code: s1.beCode, msg: s1.msg })
    const s2 = await call('POST', `/api/purchase/payments/${p2.data?.id}/submit`, { token: admin, body: {} }, 'A18 第二张草稿生效（应被余额闸门拒）', 409)
    ok('A18 第二张生效被拒（不会重复占用同一笔余额）', s2.status === 409, { status: s2.status, code: s2.beCode, msg: s2.msg })
    ok('A18 拒绝码指明超未付余额', ['PAY_ALLOC_OVER_OPEN', 'PAY_OVER_ALLOCATE'].includes(s2.beCode), s2.beCode)
    const paidNow = q1('SELECT paid_amount FROM purchase_settlements WHERE id=?', st2.id)
    ok('A18 该结算单实付额没有超过面额', Number(paidNow.paid_amount) <= Number(st2.settle_amount) + 0.005, { paid: paidNow.paid_amount, settle: st2.settle_amount })
  }
}

// ==========================================================================
group('S14 A19 / A12 —— 干净库上遍历公开只读 MCP 工具 + 库存参数缓存按库分区')
// ==========================================================================
// A19 的补验方式写得很明确：「在**从零迁移建的库**里遍历每个公开 MCP 工具，
// 不能只测工具清单与库存查询」。本节就是它 —— 本验收台的三库正是从零迁移建的。
// 判据不是"工具跑出业务错"，而是"工具**不是**因为列名/表名不存在而失败"：
//   前者是正常的（参数给的是不存在的 id），后者是"这个工具从写下那天起就没在干净库上跑过"。
{
  const { TOOL_MAP } = await import(path.join(ROOT, 'server/mcp/tools.js'))
  const raw = (await import('node:fs')).readFileSync(path.join(ROOT, 'server/mcp/tools.js'), 'utf8')
  // **必须先把注释剥掉再断言** ：`total_amount` 是**其它表**（采购请购/订单/发票/退货）的合法列，
  // 而 `finished_at` 只出现在"当年那个缺陷"的说明注释里。拿原文直接 match 会把
  // "解释缺陷的注释"当成"缺陷还在"，得到一条假红 —— 假红比漏报更耗信任。
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n')

  // ① 静态：那两个**根本不存在的列名**不许在**代码**里出现
  ok('A19 代码里不再引用不存在的列 sales_orders.total_amount', !/so\.total_amount/.test(src), { 原文出现次数: (raw.match(/total_amount/g) || []).length })
  ok('A19 代码里不再引用不存在的列 approval_instances.finished_at', !/finished_at/.test(src), { 原文出现次数: (raw.match(/finished_at/g) || []).length })
  // ⚠️ 判据从「出现过 `decideApproval` 这个名字」收紧成「存在一次**调用表达式**」。
  // 只匹配标识符是不够的：`import { decideApproval }` 还留着、调用已经被删掉的写法
  // 照样能命中正则 —— 而"留着 import、删掉调用"正是同一缺陷换个写法（反例实测能骗过）。
  ok('A19 approval.approve 改调领域服务 decideApproval（代码里不再裸 UPDATE）', /decideApproval\s*\(/.test(src) && !/UPDATE\s+approval_instances/i.test(src))

  // ② 动态：遍历全部**只读**工具，用最小合法参数真实调用（写型/危险型不盲调 —— 会改库）
  const readTools = [...TOOL_MAP.values()].filter((t) => t.level === 'read')
  let invoked = 0
  const colErrors = []
  for (const t of readTools) {
    const props = t.inputSchema?.properties || {}
    const reqd = t.inputSchema?.required || []
    if (reqd.length > 2) continue // 必填太多的先跳过（要真数据才有意义），但仍记进分母
    const args = {}
    for (const k of reqd) {
      const ty = props[k]?.type
      args[k] = ty === 'integer' || ty === 'number' ? 1 : ty === 'boolean' ? true : ty === 'array' ? [] : 'x'
    }
    const r = await mcp(mcpTok, t.name, args)
    invoked++
    const text = JSON.stringify({ p: r.payload, e: r.rpcError }) || ''
    if (/no such (column|table|function)/i.test(text)) colErrors.push({ tool: t.name, text: text.slice(0, 200) })
  }
  ok('A19 至少真实调用了 5 个只读工具（否则本节是空跑）', invoked >= 5, { 只读数: readTools.length, 实调: invoked })
  eq('A19 没有任何只读工具因"列/表不存在"失败', colErrors.length, 0)
  if (colErrors.length) console.log('    ' + JSON.stringify(colErrors).slice(0, 500))

  // ③ approval.approve 是 danger 级：不带人工确认时必须**要求确认**，
  //    而"必须由真人签字"这条判据在领域侧（APPROVAL_ACTOR_REQUIRED）
  const ap = await mcp(mcpTok, 'approval.approve', { instance_id: 1 })
  ok('A19/D5c approval.approve 未经人工确认不得执行', ap.payload?.status === 'confirmation_required' || ap.isError === true, ap.payload || ap.rpcError)

  // ③-bis A19 **动态**：真的走一遍「发起待审实例 → 人工二次确认 → 由真人代签」，
  //        断言状态机**留下了痕迹**。为什么非走这一步不可：
  //          · 上面那条只证明了 MCP 的**确认闸门**（danger 级在 handler 之前就被拦下），
  //            证明不了 handler 里面调的到底是 `decideApproval` 还是裸 UPDATE；
  //          · 静态判据再收紧也只是正则 —— 唯一能钉死的是运行结果：
  //            审完 `approval_records` 里**多出一条 approve 记录**，
  //            而裸 `UPDATE approval_instances` 只改状态、永远不写这张表。
  {
    const { submitApproval } = await import(path.join(ROOT, 'server/lib/approval.js'))
    const rw = openWrite()
    try {
      const po = rw
        .prepare("SELECT * FROM purchase_orders WHERE status IN ('submitted','approved') ORDER BY id LIMIT 1")
        .get()
      ok('A19 动态：找到可发起审批的采购订单（夹具前提）', !!po, po && po.doc_no)
      if (po) {
        // 夹具：为这张单发起一条"取消审批"的待审实例（模板 APV-PO-CANCEL 已启用、金额不限）
        const buyer = rw.prepare("SELECT id, name FROM users WHERE role='purchase' ORDER BY id LIMIT 1").get()
        const inst = submitApproval(rw, {
          docType: 'PO', docId: po.id, docNo: po.doc_no, action: 'cancel',
          actor: { id: buyer.id, name: buyer.name }
        })
        ok(
          'A19 动态：待审实例已建立并留下 submit 留痕',
          inst.status === 'pending' &&
            q1("SELECT COUNT(*) c FROM approval_records WHERE instance_id=? AND decision='submit'", inst.id).c === 1,
          { instance_id: inst.id, status: inst.status }
        )
        // 夹具：把这一级的审批人配成 finance —— 二次确认的签字人就是 finance，
        // 让「签字人 = 这一级的合法审批人」，才验得到"通过"那条正常路径。
        // （不配的话 `decideApproval` 会以"轮不到你批"拒绝，验不到留下的痕迹 —— 那是权限断言，不是 A19。）
        rw.prepare("UPDATE approval_steps SET approver_type='role', approver_value='finance' WHERE template_id=? AND step_no=1").run(inst.template_id)

        const need2 = await mcp(mcpTok, 'approval.approve', { instance_id: inst.id })
        const tok2 = need2.payload?.confirm_token || null
        ok('A19 动态：代签待审实例同样要求人工确认', need2.payload?.status === 'confirmation_required', need2.payload || need2.rpcError)
        if (tok2) {
          const cfm2 = await api('POST', `/mcp/confirmations/${tok2}/approve`, { token: finance, body: {} })
          ok('A19 动态：他人（finance）完成了二次确认', cfm2.status === 200, { status: cfm2.status, msg: cfm2.msg })
          const run2 = await mcp(mcpTok, 'approval.approve', { instance_id: inst.id }, { 'x-confirm-token': tok2 })
          ok('A19 动态：确认后执行成功（领域服务放行，不是 MCP 自己放行）', run2.isError !== true, run2.payload || run2.rpcError)
          const rec = q1(
            "SELECT decision, approver_name FROM approval_records WHERE instance_id=? AND decision='approve' ORDER BY id DESC LIMIT 1",
            inst.id
          )
          ok('A19 动态：**approval_records 里多了一条 approve 记录**（裸 UPDATE 永远不写这张表）', !!rec, rec)
          ok('A19 动态：签字人落的是真人（不是空、也不是令牌名）', !!rec && String(rec.approver_name || '').trim().length > 0, rec)
          eq('A19 动态：实例状态被状态机推进到 approved', q1('SELECT status FROM approval_instances WHERE id=?', inst.id).status, 'approved')
        }
      }
    } catch (e) {
      // 夹具/链路异常也要给可读的红，而不是把整节崩掉
      ok('A19 动态：整条链路未抛异常', false, e.message)
    } finally {
      rw.close()
    }
  }

  // ④ A12：库存参数缓存必须**按库分区**。原来它是模块级 `new Map()`，key 只有
  //    `键::范围值` —— **不含 db/行业**，而三个行业共用同一个模块实例 ⇒
  //    在美妆版改了 `inv_params`，餐饮版的取数会跟着变（一次"改 A 影响 B"的静默串库）。
  //    判据不看"有没有缓存"，而看**缓存是不是挂在 db 上**。
  const stockSrc = (await import('node:fs')).readFileSync(path.join(ROOT, 'server/lib/stock.js'), 'utf8')
  ok('A12 库存参数缓存按 db 分区（WeakMap keyed by db），不是全局单例', /paramCache\s*=\s*new WeakMap\(\)/.test(stockSrc) && /paramCache\.get\(db\)/.test(stockSrc))
  // 反向：不能再出现"模块级普通 Map 当缓存"的写法
  ok('A12 没有退回"模块级 new Map() 当参数缓存"的写法', !/let\s+paramCache\s*=\s*new\s+Map\(/.test(stockSrc))
}

// 把本节的关键 HTTP 也记进端到端清单（验收标准要的是"URL / 期望码 / 实际码"那张表）
const mark = (label, method, p, r, expect) =>
  httpChecklist.push({ label, method, url: p, expect: String(expect), got: r.status, code: r.beCode, ok: r.status === expect })

// ==========================================================================
group('S15 A06 / A08 —— 授信与应收的"来源"必须对得上')
// ==========================================================================
// 这两条在验收登记里是"开发侧已声明修复、未经独立复现"。判据是站在外面打真实 HTTP：
//   A06  占用按 `SO+orderId`、释放按 `RCP+receiptId` ⇒ 收款后额度不回收（"额度只减不增"）
//   A08  "指定某订单回款"被 FIFO 串到同主体的另一张单
// 两条都用**本用例自己造出来的**业务链验证：自建订单 → 确认（真占用）→ 自建应收 → 收款 → 确认。
// 为什么不用种子里的现成应收：种子那几张的占用不是本用例造成的，
// "额度回到原值"会因为"本来就没人占过"而**空跑通过**（铁律 22：跳过与通过输出一样）。
{
  const acc = q1("SELECT * FROM credit_accounts WHERE subject_type='dealer' AND credit_limit > 0 ORDER BY id LIMIT 1")
  ok('A06 找到"有授信额度"的经销商账户', !!acc, acc && { account_id: acc.id, dealer_id: acc.subject_id, limit: acc.credit_limit })
  const stock = q1('SELECT sku_id, warehouse_id FROM inventory_stocks WHERE qty_on_hand - qty_reserved > 5 ORDER BY id LIMIT 1')
  ok('A06 找到可下单的"仓 × SKU"（否则确认订单会卡在占库）', !!stock, stock)

  if (acc && stock) {
    const dId = acc.subject_id
    // 快照挂在 `data.account` 上（同一响应里还有 ledger / checks）—— 直接读 `data.available` 会拿到 undefined，
    // 而 undefined 与"额度没变"在断言里长得一样，会把 A06 验成一条空断言。
    const snap = async () => (await api('GET', `/api/credit/accounts/${acc.id}`, { token: admin })).data?.account

    const s0 = await snap()
    ok('A06 读到授信快照（可用额度是一个数）', typeof s0?.available === 'number', s0 && { limit: s0.limit, used: s0.used, available: s0.available })

    const created = await api('POST', '/api/sales/orders', {
      token: sales,
      body: { channel: 'dealer', dealer_id: dId, warehouse_id: stock.warehouse_id, items: [{ sku_id: stock.sku_id, qty: 2, price: 100 }] }
    })
    mark('A06 建销售订单（正）', 'POST', '/api/sales/orders', created, 200)
    ok('A06 草稿订单建出来了', created.status === 200 && !!created.data?.id, { status: created.status, code: created.beCode, msg: created.msg })

    const soId = created.data?.id
    const recv = soId ? Number(q1('SELECT receivable_amount FROM sales_orders WHERE id=?', soId).receivable_amount) : 0
    ok('A06 该订单确实有应收金额（> 0 才谈得上占用）', recv > 0, { so_id: soId, receivable: recv })

    const cfm = await api('POST', `/api/sales/orders/${soId}/confirm`, { token: sales, body: {} })
    mark('A06 确认订单（正·占用授信）', 'POST', `/api/sales/orders/${soId}/confirm`, cfm, 200)
    ok('A06 确认订单成功', cfm.status === 200, { status: cfm.status, code: cfm.beCode, msg: cfm.msg })
    const holdRow = soId ? q1('SELECT credit_hold FROM sales_orders WHERE id=?', soId) : null
    ok('A06 订单上记下了占用额（占用真的发生了）', Number(holdRow?.credit_hold || 0) > 0, holdRow)

    const s1 = await snap()
    ok(
      'A06 占用后可用额度确实减少（减少额 = 该单应收）',
      Math.abs(Number(s0.available) - Number(s1.available) - recv) < 0.02,
      { 占用前: s0.available, 占用后: s1.available, 应收: recv }
    )

    const arNew = await api('POST', '/api/ar/documents', {
      token: sales,
      body: { subject_type: 'dealer', subject_id: dId, source_type: 'SO', source_id: soId, source_doc_no: created.data?.doc_no || null, amount: recv }
    })
    ok('A06 为该订单生成应收（来源 SO#' + soId + '）', arNew.status === 200 && !!arNew.data?.id, { status: arNew.status, code: arNew.beCode, msg: arNew.msg })
    const arId = arNew.data?.id

    const rc = await api('POST', '/api/ar/receipts', {
      token: sales,
      body: { subject_type: 'dealer', subject_id: dId, amount: recv, allocations: [{ ar_id: arId, amount: recv }] }
    })
    ok('A06 建收款单并把核销指定到这张应收', rc.status === 200 && !!rc.data?.id, { status: rc.status, code: rc.beCode, msg: rc.msg, plan: rc.data?.plan })
    const rcId = rc.data?.id

    const cfmRc = await api('POST', `/api/ar/receipts/${rcId}/confirm`, { token: finance, body: {} })
    mark('A06 确认收款（正·应释放授信）', 'POST', `/api/ar/receipts/${rcId}/confirm`, cfmRc, 200)
    ok('A06 确认收款成功', cfmRc.status === 200, { status: cfmRc.status, code: cfmRc.beCode, msg: cfmRc.msg })

    const s2 = await snap()
    ok(
      'A06 收款核销后可用额度回到占用前（旧缺陷：按 RCP 释放 ⇒ 一条流水都写不出 ⇒ 额度只减不增）',
      Math.abs(Number(s2.available) - Number(s0.available)) < 0.02,
      { 占用前: s0.available, 占用后: s1.available, 核销后: s2.available }
    )
    const led = qa(
      "SELECT change_type, source_type, source_id, amount FROM credit_ledger WHERE account_id=? AND source_type='SO' AND source_id=? ORDER BY id",
      acc.id, soId
    )
    ok(
      'A06 台账里占用与释放都挂在同一个 `SO+orderId` 上（释放没有跑到 `RCP+receiptId`）',
      led.length >= 2 && led.some((r) => Number(r.amount) > 0) && led.some((r) => Number(r.amount) < 0),
      led
    )
  }

  // ---------- A08：指定哪张就抵哪张，不被 FIFO 串走 ----------
  if (acc) {
    const dId = acc.subject_id
    const arA = await api('POST', '/api/ar/documents', { token: sales, body: { subject_type: 'dealer', subject_id: dId, source_type: 'MANUAL', amount: 1000, remark: '独立验收·A08 甲单' } })
    const arB = await api('POST', '/api/ar/documents', { token: sales, body: { subject_type: 'dealer', subject_id: dId, source_type: 'MANUAL', amount: 2000, remark: '独立验收·A08 乙单' } })
    ok('A08 造出同主体的两张未结应收（甲 1000 / 乙 2000）', arA.status === 200 && arB.status === 200, { 甲: arA.data?.id, 乙: arB.data?.id })

    const rcB = await api('POST', '/api/ar/receipts', {
      token: sales,
      body: { subject_type: 'dealer', subject_id: dId, amount: 2000, allocations: [{ ar_id: arB.data.id, amount: 2000 }] }
    })
    ok('A08 收款单建出来了', rcB.status === 200 && !!rcB.data?.id, { status: rcB.status, code: rcB.beCode, msg: rcB.msg })
    const allocRows = rcB.data?.id ? qa('SELECT ar_id, amount FROM receipt_allocations WHERE receipt_id=?', rcB.data.id) : []
    ok(
      'A08 核销只落在**显式指定**的那张（乙）上（旧缺陷：被 FIFO 抵到同主体的甲）',
      allocRows.length === 1 && Number(allocRows[0].ar_id) === Number(arB.data.id),
      allocRows
    )
    ok(
      'A08 另一张（甲）一个字节都没被抵',
      Number(q1('SELECT allocated_amount FROM ar_documents WHERE id=?', arA.data.id).allocated_amount) === 0,
      q1('SELECT allocated_amount FROM ar_documents WHERE id=?', arA.data.id)
    )
    const cfmB = await api('POST', `/api/ar/receipts/${rcB.data.id}/confirm`, { token: finance, body: {} })
    ok('A08 确认收款成功（甲仍未结、乙已结清）', cfmB.status === 200, { status: cfmB.status, code: cfmB.beCode, msg: cfmB.msg })
    eq('A08 乙应收已结清', q1('SELECT status FROM ar_documents WHERE id=?', arB.data.id).status, 'closed')
    eq('A08 甲应收仍是未结', q1('SELECT status FROM ar_documents WHERE id=?', arA.data.id).status, 'open')
  }
}

// ==========================================================================
group('S16 A07 / A10 —— 核销与红冲的边界')
// ==========================================================================
//   A07  可超实收核销 / 多张草稿可重复抵同一 AR
//   A10  部分发票红冲会把**共享的整笔订单级应收**一起作废
{
  const acc = q1("SELECT * FROM credit_accounts WHERE subject_type='dealer' AND credit_limit > 0 ORDER BY id LIMIT 1")
  const dId = acc?.subject_id
  ok('A07 找到往来对象（复用 A06 的那家经销商）', !!dId, dId)

  if (dId) {
    const mkAr = async (amount, remark) =>
      (await api('POST', '/api/ar/documents', { token: sales, body: { subject_type: 'dealer', subject_id: dId, source_type: 'MANUAL', amount, remark } }))

    // ① 核销额 > 实收额 → 拒（截平是旧行为：填 1000 悄悄按 100 核销）
    const arX = await mkAr(1000, '独立验收·A07 超实收')
    ok('A07 造出一张 1000 的未结应收', arX.status === 200, arX.data?.id)
    const overRecv = await api('POST', '/api/ar/receipts', {
      token: sales, body: { subject_type: 'dealer', subject_id: dId, amount: 100, allocations: [{ ar_id: arX.data.id, amount: 1000 }] }
    })
    mark('A07 核销额 > 实收额（负）', 'POST', '/api/ar/receipts', overRecv, 409)
    eq('A07 核销额 > 实收额 → 409（不是截平后静默成功）', overRecv.status, 409)
    eq('A07 拒绝码 RC_ALLOC_EXCEEDS_RECEIPT', overRecv.beCode, 'RC_ALLOC_EXCEEDS_RECEIPT')
    ok('A07 拒绝里带出了两个可核对的数（实收剩余 / 本次要核）', overRecv.body?.detail?.remaining != null && overRecv.body?.detail?.want != null, overRecv.body?.detail)
    eq('A07 被拒后一张收款单都没落库', q1('SELECT COUNT(*) c FROM receipts WHERE subject_id=? AND amount=100', dId).c, 0)

    // ② 核销额 > 应收未核销余额 → 拒
    const overAr = await api('POST', '/api/ar/receipts', {
      token: sales, body: { subject_type: 'dealer', subject_id: dId, amount: 5000, allocations: [{ ar_id: arX.data.id, amount: 5000 }] }
    })
    eq('A07 核销额 > 应收未核销余额 → 409', overAr.status, 409)
    eq('A07 拒绝码 RC_ALLOC_EXCEEDS_AR', overAr.beCode, 'RC_ALLOC_EXCEEDS_AR')

    // ③ 同一张应收在一次核销里出现两次 → 拒（旧实现 OR REPLACE 会静默盖掉前一条）
    const dup = await api('POST', '/api/ar/receipts', {
      token: sales, body: { subject_type: 'dealer', subject_id: dId, amount: 500, allocations: [{ ar_id: arX.data.id, amount: 200 }, { ar_id: arX.data.id, amount: 300 }] }
    })
    eq('A07 同一应收在一次核销里重复出现 → 400', dup.status, 400)
    eq('A07 拒绝码 RC_ALLOC_DUPLICATE_AR', dup.beCode, 'RC_ALLOC_DUPLICATE_AR')

    // ④ 两张草稿各抵同一应收：草稿各自合法，**确认的那一刻**必须挡住第二张
    const arY = await mkAr(1000, '独立验收·A07 重复抵')
    ok('A07 造出一张 1000 的未结应收（重复抵样本）', arY.status === 200, arY.data?.id)
    const p1 = await api('POST', '/api/ar/receipts', { token: sales, body: { subject_type: 'dealer', subject_id: dId, amount: 1000, allocations: [{ ar_id: arY.data.id, amount: 1000 }] } })
    const p2 = await api('POST', '/api/ar/receipts', { token: sales, body: { subject_type: 'dealer', subject_id: dId, amount: 1000, allocations: [{ ar_id: arY.data.id, amount: 1000 }] } })
    ok('A07 两张草稿各自都能建（草稿不占额 —— 设计如此）', p1.status === 200 && p2.status === 200, { 一: p1.status, 二: p2.status, code2: p2.beCode })
    const c1 = await api('POST', `/api/ar/receipts/${p1.data?.id}/confirm`, { token: finance, body: {} })
    ok('A07 第一张确认成功', c1.status === 200, { status: c1.status, code: c1.beCode, msg: c1.msg })
    const c2 = await api('POST', `/api/ar/receipts/${p2.data?.id}/confirm`, { token: finance, body: {} })
    mark('A07 第二张草稿确认（负·重复抵同一应收）', 'POST', `/api/ar/receipts/${p2.data?.id}/confirm`, c2, 409)
    eq('A07 第二张确认被拒（不得静默成功）', c2.status, 409)
    eq('A07 拒绝码 AR_OVER_ALLOCATED', c2.beCode, 'AR_OVER_ALLOCATED')
    eq('A07 第二张仍是草稿（没被偷偷确认）', q1('SELECT status FROM receipts WHERE id=?', p2.data?.id).status, 'draft')
    ok(
      'A07 该应收的已确认核销额没有超过应收金额',
      Number(q1('SELECT allocated_amount FROM ar_documents WHERE id=?', arY.data.id).allocated_amount) <= 1000.005,
      q1('SELECT allocated_amount FROM ar_documents WHERE id=?', arY.data.id)
    )
  }

  // ---------- A10：部分发票红冲不得作废整笔订单级应收 ----------
  const pair = q1(`SELECT i.id AS inv_id, i.doc_no AS inv_no, i.total_amount, i.ar_id,
      l.relation, a.source_type, a.source_id, a.amount AS ar_amount, a.status AS ar_status,
      (SELECT COUNT(*) FROM invoice_ar_links l2 WHERE l2.ar_id = a.id) AS sharers
    FROM sales_invoices i
    JOIN invoice_ar_links l ON l.invoice_id = i.id
    JOIN ar_documents a ON a.id = l.ar_id
    WHERE i.status='confirmed' AND l.relation='linked' AND a.source_type='SO' AND a.status IN ('open','partial')
    ORDER BY i.id LIMIT 1`)
  ok(
    'A10 找到"发票关联**订单级** SO 应收"的样本（A10 说的就是这种共享应收）',
    !!pair,
    pair && { 发票: pair.inv_no, 票额: pair.total_amount, ar_id: pair.ar_id, 应收额: pair.ar_amount, ar状态: pair.ar_status, 共享票数: pair.sharers }
  )
  if (pair) {
    eq('A10 该应收确实挂在销售订单上（source_type=SO，不是发票自建的 SI）', pair.source_type, 'SO')
    const before = q1('SELECT status, amount, allocated_amount FROM ar_documents WHERE id=?', pair.ar_id)
    const red = await api('POST', `/api/invoices/${pair.inv_id}/red-chart`, { token: finance, body: { reason: '独立验收·A10 部分红冲' } })
    mark('A10 部分发票红冲（正）', 'POST', `/api/invoices/${pair.inv_id}/red-chart`, red, 200)
    ok('A10 红冲成功（共享应收不该成为"红冲不了"的理由）', red.status === 200, { status: red.status, code: red.beCode, msg: red.msg })
    const after = q1('SELECT status, amount, allocated_amount FROM ar_documents WHERE id=?', pair.ar_id)
    eq('A10 共享的订单级应收**没有被作废**', after.status, before.status)
    eq('A10 共享应收的金额没有被改动', Number(after.amount), Number(before.amount))
    eq('A10 共享应收的已核销额没有被改动', Number(after.allocated_amount), Number(before.allocated_amount))
    const redRow = q1('SELECT status, red_chart_of_id, amount FROM sales_invoices WHERE red_chart_of_id=? ORDER BY id DESC LIMIT 1', pair.inv_id)
    ok('A10 原票置红冲 + 生成一张负数红字票指回原票（红冲这件事本身是真的）', redRow && redRow.status === 'confirmed' && Number(redRow.amount) < 0, redRow)
  }
}

// ==========================================================================
group('S17 A11 / A13 —— 跨批次成本 与 不可售批次闸门')
// ==========================================================================
//   A11  跨批次领料成本误用"最后一批单价"（两批价差越大错得越多，而且账还平）
//   A13  待检/不合格批次仍可进入可售拣选；**显式指定批次**还能绕过冻结/效期/检验闸门
// A11 走真实 HTTP（MCP 入库造两批 + 制造领料单出库）；A13 的"参数口径"必须同进程直调，
// 原因见 `openWrite` 上方的注释。
{
  const { pickBatches, applyStockOut, clearParamCache, getInvParam } = await import(path.join(ROOT, 'server/lib/stock.js'))
  const mo = q1("SELECT * FROM production_orders WHERE status='in_progress' AND warehouse_id IS NOT NULL ORDER BY id LIMIT 1")
  ok('A11 找到一张"生产中"的生产订单（只有这个状态能领料）', !!mo, mo && { id: mo.id, doc_no: mo.doc_no, warehouse_id: mo.warehouse_id })

  // ---------- A11 ----------
  if (mo) {
    // 挑一个"在该仓完全没有库存"的 SKU：这样参与拣选的**只可能是本用例造的那两批**，
    // 断言才不会被别的批次干扰（否则"行成本 = 150"会因为拣到了别的批次而碰巧成立/失败）。
    const fresh = q1('SELECT id, sku_code FROM product_skus WHERE id NOT IN (SELECT sku_id FROM inventory_stocks WHERE warehouse_id=?) ORDER BY id LIMIT 1', mo.warehouse_id)
    ok('A11 找到一个在该仓零库存的 SKU（保证只有本用例的两批参与拣选）', !!fresh, fresh)

    if (fresh) {
      const tag = `${Date.now()}`
      const bA = `ACC-A11-甲-${tag}`
      const bB = `ACC-A11-乙-${tag}`
      const inA = await mcp(mcpTok, 'inventory.stock_in', { warehouse_id: mo.warehouse_id, sku_id: fresh.id, qty: 5, unit_cost: 10, batch_no: bA, idempotency_key: `acc-a11-in-a-${tag}` })
      const inB = await mcp(mcpTok, 'inventory.stock_in', { warehouse_id: mo.warehouse_id, sku_id: fresh.id, qty: 5, unit_cost: 20, batch_no: bB, idempotency_key: `acc-a11-in-b-${tag}` })
      ok('A11 两个批次已入库（甲 5×10 / 乙 5×20）', !inA.isError && !inB.isError, { 甲: inA.payload || inA.rpcError, 乙: inB.payload || inB.rpcError })
      ok(
        'A11 两批库存确实分开落账（成本不同）',
        qa('SELECT batch_no, qty_on_hand, cost_price FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? ORDER BY batch_no', mo.warehouse_id, fresh.id)
          .filter((r) => r.batch_no === bA || r.batch_no === bB).length === 2,
        qa('SELECT batch_no, qty_on_hand, cost_price FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? ORDER BY batch_no', mo.warehouse_id, fresh.id)
      )

      const mk = await api('POST', '/api/manufacture/issues', {
        token: admin,
        body: { order_id: mo.id, warehouse_id: mo.warehouse_id, issue_type: 'by_bom', items: [{ sku_id: fresh.id, qty: 10, plan_qty: 10, batch_no: '' }] }
      })
      mark('A11 建生产领料单（正·不指定批次 ⇒ 允许跨批次）', 'POST', '/api/manufacture/issues', mk, 200)
      ok('A11 领料单建出来了', mk.status === 200 && !!mk.data?.id, { status: mk.status, code: mk.beCode, msg: mk.msg })
      const issueId = mk.data?.id

      if (issueId) {
        await api('POST', `/api/manufacture/issues/${issueId}/submit`, { token: admin, body: {} })
        const ap = await api('POST', `/api/manufacture/issues/${issueId}/approve`, { token: admin, body: {} })
        ok('A11 领料单审批通过', ap.status === 200, { status: ap.status, code: ap.beCode, msg: ap.msg })
        const out = await api('POST', `/api/manufacture/issues/${issueId}/issue`, { token: admin, body: {} })
        mark('A11 确认领料出库（正）', 'POST', `/api/manufacture/issues/${issueId}/issue`, out, 200)
        ok('A11 确认出库成功', out.status === 200, { status: out.status, code: out.beCode, msg: out.msg })

        const line = q1('SELECT qty, unit_cost, amount FROM material_issue_items WHERE issue_id=? ORDER BY line_no LIMIT 1', issueId)
        const txs = qa('SELECT batch_no, qty, unit_cost, doc_type FROM inventory_transactions WHERE doc_no=? ORDER BY id', out.data?.doc_no)
        ok('A11 出库流水是**逐批**两行（甲 10 元批 + 乙 20 元批）', txs.length === 2, { doc_no: out.data?.doc_no, txs })
        const perBatch = txs.reduce((n, t) => n + Number(t.qty) * Number(t.unit_cost), 0)
        ok(
          'A11 行成本 = 各批次金额之和（5×10 + 5×20 = 150，而不是 10 × 末批价 20 = 200）',
          Math.abs(Number(line.amount) - 150) < 0.01 && Math.abs(perBatch - 150) < 0.01,
          { 行金额: line.amount, 行单价: line.unit_cost, 逐批之和: perBatch }
        )
        ok(
          'A11 行金额与逐批流水之和一致（没有一个数是"另外算的"）',
          Math.abs(Number(line.amount) - perBatch) < 0.01,
          { 行: line.amount, 逐批: perBatch }
        )
        ok(
          'A11 加权平均单价让 `数量 × 单价` 恰好等于总额（上游就是这么算整行成本的）',
          Math.abs(Number(line.qty) * Number(line.unit_cost) - Number(line.amount)) < 0.01,
          { qty: line.qty, unit_cost: line.unit_cost, amount: line.amount }
        )

        // ---------- A13：可售货出库必须挡住不可售批次 ----------
        const usable = (r) => r && r.qty_on_hand > 1
        const rejected = q1(`SELECT s.warehouse_id, s.sku_id, s.batch_no, s.qty_on_hand
          FROM inventory_stocks s JOIN inventory_batches b ON b.sku_id=s.sku_id AND b.batch_no=s.batch_no
          WHERE b.qc_status='rejected' AND s.qty_on_hand > 1 ORDER BY s.id LIMIT 1`)
        ok('A13 找到"检验不合格"且有库存的批次', usable(rejected), rejected)

        const rw = openWrite()
        try {
          if (usable(rejected)) {
            const picked = pickBatches(rw, rejected.warehouse_id, rejected.sku_id, 1e9)
            ok(
              'A13 自动拣选跳过了不合格批次（它的库存 > 0，所以"没拣到"不是因为没货）',
              !picked.picks.some((p) => p.batchNo === rejected.batch_no) && picked.skippedUnusable > 0,
              { qty_on_hand: rejected.qty_on_hand, picks: picked.picks.length, skippedUnusable: picked.skippedUnusable }
            )

            // 显式指定该批次走**可售货出库**（MR = 生产领料，在可售清单里）→ 必须被拒
            const mkBad = await api('POST', '/api/manufacture/issues', {
              token: admin,
              body: {
                order_id: mo.id, warehouse_id: rejected.warehouse_id, issue_type: 'by_bom',
                items: [{ sku_id: rejected.sku_id, qty: 1, plan_qty: 1, batch_no: rejected.batch_no }]
              }
            })
            ok('A13 建一张"指名不合格批次"的领料单', mkBad.status === 200 && !!mkBad.data?.id, { status: mkBad.status, code: mkBad.beCode, msg: mkBad.msg })
            if (mkBad.data?.id) {
              await api('POST', `/api/manufacture/issues/${mkBad.data.id}/submit`, { token: admin, body: {} })
              await api('POST', `/api/manufacture/issues/${mkBad.data.id}/approve`, { token: admin, body: {} })
              const badOut = await api('POST', `/api/manufacture/issues/${mkBad.data.id}/issue`, { token: admin, body: {} })
              mark('A13 指名不合格批次做可售出库（负）', 'POST', `/api/manufacture/issues/${mkBad.data.id}/issue`, badOut, 409)
              eq('A13 显式指定不合格批次出库 → 409', badOut.status, 409)
              eq('A13 拒绝码 BATCH_NOT_SELLABLE', badOut.beCode, 'BATCH_NOT_SELLABLE')
              eq(
                'A13 被拒后该批次库存一个字节都没动',
                Number(q1('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?', rejected.warehouse_id, rejected.sku_id, rejected.batch_no).qty_on_hand),
                Number(rejected.qty_on_hand)
              )
            }
          }

          // 待检批次：**参数没开就放行、开了才挡** —— 验的是"挡这个动作由参数决定"，
          // 而不是"某个写死的 if"。而且必须先证明"参数没开时它确实参与拣选"，
          // 否则后面那条"置 1 后被排除"可能只是因为别的原因没拣到（假绿）。
          const pending = q1(`SELECT s.warehouse_id, s.sku_id, s.batch_no, s.qty_on_hand
            FROM inventory_stocks s JOIN inventory_batches b ON b.sku_id=s.sku_id AND b.batch_no=s.batch_no
            WHERE b.qc_status='pending' AND s.qty_on_hand > 1 AND b.status='active' ORDER BY s.id LIMIT 1`)
          ok('A13 找到"待检"且有库存的批次', usable(pending), pending)
          if (usable(pending)) {
            // ⚠️ `block_pending_qc` 在种子里**根本没有这一行**（只在 `lib/stock.js` 的注释里被提到过）。
            // 只写 UPDATE 会 0 行受影响 —— 参数静默没变，测试看起来像"闸门没生效"，
            // 而真相是"我压根没把参数改成 1"。所以用 upsert；
            // 收尾按"原来有没有这一行"原样还原（原来没有就删掉，不留我造的行）。
            const priorRow = q1("SELECT param_value FROM inv_params WHERE param_key='block_pending_qc' AND scope='global'")
            // ⚠️ 这里必须**每次重新查一行再决定 INSERT/UPDATE**：
            // 第一次 INSERT 之后库里就有这一行了，若仍按"捕获的 priorRow 为空"去 INSERT，
            // 会插出**第二行**，而 `getInvParam` 的 global 分支是 `LIMIT 1` **不带 ORDER BY** ——
            // 读到的还是第一行（旧值），参数静默不生效。我第一版就踩了这个坑。
            const setPendingQc = (v) => {
              const row = rw.prepare("SELECT id FROM inv_params WHERE param_key='block_pending_qc' AND scope='global' ORDER BY id LIMIT 1").get()
              if (row) rw.prepare('UPDATE inv_params SET param_value=? WHERE id=?').run(String(v), row.id)
              else {
                rw.prepare(
                  "INSERT INTO inv_params (scope, scope_value, param_key, param_value, remark) VALUES ('global', NULL, 'block_pending_qc', ?, '独立验收·临时')"
                ).run(String(v))
              }
              clearParamCache(rw)
            }
            setPendingQc('0')
            const off = pickBatches(rw, pending.warehouse_id, pending.sku_id, 1e9)
            ok(
              'A13 参数未开（block_pending_qc=0）时待检批次**参与**拣选（先证明默认是放行的）',
              off.picks.some((p) => p.batchNo === pending.batch_no),
              { batch: pending.batch_no, picks: off.picks.map((p) => p.batchNo).slice(0, 5) }
            )

            setPendingQc('1')
            eq('A13 参数确实被读到 1（否则下面那条"被排除"可能只是我改错了地方）', getInvParam(rw, 'block_pending_qc', '0'), '1')
            const on = pickBatches(rw, pending.warehouse_id, pending.sku_id, 1e9)
            ok(
              'A13 参数置 1 后待检批次被排除出自动拣选',
              !on.picks.some((p) => p.batchNo === pending.batch_no) && on.skippedUnusable > 0,
              { batch: pending.batch_no, picks: on.picks.map((p) => p.batchNo).slice(0, 5), skippedUnusable: on.skippedUnusable }
            )
            let thrown = null
            try {
              applyStockOut(rw, {
                bizDate: '2026-10-16', docType: 'SAL_OUT', docNo: `ACC-A13-${Date.now()}`,
                warehouseId: pending.warehouse_id, skuId: pending.sku_id, batchNo: pending.batch_no, qty: 1, source: 'accept'
              })
            } catch (e) { thrown = e }
            ok(
              'A13 参数置 1 后显式指定待检批次做销售出库 → 409 BATCH_NOT_SELLABLE',
              thrown?.code === 'BATCH_NOT_SELLABLE',
              thrown ? { code: thrown.code, message: thrown.message } : '未抛错 —— 指名批次绕过了闸门'
            )
            // 还原参数：这一节改的是**临时库的配置**，收尾必须回到原样，
            // 否则后面的节（乃至下一轮同一临时目录）会继承一个"待检全禁售"的世界。
            if (priorRow) {
              rw.prepare("UPDATE inv_params SET param_value=? WHERE param_key='block_pending_qc' AND scope='global'").run(priorRow.param_value)
            } else {
              // 种子里本来没有这一行 —— 我造的行要清干净（只删这一行，不动别的参数）
              rw.prepare("DELETE FROM inv_params WHERE param_key='block_pending_qc' AND scope='global'").run()
            }
            clearParamCache(rw)
            const back = pickBatches(rw, pending.warehouse_id, pending.sku_id, 1e9)
            ok(
              'A13 用例自还原：参数回到原样（原来没有这一行就删掉），待检批次重新参与拣选',
              back.picks.some((p) => p.batchNo === pending.batch_no),
              { 参数: q1("SELECT param_value FROM inv_params WHERE param_key='block_pending_qc' AND scope='global'")?.param_value ?? '(无此参数)' }
            )
          }
        } finally {
          rw.close()
        }
      }
    }
  }
}

// ==========================================================================
group('S10 静态自证 —— 路由遮蔽（字面段必须排在参数段之前）')
{
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/check-route-order.mjs')], { encoding: 'utf8' })
  ok('没有"存在但永远 404"的接口', r.status === 0, (r.stdout || '').split('\n').slice(-6).join(' | '))
}

// ==========================================================================
group('S9 收尾 —— 库副作用总核对')
// ==========================================================================
// ==========================================================================
const negStock = qa('SELECT * FROM inventory_stocks WHERE qty_on_hand < 0')
eq('没有负库存', negStock.length, 0)
const badVoucher = qa('SELECT id FROM vouchers WHERE ABS(total_debit - total_credit) >= 0.005')
eq('没有不平的凭证', badVoucher.length, 0)
const orphan = q1(`SELECT COUNT(*) c FROM sales_return_items i
  LEFT JOIN sales_returns h ON h.id = i.return_id WHERE h.id IS NULL`).c
eq('退货明细没有孤儿', orphan, 0)

// ---------- 结果 ----------
const passed = results.filter((r) => r.pass).length
const failed = results.length - passed
console.log(`\n${'─'.repeat(72)}`)
console.log(`独立验收（自查）结果：通过 ${passed} / 失败 ${failed}（共 ${results.length} 项）`)
const byGroup = {}
for (const r of results) { byGroup[r.group] = byGroup[r.group] || { p: 0, f: 0 }; r.pass ? byGroup[r.group].p++ : byGroup[r.group].f++ }
for (const [g, v] of Object.entries(byGroup)) console.log(`  ${v.f === 0 ? '✓' : '✗'} ${g}  ${v.p}/${v.p + v.f}`)

const evDir = path.join(ROOT, 'docs/evidence')
mkdirSync(evDir, { recursive: true })
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '')
const evPath = path.join(evDir, `独立验收_必打反例_${stamp}.json`)
writeFileSync(evPath, JSON.stringify({
  kind: 'independent-self-acceptance',
  at: new Date().toISOString(),
  commit_sha: sha,
  commit_sha_source: commitShaSource,
  working_tree_dirty: !!dirty,
  source_root: ROOT,
  // ⚠️ 这里**不再**有 `is_isolated_copy` 这样的自我声明布尔：
  // 它就是"路径不等于某个字面量"，既证不了实也证不了伪。改成下面这些可观察事实。
  isolation_facts: isolationFacts,
  isolation: { data_dir: DATA, port: PORT, fresh_databases: ['cosmetic', 'food', 'apparel'] },
  summary: { total: results.length, passed, failed },
  http_checklist: httpChecklist,
  results
}, null, 2))

// 端到端 HTTP 清单单独落一份 Markdown（验收标准第 7 条要的就是这张表）
const clPath = path.join(evDir, '独立验收_端到端HTTP清单.md')
writeFileSync(clPath, [
  `# 独立验收 · 端到端 HTTP 清单`,
  ``,
  `> 对象提交：\`${sha}\`（来源：${commitShaSource}）｜服务：${isoSummary} + 全新三库 + 独立端口 ${PORT}｜生成：${new Date().toISOString()}`,
  `> 全部请求用**真实 HTTP + 真实令牌**发出（不是 router.handle 注入）。`,
  ``,
  `| # | 用例 | 方法 | URL | 期望码 | 实际码 | 业务码 | 判定 |`,
  `|---|---|---|---|---|---|---|---|`,
  ...httpChecklist.map((r, i) => `| ${i + 1} | ${r.label} | ${r.method} | \`${r.url}\` | ${r.expect} | ${r.got} | ${r.code || '—'} | ${r.ok ? '✅' : '❌'} |`),
  ``,
  `合计 **${httpChecklist.length}** 条：正向 ${httpChecklist.filter((r) => Number(r.got) < 300).length} · 负向 ${httpChecklist.filter((r) => Number(r.got) >= 400).length}`,
  ``
].join('\n'))
console.log(`HTTP 清单：${clPath}`)
console.log(`\n证据：${evPath}`)

await stopServer()
if (!KEEP) rmSync(TMP, { recursive: true, force: true })
else console.log(`临时目录保留：${TMP}`)
process.exit(failed ? 1 : 0)
