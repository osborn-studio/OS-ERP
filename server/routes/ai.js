/**
 * ============================================================================
 * 文件标识：server/routes/ai.js ｜ AI 数据承接台路由：自然语言查询 → 结构化取数 → 回答（含查询日志）
 * ============================================================================
 * 【职责】AI 数据承接台路由：自然语言查询 → 结构化取数 → 回答（含查询日志）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自手写**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requirePerm, requireGlobalData } from '../middleware/auth.js'
import { DOC_TYPE_LABEL } from '../lib/stock.js'
import { metricDefinitions } from '../lib/metrics.js'

const r = Router()

// ---------- 能力清单：AI/Agent 接入的第一入口 ----------
r.get(
  '/manifest',
  wrap((_req, res) => {
    return ok(res, {
      system: {
        name: 'GML 供应链协同系统',
        industry: '化妆品 / 美妆零售',
        version: '1.0.0',
        description:
          '化妆品行业轻量级供应链协同系统，覆盖线上 OMS 平台对接、采购、销售、存货、线下门店与经销商管理。可作为 AI FDE 场景的数据承接底座。',
        base_path: '/api',
        auth: '除 /api/ai/manifest、/api/meta/health 外，均需在 Header 携带 Authorization: Bearer <token>'
      },
      modules: [
        { key: 'master', name: '主数据', path: '/api/master', desc: '商品/SKU/品牌/品类/仓库/门店/供应商/经销商/平台' },
        { key: 'purchase', name: '采购管理', path: '/api/purchase', desc: '采购订单→审批→收货入库→采购退货' },
        { key: 'sales', name: '销售管理', path: '/api/sales', desc: '多渠道销售订单→占库→发货出库→退货→回款' },
        { key: 'inventory', name: '存货管理', path: '/api/inventory', desc: '库存查询/收发存台账/批次效期/调拨/盘点/预警' },
        { key: 'dealer', name: '经销商管理', path: '/api/dealers', desc: '等级政策/信用额度/返利核算/对账单' },
        { key: 'oms', name: '线上 OMS', path: '/api/oms', desc: '平台店铺/订单同步/转单/发货回传/退款/库存推送' },
        { key: 'dashboard', name: '经营看板', path: '/api/dashboard', desc: 'KPI/趋势/渠道/待办/排行' }
      ],
      intents: [
        { key: 'sales_summary', name: '销售汇总', params: ['startDate?', 'endDate?', 'channel?'], example: { intent: 'sales_summary', params: { startDate: '2026-10-01' } } },
        { key: 'sales_trend', name: '销售趋势', params: ['days?'] },
        { key: 'channel_compare', name: '渠道对比', params: ['days?'] },
        { key: 'inventory_query', name: '库存查询', params: ['keyword?', 'warehouse_id?', 'onlyAvailable?'] },
        { key: 'stock_alert', name: '库存预警', params: [] },
        { key: 'expiring_stock', name: '临期库存', params: ['days?'] },
        { key: 'dealer_ranking', name: '经销商排行', params: ['days?', 'limit?'] },
        { key: 'dealer_profile', name: '经销商画像', params: ['dealer_id?', 'name?'] },
        { key: 'purchase_status', name: '采购在途', params: ['status?'] },
        { key: 'oms_pending', name: '线上待发货', params: [] },
        { key: 'product_360', name: '商品全景', params: ['sku_id?', 'keyword?'] }
      ],
      sample_questions: [
        '本月各渠道销售额是多少？',
        '哪些商品库存低于安全库存？',
        '未来 90 天有哪些批次临期？',
        '排名前 10 的经销商本季度销售多少？',
        '线上还有多少待发货订单？',
        '某个商品从采购到销售的完整链路是怎样的？'
      ],
      capabilities: {
        read_only_endpoints: '本文件所列 intent 均为只读查询，不会修改业务数据',
        write_endpoints: '业务单据操作在对应模块下，需相应角色权限',
        data_freshness: '实时读取 SQLite 业务库'
      }
    })
  })
)

// ---------- 结构化查询（AI 承接主入口）----------
r.post(
  '/query',
  requireAuth,
  requirePerm('ai.chat'),
  requireGlobalData('全局AI取数'),
  wrap((req, res) => {
    const db = getDb()
    const started = Date.now()
    const { intent, params = {} } = req.body || {}
    if (!intent) return fail(res, `请提供 intent，可用值：sales_summary / sales_trend / channel_compare / inventory_query / stock_alert / expiring_stock / dealer_ranking / dealer_profile / purchase_status / oms_pending / product_360`)

    let result
    let path = `/api/ai/query#${intent}`
    const days = Number(params.days || 30)
    const from = `date('now','localtime','-${days} day')`

    switch (intent) {
      case 'sales_summary': {
        const conds = ["so.status NOT IN ('cancelled','draft')"]
        const args = []
        if (params.startDate) {
          conds.push('so.order_date >= ?')
          args.push(params.startDate)
        } else {
          conds.push(`so.order_date >= ${from}`)
        }
        if (params.endDate) {
          conds.push('so.order_date <= ?')
          args.push(params.endDate)
        }
        if (params.channel) {
          conds.push('so.channel = ?')
          args.push(params.channel)
        }
        const where = `WHERE ${conds.join(' AND ')}`
        const total = db
          .prepare(`SELECT COUNT(*) orders, COALESCE(SUM(so.receivable_amount),0) amount, COALESCE(SUM(so.total_qty),0) qty FROM sales_orders so ${where}`)
          .get(...args)
        const byChannel = db
          .prepare(`SELECT so.channel, COUNT(*) orders, COALESCE(SUM(so.receivable_amount),0) amount FROM sales_orders so ${where} GROUP BY so.channel`)
          .all(...args)
        const byDealer = db
          .prepare(
            `SELECT d.name AS dealer_name, COUNT(*) orders, COALESCE(SUM(so.receivable_amount),0) amount
             FROM sales_orders so JOIN dealers d ON d.id=so.dealer_id ${where} GROUP BY d.id ORDER BY amount DESC LIMIT 10`
          )
          .all(...args)
        result = { total, byChannel, topDealers: byDealer, period: params.startDate || `近 ${days} 天` }
        break
      }
      case 'sales_trend': {
        result = db
          .prepare(
            `SELECT so.order_date AS date, COUNT(*) orders, COALESCE(SUM(so.receivable_amount),0) amount FROM sales_orders so
             WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from} GROUP BY so.order_date ORDER BY date`
          )
          .all()
        break
      }
      case 'channel_compare': {
        const offline = db
          .prepare(
            `SELECT so.channel, COUNT(*) orders, COALESCE(SUM(so.receivable_amount),0) amount FROM sales_orders so
             WHERE so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from} GROUP BY so.channel`
          )
          .all()
        const online = db
          .prepare(
            `SELECT pf.name AS platform_name, COUNT(o.id) orders, COALESCE(SUM(o.pay_amount),0) amount FROM oms_orders o
             JOIN platforms pf ON pf.id=o.platform_id WHERE date(o.order_time) >= ${from} GROUP BY pf.id ORDER BY amount DESC`
          )
          .all()
        result = { offline, online }
        break
      }
      case 'inventory_query': {
        const conds = ['st.qty_on_hand <> 0']
        const args = []
        if (params.keyword) {
          conds.push('(sk.sku_code LIKE ? OR sk.name LIKE ? OR p.name LIKE ?)')
          const kw = `%${params.keyword}%`
          args.push(kw, kw, kw)
        }
        if (params.warehouse_id) {
          conds.push('st.warehouse_id = ?')
          args.push(Number(params.warehouse_id))
        }
        const where = `WHERE ${conds.join(' AND ')}`
        result = db
          .prepare(
            `SELECT sk.sku_code, sk.name AS sku_name, p.name AS product_name, w.name AS warehouse_name, st.batch_no,
                    st.expire_date, st.qty_on_hand, (st.qty_on_hand - st.qty_reserved) AS qty_available, st.cost_price
             FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN products p ON p.id=sk.product_id
             JOIN warehouses w ON w.id=st.warehouse_id ${where} ORDER BY st.qty_on_hand DESC LIMIT 200`
          )
          .all(...args)
        break
      }
      case 'stock_alert': {
        result = db
          .prepare(
            `SELECT sk.sku_code, sk.name AS sku_name, p.name AS product_name, sk.safe_stock,
                    COALESCE(SUM(st.qty_on_hand),0) qty_on_hand,
                    sk.safe_stock - COALESCE(SUM(st.qty_on_hand),0) AS shortage
             FROM product_skus sk JOIN products p ON p.id=sk.product_id LEFT JOIN inventory_stocks st ON st.sku_id=sk.id
             WHERE sk.status='active' AND sk.safe_stock>0 GROUP BY sk.id
             HAVING COALESCE(SUM(st.qty_on_hand),0) < sk.safe_stock ORDER BY shortage DESC`
          )
          .all()
        break
      }
      case 'expiring_stock': {
        const d = Number(params.days || 90)
        result = db
          .prepare(
            `SELECT sk.sku_code, sk.name AS sku_name, w.name AS warehouse_name, st.batch_no, st.produce_date, st.expire_date,
                    st.qty_on_hand, CAST(julianday(st.expire_date) - julianday('now','localtime') AS INTEGER) AS days_left
             FROM inventory_stocks st JOIN product_skus sk ON sk.id=st.sku_id JOIN warehouses w ON w.id=st.warehouse_id
             WHERE st.qty_on_hand>0 AND st.expire_date IS NOT NULL AND st.expire_date<>''
               AND st.expire_date <= date('now','localtime','+${d} day') ORDER BY st.expire_date`
          )
          .all()
        break
      }
      case 'dealer_ranking': {
        const limit = Number(params.limit || 10)
        result = db
          .prepare(
            `SELECT d.code, d.name AS dealer_name, d.level, d.region,
                    COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount,
                    COALESCE(SUM(so.paid_amount),0) paid
             FROM dealers d LEFT JOIN sales_orders so ON so.dealer_id=d.id
               AND so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
             WHERE d.status='active' GROUP BY d.id ORDER BY amount DESC LIMIT ?`
          )
          .all(limit)
        break
      }
      case 'dealer_profile': {
        const dealer = params.dealer_id
          ? db.prepare('SELECT * FROM dealers WHERE id=?').get(Number(params.dealer_id))
          : db.prepare('SELECT * FROM dealers WHERE name LIKE ? LIMIT 1').get(`%${params.name || ''}%`)
        if (!dealer) return fail(res, '未找到该经销商', 404)
        const sales = db
          .prepare(
            `SELECT COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(paid_amount),0) paid,
                    COALESCE(SUM(receivable_amount - paid_amount),0) unpaid FROM sales_orders
             WHERE dealer_id=? AND status NOT IN ('cancelled','draft')`
          )
          .get(dealer.id)
        const topProducts = db
          .prepare(
            `SELECT p.name AS product_name, SUM(i.qty) qty, SUM(i.amount) amount FROM sales_order_items i
             JOIN sales_orders so ON so.id=i.order_id JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
             WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft') GROUP BY p.id ORDER BY amount DESC LIMIT 10`
          )
          .all(dealer.id)
        const rebates = db.prepare('SELECT period, rebate_rate, rebate_amount, status FROM dealer_rebates WHERE dealer_id=? ORDER BY period DESC LIMIT 6').all(dealer.id)
        result = { dealer, sales, topProducts, rebates }
        break
      }
      case 'purchase_status': {
        const status = params.status || null
        result = db
          .prepare(
            `SELECT po.doc_no, po.order_date, po.status, po.total_amount, po.total_qty, s.name AS supplier_name, w.name AS warehouse_name,
                    (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id=po.id) AS item_count
             FROM purchase_orders po JOIN suppliers s ON s.id=po.supplier_id JOIN warehouses w ON w.id=po.warehouse_id
             ${status ? 'WHERE po.status = ?' : "WHERE po.status IN ('draft','submitted','approved')"} ORDER BY po.order_date DESC LIMIT 100`
          )
          .all(...(status ? [status] : []))
        break
      }
      case 'oms_pending': {
        result = db
          .prepare(
            `SELECT o.platform_order_no, o.order_time, o.pay_amount, o.buyer_nick, o.receiver, pf.name AS platform_name,
                    CASE WHEN o.sales_order_id IS NULL THEN '未转单' ELSE '已转单' END AS convert_status
             FROM oms_orders o JOIN platforms pf ON pf.id=o.platform_id WHERE o.status='pending' ORDER BY o.order_time LIMIT 200`
          )
          .all()
        break
      }
      case 'product_360': {
        let sku
        // 缺参时给出明确提示，避免误报「未找到该商品」
        if (!params.sku_id && !params.keyword) return fail(res, '请提供 sku_id 或 keyword 参数')
        if (params.sku_id) sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(Number(params.sku_id))
        else if (params.keyword)
          sku = db
            .prepare('SELECT s.* FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.sku_code LIKE ? OR s.name LIKE ? OR p.name LIKE ? LIMIT 1')
            .get(`%${params.keyword}%`, `%${params.keyword}%`, `%${params.keyword}%`)
        if (!sku) return fail(res, '未找到该商品', 404)
        const product = db
          .prepare('SELECT p.*, b.name AS brand_name, c.name AS category_name FROM products p LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id WHERE p.id=?')
          .get(sku.product_id)
        const stock = db
          .prepare(
            `SELECT w.name AS warehouse_name, st.batch_no, st.expire_date, st.qty_on_hand, st.qty_reserved,
                    (st.qty_on_hand - st.qty_reserved) AS qty_available
             FROM inventory_stocks st JOIN warehouses w ON w.id=st.warehouse_id WHERE st.sku_id=? ORDER BY st.expire_date`
          )
          .all(sku.id)
        const purchases = db
          .prepare(
            `SELECT po.doc_no, po.order_date, i.qty, i.price, i.amount, i.received_qty, s.name AS supplier_name
             FROM purchase_order_items i JOIN purchase_orders po ON po.id=i.order_id JOIN suppliers s ON s.id=po.supplier_id
             WHERE i.sku_id=? ORDER BY po.order_date DESC LIMIT 10`
          )
          .all(sku.id)
        const sales = db
          .prepare(
            `SELECT so.doc_no, so.order_date, so.channel, i.qty, i.price, i.amount,
                    COALESCE(d.name, st2.name, so.receiver) AS customer_name
             FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
             LEFT JOIN dealers d ON d.id=so.dealer_id LEFT JOIN stores st2 ON st2.id=so.store_id
             WHERE i.sku_id=? ORDER BY so.order_date DESC LIMIT 10`
          )
          .all(sku.id)
        const movements = db
          .prepare(
            `SELECT biz_date, doc_type, doc_no, direction, qty, balance_qty, warehouse_id FROM inventory_transactions
             WHERE sku_id=? ORDER BY id DESC LIMIT 20`
          )
          .all(sku.id)
        result = {
          sku,
          product,
          stock,
          stock_total: stock.reduce((s, x) => s + x.qty_on_hand, 0),
          purchases,
          sales,
          movements: movements.map((m) => ({ ...m, doc_type_name: DOC_TYPE_LABEL[m.doc_type] || m.doc_type }))
        }
        break
      }
      default:
        return fail(res, `不支持的 intent：${intent}`)
    }

    const rows = Array.isArray(result) ? result.length : 1
    const cost = Date.now() - started
    db.prepare(
      `INSERT INTO ai_query_logs (question,intent,api_path,params,result_rows,cost_ms,user_id,source)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(params.question || null, intent, path, JSON.stringify(params), rows, cost, req.user?.uid || null, req.body?.source || 'api')

    return ok(res, { intent, params, result, meta: { rows, cost_ms: cost, generated_at: new Date().toISOString() } })
  })
)

// ---------- 表结构（供 AI 理解数据模型）----------
r.get(
  '/schema',
  requireAuth,
  requirePerm('ai.chat'),
  requireGlobalData('全局数据字典'),
  wrap((_req, res) => {
    const db = getDb()
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
    const out = []
    for (const t of tables) {
      const cols = db.prepare(`PRAGMA table_info(${t.name})`).all()
      const count = db.prepare(`SELECT COUNT(*) c FROM ${t.name}`).get().c
      out.push({
        table: t.name,
        rows: count,
        columns: cols.map((c) => ({ name: c.name, type: c.type, notnull: !!c.notnull, pk: !!c.pk }))
      })
    }
    return ok(res, out)
  })
)

// ---------- 指标口径 ----------
// 只回**定义**，不回值 —— 这个端点在 index.js 里被放行免登录（AI/外部系统要能直接读口径），
// 若把当前值也带上，等于把全部经营数字开成公开接口。
// 定义直接取自 lib/metrics.js（模块 23），不在这里再维护一份 —— 两处口径必然分家。
r.get(
  '/metrics',
  wrap((_req, res) => {
    return ok(res, metricDefinitions())
  })
)

// ---------- 查询日志 ----------
r.get(
  '/logs',
  requireAuth,
  requirePerm('ai.chat'),
  requireGlobalData('全局AI查询日志'),
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const total = db.prepare('SELECT COUNT(*) c FROM ai_query_logs').get().c
    const rows = db.prepare('SELECT * FROM ai_query_logs ORDER BY id DESC LIMIT ? OFFSET ?').all(pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

export default r
