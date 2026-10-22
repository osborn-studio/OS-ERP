'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/036_annual_closing.cjs ｜ 迁移：年度结转与利润分配（4103→4104 · 分配决议 · 封整年）
 * ============================================================================
 * 【职责】迁移：年度结转与利润分配（4103→4104 · 分配决议 · 封整年）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 036 年度结转与利润分配（4103 本年利润 → 4104 未分配利润 · 分配的决议 · 封整年）
//
// ===========================================================================
// 一、这一批补的是「月结做了，年结没做」
// ===========================================================================
// 批次 M 让每个期末把损益类科目（6xxx）转到 4103 本年利润。
// 但 4103 从此成了一个**只进不出**的科目：它一年一年地累积，
// 于是"账上到底有多少可分配的利润"这个问题**答不出来** ——
// 4103 的余额混了多个年度，而只有把每个年度**结清**到 4104 未分配利润，
// 新年度才能从零重新累计。
//
//   月度结转：6xxx  ──▶ 4103       （每期一次，让损益科目归零）
//   年度结转：4103 ──▶ 4104       （每年一次，让"本年利润"归零、利润沉淀成"未分配利润"）
//   利润分配：4104 ──▶ 4105 / 4106 …（决议：提盈余公积、分配股利）
//
// ⚠️ 4103 是**两个结转的接点**：它既是月度结转的**目标**，又是年度结转的**来源**。
// 这个位置决定了本批最重要的那条前置检查（见第三节）。
//
// ===========================================================================
// 二、年度结转**不必**从发生额口径里剔除（与月度结转的关键差别）
// ===========================================================================
// 批次 M 花了很大力气把 `profit_carry` 从 `operating_*` 发生额里剔除，
// 否则结转 6001 的那一笔会把营业收入冲成 0（贷 − 借 = 收入 − 收入 = 0）。
//
// 年度结转**没有这个问题**，原因是它的两端**都是权益类科目**（4103 → 4104）：
//   · 利润表只看**损益类**科目的 `operating_signed`，而年结一个损益科目都不碰；
//   · 试算平衡表的恒等式「期初 + 本期借 − 本期贷 = 期末」本来就要求包含全部凭证，
//     剔除它反而不成立。
// 所以 `subjectBalances` 的分流规则**一个字都不用改**。
// 这不是"运气好"，而是"只搬权益内部"这个性质本身带来的 —— 值得写下来，
// 因为下一个人很容易照着月度结转的样子去加一处没有必要的剔除。
//
// ===========================================================================
// 三、年度结转必须在**全年都做完月度结转**之后（本批最重要的一条前置）
// ===========================================================================
// 如果 2026 年只有 7 月做了月度结转，10 月没做，那么 4103 的余额只含"7 月的利润"。
// 此时做年结会发生什么？
//   · 年结把 4103（只含 7 月）转到 4104，并把 4103 归零；
//   · 10 月的损益仍然挂在 6xxx 上；
//   · 到了 2027 年，4103 从 0 重新开始，而 2026-10 的那些 6xxx 余额会**永远**
//     留在损益科目里（它们已经错过了 2026 年的年结窗口，而年结一年只做一次）。
//
// 这不是"少转一笔"，而是**一笔永久错账**，而且它**不会让任何账不平**：
// 资产仍然等于负债加权益，试算仍然平。所以它必须在前置检查里被拦住。
// 判据是**同一份实现**：`uncarriedProfitSubjects`（`lib/closing.js` 的月度结转同用它）。
//
// ===========================================================================
// 四、年结 = 封整年（比"关账"更强），于是撤销必须反向解锁
// ===========================================================================
// 关账封的是**一期**；年结封的是**一年**。年结之后该年度所有期间一律置为 `closed` ——
// 否则"9 月还没关账"会让年结后仍能往 2026 年塞凭证，而 4104 的金额就再也不对了。
//
// 于是形成一条真实的依赖链（前一个动作依赖后一个的产物）：
//
//     改账 → 关账 → 年结 → 利润分配
//
// **撤销必须反向**：撤分配 → 撤年结 → 反关账 → 改账。
// 本批在 `reopenPeriod` 上加了一环：**该期间所属年度已年结时，必须先撤销年度结转**。
// 少了这一环，反关账就成了"绕过封账往旧年度塞凭证"的路。
//
// ===========================================================================
// 五、利润分配是**决议**，不是算法（与两个结转都不同）
// ===========================================================================
//   · 月度结转回答「把损益余额搬到 4103」—— 金额由余额决定，没有可选项；
//   · 年度结转回答「把 4103 搬到 4104」—— 同理；
//   · 利润分配回答「**从 4104 里拿多少去提公积、分多少股利**」——
//     这是**股东会的决定**，没有任何东西能推导出它。
// 所以分配的金额**必须由人输入**，系统只负责三件事：校验、记账、留痕。
// 校验里有一条特别重要：**目标科目不能是 4103**（年结的来源）与 **4104 自身**
// （那等于没分，而账还多了一张凭证）。
// 也不做"分配科目配置表"——科目由决议决定，做成配置就变成"配置能改账"。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '年度结转与利润分配（4103→4104 · 分配决议 · 封整年）'

// ---------------------------------------------------------------------------
// 加列：年结与分配的留痕**挂在"该年度 12 月"那一期上**
// ---------------------------------------------------------------------------
// 为什么不新建一张 `accounting_years` 表：会计年度就是期间的前 4 位，
// 它是**派生量**（"能派生的不要存"）。新建表就要额外维护"年度与期间一致"这条不变量，
// 而那张表里的每一个字段都能由期间算出来。挂在 12 月期上，顺带得到一条硬约束：
// **一个年度只有一个 12 月**，所以"一年只年结一次"由数据形状保证。
const NEW_COLUMNS = [
  // —— 年度结转（4103 → 4104）——
  ['accounting_periods', 'annual_voucher_id', 'INTEGER'],
  ['accounting_periods', 'annual_by', 'INTEGER'],
  ['accounting_periods', 'annual_by_name', 'TEXT'],
  ['accounting_periods', 'annual_at', 'TEXT'],
  ['accounting_periods', 'annual_reverse_reason', 'TEXT'],
  // —— 利润分配（4104 → 4105/4106…）——
  ['accounting_periods', 'dist_voucher_id', 'INTEGER'],
  ['accounting_periods', 'dist_by', 'INTEGER'],
  ['accounting_periods', 'dist_by_name', 'TEXT'],
  ['accounting_periods', 'dist_at', 'TEXT'],
  ['accounting_periods', 'dist_reverse_reason', 'TEXT']
]

const INDEXES = [
  { name: 'idx_periods_annual', sql: 'CREATE INDEX IF NOT EXISTS idx_periods_annual ON accounting_periods (period, annual_voucher_id)' },
  { name: 'idx_periods_dist', sql: 'CREATE INDEX IF NOT EXISTS idx_periods_dist ON accounting_periods (period, dist_voucher_id)' }
]

// 年结转到哪个科目是**会计政策**（默认未分配利润 4104），所以它是配置而不是常量。
// 分配的目标科目**不做配置**：它们由分配决议决定（见文件头第五节）。
const SETTINGS = [['annual_retained_subject', '4104']]

// 年结与月度结转**分开授权**：月度结转影响一期，年结**封整年**并改变次年期初。
// 让"能月结"的人自动获得"封整年"的能力是不对的 —— 与"关账 vs 结转分开授权"同源。
const PERMS = [['finance.annual.close', '年度结转 / 利润分配 / 撤销', 'finance', '审核']]

const ROLE_GRANTS = {
  admin: ['finance.annual.close'],
  finance: ['finance.annual.close']
}

module.exports.up = function up(db) {
  if (!tableExists(db, 'accounting_periods')) {
    throw new Error('accounting_periods 不存在，迁移顺序有误（应先执行 034_report）')
  }
  if (!hasColumn(db, 'accounting_periods', 'closing_voucher_id')) {
    throw new Error('accounting_periods.closing_voucher_id 不存在，迁移顺序有误（应先执行 035_period_closing）')
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
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5902)

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
  stampDef(db, '036_annual_closing', def)
  return { columns: NEW_COLUMNS.length, indexes: INDEXES.length, settings: SETTINGS.length, perms: PERMS.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'accounting_periods')) return false
  for (const [, c] of NEW_COLUMNS) if (!hasColumn(db, 'accounting_periods', c)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  if (tableExists(db, 'vouchers')) {
    // 不变量一：**期间上的指针与凭证表必须自洽**（年结与分配各查一遍）。
    // 它会抓住"删了凭证却忘了清期间列"这类半吊子撤销：表现是界面显示"已年结"，
    // 而凭证列表里什么都没有 —— 于是"可分配利润"被一条不存在的凭证说服了。
    for (const [col, biz] of [['annual_voucher_id', 'annual_carry'], ['dist_voucher_id', 'profit_distribution']]) {
      const dangling = db
        .prepare(`
          SELECT COUNT(*) c FROM accounting_periods p
           WHERE p.${col} IS NOT NULL
             AND NOT EXISTS (
               SELECT 1 FROM vouchers v WHERE v.id = p.${col} AND v.biz_type = ?
             )
        `)
        .get(biz).c
      if (dangling > 0) return false
    }

    // 不变量一之二：凭证与它所挂的期间必须对得上，但**两者允许不同的关系**：
    //   · 年结：必须**正好落在**年末期间（一年只有一个 12 月）；
    //   · 分配：落在年末期间**或之后**（`>=`）——
    //     分红与提取盈余公积的决议通常在**次年**作出，凭证也就做在次年的账上；
    //     "这个分配属于哪一年"由期间记录表达，不由凭证日期表达。
    //     写成 `=` 会把一个会计上正确的做法判成结构错误。
    const cross = db
      .prepare(`
        SELECT COUNT(*) c FROM accounting_periods p
          JOIN vouchers v ON v.id = p.annual_voucher_id
         WHERE v.period <> p.period
      `)
      .get().c
    if (cross > 0) return false
    const crossDist = db
      .prepare(`
        SELECT COUNT(*) c FROM accounting_periods p
          JOIN vouchers v ON v.id = p.dist_voucher_id
         WHERE v.period < p.period
      `)
      .get().c
    if (crossDist > 0) return false

    // 不变量二：**留痕只能挂在 12 月的期间上**。
    // 会计年度是期间的前 4 位，"年末"永远是该年度最后一个期间。
    // 挂在别的月份不会报错，只会让"这一年结过账没有"按年度查不到。
    for (const col of ['annual_voucher_id', 'dist_voucher_id']) {
      const offMonth = db
        .prepare(`SELECT COUNT(*) c FROM accounting_periods WHERE ${col} IS NOT NULL AND substr(period,6,2) <> '12'`)
        .get().c
      if (offMonth > 0) return false
    }
  }

  // 不变量三：目标科目必须是**已存在的叶子权益科目**（科目表非空时才检查 ——
  // 迁移先于 seed 跑，此时科目表还是空的，不能因此判定迁移失败）。
  if (tableExists(db, 'settings') && tableExists(db, 'accounting_subjects')) {
    const anySubject = db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c
    if (anySubject > 0) {
      const bad = db
        .prepare(`
          SELECT COUNT(*) c FROM settings s
           WHERE s.key = 'annual_retained_subject'
             AND NOT EXISTS (
               SELECT 1 FROM accounting_subjects a
                WHERE a.code = s.value AND a.is_leaf = 1 AND a.status = 'active' AND a.category = 'equity'
             )
        `)
        .get().c
      if (bad > 0) return false
    }
  }

  // 「年结后该年度必须全部关账」这条**刻意不放这里**：它是**数据口径**检查，
  // 而升级老库时"年结过但某期未关账"的状态本来就可能存在（本系统在 036 之前没有年结）。
  // 把它当成迁移失败，等于要求迁移去改业务数据。它落在 `auditReport` 的
  // `ANNUAL_PERIODS_NOT_CLOSED` 探针与 `verify-seed` 第 21 节。

  const def = {
    columns: NEW_COLUMNS.map(([t, c]) => `${t}.${c}`),
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0]),
    settings: SETTINGS.map((s) => s[0])
  }
  if (defStale(db, '036_annual_closing', def)) return false
  if (tableExists(db, 'settings')) {
    for (const [k] of SETTINGS) {
      if (!db.prepare('SELECT 1 AS hit FROM settings WHERE key=?').get(k)) return false
    }
  }
  return true
}
