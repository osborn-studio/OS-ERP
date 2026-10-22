'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/041_cash_flow_item.cjs ｜ 迁移：现金流量项目辅助核算（项目字典 + 分录上的项目标记）
 * ============================================================================
 * 【职责】迁移：现金流量项目辅助核算（项目字典 + 分录上的项目标记）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 041 现金流量项目辅助核算（项目字典 + 分录上的项目标记）
//
// ===========================================================================
// 一、这一批补的是「现金流量表只能靠猜对手科目」
// ===========================================================================
// 034 把三张报表做出来了，但现金流量表是**分析填列**：拿凭证里非现金那几笔的
// 对手科目去套报表行的科目区间。这在单边凭证上够用，到了复合凭证就只能
// 把净额扔进兜底行（"其他（未能归类的现金收支）"）。
// 于是"经营活动到底收了多少现金"这句话，答案是**推出来的**而不是**记下来的**。
//
// 这一批把「现金流量项目」做成一个**跨科目的独立维度**：
// 分录上标一个项目 code（`voucher_entries.cash_flow_item`），归集时优先按它走。
//
// ===========================================================================
// 二、为什么是「一张字典表 + 分录上一列」，而不是往科目表加一个 aux_type 取值
// ===========================================================================
// `accounting_subjects.aux_type` 已经承载了"这个科目要挂客户还是供应商"，
// 那是**挂在某个科目上的**属性。而现金流量项目是**跨科目**的：
// 同一个「销售商品、提供劳务收到的现金」要能同时落在应收账款 / 预收账款 /
// 主营业务收入 / 应交增值税-销项税额 上。
// 把它做成科目上的枚举，等于每加一个报表项目就改一次科目表结构，
// 而科目表是主数据 —— 主数据不该因为报表口径而变。
//
// ===========================================================================
// 三、`report_line_code`：项目 → 报表行的落点，是**显式的一列**
// ===========================================================================
// 项目比报表行**细**（22 个内置项 → 现金流量表 10 个科目行），所以"同 code 对应"
// 这条路走不通，必须显式写下落点。于是：
//   · `report_line_code` 为空 ⇒ 这个项目只登记、暂不落到某一行（标了它等于没标，
//     归集会退回按对手科目分析，并且**如实计数** `tagged_unresolved_count`）；
//   · 填写 ⇒ 归集时按标记**直接落到那一行**，不再看对手科目。
// 为什么要显式而不是靠 code 命名约定：报表行可以被人在界面上改（`finance.report.config`），
// 改完名字之后靠约定匹配就会**静默错行** —— 而报表看起来完全正常。
//
// ===========================================================================
// 四、为什么不把存量凭证一次性回填标记
// ===========================================================================
// 回填只能靠"分析填列"再写回去 —— 那等于把**推测**固化成**事实**，
// 而且之后再也分不清哪一条是推的、哪一条是记的。
// 所以存量凭证一律**不打标记**，归集时自然走回落路径（结果与加这一维之前逐字节相同），
// 由会计在需要的时候逐张补标 —— `cashFlowBuckets` 的 `tagged_count` / `untagged_count`
// 就是把"多少是记的、多少是推的"如实报出来的那两个数。
//
// ===========================================================================
// 五、权限点
// ===========================================================================
// `finance.cashflow.item.view` / `finance.cashflow.item.edit`。
// 打标记会改变现金流量表**每一行**的金额，所以它与"看报表"分开；
// 但它与"改报表口径"（`finance.report.config`）**不是一件事** ——
// 口径是会计政策（偶尔改），打标记是日常动作（每张涉现金的凭证都要做）。
// 两者合成一个权限点，结果只会是"日常动作没人有权做"。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '现金流量项目辅助核算（项目字典 + 分录上的项目标记）'

// ---------------------------------------------------------------------------
// 现金流量项目字典
// ---------------------------------------------------------------------------
// 代码（`code`）是机器键：一旦有分录标了它，改它就等于**抹掉那一批标记**
// （标记是按 code 存的）。所以内置项在下游被引用之后只应改名、不应改码。
// 名字按中国会计准则现金流量表的正式项目取名，**行业中性**：
// 不出现任何真实客户名 / 品牌名 / 供应商名（金额相关的行尤其不能）。
// ---------------------------------------------------------------------------
const ITEM_SQL = `
  CREATE TABLE IF NOT EXISTS cash_flow_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL UNIQUE,               -- 机器键（分录上的标记按它匹配）
    name             TEXT NOT NULL,                      -- 报表项目名
    category         TEXT NOT NULL,                      -- operating / investing / financing
    direction        TEXT NOT NULL DEFAULT 'both',       -- in / out / both
    is_builtin       INTEGER NOT NULL DEFAULT 0,         -- 内置项不可删（verify 会把它救回来）
    report_line_code TEXT,                               -- 落到现金流量表的哪一行（为 NULL = 只登记不落地）
    sort_no          INTEGER NOT NULL DEFAULT 100,
    status           TEXT NOT NULL DEFAULT 'active',     -- active / inactive
    remark           TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`

const TABLES = [
  { name: 'cash_flow_items', sql: ITEM_SQL }
]

const INDEXES = [
  { name: 'idx_cfi_category', sql: 'CREATE INDEX IF NOT EXISTS idx_cfi_category ON cash_flow_items (category, sort_no)' },
  { name: 'idx_cfi_status', sql: 'CREATE INDEX IF NOT EXISTS idx_cfi_status ON cash_flow_items (status)' },
  // 分录上的项目标记：反查"这个项目这个月标了哪些分录"走它
  { name: 'idx_voucher_entry_cfitem', sql: 'CREATE INDEX IF NOT EXISTS idx_voucher_entry_cfitem ON voucher_entries (cash_flow_item)' }
]

// 加列（不是加表）：**存量分录一律为空** —— 空 = 没有标记 = 走回落路径。
// `addColumn` 自带幂等（列已存在则跳过），且表不存在时会**报错**而不是静默忽略。
const NEW_COLUMNS = [
  ['voucher_entries', 'cash_flow_item', 'TEXT']
]

// ---------------------------------------------------------------------------
// 内置项目（22 条 · 三大类齐全）
// ---------------------------------------------------------------------------
// `report_line_code` 指向 `report-seed.js` 里现金流量表的行号键：
//   经营 CF_SALES_CASH / CF_OTHER_OP_IN / CF_PURCHASE_CASH / CF_PAYROLL_CASH /
//        CF_TAX_CASH / CF_OTHER_OP_OUT
//   投资 CF_INVEST_IN / CF_INVEST_OUT      筹资 CF_FINANCE_IN / CF_FINANCE_OUT
// 指向一个**已经不存在**的行是允许发生的（行可以被界面删掉）——
// 那时标记落不到行上，归集会退回分析并计入 `tagged_unresolved_count`，不静默丢账。
// ---------------------------------------------------------------------------
const BUILTIN_ITEMS = [
  // ---- 经营活动 ----
  { code: 'CFI_SALES_GOODS', name: '销售商品、提供劳务收到的现金', category: 'operating', direction: 'in', line: 'CF_SALES_CASH', sort: 110 },
  { code: 'CFI_ADVANCE_IN', name: '收到的预收货款', category: 'operating', direction: 'in', line: 'CF_SALES_CASH', sort: 120, remark: '预收货款也是"卖货收的钱"，与销售收现同一行（它只是收款时点更早）' },
  { code: 'CFI_TAX_REFUND', name: '收到的税费返还', category: 'operating', direction: 'in', line: 'CF_OTHER_OP_IN', sort: 130 },
  { code: 'CFI_OTHER_OP_IN', name: '收到的其他与经营活动有关的现金', category: 'operating', direction: 'in', line: 'CF_OTHER_OP_IN', sort: 140 },
  { code: 'CFI_BUY_GOODS', name: '购买商品、接受劳务支付的现金', category: 'operating', direction: 'out', line: 'CF_PURCHASE_CASH', sort: 150 },
  { code: 'CFI_PREPAY_OUT', name: '预付货款支付的现金', category: 'operating', direction: 'out', line: 'CF_PURCHASE_CASH', sort: 160, remark: '预付货款也是"买货花的钱"，与购货付现同一行' },
  { code: 'CFI_PAYROLL', name: '支付给职工以及为职工支付的现金', category: 'operating', direction: 'out', line: 'CF_PAYROLL_CASH', sort: 170 },
  { code: 'CFI_TAX_PAY', name: '支付的各项税费', category: 'operating', direction: 'out', line: 'CF_TAX_CASH', sort: 180 },
  { code: 'CFI_OTHER_OP_OUT', name: '支付的其他与经营活动有关的现金', category: 'operating', direction: 'out', line: 'CF_OTHER_OP_OUT', sort: 190 },
  { code: 'CFI_REFUND_OUT', name: '退还客户款项支付的现金', category: 'operating', direction: 'out', line: 'CF_OTHER_OP_OUT', sort: 200, remark: '退的是客户多付的钱（负债减少），不是采购付款' },
  // ---- 投资活动 ----
  { code: 'CFI_INVEST_BACK', name: '收回投资收到的现金', category: 'investing', direction: 'in', line: 'CF_INVEST_IN', sort: 310 },
  { code: 'CFI_INVEST_INCOME', name: '取得投资收益收到的现金', category: 'investing', direction: 'in', line: 'CF_INVEST_IN', sort: 320 },
  { code: 'CFI_DISPOSE_ASSET', name: '处置固定资产、无形资产和其他长期资产收回的现金净额', category: 'investing', direction: 'in', line: 'CF_INVEST_IN', sort: 330 },
  { code: 'CFI_OTHER_INVEST_IN', name: '收到的其他与投资活动有关的现金', category: 'investing', direction: 'in', line: 'CF_INVEST_IN', sort: 340 },
  { code: 'CFI_BUILD_ASSET', name: '购建固定资产、无形资产和其他长期资产支付的现金', category: 'investing', direction: 'out', line: 'CF_INVEST_OUT', sort: 350 },
  { code: 'CFI_INVEST_PAY', name: '投资支付的现金', category: 'investing', direction: 'out', line: 'CF_INVEST_OUT', sort: 360 },
  // ---- 筹资活动 ----
  { code: 'CFI_EQUITY_IN', name: '吸收投资收到的现金', category: 'financing', direction: 'in', line: 'CF_FINANCE_IN', sort: 510 },
  { code: 'CFI_BORROW_IN', name: '取得借款收到的现金', category: 'financing', direction: 'in', line: 'CF_FINANCE_IN', sort: 520 },
  { code: 'CFI_OTHER_FIN_IN', name: '收到的其他与筹资活动有关的现金', category: 'financing', direction: 'in', line: 'CF_FINANCE_IN', sort: 530 },
  { code: 'CFI_REPAY_DEBT', name: '偿还债务支付的现金', category: 'financing', direction: 'out', line: 'CF_FINANCE_OUT', sort: 540 },
  { code: 'CFI_DIVIDEND_PAY', name: '分配股利、利润或偿付利息支付的现金', category: 'financing', direction: 'out', line: 'CF_FINANCE_OUT', sort: 550 },
  { code: 'CFI_OTHER_FIN_OUT', name: '支付的其他与筹资活动有关的现金', category: 'financing', direction: 'out', line: 'CF_FINANCE_OUT', sort: 560 }
]

// 项目码是机器键，**必须唯一** —— 重复码在 seed 阶段会静默互相覆盖，
// 表现成"字典里少了一项"而不是报错。
const DUP_CODES = BUILTIN_ITEMS.map((i) => i.code).filter((c, i, all) => all.indexOf(c) !== i)

const PERMS = [
  ['finance.cashflow.item.view', '查看现金流量项目', 'finance', '查看', 5910],
  ['finance.cashflow.item.edit', '维护现金流量项目标记', 'finance', '编辑', 5920]
]
// 授予口径对齐 034：`view` 跟着 `finance.report.view`（admin / boss / finance），
// `edit` 只给 admin 与 finance —— 打标记改的是报表金额，账上做账的人才有这个判断。
// **刻意不给 viewer / dealer / store**：它们连报表都看不到。
const ROLE_GRANTS = {
  'finance.cashflow.item.view': ['admin', 'boss', 'finance'],
  'finance.cashflow.item.edit': ['admin', 'finance']
}

module.exports.up = function up(db) {
  if (DUP_CODES.length) throw new Error(`内置现金流量项目码重复：${DUP_CODES.join(', ')}`)
  if (!tableExists(db, 'voucher_entries')) {
    throw new Error('voucher_entries 不存在，迁移顺序有误（应由 032_voucher 先建）')
  }

  for (const t of TABLES) db.exec(t.sql)
  for (const [t, c, decl] of NEW_COLUMNS) addColumn(db, t, c, decl)
  for (const ix of INDEXES) db.exec(ix.sql)

  // 内置项：**以定义为准** —— `ON CONFLICT(code) DO UPDATE` 让 up 幂等，
  // 也让"定义改了 / 库里的内置项被写坏了"在**下一次启动收敛回定义那一份**。
  //
  // ⚠️ 为什么"覆盖"是安全的（**当前前提，必须随代码一起复核**）：
  //    全仓 `cash_flow_items` 的**唯一写手就是本迁移**（`server/routes/report.js` 只有读的入口、
  //    前端没有字典维护页、`seed.js` 只是把它登记进重建清单）⇒ 这几列今天**不可能**是"人改过的值"，
  //    覆盖它们不违背"不覆盖人的选择"这条语义。
  //    **将来的边界**：哪天加了"现金流量项目字典维护"界面，必须先加 `user_modified` 之类的开关
  //    （否则人工改名/改排序会被每次启动抹回定义值）—— 那时这一句要先被改掉。
  //    ⚠️ 反过来说：**没有这段注释就改不回 `INSERT OR IGNORE`**。`OR IGNORE` 恰恰不修已存在的行，
  //    而 `verify()` 现在要求"定义 = 库"（不变量三之二：方向与落点逐条一致）——
  //    两边必须能同时满足，upsert 是唯一合理解。
  //
  // 只覆盖**定义性**列（定义里带着的那几列）；`status` / `remark` 不动 ——
  // 它们是"人的选择"的描述面（停用 / 备注），与本条要收敛的"定义漂移"不是同一件事。
  const insItem = db.prepare(
    `INSERT INTO cash_flow_items
       (code, name, category, direction, is_builtin, report_line_code, sort_no, status, remark)
     VALUES (?,?,?,?,1,?,?,'active',?)
     ON CONFLICT(code) DO UPDATE SET
       name             = excluded.name,
       category         = excluded.category,
       direction        = excluded.direction,
       report_line_code = excluded.report_line_code,
       sort_no          = excluded.sort_no,
       is_builtin       = 1,
       updated_at       = datetime('now','localtime')`
  )
  for (const it of BUILTIN_ITEMS) {
    insItem.run(it.code, it.name, it.category, it.direction, it.line || null, it.sort, it.remark || null)
  }

  if (tableExists(db, 'permissions')) {
    for (const [code, name, module, category, sort] of PERMS) {
      db.prepare(
        `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
         ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
      ).run(code, name, module, category, sort)
    }
    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [perm, roles] of Object.entries(ROLE_GRANTS)) {
        for (const role of roles) {
          if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
          insRole.run(role, perm)
        }
      }
    }
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0]),
    // 内置项目的 code 清单**必须进指纹**：往定义里加一条项目时，指纹变化 ⇒
    // runner 判为脱节并重跑 up（幂等）⇒ 新项目自动落库。
    // 不放进来的话，加项目只会在代码里生效，库里的字典永远停在旧的那一份，
    // 而表现是"下拉里没有这个项目"——不报错、只是功能莫名少一个。
    items: BUILTIN_ITEMS.map((i) => i.code)
  }
  stampDef(db, '041_cash_flow_item', def)
  return {
    tables: TABLES.length,
    columns: NEW_COLUMNS.length,
    indexes: INDEXES.length,
    items: BUILTIN_ITEMS.length
  }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  for (const [t, c] of NEW_COLUMNS) if (!hasColumn(db, t, c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量一：取值域。写进一个 'ok2' 不会报错，但"这个项目是经营还是投资"从此没有确定答案，
  // 界面按类别分组时会**少一组** —— 而少的那一组看起来只是"这个类别没有项目"。
  const badCat = db
    .prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE category NOT IN ('operating','investing','financing')")
    .get().c
  if (badCat > 0) return false
  const badDir = db
    .prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE direction NOT IN ('in','out','both')")
    .get().c
  if (badDir > 0) return false
  const badStatus = db
    .prepare("SELECT COUNT(*) c FROM cash_flow_items WHERE status NOT IN ('active','inactive')")
    .get().c
  if (badStatus > 0) return false

  // 不变量二：**分录上的标记必须句句有出处**。
  // 标了一个字典里没有的项目不会报错，只会让那一笔**静默退回**按对手科目分析填列 ——
  // 而分析出来的行与打标记的人想的不是同一行。
  const unknown = db
    .prepare(`
      SELECT COUNT(*) c FROM voucher_entries
       WHERE cash_flow_item IS NOT NULL AND cash_flow_item <> ''
         AND cash_flow_item NOT IN (SELECT code FROM cash_flow_items)
    `)
    .get().c
  if (unknown > 0) return false

  // 不变量三：内置项**一条都不能少**（`is_builtin` 的语义是"不可删"）。
  // 少了就判为脱节、重跑 up 把它补回来 —— 与 `doc_types` / `member_levels` 同一机制。
  const builtin = db.prepare('SELECT COUNT(*) c FROM cash_flow_items WHERE is_builtin=1').get().c
  if (Number(builtin) !== BUILTIN_ITEMS.length) return false

  // 不变量三之二（批次 U 之四独立复核补强）：内置项的**方向与落点必须与定义一致**。
  //
  // 为什么只查这两列、不查 name / sort_no / status：`up()` 明确写着"只补缺的、不覆盖人改过的"
  // ——改名、排序、停用是**人的选择**，把它们判为脱节会让每次启动都重跑一遍 up（而 up 也改不动它们）。
  // 而方向与落点**不是展示字段**：方向写反会让一笔流出记到**流入行**上（负数），
  // 落点写错会让标记静默落到别的行 —— 两者都**不会让账不平**（取号由分录方向决定、
  // 恒等式照旧成立），所以 `auditReport` 的别的探针一个都不会响。
  //
  // 为什么非得在这里查：定义改了之后，**已经迁移过的库不会重跑 up**（指纹只记 code 清单，
  // 见下面 `def.items` 的注释），于是"库里那份"与"定义那份"从此不一致，
  // 而任何只看库、不看定义的断言都发现不了。逐条对一遍是唯一的发现方式。
  const drift = db
    .prepare('SELECT code, direction, report_line_code FROM cash_flow_items WHERE is_builtin=1')
    .all()
    .filter((r) => {
      const d = BUILTIN_ITEMS.find((i) => i.code === r.code)
      return !d || d.direction !== r.direction || (d.line || null) !== (r.report_line_code || null)
    })
  if (drift.length > 0) return false

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0]),
    items: BUILTIN_ITEMS.map((i) => i.code)
  }
  if (defStale(db, '041_cash_flow_item', def)) return false
  return true
}
