#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-inv-type-gate.mjs ｜ 测试：常驻断言：**「受可售性闸门约束」这张名单住在主数据里，并且真的被接线**（第 0 层 §3 ② / §4）
 * ============================================================================
 * 【职责】测试：常驻断言：**「受可售性闸门约束」这张名单住在主数据里，并且真的被接线**（第 0 层 §3 ② / §4）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 常驻断言：**「受可售性闸门约束」这张名单住在主数据里，并且真的被接线**（第 0 层 §3 ② / §4）
//
// 用法：
//   node scripts/test-inv-type-gate.mjs            # 自建临时库，不碰任何既有库
//   （本脚本**不需要** GML_DATA_DIR：它在 /tmp 自建一个干净库跑完即弃）
//
// 绑住的是一句话（客户原话）：「能不能卖由客户来决定」——
//   在此之前"哪种出库要把货当可售货消耗"是 `stock.js` 里的一个硬编码集合，
//   客户新建一种出库类型时**没有任何地方能声明**它要不要守可售性。现在它是一列
//   （`inv_txn_types.saleable_only`）。
//
// 为什么它必须是常驻断言（第 0 层 §4「登记了 ≠ 接线了」）：
//   只写"我在主数据里加了一列"不算完成。**唯一证明方式**是：
//   **把这条配置改成另一个值 ⇒ 系统行为必须真的跟着变。**
//   本脚本就是那条证明：把 `saleable_only` 改掉，闸门对同一批货的判定必须跟着翻。
//
// 三节各自守什么：
//   A 默认值 = 上线前的实际行为（§3 ②）：4 个拦 / 5 个放，与改列前的硬编码名单**逐条一致**
//   B 接线证明（§4）：改一个码的 `saleable_only` ⇒ 拦/放真的翻
//   C 客户新增的类型不许误红、且文案能回落到客户填的名字（§3 ⑦）
//
// 只读源码、只写本次 mkdtemp 创建的临时目录（每节重开一个干净库）。
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../server/db/migrations/runner.js'
import { applyStockIn, applyStockOut, clearParamCache, clearInvTypeCache } from '../server/lib/stock.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const OWN_DIR = fs.mkdtempSync('/tmp/os-egp-inv-type-gate-')
const TMP = path.join(OWN_DIR, 'direct.db')
let safeToRemove = true

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${msg}`)
  } else {
    fail += 1
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail ? `  → ${detail}` : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

/** 干净库 + 一个「已冻结」批次（冻结 = 不可售，闸门必拦）；`setup(db)` 在出库前改主数据 */
function fresh(setup) {
  for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)
  const db = new Database(TMP)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
  runMigrations(db)
  clearParamCache()
  clearInvTypeCache()
  db.prepare(`INSERT OR IGNORE INTO orgs (id,code,name,type,parent_id,level,path,is_legal,owner_org_id,currency,region,status)
    VALUES (1,'HQ','演示总部','group',NULL,1,'/1/',1,1,'CNY','华东','active')`).run()
  db.prepare(`INSERT INTO warehouses (id,code,name,type,currency,org_id,default_owner_org_id,region)
    VALUES (1,'WH01','总仓','central','CNY',1,1,'华东')`).run()
  db.prepare("INSERT INTO products (id,spu_code,name,unit) VALUES (1,'SPU001','探测品','盒')").run()
  db.prepare("INSERT INTO product_skus (id,product_id,sku_code,name) VALUES (1,1,'SKU001','探测 SKU')").run()
  applyStockIn(db, { bizDate: '2026-10-15', docType: 'PUR_IN', docNo: 'PO001', warehouseId: 1, skuId: 1, batchNo: 'FROZEN1', qty: 10, unitCost: 10 })
  db.prepare("UPDATE inventory_batches SET status='frozen' WHERE sku_id=1 AND batch_no='FROZEN1'").run()
  if (setup) setup(db)
  return db
}

/** 显式批次出库：返回 { blocked, code, msg }（msg 里带着"当前拦截集"的可读投影） */
function probe(docType, setup) {
  const db = fresh(setup)
  try {
    applyStockOut(db, { bizDate: '2026-10-15', docType, docNo: 'DOC001', warehouseId: 1, skuId: 1, batchNo: 'FROZEN1', qty: 1 })
    return { blocked: false }
  } catch (e) {
    return { blocked: true, code: e.code, msg: String(e.message || '') }
  } finally {
    db.close()
  }
}

const setFlag = (db, code, v) => {
  db.prepare('UPDATE inv_txn_types SET saleable_only=? WHERE code=?').run(v, code)
  clearInvTypeCache(db)
}
const setStatus = (db, code, s) => {
  db.prepare('UPDATE inv_txn_types SET status=? WHERE code=?').run(s, code)
  clearInvTypeCache(db)
}

// ── A. 默认值 = 上线前的实际行为 ─────────────────────────────────────────
try {
section('A. 默认值 = 改列之前的实际行为（§3 ②）')
// 改列之前 `stock.js` 里的硬编码名单，逐字
const LEGACY = ['SAL_OUT', 'SHP_OUT', 'MR', 'WWS_OUT']
for (const c of LEGACY) {
  const r = probe(c)
  ok(r.blocked && r.code === 'BATCH_NOT_SELLABLE', `${c}（旧名单成员）默认被闸门拦`, JSON.stringify(r))
}
for (const c of ['SCRAP_OUT', 'PUR_RET', 'TR_OUT', 'ADJ_OUT', 'QC_RET_OUT', 'ASM_OUT']) {
  const r = probe(c)
  ok(!r.blocked, `${c}（非旧名单成员）默认不被拦`, JSON.stringify(r))
}
{
  const db = fresh()
  const on = db.prepare('SELECT code FROM inv_txn_types WHERE saleable_only=1 ORDER BY code').all().map((r) => r.code)
  ok(
    JSON.stringify(on) === JSON.stringify([...LEGACY].sort()),
    '读库得到的闸门名单 == 旧硬编码名单（逐条一致，不是"数量一样"）',
    `读库 ${JSON.stringify(on)} / 旧名单 ${JSON.stringify([...LEGACY].sort())}`
  )
  const dirty = db.prepare('SELECT COUNT(*) c FROM inv_txn_types WHERE saleable_only IS NULL OR saleable_only NOT IN (0,1)').get().c
  ok(dirty === 0, 'saleable_only 无脏值（只允许 0/1）', `脏值 ${dirty}`)
  db.close()
}

// ── B. 接线证明：改配置 ⇒ 行为真的变 ─────────────────────────────────────
section('B. 接线证明：把配置改成另一个值 ⇒ 行为必须跟着变（§4）')
{
  const r = probe('SAL_OUT', (db) => setFlag(db, 'SAL_OUT', 0))
  ok(!r.blocked, '把 SAL_OUT 标成 saleable_only=0 ⇒ 同一批货不再被拦', JSON.stringify(r))
}
{
  const r = probe('SCRAP_OUT', (db) => setFlag(db, 'SCRAP_OUT', 1))
  ok(r.blocked && r.code === 'BATCH_NOT_SELLABLE', '把 SCRAP_OUT 标成 saleable_only=1 ⇒ 同一批货真的被拦', JSON.stringify(r))
}
{
  const r = probe('TR_OUT', (db) => setFlag(db, 'TR_OUT', 1))
  ok(r.blocked && r.code === 'BATCH_NOT_SELLABLE', '非默认成员 TR_OUT 标 1 也照样生效', JSON.stringify(r))
}

// ── C. 客户新增不许误红 + 文案回落到客户填的名字 ─────────────────────────
section('C. 客户新建的类型：文案能回落到字典名（§3 ⑦）、停用真的生效')
{
  const r = probe('REPAIR_OUT', (db) => {
    db.prepare(
      `INSERT INTO inv_txn_types (code,name,direction,biz_category,cost_effect,status,sort_order,saleable_only,ledger_subject_code)
       VALUES ('REPAIR_OUT','维修出库','out','other','normal','active',990,1,NULL)`
    ).run()
    clearInvTypeCache(db)
  })
  ok(r.blocked, '客户新建的 REPAIR_OUT 标成受约束 ⇒ 闸门对它生效（新类型立刻可被策略管住）', JSON.stringify(r))
  // `msg` 只在"被拦"时才有；被放行时是 undefined —— 断言要能**如实报红**，不能自己先崩
  // （崩掉的测试会把后面几条断言一起吞掉，读的人会以为是"只有这一条错"）。
  const msg = String(r.msg || '')
  ok(
    msg.includes('维修出库 REPAIR_OUT'),
    '报错文案里该类型显示为「中文名 码」（名字取自字典，回落生效，不是裸码）',
    msg || JSON.stringify(r)
  )
  ok(
    msg.includes('销售出库 SAL_OUT'),
    '报错文案里内置类型也是「中文名 码」（中文取自 DOC_TYPE_LABEL）',
    msg || JSON.stringify(r)
  )
}
{
  const r = probe('SCRAP_OUT', (db) => setStatus(db, 'SCRAP_OUT', 'inactive'))
  ok(r.blocked && r.code === 'INV_TYPE_INACTIVE', '停用的类型 ⇒ 新流水被硬拦（不是只改界面标签）', JSON.stringify(r))
}
{
  const r = probe('SCRAP_OUT', (db) => {
    setStatus(db, 'SCRAP_OUT', 'inactive')
    setStatus(db, 'SCRAP_OUT', 'active')
  })
  ok(!r.blocked, '停用后再启用 ⇒ 恢复（判据只看当前状态）', JSON.stringify(r))
}
{
  const db = fresh((d) => setStatus(d, 'PUR_IN', 'inactive'))
  let code = null
  try {
    applyStockIn(db, { bizDate: '2026-10-15', docType: 'PUR_IN', docNo: 'PO900', warehouseId: 1, skuId: 1, batchNo: 'X1', qty: 1, unitCost: 1 })
  } catch (e) {
    code = e.code
  } finally {
    db.close()
  }
  ok(code === 'INV_TYPE_INACTIVE', '停用在**入库**侧同样被拦（唯一写入口一处拦住）', `实际 ${code}`)
}

for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)

// ── D. 预留位不可写：**真 HTTP**（铁律 17「无意义的动作必须被明确拒绝 + 一句人话」）──────
// `ledger_subject_code` 写了不产生任何效果 ⇒ 接受它等于留一条**静默无反应的写路径**。
// 这一节起一个**真服务**（自己的 /tmp 库 + 自己的端口，**不碰 data/**）打真接口：
//   ① 带非空值的 POST / PUT ⇒ 400 + `INV_TYPE_LEDGER_RESERVED`，且**列仍为 NULL**；
//   ② 不带该键的 POST / PUT（界面字段只读后本来就不发它）⇒ 200 —— **合法路径不能被拦死**。
section('D. 预留位 `ledger_subject_code` 任何入口都不可写（`INV_TYPE_LEDGER_RESERVED`）')
{
  const API_DIR = path.join(OWN_DIR, 'api')
  // Linux diagnostic measured ~27.5s for an empty three-industry cold start.
  // Keep a bounded 90s cold-start budget, while detecting process failure immediately.
  const STARTUP_MS = Number(process.env.GML_TEST_STARTUP_MS || 90000)
  if (!Number.isSafeInteger(STARTUP_MS) || STARTUP_MS < 1000 || STARTUP_MS > 180000) {
    throw new Error('GML_TEST_STARTUP_MS must be an integer from 1000 to 180000')
  }
  const listener = net.createServer()
  listener.listen(0, '127.0.0.1')
  await once(listener, 'listening')
  const API_PORT = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  fs.mkdirSync(API_DIR, { recursive: true })
  // 显式把落点钉在 /tmp：**不设就是落 data/**（本项目纪律，见 `check-env-pinning.mjs`）
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, GML_RUNTIME_MODE: 'test', GML_DATA_DIR: API_DIR, GML_DB: '',
      HOST: '127.0.0.1', PORT: String(API_PORT), GML_JWT_SECRET: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  const base = `http://127.0.0.1:${API_PORT}`
  console.log(`[fixture] child pid=${child.pid}; data=${API_DIR}`)
  let output = ''
  const collect = data => { output = (output + data.toString()).slice(-16000) }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  let spawnError = null
  child.on('error', error => { spawnError = error })
  let closed = false
  const ended = new Promise(resolve => child.once('close', (code, signal) => {
    closed = true
    resolve({ code, signal })
  }))
  const diagnostics = () => output
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\bgml_[a-f0-9]{32,}\b/g, '[redacted token]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted JWT]')
    .split('\n').slice(-12).join('\n')
  const stopChild = async () => {
    const endedBeforeStop = closed || child.exitCode !== null || child.signalCode !== null
    const requestedSignals = new Set()
    if (!closed && child.kill('SIGTERM')) requestedSignals.add('SIGTERM')
    await Promise.race([ended, sleep(3000, undefined, { ref: false })])
    if (!closed) {
      if (child.kill('SIGKILL')) requestedSignals.add('SIGKILL')
      await Promise.race([ended, sleep(3000, undefined, { ref: false })])
    }
    if (!closed) {
      safeToRemove = false
      throw new Error(`Test child did not close; preserving owned data at ${OWN_DIR}`)
    }
    const result = await ended
    // AC9 起服务对 SIGTERM 做受控关闭（写指标快照后 exit 0）：收到我们请求的 SIGTERM 后 code=0 也是正常结束；
    // 仍然拒绝「我们没发信号就先死了」与「非零退出码」。
    const graceful = result.code === 0 && result.signal === null && requestedSignals.has('SIGTERM')
    if (endedBeforeStop || (!graceful && (result.code !== null || !requestedSignals.has(result.signal)))) {
      throw new Error(`Test server terminated before controlled shutdown or exited abnormally: code=${result.code}; signal=${result.signal}; requested=${[...requestedSignals].join(',') || 'none'}`)
    }
  }
  try {
  let up = false
  const startedAt = Date.now()
  const deadline = startedAt + STARTUP_MS
  while (!up && !closed && !spawnError && Date.now() < deadline) {
    try {
      // A responsive unrelated process is insufficient: our child must also report listening.
      if (output.includes('服务已启动')) {
        const r = await fetch(`${base}/api/meta/health`, { signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) })
        up = r.ok && !closed
      }
    } catch {
      /* 还没起来 */
    }
    if (!up && !closed && !spawnError) await sleep(Math.max(1, Math.min(100, deadline - Date.now())))
  }
  if (!up) throw new Error(`Readiness failed after ${Date.now() - startedAt}ms; exit=${child.exitCode}; signal=${child.signalCode}; spawn=${spawnError?.code || 'none'}\n${diagnostics()}`)
  ok(true, `D 前置：真服务已起（端口 ${API_PORT}，库 ${API_DIR}，${Date.now() - startedAt}ms）`)

  const j = async (path, init = {}) => {
    const r = await fetch(`${base}${path}`, {
      ...init,
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json', ...(init.headers || {}) }
    })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const login = await j('/api/auth/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: '12345', industry: 'cosmetic' }) })
  const token = login.body?.data?.token
  ok(!!token, 'D 前置：登录拿到令牌', JSON.stringify(login.body).slice(0, 160))
  const H = { Authorization: `Bearer ${token}` }
  const TYPES = '/api/master/inv-txn-types'

  const r1 = await j(TYPES, { method: 'POST', headers: H, body: JSON.stringify({ code: 'GATE_PROBE', name: '预留位探针', direction: 'out', ledger_subject_code: '1405' }) })
  ok(
    r1.status === 400 && r1.body?.error === 'INV_TYPE_LEDGER_RESERVED' && r1.body?.detail?.code === 'INV_TYPE_LEDGER_RESERVED',
    'POST 带非空 `ledger_subject_code` ⇒ 400 + `INV_TYPE_LEDGER_RESERVED`',
    JSON.stringify(r1).slice(0, 220)
  )

  const r2 = await j(TYPES, { method: 'POST', headers: H, body: JSON.stringify({ code: 'GATE_PROBE', name: '预留位探针', direction: 'out', saleable_only: 0 }) })
  ok(r2.status === 200 && r2.body?.success === true, 'POST **不带**该键（界面只读后就是这条路径）⇒ 200 —— 合法路径没被拦死', JSON.stringify(r2.body).slice(0, 200))

  const r3 = await j(`${TYPES}/GATE_PROBE`, { method: 'PUT', headers: H, body: JSON.stringify({ ledger_subject_code: '2202' }) })
  ok(
    r3.status === 400 && r3.body?.error === 'INV_TYPE_LEDGER_RESERVED',
    'PUT 带非空 `ledger_subject_code` ⇒ 400 + `INV_TYPE_LEDGER_RESERVED`',
    JSON.stringify(r3).slice(0, 220)
  )

  const r4 = await j(`${TYPES}/GATE_PROBE`, { method: 'PUT', headers: H, body: JSON.stringify({ name: '预留位探针（改名）', saleable_only: 1 }) })
  ok(r4.status === 200 && r4.body?.success === true, 'PUT **不带**该键 ⇒ 200（改名/闸门开关照常可用）', JSON.stringify(r4.body).slice(0, 200))

  const db = new Database(path.join(API_DIR, 'gml_cosmetic.db'), { readonly: true, fileMustExist: true })
  const row = db.prepare("SELECT name, saleable_only, ledger_subject_code FROM inv_txn_types WHERE code='GATE_PROBE'").get()
  db.close()
  ok(
    row && row.ledger_subject_code === null,
    '被拒两次之后：该列**仍为 NULL**（拒绝是"没写进去"，不是"写了又回滚"）',
    JSON.stringify(row)
  )
  ok(row && row.name === '预留位探针（改名）' && Number(row.saleable_only) === 1, '与此同时，合法字段（改名 + 闸门开关）**确实写进去了**', JSON.stringify(row))

  } catch (error) {
    ok(false, 'D HTTP 验证完成（启动/请求失败不得继续伪造业务结果）', error.message)
  } finally {
    await stopChild()
  }
}

console.log('\n' + '─'.repeat(60))
if (fail) console.log(`失败断言：${failures.join(' / ')}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
process.exitCode = fail ? 1 : 0
} finally {
  if (safeToRemove) fs.rmSync(OWN_DIR, { recursive: true, force: true })
}
