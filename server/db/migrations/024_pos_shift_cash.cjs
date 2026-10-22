'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/024_pos_shift_cash.cjs ｜ 迁移：POS 交班缴款：班次核款字段 / 支付方式差异 / 缴款单 / 日结现金汇总 / 门店盘点范围
 * ============================================================================
 * 【职责】迁移：POS 交班缴款：班次核款字段 / 支付方式差异 / 缴款单 / 日结现金汇总 / 门店盘点范围
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 024 POS 交班缴款与长短款（模块 17）
//
// 本迁移补的是**收银台上的那个钱箱**。
//
// 此前 `pos_shifts` 只有四个字段：谁、哪家店、几点开的、几点关的。
// 于是门店最要紧的一件事——**钱对不对得上**——在库里完全没有位置：
//   · 收银员数出来多少现金？没地方写；
//   · 店长再数一遍，两个数差多少？没地方写；
//   · 差出来的钱算谁的？没地方写；
//   · 交到总部的现金收了没有？也没地方写。
// 「长短款」这个词在界面上根本不存在，因为库里没有能让它出生的字段。
//
// 本迁移落三件事：
//   ① **班次有自己的单号与核款字段**（`pos_shifts` 扩列）——
//      交班单是缴款单与日结单都要指回来的对象，必须有一个对外标识；
//   ② **长短款按支付方式拆分**（`pos_shift_payments`）——
//      这是本模块最重要的一条口径，理由见下表；
//   ③ **缴款有单据**（`pos_cash_drops` + `pos_cash_drop_items`）——
//      「现金交上去了」必须是一张可查的单，而不是把班次某个字段改成"已交"。
//
// 为什么长短款**必须按支付方式拆分**（而不是只算一个总额）：
//
//   | 现象 | 现金渠道 | 移动支付渠道 |
//   | --- | --- | --- |
//   | 「系统 1000、实数 995」 | **现金短款**：钱少了，要去查谁拿的 | 几乎不会发生（无现货） |
//   | 「系统 800、实数 1000」 | 找零出错 / 多收 | **平台流水漏传了一笔**：钱在平台账上，POS 单没上传 |
//
//   同样一个「差异」，现金侧是**人的问题**，移动支付侧是**系统/网络的问题**，
//   处置完全不同。只记一个总额，这张差异单交上去没人知道该找谁。
//
// 两条口径写死在结构里：
//   ① **长短款 = 实点 − 系统应收**，正数长款、负数短款。方向不能反 ——
//      它决定「差异单上是 +50 还是 −50」，而这两个字在报表上完全是两回事。
//   ② **`UNIQUE (shift_id, method)`**：一个班次每种支付方式只能有一行。
//      否则两张"现金"行会让汇总翻倍，而翻倍不会报错，只会让长短款凭空变大。

const { tableExists, hasColumn, hasIndex, addColumn, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = 'POS 交班缴款：班次核款字段 / 支付方式差异 / 缴款单 / 日结现金汇总 / 门店盘点范围'

// ---------------------------------------------------------------------------
// 一、已存在的表扩列（`pos_shifts` / `pos_daily_closes` / `stock_checks`）
// ---------------------------------------------------------------------------

const SHIFT_COLUMNS = [
  // 交班单号。内核 `doc_types` 早就把 PSF 的 `doc_no_field` 登记成 `doc_no`，
  // 而 `pos_shifts` 里根本没有这一列 —— 这类「登记与结构不符」不会报错，
  // 只会在第一次真去写单号时才炸。
  ['doc_no', 'TEXT'],
  ['device_no', 'TEXT'],                                   // 收银设备号（多台收银机时区分）
  ['closed_by', 'INTEGER'],
  ['closed_by_name', 'TEXT'],
  // 三段钱：系统应收 / 收银员报数 / 店长实点。
  // 三个都要留 —— 只留「实点」就答不上「差了多少」，只留「系统」就等于认了系统的账。
  ['sys_cash', 'REAL NOT NULL DEFAULT 0'],
  ['declared_cash', 'REAL NOT NULL DEFAULT 0'],
  ['counted_cash', 'REAL NOT NULL DEFAULT 0'],
  ['variance', 'REAL NOT NULL DEFAULT 0'],                 // 实点 − 系统应收：正长款 / 负短款
  ['variance_note', 'TEXT'],                               // 差异原因（有差异必填）
  ['variance_handled', 'TEXT'],                            // 处置：charge 责任人承担 / absorb 门店承担 / pending 待查
  ['approved_by', 'INTEGER'],
  ['approved_by_name', 'TEXT'],
  ['approved_at', 'TEXT'],
  ['cash_drop_amount', 'REAL NOT NULL DEFAULT 0'],         // 已缴款金额（由缴款明细回写）
  ['daily_close_id', 'INTEGER'],                           // 参与哪个日结批次
  ['opening_float_done', 'INTEGER NOT NULL DEFAULT 0'],    // 备用金是否已归还（0/1）
  ['updated_at', 'TEXT']
]

const CLOSE_COLUMNS = [
  // 日结的现金汇总。为什么日结要单独存一份现金数：
  //   日结把货与钱一起交总部，**货按订单过账、钱按实点过账**。
  //   若只存订单口径，长短款就永远在账上出现不了 —— 而它恰恰是要被看见的东西。
  ['shift_ids', 'TEXT'],                                   // 纳入的班次 id，逗号分隔
  ['closed_shift_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['sys_cash', 'REAL NOT NULL DEFAULT 0'],
  ['counted_cash', 'REAL NOT NULL DEFAULT 0'],
  ['cash_variance', 'REAL NOT NULL DEFAULT 0'],
  ['drop_amount', 'REAL NOT NULL DEFAULT 0'],              // 已缴款金额
  ['variance_note', 'TEXT'],
  ['created_by', 'INTEGER'],
  ['created_by_name', 'TEXT'],
  ['updated_at', 'TEXT']
]

// 门店盘点：既有 `stock_checks` 是总部视角（盘点整个仓）。
// 门店盘点是**同一个动作、不同的范围与权限**，所以加一列 scope 而不是另建一张表 ——
// 另建一张表意味着「盘点明细」的结构要维护两套，迟早分叉。
const CHECK_COLUMNS = [['scope', "TEXT NOT NULL DEFAULT 'hq'"], ['store_id', 'INTEGER']]

// 订单归属班次。这一列是「系统应收现金从哪来」的答案：
//   班次对订单是**一对多**，必须显式记下来。此前靠「同门店 + 同业务日 + 同收银员」
//   现算归属 —— 同一天同一个收银员开两个班（午班/晚班）时，两个班会算出**同一批订单**，
//   现金应收直接翻倍，而长短款跟着错一倍，从界面上完全看不出来。
const ORDER_COLUMNS = [['shift_id', 'INTEGER']]

// ---------------------------------------------------------------------------
// 二、新表
// ---------------------------------------------------------------------------

const TABLES = [
  // 班次 × 支付方式。长短款按渠道拆分就落在这张表上（文件头有理由表）。
  `CREATE TABLE IF NOT EXISTS pos_shift_payments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    shift_id        INTEGER NOT NULL REFERENCES pos_shifts(id) ON DELETE CASCADE,
    method          TEXT NOT NULL,               -- cash / wxpay / alipay / unionpay / member_balance / other
    sys_amount      REAL NOT NULL DEFAULT 0,     -- 系统按本班次订单汇总出来的金额
    declared_amount REAL NOT NULL DEFAULT 0,     -- 收银员报的
    counted_amount  REAL NOT NULL DEFAULT 0,     -- 店长实点（非现金渠道对不了账，等于 declared）
    diff            REAL NOT NULL DEFAULT 0,     -- counted − sys：正长款 / 负短款
    order_count     INTEGER NOT NULL DEFAULT 0,  -- 本渠道笔数，便于「少了 3 笔」这种判断
    remark          TEXT,
    UNIQUE (shift_id, method)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pos_shift_pay_shift ON pos_shift_payments(shift_id, method)`,

  // 缴款单头。一张单可以**汇总多个班次**（打烊时把当班几个人的钱一起交给店长），
  // 所以班次在明细表里，不在头上。
  `CREATE TABLE IF NOT EXISTS pos_cash_drops (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    doc_no            TEXT NOT NULL UNIQUE,      -- JKD...
    store_id          INTEGER NOT NULL,
    drop_date         TEXT NOT NULL,
    amount            REAL NOT NULL DEFAULT 0,   -- 缴款总额（= 明细合计，由明细算出）
    handed_by         INTEGER,                   -- 交款人（收银员）
    handed_by_name    TEXT,
    received_by       INTEGER,                   -- 接收人（店长）
    received_by_name  TEXT,
    received_at       TEXT,
    reference_no      TEXT,                      -- 银行/保险柜凭证号
    status            TEXT NOT NULL DEFAULT 'pending',  -- pending 待接收 / received 已接收 / cancelled 已取消
    remark            TEXT,
    created_by        INTEGER,
    created_by_name   TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pos_drop_store ON pos_cash_drops(store_id, drop_date, status)`,

  // 缴款明细：一行一个班次。`UNIQUE (shift_id)` 是关键 ——
  // 一个班次的现金只能缴一次，否则同一笔钱能交两遍，而「重复缴款」在账上看起来
  // 只是"钱交多了"，很难反推是操作重复。
  `CREATE TABLE IF NOT EXISTS pos_cash_drop_items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    drop_id    INTEGER NOT NULL REFERENCES pos_cash_drops(id) ON DELETE CASCADE,
    shift_id   INTEGER NOT NULL,
    shift_no   TEXT,
    amount     REAL NOT NULL DEFAULT 0,
    remark     TEXT,
    UNIQUE (shift_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pos_drop_item ON pos_cash_drop_items(drop_id)`
]

// ---------------------------------------------------------------------------
// 三、视图：把「长短款」与「资金在途」变成可查的口径
// ---------------------------------------------------------------------------

const VIEWS = [
  // 班次长短款全貌：班次级三段钱 + 各支付方式差异的聚合。
  // 为什么要视图而不是两次查询前端拼：这个数会被「日结门禁」「店长核款」
  // 「总部资金在途」三处同时用，三处各写一遍必然有一天口径不同。
  `CREATE VIEW IF NOT EXISTS v_pos_shift_variance AS
     SELECT s.id AS shift_id, s.doc_no AS shift_no, s.store_id, st.name AS store_name,
            s.cashier_id, s.cashier_name, s.biz_date, s.device_no,
            s.status, s.opened_at, s.closed_at,
            s.opening_float, s.sys_cash, s.declared_cash, s.counted_cash,
            s.variance, s.variance_note, s.variance_handled,
            s.cash_drop_amount, s.daily_close_id,
            s.approved_by_name, s.approved_at,
            (SELECT COUNT(*) FROM pos_shift_payments p WHERE p.shift_id = s.id) AS pay_method_count,
            (SELECT COUNT(*) FROM pos_shift_payments p WHERE p.shift_id = s.id AND ABS(p.diff) > 0.005) AS pay_diff_count,
            COALESCE((SELECT SUM(p.diff) FROM pos_shift_payments p WHERE p.shift_id = s.id), 0) AS pay_diff_total,
            COALESCE((SELECT COUNT(*) FROM pos_orders o
                       WHERE o.store_id = s.store_id AND o.biz_date = s.biz_date
                         AND (s.cashier_id IS NULL OR o.cashier_id = s.cashier_id)), 0) AS order_count
       FROM pos_shifts s
       LEFT JOIN stores st ON st.id = s.store_id`,

  // 门店资金在途：已核款但没缴的现金（`to_drop`）与已缴但店长没收的（`to_receive`）。
  // 这两个数是门店最容易出问题的地方 —— 「钱在谁手上」必须一眼看得到。
  `CREATE VIEW IF NOT EXISTS v_pos_cash_inflight AS
     SELECT s.store_id, st.name AS store_name,
            SUM(CASE WHEN s.status = 'closed' AND COALESCE(s.counted_cash,0) > 0
                       AND COALESCE(s.cash_drop_amount,0) + 0.005 < COALESCE(s.counted_cash,0)
                     THEN COALESCE(s.counted_cash,0) - COALESCE(s.cash_drop_amount,0) ELSE 0 END) AS to_drop,
            SUM(CASE WHEN s.status = 'closed' THEN COALESCE(s.variance,0) ELSE 0 END) AS variance_total,
            SUM(CASE WHEN s.status = 'declared' THEN 1 ELSE 0 END) AS pending_review_count,
            SUM(CASE WHEN s.status = 'open' THEN 1 ELSE 0 END) AS open_count
       FROM pos_shifts s
       LEFT JOIN stores st ON st.id = s.store_id
      GROUP BY s.store_id`
]

// ---------------------------------------------------------------------------
// 四、权限点
// ---------------------------------------------------------------------------

const PERMS = [
  ['pos.shift.review', '班次核款与长短款审批', 'pos', 'action'],
  ['pos.cashdrop', '门店现金缴款', 'pos', 'action'],
  ['pos.store.check', '门店盘点', 'pos', 'action']
]

// 门店可自结的长短款上限（元）。超过它必须挂 `pending` 交总部，
// 不允许门店直接在核款时把差异写成「责任人承担」就算了 ——
// 那等于让被追责的人自己决定要不要被追责。
const SETTINGS = [['pos_variance_limit', '500']]

const ROLE_GRANTS = {
  admin: ['pos.shift.review', 'pos.cashdrop', 'pos.store.check'],
  boss: [],
  sales: [],
  finance: ['pos.shift.review', 'pos.cashdrop'],
  warehouse: ['pos.store.check'],
  store: ['pos.shift.review', 'pos.store.check'],
  viewer: []
}

module.exports.up = function up(db) {
  // ---- 扩列 ----
  for (const [col, decl] of SHIFT_COLUMNS) addColumn(db, 'pos_shifts', col, decl)
  for (const [col, decl] of CLOSE_COLUMNS) addColumn(db, 'pos_daily_closes', col, decl)
  for (const [col, decl] of ORDER_COLUMNS) addColumn(db, 'pos_orders', col, decl)
  if (tableExists(db, 'stock_checks')) {
    for (const [col, decl] of CHECK_COLUMNS) addColumn(db, 'stock_checks', col, decl)
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pos_orders_shift ON pos_orders(shift_id, pay_method)')

  // 交班单号唯一（ALTER 加不了 UNIQUE，用唯一索引表达同一个约束）
  if (!hasIndex(db, 'uq_pos_shifts_doc_no')) {
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uq_pos_shifts_doc_no ON pos_shifts(doc_no) WHERE doc_no IS NOT NULL')
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_pos_shifts_status ON pos_shifts(status, biz_date)')
  db.exec('CREATE INDEX IF NOT EXISTS idx_pos_shifts_store   ON pos_shifts(store_id, biz_date)')

  // ---- 建表 / 视图 ----
  for (const sql of TABLES) db.exec(sql)
  for (const sql of VIEWS) db.exec(sql)

  // ---- 权限 ----
  if (tableExists(db, 'permissions')) {
    const upPerm = db.prepare(
      `INSERT INTO permissions (code,name,module,category,sort_order) VALUES (?,?,?,?,?)
       ON CONFLICT(code) DO UPDATE SET name=excluded.name, module=excluded.module, category=excluded.category`
    )
    for (const [code, name, module, category] of PERMS) upPerm.run(code, name, module, category, 5700)

    if (tableExists(db, 'role_permissions')) {
      const insRole = db.prepare('INSERT OR IGNORE INTO role_permissions (role_code,perm_code) VALUES (?,?)')
      for (const [role, codes] of Object.entries(ROLE_GRANTS)) {
        if (!db.prepare('SELECT 1 AS hit FROM roles WHERE code=?').get(role)) continue
        for (const code of codes) insRole.run(role, code)
      }
    }
  }

  // ---- 口径默认值 ----
  if (tableExists(db, 'settings')) {
    const upSet = db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO NOTHING`
    )
    for (const [k, v] of SETTINGS) upSet.run(k, v)
  }

  // ---- 历史数据回填 ----
  // 已存在的班次没有单号。补一个有规则的号（`PSF + 业务日 + 4 位序号`），
  // 而不是留 NULL —— 缴款单与日结单要靠它指回来，NULL 会让「指回哪个班次」变成空。
  // 序号按 (门店, 业务日) 分组递增，与取号规则的语义一致。
  const legacy = db
    .prepare("SELECT id, store_id, biz_date FROM pos_shifts WHERE doc_no IS NULL OR doc_no = '' ORDER BY biz_date, store_id, id")
    .all()
  if (legacy.length) {
    const seqOf = new Map()
    const upd = db.prepare('UPDATE pos_shifts SET doc_no=? WHERE id=?')
    // 先收集已有号的最大序号，避免回填与已有号撞
    for (const r of db.prepare("SELECT doc_no FROM pos_shifts WHERE doc_no IS NOT NULL AND doc_no <> ''").all()) {
      const m = /^PSF(\d{8})(\d+)$/.exec(String(r.doc_no))
      if (!m) continue
      const key = m[1]
      const n = Number(m[2])
      if (!seqOf.has(key) || seqOf.get(key) < n) seqOf.set(key, n)
    }
    for (const r of legacy) {
      const d = String(r.biz_date || '').replace(/-/g, '') || '00000000'
      const next = (seqOf.get(d) || 0) + 1
      seqOf.set(d, next)
      upd.run(`PSF${d}${String(next).padStart(4, '0')}`, r.id)
    }
    // **回填必须同时推进取号计数器**（`doc_no_counters`）。
    // 只补单号不同步计数器，下一次取号会从 1 开始 —— 取号服务有前向探测兜底，
    // 所以**不会报错**，但「新班次的号比同一天已有班次的号小」会静默发生，
    // 而单号是全系统排序与对外的标识，顺序一乱，按单号取样的断言就开始随机失败。
    const ruleRow = db
      .prepare("SELECT id FROM doc_no_rules WHERE doc_type='PSF' AND scope_type='global' AND status='active'")
      .get()
    if (ruleRow) {
      const upCounter = db.prepare(
        `INSERT INTO doc_no_counters (rule_id,period_key,current_value,updated_at)
         VALUES (?,?,?,datetime('now','localtime'))
         ON CONFLICT(rule_id,period_key) DO UPDATE SET
           current_value=MAX(current_value, excluded.current_value), updated_at=excluded.updated_at`
      )
      for (const [key, max] of seqOf) {
        if (key === '00000000') continue
        upCounter.run(ruleRow.id, key, max)
      }
    }
  }
  // 交班时间缺失的补上（老班次可能只有 opened_at）
  db.exec("UPDATE pos_shifts SET closed_at = COALESCE(closed_at, updated_at, opened_at) WHERE status IN ('closed','cancelled') AND closed_at IS NULL")

  stampDef(db, '024_pos_shift_cash', {
    tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS, settings: SETTINGS,
    shiftCols: SHIFT_COLUMNS, closeCols: CLOSE_COLUMNS, checkCols: CHECK_COLUMNS, orderCols: ORDER_COLUMNS
  })
  return { tables: TABLES.length, views: VIEWS.length, perms: PERMS.length, shiftCols: SHIFT_COLUMNS.length }
}

module.exports.verify = function verify(db) {
  for (const t of ['pos_shift_payments', 'pos_cash_drops', 'pos_cash_drop_items']) {
    if (!tableExists(db, t)) return false
  }
  // 视图是口径的落点，必须一起自检 —— 整库重建会先 DROP 所有视图，
  // 只查表存在会把「视图凭空消失」误判成「已迁移」，而依赖它的查询要到运行时才炸。
  for (const v of ['v_pos_shift_variance', 'v_pos_cash_inflight']) {
    if (!db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type='view' AND name=?").get(v)) return false
  }
  for (const [col] of SHIFT_COLUMNS) if (!hasColumn(db, 'pos_shifts', col)) return false
  for (const [col] of CLOSE_COLUMNS) if (!hasColumn(db, 'pos_daily_closes', col)) return false
  for (const [col] of ORDER_COLUMNS) if (!hasColumn(db, 'pos_orders', col)) return false
  for (const [col] of CHECK_COLUMNS) if (tableExists(db, 'stock_checks') && !hasColumn(db, 'stock_checks', col)) return false

  // 交班单号唯一索引：它保证「一张缴款单不会指回两个班次」，
  // 独立自检 —— 靠的就是库结构，不靠应用层记得。
  if (!hasIndex(db, 'uq_pos_shifts_doc_no')) return false
  // 一个班次只能缴一次款
  const uniq = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pos_cash_drop_items'").get()
  if (!uniq || !/UNIQUE\s*\(\s*shift_id\s*\)/i.test(uniq.sql)) return false
  // 班次 × 支付方式唯一
  const uniq2 = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='pos_shift_payments'").get()
  if (!uniq2 || !/UNIQUE\s*\(\s*shift_id\s*,\s*method\s*\)/i.test(uniq2.sql)) return false

  if (tableExists(db, 'permissions')) {
    for (const [code] of PERMS) {
      if (!db.prepare('SELECT 1 AS hit FROM permissions WHERE code=?').get(code)) return false
    }
  }
  if (tableExists(db, 'settings')) {
    for (const [k] of SETTINGS) {
      if (!db.prepare('SELECT 1 AS hit FROM settings WHERE key=?').get(k)) return false
    }
  }
  // 指纹里的字段必须与 up 的 stampDef **逐字一致**。
  // 少写一个字段的后果不是"漏检"，而是指纹永远对不上 → verify 恒为 false →
  // 每次启动都重跑一遍 up。它不会报错，只会让每次启动都慢一截，
  // 而重跑 up 里的历史回填又在正常路径上是无害的，于是这个错能藏很久。
  if (
    defStale(db, '024_pos_shift_cash', {
      tables: TABLES, views: VIEWS, perms: PERMS, roles: ROLE_GRANTS, settings: SETTINGS,
      shiftCols: SHIFT_COLUMNS, closeCols: CLOSE_COLUMNS, checkCols: CHECK_COLUMNS, orderCols: ORDER_COLUMNS
    })
  ) {
    return false
  }
  return true
}
