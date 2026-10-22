/**
 * ============================================================================
 * 文件标识：server/lib/member.js ｜ 模块 18：会员（等级 / 积分 / 储值）
 * ============================================================================
 * 【职责】模块 18：会员（等级 / 积分 / 储值）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 模块 18：会员（等级 / 积分 / 储值）
//
// 这个文件只做一件事：让「这个客户是什么等级、有多少积分和储值、这些数怎么来的」
// 变成一个**可推导、可回放、可对账**的结果。
//
// ============================================================================
// 一、四条口径（写死在代码里，不靠界面记得）
// ============================================================================
//
// 1) **余额不是真相，流水才是**。
//    账户上的 `points` / `balance_cents` 是**余额**（为了列表页不用聚合）；
//    真相在 `member_points_ledger` / `member_balance_ledger` 里。
//    所以每一次变动都必须：写流水 → 改余额 → **立刻复算两者是否相等**，不等就抛错回滚。
//    只写余额不写流水的问题不是"不准"，而是**说不清**：客户问「我的 500 分怎么来的」，
//    账上只能回答"就是 500"。这与成本域「残差恒为 0 是唯一的账实自证手段」同源。
//
// 2) **积分与储值分两本账**，不合成一张带判别列的表。
//    两者**单位不同**（积分 vs 分），混在一张表里每一次 SUM 都要带过滤条件，
//    而漏过滤不会报错、只会把「3 元」和「300 积分」加成 303。
//    （成本域「金额与数量不能共用一个舍入函数」是同一个教训。）
//    单位也写进了列名：`_points` / `_cents` / `_yuan`，读到名字就知道是什么。
//
// 3) **等级判定用「累计获得积分 + 累计消费」，不用「当前可用积分」**。
//    用可用积分判等级会让客户一兑换就掉级 —— 那是产品事故，不是设计。
//    所以账户上 `points_total` **只增不减**：兑换只减 `points`，不动 `points_total`。
//
// 4) **跨域换算只在边界做一次**。销售/商城域的金额是「元」（REAL），
//    会员域内部一律「分」的整数（余额、累计消费、抵扣额），促销域同理。
//    入口函数收「元」并立刻转「分」，出口再转回去 —— 中间不再出现元。
//    折扣要反复按比例摊、还要除回去，REAL 累计必然出现尾差（本项目在成本域踩过）。
//
// ============================================================================
// 二、积分的三条路（获得 / 抵扣 / 兑换）与两条硬拦
// ============================================================================
//
//   获得 earn    ：按 `promo_points_per_yuan` × 等级倍率 × 订单金额（向下取整）
//   抵扣 redeem  ：积分直接抵现，**上限 = min(等级上限, 全局上限) 占订单额的万分比**
//   调整 adjust  ：人工纠错，**必须写理由**（没有理由的调整等于没有账）
//
//   硬拦一：**积分与储值都不能为负**。余额不足就抛错，不做"先欠着"。
//   硬拦二：**抵扣不得超过订单金额，也不得超过积分余额能换出的钱**。
//          前者防「越抵越多」，后者防把积分当钱刷。
// ============================================================================

import { getDb } from '../db/index.js'
import { readSetting } from './settings.js'

// ---------- 常量 ----------

export const POINTS_KIND = {
  EARN: 'earn',        // 消费获得
  REDEEM: 'redeem',    // 兑换 / 抵现
  ADJUST: 'adjust',    // 人工调整
  EXPIRE: 'expire',    // 过期
  LEVEL_UP: 'level_up' // 等级变更（零变动留痕，只为时间线完整）
}

export const BALANCE_KIND = {
  RECHARGE: 'recharge', // 充值
  PAY: 'pay',           // 消费扣减
  REFUND: 'refund',     // 退还
  ADJUST: 'adjust'      // 人工调整
}

export const POINTS_KIND_LABEL = {
  earn: '消费获得', redeem: '兑换抵扣', adjust: '人工调整', expire: '过期扣除', level_up: '等级变更'
}

export const BALANCE_KIND_LABEL = {
  recharge: '储值充值', pay: '储值消费', refund: '储值退还', adjust: '人工调整'
}

export const LEVEL_LABEL = {
  normal: '普通会员', silver: '银牌会员', gold: '金牌会员', platinum: '铂金会员'
}

// 四个积分/会员配置的**默认值与值域**唯一出处：`lib/settings.js` 的 `SETTING_RULES`。
// 本文件不再自带一份常量 —— 那正是批次 R 要根治的"同一个键四处各写一遍默认值"。
const EPS = 0.005

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

/**
 * 把 `actor` 归一成可读的操作人名字。
 * 这个参数曾经直接拼进 remark，而路由层传的是 `{id, name}` 对象 ——
 * 结果是流水里留下一句「（操作人：[object Object]）」，账还是有，但人查不出来。
 * 所以这里同时接受对象与字符串，统一取出名字。
 */
function actorName(actor) {
  if (!actor) return null
  if (typeof actor === 'string') return actor.trim() || null
  return actor.name || actor.username || (actor.id != null ? `#${actor.id}` : null)
}

/** 把操作人拼到理由后面。没有操作人时原样返回。 */
const withActor = (remark, actor) => {
  const an = actorName(actor)
  return an ? `${remark}（操作人：${an}）` : remark
}

/** 元 → 分（入口唯一换算点，四舍五入到分） */
export const yuanToCents = (yuan) => Math.round(Number(yuan || 0) * 100)
/** 分 → 元（出口唯一换算点） */
export const centsToYuan = (cents) => Number((Number(cents || 0) / 100).toFixed(2))

// 读取一律走 `readSetting`（唯一的读取点）。原来这里有一个私有的 `settingNum()`，
// 它对"读到了但值不合法"的处理与 `quote.js` / `credit.js` / `pos2.js` 三处**各不相同**
// —— 同一个键被四套规则解释。现在"值域"只有一处定义（`SETTING_RULES`），
// 所以「抵扣 1 元所需积分」不会再出现"配成 0 除零"的隐患：
// 它在 `SETTING_RULES` 里被声明为 `gt: 0`，写入点直接拒绝，读取点回落默认值。

/** 结算后是否自动重判会员等级 */
export const isAutoUpgrade = (db) => readSetting(db, 'member_upgrade_auto')

/** 每消费 1 元得多少基础积分 */
export const pointsPerYuan = (db) => readSetting(db, 'promo_points_per_yuan')
/** 抵扣 1 元需要多少积分 */
export const pointsPerYuanDeduct = (db) => readSetting(db, 'promo_points_per_yuan_deduct')
/** 全局抵扣上限（万分比） */
export const deductMaxBp = (db) => readSetting(db, 'promo_points_deduct_max')

// ---------------------------------------------------------------------------
// 等级
// ---------------------------------------------------------------------------

export function listLevels(db) {
  const store = resolveDb(db)
  return store.prepare('SELECT * FROM member_levels WHERE status=? ORDER BY sort_order, id').all('active')
}

/** 按「累计积分 + 累计消费」判定**达标等级**（可能同时满足多档，取最高档） */
export function levelOf(db, { pointsTotal = 0, totalSpentCents = 0 } = {}) {
  const store = resolveDb(db)
  const rows = store.prepare('SELECT * FROM member_levels WHERE status=? ORDER BY sort_order, id').all('active')
  let hit = null
  for (const lv of rows) {
    // 两个门槛是 **与** 关系：积分够了但没花钱，不算达标。
    // 单独用积分会出现「注册送 30000 分直接变铂金」的漏洞。
    if (Number(pointsTotal) >= Number(lv.min_points) &&
        Number(totalSpentCents) >= yuanToCents(lv.min_spent_yuan)) hit = lv
  }
  // 全都不达标时落到门槛最低的那一档（而不是返回 null）—— 会员等级必须永远有值，
  // 否则界面上会到处出现「等级：-」，而下游按等级取折扣的地方要写一堆兜底。
  return hit ?? rows[0] ?? null
}

/**
 * 按账户现状重新判定等级并落库。
 * `force` 为真时无视 `member_upgrade_auto`（人工改等级走这条）。
 * 返回 { from, to, changed }。
 */
export function syncLevel(db, customerId, { force = false } = {}) {
  const store = resolveDb(db)
  const acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  if (!acc) throw bad(`会员账户不存在：customer#${customerId}`, 'ACCOUNT_NOT_FOUND', 404)
  const next = levelOf(store, { pointsTotal: acc.points_total, totalSpentCents: acc.total_spent_cents })
  if (!next) return { from: acc.level_code, to: acc.level_code, changed: false }
  if (next.code === acc.level_code) return { from: acc.level_code, to: next.code, changed: false }
  if (!force && !isAutoUpgrade(store)) return { from: acc.level_code, to: next.code, changed: false, blocked: 'auto_disabled' }

  store.prepare(`
    UPDATE member_accounts SET level_code=?, upgraded_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
     WHERE customer_id=?
  `).run(next.code, customerId)
  // 等级变更记一条**零变动**流水：SUM 不受影响（加 0），但会员时间线上
  // 「他什么时候升到金牌的」能被回答 —— 否则这个事实只活在 current 值里，
  // 下次再升就被覆盖，等于没记。
  writePointsLedger(store, {
    customerId,
    kind: POINTS_KIND.LEVEL_UP,
    change: 0,
    sourceType: 'level_up',
    remark: `等级变更：${LEVEL_LABEL[acc.level_code] ?? acc.level_code} → ${LEVEL_LABEL[next.code] ?? next.code}`
  })
  return { from: acc.level_code, to: next.code, changed: true }
}

/**
 * **人工指定等级**（老客户补偿、大客户特批等场景）。
 *
 * 与 `syncLevel` 分开的理由：`syncLevel` 是「按规则推导」，本函数是「人说了算」。
 * 混在一起会导致下一次送分时自动判定把人工设的等级直接冲掉 ——
 * 而那种"我明明改成铂金了，过一天又变回银牌"最难排查。
 * 所以人工改等级会把累计门槛**一起抬到达标线**，让自动判定与人工设定不打架。
 */
export function setMemberLevel(db, { customerId, levelCode, remark, actor = null } = {}) {
  const store = resolveDb(db)
  if (!remark || !String(remark).trim()) {
    // 等级关系到折扣与权益，等于一次变相的调价 —— 不留理由的等级变更无法复盘。
    throw bad('人工调整等级必须填写理由', 'REASON_REQUIRED', 400)
  }
  const lv = store.prepare('SELECT * FROM member_levels WHERE code=? AND status=?').get(String(levelCode), 'active')
  if (!lv) throw bad(`等级不存在或已停用：${levelCode}`, 'LEVEL_NOT_FOUND', 404)
  ensureAccount(store, customerId)
  const tx = store.transaction(() => {
    const acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
    // 抬高累计门槛到达标线：否则下一单送完分，自动判定会依据旧门槛把他判回去
    const pointsFloor = Math.max(Number(acc.points_total), Number(lv.min_points))
    const spentFloor = Math.max(Number(acc.total_spent_cents), yuanToCents(lv.min_spent_yuan))
    store.prepare(`
      UPDATE member_accounts
         SET level_code=?, points_total=?, total_spent_cents=?,
             upgraded_at=datetime('now','localtime'), updated_at=datetime('now','localtime')
       WHERE customer_id=?
    `).run(lv.code, pointsFloor, spentFloor, customerId)
    writePointsLedger(store, {
      customerId,
      kind: POINTS_KIND.LEVEL_UP,
      change: 0,
      sourceType: 'manual',
      remark: `人工调整等级：${LEVEL_LABEL[acc.level_code] ?? acc.level_code} → ${lv.name}；理由：${withActor(remark, actor)}`
    })
    assertLedgerConsistent(store, customerId)
    return { from: acc.level_code, to: lv.code, changed: acc.level_code !== lv.code }
  })
  return tx.immediate()
}

/**
 * 编辑等级权益（折扣率 / 积分倍率 / 抵扣上限）。**改的是配置，不是余额** ——
 * 所以可以直接覆盖写；但必须校验，否则一个 0 折扣率会让全场商品卖 0 元。
 */
export function updateLevel(db, code, patch = {}) {
  const store = resolveDb(db)
  const cur = store.prepare('SELECT * FROM member_levels WHERE code=?').get(code)
  if (!cur) throw bad(`等级不存在：${code}`, 'LEVEL_NOT_FOUND', 404)
  const out = { ...cur }
  if (patch.name !== undefined) out.name = String(patch.name)
  if (patch.discount_pct !== undefined) {
    const pct = Math.round(Number(patch.discount_pct))
    // 万分比：10000 = 不打折，0 = 打到 0 元。上限必须卡死 10000，
    // 超过就是"倒贴"，而下单流程不会报错，只会算出一个负优惠。
    if (!Number.isFinite(pct) || pct <= 0 || pct > 10000) {
      throw bad(`等级折扣 discount_pct 必须在 1~10000 之间（万分比，10000=不打折），收到 ${patch.discount_pct}`, 'BAD_DISCOUNT', 400)
    }
    out.discount_pct = pct
  }
  if (patch.points_rate !== undefined) {
    const rate = Math.round(Number(patch.points_rate))
    if (!Number.isFinite(rate) || rate < 0) throw bad('积分倍率必须是不小于 0 的整数', 'BAD_RATE', 400)
    out.points_rate = rate
  }
  if (patch.points_deduct_limit !== undefined) {
    const lim = Math.round(Number(patch.points_deduct_limit))
    if (!Number.isFinite(lim) || lim < 0 || lim > 10000) {
      throw bad('积分抵扣上限是万分比，必须在 0~10000 之间（5000=最多抵一半）', 'BAD_DEDUCT_LIMIT', 400)
    }
    out.points_deduct_limit = lim
  }
  if (patch.min_points !== undefined) out.min_points = Math.max(0, Math.round(Number(patch.min_points)))
  if (patch.min_spent_yuan !== undefined) out.min_spent_yuan = Math.max(0, Number(patch.min_spent_yuan))
  if (patch.benefits !== undefined) out.benefits = patch.benefits == null ? null : String(patch.benefits)
  if (patch.sort_order !== undefined) out.sort_order = Math.round(Number(patch.sort_order))

  store.prepare(`
    UPDATE member_levels
       SET name=?, min_points=?, min_spent_yuan=?, discount_pct=?, points_rate=?,
           points_deduct_limit=?, benefits=?, sort_order=?
     WHERE code=?
  `).run(out.name, out.min_points, out.min_spent_yuan, out.discount_pct, out.points_rate,
    out.points_deduct_limit, out.benefits, out.sort_order, code)
  return store.prepare('SELECT * FROM member_levels WHERE code=?').get(code)
}

// ---------------------------------------------------------------------------
// 账户
// ---------------------------------------------------------------------------

export function ensureAccount(db, customerId) {
  const store = resolveDb(db)
  const cust = store.prepare('SELECT * FROM mall_customers WHERE id=?').get(customerId)
  if (!cust) throw bad(`商城客户不存在：customer#${customerId}`, 'CUSTOMER_NOT_FOUND', 404)
  let acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  if (acc) return acc
  store.prepare(`INSERT INTO member_accounts (customer_id, level_code) VALUES (?, 'normal')`).run(customerId)
  store.prepare("UPDATE mall_customers SET level_code='normal' WHERE id=?").run(customerId)
  acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  return acc
}

// ---------------------------------------------------------------------------
// 流水写入（**唯一**改动余额的入口）
//
// 三条都在一个事务里：写流水 → 改余额 → 复算相等。任一步失败整笔回滚。
// 把"复算相等"放进事务而不是留给测试，是因为漏写流水这类 bug 在业务上看不出来
// （余额对、只是没有来路），而它在半年后对账时才会爆出来。
// ---------------------------------------------------------------------------

function writePointsLedger(store, { customerId, kind, change, sourceType = null, source = null, sourceId = null, docNo = null, remark = null, baseCents = null }) {
  // **订单来源的流水必须带通道**（迁移 030）。放成"忘了就写 NULL"的后果不是报错，
  // 而是这条流水永远定位不到是哪张单 —— 撤单时找不到它、对账时看不出来。
  // 校验放在这个**唯一改余额的入口**上，调用方漏传当场红，不指望每个调用点都记得。
  if (sourceType === 'order' && sourceId != null && !source) {
    throw bad('订单来源的积分流水必须带 source（通道），否则无法定位到唯一一张单', 'SOURCE_REQUIRED', 400)
  }
  const acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  if (!acc) throw bad(`会员账户不存在：customer#${customerId}`, 'ACCOUNT_NOT_FOUND', 404)
  const after = Number(acc.points) + Number(change)
  if (after < 0) {
    throw bad(
      `积分不足：当前 ${acc.points}，本次变动 ${change}`,
      'POINTS_NOT_ENOUGH', 400,
      { points: acc.points, change: Number(change) }
    )
  }
  // points_total 只增不减：只有正向变动才累加（等级判定用，见口径 3）
  const totalDelta = Number(change) > 0 ? Number(change) : 0
  store.prepare(`
    UPDATE member_accounts
       SET points = ?, points_total = points_total + ?, updated_at = datetime('now','localtime')
     WHERE customer_id = ?
  `).run(after, totalDelta, customerId)
  store.prepare(`
    INSERT INTO member_points_ledger
      (customer_id, kind, change_points, balance_after_points, source_type, source, source_id, doc_no, remark, base_cents)
    VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(customerId, kind, Number(change), after, sourceType, source, sourceId, docNo, remark,
    baseCents == null ? null : Math.round(Number(baseCents) || 0))
  return after
}

function writeBalanceLedger(store, { customerId, kind, changeCents, sourceType = null, sourceId = null, docNo = null, remark = null }) {
  const acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  if (!acc) throw bad(`会员账户不存在：customer#${customerId}`, 'ACCOUNT_NOT_FOUND', 404)
  const after = Number(acc.balance_cents) + Number(changeCents)
  if (after < 0) {
    throw bad(
      `储值余额不足：当前 ${centsToYuan(acc.balance_cents)} 元，本次扣减 ${centsToYuan(-changeCents)} 元`,
      'BALANCE_NOT_ENOUGH', 400,
      { balance_cents: acc.balance_cents, change_cents: Number(changeCents) }
    )
  }
  store.prepare(`
    UPDATE member_accounts SET balance_cents = ?, updated_at = datetime('now','localtime')
     WHERE customer_id = ?
  `).run(after, customerId)
  store.prepare(`
    INSERT INTO member_balance_ledger
      (customer_id, kind, change_cents, balance_after_cents, source_type, source_id, doc_no, remark)
    VALUES (?,?,?,?,?,?,?,?)
  `).run(customerId, kind, Number(changeCents), after, sourceType, sourceId, docNo, remark)
  return after
}

/**
 * 账实自证：账户余额必须恒等于对应流水合计。
 * 只在「余额是派生值」这一处断言 —— 这正是本模块唯一需要自证的不变量。
 */
export function assertLedgerConsistent(store, customerId) {
  const acc = store.prepare('SELECT points, balance_cents FROM member_accounts WHERE customer_id=?').get(customerId)
  if (!acc) throw bad(`会员账户不存在：customer#${customerId}`, 'ACCOUNT_NOT_FOUND', 404)
  const p = store.prepare('SELECT COALESCE(SUM(change_points),0) AS s FROM member_points_ledger WHERE customer_id=?').get(customerId).s
  const b = store.prepare('SELECT COALESCE(SUM(change_cents),0) AS s FROM member_balance_ledger WHERE customer_id=?').get(customerId).s
  if (Number(acc.points) !== Number(p) || Number(acc.balance_cents) !== Number(b)) {
    throw bad(
      `会员账户与流水不一致（customer#${customerId}）：积分 ${acc.points} vs 流水 ${p}；储值 ${acc.balance_cents} vs 流水 ${b}`,
      'MEMBER_LEDGER_MISMATCH', 500,
      { points: acc.points, pointsLedger: p, balance_cents: acc.balance_cents, balanceLedger: b }
    )
  }
  return true
}

// ---------------------------------------------------------------------------
// 积分：获得 / 抵现 / 调整
// ---------------------------------------------------------------------------

/** 订单金额（分）能获得多少积分：基础 × 等级倍率 × 金额，向下取整 */
export function pointsForOrder(db, { orderAmountCents, levelCode = 'normal' }) {
  const store = resolveDb(db)
  const lv = store.prepare('SELECT * FROM member_levels WHERE code=?').get(levelCode)
  const rate = Number(lv?.points_rate ?? 100) / 100
  const yuan = Number(orderAmountCents) / 100
  // 向下取整：宁可少给一分，也不能多给 —— 多给的部分在对账时会被当成"凭空多出来的积分"。
  return Math.floor(yuan * pointsPerYuan(store) * rate)
}

/**
 * 消费获得积分，并累加累计消费额 + 触发等级重判。
 *
 * 幂等：同一笔订单重复调用（支付回调重试、运维重放）不会重复送分 ——
 * 以 `(customer_id, source_type='order', source_id=orderId)` 是否已有 earn 流水为准。
 * 这不是"以防万一"：没有这道闸，一次回调重试就会多送一份积分，
 * 而积分是能抵现的，等于凭空多给钱。
 *
 * @param orderAmountCents 订单金额（**分**）。销售/商城域传「元」时请先 `yuanToCents()`。
 */
export function earnPoints(db, { customerId, orderAmountCents, source = null, orderId = null, docNo = null, remark = null } = {}) {
  const store = resolveDb(db)
  if (orderId != null) {
    // 幂等判重必须带**通道**（迁移 030）：`oms_orders.id` 与 `pos_orders.id` 会撞号，
    // 只按 source_id 判重会让「另一张同号的单」被当成重复而**静默不送分**。
    const dup = store.prepare(
      "SELECT id FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND IFNULL(source,'')=? AND source_id=? AND kind='earn'"
    ).get(customerId, source ?? '', orderId)
    if (dup) {
      const acc0 = ensureAccount(store, customerId)
      return { points: acc0.points, earned: 0, skipped: 'duplicate', ledger_id: dup.id }
    }
  }
  const acc = ensureAccount(store, customerId)
  // 倍率取**本单成交时**的等级，不是升级后的等级 ——
  // 否则「这一单刚好把客户顶到金牌」会按金牌倍率补发，等于提前享受未达成的权益。
  const pts = pointsForOrder(store, { orderAmountCents, levelCode: acc.level_code })
  const tx = store.transaction(() => {
    // 累计消费先加，等级判定要用新值
    store.prepare(`
      UPDATE member_accounts SET total_spent_cents = total_spent_cents + ?, updated_at = datetime('now','localtime')
       WHERE customer_id = ?
    `).run(Number(orderAmountCents) || 0, customerId)
    let after = acc.points
    if (pts > 0) {
      after = writePointsLedger(store, {
        customerId, kind: POINTS_KIND.EARN, change: pts,
        sourceType: 'order', source, sourceId: orderId, docNo,
        // 把**本次计入累计消费的基数**一起记下来：撤单要靠它把钱退干净
        // （调用方再算一遍会漏掉运费 / 手工让利，且差多少完全看不出来）
        baseCents: orderAmountCents,
        remark: remark || `消费 ${centsToYuan(orderAmountCents)} 元获得（${LEVEL_LABEL[acc.level_code] ?? acc.level_code} 倍率）`
      })
    }
    const lvl = syncLevel(store, customerId)
    // 同步冗余的展示列，避免列表页出现「客户表说普通、账户表说金牌」
    store.prepare('UPDATE mall_customers SET level_code=? WHERE id=?').run(lvl.to, customerId)
    store.prepare("UPDATE mall_customers SET points=?, total_orders=total_orders+1, total_amount=total_amount+? WHERE id=?")
      .run(after, centsToYuan(orderAmountCents), customerId)
    assertLedgerConsistent(store, customerId)
    return { points: after, earned: pts, level: lvl }
  })
  return tx.immediate()
}

/**
 * 计算「这单最多能用多少积分抵现」。
 * 上限 = min(等级上限, 全局上限) 占订单额的万分比，再受两个现实约束收窄：
 *   · 不超过订单金额本身（不许越抵越多）
 *   · 不超过积分余额能换出的钱（不许把积分当钱刷）
 * 返回 { limitBp, maxPoints, maxCents }。
 */
export function pointsDeductQuote(db, { customerId, orderAmountCents } = {}) {
  const store = resolveDb(db)
  const acc = store.prepare('SELECT * FROM member_accounts WHERE customer_id=?').get(customerId)
  const levelCode = acc?.level_code ?? 'normal'
  const lv = store.prepare('SELECT * FROM member_levels WHERE code=?').get(levelCode)
  const lvBp = Number(lv?.points_deduct_limit ?? 0)
  const gBp = deductMaxBp(store)
  // 等级上限为 0 = 该等级不可抵现（普通会员就是这种），此时全局上限也不能把它放开 ——
  // 否则「谁能抵现」这件事会由全局配置决定，而等级权益表形同摆设。
  const bp = lvBp <= 0 ? 0 : Math.min(lvBp, gBp)
  const orderLimitCents = Math.floor((Number(orderAmountCents) || 0) * bp / 10000)
  const pointsAvailCents = pointsToCents(store, Number(acc?.points ?? 0))
  const maxCents = Math.max(0, Math.min(orderLimitCents, pointsAvailCents, Number(orderAmountCents) || 0))
  return {
    limitBp: bp,
    levelLimitBp: lvBp,
    globalLimitBp: gBp,
    maxPoints: centsToPoints(store, maxCents),
    maxCents
  }
}

/** 积分 → 分（向下取整，宁可少抵一分也不许多抵） */
export function pointsToCents(db, points) {
  const store = resolveDb(db)
  const need = pointsPerYuanDeduct(store)
  return Math.floor((Number(points) || 0) / need * 100)
}

/** 分 → 积分（向下取整） */
export function centsToPoints(db, cents) {
  const store = resolveDb(db)
  const need = pointsPerYuanDeduct(store)
  return Math.floor((Number(cents) || 0) / 100 * need)
}

/** 积分抵现：扣积分，返回实际抵扣的分 */
export function redeemPoints(db, { customerId, points, orderAmountCents = 0, source = null, orderId = null, docNo = null, remark = null } = {}) {
  const store = resolveDb(db)
  const want = Math.max(0, Math.floor(Number(points) || 0))
  if (!want) return { points: 0, cents: 0 }
  // 幂等：同一张单（**通道 + 单号**）只允许扣一次抵现积分。
  // 与 earnPoints 对称 —— 少了这道闸，一次支付回调重放就会把积分扣两遍，
  // 而客户只会看到"我的分少了"，看不出是哪一步重了。
  if (orderId != null) {
    const dup = store.prepare(
      "SELECT id FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND IFNULL(source,'')=? AND source_id=? AND kind='redeem'"
    ).get(customerId, source ?? '', orderId)
    if (dup) {
      return { points: want, cents: pointsToCents(store, want), skipped: 'duplicate', ledger_id: dup.id }
    }
  }
  const q = pointsDeductQuote(store, { customerId, orderAmountCents })
  if (q.maxPoints <= 0) {
    throw bad('该会员等级不支持积分抵现（或本单已无可抵额度）', 'DEDUCT_NOT_ALLOWED', 400, q)
  }
  if (want > q.maxPoints) {
    throw bad(
      `本次想抵 ${want} 分，超过上限 ${q.maxPoints} 分（本单最多抵 ${centsToYuan(q.maxCents)} 元）`,
      'DEDUCT_EXCEEDS_LIMIT', 400,
      { want, ...q }
    )
  }
  const tx = store.transaction(() => {
    writePointsLedger(store, {
      customerId, kind: POINTS_KIND.REDEEM, change: -want,
      sourceType: 'order', source, sourceId: orderId, docNo,
      remark: remark || `积分抵现 ${centsToYuan(pointsToCents(store, want))} 元`
    })
    assertLedgerConsistent(store, customerId)
    return redeemResult(store, customerId, want)
  })
  return tx.immediate()
}

// `writePointsLedger` 返回的是「变动后的余额」；兑换场景外部要的是「用了多少分」，
// 所以在外面包一层把语义讲清楚，避免调用方误把余额当成消耗量。
function redeemResult(store, customerId, spentPoints) {
  const acc = store.prepare('SELECT points FROM member_accounts WHERE customer_id=?').get(customerId)
  return { points: spentPoints, cents: pointsToCents(store, spentPoints), pointsLeft: acc.points }
}

/**
 * **撤单的积分回退**（A15）。
 *
 * 撤销一笔订单，积分上其实发生了**两件方向相反的事**，而旧实现只做了一件：
 *   ① 该单**赠送**的分要扣回（原来做了，但按可用余额封顶后没有回退累计口径）；
 *   ② 该单**抵现用掉**的分要**退回**给客户 —— 这一件原来完全没做。
 * 后果：客户撤单后**白丢一笔积分**，而且丢得没有任何痕迹。
 *
 * 还有第三件事，与积分表盘无关但对会员身份是硬伤：**累计消费要回退**。
 * `syncLevel` 是拿 `points_total` 与 `total_spent_cents` 判等级的 ——
 * 不回退的话，一笔 1 万元的订单撤掉之后，客户**仍然停在金牌**，
 * 下一单按金牌折扣结算。这笔折扣从账上完全看不出来是怎么来的。
 *
 * 幂等：以 `source_type='order_reverse'` + 通道 + 单号 是否已有流水为准。
 * 重复撤单（用户连点两次、接口重试）不会把积分退两遍。
 *
 * @param orderAmountCents 该单**已计入累计消费**的金额（分）。由调用方从单据读出 ——
 *        门店单是「元」，商城单也是「元」，统一在调用点换算，本函数只认分。
 */
export function reverseOrderPoints(db, { customerId, source, orderId, orderAmountCents = 0, reason = '订单取消' } = {}) {
  const store = resolveDb(db)
  if (customerId == null) return { skipped: 'no_customer' }
  if (orderId == null || !source) throw bad('撤单回退需要通道与单号', 'BAD_ARGS', 400)
  ensureAccount(store, customerId)

  const tx = store.transaction(() => {
    const done = store.prepare(
      "SELECT id FROM member_points_ledger WHERE customer_id=? AND source_type='order_reverse' AND IFNULL(source,'')=? AND source_id=?"
    ).get(customerId, source, orderId)
    if (done) {
      const acc0 = store.prepare('SELECT points FROM member_accounts WHERE customer_id=?').get(customerId)
      return { skipped: 'already_reversed', points_left: acc0.points, ledger_id: done.id }
    }

    const sum = (kind) =>
      Number(
        store
          .prepare(
            "SELECT COALESCE(SUM(change_points),0) s FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND IFNULL(source,'')=? AND source_id=? AND kind=?"
          )
          .get(customerId, source, orderId, kind).s
      )
    const earned = Math.max(0, sum(POINTS_KIND.EARN))          // 赠送（正数）
    const redeemed = Math.max(0, -sum(POINTS_KIND.REDEEM))     // 抵现消耗（取绝对值）

    // **回退多少累计消费，以"当初记了多少"为准**（`earn` 行上的 `base_cents`），
    // 而不是让调用方再算一遍。差别不是理论上的：含运费或手工让利的单，
    // 调用方按 `pay_amount` 反推会比实际计入的基数**多退一截**
    // （实测餐饮库差 1200 分 = 运费 12 元），于是客户撤单后累计消费被扣过头，
    // 会员等级迟迟掉不下来 —— 不报错，只是账不对。
    // 老数据没有 `base_cents`（迁移时留 NULL）时退回调用方给的名义金额。
    const loggedBase = Number(
      store
        .prepare(
          "SELECT COALESCE(SUM(base_cents),0) s FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND IFNULL(source,'')=? AND source_id=? AND kind='earn' AND base_cents IS NOT NULL"
        )
        .get(customerId, source, orderId).s
    )
    const hasLogged = Number(
      store
        .prepare(
          "SELECT COUNT(*) c FROM member_points_ledger WHERE customer_id=? AND source_type='order' AND IFNULL(source,'')=? AND source_id=? AND kind='earn' AND base_cents IS NOT NULL"
        )
        .get(customerId, source, orderId).c
    )

    // ① 先退抵现：这是客户的"钱"，优先级最高，且退回后余额变大，
    //    ② 的扣回才有余额可扣（否则会因为"客户已经花掉了"而扣不动）。
    let returned = 0
    if (redeemed > 0) {
      writePointsLedger(store, {
        customerId, kind: POINTS_KIND.ADJUST, change: redeemed,
        sourceType: 'order_reverse', source, sourceId: orderId,
        remark: `${reason}：退回订单抵现积分 ${redeemed} 分`
      })
      returned = redeemed
    }
    // ② 再扣回赠送。**按可用余额封顶，不假设客户还没花掉** ——
    //    扣不回来的差额如实报出去（shortfall），由业务决定补扣还是走坏账。
    const accNow = store.prepare('SELECT points, points_total, total_spent_cents FROM member_accounts WHERE customer_id=?').get(customerId)
    const claw = Math.min(earned, Math.max(0, Number(accNow.points)))
    if (claw > 0) {
      writePointsLedger(store, {
        customerId, kind: POINTS_KIND.ADJUST, change: -claw,
        sourceType: 'order_reverse', source, sourceId: orderId,
        remark: `${reason}：扣回订单赠送积分 ${claw} 分`
      })
    }
    // 两件都没发生（该单既没送分也没抵现）时也要留下**撤单标记**，
    // 否则幂等判据失去落点，重复撤单会反复走一遍流程。
    if (redeemed === 0 && claw === 0) {
      writePointsLedger(store, {
        customerId, kind: POINTS_KIND.ADJUST, change: 0,
        sourceType: 'order_reverse', source, sourceId: orderId,
        remark: `${reason}：本单无积分变动`
      })
    }

    // ③ 回退**累计消费**（等级判定的两个基数之一）——
    //    「这笔消费没发生过」，所以累计消费要退回去。**不动 `points_total`**：
    //    那是"历史累计获得"，撤单退回的抵现积分是"把之前扣掉的还回去"，
    //    不是新赚的；而 `auditMember` 的不变量正是「points_total ≥ 正变动之和」，
    //    把退回额计入累计获得会当场把它判成漂移（见下面的口径注）。
    const spent = hasLogged > 0 ? loggedBase : Math.max(0, Math.round(Number(orderAmountCents) || 0))
    store.prepare(`
      UPDATE member_accounts
         SET total_spent_cents = MAX(0, total_spent_cents - ?),
             updated_at = datetime('now','localtime')
       WHERE customer_id = ?
    `).run(spent, customerId)

    const lvl = syncLevel(store, customerId)
    const accEnd = store.prepare('SELECT points FROM member_accounts WHERE customer_id=?').get(customerId)
    // 冗余展示列同步（与 earnPoints 对称）：否则列表页会出现「客户表说金牌、账户表说普通」
    store.prepare(
      "UPDATE mall_customers SET points=?, total_orders=MAX(0, total_orders-1), total_amount=MAX(0, total_amount-?) WHERE id=?"
    ).run(accEnd.points, spent / 100, customerId)
    assertLedgerConsistent(store, customerId)
    return {
      points_returned: returned,
      points_clawed: -claw,
      points_shortfall: earned - claw,
      // 实际回退掉的累计消费（可能因触底而少于名义金额，如实报出）
      spent_reverted_cents: Math.min(Number(accNow.total_spent_cents) || 0, spent),
      level: lvl,
      points_left: accEnd.points
    }
  })
  return tx.immediate()
}

/** 人工调整积分。**必须写理由** —— 没有理由的调整等于没有账。 */
export function adjustPoints(db, { customerId, change, remark, actor = null } = {}) {
  const store = resolveDb(db)
  const delta = Math.trunc(Number(change) || 0)
  if (!delta) throw bad('调整积分不能为 0', 'BAD_ARGS', 400)
  if (!String(remark ?? '').trim()) {
    throw bad('人工调整积分必须写明理由（否则这笔调整在账上无法解释）', 'REMARK_REQUIRED', 400)
  }
  const tx = store.transaction(() => {
    const after = writePointsLedger(store, {
      customerId, kind: POINTS_KIND.ADJUST, change: delta,
      sourceType: 'manual',
      remark: withActor(remark, actor)
    })
    assertLedgerConsistent(store, customerId)
    return { points: after, change: delta }
  })
  return tx.immediate()
}

// ---------------------------------------------------------------------------
// 储值：充值 / 消费 / 退还
// ---------------------------------------------------------------------------

export function rechargeBalance(db, { customerId, amountCents, docNo = null, sourceId = null, remark = null } = {}) {
  const store = resolveDb(db)
  const cents = Math.trunc(Number(amountCents) || 0)
  if (cents <= 0) throw bad('充值金额必须大于 0', 'BAD_ARGS', 400)
  const tx = store.transaction(() => {
    const after = writeBalanceLedger(store, {
      customerId, kind: BALANCE_KIND.RECHARGE, changeCents: cents,
      sourceType: 'recharge', sourceId, docNo, remark: remark || '储值充值'
    })
    assertLedgerConsistent(store, customerId)
    return { balance_cents: after, amount_cents: cents }
  })
  return tx.immediate()
}

export function payByBalance(db, { customerId, amountCents, orderId = null, remark = null } = {}) {
  const store = resolveDb(db)
  const cents = Math.trunc(Number(amountCents) || 0)
  if (cents <= 0) throw bad('储值消费金额必须大于 0', 'BAD_ARGS', 400)
  const tx = store.transaction(() => {
    const after = writeBalanceLedger(store, {
      customerId, kind: BALANCE_KIND.PAY, changeCents: -cents,
      sourceType: 'order', sourceId: orderId, remark: remark || '储值支付'
    })
    assertLedgerConsistent(store, customerId)
    return { balance_cents: after, paid_cents: cents }
  })
  return tx.immediate()
}

export function refundToBalance(db, { customerId, amountCents, orderId = null, remark = null } = {}) {
  const store = resolveDb(db)
  const cents = Math.trunc(Number(amountCents) || 0)
  if (cents <= 0) throw bad('退还金额必须大于 0', 'BAD_ARGS', 400)
  const tx = store.transaction(() => {
    const after = writeBalanceLedger(store, {
      customerId, kind: BALANCE_KIND.REFUND, changeCents: cents,
      sourceType: 'order', sourceId: orderId, remark: remark || '订单退还'
    })
    assertLedgerConsistent(store, customerId)
    return { balance_cents: after, refund_cents: cents }
  })
  return tx.immediate()
}

/** 人工调整储值。同样必须写理由。 */
export function adjustBalance(db, { customerId, changeCents, remark, actor = null } = {}) {
  const store = resolveDb(db)
  const delta = Math.trunc(Number(changeCents) || 0)
  if (!delta) throw bad('调整储值不能为 0', 'BAD_ARGS', 400)
  if (!String(remark ?? '').trim()) {
    throw bad('人工调整储值必须写明理由', 'REMARK_REQUIRED', 400)
  }
  const tx = store.transaction(() => {
    const after = writeBalanceLedger(store, {
      customerId, kind: BALANCE_KIND.ADJUST, changeCents: delta,
      sourceType: 'manual',
      remark: withActor(remark, actor)
    })
    assertLedgerConsistent(store, customerId)
    return { balance_cents: after, change_cents: delta }
  })
  return tx.immediate()
}

// ---------------------------------------------------------------------------
// 查询与对账
// ---------------------------------------------------------------------------

export function listAccounts(db, { keyword = null, levelCode = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const where = []
  const params = []
  if (levelCode) { where.push('v.level_code = ?'); params.push(levelCode) }
  if (keyword) { where.push('(v.phone LIKE ? OR v.name LIKE ?)'); params.push(`%${keyword}%`, `%${keyword}%`) }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const total = store.prepare(`SELECT COUNT(*) AS c FROM v_member_overview v ${clause}`).get(...params).c
  const off = (Math.max(1, page) - 1) * pageSize
  const list = store.prepare(`
    SELECT v.*, a.created_at
      FROM v_member_overview v
      LEFT JOIN member_accounts a ON a.id = v.account_id
      ${clause}
     ORDER BY v.total_spent_cents DESC, v.customer_id ASC
     LIMIT ? OFFSET ?
  `).all(...params, pageSize, off)
  return { list, total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1 }
}

export function getMemberDetail(db, customerId) {
  const store = resolveDb(db)
  const acc = ensureAccount(store, customerId)
  const v = store.prepare('SELECT * FROM v_member_overview WHERE customer_id=?').get(customerId)
  const levels = listLevels(store)
  const cur = levels.findIndex((l) => l.code === acc.level_code)
  const next = cur >= 0 && cur < levels.length - 1 ? levels[cur + 1] : null
  const coupons = store.prepare(`
    SELECT ci.*, c.name AS coupon_name, c.code AS template_code, c.type, c.value, c.min_subtotal
      FROM coupon_instances ci JOIN coupons c ON c.id = ci.coupon_id
     WHERE ci.customer_id = ? ORDER BY ci.status='unused' DESC, ci.id DESC LIMIT 50
  `).all(customerId)
  return {
    overview: v,
    account: acc,
    level: levels.find((l) => l.code === acc.level_code) ?? null,
    next_level: next,
    // 到下一级还差多少：两个门槛分别给，因为它是"与"关系 ——
    // 只显示一个会让客户以为满足了就能升级
    gap: next
      ? {
          points: Math.max(0, Number(next.min_points) - Number(acc.points_total)),
          spent_yuan: Math.max(0, Number(next.min_spent_yuan) - centsToYuan(acc.total_spent_cents))
        }
      : null,
    deduct_quote: pointsDeductQuote(store, { customerId, orderAmountCents: 0 }),
    coupons
  }
}

export function listPointsLedger(db, { customerId = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const util = ledgerLister(store, 'member_points_ledger', 'change_points', 'balance_after_points', POINTS_KIND_LABEL)
  return util({ customerId, page, pageSize })
}

export function listBalanceLedger(db, { customerId = null, page = 1, pageSize = 20 } = {}) {
  const store = resolveDb(db)
  const util = ledgerLister(store, 'member_balance_ledger', 'change_cents', 'balance_after_cents', BALANCE_KIND_LABEL)
  return util({ customerId, page, pageSize })
}

// 两本流水的查询完全同构，抽出来共用；字段名用参数传，避免写两遍还要维护两份
function ledgerLister(store, table, changeCol, afterCol, labelMap) {
  return ({ customerId = null, page = 1, pageSize = 20 } = {}) => {
    const where = customerId ? 'WHERE l.customer_id = ?' : ''
    const params = customerId ? [customerId] : []
    const total = store.prepare(`SELECT COUNT(*) AS c FROM ${table} l ${where}`).get(...params).c
    const off = (Math.max(1, page) - 1) * pageSize
    const list = store.prepare(`
      SELECT l.*, c.phone, c.name AS customer_name
        FROM ${table} l
        LEFT JOIN mall_customers c ON c.id = l.customer_id
        ${where}
       ORDER BY l.id DESC LIMIT ? OFFSET ?
    `).all(...params, pageSize, off)
    return {
      list: list.map((r) => ({ ...r, kind_label: labelMap[r.kind] ?? r.kind })),
      total, page, pageSize, totalPages: Math.ceil(total / pageSize) || 1,
      change_col: changeCol, after_col: afterCol
    }
  }
}

/**
 * 全库会员对账：账户余额 ≠ 流水合计 的账户清单。
 * `verify-seed.mjs` 与测试都调它 —— 把"余额是派生值"这条口径变成可断言的不变量。
 */
export function auditMember(db) {
  const store = resolveDb(db)
  const rows = store.prepare(`
    SELECT a.customer_id,
           a.points, a.balance_cents, a.points_total,
           COALESCE((SELECT SUM(change_points) FROM member_points_ledger  p WHERE p.customer_id = a.customer_id), 0) AS points_ledger,
           COALESCE((SELECT SUM(change_cents)  FROM member_balance_ledger b WHERE b.customer_id = a.customer_id), 0) AS balance_ledger,
           -- 累计获得 = 正变动之和，但排除撤单回退（source_type='order_reverse'）：
           -- 撤单退回的抵现积分是"把之前扣掉的还回去"，不是新赚的，也不进 points_total。
           -- 不排除的话，一次撤单就会把「points_total >= 正变动之和」这条不变量判成漂移。
           COALESCE((SELECT SUM(CASE WHEN change_points > 0 THEN change_points ELSE 0 END)
                       FROM member_points_ledger p
                      WHERE p.customer_id = a.customer_id
                        AND IFNULL(p.source_type,'') <> 'order_reverse'), 0) AS points_earned
      FROM member_accounts a
  `).all()
  const mismatch = rows.filter((r) =>
    Number(r.points) !== Number(r.points_ledger) || Number(r.balance_cents) !== Number(r.balance_ledger))
  // `points_total`（累计积分）只增，但**不要求等于「正变动之和」**：
  // `setMemberLevel` 人工改级时会把累计门槛抬到达标线（见该函数注释 —— 否则下
  // 一单送分就会被自动判定冲回原等级），这是一次**没有流水支撑的抬高**。
  // 所以这里的口径是「不低于」：低于流水累计说明有正向变动没被累加，那才是异常。
  const totalDrift = rows.filter((r) => Number(r.points_total) < Number(r.points_earned))
  // 余额为负是无论如何都不该出现的
  const negative = rows.filter((r) => Number(r.points) < 0 || Number(r.balance_cents) < 0)
  return {
    accounts: rows.length,
    mismatch,
    totalDrift,
    negative,
    balanced: mismatch.length === 0 && totalDrift.length === 0 && negative.length === 0
  }
}

/** 券张数按状态汇总（会员详情页用；口径与视图里那两个子查询一致） */
export function couponStat(db, customerId) {
  const store = resolveDb(db)
  return store.prepare(`
    SELECT status, COUNT(*) AS c, COALESCE(SUM(used_amount),0) AS amt
      FROM coupon_instances WHERE customer_id=? GROUP BY status
  `).all(customerId)
}

export default {
  POINTS_KIND, BALANCE_KIND, POINTS_KIND_LABEL, BALANCE_KIND_LABEL, LEVEL_LABEL,
  yuanToCents, centsToYuan,
  listLevels, levelOf, syncLevel, setMemberLevel, updateLevel, ensureAccount,
  pointsForOrder, earnPoints, pointsDeductQuote, pointsToCents, centsToPoints, redeemPoints, adjustPoints,
  reverseOrderPoints,
  rechargeBalance, payByBalance, refundToBalance, adjustBalance,
  listAccounts, getMemberDetail, listPointsLedger, listBalanceLedger,
  auditMember, assertLedgerConsistent, couponStat
}
