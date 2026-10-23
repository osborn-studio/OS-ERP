/**
 * ============================================================================
 * 文件标识：server/routes/mall.js ｜ C 端商城路由（H5）：商品浏览、购物车、下单、结算试算、会员与积分
 * ============================================================================
 * 【职责】C 端商城路由（H5）：商品浏览、购物车、下单、结算试算、会员与积分
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自人工补充**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { getDb, getCurrentIndustry } from '../db/index.js'
import { buildDataset } from '../db/datasets.js'
import { ok, fail, wrap } from '../lib/http.js'
import { nextDocNo } from '../lib/docno.js'
// 业务错误的统一翻译（结算/会员/券域抛出的都是 `{status, code, detail}`）——
// 与 `routes/promo.js` 的 `guard` 共用同一份实现，不各写一套
import { failFromError } from '../lib/http.js'
// **C 端会话只有一份实现**（`middleware/mall-session.js`）——
// `routes/promo.js` 的 `/api/promo/shop/*` 也用它，不再各自维护一套身份口径。
import { signMallToken, requireMall, mallCustomer } from '../middleware/mall-session.js'
// 单据流转的唯一入口：改状态与写留痕在同一事务里。商城撤单要用它（见下方 `/orders/:id/cancel`）。
import { applyTransition } from '../lib/docflow.js'
// 结算域：促销 / 会员 / 券 / 积分**只在这里汇合**（模块 18）。
// 商城不再自己算钱 —— 那样会立刻出现"两套口径"（旧实现自己按 1 元 1 分送分）。
import * as K from '../lib/checkout.js'
import * as M from '../lib/member.js'
import * as C from '../lib/coupon.js'

// H5 线上门店（商城）：门店前台，C 端会员。
// 下单统一走 OMS 通道（H5 商城平台），由总部 OMS 转销售单发货。
//
// ---------------------------------------------------------------------------
// 身份：**C 端有自己的会话**，不再"手机号即身份"（A16）
// ---------------------------------------------------------------------------
// 原来的写法是"手机号即会员（一账通主键）"：`phone` 从 body / query 里取，谁传谁的。
// 后果（验收独立复现）：
//   · 未登录直接 `POST /api/mall/orders` 传一个手机号 → **200**，单就成了；
//   · 另一个手机号的**未登录**请求 `GET /api/mall/orders/:id` → 拿到**完整订单详情**；
//   · 列表/购物车/会员信息同理 —— **知道手机号就能读能写**。
// 手机号是**公开标识**（印在快递单上），不是凭据。把它当身份，等于把"谁都能自称是别人"。
//
// 现在的规则：
//   · `POST /login` 校验验证码后签发**C 端会话令牌**（独立 audience `gml-mall`）；
//   · 凡"我的数据"的接口一律 `requireMall`，身份**只从会话取**；
//     请求体/查询串里的 `phone` **一律忽略**（服务端不再把它当身份用，见各处理函数）；
//   · 越权读别人的单 → **404**，不是 403 —— 报 403 等于确认"这张单存在，只是不是你的"。
//
// 与内部 JWT 的关系：同一个签名密钥、**不同的 audience 与 role**，
// 互不通用（内部令牌调 C 端接口会被拒，反之亦然）—— 这是刻意做的隔离，
// 免得"给前台发一个能当后台用的凭据"。
//
// ---------------------------------------------------------------------------
// 算钱：**接入结算域**（A14）
// ---------------------------------------------------------------------------
// 旧实现是商城自己算：`会员价 × 数量 + 满 199 免运`，促销/券/积分一律不参与，
// 落单后直接 `UPDATE mall_customers SET points = points + FLOOR(实付)` ——
// 那是「1 元 1 分」，而营销域的默认口径是「**10 分/元**」（`settings.promo_points_per_yuan`）。
// 同一件事两套算法，界面上完全看不出来，只有对账时才差出 10 倍。
//
// 现在：**通道只决定"基准单价"，营销域决定"这个客户最终付多少"**。
//   ① 基准单价：取价引擎的出口 —— 商城取 `price_member || price_retail`
//      （就是货架上标给客户看的那个数，与前端展示**同一个来源**）；
//   ② 往上依次是 会员等级折扣 → 促销 → 券 → 积分抵现（顺序由 `checkout.quote` 固定）；
//   ③ 运费不参与折扣（它是履约成本，不是商品），`应付 = quote.payable + freight`；
//   ④ 优惠留痕 / 使用登记 / 券核销 / 积分 earn+redeem **全部由 `checkout.settle` 落**，
//      与后台人工端点、与演示造数走的是**同一条代码路径**。
const MALL_FREIGHT = { freeThreshold: 199, fee: 12 }

/**
 * C 端**基准单价**的唯一解析处 —— 购物车展示、结算试算、下单落库全走它。
 *
 * 为什么必须只有一处：试算与落单原来是分别取价的（试算走
 * `buildItems` 的默认值 = `price_retail`，落单用 `price_member || price_retail`），
 * 于是**同一个购物车在试算页和落单时是两个金额** —— 促销门槛按 A 价判、钱按 B 价收。
 * 这类错不会报错：页面上的"应付"与最终扣款只差一截，看起来像"又有一个活动叠加了"。
 *
 * 口径：**会员价优先，没有会员价用零售价**（会员价就是货架上标给客户的那个数）。
 * 营销域只在这条基准价**之上**做等级折扣 / 促销 / 券 / 积分。
 */
function mallLineItems(db, items = []) {
  if (!Array.isArray(items) || !items.length) return []
  return items.map((it) => {
    const sku = db
      .prepare(
        'SELECT s.*, p.name AS product_name FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?'
      )
      .get(Number(it.sku_id))
    if (!sku) return { error: `SKU#${it.sku_id} 不存在` }
    const qty = Number(it.qty)
    if (!(qty > 0)) return { error: `SKU#${it.sku_id} 数量无效` }
    const unitCents = Math.round(Number(sku.price_member || sku.price_retail) * 100)
    if (!(unitCents > 0)) return { error: `SKU#${it.sku_id} 单价异常` }
    return { sku, qty, unitCents }
  })
}

/** 某张订单是不是"我的"（C 端身份口径：下单手机号 / 买家昵称） */
function isMyOrder(order, phone) {
  return String(order.receiver_phone || '') === phone || String(order.buyer_nick || '') === `会员${phone}`
}

const r = Router()

function mallPlatform(db) {
  return db.prepare("SELECT * FROM platforms WHERE code='H5' AND status='active'").get()
}

// ---------- 登录（手机号 + 验证码，演示环境固定 1234） ----------
r.post(
  '/login',
  wrap((req, res) => {
    const db = getDb()
    const { phone = '', code = '' } = req.body || {}
    if (!/^1\d{10}$/.test(phone)) return fail(res, '请输入正确的手机号')
    if (code !== '1234') return fail(res, '验证码错误（演示环境固定 1234）')
    let c = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone)
    if (!c) {
      db.prepare("INSERT INTO mall_customers (phone, last_active_at) VALUES (?, datetime('now','localtime'))").run(phone)
      c = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone)
    } else {
      db.prepare("UPDATE mall_customers SET last_active_at=datetime('now','localtime') WHERE id=?").run(c.id)
    }
    return ok(res, {
      token: signMallToken(c, getCurrentIndustry()),
      phone: c.phone,
      industry: getCurrentIndustry(),
      points: c.points,
      total_orders: c.total_orders,
      total_amount: c.total_amount
    })
  })
)

// ---------- 会话自省：我是谁、我在哪个行业 ----------
// 存在两个理由：
//   ① 前端需要知道"当前会话绑在哪个行业"，才能避免把 A 行业的会话用到 B 行业上；
//   ② 它是「行业钉死在令牌」这条口径**可断言**的落点 ——
//      带一个不一致的 `x-industry` 头调它，返回的 `industry` 必须仍是**签发时那个**。
r.get(
  '/session',
  requireMall,
  wrap((req, res) => ok(res, { phone: req.mall.phone, industry: getCurrentIndustry() }))
)

// ---------- 首页 ----------
r.get(
  '/home',
  wrap((req, res) => {
    const db = getDb()
    const categories = db
      .prepare("SELECT id, name, parent_id FROM categories WHERE status='active' ORDER BY parent_id, id")
      .all()
    const hot = db
      .prepare(
        `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec, s.price_retail, s.price_member,
                p.id AS product_id, p.name AS product_name, p.spu_code, p.unit,
                b.name AS brand_name, c.name AS category_name
         FROM product_skus s
         JOIN products p ON p.id=s.product_id AND p.status='active'
         LEFT JOIN brands b ON b.id=p.brand_id
         LEFT JOIN categories c ON c.id=p.category_id
         WHERE s.status='active'
         ORDER BY s.id ASC LIMIT 8`
      )
      .all()
    const news = db
      .prepare(
        `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec, s.price_retail, s.price_member,
                p.id AS product_id, p.name AS product_name, p.unit, b.name AS brand_name
         FROM product_skus s
         JOIN products p ON p.id=s.product_id AND p.status='active'
         LEFT JOIN brands b ON b.id=p.brand_id
         WHERE s.status='active'
         ORDER BY p.created_at DESC, s.id DESC LIMIT 6`
      )
      .all()
    const shop = buildDataset(getCurrentIndustry()).shop
    return ok(res, { categories, hot, news, shop, notice: shop.notice })
  })
)

// ---------- 商品列表 ----------
r.get(
  '/products',
  wrap((req, res) => {
    const db = getDb()
    const { category_id = '', kw = '' } = req.query
    // 分页与筛选参数做类型兜底，避免非法入参触发 SQLITE_MISMATCH
    const page = Math.max(1, parseInt(req.query.page, 10) || 1)
    const pageSize = Math.min(100, Math.max(1, parseInt(req.query.pageSize, 10) || 20))
    let where = "s.status='active' AND p.status='active'"
    const params = []
    if (category_id) {
      const cid = Number(category_id)
      if (Number.isFinite(cid)) {
        where += ' AND (p.category_id=? OR c.parent_id=?)'
        params.push(cid, cid)
      }
    }
    if (kw) {
      where += ' AND (p.name LIKE ? OR s.name LIKE ? OR b.name LIKE ?)'
      params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`)
    }
    const total = db
      .prepare(
        `SELECT COUNT(*) c FROM product_skus s JOIN products p ON p.id=s.product_id
         LEFT JOIN brands b ON b.id=p.brand_id LEFT JOIN categories c ON c.id=p.category_id WHERE ${where}`
      )
      .get(...params).c
    const rows = db
      .prepare(
        `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec, s.price_retail, s.price_member,
                p.id AS product_id, p.name AS product_name, p.unit, p.spu_code,
                b.name AS brand_name, c.name AS category_name
         FROM product_skus s
         JOIN products p ON p.id=s.product_id
         LEFT JOIN brands b ON b.id=p.brand_id
         LEFT JOIN categories c ON c.id=p.category_id
         WHERE ${where}
         ORDER BY s.id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, pageSize, (page - 1) * pageSize)
    return ok(res, { rows, total, page, pageSize })
  })
)

// ---------- 商品详情 ----------
r.get(
  '/products/:skuId',
  wrap((req, res) => {
    const db = getDb()
    const sku = db
      .prepare(
        `SELECT s.*, p.name AS product_name, p.spu_code, p.unit, p.series, p.image_emoji, p.remark AS description,
                b.name AS brand_name, c.name AS category_name
         FROM product_skus s
         JOIN products p ON p.id=s.product_id
         LEFT JOIN brands b ON b.id=p.brand_id
         LEFT JOIN categories c ON c.id=p.category_id
         WHERE s.id=? AND s.status='active'`
      )
      .get(Number(req.params.skuId))
    if (!sku) return fail(res, '商品不存在', 404)
    // 同款其他规格
    const siblings = db
      .prepare(
        `SELECT id AS sku_id, name AS sku_name, spec, price_retail, price_member
         FROM product_skus WHERE product_id=? AND status='active' AND id<>? ORDER BY id`
      )
      .all(sku.product_id, sku.id)
    // 云仓可售量（演示只读）
    const ecomWh = db.prepare("SELECT id FROM warehouses WHERE type='ecom' LIMIT 1").get()
    const stock = ecomWh
      ? db
          .prepare('SELECT COALESCE(SUM(qty_on_hand-qty_reserved),0) a FROM inventory_stocks WHERE warehouse_id=? AND sku_id=?')
          .get(ecomWh.id, sku.id).a
      : 0
    return ok(res, { sku, siblings, available: stock })
  })
)

// ---------- 购物车（身份取自会话，忽略请求里的 phone） ----------
r.get(
  '/cart',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const phone = req.mall.phone
    const rows = db
      .prepare(
        `SELECT ci.id, ci.qty, s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec,
                s.price_retail, s.price_member, p.name AS product_name, p.unit, b.name AS brand_name
         FROM mall_cart_items ci
         JOIN product_skus s ON s.id=ci.sku_id
         JOIN products p ON p.id=s.product_id
         LEFT JOIN brands b ON b.id=p.brand_id
         WHERE ci.phone=?
         ORDER BY ci.id DESC`
      )
      .all(phone)
    return ok(res, rows)
  })
)

r.post(
  '/cart',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const phone = req.mall.phone
    const { sku_id = 0, qty = 1 } = req.body || {}
    const sku = db.prepare("SELECT id FROM product_skus WHERE id=? AND status='active'").get(Number(sku_id))
    if (!sku) return fail(res, '商品不存在')
    const n = Number(qty)
    if (!(n > 0)) return fail(res, '数量无效')
    db.prepare(
      `INSERT INTO mall_cart_items (phone, sku_id, qty) VALUES (?,?,?)
       ON CONFLICT(phone, sku_id) DO UPDATE SET qty = qty + excluded.qty`
    ).run(phone, Number(sku_id), n)
    return ok(res, { added: true })
  })
)

r.post(
  '/cart/update',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const phone = req.mall.phone
    const { sku_id = 0, qty = 1 } = req.body || {}
    if (qty <= 0) {
      db.prepare('DELETE FROM mall_cart_items WHERE phone=? AND sku_id=?').run(phone, Number(sku_id))
      return ok(res, { removed: true })
    }
    db.prepare('UPDATE mall_cart_items SET qty=? WHERE phone=? AND sku_id=?').run(Number(qty), phone, Number(sku_id))
    return ok(res, { updated: true })
  })
)

r.post(
  '/cart/clear',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    db.prepare('DELETE FROM mall_cart_items WHERE phone=?').run(req.mall.phone)
    return ok(res, { cleared: true })
  })
)

// ---------- 下单：生成 OMS 订单（H5 商城平台），总部 OMS 统一转单发货 ----------
r.post(
  '/orders',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const phone = req.mall.phone // 身份只取会话：请求体里的 phone 不参与
    const {
      receiver = '', receiver_phone = '', address = '', remark = '', items = [],
      // 券与积分抵扣由**客户在结算页显式选**（`auto_coupon` 才允许自动带上名下可用券）——
      // 与 `coupon.codesForCustomer` 的口径一致：自动带上会让试算顺手把券全用掉。
      coupon_codes: couponCodes = [], use_points: usePoints = 0, auto_coupon: autoCoupon = false
    } = req.body || {}
    if (!receiver || !receiver_phone || !address) return fail(res, '请填写收货人、电话与地址')
    if (!Array.isArray(items) || !items.length) return fail(res, '购物车为空')
    const pf = mallPlatform(db)
    if (!pf) return fail(res, 'H5 商城平台未配置', 500)

    // ① 基准单价：唯一的取价入口（与试算、购物车展示同源）
    const rows = mallLineItems(db, items)
    const bad = rows.find((r) => r.error)
    if (bad) return fail(res, bad.error)
    const goodsCents = rows.reduce((s, r) => s + r.unitCents * r.qty, 0)
    const goodsAmount = Number((goodsCents / 100).toFixed(2))
    // 运费：**不参与折扣**（它是履约成本，不是商品）。所以它是 quote 之外的加项，
    // 而不是塞进明细 —— 塞进去会被会员折扣与促销一起折掉。
    const freight = goodsAmount >= MALL_FREIGHT.freeThreshold ? 0 : MALL_FREIGHT.fee

    // ② 会员档案：身份来自会话，`mall_customers` 里没有就先建账户
    const cust = mallCustomer(db, req.mall)
    const customerId = cust ? M.ensureAccount(db, cust.id).customer_id : null

    const now = new Date()
    const nowText = now.toISOString().slice(0, 19).replace('T', ' ')
    const orderNo = nextDocNo(db, 'H5', 'oms_orders', 'platform_order_no')

    // ③ **一个事务**里做完：落单 → 结算（留痕/登记/券/积分）→ 回写金额。
    //    这几件事必须一起成败：只落了单没结算，客户的钱就收错了且没有留痕；
    //    只结算了没落单，优惠名额被吃掉而单据不存在。
    let result
    try {
      result = db.transaction(() => {
        const info = db
          .prepare(
            `INSERT INTO oms_orders (platform_id,platform_order_no,buyer_nick,order_time,pay_time,status,
                                      goods_amount,freight,discount_amount,pay_amount,receiver,receiver_phone,receiver_address,sync_at,remark)
             VALUES (?,?,?,?,?,'pending',?,?,0,?,?,?,?,datetime('now','localtime'),?)`
          )
          .run(pf.id, orderNo, `会员${phone}`, nowText, nowText, goodsAmount, freight,
            Number((goodsAmount + freight).toFixed(2)), receiver, receiver_phone, address,
            remark || 'H5 商城订单')
        const oid = Number(info.lastInsertRowid)

        // 先插明细拿到行 id，再让结算层按**真实订单行 id** 落优惠留痕 ——
        // 这样 `promotion_adjustments.item_id` 指向的是订单行本身，
        // 详情页"这一行为什么减了 30 元"才对得上（与演示造数同一条路径）。
        const ins = db.prepare(
          'INSERT INTO oms_order_items (oms_order_id,platform_sku_code,sku_id,title,spec,price,qty,amount) VALUES (?,?,?,?,?,?,?,?)'
        )
        const built = rows.map(({ sku, qty, unitCents }) => ({
          item_id: Number(
            ins.run(oid, sku.sku_code, sku.id, `${sku.product_name} ${sku.name}`, sku.spec || null,
              unitCents / 100, qty, (unitCents * qty) / 100).lastInsertRowid
          ),
          sku_id: sku.id,
          qty,
          unit_price_cents: unitCents
        }))

        const settled = K.settle(db, {
          source: 'oms',
          orderId: oid,
          items: K.buildItems(db, built),
          customerId,
          couponCodes,
          autoCoupon: !!autoCoupon,
          usePoints: Number(usePoints) || 0,
          at: nowText
        })

        // 回写行级优惠三段（会员 / 促销 / 积分，单位分）——退货时按行退钱的依据
        const updItem = db.prepare(
          'UPDATE oms_order_items SET member_discount_cents=?, promo_discount_cents=?, points_discount_cents=? WHERE id=?'
        )
        for (const l of settled.line_discounts) {
          updItem.run(l.member_discount, l.promotion_discount, l.points_discount, l.item_id)
        }
        const discountAmount = Number((settled.discount_total / 100).toFixed(2))
        const payAmount = Number(Math.max(0, goodsAmount + freight - discountAmount).toFixed(2))
        db.prepare('UPDATE oms_orders SET discount_amount=?, pay_amount=? WHERE id=?')
          .run(discountAmount, payAmount, oid)
        // 会员冗余展示列由 `earnPoints` 统一维护（含累计消费/订单数与等级重判），
        // 这里只补一个"最近活跃时间"——它不属于营销口径，是会话侧的事实。
        db.prepare("UPDATE mall_customers SET last_active_at=datetime('now','localtime') WHERE phone=?").run(phone)
        db.prepare('DELETE FROM mall_cart_items WHERE phone=?').run(phone)
        db.prepare(
          `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms,created_at)
           VALUES (?,'order','in','success',1,1,0,?,120,datetime('now','localtime'))`
        ).run(pf.id, `H5 商城新订单 ${orderNo}`)

        return {
          id: oid,
          order_no: orderNo,
          goods_amount: goodsAmount,
          freight,
          discount_amount: discountAmount,
          member_discount: Number((settled.member_discount / 100).toFixed(2)),
          promotion_discount: Number((settled.promotion_discount / 100).toFixed(2)),
          points_discount: Number((settled.points_discount / 100).toFixed(2)),
          points_used: settled.points_used,
          points_earned: settled.points_earned?.earned ?? 0,
          coupon_not_used: settled.coupon?.not_used ?? [],
          pay_amount: payAmount
        }
      })()
    } catch (e) {
      // 券不可用 / 积分超上限 / 促销分摊不平…… 都是**可以告诉客户**的业务原因
      if (failFromError(res, e)) return undefined
      throw e
    }
    return ok(res, result)
  })
)

// ---------- 结算试算（C 端会话身份；不写任何表） ----------
// 存在的理由：结算页必须能回答"这一单到底收多少钱、为什么"。
// 它走的是与落单**同一个** `checkout.quote`，所以界面上显示的数与最终收的钱不会分叉。
r.post(
  '/quote',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const cust = mallCustomer(db, req.mall)
    const customerId = cust ? M.ensureAccount(db, cust.id).customer_id : null
    const rows = mallLineItems(db, b.items || [])
    const bad = rows.find((r) => r.error)
    if (bad) return fail(res, bad.error)
    let out
    try {
      out = K.quote(db, {
        // 单价**显式传入** —— 与落单同一份取价结果（不让 `buildItems` 自己兜底成零售价）
        items: K.buildItems(db, rows.map((r) => ({ sku_id: r.sku.id, qty: r.qty, unit_price_cents: r.unitCents }))),
        customerId,
        couponCodes: b.coupon_codes || [],
        autoCoupon: !!b.auto_coupon,
        usePoints: Number(b.use_points) || 0
      })
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
    // C 端不暴露成本口径与内部轨迹，只给"能不能用 / 减多少"
    const freightYuan = Number((out.subtotal / 100).toFixed(2)) >= MALL_FREIGHT.freeThreshold ? 0 : MALL_FREIGHT.fee
    return ok(res, {
      goods_amount: Number((out.subtotal / 100).toFixed(2)),
      freight: freightYuan,
      // **落单后收的钱就是它**（与 `POST /orders` 的 pay_amount 同一算式）——
      // 界面显示的数与最终扣款的数必须来自同一条公式，否则"页面 100、扣款 98"这类
      // 差异只会在对账时以"说不清的一笔钱"出现。
      discount_amount: Number((out.discount_total / 100).toFixed(2)),
      pay_amount: Number((out.payable / 100 + freightYuan).toFixed(2)),
      subtotal: out.subtotal,
      member_discount: out.member_discount,
      promotion_discount: out.promotion_discount,
      points_discount: out.points_discount,
      points_used: out.points_used,
      payable: out.payable,
      discount_total: out.discount_total,
      line_discounts: out.line_discounts,
      applied_codes: out.applied_codes,
      member: out.member,
      coupon: out.coupon,
      points_quote: out.points_quote
    })
  })
)

// ---------- 我的券包（C 端会话身份） ----------
r.get(
  '/coupons',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const cust = mallCustomer(db, req.mall)
    if (!cust) return ok(res, { usable: [], blocked: [], all: [] })
    const all = db
      .prepare(
        `SELECT i.coupon_code, i.status, i.acquired_at, i.expires_at, i.used_at, i.used_amount,
                c.name AS coupon_name, c.type, c.value, c.min_subtotal
           FROM coupon_instances i JOIN coupons c ON c.id=i.coupon_id
          WHERE i.customer_id=? ORDER BY i.id DESC`
      )
      .all(cust.id)
    const avail = C.availableCoupons(db, { customerId: cust.id, orderAmountCents: 0 })
    return ok(res, { ...avail, all })
  })
)

// ---------- 撤单（C 端，仅"还没转销售单"的本单） ----------
// 撤单必须**成对**回退：优惠留痕、使用登记、券、积分（赠送扣回 + 抵现退回）、累计消费
// —— 全部由 `checkout.unsettle` 一处完成（A15 补的就是后半截）。
r.post(
  '/orders/:id/cancel',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const o = db.prepare('SELECT * FROM oms_orders WHERE id=?').get(id)
    if (!o || !isMyOrder(o, req.mall.phone)) return fail(res, '订单不存在', 404)
    if (o.sales_order_id) return fail(res, '订单已转入销售单发货，请走售后退货流程', 409, 409)
    if (o.status !== 'pending') return fail(res, `当前状态（${o.status}）不可撤单`, 409, 409)

    let out
    try {
      out = db.transaction(() => {
        // 撤单要回退的"累计消费"= 结算时计入的实付金额（**分**）
        const spentCents = Math.round(Number(o.pay_amount) * 100)
        const rev = K.unsettle(db, {
          source: 'oms',
          orderId: id,
          reason: `客户撤单（${o.platform_order_no}）`,
          orderAmountCents: spentCents
        })
        // 状态推进**走内核**（`OM` 的 `pending --cancel--> cancelled`），不写自由值。
        //
        // 原来这里是 `UPDATE oms_orders SET status='closed'`，两个后果都不会报错：
        //   ① **`'closed'` 根本不在 `STATES.OM` 里**（OM 只有 pending/shipped/completed/
        //      refunded/cancelled）⇒ 这张单从此**内核看不见**：`allowedActions('OM','closed')`
        //      返回空、任何按内核状态驱动的界面/统计都漏掉它 —— 它成了"内核视野外的一张单"；
        //   ② **没有 `doc_events` 留痕** —— 客户撤单这件事在时间线上不存在（本项目铁律：
        //      留痕须与改动同生共死）。
        // 改走内核后一次解决两件：落 `cancelled`（内核认识的值）+ 同事务写一条含操作人的留痕。
        // ⚠️ 连带：`routes/oms.js:66` 的 GMV 口径原来用 `status NOT IN ('refunded','closed')`
        //    排除撤单单 —— 写入口改成 `cancelled` 后那里也必须跟上，否则**已撤单会算进 GMV**
        //    （只改一半比不改更糟）。同一次改动里一并处理了。
        applyTransition({
          db,
          docType: 'OM',
          id,
          action: 'cancel',
          // C 端没有系统用户；操作人就是客户本人（用手机号标识，不伪造 user id）
          actor: { id: null, name: `商城客户 ${req.mall.phone}` },
          remark: `客户撤单（${o.platform_order_no}）`,
          source: 'api'
        })
        db.prepare(
          `INSERT INTO oms_sync_logs (platform_id,sync_type,direction,status,total_count,success_count,fail_count,message,cost_ms,created_at)
           VALUES (?,'order','out','success',1,1,0,?,80,datetime('now','localtime'))`
        ).run(o.platform_id, `H5 商城撤单 ${o.platform_order_no}`)
        return rev
      })()
    } catch (e) {
      if (failFromError(res, e)) return undefined
      throw e
    }
    // 返回**落库后的真实状态**（F16）：原来写死 `'closed'`，而事务里落的是内核值 `cancelled`，
    // 客户端拿到的字符串与列表/详情再读出来的不一致。这里重读一次，不再写字面量。
    const persisted = db.prepare('SELECT status FROM oms_orders WHERE id=?').get(id)
    return ok(res, { id, status: persisted?.status ?? null, ...out })
  })
)

// ---------- 我的订单（按会话身份） ----------
r.get(
  '/orders',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const phone = req.mall.phone
    const pf = mallPlatform(db)
    if (!pf) return ok(res, [])
    const rows = db
      .prepare(
        `SELECT o.id, o.platform_order_no AS order_no, o.order_time, o.status, o.goods_amount, o.freight,
                o.pay_amount, o.express_company, o.express_no, o.sales_order_id,
                (SELECT COUNT(*) FROM oms_order_items i WHERE i.oms_order_id=o.id) AS item_count
         FROM oms_orders o
         WHERE o.platform_id=? AND (o.receiver_phone=? OR o.buyer_nick=?) 
         ORDER BY o.id DESC LIMIT 30`
      )
      .all(pf.id, phone, `会员${phone}`)
    return ok(res, rows)
  })
)

r.get(
  '/orders/:id',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const o = db
      .prepare(
        `SELECT o.*, (SELECT name FROM platforms WHERE id=o.platform_id) AS platform_name
         FROM oms_orders o WHERE o.id=?`
      )
      .get(Number(req.params.id))
    // 别人的单当作"不存在"：报 403 等于确认"这张单存在，只是不是你的"
    if (!o || !isMyOrder(o, req.mall.phone)) return fail(res, '订单不存在', 404)
    const items = db
      .prepare(
        `SELECT i.*, s.barcode FROM oms_order_items i LEFT JOIN product_skus s ON s.id=i.sku_id WHERE i.oms_order_id=?`
      )
      .all(o.id)
    return ok(res, { order: o, items })
  })
)

// ---------- 会员积分（按会话身份） ----------
r.get(
  '/member',
  requireMall,
  wrap((req, res) => {
    const db = getDb()
    const c = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(req.mall.phone)
    if (!c) return ok(res, null)
    // 等级名与权益从 `member_levels` 带出来 —— 前端不该自己维护一份等级字典
    // （两份字典一旦不同步，界面上的"金牌会员"与结算时按金折扣算的钱就对不上了）。
    const lv = db.prepare('SELECT * FROM member_levels WHERE code=?').get(c.level_code)
    return ok(res, {
      ...c,
      level_name: lv?.name || null,
      discount_pct: lv?.discount_pct ?? 10000,
      points_rate: lv?.points_rate ?? 100,
      points_deduct_limit: lv?.points_deduct_limit ?? 0
    })
  })
)

export default r
