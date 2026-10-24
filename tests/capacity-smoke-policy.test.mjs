/**
 * ============================================================================
 * 文件标识：tests/capacity-smoke-policy.test.mjs ｜ ci.yml 的 capacity-smoke 过渡 job 静态守卫（roadmap-v9 AD8）
 * ============================================================================
 * 便宜、诚实的文本断言：job 仅在 workflow_dispatch 下运行、medium 规模 + 20 分钟生成预算、作业上限 30 分钟、
 * Actions 按 SHA 固定、只上传白名单摘要、不自动触发、不改权限。不证明它在 GitHub 上能跑通（它尚未被触发）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const m = workflow.match(/^  capacity-smoke:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m)
const job = m ? m[0] : ''
const code = job.replace(/^\s*#.*$/gm, '')

test('capacity-smoke exists, is dispatch-only, independent of other jobs, time-boxed to 30 minutes', () => {
  assert.ok(job, 'jobs.capacity-smoke must exist')
  assert.match(code, /^\s+if:\s*github\.event_name == 'workflow_dispatch'\s*$/m)
  assert.doesNotMatch(code, /^\s+needs:/m)
  assert.match(code, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.equal(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]), 30)
})

test('capacity-smoke runs the medium profile with a 20 minute generation budget', () => {
  assert.match(code, /--skus 20000 --docs 30000 --txns 150000/)
  assert.match(code, /--time-budget 20\b/)
  assert.doesNotMatch(code, /large-ci/)
})

test('capacity-smoke actions are SHA-pinned and only the allowlisted summary is uploaded', () => {
  for (const u of job.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)) {
    assert.match(u[1], /@[0-9a-f]{40}$/, u[1])
    assert.match(u[2], /#\s*v\d/)
  }
  const up = job.match(/upload-artifact[\s\S]*?path:\s*(.+)/)
  assert.match(up?.[1] ?? '', /capacity-summary\/capacity-summary\.json\s*$/)
  assert.doesNotMatch(code, /path:\s*\|/)
  assert.match(code, /capacity-summary\.mjs --pipeline/)
})

test('capacity paths are exported from a step, never from job-level env (runner context is unavailable there)', () => {
  assert.doesNotMatch(code, /^    env:/m)
  assert.doesNotMatch(code, /runner\.temp\s*\}\}\/capacity-(run|reports)/)
  assert.match(code, /CAP_RUN=\$RUNNER_TEMP\/capacity-run/)
})

test('workflow permissions stay read-only and no trigger was added', () => {
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m)
  assert.doesNotMatch(workflow, /pull_request_target|schedule:/)
})
