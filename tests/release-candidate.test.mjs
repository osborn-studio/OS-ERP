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
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

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
  // Disposable repositories must not spawn detached maintenance that races teardown.
  assert.equal(git(src, 'config', 'gc.auto', '0').status, 0)
  assert.equal(git(src, 'config', 'maintenance.auto', 'false').status, 0)
  assert.equal(git(src, 'add', '-A').status, 0)
  assert.equal(git(src, 'commit', '-q', '-m', 'stub').status, 0)
  return src
}
const candidate = (src, out, extra = []) => spawnSync(process.execPath, ['scripts/release-candidate.mjs', `--output=${out}`, '--skip-build', '--skip-docs', '--reuse-node-modules', ...extra], { cwd: src, env: { PATH }, encoding: 'utf8', timeout: 280000 })
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
  assert.match(notes, /第[一二三四五六七八九十]+批/) // 取 CHANGELOG 最新批次节，不写死批次名

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
