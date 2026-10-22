/**
 * ============================================================================
 * 文件标识：server/db/oc-seed.js ｜ 订货中心演示数据（模块 12A）
 * ============================================================================
 * 【职责】订货中心演示数据（模块 12A）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 订货中心演示数据（模块 12A）
//
// 为什么不放在 seed.js 里：订货中心的客户来自 stores/dealers，而 seed.js 会 DROP 这两张表；
// 放进去会让「谁先谁后」变成隐式依赖。独立脚本在 seedAll + seedOrgs 之后跑，顺序是显式的。
//
// 幂等：每次先清空 oc_* 再重建（重建 = 结构不动，行重灌）。

import { requireDemoDatabase } from './runtime-policy.js'
import { ensureCustomer, createOrder, transitionOrder, buildStatement, settleStatement, confirmStatement, creditSnapshot, quoteItems } from '../lib/order-center.js'
import { resolvePrice } from '../lib/pricing.js'
import { pruneOrphanEvents } from '../lib/docflow.js'
// 「可售商品」的判据（排除原料/包材 + 必须有零售价）只在一处实现
import { SELLABLE_JOIN, SELLABLE_COND } from '../lib/catalog.js'
import { seedNow } from './seed-clock.js'
import { resetSequences } from './seq.js'

const ymd = (d) => new Date(d).toISOString().slice(0, 10)
const dayAgo = (n) => ymd(new Date(seedNow().getTime() - n * 86400000))
const pick = (arr, i) => arr[i % arr.length]

// 每个行业一套口径：客户数、审批阈值、可见性规则都不一样，写死会让别的行业灌出无意义数据
//
// downstream 不写经销商编码 —— 三个行业的主数据编码规则不同，写死会让某个行业
// 一个下游都建不出来（美妆的经销商不叫 DL001）。改为「挂到排序最前的 N 个经销商下」，
// 只声明数量，编码由经销商自己的 code 派生，行业无关。
const PROFILES = {
  food: {
    label: '连锁餐饮版',
    downstream: { count: 5, spreadOver: 3 },
    // 审批规则：金额分级 + 超授信特批 + 缺货交期确认（对应「审批是有条件的」这条硬设计点）
    approval: [
      ['AP-AMT-5W', '订货金额超 5 万', 'global', null, null, 'amount', '>', 50000, 1, '区域经理审批', 'sales', 10],
      ['AP-AMT-20W', '订货金额超 20 万', 'global', null, null, 'amount', '>', 200000, 2, '销售总监审批', 'boss', 20],
      ['AP-CREDIT', '超授信额度特批', 'global', null, null, 'credit_over', '>', 0, 0, '财务授信特批', 'finance', 5],
      ['AP-SHORT', '存在缺货行', 'global', null, null, 'short_lines', '>', 0, 3, '缺货交期确认', 'sales', 60],
      ['AP-FR-3W', '加盟店金额超 3 万', 'channel', 'franchise', null, 'amount', '>', 30000, 1, '加盟业务主管审批', 'sales', 8]
    ],
    // 可见性：加盟店只能订本品牌商品（隐藏团圆楼 = 宴席大牌，非加盟业态）
    visibilityByBrand: { channel: 'franchise', brandName: '团圆楼', allowed: 0, remark: '加盟店仅可订本品牌商品' },
    visibilityByCategory: { scope: 'level', value: 'bronze', categoryName: '央厨半成品', allowed: 0, remark: '铜牌客户不开放央厨半成品直供' }
  },
  cosmetic: {
    label: '美妆连锁版',
    downstream: { count: 2, spreadOver: 2 },
    approval: [
      ['AP-AMT-3W', '订货金额超 3 万', 'global', null, null, 'amount', '>', 30000, 1, '区域经理审批', 'sales', 10],
      ['AP-CREDIT', '超授信额度特批', 'global', null, null, 'credit_over', '>', 0, 0, '财务授信特批', 'finance', 5]
    ],
    visibilityByBrand: null,
    visibilityByCategory: null
  },
  apparel: {
    label: '服装行业',
    downstream: { count: 1, spreadOver: 1 },
    approval: [
      ['AP-AMT-3W', '订货金额超 3 万', 'global', null, null, 'amount', '>', 30000, 1, '区域经理审批', 'sales', 10],
      ['AP-CREDIT', '超授信额度特批', 'global', null, null, 'credit_over', '>', 0, 0, '财务授信特批', 'finance', 5]
    ],
    visibilityByBrand: null,
    visibilityByCategory: null
  }
}

function clear(db) {
  // 先子后父；oc_orders 下有 ON DELETE CASCADE，但显式删更清楚
  const tables = [
    'oc_statement_items', 'oc_statements', 'oc_credit_ledger', 'oc_order_approvals',
    'oc_order_items', 'oc_orders', 'oc_approval_rules', 'oc_visibility_rules',
    'oc_addresses', 'oc_customers'
  ]
  for (const t of tables) {
    try { db.prepare(`DELETE FROM ${t}`).run() } catch { /* 表可能尚未建 */ }
  }
  // DELETE 不重置自增序列，id 会一轮一轮往上长（11462 → 11507 → …）。id 被抄进
  // ar_documents.subject_id / doc_events.doc_id，整库因此不可复现。清表后一并重置。
  resetSequences(db, tables)
  // 主表被整体清空，它的流转留痕必须跟着走：doc_events 是跨表的旁支表，
  // 行按 (doc_type, doc_id) 指向 oc_orders / oc_statements，而两张表的自增 id 会被**复用** ——
  // 留着旧留痕，重建出来的新单会「继承」上一张单的历史（时间线里凭空多出别人的流转）。
  //
  // 这一步不能省：clear() 是**每次服务启动**都会跑的（本 seed 幂等的方式就是整表重灌），
  // 每启动一次就漏一批。实测三库曾累计 2 万+ 条订货中心孤儿留痕，就是一次次启动攒出来的。
  pruneOrphanEvents(db)
}

export function seedOrderCenter(db, { industry = 'food', silent = false, log } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) (log ? log(m) : console.log(m)) }
  const cfg = PROFILES[industry] || PROFILES.food
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='oc_customers'")
    .get()
  if (!tables) {
    say('[oc] 订货中心表不存在，跳过（先跑迁移）')
    return { skipped: true }
  }

  clear(db)
  const stat = { customers: 0, downstream: 0, orders: 0, approvals: 0, statements: 0, creditRows: 0 }

  // ---------- 1. 订货主体：门店 + 经销商 ----------
  const storeRows = db.prepare('SELECT * FROM stores ORDER BY id').all()
  const dealerRows = db.prepare('SELECT * FROM dealers ORDER BY id').all()
  const storeCust = storeRows.map((s) => {
    const c = ensureCustomer(db, { sourceType: 'store', sourceId: s.id })
    stat.customers += 1
    return c
  })
  const dealerCust = dealerRows.map((d) => {
    const c = ensureCustomer(db, { sourceType: 'dealer', sourceId: d.id })
    stat.customers += 1
    return c
  })

  // ---------- 2. 多级渠道：经销商的下游终端门店 ----------
  // 品牌方 → 经销商 → 终端门店，演示只展开两级（第三轮 B5：经销商两级都可开户）。
  // 下游不是我方主数据（它属于经销商的客户），因此只在订货中心建档，
  // source_type='downstream'、source_id 用负数合成，一眼能看出不是主数据 id。
  const dnCfg = cfg.downstream || { count: 0, spreadOver: 1 }
  const dnParents = dealerCust.slice(0, Math.max(1, dnCfg.spreadOver))
  for (let i = 0; i < dnCfg.count; i += 1) {
    const parent = dnParents[i % dnParents.length]
    if (!parent) break
    const raw = dealerRows.find((d) => d.id === parent.source_id)
    const seq2 = String(i + 1).padStart(2, '0')
    ensureCustomer(db, {
      sourceType: 'downstream',
      parentCustomerId: parent.id,
      profile: {
        code: `DS_${raw?.code || parent.code}_${seq2}`,
        name: `${raw?.name || parent.name}·终端${seq2}`,
        region: parent.region,
        city: parent.city,
        level: 'bronze',
        channel: 'sub_dealer',
        settle_type: 'prepay',
        credit_limit: 0,
        credit_days: 0
      }
    })
    stat.downstream += 1
    stat.customers += 1
  }

  // ---------- 3. 审批规则 ----------
  const insRule = db.prepare(
    `INSERT INTO oc_approval_rules
      (code,name,scope,channel,customer_id,cond_field,cond_op,cond_value,seq,node,approver_role,priority,status,remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'active',?)`
  )
  for (const r of cfg.approval) {
    insRule.run(r[0], r[1], r[2], r[3] ?? null, r[4] ?? null, r[5], r[6], r[7], r[8], r[9], r[10], r[11],
      `演示规则：${r[1]}`)
  }

  // ---------- 4. 可见性规则 ----------
  const insVis = db.prepare(
    'INSERT INTO oc_visibility_rules (scope,scope_value,category_id,brand_id,allowed,priority,remark) VALUES (?,?,?,?,?,?,?)'
  )
  if (cfg.visibilityByBrand) {
    const b = db.prepare('SELECT id FROM brands WHERE name=?').get(cfg.visibilityByBrand.brandName)
    if (b) {
      insVis.run('channel', cfg.visibilityByBrand.channel, null, b.id, cfg.visibilityByBrand.allowed, 20, cfg.visibilityByBrand.remark)
    }
  }
  if (cfg.visibilityByCategory) {
    const c = db.prepare('SELECT id FROM categories WHERE name=?').get(cfg.visibilityByCategory.categoryName)
    if (c) {
      insVis.run(cfg.visibilityByCategory.scope, cfg.visibilityByCategory.value, c.id, null, cfg.visibilityByCategory.allowed, 30, cfg.visibilityByCategory.remark)
    }
  }

  // ---------- 5. 历史订货单（覆盖各个状态，让看板与列表不是空的） ----------
  const allCustomers = db.prepare('SELECT * FROM oc_customers ORDER BY id').all()
  const candidateSkus = db
    .prepare(
      `SELECT s.id, s.price_retail FROM product_skus s
       ${SELLABLE_JOIN}
       WHERE p.status='active' AND ${SELLABLE_COND} ORDER BY s.id`
    )
    .all()
  if (!candidateSkus.length) {
    say('[oc] 没有可用 SKU，跳过订货单生成')
    return { ...stat, customers: stat.customers, orders: 0 }
  }

  const actor = { id: null, name: '演示数据' }
  // 只给「能订货且授信充足」的客户造单：直营店与经销商。
  // 下游终端门店是现结客户，走小额单演示「在线即付」路径。
  const orderable = [
    ...storeCust.filter((c) => c.channel === 'direct'),
    ...dealerCust,
    ...allCustomers.filter((c) => c.source_type === 'downstream')
  ]

  let seq = 0
  const skipped = []
  for (const cust of orderable) {
    // 订货量按**目标金额**倒推，不按固定件数 ——
    // 三个行业的商品单价差一个量级（餐饮均价 39、美妆数百），
    // 写死件数会让某个行业算出 130 万的单，把授信一次性打满，演示直接失真。
    const target =
      cust.source_type === 'dealer'
        ? (seq % 5 === 0 ? [180000, 40000, 240000] : [30000, 12000, 70000])
        : cust.source_type === 'downstream'
        ? [800, 300, 1500]
        : cust.channel === 'franchise'
        ? [6000, 3000, 35000]
        : [1200, 500, 4000]
    const lineCount = 2 + (seq % 3) // 2~4 行
    const lo = target[1]
    const hi = target[2]
    const totalTarget = lo + ((seq * 137) % Math.max(1, hi - lo))

    const dims = {
      channel: cust.channel,
      storeType: cust.source_type === 'store' ? (cust.channel === 'direct' ? 'direct' : cust.channel) : null,
      dealerLevel: cust.source_type === 'dealer' ? cust.level : null,
      region: cust.region
    }
    const items = []
    for (let k = 0; k < lineCount; k += 1) {
      const sku = pick(candidateSkus, seq * 7 + k * 13)
      const pr = resolvePrice(db, { skuId: sku.id, orgId: cust.org_id, ...dims, qty: 1 })
      const lineTarget = totalTarget / lineCount
      const qty = Math.max(1, Math.round(lineTarget / Math.max(1, pr.price)))
      items.push({ sku_id: sku.id, qty })
    }
    const quotePreview = quoteItems(db, { customerId: cust.id, items })
    // 账期客户不要把额度一次打满：演示要能继续下单，也要留出「超授信需特批」的余量
    const snap = creditSnapshot(db, cust.id)
    if (cust.settle_type === 'credit' && snap.creditAvailable > 0 && quotePreview.totalAmount > snap.creditAvailable * 0.7) {
      const scale = Math.max(0.02, (snap.creditAvailable * 0.5) / quotePreview.totalAmount)
      for (const it of items) it.qty = Math.max(1, Math.round(it.qty * scale))
    }

    let created
    try {
      created = createOrder(db, {
        customerId: cust.id,
        items,
        orderDate: dayAgo(20 - (seq % 18)),
        expectDate: dayAgo(15 - (seq % 12)),
        source: 'seed',
        actor,
        autoSubmit: true
      })
    } catch (e) {
      // 触发硬校验（超授信/逾期/未准入/要求足量）的单直接跳过 ——
      // 这正是「下单前必须校验」在起作用，不是数据错误。记下来备查。
      skipped.push(`${cust.code}(${e.code || 'ERR'}): ${String(e.message).slice(0, 60)}`)
      seq += 1
      continue
    }
    stat.orders += 1
    stat.approvals += created.approval.chain.length

    // 7 种状态都造出样本，看板与流转列表才有东西看
    const mode = seq % 7
    const oid = created.order.id
    const advance = (action) => { try { return transitionOrder(db, { id: oid, action, actor, source: 'seed' }) } catch { return null } }
    if (mode === 6) {
      // 单独一支：草稿之后一路取消，用来验证「取消要释放授信占用」
      advance('cancel')
    } else {
      // 审批链可能有多节点（金额分级 + 缺货确认 + 授信特批），逐节点推进到通过为止。
      // 真人也是一级一级点，这里替他把每一级都点了。
      if (mode >= 1) for (let n = 0; n < 5; n += 1) {
        const r = advance('approve')
        if (!r?.partial) break
      }
      if (mode >= 2) advance('allocate')
      if (mode >= 3) advance('ship')
      if (mode >= 4) advance('receive')
      if (mode >= 5) advance('complete')
    }
    seq += 1
  }

  // ---------- 6. 对账单（对账是 B2B 主功能，不能没有样本） ----------
  const withOrders = db
    .prepare(
      `SELECT customer_id, COUNT(*) c FROM oc_orders
       WHERE status IN ('received','completed') GROUP BY customer_id HAVING c >= 1 ORDER BY c DESC LIMIT 4`
    )
    .all()
  for (const [i, row] of withOrders.entries()) {
    try {
      const s = buildStatement(db, {
        customerId: row.customer_id,
        periodStart: dayAgo(30),
        periodEnd: dayAgo(1),
        actor,
        remark: '演示对账单'
      })
      stat.statements += 1
      if (i % 2 === 0) {
        confirmStatement(db, { id: s.id, actor })
        // 一半全额结清、一半留差异，才能演示「差异申诉」这一支
        const amount = i === 0 ? s.total_amount : Number((s.total_amount * 0.6).toFixed(2))
        settleStatement(db, { id: s.id, amount, actor, remark: i === 0 ? '全额回款' : '部分回款' })
      }
    } catch {
      /* 无可对账订单则跳过 */
    }
  }

  stat.creditRows = db.prepare('SELECT COUNT(*) c FROM oc_credit_ledger').get().c
  const byStatus = db.prepare('SELECT status, COUNT(*) c FROM oc_orders GROUP BY status ORDER BY c DESC').all()
  say(`[oc:${industry}] 订货主体 ${stat.customers} 个（含下游终端 ${stat.downstream} 个）/ 订货单 ${stat.orders} 张 / 审批节点 ${stat.approvals} 个 / 对账单 ${stat.statements} 张 / 授信流水 ${stat.creditRows} 行`)
  if (!silent) {
    say(`         状态分布：${byStatus.map((r) => `${r.status}=${r.c}`).join('  ')}`)
    if (skipped.length) say(`         被下单前校验拦下的 ${skipped.length} 单（预期，非错误）：${skipped.slice(0, 3).join(' | ')}${skipped.length > 3 ? ' …' : ''}`)
  }

  return { ...stat, skipped: skipped.length, byStatus }
}

export default { seedOrderCenter, PROFILES }
