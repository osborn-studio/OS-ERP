/**
 * ============================================================================
 * 文件标识：scripts/lib/zip-safe.mjs ｜ 带硬上限的 zip 解压：条目数 / 单文件 / 总字节 / 路径穿越 / 符号链接（AH7）
 * ============================================================================
 * 【职责】verify-release 的 `--extract-to` 使用。zip 按不可信数据处理：先只读中央目录并在**解压任何字节之前**检查条目数、
 *   名称、类型和声明大小；解压时 `zlib.inflateRawSync(..., { maxOutputLength })` 强制**实际**输出不超过上限（声明大小可以说谎），
 *   并核对 CRC32 与声明大小。总字节按实际写出的累加。
 * 【拒绝】加密条目、zip64、分卷、除 stored(0) / deflate(8) 外的压缩方式、绝对路径（/ 或盘符或 UNC）、反斜杠、`..` 与 `.` 段、
 *   NUL、重复条目（大小写不敏感）、Unix 符号链接与其他特殊文件类型、文件与目录同名冲突、越出目标目录。
 * 【写文件】目标目录必须不存在或为空；用 `wx`（O_EXCL）创建，权限固定 0644，不沿用 zip 里的 setuid 等位。
 * 【不做什么】不验证 zip 的内容是否可信（那是 MANIFEST / EVIDENCE 的职责），不支持 zip64（发行包远小于 4 GiB），
 *   不防止磁盘被合规上限内的文件占满（上限就是容量预算，默认见 DEFAULT_LIMITS）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const DEFAULT_LIMITS = Object.freeze({
  maxEntries: 5000,
  maxFileBytes: 64 * 1024 * 1024,
  maxTotalBytes: 512 * 1024 * 1024,
  maxArchiveBytes: 256 * 1024 * 1024
})

export class ZipLimitError extends Error {
  constructor(message) { super(message); this.name = 'ZipLimitError' }
}
const refuse = (m) => { throw new ZipLimitError(m) }

const u16 = (b, o) => b.readUInt16LE(o)
const u32 = (b, o) => b.readUInt32LE(o)

/** Pure: normalise and validate one entry name. Returns the clean relative path (no trailing slash) or throws ZipLimitError. */
export function cleanEntryName(raw, { strip = 0 } = {}) {
  if (typeof raw !== 'string' || raw === '') refuse('entry with an empty name')
  if (raw.includes('\0')) refuse(`entry name contains NUL: ${JSON.stringify(raw)}`)
  if (raw.includes('\\')) refuse(`entry name contains a backslash: ${JSON.stringify(raw)}`)
  if (raw.startsWith('/') || /^[A-Za-z]:/.test(raw)) refuse(`absolute entry path refused: ${JSON.stringify(raw)}`)
  const segs = raw.replace(/\/$/, '').split('/')
  for (const s of segs) {
    if (s === '..') refuse(`path traversal refused: ${JSON.stringify(raw)}`)
    if (s === '.' || s === '') refuse(`non-canonical entry path refused: ${JSON.stringify(raw)}`)
  }
  return segs.slice(strip).join('/')
}

/** Parse the central directory without inflating anything. Returns [{ name, isDir, method, crc, csize, usize, offset }]. */
export function listZip(buf, limits = DEFAULT_LIMITS) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  if (buf.length > lim.maxArchiveBytes) refuse(`archive is ${buf.length} bytes, over the ${lim.maxArchiveBytes} byte limit`)
  if (buf.length < 22) refuse('not a zip file (too short)')
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (u32(buf, i) === 0x06054b50 && i + 22 + u16(buf, i + 20) === buf.length) { eocd = i; break }
  }
  if (eocd < 0) refuse('not a zip file (no end-of-central-directory record)')
  const disk = u16(buf, eocd + 4), cdDisk = u16(buf, eocd + 6)
  const onDisk = u16(buf, eocd + 8), total = u16(buf, eocd + 10)
  const cdSize = u32(buf, eocd + 12), cdOff = u32(buf, eocd + 16)
  if (disk !== 0 || cdDisk !== 0 || onDisk !== total) refuse('multi-disk archives are refused')
  if (total === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) refuse('zip64 archives are refused')
  if (total > lim.maxEntries) refuse(`archive declares ${total} entries, over the ${lim.maxEntries} entry limit`)
  if (cdOff + cdSize > eocd) refuse('central directory lies outside the archive')
  const out = []
  let p = cdOff
  for (let n = 0; n < total; n++) {
    if (p + 46 > eocd || u32(buf, p) !== 0x02014b50) refuse('corrupt central directory')
    const madeBy = u16(buf, p + 4), flags = u16(buf, p + 8), method = u16(buf, p + 10)
    const crc = u32(buf, p + 16), csize = u32(buf, p + 20), usize = u32(buf, p + 24)
    const nameLen = u16(buf, p + 28), extraLen = u16(buf, p + 30), commentLen = u16(buf, p + 32)
    const extAttr = u32(buf, p + 38), offset = u32(buf, p + 42)
    if (p + 46 + nameLen + extraLen + commentLen > eocd) refuse('corrupt central directory (entry overruns it)')
    const rawName = buf.toString('utf8', p + 46, p + 46 + nameLen)
    p += 46 + nameLen + extraLen + commentLen
    if (flags & 1 || flags & 0x40) refuse(`encrypted entry refused: ${JSON.stringify(rawName)}`)
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) refuse(`zip64 entry refused: ${JSON.stringify(rawName)}`)
    if (method !== 0 && method !== 8) refuse(`unsupported compression method ${method}: ${JSON.stringify(rawName)}`)
    cleanEntryName(rawName)
    const isDir = rawName.endsWith('/')
    if ((madeBy >> 8) === 3) { // Unix host: the high 16 bits of the external attributes are st_mode
      const type = (extAttr >>> 16) & 0o170000
      if (type === 0o120000) refuse(`symbolic link refused: ${JSON.stringify(rawName)}`)
      if (type !== 0 && type !== 0o100000 && type !== 0o040000) refuse(`special file type refused: ${JSON.stringify(rawName)}`)
      if (isDir !== (type === 0o040000) && type !== 0) refuse(`entry type disagrees with its name: ${JSON.stringify(rawName)}`)
    }
    if (isDir && (usize !== 0 || csize > 2)) refuse(`directory entry carries data: ${JSON.stringify(rawName)}`)
    if (usize > lim.maxFileBytes) refuse(`entry ${JSON.stringify(rawName)} declares ${usize} bytes, over the ${lim.maxFileBytes} byte per-file limit`)
    out.push({ name: rawName, isDir, method, crc, csize, usize, offset })
  }
  if (p !== cdOff + cdSize) refuse('central directory size does not match its entries')
  let declared = 0
  for (const e of out) declared += e.usize
  if (declared > lim.maxTotalBytes) refuse(`archive declares ${declared} bytes in total, over the ${lim.maxTotalBytes} byte limit`)
  return out
}

/**
 * Safely extract `zipFile` into `dest` (must not exist or be empty). `strip` drops that many leading path segments (release zips
 * have one top-level directory). Returns { entries, files, bytes }. Throws ZipLimitError on any violation; on error the partially
 * written destination is removed only if this call created it.
 */
export function extractZipSafe(zipFile, dest, limits = {}, { strip = 0 } = {}) {
  const lim = { ...DEFAULT_LIMITS, ...limits }
  for (const k of Object.keys(DEFAULT_LIMITS)) if (!Number.isSafeInteger(lim[k]) || lim[k] < 1) throw new ZipLimitError(`limit ${k} must be a positive integer`)
  const st = fs.statSync(zipFile)
  if (!st.isFile()) refuse('archive is not a regular file')
  if (st.size > lim.maxArchiveBytes) refuse(`archive is ${st.size} bytes, over the ${lim.maxArchiveBytes} byte limit`)
  const buf = fs.readFileSync(zipFile)
  const entries = listZip(buf, lim)
  const root = path.resolve(dest)
  let created = false
  try {
    const ls = fs.lstatSync(root)
    if (!ls.isDirectory() || fs.readdirSync(root).length) refuse('destination must be an empty directory')
  } catch (e) {
    if (e.code !== 'ENOENT') throw e
    fs.mkdirSync(root, { recursive: true }); created = true
  }
  // resolve through symlinks once so later startsWith checks compare real paths
  const real = fs.realpathSync(root)
  const seen = new Set()
  let files = 0, bytes = 0
  try {
    for (const e of entries) {
      const rel = cleanEntryName(e.name, { strip })
      if (!rel) { if (e.isDir) continue; refuse(`entry has no name after stripping ${strip} segment(s): ${JSON.stringify(e.name)}`) }
      const key = rel.toLowerCase()
      if (seen.has(key)) refuse(`duplicate entry: ${JSON.stringify(rel)}`)
      seen.add(key)
      const target = path.resolve(real, rel)
      if (!target.startsWith(real + path.sep)) refuse(`entry escapes the destination: ${JSON.stringify(e.name)}`)
      if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue }
      if (e.offset + 30 > buf.length || u32(buf, e.offset) !== 0x04034b50) refuse(`bad local header: ${JSON.stringify(e.name)}`)
      const start = e.offset + 30 + u16(buf, e.offset + 26) + u16(buf, e.offset + 28)
      if (start + e.csize > buf.length) refuse(`entry data overruns the archive: ${JSON.stringify(e.name)}`)
      const raw = buf.subarray(start, start + e.csize)
      const room = Math.min(lim.maxFileBytes, lim.maxTotalBytes - bytes)
      let data
      if (e.method === 0) {
        if (e.csize !== e.usize) refuse(`stored entry size mismatch: ${JSON.stringify(e.name)}`)
        data = raw
      } else {
        try { data = zlib.inflateRawSync(raw, { maxOutputLength: Math.max(room, 1) }) } catch (err) {
          if (err && err.code === 'ERR_BUFFER_TOO_LARGE') refuse(`entry ${JSON.stringify(e.name)} inflates past the size limits (declared ${e.usize}); possible zip bomb`)
          refuse(`corrupt compressed data: ${JSON.stringify(e.name)}`)
        }
      }
      if (data.length > room) refuse(`extraction would exceed the ${lim.maxTotalBytes} byte total / ${lim.maxFileBytes} byte per-file limit at ${JSON.stringify(e.name)}`)
      if (data.length !== e.usize) refuse(`entry size differs from its declaration: ${JSON.stringify(e.name)}`)
      if (zlib.crc32(data) !== e.crc) refuse(`CRC32 mismatch: ${JSON.stringify(e.name)}`)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, data, { flag: 'wx', mode: 0o644 })
      files++; bytes += data.length
    }
  } catch (err) {
    if (created) fs.rmSync(root, { recursive: true, force: true })
    throw err
  }
  return { entries: entries.length, files, bytes }
}
