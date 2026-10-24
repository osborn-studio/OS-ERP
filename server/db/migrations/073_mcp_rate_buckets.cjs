'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/073_mcp_rate_buckets.cjs ｜ MCP 限速桶表 mcp_rate_buckets（roadmap-v10 AE9，ADR-0056 补充）
 * ============================================================================
 * 【职责】`GML_MCP_RATE_STORE=db` 时，MCP 按令牌的 60 秒滑动窗口计数落在这张表里，多个进程共用同一份计数、重启不清零。
 *   默认的 `memory` 模式不读写它（表存在但空着，零成本）。
 * 【结构】PRIMARY KEY (token_key, window_start, kind)：
 *   · token_key    `<行业库标识>|<令牌 id>`（与内存模式同一个键）；
 *   · window_start 固定窗口起点（毫秒，60000 的整数倍）；
 *   · kind         'all'（全部调用）| 'write'（写型调用）；
 *   · count        该窗口内已放行的调用数。
 *   计数只在 `INSERT … ON CONFLICT DO UPDATE SET count=count+1` 里递增（见 `server/lib/mcp-rate-limit.js`）。
 * 【清理】只有后台定时器按 `window_start` 清过期桶（`idx_mcp_rate_buckets_window` 保证按范围删除不扫全表），请求路径从不删。
 * 【迁移安全】CREATE TABLE/INDEX IF NOT EXISTS；表是新的，不动任何既有数据。已执行迁移不改（ADR-0009）。
 * 【改它要注意什么】COLUMNS / PK / INDEX 是 up 与 verify 的唯一来源；seed.js 的 TABLES 必须登记本表（整库重建要清桶）。
 * ============================================================================
 */
const { tableExists, hasIndex } = require('./_helpers.cjs')

module.exports.name = 'MCP 限速桶表（mcp_rate_buckets，db 存储模式）'

const TABLE = 'mcp_rate_buckets'
const INDEX = 'idx_mcp_rate_buckets_window'
const COLUMNS = ['token_key', 'window_start', 'kind', 'count']
const PK = ['token_key', 'window_start', 'kind']
module.exports.TABLE = TABLE
module.exports.INDEX = INDEX

module.exports.up = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE} (
      token_key    TEXT    NOT NULL,
      window_start INTEGER NOT NULL,
      kind         TEXT    NOT NULL CHECK (kind IN ('all','write')),
      count        INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
      PRIMARY KEY (token_key, window_start, kind)
    );
    CREATE INDEX IF NOT EXISTS ${INDEX} ON ${TABLE}(window_start);
  `)
}

module.exports.verify = (db) => {
  if (!tableExists(db, TABLE) || !hasIndex(db, INDEX)) return false
  const cols = db.prepare(`PRAGMA table_info(${TABLE})`).all()
  if (COLUMNS.some((c) => !cols.some((x) => x.name === c))) return false
  const pk = cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name)
  if (pk.join(',') !== PK.join(',')) return false
  const ix = db.prepare(`PRAGMA index_info(${INDEX})`).all().map((c) => c.name)
  return ix.length === 1 && ix[0] === 'window_start'
}
