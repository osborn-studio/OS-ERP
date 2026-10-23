/**
 * ============================================================================
 * 文件标识：tests/browser/scenario-data.mjs ｜ AA8 三个浏览器场景共用的"接口层"数据期望
 * ============================================================================
 * 只含不依赖浏览器的部分：造数、同一批接口调用、CSV 解析、游标翻页遍历。
 * 场景（my-scope / audit-logs / inventory-paging）用它们定下"页面应当显示什么"，
 * tests/browser-scenario-contracts.test.mjs 在本机 macOS 对 test 模式服务跑同一批调用，
 * 证明这些数据期望成立（浏览器那一半仍只在 Linux 托管 CI 上执行）。
 * 约束：不打印账号、密码、令牌；造数只用随机后缀的批次前缀，不碰既有演示行。
 * ============================================================================
 */
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'

export const AUDIT_CSV_HEADER = ['id', 'created_at', 'user_id', 'user_name', 'module', 'action', 'entity', 'entity_id', 'detail', 'ip']

const okData = (r, what) => {
  assert.equal(r.status, 200, `${what}: expected 200, got ${r.status}`)
  return r.body.data
}

/** 一个没有下级的组织（它的名字就是"仅本组织"范围的全部内容）。 */
export async function pickLeafOrg(api, adminToken) {
  const orgs = okData(await api('/api/auth/orgs', { token: adminToken }), 'orgs')
  const parents = new Set(orgs.map((o) => o.parent_id).filter((x) => x !== null && x !== undefined))
  const names = new Map()
  for (const o of orgs) names.set(o.name, (names.get(o.name) || 0) + 1)
  const leaf = orgs.find((o) => !parents.has(o.id) && o.status === 'active' && names.get(o.name) === 1)
  assert.ok(leaf, 'demo data must provide a uniquely named leaf org')
  return leaf
}

/** my-scope 接口对 org 范围账号 / admin 的期望形状（页面文本必须与它一致）。 */
export function expectOrgScoped(d, org) {
  assert.equal(d.is_admin, false)
  assert.equal(d.data_scope_effective, 'org')
  assert.equal(d.data_scope_source, 'user')
  assert.equal(d.org?.id, org.id)
  assert.equal(d.org?.name, org.name)
  assert.equal(d.org_ids_in_scope.all, false)
  assert.equal(d.org_ids_in_scope.count, 1)
  assert.deepEqual(d.org_ids_in_scope.names, [org.name])
  assert.ok(d.explanations.length >= 2)
  assert.ok(d.explanations.some((s) => s.includes(`「${org.name}」`)), 'an explanation must name the org')
}
export function expectAdminScope(d) {
  assert.equal(d.is_admin, true)
  assert.equal(d.data_scope_effective, 'all')
  assert.equal(d.data_scope_source, 'admin')
  assert.equal(d.org_ids_in_scope.all, true)
  assert.equal(d.org_ids_in_scope.count, null)
  assert.ok(d.explanations.length >= 1)
}

/** 最小 RFC4180 解析（审计 CSV 恒加引号、引号加倍、行以 CRLF 结尾；单元格里可能含换行）。 */
export function parseCsv(text) {
  const src = text.replace(/^﻿/, '')
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { cell += '"'; i++ } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') { row.push(cell); cell = '' }
    else if (ch === '\r' && src[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++ }
    else cell += ch
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
  return rows
}

export const csvRecords = (text) => {
  const [header, ...rest] = parseCsv(text)
  return { header, records: rest.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i]]))) }
}

const listAudit = async (api, token, params) => {
  const qs = new URLSearchParams({ pageSize: '200', ...params }).toString()
  return okData(await api(`/api/meta/audit-logs?${qs}`, { token }), 'audit-logs')
}

/**
 * 保证审计里至少有两个模块：先写一条 inventory 模块的 ADJUST 审计（真实库存调整），
 * 登录与建账号本来就留下 auth 等模块的行。返回过滤用的模块名与接口给出的期望。
 */
export async function prepareAuditModule(api, adminToken) {
  const opts = okData(await api('/api/master/options', { token: adminToken }), 'options')
  const wh = opts.warehouses?.[0]
  const sku = opts.skus?.[0]
  assert.ok(wh && sku, 'demo data must provide a warehouse and a SKU')
  const batch = `AUD${randomBytes(3).toString('hex')}`
  okData(await api('/api/inventory/adjust', { token: adminToken, body: { warehouse_id: wh.value, sku_id: sku.value, batch_no: batch, qty: 1, direction: 'in', reason: 'aa8 audit fixture' } }), 'adjust')
  const module = 'inventory'
  const filtered = await listAudit(api, adminToken, { module })
  const unfiltered = await listAudit(api, adminToken, {})
  assert.ok(filtered.total >= 1, 'the adjust must leave an inventory audit row')
  assert.ok(unfiltered.total > filtered.total, 'unfiltered audit must contain rows from other modules, so the filter is observable')
  assert.ok(filtered.list.every((r) => r.module === module))
  assert.ok(unfiltered.list.some((r) => r.module !== module), 'a non-matching module must exist in the unfiltered first page')
  return { module, filteredTotal: filtered.total, unfilteredTotal: unfiltered.total }
}

export const exportAuditRows = async (api, token) => {
  const d = await listAudit(api, token, { module: 'audit', action: 'AUDIT_LOG_EXPORT' })
  return d
}

/** 经真实库存调整接口造 `count` 个互不相同的批次行（同仓同 SKU，批次不同 ⇒ 不同 inventory_stocks 行）。 */
export async function seedStockRows(api, adminToken, count) {
  const opts = okData(await api('/api/master/options', { token: adminToken }), 'options')
  const wh = opts.warehouses?.[0]
  const sku = opts.skus?.[0]
  assert.ok(wh && sku, 'demo data must provide a warehouse and a SKU')
  const prefix = `PG${randomBytes(3).toString('hex').toUpperCase()}-`
  const batches = []
  for (let i = 1; i <= count; i++) {
    const batch = `${prefix}${String(i).padStart(3, '0')}`
    okData(await api('/api/inventory/adjust', { token: adminToken, body: { warehouse_id: wh.value, sku_id: sku.value, batch_no: batch, qty: 3, direction: 'in', reason: 'aa8 paging fixture' } }), `adjust ${i}`)
    batches.push(batch)
  }
  return { prefix, batches, warehouseId: wh.value }
}

/**
 * 沿 next_after_id 逐页取库存。每页都核对：total/summary 只在第一页出现、has_more 与 next_after_id 一致、id 严格递增。
 * 返回各页行 id 与批次，以及用 pageSize=500 一次取全得到的基准集合。
 */
export async function walkStocks(api, token, keyword, pageSize) {
  const pages = []
  let after = null
  for (let guard = 0; guard < 100; guard++) {
    const qs = new URLSearchParams({ pageSize: String(pageSize), keyword, ...(after === null ? {} : { after_id: String(after) }) })
    const d = okData(await api(`/api/inventory/stocks?${qs}`, { token }), 'stocks')
    const first = after === null
    assert.equal('total' in d, first, `total must be present only on the first page (page ${pages.length + 1})`)
    assert.equal('summary' in d, first, `summary must be present only on the first page (page ${pages.length + 1})`)
    assert.ok(d.list.length <= pageSize)
    assert.equal(d.has_more, d.next_after_id !== null)
    if (d.has_more) {
      assert.equal(d.list.length, pageSize, 'a page with more behind it must be full')
      assert.equal(d.next_after_id, d.list.at(-1).id)
    }
    pages.push({ after, total: d.total, ids: d.list.map((r) => r.id), batches: d.list.map((r) => r.batch_no), hasMore: d.has_more, next: d.next_after_id })
    if (!d.has_more) break
    after = d.next_after_id
  }
  const baseline = okData(await api(`/api/inventory/stocks?${new URLSearchParams({ pageSize: '500', keyword })}`, { token }), 'stocks baseline')
  return { pages, baselineIds: baseline.list.map((r) => r.id), baselineTotal: baseline.total }
}

/** 并集恰等于基准集合、每个 id 只出现一次、跨页严格升序。 */
export function assertExactlyOnce(walk, expectedCount) {
  const all = walk.pages.flatMap((p) => p.ids)
  assert.equal(all.length, expectedCount, 'page sizes must add up to the seeded row count')
  assert.equal(new Set(all).size, all.length, 'no id may repeat across pages')
  assert.deepEqual([...all].sort((a, b) => a - b), [...walk.baselineIds].sort((a, b) => a - b), 'union of pages must equal the one-shot set')
  assert.deepEqual(all, [...all].sort((a, b) => a - b), 'ids must ascend across pages')
  assert.equal(walk.pages[0].total, expectedCount, 'first page carries the full total')
  assert.equal(walk.baselineTotal, expectedCount)
  assert.ok(walk.pages.slice(1).every((p) => p.total === undefined))
}

/** 某模块下全部审计行 id（逐页取，pageSize 上限 200）。 */
export async function auditIds(api, token, params) {
  const ids = []
  for (let page = 1; page < 100; page++) {
    const d = await listAudit(api, token, { ...params, page: String(page) })
    ids.push(...d.list.map((r) => r.id))
    if (ids.length >= d.total || !d.list.length) return { ids, total: d.total }
  }
  throw new Error('audit listing did not terminate')
}

/** 直接取导出 CSV（不经浏览器）；返回状态、响应头与解析后的记录。 */
export async function fetchAuditCsv(base, token, query) {
  const res = await fetch(new URL(`/api/meta/audit-logs/export.csv?${query}`, base), { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000) })
  const text = await res.text()
  return { status: res.status, headers: res.headers, ...(res.status === 200 ? csvRecords(text) : { header: null, records: [] }) }
}
