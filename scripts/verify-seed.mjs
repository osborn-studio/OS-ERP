/**
 * ============================================================================
 * 文件标识：scripts/verify-seed.mjs ｜ 数据校验：seed 口径复核：按行业逐个核对「组织 / 货主 / 品牌 / 币种 / 效期」是否与数据集声明一致
 * ============================================================================
 * 【职责】数据校验：seed 口径复核：按行业逐个核对「组织 / 货主 / 品牌 / 币种 / 效期」是否与数据集声明一致
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// seed 口径复核：按行业逐个核对「组织 / 货主 / 品牌 / 币种 / 效期」是否与数据集声明一致
// 用法：node scripts/verify-seed.mjs [cosmetic|food|apparel|all]
//
// 与 test-*.mjs 的分工：那几套测「引擎行为」，本脚本测「灌进去的数据口径对不对」。
// 起因：餐饮 seed 曾出现 11 条在库批次已过保 —— 这类问题断言测不出来，只能按数据集口径逐项复核。
import { getDbFor, INDUSTRIES } from '../server/db/index.js'
// 整库重建清单（第 16 节）：库里每一张表都必须落在两者之一
import { TABLES, KEEP_TABLES } from '../server/db/seed.js'
import { pruneOrphanEvents } from '../server/lib/docflow.js'
import { auditInvoice } from '../server/lib/invoice.js'
import { auditAr } from '../server/lib/ar.js'
// 授信投影对账（第 9 节）：`sales_orders.credit_hold` 必须等于台账净占用，判据只有 `reconcileOrderHolds` 一处（ADR-0014）
import { reconcileOrderHolds } from '../server/lib/credit.js'
import { auditQc } from '../server/lib/qc2.js'
import { auditMfg } from '../server/lib/mfg.js'
// 报表域自洽（第 18 节）：与 `lib/report.js` **共用同一份自证判据** ——
// 这里的"复核"不另写一遍三条恒等式，而是调报表域自己的 `auditReport`。
// 两处各写一遍的结果一定是"只有一处会响"，而那一处是测试里那个（人不会去看）。
import { auditReport, auditComparison, auditRange, compareReport, exportReport, computeReport, listReportDefs, availablePeriods, subjectBalances, uncarriedProfitSubjects } from '../server/lib/report.js'
// 试算平衡表的"逐行展开"（第 20 节）：与汇总共用 `trialBalanceFilter`，
// 所以这里能直接断言"明细合计 = 汇总行"——不另写一遍筛选条件。
import { trialBalance, trialBalanceDetail } from '../server/lib/accounting.js'
// 年度结转与分配（第 21 节）：年度的状态与"能不能年结"也**不另写判据**，
// 直接调 `lib/annual.js` 的 `listAnnual`（它是界面与自证共用的那一份回答）。
import { listAnnual } from '../server/lib/annual.js'
// 期间审计链（第 23 节）：重放核对 / 双向核对 / 派生凭证归主，判据同样只有一份
// （`lib/period-audit.js` 的 `auditPeriodTrail`），这里不再写一遍。
import { auditPeriodTrail, PERIOD_ACTIONS, REASON_REQUIRED_ACTIONS, ACTION_VOUCHER_BIZ_TYPES } from '../server/lib/period-audit.js'
// IM（钉钉/飞书）同步链自证（批次 T）
import * as IMA from '../server/lib/im-sync.js'
// 报表口径变更链（批次 S）：判据与 `test-report-config-audit.mjs` 共用同一份
// （`auditReportConfigTrail` / `replayReportConfig` / `reportConfigStateOf` / `diffSnapshot`），
// 所以"测试里绿、自查里红"这种事不可能发生。
import { auditReportConfigTrail, replayReportConfig, reportConfigStateOf, diffSnapshot, SNAPSHOT_FIELDS } from '../server/lib/report-config-audit.js'

// 配置变更链（第 24 节）：定义表是否完整 / 库里的键是否 == 登记表的键 / 重放核对。
// 判据同样只有一份（`lib/settings.js` 的 `auditSettingTrail`），这里不再写一遍。
import { auditSettingTrail, SETTING_RULES, SETTING_KEYS, replaySettings, settingsStateOf } from '../server/lib/settings.js'

let fails = 0
const ok = (cond, msg) => {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    console.log(`  ✗ ${msg}`)
    fails += 1
  }
}

const args = process.argv.slice(2)
const target = args[0] && INDUSTRIES[args[0]] ? args[0] : args[0] === 'all' ? 'all' : 'food'
const codes = target === 'all' ? Object.keys(INDUSTRIES) : [target]

for (const code of codes) {
  const db = getDbFor(code)
  const q = (s, ...a) => db.prepare(s).get(...a)
  const all = (s, ...a) => db.prepare(s).all(...a)

  console.log(`\n${'='.repeat(72)}`)
  console.log(`【${code}】${INDUSTRIES[code].label}`)
  console.log('='.repeat(72))

  console.log('\n1. 主体结构')
  for (const r of all(`SELECT type, COUNT(*) c FROM orgs WHERE id<>0 GROUP BY type ORDER BY c DESC`)) {
    console.log(`  ${String(r.type).padEnd(10)} ${r.c}`)
  }

  console.log('\n2. 库存货主回填')
  const nullOwner = q('SELECT COUNT(*) c FROM inventory_stocks WHERE owner_org_id IS NULL').c
  ok(nullOwner === 0, `库存无 NULL 货主（遗留 ${nullOwner} 行，应为 0）`)

  console.log('\n3. 门店仓与门店关联')
  const linked = q(`SELECT COUNT(*) c FROM warehouses WHERE type='store' AND store_id IS NOT NULL`).c
  const whTotal = q(`SELECT COUNT(*) c FROM warehouses WHERE type='store'`).c
  const stTotal = q('SELECT COUNT(*) c FROM stores').c
  console.log(`  门店仓 ${whTotal} / 门店 ${stTotal} / 已关联 ${linked}`)
  ok(whTotal === linked, `门店仓全部关联到门店（${linked}/${whTotal}）`)
  ok(whTotal >= stTotal, `门店仓数不少于门店数（${whTotal} >= ${stTotal}）`)

  console.log('\n4. 品牌贯穿')
  const brandRows = all(`SELECT b.name AS brand, COUNT(DISTINCT s.id) stores
    FROM brands b LEFT JOIN stores s ON s.brand_id=b.id GROUP BY b.id ORDER BY b.id`)
  const brandedStores = brandRows.reduce((a, r) => a + r.stores, 0)
  for (const r of brandRows) console.log(`  ${String(r.brand).padEnd(10)} 门店 ${r.stores}`)
  const noBrand = q(`SELECT COUNT(*) c FROM orgs WHERE type='store' AND brand_id IS NULL`).c
  const storeOrgs = q(`SELECT COUNT(*) c FROM orgs WHERE type='store'`).c
  console.log(`  门店组织未带品牌：${noBrand} / ${storeOrgs}`)
  // 口径：品牌可以是「门店级」（如餐饮多品牌）也可以是「纯商品属性」（如美妆）。
  // 硬不变量只有一条 —— 不能一半带一半不带（半带 = 有门店被漏掉品牌）。
  ok(brandedStores === 0 || noBrand === 0,
    brandedStores === 0
      ? '品牌为纯商品属性（门店一律不带品牌，口径一致）'
      : `门店组织均带品牌（未带 ${noBrand} 个，应为 0）`)

  console.log('\n5. 多币种')
  for (const r of all(`SELECT currency, COUNT(*) rows, ROUND(SUM(qty_on_hand),0) qty
    FROM inventory_stocks GROUP BY currency ORDER BY rows DESC`)) {
    console.log(`  ${r.currency}: ${r.rows} 行 / 数量 ${r.qty}`)
  }
  for (const r of all(`SELECT w.currency, COUNT(DISTINCT s.id) stores FROM stores s
    JOIN warehouses w ON w.store_id=s.id GROUP BY w.currency`)) {
    console.log(`  门店币种 ${r.currency}: ${r.stores} 店`)
  }
  const badCur = q(`SELECT COUNT(*) c FROM stores WHERE currency IS NULL OR currency=''`).c
  ok(badCur === 0, `门店币种均已声明（缺 ${badCur} 个）`)

  console.log('\n6. 批次效期')
  const exp = q(`SELECT COUNT(*) total,
      SUM(CASE WHEN expire_date IS NOT NULL THEN 1 ELSE 0 END) with_exp,
      SUM(CASE WHEN expire_date < date('now') THEN 1 ELSE 0 END) expired,
      SUM(CASE WHEN expire_date >= date('now') AND expire_date <= date('now','+3 day') THEN 1 ELSE 0 END) near3
    FROM inventory_stocks WHERE qty_on_hand > 0`)
  console.log(`  在库批次 ${exp.total} / 带效期 ${exp.with_exp} / 已过保 ${exp.expired} / 3 天内到期 ${exp.near3}`)
  ok(exp.expired === 0, `在库批次无过保（${exp.expired} 条，应为 0）`)
  const span = q(`SELECT MIN(julianday(expire_date)-julianday('now')) minD,
      MAX(julianday(expire_date)-julianday('now')) maxD
    FROM inventory_stocks WHERE expire_date IS NOT NULL AND qty_on_hand>0`)
  if (span.minD != null) {
    console.log(`  剩余效期范围：${Number(span.minD).toFixed(1)} ~ ${Number(span.maxD).toFixed(1)} 天`)
    ok(Number(span.minD) >= 0, `最短剩余效期非负（${Number(span.minD).toFixed(1)} 天）`)
  }

  console.log('\n7. 库存逻辑层自检')
  const neg = q('SELECT COUNT(*) c FROM inventory_stocks WHERE qty_on_hand < 0').c
  ok(neg === 0, `无负现存量（${neg} 行，应为 0）`)
  const negRes = q('SELECT COUNT(*) c FROM inventory_stocks WHERE qty_reserved < 0 OR qty_in_transit < 0 OR qty_ordered < 0').c
  ok(negRes === 0, `无负占用/在途/采购在途（${negRes} 行，应为 0）`)
  const overRes = q('SELECT COUNT(*) c FROM inventory_stocks WHERE qty_reserved > qty_on_hand + 0.001').c
  ok(overRes === 0, `占用量不超过现存量（超占 ${overRes} 行，应为 0）`)

  // 8. 流转留痕对账
  // doc_events 是唯一一张跨所有单据类型的旁支表，行按 (doc_type, doc_id) 指向各自的主表。
  // 主表重建后 id 会被复用，上一代的留痕看起来仍「指着一张存在的单」——
  // 于是单据时间线挂着别人的历史（实测三库曾累计 2 万+ 条孤儿，其中 53 条 INS 留痕已错挂）。
  // 这类错不会报错，只会让人不再相信流转记录，所以把它变成可断言的不变量。
  console.log('\n8. 流转留痕对账')
  const orphan = pruneOrphanEvents(db, { dryRun: true })
  const evTotal = q('SELECT COUNT(*) c FROM doc_events').c
  console.log(`  doc_events 共 ${evTotal} 条`)
  if (orphan.removed > 0) {
    console.log(`  孤儿分布：${Object.entries(orphan.byType).map(([k, v]) => `${k} ${v}`).join('、')}`)
  }
  ok(orphan.removed === 0, `无孤儿留痕（${orphan.removed} 条指向不存在的单据，应为 0）`)

  // 9. 跨代引用自洽（发票 / 应收）
  // 「整库重建」只 DROP 清单内的表。若某个新模块的表被漏在清单外，
  // 重建后它会残留下来、继续指向已被复用 id 的发货行/订单 —— 这类脏数据**不会**被孤儿留痕检查发现
  // （行指向的单据确实存在，只是换了人），只会让下游口径悄悄算错。
  // 本轮真实踩到：force 重灌后残留上一代发票，开票审计误报 3 处「超开发票」+ 5 处「孤儿关联」。
  // 所以把「发票 / 应收 自洽审计」也变成 seed 复核的一部分：重建不彻底会在这里当场现形。
  console.log('\n9. 跨代引用自洽（发票 / 应收）')
  const invAudit = auditInvoice(db)
  const invBad = invAudit.overQty.length + invAudit.orphanLinks.length + invAudit.headDrift.length + invAudit.missingAr.length + invAudit.badClose.length
  if (invBad > 0) {
    console.log(`  开票审计：超开 ${invAudit.overQty.length} / 孤儿关联 ${invAudit.orphanLinks.length} / 头行不符 ${invAudit.headDrift.length} / 缺应收 ${invAudit.missingAr.length} / 关闭漂移 ${invAudit.badClose.length}`)
  }
  ok(invAudit.ok, `开票自洽审计通过（不一致 ${invBad} 处，应为 0）`)
  const arAudit = auditAr(db)
  const arBad = (arAudit.drift?.length || 0) + (arAudit.badStatus?.length || 0) + (arAudit.overAlloc?.length || 0) + (arAudit.rcDrift?.length || 0)
  ok(arAudit.ok, `应收自洽审计通过（不一致 ${arBad} 处，应为 0）`)
  // 授信投影：seed 先补历史占用，再由 ar-seed 核销 / 作废 / 预收抵扣 —— 四条路径之后
  // 每张订单的 credit_hold 都必须仍等于台账净占用。原来只有 test-quote-credit 会响，这里让重建自己也响。
  const holdDiffs = reconcileOrderHolds(db)
  if (holdDiffs.length) console.log(`  投影漂移：${holdDiffs.slice(0, 5).map((d) => `${d.doc_no} hold=${d.hold} ledger=${d.ledger}`).join(' / ')}`)
  ok(holdDiffs.length === 0, `销售订单 credit_hold 投影与授信台账逐单一致（漂移 ${holdDiffs.length} 条，应为 0）`)

  // 10. 质量检验自洽（模块 13）
  // 与第 9 节同一个道理：质检的三张表（报检行 / 检验单 / 处置单）互相引用，
  // 重建清单漏一张就会留下一批"看起来合法"的旧单。
  // 这里直接跑 auditQc —— 它把「判定与数字是否一致」也做成了断言，
  // 而这一条恰恰是最容易静默出错的（判合格却有不良数 > Ac）。
  console.log('\n10. 质量检验自洽（报检 / 检验 / 处置）')
  const qcAudit = auditQc(db)
  const qcKeys = ['badLineQty', 'badVerdict', 'headDrift', 'inspDrift', 'overHandle', 'staleHandle', 'closedWithDraft', 'shortHandle', 'orphan', 'missingStockEffect', 'transferNotPosted']
  const qcBad = qcKeys.reduce((s, k) => s + (qcAudit[k]?.length || 0), 0)
  if (qcBad > 0) {
    console.log(`  质检审计：${qcKeys.filter((k) => qcAudit[k]?.length).map((k) => `${k} ${qcAudit[k].length}`).join(' / ')}`)
  }
  ok(qcAudit.ok, `质检自洽审计通过（不一致 ${qcBad} 处，应为 0）`)
  const qcCount = q('SELECT COUNT(*) c FROM qc_requests').c
  const qciCount = q('SELECT COUNT(*) c FROM qc_inspections').c
  const dhCount = q('SELECT COUNT(*) c FROM qc_defect_handlings').c
  // 一对一的口径是「已提交的报检单」——草稿还没提交，本来就不该有检验单；
  // 写成「报检单总数 == 检验单数」会在留了草稿样本时永远不成立（实测踩到）。
  const qcSubmitted = q("SELECT COUNT(*) c FROM qc_requests WHERE status IN ('submitted','closed')").c
  ok(qcSubmitted === qciCount, `已提交报检单与检验单一对一（${qcSubmitted} / ${qciCount}）`)
  console.log(`  报检 ${qcCount}（已提交 ${qcSubmitted} / 草稿 ${qcCount - qcSubmitted}）/ 检验 ${qciCount} / 处置 ${dhCount}`)

  // 11. 生产制造自洽（模块 10B：BOM / 领料 / 完工入库）
  // 三张表同样互相引用（订单 → 领料单 → 库存流水；订单 → 完工汇报 → 库存流水），
  // 而本域最典型的静默失效是「单据说出了库、流水里没有」——
  // 界面上完全看不出红字，只在对账时露馅，所以这里直接跑 auditMfg。
  console.log('\n11. 生产制造自洽（BOM / 领料 / 完工入库）')
  const mfgAudit = auditMfg(db)
  if (mfgAudit.issues.length) {
    const by = mfgAudit.issues.reduce((m, x) => ({ ...m, [x.code]: (m[x.code] || 0) + 1 }), {})
    console.log(`  制造审计：${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' / ')}`)
  }
  ok(mfgAudit.error_count === 0, `制造自洽审计无错误（错误 ${mfgAudit.error_count} 处，应为 0）`)
  ok(mfgAudit.warn_count === 0, `制造自洽审计无警告（警告 ${mfgAudit.warn_count} 处，应为 0）`)

  const bomCount = q('SELECT COUNT(*) c FROM boms').c
  const bomApproved = q("SELECT COUNT(*) c FROM boms WHERE status='approved'").c
  const issueCount = q('SELECT COUNT(*) c FROM material_issues').c
  const issueIssued = q("SELECT COUNT(*) c FROM material_issues WHERE status='issued'").c
  const wrCount = q('SELECT COUNT(*) c FROM work_reports').c
  // 「一个母件一个用途只有一版」是 BOM 的核心约束 —— 直接查库，不信接口：
  // 唯一索引掉了接口不会报错，但两个人都建一版、各领各的料，系统两个都认。
  const bomDup = all(`
    SELECT product_sku_id, usage, COUNT(*) c FROM boms
     GROUP BY product_sku_id, usage HAVING COUNT(*) > 1`)
  ok(bomDup.length === 0, `一个母件一个用途只有一版 BOM（重复 ${bomDup.length} 组，应为 0）`)
  // 已出库的领料单必须逐条有库存流水（auditMfg 已覆盖，这里给一个显式的数量口径便于对账）
  const issuedNoTxn = q(`
    SELECT COUNT(*) c FROM material_issues mi
     WHERE mi.status='issued'
       AND NOT EXISTS (SELECT 1 FROM inventory_transactions t WHERE t.doc_type='MR' AND t.doc_id=mi.id AND t.direction='out')`).c
  ok(issuedNoTxn === 0, `已出库领料单都有库存流水（缺流水 ${issuedNoTxn} 张，应为 0）`)
  // 完工入库产生的批次必须是**待检**：刚做出来的货不该直接可用
  const badQc = q(`
    SELECT COUNT(*) c FROM inventory_batches b
     WHERE b.batch_no IN (SELECT DISTINCT batch_no FROM inventory_transactions WHERE doc_type='MO' AND direction='in' AND COALESCE(batch_no,'')<>'')
       AND b.qc_status NOT IN ('pending','qualified')`).c
  ok(badQc === 0, `完工入库批次的质检状态合法（异常 ${badQc} 个，应为 0）`)
  console.log(
    `  BOM ${bomCount}（已审批 ${bomApproved}）/ 领料单 ${issueCount}（已出库 ${issueIssued}）/ 完工汇报 ${wrCount}`
  )

  // 12. 门店交班核款自洽（模块 17：班次 / 支付方式差异 / 缴款 / 日结）
  // 本域的静默失效全都长一个样：**单据都存在、数字都非空，但互相推不出来**。
  //   · 长短款与「实点 − 系统应收」不等 → 差异单上的方向是错的，看的人会理解反；
  //   · 订单没有 `shift_id` → 系统应收只能现算，同一天两班会翻倍，而界面上看不出来；
  //   · 班次的已缴金额与缴款明细不等 → 钱在"已交"与"没交"之间同时成立。
  // 这几条都不会报错，所以逐条用 SQL 复核，不靠接口自述。
  console.log('\n12. 门店交班核款自洽（班次 / 长短款 / 缴款 / 日结）')
  const shiftCount = q('SELECT COUNT(*) c FROM pos_shifts').c
  // 班次必须有单号：缴款单与日结单都要指回它，空单号会让"指回哪个班次"变成空
  const noDocNo = q("SELECT COUNT(*) c FROM pos_shifts WHERE doc_no IS NULL OR doc_no=''").c
  ok(noDocNo === 0, `每个班次都有交班单号（缺号 ${noDocNo} 个，应为 0）`)
  const dupDocNo = all('SELECT doc_no, COUNT(*) c FROM pos_shifts GROUP BY doc_no HAVING COUNT(*) > 1')
  ok(dupDocNo.length === 0, `交班单号不重复（重复 ${dupDocNo.length} 组，应为 0）`)
  // 长短款 = 实点 − 系统应收（只有已核款的班次有资格谈长短款）
  const badVariance = q(`
    SELECT COUNT(*) c FROM pos_shifts
     WHERE status='closed' AND ABS(COALESCE(variance,0) - (COALESCE(counted_cash,0) - COALESCE(sys_cash,0))) > 0.005`).c
  ok(badVariance === 0, `已核款班次满足「长短款 = 实点 − 系统应收」（异常 ${badVariance} 个，应为 0）`)
  // 已核款班次必须有现金行，且现金行的差异与班次长短款一致
  const missCashRow = q(`
    SELECT COUNT(*) c FROM pos_shifts s
     WHERE s.status='closed'
       AND NOT EXISTS (SELECT 1 FROM pos_shift_payments p WHERE p.shift_id=s.id AND p.method='cash')`).c
  ok(missCashRow === 0, `已核款班次都有现金支付方式行（缺 ${missCashRow} 个，应为 0）`)
  const badCashDiff = q(`
    SELECT COUNT(*) c FROM pos_shifts s JOIN pos_shift_payments p ON p.shift_id=s.id AND p.method='cash'
     WHERE s.status='closed' AND ABS(COALESCE(p.diff,0) - COALESCE(s.variance,0)) > 0.005`).c
  ok(badCashDiff === 0, `现金行差异与班次长短款一致（不一致 ${badCashDiff} 个，应为 0）`)
  // 报数阶段（declared）现金差异必须为 0：店长还没数钱，此时不存在「差异」
  const declaredDiff = q(`
    SELECT COUNT(*) c FROM pos_shifts s JOIN pos_shift_payments p ON p.shift_id=s.id AND p.method='cash'
     WHERE s.status='declared' AND ABS(COALESCE(p.diff,0)) > 0.005`).c
  ok(declaredDiff === 0, `已报数未核款的班次现金差异为 0（异常 ${declaredDiff} 个，应为 0）`)
  // 一个班次一种支付方式一行
  const dupPay = all('SELECT shift_id, method, COUNT(*) c FROM pos_shift_payments GROUP BY shift_id, method HAVING COUNT(*) > 1')
  ok(dupPay.length === 0, `一个班次一种支付方式只有一行（重复 ${dupPay.length} 组，应为 0）`)
  // 有效订单必须绑班次，且班次的门店/营业日与订单一致（跨门店/跨日归属会让现金口径错位）
  const orphanOrder = q(`
    SELECT COUNT(*) c FROM pos_orders o
     WHERE o.status IN ('local','synced') AND o.shift_id IS NULL`).c
  ok(orphanOrder === 0, `有效零售单都绑定了班次（孤儿 ${orphanOrder} 笔，应为 0）`)
  const mismatchOrder = q(`
    SELECT COUNT(*) c FROM pos_orders o JOIN pos_shifts s ON s.id=o.shift_id
     WHERE o.store_id <> s.store_id OR o.biz_date <> s.biz_date`).c
  ok(mismatchOrder === 0, `订单与所属班次同门店同营业日（错位 ${mismatchOrder} 笔，应为 0）`)
  // 一个班次的现金只能缴一次，且班次已缴金额 = 缴款明细之和
  const dupDrop = all('SELECT shift_id, COUNT(*) c FROM pos_cash_drop_items GROUP BY shift_id HAVING COUNT(*) > 1')
  ok(dupDrop.length === 0, `没有班次被缴款两次（重复 ${dupDrop.length} 组，应为 0）`)
  const dropAmountMismatch = q(`
    SELECT COUNT(*) c FROM pos_shifts s
     WHERE ABS(COALESCE(s.cash_drop_amount,0) -
              COALESCE((SELECT SUM(i.amount) FROM pos_cash_drop_items i WHERE i.shift_id=s.id),0)) > 0.005`).c
  ok(dropAmountMismatch === 0, `班次已缴金额与缴款明细一致（不一致 ${dropAmountMismatch} 个，应为 0）`)
  // 缴款单头金额 = 明细合计。
  // **只查未取消的单子**：`cancelCashDrop` 会把明细删掉（为了放开
  // `pos_cash_drop_items` 上的 `UNIQUE (shift_id)`，让这个班次还能重新缴款），
  // 同时把班次的 `cash_drop_amount` 退回去。于是已取消的单子天然是
  // 「头上有金额、明细为空」—— 那不是数据不一致，是「取消」这件事的定义。
  // 不排除它，这一条会变成永久失败，而失败原因看起来像「金额算错了」。
  const dropHeadMismatch = q(`
    SELECT COUNT(*) c FROM pos_cash_drops d
     WHERE d.status <> 'cancelled'
       AND ABS(COALESCE(d.amount,0) -
              COALESCE((SELECT SUM(i.amount) FROM pos_cash_drop_items i WHERE i.drop_id=d.id),0)) > 0.005`).c
  ok(dropHeadMismatch === 0, `缴款单金额与明细合计一致（未取消单；不一致 ${dropHeadMismatch} 张，应为 0）`)
  // 未核款的班次不能出现在缴款明细里（缴款的前提是钱已经数过两遍）
  const dropBeforeClose = q(`
    SELECT COUNT(*) c FROM pos_cash_drop_items i JOIN pos_shifts s ON s.id=i.shift_id
     WHERE s.status <> 'closed'`).c
  ok(dropBeforeClose === 0, `缴款只针对已核款的班次（越界 ${dropBeforeClose} 个，应为 0）`)
  // 日结单的现金三段数必须等于参与班次之和（否则"钱按实点过账"这句话不成立）
  const badCloseCash = q(`
    SELECT COUNT(*) c FROM pos_daily_closes d
     WHERE COALESCE(d.shift_ids,'') <> ''
       AND (ABS(COALESCE(d.sys_cash,0) - COALESCE((SELECT SUM(s.sys_cash) FROM pos_shifts s WHERE ','||d.shift_ids||',' LIKE '%,'||s.id||',%'),0)) > 0.005
         OR ABS(COALESCE(d.counted_cash,0) - COALESCE((SELECT SUM(s.counted_cash) FROM pos_shifts s WHERE ','||d.shift_ids||',' LIKE '%,'||s.id||',%'),0)) > 0.005
         OR ABS(COALESCE(d.cash_variance,0) - COALESCE((SELECT SUM(s.variance) FROM pos_shifts s WHERE ','||d.shift_ids||',' LIKE '%,'||s.id||',%'),0)) > 0.005)`).c
  ok(badCloseCash === 0, `日结单现金三段数等于参与班次之和（不一致 ${badCloseCash} 张，应为 0）`)
  // 挂账待查的差异必须能被总部看到：`pending` 只能出现在已核款的班次上
  const pendingOnOpen = q("SELECT COUNT(*) c FROM pos_shifts WHERE variance_handled='pending' AND status <> 'closed'").c
  ok(pendingOnOpen === 0, `挂账待查只出现在已核款班次（异常 ${pendingOnOpen} 个，应为 0）`)
  // 长短款有数字就必须有原因与归属（否则差异单交上去没人知道该找谁）
  const noReason = q(`
    SELECT COUNT(*) c FROM pos_shifts
     WHERE status='closed' AND ABS(COALESCE(variance,0)) > 0.005
       AND (COALESCE(variance_note,'')='' OR COALESCE(variance_handled,'')='')`).c
  ok(noReason === 0, `有长短款的班次都写了原因与责任归属（缺失 ${noReason} 个，应为 0）`)
  const statusDist = all('SELECT status, COUNT(*) c FROM pos_shifts GROUP BY status ORDER BY status')
  const varDist = all(`SELECT COALESCE(variance_handled,'(无差异)') h, COUNT(*) c, ROUND(COALESCE(SUM(variance),0),2) s
                         FROM pos_shifts WHERE status='closed' GROUP BY variance_handled ORDER BY h`)
  const dropDist = all('SELECT status, COUNT(*) c, ROUND(COALESCE(SUM(amount),0),2) amt FROM pos_cash_drops GROUP BY status')
  console.log(`  班次 ${shiftCount}（${statusDist.map((r) => `${r.status} ${r.c}`).join(' / ')}）`)
  console.log(`  缴费单 ${q('SELECT COUNT(*) c FROM pos_cash_drops').c}（${dropDist.map((r) => `${r.status} ${r.c} 笔 ¥${r.amt}`).join(' / ')}）`)
  console.log(`  长短款形态 ${varDist.map((r) => `${r.h} ${r.c} 个 ¥${r.s}`).join(' / ')}`)
  console.log(`  支付方式差异行 ${q('SELECT COUNT(*) c FROM pos_shift_payments').c} / 门店盘点 ${q("SELECT COUNT(*) c FROM stock_checks WHERE scope='store'").c} / 门店退货 ${q("SELECT COUNT(*) c FROM sales_returns WHERE channel='store'").c}`)

  // 13. 促销与会员自洽（模块 18：活动 / 促销 / 券 / 积分 / 储值）
  // 本域的三条硬口径都可以变成 SQL 不变量，而且**每一条都对应一类静默失效**：
  //   · 余额不是真相，流水才是 → 账户余额必须等于流水合计，且每行 `balance_after` 等于当时的累计；
  //     漏写流水在业务上看不出来（余额对、只是没有来路），半年后对账才爆；
  //   · 行优惠合计恒等于整单优惠 → 优惠算在整单、分摊到行，两处不等说明分摊漏行或重复；
  //   · 券的四态与时间自洽 → `unused` 不该已经过期、`used` 必须指向某张订单。
  // 另有「促销 used 计数器 = 使用登记数」：计数器漏加的表现是"限量券明明没人用却显示已用满"。
  console.log('\n13. 促销与会员自洽（活动 / 促销 / 券 / 积分 / 储值）')

  // 13.1 积分：账户余额 = 流水合计；`points_total` = 正变动之和（只增不减）
  const ptsBalBad = q(`
    SELECT COUNT(*) c FROM member_accounts a
     WHERE a.points <> COALESCE((SELECT SUM(l.change_points) FROM member_points_ledger l
                                  WHERE l.customer_id=a.customer_id),0)`).c
  ok(ptsBalBad === 0, `积分余额 = 流水合计（不一致 ${ptsBalBad} 个账户，应为 0）`)
  // 累计积分只增；口径是「不低于正变动之和」——`setMemberLevel` 人工改级会把
  // 累计门槛抬到达标线（没有流水支撑），所以不能要求严格相等。
  // **排除撤单回退**（`source_type='order_reverse'`）：那里退的是"之前扣掉的抵现积分"，
  // 不是新赚的，也不进 `points_total`；不排除的话一次撤单就会把这条判成漂移。
  // 与 `lib/member.js` 的 `auditMember` **同一口径**（两处必须一起改）。
  const ptsTotalBad = q(`
    SELECT COUNT(*) c FROM member_accounts a
     WHERE a.points_total < COALESCE((SELECT SUM(CASE WHEN l.change_points>0 THEN l.change_points ELSE 0 END)
                                         FROM member_points_ledger l
                                        WHERE l.customer_id=a.customer_id
                                          AND IFNULL(l.source_type,'') <> 'order_reverse'),0)`).c
  ok(ptsTotalBad === 0, `累计积分不低于正变动之和（不足 ${ptsTotalBad} 个账户，应为 0）`)
  // 每一行的 `balance_after_points` 必须等于「到这一行为止的累计」——
  // 这一条抓住的是「余额对、但某几行流水是后补的、顺序对不上」。
  const ptsRunBad = q(`
    SELECT COUNT(*) c FROM (
      SELECT balance_after_points,
             SUM(change_points) OVER (PARTITION BY customer_id ORDER BY id) AS run
        FROM member_points_ledger
    ) WHERE balance_after_points <> run`).c
  ok(ptsRunBad === 0, `积分流水逐行余额可复算（异常 ${ptsRunBad} 行，应为 0）`)

  // 13.2 储值：同口径
  const balBalBad = q(`
    SELECT COUNT(*) c FROM member_accounts a
     WHERE a.balance_cents <> COALESCE((SELECT SUM(l.change_cents) FROM member_balance_ledger l
                                        WHERE l.customer_id=a.customer_id),0)`).c
  ok(balBalBad === 0, `储值余额 = 流水合计（不一致 ${balBalBad} 个账户，应为 0）`)
  const balRunBad = q(`
    SELECT COUNT(*) c FROM (
      SELECT balance_after_cents,
             SUM(change_cents) OVER (PARTITION BY customer_id ORDER BY id) AS run
        FROM member_balance_ledger
    ) WHERE balance_after_cents <> run`).c
  ok(balRunBad === 0, `储值流水逐行余额可复算（异常 ${balRunBad} 行，应为 0）`)
  const negBal = q('SELECT COUNT(*) c FROM member_accounts WHERE points < 0 OR balance_cents < 0').c
  ok(negBal === 0, `会员积分/储值无负数（${negBal} 个，应为 0）`)

  // 13.3 等级：账户与客户表的冗余列一致（两处不一致会让列表页与详情页各说各话）
  const lvlDrift = q(`
    SELECT COUNT(*) c FROM member_accounts a JOIN mall_customers c ON c.id=a.customer_id
     WHERE COALESCE(c.level_code,'') <> COALESCE(a.level_code,'')`).c
  ok(lvlDrift === 0, `会员等级冗余列一致（漂移 ${lvlDrift} 行，应为 0）`)

  // 13.4 促销：used 计数器 = 使用登记数
  const usedDrift = all(`
    SELECT code, used, (SELECT COUNT(*) FROM promotion_usages u WHERE u.promotion_id=p.id) reg
      FROM promotions p WHERE used <> (SELECT COUNT(*) FROM promotion_usages u WHERE u.promotion_id=p.id)`)
  ok(usedDrift.length === 0, `促销 used 计数器 = 使用登记数（不一致 ${usedDrift.length} 张，应为 0）`)

  // 13.5 行优惠合计 = 订单行的促销优惠合计（"优惠必须摊到行"这条硬口径的落库体现）
  //
  // **必须按来源通道分别比**（迁移 030）：`oms_orders.id` 与 `pos_orders.id` 独立自增、
  // 会撞号，把两者混在一张表里比，同号的两张单会互相抵消成"恰好相等"或"凭空不平"，
  // 而两种结果都不指向真实问题。
  // 排除已撤单（`closed`）：撤单会把留痕删掉，但订单行上的**结算快照**是历史事实，
  // 保留下来才能回答"这张废单当初减了多少"。拿它去比已被删的留痕没有意义。
  const allocDrift = q(`
    SELECT COUNT(*) c FROM (
      SELECT o.id,
             COALESCE((SELECT SUM(i.promo_discount_cents) FROM oms_order_items i WHERE i.oms_order_id=o.id),0) line_sum,
             COALESCE((SELECT SUM(a.amount) FROM promotion_adjustments a
                        WHERE a.source='oms' AND a.order_id=o.id),0) adj_sum
        FROM oms_orders o WHERE o.status NOT IN ('closed','cancelled')
    ) WHERE line_sum <> adj_sum`).c
  ok(allocDrift === 0, `行优惠合计 = 优惠留痕合计（不平 ${allocDrift} 单，应为 0）`)
  const allocDriftPos = q(`
    SELECT COUNT(*) c FROM (
      SELECT p.id,
             COALESCE((SELECT SUM(i.promo_discount_cents) FROM pos_order_items i WHERE i.pos_order_id=p.id),0) line_sum,
             COALESCE((SELECT SUM(a.amount) FROM promotion_adjustments a
                        WHERE a.source='pos' AND a.order_id=p.id),0) adj_sum
        FROM pos_orders p WHERE p.status <> 'voided'
    ) WHERE line_sum <> adj_sum`).c
  ok(allocDriftPos === 0, `门店单行优惠合计 = 门店留痕合计（不平 ${allocDriftPos} 单，应为 0）`)
  // 优惠留痕的每一行都必须指向真实存在的订单行（重建漏表会留下指向别家订单的旧留痕）
  const adjOrphan = q(`
    SELECT COUNT(*) c FROM promotion_adjustments a
     WHERE (a.source='oms' AND NOT EXISTS (SELECT 1 FROM oms_order_items i WHERE i.id=a.item_id))
        OR (a.source='pos' AND NOT EXISTS (SELECT 1 FROM pos_order_items i WHERE i.id=a.item_id))`).c
  ok(adjOrphan === 0, `优惠留痕均指向真实订单行（孤儿 ${adjOrphan} 行，应为 0）`)

  // 13.5b 来源通道自洽（迁移 030）：留痕/登记/券/积分流水上的 `source` 必须指到
  // **真实存在的**那张单上。这一条正是"oms 418 与 pos 418 撞号"的守卫 ——
  // 串到另一张单上的留痕在界面上完全看不出来，只有这条能抓。
  const srcOrphanOms = q(`
    SELECT COUNT(*) c FROM promotion_usages u
     WHERE u.source='oms' AND NOT EXISTS (SELECT 1 FROM oms_orders o WHERE o.id=u.order_id)`).c
  const srcOrphanPos = q(`
    SELECT COUNT(*) c FROM promotion_usages u
     WHERE u.source='pos' AND NOT EXISTS (SELECT 1 FROM pos_orders p WHERE p.id=u.order_id)`).c
  const srcNoChannel = q(`
    SELECT COUNT(*) c FROM promotion_usages WHERE source IS NULL OR source=''`).c
  ok(
    srcOrphanOms === 0 && srcOrphanPos === 0 && srcNoChannel === 0,
    `促销使用登记的来源通道自洽（oms 孤儿 ${srcOrphanOms} / pos 孤儿 ${srcOrphanPos} / 缺通道 ${srcNoChannel}，应为 0）`
  )
  const couponSrcOrphan = q(`
    SELECT COUNT(*) c FROM coupon_instances i
     WHERE i.status='used' AND i.order_id IS NOT NULL AND (i.source IS NULL OR i.source='')`).c
  ok(couponSrcOrphan === 0, `已核销券都带来源通道（缺通道 ${couponSrcOrphan} 张，应为 0）`)
  const ptsSrcMissing = q(`
    SELECT COUNT(*) c FROM member_points_ledger l
     WHERE l.source_type='order' AND (l.source IS NULL OR l.source='')`).c
  ok(ptsSrcMissing === 0, `订单积分流水都带来源通道（缺通道 ${ptsSrcMissing} 行，应为 0）`)

  // 13.6 券：状态与时间自洽
  const couponExpiredUnused = q(`
    SELECT COUNT(*) c FROM coupon_instances
     WHERE status='unused' AND expires_at IS NOT NULL AND expires_at < datetime('now','localtime')`).c
  ok(couponExpiredUnused === 0, `未使用的券没有已过期的（${couponExpiredUnused} 张，应为 0）`)
  const usedNoOrder = q("SELECT COUNT(*) c FROM coupon_instances WHERE status='used' AND order_id IS NULL").c
  ok(usedNoOrder === 0, `已核销的券都指向订单（缺单 ${usedNoOrder} 张，应为 0）`)
  const expiredNotPast = q(`
    SELECT COUNT(*) c FROM coupon_instances
     WHERE status='expired' AND (expires_at IS NULL OR expires_at >= datetime('now','localtime'))`).c
  ok(expiredNotPast === 0, `已过期的券确实已到期（异常 ${expiredNotPast} 张，应为 0）`)
  // 券的发行量与实例数一致（发行量漏加会让"已发满"判断提前触发）
  const issueDrift = all(`
    SELECT code, issued_qty, (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id=c.id) inst
      FROM coupons c WHERE issued_qty <> (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id=c.id)`)
  ok(issueDrift.length === 0, `券发行量 = 实例数（不一致 ${issueDrift.length} 张，应为 0）`)

  // 覆盖度：每个非退化形态至少有一个样本 —— 促销与会员"空的时候和没做好的时候长得一样"，
  // 所以这里把「样本存在」本身也变成断言（缺了不是错算，是演示看不见）。
  const lvRows = all('SELECT level_code, COUNT(*) c FROM member_accounts GROUP BY level_code')
  const lvSet = new Set(lvRows.map((r) => r.level_code))
  const missLv = ['normal', 'silver', 'gold', 'platinum'].filter((c) => !lvSet.has(c))
  ok(missLv.length === 0, `四个会员等级都有样本（缺 ${missLv.join('/') || '无'}）`)
  const ciRows = all('SELECT status, COUNT(*) c FROM coupon_instances GROUP BY status')
  const ciMap = Object.fromEntries(ciRows.map((r) => [r.status, r.c]))
  if (ciRows.length) {
    const missSt = ['unused', 'used', 'expired', 'void'].filter((s) => !ciMap[s])
    ok(missSt.length === 0, `券四态都有样本（缺 ${missSt.join('/') || '无'}）`)
  }
  const bgUsed = q("SELECT COALESCE(used,0) u FROM promotions WHERE code='BUYGET_3G1'")?.u
  if (bgUsed != null) ok(bgUsed > 0, `买赠促销有真实命中（used=${bgUsed}，应为 >0）`)

  const sumPts = q('SELECT COALESCE(SUM(points),0) p, COALESCE(SUM(points_total),0) t, COALESCE(SUM(balance_cents),0) b FROM member_accounts')
  const promoCounts = all('SELECT code, used FROM promotions ORDER BY used DESC, code LIMIT 4')
  console.log(`  会员账户 ${lvRows.reduce((s, r) => s + r.c, 0)} 个（${lvRows.map((r) => `${r.level_code} ${r.c}`).join(' / ')}）`)
  console.log(`  积分余额合计 ${sumPts.p} / 累计积分 ${sumPts.t} / 储值余额合计 ¥${(sumPts.b / 100).toFixed(2)}`)
  console.log(`  券模板 ${q('SELECT COUNT(*) c FROM coupons').c} / 券实例 ${q('SELECT COUNT(*) c FROM coupon_instances').c}（${ciRows.map((r) => `${r.status} ${r.c}`).join(' / ')}）`)
  console.log(`  促销 ${q('SELECT COUNT(*) c FROM promotions').c} / 使用登记 ${q('SELECT COUNT(*) c FROM promotion_usages').c} / 优惠留痕 ${q('SELECT COUNT(*) c FROM promotion_adjustments').c}`)
  console.log(`  used 最高的促销：${promoCounts.map((r) => `${r.code} ${r.used}`).join(' / ')}`)
// ---------------------------------------------------------------------------
// 14. 渠道管理自洽（协议价 / 返利核销）
//
// 这一域有两条"不报错但让账分叉"的形态：
//   · 协议价的 `target_type` 与 `target_id` 自洽 —— 不自洽的协议**永远不命中**，
//     而在列表页上看起来一切正常（"我明明配了协议价，为什么开单还是原价"）；
//   · 返利核销的三条等式 —— 已核销必挂核销单、明细合计 = 总额、冲减 + 未冲 = 总额。
//     破了任何一条，账面都只是"数对不上"，看不出是哪一步。
// 另外把"核销单指向的经销商 / 返利"也做一次跨代引用自洽（重建漏表会留下指向别家的旧单）。
// ---------------------------------------------------------------------------
if (q("SELECT 1 AS h FROM sqlite_master WHERE type='table' AND name='price_agreements'")) {
  console.log('\n14. 渠道管理自洽（协议价 / 返利核销）')

  const agBad = q(`
    SELECT COUNT(*) c FROM price_agreements
     WHERE (target_type='all' AND target_id IS NOT NULL)
        OR (target_type<>'all' AND target_id IS NULL)
        OR target_type NOT IN ('sku','category','all')
        OR price_type NOT IN ('fixed','discount')
        OR (price_type='fixed' AND price <= 0)
        OR (price_type='discount' AND (discount_bp <= 0 OR discount_bp >= 10000))
        OR min_qty <= 0`).c
  ok(agBad === 0, `协议价的类型 / 目标 / 价格形态自洽（异常 ${agBad} 条，应为 0）`)

  const agPeriod = q(`
    SELECT COUNT(*) c FROM price_agreements
     WHERE effect_from IS NOT NULL AND effect_to IS NOT NULL AND effect_from > effect_to`).c
  ok(agPeriod === 0, `协议合同周期起不晚于止（异常 ${agPeriod} 条，应为 0）`)

  const agDealer = q(`
    SELECT COUNT(*) c FROM price_agreements a
     WHERE NOT EXISTS (SELECT 1 FROM dealers d WHERE d.id = a.dealer_id)`).c
  ok(agDealer === 0, `协议价都指向真实经销商（孤儿 ${agDealer} 条，应为 0）`)

  const paidNoSettle = q(`
    SELECT COUNT(*) c FROM dealer_rebates WHERE status='paid' AND settlement_id IS NULL`).c
  ok(paidNoSettle === 0, `已核销的返利都挂着核销单（缺单 ${paidNoSettle} 笔，应为 0）`)

  const settleDealer = q(`
    SELECT COUNT(*) c FROM rebate_settlements s
     WHERE NOT EXISTS (SELECT 1 FROM dealers d WHERE d.id = s.dealer_id)`).c
  ok(settleDealer === 0, `核销单都指向真实经销商（孤儿 ${settleDealer} 张，应为 0）`)

  const itemSum = q(`
    SELECT COUNT(*) c FROM (
      SELECT s.id, s.total_amount,
             COALESCE((SELECT SUM(i.amount) FROM rebate_settlement_items i WHERE i.settlement_id=s.id),0) item_sum
        FROM rebate_settlements s WHERE s.status='confirmed'
    ) WHERE ABS(total_amount - item_sum) > 0.005`).c
  ok(itemSum === 0, `核销明细合计 = 核销单返利总额（不平 ${itemSum} 张，应为 0）`)

  const moneySum = q(`
    SELECT COUNT(*) c FROM rebate_settlements
     WHERE status='confirmed'
       AND ABS(total_amount - (ar_offset_amount + unoffset_amount)) > 0.005`).c
  ok(moneySum === 0, `核销单的「冲减 + 未冲减」= 返利总额（不平 ${moneySum} 张，应为 0）`)

  const allocSum = q(`
    SELECT COUNT(*) c FROM (
      SELECT s.id, s.ar_offset_amount,
             COALESCE((SELECT SUM(i.ar_offset_amount) FROM rebate_settlement_items i WHERE i.settlement_id=s.id),0) item_off
        FROM rebate_settlements s WHERE s.status='confirmed'
    ) WHERE ABS(ar_offset_amount - item_off) > 0.005`).c
  ok(allocSum === 0, `明细的冲减分摊合计 = 核销单冲减额（不平 ${allocSum} 张，应为 0）`)

  const settleDrift = all(`
    SELECT r.id, r.status, r.settlement_id,
           (SELECT s.status FROM rebate_settlements s WHERE s.id = r.settlement_id) AS settle_status
      FROM dealer_rebates r WHERE r.settlement_id IS NOT NULL`)
  ok(
    settleDrift.every((r) => r.settle_status === 'confirmed' && r.status === 'paid'),
    `挂单的返利与核销单状态一致（异常 ${settleDrift.filter((r) => !(r.settle_status === 'confirmed' && r.status === 'paid')).length} 笔，应为 0）`
  )

  const arNonNeg = q('SELECT COUNT(*) c FROM ar_documents WHERE amount < 0').c
  ok(arNonNeg === 0, `应收金额没有被冲成负数（${arNonNeg} 行，应为 0）`)

  const agCount = q('SELECT COUNT(*) c FROM price_agreements').c
  const rbByStatus = all('SELECT status, COUNT(*) c FROM dealer_rebates GROUP BY status')
  const stCount = q('SELECT COUNT(*) c FROM rebate_settlements').c
  const stByStatus = all('SELECT status, COUNT(*) c FROM rebate_settlements GROUP BY status')
  const unoffsetCount = q('SELECT COUNT(*) c FROM rebate_settlements WHERE unoffset_amount > 0').c
  console.log(`  协议价 ${agCount} 条（生效 ${q("SELECT COUNT(*) c FROM price_agreements WHERE status='active'").c}）`)
  console.log(`  返利记录 ${rbByStatus.reduce((s, r) => s + r.c, 0)} 条（${rbByStatus.map((r) => `${r.status} ${r.c}`).join(' / ') || '无'}）`)
  console.log(`  核销单 ${stCount} 张（${stByStatus.map((r) => `${r.status} ${r.c}`).join(' / ') || '无'}；含未冲减 ${unoffsetCount} 张）`)
}

// ---------------------------------------------------------------------------
// 15. 财务凭证自洽（科目 / 凭证 / 试算平衡）
//
// 这一域最危险的地方是：**一张平的错账和一张平的对账长得一模一样**。
// 所以这里查的不是"有没有凭证"，而是那些"错了也不会报错"的形态：
//   · 凭证头金额与分录合计分叉（头是冗余，冗余就会各说各话）；
//   · 分录挂在父科目上（「父科目 = 子科目之和」悄悄不成立）；
//   · 同一来源入两次账（金额翻倍，但两次都"有来源、能解释"）；
//   · 期间与记账日不一致（本期账凭空多/少一块）；
//   · 凭证指向**上一代**已重建掉的业务单据 id（重建漏表 ⇒ 一本账混进两代业务）。
// 最后再加一条总账试算：全部已过账分录的借合计必须等于贷合计。
// ---------------------------------------------------------------------------
if (q("SELECT 1 AS h FROM sqlite_master WHERE type='table' AND name='vouchers'")) {
  console.log('\n15. 财务凭证自洽（科目 / 凭证 / 试算平衡）')

  const entryBad = q('SELECT COUNT(*) c FROM voucher_entries WHERE amount <= 0').c
  ok(entryBad === 0, `分录金额都为正（异常 ${entryBad} 条，应为 0）`)

  const dirBad = q("SELECT COUNT(*) c FROM voucher_entries WHERE direction NOT IN ('debit','credit')").c
  ok(dirBad === 0, `分录方向取值合法（异常 ${dirBad} 条，应为 0）`)

  const unbal = q(`
    SELECT COUNT(*) c FROM vouchers
     WHERE status IN ('draft','posted') AND ABS(total_debit - total_credit) > 0.005`).c
  ok(unbal === 0, `凭证借贷平衡（不平 ${unbal} 张，应为 0）`)

  const headDrift = q(`
    SELECT COUNT(*) c FROM vouchers v WHERE EXISTS (SELECT 1 FROM voucher_entries e WHERE e.voucher_id=v.id)
      AND ABS(v.total_debit - (SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount END),0)
                                 FROM voucher_entries WHERE voucher_id=v.id)) > 0.005`).c
  ok(headDrift === 0, `凭证头的借方合计 = 分录合计（分叉 ${headDrift} 张，应为 0）`)

  const onParent = q(`
    SELECT COUNT(*) c FROM voucher_entries e JOIN accounting_subjects s ON s.id=e.subject_id WHERE s.is_leaf=0`).c
  ok(onParent === 0, `分录都挂在叶子科目上（挂父科目 ${onParent} 条，应为 0）`)

  const dupSource = q(`
    SELECT COUNT(*) c FROM (SELECT biz_type, source_type, source_id FROM vouchers
                             GROUP BY biz_type, source_type, source_id HAVING COUNT(*) > 1)`).c
  ok(dupSource === 0, `同一事实只入一次账（重复 ${dupSource} 组，应为 0）`)

  const periodBad = q("SELECT COUNT(*) c FROM vouchers WHERE period <> substr(voucher_date,1,7)").c
  ok(periodBad === 0, `凭证期间 = 记账日期前 7 位（异常 ${periodBad} 张，应为 0）`)

  // 跨代引用：凭证指向的业务单据必须真实存在（重建漏清 `vouchers` 时，这条会红）
  const orphan = q(`
    SELECT COUNT(*) c FROM vouchers v WHERE
      (v.source_type='purchase_receipts'  AND NOT EXISTS (SELECT 1 FROM purchase_receipts  x WHERE x.id=v.source_id))
   OR (v.source_type='sales_deliveries'   AND NOT EXISTS (SELECT 1 FROM sales_deliveries   x WHERE x.id=v.source_id))
   OR (v.source_type='receipts'           AND NOT EXISTS (SELECT 1 FROM receipts           x WHERE x.id=v.source_id))
   OR (v.source_type='purchase_payments'  AND NOT EXISTS (SELECT 1 FROM purchase_payments  x WHERE x.id=v.source_id))`).c
  ok(orphan === 0, `凭证的来源单据都真实存在（孤儿 ${orphan} 张，应为 0）`)

  const voidNoReason = q("SELECT COUNT(*) c FROM vouchers WHERE status='voided' AND (void_reason IS NULL OR void_reason='')").c
  ok(voidNoReason === 0, `作废凭证都写了理由（缺理由 ${voidNoReason} 张，应为 0）`)

  const subjSelf = q('SELECT COUNT(*) c FROM accounting_subjects WHERE parent_id = id').c
  ok(subjSelf === 0, `科目没有自指（自指 ${subjSelf} 个，应为 0）`)

  // **总账试算**：这是这一域唯一一条"汇总级"不变量
  const g = q(`
    SELECT COALESCE(SUM(CASE WHEN e.direction='debit'  THEN e.amount END),0) d,
           COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount END),0) c
      FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.status='posted'`)
  ok(Math.abs(g.d - g.c) <= 0.005, `总账试算平衡：借 ${Number(g.d).toFixed(2)} = 贷 ${Number(g.c).toFixed(2)}（差 ${Number(g.d - g.c).toFixed(2)}，应为 0）`)

  // 演示数据形态：科目 / 模板 / 凭证三件都要在，且**两种状态都有样本**
  const nSubj = q('SELECT COUNT(*) c FROM accounting_subjects').c
  const nLeaf = q('SELECT COUNT(*) c FROM accounting_subjects WHERE is_leaf=1').c
  const nTpl = q('SELECT COUNT(*) c FROM voucher_templates').c
  const vByBiz = all('SELECT biz_type, COUNT(*) c FROM vouchers GROUP BY biz_type ORDER BY biz_type')
  const vByStatus = all('SELECT status, COUNT(*) c FROM vouchers GROUP BY status')
  const nPosted = q("SELECT COUNT(*) c FROM vouchers WHERE status='posted'").c
  const nDraft = q("SELECT COUNT(*) c FROM vouchers WHERE status='draft'").c
  const periods = all('SELECT period, COUNT(*) c FROM vouchers GROUP BY period ORDER BY period')
  ok(nSubj >= 20, `科目表已灌（${nSubj} 个，其中可记账叶子 ${nLeaf} 个）`)
  // ⚠️ 这两个数字**刻意钉死**（不是派生）：派生出来的数永远等于它自己，抓不到"顺手多了一套模板"。
  // 本轮补「采购退货的会计落点」加了 `purchase_return`：模板 6 → 7、业务场景 7 → 8。
  ok(nTpl === 7, `凭证模板 7 套（采购入库 / 销售出库 / 结转成本 / 收款 / 付款 / 退款 / 采购退货；实际 ${nTpl}）`)
  // **模板 7 套，业务场景 8 种** —— 差的这一种就是期末结转（`profit_carry`）。
  // 它**刻意不走模板**：模板回答的是"这笔业务该记成哪几笔分录"（业务形态无穷，所以要配置），
  // 而结转回答的是"把损益科目余额搬到本年利润"（这是一个算法，没有可选项），
  // 且它的分录**行数由余额决定**（有几个损益科目有余额就有几行），模板的固定行装不下。
  // 详见 `lib/closing.js` 与迁移 035 的注释二。
  ok(vByBiz.length === 8, `八种业务场景都有凭证样本（七套模板 + 期末结转；实际 ${vByBiz.length} 种）`)
  ok(nPosted > 0, `有已过账样本（${nPosted} 张，试算平衡表才不空）`)
  ok(nDraft > 0, `有未过账样本（${nDraft} 张，"生成"与"入账"是两步要看得出来）`)
  console.log(`  会计科目 ${nSubj} 个（叶子 ${nLeaf}） / 凭证模板 ${nTpl} 套`)
  console.log(`  凭证 ${vByStatus.reduce((s, r) => s + r.c, 0)} 张（${vByStatus.map((r) => `${r.status} ${r.c}`).join(' / ') || '无'}）`)
  console.log(`  按场景：${vByBiz.map((r) => `${r.biz_type} ${r.c}`).join(' / ')}`)
  console.log(`  期间：${periods.map((r) => `${r.period} ${r.c}`).join(' / ')}`)
  console.log(`  总账试算：借 ${Number(g.d).toFixed(2)} / 贷 ${Number(g.c).toFixed(2)}`)
}

// ---------------------------------------------------------------------------
// 16. 整库重建清单的完整性（库里每一张表都必须落在 TABLES 或 KEEP_TABLES 之一）
//
// 漏登记一张表的表现**不是报错**：
//   · `price_change_logs` 漏了 ⇒ 每轮重建 +7 条 ⇒ **重建不可复现**（verify-reseed 抓到的唯一漂移项）；
//   · `mcp_idempotency` 漏了 ⇒ 重建后自增 id 被复用，重放返回**上一个世界**的结果（跨代引用）。
// 所以这里把"有意保留"也显式列出来，让**新增表忘记登记**在这一节立刻变红，
// 而不是等某次整库重建才发现 —— 那种发现的代价是"定位到的报错点离真因隔着好几层"。
// ---------------------------------------------------------------------------
{
  const declared = new Set([...TABLES, ...KEEP_TABLES])
  const keepSet = new Set(KEEP_TABLES)
  const inDb = all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").map((r) => r.name)

  const undeclared = inDb.filter((t) => !declared.has(t))
  ok(undeclared.length === 0, `每张表都在清理清单或豁免清单里（未登记 ${undeclared.length} 张：${undeclared.slice(0, 6).join(', ') || '无'}）`)

  const overlap = TABLES.filter((t) => keepSet.has(t))
  ok(overlap.length === 0, `清理清单与豁免清单不重叠（重叠：${overlap.join(', ') || '无'}）`)

  // 这几张是历史上真实踩过的"跨代必清"：留痕（doc_events）· 取号计数器（doc_no_counters）·
  // 库存派生物（inventory_batches / inventory_reservations）· 改价留痕 · MCP 幂等缓存
  const mustClean = [
    'doc_events', 'doc_no_counters', 'inventory_batches', 'inventory_reservations',
    'price_change_logs', 'mcp_idempotency'
  ]
  const notClean = mustClean.filter((t) => !TABLES.includes(t))
  ok(notClean.length === 0, `六张"跨代必清"的表都在清理清单里（缺：${notClean.join(', ') || '无'}）`)

  console.log(`  表清单：清理 ${TABLES.length} 张 / 豁免 ${KEEP_TABLES.length} 张 / 库中 ${inDb.length} 张`)

  // -------------------------------------------------------------------------
  // 十七、退款域自洽（批次 J）
  //
  // 这一批补的是「退货登记了待退款，但没有任何东西能把它兑现成出账」。
  // 所以本节要回答：**这个域现在是不是自洽的** ——
  //   ① 已退款的单必须挂确认人（"谁放的这笔钱"）；
  //   ② 作废必须写理由（"为什么这笔不算了"）；
  //   ③ 明细合计 = 单头金额；明细不指向已消失的退货单；
  //   ④ **按退货单累计的已确认退款额 ≤ 该单的待退款额**（退款上限的周期性复核）；
  //   ⑤ 草稿**不**占用额度（"先建单、后作废"不能成为一条死路）；
  //   ⑥ 已确认退款单生成的凭证必须平衡且挂对科目（借 2203 / 贷 1002）。
  // -------------------------------------------------------------------------
  const one = (s, ...a) => Number(q(s, ...a)?.c ?? 0)
  const refCount = one('SELECT COUNT(*) c FROM refunds')
  if (refCount > 0) {
    const noSigner = one(
      "SELECT COUNT(*) c FROM refunds WHERE status='confirmed' AND (confirmed_by_name IS NULL OR confirmed_at IS NULL)"
    )
    ok(noSigner === 0, `已退款的退款单都挂着确认人与确认时间（缺 ${noSigner} 张）`)
    const voidNoReason = one("SELECT COUNT(*) c FROM refunds WHERE status='voided' AND (void_reason IS NULL OR TRIM(void_reason)='')")
    ok(voidNoReason === 0, `已作废的退款单都写着理由（缺 ${voidNoReason} 张）`)

    const mismatch = one(`
      SELECT COUNT(*) c FROM refunds r
       WHERE ABS(r.amount - COALESCE((SELECT SUM(i.amount) FROM refund_items i WHERE i.refund_id=r.id),0)) > 0.005
    `)
    ok(mismatch === 0, `退款单头行一致（头金额 = 明细合计；不一致 ${mismatch} 张）`)

    const orphan = one('SELECT COUNT(*) c FROM refund_items i WHERE NOT EXISTS (SELECT 1 FROM sales_returns s WHERE s.id=i.return_id)')
    ok(orphan === 0, `退款明细都指向真实退货单（孤儿 ${orphan} 条）`)

    const over = all(`
      SELECT ret.doc_no, ret.refund_due, SUM(i.amount) refunded
        FROM refund_items i
        JOIN refunds rf ON rf.id=i.refund_id AND rf.status='confirmed'
        JOIN sales_returns ret ON ret.id=i.return_id
       GROUP BY i.return_id
      HAVING SUM(i.amount) - ret.refund_due > 0.005
    `)
    ok(over.length === 0, `按退货单累计的已确认退款额都不超待退款额（超退 ${over.length} 张：${over.slice(0, 3).map((o) => o.doc_no).join(', ') || '无'}）`)

    // 与界面同口径复算"还能退多少"：草稿不占用额度
    const list = all("SELECT id FROM sales_returns WHERE status='confirmed' AND refund_due > 0 ORDER BY id LIMIT 20")
    let wrong = 0
    for (const r of list) {
      const due = Number(q('SELECT refund_due v FROM sales_returns WHERE id=?', r.id)?.v || 0)
      const confirmed = one(
        `SELECT COALESCE(SUM(i.amount),0) c FROM refund_items i
           JOIN refunds rf ON rf.id=i.refund_id AND rf.status='confirmed'
          WHERE i.return_id=?`,
        r.id
      )
      const refundable = Math.round((due - confirmed) * 100) / 100
      // 可退余额只看已确认；草稿再多也不能把它压低
      if (refundable < -0.005) wrong += 1
    }
    ok(wrong === 0, `可退余额复算无不合理负值（异常 ${wrong} 张）`)

    // 已确认的退款单：若已生成凭证，必须平衡且挂对科目
    const confirmedRefunds = all("SELECT id, doc_no, amount FROM refunds WHERE status='confirmed' ORDER BY id LIMIT 5")
    let vWrong = 0
    for (const rf of confirmedRefunds) {
      const v = db.prepare("SELECT * FROM vouchers WHERE biz_type='refund' AND source_type='refunds' AND source_id=?").get(rf.id)
      if (!v) continue // 未生成凭证不是错：与其它业务场景一致，生成是显式动作
      if (Math.abs(Number(v.total_debit) - Number(v.total_credit)) > 0.005) vWrong += 1
      const d = one("SELECT COUNT(*) c FROM voucher_entries WHERE voucher_id=? AND direction='debit' AND subject_code='2203'", v.id)
      const c = one("SELECT COUNT(*) c FROM voucher_entries WHERE voucher_id=? AND direction='credit' AND subject_code='1002'", v.id)
      if (d < 1 || c < 1) vWrong += 1
    }
    ok(vWrong === 0, `退款凭证借贷平衡且挂对科目（借 2203 / 贷 1002；异常 ${vWrong} 张）`)

    const byStatus = all('SELECT status, COUNT(*) c FROM refunds GROUP BY status')
    const refundableReturns = all("SELECT id FROM sales_returns WHERE status='confirmed' AND refund_due > 0").length
    console.log(
      `  退款单 ${refCount} 张（${byStatus.map((r) => `${r.status} ${r.c}`).join(' / ')}）；可退退货单 ${refundableReturns} 张`
    )
  } else {
    ok(true, '本次未造退款单（退款域自洽检查跳过）')
  }

  // -------------------------------------------------------------------------
  // 十八、报表域自洽（批次 L）
  //
  // 这一批补的是「账记了，但读不出来」。本节要回答：**三张报表现在自证通过吗** ——
  //   ① 三张报表定义与口径齐全；
  //   ② 三条恒等式（资产＝负债＋权益 / 净利润＝损益类发生额 / 现金流净增加额＝现金科目变动）
  //      都由 `lib/report.js` 的 `auditReport` 判定，**不在这里另写一遍**；
  //   ③ 期初余额平衡（不平的期初会让之后每一期都不平，且差额来源从此不可考）；
  //   ④ 已关账的期间里不能再有未过账凭证（那两张会被永远挡在账外）。
  // -------------------------------------------------------------------------
  const repDefs = listReportDefs(db)
  if (repDefs.length === 0) {
    ok(true, '本次未建报表定义（报表域自洽检查跳过）')
  } else {
    ok(repDefs.length === 3, `三张报表定义齐全（实际 ${repDefs.length} 张：${repDefs.map((d) => d.report_code).join('/')}）`)
    ok(repDefs.every((d) => d.line_count > 0), `每张报表都有行定义（${repDefs.map((d) => `${d.report_code}:${d.line_count}`).join(' ')}）`)

    // 挑"最近一个有已过账凭证的期间" —— 空期间的三张报表全 0，恒等式成立但什么也验不出来
    const busy = availablePeriods(db).find((x) => x.posted_count > 0) || availablePeriods(db)[0]
    if (!busy) {
      ok(false, '库里没有任何凭证 —— 报表域无从复核（演示数据不该出现这种情况）')
    } else {
      const audit = auditReport(db, { period: busy.period })
      ok(audit.ok, `报表自证通过（期间 ${busy.period}）${audit.ok ? '' : '：' + audit.problems.map((p) => p.code).join(',')}`)
      for (const p of audit.problems) ok(false, `  报表自证问题「${p.code}」：${p.message}`)

      const assets = audit.totals.assets
      const liab = audit.totals.liabilities
      const equity = audit.totals.equity
      if (assets !== null && liab !== null && equity !== null) {
        ok(Math.abs(assets - (liab + equity)) <= 0.005, `资产 = 负债 + 所有者权益（${assets} = ${liab} + ${equity}）`)
      }
      const bal = subjectBalances(db, { period: busy.period })
      ok(
        Math.abs(bal.movement.total_debit - bal.movement.total_credit) <= 0.005,
        `本期发生额借贷平衡（借 ${bal.movement.total_debit} = 贷 ${bal.movement.total_credit}）`
      )

      // 期初余额：登记过就必须平衡（滚动基准那一期）
      const base = all('SELECT period FROM accounting_opening_balances ORDER BY period DESC LIMIT 1')[0]
      if (base) {
        const ob = q(
          'SELECT ROUND(SUM(debit_amount),2) d, ROUND(SUM(credit_amount),2) c FROM accounting_opening_balances WHERE period=?',
          base.period
        )
        ok(Math.abs(Number(ob.d) - Number(ob.c)) <= 0.005, `期初余额平衡（${base.period}：借 ${ob.d} = 贷 ${ob.c}）`)
      } else {
        ok(true, '演示库未登记期初余额（报表按 0 起算，自证仍然成立）')
      }

      // 已关账期间不得残留未过账凭证（关账本身会拦，这里是复核"没被绕过"）
      const closedDraft = all(`
        SELECT p.period, COUNT(*) c FROM accounting_periods p
          JOIN vouchers v ON v.period = p.period AND v.status='draft'
         WHERE p.status='closed' GROUP BY p.period
      `)
      ok(closedDraft.length === 0, `已关账期间没有残留未过账凭证（${closedDraft.map((r) => `${r.period}:${r.c}`).join(',') || '无'}）`)

      console.log(
        `  期间 ${busy.period}：资产 ${assets} / 负债 ${liab} / 权益 ${equity}；`
        + `净利润 ${audit.totals.net_profit}；现金净增加额 ${audit.totals.cash_net_increase}`
        + `；复合凭证 ${audit.cash_complex_vouchers} 张`
      )
    }
  }

  // -------------------------------------------------------------------------
  // 十九、结转域自洽（批次 M）
  //
  // 这一批补的是「账平了，但利润还挂在损益科目上」。本节要回答四件事：
  //   ① 演示库有**真正做过结转**的期间（否则这一批在演示环境里看不见效果）；
  //   ② 结转凭证与期间记录**互相自洽**（期间说结转了，凭证就得在、得是 posted、得落在同一期）；
  //   ③ 已结转的期间里损益科目**确实归零**（"结平"不能只写在状态字里）；
  //   ④ 已关账的期间都已结平（这是本批新增的关账前置，这里复核"没被绕过"）。
  // 至于"结转前后利润表的净利润一致"，由 `auditReport` 的 `PL_MISMATCH` 兜底，
  // **这里不另算一遍** —— 同一份判据只有一个实现。
  // -------------------------------------------------------------------------
  const carriedPeriods = all(`
    SELECT p.period, p.status AS period_status, p.closing_voucher_id,
           v.doc_no, v.status AS voucher_status, v.period AS voucher_period
      FROM accounting_periods p LEFT JOIN vouchers v ON v.id = p.closing_voucher_id
     WHERE p.closing_voucher_id IS NOT NULL ORDER BY p.period
  `)
  const carryVouchers = all("SELECT id, doc_no, period, status FROM vouchers WHERE biz_type='profit_carry' ORDER BY id")
  if (carryVouchers.length === 0) {
    ok(false, '演示库没有任何期末结转凭证（report-seed 的 CARRY_PERIODS 没生效 —— 这一批在演示环境里看不见效果）')
  } else {
    ok(
      carriedPeriods.length === carryVouchers.length,
      `结转凭证与期间记录一一对应（期间侧 ${carriedPeriods.length} / 凭证侧 ${carryVouchers.length}）`
    )
    for (const r of carriedPeriods) {
      ok(r.voucher_status === 'posted', `期间 ${r.period} 的结转凭证 ${r.doc_no} 已过账（实际 ${r.voucher_status}）`)
      ok(r.voucher_period === r.period, `结转凭证落在它所结转的那个期间（${r.doc_no} 记在 ${r.voucher_period}）`)
      const pending = uncarriedProfitSubjects(db, { period: r.period })
      ok(pending.length === 0, `已结转的期间 ${r.period} 损益科目已归零（残留 ${pending.map((x) => x.code).join(',') || '无'}）`)
      const dr = q("SELECT ROUND(SUM(amount),2) d FROM voucher_entries WHERE voucher_id=? AND direction='debit'", r.closing_voucher_id)
      const cr = q("SELECT ROUND(SUM(amount),2) c FROM voucher_entries WHERE voucher_id=? AND direction='credit'", r.closing_voucher_id)
      ok(Math.abs(Number(dr.d) - Number(cr.c)) <= 0.005, `结转凭证 ${r.doc_no} 借贷平衡（借 ${dr.d} = 贷 ${cr.c}）`)
    }
  }
  const closedNoCarry = all("SELECT period FROM accounting_periods WHERE status='closed'")
    .filter((r) => uncarriedProfitSubjects(db, { period: r.period }).length > 0)
  ok(
    closedNoCarry.length === 0,
    `已关账期间都已结平（未结平的：${closedNoCarry.map((r) => r.period).join(',') || '无'}）`
  )

  // -------------------------------------------------------------------------
  // 二十、跨期比较与展开自洽（批次 N）
  //
  // 这一批补的是「报表只能一期一期看」。本节要回答四件事：
  //   ① **期初接得上**：每一期的期初 = 上一期的期末（逐科目，全期间扫描）；
  //   ② **比较可信**：两列等于"单独打开那一期"、差额等于两列相减、基期由模式唯一决定；
  //   ③ **导出即视图**：导出的行数与内容就是报表本身（不另写取数路径）；
  //   ④ **展开对得上汇总**：试算平衡表的逐行展开合计 = 汇总行的借贷。
  // ①与②**不在这里另写一遍判据**，而是调报表域自己的 `auditReport` / `auditComparison` ——
  // 同一份判据只有一个实现，"复核"才有意义（两处各写一遍的结果一定是只有一处会响）。
  // -------------------------------------------------------------------------
  const allPeriods = availablePeriods(db)
  const cmpPeriods = allPeriods.filter((x) => x.posted_count > 0).map((x) => x.period)
  ok(cmpPeriods.length > 0, `存在有已过账凭证的期间可供比较（${cmpPeriods.length} 个：${cmpPeriods.join('、')}）`)

  const openingIssues = []
  for (const p of allPeriods.map((x) => x.period)) {
    const au = auditReport(db, { period: p })
    const hit = (au.problems || []).find((x) => x.code === 'OPENING_NE_BASE_CLOSE')
    if (hit) openingIssues.push(`${p}：${hit.message.slice(0, 70)}`)
  }
  ok(
    openingIssues.length === 0,
    `逐期间的「本期期初 = 上期期末」自证通过（异常 ${openingIssues.length} 个期间${openingIssues.length ? `：${openingIssues[0]}` : ''}）`
  )

  let cmpChecked = 0
  const cmpBad = []
  for (const p of cmpPeriods) {
    for (const code of ['bs', 'pl', 'cf']) {
      for (const mode of ['previous', 'yoy']) {
        const a = auditComparison(db, { reportCode: code, period: p, mode })
        if (!a.ok) cmpBad.push(`${code}/${p}/${mode}：${(a.problems || []).map((x) => x.code).join(',')}`)
        cmpChecked += 1
      }
    }
  }
  ok(
    cmpBad.length === 0,
    `跨期比较自证通过（${cmpChecked} 组 = ${cmpPeriods.length} 期 × 3 表 × 2 模式${cmpBad.length ? `；异常：${cmpBad.slice(0, 3).join(' / ')}` : ''}）`
  )

  const exBad = []
  for (const p of cmpPeriods) {
    for (const code of ['bs', 'pl', 'cf']) {
      const rep = computeReport(db, { reportCode: code, period: p })
      const out = exportReport(db, { reportCode: code, period: p })
      // 数据行 = 表头 + 报表行；**其余非空行一律是 `#` 开头的注释**（期间 / 口径 / 生成时间）。
      // 不再写死"注释有 1 行"——那个数字会随着注释内容变化而失效，
      // 而失效的断言通常被"顺手改大一点"糊过去，而不是被认真看一眼。
      const lines = out.content.split('\r\n').filter((x) => x !== '')
      const dataLines = lines.filter((x) => !x.replace(/^\uFEFF/, '').startsWith('#'))
      if (dataLines.length !== rep.rows.length + 1) {
        exBad.push(`${code}/${p}：数据行 ${dataLines.length} ≠ ${rep.rows.length}+1`)
      }
      const commentLines = lines.length - dataLines.length
      if (commentLines < 1) exBad.push(`${code}/${p}：一条注释都没有（生成时间与口径应当写进文件）`)
      const width = dataLines[0].split(',').length
      if (dataLines.some((x) => x.split(',').length !== width)) {
        exBad.push(`${code}/${p}：数据行的列数与表头不一致（表格会被读歪）`)
      }
      if (!out.content.startsWith('\uFEFF')) exBad.push(`${code}/${p}：缺 BOM`)
    }
  }
  ok(exBad.length === 0, `导出即视图（数据行 = 表头 + 报表行、列数一致、注释在末尾、带 BOM）${exBad.length ? `；异常：${exBad.slice(0, 3).join(' / ')}` : ''}`)

  let detailRows = 0
  let detailBad = null
  for (const p of cmpPeriods) {
    const tb = trialBalance(db, { period: p })
    for (const r of tb.rows) {
      const d = trialBalanceDetail(db, { period: p, subjectCode: r.code })
      if (
        Math.abs(Number(d.total_debit) - Number(r.debit)) > 0.005
        || Math.abs(Number(d.total_credit) - Number(r.credit)) > 0.005
      ) {
        detailBad = `${p} 的 ${r.code}：明细 ${d.total_debit}/${d.total_credit} ≠ 汇总 ${r.debit}/${r.credit}`
      }
      detailRows += 1
    }
  }
  ok(
    !detailBad,
    `试算平衡表逐行展开与汇总一致（${cmpPeriods.length} 期 · ${detailRows} 个科目行）${detailBad ? `；异常：${detailBad}` : ''}`
  )

  console.log(
    `  跨期比较：${cmpChecked} 组自证通过；展开核对 ${detailRows} 个科目行；`
    + `期间 ${cmpPeriods.join('、')}`
  )

  // -------------------------------------------------------------------------
  // 二十一、年度结转与分配自洽（批次 O）
  //
  // 这一批补的是「月结做了，年结没做」。本节要回答五件事：
  //   ① 年结与分配的**前提科目**齐不齐（缺一个，功能就是"看得到、点不动"）；
  //   ② 报表口径**覆盖**这些科目（少覆盖一行，兜底行就会有金额 —— 而报表仍然是平的）；
  //   ③ 逐期间的报表域自证通过（含年度结转那四条探针，**全库扫描**）；
  //   ④ 不可年结的年度**说得出具体原因**（不是一句"不能年结"）；
  //   ⑤ 已年结的年度：4103 归零 + 该年度全部期间已关账。
  // 「年结的完整链路」（月结 → 年结 → 分配 → 反向撤销）由 `test-annual.mjs`
  // 用一个自造年度（2024）走完，**不在演示库上做** —— 演示库的 2026 年还没结束，
  // 对一个未结束的年度封账会让演示环境再也记不了账。
  // -------------------------------------------------------------------------
  const annualRows = listAnnual(db)
  ok(annualRows.length > 0, `账上存在可年结的年度（${annualRows.map((x) => x.year).join('、') || '无'}）`)

  for (const [code, cat, want] of [
    ['4103', 'equity', '月度结转的目标：本年利润'],
    ['4104', 'equity', '年度结转的目标：未分配利润'],
    ['4105', 'equity', '分配的去处之一：盈余公积'],
    ['2232', 'liability', '分配的去处之二：应付股利（宣告那一刻就欠了股东钱 ⇒ 负债侧）']
  ]) {
    const s = q('SELECT code, name, category, is_leaf, status FROM accounting_subjects WHERE code=?', code)
    ok(
      !!s && s.status === 'active' && Number(s.is_leaf) === 1 && s.category === cat,
      `科目 ${code}（${want}）存在、启用、叶子、类别=${cat}` + (s ? `（实际 ${s.category}/${s.status}/leaf=${s.is_leaf}）` : '（**不存在**）')
    )
  }

  const probeProblems = []
  for (const x of availablePeriods(db)) {
    const a = auditReport(db, { period: x.period })
    if (!a.ok) probeProblems.push(`${x.period}：${a.problems.map((p) => p.code).join(',')}`)
  }
  ok(
    probeProblems.length === 0,
    `逐期间的报表域自证通过（含年度结转四条探针）${probeProblems.length ? `；异常：${probeProblems.slice(0, 2).join(' / ')}` : ''}`
  )

  const notReady = annualRows.filter((x) => !x.can_carry)
  ok(
    notReady.every((x) => x.blocked.length > 0 && !!x.blocked_message),
    `不可年结的年度都给出了具体原因（${notReady.map((x) => `${x.year}:${x.blocked.join(',')}`).join(' / ') || '无不可年结的年度'}）`
  )

  const carriedYears = annualRows.filter((x) => x.carried)
  if (carriedYears.length === 0) {
    ok(true, '演示库当前没有已年结的年度（年结链路由 `test-annual.mjs` 用自造年度完整验证 —— 演示库的 2026 年尚未结束，不该封账）')
  } else {
    for (const x of carriedYears) {
      ok(Math.abs(x.carry_profit) <= 0.005, `${x.year} 已年结 → 4103 余额归零（实际 ${x.carry_profit}）`)
      ok(x.closed_periods === x.periods, `${x.year} 已年结 → 该年度全部期间已关账（${x.closed_periods}/${x.periods}）`)
    }
  }

  console.log(
    `  年度：${annualRows.map((x) => `${x.year}(${x.periods}期/${x.carried ? '已年结' : x.blocked.join('+') || '可年结'})`).join('、')}`
  )

  // -------------------------------------------------------------------------
  // 二十二、本年累计与列定义自洽（批次 P）
  //
  // 这一批补的是「报表只能看"这一期"和"上一期"」。本节要回答五件事：
  //   ① **窗口对**：累计的区间必须恰好是「本期所在年度的 1 月 ~ 本期」；
  //   ② **值对**：累计逐行 = 该年 1 月至本期**逐月各算一次再相加**（两条独立路径）；
  //   ③ **本期列不乱**：加一列累计不该改动原来那一列；
  //   ④ **列只有一个出处**：导出的表头逐字等于结果里的 `columns`（页面也读它）；
  //   ⑤ **闸门在拦**：时点口径（资产负债表）没有累计这回事，必须是 409 而不是一列整齐的 0。
  //
  // ①③⑤ 都**不另写一遍判据**：调 `auditRange` / `computeReport`，
  // 与界面、与 `auditReport` 共用同一份回答。
  //
  // ⚠️ ①的期望窗口在这里**字面算出**，不调 `resolveRange` ——
  //    用被测函数推期望值再和它的输出比就是自己验自己，
  //    这类"恒真的探针"比没有探针更危险（批次 P 反例 A 实测到过）。
  // -------------------------------------------------------------------------
  // 期间 +1 个月：**复核脚本自己算**，不走被测代码 ——
  // 否则"窗口算错"会一起把对照也算错，两边同步错成同一个数，复核就白做了。
  const shiftMonth = (v) => {
    const [yy, mm] = v.split('-').map(Number)
    const t = yy * 12 + (mm - 1) + 1
    return `${String(Math.floor(t / 12)).padStart(4, '0')}-${String((t % 12) + 1).padStart(2, '0')}`
  }

  const ytdPeriods = allPeriods.filter((x) => x.posted_count > 0)
  ok(ytdPeriods.length > 0, `存在有已过账凭证的期间可供累计（${ytdPeriods.length} 个）`)

  const ytdBad = []
  let ytdChecked = 0
  let ytdRows = 0
  for (const x of ytdPeriods) {
    const p = x.period
    const expectFrom = `${p.slice(0, 4)}-01` // 字面规则：本年 = 期间前 4 位，累计必然从该年 1 月起
    const got = computeReport(db, { reportCode: 'pl', period: p, range: 'ytd' })
    if (got.range_meta?.from !== expectFrom || got.range_meta?.to !== p) {
      ytdBad.push(`${p}：窗口 ${got.range_meta?.from}~${got.range_meta?.to} ≠ ${expectFrom}~${p}`)
    }
    // 逐月相加（另一条独立路径：一个按区间筛凭证、一个按月筛）
    const sums = new Map()
    for (let m = expectFrom; m <= p; m = shiftMonth(m)) {
      for (const r of computeReport(db, { reportCode: 'pl', period: m }).rows) {
        sums.set(r.line_code, Math.round(((sums.get(r.line_code) || 0) + Number(r.amount)) * 100) / 100)
      }
    }
    for (const r of got.rows) {
      ytdRows += 1
      if (Math.abs(Number(r.ytd_amount) - (sums.get(r.line_code) ?? 0)) > 0.005) {
        ytdBad.push(`${p} 的「${r.line_name}」：累计 ${r.ytd_amount} ≠ 逐月相加 ${sums.get(r.line_code) ?? 0}`)
      }
    }
    // 本期列不受累计影响
    const solo = computeReport(db, { reportCode: 'pl', period: p })
    const soloBy = new Map(solo.rows.map((r) => [r.line_code, Number(r.amount)]))
    for (const r of got.rows) {
      if (Math.abs(Number(r.amount) - (soloBy.get(r.line_code) ?? 0)) > 0.005) ytdBad.push(`${p} 的「${r.line_name}」：加了累计列之后本期列变了`)
    }
    ytdChecked += 1
  }
  ok(
    ytdBad.length === 0,
    `本年累计自洽（${ytdChecked} 期 × 利润表，核对 ${ytdRows} 个行次：窗口 = 本年 1 月~本期、逐行 = 逐月相加、本期列不受影响）`
      + (ytdBad.length ? `；异常：${ytdBad.slice(0, 2).join(' / ')}` : '')
  )

  // 现金流量表同样能累计（费率表的取数与利润表不同，所以单独核对一次）
  const cfYtd = computeReport(db, { reportCode: 'cf', period: ytdPeriods[0].period, range: 'ytd' })
  const cfAudit = auditRange(db, { reportCode: 'cf', period: ytdPeriods[0].period, range: 'ytd' })
  ok(cfAudit.ok, `现金流量表的本年累计自证通过（窗口 ${cfAudit.from}~${cfAudit.to}，核对 ${cfAudit.months_checked} 个月）` + (cfAudit.ok ? '' : `；异常：${cfAudit.problems.map((x) => x.code).join(',')}`))
  ok(Array.isArray(cfYtd.columns) && cfYtd.columns.some((c) => c.key === 'ytd_amount'), '现金流量表的累计结果带 ytd_amount 列定义')

  // ④ 列只有一个出处：导出的表头逐字等于结果里的 columns
  const colBad = []
  for (const code of ['bs', 'pl', 'cf']) {
    for (const opt of [{}, { range: 'ytd' }, { mode: 'previous' }]) {
      if (opt.range && code === 'bs') continue
      let out
      try {
        out = exportReport(db, { reportCode: code, period: ytdPeriods[0].period, ...opt })
      } catch (e) {
        colBad.push(`${code}/${JSON.stringify(opt)}：${e.code}`)
        continue
      }
      const head = String(out.content).replace(/^\uFEFF/, '').split('\r\n')[0]
      const want = out.columns.map((c) => c.label)
      if (JSON.stringify(head.split(',')) !== JSON.stringify(want)) {
        colBad.push(`${code}/${JSON.stringify(opt)}：表头 ${head} ≠ columns ${want.join('|')}`)
      }
    }
  }
  ok(
    colBad.length === 0,
    `导出的列与结果里的 columns 逐字一致（${colBad.length ? `异常：${colBad.slice(0, 2).join(' / ')}` : '单期 / 累计 / 比较三种列组合'}）`
  )

  // ⑤ 闸门在拦：时点口径没有累计这回事
  let gate = 'no-throw'
  try {
    computeReport(db, { reportCode: 'bs', period: ytdPeriods[0].period, range: 'ytd' })
  } catch (e) {
    gate = e.code
  }
  ok(gate === 'RANGE_NOT_APPLICABLE', `时点口径（资产负债表）拒绝本年累计（实得 ${gate}）—— 否则它会安静地产出一列整齐的 0，而资产 = 负债 + 权益照样成立`)

  // ⑦ 自定义基期与"环比"是**同一条判据的两种问法**，必须得到同一个答案
  const custBad = []
  for (const x of ytdPeriods) {
    if (!x.prev_period) continue
    const prev = x.prev_period
    try {
      const a = computeReport(db, { reportCode: 'pl', period: x.period })
      const b = computeReport(db, { reportCode: 'pl', period: prev })
      const viaPrev = compareReport(db, { reportCode: 'pl', period: x.period, mode: 'previous' })
      const viaCustom = compareReport(db, { reportCode: 'pl', period: x.period, mode: 'custom', basePeriod: prev })
      if (JSON.stringify(viaPrev.rows.map((r) => [r.line_no, r.amount, r.base_amount, r.diff]))
        !== JSON.stringify(viaCustom.rows.map((r) => [r.line_no, r.amount, r.base_amount, r.diff]))) {
        custBad.push(`${x.period}：custom(${prev}) 与 previous 对不上`)
      }
      if (Math.abs(Number(a.totals.PL_NET_PROFIT) - Number(viaPrev.rows.find((r) => r.line_code === 'PL_NET_PROFIT').amount)) > 0.005) {
        custBad.push(`${x.period}：比较的"本期列"与单独打开本期对不上`)
      }
      if (Math.abs(Number(b.totals.PL_NET_PROFIT) - Number(viaPrev.rows.find((r) => r.line_code === 'PL_NET_PROFIT').base_amount)) > 0.005) {
        custBad.push(`${x.period}：比较的"基期列"与单独打开 ${prev} 对不上`)
      }
    } catch (e) {
      custBad.push(`${x.period}：${e.code || e.message}`)
    }
  }
  ok(
    custBad.length === 0,
    `自定义基期与环比是同一条判据（${ytdPeriods.length} 期逐行核对${custBad.length ? `；异常：${custBad.slice(0, 2).join(' / ')}` : ''}）`
  )

  console.log(
    `  本年累计：${ytdChecked} 组窗口自洽；列定义 ${cfYtd.columns.length} 列；时点口径闸门 ${gate}`
  )
}
  // 二十三、期间审计链自洽（批次 Q）
  //
  // 这一批补的是「账上写着已关账，但没人知道它是怎么关上的」。
  // 本节要回答五件事：
  //   ① 重放全部变更记录得到的状态 = 期间表现状（**两条路径互证**）；
  //   ② 期间表上有留痕（撤销理由 / 派生凭证指针）就必须有对应的动作日志；
  //   ③ 每条派生凭证（期末结转 / 年度结转 / 利润分配）都要能被某条日志认领 ——
  //      这条**完全不读期间表**，来源是 `vouchers`（来源不同的互证才有分量）；
  //   ④ 动作名必须认识、撤销类动作必须写理由、年结承诺"封整年"必须兑现；
  //   ⑤ **期间表上是"指针"不是"历史"** —— `status='open'` 的行不该还带着关账人。
  // 判据与 `test-period-audit.mjs` 共用同一份（`auditPeriodTrail`），这里不再写一遍。
  // -------------------------------------------------------------------------
  const trail = auditPeriodTrail(db)
  ok(
    trail.ok,
    `期间审计链自洽（核 ${trail.periods_checked} 个期间 / ${trail.entries_checked} 条变更记录 / ${trail.years_checked} 个已年结年度）`
      + (trail.ok ? '' : `；异常：${trail.problems.map((x) => x.code).join(',')}`)
  )

  const logRows = all('SELECT action, COUNT(*) c FROM period_audit_log GROUP BY action ORDER BY c DESC')
  const unknownActions = logRows.map((r) => r.action).filter((a) => !PERIOD_ACTIONS[a])
  ok(
    unknownActions.length === 0,
    `日志里的动作名都在 PERIOD_ACTIONS 里（陌生动作：${unknownActions.join('、') || '无'}）—— 唯一的写入点是 logPeriodChange`
  )

  const auditNoReason = all(
    `SELECT period, action FROM period_audit_log
      WHERE action IN (${REASON_REQUIRED_ACTIONS.map(() => '?').join(',')})
        AND (reason IS NULL OR trim(reason) = '')`,
    ...REASON_REQUIRED_ACTIONS
  )
  ok(
    auditNoReason.length === 0,
    `撤销 / 反关账类记录都写了理由（缺 ${auditNoReason.length} 条）—— "谁撤销的"与"为什么撤销"是同一件事的两半`
  )

  const derivedOrphan = all(
    `SELECT v.doc_no, v.period FROM vouchers v
      WHERE v.biz_type IN (${ACTION_VOUCHER_BIZ_TYPES.map(() => '?').join(',')})
        AND NOT EXISTS (
          SELECT 1 FROM period_audit_log l
           WHERE l.closing_voucher_id = v.id OR l.annual_voucher_id = v.id OR l.dist_voucher_id = v.id
        )
      ORDER BY v.id`,
    ...ACTION_VOUCHER_BIZ_TYPES
  )
  ok(
    derivedOrphan.length === 0,
    `每条派生凭证都能在日志里找到来源（孤儿 ${derivedOrphan.length} 张）`
      + (derivedOrphan.length ? `；如 ${derivedOrphan[0].doc_no}/${derivedOrphan[0].period}` : '')
  )

  // 指针语义：状态是 open 的行不该还挂着关账人 / 关账时间。
  // 反关账清空这两列是**刻意的**（"状态未关账"与"关账人是张三"放在同一行是自相矛盾的一句话），
  // 历史在 `period_audit_log` 里 —— 这条断言就是那个决定的落点。
  const pointerBad = q(
    "SELECT COUNT(*) c FROM accounting_periods WHERE status='open' AND (closed_by IS NOT NULL OR closed_at IS NOT NULL)"
  ).c
  ok(pointerBad === 0, `"未关账"的期间不带关账人（指针不是历史；不符 ${pointerBad} 行）`)

  const baselineRows = q("SELECT COUNT(*) c FROM period_audit_log WHERE action='baseline'").c
  console.log(
    `  审计链：${logRows.map((r) => `${r.action}=${r.c}`).join(' ')}（基线 ${baselineRows} 条）`
  )

// ---------------------------------------------------------------------------
// 24. 配置变更链自洽（批次 R）
// ---------------------------------------------------------------------------
// 这一批补的是「配置改了，但没人知道它改过」，以及摸底时查出的四个真实缺口：
//   ① 同一个键四处各写一遍默认值（credit / quote / member / pos2 各带一个私有 `setting()`）；
//   ② 三个"代码读、库里没有"的幽灵配置（`credit.overdue_block_days` / `quote.approval_amount` /
//      `quote.valid_days`）—— 读不到就永远走默认值，看起来可配、实际不可配；
//   ③ 一个"登记了但没人读"的配置（`ar_prepay_auto`）；
//   ④ **库里的键没有任何约束**：谁都能写一个没人认识的键进去，而没有任何东西会报错。
//
// 本节要回答四件事：
//   ① 库里的键集合 == 登记表里的键集合（两个方向都查：多的报 `SETTING_KEY_UNKNOWN`、
//      少的报 `SETTING_KEY_MISSING`）—— 这是"配置项的集合是确定的"的落点；
//   ② 危险配置（会计政策 / 应收口径 / 门店阈值）的每一次变更都写了理由；
//   ③ 重放全部变更记录得到的值 = settings 表的现状（**两条路径互证**）；
//   ④ 三个幽灵配置**真的落库了** —— 否则本批修的缺口会在下一次重建后悄悄回来。
// 判据与 `test-setting-audit.mjs` 共用同一份（`auditSettingTrail`）。
// -------------------------------------------------------------------------
  const cfgTrail = auditSettingTrail(db)
  ok(
    cfgTrail.ok,
    `配置变更链自洽（核 ${cfgTrail.keys_checked} 项配置 / ${cfgTrail.entries_checked} 条变更记录 / 登记 ${cfgTrail.registered_keys} 项）`
      + (cfgTrail.ok ? '' : `；异常：${cfgTrail.problems.map((x) => x.code).join(',')}`)
  )

  const dbKeys = all('SELECT key FROM settings ORDER BY key').map((r) => r.key)
  const missingCfg = SETTING_KEYS.filter((k) => !dbKeys.includes(k))
  ok(
    missingCfg.length === 0,
    `登记的配置项都已落库（缺 ${missingCfg.length} 项${missingCfg.length ? `：${missingCfg.join('、')}` : ''}）—— 缺项会一直走默认值，看起来可配其实不可配`
  )

  const unregCfg = dbKeys.filter((k) => !SETTING_RULES[k])
  ok(
    unregCfg.length === 0,
    `库里没有未登记的配置键（未登记 ${unregCfg.length} 个${unregCfg.length ? `：${unregCfg.join('、')}` : ''}）—— 未登记的键没有标签/默认值/值域，读它的代码只能自己编一套`
  )

  // 危险配置的变更必须写理由 —— "谁改的"与"为什么改"是同一件事的两半。
  const cfgNoReason = all(
    `SELECT key, action, created_at FROM setting_audit_log
      WHERE action <> 'baseline' AND is_danger = 1 AND (reason IS NULL OR trim(reason) = '')`
  )
  ok(
    cfgNoReason.length === 0,
    `危险配置（会计政策 / 应收口径 / 门店阈值）的变更都写了理由（缺 ${cfgNoReason.length} 条）`
      + (cfgNoReason.length ? `；如 ${cfgNoReason[0].key}·${cfgNoReason[0].action}` : '')
  )

  // 三个幽灵配置必须真的在库里 —— 这条守的是"本批修的缺口不会被重建悄悄还原"
  const GHOSTS = ['credit.overdue_block_days', 'quote.approval_amount', 'quote.valid_days']
  const ghostMissing = GHOSTS.filter((k) => !dbKeys.includes(k))
  ok(
    ghostMissing.length === 0,
    `三个"代码读、库里没有"的幽灵配置已全部落库（缺 ${ghostMissing.length}/3${ghostMissing.length ? `：${ghostMissing.join('、')}` : ''}）`
  )

  // 重放核对：从空状态按序应用日志，必须得到 settings 表的现状。
  // 两条路径**出处不同**（现状来自各处的 upsert，历史来自唯一写入点 `logSettingChange`），
  // 所以它抓得到"改了没记""记了没改"。
  const want = replaySettings(db)
  const got = settingsStateOf(db)
  const cfgDesync = [...new Set([...Object.keys(want), ...Object.keys(got)])].filter((k) => want[k] !== got[k])
  ok(
    cfgDesync.length === 0,
    `配置的现状可由变更日志重放出来（不一致 ${cfgDesync.length} 处${cfgDesync.length ? `：${cfgDesync.slice(0, 2).map((k) => `${k}（重放 ${want[k] ?? '无'} / 现状 ${got[k] ?? '无'}）`).join('；')}` : ''}）`
  )

  // 每个登记键都必须至少有一条日志 —— 否则它的"现状"来路不明。
  const noHist = SETTING_KEYS.filter(
    (k) => q('SELECT COUNT(*) c FROM setting_audit_log WHERE key=?', k).c === 0
  )
  ok(
    noHist.length === 0,
    `每个配置项都有来路（无历史的 ${noHist.length} 项${noHist.length ? `：${noHist.join('、')}` : ''}）—— 基线是初始化时补的，它回答"在我们开始记日志之前这个键是什么"`
  )

  const cfgLogRows = all('SELECT action, COUNT(*) c FROM setting_audit_log GROUP BY action ORDER BY c DESC')
  const dangerChanged = q('SELECT COUNT(*) c FROM setting_audit_log WHERE is_danger=1 AND action<>?', 'baseline').c
  console.log(
    `  配置链：${cfgLogRows.map((r) => `${r.action}=${r.c}`).join(' ')}`
      + `（登记 ${SETTING_KEYS.length} 项 / 危险项 ${SETTING_KEYS.filter((k) => SETTING_RULES[k].is_danger).length} 项 / 危险项被改过 ${dangerChanged} 次）`
  )

  // -------------------------------------------------------------------------
  // 25. 报表口径变更链自洽（批次 S）
  // -------------------------------------------------------------------------
  // 这一批补的是「会计政策改了，只留下一句"保存成功"」——
  // 原来保存只记一个行号、删除只记一个自增 id，而 `report_lines` 是物理删除：
  // **删掉之后"删的是什么"永久不可考**。三件事一起补：
  //   ① 唯一写入点落在 `lib/report.js` 的三个写函数里（绕过它就没法改口径）；
  //   ② 每次记录存**整行快照**（`snapshot_before` / `snapshot_after`）；
  //   ③ 重放：从空状态按序应用日志 == `report_defs` + `report_lines` 的全部内容。
  //
  // 本节要回答五件事：
  //   ① 变更链自证通过（八条探针全绿，判据与 `test-report-config-audit.mjs` 共用一份）；
  //   ② 每一张定义、每一行口径都有来路（基线是初始化补的，不是"没有历史"）；
  //   ③ 重放得到的口径 == 库里的口径（**两条路径互证**）；
  //   ④ **删掉的记录里还留着那一行的全部内容** —— 这是本批要根治的东西，
  //      所以它必须是一条**可执行的断言**，不是"设计上如此"；
  //   ⑤ `SNAPSHOT_FIELDS` 覆盖了两张表的全部列（表加列没登记 ⇒ 那一列不留痕也不参与重放，
  //      是一条会安静扩大的盲区）。
  {
    const rcfg = auditReportConfigTrail(db)
    ok(
      rcfg.ok,
      `报表口径变更链自洽（核 ${rcfg.entries_checked} 条记录 / ${rcfg.defs_checked} 张定义 / ${rcfg.lines_checked} 行口径）`
        + (rcfg.ok ? '' : `；异常：${rcfg.problems.map((x) => x.code).join(',')}`)
    )

    // 每张定义、每行口径都必须有历史 —— 否则它的"现状"来路不明
    const untrackedCfg = [
      ...all('SELECT report_code FROM report_defs')
        .map((r) => r.report_code)
        .filter((c) => q('SELECT COUNT(*) c FROM report_config_audit_log WHERE target_type=? AND report_code=?', 'def', c).c === 0)
        .map((c) => `def:${c}`),
      ...all('SELECT report_code, line_code FROM report_lines')
        .filter((r) => q('SELECT COUNT(*) c FROM report_config_audit_log WHERE target_type=? AND report_code=? AND line_code=?', 'line', r.report_code, r.line_code).c === 0)
        .map((r) => `line:${r.report_code}/${r.line_code}`)
    ]
    ok(
      untrackedCfg.length === 0,
      `每一张报表定义与每一行口径都有来路（无历史的 ${untrackedCfg.length} 个${untrackedCfg.length ? `：${untrackedCfg.slice(0, 3).join('、')}` : ''}）—— `
        + '基线由 seedReport / bootIndustry 补，"有行无历史"会被 UNTRACKED 报出来'
    )

    // 重放核对：两条路径出处不同（现状来自 INSERT/DELETE，历史来自唯一写入点）
    const wantCfg = replayReportConfig(db)
    const gotCfg = reportConfigStateOf(db)
    const cfgRDesync = []
    for (const t of ['def', 'line']) {
      for (const k of new Set([...Object.keys(wantCfg[t]), ...Object.keys(gotCfg[t])])) {
        const a = wantCfg[t][k]
        const b = gotCfg[t][k]
        if (!a || !b) { cfgRDesync.push(`${t}:${k} 重放${a ? '有' : '无'}/现状${b ? '有' : '无'}`); continue }
        const f = diffSnapshot(t, a, b)
        if (f.length) cfgRDesync.push(`${t}:${k}（${f.join(',')}）`)
      }
    }
    ok(
      cfgRDesync.length === 0,
      `报表口径的现状可由变更日志重放出来（不一致 ${cfgRDesync.length} 处${cfgRDesync.length ? `：${cfgRDesync.slice(0, 2).join('；')}` : ''}）`
    )

    // **本批的核心**：删掉的记录里必须留着那一行的全部内容。
    // `report_lines` 是物理删除 —— 不留快照就等于没留痕（原来只记 `report_line:<id>`）。
    const delRows = all("SELECT id, report_code, line_code, snapshot_before FROM report_config_audit_log WHERE action='delete'")
    const delThin = delRows.filter((r) => {
      if (!r.snapshot_before) return true
      try {
        const o = JSON.parse(r.snapshot_before)
        // "整行"的判据不是"是合法 JSON"，而是**字段齐**：残缺的快照答不出"删的是什么"
        return SNAPSHOT_FIELDS.line.some((f) => o[f] === undefined)
      } catch {
        return true
      }
    })
    ok(
      delThin.length === 0,
      `删除记录都带着整行快照（残缺 ${delThin.length}/${delRows.length} 条）—— report_lines 是物理删除，不留快照就答不出"删掉的那一行原来是什么"`
        // **不能说成"通过"就完事**：本代库里一条删除记录都没有时，这条断言是**空跑**
        // （批次 Q 的教训：「跳过」与「通过」在输出上完全一样）。空跑时必须说出来。
        + (delRows.length === 0 ? '（本代库还没有删除记录 ⇒ 本条本次是空跑；真正的覆盖在 test-report-config-audit 的 S6）' : '')
    )

    // 快照字段清单必须覆盖两张表的全部列：漏一列，那一列就不留痕、也不参与重放比对
    const fieldGaps = []
    for (const [t, table] of [['def', 'report_defs'], ['line', 'report_lines']]) {
      const undeclared = all(`PRAGMA table_info(${table})`).map((c) => c.name).filter((c) => !SNAPSHOT_FIELDS[t].includes(c))
      if (undeclared.length) fieldGaps.push(`${table}：${undeclared.join('、')}`)
    }
    ok(
      fieldGaps.length === 0,
      `SNAPSHOT_FIELDS 覆盖了报表定义与口径行的全部列（缺口 ${fieldGaps.length} 处${fieldGaps.length ? `：${fieldGaps.join('；')}` : ''}）—— 表里加了列而没登记，那一列就既不留痕也不参与重放比对`
    )

    const rcfgRows = all('SELECT action, COUNT(*) c FROM report_config_audit_log GROUP BY action ORDER BY c DESC')
    console.log(
      `  报表口径链：${rcfgRows.map((r) => `${r.action}=${r.c}`).join(' ') || '（空）'}`
        + `（定义 ${rcfg.defs_checked} 张 / 口径行 ${rcfg.lines_checked} 行 / `
        + `删除记录 ${delRows.length} 条${delRows.length ? '，快照全部完整' : '（本代库还没有删除 ⇒ 删除快照那条断言本次是空跑）'}）`
    )
  }

  // -------------------------------------------------------------------------
  // 26. IM（钉钉/飞书）同步链自洽（批次 T）
  // -------------------------------------------------------------------------
  // 这一节回答的是"重建之后，IM 那一摊子还自不自洽"。要点：
  //   · 三张映射表里存的是**外部 id → 本地自增 id**，重建会重排本地 id ⇒
  //     它们是 `TABLES` 里必须一起清的表（漏清 = 跨代引用，而孤儿检查发现不了）；
  //   · 平台配置正相反 —— 它是**配置**，在 `KEEP_TABLES` 里，重建后必须还在；
  //   · 探针跑一遍：留痕只追加、映射有出处、引用不悬空。
  {
    const imTrail = IMA.auditImTrail(db)
    ok(imTrail.ok, `IM 同步链自洽（核 ${imTrail.checked.runs} 次同步 / 部门映射 ${imTrail.checked.dept_maps} / 成员映射 ${imTrail.checked.user_maps} / 审批映射 ${imTrail.checked.approval_maps} / 冲突 ${imTrail.checked.conflicts}）${imTrail.ok ? '' : '：' + imTrail.problems.map((p) => p.code).join('、')}`)

    // 平台配置是配置不是数据：重建必须保留它（否则"这个平台接没接"会被一次重建抹掉）
    const platforms = all('SELECT platform, enabled FROM im_platform_cfg ORDER BY platform')
    ok(platforms.length === IMA.IM_PLATFORM_CODES.length, `IM 平台配置齐全（${platforms.map((p) => p.platform).join(' / ')}）`)
    ok(platforms.every((p) => p.enabled === 0), 'IM 平台默认停用（同步会改组织与审批状态，必须是显式打开的）')

    // 三张映射表在默认（未同步）状态下应为空 —— 空不是错，
    // 但"重建之后还留着上一代的映射"是错，而它的表现是某一行指向了另一代的 org/user。
    const mapRows = all('SELECT COUNT(*) c FROM im_dept_map').concat(all('SELECT COUNT(*) c FROM im_user_map')).concat(all('SELECT COUNT(*) c FROM im_approval_map'))
    console.log(`  IM 同步链：平台 ${platforms.length} 个（全部停用）/ 映射 ${mapRows.map((r) => r.c).join('/')} 行（部门/成员/审批）/ 冲突 ${imTrail.checked.conflicts} 条`)
  }
}


console.log(`\n${'─'.repeat(72)}`)
if (fails === 0) console.log('seed 口径复核：全部通过')
else console.log(`seed 口径复核：${fails} 项不通过`)
process.exit(fails === 0 ? 0 : 1)
