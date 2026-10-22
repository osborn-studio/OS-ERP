/**
 * ============================================================================
 * 文件标识：scripts/shot-costing.mjs ｜ 模块 09 界面截图（headless Chrome + CDP，零额外依赖）
 * ============================================================================
 * 【职责】模块 09 界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 模块 09 界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 为什么要手写 CDP 客户端：项目里没有装 playwright / puppeteer，
 * 而 agent-browser 需要另外下载几百 MB 的 Chromium。本机已有 Chrome，
 * 用它的 --remote-debugging-port 配合 Node 22 内置 WebSocket 就够用了。
 *
 * 用法：node scripts/shot-costing.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5199（vite dev，/api 已代理到 3001）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
// 每次用不同端口 + 不同 profile 目录：否则上一轮没死透的 Chrome 会占着端口，
// 探活探到的是旧实例，而它手上那个 page target 早已随 Browser.close 失效。
const PORT = 9400 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-profile-${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const API = 'http://127.0.0.1:3001'

mkdirSync(OUT, { recursive: true })

// ---------- 1. 先拿一枚管理员 token（截图要落在已登录态） ----------
const loginRes = await fetch(`${API}/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: '12345' })
})
const login = await loginRes.json()
if (!login?.data?.token) {
  console.error('登录失败，无法继续：', JSON.stringify(login).slice(0, 200))
  process.exit(1)
}
const TOKEN = login.data.token
const USER = JSON.stringify(login.data.user || { username: 'admin' })

// ---------- 2. 起 Chrome ----------
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  // Chrome 155 起：不加这几个开关，渲染进程会直接 targetCrashed（表现是所有 CDP 命令超时）
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-software-rasterizer',
  '--disable-gpu',
  '--hide-scrollbars',
  // 本机开着系统代理，headless Chrome 会跟着走代理去访问 127.0.0.1 → ERR_CONNECTION_*
  '--no-proxy-server',
  '--proxy-bypass-list=*',
  // Chrome 新版会校验 DevTools WebSocket 的 Origin，来源不明直接不回帧（表现为所有命令超时）
  '--remote-allow-origins=*',
  '--window-size=1600,1200',
  `--user-data-dir=${PROFILE}`,
  'about:blank'
], { stdio: 'ignore' })

const cleanup = () => { try { chrome.kill('SIGKILL') } catch {} }
process.on('exit', cleanup)

async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`)
      if (r.ok) {
        const v = await r.json()
        // 必须确认连到的是**本次**起的实例：端口冲突时探活会探到别人
        if (String(v.webSocketDebuggerUrl || '').includes(`:${PORT}/`)) return v
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来（或端口被别的实例占用）')
}
await waitChrome()

// ---------- 3. 极简 CDP 客户端 ----------
let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []

class Cdp {
  constructor(ws) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data)
      if (m.id && pending.has(m.id)) {
        const { resolve, reject } = pending.get(m.id)
        pending.delete(m.id)
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result)
        return
      }
      // 事件：把页面的错误收集起来，「零错误」才可断言
      if (m.method === 'Runtime.exceptionThrown') {
        pageErrors.push(m.params?.exceptionDetails?.exception?.description || m.params?.exceptionDetails?.text || 'unknown')
      }
      if (m.method === 'Runtime.consoleAPICalled' && m.params?.type === 'error') {
        consoleErrors.push((m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '))
      }
      if (m.method === 'Log.entryAdded' && m.params?.entry?.level === 'error') {
        consoleErrors.push(`${m.params.entry.text} ${m.params.entry.url || ''}`.trim())
      }
    })
  }
  send(method, params = {}) {
    // 首帧偶尔会被 Chrome 吞掉（Node 内置 WebSocket 的已知毛病，见 connect 说明）：
    // 6 秒没回就补一帧激活、再重发一次，而不是直接判失败。
    return this.once(method, params, 6000).catch(async (err) => {
      try { this.ws.send(JSON.stringify({ id: ++msgId, method: 'Browser.getVersion' })) } catch {}
      await sleep(500)
      return this.once(method, params, 15000).catch(() => { throw err })
    })
  }
  once(method, params, timeout) {
    const id = ++msgId
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      this.ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP 超时: ${method}`)) }
      }, timeout)
    })
  }
}

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('error', (e) => reject(new Error(`WS 连接失败: ${e.message || url}`)))
    ws.addEventListener('open', () => {
      const cdp = new Cdp(ws)
      // ⚠️ 必须在 open 事件里**同步**送出第一帧：Node 内置 WebSocket 若把首次 send 推到
      // open 事件之外（哪怕只隔一个 microtask），帧发得出去但 Chrome 一条响应都不回。
      // 实测：同步发必成、异步发必超时（同一个脚本只改这一点）。
      // 这里先发一条无副作用的 Browser.getVersion 当激活帧（响应 id=999 不命中 pending，
      // 当事件丢掉即可），主流程再等一拍才开始正式命令。
      ws.send(JSON.stringify({ id: 999, method: 'Browser.getVersion' }))
      resolve(cdp)
    })
  })
}

// 自己开一个干净的 page target，不挑 /json/list 里那些（可能是别的实例遗留的）
let pageTarget = null
try {
  const nr = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })
  if (nr.ok) pageTarget = await nr.json()
} catch {}
if (!pageTarget) {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  pageTarget = targets.find((t) => t.type === 'page' && t.url === 'about:blank') || targets.find((t) => t.type === 'page')
}
if (!pageTarget?.webSocketDebuggerUrl) throw new Error('没拿到可用的 page target')
const cdp = await connect(pageTarget.webSocketDebuggerUrl)

await sleep(250)             // 等激活帧走完，连接才真正可用（见 connect 里的说明）
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false
})

// 每次导航前都注入已登录态（比 navigate 后再 evaluate 更稳，避免首帧跳登录页）
await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      localStorage.setItem('gml_token', ${JSON.stringify(TOKEN)});
      localStorage.setItem('gml_user', ${JSON.stringify(USER)});
      if (!localStorage.getItem('gml_industry')) localStorage.setItem('gml_industry', 'cosmetic');
    } catch (e) { /* about:blank 等无 storage 权限的文档，静默跳过 */ }
  `
})

async function goto(path, { wait = 3200, fullPage = true } = {}) {
  await cdp.send('Page.navigate', { url: `${BASE}${path}` })
  await sleep(wait)
  if (fullPage) {
    // 让页面按内容全高渲染，长表格也能一次截全
    try {
      const m = await cdp.send('Page.getLayoutMetrics')
      const h = Math.min(Math.ceil(m.cssContentSize?.height || 1200), 6000)
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: 1600, height: h, deviceScaleFactor: 2, mobile: false
      })
      await sleep(600)
    } catch {}
  }
}

async function shot(name) {
  const r = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  const file = `${OUT}/${name}.png`
  writeFileSync(file, Buffer.from(r.data, 'base64'))
  console.log('  截图 →', file)
  return file
}

/** 点页签：本项目 Tabs 是 div.tab，必须只在这个集合里找 ——
 *  否则会先命中正文里的描述文案（它也含「暂估差异」这几个字），点了等于没切页。 */
async function clickTab(text) {
  const expr = `
    (() => {
      const t = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll('.tab')].find((e) => (e.textContent || '').includes(t));
      if (!el) return 'not-found';
      el.click();
      return 'clicked:' + (el.textContent || '').trim().slice(0, 20);
    })()
  `
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value
}

async function clickByText(text) {
  // 用最朴素的方式找可点元素：按可见文字点。React 页面里没有稳定 id，
  // 文字是最稳的锚点。注意本项目 Tabs 是 <div class="tab">，不是 button/[role=tab]，
  // 所以选择器池要宽一些，并取「子孙最少的那个」＝最内层的可点元素。
  const expr = `
    (() => {
      const t = ${JSON.stringify(text)};
      const pool = [...document.querySelectorAll('button, a, [role=tab], [role=button], .tab, .cursor-pointer, td, tr')];
      const hits = pool.filter((e) => (e.textContent || '').trim().includes(t));
      if (!hits.length) return 'not-found';
      hits.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      hits[0].click();
      return 'clicked:' + (hits[0].textContent || '').trim().slice(0, 24);
    })()
  `
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true })
  return r.result?.value
}

const results = []

// ---------- 4. 截图序列 ----------
console.log('→ 成本核算主页')
await goto('/inventory/costing')
await shot('costing-01-总览')
const title = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
const h1 = await cdp.send('Runtime.evaluate', {
  expression: `([...document.querySelectorAll('h1,h2')].map(e=>e.textContent.trim()).slice(0,3).join(' | '))`,
  returnByValue: true
})
const statCards = await cdp.send('Runtime.evaluate', {
  expression: `([...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/成本|金额|期末|差异/.test(e.textContent||'')).slice(0,8).map(e=>e.textContent.trim()))`,
  returnByValue: true
})
console.log('  标题：', h1.result?.value)
console.log('  命中成本字样：', JSON.stringify(statCards.result?.value).slice(0, 300))

console.log('→ 暂估差异：待办只列能回写的，发票口径单列')
const c1 = await clickTab('暂估差异')
console.log('  ', c1)
await sleep(1800)
await shot('costing-02-暂估差异')

// 从差异台账开一张草稿调整单 —— 会真的落一张草稿（正好当演示数据），
// 并自动弹出详情，顺便验证整条界面链路可用（不只是能看）
console.log('→ 开调整单（草稿）+ 详情弹窗')
const openBtn = await clickByText('开调整单')
console.log('  ', openBtn)
await sleep(2200)
await shot('costing-05-调整单详情')
const modalInfo = await cdp.send('Runtime.evaluate', {
  expression: `(() => {
    const t = document.body.innerText;
    const hit = ['行级明细', '在库', '已售出', '暂估单价', '实际单价'].filter((k) => t.includes(k));
    return hit.join('/');
  })()`,
  returnByValue: true
})
console.log('  详情弹窗里出现的要素：', modalInfo.result?.value)

console.log('→ 调整单台账')
await goto('/inventory/costing', { wait: 2600 })
const c2 = await clickTab('调整单')
console.log('  ', c2)
await sleep(1800)
await shot('costing-03-调整单')

console.log('→ 期间结转')
const c3 = await clickTab('期间结转')
console.log('  ', c3)
await sleep(1800)
await shot('costing-04-期间结转')

results.push({ title: title.result?.value, consoleErrors, pageErrors })

// ---------- 5. 收尾 ----------
console.log('\n=== 浏览器错误汇总 ===')
console.log('  Runtime 异常:', pageErrors.length ? pageErrors : '0 条')
console.log('  console.error / Log.error:', consoleErrors.length ? consoleErrors : '0 条')

await cdp.send('Browser.close').catch(() => {})
cleanup()
process.exit(0)
