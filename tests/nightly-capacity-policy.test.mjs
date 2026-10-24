/**
 * ============================================================================
 * 文件标识：tests/nightly-capacity-policy.test.mjs ｜ 夜间容量工作流与摘要脚本的静态守卫（roadmap-v5 Z10）
 * ============================================================================
 * 便宜、诚实的文本断言：工作流存在、触发方式、Actions 按 SHA 固定、只上传摘要、失败条件只有约定的三类；
 * 摘要脚本只输出白名单字段、不打印路径/密钥；并用合成输入对 buildSummary 做行为断言。
 * 它们不证明工作流能在 GitHub 上跑通 —— 那要等它第一次真实运行。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSummary } from '../scripts/capacity-summary.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFileSync(path.join(ROOT, file), 'utf8')
const workflow = read('.github/workflows/nightly-capacity.yml')
const code = workflow.replace(/^\s*#.*$/gm, '')
const summaryScript = read('scripts/capacity-summary.mjs')
const ciDoc = read('docs/implementation/ci.md')

test('workflow triggers on a daily schedule and manual dispatch with a scale choice; read-only permissions', () => {
  assert.match(code, /^\s+schedule:\s*\n\s+-\s*cron:\s*'[^']+'/m)
  assert.match(code, /^\s+workflow_dispatch:/m)
  assert.match(code, /^\s+scale:[\s\S]*?type:\s*choice[\s\S]*?-\s*small[\s\S]*?-\s*medium[\s\S]*?-\s*large/m)
  assert.match(code, /^permissions:\s*\n\s+contents:\s*read\s*$/m)
  assert.doesNotMatch(code, /^\s+(pull_request|push|pull_request_target):/m, 'must not run on code events')
  assert.doesNotMatch(code, /:\s*write\s*$/m, 'no write permissions')
})

test('job runs on ubuntu-latest with a 60 minute timeout', () => {
  assert.match(code, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.equal(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]), 60)
})

test('every action is pinned to a 40-hex SHA with a version comment', () => {
  const uses = [...workflow.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)]
  assert.ok(uses.length >= 3)
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `unpinned action: ${ref}`)
    assert.match(rest, /#\s*v\d/, `missing version comment: ${ref}`)
  }
})

test('install uses npm ci --ignore-scripts then rebuilds only the selected native packages', () => {
  assert.match(code, /npm ci --ignore-scripts\b/)
  assert.match(code, /npm rebuild better-sqlite3 esbuild\b/)
})

test('runs the synth pipeline into RUNNER_TEMP-based paths, then the write profile, then the summary script', () => {
  assert.match(code, /CAP_RUN=\$RUNNER_TEMP\//)
  assert.match(code, /node scripts\/synth-pipeline\.mjs --dir "\$CAP_RUN" --keep/)
  assert.match(code, /node scripts\/bench-api\.mjs --profile=write\b[^\n]*--max-error-rate 0\b/)
  assert.match(code, /node scripts\/capacity-summary\.mjs --pipeline[^\n]*--write[^\n]*--out[^\n]*--scale/)
  assert.ok(code.indexOf('synth-pipeline.mjs') < code.indexOf('--profile=write') && code.indexOf('--profile=write') < code.indexOf('capacity-summary.mjs'))
  assert.match(code, /medium\)\s+args='--skus 20000 --docs 30000 --txns 150000'/)
})

test('scale input is matched against a fixed list through an env var and never interpolated into a script', () => {
  const runBlocks = [...code.matchAll(/^\s+run:\s*\|?\n?([\s\S]*?)(?=^\s+- |^\s+\w[\w-]*:\s*$|(?![\s\S]))/gm)].map(m => m[1]).join('\n')
  assert.doesNotMatch(runBlocks, /\$\{\{\s*inputs\./, 'inputs must not be interpolated into run scripts')
  assert.match(code, /SCALE_INPUT:\s*\$\{\{\s*inputs\.scale\s*\}\}/)
  assert.match(code, /\*\)\s*echo '::error::unknown scale'; exit 1/)
})

test('uploads exactly one file: the allowlisted summary JSON', () => {
  const uploads = [...code.matchAll(/uses:\s*actions\/upload-artifact@[\s\S]*?(?=^\s+- |(?![\s\S]))/gm)].map(m => m[0])
  assert.equal(uploads.length, 1)
  const withBlock = uploads[0]
  assert.match(withBlock, /^\s+path:\s*\$\{\{\s*runner\.temp\s*\}\}\/capacity-summary\/capacity-summary\.json\s*$/m)
  assert.doesNotMatch(withBlock, /^\s+path:\s*\|/m, 'single explicit path only')
  assert.doesNotMatch(withBlock, /[*]/, 'no globs')
  assert.doesNotMatch(withBlock, /capacity-run|capacity-reports|\.db|backup|\.log/i)
  assert.match(withBlock, /if-no-files-found:\s*error/)
  assert.match(code, /rm -rf "\$CAP_RUN" "\$CAP_REPORTS"/, 'raw data and reports are removed')
})

test('pipeline and bench steps redirect stdout AND stderr to disposable log files; raw output is never echoed', () => {
  assert.doesNotMatch(code, />\s*\/dev\/null\s*$/m, 'a stdout-only redirect leaves stderr in the public log')
  assert.match(code, /synth-pipeline\.mjs[^\n]*> "\$CAP_REPORTS\/pipeline\.log" 2>&1/)
  assert.match(code, /bench-api\.mjs[^\n]*> "\$CAP_REPORTS\/bench-write\.log" 2>&1/)
  assert.doesNotMatch(code, /cat "\$CAP_REPORTS\/[^"]*\.log"|tail [^\n]*\.log/, 'logs are never dumped')
})

test('the summary file lives in its own directory, apart from raw reports and databases', () => {
  assert.match(code, /CAP_SUMMARY=\$RUNNER_TEMP\/capacity-summary/)
  assert.match(code, /CAP_REPORTS=\$RUNNER_TEMP\/capacity-reports/)
  assert.doesNotMatch(code, /--out "\$CAP_SUMMARY\/(?!capacity-summary\.json")/)
})

test('failure gate: only failed pipeline step, failed write bench, or a non-successful summary step turn the job red', () => {
  const gate = code.slice(code.indexOf('- name: Gate'))
  assert.match(gate, /PIPELINE_OUTCOME.*= failure/)
  assert.match(gate, /WRITE_OUTCOME.*= failure/)
  assert.match(gate, /SUMMARY_OUTCOME.*!= success/)
  assert.match(code, /id:\s*pipeline\s*\n\s+continue-on-error:\s*true/)
  assert.match(code, /id:\s*summary\s*\n\s+if:\s*always\(\)/)
})

test('the workflow documents that numbers are trend indicators and that it is unexecuted', () => {
  assert.match(workflow, /TREND INDICATORS ONLY/)
  assert.match(workflow, /not been executed on GitHub/)
})

test('summary script prints only its own allowlisted object and fixed codes; never paths, env, or raw error text', () => {
  const body = summaryScript.replace(/\/\*\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  assert.doesNotMatch(body, /process\.env\s*[.\[]/, 'env is only read through the injected parameter')
  assert.doesNotMatch(body, /stderr|e\.message|error\.message|e\.stack|\.stack\b/, 'no raw error text')
  const outputs = [...body.matchAll(/(?:console\.(?:log|error|warn|info)|process\.std(?:out|err)\.write)\(([^\n]*)\)/g)].map(m => m[1])
  assert.ok(outputs.length >= 2)
  for (const o of outputs) {
    assert.doesNotMatch(o, /\b(out|o\.out|o\.pipeline|o\.write|file|argv|process\.cwd|__dirname|ROOT)\b/, `output must not mention a path: ${o}`)
  }
  assert.match(body, /const NAME_RE = /)
  assert.match(body, /flag:\s*'wx'/)
  assert.doesNotMatch(body, /stderr_tail|cpu_model|digest|token|secret|password/i, 'denylisted fields must not be copied')
})

test('buildSummary: clean inputs pass; each failure condition is reported; unknown and hostile strings are dropped', () => {
  const pipeline = {
    ok: true, host: { platform: 'linux', arch: 'x64', cpus: 4, node: 'v22.1.0', cpu_model: 'SECRET-CPU', loadavg_start: [1, 2, 3] },
    dataset: { table_counts: { products: 5 }, db_bytes: 10, invariants_ok: true, digest: 'abc' },
    steps: {
      explain_audit: { ok: true, statements: 61, violations: 0, unused_allow: 0, violation_list: ['/home/runner/x'], stderr_tail: '/home/runner/leak' },
      bench_api: { ok: true, totals: { requests: 100, errors: 0, error_rate: 0, wall_seconds: 1, throughput_rps: 2 }, sqlite_busy_count: 0, endpoints: [{ name: 'login', route: '/api/auth/login', requests: 10, errors: 0, p50: 1, p95: 2, p99: 3, secret: 'x' }] }
    }
  }
  const write = { totals: { requests: 30, errors: 0, error_rate: 0, wall_seconds: 1, throughput_rps: 3 }, integrity: { ok: true }, contention: {}, operations: [{ name: '/etc/passwd', requests: 1, errors: 0, latency_ms: { p50: 1, p95: 2, p99: 3 } }] }
  const ok = buildSummary(pipeline, write, { scale: 'medium', sha: 'a'.repeat(40) })
  assert.equal(ok.summary.verdict, 'PASS')
  assert.deepEqual(ok.failures, [])
  const text = JSON.stringify(ok.summary)
  for (const leak of ['SECRET-CPU', '/home/runner', 'abc', '/api/auth/login', '/etc/passwd', 'secret']) assert.ok(!text.includes(leak), `leaked ${leak}`)
  assert.equal(ok.summary.bench_write.operations[0].name, '?')
  const clone = o => JSON.parse(JSON.stringify(o))
  const v = clone(pipeline); v.steps.explain_audit.violations = 2
  assert.deepEqual(buildSummary(v, write).failures, ['explain_audit_violations'])
  const r = clone(pipeline); r.steps.bench_api.totals.errors = 1
  assert.deepEqual(buildSummary(r, write).failures, ['bench_read_errors'])
  const w = clone(write); w.totals.errors = 1
  assert.deepEqual(buildSummary(pipeline, w).failures, ['bench_write_errors'])
  const wi = clone(write); wi.integrity.ok = false
  assert.deepEqual(buildSummary(pipeline, wi).failures, ['bench_write_integrity'])
  const f = clone(pipeline); f.ok = false
  assert.ok(buildSummary(f, write).failures.includes('pipeline_step_failed'))
  assert.ok(buildSummary(null, null).failures.includes('pipeline_report_missing'))
  assert.ok(buildSummary(pipeline, null).failures.includes('bench_write_missing'))
  assert.equal(buildSummary(pipeline, write, { sha: 'not-a-sha', scale: 'x' }).summary.commit, null)
})

test('docs/implementation/ci.md has a nightly capacity section stating hosted numbers are trend indicators only', () => {
  const i = ciDoc.indexOf('夜间容量')
  assert.ok(i >= 0, 'section missing')
  const section = ciDoc.slice(i)
  assert.match(section, /趋势指示/)
  assert.match(section, /nightly-capacity\.yml/)
  assert.match(section, /尚未在 GitHub 上执行/)
})
