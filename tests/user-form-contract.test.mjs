/** Node contract checks. Browser event -> DataPage -> fetch coverage is separate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { updateAccount } from '../server/lib/account-security.js'

const source = ts.transpileModule(readFileSync(new URL('../src/pages/system/user-form.ts', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }
}).outputText
const { prepareUserPayload, DATA_SCOPES, ORG_CLEAR, ROLE_DEFAULT, flattenOrgTree, userFieldVisible } = await import('data:text/javascript;base64,' + Buffer.from(source).toString('base64'))
const options = { dealers: [{ value: 17 }], stores: [{ value: 29 }], orgs: [{ value: 5 }, { value: 8 }] }

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

// ---- X11: org_id / data_scope contract (PUT /api/auth/users/:id, normalizePatch in account-security.js) ----
const ACCEPTED_EDIT = ['password', 'name', 'role', 'dept', 'phone', 'dealer_id', 'store_id', 'status', 'org_id', 'data_scope']
const fullBody = { username: 'u_fixture', password: null, name: 'N', role: 'viewer', dept: null, phone: null, dealer_id: '', store_id: '',
  status: 'active', last_login_at: '2026-10-01', org_id: '5', data_scope: 'subtree', id: 7, dealer_name: 'x' }

test('payload field names are exactly the accepted ones; display-only columns never sent', () => {
  const edit = prepareUserPayload(fullBody, { isEditing: true }, options)
  assert.deepEqual(Object.keys(edit).sort(), ACCEPTED_EDIT.filter(k => k !== 'password').sort())
  assert.equal(edit.org_id, 5); assert.equal(edit.data_scope, 'subtree'); assert.equal(typeof edit.org_id, 'number')
  const create = prepareUserPayload({ ...fullBody, password: 'synthetic-new-password-for-test' }, { isEditing: false }, options)
  assert.deepEqual(Object.keys(create).sort(), ['username', ...ACCEPTED_EDIT].sort())
})

test('untouched org/scope controls are omitted so an edit can never clear org or reset/widen scope', () => {
  for (const empty of ['', null, undefined]) {
    for (const isEditing of [true, false]) {
      const payload = prepareUserPayload({ name: 'N', org_id: empty, data_scope: empty }, { isEditing }, options)
      assert.equal(Object.hasOwn(payload, 'org_id'), false); assert.equal(Object.hasOwn(payload, 'data_scope'), false)
    }
  }
})

test('explicit sentinels map to null org and role-default scope; scope values are exact strings', () => {
  const p = prepareUserPayload({ org_id: ORG_CLEAR, data_scope: ROLE_DEFAULT }, { isEditing: true }, options)
  assert.equal(p.org_id, null); assert.equal(p.data_scope, '')
  for (const { value } of DATA_SCOPES.filter(s => s.value !== ROLE_DEFAULT)) {
    const body = { org_id: '8', data_scope: value, dealer_id: '17' }
    assert.equal(prepareUserPayload(body, { isEditing: true }, options).data_scope, value)
  }
  for (const bad of ['store', 'none', 'ALL', 'self ', 7, {}]) {
    assert.throws(() => prepareUserPayload({ data_scope: bad }, { isEditing: true }, options), /数据范围/)
  }
  for (const bad of ['999', '05', 8.5, -1, 0, {}]) {
    assert.throws(() => prepareUserPayload({ org_id: bad }, { isEditing: true }, options), /所属组织/)
  }
  assert.throws(() => prepareUserPayload({ org_id: '5' }, { isEditing: true }, { ...options, orgs: undefined }), /所属组织/)
})

test('scope prerequisites are enforced client-side (dealer needs dealer; org scopes need org on create or when clearing)', () => {
  assert.throws(() => prepareUserPayload({ data_scope: 'dealer' }, { isEditing: true }, options), /经销商/)
  assert.equal(prepareUserPayload({ data_scope: 'dealer', dealer_id: '17' }, { isEditing: true }, options).dealer_id, 17)
  for (const scope of ['subtree', 'org', 'self']) {
    assert.throws(() => prepareUserPayload({ data_scope: scope }, { isEditing: false }, options), /所属组织/)
    assert.throws(() => prepareUserPayload({ data_scope: scope, org_id: ORG_CLEAR }, { isEditing: true }, options), /所属组织/)
    assert.equal(prepareUserPayload({ data_scope: scope }, { isEditing: true }, options).data_scope, scope, 'edit keeps the stored org')
  }
})

test('every selectable data_scope is accepted by the real server validation; unsupported ones are not offered', async () => {
  const db = { prepare: () => ({ get: () => ({ id: 7, auth_version: 0, role: 'viewer', 1: 1 }) }) }
  for (const { value } of DATA_SCOPES) {
    const wire = value === ROLE_DEFAULT ? '' : value
    await updateAccount(db, { uid: 1, auth_version: 0 }, 7, { data_scope: wire }).catch(e => {
      assert.notEqual(e.code, 'ACCOUNT_INPUT_INVALID', `server rejects data_scope ${JSON.stringify(wire)}`)
    })
  }
  await assert.rejects(updateAccount(db, { uid: 1, auth_version: 0 }, 7, { data_scope: 'store' }), { code: 'ACCOUNT_INPUT_INVALID' })
  await assert.rejects(updateAccount(db, { uid: 1, auth_version: 0 }, 7, { data_scope: 'none' }), { code: 'ACCOUNT_INPUT_INVALID' })
})

test('org tree flattens with indentation, ignores bad ids and cycles; binding fields show only when relevant', () => {
  const tree = [{ id: 1, name: 'HQ', children: [{ id: 2, name: 'East', children: [{ id: 1, name: 'loop' }] }, { id: 0, name: 'bad' }] }]
  assert.deepEqual(flattenOrgTree(tree), [{ value: 1, label: 'HQ' }, { value: 2, label: '　└ East' }])
  assert.deepEqual(flattenOrgTree(null), [])
  assert.equal(userFieldVisible('dealer_id', { role: 'viewer' }), false)
  assert.equal(userFieldVisible('dealer_id', { role: 'viewer', data_scope: 'dealer' }), true)
  assert.equal(userFieldVisible('dealer_id', { role: 'dealer' }), true)
  assert.equal(userFieldVisible('dealer_id', { role: 'viewer', dealer_id: 17 }), true)
  assert.equal(userFieldVisible('store_id', { role: 'viewer' }), false)
  assert.equal(userFieldVisible('store_id', { role: 'store' }), true)
  assert.equal(userFieldVisible('name', {}), true)
})
