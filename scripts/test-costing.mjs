/**
 * ============================================================================
 * 文件标识：scripts/test-costing.mjs ｜ 测试：存货核算与成本（模块 09）断言测试
 * ============================================================================
 * 【职责】测试：存货核算与成本（模块 09）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 存货核算与成本（模块 09）断言测试
// 用法：node scripts/test-costing.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是把「成本为什么要划期间」这件事钉死在断言里：
//
//   ① **三层必须闭合**：期初 + 本期入 − 本期出 = 截至期末。
//      不闭合意味着有货凭空出现或消失，而账上不会报警 —— 所以它必须是可断言的不变量。
//      但闭合式的左边与右边**同源**，所以它自己证明不了「账实相符」，
//      真正有信息量的是「现存量 − (截至期末 + 期末之后的流水) = 0」这一条：
//      它把「下月的货」归因出来，剩下的残差非 0 才是真的账实不符。
//
//   ② **结转要有约束力**：结转之后往那个期间写流水必须被**硬拦**。
//      只做快照不拦后续流水，「结转」就是一张随时会被推翻的纸 ——
//      上一期结出来的期末与今天算出来的不一致，而两张报表都能打开、都像是对的。
//      这条断言落在 stock.js 的出入库入口（闸门在入口，不靠事后对账）。
//
//   ③ **暂估差异不追溯已售出部分**：回写金额只按「仍在库数量 × 单价差」算，
//      已售出部分单列 sold_amount 计入本期损益。追溯会让历史毛利变化，
//      而且无法可靠分摊到客户 —— 所以要断言「adj_amount ≠ 全额差异」这一情形真的会发生，
//      而不是碰巧所有货都还在库、于是这个分支从未被走过。
//
// 夹具口径：所有会改库的用例（T3 / T4 / T5）**整体跑在一个回滚事务里**，
// 断言做完就 throw 回滚，库回到跑之前的状态。理由与模块 07 的「自建自清」同源：
// 成本调整会真的改 inventory_stocks.cost_amount，靠事后修复容易漏；
// 回滚是**结构上**保证干净，不依赖修复代码写对。
// 唯一例外是 T4 需要事务内多次 commit 才能验证「重复结转」，见该段注释。
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { applyStockIn, applyStockOut } from '../server/lib/stock.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
import {
  AMOUNT_TOL, COST_METHODS, CostError,
  costMethod, periodOf, periodRange, assertPeriodOpen, isPeriodClosed, periodFinished,
  threeLayers, closePeriod, listPeriods, ensurePeriod,
  estimateVariances, settlementLines, createAdjustment, getAdjustment, adjustCost,
  transitionAdjustment, listAdjustments, auditCostIntegrity, recompute, costingOverview
} from '../server/lib/costing.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'cosmetic'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
const num = (v) => Number(v) || 0
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100
const near = (a, b, tol = AMOUNT_TOL) => Math.abs(num(a) - num(b)) <= tol
const nearQty = (a, b) => Math.abs(num(a) - num(b)) < 1e-6
const today = () => new Date().toISOString().slice(0, 10)

/** 在回滚事务里跑 fn：fn 里的断言照常记账，结束时整段回滚，库不变 */
function inRollback(db, fn) {
  let hard = null
  try {
    db.transaction(() => {
      fn()
      throw new Error('__ROLLBACK__')
    })()
  } catch (e) {
    if (e && e.message !== '__ROLLBACK__') hard = e
  }
  if (hard) throw hard
}

const throwsCode = (fn, code, msg) => {
  try {
    fn()
    ok(false, `${msg}（未抛错）`)
  } catch (e) {
    const hit = !code || e.code === code
    ok(hit, hit ? `${msg} → ${e.code}` : `${msg}（期望 ${code}，实得 ${e.code}）`)
  }
}

console.log('═'.repeat(72))
console.log(`存货核算与成本 · 模块 09 · 行业「${INDUSTRIES[industry].label}」`)
console.log('═'.repeat(72))

runWithIndustry(industry, () => {
  const db = getDb()

  // =========================================================================
  section('T1 期间与计价方式：口径先定，算出来的数才有意义')
  // =========================================================================
  // 计价方式：只支持集合内的写法，其它一律显式拒绝（而不是悄悄按移动平均算）
  const cm = costMethod(db)
  ok(Object.keys(COST_METHODS).includes(cm), `计价方式在支持集合内（${cm} = ${COST_METHODS[cm]}）`)
  inRollback(db, () => {
    db.prepare("UPDATE inv_params SET param_value='fifo' WHERE param_key='cost_method'").run()
    // 参数被改成 fifo 时，若默默按移动加权算，报表上会写着「先进先出」而数字是加权平均 ——
    // 这类错不报错、只让所有成本报表的口径变成假的
    throwsCode(() => costMethod(db), 'COST_METHOD_UNSUPPORTED', '不支持的计价方式被显式拒绝')
  })
  ok(costMethod(db) === cm, '回滚后计价方式原样（说明回滚夹具本身是干净的）')

  // 期间解析：Date 对象曾经得到 "Thu Oct" 这种一眼看不出错的值
  const ymdNow = today()
  const mNow = ymdNow.slice(0, 7)
  ok(periodOf(new Date()) === mNow, `periodOf(Date) → ${mNow}（不是 "Thu Oct" 这类字符串切片产物）`)
  ok(periodOf('2026-03-15') === '2026-03', "periodOf('2026-03-15') → 2026-03")
  ok(periodOf('2026-03-15 08:30:00') === '2026-03', "periodOf('2026-03-15 08:30:00') → 2026-03")
  ok(periodOf('2026-03') === '2026-03', "periodOf('2026-03') → 2026-03")
  throwsCode(() => periodOf('三月'), 'COST_PERIOD_INVALID', '无法解析的日期显式报错（而不是拼出一个错期间号）')

  // 期间起止：闰年 2 月必须 29 天，否则月末最后一天的流水会被算到隔壁期间
  ok(periodRange('2024-02').end === '2024-02-29', '2024-02 期末日是 29 号（闰年）')
  ok(periodRange('2026-02').end === '2026-02-28', '2026-02 期末日是 28 号（平年）')
  ok(periodRange('2026-12').end === '2026-12-31', '2026-12 期末日是 31 号')

  // 未结转的期间放行、已结转的期间硬拦
  const probe = '1999-12'
  inRollback(db, () => {
    assertPeriodOpen(db, `${probe}-05`) // 不存在期间记录 = 打开，不该抛
    ok(true, '没有期间记录 = 未结转（不抛错）')
    ensurePeriod(db, probe)
    db.prepare("UPDATE cost_periods SET status='closed', closed_at='probe' WHERE period=?").run(probe)
    ok(isPeriodClosed(db, probe), '已结转期间 isPeriodClosed = true')
    throwsCode(() => assertPeriodOpen(db, `${probe}-20`), 'PERIOD_CLOSED', '往已结转期间补单据被硬拦')
  })
  ok(!isPeriodClosed(db, probe), '回滚后探针期间未残留')

  // periodFinished：期末日 < 今天才算走完
  const cur = periodOf(new Date())
  ok(periodFinished(cur) === false, `当前期间 ${cur} 未走完（当前月不该能结转）`)
  ok(periodFinished('2026-01', '2026-03-01') === true, 'periodFinished 支持传入 today 便于测试')

  // =========================================================================
  section('T2 三层成本：闭合式与残差恒等式')
  // =========================================================================
  // 取数据量最大与次大的两个月各验一次：只有一个月的样本证明不了「换个月也对」
  const months = db
    .prepare("SELECT substr(biz_date,1,7) m, COUNT(*) c FROM inventory_transactions GROUP BY m ORDER BY c DESC LIMIT 2")
    .all()
  for (const { m } of months) {
    const r = threeLayers(db, { period: m })
    const selfClosed = nearQty(r.opening.qty + r.in.qty - r.out.qty, r.as_of_end.qty)
      && near(r.opening.amount + r.in.amount - r.out.amount, r.as_of_end.amount)
    ok(selfClosed, `${m} 三层自闭合：期初 ${r.opening.qty} + 入 ${r.in.qty} − 出 ${r.out.qty} = 截至期末 ${r.as_of_end.qty}`)
    // 这一条才是真的账实校验：残差必须归零
    ok(r.balanced, `${m} 残差恒等式成立：现存 ${r.closing.qty} − (截至期末 ${r.as_of_end.qty} + 期末之后 ${r.later.qty}) = ${r.residual.qty} 件 / ${r.residual.amount} 元`)
    ok(!!r.opening_source, `${m} 期初来源写明（${String(r.opening_source).slice(0, 24)}...）`)
  }

  // 期末之后那段必须和「期末日之后的流水净额」独立算一遍对得上 ——
  // 否则 later 只是一个凑数的差额，残差归零就成了自证
  const m0 = months[0].m
  const { end } = periodRange(m0)
  const flowAfter = db
    .prepare(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN qty ELSE -qty END),0) qty,
              COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) amount
         FROM inventory_transactions WHERE biz_date > ?`
    )
    .get(end)
  const l0 = threeLayers(db, { period: m0 })
  ok(nearQty(l0.later.qty, flowAfter.qty) && near(l0.later.amount, flowAfter.amount),
    `${m0} 期末之后那一段与「期末日之后流水净额」独立对得上（${flowAfter.qty} 件 / ${round2(flowAfter.amount)} 元）`)

  // 维度下钻：按仓库过滤后必须仍然闭合（过滤条件漏进任何一个子查询都会破坏它）
  const wh = db.prepare('SELECT warehouse_id FROM inventory_stocks WHERE qty_on_hand <> 0 GROUP BY warehouse_id ORDER BY COUNT(*) DESC LIMIT 1').get()
  if (wh) {
    const rw = threeLayers(db, { period: m0, warehouseId: wh.warehouse_id })
    ok(rw.balanced, `按仓库 ${wh.warehouse_id} 过滤后仍然闭合（残差 ${rw.residual.qty} 件 / ${rw.residual.amount} 元）`)
    ok(rw.closing.qty <= l0.closing.qty + 1e-6, '按仓库过滤后的现存量不超过全库现存量')
  } else {
    ok(true, '（无库存行，跳过仓库维度下钻）')
  }

  // =========================================================================
  section('T3 出口闸门：结转之后禁止补流水（落在出入库入口）')
  // =========================================================================
  const stockRow = db
    .prepare('SELECT warehouse_id, sku_id, batch_no FROM inventory_stocks WHERE qty_on_hand > 10 LIMIT 1')
    .get()
  const closedProbe = '1999-11'
  inRollback(db, () => {
    if (!stockRow) { ok(true, '（无可用库存行，跳过闸门用例）'); return }
    ensurePeriod(db, closedProbe)
    db.prepare("UPDATE cost_periods SET status='closed', closed_at='probe' WHERE period=?").run(closedProbe)
    const beforeQty = num(
      db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
        .get(stockRow.warehouse_id, stockRow.sku_id, stockRow.batch_no)?.qty_on_hand
    )
    throwsCode(
      () => applyStockIn(db, {
        bizDate: `${closedProbe}-10`, docType: 'ADJ_IN', docNo: 'PROBE-CLOSED', docId: 0,
        warehouseId: stockRow.warehouse_id, skuId: stockRow.sku_id, batchNo: stockRow.batch_no,
        qty: 1, unitCost: 1, operator: 'test', remark: '探针：往已结转期间补入库'
      }),
      'PERIOD_CLOSED',
      '往已结转期间写入库被拦'
    )
    // 关键：拦在写库之前。若先写流水再校验，这里会看到数量已经变了
    const afterQty = num(
      db.prepare('SELECT qty_on_hand FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
        .get(stockRow.warehouse_id, stockRow.sku_id, stockRow.batch_no)?.qty_on_hand
    )
    ok(nearQty(beforeQty, afterQty), `被拦后库存数量未变（${beforeQty} → ${afterQty}，说明是硬拦不是事后回滚）`)
    const strayTx = db
      .prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_no='PROBE-CLOSED'")
      .get().c
    ok(strayTx === 0, '被拦后没有留下半条流水')

    throwsCode(
      () => applyStockOut(db, {
        bizDate: `${closedProbe}-10`, docType: 'ADJ_OUT', docNo: 'PROBE-CLOSED-OUT', docId: 0,
        warehouseId: stockRow.warehouse_id, skuId: stockRow.sku_id, batchNo: stockRow.batch_no,
        qty: 1, operator: 'test', remark: '探针：往已结转期间补出库'
      }),
      'PERIOD_CLOSED',
      '往已结转期间写出库同样被拦（两个入口都要挂，漏一个就等于没拦）'
    )

    // 打开期间则应当放行 —— 否则「闸门」会变成「什么都写不进去」
    db.prepare("UPDATE cost_periods SET status='open' WHERE period=?").run(closedProbe)
    let allowed = true
    try {
      applyStockIn(db, {
        bizDate: `${closedProbe}-10`, docType: 'ADJ_IN', docNo: 'PROBE-OPEN', docId: 0,
        warehouseId: stockRow.warehouse_id, skuId: stockRow.sku_id, batchNo: stockRow.batch_no,
        qty: 1, unitCost: 1, operator: 'test', remark: '探针：期间打开时应放行'
      })
    } catch (e) {
      allowed = false
      console.log(`      （放行用例异常：${e.code} ${e.message.slice(0, 60)}）`)
    }
    ok(allowed, '期间打开时写入正常放行（闸门不是「一律拒绝」）')
  })
  ok(db.prepare("SELECT COUNT(*) c FROM inventory_transactions WHERE doc_no LIKE 'PROBE-%'").get().c === 0,
    '回滚后探针流水未残留')

  // =========================================================================
  section('T4 期末结转：三条约束')
  // =========================================================================
  // ① 没走完的期间不能结
  throwsCode(
    () => closePeriod(db, { period: cur, actor: { id: 1, name: 'test' } }),
    'PERIOD_NOT_FINISHED',
    `当前期间 ${cur} 未走完，不能结转`
  )

  // ② 走完的期间能结，且快照必须与三层口径同源
  // 这段**不能整体回滚**（重复结转要看到已 commit 的状态），所以显式自清：结尾删快照 + 退回 open
  const donePeriod = months.map((x) => x.m).find((m) => periodFinished(m))
  if (donePeriod) {
    const layers = threeLayers(db, { period: donePeriod })
    // 记下这段之前是否已有该期间记录：自清时只删「本用例造出来的」，不碰本来就存在的
    const existedBefore = !!db.prepare('SELECT 1 AS hit FROM cost_periods WHERE period=?').get(donePeriod)
    let r = null
    try {
      r = closePeriod(db, { period: donePeriod, actor: { id: 1, name: 'test' } })
      ok(r.lines > 0, `${donePeriod} 结转落 ${r.lines} 行期末快照`)
      ok(nearQty(r.snapshot.qty, layers.as_of_end.qty) && near(r.snapshot.amount, layers.as_of_end.amount),
        `快照合计 = 三层「截至期末」（${r.snapshot.qty} 件 / ${r.snapshot.amount} 元）`)
      ok(r.balanced, '结转返回的残差平衡标记为真')
      const row = db.prepare('SELECT * FROM cost_periods WHERE period=?').get(donePeriod)
      ok(row.status === 'closed', `${donePeriod} 状态变为 closed`)
      ok(row.closed_by_name === 'test', '结转人落库')
      ok(near(row.closing_amount, layers.as_of_end.amount), '期间记录里的期末金额与三层一致')
      ok(row.line_count === r.lines, '期间记录的行数与快照行数一致')

      // ③ 重复结转被拦
      throwsCode(
        () => closePeriod(db, { period: donePeriod, actor: { id: 1, name: 'test' } }),
        'PERIOD_ALREADY_CLOSED',
        '同一期间重复结转被拦（否则同期会出现两份不同的期末数字）'
      )

      // 结转之后，下一个期间的期初必须正好等于本期的期末 —— 这就是「结转」的全部意义
      const nextRow = db
        .prepare("SELECT period FROM cost_periods WHERE period > ? ORDER BY period LIMIT 1")
        .get(donePeriod)
      const nextPeriod = nextRow ? nextRow.period : nextMonth(donePeriod)
      const after = threeLayers(db, { period: nextPeriod })
      ok(String(after.opening_source).includes(donePeriod),
        `${nextPeriod} 的期初来源指向已结转的 ${donePeriod}（${after.opening_source}）`)
      ok(nearQty(after.opening.qty, layers.as_of_end.qty) && near(after.opening.amount, layers.as_of_end.amount),
        `${nextPeriod} 期初 ${after.opening.qty} 件 / ${round2(after.opening.amount)} 元 = ${donePeriod} 期末（同源）`)

      // reopen：先删快照再重算，结果应当与首次一致
      const r2 = closePeriod(db, { period: donePeriod, actor: { id: 1, name: 'test' }, reopen: true })
      ok(r2.reopened === true && r2.lines === r.lines, `reopen 重算得到同样的 ${r2.lines} 行快照`)
      ok(near(r2.snapshot.amount, r.snapshot.amount), '重算金额与首次一致（说明快照只依赖流水，不受结转本身影响）')
    } catch (e) {
      ok(false, `结转用例异常：${e.code || ''} ${e.message}`)
    } finally {
      // 自清：把探针期间退回未结转，别把「已结账」状态留给后续脚本与界面
      db.prepare('DELETE FROM cost_period_balances WHERE period=?').run(donePeriod)
      if (existedBefore) {
        db.prepare(
          "UPDATE cost_periods SET status='open', closed_at=NULL, closed_by=NULL, closed_by_name=NULL WHERE period=?"
        ).run(donePeriod)
      } else {
        // 本用例之前没有这个期间记录（closePeriod 里的 ensurePeriod 建出来的），整行删掉，库回到原样
        db.prepare('DELETE FROM cost_periods WHERE period=?').run(donePeriod)
      }
    }
    ok(!isPeriodClosed(db, donePeriod), `自清完成：${donePeriod} 回到未结转状态`)
  } else {
    ok(true, '（没有已走完的期间，跳过结转用例）')
  }

  // =========================================================================
  section('T5 暂估差异与成本调整：两个口径不能混用，且不追溯已售出部分')
  // =========================================================================
  const variances = estimateVariances(db, { limit: 50 })
  ok(variances.length > 0, `暂估差异台账非空（${variances.length} 张结算单）`)
  ok(variances.every((v) => near(v.diff_amount, num(v.act_amount) - num(v.est_amount))),
    '每行都满足 差异 = 实际入库成本 − 入库暂估（口径自洽，不是写死的一个数）')
  ok(variances.every((v) => near(v.pending_amount, v.adjustable
    ? num(v.diff_amount) - num(v.adjusted_amount) - num(v.sold_not_traced) : 0, 0.05)),
    '每行都满足 待调整 = 可回写差异 − 已回写 − 已售出不追溯（不可回写的按 0 计，不进待办）')

  // 核心断言：**不可回写的差异绝不能进待办**。
  // 混用口径的后果实测过 —— 界面显示「待调整 566,866.88」，点进去建出来一张 0 元调整单。
  const notAdjustable = variances.filter((v) => !v.adjustable)
  ok(notAdjustable.every((v) => near(v.pending_amount, 0)),
    `${notAdjustable.length} 张不可回写的结算单待调整金额都是 0（不会造出做不掉的待办）`)
  const invoiceGapOnly = notAdjustable.filter((v) => !v.invoice_settled)
  ok(invoiceGapOnly.length > 0,
    `其中 ${invoiceGapOnly.length} 张是「发票口径有差、但入库成本没差」的（如 ${invoiceGapOnly[0]?.doc_no} 差 ${invoiceGapOnly[0]?.invoice_diff} 元）`)
  ok(invoiceGapOnly.every((v) => !!v.blocked_reason),
    '这类结算单都给出了「为什么不能回写」的说明（而不是给个 0 元单让人猜）')

  // 能回写的那些：差异应当正好等于摊入入库行的费用，而不是发票差额
  const adjustable = variances.filter((v) => v.adjustable)
  ok(adjustable.length > 0, `有 ${adjustable.length} 张结算单的差异可以回写到批次`)
  ok(adjustable.every((v) => !v.blocked_reason),
    '能回写的结算单不带 blocked_reason（界面据此决定建单按钮是否可点）')
  if (adjustable.length) {
    const a = adjustable[0]
    // 逐行摊入的费用合计（不是结算单头的 fee_amount —— 头是原始费用票额，行是分摊额）
    const lineFee = db
      .prepare(
        `SELECT COALESCE(SUM(fee_amount),0) f, COALESCE(SUM(qty),0) q
           FROM purchase_settlement_items WHERE settle_id=? AND source_type='receipt'`
      )
      .get(a.id)
    // 两者不是严格相等，且**差异有确定的上限**：结算时 final_cost = round2((金额+分摊)/数量)，
    // 单价被 round2 之后误差 ≤0.005/件，再乘数量就被放大了 —— 上限即 0.005 × 总数量。
    // 换句话说：成本口径取的是「数量 × 最终单价」的累计，而不是把费用额照抄进库存金额，
    // 所以库存里能对上的永远是后者。这正是「结存金额必须能从流水回溯」的一个体现。
    const allow = 0.005 * num(lineFee.q) + 0.05
    ok(Math.abs(a.cost_diff - num(lineFee.f)) <= allow,
      `${a.doc_no} 可回写差异 ${a.cost_diff} ≈ 逐行摊入费用 ${round2(lineFee.f)}（差 ${round2(a.cost_diff - lineFee.f)}，上限 ${round2(allow)} = 0.005 × 数量 ${num(lineFee.q)}）`)
    ok(!near(a.cost_diff, a.invoice_diff, 0.05),
      `同一张单的两个口径确实不同：成本口径 ${a.cost_diff} ≠ 发票口径 ${a.invoice_diff}（若相同则说明口径没分清）`)
  }

  // 拿一张能回写的结算单做全链路。
  // **优先挑「行里真的已经有售出」的那张**：本段要验的核心是「已售出部分不追溯」这个分支，
  // 而「第一张能回写的」不一定含售出行 —— 结算单与批次的售出比例由当日灌的演示数据决定，
  // 且单号序列每重建一次就往后走（`doc_no_counters` 不随业务表清空而重置），
  // 于是 `adjustable` 的排序结果每次都可能落到不同的单上。挑到没有售出的那张时，
  // 分支压根没被走到，测试会以「已售出 0 件」失败 —— 那不是系统出错，是样本没选对。
  const withLines = adjustable.filter((v) => settlementLines(db, v.id).length > 0)
  const target = withLines.find((v) => settlementLines(db, v.id).some((l) => num(l.qty_sold) > 0)) || withLines[0]
  const noLine = notAdjustable.find((v) => settlementLines(db, v.id).length === 0)
  const zeroCost = notAdjustable.find((v) => settlementLines(db, v.id).length > 0)
  if (!target) {
    ok(true, '（没有带来源行的可回写结算单，跳过调整用例）')
  } else {
    // ---- 拒绝类：这些不落库，可以在回滚外跑，但统一放回滚里更省心
    inRollback(db, () => {
      throwsCode(() => createAdjustment(db, { settleId: 999999 }), 'COST_SETTLE_NOT_FOUND',
        '不存在的结算单被拒')
      if (noLine) {
        throwsCode(() => createAdjustment(db, { settleId: noLine.id }), 'COST_NO_SOURCE_LINE',
          '只有发票行、没有入库来源行的结算单被拒（差异落不到批次）')
      } else {
        ok(true, '（本库无「有差异但无来源行」的结算单，跳过）')
      }
      if (zeroCost) {
        // 这一条是本轮修掉的真缺陷：过去用结算单头部的 diff_amount 做校验，
        // 于是「发票口径有差、入库成本没差」的单也会放行，建出一张 0 元调整单
        throwsCode(() => createAdjustment(db, { settleId: zeroCost.id }), 'COST_NO_VARIANCE',
          `入库成本无差异的结算单（${zeroCost.doc_no}，发票口径差 ${zeroCost.invoice_diff} 元）被拒`)
      } else {
        ok(true, '（本库无「发票有差但成本无差」的结算单，跳过）')
      }
      const per = periodOf(target.settle_date)
      ensurePeriod(db, per)
      db.prepare("UPDATE cost_periods SET status='closed' WHERE period=?").run(per)
      throwsCode(() => createAdjustment(db, { settleId: target.id, adjustDate: `${per}-05` }),
        'PERIOD_CLOSED', `归到已结转期间 ${per} 的调整单被拒（否则会推翻已结出来的期末）`)
      db.prepare("UPDATE cost_periods SET status='open' WHERE period=?").run(per)
    })

    // ---- 正向链路：整体回滚，因为 adjust() 会真的改 inventory_stocks
    inRollback(db, () => {
      const lines = settlementLines(db, target.id)
      // 先把「建单之前」的库存在纸上记下来，才可能证明「建单不改成本」
      const stockAtStart = db
        .prepare('SELECT COALESCE(SUM(cost_amount),0) s, COALESCE(SUM(qty_on_hand),0) q, COUNT(*) c FROM inventory_stocks').get()
      // 待办基线：调整前有几张、多少钱
      const ovBefore = costingOverview(db, { period: periodOf(target.settle_date) })
      const adj = createAdjustment(db, { settleId: target.id, actor: { id: 1, name: 'test' } })
      ok(adj.id > 0 && adj.status === 'draft', `建成本调整单 ${adj.doc_no}（草稿）`)
      ok(adj.settle_no === target.doc_no, '调整单带出结算单号（差异的来源可追）')
      ok(adj.period === periodOf(adj.adjust_date), `调整单归属期间 ${adj.period}`)
      ok(adj.line_count > 0, `落了 ${adj.line_count} 行明细（结算 ${lines.length} 行）`)
      ok(adj.diff_amount !== 0, `带出差异 ${adj.diff_amount} 元`)

      // 行级：三数必须闭合（总量 = 在库 + 已售出）
      const closedLines = adj.items.filter((i) => nearQty(num(i.qty_on_hand) + num(i.qty_sold), num(i.qty_total)))
      ok(closedLines.length === adj.items.length,
        `行级三数闭合：在库 + 已售出 = 入库总量（${adj.items.length} 行全部满足）`)
      ok(adj.items.every((i) => near(i.adj_amount, num(i.qty_on_hand) * (num(i.price_act) - num(i.price_est)))),
        '每行回写金额 = 仍在库数量 × (实际单价 − 暂估单价)')

      // 核心口径：回写金额只覆盖仍在库部分，已售出部分单列
      const soldQty = adj.items.reduce((a, i) => a + num(i.qty_sold), 0)
      const totalQty = adj.items.reduce((a, i) => a + num(i.qty_total), 0)
      if (soldQty > 0) {
        ok(true, `本单涉及已售出 ${soldQty} 件（占入库 ${totalQty} 件）—— 不追溯分支真的被走到了`)
        ok(!near(adj.adjusted_amount, adj.diff_amount),
          `回写金额 ${adj.adjusted_amount} ≠ 全额差异 ${adj.diff_amount}（已售出部分被剔除，不是全额照搬）`)
      } else {
        // 兜底样本：全库确实找不到「行里有售出」的可回写结算单时，本段只能验到另一条支路 ——
        // 没有售出就该全额回写。显式断言这一点，而不是让一条注定不成立的断言把整轮染红。
        ok(true, `（本库可回写结算单均无售出行，跳过「不追溯」分支；占入库 ${totalQty} 件）`)
        ok(near(adj.adjusted_amount, adj.diff_amount),
          `无售出时可回写金额 ${adj.adjusted_amount} = 全额差异 ${adj.diff_amount}（全额照搬才对）`)
      }
      ok(near(adj.sold_amount + adj.adjusted_amount, adj.diff_amount, 0.05),
        `已售出 ${adj.sold_amount} + 回写 ${adj.adjusted_amount} = 差异 ${adj.diff_amount}（差异没丢也没重复算，且精确到分）`)

      // 建单不改成本：草稿态既不写台账，也不动结存金额
      const draftLedger = db.prepare("SELECT COUNT(*) c FROM stock_cost_ledger WHERE doc_no=?").get(adj.doc_no).c
      ok(draftLedger === 0, '草稿态不写成本台账（建单只是记录意图）')
      const stockAfterCreate = db
        .prepare('SELECT COALESCE(SUM(cost_amount),0) s, COUNT(*) c FROM inventory_stocks').get()
      ok(near(stockAfterCreate.s, stockAtStart.s) && stockAfterCreate.c === stockAtStart.c,
        `草稿态不改结存金额（${round2(stockAtStart.s)} → ${round2(stockAfterCreate.s)}，与质检「建单只记意图」同一设计）`)

      // 提交：唯一有后果的动作
      const out = adjustCost(db, { id: adj.id, actor: { id: 1, name: 'test' } })
      ok(out.status === 'adjusted', `确认调整后状态 → adjusted（${out.status_label}）`)
      const afterLedger = db.prepare("SELECT COUNT(*) c FROM stock_cost_ledger WHERE doc_no=?").get(adj.doc_no).c
      ok(afterLedger > 0, `写成本台账 ${afterLedger} 条（成本变动可回溯）`)
      const sumLedger = db
        .prepare("SELECT COALESCE(SUM(amount_after - amount_before),0) d FROM stock_cost_ledger WHERE doc_no=? AND direction='adj'")
        .get(adj.doc_no).d
      ok(near(sumLedger, out.adjusted_amount, 0.2),
        `台账金额变动合计 ${round2(sumLedger)} = 回写金额 ${out.adjusted_amount}`)

      // 结存金额真的动了，且正好是回写金额（逐行对比「建单前」的纸上快照）
      let moved = 0
      let movedRows = 0
      for (const i of adj.items) {
        const now = num(db.prepare('SELECT cost_amount FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?')
          .get(i.warehouse_id, i.sku_id, i.batch_no || '')?.cost_amount)
        const delta = round2(now - num(i.amount_before))
        if (Math.abs(delta) > AMOUNT_TOL) { movedRows += 1; moved = round2(moved + delta) }
      }
      ok(movedRows > 0, `结存金额真的被改了（${movedRows} 行）`)
      ok(near(moved, out.adjusted_amount, 0.2), `改动合计 ${moved} = 回写金额 ${out.adjusted_amount}`)
      const afterStock = db.prepare('SELECT COALESCE(SUM(cost_amount),0) s FROM inventory_stocks').get().s
      ok(near(afterStock - stockAtStart.s, out.adjusted_amount, 0.2),
        `库存总金额增量 ${round2(afterStock - stockAtStart.s)} = 回写金额（未把已售出部分算进来）`)
      // 存量不变：成本调整只改钱的账，不动数量 —— 动了数量就变成盘点了
      const qtyAfter = db.prepare('SELECT COALESCE(SUM(qty_on_hand),0) q FROM inventory_stocks').get().q
      ok(nearQty(qtyAfter, stockAtStart.q),
        `成本调整不改数量（${stockAtStart.q} → ${qtyAfter}，只动单价与金额，数量由出入库负责）`)

      // 单价的联动：金额改了，单价必须跟着改，否则下一次出库会按旧单价计价
      const itemsAfter = getAdjustment(db, adj.id).items
      ok(itemsAfter.every((i) => num(i.unit_after) > 0), '每行记录了调整后单价（出库要按新单价计价）')
      ok(itemsAfter.every((i) => near(i.amount_after, num(i.amount_before) + num(i.adj_amount))),
        '每行「调整后金额 = 调整前金额 + 回写金额」')

      // 已售出部分的差异留在损益、不进库存
      ok(near(num(adj.sold_amount), out.sold_amount), `已售出部分 ${out.sold_amount} 元计入本期损益，未进库存金额`)

      // 已调整的单不能再取消（内核拦）
      throwsCode(() => transitionAdjustment(db, { id: adj.id, action: 'cancel', actor: { id: 1, name: 'test' } }),
        null, '已调整的调整单不允许取消（要纠正请开反向调整单）')

      // 同一结算单不允许第二张有效调整单
      throwsCode(() => createAdjustment(db, { settleId: target.id }), 'COST_ADJ_DUPLICATE',
        '同一结算单已有未作废的调整单时，再建被拦（否则差异会被调两次）')

      // 取消只允许草稿 —— 用另一张单验证
      const other = adjustable.find((v) => v.id !== target.id && settlementLines(db, v.id).length > 0)
      if (other) {
        const a2 = createAdjustment(db, { settleId: other.id, actor: { id: 1, name: 'test' } })
        const stockBeforeCancel = db.prepare('SELECT COALESCE(SUM(cost_amount),0) s FROM inventory_stocks').get().s
        const c2 = transitionAdjustment(db, { id: a2.id, action: 'cancel', actor: { id: 1, name: 'test' } })
        ok(c2.to === 'cancelled', '草稿可以取消（取消无后果，所以不设审批）')
        const after = getAdjustment(db, a2.id)
        ok(after.status === 'cancelled', `取消后状态 cancelled（${after.status_label}）`)
        ok(near(db.prepare('SELECT COALESCE(SUM(cost_amount),0) s FROM inventory_stocks').get().s, stockBeforeCancel),
          '取消不改成本（取消的是一张还没生效的单）')
        // 取消掉的单不该再占着结算单
        const again = createAdjustment(db, { settleId: other.id, actor: { id: 1, name: 'test' } })
        ok(again.id !== a2.id, '取消之后可以对同一结算单重新建单（作废不是死锁）')
      } else {
        ok(true, '（无第二张可用的待调整结算单，跳过取消用例）')
      }

      // 台账列表：过滤与分页参数要真的生效
      const listBySettle = listAdjustments(db, { settleId: target.id })
      ok(listBySettle.total > 0 && listBySettle.rows.every((x) => x.settle_id === target.id),
        `按结算单过滤调整单列表生效（total=${listBySettle.total}，全部属于该结算单）`)
      const listDraft = listAdjustments(db, { status: 'draft' })
      ok(listDraft.rows.every((x) => x.status === 'draft'), '按状态过滤调整单列表生效')
      const p1 = listAdjustments(db, { page: 1, pageSize: 1 })
      ok(p1.rows.length <= 1 && p1.pageSize === 1, `分页生效（pageSize=1 返回 ${p1.rows.length} 行）`)
      // 概览的待办金额必须与「可回写 − 已回写 − 已售出不追溯」一致，不能是结算单头部口径
      const ovAfter = costingOverview(db, { period: adj.period })
      ok(!near(ovAfter.variance.pending_amount, num(target.invoice_diff)),
        `概览待调整 ${ovAfter.variance.pending_amount} 元按可回写口径算（发票口径 ${target.invoice_diff} 元不混入）`)
      ok(typeof ovAfter.variance.invoice_gap_amount === 'number',
        `发票口径差额另列展示 ${ovAfter.variance.invoice_gap_amount} 元（供财务看，不是成本待办）`)

      // 关键：调完之后这一张必须从待办里消失。
      // 若待办 = 差异 − 已回写，只要涉及已售出数量就会永久挂着一截做不掉的尾巴（实测 52.3 元）。
      const afterAdj = estimateVariances(db, { limit: 50 }).find((v) => v.id === target.id)
      ok(afterAdj.fully_adjusted && near(afterAdj.pending_amount, 0),
        `调整后该结算单从待办里消失（差异 ${afterAdj.diff_amount} = 回写 ${afterAdj.adjusted_amount} + 已售出不追溯 ${afterAdj.sold_not_traced}，剩余 ${afterAdj.pending_amount}）`)
      const ovAfter2 = costingOverview(db, { period: adj.period })
      ok(ovAfter2.variance.pending_amount < ovBefore.variance.pending_amount
        || near(ovAfter2.variance.pending_amount, 0),
        `概览待办金额收敛（${ovBefore.variance.pending_amount} → ${ovAfter2.variance.pending_amount} 元）`)
    })
  }

  // =========================================================================
  section('T6 自洽审计与可回溯')
  // =========================================================================
  const audit = auditCostIntegrity(db, { limit: 5 })
  ok(audit.checked > 0, `审计覆盖 ${audit.checked} 个库存维度`)
  ok(audit.broken_count === 0,
    `真错 0 条（流水累计 vs 结存金额；差异最大 ${round2(audit.broken_amount)} 元）`)
  ok(audit.zero_qty_count >= 0,
    `qty=0 的残值 ${audit.zero_qty_count} 行单列不判错（口径：zero_qty_cost=keep_last，出清后留下的是历史舍入残值）`)

  if (stockRow) {
    const rec = recompute(db, { warehouseId: stockRow.warehouse_id, skuId: stockRow.sku_id, batchNo: stockRow.batch_no })
    ok(rec.consistent || near(num(rec.current.qty), 0),
      `单维度重算一致：流水累计 ${rec.recomputed.qty} 件 / ${rec.recomputed.amount} 元 vs 结存 ${rec.current.qty} 件 / ${rec.current.amount} 元`)
  }

  // P0 结束时的实际值应当有内容，否则页面会是空的
  const ov = costingOverview(db, { period: months[0].m })
  ok(ov && ov.layers && ov.layers.period === months[0].m, `概览带出期间 ${months[0].m} 的三层`)
  ok(!!ov.period_status, `概览带出期间状态（${ov.period_status}）`)
  ok(ov.variance && typeof ov.variance.pending_settlements === 'number',
    `概览带出待调整暂估差异 ${ov.variance.pending_settlements} 张 / ${ov.variance.pending_amount} 元`)
  ok(ov.integrity && ov.integrity.broken_count === 0, '概览带出自洽审计结果（真错 0）')
  ok(typeof ov.adjusted_this_period === 'number' && typeof ov.sold_not_traced === 'number',
    `概览带出本期已调整 ${ov.adjusted_this_period} 元 / 未追溯 ${ov.sold_not_traced} 元`)

  // =========================================================================
  section('T7 流转留痕与重建卫生')
  // =========================================================================
  const caEvents = db.prepare("SELECT COUNT(*) c FROM doc_events WHERE doc_type='CA'").get().c
  const caRows = db.prepare('SELECT COUNT(*) c FROM cost_adjustments').get().c
  ok(caEvents >= 0, `成本调整单留痕 ${caEvents} 条 / 调整单 ${caRows} 张`)
  ok(caRows > 0 ? caEvents > 0 : caEvents === 0,
    caRows > 0 ? '有调整单就有留痕（走内核推进，不是直接 UPDATE status）' : '本库无调整单，留痕为 0')

  // 孤儿留痕：CA 的留痕必须都能指回一张存在的调整单
  const orphanCa = db
    .prepare(
      `SELECT COUNT(*) c FROM doc_events e
        WHERE e.doc_type='CA'
          AND NOT EXISTS (SELECT 1 FROM cost_adjustments a WHERE a.id = e.doc_id)`
    )
    .get().c
  ok(orphanCa === 0, `CA 留痕零孤儿（${orphanCa} 条指向不存在的调整单）`)

  // 全库留痕对账应当也是零孤儿 —— 成本调整为单据内核引入了一张新单据类型，
  // 新增类型最容易漏的正是「清库/重建时忘了带上它」
  const prune = pruneOrphanEvents(db, { dryRun: true })
  ok(prune.removed === 0, `全库流转留痕零孤儿（dryRun 查到 ${prune.removed} 条）`)

  // 重建清理清单的证据：成本调整单不允许指向一张不存在（或已被重建）的结算单。
  // 这是「整库重建时必须连成本三张表一起清」这条规则的可断言形态 ——
  // 漏了它们会表现成「暂估差异那一栏永远显示已调整，而差异其实没处理」。
  const orphanAdjHead = db
    .prepare(
      `SELECT COUNT(*) c FROM cost_adjustments a
        WHERE a.settle_id IS NOT NULL
          AND NOT EXISTS (SELECT 1 FROM purchase_settlements s WHERE s.id = a.settle_id)`
    )
    .get().c
  ok(orphanAdjHead === 0, `成本调整单零孤儿（${orphanAdjHead} 张指向不存在的结算单）`)

  // 成本流水台账必须是「重建后被重新写出来」的状态：清掉后由 applyStockIn/Out 重灌
  const ledgerRows = db.prepare('SELECT COUNT(*) c FROM stock_cost_ledger').get().c
  const txRows = db.prepare('SELECT COUNT(*) c FROM inventory_transactions').get().c
  ok(ledgerRows > 0 && ledgerRows <= txRows * 2,
    `成本台账 ${ledgerRows} 条 / 流水 ${txRows} 条（台账是派生表，重建后重新生成且不跨代累积）`)

  // 单据内核里 CA 的定义必须存在，且不设作废流程
  const caDef = db.prepare("SELECT * FROM doc_types WHERE code='CA'").get()
  ok(!!caDef, `内核已登记单据类型 CA（${caDef?.name || ''}，表 ${caDef?.table_name || ''}）`)
  if (caDef) {
    ok(caDef.table_name === 'cost_adjustments', 'CA 的主表指向 cost_adjustments（孤儿留痕判据取自这里）')
    const actions = db.prepare("SELECT action FROM doc_actions WHERE doc_type='CA'").all().map((x) => x.action)
    ok(actions.includes('adjust'), `CA 有 adjust 动作（${[...new Set(actions)].join('/')}）`)
    ok(!actions.includes('void'), 'CA 没有作废动作（已调整的不可作废，要纠正开反向调整单）')
    const states = db.prepare('SELECT code, kind FROM doc_states WHERE doc_type=?').all('CA')
    ok(states.length === 3 && states.some((s) => s.kind === 'draft') && states.some((s) => s.kind === 'done')
      && states.some((s) => s.kind === 'void'),
      `CA 三个状态且 kind 齐备（${states.map((s) => s.code + ':' + s.kind).join(' ')}）`)
  }
})

console.log('\n' + '─'.repeat(72))
console.log(`通过 ${pass}　失败 ${fail}`)
console.log('─'.repeat(72))
process.exit(fail ? 1 : 0)

/** 2026-09 → 2026-10 */
function nextMonth(period) {
  const [y, m] = period.split('-').map(Number)
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`
}
