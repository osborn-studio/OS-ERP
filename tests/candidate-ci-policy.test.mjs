/**
 * ============================================================================
 * 文件标识：tests/candidate-ci-policy.test.mjs ｜ CI candidate job 的静态守卫（AD10）
 * ============================================================================
 * 便宜、诚实的文本断言：证明 .github/workflows/ci.yml 的 candidate job 仅由 workflow_dispatch 与 v* 标签推送触发
 * （不由 PR / main 推送触发）、固定 Actions SHA、超时 ≤ 90 分钟、有互斥并发组、权限只读、只上传白名单文件（14 天）、
 * 不含任何发布 / 打标签 / 回推步骤，且 README 声明托管候选未签名。
 * 它们不证明 job 在 GitHub 上能跑通 —— 那是托管 runner 上 candidate job 本身的事。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const workflow = read('.github/workflows/ci.yml')
const m = workflow.match(/^  candidate:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m)
const job = m ? m[0] : null
const code = job?.replace(/^\s*#.*$/gm, '') ?? ''

test('candidate job runs only on workflow_dispatch or v* tag pushes, never on PR or main push', () => {
  assert.ok(job, 'jobs.candidate must exist')
  const cond = code.match(/^\s+if:\s*(.+)$/m)?.[1] ?? ''
  assert.equal(cond, "github.event_name == 'workflow_dispatch' || (github.event_name == 'push' && startsWith(github.ref, 'refs/tags/v'))")
  assert.doesNotMatch(cond, /pull_request|refs\/heads|main/)
  const on = workflow.slice(workflow.indexOf('\non:'), workflow.indexOf('\npermissions:'))
  assert.match(on, /tags:\s*\['v\*'\]/)
  assert.match(on, /branches:\s*\[main\]/)
  assert.match(on, /^\s+workflow_dispatch:/m)
  assert.doesNotMatch(on, /pull_request_target/)
})

test('candidate job is time-boxed (<= 90 min), read-only, and serialised by its own concurrency group', () => {
  assert.ok(Number(code.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]) <= 90)
  const perms = code.match(/^    permissions:\n((?:      .+\n)+)/m)?.[1] ?? ''
  assert.match(perms, /contents:\s*read/)
  assert.match(perms, /actions:\s*read/)
  assert.doesNotMatch(perms, /write/)
  assert.match(code, /concurrency:\s*\n\s+group:\s*candidate-\$\{\{ github\.repository \}\}\s*\n\s+cancel-in-progress:\s*false/)
})

test('workflow-level concurrency never cancels dispatch or tag runs', () => {
  const top = workflow.match(/^concurrency:\n((?:  .+\n)+)/m)?.[1] ?? ''
  assert.match(top, /group:.*github\.event_name/)
  assert.match(top, /cancel-in-progress:\s*\$\{\{ github\.event_name != 'workflow_dispatch' && github\.ref_type != 'tag' \}\}/)
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

test('AE10: checks, docker, browser and regression skip tag pushes; the candidate job condition is unchanged', () => {
  for (const name of ['checks', 'docker', 'browser', 'regression']) {
    const body = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm'))?.[0]
    assert.ok(body, `${name} job exists`)
    const cond = body.replace(/^\s*#.*$/gm, '').match(/^    if:\s*(.+?)(?:\s+#.*)?$/m)?.[1]
    assert.equal(cond, "${{ !startsWith(github.ref, 'refs/tags/') }}", `${name} must skip refs/tags/* pushes`)
    assert.doesNotMatch(cond, /pull_request|refs\/heads|main/, `${name} keeps running for PR and main`)
  }
  // PR 的 github.ref 是 refs/pull/N/merge、main 推送是 refs/heads/main，都不以 refs/tags/ 开头，分支保护所依赖的检查不受影响
  assert.match(workflow, /^    if: github\.event_name == 'workflow_dispatch' \|\| \(github\.event_name == 'push' && startsWith\(github\.ref, 'refs\/tags\/v'\)\)$/m)
})

test('AE10: no job in ci.yml has a publish, release, tag or push-back step', () => {
  const all = workflow.replace(/^\s*#.*$/gm, '')
  assert.doesNotMatch(all, /gh release|softprops|action-gh-release|create-release|npm publish|docker push|docker login/i)
  assert.doesNotMatch(all, /git (push|tag|commit)\b/)
  assert.doesNotMatch(all, /contents:\s*write|packages:\s*write|id-token/)
})

test('AE10: README documents the artifact, ingest, commit maintainer flow and the self-referential CI record', () => {
  const readme = read('docs/release/README.md')
  assert.match(readme, /evidence-log-ingest\.mjs --line/)
  assert.match(readme, /hosted-ci-self/)
  assert.match(readme, /refs\/tags\//)
})
