/**
 * ============================================================================
 * 文件标识：server/routes/qimen.js ｜ 奇门（Qimen）标准化协议网关 · 模拟实现
 * ============================================================================
 * 【职责】奇门（Qimen）标准化协议网关 · 模拟实现
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 奇门（Qimen）标准化协议网关 · 模拟实现
// 参考菜鸟《奇门标准化协议白皮书》：ERP 调用 taobao.qimen.* 系列，
// 本模块让 GML 扮演「承接方」，用标准报文演示与主流电商平台的对接能力。
// 报文格式：{ method, app_key, sign, ...request }，响应统一 { success, code, message, ...data }
import { Router } from 'express'
import crypto from 'node:crypto'
import { getDb } from '../db/index.js'
import { ok, fail, wrap } from '../lib/http.js'
import { requireAuth } from '../middleware/auth.js'

const r = Router()

const md5 = (s) => crypto.createHash('md5').update(s, 'utf8').digest('hex').toUpperCase()

// 奇门签名规则（演示版）：sign = MD5(app_key + method + secret)
// 真实环境为 系统参数按 key 排序拼接 + secret 前后缀，此处做等价简化
function verifySign(platform, method, sign) {
  if (!sign) return { pass: true, note: '未携带签名（演示环境放行，生产必须校验）' }
  const expected = md5(`${platform.app_key}${method}GML-DEMO-SECRET`)
  return { pass: sign === expected, note: 'sign = MD5(app_key + method + secret)' }
}

function qimenError(res, code, message, extra = {}) {
  return res.status(200).json({ success: false, code, message, ...extra })
}

function logGateway(db, platformId, method, payload, status, message, costMs) {
  db.prepare(
    `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,payload,cost_ms)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    platformId || null, `qimen:${method}`, 'in', status, 1, status === 'success' ? 1 : 0, status === 'success' ? 0 : 1,
    message, JSON.stringify(payload).slice(0, 4000), costMs
  )
}

// ---------- 能力清单（供前端对接中心展示）----------
const METHODS = [
  {
    method: 'taobao.qimen.itemmapping.query',
    name: '商品映射查询',
    desc: '店铺商品（shopSkuId）与后端商品编码（itemCode）双向映射，转单前的商品对照基础',
    direction: 'ERP → WMS/OMS',
    req: ['itemCode 后端商品编码', 'shopCode 店铺编码', 'shopSkuId 店铺商品 ID'],
    res: ['itemId 后端商品编码', 'shopSkuId 店铺商品 ID', 'skuId 平台 SKU']
  },
  {
    method: 'taobao.qimen.deliveryorder.create',
    name: '发货单创建',
    desc: 'OMS 审单后向仓内下发发货指令：含平台单号、脱敏收件人、承诺发货时限、orderLines 明细',
    direction: 'ERP → WMS',
    req: ['deliveryOrderCode 出库单号', 'orderSourceCode 平台交易单号', 'warehouseCode 仓库编码', 'orderLines[] itemCode/planQty'],
    res: ['deliveryOrderId', 'success']
  },
  {
    method: 'taobao.qimen.deliveryorder.confirm',
    name: '发货单确认回传',
    desc: 'WMS 打包出库后回传实际发运信息：物流公司编码、运单号、实发数量与批次',
    direction: 'WMS → ERP',
    req: ['deliveryOrderCode', 'logisticsCode 物流编码', 'expressCode 运单号', 'orderLines[] actualQty/batchCode'],
    res: ['success']
  },
  {
    method: 'taobao.qimen.entryorder.create',
    name: '入库单创建',
    desc: '采购入库 / 退货入库指令下发，含批次号、生产日期、失效日期',
    direction: 'ERP → WMS',
    req: ['entryOrderCode 入库单号', 'warehouseCode', 'orderType PURCHASE/RETURN', 'orderLines[] batchCode/produceDate/expireDate'],
    res: ['entryOrderId', 'success']
  },
  {
    method: 'taobao.qimen.entryorder.confirm',
    name: '入库单确认回传',
    desc: 'WMS 收货上架后回传实际收货数量、残次数量与真实批次',
    direction: 'WMS → ERP',
    req: ['entryOrderCode', 'orderLines[] actualQty/defectQty/batchCode'],
    res: ['success']
  },
  {
    method: 'taobao.qimen.returnorder.create',
    name: '退货入库单创建',
    desc: '消费者退货退款时的退货入库指令',
    direction: '平台/ERP → WMS',
    req: ['returnOrderCode', 'orderType', 'orderLines[] itemCode/qty'],
    res: ['returnOrderId', 'success']
  },
  {
    method: 'taobao.qimen.inventory.query',
    name: '库存查询',
    desc: '按仓库 + 商品查询现存量 / 占用量 / 可用量，供平台可售库存推送前核对',
    direction: 'ERP ↔ WMS',
    req: ['warehouseCode', 'itemCodes[]'],
    res: ['items[] itemCode/quantity/reserved']
  },
  {
    method: 'taobao.qimen.stock.change.report',
    name: '库存异动通知',
    desc: '库存增减变动批量上报（采购入库 / 销售出库 / 盘点调整）',
    direction: 'WMS → ERP',
    req: ['warehouseCode', 'items[] itemCode/changeQty/orderType'],
    res: ['success']
  }
]

// 主流平台编码（奇门 sourcePlatformCode 约定）
const PLATFORM_CODES = [
  { code: 'TB', name: '淘宝', adapter: 'qimen' },
  { code: 'TB', name: '天猫', adapter: 'qimen' },
  { code: 'JD', name: '京东', adapter: 'qimen' },
  { code: 'DYXD', name: '抖音小店', adapter: 'qimen' },
  { code: 'PDD', name: '拼多多', adapter: 'qimen' },
  { code: 'KS', name: '快手小店', adapter: 'qimen' },
  { code: 'XHS', name: '小红书', adapter: 'open' },
  { code: 'WX', name: '微信小程序 / 视频号', adapter: 'direct' },
  { code: 'MTWM', name: '美团闪购', adapter: 'open' },
  { code: 'ELE', name: '饿了么', adapter: 'open' }
]

r.get(
  '/capabilities',
  requireAuth,
  wrap((_req, res) => {
    const db = getDb()
    const platforms = db
      .prepare(
        `SELECT pf.id, pf.code, pf.platform_code, pf.name, pf.shop_name, pf.adapter, pf.app_key, pf.qimen_url, pf.qimen_wh, pf.shop_code, pf.status,
                w.name AS warehouse_name
         FROM platforms pf LEFT JOIN warehouses w ON w.id=pf.warehouse_id ORDER BY pf.id`
      )
      .all()
    return ok(res, {
      protocol: '奇门标准化协议 V3.9.5（演示实现）',
      gateway: '/api/qimen',
      signRule: 'sign = MD5(app_key + method + secret)，演示环境 secret = GML-DEMO-SECRET，未携带签名时放行并记录告警',
      methods: METHODS,
      platformCodes: PLATFORM_CODES,
      platforms
    })
  })
)

// ---------- 奇门网关（模拟 WMS/OMS 承接方）----------
r.post(
  '/',
  wrap((req, res) => {
    const db = getDb()
    const started = Date.now()
    const body = req.body || {}
    const method = body.method
    if (!method) return qimenError(res, '1001', '缺少 method 参数')
    if (!METHODS.some((m) => m.method === method)) {
      return qimenError(res, '1002', `不支持的奇门接口：${method}`)
    }
    // app_key 鉴权
    const platform = body.app_key
      ? db.prepare('SELECT * FROM platforms WHERE app_key=?').get(body.app_key)
      : null
    if (body.app_key && !platform) return qimenError(res, '1003', 'app_key 不存在或未授权')
    const signCheck = platform ? verifySign(platform, method, body.sign) : { pass: true, note: '未鉴权调用' }
    if (!signCheck.pass) {
      logGateway(db, platform?.id || null, method, { app_key: body.app_key }, 'fail', '签名校验失败', Date.now() - started)
      return qimenError(res, '1004', '签名校验失败')
    }

    const request = body.request || {}
    const respond = (data) => {
      logGateway(db, platform?.id || null, method, body, 'success', `${method} 处理成功`, Date.now() - started)
      return res.json({ success: true, code: 0, message: signCheck.note || 'success', ...data })
    }

    // ---- 各 method 的承接逻辑 ----
    if (method === 'taobao.qimen.itemmapping.query') {
      const itemCode = request.itemCode
      const rows = itemCode
        ? db.prepare('SELECT sku_code, barcode, name FROM product_skus WHERE sku_code=? OR barcode=?').all(itemCode, request.shopSkuId || itemCode)
        : db.prepare("SELECT sku_code, barcode, name FROM product_skus WHERE status='active' LIMIT 20").all()
      return respond({
        mappings: rows.map((s) => ({
          ownerCode: 'GML',
          shopCode: request.shopCode || platform?.shop_code || '',
          itemCode: s.sku_code,
          shopSkuId: `P${s.sku_code}`,
          itemId: s.sku_code,
          itemName: s.name
        }))
      })
    }

    if (method === 'taobao.qimen.inventory.query') {
      const itemCodes = request.itemCodes || []
      const wh = request.warehouseCode
        ? db.prepare('SELECT * FROM warehouses WHERE code=?').get(request.warehouseCode)
        : null
      const conds = ['st.qty_on_hand <> 0']
      const params = []
      if (wh) {
        conds.push('st.warehouse_id=?')
        params.push(wh.id)
      }
      if (itemCodes.length) {
        conds.push(`sk.sku_code IN (${itemCodes.map(() => '?').join(',')})`)
        params.push(...itemCodes)
      }
      const rows = db
        .prepare(
          `SELECT sk.sku_code, SUM(st.qty_on_hand) qty, SUM(st.qty_reserved) reserved FROM inventory_stocks st
           JOIN product_skus sk ON sk.id=st.sku_id WHERE ${conds.join(' AND ')} GROUP BY sk.sku_code LIMIT 100`
        )
        .all(...params)
      return respond({
        warehouseCode: request.warehouseCode || 'ALL',
        items: rows.map((x) => ({ itemCode: x.sku_code, quantity: x.qty, reserved: x.reserved, available: x.qty - x.reserved }))
      })
    }

    if (method === 'taobao.qimen.deliveryorder.create') {
      const order = request.deliveryOrder || {}
      const lines = order.orderLines || []
      if (!order.deliveryOrderCode) return qimenError(res, '2001', '缺少 deliveryOrderCode')
      return respond({
        deliveryOrderId: `WMS${Date.now().toString().slice(-9)}`,
        deliveryOrderCode: order.deliveryOrderCode,
        orderType: order.orderType || 'JYCK',
        warehouseCode: order.warehouseCode || 'OTHER',
        receivedLines: lines.length,
        scheduleFinishTime: order.scheduleFinishTime || null,
        tips: '发货指令已接收（演示环境：不实际执行出库，可在 OMS 页面操作转单发货）'
      })
    }

    if (method === 'taobao.qimen.deliveryorder.confirm') {
      const order = request.deliveryOrder || {}
      return respond({
        deliveryOrderCode: order.deliveryOrderCode,
        logisticsCode: order.logisticsCode,
        expressCode: order.expressCode,
        confirmedLines: (order.orderLines || []).length,
        tips: '发货确认已回传（演示环境）'
      })
    }

    if (method === 'taobao.qimen.entryorder.create' || method === 'taobao.qimen.returnorder.create') {
      const order = request.entryOrder || request.returnOrder || {}
      return respond({
        entryOrderId: `EWM${Date.now().toString().slice(-9)}`,
        entryOrderCode: order.entryOrderCode || order.returnOrderCode,
        orderType: order.orderType || 'PURCHASE',
        receivedLines: (order.orderLines || []).length,
        tips: '入库指令已接收（演示环境）'
      })
    }

    if (method === 'taobao.qimen.entryorder.confirm') {
      const order = request.entryOrder || {}
      return respond({
        entryOrderCode: order.entryOrderCode,
        confirmedLines: (order.orderLines || []).length,
        tips: '入库确认已回传（演示环境）'
      })
    }

    if (method === 'taobao.qimen.stock.change.report') {
      const items = request.items || []
      return respond({
        warehouseCode: request.warehouseCode,
        accepted: items.length,
        tips: '库存异动已入账（演示环境）'
      })
    }

    return qimenError(res, '9999', '未实现的接口分支')
  })
)

export default r
