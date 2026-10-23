/**
 * ============================================================================
 * 文件标识：scripts/lib/privacy-common.mjs ｜ 个人信息导出 / 抹除脚本共用底座：手机号校验、定位商城客户涉及的行、带钥伪名
 * ============================================================================
 * 【职责】`privacy-export.mjs` 与 `privacy-erase.mjs` 共用：参数解析、行业库定位、"这个手机号在库里涉及哪些行"的唯一查询。
 *
 * 【范围】本系统没有独立的"地址簿"表；商城（平台 code=H5）的收货信息存在订单上。所以"客户 / 订单 / 地址"= 
 *   mall_customers + member_accounts / member_points_ledger（只导出，不含个人字段）+ mall_cart_items（phone）
 *   + 平台 H5 的 oms_orders（buyer_nick / receiver / receiver_phone / receiver_address）+ 其关联的 sales_orders 收货三列
 *   + pos_orders.member_phone。金额、单号、状态、数量、时间一律不动（财务要用）。
 *
 * 【Y8】`collect` 另带“扩展集”（退款单 / 订货中心快照 / 日志行），`planErase` 把整个库的改动算成一份计划（报告、dry-run、真实执行共用），`applyPlan` 按计划写；
 *   `scanRawPhone` 全库找仍含原号码的文本列。关联规则与全库个人信息列结论见 ADR-0030 补充。
 *
 * 【改它要注意什么】新增含手机号 / 收货信息的商城表，必须同时加到这里的 `collect`，导出与抹除才会一起覆盖；
 *   伪名 = `erased:` + 带钥哈希（手机号再加 `-<客户id>`；密钥来自 GML_SECRET_KEY / JWT 密钥，见 secret-box.keyedPseudonym），换密钥后旧伪名不再可重算。
 * ============================================================================
 */
import fs from 'node:fs'
import Database from 'better-sqlite3'
import { INDUSTRIES, dbPathFor } from '../../server/db/index.js'
import { keyedPseudonym } from '../../server/lib/secret-box.js'

export const PHONE_RE = /^1\d{10}$/
export const ERASED_PREFIX = 'erased:'
export const OPEN_OMS = ['pending', 'shipped', 'refunding']
export const OPEN_SALES = ['draft', 'confirmed', 'picking', 'shipped']

export function fatal(code, message) {
  console.error(`${code}: ${message}`)
  process.exit(2)
}

export const pseudo = (kind, value) => `${ERASED_PREFIX}${keyedPseudonym(kind, value)}`
/** 手机号伪名 = `erased:<带钥哈希>`；mall_customers.phone 是 UNIQUE，老客户抹除后同号再注册还会再被抹除，
 *  所以按客户行 id 加后缀（`-<id>`，无客户行记 0）保证每个生命周期各有一个。哈希部分相同 ⇒ 仍可关联同一号码。 */
export const phoneHash = (phone) => keyedPseudonym('phone', phone)
export const phonePseudonym = (phone, customerId) => `${ERASED_PREFIX}${phoneHash(phone)}-${customerId ?? 0}`
export const erasedLike = (phone) => `${ERASED_PREFIX}${phoneHash(phone)}-%`

export function openIndustryDbs(codes, readonly) {
  const out = []
  for (const code of codes) {
    if (!Object.hasOwn(INDUSTRIES, code)) fatal('USAGE', `未知行业：${code}`)
    const file = dbPathFor(code)
    if (fs.existsSync(file)) out.push({ code, db: new Database(file, readonly ? { readonly: true } : {}) })
  }
  return out
}

const has = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)

/** 与 `server/lib/redact.js` 的 `maskPhone` 同一口径：前 3 + `****` + 后 4。 */
export const maskedPhone = (phone) => `${phone.slice(0, 3)}****${phone.slice(-4)}`
const MARKER_ACTION = 'PRIVACY_ERASE'
const inList = (n) => Array(n).fill('?').join(',')
const allRows = (db, table, where, args) => (has(db, table) ? db.prepare(`SELECT * FROM ${table} WHERE ${where} ORDER BY id`).all(...args) : [])

/** 主体名下已知的姓名集合（本人姓名、订单收货人、销售单收货人）。快照列只有等于其中之一才改（不误伤同一客户行上的企业名）。 */
export function subjectNames(c) {
  const out = new Set()
  const add = (v) => { if (v && typeof v === 'string' && !v.startsWith(ERASED_PREFIX) && !/^会员\s?\d/.test(v)) out.add(v.trim()) }
  add(c.customer?.name)
  c.orders.forEach((o) => add(o.receiver))
  c.sales_orders.forEach((o) => add(o.receiver))
  ;(c.oc_customers || []).forEach((o) => add(o.contact))
  ;(c.oc_addresses || []).forEach((o) => add(o.contact))
  return out
}

/**
 * 手机号在一个行业库里涉及的全部行。纯读。
 *
 * 核心集（客户 / 购物车 / H5 订单 / 销售单 / POS 单）决定"这个人是否存在"（isEmpty、重放判定只看它）；
 * 扩展集（Y8）是和核心集有**确定关联**的其它快照：退款单、订货中心客户 / 地址 / 订单 / 对账单、AR/收款/发票/授信的订货客户名、
 * 以及审计 / 通知日志里出现主体手机号的行。关联规则见 ADR-0030 补充，宁缺毋滥 —— 只有精确手机号、客户 id、订单 id 才算关联。
 */
export function collect(db, phone) {
  const pf = db.prepare("SELECT id FROM platforms WHERE code='H5'").get()
  const customer = db.prepare('SELECT * FROM mall_customers WHERE phone=?').get(phone) || null
  const orders = pf
    ? db.prepare('SELECT * FROM oms_orders WHERE platform_id=? AND (receiver_phone=? OR buyer_nick=?) ORDER BY id').all(pf.id, phone, `会员${phone}`)
    : []
  const items = orders.length
    ? db.prepare(`SELECT * FROM oms_order_items WHERE oms_order_id IN (${inList(orders.length)}) ORDER BY id`).all(...orders.map((o) => o.id))
    : []
  // 销售单有两条来路：H5 订单转出（oms_orders.sales_order_id），以及 POS 日结上传（pos2.js 把 member_phone 抄进 receiver_phone，
  // receiver 写成「会员 <手机号>」）。两条都要覆盖，否则抹除后销售单上还留着原号码。
  const salesIds = orders.map((o) => o.sales_order_id).filter((x) => x != null)
  const sales = db.prepare(`SELECT * FROM sales_orders WHERE receiver_phone=?${salesIds.length ? ` OR id IN (${inList(salesIds.length)})` : ''} ORDER BY id`).all(phone, ...salesIds)
  const core = {
    customer,
    member_account: customer && has(db, 'member_accounts') ? db.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customer.id) || null : null,
    points_ledger: customer && has(db, 'member_points_ledger') ? db.prepare('SELECT * FROM member_points_ledger WHERE customer_id=? ORDER BY id').all(customer.id) : [],
    cart_items: db.prepare('SELECT * FROM mall_cart_items WHERE phone=? ORDER BY id').all(phone),
    orders, order_items: items, sales_orders: sales,
    pos_orders: db.prepare('SELECT * FROM pos_orders WHERE member_phone=? ORDER BY id').all(phone)
  }
  return { ...core, ...collectExtended(db, phone, core) }
}

function collectExtended(db, phone, c) {
  const names = subjectNames(c)
  const cid = c.customer?.id ?? null
  const salesIds = c.sales_orders.map((o) => o.id)
  // ---- 退款单：member 类型且 customer_id 是主体；或退款明细指向的退货单属于主体的销售单 ----
  const refundIds = new Set()
  if (has(db, 'refunds')) {
    if (cid != null) db.prepare("SELECT id FROM refunds WHERE customer_type='member' AND customer_id=?").all(cid).forEach((r) => refundIds.add(r.id))
    if (salesIds.length && has(db, 'refund_items') && has(db, 'sales_returns')) {
      db.prepare(`SELECT DISTINCT ri.refund_id id FROM refund_items ri JOIN sales_returns sr ON sr.id=ri.return_id WHERE sr.order_id IN (${inList(salesIds.length)})`).all(...salesIds).forEach((r) => refundIds.add(r.id))
    }
  }
  const refunds = refundIds.size ? allRows(db, 'refunds', `id IN (${inList(refundIds.size)})`, [...refundIds]) : []
  // ---- 订货中心：电话精确等于主体手机号的客户 / 地址 ----
  // 只有电话本身是主体的客户行才算个人数据，其订单 / 对账单 / 往来快照才算关联；仅地址簿里有主体电话的客户（企业）只动那条地址，不连带它的单据
  const oc_customers = allRows(db, 'oc_customers', 'phone=?', [phone])
  const ocList = oc_customers.map((r) => r.id)
  // 地址簿：电话精确等于主体的行，加上命中客户名下的全部地址（备用电话 / 空电话的地址同样带着本人的姓名与地址）
  const oc_addresses = has(db, 'oc_addresses')
    ? db.prepare(`SELECT * FROM oc_addresses WHERE phone=?${ocList.length ? ` OR customer_id IN (${inList(ocList.length)})` : ''} ORDER BY id`).all(phone, ...ocList)
    : []
  const byCust = (table) => (ocList.length ? allRows(db, table, `customer_id IN (${inList(ocList.length)})`, ocList) : [])
  const bySubject = (table) => (ocList.length ? allRows(db, table, `subject_type='oc' AND subject_id IN (${inList(ocList.length)})`, ocList) : [])
  // ---- 台账类备注里的原号码 ----
  const balance_ledger = cid != null ? allRows(db, 'member_balance_ledger', 'customer_id=?', [cid]) : []
  // ---- 审计 / 通知日志 ----
  const masked = maskedPhone(phone)
  const hasText = (cols) => cols.map((col) => `instr(COALESCE(${col},''),?)>0`).join(' OR ')
  const tiePairs = [
    ['oms_orders', c.orders.map((o) => o.id)], ['sales_orders', salesIds], ['pos_orders', c.pos_orders.map((o) => o.id)],
    ['mall_customers', cid != null ? [cid] : []], ['member_accounts', cid != null ? [cid] : []], ['refunds', [...refundIds]]
  ].filter(([, ids]) => ids.length)
  const tieSql = tiePairs.map(([, ids]) => `(entity=? AND entity_id IN (${inList(ids.length)}))`).join(' OR ')
  const tieArgs = tiePairs.flatMap(([e, ids]) => [e, ...ids.map(String)])
  const audit_logs = []
  const audit_ambiguous = []
  if (has(db, 'audit_logs')) {
    const rows = db.prepare(`SELECT * FROM audit_logs WHERE action<>? AND (${hasText(['detail'])} OR ${hasText(['detail'])}) ORDER BY id`).all(MARKER_ACTION, phone, masked)
    const tiedIds = tieSql ? new Set(db.prepare(`SELECT id FROM audit_logs WHERE ${tieSql}`).all(...tieArgs).map((r) => r.id)) : new Set()
    for (const r of rows) (String(r.detail).includes(phone) || tiedIds.has(r.id) ? audit_logs : audit_ambiguous).push(r)
  }
  const nCols = ['title', 'payload', 'error']
  const notify_logs = []
  const notify_ambiguous = []
  if (has(db, 'notify_logs')) {
    const rows = db.prepare(`SELECT * FROM notify_logs WHERE ${hasText(nCols)} OR ${hasText(nCols)} ORDER BY id`).all(...nCols.map(() => phone), ...nCols.map(() => masked))
    for (const r of rows) (nCols.some((k) => (r[k] || '').includes(phone)) ? notify_logs : notify_ambiguous).push(r)
  }
  return {
    refunds, oc_customers, oc_addresses, oc_orders: byCust('oc_orders'), oc_statements: byCust('oc_statements'),
    ar_documents: bySubject('ar_documents'), receipts: bySubject('receipts'), sales_invoices: bySubject('sales_invoices'), credit_accounts: bySubject('credit_accounts'),
    member_balance_ledger: balance_ledger,
    audit_logs, notify_logs,
    ambiguous_masked: { audit_logs: audit_ambiguous, notify_logs: notify_ambiguous }
  }
}

export const isEmpty = (c) => !c.customer && !c.cart_items.length && !c.orders.length && !c.sales_orders.length && !c.pos_orders.length && !c.oc_customers.length && !c.oc_addresses.length

/** 已抹除判定：商城客户、订货中心客户 / 地址任何一处带有该号码的伪名即算 */
export function alreadyErased(db, phone) {
  const like = erasedLike(phone)
  return [['mall_customers', 'phone'], ['oc_customers', 'phone'], ['oc_addresses', 'phone']].some(([t, col]) => has(db, t) && db.prepare(`SELECT 1 FROM ${t} WHERE ${col} LIKE ?`).get(like))
}

/** 手机号精确出现在这些表里时只提示、不改：它们是供应商 / 经销商 / 门店 / 员工等主数据，与商城主体是否同一人需要业务确认。 */
const MANUAL_REVIEW = [['dealers', 'phone'], ['stores', 'phone'], ['suppliers', 'phone'], ['users', 'phone'], ['warehouses', 'phone'], ['im_user_map', 'mobile']]
export function manualReview(db, phone) {
  const out = {}
  for (const [t, col] of MANUAL_REVIEW) {
    if (!has(db, t)) continue
    const n = db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE ${col}=?`).get(phone).n
    if (n) out[`${t}.${col}`] = n
  }
  return out
}

/** 全库扫描：哪些文本列里还含有原手机号（精确 11 位）。抹除后用它给出"实际残留"，抹除前用它指出计划没覆盖到的列。 */
export function scanRawPhone(db, phone) {
  const out = {}
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
  for (const { name } of tables) {
    for (const col of db.prepare(`PRAGMA table_info("${name}")`).all()) {
      if (col.type && !/TEXT|CHAR|CLOB/i.test(col.type)) continue
      const n = db.prepare(`SELECT COUNT(*) n FROM "${name}" WHERE typeof("${col.name}")='text' AND instr("${col.name}",?)>0`).get(phone).n
      if (n) out[`${name}.${col.name}`] = n
    }
  }
  return out
}

/**
 * 抹除计划（纯计算，不写库）：返回要改的行与列、每表影响行数。`--report` / `--dry-run` / 真正执行共用它，
 * 所以报告里的数字与执行结果是同一份计算，不是另外估的。
 * 规则只改个人信息列；金额、单号、状态、数量、时间、行 id、客户 id 一律不动。
 */
/**
 * 文本里的号码替换。**只替换独立出现的号码**：前后不能紧挨字母 / 数字 / `_` / `-`（单号 `RC-13812345678`、`13812345678-A` 不动）。
 * 明细是 JSON 时按结构处理：只改字符串值，不改数字、不改键，键名像单号 / 账号 / 金额的字符串值也不动；改完再序列化（审计明细本就由 JSON.stringify 写入，往返稳定）。
 */
const DOCISH_KEY = /(doc|order|serial|ref|bank|account|voucher|invoice|(^|_)no$|number|code|amount|price|total)/i
export function replaceInText(text, tokens, pp) {
  if (typeof text !== 'string' || !text) return text
  const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`(?<![A-Za-z0-9_-])(?:${tokens.map(esc).join('|')})(?![A-Za-z0-9_-])`, 'g')
  if (!re.test(text)) return text
  re.lastIndex = 0
  const t = text.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      let changed = false
      const walk = (v, key) => {
        if (typeof v === 'string') {
          if (key && DOCISH_KEY.test(key)) return v
          const n = v.replace(re, pp)
          if (n !== v) changed = true
          return n
        }
        if (Array.isArray(v)) return v.map((x) => walk(x, key))
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]))
        return v
      }
      const out = walk(JSON.parse(t), null)
      return changed ? JSON.stringify(out) : text
    } catch { /* 不是合法 JSON：按文本处理 */ }
  }
  return text.replace(re, pp)
}

export function planErase(db, phone, c, { includeAmbiguous = false } = {}) {
  const pp = phonePseudonym(phone, c.customer?.id)
  const masked = maskedPhone(phone)
  const names = subjectNames(c)
  const ops = new Map() // `${table}#${id}` → { table, id, set }
  const columns = {} // table → Set(col)
  const cleared = {} // `${table}.${col}` → 原来含原号码、计划执行后不再含的行数（报告据此给出"执行后仍残留"的预测）
  const put = (table, row, col, next) => {
    if (next === undefined || next === row[col]) return
    if (typeof row[col] === 'string' && row[col].includes(phone) && typeof next === 'string' && !next.includes(phone)) cleared[`${table}.${col}`] = (cleared[`${table}.${col}`] || 0) + 1
    const key = `${table}#${row.id}`
    if (!ops.has(key)) ops.set(key, { table, id: row.id, set: {} })
    ops.get(key).set[col] = next
    ;(columns[table] ||= new Set()).add(col)
  }
  const isErased = (v) => typeof v === 'string' && v.startsWith(ERASED_PREFIX)
  const nameP = (v) => (v && !isErased(v) ? pseudo('name', v) : v)
  const addrP = (v) => (v && !isErased(v) ? pseudo('address', v) : v)
  const phoneOf = (v) => (!v || isErased(v) ? v : v === phone ? pp : pseudo('phone', v))
  const freeText = (v) => replaceInText(v, [phone], pp)
  const nameIfSubject = (v) => (names.has(String(v ?? '').trim()) ? nameP(v) : v)

  if (c.customer) {
    put('mall_customers', c.customer, 'phone', pp)
    put('mall_customers', c.customer, 'name', nameP(c.customer.name))
  }
  c.cart_items.forEach((r) => put('mall_cart_items', r, 'phone', pp))
  for (const o of c.orders) {
    put('oms_orders', o, 'buyer_nick', o.buyer_nick === `会员${phone}` ? `会员${pp}` : o.buyer_nick)
    put('oms_orders', o, 'receiver', nameP(o.receiver))
    put('oms_orders', o, 'receiver_phone', phoneOf(o.receiver_phone))
    put('oms_orders', o, 'receiver_address', addrP(o.receiver_address))
    put('oms_orders', o, 'remark', freeText(o.remark))
  }
  for (const so of c.sales_orders) {
    put('sales_orders', so, 'receiver', so.receiver === `会员 ${phone}` ? `会员 ${pp}` : nameP(so.receiver))
    put('sales_orders', so, 'receiver_phone', phoneOf(so.receiver_phone))
    put('sales_orders', so, 'receiver_address', addrP(so.receiver_address))
    put('sales_orders', so, 'remark', freeText(so.remark))
  }
  for (const p of c.pos_orders) {
    put('pos_orders', p, 'member_phone', pp)
    put('pos_orders', p, 'remark', freeText(p.remark))
  }
  c.points_ledger.forEach((r) => put('member_points_ledger', r, 'remark', freeText(r.remark)))
  c.member_balance_ledger.forEach((r) => put('member_balance_ledger', r, 'remark', freeText(r.remark)))
  // ---- Y8：退款单。member 类型 = 名字就是主体；其它类型只有名字等于主体名下姓名才改（经销商 / 门店名是企业名，不动）----
  for (const r of c.refunds) {
    put('refunds', r, 'customer_name', r.customer_type === 'member' ? nameP(r.customer_name) : nameIfSubject(r.customer_name))
    put('refunds', r, 'remark', freeText(r.remark))
    put('refunds', r, 'void_reason', freeText(r.void_reason))
  }
  // ---- Y8：订货中心。电话等于主体的客户 / 地址：电话、联系人、地址换伪名；名称只有等于主体姓名才换；快照列同一判据 ----
  for (const r of c.oc_customers) {
    if (r.phone === phone) put('oc_customers', r, 'phone', pp)
    put('oc_customers', r, 'contact', nameP(r.contact))
    put('oc_customers', r, 'address', addrP(r.address))
    put('oc_customers', r, 'name', nameIfSubject(r.name))
  }
  for (const r of c.oc_addresses) {
    put('oc_addresses', r, 'phone', phoneOf(r.phone))
    put('oc_addresses', r, 'contact', nameP(r.contact))
    put('oc_addresses', r, 'address', addrP(r.address))
    put('oc_addresses', r, 'name', nameIfSubject(r.name))
  }
  c.oc_orders.forEach((r) => put('oc_orders', r, 'customer_name', nameIfSubject(r.customer_name)))
  c.oc_statements.forEach((r) => put('oc_statements', r, 'customer_name', nameIfSubject(r.customer_name)))
  c.ar_documents.forEach((r) => put('ar_documents', r, 'subject_name', nameIfSubject(r.subject_name)))
  c.receipts.forEach((r) => put('receipts', r, 'subject_name', nameIfSubject(r.subject_name)))
  c.sales_invoices.forEach((r) => put('sales_invoices', r, 'subject_name', nameIfSubject(r.subject_name)))
  c.credit_accounts.forEach((r) => put('credit_accounts', r, 'name', nameIfSubject(r.name)))
  // ---- Y8：日志。raw 号码或与主体订单 / 客户 id 绑定的行 → 部分遮盖片段与原号码一起换伪名；
  //      仅凭"前 3 后 4"匹配的行不能证明是同一个人（约 10^4 个号码共享同一遮盖串），默认不动，--include-ambiguous-masked 才改 ----
  const sub = (v) => replaceInText(v, [phone, masked], pp)
  const logCols = { audit_logs: ['detail'], notify_logs: ['title', 'payload', 'error'] }
  for (const table of Object.keys(logCols)) {
    const rows = [...c[table], ...(includeAmbiguous ? c.ambiguous_masked[table] : [])]
    for (const r of rows) for (const col of logCols[table]) put(table, r, col, sub(r[col]))
  }
  const counts = {}
  const colsOut = {}
  for (const { table } of ops.values()) counts[table] = (counts[table] || 0) + 1
  for (const [t, set] of Object.entries(columns)) colsOut[t] = [...set].sort()
  return {
    ops: [...ops.values()], counts, columns: colsOut, cleared, pp,
    ambiguous_masked: { included: includeAmbiguous, audit_logs: c.ambiguous_masked.audit_logs.length, notify_logs: c.ambiguous_masked.notify_logs.length }
  }
}

/** 执行计划（调用方负责事务）。只写计划里列出的列，返回实际改动的行数（与 plan.counts 相等是测试的断言）。 */
export function applyPlan(db, plan) {
  const done = {}
  for (const op of plan.ops) {
    const cols = Object.keys(op.set)
    const r = db.prepare(`UPDATE ${op.table} SET ${cols.map((k) => `${k}=?`).join(',')} WHERE id=?`).run(...cols.map((k) => op.set[k]), op.id)
    done[op.table] = (done[op.table] || 0) + r.changes
  }
  return done
}
