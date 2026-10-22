'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/033_refund.cjs ｜ 迁移：退款单（销售退货待退款兑现 / 上限判据 / 幂等 / 账务后果）
 * ============================================================================
 * 【职责】迁移：退款单（销售退货待退款兑现 / 上限判据 / 幂等 / 账务后果）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 033 退款单（销售退货的「待退款」兑现）
//
// ===========================================================================
// 一、这一批补的是「登记了，但没有兑现的出口」
// ===========================================================================
// 批次 D1 把销售退货闭环做到了这一步：退货额冲减原应收，**冲不下的部分
// 如实登记为 `sales_returns.refund_due`（待退款额）**。
// 那句"如实登记"只解决了一半问题 —— 它答出了"该退客户多少钱"，
// **但没有任何东西能把这件事变成一次真实的出账**：
//   · 全仓搜不到一张"退款单"的表，也搜不到任何一处真正把钱退出去的代码；
//   · 界面上看得到 `refund_due` 是一个数字，但它**永远停在那里**；
//   · 对账时客户说"那笔退款到账了吗"，系统只能回答"登记过"，答不出"退没退"。
// 这是本项目反复出现的那类形态的又一次：**一个数字被记录下来了，
// 但没有任何单据/状态/账务后果与之对应** —— 于是它既不能被核销，也不能被审计。
//
// 本批落的是**最小闭环**：退款单（草稿 → 已退款 → 已作废）+ 分摊到退货单的明细
// + 退款上限判据 + 幂等键 + 账务后果（凭证模板）。
//
// ===========================================================================
// 二、四条硬口径（都在表结构、lib/refund.js 与 verify() 里体现）
// ===========================================================================
// ① **退款上限 = 退货单的 `refund_due` 减去该退货单已退（已确认）的金额**。
//    判据只写在 `lib/refund.js` 的 `planRefund()` 一张函数里 ——
//    与本项目「同一份判据不允许有两个实现」一致。
//    超退抛 `REFUND_OVER_DUE`，且**整笔不落库**。
// ② **只有 `confirmed` 才真正出账**。草稿是"打算退"，不是"退过了"；
//    作废已确认的退款单必须写理由（它会让一笔已出的钱从账上消失）。
// ③ **幂等键非空唯一**（`idx_refunds_idem`）—— 收付款与退款这类**动钱**的动作
//    最怕重放：同一次退款请求重试两次，钱不能出去两遍。
// ④ **退款必须有账务后果**：`refund` 注册进 `lib/accounting.js` 的 `BIZ_TYPES`，
//    模板 `TPL_REFUND` = 借 2203 预收账款 / 贷 1002 银行存款。
//    为什么借"预收账款"而不是"应收账款"：已收款退货产生的 `refund_due`，
//    其经济实质就是**我们多收了客户的钱**（预收负债）；
//    退款是清偿这笔负债。挂应收会让"退货冲减应收"与"退款"两件事
//    同时对同一个科目反向操作，账上看起来像什么都没发生。
//
// ===========================================================================
// 三、为什么退款单要**带分摊明细**（`refund_items`）
// ===========================================================================
// 一个客户可能同时有多张退货单各自产生待退款额，**一次性退给他**是常见业务。
// 只记一个总额的话，"这次退款抵的是哪几张退货单的待退款"就答不出来：
//   · 退款上限判据无法按退货单累计（只能看到一个总额）；
//   · 对账时无法说明"这张退货单的钱退了没有"。
// 所以明细按**退货单**分摊，唯一键 `(refund_id, return_id)` ——
// 同一张退货单不能在同一次退款里被分摊两次（那会让金额校验的 `used` 累计出现歧义）。
//
// ===========================================================================
// 四、与现有单据内核的关系
// ===========================================================================
// RFD 是第 40 种单据类型（`008_doc_kernel.cjs`）：
//   draft（已登记未退款）→ confirmed（已退款，终态）→ voided（已作废）。
// `confirmed` 是**终态**（钱出去了就是出去了）；要纠正只能作废后重退，
// 作废在内核里登记为高危动作（`高风险=1`）且必须写 `void_reason`。

const { tableExists, hasColumn, addColumn, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '退款单（销售退货待退款兑现 / 上限判据 / 幂等 / 账务后果）'

const REFUND_SQL = `
  CREATE TABLE IF NOT EXISTS refunds (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,           -- RFD + 年月日 + 序号
    source_type       TEXT NOT NULL,                  -- 来源：sales_return（退货单）/ 其它通道
    source_id         INTEGER,                        -- 来源单据 id（退货单时非空）
    customer_type     TEXT NOT NULL DEFAULT 'dealer', -- dealer / store / member / walkin
    customer_id       INTEGER,
    customer_name     TEXT,
    refund_date       TEXT NOT NULL,
    method            TEXT NOT NULL DEFAULT 'bank',   -- bank / cash / wechat / alipay / original
    amount            REAL NOT NULL DEFAULT 0,        -- 本次退款额（= 明细合计）
    status            TEXT NOT NULL DEFAULT 'draft',  -- draft / confirmed / voided
    idempotency_key   TEXT,                           -- 非空时唯一
    bank_account      TEXT,
    serial_no         TEXT,                           -- 流水号
    remark            TEXT,
    void_reason       TEXT,                           -- 作废理由（作废必填：它会让一笔已出的钱从账上消失）
    confirmed_by      INTEGER,
    confirmed_by_name TEXT,
    confirmed_at      TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`

const REFUND_ITEM_SQL = `
  CREATE TABLE IF NOT EXISTS refund_items (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    refund_id     INTEGER NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
    return_id     INTEGER NOT NULL REFERENCES sales_returns(id),
    return_doc_no TEXT,
    amount        REAL NOT NULL,                      -- 本次退这张退货单多少钱
    UNIQUE (refund_id, return_id)
  )`

const TABLES = [
  { name: 'refunds', sql: REFUND_SQL },
  { name: 'refund_items', sql: REFUND_ITEM_SQL }
]

const INDEXES = [
  {
    name: 'idx_refunds_idem',
    sql: 'CREATE UNIQUE INDEX IF NOT EXISTS idx_refunds_idem ON refunds (idempotency_key) WHERE idempotency_key IS NOT NULL'
  },
  { name: 'idx_refunds_status', sql: 'CREATE INDEX IF NOT EXISTS idx_refunds_status ON refunds (status, refund_date)' },
  { name: 'idx_refunds_customer', sql: 'CREATE INDEX IF NOT EXISTS idx_refunds_customer ON refunds (customer_type, customer_id)' },
  { name: 'idx_refund_items_refund', sql: 'CREATE INDEX IF NOT EXISTS idx_refund_items_refund ON refund_items (refund_id)' },
  // 「这张退货单被退过多少钱」是退款上限判据的核心查询，必须有索引
  { name: 'idx_refund_items_return', sql: 'CREATE INDEX IF NOT EXISTS idx_refund_items_return ON refund_items (return_id)' }
]

const PERMS = [
  ['finance.refund.view', '查看退款单', 'finance', '查看'],
  ['finance.refund.edit', '登记退款单', 'finance', '编辑'],
  ['finance.refund.approve', '确认退款（出账）', 'finance', '审核']
]

const ROLE_GRANTS = {
  admin: ['finance.refund.view', 'finance.refund.edit', 'finance.refund.approve'],
  boss: ['finance.refund.view'],
  finance: ['finance.refund.view', 'finance.refund.edit', 'finance.refund.approve'],
  sales: ['finance.refund.view'],
  viewer: ['finance.refund.view']
}

module.exports.up = function up(db) {
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  // 权限：登记与确认（出账）**分权** —— 能登记的人不该同时能把钱放出去
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

  stampDef(db, '033_refund', {
    tables: TABLES.map((t) => t.name),
    columns: [],
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  })
  return { tables: TABLES.length, columns: 0, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  for (const t of TABLES) if (!tableExists(db, t.name)) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  if (tableExists(db, 'refund_items')) {
    // 不变量一：明细金额恒 > 0（允许负数金额的分摊，任何"合计 = 总额"都能被负负得正做平）
    const badAmount = db.prepare('SELECT COUNT(*) c FROM refund_items WHERE amount <= 0').get().c
    if (badAmount > 0) return false
    // 不变量二：明细必须指向真实存在的退货单（孤儿明细会让退款上限判据静默失真）
    if (tableExists(db, 'sales_returns')) {
      const orphan = db
        .prepare('SELECT COUNT(*) c FROM refund_items i WHERE NOT EXISTS (SELECT 1 FROM sales_returns r WHERE r.id = i.return_id)')
        .get().c
      if (orphan > 0) return false
    }
  }

  if (tableExists(db, 'refunds')) {
    // 不变量三：状态只有三种取值
    const badStatus = db.prepare("SELECT COUNT(*) c FROM refunds WHERE status NOT IN ('draft','confirmed','voided')").get().c
    if (badStatus > 0) return false
    // 不变量四：**已退款的必须有确认人与确认时间**（"谁放的这笔钱"必须答得上）
    const noSigner = db
      .prepare("SELECT COUNT(*) c FROM refunds WHERE status='confirmed' AND (confirmed_by_name IS NULL OR confirmed_at IS NULL)")
      .get().c
    if (noSigner > 0) return false
    // 不变量五：作废必须写理由（它会让一笔已出的钱从账上消失）
    const voidNoReason = db
      .prepare("SELECT COUNT(*) c FROM refunds WHERE status='voided' AND (void_reason IS NULL OR TRIM(void_reason)='')")
      .get().c
    if (voidNoReason > 0) return false
  }

  // 不变量六：**单据总额必须等于明细合计**（头行不一致时，"头是权威"与"行是权威"
  // 这两种读法会给出两个不同的退款额，而两边界面都自洽）
  if (tableExists(db, 'refunds') && tableExists(db, 'refund_items')) {
    const mismatch = db
      .prepare(`
        SELECT COUNT(*) c FROM refunds r
         WHERE ABS(r.amount - COALESCE((SELECT SUM(i.amount) FROM refund_items i WHERE i.refund_id = r.id), 0)) > 0.005
      `)
      .get().c
    if (mismatch > 0) return false
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    columns: [],
    indexes: INDEXES.map((x) => x.name),
    perms: PERMS.map((p) => p[0])
  }
  if (defStale(db, '033_refund', def)) return false
  return true
}
