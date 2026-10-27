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
  assert.match(code, /env -u GML_RUNTIME_MODE -u GML_DB node scripts\/release-candidate\.mjs --skip-focused --run-guards --ci-run=auto --output="\$CAND_OUT"\n/)
  assert.match(code, /CAND_OUT=\$RUNNER_TEMP\//)
  assert.match(code, /CAND_LOG=\$RUNNER_TEMP\//)
  assert.match(code, /verify-release\.mjs --evidence="[^"]+" --artifact="\$zip" --log="\$CAND_LOG"/)
  assert.ok(code.indexOf('release-candidate.mjs') < code.indexOf('verify-release.mjs'))
  assert.doesNotMatch(code, /GML_RELEASE_SIGN_KEY|secrets\./, 'hosted CI must not hold the signing key or secrets')
  // AF7 adds the SBOM-diff step as the second (and only other) holder of the read-only token
  assert.ok((code.match(/GH_TOKEN/g) ?? []).length === 2, 'the token is passed to exactly two steps (build + SBOM diff)')
})

test('candidate job uploads only the whitelisted files with 14-day retention', () => {
  const ups = code.split(/^\s+(?:- )?uses: actions\/upload-artifact@/m).slice(1)
  assert.equal(ups.length, 1)
  const paths = ups[0].match(/path: \|\n((?:\s+\$\{\{.*\n)+)/)?.[1].trim().split('\n').map((s) => s.trim()) ?? []
  assert.deepEqual(paths, [
    '${{ runner.temp }}/candidate-upload/RC-*.zip',
    '${{ runner.temp }}/candidate-upload/EVIDENCE.json',
    '${{ runner.temp }}/candidate-upload/evidence-log-line.jsonl',
    '${{ runner.temp }}/candidate-upload/sbom.cdx.json',
    '${{ runner.temp }}/candidate-upload/sbom-diff.json',
    '${{ runner.temp }}/candidate-upload/sbom-diff.txt',
    '${{ runner.temp }}/candidate-upload/audit-signatures.txt'
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

// AG1: dry-run input
const dispatchBlock = stripComments(workflow.slice(workflow.indexOf('  workflow_dispatch:'), workflow.indexOf('\npermissions:'))).replace(/\n\s*\n/g, '\n')
const buildStep = code.split(/^      - /m).find((x) => /^name: Build candidate/.test(x)) ?? ''
const [normalBranch, dryBranch] = (() => {
  const m = buildStep.match(/if \[ "\$\{DRY_RUN:-false\}" = "true" \]; then\n([\s\S]*?)\n\s+else\n([\s\S]*?)\n\s+fi/)
  return m ? [m[2], m[1]] : ['', '']
})()

test('AG1: workflow_dispatch has a dry_run choice input (false/true), default false, and no other input', () => {
  assert.match(dispatchBlock, /^    inputs:\n      dry_run:\n/m)
  assert.match(dispatchBlock, /type: choice/)
  assert.match(dispatchBlock, /default: 'false'/)
  assert.match(dispatchBlock, /options:\n\s+- 'false'\n\s+- 'true'/)
  assert.deepEqual([...dispatchBlock.matchAll(/^      (\w+):/gm)].map((x) => x[1]), ['dry_run'])
  // the push trigger stays tag-only, so a tag push can never be a dry run (input absent => treated as false)
  assert.match(workflow, /DRY_RUN: \$\{\{ inputs\.dry_run \}\}/)
})

test('AG1: the dry-run branch skips the focused suite, runs guards, and never touches the evidence log', () => {
  assert.ok(buildStep, 'build step exists')
  assert.ok(dryBranch && normalBranch, 'build step branches on DRY_RUN')
  assert.match(dryBranch, /release-candidate\.mjs --skip-focused --run-guards --ci-run=auto --output="\$CAND_OUT"/)
  assert.doesNotMatch(dryBranch, /--run-tests|--log|CAND_LOG|EVIDENCE-LOG/)
  assert.match(normalBranch, /--run-tests --ci-run=auto --log="\$CAND_LOG"/)
  assert.doesNotMatch(normalBranch, /--skip-focused/)
  // DRY_RUN is only ever compared against the literal "true"; the input is never interpolated into shell text
  for (const step of code.split(/^      - /m)) assert.doesNotMatch(step.split(/^\s+run:/m).slice(1).join(''), /\$\{\{ inputs\./, 'no run script interpolates an input')
  assert.equal([...code.matchAll(/\$\{\{ inputs\.dry_run/g)].length, 2, 'only the job-level DRY_RUN env and the artifact name read the input')
})

test('AG1: dry-run self-verify omits --log and the log-line upload file; normal self-verify keeps both', () => {
  const verifyStep = code.split(/^      - /m).find((x) => /^name: Self-verify the candidate/.test(x)) ?? ''
  const m = verifyStep.match(/if \[ "\$\{DRY_RUN:-false\}" = "true" \]; then\n([\s\S]*?)\n\s+else\n([\s\S]*?)\n\s+fi/)
  assert.ok(m, 'verify step branches on DRY_RUN')
  assert.doesNotMatch(m[1], /--log|CAND_LOG|evidence-log-line/)
  assert.match(m[1], /verify-release\.mjs --evidence="\$CAND_OUT\/\$name\.evidence\/EVIDENCE\.json" --artifact="\$zip"/)
  assert.match(m[2], /--log="\$CAND_LOG"/)
  assert.match(m[2], /evidence-log-line\.jsonl/)
  assert.match(verifyStep, /verify-release\.mjs --evidence="\$CAND_OUT\/\$name\.evidence\/EVIDENCE\.json" --artifact="\$zip" --log="\$CAND_LOG"/)
})

test('AG1: the dry-run upload uses a distinct -dry-run artifact name, the normal name is unchanged, and the SBOM diff ignores dry-run artifacts', () => {
  const ups = code.split(/^\s+(?:- )?uses: actions\/upload-artifact@/m).slice(1)
  assert.equal(ups.length, 1)
  assert.match(ups[0], /name: os-erp-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\$\{\{ inputs\.dry_run == 'true' && '-dry-run' \|\| '' \}\}\n/)
  // the normal name (dry_run false / tag push) is exactly the pre-AG1 name
  assert.match(ups[0], /os-erp-candidate-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}\$\{\{/)
  const diffStep = code.split(/^      - /m).find((x) => /^name: SBOM diff/.test(x)) ?? ''
  assert.match(diffStep, /"dry_run": true/, 'previous candidates whose evidence says dry_run are skipped')
  assert.match(diffStep, /-dry-run/)
})

test('AG1: dry-run evidence is never log-eligible in the scripts either (static)', () => {
  const rc = read('scripts/release-candidate.mjs')
  const vr = read('scripts/verify-release.mjs')
  assert.match(rc, /--skip-focused is only allowed when GITHUB_ACTIONS=true/)
  assert.match(rc, /dry run[^\n]*evidence log|evidence log[^\n]*dry run/i)
  assert.match(vr, /DRY RUN, NOT A CANDIDATE/)
  assert.match(vr, /never log-eligible/)
})

test('AG1: README documents the first-run steps (dry run first, then full) and the dry-run semantics', () => {
  const readme = read('docs/release/README.md')
  assert.match(readme, /首跑步骤/)
  assert.match(readme, /dry_run=true/)
  assert.match(readme, /gh workflow run release-candidate\.yml --ref main -f dry_run=true/)
  assert.match(readme, /gh workflow run release-candidate\.yml --ref main -f dry_run=false/)
  assert.ok(readme.indexOf('-f dry_run=true') < readme.indexOf('-f dry_run=false'), 'dry run comes first')
  assert.match(readme, /skipped-dry-run/)
  assert.match(readme, /-dry-run/)
  assert.match(readme, /--skip-focused/)
})
