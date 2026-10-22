/**
 * ============================================================================
 * 文件标识：scripts/test-purchase-return-accounting.mjs ｜ 测试：采购退货的**会计落点**（PRT → 凭证 + 应付台账披露）
 * ============================================================================
 * 【职责】测试：采购退货的**会计落点**（PRT → 凭证 + 应付台账披露）
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
 * 采购退货的**会计落点**（PRT → 凭证 + 应付台账披露）
 *
 * 修的是什么：采购侧原来只有 `purchase_inbound` 一条凭证路径（到货即 借 库存商品 / 贷 应付暂估），
 * 也就是**只挂不减** —— 货退回供应商之后，暂估应付与存货**双双虚高**，
 * 而**没有任何一处会报错**（凭证生成根本不知道"退货"这件事存在）。
 * 台账侧同理：`/api/purchase/payables` 只汇总结算单，而结算明细的来源类型只有
 * `receipt / invoice / fee` —— 退货不参与，于是台账上的"未付"也是虚高值。
 *
 * 本脚本按**判据**验，六条：
 *   ① **模板方向**（最重要的一条）：`voucher_templates` 里 `purchase_return` 必须恰好两条分录，
 *      且**借 2202 应付账款 / 贷 1405 库存商品**，与 `purchase_inbound` **逐位相反**。
 *      ⚠️ 为什么必须钉到科目与方向、而不是只断言"借贷平"：**方向反了的模板照样是平的**
 *      （借1405/贷2202 也平衡），但它记出来的是"又挂了一笔应付"——**账更难看了**。
 *      "平"只证明分录自洽，不证明记对了。反例 A 就是专门打这一格的。
 *   ② **真生成**：对一张 `confirmed` 的退货单打真实 HTTP 生成凭证 ⇒ 借贷相等且**等于退货金额**；
 *      逐条查分录的科目码与方向；反查接口能按来源查到同一张。
 *   ③ **幂等**：同一来源再生成一次 ⇒ 返回**同一张**凭证，`vouchers` 行数不变。
 *   ④ **负例**：`draft` 的退货单 ⇒ 409 `SOURCE_STATUS_INVALID`（**draft 是"打算退"，
 *      此时库存与成本侧一行都没写过**）；不存在的 id ⇒ 404；两次都**不落任何凭证**。
 *   ⑤ **应付台账披露**：`/api/purchase/payables` 的 `returns.total_amount` 必须等于库里
 *      `confirmed`/`completed` 退货合计；**`draft` 的不许出现**；且这块**不参与**
 *      settle/paid/open 口径（调接口前后 `purchase_settlements` 一字未变）。
 *   ⑥ **零副作用**：夹具自建自清（含 `doc_events` / `vouchers` / `voucher_entries` /
 *      `audit_logs`），并把 `doc_no_counters` 快照还原 —— 所以本脚本可反复跑、不推高任何单号。
 *
 * 夹具说明（如实写清，免得被当成"走过建单流程"）：本脚本的退货单是**直接 INSERT** 的
 * "一张已确认的退货单"，**不走** `createPurchaseReturn`。理由是这里验的是**会计层**，
 * 建单/出库那条路的副作用会污染"零副作用"那组断言；建单与确认的路径由
 * `test-gates-purchase.mjs`（门）与 `test-purchase.mjs`（采购链）覆盖。
 *
 * 用法：node scripts/test-purchase-return-accounting.mjs [cosmetic|food|apparel]
 *   隔离：必须设 `GML_DATA_DIR=/tmp/...`（不设时**自落**到 /tmp/gml-test-purchase-return-accounting
 *   并从仓库 data/ **只读**备份三库）；指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑。
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
  console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${ISOLATED_DIR}）。本脚本会建单/生成凭证，只允许在 /tmp 下的副本上跑。`)
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
// 会安静地跑另一个库，拿到的"绿"是假的。
if (process.argv[2] && !Object.hasOwn(INDUSTRIES, process.argv[2])) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}

const PORT = Number(process.env.TEST_PORT || 43931)
const BASE = `http://127.0.0.1:${PORT}`
const MARK = 'PRACC'
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

// ---------------------------------------------------------------- 夹具编号（自增量，避免与库里既有单号撞）
function nextFixtureNo() {
  const used = new Set(all(`SELECT doc_no FROM purchase_returns WHERE doc_no LIKE '${MARK}%'`).map((r) => r.doc_no))
  for (let i = 1; i < 500; i++) {
    const no = `${MARK}${String(i).padStart(3, '0')}`
    if (!used.has(no)) return no
  }
  throw new Error('夹具编号用完')
}

// ---------------------------------------------------------------- 零副作用：doc_no_counters 快照/还原
// 凭证生成会走 `nextDocNo(db,'PZ',…)` ⇒ **会推高 PZ 的计数**。夹具本身用固定 doc_no 建（不推高），
// 但 PZ 那一下必须还原，否则本脚本每跑一次就把单号往前推 —— "可重跑、零副作用"是本项目的硬要求。
const counterCols = all('PRAGMA table_info(doc_no_counters)').map((r) => r.name)
// ⚠️ 快照与还原后的比对**必须同一排序**：第一版 snapshot 没排序、还原后按 `ORDER BY 1`，
// 于是"顺序不同"被判成"没还原" —— 又是一次"我读到的数不是我以为那条命令产的"。
const snapshotCounters = () => safeJson(all('SELECT * FROM doc_no_counters ORDER BY 1'))
const counterSnapshot = snapshotCounters()
const counterRows = all('SELECT * FROM doc_no_counters')
function restoreCounters() {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM doc_no_counters').run()
    const ins = db.prepare(
      `INSERT INTO doc_no_counters (${counterCols.join(',')}) VALUES (${counterCols.map(() => '?').join(',')})`
    )
    for (const row of counterRows) ins.run(...counterCols.map((c) => row[c]))
  })
  tx()
}

// ---------------------------------------------------------------- 夹具自清
function fixtureReturnIds() {
  return all(`SELECT id FROM purchase_returns WHERE doc_no LIKE '${MARK}%'`).map((r) => r.id)
}
/** §7 的抵减夹具会额外造收货单与结算单 —— 它们也必须能清干净（按"明细里引用了我的夹具单号"定位） */
function fixtureSettleIds() {
  return all(`SELECT DISTINCT settle_id id FROM purchase_settlement_items WHERE source_doc_no LIKE '${MARK}%'`).map(
    (r) => r.id
  )
}
function purgeFixtures() {
  const ids = fixtureReturnIds()
  const settleIds = fixtureSettleIds()
  const rcIds = all(`SELECT id FROM purchase_receipts WHERE doc_no LIKE '${MARK}%'`).map((r) => r.id)
  if (!ids.length && !settleIds.length && !rcIds.length) {
    return { purged: 0, orphan_events: 0, orphan_vouchers: 0, settle: 0, receipts: 0 }
  }
  const ph = ids.length ? ids.map(() => '?').join(',') : null
  const sph = settleIds.length ? settleIds.map(() => '?').join(',') : null
  const rph = rcIds.length ? rcIds.map(() => '?').join(',') : null
  const tx = db.transaction(() => {
    // 结算单先删（它引用我的夹具单号；不先删会留下"指向已删收货单的明细"）
    if (settleIds.length) {
      db.prepare(`DELETE FROM purchase_settlement_items WHERE settle_id IN (${sph})`).run(...settleIds)
      db.prepare(`DELETE FROM purchase_settlements WHERE id IN (${sph})`).run(...settleIds)
    }
    // 凭证（分录挂在凭证头上）
    if (ids.length) {
      const vIds = all(
        `SELECT id FROM vouchers WHERE source_type='purchase_returns' AND source_id IN (${ph})`,
        ...ids
      ).map((r) => r.id)
      if (vIds.length) {
        const vph = vIds.map(() => '?').join(',')
        db.prepare(`DELETE FROM voucher_entries WHERE voucher_id IN (${vph})`).run(...vIds)
        db.prepare(`DELETE FROM vouchers WHERE id IN (${vph})`).run(...vIds)
      }
      // 留痕先删 —— 只删单据不删 doc_events 会立刻造"指向不存在单据的孤儿留痕"
      db.prepare(`DELETE FROM doc_events WHERE doc_type='PRT' AND doc_id IN (${ph})`).run(...ids)
      db.prepare(`DELETE FROM audit_logs WHERE entity='purchase_returns' AND entity_id IN (${ph})`).run(...ids)
      db.prepare(`DELETE FROM purchase_return_items WHERE return_id IN (${ph})`).run(...ids)
      db.prepare(`DELETE FROM purchase_returns WHERE id IN (${ph})`).run(...ids)
    }
    if (rcIds.length) {
      db.prepare(`DELETE FROM doc_events WHERE doc_type='GR' AND doc_id IN (${rph})`).run(...rcIds)
      db.prepare(`DELETE FROM purchase_receipt_items WHERE receipt_id IN (${rph})`).run(...rcIds)
      db.prepare(`DELETE FROM purchase_receipts WHERE id IN (${rph})`).run(...rcIds)
    }
    // 专用供应商最后删（上面那些行都指着它）
    db.prepare(`DELETE FROM suppliers WHERE code LIKE '${MARK}%'`).run()
  })
  tx()
  const orphanEvents = ids.length
    ? one(`SELECT COUNT(*) c FROM doc_events WHERE doc_type='PRT' AND doc_id IN (${ph})`, ...ids).c
    : 0
  const orphanVouchers = ids.length
    ? one(`SELECT COUNT(*) c FROM vouchers WHERE source_type='purchase_returns' AND source_id IN (${ph})`, ...ids).c
    : 0
  return {
    purged: ids.length,
    orphan_events: orphanEvents,
    orphan_vouchers: orphanVouchers,
    settle: settleIds.length,
    receipts: rcIds.length
  }
}

// 跑前先清一次（上一轮若中途崩了会留残）
const pre = purgeFixtures()
if (pre.purged) console.log(`[夹具] 跑前清掉上一轮残留 ${pre.purged} 张`)
// ⚠️ 开关也要复位：§7 会把 `purchase_return_offset` 改成"是"再改回来，**但崩溃就来不及改回**。
// 第一版没这一步 ⇒ 一次注入反例崩溃后，库里把开关留在了"是"上，
// 下一轮跑的第一条断言（"库里当前读出来是 false"）直接红 —— 那是**上一轮崩溃的假红**，
// 与代码无关。可重跑的脚本必须自己保证"起点状态"，不能指望上一轮礼貌退出。
{
  const S0 = await import('../server/lib/settings.js')
  if (S0.readSetting(db, 'purchase_return_offset') !== false) {
    S0.resetSetting(db, {
      key: 'purchase_return_offset',
      reason: '测试前置：清理上一轮崩溃时留在"是"上的抵减开关',
      actor: null,
      source: 'test'
    })
    console.log('[前置] purchase_return_offset 被上一轮留在"是"上，已复位默认')
  }
}

// ============================================================================
section(`采购退货会计落点（${INDUSTRY}）`)
// ============================================================================

// ---------------------------------------------------------------- §1 模板：方向必须对
section('§1 凭证模板 —— 判据钉到"科目 + 方向"，不是"借贷平"')

const tpl = one(`SELECT * FROM voucher_templates WHERE biz_type='purchase_return'`)
ok('① 模板存在（biz_type=purchase_return）', !!tpl, safeJson(tpl))
ok('① 模板是启用的、且挂在 PRT 上', tpl?.status === 'active' && tpl?.doc_type === 'PRT', `status=${tpl?.status} doc_type=${tpl?.doc_type}`)

const entries = tpl ? all('SELECT * FROM voucher_template_entries WHERE template_id=? ORDER BY seq', tpl.id) : []
ok('① 分录恰好两条', entries.length === 2, `实得 ${entries.length} 条：${safeJson(entries.map((e) => [e.seq, e.direction, e.subject_code]))}`)

const debit = entries.find((e) => e.direction === 'debit')
const credit = entries.find((e) => e.direction === 'credit')
// 借贷方向各一条 —— 少了任一边，生成出来的凭证必定不平（`seedFinance` 也会抛），
// 但这里自己判一次：判据不能只依赖"别人会拦"。
ok('① 借贷各一条', !!debit && !!credit, `debit=${debit?.subject_code} credit=${credit?.subject_code}`)

// ⭐ 本条是整个脚本的核心：**借 2202 应付账款 / 贷 1405 库存商品**
ok(
  '① 借方 = 2202 应付账款（冲回应付，不是又挂一笔）',
  debit?.subject_code === '2202',
  `实得借方科目 ${debit?.subject_code}`
)
ok(
  '① 贷方 = 1405 库存商品（冲回存货）',
  credit?.subject_code === '1405',
  `实得贷方科目 ${credit?.subject_code}`
)

// 与入库模板严格镜像（逐位相反）—— 用**实算**取出入库模板的方向，不写死期望值
const inEntries = all(
  `SELECT e.* FROM voucher_template_entries e
     WHERE e.template_id=(SELECT id FROM voucher_templates WHERE biz_type='purchase_inbound') ORDER BY e.seq`
)
const inDebit = inEntries.find((e) => e.direction === 'debit')
const inCredit = inEntries.find((e) => e.direction === 'credit')
ok(
  '① 与采购入库模板严格镜像（入库 借/贷 ⇄ 退货 贷/借）',
  inDebit?.subject_code === credit?.subject_code && inCredit?.subject_code === debit?.subject_code,
  `入库=(借${inDebit?.subject_code},贷${inCredit?.subject_code}) 退货=(借${debit?.subject_code},贷${credit?.subject_code})`
)

// 取数键必须是合法键（模板是**可被界面编辑的配置**，写错键会让生成整体失败）
const { FACT_KEYS } = await import('../server/lib/accounting.js')
const badKeys = entries.filter((e) => !Object.hasOwn(FACT_KEYS, e.amount_key || ''))
ok('① 两条分录的取数键都在 FACT_KEYS 里', badKeys.length === 0, safeJson(badKeys.map((e) => e.amount_key)))
ok(
  '① 两侧同用一个取数键（金额口径只有一处）',
  debit?.amount_key === 'total_amount' && credit?.amount_key === 'total_amount',
  `借=${debit?.amount_key} 贷=${credit?.amount_key}`
)

// ---------------------------------------------------------------- 凭证类型注册表
const { BIZ_TYPES } = await import('../server/lib/accounting.js')
ok(
  '① BIZ_TYPES 里注册了 purchase_return（来源 purchase_returns）',
  BIZ_TYPES.purchase_return?.source_type === 'purchase_returns' && BIZ_TYPES.purchase_return?.doc_type === 'PRT',
  safeJson({ s: BIZ_TYPES.purchase_return?.source_type, d: BIZ_TYPES.purchase_return?.doc_type })
)
ok(
  '① 只收 confirmed / completed（draft 是"打算退"，不是"退过了"）',
  JSON.stringify(BIZ_TYPES.purchase_return?.okStatuses) === JSON.stringify(['confirmed', 'completed']),
  safeJson(BIZ_TYPES.purchase_return?.okStatuses)
)

// ---------------------------------------------------------------- §2 夹具
const token = await login('admin', '12345')
if (!token) await gateFail('✗ 登录失败（admin/12345），无法继续')

const sup = one('SELECT id, name FROM suppliers ORDER BY id LIMIT 1')
const wh = one('SELECT id FROM warehouses ORDER BY id LIMIT 1')
if (!sup || !wh) await gateFail('✗ 库里没有供应商或仓库，造不出夹具')

const AMT = 1234.56
function makeReturn(status, amount, supplierId = sup.id) {
  const no = nextFixtureNo()
  const rid = db
    .prepare(
      `INSERT INTO purchase_returns (doc_no,supplier_id,warehouse_id,return_date,reason,status,total_qty,total_amount,created_by,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
    )
    .run(no, supplierId, wh.id, TODAY, `${MARK} 会计落点夹具`, status, 10, amount, 'test').lastInsertRowid
  return { id: Number(rid), doc_no: no }
}
const fxConfirmed = makeReturn('confirmed', AMT)
const fxDraft = makeReturn('draft', 99.99)
const voucherCountBefore = one('SELECT COUNT(*) c FROM vouchers').c

// ---------------------------------------------------------------- §2 真生成
section('§2 生成凭证（真实 HTTP）')
const gen = await api('POST', '/api/accounting/vouchers/generate', {
  token,
  body: { biz_type: 'purchase_return', source_id: fxConfirmed.id }
})
ok('② 生成返回 200', gen.status === 200, `http=${gen.status} ${safeJson(gen.body).slice(0, 200)}`)

const v = one(
  `SELECT * FROM vouchers WHERE biz_type='purchase_return' AND source_type='purchase_returns' AND source_id=?`,
  fxConfirmed.id
)
ok('② 凭证真的落库了', !!v, safeJson(v))
ok('② 借贷合计相等', !!v && Math.abs(Number(v.total_debit) - Number(v.total_credit)) < 0.005, `借=${v?.total_debit} 贷=${v?.total_credit}`)
ok('② 借贷合计 = 退货金额', !!v && Math.abs(Number(v.total_debit) - AMT) < 0.005, `实得 ${v?.total_debit}，期望 ${AMT}`)
ok('② 来源单号回填正确', v?.source_doc_no === fxConfirmed.doc_no, `实得 ${v?.source_doc_no}`)

const vLines = v ? all('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY seq', v.id) : []
ok('② 分录两条', vLines.length === 2, `实得 ${vLines.length}`)
const vDebit = vLines.find((l) => l.direction === 'debit')
const vCredit = vLines.find((l) => l.direction === 'credit')
// ⭐ 落库的分录也要逐条查科目与方向 —— 模板对不代表生成器抄对了
ok('② 落库分录 借 2202', vDebit?.subject_code === '2202', `实得 ${vDebit?.subject_code}`)
ok('② 落库分录 贷 1405', vCredit?.subject_code === '1405', `实得 ${vCredit?.subject_code}`)
ok(
  '② 落库分录带供应商辅助核算',
  !!vDebit?.aux_name && !!vCredit?.aux_name,
  `借aux=${vDebit?.aux_name} 贷aux=${vCredit?.aux_name}`
)

const bySource = await api('GET', `/api/accounting/vouchers/by-source/purchase_returns/${fxConfirmed.id}`, { token })
// ⚠️ 分页接口的载荷是 `data.rows`（不是 `data` 也不是 `data.list`）——
// 第一版按 `data` / `data.list` 取，拿到空数组 ⇒ 断言红。**红的是我的读法，不是接口。**
const found = bySource.body?.data?.rows || []
ok(
  '② 反查接口能按来源查到这张凭证',
  bySource.status === 200 && found.some((x) => x.doc_no === v?.doc_no),
  `http=${bySource.status} rows=${safeJson(found.map((x) => x.doc_no))}`
)

// ---------------------------------------------------------------- §3 幂等
section('§3 幂等：同一来源只生成一张')
const gen2 = await api('POST', '/api/accounting/vouchers/generate', {
  token,
  body: { biz_type: 'purchase_return', source_id: fxConfirmed.id }
})
const vAfter = all(`SELECT id FROM vouchers WHERE biz_type='purchase_return' AND source_id=?`, fxConfirmed.id)
ok('③ 重放返回 200', gen2.status === 200, `http=${gen2.status}`)
ok('③ 仍是同一张凭证（没有第二张）', vAfter.length === 1 && Number(vAfter[0].id) === Number(v?.id), safeJson(vAfter))
ok(
  '③ 全库凭证数只多了 1 张',
  one('SELECT COUNT(*) c FROM vouchers').c === voucherCountBefore + 1,
  `前=${voucherCountBefore} 后=${one('SELECT COUNT(*) c FROM vouchers').c}`
)

// ---------------------------------------------------------------- §4 负例
section('§4 负例：draft 不许入账 / 不存在要 404')
const beforeNeg = one('SELECT COUNT(*) c FROM vouchers').c
const genDraft = await api('POST', '/api/accounting/vouchers/generate', {
  token,
  body: { biz_type: 'purchase_return', source_id: fxDraft.id }
})
ok(
  '④ draft 的退货单被拒（409 SOURCE_STATUS_INVALID）',
  genDraft.status === 409 && (genDraft.body?.detail?.code || genDraft.body?.code) === 'SOURCE_STATUS_INVALID',
  `http=${genDraft.status} code=${genDraft.body?.detail?.code || genDraft.body?.code}`
)
ok(
  '④ 被拒后没有落任何凭证',
  one('SELECT COUNT(*) c FROM vouchers').c === beforeNeg,
  `前=${beforeNeg} 后=${one('SELECT COUNT(*) c FROM vouchers').c}`
)

const genMissing = await api('POST', '/api/accounting/vouchers/generate', {
  token,
  body: { biz_type: 'purchase_return', source_id: 99999999 }
})
ok(
  '④ 不存在的来源 ⇒ 404 SOURCE_NOT_FOUND',
  genMissing.status === 404 && (genMissing.body?.detail?.code || genMissing.body?.code) === 'SOURCE_NOT_FOUND',
  `http=${genMissing.status} code=${genMissing.body?.detail?.code || genMissing.body?.code}`
)

// ---------------------------------------------------------------- §5 应付台账披露
section('§5 应付台账：退货披露（且不参与 settle/paid/open 口径）')
const settleBefore = safeJson(all('SELECT * FROM purchase_settlements ORDER BY id'))
const payables = await api('GET', '/api/purchase/payables', { token })
ok('⑤ /purchase/payables 返回 200', payables.status === 200, `http=${payables.status}`)
const d = payables.body?.data
ok('⑤ 响应里有独立的 returns 披露块', !!d?.returns, safeJson(d && Object.keys(d)))

const dbReturnTotal = one(
  `SELECT COALESCE(SUM(total_amount),0) s FROM purchase_returns WHERE status IN ('confirmed','completed')`
).s
const shown = Number(d?.returns?.total_amount)
ok(
  '⑤ 披露金额 == 库里 confirmed/completed 退货合计',
  Math.abs(shown - Number(dbReturnTotal)) < 0.005,
  `披露=${shown} 库内=${dbReturnTotal}`
)
// 判别力自证：如果实现写成"不过滤状态"或 `status <> 'voided'`，上面那条"等于"会红；
// 这里再独立证一次"状态过滤真的生效"——**全部**退货合计与**披露**合计必须显著不同。
// 少了这一条，一个把 draft 也算进去的实现，只要我恰好没造 draft 夹具就能混过去（"断言管有没有、不管对不对"）。
const allReturnTotal = one(`SELECT COALESCE(SUM(total_amount),0) s FROM purchase_returns`).s
ok(
  '⑤ 披露剔除了 draft（与"全部退货合计"显著不同 ⇒ 状态过滤真的生效）',
  Math.abs(Number(allReturnTotal) - shown) > 0.005,
  `全部=${allReturnTotal} 披露=${shown}（我造的 draft 是 ${fxDraft.doc_no} / 99.99）`
)
ok(
  '⑤ 披露块按供应商聚合，且只统计两类终态',
  Array.isArray(d?.returns?.by_supplier) &&
    d.returns.by_supplier.every((x) => Number(x.return_amount) >= 0),
  safeJson(d?.returns?.by_supplier?.[0])
)
// 只读自证：调这个接口不许改结算单
ok(
  '⑤ 调台账接口**没有**改动 purchase_settlements（披露不影响既有口径）',
  safeJson(all('SELECT * FROM purchase_settlements ORDER BY id')) === settleBefore,
  '结算单快照前后不一致'
)

// ---------------------------------------------------------------- §7 配置开关：抵减到底接没接线
section('§7 供应链设置 purchase_return_offset —— 改成"是"，行为必须真的跟着变')
//
// 这一节守的是本项目最硬的一条判据：**"登记了"≠"接线了"**。
// 配置项写进 `SETTING_RULES` 只证明"它出现在界面上"，**不证明它管用**。
// 唯一证明是：**把配置改成另一个值 ⇒ 行为真的跟着变**，再改回来 ⇒ 又变回去。
// 所以下面不是"检查配置存在"，而是**同一套夹具、同一个供应商、同一个期间，只翻开关**。

const S = await import('../server/lib/settings.js')
const P = await import('../server/lib/purchase.js')

const def = S.SETTING_RULES.purchase_return_offset
ok('⑦ 配置已登记在「供应链参数」组', def?.group === 'inv', `group=${def?.group}`)
ok('⑦ 是危险项（改动要写理由）', def?.is_danger === true, `is_danger=${def?.is_danger}`)
// 默认值必须等于**上线前的实际行为**（上线前退货不参与结算）
ok('⑦ 默认值 = 不抵减（0，= 改之前的实际行为）', String(def?.default) === '0', `default=${def?.default}`)
ok('⑦ 库里当前读出来是 false', S.readSetting(db, 'purchase_return_offset') === false, String(S.readSetting(db, 'purchase_return_offset')))

// 夹具：**专用供应商** + 一张收货单（可结算）+ 一张已确认退货（可抵减），同期间。
// ⚠️ 必须用专用供应商，不能借库里现成的：`buildSettlement` 按「供应商 + 期间 + 状态」取数，
// 借来的供应商会把**别人的**收货单/退货单一起卷进结算，金额对不上，而失败原因看起来像"抵减算错了"。
const near = (a, b) => Math.abs(Number(a) - Number(b)) < 0.005
const AMT_RC = 1000
const AMT_RT = 300
const sku = one('SELECT id FROM product_skus ORDER BY id LIMIT 1')
const stamp = String(Date.now()).slice(-6)
const fxSupCode = `${MARK}S${stamp}`
const fxSupId = Number(
  db
    .prepare('INSERT INTO suppliers (code,name,category,settle_type,status,created_at) VALUES (?,?,?,?,?,datetime(\'now\',\'localtime\'))')
    .run(fxSupCode, `${MARK} 抵减夹具供应商`, '测试', '月结30天', 'active').lastInsertRowid
)
const fxRcNo = `${MARK}RC${stamp}`
const rcId = Number(
  db
    .prepare(
      `INSERT INTO purchase_receipts (doc_no,order_id,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,inspector,remark,created_by,created_at)
       VALUES (?,NULL,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
    )
    .run(fxRcNo, fxSupId, wh.id, '2026-10-05', 'received', 10, AMT_RC, 'test', `${MARK} 抵减夹具收货单`, 'test').lastInsertRowid
)
db.prepare('INSERT INTO purchase_receipt_items (receipt_id,sku_id,qty,price,amount) VALUES (?,?,?,?,?)').run(
  rcId, sku.id, 10, AMT_RC / 10, AMT_RC
)
const fxOffset = makeReturn('confirmed', AMT_RT, fxSupId)
db.prepare('INSERT INTO purchase_return_items (return_id,sku_id,qty,price,amount) VALUES (?,?,?,?,?)').run(
  fxOffset.id, sku.id, 3, AMT_RT / 3, AMT_RT
)

const SETTLE_Q = {
  supplierId: fxSupId,
  settleDate: '2026-10-17',
  periodStart: '2026-10-01',
  periodEnd: '2026-10-31',
  settleMode: 'manual',
  actor: { id: null, name: 'test' }
}
/** 结算单会"占用"收货单与退货单（一单一结）；要重跑就把这张结算单删掉，等价于作废 */
function dropSettlement(sid) {
  db.prepare('DELETE FROM purchase_settlement_items WHERE settle_id=?').run(sid)
  db.prepare('DELETE FROM purchase_settlements WHERE id=?').run(sid)
}

// ---- 关着的时候 ----
const s1 = P.buildSettlement(db, SETTLE_Q)
ok('⑦ 关闭时：抵减额 = 0', near(s1.return_amount, 0), `return_amount=${s1.return_amount}`)
ok('⑦ 关闭时：应结 = 入库金额（退货完全不参与）', near(s1.settle_amount, AMT_RC), `settle_amount=${s1.settle_amount}`)
ok(
  '⑦ 关闭时：明细里没有 return 行',
  one("SELECT COUNT(*) c FROM purchase_settlement_items WHERE settle_id=? AND source_type='return'", s1.id).c === 0,
  '却出现了 return 明细'
)
dropSettlement(s1.id)

// ---- 翻成"是" ----
S.writeSetting(db, {
  key: 'purchase_return_offset',
  value: '1',
  reason: '测试：验证退货抵减开关真的接线（改完必须能被行为证明）',
  actor: { id: null, name: 'test' },
  source: 'test'
})
ok('⑦ 改成"是"后读出来是 true', S.readSetting(db, 'purchase_return_offset') === true, String(S.readSetting(db, 'purchase_return_offset')))

// 负例：退货比入库多 ⇒ 必须**拒绝建单**，不静默截成 0
// ⚠️ 必须显式传 `fxSupId`：不传会落到默认的 `sup.id`（库里第一个供应商），
// 于是这张大额退货根本不在本夹具供应商名下 —— 溢出不会发生，而失败原因看起来像"溢出判据没写"。
const fxBig = makeReturn('confirmed', AMT_RC + 5000, fxSupId)
let overflowCode = null
try {
  P.buildSettlement(db, SETTLE_Q)
} catch (e) {
  overflowCode = e.code || e.message
}
ok('⑦ 退货超过入库时拒绝建单（PST_RETURN_OVERFLOW）', overflowCode === 'PST_RETURN_OVERFLOW', `实得 ${overflowCode}`)
ok(
  '⑦ 被拒后没有多出结算单',
  one('SELECT COUNT(*) c FROM purchase_settlements WHERE supplier_id=?', fxSupId).c === 0,
  '出现了不该有的结算单'
)
db.prepare('DELETE FROM purchase_return_items WHERE return_id=?').run(fxBig.id)
db.prepare('DELETE FROM purchase_returns WHERE id=?').run(fxBig.id)

// ---- 开着的时候 ----
// ⚠️ 这里用 try/catch 而不是裸调用：如果开关**没接线**（注入反例的形态），上面那步溢出不报错、
// 会把收货单吃掉，到这里就变成"没有可结算的入库单"而**崩栈退出** —— 崩栈给不出失败项名字，
// 而"红要可读"是本项目的硬要求。所以把它转成一条可读的断言失败。
let s2 = null
let s2Err = null
try {
  s2 = P.buildSettlement(db, SETTLE_Q)
} catch (e) {
  s2Err = e.code || e.message
}
ok('⑦ 打开后能建出结算单', !!s2, s2Err)
ok('⑦ 打开后：抵减额 = 退货合计', !!s2 && near(s2.return_amount, AMT_RT), `return_amount=${s2?.return_amount}，期望 ${AMT_RT}`)
ok(
  '⑦ 打开后：应结 = 入库 − 退货',
  !!s2 && near(s2.settle_amount, AMT_RC - AMT_RT),
  `settle_amount=${s2?.settle_amount}，期望 ${AMT_RC - AMT_RT}`
)
const negLines = s2
  ? all("SELECT * FROM purchase_settlement_items WHERE settle_id=? AND source_type='return'", s2.id)
  : []
ok('⑦ 打开后：明细有 return 行', negLines.length > 0, `实得 ${negLines.length} 行`)
ok('⑦ 打开后：return 明细金额是负数', negLines.every((x) => Number(x.amount) < 0), safeJson(negLines.map((x) => x.amount)))
ok(
  '⑦ 打开后：头行对得上（return_amount = −Σ明细）',
  !!s2 && near(Number(s2.return_amount), -negLines.reduce((a, x) => a + Number(x.amount), 0)),
  `头=${s2?.return_amount} 明细和=${-negLines.reduce((a, x) => a + Number(x.amount), 0)}`
)

// 一单一结：不删结算单再建一次 ⇒ 这张退货已经被引用，不该被抵第二次
let secondBlocked = null
try {
  P.buildSettlement(db, SETTLE_Q)
} catch (e) {
  secondBlocked = e.code || e.message
}
// 收货单与退货单都已被占用 ⇒ 无可结算对象（PST_NOTHING）；关键是**不能**再抵一次
ok('⑦ 一单一结：不会把同一张退货抵两次', secondBlocked === 'PST_NOTHING', `实得 ${secondBlocked}`)
if (s2) dropSettlement(s2.id)

// ---- 改回去 ----
S.resetSetting(db, { key: 'purchase_return_offset', reason: '测试：复原', actor: { id: null, name: 'test' }, source: 'test' })
ok('⑦ 恢复默认后读出来又是 false', S.readSetting(db, 'purchase_return_offset') === false, String(S.readSetting(db, 'purchase_return_offset')))
// 同理用 try/catch：注入反例下这里已经无可结算对象，裸调用会崩栈
let s3 = null
let s3Err = null
try {
  s3 = P.buildSettlement(db, SETTLE_Q)
} catch (e) {
  s3Err = e.code || e.message
}
ok(
  '⑦ 改回去之后：又变成不抵减（行为真的跟着开关走）',
  !!s3 && near(s3.return_amount, 0) && near(s3.settle_amount, AMT_RC),
  s3 ? safeJson({ r: s3.return_amount, s: s3.settle_amount }) : s3Err
)
if (s3) dropSettlement(s3.id)

// ---------------------------------------------------------------- §6 清夹具 + 零副作用
section('§6 清夹具（连痕一起删）+ 零副作用')
const purged = purgeFixtures()
ok('⑥ 夹具清干净了', purged.purged > 0 && fixtureReturnIds().length === 0, safeJson(purged))
ok('⑥ 没有孤儿留痕', purged.orphan_events === 0, `残留 ${purged.orphan_events} 条`)
ok('⑥ 没有孤儿凭证', purged.orphan_vouchers === 0, `残留 ${purged.orphan_vouchers} 条`)
ok(
  '⑥ 结算单与收货单也清干净了（§7 的抵减夹具）',
  // ⚠️ 这里**不能**要求 `purged.settle > 0`：§7 自己会把三张结算单逐一 drop 掉，
  // 到这一步本来就一张都不剩（第一版按 "purged>0" 写，于是它必然红 —— 判据写错了对象）。
  // 真正要守的是**终态干净**；而"夹具确实存在过"由 §7 的 s1/s2/s3 断言证明，
  // 不是靠这条清理断言自我证明。
  purged.receipts > 0 &&
    fixtureSettleIds().length === 0 &&
    one(`SELECT COUNT(*) c FROM purchase_receipts WHERE doc_no LIKE '${MARK}%'`).c === 0,
  safeJson(purged)
)
ok(
  '⑥ 专用供应商已删除（不留"没有业务的空供应商"）',
  one(`SELECT COUNT(*) c FROM suppliers WHERE code LIKE '${MARK}%'`).c === 0,
  '夹具供应商还在'
)
ok(
  '⑥ 全库凭证数回到跑之前',
  one('SELECT COUNT(*) c FROM vouchers').c === voucherCountBefore,
  `前=${voucherCountBefore} 后=${one('SELECT COUNT(*) c FROM vouchers').c}`
)
restoreCounters()
ok(
  '⑥ doc_no_counters 已还原（本脚本每跑一次不许推高单号）',
  snapshotCounters() === counterSnapshot,
  '计数器快照还原后不一致'
)

await stopAndReport(srv, { port: PORT })
// ⚠️ 这一行的**形状**是跑批口径的一部分：`regress-all.mjs` 的 `tally()` 用
// `/通过\s*(\d+)\s*\/\s*失败\s*(\d+)/` 抓计数 —— **必须有那个斜杠**。
// 本脚本第一版写成 `通过 59　失败 0`（全角空格、无斜杠），于是 59 条断言
// **一直以"通过（无计数）"入账、从不进"断言累计"** —— 看起来绿，实则没被统计。
// 这正是"收尾必须写「通过 N / 失败 M」，否则断言不进累计"那条纪律的现场示例。
console.log(`\n${'─'.repeat(64)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (failedNames.length) console.log('失败项：\n - ' + failedNames.join('\n - '))
process.exit(fail ? 1 : 0)
