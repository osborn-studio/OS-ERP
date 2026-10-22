/**
 * ============================================================================
 * 文件标识：scripts/test-mcp.mjs ｜ 测试：MCP 能力层端到端测试：握手 → 按权限过滤工具 → 三级执行链（read/write/danger）
 * ============================================================================
 * 【职责】测试：MCP 能力层端到端测试：握手 → 按权限过滤工具 → 三级执行链（read/write/danger）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// MCP 能力层端到端测试：握手 → 按权限过滤工具 → 三级执行链（read/write/danger）
//   node scripts/test-mcp.mjs
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const PORT = 3197
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0, fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; failed.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + detail : ''}`) }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

// ---------- 起服务 ----------
const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))
const started = Date.now()
const ready = await new Promise((res) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) { clearInterval(t); res(true) }
    else if (Date.now() - started > 180000) { clearInterval(t); res(false) }
  }, 300)
})
if (!ready) {
  console.log('❌ 服务启动失败：\n' + log.split('\n').slice(-30).join('\n'))
  srv.kill('SIGKILL'); process.exit(1)
}
console.log('✅ 服务已启动')

// ---------- 登录 + 签发三档 Agent Token ----------
const login = await (await fetch(`${BASE}/api/auth/login`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' })
})).json()
const jwt = login.data?.token
if (!jwt) { console.log('❌ admin 登录失败：' + JSON.stringify(login)); srv.kill('SIGKILL'); process.exit(1) }

async function issueToken(name, scopes) {
  const r = await (await fetch(`${BASE}/api/mcp/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
    body: JSON.stringify({ name, scopes })
  })).json()
  if (!r.data?.token) throw new Error('签发失败: ' + JSON.stringify(r))
  return r.data.token
}
const tkRead = await issueToken('测试·只读', 'read')
const tkWrite = await issueToken('测试·事务', 'read,write')
const tkDanger = await issueToken('测试·全权', 'read,write,danger')
console.log('已签发三档 Token')

// ---------- MCP 调用封装 ----------
let seq = 0
async function mcp(method, params, token, extraHeaders = {}) {
  const res = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
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
  try { return JSON.parse(t) } catch { return t }
}
const brief = (r) => {
  try { return JSON.stringify(r.body).slice(0, 200) } catch { return String(r) }
}

// ============================================================
section('T1 握手（无需凭据）')
const init = await mcp('initialize', { protocolVersion: '2026-07-28', clientInfo: { name: 'test' } })
ok('initialize 成功', init.body.result?.protocolVersion === '2026-07-28', JSON.stringify(init.body).slice(0, 120))
ok('声明了 tools/resources/prompts 能力', !!init.body.result?.capabilities?.tools && !!init.body.result?.capabilities?.resources)

section('T2 工具清单按 Token 权限过滤')
const listAll = await mcp('tools/list', {}, tkDanger)
const listRead = await mcp('tools/list', {}, tkRead)
const nAll = listAll.body.result?.tools?.length || 0
const nRead = listRead.body.result?.tools?.length || 0
ok(`全权 Token 可见 ${nAll} 个工具`, nAll >= 20, `实际 ${nAll}`)
ok(`只读 Token 只见 ${nRead} 个（严格少于全权）`, nRead > 0 && nRead < nAll, `${nRead} vs ${nAll}`)
const levelsOf = (l) => new Set((l.body.result?.tools || []).map((t) => t.annotations?.level))
ok('全权含 read/write/danger 三档', levelsOf(listAll).size === 3, [...levelsOf(listAll)].join(','))
ok('只读仅含 read 档', [...levelsOf(listRead)].join(',') === 'read', [...levelsOf(listRead)].join(','))

section('T3 只读工具调用')
const q = await mcp('tools/call', { name: 'inventory.query_stock', arguments: { limit: 5 } }, tkRead)
ok('inventory.query_stock 调用成功', !isErr(q), JSON.stringify(q.body).slice(0, 160))
ok('返回库存行', Array.isArray(textOf(q)?.list), JSON.stringify(textOf(q)).slice(0, 120))

const kpi = await mcp('tools/call', { name: 'report.dashboard_kpi', arguments: {} }, tkRead)
ok('report.dashboard_kpi 返回库存总值', typeof textOf(kpi)?.stock_value === 'number', JSON.stringify(textOf(kpi)).slice(0, 160))

section('T4 越权拦截')
const denied = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: 1, sku_id: 1, qty: 1, unit_cost: 1, idempotency_key: 'k-deny' } }, tkRead)
ok('只读 Token 调事务工具被拒', isErr(denied), JSON.stringify(denied.body.error || '').slice(0, 120))
ok('错误信息点明权限范围', String(textOf(denied)?.message || '').includes('权限范围'), brief(denied))

const noToken = await mcp('tools/call', { name: 'inventory.query_stock', arguments: {} }, null)
ok('无 Token 被拒', !!noToken.body.error, JSON.stringify(noToken.body).slice(0, 120))

section('T5 事务类强制幂等键')
const noKey = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: 1, sku_id: 1, qty: 3, unit_cost: 10 } }, tkWrite)
ok('缺幂等键被拒', isErr(noKey))
ok('提示可用 idempotency_key', String(textOf(noKey)?.message || '').includes('idempotency_key'), brief(noKey))

const before = textOf(await mcp('tools/call', { name: 'inventory.get_cost', arguments: { sku_id: 1, warehouse_id: 1 } }, tkWrite))
const BATCH = 'MCPTEST-' + Date.now()   // 每轮唯一，保证测试可重复运行
const key = 'test-idem-' + Date.now()
const in1 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: 1, sku_id: 1, qty: 3, unit_cost: 10, batch_no: BATCH, idempotency_key: key } }, tkWrite)
ok('带幂等键入库成功', !isErr(in1), JSON.stringify(in1.body).slice(0, 160))
const after1 = textOf(await mcp('tools/call', { name: 'inventory.get_cost', arguments: { sku_id: 1, warehouse_id: 1, batch_no: BATCH } }, tkWrite))
ok('库存已增加 3', after1?.qty === 3, `实际 ${after1?.qty}`)

const in2 = await mcp('tools/call', { name: 'inventory.stock_in', arguments: { warehouse_id: 1, sku_id: 1, qty: 3, unit_cost: 10, batch_no: BATCH, idempotency_key: key } }, tkWrite)
ok('重复同幂等键被识别为重放', in2.body.result?._idempotent_replay === true, JSON.stringify(in2.body).slice(0, 160))
const after2 = textOf(await mcp('tools/call', { name: 'inventory.get_cost', arguments: { sku_id: 1, warehouse_id: 1, batch_no: BATCH } }, tkWrite))
ok('重放未重复扣加库存（仍为 3）', after2?.qty === 3, `实际 ${after2?.qty}`)

section('T6 高危动作人工二次确认')
const adjArgs = { warehouse_id: 1, sku_id: 1, batch_no: BATCH, delta: 5, reason: 'MCP 测试盘盈' }
const d1 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDanger)
const d1t = textOf(d1)
ok('高危动作返回 confirmation_required', d1t?.status === 'confirmation_required', brief(d1))
const cfm = d1t?.confirm_token
ok('返回 confirm_token', !!cfm)

const d2 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm } }, tkDanger)
ok('未经人工确认直接执行被拒', isErr(d2), brief(d2))

// 人工确认（用登录用户的 JWT —— 这才叫「人工」）
// 二次确认的两道闸（D4-4a 修复后新增，必须都验）：
//   ① 权限门：viewer 这类角色不得批准；② 自批拦截：申请人本人不得批准自己的确认单。
// 令牌是 admin 签的（owner = admin），所以 admin 自己批必须被拒 —— 这正是本次修的反例。
async function loginAs(username, password) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, industry: 'cosmetic' })
  })
  return (await res.json()).data?.token
}
async function approve(token, cfmToken) {
  const res = await fetch(`${BASE}/mcp/confirmations/${cfmToken}/approve`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }
  })
  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const selfApprove = await approve(jwt, cfm)
ok('申请人本人不能批准自己的确认单（403）', selfApprove.status === 403, JSON.stringify(selfApprove.body).slice(0, 140))

const viewerJwt = await loginAs('viewer', '123456')
const viewerApprove = await approve(viewerJwt, cfm)
ok('viewer 无确认权限，批准被拒（403）', viewerApprove.status === 403, JSON.stringify(viewerApprove.body).slice(0, 140))

// 换一个**有确认权限、且不是申请人**的账号来批
const financeJwt = await loginAs('finance', '123456')
const appr = await approve(financeJwt, cfm)
ok('由他人人工确认成功', appr.body?.data?.status === 'confirmed', JSON.stringify(appr.body).slice(0, 140))

const d3 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm } }, tkDanger)
ok('确认后执行成功', !isErr(d3), JSON.stringify(d3.body).slice(0, 160))

const d4 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm } }, tkDanger)
ok('确认单用后失效（不可重复执行）', isErr(d4), brief(d4))

// 参数指纹：确认的是这一组参数，换一组必须重新申请（D4-4b）
// 用一张**新的**确认单来验 —— 上面那张已经被用掉了，拿它测的是"状态已 used"而不是"参数不符"。
const e1 = await mcp('tools/call', { name: 'inventory.adjust', arguments: adjArgs }, tkDanger)
const cfm2 = textOf(e1)?.confirm_token
ok('再次发起得到一张新确认单', !!cfm2 && cfm2 !== cfm, String(cfm2))
const appr2 = await approve(financeJwt, cfm2)
ok('第二张确认单同样需要他人批准', appr2.body?.data?.status === 'confirmed', JSON.stringify(appr2.body).slice(0, 140))

const d5 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, delta: 9999, confirm_token: cfm2 } }, tkDanger)
ok('改参数执行已批准的确认单被拒', isErr(d5) && String(textOf(d5)?.message || '').includes('参数'), brief(d5))

const d6 = await mcp('tools/call', { name: 'inventory.adjust', arguments: { ...adjArgs, confirm_token: cfm2 } }, tkDanger)
ok('参数比对失败不消耗确认单，原参数仍可执行', !isErr(d6), JSON.stringify(d6.body).slice(0, 160))

section('T7 资源与提示')
const rl = await mcp('resources/list', {}, tkRead)
ok('resources/list 返回资源', (rl.body.result?.resources || []).length >= 4, String((rl.body.result?.resources || []).length))
const rr = await mcp('resources/read', { uri: 'gml://dashboard/kpi' }, tkRead)
ok('resources/read 能读到 KPI', (rr.body.result?.contents?.[0]?.text || '').length > 10)
const pl = await mcp('prompts/list', {}, tkRead)
ok('prompts/list 返回提示模板', (pl.body.result?.prompts || []).length >= 4, String((pl.body.result?.prompts || []).length))
const pg = await mcp('prompts/get', { name: 'stock_health_check', arguments: {} }, tkRead)
ok('prompts/get 返回可执行指令', (pg.body.result?.messages?.[0]?.content?.text || '').includes('inventory.stock_alert'))

section('T8 调用审计')
const logs = await (await fetch(`${BASE}/api/mcp/logs?limit=50`, { headers: { Authorization: `Bearer ${jwt}` } })).json()
const rows = logs.data || []
ok('审计日志已记录', rows.length > 0, `实际 ${rows.length} 条`)
ok('记录了工具名与级别', rows.some((r) => r.tool_name && r.level))
ok('记录了失败调用（拦截也留痕）', rows.some((r) => r.ok === 0))
ok('记录了幂等键', rows.some((r) => r.idempotency_key && r.idempotency_key.startsWith('test-idem')))

const stats = await (await fetch(`${BASE}/api/mcp/stats`, { headers: { Authorization: `Bearer ${jwt}` } })).json()
ok('统计接口按级别聚合', (stats.data?.by_level || []).length > 0, JSON.stringify(stats.data?.by_level))

// ---------------------------------------------------------------------------
section('T9 数量类参数的下界 —— 无意义的动作必须被参数校验层拒绝')
// 这一节是**批次 T 独立验收抓到的缺陷**的常驻守卫：
//   `inventory.stock_out` 传 `qty:-5` 时，自动拣选收到非正需求会返回**空拣选**，
//   handler 里那个 `for (const pk of picks)` 一次都不跑，最后 `ok(...)` 返回
//   「出库 -5，涉及 0 个批次」—— **成功、但什么都没做**。而 `applyStockOut` 自己的
//   `assertPositiveQty` 根本没被走到（循环没进）。同类洞在 transfer / ownership_transfer 上一样存在。
//
// 判据刻意写成「这些 (工具, 参数, 非法值) **必须**被拒」而不是「schema 里有没有写约束」——
// 前者在约束被删掉时会变红，后者不会（没有约束就没有断言，正是那种"安静的洞"）。
{
  const { TOOL_MAP } = await import('../server/mcp/tools.js')
  const { validateToolArgs } = await import('../server/mcp/validate.js')
  const must = [
    ['inventory.stock_in', 'qty', -5],
    ['inventory.stock_in', 'qty', 0],
    ['inventory.stock_out', 'qty', -5],
    ['inventory.stock_out', 'qty', 0],
    ['inventory.transfer', 'qty', -1],
    ['inventory.ownership_transfer', 'qty', 0],
    ['purchase.create_payment', 'amount', -1]
  ]
  for (const [toolName, param, bad] of must) {
    const tool = TOOL_MAP.get(toolName)
    ok(`工具 ${toolName} 存在`, !!tool)
    if (!tool) continue
    const props = tool.inputSchema.properties || {}
    // 先把**必填项**都填成合法占位值，否则会因为"缺必填"而拒，测不到下界那一条
    const args = {}
    for (const k of tool.inputSchema.required || []) {
      const t = (props[k] || {}).type
      args[k] = t === 'integer' || t === 'number' ? 1 : t === 'boolean' ? true : t === 'array' ? [] : t === 'object' ? {} : 'x'
    }
    args[param] = bad
    const r = validateToolArgs(tool, args)
    ok(`${toolName}.${param} = ${bad} 被参数校验拒绝`, r.ok === false, r)
  }
}

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
srv.kill('SIGKILL')
setTimeout(() => process.exit(fail ? 1 : 0), 250)
