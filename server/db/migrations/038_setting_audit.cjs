'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/038_setting_audit.cjs ｜ 迁移：配置变更留痕（settings 的变更日志 · 只追加 · 可重放）
 * ============================================================================
 * 【职责】迁移：配置变更留痕（settings 的变更日志 · 只追加 · 可重放）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 038 配置变更留痕（settings 的每一次改动都留一条可重放的记录）
//
// ===========================================================================
// 一、这一批补的是「配置改了，但没人知道它改过」
// ===========================================================================
// `settings` 从模块 20 起就在长：应收口径、备份目录、促销积分、积分抵扣上限、
// 门店长短款阈值、默认税率、结转目标科目、年结留存科目…… 十六个键。
// 而写入路径只有一条、且**什么都不做**：
//
//     INSERT INTO settings (key,value,updated_at) VALUES (?,?,...)
//       ON CONFLICT(key) DO UPDATE SET value=excluded.value, ...
//
// `settings.closing_profit_subject`（期末结转到哪个科目）被从 4103 改成别的，
// 事后没人答得出「谁改的、什么时候、原来是什么、为什么」—— 而那是**会计政策**。
//
// ===========================================================================
// 二、日志只追加，且必须与它记录的那次改动**同一个事务**
// ===========================================================================
// 与本项目既有的 `period_audit_log`（批次 Q）完全同构的两条硬口径：
//   ① **只追加**。本表没有 UPDATE / DELETE 路径，代码层面也只有一处 INSERT
//      （`lib/settings.js` 的 `logSettingChange`）—— 一旦允许修改，
//      "谁改过配置"就退化成"谁有权限改日志"。
//   ② **同事务**。写日志与改值必须在同一个 `db.transaction` 里，
//      否则"值改了但日志没写"会真的出现，而日志就从"证据"变成"说法"。
//      这条铁律写进文档没人记得，所以 `logSettingChange` 会**当场断言**
//      `db.inTransaction`，反例注入时它会先喊 `AUDIT_OUTSIDE_TX`。
//
// ===========================================================================
// 三、这一批**只建表**，不回填基线 —— 与 037 不同，这里有理由
// ===========================================================================
// 037（期间审计链）在迁移里回填 `baseline`，因为期间的状态是被**动作**驱动的
// （关账/结转/年结），而它们的动作发生在日志表存在之前，迁移只能"按现状补记"。
//
// 配置不一样：**它没有驱动者** —— 一个库建起来的那一刻，配置就该是完整的。
// 所以基线与"补齐缺失的键"这两件事统一交给运行时的一个入口
// （`lib/settings.js` 的 `ensureSettings`），好处是：
//   · **升级路径与重建路径走同一条代码**。重建会把 `settings` 与 `setting_audit_log`
//     一起清掉（两者都在 `db/seed.js` 的清理清单里），之后由 `ensureSettings` 重新补齐；
//   · 迁移里**不需要写一份键清单**。迁移是 CommonJS、定义表是 ESM，
//     在迁移里再抄一份 `[key, default]` 数组就是**第二份定义** ——
//     而"同一份判据有两个实现"正是本批要根治的东西。
//
// ===========================================================================
// 四、为什么不加权限点
// ===========================================================================
// `GET /settings` 与 `PUT /settings` 本来就限 `admin`（`routes/meta.js`），
// 日志给的是同一个信息集合的**历史**，不是新的信息类别。
// 凭空多一个"配置审计查看权限"只会让权限表越来越长而没人维护 ——
// 与批次 Q 不给期间日志加权限点、批次 N 不给报表导出加权限点，同一条理由。

const { tableExists, hasIndex, stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '配置变更留痕（settings 的变更日志 · 只追加 · 可重放）'

// ---------------------------------------------------------------------------
// 表：配置变更日志
// ---------------------------------------------------------------------------
// 每个字段都有一个"为什么非它不可"：
//   · `key` —— 配置键。**不做外键**（配置可能被登记表移除，而历史必须留下）；
//   · `action` —— 唯一写入点认的动作名（`lib/settings.js` 的 `SETTING_ACTIONS`）：
//     `baseline` / `set` / `reset`。三态必须能分开 —— 否则"恢复默认值"与
//     "手工填了一个恰好等于默认值的值"在历史里长得一模一样；
//   · `action_label` / `group_key` —— 动作与分组的**当时**中文名，刻意冗余落库：
//     日志是不可变事实，它的措辞不该随后续代码分组改名而变
//     （改名之后，去年那条日志会突然换一个说法）；
//   · `value_before` / `value_after` —— 都是**字符串**（与 `settings.value` 同形）。
//     `before` 允许为 NULL（新键首次落位／基线条目没有"之前"）；
//   · `is_danger` —— 当时这个键是不是危险配置。**必须在日志里冻结**：
//     危险等级会在以后调整，而"这次改动当时该不该写理由"是历史问题；
//   · `reason` —— 危险配置改动**必填**（判据在 `SETTING_RULES[x].is_danger`）；
//   · `actor_source` —— `web` / `mcp` / `script` / `system` / `migration`。
//     区分"人改的"与"初始化补齐的"——后者不是谁的动作。
const TABLES = [
  {
    name: 'setting_audit_log',
    sql: `CREATE TABLE IF NOT EXISTS setting_audit_log (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      key           TEXT NOT NULL,               -- 配置键（不做外键：历史必须留下）
      action        TEXT NOT NULL,               -- baseline / set / reset，见 lib/settings.js
      action_label  TEXT NOT NULL,               -- 动作的中文名（**当时**的措辞，落库即冻结）
      group_key     TEXT NOT NULL,               -- 分组（当时的，用于按域筛选历史）
      value_before  TEXT,                        -- 改动前（字符串，与 settings.value 同形）
      value_after   TEXT,                        -- 改动后
      is_danger     INTEGER NOT NULL DEFAULT 0,  -- 当时是否为危险配置（会计政策等）
      reason        TEXT,                        -- 危险配置必填
      actor_id      INTEGER,
      actor_name    TEXT,
      actor_source  TEXT NOT NULL DEFAULT 'web', -- web / mcp / script / system / migration
      detail        TEXT,                        -- JSON 快照（人读与排障；判据不读它）
      created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`
  }
]

const INDEXES = [
  // 按配置键查历史（界面展开某一个键时用的就是它）
  { name: 'idx_setting_audit_key', sql: 'CREATE INDEX IF NOT EXISTS idx_setting_audit_key ON setting_audit_log (key, id)' },
  // 按时间查（"最近改过什么"）
  { name: 'idx_setting_audit_time', sql: 'CREATE INDEX IF NOT EXISTS idx_setting_audit_time ON setting_audit_log (created_at)' },
  // 按动作 + 危险等级查（"有哪些会计政策被改过、理由写了没"走这条）
  { name: 'idx_setting_audit_action', sql: 'CREATE INDEX IF NOT EXISTS idx_setting_audit_action ON setting_audit_log (action, is_danger)' }
]

module.exports.up = function up(db) {
  if (!tableExists(db, 'settings')) {
    throw new Error('settings 不存在，迁移顺序有误（应先在基础建表/schema.sql 里创建）')
  }
  for (const t of TABLES) db.exec(t.sql)
  for (const ix of INDEXES) db.exec(ix.sql)

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    // 只登记"结构"，动作清单**刻意不放这里** —— 它需要读 `SETTING_ACTIONS`，
    // 而迁移是 CommonJS、定义是 ESM；在迁移里再写一份动作清单就是第二个定义。
    // 它落在运行时探针 `SETTING_AUDIT_UNKNOWN_ACTION`（`lib/settings.js`），
    // 与 035 把"已关账必须已结转"从迁移移到探针是同一条理由。
    actions: ['baseline', 'set', 'reset']
  }
  stampDef(db, '038_setting_audit', def)
  return { tables: TABLES.length, indexes: INDEXES.length }
}

module.exports.verify = function verify(db) {
  if (!tableExists(db, 'setting_audit_log')) return false
  for (const ix of INDEXES) if (!hasIndex(db, ix.name)) return false

  // 结构不变量：`is_danger` 的取值域。写进一个 `'yes'` 不会报错，
  // 但"这条改动当时是不是危险配置"从此就没有确定答案了。
  const badDanger = db
    .prepare('SELECT COUNT(*) c FROM setting_audit_log WHERE is_danger NOT IN (0,1)')
    .get().c
  if (badDanger > 0) return false

  // 结构不变量：改动的两个端点不能"改了个没变的值"。
  // 唯一写入点在写入前就会拦（`changed:false` 不写日志），这里守的是"有人绕过写入点"。
  // 基线条目 `before` 本来就可以为空，所以只查 `set` / `reset`。
  const badNoop = db
    .prepare(`SELECT COUNT(*) c FROM setting_audit_log
               WHERE action IN ('set','reset') AND value_before IS value_after`)
    .get().c
  if (badNoop > 0) return false

  const def = {
    tables: TABLES.map((t) => t.name),
    indexes: INDEXES.map((x) => x.name),
    actions: ['baseline', 'set', 'reset']
  }
  if (defStale(db, '038_setting_audit', def)) return false
  return true
}
