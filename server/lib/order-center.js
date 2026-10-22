/**
 * ============================================================================
 * 文件标识：server/lib/order-center.js ｜ 订货中心服务层（模块 12A）
 * ============================================================================
 * 【职责】订货中心服务层（模块 12A）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 订货中心服务层（模块 12A）
//
// 一件事实：门店要货与经销商订货本质是同一件事 —— 下级向总部订货。
// 本模块把它们收口到一张单（oc_orders）与一套规则（本文件）上，
// 差别只剩「客户类型、取价维度、审批阈值、分仓候选」四项参数。
//
// 与零售商城的边界（不能混）：
//   订货平台 = 因人而异的价格 + 账期与授信 + 审批 + 对账 + 客户准入
//   零售商城 = 统一定价 + 在线即付 + 无审批 + 无对账 + 注册即用
//   两者共享商品/库存内核，但不共用前台与规则。
//
// 六个硬设计点（来自用户补充轮的调研结论），逐条落到代码：
//   ① 价格因人而异      → quoteItems() 走 resolvePrice，按客户维度取价
//   ② 下单前必须校验    → checkOrder() 返回 checks[]，任一 blocking 即拒单
//   ③ 审批是有条件的    → decideApproval() 按 oc_approval_rules 命中规则
//   ④ 对账是主功能      → buildStatement() / confirmStatement()
//   ⑤ 智能分仓          → pickWarehouse() 按库存满足率 + 区域就近打分
//   ⑥ 多端多种下单方式  → createOrder({ source }) 支持 web/import/repeat/mcp

import { resolvePrice } from './pricing.js'
import { nextDocNoByRule } from './docno.js'
import { applyTransition, allowedActions, DocFlowError, claimTransitionEffect } from './docflow.js'
import { localDate, localNow, addDays } from './dates.js'
// 授信台账写入下沉到 oc-credit.js：模块 21 的收款核销也要写同一本台账，
// 若继续放在本文件会形成 order-center → ar(生成应收) → order-center(释放授信) 的循环依赖
import { writeOcCredit, releaseByOrder, reoccupyByOrder, ocCreditUsed } from './oc-credit.js'
import { ensureAr, ensureOcAr, AR_SOURCE_OC } from './ar.js'
import { readSetting } from './settings.js'
// 仓库类型的**唯一出处**。可发货仓型不再在本文件手写清单（那正是下面那处缺陷的成因）：
// 手写的 `('normal','regional','central','kitchen','consignment')` 里 `regional` 是拼错的
// （真值 `region`）、`consignment` 不在值域里 ⇒ 区域仓被整类漏掉且**不报错**。
import { WAREHOUSE_TYPE_CODES, isIsolationWarehouseType } from './warehouse.js'

const nowStr = () => localNow()
// 业务日一律本地口径（dates.js）。订货单号里的日期段也由它派生，
// 用 toISOString() 会让凌晨下的单拿到昨天的单号。
const ymd = (d = new Date()) => localDate(d)
// 日期加减统一走 dates.js 的 addDays（本地整数运算，不经过 toISOString）
const dayShift = (base, n) => addDays(base, n)

export class OrderCenterError extends Error {
  constructor(message, { code = 'ORDER_CENTER_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'OrderCenterError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 一、订货主体
// ---------------------------------------------------------------------------

/** 客户等级 → 取价维度（channel / store_type / dealer_level 的取值） */
function pricingDims(cust) {
  const channel = cust.channel || (cust.source_type === 'store' ? 'direct' : 'dealer')
  return {
    channel,
    storeType: cust.source_type === 'store' ? (cust.level === 'gold' ? 'direct' : cust.channel) : null,
    dealerLevel: cust.source_type === 'dealer' ? cust.level : null,
    region: cust.region || null
  }
}

/** 由门店档案推导订货口径 */
function fromStore(db, st) {
  const franchise = st.type === 'franchise'
  // 直营门店是**内部主体**，货主归总部，走内部调拨往来 —— 不适用对外授信。
  // 曾经把直营店按对外客户处理（授信 0），结果是全部门店被「额度已用尽」拦死：
  // 一个不存在的额度被当成 0 来校验，比不校验更糟。
  const internal = !franchise
  return {
    code: `OCS_${st.code}`,
    name: st.name,
    source_type: 'store',
    source_id: st.id,
    level: franchise ? 'silver' : 'gold',
    channel: franchise ? 'franchise' : 'direct',
    region: st.region,
    city: st.city,
    contact: st.manager,
    phone: st.phone,
    address: st.address,
    currency: st.currency || 'CNY',
    owner_org_id: st.owner_org_id || null,
    org_id: st.org_id || null,
    settle_type: internal ? 'internal' : 'credit',
    credit_limit: franchise ? 80000 : null,
    credit_days: franchise ? 30 : 0,
    price_level: franchise ? 'franchise' : 'direct'
  }
}

/** 由经销商档案推导订货口径 */
function fromDealer(db, d) {
  // 档案里的 settle_type 是中文描述（'月结 30 天' / '现结'），订货中心需要可判定的口径。
  // 把「档案怎么写的」翻译成「系统怎么算的」，翻译规则只此一处 —— 不散到各路由。
  const raw = String(d.settle_type || '')
  const prepay = /现结|预付|现款/.test(raw)
  const m = /(\d+)\s*天/.exec(raw)
  const creditDays = prepay ? 0 : (m ? Number(m[1]) : (d.credit_days > 0 ? d.credit_days : 30))
  return {
    code: `OCD_${d.code}`,
    name: d.name,
    source_type: 'dealer',
    source_id: d.id,
    level: d.level || 'silver',
    channel: 'dealer',
    region: d.region,
    city: d.city,
    contact: d.contact,
    phone: d.phone,
    address: d.address,
    currency: 'CNY',
    owner_org_id: null,
    org_id: d.org_id || null,
    settle_type: prepay ? 'prepay' : 'credit',
    credit_limit: d.credit_limit ?? null,
    credit_days: creditDays,
    price_level: d.price_level || d.level,
    discount_rate: d.discount_rate ?? null
  }
}

/** 下游终端门店（经销商的客户，不是我方主数据里的门店）：由调用方给出档案 */
function fromDownstream(p) {
  return {
    code: p.code,
    name: p.name,
    source_type: 'downstream',
    source_id: p.source_id,
    level: p.level || 'bronze',
    channel: p.channel || 'sub_dealer',
    region: p.region || null,
    city: p.city || null,
    contact: p.contact || null,
    phone: p.phone || null,
    address: p.address || null,
    currency: p.currency || 'CNY',
    owner_org_id: p.owner_org_id ?? null,
    org_id: null,
    settle_type: p.settle_type || 'prepay',
    credit_limit: p.credit_limit ?? 0,
    credit_days: p.credit_days ?? 0,
    price_level: p.price_level || 'sub_dealer',
    discount_rate: null
  }
}

/**
 * 取（必要时建）一个订货主体。
 * 档案真相仍在 stores / dealers，本表只承载「能不能订、能订多少、怎么订」。
 * source_type='downstream' 用于「经销商的下游终端门店」—— 它不是我方主数据，
 * 因此 source_id 用负数合成（保证 UNIQUE 成立，且一眼看出不是主数据 id）。
 */
export function ensureCustomer(db, { sourceType, sourceId = null, parentCustomerId = null, profile = null } = {}) {
  if (sourceType === 'downstream') {
    if (!profile?.code || !profile?.name) {
      throw new OrderCenterError('下游客户必须提供 profile.code 与 profile.name', { code: 'BAD_PROFILE' })
    }
    const exist = db.prepare('SELECT * FROM oc_customers WHERE code=?').get(profile.code)
    if (exist) return exist
    const min = db.prepare("SELECT MIN(source_id) m FROM oc_customers WHERE source_type='downstream'").get().m
    const syntheticId = (min == null ? 0 : Math.min(0, min)) - 1
    const base = fromDownstream({ ...profile, source_id: syntheticId })
    return insertCustomer(db, base, parentCustomerId)
  }

  const existing = db
    .prepare('SELECT * FROM oc_customers WHERE source_type=? AND source_id=?')
    .get(sourceType, sourceId)
  if (existing) return existing

  const srcRow =
    sourceType === 'store'
      ? db.prepare('SELECT * FROM stores WHERE id=?').get(sourceId)
      : db.prepare('SELECT * FROM dealers WHERE id=?').get(sourceId)
  if (!srcRow) {
    throw new OrderCenterError(`订货主体来源不存在：${sourceType}#${sourceId}`, {
      code: 'CUSTOMER_SOURCE_NOT_FOUND', httpStatus: 404
    })
  }
  const base = sourceType === 'store' ? fromStore(db, srcRow) : fromDealer(db, srcRow)
  return insertCustomer(db, base, parentCustomerId)
}

function insertCustomer(db, base, parentCustomerId) {
  const info = db
    .prepare(
      `INSERT INTO oc_customers
        (code,name,source_type,source_id,parent_customer_id,level,channel,region,city,contact,phone,address,
         owner_org_id,org_id,settle_type,credit_limit,credit_days,price_level,discount_rate,admit_status,admit_at,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`
    )
    .run(
      base.code, base.name, base.source_type, base.source_id, parentCustomerId,
      base.level, base.channel, base.region, base.city, base.contact, base.phone, base.address,
      base.owner_org_id, base.org_id, base.settle_type, base.credit_limit ?? null,
      base.credit_days ?? null, base.price_level ?? null, base.discount_rate ?? null,
      'active' // 演示口径：主数据已存在即视为已准入；真实场景应为 pending 待审核
    )
  const id = Number(info.lastInsertRowid)
  db.prepare(
    'INSERT INTO oc_addresses (customer_id,name,contact,phone,region,city,address,is_default) VALUES (?,?,?,?,?,?,?,1)'
  ).run(id, base.name, base.contact, base.phone, base.region, base.city, base.address)
  // 订货中心统一用 CNY 记账，但客户所在币种要保留（中国香港门店为 HKD）——
  // 门店档案的 currency 已经在 oc_customers.currency 上带出，结算币种另存一份便于扩展
  return db.prepare('SELECT * FROM oc_customers WHERE id=?').get(id)
}

export function getCustomer(db, id) {
  const c = db.prepare('SELECT * FROM oc_customers WHERE id=?').get(id)
  if (!c) throw new OrderCenterError(`订货主体 #${id} 不存在`, { code: 'CUSTOMER_NOT_FOUND', httpStatus: 404 })
  return c
}

/** 客户树（多级渠道）：返回该客户及其全部下级 */
export function customerTree(db, rootId = null) {
  const all = db.prepare('SELECT * FROM oc_customers ORDER BY id').all()
  const byParent = new Map()
  for (const c of all) {
    const k = c.parent_customer_id || 0
    if (!byParent.has(k)) byParent.set(k, [])
    byParent.get(k).push(c)
  }
  const build = (node) => ({ ...node, children: (byParent.get(node.id) || []).map(build) })
  if (rootId) return build(getCustomer(db, rootId))
  return (byParent.get(0) || []).map(build)
}

// ---------------------------------------------------------------------------
// 二、授信（额度只有一个真相：oc_credit_ledger 的求和）
// ---------------------------------------------------------------------------

/**
 * 授信快照。
 * 额度来源优先级：oc_customers.credit_limit → 来源档案（dealers.credit_limit）
 * 已用额度 = SUM(oc_credit_ledger.amount)，绝不读缓存列 —— 缓存列迟早对不上账。
 */
export function creditSnapshot(db, customerId) {
  const cust = getCustomer(db, customerId)
  let limit = cust.credit_limit
  if (limit === null || limit === undefined) {
    if (cust.source_type === 'dealer') {
      limit = db.prepare('SELECT credit_limit FROM dealers WHERE id=?').get(cust.source_id)?.credit_limit ?? 0
    } else {
      limit = 0
    }
  }
  const used = db
    .prepare('SELECT COALESCE(SUM(amount),0) s FROM oc_credit_ledger WHERE customer_id=?')
    .get(customerId).s
  const limitNum = Number(limit) || 0
  const usedNum = Number(used) || 0
  const available = limitNum - usedNum

  // 账期逾期：最近一张已确认但未结清的对账单的最早到期日
  const overdue = db
    .prepare(
      `SELECT MIN(s.period_end) d FROM oc_statements s
       WHERE s.customer_id=? AND s.status='confirmed' AND s.diff_amount > 0.001`
    )
    .get(customerId)?.d
  const creditDays = cust.credit_days ?? 0
  let overdueDays = 0
  if (overdue && creditDays > 0) {
    const due = new Date(`${overdue}T00:00:00`)
    due.setDate(due.getDate() + creditDays)
    overdueDays = Math.floor((Date.now() - due.getTime()) / 86400000)
  }

  return {
    customerId,
    creditLimit: limitNum,
    creditUsed: usedNum,
    creditAvailable: available,
    creditDays,
    settleType: cust.settle_type,
    overdueDays: Math.max(overdueDays, 0),
    utilization: limitNum > 0 ? Number((usedNum / limitNum).toFixed(4)) : 0
  }
}

export function writeCredit(db, opts) {
  // 实现已下沉到 oc-credit.js（模块 21 收款核销要写同一本台账，避免循环依赖）；
  // 保留本导出名是为了不动既有的 12A 调用点。
  return writeOcCredit(db, opts)
}

// ---------------------------------------------------------------------------
// 三、可见商品（按等级 / 渠道 / 客户控制）
// ---------------------------------------------------------------------------

/**
 * 客户可见 SKU 列表。
 * 规则：默认全部上架商品可见；oc_visibility_rules 里显式 allowed=0 的品类/品牌被隐藏。
 * 取优先级最高的那条规则（priority 小者优先）作为结论 —— 避免「一条允许一条禁止」时结果随机。
 */
export function visibleSkus(db, customerId, { keyword = null, categoryId = null, limit = 200, offset = 0 } = {}) {
  const cust = getCustomer(db, customerId)
  const rules = db
    .prepare(
      `SELECT * FROM oc_visibility_rules
       WHERE (scope='level' AND scope_value=?)
          OR (scope='channel' AND scope_value=?)
          OR (scope='customer' AND scope_value=?)
       ORDER BY priority, id`
    )
    .all(cust.level || '', cust.channel || '', String(customerId))

  const hiddenCats = new Set()
  const hiddenBrands = new Set()
  const decidedCats = new Set()
  for (const r of rules) {
    if (r.category_id && decidedCats.has(`c${r.category_id}`)) continue
    if (r.category_id) {
      decidedCats.add(`c${r.category_id}`)
      if (!r.allowed) hiddenCats.add(r.category_id)
    }
    if (r.brand_id && !r.allowed) hiddenBrands.add(r.brand_id)
  }

  const conds = ["p.status='active'"]
  const args = []
  if (keyword) {
    conds.push('(p.name LIKE ? OR s.sku_code LIKE ?)')
    args.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (categoryId) {
    conds.push('p.category_id=?')
    args.push(Number(categoryId))
  }
  if (hiddenCats.size) {
    conds.push(`p.category_id NOT IN (${[...hiddenCats].map(() => '?').join(',')})`)
    args.push(...hiddenCats)
  }
  if (hiddenBrands.size) {
    conds.push(`p.brand_id NOT IN (${[...hiddenBrands].map(() => '?').join(',')})`)
    args.push(...hiddenBrands)
  }

  const rows = db
    .prepare(
      `SELECT s.id AS sku_id, s.sku_code, s.name AS sku_name, s.spec, p.unit AS uom, s.barcode,
              p.id AS product_id, p.name AS product_name, p.category_id, p.brand_id, p.tax_rate,
              b.name AS brand_name, c.name AS category_name,
              s.price_retail, s.price_dealer
       FROM product_skus s
       JOIN products p ON p.id=s.product_id
       LEFT JOIN brands b ON b.id=p.brand_id
       LEFT JOIN categories c ON c.id=p.category_id
       WHERE ${conds.join(' AND ')}
       ORDER BY p.id, s.id
       LIMIT ? OFFSET ?`
    )
    .all(...args, Number(limit), Number(offset))

  const dims = pricingDims(cust)
  return rows.map((r) => {
    const pr = resolvePrice(db, { skuId: r.sku_id, orgId: cust.org_id, ...dims, qty: 1 })
    return {
      ...r,
      price: pr.price,
      currency: pr.currency,
      priceSource: pr.source,
      priceGroup: pr.groupName || null,
      ladderMinQty: pr.ladderMinQty ?? null,
      visible: true
    }
  })
}

// ---------------------------------------------------------------------------
// 四、取价与可售量（试算）
// ---------------------------------------------------------------------------

/** 可售量：现存量 − 占用 + 在途（第三轮「一盘货」口径，按客户的可达仓汇总） */
export function availableQty(db, skuId, warehouseIds) {
  if (!warehouseIds || !warehouseIds.length) return 0
  const ph = warehouseIds.map(() => '?').join(',')
  return (
    db
      .prepare(
        `SELECT COALESCE(SUM(qty_on_hand - qty_reserved + qty_in_transit),0) a
         FROM inventory_stocks WHERE sku_id=? AND warehouse_id IN (${ph})`
      )
      .get(skuId, ...warehouseIds).a || 0
  )
}

/**
 * 试算：逐行取价 + 阶梯 + 可售量，返回明细与告警。
 * 不落库、不改状态，可反复调用（下单前置校验与界面「购物车」共用）。
 */
export function quoteItems(db, { customerId, items = [], expectDate = null, at = null }) {
  const cust = getCustomer(db, customerId)
  const dims = pricingDims(cust)
  const custWhs = customerWarehouseIds(db, cust)
  const lines = []
  const warnings = []

  for (const [i, it] of items.entries()) {
    const skuId = Number(it.sku_id ?? it.skuId)
    const qty = Number(it.qty)
    if (!skuId) throw new OrderCenterError(`第 ${i + 1} 行缺少 sku_id`, { code: 'BAD_LINE' })
    if (!(qty > 0)) throw new OrderCenterError(`第 ${i + 1} 行数量必须大于 0`, { code: 'BAD_QTY' })

    const sku = db
      .prepare(
        `SELECT s.*, s.sku_code AS sku_code, s.name AS line_name,
                p.name AS product_name, p.category_id, p.brand_id, p.unit AS uom, p.tax_rate
         FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?`
      )
      .get(skuId)
    if (!sku) throw new OrderCenterError(`SKU#${skuId} 不存在`, { code: 'SKU_NOT_FOUND', httpStatus: 404 })

    const pr = resolvePrice(db, { skuId, orgId: cust.org_id, ...dims, qty, at })
    const avail = availableQty(db, skuId, custWhs)
    const amount = Number((pr.price * qty).toFixed(2))

    if (pr.warn) warnings.push(`第 ${i + 1} 行：${pr.warn}`)
    if (avail > 0 && avail < qty) {
      warnings.push(`第 ${i + 1} 行「${sku.product_name}」可售 ${avail} 不足订货 ${qty}，将按缺口分单/待补`)
    }
    if (avail <= 0) warnings.push(`第 ${i + 1} 行「${sku.product_name}」暂无可用库存`)

    lines.push({
      line_no: i + 1,
      sku_id: skuId,
      sku_code: sku.sku_code,
      sku_name: sku.line_name || sku.product_name,
      uom: sku.uom,
      qty,
      price: pr.price,
      amount,
      price_source: pr.source,
      price_group: pr.groupName || pr.groupCode || null,
      currency: pr.currency || cust.currency,
      available_qty: Number(avail.toFixed(2)),
      tax_rate: sku.tax_rate ?? null,
      price_trace: pr.trace || []
    })
  }

  const totalQty = lines.reduce((a, l) => a + l.qty, 0)
  const totalAmount = Number(lines.reduce((a, l) => a + l.amount, 0).toFixed(2))
  return {
    customer: cust,
    currency: cust.currency,
    expectDate: expectDate || dayShift(new Date(), cust.credit_days > 0 ? 3 : 2),
    lines,
    warnings,
    totalQty,
    totalAmount
  }
}

// ---------------------------------------------------------------------------
// 五、下单前校验（B2B 与 B2C 最本质的差别就在这里）
// ---------------------------------------------------------------------------

/**
 * 校验结果里的 severity：
 *   block  必须拦住，不允许提交
 *   warn   允许提交但必须留痕（例如超授信走特批）
 *   info   仅提示
 * 返回 blocking 便于调用方一行判断。
 */
export function checkOrder(db, { customerId, quote }) {
  const cust = getCustomer(db, customerId)
  const checks = []
  const add = (code, severity, message, detail = null) =>
    checks.push({ code, severity, message, detail })

  // 1. 准入状态
  if (cust.admit_status !== 'active') {
    add('ADMIT', 'block', `客户准入状态为「${cust.admit_status}」，不可下单`)
  }
  if (cust.admit_status === 'frozen') {
    add('FROZEN', 'block', `客户已冻结：${cust.frozen_reason || '未说明原因'}`)
  }

  // 2. 起订量 / 起订金额
  const minQty = Number(cust.min_order_qty || 0)
  const minAmt = Number(cust.min_order_amount || 0)
  if (minQty > 0 && quote.totalQty < minQty) {
    add('MIN_QTY', 'block', `未达最小起订量 ${minQty}，当前 ${quote.totalQty}`, { minQty })
  }
  if (minAmt > 0 && quote.totalAmount < minAmt) {
    add('MIN_AMOUNT', 'block', `未达最小起订金额 ${minAmt}，当前 ${quote.totalAmount}`, { minAmt })
  }

  // 3. 授信与账期
  //    internal（直营门店内部往来）不走对外授信 —— 没有额度就谈不上用尽。
  const snap = creditSnapshot(db, customerId)
  let creditHold = 0
  if (cust.settle_type === 'internal') {
    add('INTERNAL', 'info', '直营门店走内部调拨往来，不适用对外授信')
  } else if (cust.settle_type === 'prepay') {
    add('PREPAY', 'info', '该客户为现结客户，下单后需先付款再发货')
  } else {
    creditHold = quote.totalAmount
    if (snap.overdueDays > 0) {
      add('OVERDUE', 'block', `存在逾期未结账款 ${snap.overdueDays} 天，暂停下单`, { overdueDays: snap.overdueDays })
    }
    if (snap.creditAvailable <= 0) {
      add('NO_CREDIT', 'block', `授信额度已用尽（额度 ${snap.creditLimit}，已用 ${snap.creditUsed}）`)
    } else if (creditHold > snap.creditAvailable) {
      add(
        'OVER_CREDIT',
        'warn',
        `本单 ${creditHold} 超出可用授信 ${Number(snap.creditAvailable.toFixed(2))}，需特批`,
        { hold: creditHold, available: snap.creditAvailable }
      )
    }
    if (snap.utilization >= 0.9) {
      add('CREDIT_TIGHT', 'warn', `授信使用率已达 ${(snap.utilization * 100).toFixed(1)}%`, { utilization: snap.utilization })
    }
  }

  // 4. 缺货（可售不足）
  //    口径：缺货默认**不拦单**，而是转「待补/拆单」并留痕 ——
  //    真正会拦的是客户策略 allow_shortage=0（例如宴席大单必须足量交付）。
  //    若把缺货做成硬拦，演示里大部分单都下不进去，与真实 B2B 行为不符。
  const shortLines = quote.lines.filter((l) => l.available_qty < l.qty)
  const shortage = {
    lines: shortLines.map((l) => ({ line: l.line_no, sku: l.sku_name, need: l.qty, avail: l.available_qty }))
  }
  if (shortLines.length) {
    const all = shortLines.length === quote.lines.length
    add(
      all ? 'OUT_OF_STOCK' : 'PARTIAL_STOCK',
      cust.allow_shortage ? 'warn' : 'block',
      cust.allow_shortage
        ? `${shortLines.length} 行可售不足，缺货部分转待补/拆单`
        : `${shortLines.length} 行可售不足，该客户要求足量交付，不可下单`,
      shortage
    )
  }

  const blocking = checks.filter((c) => c.severity === 'block')
  return { checks, blocking, pass: blocking.length === 0, creditHold, credit: snap, shortage }
}

// ---------------------------------------------------------------------------
// 六、条件审批
// ---------------------------------------------------------------------------

/** 命中哪些审批规则（多节点取并集，按 seq 串成链） */
export function decideApproval(db, { customerId, quote, check }) {
  const cust = getCustomer(db, customerId)
  const rules = db
    .prepare(
      `SELECT * FROM oc_approval_rules WHERE status='active'
         AND (scope='global'
           OR (scope='channel' AND channel=?)
           OR (scope='customer' AND customer_id=?))
       ORDER BY priority, seq, id`
    )
    .all(cust.channel || '', customerId)

  const ctx = {
    amount: quote.totalAmount,
    qty: quote.totalQty,
    credit_over: Number(((check.creditHold || 0) - (check.credit?.creditAvailable || 0)).toFixed(2)),
    no_credit: check.credit?.creditAvailable <= 0 ? 1 : 0,
    overdue: check.credit?.overdueDays || 0,
    short_lines: check.shortage?.lines?.length || 0
  }

  const hit = []
  for (const r of rules) {
    const v = Number(ctx[r.cond_field] ?? 0)
    const t = Number(r.cond_value ?? 0)
    const pass =
      r.cond_op === '>' ? v > t
      : r.cond_op === '>=' ? v >= t
      : r.cond_op === '<' ? v < t
      : r.cond_op === '<=' ? v <= t
      : r.cond_op === '==' ? v === t
      : v !== t
    if (pass) hit.push(r)
  }
  // 同一 (node, approver_role) 去重：规则表可以多条命中，但审批链不该出现两个同名节点
  const seen = new Set()
  const chain = []
  for (const r of hit) {
    const k = `${r.node}|${r.approver_role}`
    if (seen.has(k)) continue
    seen.add(k)
    chain.push({ node: r.node, approverRole: r.approver_role, ruleCode: r.code })
  }
  return { rules: hit, chain, needApproval: chain.length > 0 }
}

// ---------------------------------------------------------------------------
// 七、智能分仓（按库存满足率 + 区域就近）
// ---------------------------------------------------------------------------

/** 客户可达仓：直营/加盟门店 → 门店仓 + 同区域仓 + 央厨仓；经销商 → 同区域仓 */
export function customerWarehouseIds(db, cust) {
  const ids = []
  // 可发货仓型 = **权威值域里除隔离仓之外**的全部类型（判据一处、两个分支共用）。
  //
  // 为什么不再手写清单（这处原来是）：
  //   `WHERE type IN ('normal','regional','central','kitchen','consignment')`
  //   · `regional` **拼错了** —— 值域里是 `region`（`lib/warehouse.js` 的 `WAREHOUSE_TYPES`）；
  //   · `consignment` **根本不在值域里**；
  //   ⇒ 这条白名单实际只命中 `normal`/`central`/`kitchen`：**区域仓被整类漏掉**，
  //     而且不报错（只是候选少了一类 —— 静默的错）。
  //   现在从值域派生 ⇒ **将来新增仓型自动纳入**、拼错的字面量不可能再出现。
  // 隔离仓（不合格品仓 / 待检品仓）按 `lib/warehouse.js` 的语义**必须排除**：
  //   "隔离仓不是经营仓 —— 绝不能被'选发货仓 / 选货源仓'这类下拉选中"。
  const shippable = WAREHOUSE_TYPE_CODES.filter((c) => !isIsolationWarehouseType(c))
  const ph = shippable.map(() => '?').join(',')
  if (cust.source_type === 'store') {
    // 门店仓同样按同一判据过滤：隔离仓绝不能当货源（原来这个分支**完全不按类型过滤**）
    const own = db
      .prepare(`SELECT id FROM warehouses WHERE store_id=? AND type IN (${ph})`)
      .all(cust.source_id, ...shippable)
    ids.push(...own.map((r) => r.id))
  }
  const regional = db
    .prepare(`SELECT id FROM warehouses WHERE type IN (${ph}) AND (region=? OR ? IS NULL)`)
    .all(...shippable, cust.region, cust.region)
  ids.push(...regional.map((r) => r.id))
  return [...new Set(ids)]
}

/**
 * 分仓打分：0.7 × 满足率 + 0.3 × 就近度
 * 满足率 = min(1, 可售/需求) 的均值；就近度 = 同城 1 / 同区域 0.6 / 其他 0.2
 * 用打分而不是「找第一个能装的仓」：后者会让所有单都压到同一仓，
 * 演示里表现为「库存充足但某仓爆仓、其他仓闲置」。
 */
export function pickWarehouse(db, { customerId, quote, at = null }) {
  const cust = getCustomer(db, customerId)
  const whs = db
    .prepare(`SELECT * FROM warehouses WHERE id IN (${customerWarehouseIds(db, cust).map(() => '?').join(',') || 'NULL'})`)
    .all(...customerWarehouseIds(db, cust))
  if (!whs.length) return null

  const need = quote.lines.map((l) => ({ skuId: l.sku_id, qty: l.qty }))
  const scored = whs.map((w) => {
    let fillSum = 0
    let fullLines = 0
    const detail = []
    for (const n of need) {
      const qty =
        db
          .prepare(
            `SELECT COALESCE(SUM(qty_on_hand - qty_reserved + qty_in_transit),0) a
             FROM inventory_stocks WHERE sku_id=? AND warehouse_id=?`
          )
          .get(n.skuId, w.id).a || 0
      const fill = n.qty > 0 ? Math.min(1, qty / n.qty) : 0
      fillSum += fill
      if (fill >= 1) fullLines += 1
      detail.push({ skuId: n.skuId, need: n.qty, stock: Number(qty.toFixed(2)), fill: Number(fill.toFixed(3)) })
    }
    const fillRate = need.length ? fillSum / need.length : 0
    const proximity = w.city && cust.city && w.city === cust.city ? 1 : w.region && w.region === cust.region ? 0.6 : 0.2
    return {
      warehouseId: w.id,
      code: w.code,
      name: w.name,
      type: w.type,
      region: w.region,
      currency: w.currency,
      fillRate: Number(fillRate.toFixed(3)),
      fullLines,
      lineCount: need.length,
      proximity,
      score: Number((0.7 * fillRate + 0.3 * proximity).toFixed(4)),
      detail
    }
  })
  scored.sort((a, b) => b.score - a.score || b.fullLines - a.fullLines || a.warehouseId - b.warehouseId)
  return scored[0]
}

// ---------------------------------------------------------------------------
// 八、下单（写单 + 审批链 + 信用占用，同一事务）
// ---------------------------------------------------------------------------

export function createOrder(db, {
  customerId, items, expectDate = null, remark = null, source = 'web',
  sourceRef = null, actor = null, orderDate = null, autoSubmit = true, at = null
}) {
  const cust = getCustomer(db, customerId)
  const quote = quoteItems(db, { customerId, items, expectDate, at })
  const check = checkOrder(db, { customerId, quote })
  if (!check.pass) {
    throw new OrderCenterError(
      `下单前校验未通过：${check.blocking.map((c) => c.message).join('；')}`,
      { code: 'PRE_CHECK_FAILED', httpStatus: 409, detail: check }
    )
  }
  const approval = decideApproval(db, { customerId, quote, check })
  const pick = pickWarehouse(db, { customerId, quote, at })
  const docNo = nextOrderNo(db, orderDate || ymd(new Date()))

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO oc_orders
          (doc_no,customer_id,customer_type,customer_name,store_id,dealer_id,order_date,expect_date,status,
           channel,region,currency,total_qty,total_amount,credit_hold,credit_checked_at,need_approval,approval_reason,
           ship_warehouse_id,ship_warehouse,allocate_note,source,source_ref,remark,org_id,creator_id,creator_name,created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`
      )
      .run(
        docNo, cust.id, cust.source_type, cust.name,
        cust.source_type === 'store' ? cust.source_id : null,
        cust.source_type === 'dealer' ? cust.source_id : null,
        orderDate || ymd(new Date()), quote.expectDate, autoSubmit ? 'submitted' : 'draft',
        cust.channel, cust.region, quote.currency, quote.totalQty, quote.totalAmount,
        check.creditHold, nowStr(), approval.needApproval ? 1 : 0,
        approval.needApproval ? approval.chain.map((c) => c.node).join(' → ') : null,
        pick?.warehouseId ?? null, pick?.name ?? null,
        pick ? `满足率 ${(pick.fillRate * 100).toFixed(0)}%，${pick.fullLines}/${pick.lineCount} 行足量` : null,
        source, sourceRef, remark, cust.owner_org_id,
        actor?.id ?? null, actor?.name ?? null
      )
    const orderId = Number(info.lastInsertRowid)

    const insItem = db.prepare(
      `INSERT INTO oc_order_items
        (order_id,line_no,sku_id,sku_code,sku_name,uom,qty,price,amount,price_source,price_group,currency,available_qty,tax_rate,remark)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    for (const l of quote.lines) {
      insItem.run(
        orderId, l.line_no, l.sku_id, l.sku_code, l.sku_name, l.uom, l.qty, l.price, l.amount,
        l.price_source, l.price_group, l.currency, l.available_qty, l.tax_rate, null
      )
    }

    const insAppr = db.prepare(
      `INSERT INTO oc_order_approvals (order_id,seq,node,rule_code,approver_role,decision,created_at)
       VALUES (?,?,?,?,?,'pending',datetime('now','localtime'))`
    )
    approval.chain.forEach((c, i) => insAppr.run(orderId, i + 1, c.node, c.ruleCode, c.approverRole))

    // 信用占用：只在需要授信且已提交时占用（草稿不占，避免删草稿要冲销）
    if (autoSubmit && cust.settle_type !== 'prepay' && check.creditHold > 0) {
      writeCredit(db, {
        customerId: cust.id, orderId, docNo, changeType: 'occupy', amount: check.creditHold,
        operator: actor?.name || null, remark: `订货占用（${docNo}）`
      })
    }

    // 留痕：下单本身也要进单据一生
    db.prepare(
      `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,payload_json,org_id,created_at)
       VALUES ('OC',?,?,?,?,NULL,?,?,?,?,?,?,?,datetime('now','localtime'))`
    ).run(
      orderId, docNo, autoSubmit ? 'submit' : 'create', autoSubmit ? '提交订货' : '创建草稿',
      autoSubmit ? 'submitted' : 'draft', actor?.id ?? null, actor?.name ?? null, source,
      approval.needApproval ? `触发审批：${approval.chain.map((c) => c.node).join(' → ')}` : '免审批直通',
      JSON.stringify({ quote: { totalQty: quote.totalQty, totalAmount: quote.totalAmount }, checks: check.checks }),
      cust.owner_org_id
    )

    return orderId
  })

  const orderId = tx()
  return {
    order: getOrder(db, orderId),
    quote,
    check,
    approval,
    pick
  }
}

/** 订货单号：走编码规则表（模块 06），规则缺失时回落默认格式（不静默失败） */
function nextOrderNo(db, bizDate) {
  const no = nextDocNoByRule(db, { docType: 'OC', bizDate })
  if (no) return no
  const seq = db.prepare("SELECT COUNT(*) c FROM oc_orders WHERE doc_no LIKE 'OC%'").get().c + 1
  return `OC${String(bizDate).replace(/-/g, '')}${String(seq).padStart(4, '0')}`
}

// ---------------------------------------------------------------------------
// 九、单据流转（副作用与状态变更同事务）
// ---------------------------------------------------------------------------

export function getOrder(db, id) {
  const o = db.prepare('SELECT * FROM oc_orders WHERE id=?').get(id)
  if (!o) throw new OrderCenterError(`订货单 #${id} 不存在`, { code: 'ORDER_NOT_FOUND', httpStatus: 404 })
  o.items = db.prepare('SELECT * FROM oc_order_items WHERE order_id=? ORDER BY line_no').all(id)
  o.approvals = db.prepare('SELECT * FROM oc_order_approvals WHERE order_id=? ORDER BY seq').all(id)
  const snap = creditSnapshot(db, o.customer_id)
  o.credit = snap
  o.actions = allowedActions(db, 'OC', o.status).map((a) => ({
    action: a.action, name: a.actionName, to: a.to, isDanger: a.isDanger
  }))
  o.events = db
    .prepare('SELECT * FROM doc_events WHERE doc_type=\'OC\' AND doc_id=? ORDER BY id')
    .all(id)
  return o
}

/**
 * 统一流转入口。
 * 副作用规则：
 *   cancel  释放已占用的授信
 *   allocate 落分仓结果
 *   receive  释放授信占用并转「应收待结」（settle 正向入账，占用量归零）
 * 关键：状态变更与信用流水在同一事务，避免「单取消了、额度没退」。
 */
/**
 * 收货后并入应收（模块 21）。
 * 开关落在 settings.ar_oc_enabled（020 迁移写入，默认 1）：
 * 过渡期想「只做订货、暂不并入财务」时改配置即可，不必改代码、更不必注释掉一段逻辑。
 */
function maybeEnsureArOnReceive(db, orderId, actor) {
  // 唯一读取点走 `readSetting`：它返回**布尔**（`SETTING_RULES.ar_oc_enabled` 的 `type: 'bool'`），
  // 读不到或值非法都回落到默认值「开」—— 与原来那句 "只有恰好是 '0' 才关" 等价。
  if (!readSetting(db, 'ar_oc_enabled')) return null
  const order = db.prepare('SELECT * FROM oc_orders WHERE id=?').get(orderId)
  if (!order) return null
  return ensureOcAr(db, order, actor)
}

export function transitionOrder(db, {
  id, action, actor = null, remark = null, source = 'api',
  warehouseId = null, expectFrom = null, extraSet = null
}) {
  const before = getOrder(db, id)
  const set = { updated_at: nowStr(), ...(extraSet || {}) }

  if (action === 'cancel') {
    const tx = db.transaction(() => {
      const r = applyTransition({ db, docType: 'OC', id, action, actor, remark, source, expectFrom, set })
      if (before.credit_hold > 0) {
        writeCredit(db, {
          customerId: before.customer_id, orderId: id, docNo: before.doc_no,
          changeType: 'release', amount: -before.credit_hold,
          operator: actor?.name || null, remark: `取消订货释放（${before.doc_no}）`
        })
        db.prepare('UPDATE oc_orders SET credit_hold=0 WHERE id=?').run(id)
      }
      return r
    })
    return tx()
  }

  if (action === 'allocate') {
    const pick = warehouseId
      ? { warehouseId, name: db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouseId)?.name, fillRate: null }
      : pickWarehouse(db, {
          customerId: before.customer_id,
          quote: { lines: before.items.map((i) => ({ sku_id: i.sku_id, qty: i.qty })) }
        })
    if (!pick) throw new OrderCenterError('没有可用发货仓', { code: 'NO_WAREHOUSE', httpStatus: 409 })
    set.ship_warehouse_id = pick.warehouseId
    set.ship_warehouse = pick.name
    set.allocate_note = pick.fillRate != null
      ? `满足率 ${(pick.fillRate * 100).toFixed(0)}%，${pick.fullLines}/${pick.lineCount} 行足量`
      : '人工指定发货仓'
    return applyTransition({ db, docType: 'OC', id, action, actor, remark, source, expectFrom, set })
  }

  if (action === 'receive') {
    // 收货**不释放**授信：货发了、钱没回，额度仍应被占住。
    // 曾经在这里写了一条 settle 释放，结果「收货释放一次 + 回款再释放一次」=
    // 同一笔钱放两次额度（台账 459k vs 在途占用 530k，差 71k 就是被重复释放的部分）。
    // 授信只有一个口径：**额度 = 未回款金额的上限**。
    //
    // 但收货是「收款权成立」的那一刻 —— 从这一刻起这笔钱就是应收了，
    // 所以并入应收（模块 21）放在这里，而不是发货或审批时。
    const tx = db.transaction(() => {
      const r = applyTransition({ db, docType: 'OC', id, action, actor, remark, source, expectFrom, set })
      maybeEnsureArOnReceive(db, id, actor)
      return r
    })
    return tx()
  }

  // approve 时若审批链还有 pending 节点，按序推进一个节点；全部通过才真正 approved
  if (action === 'approve' && before.need_approval) {
    const pending = before.approvals.filter((a) => a.decision === 'pending')
    if (pending.length > 1) {
      const tx = db.transaction(() => {
        db.prepare(
          `UPDATE oc_order_approvals SET decision='approved', approver_id=?, approver_name=?, decided_at=? WHERE id=?`
        ).run(actor?.id ?? null, actor?.name || null, nowStr(), pending[0].id)
        const nextNode = pending[1].node
        // 第一次审批时把单据推进到「审批中」——状态要能反映「卡在谁那里」，
        // 否则多级审批的单会一直显示「已提交」，看不出在走流程
        if (before.status === 'submitted') {
          applyTransition({
            db, docType: 'OC', id, action: 'review', actor, source,
            remark: `进入审批：${pending[0].node} → ${nextNode}`
          })
        } else {
          db.prepare(
            `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,org_id,created_at)
             VALUES ('OC',?,?,'approve_node','审批推进',?,?,?,?,?,?,?,datetime('now','localtime'))`
          ).run(id, before.doc_no, before.status, before.status, actor?.id ?? null, actor?.name || null, source,
            `节点「${pending[0].node}」通过，下一节点「${nextNode}」`, before.org_id)
        }
        return { ...getOrder(db, id), partial: true, doneNode: pending[0].node, nextNode }
      })
      return tx()
    }
    // 最后一个节点 → 真正 approved
    const tx = db.transaction(() => {
      if (pending.length === 1) {
        db.prepare(
          `UPDATE oc_order_approvals SET decision='approved', approver_id=?, approver_name=?, decided_at=? WHERE id=?`
        ).run(actor?.id ?? null, actor?.name || null, nowStr(), pending[0].id)
      }
      return applyTransition({
        db, docType: 'OC', id, action, actor, remark, source,
        expectFrom: before.status,
        set: { ...set, approver_id: actor?.id ?? null, approver_name: actor?.name || null, approved_at: nowStr() }
      })
    })
    return tx()
  }

  if (action === 'reject') {
    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE oc_order_approvals SET decision='rejected', approver_id=?, approver_name=?, reason=?, decided_at=?
         WHERE order_id=? AND decision='pending'`
      ).run(actor?.id ?? null, actor?.name || null, remark, nowStr(), id)
      const r = applyTransition({ db, docType: 'OC', id, action, actor, remark, source, expectFrom, set })
      if (before.credit_hold > 0) {
        writeCredit(db, {
          customerId: before.customer_id, orderId: id, docNo: before.doc_no,
          changeType: 'release', amount: -before.credit_hold,
          operator: actor?.name || null, remark: `驳回释放（${before.doc_no}）`
        })
        db.prepare('UPDATE oc_orders SET credit_hold=0 WHERE id=?').run(id)
      }
      return r
    })
    return tx()
  }

  return applyTransition({ db, docType: 'OC', id, action, actor, remark, source, expectFrom, set })
}

// ---------------------------------------------------------------------------
// 十、对账
// ---------------------------------------------------------------------------

export function buildStatement(db, { customerId, periodStart, periodEnd, actor = null, remark = null }) {
  const cust = getCustomer(db, customerId)
  const orders = db
    .prepare(
      `SELECT id, doc_no, order_date, total_amount, status FROM oc_orders
       WHERE customer_id=? AND order_date >= ? AND order_date <= ?
         AND status IN ('received','completed')
       ORDER BY order_date, id`
    )
    .all(customerId, periodStart, periodEnd)
  if (!orders.length) {
    throw new OrderCenterError('该周期内没有可对账的订货单（需已收货/已完成）', {
      code: 'NO_BILLABLE_ORDER', httpStatus: 409
    })
  }
  const total = Number(orders.reduce((a, o) => a + Number(o.total_amount || 0), 0).toFixed(2))
  const docNo = nextStatementNo(db, periodEnd)

  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO oc_statements
          (doc_no,customer_id,customer_name,period_start,period_end,currency,order_count,total_amount,paid_amount,diff_amount,status,remark,created_at)
         VALUES (?,?,?,?,?,?,?,?,0,?, 'draft', ?, datetime('now','localtime'))`
      )
      .run(docNo, cust.id, cust.name, periodStart, periodEnd, cust.currency, orders.length, total, total, remark)
    const sid = Number(info.lastInsertRowid)
    const ins = db.prepare(
      `INSERT INTO oc_statement_items (statement_id,order_id,doc_no,order_date,amount,paid_amount,diff_amount) VALUES (?,?,?,?,?,0,?)`
    )
    for (const o of orders) ins.run(sid, o.id, o.doc_no, o.order_date, o.total_amount, o.total_amount)
    db.prepare(
      `INSERT INTO doc_events (doc_type,doc_id,doc_no,action,action_name,from_state,to_state,actor_id,actor_name,source,remark,org_id,created_at)
       VALUES ('OCS',?,?,'create','生成对账单',NULL,'draft',?,?,?,?,?,datetime('now','localtime'))`
    ).run(sid, docNo, actor?.id ?? null, actor?.name || null, 'api', `周期 ${periodStart} ~ ${periodEnd}`, cust.owner_org_id)
    return sid
  })
  const id = tx()
  return getStatement(db, id)
}

function nextStatementNo(db, periodEnd) {
  const prefix = `OCS${String(periodEnd).replace(/-/g, '')}`
  const n = db.prepare('SELECT COUNT(*) c FROM oc_statements WHERE doc_no LIKE ?').get(`${prefix}%`).c + 1
  return `${prefix}${String(n).padStart(3, '0')}`
}

export function getStatement(db, id) {
  const s = db.prepare('SELECT * FROM oc_statements WHERE id=?').get(id)
  if (!s) throw new OrderCenterError(`对账单 #${id} 不存在`, { code: 'STATEMENT_NOT_FOUND', httpStatus: 404 })
  s.items = db.prepare('SELECT * FROM oc_statement_items WHERE statement_id=? ORDER BY order_date, id').all(id)
  s.actions = allowedActions(db, 'OCS', s.status).map((a) => ({ action: a.action, name: a.actionName, to: a.to }))
  return s
}

/**
 * 回款核销。
 * 回款释放的额度必须**同时**从单据上落下去 —— 否则台账少了、单据还占着，
 * 两边过一段时间就对不上（这类账是「演示看不出来、上线必出事」的典型）。
 * 所以这里按 FIFO 把回款分摊到该客户的未回款单据上，逐单减少 credit_hold。
 */
export function settleStatement(db, { id, amount, actor = null, remark = null }) {
  const s = getStatement(db, id)
  if (s.status === 'draft') {
    throw new OrderCenterError('对账单尚未确认，不能登记回款', { code: 'STATEMENT_NOT_CONFIRMED', httpStatus: 409 })
  }
  // 终态守卫：**已结清 / 已作废的对账单不能再登记回款**。
  //
  // 为什么必须在这里拦（而不是靠末尾那条自动结清自然撞墙）：
  //   没有这个守卫时，对一张已结清的对账单登记回款会一路走到末尾的
  //   `if (diff <= 0.001) applyTransition('close')`，然后撞上内核"终态无出边"，
  //   抛出「状态「已结清」已是终态，不能继续流转」——
  //   那是**状态机的话，不是业务的话**：用户正在做的事是"登记回款"，
  //   "不能继续流转"对他没有任何指向（该作废？该重开？该找谁？一句都没答）。
  //   功能上 fail-closed 本来是对的（事务回滚、`paid` 未被改动），
  //   但报障时方向会被带偏 —— 这正是本项目一直在打的"错误信息要指路"。
  //
  // 错误码**沿用 `TRANSITION_NOT_ALLOWED`**、不新造码：前端与既有测试都按这个码读，
  // 新造一个只会多一处"同一件事两个码"。
  if (s.status === 'closed' || s.status === 'voided') {
    const closed = s.status === 'closed'
    throw new OrderCenterError(
      closed
        ? '该对账单已结清（closed），不能再登记回款；如需补登记请先作废该对账单'
        : '该对账单已作废（voided），不能再登记回款；如需补登记请重开一张对账单',
      { code: 'TRANSITION_NOT_ALLOWED', httpStatus: 409, detail: { docType: 'OCS', id: s.id, status: s.status } }
    )
  }
  const pay = Number(amount)
  if (!(pay > 0)) throw new OrderCenterError('回款金额必须大于 0', { code: 'BAD_AMOUNT' })

  const tx = db.transaction(() => {
    // 1. 对账单行：把回款按行分摊（对账粒度）
    let left = pay
    for (const it of s.items) {
      if (left <= 0) break
      const need = Number(it.diff_amount || 0)
      if (need <= 0) continue
      const put = Math.min(left, need)
      db.prepare('UPDATE oc_statement_items SET paid_amount=paid_amount+?, diff_amount=diff_amount-? WHERE id=?')
        .run(put, put, it.id)
      left = Number((left - put).toFixed(2))
    }
    const paid = Number((Number(s.paid_amount) + pay).toFixed(2))
    const diff = Number((Number(s.total_amount) - paid).toFixed(2))
    db.prepare('UPDATE oc_statements SET paid_amount=?, diff_amount=? WHERE id=?').run(paid, diff, id)

    // 2. 授信台账：回款释放
    //    只有**账期客户**的回款才与授信有关。现结/内部往来客户本就未占用额度，
    //    给他们记一条负数「释放」会让台账出现凭空的负余额（曾出现 -876 的溢缴挂账）。
    //    账期客户还要**封顶到实际占用**：回款超过未回款占用时，多出的部分是溢缴。
    //    溢缴是**资金账**，不是**额度占用账** —— 把它写进「已用额度」会让
    //    SUM(台账) 变负，与 SUM(单据 credit_hold) 当场对不上（`账实仍一致`那条
    //    不变量立刻破掉），而 credit_hold 又只能减到 0，两边再也不可能自己合上。
    //    所以：只释放「实际占着的那部分」，多出来的留在对账单上作为已收金额。
    const cust = getCustomer(db, s.customer_id)
    const usesCredit = cust.settle_type === 'credit'
    const usedBefore = usesCredit ? Math.max(0, Number(ocCreditUsed(db, s.customer_id) || 0)) : 0
    const release = Number(Math.min(pay, usedBefore).toFixed(2))
    if (release > 0) {
      writeCredit(db, {
        customerId: s.customer_id, orderId: null, docNo: s.doc_no,
        changeType: 'repay', amount: -release, operator: actor?.name || null,
        remark: `回款核销（${s.doc_no}）`
      })
    }

    // 3. 单据侧同步：FIFO 把**已释放的额度**摊到未回款单上，逐单减少占用。
    //    这里必须用 release 而不是 pay —— 用 pay 会让「台账少了一笔、单据侧多减一笔」，
    //    两边从这一笔起就开始漂移。
    let quota = release
    const openOrders = db
      .prepare(
        `SELECT id, doc_no, credit_hold FROM oc_orders
         WHERE customer_id=? AND credit_hold > 0 AND status IN ('received','completed','shipped','allocated','approved')
         ORDER BY order_date, id`
      )
      .all(s.customer_id)
    for (const o of openOrders) {
      if (quota <= 0) break
      const hold = Number(o.credit_hold || 0)
      const cut = Math.min(quota, hold)
      db.prepare('UPDATE oc_orders SET credit_hold=credit_hold-? WHERE id=?').run(cut, o.id)
      quota = Number((quota - cut).toFixed(2))
    }
    // 超出未回款占用的部分 = 预收/溢缴：留在对账单的已收金额里，**不进额度台账**

    if (diff <= 0.001) {
      applyTransition({ db, docType: 'OCS', id, action: 'close', actor, remark: remark || '货款已结清', source: 'api' })
    }
    return getStatement(db, id)
  })
  return tx()
}

export function confirmStatement(db, { id, actor = null, remark = null }) {
  return applyTransition({ db, docType: 'OCS', id, action: 'confirm', actor, remark, source: 'api' })
}

// ---------------------------------------------------------------------------
// 十之二、对账单的两个终局动作：结清 / 作废
// ---------------------------------------------------------------------------
// 这两个动作**只动对账单这一张凭证** —— `oc_orders` / `oc_credit_ledger` /
// `oc_statement_items` 分毫不动。
//   ⚠️ 这句话是刻意写死的：下一维护者很容易把"作废对账单"读成"整条债权作废"。
//   债权由订货单承载（`oc_orders` + 授信台账），对账单只是「某一期间双方确认过的
//   账目快照」——它是**结论的载体**，不是**债权的载体**。客户不认这份对账单，
//   不等于客户不用还钱。真要"这笔钱不要了"是坏账核销，是另一个域的事。
//
// 与经销商对账单（`lib/dealer-statement.js`）的关系：**同一套口径的两个载体**。
// 差别只有"余额怎么算"（这里用 OC 自己的 `total − paid`，那里用 DS 的
// `期初 + 本期销售 − 退货 − 回款`），其余（结清判据的形状、force 通道、
// 理由必填、留痕方式）刻意保持一致 —— 不一致会让客户看到
// "经销商对账单确认过也能作废、订货对账单确认过就不能"这类同业务两语义。

/** OC 的结清容差：与 `settleStatement` 里那条自动结清（`if (diff <= 0.001)`）**同源**。
 *  改这里就必须改那里，否则"回款自动结清"与"手动结清"会给出不同结论。 */
export const OC_SETTLE_TOLERANCE = 0.001

/** 手动结清 / 作废时的理由最短长度（去空白后），与 DS 侧一致。 */
export const OC_MIN_REASON = 5

/**
 * 对账单余额（**OC 自己的口径**）。
 *
 * 两个口径细节，都不是随手定的：
 *   ① **从明细重算**，不读 `oc_statements.paid_amount / diff_amount` 的存值 ——
 *      与 `lib/ar.js` 的"已收金额永远由明细 SUM 算出，不累加"是同一条铁律：
 *      明细是唯一真相。存值只作为对照返回（`stored_diff_amount`），便于对账时看清差异。
 *   ② **判据是 `diff <= 容差`，不是 `|diff| <= 容差`** —— 与 `settleStatement` 的
 *      `if (diff <= 0.001)` 一字不差地一致。溢缴（paid > total，diff 为负）意味着
 *      "钱确实收够了、多出的部分是对账方的预存"，本就该算结清；
 *      写成绝对值会把溢缴单挡在结清之外，与回款时的自动结清自相矛盾。
 *
 * @returns {{total_amount:number,paid_amount:number,diff_amount:number,stored_diff_amount:number,item_count:number}}
 */
export function statementBalance(db, id) {
  const s = db.prepare('SELECT * FROM oc_statements WHERE id=?').get(Number(id))
  if (!s) throw new OrderCenterError(`对账单 #${id} 不存在`, { code: 'STATEMENT_NOT_FOUND', httpStatus: 404 })
  const agg = db
    .prepare(
      `SELECT COUNT(*) n, COALESCE(SUM(amount),0) total, COALESCE(SUM(paid_amount),0) paid
       FROM oc_statement_items WHERE statement_id=?`
    )
    .get(s.id)
  const round2 = (n) => Number((Number(n) || 0).toFixed(2))
  const total = round2(agg.total)
  const paid = round2(agg.paid)
  return {
    total_amount: total,
    paid_amount: paid,
    diff_amount: round2(total - paid),
    stored_diff_amount: round2(s.diff_amount),
    item_count: agg.n
  }
}

/**
 * 结清对账单。
 *
 * 判据（**OC 自己的口径**，见 `statementBalance`）：`未被收差额 = Σ明细金额 − Σ明细已收`，
 * `diff <= 0.001` 视为收齐（容差与 `settleStatement` 的自动结清同源）。
 *
 * "账没收齐也能标已结清"这条路的**唯一出口** = 显式 `force=true` **且** `reason` ≥ 5 字；
 * 理由落在单据列 `close_reason`（跟单走，不只是事件流的 remark），
 * 留痕 remark 前缀 `[手动结清]`，使其在事件流里一眼可辨。
 */
export function closeStatement(db, { id, actor = null, reason = null, force = false }) {
  const s = db.prepare('SELECT * FROM oc_statements WHERE id=?').get(Number(id))
  if (!s) throw new OrderCenterError(`对账单 #${id} 不存在`, { code: 'STATEMENT_NOT_FOUND', httpStatus: 404 })
  const bal = statementBalance(db, s.id)
  const settled = bal.diff_amount <= OC_SETTLE_TOLERANCE
  const why = String(reason || '').trim()
  const forced = !!force && !settled

  if (!settled && !force) {
    throw new OrderCenterError(
      `未收差额 ¥${bal.diff_amount.toFixed(2)} 未结清，不能结清（明细合计 ¥${bal.total_amount.toFixed(2)} − 已收 ¥${bal.paid_amount.toFixed(2)}）。` +
        `如需业务判断手动结清，请传 force=true 并写明理由`,
      { code: 'STATEMENT_NOT_SETTLED', httpStatus: 409, detail: { ...bal, tolerance: OC_SETTLE_TOLERANCE } }
    )
  }
  if (forced && why.length < OC_MIN_REASON) {
    throw new OrderCenterError(
      `手动结清必须写明理由（不少于 ${OC_MIN_REASON} 个字）：该对账单未收差额 ¥${bal.diff_amount.toFixed(2)}`,
      { code: 'REASON_REQUIRED', httpStatus: 400, detail: { diff_amount: bal.diff_amount, min_reason: OC_MIN_REASON } }
    )
  }

  // 状态与留痕走内核（`close` 边：confirmed → closed），终局列通过 `set` 在同一次
  // UPDATE 里落库 —— 不会出现"状态是已结清、但没有结清时间/人"。
  applyTransition({
    db,
    docType: 'OCS',
    id: s.id,
    action: 'close',
    actor,
    remark: forced ? `[手动结清] ${why}` : why || `未收差额 ¥${bal.diff_amount.toFixed(2)}，已收齐`,
    set: {
      closed_at: localNow(),
      closed_by: actor?.name || null, // 与 `confirmed_by TEXT` 同形
      close_reason: why || (settled ? `自动结清：未收差额 ¥${bal.diff_amount.toFixed(2)}` : null)
    }
  })
  return getStatement(db, s.id)
}

/**
 * 作废对账单。**只作废这份对账单凭证**，不动底层台账（见本节开头）。
 *
 * 理由必填：作废让一份"双方确认过的账"从系统里消失，事后必须答得出是谁、为什么
 * （内核对 `void` 边标了 `is_danger=1`）。
 */
export function voidStatement(db, { id, actor = null, reason = null }) {
  const s = db.prepare('SELECT * FROM oc_statements WHERE id=?').get(Number(id))
  if (!s) throw new OrderCenterError(`对账单 #${id} 不存在`, { code: 'STATEMENT_NOT_FOUND', httpStatus: 404 })
  const why = String(reason || '').trim()
  if (why.length < OC_MIN_REASON) {
    throw new OrderCenterError(`作废对账单必须写明理由（不少于 ${OC_MIN_REASON} 个字）`, {
      code: 'REASON_REQUIRED',
      httpStatus: 400,
      detail: { min_reason: OC_MIN_REASON }
    })
  }
  applyTransition({
    db,
    docType: 'OCS',
    id: s.id,
    action: 'void',
    actor,
    remark: why,
    set: {
      voided_at: localNow(),
      voided_by: actor?.name || null, // 与 `confirmed_by TEXT` 同形
      void_reason: why
    }
  })
  return getStatement(db, s.id)
}

// ---------------------------------------------------------------------------
// 十一、看板
// ---------------------------------------------------------------------------

export function overview(db, { customerIds = null } = {}) {
  const args = customerIds || []
  const scopeClause = (column, prefix = 'WHERE') => customerIds === null ? ''
    : `${prefix} ${args.length ? `${column} IN (${args.map(() => '?').join(',')})` : '1=0'}`
  const cond = scopeClause('customer_id')

  const byStatus = db
    .prepare(`SELECT status, COUNT(*) c, ROUND(SUM(total_amount),2) amt FROM oc_orders ${cond} GROUP BY status ORDER BY c DESC`)
    .all(...args)

  const totals = db
    .prepare(
      `SELECT COUNT(*) orders, ROUND(COALESCE(SUM(total_amount),0),2) amount
       FROM oc_orders ${cond ? cond + ' AND' : 'WHERE'} status NOT IN ('cancelled','rejected')`
    )
    .get(...args)

  const customers = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN admit_status='active' THEN 1 ELSE 0 END) active,
              SUM(CASE WHEN admit_status='pending' THEN 1 ELSE 0 END) pending,
              SUM(CASE WHEN admit_status='frozen' THEN 1 ELSE 0 END) frozen
       FROM oc_customers ${scopeClause('id')}`
    )
    .get(...args)

  const blockUsers = db
    .prepare(
      `SELECT id, code, name, channel, level, admit_status FROM oc_customers
       WHERE admit_status<>'active' ${scopeClause('id', 'AND')} ORDER BY id LIMIT 20`
    )
    .all(...args)

  // 授信风险榜：占用率高的前 10 个客户
  const creditRisk = db
    .prepare(
      `SELECT c.id, c.code, c.name, c.level,
              COALESCE(c.credit_limit, d.credit_limit, 0) AS limit_amount,
              COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0) AS used
       FROM oc_customers c LEFT JOIN dealers d ON d.id=c.source_id AND c.source_type='dealer'
       WHERE c.settle_type<>'prepay' ${scopeClause('c.id', 'AND')}
       ORDER BY (CASE WHEN COALESCE(c.credit_limit,d.credit_limit,0)>0
                      THEN COALESCE((SELECT SUM(amount) FROM oc_credit_ledger l WHERE l.customer_id=c.id),0)
                           / COALESCE(c.credit_limit,d.credit_limit,1)
                      ELSE 0 END) DESC
       LIMIT 10`
    )
    .all(...args)
    .map((r) => ({
      ...r,
      utilization: r.limit_amount > 0 ? Number((Number(r.used) / Number(r.limit_amount)).toFixed(4)) : 0
    }))

  const pendingApproval = db
    .prepare(
      `SELECT o.id, o.doc_no, o.customer_name, o.total_amount, o.approval_reason, o.order_date
       FROM oc_orders o WHERE o.need_approval=1 AND o.status IN ('submitted','approving') ${scopeClause('o.customer_id', 'AND')}
       ORDER BY o.id DESC LIMIT 20`
    )
    .all(...args)

  const flow = db.prepare('SELECT * FROM biz_flows WHERE code=?').get('FLOW_ORDER_CENTER')
  const steps = flow
    ? db.prepare('SELECT * FROM biz_flow_steps WHERE flow_code=? ORDER BY seq').all('FLOW_ORDER_CENTER')
    : []

  return {
    totals: { ...totals, byStatus },
    customers,
    blockedCustomers: blockUsers,
    creditRisk,
    pendingApproval,
    flow: flow ? { ...flow, steps } : null,
    types: db.prepare("SELECT code,name FROM doc_types WHERE module='order-center' ORDER BY sort_order").all(),
    generatedAt: nowStr()
  }
}

/**
 * 订货方自身绑定：经销商账号只能看到自己的单，门店店长只能看到本店的单。
 * 返回 customerId，null 表示不限（总部角色）。
 *
 * **放在 lib 而不是路由**：这条判据有两个调用方（列表 scopeCond 与流转入口的越权检查），
 * 放在路由里就只有路由能用，另一个调用方必然再写一遍 —— 那就又变成"同一份判据两个实现"。
 */
export function selfCustomerId(db, user = {}) {
  if (user.role === 'dealer' && user.dealer_id) {
    return ensureCustomer(db, { sourceType: 'dealer', sourceId: user.dealer_id }).id
  }
  if (user.role === 'store' && user.store_id) {
    return ensureCustomer(db, { sourceType: 'store', sourceId: user.store_id }).id
  }
  if (user.role === 'dealer' || user.role === 'store') {
    throw new OrderCenterError('当前账号未绑定订货主体', { code: 'SUBJECT_BINDING_REQUIRED', httpStatus: 403 })
  }
  return null
}

/**
 * 单据级越权判定（订货中心域自己的口径）。
 * 与列表 `scopeCond` 同一份规则：订货方按 customer_id，内部按 org 范围。
 * @returns {{ok:boolean, status?:number, message?:string}}
 */
export function ocAccessCheck(db, req, row) {
  const u = (req && req.user) || {}
  const self = selfCustomerId(db, u)
  if (self) {
    if (Number(row.customer_id) !== Number(self)) {
      return { ok: false, status: 403, message: '无权操作其他订货方的单据' }
    }
    return { ok: true }
  }
  const s = (req && req.orgScope) || { scope: 'all', orgIds: null }
  if (s.scope === 'all') return { ok: true }
  if (s.scope === 'none' || !s.orgIds || !s.orgIds.length) {
    return { ok: false, status: 403, message: '当前身份没有该单据的数据范围' }
  }
  if (row.org_id == null || s.orgIds.includes(row.org_id)) return { ok: true }
  return { ok: false, status: 403, message: '无权操作其他组织的单据' }
}

// 流转效果归属登记（027 / A01）：订货单的流转占/放授信、分仓、收货并应收，
// 通用流转入口必须走这一段，而不是只改 status。
// canAccess 一并登记 —— **"能不能动这张单"也属于这个域的知识**，
// 通用入口不该自己另写一套（订货方看 customer_id、内部看 org_id，这套口径只在这里）。
claimTransitionEffect(
  'OC',
  (db, p) =>
    transitionOrder(db, {
      id: p.id, action: p.action, actor: p.actor, remark: p.remark, source: p.source,
      expectFrom: p.expectFrom, extraSet: p.set
    }),
  { entry: 'POST /api/order-center/orders/:id/:action', canAccess: ocAccessCheck }
)

export default {
  OrderCenterError,
  ensureCustomer, getCustomer, customerTree, creditSnapshot, writeCredit,
  selfCustomerId, ocAccessCheck,
  visibleSkus, availableQty, quoteItems, checkOrder, decideApproval,
  customerWarehouseIds, pickWarehouse, createOrder, getOrder, transitionOrder,
  buildStatement, getStatement, settleStatement, confirmStatement,
  statementBalance, closeStatement, voidStatement, overview
}
