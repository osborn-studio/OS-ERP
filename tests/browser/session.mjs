/** Linux browser verification of real AuthProvider/client/session/dialog modules.
 * Transport is intercepted with deterministic fixtures. This does not claim real
 * backend revocation acceptance or complete Layout navigation coverage.
 * No listening server, database mutation, credentials, downloads or paid calls.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { writeFile } from 'node:fs/promises'
import { runSessionSwitchChecks } from './session-switch.mjs'

const required = name => { if (!process.env[name]) throw Error(`${name} is required`); return process.env[name] }
const base = new URL(required('GML_TEST_BASE_URL'))
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only an isolated loopback test origin is allowed')
assert.equal(base.protocol, 'http:')
assert.equal(process.platform, 'linux', 'Run browser acceptance on the assigned Linux host')
const { chromium } = await import(pathToFileURL(required('GML_PLAYWRIGHT_MODULE')).href)
const root = fileURLToPath(new URL('../../', import.meta.url))
const bundled = await build({
  absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"test"' },
  stdin: { resolveDir: root, loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {AuthProvider,useAuth} from './src/store/auth';
    import ChangePasswordDialog from './src/components/ChangePasswordDialog';
    import * as client from './src/api/client';
    import * as session from './src/store/session';
    Object.assign(window,{__client:client,__session:session});
    function Probe(){const a=useAuth();const [dialog,setDialog]=useState(false);return <>
      <output data-testid="state">{a.token?'active':'inactive'}:{a.user?.id||'none'}</output>
      <p data-testid="notice">{a.sessionNotice}</p>
      <button onClick={()=>void a.logout()}>退出全部会话</button>
      <button onClick={()=>setDialog(true)}>修改密码</button>
      {dialog&&<ChangePasswordDialog onClose={()=>setDialog(false)}/>}
    </>};
    createRoot(document.getElementById('root')!).render(<AuthProvider><Probe/></AuthProvider>);
  ` }
})
const browser = await chromium.launch({
  executablePath: required('GML_CHROMIUM_EXECUTABLE'), chromiumSandbox: true, headless: true,
  env: { ...process.env, ...(process.env.GML_BROWSER_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.GML_BROWSER_LD_LIBRARY_PATH } : {}) }
})
const results = []
try {
  const context = await browser.newContext()
  context.setDefaultTimeout(10000)
  let externalRequests = 0
  let handler
  let authMe = { id: 1, role: 'admin' }
  await context.route('**/*', async route => {
    const url = new URL(route.request().url())
    if (url.origin !== base.origin) { externalRequests++; return route.abort('blockedbyclient') }
    if (url.pathname === '/__session_browser_test__') return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><title>Session verification</title></head><body><div id="root"></div></body></html>' })
    if (url.pathname === '/api/auth/me') return route.fulfill({ json: { success: true, data: authMe } })
    if (handler) return handler(route, url)
    return route.abort('blockedbyclient')
  })
  const pages = [await context.newPage(), await context.newPage()]
  for (const page of pages) {
    await page.goto(new URL('/__session_browser_test__', base).href)
    await page.addScriptTag({ content: bundled.outputFiles[0].text })
    await page.getByTestId('state').waitFor()
  }
  const [page, other] = pages
  const reset = async () => {
    handler = undefined
    authMe = { id: 1, role: 'admin' }
    await page.evaluate(() => window.__client.setSession('synthetic-session-fixture', { id: 1, role: 'admin' }, 'cosmetic'))
    for (const p of pages) await p.waitForFunction(() => document.querySelector('[data-testid="state"]').textContent === 'active:1')
  }
  const inactive = async () => {
    for (const p of pages) await p.waitForFunction(() => document.querySelector('[data-testid="state"]').textContent === 'inactive:none')
  }
  const check = async (name, fn) => {
    let timer
    try {
      await Promise.race([
        (async () => { await reset(); await fn() })(),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${name}`)), 20000) })
      ])
      results.push({ name, passed: true }); console.log(`PASS ${name}`)
    } finally { clearTimeout(timer) }
  }
  const revoked = route => route.fulfill({ status: 401, json: { success: false, code: 'SESSION_REVOKED', detail: { reason: 'fixture' } } })

  await check('confirmed logout clears both mounted AuthProviders through native storage events', async () => {
    handler = route => route.fulfill({ json: { success: true, data: { revoked: true } } })
    await page.getByRole('button', { name: '退出全部会话', exact: true }).click()
    await inactive()
    assert.match(await other.getByTestId('notice').textContent(), /服务端已撤销/)
  })
  await check('offline logout clears both tabs and explicitly leaves remote revocation unconfirmed', async () => {
    handler = route => route.abort('failed')
    await page.getByRole('button', { name: '退出全部会话', exact: true }).click()
    await inactive()
    assert.match(await other.getByTestId('notice').textContent(), /未能确认服务端/)
  })
  await check('password dialog confirms server contract and clears both tabs without persisting passwords', async () => {
    handler = (route, url) => {
      assert.equal(url.pathname, '/api/auth/change-password')
      const body = route.request().postDataJSON()
      assert.equal(body.oldPassword, 'old-fixture-password')
      assert.equal(body.newPassword, 'new-fixture-password-1')
      return route.fulfill({ json: { success: true, data: { changed: true, reauthenticate: true } } })
    }
    await page.getByRole('button', { name: '修改密码', exact: true }).click()
    await page.getByLabel('当前密码', { exact: true }).fill('old-fixture-password')
    await page.getByLabel('新密码', { exact: true }).fill('new-fixture-password-1')
    await page.getByLabel('确认新密码', { exact: true }).fill('new-fixture-password-1')
    await page.getByRole('button', { name: '修改并重新登录', exact: true }).click()
    await inactive()
    assert.match(await other.getByTestId('notice').textContent(), /密码已修改/)
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('fixture-password')), false)
    assert.equal(await page.getByRole('dialog').count(), 0)
  })
  for (const method of ['get', 'download', 'rawPost']) {
    await check(`${method}: current 401 clears both tabs and preserves top-level business code`, async () => {
      handler = revoked
      const code = await page.evaluate(async method => {
        try { await window.__client.api[method]('/session-probe') } catch (e) { return e.code }
      }, method)
      assert.equal(code, 'SESSION_REVOKED'); await inactive()
    })
    await check(`${method}: delayed 401 cannot clear a new same-token generation in another tab`, async () => {
      let release, arrived
      const received = new Promise(resolve => { arrived = resolve })
      handler = route => new Promise(resolve => { release = async () => { await revoked(route); resolve() }; arrived() })
      const pending = page.evaluate(async method => {
        try { await window.__client.api[method]('/session-probe') } catch (e) { return e.status }
      }, method)
      await received
      authMe = { id: 2, role: 'viewer' }
      await other.evaluate(() => window.__client.setSession('synthetic-session-fixture', { id: 2, role: 'viewer' }, 'food'))
      await release(); assert.equal(await pending, 401)
      for (const p of pages) await p.waitForFunction(() => document.querySelector('[data-testid="state"]').textContent === 'active:2')
    })
  }
  await check('login failure preserves existing backend session and sends no old credential', async () => {
    handler = route => { assert.equal(route.request().headers().authorization, undefined); return revoked(route) }
    await page.evaluate(async () => { try { await window.__client.api.post('/auth/login', {}) } catch {} })
    assert.equal(await page.getByTestId('state').textContent(), 'active:1')
  })
  await check('mall failure has isolated headers and does not invalidate backend AuthProvider', async () => {
    await page.evaluate(() => window.__client.setMallToken('synthetic-mall-fixture'))
    handler = route => {
      assert.equal(route.request().headers().authorization, undefined)
      assert.equal(route.request().headers()['x-mall-token'], 'synthetic-mall-fixture')
      return revoked(route)
    }
    await page.evaluate(async () => { try { await window.__client.api.get('/mall/me') } catch {} })
    assert.equal(await page.getByTestId('state').textContent(), 'active:1')
    assert.equal(await page.evaluate(() => window.__client.getMallToken()), '')
  })
  await check('FEATURE_DISABLED refresh event fires once without retrying the write', async () => {
    let calls = 0
    await page.evaluate(() => { window.__features = 0; window.addEventListener('os-egp:feature-disabled', () => window.__features++) })
    handler = route => { calls++; return route.fulfill({ status: 503, json: { detail: { code: 'FEATURE_DISABLED', capability: 'agent_access' } } }) }
    await page.evaluate(async () => { try { await window.__client.api.post('/session-probe', {}) } catch {} })
    assert.equal(calls, 1); assert.equal(await page.evaluate(() => window.__features), 1)
  })
  await check('external URL rejection and redirect refusal prevent credential forwarding', async () => {
    let calls = 0
    handler = route => { calls++; return route.fulfill({ status: 302, headers: { location: 'https://external.invalid/never' } }) }
    const rejected = await page.evaluate(async () => {
      let count = 0
      for (const method of ['get', 'download', 'rawPost']) {
        try { await window.__client.api[method]('https://external.invalid/never') } catch { count++ }
      }
      try { await window.__client.api.get('/session-probe') } catch { count++ }
      return count
    })
    assert.equal(rejected, 4); assert.equal(calls, 1); assert.equal(externalRequests, 0)
  })
  await context.close()
  results.push(...await runSessionSwitchChecks(browser, base))
  const report = { suite: 'frontend-session-browser', transport: 'deterministic intercepted fixtures; actual React/client/App business pages', browser: browser.version(), sandbox: true, passed: results.length, results }
  if (process.env.GML_BROWSER_EVIDENCE) await writeFile(process.env.GML_BROWSER_EVIDENCE, JSON.stringify(report, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify(report))
} finally { await browser.close() }
