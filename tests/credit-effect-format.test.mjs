/**
 * ============================================================================
 * 文件标识：tests/credit-effect-format.test.mjs ｜ 测试：收款确认 / 作废 / 预收抵扣的授信效果展示格式化（纯函数）
 * ============================================================================
 * 【职责】守住 `src/utils/credit-effect.ts` 的口径：后端（ADR-0013）在确认 / 预收抵扣响应里给
 *   `credit_released: { entries, unified, oc, rows }`、作废响应里给 `credit_reversal: {..., legacy}`，
 *   前端只做**展示**，不许自己算金额、不许把 legacy 说成"已恢复"。
 *   五种形态必须各有一条断言：空 / 只有统一授信 / 只有订货中心 / 混合 / legacy。
 *
 * 【夹具口径】不起服务、不碰库：用 typescript.transpileModule 把 .ts 编成 ESM 再 import（同 user-form-contract）。
 *
 * 【改它要注意什么】金额断言用后端给的 unified / oc 原值，不要在测试里重新求和 ——
 *   否则"前端悄悄自己算"这种错守不住。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

const source = ts.transpileModule(readFileSync(new URL('../src/utils/credit-effect.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText
const { formatCreditEffect, creditEffectSummary } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))

const row = (over = {}) => ({
  id: 1, receipt_id: 9, ar_id: 3, trigger: 'confirm', ledger: 'credit', account_id: 1,
  customer_type: 'dealer', customer_id: 5, source_type: 'SO', source_id: 11, doc_no: 'SO-001', amount: 60, ...over
})

test('缺字段 / 零条目：标记 empty，摘要说明"未触及授信"，不编造行', () => {
  for (const effect of [undefined, null, { entries: 0, unified: 0, oc: 0, rows: [] }]) {
    const v = formatCreditEffect(effect, 'released')
    assert.equal(v.empty, true)
    assert.equal(v.legacy, false)
    assert.deepEqual(v.lines, [])
    assert.equal(v.totals.unified, 0); assert.equal(v.totals.oc, 0)
  }
  assert.match(creditEffectSummary(undefined, 'released'), /未触及授信/)
  assert.match(creditEffectSummary({ entries: 0, unified: 0, oc: 0, rows: [] }, 'reversal'), /未触及授信/)
})

test('只有统一授信：逐行 doc_no / 类型 / 金额，totals 直接取后端 unified，oc 为 0', () => {
  const effect = { entries: 2, unified: 100, oc: 0, rows: [row({ amount: 60 }), row({ id: 2, source_id: 12, doc_no: 'SO-002', amount: 40 })] }
  const v = formatCreditEffect(effect, 'released')
  assert.equal(v.empty, false)
  assert.equal(v.kind, 'released')
  assert.deepEqual(v.lines.map((l) => [l.doc_no, l.type, l.ledger, l.amount]), [['SO-001', 'SO', 'unified', 60], ['SO-002', 'SO', 'unified', 40]])
  assert.equal(v.lines[0].ledger_label, '统一授信')
  assert.deepEqual(v.totals, { unified: 100, oc: 0 })
  assert.match(creditEffectSummary(effect, 'released'), /释放授信/)
  assert.match(creditEffectSummary(effect, 'released'), /统一授信 100\.00/)
  assert.doesNotMatch(creditEffectSummary(effect, 'released'), /订货中心/)
})

test('只有订货中心：ledger 映射为 oc，摘要只提订货中心', () => {
  const effect = { entries: 1, unified: 0, oc: 80, rows: [row({ ledger: 'oc', source_type: 'OC', doc_no: 'OC-77', amount: 80 })] }
  const v = formatCreditEffect(effect, 'released')
  assert.equal(v.lines[0].ledger, 'oc')
  assert.equal(v.lines[0].ledger_label, '订货中心')
  assert.equal(v.lines[0].type, 'OC')
  assert.deepEqual(v.totals, { unified: 0, oc: 80 })
  const s = creditEffectSummary(effect, 'released')
  assert.match(s, /订货中心 80\.00/)
  assert.doesNotMatch(s, /统一授信/)
})

test('混合：两条总额都在；作废口径措辞为"恢复占用"；无 doc_no 时退回 来源类型#id', () => {
  const effect = {
    entries: 2, unified: 60, oc: 80, legacy: false,
    rows: [row({ amount: 60, trigger: 'confirm' }), row({ id: 2, ledger: 'oc', source_type: 'OC', source_id: 77, doc_no: null, amount: 80 })]
  }
  const v = formatCreditEffect(effect, 'reversal')
  assert.equal(v.kind, 'reversal')
  assert.equal(v.legacy, false)
  assert.deepEqual(v.totals, { unified: 60, oc: 80 })
  assert.equal(v.lines[1].doc_no, 'OC#77')
  const s = creditEffectSummary(effect, 'reversal')
  assert.match(s, /恢复占用/)
  assert.match(s, /统一授信 60\.00/); assert.match(s, /订货中心 80\.00/)
})

test('legacy 作废：标 legacy、不算 empty、说明只回补订货中心占用且统一授信未恢复', () => {
  const effect = { entries: 0, unified: 0, oc: 35, rows: [], legacy: true, receipt_id: 9 }
  const v = formatCreditEffect(effect, 'reversal')
  assert.equal(v.legacy, true)
  assert.equal(v.empty, false, 'legacy 回补了 OC，不能当作"没有效果"')
  assert.deepEqual(v.lines, [])
  assert.deepEqual(v.totals, { unified: 0, oc: 35 })
  assert.match(v.note, /迁移前/)
  assert.match(v.note, /订货中心/)
  assert.match(v.note, /统一授信.*未.*恢复|未恢复统一授信/)
  assert.match(creditEffectSummary(effect, 'reversal'), /旧口径|迁移前/)
})

test('legacy 标记只对作废有意义：released 口径忽略 legacy 字段', () => {
  const v = formatCreditEffect({ entries: 0, unified: 0, oc: 0, rows: [], legacy: true }, 'released')
  assert.equal(v.legacy, false)
  assert.equal(v.empty, true)
})
