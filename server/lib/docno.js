/**
 * ============================================================================
 * 文件标识：server/lib/docno.js ｜ 单据号生成（编码规则 + 计数器）：`nextDocNo` / `nextDocNoAuto` 的**唯一实现**
 * ============================================================================
 * 【职责】单据号生成（编码规则 + 计数器）：`nextDocNo` / `nextDocNoAuto` 的**唯一实现**
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import dayjs from 'dayjs'
import { getDb } from '../db/index.js'

const SEQ_PAD = 4

// ---------------------------------------------------------------------------
// 旧接口（保留原签名与行为，80 处调用点零改动）
// ---------------------------------------------------------------------------

export function nextDocNo(db, prefix, table, field = 'doc_no', dateStr) {
  const d = dateStr ? dayjs(dateStr) : dayjs()
  const key = `${prefix}${d.format('YYYYMMDD')}`
  const row = db
    .prepare(`SELECT ${field} AS no FROM ${table} WHERE ${field} LIKE ? ORDER BY length(${field}) DESC, ${field} DESC LIMIT 1`)
    .get(`${key}%`)
  let seq = 1
  if (row && row.no) {
    const tail = String(row.no).slice(key.length)
    const n = parseInt(tail, 10)
    if (!Number.isNaN(n)) seq = n + 1
  }
  // 兜底：单号可能被手工/历史数据占用（如 seed 按自增序号拼号与日期脱钩），
  // 这里逐号探测直到拿到一个库里确实不存在的号，避免 UNIQUE 约束冲突。
  const existsStmt = db.prepare(`SELECT 1 AS hit FROM ${table} WHERE ${field} = ? LIMIT 1`)
  const build = (n) => `${key}${String(n).padStart(SEQ_PAD, '0')}`
  let no = build(seq)
  let guard = 0
  while (existsStmt.get(no) && guard++ < 9999) no = build(++seq)
  return no
}

export function nextBatchNo(skuCode, dateStr) {
  const d = dateStr ? dayjs(dateStr) : dayjs()
  const rand = Math.floor(Math.random() * 900 + 100)
  return `${String(skuCode).replace(/[^A-Za-z0-9]/g, '').slice(-6).toUpperCase()}${d.format('YYMM')}${rand}`
}

// ---------------------------------------------------------------------------
// 新接口：规则表驱动（模块 06 编码规则与单据编号）
// ---------------------------------------------------------------------------

/**
 * 支持的通配符。
 * 关键：日期段允许**复合写法**（{YYYYMMDD} / {YYYYMM} / {YYMM}…），
 * 按原子段贪心切分拼接。写成 {YYYY}{MM}{DD} 也等价 —— 两种都要能用，
 * 因为默认规则就是复合写法，解析器若不认就会把 {YYYYMMDD} 原样输出到单号里。
 */
const TOKEN_RE = /\{([A-Za-z][A-Za-z0-9:]*)\}/g
const ATOMS = ['YYYY', 'YY', 'MM', 'DD', 'HH', 'mm', 'SS', 'PREFIX', 'TYPE', 'ORG', 'WH', 'STORE']

/** 解析单个 token；未知 token 返回 null（调用方原样保留，让配置错误显性可见） */
function resolveToken(key, ctx, seq, seqPad) {
  if (key.startsWith('SEQ')) return pad(seq, seqPad)
  if (key.startsWith('RAND')) {
    const len = Number(key.split(':')[1] || 3)
    return pad(Math.floor(Math.random() * 10 ** len), len)
  }
  const sorted = [...ATOMS].sort((a, b) => b.length - a.length)
  let i = 0
  let out = ''
  while (i < key.length) {
    const hit = sorted.find((a) => key.startsWith(a, i))
    if (!hit) return null
    out += ctx[hit] ?? ''
    i += hit.length
  }
  return out
}

const pad = (n, len) => String(n).padStart(len, '0')

function periodKeyOf(period, d) {
  switch (period) {
    case 'none':
      return ''
    case 'year':
      return d.format('YYYY')
    case 'month':
      return d.format('YYYYMM')
    case 'day':
    default:
      return d.format('YYYYMMDD')
  }
}

/** 按作用域精确度取最合适的规则：warehouse > store > org > global */
function findRule(db, docType, { orgId = null, warehouseId = null, storeId = null } = {}) {
  const rows = db.prepare("SELECT * FROM doc_no_rules WHERE doc_type=? AND status='active'").all(docType)
  const pick = (scopeType, value) =>
    rows.find((r) => r.scope_type === scopeType && String(r.scope_value) === String(value))
  return (
    (warehouseId != null ? pick('warehouse', warehouseId) : null) ||
    (storeId != null ? pick('store', storeId) : null) ||
    (orgId != null ? pick('org', orgId) : null) ||
    rows.find((r) => r.scope_type === 'global') ||
    null
  )
}

/**
 * 规则驱动取号。序号走 doc_no_counters 计数器表并在事务内自增，
 * 不再依赖「反查最大单号反推序号」这种有竞态的做法。
 * @returns {string|null} 未配置规则时返回 null，调用方回落旧逻辑
 */
export function nextDocNoByRule(
  db,
  { docType, orgId = null, warehouseId = null, storeId = null, bizDate, table = null, field = 'doc_no' }
) {
  const rule = findRule(db, docType, { orgId, warehouseId, storeId })
  if (!rule) return null

  const type = db
    .prepare('SELECT code,name,doc_no_prefix,table_name FROM doc_types WHERE code=?')
    .get(docType)
  const d = bizDate ? dayjs(bizDate) : dayjs()
  const pkey = periodKeyOf(rule.period, d)
  const tbl = table || type?.table_name
  if (!tbl) return null

  const seqPadMatch = /\{SEQ:(\d+)\}/.exec(rule.pattern)
  const seqPad = seqPadMatch ? Number(seqPadMatch[1]) : rule.seq_pad || SEQ_PAD

  const ctx = {
    YYYY: d.format('YYYY'),
    YY: d.format('YY'),
    MM: d.format('MM'),
    DD: d.format('DD'),
    HH: d.format('HH'),
    mm: d.format('mm'),
    SS: d.format('SS'),
    PREFIX: type?.doc_no_prefix || '',
    TYPE: docType,
    ORG: orgId != null ? pad(orgId, 4) : '',
    WH: warehouseId != null ? pad(warehouseId, 4) : '',
    STORE: storeId != null ? pad(storeId, 4) : ''
  }

  const render = (seq) =>
    rule.pattern.replace(TOKEN_RE, (m, k) => resolveToken(k, ctx, seq, seqPad) ?? m)

  const existsStmt = db.prepare(`SELECT 1 AS hit FROM ${tbl} WHERE ${field} = ? LIMIT 1`)

  const allocate = db.transaction(() => {
    const cur = db
      .prepare('SELECT current_value FROM doc_no_counters WHERE rule_id=? AND period_key=?')
      .get(rule.id, pkey)
    let seq = cur ? cur.current_value : rule.seq_start - 1

    let no
    let guard = 0
    do {
      seq += 1
      no = render(seq)
    } while (existsStmt.get(no) && guard++ < 9999)

    db.prepare(
      `INSERT INTO doc_no_counters (rule_id,period_key,current_value,updated_at)
       VALUES (?,?,?,datetime('now','localtime'))
       ON CONFLICT(rule_id,period_key) DO UPDATE SET
         current_value=excluded.current_value, updated_at=excluded.updated_at`
    ).run(rule.id, pkey, seq)

    return no
  })

  return allocate()
}

/** 统一入口：有规则走规则，无规则回落旧逻辑（调用方无需关心） */
export function nextDocNoAuto(
  db = getDb(),
  { docType, orgId, warehouseId, storeId, bizDate, table, field = 'doc_no' }
) {
  const byRule = nextDocNoByRule(db, { docType, orgId, warehouseId, storeId, bizDate, table, field })
  if (byRule) return byRule

  const type = db.prepare('SELECT doc_no_prefix, table_name FROM doc_types WHERE code=?').get(docType)
  const prefix = type?.doc_no_prefix || docType
  const tbl = table || type?.table_name
  if (!tbl) throw new Error(`无法为 ${docType} 生成单号：既无规则也未注册单据类型`)
  return nextDocNo(db, prefix, tbl, field, bizDate)
}

/** 预览（不消耗序号）：界面配置规则时实时看效果 */
export function previewDocNo(
  db,
  { docType, pattern, seqPad = 4, seq = 1, bizDate, orgId = null, warehouseId = null }
) {
  const type = db.prepare('SELECT code,name,doc_no_prefix FROM doc_types WHERE code=?').get(docType)
  const d = bizDate ? dayjs(bizDate) : dayjs()
  // 模式里写了 {SEQ:n} 时以模式为准，否则用传入的 seqPad
  const padMatch = /\{SEQ:(\d+)\}/.exec(pattern)
  const realPad = padMatch ? Number(padMatch[1]) : seqPad
  const ctx = {
    YYYY: d.format('YYYY'),
    YY: d.format('YY'),
    MM: d.format('MM'),
    DD: d.format('DD'),
    HH: d.format('HH'),
    mm: d.format('mm'),
    SS: d.format('SS'),
    PREFIX: type?.doc_no_prefix || '',
    TYPE: docType,
    ORG: orgId != null ? pad(orgId, 4) : '',
    WH: warehouseId != null ? pad(warehouseId, 4) : '',
    STORE: ''
  }
  return pattern.replace(TOKEN_RE, (m, k) => {
    if (k.startsWith('RAND')) return 'x'.repeat(Number(k.split(':')[1] || 3))
    return resolveToken(k, ctx, seq, realPad) ?? m
  })
}

/** 规则清单（带计数器条数，便于判断哪些规则真的在用） */
export function listDocNoRules(db = getDb()) {
  return db
    .prepare(
      `SELECT r.*, t.name AS doc_type_name, t.table_name,
              (SELECT COUNT(*) FROM doc_no_counters c WHERE c.rule_id=r.id) AS counter_rows
       FROM doc_no_rules r
       LEFT JOIN doc_types t ON t.code=r.doc_type
       ORDER BY t.sort_order, r.scope_type`
    )
    .all()
}

export default { nextDocNo, nextBatchNo, nextDocNoByRule, nextDocNoAuto, previewDocNo, listDocNoRules }
