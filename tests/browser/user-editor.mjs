/** Linux-only real Users/DataPage DOM event -> fetch contract verification.
 * Deterministic intercepted transport; does not claim backend persistence or
 * authorization acceptance. No application server/database/real credentials.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'

const required = name => { if (!process.env[name]) throw Error(`${name} is required`); return process.env[name] }
assert.equal(process.platform, 'linux', 'Run browser acceptance on the assigned Linux host')
const base = new URL(required('GML_TEST_BASE_URL'))
assert.equal(base.protocol, 'http:')
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only an isolated loopback test origin is allowed')
const { chromium } = await import(pathToFileURL(required('GML_PLAYWRIGHT_MODULE')).href)
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundled = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Users from './src/pages/system/Users'; import DataPage from './src/components/DataPage';
    import {ToastHost} from './src/components/ui';
    const root=createRoot(document.getElementById('root')!);
    window.__renderGeneric=()=>root.render(<><DataPage title="Generic" path="/generic-records" fields={[
      {key:'subject_id',label:'Generic subject',type:'select',options:[{value:17,label:'Subject'}]},
      {key:'password',label:'Generic password',type:'password'}
    ]}/><ToastHost/></>);
    root.render(<><Users/><ToastHost/></>);
  ` }
})
const browser = await chromium.launch({
  executablePath: required('GML_CHROMIUM_EXECUTABLE'), chromiumSandbox: true, headless: true,
  env: { ...process.env, ...(process.env.GML_BROWSER_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.GML_BROWSER_LD_LIBRARY_PATH } : {}) }
})
const results = []
async function scenario(name, fn) {
  const context = await browser.newContext()
  context.setDefaultTimeout(10000)
  const writes = [], errors = []
  let externalRequests = 0
  const row = { id: 7, username: 'editor_fixture', name: 'Editor fixture', role: 'viewer', status: 'active', dealer_id: 17, store_id: 29, dept: null, phone: null }
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    const respond = data => route.fulfill({ json: { success: true, data } })
    if (url.pathname === '/__user_editor_test__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>User editor verification</title></head><body><div id="root"></div></body></html>' })
    if (['POST', 'PUT'].includes(request.method()) && ['/api/auth/users', '/api/auth/users/7', '/api/generic-records'].includes(url.pathname)) {
      writes.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() })
      return respond({ id: 7 })
    }
    if (request.method() !== 'GET') return route.abort('blockedbyclient')
    if (url.pathname === '/api/meta/dict') return respond({ roles: { viewer: '只读访客', dealer: '经销商', store: '门店店长' } })
    if (url.pathname === '/api/master/options') return respond({ dealers: [{ value: 17, label: 'Fixture dealer' }], stores: [{ value: 29, label: 'Fixture store' }] })
    if (url.pathname === '/api/auth/org-tree') return respond({ tree: [{ id: 5, name: 'Fixture HQ', children: [{ id: 8, name: 'Fixture East', children: [] }] }], total: 2, scope: { scope: 'all' } })
    if (url.pathname === '/api/auth/users') return respond({ list: [row], total: 1 })
    if (url.pathname === '/api/generic-records') return respond({ list: [], total: 0 })
    return route.abort('blockedbyclient')
  })
  const page = await context.newPage()
  page.on('pageerror', error => errors.push(error.message))
  try {
    await page.goto(new URL('/__user_editor_test__', base).href)
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByRole('button', { name: '编辑', exact: true }).waitFor()
    const edit = async () => {
      await page.getByRole('button', { name: '编辑', exact: true }).click()
      await page.getByLabel(/^绑定经销商/).locator('option[value="17"]').waitFor({ state: 'attached' })
      await page.getByLabel(/^绑定门店/).locator('option[value="29"]').waitFor({ state: 'attached' })
    }
    const save = async () => {
      const received = page.waitForResponse(response => ['POST', 'PUT'].includes(response.request().method()))
      await page.getByRole('button', { name: '保存', exact: true }).click()
      assert.equal((await received).status(), 200)
      assert.equal(writes.length, 1)
      return writes[0]
    }
    await fn({ page, writes, edit, save })
    assert.deepEqual(errors, [], 'No React/browser runtime errors')
    assert.equal(externalRequests, 0)
    results.push({ name, passed: true }); console.log(`PASS ${name}`)
  } finally { await context.close() }
}
try {
  for (const [name, action, expected] of [
    ['name', async page => page.getByLabel(/^姓名/).fill('Renamed fixture'), { name: 'Renamed fixture' }],
    ['role', async page => page.getByLabel(/^角色/).selectOption('dealer'), { role: 'dealer' }],
    ['disable', async page => page.getByLabel(/^状态/).selectOption('inactive'), { status: 'inactive' }]
  ]) await scenario(`edit ${name} without touching password omits password`, async ({ page, edit, save }) => {
    await edit(); await action(page)
    const { body, method } = await save()
    assert.equal(method, 'PUT'); assert.equal(Object.hasOwn(body, 'password'), false)
    for (const [key, value] of Object.entries(expected)) assert.equal(body[key], value)
    assert.equal(body.dealer_id, 17); assert.equal(body.store_id, 29)
  })
  await scenario('new account selections submit numeric bindings through actual change events', async ({ page, save }) => {
    await page.getByRole('button', { name: '新增', exact: true }).click()
    await page.getByLabel(/^登录账号/).fill('new_fixture')
    await page.getByLabel(/^姓名/).fill('New fixture')
    await page.getByLabel(/^密码/).fill('synthetic-new-password-for-test')
    await page.getByLabel(/^角色/).selectOption('store')
    // Dealer binding is hidden unless the role/scope is dealer-related; reveal it through the dealer scope.
    assert.equal(await page.getByLabel(/^绑定经销商/).count(), 0)
    await page.getByLabel(/^数据范围/).selectOption('dealer')
    await page.getByLabel(/^绑定经销商/).selectOption('17')
    await page.getByLabel(/^绑定门店/).selectOption('29')
    const { body, method } = await save()
    assert.equal(method, 'POST'); assert.equal(body.dealer_id, 17); assert.equal(body.store_id, 29)
    assert.equal(body.role, 'store'); assert.equal(body.status, 'active')
    assert.equal(body.data_scope, 'dealer'); assert.equal(Object.hasOwn(body, 'org_id'), false)
    assert.equal(body.password, 'synthetic-new-password-for-test')
  })
  await scenario('editing selections and clearing a password still obey the Users contract', async ({ page, edit, save }) => {
    await edit()
    await page.getByLabel(/^绑定经销商/).selectOption('17')
    await page.getByLabel(/^绑定门店/).selectOption('29')
    await page.getByLabel(/^密码/).fill('temporary-fixture-text')
    await page.getByLabel(/^密码/).fill('')
    const { body } = await save()
    assert.equal(body.dealer_id, 17); assert.equal(body.store_id, 29)
    assert.equal(Object.hasOwn(body, 'password'), false)
  })
  await scenario('explicitly cleared binding controls submit null', async ({ page, edit, save }) => {
    await edit()
    await page.getByLabel(/^绑定经销商/).selectOption('')
    await page.getByLabel(/^绑定门店/).selectOption('')
    const { body } = await save()
    assert.equal(body.dealer_id, null); assert.equal(body.store_id, null)
  })
  await scenario('untouched org/scope controls are not sent and the session-revocation warning is shown', async ({ page, edit, save }) => {
    await edit()
    await page.getByTestId('revoke-warning').waitFor()
    assert.match(await page.getByTestId('revoke-warning').innerText(), /所有登录会话会立即失效/)
    const { body } = await save()
    assert.equal(Object.hasOwn(body, 'org_id'), false); assert.equal(Object.hasOwn(body, 'data_scope'), false)
    assert.equal(Object.hasOwn(body, 'last_login_at'), false); assert.equal(Object.hasOwn(body, 'username'), false)
  })
  await scenario('org tree and data scope selection send numeric org_id and exact scope string', async ({ page, edit, save }) => {
    await edit()
    await page.getByLabel(/^所属组织/).locator('option[value="8"]').waitFor({ state: 'attached' })
    await page.getByLabel(/^所属组织/).selectOption('8')
    await page.getByLabel(/^数据范围/).selectOption('subtree')
    assert.match(await page.getByTestId('scope-hint').innerText(), /本组织及下级/)
    const { body } = await save()
    assert.equal(body.org_id, 8); assert.equal(body.data_scope, 'subtree')
    assert.equal(body.dealer_id, 17); assert.equal(body.store_id, 29)
  })
  await scenario('clearing org and resetting scope to role default are explicit', async ({ page, edit, save }) => {
    await edit()
    await page.getByLabel(/^所属组织/).selectOption({ label: '（清除所属组织）' })
    await page.getByLabel(/^数据范围/).selectOption('role_default')
    const { body } = await save()
    assert.equal(body.org_id, null); assert.equal(body.data_scope, '')
  })
  await scenario('dealer scope without a dealer binding is blocked before fetch; binding fields follow role/scope', async ({ page, writes, edit }) => {
    await edit()
    await page.getByLabel(/^绑定经销商/).selectOption('')
    assert.equal(await page.getByLabel(/^绑定经销商/).count(), 0, 'hidden once empty and not dealer-related')
    await page.getByLabel(/^数据范围/).selectOption('dealer')
    assert.equal(await page.getByLabel(/^绑定经销商/).count(), 1)
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByText('数据范围为「仅本经销商」时必须绑定经销商', { exact: true }).waitFor()
    assert.equal(writes.length, 0)
  })
  await scenario('unknown injected option is blocked before fetch', async ({ page, writes, edit }) => {
    await edit()
    const select = page.getByLabel(/^绑定经销商/)
    await select.evaluate(element => element.add(new Option('Unknown fixture', '999')))
    await select.selectOption('999')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.getByText('请重新选择有效经销商', { exact: true }).waitFor()
    assert.equal(writes.length, 0)
  })
  await scenario('new password is retained when explicitly supplied during editing', async ({ page, edit, save }) => {
    await edit(); await page.getByLabel(/^密码/).fill('synthetic-reset-password-for-test')
    const { body } = await save()
    assert.equal(body.password, 'synthetic-reset-password-for-test')
  })
  await scenario('DataPage without a page contract retains its original serialization', async ({ page, save }) => {
    await page.evaluate(() => window.__renderGeneric())
    await page.getByRole('heading', { name: 'Generic', exact: true }).waitFor()
    await page.getByRole('button', { name: '新增', exact: true }).click()
    await page.getByRole('heading', { name: '新增Generic', exact: true }).waitFor()
    // Field wraps its select in a label, whose accessible text includes the
    // option labels. Match the exact field caption, then its own control.
    const subject = page.locator('label').filter({
      has: page.locator('span.label').filter({ hasText: /^Generic subject\s*$/ })
    }).locator('select')
    assert.equal(await subject.count(), 1)
    await subject.selectOption('17')
    const { body } = await save()
    assert.equal(body.subject_id, '17'); assert.equal(body.password, null)
  })
  const report = { suite: 'user-editor-browser', transport: 'intercepted fixtures; real Users/DataPage DOM interactions and API client', browser: browser.version(), sandbox: true, passed: results.length, results }
  if (process.env.GML_BROWSER_EVIDENCE) await writeFile(process.env.GML_BROWSER_EVIDENCE, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
} finally { await browser.close() }
