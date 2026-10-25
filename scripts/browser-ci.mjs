/**
 * ============================================================================
 * 文件标识：scripts/browser-ci.mjs ｜ 托管 CI 浏览器场景驱动（Linux 专用）
 * ============================================================================
 * 做什么：在全新临时数据目录 + 随机回环端口 + 随机 JWT 密钥下启动 `server/index.js`（test 模式，演示种子），
 *   用已安装的 Playwright Chromium 依次运行 tests/browser 下的场景，最后写一份白名单摘要。
 * 约束：
 *   · 只在 Linux 运行（场景自己也断言）；需要先 `npm ci`、`npx playwright install chromium`、`npm run build`。
 *   · 场景与服务端的原始输出不外泄：只打印 `PASS ...` 行与阶段结果；失败时打印脱敏尾部（32 位以上不透明串打码）。
 *   · 产物只有 <out>/summary.json、<out>/evidence-<场景>.json（场景名与浏览器版本，每个场景各自一份，避免 wx 写入冲突）和 <out>/screenshots/failure-*.png。
 *   · 先探测 Chromium 沙箱：可用则保持开启；托管 runner 的内核策略禁止非特权 userns 时才退到 GML_CHROMIUM_SANDBOX=0，
 *     并在摘要里如实记录 sandbox 取值。回退只发生在一次性 runner 上，场景只访问本机回环源并拦截外部请求。
 * 不声明：这是源码级浏览器场景证据，不是发行包或生产验收。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCENARIOS = ['runtime-capabilities', 'session', 'user-editor', 'funds-review', 'scope-notice', 'my-scope', 'audit-logs', 'inventory-paging', 'approval-template-perm', 'pos-settle-perm', 'audit-fts-hint', 'dashboard-cache-stamp', 'role-matrix', 'audit-fts-state', 'mcp-token-limits', 'metrics-hidden-note', 'metrics-scoped-real', 'mcp-token-429', 'audit-fts-fallback', 'inactive-role-notice', 'audit-anchor-intents', 'backup-report-card']
const SCENARIO_TIMEOUT_MS = 5 * 60 * 1000
const redact = (text) => text.replace(/[A-Za-z0-9_.-]{32,}/g, '[REDACTED]')
const tail = (text, n) => text.split('\n').slice(-n).join('\n')

const outArg = process.argv.find((a) => a.startsWith('--out='))?.slice(6) || 'artifacts/browser-ci'
const outDir = path.resolve(ROOT, outArg)
if (path.relative(ROOT, outDir).startsWith('..')) throw new Error('--out must stay inside the repository checkout')

if (process.platform !== 'linux') {
  console.error('browser-ci: Linux only (macOS/Windows runs are not browser acceptance)')
  process.exit(2)
}
const playwrightModule = path.join(ROOT, 'node_modules/playwright-core/index.mjs')
if (!existsSync(playwrightModule)) { console.error('browser-ci: playwright-core is not installed (run npm ci)'); process.exit(2) }
if (!existsSync(path.join(ROOT, 'dist/index.html'))) { console.error('browser-ci: dist/ is missing (run npm run build)'); process.exit(2) }
const { chromium } = await import(pathToFileURL(playwrightModule).href)
const chromiumExecutable = chromium.executablePath()
if (!existsSync(chromiumExecutable)) { console.error('browser-ci: Chromium is not installed (run npx playwright install chromium)'); process.exit(2) }

mkdirSync(path.join(outDir, 'screenshots'), { recursive: true })

async function probeBrowser() {
  for (const sandbox of [true, false]) {
    let browser
    try {
      browser = await chromium.launch({ executablePath: chromiumExecutable, chromiumSandbox: sandbox, headless: true })
      return { sandbox, version: browser.version() }
    } catch (error) {
      console.log(`browser-ci: chromium launch with sandbox=${sandbox} failed (${redact(String(error.message).split('\n')[0])})`)
    } finally { await browser?.close() }
  }
  throw new Error('Chromium cannot be launched on this runner')
}

async function freePort() {
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const { port } = probe.address()
  await new Promise((resolve) => probe.close(resolve))
  return port
}

const dataDir = mkdtempSync(path.join(tmpdir(), 'os-erp-browser-ci-'))
let server
let serverOutput = ''
const results = []
let browserInfo = { sandbox: null, version: null }
let fatal = null

try {
  browserInfo = await probeBrowser()
  console.log(`browser-ci: chromium ${browserInfo.version}, sandbox=${browserInfo.sandbox}`)
  const port = await freePort()
  server = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      PATH: process.env.PATH, HOME: dataDir, TMPDIR: dataDir, HOST: '127.0.0.1', PORT: String(port),
      GML_RUNTIME_MODE: 'test', GML_DATA_DIR: dataDir, GML_DB: '', GML_JWT_SECRET: randomBytes(32).toString('hex'),
      // 所有场景共用一个服务进程，且全部来自 127.0.0.1：默认每 IP 每分钟 60 次登录（ADR-0005，成功也计数、不退还）
      // 在十几个场景连跑时会被耗尽，后面的场景登录得到 429 而不是页面缺陷。按账号的限额保持默认。
      GML_LOGIN_IP_LIMIT: '10000'
    }
  })
  server.stdout.on('data', (d) => { serverOutput += d })
  server.stderr.on('data', (d) => { serverOutput += d })
  for (let i = 0; i < 2400 && !serverOutput.includes('服务已启动') && server.exitCode === null; i++) await delay(50)
  if (!serverOutput.includes('服务已启动')) throw new Error('test-mode server did not become ready')
  const base = `http://127.0.0.1:${port}`
  console.log('browser-ci: test-mode server ready on a random loopback port')

  const scenarioEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME, CI: process.env.CI,
    ...(process.env.PLAYWRIGHT_BROWSERS_PATH ? { PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH } : {}),
    GML_TEST_BASE_URL: base, GML_TEST_DATA_DIR: dataDir, GML_PLAYWRIGHT_MODULE: playwrightModule, GML_CHROMIUM_EXECUTABLE: chromiumExecutable,
    GML_CHROMIUM_SANDBOX: browserInfo.sandbox ? '1' : '0', GML_BROWSER_SHOT_DIR: path.join(outDir, 'screenshots')
  }
  for (const name of SCENARIOS) {
    const started = Date.now()
    const child = spawn(process.execPath, [`tests/browser/${name}.mjs`], { cwd: ROOT, env: { ...scenarioEnv, GML_BROWSER_EVIDENCE: path.join(outDir, `evidence-${name}.json`) }, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    const collect = (d) => { if (output.length < 1_000_000) output += d }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    const timer = setTimeout(() => child.kill('SIGKILL'), SCENARIO_TIMEOUT_MS)
    const [code, signal] = await once(child, 'close')
    clearTimeout(timer)
    const passLines = output.split('\n').filter((l) => /^PASS /.test(l))
    for (const line of passLines) console.log(redact(line))
    const ok = code === 0
    results.push({ name, result: ok ? 'passed' : 'failed', pass_lines: passLines.length, duration_ms: Date.now() - started })
    console.log(`browser-ci: ${name} ${ok ? 'passed' : `FAILED (exit ${code ?? signal})`}`)
    if (!ok) {
      console.log('::group::Failure diagnostics (tail, long opaque strings redacted)')
      console.log(redact(tail(output.trim(), 40)))
      console.log('::endgroup::')
      // 场景失败时服务端最近的日志行同样有用（例如 429 / 500 的来源）；同样只打印脱敏尾部
      console.log('::group::Server output tail at failure (redacted)')
      console.log(redact(tail(serverOutput.trim(), 30)))
      console.log('::endgroup::')
    }
  }
} catch (error) {
  fatal = redact(String(error.message || error).split('\n')[0])
  console.log(`browser-ci: ${fatal}`)
  if (serverOutput) {
    console.log('::group::Server output tail (redacted)')
    console.log(redact(tail(serverOutput.trim(), 40)))
    console.log('::endgroup::')
  }
} finally {
  if (server && server.exitCode === null) {
    const closed = once(server, 'close')
    server.kill('SIGTERM')
    await Promise.race([closed, delay(5000)])
    if (server.exitCode === null) server.kill('SIGKILL')
  }
  rmSync(dataDir, { recursive: true, force: true })
}

const allPassed = !fatal && results.length === SCENARIOS.length && results.every((r) => r.result === 'passed')
const summary = {
  schema_version: 1,
  repository: process.env.GITHUB_REPOSITORY ?? null,
  commit: /^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : null,
  platform: process.platform,
  node: process.version,
  chromium: browserInfo.version,
  sandbox: browserInfo.sandbox,
  scenarios: results,
  expected_scenarios: SCENARIOS,
  result: allPassed ? 'passed' : 'failed',
  error: fatal,
  evidence_scope: 'GitHub-hosted source-level browser scenarios against a test-mode server; not release-package acceptance or production readiness'
}
writeFileSync(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n')
console.log(`browser-ci: ${summary.result} (${results.filter((r) => r.result === 'passed').length}/${SCENARIOS.length} scenarios)`)
process.exit(allPassed ? 0 : 1)
