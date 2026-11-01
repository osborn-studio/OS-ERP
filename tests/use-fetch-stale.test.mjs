import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'

// Node-focused contract check for useFetch in src/components/ui.tsx: the real hook body runs against minimal
// react / jsx-runtime / api stubs (no renderer, no browser). Each useState cell is inspectable after reload().
const asModule = source => 'data:text/javascript;base64,' + Buffer.from(source).toString('base64')
const reactStub = asModule(`
export const cells = []
export function useState(init) { const c = { v: typeof init === 'function' ? init() : init }; cells.push(c); return [c.v, (x) => { c.v = typeof x === 'function' ? x(c.v) : x }] }
export const useRef = (v) => ({ current: v })
export const useCallback = (fn) => fn
export const useEffect = () => {}
export const useMemo = (fn) => fn()
export default {}
`)
const jsxStub = asModule('export const jsx = () => null, jsxs = () => null, Fragment = null')
const clientStub = asModule(`
export class ApiError extends Error { constructor(m, status, code) { super(m); this.status = status; this.code = code } }
export const calls = []
export default { get: (path, params) => new Promise((resolve, reject) => calls.push({ params, resolve, reject })) }
`)
const source = ts.transpileModule(readFileSync(new URL('../src/components/ui.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX }
}).outputText
  .replace(/(["'])react\/jsx-runtime\1/g, JSON.stringify(jsxStub))
  .replace(/(["'])react\1/g, JSON.stringify(reactStub))
  .replace(/(["'])\.\.\/api\/client\1/g, JSON.stringify(clientStub))
const ui = await import(asModule(source))
const react = await import(reactStub)
const client = await import(clientStub)

function mount() {
  react.cells.length = 0
  client.calls.length = 0
  const { reload } = ui.useFetch('/master/products', { keyword: '' })
  const [data, loading, error] = react.cells
  return { reload, data, loading, error }
}

test('a slower earlier request that resolves last does not overwrite the newer result', async () => {
  const h = mount()
  const first = h.reload()   // e.g. refresh after save (unfiltered)
  const second = h.reload()  // e.g. 查询 right after (filtered)
  client.calls[1].resolve({ data: { list: ['filtered'] } })
  await second
  assert.deepEqual(h.data.v, { list: ['filtered'] })
  assert.equal(h.loading.v, false)
  client.calls[0].resolve({ data: { list: ['stale'] } })
  await first
  assert.deepEqual(h.data.v, { list: ['filtered'] }, 'stale response must be dropped')
  assert.equal(h.loading.v, false)
})

test('an earlier request finishing first does not clear loading while the newer one is pending', async () => {
  const h = mount()
  const first = h.reload()
  const second = h.reload()
  client.calls[0].resolve({ data: { list: ['stale'] } })
  await first
  assert.equal(h.data.v, null, 'stale response must not be shown')
  assert.equal(h.loading.v, true, 'newer request is still loading')
  client.calls[1].resolve({ data: { list: ['fresh'] } })
  await second
  assert.deepEqual(h.data.v, { list: ['fresh'] })
  assert.equal(h.loading.v, false)
})

test('a stale failure does not replace a newer success, and the latest failure is still reported', async () => {
  const h = mount()
  const first = h.reload()
  const second = h.reload()
  client.calls[1].resolve({ data: { list: ['fresh'] } })
  await second
  client.calls[0].reject(new client.ApiError('forbidden', 403, 'FORBIDDEN'))
  await first
  assert.deepEqual(h.data.v, { list: ['fresh'] })
  assert.equal(h.error.v, null)

  const third = h.reload()
  client.calls[2].reject(new client.ApiError('forbidden', 403, 'FORBIDDEN'))
  await third
  assert.equal(h.error.v, 'forbidden')
  assert.equal(h.data.v, null, '403 on the latest request still clears data')
  assert.equal(h.loading.v, false)
})
