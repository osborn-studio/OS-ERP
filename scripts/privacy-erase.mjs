/**
 * ============================================================================
 * 文件标识：scripts/privacy-erase.mjs ｜ 个人信息抹除：把一个商城手机号的姓名 / 手机号 / 收货信息换成带钥哈希伪名，保留财务字段，写审计
 * ============================================================================
 * 【职责】数据主体删除请求（ADR-0030）：**脱敏而不是删行**——订单、金额、单号、积分流水都要给财务和对账留着。
 *
 * 【判据】
 *   · 用法：node scripts/privacy-erase.mjs <手机号> --confirm --actor <admin 用户名> [--industry <行业>] [--allow-open-orders]
 *   · 没有 `--confirm` ⇒ 退出码 2，什么都不做。`--actor` 必须是目标库里 status=active 的 admin（role=admin 或 is_super）。
 *   · 改动的列（仅这些）：mall_customers.phone/name；mall_cart_items.phone；H5 oms_orders.buyer_nick/receiver/receiver_phone/receiver_address；
 *     关联 sales_orders.receiver/receiver_phone/receiver_address；pos_orders.member_phone。伪名 = `erased:` + 带钥 HMAC。
 *     行 id、customer_id、金额、数量、状态、单号、时间一律不动 ⇒ 外键与账务不受影响。
 *   · 有未完结订单（oms: pending/shipped/refunding；sales: draft/confirmed/picking/shipped）⇒ 拒绝（退出 1），除非 `--allow-open-orders`
 *     —— 抹掉收货信息会让在途订单无法履约。
 *   · 每个行业库一个事务：改动 + 一条 `PRIVACY_ERASE` 严格审计（只记行 id 与行数、伪名前缀，**不含原手机号**）。审计写不进 ⇒ 回滚。
 *   · 重放安全：已抹除的手机号再跑，原号码查不到而伪名存在 ⇒ 报 already-erased、退出 0、不写第二条审计；从没出现过的号码退出 1。
 *     跨库不是一个事务：某库失败后重跑，已完成的库自动跳过，失败的库继续。
 *   · 生产模式必须有显式 GML_SECRET_KEY 或非公开 GML_JWT_SECRET，否则拒绝（公开密钥下的哈希可被穷举还原手机号）。
 *   · 退出码：0 完成（含 already-erased）；1 无数据 / 有在途订单 / 事务失败；2 参数 / 环境 / 管理员校验错误。
 *
 * 【不做】审计表里已被 redact 部分遮盖的手机号（前 3 后 4）、备份文件里的旧数据、refunds.customer_name 等其它域的姓名快照——见 ADR-0030「边界」。
 * ============================================================================
 */
import { INDUSTRIES, requireExplicitDataDir } from '../server/db/index.js'
import { auditStrictRow } from '../server/lib/audit-trail.js'
import { PHONE_RE, ERASED_PREFIX, OPEN_OMS, OPEN_SALES, fatal, pseudo, openIndustryDbs, collect, isEmpty } from './lib/privacy-common.mjs'

const args = process.argv.slice(2)
let confirm = false
let allowOpen = false
let actor = null
let industry = null
const positional = []
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--confirm') confirm = true
  else if (a === '--allow-open-orders') allowOpen = true
  else if (a === '--actor') actor = args[++i]
  else if (a === '--industry') industry = args[++i]
  else if (a.startsWith('--')) fatal('USAGE', `未知参数：${a}（可用：--confirm、--actor、--industry、--allow-open-orders）`)
  else positional.push(a)
}
const phone = positional[0]
if (positional.length !== 1 || !PHONE_RE.test(phone)) fatal('USAGE', '用法：privacy-erase.mjs <11 位手机号> --confirm --actor <admin 用户名>')
if (!confirm) fatal('CONFIRM_REQUIRED', '抹除不可逆，必须显式加 --confirm')
if (!actor) fatal('USAGE', '--actor <admin 用户名> 必填（写入审计）')
if (industry && !Object.hasOwn(INDUSTRIES, industry)) fatal('USAGE', `未知行业：${industry}`)
try {
  requireExplicitDataDir()
} catch (e) {
  fatal(e.code || 'USAGE', e.message)
}

let phonePseudo
try {
  phonePseudo = pseudo('phone', phone)
} catch (e) {
  fatal(e.code || 'KEY_UNSAFE', e.message)
}

const dbs = openIndustryDbs(industry ? [industry] : Object.keys(INDUSTRIES), false)
const closeAll = () => dbs.forEach(({ db }) => db.close())
const report = {}
let exitCode = 0

try {
  // ---- 预检：管理员身份、在途订单 —— 全部库通过后才开始写 ----
  const plan = []
  for (const { code, db } of dbs) {
    const admin = db.prepare("SELECT id, username, name FROM users WHERE username=? AND status='active' AND (role='admin' OR is_super=1)").get(actor)
    const c = collect(db, phone)
    const already = db.prepare('SELECT 1 FROM mall_customers WHERE phone=?').get(phonePseudo)
    if (isEmpty(c)) { report[code] = already ? 'already-erased' : 'not-found'; continue }
    if (!admin) fatal('ACTOR_INVALID', `--actor「${actor}」在行业库 ${code} 中不是启用的 admin`)
    const open = [
      ...c.orders.filter((o) => OPEN_OMS.includes(o.status)).map((o) => `oms_orders#${o.id}(${o.status})`),
      ...c.sales_orders.filter((o) => OPEN_SALES.includes(o.status)).map((o) => `sales_orders#${o.id}(${o.status})`)
    ]
    if (open.length && !allowOpen) {
      console.error(`OPEN_ORDERS: ${code} 有未完结订单 ${open.join(', ')}；抹除会让它们无法履约。完结后再抹除，或明确加 --allow-open-orders`)
      exitCode = 1
      throw Object.assign(new Error('open orders'), { handled: true })
    }
    plan.push({ code, db, c, admin })
  }
  if (!plan.length && !Object.values(report).includes('already-erased')) {
    console.error('NOT_FOUND: 该手机号在任何行业库中都没有商城数据')
    exitCode = 1
  }

  for (const { code, db, c, admin } of plan) {
    try {
      const counts = db.transaction(() => {
        const n = {}
        const phoneOf = (v) => (v === phone ? phonePseudo : pseudo('phone', v))
        n.mall_customers = db.prepare('UPDATE mall_customers SET phone=?, name=? WHERE phone=?').run(phonePseudo, c.customer?.name ? pseudo('name', c.customer.name) : null, phone).changes
        n.mall_cart_items = db.prepare('UPDATE mall_cart_items SET phone=? WHERE phone=?').run(phonePseudo, phone).changes
        const updOms = db.prepare('UPDATE oms_orders SET buyer_nick=?, receiver=?, receiver_phone=?, receiver_address=? WHERE id=?')
        n.oms_orders = 0
        for (const o of c.orders) {
          n.oms_orders += updOms.run(
            o.buyer_nick === `会员${phone}` ? `会员${phonePseudo}` : o.buyer_nick,
            o.receiver ? pseudo('name', o.receiver) : o.receiver,
            o.receiver_phone ? phoneOf(o.receiver_phone) : o.receiver_phone,
            o.receiver_address ? pseudo('address', o.receiver_address) : o.receiver_address,
            o.id
          ).changes
        }
        const updSales = db.prepare('UPDATE sales_orders SET receiver=?, receiver_phone=?, receiver_address=? WHERE id=?')
        n.sales_orders = 0
        for (const s of c.sales_orders) {
          n.sales_orders += updSales.run(
            s.receiver ? pseudo('name', s.receiver) : s.receiver,
            s.receiver_phone ? phoneOf(s.receiver_phone) : s.receiver_phone,
            s.receiver_address ? pseudo('address', s.receiver_address) : s.receiver_address,
            s.id
          ).changes
        }
        n.pos_orders = db.prepare('UPDATE pos_orders SET member_phone=? WHERE member_phone=?').run(phonePseudo, phone).changes
        auditStrictRow(db, {
          userId: admin.id, userName: admin.username, action: 'PRIVACY_ERASE', module: 'privacy', entity: 'mall_customer',
          entityId: c.customer?.id ?? null,
          detail: { subject: phonePseudo.slice(0, ERASED_PREFIX.length + 8), counts: n, order_ids: c.orders.map((o) => o.id), allow_open_orders: allowOpen }
        })
        return n
      }).immediate()
      report[code] = { erased: counts }
    } catch (e) {
      console.error(`${code}: ERASE_FAILED ${e.code || ''} ${e.message}`)
      report[code] = 'failed'
      exitCode = 1
    }
  }
} catch (e) {
  if (!e.handled) throw e
} finally {
  closeAll()
}
console.log(JSON.stringify(report, null, 2))
process.exit(exitCode)
