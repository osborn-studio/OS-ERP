/**
 * ============================================================================
 * 文件标识：tests/docker-smoke-policy.test.mjs ｜ CI docker job 与冒烟脚本的静态守卫
 * ============================================================================
 * 便宜、诚实的文本断言：证明 .github/workflows/ci.yml 里有 docker job、Actions 固定到 SHA、
 * 不推镜像不登录；证明 scripts/docker-smoke.mjs 从不回显密钥、加固参数齐全、finally 里清理。
 * 它们不证明镜像能构建或冒烟能通过 —— 那是 CI docker job 本身的事。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFileSync(path.join(ROOT, file), 'utf8')
const workflow = read('.github/workflows/ci.yml')
const smoke = read('scripts/docker-smoke.mjs')

/** Text of one top-level job block (from `  <name>:` to the next 2-space-indented key). */
function jobBlock(name) {
  const m = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm'))
  return m ? m[0] : null
}

test('ci.yml has a docker job that depends on checks, runs on ubuntu-latest and is time-boxed', () => {
  const job = jobBlock('docker')
  assert.ok(job, 'jobs.docker must exist')
  assert.match(job, /^\s+needs:\s*checks\s*$/m)
  assert.match(job, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  const minutes = Number(job.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1])
  assert.ok(minutes >= 5 && minutes <= 20, `timeout-minutes must be 5-20, got ${minutes}`)
})

test('docker job builds linux/amd64 with the commit SHA injected and runs the smoke script; never pushes or logs in', () => {
  const job = jobBlock('docker').replace(/^\s*#.*$/gm, '') // comments may mention what is *not* done
  const flat = job.replace(/\\\n\s*/g, ' ')
  assert.match(flat, /docker build\b[^\n]*--platform linux\/amd64/)
  assert.match(flat, /docker build\b[^\n]*--build-arg "GML_BUILD_SHA=\$\{GITHUB_SHA\}"/)
  assert.match(job, /node scripts\/docker-smoke\.mjs --image "\$IMAGE" --expect-sha "\$GITHUB_SHA"/)
  assert.doesNotMatch(job, /docker\s+push|docker\s+login|docker\/login-action|--push\b|registry/i)
  assert.doesNotMatch(workflow, /^\s+packages:\s*write/m, 'workflow must not request package write permission')
})

test('every action in ci.yml is pinned to a full commit SHA with a version comment', () => {
  const uses = [...workflow.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)]
  assert.ok(uses.length >= 4, 'expected several uses: lines')
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, `action must be pinned by 40-hex SHA: ${ref}`)
    assert.match(rest, /#\s*v\d/, `pinned action should carry its version tag in a comment: ${ref}`)
  }
})

test('smoke script passes the random secret by environment name only and never prints it', () => {
  assert.match(smoke, /'-e',\s*'GML_JWT_SECRET',/, 'secret must be passed as `-e GML_JWT_SECRET` (no value in argv)')
  assert.doesNotMatch(smoke, /GML_JWT_SECRET=\$\{secret/, 'secret value must not be interpolated into an argument')
  assert.doesNotMatch(smoke, /\$\{secret\}/, 'secret must not be interpolated into any string')
  assert.doesNotMatch(smoke, /console\.(log|error|warn|info)\([^\n]*\bsecret\b(?!\))/, 'secret must not be printed')
  assert.doesNotMatch(smoke, /(stdout|stderr)\.write\(/, 'only console.log of fixed-format lines is allowed')
  assert.match(smoke, /function redact\(/)
  assert.match(smoke, /\{32,\}/, 'redaction must mask 32+ character opaque strings')
  assert.match(smoke, /randomBytes\(32\)\.toString\('hex'\)/, 'secret must be random, not a literal')
  // 公开已知值允许出现（它不是密钥），但不得有任何其他长字面量看起来像密钥
  const literals = [...smoke.matchAll(/'([A-Za-z0-9_-]{24,})'/g)].map(m => m[1])
  assert.deepEqual(literals.filter(v => v !== 'gml-demo-secret-change-me' && !/^JWT_SECRET_MISSING_IN_PRODUCTION$/.test(v)), [])
})

test('smoke script exercises the hardened run contract and cleans up in finally', () => {
  for (const flag of ['--read-only', '--cap-drop', 'no-new-privileges', '--tmpfs']) assert.ok(smoke.includes(`'${flag}'`), `missing ${flag}`)
  assert.match(smoke, /`127\.0\.0\.1:\$\{port\}:3001`/, 'port must be published on loopback only')
  assert.match(smoke, /`\$\{names\.volume\}:\/data`/, 'a named volume must back /data')
  assert.match(smoke, /JWT_SECRET_MISSING_IN_PRODUCTION/)
  assert.match(smoke, /\/api\/meta\/health/)
  assert.match(smoke, /\/mcp`/)
  assert.match(smoke, /=== 503/)
  assert.match(smoke, /EXPECTED_UID = '10001'/)
  assert.match(smoke, /touch \/app\//)
  assert.match(smoke, /\bfinally\s*\{\s*\n\s*cleanup\(\)/)
  assert.match(smoke, /\['rm', '-f', name\]/)
  assert.match(smoke, /\['volume', 'rm', '-f', names\.volume\]/)
  assert.match(smoke, /process\.exit\(failures \? 1 : 0\)/)
  assert.doesNotMatch(smoke, /shell:\s*true/, 'docker must be invoked without a shell')
  assert.doesNotMatch(smoke, /\bexecSync\b|\bexec\(/, 'no shell-string execution')
})

test('smoke script refuses to run without --image (usage exit 2) and needs no npm dependencies', () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts/docker-smoke.mjs')], { encoding: 'utf8', timeout: 20000 })
  assert.equal(r.status, 2)
  assert.match(r.stdout, /usage: node scripts\/docker-smoke\.mjs --image/)
  const imports = [...smoke.matchAll(/^import .* from '([^']+)'$/gm)].map(m => m[1])
  assert.ok(imports.length >= 4)
  for (const spec of imports) assert.match(spec, /^node:/, `only Node built-ins may be imported: ${spec}`)
})
