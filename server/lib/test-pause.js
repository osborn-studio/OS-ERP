/**
 * ============================================================================
 * 文件标识：server/lib/test-pause.js ｜ 仅测试模式的"暂停点"：写标记文件并同步等放行文件（AF4，ADR-0054 补充 2）
 * ============================================================================
 * 【职责】让竞态测试能在两个真实进程之间确定性地排出"A 已决定、B 先提交、A 再继续"的顺序，而不靠 sleep。
 *   `testPause(envName, name)`：环境变量 `envName` 未设置 → 什么都不做（生产路径零成本，只读一次 `process.env`）；
 *   设置了但 `GML_RUNTIME_MODE` 不是 `test` → 抛 `PAUSE_HOOK_FORBIDDEN`（与 `audit-archive` 的钩子同一约定）；
 *   否则在目录 `<env 值>` 写 `.<name>-paused`（内容为 pid），再同步轮询等待 `.<name>-continue` 出现。
 * 【边界】同步阻塞当前进程（含事件循环）——只用于测试子进程；等待有上限（默认 60 s），超时抛 `PAUSE_HOOK_TIMEOUT`，不会永久挂住。
 *   放行文件已存在时直通（同一次请求里多次经过同名暂停点只停第一次）；测试删掉 paused / continue 两个标记文件即可重新布防。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'

export function testPause(envName, name, { timeoutMs = 60000, env = process.env } = {}) {
  const dir = env[envName]
  if (dir === undefined || dir === '') return false
  if (env.GML_RUNTIME_MODE !== 'test') throw Object.assign(new Error(`PAUSE_HOOK_FORBIDDEN: ${envName} 只允许在 GML_RUNTIME_MODE=test 下设置`), { code: 'PAUSE_HOOK_FORBIDDEN' })
  fs.mkdirSync(dir, { recursive: true })
  if (fs.existsSync(path.join(dir, `.${name}-continue`))) return false // 已放行：直通（测试删掉两个标记文件即可重新布防）
  fs.writeFileSync(path.join(dir, `.${name}-paused`), String(process.pid))
  const wait = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + timeoutMs
  while (!fs.existsSync(path.join(dir, `.${name}-continue`))) {
    if (Date.now() > deadline) throw Object.assign(new Error(`${envName}: 等待放行超时`), { code: 'PAUSE_HOOK_TIMEOUT' })
    Atomics.wait(wait, 0, 0, 25)
  }
  return true
}

export default { testPause }
