/**
 * ============================================================================
 * 文件标识：scripts/lib/evidence-log.mjs ｜ 发行证据透明日志（AC6，ADR-0052）：追加式哈希链 JSONL
 * ============================================================================
 * 【职责】release-candidate（追加）与 verify-release（校验）共用。日志文件 docs/release/EVIDENCE-LOG.jsonl，一行一个候选：
 *   {schema,name,evidence_sha256,signature,built_by,timestamp,prev}。
 *   - name：RC-<version>-<shortsha>（不含 .zip），全日志唯一。
 *   - evidence_sha256：规范化 EVIDENCE.json（与签名相同的规范化 v1 字节）的 sha256。
 *   - signature：EVIDENCE.sig（去首尾空白后的 base64 文本）的 sha256；未签名为 null。
 *   - built_by：hosted-ci | key-holder | local（见 builtByFor）。
 *   - prev：上一行**原文**（不含换行）的 sha256；第一行为 GENESIS_PREV。
 * 【严格性】每行必须恰好等于其解析结果的规范化 JSON（拒绝缩进、键序、CRLF、多余空白）；不允许空行；文件必须以单个换行结尾；
 *   字段集合固定；名称唯一；时间戳不得倒退。任何一条不满足 ⇒ 链无效，append 拒绝且不修复、不改动文件。
 * 【边界】哈希链只能发现中间改动，不能发现"截掉尾部若干行"或"整个文件被替换成另一条有效链"：对抗这两点靠仓库历史（git）与
 *   把链尾哈希带外保存；这是透明日志的最小形态，不是时间戳权威。日志条目由构建者自述，不证明证据为真。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { canonicalize } from './evidence-sign.mjs'

export const LOG_FILE = 'docs/release/EVIDENCE-LOG.jsonl'
export const GENESIS_PREV = createHash('sha256').update('OS-ERP EVIDENCE-LOG v1 genesis').digest('hex')
export const BUILT_BY = ['hosted-ci', 'key-holder', 'local']
const FIELDS = ['schema', 'name', 'evidence_sha256', 'signature', 'built_by', 'timestamp', 'prev']
const HEX64 = /^[0-9a-f]{64}$/
const NAME = /^RC-[0-9A-Za-z.+-]+-[0-9a-f]{7,40}$/
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex')

export const entryLine = entry => canonicalize(entry)
export const evidenceDigest = evidence => sha256(canonicalize(evidence))
/** EVIDENCE.sig 文本 → 摘要；格式不是 88 字符 base64 签名则抛错。null/undefined → null。 */
export function signatureDigest(sigText) {
  if (sigText === null || sigText === undefined) return null
  const text = String(sigText).replace(/\s+$/, '') // 与 verifyEvidenceSignature 相同：只容忍尾部空白
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) throw new Error('signature text is not a base64 Ed25519 signature')
  return sha256(text)
}
/** 谁构建的：托管 CI（GITHUB_ACTIONS=true）→ hosted-ci；有签名 → key-holder；其余 → local。 */
export function builtByFor({ env = process.env, signed }) {
  if (env.GITHUB_ACTIONS === 'true') return 'hosted-ci'
  return signed ? 'key-holder' : 'local'
}

/** 校验整份日志文本。返回 {ok, entries, tip, reason?}；永不抛错。 */
export function verifyLog(text) {
  const no = reason => ({ ok: false, reason: `evidence log invalid: ${reason}`, entries: [], tip: null })
  if (text === '') return { ok: true, entries: [], tip: GENESIS_PREV }
  if (!text.endsWith('\n')) return no('file does not end with a newline (truncated or hand-edited)')
  if (text.endsWith('\n\n')) return no('blank line at the end')
  const lines = text.slice(0, -1).split('\n')
  const entries = []
  const names = new Set()
  let prev = GENESIS_PREV
  let lastTs = null
  for (let i = 0; i < lines.length; i++) {
    const at = `line ${i + 1}`
    const line = lines[i]
    if (line === '') return no(`${at}: blank line`)
    let e
    try { e = JSON.parse(line) } catch (error) { return no(`${at}: cannot parse JSON (${error.message})`) }
    if (!e || typeof e !== 'object' || Array.isArray(e)) return no(`${at}: not an object`)
    let canon
    try { canon = canonicalize(e) } catch (error) { return no(`${at}: ${error.message}`) }
    if (canon !== line) return no(`${at}: not in canonical form (CR, whitespace or key order differs)`)
    const keys = Object.keys(e).sort().join()
    if (keys !== [...FIELDS].sort().join()) return no(`${at}: unexpected or missing field set`)
    if (e.schema !== 1) return no(`${at}: unsupported schema`)
    if (typeof e.name !== 'string' || !NAME.test(e.name)) return no(`${at}: bad name`)
    if (!HEX64.test(e.evidence_sha256)) return no(`${at}: bad evidence_sha256`)
    if (e.signature !== null && !HEX64.test(String(e.signature))) return no(`${at}: signature must be null or a sha256`)
    if (!BUILT_BY.includes(e.built_by)) return no(`${at}: built_by must be one of ${BUILT_BY.join(', ')}`)
    if (e.built_by === 'hosted-ci' && e.signature !== null) return no(`${at}: hosted-ci entries cannot carry a signature`)
    if (typeof e.timestamp !== 'string' || Number.isNaN(Date.parse(e.timestamp)) || new Date(e.timestamp).toISOString() !== e.timestamp) return no(`${at}: timestamp must be a canonical ISO-8601 UTC string`)
    if (lastTs !== null && e.timestamp < lastTs) return no(`${at}: timestamp goes backwards`)
    if (e.prev !== prev) return no(`${at}: prev does not match the hash of the previous line (chain broken or genesis wrong)`)
    if (names.has(e.name)) return no(`${at}: duplicate candidate name ${e.name}`)
    names.add(e.name); lastTs = e.timestamp
    entries.push(e)
    prev = sha256(line)
  }
  return { ok: true, entries, tip: prev }
}

/** 读取并校验磁盘上的日志（不存在 ⇒ 空链，仅 allowMissing 时）。 */
export function readLog(file, { allowMissing = false } = {}) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT' && allowMissing) text = ''
    else return { ok: false, reason: `evidence log cannot be read: ${file} (${error.code || error.message})`, entries: [], tip: null }
  }
  return verifyLog(text)
}

/** 构建前的检查：链必须有效且不含该候选名。 */
export function assertAppendable(file, name) {
  const v = readLog(file, { allowMissing: true })
  if (!v.ok) throw new Error(`${v.reason} (the chain is broken; it is never repaired automatically)`)
  if (v.entries.some(e => e.name === name)) throw new Error(`candidate ${name} is already in the evidence log; a formal re-signature needs a new commit`)
  return v
}

/** 追加一行；返回写入的条目。整个"读-校验-追加"在独占锁文件（<log>.lock，O_EXCL）内完成；锁被占用即失败，不等待、不抢锁。任何失败都不改动日志。 */
export function appendEntry(file, { name, evidence, sigText, builtBy, timestamp = new Date().toISOString() }) {
  if (!BUILT_BY.includes(builtBy)) throw new Error(`built_by must be one of ${BUILT_BY.join(', ')}`)
  if (!NAME.test(name)) throw new Error(`bad candidate name ${name}`)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const lock = `${file}.lock`
  let fd
  try { fd = fs.openSync(lock, 'wx', 0o600) } catch (error) {
    throw new Error(error.code === 'EEXIST' ? `evidence log lock ${lock} is held by another process (or left by a crashed one; remove it only after confirming nothing is appending)` : `cannot take evidence log lock ${lock} (${error.code || error.message})`)
  }
  try {
    const v = assertAppendable(file, name)
    const entry = { schema: 1, name, evidence_sha256: evidenceDigest(evidence), signature: signatureDigest(sigText), built_by: builtBy, timestamp, prev: v.tip }
    const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
    const check = verifyLog(existing + entryLine(entry) + '\n')
    if (!check.ok) throw new Error(check.reason)
    fs.appendFileSync(file, entryLine(entry) + '\n')
    return entry
  } finally { fs.closeSync(fd); fs.rmSync(lock, { force: true }) }
}
