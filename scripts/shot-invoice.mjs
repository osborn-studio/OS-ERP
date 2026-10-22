/**
 * ============================================================================
 * 文件标识：scripts/shot-invoice.mjs ｜ 模块 24 界面截图（销售发票，headless Chrome + CDP）
 * ============================================================================
 * 【职责】模块 24 界面截图（销售发票，headless Chrome + CDP）
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
 * 模块 24 界面截图（销售发票，headless Chrome + CDP）
 *
 * 与 shot-ar.mjs 同一套极简 CDP 客户端（项目里没有 playwright/puppeteer，
 * 本机已有 Chrome，用它 + Node 内置 WebSocket 就够）。
 *
 * 用法：node scripts/shot-invoice.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5199（vite dev，/api 已代理到 3001）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5199'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
const PORT = 9400 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-si-profile-${PORT}`
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const API = 'http://127.0.0.1:3001'

mkdirSync(OUT, { recursive: true })

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
  '--no-proxy-server',
  '--proxy-bypass-list=*',
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
        if (String(v.webSocketDebuggerUrl || '').includes(`:${PORT}/`)) return v
      }
    } catch {}
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来（或端口被别的实例占用）')
}
await waitChrome()

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
      // 必须在 open 里同步送出第一帧，否则 Chrome 一条响应都不回（见 shot-ar.mjs 详注）
      ws.send(JSON.stringify({ id: 999, method: 'Browser.getVersion' }))
      resolve(cdp)
    })
  })
}

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

await sleep(250)
await cdp.send('Page.enable')
await cdp.send('Runtime.enable')
await cdp.send('Log.enable')
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false })

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
    try {
      const m = await cdp.send('Page.getLayoutMetrics')
      const h = Math.min(Math.ceil(m.cssContentSize?.height || 1200), 6000)
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: h, deviceScaleFactor: 2, mobile: false })
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

/** 点页签：本项目 Tabs 是 div.tab，必须只在这个集合里找 */
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
  const expr = `
    (() => {
      const t = ${JSON.stringify(text)};
      const pool = [...document.querySelectorAll('button, a, [role=tab], [role=button], .tab, .cursor-pointer, td, tr, span')];
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

async function evalJs(expression) {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

/** 关掉弹窗：优先点页脚「关闭」，再退到「×」。**必须确认真的关掉了** ——
 *  否则下一张截图会把上一张的弹窗再拍一遍（本轮真实踩到：si-07 与 si-06 是同一张图）。 */
async function closeModal() {
  const step = `(() => {
    const b1 = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '关闭');
    if (b1) { b1.click(); return 'footer'; }
    const b2 = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '×');
    if (b2) { b2.click(); return 'x'; }
    return 'none';
  })()`
  const how = await evalJs(step)
  await sleep(900)
  // 兜底：还有弹窗就直接点遮罩（Modal 的 overlay 也绑了 onClose）
  let still = await evalJs(`document.querySelectorAll('.fixed.inset-0').length`)
  if (still) {
    await evalJs(`(() => { const o=document.querySelector('.fixed.inset-0'); if(o) o.click(); return 'overlay'; })()`)
    await sleep(900)
    still = await evalJs(`document.querySelectorAll('.fixed.inset-0').length`)
  }
  return `${how}${still ? '(仍开着!)' : ''}`
}

/** 只在按钮里按精确文本点，避免命中正文里同名的说明文字 */
async function clickButton(text) {
  const expr = `(() => {
    const t = ${JSON.stringify(text)};
    const b = [...document.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === t);
    if (!b) return 'not-found';
    b.click();
    return 'clicked:' + t;
  })()`
  return evalJs(expr)
}

async function hasText(...keys) {
  const expr = `(() => {
    const t = document.body.innerText;
    return ${JSON.stringify(keys)}.filter((k) => t.includes(k)).join('/');
  })()`
  return evalJs(expr)
}

// ---------- 截图序列 ----------
console.log('→ 开票总览（KPI + 按状态分布 + 自洽审计）')
await goto('/sales/invoices')
await shot('si-01-开票总览')
console.log('  要素：', await hasText('已开票金额', '其中税额', '待开票发货单', '自洽审计'))

console.log('→ 待开票队列（货发了、票没开）')
const t1 = await clickTab('待开票队列')
console.log('  ', t1)
await sleep(2200)
await shot('si-02-待开票队列')
console.log('  要素：', await hasText('待开票队列', '剩余可开', '开票状态'))

console.log('→ 由发货单开票（弹窗：含税反推 + 可分批）')
// 不能按文字模糊点「开票」——筛选条的「开票状态」标签也含这两个字，会命中它而不是行内按钮。
// 并且要挑一张**还有剩余可开**的单（状态为「未开票」）：
// 已开完票的单点进去只有一行「没有可开数量」，截出来是空表，看不出这个弹窗长什么样。
const openInv = await evalJs(`(() => {
  const tr = [...document.querySelectorAll('.tbl tbody tr')].find((r) => (r.textContent || '').includes('未开票'));
  if (!tr) return 'no-row';
  const b = [...tr.querySelectorAll('button')].find((e) => (e.textContent || '').trim() === '开票');
  if (!b) return 'no-btn';
  b.click();
  return 'clicked:' + (tr.textContent || '').trim().slice(0, 20);
})()`)
console.log('  点行内「开票」：', openInv)
await sleep(2600)
await shot('si-03-由发货单开票')
console.log('  要素：', await hasText('本次开票数量', '剩余可开', '价税合计', '不含税', '草稿'))

// 关掉弹窗再进入下一张
console.log('  关闭弹窗：', await closeModal())

console.log('→ 发票列表（蓝/红字 + 关联应收 + 状态）')
const t2 = await clickTab('发票列表')
console.log('  ', t2)
await sleep(2400)
await shot('si-04-发票列表')
console.log('  要素：', await hasText('发票单号', '价税合计', '关联应收', '状态'))

console.log('→ 发票详情（发票行 + 关联应收）')
const openDetail = await evalJs(`(() => { const tr=document.querySelector('.tbl tbody tr'); if(!tr) return 'no-row'; tr.click(); return 'clicked:'+(tr.textContent||'').trim().slice(0,24); })()`)
console.log('  点行：', openDetail)
await sleep(2600)
await shot('si-05-发票详情')
console.log('  要素：', await hasText('发票行', '关联应收', '价税合计'))
console.log('  关闭弹窗：', await closeModal())

console.log('→ 红冲关系（原票 + 红字票并排）')
const openRed = await clickByText('已红冲')
console.log('  点「已红冲」行：', openRed)
await sleep(2600)
await shot('si-06-红冲关系')
console.log('  要素：', await hasText('红冲关系', '原票', '红字票'))
console.log('  关闭弹窗：', await closeModal())

console.log('→ 手工开票（无来源单据，补历史票）')
const openManual = await clickButton('手工开票')
console.log('  点「手工开票」：', openManual)
await sleep(2400)
await shot('si-07-手工开票')
console.log('  要素：', await hasText('开票明细', '含税单价', '价税合计', '客户'))

console.log('\n=== 浏览器错误汇总 ===')
console.log('  Runtime 异常:', pageErrors.length ? pageErrors : '0 条')
console.log('  console.error / Log.error:', consoleErrors.length ? consoleErrors : '0 条')

await cdp.send('Browser.close').catch(() => {})
cleanup()
process.exit(0)
