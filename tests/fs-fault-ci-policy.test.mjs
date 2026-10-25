/**
 * ============================================================================
 * 文件标识：tests/fs-fault-ci-policy.test.mjs ｜ ci.yml 的 fs-fault job 静态守卫（roadmap-v13 AH6）
 * ============================================================================
 * 便宜、诚实的文本断言：job 在 ubuntu / Node 22 上跑两个测试文件、用 GML_FS_FAULT_REPORT 写报告并上传、Actions 按 SHA 固定、
 * 作业上限不超 15 分钟、位于 capacity-smoke 之后的独立 job、不加触发器、不改权限、无发布/推送步骤。不证明它在 GitHub 上跑通（尚未被触发）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const workflow = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8')
const jobs = [...workflow.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  [\w-]+:\n|(?![\s\S]))/gm)].filter((m) => /^    runs-on:/m.test(m[2]))
const job = jobs.find((m) => m[1] === 'fs-fault')?.[0] ?? ''
const code = job.replace(/^\s*#.*$/gm, '')

test('fs-fault exists once after capacity-smoke as a whole job block', () => {
  assert.ok(job, 'jobs.fs-fault must exist')
  const names = jobs.map((m) => m[1])
  assert.ok(names.includes('capacity-smoke'))
  assert.ok(names.indexOf('fs-fault') > names.indexOf('capacity-smoke'))
  assert.equal(names.filter((name) => name === 'fs-fault').length, 1)
})

test('fs-fault runs on ubuntu with Node 22, locked install, time-boxed, no job-level if / needs', () => {
  assert.match(code, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.match(code, /node-version:\s*22\s*$/m)
  assert.match(code, /npm ci --ignore-scripts/)
  assert.doesNotMatch(code, /^    if:/m)
  assert.doesNotMatch(code, /^    needs:/m)
  const minutes = Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1])
  assert.ok(minutes >= 10 && minutes <= 15, `timeout-minutes ${minutes} should stay near the ~10 minute budget`)
})

test('fs-fault runs both test files serially with GML_FS_FAULT_REPORT and uploads fs-fault-report.json', () => {
  assert.match(code, /node --test --test-concurrency=1 tests\/fs-fault\.test\.mjs tests\/db-backup\.test\.mjs/)
  assert.match(code, /GML_FS_FAULT_REPORT:\s*\$\{\{ runner\.temp \}\}\/fs-fault\/fs-fault-report\.json/)
  assert.doesNotMatch(code, /^    env:/m, 'runner context is unavailable in job-level env; set it on the step')
  const up = code.match(/upload-artifact[\s\S]*?path:\s*(.+)/)
  assert.match(up?.[1] ?? '', /fs-fault\/fs-fault-report\.json\s*$/)
  assert.match(code, /if-no-files-found:\s*error/)
})

test('fs-fault actions are SHA-pinned; no secrets, publish or push step; triggers and permissions unchanged', () => {
  for (const u of job.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)) {
    assert.match(u[1], /@[0-9a-f]{40}$/, u[1])
    assert.match(u[2], /#\s*v\d/)
  }
  assert.doesNotMatch(code, /secrets\.|git push|gh release|npm publish/)
  assert.match(workflow, /^permissions:\s*\n\s+contents:\s*read\s*$/m)
  assert.doesNotMatch(workflow, /pull_request_target|schedule:/)
})
