#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/a04-common-tx.mjs ｜ 独立验收：A04 共同事务 —— **注入式反例先红后证**
 * ============================================================================
 * 【职责】独立验收：A04 共同事务 —— **注入式反例先红后证**
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
 * A04 共同事务 —— **注入式反例先红后证**
 *
 * 被测的不变量（项目里写着、但只有注入才能证明它真的成立）：
 *   「MCP 的一次写调用里，**业务过账 + 结果缓存 + 确认消费**在同一个事务边界内 ——
 *     要么全部生效，要么全部回滚。」
 *
 * 为什么不能靠普通断言验：
 *   正常路径上这三件事都会成功，看不出它们是不是同一个事务。
 *   只有**让最后一件事失败**，才能区分"回滚了"和"前三件已经落地"。
 *   而"失败"必须在代码里注入 —— 没有别的办法让 `mcp_idempotency` 的 INSERT 挂掉。
 *
 * 三个相位（同一份代码，只差一个补丁）：
 *   A（红）拆掉事务 + 注入失败 ⇒ **业务写留在库里**（缺陷可见，证明下面的断言抓得到）
 *   B（绿）保留事务 + 注入失败 ⇒ 业务写一行都不留、幂等行也没有（回滚是自然结果）
 *   C（对照）保留事务、不注入   ⇒ 调用成功、库存确实 +qty、幂等行恰好 1 条
 *      —— C 用来回答"B 里什么都没发生，是不是因为这个工具本来就不写库？"
 *
 * 用法：node scripts/accept/a04-common-tx.mjs
 *   （无参数；端口用环境变量 A04_PORT。口径「丁」：**不认识的参数一律拒绝** —— 打用法 + 退 2。
 *     本脚本会 patch 工作区 `server/mcp/server.js`，所以闸门必须发生在任何写动作之前。）
 */
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// ---------------------------------------------------------------------------
// 参数（口径「丁」）：**不认识的参数一律拒绝** —— 打用法 + 非 0 退出，绝不静默忽略。
// 本脚本**不接受任何命令行参数**（换端口用环境变量 A04_PORT —— 那是环境不是参数，丁管不着它）。
// 为什么必须显式拒绝：有人给它传个 `--dry` 以为"只解析、不跑"，实际它会**真的往工作区
// `server/mcp/server.js` 打补丁、起一个真服务、建临时库、写证据 JSON**。静默忽略一个无意义的
// 动作，与本批缺陷 186（`qty:-5` 静默成功）同一族。
// ⚠️ 闸门必须放在**最前面**：本脚本靠 exit 钩子还原被补丁的源码，所以"拒绝"要发生在
//    任何写动作之前 —— 否则拒掉之前工作区已经被改过了（先改再拒 = 拒了个寂寞）。
//    **判据（可复算）**：跑 `--nonsense` ⇒ 退出码 2，且**被补丁的那份源文件 sha256 逐字节未变**、
//    `/tmp` 下本脚本的副本残留 0 份。实测（20:xx）：

// ---------------------------------------------------------------------------
const USAGE = [
  '用法: node scripts/accept/a04-common-tx.mjs',
  '  （无参数。端口用环境变量换：A04_PORT=42353 node scripts/accept/a04-common-tx.mjs）'
].join('\n')
// 顺序与家族里其余脚本一致：**非法参数优先于 `--help`**（`--help --nonsense` 也得退 2）。
// `--help` 是裸开关 ⇒ 只有整字相符才算（`--help=1` 一样被拒）。
const KNOWN_FLAGS = ['--help']
const badArgs = process.argv.slice(2).filter((a) => !KNOWN_FLAGS.includes(a))
if (badArgs.length) {
  console.error(`不认识的参数：${badArgs.join(' ')}`)
  console.error(USAGE)
  process.exit(2)
}
if (process.argv.includes('--help')) { console.log(USAGE); process.exit(0) }

const PORT = Number(process.env.A04_PORT || 42352)
const BASE = `http://127.0.0.1:${PORT}`
const TARGET = path.join(ROOT, 'server/mcp/server.js')
const ORIGINAL = readFileSync(TARGET, 'utf8')

// ---------- 补丁 ----------
const PATCH_TX_OFF = {
  from: '    const runInOneTx = db.transaction(() => {',
  to: '    const runInOneTx = ((fn) => () => fn())(() => {'
}
const PATCH_INJECT = {
  from: '      const out = tool.handler({ db, args: execArgs, ctx })\n      if (idemKey) {',
  to: `      const out = tool.handler({ db, args: execArgs, ctx })
      // 【A04 反例注入】让"结果缓存写入"这一步失败。业务过账此时**已经完成** ——
      // 于是有没有事务，就决定了那份业务写会不会留在库里。
      if (process.env.GML_A04_INJECT === '1') {
        const e = new Error('A04 注入：结果缓存写入失败')
        e.code = 'A04_INJECTED_CACHE_FAIL'
        throw e
      }
      if (idemKey) {`
}

function apply(patches) {
  let s = ORIGINAL
  for (const p of patches) {
    if (!s.includes(p.from)) throw new Error(`补丁锚点找不到：${p.from.slice(0, 60)}`)
    s = s.replace(p.from, p.to)
  }
  writeFileSync(TARGET, s)
}
const restore = () => writeFileSync(TARGET, ORIGINAL)
process.on('exit', restore)
process.on('SIGINT', () => { restore(); process.exit(3) })

// ---------- 环境 ----------
const TMP = mkdtempSync(path.join(tmpdir(), 'gml-a04-'))
const DATA = path.join(TMP, 'data')
mkdirSync(DATA, { recursive: true })
process.env.GML_DATA_DIR = DATA

const { bootIndustry } = await import(path.join(ROOT, 'server/db/boot.js'))
bootIndustry('cosmetic', { force: true, log: () => {} })
console.log(`A04 共同事务反例\n  数据目录 ${DATA}\n  端口 ${PORT}`)

const Database = (await import(path.join(ROOT, 'node_modules/better-sqlite3/lib/index.js'))).default
const open = () => new Database(path.join(DATA, 'gml_cosmetic.db'), { readonly: true })

let child = null
const cleanup = () => { try { if (child && !child.killed) child.kill('SIGKILL') } catch {} ; try { rmSync(TMP, { recursive: true, force: true }) } catch {} }
process.on('exit', cleanup)

async function startServer(inject) {
  child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
    cwd: ROOT,
    env: { ...process.env, GML_DATA_DIR: DATA, PORT: String(PORT), HOST: '127.0.0.1', GML_A04_INJECT: inject ? '1' : '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  child.stdout.on('data', () => {})
  child.stderr.on('data', () => {})
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, 500))
    try { if ((await fetch(`${BASE}/api/meta/health`)).ok) return true } catch {}
  }
  return false
}
const stopServer = () => new Promise((r) => { if (!child) return r(); child.once('exit', r); child.kill('SIGKILL') })

async function api(method, p, { token, body } = {}) {
  const h = { 'content-type': 'application/json', 'x-industry': 'cosmetic' }
  if (token) h.authorization = `Bearer ${token}`
  const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => null) }
}
async function mcp(token, name, args) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
  })
  const j = await r.json().catch(() => null)
  let payload = null
  try { payload = JSON.parse(j?.result?.content?.[0]?.text) } catch {}
  return { isError: !!j?.result?.isError, payload }
}

// ---------- 单个相位 ----------
async function phase(label, { txOff, inject, batch }) {
  apply([...(txOff ? [PATCH_TX_OFF] : []), ...(inject ? [PATCH_INJECT] : [])])
  if (!(await startServer(inject))) throw new Error(`${label}：服务没起来`)

  const admin = (await api('POST', '/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })).body?.data?.token
  const tok = (await api('POST', '/api/mcp/tokens', { token: admin, body: { name: `A04-${label}`, scopes: 'read,write' } })).body?.data?.token
  if (!tok) throw new Error(`${label}：没拿到 MCP 令牌`)

  const db0 = open()
  const wh = db0.prepare("SELECT * FROM warehouses WHERE status='active' ORDER BY id LIMIT 1").get()
  const sku = db0.prepare('SELECT * FROM product_skus ORDER BY id LIMIT 1').get()
  const before = db0.prepare('SELECT COUNT(*) c FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?').get(wh.id, sku.id, batch).c
  db0.close()

  const key = `a04-${label}-${Date.now()}`
  const QTY = 7
  const r = await mcp(tok, 'inventory.stock_in', { warehouse_id: wh.id, sku_id: sku.id, qty: QTY, unit_cost: 3.5, batch_no: batch, idempotency_key: key })
  await stopServer()

  const db1 = open()
  const after = db1.prepare('SELECT COUNT(*) c, COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?').get(wh.id, sku.id, batch)
  const idem = db1.prepare('SELECT COUNT(*) c FROM mcp_idempotency WHERE idempotency_key=?').get(key).c
  const txs = db1.prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_no LIKE 'MCP%' AND qty=?").get(QTY).c
  db1.close()
  restore()

  return { label, toolError: r.payload?.error || null, isError: r.isError, beforeRows: before, afterRows: after.c, afterQty: after.q, idemRows: idem, wh: wh.id, sku: sku.id }
}

// ---------- 跑三个相位 ----------
const results = []
const A = await phase('A-拆掉事务', { txOff: true, inject: true, batch: 'A04-A' })
results.push(A)
const B = await phase('B-保留事务', { txOff: false, inject: true, batch: 'A04-B' })
results.push(B)
const C = await phase('C-对照', { txOff: false, inject: false, batch: 'A04-C' })
results.push(C)

let pass = 0
let fail = 0
const ok = (name, cond, detail) => { cond ? pass++ : fail++; console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '  → ' + JSON.stringify(detail)}`) }

console.log('\n── 相位 A：拆掉事务 + 注入失败（**这是缺陷形态**）')
ok('工具确实报错（注入生效）', A.isError && A.toolError === 'A04_INJECTED_CACHE_FAIL', A)
ok('【红】业务写留在了库里 —— 说明下面那条断言抓得到这个缺陷', A.afterRows === 1 && A.afterQty === 7, A)
ok('【红】结果缓存没有落下（调用方以为没成功，重试会再执行一次）', A.idemRows === 0, A)

console.log('\n── 相位 B：保留事务 + 注入失败（**这是当前代码**）')
ok('工具确实报错（注入生效）', B.isError && B.toolError === 'A04_INJECTED_CACHE_FAIL', B)
ok('业务写一行都没留（回滚是事务的自然结果）', B.afterRows === 0 && B.afterQty === 0, B)
ok('结果缓存也没落下 —— 故障消除后可以干净重跑', B.idemRows === 0, B)

console.log('\n── 相位 C：不注入（对照 —— 排除"这个工具本来就不写库"）')
ok('调用成功', C.isError === false, C)
ok('库存确实 +7（工具真的在写库）', C.afterRows === 1 && C.afterQty === 7, C)
ok('结果缓存恰好 1 条', C.idemRows === 1, C)

console.log(`\n${'─'.repeat(72)}`)
console.log(`A04 共同事务 · 反例先红后证：通过 ${pass} / 失败 ${fail}`)

const evDir = path.join(ROOT, 'docs/evidence')
mkdirSync(evDir, { recursive: true })
writeFileSync(path.join(evDir, '独立验收_A04共同事务_反例先红后证.json'), JSON.stringify({
  kind: 'a04-common-transaction-reversal',
  at: new Date().toISOString(),
  target: 'server/mcp/server.js · runInOneTx',
  phases: { A_defect: A, B_fixed: B, C_control: C },
  summary: { passed: pass, failed: fail }
}, null, 2))

cleanup()
process.exit(fail ? 1 : 0)
