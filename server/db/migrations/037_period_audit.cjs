'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/037_period_audit.cjs ｜ 迁移：期间审计链（关账/结转/年结/分配的变更日志 · 只追加 · 可重放）
 * ============================================================================
 * 【职责】迁移：期间审计链（关账/结转/年结/分配的变更日志 · 只追加 · 可重放）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 037 期间审计链（关账 / 结转 / 年结 / 分配的每一次变更都留一条可重放的记录）
//
// ===========================================================================
// 一、这一批补的是「账上写着已关账，但没人知道它是怎么关上的」
// ===========================================================================
// 批次 L 起，会计期间有了状态、有了"定稿"动作；批次 M 加了期末结转与撤销结转；
// 批次 O 加了年结、封整年与利润分配。到今天，能改变期间状态/定稿结果的动作有**八个**：
//
//     关账 · 反关账 · 期末结转 · 撤销期末结转 · 年度结转 · 撤销年度结转 · 利润分配 · 撤销利润分配
//
// 而它们留下的痕迹是**覆盖式**的 —— 期间表上只有"最后一次"：
//
//     status='closed' · closed_by / closed_at · reopen_reason
//     closing_voucher_id / closing_by / closing_at / closing_reverse_reason
//     annual_voucher_id / annual_by / annual_at / annual_reverse_reason
//     dist_voucher_id  / dist_by  / dist_at  / dist_reverse_reason
//
// 于是下面这些问题答不出来（而它们都是审计上的必答题）：
//   · 这一期**被反关账过几次**？每次的理由是什么？
//   · 3 月关账之后又反关账、改了账、重新关账 —— 现在这个"已关账"是谁关的？
//   · 期末结转被撤销过吗？撤销时账上是什么样？
//   · 年结封了整年 —— 那些期间里，哪几个是被年结顺手封的、哪几个是各自关的？
//
// `openapi.js` 与交接文档里把它记成"反关账清 `closed_by`（审计链不完整）"，
// 措辞只说对了一半：**清空本身是对的**（下面第二节），缺的是"历史去哪了"。
//
// ===========================================================================
// 二、先纠正一个口径：期间表上的那些列是**指针**，不是历史
// ===========================================================================
// 反关账时把 `closed_by` / `closed_at` 清空，看起来像"销毁证据"，其实是唯一自洽的写法：
// 一个 `status='open'` 的期间同时带着 `closed_by='张三'`，那句话本身是矛盾的 ——
// 读它的人必须先知道"这是历史还是现状"才能解释，而**列名不携带这个信息**。
//
// 所以本批不改成"保留旧值"，而是把两件事分开：
//   · **期间表 = 当前状态指针**（现状，随时可被下一个动作覆盖）；
//   · **审计日志 = 历史事实**（只追加，不更新，不删除）。
// 这与批次 M 定下的"`closing_voucher_id` 只是指针、`vouchers` 才是事实"是同一条口径。
//
// ===========================================================================
// 三、日志必须是**追加**的，且必须与产生它的动作**同一个事务**
// ===========================================================================
// 两条硬口径：
//   ① **只追加**。日志没有 UPDATE / DELETE 路径 —— 一旦允许修改，"谁改过账"这个问题
//      就退化成"谁有权限改日志"。代码层面也只有 `INSERT` 一处。
//   ② **同事务**。写日志与改期间必须在同一个 `db.transaction` 里 ——
//      否则"关了账但日志没写"或者"日志写了但账没关上"会真的出现，
//      而这两种不一致都会让日志从"证据"变成"说法"。
//      八个动作里本来就有六个在事务里（结转/年结/分配要落凭证），
//      另外两个（关账/反关账）本批一并包进事务。
//
// ===========================================================================
// 四、为什么要有「基线」条目（而不是"空日志 = 没发生过"）
// ===========================================================================
// 迁移跑在一个**已经用过的库**上时，期间表里已经有状态了（演示库就有 1 个已关账期间），
// 而它们的动作发生在日志表存在之前。这里只有两个诚实的选择：
//   · 让探针"从有日志的期间开始查"—— 于是恰好把唯一需要解释的那个状态跳过了；
//   · **按现状补一条 `baseline`（基线）条目**，并且明写它"不是某个人的动作"。
//
// 选后者。它与批次 O 的一条教训同源：**"没有配置 / 没有基准"不等于"从零开始"**。
// 基线条目让"重放日志 = 期间表现状"这条不变量从**第一个期间**起就成立，
// 而不是从"我们开始记日志的那天"起才成立。
//
// 基线**不做**成"假装是关账动作"（那会伪造一个人和一条理由），
// 它的 `actor_source='migration'`、`reason` 明写来由，`action='baseline'`。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '期间审计链（关账/结转/年结/分配的变更日志 · 只追加 · 可重放）'

// ---------------------------------------------------------------------------
// 表：期间变更日志
// ---------------------------------------------------------------------------
// 每个字段都有一个"为什么非它不可"：
//   · `action` —— 唯一写入点认的动作名（`lib/period-audit.js` 的 `PERIOD_ACTIONS`）；
//   · `action_label` —— 动作的**当时**中文名。刻意冗余落库：日志是不可变事实，
//     它的措辞不该随后续代码改名而变（改名之后，去年的日志会突然换一个说法）；
//   · `scope` / `scope_key` —— 动作作用于「一期」还是「一年」。年结会封整年，
//     只按期间查会漏掉"这一期是被年结封的"这件事；
//   · `status_before` / `status_after` —— 状态迁移的两个端点。`before` 允许为空
//     （基线条目没有"之前"）；
//   · 三个凭证指针 —— 与期间表同名同义，这样"重放"可以逐字段比对而不用做映射；
//   · `amount` —— 结转账 / 分配凭证的金额（人读日志时最想知道的那一个数）。
//     `NULL` 表示该动作不涉及金额（关账/反关账）；
//   · `reason` —— 撤销类动作**必填**（判据在 `PERIOD_ACTIONS`，不在这里）；
//   · `actor_source` —— `web` / `mcp` / `system` / `migration`。写它是为了区分
//     "人做的"与"迁移补的基线"——后者不是谁的动作。
const TABLES = [
  {
    name: 'period_audit_log',
    sql: `CREATE TABLE IF NOT EXISTS period_audit_log (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      period               TEXT NOT NULL,           -- 动作落在哪个期间 'YYYY-MM'
      action               TEXT NOT NULL,           -- 见 lib/period-audit.js 的 PERIOD_ACTIONS
      action_label         TEXT NOT NULL,           -- 动作的中文名（**当时**的措辞，落库即冻结）
      scope                TEXT NOT NULL,           -- period / year
      scope_key            TEXT NOT NULL,           -- period 动作 = 期间；year 动作 = 'YYYY'
      status_before        TEXT,                    -- open / closed；基线条目为 NULL
      status_after         TEXT,                    -- 动作之后的状态（可为 NULL = 本动作不改状态）
      closing_voucher_id   INTEGER,
      annual_voucher_id    INTEGER,
      dist_voucher_id      INTEGER,
      voucher_doc_no       TEXT,                    -- 便于人读；不是真值来源
      amount               REAL,                    -- 结转 / 分配金额；不涉及则为 NULL
      reason               TEXT,                    -- 撤销类动作必填
      remark               TEXT,                    -- 备注（关账的 remark 落在这里）
      actor_id             INTEGER,
      actor_name           TEXT,
      actor_source         TEXT NOT NULL DEFAULT 'web',
      detail               TEXT,                    -- JSON 快照（如年结"封了哪几期"）
      created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  }
]

const INDEXES = [
  // 按期间查历史（界面展开某一行时用的就是它）
  { name: 'idx_period_audit_period', sql: 'CREATE INDEX IF NOT EXISTS idx_period_audit_period ON period_audit_log (period, id)' },
  // 按"年"查（年结 / 分配是年维度的动作）
  { name: 'idx_period_audit_scope', sql: 'CREATE INDEX IF NOT EXISTS idx_period_audit_scope ON period_audit_log (scope, scope_key, id)' },
  // 按动作 + 凭证反查（自证里"每条派生凭证都必须有日志"走这条）
  { name: 'idx_period_audit_action', sql: 'CREATE INDEX IF NOT EXISTS idx_period_audit_action ON period_audit_log (action, closing_voucher_id, annual_voucher_id, dist_voucher_id)' }
]

// 本批**不新增权限点**：能看 `/reports/periods` 的人已经能看到
// `closed_by_name` / `reopen_reason` / `closing_reverse_reason` ——
// 日志给的是同一个信息集合的**历史**，不是新的信息类别。
// 凭空多一个"审计查看权限"只会让权限表越来越长而没人维护（权限通胀
// 会让真正的授权边界被淹没），这条理由与批次 N 不给导出加权限点同源。

module.exports.up = function up(db) {
  if (!tableExists(db, 'accounting_periods')) {
    throw new Error('accounting_periods 不存在，迁移顺序有误（应先执行 034_report）')
  }
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  // ---- 基线回填：把"日志表存在之前就已经存在的状态"按现状补记一条 ----
  // 幂等：同一期间已有一条 baseline 就跳过（迁移自愈重跑时会再次执行到这里）。
  // 只给"有事可记"的期间补 —— 一个从没被关过、没有指针、也没有撤销理由的期间，
  // 它的重放结果本来就是「open / 无指针」，与空日志完全一致，补一条纯属噪音。
  const needBaseline = db
    .prepare(`
      SELECT p.* FROM accounting_periods p
       WHERE (p.status <> 'open'
              OR p.closing_voucher_id IS NOT NULL
              OR p.annual_voucher_id IS NOT NULL
              OR p.dist_voucher_id IS NOT NULL
              OR p.reopen_reason IS NOT NULL
              OR p.closing_reverse_reason IS NOT NULL
              OR p.annual_reverse_reason IS NOT NULL
              OR p.dist_reverse_reason IS NOT NULL)
         AND NOT EXISTS (
              SELECT 1 FROM period_audit_log l WHERE l.period = p.period AND l.action = 'baseline'
         )
    `)
    .all()

  const insBase = db.prepare(`
    INSERT INTO period_audit_log
      (period, action, action_label, scope, scope_key,
       status_before, status_after,
       closing_voucher_id, annual_voucher_id, dist_voucher_id,
       reason, actor_source, detail)
    VALUES (?, 'baseline', '基线（迁移时现状快照）', 'period', ?, NULL, ?, ?, ?, ?, ?, 'migration', ?)
  `)
  for (const p of needBaseline) {
    insBase.run(
      p.period,
      p.period,
      p.status,
      p.closing_voucher_id ?? null,
      p.annual_voucher_id ?? null,
      p.dist_voucher_id ?? null,
      '基线：迁移 037 引入审计日志之前，这个期间的状态就已经是这样了；本条按现状补记，**不表示任何人的动作**',
      JSON.stringify({
        closed_by: p.closed_by ?? null,
        closed_by_name: p.closed_by_name ?? null,
        closed_at: p.closed_at ?? null,
        reopen_reason: p.reopen_reason ?? null,
        closing_by_name: p.closing_by_name ?? null,
        closing_at: p.closing_at ?? null,
        closing_reverse_reason: p.closing_reverse_reason ?? null,
        annual_reverse_reason: p.annual_reverse_reason ?? null,
        dist_reverse_reason: p.dist_reverse_reason ?? null,
        remark: p.remark ?? null
      })
    )
  }

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    actions: ['baseline']
  }
  stampDef(db, '037_period_audit', def)
  return { tables: TABLES.length, indexes: INDEXES.length, baselines: needBaseline.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'period_audit_log')) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 结构不变量一：**`scope` 与 `scope_key` 必须自洽**。
  // 一期动作的 `scope_key` 就是期间本身；一年动作的 `scope_key` 是期间的前 4 位。
  // 写错不会报错，只会让"按年查历史"查不到 —— 而那正是年结最需要被查的地方。
  const badScope = db
    .prepare(`
      SELECT COUNT(*) c FROM period_audit_log
       WHERE (scope = 'period' AND scope_key <> period)
          OR (scope = 'year'   AND scope_key <> substr(period, 1, 4))
          OR scope NOT IN ('period', 'year')
    `)
    .get().c
  if (badScope > 0) return false

  // 结构不变量二：状态列的取值域。写进一个 'CLOSED' 不会报错，
  // 但重放时它会与期间表的 'closed' 永远对不上 —— 而那看起来像"数据坏了"。
  const badStatus = db
    .prepare(`
      SELECT COUNT(*) c FROM period_audit_log
       WHERE (status_before IS NOT NULL AND status_before NOT IN ('open','closed'))
          OR (status_after  IS NOT NULL AND status_after  NOT IN ('open','closed'))
    `)
    .get().c
  if (badStatus > 0) return false

  // 「动作名必须是代码认识的”这条**刻意不放这里** —— 它需要读 `PERIOD_ACTIONS`，
  // 而迁移是 CommonJS、判据是 ESM；在迁移里再写一份动作清单就是第二个定义。
  // 它落在运行时探针 `PERIOD_AUDIT_UNKNOWN_ACTION`（`lib/period-audit.js`），
  // 与 035 把"已关账必须已结转"从迁移移到探针是同一条理由。

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    actions: ['baseline']
  }
  if (defStale(db, '037_period_audit', def)) return false
  return true
}
