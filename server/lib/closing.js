/**
 * ============================================================================
 * 文件标识：server/lib/closing.js ｜ 期末结转（批次 M · 模块 28 的续）：把损益类科目余额搬到「本年利润」，让"结账"这个词有内容
 * ============================================================================
 * 【职责】期末结转（批次 M · 模块 28 的续）：把损益类科目余额搬到「本年利润」，让"结账"这个词有内容
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 期末结转（批次 M · 模块 28 的续）：把损益类科目余额搬到「本年利润」，让"结账"这个词有内容
//
// ===========================================================================
// 一、这一批补的是「账平了，但利润还挂在损益科目上」
// ===========================================================================
// 批次 L 让三张报表算得出来，但它在自己的注释里留了一句实话：
//
//     「本系统**没有做期末结转**，损益类科目期末仍有余额。」
//
// 于是资产负债表上用了一行「未结转损益」（`BS_UNCARRIED_PL`，区间 6001~6999）
// 把 6xxx 的余额兜进所有者权益。这是权宜之计，代价有三：
//   · **收入科目的余额跨年不清零**（6001 的余额会是开业至今的全部收入），
//     而会计上它本该在每个期末被转到 4103、把损益科目归零；
//   · 答不出**账上口径的本年累计利润**（4103 的余额才是它）；
//   · 「结账」失去落点 —— 账没结平，"这一期定稿了"就只是一个状态字。
//
// ===========================================================================
// 二、为什么结转**不能走凭证模板**（本批最重要的一个判断）
// ===========================================================================
// 批次 H 立过一条铁律：凭证只能由"已发生的事实"生成，金额只能取 `FACT_KEYS`
// 那个**封闭字典** —— 因为模板是**配置**，配置能改账。
//
// 结转看起来在违反它：金额不是"某张来源单据的某个字段"，而是**一组科目余额的聚合**；
// 而且**分录行数不固定**（有几个损益科目有余额就有几行），模板的分录是固定行。
//
// 正确的结论不是"把模板放宽"，而是认出这里根本不是同一类东西：
//   · 模板回答「**这笔业务该记成哪几笔分录**」—— 业务形态无穷，所以要配置；
//   · 结转回答「**把损益科目余额搬到 4103**」—— 这是个**算法**，没有可选项。
// 所以结转走代码（本文件），且它的正确性不靠"配置得对"，而靠**恒等式自证**：
//   · 结转后所有损益类科目余额归零；
//   · 4103 的余额增量 = 本期的净利润；
//   · **结转前后利润表给出的净利润完全相同**（因为利润表的发生额口径剔除了结转账）。
// 唯一保留的配置是"结转到哪个科目"（`settings.closing_profit_subject`）—— 那是会计政策。
//
// ===========================================================================
// 三、结转凭证必须从「发生额」口径里剔除
// ===========================================================================
// 结转的分录是「借 6001（冲平贷方余额）/ 贷 4103」。它一旦计入 `6001` 的
// **本期发生额**，利润表算出来的营业收入立刻变成 `贷 − 借 = 本期收入 − 本期收入 = 0`。
// 所以 `lib/report.js` 的 `subjectBalances` 把发生额拆成两套：
//   · `period_*`（**含**结转）→ 试算平衡表用（它的恒等式是"期初 + 借 − 贷 = 期末"）；
//   · `operating_*`（**不含**结转）→ 利润表与经营分析用（问题不同：本期**经营**上发生了什么）。
// 两者都对，**混用才错**。详见迁移 035 的注释三。
//
// ===========================================================================
// 四、幂等与撤销：为什么撤销是"物理删除"而不是"作废"
// ===========================================================================
// `vouchers` 上有 `UNIQUE (biz_type, source_type, source_id)`（迁移 032）。
// 结转的来源是**期间**，一张期间只能结转一次 —— 幂等天然成立。
// 但"撤销后再结转"会撞这个唯一约束（作废的那张行还在），所以要选一条撤销路径。
// 选**物理删除**，理由不是省事，而是这两类凭证的性质不同：
//   · 业务凭证承载**人工录入的事实**，"当初为什么记这一笔"只存在于那张票上 ⇒ 作废必须留原票；
//   · 结转凭证是**派生凭证**，可由"当前科目余额"完全重算，不承载任何人工信息 ⇒
//     留一张 voided 的派生凭证没有审计价值，而它挡住重结却是实打实的。
// 配套三道硬约束（见 `reverseClosing`）：只删 `profit_carry`、已关账期间不许撤销、必须写理由。
//
// ===========================================================================
// 五、依赖方向
// ===========================================================================
//   `period.js`（期间 + 结转类型常量）  ←  `report.js`（余额与报表）  ←  `closing.js`（本文件）
//   `accounting.js`（凭证生成/过账/校验）←──────────────────────────┘
// 本文件是唯一"同时知道余额与凭证"的地方 —— 这正是它存在的理由：
// 把这两个世界连起来的那一步（"把余额记成一张凭证"）只写一次。
import * as A from './accounting.js'
import * as R from './report.js'
import { assertPeriod, ensurePeriod, getPeriod, CARRY_BIZ_TYPE } from './period.js'
import { monthEnd } from './dates.js'
// 期间审计日志（批次 Q）：结转/撤销结转都要留一条可重放的记录，且必须与动账同事务
import { logPeriodChange } from './period-audit.js'
import { readSetting } from './settings.js'

const money2 = (n) => Number(Number(n || 0).toFixed(2))

export class ClosingError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message)
    this.name = 'ClosingError'
    this.code = code
    // 同时写 `status` 与 `http`：HTTP 层的统一翻译器只认 `.status`（批次 L 的缺陷一百三十一）
    this.status = status
    this.http = status
    this.detail = detail
  }
}

/** 结转凭证的来源表。它与 `CARRY_BIZ_TYPE` 一起构成幂等三元组。 */
export const CARRY_SOURCE_TYPE = 'accounting_periods'

// ---------------------------------------------------------------------------
// 一、结转目标科目（会计政策，唯一出处是 settings）
// ---------------------------------------------------------------------------
/** 结转到哪个科目 —— 唯一出处 `SETTING_RULES.closing_profit_subject`（默认本年利润 4103）。
 *  **注意**：`readSetting` 对非法值（空串 / 非纯数字）回落默认值，
 *  而本函数原来的 `String(row?.value || '').trim() || '4103'` 对 `'abc'` 会原样返回 ——
 *  于是错误从"配置读错"变成"科目找不到"（`CLOSING_SUBJECT_NOT_FOUND`）。
 *  严格一点是对的：配置**必须**是一个科目编码，不符合就不该被写进去。 */
export function closingSubjectCode(db) {
  return readSetting(db, 'closing_profit_subject')
}

/**
 * 结转目标科目本身。三条校验都是刻意的：
 *   · 必须存在 → 否则结转凭证生成到一半才发现科目没建；
 *   · 必须是**叶子** → 挂父科目不会报错，只会让"父科目 = 子科目之和"悄悄不成立；
 *   · 必须是**权益类** → 把损益结转到资产或负债科目上，账还能平（借贷一样平），
 *     但资产负债表会同时错两块 —— 而它**仍然是平的**，没有任何东西会报错。
 */
export function closingSubject(db) {
  const code = closingSubjectCode(db)
  const s = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
  if (!s) {
    throw new ClosingError('CLOSING_SUBJECT_NOT_FOUND', `结转目标科目 ${code} 不存在（配置项 settings.closing_profit_subject）`, 409)
  }
  if (s.status !== 'active') throw new ClosingError('CLOSING_SUBJECT_INACTIVE', `结转目标科目 ${s.code} ${s.name} 已停用`, 409)
  if (!s.is_leaf) throw new ClosingError('CLOSING_SUBJECT_NOT_LEAF', `结转目标科目 ${s.code} ${s.name} 不是叶子科目`, 409)
  if (s.category !== 'equity') {
    throw new ClosingError(
      'CLOSING_SUBJECT_NOT_EQUITY',
      `结转目标科目 ${s.code} ${s.name} 的类别是「${s.category}」，损益只能结转到权益类科目（否则报表会同时错两块，而它仍然是平的）`,
      409
    )
  }
  return s
}

// ---------------------------------------------------------------------------
// 二、试算（只算不写）—— 界面的"预览"与真正的"结转"走同一个函数
// ---------------------------------------------------------------------------
/**
 * 本期要结转什么。**不落库**。
 *
 * 金额取的是各损益科目的**期末余额**（`closing_signed` = 期初登记 + 本期借 − 本期贷）。
 * 为什么用期末余额而不是本期发生额：
 *   · 期末余额天然包含"上期没结转完的余额" —— 只算本期发生额的话，
 *     一个从未结转过账的库第一次结转会**漏掉全部历史余额**；
 *   · 而它天然**只含本期**：因为每次结转都把损益科目转平了，
 *     所以只要按期顺序结转，期末余额就是"自上次结转以来"的净额。这两件事是同一个性质。
 *
 * 借贷方向：**与其余额方向相反**记一笔，把它冲平。
 *   收入类（贷方余额，`signed < 0`）→ 记借方；费用类（借方余额，`signed > 0`）→ 记贷方。
 */
export function planClosing(db, { period }) {
  const p = assertPeriod(period)
  const row = ensurePeriod(db, p)
  const target = closingSubject(db)
  const balances = R.subjectBalances(db, { period: p })

  const src = balances.rows
    .filter((r) => r.category === 'profit_loss' && r.is_leaf)
    .filter((r) => Math.abs(Number(r.closing_signed)) > 0.005)

  const lines = []
  const details = []
  for (const r of src) {
    const signed = money2(r.closing_signed)
    const direction = signed > 0 ? 'credit' : 'debit'
    const amount = Math.abs(signed)
    lines.push({
      seq: lines.length + 1,
      summary: `期末结转 ${r.code} ${r.name}`,
      direction,
      amount,
      subject_code: r.code
    })
    details.push({
      subject_code: r.code,
      subject_name: r.name,
      balance_side: r.direction,
      balance_signed: signed,
      carry_direction: direction,
      carry_amount: amount
    })
  }

  // 对方科目那一行：**末行兜底，用减法算**。
  // 不用"把各科目 signed 再加一遍"（那会独立算出第二个数）——
  // 总额拆成几份时最后一份必须用减法，否则四舍五入的尾差会让整张凭证差 0.01，
  // 而这个差额不会报错，只会被当成"生成器有 bug"（批次 H 立下的口径）。
  const debitSum = money2(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
  const creditSum = money2(lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0))
  const diff = money2(debitSum - creditSum) // > 0 = 借方多（盈利）→ 给目标科目记贷方
  if (Math.abs(diff) > 0.005) {
    lines.push({
      seq: lines.length + 1,
      summary: `本期损益结转至 ${target.code} ${target.name}`,
      direction: diff > 0 ? 'credit' : 'debit',
      amount: Math.abs(diff),
      subject_code: target.code
    })
  }

  const totalDebit = money2(lines.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
  const totalCredit = money2(lines.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0))

  return {
    period: p,
    period_id: row.id,
    period_status: row.status,
    target: { id: target.id, code: target.code, name: target.name },
    // 逐科目的余额与结转方向 —— 界面靠它回答"为什么是这几行"，
    // 而不是让人对着一个合计数猜。
    details,
    lines,
    // **待结转的损益净额**（贷方口径，正数 = 盈利）。
    // 它与「利润表净利润」**不是同一个数**，这是刻意的区分：
    //   · 按期结转的库：上次结转已把历史损益转平，两者相等；
    //   · **首次结转**（历史从未结转过）的库：这里是**自开业以来的累计**，
    //     而利润表只答本期。两者不等时，"历史上没按期结转"这件事因此可见。
    carry_profit: diff,
    // 本期经营口径的净利润（来自利润表，同一个实现 —— 不在本文件重算一遍）
    period_net_profit: R.incomeStatement(db, { period: p }).totals.PL_NET_PROFIT ?? 0,
    total_debit: totalDebit,
    total_credit: totalCredit,
    carried: !!row.closing_voucher_id,
    closing_voucher_id: row.closing_voucher_id ?? null,
    // 还有未结转的损益余额吗（`lines` 非空即为真）
    pending: lines.length > 0
  }
}

// ---------------------------------------------------------------------------
// 三、结转（生成 → 过账 → 回写期间）
// ---------------------------------------------------------------------------
/**
 * 期末结转。**生成并立刻过账**。
 *
 * 为什么当场过账（而不是留一张 draft 让人点）：
 *   · 结转是**期末定稿**动作，一张没过账的结转凭证不会改变任何报表数字
 *     （`draft` 不计入），于是界面上会显示"已结转"而账上什么都没变；
 *   · 而 `closePeriod` 的前置要求"本期没有未过账草稿" ——
 *     留 draft 会让关账**必然失败**，把结转变成一步半的动作。
 * 幂等：同一期重复调用返回首次结果（`replayed: true`）。
 */
export function carryForward(db, { period, actor = null, remark = null }) {
  const p = assertPeriod(period)
  const row = ensurePeriod(db, p)

  // 幂等**以凭证表为准**，不是以期间列为准。
  // 两个理由：
  //   ① `vouchers` 上有 `UNIQUE (biz_type, source_type, source_id)`；
  //      只看期间列的话，"期间列被清空而凭证还在"会撞这条约束，
  //      于是调用方拿到的是一个 `SqliteError` 而不是业务错误 ——
  //      数据库约束不该是最后一道防线（它连"该怎么办"都说不出来）；
  //   ② 凭证表承载的是**实际发生过的事**，期间列只是它的一个指针。
  //      两者不一致时，以"发生过的事"为准，并把不一致报出来。
  const exist = db
    .prepare('SELECT * FROM vouchers WHERE biz_type=? AND source_type=? AND source_id=?')
    .get(CARRY_BIZ_TYPE, CARRY_SOURCE_TYPE, row.id)

  if (exist && exist.status === 'posted') {
    return {
      period: p,
      replayed: true,
      reason: row.closing_voucher_id ? '本期已结转' : '本期已结转（期间指针缺失，已按凭证表为准）',
      pointer_missing: !row.closing_voucher_id,
      voucher: A.getVoucher(db, exist.id),
      plan: planClosing(db, { period: p })
    }
  }
  if (exist) {
    // 存在但不是 posted（draft / voided）：**如实报出来**，而不是"重新结一张、把旧的覆盖掉"。
    // 后者会把一个坏状态悄悄修好，于是没有人知道它坏过。
    throw new ClosingError(
      'CLOSING_VOUCHER_NOT_POSTED',
      `期间 ${p} 的结转凭证 ${exist.doc_no} 当前状态为「${exist.status}」，不能当作已结转；请先撤销结转记录（或删除该凭证）后重试`,
      409,
      { period: p, voucher_id: exist.id, doc_no: exist.doc_no, voucher_status: exist.status }
    )
  }
  if (row.closing_voucher_id) {
    // 期间列指向一张不存在的凭证 —— 结构不一致，迁移 035 的 verify 会拦
    throw new ClosingError(
      'CLOSING_VOUCHER_MISSING',
      `期间 ${p} 记录的结转凭证 #${row.closing_voucher_id} 不存在；请先撤销结转记录再重试`,
      409,
      { period: p, closing_voucher_id: row.closing_voucher_id }
    )
  }

  if (row.status === 'closed') {
    throw new ClosingError(
      'PERIOD_CLOSED',
      `期间 ${p} 已关账，不能再结转（结转要过账，而关账的期间不能再过账 —— 请先反关账并填写理由）`,
      409,
      { period: p }
    )
  }

  const plan = planClosing(db, { period: p })
  if (!plan.lines.length) {
    throw new ClosingError('CLOSING_NOTHING', `期间 ${p} 的损益类科目余额全部为 0，没有需要结转的内容`, 409, { period: p })
  }

  const exec = db.transaction(() => {
    const v = A.persistVoucher(
      db,
      {
        biz_type: CARRY_BIZ_TYPE,
        source_type: CARRY_SOURCE_TYPE,
        // 来源就是**期间本身**：一张期间只能结一次，幂等由唯一约束兜底
        source_id: row.id,
        source_doc_no: p,
        // 结转日期取**期间末日**（不是"今天"）：它属于这一期，
        // 写成今天会让一张 9 月的结转凭证落在 10 月的日期上，而月末对账是按日期扫的。
        voucher_date: monthEnd(p) || `${p}-01`,
        period: p,
        lines: plan.lines,
        label: `期间 ${p} 期末结转`
      },
      {
        actor,
        memo: remark || `${p} 期末结转损益（待结转净额 ${plan.carry_profit}）→ ${plan.target.code} ${plan.target.name}`
      }
    )
    A.postVoucher(db, { id: v.id, actor })
    db.prepare(`
      UPDATE accounting_periods
         SET closing_voucher_id=?, closing_by=?, closing_by_name=?, closing_at=datetime('now','localtime'),
             closing_reverse_reason=NULL
       WHERE period=?
    `).run(v.id, actor?.id ?? null, actor?.name ?? null, p)
    // 审计日志与"生成凭证 + 落指针"同事务（批次 Q）：
    // 结转既动账又改期间指针，如果日志掉队，"这一期的结转是谁做的"就永久无解。
    logPeriodChange(db, {
      period: p,
      action: 'profit_carry',
      statusBefore: row.status,
      voucherId: v.id,
      voucherDocNo: v.doc_no,
      amount: plan.carry_profit,
      remark,
      actor,
      detail: { target_subject: plan.target.code, lines: plan.lines.length, period_net_profit: plan.period_net_profit }
    })
    return v.id
  })
  const vid = exec()
  return { period: p, replayed: false, voucher: A.getVoucher(db, vid), plan }
}

/**
 * 撤销结转：删掉本期的结转凭证、清掉期间上的结转记录。
 *
 * 三道硬约束（少一条它就会变成一把"谁都能删凭证"的钥匙）：
 *   ① 必须写理由 —— 与反关账、作废已过账凭证同一个道理：撤销一个已定稿的动作要答得出为什么；
 *   ② **已关账的期间不许撤销** —— 保证"已关账期间的凭证"永远不会被删（要先反关账）；
 *   ③ 只删 `biz_type='profit_carry'` 的凭证 —— 期间列就算被改坏了也删不掉业务凭证。
 *
 * 返回被删掉的那张凭证的摘要（它已经不在了，所以这个摘要是事后唯一的记录）
 * 以及写进期间的撤销理由。
 */
export function reverseClosing(db, { period, actor = null, reason = null }) {
  const p = assertPeriod(period)
  const row = getPeriod(db, p)
  if (!row || !row.closing_voucher_id) {
    return { period: p, replayed: true, reason: '本期未结转', removed: null }
  }
  if (!String(reason || '').trim()) {
    throw new ClosingError('REVERSE_REASON_REQUIRED', `撤销期间 ${p} 的期末结转必须填写理由`, 400, { period: p })
  }
  if (row.status === 'closed') {
    throw new ClosingError(
      'PERIOD_CLOSED',
      `期间 ${p} 已关账；撤销结转会让已定稿的账少一张凭证 —— 请先反关账（反关账本身也要写理由）`,
      409,
      { period: p }
    )
  }
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(row.closing_voucher_id)
  if (v && v.biz_type !== CARRY_BIZ_TYPE) {
    throw new ClosingError(
      'NOT_A_CARRY_VOUCHER',
      `期间 ${p} 记录的凭证 ${v.doc_no} 不是期末结转凭证（biz_type=${v.biz_type}），拒绝撤销`,
      409,
      { period: p, voucher_id: v.id, biz_type: v.biz_type }
    )
  }

  const removed = v ? { id: v.id, doc_no: v.doc_no, status: v.status, total_debit: v.total_debit, voucher_date: v.voucher_date, memo: v.memo } : null
  const exec = db.transaction(() => {
    if (v) {
      db.prepare('DELETE FROM voucher_entries WHERE voucher_id=?').run(v.id)
      db.prepare('DELETE FROM vouchers WHERE id=?').run(v.id)
    }
    db.prepare(`
      UPDATE accounting_periods
         SET closing_voucher_id=NULL, closing_by=NULL, closing_by_name=NULL, closing_at=NULL,
             closing_reverse_reason=?
       WHERE period=?
    `).run(String(reason).trim(), p)
    // 撤销是被删掉的那张凭证**事后唯一的记录**：凭证已经不在了，
    // 日志里的 `amount` / `voucher_doc_no` 是"当初结了多少"唯一的出处。
    logPeriodChange(db, {
      period: p,
      action: 'carry_reverse',
      statusBefore: row.status,
      voucherDocNo: removed?.doc_no ?? null,
      amount: removed?.total_debit ?? null,
      reason: String(reason).trim(),
      actor
    })
  })
  exec()
  return { period: p, replayed: false, removed, reason: String(reason).trim(), operator: actor?.name ?? null }
}

// ---------------------------------------------------------------------------
// 四、状态（界面与关账前置共用一份回答）
// ---------------------------------------------------------------------------
/**
 * 本期的结转状态。
 * `pending` 为真 = 还有未结转的损益余额 → `closePeriod` 会拿它把关。
 */
export function closingStatus(db, { period }) {
  const p = assertPeriod(period)
  const plan = planClosing(db, { period: p })
  const row = getPeriod(db, p)
  return {
    period: p,
    period_status: row?.status ?? 'open',
    carried: !!row?.closing_voucher_id,
    closing_voucher_id: row?.closing_voucher_id ?? null,
    closing_by_name: row?.closing_by_name ?? null,
    closing_at: row?.closing_at ?? null,
    closing_reverse_reason: row?.closing_reverse_reason ?? null,
    carry_profit: plan.carry_profit,
    period_net_profit: plan.period_net_profit,
    pending: plan.pending,
    target: plan.target,
    details: plan.details
  }
}

export function meta(db) {
  const target = closingSubject(db)
  return {
    carry_biz_type: CARRY_BIZ_TYPE,
    carry_source_type: CARRY_SOURCE_TYPE,
    target: { id: target.id, code: target.code, name: target.name },
    profit_loss_subjects: db
      .prepare("SELECT id, code, name, direction FROM accounting_subjects WHERE category='profit_loss' AND status='active' ORDER BY code")
      .all(),
    note: '期末结转把损益类科目余额搬到目标科目（默认 4103 本年利润）。'
      + '结转凭证由算法生成、**不走凭证模板** —— 它的行数由余额决定，不是配置。'
      + '结转前后利润表的净利润必须完全相同（利润表的发生额口径剔除了结转账）。'
  }
}
