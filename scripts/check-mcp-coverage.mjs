/**
 * ============================================================================
 * 文件标识：scripts/check-mcp-coverage.mjs ｜ 「任何单据都有 MCP」这句话的**静态守卫**
 * ============================================================================
 * 【为什么需要它】
 *   客户要的是「明确展示这个系统**任何单据**都有 MCP」。这句话要能成立、并且**长期**成立，
 *   就不能只靠一张页面 + 一次人工核对 —— 新增一个单据类型时，没有任何东西会提醒你
 *   "通用工具还能覆盖它吗""它有归属列吗"。
 *   本脚本把这两件事变成**断言**：
 *     ① 声明过的通用工具**必须真的注册**（名字、级别都对得上）—— 防止"说支持了、其实没实现"；
 *     ② 每一种在用单据都必须有**归属列**（org/store/dealer/warehouse）——
 *        没有归属列的表，受限令牌会被 fail-closed 判成"看不到"，
 *        而那种漏**不会报错**，只会在某天客户问"为什么 AI 说没有这张单"时才被发现。
 *
 * 【不查什么】
 *   · 不查业务正确性（那是 `test-mcp*.mjs` 与 `test-*.mjs` 的事）；
 *   · 不查页面渲染（前端由 `tsc` 与 `vite build` 兜）。
 *
 * 用法：GML_DATA_DIR=/absolute/dir node scripts/check-mcp-coverage.mjs [cosmetic|food|apparel]
 *   需要库：**必须**显式绝对 `GML_DATA_DIR`（ADR-0001 / ADR-0019），且不许是仓库 `data/`；
 *   库文件路径由 `server/db/index.js` 的 `dbPathFor()` 解析（**只读打开**，不写库）。
 *   退出码 2 = 数据目录 / 行业码不合法。
 * ============================================================================
 */
import Database from 'better-sqlite3'
import { requireExplicitDataDir, dbPathFor, assertIndustry } from '../server/db/index.js'

let INDUSTRY
let DB_PATH
try {
  requireExplicitDataDir()
  INDUSTRY = assertIndustry(process.argv[2]) || 'cosmetic'
  DB_PATH = dbPathFor(INDUSTRY)
} catch (e) {
  console.error(`${e.code || 'USAGE'}: ${e.message}`)
  process.exit(2)
}

let pass = 0
let fail = 0
const failed = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failed.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}${detail !== undefined ? `  → ${String(detail).slice(0, 400)}` : ''}`)
  }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

const { TOOLS } = await import('../server/mcp/tools.js')
const { GENERIC_DOC_TOOLS, ownershipColumns } = await import('../server/mcp/catalog.js')
const { DOC_VIEW_PERMS, viewPermsOf } = await import('../server/mcp/doc-perms.js')
const { DOC_SCOPE_RESOLVERS } = await import('../server/lib/docflow.js')

const db = new Database(DB_PATH, { readonly: true })

section(`MCP 覆盖守卫（${INDUSTRY}）`)
console.log(`  库文件：${DB_PATH}`)

// ---------------------------------------------------------------- ① 通用工具必须真实现
section('① 声明过的通用单据工具，必须真的注册')
const toolMap = new Map(TOOLS.map((t) => [t.name, t]))
for (const g of GENERIC_DOC_TOOLS) {
  const t = toolMap.get(g.name)
  ok(`通用工具已注册：${g.name}`, !!t, '声明了但 tools.js 里没有 —— "说支持了、其实没实现"')
  if (t) ok(`  级别与声明一致（${g.name} → ${t.level}）`, t.level === g.level, `声明 ${g.level}，实现 ${t.level}`)
}
ok('通用工具至少 4 个（list_types / query / get / transition）', GENERIC_DOC_TOOLS.length >= 4, `实得 ${GENERIC_DOC_TOOLS.length}`)
ok(
  '`doc.transition` 是写级别（不是只读）',
  toolMap.get('doc.transition')?.level === 'write',
  `实得 ${toolMap.get('doc.transition')?.level}`
)
// 高危边拒收是**代码里的分支**，没法静态求值；这里只守住"它确实写了这道判据"，
// 真正的行为验证在 `test-mcp*.mjs`（跑真实 JSON-RPC）。
const transitionSrc = String(toolMap.get('doc.transition')?.handler || '')
ok(
  '`doc.transition` 里有「高危边拒绝」的分支（EDGE_REQUIRES_HUMAN）',
  transitionSrc.includes('EDGE_REQUIRES_HUMAN') && transitionSrc.includes('is_danger'),
  '没找到高危拒收分支 —— 通用工具将成为绕过人工确认的后门'
)
ok(
  '`doc.transition` 走了边权限判据（assertEdgePermitted）',
  transitionSrc.includes('assertEdgePermitted'),
  '没走边权限 ⇒ 与 HTTP 入口两套规则'
)

// ---------------------------------------------------------------- ② 每种在用单据都要有归属列
section('② 每一种单据都必须有归属列（否则受限令牌静默看不到）')
const types = db.prepare("SELECT code,name,table_name FROM doc_types WHERE status='active' ORDER BY code").all()
const SAFE = /^[a-z_][a-z0-9_]*$/
const noOwner = []
const broken = []
const rows = []
for (const t of types) {
  if (!SAFE.test(t.table_name)) {
    broken.push(`${t.code}:${t.table_name}`)
    continue
  }
  let cols
  try {
    cols = ownershipColumns(db, t.table_name)
  } catch {
    broken.push(`${t.code}:${t.table_name}(表不存在)`)
    continue
  }
  const n = cols.orgs.length + cols.stores.length + cols.dealers.length + cols.warehouses.length
  let count = 0
  try {
    count = db.prepare(`SELECT COUNT(*) c FROM ${t.table_name}`).get().c
  } catch {
    count = -1
  }
  rows.push({ code: t.code, name: t.name, table: t.table_name, ownerCols: n, rows: count })
  if (n === 0) noOwner.push(`${t.code}(${t.name}) 在用 ${count} 行`)
}
ok('所有单据的表名合法（可安全拼进 SQL）', broken.length === 0, broken.join(' / '))
// 已知的"没有归属列"清单 —— **刻意钉死**，不是为了让它变绿，而是为了让"新增一个没有归属列的单据"
// 立刻红：那种漏不会报错，只会在某天客户问"AI 说没有这张收款单"时才被发现。
// 每一条都要有理由；理由写不出来，说明应该给它补归属列，而不是往这张表里加一行。
const KNOWN_NO_OWNER = {
  AR: '应收单的"归谁"记在 customer_type/customer_id（经销商 / 门店 / 散客），不是单一归属列',
  CA: '存货成本调整单按仓库+批次调整，没有组织/主体归属',
  OCS: '订货对账单的归属记在 dealer_id，但该列当前为空（对账单由订货单汇总而来）',
  OM: '商城订单的归属记在 platform_shop_id（平台店铺），没有组织/门店列',
  RCP: '收款单的"归谁"记在 customer_type/customer_id',
  RFD: '退款单的"归谁"记在 customer_type/customer_id',
  VOUCHER: '记账凭证按期间与科目组织，没有组织/门店归属'
}
const unexpected = noOwner
  .map((s) => String(s).split('(')[0])
  .filter((code) => !Object.prototype.hasOwnProperty.call(KNOWN_NO_OWNER, code))
ok(
  '没有归属列的单据**只**是已知那 7 个（新增的必须显式认领）',
  unexpected.length === 0,
  `新增了没有归属列的单据（受限令牌会静默看不到它）：${unexpected.join(' / ')}`
)
ok('扫描面自证：读到 ≥ 30 种单据（否则是路径/行业写错了）', types.length >= 30, `实得 ${types.length}`)

// ---------------------------------------------------------------- ②b 每种单据都要有查看权限点（X5）
section('②b 每一种单据都必须登记查看权限点（否则 doc.query / doc.get 默认拒绝）')
const typeCodes = types.map((t) => t.code)
const unmappedTypes = typeCodes.filter((c) => !viewPermsOf(c))
ok('所有在用单据类型都在 DOC_VIEW_PERMS 里有查看权限点', unmappedTypes.length === 0, `未映射（读工具将默认拒绝）：${unmappedTypes.join(' / ')}`)
const knownPerms = new Set(db.prepare('SELECT code FROM permissions').all().map((r) => r.code))
const badPerms = []
for (const [code, e] of Object.entries(DOC_VIEW_PERMS)) for (const p of e.perms) if (!knownPerms.has(p)) badPerms.push(`${code}:${p}`)
ok('映射里的权限点都是 permissions 表里真实存在的码', badPerms.length === 0, badPerms.join(' / '))
const staleMap = Object.keys(DOC_VIEW_PERMS).filter((c) => !typeCodes.includes(c))
ok('映射里没有已不存在的单据类型', staleMap.length === 0, staleMap.join(' / '))
ok('映射里没有空权限列表（空 = 无人可看）', Object.entries(DOC_VIEW_PERMS).every(([, e]) => e.perms.length > 0), '有类型映射到 []')
const genericSrc = ['doc.query', 'doc.get'].map((n) => String(toolMap.get(n)?.handler || ''))
ok('`doc.query` / `doc.get` 走了类型级查看权限闸门（assertCanViewDocType）', genericSrc.every((x) => x.includes('assertCanViewDocType')), '读工具没有按类型校验所有者权限')
ok('`doc.list_types` 按类型过滤（canViewDocType）', String(toolMap.get('doc.list_types')?.handler || '').includes('canViewDocType'), '字典会列出无权查看的类型')
ok('`doc.query` / `doc.get` 对绑定类型过滤到所有者的门店 / 经销商（bindingWhere / rowInBinding，Y6）',
  String(toolMap.get('doc.query')?.handler || '').includes('bindingWhere') && String(toolMap.get('doc.get')?.handler || '').includes('rowInBinding'),
  '绑定类型的读工具没有按所有者绑定收窄')
const badBind = []
for (const [code, e] of Object.entries(DOC_VIEW_PERMS)) {
  if (!e.binding) continue
  const t = types.find((x) => x.code === code)
  const cols = t ? db.prepare(`PRAGMA table_info(${t.table_name})`).all().map((c) => c.name) : []
  if (!['store', 'dealer', 'subject'].includes(e.binding) || !cols.includes(e.bindCol)) badBind.push(`${code}:${e.binding}/${e.bindCol}`)
}
ok('DOC_VIEW_PERMS 的绑定声明合法且归属列真实存在（Y6）', badBind.length === 0, badBind.join(' / '))
// AB7 / AC3：DOC_VIEW_PERMS 里**每个**绑定类型（store / dealer / subject）都必须在 DOC_SCOPE_RESOLVERS 声明同一个 binding，
// 反向亦然（无残留白名单）；DS / RB 这类总部专属、没有自视图的经销商往来类型在注册表声明 `binding: 'hq'`（任何门店 / 经销商绑定的账号整类不可见）。
const bindMissing = Object.entries(DOC_VIEW_PERMS).filter(([c, e]) => e.binding && DOC_SCOPE_RESOLVERS[c]?.binding !== e.binding).map(([c, e]) => `${c}(应为 ${e.binding}，实为 ${DOC_SCOPE_RESOLVERS[c]?.binding ?? '无'})`)
ok('DOC_VIEW_PERMS 的每个绑定类型在 DOC_SCOPE_RESOLVERS 都有同一个 binding 规则（AC3，无残留白名单）', bindMissing.length === 0, bindMissing.join(' / '))
const bindExtra = Object.entries(DOC_SCOPE_RESOLVERS)
  .filter(([c, sp]) => sp.binding && sp.binding !== 'hq' && DOC_VIEW_PERMS[c]?.binding !== sp.binding)
  .map(([c, sp]) => `${c}(注册表 ${sp.binding}，DOC_VIEW_PERMS ${DOC_VIEW_PERMS[c]?.binding ?? '无'})`)
ok('注册表里的 store / dealer / subject 绑定在 DOC_VIEW_PERMS 里同样声明（两处不漂移）', bindExtra.length === 0, bindExtra.join(' / '))
const hqBad = Object.entries(DOC_SCOPE_RESOLVERS)
  .filter(([c, sp]) => (sp.binding === 'hq') !== (sp.builder === 'dealer' && !DOC_VIEW_PERMS[c]?.binding))
  .map(([c]) => c)
ok('经销商往来类型要么按经销商绑定（DR）、要么声明 hq（DS / RB）；hq 只用于未绑定的经销商往来类型', hqBad.length === 0, hqBad.join(' / '))
const colDrift = Object.entries(DOC_VIEW_PERMS)
  .filter(([c, e]) => (e.binding === 'store' || e.binding === 'dealer') && DOC_SCOPE_RESOLVERS[c]?.cols?.[0] !== e.bindCol)
  .map(([c]) => c)
ok('store / dealer 绑定的归属列在两处一致（resolver cols[0] == bindCol）', colDrift.length === 0, colDrift.join(' / '))
ok('读工具的范围上下文启用 strictBinding（docScopeCtx，AB7）', /strictBinding:\s*true/.test((await import('node:fs')).readFileSync(new URL('../server/mcp/tools.js', import.meta.url), 'utf8')), 'docScopeCtx 没有 strictBinding')

// ---------------------------------------------------------------- ③ 覆盖结论
section('③ 覆盖结论（打印给人看，可复算）')
const states = db.prepare('SELECT COUNT(*) c FROM doc_states').get().c
const actions = db.prepare('SELECT COUNT(*) c FROM doc_actions').get().c
const danger = db.prepare('SELECT COUNT(*) c FROM doc_actions WHERE is_danger=1').get().c
const inUse = rows.filter((r) => r.rows > 0).length
console.log(`  单据类型 ${types.length}（在用 ${inUse}） / 状态 ${states} / 流转边 ${actions}（高危 ${danger}）`)
console.log(`  MCP 工具 ${TOOLS.length}（通用 ${GENERIC_DOC_TOOLS.length}）`)
console.log('  归属列覆盖（前 8 行）：')
for (const r of rows.slice(0, 8)) console.log(`    ${r.code.padEnd(6)} ${r.table.padEnd(24)} 归属列 ${r.ownerCols} / 在用 ${r.rows}`)
ok('每种单据都至少有一条流转边', rows.every((r) => db.prepare('SELECT COUNT(*) c FROM doc_actions WHERE doc_type=?').get(r.code).c > 0), '有单据没有任何边（状态机是死的）')

db.close()
console.log(`\n${'─'.repeat(64)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (failed.length) console.log('失败项：\n - ' + failed.join('\n - '))
process.exit(fail ? 1 : 0)
