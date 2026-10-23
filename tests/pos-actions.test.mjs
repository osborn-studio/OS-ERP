/**
 * ============================================================================
 * 文件标识：tests/pos-actions.test.mjs ｜ 测试：POS 动作可见 / 可用选择器（纯函数，ADR-0025）
 * ============================================================================
 * 【职责】守住 `src/utils/pos-actions.ts`：无权限点隐藏；自审（开班人核款 / 退回）与自收（缴款人点收）禁用并给原因；
 *   权限未加载时全隐藏；'*' 全开；已报数班次作废另需 pos.shift.review；日结门禁。
 * 【夹具口径】不起服务、不碰库：typescript.transpileModule 编成 ESM 再 import（同 scope-notice.test）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const src = readFileSync(fileURLToPath(new URL('../src/utils/pos-actions.ts', import.meta.url)), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const m = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))
const { selectPosActions, isShiftMaker, SELF_APPROVE_REASON, SAME_PERSON_REASON } = m

const ALL = ['pos.shift', 'pos.shift.review', 'pos.cashdrop', 'pos.cashdrop.receive', 'pos.dailyclose', 'pos.store.check']
const me = { id: 7, name: '王店长', username: 'store07' }
const declared = { status: 'declared', cashier_id: 9, cashier_name: '李收银' }

test('permissions not loaded or empty -> every action hidden', () => {
  for (const permissions of [null, undefined, [], ['pos.view']]) {
    const a = selectPosActions({ permissions, shift: declared, currentUser: me })
    for (const [k, v] of Object.entries(a)) assert.equal(v.visible, false, k)
  }
})
test('each permission shows exactly its own actions', () => {
  const only = (perm) => Object.entries(selectPosActions({ permissions: [perm], shift: { status: 'open', cashier_id: 9 }, currentUser: me }))
    .filter(([, v]) => v.visible).map(([k]) => k).sort()
  assert.deepEqual(only('pos.shift'), ['shift_cancel', 'shift_declare', 'shift_open'])
  assert.deepEqual(only('pos.shift.review'), ['shift_approve', 'shift_reject'])
  assert.deepEqual(only('pos.cashdrop'), ['cashdrop_cancel', 'cashdrop_create'])
  assert.deepEqual(only('pos.cashdrop.receive'), ['cashdrop_receive'])
  assert.deepEqual(only('pos.dailyclose'), ['daily_close'])
  assert.deepEqual(only('pos.store.check'), ['stock_check_adjust', 'stock_check_create'])
})
test('other person declared shift -> approve / reject enabled', () => {
  const a = selectPosActions({ permissions: ALL, shift: declared, currentUser: me })
  assert.deepEqual(a.shift_approve, { visible: true, enabled: true, reason: '' })
  assert.equal(a.shift_reject.enabled, true)
})
test('own shift -> approve / reject visible but disabled with POS_SELF_APPROVE reason; admin not exempt', () => {
  const own = { status: 'declared', cashier_id: 7, cashier_name: '王店长' }
  for (const permissions of [ALL, ['*']]) {
    const a = selectPosActions({ permissions, shift: own, currentUser: me })
    for (const k of ['shift_approve', 'shift_reject']) {
      assert.equal(a[k].visible, true); assert.equal(a[k].enabled, false); assert.equal(a[k].reason, SELF_APPROVE_REASON)
    }
    assert.match(a.shift_approve.reason, /POS_SELF_APPROVE/)
  }
})
test('self-approve without review permission stays hidden (no reason leak, no button)', () => {
  const a = selectPosActions({ permissions: ['pos.shift'], shift: { status: 'declared', cashier_id: 7 }, currentUser: me })
  assert.equal(a.shift_approve.visible, false)
})
test('name fallback only when cashier_id is absent (mirrors server)', () => {
  assert.equal(isShiftMaker({ cashier_id: null, cashier_name: '王店长' }, me), true)
  assert.equal(isShiftMaker({ cashier_id: undefined, cashier_name: 'store07' }, me), true)
  assert.equal(isShiftMaker({ cashier_id: 9, cashier_name: '王店长' }, me), false)
  assert.equal(isShiftMaker({ cashier_id: null, cashier_name: '' }, { id: 7, name: '' }), false)
  assert.equal(isShiftMaker({ cashier_id: 7 }, null), false)
  assert.equal(isShiftMaker({ cashier_id: '7' }, me), true)
})
test('cash drop receive: handed_by === me disabled with SAME_PERSON; other person enabled', () => {
  const same = selectPosActions({ permissions: ALL, currentUser: me, cashDrop: { status: 'pending', handed_by: 7 } })
  assert.equal(same.cashdrop_receive.enabled, false); assert.equal(same.cashdrop_receive.reason, SAME_PERSON_REASON)
  const other = selectPosActions({ permissions: ALL, currentUser: me, cashDrop: { status: 'pending', handed_by: 3 } })
  assert.equal(other.cashdrop_receive.enabled, true)
  assert.equal(selectPosActions({ permissions: ['pos.cashdrop'], currentUser: me, cashDrop: { handed_by: 3 } }).cashdrop_receive.visible, false)
})
test('cancelling a declared shift needs pos.shift.review; open shift does not', () => {
  assert.equal(selectPosActions({ permissions: ['pos.shift'], shift: declared, currentUser: me }).shift_cancel.visible, false)
  assert.equal(selectPosActions({ permissions: ['pos.shift', 'pos.shift.review'], shift: declared, currentUser: me }).shift_cancel.enabled, true)
  assert.equal(selectPosActions({ permissions: ['pos.shift'], shift: { status: 'open' }, currentUser: me }).shift_cancel.enabled, true)
})
test('daily close gate disables with reason but keeps visible', () => {
  const a = selectPosActions({ permissions: ALL, currentUser: me, dailyCloseGate: { ok: false, blocking: [1] } })
  assert.equal(a.daily_close.visible, true); assert.equal(a.daily_close.enabled, false); assert.ok(a.daily_close.reason)
  assert.equal(selectPosActions({ permissions: ALL, currentUser: me, dailyCloseGate: { ok: true } }).daily_close.enabled, true)
  assert.equal(selectPosActions({ permissions: ['pos.shift'], currentUser: me, dailyCloseGate: { ok: false } }).daily_close.visible, false)
})
