/**
 * ============================================================================
 * 文件标识：server/lib/audit-anchor-intent.js ｜ 审计锚点“操作意图”：写入（保留清理 / 归档 / 隐私抹除）与校验（离机锚点比对）（AE5，ADR-0055 补充）
 * ============================================================================
 * 【职责】
 *   · 写：`anchorMark(db)` 在操作开始前记下锚点表的自增水位；操作新增锚点后 `recordAnchorIntent` 把“水位之后新增的全部锚点”连同操作类型、范围、
 *     操作者写成一行 `audit_anchor_intents`（迁移 072），算 `intent_hash`，配置了私钥时签名；`linkIntentAuditRow` 在操作审计行写入后把该行 id 回填。
 *     三者必须在**同一个事务**里（`recordAnchorIntent` 不在事务内会抛 `AUDIT_OUTSIDE_TX`）：锚点、意图、审计行要么一起提交要么一起回滚。
 *   · 校验：`verifyAnchorIntents(db, anchors, opts)` 对“已锚定范围内新增的库内锚点”逐个要求：
 *       ① 存在意图行，其 anchors_json 含该锚点（kind / at_row_id / anchor_hash / prev_id / prev_row_hash 全等）—— 否则 `anchor-without-intent`；
 *       ② 意图哈希按行内字段重算一致 —— 否则 `intent-hash-mismatch`；
 *       ③ 有签名且持有对应公钥时验签（失败 `intent-signature-invalid`）；`requireSigned` 时无签名 `intent-unsigned`、无法验证 `intent-signature-unverifiable`；
 *       ④ 意图被审计行印证：`audit_row_id` 指向的行存在、id 大于离机锚点的链尾（不能拿锚点之前就有的行冒充）、action 与操作类型对应
 *          （retention→RETENTION_PURGE，archive→AUDIT_ARCHIVE，erase→PRIVACY_ERASE）、明细里 `anchor_intent` 的 id 与哈希与意图一致 —— 否则 `intent-uncorroborated`。
 *          印证行已被后来的归档搬出库时为 `corroboration-archived`，只有 `acceptArchived`（CLI 的 --accept-new-anchors）才放行。
 * 【规范化】intent_hash = sha256(JSON.stringify([格式标识, operation, range_desc, operator_user_id, operator_name, created_at, 锚点元组列表]))，
 *   锚点元组 = [kind, at_row_id, anchor_hash, prev_id, prev_row_hash]；签名 = Ed25519(`${格式标识}:${intent_hash}`)，key_id = 公钥 SPKI DER 的 sha256。
 * 【诚实边界】能同时写库、写审计链并伪造未签名意图的攻击者，仍能造出自洽的“意图 + 审计行”；签名（`GML_ANCHOR_INTENT_KEY`，私钥不在业务主机上）
 *   与 `--require-signed-intents` 才挡得住它。没有意图表（迁移 072 之前）时写入退化为不写意图，校验侧会把这些锚点判为 `anchor-without-intent`。
 * ============================================================================
 */
import { createHash, createPublicKey, sign, verify } from 'node:crypto'

export const INTENT_FORMAT = 'os-erp-audit-anchor-intent/1'
export const OPERATION_ACTIONS = { retention: 'RETENTION_PURGE', archive: 'AUDIT_ARCHIVE', erase: 'PRIVACY_ERASE' }

const fault = (code, message, status) => Object.assign(new Error(message), { code, status })
const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
const tuple = (a) => [String(a.kind), Number(a.at_row_id), String(a.anchor_hash), a.prev_id ?? null, a.prev_row_hash ?? null]
const tupleKey = (t) => JSON.stringify(t)
const keyIdOf = (publicKey) => createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')

/** 意图哈希（唯一实现）。`fields.anchors` 是元组列表 */
export function intentHash({ operation, range, operatorUserId, operatorName, createdAt, anchors }) {
  const body = JSON.stringify([INTENT_FORMAT, String(operation), String(range), operatorUserId === null || operatorUserId === undefined ? null : String(operatorUserId), String(operatorName), String(createdAt), anchors])
  return createHash('sha256').update(body, 'utf8').digest('hex')
}
const signingInput = (hash) => Buffer.from(`${INTENT_FORMAT}:${hash}`, 'utf8')

/** 操作开始前的锚点自增水位；库里没有锚点表（迁移 068 之前）返回 null */
export function anchorMark(db) {
  if (!hasTable(db, 'audit_chain_anchors')) return null
  return db.prepare("SELECT COALESCE((SELECT seq FROM sqlite_sequence WHERE name='audit_chain_anchors'),0) AS m").get().m
}

/**
 * 把 `mark` 之后新增的全部锚点记成一条意图。必须在调用方事务内。没有新增锚点 / 没有意图表 / `mark` 为 null ⇒ 返回 null（没有可解释的东西）。
 * `signer` = Ed25519 私钥 KeyObject 或 null（不签名）。返回 { id, hash, anchors, signed }。
 */
export function recordAnchorIntent(db, mark, { operation, range, operatorUserId = null, operatorName, signer = null }) {
  if (!db.inTransaction) throw fault('AUDIT_OUTSIDE_TX', '写锚点意图必须与锚点在同一个事务内', 500)
  if (!Object.hasOwn(OPERATION_ACTIONS, operation)) throw fault('INTENT_OPERATION_INVALID', `未知操作类型：${operation}`, 500)
  if (mark === null || !hasTable(db, 'audit_anchor_intents')) return null
  const anchors = db.prepare('SELECT kind, at_row_id, anchor_hash, prev_id, prev_row_hash FROM audit_chain_anchors WHERE id > ? ORDER BY id').all(mark).map(tuple)
  if (!anchors.length) return null
  const createdAt = db.prepare("SELECT datetime('now','localtime') AS t").get().t
  const name = String(operatorName || 'unknown')
  const hash = intentHash({ operation, range, operatorUserId, operatorName: name, createdAt, anchors })
  let keyId = null
  let signature = null
  if (signer) {
    keyId = keyIdOf(createPublicKey(signer))
    signature = sign(null, signingInput(hash), signer).toString('base64')
  }
  const info = db.prepare(`INSERT INTO audit_anchor_intents (created_at, operation, range_desc, operator_user_id, operator_name, anchors_json, intent_hash, key_id, signature)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(createdAt, operation, String(range), operatorUserId ?? null, name, JSON.stringify(anchors), hash, keyId, signature)
  return { id: Number(info.lastInsertRowid), hash, anchors, signed: !!signature }
}

/** 操作审计行里引用意图的片段：放进审计明细的 `anchor_intent` 键（键名不含会被脱敏的词） */
export const intentRef = (intent) => (intent ? { id: intent.id, hash: intent.hash } : null)

/** 操作审计行写入之后调用（同一事务）：把意图的 audit_row_id 指向刚写入的尾行 */
export function linkIntentAuditRow(db, intent) {
  if (!intent) return
  const n = db.prepare('UPDATE audit_anchor_intents SET audit_row_id=(SELECT MAX(id) FROM audit_logs) WHERE id=?').run(intent.id).changes
  if (n !== 1) throw fault('INTENT_LINK_FAILED', '锚点意图回填审计行 id 失败', 500)
}

function checkIntent(db, it, { publicKey, requireSigned, minAuditRowId, acceptArchived, liveFirstId }) {
  let anchors
  try { anchors = JSON.parse(it.anchors_json) } catch { return { kind: 'intent-hash-mismatch', message: `意图 #${it.id} 的锚点列表无法解析` } }
  const want = intentHash({ operation: it.operation, range: it.range_desc, operatorUserId: it.operator_user_id, operatorName: it.operator_name, createdAt: it.created_at, anchors })
  if (want !== it.intent_hash) return { kind: 'intent-hash-mismatch', message: `意图 #${it.id} 的哈希与其字段不符（意图行被改？）` }
  if (it.signature) {
    if (publicKey && keyIdOf(publicKey) === it.key_id) {
      let good = false
      try { good = verify(null, signingInput(it.intent_hash), publicKey, Buffer.from(it.signature, 'base64')) } catch { good = false }
      if (!good) return { kind: 'intent-signature-invalid', message: `意图 #${it.id} 的签名验不过` }
    } else if (requireSigned) return { kind: 'intent-signature-unverifiable', message: `意图 #${it.id} 的签名密钥（${String(it.key_id).slice(0, 12)}…）与提供的公钥不符` }
  } else if (requireSigned) return { kind: 'intent-unsigned', message: `意图 #${it.id} 没有签名，但要求签名意图` }
  const id = it.audit_row_id
  const uncorroborated = (why) => ({ kind: 'intent-uncorroborated', message: `意图 #${it.id}（${it.operation}）没有被操作审计行印证：${why}` })
  if (id === null || id === undefined) return uncorroborated('未记录审计行 id')
  if (id <= minAuditRowId) return uncorroborated(`审计行 #${id} 不晚于离机锚点的链尾 #${minAuditRowId}`)
  const row = db.prepare('SELECT id, action, detail FROM audit_logs WHERE id=?').get(id)
  if (!row) {
    if (liveFirstId !== null && id < liveFirstId) {
      return acceptArchived ? null : { kind: 'corroboration-archived', message: `意图 #${it.id} 的审计行 #${id} 已被归档搬出库，无法在库内印证；核对归档后可用 --accept-new-anchors 接受` }
    }
    return uncorroborated(`审计行 #${id} 不存在`)
  }
  if (row.action !== OPERATION_ACTIONS[it.operation]) return uncorroborated(`审计行 #${id} 的 action 是 ${row.action}，应为 ${OPERATION_ACTIONS[it.operation]}`)
  let ref = null
  try { ref = JSON.parse(row.detail)?.anchor_intent } catch { ref = null }
  if (!ref || ref.id !== it.id || ref.hash !== it.intent_hash) return uncorroborated(`审计行 #${id} 的明细没有引用这条意图`)
  return null
}

/**
 * 逐个核对“离机锚点之后在已锚定范围内新增的库内锚点”。`anchors` 是 { kind, at_row_id, anchor_hash, prev_id, prev_row_hash } 列表。
 * 返回 { ok, checked, problems: [{ kind, message, anchor }] }。
 */
export function verifyAnchorIntents(db, anchors, { publicKey = null, requireSigned = false, minAuditRowId = 0, acceptArchived = false } = {}) {
  const problems = []
  const byAnchor = new Map()
  if (hasTable(db, 'audit_anchor_intents')) {
    for (const it of db.prepare('SELECT * FROM audit_anchor_intents ORDER BY id').all()) {
      let list
      try { list = JSON.parse(it.anchors_json) } catch { continue }
      if (!Array.isArray(list)) continue
      for (const t of list) {
        const k = tupleKey(Array.isArray(t) ? t : [])
        if (!byAnchor.has(k)) byAnchor.set(k, [])
        byAnchor.get(k).push(it)
      }
    }
  }
  const liveFirstId = db.prepare('SELECT MIN(id) AS id FROM audit_logs').get().id
  const opts = { publicKey, requireSigned, minAuditRowId, acceptArchived, liveFirstId }
  for (const a of anchors) {
    const cands = byAnchor.get(tupleKey(tuple(a))) || []
    if (!cands.length) { problems.push({ kind: 'anchor-without-intent', message: `锚点 ${a.kind}@${a.at_row_id} 没有匹配的操作意图（伪造的桥锚点？）`, anchor: a }); continue }
    let first = null
    let passed = false
    for (const it of cands) {
      const p = checkIntent(db, it, opts)
      if (!p) { passed = true; break }
      first ??= p
    }
    if (!passed) problems.push({ ...first, anchor: a })
  }
  return { ok: problems.length === 0, checked: anchors.length, problems }
}
