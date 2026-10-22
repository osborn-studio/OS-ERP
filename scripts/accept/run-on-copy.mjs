#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/accept/run-on-copy.mjs ｜ 独立验收：在**独立副本**上跑独立验收。
 * ============================================================================
 * 【职责】独立验收：在**独立副本**上跑独立验收。
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 在**独立副本**上跑独立验收。
 *
 * 为什么非要复制一份：
 *   验收的定义里有一条是"独立副本" —— 不是"独立库"就够了。在开发工作区里跑，
 *   被测的代码就是**我自己正在改的代码**，而验收要回答的是"这个**提交**怎么样"。
 *   两者差一步：工作区里可能有没提交的改动，而结论最后要挂在一个固定 SHA 上。
 *
 * 做法：
 *   ① 只复制**源码与配置**（server/ scripts/ src/ + 各配置文件），不复制 data/ dist/ node_modules/；
 *   ② node_modules 用**只读软链**复用 —— 依赖不属于被测对象，没必要再装一遍；
 *   ③ 在副本里跑 selfcheck（它自己按 `../..` 定位根目录，所以天然落在副本上）；
 *   ④ 把证据 JSON 拷回真仓库的 docs/evidence/；
 *   ⑤ 无论成败都删副本。
 *
 * 用法：node scripts/accept/run-on-copy.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, rmSync, symlinkSync, existsSync, readdirSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const dirs = ['server', 'scripts', 'src', 'public']
const files = ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'vite.config.js', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'enter.html']

const sha = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
const dirty = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim()
console.log(`独立副本验收\n  源 ${ROOT}\n  提交 ${sha}${dirty ? `\n  ⚠️ 工作区有 ${dirty.split('\n').length} 处未提交改动 —— 副本跑的是"当前工作区"而不是这个提交` : '（工作区干净）'}`)

const TMP = mkdtempSync(path.join(tmpdir(), 'gml-copy-'))
const REPO = path.join(TMP, 'repo')

try {
  for (const d of dirs) if (existsSync(path.join(ROOT, d))) cpSync(path.join(ROOT, d), path.join(REPO, d), { recursive: true })
  for (const f of files) if (existsSync(path.join(ROOT, f))) { mkdirSync(REPO, { recursive: true }); copyFileSync(path.join(ROOT, f), path.join(REPO, f)) }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(REPO, 'node_modules'), 'dir')

  // ---------- 隔离哨兵 ----------
  // 为什么要有它：selfcheck 原来靠 `ROOT !== '<硬编码路径>'` 判断"是不是副本" ——
  // 那是**字面量比对**，换机器/换目录就误报，既证不了实也证不了伪。
  // 现在改成：**只有 run-on-copy 会往副本里写这个文件**，所以"哨兵在"就是
  // "这份证据确实出自副本"的硬证据；顺带把源仓库的 HEAD sha 与复制时间固定下来，
  // 让证据能挂到一个确定的提交上（副本里没有 .git，不然只能记 null）。
  const sentinelPath = path.join(REPO, '.accept-sentinel.json')
  writeFileSync(sentinelPath, JSON.stringify({
    kind: 'accept-isolation-sentinel',
    written_by: 'scripts/accept/run-on-copy.mjs',
    source_root: ROOT,
    source_head_sha: sha,
    source_working_tree_dirty_lines: dirty ? dirty.split('\n').length : 0,
    copied_at: new Date().toISOString(),
    note: '本文件只出现在**副本**里；仓库的 .gitignore 之外无需清理（副本跑完即删）'
  }, null, 2))

  const r = spawnSync(process.execPath, [path.join(REPO, 'scripts/accept/selfcheck.mjs'), ...process.argv.slice(2)], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    // 副本里没有 `.git`（刻意不复制），所以把源仓库的 SHA 与工作区状态**传进去** ——
    // 证据里必须写清"验的是哪一版"，而 null 的 SHA 等于不知道。
    // 哨兵路径也传进去（selfcheck 默认会去 ROOT 下找，两者语义一致）。
    env: {
      ...process.env,
      GML_ACCEPT_SHA: sha,
      GML_ACCEPT_DIRTY: dirty,
      GML_ACCEPT_SENTINEL: sentinelPath,
      GML_ACCEPT_IS_COPY: '1'
    }
  })
  process.stdout.write(r.stdout || '')
  process.stderr.write(r.stderr || '')

  // 证据拷回真仓库（副本里写出来的那份路径在副本内）
  const evSrc = path.join(REPO, 'docs/evidence')
  const evDst = path.join(ROOT, 'docs/evidence')
  mkdirSync(evDst, { recursive: true })
  const copied = []
  if (existsSync(evSrc)) {
    for (const f of readdirSync(evSrc)) {
      if (f.startsWith('独立验收_')) { copyFileSync(path.join(evSrc, f), path.join(evDst, f)); copied.push(f) }
    }
  }
  // ⚠️ 这句话必须**由实算派生**：原来它无条件打印「证据已拷回 …」——
  // 而 selfcheck 若没跑到产出那一步（崩了 / 被参数闸门拒了 / 提前退出），
  // 副本里根本没有那两份文件，拷贝循环一次都不进，读者却被告知"已拷回"。
  // 这是"自称的元信息没有由实算派生"，与 is_isolated_copy 那条假信号同一族。
  console.log(copied.length
    ? `\n证据已拷回 ${evDst}（实拷 ${copied.length} 份：${copied.join(' · ')}）`
    : `\n⚠️ **没有任何证据文件被拷回**：副本里 ${evSrc} 不存在，或其中没有「独立验收_」开头的文件。\n`
      + `   —— 这通常意味着 selfcheck 没跑到"产出证据"那一步（崩了 / 被参数闸门拒了 / 提前退出）。\n`
      + `   —— **别把这一行当成"已归档"**；回看上面的 selfcheck 输出与退出码。`)
  process.exitCode = r.status || 0
} finally {
  rmSync(TMP, { recursive: true, force: true })
}
