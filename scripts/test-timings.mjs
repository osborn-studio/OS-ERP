#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-timings.mjs ｜ 测试耗时统计：逐文件运行 node:test，从 TAP 统计文件/用例耗时并写 JSON（AH1）
 * ============================================================================
 * 【职责】逐个测试文件起一个 `node --test --test-reporter=tap` 子进程（与门禁同样的串行、同样的环境变量），
 *   记录每个文件的墙钟耗时、通过/失败/跳过计数与最慢的 5 个顶层用例，写入
 *   `docs/implementation/test-timings.json`（CI 把它作为 artifact 上传）；超过阈值（默认 60 s）的文件列入 `slow_files`。
 *
 * 【用法】
 *   node scripts/test-timings.mjs --run [--output <json>] [--threshold-s 60] [--list] [files...]
 *       不给 files 时跑 `tests/*.test.mjs` 与 `tests/slow/*.test.mjs`。任何文件失败 ⇒ 退出 1（耗时仍照写）。
 *   node scripts/test-timings.mjs --check [--input <json>]
 *       只读检查：JSON 里 `tests/*.test.mjs`（非 slow）没有一个超过阈值，且 slow 文件与目录一致。不跑测试。
 *
 * 【设计要点】
 *   · 隔离：每个子进程的 env 只带 PATH/HOME 与 GML_RUNTIME_MODE=test、GML_DB=''、随机 GML_JWT_SECRET；
 *     不读不写仓库 data/，不占固定端口（各测试自己用随机 loopback 端口）。
 *   · 本脚本是度量工具，不是验收证据：耗时受机器负载影响，托管 runner 与目标主机 dmserver 的数字不可互换。
 *   · `parseTap` 是纯函数（有单测），只认顶层（零缩进）的 `ok/not ok` 行，用 `duration_ms` 取耗时。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_THRESHOLD_S = 60
export const DEFAULT_OUTPUT = 'docs/implementation/test-timings.json'
/** 有意留在 tests/ 的超阈值文件（必须写理由）。--check 不对它们报错；--run 把它们原样写进 JSON 的 exempt。 */
export const EXEMPT = {
  'tests/fs-fault.test.mjs': '62 s on the macOS reference run, borderline; roadmap-v13 AH6 gives it its own fs-fault CI job at this exact path, so it is not moved'
}

/** 解析 TAP 文本：返回顶层用例 [{ name, ok, skipped, todo, duration_ms }] 与汇总计数（取自末尾 `# pass` 等行）。 */
export function parseTap(text) {
  const cases = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const m = /^(not ok|ok) \d+ - (.*)$/.exec(lines[i])
    if (!m) continue
    let name = m[2]
    const skipped = /# SKIP\b/i.test(name)
    const todo = /# TODO\b/i.test(name)
    name = name.replace(/\s+# (SKIP|TODO)\b.*$/i, '')
    let duration = null
    for (let j = i + 1; j < lines.length && j < i + 40; j++) {
      if (/^(not ok|ok) \d+ - /.test(lines[j]) || /^# Subtest/.test(lines[j])) break
      const d = /^  duration_ms: ([0-9.]+)/.exec(lines[j])
      if (d) { duration = Number(d[1]); break }
    }
    cases.push({ name, ok: m[1] === 'ok', skipped, todo, duration_ms: duration })
  }
  const counts = {}
  for (const k of ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const m = new RegExp(`^# ${k} (\\d+)\\s*$`, 'm').exec(text)
    counts[k] = m ? Number(m[1]) : 0
  }
  return { cases, counts }
}

/** 默认文件集：`tests/*.test.mjs`（门禁 checks job）+ `tests/slow/*.test.mjs`（slow-tests job）。 */
export function defaultFiles(root = ROOT) {
  const pick = (dir) => fs.existsSync(path.join(root, dir))
    ? fs.readdirSync(path.join(root, dir)).filter((f) => f.endsWith('.test.mjs')).sort().map((f) => `${dir}/${f}`)
    : []
  return [...pick('tests'), ...pick('tests/slow')]
}

export function runOne(rel, { root = ROOT, timeoutMs = 1500000 } = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    GML_RUNTIME_MODE: 'test', HOST: '127.0.0.1', GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex')
  }
  const t0 = Date.now()
  const r = spawnSync(process.execPath, ['--test', '--test-concurrency=1', '--test-reporter=tap', rel], {
    cwd: root, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe']
  })
  const duration_ms = Date.now() - t0
  const { cases, counts } = parseTap(r.stdout || '')
  const slowest = cases.filter((c) => c.duration_ms != null).sort((a, b) => b.duration_ms - a.duration_ms).slice(0, 5)
    .map((c) => ({ name: c.name, duration_ms: Math.round(c.duration_ms) }))
  return { file: rel, duration_ms, exit: r.status === null ? -1 : r.status, ...counts, slowest }
}

export function summarize(files, thresholdS) {
  const slow_files = files.filter((f) => f.duration_ms > thresholdS * 1000).map((f) => f.file).sort()
  const total_ms = files.reduce((s, f) => s + f.duration_ms, 0)
  return { threshold_s: thresholdS, total_ms, slow_files, exempt: EXEMPT }
}

/** --check：JSON 与目录一致。返回问题列表（空 = 通过）。 */
export function checkTimings(doc, root = ROOT) {
  const problems = []
  const thr = (doc.threshold_s ?? DEFAULT_THRESHOLD_S) * 1000
  const slowDir = fs.existsSync(path.join(root, 'tests/slow')) ? fs.readdirSync(path.join(root, 'tests/slow')).filter((f) => f.endsWith('.test.mjs')).map((f) => `tests/slow/${f}`) : []
  for (const f of doc.files || []) {
    const inSlow = f.file.startsWith('tests/slow/')
    if (!inSlow && f.duration_ms > thr && !(doc.exempt && doc.exempt[f.file])) problems.push(`${f.file} took ${Math.round(f.duration_ms / 1000)} s (> ${thr / 1000} s) but is not under tests/slow/`)
    if (!fs.existsSync(path.join(root, f.file))) problems.push(`${f.file} is listed in the timings but no longer exists`)
  }
  const listed = new Set((doc.files || []).map((f) => f.file))
  for (const s of slowDir) if (!listed.has(s)) problems.push(`${s} has no recorded timing`)
  return problems
}

function main() {
  const { values, positionals } = parseArgs({
    options: { run: { type: 'boolean' }, check: { type: 'boolean' }, list: { type: 'boolean' }, output: { type: 'string', default: DEFAULT_OUTPUT }, input: { type: 'string', default: DEFAULT_OUTPUT }, 'threshold-s': { type: 'string', default: String(DEFAULT_THRESHOLD_S) } },
    allowPositionals: true
  })
  const thresholdS = Number(values['threshold-s'])
  if (!Number.isFinite(thresholdS) || thresholdS <= 0) { console.error('--threshold-s must be a positive number'); process.exit(2) }
  if (values.check) {
    const doc = JSON.parse(fs.readFileSync(path.resolve(ROOT, values.input), 'utf8'))
    const problems = checkTimings(doc)
    for (const p of problems) console.error(`FAIL ${p}`)
    console.log(problems.length ? `${problems.length} problem(s)` : `ok: ${doc.files.length} files, ${doc.slow_files.length} slow`)
    process.exit(problems.length ? 1 : 0)
  }
  if (!values.run) { console.error('usage: test-timings.mjs --run [--output f] [files...] | --check [--input f]'); process.exit(2) }
  const files = positionals.length ? positionals : defaultFiles()
  if (values.list) { console.log(files.join('\n')); return }
  if (!files.length) { console.error('no test files'); process.exit(2) }
  const results = []
  for (const rel of files) {
    const r = runOne(rel)
    results.push(r)
    console.log(`${r.exit === 0 ? 'ok  ' : 'FAIL'} ${String(Math.round(r.duration_ms / 1000)).padStart(5)} s  ${rel}`)
  }
  const doc = { generated_at: new Date().toISOString(), node: process.version, platform: `${process.platform}-${process.arch}`, ...summarize(results, thresholdS), files: results }
  const out = path.resolve(ROOT, values.output)
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n')
  console.log(`wrote ${path.relative(ROOT, out)}: ${results.length} files, ${doc.slow_files.length} over ${thresholdS} s`)
  process.exit(results.every((r) => r.exit === 0) ? 0 : 1)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
