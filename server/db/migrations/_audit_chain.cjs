'use strict'
/**
 * ============================================================================
 * 文件标识：server/db/migrations/_audit_chain.cjs ｜ 审计日志哈希链的唯一规范化与哈希函数（ADR-0049，迁移 068 与运行时共用）
 * ============================================================================
 * 【职责】定义 `audit_logs.row_hash` 的计算：
 *     row_hash = sha256( JSON.stringify([id, created_at, user_id, action, entity, entity_id, detail, prev_hash]) )
 *   其中八个分量**全部先转成字符串（NULL 保持 null）**再做 JSON 数组序列化，`prev_hash` 为前一行的 row_hash，
 *   链头（库里最早的一行）用 64 个 '0'（GENESIS）。
 *
 * 【为什么是 .cjs、为什么放在迁移目录】迁移（.cjs，同步 require）要在回填时算同一个哈希，运行时 `audit-trail.js`（ESM）要在写入时算；
 *   两处必须逐字节一致，所以只有这一份实现，ESM 侧经 createRequire 引用它。放在迁移目录里（与 `_helpers.cjs` 同类的下划线辅助文件）是因为
 *   升级演练 / 基准脚本会把整个迁移目录复制到临时位置再跑，迁移不能依赖目录外的相对路径。
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

const BATCH = 20000

/**
 * 把**最后一条已入链的行之后**的所有行（它们的 row_hash 必然都是空）按 id 升序接到链尾；一条已入链的行都没有时即整表回填。
 * 返回处理行数。**只接尾部**：夹在已入链行中间的空 row_hash 不动（那是已建立的链被破坏，交给校验器报 `unchained`，
 * 不能让启动自愈把"被改过的内容"重算成合法哈希）。调用方负责事务 / 写锁。
 */
function adoptOrphans(db) {
  const last = db.prepare('SELECT id, row_hash FROM audit_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get()
  let prev = last ? last.row_hash : GENESIS
  let cursor = last ? last.id : 0
  const page = db.prepare('SELECT id, created_at, user_id, action, entity, entity_id, detail FROM audit_logs WHERE id > ? ORDER BY id LIMIT ?')
  const update = db.prepare('UPDATE audit_logs SET prev_hash=?, row_hash=? WHERE id=?')
  let n = 0
  for (;;) {
    const rows = page.all(cursor, BATCH)
    if (!rows.length) break
    for (const r of rows) {
      const h = hashRow(r, prev)
      update.run(prev, h, r.id)
      prev = h
      n += 1
    }
    cursor = rows[rows.length - 1].id
  }
  return n
}

/** 尾部是否有待接链的行（迁移 verify() 用：有 ⇒ 需要自愈） */
function hasOrphanTail(db) {
  const last = db.prepare('SELECT id FROM audit_logs WHERE row_hash IS NOT NULL ORDER BY id DESC LIMIT 1').get()
  return !!db.prepare('SELECT 1 FROM audit_logs WHERE id > ? LIMIT 1').get(last ? last.id : 0)
}

/**
 * 锚点是否承认"这一行的 prev_hash 与前一行 row_hash 对不上"：锚点必须同时绑定 ① 这一行的 prev_hash（anchor_hash）、
 * ② 实际的前驱行（prev_id + prev_row_hash；表里没有前驱 ⇒ 两者为 NULL）。只绑哈希的话，已有锚点会连带放过
 * 锚点之前被额外删掉的行（审计 AB6-H1）。
 */
function anchorAccepts(anchors, row, prevRowId, prevRowHash) {
  if (!anchors) return false
  return anchors.some((a) => a.anchor_hash === row.prev_hash && (a.prev_id ?? null) === (prevRowId ?? null) && (a.prev_row_hash ?? null) === (prevRowHash ?? null))
}

module.exports = { GENESIS, canonical, hashRow, adoptOrphans, hasOrphanTail, anchorAccepts }
