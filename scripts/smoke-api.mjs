/**
 * ============================================================================
 * 文件标识：scripts/smoke-api.mjs ｜ 服务端冒烟：真实起服务 → 登录 → 按 OpenAPI 全量扫描 GET 接口 → 统计异常
 * ============================================================================
 * 【职责】服务端冒烟：真实起服务 → 登录 → 按 OpenAPI 全量扫描 GET 接口 → 统计异常
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 服务端冒烟：真实起服务 → 登录 → 按 OpenAPI 全量扫描 GET 接口 → 统计异常
// 目的：验证库存引擎重写后，80 处既有调用点（9 个路由 + seed）全部照旧工作
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const NODE = process.execPath
const PORT = 3199
const BASE = `http://127.0.0.1:${PORT}`
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100

const srv = spawn(NODE, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe']
})

let log = ''
srv.stdout.on('data', (d) => { log += d.toString() })
srv.stderr.on('data', (d) => { log += d.toString() })

const started = Date.now()
const ready = await new Promise((resolve) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) { clearInterval(t); resolve(true) }
    else if (Date.now() - started > 240000) { clearInterval(t); resolve(false) }
  }, 400)
})

if (!ready) {
  console.log('❌ 服务未能在 240s 内就绪，日志尾部：')
  console.log(log.split('\n').slice(-40).join('\n'))
  srv.kill('SIGKILL')
  process.exit(1)
}
console.log('✅ 服务已启动')
console.log(log.split('\n').filter((l) => l.includes('[gml]')).slice(0, 12).join('\n'))

const results = { ok: 0, client: 0, server: 0, other: 0 }
const bad = []

async function hit(method, p, token, label) {
  const url = `${BASE}${p}`
  try {
    const res = await fetch(url, {
      method,
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    const s = res.status
    if (s >= 500) { results.server += 1; bad.push([method, p, s, label]) }
    else if (s >= 400) { results.client += 1 }
    else { results.ok += 1 }
    return { status: s, body: await res.text() }
  } catch (e) {
    results.other += 1
    bad.push([method, p, 'ERR', e.message])
    return { status: 0, body: '' }
  }
}

// ---------- 1. 基础接口 ----------
console.log('\n--- 基础接口 ---')
for (const p of ['/api', '/api/meta/health', '/api/openapi.json', '/api/ai/manifest', '/api/openapi.json']) {
  const r = await hit('GET', p, null, '基础')
  console.log(`  ${String(r.status).padStart(3)}  ${p}`)
}

// ---------- 2. 登录（两个行业） ----------
console.log('\n--- 登录 ---')
const tokens = {}
for (const ind of ['cosmetic', 'food']) {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: '12345', industry: ind })
  })
  const j = await res.json().catch(() => ({}))
  console.log(`  ${String(res.status).padStart(3)}  login[${ind}]  code=${j.code} ${j.message || ''}`)
  if (j.data?.token) tokens[ind] = j.data.token
}

// ---------- 3. OpenAPI 全量扫描 ----------
const oa = await (await fetch(`${BASE}/api/openapi.json`)).json()
const paths = Object.keys(oa.paths || {})
console.log(`\n--- OpenAPI 路径共 ${paths.length} 条，扫描其中无路径参数的 GET ---`)

const token = tokens.cosmetic
let scanned = 0
for (const p of paths) {
  const full = p.startsWith('/api') ? p : `/api${p}`
  if (/\{.*\}/.test(full) || /:/.test(full)) continue
  const item = oa.paths[p]
  if (!item.get) continue
  await hit('GET', full, token, '扫描')
  scanned += 1
}
console.log(`  已扫描 ${scanned} 个接口`)

// ---------- 4. 库存相关重点接口（改了 stock.js 的高风险面） ----------
console.log('\n--- 库存引擎高风险面 ---')
for (const ind of ['cosmetic', 'food']) {
  const tk = tokens[ind] || token
  for (const p of [
    // 注意：以下路径必须与 server/routes/*.js 里 r.get() 的真实注册路径一致。
    // 历史上这里写过 /inventory/warehouses、/pos/stores 等「想当然」的路径，
    // 每次都报 404，看起来像应用缺接口，实为脚本自身过期 —— 排查成本很高，勿再改动。
    '/api/inventory/stocks', '/api/inventory/transactions', '/api/inventory/alerts',
    '/api/inventory/availability', '/api/inventory/aging', '/api/dashboard/summary',
    '/api/master/products', '/api/master/warehouses', '/api/master/options',
    '/api/purchase/orders', '/api/sales/orders', '/api/pos/context', '/api/oms/orders',
    '/api/requisitions/store', '/api/outsourcing/orders', '/api/dealers/overview',
    '/api/pricing/groups', '/api/pricing/rules', '/api/pricing/logs',
    '/api/pricing/resolve?sku_id=1&channel=dealer&dealer_level=gold&region=华东',
    '/api/pricing/explain?sku_id=1&channel=franchise',
    '/api/auth/org-tree', '/api/auth/my-permissions', '/api/mcp/tools',
    '/api/mcp/tokens', '/api/mcp/stats',
    '/api/docflow/overview', '/api/docflow/types', '/api/docflow/flows', '/api/docflow/no-rules',
    // 订货中心（模块 12A）
    '/api/order-center/overview', '/api/order-center/flow', '/api/order-center/policies',
    '/api/order-center/customers', '/api/order-center/customers/tree',
    '/api/order-center/orders', '/api/order-center/statements',
    // 采购域后段（模块 07）
    '/api/purchase/chain/overview', '/api/purchase/chain/todos', '/api/purchase/chain/flow',
    '/api/purchase/catalog', '/api/purchase/price?sku_id=1',
    '/api/purchase/requisitions', '/api/purchase/invoices', '/api/purchase/settlements',
    '/api/purchase/payments', '/api/purchase/payables',
    '/api/purchase/invoices-available-lines?supplier_id=1',
    // 采购质检（模块 07）：读接口这里扫一遍，写接口在下面第 5c 段
    '/api/purchase/inspections', '/api/purchase/inspections/meta',
    '/api/purchase/inspections/overview', '/api/purchase/inspections/pending'
  ]) {
    const r = await hit('GET', p, tk, ind)
    const flag = r.status >= 500 ? '❌' : '  '
    console.log(`  ${flag}${String(r.status).padStart(3)}  [${ind}] ${p}`)
  }
}

// ---------- 5. 订货中心写链路（下单 → 审批 → 分仓 → 发货 → 收货 → 完成） ----------
// 只验读接口是不够的：订货中心的规则全在写路径上（取价、校验、审批、授信占用）。
// 这里用真实 HTTP 走一遍，确保路由层的权限、事务与错误映射都成立。
console.log('\n--- 订货中心写链路 ---')
{
  const tk = tokens.food || token
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}`, 'x-industry': 'food' }
  const post = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, body: j }
  }
  const get = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${tk}`, 'x-industry': 'food' } })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }

  const cl = await get('/api/order-center/customers?pageSize=50')
  const candidates = cl.body?.data?.list || []
  console.log(`  订货方候选 ${candidates.length} 个`)

  let orderId = null
  let used = null
  for (const c of candidates.slice(0, 12)) {
    const q = await post('/api/order-center/quote', { customer_id: c.id, items: [{ sku_id: 1, qty: 2 }] })
    if (q.status !== 200 || !q.body?.data?.check?.pass) continue
    const r = await post('/api/order-center/orders', { customer_id: c.id, items: [{ sku_id: 1, qty: 2 }] })
    if (r.status === 200 && r.body?.data?.order?.id) {
      orderId = r.body.data.order.id
      used = c
      console.log(`  ✓ 下单成功 ${r.body.data.order.doc_no}（${c.name}，¥${r.body.data.order.total_amount}）`)
      break
    }
  }
  if (!orderId) {
    console.log('  ✗ 未能在任何客户上下单成功（属异常）')
    results.server += 1
    bad.push(['POST', '/api/order-center/orders', 'NONE', '写链路'])
  } else {
    for (const action of ['approve', 'allocate', 'ship', 'receive', 'complete']) {
      const r = await post(`/api/order-center/orders/${orderId}/${action}`, {})
      const st = r.body?.data?.order?.status || r.body?.message || ''
      console.log(`  ${r.status === 200 ? '✓' : '✗'} ${action.padEnd(9)} → ${r.status} ${st}`)
      if (r.status !== 200) {
        results.client += 1
      }
      if (r.status >= 500) bad.push(['POST', `/api/order-center/orders/${orderId}/${action}`, r.status, '写链路'])
    }
    // 非法流转必须被拒（未审批就发货这种跳跃）
    const o2 = await post('/api/order-center/orders', { customer_id: used.id, items: [{ sku_id: 1, qty: 1 }] })
    if (o2.status === 200) {
      const bad2 = await post(`/api/order-center/orders/${o2.body.data.order.id}/ship`, {})
      console.log(`  ${bad2.status === 409 ? '✓' : '✗'} 跳跃流转被拒 → ${bad2.status} ${bad2.body?.message || ''}`)
      if (bad2.status !== 409) results.client += 1
    }
  }
}

// ---------- 5b. 采购域写链路（请购 → 审批 → 转单 → 发票 → 结算 → 付款核销） ----------
// 采购域的规则几乎全在写路径上：取价链、供货目录、起订量、超量控制、三单匹配、核销生效点。
// 这里用真实 HTTP 走一遍，确保路由层的权限、事务与错误映射都成立（不是只测 lib）。
// 采购域写链路
console.log('\n--- 采购域写链路 ---')
// 这一段产生的收货单要交给 5c 做质检链路（冒烟要能自己造出「待质检的到货单」，
// 否则质检段只能去啃演示数据，跑几次就把待质检队列啃空了）
let qcReceiptId = null
let qcSupplierId = null
{
  const tk = tokens.food || token
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}`, 'x-industry': 'food' }
  const post = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, body: j }
  }
  const get = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${tk}`, 'x-industry': 'food' } })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  // 5xx 必须计入异常统计，否则写链路的服务端错误会被「✓/✗ 只是 client」掩盖掉
  // （历史上踩过：收货接口 500 但总计仍显示 5xx 0）
  const mark = (okFlag, label, extra = '') => {
    console.log(`  ${okFlag ? '✓' : '✗'} ${label}${extra ? ' → ' + extra : ''}`)
    if (!okFlag) {
      results.client += 1
      if (/\s5\d\d(\s|$)/.test(` ${extra} `)) {
        results.server += 1
        bad.push(['CHAIN', label, 500, '写链路'])
      }
    }
  }

  // 拿一条供货目录作为请购来源（保证转单不会被目录/起订量拦掉）
  const cat = await get('/api/purchase/catalog?pageSize=50')
  const catRows = cat.body?.data?.list || cat.body?.data?.rows || []
  const pick = catRows.find((x) => x.is_available && x.min_order_qty >= 0) || catRows[0]
  // 转单必须指定入库仓，否则会被 PRQ_WAREHOUSE_REQUIRED 挡回来
  const whRes = await get('/api/master/warehouses')
  const whs = whRes.body?.data?.list || whRes.body?.data || []
  const whId = whs[0]?.id
  if (!pick) {
    mark(false, '供货目录为空，无法继续采购写链路')
  } else if (!whId) {
    mark(false, '未能取到仓库，无法验证转单')
  } else {
    const qty = Math.max(Number(pick.min_order_qty || 0), 5)
    const create = await post('/api/purchase/requisitions', {
      supplier_id: pick.supplier_id,
      warehouse_id: whId,
      applicant_type: 'org',
      applicant_name: '冒烟测试',
      purpose: '补货',
      lines: [{ sku_id: pick.sku_id, qty, price: pick.price }]
    })
    const req = create.body?.data?.requisition || create.body?.data?.req || create.body?.data
    if (create.status !== 200 || !req?.id) {
      mark(false, '新建请购单', `${create.status} ${create.body?.message || ''}`)
    } else {
      mark(true, `新建请购单 ${req.doc_no}`, `¥${req.total_amount}`)
      let r = await post(`/api/purchase/requisitions/${req.id}/submit`, {})
      mark(r.status === 200, '提交请购', `${r.status}`)
      r = await post(`/api/purchase/requisitions/${req.id}/approve`, {})
      mark(r.status === 200, '审批请购', `${r.status}`)
      const cv = await post(`/api/purchase/requisitions/${req.id}/convert`, {})
      const orderId = cv.body?.data?.order_id || cv.body?.data?.order?.id
      mark(cv.status === 200 && !!orderId, '转采购订单', `${cv.status} ${cv.body?.data?.order_no || ''}`)
      if (orderId) {
        const cl = await get(`/api/purchase/orders/${orderId}/closes`)
        mark(cl.status === 200, '四段关闭可读',
          cl.body?.data ? JSON.stringify(cl.body.data).slice(0, 90) : '')
        // 超量校验：写库前拦（这里故意报一个远大于订单量的数量）
        const chk = await post(`/api/purchase/orders/${orderId}/receive-check`, { lines: [{ sku_id: pick.sku_id, qty: 999999 }] })
        mark(chk.status === 200 && chk.body?.data?.ok === false, '超量校验拦下超收',
          `${chk.status} ok=${chk.body?.data?.ok}`)
        // 草稿采购订单直接收货必须被拒
        const jump = await post(`/api/purchase/orders/${orderId}/receive`, {})
        mark(jump.status === 400, '草稿订单直接收货被拒', `${jump.status} ${jump.body?.message || ''}`)
        // 走正规链路：提交 → 收货入库（这才算真的有「可结算的入库单」）
        const sb = await post(`/api/purchase/orders/${orderId}/status`, { action: 'submit' })
        mark(sb.status === 200, '采购订单提交', `${sb.status} ${sb.body?.data?.status || ''}`)
        const rc = await post(`/api/purchase/orders/${orderId}/receive`, {})
        mark(rc.status === 200, '收货入库（生成收货单 + 批次）', `${rc.status} ${rc.body?.data?.doc_no || ''}`)
        qcReceiptId = rc.body?.data?.receipt_id || null
        qcSupplierId = pick.supplier_id
        // 结算 → 审核 → 付款核销：用刚收到的这批货，避免依赖演示数据里是否还有未结算入库
        const st = await post('/api/purchase/settlements', {
          supplier_id: pick.supplier_id, settle_mode: 'manual', remark: '冒烟测试结算'
        })
        const sid = st.body?.data?.id
        const sidNo = st.body?.data?.doc_no || ''
        mark(st.status === 200 && !!sid, '生成结算单', `${st.status} ${sidNo}`)
        if (sid) {
          await post(`/api/purchase/settlements/${sid}/submit`, {})
          const au = await post(`/api/purchase/settlements/${sid}/audit`, {})
          mark(au.status === 200, '结算单审核', `${au.status}`)
          const detail = await get(`/api/purchase/settlements/${sid}`)
          const open = Number(detail.body?.data?.open_amount || 0)
          mark(detail.status === 200 && open > 0, '结算单详情报出未结清金额', `open=${open}`)
          if (open > 0) {
            const plan = await get(`/api/purchase/payment-plan?supplier_id=${pick.supplier_id}&amount=100`)
            mark(plan.status === 200, 'FIFO 核销计划可读',
              `未付合计 ${plan.body?.data?.open_total}，计划 ${(plan.body?.data?.plan || []).length} 条`)
            const pay = await post('/api/purchase/payments', {
              supplier_id: pick.supplier_id, amount: Math.min(open, 100), remark: '冒烟测试付款'
            })
            const pid = pay.body?.data?.id
            mark(pay.status === 200 && !!pid, '新建付款单（FIFO 自动核销）', `${pay.status} ${pay.body?.data?.doc_no || ''}`)
            if (pid) {
              // 草稿付款单直接执行付款 → 应被拒（核销生效前必须先审批）
              const bad = await post(`/api/purchase/payments/${pid}/pay`, {})
              mark(bad.status === 409, '草稿付款单直接执行付款被拒', `${bad.status}`)
              const sub = await post(`/api/purchase/payments/${pid}/submit`, {})
              mark(sub.status === 200, '提交付款单（核销生效）', `${sub.status}`)
              const pd = await get(`/api/purchase/payments/${pid}`)
              mark(pd.status === 200, '付款单详情可读', `已核销 ${pd.body?.data?.settled_amount ?? ''}`)
            }
          }
        }
      }
    }
  }
}

// ---------- 5c. 采购质检写链路（到货 → 建质检单 → 提交判退 → 生成退货单） ----------
// 这一段是**补上来的**，起因是一个真实的漏网 bug：
//   质检路由把 createInspection 的返回值（整张单对象）当成 id 又丢回 getInspection，
//   better-sqlite3 收到对象后按命名参数处理，撞上匿名 `?` 抛
//   RangeError: Too few parameter values were provided —— 报错信息与真实原因毫无关系。
// 它为什么没被测出来：GET 全量扫描只打 item.get，写链路里当时没有质检这一段，
// 而 lib 层单测直接调 createInspection 用的是返回值本身、根本不经过路由。
// 教训：**路由层的错必须由路由层的测试来抓**。以后新增写接口，都要在这里留一段。
console.log('\n--- 采购质检写链路 ---')
{
  const tk = tokens.food || token
  const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${tk}`, 'x-industry': 'food' }
  const post = async (p, body) => {
    const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: H, body: JSON.stringify(body || {}) })
    const j = await r.json().catch(() => ({}))
    return { status: r.status, body: j }
  }
  const get = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: { Authorization: `Bearer ${tk}`, 'x-industry': 'food' } })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const mark = (okFlag, label, extra = '') => {
    console.log(`  ${okFlag ? '✓' : '✗'} ${label}${extra ? ' → ' + extra : ''}`)
    if (!okFlag) {
      results.client += 1
      if (/\s5\d\d(\s|$)/.test(` ${extra} `)) {
        results.server += 1
        bad.push(['QC', label, 500, '质检写链路'])
      }
    }
  }

  if (!qcReceiptId) {
    mark(false, '没有可质检的到货单（上一段收货未拿到 receipt_id），质检链路未验证')
  } else {
    // ① 装填：质检岗一屏填完靠它（到货事实 + 已有草稿）
    const fill = await get(`/api/purchase/inspections/receipt/${qcReceiptId}`)
    const lines = fill.body?.data?.items || []
    mark(fill.status === 200 && lines.length > 0, '到货单装填（载出明细行）', `${fill.status} 行数 ${lines.length}`)

    if (!lines.length) {
      mark(false, '装填没拿到明细行，质检无法继续')
    } else {
      const first = lines[0]
      const qty = Number(first.qty)
      // ② 不闭合必须被拦：合格数少 1 且没有让步/判退去补 —— 那件货会凭空消失。
      //    这一条同时验证路由的 guard() 把 QCError 正确映射成了 400 + 业务错误码。
      //    注意错误码位置：顶层 code 是数字（0 成功 / 1 失败），业务码在 detail.code 里。
      const bad1 = await post('/api/purchase/inspections', {
        receipt_id: qcReceiptId,
        items: [{ receipt_item_id: first.id, qualified_qty: qty - 1, concession_qty: 0, rejected_qty: 0 }]
      })
      mark(
        bad1.status === 400 && bad1.body?.detail?.code === 'QC_NOT_CLOSED',
        '三数不闭合被拦（且不留下半张单）',
        `${bad1.status} ${bad1.body?.detail?.code || bad1.body?.message || ''}`
      )

      // ③ 建单带明细：第一行判退 1 件，其余全合格（判退 ≥ 1 才能走到「退货单」那条路）
      const rej = 1
      const okQty = round2(qty - rej)
      const created = await post('/api/purchase/inspections', {
        receipt_id: qcReceiptId,
        items: [
          {
            receipt_item_id: first.id, qualified_qty: okQty, concession_qty: 0, rejected_qty: rej,
            defect_code: 'appearance', defect_reason: '冒烟测试：外观不良'
          },
          ...lines.slice(1).map((l) => ({
            receipt_item_id: l.id, qualified_qty: Number(l.qty), concession_qty: 0, rejected_qty: 0
          }))
        ]
      })
      const ins = created.body?.data
      mark(
        created.status === 200 && !!ins?.id,
        '建质检单（带明细）',
        `${created.status} ${ins?.doc_no || created.body?.message || ''}`
      )
      mark(
        (ins?.items || []).length === lines.length,
        '质检单行数与到货行数一致',
        `${(ins?.items || []).length} / ${lines.length}`
      )
      // 建单是「纯写」动作，不该把结论定下来
      mark(ins?.status === 'draft' && ins?.result === 'pending', '建单后停在草稿、结论未定',
        `status=${ins?.status} result=${ins?.result}`)

      if (!ins?.id) {
        mark(false, '建单失败，后面的提交无法验证')
      } else {
        // ④ 同票重复建单必须被拒（uq_inspection_receipt）
        const dup = await post('/api/purchase/inspections', { receipt_id: qcReceiptId })
        mark(
          dup.status === 409 && dup.body?.detail?.code === 'QC_DUPLICATE',
          '同票重复建单被拒', `${dup.status} ${dup.body?.detail?.code || dup.body?.message || ''}`
        )

        // ⑤ 详情可读（含明细与流转留痕）
        const detail = await get(`/api/purchase/inspections/${ins.id}`)
        const insLines = detail.body?.data?.items || []
        mark(detail.status === 200 && insLines.length > 0, '质检单详情可读（明细 + 留痕）',
          `${detail.status} 行数 ${insLines.length} 留痕 ${(detail.body?.data?.events || []).length} 条`)

        // ⑥ 提交质检结论。**lines[].id 要的是质检行 id，不是到货行 id** ——
        //    传错不会报错，只会静默覆盖不上（这个坑踩过，所以这里显式断言结论真的变了）
        const sub = await post(`/api/purchase/inspections/${ins.id}/submit`, {
          lines: [{
            id: insLines[0]?.id, qualified_qty: okQty, concession_qty: 0, rejected_qty: rej,
            defect_reason: '冒烟测试：外观不良'
          }],
          remark: '冒烟测试提交'
        })
        const sd = sub.body?.data
        mark(sub.status === 200 && sd?.status === 'inspected', '提交质检结论（草稿 → 已质检）',
          `${sub.status} ${sd?.status || sub.body?.message || ''}`)
        mark(Number(sd?.rejected_qty || 0) === rej, '判退数量落到单头', `rejected_qty=${sd?.rejected_qty}`)
        mark(['partial_rejected', 'rejected'].includes(sd?.result), '结论由数字推导（有判退就不是「全部合格」）',
          `result=${sd?.result}`)
        // 判退必须**有后果**：生成采购退货单并反向出库。只改状态的质检只是一张纸。
        mark(/^RT/.test(sd?.return_created?.doc_no || ''), '判退有后果：生成采购退货单（RT）',
          `${sd?.return_created?.doc_no || '未生成'} ${sub.status}`)
        mark(!!sd?.return_no && sd.return_no === sd?.return_created?.doc_no, '退货单号回写到质检单',
          `${sd?.return_no || ''}`)

        // ⑦ 已出结论的单不能再提交（非法流转归内核管）
        const again = await post(`/api/purchase/inspections/${ins.id}/submit`, {})
        mark(again.status === 409, '已质检的单重复提交被拒', `${again.status} ${again.body?.message || ''}`)

        // ⑧ 到货单必须跟着走到「已质检」——
        //    否则就是那种「状态说检过了，但查不到谁检的、怎么判的」
        const rcAfter = await get(`/api/purchase/receipts/${qcReceiptId}`)
        mark(rcAfter.body?.data?.status === 'inspected', '到货单联动为已质检',
          `${rcAfter.status} ${rcAfter.body?.data?.status || ''}`)

        // ⑨ 刚出过结论的到货单不该还躺在待质检队列里
        //    （口径：没有「已出结论」的质检单才算待质检，草稿仍算待质检）
        const pendAfter = await get('/api/purchase/inspections/pending?limit=500')
        const still = (pendAfter.body?.data?.list || []).find((x) => Number(x.id) === Number(qcReceiptId))
        mark(!still, '已出结论的到货单不再出现在待质检队列',
          still ? `仍在队列：${still.doc_no}${still.draft_no ? '（草稿 ' + still.draft_no + '）' : ''}` : '')
      }
    }
  }

  // ⑩ 概览：指标要能算出来（算不出来就该返回空而不是 0，这里只看接口是否成立）
  const ov = await get('/api/purchase/inspections/overview')
  mark(ov.status === 200, '质检概览可读',
    `总数 ${ov.body?.data?.total}、待提交 ${ov.body?.data?.draft_ready}、判退率 ${ov.body?.data?.reject_rate}%`)
  const pend = await get('/api/purchase/inspections/pending')
  mark(pend.status === 200 && Array.isArray(pend.body?.data?.list), '待质检队列可读',
    `${(pend.body?.data?.list || []).length} 张`)
}

// ---------- 6. 结存与成本抽样（引擎结果合理性） ----------
console.log('\n--- 库存引擎结果抽样 ---')

// ---------- 7. 营销域返回**形状**（模块 18） ----------
//
// 为什么单独查形状：`/promo/overview` 曾经漏了一个 `.all()`，`by_level` 于是不是数组
// 而是 better-sqlite3 的 Statement 对象。HTTP 200、字段名也在、控制台不报错 ——
// 但前端 `by_level.map` 直接抛异常把整页打崩（表现是"点哪个页签都不动"）。
// 这类"形状对但类型错"的返回，只有断言到**类型**才抓得住，只看状态码是抓不住的。
console.log('\n--- 营销域返回形状（模块 18） ---')
{
  const tk = tokens.cosmetic || token
  const H = { Authorization: `Bearer ${tk}`, 'x-industry': 'cosmetic' }
  const get = async (p) => {
    const r = await fetch(`${BASE}${p}`, { headers: H })
    return { status: r.status, body: await r.json().catch(() => ({})) }
  }
  const mark = (okFlag, label, extra = '') => {
    console.log(`  ${okFlag ? '✓' : '✗'} ${label}${extra ? ' → ' + extra : ''}`)
    if (!okFlag) { results.client += 1; bad.push(['PROMO', label, 200, '营销域形状']) }
  }

  const ov = await get('/api/promo/overview')
  const d = ov.body?.data || {}
  mark(ov.status === 200, '营销总览可读')
  mark(Array.isArray(d.members?.by_level), 'overview.members.by_level 是数组',
    `实际 ${Array.isArray(d.members?.by_level) ? `${d.members.by_level.length} 个等级` : typeof d.members?.by_level}`)
  mark(typeof d.promotions?.total === 'number' && typeof d.coupons?.total === 'number',
    'overview 的计数是数字（不是 null / 对象）',
    `促销 ${d.promotions?.total}、券 ${d.coupons?.total}`)

  const meta = await get('/api/promo/meta')
  mark(meta.status === 200 && Array.isArray(meta.body?.data?.levels) && Array.isArray(meta.body?.data?.settings),
    '字典 meta 的 levels / settings 都是数组',
    `levels ${meta.body?.data?.levels?.length}、settings ${meta.body?.data?.settings?.length}`)

  const lv = await get('/api/promo/levels')
  mark(Array.isArray(lv.body?.data) && lv.body.data.length >= 4, '会员等级至少四档',
    `${lv.body?.data?.length} 档`)

  const pm = await get('/api/promo/promotions?page=1&pageSize=5')
  mark(Array.isArray(pm.body?.data?.list) && typeof pm.body?.data?.total === 'number',
    '促销列表返回 {list[], total}', `list ${pm.body?.data?.list?.length} / total ${pm.body?.data?.total}`)

  // 分页参数名必须是**蛇形**才生效（写成驼峰会静默返回全量，页面筛选看起来"没反应"）
  const mem = await get('/api/promo/members?level_code=normal&page=1&pageSize=100')
  const onlyNormal = (mem.body?.data?.list || []).every((m) => m.level_code === 'normal')
  mark(mem.status === 200 && onlyNormal, 'members 的 level_code 筛选真的生效（蛇形参数名）',
    `命中 ${(mem.body?.data?.list || []).length} 人`)

  // 自洽审计必须是"通过"——它同时兜住余额=流水、券超发、用量计数漂移三类静默错
  const audit = await get('/api/promo/audit')
  mark(audit.body?.data?.ok === true, '营销自洽审计通过（余额=流水 / 券不超发 / 计数不漂移）',
    audit.body?.data?.ok ? '' : JSON.stringify(audit.body?.data).slice(0, 200))
}


console.log(`\n${'─'.repeat(56)}`)
console.log(`2xx ${results.ok} / 4xx ${results.client} / 5xx ${results.server} / 异常 ${results.other}`)
if (bad.length) {
  console.log('\n异常明细：')
  for (const [m, p, s, l] of bad) console.log(`  ${m} ${p} → ${s} ${l}`)
}

srv.kill('SIGKILL')
setTimeout(() => process.exit(bad.length ? 1 : 0), 300)
