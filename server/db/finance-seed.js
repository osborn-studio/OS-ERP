/**
 * ============================================================================
 * 文件标识：server/db/finance-seed.js ｜ 业财一体演示数据（批次 H · 模块 27）
 * ============================================================================
 * 【职责】业财一体演示数据（批次 H · 模块 27）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 业财一体演示数据（批次 H · 模块 27）
//
// 两件事：**科目表与凭证模板**（定义类，必须每次都在）+ **演示凭证**（从真实来源单生成）。
//
// 为什么演示凭证一律走 `accounting.generateVoucher` 而不手工 INSERT 分录：
//   ① 手工写分录最容易写出**不平的凭证**，而它不会报错，只会让试算平衡表长期差一个数；
//   ② 关键数（不含税 = 总额 ÷ (1+税率)、税额 = 总额 − 不含税）有两套算法时，
//      界面上的凭证和汇总表就会各说各话 —— 本项目的铁律是**算钱只有一处**；
//   ③ 生成的凭证带真实的 `source_type/source_id`，界面上"点单据跳凭证"才走得通。
//
// 演示样本刻意覆盖四种场景，并且**每一种都挑"状态已经允许入账"的单**：
//   采购入库（暂估）· 销售出库（确认收入）· 销售成本结转 · 收款 · 付款。
// 挑不到就不造 —— 宁可少一条样本，也不要造一张"来源状态不对"的凭证。
import { requireDemoDatabase } from './runtime-policy.js'
import * as A from '../lib/accounting.js'

/**
 * 科目表（两层）。
 * 一级科目下挂子科目时，**父科目自动变成不可记账**（由 `saveSubject` 按结构推导，
 * 不靠人工维护 `is_leaf`）—— 「父科目 = 子科目之和」这条恒等式靠这个机制守住。
 */
const SUBJECTS = [
  ['1001', '库存现金', 'asset', 'debit', null],
  ['1002', '银行存款', 'asset', 'debit', null],
  ['1122', '应收账款', 'asset', 'debit', 'customer'],
  ['1123', '预付账款', 'asset', 'debit', 'supplier'],
  ['1201', '其他应收款', 'asset', 'debit', null],
  ['1403', '原材料', 'asset', 'debit', null],
  ['1405', '库存商品', 'asset', 'debit', null],
  ['1408', '委托加工物资', 'asset', 'debit', null],
  ['1601', '固定资产', 'asset', 'debit', null],
  ['2202', '应付账款', 'liability', 'credit', 'supplier'],
  ['2203', '预收账款', 'liability', 'credit', 'customer'],
  ['2211', '应付职工薪酬', 'liability', 'credit', null],
  ['2221', '应交税费', 'liability', 'credit', null],          // 父科目（有子科目后自动不可记账）
  // 应付股利：利润分配的另一半。**它必须在"负债"这一侧** ——
  // 宣告分配股利那一刻公司就欠了股东一笔钱，所以借 4104（未分配利润）/ 贷 2232（应付股利）。
  // 批次 O 之前没有它，是因为那时还没有"利润分配"这个动作。
  ['2232', '应付股利', 'liability', 'credit', null],
  ['4001', '实收资本', 'equity', 'credit', null],
  ['4103', '本年利润', 'equity', 'credit', null],
  // 未分配利润与盈余公积（批次 O）：年度结转的落点与法定提取的去处。
  // 没有 4104，"本年利润"就没有出路 —— 它会一年一年地累积，
  // 于是"账上到底有多少可分配的利润"这个问题永远答不出来。
  ['4104', '利润分配—未分配利润', 'equity', 'credit', null],
  ['4105', '盈余公积', 'equity', 'credit', null],
  ['5001', '生产成本', 'cost', 'debit', null],
  ['6001', '主营业务收入', 'profit_loss', 'credit', null],
  ['6051', '其他业务收入', 'profit_loss', 'credit', null],
  ['6401', '主营业务成本', 'profit_loss', 'debit', null],
  ['6601', '销售费用', 'profit_loss', 'debit', null],
  ['6602', '管理费用', 'profit_loss', 'debit', null],
  // 子科目放在父科目之后（`saveSubject` 会按结构重算 is_leaf，顺序只影响可读性）
  ['222101', '应交增值税-销项税额', 'liability', 'credit', '2221'],
  ['222102', '应交增值税-进项税额', 'liability', 'credit', '2221']
]

/**
 * 凭证模板。
 * `amount_key` 只能从 `lib/accounting.js` 的 `FACT_KEYS` 里取 —— 模板没有"自由表达式"，
 * 因为模板是可被界面编辑的配置，能写表达式就等于**配置能改账**。
 *
 * 每一组的分录都要**恒等平衡**，这是模板能成立的前提：
 *   采购入库：借 存货 = 贷 应付暂估
 *   销售出库：借 应收 = 贷 收入 + 贷 销项税（收入与税额都由总额**减**出来，所以恒等）
 *   成本结转：借 主营成本 = 贷 库存商品
 *   收款　　：借 银行 = 贷 应收 + 贷 预收（未核销部分）
 *   付款　　：借 应付 + 借 预付（未核销部分）= 贷 银行
 */
const TEMPLATES = [
  {
    code: 'TPL_PURCHASE_INBOUND',
    name: '采购入库（暂估）',
    biz_type: 'purchase_inbound',
    doc_type: 'GR',
    // 借方取 `1405 库存商品`：三条行业线都是**买卖**（美妆 / 餐饮 / 服饰），
    // 进货直接进库存商品。生产型企业的「借 1403 原材料」要由生产领料凭证处理，
    // 那条链属于制造域，**不在本批范围内**（列为边界），所以这里不去猜。
    remark: '到货即入库：按到货单金额暂估入账（借 库存商品 / 贷 应付暂估）；发票校验后的差异由采购结算另行调整',
    entries: [
      ['采购入库暂估 {doc_no}', 'debit', '1405', 'total_amount', 'supplier_name'],
      ['应付暂估 {doc_no}', 'credit', '2202', 'total_amount', 'supplier_name']
    ]
  },
  {
    code: 'TPL_SALES_DELIVERY',
    name: '销售出库（确认收入）',
    biz_type: 'sales_delivery',
    doc_type: 'DL',
    remark: '发货即确认债权与收入；收入与销项税由价税合计逆算，保证两者之和恒等于总额',
    entries: [
      ['销售应收 {doc_no}', 'debit', '1122', 'total_amount', 'customer_name'],
      ['主营业务收入 {doc_no}', 'credit', '6001', 'net_amount', null],
      ['销项税额 {doc_no}', 'credit', '222101', 'tax_amount', null]
    ]
  },
  {
    code: 'TPL_COST_CARRY',
    name: '销售出库（结转成本）',
    biz_type: 'cost_carry',
    doc_type: 'DL',
    remark: '成本只从库存成本流水取，不用售价估算 —— 用售价估成本，毛利永远是"对的"（因为它是编的）',
    entries: [
      ['结转销售成本 {doc_no}', 'debit', '6401', 'cost_amount', null],
      ['库存商品减少 {doc_no}', 'credit', '1405', 'cost_amount', null]
    ]
  },
  {
    code: 'TPL_RECEIPT',
    name: '收款',
    biz_type: 'receipt',
    doc_type: 'RCP',
    remark: '已核销部分冲应收，未核销部分记预收 —— 两者都由收款单自己的核销结果决定',
    entries: [
      ['收到货款 {doc_no}', 'debit', '1002', 'total_amount', null],
      ['冲减应收 {doc_no}', 'credit', '1122', 'settled_amount', null],
      ['预收货款 {doc_no}', 'credit', '2203', 'offset_amount', 'customer_name']
    ]
  },
  {
    code: 'TPL_PAYMENT',
    name: '付款',
    biz_type: 'payment',
    doc_type: 'PAY',
    remark: '已核销部分冲应付，未核销部分记预付',
    entries: [
      ['支付货款 {doc_no}', 'debit', '2202', 'settled_amount', 'supplier_name'],
      ['预付货款 {doc_no}', 'debit', '1123', 'offset_amount', 'supplier_name'],
      ['银行存款减少 {doc_no}', 'credit', '1002', 'total_amount', null]
    ]
  },
  {
    code: 'TPL_REFUND',
    name: '销售退款',
    biz_type: 'refund',
    doc_type: 'RFD',
    // 为什么借"预收账款"而不是"应收账款"：
    //   `refund_due` 是**已收款退货**里"应收冲不下的那一部分"，其经济实质就是
    //   我们多收了客户的钱（预收负债）。退款就是清偿这笔负债。
    //   挂应收会让"退货冲减应收"与"退款"同时反向操作同一个科目，
    //   账上看起来像什么都没发生 —— 而事实上钱确实出去了。
    remark: '退款清偿的是"多收客户的钱"（预收负债）；已收款退货产生的待退款额就是那笔负债',
    entries: [
      ['退还客户货款 {doc_no}', 'debit', '2203', 'total_amount', 'customer_name'],
      ['银行存款减少 {doc_no}', 'credit', '1002', 'total_amount', null]
    ]
  },
  {
    // 与 `TPL_PURCHASE_INBOUND` **严格镜像**：那条是「借 1405 / 贷 2202」，这条反过来。
    // 为什么必须有它：采购侧原来只有入库一条路（只挂不减），货退回供应商之后
    // 暂估应付与存货**双双虚高**，而且不报错。两套模板共用同一个 `amount_key`
    // （`total_amount`），方向由 `direction` 决定 ⇒ 金额口径只有一处。
    code: 'TPL_PURCHASE_RETURN',
    name: '采购退货（冲回暂估）',
    biz_type: 'purchase_return',
    doc_type: 'PRT',
    remark: '退货出库：冲回入库时挂上的暂估存货与应付（借 应付暂估 / 贷 库存商品），与采购入库模板严格镜像；发票校验后的差异仍由采购结算另行调整',
    entries: [
      ['采购退货冲回应付 {doc_no}', 'debit', '2202', 'total_amount', 'supplier_name'],
      ['采购退货冲回库存 {doc_no}', 'credit', '1405', 'total_amount', 'supplier_name']
    ]
  }
]

/** 演示要生成凭证的来源单据：按场景各挑几条"状态已允许入账"的真单 */
function pickSources(db) {
  const out = []
  const receipts = db
    .prepare("SELECT id, doc_no FROM purchase_receipts WHERE status IN ('received','inspected','closed') AND total_amount > 0 ORDER BY id LIMIT 2")
    .all()
  for (const r of receipts) out.push(['purchase_inbound', r.id])

  const deliveries = db
    .prepare("SELECT id, doc_no, total_amount FROM sales_deliveries WHERE status IN ('shipped','completed') AND total_amount > 0 ORDER BY id LIMIT 2")
    .all()
  for (const d of deliveries) out.push(['sales_delivery', d.id])

  // 结转成本必须**真的有成本流水**：没有成本流水的发货单生成不出凭证（会被 VOUCHER_EMPTY 拦住），
  // 所以这里先探一下，宁可少一条样本
  for (const d of deliveries) {
    const n = db.prepare("SELECT COUNT(*) c FROM stock_cost_ledger WHERE doc_no=? AND doc_type='SAL_OUT'").get(d.doc_no).c
    if (n > 0) out.push(['cost_carry', d.id])
  }

  const rcps = db.prepare("SELECT id FROM receipts WHERE status='confirmed' AND amount > 0 ORDER BY id LIMIT 2").all()
  for (const r of rcps) out.push(['receipt', r.id])

  const pays = db.prepare("SELECT id FROM purchase_payments WHERE status IN ('paid','approved') AND amount > 0 ORDER BY id LIMIT 2").all()
  for (const p of pays) out.push(['payment', p.id])

  // 退款：只有"已退款"才能入账（草稿是"打算退"，不是"退过了"）
  const refunds = db.prepare("SELECT id FROM refunds WHERE status='confirmed' AND amount > 0 ORDER BY id LIMIT 2").all()
  for (const x of refunds) out.push(['refund', x.id])

  // 采购退货：只有"货真退了"才能入账（`draft` 是"打算退"，库存与成本侧一行都没写过）。
  // 与采购入库同理 —— 少一条样本没关系，**凭空记一笔没发生的退货**才是事故。
  const prts = db
    .prepare("SELECT id FROM purchase_returns WHERE status IN ('confirmed','completed') AND total_amount > 0 ORDER BY id LIMIT 2")
    .all()
  for (const x of prts) out.push(['purchase_return', x.id])

  return out
}

export function seedFinance(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const log = (m) => { if (!silent) console.log(`  [finance-seed] ${m}`) }

  // ---------- 1. 科目表（定义类：覆盖写，改了就该生效） ----------
  for (const [code, name, category, direction, parentCode] of SUBJECTS) {
    const parent = parentCode ? db.prepare('SELECT id FROM accounting_subjects WHERE code=?').get(parentCode) : null
    A.saveSubject(db, { code, name, category, direction, parent_id: parent?.id ?? null })
  }
  const subjectCount = db.prepare('SELECT COUNT(*) c FROM accounting_subjects').get().c
  log(`会计科目 ${subjectCount} 个`)

  // ---------- 2. 凭证模板 ----------
  const upTpl = db.prepare(`
    INSERT INTO voucher_templates (code,name,biz_type,doc_type,status,remark) VALUES (?,?,?,?,'active',?)
    ON CONFLICT(biz_type) DO UPDATE SET code=excluded.code, name=excluded.name, doc_type=excluded.doc_type, remark=excluded.remark
  `)
  const delEntries = db.prepare('DELETE FROM voucher_template_entries WHERE template_id=?')
  const insEntry = db.prepare(`
    INSERT INTO voucher_template_entries (template_id,seq,summary,direction,subject_code,amount_key,aux_key)
    VALUES (?,?,?,?,?,?,?)
  `)
  for (const t of TEMPLATES) {
    upTpl.run(t.code, t.name, t.biz_type, t.doc_type, t.remark)
    const row = db.prepare('SELECT id FROM voucher_templates WHERE biz_type=?').get(t.biz_type)
    // 分录模板**整体重建**而不是逐条 upsert：改了行数（例如从三行变两行）时，
    // 逐条 upsert 会留下多余的老行，而那是"上一版模板"的残留 —— 它还在参与生成。
    delEntries.run(row.id)
    t.entries.forEach((e, i) => insEntry.run(row.id, i + 1, ...e))
  }
  log(`凭证模板 ${TEMPLATES.length} 套`)

  // 模板自检：每组都必须"两边都有、且有内容"（模板写错不报错，只会让生成全部失败）
  for (const t of TEMPLATES) {
    const entries = db.prepare('SELECT * FROM voucher_template_entries WHERE template_id=(SELECT id FROM voucher_templates WHERE biz_type=?)').all(t.biz_type)
    const bad = entries.filter((e) => !A.FACT_KEYS[e.amount_key] || !['debit', 'credit'].includes(e.direction))
    if (bad.length) throw new Error(`模板 ${t.name} 的分录引用了非法取数键或方向：${JSON.stringify(bad)}`)
    if (!entries.some((e) => e.direction === 'debit') || !entries.some((e) => e.direction === 'credit')) {
      throw new Error(`模板 ${t.name} 只有单边分录，生成出来的凭证必定不平`)
    }
  }

  // ---------- 3. 演示凭证（**从真实来源单生成**，不平即拒绝） ----------
  //
  // 幂等：`generateVoucher` 对同一来源返回同一张，所以每次启动重跑不会堆积。
  // 但**不自动过账**：过账是"入账"，属于人的动作 —— 演示数据里留一部分 draft 也有意义
  // （界面上一眼能看出"生成"和"入账"是两步）。
  let generated = 0
  let replayed = 0
  const skipped = []
  const ids = []
  for (const [bizType, sourceId] of pickSources(db)) {
    try {
      const out = A.generateVoucher(db, { bizType, sourceId, actor: { name: '演示数据' }, memo: null })
      if (out.replayed) replayed += 1
      else generated += 1
      ids.push(out.id)
    } catch (e) {
      // 挑不到样本、金额为 0、来源状态不对 —— 都不该让整个 seed 挂掉，
      // 但必须**如实记一条**，否则"演示数据少了一块"会变成一个没有原因的空白
      skipped.push(`${bizType}#${sourceId}:${e.code || e.message}`)
    }
  }
  log(`演示凭证 新建 ${generated} / 已存在 ${replayed}${skipped.length ? ` / 跳过 ${skipped.length}` : ''}`)
  if (skipped.length) log(`  跳过明细：${skipped.slice(0, 6).join(' · ')}`)

  // ---------- 4. 过账 ----------
  //
  // 演示数据**刻意留下一张不过账**：界面上必须能同时看到「已生成（draft）」与
  // 「已过账（posted）」两种形态，否则"生成"与"入账"是两步这件事在演示里看不出来，
  // 而试算平衡表又会因为这些凭证没过账而一片空白 —— 那看起来像功能没做。
  // 过账同样是走服务函数（`postVoucher` 会**再校验一次平衡**）。
  const posted = ids.slice(0, Math.max(0, ids.length - 1))
  let postOk = 0
  for (const id of posted) {
    try {
      A.postVoucher(db, { id, actor: { name: '演示数据' } })
      postOk += 1
    } catch (e) {
      skipped.push(`post#${id}:${e.code || e.message}`)
    }
  }
  log(`已过账 ${postOk} 张（刻意留 1 张 draft）`)

  return { subjects: subjectCount, templates: TEMPLATES.length, generated, replayed, posted: postOk, skipped }
}

export default { seedFinance }
