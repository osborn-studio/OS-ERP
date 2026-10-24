/**
 * ============================================================================
 * 文件标识：scripts/lib/evidence-sign.mjs ｜ 发行候选证据签名（AB4，ADR-0047）：规范化 JSON + Ed25519 签名/验签 + 密钥加载
 * ============================================================================
 * 【职责】release-candidate（签名）、verify-release（验签）、release-keygen 共用。只用 node:crypto。
 * 【规范化 v1】对象键按 UTF-16 码元序递增、无任何空白、数组保序；只接受 null/布尔/有限数字/字符串/数组/普通对象。
 *   undefined、NaN、Infinity、BigInt、函数、Date、带原型的对象、稀疏数组一律抛错（宁可拒绝也不静默改写被签内容）。
 *   字符串用 JSON.stringify（规范转义）。签名覆盖整份证据——包括 `signature` 元数据（算法、规范化版本、key_id、sig_file）——
 *   所以不能在保留旧签名的同时改 key_id 或把 signature 改成 null（降级）。
 * 【密钥】Ed25519 PKCS#8 私钥 PEM / SPKI 公钥 PEM。私钥文件必须是普通文件、不在任何 git 工作树内、权限不得对组/其它可读；
 *   公钥参数若是私钥 PEM 直接拒绝（避免把私钥当公钥传来传去）。key_id = 公钥 SPKI DER 的 sha256。
 * 【边界】签名证明"持有该私钥的人在构建时批准了这份证据"，不证明证据内容为真（operator-attested 仍只是声明）；
 *   公钥必须经带外渠道获得，随候选一起分发的公钥没有意义。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createPrivateKey, createPublicKey, sign, verify } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { isWithin, resolveThroughSymlinks } from './safe-path.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const SIGNATURE_ALGORITHM = 'ed25519'
export const CANONICALIZATION = 'sorted-keys-no-whitespace-v1'
export const SIG_FILE = 'EVIDENCE.sig'
export const KEY_ENV = 'GML_RELEASE_SIGN_KEY'

/** 规范化 JSON 文本（见文件头）。 */
export function canonicalize(value) {
  const fail = why => { throw new Error(`Cannot canonicalize: ${why}`) }
  const walk = v => {
    if (v === null) return 'null'
    switch (typeof v) {
      case 'boolean': return v ? 'true' : 'false'
      case 'string': return JSON.stringify(v)
      case 'number': return Number.isFinite(v) ? JSON.stringify(v) : fail('non-finite number')
      case 'object': break
      default: return fail(`unsupported ${typeof v}`)
    }
    if (Array.isArray(v)) {
      const parts = []
      for (let i = 0; i < v.length; i++) { if (!(i in v)) fail('sparse array'); parts.push(walk(v[i])) }
      return `[${parts.join(',')}]`
    }
    const proto = Object.getPrototypeOf(v)
    if (proto !== Object.prototype && proto !== null) fail('non-plain object')
    return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${walk(v[k])}`).join(',')}}`
  }
  return walk(value)
}

/** 公钥身份：SPKI DER 的 sha256（十六进制）。 */
export function publicKeyId(publicKey) {
  return createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex')
}

function hasGitAncestor(p) {
  let cur = resolveThroughSymlinks(p)
  for (;;) {
    if (fs.existsSync(path.join(cur, '.git'))) return true
    const up = path.dirname(cur)
    if (up === cur) return false
    cur = up
  }
}
/** 密钥/密钥目录绝不能落在仓库或任何 git 工作树内（含经符号链接指进去的路径）。 */
export function assertOutsideRepository(p, label = 'path') {
  let inside
  try { inside = isWithin(ROOT, p) || hasGitAncestor(p) } catch { inside = true }
  if (inside) throw new Error(`${label} ${p} is inside a git repository (or cannot be resolved); keep release keys outside any repository`)
}

/** 读取签名私钥：普通文件、仓库外、权限 0600 级别、Ed25519。 */
export function loadSigningKey(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`${KEY_ENV} must be an absolute path to a private key PEM`)
  assertOutsideRepository(file, 'Signing key')
  let st
  try { st = fs.statSync(file) } catch (error) { throw new Error(`Cannot read signing key ${file} (${error.code || error.message})`) }
  if (!st.isFile()) throw new Error(`Signing key ${file} is not a regular file`)
  if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) throw new Error(`Signing key ${file} has permission ${(st.mode & 0o777).toString(8)}; it must not be readable by group/others (chmod 600)`)
  let key
  try { key = createPrivateKey(fs.readFileSync(file)) } catch (error) { throw new Error(`Signing key ${file} is not a readable private key PEM (${error.message.split('\n')[0]})`) }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`Signing key must be Ed25519, got ${key.asymmetricKeyType}`)
  return key
}

/** 读取公钥 PEM：拒绝私钥内容与非 Ed25519。 */
export function loadPublicKey(file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) { throw new Error(`Cannot read public key ${file} (${error.code || error.message})`) }
  if (/PRIVATE KEY/.test(text)) throw new Error(`${file} contains a private key; pass the public key PEM only`)
  let key
  try { key = createPublicKey(text) } catch (error) { throw new Error(`${file} is not a readable public key PEM (${error.message.split('\n')[0]})`) }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error(`Public key must be Ed25519, got ${key.asymmetricKeyType}`)
  return key
}

/** 给证据加上 signature 元数据并签名；返回 {evidence, sigBase64}。调用方必须写出 evidence 且原样保存。 */
export function signEvidence(base, privateKey) {
  const evidence = { ...base, signature: { algorithm: SIGNATURE_ALGORITHM, canonicalization: CANONICALIZATION, key_id: publicKeyId(createPublicKey(privateKey)), sig_file: SIG_FILE } }
  const sigBase64 = sign(null, Buffer.from(canonicalize(evidence), 'utf8'), privateKey).toString('base64')
  return { evidence, sigBase64 }
}

/** 验签：永不抛错，返回 {ok, reason?}。 */
export function verifyEvidenceSignature(evidence, sigText, publicKey) {
  const no = reason => ({ ok: false, reason })
  const meta = evidence?.signature
  if (!meta || typeof meta !== 'object') return no('evidence is unsigned (signature is not an object)')
  if (meta.algorithm !== SIGNATURE_ALGORITHM || meta.canonicalization !== CANONICALIZATION || meta.sig_file !== SIG_FILE) return no('unsupported signature metadata (algorithm/canonicalization/sig_file)')
  if (meta.key_id !== publicKeyId(publicKey)) return no('signature key_id does not match the supplied public key')
  const text = String(sigText ?? '').replace(/\s+$/, '')
  if (!/^[A-Za-z0-9+/]{86}==$/.test(text)) return no('EVIDENCE.sig is not a base64 Ed25519 signature (64 bytes)')
  const sig = Buffer.from(text, 'base64')
  if (sig.length !== 64 || sig.toString('base64') !== text) return no('EVIDENCE.sig is not canonical base64')
  let bytes
  try { bytes = Buffer.from(canonicalize(evidence), 'utf8') } catch (error) { return no(error.message) }
  let good = false
  try { good = verify(null, bytes, publicKey, sig) } catch { good = false }
  return good ? { ok: true } : no('signature does not match the canonicalized evidence')
}
