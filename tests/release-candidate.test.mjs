/**
 * ============================================================================
 * 文件标识：tests/release-candidate.test.mjs ｜ 发行候选包（Z5）：干净树、命名、证据字段、说明提取
 * ============================================================================
 * 【职责】证明 `scripts/release-candidate.mjs`：拒绝脏工作树（含未跟踪文件）；产物命名为
 *   RC-<version>-<shortsha>.zip + .sha256；EVIDENCE.json 只含脚本亲自产生或明确标注为"人工声明/未运行"的结果；
 *   RELEASE-NOTES.md 来自 CHANGELOG；verify-release 与生产验收在新解压目录上通过；verify-release --evidence
 *   拒绝被篡改或自相矛盾的证据。夹具复用 release-package 的最小源码树（桩构建，真实 git 仓库）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'
import { BATCHES } from '../scripts/gen-changelog.mjs'
import { hashTestsTree } from '../scripts/lib/tests-tree.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PATH = process.env.PATH

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function put(dir, rel, content) {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}
const git = (cwd, ...argv) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...argv], { cwd, encoding: 'utf8' })
/**
 * 仓库源文件清单：有 git 时取 `git ls-files`；在隔离回归副本（只复制了跟踪文件、没有 .git）里改为遍历目录，
 * 跳过 .git / node_modules / data / dist / release / coverage 与除 .env.example 外的 .env*（与 regress-isolated 的复制规则一致）。
 */
function repoSourceFiles() {
  const r = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8' })
  if (r.status === 0 && r.stdout) return r.stdout.split('\0')
  const SKIP = new Set(['.git', 'node_modules', 'data', 'dist', 'release', 'coverage'])
  const out = []
  const walk = (rel) => {
    for (const ent of readdirSync(path.join(ROOT, rel), { withFileTypes: true })) {
      const next = rel ? `${rel}/${ent.name}` : ent.name
      if (ent.isDirectory()) { if (!SKIP.has(ent.name)) walk(next); continue }
      if (ent.name.startsWith('.env') && ent.name !== '.env.example') continue
      if (ent.isFile()) out.push(next)
    }
  }
  walk('')
  return out
}

function minimalSource(t) {
  const src = tempDir(t, 'os-erp-rc-src-')
  for (const name of ['server', 'scripts']) cpSync(path.join(ROOT, name), path.join(src, name), { recursive: true })
  for (const name of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'CHANGELOG.md']) cpSync(path.join(ROOT, name), path.join(src, name))
  cpSync(path.join(ROOT, 'docs/implementation'), path.join(src, 'docs/implementation'), { recursive: true })
  put(src, 'src/App.tsx', '// stub\n')
  put(src, 'reusable/README.md', '# stub\n')
  put(src, 'docs/本地交付/README.md', '# stub\n')
  put(src, 'dist/index.html', '<!doctype html><html><head><title>stub</title><script type="module" src="/assets/app.js"></script></head><body></body></html>')
  put(src, 'dist/assets/app.js', 'export {}\n')
  for (const page of ['install', 'manual']) put(src, `public/docs/${page}.html`, `<html><body>${page} stub</body></html>`)
  for (const f of ['index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore']) put(src, f, '# stub\n')
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(src, 'node_modules'), 'dir')
  put(src, '.gitignore', 'node_modules\nrelease/\ndist/\n')
  assert.equal(git(src, 'init', '-q').status, 0)
  assert.equal(git(src, 'add', '-A').status, 0)
  assert.equal(git(src, 'commit', '-q', '-m', 'stub').status, 0)
  return src
}
const candidate = (src, out, extra = [], env = {}) => spawnSync(process.execPath, ['scripts/release-candidate.mjs', `--output=${out}`, '--skip-build', '--skip-docs', '--reuse-node-modules', ...extra], { cwd: src, env: { PATH, ...env }, encoding: 'utf8', timeout: 280000 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')

test('candidate refuses a dirty working tree (modified, staged or untracked) before building anything', (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  for (const dirty of [
    () => writeFileSync(path.join(src, 'LICENSE'), 'changed\n'),
    () => { put(src, 'staged.txt', 'x'); git(src, 'add', 'staged.txt') },
    () => put(src, 'untracked.txt', 'x')
  ]) {
    dirty()
    const r = candidate(src, out)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /working tree is dirty/i)
    assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'nothing written for a dirty tree')
    git(src, 'reset', '-q', '--hard'); git(src, 'clean', '-fdq')
  }
})

test('candidate refuses git-ignored files that the packager would copy, and a secret hidden in a binary file', (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  put(src, 'public/artifacts/customer-export.csv', 'phone\n13800000000\n')
  writeFileSync(path.join(src, '.gitignore'), readFileSync(path.join(src, '.gitignore'), 'utf8').replace('release/', 'release/\npublic/artifacts/'))
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'ignore artifacts')
  const r = candidate(src, out)
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /git-ignored files/)
  assert.match(r.stderr, /customer-export\.csv/)
  assert.ok(!existsSync(out) || readdirSync(out).length === 0)
})

test('secret scan inspects binary and large files too', async (t) => {
  const { scanSecrets } = await import(pathToFileURL(path.join(ROOT, 'scripts/release-candidate.mjs')).href)
  const dir = tempDir(t, 'os-erp-rc-scan-')
  const token = 'sk' + '-' + 'A'.repeat(40)
  put(dir, 'ok.txt', 'nothing\n')
  assert.equal(scanSecrets(dir).result, 'passed')
  writeFileSync(path.join(dir, 'bin.dat'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(token)]))
  assert.match(scanSecrets(dir).findings.join(), /bin\.dat: API secret key/)
  rmSync(path.join(dir, 'bin.dat'))
  writeFileSync(path.join(dir, 'big.txt'), Buffer.concat([Buffer.alloc(9 * 1024 * 1024, 32), Buffer.from(token)]))
  assert.match(scanSecrets(dir).findings.join(), /big\.txt: API secret key/)
})

test('candidate refuses malformed flags rather than guessing', (t) => {
  const src = minimalSource(t)
  const out = tempDir(t, 'os-erp-rc-out-')
  for (const bad of ['--ci-run=abc', '--focused-result=green', '--regression-result=ok', '--guards-result=passed']) {
    const r = candidate(src, out, [bad])
    assert.notEqual(r.status, 0, bad)
  }
  // 声明了结果却没写来源 = 无法追溯，拒绝
  assert.notEqual(candidate(src, out, ['--focused-result=passed']).status, 0)
})

test('extractNotes picks the version section, else the newest batch, and always states it is a candidate', async () => {
  const { extractNotes } = await import(pathToFileURL(path.join(ROOT, 'scripts/release-candidate.mjs')).href)
  const log = '# 变更记录\n\nintro\n\n<!-- generated -->\n\n## 第二批 v9.9.9-rc.1\n\n- two\n\n## 第一批\n\n- one\n'
  const exact = extractNotes(log, '9.9.9-rc.1', { commit: 'abcdef0123456789', builtAt: '2026-01-01T00:00:00.000Z' })
  assert.equal(exact.matched, 'version')
  assert.match(exact.text, /- two/)
  assert.doesNotMatch(exact.text, /- one/)
  assert.match(exact.text, /not a published release/i)
  assert.match(exact.text, /abcdef0/)
  const fallback = extractNotes(log, '1.2.3', { commit: 'abcdef0123456789', builtAt: '2026-01-01T00:00:00.000Z' })
  assert.equal(fallback.matched, 'latest-batch')
  assert.match(fallback.text, /no section for version 1\.2\.3/i)
  assert.match(fallback.text, /- two/)
  assert.doesNotMatch(fallback.text, /- one/)
  assert.throws(() => extractNotes('# nothing here\n', '1.2.3', { commit: 'abcdef0', builtAt: 'x' }), /no changelog section/i)
})

test('candidate builds RC-<version>-<sha>.zip with sha256, EVIDENCE.json and notes, and verifies on a fresh extraction', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const version = JSON.parse(readFileSync(path.join(src, 'package.json'), 'utf8')).version
  const head = git(src, 'rev-parse', 'HEAD').stdout.trim()
  const short = head.slice(0, 7)
  const r = candidate(src, out, ['--ci-run=123456789', '--focused-result=passed', '--focused-source=node --test on mac mini (operator)'])
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-3000))

  const name = `RC-${version}-${short}`
  const zip = path.join(out, `${name}.zip`)
  assert.ok(existsSync(zip), 'zip named RC-<version>-<shortsha>.zip')
  const sumLine = readFileSync(`${zip}.sha256`, 'utf8')
  assert.equal(sumLine, `${sha(readFileSync(zip))}  ${name}.zip\n`)
  // 只留候选产物：没有 BanyuanERP-Local-* 中间目录
  assert.deepEqual(readdirSync(out).filter(f => f.startsWith('BanyuanERP')), [])
  // 包内没有数据库、环境文件、密钥
  const names = Object.keys(unzipSync(new Uint8Array(readFileSync(zip))))
  assert.deepEqual(names.filter(n => /(^|\/)\.env|\.(db|sqlite3?)(-|$)|\.pem$/i.test(n)), [])

  const dir = path.join(out, `${name}.evidence`)
  const ev = JSON.parse(readFileSync(path.join(dir, 'EVIDENCE.json'), 'utf8'))
  assert.equal(ev.version, version)
  assert.equal(ev.commit, head)
  assert.match(ev.built_at, /^\d{4}-\d\d-\d\dT/)
  assert.equal(ev.node, process.version)
  assert.equal(ev.ci_run_id, '123456789')
  assert.equal(ev.artifact.name, `${name}.zip`)
  assert.equal(ev.artifact.sha256, sha(readFileSync(zip)))
  assert.deepEqual(ev.focused_tests, { source: 'node --test on mac mini (operator)', result: 'passed', origin: 'operator-attested' })
  assert.equal(ev.regression.result, 'not run')
  for (const g of Object.values(ev.guards)) assert.equal(g.result, 'not run') // 没有 --run-guards，不得声称通过
  assert.equal(ev.verify_release.result, 'passed')
  assert.equal(ev.verify_release.origin, 'produced')
  assert.equal(ev.acceptance.result, 'passed')
  assert.equal(ev.acceptance.mode, 'production')
  assert.equal(ev.acceptance.reuse_node_modules, true)
  assert.equal(ev.secret_scan.result, 'passed')
  assert.equal(ev.not_a_release, true)
  assert.ok(ev.synthetic_drill.files.length >= 2)
  for (const f of ev.synthetic_drill.files) assert.equal(f.sha256, sha(readFileSync(path.join(src, f.path))))

  const notes = readFileSync(path.join(dir, 'RELEASE-NOTES.md'), 'utf8')
  assert.match(notes, new RegExp(version.replace(/\./g, '\\.')))
  assert.match(notes, /not a published release/i)
  // 版本号在 CHANGELOG 中没有专属小节时，发布说明展示最新批次小节（BATCHES 末项；随批次推进，不写死批次名）
  // 最新批次 = 已有 ADR 落入其区间的最后一个批次（BATCHES 末项可能是尚无 ADR 的预留区间，CHANGELOG 不会为它生成小节）
  const maxAdr = Math.max(...readdirSync(path.join(ROOT, 'docs/implementation')).map(f => /^ADR-(\d{4})-/.exec(f)).filter(Boolean).map(m => Number(m[1])))
  const newest = [...BATCHES].reverse().find(b => b.from <= maxAdr) || BATCHES[BATCHES.length - 1]
  assert.ok(notes.includes(newest.title), `notes show the newest batch section (${newest.title})`)

  // 默认（无 --ci-run / 人工声明）时同样的证据字段是 null / not run
  // verify-release --evidence 接受真证据，拒绝篡改
  const pkg = tempDir(t, 'os-erp-rc-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const evFile = path.join(dir, 'EVIDENCE.json')
  const verify = (file = evFile) => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${file}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.equal(verify().status, 0, verify().stderr)
  const mutate = fn => { const e = JSON.parse(JSON.stringify(ev)); fn(e); const f = path.join(dir, 'tampered.json'); writeFileSync(f, JSON.stringify(e)); return verify(f) }
  // 证据绑定真实 zip：hash/名字不符即红
  const bound = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${evFile}`, `--artifact=${zip}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.equal(bound.status, 0, bound.stderr)
  const other = path.join(dir, `RC-other.zip`)
  writeFileSync(other, 'not the archive')
  const unbound = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${evFile}`, `--artifact=${other}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(unbound.status, 0)
  assert.match(unbound.stderr, /artifact/)
  for (const [label, fn, re] of [
    ['commit mismatch', e => { e.commit = 'a'.repeat(40) }, /commit/],
    ['version mismatch', e => { e.version = '9.9.9' }, /version/],
    ['bad result', e => { e.focused_tests.result = 'green' }, /focused_tests/],
    ['passed without source', e => { e.focused_tests.source = '' }, /focused_tests/],
    ['guard passed but origin missing', e => { e.guards = { x: { result: 'passed' } } }, /guards/],
    ['bad ci id', e => { e.ci_run_id = 'run-1' }, /ci_run_id/],
    ['drill hash wrong', e => { e.synthetic_drill.files[0].sha256 = '0'.repeat(64) }, /synthetic_drill/],
    ['acceptance attested not produced', e => { e.acceptance.origin = 'operator-attested' }, /acceptance/],
    ['secret_scan attested', e => { e.secret_scan.origin = 'operator-attested' }, /secret_scan/],
    ['invented guard', e => { e.guards = { invented: { result: 'passed', origin: 'produced' } } }, /guards/],
    ['guard attested', e => { e.guards['tsc'] = { result: 'passed', origin: 'operator-attested' } }, /guards\.tsc/],
    ['file count wrong', e => { e.artifact.files += 1 }, /artifact/],
    ['acceptance not passed', e => { e.acceptance.result = 'failed' }, /acceptance/],
    ['missing field', e => { delete e.built_at }, /built_at/]
  ]) {
    const x = mutate(fn)
    assert.notEqual(x.status, 0, label)
    assert.match(x.stderr, re, label)
  }
})

// ---- AA7：--run-tests、--ci-run=auto、测试树哈希绑定 ----
/** 写一个假的 gh 可执行文件：打印给定 stdout 并以给定状态退出（外部服务的测试替身，不在被测脚本内）。 */
function fakeGh(t, { stdout = '[]', status = 0, stderr = '' }) {
  const dir = tempDir(t, 'os-erp-rc-gh-')
  const file = path.join(dir, 'gh')
  writeFileSync(file, `#!/bin/sh\necho "$@" > "${dir}/args.txt"\ncat <<'EOF_JSON'\n${stdout}\nEOF_JSON\necho '${stderr}' >&2\nexit ${status}\n`)
  chmodSync(file, 0o755)
  return { file, dir }
}
const HEAD40 = 'b'.repeat(40)
/** 五个守卫检查真实仓库形状，所以守卫用例的桩树要带上全部受版本控制的源码（tests/ 与 dist/ 除外），再放自己的桩测试。 */
function guardedSource(t, stubTests) {
  const src = minimalSource(t)
  const tracked = repoSourceFiles().filter(f => f && !/^(tests|dist)\//.test(f) && f !== '.gitignore' && existsSync(path.join(ROOT, f)))
  for (const f of tracked) { mkdirSync(path.dirname(path.join(src, f)), { recursive: true }); cpSync(path.join(ROOT, f), path.join(src, f)) }
  // 文件标识守卫登记了若干测试文件：用只含标识块的桩满足它，不重复运行真实用例（也避免递归运行本文件）。
  const header = f => `/**\n * ============================================================================\n * 文件标识：${f} ｜ 桩（只满足文件标识守卫）\n * ============================================================================\n */\n`
  for (const f of readFileSync(path.join(ROOT, 'scripts/check-file-header.mjs'), 'utf8').match(/'tests\/[^']+'/g).map(x => x.slice(1, -1))) {
    put(src, f, `${header(f)}import test from 'node:test'\ntest('header stub ${f}', () => {})\n`)
  }
  // 库文件路径守卫的例外表登记了若干测试文件（要求它们仍有命中）：桩里放一行命中形态，注释行不算命中所以用代码行。
  const allowed = readFileSync(path.join(ROOT, 'scripts/check-data-paths.mjs'), 'utf8').match(/^\s*'tests\/[^']+':/gm).map(x => x.trim().slice(1, x.trim().indexOf("'", 1)))
  const DATA = `'da${'ta'}'` // 拼接，避免本文件自身命中路径守卫
  for (const f of allowed) put(src, f, `${header(f)}import test from 'node:test'\nimport path from 'node:path'\nconst root = '.'\nexport const probe = path.join(root, ${DATA})\ntest('allow-list stub ${f}', () => {})\n`)
  for (const f of Object.keys(stubTests)) put(src, `tests/${f}`, `${header(`tests/${f}`)}${stubTests[f]}`)
  put(src, '.gitignore', 'node_modules\n/release/\ndist/\n') // 真实目录 docs/release/ 不能被 release/ 规则忽略
  git(src, 'add', '-A'); assert.equal(git(src, 'commit', '-q', '-m', 'guarded stub').status, 0)
  return src
}

test('parseTestSummary needs every count exactly once; resolveCiRun is honest about gh and missing runs', async (t) => {
  const { parseTestSummary, resolveCiRun } = await import(pathToFileURL(path.join(ROOT, 'scripts/release-candidate.mjs')).href)
  assert.deepEqual(parseTestSummary('ℹ tests 5\nℹ suites 1\nℹ pass 4\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 12\n'), { tests: 5, pass: 4, fail: 0, cancelled: 0, skipped: 1, todo: 0 })
  assert.equal(parseTestSummary('ℹ tests 5\nℹ pass 5\n'), null, 'missing counts')
  assert.equal(parseTestSummary('ℹ tests 5\nℹ tests 6\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n'), null, 'ambiguous counts')
  assert.equal(parseTestSummary(''), null)

  // gh 不可用
  const none = resolveCiRun(HEAD40, { gh: '/nonexistent/gh' })
  assert.equal(none.id, null)
  assert.match(none.lookup.reason, /gh unavailable/)
  // gh 失败（未登录等）
  const failed = fakeGh(t, { status: 1, stderr: 'not logged in' })
  const f = resolveCiRun(HEAD40, { gh: failed.file })
  assert.equal(f.id, null)
  assert.match(f.lookup.reason, /exit 1.*not logged in/s)
  // 没有任何 run
  const empty = resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: '[]' }).file })
  assert.equal(empty.id, null)
  assert.match(empty.lookup.reason, /no ci\.yml run recorded/)
  // 只有失败/进行中
  const bad = resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: JSON.stringify([{ databaseId: 9, conclusion: 'failure', status: 'completed', headSha: HEAD40, createdAt: '2026-01-02T00:00:00Z', event: 'push', headBranch: 'main' }, { databaseId: 8, conclusion: '', status: 'in_progress', headSha: HEAD40, createdAt: '2026-01-03T00:00:00Z', event: 'push', headBranch: 'main' }]) }).file })
  assert.equal(bad.id, null)
  assert.match(bad.lookup.reason, /none with conclusion success/)
  // 乱码输出
  assert.match(resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: 'oops' }).file }).lookup.reason, /unparseable/)
  // 选最新成功，忽略其他提交与失败；并验证传给 gh 的参数
  const gh = fakeGh(t, { stdout: JSON.stringify([
    { databaseId: 100, conclusion: 'failure', status: 'completed', headSha: HEAD40, createdAt: '2026-01-05T00:00:00Z', event: 'push', headBranch: 'main' },
    { databaseId: 101, conclusion: 'success', status: 'completed', headSha: HEAD40, createdAt: '2026-01-02T00:00:00Z', event: 'push', headBranch: 'main' },
    { databaseId: 102, conclusion: 'success', status: 'completed', headSha: HEAD40, createdAt: '2026-01-04T00:00:00Z', event: 'push', headBranch: 'main' },
    { databaseId: 103, conclusion: 'success', status: 'completed', headSha: 'c'.repeat(40), createdAt: '2026-01-09T00:00:00Z', event: 'push', headBranch: 'main' }
  ]) })
  const ok = resolveCiRun(HEAD40, { gh: gh.file })
  assert.equal(ok.id, '102')
  assert.equal(ok.lookup.conclusion, 'success')
  assert.equal(ok.lookup.source, 'gh run list')
  assert.equal(ok.lookup.head_sha, HEAD40)
  assert.equal(ok.lookup.gh_override, undefined) // 单测直接传 gh 参数，不经环境变量
  // 缺 headSha 的记录不被信任
  assert.equal(resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: JSON.stringify([{ databaseId: 5, conclusion: 'success', event: 'push', headBranch: 'main' }]) }).file }).id, null)
  const args = readFileSync(path.join(gh.dir, 'args.txt'), 'utf8')
  assert.match(args, new RegExp(`run list --commit ${HEAD40} --workflow ci\\.yml --json databaseId,conclusion`))
})

test('--run-tests cannot be combined with an operator-attested focused result', (t) => {
  const src = minimalSource(t)
  const r = candidate(src, tempDir(t, 'os-erp-rc-out-'), ['--run-tests', '--focused-result=passed', '--focused-source=x'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /do not combine/)
})

test('--run-tests with a failing test aborts and writes no candidate', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  put(src, 'tests/zz-fails.test.mjs', "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('stub failure', () => assert.equal(1, 2))\n")
  git(src, 'add', '-A'); git(src, 'commit', '-q', '-m', 'failing test')
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--run-tests'])
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /Focused suite failed/)
  assert.match(r.stderr, /stub failure/)
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'no candidate left behind')
})

test('--run-tests --ci-run auto records produced results bound to the package tests tree; gh stand-in supplies the run id', { timeout: 290000 }, (t) => {
  const src = guardedSource(t, { 'zz-ok.test.mjs': "import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('stub ok', () => assert.equal(1, 1))\ntest('stub skipped', { skip: true }, () => {})\n" })
  const head = git(src, 'rev-parse', 'HEAD').stdout.trim()
  const gh = fakeGh(t, { stdout: JSON.stringify([{ databaseId: 424242, conclusion: 'success', status: 'completed', headSha: head, createdAt: '2026-01-04T00:00:00Z', event: 'push', headBranch: 'main' }]) })
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--run-tests', '--ci-run', 'auto'], { OS_ERP_GH: gh.file })
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-3000))
  const name = readdirSync(out).find(f => f.endsWith('.evidence'))
  const dir = path.join(out, name)
  const ev = JSON.parse(readFileSync(path.join(dir, 'EVIDENCE.json'), 'utf8'))
  const zip = path.join(out, name.replace('.evidence', '.zip'))
  // 焦点测试：亲自运行，带计数与耗时，哈希等于仓库 tests/ 树
  const ft = ev.focused_tests
  assert.equal(ft.result, 'passed')
  assert.equal(ft.origin, 'produced')
  assert.ok(ft.duration_ms >= 0)
  const stubs = readdirSync(path.join(src, 'tests')).filter(f => f.endsWith('.test.mjs') && f !== 'zz-ok.test.mjs').length // 每个桩 1 个用例 + zz-ok 的 2 个（1 通过、1 跳过）
  assert.deepEqual(ft.summary_counts, { tests: stubs + 2, pass: stubs + 1, fail: 0, cancelled: 0, skipped: 1, todo: 0 })
    assert.equal(ft.tests_tree_sha256, hashTestsTree(src))
  for (const g of Object.values(ev.guards)) { assert.equal(g.result, 'passed'); assert.equal(g.origin, 'produced'); assert.ok(g.duration_ms >= 0) }
  // CI：来自 gh 替身，且被标注为查询结果
  assert.equal(ev.ci_run_id, '424242')
  assert.equal(ev.ci_lookup.mode, 'auto')
  assert.equal(ev.ci_lookup.source, 'gh run list')
  assert.equal(ev.ci_lookup.head_sha, head)
  assert.equal(ev.ci_lookup.gh_override, true) // 测试替身必须在证据里留痕
  assert.match(readFileSync(path.join(gh.dir, 'args.txt'), 'utf8'), new RegExp(`--commit ${head}`))

  const pkg = tempDir(t, 'os-erp-rc-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const listing = JSON.parse(readFileSync(path.join(pkg, 'release/tests-tree.json'), 'utf8'))
  assert.equal(listing.tree_sha256, ft.tests_tree_sha256)
  assert.ok(!existsSync(path.join(pkg, 'tests')), 'tests/ itself is not shipped (it holds TLS key fixtures)')
  const verify = file => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${file}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.equal(verify(path.join(dir, 'EVIDENCE.json')).status, 0, verify(path.join(dir, 'EVIDENCE.json')).stderr)
  const mutate = fn => { const e = JSON.parse(JSON.stringify(ev)); fn(e); const f = path.join(dir, 'tampered.json'); writeFileSync(f, JSON.stringify(e)); return verify(f) }
  for (const [label, fn, re] of [
    ['counts missing', e => { delete e.focused_tests.summary_counts }, /summary_counts/],
    ['count field missing', e => { delete e.focused_tests.summary_counts.todo }, /summary_counts/],
    ['zero tests', e => { e.focused_tests.summary_counts = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 } }, /at least one passing/],
    ['failures with passed', e => { e.focused_tests.summary_counts.fail = 1 }, /failed or cancelled/],
    ['duration missing', e => { delete e.focused_tests.duration_ms }, /duration_ms/],
    ['tests hash missing', e => { delete e.focused_tests.tests_tree_sha256 }, /tests_tree_sha256/],
    ['tests hash wrong', e => { e.focused_tests.tests_tree_sha256 = '0'.repeat(64) }, /tests tree binding failed/],
    ['auto ci id without gh source', e => { e.ci_lookup.source = 'operator' }, /ci_lookup/],
    ['inconsistent counts', e => { e.focused_tests.summary_counts.pass += 5 }, /inconsistent/],
    ['auto ci for another commit', e => { e.ci_lookup.head_sha = 'f'.repeat(40) }, /ci_lookup/],
    ['auto ci null without reason', e => { e.ci_run_id = null; delete e.ci_lookup.reason }, /ci_lookup/],
    ['none mode with id', e => { e.ci_lookup = { mode: 'none' } }, /ci_lookup/]
  ]) {
    const x = mutate(fn)
    assert.notEqual(x.status, 0, label)
    assert.match(x.stderr, re, label)
  }
  // 包内清单被改（哈希与 MANIFEST 不符 / 自身不一致）同样被拒
  writeFileSync(path.join(pkg, 'release/tests-tree.json'), JSON.stringify({ ...listing, files: listing.files.slice(1) }))
  const swapped = verify(path.join(dir, 'EVIDENCE.json'))
  assert.notEqual(swapped.status, 0)
  assert.match(swapped.stderr, /tests-tree\.json|tests tree binding failed/)
})

test('without gh the candidate still builds, with ci_run_id null and the reason recorded; nothing is invented', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--ci-run=auto'], { OS_ERP_GH: '/nonexistent/gh' })
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-3000))
  const ev = JSON.parse(readFileSync(path.join(out, readdirSync(out).find(f => f.endsWith('.evidence')), 'EVIDENCE.json'), 'utf8'))
  assert.equal(ev.ci_run_id, null)
  assert.equal(ev.ci_lookup.mode, 'auto')
  assert.match(ev.ci_lookup.reason, /gh unavailable/)
  assert.equal(ev.focused_tests.result, 'not run') // 没有 --run-tests 就不得出现 produced 的焦点结果
  assert.equal(ev.focused_tests.origin, undefined)
})

// ---- AE10：标签推送没有成功的 ci.yml run 时，托管 CI 回退为记录当前 run（自指引用，如实标注） ----
test('selfCiRun only applies on hosted CI with a numeric run id for this very commit, and never claims success', async () => {
  const { selfCiRun } = await import(pathToFileURL(path.join(ROOT, 'scripts/release-candidate.mjs')).href)
  assert.equal(selfCiRun(HEAD40, {}), null, 'not on CI')
  assert.equal(selfCiRun(HEAD40, { GITHUB_ACTIONS: 'true' }), null, 'no run id')
  assert.equal(selfCiRun(HEAD40, { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: 'abc' }), null, 'non-numeric run id')
  assert.equal(selfCiRun(HEAD40, { GITHUB_ACTIONS: 'false', GITHUB_RUN_ID: '7' }), null, 'GITHUB_ACTIONS must be exactly true')
  assert.equal(selfCiRun(HEAD40, { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '7', GITHUB_SHA: 'c'.repeat(40) }), null, 'other commit')
  const s = selfCiRun(HEAD40, { GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '7', GITHUB_SHA: HEAD40 })
  assert.equal(s.id, '7')
  assert.equal(s.lookup.ci_run_origin, 'hosted-ci-self')
  assert.equal(s.lookup.conclusion, undefined)
  assert.match(s.lookup.note, /SELF-REFERENTIAL/)
})

test('--ci-run=auto on hosted CI without a successful ci.yml run records the current run as hosted-ci-self; verify-release accepts it with a warning and rejects forgeries', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const head = git(src, 'rev-parse', 'HEAD').stdout.trim()
  const gh = fakeGh(t, { stdout: '[]' })
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--ci-run=auto'], { OS_ERP_GH: gh.file, GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '555001', GITHUB_SHA: head })
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-3000))
  const name = readdirSync(out).find(f => f.endsWith('.evidence'))
  const dir = path.join(out, name)
  const ev = JSON.parse(readFileSync(path.join(dir, 'EVIDENCE.json'), 'utf8'))
  assert.equal(ev.ci_run_id, '555001')
  assert.equal(ev.built_by, 'hosted-ci')
  assert.equal(ev.ci_lookup.mode, 'auto')
  assert.equal(ev.ci_lookup.ci_run_origin, 'hosted-ci-self')
  assert.equal(ev.ci_lookup.source, 'GITHUB_RUN_ID')
  assert.equal(ev.ci_lookup.conclusion, undefined)
  assert.match(ev.ci_lookup.lookup_reason, /no ci\.yml run recorded/)
  assert.match(ev.ci_lookup.note, /SELF-REFERENTIAL/)
  const pkg = tempDir(t, 'os-erp-rc-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(path.join(out, name.replace('.evidence', '.zip'))))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const verify = file => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${file}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  const ok = verify(path.join(dir, 'EVIDENCE.json'))
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /hosted-ci-self/)
  for (const [label, fn] of [
    ['claims success', e => { e.ci_lookup.conclusion = 'success' }],
    ['other commit', e => { e.ci_lookup.head_sha = 'f'.repeat(40) }],
    ['note removed', e => { delete e.ci_lookup.note }],
    ['wrong source', e => { e.ci_lookup.source = 'gh run list' }],
    ['not hosted-ci', e => { e.built_by = 'local' }]
  ]) {
    const e = JSON.parse(JSON.stringify(ev)); fn(e)
    const f = path.join(dir, 'tampered.json'); writeFileSync(f, JSON.stringify(e))
    const x = verify(f)
    assert.notEqual(x.status, 0, label)
  }
})

test('AF1: resolveCiRun accepts only ci.yml pull_request/push runs; dispatch runs and legacy v* tag-push runs are not check evidence', async (t) => {
  const { resolveCiRun } = await import(pathToFileURL(path.join(ROOT, 'scripts/release-candidate.mjs')).href)
  const run = (id, event, headBranch) => ({ databaseId: id, conclusion: 'success', status: 'completed', headSha: HEAD40, createdAt: `2026-01-0${id - 200}T00:00:00Z`, event, headBranch })
  const r = resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: JSON.stringify([run(206, 'workflow_dispatch', 'main'), run(205, 'schedule', 'main'), run(204, 'push', 'v1.2.3'), run(203, 'push', 'main'), run(202, 'pull_request', 'feat/x')]) }).file })
  assert.equal(r.id, '203')
  const pr = resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: JSON.stringify([run(204, 'push', 'v1.2.3'), run(203, 'push', 'vnext'), run(202, 'pull_request', 'v2-fix')]) }).file })
  assert.equal(pr.id, '202')
  for (const bad of [run(204, 'push', 'v1.2.3'), run(208, 'push', 'vnext'), run(209, 'push', 'feat/x'), run(206, 'workflow_dispatch', 'main'), { databaseId: 207, conclusion: 'success', status: 'completed', headSha: HEAD40, createdAt: '2026-01-07T00:00:00Z' }]) {
    const only = resolveCiRun(HEAD40, { gh: fakeGh(t, { stdout: JSON.stringify([bad]) }).file })
    assert.equal(only.id, null)
    assert.match(only.lookup.reason, /none with conclusion success on a pull_request or main push event/)
  }
})

test('outside hosted CI a missing successful run stays null (no self record is invented locally)', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--ci-run=auto'], { OS_ERP_GH: fakeGh(t, { stdout: '[]' }).file, GITHUB_RUN_ID: '555001' })
  assert.equal(r.status, 0, r.stderr.slice(-2000))
  const ev = JSON.parse(readFileSync(path.join(out, readdirSync(out).find(f => f.endsWith('.evidence')), 'EVIDENCE.json'), 'utf8'))
  assert.equal(ev.ci_run_id, null)
  assert.equal(ev.ci_lookup.ci_run_origin, undefined)
})

// AG1：--skip-focused 演练（只许托管 CI；证据标 dry_run；永不进透明日志）
test('AG1: --skip-focused is refused outside GitHub Actions, and never combines with --log, --run-tests or an attested focused result', (t) => {
  const src = minimalSource(t)
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const local = candidate(src, out, ['--skip-focused'])
  assert.notEqual(local.status, 0)
  assert.match(local.stderr, /--skip-focused is only allowed when GITHUB_ACTIONS=true/)
  assert.ok(!existsSync(out), 'nothing is built')
  const falseEnv = candidate(src, out, ['--skip-focused'], { GITHUB_ACTIONS: 'false' })
  assert.notEqual(falseEnv.status, 0)
  assert.match(falseEnv.stderr, /only allowed when GITHUB_ACTIONS=true/)
  const hosted = { GITHUB_ACTIONS: 'true' }
  const withLog = candidate(src, out, ['--skip-focused', `--log=${path.join(out, 'log.jsonl')}`], hosted)
  assert.notEqual(withLog.status, 0)
  assert.match(withLog.stderr, /dry run.*evidence log|evidence log.*dry run/i)
  assert.notEqual(candidate(src, out, ['--skip-focused', '--log'], hosted).status, 0)
  assert.match(candidate(src, out, ['--skip-focused', '--run-tests'], hosted).stderr, /--skip-focused/)
  assert.match(candidate(src, out, ['--skip-focused', '--focused-result=passed', '--focused-source=x'], hosted).stderr, /--skip-focused/)
  assert.ok(!existsSync(out), 'nothing is built')
})

test('AG1: a hosted --skip-focused build records dry_run, skipped-dry-run focused tests; verify-release warns, is never log-eligible and rejects forgeries', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const head = git(src, 'rev-parse', 'HEAD').stdout.trim()
  const gh = fakeGh(t, { stdout: '[]' })
  const out = path.join(tempDir(t, 'os-erp-rc-out-'), 'release')
  const r = candidate(src, out, ['--skip-focused', '--ci-run=auto'], { OS_ERP_GH: gh.file, GITHUB_ACTIONS: 'true', GITHUB_RUN_ID: '555002', GITHUB_SHA: head })
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-3000))
  const name = readdirSync(out).find(f => f.endsWith('.evidence'))
  const dir = path.join(out, name)
  const zip = path.join(out, name.replace('.evidence', '.zip'))
  const ev = JSON.parse(readFileSync(path.join(dir, 'EVIDENCE.json'), 'utf8'))
  assert.equal(ev.dry_run, true)
  assert.equal(ev.focused_tests.origin, 'skipped-dry-run')
  assert.equal(ev.focused_tests.result, 'not run')
  assert.equal(ev.built_by, 'hosted-ci')
  assert.equal(ev.signature, null)
  assert.equal(ev.not_a_release, true)
  assert.ok(!existsSync(path.join(out, 'EVIDENCE-LOG.jsonl')))
  const pkg = tempDir(t, 'os-erp-rc-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const verify = (file, extra = []) => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${file}`, `--artifact=${zip}`, ...extra], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  const ok = verify(path.join(dir, 'EVIDENCE.json'))
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /DRY RUN, NOT A CANDIDATE/)
  // 即使有人手工造一份日志，演练也不能通过 --log 核验
  const fakeLog = path.join(dir, 'fake-log.jsonl')
  writeFileSync(fakeLog, '')
  const logged = verify(path.join(dir, 'EVIDENCE.json'), [`--log=${fakeLog}`])
  assert.notEqual(logged.status, 0)
  assert.match(logged.stderr, /dry run.*never log-eligible/i)
  const forge = (label, fn, re) => {
    const e = JSON.parse(JSON.stringify(ev)); fn(e)
    const f = path.join(dir, 'tampered.json'); writeFileSync(f, JSON.stringify(e))
    const x = verify(f)
    assert.notEqual(x.status, 0, label)
    assert.match(x.stderr, re, label)
  }
  forge('dry_run removed but still skipped', e => { delete e.dry_run }, /skipped-dry-run/)
  forge('dry_run false but still skipped', e => { e.dry_run = false }, /dry_run/)
  forge('dry_run true but focused passed', e => { e.focused_tests = { result: 'passed', origin: 'operator-attested', source: 'x' } }, /dry_run/)
  forge('dry_run not boolean', e => { e.dry_run = 'yes' }, /dry_run/)
  forge('dry run claims a signature', e => { e.signature = { key_id: 'a'.repeat(64) }; e.built_by = 'key-holder' }, /dry_run|signature/)
})
