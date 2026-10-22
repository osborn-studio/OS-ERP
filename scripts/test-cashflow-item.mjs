/**
 * ============================================================================
 * 文件标识：scripts/test-cashflow-item.mjs ｜ 测试：批次 U：现金流量项目辅助核算（项目字典 + 分录上的项目标记）
 * ============================================================================
 * 【职责】测试：批次 U：现金流量项目辅助核算（项目字典 + 分录上的项目标记）
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
 * 批次 U：现金流量项目辅助核算（项目字典 + 分录上的项目标记）
 *
 * 这一批补的是「现金流量表只能靠猜对手科目」。所以本文件围绕**两条填列路的关系**写：
 *
 *     U1 迁移 041 的结构与内置项         —— 字典真的建起来了、三大类齐全
 *     U2 **没有标记时结果不变**          —— 拿一个独立重写的"旧口径"实现对拍（这一条最要紧）
 *     U3 打了标记之后归属真的变了        —— 同一张凭证，标记换了行，净增加额不动
 *     U4 字典/标记被写坏时探针会响        —— CF_ITEM_UNKNOWN / CF_ITEM_DOMAIN
 *     U5 打标记入口的判据                —— 含"改一笔已定性的钱必须写理由"
 *     U6 一行都不多                      —— 全部写在事务里，收尾回滚干净
 *
 * ## 「没有标记时结果不变」是怎么证的（U2）
 * 拿被测函数和自己的上一个版本比，比的是"代码没变"，不是"结果还对"。
 * 所以 U2 在这里**独立重写了一遍 034 的旧口径**（对手科目分桶 → 单边配对 →
 * 复合凭证净额进兜底桶 → 按区间与方向归行 → 小计按行号加）——
 * 那段参照实现是照 034 的算法抄的，不引用被测函数的任何内部结果
 * （只用了 `listReportLines` / `parseSubjectRange` / `inSubjectRange` / `parseSubtotalExpr`
 * 这四个**口径读取与解析**的纯工具，它们不是本批改动的那段逻辑）。
 * 演示库一条标记都没有，于是：新实现（标记优先）与旧口径参照实现**逐行逐桶必须相同**。
 * 另外再补一条：把"标记能力探测"关掉的那份库（未迁移快照）与开着的那份也逐字节相同。
 *
 * ## 为什么用「临时库」而不是 `data/gml_*.db`
 * 迁移 041 会给 `voucher_entries` 加一列、建一张表。在**开发库**上跑迁移是本批明令禁止的
 * （那些库由另一个任务整库重建）。所以本脚本：
 *   ① 用 `better-sqlite3` 的 `backup()` 把三库各取一份**一致快照**到临时目录（绝不动 data/）；
 *   ② 在临时快照上跑 `initSchemaFor`（含 041）；
 *   ③ 另留一份**未迁移**的快照，用于"能力探测关掉时结果也不变"。
 *
 * 用法：node scripts/test-cashflow-item.mjs
 * 收尾必打「通过 N / 失败 M」（否则回归统计器会把断言记成"通过（无计数）"）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const require = createRequire(import.meta.url)

const INDUSTRIES = ['cosmetic', 'food', 'apparel']

let pass = 0
let fail = 0
const failures = []
// 实际跑过的库：**计数行由它派生**，不写死"三库"（只跑一个库却写着三库会误导读计数行的人）。
// 必须在模块作用域（收尾的计数行在循环之外）。
const ran = []
function ok(cond, msg, detail) {
  // 自保（铁律 27 第二次撞车后立的规矩）：参数写反时**当场崩**，而不是「永远绿」。
  // 本文件的形参顺序是 (cond, msg, detail)；搬别的文件的写法过来时这一行会立刻逮住它。
  if (typeof cond !== 'boolean') throw new Error(`ok() 的条件必须是布尔值，收到 ${typeof cond}（参数顺序写反了？）`)
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 300)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const near = (a, b, eps = 0.005) => Math.abs(Number(a) - Number(b)) <= eps
const okNear = (a, b, msg, eps = 0.005) => {
  if (!near(a, b, eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(near(a, b, eps), msg)
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)
const throws = (fn, code, msg) => {
  try {
    fn()
  } catch (e) {
    const hit = !code || e.code === code
    if (!hit) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${code}，实得 ${e.code || e.message}`)
    ok(hit, msg)
    return
  }
  console.log(`  \x1b[31m✗\x1b[0m ${msg}：没有抛错`)
  ok(false, msg)
}
const money = (v) => Math.round((Number(v) || 0) * 100) / 100

// ===========================================================================
// 0. 取三库的一致快照到临时目录（**绝不碰 data/**）
// ===========================================================================
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'gml-cfitem-'))
const RAW_DIR = path.join(TMP, 'raw') // 未迁移：标记能力探测为 false 的那一份
const MIG_DIR = path.join(TMP, 'mig') // 跑完 041 的那一份
fs.mkdirSync(RAW_DIR)
fs.mkdirSync(MIG_DIR)

const available = []
for (const ind of INDUSTRIES) {
  const src = path.join(ROOT, 'data', `gml_${ind}.db`)
  if (!fs.existsSync(src)) {
    console.log(`  （跳过 ${ind}：${src} 不存在）`)
    continue
  }
  // `backup()` 而不是 `copyFileSync`：WAL 模式下主文件里没有最新页，
  // 裸复制会拿到一份**落后于现状**的库 —— 那会让对拍在两个不同的时间点上做。
  const s = new Database(src, { readonly: true, fileMustExist: true })
  await s.backup(path.join(RAW_DIR, `gml_${ind}.db`))
  await s.backup(path.join(MIG_DIR, `gml_${ind}.db`))
  s.close()
  available.push(ind)
}

// 必须在 import 业务模块**之前**设好：`DATA_DIR` 是 db/index.js 的模块级常量
process.env.GML_DATA_DIR = MIG_DIR

const { initSchemaFor } = await import('../server/db/index.js')
const { runMigrations } = await import('../server/db/migrations/runner.js')
const R = await import('../server/lib/report.js')
const MIG_FILE = require(path.join(ROOT, 'server/db/migrations/041_cash_flow_item.cjs'))

console.log(`=== 现金流量项目辅助核算测试（三库：${available.join(' / ')}） ===`)
console.log(`  临时快照目录 ${TMP}`)

// ---------------------------------------------------------------------------
// U2 的参照实现：**独立重写一遍 034 的旧口径**
// ---------------------------------------------------------------------------
// 这段代码照着 034 的算法抄（不是我改完之后的代码），只依赖口径读取与解析的四个纯工具。
// 它的作用不是"再算一遍核对"，而是把**旧口径**冻结成一个可执行的定义：
// 新实现在"零标记"时必须与它逐行逐桶相同。
// ---------------------------------------------------------------------------
function refCashFlow(db, period) {
  const cashSet = new Set(R.cashSubjectsOf(db, 'cf'))
  const codeOf = new Map(
    db.prepare('SELECT id, code FROM accounting_subjects').all().map((r) => [Number(r.id), String(r.code)])
  )
  const vouchers = db
    .prepare("SELECT id FROM vouchers WHERE status='posted' AND period=? ORDER BY id")
    .all(period)
  const entriesOf = db.prepare('SELECT subject_id, direction, amount FROM voucher_entries WHERE voucher_id=? ORDER BY seq')
  const lines = R.listReportLines(db, 'cf')
  const itemLines = lines.filter((l) => l.line_type === 'item' && !l.is_fallback)
  const fallback = lines.find((l) => l.line_type === 'item' && l.is_fallback) || null

  const buckets = new Map()
  const bump = (key, dir, amt) => {
    const cur = buckets.get(key) || { credit: 0, debit: 0 }
    cur[dir] = money(cur[dir] + amt)
    buckets.set(key, cur)
  }
  let cashIn = 0
  let cashOut = 0
  let cashVouchers = 0
  let complexVouchers = 0
  let analyzedEntries = 0 // 「被分析过的非现金分录」条数 —— 用来核对新实现报的 untagged_count
  for (const v of vouchers) {
    let cd = 0
    let cc = 0
    const others = []
    for (const e of entriesOf.all(v.id)) {
      const amt = money(e.amount)
      if (cashSet.has(codeOf.get(Number(e.subject_id)))) {
        if (e.direction === 'debit') cd = money(cd + amt)
        else cc = money(cc + amt)
      } else {
        others.push({ id: Number(e.subject_id), direction: e.direction, amount: amt })
      }
    }
    if (cd === 0 && cc === 0) continue
    cashVouchers += 1
    // 只有"涉及现金"的凭证上的非现金分录才会被分析（不涉及现金的凭证整张跳过）
    analyzedEntries += others.length
    cashIn = money(cashIn + cd)
    cashOut = money(cashOut + cc)
    const od = money(others.filter((o) => o.direction === 'debit').reduce((s, o) => s + o.amount, 0))
    const oc = money(others.filter((o) => o.direction === 'credit').reduce((s, o) => s + o.amount, 0))
    const pureIn = cc === 0 && od === 0 && Math.abs(oc - cd) <= 0.005
    const pureOut = cd === 0 && oc === 0 && Math.abs(od - cc) <= 0.005
    if (pureIn || pureOut) {
      for (const o of others) bump(o.id, o.direction, o.amount)
      continue
    }
    const net = money(cd - cc)
    if (net !== 0) bump('__OTHER__', net > 0 ? 'credit' : 'debit', Math.abs(net))
    complexVouchers += 1
  }

  const amounts = new Map()
  for (const l of itemLines) amounts.set(l.line_no, 0)
  const claimed = new Set()
  const segsOf = new Map(itemLines.map((l) => [l, R.parseSubjectRange(l.subject_range)]))
  for (const [key, b] of buckets) {
    if (key === '__OTHER__') continue
    const code = codeOf.get(Number(key))
    if (!code) continue
    for (const dir of ['credit', 'debit']) {
      const amt = money(b[dir])
      if (amt === 0) continue
      const hit = itemLines.find((l) => (!l.only_direction || l.only_direction === dir) && R.inSubjectRange(code, segsOf.get(l)))
      if (!hit) continue
      amounts.set(hit.line_no, money((amounts.get(hit.line_no) || 0) + hit.sign * (dir === 'credit' ? amt : -amt)))
      claimed.add(`${key}|${dir}`)
    }
  }
  if (fallback) {
    const segs = R.parseSubjectRange(fallback.subject_range)
    let sum = 0
    for (const [key, b] of buckets) {
      const code = key === '__OTHER__' ? null : codeOf.get(Number(key))
      for (const dir of ['credit', 'debit']) {
        const amt = money(b[dir])
        if (amt === 0) continue
        if (claimed.has(`${key}|${dir}`)) continue
        if (code && !R.inSubjectRange(code, segs)) continue
        sum += dir === 'credit' ? amt : -amt
        claimed.add(`${key}|${dir}`)
      }
    }
    amounts.set(fallback.line_no, money(fallback.sign * sum))
  }
  for (const l of lines.filter((x) => x.line_type !== 'item').sort((a, b) => Number(a.line_no) - Number(b.line_no))) {
    let sum = 0
    for (const ref of R.parseSubtotalExpr(l.subtotal_expr)) sum += ref.sign * (amounts.get(ref.no) ?? 0)
    amounts.set(l.line_no, money(l.sign * sum))
  }
  const ordered = lines
    .slice()
    .sort((a, b) => Number(a.order_no) - Number(b.order_no) || Number(a.line_no) - Number(b.line_no))
  return {
    rows: ordered.map((l) => [l.line_code, amounts.get(l.line_no) ?? 0]),
    totals: Object.fromEntries(lines.map((l) => [l.line_code, amounts.get(l.line_no) ?? 0])),
    cash_in: cashIn,
    cash_out: cashOut,
    net: money(cashIn - cashOut),
    cash_vouchers: cashVouchers,
    complex_vouchers: complexVouchers,
    analyzed_entries: analyzedEntries,
    bucket_entries: [...buckets.entries()]
      .map(([k, b]) => [k, b])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  }
}

const NEW_CASH_KEYS = ['item_buckets', 'tag_supported', 'tagged_count', 'untagged_count', 'tagged_vouchers', 'tagged_unresolved_count']
const stripNew = (cash) => {
  const out = {}
  for (const [k, v] of Object.entries(cash)) {
    if (NEW_CASH_KEYS.includes(k)) continue
    // buckets 是 Map，JSON 化会变成 {} —— 显式摊成数组，否则"逐字节相同"是假的相同
    out[k] = k === 'buckets'
      ? [...v.entries()].map(([key, b]) => [key, b]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      : v
  }
  return out
}
const sortedEntries = (m) => [...m.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))

for (const ind of available) {
  ran.push(ind) // 这一库真的开跑了 —— 计数行的库标签由它派生
  console.log(`\n${'─'.repeat(72)}\n【${ind}】`)

  const mig = initSchemaFor(ind)
  const raw = new Database(path.join(RAW_DIR, `gml_${ind}.db`))
  raw.pragma('journal_mode = WAL')
  // 未迁移快照 = "041 之前的库"。如果这份快照本身已经迁移过（开发库被人先跑过迁移），
  // 就把字典表删掉，**显式**造出"没有这一维"的库 —— 删列做不到，但"能力探测"要求
  // 表与列同时在，删表足以让 `tag_supported` 为 false，从而走到纯旧路径。
  // 这样"探测关掉时结果也不变"这条补充基线在任何一份快照上都成立。
  raw.exec('DROP TABLE IF EXISTS cash_flow_items')

  const periods = R.availablePeriods(mig)
  const busy = periods.find((p) => p.posted_count > 0)?.period
  const postedPeriods = periods.filter((p) => p.posted_count > 0).map((p) => p.period).sort()
  console.log(`  活跃期间 ${busy || '（无）'}（已过账 ${periods.find((p) => p.period === busy)?.posted_count ?? 0} 张）`)

  // =========================================================================
  section(`U1 迁移 041：字典、列、内置项、权限点（${ind}）`)
  // =========================================================================
  const hasTable = !!mig.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='cash_flow_items'").get()
  ok(hasTable, 'cash_flow_items 表已建（迁移 041 跑过）')
  const migHasColumn = mig.prepare('PRAGMA table_info(voucher_entries)').all().some((c) => c.name === 'cash_flow_item')
  ok(migHasColumn, '已迁移的那一份有 voucher_entries.cash_flow_item 列')
  ok(!R.cashFlowBuckets(raw, { period: busy, cashSubjects: R.cashSubjectsOf(mig, 'cf') }).tag_supported, '未迁移快照上报 tag_supported=false（已把字典表删掉，代表 041 之前的库）')

  const items = R.listCashFlowItems(mig)
  const builtin = items.filter((i) => i.is_builtin)
  ok(builtin.length >= 18, `内置现金流量项目不少于 18 条（实际 ${builtin.length}）`)
  eq('三大类齐全（经营 / 投资 / 筹资）', [...new Set(builtin.map((i) => i.category))].sort(), ['financing', 'investing', 'operating'])
  for (const c of ['operating', 'investing', 'financing']) {
    const n = builtin.filter((i) => i.category === c).length
    ok(n >= 3, `「${c}」至少 3 条内置项（实际 ${n}）`)
  }
  ok(builtin.every((i) => ['in', 'out', 'both'].includes(i.direction)), '每条内置项的方向都在取值域内')
  ok(builtin.every((i) => i.category_label && i.direction_label), '字典行自带类别/方向的中文标签（界面不自己拼）')
  ok(builtin.every((i) => i.report_line_code), '每条内置项都配了报表落点（否则标了等于没标）')
  // 方向是**会计语义**，不是展示字段：`direction='in'` 的项目标在贷方分录上、`'out'` 的标在借方上。
  // 但 041 的 `verify()` 只查"方向是不是 in/out/both" —— **查不出"方向写反了"**：
  // 把"销售收现"写成 out，取值域仍然合法、内置项条数不变、`def.items` 指纹只记 code 列表，
  // 于是**没有任何断言会响**，而报表那一行的金额会悄悄变成负的（取号由分录方向决定，账仍然是平的）。
  // 所以这里按**字面表**钉住几个已被本文件其他断言依赖的内置项方向。
  const DIRECTION_PIN = {
    CFI_SALES_GOODS: 'in', // 「销售商品…收到的现金」—— 标在贷方（收到钱）
    CFI_TAX_REFUND: 'in', // 「收到的税费返还」
    CFI_TAX_PAY: 'out', // 「支付的各项税费」—— 标在借方
    CFI_BUY_GOODS: 'out', // 「购买商品…支付的现金」
    CFI_BORROW_IN: 'in', // 「取得借款收到的现金」
    CFI_REPAY_DEBT: 'out' // 「偿还债务支付的现金」
  }
  eq('关键内置项的方向与会计语义一致（写反了估值域仍合法 ⇒ 只有这条守得住）',
    Object.entries(DIRECTION_PIN).filter(([code, dir]) => builtin.find((i) => i.code === code)?.direction !== dir).map(([c, d]) => `${c}≠${d}`),
    [])

  // ---- 定义 → **全新库**：空库跑一遍 schema.sql + 全部迁移，字典必须就是定义那一份 ----
  // 为什么必须有这一段：上面所有断言查的都是 `mig`（**开发库快照**，041 早就跑过了），
  // 于是"定义里把方向写反了"在这份快照上**永远看不出来**（`up()` 不会重跑：指纹只记 code 清单）。
  // 唯一能发现"新装一台会拿到一份错字典"的办法，就是**真的在一张空库上把建库这条路走一遍**。
  // （`initSchemaFor` 走的是 pool，`DATA_DIR` 被本脚本固定到了快照目录；所以这里自己按
  //   `schema.sql` + `runMigrations` 两条真实步骤走，落到本测试自己的临时目录里。）
  {
    const freshPath = path.join(TMP, `fresh_${ind}.db`)
    const fresh = new Database(freshPath)
    fresh.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
    runMigrations(fresh)
    const fi = R.listCashFlowItems(fresh).filter((i) => i.is_builtin)
    eq('全新库（空库跑一遍建库）的内置项条数 == 定义条数', fi.length, builtin.length)
    eq('全新库的内置项方向与会计语义一致（定义写反了只有这条能发现）',
      Object.entries(DIRECTION_PIN).filter(([code, dir]) => fi.find((i) => i.code === code)?.direction !== dir).map(([c, d]) => `${c}≠${d}`),
      [])
    fresh.close()
    try { fs.rmSync(freshPath, { force: true }) } catch { /* 删不掉不影响结论 */ }
  }

  // ---- 内置项以**定义为准**：把库里那条写坏 ⇒ verify() 判脱节 ⇒ 重跑 up() 收敛回定义值 ----
  // 这一段守的是"**已迁移的库**也会收敛"（上面那段只覆盖全新库）。
  // 为什么非要它：`up()` 原来是 `INSERT OR IGNORE`（不修已存在的行），于是"定义改了"在存量库上
  // 只表现为"每次启动报一次 heal、数据不变"——响亮但不可行动。现在 `up()` 是 upsert：
  // 定义那一份是唯一真相，库里的这几列会被收敛回来（**在事务里做、做完立刻还原**）。
  {
    const before = mig.prepare("SELECT direction d FROM cash_flow_items WHERE code='CFI_SALES_GOODS'").get().d
    eq('收敛实验前：库里的方向 == 定义值（in）', before, 'in')
    mig.prepare("UPDATE cash_flow_items SET direction='out', report_line_code='CF_TAX_CASH' WHERE code='CFI_SALES_GOODS'").run()
    ok(MIG_FILE.verify(mig) === false, '把内置项的方向/落点写坏 ⇒ 迁移 verify() 判为脱节（不变量三之二）')
    runMigrations(mig) // 触发 heal：verify() false ⇒ 重跑 up()
    eq('重跑 up() 之后**已迁移的库**收敛回定义值（方向 in / 落点 CF_SALES_CASH）',
      mig.prepare("SELECT direction d FROM cash_flow_items WHERE code='CFI_SALES_GOODS'").get().d, 'in')
    eq('落点也一并收敛（定义是唯一真相）',
      mig.prepare("SELECT report_line_code c FROM cash_flow_items WHERE code='CFI_SALES_GOODS'").get().c, 'CF_SALES_CASH')
    ok(MIG_FILE.verify(mig) === true, '收敛之后 verify() 回到通过（两边永远可满足）')
  }
  const meta = R.cashFlowItemMeta(mig)
  eq('元数据如实报出：落点失效 0 条（内置项都指向真实存在的报表行）', meta.orphan_count, 0)
  ok(meta.mapped_active === meta.active, `所有启用项都配了落点（${meta.mapped_active}/${meta.active}）`)
  eq('类别与方向的标签由服务端给（界面不硬编码）', [meta.categories.length, meta.directions.length], [3, 3])

  const granted = mig.prepare("SELECT role_code, perm_code FROM role_permissions WHERE perm_code LIKE 'finance.cashflow.item.%' ORDER BY role_code, perm_code").all()
  ok(granted.length > 0, `权限点已授予角色（${granted.map((g) => `${g.role_code}:${g.perm_code.split('.').pop()}`).join(' ')}）`)
  eq('两个权限点都登记了', mig.prepare("SELECT code FROM permissions WHERE code LIKE 'finance.cashflow.item.%' ORDER BY code").all().map((r) => r.code), ['finance.cashflow.item.edit', 'finance.cashflow.item.view'])
  ok(granted.every((g) => ['admin', 'boss', 'finance'].includes(g.role_code)), '没有把一个"改报表金额"的权限点发给财务以外的业务角色')
  ok(MIG_FILE.verify(mig) === true, '迁移 041 的 verify() 通过（结构 + 取值域 + 标记有出处 + 内置项齐 + 指纹不脱节）')

  // =========================================================================
  section(`U2 没有标记时结果不变：与独立重写的旧口径逐行逐桶对拍（${ind}）`)
  // =========================================================================
  const cashSubjects = R.cashSubjectsOf(mig, 'cf')
  let compared = 0
  let nonZeroPeriods = 0
  for (const p of postedPeriods) {
    const ref = refCashFlow(mig, p)
    if (ref.bucket_entries.length > 0) nonZeroPeriods += 1
    const rep = R.computeReport(mig, { reportCode: 'cf', period: p })
    const b = R.cashFlowBuckets(mig, { period: p, cashSubjects })
    eq(`[${p}] 逐行金额 == 旧口径参照实现（${ref.rows.length} 行）`, rep.rows.map((r) => [r.line_code, r.amount]), ref.rows)
    eq(`[${p}] 合计 == 参照实现`, rep.totals, ref.totals)
    eq(`[${p}] 流入/流出/净额/凭证数 == 参照实现`, [b.cash_in, b.cash_out, b.net, b.cash_vouchers, b.complex_vouchers], [ref.cash_in, ref.cash_out, ref.net, ref.cash_vouchers, ref.complex_vouchers])
    eq(`[${p}] 对手科目分桶 == 参照实现`, stripNew(b).buckets, ref.bucket_entries)
    // 迁移后的库上报 tag_supported=true（列与表都在），但本期间一条标记都没有：
    // 于是 tagged_count / tagged_vouchers / item_buckets 必须全是空的，
    // 而 untagged_count 应当**恰好等于**这一期被分析过的非现金分录条数（> 0 是正常的）。
    eq(`[${p}] 本期没有任何标记（能力开着但没标记可用）`, [b.tag_supported, b.tagged_count, b.tagged_vouchers, b.tagged_unresolved_count, sortedEntries(b.item_buckets).length], [true, 0, 0, 0, 0])
    eq(`[${p}] untagged_count == 参照实现里被分析过的非现金分录条数`, b.untagged_count, ref.analyzed_entries)
    compared += 1
  }
  ok(compared > 0, `至少对拍了一个期间（实际 ${compared} 个）`)
  // **防空跑**：如果每个期间的分桶都是空的，上面那串"逐行相同"就只是"两边都是 0"
  // （批次 Q 的教训：「跳过」与「通过」在输出上完全一样）。所以这里要求至少有一个期间真的有数。
  ok(nonZeroPeriods > 0, `至少有一个期间的分桶非空（实际 ${nonZeroPeriods}/${compared} 个期间真的有现金收支）`)
  console.log(`  对拍 ${compared} 个已过账期间，其中 ${nonZeroPeriods} 个真的有现金收支（不是"两边都是 0"）`)

  if (busy) {
    const ref = refCashFlow(mig, busy)
    const rep = R.computeReport(mig, { reportCode: 'cf', period: busy, range: 'ytd' })
    const mc = rep.rows.map((r) => [r.line_code, r.amount])
    const rc = ref.rows.map(([code, amount]) => [code, amount])
    eq(`[${busy}] 本年累计的**本期列**也等于参照实现`, mc, rc)
    // 本年累计列 = 本年 1 月到本期逐月相加（再走一遍参照实现，两条独立路径互证）
    const months = []
    for (let m = 1; m <= Number(busy.slice(5)); m += 1) months.push(`${busy.slice(0, 4)}-${String(m).padStart(2, '0')}`)
    const acc = new Map()
    for (const m of months) for (const [code, amount] of refCashFlow(mig, m).rows) acc.set(code, money((acc.get(code) || 0) + amount))
    eq(`[${busy}] 本年累计列 == 逐月参照实现相加`, rep.rows.map((r) => [r.line_code, r.ytd_amount]), [...acc.entries()])
    // 能力探测关掉的那一份（041 之前的库）也必须给出同一组数：
    // 它走的是"没有标记"的那一支，与新实现唯一的分歧点就是"能不能读到标记"。
    const rb = R.cashFlowBuckets(raw, { period: busy, cashSubjects })
    eq('能力探测关掉时 cashFlowBuckets 的旧字段逐字节相同', stripNew(R.cashFlowBuckets(mig, { period: busy, cashSubjects })), stripNew(rb))
    const rr = R.computeReport(raw, { reportCode: 'cf', period: busy })
    eq('能力探测关掉时现金流量表逐行金额相同', rr.rows.map((r) => [r.line_code, r.amount]), R.computeReport(mig, { reportCode: 'cf', period: busy }).rows.map((r) => [r.line_code, r.amount]))
  }
  {
    const rep = R.computeReport(mig, { reportCode: 'cf', period: '2099-01' })
    ok(rep.rows.every((r) => Number(r.amount) === 0), '[2099-01 空期间] 逐行金额全 0（没有标记这一维也不该凭空长钱）')
  }

  // =========================================================================
  section(`U3 打了标记之后归属真的变了（${ind}）`)
  // =========================================================================
  const PK = '2099-06' // 与 test-report.mjs 同一约定：自造期间，与演示数据无关
  const before = {
    vouchers: mig.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: mig.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    items: mig.prepare('SELECT COUNT(*) c FROM cash_flow_items').get().c,
    lines: mig.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
    perms: mig.prepare("SELECT COUNT(*) c FROM role_permissions WHERE perm_code LIKE 'finance.cashflow.item.%'").get().c
  }

  mig.exec('BEGIN')
  try {
    const subjects = mig.prepare("SELECT id, code, name FROM accounting_subjects WHERE is_leaf=1 AND status='active' ORDER BY code").all()
    const byCode = (c) => subjects.find((s) => s.code === c) || subjects[0]
    let seq = 91000
    const mkVoucher = ({ docNo, lines, period = PK }) => {
      seq += 1
      const total = money(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
      const vid = Number(
        mig
          .prepare(`INSERT INTO vouchers (doc_no,biz_type,source_type,source_id,voucher_date,period,status,total_debit,total_credit,memo,maker_name)
                    VALUES (?,?,'test_cfitem',?,?,?,'posted',?,?,?,'test-cfitem')`)
          .run(docNo, 'test_cfitem', seq, `${period}-15`, period, total, total, docNo).lastInsertRowid
      )
      const ins = mig.prepare(`INSERT INTO voucher_entries (voucher_id,seq,summary,subject_id,subject_code,subject_name,direction,amount,cash_flow_item)
                               VALUES (?,?,?,?,?,?,?,?,?)`)
      lines.forEach((l, i) => {
        const s = byCode(l.code)
        ins.run(vid, i + 1, docNo, s.id, s.code, s.name, l.direction, l.amount, l.item ?? null)
      })
      return vid
    }
    const lineNoOf = (code) => Number(mig.prepare("SELECT line_no FROM report_lines WHERE report_code='cf' AND line_code=?").get(code).line_no)
    const amtOf = (rep, code) => money(rep.rows.find((r) => r.line_code === code)?.amount ?? 0)
    const act = { id: null, name: 'test-cashflow-item' }

    // ---- 先在一个**专门的期间**里造齐"各种凭证形态"，再对一次旧口径 ----
    // 演示库每库只有一两个期间真的有现金收支（其余是纯现金内部划转），拿它证"结果不变"
    // 覆盖面太窄。所以这里自造一批：现金内部划转 / 复合凭证 / 单边流入 / 单边流出 / 多笔同向。
    // 零标记时，新实现必须与 U2 那段**独立重写的旧口径**逐行逐桶相同。
    const PK2 = '2099-07'
    mkVoucher({ docNo: '__test_cfitem__F1', period: PK2, lines: [
      { code: cashSubjects[1] || cashSubjects[0], direction: 'debit', amount: 200 },
      { code: cashSubjects[0], direction: 'credit', amount: 200 }
    ] }) // 现金内部划转：没有非现金分录，净额 0
    mkVoucher({ docNo: '__test_cfitem__F2', period: PK2, lines: [
      { code: cashSubjects[0], direction: 'debit', amount: 400 },
      { code: cashSubjects[0], direction: 'credit', amount: 100 },
      { code: '1122', direction: 'debit', amount: 150 },
      { code: '6001', direction: 'credit', amount: 450 }
    ] }) // 复合凭证：非现金两侧都有 ⇒ 净额法
    const F3 = mkVoucher({ docNo: '__test_cfitem__F3', period: PK2, lines: [
      { code: '2202', direction: 'debit', amount: 250 },
      { code: cashSubjects[0], direction: 'credit', amount: 250 }
    ] }) // 单边配对（流出）
    mkVoucher({ docNo: '__test_cfitem__F4', period: PK2, lines: [
      { code: cashSubjects[0], direction: 'debit', amount: 300 },
      { code: '6001', direction: 'credit', amount: 200 },
      { code: '222101', direction: 'credit', amount: 100 }
    ] }) // 单边配对（流入，多笔同向）
    {
      const ref2 = refCashFlow(mig, PK2)
      const rep2 = R.computeReport(mig, { reportCode: 'cf', period: PK2 })
      const b2 = R.cashFlowBuckets(mig, { period: PK2, cashSubjects })
      section(`U2 之二 零标记时与旧口径一致：在自造的各种凭证形态上再对一次（${ind}）`)
      eq('自造期间的逐行金额 == 旧口径参照实现', rep2.rows.map((r) => [r.line_code, r.amount]), ref2.rows)
      eq('自造期间的合计 == 参照实现', rep2.totals, ref2.totals)
      eq('自造期间的分桶 == 参照实现', stripNew(b2).buckets, ref2.bucket_entries)
      eq('自造期间的流入/流出/净额/凭证数/复合凭证数 == 参照实现', [b2.cash_in, b2.cash_out, b2.net, b2.cash_vouchers, b2.complex_vouchers], [ref2.cash_in, ref2.cash_out, ref2.net, ref2.cash_vouchers, ref2.complex_vouchers])
      // 手算：F1 (200−200) + F2 (400−100) + F3 (0−250) + F4 (300−0) = 350
      okNear(b2.net, 350, '自造期间净额 = 0 + 300 − 250 + 300 = 350（有非零数才不是空跑）')
      okNear(rep2.rows.find((r) => r.is_fallback)?.amount, 300, '复合凭证 F2 的净额 300 真的进了兜底行（这批数据覆盖了净额法）')
      eq('自造期间同样零标记', [b2.tagged_count, b2.tagged_vouchers], [0, 0])
      ok(R.auditReport(mig, { period: PK2 }).ok, '自造期间报表自证通过', JSON.stringify(R.auditReport(mig, { period: PK2 }).problems.map((p) => p.code)))
    }

    // ---- **借方（流出）分录**的标记取号：钱出去要记负 ----
    // 上面那些标记分录都是贷方（流入）。只测贷方的话，"取号反了"这类缺陷根本现不了形
    // （贷方 `credit ? +amt : -amt` 与 `amt` 恰好相同）。所以这里必须专门标一笔借方。
    R.tagVoucherCashFlow(mig, { voucherId: F3, entries: [{ line_no: 1, cash_flow_item: 'CFI_TAX_PAY' }], actor: act })
    {
      const repD = R.computeReport(mig, { reportCode: 'cf', period: PK2 })
      eq('借方分录的标记取负号（250 从「购货付现」搬到「支付的各项税费」，记 −250）', [amtOf(repD, 'CF_PURCHASE_CASH'), amtOf(repD, 'CF_TAX_CASH')], [0, -250])
      okNear(repD.totals.CF_NET_INCREASE, 350, '借方标记之后净增加额仍然不变')
      eq('借方标记后计数如实：tagged_count=1 / tagged_vouchers=1', [repD.cash.tagged_count, repD.cash.tagged_vouchers], [1, 1])
      ok(R.auditReport(mig, { period: PK2 }).ok, '借方标记之后自造期间自证仍通过', JSON.stringify(R.auditReport(mig, { period: PK2 }).problems.map((p) => p.code)))
    }

    // ---- 「方向必须属于该项」这道闸门**不存在**（独立复核点名要的那一条）----
    // 复核派单里写着"去掉 `tagVoucherCashFlow` 里「方向必须属于该项」的校验" ——
    // 实测：**这道校验压根没有**（`direction` 只用于展示标签与 `CF_ITEM_DOMAIN` 的取值域探针，
    // 打标记与归行都不看它）。说谎比缺覆盖更糟，所以这里不假装它存在，而是把它**钉成现状**
    // 并把它**会造成的后果**一并断言出来：
    //   把一笔**借方**（流出）分录标成一个 direction='in'（流入）的项目 —— 不拒绝；
    //   报表把它记到**流入行**上，且取负数（−250）：一行"收到的现金"是负的。
    //   而 `auditReport` **不会**报错（恒等式仍然成立，取号由分录方向决定）。
    // 若将来补上这道闸门，这 3 条会红 —— 那时把它们翻成"被拒"的守卫（本项目已立过这个做法）。
    {
      // 标记调用**包在 try 里**：如果将来补上这道闸门（拒绝方向不匹配），这一句会抛 ——
      // 断言必须能**读得出"被拒了"**，而不是让异常把整个套件带崩（那样后面几十条断言一条都跑不到）。
      const outcome = (() => {
        try {
          R.tagVoucherCashFlow(mig, { voucherId: F3, entries: [{ line_no: 1, cash_flow_item: 'CFI_TAX_REFUND' }], reason: '测试：方向与项目相反（CFI_TAX_REFUND 是流入项，这一笔是借方）', actor: act })
          return { threw: null }
        } catch (e) {
          return { threw: e.code || e.message }
        }
      })()
      eq('现状：把借方（流出）分录取标成流入项目**不做拒绝**（没有「方向必须属于该项」这道闸门）',
        [outcome.threw], [null])
      const repG = R.computeReport(mig, { reportCode: 'cf', period: PK2 })
      eq('它的后果：250 记在**流入行**上但取负数（−250）——"方向写反"能悄悄改报表的一行金额',
        amtOf(repG, 'CF_OTHER_OP_IN'), -250)
      ok(R.auditReport(mig, { period: PK2 }).ok,
        '而且报表自证**不会**报错（这个错误当前没有任何探针守着 —— 这就是它是个口子的原因）',
        JSON.stringify(R.auditReport(mig, { period: PK2 }).problems.map((p) => p.code)))
      // 还原：后面几条断言（以及自造期间的对拍）用的还是"借方 = 支付税费"那一版
      mig.prepare("UPDATE voucher_entries SET cash_flow_item='CFI_TAX_PAY' WHERE voucher_id=? AND seq=1").run(F3)
      eq('还原之后回到 −250 在「支付的各项税费」上（这一段没有留下副作用）', amtOf(R.computeReport(mig, { reportCode: 'cf', period: PK2 }), 'CF_TAX_CASH'), -250)
    }

    // ---- 单边配对凭证：借 现金 100 / 贷 6001 100 ----
    const V1 = mkVoucher({ docNo: '__test_cfitem__V1', lines: [
      { code: cashSubjects[0], direction: 'debit', amount: 100 },
      { code: '6001', direction: 'credit', amount: 100 }
    ] })
    let rep = R.computeReport(mig, { reportCode: 'cf', period: PK })
    okNear(amtOf(rep, 'CF_SALES_CASH'), 100, '打标记之前：100 落「销售商品收到的现金」（分析填列）')
    eq('打标记之前：无从标记', [rep.cash.tagged_count, rep.cash.tagged_vouchers], [0, 0])

    // 标成「收到的税费返还」—— 它落到「收到的其他与经营活动有关的现金」
    const tagOut = R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act })
    eq('打标记回报改动明细（第 2 行 null → CFI_TAX_REFUND）', tagOut.changed, [{ line_no: 2, from: null, to: 'CFI_TAX_REFUND' }])
    rep = R.computeReport(mig, { reportCode: 'cf', period: PK })
    eq('打标记之后：100 从「销售收现」搬到「收到的其他经营现金」', [amtOf(rep, 'CF_SALES_CASH'), amtOf(rep, 'CF_OTHER_OP_IN')], [0, 100])
    okNear(rep.totals.CF_NET_INCREASE, 100, '换行之后净增加额不变（标记只改归属，不改总额）')
    eq('tagged_count=1 / untagged_count=0（这一条是记的，不是推的）', [rep.cash.tagged_count, rep.cash.untagged_count], [1, 0])
    eq('item_buckets 的键就是报表行号', sortedEntries(rep.cash.item_buckets), [[lineNoOf('CF_OTHER_OP_IN'), 100]])
    ok(R.auditReport(mig, { period: PK }).ok, '打标记之后报表自证仍然通过', JSON.stringify(R.auditReport(mig, { period: PK }).problems.map((p) => p.code)))

    // ---- 复合凭证 + 部分标记：标记的归行，没标记的净额进兜底 ----
    mkVoucher({ docNo: '__test_cfitem__V2', lines: [
      { code: cashSubjects[0], direction: 'debit', amount: 500 },
      { code: cashSubjects[0], direction: 'credit', amount: 300 },
      { code: '1122', direction: 'debit', amount: 120 },
      { code: '6001', direction: 'credit', amount: 320, item: 'CFI_SALES_GOODS' }
    ] })
    rep = R.computeReport(mig, { reportCode: 'cf', period: PK })
    okNear(amtOf(rep, 'CF_SALES_CASH'), 320, '标记分录按项目归行（320 → 销售收现）')
    okNear(amtOf(rep, 'CF_OTHER_OP_IN'), 100, '上一张凭证的标记仍在（100 未受影响）')
    okNear(rep.rows.find((r) => r.is_fallback)?.amount, -120, '同一张凭证里没标记的那一笔（借 1122 120）按净额进兜底行')
    // 本期净增加额 = V1 的 100 + V2 的 200（500−300），标记只改归属不改总额
    okNear(rep.totals.CF_NET_INCREASE, 300, '部分标记的复合凭证：净增加额仍然自证（100 + (500−300)）')
    eq('标记凭证不再计入 complex_vouchers（它走的是标记路径）', rep.cash.complex_vouchers, 0)
    eq('tagged_vouchers=2 / tagged_count=2 / untagged_count=1', [rep.cash.tagged_vouchers, rep.cash.tagged_count, rep.cash.untagged_count], [2, 2, 1])
    eq('item_buckets 两个键', sortedEntries(rep.cash.item_buckets), [[lineNoOf('CF_SALES_CASH'), 320], [lineNoOf('CF_OTHER_OP_IN'), 100]])
    ok(R.auditReport(mig, { period: PK }).ok, '部分标记的复合凭证下报表自证仍然通过', JSON.stringify(R.auditReport(mig, { period: PK }).problems.map((p) => p.code)))

    // ---- 标记落不到行上：退回分析，且如实计数（不静默丢账）----
    mig.prepare("UPDATE cash_flow_items SET report_line_code='CF_NOT_EXIST' WHERE code='CFI_TAX_REFUND'").run()
    rep = R.computeReport(mig, { reportCode: 'cf', period: PK })
    // V1 那一条标记失效退回分析（untagged 从 1 变 2），V2 那一条仍然按标记归行
    eq('落点失效的标记退回分析并如实计数', [rep.cash.tagged_count, rep.cash.untagged_count, rep.cash.tagged_unresolved_count], [1, 2, 1])
    okNear(amtOf(rep, 'CF_SALES_CASH'), 420, '退回分析之后 V1 的 100 又回到「销售收现」，与 V2 的 320 合并')
    okNear(rep.totals.CF_NET_INCREASE, 300, '落点失效也不丢账：净增加额仍然自证')
    ok(R.auditReport(mig, { period: PK }).ok, '落点失效不是"账错了"（它只是标记没生效），自证仍通过')
    eq('字典元数据如实报出落点失效数', R.cashFlowItemMeta(mig).orphan_count, 1)
    mig.prepare("UPDATE cash_flow_items SET report_line_code='CF_OTHER_OP_IN' WHERE code='CFI_TAX_REFUND'").run()
    eq('落点恢复后元数据不再报失效', R.cashFlowItemMeta(mig).orphan_count, 0)

    // =======================================================================
    section(`U4 字典与标记被写坏时探针会响（${ind}）`)
    // =======================================================================
    // ① 分录标了一个字典里没有的项目
    mig.prepare('UPDATE voucher_entries SET cash_flow_item=? WHERE voucher_id=? AND seq=2').run('NO_SUCH_ITEM', V1)
    let audit = R.auditReport(mig, { period: PK })
    ok(audit.problems.some((p) => p.code === 'CF_ITEM_UNKNOWN'), 'CF_ITEM_UNKNOWN：分录挂着字典里不存在的项目时报出来', JSON.stringify(audit.problems.map((p) => p.code)))
    mig.prepare('UPDATE voucher_entries SET cash_flow_item=NULL WHERE voucher_id=? AND seq=2').run(V1)
    ok(R.auditReport(mig, { period: PK }).ok, '改回来之后自证回到通过（这条探针不是恒真的）')

    // ② 字典的类别取值域被写坏
    mig.prepare("UPDATE cash_flow_items SET category='weird' WHERE code='CFI_SALES_GOODS'").run()
    audit = R.auditReport(mig, { period: PK })
    ok(audit.problems.some((p) => p.code === 'CF_ITEM_DOMAIN'), 'CF_ITEM_DOMAIN：类别取值域被写坏时报出来', JSON.stringify(audit.problems.map((p) => p.code)))
    mig.prepare("UPDATE cash_flow_items SET category='operating' WHERE code='CFI_SALES_GOODS'").run()

    // ③ 字典的方向取值域被写坏
    mig.prepare("UPDATE cash_flow_items SET direction='sideways' WHERE code='CFI_BORROW_IN'").run()
    audit = R.auditReport(mig, { period: PK })
    ok(audit.problems.some((p) => p.code === 'CF_ITEM_DOMAIN'), 'CF_ITEM_DOMAIN：方向取值域被写坏时报出来', JSON.stringify(audit.problems.map((p) => p.code)))
    mig.prepare("UPDATE cash_flow_items SET direction='in' WHERE code='CFI_BORROW_IN'").run()
    ok(R.auditReport(mig, { period: PK }).ok, '三处写坏都还原之后自证回到通过')

    // ④ 迁移自己的 verify 也守同一条不变量（未知标记 → false，会被 runner 判为脱节）
    mig.prepare('UPDATE voucher_entries SET cash_flow_item=? WHERE voucher_id=? AND seq=2').run('NO_SUCH_ITEM', V1)
    ok(MIG_FILE.verify(mig) === false, '迁移 verify() 对着"标了不存在的项目"判为脱节（不是只有运行时探针在守）')
    mig.prepare('UPDATE voucher_entries SET cash_flow_item=NULL WHERE voucher_id=? AND seq=2').run(V1)
    ok(MIG_FILE.verify(mig) === true, '还原之后迁移 verify() 回到通过')

    // =======================================================================
    section(`U5 打标记入口的判据（${ind}）`)
    // =======================================================================
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: 'abc', entries: [{ line_no: 1 }], actor: act }), 'BAD_VOUCHER_ID', '凭证 id 不合法即拒')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: 99999999, entries: [{ line_no: 1 }], actor: act }), 'VOUCHER_NOT_FOUND', '凭证不存在即拒（404）')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [], actor: act }), 'ENTRIES_REQUIRED', '空 entries 即拒')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 99, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act }), 'ENTRY_NOT_FOUND', '行号不属于这张凭证即拒')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 1, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act }), 'CF_ITEM_ON_CASH_ENTRY', '现金类科目的分录不允许标记（标的是对手方那一笔）')
    // 行号就是 `voucher_entries.seq`；`seq` 这个键也收（凭证详情接口里就叫这个名字）
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ seq: 1, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act }), 'CF_ITEM_ON_CASH_ENTRY', '用 seq 代替 line_no 也认得（不会当成"行号非法"）')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'NO_SUCH_ITEM' }], actor: act }), 'CF_ITEM_NOT_FOUND', '字典里没有的项目即拒（否则静默退回分析）')
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_TAX_REFUND' }, { line_no: 2, cash_flow_item: 'CFI_SALES_GOODS' }], actor: act }), 'DUPLICATE_LINE_NO', '同一个行号在一批里出现两次即拒（批次级错误不能被逐条校验盖住）')
    mig.prepare("UPDATE cash_flow_items SET status='inactive' WHERE code='CFI_BORROW_IN'").run()
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_BORROW_IN' }], actor: act }), 'CF_ITEM_INACTIVE', '停用的项目不能再标到新分录上')
    mig.prepare("UPDATE cash_flow_items SET status='active' WHERE code='CFI_BORROW_IN'").run()

    // 至此第 2 行仍为空；第一次标记（空白分录）**不需要**理由 —— 危险是差分驱动的
    eq('第一次标空白分录不需要理由', R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act }).changed.length, 1)
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: null }], actor: act }), 'CF_TAG_REASON_REQUIRED', '清除一条已经标过的标记必须写理由')
    const noop = R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_TAX_REFUND' }], actor: act })
    eq('重复标同一个值 = 空操作（既不改库，也不要理由）', [noop.changed.length, noop.unchanged], [0, 1])
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_SALES_GOODS' }], actor: act }), 'CF_TAG_REASON_REQUIRED', '把一笔已定性的钱改到别的项目必须写理由')
    eq('写了理由就改得动，并回报改动前后', R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_SALES_GOODS' }], reason: '重分类', actor: act }).changed, [{ line_no: 2, from: 'CFI_TAX_REFUND', to: 'CFI_SALES_GOODS' }])
    eq('带理由清除标记', R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: null }], reason: '标错了', actor: act }).changed, [{ line_no: 2, from: 'CFI_SALES_GOODS', to: null }])
    // 清除之后 V1 整张回到分析填列（100 回到销售收现），只剩 V2 那一条标记
    rep = R.computeReport(mig, { reportCode: 'cf', period: PK })
    eq('清除之后这张凭证回到分析填列（V1 的 100 回到销售收现，与 V2 的 320 合并）', [rep.cash.tagged_count, rep.cash.tagged_vouchers, rep.cash.untagged_count, amtOf(rep, 'CF_SALES_CASH'), amtOf(rep, 'CF_OTHER_OP_IN')], [1, 1, 2, 420, 0])
    mig.prepare("UPDATE vouchers SET status='voided' WHERE id=?").run(V1)
    throws(() => R.tagVoucherCashFlow(mig, { voucherId: V1, entries: [{ line_no: 2, cash_flow_item: 'CFI_SALES_GOODS' }], actor: act }), 'VOUCHER_VOIDED', '已作废凭证不允许改标记（它不计入任何报表）')
    mig.prepare("UPDATE vouchers SET status='posted' WHERE id=?").run(V1)

    // 没有 041 的库：明确拒绝，而不是悄悄不生效
    throws(() => R.listCashFlowItems(raw), 'CF_ITEM_UNSUPPORTED', '没有 041 的库上取字典明确拒绝（不返回空数组假装"字典是空的"）')
    throws(() => R.cashFlowItemMeta(raw), 'CF_ITEM_UNSUPPORTED', '没有 041 的库上取元数据同样明确拒绝')
    const anyVoucher = raw.prepare("SELECT id FROM vouchers WHERE status='posted' LIMIT 1").get()
    if (anyVoucher) {
      throws(() => R.tagVoucherCashFlow(raw, { voucherId: anyVoucher.id, entries: [{ line_no: 1, cash_flow_item: 'CFI_SALES_GOODS' }], actor: act }), 'CF_ITEM_UNSUPPORTED', '没有 041 的库上打标记明确拒绝（不静默）')
    }

    // =======================================================================
    section(`U6 收尾：一行都不多（${ind}）`)
    // =======================================================================
  } finally {
    mig.exec('ROLLBACK')
  }

  const after = {
    vouchers: mig.prepare('SELECT COUNT(*) c FROM vouchers').get().c,
    entries: mig.prepare('SELECT COUNT(*) c FROM voucher_entries').get().c,
    items: mig.prepare('SELECT COUNT(*) c FROM cash_flow_items').get().c,
    lines: mig.prepare('SELECT COUNT(*) c FROM report_lines').get().c,
    perms: mig.prepare("SELECT COUNT(*) c FROM role_permissions WHERE perm_code LIKE 'finance.cashflow.item.%'").get().c
  }
  eq('测试凭证一行都没留下（全部活在事务里）', after.vouchers - before.vouchers, 0)
  eq('测试分录一行都没留下', after.entries - before.entries, 0)
  eq('现金流量项目字典一条都没变', after.items - before.items, 0)
  eq('报表口径行一行都没变', after.lines - before.lines, 0)
  eq('权限授予一行都没变', after.perms - before.perms, 0)
  ok(!mig.prepare("SELECT 1 FROM vouchers WHERE doc_no LIKE '__test_cfitem__%'").get(), '自造凭证按单号也查不到')
  eq('自造期间没有留下期间记录', mig.prepare('SELECT COUNT(*) c FROM accounting_periods WHERE period=?').get(PK).c, 0)
  if (busy) {
    const fin = R.auditReport(mig, { period: busy })
    ok(fin.ok, '收尾：演示库报表自证仍然通过（没被测试改坏）', JSON.stringify(fin.problems.map((p) => p.code)))
  }

  raw.close()
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`现金流量项目辅助核算（实跑 ${ran.length ? ran.join('/') : '没有库跑到'}）：通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  failures.forEach((f) => console.log(`  - ${f}`))
}
try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* 临时目录删不掉不影响结论 */
}
process.exit(fail === 0 ? 0 : 1)
