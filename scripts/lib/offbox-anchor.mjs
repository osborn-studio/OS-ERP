/**
 * ============================================================================
 * 文件标识：scripts/lib/offbox-anchor.mjs ｜ 离机锚点（AD5，ADR-0055）：锚点文件的构造、签名、验签与后代校验
 * ============================================================================
 * 【职责】offbox-anchor（写）、audit-verify-chain 与 verify-release（验）共用。锚点文件 `anchor-<stamp>.json`：
 *   `{ "anchor": {format, created_at, log, audit, signature}, "sig": "<base64 Ed25519>" }`。
 *   · anchor.log = {present, lines, tail_hash}：透明日志（EVIDENCE-LOG.jsonl）前 `lines` 行的链尾哈希（= 第 lines 行原文的 sha256；0 行为 GENESIS_PREV）。
 *   · anchor.audit[<行业>] = {status:'absent'} | {status:'not-migrated'} | {status:'chain', rows, first_id, last_id, tip_hash, anchors_count, anchors_digest, anchors[]}。
 *   · 签名复用 ADR-0047：规范化 JSON v1 + Ed25519（evidence-sign.mjs），覆盖整个 anchor（含 signature 元数据与 `format`，
 *     `format` 与证据文件互不相同，一种文件的签名不能冒充另一种）。`sig` 在被签内容之外。
 * 【后代校验】日志：现日志必须自身是有效链、至少 `lines` 行，且第 `lines` 行的哈希等于锚定的 tail_hash（整份替换为另一条有效链会在这里失败）。
 *   审计：沿用 AC7 的 compareLiveToBackup（在用链须是锚定链尾的后代；改写 / 截断 / 锚点消失都失败）。
 * 【边界】锚点只证明"持钥者在该时刻看到过这个链尾"；同时拿到私钥与离机副本的攻击者不在防护范围。公钥须带外获得。
 * ============================================================================
 */
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { signEvidence, verifyEvidenceSignature } from './evidence-sign.mjs'
import { GENESIS_PREV, verifyLog } from './evidence-log.mjs'

export const ANCHOR_FORMAT = 'os-erp-offbox-anchor/1'
const HEX64 = /^[0-9a-f]{64}$/
const MAX_BYTES = 8 * 1024 * 1024
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex')

/** 日志文本 → {present:true, lines, tail_hash}；日志无效则抛错（不给坏链做锚点）。 */
export function summarizeLog(text) {
  const v = verifyLog(text)
  if (!v.ok) throw new Error(v.reason)
  return { present: true, lines: v.entries.length, tail_hash: v.tip }
}

export const stampFor = (date = new Date()) => date.toISOString().replace(/[-:.]/g, '')

/** 构造并签名；返回写盘用的文本（规范化外层不重要，内层以规范化字节验签）。 */
export function buildSignedAnchor({ createdAt = new Date().toISOString(), log, audit }, privateKey) {
  const { evidence, sigBase64 } = signEvidence({ format: ANCHOR_FORMAT, created_at: createdAt, log, audit }, privateKey)
  return JSON.stringify({ anchor: evidence, sig: sigBase64 }, null, 2) + '\n'
}

/** 读取并验签。永不抛错：{ok, anchor, key_id} | {ok:false, reason}。 */
export function loadAnchor(file, publicKey) {
  const no = (reason) => ({ ok: false, reason: `offbox anchor ${file}: ${reason}` })
  let text
  try {
    const st = fs.statSync(file)
    if (!st.isFile() || st.size > MAX_BYTES) return no('not a regular file or too large')
    text = fs.readFileSync(file, 'utf8')
  } catch (error) { return no(`cannot be read (${error.code || error.message})`) }
  let doc
  try { doc = JSON.parse(text) } catch (error) { return no(`is not JSON (${error.message})`) }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc) || Object.keys(doc).sort().join() !== 'anchor,sig') return no('unexpected top-level fields (need exactly anchor, sig)')
  const a = doc.anchor
  if (!a || typeof a !== 'object' || Array.isArray(a) || a.format !== ANCHOR_FORMAT) return no(`format is not ${ANCHOR_FORMAT}`)
  if (typeof doc.sig !== 'string') return no('sig must be a string')
  const v = verifyEvidenceSignature(a, doc.sig, publicKey)
  if (!v.ok) return no(`signature check failed: ${v.reason}`)
  const L = a.log
  if (!L || typeof L !== 'object' || typeof L.present !== 'boolean') return no('log section malformed')
  if (L.present && (!Number.isSafeInteger(L.lines) || L.lines < 0 || !HEX64.test(String(L.tail_hash)))) return no('log.lines / log.tail_hash malformed')
  if (!a.audit || typeof a.audit !== 'object' || Array.isArray(a.audit)) return no('audit section malformed')
  return { ok: true, anchor: a, key_id: a.signature.key_id }
}

/** 现有日志文本（null = 文件不存在）是否是锚定日志的后代。 */
export function checkLogDescent(anchor, text) {
  const L = anchor.log
  if (!L.present) return { ok: true, note: 'anchor was made without a transparency log; nothing to compare' }
  if (text === null) return { ok: false, reason: `evidence log is missing but the anchor recorded ${L.lines} line(s) (log deleted?)` }
  const v = verifyLog(text)
  if (!v.ok) return { ok: false, reason: v.reason }
  const lines = text === '' ? [] : text.slice(0, -1).split('\n')
  if (lines.length < L.lines) return { ok: false, reason: `evidence log has ${lines.length} line(s) but the anchor recorded ${L.lines}: the tail was truncated, or the file was replaced` }
  const tip = L.lines === 0 ? GENESIS_PREV : sha256(lines[L.lines - 1])
  if (tip !== L.tail_hash) return { ok: false, reason: `evidence log line ${L.lines} does not match the anchored tail hash: the log is not a continuation of the anchored one (rewritten or replaced)` }
  return { ok: true, lines: lines.length, advanced: lines.length - L.lines }
}

/** 锚定的某行业条目 → compareLiveToBackup 所需的清单形态。 */
export const asManifest = (code, entry) => ({ industry: code, audit_chain: { present: true, verified: true, ...entry } })
