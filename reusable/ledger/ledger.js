// =====================================================================
// GML 复式记账内核 · 可落地骨架（Node + better-sqlite3，ESM）
//
// 【来源与改造说明 - 必读】
// 数据结构抄 medici（MIT，_ref/medici）：
//   1) journal(凭证头) + transaction(凭证行) 双表，借贷双列 credit/debit 同行 ——
//      medici 的 ITransaction 就是这样，聚合时直接 SUM(debit)-SUM(credit)。
//   2) account_path 分级科目（medici 用 string[]，SQLite 改用 ':' 分隔文本）。
//   3) **红冲不作废**：medici 的 voidJournal 是「写一张反向凭证 + 原凭证标
//      voided」，_original_journal 指回原凭证，绝不物理删除 —— 审计链不能断。
//      这个设计 GML 完整保留（src/helper/addReversedTransactions.ts）。
//   4) medici 的 mongoTransaction / lock 是 Mongo 特有，全部丢弃。
//
// 【medici 没有、GML 自研补齐】
//   - 会计期间闸门 acct_periods（期末结转必须有，否则凭证能写进已结账月份）
//   - 幂等唯一索引（同一业务单据只出一张有效凭证）
//   - 账龄分桶（见 GML模块21 设计稿；不能用科目余额按日期区间算）
//
// 【金额口径】INTEGER（分）。借贷必须平衡，否则整笔拒绝写入。
// =====================================================================

// ---------------------------------------------------------------------
// 一、平衡校验：借贷不相等直接抛错，绝不允许落半成品凭证
// ---------------------------------------------------------------------
export function assertBalanced (entries) {
  let debit = 0
  let credit = 0
  for (const e of entries) {
    debit += Number(e.debit ?? 0)
    credit += Number(e.credit ?? 0)
    if (Number(e.debit ?? 0) < 0 || Number(e.credit ?? 0) < 0) {
      throw new Error('凭证分录金额不得为负：负数请用反向分录表达')
    }
    if (Number(e.debit ?? 0) > 0 && Number(e.credit ?? 0) > 0) {
      throw new Error('同一分录不得同时有借与贷')
    }
  }
  if (debit !== credit) {
    throw new Error(`借贷不平衡：借 ${debit} ≠ 贷 ${credit}，差额 ${debit - credit}`)
  }
  if (debit === 0) throw new Error('空凭证：借贷均为 0')
  return { debit, credit }
}

// ---------------------------------------------------------------------
// 二、期间闸门：已结账月份禁止再写凭证
// ---------------------------------------------------------------------
function assertPeriodOpen (db, bizDate) {
  const period = String(bizDate).slice(0, 7)
  const row = db.prepare('SELECT status FROM acct_periods WHERE period = ?').get(period)
  if (row && row.status === 'closed') {
    throw new Error(`会计期间 ${period} 已结账，禁止写入凭证`)
  }
  return period
}

// ---------------------------------------------------------------------
// 三、写凭证（幂等：同一 doc_type+doc_id 只保留一张有效凭证）
// entries: [{ account_path, debit, credit, currency, qty, meta }]
// ---------------------------------------------------------------------
export function postJournal (db, { docType, docId, docNo, bizDate, memo, entries, book = 'main', createdBy = null }) {
  assertBalanced(entries)
  const period = assertPeriodOpen(db, bizDate)

  const tx = db.transaction(() => {
    // 幂等：先作废同来源的旧凭证（红冲语义），再写新的
    const old = db.prepare(
      'SELECT id FROM acct_journals WHERE doc_type = ? AND doc_id = ? AND voided = 0'
    ).get(docType, docId)
    if (old) voidJournal(db, { journalId: old.id, reason: '同源凭证重算' })

    const info = db.prepare(`
      INSERT INTO acct_journals (book, biz_date, doc_type, doc_id, doc_no, memo, period, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(book, bizDate, docType, docId ?? null, docNo ?? null, memo ?? '', period, createdBy)
    const journalId = info.lastInsertRowid

    const ins = db.prepare(`
      INSERT INTO acct_entries (journal_id, account_path, account, debit, credit, currency, qty, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of entries) {
      const path = String(e.account_path)
      const account = path.split(':').pop()
      ins.run(journalId, path, account, e.debit ?? 0, e.credit ?? 0, e.currency ?? 'CNY',
        e.qty ?? null, e.meta ? JSON.stringify(e.meta) : null)
    }
    return journalId
  })
  return tx.immediate ? tx.immediate() : tx()
}

// ---------------------------------------------------------------------
// 四、红冲（作废）：抄 medici —— 写反向凭证，原凭证标 voided，不删数据
// ---------------------------------------------------------------------
export function voidJournal (db, { journalId, reason = '', createdBy = null }) {
  const tx = db.transaction(() => {
    const j = db.prepare('SELECT * FROM acct_journals WHERE id = ?').get(journalId)
    if (!j) throw new Error(`凭证不存在：${journalId}`)
    if (j.voided) throw new Error(`凭证 ${journalId} 已作废，不可重复红冲`)

    const entries = db.prepare('SELECT * FROM acct_entries WHERE journal_id = ? AND voided = 0').all(journalId)

    // 1) 写反向凭证（借贷互换）
    // 注意：红冲凭证必须用独立 doc_type='VOID' 且 doc_id 留空。
    // 若沿用原凭证的 doc_type+doc_id，会撞上 uq_acct_journal_doc 幂等唯一索引
    // （该索引只允许同一业务单据存在一张未作废凭证）。红冲凭证与原凭证的
    // 关系由 orig_journal_id 表达，不靠业务单据号。
    const info = db.prepare(`
      INSERT INTO acct_journals (book, biz_date, doc_type, doc_id, doc_no, memo, period, orig_journal_id, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(j.book, j.biz_date, 'VOID', null, `VOID-${journalId}`,
      `红冲 #${journalId}（${j.doc_type}${j.doc_no ? ' ' + j.doc_no : ''}）：${reason || '无'}`,
      j.period, journalId, createdBy)
    const revId = info.lastInsertRowid

    const ins = db.prepare(`
      INSERT INTO acct_entries (journal_id, account_path, account, debit, credit, currency, qty, meta)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    for (const e of entries) {
      ins.run(revId, e.account_path, e.account, e.credit, e.debit, e.currency, e.qty, e.meta)
    }

    // 2) 原凭证标 voided（不删）
    db.prepare('UPDATE acct_journals SET voided = 1, void_reason = ? WHERE id = ?').run(reason, journalId)
    return revId
  })
  return tx.immediate ? tx.immediate() : tx()
}

// ---------------------------------------------------------------------
// 五、余额查询：按科目路径前缀聚合（SQLite 用 LIKE '前缀%'）
//    medici 用 Mongo 的 account_path 数组匹配，此处等价改写
// ---------------------------------------------------------------------
export function getBalance (db, { accountPath, book = 'main', until = null, currency = 'CNY' }) {
  // ⚠️ 关键语义：这里**不能**过滤 j.voided = 0。
  // 红冲是「写一张借贷互换的反向凭证 + 原凭证标 voided」（抄 medici
  // addReversedTransactions.ts:19-24）。两张凭证都留在账上互相抵消，净额才为 0。
  // 若此处再把原凭证排除，就只剩反向凭证生效，余额会变成原额取反（差额翻倍）。
  // 教训：voided 只是「不可再被红冲」的业务标记，不参与余额聚合。
  const sql = `
    SELECT
      COALESCE(SUM(e.debit), 0)  AS debit,
      COALESCE(SUM(e.credit), 0) AS credit
    FROM acct_entries e
    JOIN acct_journals j ON j.id = e.journal_id
    WHERE e.voided = 0
      AND j.book = ? AND e.currency = ?
      AND (e.account_path = ? OR e.account_path LIKE ?)
      ${until ? 'AND j.biz_date <= ?' : ''}
  `
  const params = [book, currency, accountPath, `${accountPath}:%`]
  if (until) params.push(until)
  const row = db.prepare(sql).get(...params)
  return {
    account_path: accountPath,
    debit: row.debit,
    credit: row.credit,
    balance: row.debit - row.credit   // 借方余额为正
  }
}

// ---------------------------------------------------------------------
// 六、期末结转：把损益类科目余额结转进本年利润，随后关闭期间
// ---------------------------------------------------------------------
export function closePeriod (db, { period, profitAccount = '3131:本年利润', revenuePrefix = '6', bizDate, createdBy = null }) {
  const tx = db.transaction(() => {
    const st = db.prepare('SELECT status FROM acct_periods WHERE period = ?').get(period)
    if (st && st.status === 'closed') throw new Error(`期间 ${period} 已结账`)
    db.prepare('INSERT OR REPLACE INTO acct_periods (period, status) VALUES (?, ?)').run(period, 'closing')

    // 取本期损益类科目余额（示例：以 6 开头的损益科目）
    // 科目前缀一律参数化绑定，禁止字符串拼接（SQL 注入面）
    const rows = db.prepare(`
      SELECT e.account_path,
             COALESCE(SUM(e.debit),0) - COALESCE(SUM(e.credit),0) AS balance
        FROM acct_entries e
        JOIN acct_journals j ON j.id = e.journal_id
       WHERE e.voided = 0 AND j.period = ?      -- 同上：不排除 j.voided，避免结转重复扣减
         AND e.account_path LIKE ?
       GROUP BY e.account_path
      HAVING balance <> 0
    `).all(period, `${revenuePrefix}%`)

    const entries = []
    let profit = 0
    for (const r of rows) {
      profit += r.balance
      // 反向冲平损益科目
      entries.push(r.balance > 0
        ? { account_path: r.account_path, credit: r.balance, debit: 0 }
        : { account_path: r.account_path, debit: -r.balance, credit: 0 })
    }
    if (entries.length) {
      // 差额进本年利润。balance = 借 - 贷，收入类为贷方余额 → profit < 0 即盈利，
      // 盈利应「贷本年利润」；亏损则「借本年利润」。方向写反会导致结转凭证不平。
      entries.push(profit < 0
        ? { account_path: profitAccount, credit: -profit, debit: 0 }
        : { account_path: profitAccount, debit: profit, credit: 0 })
      assertBalanced(entries)
      postJournal(db, {
        docType: 'PERIOD_CLOSE', docId: null, docNo: `CLOSE-${period}`,
        bizDate: bizDate ?? `${period}-28`, memo: `${period} 期末结转`,
        entries, createdBy
      })
    }

    db.prepare('UPDATE acct_periods SET status = ?, closed_by = ?, closed_at = datetime(\'now\',\'localtime\') WHERE period = ?')
      .run('closed', createdBy, period)
    return { period, profit, closed: true }
  })
  return tx.immediate ? tx.immediate() : tx()
}
