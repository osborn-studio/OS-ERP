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
 * 【登记报告】（AH6）buildFaultReport / writeFaultReport：测试在 GML_FS_FAULT_REPORT=<文件> 时把每次注入（点名、模式、结果）写成 JSON，只含白名单字段，target_host 恒为 false。
 * 【改它要注意什么】新增注入点必须同时登记到 FAULT_POINTS 并补测试与 docs/operations/audit-integrity.md 的恢复语义表；
 *   注入点只许插在两个写步骤之间，不得改变被插桩代码的任何行为。
 * ============================================================================
 */
// AH6：GML_FS_FAULT_REPORT=<文件> 时，测试把每次注入（点名、模式、结果）汇总写成 JSON（CI 的 fs-fault job 上传它）。
import fs from 'node:fs'
import path from 'node:path'
// 不引入 server/runtime.js：本库会随 evidence-log.mjs 进入最小发行包夹具（verify-release 的包根里没有 server/），
// 判据只看环境变量本身——与 runtimeMode() 对 `test` 的判定一致（未设置 = 非 test ⇒ 拒绝）。
const runtimeMode = (env) => String(env.GML_RUNTIME_MODE ?? '').trim().toLowerCase()

export const FAULT_POINTS = Object.freeze({
  archive: ['archive.after-export-write', 'archive.after-export-fsync', 'archive.before-delete', 'archive.after-delete', 'archive.after-anchor'],
  backup: ['backup.after-db-copy', 'backup.after-enc-rename-fsync', 'backup.before-sidecar', 'backup.after-manifest-fsync', 'backup.after-sidecar', 'backup.after-report-write-before-rename', 'backup.after-prune-delete-before-dirsync', 'backup.encrypt-before-rename', 'backup.prune-between-backup-and-manifest'],
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

/**
 * AH6：把一组注入记录整理成登记报告（纯函数）。records: [{ script, point, mode, status, signal }]。
 * 只写固定白名单字段（平台、Node 版本、点名、模式、结果），不含环境变量、路径或输出内容。
 * target_host 恒为 false：这份报告来自开发机或托管 runner，不是 dmserver / 发行验收。
 */
export function buildFaultReport(records, env = process.env, now = new Date()) {
  const injections = records.map((r) => ({
    script: String(r.script),
    point: String(r.point),
    mode: String(r.mode ?? 'throw'),
    result: r.result ?? 'injected', // injected = 确认走到该点；not-reached = 配置了但进程正常结束；refused = 配置被拒
    outcome: r.signal ? `signal:${r.signal}` : `exit:${r.status}`
  }))
  const seen = new Set(injections.filter((i) => i.result === 'injected').map((i) => i.point))
  return {
    schema: 'os-erp.fs-fault-report/1',
    generated_at: now.toISOString(),
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    hosted_runner: env.GITHUB_ACTIONS === 'true',
    target_host: false,
    note: 'hosted runner or development machine; not a target host and not release acceptance',
    registered_points: [...ALL].length,
    summary: {
      attempts: injections.length,
      injected: injections.filter((i) => i.result === 'injected').length,
      not_reached: injections.filter((i) => i.result === 'not-reached').length,
      refused: injections.filter((i) => i.result === 'refused').length,
      aborted: injections.filter((i) => i.outcome === 'signal:SIGABRT').length,
      nonzero_exit: injections.filter((i) => /^exit:(?!0$)/.test(i.outcome)).length,
      exit_zero: injections.filter((i) => i.outcome === 'exit:0').length
    },
    not_exercised: [...ALL].filter((p) => !seen.has(p)),
    injections
  }
}

/** 写报告（同步，可在 process.on('exit') 里调用）；失败只写 stderr，不改变测试结果。 */
export function writeFaultReport(file, records, env = process.env) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(buildFaultReport(records, env), null, 2) + '\n')
    return true
  } catch (e) {
    console.error(`fs-fault report not written: ${e.message}`)
    return false
  }
}
