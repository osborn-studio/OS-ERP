/**
 * ============================================================================
 * 文件标识：scripts/privacy-export.mjs ｜ 个人信息导出：把一个商城手机号的客户 / 订单 / 收货信息导成 JSON 文件（凭据类字段遮盖）
 * ============================================================================
 * 【职责】数据主体访问请求（ADR-0030）：按手机号汇总该人在各行业库里的商城数据，写到**显式指定**的文件。
 *
 * 【判据】
 *   · 用法：node scripts/privacy-export.mjs <手机号> --out <绝对路径.json> [--industry <行业>]
 *   · Y8：同时导出与主体有确定关联的退款单、订货中心客户 / 地址 / 订单 / 对账单与名称快照、台账、含原号码或与主体订单绑定的审计 / 通知日志行（与抹除共用 collect）。
 *   · 只读打开数据库；必须显式 GML_DATA_DIR 且不许是仓库 data/（ADR-0019）。
 *   · `--out` 必填、必须是绝对路径、不许落在仓库目录内、不许覆盖已有文件（`wx`），文件权限 0600；不往 stdout 打印个人数据。
 *   · 键名命中 redact.js 的 SENSITIVE_KEY（password/token/secret/key…）的值遮成 [REDACTED]，字符串里的 `token=…` 也剥掉。
 *     注意：**手机号 / 姓名 / 地址不遮盖** —— 这是给数据主体本人看的，遮了就不是访问请求的答复。
 *   · 退出码：0 已写出；1 手机号在任何行业库都没有数据；2 参数 / 环境错误。
 *
 * 【改它要注意什么】导出文件本身就是个人信息，交付与销毁由操作者负责（见操作手册）；本脚本不写审计行（只读，不改库）。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { INDUSTRIES, requireExplicitDataDir } from '../server/db/index.js'
import { SENSITIVE_KEY, MASK, redactText } from '../server/lib/redact.js'
import { PHONE_RE, fatal, openIndustryDbs, collect, isEmpty } from './lib/privacy-common.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
let out = null
let industry = null
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--out') out = args[++i]
  else if (a === '--industry') industry = args[++i]
  else if (a.startsWith('--')) fatal('USAGE', `未知参数：${a}（可用：--out、--industry）`)
  else positional.push(a)
}
const phone = positional[0]
if (positional.length !== 1 || !PHONE_RE.test(phone)) fatal('USAGE', '用法：privacy-export.mjs <11 位手机号> --out <绝对路径>')
if (!out || !path.isAbsolute(out)) fatal('USAGE', '--out 必填且必须是绝对路径')
const resolvedOut = path.resolve(out)
if (resolvedOut === ROOT || resolvedOut.startsWith(ROOT + path.sep)) fatal('USAGE', '--out 不许落在仓库目录内（导出文件含个人信息）')
if (industry && !Object.hasOwn(INDUSTRIES, industry)) fatal('USAGE', `未知行业：${industry}`)
try {
  requireExplicitDataDir()
} catch (e) {
  fatal(e.code || 'USAGE', e.message)
}

// 自由文本里的凭据：`token=x`（redactText）、JSON 片段 `"token":"x"`、`Authorization: Bearer x`、裸 `Bearer x`。
const KV_SECRET = /(["']?(?:[A-Za-z0-9_.-]*(?:password|passwd|pwd|secret|token|authorization|auth|credential|cookie|jwt|key)[A-Za-z0-9_.-]*)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|(?:Bearer\s+)?[^\s,;&}\]]+)/gi
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi
// redact.js 的 SENSITIVE_KEY 不含 passwd / pwd / credential / auth* 这类写法；导出口径再补一层（只会多遮，不会少遮）
const EXTRA_KEY = /passwd|pwd|credential|auth|bearer|private|signature|sign\b/i
const sensitiveKey = (k) => SENSITIVE_KEY.test(k) || EXTRA_KEY.test(k)
function scrubText(str) {
  const t = str.trim()
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try { return JSON.stringify(scrub(JSON.parse(t))) } catch { /* 不是合法 JSON：按文本处理 */ }
  }
  return redactText(str).replace(KV_SECRET, (_m, k) => `${k}${MASK}`).replace(BEARER, `Bearer ${MASK}`)
}
function scrub(v) {
  if (typeof v === 'string') return scrubText(v)
  if (Array.isArray(v)) return v.map(scrub)
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sensitiveKey(k) && x !== null && x !== '' ? MASK : scrub(x)]))
  }
  return v
}

/** Y8：与抹除同一份关联集合（collect 的扩展集），保证"导出了什么 = 抹除会动什么"。仅凭遮盖片段命中的日志行不能证明属于本人，只给行数。 */
const extended = (c) => ({
  refunds: c.refunds, oc_customers: c.oc_customers, oc_addresses: c.oc_addresses, oc_orders: c.oc_orders, oc_statements: c.oc_statements,
  ar_documents: c.ar_documents, receipts: c.receipts, sales_invoices: c.sales_invoices, credit_accounts: c.credit_accounts,
  member_balance_ledger: c.member_balance_ledger, audit_logs: c.audit_logs, notify_logs: c.notify_logs,
  ambiguous_masked_log_rows: { audit_logs: c.ambiguous_masked.audit_logs.length, notify_logs: c.ambiguous_masked.notify_logs.length }
})

const dbs = openIndustryDbs(industry ? [industry] : Object.keys(INDUSTRIES), true)
const result = { exported_at: new Date().toISOString(), subject_phone: phone, industries: {} }
for (const { code, db } of dbs) {
  try {
    const c = collect(db, phone)
    if (isEmpty(c)) continue
    const addresses = [...new Map(c.orders.filter((o) => o.receiver_address).map((o) => [`${o.receiver}|${o.receiver_phone}|${o.receiver_address}`, { receiver: o.receiver, receiver_phone: o.receiver_phone, receiver_address: o.receiver_address }])).values()]
    result.industries[code] = scrub({ customer: c.customer, member_account: c.member_account, points_ledger: c.points_ledger, cart_items: c.cart_items, orders: c.orders.map((o) => ({ ...o, items: c.order_items.filter((i) => i.oms_order_id === o.id) })), addresses, sales_orders: c.sales_orders, pos_orders: c.pos_orders, ...extended(c) })
  } finally {
    db.close()
  }
}
if (!Object.keys(result.industries).length) {
  console.error('NOT_FOUND: 该手机号在任何行业库中都没有商城数据')
  process.exit(1)
}
try {
  fs.writeFileSync(resolvedOut, JSON.stringify(result, null, 2), { flag: 'wx', mode: 0o600 })
} catch (e) {
  fatal(e.code || 'WRITE_FAILED', `无法写出 ${resolvedOut}：${e.message}`)
}
console.log(`已导出 ${Object.keys(result.industries).join(', ')} → ${resolvedOut}`)
