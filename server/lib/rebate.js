/**
 * ============================================================================
 * 文件标识：server/lib/rebate.js ｜ 经销商返利：计提 → 试算 → 核销 → 冲应收（批次 G · 模块 26）
 * ============================================================================
 * 【职责】经销商返利：计提 → 试算 → 核销 → 冲应收（批次 G · 模块 26）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 经销商返利：计提 → 试算 → 核销 → 冲应收（批次 G · 模块 26）
//
// ===========================================================================
// 一、这一层要补的是最后一步：**把钱真正冲掉**
// ===========================================================================
// `rebate_policies`（政策）与 `dealer_rebates`（每期每政策一条核算结果）早已存在，
// 状态是 `pending / confirmed / paid`。但 `paid` 只是一个**状态字** ——
// 把它从 confirmed 改成 paid，账上分毫未动：应收还是那么多，客户还得照付。
//
// 本批补齐的是"核销"：
//
//   ① **计提（accrue）**：按适用政策算出这一期该返多少，写 `dealer_rebates`(pending)；
//   ② **确认（confirm）**：把这一笔从 pending 推到 confirmed（可入账的语义）；
//   ③ **核销（settle）**：把某期已确认的返利汇成一张核销单，**冲减该客户的未核销应收**。
//
// ⚠️ 内核侧的口径对齐（批次 V · A1）：本文件的三态 `pending → confirmed → paid`
// （`confirmRebate` 只接受 pending、`settleRebates` 只取 confirmed）**就是定义**——
// `008_doc_kernel.cjs` 的 `STATES.RB / ACTIONS.RB` 已按它补齐（补 `confirmed` 与
// `pending→confirmed / confirmed→paid`，并删掉原来那条在这份代码里走不通的 `pending→paid`）。
// 若将来这里再改状态，**必须同步改 008 的 RB 状态与动作**，否则内核里会出现
// 「注册了到不了」或「真实状态内核不认」——两者都不报错，只是状态机与账各说各话。
//
// 三条硬口径（与销售退货 D1 严格一致，改一处就要改另一处）：
//   · 应收**只减不增**，绝不生成负数应收；
//   · 应收不够冲的部分登记为 `unoffset_amount`（如实登记，不静默吞掉）；
//   · 核销**幂等**：同一 `idempotency_key` 重放返回同一张单，不重复冲减。
//
// ===========================================================================
// 二、为什么"计算"必须只有一处实现
// ===========================================================================
// 原来 `calcOnePolicy` 长在 `routes/dealers.js` 里，只能被"试算"这一个端点用。
// 而计提要在**没有 HTTP 请求**的地方跑（定时任务 / 批量核算），
// 复制一份到 lib 里的后果是"试算说 12000、计提算成 11800" ——
// 两个数都合理，界面上一眼看不出哪个对。所以整段搬进来，路由改为调它。
//
// 基数的口径说明一并作为**快照**写进 `dealer_rebates.commission_basis`：
// 政策后来改了档位，历史那几期的"当时是怎么算出来的"仍然答得上来。
import { offsetAr } from './ar.js'
// 单号：返利核销单不是内核单据（不进 doc_types），直接用前缀 + 计数器，
// 与门店日结批次 / H5 商城单同一手法。
import { nextDocNo } from './docno.js'
// 留痕唯一出处（doc_events）。返利单（RB）的状态推进是**裸 UPDATE**（见下两处的说明），
// 所以必须自己补痕 —— 与 `routes/requisitions.js:393/844`、`routes/demand.js:276` 同一档写法。
import { logEvent } from './docflow.js'

export class RebateError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = http
    this.detail = detail
  }
}

const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ')
const money = (n) => Number((Number(n) || 0).toFixed(2))

export const POLICY_TYPE_LABEL = {
  tiered: '阶梯比例返点',
  fixed_per_unit: '按件定额返点',
  growth: '同比增量返点',
  payback: '回款达标返点',
  category: '品类专向返点',
  seasonal: '档期任务返点'
}

export const REBATE_STATUS_LABEL = { pending: '待核算', confirmed: '已确认', paid: '已核销' }
export const SETTLEMENT_STATUS_LABEL = { draft: '草稿', confirmed: '已核销', cancelled: '已取消' }

/** `/^\d{4}-\d{2}$/` 的期间校验：写错期间的后果是"这一期永远算不出返利"，且不报错 */
export function assertPeriod(period) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) {
    throw new RebateError('BAD_PERIOD', `期间格式应为 YYYY-MM，收到「${period}」`)
  }
  return String(period)
}

export function parseRules(policy) {
  try {
    return typeof policy.rules === 'string' ? JSON.parse(policy.rules || '{}') : policy.rules || {}
  } catch {
    return {}
  }
}

/** 政策是否适用于这家经销商（等级 / 渠道两条门槛） */
export function policyApplies(policy, dealer) {
  if (policy.dealer_level && policy.dealer_level !== 'all' && policy.dealer_level !== dealer.level) return false
  if (policy.channel_type && policy.channel_type !== 'all' && policy.channel_type !== dealer.channel_type) return false
  return true
}

/** 政策期间与核算期间的匹配（支持 `2026-10` 与 `2026-Q4` 两种写法） */
export function periodMatches(policyPeriod, period) {
  if (!policyPeriod) return true
  if (policyPeriod === period) return true
  const q = String(policyPeriod).match(/^(\d{4})-Q([1-4])$/)
  if (q) {
    const month = Number(String(period).split('-')[1])
    return String(period).startsWith(q[1]) && Math.ceil(month / 3) === Number(q[2])
  }
  return false
}

/**
 * 单个政策对单个经销商在某一期的返利试算（**不落库**）。
 * 返回带 `basis_desc`（给界面解释"为什么是这个数"）与 `matched`（是否命中）。
 */
export function calcOnePolicy(db, policy, dealer, period) {
  const rules = parseRules(policy)
  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(receivable_amount),0) sales, COALESCE(SUM(paid_amount),0) paid FROM sales_orders
       WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND substr(order_date,1,7)=?`
    )
    .get(dealer.id, period)
  const ret = db
    .prepare(
      `SELECT COALESCE(SUM(total_amount),0) amount FROM sales_returns
       WHERE dealer_id=? AND substr(return_date,1,7)=? AND status IN ('confirmed','completed')`
    )
    .get(dealer.id, period)
  const sales = money(agg.sales)
  const paid = money(agg.paid)
  const returns = money(ret.amount)
  const net = money(sales - returns)
  const basis = policy.basis === 'gross' ? sales : policy.basis === 'pay' ? paid : net
  let rate = 0
  let amount = 0
  let basisDesc = ''
  let matched = false

  if (policy.type === 'tiered') {
    const tiers = (rules.tiers || []).slice().sort((a, b) => (a.min || 0) - (b.min || 0))
    for (const t of tiers) {
      if (basis >= (t.min || 0) && (t.max == null || basis < t.max)) {
        rate = Number(t.rate || 0)
        matched = true
        break
      }
    }
    amount = money((basis * rate) / 100)
    basisDesc = `${basis >= 0 ? '阶梯命中' : ''}${tiers.map((t) => `≥${t.min || 0}:${t.rate}%`).join(' / ')}`
  } else if (policy.type === 'fixed_per_unit') {
    const qtyRow = db
      .prepare(
        `SELECT COALESCE(SUM(i.qty),0) qty FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft') AND substr(so.order_date,1,7)=?`
      )
      .get(dealer.id, period)
    const qty = Number(qtyRow.qty)
    rate = Number(rules.perUnit || 0)
    amount = money(qty * rate)
    matched = qty > 0
    basisDesc = `进货 ${qty} 件 × ${rate} 元/件`
  } else if (policy.type === 'growth') {
    // 同比/环比增量：与上一期销售额对比，增量部分按 rate 返
    const [py, pm] = String(period).split('-').map(Number)
    const prevDate = new Date(py, pm - 2, 1)
    const prevPeriod = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`
    const prevAgg = db
      .prepare(
        `SELECT COALESCE(SUM(receivable_amount),0) v FROM sales_orders
         WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND substr(order_date,1,7)=?`
      )
      .get(dealer.id, prevPeriod)
    const base = money(prevAgg.v)
    const growth = money(sales - base)
    rate = Number(rules.rate || 0)
    if (growth > 0) {
      amount = money((growth * rate) / 100)
      matched = true
    }
    basisDesc = `上期基数 ${base}，本期增量 ${growth} × ${rate}%`
  } else if (policy.type === 'payback') {
    const payRatio = paid / (sales || 1)
    rate = Number(rules.rate || 0)
    if (payRatio >= Number(rules.payRatio || 0.9)) {
      amount = money((basis * rate) / 100)
      matched = true
    }
    basisDesc = `回款率 ${(payRatio * 100).toFixed(1)}%（要求 ≥${((rules.payRatio || 0.9) * 100).toFixed(0)}%）`
  } else if (policy.type === 'category') {
    const catAgg = db
      .prepare(
        `SELECT COALESCE(SUM(i.amount),0) v FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft') AND substr(so.order_date,1,7)=? AND p.category_id=?`
      )
      .get(dealer.id, period, Number(rules.categoryId || 0))
    const catSales = money(catAgg.v)
    rate = Number(rules.rate || 0)
    if (catSales > 0) {
      amount = money((catSales * rate) / 100)
      matched = true
    }
    basisDesc = `指定品类销售 ${catSales} × ${rate}%`
  } else if (policy.type === 'seasonal') {
    const target = Number(rules.target || 0)
    rate = Number(rules.rate || 0)
    if (basis >= target && target > 0) {
      amount = money((basis * rate) / 100)
      matched = true
    }
    basisDesc = `档期目标 ${target}，实际 ${basis}`
  }

  // 封顶：**先封顶再返回**，让"算出来 5 万、实际只返 2 万"这件事在试算阶段就可见
  if (Number(policy.rebate_cap) > 0 && amount > Number(policy.rebate_cap)) {
    basisDesc += `（封顶 ${policy.rebate_cap}）`
    amount = money(policy.rebate_cap)
  }

  return {
    policy_id: policy.id,
    policy_name: policy.name,
    policy_type: policy.type,
    policy_type_name: POLICY_TYPE_LABEL[policy.type] || policy.type,
    applicable: policyApplies(policy, dealer),
    matched,
    basis_desc: basisDesc,
    sales_amount: sales,
    return_amount: returns,
    net_amount: net,
    paid_amount: paid,
    rebate_rate: rate,
    rebate_amount: matched ? amount : 0
  }
}

export function getDealer(db, dealerId) {
  const d = db.prepare('SELECT * FROM dealers WHERE id=?').get(Number(dealerId))
  if (!d) throw new RebateError('DEALER_NOT_FOUND', `经销商 #${dealerId} 不存在`, 404)
  return d
}

/** 这家经销商在这一期适用的政策（等级/渠道命中 + 期间匹配） */
export function applicablePolicies(db, { dealerId, period }) {
  const dealer = getDealer(db, dealerId)
  return db
    .prepare("SELECT * FROM rebate_policies WHERE status='active' ORDER BY priority, id")
    .all()
    .filter((p) => policyApplies(p, dealer) && periodMatches(p.period, period))
}

/** 试算：这一期全部适用政策的逐条结果 + 合计 */
export function planRebate(db, { dealerId, period, policyId = null }) {
  assertPeriod(period)
  const dealer = getDealer(db, dealerId)
  const policies = applicablePolicies(db, { dealerId, period }).filter(
    (p) => policyId == null || Number(p.id) === Number(policyId)
  )
  const items = policies.map((p) => calcOnePolicy(db, p, dealer, period))
  return {
    dealer,
    period,
    items,
    total_amount: money(items.filter((i) => i.matched).reduce((s, i) => s + i.rebate_amount, 0))
  }
}

/**
 * 计提：把试算结果落成 `dealer_rebates`（pending）。
 *
 * 幂等：靠表上的 `UNIQUE (dealer_id, period, policy_id)` —— 重复计提只更新
 * **尚未确认**的那些行；已经 `confirmed / paid` 的行**一律不覆盖**
 * （否则一次月度重跑会悄悄改掉上个月已经入账的金额）。
 */
export function accrueRebates(db, { dealerId, period, actor = null, policyId = null } = {}) {
  assertPeriod(period)
  const plan = planRebate(db, { dealerId, period, policyId })
  const result = { dealer_id: Number(dealerId), period, created: 0, updated: 0, skipped: [], lines: [] }

  const tx = db.transaction(() => {
    for (const it of plan.items) {
      if (!it.matched || !(it.rebate_amount > 0)) {
        result.skipped.push({ policy_id: it.policy_id, policy_name: it.policy_name, reason: it.matched ? 'zero_amount' : 'not_matched' })
        continue
      }
      const cur = db
        .prepare('SELECT * FROM dealer_rebates WHERE dealer_id=? AND period=? AND policy_id=?')
        .get(Number(dealerId), period, it.policy_id)
      if (cur) {
        if (cur.status !== 'pending') {
          // 已确认 / 已核销：**不覆盖**，但如实报出来（"为什么这次计提没动它"要答得上）
          result.skipped.push({ policy_id: it.policy_id, policy_name: it.policy_name, reason: `locked:${cur.status}` })
          continue
        }
        db.prepare(`
          UPDATE dealer_rebates
             SET policy_name=?, calc_basis=?, commission_basis=?, sales_amount=?, return_amount=?, net_amount=?,
                 rebate_rate=?, rebate_amount=?, remark=?
           WHERE id=?
        `).run(it.policy_name, it.policy_type_name, it.basis_desc, it.sales_amount, it.return_amount,
          it.net_amount, it.rebate_rate, it.rebate_amount, `按政策 ${it.policy_name} 计提`, cur.id)
        result.updated += 1
        result.lines.push({ id: cur.id, ...it, action: 'updated' })
      } else {
        const info = db.prepare(`
          INSERT INTO dealer_rebates
            (dealer_id, period, policy_id, policy_name, calc_basis, commission_basis,
             sales_amount, return_amount, net_amount, rebate_rate, rebate_amount, status, remark)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,'pending',?)
        `).run(Number(dealerId), period, it.policy_id, it.policy_name, it.policy_type_name, it.basis_desc,
          it.sales_amount, it.return_amount, it.net_amount, it.rebate_rate, it.rebate_amount,
          `按政策 ${it.policy_name} 计提`)
        result.created += 1
        result.lines.push({ id: Number(info.lastInsertRowid), ...it, action: 'created' })
      }
    }
    return result
  })

  const out = tx.immediate()
  out.total_amount = plan.total_amount
  out.actor = actor?.name ?? null
  return out
}

/** 确认单笔返利（pending → confirmed）。**只有 pending 能确认** —— 状态机不做跳级。 */
export function confirmRebate(db, { id, actor = null, remark = null } = {}) {
  const row = db.prepare('SELECT * FROM dealer_rebates WHERE id=?').get(Number(id))
  if (!row) throw new RebateError('NOT_FOUND', `返利记录不存在：#${id}`, 404)
  if (row.status !== 'pending') {
    throw new RebateError('REBATE_NOT_PENDING', `当前状态「${REBATE_STATUS_LABEL[row.status] || row.status}」不能确认`, 409)
  }
  // 裸 UPDATE（不是 applyTransition）⇒ **痕迹自己补**，且与改动**同一个事务**（同生共死）。
  // ⚠️ 为什么**不**改成 applyTransition：返利单的状态推进里夹着"按 net_amount×rate 算 rebate_amount"
  // 这类业务计算，动 transition 会把它拆成两段；而且它会引入边校验，可能把现在能跑的流程变成 409。
  // `from: row.status`（这里必为 `pending`）/ `to: 'confirmed'` 是内核注册过的边（`RB` 的 `confirm`）。
  const exec = db.transaction(() => {
    db.prepare("UPDATE dealer_rebates SET status='confirmed', remark=COALESCE(?, remark) WHERE id=?").run(remark, Number(id))
    logEvent({
      db,
      docType: 'RB',
      id: Number(id),
      docNo: row.doc_no ?? null,
      action: 'confirm',
      actionName: '确认',
      from: row.status,
      to: 'confirmed',
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
      source: actor?.source || 'api',
      remark: remark || `返利确认（${row.period || ''}）`,
      payload: { dealer_id: row.dealer_id ?? null, period: row.period ?? null, rebate_amount: row.rebate_amount ?? null }
    })
  })
  exec()
  return { id: Number(id), status: 'confirmed', actor: actor?.name ?? null }
}

/**
 * 核销：把某经销商某期**已确认**的返利汇成一张核销单并**冲减应收**。
 *
 * 一个事务里做完四件事：
 *   ① 汇总该期 `confirmed` 的返利；一笔都没有就**报错**（不生成空单 ——
 *      空单会让"这批返利核销过了"这个事实变成假的）；
 *   ② 冲应收（`ar.offsetAr` 的唯一实现，只减不增、冲不下如实报 `unoffset`）；
 *   ③ 写核销单 + 明细；
 *   ④ 回写每笔返利：`status='paid'` + `settlement_id` + `ar_offset_amount` + `settled_at`。
 *
 * 幂等：给了 `idempotencyKey` 时同键重放返回**首次那张单**，不重复冲减
 * （唯一索引 `idx_rebate_settlement_idem` 兜住并发）。
 */
export function settleRebates(db, { dealerId, period, actor = null, idempotencyKey = null, remark = null } = {}) {
  assertPeriod(period)
  const dealer = getDealer(db, dealerId)

  if (idempotencyKey) {
    const hit = db.prepare('SELECT * FROM rebate_settlements WHERE idempotency_key=?').get(idempotencyKey)
    if (hit) return { ...getSettlement(db, hit.id), replayed: true }
  }

  const tx = db.transaction(() => {
    const rows = db
      .prepare("SELECT * FROM dealer_rebates WHERE dealer_id=? AND period=? AND status='confirmed' ORDER BY id")
      .all(Number(dealerId), period)
    if (!rows.length) {
      throw new RebateError('NO_CONFIRMED_REBATE', `${dealer.name} 在 ${period} 没有已确认的返利可核销`, 409)
    }
    const total = money(rows.reduce((s, r) => s + Number(r.rebate_amount), 0))
    if (!(total > 0)) {
      throw new RebateError('ZERO_TOTAL', '已确认返利合计为 0，无需核销', 409)
    }

    const docNo = nextDocNo(db, 'FLHX', 'rebate_settlements', 'doc_no')
    const info = db.prepare(`
      INSERT INTO rebate_settlements
        (doc_no,dealer_id,period,rebate_count,total_amount,ar_offset_amount,unoffset_amount,status,
         idempotency_key,operator_id,operator_name,remark,confirmed_at)
      VALUES (?,?,?,?,?,0,0,'confirmed',?,?,?,?,?)
    `).run(docNo, Number(dealerId), period, rows.length, total, idempotencyKey,
      actor?.id ?? null, actor?.name ?? null, remark || `${dealer.name} ${period} 返利核销`, nowText())
    const sid = Number(info.lastInsertRowid)

    // ② 冲应收：返利不属于任何一张具体订单，是**对这个客户的债权** ⇒ 按主体分摊
    const off = offsetAr(db, {
      subjectType: 'dealer', subjectId: Number(dealerId),
      amount: total, reason: `返利核销 ${docNo}`
    })

    // ③ 明细：按各笔返利占比把"冲减额"摊回去 —— 逐笔可追溯"这笔返利冲了多少应收"
    const insItem = db.prepare(`
      INSERT INTO rebate_settlement_items (settlement_id,rebate_id,policy_id,amount,ar_offset_amount)
      VALUES (?,?,?,?,?)
    `)
    const updRebate = db.prepare(`
      UPDATE dealer_rebates SET status='paid', settlement_id=?, ar_offset_amount=?, settled_at=? WHERE id=?
    `)
    let allocated = 0
    rows.forEach((r, i) => {
      const amt = money(r.rebate_amount)
      // 末行兜底消尾差：**不能留一个"合计对不上"的差额**，账龄与客户汇总都按合计比
      const share = i === rows.length - 1 ? money(off.offset - allocated) : money((off.offset * amt) / (total || 1))
      const capped = money(Math.max(0, Math.min(share, amt)))
      allocated = money(allocated + capped)
      insItem.run(sid, r.id, r.policy_id, amt, capped)
      updRebate.run(sid, capped, nowText(), r.id)
      // 裸 UPDATE（`updRebate`）⇒ **每笔返利都要有自己的痕**（N 行 = N 张 RB 单，不能只记一条）。
      // 与改动同事务（都在这个 `tx` 里）；`confirmed → paid` 是内核注册过的边（`RB` 的 `pay`）。
      logEvent({
        db,
        docType: 'RB',
        id: Number(r.id),
        docNo: r.doc_no ?? null,
        action: 'pay',
        actionName: '核销返利',
        from: r.status,
        to: 'paid',
        actor: { id: actor?.id ?? null, name: actor?.name ?? null },
        source: actor?.source || 'api',
        remark: `返利核销（核销单 ${docNo}）`,
        payload: {
          settlement_id: sid,
          settlement_doc_no: docNo,
          ar_offset_amount: capped,
          rebate_amount: amt,
          period,
          dealer_id: Number(dealerId)
        }
      })
    })

    db.prepare('UPDATE rebate_settlements SET ar_offset_amount=?, unoffset_amount=? WHERE id=?').run(
      off.offset, off.unoffset, sid
    )
    return sid
  })

  const sid = tx.immediate()
  return getSettlement(db, sid)
}

export function getSettlement(db, id) {
  const head = db
    .prepare(`
      SELECT s.*, d.name AS dealer_name, d.code AS dealer_code
        FROM rebate_settlements s LEFT JOIN dealers d ON d.id=s.dealer_id
       WHERE s.id=?
    `)
    .get(Number(id))
  if (!head) return null
  const items = db
    .prepare(`
      SELECT i.*, r.period, r.status AS rebate_status, r.policy_name
        FROM rebate_settlement_items i LEFT JOIN dealer_rebates r ON r.id=i.rebate_id
       WHERE i.settlement_id=? ORDER BY i.id
    `)
    .all(Number(id))
  return {
    ...head,
    items,
    status_label: SETTLEMENT_STATUS_LABEL[head.status] || head.status,
    // 冲不下的部分单独给一个字段：界面要能直接回答"还有多少返利没落到实处"
    unoffset_reason: head.unoffset_amount > 0
      ? '该客户未核销应收余额不足，差额未冲减（未生成负数应收）'
      : null
  }
}

export function listSettlements(db, { dealerId = null, period = null, status = null, page = 1, pageSize = 20 } = {}) {
  const where = []
  const params = []
  if (dealerId) { where.push('s.dealer_id=?'); params.push(Number(dealerId)) }
  if (period) { where.push('s.period=?'); params.push(period) }
  if (status) { where.push('s.status=?'); params.push(status) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = db.prepare(`SELECT COUNT(*) c FROM rebate_settlements s ${clause}`).get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const rows = db
    .prepare(`
      SELECT s.*, d.name AS dealer_name, d.code AS dealer_code
        FROM rebate_settlements s LEFT JOIN dealers d ON d.id=s.dealer_id
        ${clause} ORDER BY s.id DESC LIMIT ? OFFSET ?
    `)
    .all(...params, pageSize, off)
  return {
    list: rows.map((r) => ({ ...r, status_label: SETTLEMENT_STATUS_LABEL[r.status] || r.status })),
    total, page, pageSize
  }
}

/**
 * 返利域的账实自证：三条不变量。
 *   · 已核销（paid）的返利必须挂在一张真实的核销单上；
 *   · 核销明细合计 = 核销单的返利总额；
 *   · 核销单的「冲减 + 未冲减」必须等于返利总额（钱要么冲掉了、要么如实记着没冲掉）。
 */
export function auditRebate(db) {
  const noSettlement = db
    .prepare("SELECT COUNT(*) c FROM dealer_rebates WHERE status='paid' AND settlement_id IS NULL")
    .get().c
  const itemMismatch = db
    .prepare(`
      SELECT COUNT(*) c FROM (
        SELECT s.id, s.total_amount,
               COALESCE((SELECT SUM(i.amount) FROM rebate_settlement_items i WHERE i.settlement_id=s.id),0) item_sum
          FROM rebate_settlements s WHERE s.status='confirmed'
      ) WHERE ABS(total_amount - item_sum) > 0.005
    `)
    .get().c
  const moneyMismatch = db
    .prepare(`
      SELECT COUNT(*) c FROM rebate_settlements
       WHERE status='confirmed'
         AND ABS(total_amount - (ar_offset_amount + unoffset_amount)) > 0.005
    `)
    .get().c
  return {
    no_settlement: noSettlement,
    item_mismatch: itemMismatch,
    money_mismatch: moneyMismatch,
    balanced: noSettlement === 0 && itemMismatch === 0 && moneyMismatch === 0
  }
}

export default {
  RebateError, assertPeriod, parseRules, policyApplies, periodMatches, calcOnePolicy,
  applicablePolicies, planRebate, accrueRebates, confirmRebate,
  settleRebates, getSettlement, listSettlements, auditRebate,
  POLICY_TYPE_LABEL, REBATE_STATUS_LABEL, SETTLEMENT_STATUS_LABEL
}
