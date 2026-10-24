/**
 * ============================================================================
 * 文件标识：tests/candidate-supply-chain-policy.test.mjs ｜ 候选 job 供应链自检步骤的静态守卫（AF7）
 * ============================================================================
 * 文本断言：candidate job（优先读 release-candidate.yml，其次 ci.yml）含 `npm audit signatures` 步骤（npmjs 注册表、
 * 失败即失败、保留 npmmirror 覆盖范围说明）与“SBOM 对比上一次候选 artifact”步骤（只认 main / v* 的成功 run、不执行下载内容、
 * 首次候选写明、畸形不致命但留痕），两者的输出都在上传白名单里；README 有对应小节。不联网，不证明托管 runner 上能跑通。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const file = existsSync(path.join(ROOT, '.github/workflows/release-candidate.yml')) ? '.github/workflows/release-candidate.yml' : '.github/workflows/ci.yml'
const workflow = read(file)
const job = workflow.match(/^  candidate:\n([\s\S]*?)(?=^  \S|(?![\s\S]))/m)?.[0] ?? workflow
const stepsOf = (text) => text.split(/^      - /m).slice(1).map((x) => x.replace(/^\s*#.*$/gm, ''))
const steps = stepsOf(job)
const sig = steps.find((x) => /npm audit signatures/.test(x))
const diff = steps.find((x) => /^name: SBOM diff vs the previous candidate artifact/.test(x))
const order = (needle) => steps.findIndex((x) => x.includes(needle))

test('AF7: the candidate job has a failing npm audit signatures step pinned to the npmjs registry', () => {
  assert.ok(sig, 'signatures step exists')
  assert.match(sig, /npm audit signatures --registry=https:\/\/registry\.npmjs\.org(\s|$)/)
  assert.match(sig, /set -euo pipefail/, 'pipefail so a failed verification fails the step through tee')
  assert.doesNotMatch(sig, /continue-on-error|\|\|\s*true/)
  assert.match(sig, /audit-signatures\.txt/)
  assert.match(sig, /lockfile entries by registry host/, 'npmmirror coverage gap is recorded in the output')
  assert.match(job, /npmmirror[^\n]*no (audit|signature)|no audit\/signature endpoint/i, 'the npmmirror reason is documented next to the step')
  assert.doesNotMatch(sig, /continue-on-error/)
})

test('AF7: the SBOM diff step downloads only trusted previous runs, never executes artifact content, and is informational', () => {
  assert.ok(diff, 'SBOM diff step exists')
  assert.match(diff, /gh run list --repo "\$GITHUB_REPOSITORY" --workflow "\$CAND_WORKFLOW" --status success/)
  assert.match(diff, /headBranch == "main" or \(\.headBranch \| test\("\^v\[0-9\]"\)\)/, 'only main / v* runs')
  assert.match(diff, /databaseId != \(env\.GITHUB_RUN_ID \| tonumber\)/, 'never the current run')
  assert.match(diff, /gh run download "\$id" --repo "\$GITHUB_REPOSITORY" --pattern 'os-erp-candidate-\*'/)
  assert.match(diff, /case "\$id" in ''\|\*\[!0-9\]\*\) continue/, 'run ids are validated as numeric')
  assert.match(diff, /-type f/, 'regular files only (no symlinks)')
  assert.match(diff, /\^\[\^\/\]\+\/release\/sbom\\\.cdx\\\.json\$/, 'exactly one fixed zip entry is read')
  assert.match(diff, /head -c 33554433/, 'size is capped')
  assert.match(diff, /node scripts\/sbom-diff\.mjs "\$prev_sbom" "\$cur"/)
  assert.match(diff, /first candidate/)
  assert.match(diff, /GH_TOKEN: \$\{\{ github\.token \}\}/)
  // 下载的内容只当数据：不 source / eval / 解释执行，也不 unzip 整个包到可执行位置
  assert.doesNotMatch(diff, /\beval\b|\bsource\b|\bbash\s+"?\$|\bsh\s+"?\$|npm (run|exec|install)|node\s+"?\$(prev|f|d|z)/)
  assert.doesNotMatch(diff, /unzip (?!-Z1|-p)/, 'only listing (-Z1) and single-entry extraction to stdout (-p)')
  assert.doesNotMatch(diff, /secrets\./)
})

test('AF7: the two steps sit after the self-verify step and before the upload, and the upload carries their outputs', () => {
  const iVerify = order('Self-verify the candidate')
  const iSig = steps.indexOf(sig)
  const iDiff = steps.indexOf(diff)
  const iUpload = order('actions/upload-artifact@')
  assert.ok(iVerify >= 0 && iSig > iVerify && iDiff > iSig && iUpload > iDiff)
  const up = steps[iUpload]
  for (const f of ['sbom.cdx.json', 'sbom-diff.json', 'sbom-diff.txt', 'audit-signatures.txt']) assert.match(up, new RegExp(`candidate-upload/${f.replace('.', '\\.')}`))
  assert.match(up, /retention-days:\s*14\b/)
})

test('AF7: the job stays read-only and publish-free with the new steps', () => {
  const code = job.replace(/^\s*#.*$/gm, '')
  assert.doesNotMatch(code, /contents:\s*write|actions:\s*write|packages:\s*write|id-token/)
  assert.match(code, /actions:\s*read/)
  assert.doesNotMatch(code, /gh release|npm publish|git (push|tag|commit)/)
})

test('AF7: README documents both steps, the npmmirror reason and the trust boundary', () => {
  const readme = read('docs/release/README.md')
  assert.match(readme, /npm audit signatures/)
  assert.match(readme, /npmmirror/)
  assert.match(readme, /--sbom-diff/)
  assert.match(readme, /scripts\/sbom-diff\.mjs/)
  assert.match(readme, /first candidate/)
})
