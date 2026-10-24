'use strict'
/**
 * ============================================================================
 * 文件标识：server/lib/audit-chain.cjs ｜ 审计日志哈希链的唯一规范化与哈希函数（ADR-0049，迁移 068 与运行时共用）
 * ============================================================================
 * 【职责】定义 `audit_logs.row_hash` 的计算：
 *     row_hash = sha256( JSON.stringify([id, created_at, user_id, action, entity, entity_id, detail, prev_hash]) )
 *   其中八个分量**全部先转成字符串（NULL 保持 null）**再做 JSON 数组序列化，`prev_hash` 为前一行的 row_hash，
 *   链头（库里最早的一行）用 64 个 '0'（GENESIS）。
 *
 * 【为什么是 .cjs】迁移（.cjs，同步 require）要在回填时算同一个哈希，运行时 `audit-trail.js`（ESM）要在写入时算；
 *   两处必须逐字节一致，所以只有这一份实现，ESM 侧 `import` 它。
 *
 * 【为什么用 JSON 数组而不是拼接分隔符】数组序列化自带分量边界（引号、逗号），`action='a|b',entity='c'` 与
 *   `action='a',entity='b|c'` 不会撞同一个输入；NULL 与字符串 "null" 也不同（前者序列化为 null，后者为 "null"）。
 * 【为什么转字符串】SQLite 列亲和性会把 `user_id='5'` 存成整数 5、把数字 action 存成文本；
 *   写入时用绑定值算、校验时用读回值算，必须落在同一个字符串上，否则合法行会被误报断点。
 *
 * 【不覆盖的列】user_name / module / ip 不进哈希（规格如此，见 ADR-0049「限制」）。
 * 【改它要注意什么】这是链的**格式版本**：改动任何一个字节都会让全部既有行校验失败。要改格式必须新开迁移重算。
 * ============================================================================
 */
const crypto = require('node:crypto')

const GENESIS = '0'.repeat(64)
const str = (v) => (v === null || v === undefined ? null : String(v))

/** 行 → 规范化字符串（哈希输入）。`row` 取 DB 读回形态或写入绑定形态均可 */
function canonical(row, prevHash) {
  return JSON.stringify([
    str(row.id), str(row.created_at), str(row.user_id), str(row.action),
    str(row.entity), str(row.entity_id), str(row.detail), str(prevHash)
  ])
}

function hashRow(row, prevHash) {
  return crypto.createHash('sha256').update(canonical(row, prevHash), 'utf8').digest('hex')
}

module.exports = { GENESIS, canonical, hashRow }
