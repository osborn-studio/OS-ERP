/**
 * ============================================================================
 * 文件标识：tests/release-package.test.mjs ｜ 发行包验收（W8）：打最小包 → 解压 → 生产模式端到端验收
 * ============================================================================
 * 【职责】证明 `scripts/package-release.mjs` → `scripts/verify-release.mjs` → `scripts/test-local-delivery.mjs`
 *   这条链在**生产模式**下真的走通：setup --instance → bootstrap-admin(stdin) → start → 用该管理员登录 →
 *   健康/版本/build_sha → 受限能力 503 → 无演示账号/数据 → 备份 → 恢复演练 → 篡改检测。
 *
 * 【最小包的约定（桩）】这里不跑 vite 构建、不重建网页手册：临时源码根里 `dist/`、`public/docs/`、`src/`、
 *   `reusable/`、`docs/本地交付/` 与各配置文件都是**占位桩**（只有一两行），`server/`、`scripts/`、`package.json`、
 *   `package-lock.json`、`THIRD_PARTY_NOTICES.md` 是仓库真实文件；`node_modules` 以软链复用仓库依赖
 *   （验收加 `--reuse-node-modules`，因此不覆盖"运行时依赖不含构建链"那条，那条只在真实 `npm run release` 包上验）。
 *   临时源码根是一个真实 git 仓库（一次提交），所以 MANIFEST.baseCommit 是真实 SHA。
 *   演示分支（--mode=demo）需要完整网页与手册，不在这个最小包里跑，只在真实包上验。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
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
function minimalSource(t, { commit = true } = {}) {
  const src = tempDir(t, 'os-erp-release-src-')
  for (const name of ['server', 'scripts']) cpSync(path.join(ROOT, name), path.join(src, name), { recursive: true })
  for (const name of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE']) cpSync(path.join(ROOT, name), path.join(src, name))
  put(src, 'src/App.tsx', '// stub\n')
  put(src, 'reusable/README.md', '# stub\n')
  put(src, 'docs/本地交付/README.md', '# stub\n')
  put(src, 'dist/index.html', '<!doctype html><html><head><title>stub</title><script type="module" src="/assets/app.js"></script></head><body></body></html>')
  put(src, 'dist/assets/app.js', 'export {}\n')
  for (const page of ['install', 'manual']) put(src, `public/docs/${page}.html`, `<html><body>${page} stub</body></html>`)
  for (const f of ['index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore']) put(src, f, '# stub\n')
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(src, 'node_modules'), 'dir') // package-release 需要 fflate；包本身排除 node_modules
  put(src, '.gitignore', 'node_modules\n')
  if (commit) {
    const git = (...argv) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...argv], { cwd: src, encoding: 'utf8' })
    assert.equal(git('init', '-q').status, 0)
    assert.equal(git('add', '-A').status, 0)
    assert.equal(git('commit', '-q', '-m', 'stub').status, 0)
  }
  return src
}
function release(src, out) {
  return spawnSync(process.execPath, ['scripts/package-release.mjs', `--output=${out}`, '--skip-build', '--skip-docs'], { cwd: src, env: { PATH }, encoding: 'utf8', timeout: 120000 })
}
/** 解压 zip（走真实归档路径，而不是直接用输出目录）并软链依赖。 */
function extract(t, out) {
  const zip = readdirSync(out).find(f => f.endsWith('.zip'))
  assert.ok(zip, 'archive written')
  const dest = tempDir(t, 'os-erp-release-pkg-')
  for (const [name, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(path.join(out, zip)))))) {
    if (name.endsWith('/')) continue
    put(dest, name.split('/').slice(1).join('/'), bytes)
  }
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(dest, 'node_modules'), 'dir')
  return dest
}

test('minimal package carries baseCommit and notices, and passes production acceptance end-to-end', { timeout: 280000 }, (t) => {
  const src = minimalSource(t)
  const out = tempDir(t, 'os-erp-release-out-')
  const built = release(src, out)
  assert.equal(built.status, 0, built.stderr + built.stdout)
  const pkg = extract(t, out)

  const manifest = JSON.parse(readFileSync(path.join(pkg, 'MANIFEST.json'), 'utf8'))
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: src, encoding: 'utf8' }).stdout.trim()
  assert.equal(manifest.baseCommit, head)
  assert.ok(manifest.files['THIRD_PARTY_NOTICES.md'])
  assert.ok(existsSync(path.join(pkg, 'THIRD_PARTY_NOTICES.md')))
  assert.doesNotMatch(readFileSync(path.join(pkg, 'README.md'), 'utf8'), /12345/)

  const evidence = tempDir(t, 'os-erp-release-evidence-')
  const run = spawnSync(process.execPath, ['scripts/test-local-delivery.mjs', `--package=${pkg}`, `--evidence=${evidence}`, '--reuse-node-modules'], {
    cwd: ROOT, env: { PATH }, encoding: 'utf8', timeout: 250000
  })
  assert.equal(run.status, 0, run.stdout.slice(-3000) + run.stderr.slice(-3000))
  const report = JSON.parse(readFileSync(path.join(evidence, 'install-smoke.json'), 'utf8'))
  assert.equal(report.result, 'passed')
  assert.equal(report.mode, 'production')
  for (const needle of ['bootstrap-admin', 'FEATURE_DISABLED', 'restore drill', 'demo credentials', 'build_sha']) {
    assert.ok(report.checks.some(c => c.includes(needle)), `acceptance must contain a check about: ${needle}`)
  }
  assert.ok(report.timings_ms.restore_drill > 0)
  assert.ok(!existsSync(path.join(pkg, 'data')) && !existsSync(path.join(pkg, '.local')), 'production acceptance keeps state outside the package')
})

test('verify-release rejects a package without baseCommit, notices, or with database files listed', (t) => {
  const src = minimalSource(t)
  const out = tempDir(t, 'os-erp-release-out-')
  assert.equal(release(src, out).status, 0)
  const pkg = extract(t, out)
  const verify = () => spawnSync(process.execPath, ['scripts/verify-release.mjs'], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.equal(verify().status, 0)
  const file = path.join(pkg, 'MANIFEST.json')
  const original = readFileSync(file, 'utf8')
  const mutate = (fn) => { const m = JSON.parse(original); fn(m); writeFileSync(file, JSON.stringify(m)); return verify() }
  let r = mutate(m => { delete m.baseCommit })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /baseCommit/)
  r = mutate(m => { m.baseCommit = 'unavailable' })
  assert.notEqual(r.status, 0)
  r = mutate(m => { delete m.files['THIRD_PARTY_NOTICES.md'] })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /THIRD_PARTY_NOTICES/)
  r = mutate(m => { m.files['data/gml_cosmetic.db'] = 'x' })
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /must not be part of a release/)
  writeFileSync(file, original)
  assert.equal(verify().status, 0)
})

test('package-release refuses to build without a git commit to record', (t) => {
  const src = minimalSource(t, { commit: false })
  const r = release(src, tempDir(t, 'os-erp-release-out-'))
  assert.notEqual(r.status, 0)
  assert.match(r.stderr, /baseCommit/)
})
