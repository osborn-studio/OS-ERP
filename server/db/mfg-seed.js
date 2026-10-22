/**
 * ============================================================================
 * 文件标识：server/db/mfg-seed.js ｜ 生产制造演示数据（模块 10B · BOM / 领料 / 完工）
 * ============================================================================
 * 【职责】生产制造演示数据（模块 10B · BOM / 领料 / 完工）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

/**
 * 生产制造演示数据（模块 10B · BOM / 领料 / 完工）
 *
 * 与其它 seed 同一原则：**每一条数据都能讲一个故事**，而不是把表填满。
 * 造出来的东西必须能回答制造页上的五个问题：
 *   ① **BOM 长什么样？** 要有已审批的自制 BOM（含损耗率与替代组）、
 *      草稿（未审批，不能用来展开）、已作废（换版留下的旧版）、委外用途、组合装用途
 *      —— 「组合装并入统一 BOM」这条口径只有造出来才算落地。
 *   ② **一张订单真的能从展开跑到入库吗？** 至少一张订单走完整链并变成「已完工」，
 *      它的材料成本、人工、制费、单位成本都必须算得出来。
 *   ③ **在制看得见吗？** 留一张「领了料、只完工一部分」的，界面上的「剩余在制」才有数。
 *   ④ **中间态有样本吗？** 留一张「只领了一部分料、还没完工」的 —— 它同时又是
 *      「确实还有待领量」的样本（「新建领料单 → 按 BOM 自动装填」要拍的就是这张）。
 *   ⑤ **超额领料有痕迹吗？** 造一张「补料」单 —— 超领必须表现为补料，
 *      不能靠一张「正常领料」悄悄带过。
 *
 * 依赖：`production_orders`（第 19 步造的、状态至「生产中」）、原料库存、成品 SKU。
 * 全程 try/catch：库存可能不足、BOM 可能因唯一约束冲突，单条失败不该让整库 seed 崩掉。
 *
 * ⚠️ **但「吞掉」只允许用在「本来就该跳过」的情形**（唯一约束冲突之类）。
 * 造成「本该有的样本不见了」的失败必须**说出来**：下面 `makeBom` 返回 null 与
 * 建 BOM 抛异常都会记进 `out.bom_misses` 并在收尾一并打印 ——
 * 早先这里静默返回 null，结果是「第 6 张订单的成品没有 BOM」这种事
 * 只能从「制造页少了一张单」倒推，绕一大圈。（根因是原料窗口 `slice(offset, offset+4)`
 * 不回绕，第 6 个成品只剩 1 种可选的原料。）
 *
 * 关于可复现：所有时间走 `seedNow()`，取号一律**显式传业务日期**
 * （不传的话 `nextDocNo` 会用真实墙钟，两次重建的单号就会不同）。
 */
import { requireDemoDatabase } from './runtime-policy.js'
import { createBom, auditBom, obsoleteBom } from '../lib/bom.js'
import {
  startOrder, createIssue, transitionIssue,
  createWorkReport, completeOrder, planRequirement
} from '../lib/mfg.js'
import { seedNow } from './seed-clock.js'

const pad = (n) => String(n).padStart(2, '0')
const ymd = (d) => {
  const x = d instanceof Date ? d : new Date(d)
  return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`
}
const dayOffset = (n) => ymd(new Date(seedNow().getTime() + n * 86400000))

const ACTOR = { id: null, name: '演示数据' }

export function seedManufacture(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) console.log(m) }

  // 幂等：已经造过 BOM 就不再造（否则单号一直往后跑，演示数据越堆越多）
  if (db.prepare('SELECT COUNT(*) AS c FROM boms').get().c > 0) return { skipped: true }

  const out = {
    boms: 0, approved: 0, draft: 0, obsolete: 0, combo: 0, outsourced: 0,
    substitute_groups: 0, bom_misses: [],
    orders_completed: 0, orders_wip: 0, orders_issued_only: 0,
    issues: 0, issued_amount: 0, supplementary: 0,
    reports: 0, good_qty: 0, defect_qty: 0, stock_in_qty: 0, pending_reports: 0
  }

  const inprog = db
    .prepare("SELECT * FROM production_orders WHERE status='in_progress' ORDER BY id")
    .all()
  // BOM 是**主数据**，给全部生产订单的成品都建（不只是已开工的）：
  // 「净需求算出要自产、点进去却没有 BOM」是最该被看见的那种缺口，
  // 制造页的 `producible_without_bom` 就是数这个的 —— 只给开工的建，
  // 这个数就永远不为 0，指标失去意义。
  const allOrders = db.prepare('SELECT * FROM production_orders ORDER BY id').all()
  const selfSkus = db
    .prepare(
      `SELECT s.id, s.sku_code, s.name, s.cost_std
         FROM product_skus s JOIN products p ON p.id = s.product_id
        WHERE p.procurement_type = 'self' AND s.status = 'active'
        ORDER BY s.id`
    )
    .all()
  if (!selfSkus.length) return { skipped: true, reason: '没有自制成品的 SKU' }

  // -------------------------------------------------------------------------
  // 一、BOM 主数据
  // -------------------------------------------------------------------------

  /** 某仓有库存的原料（procurement_type='buy' 才可能是原料），按可用量降序 */
  const materialsOf = (warehouseId, limit = 8) =>
    db
      .prepare(
        `SELECT s.sku_id, k.sku_code, k.name, p.unit,
                SUM(s.qty_on_hand - s.qty_reserved) AS available
           FROM inventory_stocks s
           JOIN product_skus k ON k.id = s.sku_id
           JOIN products p ON p.id = k.product_id
          WHERE s.warehouse_id = ? AND p.procurement_type = 'buy'
            AND s.qty_on_hand > 0
          GROUP BY s.sku_id
         HAVING SUM(s.qty_on_hand - s.qty_reserved) > 0
          ORDER BY available DESC, s.sku_id
          LIMIT ?`
      )
      .all(warehouseId, limit)

  /**
   * 建一张 BOM。用量按**库存与订单数量反推**，保证领料时不会因库存不足而失败 ——
   * 演示数据的价值在于「能跑通」，而不是「真实到跑不通」。
   */
  const makeBom = (sku, whId, { usage = 'self_made', approve = true, obsolete = false, produceQty = 200, withSubstitute = true, offset = 0 } = {}) => {
    // 原料池取 8 种、按 `offset` **环形**取窗口。
    // 不回绕的话，第 N 个成品往后可选原料会越取越少，到第 6 个只剩 1 种 →
    // 函数返回 null → 那张订单的成品就永远没有 BOM（而这个失败当时是静默的）。
    const pool = materialsOf(whId, 8)
    if (pool.length < 2) return null
    const need = withSubstitute ? 4 : 2
    const mats = []
    for (let i = 0; i < need && i < pool.length; i += 1) mats.push(pool[(offset + i) % pool.length])
    if (mats.length < 2) return null
    // 用量 = 可用量 × 8% ÷ 生产数量。
    // 展开后**实际领走的量 = 可用量 × 8%**（与订单数量无关 —— 用量里已经把它除掉了），
    // 于是三张订单合计只吃掉约四分之一的原料。系数取 0.3 时三张就吃掉九成，
    // 后面那张必然「库存不足」—— 而演示数据失败在 seed 里只会被 try/catch 吞掉，
    // 表现成「制造页少了一张单」，查起来要绕一大圈。
    const per = (m) => Math.max(0.001, Math.round(((Number(m.available) * 0.08) / Math.max(1, produceQty)) * 1000) / 1000)
    const items = []
    if (withSubstitute && mats.length >= 3) {
      // 主料 + 替代料同组（替代组是本模块要演示的能力之一）
      items.push({ sku_id: mats[0].sku_id, qty: per(mats[0]), loss_rate: 0.05, substitute_group: '主料替代', priority: 0 })
      items.push({ sku_id: mats[1].sku_id, qty: per(mats[1]), loss_rate: 0.05, substitute_group: '主料替代', priority: 1 })
      items.push({ sku_id: mats[2].sku_id, qty: per(mats[2]), loss_rate: 0, remark: '不与任何料互为替代' })
    } else {
      items.push({ sku_id: mats[0].sku_id, qty: per(mats[0]), loss_rate: 0.03 })
      items.push({ sku_id: mats[1].sku_id, qty: per(mats[1]), loss_rate: 0 })
    }
    let bom
    try {
      bom = createBom(db, {
        productSkuId: sku.id, usage, baseQty: 1,
        effectiveFrom: dayOffset(-30),
        produceWay: usage === 'outsourced' ? 'outsourced' : 'self_made',
        warehouseId: whId, items, actor: ACTOR,
        remark: usage === 'combo' ? '组合装：卖的是组合，做的是这一套组件' : null
      })
    } catch (e) {
      // 唯一约束（一个母件一个用途一个 BOM）会挡住重复；演示场景直接跳过
      return null
    }
    out.boms += 1
    if (items.some((x) => x.substitute_group)) out.substitute_groups += 1
    if (approve) {
      try {
        bom = auditBom(db, { id: bom.id, actor: ACTOR, remark: '演示数据审批' })
        // 只把**当前仍生效**的计入 approved：作废那张也是「先审批后作废」，
        // 两边都计数会让「审批 6 + 草稿 1 + 作废 1 = 8」而库里只有 7 张。
        if (!obsolete) out.approved += 1
        if (usage === 'combo') out.combo += 1
        else if (usage === 'outsourced') out.outsourced += 1
      } catch { /* ignore */ }
    }
    if (obsolete) {
      try { bom = obsoleteBom(db, { id: bom.id, actor: ACTOR, remark: '换版：新版已建，旧版作废' }); out.obsolete += 1 } catch { /* ignore */ }
    }
    return bom
  }

  // 给「生产中」的成品各建一张已审批的自制 BOM —— 它们是后面跑链路的前提。
  // 组件按订单序号错开取（`offset`），避免几张 BOM 全压在同样那两三种原料上、
  // 领料时互相抢库存。
  const whOf = (po) => po.warehouse_id
  const bomBySku = new Map()
  for (const [i, po] of allOrders.entries()) {
    if (bomBySku.has(po.product_sku_id)) continue
    const sku = selfSkus.find((s) => s.id === po.product_sku_id)
    if (!sku) continue
    // offset 乘 3：原料窗口错开得开一点，几张 BOM 之间只重叠一两种料，
    // 领料时才不会互相抢库存（抢不过去的表现是 INSUFFICIENT_STOCK 被 try/catch 吞掉）。
    const bom = makeBom(sku, whOf(po), { produceQty: Number(po.qty) || 200, offset: i * 3 })
    if (bom) bomBySku.set(po.product_sku_id, bom)
    else out.bom_misses.push(`${po.doc_no}/${sku.sku_code}`)
  }

  // 另有用途的样本：草稿 / 换版作废 / 委外 / 组合装。
  // 这些成品**不在生产订单里**，纯粹用来演示 BOM 的多种形态与状态。
  const spare = selfSkus.filter((s) => !bomBySku.has(s.id))
  const whFallback =
    inprog[0]?.warehouse_id ||
    db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id
  if (spare[0] && whFallback) {
    const b = makeBom(spare[0], whFallback, { approve: false, withSubstitute: false })
    if (b) { out.draft += 1; say(`  BOM 草稿样本 ${b.code}（${spare[0].sku_code}，未审批不能展开）`) }
  }
  if (spare[1] && whFallback) {
    const b = makeBom(spare[1], whFallback, { approve: true, obsolete: true, withSubstitute: false })
    if (b) say(`  BOM 作废样本 ${b.code}（${spare[1].sku_code}，换版留下的旧版）`)
  }
  if (spare[2] && whFallback) {
    const b = makeBom(spare[2], whFallback, { usage: 'outsourced', approve: true, withSubstitute: false })
    if (b) say(`  BOM 委外样本 ${b.code}（${spare[2].sku_code}）`)
  }
  if (spare[3] && whFallback) {
    const b = makeBom(spare[3], whFallback, { usage: 'combo', approve: true, withSubstitute: false })
    if (b) say(`  BOM 组合装样本 ${b.code}（${spare[3].sku_code}，组合装并入统一 BOM）`)
  }

  if (!bomBySku.size) {
    say('  没有可用的自制 BOM，跳过制造链路造数')
    return { ...out, skipped_chain: true }
  }

  // -------------------------------------------------------------------------
  // 二、制造链路：领料 → 出库 → 完工汇报 → 完工入库
  // -------------------------------------------------------------------------

  // 只对前三张「生产中」的订单跑链路，三种收尾各留一个样本：
  //   idx 0 → 全流程完工（订单变「已完工」，成本归集完整）
  //   idx 1 → 部分完工（订单仍「生产中」，界面上「剩余在制」有数 + 留一张待入库汇报）
  //   idx 2 → 只领了 **60%** 的料、还没完工。刻意不领满，因为它要同时充当
  //           「确实还有待领量」的样本 —— 领满的话 `planRequirement` 返回空，
  //           「新建领料单 → 按 BOM 自动装填」这一屏就永远没有内容可看。
  const targets = inprog.slice(0, 3)
  const MODES = ['complete', 'partial', 'issue_partial']
  const DAY_OFFSETS = [8, 5, 3]
  for (const [idx, po] of targets.entries()) {
    const mode = MODES[idx] || 'issue_partial'
    const dayOff = DAY_OFFSETS[idx] || 3
    try {
      startOrder(db, { orderId: po.id, actor: ACTOR }) // 已是 in_progress 则幂等返回

      const req = planRequirement(db, { orderId: po.id })
      if (!req.lines.length) continue

      // issue_partial：只领 60%，留出待领量。
      // 把它做成「一张按 60% 的领料单」而不是「全领 + 退料」：本模块没有退料单，
      // 退料要另开单据，造擦边样本只会让演示数据看起来像错的。
      const ratio = mode === 'issue_partial' ? 0.6 : 1
      const items = ratio === 1
        ? null
        : req.lines.map((l) => ({
            sku_id: l.sku_id,
            qty: Math.max(0.001, Math.round(Number(l.pending_qty) * ratio * 1000) / 1000)
          }))
      let issue = createIssue(db, {
        orderId: po.id, warehouseId: po.warehouse_id, issueType: 'by_bom',
        issueDate: dayOffset(-dayOff), actor: ACTOR, items,
        remark: ratio === 1 ? '按 BOM 展开领料' : '分批领料：本批先领 60%，其余待生产进度再领'
      })
      issue = transitionIssue(db, { id: issue.id, action: 'submit', actor: ACTOR })
      issue = transitionIssue(db, { id: issue.id, action: 'approve', actor: ACTOR })
      issue = transitionIssue(db, { id: issue.id, action: 'issue', actor: ACTOR })
      out.issues += 1
      out.issued_amount += Number(issue.total_amount || 0)
      say(`  领料出库 ${issue.doc_no}（订单 ${po.doc_no}，${issue.items.length} 行，金额 ${issue.total_amount}）`)

      // 补料样本：**必须排在完工之前**。
      // 完工后订单变成「已完工」，而领料要求订单处于「生产中」——
      // 放到循环外面给已完工的订单开补料单，会被状态校验挡掉，
      // 而挡住只会留下一条日志，界面上表现成「补料样本不见了」。
      if (idx === 0) {
        const line = planRequirement(db, { orderId: po.id, includeIssued: true }).lines[0]
        if (line) {
          const supQty = Math.max(0.001, Math.round(Number(line.qty) * 0.02 * 1000) / 1000)
          let sup = createIssue(db, {
            orderId: po.id, warehouseId: po.warehouse_id, issueType: 'supplement',
            issueDate: dayOffset(-dayOff + 1),
            items: [{ sku_id: line.sku_id, batch_no: line.batch_no || '', plan_qty: supQty, qty: supQty }],
            remark: '部分原料在熟制环节损耗超预期，补领',
            actor: ACTOR
          })
          sup = transitionIssue(db, { id: sup.id, action: 'submit', actor: ACTOR })
          sup = transitionIssue(db, { id: sup.id, action: 'approve', actor: ACTOR })
          sup = transitionIssue(db, { id: sup.id, action: 'issue', actor: ACTOR })
          out.issues += 1
          out.supplementary += 1
          out.issued_amount += Number(sup.total_amount || 0)
          say(`  补料单 ${sup.doc_no}（${supQty} ${line.unit || ''}，原因已记录）`)
        }
      }

      if (mode === 'issue_partial') { out.orders_issued_only += 1; continue }

      // 完工汇报：良品占订单数量的一部分，另留约 4% 不良（不良率在界面上要看得见）
      const goodQty = mode === 'complete' ? Number(po.qty) : Math.max(1, Math.round(Number(po.qty) * 0.6))
      const defectQty = Math.max(1, Math.round(goodQty * 0.04))
      const hours = Math.round(goodQty * 0.05)
      const wr = createWorkReport(db, {
        orderId: po.id, issueId: issue.id,
        reportDate: dayOffset(-dayOff + 2),
        processName: ['熟制', '分装', '质检包装'][idx % 3],
        goodQty, defectQty, workHours: hours, laborRate: 42,
        overheadCost: Math.round(goodQty * 1.5),
        actor: ACTOR, remark: mode === 'partial' ? '本批先完工一部分' : null
      })
      out.reports += 1
      out.good_qty += goodQty
      out.defect_qty += defectQty

      const done = completeOrder(db, { orderId: po.id, reportId: wr.id, actor: ACTOR })
      out.stock_in_qty += done.stock_in_qty
      if (mode === 'complete') out.orders_completed += 1
      else out.orders_wip += 1
      say(
        `  完工入库 ${wr.doc_no} → ${done.stock_in_qty} 件（材料 ${done.material_cost} + 转换 ${done.conversion_cost}），` +
        `订单状态 ${done.order.status}`
      )
      if (mode === 'partial') {
        // 「部分完工」样本再多登记一张**待入库**的汇报，且**不**入库。
        // 为什么必须留一张待入库的：`pending_stock_in` 恒为 0 的话，
        // 界面上「完工入库」按钮永远是灰的 —— 制造链最有代表性的一步在演示库里没法演示，
        // 截图也只能拍到一张没有内容的列表。而它不入库也不会让审计变红：
        // 未入库的汇报不参与「完工数 vs 已入库良品」的比对，也不参与「已入库必须有流水」的检查。
        const pendingQty = Math.max(1, Math.round(Number(po.qty) * 0.3))
        createWorkReport(db, {
          orderId: po.id, issueId: issue.id,
          reportDate: dayOffset(-dayOff + 3),
          processName: '分装',
          goodQty: pendingQty, defectQty: 1,
          workHours: Math.round(pendingQty * 0.05), laborRate: 42,
          overheadCost: Math.round(pendingQty * 1.5),
          actor: ACTOR, remark: '已完工待入库（用来演示「完工入库」这一步）'
        })
        out.reports += 1
        out.good_qty += pendingQty
        out.pending_reports += 1
        say(`  完工汇报（待入库）${po.doc_no} → 良品 ${pendingQty} 件，等待入库`)
      }
    } catch (e) {
      say(`  [manufacture] 订单 ${po.doc_no} 造数跳过：${e.message}`)
    }
  }

  if (out.bom_misses.length) {
    // 说清楚而不是咽下去：这一行如果出现，说明「有订单的成品没建出 BOM」，
    // 制造页的「能生产但没 BOM」会不为 0，而且后续链路样本会缺。
    say(`  ⚠ [manufacture] 以下订单的成品没能建出 BOM（会影响链路样本）：${out.bom_misses.join('、')}`)
  }
  say(`制造演示数据：BOM ${out.boms} 张（审批 ${out.approved} / 草稿 ${out.draft} / 作废 ${out.obsolete}）· ` +
      `领料 ${out.issues} 张（补料 ${out.supplementary}）· 完工汇报 ${out.reports} 张（待入库 ${out.pending_reports}）· ` +
      `完工入库 ${out.stock_in_qty} 件`)
  return out
}

export default { seedManufacture }
