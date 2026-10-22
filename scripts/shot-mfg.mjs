/**
 * ============================================================================
 * 文件标识：scripts/shot-mfg.mjs ｜ 模块 10B 制造中心界面截图（headless Chrome + CDP，零额外依赖）
 * ============================================================================
 * 【职责】模块 10B 制造中心界面截图（headless Chrome + CDP，零额外依赖）
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
 * 模块 10B 制造中心界面截图（headless Chrome + CDP，零额外依赖）
 *
 * 与 shot-qc / shot-costing / shot-invoice 同一套骨架：本机没装 playwright，
 * 直接用已有 Chrome 的 --remote-debugging-port 配 Node 22 内置 WebSocket。
 *
 * 本脚本要拍出的东西（每一张都对应一条口径，不是随便拍个列表）：
 *   01 总览      —— 在制/领料额/待入库 + **七项自洽审计**（制造域最容易静默出错的地方）
 *   02 BOM 清单  —— 一个母件一个用途一版；草稿/已审批/已作废三态并存
 *   03 BOM 展开  —— **含损耗的用量** + 替代料的取舍理由（只给结果不给理由就没法复盘）
 *   04 BOM 详情  —— 组件按替代组归并，独立行与替代行分得清
 *   05 领料台账  —— 只有「确认出库」是主按钮，其余动作是次按钮（谁动库存一眼看得出）
 *   06 领料详情  —— 行上有**实际扣减的批次号与出库单价**，以及流转留痕
 *   07 新建领料  —— 选订单后**按 BOM 自动装填待领量**（BOM 需求 − 已出库）
 *   08 完工试算  —— 料工费归集：材料 = 领料总额÷订单数量×本次良品；转换 = 人工 + 制费
 *
 * 用法：node scripts/shot-mfg.mjs [baseUrl] [outDir]
 *   baseUrl 默认 http://127.0.0.1:5173（vite dev，/api 已代理到 3001）
 */
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const BASE = process.argv[2] || 'http://127.0.0.1:5173'
const OUT = process.argv[3] || '/Users/linxinlan/工作文档/gml/docs/shots'
// 每次用不同端口 + 不同 profile 目录：否则上一轮没死透的 Chrome 会占着端口，
// 探活探到的是旧实例，而它手上那个 page target 早已随 Browser.close 失效。
const PORT = 9500 + Math.floor(Math.random() * 90)
const PROFILE = `/tmp/gml-shot-mfg-profile-${PORT}`
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

/**
 * 用同一枚 token 直接查接口，给「点哪一行」提供**数据驱动的锚点**。
 * 为什么不按「第一行 / 含某关键字的第一行」挑：列表是按 id 倒序的，
 * 而 mock 数据一改，第一个匹配的行就换人了 —— 于是截图拍到的是另一条业务分支，
 * 打印出来的「要素齐全」还照样是绿的（早期真的拍到过一张没有替代组的组合装 BOM）。
 */
const apiGet = async (path) => {
  const r = await fetch(`${API}/api${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } })
  const j = await r.json().catch(() => null)
  return j?.data
}

// ---------- 2. 起 Chrome ----------
const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
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

// ---------- 3. 极简 CDP 客户端 ----------
let msgId = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
const dialogs = []

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
      // confirm() / alert() 不处理会**卡死整个页面**（CDP 命令全部超时，表现成脚本莫名卡住）。
      // 本项目界面上「确认出库」「完工入库」前都有 confirm，所以必须自动应答。
      if (m.method === 'Page.javascriptDialogOpening') {
        dialogs.push(m.params?.message || '')
        const id = ++msgId
        try {
          ws.send(JSON.stringify({ id, method: 'Page.handleJavaScriptDialog', params: { accept: true } }))
        } catch {}
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
      // ⚠️ 必须在 open 事件里**同步**送出第一帧：Node 内置 WebSocket 若把首次 send 推到
      // open 事件之外（哪怕只隔一个 microtask），帧发得出去但 Chrome 一条响应都不回。
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
await cdp.send('Emulation.setDeviceMetricsOverride', {
  width: 1600, height: 1200, deviceScaleFactor: 2, mobile: false
})

await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    try {
      localStorage.setItem('gml_token', ${JSON.stringify(TOKEN)});
      localStorage.setItem('gml_user', ${JSON.stringify(USER)});
      localStorage.setItem('gml_industry', 'cosmetic');
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

const evalJs = async (expression) => {
  const r = await cdp.send('Runtime.evaluate', { expression, returnByValue: true })
  return r.result?.value
}

/** 点页签：Tabs 是 div.tab，必须只在这个集合里找 —— 否则会先命中正文里的描述文案 */
async function clickTab(text) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const el = [...document.querySelectorAll('.tab')].find((e) => (e.textContent || '').includes(t));
      if (!el) return 'not-found';
      el.click();
      return 'clicked:' + (el.textContent || '').trim().slice(0, 20);
    })()
  `)
}

/** 点「同时含这些关键字」的那一行 —— 用行内容当锚点比序号稳（列表是按 id 倒序的） */
async function clickRow(parts) {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(parts)};
      const rows = [...document.querySelectorAll('table tbody tr')];
      const hit = rows.find((tr) => {
        const t = tr.textContent || '';
        return ks.every((k) => t.includes(k));
      });
      if (!hit) return 'not-found';
      hit.click();
      return 'clicked:' + (hit.textContent || '').trim().slice(0, 40);
    })()
  `)
}

/**
 * 点按钮：**必须精确匹配 button 文本**。
 * 本项目踩过：模糊匹配会先命中同名的字段标签（比如「完工入库」既在按钮上、也在提示文案里），
 * 于是点了个 div，什么也没发生，却拍出一张和上一张一模一样的图。
 */
async function clickButton(text, { exact = false } = {}) {
  return evalJs(`
    (() => {
      const t = ${JSON.stringify(text)};
      const btns = [...document.querySelectorAll('button')];
      const hit = btns.find((b) => {
        const s = (b.textContent || '').trim();
        return ${exact ? 's === t' : 's.includes(t)'};
      });
      if (!hit) return 'not-found';
      if (hit.disabled) return 'disabled';
      hit.click();
      return 'clicked:' + (hit.textContent || '').trim().slice(0, 30);
    })()
  `)
}

/** 行内按钮：只在指定行里找按钮，避免点到别的行 */
async function clickButtonInRow(rowParts, btnText) {
  return evalJs(`
    (() => {
      const ks = ${JSON.stringify(rowParts)};
      const rows = [...document.querySelectorAll('table tbody tr')];
      const row = rows.find((tr) => ks.every((k) => (tr.textContent || '').includes(k)));
      if (!row) return 'row-not-found';
      const btn = [...row.querySelectorAll('button')].find((b) => (b.textContent || '').trim().includes(${JSON.stringify(btnText)}));
      if (!btn) return 'btn-not-found';
      if (btn.disabled) return 'disabled';
      btn.click();
      return 'clicked:' + (btn.textContent || '').trim().slice(0, 30);
    })()
  `)
}

/**
 * 设置 select 的值。
 * React 17+ 把 onChange 绑定在 root 上、靠原生 change 事件冒泡触发，
 * 所以直接改 value 不会触发 setState —— 必须 dispatch 一个真正的 change 事件，
 * 而且要先按 React 的方式改值（走 nativeSetter）才不会被打回。
 */
async function setSelect({ inModal = false, optionIncludes = null, index = null, nth = 0 }) {
  return evalJs(`
    (() => {
      const root = ${inModal ? "document.querySelector('.fixed.inset-0') || document" : 'document'};
      const sels = [...root.querySelectorAll('select')];
      const sel = sels[${nth}];
      if (!sel) return 'no-select';
      const opts = [...sel.options];
      let target = null;
      ${optionIncludes ? `
      target = opts.find((o) => (o.textContent || '').includes(${JSON.stringify(optionIncludes)}));
      ` : `
      target = opts[${index ?? 1}];
      `}
      if (!target) return 'no-option:' + opts.map((o) => (o.textContent || '').trim()).slice(0, 6).join('|');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
      setter.call(sel, target.value);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'selected:' + (target.textContent || '').trim().slice(0, 40);
    })()
  `)
}

const results = []

/** 挑一张「已审批 + 含替代组」的 BOM 作为展开与详情的样本 */
async function pickBomWithSubstitute() {
  const list = (await apiGet('/manufacture/boms?pageSize=200'))?.list || []
  for (const b of list) {
    if (b.status !== 'approved') continue
    const full = await apiGet(`/manufacture/boms/${b.id}`)
    if ((full?.items || []).some((i) => i.substitute_group)) return full
  }
  return null
}

/** 挑一张「有待入库汇报」的生产订单 —— 否则「完工入库」按钮是灰的，拍出来什么都没有 */
async function pickOrderWithPendingReport() {
  const pend = (await apiGet('/manufacture/reports?stock_done=0&pageSize=50'))?.list || []
  if (!pend.length) return null
  const list = (await apiGet('/manufacture/orders?pageSize=200'))?.list || []
  return list.find((o) => o.doc_no === pend[0].order_no) || null
}

/** 挑一张「有已审批自制 BOM、且确实还有待领量」的订单 —— 否则自动装填出来是空的，
 *  拍到的只是兜底提示文案（"该成品尚未维护自制 BOM"），而不是想展示的自动装填。 */
async function pickOrderWithPendingRequirement() {
  const orders = (await apiGet('/manufacture/orders?status=in_progress&pageSize=200'))?.list || []
  for (const o of orders) {
    const req = await apiGet(`/manufacture/orders/${o.id}/requirement`)
    if (req?.bom && (req.lines || []).length > 0) return { order: o, req }
  }
  return null
}

const rowsText = (sel = 'table tbody tr', n = 3) =>
  evalJs(`([...document.querySelectorAll('${sel}')].slice(0,${n}).map(tr=>tr.innerText.replace(/\\n/g,' | ')).join('  ///  '))`)

// ---------- 4. 截图序列 ----------
console.log('→ 制造中心 · 总览（在制 / 领料额 / 待入库 + 七项自洽审计）')
await goto('/manufacture')
await shot('mfg-01-总览')
console.log('  指标卡：', JSON.stringify(await evalJs(
  `([...document.querySelectorAll('*')].filter(e=>e.children.length===0&&/在制订单|已出库领料额|累计良品|待完工入库/.test(e.textContent||'')).slice(0,10).map(e=>e.textContent.trim()))`
)).slice(0, 400))
console.log('  审计结论：', await evalJs(
  `(() => { const t = document.body.innerText; const m = t.match(/七项不变量[^\\n]*|错误 [^\\n]{0,40}|警告 [^\\n]{0,40}/); return m ? m[0] : '未找到'; })()`
))
console.log('  BOM 总览：', await evalJs(
  `(() => { const t = document.body.innerText; return ['BOM 总数','已审批 BOM','替代组','能生产但没 BOM'].filter(k=>t.includes(k)).join('/'); })()`
))

console.log('→ BOM 清单（草稿 / 已审批 / 已作废三态并存）')
console.log('  ', await clickTab('BOM 与展开'))
await sleep(2200)
await shot('mfg-02-BOM清单')
console.log('  表格首行：', String(await rowsText()).slice(0, 500))

const subBom = await pickBomWithSubstitute()
if (!subBom) throw new Error('演示数据里找不到「已审批 + 含替代组」的 BOM，无法拍摄展开与详情')
const subGroups = [...new Set(subBom.items.filter((i) => i.substitute_group).map((i) => i.substitute_group))]
console.log(`  样本：${subBom.code}（${subBom.product_sku_name}，替代组 ${subGroups.length} 个：${subGroups.join(' / ')}）`)

console.log('→ BOM 展开试算：用量已含损耗，替代料给出取舍理由')
console.log('  ', await clickButtonInRow([subBom.code, '已审批'], '展开试算'))
await sleep(2400)
// 指定生产仓 → 替代料的「可用量 / 够不够」才有数（不指仓时只按优先级取主料，页面会写「未指定仓」）
console.log('  指定生产仓：', await setSelect({ inModal: true, nth: 0 }))
await sleep(600)
console.log('  ', await clickButton('重新试算'))
await sleep(2400)
await shot('mfg-03-BOM展开试算')
console.log('  口径文案：', await evalJs(
  `(() => { const t = document.body.innerText; return ['改任何数据','已含损耗','单件用量','替代料的取舍理由','应领（含损耗）','可用量','缺口'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  替代取舍理由：', String(await evalJs(
  `(() => { const t = document.body.innerText; const i = t.indexOf('替代料的取舍理由'); return i < 0 ? '未展示' : t.slice(i, i + 200).replace(/\\n/g, ' '); })()`
)).slice(0, 260))
console.log('  ', await clickButton('关闭'))
await sleep(900)

console.log('→ BOM 详情：组件按替代组归并（独立行与替代行分得清）')
console.log('  ', await clickButtonInRow([subBom.code, '已审批'], '详情'))
await sleep(2400)
await shot('mfg-04-BOM详情')
console.log('  弹窗要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['基准批量','替代组','组件行数','损耗率','生效期','审批人'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  ', await clickButton('关闭'))
await sleep(900)
// 断言弹窗真的不在了 —— 否则会拍出两张完全相同的图，而且没人看得出来
console.log('  弹窗已关闭：', await evalJs(`!document.querySelector('.fixed.inset-0')`))

console.log('→ 生产领料台账（只有「确认出库」是主按钮，其余是次按钮）')
console.log('  ', await clickTab('生产领料'))
await sleep(2200)
await shot('mfg-05-领料台账')
console.log('  台账首行：', String(await rowsText()).slice(0, 500))

console.log('→ 领料单详情：行上有实际扣减的批次号与出库单价')
console.log('  ', await clickRow(['MR', '已出库']))
await sleep(2600)
await shot('mfg-06-领料单详情')
console.log('  详情要素：', await evalJs(
  `(() => { const t = document.body.innerText; return ['表头数量','行合计','出库金额','行金额合计','出库单价','流转留痕','已出库'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  行级批次：', String(await rowsText('.fixed.inset-0 table tbody tr', 2)).slice(0, 320))
console.log('  ', await clickButton('关闭'))
await sleep(900)

console.log('→ 新建领料单：选订单后按 BOM 自动装填待领量')
const withReq = await pickOrderWithPendingRequirement()
if (!withReq) throw new Error('演示数据里找不到「有待领量」的在制订单，无法拍摄自动装填')
console.log(`  样本：${withReq.order.doc_no}（${withReq.order.sku_name}，照 BOM ${withReq.req.bom.code} 展开，待领 ${withReq.req.summary.pending_count} 行）`)
console.log('  ', await clickButton('新建领料单'))
await sleep(1600)
console.log('  选订单：', await setSelect({ inModal: true, optionIncludes: withReq.order.doc_no, nth: 0 }))
await sleep(3000)
await shot('mfg-07-新建领料单-按BOM自动装填')
console.log('  自动装填：', await evalJs(
  `(() => { const t = document.body.innerText; return ['待领物料','照 BOM','BOM 需求','待领','本次领用','指定批次','自动取批'].filter(k=>t.includes(k)).join('/'); })()`
))
console.log('  装填结果：', String(await rowsText('.fixed.inset-0 table tbody tr')).slice(0, 400))
console.log('  ', await clickButton('取消'))
await sleep(900)

console.log('→ 完工入库试算：料工费归集（材料 = 领料总额 ÷ 订单数量 × 本次良品）')
console.log('  ', await clickTab('完工入库'))
await sleep(2200)
await shot('mfg-08a-完工入库-订单执行')
const pendOrder = await pickOrderWithPendingReport()
if (!pendOrder) throw new Error('演示数据里找不到「有待入库汇报」的订单，无法拍摄完工入库')
console.log(`  样本：${pendOrder.doc_no}（${pendOrder.sku_name}，计划 ${pendOrder.qty} / 已完工 ${pendOrder.completed_qty}）`)
console.log('  ', await clickRow([pendOrder.doc_no, '生产中']))
await sleep(2800)
console.log('  ', await clickButton('完工入库'))
await sleep(2600)
await shot('mfg-08b-完工入库试算')
console.log('  归集项：', await evalJs(
  `(() => { const t = document.body.innerText; return ['已出库领料总额','单位材料','材料成本','转换成本','入库总成本','入库单位成本','待检'].filter(k=>t.includes(k)).join('/'); })()`
))
// 只关掉试算弹窗，**不真的入库** —— 截图脚本不应该改动演示数据
console.log('  ', await clickButton('取消'))
await sleep(900)
console.log('  ', await clickButton('关闭'))
await sleep(700)

results.push({ dialogs })

// ---------- 5. 收尾 ----------
// favicon 的 404 与本模块无关且长期存在；留在汇总里只会让人每次都要重新判断一遍
const ignorable = (s) => /favicon\.ico/.test(s)
const realConsoleErrors = consoleErrors.filter((s) => !ignorable(s))
console.log('\n=== 浏览器错误汇总 ===')
console.log('  Runtime 异常:', pageErrors.length ? pageErrors : '0 条')
console.log('  console.error / Log.error:', realConsoleErrors.length ? realConsoleErrors : '0 条')
console.log('  自动应答的 confirm 弹窗:', dialogs.length ? dialogs.map((d) => d.split('\n')[0]).slice(0, 3) : '0 次（本次不执行入库/出库，符合预期）')

await cdp.send('Browser.close').catch(() => {})
cleanup()
process.exit(realConsoleErrors.length || pageErrors.length ? 1 : 0)
