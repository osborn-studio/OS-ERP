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
 *          AG5（ADR-0055 补充 3）：公钥可以是一个集合，按意图记录的 key_id 选钥；明确给了集合而 key_id 不在其中 ⇒ `intent-key-unknown`；
 *          没有 key_id 的签名意图（过渡规则）对集合里每把试，`requireKeyId` 时 `intent-key-id-missing`；
 *       ④ 意图被审计行印证：`audit_row_id` 指向的行存在、id 大于离机锚点的链尾（不能拿锚点之前就有的行冒充）、action 与操作类型对应
 *          （retention→RETENTION_PURGE，archive→AUDIT_ARCHIVE，erase→PRIVACY_ERASE）、明细里 `anchor_intent` 的 id 与哈希与意图一致 —— 否则 `intent-uncorroborated`。
 *          印证行不在库里就是 `intent-uncorroborated`，除非调用方给了 `archivedRow`（AF5）：它在**验证通过的归档 JSONL** 里按 id 找行，用来对账“已被归档搬出库的锚点”。
 *          （库内锚点的印证行不可能被归档：印证行 id 必晚于基线链尾，要被归档搬走，那次归档在同一事务里会连这个范围内锚点一起删除；所以 AE5 的
 *          “印证行已归档”放行路径与 `--accept-new-anchors` 已删除。被归档搬出库的锚点改由摘要里的锚点清单 + 归档 JSONL 证据对账，见 ADR-0055 补充 2。）
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

/**
 * 签名核对（AG5，ADR-0055 补充 3）。`keys` = Map<key_id, 公钥>；`explicit` = 公钥集合是调用方明确给的意图公钥（`--intent-pubkey`），
 * 而不是回落用的 `--pubkey`（发行 / 锚点公钥）。按意图记录的 key_id 选钥，**不逐把试**：key_id 被改成另一把受信公钥只会验签失败。
 * · 无公钥：`requireSigned` ⇒ intent-signature-unverifiable，否则跳过（AE5 口径）。
 * · key_id 在集合里：用这一把验，失败 ⇒ intent-signature-invalid。
 * · key_id 不在集合里：明确给了公钥集合 ⇒ intent-key-unknown（rewrite）；只是回落的 --pubkey ⇒ 沿用 AE5（requireSigned 时 unverifiable，否则跳过）。
 * · 过渡规则：意图没有 key_id（本变更之前写的，或被剥掉）而带签名 ⇒ 对集合里每一把试；一把都过不了 ⇒ invalid。`requireKeyId` 结束过渡（intent-key-id-missing）。
 */
function checkSignature(it, { keys, explicit, requireSigned, requireKeyId }) {
  const verifyWith = (key) => { try { return verify(null, signingInput(it.intent_hash), key, Buffer.from(it.signature, 'base64')) } catch { return false } }
  const invalid = () => ({ kind: 'intent-signature-invalid', message: `意图 #${it.id} 的签名验不过` })
  const hasKeyId = typeof it.key_id === 'string' && it.key_id !== ''
  if (!hasKeyId && requireKeyId) return { kind: 'intent-key-id-missing', message: `意图 #${it.id} 带签名但没有 key_id（过渡期的旧意图或 key_id 被剥掉），而要求每条签名意图都记录 key_id` }
  if (!keys.size) return requireSigned ? { kind: 'intent-signature-unverifiable', message: `意图 #${it.id} 已签名，但没有提供意图公钥（--intent-pubkey）` } : null
  if (!hasKeyId) {
    for (const key of keys.values()) if (verifyWith(key)) return null
    if (explicit) return invalid()
    return requireSigned ? { kind: 'intent-signature-unverifiable', message: `意图 #${it.id} 没有 key_id，提供的公钥都验不过它的签名` } : null
  }
  const key = keys.get(it.key_id)
  if (!key) {
    if (explicit) return { kind: 'intent-key-unknown', message: `意图 #${it.id} 的签名密钥（key_id ${String(it.key_id).slice(0, 16)}…）不在提供的意图公钥集合里（${keys.size} 把）：公钥没带全，或这把钥不受信` }
    return requireSigned ? { kind: 'intent-signature-unverifiable', message: `意图 #${it.id} 的签名密钥（${String(it.key_id).slice(0, 12)}…）与提供的公钥不符` } : null
  }
  return verifyWith(key) ? null : invalid()
}

function checkIntent(db, it, { keys, explicit, requireSigned, requireKeyId, minAuditRowId, rowLookup }) {
  let anchors
  try { anchors = JSON.parse(it.anchors_json) } catch { return { kind: 'intent-hash-mismatch', message: `意图 #${it.id} 的锚点列表无法解析` } }
  const want = intentHash({ operation: it.operation, range: it.range_desc, operatorUserId: it.operator_user_id, operatorName: it.operator_name, createdAt: it.created_at, anchors })
  if (want !== it.intent_hash) return { kind: 'intent-hash-mismatch', message: `意图 #${it.id} 的哈希与其字段不符（意图行被改？）` }
  if (it.signature) {
    const p = checkSignature(it, { keys, explicit, requireSigned, requireKeyId })
    if (p) return p
  } else if (requireSigned) return { kind: 'intent-unsigned', message: `意图 #${it.id} 没有签名，但要求签名意图` }
  const id = it.audit_row_id
  const uncorroborated = (why) => ({ kind: 'intent-uncorroborated', message: `意图 #${it.id}（${it.operation}）没有被操作审计行印证：${why}` })
  if (id === null || id === undefined) return uncorroborated('未记录审计行 id')
  if (id <= minAuditRowId) return uncorroborated(`审计行 #${id} 不晚于离机锚点的链尾 #${minAuditRowId}`)
  const row = rowLookup(id)
  if (!row) return uncorroborated(`审计行 #${id} 不存在`)
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
export function verifyAnchorIntents(db, anchors, { publicKey = null, publicKeys = [], explicitKeys = false, requireSigned = false, requireKeyId = false, minAuditRowId = 0, archivedRow = null } = {}) {
  const problems = []
  const keys = new Map()
  for (const k of [...(publicKey ? [publicKey] : []), ...publicKeys]) keys.set(keyIdOf(k), k)
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
  // 印证行先在库里找；库里没有时（只在对账“已被归档搬出库的锚点”时有意义）才去验证通过的归档 JSONL 里找
  const rowLookup = (id) => db.prepare('SELECT id, action, detail FROM audit_logs WHERE id=?').get(id) ?? (archivedRow ? archivedRow(id) : null)
  const opts = { keys, explicit: explicitKeys, requireSigned, requireKeyId, minAuditRowId, rowLookup }
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
