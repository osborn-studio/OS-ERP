/**
 * ============================================================================
 * 文件标识：server/lib/profile.js ｜ 临时分段计时器：`GML_PROFILE=1` 时把一次请求内各代码块的耗时写进结构化日志（AA5）
 * ============================================================================
 * 【职责】给看板汇总这类"一个处理器里十几段查询"的接口逐块计时，找出 ≥50 ms 的块。
 *   默认关闭（环境变量不是精确的 `1` 就关）；关闭时 `time()` 直接调用回调，不取时钟、不写日志、不分配。
 * 【边界】只**记录**：耗时只进 `logger`（一行 `profile_blocks`），**永远不进响应体**，也不改任何业务结果。
 *   开关在每次请求时读取环境变量，所以测试可以按进程设置；生产不应长期开启（日志里多一行/请求）。
 * ============================================================================
 */
import { performance } from 'node:perf_hooks'
import { logger } from './logger.js'

export function profilingEnabled(env = process.env) {
  return env.GML_PROFILE === '1'
}

const OFF = Object.freeze({ enabled: false, time: (_name, fn) => fn(), done() {} })

/** 为一次请求创建计时器；`label` 是接口名（如 `dashboard.summary`）。 */
export function createProfiler(label, env = process.env, log = logger) {
  if (!profilingEnabled(env)) return OFF
  const blocks = {}
  const t0 = performance.now()
  return {
    enabled: true,
    time(name, fn) {
      const s = performance.now()
      try { return fn() } finally { blocks[name] = Math.round((performance.now() - s) * 100) / 100 }
    },
    done(extra = {}) {
      log.info('profile_blocks', { label, ...extra, total_ms: Math.round((performance.now() - t0) * 100) / 100, blocks })
    }
  }
}
