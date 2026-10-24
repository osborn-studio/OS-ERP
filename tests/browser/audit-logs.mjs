/**
 * ============================================================================
 * 文件标识：tests/browser/audit-logs.mjs ｜ 审计日志查看器（Z7）真实浏览器场景
 * ============================================================================
 * 连真实 test 模式服务 + 真实前端构建，页面是 /system/audit-logs：
 *   · admin 按模块过滤：先经真实库存调整写入 inventory 模块的审计行，页面输入模块"inventory"并点"查询"，
 *     列表接口带 module=inventory 返回 200，响应里的 total 等于直接调接口的 total，页面的每一行"模块"列都是 inventory，
 *     行数 = min(total, 50)，且该模块之外的行（auth 登录）不再出现；
 *   · admin 点"导出 CSV"：浏览器真的发出 export.csv 请求并触发下载；响应 200、text/csv、附件文件名、X-Export-Truncated=0；
 *     下载到的文件表头与服务端列一致、每条记录都是 inventory 模块、条数等于过滤总数、不含导出自己的审计行；
 *     随后审计里恰好多出一条 module=audit/action=AUDIT_LOG_EXPORT 的行，其 detail 记录了同一过滤与同一行数；
 *   · 非 admin（role=purchase）：接口 403；页面出现阻断的 forbidden 提示（role=alert），没有导出按钮、没有表格，
 *     且浏览器没有发出过 export.csv 请求。
 * 账号密码随机，不打印。接口数据期望在 scenario-data.mjs，由 tests/browser-scenario-contracts.test.mjs 在本机验证；
 * 浏览器部分只在 Linux 托管 CI 运行，未执行前不得称"浏览器场景已通过"。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { apiLogin, createAccount, launchBrowser, loopbackBase, makeApi, okData, screenshotPages, uiLogin } from './lib.mjs'
import { AUDIT_CSV_HEADER, auditIds, csvRecords, exportAuditRows, fetchAuditCsv, prepareAuditModule } from './scenario-data.mjs'

const base = loopbackBase()
const api = makeApi(base)
const browser = await launchBrowser()
const pages = []
const results = []
const step = async (name, fn) => { await fn(); results.push(name); console.log(`PASS ${name}`) }
const isAuditList = (r) => new URL(r.url()).pathname === '/api/meta/audit-logs'
const isExport = (r) => new URL(r.url()).pathname === '/api/meta/audit-logs/export.csv'

async function newPage(actor) {
  const ctx = await browser.newContext({ acceptDownloads: true })
  ctx.setDefaultTimeout(15000)
  const page = await ctx.newPage()
  pages.push(page)
  const errors = []
  page.on('pageerror', (e) => errors.push(e.message))
  await uiLogin(page, base, actor.username, actor.password)
  return { page, errors }
}

try {
  const adminToken = (await apiLogin(api, 'admin', '12345')).token
  const prep = await prepareAuditModule(api, adminToken)

  await step('admin filters by module: list API is 200 and every shown row belongs to that module', async () => {
    const { page, errors } = await newPage({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    // 先等无过滤的第一屏，证明过滤前确有其它模块的行（过滤是可观察的）
    await page.locator('tbody tr td:nth-child(3)').first().waitFor()
    const before = await page.locator('tbody tr td:nth-child(3)').allInnerTexts()
    assert.ok(before.some((m) => m.trim() !== prep.module), 'unfiltered page must show rows from other modules')

    await page.getByPlaceholder('模块（如 sales）').fill(prep.module)
    const filteredList = page.waitForResponse((r) => isAuditList(r) && new URL(r.url()).searchParams.get('module') === prep.module && new URL(r.url()).searchParams.get('pageSize') === '50')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    const res = await filteredList
    assert.equal(res.status(), 200)
    const data = (await res.json()).data
    const direct = okData(await api(`/api/meta/audit-logs?module=${prep.module}&page=1&pageSize=50`, { token: adminToken }))
    assert.equal(data.total, direct.total)
    assert.ok(data.total >= 1)
    assert.ok(data.list.every((r) => r.module === prep.module))

    const expectedRows = Math.min(data.total, 50)
    await page.waitForFunction(({ n, mod }) => {
      const cells = [...document.querySelectorAll('tbody tr td:nth-child(3)')].map((td) => td.textContent.trim())
      return cells.length === n && cells.every((c) => c === mod)
    }, { n: expectedRows, mod: prep.module })
    const shown = await page.locator('tbody tr td:nth-child(3)').allInnerTexts()
    assert.equal(shown.length, expectedRows)
    assert.ok(shown.every((m) => m.trim() === prep.module))
    assert.deepEqual(errors, [])
  })

  await step('admin exports CSV: download fires, file matches the filter, and the export itself is audited', async () => {
    const { page, errors } = await newPage({ username: 'admin', password: '12345' })
    await page.goto(new URL('/system/audit-logs', base).href)
    await page.getByRole('heading', { name: '审计日志' }).waitFor()
    await page.getByPlaceholder('模块（如 sales）').fill(prep.module)
    const filtered = page.waitForResponse((r) => isAuditList(r) && new URL(r.url()).searchParams.get('module') === prep.module && new URL(r.url()).searchParams.get('pageSize') === '50')
    await page.getByRole('button', { name: '查询', exact: true }).click()
    await filtered

    const before = (await exportAuditRows(api, adminToken)).total
    const expectedIds = await auditIds(api, adminToken, { module: prep.module })
    const exportResponse = page.waitForResponse(isExport)
    const downloadEvent = page.waitForEvent('download')
    await page.getByRole('button', { name: '导出 CSV' }).click()
    const res = await exportResponse
    assert.equal(new URL(res.url()).searchParams.get('module'), prep.module, 'export must carry the active filter')
    assert.equal(res.status(), 200)
    const headers = res.headers()
    assert.match(headers['content-type'], /^text\/csv/)
    assert.match(headers['content-disposition'], /^attachment; filename="audit-logs-\d+\.csv"$/)
    assert.equal(headers['x-export-truncated'], '0')

    const download = await downloadEvent
    assert.match(download.suggestedFilename(), /^audit-logs-\d+\.csv$/)
    const file = await download.path()
    assert.ok(file, 'the download must be saved')
    const { header, records } = csvRecords(readFileSync(file, 'utf8'))
    assert.deepEqual(header, AUDIT_CSV_HEADER)
    assert.ok(records.length >= 1)
    const exportedIds = records.map((r) => Number(r.id))
    assert.equal(new Set(exportedIds).size, exportedIds.length, 'no audit row may be exported twice')
    assert.deepEqual([...exportedIds].sort((a, b) => a - b), [...expectedIds.ids].sort((a, b) => a - b), 'the file holds exactly the filtered audit rows')
    assert.ok(records.every((r) => r.module === prep.module), 'every exported row must match the module filter')
    assert.ok(!records.some((r) => r.action === 'AUDIT_LOG_EXPORT'))

    const after = await exportAuditRows(api, adminToken)
    assert.equal(after.total, before + 1, 'exactly one export audit row must be written')
    const detail = JSON.parse(after.list[0].detail)
    assert.equal(after.list[0].action, 'AUDIT_LOG_EXPORT')
    assert.equal(detail.filters.module, prep.module)
    assert.equal(detail.rows, records.length)
    assert.equal(detail.truncated, false)
    // 快照排除：对"包含导出审计行"的过滤再导出一次，文件里有上一次导出的行、但没有这一次自己的行
    const audited = await exportAuditRows(api, adminToken)
    const second = await fetchAuditCsv(base, adminToken, 'module=audit&action=AUDIT_LOG_EXPORT')
    assert.equal(second.status, 200)
    assert.equal(second.records.length, audited.total, 'an export must not contain its own audit row')
    assert.ok(second.records.some((r) => r.id === String(after.list[0].id)), 'the previous export row is present')
    assert.deepEqual(errors, [])
  })

  await step('non-admin: APIs are 403 and the page shows the blocking forbidden notice with no export control', async () => {
    const plain = await createAccount(api, adminToken, 'al_plain', 'purchase')
    assert.equal((await api('/api/meta/audit-logs?page=1&pageSize=50', { token: plain.token })).status, 403)
    const exportsBefore = (await exportAuditRows(api, adminToken)).total
    const { page, errors } = await newPage(plain)
    const requests = []
    page.on('request', (r) => { if (isExport(r)) requests.push(r.url()) })
    const listed = page.waitForResponse(isAuditList)
    await page.goto(new URL('/system/audit-logs', base).href)
    assert.equal((await listed).status(), 403)
    const notice = page.getByTestId('scope-notice')
    await notice.waitFor()
    assert.equal(await notice.getAttribute('data-kind'), 'forbidden')
    assert.equal(await notice.getAttribute('role'), 'alert')
    assert.match(await notice.innerText(), /没有访问权限/)
    assert.equal(await page.getByRole('button', { name: '导出 CSV' }).count(), 0)
    assert.equal(await page.getByRole('columnheader', { name: '操作人' }).count(), 0, '403 must not render the data table')
    assert.equal(await page.locator('[data-kind="empty_scope"]').count(), 0)
    assert.deepEqual(requests, [])
    assert.equal((await exportAuditRows(api, adminToken)).total, exportsBefore, 'no export audit row for a refused user')
    assert.deepEqual(errors, [])
  })

  console.log(JSON.stringify({ suite: 'audit-logs-browser', passed: results.length, results }))
} catch (error) {
  await screenshotPages('audit-logs', pages)
  throw error
} finally {
  await browser.close()
}
