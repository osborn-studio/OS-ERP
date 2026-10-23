/**
 * ============================================================================
 * 文件标识：tests/scope-notice.test.mjs ｜ 测试：403 / 空范围 / 功能关闭提示选择器（纯函数）
 * ============================================================================
 * 【职责】守住 `src/utils/scope-notice.ts`：401 / 403 / FEATURE_DISABLED / 无组织空范围 四类输入各自得到唯一提示，
 *   且失败、加载中、admin、data_scope=all 永远不会被误判成"空范围"或"成功"。
 * 【夹具口径】不起服务、不碰库：typescript.transpileModule 编成 ESM 再 import（同 credit-effect-format）。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const src = readFileSync(fileURLToPath(new URL('../src/utils/scope-notice.ts', import.meta.url)), 'utf8')
const js = ts.transpileModule(src, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { selectScopeNotice, isUnscopedAccount } = await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))

const restricted = { role: 'warehouse', orgId: null, dataScope: 'subtree' }

test('403 -> forbidden and blocking, even with rows or scoped meta', () => {
  for (const meta of [restricted, { role: 'admin', orgId: 1, dataScope: 'all' }, null]) {
    const n = selectScopeNotice({ status: 403, meta, rows: [{ id: 1 }] })
    assert.equal(n.kind, 'forbidden'); assert.equal(n.blocking, true)
  }
})
test('401 -> unauthenticated and blocking', () => {
  const n = selectScopeNotice({ status: 401, rows: [] })
  assert.equal(n.kind, 'unauthenticated'); assert.equal(n.blocking, true)
})
test('FEATURE_DISABLED wins regardless of status and is blocking', () => {
  for (const status of [0, 403, 404, 409, 503]) {
    const n = selectScopeNotice({ status, code: 'FEATURE_DISABLED', meta: restricted, rows: [] })
    assert.equal(n.kind, 'feature_disabled'); assert.equal(n.blocking, true)
  }
})
test('empty list + unscoped account -> empty_scope, non-blocking', () => {
  for (const meta of [restricted, { role: 'purchase', orgId: 5, dataScope: 'none' }, { role: 'x', orgId: 0, dataScope: '' }]) {
    const n = selectScopeNotice({ status: 200, meta, rows: [] })
    assert.equal(n.kind, 'empty_scope'); assert.equal(n.blocking, false)
  }
  assert.equal(selectScopeNotice({ meta: restricted, rows: 0 }).kind, 'empty_scope')
})
test('no notice for admin / data_scope=all / org-bound / non-empty / unknown rows / loading', () => {
  assert.equal(selectScopeNotice({ meta: { role: 'admin', orgId: null, dataScope: 'subtree' }, rows: [] }).kind, 'none')
  assert.equal(selectScopeNotice({ meta: { role: 'boss', orgId: null, dataScope: 'all' }, rows: [] }).kind, 'none')
  assert.equal(selectScopeNotice({ meta: { role: 'purchase', orgId: 3, dataScope: 'subtree' }, rows: [] }).kind, 'none')
  assert.equal(selectScopeNotice({ meta: restricted, rows: [{ id: 1 }] }).kind, 'none')
  assert.equal(selectScopeNotice({ meta: restricted, rows: null }).kind, 'none')
  assert.equal(selectScopeNotice({ meta: null, rows: [] }).kind, 'none')
  assert.equal(selectScopeNotice({ loading: true, status: 403, code: 'FEATURE_DISABLED', meta: restricted, rows: [] }).kind, 'none')
})
test('other failures are never reported as empty_scope', () => {
  for (const status of [400, 404, 409, 500, 503]) assert.equal(selectScopeNotice({ status, meta: restricted, rows: [] }).kind, 'none')
  assert.equal(selectScopeNotice({ code: 'SOMETHING', meta: restricted, rows: [] }).kind, 'none')
})
test('isUnscopedAccount edge cases', () => {
  assert.equal(isUnscopedAccount(undefined), false)
  assert.equal(isUnscopedAccount({ role: 'admin', dataScope: 'none' }), false)
  assert.equal(isUnscopedAccount({ role: 'a', orgId: 7, dataScope: 'org' }), false)
})
