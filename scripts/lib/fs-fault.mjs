/**
 * ============================================================================
 * 文件标识：scripts/lib/fs-fault.mjs ｜ 文件系统写入序列的故障注入点（AD6，仅测试模式）
 * ============================================================================
 * 【职责】给"导出 → fsync → 删除 → 锚定"（audit-archive）、"快照 → 清单 → 报告"（db-backup）、"加锁 → 追加 → fsync → 解锁"（evidence-log）
 *   这类多步写入序列提供可命名的注入点：`faultPoint('archive.after-delete')`。环境变量 `GML_TEST_FS_FAULT=<点名>` 命中时，按
 *   `GML_TEST_FS_FAULT_MODE=throw|abort`（默认 throw）抛错或 `process.abort()`（SIGABRT，不跑 finally / exit 处理器，最接近断电）。
 * 【安全】未设置 GML_TEST_FS_FAULT ⇒ 注入点是纯空操作。设置了而 GML_RUNTIME_MODE 不是 `test` ⇒ 拒绝（抛 FS_FAULT_FORBIDDEN）；
 *   点名不在登记表里（拼写错）⇒ 拒绝，免得"以为注入了其实没有"。各脚本启动时调 `assertFsFaultAllowed()`，让生产环境下误设的变量在
 *   做任何写入之前就失败，而不是等到某个注入点。
 * 【改它要注意什么】新增注入点必须同时登记到 FAULT_POINTS 并补测试与 docs/operations/audit-integrity.md 的恢复语义表；
 *   注入点只许插在两个写步骤之间，不得改变被插桩代码的任何行为。
 * ============================================================================
 */
// 不引入 server/runtime.js：本库会随 evidence-log.mjs 进入最小发行包夹具（verify-release 的包根里没有 server/），
// 判据只看环境变量本身——与 runtimeMode() 对 `test` 的判定一致（未设置 = 非 test ⇒ 拒绝）。
const runtimeMode = (env) => String(env.GML_RUNTIME_MODE ?? '').trim().toLowerCase()

export const FAULT_POINTS = Object.freeze({
  archive: ['archive.after-export-write', 'archive.after-export-fsync', 'archive.before-delete', 'archive.after-delete', 'archive.after-anchor'],
  backup: ['backup.after-db-copy', 'backup.after-enc-rename-fsync', 'backup.before-sidecar', 'backup.after-manifest-fsync', 'backup.after-sidecar'],
  log: ['log.after-lock', 'log.after-write-before-fsync', 'log.after-fsync-before-unlock']
})
const ALL = new Set(Object.values(FAULT_POINTS).flat())
const refuse = (code, message) => Object.assign(new Error(message), { code })

/** 校验环境里的注入配置（不触发）。未设置 ⇒ 返回 null；合法 ⇒ { name, mode }；否则抛错。 */
export function assertFsFaultAllowed(env = process.env) {
  const name = env.GML_TEST_FS_FAULT
  const mode = env.GML_TEST_FS_FAULT_MODE
  if (name === undefined && mode === undefined) return null
  if (runtimeMode(env) !== 'test') throw refuse('FS_FAULT_FORBIDDEN', 'GML_TEST_FS_FAULT / GML_TEST_FS_FAULT_MODE 只允许在 GML_RUNTIME_MODE=test 下设置')
  if (name === undefined || !ALL.has(name)) throw refuse('FS_FAULT_UNKNOWN', `未知的故障注入点 ${JSON.stringify(name)}（可用：${[...ALL].join(', ')}）`)
  if (mode !== undefined && mode !== 'throw' && mode !== 'abort') throw refuse('FS_FAULT_MODE_INVALID', 'GML_TEST_FS_FAULT_MODE 只能是 throw 或 abort')
  return { name, mode: mode ?? 'throw' }
}

/** 注入点。未配置 ⇒ 空操作；配置但不是本点 ⇒ 空操作；命中 ⇒ 抛错或 abort。 */
export function faultPoint(point, env = process.env) {
  if (!ALL.has(point)) throw refuse('FS_FAULT_UNKNOWN', `代码里使用了未登记的注入点 ${point}`)
  const cfg = assertFsFaultAllowed(env)
  if (!cfg || cfg.name !== point) return
  if (cfg.mode === 'abort') process.abort()
  throw refuse('FS_FAULT_INJECTED', `injected filesystem fault at ${point}`)
}
