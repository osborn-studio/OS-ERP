/**
 * ============================================================================
 * 文件标识：scripts/lib/reap.mjs ｜ 回收 spawn 出去的子进程（服务端）—— 整族**唯一实现**。
 * ============================================================================
 * 【职责】回收 spawn 出去的子进程（服务端）—— 整族**唯一实现**。
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
 * 回收 spawn 出去的子进程（服务端）—— 整族**唯一实现**。
 *
 * 为什么抽成模块（而不是各脚本内联一份）：
 *   本批有 3 个 `test-*.mjs` 会 spawn `server/index.js`。各写一版就是"同一判据两份实现"，
 *   而这条判据**已经踩过两个坑**，两处都会各自再踩一遍：
 *     ① `child.kill()` 只表示"信号发出去了"，**不等于进程真的没了** ——
 *        实测留下过一只 `node server/index.js` 一直监听端口（还持有库文件，下一轮撞端口）。
 *     ② 在 `exit` 钩子里用 `process.kill(pid, 0)` 探活**必报"存在"**（子进程还没被 reap）
 *        ⇒ **假红**。**假红比漏报更耗信任**：一个恒报"回收失败"的守卫会让人不再信整条证据链。
 *   形状与 `test-guards.mjs:166-205` 完全一致（那边是内联版，先落地并被实测验证）。
 *
 * 三条要点：
 *   ① 快路径用 `exitCode !== null || signalCode !== null`（Node 只在真的 reap 后置位，可靠），
 *      **不要**用 `pidAlive` 当快路径判据；
 *   ② SIGKILL 之后**轮询**（50ms × 上限 1.5s）：秒退时立刻下结论、不白等；
 *      "失败"来自多次重探 ⇒ 天然免疫瞬时假红；
 *   ③ `exit` 钩子**只发信号、不打字不下结论**（否则同一件事被说两遍、还说错一遍）。
 *
 * 后置条件同时看**端口已释放**（比"pid 还在"更贴近"这一轮有没有把环境还回去"）：
 *   `lsof` 不可用时返回 null（**不当成失败**，避免为了一个观察不到的量报假红）。
 */
import { spawnSync } from 'node:child_process'

/** 进程是否还活着。`EPERM` = 存在但无权限（这里不该发生，保守算活着） */
export function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** 监听端口是否已释放：true 已释放 / false 仍被监听 / null 无法判定（不当成失败） */
export function portReleased(port) {
  if (!port) return null
  try {
    const r = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    if (r.error || typeof r.stdout !== 'string') return null
    return r.stdout.trim() === ''
  } catch {
    return null
  }
}

/**
 * SIGKILL 子进程并**等到确认**，然后打印结论。
 * @param {import('node:child_process').ChildProcess|null} child
 * @param {{port?: number|null, timeoutMs?: number}} opts
 * @returns {Promise<boolean>} 是否确认已消失
 */
export async function stopAndReport(child, { port = null, timeoutMs = 1500 } = {}) {
  if (!child) {
    console.log('[回收] 无子进程需要回收')
    return true
  }
  const pid = child.pid
  // 快路径：Node 只在真的退出/reap 之后才置位这两个字段
  if (child.exitCode !== null || child.signalCode !== null) {
    console.log(`[回收] 已回收 pid ${pid}（结束时已退出）`)
    return true
  }
  try {
    child.kill('SIGKILL')
  } catch {
    /* 已经没了 */
  }
  const t0 = Date.now()
  let gone = false
  while (Date.now() - t0 < timeoutMs) {
    if (!pidAlive(pid)) {
      gone = true
      break
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  if (!gone) gone = !pidAlive(pid)
  const portState = portReleased(port)
  const portMsg =
    portState === null ? '' : portState ? `，端口 ${port} 已释放` : `，⚠️ 端口 ${port} 仍被监听`
  console.log(
    gone
      ? `[回收] 已回收 pid ${pid}${portMsg}`
      : `[回收] ⚠️ 回收失败，pid ${pid} 仍在${portMsg}（请 lsof -p ${pid} 复查）`
  )
  return gone
}

/** 静默兜底：任何路径退出时再补一发（不能 await ⇒ 只发信号、不承诺结果、也不下结论） */
export function installReapFallback(child) {
  process.on('exit', () => {
    try {
      if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    } catch {
      /* 已经没了 */
    }
  })
}
