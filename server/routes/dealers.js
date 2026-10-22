/**
 * ============================================================================
 * 文件标识：server/routes/dealers.js ｜ 经销商路由：经销商总览、要货申请与计划、返利管理、返点政策、对账单（出具/结清/作废）
 * ============================================================================
 * 【职责】经销商路由：经销商总览、要货申请与计划、返利管理、返点政策、对账单（出具/结清/作废）
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
import { getDb } from '../db/index.js'
import { localDate } from '../lib/dates.js'
import { ok, fail, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole, requirePerm, requireInternal, currentUser } from '../middleware/auth.js'
import { audit, auditStrict } from '../middleware/audit.js'
import { nextDocNo } from '../lib/docno.js'
// 返利计算与核销的**唯一实现**（批次 G）。本文件只保留端点，不再自带一份算法。
import * as Rebate from '../lib/rebate.js'
// 对账单四个动作（确认 / 发送 / 结清 / 作废）与对账单口径的**唯一实现**。本文件只做鉴权与转发：
//   · 「结清必须收齐」这条判据如果写在路由里，任何第二个入口都会绕过它；
//   · 确认/发送原来是一段裸 UPDATE（改状态不写留痕），现已收敛到这里走内核；
//   · 生成对账单（POST /statements）也调这里的 statementFigures ——
//     生成口径与结清判据必须同源，否则会出现"刚生成就结不了清"这种自相矛盾的怪状。
import { statementFigures, setStatementStatus, closeStatement, voidStatement } from '../lib/dealer-statement.js'
// 留痕唯一出处（doc_events）：返利单（RB）这个端点原来是**裸 UPDATE 改状态**（改完什么痕都没有），
// 现在补一条与改动同事务的 `logEvent`（见 `PUT /rebates/:id` 里的说明）。
// `allowedActions` 是内核里"某状态下能做哪些动作"的**唯一读法** —— 用它查边，
// 而不是在本文件手写一条 `SELECT … FROM doc_actions`（那就是第二份"哪些边存在"的实现）。
import { logEvent, allowedActions } from '../lib/docflow.js'

const r = Router()
r.use(requireAuth, requireInternal('总部经销商管理；经销商请使用订货中心'))
const W = ['sales', 'admin', 'finance']

// 操作人：与 lib/ar.js 的 actorOf 同形（`uid` 优先，兼容 `id`）。
// 留痕的第一要素是人，取错字段会让"谁做的"彻底失真 —— 所以只此一处。
const actorOf = (req) => {
  const u = currentUser(req) || {}
  return { id: u.uid ?? u.id ?? null, name: u.name || u.username || null }
}

const LEVEL_LABEL = { diamond: '钻石经销商', gold: '金牌经销商', silver: '银牌经销商', bronze: '普通经销商' }
const LEVEL_RANK = { diamond: 4, gold: 3, silver: 2, bronze: 1 }

// ---------- 经销商总览 ----------
r.get(
  '/overview',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const days = Number(req.query.days || 90)
    const from = `date('now','localtime','-${days} day')`
    const byLevel = db
      .prepare(`SELECT level, COUNT(*) cnt, COALESCE(SUM(credit_limit),0) credit FROM dealers WHERE status='active' GROUP BY level`)
      .all()
    const byRegion = db
      .prepare(
        `SELECT COALESCE(region,'未分区') AS region, COUNT(*) cnt FROM dealers WHERE status='active' GROUP BY region ORDER BY cnt DESC`
      )
      .all()
    const ranking = db
      .prepare(
        `SELECT d.id, d.code, d.name, d.level, d.region, d.credit_limit, d.credit_used,
                COUNT(so.id) orders, COALESCE(SUM(so.receivable_amount),0) amount,
                COALESCE(SUM(so.paid_amount),0) paid,
                COALESCE(SUM(so.receivable_amount - so.paid_amount),0) unpaid
         FROM dealers d LEFT JOIN sales_orders so ON so.dealer_id=d.id AND so.status NOT IN ('cancelled','draft') AND so.order_date >= ${from}
         WHERE d.status='active'
         GROUP BY d.id ORDER BY amount DESC LIMIT 20`
      )
      .all()
    const total = db
      .prepare(
        `SELECT COUNT(*) dealers, COALESCE(SUM(credit_limit),0) credit_limit, COALESCE(SUM(credit_used),0) credit_used,
                COALESCE(AVG(rebate_rate),0) avg_rebate FROM dealers WHERE status='active'`
      )
      .get()
    const creditAlerts = db
      .prepare(
        `SELECT id, code, name, credit_limit, credit_used,
                ROUND(credit_used * 100.0 / NULLIF(credit_limit,0), 1) AS usage_pct
         FROM dealers WHERE status='active' AND credit_limit > 0 AND credit_used * 1.0 / credit_limit >= 0.8
         ORDER BY usage_pct DESC LIMIT 20`
      )
      .all()
    return ok(res, {
      byLevel: byLevel.map((x) => ({ ...x, level_name: LEVEL_LABEL[x.level] || x.level })),
      byRegion,
      ranking,
      total,
      creditAlerts
    })
  })
)

// ---------- 经销商档案详情 ----------
r.get(
  '/:id/profile',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const dealer = db.prepare('SELECT * FROM dealers WHERE id=?').get(id)
    if (!dealer) return fail(res, '经销商不存在', 404)
    dealer.level_name = LEVEL_LABEL[dealer.level] || dealer.level
    const sales = db
      .prepare(
        `SELECT COALESCE(SUM(receivable_amount),0) amount, COALESCE(SUM(paid_amount),0) paid, COUNT(*) orders,
                COALESCE(SUM(CASE WHEN order_date >= date('now','localtime','-90 day') THEN receivable_amount ELSE 0 END),0) amount_90d
         FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft')`
      )
      .get(id)
    const monthly = db
      .prepare(
        `SELECT substr(order_date,1,7) AS month, COUNT(*) orders, COALESCE(SUM(receivable_amount),0) amount
         FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft')
         GROUP BY month ORDER BY month DESC LIMIT 12`
      )
      .all(id)
    const recentOrders = db
      .prepare(
        `SELECT id, doc_no, order_date, status, total_qty, receivable_amount, paid_amount FROM sales_orders
         WHERE dealer_id=? ORDER BY id DESC LIMIT 10`
      )
      .all(id)
    const topProducts = db
      .prepare(
        `SELECT p.name AS product_name, sk.name AS sku_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft')
         GROUP BY sk.id ORDER BY amount DESC LIMIT 10`
      )
      .all(id)
    const rebates = db.prepare('SELECT * FROM dealer_rebates WHERE dealer_id=? ORDER BY period DESC LIMIT 12').all(id)
    const statements = db.prepare('SELECT * FROM dealer_statements WHERE dealer_id=? ORDER BY id DESC LIMIT 10').all(id)
    const returns = db
      .prepare('SELECT * FROM sales_returns WHERE dealer_id=? ORDER BY id DESC LIMIT 10')
      .all(id)
    return ok(res, { dealer, sales, monthly, recentOrders, topProducts, rebates, statements, returns })
  })
)

// ---------- 返利 ----------
r.get(
  '/rebates',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.dealer_id) {
      conds.push('rb.dealer_id = ?')
      params.push(Number(req.query.dealer_id))
    }
    if (req.query.period) {
      conds.push('rb.period = ?')
      params.push(req.query.period)
    }
    if (req.query.status) {
      conds.push('rb.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'dealer_rebates rb JOIN dealers d ON d.id=rb.dealer_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT rb.*, d.name AS dealer_name, d.code AS dealer_code, d.level FROM ${FROM} ${where} ORDER BY rb.period DESC, rb.rebate_amount DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    const sum = db.prepare(`SELECT COALESCE(SUM(rb.rebate_amount),0) amount FROM ${FROM} ${where}`).get(...params)
    return paged(res, { rows, total, page, pageSize, summary: sum })
  })
)

// ---------- 返点政策（多形式） ----------
// ⚠️ 计算实现**已移到 lib/rebate.js**（批次 G）：
// "计提"要在**没有 HTTP 请求**的地方跑（批量核算），把计算留在路由里就必然要复制一份，
// 复制之后「试算说 12000、计提算成 11800」——两个数都合理，界面上一眼看不出哪个对。
// 这里只做别名，保证老端点（/api/dealers/*）与新端点（/api/dms/*）用的是同一份判据。
const {
  POLICY_TYPE_LABEL,
  parseRules,
  policyApplies,
  periodMatches,
  calcOnePolicy
} = Rebate


r.get(
  '/policies',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.type) {
      conds.push('p.type = ?')
      params.push(req.query.type)
    }
    if (req.query.status) {
      conds.push('p.status = ?')
      params.push(req.query.status)
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM rebate_policies p ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT p.* FROM rebate_policies p ${where} ORDER BY p.priority, p.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, {
      rows: rows.map((x) => ({ ...x, type_name: POLICY_TYPE_LABEL[x.type] || x.type, rules_json: parseRules(x) })),
      total, page, pageSize,
      typeLabels: POLICY_TYPE_LABEL
    })
  })
)

r.post(
  '/policies',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const { code, name, type = 'tiered', dealer_level = 'all', channel_type = 'all', period, basis = 'net', rules, rebate_cap = 0, priority = 100, status = 'active', remark } = req.body || {}
    if (!name) return fail(res, '政策名称必填')
    if (!POLICY_TYPE_LABEL[type]) return fail(res, `不支持的政策类型：${type}`)
    const pCode = code || `RP${Date.now().toString().slice(-6)}`
    if (db.prepare('SELECT id FROM rebate_policies WHERE code=?').get(pCode)) return fail(res, '政策编码已存在')
    const info = db
      .prepare(
        `INSERT INTO rebate_policies (code,name,type,dealer_level,channel_type,period,basis,rules,rebate_cap,priority,status,remark)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(pCode, name, type, dealer_level, channel_type, period || null, basis, typeof rules === 'string' ? rules : JSON.stringify(rules || {}), Number(rebate_cap || 0), Number(priority || 100), status, remark || null)
    audit(req, { action: 'CREATE', module: 'dealer', entity: 'rebate_policies', entityId: info.lastInsertRowid, detail: name })
    return ok(res, { id: info.lastInsertRowid, code: pCode })
  })
)

r.put(
  '/policies/:id',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const exist = db.prepare('SELECT * FROM rebate_policies WHERE id=?').get(id)
    if (!exist) return fail(res, '政策不存在', 404)
    const { name, type, dealer_level, channel_type, period, basis, rules, rebate_cap, priority, status, remark } = req.body || {}
    db.prepare(
      `UPDATE rebate_policies SET name=COALESCE(?,name), type=COALESCE(?,type), dealer_level=COALESCE(?,dealer_level),
        channel_type=COALESCE(?,channel_type), period=COALESCE(?,period), basis=COALESCE(?,basis),
        rules=COALESCE(?,rules), rebate_cap=COALESCE(?,rebate_cap), priority=COALESCE(?,priority), status=COALESCE(?,status), remark=COALESCE(?,remark)
       WHERE id=?`
    ).run(
      name ?? null, type ?? null, dealer_level ?? null, channel_type ?? null, period ?? null, basis ?? null,
      rules == null ? null : typeof rules === 'string' ? rules : JSON.stringify(rules),
      rebate_cap ?? null, priority ?? null, status ?? null, remark ?? null, id
    )
    audit(req, { action: 'UPDATE', module: 'dealer', entity: 'rebate_policies', entityId: id })
    return ok(res, { id })
  })
)

r.delete(
  '/policies/:id',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const used = db.prepare('SELECT COUNT(*) c FROM dealer_rebates WHERE policy_id=?').get(id).c
    if (used) return fail(res, '该政策已产生返点核算记录，请改为停用', 400, 'REFERENCED')
    db.prepare('DELETE FROM rebate_policies WHERE id=?').run(id)
    audit(req, { action: 'DELETE', module: 'dealer', entity: 'rebate_policies', entityId: id })
    return ok(res, { id })
  })
)

// 政策试算（不落库）
r.post(
  '/rebates/preview',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { dealer_id, period } = req.body || {}
    if (!dealer_id || !period) return fail(res, '请选择经销商与期间')
    const dealer = db.prepare('SELECT * FROM dealers WHERE id=?').get(Number(dealer_id))
    if (!dealer) return fail(res, '经销商不存在', 404)
    const policies = db
      .prepare("SELECT * FROM rebate_policies WHERE status='active' ORDER BY priority, id")
      .all()
      .filter((p) => periodMatches(p.period, period))
    const results = policies.map((p) => calcOnePolicy(db, p, dealer, period))
    const totalRebate = results.filter((x) => x.applicable).reduce((s, x) => s + x.rebate_amount, 0)
    return ok(res, {
      dealer: { id: dealer.id, name: dealer.name, level: dealer.level, channel_type: dealer.channel_type },
      period,
      policies: results,
      total_rebate: Number(totalRebate.toFixed(2))
    })
  })
)

// 按期间核算返利（多政策并行）——**改调 `lib/rebate.js` 的计提**（批次 G）。
//
// 原来这段自带一份 upsert：`ON CONFLICT ... DO UPDATE SET rebate_amount=excluded...`，
// 于是**已经确认、甚至已经核销过的上一期数据会被重跑覆盖** ——
// 一次"顺手重算"，账上已经冲掉的返利金额就悄悄变了，而没有任何痕迹。
// `accrueRebates` 的口径是「只更新 pending，非 pending 一律跳过并如实报出来」。
r.post(
  '/rebates/calc',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const period = req.body?.period || localDate().slice(0, 7)
    if (!/^\d{4}-\d{2}$/.test(period)) return fail(res, '期间格式应为 YYYY-MM')
    const dealers = db.prepare("SELECT * FROM dealers WHERE status='active'").all()
    const actor = { id: req.user?.uid ?? null, name: req.user?.name || req.user?.username || null }
    const result = []
    for (const d of dealers) {
      const out = Rebate.accrueRebates(db, { dealerId: d.id, period, actor })
      if (out.created || out.updated) {
        result.push({
          dealer_id: d.id, dealer_name: d.name, total_rebate: out.total_amount,
          created: out.created, updated: out.updated, skipped: out.skipped
        })
      }
    }
    audit(req, { action: 'CALC_REBATE', module: 'dealer', detail: `${period} × ${dealers.length} 经销商` })
    return ok(res, {
      period,
      dealer_count: result.length,
      total_amount: Number(result.reduce((s, x) => s + x.total_rebate, 0).toFixed(2)),
      list: result.sort((a, b) => b.total_rebate - a.total_rebate)
    })
  })
)

r.put(
  '/rebates/:id',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const row = db.prepare('SELECT * FROM dealer_rebates WHERE id=?').get(id)
    if (!row) return fail(res, '返利记录不存在', 404)
    const { status, rebate_rate, remark } = req.body || {}
    const next = status || row.status
    // 状态推进仍是**裸 UPDATE**（不是 applyTransition）：改成走内核会引入边校验，
    // 可能把现在能跑的流程变成 409（这条记入技术债）。但**痕迹必须补**，且与改动**同一个事务**。
    //
    // ⚠️ `action` 从**内核注册过的边**里查（`doc_actions` 的 from→to），查不到就**不留痕**：
    //    这个端点收的是请求体里的 `status`（`PUT /dealers/rebates/:id {status:'paid'|'confirmed'|'voided'}`），
    //    一旦有人传了个内核不认识的值，痕迹若跟着写就会**说谎**（记下一对内核不认的流转，而没人发现）。
    //    所以"只给真边留痕"是这里的硬口径 —— `scripts/check-doc-events-edges.mjs` 也守着同一条。
    const exec = db.transaction(() => {
      db.prepare('UPDATE dealer_rebates SET status=?, rebate_rate=COALESCE(?,rebate_rate), rebate_amount=ROUND(net_amount*COALESCE(?,rebate_rate)/100.0,2), remark=? WHERE id=?').run(
        next, rebate_rate ?? null, rebate_rate ?? null, remark ?? row.remark, id
      )
      if (next !== row.status) {
        // 用内核的 `allowedActions` 查这条 (from→to) 是不是**注册过的边**：
        // 是 ⇒ 用它的 action / action_name 记痕；不是 ⇒ **不留痕**（宁缺勿假）。
        const edge = allowedActions(db, 'RB', row.status).find((a) => a.to === next) || null
        if (edge) {
          logEvent({
            db,
            docType: 'RB',
            id,
            docNo: row.doc_no ?? null,
            action: edge.action,
            actionName: edge.action_name,
            from: row.status,
            to: next,
            actor: { id: req.user?.uid ?? null, name: req.user?.name || req.user?.username || null },
            source: 'api',
            remark: remark || `返利单状态：${row.status} → ${next}`,
            payload: { dealer_id: row.dealer_id ?? null, period: row.period ?? null, rebate_rate: rebate_rate ?? row.rebate_rate ?? null }
          })
        }
      }
      // 返利发放 / 作废是资金相关动作：留痕**严格**且与改动同一个事务（写不进就一起回滚，见 ADR-0010）
      auditStrict(req, { action: 'UPDATE', module: 'dealer', entity: 'dealer_rebates', entityId: id, detail: { status: next, status_before: row.status, rebate_rate: rebate_rate ?? null } })
    })
    exec()
    return ok(res, db.prepare('SELECT * FROM dealer_rebates WHERE id=?').get(id))
  })
)

// ---------- 对账单 ----------
r.get(
  '/statements',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const conds = []
    const params = []
    if (req.query.dealer_id) {
      conds.push('st.dealer_id = ?')
      params.push(Number(req.query.dealer_id))
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : ''
    const FROM = 'dealer_statements st JOIN dealers d ON d.id=st.dealer_id'
    const total = db.prepare(`SELECT COUNT(*) c FROM ${FROM} ${where}`).get(...params).c
    const rows = db
      .prepare(`SELECT st.*, d.name AS dealer_name, d.code AS dealer_code FROM ${FROM} ${where} ORDER BY st.id DESC LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows, total, page, pageSize })
  })
)

r.post(
  '/statements',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const { dealer_id, period_start, period_end } = req.body || {}
    if (!dealer_id || !period_start || !period_end) return fail(res, '请选择经销商与对账期间')
    const dealer = db.prepare('SELECT * FROM dealers WHERE id=?').get(Number(dealer_id))
    if (!dealer) return fail(res, '经销商不存在', 404)
    // 对账单口径**只有一个出处**（`lib/dealer-statement.js` 的 `statementFigures`）。
    // 生成端与"结清时必须收齐"的判据必须同源：分别实现时，只要有一边改了口径，
    // 就会出现"刚生成的对账单立刻结不了清"（或"明明还欠钱却能结清"）——
    // 而两者都不报错，只是账对不上。原来这里是 4 段内联 SQL，现已收敛。
    const fig = statementFigures(db, { dealerId: dealer.id, periodStart: period_start, periodEnd: period_end })
    const closing = fig.closing_amount
    const docNo = nextDocNo(db, 'DS', 'dealer_statements', 'doc_no')
    const info = db
      .prepare(
        `INSERT INTO dealer_statements (doc_no,dealer_id,period_start,period_end,opening_amount,sales_amount,return_amount,received_amount,closing_amount,status)
         VALUES (?,?,?,?,?,?,?,?,?,'draft')`
      )
      .run(docNo, dealer.id, period_start, period_end, fig.opening_amount, fig.sales_amount, fig.return_amount, fig.received_amount, closing)
    audit(req, { action: 'CREATE', module: 'dealer', entity: 'dealer_statements', entityId: info.lastInsertRowid })
    return ok(res, { id: info.lastInsertRowid, doc_no: docNo, closing_amount: closing })
  })
)

r.get(
  '/statements/:id',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const st = db
      .prepare('SELECT st.*, d.name AS dealer_name, d.code AS dealer_code, d.contact, d.phone FROM dealer_statements st JOIN dealers d ON d.id=st.dealer_id WHERE st.id=?')
      .get(Number(req.params.id))
    if (!st) return fail(res, '对账单不存在', 404)
    st.orders = db
      .prepare(
        `SELECT doc_no, order_date, status, receivable_amount, paid_amount FROM sales_orders
         WHERE dealer_id=? AND status NOT IN ('cancelled','draft') AND order_date BETWEEN ? AND ? ORDER BY order_date`
      )
      .all(st.dealer_id, st.period_start, st.period_end)
    st.returns = db
      .prepare(
        `SELECT doc_no, return_date, reason, total_amount FROM sales_returns
         WHERE dealer_id=? AND return_date BETWEEN ? AND ? ORDER BY return_date`
      )
      .all(st.dealer_id, st.period_start, st.period_end)
    return ok(res, st)
  })
)

// 确认 / 发送（`draft → confirmed → sent`）。流转逻辑在 `lib/dealer-statement.js` 的
// `setStatementStatus` —— **判据只有一份**，本路由只做鉴权与转发（与 close/void 同族）。
//
// 它曾经是一段裸 `UPDATE dealer_statements SET status=?`：状态变了、留痕一条没有。
// 而"这份对账单什么时候发给了客户"是下游一切的起点（客户收到 → 对账 → 结清），
// 查不到它怎么变成 sent，就等于这段历史不存在。现在走内核 `applyTransition()`，
// 同事务改状态 + 写 `doc_events`（只追加）。
// ⚠️ 一处行为收紧：原白名单含 `'draft'`（退回草稿），内核里 `confirmed → draft`
//    不是合法边；实测调用方只有 Statements.tsx（只传 confirmed / sent），详见 lib 注释。
r.post(
  '/statements/:id/status',
  requireAuth,
  // 权限**不动**（原来就是这三个角色）：判"谁能调这个端点"留在入口层，
  // 内核只管"这条边合不合法" —— 与 docflow 的分工一致（见其文件头）。
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const out = setStatementStatus(db, {
      id,
      actor: actorOf(req),
      status: req.body?.status,
      remark: req.body?.remark || null
    })
    audit(req, { action: 'UPDATE', module: 'dealer', entity: 'dealer_statements', entityId: id, detail: `${out.statement.status}（内核 ${out.transition.action}）` })
    return ok(res, { id, status: out.statement.status, transition: out.transition })
  })
)

// ---------- 对账单的两个终局动作：结清 / 作废 ----------
// 为什么不复用上面那个 `/status` 端点（把 closed / voided 也塞进它的映射表）：
//   ① **校验不同**。确认/发送只是改个状态；结清要校验"同主体同期间应收确实收齐"
//      （判据见 `lib/dealer-statement.js` 文件头第三节），作废要强制写理由。
//      合并后端点里会长出"按目标状态分支"的 if —— 而"合法流转是数据，不是散落的 if"
//      正是内核存在的理由。
//   ② **权限不同**。确认/发送用的是 `requireRole(sales/admin/finance)`，
//      结清/作废是 `finance.settle.edit`（动账结论，admin/boss/finance 持有）。
//      两组角色集合不同，合并只能取并集 ⇒ 等于把"能发送"的人一并授予"能结清"。
//   ③ **留痕理由不同**。两者现在都走内核（都写 `doc_events`），但只有终局动作
//      需要"理由"这个必填项，且理由要落到单据列（`close_reason` / `void_reason`）上。
//      （`/status` 本轮已改成走内核；它没有 closed/voided 两个目标，不与本组冲突。）
// ⚠️ `close` / `void` 是**独立字面段**，不是 `:action` 参数段：写成 `:action`
//    会被 `check-route-order.mjs` 判为"字面段被参数段吃掉"（接口存在、契约里有、
//    前端在调，却永远 404 —— 本项目踩过的坑）。
r.post(
  '/statements/:id/close',
  requireAuth,
  // 与内核对 DS 的 close 边（`008_doc_kernel.cjs` 的 perm_code）**同一个权限点**。
  // 路由层判权限、内核只管状态机合法性 —— 两处若用了不同的权限点，
  // 会出现"路由放行、内核拒绝"或反过来的错位。
  requirePerm('finance.settle.edit'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const out = closeStatement(db, {
      id,
      actor: actorOf(req),
      reason: req.body?.reason || null,
      force: req.body?.force === true || req.body?.force === '1'
    })
    audit(req, {
      action: out.forced ? 'STATEMENT_CLOSE_FORCED' : 'STATEMENT_CLOSE',
      module: 'dealer',
      entity: 'dealer_statements',
      entityId: id,
      detail: `期末应收 ${out.figures.closing_amount}｜${out.settled ? '已收齐' : '手动结清'}${
        req.body?.reason ? '｜' + req.body.reason : ''
      }`
    })
    return ok(res, out)
  })
)

// 作废对账单。
// ⚠️ **它只作废"这份对账单凭证"，不动底层应收台账** —— `sales_orders` /
//    `ar_documents` / `receipts` 分毫不动。客户不认这份对账单，不等于客户不用还钱；
//    那笔债权照样挂在应收上、照样计入账龄。真要"这笔钱不要了"是坏账核销（动应收单），
//    是另一个域的事。这句话同时写进 `lib/dealer-statement.js` 与 openapi 的 summary，
//    因为下一个维护者很自然会把它读成"作废整条债权"。
r.post(
  '/statements/:id/void',
  requireAuth,
  requirePerm('finance.settle.edit'),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const out = voidStatement(db, { id, actor: actorOf(req), reason: req.body?.reason || null })
    audit(req, {
      action: 'STATEMENT_VOID',
      module: 'dealer',
      entity: 'dealer_statements',
      entityId: id,
      detail: req.body?.reason || ''
    })
    return ok(res, out)
  })
)

// 信用额度维护与预警
r.post(
  '/:id/credit',
  requireAuth,
  requireRole(...W),
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const dealer = db.prepare('SELECT * FROM dealers WHERE id=?').get(id)
    if (!dealer) return fail(res, '经销商不存在', 404)
    const { credit_limit, credit_used, level, discount_rate, rebate_rate, status, settle_type } = req.body || {}
    // 信用额度 / 折扣 / 启停是高风险主数据变更：改动与**严格**留痕同一个事务，审计写不进就不改（ADR-0010）
    db.transaction(() => {
      db.prepare(
        `UPDATE dealers SET credit_limit=COALESCE(?,credit_limit), credit_used=COALESCE(?,credit_used), level=COALESCE(?,level),
          discount_rate=COALESCE(?,discount_rate), rebate_rate=COALESCE(?,rebate_rate), status=COALESCE(?,status), settle_type=COALESCE(?,settle_type)
         WHERE id=?`
      ).run(credit_limit ?? null, credit_used ?? null, level ?? null, discount_rate ?? null, rebate_rate ?? null, status ?? null, settle_type ?? null, id)
      auditStrict(req, {
        action: 'DEALER_CREDIT_UPDATE', module: 'dealer', entity: 'dealers', entityId: id,
        detail: {
          before: { credit_limit: dealer.credit_limit, credit_used: dealer.credit_used, level: dealer.level, discount_rate: dealer.discount_rate, rebate_rate: dealer.rebate_rate, status: dealer.status, settle_type: dealer.settle_type },
          patch: { credit_limit, credit_used, level, discount_rate, rebate_rate, status, settle_type }
        }
      })
    })()
    return ok(res, db.prepare('SELECT * FROM dealers WHERE id=?').get(id))
  })
)

// 经销商进货分析（进销存上报的简化版：按商品看经销商的进货结构）
r.get(
  '/:id/purchase-analysis',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const id = Number(req.params.id)
    const months = Number(req.query.months || 6)
    const byCategory = db
      .prepare(
        `SELECT COALESCE(c.name,'未分类') AS category_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN categories c ON c.id=p.category_id
         WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft')
           AND so.order_date >= date('now','localtime','-${months} month')
         GROUP BY c.id ORDER BY amount DESC`
      )
      .all(id)
    const byBrand = db
      .prepare(
        `SELECT COALESCE(b.name,'未标品牌') AS brand_name, SUM(i.qty) qty, SUM(i.amount) amount
         FROM sales_order_items i JOIN sales_orders so ON so.id=i.order_id
         JOIN product_skus sk ON sk.id=i.sku_id JOIN products p ON p.id=sk.product_id
         LEFT JOIN brands b ON b.id=p.brand_id
         WHERE so.dealer_id=? AND so.status NOT IN ('cancelled','draft')
           AND so.order_date >= date('now','localtime','-${months} month')
         GROUP BY b.id ORDER BY amount DESC`
      )
      .all(id)
    const trend = db
      .prepare(
        `SELECT substr(order_date,1,7) AS month, COALESCE(SUM(receivable_amount),0) amount, COUNT(*) orders
         FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft') GROUP BY month ORDER BY month DESC LIMIT ?`
      )
      .all(id, months)
    const returnRate = db
      .prepare(
        `SELECT
           COALESCE((SELECT SUM(receivable_amount) FROM sales_orders WHERE dealer_id=? AND status NOT IN ('cancelled','draft')),0) sales,
           COALESCE((SELECT SUM(total_amount) FROM sales_returns WHERE dealer_id=?),0) returns`
      )
      .get(id, id)
    return ok(res, { byCategory, byBrand, trend, returnRate })
  })
)

export default r
