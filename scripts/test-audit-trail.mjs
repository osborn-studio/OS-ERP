/**
 * ============================================================================
 * 文件标识：scripts/test-audit-trail.mjs ｜ 测试：常驻守卫：留痕**必须落库**（`server/middleware/audit.js`）
 * ============================================================================
 * 【职责】测试：常驻守卫：留痕**必须落库**（`server/middleware/audit.js`）
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
 * 常驻守卫：留痕**必须落库**（`server/middleware/audit.js`）
 *
 * 这一条守的是一个真实缺陷（批次 U 之四 收尾时发现的）：
 *   `audit_logs.detail` 是 TEXT 列，而 `audit()` 原来把 `detail` **原样绑进 SQL**。
 *   项目里 35 处调用点写的是 `detail: { ... }`（对象），better-sqlite3 见到对象会把它当成
 *   **具名参数包** ⇒ 抛 `RangeError: Too few parameter values were provided`
 *   ⇒ 被 `audit()` 的 catch 吞掉 ⇒ **整条记录没有落库**（只在服务端日志留一行 `[audit]`）。
 *   后果是那些动作在审计上**根本不存在**，而调用点看起来完全正常 ——
 *   这类"静默丢失"只有"拿行数去数"才抓得住，所以这一条做成**行数断言**。
 *
 * 两层（缺一不可）：
 *   · **A 层（lib）**：`audit()` 的输入形状穷举 —— 对象 / 字符串 / 循环引用 / BigInt /
 *     缺省 / `target` 别名 / 显式 entity 优先 / 用户与 IP 落库；每一条都断"行存在"。
 *   · **B 层（HTTP）**：真实令牌打真实端口，走**真的传对象的那些路由**，
 *     再回库数行数（lib 层测不到"路由里那一行到底传了什么"）。
 *
 * 隔离：数据目录是 /tmp 下的**三库快照**（`backup()` 取一致快照），
 * `data/gml_*.db` 一个字节都不碰；HTTP 用临时端口（默认 42353），子进程跑完必杀。
 *
 * 用法：node scripts/test-audit-trail.mjs
 * 收尾打印「通过 N / 失败 M」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const INDUSTRIES = ['cosmetic', 'food', 'apparel']
const PORT = Number(process.env.AUDIT_TEST_PORT || 42353)
const BASE = `http://127.0.0.1:${PORT}`

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${JSON.stringify(detail).slice(0, 300)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

// ===========================================================================
// 0. 三库一致快照 → 临时目录（绝不动 data/）
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gml-audit-trail-'))
const available = []
for (const ind of INDUSTRIES) {
  const src = path.join(ROOT, 'data', `gml_${ind}.db`)
  if (!fs.existsSync(src)) continue
  const s = new Database(src, { readonly: true, fileMustExist: true })
  await s.backup(path.join(TMP, `gml_${ind}.db`))
  s.close()
  available.push(ind)
}
process.env.GML_DATA_DIR = TMP

const { getDbFor, runWithIndustry } = await import('../server/db/index.js')
const { audit } = await import('../server/middleware/audit.js')

console.log(`=== 留痕落库守卫（三库：${available.join(' / ')}） ===\n  临时快照目录 ${TMP}`)

const MARK = '__test_audit_trail__'
const reqStub = { user: { uid: 7, name: '守卫-test' }, ip: '203.0.113.9' }
const rowsOf = (db, action) => db.prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY id').all(action)

// ===========================================================================
// A 层：`audit()` 的输入形状（每一条都必须**留下行**）
// ===========================================================================
for (const ind of available) {
  const db = getDbFor(ind)
  section(`A 留痕形状穷举（${ind}）`)
  db.prepare('DELETE FROM audit_logs WHERE action LIKE ?').run(`${MARK}%`)

  // 循环引用：`JSON.stringify` 会抛（TypeError: Converting circular structure to JSON）
  const circular = { a: 1 }
  circular.self = circular

  const cases = [
    { name: '对象 detail', action: `${MARK}.obj`, payload: { module: 'test', entity: 'subject', entityId: 12, detail: { code: '1001', qty: 2 } }, expect: { detail: '{"code":"1001","qty":2}', entity: 'subject', entity_id: '12' } },
    { name: '字符串 detail（原样，不再包一层引号）', action: `${MARK}.str`, payload: { detail: '{"pre":"stringified"}' }, expect: { detail: '{"pre":"stringified"}' } },
    { name: '循环引用 detail（明细退化，但**行必须在**）', action: `${MARK}.circular`, payload: { detail: circular }, expect: { detail: '{"__unserializable__":true}' } },
    { name: 'BigInt detail（同样序列化不了）', action: `${MARK}.bigint`, payload: { detail: { n: 1n } }, expect: { detail: '{"__unserializable__":true}' } },
    { name: '没有 detail', action: `${MARK}.none`, payload: {}, expect: { detail: null } },
    { name: 'target 别名 period:2026-10', action: `${MARK}.target1`, payload: { target: 'period:2026-10', detail: { x: 1 } }, expect: { entity: 'period', entity_id: '2026-10' } },
    { name: 'target 无冒号（整体当 entity）', action: `${MARK}.target2`, payload: { target: 'voucher' }, expect: { entity: 'voucher', entity_id: null } },
    { name: '显式 entity 优先于 target', action: `${MARK}.target3`, payload: { entity: 'voucher', entityId: '99', target: 'period:2026-10' }, expect: { entity: 'voucher', entity_id: '99' } }
  ]

  let thrown = null
  for (const c of cases) {
    try {
      runWithIndustry(ind, () => audit(reqStub, { action: c.action, ...c.payload }))
    } catch (e) {
      thrown = `${c.name}: ${e.message}`
    }
    const rows = rowsOf(db, c.action)
    ok(rows.length === 1, `${c.name} → **真的落库了**（行数 ${rows.length}，应为 1）`, rows.length)
    if (rows[0]) {
      for (const [k, v] of Object.entries(c.expect)) {
        eq(`${c.name} 的 ${k}`, rows[0][k], v)
      }
    }
  }
  eq('audit() 从头到尾没有抛异常（留痕失败不许打断业务）', thrown, null)
  const landed = db.prepare('SELECT COUNT(*) c FROM audit_logs WHERE action LIKE ?').get(`${MARK}%`).c
  eq(`八种形状一条都没丢（落库 ${landed} 条 / 应 8 条）`, landed, 8)
  // ⚠️ 每一处取值都要**先判存在**：这一条守卫的职责恰恰是"在被改坏时给出红断言"，
  //    而被改坏时行就是不在的 —— 直接 `[0].user_id` 会在红断言之后抛异常，
  //    整个套件崩掉 ⇒ 收尾的「通过 N / 失败 M」都打不出来
  //    （回归统计器会把这种崩溃记成"没有计数行"，比一条红断言更糟）。
  const meta = rowsOf(db, `${MARK}.obj`)[0]
  ok(Boolean(meta), '对象 detail 的那一行存在（用户与 IP 要挂在它上面核对）', meta)
  if (meta) eq('用户与 IP 也落库了', [meta.user_id, meta.user_name, meta.ip], [7, '守卫-test', '203.0.113.9'])

  // 收尾：临时库上把这些标记行删掉（不是必须，但让"跑两遍结果一样"成立）
  db.prepare('DELETE FROM audit_logs WHERE action LIKE ?').run(`${MARK}%`)
}

// ===========================================================================
// B 层：真实 HTTP —— 走**真的传对象的那些路由**，再回库数行数
// ===========================================================================
section('B 端到端：那些"传对象 detail"的路由，留痕真的落库了吗')

let child = null
const cleanup = () => {
  try { if (child && !child.killed) child.kill('SIGKILL') } catch { /* ignore */ }
}
process.on('exit', cleanup)

child = spawn(process.execPath, [path.join(ROOT, 'server/index.js')], {
  cwd: ROOT,
  env: { ...process.env, GML_DATA_DIR: TMP, PORT: String(PORT), HOST: '127.0.0.1' },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
child.stdout.on('data', (d) => { log += d })
child.stderr.on('data', (d) => { log += d })
let up = false
for (let i = 0; i < 120; i += 1) {
  await new Promise((r) => setTimeout(r, 500))
  try {
    const r = await fetch(`${BASE}/api/meta/health`)
    if (r.ok) { up = true; break }
  } catch { /* 还没起来 */ }
}
if (!up) {
  ok(false, '临时服务起来了', log.split('\n').slice(-12).join(' | '))
} else {
  async function req(method, p, { token, body } = {}) {
    const h = { 'content-type': 'application/json', 'x-industry': 'cosmetic' }
    if (token) h.authorization = `Bearer ${token}`
    const r = await fetch(BASE + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) })
    let b = null
    try { b = await r.json() } catch { /* 非 JSON */ }
    return { status: r.status, data: b?.data, code: b?.detail?.code || b?.error || null }
  }
  const login = await req('POST', '/api/auth/login', { body: { username: 'admin', password: '12345', industry: 'cosmetic' } })
  const token = login.data?.token
  ok(Boolean(token), '管理员登录拿到令牌')

  const db = new Database(path.join(TMP, 'gml_cosmetic.db'), { readonly: true })
  const before = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  const maxIdBefore = Number(db.prepare('SELECT COALESCE(MAX(id),0) m FROM audit_logs').get().m)
  const since = (action) => db.prepare('SELECT * FROM audit_logs WHERE action=? AND id > ? ORDER BY id DESC LIMIT 1').get(action, maxIdBefore)

  // 六处**真的传对象 detail** 的调用点（含 4 处 `target` 早年写法）
  const CASES = [
    { name: 'POST /accounting/subjects（finance.subject.save，accounting.js:56，target 写法）', action: 'finance.subject.save', run: () => req('POST', '/api/accounting/subjects', { token, body: { code: '889901', name: '守卫测试科目', category: 'asset' } }), expectEntity: 'subject' },
    { name: 'POST /accounting/subjects/:id/status（finance.subject.status，accounting.js:72，target 写法）', action: 'finance.subject.status', run: async () => { const rows = await req('GET', '/api/accounting/subjects?keyword=889901', { token }); const id = (rows.data?.rows || [])[0]?.id; return req('POST', `/api/accounting/subjects/${id}/status`, { token, body: { status: 'inactive' } }) }, expectEntity: 'subject' },
    { name: 'PUT /reports/opening（finance.opening.save，report.js:292，target 写法）', action: 'finance.opening.save', run: () => req('PUT', '/api/reports/opening', { token, body: { period: '2099-01', rows: [{ subject_code: '1001', debit_amount: 1, credit_amount: 0 }, { subject_code: '4001', debit_amount: 0, credit_amount: 1 }], remark: '守卫测试' } }), expectEntity: 'opening' },
    { name: 'POST /reports/periods/:period/close（finance.period.close，report.js:167，target 写法）', action: 'finance.period.close', run: () => req('POST', '/api/reports/periods/2099-01/close', { token, body: {} }), expectEntity: 'period' },
    { name: 'POST /reports/vouchers/:id/tag-cashflow（finance.cashflow.tag，字符串 detail 的对照组）', action: 'finance.cashflow.tag', run: async () => { const v = draftVoucher(); return req('POST', `/api/reports/vouchers/${v}/tag-cashflow`, { token, body: { entries: [{ line_no: 1, cash_flow_item: 'CFI_SALES_GOODS' }] } }) }, expectEntity: 'voucher' },
    { name: 'POST /accounting/vouchers/:id/post（finance.voucher.post，accounting.js:121，target 写法）', action: 'finance.voucher.post', run: async () => { const v = draftVoucher(); return req('POST', `/api/accounting/vouchers/${v}/post`, { token, body: {} }) }, expectEntity: 'voucher', allowFail: true }
  ]
  const dbw = new Database(path.join(TMP, 'gml_cosmetic.db'), { readonly: true })
  function draftVoucher() {
    return dbw.prepare("SELECT id FROM vouchers WHERE status='draft' ORDER BY id LIMIT 1").get()?.id || dbw.prepare('SELECT id FROM vouchers ORDER BY id DESC LIMIT 1').get()?.id
  }

  for (const c of CASES) {
    const r = await c.run()
    const line = since(c.action)
    const handled = r.status < 400 || c.allowFail
    if (handled && r.status < 400) {
      // 断言名里带**行数**：这一条的全部价值就是"数行数"，
      // 报出来的名字必须能让读的人一眼看到"0 行"（而不是自己去猜）
      ok(Boolean(line), `${c.name} → 留痕落库（HTTP ${r.status}，该 action 新增行数 ${line ? 1 : 0}）`, { http: r.status, action: c.action })
      if (line) {
        eq(`${c.name} 的 entity（来自 target 单点兼容）`, line.entity, c.expectEntity)
        ok(line.entity_id != null && String(line.entity_id).length > 0, `${c.name} 的 entity_id 不为空（旧写法曾经是空）`, line.entity_id)
        ok(line.detail != null, `${c.name} 的 detail 落库了（对象已被序列化成字符串）`, line.detail)
        ok(typeof line.detail === 'string' && line.detail.length > 0, `${c.name} 的 detail 是字符串`)
      }
    } else {
      // 业务前置不满足（例如没有草稿凭证）不是留痕的错：如实说明**没验到**，而不是假装通过
      ok(false, `${c.name} 没走到留痕那一步（HTTP ${r.status} ${r.code || ''}）—— 本条未验到`, { http: r.status, code: r.code })
    }
  }

  const after = db.prepare('SELECT COUNT(*) c FROM audit_logs').get().c
  ok(after > before, `这批请求整体让 audit_logs 涨了行（${before} → ${after}）`)
  // 只对**本次跑出来的行**提这条要求：库里的存量行里有大量**故意的人话** detail
  // （字符串调用点写的是"合计 100"这类），它们本来就不是 JSON，不该被判为坏。
  // 真正的口径是：**传对象的调用点，落库的 detail 必须是序列化后的 JSON**。
  const mine = db.prepare('SELECT action, detail FROM audit_logs WHERE id > ?').all(maxIdBefore)
  const objDetailRows = mine.filter((r) => r.detail != null && r.detail.startsWith('{'))
  const badJson = objDetailRows.filter((r) => !db.prepare('SELECT json_valid(?) v').get(r.detail).v)
  eq('本次新增的"对象 detail"行全部是合法 JSON（对象确实被序列化了）', badJson.length, 0)
  ok(objDetailRows.length >= 4, `至少验到 4 条对象 detail 的行（实际 ${objDetailRows.length} 条）`, objDetailRows.map((r) => r.action))
  db.close()
  dbw.close()
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`留痕落库守卫（三库）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
cleanup()
try { fs.rmSync(TMP, { recursive: true, force: true }) } catch { /* ignore */ }
process.exit(fail === 0 ? 0 : 1)
