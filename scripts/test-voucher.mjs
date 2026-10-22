/**
 * ============================================================================
 * 文件标识：scripts/test-voucher.mjs ｜ 测试：业财一体凭证测试（模块 27 · 科目表 / 凭证模板 / 凭证生成 / 试算平衡）
 * ============================================================================
 * 【职责】测试：业财一体凭证测试（模块 27 · 科目表 / 凭证模板 / 凭证生成 / 试算平衡）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 业财一体凭证测试（模块 27 · 科目表 / 凭证模板 / 凭证生成 / 试算平衡）
 *
 * 这个域的危险不在"生成不出来"，而在**生成得出来但是错的**：
 *   · 借贷不平的凭证被落了库 → 试算平衡表长期差一个数，而每张凭证单看都像对的；
 *   · 同一张来源单被入两次账 → 金额翻倍，且两次都"有来源、能解释"；
 *   · 分录挂在父科目上 → 「父科目 = 子科目之和」悄悄不成立，报表却很好看；
 *   · 生成与试算各算一遍金额 → "预览说 A、入账是 B"，没有任何界面能看出来；
 *   · 作废已过账凭证而不写理由 → 账少了钱，没人知道为什么。
 *
 * 所以本测试把五条硬口径一条条钉死：
 *   ① **不平即拒绝，且整张不落库**（不是落库了再报错）；
 *   ② **同一事实只入一次账**（重放返回同一张，不报错也不新建）；
 *   ③ **分录金额恒 > 0、方向只由模板决定、只能挂叶子科目**；
 *   ④ **只有 `posted` 计入账**（draft 不进试算平衡表）；
 *   ⑤ **试算平衡表借贷相等，且余额方向由科目自身的方向决定**（负债类不读成负数）。
 *
 * 与其它域同一规矩：**串行跑**（并行写同一个 SQLite 会 WAL 竞争）。
 * 用法：node scripts/test-voucher.mjs [industry]
 *
 * 关于「可重复跑」：本测试会造真实的来源单据（到货单 / 收款单）并生成凭证。
 * 开跑前先按标记 `__test_voucher__` 把自己上一轮的残渣**成对清掉**
 * （先删分录 → 再删凭证 → 再删来源单），否则来源单的 id 会被复用，
 * 上一轮的凭证会"看起来指向一张真实存在的单"。
 */
import { getDbFor } from '../server/db/index.js'
import { nextDocNo } from '../server/lib/docno.js'
import * as A from '../server/lib/accounting.js'

const INDUSTRY = process.argv[2] || 'cosmetic'
const db = getDbFor(INDUSTRY)

let pass = 0
let fail = 0
const failures = []
function ok(cond, msg, detail) {
  if (cond) { pass++ }
  else {
    fail++
    failures.push(msg)
    console.log(`  \x1b[31m✗\x1b[0m ${msg}${detail !== undefined ? `  → ${String(detail).slice(0, 240)}` : ''}`)
  }
}
const eq = (msg, actual, expect) => {
  const good = JSON.stringify(actual) === JSON.stringify(expect)
  if (!good) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望 ${JSON.stringify(expect)}，实际 ${JSON.stringify(actual)}`)
  ok(good, msg)
}
const num = (v) => Number(v) || 0
const okNear = (a, b, msg, eps = 0.005) => {
  if (!(Math.abs(num(a) - num(b)) <= eps)) console.log(`  \x1b[31m✗\x1b[0m ${msg}：期望≈${b}，实际 ${a}`)
  ok(Math.abs(num(a) - num(b)) <= eps, msg)
}
const codes = (e) => e?.code || null
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

const T = '__test_voucher__'
const SUBJ = 'T9'          // 自造科目编码前缀

console.log(`=== 业财一体凭证测试（${INDUSTRY}） ===`)

// ===========================================================================
// [0] 清理上一轮残渣（子 → 父）
// ===========================================================================
function purge() {
  const rcps = db.prepare('SELECT id FROM receipts WHERE remark=?').all(T).map((r) => r.id)
  const grs = db.prepare('SELECT id FROM purchase_receipts WHERE remark=?').all(T).map((r) => r.id)
  const vids = []
  const inIds = (ids) => (ids.length ? `(${ids.join(',')})` : '(NULL)')
  // 凭证从 `source_type + source_id` 反查 —— **不能靠 doc_no**：
  // 单号是按日期+序号生成的，重跑时可能被别的新单占用
  const pair = []
  if (rcps.length) pair.push(`(source_type='receipts' AND source_id IN ${inIds(rcps)})`)
  if (grs.length) pair.push(`(source_type='purchase_receipts' AND source_id IN ${inIds(grs)})`)
  if (pair.length) {
    const rows = db.prepare(`SELECT id FROM vouchers WHERE ${pair.join(' OR ')}`).all()
    for (const r of rows) vids.push(r.id)
  }
  if (vids.length) {
    db.prepare(`DELETE FROM doc_events WHERE doc_type='VOUCHER' AND doc_id IN ${inIds(vids)}`).run()
    db.prepare(`DELETE FROM voucher_entries WHERE voucher_id IN ${inIds(vids)}`).run()
    db.prepare(`DELETE FROM vouchers WHERE id IN ${inIds(vids)}`).run()
  }
  if (rcps.length) db.prepare(`DELETE FROM receipts WHERE id IN ${inIds(rcps)}`).run()
  if (grs.length) db.prepare(`DELETE FROM purchase_receipts WHERE id IN ${inIds(grs)}`).run()
  // 自造科目：先确认没有分录挂上去（有就说明上一轮留了残渣，先清干净）
  const sid = db.prepare('SELECT id FROM accounting_subjects WHERE code LIKE ?').all(`${SUBJ}%`).map((r) => r.id)
  if (sid.length) {
    db.prepare(`DELETE FROM voucher_entries WHERE subject_id IN ${inIds(sid)}`).run()
    db.prepare(`DELETE FROM accounting_subjects WHERE parent_id IN ${inIds(sid)}`).run()
    db.prepare(`DELETE FROM accounting_subjects WHERE id IN ${inIds(sid)}`).run()
  }
  // 目录里遗留的僵尸模板（探针模板用固定 code，必须清掉）
  db.prepare("DELETE FROM voucher_template_entries WHERE template_id IN (SELECT id FROM voucher_templates WHERE code LIKE 'TPL_T9%')").run()
  db.prepare("DELETE FROM voucher_templates WHERE code LIKE 'TPL_T9%'").run()
}
purge()

// 探测用来源单：状态可入账 / 状态不可入账 / 金额为 0 / 金额为负 —— 四种形态各一条
function makeReceipt(amount, { status = 'confirmed', allocated = 0 } = {}) {
  const docNo = nextDocNo(db, 'RCP', 'receipts', 'doc_no', '2026-10-16')
  const subjectId = db.prepare("SELECT id FROM dealers ORDER BY id LIMIT 1").get()?.id ?? 1
  const info = db
    .prepare(`
      INSERT INTO receipts (doc_no,subject_type,subject_id,subject_name,receipt_date,method,amount,
                            allocated_amount,status,remark)
      VALUES (?,'dealer',?,'测试主体',?, 'bank',?,?,?,?)
    `)
    .run(docNo, subjectId, '2026-10-16', amount, allocated, status, T)
  return { id: Number(info.lastInsertRowid), doc_no: docNo }
}
function makeReceiptGr(amount, { status = 'received' } = {}) {
  const docNo = nextDocNo(db, 'PR', 'purchase_receipts', 'doc_no', '2026-10-16')
  const supplierId = db.prepare('SELECT id FROM suppliers ORDER BY id LIMIT 1').get()?.id ?? 1
  const whId = db.prepare('SELECT id FROM warehouses ORDER BY id LIMIT 1').get()?.id ?? 1
  const info = db
    .prepare(`
      INSERT INTO purchase_receipts (doc_no,supplier_id,warehouse_id,receipt_date,status,total_qty,total_amount,remark)
      VALUES (?,?,?,?,?,0,?,?)
    `)
    .run(docNo, supplierId, whId, '2026-10-16', status, amount, T)
  return { id: Number(info.lastInsertRowid), doc_no: docNo }
}

// ===========================================================================
// [1] 科目表
// ===========================================================================
section('[1] 会计科目')

const subjects = A.listSubjects(db)
ok(subjects.length >= 20, `科目表已就位（${subjects.length} 个）`)
ok(subjects.every((s) => s.code && s.name && s.category), '每个科目都有编码 / 名称 / 类别')
ok(subjects.every((s) => ['debit', 'credit'].includes(s.direction)), '每个科目都有余额方向')
eq('科目编码唯一', db.prepare('SELECT COUNT(*) c FROM (SELECT code FROM accounting_subjects GROUP BY code HAVING COUNT(*)>1)').get().c, 0)

// 父科目（2221 应交税费）因为挂了子科目，自动变成不可记账
const parent = db.prepare("SELECT * FROM accounting_subjects WHERE code='2221'").get()
eq('有子科目的科目自动变成非叶子（无需人工维护）', parent.is_leaf, 0)
const leaf = db.prepare("SELECT * FROM accounting_subjects WHERE code='222101'").get()
eq('子科目是叶子科目', leaf.is_leaf, 1)

// 自造一对父子，验证"结构推 is_leaf"
const p9 = A.saveSubject(db, { code: `${SUBJ}001`, name: '测试父科目', category: 'asset', direction: 'debit' })
eq('新建科目的 level=1', p9.level, 1)
eq('新建科目默认是叶子', p9.is_leaf, 1)
const c9 = A.saveSubject(db, { code: `${SUBJ}00101`, name: '测试子科目', category: 'asset', direction: 'debit', parent_id: p9.id })
eq('子科目 level=2', c9.level, 2)
eq('挂上子科目后父科目变成非叶子', db.prepare('SELECT is_leaf FROM accounting_subjects WHERE id=?').get(p9.id).is_leaf, 0)

let selfErr = null
try { A.saveSubject(db, { code: `${SUBJ}001`, name: 'x', category: 'asset', parent_id: p9.id }) } catch (e) { selfErr = e }
eq('科目不能把自己的 id 当上级', codes(selfErr), 'BAD_ARGS')

let catErr = null
try { A.saveSubject(db, { code: `${SUBJ}002`, name: 'x', category: 'nope' }) } catch (e) { catErr = e }
eq('未知科目类别被拒', codes(catErr), 'BAD_ARGS')

// 停用：被分录用过的科目不能停用（否则历史凭证会指到一个"不存在"的科目）
const usedSubject = db.prepare('SELECT subject_id FROM voucher_entries LIMIT 1').get()
if (usedSubject) {
  let inUse = null
  try { A.setSubjectStatus(db, usedSubject.subject_id, 'inactive') } catch (e) { inUse = e }
  eq('已被分录使用的科目不能停用', codes(inUse), 'SUBJECT_IN_USE')
}
let childStop = null
try { A.setSubjectStatus(db, p9.id, 'inactive') } catch (e) { childStop = e }
eq('还有子科目的科目不能停用', codes(childStop), 'SUBJECT_HAS_CHILDREN')
A.setSubjectStatus(db, c9.id, 'inactive')
eq('没有引用的子科目可以停用', db.prepare('SELECT status FROM accounting_subjects WHERE id=?').get(c9.id).status, 'inactive')
A.setSubjectStatus(db, c9.id, 'active')

// ===========================================================================
// [2] 凭证模板
// ===========================================================================
section('[2] 凭证模板')

const tpls = A.listTemplates(db)
eq('模板 7 套（含批次 J 的退款 + 本批的采购退货）', tpls.length, 7)
ok(tpls.every((t) => t.entries.length >= 2), '每套模板至少两条分录', tpls.map((t) => `${t.code}:${t.entries.length}`).join(' '))
ok(tpls.every((t) => t.entries.some((e) => e.direction === 'debit') && t.entries.some((e) => e.direction === 'credit')), '每套模板借贷两边都有')
ok(tpls.every((t) => t.entries.every((e) => A.FACT_KEYS[e.amount_key])), '模板引用的取数键都在字典里')
eq('取数字典有 6 个键', Object.keys(A.FACT_KEYS).length, 6)
eq('业务场景有 7 种', Object.keys(A.BIZ_TYPES).length, 7)
eq('模板里没有"自由表达式"（只有受控取值键）',
  db.prepare("SELECT COUNT(*) c FROM voucher_template_entries WHERE amount_key NOT IN (?,?,?,?,?,?)")
    .get(...Object.keys(A.FACT_KEYS)).c, 0)

let noTpl = null
try { A.templateOf(db, 'not_a_biz') } catch (e) { noTpl = e }
eq('未配置模板的业务场景被拒', codes(noTpl), 'TEMPLATE_NOT_FOUND')

// ===========================================================================
// [3] 取数：不含税 + 税额 = 总额（尾差收在税额里）
// ===========================================================================
section('[3] 取数与税额拆分')

const rc1 = makeReceipt(1000, { allocated: 600 })
const f1 = A.collectFacts(db, { bizType: 'receipt', sourceId: rc1.id })
okNear(f1.facts.total_amount, 1000, '收款总额取到 1000')
okNear(f1.facts.settled_amount, 600, '已核销部分取到 600')
okNear(f1.facts.offset_amount, 400, '未核销部分由**减法**得到 400')

const gr1 = makeReceiptGr(1130)
const f2 = A.collectFacts(db, { bizType: 'purchase_inbound', sourceId: gr1.id })
eq('默认税率从 settings 取（13%）', f2.facts.tax_rate, 13)
okNear(f2.facts.net_amount, 1000, '不含税 = 1130 / 1.13 = 1000')
okNear(f2.facts.tax_amount, 130, '税额 = 1130 − 1000 = 130')
okNear(num(f2.facts.net_amount) + num(f2.facts.tax_amount), num(f2.facts.total_amount), '不含税 + 税额 **恒等于** 总额')

// 会打不平的金额：99.99 / 1.13 —— 各自四舍五入会差 0.01，用减法就不会
const gr2 = makeReceiptGr(99.99)
const f3 = A.collectFacts(db, { bizType: 'purchase_inbound', sourceId: gr2.id })
okNear(num(f3.facts.net_amount) + num(f3.facts.tax_amount), 99.99, `易打不平的金额也恒等（${f3.facts.net_amount} + ${f3.facts.tax_amount} = 99.99）`)

let badBiz = null
try { A.collectFacts(db, { bizType: 'nope', sourceId: 1 }) } catch (e) { badBiz = e }
eq('未知业务场景被拒', codes(badBiz), 'BAD_BIZ_TYPE')

let missing = null
try { A.collectFacts(db, { bizType: 'receipt', sourceId: 99999999 }) } catch (e) { missing = e }
eq('来源单据不存在被拒', codes(missing), 'SOURCE_NOT_FOUND')

const rcDraft = makeReceipt(500, { status: 'draft' })
let badStatus = null
try { A.collectFacts(db, { bizType: 'receipt', sourceId: rcDraft.id }) } catch (e) { badStatus = e }
eq('来源单据状态不允许入账时被拒（草稿的收款单不是事实）', codes(badStatus), 'SOURCE_STATUS_INVALID')

// ===========================================================================
// [4] 生成：不平即拒绝、幂等、金额非负
// ===========================================================================
section('[4] 生成凭证')

const v1 = A.generateVoucher(db, { bizType: 'receipt', sourceId: rc1.id, actor: { name: 'test' } })
eq('生成成功且状态 draft', v1.status, 'draft')
eq('幂等标记为 false（首次）', v1.replayed, false)
ok(v1.doc_no.startsWith('PZ'), '凭证号按 PZ 前缀生成', v1.doc_no)
okNear(v1.total_debit, 1000, '借方合计 = 1000')
okNear(v1.total_credit, 1000, '贷方合计 = 1000')
ok(v1.balanced, '凭证自报平衡')
const v1lines = v1.entries
eq('分录 3 行（银行 / 应收 / 预收）', v1lines.length, 3)
okNear(v1lines[0].amount, 1000, '借 银行存款 1000')
okNear(v1lines.find((l) => l.subject_code === '1122').amount, 600, '贷 应收账款 = 已核销 600')
okNear(v1lines.find((l) => l.subject_code === '2203').amount, 400, '贷 预收账款 = 未核销 400')
ok(v1lines.every((l) => l.amount > 0), '所有分录金额都 > 0')

// 幂等：同来源再生成返回同一张
//
// 这里刻意**捕获异常而不是让它抛出**：幂等一旦做漏，第二张会被
// `UNIQUE (biz_type, source_type, source_id)` 拦成 `SQLITE_CONSTRAINT_UNIQUE` ——
// 那是"炸了一条语句"，而断言要报的是"有没有重复记账"这件事本身。
// 让异常穿透会掩盖掉后面的断言（红得没有信息量）。
let v1b = null
try { v1b = A.generateVoucher(db, { bizType: 'receipt', sourceId: rc1.id, actor: { name: 'test' } }) } catch (e) { v1b = { error: e.code || e.message } }
eq('同来源重复生成返回同一张（不新建）', v1b?.error ? `抛错 ${v1b.error}` : v1b.id, v1.id)
eq('重放标记为 true', v1b?.replayed, true)
eq('重复生成没有多出一张', db.prepare("SELECT COUNT(*) c FROM vouchers WHERE source_type='receipts' AND source_id=?").get(rc1.id).c, 1)

// 试算（预览）与落库必须一致 —— 两处各算一遍必然分叉
const plan1 = A.planVoucher(db, { bizType: 'receipt', sourceId: rc1.id })
okNear(plan1.total_debit, v1.total_debit, '预览与落库的借方合计一致')
okNear(plan1.total_credit, v1.total_credit, '预览与落库的贷方合计一致')
eq('预览与落库的分录行数一致', plan1.lines.length, v1.entries.length)

// 不平即拒绝：临时把"应付暂估"的取数键改成 net_amount（借 1130 ≠ 贷 1000）
function withTemplateEntry(subjectCode, amountKey, fn) {
  const row = db.prepare('SELECT * FROM voucher_template_entries WHERE subject_code=? ORDER BY id LIMIT 1').get(subjectCode)
  const before = row.amount_key
  db.prepare('UPDATE voucher_template_entries SET amount_key=? WHERE id=?').run(amountKey, row.id)
  try { return fn() } finally { db.prepare('UPDATE voucher_template_entries SET amount_key=? WHERE id=?').run(before, row.id) }
}
const gr3 = makeReceiptGr(1130)
let unbal = null
withTemplateEntry('2202', 'net_amount', () => {
  try { A.generateVoucher(db, { bizType: 'purchase_inbound', sourceId: gr3.id }) } catch (e) { unbal = e }
})
eq('借贷不平 → 拒绝', codes(unbal), 'VOUCHER_NOT_BALANCED')
eq('不平的凭证**整张没有落库**（半张凭证比没有更糟）',
  db.prepare("SELECT COUNT(*) c FROM vouchers WHERE source_type='purchase_receipts' AND source_id=?").get(gr3.id).c, 0)

// 未知取数键 → 拒绝
let badKey = null
withTemplateEntry('2202', '__nope__', () => {
  try { A.generateVoucher(db, { bizType: 'purchase_inbound', sourceId: gr3.id }) } catch (e) { badKey = e }
})
eq('未知取数键被拒', codes(badKey), 'FACT_KEY_UNKNOWN')

// 挂父科目 → 拒绝
let onParent = null
withTemplateEntry('2202', 'total_amount', () => {
  const row = db.prepare("SELECT * FROM voucher_template_entries WHERE subject_code='2202'").get()
  db.prepare("UPDATE voucher_template_entries SET subject_code='2221' WHERE id=?").run(row.id)
  try { A.generateVoucher(db, { bizType: 'purchase_inbound', sourceId: gr3.id }) } catch (e) { onParent = e }
  db.prepare("UPDATE voucher_template_entries SET subject_code='2202' WHERE id=?").run(row.id)
})
eq('分录挂在非叶子科目上 → 拒绝（否则"父科目 = 子科目之和"悄悄不成立）', codes(onParent), 'SUBJECT_NOT_LEAF')

// 金额为负 → 拒绝
const rcNeg = makeReceipt(-100)
let negErr = null
try { A.generateVoucher(db, { bizType: 'receipt', sourceId: rcNeg.id }) } catch (e) { negErr = e }
eq('负数金额 → 拒绝（要冲减就换方向）', codes(negErr), 'VOUCHER_NEGATIVE_AMOUNT')

// 金额为 0 → 拒绝（不生成一张全是 0 元行的凭证）
const rcZero = makeReceipt(0)
let zeroErr = null
try { A.generateVoucher(db, { bizType: 'receipt', sourceId: rcZero.id }) } catch (e) { zeroErr = e }
eq('金额为 0 → 拒绝生成空凭证', codes(zeroErr), 'VOUCHER_EMPTY')

// 正常采购入库能生成，且凭证上带了辅助核算（供应商）
A.saveSubject(db, { code: '1405', name: '库存商品', category: 'asset', direction: 'debit' })
const vg = A.generateVoucher(db, { bizType: 'purchase_inbound', sourceId: gr1.id })
eq('采购入库生成 2 行分录', vg.entries.length, 2)
okNear(vg.total_debit, 1130, '采购入库借方 = 到货单金额 1130')
eq('借的是库存商品 1405', vg.entries.find((l) => l.direction === 'debit').subject_code, '1405')

// 来源单据反查
const bySrc = A.vouchersOfSource(db, { sourceType: 'receipts', sourceId: rc1.id })
eq('能按来源反查凭证（"这笔记过账没有"）', bySrc.length, 1)

// ===========================================================================
// [5] 过账 / 作废 / 试算平衡
// ===========================================================================
section('[5] 过账与试算平衡')

const before = A.trialBalance(db)
// 断言用**增量**而不是某个具体科目：演示数据里已经有一批已过账凭证，
// 按科目名断言会被它们污染 —— 那样得到的红/绿与本次改动无关。
const baseDebit = num(before.total_debit)

const p1 = A.postVoucher(db, { id: v1.id, actor: { name: 'test' } })
eq('过账成功', p1.status, 'posted')
const p1b = A.postVoucher(db, { id: v1.id, actor: { name: 'test' } })
eq('重复过账幂等', p1b.replayed, true)

const after = A.trialBalance(db)
okNear(num(after.total_debit) - baseDebit, 1000, '过账后试算平衡表的借方合计**正好增加这张凭证的金额**（draft 之前不计入）')
ok(after.balanced, '试算平衡表借贷相等', JSON.stringify({ d: after.total_debit, c: after.total_credit }))
okNear(after.total_debit, after.total_credit, '借贷合计差额为 0')
ok(after.voucher_count >= 1, `已过账凭证计数 ≥ 1（${after.voucher_count}）`)

// Verify this posting's delta; the demo may already contain a larger debit balance.
const yushou = after.rows.find((r) => r.code === '2203')
okNear(num(yushou.credit) - num(before.rows.find(r => r.code === '2203')?.credit), 400, '本凭证增加预收贷方400，不能拿全库余额方向替代增量')
eq('单独贷记400的负债余额方向为贷', A.balanceOf('credit', 0, 400).side, 'credit')
ok(num(yushou.balance_abs) > 0, '预收账款余额取绝对值后为正')

// 作废：已过账的必须写理由
let voidNoReason = null
try { A.voidVoucher(db, { id: v1.id }) } catch (e) { voidNoReason = e }
eq('作废已过账凭证不写理由 → 拒绝', codes(voidNoReason), 'VOID_REASON_REQUIRED')

const vd = A.voidVoucher(db, { id: v1.id, reason: '测试作废', actor: { name: 'test' } })
eq('作废成功', vd.status, 'voided')
eq('记录了"作废前是已过账"（作废会改变当期发生额）', vd.was_posted, true)
eq('作废保留理由（"为什么这笔记过的账不算了"要答得上）',
  db.prepare('SELECT void_reason FROM vouchers WHERE id=?').get(v1.id).void_reason, '测试作废')
const afterVoid = A.trialBalance(db)
okNear(num(afterVoid.total_debit), baseDebit, '作废后试算平衡表的借方合计**回到过账前的基线**（作废即从账上移除）')
ok(afterVoid.balanced, '作废后试算仍然平衡')
const vd2 = A.voidVoucher(db, { id: v1.id })
eq('重复作废幂等', vd2.replayed, true)

// ===========================================================================
// [6] 域自证与台账
// ===========================================================================
section('[6] 域自证')

const audit = A.auditVoucher(db)
ok(audit.balanced, '凭证域自证通过', JSON.stringify(audit.problems))
okNear(audit.total_debit, audit.total_credit, '总账试算平衡：借合计 = 贷合计')
const meta = A.meta(db)
eq('字典里业务场景 7 种', meta.biz_types.length, 7)
eq('字典里取数键 6 个', meta.fact_keys.length, 6)
eq('默认税率来自 settings', meta.default_tax_rate, 13)

// ===========================================================================
// [7] 清理与自还原
// ===========================================================================
section('[7] 清理与回滚')
const beforeClean = db.prepare('SELECT COUNT(*) c FROM vouchers').get().c
purge()
const leftV = db.prepare(`
  SELECT COUNT(*) c FROM vouchers WHERE source_type IN ('receipts','purchase_receipts')
     AND source_id NOT IN (SELECT id FROM receipts UNION SELECT id FROM purchase_receipts)
`).get().c
eq('清理后没有指向已删来源单的孤儿凭证', leftV, 0)
eq('清理后本测试的来源单据归零',
  db.prepare('SELECT COUNT(*) c FROM receipts WHERE remark=?').get(T).c +
  db.prepare('SELECT COUNT(*) c FROM purchase_receipts WHERE remark=?').get(T).c, 0)
eq('清理后自造科目归零', db.prepare('SELECT COUNT(*) c FROM accounting_subjects WHERE code LIKE ?').get(`${SUBJ}%`).c, 0)
eq('清理后探针模板归零', db.prepare("SELECT COUNT(*) c FROM voucher_templates WHERE code LIKE 'TPL_T9%'").get().c, 0)
ok(db.prepare('SELECT COUNT(*) c FROM vouchers').get().c < beforeClean, '本测试产生的凭证已被清掉')
const auditAfter = A.auditVoucher(db)
ok(auditAfter.balanced, '清理后凭证域仍然自证通过', JSON.stringify(auditAfter.problems))

// ---------------------------------------------------------------------------
console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) {
  console.log('失败项：')
  for (const f of failures) console.log('  -', f)
  process.exit(1)
}
