/**
 * ============================================================================
 * 文件标识：tests/lib/load-tolerance.mjs ｜ 受负载影响的断言/等待的统一常量（AH1）
 * ============================================================================
 * 【职责】把散落在测试里、会被 CI 负载抖动拖红的"魔法数"（子进程超时、服务就绪轮询、HTTP 单次请求上限、
 *   带宽/重试预算）集中成命名常量，并用同一个倍率 `LOAD_FACTOR` 缩放。
 *
 * 【倍率】`GML_TEST_LOAD_FACTOR`（正数，缺省 1；托管 runner 可设 2–3）。**只放宽等待与超时上限，不放宽被测行为的断言**：
 *   例如"重试次数 ≥ 1"、"完整性检查通过"、"零重复行"仍是精确断言，不在这里。
 *
 * 【规矩】新增会随负载波动的数字先看这里有没有现成常量；没有就加一个并写清它放宽的是什么。
 *   本文件无副作用（不读写磁盘、不开端口），可被任何测试导入。
 * ============================================================================
 */

function parseFactor(raw) {
  if (raw == null || raw === '') return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) throw new Error(`GML_TEST_LOAD_FACTOR must be a positive number, got ${JSON.stringify(raw)}`)
  return Math.min(n, 20)
}

/** 当前倍率。 */
export const LOAD_FACTOR = parseFactor(process.env.GML_TEST_LOAD_FACTOR)

/** 毫秒数按倍率放宽（向上取整）。 */
export const scaleMs = (ms) => Math.ceil(ms * LOAD_FACTOR)

/** 子进程（spawnSync / 单个脚本）超时：短（单个 CLI）、中（一次基准）、长（整条发行候选构建）。 */
export const SPAWN_TIMEOUT_SHORT_MS = scaleMs(60_000)
export const SPAWN_TIMEOUT_MEDIUM_MS = scaleMs(150_000)
export const SPAWN_TIMEOUT_LONG_MS = scaleMs(280_000)

/** node:test 的单用例 `timeout` 选项：快 / 中 / 慢。 */
export const CASE_TIMEOUT_FAST_MS = scaleMs(120_000)
export const CASE_TIMEOUT_MEDIUM_MS = scaleMs(180_000)
export const CASE_TIMEOUT_SLOW_MS = scaleMs(240_000)
export const CASE_TIMEOUT_CANDIDATE_MS = scaleMs(590_000)

/** 起服务后等待就绪：轮询次数 × 间隔（默认 1200 × 50 ms = 60 s，随倍率放宽）。 */
export const READY_POLL_INTERVAL_MS = 50
export const READY_POLL_ATTEMPTS = Math.ceil(1200 * LOAD_FACTOR)

/** 对真实服务发的单次 HTTP 请求的 AbortSignal 上限。 */
export const FETCH_TIMEOUT_MS = scaleMs(15_000)

/** 等待某个条件成立的轮询（间隔 25 ms）次数，默认 1000 次 = 25 s。 */
export const UNTIL_POLL_INTERVAL_MS = 25
export const UNTIL_POLL_ATTEMPTS = Math.ceil(1000 * LOAD_FACTOR)

/**
 * 写争用基准（bench-api --profile=write）的重试预算：busy-ms 15 < 外部写者占锁 25 ms，retry-max 10 是脚本上限；
 * 预算已经是上限，所以这里**不随倍率变**——放宽的办法是减少迭代数，而不是再加重试。
 */
export const WRITE_BENCH = Object.freeze({ busyMs: 15, retryMax: 10, contenderHoldMs: 25, contenderGapMs: 10 })

/** 轮询辅助：`pred()` 在 attempts 次内为真则返回 true。 */
export async function pollUntil(pred, { attempts = UNTIL_POLL_ATTEMPTS, intervalMs = UNTIL_POLL_INTERVAL_MS } = {}) {
  for (let i = 0; i < attempts; i++) {
    if (await pred()) return true
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return Boolean(await pred())
}

/** 慢套件剩余等待预算：默认值保持原上限；不用于 TTL、锁持有、数据量或业务断言。 */
export const SLOW_WAIT = Object.freeze({
  probeMs: scaleMs(5_000),
  bootstrapMs: scaleMs(30_000),
  cliMs: scaleMs(120_000),
  httpShortMs: scaleMs(10_000),
  httpCaseMs: scaleMs(90_000),
  serverCaseMs: scaleMs(300_000),
  candidateCaseMs: scaleMs(290_000),
  extendedReadyAttempts: Math.ceil(2400 * LOAD_FACTOR),
  productionReadyAttempts: Math.ceil(250 * LOAD_FACTOR),
  archivePauseAttempts: Math.ceil(600 * LOAD_FACTOR),
  profileAttempts: Math.ceil(100 * LOAD_FACTOR)
})
