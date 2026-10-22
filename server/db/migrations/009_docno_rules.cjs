'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/009_docno_rules.cjs ｜ 迁移：编码规则 doc_no_rules 与编号计数器 doc_no_counters
 * ============================================================================
 * 【职责】迁移：编码规则 doc_no_rules 与编号计数器 doc_no_counters
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自迁移定义**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 009 编码规则与单据编号（模块 06）
//
// 现状（server/lib/docno.js）：前缀 + 日期 + 序号，序号靠「查最后一条 + 探测占位」得出。
//   问题：① 规则写死在代码里，改格式要动代码；
//        ② 序号不分场景（同一前缀在总部与门店共用一个序列）；
//        ③ 无并发保护意识（现在是单写者 + WAL + busy_timeout，但序号取号本身非原子）；
//        ④ 无法按组织/仓库分段编号。
//
// 本迁移把编号规则变成数据：doc_no_rules（规则）+ doc_no_counters（计数器）。
//   兼容策略：nextDocNo() 原签名与行为完全保留（老代码零改动）；
//   新增 nextDocNoByRule()，对已配置规则的单据类型走规则表，未配置的自动回落旧逻辑。
//   这样脚本可渐进迁移，不会一次改动引爆 80 处调用点。

const { stampDef, defStale } = require('./_helpers.cjs')

module.exports.name = '编码规则 doc_no_rules 与编号计数器 doc_no_counters'

// 默认编号模式属于「定义」：与 008 同样接入指纹，
// 改了默认 pattern / 周期 / 起始序号，重跑迁移就能被自检发现并同步。
// 注意只能用 ON CONFLICT DO NOTHING —— 线上可能已有按组织/仓库分段的自定义规则，
// 以及已被演示改过的参数，重跑只补缺、不覆盖。
const DEFAULT_PATTERN = '{PREFIX}{YYYYMMDD}{SEQ:4}'
const DEFAULT_PERIOD = 'day'
const DEFAULT_PAD = 4
const DEFAULT_START = 1

module.exports.up = function up(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS doc_no_rules (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_type    TEXT NOT NULL,
      name        TEXT,
      scope_type  TEXT NOT NULL DEFAULT 'global',   -- global / org / warehouse / store
      scope_value TEXT NOT NULL DEFAULT '',         -- 对应 scope_type 的 id；global 为空串
      pattern     TEXT NOT NULL,                    -- 例：{PREFIX}{YYYYMMDD}{SEQ:4}
      period      TEXT NOT NULL DEFAULT 'day',      -- 序号归零周期：none / day / month / year
      seq_pad     INTEGER NOT NULL DEFAULT 4,
      seq_start   INTEGER NOT NULL DEFAULT 1,
      status      TEXT NOT NULL DEFAULT 'active',
      remark      TEXT,
      created_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE (doc_type, scope_type, scope_value)
    );

    -- 计数器按「规则 + 周期键」一行，取号时在同一事务内 UPSERT 自增，
    -- 不再依赖「查最大单号反推序号」这种有竞态的做法
    CREATE TABLE IF NOT EXISTS doc_no_counters (
      rule_id       INTEGER NOT NULL,
      period_key    TEXT NOT NULL,
      current_value INTEGER NOT NULL DEFAULT 0,
      updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (rule_id, period_key)
    );

    CREATE INDEX IF NOT EXISTS idx_doc_no_rules_type ON doc_no_rules(doc_type, scope_type, status);
  `)

  // ---------- 按单据类型注册表批量生成默认规则 ----------
  // 默认与旧编号格式保持一致（前缀 + 8 位日期 + 4 位序号），确保新旧混用不冲突
  const types = db
    .prepare("SELECT code, name, doc_no_prefix FROM doc_types WHERE status='active' AND doc_no_prefix IS NOT NULL AND doc_no_prefix<>''")
    .all()

  const ins = db.prepare(`
    INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start,remark)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(doc_type,scope_type,scope_value) DO NOTHING
  `)
  let created = 0
  for (const t of types) {
    ins.run(
      t.code,
      `${t.name}编号规则`,
      'global',
      '',
      DEFAULT_PATTERN,
      DEFAULT_PERIOD,
      DEFAULT_PAD,
      DEFAULT_START,
      '默认规则，与既有单号格式兼容'
    )
    created += 1
  }

  stampDef(db, '009_docno_rules', { DEFAULT_PATTERN, DEFAULT_PERIOD, DEFAULT_PAD, DEFAULT_START })

  return { rules: created, doc_types: types.length }
}

module.exports.verify = function verify(db) {
  const a = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_no_rules'").get()
  const b = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='doc_no_counters'").get()
  if (!a || !b) return false

  // 不变量：凡登记了单号前缀的单据类型，都必须有全局取号规则。
  // 这样新增单据类型后（改 008 的 DOC_TYPES），重跑迁移会自动补出规则，
  // 不会出现「类型注册了但取不到号」的半成品状态。
  const missing = db
    .prepare(
      `SELECT COUNT(*) c FROM doc_types t
       WHERE t.doc_no_prefix IS NOT NULL AND t.doc_no_prefix<>''
         AND NOT EXISTS (
           SELECT 1 FROM doc_no_rules r
           WHERE r.doc_type=t.code AND r.scope_type='global' AND r.status='active'
         )`
    )
    .get().c
  if (missing !== 0) return false

  // 定义指纹：默认编号模式改了也要能同步进库
  if (defStale(db, '009_docno_rules', { DEFAULT_PATTERN, DEFAULT_PERIOD, DEFAULT_PAD, DEFAULT_START })) {
    return false
  }
  return true
}
