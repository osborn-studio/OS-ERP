/**
 * ============================================================================
 * 文件标识：scripts/lib/explain-plan-guard.mjs ｜ 查询计划指纹：归一化、快照、漂移比较（roadmap-v12 AG3，ADR-0044 补充 6）
 * ============================================================================
 * 【职责】explain-audit 的 expectIndex / expectSearch 只断言"用了某个索引"；这里把**整条**计划存档，任何偏离都报红：
 *   · normalisePlanDetail：EXPLAIN QUERY PLAN 一行 → 去掉字面量 / 参数标记 / 子计划编号 / 多余空白后的稳定文本；
 *   · fingerprintsFromAudit：auditStatements 的结果 → { 语句 id: { lines（按层级缩进）, hash（sha256 前 16 位） } }；
 *   · buildSnapshot / compareSnapshot：生成 docs/implementation/explain-plans.json，并在 CI 里按语句 id 比较。
 *
 * 【设计要点】
 *   · 指纹与数据无关：应用从不跑 ANALYZE，没有 sqlite_stat1 时规划器按固定启发式选计划，所以在"小合成库"上取的指纹等于大库上的计划形状。
 *     比较时若库里有 sqlite_stat1 直接拒绝（统计会改计划，对比无意义）。
 *   · 归一化只去"随 SQLite 版本 / 绑定值会变的部分"：字面量、?NNN / :name 参数、子计划编号（SUBQUERY 2、MATERIALIZE 3 → #）、比较运算符后的数值常量；
 *     表名、索引名、扫描 / 搜索类型、覆盖 / 临时 B-tree 行、嵌套深度都保留——它们正是要守的东西。
 *   · 白名单是"被接受的那一个新指纹"：条目 { statement, accepted_hash, reason }，hash 绑定被接受的新计划（删除用 'removed'），
 *     理由至少 20 个字符；之后同一语句的**另一个**新计划不被放行；语句没有漂移时条目算过期、同样报红（重取快照时随之清空）。
 *   · SQLite 版本、迁移号只写进快照并在比较时作为提示（notes），本身不判红：版本差异导致的措辞变化要重取快照（见 query-planner.md）。
 * 【改它要注意】改归一化规则会让所有指纹变化，必须同时重取并提交快照。
 * ============================================================================
 */
import crypto from 'node:crypto'

export const SNAPSHOT_VERSION = 1
const HASH_RE = /^[0-9a-f]{16}$/
const MIN_REASON = 20

/** 一行计划明细 → 稳定文本 */
export function normalisePlanDetail(detail) {
  let s = String(detail).replace(/\s+/g, ' ').trim()
  s = s.replace(/'(?:[^']|'')*'/g, '?') // 单引号字符串字面量
  s = s.replace(/\?\d+/g, '?').replace(/(?<![\w])[:@$][A-Za-z_]\w*/g, '?') // ?NNN、:name、@name、$name
  // 只替换"会随 SQLite 版本 / 查询文本变化"的数字：子计划编号，以及比较运算符后的数值常量。
  // 其余数字保留——例如虚表策略 `VIRTUAL TABLE INDEX 64:M1` 与 `192:M1`（FTS 升序 / 降序）是不同的计划（Codex 审计 AG3）。
  s = s.replace(/\b(SUBQUERY|MATERIALIZE|CO-ROUTINE)\s+\d+/g, '$1 #')
  s = s.replace(/(?<=[=<>])\s*-?\d+(?:\.\d+)?(?![\w])/g, '?')
  return s
}

const hashOf = (lines) => crypto.createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)

/** auditStatements().statements → { id: { lines, hash } }；被跳过的语句（缺可选表）不进指纹 */
export function fingerprintsFromAudit(statements) {
  const out = {}
  for (const s of statements) {
    if (s.skipped) continue
    const lines = s.plan.map((d, i) => `${'  '.repeat(s.depths?.[i] ?? 0)}${normalisePlanDetail(d)}`)
    out[s.id] = { lines, hash: hashOf(lines) }
  }
  return out
}

export function buildSnapshot({ fingerprints, latestMigration, sqliteVersion, generator }) {
  const ids = Object.keys(fingerprints).sort()
  const statements = {}
  for (const id of ids) statements[id] = { hash: fingerprints[id].hash, plan: fingerprints[id].lines }
  return {
    snapshot_version: SNAPSHOT_VERSION,
    note: 'Plan fingerprints (normalised EXPLAIN QUERY PLAN) of the statements registered in scripts/explain-audit.mjs. Whitelist entries need statement, accepted_hash (the new fingerprint hash, or "removed") and a reason of at least 20 characters.',
    generator,
    latest_migration: latestMigration,
    sqlite_version: sqliteVersion,
    statement_count: ids.length,
    whitelist: [],
    statements
  }
}

function checkWhitelist(snapshot) {
  const list = snapshot.whitelist ?? []
  if (!Array.isArray(list)) throw new Error('whitelist 必须是数组')
  const seen = new Set()
  for (const w of list) {
    if (w && seen.has(w.statement)) throw new Error(`whitelist 对语句 ${w.statement} 有重复条目（每条语句只能有一个被接受的新计划）`)
    if (w) seen.add(w.statement)
    if (!w || typeof w.statement !== 'string' || !w.statement) throw new Error('whitelist 条目缺 statement')
    if (typeof w.reason !== 'string' || w.reason.trim().length < MIN_REASON) throw new Error(`whitelist ${w.statement} 必须写理由 reason（至少 ${MIN_REASON} 个字符）`)
    if (w.accepted_hash !== 'removed' && !HASH_RE.test(String(w.accepted_hash))) throw new Error(`whitelist ${w.statement} 的 accepted_hash 必须是 16 位十六进制或 "removed"`)
  }
  return list
}

/**
 * snapshot：已提交快照；current：{ fingerprints, latestMigration, sqliteVersion, hasStat1 }
 * 返回 { ok, drifts:[{statement,kind,before,after,beforeHash,afterHash,whitelisted,note?}], staleWhitelist, notes }
 */
export function compareSnapshot(snapshot, current) {
  if (snapshot?.snapshot_version !== SNAPSHOT_VERSION || typeof snapshot.statements !== 'object') throw new Error(`快照格式不符（snapshot_version 应为 ${SNAPSHOT_VERSION}）`)
  if (current.hasStat1) throw new Error('库里存在 sqlite_stat1（执行过统计收集），统计信息会改变计划，指纹不可比；请用没有统计表的库')
  const list = checkWhitelist(snapshot)
  const ids = new Set([...Object.keys(snapshot.statements), ...Object.keys(current.fingerprints)])
  for (const w of list) if (!ids.has(w.statement)) throw new Error(`whitelist 指向未知语句 ${w.statement}（过期条目，删掉它）`)
  const drifts = []
  for (const id of [...ids].sort()) {
    const was = snapshot.statements[id]
    const now = current.fingerprints[id]
    if (was && now && was.hash === now.hash) continue
    const kind = !was ? 'added' : !now ? 'removed' : 'changed'
    const afterHash = now ? now.hash : 'removed'
    const entry = list.find(w => w.statement === id)
    const whitelisted = !!entry && entry.accepted_hash === afterHash
    drifts.push({ statement: id, kind, before: was?.plan ?? [], after: now?.lines ?? [], beforeHash: was?.hash ?? null, afterHash, whitelisted,
      note: entry && !whitelisted ? `白名单条目绑定的是 ${entry.accepted_hash}，当前指纹是 ${afterHash}——不是被接受的那个计划` : undefined })
  }
  const driftIds = new Set(drifts.map(d => d.statement))
  const staleWhitelist = list.filter(w => !driftIds.has(w.statement))
  const notes = []
  if (snapshot.latest_migration !== current.latestMigration) notes.push(`migration differs: snapshot ${snapshot.latest_migration}, database ${current.latestMigration}`)
  if (snapshot.sqlite_version !== current.sqliteVersion) notes.push(`sqlite version differs: snapshot ${snapshot.sqlite_version}, runtime ${current.sqliteVersion} (if only plan wording changed, regenerate the snapshot)`)
  return { ok: drifts.every(d => d.whitelisted) && staleWhitelist.length === 0, drifts, staleWhitelist, notes }
}
