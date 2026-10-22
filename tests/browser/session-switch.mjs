/** Actual App/Brands/POS/Mall double-tab checks; synthetic intercepted HTTP only.
 * Called by session.mjs using its sandboxed Linux Chromium. No backend writes.
 */
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'

export async function runSessionSwitchChecks(browser, base) {
  const root = fileURLToPath(new URL('../../', import.meta.url))
  const { outputFiles } = await build({
    absWorkingDir: root, bundle: true, write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"test"' },
    stdin: { resolveDir: root, loader: 'tsx', contents: `
      import React from 'react'; import {createRoot} from 'react-dom/client';
      import {BrowserRouter} from 'react-router-dom'; import App from './src/App';
      import {AuthProvider} from './src/store/auth';
      import {RuntimeCapabilitiesProvider} from './src/store/runtime-capabilities';
      import * as client from './src/api/client'; window.__client=client;
      createRoot(document.getElementById('root')!).render(<BrowserRouter><AuthProvider>
        <RuntimeCapabilitiesProvider><App/></RuntimeCapabilitiesProvider>
      </AuthProvider></BrowserRouter>);
    ` }
  })
  const user = actor => ({ id: actor === 'A' ? 101 : 202, name: `User-${actor}`, role: 'store', permissions: [], orgScope: { scope: 'store' } })
  const product = actor => ({ sku_id: actor === 'A' ? 11 : 22, sku_code: `SKU-${actor}`, sku_name: `SKU-${actor}`, product_name: `Product-${actor}`, price_retail: 10, store_stock: 10 })
  const results = []
  const run = async (name, path, exercise, initialDelay) => {
    const context = await browser.newContext()
    context.setDefaultTimeout(10000)
    const pending = new Set()
    let initialArrived
    const initialReceived = new Promise(resolve => { initialArrived = resolve })
    let delay = initialDelay ? { ...initialDelay, arrived: initialArrived } : null, timer
    const writes = [], errors = []
    const counts = { brands: 0, context: 0, me: 0 }
    try {
      await context.addInitScript(({ initialUser }) => {
        if (localStorage.getItem('session-switch-fixture')) return
        localStorage.setItem('session-switch-fixture', 'initialized')
        localStorage.setItem('gml_token', 'fixture-A')
        localStorage.setItem('gml_user', JSON.stringify(initialUser))
        localStorage.setItem('gml_industry', 'cosmetic')
        localStorage.setItem('os_egp_session_generation', 'fixture-generation-A')
        localStorage.setItem('gml_mall_token', 'fixture-mall')
      }, { initialUser: user('A') })
      await context.route('**/*', async route => {
        const url = new URL(route.request().url())
        if (url.origin !== base.origin) return route.abort('blockedbyclient')
        if (!url.pathname.startsWith('/api')) return route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="root"></div>' })
        const actor = route.request().headers().authorization === 'Bearer fixture-B' ? 'B' : 'A'
        const send = data => route.fulfill({ json: { success: true, data } })
        if (delay?.path === url.pathname && actor === 'A') {
          const held = delay; delay = null
          return new Promise(resolve => {
            const release = async () => { pending.delete(release); await send(held.data); resolve() }
            pending.add(release); held.arrived(release)
          })
        }
        switch (url.pathname) {
          case '/api': return send({ runtime_mode: 'test', capabilities: Object.fromEntries(['public_mall', 'qimen_gateway', 'oms_simulation', 'im_connector', 'agent_access'].map(id => [id, { enabled: true }])) })
          case '/api/auth/industries': return send([{ code: 'cosmetic', label: '美妆连锁版', name: '美妆连锁' }])
          case '/api/auth/me': counts.me++; return send(user(actor))
          case '/api/auth/login': {
            const requested = route.request().postDataJSON().username
            assert.ok(['A', 'B'].includes(requested))
            return send({ token: `fixture-${requested}`, user: user(requested) })
          }
          case '/api/master/brands': counts.brands++; return send({ list: [{ id: 1, code: `BRAND-${actor}`, name: `Brand-${actor}`, status: 'active' }], total: 1 })
          case '/api/master/categories': return send({ list: [], total: 0 })
          case '/api/pos/context': counts.context++; return send({ store: { name: `Store-${actor}` }, warehouse: { name: `Warehouse-${actor}` }, local_orders: 0 })
          case '/api/pos/products': return send([product(actor)])
          case '/api/pos/quote': return send({ pay_amount: 10 })
          case '/api/pos/orders': writes.push({ actor, body: route.request().postDataJSON() }); return send({ id: 1, code: 'FIXTURE-ORDER', pay_amount: 10 })
          case '/api/mall/home': return send({ shop: { title: 'Fixture Mall' }, hot: [], news: [], categories: [] })
          case '/api/mall/cart': return send([])
          default: return route.abort('blockedbyclient')
        }
      })
      const open = async pathname => {
        const page = await context.newPage()
        page.on('pageerror', error => errors.push(error.message))
        await page.goto(new URL(pathname, base).href)
        await page.addScriptTag({ content: outputFiles[0].text })
        return page
      }
      const page = await open(path)
      const other = await open('/login')
      const login = async (actor = 'B') => {
        await other.getByPlaceholder('请输入账号', { exact: true }).fill(actor)
        await other.getByPlaceholder('请输入密码', { exact: true }).fill('synthetic-test-password')
        await other.getByRole('button', { name: '登 录', exact: true }).click()
        await other.getByText(`Store-${actor}`, { exact: true }).waitFor()
      }
      const hold = (pathname, data) => new Promise(resolve => { delay = { path: pathname, data, arrived: resolve } })
      await Promise.race([
        exercise({ page, other, login, hold, counts, writes, initialReceived }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Error(`Timed out: ${name}`)), 25000) })
      ])
      assert.deepEqual(errors, [], 'Actual application pages must not throw browser errors')
      results.push({ name, passed: true }); console.log(`PASS ${name}`)
    } finally {
      clearTimeout(timer)
      for (const release of pending) await release().catch(() => {})
      await context.close()
    }
  }

  await run('App: double-tab A→B replaces list/form state and ignores A delayed 200 response', '/master/brands', async ({ page, login, hold }) => {
    await page.getByText('Brand-A', { exact: true }).waitFor()
    const received = hold('/api/master/brands', { list: [{ id: 9, code: 'LATE-A', name: 'Late-Brand-A', status: 'active' }], total: 1 })
    await page.getByRole('button', { name: '刷新', exact: true }).first().click()
    const release = await received
    await page.getByRole('button', { name: '新增', exact: true }).first().click()
    await page.getByRole('heading', { name: '新增品牌管理', exact: true }).waitFor()
    await login()
    await page.getByText('Brand-B', { exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '新增品牌管理', exact: true }).count(), 0)
    const response = page.waitForResponse(r => r.url().includes('/api/master/brands'))
    await release(); await response
    await page.waitForTimeout(100) // Allow the released response's state callback to run.
    assert.equal(await page.getByText('Brand-B', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Late-Brand-A', { exact: true }).count(), 0)
    assert.equal(await page.getByText('Brand-A', { exact: true }).count(), 0)
  })

  await run('App/POS: account switch discards cart/member/discount and new order contains only B state', '/pos', async ({ page, login, writes }) => {
    await page.getByText('Store-A', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Product-A/ }).click()
    await page.getByPlaceholder('会员手机号（可享会员价）').fill('19900000001')
    await page.getByPlaceholder('0', { exact: true }).fill('3')
    await login()
    await page.getByText('Store-B', { exact: true }).waitFor()
    await page.getByRole('button', { name: /Product-B/ }).waitFor()
    assert.equal(await page.getByPlaceholder('会员手机号（可享会员价）').inputValue(), '')
    assert.equal(await page.getByPlaceholder('0', { exact: true }).inputValue(), '')
    assert.equal(await page.getByRole('button', { name: /^收款/ }).isDisabled(), true)
    assert.equal(await page.getByText('点击左侧商品加入购物车', { exact: true }).count(), 1)
    assert.equal(writes.length, 0)
    await page.getByRole('button', { name: /Product-B/ }).click()
    await page.getByRole('button', { name: /^收款/ }).click()
    await page.getByText('点击左侧商品加入购物车', { exact: true }).waitFor()
    assert.equal(writes.length, 1); assert.equal(writes[0].actor, 'B')
    assert.deepEqual(writes[0].body.items, [{ sku_id: 22, qty: 1 }])
    assert.equal(writes[0].body.member_phone, undefined); assert.equal(writes[0].body.discount_amount, 0)
  })

  await run('App/POS: same-token re-login generation resets cart and refreshes account context', '/pos', async ({ page, login }) => {
    await page.getByRole('button', { name: /Product-A/ }).click()
    await login('A')
    await page.getByText('点击左侧商品加入购物车', { exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: /^收款/ }).isDisabled(), true)
  })

  await run('App/POS: delayed old product results cannot populate the new account', '/pos', async ({ page, login, hold }) => {
    await page.getByRole('button', { name: /Product-A/ }).waitFor()
    const received = hold('/api/pos/products', [{ ...product('A'), product_name: 'Late-Product-A' }])
    await page.getByPlaceholder('扫码或输入商品名称 / 条码 / 编码').fill('old-search')
    const release = await received
    await login()
    await page.getByRole('button', { name: /Product-B/ }).waitFor()
    const response = page.waitForResponse(r => r.url().includes('/api/pos/products'))
    await release(); await response; await page.waitForTimeout(100)
    assert.equal(await page.getByRole('button', { name: /Product-B/ }).count(), 1)
    assert.equal(await page.getByText('Late-Product-A', { exact: true }).count(), 0)
    assert.equal(await page.getByPlaceholder('扫码或输入商品名称 / 条码 / 编码').inputValue(), '')
  })

  await run('App/POS: delayed A context cannot replace B store and warehouse', '/pos', async ({ page, login, initialReceived }) => {
    const release = await initialReceived
    await login()
    await page.getByText('Store-B', { exact: true }).waitFor()
    const response = page.waitForResponse(r => r.url().includes('/api/pos/context'))
    await release(); await response; await page.waitForTimeout(100)
    assert.equal(await page.getByText('Store-B', { exact: true }).count(), 1)
    assert.equal(await page.getByText('Late-Store-A', { exact: true }).count(), 0)
    assert.ok((await page.locator('header').textContent()).includes('Warehouse-B'))
  }, { path: '/api/pos/context', data: { store: { name: 'Late-Store-A' }, warehouse: { name: 'Late-Warehouse-A' } } })

  await run('App/Mall: backend account switch preserves independent mall UI and token', '/mall', async ({ page, login }) => {
    await page.getByText('Fixture Mall', { exact: true }).waitFor()
    await page.getByPlaceholder('搜索商品', { exact: true }).fill('mall-search-state')
    await login()
    assert.equal(await page.getByPlaceholder('搜索商品', { exact: true }).inputValue(), 'mall-search-state')
    assert.equal(await page.evaluate(() => localStorage.getItem('gml_mall_token')), 'fixture-mall')
  })

  await run('App/POS: mall session change does not reset backend cart', '/pos', async ({ page, other }) => {
    await page.getByRole('button', { name: /Product-A/ }).click()
    await other.evaluate(() => window.__client.setMallToken('fixture-other-mall'))
    await page.waitForFunction(() => localStorage.getItem('gml_mall_token') === 'fixture-other-mall')
    assert.equal(await page.getByRole('button', { name: /^收款/ }).isDisabled(), false)
    assert.equal(await page.getByText('共 1 件', { exact: true }).count(), 1)
  })
  return results
}
