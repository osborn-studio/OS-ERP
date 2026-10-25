/**
 * ============================================================================
 * 文件标识：scripts/lib/data-separation.mjs ｜ 数据目录 / 数据库文件的属主与权限评估（AH5，ADR-0055 补充 4）：只报告，不强制
 * ============================================================================
 * 【职责】`local-manage doctor` 用它回答“谁能直接写库”——能直接写数据库的人可以伪造未签名的锚点操作意图（ADR-0055 补充 4 的威胁模型边界）。
 *   对数据目录与其中的 `gml_*.db`（及 -wal / -shm）逐个 lstat（不跟随符号链接），给出一个状态与逐条发现：
 *     · exposed        其他账号可写（目录或库文件 world-writable）——任何本机账号都能直接改库，高危；
 *     · group-shared   同组账号可写——组成员等于“能写库者”，中危；
 *     · unknown        无法判断（符号链接、读目录 / stat 失败）——不当作通过；
 *     · separated      文件属于**另一个**账号，且当前账号对它们都没有写权限（运行本命令的账号不是能写库者）；
 *     · single-account 数据归当前账号所有或当前账号仍可写——没有账号级隔离，只能靠离机私钥签名意图（`GML_ANCHOR_INTENT_KEY` + `--require-signed-intents`）；
 *     · not-created    数据目录尚未创建；  · skipped  平台无法判定（Windows 没有可比的 uid / 模式位）。
 * 【边界】这是文件级的账号隔离检查，不是表级的：SQLite 把意图表与业务表放在同一个库文件里，应用账号要写业务数据就必然能写这个文件。
 *   所以“只读应用账号 + 仅 CLI 账号可写意图表”在当前单文件架构下只能通过**应用账号对库文件只读、维护操作由另一账号执行**达到，评估结果只是如实报告现状。
 *   纯函数：stat / 读目录 / 写权限探测 / uid / platform 都可注入，便于测试；真实实现用 lstatSync / readdirSync / accessSync。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

const DB_FILE = /^gml_(cosmetic|food|apparel)\.db(-wal|-shm)?$/
const ADVICE = '能直接写数据库的账号可以伪造未签名的锚点操作意图。缓解：把 GML_ANCHOR_INTENT_KEY 私钥放在业务主机之外并用 audit-verify-chain --require-signed-intents 复核；'
  + '同时让数据目录只属于运维账号、不对组 / 其他开放写权限（见 docs/operations/audit-integrity.md「谁能写库」）。'

const realFs = {
  platform: process.platform,
  uid: typeof process.getuid === 'function' ? process.getuid() : null,
  lstat: (p) => fs.lstatSync(p),
  list: (dir) => fs.readdirSync(dir),
  canWrite: (p) => { try { fs.accessSync(p, fs.constants.W_OK); return true } catch { return false } }
}

export function assessDataSeparation({ dataDir, ...injected }) {
  const io = { ...realFs, ...injected }
  const done = (status, message, findings = []) => ({ status, enforced: false, message, findings, advice: ADVICE })
  if (io.platform === 'win32') return done('skipped', 'skipped: file ownership / permission bits cannot be compared on win32 (Windows); verify the data directory ACL manually')
  if (io.uid === null || io.uid === undefined) return done('skipped', 'skipped: the current account id is not available on this platform')
  const findings = []
  const add = (code, severity, p, detail) => findings.push({ code, severity, path: p, detail })
  let top
  try { top = io.lstat(dataDir) } catch (error) {
    if (error.code === 'ENOENT') return done('not-created', 'data directory not created yet (尚未创建): run setup/start first, then re-run doctor')
    return done('unknown', `cannot inspect the data directory (${error.code || error.message})`)
  }
  if (top.isSymbolicLink()) {
    add('symlink', 'medium', dataDir, 'data directory is a symbolic link; the real location was not inspected')
    return done('unknown', 'data directory is a symbolic link: inspect its real target', findings)
  }
  let names
  try { names = io.list(dataDir).filter((n) => DB_FILE.test(n)).sort() } catch (error) { return done('unknown', `cannot list the data directory (${error.code || error.message})`) }
  const targets = [dataDir, ...names.map((n) => path.join(dataDir, n))]
  let foreignOwner = 0
  let unreadable = 0
  let linked = 0
  for (const p of targets) {
    let st
    try { st = p === dataDir ? top : io.lstat(p) } catch (error) { unreadable++; add('stat-failed', 'medium', p, error.code || error.message); continue }
    if (st.isSymbolicLink()) { linked++; add('symlink', 'medium', p, 'symbolic link; the real file was not inspected'); continue }
    if (st.mode & 0o002) add('world-writable', 'high', p, 'writable by any local account')
    else if (st.mode & 0o020) add('group-writable', 'medium', p, 'writable by the owning group')
    if (st.uid === io.uid) add('same-account', 'info', p, 'owned by the account running this command')
    else if (io.canWrite(p)) add('writable-by-this-account', 'info', p, 'owned by another account but writable from this one (root, ACL or group)')
    else foreignOwner++
  }
  const has = (code) => findings.some((f) => f.code === code)
  if (has('world-writable')) return done('exposed', 'the data directory or a database file is writable by any local account', dedupe(findings))
  if (has('group-writable')) return done('group-shared', 'the owning group can write the data directory or a database file: group members can write the database', dedupe(findings))
  if (linked || unreadable) return done('unknown', 'some paths could not be inspected (symbolic link or stat failure)', dedupe(findings))
  if (foreignOwner === targets.length) return done('separated', 'data is owned by another account and not writable from this one', [])
  return done('single-account', 'no account-level separation: the account that owns / can write the data can also forge unsigned anchor intents', dedupe(findings))
}

/** 同一种 info 发现只留一条（目录 + 多个库文件会重复），其余原样保留 */
function dedupe(findings) {
  const seen = new Set()
  return findings.filter((f) => f.severity !== 'info' || (!seen.has(f.code) && seen.add(f.code)))
}
