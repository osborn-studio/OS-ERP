/**
 * ============================================================================
 * 文件标识：server/lib/coupon.js ｜ 模块 18：优惠券（模板 / 实例 / 发放 / 核销 / 过期）
 * ============================================================================
 * 【职责】模块 18：优惠券（模板 / 实例 / 发放 / 核销 / 过期）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 模块 18：优惠券（模板 / 实例 / 发放 / 核销 / 过期）
//
// 券这一层只做四件事：**发得出去、记得住是谁的、只能核销一次、过期就失效**。
// 优惠额**一律不由本模块计算** —— 券只是「一张能解锁某促销的凭证」。
//
// ============================================================================
// 一、三条口径（写死在代码里）
// ============================================================================
//
// 1) **券的优惠额由促销引擎算，券表里不存"券能减多少"。**
//    `coupons.type` / `coupons.value` 是**冗余的展示字段**（列表页要显示"满 100 减 20"），
//    真正算钱的是它绑定的那张 `promotions`（规则在 `promotion_rules` / `promotion_methods`）。
//    为什么不做两套：一旦券里能减、促销里也能减，"这张券到底减多少"就有两个答案，
//    而两个答案不会报错，只会在某一单上不一致 —— 这种不一致要等客户投诉才被发现。
//
// 2) **一张券只能核销一次**，靠的是 `coupon_instances.coupon_code` 唯一
//    ＋ 条件式 `UPDATE ... WHERE status='unused'` ＋ `changes` 判定。
//    不使用「先查状态再改」：那在并发下必然双花，而双花不会报错，
//    只会让同一个 100 元券被抵两次。
//
// 3) **过期是"读时判定 + 写时落库"两件事，缺一不可。**
//    只靠定时任务落库：任务没跑到的时候，过期券在界面上还是"未使用"，客户拿去用会被拒，
//    而拒的理由是"券已过期"却与界面显示矛盾 —— 用户只会认为系统坏了。
//    只靠读时判定：券状态的统计口径（发了多少 / 用了多少 / 过期多少）永远算不出来。
//    所以：所有查询按 `expires_at` 现算是否过期，同时提供 `expireCoupons()` 批量落库。
//
// ============================================================================
// 二、有效期 = 绝对期与相对期取**交集**（取更早的那个）
// ============================================================================
//
//   绝对期 `valid_from` / `valid_to`：活动统一的起止（如"双十一当天可用"）
//   相对期 `valid_days`：领券后 N 天（如"领取后 7 天内有效"）
//   本券实际失效时刻 = min(valid_to, acquired_at + valid_days)
//   起算时刻 = max(valid_from, acquired_at)
//   取交集而不是取其一：任一方没限制就听另一方的，两方都有限制就以更严的为准。
//   只取其一的后果是「双十一发的券"领取后 30 天有效"，12 月还能用」——
//   活动都结束了券还在流通，对账时多出一批无法解释的核销。
// ============================================================================

import { getDb } from '../db/index.js'

export const TEMPLATE_STATUS = { ACTIVE: 'active', PAUSED: 'paused', ENDED: 'ended' }
export const TEMPLATE_STATUS_LABEL = { active: '进行中', paused: '已暂停', ended: '已结束' }

export const INSTANCE_STATUS = { UNUSED: 'unused', USED: 'used', EXPIRED: 'expired', VOID: 'void' }
export const INSTANCE_STATUS_LABEL = { unused: '未使用', used: '已核销', expired: '已过期', void: '已作废' }

function bad(message, code = 'BAD_REQUEST', httpStatus = 400, detail = null) {
  const e = new Error(message)
  e.status = httpStatus
  e.code = code
  e.detail = detail
  return e
}

function resolveDb(db) {
  const handle = db ?? getDb()
  if (!handle) throw bad('数据库不可用', 'DB_UNAVAILABLE', 500)
  return handle
}

const nowLocal = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/**
 * 参数取值的**双写法**兼容层。
 *
 * ===== 这个函数是一次真实缺陷的补丁，别删 =====
 * 本模块最初只认驼峰（`promotionId` / `minSubtotal` / `totalQty`），而 HTTP 层与
 * 数据库列名都是下划线（`promotion_id` / `min_subtotal` / `total_qty`）。
 * 路由把请求体原样透传进来后，**每一个下划线键都被当成"没传"而落回默认值**：
 * 券建出来了、接口返回 200、界面显示成功，但
 *   ① 券根本没绑促销 → 领了也用不了，客户只会说"系统坏了"；
 *   ② `min_subtotal` 落成 0 → 门槛消失，1 元也能用 50 元券；
 *   ③ `total_qty` 落成 null → 限量变不限量，超发检查形同虚设。
 * 三者都不报错，是"静默改掉业务规则"里最难查的一类。
 *
 * 所以这里统一按**下划线为主、驼峰兼容**取值。新代码写 snake_case 即可。
 */
function pick(obj, snake, camel) {
  if (obj == null) return undefined
  if (obj[snake] !== undefined) return obj[snake]
  if (camel !== undefined && obj[camel] !== undefined) return obj[camel]
  return undefined
}

/** 取一个「传了才有」的值：用于"改一半"的 patch 语义（区别于 create 的默认值语义） */
const pickDefined = (obj, snake, camel) => {
  const v = pick(obj, snake, camel)
  return v === undefined ? undefined : v
}

/** 日期加减天数（返回 'YYYY-MM-DD HH:mm:ss'），用 UTC 运算避免时区把日期挪一天 */
function addDays(ts, days) {
  const d = new Date(String(ts).replace(' ', 'T') + 'Z')
  if (Number.isNaN(d.getTime())) return null
  d.setUTCDate(d.getUTCDate() + Number(days))
  return d.toISOString().slice(0, 19).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// 一、券模板
// ---------------------------------------------------------------------------

export function listCoupons(db, { status = null, keyword = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const where = []
  const params = []
  if (status) { where.push('c.status = ?'); params.push(status) }
  if (keyword) { where.push('(c.code LIKE ? OR c.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = store.prepare(`SELECT COUNT(*) AS c FROM coupons c ${clause}`).get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const list = store.prepare(`
    SELECT c.*, p.code AS promotion_code, p.name AS promotion_name, p.status AS promotion_status,
           (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id = c.id) AS instance_total,
           (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id = c.id AND i.status = 'unused')  AS instance_unused,
           (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id = c.id AND i.status = 'used')    AS instance_used,
           (SELECT COUNT(*) FROM coupon_instances i WHERE i.coupon_id = c.id AND i.status = 'expired') AS instance_expired,
           (SELECT COALESCE(SUM(i.used_amount),0) FROM coupon_instances i WHERE i.coupon_id = c.id AND i.status='used') AS redeemed_cents
      FROM coupons c
      LEFT JOIN promotions p ON p.id = c.promotion_id
      ${clause}
     ORDER BY c.status = 'active' DESC, c.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, pageSize, off)
  return {
    list: list.map((r) => ({ ...r, status_label: TEMPLATE_STATUS_LABEL[r.status] ?? r.status })),
    total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1
  }
}

export function getCouponDetail(db, id) {
  const store = resolveDb(db)
  const c = store.prepare('SELECT * FROM coupons WHERE id=? OR code=?').get(id, id)
  if (!c) throw bad(`券模板不存在：${id}`, 'COUPON_NOT_FOUND', 404)
  const promo = c.promotion_id
    ? store.prepare('SELECT id,code,name,status,type,priority,stack_group,is_exclusive FROM promotions WHERE id=?').get(c.promotion_id)
    : null
  return {
    ...c,
    status_label: TEMPLATE_STATUS_LABEL[c.status] ?? c.status,
    promotion: promo,
    remaining: c.total_qty == null ? null : Math.max(0, Number(c.total_qty) - Number(c.issued_qty))
  }
}

export function createCoupon(db, payload = {}) {
  const store = resolveDb(db)
  // 取值走 `pick`：下划线为主、驼峰兼容 —— 原因见 pick 的注释（静默落默认值那次缺陷）
  const code = pick(payload, 'code')
  const name = pick(payload, 'name')
  const promotionId = pick(payload, 'promotion_id', 'promotionId') ?? null
  const type = pick(payload, 'type') ?? 'fixed'
  const value = pick(payload, 'value') ?? 0
  const minSubtotalCents = pick(payload, 'min_subtotal', 'minSubtotalCents') ?? 0
  const totalQty = pick(payload, 'total_qty', 'totalQty') ?? null
  const perUserLimit = pick(payload, 'per_user_limit', 'perUserLimit') ?? 1
  const validFrom = pick(payload, 'valid_from', 'validFrom') ?? null
  const validTo = pick(payload, 'valid_to', 'validTo') ?? null
  const validDays = pick(payload, 'valid_days', 'validDays') ?? null
  const remark = pick(payload, 'remark') ?? null
  if (!String(code || '').trim()) throw bad('券模板码必填', 'BAD_ARGS', 400)
  if (!String(name || '').trim()) throw bad('券名称必填', 'BAD_ARGS', 400)
  if (type !== 'fixed' && type !== 'percent') throw bad(`券类型只支持 fixed / percent，收到：${type}`, 'BAD_ARGS', 400)
  if (store.prepare('SELECT 1 AS hit FROM coupons WHERE code=?').get(code)) {
    throw bad(`券模板码已存在：${code}`, 'COUPON_CODE_EXISTS', 409)
  }
  if (promotionId != null && !store.prepare('SELECT 1 AS hit FROM promotions WHERE id=?').get(promotionId)) {
    throw bad(`关联的促销不存在：#${promotionId}`, 'PROMOTION_NOT_FOUND', 400)
  }
  if (validFrom && validTo && String(validFrom) > String(validTo)) {
    throw bad(`有效期写反了：valid_from ${validFrom} 晚于 valid_to ${validTo}`, 'BAD_WINDOW', 400)
  }
  const info = store.prepare(`
    INSERT INTO coupons (code,name,promotion_id,type,value,min_subtotal,total_qty,per_user_limit,valid_from,valid_to,valid_days,remark)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(code, name, promotionId, type, Math.trunc(Number(value) || 0), Math.trunc(Number(minSubtotalCents) || 0),
    totalQty == null ? null : Math.trunc(Number(totalQty)), Math.max(1, Math.trunc(Number(perUserLimit) || 1)),
    validFrom, validTo, validDays == null ? null : Math.trunc(Number(validDays)), remark)
  return getCouponDetail(store, info.lastInsertRowid)
}

export function updateCoupon(db, id, payload = {}) {
  const store = resolveDb(db)
  const c = store.prepare('SELECT * FROM coupons WHERE id=?').get(id)
  if (!c) throw bad(`券模板不存在：${id}`, 'COUPON_NOT_FOUND', 404)
  const totalQty = pickDefined(payload, 'total_qty', 'totalQty')
  const promotionId = pickDefined(payload, 'promotion_id', 'promotionId')
  // 发行量只能往大改：往小改会让已发出去的券数量超过上限，那是自相矛盾的数据
  if (totalQty != null && Number(totalQty) < Number(c.issued_qty)) {
    throw bad(
      `发行量不能小于已发放数量（已发 ${c.issued_qty} 张，本次填 ${totalQty}）`,
      'TOTAL_QTY_TOO_SMALL', 400, { issued_qty: c.issued_qty }
    )
  }
  // 已发放的券不能换绑促销：换了之后"手里这张券能减多少"会变，
  // 而客户是看着当时的说明领的券
  if (promotionId !== undefined && Number(promotionId ?? 0) !== Number(c.promotion_id ?? 0) &&
      Number(c.issued_qty) > 0) {
    throw bad('已开始发放的券不能再换绑促销活动（否则已领券的减免额会变）', 'PROMOTION_REBIND_FORBIDDEN', 400)
  }
  const sets = []
  const params = []
  const NUMERIC = new Set(['promotion_id', 'value', 'min_subtotal', 'total_qty', 'per_user_limit', 'valid_days'])
  const map = [
    ['name', 'name'], ['promotion_id', 'promotion_id', 'promotionId'], ['type', 'type'], ['value', 'value'],
    ['min_subtotal', 'min_subtotal', 'minSubtotalCents'], ['total_qty', 'total_qty', 'totalQty'],
    ['per_user_limit', 'per_user_limit', 'perUserLimit'], ['valid_from', 'valid_from', 'validFrom'],
    ['valid_to', 'valid_to', 'validTo'], ['valid_days', 'valid_days', 'validDays'],
    ['remark', 'remark'], ['status', 'status']
  ]
  for (const [snake, col, camel] of map) {
    const v = pickDefined(payload, snake, camel)
    if (v === undefined) continue
    sets.push(`${col} = ?`)
    params.push(v === null ? null : (NUMERIC.has(col) ? Math.trunc(Number(v)) : v))
  }
  if (!sets.length) return getCouponDetail(store, id)
  sets.push("updated_at = datetime('now','localtime')")
  store.prepare(`UPDATE coupons SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  return getCouponDetail(store, id)
}

export function setCouponStatus(db, id, status) {
  const store = resolveDb(db)
  if (!Object.values(TEMPLATE_STATUS).includes(status)) {
    throw bad(`券状态无效：${status}`, 'BAD_ARGS', 400)
  }
  const r = store.prepare("UPDATE coupons SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, id)
  if (!r.changes) throw bad(`券模板不存在：${id}`, 'COUPON_NOT_FOUND', 404)
  return getCouponDetail(store, id)
}

// ---------------------------------------------------------------------------
// 二、发放与领取
// ---------------------------------------------------------------------------

/**
 * 券码生成：`<模板码>-<6位序号>`。
 * 用「本模板已发数量 + 1」而不是随机串 —— 随机串在并发下要重试，而重试失败的形态是
 * 「点了发放没反应」，很难排查；序号只需要在一次事务里自增，天然唯一。
 */
function nextCouponCode(store, template, seq) {
  return `${template.code}-${String(seq).padStart(6, '0')}`
}

/**
 * 算这张券的实际失效时刻与起算时刻（绝对期与相对期取交集）。
 * 返回值同时给界面用来显示"有效期至"。
 */
export function resolveValidity(template, acquiredAt) {
  const at = acquiredAt || nowLocal()
  let from = template.valid_from || null
  if (!from || at > from) from = at
  let to = template.valid_to || null
  if (template.valid_days != null) {
    const rel = addDays(at, template.valid_days)
    if (rel && (!to || rel < to)) to = rel
  }
  return { from, to }
}

/**
 * 发放：给某个客户发 N 张。
 * 发行总量按**条件式更新**扣减（`used < total_qty`），判断与写入在同一条语句里，
 * 所以并发发放不会超发。这与促销引擎 `registerUsage` 是同一套做法。
 */
export function issueCoupons(db, { couponId, customerId, qty = 1, remark = null } = {}) {
  const store = resolveDb(db)
  const n = Math.max(1, Math.trunc(Number(qty) || 1))
  const tx = store.transaction(() => {
    const tpl = store.prepare('SELECT * FROM coupons WHERE id=?').get(couponId)
    if (!tpl) throw bad(`券模板不存在：#${couponId}`, 'COUPON_NOT_FOUND', 404)
    if (tpl.status !== TEMPLATE_STATUS.ACTIVE) {
      throw bad(`券「${tpl.name}」当前状态为「${TEMPLATE_STATUS_LABEL[tpl.status] ?? tpl.status}」，不能发放`, 'COUPON_NOT_ACTIVE', 409)
    }
    if (!store.prepare('SELECT 1 AS hit FROM mall_customers WHERE id=?').get(customerId)) {
      throw bad(`商城客户不存在：#${customerId}`, 'CUSTOMER_NOT_FOUND', 404)
    }

    // 每人限领：把「已持有张数」也算进去，否则重复点发放能绕开 per_user_limit
    if (tpl.per_user_limit != null) {
      const owned = store.prepare(
        "SELECT COUNT(*) AS c FROM coupon_instances WHERE coupon_id=? AND customer_id=? AND status IN ('unused','used')"
      ).get(couponId, customerId).c
      if (owned + n > Number(tpl.per_user_limit)) {
        throw bad(
          `每人限领 ${tpl.per_user_limit} 张，该客户已持有 ${owned} 张，本次再发 ${n} 张会超限`,
          'PER_USER_LIMIT', 400, { owned, limit: tpl.per_user_limit, qty: n }
        )
      }
    }

    // 总量：条件式更新，`changes === 0` 表示已经发满
    if (tpl.total_qty != null) {
      const info = store.prepare(`
        UPDATE coupons SET issued_qty = issued_qty + ?
         WHERE id = ? AND issued_qty + ? <= total_qty
      `).run(n, couponId, n)
      if (info.changes === 0) {
        throw bad(
          `券「${tpl.name}」发行量已用尽（${tpl.issued_qty}/${tpl.total_qty}）`,
          'COUPON_EXHAUSTED', 409, { issued: tpl.issued_qty, total: tpl.total_qty }
        )
      }
    } else {
      store.prepare('UPDATE coupons SET issued_qty = issued_qty + ? WHERE id = ?').run(n, couponId)
    }

    const fresh = store.prepare('SELECT * FROM coupons WHERE id=?').get(couponId)
    const ins = store.prepare(`
      INSERT INTO coupon_instances (coupon_id, coupon_code, customer_id, status, acquired_at, expires_at, remark)
      VALUES (?,?,?, 'unused', ?, ?, ?)
    `)
    // 序号从「已发数量 - n」起算，保证与 issued_qty 一致
    const startSeq = Number(fresh.issued_qty) - n
    const codes = []
    for (let i = 1; i <= n; i++) {
      const code = nextCouponCode(store, fresh, startSeq + i)
      ins.run(couponId, code, customerId, nowLocal(), resolveValidity(fresh, nowLocal()).to, remark)
      codes.push(code)
    }
    return { coupon_id: couponId, coupon_name: fresh.name, customer_id: customerId, issued: n, codes }
  })
  return tx.immediate()
}

/** 领券（客户自助）：与发放同一套校验，只是由客户自己触发 */
export function claimCoupon(db, { couponCode, customerId } = {}) {
  const store = resolveDb(db)
  const tpl = store.prepare('SELECT * FROM coupons WHERE code=?').get(couponCode)
  if (!tpl) throw bad(`券不存在或已下架：${couponCode}`, 'COUPON_NOT_FOUND', 404)
  return issueCoupons(store, { couponId: tpl.id, customerId, qty: 1, remark: '客户自助领取' })
}

// ---------------------------------------------------------------------------
// 三、有效期判定与核销
// ---------------------------------------------------------------------------

/** 读时判定：过期的券在**任何**查询里都不许显示成"未使用" */
function effectiveStatus(inst, at) {
  if (inst.status !== INSTANCE_STATUS.UNUSED) return inst.status
  if (inst.expires_at && at > inst.expires_at) return INSTANCE_STATUS.EXPIRED
  return INSTANCE_STATUS.UNUSED
}

/**
 * 批量把已过期的券落库。可以由启动流程或定时任务调用，也可由界面上的"刷新"触发。
 * 幂等：只改仍为 unused 且 expires_at 已过的那批。
 */
export function expireCoupons(db, { at = null } = {}) {
  const store = resolveDb(db)
  const now = at || nowLocal()
  const r = store.prepare(`
    UPDATE coupon_instances SET status='expired'
     WHERE status='unused' AND expires_at IS NOT NULL AND expires_at < ?
  `).run(now)
  return { expired: r.changes }
}

export function listInstances(db, { customerId = null, couponId = null, status = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const where = []
  const params = []
  if (customerId) { where.push('i.customer_id = ?'); params.push(customerId) }
  if (couponId) { where.push('i.coupon_id = ?'); params.push(couponId) }
  // status 过滤器配合读时判定：查「未使用」时要同时排除已过期的
  if (status === INSTANCE_STATUS.UNUSED) {
    where.push("i.status = 'unused' AND (i.expires_at IS NULL OR i.expires_at >= ?)")
    params.push(nowLocal())
  } else if (status === INSTANCE_STATUS.EXPIRED) {
    where.push("(i.status = 'expired' OR (i.status = 'unused' AND i.expires_at IS NOT NULL AND i.expires_at < ?))")
    params.push(nowLocal())
  } else if (status) { where.push('i.status = ?'); params.push(status) }

  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = store.prepare(`SELECT COUNT(*) AS c FROM coupon_instances i ${clause}`).get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const now = nowLocal()
  const list = store.prepare(`
    SELECT i.*, c.code AS template_code, c.name AS coupon_name, c.type, c.value, c.min_subtotal, c.status AS template_status,
           cu.phone, cu.name AS customer_name
      FROM coupon_instances i
      JOIN coupons c        ON c.id = i.coupon_id
      LEFT JOIN mall_customers cu ON cu.id = i.customer_id
      ${clause}
     ORDER BY i.status = 'unused' DESC, i.id DESC
     LIMIT ? OFFSET ?
  `).all(...params, pageSize, off)
  return {
    list: list.map((r) => {
      const st = effectiveStatus(r, now)
      return { ...r, effective_status: st, status_label: INSTANCE_STATUS_LABEL[st] ?? st }
    }),
    total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1
  }
}

export function voidInstance(db, { instanceId, remark } = {}) {
  const store = resolveDb(db)
  if (!String(remark ?? '').trim()) throw bad('作废券必须写明原因', 'REMARK_REQUIRED', 400)
  const r = store.prepare(`
    UPDATE coupon_instances SET status='void', remark=? WHERE id=? AND status='unused'
  `).run(remark, instanceId)
  if (!r.changes) throw bad('该券不存在或已被使用/作废，不能作废', 'COUPON_NOT_VOIDABLE', 409)
  return { instance_id: instanceId, status: INSTANCE_STATUS.VOID }
}

/**
 * 校验一张券能不能用在这一单上。
 * 返回 `{ ok, reason, instance, template, discount_promotion_code }`。
 * 这里**不**算优惠额 —— 只回答"这张券有效吗、它解锁的是哪张促销"。
 */
export function validateCoupon(db, { code, customerId = null, orderAmountCents = 0, at = null } = {}) {
  const store = resolveDb(db)
  const now = at || nowLocal()
  const inst = store.prepare('SELECT * FROM coupon_instances WHERE coupon_code=?').get(code)
  if (!inst) return { ok: false, reason: 'not_found', message: '券码不存在' }
  const tpl = store.prepare('SELECT * FROM coupons WHERE id=?').get(inst.coupon_id)
  if (!tpl) return { ok: false, reason: 'template_missing', message: '券模板已删除' }

  const st = effectiveStatus(inst, now)
  if (st === INSTANCE_STATUS.USED) return { ok: false, reason: 'used', message: '该券已核销', instance: inst, template: tpl }
  if (st === INSTANCE_STATUS.EXPIRED) {
    return { ok: false, reason: 'expired', message: `该券已于 ${inst.expires_at} 过期`, instance: inst, template: tpl }
  }
  if (st === INSTANCE_STATUS.VOID) return { ok: false, reason: 'void', message: '该券已作废', instance: inst, template: tpl }
  if (tpl.status !== TEMPLATE_STATUS.ACTIVE) {
    return { ok: false, reason: 'template_not_active', message: `券活动当前状态为「${TEMPLATE_STATUS_LABEL[tpl.status] ?? tpl.status}」`, instance: inst, template: tpl }
  }
  // 起算时刻：券在 valid_from 之前不可用（如"双十一当天才生效"）
  const v = resolveValidity(tpl, inst.acquired_at)
  if (v.from && now < v.from) {
    return { ok: false, reason: 'not_started', message: `该券 ${v.from} 才生效`, instance: inst, template: tpl }
  }
  if (customerId != null && inst.customer_id != null && Number(inst.customer_id) !== Number(customerId)) {
    return { ok: false, reason: 'not_owner', message: '该券不属于当前客户', instance: inst, template: tpl }
  }
  if (Number(orderAmountCents) < Number(tpl.min_subtotal || 0)) {
    return {
      ok: false, reason: 'below_min',
      message: `本单金额未达到券门槛（需满 ${(Number(tpl.min_subtotal) / 100).toFixed(2)} 元）`,
      instance: inst, template: tpl
    }
  }
  if (!tpl.promotion_id) {
    return { ok: false, reason: 'no_promotion', message: '该券尚未关联促销活动，无法产生优惠', instance: inst, template: tpl }
  }
  const promo = store.prepare('SELECT * FROM promotions WHERE id=?').get(tpl.promotion_id)
  if (!promo) return { ok: false, reason: 'promotion_missing', message: '券关联的促销已删除', instance: inst, template: tpl }
  if (promo.status !== 'active') {
    return { ok: false, reason: 'promotion_not_active', message: `关联促销「${promo.name}」当前不可用`, instance: inst, template: tpl }
  }
  return { ok: true, instance: inst, template: tpl, promotion: promo, discount_promotion_code: promo.code }
}

/**
 * 核销：把券置为已用，并记录订单与实际抵扣额。
 *
 * 幂等有**两道**防线，错误码分两层：
 *   ① 前置 `validateCoupon` → `COUPON_NOT_USABLE` + `reason='used'`（正常路径走这条）；
 *   ② 条件式 UPDATE（只从 `unused` 出发）的 `changes===0` → `COUPON_ALREADY_USED`，
 *      这一层是并发兜底（两个请求都读到了 unused），正常串行路径到不了。
 * 两道都不可省：只有 ① 会在并发下漏；只有 ② 会让调用方拿到"意料之外"的码。
 */
export function redeemCoupon(db, { code, source = null, orderId = null, customerId = null, amountCents = 0, at = null } = {}) {
  const store = resolveDb(db)
  const check = validateCoupon(store, { code, customerId, orderAmountCents: Number.MAX_SAFE_INTEGER, at })
  // 注意上面传入的 orderAmountCents 只是为了让门槛校验不在这里拦（核销时门槛已由结算环节判定过）
  if (!check.ok && check.reason !== 'below_min') {
    throw bad(check.message, 'COUPON_NOT_USABLE', 409, { reason: check.reason })
  }
  const tx = store.transaction(() => {
    // `source` 与 `order_id` 一起写（迁移 030）：只存 order_id 的话，
    // 「商城第 418 单」核销的券会被「门店第 418 单」的取消操作退回去。
    const r = store.prepare(`
      UPDATE coupon_instances
         SET status='used', used_at=?, source=?, order_id=?, used_amount=?
       WHERE coupon_code=? AND status='unused'
         AND (expires_at IS NULL OR expires_at >= ?)
    `).run(at || nowLocal(), source, orderId, Math.trunc(Number(amountCents) || 0), code, at || nowLocal())
    if (!r.changes) {
      throw bad('该券已被核销或已过期，不能再次使用', 'COUPON_ALREADY_USED', 409)
    }
    return { coupon_code: code, source, order_id: orderId, used_amount: Math.trunc(Number(amountCents) || 0) }
  })
  return tx.immediate()
}

/**
 * 订单取消 / 退款时把券退回未使用。
 * 为什么必须提供"退回"：券一旦只能用一次，而订单可能被取消 ——
 * 没有退回就等于「取消一次订单白扔一张券」，这类事故不会报错，
 * 只会在客服那边变成"我的券怎么没了"。
 */
export function releaseCoupon(db, { source, orderId, remark = '订单取消退回' } = {}) {
  const store = resolveDb(db)
  // 必须带 `source`：只按 order_id 找会把同号的另一张单用掉的券也退回来（迁移 030）。
  const rows = source
    ? store.prepare("SELECT * FROM coupon_instances WHERE source=? AND order_id=? AND status='used'").all(source, orderId)
    : store.prepare("SELECT * FROM coupon_instances WHERE order_id=? AND status='used'").all(orderId)
  if (!rows.length) return { released: 0, codes: [] }
  const tx = store.transaction(() => {
    const up = store.prepare(`
      UPDATE coupon_instances SET status='unused', used_at=NULL, source=NULL, order_id=NULL, used_amount=0, remark=?
       WHERE id=? AND status='used'
    `)
    for (const r of rows) up.run(remark, r.id)
    return { released: rows.length, codes: rows.map((r) => r.coupon_code) }
  })
  return tx.immediate()
}

/**
 * 客户手里**当前可用**的券（只读展示用，**不含任何"要用哪张"的判断**）。
 * 界面上的"我的券包"、结算页的"可用券"列表走这里。
 */
export function availableCoupons(db, { customerId, orderAmountCents = 0, at = null } = {}) {
  const store = resolveDb(db)
  const now = at || nowLocal()
  const rows = store.prepare(`
    SELECT * FROM coupon_instances
     WHERE customer_id=? AND status='unused' AND (expires_at IS NULL OR expires_at >= ?)
     ORDER BY expires_at IS NULL, expires_at, id
  `).all(customerId, now)
  const usable = []
  const blocked = []
  for (const inst of rows) {
    const chk = validateCoupon(store, { code: inst.coupon_code, customerId, orderAmountCents, at: now })
    // `min_subtotal` **本来就是分**（见 validateCoupon 的门槛比较，以及 openapi 里
    // 那句「使用门槛（**分**）」）。这里曾经写成 `* 100`，于是界面把 ¥404 的门槛
    // 显示成 ¥40,400 —— 数字有、接口 200、不报错，只是差了 100 倍。
    if (chk.ok) usable.push({ coupon_code: inst.coupon_code, promotion_code: chk.discount_promotion_code, coupon_name: chk.template.name, min_subtotal_cents: Number(chk.template.min_subtotal || 0) })
    else blocked.push({ coupon_code: inst.coupon_code, reason: chk.reason, message: chk.message })
  }
  return { usable, blocked }
}

/**
 * 给促销引擎用的券码清单：把券实例码翻译成它们各自解锁的 `promotions.code`。
 *
 * 这一步是券与促销的接缝：促销引擎只认 `promotions.code`（见 promotion.js 的 `ctx.codes`），
 * 券码与促销码是两套编号，必须在这里换一次 —— 而不是把券码塞进促销引擎让它自己找。
 *
 * ⚠️ **默认只认调用方显式传进来的券码（`couponCodes`）。**
 * 曾经这里无条件把客户名下所有未用券也一起塞进来，后果是：
 * 一句普通的购物车试算就会"自动帮我用掉全部券"，落单时全部核销 ——
 * 客户没选、也没看见，券就没了。而且它**不会报错**，只会让券包莫名其妙变空。
 * 需要"帮我挑最省的一张"时，由调用方显式传 `auto: true` 表达这个意图。
 */
export function codesForCustomer(db, { customerId, orderAmountCents = 0, couponCodes = [], auto = false, at = null } = {}) {
  const store = resolveDb(db)
  const now = at || nowLocal()
  const out = []
  const rejected = []
  const seen = new Set()

  const push = (inst) => {
    if (!inst || seen.has(inst.coupon_code)) return
    seen.add(inst.coupon_code)
    const chk = validateCoupon(store, { code: inst.coupon_code, customerId, orderAmountCents, at: now })
    if (chk.ok) out.push({ coupon_code: inst.coupon_code, promotion_code: chk.discount_promotion_code, coupon_name: chk.template.name })
    else rejected.push({ coupon_code: inst.coupon_code, reason: chk.reason, message: chk.message })
  }

  for (const code of couponCodes) {
    const inst = store.prepare('SELECT * FROM coupon_instances WHERE coupon_code=?').get(code)
    if (!inst) { rejected.push({ coupon_code: code, reason: 'not_found', message: '券码不存在' }); continue }
    push(inst)
  }
  // 显式声明「自动选券」时才带上客户名下的券；否则一张都不带。
  if (auto && customerId != null) {
    for (const u of availableCoupons(store, { customerId, orderAmountCents, at: now }).usable) {
      const inst = store.prepare('SELECT * FROM coupon_instances WHERE coupon_code=?').get(u.coupon_code)
      push(inst)
    }
  }
  return {
    promotionCodes: out.map((o) => o.promotion_code),
    accepted: out,
    rejected
  }
}

export default {
  TEMPLATE_STATUS, TEMPLATE_STATUS_LABEL, INSTANCE_STATUS, INSTANCE_STATUS_LABEL,
  listCoupons, getCouponDetail, createCoupon, updateCoupon, setCouponStatus,
  issueCoupons, claimCoupon, resolveValidity,
  expireCoupons, listInstances, voidInstance,
  validateCoupon, redeemCoupon, releaseCoupon, codesForCustomer, availableCoupons
}
