'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/034_report.cjs ｜ 迁移：报表体系（资产负债表 / 利润表 / 现金流量表 / 会计期间 / 期初余额）
 * ============================================================================
 * 【职责】迁移：报表体系（资产负债表 / 利润表 / 现金流量表 / 会计期间 / 期初余额）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 034 报表体系（资产负债表 / 利润表 / 现金流量表 + 会计期间与期初余额）
//
// ===========================================================================
// 一、这一批补的是「账记了，但读不出来」
// ===========================================================================
// 批次 H 把业务事实变成了借贷平衡的凭证，批次 13/14 把它做成了可审计的。
// 但整条链上**只有一张试算平衡表** —— 它能回答"总账平不平"，
// 回答不了经营者真正要问的三句话：
//   · **我这家公司现在有多少家底**（资产 / 负债 / 所有者权益）
//   · **这段期间赚了多少**（收入 / 成本 / 费用 / 利润）
//   · **钱到底是怎么来的、花到哪去了**（经营 / 投资 / 筹资）
//
// ===========================================================================
// 二、四条硬口径（都在表结构、lib/report.js 与 verify() 里体现）
// ===========================================================================
// ① **报表结构是会计政策，不是代码**。
//    「货币资金 = 1001 + 1002」「营业成本 = 6401」这类映射由人来定，
//    而且要能被审计、被追溯改过什么。所以它入库（`report_lines`），
//    与 `voucher_templates` 同一个道理：能改的东西不该写死在 if 里。
//
// ② **小计行不能自由写表达式**。`subtotal_expr` 只允许「行号 + `+`/`-`」，
//    如 `'1+2+3-4'`。这与凭证模板的 `amount_key` 只能取封闭字典是同一个理由：
//    可被界面编辑的配置**一旦能写表达式，就等于配置能改账**。
//    不允许 `*`、`/`、括号、函数调用、字段引用。
//
// ③ **期初余额按借贷两列存，不存一个带符号的数**。
//    理由与试算平衡表的 `balance_side` 一致：余额方向由科目自身的 `direction`
//    决定（负债类与资产类相反），用一个 signed 数存下来，
//    读出来的人就得先知道"这个数是按谁的方向算的" —— 而这正是把负债读成负数的来源。
//    两列存法还能表达「资产科目出现贷方余额」这种异常（不该发生，但要能表达出来）。
//
// ④ **关账之后不能再过账**（`accounting_periods.status='closed'`）。
//    这是"期间"这个概念唯一的落点：没有它，"9 月的报表"会随着 10 月做事而改变。
//    **只拦过账，不拦生成** —— 生成出来的 `draft` 不计入任何报表，
//    拦它只会让"先录单、后开账"这条正常流程走不通。
//
// ===========================================================================
// 三、为什么资产负债表一定会平（这条不变量是报表域的自证）
// ===========================================================================
// 记 `signed(科目)` = 借方余额为正、贷方余额为负。
// 因为每张凭证"借方合计 = 贷方合计"，把所有已过账分录按科目汇总后
// **Σ signed(科目) 恒等于 0**。于是：
//     Σ资产 = −Σ(负债 + 权益 + 损益) = 负债 + 权益 + 损益
// ⇒ **只要借贷是平的，资产 = 负债 + 所有者权益 就必然成立**，
// 与科目余额的大小无关。
//
// 这条恒等式给了我们两件东西：
//   · **一个判定没做到位的探针**：报表不平只可能有两个原因 ——
//     期初余额本身不平，或**报表行漏了某个科目**（那个科目的余额没被任何一行认领）。
//     后者是配置错误里最隐蔽的一种（报表看起来很好看，就是差一个数），
//     所以 `lib/report.js` 的 `auditReport` 会专门把"没人认领的科目"报出来。
//   · **一个不依赖人工核对的验收口径**。
//
// ===========================================================================
// 四、现金流量表的算法与它的自证
// ===========================================================================
// 系统**没有做期末结转**，也没有"现金流量项目"这种辅助核算，
// 所以现金流量表只能从凭证本身**分析**出来（这正是它叫"现金流量表（分析填列）"的原因）。
//
// 算法（逐张凭证）：
//   · 现金类科目集合由 `report_defs.cash_subjects` 配置（默认 1001,1002）；
//   · 记 cashDebit / cashCredit = 该凭证里现金类科目的借 / 贷合计，
//     otherDebit / otherCredit = 非现金分录的借 / 贷合计；
//   · **单边配对**（非现金分录方向单一且金额正好对上）：
//       非现金 credit 是现金的**来源**（+），非现金 debit 是现金的**用途**（−），
//       逐条按其**对手科目**匹配报表行；
//   · **复合凭证**（现金与非现金在多条线上交叉）走**净额法**：
//       净额 `cashDebit − cashCredit` 归到兜底行，并**如实计数**回报，
//       不假装它被精确归了类。
//
// 自证恒等式（`Σ 现金流量表各行 = 现金类科目净变动`）：
//   凭证平衡 ⇒ cashDebit + otherDebit = cashCredit + otherCredit
//            ⇒ otherCredit − otherDebit = cashCredit − cashDebit
//   左边就是填进报表的全部金额，右边就是现金类科目的净变动（期末 − 期初）。
//   **两种填列法都满足它** —— 净额法只是把同一笔总额放到了兜底行。
//   所以这条恒等式同时也是"现金期初余额登记得对不对"的探针。
//
// ===========================================================================
// 五、与现有单据内核的关系
// ===========================================================================
// 本批**不新增单据类型**（报表是只读产物，不是单据），也不改内核。
// 唯一碰到既有链路的是 `postVoucher`（关账拦截），已在 lib 侧写明理由。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef } = require('./_helpers.cjs')

module.exports.name = '报表体系（资产负债表 / 利润表 / 现金流量表 / 会计期间 / 期初余额）'

const TABLES = [
  {
    name: 'report_defs',
    sql: `CREATE TABLE IF NOT EXISTS report_defs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      report_code   TEXT NOT NULL UNIQUE,              -- bs / pl / cf
      name          TEXT NOT NULL,
      basis         TEXT NOT NULL,                     -- balance（期末余额）/ amount（本期发生额）/ cash_flow（现金收支）
      cash_subjects TEXT,                              -- 仅 cash_flow：现金类科目码，逗号分隔
      -- **必须穷尽覆盖**的科目大类（逗号分隔）。空 = 不做覆盖检查。
      -- 为什么是配置而不是代码里的 if：资产负债表要覆盖全部科目（它是"家底"的完整表述，
      -- 少一个科目就少一块钱），而利润表只需要覆盖损益类（资产科目本来就不该进利润表）。
      -- 把它写成代码里的 if (basis === 'balance')，等于把会计政策钉死在实现里。
      cover_categories TEXT,
      remark        TEXT,
      status        TEXT NOT NULL DEFAULT 'active',    -- active / disabled
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  },
  {
    name: 'report_lines',
    sql: `CREATE TABLE IF NOT EXISTS report_lines (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      report_code   TEXT NOT NULL,                     -- 指向 report_defs.report_code
      line_code     TEXT NOT NULL,                     -- 机器键（'BS_ASSETS_TOTAL'）：**报表自证按它找行**，不按中文名
      line_no       INTEGER NOT NULL,                  -- 行号：小计表达式按它引用（不是显示行次）
      display_no    TEXT,                              -- 显示用行次（"一" / "1"），可空
      line_name     TEXT NOT NULL,
      line_type     TEXT NOT NULL,                     -- item（科目区间行）/ subtotal（小计）/ total（合计）
      level         INTEGER NOT NULL DEFAULT 1,        -- 缩进层级，只影响观感
      -- item 行认领的科目码闭区间，**一段或多段**：'1122~1122|2203~2203'。
      -- 为什么要多段：现金流量表的一行常常对应**几个互不相邻的对手科目**
      -- （"销售商品收到的现金" = 应收 1122 + 预收 2203 + 收入 6001 + 销项税 222101）。
      -- 只给一个区间的话，要么拆成几行同名（界面上重复出现，像 bug），
      -- 要么把中间的科目一起圈进来（把"预付账款"算进"销售收现"）—— 两者都是在配置里撒谎。
      subject_range TEXT,
      sign          INTEGER NOT NULL DEFAULT 1,        -- +1 / −1，作用于本行金额（方向口径，见 lib/report.js）
      -- 仅现金流量表的 item 行使用：只接**流入（credit）**或只接**流出（debit）**。
      -- 同一个科目在两个方向上语义不同（借 222101 是"缴税流出"，贷 222101 是"随货款代收的销项税"），
      -- 只靠科目区间无法区分 —— 这一列就是那个区分。
      only_direction TEXT,                             -- credit / debit / NULL（不限）
      subtotal_expr TEXT,                              -- subtotal/total 行：形如 '1+2+3-4'（只允许行号与 +−）
      is_fallback   INTEGER NOT NULL DEFAULT 0,        -- 兜底行：只在其它行都不认领时才接（必须排在最前被排除）
      order_no      INTEGER NOT NULL DEFAULT 0,
      remark        TEXT,
      UNIQUE (report_code, line_no),
      UNIQUE (report_code, line_code)
    )`
  },
  {
    name: 'accounting_periods',
    sql: `CREATE TABLE IF NOT EXISTS accounting_periods (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      period         TEXT NOT NULL UNIQUE,             -- 'YYYY-MM'
      status         TEXT NOT NULL DEFAULT 'open',     -- open / closed
      closed_by      INTEGER,
      closed_by_name TEXT,
      closed_at      TEXT,
      reopen_reason  TEXT,                             -- 反关账必须写理由
      remark         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  },
  {
    name: 'accounting_opening_balances',
    sql: `CREATE TABLE IF NOT EXISTS accounting_opening_balances (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      period         TEXT NOT NULL,                    -- 这是"哪个期间的期初"
      subject_id     INTEGER NOT NULL,
      subject_code   TEXT NOT NULL,
      debit_amount   REAL NOT NULL DEFAULT 0,          -- 借方余额
      credit_amount  REAL NOT NULL DEFAULT 0,          -- 贷方余额
      remark         TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (period, subject_id)
    )`
  }
]

const INDEXES = [
  { name: 'idx_report_lines_code', sql: 'CREATE INDEX IF NOT EXISTS idx_report_lines_code ON report_lines (report_code, order_no, line_no)' },
  { name: 'idx_report_lines_subject', sql: 'CREATE INDEX IF NOT EXISTS idx_report_lines_subject ON report_lines (report_code, line_no)' },
  { name: 'idx_opening_period', sql: 'CREATE INDEX IF NOT EXISTS idx_opening_period ON accounting_opening_balances (period, subject_code)' },
  { name: 'idx_vouchers_period_status', sql: 'CREATE INDEX IF NOT EXISTS idx_vouchers_period_status ON vouchers (period, status)' }
]

// 权限点：**看报表**与**改报表口径**必须分开授权。
// 报表行定义决定"哪些科目算进哪一行"，改它能让同一份账得出不同的利润 ——
// 这是会计政策，不是展示配置。
// 期间关账与期初余额各自单独授权：关账会挡住记账，期初余额会改变每一张报表。
const PERMS = [
  ['finance.report.view', '查看财务报表', 'finance', '查看'],
  ['finance.report.config', '维护报表口径', 'finance', '编辑'],
  ['finance.period.close', '会计期间关账/反关账', 'finance', '审核'],
  ['finance.opening.edit', '维护期初余额', 'finance', '编辑']
]

const ROLE_GRANTS = {
  admin: ['finance.report.view', 'finance.report.config', 'finance.period.close', 'finance.opening.edit'],
  boss: ['finance.report.view'],
  finance: ['finance.report.view', 'finance.period.close', 'finance.opening.edit']
}

module.exports.up = function up(db) {
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5900)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  }
  stampDef(db, '034_report', def)
  return { tables: TABLES.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量一：报表行的类型只有三种取值
  if (tableExists(db, 'report_lines')) {
    const badType = db
      .prepare("SELECT COUNT(*) c FROM report_lines WHERE line_type NOT IN ('item','subtotal','total')")
      .get().c
    if (badType > 0) return false
    // 不变量二：`sign` 只能是 ±1（写 0 会让一行"悄悄不参与合计"）
    const badSign = db.prepare('SELECT COUNT(*) c FROM report_lines WHERE sign NOT IN (1,-1)').get().c
    if (badSign > 0) return false
    // 不变量三：item 行必须有科目区间；subtotal/total 行必须有表达式
    const badItem = db
      .prepare("SELECT COUNT(*) c FROM report_lines WHERE line_type='item' AND (subject_range IS NULL OR TRIM(subject_range)='')")
      .get().c
    if (badItem > 0) return false
    const badSub = db
      .prepare("SELECT COUNT(*) c FROM report_lines WHERE line_type IN ('subtotal','total') AND (subtotal_expr IS NULL OR TRIM(subtotal_expr)='')")
      .get().c
    if (badSub > 0) return false
    // 不变量三之二：科目区间的每一段都必须是 `起~止` 且起 ≤ 止
    // （区间写反不会报错，只会让那一行的金额**永远是 0** —— 报表看起来只是"这一项没有"）
    for (const r of db.prepare("SELECT subject_range FROM report_lines WHERE line_type='item'").all()) {
      for (const seg of String(r.subject_range || '').split('|')) {
        const m = /^\s*(\d{4,8})\s*~\s*(\d{4,8})\s*$/.exec(seg)
        if (!m) return false
        if (m[1] > m[2]) return false
      }
    }
    // 不变量三之三：方向过滤只有两种取值
    const badDir = db
      .prepare("SELECT COUNT(*) c FROM report_lines WHERE only_direction IS NOT NULL AND only_direction NOT IN ('credit','debit')")
      .get().c
    if (badDir > 0) return false
    // 不变量三之四：**一张报表只能有一个兜底行** ——
    // 两个兜底行不会报错，只会让"没人认领的科目"被**任意一个**接走（谁在前谁接），
    // 于是同一份账两次查询得到不同的报表，且没有任何东西会告诉你。
    const dupFallback = db
      .prepare('SELECT COUNT(*) c FROM (SELECT report_code FROM report_lines WHERE is_fallback=1 GROUP BY report_code HAVING COUNT(*) > 1)')
      .get().c
    if (dupFallback > 0) return false
    // 不变量四：小计表达式只能引用**同一张报表里真实存在的行号**，且只含数字与 +−
    const rows = db.prepare("SELECT report_code, line_no, subtotal_expr FROM report_lines WHERE line_type IN ('subtotal','total')").all()
    for (const r of rows) {
      const expr = String(r.subtotal_expr || '')
      if (!/^\s*\d+(\s*[+-]\s*\d+)*\s*$/.test(expr)) return false
      const refs = expr.split(/[+-]/).map((s) => Number(s.trim()))
      for (const no of refs) {
        const hit = db.prepare('SELECT 1 AS hit FROM report_lines WHERE report_code=? AND line_no=?').get(r.report_code, no)
        if (!hit) return false
      }
    }
  }
  // 不变量五：报表定义的 basis 只有三种取值
  if (tableExists(db, 'report_defs')) {
    const badBasis = db.prepare("SELECT COUNT(*) c FROM report_defs WHERE basis NOT IN ('balance','amount','cash_flow')").get().c
    if (badBasis > 0) return false
    // 不变量五之二：`cover_categories` 只能取科目大类里的值
    // （拼错的类别名会让覆盖检查**永远通过** —— 那正好是它存在的理由）
    const cats = ['asset', 'liability', 'equity', 'cost', 'profit_loss']
    for (const r of db.prepare("SELECT report_code, cover_categories FROM report_defs WHERE cover_categories IS NOT NULL AND TRIM(cover_categories) <> ''").all()) {
      for (const c of String(r.cover_categories).split(',').map((s) => s.trim()).filter(Boolean)) {
        if (!cats.includes(c)) return false
      }
    }
  }
  // 不变量六：期间状态只有两种取值
  if (tableExists(db, 'accounting_periods')) {
    const badStatus = db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE status NOT IN ('open','closed')").get().c
    if (badStatus > 0) return false
    // 期间格式必须是 YYYY-MM（写错格式不会报错，只会让报表"这个月一片空白"）
    const badFmt = db.prepare("SELECT COUNT(*) c FROM accounting_periods WHERE period NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'").get().c
    if (badFmt > 0) return false
  }
  // 不变量七：期初余额的金额非负（方向由借贷两列表达，不靠符号）
  if (tableExists(db, 'accounting_opening_balances')) {
    const neg = db
      .prepare('SELECT COUNT(*) c FROM accounting_opening_balances WHERE debit_amount < 0 OR credit_amount < 0')
      .get().c
    if (neg > 0) return false
  }
  return true
}
