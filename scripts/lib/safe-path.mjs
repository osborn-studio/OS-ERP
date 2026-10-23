/**
 * ============================================================================
 * 文件标识：scripts/lib/safe-path.mjs ｜ 路径安全判据：穿过（含悬空）符号链接解析路径、判断是否落在仓库 data/ 内、独占创建输出文件
 * ============================================================================
 * 【职责】synth-data / synth-pipeline 共用。`fs.realpathSync` 对"尚不存在"的路径会抛错，朴素回退到字面路径会让
 *   `/tmp/alias/new-run`（alias → 仓库 data/，或悬空链接）绕过"不得在仓库 data/ 内"的判据。这里逐段 lstat：
 *   遇到符号链接就跟随（含悬空），遇到第一个不存在的段才把剩余部分按字面拼上。
 * 【输出文件】`writeExclusive` 用 `wx`（O_EXCL）创建：目标已存在（含符号链接）一律失败，不会跟随链接截断别的文件。
 * 【改它要注意什么】tests/synth-data.test.mjs 用真实符号链接（含悬空）证明两个入口都会拒绝。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

/** 解析到真实路径；不存在的尾段按字面保留。链接环 / 过深直接抛错（isWithin 对它按"在内"处理，即失败时关闭）。 */
export function resolveThroughSymlinks(p, depth = 0) {
  if (depth > 32) throw Object.assign(new Error(`符号链接过深或成环：${p}`), { code: 'SYMLINK_DEPTH' })
  const parts = path.resolve(p).split(path.sep).filter(Boolean)
  let cur = path.sep
  for (let i = 0; i < parts.length; i++) {
    const next = path.join(cur, parts[i])
    let st
    try { st = fs.lstatSync(next) } catch { return path.join(next, ...parts.slice(i + 1)) }
    if (st.isSymbolicLink()) {
      return resolveThroughSymlinks(path.join(path.resolve(path.dirname(next), fs.readlinkSync(next)), ...parts.slice(i + 1)), depth + 1)
    }
    cur = next
  }
  // 最后一段对大小写不敏感的文件系统（macOS/Windows）取规范大小写，避免靠大小写绕过
  try { return fs.realpathSync.native(cur) } catch { return cur }
}

/** child 是否等于或位于 parent 之内（两边都先解析符号链接；大小写不敏感平台按小写比较） */
export function isWithin(parent, child) {
  let a; let b
  try { a = resolveThroughSymlinks(parent); b = resolveThroughSymlinks(child) } catch { return true } // 解析不了就当作"在内"：宁可误拒
  if (process.platform === 'darwin' || process.platform === 'win32') { a = a.toLowerCase(); b = b.toLowerCase() }
  const rel = path.relative(a, b)
  // 只有恰好是 `..` 或以 `../` 开头才算在外；`..name`（如 data/..run）是 data 的合法子项
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel))
}

/** 独占创建并写入（O_EXCL，不跟随符号链接，不覆盖已有文件）。 */
export function writeExclusive(file, data) {
  fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 })
}
