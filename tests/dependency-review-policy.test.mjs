/**
 * ============================================================================
 * 文件标识：tests/dependency-review-policy.test.mjs ｜ ci.yml 的 dependency-review job 静态守卫（roadmap-v10 AE7）
 * ============================================================================
 * 便宜、诚实的文本断言：job 仅 workflow_dispatch 触发、Actions 按 SHA 固定、不引用 secrets、权限只读、
 * 两种审计模式都运行、摘要写到 $RUNNER_TEMP、只上传白名单内的两个 JSON、保留 30 天。不证明它在 GitHub 上能跑通
 * （它尚未被触发）。不联网。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const m = workflow.match(/^  dependency-review:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m)
const job = m ? m[0] : ''
const code = job.replace(/^\s*#.*$/gm, '')

test('dependency-review exists, is dispatch-only, independent and time-boxed', () => {
  assert.ok(job, 'jobs.dependency-review must exist')
  assert.match(code, /^\s+if:\s*github\.event_name == 'workflow_dispatch'\s*$/m)
  assert.doesNotMatch(code, /^\s+needs:/m)
  assert.match(code, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.ok(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]) <= 15)
})

test('it is a whole top-level block (later jobs are appended after it, never nested in it)', () => {
  // AH1: new jobs (slow-tests, ...) are appended at the END of ci.yml, so dependency-review is no longer required to be last.
  const names = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n(?=    )/gm)].map((x) => x[1])
  assert.ok(names.includes('dependency-review'))
  assert.doesNotMatch(job, /^  (?!dependency-review:)[a-z][a-z0-9-]*:\n/m, 'the job block must not swallow a following job')
})

test('actions are SHA-pinned with a version comment', () => {
  const uses = [...job.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)]
  assert.ok(uses.length >= 3)
  for (const u of uses) {
    assert.match(u[1], /@[0-9a-f]{40}$/, u[1])
    assert.match(u[2], /#\s*v\d/)
  }
})

test('no secrets, no tokens, no job-level permission widening, no checkout credentials', () => {
  assert.doesNotMatch(code, /secrets\./)
  assert.doesNotMatch(code, /github\.token|GH_TOKEN|GITHUB_TOKEN/)
  assert.doesNotMatch(code, /^\s+permissions:/m)
  assert.match(code, /persist-credentials:\s*false/)
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m)
  assert.doesNotMatch(workflow, /pull_request_target|schedule:/)
})

test('both audit modes run and write JSON summaries to RUNNER_TEMP, not the checkout', () => {
  assert.match(code, /check-audit-allowlist\.mjs --summary "\$out\/audit-runtime\.json"/)
  assert.match(code, /check-audit-allowlist\.mjs --include-dev --summary "\$out\/audit-dev\.json"/)
  assert.match(code, /out="\$RUNNER_TEMP\/dependency-review"/)
  assert.doesNotMatch(code, /runner\.temp\s*\}\}\/dependency-review"?\s*$/m, 'upload paths must name files, not the directory')
  assert.doesNotMatch(code, /^    env:/m)
})

test('both modes run even if the first fails, and the step still fails overall', () => {
  assert.match(code, /rt=\$\?/)
  assert.match(code, /dev=\$\?/)
  assert.match(code, /\[ "\$rt" -eq 0 \] && \[ "\$dev" -eq 0 \]/)
})

test('one artifact, whitelisted to the two summaries, uploaded even on failure, kept 30 days', () => {
  const ups = [...job.matchAll(/upload-artifact@/g)]
  assert.equal(ups.length, 1)
  const block = job.slice(job.indexOf('upload-artifact@'))
  assert.match(block, /if:\s*always\(\)/)
  const paths = block.match(/path:\s*\|\n((?:\s+\$\{\{.*\n?)+)/)?.[1].trim().split('\n').map((l) => l.trim()) ?? []
  assert.deepEqual(paths, [
    '${{ runner.temp }}/dependency-review/audit-runtime.json',
    '${{ runner.temp }}/dependency-review/audit-dev.json'
  ])
  assert.match(block, /retention-days:\s*30\s*$/m)
  assert.match(block, /if-no-files-found:\s*error/)
})
