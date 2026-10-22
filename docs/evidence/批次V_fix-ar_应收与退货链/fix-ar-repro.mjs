// 批次 V · 修复反例（S-1 / S-2 / S-3 / S-4 / S-5 / S-8 / S-10）
// 隔离库：GML_DATA_DIR=/tmp/fix-ar-db   独立端口：PORT=44011
// 用法：GML_DATA_DIR=/tmp/fix-ar-db node /tmp/fix-ar-repro.mjs
//
// 只做「让缺陷变红」的断言 —— 修复前跑出一片 ✗，修复后全 ✓。
// 全程只读夹具（不直接写库），写入一律走被测接口。
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'

const ROOT = process.env.REPRO_ROOT || '/Users/linxinlan/工作文档/gml'
const Database = createRequire(`${ROOT}/package.json`)('better-sqlite3')
const PORT = 44011
const BASE = `http://127.0.0.1:${PORT}`
const DATA_DIR = process.env.REPRO_DATA || '/tmp/fix-ar-db'
const INDUSTRY = process.env.REPRO_INDUSTRY || 'cosmetic'
const ONLY = process.env.REPRO_ONLY || ''

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) {
    pass++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail++
    failures.push(name)
    console.log(`  \x1b[31m✗ ${name}${detail !== undefined ? '  → ' + String(detail).slice(0, 300) : ''}\x1b[0m`)
  }
}
const caseStart = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

const srv = spawn(process.execPath, ['server/index.js'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), GML_DATA_DIR: DATA_DIR },
  stdio: ['ignore', 'pipe', 'pipe']
})
let log = ''
srv.stdout.on('data', (d) => (log += d.toString()))
srv.stderr.on('data', (d) => (log += d.toString()))
const started = Date.now()
const ready = await new Promise((resolve) => {
  const t = setInterval(() => {
    if (log.includes('服务已启动')) {
      clearInterval(t)
      resolve(true)
    } else if (Date.now() - started > 120000) {
      clearInterval(t)
      resolve(false)
    }
  }, 300)
})
if (!ready) {
  console.log('服务未能启动，日志尾部：\n' + log.split('\n').slice(-30).join('\n'))
  srv.kill('SIGKILL')
  process.exit(1)
}
console.log(`服务已启动 :${PORT}  data=${DATA_DIR} industry=${INDUSTRY}`)

const db = new Database(`${DATA_DIR}/gml_${INDUSTRY}.db`, { readonly: true })
// 夹具用：可写连接（**只连 /tmp 副本**，绝不连 data/）
const wdb = new Database(`${DATA_DIR}/gml_${INDUSTRY}.db`)
const q1 = (sql, ...a) => db.prepare(sql).get(...a)

let token = ''
async function api(method, p, body, tk = token) {
  const res = await fetch(`${BASE}${p}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(tk ? { Authorization: `Bearer ${tk}` } : {}),
      'x-industry': INDUSTRY
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {}
  return { status: res.status, body: json }
}

const login = await api('POST', '/api/auth/login', { username: 'admin', password: '12345', industry: INDUSTRY }, '')
if (login.status !== 200) {
  console.log('登录失败', JSON.stringify(login.body).slice(0, 300))
  srv.kill('SIGKILL')
  process.exit(1)
}
token = login.body.data.token
const today = new Date().toISOString().slice(0, 10)
const want = (k) => !ONLY || ONLY === k

const wh = q1("SELECT id FROM warehouses WHERE status='active' AND type='central' ORDER BY id LIMIT 1")
const rich = q1(
  `SELECT sku_id, SUM(qty_on_hand - qty_reserved) free FROM inventory_stocks
    WHERE warehouse_id=? GROUP BY sku_id ORDER BY free DESC LIMIT 1`,
  wh.id
)
const store = q1("SELECT id FROM stores WHERE status='active' ORDER BY id LIMIT 1")
const dealer = q1('SELECT id, name FROM dealers ORDER BY id LIMIT 1')

/** 造一张"订单 → 确认 → 发货"的自有单 */
async function makeShippedOrder(qty, price, tag) {
  const c = await api('POST', '/api/sales/orders', {
    channel: 'store',
    store_id: store.id,
    order_date: today,
    warehouse_id: wh.id,
    items: [{ sku_id: rich.sku_id, qty, price }],
    remark: tag
  })
  if (c.status !== 200) throw new Error('建单失败 ' + JSON.stringify(c.body).slice(0, 200))
  const id = c.body.data.id
  const cf = await api('POST', `/api/sales/orders/${id}/confirm`, {})
  if (cf.status !== 200) throw new Error('确认失败 ' + JSON.stringify(cf.body).slice(0, 200))
  const dl = await api('POST', `/api/sales/orders/${id}/deliver`, { delivery_date: today, warehouse_id: wh.id })
  if (dl.status !== 200) throw new Error('发货失败 ' + JSON.stringify(dl.body).slice(0, 200))
  return { id, deliveryId: dl.body.data.delivery_id, detail: dl.body.data.order }
}
async function invoiceAll(deliveryId, items = null) {
  const inv = await api('POST', '/api/invoices/from-delivery', { delivery_id: deliveryId, items, tax_rate: 0.13 })
  if (inv.status !== 200) return { inv }
  const id = inv.body.data.id
  await api('POST', `/api/invoices/${id}/submit`, {})
  const cf = await api('POST', `/api/invoices/${id}/confirm`, {})
  return { inv, id, confirm: cf }
}

// ---------------------------------------------------------------------------
// S-5
// ---------------------------------------------------------------------------
if (want('S5')) {
  caseStart('S-5 /api/ar/documents/generate 应返回 200（坏列名 dealer_name/store_name 会 500）')
  const dOrder = q1('SELECT id FROM sales_orders WHERE dealer_id IS NOT NULL ORDER BY id LIMIT 1')
  const sOrder = q1('SELECT id FROM sales_orders WHERE dealer_id IS NULL AND store_id IS NOT NULL ORDER BY id LIMIT 1')
  const r = await api('POST', '/api/ar/documents/generate', { items: [{ id: dOrder.id }, { id: sOrder.id }] })
  ok(`POST /api/ar/documents/generate → 200（实测 ${r.status}）`, r.status === 200, JSON.stringify(r.body).slice(0, 220))
}

// ---------------------------------------------------------------------------
// S-8
// ---------------------------------------------------------------------------
if (want('S8')) {
  caseStart('S-8 对账单应把同一个经销商的 dealer 主体与 oc 主体合并')
  const pair = q1(
    `SELECT oc.source_id AS dealer_id, d.name,
            IFNULL((SELECT SUM(amount-allocated_amount) FROM ar_documents WHERE subject_type='dealer' AND subject_id=oc.source_id AND status IN ('open','partial')),0) AS dealer_bal,
            IFNULL((SELECT SUM(amount-allocated_amount) FROM ar_documents WHERE subject_type='oc' AND subject_id=oc.id AND status IN ('open','partial')),0) AS oc_bal
       FROM oc_customers oc JOIN dealers d ON d.id=oc.source_id
      WHERE oc.source_type='dealer'
        AND (SELECT COUNT(*) FROM ar_documents WHERE subject_type='oc' AND subject_id=oc.id AND status IN ('open','partial')) > 0
        AND (SELECT COUNT(*) FROM ar_documents WHERE subject_type='dealer' AND subject_id=oc.source_id AND status IN ('open','partial')) > 0
      ORDER BY oc.id LIMIT 1`
  )
  if (!pair) {
    ok('找到一套被拆开的经销商主体（样本）', false, '库里没有同时挂 dealer+oc 未结余额的经销商')
  } else {
    const expect = Number((Number(pair.dealer_bal) + Number(pair.oc_bal)).toFixed(2))
    const st = await api('GET', `/api/ar/statement?subject_type=dealer&subject_id=${pair.dealer_id}`)
    const bal = Number(st.body?.data?.balance || 0)
    console.log(`    ${pair.name}（dealer#${pair.dealer_id}）：dealer 主体 ${pair.dealer_bal} + oc 主体 ${pair.oc_bal} = ${expect}`)
    ok(`对账单余额并入 oc 主体（期望 ${expect}，实测 ${bal}）`, Math.abs(bal - expect) <= 0.05, `statement 返回 ${bal}`)
    const subj = await api('GET', '/api/ar/aging/subjects')
    const row = (subj.body?.data?.rows || []).find(
      (x) => x.subject_type === 'dealer' && Number(x.subject_id) === Number(pair.dealer_id)
    )
    ok(
      `账龄榜按主体合并（期望 >= ${pair.dealer_bal}）`,
      !!row && Number(row.balance) >= Number(pair.dealer_bal) - 0.01,
      row ? `实测 ${row.balance}` : '缺该主体行'
    )
  }
}

// ---------------------------------------------------------------------------
// S-2
// ---------------------------------------------------------------------------
if (want('S2')) {
  caseStart('S-2 同一订单只应有一笔应收（开票 + 订单回款不得各建一张）')
  const o = await makeShippedOrder(2, 100, '__FIXAR__S2')
  const r = await invoiceAll(o.deliveryId)
  ok('由发货单开票并确认', r.confirm?.status === 200, JSON.stringify(r.confirm?.body).slice(0, 200))
  const pay = await api('POST', `/api/sales/orders/${o.id}/payment`, { amount: 50 })
  ok('订单回款', pay.status === 200, JSON.stringify(pay.body).slice(0, 200))
  const ars = db
    .prepare(
      `SELECT * FROM ar_documents WHERE (source_type='SO' AND source_id=?)
         OR (source_type='SI' AND source_id IN (SELECT id FROM sales_invoices WHERE order_id=?))`,
    )
    .all(o.id, o.id)
  const sum = ars.reduce((s, x) => s + Number(x.amount), 0)
  ok(
    `该订单的应收单数 = 1（实测 ${ars.length}：${ars.map((a) => a.doc_no + '/' + a.source_type).join(', ')}）`,
    ars.length === 1,
    `合计应收 ${sum}`
  )
  ok(
    `该订单累计应收未被翻倍（订单应收 ${o.detail.receivable_amount}，累计 ${sum.toFixed(2)}）`,
    sum <= Number(o.detail.receivable_amount) + 0.05,
    `翻倍后 ${sum}`
  )
}

// ---------------------------------------------------------------------------
// S-3
// ---------------------------------------------------------------------------
if (want('S3')) {
  caseStart('S-3 红冲后剩余可开量应回到 2（不得变成 4），且不得真开出 4 件')
  const o = await makeShippedOrder(2, 100, '__FIXAR__S3')
  const r = await invoiceAll(o.deliveryId)
  ok('发货 2 件全部开票并确认', r.confirm?.status === 200, JSON.stringify(r.confirm?.body).slice(0, 200))
  const red = await api('POST', `/api/invoices/${r.id}/red-chart`, { reason: '__FIXAR__ 红冲反例' })
  ok('红冲成功', red.status === 200, JSON.stringify(red.body).slice(0, 200))
  const pend = await api('GET', `/api/invoices/pending/${o.deliveryId}`)
  const line = (pend.body?.data?.lines || [])[0]
  const remain = line ? Number(line.remain_qty) : pend.body?.data?.remain_total
  console.log(`    发货 2 / 开票 2 / 红冲 → 剩余可开 ${remain}`)
  ok(`红冲后剩余可开量 = 2（实测 ${remain}）`, Number(remain) === 2, `实测 ${remain}`)
  const over = await api('POST', '/api/invoices/from-delivery', {
    delivery_id: o.deliveryId,
    items: [{ item_id: line?.item_id, qty: 4 }],
    tax_rate: 0.13
  })
  ok(`对"剩余 2 件"强行开 4 件应被拒（实测 ${over.status}）`, over.status >= 400, JSON.stringify(over.body).slice(0, 220))
}

// ---------------------------------------------------------------------------
// S-1
// ---------------------------------------------------------------------------
if (want('S1')) {
  caseStart('S-1① 该订单有应收、一分未收 ⇒ 退货应退 0，且应收被冲减')
  const o = await makeShippedOrder(2, 100, '__FIXAR__S1a')
  const item = o.detail.items[0]
  const netPrice = Number((Number(item.amount) / Number(item.qty)).toFixed(2))
  const r = await invoiceAll(o.deliveryId)
  ok('夹具：开票并确认（SO 口径下应收落在订单上）', r.confirm?.status === 200, JSON.stringify(r.confirm?.body).slice(0, 200))
  const arsBefore = db
    .prepare(
      `SELECT * FROM ar_documents WHERE (source_type='SO' AND source_id=?)
         OR (source_type='SI' AND source_id IN (SELECT id FROM sales_invoices WHERE order_id=?))`,
    )
    .all(o.id, o.id)
  console.log(`    夹具：该订单应收 ${arsBefore.map((a) => a.doc_no + '/' + a.source_type + '/' + a.amount).join(' + ')}（已收 ${arsBefore.reduce((s, a) => s + a.allocated_amount, 0)}）`)
  const rt = await api('POST', '/api/sales/returns', {
    order_id: o.id,
    reason: '__FIXAR__ S1① 开票未回款退货',
    items: [{ order_item_id: item.id, qty: 1 }]
  })
  ok('退货单创建成功', rt.status === 200, JSON.stringify(rt.body).slice(0, 220))
  const d = rt.body?.data || {}
  console.log(`    退 1 件（${netPrice} 元）→ refund_due=${d.refund_due}  ar_offset=${d.ar_offset_amount}  ar_id=${d.ar_id}`)
  ok(`未收款退货的 refund_due = 0（实测 ${d.refund_due}）`, Number(d.refund_due || 0) === 0, `refund_due=${d.refund_due}`)
  ok(`原应收被冲减（实测 offset=${d.ar_offset_amount}）`, Number(d.ar_offset_amount || 0) > 0, `offset=${d.ar_offset_amount}`)
  const sumAfter = db
    .prepare(
      `SELECT IFNULL(SUM(amount),0) s FROM ar_documents WHERE (source_type='SO' AND source_id=?)
         OR (source_type='SI' AND source_id IN (SELECT id FROM sales_invoices WHERE order_id=?))`,
    )
    .get(o.id, o.id).s
  const sumBefore = arsBefore.reduce((s, a) => s + Number(a.amount), 0)
  ok(
    '应收金额确实变小（减少额 ≈ 退货额）',
    Math.abs(sumBefore - Number(sumAfter) - netPrice) <= 0.05,
    `${sumBefore} → ${sumAfter}（退 1 件 ${netPrice} 元）`
  )
  // 钱的出口：退货单上登记的 refund_due 是退款单的唯一上限（lib/refund.js planRefund）。
  // 未收款退货若登记了 refund_due，退款就能被创建并确认 —— 钱真的出账。
  const rf = await api('POST', '/api/refunds', { items: [{ return_id: d.id, amount: netPrice }], method: 'bank' })
  let confirmed = null
  if (rf.status === 200) confirmed = (await api('POST', `/api/refunds/${rf.body?.data?.id}/confirm`, {})).status
  console.log(`    拿这张退货单去退款：POST /api/refunds → ${rf.status}${confirmed ? ` / confirm → ${confirmed}` : ''}`)
  ok(
    `未收款退货**不能退出现金**（退款请求应被拒，实测 ${rf.status}）`,
    rf.status >= 400,
    `退款被创建（${rf.status}${confirmed ? ` 且确认 ${confirmed} ⇒ 钱真的出账` : ''}）`
  )

  caseStart('S-1② 该订单根本没有应收 ⇒ 退货 refund_due 必须恒为 0')
  const o2 = q1(
    `SELECT o.id, o.doc_no FROM sales_orders o
      WHERE EXISTS (SELECT 1 FROM sales_order_items i WHERE i.order_id=o.id AND i.shipped_qty>0)
        AND NOT EXISTS (SELECT 1 FROM ar_documents a WHERE a.source_type='SO' AND a.source_id=o.id)
        AND NOT EXISTS (SELECT 1 FROM sales_invoices si WHERE si.order_id=o.id)
      ORDER BY o.id LIMIT 1`
  )
  ok('找到一张有已发行、且完全没有应收的订单（样本）', !!o2, o2 && o2.doc_no)
  const it2 = q1('SELECT * FROM sales_order_items WHERE order_id=? AND shipped_qty>0 ORDER BY id LIMIT 1', o2.id)
  const rt2 = await api('POST', '/api/sales/returns', {
    order_id: o2.id,
    reason: '__FIXAR__ S1② 无应收退货',
    items: [{ order_item_id: it2.id, qty: 1 }]
  })
  ok('退货单创建成功', rt2.status === 200, JSON.stringify(rt2.body).slice(0, 220))
  const d2 = rt2.body?.data || {}
  console.log(`    ${o2.doc_no} 无应收退 1 件 → refund_due=${d2.refund_due}`)
  ok(`无应收时 refund_due = 0（实测 ${d2.refund_due}）`, Number(d2.refund_due || 0) === 0, `refund_due=${d2.refund_due}`)
}

// ---------------------------------------------------------------------------
// S-4
// ---------------------------------------------------------------------------
if (want('S4')) {
  caseStart('S-4 部分退货不得把整单打成终态 returned（剩余欠发还要能走完）')
  const cand = q1(
    `SELECT o.id, o.doc_no, o.status,
            (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id=o.id AND i.shipped_qty>0) lines,
            (SELECT SUM(i.shipped_qty) FROM sales_order_items i WHERE i.order_id=o.id) shipped
       FROM sales_orders o
      WHERE o.status IN ('shipped','completed')
        AND (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id=o.id AND i.shipped_qty>0) >= 2
      ORDER BY o.id LIMIT 1`
  )
  const line0 = cand && q1('SELECT * FROM sales_order_items WHERE order_id=? AND shipped_qty>0 ORDER BY id LIMIT 1', cand.id)
  ok('找到一张多行已发订单（样本）', !!cand && !!line0, cand && cand.doc_no)
  const rt = await api('POST', '/api/sales/returns', {
    order_id: cand.id,
    reason: '__FIXAR__ S4 部分退货',
    items: [{ order_item_id: line0.id, qty: 1 }]
  })
  ok('部分退货成功', rt.status === 200, JSON.stringify(rt.body).slice(0, 220))
  const stdb = q1('SELECT status FROM sales_orders WHERE id=?', cand.id)
  console.log(`    ${cand.doc_no}（${cand.lines} 行已发 / 共 ${cand.shipped} 件）只退第 1 行 1 件 → 订单状态 ${stdb.status}`)
  ok(`部分退货后订单不应变 returned（实测 ${stdb.status}）`, stdb.status !== 'returned', `被推成 ${stdb.status}（终态，链断）`)
  const cp = await api('POST', `/api/sales/orders/${cand.id}/complete`, {})
  ok(`之后"完成"应可执行（实测 ${cp.status}）`, cp.status === 200, JSON.stringify(cp.body).slice(0, 220))
}

// ---------------------------------------------------------------------------
// S-10
// ---------------------------------------------------------------------------
if (want('S10')) {
  caseStart('S-10 冲减应收 / 红冲作废应收都要在 doc_events 留痕')
  const so = q1(
    `SELECT i.*, o.id AS oid, o.doc_no FROM sales_order_items i
       JOIN sales_orders o ON o.id=i.order_id
       JOIN ar_documents a ON a.source_type='SO' AND a.source_id=o.id AND a.status IN ('open','partial')
      WHERE o.status IN ('shipped','completed') AND i.shipped_qty > 0
      ORDER BY i.id LIMIT 1`
  )
  ok('找到"已发 + 挂着未结 SO 应收"的订单行（样本）', !!so, so && so.doc_no)
  if (so) {
    const ar = q1("SELECT * FROM ar_documents WHERE source_type='SO' AND source_id=? AND status IN ('open','partial')", so.oid)
    const ev0 = q1("SELECT COUNT(*) c FROM doc_events WHERE doc_type='AR' AND doc_id=?", ar.id).c
    const rt = await api('POST', '/api/sales/returns', {
      order_id: so.oid,
      reason: '__FIXAR__ S10 冲减留痕',
      items: [{ order_item_id: so.id, qty: 1 }]
    })
    ok('退货（含应收冲减）成功', rt.status === 200, JSON.stringify(rt.body).slice(0, 200))
    ok('确实发生了冲减', Number(rt.body?.data?.ar_offset_amount || 0) > 0, `offset=${rt.body?.data?.ar_offset_amount}`)
    const ev1 = q1("SELECT COUNT(*) c FROM doc_events WHERE doc_type='AR' AND doc_id=?", ar.id).c
    console.log(`    应收 ${ar.doc_no} 冲减前后 doc_events 条数：${ev0} → ${ev1}`)
    ok(`应收冲减留下了 doc_events 痕迹（实测新增 ${ev1 - ev0}）`, ev1 > ev0, `新增 ${ev1 - ev0}`)
  }

  // 红冲把 SI（created）应收置 voided —— 也要留痕
  const m = await api('POST', '/api/invoices/manual', {
    subject_type: 'dealer',
    subject_id: dealer.id,
    subject_name: dealer.name,
    tax_rate: 0.13,
    items: [{ qty: 1, price: 500 }],
    remark: '__FIXAR__ S10 红冲留痕'
  })
  ok('手工开票（草稿）', m.status === 200, JSON.stringify(m.body).slice(0, 200))
  const mid = m.body?.data?.id
  await api('POST', `/api/invoices/${mid}/submit`, {})
  const mcf = await api('POST', `/api/invoices/${mid}/confirm`, {})
  ok('手工票确认（新建 SI 应收）', mcf.status === 200, JSON.stringify(mcf.body).slice(0, 200))
  const siAr = q1("SELECT * FROM ar_documents WHERE source_type='SI' AND source_id=?", mid)
  const e0 = q1("SELECT COUNT(*) c FROM doc_events WHERE doc_type='AR' AND doc_id=?", siAr.id).c
  const red = await api('POST', `/api/invoices/${mid}/red-chart`, { reason: '__FIXAR__ S10' })
  ok('红冲成功', red.status === 200, JSON.stringify(red.body).slice(0, 200))
  const after = q1('SELECT status FROM ar_documents WHERE id=?', siAr.id)
  ok('红冲把该应收置 voided', after.status === 'voided', after.status)
  const e1 = q1("SELECT COUNT(*) c FROM doc_events WHERE doc_type='AR' AND doc_id=?", siAr.id).c
  console.log(`    应收 ${siAr.doc_no} 红冲作废前后 doc_events 条数：${e0} → ${e1}`)
  ok(`应收作废留下了 doc_events 痕迹（实测新增 ${e1 - e0}）`, e1 > e0, `新增 ${e1 - e0}`)
}

// ---------------------------------------------------------------------------
// SX：成本追溯（outLotsOf）—— 结构化匹配 + 追溯失败必须可见
// ---------------------------------------------------------------------------
if (want('SX')) {
  caseStart('SX-a 出库流水的 counterparty 不是订单号（存量/门店日结形状）时，应按 doc_id 结构化追溯')
  const o = await makeShippedOrder(2, 100, '__FIXAR__SX-a')
  const item = o.detail.items[0]
  // 把这一步出库流水的 counterparty 改成"门店零售"（模拟存量：counterparty 不是订单号），
  // doc_id 保持指向发货单 —— 这正是实测里 243/337 条的形状。
  wdb.prepare("UPDATE inventory_transactions SET counterparty='门店零售' WHERE doc_type='SAL_OUT' AND doc_id=?").run(o.deliveryId)
  const raw = db
    .prepare("SELECT counterparty, doc_id, sku_id, qty FROM inventory_transactions WHERE doc_type='SAL_OUT' AND doc_id=?")
    .all(o.deliveryId)
  console.log(`    夹具：出库流水 counterparty=${raw[0]?.counterparty} doc_id=${raw[0]?.doc_id}（不是订单号 ${o.detail.doc_no}）`)
  const r = await api('POST', '/api/sales/returns', {
    order_id: o.id,
    reason: '__FIXAR__ SX-a 存量形状追溯',
    items: [{ order_item_id: item.id, qty: 1 }]
  })
  ok('退货单创建成功', r.status === 200, JSON.stringify(r.body).slice(0, 200))
  const d = r.body?.data || {}
  console.log(`    cost_sources=${JSON.stringify(d.cost_sources)}  cost_trace=${JSON.stringify(d.cost_trace || null)}`)
  ok(
    `应按 doc_id 追溯到原出库批次（cost_source 应为 source_out，实测 ${JSON.stringify(d.cost_sources)}）`,
    Array.isArray(d.cost_sources) && d.cost_sources.every((s) => s === 'source_out'),
    JSON.stringify(d.cost_sources)
  )
  ok(
    `追溯来源应报出 delivery（实测 ${d.cost_trace?.via}）`,
    d.cost_trace?.via === 'delivery',
    JSON.stringify(d.cost_trace || null)
  )

  caseStart('SX-b 完全追溯不到时，必须**可见**（不再静默按当前成本计价）')
  const o2 = await makeShippedOrder(2, 100, '__FIXAR__SX-b')
  const item2 = o2.detail.items[0]
  // 模拟"既没有指向本单发货单的 doc_id，也没有 counterparty=订单号"（门店日结形状）
  wdb.prepare("UPDATE inventory_transactions SET counterparty='门店零售', doc_id=0 WHERE doc_type='SAL_OUT' AND doc_id=?").run(o2.deliveryId)
  const r2 = await api('POST', '/api/sales/returns', {
    order_id: o2.id,
    reason: '__FIXAR__ SX-b 追溯失败可见',
    items: [{ order_item_id: item2.id, qty: 1 }]
  })
  ok('退货单创建成功', r2.status === 200, JSON.stringify(r2.body).slice(0, 200))
  const d2 = r2.body?.data || {}
  console.log(`    cost_sources=${JSON.stringify(d2.cost_sources)}  warning=${JSON.stringify(d2.cost_trace_warning)}`)
  ok(
    `追溯失败应标成 lot_trace_failed（实测 ${JSON.stringify(d2.cost_sources)}）`,
    Array.isArray(d2.cost_sources) && d2.cost_sources.includes('lot_trace_failed'),
    JSON.stringify(d2.cost_sources)
  )
  ok('追溯失败应带出可读原因', typeof d2.cost_trace_warning === 'string' && d2.cost_trace_warning.length > 10, d2.cost_trace_warning)
  const txn = db
    .prepare("SELECT remark, unit_cost FROM inventory_transactions WHERE doc_type='SAL_RET' AND doc_no=?")
    .all(d2.doc_no)
  console.log(`    入库流水 remark=${JSON.stringify(txn[0]?.remark)}`)
  ok(
    '追溯失败的原因要留在**入库流水**里（查库存就能看见）',
    !!txn.length && String(txn[0].remark || '').includes('未按原出库批次追溯'),
    txn[0]?.remark
  )
}

wdb.close()
db.close()
console.log(`\n通过 ${pass}　失败 ${fail}`)
if (failures.length) console.log('失败清单：\n - ' + failures.join('\n - '))
srv.kill('SIGKILL')
process.exit(0)
