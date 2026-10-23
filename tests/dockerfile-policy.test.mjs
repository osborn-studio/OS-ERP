import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Static container policy: cheap, honest assertions about the build definition itself.
// They prove the Dockerfile/compose text follows the ADR-0012 rules; they do not prove an image was built.
const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = file => readFileSync(path.join(ROOT, file), 'utf8')
const dockerfile = read('Dockerfile')
const compose = read('docker-compose.yml')
const dockerignore = read('.dockerignore')
const lock = JSON.parse(read('package-lock.json'))

/** Instruction lines without comments and with backslash continuations joined. */
const lines = dockerfile
  .replace(/\\\r?\n/g, ' ')
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'))
const stages = []
for (const line of lines) {
  if (/^FROM\s/i.test(line)) stages.push({ from: line, body: [] })
  else if (stages.length) stages.at(-1).body.push(line)
}
const runtime = stages.at(-1)
const runtimeText = [runtime?.from, ...(runtime?.body ?? [])].join('\n')
const npmCommands = lines.filter(line => /^RUN\s/.test(line) && /\bnpm\s/.test(line))

test('Dockerfile is multi-stage and every stage starts from the digest-pinned base image', () => {
  assert.ok(stages.length >= 2, 'expected at least a build stage and a runtime stage')
  const argLine = lines.find(line => /^ARG\s+NODE_IMAGE=/.test(line))
  assert.ok(argLine, 'base image must be declared once as ARG NODE_IMAGE')
  assert.match(argLine, /^ARG\s+NODE_IMAGE=node:22-bookworm-slim@sha256:[0-9a-f]{64}$/)
  for (const stage of stages) assert.match(stage.from, /^FROM\s+\$\{NODE_IMAGE\}(\s+AS\s+\S+)?$/i)
})

test('runtime stage runs as a non-root user after the last file copy', () => {
  const userIndex = runtime.body.findIndex(line => /^USER\s/.test(line))
  assert.ok(userIndex >= 0, 'runtime stage must declare USER')
  const user = runtime.body[userIndex].replace(/^USER\s+/, '').trim()
  assert.notEqual(user, 'root')
  assert.notEqual(user, '0')
  assert.ok(!/^0:/.test(user))
  const lastCopy = runtime.body.reduce((last, line, i) => (/^(COPY|ADD)\s/.test(line) ? i : last), -1)
  assert.ok(lastCopy < userIndex, 'USER must come after the last COPY so files are not written as the service user')
  const cmdIndex = runtime.body.findIndex(line => /^(CMD|ENTRYPOINT)\s/.test(line))
  assert.ok(cmdIndex > userIndex, 'process must start after USER switch')
})

test('dependency installs use the lockfile and the runtime image carries no dev dependencies', () => {
  assert.ok(npmCommands.length >= 2, 'expected a build install and a production install')
  for (const line of npmCommands) {
    assert.doesNotMatch(line, /\bnpm\s+(install|i|add)\b/, `lockfile bypass: ${line}`)
    if (/\bnpm\s+ci\b/.test(line)) assert.match(line, /--ignore-scripts/, `lifecycle scripts must be opted in explicitly: ${line}`)
  }
  assert.ok(lines.some(line => /^COPY\s.*package-lock\.json/.test(line)), 'package-lock.json must be copied before npm ci')
  assert.ok(npmCommands.some(line => /\bnpm\s+ci\b.*--omit=dev/.test(line)), 'a production-only install is required')
  assert.doesNotMatch(dockerfile, /--include=dev/)
  assert.doesNotMatch(runtimeText, /\bnpm\s+ci\b(?!.*--omit=dev)/, 'runtime stage must not install dev dependencies')
  assert.doesNotMatch(runtimeText, /COPY\s+--from=build\b[^\n]*node_modules/, 'runtime stage must not copy the build stage node_modules')
  assert.doesNotMatch(runtimeText, /COPY\s+[^\n]*\s\.\s+\.\s*$/m, 'runtime stage must not copy the whole context')
})

test('runtime stage declares the production contract: mode, data volume, health check, exposed port, no baked secret', () => {
  assert.match(runtimeText, /GML_RUNTIME_MODE=production/)
  assert.match(runtimeText, /GML_DATA_DIR=\/data/)
  assert.match(runtimeText, /^VOLUME\s+\[\s*"\/data"\s*\]$/m)
  assert.match(runtimeText, /^EXPOSE\s+\d+$/m)
  assert.match(runtimeText, /^HEALTHCHECK\s[^\n]*\/api\/meta\/health/m)
  assert.doesNotMatch(dockerfile, /GML_JWT_SECRET\s*=\s*\S/, 'no JWT secret may be baked into the image')
  assert.doesNotMatch(dockerfile, /JWT_SECRET\s*=\s*['"]?[A-Za-z0-9]{8,}/)
})

test('compose publishes to loopback only, mounts a named data volume and keeps secrets out of the file', () => {
  const published = [...compose.matchAll(/^\s*-\s*"?([^"\n]+:\d+(?:\/\w+)?)"?\s*$/gm)]
    .map(m => m[1])
    .filter(spec => /^\S+:\d+(?::\d+)?/.test(spec) && !spec.includes('/data'))
  assert.ok(published.length >= 1, 'expected at least one published port')
  for (const spec of published) assert.match(spec, /^127\.0\.0\.1:\d+:\d+(\/\w+)?$/, `must bind loopback only: ${spec}`)
  assert.match(compose, /^\s*read_only:\s*true\s*$/m)
  assert.match(compose, /^\s*-\s*no-new-privileges:true\s*$/m)
  assert.match(compose, /^\s*cap_drop:\s*$/m)
  assert.match(compose, /^\s*-\s*os-erp-data:\/data\s*$/m)
  assert.match(compose, /^volumes:\s*\n\s+os-erp-data:/m)
  assert.match(compose, /GML_JWT_SECRET:\s*\$\{GML_JWT_SECRET:\?/, 'secret must be required from the environment, not defaulted')
  assert.doesNotMatch(compose, /GML_JWT_SECRET:\s*['"]?[A-Za-z0-9]{8,}/, 'no literal secret value in compose')
  assert.doesNotMatch(compose, /:-[A-Za-z0-9]{8,}\}/, 'no default secret value in interpolation')
})

test('.env.example documents the required variables without real values', () => {
  const example = read('.env.example')
  assert.match(example, /^GML_JWT_SECRET=\s*$/m)
  assert.doesNotMatch(example, /^GML_JWT_SECRET=\S/m)
  assert.match(example, /GML_BUILD_SHA=/)
})

test('.dockerignore keeps tests, documentation, evidence, artifacts and local state out of the build context', () => {
  const entries = new Set(dockerignore.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#')))
  for (const required of ['node_modules', '.git', '.github', 'data', 'tests', 'docs', 'artifacts', 'deliverables', 'test-evidence', '.local', 'backups', 'release', '.env', '.env.*', '*.md', '*.db']) {
    assert.ok(entries.has(required), `.dockerignore must list ${required}`)
  }
  assert.ok(!entries.has('public') && !entries.has('public/docs'), 'public/docs is served at runtime and must stay in the context')
})

test('the known unfixed braces advisory chain is development-only and therefore absent from the runtime install', () => {
  for (const name of ['braces', 'chokidar', 'micromatch', 'fast-glob', 'tailwindcss']) {
    const entry = lock.packages[`node_modules/${name}`]
    assert.ok(entry, `${name} is expected in the lockfile`)
    assert.equal(entry.dev, true, `${name} must be dev-only so npm ci --omit=dev excludes it`)
  }
  const runtimeNames = Object.keys(JSON.parse(read('package.json')).dependencies)
  assert.ok(!runtimeNames.includes('tailwindcss') && !runtimeNames.includes('braces'))
})
