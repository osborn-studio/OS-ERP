/** Node contract checks. Browser event -> DataPage -> fetch coverage is separate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { updateAccount } from '../server/lib/account-security.js'

const source = ts.transpileModule(readFileSync(new URL('../src/pages/system/user-form.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText
const { prepareUserPayload } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const options = { dealers: [{ value: 17 }], stores: [{ value: 29 }] }

test('DOM select strings restore only the exact numeric option identity; enum fields stay strings', () => {
  const body = { dealer_id: '17', store_id: '29', role: 'dealer', status: 'active', name: 'Fixture', password: null }
  const payload = prepareUserPayload(body, { isEditing: true }, options)
  assert.equal(payload.dealer_id, 17); assert.equal(payload.store_id, 29)
  assert.equal(payload.role, 'dealer'); assert.equal(payload.status, 'active')
  assert.equal(Object.hasOwn(payload, 'password'), false)
  assert.equal(body.dealer_id, '17'); assert.equal(body.password, null, 'Do not mutate React form state')
})

test('existing numeric bindings and explicitly cleared controls preserve intended identity/null semantics', () => {
  assert.deepEqual(prepareUserPayload({ dealer_id: 17, store_id: 29 }, { isEditing: true }, options), { dealer_id: 17, store_id: 29 })
  for (const empty of ['', null, undefined]) {
    const payload = prepareUserPayload({ dealer_id: empty, store_id: empty }, { isEditing: true }, options)
    assert.equal(payload.dealer_id, null); assert.equal(payload.store_id, null)
  }
})

test('unknown, noncanonical, unsafe and nonnumeric selections fail instead of arbitrary Number coercion', () => {
  for (const value of ['017', ' 17', '17.0', '1.7e1', '0x11', '17tail', '999', -1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, {}, []]) {
    assert.throws(() => prepareUserPayload({ dealer_id: value }, { isEditing: true }, options), /有效经销商/)
  }
  for (const values of [[], [{ value: '17' }], [{ value: -1 }]]) {
    assert.throws(() => prepareUserPayload({ dealer_id: '17' }, { isEditing: true }, { ...options, dealers: values }), /有效经销商/)
  }
})

test('untouched and cleared password controls mean keep only when editing', () => {
  for (const password of [undefined, null, '']) {
    assert.equal(Object.hasOwn(prepareUserPayload({ password }, { isEditing: true }, options), 'password'), false)
    assert.equal(prepareUserPayload({ password }, { isEditing: false }, options).password, password)
  }
  for (const password of ['synthetic-new-password-for-test', '   ', 0]) {
    assert.equal(prepareUserPayload({ password }, { isEditing: true }, options).password, password)
  }
})

test('explicit API password:null remains rejected before any write or hashing', async () => {
  // Read-only stand-in: exercise the actual account service validation path without
  // a database, application boot, fixture credentials or changes to auth policy.
  let reads = 0
  const db = { prepare(sql) {
    assert.equal(sql, 'SELECT * FROM users WHERE id=?')
    return { get(id) { assert.equal(id, 7); reads++; return { id: 7, auth_version: 0 } } }
  } }
  await assert.rejects(updateAccount(db, { uid: 1, auth_version: 0 }, 7, { password: null }), { code: 'PASSWORD_POLICY_INVALID', status: 400 })
  assert.equal(reads, 1)
})
