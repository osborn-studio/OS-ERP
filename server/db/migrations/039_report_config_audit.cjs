'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/039_report_config_audit.cjs ｜ 迁移：报表口径变更留痕（会计政策的每一次改动 · 整行快照 · 只追加 · 可重放）
 * ============================================================================
 * 【职责】迁移：报表口径变更留痕（会计政策的每一次改动 · 整行快照 · 只追加 · 可重放）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 039 报表口径变更留痕（report_defs / report_lines 的每一次改动都留一条可重放的记录）
//
// ===========================================================================
// 一、这一批补的是「会计政策被人改过，但只有一行"保存成功"」
// ===========================================================================
// `034_report` 把报表结构从代码里搬进了库，理由是**它是会计政策**：
// 科目区间与方向口径决定"哪些科目算进哪一行"，改一行能让同一份账算出不同的利润。
// 对应的接口也建了（`PUT /reports/defs/{code}` / `POST /reports/lines` /
// `DELETE /reports/lines/{id}`），开放的注释里写着一句承诺：
//
//     「会计政策，可审计、可追溯改过什么」
//
// 而实际落下来的只有一条通用审计：
//
//     audit(req, { action: 'finance.report.line.save',
//                  target: `report_line:${row.report_code}/${row.line_code}`,
//                  detail: { line_no: row.line_no } })          ← 只有一个行号
//
//     audit(req, { action: 'finance.report.line.delete',
//                  target: `report_line:${req.params.id}` })    ← 只有一个自增 id
//
// 三个具体后果，都是"事后答不出来"：
//   · **删掉一行之后再问"删了什么"，查不出来**。`report_lines` 是物理删除，
//     日志里只有 `report_line:37`，而 37 已经不存在了 —— 日志指向一个空。
//     删掉的可能正是"销售商品收到的现金"那行的一个科目区间。
//   · **改了什么，看不出来**。日志只记 `line_no`。把 `subject_range` 从
//     `'1122~1122'` 改成 `'1122~1122|2203~2203'`、或把 `sign` 从 +1 改成 −1、
//     或往资产负债表上加一行 `only_direction` —— 三种改动留下的记录完全一样。
//   · **报表定义（`basis` / `cash_subjects` / `cover_categories`）只有 basis 有痕**，
//     而 `cover_categories` 决定"这张表必须穷尽覆盖哪些科目大类"（少覆盖一个大类
//     就是少一块钱，且 `auditReport` 的覆盖探针会报 —— 但报的是"现在不对"，
//     不是"谁在什么时候改的"）。
//
// ===========================================================================
// 二、为什么这一批的「危险」判据与批次 R 不同（不是照抄）
// ===========================================================================
// 批次 R 里危险是**键的属性**（`SETTING_RULES[key].is_danger`）—— 因为一个键
// 的含义是固定的：`closing_profit_subject` 永远是会计政策。
//
// 这里不行：`report_lines` 的行是**会变的**，同一行 `line_name` 从"存货"改成
// "库存商品"是纯展示，而它的 `subject_range` 从 `'1405~1405'` 改成 `'1405~1408'`
// 是会计政策。危险不是"这一行危险"，而是**这一次改动动了哪个字段**。
//
// 所以本条目的判据是**差分驱动**的（`isDangerChange`）：
//
//     危险 ⇔ 动作是 delete，或 changed_fields 与 REPORT_CONFIG_DANGER_FIELDS 有交集
//
// 一条统一规则，**不为 create 特判**：新增一行必然带上 `subject_range` 或
// `subtotal_expr`（两者都在危险集里），于是"加一行口径"天然需要理由 ——
// 这是对的，加一行会让报表多一块，它同样在改会计政策。
//
// 反面：只改 `line_name` / `display_no` / `level` / `order_no` / `remark`
// **不需要**理由 —— 那些字段不进任何金额。要求给它们写理由只会训练人写"调整显示"，
// 而理由一旦可以随便填，它就退化成噪音（与批次 R 拒绝给 `reset` 自动补
// 一句"恢复默认值"同一条理由）。
//
// ===========================================================================
// 三、日志存**整行快照**，不是字段差分
// ===========================================================================
// 期间审计链（批次 Q）存的是"指针字段的改后值"，因为期间的状态是**四个字段**。
// 报表口径的状态是**一百多行**，差分表达不了 `create` / `delete`，
// 而 `delete` 又恰恰是最需要留完整内容的那一种。
//
// 于是这里每次记录存两份整行 JSON（`snapshot_before` / `snapshot_after`）：
//   · `baseline` —— before 为 NULL，after = 当时那一行的全部字段；
//   · `create`   —— before 为 NULL，after = 新建出来的全部字段；
//   · `update`   —— 两侧都有，`changed_fields` 列出真正变了的列；
//   · `delete`   —— before = 被删掉的**全部字段**，after 为 NULL。
//
// 一份快照同时解决三件事：删除后仍答得出"删的是什么"、重放能重建整张表、
// 「改前改后」能并排显示。代价是存储 —— 一百多行 × 每行几百字节，
// 而这个代价换的是"会计政策的历史"，划算。
//
// ===========================================================================
// 四、重放：从空状态重建整张表（比期间链更强的一条不变量）
// ===========================================================================
// 期间链的不变量是"重放 == 四个字段"。这里的是：
//
//     从空状态开始，按 id 顺序应用每一条日志，得到的必须是今天
//     `report_defs` + `report_lines` 的**全部内容**（逐行、逐字段）。
//
// 两条路径的出处不同：现状来自 `saveReportDef` / `saveReportLine` /
// `deleteReportLine` 的 `INSERT`/`DELETE`，历史来自 `logReportConfigChange`
// 写下的快照。所以它抓得到"改了没记""记了没改"。
//
// 盲区要划清（批次 P 的教训：先问两条路径**共享**什么）：
//   · 两者共享"身份键"（`report_code` / `line_code`）。若身份键的确定方式错了，
//     两边一起错 —— 由 `REPORT_CONFIG_FIELD_GAP`（表列必须全被声明）与
//     `REPORT_CONFIG_AUDIT_SNAPSHOT_MISSING`（快照必须整份）从侧面守着。
//   · 抓不到"有人既没改库也没写日志" —— 那在留痕上**不存在**（没有状态可藏）。
//   · 抓不到"有人绕过写入点直接 `UPDATE` 了库、又恰好把值改成与历史一致的"，
//     但那种改动等于没改。
//
// ===========================================================================
// 五、`SNAPSHOT_FIELDS` 是显式代价，而且它被探针守着
// ===========================================================================
// 快照存的是"当时那一行的全部字段"，而字段清单写在 `SNAPSHOT_FIELDS` 里。
// 以后 `034`/后续迁移给 `report_lines` 加了一列而没人登记它，那一列就
// **既不在留痕范围、也不在重放比对范围** —— 这是一个安静扩大的盲区。
//
// 所以 `REPORT_CONFIG_FIELD_GAP` 探针直接对比 `PRAGMA table_info` 与
// `SNAPSHOT_FIELDS`：表里有、清单里没有的列 ⇒ 报出来。
// 「唯一出处」这件事必须能被机器核对，不能只写在注释里（批次 P 的教训）。
//
// ===========================================================================
// 六、为什么不加权限点
// ===========================================================================
// 改口径本来就限 `finance.report.config`；看历史复用 `finance.report.view` ——
// 能看报表的人已经能看到口径本身（`GET /reports/defs/{code}/lines`），
// 日志给的是同一个信息集合的**历史**，不是新的信息类别。
// 与批次 Q 不给期间日志加权限点、批次 R 不给配置日志加权限点，同一条理由。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '报表口径变更留痕（会计政策的每一次改动 · 整行快照 · 只追加 · 可重放）'

// ---------------------------------------------------------------------------
// 表：报表口径变更日志
// ---------------------------------------------------------------------------
// 每个字段都有一个"为什么非它不可"：
//   · `target_type` / `report_code` / `line_code` —— 这一条记录的是
//     **一张报表的定义**还是**其中的一行**，以及它的身份键。
//     `line_code` 对 def 记录为 NULL（不做外键：报表或行可以整张消失，历史必须留下）；
//   · `action` —— 唯一写入点认的动作名（`lib/report-config-audit.js` 的
//     `REPORT_CONFIG_ACTIONS`）：`baseline` / `create` / `update` / `delete`；
//   · `action_label` —— 动作的**当时**中文名，刻意冗余落库：日志是不可变事实，
//     它的措辞不该随后续代码改名而变（改名之后去年那条日志会突然换一个说法）；
//   · `snapshot_before` / `snapshot_after` —— **整行 JSON**。见文件头第三节。
//     `delete` 记录的 `snapshot_before` 是这一行唯一还能被查到的地方 ——
//     `report_lines` 是物理删除，不留这个就等于没留痕；
//   · `changed_fields` —— JSON 数组，`update` 时给出真正变了的列名。
//     界面靠它显示"改了哪几列"，判据靠它算危险等级；
//   · `is_danger` —— 这次改动**当时**是否危险（判据 `isDangerChange`）。
//     **必须在日志里冻结**：危险字段集以后会调整，而"这次改动当时该不该写理由"
//     是历史问题（与批次 R 的 `is_danger` 同一条理由）；
//   · `reason` —— 危险改动必填；
//   · `actor_source` —— `web` / `mcp` / `script` / `system`。
//     区分"人改的"与"初始化补的"——后者不是谁的动作。
const TABLES = [
  {
    name: 'report_config_audit_log',
    sql: `CREATE TABLE IF NOT EXISTS report_config_audit_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      target_type     TEXT NOT NULL,               -- def / line
      report_code     TEXT NOT NULL,               -- 报表代码（不做外键：历史必须留下）
      line_code       TEXT,                        -- 报表行的机器键；def 记录为 NULL
      action          TEXT NOT NULL,               -- baseline / create / update / delete
      action_label    TEXT NOT NULL,               -- 动作的中文名（当时的措辞，落库即冻结）
      snapshot_before TEXT,                        -- 改动前**整行** JSON（delete 记录唯一的内容来源）
      snapshot_after  TEXT,                        -- 改动后**整行** JSON
      changed_fields  TEXT,                        -- JSON 数组：update 时真正变了的列
      is_danger       INTEGER NOT NULL DEFAULT 0,  -- 当时是否为危险改动（会计政策）
      reason          TEXT,                        -- 危险改动必填
      actor_id        INTEGER,
      actor_name      TEXT,
      actor_source    TEXT NOT NULL DEFAULT 'web', -- web / mcp / script / system
      detail          TEXT,                        -- JSON 快照（人读与排障；判据不读它）
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  }
]

const INDEXES = [
  // 按目标查历史（界面展开某一行口径时用的就是它）
  { name: 'idx_report_cfg_audit_target', sql: 'CREATE INDEX IF NOT EXISTS idx_report_cfg_audit_target ON report_config_audit_log (target_type, report_code, line_code, id)' },
  // 按时间查（"最近改过什么"）
  { name: 'idx_report_cfg_audit_time', sql: 'CREATE INDEX IF NOT EXISTS idx_report_cfg_audit_time ON report_config_audit_log (created_at)' },
  // 按动作 + 危险等级查（"有哪些会计政策被改过、理由写了没"走这条）
  { name: 'idx_report_cfg_audit_action', sql: 'CREATE INDEX IF NOT EXISTS idx_report_cfg_audit_action ON report_config_audit_log (action, is_danger)' }
]

const ACTIONS = ['baseline', 'create', 'update', 'delete']

module.exports.up = function up(db) {
  if (!tableExists(db, 'report_lines')) {
    throw new Error('report_lines 不存在，迁移顺序有误（应先在 034_report 里创建报表体系）')
  }
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    // 只登记"结构"，动作清单与字段清单**刻意不放这里** —— 它们需要读
    // `lib/report-config-audit.js` 的 ESM 定义，在迁移里再抄一份就是第二个定义。
    // 它们落在运行时探针（`REPORT_CONFIG_AUDIT_UNKNOWN_ACTION` / `REPORT_CONFIG_FIELD_GAP`），
    // 与 035 把"已关账必须已结转"从迁移移到探针、038 不把动作清单放进迁移，同一条理由。
    actions: ACTIONS
  }
  stampDef(db, '039_report_config_audit', def)
  return { tables: TABLES.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'report_config_audit_log')) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 结构不变量：`is_danger` 的取值域。写进一个 `'yes'` 不会报错，
  // 但"这次改动当时是不是危险改动"从此就没有确定答案了。
  const badDanger = db
    .prepare('SELECT COUNT(*) c FROM report_config_audit_log WHERE is_danger NOT IN (0,1)')
    .get().c
  if (badDanger > 0) return false

  // 结构不变量：`target_type` 的取值域。多一个 `'sheet'` 会让按类型筛选历史
  // 安静地漏掉一类记录。
  const badType = db
    .prepare("SELECT COUNT(*) c FROM report_config_audit_log WHERE target_type NOT IN ('def','line')")
    .get().c
  if (badType > 0) return false

  // 结构不变量：**快照的完整性**。这一条是"删除后还查得到删了什么"的机械保证 ——
  // `create` 必须留 after、`delete` 必须留 before，缺一个就是一条**指向空**的记录
  // （正是这一批要根治的原始缺陷：原来删除只记 `report_line:37`）。
  const badSnap = db
    .prepare(`SELECT COUNT(*) c FROM report_config_audit_log
               WHERE (action='create' AND (snapshot_after IS NULL OR trim(snapshot_after)=''))
                  OR (action='delete' AND (snapshot_before IS NULL OR trim(snapshot_before)=''))
                  OR (action='baseline' AND (snapshot_after IS NULL OR trim(snapshot_after)=''))
                  OR (action='update' AND (snapshot_before IS NULL OR snapshot_after IS NULL))`)
    .get().c
  if (badSnap > 0) return false

  // 结构不变量：`delete` 必须带理由（删除一行口径是最不可逆的一种改动）。
  // 唯一写入点在写入前就会拦，这里守的是"有人绕过写入点往日志里塞"。
  const badDel = db
    .prepare(`SELECT COUNT(*) c FROM report_config_audit_log
               WHERE action='delete' AND (reason IS NULL OR trim(reason)='')`)
    .get().c
  if (badDel > 0) return false

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    actions: ACTIONS
  }
  if (defStale(db, '039_report_config_audit', def)) return false
  return true
}
