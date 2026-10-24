/**
 * ============================================================================
 * 文件标识：tests/browser-ci-policy.test.mjs ｜ CI browser job 与浏览器场景驱动的静态守卫
 * ============================================================================
 * 便宜、诚实的文本断言：证明 .github/workflows/ci.yml 有 browser job（依赖 checks、固定 Actions SHA、
 * Chromium 来自锁文件固定的 playwright、只上传白名单文件、不上传原始日志），证明 scripts/browser-ci.mjs 用随机密钥 +
 * 临时数据目录 + 回环端口、不回显原始输出，且 tests/browser 下的场景都被它登记。
 * 它们不证明浏览器场景能通过 —— 那是托管 runner 上 browser job 本身的事（本机 macOS 不能运行）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const read = (file) => readFileSync(path.join(ROOT, file), 'utf8')
const workflow = read('.github/workflows/ci.yml')
const driver = read('scripts/browser-ci.mjs')
const pkg = JSON.parse(read('package.json'))
const lock = JSON.parse(read('package-lock.json'))

function jobBlock(name) {
  const m = workflow.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  \\S|(?![\\s\\S]))`, 'm'))
  return m ? m[0] : null
}
const job = jobBlock('browser')
const jobNoComments = job?.replace(/^\s*#.*$/gm, '') ?? ''

test('browser job exists, depends on checks, runs on ubuntu-latest and is time-boxed to 25 minutes', () => {
  assert.ok(job, 'jobs.browser must exist')
  assert.match(job, /^\s+needs:\s*checks\s*$/m)
  assert.match(job, /^\s+runs-on:\s*ubuntu-latest\s*$/m)
  assert.equal(Number(job.match(/^\s+timeout-minutes:\s*(\d+)\s*$/m)?.[1]), 25)
})

test('browser job installs locked deps, Chromium from the pinned playwright, builds, then runs the driver', () => {
  assert.match(jobNoComments, /npm ci --ignore-scripts/)
  assert.match(jobNoComments, /npm rebuild better-sqlite3 esbuild/)
  assert.match(jobNoComments, /npx --no-install playwright install --with-deps chromium/)
  assert.doesNotMatch(jobNoComments, /npx\s+(?!--no-install)\S*playwright/, 'playwright must come from the lockfile, not an unpinned npx download')
  assert.doesNotMatch(jobNoComments, /@latest|playwright@/)
  const order = ['npm ci', 'playwright install', 'npm run build', 'node scripts/browser-ci.mjs'].map((s) => jobNoComments.indexOf(s))
  assert.ok(order.every((i) => i >= 0), 'all four steps present')
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'steps run in ci -> playwright install -> build -> driver order')
})

test('playwright is an exact-version devDependency whose lock entries carry integrity hashes', () => {
  assert.match(pkg.devDependencies.playwright, /^\d+\.\d+\.\d+$/, 'exact version, no range')
  assert.equal(pkg.dependencies?.playwright, undefined, 'must not ship in runtime dependencies')
  for (const name of ['playwright', 'playwright-core']) {
    const entry = lock.packages[`node_modules/${name}`]
    assert.ok(entry, `${name} must be locked`)
    assert.equal(entry.version, pkg.devDependencies.playwright)
    assert.equal(entry.dev, true)
    assert.match(entry.integrity, /^sha512-/)
  }
})

test('every action used by the browser job is pinned to a full commit SHA with a version comment', () => {
  const uses = [...job.matchAll(/^\s+-?\s*uses:\s*(\S+)(.*)$/gm)]
  assert.ok(uses.length >= 3)
  for (const [, ref, rest] of uses) {
    assert.match(ref, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/, ref)
    assert.match(rest, /#\s*v\d/, ref)
  }
})

test('browser job uploads only the allowlisted summary files and failure screenshots, never raw logs', () => {
  const upload = job.match(/uses:\s*actions\/upload-artifact@[\s\S]*$/)?.[0] ?? ''
  const paths = upload.match(/path:\s*\|\n((?:\s+\S.*\n?)+)/)?.[1].split('\n').map((l) => l.trim()).filter((l) => l && !/^[\w-]+:/.test(l))
  assert.deepEqual(paths, [
    'artifacts/browser-ci/summary.json',
    'artifacts/browser-ci/evidence-*.json',
    'artifacts/browser-ci/screenshots/failure-*.png'
  ])
  assert.doesNotMatch(upload, /\.log|node_modules|\.db|\.env|\*\*|\btmp\b/i)
  assert.equal([...job.matchAll(/upload-artifact@/g)].length, 1)
  assert.doesNotMatch(jobNoComments, /(?:^|\s)>+\s*\S*\.log|\btee\b/, 'the job must not write raw output to files')
  assert.doesNotMatch(workflow, /^\s+(packages|id-token):\s*write/m)
})

test('driver isolates the server (random secret, temp data dir, loopback random port, test mode) and never echoes raw output', () => {
  assert.match(driver, /randomBytes\(32\)\.toString\('hex'\)/)
  assert.match(driver, /mkdtempSync\(path\.join\(tmpdir\(\)/)
  assert.match(driver, /HOST: '127\.0\.0\.1'/)
  assert.match(driver, /listen\(0, '127\.0\.0\.1'\)/)
  assert.match(driver, /GML_RUNTIME_MODE: 'test'/)
  assert.match(driver, /GML_DATA_DIR: dataDir/)
  assert.match(driver, /rmSync\(dataDir, \{ recursive: true, force: true \}\)/)
  assert.doesNotMatch(driver, /stdio:\s*['"\[]?\s*['"]?inherit/, 'child output must be captured, not inherited')
  assert.doesNotMatch(driver, /process\.stdout\.write|process\.stderr\.write/)
  assert.match(driver, /\{32,\}/, 'long opaque strings are redacted')
  assert.doesNotMatch(driver, /GML_JWT_SECRET[^\n]*console|console[^\n]*GML_JWT_SECRET/)
  const literals = [...driver.matchAll(/'([A-Za-z0-9_-]{24,})'/g)].map((m) => m[1])
  assert.deepEqual(literals, [])
  assert.match(driver, /evidence-\$\{name\}\.json/, 'each scenario gets its own evidence file (wx writes would collide)')
  assert.match(driver, /process\.platform !== 'linux'/)
})

test('driver registers every scenario file under tests/browser and each one parses', () => {
  const declared = driver.match(/const SCENARIOS = \[([^\]]+)\]/)[1].split(',').map((s) => s.trim().replace(/'/g, ''))
  const helpers = new Set(['lib.mjs', 'session-switch.mjs', 'scenario-data.mjs'])
  const files = readdirSync(path.join(ROOT, 'tests/browser')).filter((f) => f.endsWith('.mjs') && !helpers.has(f)).map((f) => f.replace(/\.mjs$/, ''))
  assert.deepEqual([...declared].sort(), files.sort())
  for (const need of ['funds-review', 'scope-notice', 'my-scope', 'audit-logs', 'inventory-paging', 'approval-template-perm', 'pos-settle-perm', 'audit-fts-hint', 'dashboard-cache-stamp']) assert.ok(declared.includes(need), `${need} must be registered in SCENARIOS`)
  assert.equal(new Set(declared).size, declared.length, 'no scenario is registered twice')
  for (const f of readdirSync(path.join(ROOT, 'tests/browser')).filter((x) => x.endsWith('.mjs'))) {
    const r = spawnSync(process.execPath, ['--check', path.join(ROOT, 'tests/browser', f)], { encoding: 'utf8' })
    assert.equal(r.status, 0, `${f}: ${r.stderr}`)
  }
})

test('scenarios stay Linux/loopback-only, honour the sandbox switch, and the two new ones assert real outcomes', () => {
  for (const f of ['runtime-capabilities', 'session', 'user-editor']) {
    assert.match(read(`tests/browser/${f}.mjs`), /chromiumSandbox: process\.env\.GML_CHROMIUM_SANDBOX !== '0'/, f)
  }
  const lib = read('tests/browser/lib.mjs')
  assert.match(lib, /process\.platform, 'linux'/)
  assert.match(lib, /\['localhost', '127\.0\.0\.1', '\[::1\]'\]/)
  assert.match(lib, /failure-\$\{scenario\}-\$\{n\}\.png/, 'screenshot names carry no account, document or token')
  const funds = read('tests/browser/funds-review.mjs')
  for (const needle of ['FUNDS_EVIDENCE_REQUIRED', "'pending_review'", 'FUNDS_SELF_REVIEW', 'FUNDS_NOT_PENDING', "'confirmed'", "'approved'", 'credit-effect-panel', 'allocated()']) {
    assert.ok(funds.includes(needle), `funds-review must assert ${needle}`)
  }
  const scope = read('tests/browser/scope-notice.mjs')
  for (const needle of ["'empty_scope'", "'forbidden'", 'status, 403', 'overviewStatus, 403', 'overviewStatus, 200', 'count(), 0']) {
    assert.ok(scope.includes(needle), `scope-notice must assert ${needle}`)
  }
})

test('AA8 scenarios assert API outcomes and observable page results, not only text', () => {
  const myScope = read('tests/browser/my-scope.mjs')
  for (const needle of ["'/api/auth/my-scope'", 'expectOrgScoped', 'expectAdminScope', 'data.explanations', 'tr[data-current="true"]', 'status, 200']) {
    assert.ok(myScope.includes(needle), `my-scope must assert ${needle}`)
  }
  const audit = read('tests/browser/audit-logs.mjs')
  for (const needle of ["'content-type'", "'x-export-truncated'", 'waitForEvent(\'download\')', 'AUDIT_LOG_EXPORT', 'before + 1', 'detail.rows', "'forbidden'", '.status(), 403', 'records.every', 'requests, []']) {
    assert.ok(audit.includes(needle), `audit-logs must assert ${needle}`)
  }
  const paging = read('tests/browser/inventory-paging.mjs')
  for (const needle of ['assertExactlyOnce', "'total' in secondData, false", 'next_after_id', 'has_more', 'new Set([...page1, ...page2]).size', '上一页', '下一页']) {
    assert.ok(paging.includes(needle), `inventory-paging must assert ${needle}`)
  }
  const data = read('tests/browser/scenario-data.mjs')
  for (const needle of ["'total' in d, first", "'summary' in d, first", 'new Set(all).size, all.length']) {
    assert.ok(data.includes(needle), `scenario-data must assert ${needle}`)
  }
  assert.match(read('tests/browser-scenario-contracts.test.mjs'), /scenario-data\.mjs/)
})

test('AB9 permission scenarios assert both the hidden control and the server verdict, and stay on loopback', () => {
  const tpl = read('tests/browser/approval-template-perm.mjs')
  for (const needle of ['system:approval:template', "'/api/approval/templates'", '/toggle', 'status, 403', '.status(), 200', '新建模板', 'count(), 0', '模板已停用', '模板已启用', 'externalRequests', 'screenshotPages']) {
    assert.ok(tpl.includes(needle), `approval-template-perm must assert ${needle}`)
  }
  const pos = read('tests/browser/pos-settle-perm.mjs')
  for (const needle of ['pos.shift.settle', 'pos.refund', '责任人承担', '公司承担', '作废', 'settle-variance', '/void', 'has(perms, SETTLE) ? 1 : 0', 'has(perms, REFUND) ? 1 : 0', "handled: 'charge'", 'externalRequests', 'screenshotPages']) {
    assert.ok(pos.includes(needle), `pos-settle-perm must assert ${needle}`)
  }
  for (const f of ['approval-template-perm', 'pos-settle-perm']) {
    const src = read(`tests/browser/${f}.mjs`)
    assert.match(src, /from '\.\/lib\.mjs'/, `${f} uses the shared loopback/Linux helpers`)
    assert.doesNotMatch(src, /https?:\/\/(?!127\.0\.0\.1|localhost)/, `${f} must not hard-code external origins`)
    assert.doesNotMatch(src, /console\.log\([^)]*(password|token)/i, `${f} must not print credentials`)
  }
})

test('AC11 scenarios assert the hint modes, the disabled/blocked query, the server verdicts, the stamp arithmetic and the 403 absence', () => {
  const audit = read('tests/browser/audit-fts-hint.mjs')
  for (const needle of ['audit-fts-hint', 'audit-action-hint', "'too_short'", "'like'", "'fts'", 'AUDIT_ACTION_NEEDS_MODULE', 'data-needs-module', 'isDisabled()', 'sent, []', 'status, 400', 'data.total, direct.total', '.status(), 403', 'count(), 0', 'externalRequests']) {
    assert.ok(audit.includes(needle), `audit-fts-hint must assert ${needle}`)
  }
  const dash = read('tests/browser/dashboard-cache-stamp.mjs')
  for (const needle of ['数据截至', '缓存 30 s', 'cache_ttl_ms', 'cached_at', 'data-cached-at', 'dashboard-refresh', 'oldest(', 'must not move backwards', '/api/inventory/adjust', 'GLOBAL_DATA_FORBIDDEN', 'dashRequests, []', 'waitForURL', 'page.off(', 'count(), 0', 'externalRequests']) {
    assert.ok(dash.includes(needle), `dashboard-cache-stamp must assert ${needle}`)
  }
  for (const f of ['audit-fts-hint', 'dashboard-cache-stamp']) {
    const src = read(`tests/browser/${f}.mjs`)
    assert.match(src, /from '\.\/lib\.mjs'/, `${f} uses the shared loopback/Linux helpers`)
    assert.doesNotMatch(src, /https?:\/\/(?!127\.0\.0\.1|localhost)/, `${f} must not hard-code external origins`)
    assert.doesNotMatch(src, /console\.log\([^)]*(password|token)/i, `${f} must not print credentials`)
    assert.match(src, /blockedbyclient/, `${f} blocks non-loopback requests`)
  }
  // 页面侧的钩子必须存在，场景才有东西可断言
  const page = read('src/pages/Dashboard.tsx')
  assert.ok(page.includes('dashboard-cache-stamp') && page.includes('dashboard-refresh') && page.includes('selectCacheStamp') && page.includes('dashboard-refresh-failed'))
  const auditPage = read('src/pages/system/AuditLogs.tsx')
  assert.ok(auditPage.includes('audit-fts-hint') && auditPage.includes('audit-action-hint') && auditPage.includes('KEYWORD_HINTS'))
})

test('AD11 role-matrix scenario asserts the highlighted column, server-equal cells, the external-role none cell and zero external requests', () => {
  const src = read('tests/browser/role-matrix.mjs')
  for (const needle of ["'/api/meta/role-matrix'", 'thead th[data-current="true"]', 'data-access', 'data.cells.warehouse', 'data.cells.store.PO, \'none\'', "col.cells.VOUCHER, 'full'", 'role-matrix-me-store', 'role-matrix-filter', 'data.restricted', 'status, 200', 'externalRequests, 0', 'blockedbyclient', 'screenshotPages']) {
    assert.ok(src.includes(needle), `role-matrix must assert ${needle}`)
  }
  assert.match(src, /from '\.\/lib\.mjs'/, 'uses the shared loopback/Linux helpers')
  assert.doesNotMatch(src, /https?:\/\/(?!127\.0\.0\.1|localhost)/, 'must not hard-code external origins')
  assert.doesNotMatch(src, /console\.log\([^)]*(password|token)/i, 'must not print credentials')
  // 页面侧的钩子必须存在
  const page = read('src/pages/system/RoleMatrix.tsx')
  for (const hook of ['role-matrix-page', 'role-matrix-table', 'role-matrix-me-store', 'role-matrix-filter', 'role-matrix-legend', 'data-access', 'data-current']) assert.ok(page.includes(hook), `RoleMatrix.tsx must expose ${hook}`)
  assert.ok(read('src/App.tsx').includes('/system/role-matrix'))
})

test('driver gives every scenario a 5 minute kill timer and runs them in registration order (AA8 + AB9 included)', () => {
  assert.match(driver, /SCENARIO_TIMEOUT_MS = 5 \* 60 \* 1000/)
  assert.match(driver, /for \(const name of SCENARIOS\)/)
  assert.ok(Number(job.match(/timeout-minutes:\s*(\d+)/)[1]) >= 25, 'job budget covers several scenario budgets')
})

test('capacity-baseline has a hosted-runner section with the exact manual dispatch commands, without claiming a run', () => {
  const doc = read('docs/implementation/capacity-baseline.md')
  // 锚定到以「托管 runner」开头的小节标题（AB11 的 large-ci 小节标题里也含这四个字，不能用 `.*` 松匹配）
  const section = doc.match(/^## 托管 runner[\s\S]*?(?=^## |(?![\s\S]))/m)?.[0]
  assert.ok(section, '托管 runner section must exist')
  assert.match(section, /gh workflow run nightly-capacity\.yml -f rehearsal=true/)
  assert.match(section, /gh run (list|watch|view)/)
  assert.match(section, /待填|尚未/, 'placeholder table must say it is unfilled')
  assert.doesNotMatch(section, /\b\d{2,}(\.\d+)? ?ms\b/, 'no invented latency numbers')
})

test('ci.md documents the browser job and states the scenarios are unexecuted until hosted CI runs', () => {
  const doc = read('docs/implementation/ci.md')
  assert.match(doc, /`browser`/)
  assert.match(doc, /playwright/i)
  assert.match(doc, /尚未在托管 runner 上执行|未执行/)
})
