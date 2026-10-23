/**
 * ============================================================================
 * 文件标识：server/lib/backup-crypto.js ｜ 备份文件的流式 AES-256-GCM 加密/解密（ADR-0022）
 * ============================================================================
 * 【职责】把一个 SQLite 快照加密成 `.db.enc`，或把 `.db.enc` 解回明文；只做文件级密码学，不决定何时备份。
 *
 * 【文件格式 v1】header(49B) | ciphertext | tag(16B)
 *   header = "OSBK"(4) | version(1)=0x01 | salt(32，每个文件随机) | iv(12，每个文件随机)
 *   · 整个 header 作为 GCM 的 AAD：改动魔数/版本/salt/iv 任何一位，解密时认证失败；
 *   · 文件密钥 = HKDF-SHA256(ikm=GML_BACKUP_KEY 的 UTF-8 字节, salt=header.salt, info="gml-backup-v1")，
 *     所以即使 iv 巧合重复，不同文件用的也是不同的 AES 密钥（不存在"同密钥同 nonce"）；
 *   · 单次 GCM 消息上限约 64 GiB（NIST SP 800-38D），超过则拒绝加密而不是静默破坏；
 *   · 认证标签放在文件尾，解密需要先读尾部 16 字节，再流式解密中间部分。
 *
 * 【失败路径】加/解密都先写 `<dest>.partial`（0600），完整且认证通过后才 rename 成正式名；
 *   任何异常都会删除 partial。解密时明文在认证通过前已写入 partial，所以失败必须删除它（本模块保证）。
 *
 * 【改它要注意什么】改格式必须升版本号并保留 v1 的解法；密钥只来自环境变量，绝不写入报告/日志。
 * ============================================================================
 */
import fs from 'node:fs'
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'

export const MAGIC = Buffer.from('OSBK')
export const FORMAT_VERSION = 1
export const MIN_KEY_BYTES = 32
const SALT_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = MAGIC.length + 1 + SALT_BYTES + IV_BYTES
const HKDF_INFO = 'gml-backup-v1'
const CHUNK = 64 * 1024
const MAX_PLAINTEXT_BYTES = 2 ** 36 - 64 // ≈ 64 GiB，低于 GCM 的 2^39-256 bit 上限

export class BackupCryptoError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** 读取 GML_BACKUP_KEY：未设置返回 null；设置了但短于 32 字节则抛错（不静默降级为明文备份）。 */
export function loadBackupKey(env = process.env) {
  const raw = env.GML_BACKUP_KEY
  if (raw === undefined || raw === '') return null
  const bytes = Buffer.from(String(raw), 'utf8')
  if (bytes.length < MIN_KEY_BYTES) throw new BackupCryptoError('BACKUP_KEY_WEAK', `GML_BACKUP_KEY 至少 ${MIN_KEY_BYTES} 字节（当前 ${bytes.length}）`)
  return bytes
}

const fileKey = (ikm, salt) => Buffer.from(hkdfSync('sha256', ikm, salt, HKDF_INFO, 32))

function removeQuietly(file) {
  try { fs.rmSync(file, { force: true }) } catch { /* 清理失败不覆盖原始错误 */ }
}

/** 加密 src → dest（dest 不得已存在）。返回 { size, sha256 }（密文，含 header 与 tag）。 */
export function encryptFile(src, dest, keyBytes) {
  const partial = `${dest}.partial`
  let inFd = null
  let outFd = null
  try {
    if (fs.existsSync(dest)) throw new BackupCryptoError('BACKUP_ENC_DEST_EXISTS', `目标已存在：${dest}`)
    if (fs.statSync(src).size > MAX_PLAINTEXT_BYTES) throw new BackupCryptoError('BACKUP_TOO_LARGE', '快照超过单次 GCM 消息上限（约 64 GiB）')
    const salt = randomBytes(SALT_BYTES)
    const iv = randomBytes(IV_BYTES)
    const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION]), salt, iv])
    const cipher = createCipheriv('aes-256-gcm', fileKey(keyBytes, salt), iv)
    cipher.setAAD(header)
    const hash = createHash('sha256')
    inFd = fs.openSync(src, 'r')
    outFd = fs.openSync(partial, 'wx', 0o600)
    let size = 0
    const emit = (buf) => { if (buf.length) { fs.writeSync(outFd, buf); hash.update(buf); size += buf.length } }
    emit(header)
    const buf = Buffer.allocUnsafe(CHUNK)
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, CHUNK, null)
      if (!n) break
      emit(cipher.update(buf.subarray(0, n)))
    }
    emit(cipher.final())
    emit(cipher.getAuthTag())
    fs.fsyncSync(outFd)
    fs.closeSync(outFd); outFd = null
    fs.renameSync(partial, dest)
    return { size, sha256: hash.digest('hex') }
  } catch (e) {
    if (outFd !== null) try { fs.closeSync(outFd) } catch { /* ignore */ }
    removeQuietly(partial)
    throw e
  } finally {
    if (inFd !== null) try { fs.closeSync(inFd) } catch { /* ignore */ }
  }
}

/**
 * 解密 src；dest 为 null 时只做认证校验、不落盘。认证失败/格式错误抛 BackupCryptoError，且不留下 dest 或 partial。
 */
export function decryptFile(src, dest, keyBytes) {
  const partial = dest ? `${dest}.partial` : null
  let inFd = null
  let outFd = null
  try {
    if (dest && fs.existsSync(dest)) throw new BackupCryptoError('BACKUP_DEC_DEST_EXISTS', `目标已存在：${dest}`)
    inFd = fs.openSync(src, 'r')
    const total = fs.fstatSync(inFd).size
    if (total < HEADER_BYTES + TAG_BYTES) throw new BackupCryptoError('BACKUP_ENC_FORMAT', '加密备份文件过短或已截断')
    const header = Buffer.alloc(HEADER_BYTES)
    fs.readSync(inFd, header, 0, HEADER_BYTES, 0)
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupCryptoError('BACKUP_ENC_FORMAT', '不是 OS ERP 加密备份（魔数不符）')
    if (header[MAGIC.length] !== FORMAT_VERSION) throw new BackupCryptoError('BACKUP_ENC_VERSION', `不支持的加密备份版本 ${header[MAGIC.length]}`)
    const salt = header.subarray(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES)
    const iv = header.subarray(MAGIC.length + 1 + SALT_BYTES)
    const tag = Buffer.alloc(TAG_BYTES)
    fs.readSync(inFd, tag, 0, TAG_BYTES, total - TAG_BYTES)
    const decipher = createDecipheriv('aes-256-gcm', fileKey(keyBytes, salt), iv)
    decipher.setAAD(header)
    decipher.setAuthTag(tag)
    if (partial) outFd = fs.openSync(partial, 'wx', 0o600)
    const emit = (buf) => { if (outFd !== null && buf.length) fs.writeSync(outFd, buf) }
    const end = total - TAG_BYTES
    let pos = HEADER_BYTES
    const buf = Buffer.allocUnsafe(CHUNK)
    while (pos < end) {
      const n = fs.readSync(inFd, buf, 0, Math.min(CHUNK, end - pos), pos)
      if (!n) throw new BackupCryptoError('BACKUP_ENC_FORMAT', '读取加密备份时意外结束')
      pos += n
      emit(decipher.update(buf.subarray(0, n)))
    }
    try {
      emit(decipher.final())
    } catch {
      throw new BackupCryptoError('BACKUP_DECRYPT_FAILED', '解密认证失败：密钥错误，或备份文件/头部被改动')
    }
    if (outFd !== null) {
      fs.fsyncSync(outFd)
      fs.closeSync(outFd); outFd = null
      fs.renameSync(partial, dest)
    }
    return { ok: true }
  } catch (e) {
    if (outFd !== null) try { fs.closeSync(outFd) } catch { /* ignore */ }
    if (partial) removeQuietly(partial)
    throw e
  } finally {
    if (inFd !== null) try { fs.closeSync(inFd) } catch { /* ignore */ }
  }
}

/** 尽力擦除并删除明文临时文件：先用零覆盖再 unlink。SSD/写时复制文件系统上覆盖不保证物理擦除（见 ADR-0022）。 */
export function shredFile(file) {
  try {
    const size = fs.statSync(file).size
    const fd = fs.openSync(file, 'r+')
    try {
      const zeros = Buffer.alloc(CHUNK)
      for (let off = 0; off < size; off += CHUNK) fs.writeSync(fd, zeros, 0, Math.min(CHUNK, size - off), off)
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }
  } catch { /* 文件不存在或不可写：仍尝试 unlink */ }
  fs.rmSync(file, { force: true })
}

export default { MAGIC, FORMAT_VERSION, MIN_KEY_BYTES, BackupCryptoError, loadBackupKey, encryptFile, decryptFile, shredFile }
