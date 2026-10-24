/**
 * ============================================================================
 * 文件标识：scripts/lib/source-identity.mjs ｜ 计时/规模证据的来源身份：提交、脏工作区指纹（含未跟踪文件内容）、SQLite / Node 版本
 * ============================================================================
 * 【职责】synth-data（摘要）与 synth-pipeline（报告）共用，保证"同一份数字"能追到同一份代码与运行时。
 *   工作区脏时指纹 = sha256(git status --porcelain + git diff HEAD + 每个未跟踪文件的路径与内容)；
 *   未跟踪文件单个超过 2 MB 的只记路径与大小（避免把大产物哈希进去），指纹里会带上 `+size`。
 * 【改它要注意什么】只读 git，不写任何东西；git 不可用时 `git_head` 为 null（证据不完整，调用方应在报告里如实显示）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export function sourceIdentity() {
  const git = (...a) => spawnSync('git', a, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const head = git('rev-parse', 'HEAD')
  const status = git('status', '--porcelain', '--untracked-files=all')
  const dirty = status.status === 0 && status.stdout.trim().length > 0
  let fingerprint = null
  if (dirty) {
    const h = crypto.createHash('sha256').update(status.stdout).update(git('diff', 'HEAD').stdout || '')
    const untracked = (git('ls-files', '--others', '--exclude-standard', '-z').stdout || '').split('\0').filter(Boolean).sort()
    for (const rel of untracked) {
      h.update(`\0${rel}\0`)
      try {
        const file = path.join(ROOT, rel)
        const st = fs.lstatSync(file)
        if (st.isFile() && st.size <= 2 * 1024 * 1024) h.update(fs.readFileSync(file))
        else h.update(`+size:${st.size}`)
      } catch { h.update('+unreadable') }
    }
    fingerprint = h.digest('hex')
  }
  const mem = new Database(':memory:')
  const sqlite = mem.prepare('SELECT sqlite_version() v').get().v
  mem.close()
  return {
    git_head: head.status === 0 ? head.stdout.trim() : null,
    git_dirty: dirty,
    git_dirty_fingerprint: fingerprint,
    sqlite_version: sqlite,
    better_sqlite3: createRequire(import.meta.url)('better-sqlite3/package.json').version,
    node: process.version
  }
}
