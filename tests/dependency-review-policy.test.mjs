/**
 * ============================================================================
 * 文件标识：tests/dependency-review-policy.test.mjs ｜ ci.yml 的 dependency-review job 静态守卫（roadmap-v10 AE7）
 * ============================================================================
 * 便宜、诚实的文本断言：job 对 ci.yml 的每个事件都运行（含 pull_request，不带 job 级 if，满足 AF1 的 required-check 语义）、Actions 按 SHA 固定、不引用 secrets、权限只读、
 * 步骤顺序（锁文件 registry 守卫 → npm ci --ignore-scripts → 安装树核对 → npm audit signatures → 审计）、
 * 两种审计模式都运行、摘要写到 $RUNNER_TEMP、只上传白名单内的两个 JSON、保留 30 天。不证明它在 GitHub 上能跑通
 * （它尚未运行过，AH7）。不联网。
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

test('dependency-review exists, runs on every ci.yml event without a conditional skip, independent and time-boxed', () => {
  assert.ok(job, 'jobs.dependency-review must exist')
  assert.doesNotMatch(code.split('steps:')[0], /^\s+if:/m, 'no job-level if: a conditional skip breaks required-check semantics (AF1)')
  assert.doesNotMatch(code, /^\s+needs:/m)
  assert.match(code, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.ok(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]) <= 15)
})

test('it is the last job in the file (appended as a whole block)', () => {
  const names = [...workflow.matchAll(/^  ([a-z][a-z0-9-]*):\n(?=    )/gm)].map((x) => x[1])
  assert.equal(names[names.length - 1], 'dependency-review')
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

test('AH7 gate steps exist, in order, before the audit step; install keeps scripts disabled', () => {
  const idx = (re) => { const m = code.match(re); assert.ok(m, String(re)); return m.index }
  const guard = idx(/run:\s*node scripts\/check-lock-registry\.mjs\s*$/m)
  const install = idx(/run:\s*npm ci --ignore-scripts --no-audit --no-fund\s*$/m)
  const installed = idx(/run:\s*node scripts\/check-install-registry\.mjs\s*$/m)
  const sigs = idx(/run:\s*npm audit signatures --registry=https:\/\/registry\.npmjs\.org\s*$/m)
  const audit = idx(/check-audit-allowlist\.mjs --summary/)
  assert.ok(guard < install && install < installed && installed < sigs && sigs < audit)
  assert.doesNotMatch(code, /run:\s*npm (ci|install|i)\b(?![^\n]*--ignore-scripts)/, 'every install must pass --ignore-scripts')
  assert.doesNotMatch(code, /check-lock-registry\.mjs[^\n]*--allow/, 'CI must not widen the registry allowlist')
  assert.doesNotMatch(code, /continue-on-error/)
})

test('the audit step still runs (and the job still fails) when an earlier gate step failed, but not when cancelled', () => {
  const step = code.match(/- name: Audit runtime and dev dependencies[^\n]*\n\s+if:\s*(\$\{\{ !cancelled\(\) \}\})/)
  assert.ok(step, 'audit step must carry if: ${{ !cancelled() }}')
})

test('only the dependency-review job was touched for AH7: other jobs keep their triggers and there is no pull_request_target', () => {
  assert.match(workflow, /^on:\n  push:\n    branches: \[main\]\n  pull_request:\n  workflow_dispatch:/m)
})
