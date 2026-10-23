/**
 * ============================================================================
 * 文件标识：scripts/lib/privacy-common.mjs ｜ 个人信息导出 / 抹除脚本共用底座：手机号校验、定位商城客户涉及的行、带钥伪名
 * ============================================================================
 * 【职责】`privacy-export.mjs` 与 `privacy-erase.mjs` 共用：参数解析、行业库定位、"这个手机号在库里涉及哪些行"的唯一查询。
 *
 * 【范围】本系统没有独立的"地址簿"表；商城（平台 code=H5）的收货信息存在订单上。所以"客户 / 订单 / 地址"= 
 *   mall_customers + member_accounts / member_points_ledger（只导出，不含个人字段）+ mall_cart_items（phone）
 *   + 平台 H5 的 oms_orders（buyer_nick / receiver / receiver_phone / receiver_address）+ 其关联的 sales_orders 收货三列
 *   + pos_orders.member_phone。金额、单号、状态、数量、时间一律不动（财务要用）。
 *
 * 【改它要注意什么】新增含手机号 / 收货信息的商城表，必须同时加到这里的 `collect`，导出与抹除才会一起覆盖；
 *   伪名 = `erased:` + 带钥哈希（密钥来自 GML_SECRET_KEY / JWT 密钥，见 secret-box.keyedPseudonym），换密钥后旧伪名不再可重算。
 * ============================================================================
 */
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { INDUSTRIES, dbPathFor } from '../../server/db/index.js'
import { keyedPseudonym } from '../../server/lib/secret-box.js'

export const PHONE_RE = /^1\d{10}$/
export const ERASED_PREFIX = 'erased:'
export const OPEN_OMS = ['pending', 'shipped', 'refunding']
export const OPEN_SALES = ['draft', 'confirmed', 'picking', 'shipped']

export function fatal(code, message) {
  console.error(`${code}: ${message}`)
  process.exit(2)
}

export const pseudo = (kind, value) => `${ERASED_PREFIX}${keyedPseudonym(kind, value)}`

export function openIndustryDbs(codes, readonly) {
  const out = []
  for (const code of codes) {
    if (!Object.hasOwn(INDUSTRIES, code)) fatal('USAGE', `未知行业：${code}`)
    const file = dbPathFor(code)
    if (fs.existsSync(file)) out.push({ code, db: new Database(file, readonly ? { readonly: true } : {}) })
  }
  return out
}

const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)

/** 手机号在一个行业库里涉及的全部行。纯读。 */
export function collect(db, phone) {
  const pf = db.prepare("SELECT id FROM platforms WHERE code='H5'").get()
  const customer = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone) || null
  const orders = pf
    ? db.prepare('SELECT * FROM oms_orders WHERE platform_id=? AND (receiver_phone=? OR buyer_nick=?) ORDER BY id').all(pf.id, phone, `会员${phone}`)
    : []
  const items = orders.length
    ? db.prepare(`SELECT * FROM oms_order_items WHERE oms_order_id IN (${orders.map(() => '?').join(',')}) ORDER BY id`).all(...orders.map((o) => o.id))
    : []
  const salesIds = orders.map((o) => o.sales_order_id).filter((x) => x != null)
  const sales = salesIds.length
    ? db.prepare(`SELECT * FROM sales_orders WHERE id IN (${salesIds.map(() => '?').join(',')}) ORDER BY id`).all(...salesIds)
    : []
  return {
    customer,
    member_account: customer && has(db, 'member_accounts') ? db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customer.id) || null : null,
    points_ledger: customer && has(db, 'member_points_ledger') ? db.prepare('SELECT * FROM member_points_ledger WHERE customer_id=? ORDER BY id').all(customer.id) : [],
    cart_items: db.prepare('SELECT * FROM mall_cart_items WHERE phone=? ORDER BY id').all(phone),
    orders, order_items: items, sales_orders: sales,
    pos_orders: db.prepare('SELECT * FROM pos_orders WHERE member_phone=? ORDER BY id').all(phone)
  }
}

export const isEmpty = (c) => !c.customer && !c.cart_items.length && !c.orders.length && !c.pos_orders.length
