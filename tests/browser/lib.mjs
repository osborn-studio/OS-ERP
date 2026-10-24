/**
 * ============================================================================
 * 文件标识：tests/browser/lib.mjs ｜ 真实服务端浏览器场景的共用小工具
 * ============================================================================
 * 只服务 funds-review.mjs / scope-notice.mjs 这类"连真实 test 模式服务 + 真实前端构建"的场景：
 * 环境变量读取、Chromium 启动、同源 API 调用、随机账号、UI 登录、失败截图。
 * 约束：只允许回环源；账号密码全部随机生成、不打印；截图文件名不含账号/单号/令牌。
 * 它不替代服务端自己的测试，也不在 macOS 上运行（场景断言 linux）。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const required = (name) => {
  if (!process.env[name]) throw new Error(`${name} is required`)
  return process.env[name]
}

export const randomSuffix = () => randomBytes(4).toString('hex')
export const randomSecret = () => randomBytes(24).toString('base64url')

export function loopbackBase() {
  const base = new URL(required('GML_TEST_BASE_URL'))
  assert.equal(base.protocol, 'http:')
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(base.hostname), 'Only an isolated loopback test origin is allowed')
  assert.equal(process.platform, 'linux', 'Run browser acceptance on the assigned Linux host')
  return base
}

export async function launchBrowser() {
  const { chromium } = await import(pathToFileURL(required('GML_PLAYWRIGHT_MODULE')).href)
  return chromium.launch({
    executablePath: required('GML_CHROMIUM_EXECUTABLE'),
    chromiumSandbox: process.env.GML_CHROMIUM_SANDBOX !== '0',
    headless: true,
    env: { ...process.env, ...(process.env.GML_BROWSER_LD_LIBRARY_PATH ? { LD_LIBRARY_PATH: process.env.GML_BROWSER_LD_LIBRARY_PATH } : {}) }
  })
}

/** Same-origin JSON API helper. Returns { status, body } and never throws on HTTP errors. */
export function makeApi(base) {
  return async (route, { token, body, method = body === undefined ? 'GET' : 'POST' } = {}) => {
    const res = await fetch(new URL(route, base), {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000)
    })
    return { status: res.status, body: await res.json() }
  }
}

export const okData = (r) => {
  assert.equal(r.status, 200, `expected 200, got ${r.status} ${r.body?.error ?? r.body?.detail?.code ?? ''}`)
  return r.body.data
}

/** Business error code in either of the two envelope shapes the server uses. */
export const errorCode = (r) => r.body?.error ?? r.body?.detail?.code ?? r.body?.code

export async function apiLogin(api, username, password) {
  const r = await api('/api/auth/login', { body: { username, password, industry: 'cosmetic' } })
  const data = okData(r)
  return { token: data.token, user: data.user }
}

/** Creates a user through the admin API with a random password (never printed). */
export async function createAccount(api, adminToken, prefix, role, extra = {}) {
  const username = `${prefix}_${randomSuffix()}`
  const password = randomSecret()
  const r = await api('/api/auth/users', { token: adminToken, body: { username, name: username, role, password, ...extra } })
  const id = okData(r).id
  const { token } = await apiLogin(api, username, password)
  return { id, username, password, token }
}

/** Real login form on /login; resolves once the session is stored. */
export async function uiLogin(page, base, username, password) {
  await page.goto(new URL('/login', base).href)
  await page.getByPlaceholder('请输入账号').fill(username)
  await page.getByPlaceholder('请输入密码').fill(password)
  await page.getByRole('button', { name: '登 录', exact: true }).click()
  await page.waitForFunction(() => !!localStorage.getItem('gml_token'))
}

/** Non-identifying failure screenshots: failure-<scenario>-<n>.png. */
export async function screenshotPages(scenario, pages) {
  const dir = process.env.GML_BROWSER_SHOT_DIR
  if (!dir) return
  mkdirSync(dir, { recursive: true })
  let n = 0
  for (const page of pages) {
    n++
    try { await page.screenshot({ path: path.join(dir, `failure-${scenario}-${n}.png`), fullPage: true }) } catch { /* page already closed */ }
  }
}
