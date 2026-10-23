/**
 * ============================================================================
 * 文件标识：scripts/privacy-erase.mjs ｜ 个人信息抹除：把一个商城手机号的姓名 / 手机号 / 收货信息换成带钥哈希伪名，保留财务字段，写审计
 * ============================================================================
 * 【职责】数据主体删除请求（ADR-0030 + Y8 补充）：**脱敏而不是删行**——订单、金额、单号、积分流水、退款单都要给财务和对账留着。
 *
 * 【判据】
 *   · 用法：node scripts/privacy-erase.mjs <手机号> --confirm --actor <admin 用户名> [--industry <行业>] [--allow-open-orders] [--include-ambiguous-masked]
 *          node scripts/privacy-erase.mjs <手机号> --report [--industry <行业>]          只读：逐表打印"将改多少行、哪些列"，不需要 --confirm / --actor
 *          node scripts/privacy-erase.mjs <手机号> --dry-run --actor <admin 用户名>      只读：走与真实执行相同的校验（管理员、在途订单）并打印同一份计划
 *   · 没有 `--confirm`（也不是 --report / --dry-run）⇒ 退出码 2，什么都不做。`--actor` 必须是目标库里 status=active 的 admin（role=admin 或 is_super）。
 *   · 改动的列（仅这些，完整清单见 ADR-0030 补充）：mall_customers.phone/name；mall_cart_items.phone；H5 oms_orders.buyer_nick/receiver/receiver_phone/receiver_address；
 *     sales_orders.receiver/receiver_phone/receiver_address（H5 转出的 + POS 日结上传的两条来路）；pos_orders.member_phone；
 *     Y8 新增：refunds.customer_name（member 类型，或退款明细指向主体销售单且名字等于主体名下姓名）；oc_customers / oc_addresses 中电话等于主体的行（phone/contact/address，
 *     名称仅当等于主体姓名）及其 oc_orders / oc_statements / ar_documents / receipts / sales_invoices / credit_accounts 上的名称快照（同一判据）；
 *     已关联行 remark 里的原号码；audit_logs.detail / notify_logs.title,payload,error 里的原号码与"前 3 后 4"部分遮盖片段（见下）。伪名 = `erased:` + 带钥 HMAC。
 *   · 日志里的部分遮盖片段（如 138****5678）只凭前 3 后 4 并不能证明是同一个人（约 10^4 个号码共享一个遮盖串）：与主体订单 / 客户 id 绑定的审计行，或含原号码的行，才替换；
 *     其余仅命中遮盖串的行默认不动，`--report` 单列其行数，确认接受误伤后可加 `--include-ambiguous-masked`。金额、单号、动作、实体、行 id 从不动。
 *   · 行 id、customer_id、金额、数量、状态、单号、时间一律不动 ⇒ 外键与账务不受影响。
 *   · 有未完结订单（oms: pending/shipped/refunding；sales: draft/confirmed/picking/shipped）⇒ 拒绝（退出 1），除非 `--allow-open-orders`
 *     —— 抹掉收货信息会让在途订单无法履约。
 *   · 每个行业库一个 BEGIN IMMEDIATE 事务：事务内**重新取数、重新生成计划并复核管理员 / 在途订单**（预检之后新增或变化的订单不会漏）+ 改动 + 全库原号码残留扫描 + 一条 `PRIVACY_ERASE` 严格审计
 *     （只记行 id、各表行数、伪名前缀、残留列，**不含原手机号**）。审计写不进、或实际改动行数与计划不符 ⇒ 回滚。
 *   · 重放安全：已抹除的手机号再跑，原号码查不到而伪名（`erased:<哈希>-<客户id>`）存在 ⇒ 报 already-erased、退出 0、不写第二条审计；从没出现过的号码退出 1。
 *     跨库不是一个事务：某库失败后重跑，已完成的库自动跳过，失败的库继续。**Y8 之前抹除过的主体不会被追补**（识别用的手机号已被换掉）。
 *   · 生产模式必须有显式 GML_SECRET_KEY 或非公开 GML_JWT_SECRET，否则拒绝（公开密钥下的哈希可被穷举还原手机号）。
 *   · 退出码：0 完成（含 already-erased、report、dry-run）；1 无数据 / 有在途订单 / 事务失败；2 参数 / 环境 / 管理员校验错误。
 *
 * 【不做】备份文件里的旧数据；供应商 / 经销商 / 门店 / 员工等主数据里恰好相同的电话（只在报告 manual_review 里提示）；其它表的自由文本里的号码（执行后扫描并报告 residual_raw_phone，不改）。
 * ============================================================================
 */
import { INDUSTRIES, requireExplicitDataDir } from '../server/db/index.js'
import { auditStrictRow } from '../server/lib/audit-trail.js'
import { PHONE_RE, ERASED_PREFIX, OPEN_OMS, OPEN_SALES, fatal, phoneHash, alreadyErased, openIndustryDbs, collect, isEmpty, planErase, applyPlan, manualReview, scanRawPhone } from './lib/privacy-common.mjs'

const args = process.argv.slice(2)
let confirm = false
let reportOnly = false
let dryRun = false
let includeAmbiguous = false
let allowOpen = false
let actor = null
let industry = null
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--confirm') confirm = true
  else if (a === '--report') reportOnly = true
  else if (a === '--dry-run') dryRun = true
  else if (a === '--include-ambiguous-masked') includeAmbiguous = true
  else if (a === '--allow-open-orders') allowOpen = true
  else if (a === '--actor') actor = args[++i]
  else if (a === '--industry') industry = args[++i]
  else if (a.startsWith('--')) fatal('USAGE', `未知参数：${a}（可用：--confirm、--actor、--industry、--allow-open-orders、--report、--dry-run、--include-ambiguous-masked）`)
  else positional.push(a)
}
const phone = positional[0]
if (positional.length !== 1 || !PHONE_RE.test(phone)) fatal('USAGE', '用法：privacy-erase.mjs <11 位手机号> --confirm --actor <admin 用户名>')
const readOnly = reportOnly || dryRun
if (reportOnly && dryRun) fatal('USAGE', '--report 与 --dry-run 只能选一个')
if (!readOnly && !confirm) fatal('CONFIRM_REQUIRED', '抹除不可逆，必须显式加 --confirm（只想看影响面请用 --report）')
if (!reportOnly && !actor) fatal('USAGE', '--actor <admin 用户名> 必填（写入审计）')
if (industry && !Object.hasOwn(INDUSTRIES, industry)) fatal('USAGE', `未知行业：${industry}`)
try {
  requireExplicitDataDir()
} catch (e) {
  fatal(e.code || 'USAGE', e.message)
}

try {
  phoneHash(phone) // 提前验证密钥姿态（生产模式缺省 / 公开密钥直接拒绝）
} catch (e) {
  fatal(e.code || 'KEY_UNSAFE', e.message)
}

class Refusal extends Error {}

/** 读出这个库里该手机号当前的状态并生成计划。预检、--report 与事务内复核共用 —— 事务内再算一遍，防止预检之后有新订单 / 订单状态变化。
 *  `lenient`（--report）：不要求 actor、在途订单只列出不拒绝。 */
function evaluate(db, code, { lenient = false } = {}) {
  const c = collect(db, phone)
  if (isEmpty(c)) return { state: alreadyErased(db, phone) ? 'already-erased' : 'not-found' }
  const open = [
    ...c.orders.filter((o) => OPEN_OMS.includes(o.status)).map((o) => `oms_orders#${o.id}(${o.status})`),
    ...c.sales_orders.filter((o) => OPEN_SALES.includes(o.status)).map((o) => `sales_orders#${o.id}(${o.status})`)
  ]
  let admin = null
  if (!lenient || actor) {
    admin = db.prepare("SELECT id, username, name FROM users WHERE username=? AND status='active' AND (role='admin' OR is_super=1)").get(actor)
    if (!admin && !lenient) throw Object.assign(new Refusal(`--actor「${actor}」在行业库 ${code} 中不是启用的 admin`), { code: 'ACTOR_INVALID', exit: 2 })
  }
  if (open.length && !allowOpen && !lenient) {
    throw Object.assign(new Refusal(`${code} 有未完结订单 ${open.join(', ')}；抹除会让它们无法履约。完结后再抹除，或明确加 --allow-open-orders`), { code: 'OPEN_ORDERS', exit: 1 })
  }
  return { state: 'ready', c, admin, open, plan: planErase(db, phone, c, { includeAmbiguous }) }
}

function applyErase(db, code) {
  const ev = evaluate(db, code)
  if (ev.state !== 'ready') return ev
  const { c, admin, plan } = ev
  const n = applyPlan(db, plan)
  if (JSON.stringify(n, Object.keys(n).sort()) !== JSON.stringify(plan.counts, Object.keys(plan.counts).sort())) {
    throw new Error(`实际改动行数 ${JSON.stringify(n)} 与计划 ${JSON.stringify(plan.counts)} 不一致，已回滚`)
  }
  const residual = scanRawPhone(db, phone)
  auditStrictRow(db, {
    userId: admin.id, userName: admin.username, action: 'PRIVACY_ERASE', module: 'privacy', entity: 'mall_customer',
    entityId: c.customer?.id ?? null,
    detail: {
      subject: plan.pp.slice(0, ERASED_PREFIX.length + 8), counts: n, order_ids: c.orders.map((o) => o.id), sales_order_ids: c.sales_orders.map((o) => o.id),
      allow_open_orders: allowOpen, include_ambiguous_masked: includeAmbiguous,
      ambiguous_masked_untouched: includeAmbiguous ? { audit_logs: 0, notify_logs: 0 } : { audit_logs: plan.ambiguous_masked.audit_logs, notify_logs: plan.ambiguous_masked.notify_logs },
      residual_raw_phone: Object.entries(residual).map(([k, v]) => `${k}:${v}`)
    }
  })
  return { state: 'erased', counts: n, residual }
}

/** --report / --dry-run 的单库输出：每表行数与列、未覆盖的原号码出现位置、人工复核提示。不含任何个人数据。 */
function describe(db, ev) {
  if (ev.state !== 'ready') return ev.state
  // 预测执行后的残留 = 现在含原号码的行数 − 计划会清掉的行数（按行，不是按列：同一列里没被计划到的行照样算残留）
  const present = scanRawPhone(db, phone)
  const remaining = Object.fromEntries(Object.entries(present).map(([k, n]) => [k, n - (ev.plan.cleared[k] || 0)]).filter(([, n]) => n > 0))
  return {
    state: 'ready',
    tables: Object.fromEntries(Object.entries(ev.plan.counts).map(([t, rows]) => [t, { rows, columns: ev.plan.columns[t] }])),
    ambiguous_masked: ev.plan.ambiguous_masked,
    raw_phone_not_covered: remaining,
    manual_review: manualReview(db, phone),
    open_orders: ev.open,
    would_refuse: ev.open.length > 0 && !allowOpen ? 'OPEN_ORDERS' : null
  }
}

const dbs = openIndustryDbs(industry ? [industry] : Object.keys(INDUSTRIES), readOnly)
const report = {}
let exitCode = 0
const bump = (code) => { exitCode = Math.max(exitCode, code) }

try {
  if (readOnly) {
    for (const { code, db } of dbs) {
      try {
        report[code] = describe(db, evaluate(db, code, { lenient: reportOnly }))
        if (dryRun && report[code]?.would_refuse) throw Object.assign(new Refusal(`${code} 有未完结订单；真实执行会被拒绝`), { code: 'OPEN_ORDERS', exit: 1 })
      } catch (e) {
        if (!(e instanceof Refusal)) throw e
        console.error(`${code}: ${e.code} ${e.message}`)
        report[code] = 'refused'
        bump(e.exit)
      }
    }
    if (!exitCode && !Object.values(report).some((v) => typeof v === 'object' || v === 'already-erased')) {
      console.error('NOT_FOUND: 该手机号在任何行业库中都没有商城数据')
      exitCode = 1
    }
    console.log(JSON.stringify({ mode: reportOnly ? 'report' : 'dry-run', include_ambiguous_masked: includeAmbiguous, industries: report }, null, 2))
    dbs.forEach(({ db }) => db.close())
    process.exit(exitCode)
  }
  // ---- 预检（只读）：任何库不满足条件就在动手前停下；真正的校验在每个库的写事务里再做一遍 ----
  for (const { code, db } of dbs) evaluate(db, code)

  for (const { code, db } of dbs) {
    try {
      db.pragma('busy_timeout = 5000')
      const r = db.transaction(() => applyErase(db, code)).immediate()
      report[code] = r.state === 'erased' ? { erased: r.counts, residual_raw_phone: r.residual } : r.state
    } catch (e) {
      console.error(`${code}: ${e instanceof Refusal ? e.code : 'ERASE_FAILED'} ${e.message}`)
      report[code] = e instanceof Refusal ? 'refused' : 'failed'
      bump(e instanceof Refusal ? e.exit : 1)
    }
  }
  if (!exitCode && !Object.values(report).some((v) => v === 'already-erased' || typeof v === 'object')) {
    console.error('NOT_FOUND: 该手机号在任何行业库中都没有商城数据')
    exitCode = 1
  }
} catch (e) {
  if (!(e instanceof Refusal)) throw e
  console.error(`${e.code}: ${e.message}`)
  exitCode = e.exit
} finally {
  dbs.forEach(({ db }) => { if (db.open) db.close() })
}
console.log(JSON.stringify(report, null, 2))
process.exit(exitCode)
