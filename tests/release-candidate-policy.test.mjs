/**
 * ============================================================================
 * 文件标识：tests/release-candidate-policy.test.mjs ｜ 发行候选工作流的静态守卫（AD10，AF1 起独立成文件）
 * ============================================================================
 * 便宜、诚实的文本断言：证明 .github/workflows/release-candidate.yml 仅由 workflow_dispatch 与 v* 标签推送触发
 * （不由 PR / 分支推送触发）、固定 Actions SHA、超时 ≤ 90 分钟、有互斥并发组、权限只读、只上传白名单文件（14 天）、
 * 不含任何发布 / 打标签 / 回推步骤，且 ci.yml 不含任何标签逻辑、不含 candidate job（AF1：避免被跳过的 job 在同一 SHA 上
 * 冒充通过状态）；README 声明托管候选未签名。
 * 它们不证明工作流在 GitHub 上能跑通 —— 那是托管 runner 上第一次运行的事。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const ci = read('.github/workflows/ci.yml')
const workflow = read('.github/workflows/release-candidate.yml')
const m = workflow.match(/^  candidate:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m)
const job = m ? m[0] : null
const code = job?.replace(/^\s*#.*$/gm, '') ?? ''
const stripComments = (t) => t.replace(/^\s*#.*$/gm, '').replace(/\s+#.*$/gm, '')

test('release-candidate.yml triggers only on v* tag pushes and workflow_dispatch', () => {
  assert.ok(job, 'jobs.candidate must exist')
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'))
  assert.match(on, /^  push:\n    tags: \['v\*'\]\n(?!    branches)/m)
  assert.match(on, /^  workflow_dispatch:/m)
  assert.doesNotMatch(on, /pull_request|schedule|branches|workflow_run|release:/)
  assert.deepEqual([...on.matchAll(/^  (\w+):/gm)].map((x) => x[1]).sort(), ['push', 'workflow_dispatch'])
  // the job itself carries no ref-based skip (a skipped job would be a passing status context)
  assert.doesNotMatch(code, /^\s+if:/m)
})

test('candidate job is time-boxed (<= 90 min), read-only, and serialised by its own concurrency group', () => {
  assert.ok(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]) <= 90)
  const perms = code.match(/^    permissions:\n((?:      .+\n)+)/m)?.[1] ?? ''
  assert.match(perms, /contents:\s*read/)
  assert.match(perms, /actions:\s*read/)
  assert.doesNotMatch(perms, /write/)
  assert.match(code, /concurrency:\s*\n\s+group:\s*candidate-\$\{\{ github\.repository \}\}\s*\n\s+cancel-in-progress:\s*false/)
})

test('workflow-level token is read-only and no job grants write scopes', () => {
  const top = workflow.match(/^permissions:\n((?:  .+\n)+)/m)?.[1] ?? ''
  assert.match(top, /contents:\s*read/)
  assert.doesNotMatch(stripComments(workflow), /:\s*write\b|id-token/)
})

test('candidate job pins every action by SHA and does not persist checkout credentials', () => {
  const uses = [...code.matchAll(/^\s+(?:- )?uses:\s*(\S+)/gm)].map((x) => x[1])
  assert.ok(uses.length >= 4)
  for (const u of uses) assert.match(u, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `${u} must be pinned to a full commit SHA`)
  assert.match(code, /persist-credentials:\s*false/)
})

test('candidate job builds with the documented flags, writes outside the checkout, and verifies the result', () => {
  assert.match(code, /env -u GML_RUNTIME_MODE -u GML_DB node scripts\/release-candidate\.mjs --run-tests --ci-run=auto --log="\$CAND_LOG" --output="\$CAND_OUT"/)
  assert.match(code, /CAND_OUT=\$RUNNER_TEMP\//)
  assert.match(code, /CAND_LOG=\$RUNNER_TEMP\//)
  assert.match(code, /verify-release\.mjs --evidence="[^"]+" --artifact="\$zip" --log="\$CAND_LOG"/)
  assert.ok(code.indexOf('release-candidate.mjs') < code.indexOf('verify-release.mjs'))
  assert.doesNotMatch(code, /GML_RELEASE_SIGN_KEY|secrets\./, 'hosted CI must not hold the signing key or secrets')
  assert.ok((code.match(/GH_TOKEN/g) ?? []).length === 1, 'the token is passed to exactly one step')
})

test('candidate job uploads only the whitelisted files with 14-day retention', () => {
  const ups = code.split(/^\s+(?:- )?uses: actions\/upload-artifact@/m).slice(1)
  assert.equal(ups.length, 1)
  const paths = ups[0].match(/path: \|\n((?:\s+\$\{\{.*\n)+)/)?.[1].trim().split('\n').map((s) => s.trim()) ?? []
  assert.deepEqual(paths, [
    '${{ runner.temp }}/candidate-upload/RC-*.zip',
    '${{ runner.temp }}/candidate-upload/EVIDENCE.json',
    '${{ runner.temp }}/candidate-upload/evidence-log-line.jsonl'
  ])
  assert.match(ups[0], /retention-days:\s*14\b/)
  assert.match(ups[0], /if-no-files-found:\s*error/)
})

test('candidate job never publishes: no release, tag, push, commit, or deploy step', () => {
  assert.doesNotMatch(code, /gh release|gh api|softprops|action-gh-release|create-release|npm publish|docker push|docker login/i)
  assert.doesNotMatch(code, /git (push|tag|commit|config|remote)/)
  assert.doesNotMatch(code, /contents:\s*write|packages:\s*write|id-token/)
  assert.doesNotMatch(code, /^\s+- (name|run):.*\bdeploy/im)
})

test('docs/release/README.md states hosted candidates are unsigned and need a key-holder re-sign', () => {
  const readme = read('docs/release/README.md')
  assert.match(readme, /托管候选未签名，正式发行须持钥者在受控机器重签/)
  assert.match(readme, /workflow_dispatch/)
  assert.match(readme, /14 days|14 天/)
})

test('AF1: ci.yml has no tag trigger, no ref-based job skips and no candidate job', () => {
  const code = stripComments(ci)
  const on = ci.slice(ci.indexOf('\non:'), ci.indexOf('\npermissions:'))
  assert.doesNotMatch(on, /tags:/)
  assert.match(on, /branches:\s*\[main\]/)
  assert.match(on, /^  pull_request:/m)
  assert.match(on, /^  workflow_dispatch:/m)
  assert.doesNotMatch(code, /refs\/tags|startsWith\(github\.ref|ref_type|v\*/)
  assert.doesNotMatch(code, /^  candidate:/m)
  assert.doesNotMatch(code, /release-candidate\.mjs|candidate-upload|CAND_OUT/)
  // required-check semantics: no job in ci.yml has a ref/event-conditional skip except the explicit manual-dispatch-only jobs
  for (const [, name, body] of ci.matchAll(/^  ([\w-]+):\n([\s\S]*?)(?=^  \S|(?![\s\S]))/gm)) {
    if (!/^    runs-on:/m.test(body)) continue
    const cond = stripComments(body).match(/^    if:\s*(.+)$/m)?.[1]
    if (cond) assert.equal(cond, "github.event_name == 'workflow_dispatch'", `${name}: only dispatch-only jobs may carry a job-level if`)
  }
})

test('AF1: ci.yml concurrency cancels only superseded runs and never a manual dispatch', () => {
  const top = ci.match(/^concurrency:\n((?:  .+\n)+)/m)?.[1] ?? ''
  assert.match(top, /group:.*github\.ref/)
  assert.match(top, /cancel-in-progress:\s*\$\{\{ github\.event_name != 'workflow_dispatch' \}\}/)
  assert.doesNotMatch(top, /ref_type|tag/)
})

test('AF1: the candidate job lives only in release-candidate.yml', () => {
  assert.equal([...ci.matchAll(/^  candidate:/gm)].length, 0)
  assert.equal([...workflow.matchAll(/^  candidate:/gm)].length, 1)
})

test('no workflow job has a publish, release, tag or push-back step (ci.yml and release-candidate.yml)', () => {
  for (const text of [ci, workflow]) {
    const all = stripComments(text)
    assert.doesNotMatch(all, /gh release|softprops|action-gh-release|create-release|npm publish|docker push|docker login/i)
    assert.doesNotMatch(all, /git (push|tag|commit)\b/)
    assert.doesNotMatch(all, /contents:\s*write|packages:\s*write|id-token/)
  }
})

test('AE10/AF1: README documents the artifact, ingest, commit maintainer flow, the self-referential CI record and the workflow split', () => {
  const readme = read('docs/release/README.md')
  assert.match(readme, /release-candidate\.yml/)
  assert.match(readme, /evidence-log-ingest\.mjs --line/)
  assert.match(readme, /hosted-ci-self/)
})
