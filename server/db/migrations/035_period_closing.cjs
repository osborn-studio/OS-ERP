'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/035_period_closing.cjs ｜ 迁移：期末结转与结账（损益结转 / 结转留痕 / 结转账从发生额口径中剔除）
 * ============================================================================
 * 【职责】迁移：期末结转与结账（损益结转 / 结转留痕 / 结转账从发生额口径中剔除）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 035 期末结转与结账（损益结转 6xxx → 4103 · 结转留痕 · 结转账从试算口径中剔除）
//
// ===========================================================================
// 一、这一批补的是「账平了，但利润还挂在损益科目上」
// ===========================================================================
// 批次 L 让三张报表算得出来，但它自己在注释里留了一句实话：
//
//     「本系统**没有做期末结转**，损益类科目期末仍有余额。
//       不把它计入权益，资产负债表必然差一个『本期利润』。」
//
// 于是资产负债表上用了一行「未结转损益」（`BS_UNCARRIED_PL`，区间 6001~6999）
// 把 6xxx 的余额兜进所有者权益。**这是权宜之计，不是会计上正确的事**：
//   · 收入科目的贷方余额在账上越积越大（跨年之后 6001 的余额是开业至今的全部收入），
//     而它本该在每个期末被转到 4103 本年利润、把损益科目**归零**；
//   · 没有结转，就答不出"这个月的利润是多少"与"本年累计利润是多少"的**账上口径**
//     —— 利润表答的是后者（本期发生额），而 4103 的余额才是"累计已结转的利润"；
//   · 「结账」这个动作本身失去了落点：账不结平，所谓"这一期定稿了"就只是状态字。
//
// ===========================================================================
// 二、为什么结转**不能走凭证模板**（这是本批最重要的一个判断）
// ===========================================================================
// 批次 H 立了一条铁律：凭证只能由"已发生的事实"生成，且金额只能取
// `FACT_KEYS` 那个**封闭字典**里的键 —— 因为模板是**配置**，配置能改账。
//
// 期末结转看起来是在违反它：它的金额不是"某张来源单据的某个字段"，
// 而是**一组科目余额的聚合**；更麻烦的是它的**分录行数不固定**
// （有几个损益科目有余额就有几行），而模板的分录是固定行。
//
// 正确的结论不是"把模板放宽"，而是认出这里根本不是同一类东西：
//
//   · 模板回答的是「**这笔业务该记成哪几笔分录**」—— 业务有无数种，故要配置；
//   · 结转回答的是「**把损益科目余额搬到 4103**」—— 这是个**算法**，没有可选项。
//
// 所以结转走**代码**（`lib/closing.js`），且它的正确性不靠"配置得对"，
// 而靠两条恒等式自证（见下）。唯一保留的配置是"结转到哪个科目"
// （`settings.closing_profit_subject`，默认 4103）—— 那是会计政策。
//
// ===========================================================================
// 三、结转凭证必须从「发生额」口径里剔除（否则结账之后利润表变成 0）
// ===========================================================================
// 结转的分录是「借 6001（冲平贷方余额）/ 贷 4103」。
// 它一旦计入 `6001` 的**本期发生额**，利润表算出来的营业收入立刻变成
// `贷方发生 − 借方发生 = 本期收入 − 本期收入 = 0`。
//
// 于是本批把 `subjectBalances` 的发生额拆成**两套**，各自服务于一个明确的问题：
//
//   · `period_*`（**含**结转）：回答"这一期账上发生了什么"—— 试算平衡表用它，
//     因为试算平衡表的恒等式是「期初 + 本期借方 − 本期贷方 = 期末」，
//     把结转剔除掉这条等式立刻不成立。
//   · `operating_*`（**不含**结转）：回答"这一期**经营**上发生了什么"——
//     利润表与经营分析用它，因为结转是"把损益搬走"的记账动作，不是经营发生额。
//
// 两者都是对的，只是问题不同。**混用才会出错**，而它的表现是
// "结账之后利润表全 0 / 关账前后净利润不一致"，很容易被当成结转账算错了。
//
// 附赠一条极强的自证：**结转前后，利润表给出的净利润必须完全相同**。
// 因为它剔除了结转账，而结转只是把这同一笔金额从 6xxx 搬到 4103。
// 这条被写进 `test-closing.mjs`。
//
// ===========================================================================
// 四、结转凭证的幂等与撤销：为什么撤销是"物理删除"而不是"作废"
// ===========================================================================
// `vouchers` 上有 `UNIQUE (biz_type, source_type, source_id)`（迁移 032）。
// 结转的来源是**期间**（`accounting_periods`），一张期间只能结转一次 —— 幂等天然成立。
//
// 但"撤销结转后再结转"会撞这个唯一约束（作废的那张行还在）。两条路：
//   · 撤销 = **作废**（保留原票）→ 重结时删掉旧的 voided 票再插新的，
//     等于在"作废"之上再加一次删除，留下一个半吊子的中间态；
//   · 撤销 = **物理删除**该凭证 + 其分录 + 清期间列，理由写进期间。
//
// 选后者。理由不是"省事"，而是**这两类凭证的性质根本不同**：
//   · 业务凭证（采购/销售/收付款）承载**人工录入的事实**，作废必须保留原票 ——
//     因为"当初为什么记这一笔"只存在于那张票上；
//   · 结转凭证是**派生凭证**：它可以由"当前科目余额"完全重算出来，不承载任何
//     人工信息。保留一张 voided 的派生凭证没有审计价值，而它挡住重结却是实打实的。
//
// 配套的硬约束（防止它变成一把万能删除键）：
//   ① 只有 `biz_type='profit_carry'` 的凭证可以被这条路径删除；
//   ② **期间已关账时不允许撤销结转**（必须先反关账）——
//      这条保证"已关账期间的凭证"永远不会被删；
//   ③ 撤销必须写理由，记进 `accounting_periods.closing_reverse_reason`。
//
// ===========================================================================
// 五、结账的前置：本期已结转
// ===========================================================================
// 「关账」的定义变成：**这一期的账已经定稿**。而账没结平就不算定稿。
// 所以 `closePeriod` 增加一条前置 —— 本期已结转，或本期损益本来就为 0
// （空期间没有可结转的东西，不结转也能关账）。
// 反方向：**本期有结转凭证时不允许反关账**（先撤销结转），
// 否则"已定稿"被打开之后，结转还挂在那里，6xxx 已经是 0，
// 而新补进来的业务发生额再也进不了 4103。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '期末结转与结账（损益结转 / 结转留痕 / 结转账从发生额口径中剔除）'

// ---------------------------------------------------------------------------
// 加列（不新建表 —— 这一批只往"期间"上加结转留痕）
// ---------------------------------------------------------------------------
const NEW_COLUMNS = [
  // 本期结转凭证。NULL = 本期未结转。**只存 id，不存金额** ——
  // 金额是派生量（可以在凭证上查到），存下来就有两个真值来源。
  ['accounting_periods', 'closing_voucher_id', 'INTEGER'],
  ['accounting_periods', 'closing_by', 'INTEGER'],
  ['accounting_periods', 'closing_by_name', 'TEXT'],
  ['accounting_periods', 'closing_at', 'TEXT'],
  // 撤销结转的理由。与 `reopen_reason` 同理：撤销一个"已定稿"的动作必须答得出为什么。
  ['accounting_periods', 'closing_reverse_reason', 'TEXT']
]

const INDEXES = [
  // 结转凭证按期间反查（`listPeriods` 与关账前置检查都会用到）
  { name: 'idx_periods_closing', sql: 'CREATE INDEX IF NOT EXISTS idx_periods_closing ON accounting_periods (period, closing_voucher_id)' }
]

// 结转到哪个科目是**会计政策**（默认本年利润 4103），所以它是配置而不是常量。
const SETTINGS = [['closing_profit_subject', '4103']]

// 结转与关账**分开授权**：结转会生成一张已过账的凭证（改账），
// 而关账只是"把这一期封起来"。让"能关账"的人自动获得"能动账"的能力是不对的。
const PERMS = [['finance.period.carry', '期末结转/撤销结转', 'finance', '审核']]

const ROLE_GRANTS = {
  admin: ['finance.period.carry'],
  finance: ['finance.period.carry']
}

module.exports.up = function up(db) {
  if (!tableExists(db, 'accounting_periods')) {
    throw new Error('accounting_periods 不存在，迁移顺序有误（应先执行 034_report）')
  }
  for (const [t, c, decl] of NEW_COLUMNS) addColumn(db, t, c, decl)
  for (const ix of INDEXES) db.exec(ix.sql)

  if (tableExists(db, 'settings')) {
    const insSet = db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO NOTHING`
    )
    for (const [k, v] of SETTINGS) insSet.run(k, v)
  }

  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5901)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  const def = {
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0]),
    settings: SETTINGS.map((s) => s[0])
  }
  stampDef(db, '035_period_closing', def)
  return { columns: NEW_COLUMNS.length, indexes: INDEXES.length, settings: SETTINGS.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'accounting_periods')) return false
  for (const [, c] of NEW_COLUMNS) if (!hasColumn(db, 'accounting_periods', c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 不变量一：**结转凭证与期间状态必须自洽** ——
  // `closing_voucher_id` 非空时，那张凭证必须真的存在、且确实是结转凭证。
  // 这条会抓住"删了凭证却忘了清期间列"这类半吊子撤销：
  // 它的表现是界面上显示"本期已结转"，而凭证列表里什么都没有，
  // 于是关账前置检查**被一条不存在的凭证说服**了。
  if (tableExists(db, 'vouchers')) {
    const dangling = db
      .prepare(`
        SELECT COUNT(*) c FROM accounting_periods p
         WHERE p.closing_voucher_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM vouchers v
              WHERE v.id = p.closing_voucher_id AND v.biz_type = 'profit_carry'
           )
      `)
      .get().c
    if (dangling > 0) return false
    // 不变量一之二：结转凭证必须落在它所结转的那个期间里。
    // 落在别的期间不会报错，只会让"这一期的账"看起来没结转（而实际转了上一期）。
    const crossPeriod = db
      .prepare(`
        SELECT COUNT(*) c FROM accounting_periods p
          JOIN vouchers v ON v.id = p.closing_voucher_id
         WHERE v.period <> p.period
      `)
      .get().c
    if (crossPeriod > 0) return false
  }

  // 不变量二：结转科目必须是**已存在的叶子科目**（科目表非空时才检查 ——
  // 迁移先于 seed 跑，此时科目表还是空的，不能因此判定迁移失败）。
  if (tableExists(db, 'settings') && tableExists(db, 'accounting_subjects')) {
    const anySubject = db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c
    if (anySubject > 0) {
      const bad = db
        .prepare(`
          SELECT COUNT(*) c FROM settings s
           WHERE s.key = 'closing_profit_subject'
             AND NOT EXISTS (
               SELECT 1 FROM accounting_subjects a WHERE a.code = s.value AND a.is_leaf = 1 AND a.status = 'active'
             )
        `)
        .get().c
      if (bad > 0) return false
    }
  }

  // 「已关账的期间必须已结转」这条**刻意不放这里**。
  // 迁移的自检只回答"结构对不对"，而那条是**数据口径**检查：升级一个老库时，
  // 历史上"没结转就关账"的期间本来就存在（本系统在 035 之前就是这么干的），
  // 把它当成迁移失败，等于要求迁移去改业务数据（生成一张凭证）—— 迁移不该做这件事。
  // 它落在三处：`lib/report.js` 的 `auditReport` 探针（`PERIOD_CLOSED_NO_CARRY`）、
  // `verify-seed` 第 19 节、以及 `closePeriod` 的前置检查（拦住"新的"这种关账）。

  const def = {
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0]),
    settings: SETTINGS.map((s) => s[0])
  }
  if (defStale(db, '035_period_closing', def)) return false
  if (tableExists(db, 'settings')) {
    for (const [k] of SETTINGS) {
      if (!db.prepare('SELECT 1 AS hit FROM settings WHERE key=?').get(k)) return false
    }
  }
  return true
}
