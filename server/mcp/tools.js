/**
 * ============================================================================
 * 文件标识：server/mcp/tools.js ｜ MCP 工具注册表：把系统业务能力以标准 MCP 工具暴露
 * ============================================================================
 * 【职责】MCP 工具注册表：把系统业务能力以标准 MCP 工具暴露
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// MCP 工具注册表：把系统业务能力以标准 MCP 工具暴露
//
// 三级开放程度（第三轮 A1）：
//   read   查询类，可用即开
//   write  事务类，强制幂等键（idempotency_key），重复调用返回首次结果
//   danger 高危类（调价/作废/审批通过/库存调整），必须走二次确认（confirm_token）
//
// 设计原则：工具直接复用五维库存引擎与组织数据权限，而不是另写一套取数逻辑 ——
//          这样 AI 看到的数据与人在界面上看到的永远一致，不会出现「AI 说还有 10 件、页面显示 0 件」。

import { pickBatches, queryBalance, costOf, getInvParam, resolveOwnerOrg, applyStockGain, listBelowSafe } from '../lib/stock.js'
import { localDate, localNow } from '../lib/dates.js'
// D5：MCP 工具不再"平行实现"业务 —— 有领域服务的一律调领域服务
import { decideApproval, ApprovalError } from '../lib/approval.js'
import { cancelOrder, SalesOrderError, salesScopeSql } from '../lib/sales-order.js'
import { logPriceChange } from '../lib/pricing.js'
// 采购域领域服务（批次 K）。**每一个采购写型工具只做两件事**：
// 校验入参与组织归属，然后把动作交给下面这些函数 —— 一行业务 SQL 都不在这里写。
import {
  PurchaseError,
  resolvePurchasePrices,
  createRequisition, convertRequisitionToOrder,
  createPurchaseOrder, receivePurchaseOrder, transitionPurchaseOrder,
  createInvoice, buildSettlement, createPayment, createPurchaseReturn,
  // 「只能走带参数业务入口」的动作闸门 —— **定义在领域层**（`lib/purchase.js`），
  // 这里只是调用方。原来这份判据长在 MCP 这一层，于是 HTTP 入口完全没有它
  // （`POST /orders/:id/status {"action":"receive"}` 一路 200、账却不动）。
  // 现在 HTTP / MCP / 通用流转入口三条路调**同一份**，被拒时的码与文案逐字相同。
  assertNotParamOnly
} from '../lib/purchase.js'
import {
  DocFlowError, getDocType, assertEdgePermitted, dispatchTransition, docInScope
} from '../lib/docflow.js'
// 金额/数量与权限点的**唯一判据**（与 HTTP 入口同一个）
import { numAmount, numQty, permContext, hasPerm, resolveOrgScope } from '../middleware/auth.js'
import { assertCanViewDocType, canViewDocType, bindingWhere, rowInBinding, TOKEN_OWNER_PERM_DENIED } from './doc-perms.js'

/**
 * `perms`（ADR-0011）：有主令牌调用该工具时，**令牌所有者此刻**必须持有其中任一权限点
 * （判据 = HTTP 的 `permContext` / `hasPerm`，由 `mcp/delegation.js` 统一执行，本文件不自判）。
 *   · 与 HTTP 入口对齐：入库 = `purchase.inbound`、出库 = `sales.outbound`、调拨 / 货权 / 调整 =
 *     `inventory.*`、采购建单 = 工具内已有的那一个码、调价 = `master.price.edit`……
 *   · `[]` = 不设额外权限点（字典 / 看板 / 组织树，以及边权限在工具内按状态机判定的 `advance_*`
 *     与 `doc.transition`）—— 它们仍受令牌级别、数据范围交集与工具内自己的闸门约束。
 *   · 无主令牌不过此门（它没有所有者可对照），其写能力仍由 `AGENT_OWNER_REQUIRED` 等工具内判据限制。
 */
export const LEVELS = { read: 'read', write: 'write', danger: 'danger' }

const S = {
  str: (d) => ({ type: 'string', description: d }),
  // 第二参是**额外的 JSON Schema 约束**（如 { exclusiveMinimum: 0 }）。
  // 约束写在这里而不是 handler 里：同一份「数量必须为正」只有一个出处，
  // 且会随 tools/list 一起告诉客户端「这个参数我不收 0 和负数」。
  num: (d, o = {}) => ({ type: 'number', description: d, ...o }),
  int: (d, o = {}) => ({ type: 'integer', description: d, ...o }),
  bool: (d) => ({ type: 'boolean', description: d }),
  arr: (d) => ({ type: 'array', description: d, items: { type: 'object' } })
}

function like(v) {
  return `%${String(v).trim()}%`
}

function today() {
  return localDate()
}

function ok(data, summary) {
  return { data, summary }
}

/**
 * 把 `numAmount` / `numQty` 的校验结果转成"要么取值、要么抛业务错误"。
 *
 * 它们是**唯一校验器**，返回值形如 `{ ok, value }` / `{ ok:false, message }` ——
 * 直接把结果当数字用会静默出错：一个对象被当成 better-sqlite3 的**命名参数集合**，
 * 报的是 `Too few parameter values were provided`，
 * 完全看不出"其实是金额校验没过"（本批真实踩到）。
 * 所以统一从这个口子取数。
 */
function mustNum(chk) {
  if (!chk?.ok) {
    const e = new Error(chk?.message || '数值校验未通过')
    e.code = chk?.code || 'AMOUNT_INVALID'
    e.status = 400
    throw e
  }
  return chk.value
}

// 数据权限：把 token 绑定的主体换算成可见组织集合的 SQL 片段
function orgFilter(ctx, alias, column = 'org_id') {
  if (!ctx.scope || ctx.scope.scope === 'all' || !ctx.scope.orgIds) return { sql: '', params: [] }
  const ids = ctx.scope.orgIds
  if (!ids.length) return { sql: ' AND 1=0 ', params: [] }
  return { sql: ` AND ${alias}.${column} IN (${ids.map(() => '?').join(',')}) `, params: [...ids] }
}

// ---------------------------------------------------------------------------
// 写路径的组织归属校验（A03）
//
// 为什么列表有过滤、写却没有：`orgFilter` 只被查询用，它是「看哪些行」的判据。
// 而写工具的货主来自**调用方传参** —— `args.owner_org_id ?? ctx.orgId`，
// 显式传一个不属于本令牌子树的组织时**直接采信**。实测（验收独立复现）：
// 令牌 org=5（path `/1/2/5/`）调 `inventory.stock_in` 传 `owner_org_id=3` → **成功**，
// 库内该批次 `owner_org_id=3`、`qty_on_hand=1`。
// 也就是「我只能看 5 号组织，但能往 3 号组织里入库」。
//
// 判据只有这一处：**读和写共用同一个 scope 定义**（`ctx.scope` 由 buildContext
// 从令牌绑定的组织子树算出），不再各写一套。
// ---------------------------------------------------------------------------

/** 目标组织是否落在本令牌的组织范围内（未绑组织的令牌 = 全局，放行） */
function assertOrgInScope(ctx, orgId, label = '货主组织') {
  if (orgId == null) return null
  const s = ctx.scope || { scope: 'all', orgIds: null }
  if (s.scope === 'all' || !s.orgIds) return Number(orgId)
  const id = Number(orgId)
  if (s.orgIds.includes(id)) return id
  const e = new Error(`${label} #${id} 不在本令牌的组织范围内`)
  e.code = 'ORG_OUT_OF_SCOPE'
  e.status = 403
  e.detail = { orgId: id, label, visibleOrgCount: s.orgIds.length }
  throw e
}

/**
 * 仓库本身 + **本次实际要用的货主**都必须在范围内；返回解析出的货主组织。
 *
 * `ownerOrgId` 的语义是「**这一次操作用哪个货主**」：
 *   · 传了值（显式传参，或令牌有默认组织）→ 就用它判定；
 *   · 传 null → 才回落到仓库默认货主（`resolveOwnerOrg`）。
 *
 * **不要无条件拿仓库默认货主判定** —— 多货主仓库里，"范围内仓 + 范围内显式货主"
 * 会被一个**本次根本不会用到的**默认货主挡住。这是验收侧 §27.2 独立复现的**正向误伤**：
 * 令牌组织 5、目标仓 4 的 `org_id=6` 在子树内、显式 `owner_org_id=6` 也在子树内，
 * 却因为仓库默认货主是 #1 而返回 `ORG_OUT_OF_SCOPE`。
 * 教训与第 2 批同源：**收紧一条门必须先跑一遍「这条门原本该放谁进来」** ——
 * 这次是收紧一个判定时没跑正向对照。
 */
function assertWarehouseInScope(ctx, db, warehouseId, { ownerOrgId = null, label = '仓库' } = {}) {
  const wh = db.prepare('SELECT id, name, org_id, default_owner_org_id FROM warehouses WHERE id=?').get(warehouseId)
  if (!wh) {
    const e = new Error(`${label} #${warehouseId} 不存在`)
    e.code = 'WAREHOUSE_NOT_FOUND'
    e.status = 404
    throw e
  }
  assertOrgInScope(ctx, wh.org_id, `${label} #${warehouseId} 所属组织`)
  const explicit = ownerOrgId != null
  const target = explicit ? Number(ownerOrgId) : resolveOwnerOrg(db, warehouseId, null)
  assertOrgInScope(
    ctx,
    target,
    explicit ? `${label} #${warehouseId} 的货主组织` : `${label} #${warehouseId} 的默认货主组织`
  )
  return target
}

/**
 * 组织范围 → 各业务主体的可见 id 集（A03 增量，单一定义处）。null = 不受限。
 *
 * 为什么需要这一层：**单据表（采购/销售）没有 `org_id` 列** —— 它们靠
 * `store_id` / `dealer_id` / `warehouse_id` 归属，而这些主体各自挂在某个组织下。
 * 所以"令牌能看哪些单"必须先把组织范围映射成主体集合，而不是给单据表硬找一个 org 列。
 */
function scopeEntityIds(ctx, db) {
  const s = ctx.scope
  if (!s || s.scope === 'all' || !s.orgIds) return null
  const ids = s.orgIds
  if (!ids.length) return { orgIds: [], storeIds: [], dealerIds: [], warehouseIds: [] }
  const ph = ids.map(() => '?').join(',')
  const pick = (sql) => {
    try {
      return db.prepare(sql).all(...ids).map((r) => r.id)
    } catch {
      return [] // 表不存在（分行业裁剪）时按"看不到"处理
    }
  }
  return {
    orgIds: ids,
    storeIds: pick(`SELECT id FROM stores WHERE org_id IN (${ph})`),
    dealerIds: pick(`SELECT id FROM dealers WHERE org_id IN (${ph})`),
    warehouseIds: pick(`SELECT id FROM warehouses WHERE org_id IN (${ph})`)
  }
}

/**
 * 把「这些归属列里任意一个落在可见主体集内」写成 SQL 条件。
 * 一个主体集都算不出来（或该表没有任何可用的归属列）→ `AND 1=0`，
 * **宁可什么都看不到，也不要放行**。
 *
 * 归属列一律写**裸列名**，表别名由 `alias` 传入 ——
 * 这样同一份 `PURCHASE_DOC_SCOPE` 既能喂 SQL（`entityScopeClause`）也能喂逐行 JS 判断
 * （`entityRowVisible` 读的是 `row[列名]`，加了前缀就取不到了）。
 * 原来 SQL 侧传的是 `po.warehouse_id`、JS 侧传的是 `warehouse_id` —— 同一件事两种写法，
 * 迟早只改一处（"列表挡得住、单条挡不住"的形状）。
 */
function entityScopeClause(e, { orgs = [], stores = [], dealers = [], warehouses = [] } = {}, { alias = '' } = {}) {
  if (!e) return { sql: '', params: [] }
  const ors = []
  const params = []
  const q = (c) => (alias ? `${alias}.${c}` : c)
  const add = (cols, ids) => {
    if (!cols.length || !ids.length) return
    const ph = ids.map(() => '?').join(',')
    for (const c of cols) {
      ors.push(`${q(c)} IN (${ph})`)
      params.push(...ids)
    }
  }
  add(orgs, e.orgIds)
  add(stores, e.storeIds)
  add(dealers, e.dealerIds)
  add(warehouses, e.warehouseIds)
  return ors.length ? { sql: ` AND (${ors.join(' OR ')}) `, params } : { sql: ' AND 1=0 ', params: [] }
}

/**
 * JS 版的同一份判据：这一行是否落在可见主体集内。
 * 与 `entityScopeClause` 同源（都从 `scopeEntityIds` 派生）——
 * "列表用 SQL 过滤、单条用 JS 判断"这种两套写法正是 D2 的原形，这里从一开始就只留一份定义。
 */
function entityRowVisible(e, row, { orgs = [], stores = [], dealers = [], warehouses = [] } = {}) {
  if (!e) return true
  const hit = (cols, ids) => cols.some((c) => row[c] != null && ids.includes(Number(row[c])))
  return (
    hit(orgs, e.orgIds) ||
    hit(stores, e.storeIds) ||
    hit(dealers, e.dealerIds) ||
    hit(warehouses, e.warehouseIds)
  )
}

// ---------------------------------------------------------------------------
// 采购域：组织归属 —— 读列表与写闸门**同一份定义**（批次 K）
// ---------------------------------------------------------------------------
// 为什么必须共用：A03 那条缺陷的形状就是「列表挡得住、写路径挡不住」。
// 读侧 `purchase.list_orders` 已经按 `warehouse_id / target_store_id` 过滤；
// 写侧若另写一套（比如"再带上供应商"），就会出现
// **「列表里看不到这张单，却能推进它」**——两个入口各说各话。
// 所以这里把 PO 的归属列**照抄**读列表那一组（一个字都不差），
// 其余单据类型按"这张表上真的能回答'归谁'的那一列"来定。
const PURCHASE_DOC_SCOPE = {
  PRQ: { name: '请购单', table: 'purchase_requisitions', orgs: ['org_id'], warehouses: ['warehouse_id'] },
  // ↓ 与 `purchase.list_orders` 的 entityScopeClause 参数完全一致
  PO: { name: '采购订单', table: 'purchase_orders', warehouses: ['warehouse_id'], stores: ['target_store_id'] },
  GR: { name: '收货单', table: 'purchase_receipts', warehouses: ['warehouse_id'] },
  PRT: { name: '采购退货单', table: 'purchase_returns', warehouses: ['warehouse_id'] },
  // ↓ 这三张单没有仓库/门店列，用它们自己的 `org_id`（建单时写入）。
  //    存量行为空 ⇒ 受限令牌动不了 —— 这是**刻意的安全默认**（同 `entityScopeClause` 的 `AND 1=0`）。
  PI: { name: '采购发票', table: 'purchase_invoices', orgs: ['org_id'] },
  PST: { name: '采购结算单', table: 'purchase_settlements', orgs: ['org_id'] },
  PAY: { name: '付款单', table: 'purchase_payments', orgs: ['org_id'] }
}
//
// ⚠️ **刻意不用 `suppliers.org_id` 做归属判据**（本批实测踩到的正向误伤）：
// 供应商主体在组织树上是**总部子树的兄弟**（`/37/` vs `/1/…`），
// 而 `POST /api/mcp/tokens` 会把令牌绑到签发人的组织（总部）——
// 于是"供应商组织必须在范围内"这条判据对**所有内部令牌**恒为假：
// 建单 403、连读都读不到，而界面上什么线索都没有。
// §27.2 的教训在这里第二次生效：**收紧一条门之前，先跑一遍"这条门原本该放谁进来"**。
// 供应商是外部伙伴，不该用它来判"这单归不归我管" —— 归属只认内部的货主组织 / 仓库 / 门店。

/**
 * 已有单据的组织归属闸门。返回单据行（省一次查询）。
 * 越界时返回 404 而不是 403 —— 报 403 等于确认"这张单存在但不是你的"，
 * 与 `order.trace_document` 的口径一致。
 */
function assertPurchaseDocInScope(ctx, db, docType, id) {
  const spec = PURCHASE_DOC_SCOPE[docType]
  if (!spec) {
    const e = new Error(`未知单据类型 ${docType}`); e.code = 'BAD_DOC_TYPE'; e.status = 400; throw e
  }
  const row = db.prepare(`SELECT * FROM ${spec.table} WHERE id=?`).get(Number(id))
  if (!row) {
    const e = new Error(`${spec.name} #${id} 不存在`); e.code = 'DOC_NOT_FOUND'; e.status = 404; throw e
  }
  const scope = scopeEntityIds(ctx, db)
  if (scope && !entityRowVisible(scope, row, spec)) {
    const e = new Error(`${spec.name} #${id} 不在本令牌的组织范围内`)
    e.code = 'DOC_NOT_FOUND'; e.status = 404
    e.detail = { docType, id, visible_warehouses: scope.warehouseIds.length, visible_stores: scope.storeIds.length }
    throw e
  }
  return row
}

/**
 * 建单前的组织归属闸门：**判的是这次操作实际会用到的主体**。
 * §27.2 的教训：不要拿"这次根本用不到的"主体去判（那是正向误伤）；
 * 但参数里明确给了的每一个主体，都必须能回答"它归谁、那个组织在不在我范围内"。
 * 主体查不到 → 404（不存在就是不存在，不能当成"不在范围内"混过去）。
 */
function assertPurchaseWriteScope(ctx, db, { orgs = [], warehouses = [], stores = [] } = {}, label = '采购单据') {
  const s = ctx.scope || { scope: 'all', orgIds: null }
  if (s.scope === 'all' || !s.orgIds) return
  const look = (table, id, what) => {
    if (id == null) return
    const row = db.prepare(`SELECT org_id FROM ${table} WHERE id=?`).get(Number(id))
    if (!row) {
      const e = new Error(`${label}：${what} #${id} 不存在`)
      e.code = 'TARGET_NOT_FOUND'; e.status = 404
      throw e
    }
    assertOrgInScope(ctx, row.org_id, `${label}的${what} #${id} 所属组织`)
  }
  // 受限范围下"没有任何归属"不等于"不受限"：org / 仓库 / 门店一个都没给（令牌也没绑组织）时，
  // 单据会落成无主行，而范围内的人永远看不到它 —— 与读侧 `AND 1=0` 同口径，fail-closed（W5 矩阵验收发现）。
  const given = [...orgs, ...warehouses, ...stores].some((v) => v != null)
  if (!given) {
    const e = new Error(`${label}：受限数据范围下必须指明归属（org_id / 仓库 / 门店），不能创建无主单据`)
    e.code = 'ORG_OUT_OF_SCOPE'; e.status = 403
    e.detail = { label, visibleOrgCount: s.orgIds.length }
    throw e
  }
  for (const id of orgs) assertOrgInScope(ctx, id, `${label}的货主组织 #${id}`)
  for (const id of warehouses) look('warehouses', id, '仓库')
  for (const id of stores) look('stores', id, '门店')
}

// ---------------------------------------------------------------------------
// MCP 采购写型工具的执行人与权限（批次 K）
// ---------------------------------------------------------------------------
// 这一块回答的是「Agent 凭什么代表公司建单 / 批准采购单」。
// 与 `approval.approve` 的设计问题同源，答案也是同一个：**它不代替，它转呈**。
//
//   · danger 级（推进状态 / 动货 / 动钱）→ 人工二次确认 → 执行人 = **确认单上的真人**；
//   · write  级（建草稿单据）           → 执行人 = **令牌所有者**（`agent_tokens.owner_user_id`）。
//
// 为什么写型也要求"一个真人"：采购单据上要落 `created_by` / `approved_by`，
// 「谁买的、谁批的」不能是空。无主的令牌（`ensureDemoTokens` 早期那种）建不出一张可追责的单。
// 权限判定与 HTTP **同一份**（`permContext` + `assertEdgePermitted`）——
// 否则「同一个人，界面点不动、Agent 能动」这扇后门就永远关不上。

/** 令牌所有者 / 确认人 → 一个真实用户。写型与高危型都**必须**能答出"是谁在办" */
function mcpActor(db, ctx, { requireReal = false } = {}) {
  const c = ctx?.confirmedBy
  if (c?.id != null) {
    const u = db.prepare('SELECT id, name, username FROM users WHERE id=?').get(Number(c.id))
    return { id: Number(c.id), name: c.name || u?.name || u?.username || `uid:${c.id}`, source: 'confirmer' }
  }
  const ownerId = ctx?.ownerUserId
  const u = ownerId != null ? db.prepare('SELECT id, name, username FROM users WHERE id=?').get(Number(ownerId)) : null
  if (!u) {
    const e = new Error(
      '该采购动作需要归责到一个真实用户：要么令牌绑定所有者（`agent_tokens.owner_user_id`），' +
        '要么走人工二次确认由确认人签字。无主的令牌不能建单/推进采购单据。'
    )
    e.code = requireReal ? 'AGENT_ACTOR_REQUIRED' : 'AGENT_OWNER_REQUIRED'
    e.status = 403
    throw e
  }
  return { id: u.id, name: u.name || u.username || `uid:${u.id}`, source: 'owner' }
}

/** 「当前执行人有哪些权限点」——判据是 HTTP 那一个 `permContext`，不另写 */
function actorPermCtx(db, ctx) {
  const id = ctx?.confirmedBy?.id ?? ctx?.ownerUserId ?? null
  return permContext(db, { uid: id })
}

/**
 * 令牌所有者**此刻**的权限上下文；无主令牌返回 null（它是独立服务主体，没有"所有者"可对照）。
 * 为什么与执行人分开判：danger 工具的执行人是确认单上的签字人，签字人有权限不等于所有者有权限 ——
 * 令牌能做的事 = 令牌范围 ∩ 所有者当前权限（ADR-0011），不能靠换一个有权限的人来点确认去绕开。
 */
function ownerPermCtx(db, ctx) {
  return ctx?.ownerUserId != null ? permContext(db, { uid: ctx.ownerUserId }) : null
}

/** 固定权限码闸门（用于没有"边"的动作，如转单 / 收货）：执行人与令牌所有者**都**必须持有 */
function assertMcpPerm(db, ctx, code, label) {
  const owner = ownerPermCtx(db, ctx)
  if (hasPerm(actorPermCtx(db, ctx), code) && (!owner || hasPerm(owner, code))) return
  throw new DocFlowError(`当前身份没有「${label}」的操作权限（需 ${code}）`, {
    code: 'PERM_DENIED',
    httpStatus: 403,
    detail: { permCode: code, entry: 'MCP' }
  })
}

/**
 * 单据流转的前置闸门（唯一入口）：**先过组织归属，再过边权限**。
 *
 * 顺序是刻意的：越权的单据一律按"不存在"处理（404），不泄露"它存在但不是你的"；
 * 权限不足才报 403。反过来的话，一个没有权限的人能靠错误码把"哪些 id 存在"扫出来。
 * 返回单据行，供调用方继续取状态。
 */
function gatePurchaseEdge(ctx, db, { docType, id, action }) {
  const row = assertPurchaseDocInScope(ctx, db, docType, id)
  const type = getDocType(db, docType)
  const statusField = type.status_field || 'status'
  // 边权限走 HTTP 入口**同一个** assertEdgePermitted（错误码 PERM_DENIED 也同一份）
  assertEdgePermitted({
    db, docType, fromState: row[statusField], action,
    permCtx: actorPermCtx(db, ctx), entry: 'MCP'
  })
  // 委托口径（ADR-0011）：确认人签字不能替所有者"补"权限 —— 所有者此刻也必须持有这条边的权限点
  const owner = ownerPermCtx(db, ctx)
  if (owner) {
    assertEdgePermitted({ db, docType, fromState: row[statusField], action, permCtx: owner, entry: 'MCP' })
  }
  return row
}

/** 闸门 + 执行：有归属服务的单据一律走 `dispatchTransition`（与正门同一段代码） */
function advancePurchaseDoc(ctx, db, { docType, id, action, remark = null, set = null, actor }) {
  gatePurchaseEdge(ctx, db, { docType, id, action })
  return dispatchTransition({ db, docType, id: Number(id), action, set, remark, actor, source: 'mcp' })
}

/**
 * 「这一步只能走带参数的业务入口」的闸门（PRQ.convert / PO.receive / PO.partial）。
 *
 * **实现不在这里**：判据定义在 `lib/purchase.js` 的 `assertNotParamOnly`
 * （与 HTTP 入口、通用流转入口共用的那一份），本文件只 import 它。
 * 原来这里自己写了一份 `PARAM_ONLY_ACTION` + `assertNotParamOnly`，注释还写着
 * "判据放在 MCP 这一层" —— 那正是缺陷本身：闸门挂在入口上，就只能保住那一个入口，
 * HTTP 侧 `POST /orders/:id/status {"action":"receive"}` 从无此闸门。
 * **删掉本地那份，是为了不让"新的对、旧的还在"继续存在。**
 */

// ---------------------------------------------------------------------------
// 通用单据工具的三个小依赖（放在这里而不是 import，是为了不让 tools.js → catalog.js
// 变成双向依赖：catalog.js 已经 import 了 TOOLS，这里再 import 回去就是环）
// ---------------------------------------------------------------------------

/** 表名白名单校验：`doc_types.table_name` 来自库，但它会被拼进 SQL */
const SAFE_TABLE_NAME = /^[a-z_][a-z0-9_]*$/
function safeTable(name) {
  const t = String(name || '')
  if (!SAFE_TABLE_NAME.test(t)) {
    const err = new Error(`单据表名不合法：${t}`)
    err.code = 'BAD_DOC_TYPE'
    err.status = 400
    throw err
  }
  return t
}

/** 取单据类型定义；不存在就报业务错，不要静默落到默认表 */
function docTypeOrThrow(db, code) {
  const c = String(code || '').trim()
  const t = c ? db.prepare("SELECT * FROM doc_types WHERE code=? AND status='active'").get(c) : null
  if (!t) {
    const err = new Error(`未知单据类型「${c}」。取值见 doc.list_types。`)
    err.code = 'BAD_DOC_TYPE'
    err.status = 400
    throw err
  }
  return t
}

/**
 * 归属列推断（**与 `catalog.js` 的 `ownershipColumns` 同一份口径**）。
 * 为什么不 import：见上面"双向依赖"的说明。两边都改的时候要一起改 ——
 * `scripts/check-mcp-coverage.mjs` 会断言两边推断出的列集合一致。
 */
function ownershipColumnsOf(db, table) {
  const cols = db.prepare(`PRAGMA table_info(${safeTable(table)})`).all().map((c) => c.name)
  const has = (c) => cols.includes(c)
  const out = { orgs: [], stores: [], dealers: [], warehouses: [] }
  if (has('org_id')) out.orgs.push('org_id')
  if (has('store_id')) out.stores.push('store_id')
  if (has('target_store_id')) out.stores.push('target_store_id')
  if (has('dealer_id')) out.dealers.push('dealer_id')
  if (has('warehouse_id')) out.warehouses.push('warehouse_id')
  if (has('from_warehouse_id')) out.warehouses.push('from_warehouse_id')
  if (has('to_warehouse_id')) out.warehouses.push('to_warehouse_id')
  if (has('material_warehouse_id')) out.warehouses.push('material_warehouse_id')
  return out
}

/**
 * 任意单据（doc_types 登记的类型）是否在本次调用的范围内；不受限时直接放行。
 * 越界、单据不存在、类型未知都按"不存在"处理（不泄露存在性；受限范围下 fail-closed）。
 */
function assertDocInScope(ctx, db, docType, docId, { code = 'NOT_FOUND', label = '单据' } = {}) {
  const e = scopeEntityIds(ctx, db)
  if (!e) return null
  const t = db.prepare("SELECT table_name FROM doc_types WHERE code=? AND status='active'").get(String(docType || ''))
  let row = null
  if (t) {
    const table = safeTable(t.table_name)
    row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(docId))
    if (row && entityRowVisible(e, row, ownershipColumnsOf(db, table))) return row
  }
  const err = new Error(`${label}不存在或不在本令牌的数据范围内`)
  err.code = code
  err.status = 404
  throw err
}

export const TOOLS = [
  // ============================================================
  // 一、主数据（read）
  // ============================================================
  {
    name: 'master.search_products',
    level: 'read',
    perms: ['master.product.view'],
    title: '搜索商品',
    description: '按关键词搜索商品（SPU）及其 SKU，返回价格与库存汇总。用于回答「某商品还有多少货」「某商品卖多少钱」类问题。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: S.str('商品名称/编码关键词，可空表示全部'),
        category_id: S.int('品类 ID'),
        limit: S.int('返回条数，默认 20，最大 100')
      }
    },
    handler({ db, args }) {
      const limit = Math.min(Number(args.limit) || 20, 100)
      const where = ['p.status=\'active\'']
      const params = []
      if (args.keyword) { where.push('(p.name LIKE ? OR p.spu_code LIKE ?)'); params.push(like(args.keyword), like(args.keyword)) }
      if (args.category_id) { where.push('p.category_id = ?'); params.push(args.category_id) }
      const rows = db
        .prepare(`
          SELECT p.id, p.spu_code, p.name, p.spec, p.unit, p.price_retail, p.price_dealer, p.cost_std,
                 p.item_type, p.procurement_type, c.name AS category_name, b.name AS brand_name,
                 (SELECT COUNT(*) FROM product_skus k WHERE k.product_id = p.id) AS sku_count
          FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
          LEFT JOIN brands b ON b.id = p.brand_id
          WHERE ${where.join(' AND ')}
          ORDER BY p.id LIMIT ?`).all(...params, limit)
      return ok({ count: rows.length, list: rows }, `命中 ${rows.length} 个商品`)
    }
  },
  {
    name: 'master.get_product_360',
    level: 'read',
    perms: ['master.product.view'],
    title: '商品全景',
    description: '给一个商品或 SKU，返回它的 SKU 明细、各仓库库存分布、近期出入库与采购/销售情况，用于回答「这个商品从采购到销售的全链路」。',
    inputSchema: {
      type: 'object',
      properties: { product_id: S.int('商品 ID'), sku_id: S.int('SKU ID'), keyword: S.str('或按名称关键词') }
    },
    handler({ db, args, ctx }) {
      let product = null
      if (args.product_id) product = db.prepare('SELECT * FROM products WHERE id=?').get(args.product_id)
      else if (args.sku_id) {
        const sku = db.prepare('SELECT * FROM product_skus WHERE id=?').get(args.sku_id)
        if (sku) product = db.prepare('SELECT * FROM products WHERE id=?').get(sku.product_id)
      } else if (args.keyword) {
        product = db.prepare('SELECT * FROM products WHERE name LIKE ? OR spu_code LIKE ? LIMIT 1').get(like(args.keyword), like(args.keyword))
      }
      if (!product) {
        const e = new Error('未找到该商品'); e.code = 'NOT_FOUND'; e.status = 404; throw e
      }
      const skus = db.prepare('SELECT * FROM product_skus WHERE product_id=?').all(product.id)
      const skuIds = skus.map((s) => s.id)
      const f = orgFilter(ctx, 's', 'owner_org_id')
      const stocks = skuIds.length
        ? db.prepare(`
            SELECT s.sku_id, s.warehouse_id, w.name AS warehouse_name, s.batch_no, s.owner_org_id,
                   o.name AS owner_name, s.currency, s.qty_on_hand, s.qty_reserved, s.cost_price, s.cost_amount,
                   COALESCE(s.expire_at, s.expire_date) AS expire_at
            FROM inventory_stocks s
            LEFT JOIN warehouses w ON w.id = s.warehouse_id
            LEFT JOIN orgs o ON o.id = s.owner_org_id
            WHERE s.sku_id IN (${skuIds.map(() => '?').join(',')}) ${f.sql}
            ORDER BY s.qty_on_hand DESC`).all(...skuIds, ...f.params)
        : []
      const recent = skuIds.length
        ? db.prepare(`
            SELECT s.biz_date, s.doc_type, s.doc_no, s.direction, s.qty, s.unit_cost, s.amount, s.warehouse_id, s.owner_org_id
            FROM inventory_transactions s WHERE s.sku_id IN (${skuIds.map(() => '?').join(',')}) ${f.sql}
            ORDER BY s.id DESC LIMIT 20`).all(...skuIds, ...f.params)
        : []
      return ok(
        { product, skus, stocks, recent_transactions: recent },
        `${product.name}：${skus.length} 个 SKU，${stocks.length} 条库存记录`
      )
    }
  },
  {
    name: 'master.list_partners',
    level: 'read',
    perms: ['master.partner.view'],
    title: '往来单位',
    description: '统一查询供应商 / 经销商 / 门店等往来单位档案（第三轮已定统一往来单位模型）。',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['supplier', 'dealer', 'store'], description: '单位类型' },
        keyword: S.str('名称关键词'),
        limit: S.int('返回条数，默认 30')
      }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 30, 200)
      const kw = args.keyword ? like(args.keyword) : null
      if (args.kind === 'store') {
        const f = orgFilter(ctx, 's')
        const rows = db.prepare(`SELECT id,code,name,type,region,city,org_id,owner_org_id FROM stores s WHERE 1=1 ${f.sql} ${kw ? 'AND (name LIKE ? OR code LIKE ?)' : ''} ORDER BY id LIMIT ?`)
          .all(...f.params, ...(kw ? [kw, kw] : []), limit)
        return ok({ kind: 'store', count: rows.length, list: rows }, `门店 ${rows.length} 家`)
      }
      if (args.kind === 'dealer') {
        const f = orgFilter(ctx, 'd')
        const rows = db.prepare(`SELECT id,code,name,level,region,credit_limit,credit_days,org_id FROM dealers d WHERE 1=1 ${f.sql} ${kw ? 'AND (name LIKE ? OR code LIKE ?)' : ''} ORDER BY id LIMIT ?`)
          .all(...f.params, ...(kw ? [kw, kw] : []), limit)
        return ok({ kind: 'dealer', count: rows.length, list: rows }, `经销商 ${rows.length} 家`)
      }
      const rows = db.prepare(`SELECT id,code,name,category,contact,phone,settle_type,credit_days FROM suppliers ${kw ? 'WHERE name LIKE ? OR code LIKE ?' : ''} ORDER BY id LIMIT ?`)
        .all(...(kw ? [kw, kw] : []), limit)
      return ok({ kind: 'supplier', count: rows.length, list: rows }, `供应商 ${rows.length} 家`)
    }
  },

  // ============================================================
  // 二、库存（read）
  // ============================================================
  {
    name: 'inventory.query_stock',
    level: 'read',
    perms: ['inventory.stock.view'],
    title: '查询库存',
    description: '按商品/仓库/批次/货主/币种查询五维现存量与成本。这是库存类问题的首选工具。',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: S.str('商品名称关键词'),
        sku_id: S.int('SKU ID'),
        warehouse_id: S.int('仓库 ID'),
        batch_no: S.str('批次号'),
        owner_org_id: S.int('货主组织 ID'),
        currency: S.str('币种，如 CNY / HKD'),
        only_available: S.bool('只看有可用量的'),
        limit: S.int('返回条数，默认 50，最大 500')
      }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 50, 500)
      const where = ['1=1']
      const params = []
      if (args.sku_id) { where.push('s.sku_id=?'); params.push(args.sku_id) }
      if (args.keyword) { where.push('(k.name LIKE ? OR k.sku_code LIKE ? OR p.name LIKE ?)'); params.push(like(args.keyword), like(args.keyword), like(args.keyword)) }
      if (args.warehouse_id) { where.push('s.warehouse_id=?'); params.push(args.warehouse_id) }
      if (args.batch_no) { where.push("IFNULL(s.batch_no,'')=?"); params.push(args.batch_no) }
      if (args.owner_org_id) { where.push('s.owner_org_id=?'); params.push(args.owner_org_id) }
      if (args.currency) { where.push('s.currency=?'); params.push(args.currency) }
      if (args.only_available) where.push('(s.qty_on_hand - s.qty_reserved) > 0')
      const f = orgFilter(ctx, 's', 'owner_org_id')
      const rows = db.prepare(`
        SELECT s.id, s.sku_id, k.sku_code, k.name AS sku_name, p.name AS product_name,
               s.warehouse_id, w.name AS warehouse_name, s.batch_no,
               s.owner_org_id, o.name AS owner_name, s.currency,
               s.qty_on_hand, s.qty_reserved, (s.qty_on_hand - s.qty_reserved) AS qty_available,
               s.cost_price, s.cost_amount, COALESCE(s.expire_at, s.expire_date) AS expire_at
        FROM inventory_stocks s
        LEFT JOIN product_skus k ON k.id = s.sku_id
        LEFT JOIN products p ON p.id = k.product_id
        LEFT JOIN warehouses w ON w.id = s.warehouse_id
        LEFT JOIN orgs o ON o.id = s.owner_org_id
        WHERE ${where.join(' AND ')} ${f.sql}
        ORDER BY s.qty_on_hand DESC LIMIT ?`).all(...params, ...f.params, limit)
      const totalQty = rows.reduce((a, r) => a + (r.qty_on_hand || 0), 0)
      return ok({ count: rows.length, total_qty: Number(totalQty.toFixed(2)), list: rows }, `命中 ${rows.length} 条库存，合计 ${totalQty.toFixed(2)}`)
    }
  },
  {
    name: 'inventory.list_batches',
    level: 'read',
    perms: ['inventory.batch.view'],
    title: '批次与效期',
    description: '查询批次主档与效期（支持小时级），回答「哪些批次临期」「这个批次还有多少」。',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id: S.int('SKU ID'),
        days: S.int('未来多少天内到期，默认 90'),
        include_expired: S.bool('是否包含已过保批次'),
        limit: S.int('返回条数，默认 50')
      }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 50, 500)
      const days = Number(args.days) || 90
      const now = new Date()
      const until = localNow(new Date(now.getTime() + days * 86400000))
      const f = orgFilter(ctx, 's', 'owner_org_id')
      const batchScope = f.sql ? `AND EXISTS (SELECT 1 FROM inventory_stocks s WHERE s.sku_id=b.sku_id AND s.batch_no=b.batch_no ${f.sql})` : ''
      const where = ["b.expire_at IS NOT NULL", "b.expire_at <> ''"]
      const params = []
      if (args.sku_id) { where.push('b.sku_id=?'); params.push(args.sku_id) }
      if (args.include_expired) { where.push('b.expire_at <= ?'); params.push(until) }
      else { where.push("b.expire_at > datetime('now','localtime')", 'b.expire_at <= ?'); params.push(until) }
      const rows = db.prepare(`
        SELECT b.batch_no, b.sku_id, k.name AS sku_name, b.produce_at, b.expire_at,
               b.status AS batch_status, b.qc_status,
               ROUND(julianday(b.expire_at) - julianday('now','localtime'), 1) AS days_left,
               (SELECT SUM(qty_on_hand) FROM inventory_stocks s WHERE s.sku_id=b.sku_id AND s.batch_no=b.batch_no ${f.sql}) AS qty_on_hand
        FROM inventory_batches b LEFT JOIN product_skus k ON k.id=b.sku_id
        WHERE ${where.join(' AND ')} ${batchScope} ORDER BY b.expire_at LIMIT ?`).all(...f.params, ...params, ...f.params, limit)
      return ok({ count: rows.length, within_days: days, list: rows }, `${days} 天内到期批次 ${rows.length} 个`)
    }
  },
  {
    name: 'inventory.get_cost',
    level: 'read',
    perms: ['inventory.cost.view'],
    title: '结存成本',
    description: '查询指定维度的结存数量与移动加权成本、结存金额（第三轮新增：成本改移动加权）。',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        warehouse_id: S.int('仓库 ID'),
        owner_org_id: S.int('货主组织 ID'),
        batch_no: S.str('批次号，默认空批次')
      },
      required: ['sku_id']
    },
    handler({ db, args, ctx }) {
      // 显式指定仓库/货主时必须落在本令牌范围内（A03：读路径同样不能靠传参越界）
      // 判定对象是「本次实际用的货主」= 显式传参 ?? 令牌组织；两者都没有才是仓库默认货主
      const ownerOrgId = args.owner_org_id ?? ctx.orgId ?? null
      if (args.warehouse_id != null) assertWarehouseInScope(ctx, db, args.warehouse_id, { ownerOrgId })
      else if (ownerOrgId != null) assertOrgInScope(ctx, ownerOrgId)
      const res = costOf(db, {
        warehouseId: args.warehouse_id ?? null,
        ownerOrgId,
        skuId: args.sku_id,
        batchNo: args.batch_no || '',
        currency: null
      })
      return ok(res, `结存 ${res.qty}，均价 ${res.unitCost}，金额 ${res.amount}`)
    }
  },
  {
    name: 'inventory.pick_suggestion',
    level: 'read',
    perms: ['inventory.stock.query'],
    title: '批次拣选建议',
    description: '按当前拣选规则（FEFO/FIFO）给出出货批次建议，并提示过保跳过情况。不写库，只做建议。',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        warehouse_id: { ...S.int('仓库 ID'), description: '仓库 ID（必填）' },
        qty: { ...S.num('需要数量'), description: '需要数量（必填）' },
        owner_org_id: S.int('货主组织 ID')
      },
      required: ['sku_id', 'warehouse_id', 'qty']
    },
    handler({ db, args, ctx }) {
      const ownerOrgId = args.owner_org_id ?? ctx.orgId ?? null
      assertWarehouseInScope(ctx, db, args.warehouse_id, { ownerOrgId })
      const r = pickBatches(db, args.warehouse_id, args.sku_id, Number(args.qty), { ownerOrgId })
      return ok(r, `拣选规则 ${r.rule}，命中 ${r.picks.length} 个批次${r.shortage ? `，缺口 ${r.shortage}` : ''}${r.warn ? `；${r.warn}` : ''}`)
    }
  },
  {
    name: 'inventory.list_transactions',
    level: 'read',
    perms: ['inventory.stock.query'],
    title: '出入库流水',
    description: '查询库房收发存流水（含货主、币种、成本维度）。',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id: S.int('SKU ID'),
        warehouse_id: S.int('仓库 ID'),
        doc_type: S.str('单据类型，如 PUR_IN / SAL_OUT / TR_OWN_OUT'),
        start_date: S.str('起始日期 YYYY-MM-DD'),
        end_date: S.str('截止日期 YYYY-MM-DD'),
        limit: S.int('返回条数，默认 50')
      }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 50, 500)
      const where = ['1=1']
      const params = []
      if (args.sku_id) { where.push('t.sku_id=?'); params.push(args.sku_id) }
      if (args.warehouse_id) { where.push('t.warehouse_id=?'); params.push(args.warehouse_id) }
      if (args.doc_type) { where.push('t.doc_type=?'); params.push(args.doc_type) }
      if (args.start_date) { where.push('t.biz_date >= ?'); params.push(args.start_date) }
      if (args.end_date) { where.push('t.biz_date <= ?'); params.push(args.end_date) }
      const f = orgFilter(ctx, 't', 'owner_org_id')
      const rows = db.prepare(`
        SELECT t.biz_date, t.biz_time, t.doc_type, t.doc_no, t.direction, t.qty, t.unit_cost, t.amount,
               t.balance_qty, t.currency, t.owner_org_id, o.name AS owner_name,
               t.warehouse_id, w.name AS warehouse_name, t.batch_no, t.operator, t.source
        FROM inventory_transactions t
        LEFT JOIN warehouses w ON w.id=t.warehouse_id
        LEFT JOIN orgs o ON o.id=t.owner_org_id
        WHERE ${where.join(' AND ')} ${f.sql}
        ORDER BY t.id DESC LIMIT ?`).all(...params, ...f.params, limit)
      return ok({ count: rows.length, list: rows }, `流水 ${rows.length} 条`)
    }
  },
  {
    name: 'inventory.stock_alert',
    level: 'read',
    perms: ['inventory.stock.view'],
    title: '库存预警',
    description: '返回低于安全库存、超储、以及临期（含过保）的库存清单。',
    inputSchema: {
      type: 'object',
      properties: { expiring_days: S.int('临期天数阈值，默认 90') }
    },
    handler({ db, args, ctx }) {
      const days = Number(args.expiring_days) || Number(getInvParam(db, 'expire_warn_days', 90))
      const f = orgFilter(ctx, 's', 'owner_org_id')
      // AA5：低库存与看板 / 预警页同一口径（lib/stock.js listBelowSafe，按仓库所属组织收口，ctx.scope 即令牌范围）；
      // 输出字段保持原来的五个键。口径差异见 ADR-0044（全局范围含无库存行的 SKU、只算 active、并列按 sku id；受限范围只列范围内有库存行的 SKU）。
      const below = listBelowSafe(db, 100, ctx.scope, { visibleOnly: true }).map(({ sku_id, sku_code, sku_name, safe_stock, qty_on_hand }) => ({ sku_id, sku_code, sku_name, safe_stock, qty_on_hand }))
      const expiring = db.prepare(`
        SELECT s.sku_id, k.name AS sku_name, s.batch_no, s.warehouse_id, w.name AS warehouse_name,
               COALESCE(s.expire_at, s.expire_date) AS expire_at, s.qty_on_hand
        FROM inventory_stocks s
        LEFT JOIN product_skus k ON k.id=s.sku_id
        LEFT JOIN warehouses w ON w.id=s.warehouse_id
        WHERE s.qty_on_hand > 0 AND COALESCE(s.expire_at, s.expire_date) IS NOT NULL
          AND COALESCE(s.expire_at, s.expire_date) <= datetime('now','localtime', ?) ${f.sql}
        ORDER BY expire_at LIMIT 100`).all(`+${days} days`, ...f.params)
      const expired = expiring.filter((x) => new Date(String(x.expire_at).replace(' ', 'T')) < new Date())
      return ok(
        { below_safe: below, expiring, expired_count: expired.length },
        `库存不足 ${below.length} 项，临期 ${expiring.length} 项（其中已过保 ${expired.length}）`
      )
    }
  },

  // ============================================================
  // 三、单据（read）
  // ============================================================
  {
    name: 'purchase.list_orders',
    level: 'read',
    perms: ['purchase.order.view', 'purchase.inbound', 'purchase.return'],
    title: '采购订单',
    description: '查询采购订单及在途情况。',
    inputSchema: {
      type: 'object',
      properties: { status: S.str('状态'), supplier_id: S.int('供应商 ID'), start_date: S.str('起始日期'), limit: S.int('返回条数，默认 30') }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 30, 200)
      const where = ['1=1']
      const params = []
      if (args.status) { where.push('po.status=?'); params.push(args.status) }
      if (args.supplier_id) { where.push('po.supplier_id=?'); params.push(args.supplier_id) }
      if (args.start_date) { where.push('po.order_date >= ?'); params.push(args.start_date) }
      // A03 增量：handler 必须接收 ctx 并施加组织过滤（原来不接收 ⇒ 令牌绑了组织也照样看全量）
      // 归属列直接取 `PURCHASE_DOC_SCOPE.PO` —— 与写闸门（`purchase.advance_order` 等）
      // 是**同一个对象**，不是"两处写了相同的一行"。
      const f = entityScopeClause(scopeEntityIds(ctx, db), PURCHASE_DOC_SCOPE.PO, { alias: 'po' })
      const rows = db.prepare(`
        SELECT po.*, s.name AS supplier_name,
               (SELECT COUNT(*) FROM purchase_order_items i WHERE i.order_id=po.id) AS item_count
        FROM purchase_orders po LEFT JOIN suppliers s ON s.id=po.supplier_id
        WHERE ${where.join(' AND ')} ${f.sql} ORDER BY po.id DESC LIMIT ?`).all(...params, ...f.params, limit)
      return ok({ count: rows.length, list: rows }, `采购订单 ${rows.length} 张`)
    }
  },
  {
    name: 'sales.list_orders',
    level: 'read',
    perms: ['sales.order.view'],
    title: '销售订单',
    description: '查询销售订单（含渠道、门店、经销商维度）。',
    inputSchema: {
      type: 'object',
      properties: { status: S.str('状态'), channel: S.str('渠道'), store_id: S.int('门店 ID'), start_date: S.str('起始日期'), limit: S.int('返回条数，默认 30') }
    },
    handler({ db, args, ctx }) {
      const limit = Math.min(Number(args.limit) || 30, 200)
      const where = ['1=1']
      const params = []
      if (args.status) { where.push('so.status=?'); params.push(args.status) }
      if (args.channel) { where.push('so.channel=?'); params.push(args.channel) }
      if (args.store_id) { where.push('so.store_id=?'); params.push(args.store_id) }
      if (args.start_date) { where.push('so.order_date >= ?'); params.push(args.start_date) }
      // ADR-0034：与 `GET /api/sales/orders` 同一个判据（salesScopeSql：出货仓 / 门店组织，任一在范围内可见；
      // 空范围 = 1=0）。此前这里用另一套「门店 / 经销商 / 仓」映射，两个入口看到的订单集合不一致。
      const f = salesScopeSql(ctx.scope, 'order', 'so')
      const rows = db.prepare(`
        SELECT so.*,
               (SELECT COUNT(*) FROM sales_order_items i WHERE i.order_id=so.id) AS item_count
        FROM sales_orders so WHERE ${where.join(' AND ')} AND ${f.sql} ORDER BY so.id DESC LIMIT ?`).all(...params, ...f.params, limit)
      return ok({ count: rows.length, list: rows }, `销售订单 ${rows.length} 张`)
    }
  },
  {
    name: 'order.trace_document',
    level: 'read',
    perms: ['sales.order.view', 'purchase.order.view', 'inventory.stock.view'],
    title: '单据全链路追溯',
    description: '给一个单据号，回溯它的上下游单据与库存流水，回答「这张单走到哪一步了」。',
    inputSchema: {
      type: 'object',
      properties: { doc_no: { ...S.str('单据号'), description: '单据号（必填）' } },
      required: ['doc_no']
    },
    handler({ db, args, ctx }) {
      const no = String(args.doc_no).trim()
      const e = scopeEntityIds(ctx, db)
      // 库存流水按货主过滤；单据按各自归属列过滤（拿不到归属列的表 = 受限令牌看不到）
      const txns = db
        .prepare('SELECT * FROM inventory_transactions WHERE doc_no=? ORDER BY id')
        .all(no)
        .filter((t) => !e || e.orgIds.includes(Number(t.owner_org_id)))
      const hits = []
      const owns = {
        purchase_orders: { stores: ['target_store_id'], warehouses: ['warehouse_id'] },
        sales_orders: { stores: ['store_id'], dealers: ['dealer_id'], warehouses: ['warehouse_id'] },
        stock_transfers: { warehouses: ['from_warehouse_id', 'to_warehouse_id'] },
        production_orders: { warehouses: ['warehouse_id'] },
        outsourcing_orders: { warehouses: ['warehouse_id', 'material_warehouse_id'] }
      }
      const probe = (t, label) => {
        try {
          const row = db.prepare(`SELECT * FROM ${t} WHERE doc_no=?`).get(no)
          // 越界单据**不报"无权查看"**，直接当作不存在 —— 报 403 等于确认"这张单存在但不是你的"
          if (row && entityRowVisible(e, row, owns[t] || {})) hits.push({ table: t, label, row })
        } catch { /* 表不存在则跳过 */ }
      }
      probe('purchase_orders', '采购订单')
      probe('sales_orders', '销售订单')
      probe('stock_transfers', '调拨单')
      probe('production_orders', '生产/组装单')
      probe('outsourcing_orders', '委外单')
      if (!txns.length && !hits.length) {
        const err = new Error(`未找到单据 ${no}`); err.code = 'NOT_FOUND'; err.status = 404; throw err
      }
      return ok({ doc_no: no, documents: hits, inventory_transactions: txns }, `找到 ${hits.length} 张单据、${txns.length} 条库存流水`)
    }
  },

  // ============================================================
  // 四、经营分析（read）
  // ============================================================
  {
    name: 'report.sales_summary',
    level: 'read',
    perms: ['sales.order.view'],
    title: '销售汇总',
    description: '按时间/渠道/门店汇总销售额、订单数、毛利（成本取移动加权）。',
    inputSchema: {
      type: 'object',
      properties: { start_date: S.str('起始日期'), end_date: S.str('截止日期'), group_by: { type: 'string', enum: ['channel', 'store', 'day'], description: '分组维度' } }
    },
    handler({ db, args, ctx }) {
      const start = args.start_date || today().slice(0, 8) + '01'
      const end = args.end_date || today()
      const groupBy = args.group_by === 'store' ? 'so.store_id' : args.group_by === 'day' ? 'so.order_date' : 'so.channel'
      // A03 增量：汇总也必须按令牌组织范围过滤（否则"明细看不到、总数看得到"）
      const f = entityScopeClause(
        scopeEntityIds(ctx, db),
        { stores: ['store_id'], dealers: ['dealer_id'], warehouses: ['warehouse_id'] },
        { alias: 'so' }
      )
      // A19：这里原来写 `SUM(so.total_amount)` —— **该列不存在**（只有 goods_amount / receivable_amount），
      // 干净库上必然抛 `no such column`。销售额按货值口径 = goods_amount，另给出应收口径。
      const rows = db.prepare(`
        SELECT ${groupBy} AS dimension, COUNT(*) AS order_count,
               ROUND(SUM(so.goods_amount),2) AS amount,
               ROUND(SUM(so.receivable_amount),2) AS receivable_amount
        FROM sales_orders so
        WHERE so.order_date BETWEEN ? AND ? AND so.status <> 'cancelled' ${f.sql}
        GROUP BY ${groupBy} ORDER BY amount DESC`).all(start, end, ...f.params)
      const total = rows.reduce((a, r) => a + (r.amount || 0), 0)
      const totalReceivable = rows.reduce((a, r) => a + (r.receivable_amount || 0), 0)
      return ok(
        { start_date: start, end_date: end, total_amount: Number(total.toFixed(2)), total_receivable: Number(totalReceivable.toFixed(2)), groups: rows },
        `${start}~${end} 合计 ${total.toFixed(2)}`
      )
    }
  },
  {
    name: 'report.dashboard_kpi',
    level: 'read',
    perms: [],
    title: '经营看板',
    description: '返回核心 KPI：库存总值、在途采购、待发货、库存预警数等。',
    inputSchema: { type: 'object', properties: { currency: S.str('币种，默认 CNY') } },
    handler({ db, args, ctx }) {
      const cur = args.currency || 'CNY'
      const f = orgFilter(ctx, 's', 'owner_org_id')
      const stockValue = db.prepare(`SELECT ROUND(SUM(cost_amount),2) v, COUNT(*) c FROM inventory_stocks s WHERE s.currency=? ${f.sql}`).get(cur, ...f.params)
      const skuCount = db.prepare('SELECT COUNT(*) c FROM product_skus').get().c
      const entities = scopeEntityIds(ctx, db)
      const salesScope = entityScopeClause(entities, { stores: ['store_id'], dealers: ['dealer_id'], warehouses: ['warehouse_id'] }, { alias: 'so' })
      const purchaseScope = entityScopeClause(entities, { warehouses: ['warehouse_id'], stores: ['target_store_id'] }, { alias: 'po' })
      const pendingShip = db.prepare(`SELECT COUNT(*) c FROM sales_orders so WHERE status IN ('confirmed','pending','approved') ${salesScope.sql}`).get(...salesScope.params).c
      const purchaseInTransit = db.prepare(`SELECT COUNT(*) c FROM purchase_orders po WHERE status IN ('approved','partial') ${purchaseScope.sql}`).get(...purchaseScope.params).c
      return ok({
        currency: cur,
        stock_value: stockValue.v || 0,
        stock_rows: stockValue.c,
        sku_count: skuCount,
        pending_shipment_orders: pendingShip,
        purchase_in_transit: purchaseInTransit
      }, `库存总值 ${stockValue.v || 0} ${cur}`)
    }
  },
  {
    name: 'org.tree',
    level: 'read',
    perms: [],
    title: '组织树',
    description: '返回组织主体树（总部→区域→门店→仓/央厨），含货主与币种。',
    inputSchema: { type: 'object', properties: { type: S.str('按类型过滤：group/region/store/warehouse/kitchen/dealer') } },
    handler({ db, args, ctx }) {
      let rows = db.prepare("SELECT id,code,name,type,parent_id,level,path,is_legal,owner_org_id,currency,region,brand_id FROM orgs WHERE id<>0 AND status='active' ORDER BY path").all()
      if (ctx.scope && ctx.scope.scope !== 'all' && ctx.scope.orgIds) {
        const allow = new Set(ctx.scope.orgIds)
        for (const o of rows) {
          if (!allow.has(o.id)) continue
          for (const seg of String(o.path || '').split('/').filter(Boolean)) allow.add(Number(seg))
        }
        rows = rows.filter((o) => allow.has(o.id))
      }
      if (args.type) rows = rows.filter((o) => o.type === args.type)
      return ok({ count: rows.length, list: rows }, `组织 ${rows.length} 个`)
    }
  },

  // ============================================================
  // 五、事务类（write，强制幂等键）
  // ============================================================
  {
    name: 'inventory.stock_in',
    level: 'write',
    perms: ['purchase.inbound'],
    title: '入库',
    description: '对指定仓库/SKU/批次执行入库，成本按移动加权重算。写操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { ...S.int('仓库 ID'), description: '仓库 ID（必填）' },
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        qty: { ...S.num('入库数量', { exclusiveMinimum: 0 }), description: '入库数量（必填，正数）' },
        unit_cost: { ...S.num('单位成本', { minimum: 0 }), description: '单位成本（必填）' },
        batch_no: S.str('批次号'),
        owner_org_id: S.int('货主组织 ID，缺省取仓库默认货主'),
        currency: S.str('币种，缺省取仓库本位币'),
        expire_at: S.str('到期时间，可精确到小时，如 2026-10-20 18:00:00'),
        remark: S.str('备注'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填，同一键重复调用只生效一次）' }
      },
      required: ['warehouse_id', 'sku_id', 'qty', 'unit_cost', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const { applyStockIn } = ctx.engine
      // A03：入库的货主与仓库都必须在令牌范围内 —— 这一条是本轮被独立复现的缺陷原形。
      // 一次判定同时管两件事：仓库所属组织 + **本次实际要用的货主**（显式 > 令牌 > 仓库默认）
      const ownerOrgId = args.owner_org_id ?? ctx.orgId ?? null
      const target = assertWarehouseInScope(ctx, db, args.warehouse_id, { ownerOrgId })
      const r = applyStockIn(db, {
        bizDate: today(),
        docType: 'ADJ_IN',
        docNo: `MCP${Date.now()}`,
        warehouseId: args.warehouse_id,
        ownerOrgId: target ?? null,
        currency: args.currency ?? null,
        skuId: args.sku_id,
        batchNo: args.batch_no || '',
        qty: Number(args.qty),
        unitCost: Number(args.unit_cost),
        expireAt: args.expire_at || null,
        remark: args.remark || 'MCP 入库',
        source: 'mcp',
        operator: `MCP:${ctx.tokenName}`
      })
      return ok(r, `入库 ${args.qty}，结存 ${r.balance}，新均价 ${r.unitCost}`)
    }
  },
  {
    name: 'inventory.stock_out',
    level: 'write',
    perms: ['sales.outbound'],
    title: '出库',
    description: '对指定仓库/SKU/批次执行出库，按移动加权均价结转成本。写操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { ...S.int('仓库 ID'), description: '仓库 ID（必填）' },
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        qty: { ...S.num('出库数量', { exclusiveMinimum: 0 }), description: '出库数量（必填，正数）' },
        batch_no: S.str('批次号，不传则按拣选规则自动挑批'),
        owner_org_id: S.int('货主组织 ID'),
        remark: S.str('备注'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['warehouse_id', 'sku_id', 'qty', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const { applyStockOut, pickBatches } = ctx.engine
      // 与 stock_in 同一份判定：仓库 + **本次实际要用的货主**（显式 > 令牌 > 仓库默认）
      const ownerArg = args.owner_org_id ?? ctx.orgId ?? null
      const owner = assertWarehouseInScope(ctx, db, args.warehouse_id, { ownerOrgId: ownerArg }) ?? null
      const docNo = `MCP${Date.now()}`
      let picks = [{ batchNo: args.batch_no || '', qty: Number(args.qty), unitCost: null }]
      if (!args.batch_no) {
        const p = pickBatches(db, args.warehouse_id, args.sku_id, Number(args.qty), { ownerOrgId: owner })
        if (p.shortage > 0) {
          const e = new Error(`库存不足，缺口 ${p.shortage}`); e.code = 'INSUFFICIENT_STOCK'; e.status = 400
          e.detail = { picks: p.picks, shortage: p.shortage }; throw e
        }
        picks = p.picks
      }
      const results = []
      for (const pk of picks) {
        results.push(applyStockOut(db, {
          bizDate: today(), docType: 'ADJ_OUT', docNo,
          warehouseId: args.warehouse_id, ownerOrgId: owner, skuId: args.sku_id,
          batchNo: pk.batchNo, qty: pk.qty, unitCost: pk.unitCost ?? undefined,
          remark: args.remark || 'MCP 出库', source: 'mcp', operator: `MCP:${ctx.tokenName}`
        }))
      }
      const totalCost = results.reduce((a, r) => a + r.unitCost * (r === results[0] ? picks[0].qty : 0), 0)
      return ok({ doc_no: docNo, picks: results }, `出库 ${args.qty}，涉及 ${results.length} 个批次`)
    }
  },
  {
    name: 'inventory.transfer',
    level: 'write',
    perms: ['inventory.transfer'],
    title: '调拨',
    description: '仓库间调拨。货主相同为内部调拨（成本平移）；货主不同必须改用 ownership_transfer。写操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        from_warehouse_id: { ...S.int('调出仓库'), description: '调出仓库 ID（必填）' },
        to_warehouse_id: { ...S.int('调入仓库'), description: '调入仓库 ID（必填）' },
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        qty: { ...S.num('数量', { exclusiveMinimum: 0 }), description: '调拨数量（必填）' },
        batch_no: S.str('批次号'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['from_warehouse_id', 'to_warehouse_id', 'sku_id', 'qty', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const { applyStockOut, applyStockIn, pickBatches } = ctx.engine
      // A03：调出/调入两仓都在范围内才允许调拨（两个仓 = 两个可能越界的入口）。
      // 内部调拨**不接受货主参数**，货主就是两仓各自的默认货主 ——
      // 所以这里用默认货主判定是正确的，不是 §27.2 那种"拿本次不用的货主去判"。
      const fromOwner = assertWarehouseInScope(ctx, db, args.from_warehouse_id, { label: '调出仓库' })
      const toOwner = assertWarehouseInScope(ctx, db, args.to_warehouse_id, { label: '调入仓库' })
      if (fromOwner !== toOwner) {
        const e = new Error('两仓货主不同，属于货权转移，请使用 inventory.ownership_transfer'); e.code = 'OWNER_MISMATCH'; e.status = 400; throw e
      }
      const docNo = `MCPTR${Date.now()}`
      const picks = args.batch_no
        ? [{ batchNo: args.batch_no, qty: Number(args.qty), unitCost: null }]
        : pickBatches(db, args.from_warehouse_id, args.sku_id, Number(args.qty), { ownerOrgId: fromOwner }).picks
      const out = []
      for (const pk of picks) {
        const o = applyStockOut(db, { bizDate: today(), docType: 'TR_OUT', docNo, warehouseId: args.from_warehouse_id, skuId: args.sku_id, batchNo: pk.batchNo, qty: pk.qty, unitCost: pk.unitCost ?? undefined, source: 'mcp', operator: `MCP:${ctx.tokenName}` })
        applyStockIn(db, { bizDate: today(), docType: 'TR_IN', docNo, warehouseId: args.to_warehouse_id, skuId: args.sku_id, batchNo: pk.batchNo, qty: pk.qty, unitCost: o.unitCost, source: 'mcp', operator: `MCP:${ctx.tokenName}` })
        out.push(o)
      }
      return ok({ doc_no: docNo, picks: out }, `调拨 ${args.qty} 完成`)
    }
  },
  {
    name: 'inventory.ownership_transfer',
    level: 'write',
    perms: ['inventory.transfer.ownership'],
    title: '货权转移',
    description: '跨货主的货权转移（如中央厨房 → 加盟店，加盟店是独立主体）。一步完成原货主出库与新货主入库。写操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        from_warehouse_id: { ...S.int('调出货主仓库'), description: '调出仓库 ID（必填）' },
        from_owner_org_id: { ...S.int('调出货主'), description: '调出货主组织 ID（必填）' },
        to_warehouse_id: { ...S.int('调入货主仓库'), description: '调入仓库 ID（必填）' },
        to_owner_org_id: { ...S.int('调入货主'), description: '调入货主组织 ID（必填）' },
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        qty: { ...S.num('数量', { exclusiveMinimum: 0 }), description: '数量（必填）' },
        batch_no: S.str('批次号'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['from_warehouse_id', 'from_owner_org_id', 'to_warehouse_id', 'to_owner_org_id', 'sku_id', 'qty', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const { applyOwnershipTransfer } = ctx.engine
      // A03：货权转移的**两个货主都是显式传参** —— 这是最容易越界的一个工具，两边都要校验。
      // 判定的货主就是**这次要用的那两个显式货主**，不是仓库默认货主（§27.2）。
      assertWarehouseInScope(ctx, db, args.from_warehouse_id, { ownerOrgId: args.from_owner_org_id, label: '调出仓库' })
      assertWarehouseInScope(ctx, db, args.to_warehouse_id, { ownerOrgId: args.to_owner_org_id, label: '调入仓库' })
      const r = applyOwnershipTransfer(db, {
        fromWarehouseId: args.from_warehouse_id, fromOwnerOrgId: args.from_owner_org_id,
        toWarehouseId: args.to_warehouse_id, toOwnerOrgId: args.to_owner_org_id,
        skuId: args.sku_id, batchNo: args.batch_no || '', qty: Number(args.qty),
        docNo: `MCPOW${Date.now()}`, bizDate: today(), operator: `MCP:${ctx.tokenName}`, source: 'mcp'
      })
      return ok(r, `货权转移 ${args.qty} 完成，单价 ${r.unitCost}`)
    }
  },

  // ============================================================
  // 六、高危类（danger，必须二次确认）
  // ============================================================
  {
    name: 'inventory.adjust',
    level: 'danger',
    perms: ['inventory.adjust'],
    title: '库存调整（盘盈亏）',
    description: '直接调整库存数量（盘盈/盘亏），会影响账面与成本。高危操作，需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        warehouse_id: { ...S.int('仓库 ID'), description: '仓库 ID（必填）' },
        sku_id: { ...S.int('SKU ID'), description: 'SKU ID（必填）' },
        batch_no: S.str('批次号'),
        delta: { ...S.num('调整数量，正为盘盈、负为盘亏'), description: '调整数量（必填，正=盘盈 / 负=盘亏）' },
        reason: { ...S.str('调整原因'), description: '调整原因（必填）' }
      },
      required: ['warehouse_id', 'sku_id', 'delta', 'reason']
    },
    handler({ db, args, ctx }) {
      const { applyStockIn, applyStockOut } = ctx.engine
      // A03：高危调整同样要过组织闸门（它没有 owner_org_id 参数，货主由仓库推导 —— 那就校验仓库）
      assertWarehouseInScope(ctx, db, args.warehouse_id)
      const delta = Number(args.delta)
      const docNo = `MCPADJ${Date.now()}`
      const base = { bizDate: today(), docNo, warehouseId: args.warehouse_id, skuId: args.sku_id, batchNo: args.batch_no || '', source: 'mcp', operator: `MCP:${ctx.tokenName}`, remark: args.reason }
      const r = delta >= 0
        ? applyStockGain(db, { ...base, docType: 'ADJ_IN', qty: delta })
        : applyStockOut(db, { ...base, docType: 'ADJ_OUT', qty: -delta })
      return ok({ doc_no: docNo, delta, result: r }, `库存调整 ${delta > 0 ? '+' : ''}${delta}，结存 ${r.balance}`)
    }
  },
  {
    name: 'pricing.update_price',
    level: 'danger',
    perms: ['master.price.edit'],
    title: '调价',
    description: '修改商品或 SKU 的零售价/经销价/会员价。高危操作（影响所有渠道报价），需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        sku_id: S.int('SKU ID（与 product_id 二选一）'),
        product_id: S.int('商品 ID'),
        price_retail: S.num('零售价'),
        price_dealer: S.num('经销价'),
        price_member: S.num('会员价'),
        reason: { ...S.str('调价原因'), description: '调价原因（必填）' }
      },
      required: ['reason']
    },
    handler({ db, args, ctx }) {
      if (!args.sku_id && !args.product_id) {
        const e = new Error('需提供 sku_id 或 product_id'); e.code = 'BAD_ARGS'; e.status = 400; throw e
      }
      const table = args.sku_id ? 'product_skus' : 'products'
      const id = args.sku_id || args.product_id
      const FIELDS = ['price_retail', 'price_dealer', 'price_member']
      const sets = []
      const params = []
      for (const k of FIELDS) {
        if (args[k] != null) {
          // D5：价格走**同一个校验器**（拒负价、拒 NaN/±Infinity、拒非十进制字面量、金额 2 位小数）
          sets.push(`${k}=?`)
          params.push(mustNum(numAmount(args[k], k, { min: 0 })))
        }
      }
      if (!sets.length) {
        const e = new Error('没有要修改的价格字段'); e.code = 'BAD_ARGS'; e.status = 400; throw e
      }
      const before = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      if (!before) { const e = new Error(`目标 #${id} 不存在`); e.code = 'NOT_FOUND'; e.status = 404; throw e }
      db.prepare(`UPDATE ${table} SET ${sets.join(',')} WHERE id=?`).run(...params, id)
      // D5：调价**必须留痕**。原来 MCP 改价不留痕 —— 界面的"价格变更历史"里看不到 Agent 改过价，
      // 而调价是 danger 级操作，事后追责时"谁改的、从多少改到多少"是唯一线索。
      const changed = []
      for (const k of FIELDS) {
        if (args[k] == null) continue
        const nv = Number(args[k])
        if (Number(before[k]) === nv) continue
        logPriceChange(db, {
          entity: table,
          entityId: id,
          field: k,
          oldValue: before[k],
          newValue: nv,
          reason: args.reason,
          operator: ctx?.confirmedBy?.name || `MCP:${ctx?.tokenName || ''}`,
          source: 'mcp'
        })
        changed.push(k)
      }
      const after = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      return ok({
        table, id, changed,
        before: { price_retail: before.price_retail, price_dealer: before.price_dealer, price_member: before.price_member },
        after: { price_retail: after.price_retail, price_dealer: after.price_dealer, price_member: after.price_member },
        reason: args.reason
      }, `已调整 ${changed.length} 个价格字段并留痕`)
    }
  },
  {
    name: 'sales.cancel_order',
    level: 'danger',
    perms: ['sales.order.edit'],
    title: '作废订单',
    description: '作废销售订单并释放已占用库存与授信。高危操作，需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { ...S.int('销售订单 ID'), description: '销售订单 ID（必填）' },
        reason: { ...S.str('作废原因'), description: '作废原因（必填）' }
      },
      required: ['order_id', 'reason']
    },
    handler({ db, args, ctx }) {
      // D5：改调**领域服务**（与 `POST /api/sales/orders/:id/cancel` 同一段代码）。
      // 原来这里只有一行 `UPDATE sales_orders SET status='cancelled'`：
      // 库存占用没释放（那批货永远卖不出去）、授信没还回去（额度只减不增），
      // 而单子看起来"已作废"，一切正常。
      // ADR-0034：范围判定在领域服务里（`orgScope` = 令牌 ∩ 所有者当前数据范围），与 `sales.list_orders` 同一判据；
      // 范围外与不存在同形（ORDER_NOT_FOUND 404，早于状态校验）。
      const actor = ctx?.confirmedBy?.id
        ? { id: ctx.confirmedBy.id, name: ctx.confirmedBy.name }
        : { id: null, name: `MCP:${ctx?.tokenName || ''}` }
      const out = cancelOrder(db, { id: args.order_id, reason: args.reason, actor, source: 'mcp', orgScope: ctx.scope || { scope: 'all', orgIds: null } })
      return ok(
        {
          order_id: out.order.id,
          order_no: out.order.doc_no,
          from: out.from_status,
          to: out.order.status,
          released_credit: out.released_credit,
          reason: args.reason
        },
        `订单 ${out.order.doc_no} 已作废（含释放库存占用与授信）`
      )
    }
  },
  {
    name: 'approval.approve',
    level: 'danger',
    perms: ['approval.instance.act'],
    title: '审批通过',
    description: '对审批实例执行通过动作。高危操作（等同于代表人签字），需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        instance_id: S.int('审批实例 ID'),
        doc_no: S.str('或按单据号定位'),
        comment: S.str('审批意见')
      }
    },
    handler({ db, args, ctx }) {
      // D5：改调**领域服务** `decideApproval`。
      // 原来这里是裸 `UPDATE approval_instances SET status='approved', finished_at=…` ——
      // 两个问题：① `finished_at` 这一列**根本不存在**（只有 `decided_at`），干净库上必然报错；
      // ② 更严重的是它绕开了状态机：不写 `approval_records` 审批记录、不判"这一级该不该你批"、
      //    不进级、**审批通过后也不执行对应的业务流转** —— 单据"批了"但什么都没发生。
      //
      // "Agent 凭什么代替人签字"这个设计问题，答案在这里：**它不是自己签，而是转呈人工确认人**。
      // actor 取 MCP 二次确认单上的 `confirmed_by_id`（真人），审批记录里因此留下的是那个人的名字。
      const actor = ctx?.confirmedBy?.id ? { id: ctx.confirmedBy.id, name: ctx.confirmedBy.name } : null
      if (!actor) {
        const e = new Error(
          '审批必须由人工确认后执行：MCP 的二次确认会把"点确认的那个人"作为签字人。' +
            '未经确认的执行没有签字人，不能代表任何人作出审批。'
        )
        e.code = 'APPROVAL_ACTOR_REQUIRED'
        e.status = 403
        throw e
      }
      const inst = args.instance_id
        ? db.prepare('SELECT * FROM approval_instances WHERE id=?').get(args.instance_id)
        : args.doc_no
          ? db.prepare('SELECT * FROM approval_instances WHERE doc_no=? ORDER BY id DESC LIMIT 1').get(args.doc_no)
          : null
      if (!inst) {
        const e = new Error('未找到审批实例（审批模块尚未上线时此工具不可用）')
        e.code = 'NOT_FOUND'
        e.status = 404
        throw e
      }
      // 审批实例挂在某张单据上：单据不在本次调用的数据范围内，就不能替它签字（W5 矩阵验收发现此前缺这一道）
      assertDocInScope(ctx, db, inst.doc_type, inst.doc_id, { code: 'APPROVAL_NOT_FOUND', label: `审批实例 #${inst.id} 对应的单据` })
      // ADR-0037：签字人不只是"在场的人"，还要对这张单据有组织范围——Agent 令牌范围之外再叠一层人的范围，
      // 否则 HTTP 侧按组织拒绝的审批可以绕到 MCP 由同一个人确认后签掉（Y12 审计发现）。
      const signerRow = db.prepare('SELECT id, role FROM users WHERE id=?').get(actor.id)
      const signerScope = signerRow ? resolveOrgScope(db, { uid: signerRow.id, role: signerRow.role }) : { scope: 'none', orgIds: [] }
      const out = decideApproval(db, {
        instanceId: inst.id,
        decision: 'approve',
        comment: args.comment || null,
        actor,
        scopeCtx: { orgScope: signerScope, user: { uid: actor.id, name: actor.name } }
      })
      return ok(
        {
          instance_id: inst.id,
          doc_no: inst.doc_no,
          status: out.instance?.status || null,
          step: out.step,
          done: out.done,
          next_step: out.nextStep ?? null,
          signed_by: actor.name || actor.id,
          applied: out.applied ? { from: out.applied.from ?? null, to: out.applied.to ?? null } : null,
          comment: args.comment || ''
        },
        out.done
          ?         `审批 #${inst.id} 已通过（由「${actor.name}」签字），业务动作已执行`
          : `审批 #${inst.id} 已过第 ${out.step} 级（由「${actor.name}」签字），待下一级`
      )
    }
  },

  // ============================================================
  // 七、采购域（批次 K：写型工具补齐 · **全部复用 `lib/purchase.js`**）
  // ============================================================
  // 为什么采购要单开一节：D5 那一轮把 `sales.cancel_order` / `approval.approve` /
  // `pricing.update_price` 改成"调领域服务"之后，**采购域的写型工具一个都没有** ——
  // 整条链（请购 → 订单 → 收货 → 发票 → 结算 → 付款）在 MCP 上完全不可用。
  // 这一批补齐，并立一条硬口径：
  //   **每个写型工具只做三件事** —— 校验入参、校验组织归属、把动作交给领域服务。
  //   一行业务 SQL 都不在 `mcp/tools.js` 里写。
  //
  // 执行人与权限（与 `approval.approve` 同一套答案）：
  //   · `write`  级（建草稿单） = 令牌所有者 → 过建单权限码（无主令牌 403）；
  //   · `danger` 级（推进/动货/动钱） = 人工确认人 → 过该条边的 `perm_code`（与 HTTP 同一份）。
  {
    name: 'purchase.create_requisition',
    level: 'write',
    perms: ['purchase.req.edit'],
    title: '创建请购单',
    description: '创建一张请购单（草稿）。未给价的行会走采购取价链（协议价 → 该供应商最近成交价 → 历史订单价 → 标准成本）并回报价格来源。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: S.int('建议供应商 ID（可空）'),
        warehouse_id: S.int('期望入库仓 ID（可空）'),
        org_id: S.int('货主组织 ID（可空，缺省取令牌绑定组织）'),
        req_date: S.str('请购日期 YYYY-MM-DD，缺省今天'),
        expect_date: S.str('期望到货日期 YYYY-MM-DD'),
        applicant_type: { type: 'string', enum: ['org', 'store', 'dealer'], description: '申请主体类型' },
        applicant_id: S.int('申请主体 ID'),
        department: S.str('申请部门'),
        purpose: S.str('请购用途'),
        urgency: { type: 'string', enum: ['normal', 'urgent', 'critical'], description: '紧急程度' },
        budget_amount: S.num('预算金额'),
        remark: S.str('备注'),
        lines: S.arr('明细行：[{ sku_id, qty, price?, need_date?, purpose? }]，至少一行'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填，同一键重复调用只生效一次）' }
      },
      required: ['lines', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      // 组织归属：本次真的会用到的两个**内部**主体（货主组织 / 期望入库仓）。
      // 供应商**不参与**归属判定 —— 见 PURCHASE_DOC_SCOPE 下面那段（外部主体不在总部子树里）
      assertPurchaseWriteScope(
        ctx, db,
        { orgs: [args.org_id ?? ctx.orgId ?? null], warehouses: [args.warehouse_id ?? null] },
        '请购单'
      )
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.req.edit', '提交请购单')
      const lines = (args.lines || []).map((l, i) => ({
        sku_id: Number(l?.sku_id),
        qty: mustNum(numQty(l?.qty, `第 ${i + 1} 行请购数量`)),
        price: l?.price != null ? mustNum(numAmount(l.price, `第 ${i + 1} 行单价`)) : undefined,
        need_date: l?.need_date || null,
        purpose: l?.purpose || null,
        remark: l?.remark || null
      }))
      // 未给价的行先走取价链，而不是留 0 —— 留 0 会让请购金额凭空少一块
      const priced = resolvePurchasePrices(db, {
        lines,
        supplierId: args.supplier_id ? Number(args.supplier_id) : null,
        at: args.req_date || null
      })
      const row = createRequisition(db, {
        orgId: args.org_id ?? ctx.orgId ?? null,
        warehouseId: args.warehouse_id ? Number(args.warehouse_id) : null,
        supplierId: args.supplier_id ? Number(args.supplier_id) : null,
        reqDate: args.req_date || undefined,
        expectDate: args.expect_date || null,
        applicantType: args.applicant_type || 'org',
        applicantId: args.applicant_id ? Number(args.applicant_id) : null,
        applicantName: actor.name,
        department: args.department || null,
        purpose: args.purpose || null,
        urgency: args.urgency || 'normal',
        budgetAmount: args.budget_amount != null ? Number(args.budget_amount) : null,
        remark: args.remark || null,
        source: 'mcp',
        actor,
        lines: priced
      })
      return ok(
        {
          id: row.id,
          doc_no: row.doc_no,
          status: row.status,
          total_amount: row.total_amount,
          line_count: row.items.length,
          price_trace: priced.map((p) => ({ sku_id: p.sku_id, price: p.price, source: p.price_source, label: p.price_source_label }))
        },
        `请购单 ${row.doc_no} 已创建（${row.items.length} 行 / 金额 ${row.total_amount}）`
      )
    }
  },
  {
    name: 'purchase.create_order',
    level: 'write',
    perms: ['purchase.order.edit'],
    title: '创建采购订单',
    description: '创建一张采购订单（草稿）。支持直运门店（fulfill_type=direct）。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { ...S.int('供应商 ID'), description: '供应商 ID（必填）' },
        warehouse_id: { ...S.int('入库仓 ID'), description: '入库仓 ID（必填）' },
        order_date: S.str('订单日期 YYYY-MM-DD，缺省今天'),
        expect_date: S.str('期望到货日期 YYYY-MM-DD'),
        fulfill_type: { type: 'string', enum: ['hq', 'direct'], description: '履约方式：hq 总部入库 / direct 直运门店仓' },
        target_store_id: S.int('直运门店 ID（direct 时用）'),
        target_warehouse_id: S.int('直运门店仓 ID（direct 时用）'),
        settle_type: S.str('结算方式'),
        remark: S.str('备注'),
        items: S.arr('明细行：[{ sku_id, qty, price, tax_rate?, remark? }]，至少一行'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['supplier_id', 'warehouse_id', 'items', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      assertPurchaseWriteScope(
        ctx, db,
        {
          warehouses: [args.warehouse_id ?? null, args.target_warehouse_id ?? null],
          stores: [args.target_store_id ?? null]
        },
        '采购订单'
      )
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.order.edit', '创建采购订单')
      // 行级校验、单号、落库、汇总重算都在领域服务里（与 `POST /api/purchase/orders` 同一段代码）
      const order = createPurchaseOrder(db, {
        supplierId: args.supplier_id,
        warehouseId: args.warehouse_id,
        orderDate: args.order_date || null,
        expectDate: args.expect_date || null,
        items: args.items,
        remark: args.remark || null,
        settleType: args.settle_type || null,
        fulfillType: args.fulfill_type || 'hq',
        targetStoreId: args.target_store_id || null,
        targetWarehouseId: args.target_warehouse_id || null,
        sourceType: 'mcp',
        actor
      })
      return ok(
        { id: order.id, doc_no: order.doc_no, status: order.status, total_qty: order.total_qty, total_amount: order.total_amount, line_count: order.items.length },
        `采购订单 ${order.doc_no} 已创建（${order.items.length} 行 / 金额 ${order.total_amount}）`
      )
    }
  },
  {
    name: 'purchase.create_invoice',
    level: 'write',
    perms: ['purchase.invoice.edit'],
    title: '录入采购发票',
    description: '录入一张采购发票（草稿，不涉及库存）。票号在同一供应商下不可重复。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { ...S.int('供应商 ID'), description: '供应商 ID（必填）' },
        org_id: S.int('货主组织 ID（可空，缺省取令牌绑定组织）'),
        invoice_no: S.str('发票号（可空；同一供应商下不可重复）'),
        invoice_type: { type: 'string', enum: ['vat_special', 'vat_general', 'fee', 'other'], description: '发票类型' },
        order_id: S.int('关联采购订单 ID（可空）'),
        receipt_id: S.int('关联收货单 ID（可空）'),
        invoice_date: S.str('开票日期 YYYY-MM-DD，缺省今天'),
        currency: S.str('币种，缺省 CNY'),
        tax_rate: S.num('默认税率（%），缺省 13'),
        remark: S.str('备注'),
        lines: S.arr('明细行：[{ sku_id?, qty, price, tax_rate?, order_item_id?, fee_type? }]'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['supplier_id', 'lines', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      // 这三张票据的归属就是它们自己的 `org_id`（建单时写入）—— 在归属判定用不了供应商
      const orgId = args.org_id ?? ctx.orgId ?? null
      assertPurchaseWriteScope(ctx, db, { orgs: [orgId] }, '采购发票')
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.invoice.edit', '录入采购发票')
      const lines = (args.lines || []).map((l, i) => ({
        sku_id: l?.sku_id ? Number(l.sku_id) : null,
        order_item_id: l?.order_item_id ? Number(l.order_item_id) : null,
        receipt_id: l?.receipt_id ? Number(l.receipt_id) : null,
        qty: mustNum(numQty(l?.qty, `第 ${i + 1} 行数量`)),
        price: mustNum(numAmount(l?.price, `第 ${i + 1} 行单价`)),
        tax_rate: l?.tax_rate != null ? Number(l.tax_rate) : undefined,
        fee_type: l?.fee_type || null,
        remark: l?.remark || null
      }))
      const row = createInvoice(db, {
        orgId,
        invoiceNo: args.invoice_no || null,
        invoiceType: args.invoice_type || 'vat_special',
        supplierId: Number(args.supplier_id),
        orderId: args.order_id ? Number(args.order_id) : null,
        receiptId: args.receipt_id ? Number(args.receipt_id) : null,
        invoiceDate: args.invoice_date || undefined,
        currency: args.currency || 'CNY',
        taxRate: args.tax_rate != null ? Number(args.tax_rate) : 13,
        remark: args.remark || null,
        actor,
        lines
      })
      return ok(
        { id: row.id, doc_no: row.doc_no, status: row.status, amount: row.amount, tax_amount: row.tax_amount, total_amount: row.total_amount },
        `采购发票 ${row.doc_no} 已录入（金额 ${row.total_amount}）`
      )
    }
  },
  {
    name: 'purchase.build_settlement',
    level: 'write',
    perms: ['purchase.settle.edit'],
    title: '生成采购结算单',
    description: '按供应商（可限定期间）汇总入库与发票，生成一张采购结算单（草稿）。差异 = 入库暂估 − 发票，不抹平。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { ...S.int('供应商 ID'), description: '供应商 ID（必填）' },
        org_id: S.int('货主组织 ID（可空，缺省取令牌绑定组织）'),
        settle_date: S.str('结算日期 YYYY-MM-DD，缺省今天'),
        period_start: S.str('期间起 YYYY-MM-DD'),
        period_end: S.str('期间止 YYYY-MM-DD'),
        settle_mode: { type: 'string', enum: ['auto', 'manual'], description: '结算方式' },
        remark: S.str('备注'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['supplier_id', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const orgId = args.org_id ?? ctx.orgId ?? null
      assertPurchaseWriteScope(ctx, db, { orgs: [orgId] }, '采购结算单')
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.settle.edit', '生成结算单')
      const row = buildSettlement(db, {
        orgId,
        supplierId: Number(args.supplier_id),
        settleDate: args.settle_date || undefined,
        periodStart: args.period_start || null,
        periodEnd: args.period_end || null,
        settleMode: args.settle_mode || 'auto',
        remark: args.remark || null,
        actor,
        // ADR-0031：来源选择按委托生效范围（令牌范围 ∩ 所有者当前范围），与 HTTP 同一谓词
        orgScope: ctx.scope
      })
      return ok(
        { id: row.id, doc_no: row.doc_no, status: row.status, settle_amount: row.settle_amount, diff_amount: row.diff_amount },
        `结算单 ${row.doc_no} 已生成（应结 ${row.settle_amount} / 差异 ${row.diff_amount}）`
      )
    }
  },
  {
    name: 'purchase.create_payment',
    level: 'write',
    perms: ['purchase.payment.edit'],
    title: '登记付款单',
    description: '登记一张付款单（草稿）。核销目标不传则按 FIFO 自动分配到未结清结算单；传给则逐条过四道闸（主体/状态/金额/未付余额）。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { ...S.int('供应商 ID'), description: '供应商 ID（必填）' },
        org_id: S.int('货主组织 ID（可空，缺省取令牌绑定组织）'),
        amount: { ...S.num('付款金额', { exclusiveMinimum: 0 }), description: '付款金额（必填，> 0）' },
        pay_date: S.str('付款日期 YYYY-MM-DD，缺省今天'),
        pay_type: { type: 'string', enum: ['transfer', 'cash', 'check', 'other'], description: '付款方式' },
        currency: S.str('币种，缺省 CNY'),
        bank_account: S.str('付款账户'),
        voucher_no: S.str('凭证号'),
        remark: S.str('备注'),
        allocations: S.arr('手工核销明细：[{ settle_id, amount }]；不传则 FIFO 自动核销'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['supplier_id', 'amount', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      const orgId = args.org_id ?? ctx.orgId ?? null
      assertPurchaseWriteScope(ctx, db, { orgs: [orgId] }, '付款单')
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.payment.edit', '登记付款单')
      const allocations = Array.isArray(args.allocations)
        ? args.allocations.map((a, i) => ({
            settle_id: Number(a?.settle_id),
            amount: mustNum(numAmount(a?.amount, `第 ${i + 1} 条核销金额`)),
            remark: a?.remark || null
          }))
        : null
      const row = createPayment(db, {
        orgId,
        supplierId: Number(args.supplier_id),
        payDate: args.pay_date || undefined,
        payType: args.pay_type || 'transfer',
        currency: args.currency || 'CNY',
        amount: mustNum(numAmount(args.amount, '付款金额')),
        bankAccount: args.bank_account || null,
        voucherNo: args.voucher_no || null,
        remark: args.remark || null,
        allocations,
        actor,
        // ADR-0031：FIFO 与手工核销都限在委托生效范围内（范围外结算单 ⇒ DOC_NOT_FOUND）
        orgScope: ctx.scope
      })
      return ok(
        { id: row.id, doc_no: row.doc_no, status: row.status, amount: row.amount, settled_amount: row.settled_amount, allocation_count: row.items.length },
        `付款单 ${row.doc_no} 已登记（金额 ${row.amount}，预分配核销 ${row.settled_amount}）`
      )
    }
  },
  {
    name: 'purchase.create_return',
    level: 'write',
    perms: ['purchase.return'],
    title: '登记采购退货',
    description: '对供应商登记一张采购退货单并**立即出库**（退货是真出库，所以不留在草稿）。事务类操作，必须提供幂等键。',
    inputSchema: {
      type: 'object',
      properties: {
        supplier_id: { ...S.int('供应商 ID'), description: '供应商 ID（必填）' },
        warehouse_id: { ...S.int('退货出库仓 ID'), description: '退货出库仓 ID（必填）' },
        return_date: S.str('退货日期 YYYY-MM-DD，缺省今天'),
        reason: S.str('退货原因'),
        items: S.arr('明细行：[{ sku_id, batch_no, qty, price }]，至少一行'),
        idempotency_key: { ...S.str('幂等键'), description: '幂等键（必填）' }
      },
      required: ['supplier_id', 'warehouse_id', 'items', 'idempotency_key']
    },
    handler({ db, args, ctx }) {
      assertPurchaseWriteScope(ctx, db, { warehouses: [args.warehouse_id ?? null] }, '采购退货单')
      const actor = mcpActor(db, ctx)
      assertMcpPerm(db, ctx, 'purchase.return', '登记采购退货')
      const items = (args.items || []).map((it, i) => ({
        sku_id: Number(it?.sku_id),
        batch_no: it?.batch_no || '',
        qty: mustNum(numQty(it?.qty, `第 ${i + 1} 行退货数量`)),
        price: it?.price != null ? mustNum(numAmount(it.price, `第 ${i + 1} 行单价`)) : 0
      }))
      const rid = createPurchaseReturn(db, {
        supplierId: Number(args.supplier_id),
        warehouseId: Number(args.warehouse_id),
        returnDate: args.return_date || null,
        reason: args.reason || null,
        items,
        actor,
        source: 'mcp'
      })
      const row = db.prepare('SELECT doc_no, status, total_qty, total_amount FROM purchase_returns WHERE id=?').get(rid)
      return ok(
        { id: rid, doc_no: row.doc_no, status: row.status, total_qty: row.total_qty, total_amount: row.total_amount },
        `采购退货单 ${row.doc_no} 已登记并出库（${row.total_qty} 件 / ${row.total_amount}）`
      )
    }
  },
  {
    name: 'purchase.advance_requisition',
    level: 'danger',
    perms: [],
    title: '请购单流转',
    description: '推进请购单状态：submit 提交 / approve 审批通过 / reject 驳回 / close 关闭 / cancel 取消。转单请用 purchase.convert_requisition（要指定行与供应商/仓）。高危操作，需人工二次确认；确认人必须有该动作的权限。',
    inputSchema: {
      type: 'object',
      properties: {
        requisition_id: { ...S.int('请购单 ID'), description: '请购单 ID（必填）' },
        action: { type: 'string', enum: ['submit', 'approve', 'reject', 'convert', 'close', 'cancel'], description: '动作（必填）。convert 请改用 purchase.convert_requisition' },
        remark: S.str('备注 / 驳回原因')
      },
      required: ['requisition_id', 'action']
    },
    handler({ db, args, ctx }) {
      const actor = mcpActor(db, ctx, { requireReal: true })
      assertNotParamOnly('PRQ', args.action)
      const out = advancePurchaseDoc(ctx, db, {
        docType: 'PRQ', id: args.requisition_id, action: args.action, remark: args.remark || null, actor
      })
      return ok(
        { id: Number(args.requisition_id), doc_no: out.doc_no, action: args.action, to: out.to_state, signed_by: actor.name },
        `请购单 ${out.doc_no} 已执行「${args.action}」（由「${actor.name}」确认）`
      )
    }
  },
  {
    name: 'purchase.convert_requisition',
    level: 'danger',
    perms: [],
    title: '请购单转采购订单',
    description: '把请购单转成采购订单（支持只转部分行）。不传 lines 则转全部未转行。高危操作，需人工二次确认；确认人需 purchase.order.edit 权限。',
    inputSchema: {
      type: 'object',
      properties: {
        requisition_id: { ...S.int('请购单 ID'), description: '请购单 ID（必填）' },
        supplier_id: S.int('覆盖供应商（缺省取请购单表头）'),
        warehouse_id: S.int('覆盖入库仓（缺省取请购单表头）'),
        lines: S.arr('只转这些行：[{ sku_id, qty }]；不传则转全部未转行'),
        remark: S.str('备注')
      },
      required: ['requisition_id']
    },
    handler({ db, args, ctx }) {
      const row = assertPurchaseDocInScope(ctx, db, 'PRQ', args.requisition_id)
      assertMcpPerm(db, ctx, 'purchase.order.edit', '转采购订单')
      const actor = mcpActor(db, ctx, { requireReal: true })
      const out = convertRequisitionToOrder(db, {
        reqId: Number(args.requisition_id),
        lines: Array.isArray(args.lines) && args.lines.length
          ? args.lines.map((l, i) => ({ sku_id: Number(l?.sku_id), qty: mustNum(numQty(l?.qty, `第 ${i + 1} 行转单数量`)) }))
          : null,
        supplierId: args.supplier_id ? Number(args.supplier_id) : null,
        warehouseId: args.warehouse_id ? Number(args.warehouse_id) : null,
        actor,
        remark: args.remark || null
      })
      return ok(
        { requisition_id: row.id, order_id: out.order_id, order_no: out.order_no, converted_lines: out.converted_lines, remaining_lines: out.remaining_lines, signed_by: actor.name },
        `请购单 ${row.doc_no} 已转采购订单 ${out.order_no}（${out.converted_lines} 行）`
      )
    }
  },
  {
    name: 'purchase.advance_order',
    level: 'danger',
    perms: [],
    title: '采购订单流转',
    description: '推进采购订单状态：submit 提交 / approve 审批 / close 关闭 / cancel 取消。**收货请用 purchase.receive_order**（收货要写库存与成本，简化入口做不了）。高危操作，需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { ...S.int('采购订单 ID'), description: '采购订单 ID（必填）' },
        action: { type: 'string', enum: ['submit', 'approve', 'receive', 'partial', 'close', 'cancel'], description: '动作（必填）。receive/partial 请改用 purchase.receive_order' },
        remark: S.str('备注 / 取消原因')
      },
      required: ['order_id', 'action']
    },
    handler({ db, args, ctx }) {
      const actor = mcpActor(db, ctx, { requireReal: true })
      assertNotParamOnly('PO', args.action)
      gatePurchaseEdge(ctx, db, { docType: 'PO', id: args.order_id, action: args.action })
      const out = transitionPurchaseOrder(db, {
        id: Number(args.order_id), action: args.action, remark: args.remark || null, actor, source: 'mcp'
      })
      return ok(
        { order_id: out.order.id, doc_no: out.order.doc_no, action: args.action, to: out.order.status, signed_by: actor.name },
        `采购订单 ${out.order.doc_no} 已执行「${args.action}」（由「${actor.name}」确认）`
      )
    }
  },
  {
    name: 'purchase.receive_order',
    level: 'danger',
    perms: [],
    title: '采购收货入库',
    description: '按采购订单收货：生成收货单 → 批次入库（写库存与成本流水）→ 推进订单状态。不传 items 则按订单未收数量全额收货。高危操作（动库存），需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        order_id: { ...S.int('采购订单 ID'), description: '采购订单 ID（必填）' },
        items: S.arr('收货明细：[{ id?, sku_id, qty, price?, batch_no?, produce_date?, expire_date? }]；不传则全额收货'),
        inspector: S.str('检验人'),
        receipt_date: S.str('收货日期 YYYY-MM-DD，缺省今天'),
        remark: S.str('备注')
      },
      required: ['order_id']
    },
    handler({ db, args, ctx }) {
      const row = assertPurchaseDocInScope(ctx, db, 'PO', args.order_id)
      assertMcpPerm(db, ctx, 'purchase.inbound', '采购收货')
      const actor = mcpActor(db, ctx, { requireReal: true })
      const items = (args.items || []).map((it, i) => ({
        id: it?.id ? Number(it.id) : undefined,
        sku_id: Number(it?.sku_id),
        qty: mustNum(numQty(it?.qty, `第 ${i + 1} 行收货数量`)),
        price: it?.price != null ? mustNum(numAmount(it.price, `第 ${i + 1} 行单价`)) : undefined,
        batch_no: it?.batch_no || undefined,
        produce_date: it?.produce_date || null,
        expire_date: it?.expire_date || null
      }))
      const out = receivePurchaseOrder(db, {
        orderId: Number(args.order_id),
        items,
        inspector: args.inspector || null,
        remark: args.remark || null,
        receiptDate: args.receipt_date || null,
        actor,
        source: 'mcp'
      })
      return ok(
        { order_id: row.id, order_no: out.order.doc_no, receipt_id: out.receipt_id, order_status: out.order.status, signed_by: actor.name },
        `采购订单 ${out.order.doc_no} 已收货（收货单 #${out.receipt_id}，订单状态 ${out.order.status}）`
      )
    }
  },
  {
    name: 'purchase.advance_invoice',
    level: 'danger',
    perms: [],
    title: '采购发票流转',
    description: '推进采购发票状态：submit 提交 / verify 发票校验（三单匹配，超开票会被拒）/ post 入账 / void 作废。高危操作，需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        invoice_id: { ...S.int('采购发票 ID'), description: '采购发票 ID（必填）' },
        action: { type: 'string', enum: ['submit', 'verify', 'post', 'void'], description: '动作（必填）' },
        remark: S.str('备注 / 作废原因')
      },
      required: ['invoice_id', 'action']
    },
    handler({ db, args, ctx }) {
      const actor = mcpActor(db, ctx, { requireReal: true })
      const out = advancePurchaseDoc(ctx, db, {
        docType: 'PI', id: args.invoice_id, action: args.action, remark: args.remark || null, actor
      })
      return ok(
        { id: Number(args.invoice_id), doc_no: out.doc_no, action: args.action, to: out.to_state, signed_by: actor.name },
        `采购发票 ${out.doc_no} 已执行「${args.action}」`
      )
    }
  },
  {
    name: 'purchase.advance_settlement',
    level: 'danger',
    perms: [],
    title: '采购结算流转',
    description: '推进采购结算单状态：submit 提交 / audit 审核 / settle 结清 / void 作废。高危操作，需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        settlement_id: { ...S.int('结算单 ID'), description: '结算单 ID（必填）' },
        action: { type: 'string', enum: ['submit', 'audit', 'settle', 'void'], description: '动作（必填）' },
        remark: S.str('备注 / 作废原因')
      },
      required: ['settlement_id', 'action']
    },
    handler({ db, args, ctx }) {
      const actor = mcpActor(db, ctx, { requireReal: true })
      const out = advancePurchaseDoc(ctx, db, {
        docType: 'PST', id: args.settlement_id, action: args.action, remark: args.remark || null, actor
      })
      return ok(
        { id: Number(args.settlement_id), doc_no: out.doc_no, action: args.action, to: out.to_state, signed_by: actor.name },
        `结算单 ${out.doc_no} 已执行「${args.action}」`
      )
    }
  },
  {
    name: 'purchase.advance_payment',
    level: 'danger',
    perms: [],
    title: '付款单流转（含核销）',
    description: '推进付款单状态：submit 提交审批 / pay 执行付款（**同时核销结算单**，重算已付金额，足额自动结清）/ void 作废。高危操作（动钱），需人工二次确认。',
    inputSchema: {
      type: 'object',
      properties: {
        payment_id: { ...S.int('付款单 ID'), description: '付款单 ID（必填）' },
        action: { type: 'string', enum: ['submit', 'pay', 'void'], description: '动作（必填）' },
        remark: S.str('备注 / 作废原因')
      },
      required: ['payment_id', 'action']
    },
    handler({ db, args, ctx }) {
      const actor = mcpActor(db, ctx, { requireReal: true })
      const out = advancePurchaseDoc(ctx, db, {
        docType: 'PAY', id: args.payment_id, action: args.action, remark: args.remark || null, actor
      })
      const after = db.prepare('SELECT settled_amount, status FROM purchase_payments WHERE id=?').get(Number(args.payment_id))
      return ok(
        {
          id: Number(args.payment_id), doc_no: out.doc_no, action: args.action, to: out.to_state,
          settled_amount: after?.settled_amount ?? null, signed_by: actor.name
        },
        `付款单 ${out.doc_no} 已执行「${args.action}」（核销 ${after?.settled_amount ?? 0}）`
      )
    }
  },

  // ============================================================
  // 九、通用单据工具 —— 让「任何单据都能被 AI 读、写、控制」成立
  // ============================================================
  //
  // 上面那些是**专用工具**（采购建单、库存出入库…），覆盖的是主链路；
  // 而内核里登记着 40 个单据类型、215 条流转边 —— 专用工具永远追不上。
  // 这 4 个工具**不认识具体业务**，只认识内核（`doc_types` / `doc_states` / `doc_actions`）：
  //   ⇒ 内核里新登记一张单据，AI 立刻就能读它、推进它，**不需要改这里一行代码**。
  //
  // 安全边界（与 `server/mcp/catalog.js` 的文件头同源，改一处必须改两处）：
  //   · 高危边（`is_danger=1`）**一律拒绝**：通用工具的调用方是 AI，
  //     而"高危"的定义就是"要人看一眼"，两者不能共存 ⇒ 报 `EDGE_REQUIRES_HUMAN`；
  //   · 每一次推进都过 `assertEdgePermitted`（与 HTTP 入口**同一份**判据）；
  //   · 读与写都受**实体范围**约束；表上取不到归属列时按"看不到"处理（fail-closed）；
  //   · 表名只从 `doc_types` 取，且再校验一次格式 —— 它会被拼进 SQL。
  {
    name: 'doc.list_types',
    level: 'read',
    perms: [], // X5：按单据类型的查看权限在 handler 内校验（doc-perms.js），不是整工具一个权限点
    title: '单据类型字典（AI 的入口地图）',
    description:
      '列出系统里全部单据类型：每种单据有哪些状态、在什么状态下能做哪些动作、哪些动作是高危（需人工确认）。'
      + 'AI 打算操作单据前应先调它，不要凭猜测拼 action。',
    inputSchema: { type: 'object', properties: {} },
    handler({ db, ctx }) {
      // X5：只返回所有者当前有查看权限的类型；未映射的类型（含无主令牌）也不列。有主令牌一个都看不了 ⇒ 明确拒绝。
      const owner = ctx?.ownerUserId != null ? permContext(db, { uid: ctx.ownerUserId }) : null
      const all = db
        .prepare(`SELECT code,name,module,table_name,has_lines FROM doc_types WHERE status='active' ORDER BY sort_order, code`)
        .all()
      const types = all.filter((t0) => canViewDocType(db, ctx, t0, owner))
      if (owner && !types.length) {
        const err = new Error('令牌所有者当前没有查看任何单据类型的权限；委托令牌不能超过所有者本人的权限')
        err.code = TOKEN_OWNER_PERM_DENIED
        err.status = 403
        throw err
      }
      const states = db.prepare('SELECT doc_type,code,name,kind,is_initial,is_final FROM doc_states ORDER BY doc_type,sort_order').all()
      const visible = new Set(types.map((x) => x.code))
      const actions = db
        .prepare('SELECT doc_type,action,action_name,from_state,to_state,is_danger FROM doc_actions ORDER BY doc_type,sort_order')
        .all()
        .filter((a) => visible.has(a.doc_type))
      const out = types.map((t2) => ({
        code: t2.code,
        name: t2.name,
        module: t2.module,
        has_lines: !!t2.has_lines,
        states: states.filter((s) => s.doc_type === t2.code).map((s) => ({ code: s.code, name: s.name, initial: !!s.is_initial, final: !!s.is_final })),
        // 只列**非高危**边：高危边通用工具执行不了，列出来只会诱导 AI 反复试错
        safe_actions: actions
          .filter((a) => a.doc_type === t2.code && !a.is_danger)
          .map((a) => ({ action: a.action, name: a.action_name, from: a.from_state, to: a.to_state })),
        danger_actions: actions
          .filter((a) => a.doc_type === t2.code && a.is_danger)
          .map((a) => ({ action: a.action, name: a.action_name, from: a.from_state, to: a.to_state }))
      }))
      return ok({ doc_types: out }, `共 ${out.length} 种单据；安全边 ${actions.filter((a) => !a.is_danger).length} 条，高危边 ${actions.filter((a) => a.is_danger).length} 条（高危边须人工确认）`)
    }
  },
  {
    name: 'doc.query',
    level: 'read',
    perms: [], // X5：同上，按 doc_type 校验
    title: '查任意单据列表',
    description:
      '按单据类型（`doc.list_types` 里的 code）查单据列表，可按状态与关键词过滤。'
      + '受令牌的实体范围约束：越界的单据**当作不存在**返回（不会告诉你"有但你看不到"）。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: S.str('单据类型码，例如 PO / SO / GR / PRT / ST…（必填，取值见 doc.list_types）'),
        status: S.str('状态码过滤，可省略'),
        keyword: S.str('单号关键词，可省略'),
        limit: { ...S.int('返回条数，默认 20，最多 100', { minimum: 1, maximum: 100 }) }
      },
      required: ['doc_type']
    },
    handler({ db, args, ctx }) {
      const type = docTypeOrThrow(db, args.doc_type)
      assertCanViewDocType(db, ctx, type) // X5：先过类型级查看权限，再谈范围
      const table = safeTable(type.table_name)
      const statusField = type.status_field || 'status'
      const docNoField = type.doc_no_field || 'doc_no'
      const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100)
      const where = []
      const params = []
      // Y6：绑定类型把「属于所有者门店 / 经销商 / 订货主体」下推进 SQL（不是取回后再滤，limit 才准）
      const bw = bindingWhere(db, ctx, type)
      if (bw) {
        where.push(bw.sql)
        params.push(...bw.params)
      }
      if (args.status) {
        where.push(`${statusField}=?`)
        params.push(String(args.status))
      }
      if (args.keyword) {
        where.push(`${docNoField} LIKE ?`)
        params.push(like(args.keyword))
      }
      const sql = `SELECT * FROM ${table}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`
      // 多取 3 倍再按范围过滤：受限令牌下"过滤后不够 limit 条"比"返回越界数据"好得多
      const raw = db.prepare(sql).all(...params, limit * 3)
      const e = scopeEntityIds(ctx, db)
      const owns = ownershipColumnsOf(db, table)
      const rows = raw.filter((r) => entityRowVisible(e, r, owns)).slice(0, limit)
      return ok(
        {
          doc_type: type.code,
          doc_type_name: type.name,
          total_scanned: raw.length,
          returned: rows.length,
          rows: rows.map((r) => ({
            id: r.id,
            doc_no: r[docNoField],
            status: r[statusField],
            date: r.created_at || null,
            amount: r.total_amount ?? r.amount ?? null
          }))
        },
        `${type.name}：命中 ${rows.length} 张（受限令牌已按实体范围过滤）`
      )
    }
  },
  {
    name: 'doc.get',
    level: 'read',
    perms: [], // X5：同上，按 doc_type 校验
    title: '查任意单据详情 + 流转留痕',
    description:
      '给单据类型与 id（或单号），返回单头字段与**完整流转留痕**（谁、什么时候、从哪个状态到哪个状态）。'
      + '回答"这张单走到哪一步了、为什么停在这里"。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: S.str('单据类型码（必填）'),
        id: S.int('单据 id（与 doc_no 二选一）'),
        doc_no: S.str('单据号（与 id 二选一）')
      },
      required: ['doc_type']
    },
    handler({ db, args, ctx }) {
      const type = docTypeOrThrow(db, args.doc_type)
      assertCanViewDocType(db, ctx, type) // X5：权限先于取行，避免用错误码探测单据是否存在
      const table = safeTable(type.table_name)
      const docNoField = type.doc_no_field || 'doc_no'
      let row = null
      if (args.id != null) row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(Number(args.id))
      else if (args.doc_no) row = db.prepare(`SELECT * FROM ${table} WHERE ${docNoField}=?`).get(String(args.doc_no))
      if (!row) {
        const err = new Error(`${type.name}不存在（doc_type=${type.code}）`)
        err.code = 'NOT_FOUND'
        err.status = 404
        throw err
      }
      // 越界不报"无权查看"：报 403 等于确认"这张单存在但不是你的"
      // ADR-0039：范围判据是 docflow 的 DOC_SCOPE_RESOLVERS（与 /api/docflow/history 同一份），不再按列名推断归属
      // （此前 dealer_id 推断会让持有某经销商范围的令牌读到仅归他组织仓 / 门店的单据及其留痕）；
      // 门店 / 经销商 / 订货主体绑定（Y6）仍叠加。留痕只在单据通过范围判定后才读。
      const scopeUser = ctx.ownerUserId != null ? db.prepare('SELECT id, store_id, dealer_id FROM users WHERE id=?').get(Number(ctx.ownerUserId)) : null
      const inScope = docInScope({ db, user: scopeUser, orgScope: ctx.scope || { scope: 'all', orgIds: null } }, type.code, row.id)
      if (!inScope || !rowInBinding(db, ctx, type, row)) {
        const err = new Error(`${type.name}不存在（doc_type=${type.code}）`)
        err.code = 'NOT_FOUND'
        err.status = 404
        throw err
      }
      let events = []
      try {
        events = db
          .prepare('SELECT action, from_state, to_state, actor_name, remark, created_at FROM doc_events WHERE doc_type=? AND doc_id=? ORDER BY id')
          .all(type.code, row.id)
      } catch {
        events = []
      }
      return ok(
        { doc_type: type.code, doc_type_name: type.name, document: row, events },
        `${type.name} ${row[docNoField] || row.id}，当前状态 ${row[type.status_field || 'status']}，留痕 ${events.length} 条`
      )
    }
  },
  {
    name: 'doc.transition',
    level: 'write',
    perms: [],
    title: '推进任意单据（高危边拒收）',
    description:
      '按内核状态机推进任意单据：先看 `doc.list_types` 里这个类型在该状态下的 safe_actions。'
      + '⚠️ 高危动作（作废已过账凭证、强平账等）**一律拒绝**，必须由人工在界面上确认后执行。',
    inputSchema: {
      type: 'object',
      properties: {
        doc_type: S.str('单据类型码（必填）'),
        id: S.int('单据 id（必填）'),
        action: S.str('动作码（必填，取值见 doc.list_types 的 safe_actions）'),
        remark: S.str('备注 / 作废原因')
      },
      required: ['doc_type', 'id', 'action']
    },
    handler({ db, args, ctx }) {
      const type = docTypeOrThrow(db, args.doc_type)
      const table = safeTable(type.table_name)
      const statusField = type.status_field || 'status'
      const id = Number(args.id)
      const row = db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id)
      if (!row) {
        const err = new Error(`${type.name}不存在`)
        err.code = 'NOT_FOUND'
        err.status = 404
        throw err
      }
      const e = scopeEntityIds(ctx, db)
      if (!entityRowVisible(e, row, ownershipColumnsOf(db, table))) {
        const err = new Error(`${type.name}不存在`)
        err.code = 'NOT_FOUND'
        err.status = 404
        throw err
      }
      // 这一条边在**当前状态**下是否合法 / 是否高危 —— 判据来自内核，不在这里写死
      const edge = db
        .prepare('SELECT * FROM doc_actions WHERE doc_type=? AND action=? AND from_state=?')
        .get(type.code, String(args.action), row[statusField])
      if (!edge) {
        const err = new Error(
          `${type.name}当前状态「${row[statusField]}」不允许动作「${args.action}」。可用动作请调 doc.list_types 查看。`
        )
        err.code = 'TRANSITION_NOT_ALLOWED'
        err.status = 409
        throw err
      }
      if (edge.is_danger) {
        // fail-closed：不是"没查到所以放过"，而是"查到了且高危所以拒绝"
        const err = new Error(
          `动作「${args.action}」是高危动作，AI 不能直接执行。请由具备确认权限的登录用户在界面上确认（MCP 高危工具走 confirm_token 流程）。`
        )
        err.code = 'EDGE_REQUIRES_HUMAN'
        err.status = 403
        throw err
      }
      const actor = mcpActor(db, ctx, { requireReal: true })
      // 边权限：与 HTTP 入口、MCP 专用工具**同一份**判据
      assertEdgePermitted({ db, docType: type.code, fromState: row[statusField], action: String(args.action), permCtx: actorPermCtx(db, ctx), entry: 'MCP' })
      const out = dispatchTransition({ db, docType: type.code, id, action: String(args.action), remark: args.remark || null, actor, source: 'mcp' })
      return ok(
        { doc_type: type.code, id, doc_no: out.doc_no, action: args.action, from: row[statusField], to: out.to_state, signed_by: actor.name },
        `${type.name} ${out.doc_no} ${row[statusField]} → ${out.to_state}`
      )
    }
  }
]

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]))

export function listTools({ levels = null, allow = null, deny = null } = {}) {
  const allowSet = allow && allow.length ? new Set(allow) : null
  const denySet = deny && deny.length ? new Set(deny) : null
  return TOOLS.filter((t) => {
    if (levels && !levels.includes(t.level)) return false
    if (allowSet && !allowSet.has(t.name)) return false
    if (denySet && denySet.has(t.name)) return false
    return true
  })
}

export function toolToMcp(t) {
  return { name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: { level: t.level } }
}
