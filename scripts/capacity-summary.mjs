#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/capacity-summary.mjs ｜ 夜间容量基线：把流水线报告与写档压测 JSON 缩减为白名单摘要并给出失败判定（roadmap-v5 Z10）
 * ============================================================================
 * 【职责】读 `synth-pipeline.mjs` 的报告与 `bench-api.mjs --profile=write` 的报告，只挑出下面列出的数值/布尔/短名字段，
 *   写成一份摘要 JSON（`--out`，上传到 Actions artifact）并原样打印到作业日志。判定（退出码 1）只有三类：
 *   ① 流水线报告缺失/不可解析，或其 `ok` 不是 true（任一步骤失败）；② 索引审计违规数 > 0；③ 读档或写档压测错误数 > 0（或写档完整性核对失败/缺失）。
 *   延迟只记录，不设阈值：托管 runner 的数字是趋势指示，不是容量承诺，也不是目标主机（dmserver）结果。
 *
 * 【安全判据】输出只来自白名单取值：数字必须有限、布尔、名字必须匹配 /^[A-Za-z0-9_.-]{1,64}$/ 否则记为 "?"；
 *   从不输出输入文件里的任何路径、主机名、环境变量、密钥、错误原文、stderr 尾部或违规明细文本（只输出违规条数与语句 id）。
 *   失败时只打印固定原因码，不回显文件路径或异常消息。`--out` 必须是尚不存在的新文件（不覆盖、不跟随符号链接）。
 *
 * 【用法】node scripts/capacity-summary.mjs --pipeline <pipeline-report.json> --write <bench-write.json> --out <summary.json> [--scale <label>]
 *   退出码：0 无失败判定；1 有失败判定（摘要仍写出）；2 用法错误。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/
const SCALES = new Set(['small', 'medium', 'large'])

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const bool = (v) => (typeof v === 'boolean' ? v : null)
const name = (v) => (typeof v === 'string' && NAME_RE.test(v) ? v : '?')
const nums = (a) => (Array.isArray(a) ? a.slice(0, 3).map(num) : null)

function readJson(file) {
  try { return { value: JSON.parse(fs.readFileSync(file, 'utf8')) } } catch { return { value: null } }
}

export function reduceBenchEndpoints(list) {
  return (Array.isArray(list) ? list : []).slice(0, 40).map((e) => ({
    name: name(e?.name), requests: num(e?.requests), errors: num(e?.errors), p50_ms: num(e?.p50 ?? e?.latency_ms?.p50), p95_ms: num(e?.p95 ?? e?.latency_ms?.p95), p99_ms: num(e?.p99 ?? e?.latency_ms?.p99)
  }))
}

/** 纯函数：两份报告对象（可为 null）→ { summary, failures }。 */
export function buildSummary(pipeline, write, { scale = null, sha = null } = {}) {
  const failures = []
  const p = pipeline && typeof pipeline === 'object' ? pipeline : null
  const w = write && typeof write === 'object' ? write : null
  const steps = p?.steps && typeof p.steps === 'object' ? p.steps : {}
  if (!p) failures.push('pipeline_report_missing')
  else if (p.ok !== true) failures.push('pipeline_step_failed')

  const stepList = Object.keys(steps).slice(0, 20).map((k) => ({ step: name(k), ok: bool(steps[k]?.ok), wall_ms: num(steps[k]?.wall_ms) }))
  const ea = steps.explain_audit
  const violationCount = num(ea?.violations)
  if (p && ea == null) failures.push('explain_audit_missing')
  else if (violationCount == null && p) failures.push('explain_audit_unreadable')
  else if (violationCount > 0) failures.push('explain_audit_violations')
  const violationIds = Array.isArray(ea?.violation_list) ? ea.violation_list.slice(0, 20).map((s) => name(String(s).split(':')[0])) : []

  const br = steps.bench_api
  const readErrors = num(br?.totals?.errors)
  if (p && br == null) failures.push('bench_read_missing')
  else if (p && readErrors == null) failures.push('bench_read_unreadable')
  else if (readErrors > 0) failures.push('bench_read_errors')

  const wErrors = num(w?.totals?.errors)
  if (!w) failures.push('bench_write_missing')
  else if (wErrors == null) failures.push('bench_write_unreadable')
  else if (wErrors > 0) failures.push('bench_write_errors')
  if (w && bool(w.integrity?.ok) !== true) failures.push('bench_write_integrity')

  const summary = {
    schema_version: 1,
    scope_notice: 'GitHub-hosted runner, synthetic data, single run: trend indicator only. NOT a target-host (dmserver) result and NOT a capacity commitment.',
    scale: SCALES.has(scale) ? scale : '?',
    commit: typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) ? sha : null,
    verdict: failures.length ? 'FAIL' : 'PASS',
    failures,
    host: { platform: name(p?.host?.platform), arch: name(p?.host?.arch), cpus: num(p?.host?.cpus), total_mem_mb: num(p?.host?.total_mem_mb), node: name(p?.host?.node), loadavg_start: nums(p?.host?.loadavg_start), loadavg_end: nums(p?.host?.loadavg_end) },
    dataset: { table_counts: Object.fromEntries(Object.entries(p?.dataset?.table_counts && typeof p.dataset.table_counts === 'object' ? p.dataset.table_counts : {}).slice(0, 60).map(([k, v]) => [name(k), num(v)])), db_bytes: num(p?.dataset?.db_bytes), invariants_ok: bool(p?.dataset?.invariants_ok) },
    steps: stepList,
    explain_audit: { statements: num(ea?.statements), violations: violationCount, unused_allow: num(ea?.unused_allow), violation_statement_ids: violationIds },
    bench_read: { totals: { requests: num(br?.totals?.requests), errors: readErrors, error_rate: num(br?.totals?.error_rate), wall_seconds: num(br?.totals?.wall_seconds), throughput_rps: num(br?.totals?.throughput_rps) }, sqlite_busy_count: num(br?.sqlite_busy_count), endpoints: reduceBenchEndpoints(br?.endpoints) },
    bench_write: {
      totals: { requests: num(w?.totals?.requests), errors: wErrors, error_rate: num(w?.totals?.error_rate), wall_seconds: num(w?.totals?.wall_seconds), throughput_rps: num(w?.totals?.throughput_rps) },
      integrity_ok: bool(w?.integrity?.ok),
      contention: { server_busy_log_lines: num(w?.contention?.server_busy_log_lines), write_retry_log_lines: num(w?.contention?.write_retry_log_lines), write_retry_exhausted_log_lines: num(w?.contention?.write_retry_exhausted_log_lines) },
      operations: reduceBenchEndpoints(w?.operations)
    }
  }
  return { summary, failures }
}

function parseArgs(argv) {
  const o = { pipeline: null, write: null, out: null, scale: null }
  for (let i = 0; i < argv.length; i++) {
    const k = { '--pipeline': 'pipeline', '--write': 'write', '--out': 'out', '--scale': 'scale' }[argv[i]]
    if (!k || argv[i + 1] === undefined) throw Object.assign(new Error('usage'), { exitCode: 2 })
    o[k] = argv[++i]
  }
  if (!o.pipeline || !o.write || !o.out) throw Object.assign(new Error('usage'), { exitCode: 2 })
  return o
}

export function main(argv = process.argv.slice(2), env = process.env) {
  const o = parseArgs(argv)
  const out = path.resolve(o.out)
  try { fs.lstatSync(out); throw Object.assign(new Error('out_exists'), { exitCode: 2 }) } catch (e) { if (e.exitCode) throw e }
  const { summary, failures } = buildSummary(readJson(o.pipeline).value, readJson(o.write).value, { scale: o.scale, sha: env.GITHUB_SHA })
  const text = JSON.stringify(summary, null, 2) + '\n'
  fs.writeFileSync(out, text, { flag: 'wx', mode: 0o600 })
  process.stdout.write(text)
  console.log(`capacity-summary: ${summary.verdict}${failures.length ? ` (${failures.join(', ')})` : ''}`)
  return failures.length ? 1 : 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exit(main()) } catch (e) { console.error(`capacity-summary: ${e.exitCode === 2 ? 'usage or output refused' : 'internal error'}`); process.exit(e.exitCode ?? 1) }
}
