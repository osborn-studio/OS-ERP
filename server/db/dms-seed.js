/**
 * ============================================================================
 * 文件标识：server/db/dms-seed.js ｜ 渠道协议价与返利核销的演示数据（批次 G · 模块 26）
 * ============================================================================
 * 【职责】渠道协议价与返利核销的演示数据（批次 G · 模块 26）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 渠道协议价与返利核销的演示数据（批次 G · 模块 26）
//
// ============================================================================
// 一、为什么必须专门造数
// ============================================================================
// 协议价与返利都有同一个特征：**空的时候和"没配好"的时候长得一模一样**。
//   协议价列表空着 → 看不出是"没有协议"还是"协议没生效"（周期不对 / 优先级被压）；
//   返利页全是 0 → 看不出是"这期没卖出去"还是"政策一条都没匹配上"。
// 所以这里刻意造出每一种形态，让每个非退化指标都至少有一个非零样本：
//
//   | 要看见的东西 | 样本 |
//   | --- | --- |
//   | 定点定价（指定 SKU） | 一家签了 3 个 SKU 的固定价 |
//   | 品类折扣（整类 88 折） | 一家签了某个二级品类的万分比折扣 |
//   | 起订量门槛 | 一条 `min_qty=5` 的协议（低于它不适用） |
//   | 优先级裁决 | 同一家同一 SKU 同时有"全部商品"与"指定 SKU"两份协议 |
//   | 已失效样本 | 一条周期已经过去的协议（列表里能看到"已过期"） |
//   | 返利：待核算 / 已确认 / 已核销 | 三期数据，三种状态各留一条 |
//   | 返利：冲减 + 未冲减 | 一次核销里**应收不够冲**，如实留下 `unoffset_amount` |
//   | 返利：未命中 | 一条政策命中但金额为 0（阶梯没够到） |
//
// ============================================================================
// 二、两条造数纪律（本项目踩过的坑，写在这里防止回退）
// ============================================================================
// 1) **一律走服务函数，不手工 INSERT 业务行。**
//    协议价用 `agreement.createAgreement`、返利用 `rebate.accrueRebates` +
//    `settleRebates` —— 与界面点击完全同一条代码路径。
//    手工 INSERT 最容易漏派生列（核销单的 `ar_offset_amount`、协议的
//    `discount_bp` 默认值），而漏掉的表现是"核销单金额对、但应收没动"这类
//    完全看不出原因的现象。
//
// 2) **金额不写死，从真实售价与等级门槛推导（行业比例化）。**
//    三个行业的客单价差一个数量级（美妆约 400 元、餐饮约 28 元、服饰约 994 元）。
//    写死"协议价 300 元"到餐饮库就是一个荒谬的价格，到服饰库又小到看不出折扣。
//    所以协议价一律从 `product_skus.price_retail` **读出来**再乘一个比例。

// `seed.js` 的确定性随机与灌数时钟（`R` 取一个、`PICK` 取 n 个）——
// **只能用这一套**：seed 路径上出现 SQLite 的 `ORDER BY RANDOM()` 会让重建不可复现。
import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow, R, PICK } from './seed.js'
// 「可售商品」的判据（排除原料/包材 + 必须有零售价）只在一处实现
import { sellableSkus } from '../lib/catalog.js'
import * as A from '../lib/agreement.js'
// 返利：`R` 已被随机数占用，这里用 `RB`。
import * as RB from '../lib/rebate.js'

const ymd = (d) => d.toISOString().slice(0, 10)
const shift = (d, days) => new Date(d.getTime() + days * 86400000)
const round2 = (n) => Number(Number(n || 0).toFixed(2))

export function seedDms(db, { silent = true } = {}) {
  requireDemoDatabase(db)
  const log = silent ? () => {} : (...a) => console.log('  [dms]', ...a)

  // 幂等：库里已有协议就整段跳过。
  // satellite 每次服务启动都会跑一遍，而演示现场真点出来的协议必须留住。
  if (db.prepare('SELECT COUNT(*) AS c FROM price_agreements').get().c > 0) {
    log('已存在协议价数据，跳过')
    return { skipped: true }
  }

  const base = seedNow()
  const dealers = db.prepare("SELECT * FROM dealers WHERE status='active' ORDER BY id").all()
  // 取样必须排除**原料 / 包材**（零售价为 0）：协议价是"谈出来的销售价"，
  // 对它们定价没有业务含义，而 `round2(price_retail * 0.82)` 会算成 0 →
  // `createAgreement` 直接拒（定价型协议必须给协议单价），整个 seed 挂在这里。
  // 判据在 `lib/catalog.js` 一处实现 —— 这里原先自己写了一份，漏了排除原料。
  const skus = sellableSkus(db, { limit: 40 })
  if (!dealers.length || !skus.length) {
    log('没有经销商或 SKU，跳过')
    return { skipped: true, reason: 'no_dealer_or_sku' }
  }
  const y = base.getFullYear()
  const period = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}`

  let agreements = 0
  const made = []

  // ---------- 1. 协议价：四种形态各一条（挑前三家经销商，互不干扰） ----------
  // 核销演示要**两种形态都出现**：「冲掉了」与「应收不够冲」。
  // 只挑前几家的话，若它们的应收恰好已结清，核销单会全是"未冲减" ——
  // 演示现场看到的是「返利核销了但账上一分没动」，反而像功能坏了。
  // 所以核销对象里额外加一家**当前有未核销应收余额**的经销商。
  const richDealer = db
    .prepare(`
      SELECT subject_id AS id, ROUND(SUM(amount - allocated_amount), 2) AS open_amt
        FROM ar_documents
       WHERE subject_type='dealer' AND status<>'voided' AND amount - allocated_amount > 0.005
       GROUP BY subject_id ORDER BY open_amt DESC LIMIT 1
    `)
    .get()
  const richDealerRow = richDealer
    ? db.prepare("SELECT * FROM dealers WHERE id=? AND status='active'").get(Number(richDealer.id))
    : null

  const [dA, dB, dC] = dealers
  // ① 定点定价：指定 3 个 SKU，按零售价的 82% 定死
  const pickA = PICK(skus, 3)
  for (const s of pickA) {
    A.createAgreement(db, {
      // 编码留空 → 由 `nextAgreementCode` 生成「XY + 年 + 4 位序号」，
      // 与界面新建走同一条路径（自己编一个码会让"序号规则"在 seed 里失效）
      code: '',
      name: `${dA.name}·定点协议价（${s.name}）`,
      dealer_id: dA.id,
      target_type: 'sku',
      target_id: s.id,
      price_type: 'fixed',
      price: round2(Number(s.price_retail) * 0.82),
      min_qty: 1,
      effect_from: ymd(shift(base, -60)),
      effect_to: ymd(shift(base, 305)),
      priority: 10,
      remark: '演示样本：指定 SKU 的固定协议价'
    }, { name: 'seed', id: null })
    agreements += 1
  }

  // ② 品类折扣：找一个真有商品的二级品类，整类 88 折
  const cat = db
    .prepare(`
      SELECT p.category_id AS id, c.name, COUNT(*) AS n
        FROM products p JOIN categories c ON c.id = p.category_id
       WHERE p.status='active' GROUP BY p.category_id ORDER BY n DESC LIMIT 1
    `)
    .get()
  if (cat?.id) {
    A.createAgreement(db, {
      code: '',
      name: `${dB.name}·${cat.name}品类协议（88 折）`,
      dealer_id: dB.id,
      target_type: 'category',
      target_id: cat.id,
      price_type: 'discount',
      price: 0,
      discount_bp: 8800,
      min_qty: 1,
      effect_from: ymd(shift(base, -30)),
      effect_to: ymd(shift(base, 335)),
      priority: 20,
      remark: '演示样本：整类折扣型协议（在标准零售价上打折）'
    }, { name: 'seed', id: null })
    agreements += 1
  }

  // ③ 起订量门槛 + ④ 优先级裁决：同一家同时有"全部商品"与"指定 SKU"两份
  const pickC = R(skus)
  A.createAgreement(db, {
    code: '',
    name: `${dC.name}·全部商品协议（93 折 / 起订 5 件）`,
    dealer_id: dC.id,
    target_type: 'all',
    target_id: null,
    price_type: 'discount',
    price: 0,
    discount_bp: 9300,
    min_qty: 5,
    effect_from: ymd(shift(base, -20)),
    effect_to: ymd(shift(base, 345)),
    priority: 90,
    remark: '演示样本：起订量门槛（低于 5 件不适用）'
  }, { name: 'seed', id: null })
  A.createAgreement(db, {
    code: '',
    name: `${dC.name}·爆品单独议价（定点 / 优先）`,
    dealer_id: dC.id,
    target_type: 'sku',
    target_id: pickC.id,
    price_type: 'fixed',
    price: round2(Number(pickC.price_retail) * 0.75),
    min_qty: 1,
    effect_from: ymd(shift(base, -20)),
    effect_to: ymd(shift(base, 345)),
    priority: 5,
    remark: '演示样本：与「全部商品协议」并存，按 priority 裁决（数字小者优先）'
  }, { name: 'seed', id: null })
  agreements += 2

  // ⑤ 已失效样本：周期已经过去，列表里能看到"已过期"而不是"没配"
  A.createAgreement(db, {
    code: '',
    name: `${dA.name}·上季度档期协议（已到期）`,
    dealer_id: dA.id,
    target_type: 'all',
    target_id: null,
    price_type: 'discount',
    price: 0,
    discount_bp: 9500,
    min_qty: 1,
    effect_from: ymd(shift(base, -200)),
    effect_to: ymd(shift(base, -100)),
    priority: 80,
    remark: '演示样本：已过期的协议（不参与取价）'
  }, { name: 'seed', id: null })
  agreements += 1
  log(`协议价 ${agreements} 条`)

  // ---------- 2. 返利政策：三种形态（有一家能命中、有一家够不到） ----------
  const policies = [
    {
      code: 'RB_SEED_TIER', name: '演示·阶梯比例返点（按净销售）', type: 'tiered',
      basis: 'net', priority: 10,
      rules: { tiers: [{ min: 0, rate: 0.5 }, { min: 5000, rate: 1.2 }, { min: 20000, rate: 2 }] },
      remark: '演示样本：净销售落在哪个阶梯就取哪一档费率'
    },
    {
      code: 'RB_SEED_PAY', name: '演示·回款达标返点', type: 'payback',
      basis: 'net', priority: 20,
      rules: { rate: 0.8, payRatio: 0.3 },
      remark: '演示样本：回款率门槛（演示门槛取 30%，真实场景按合同）'
    },
    {
      code: 'RB_SEED_UNIT', name: '演示·按件定额返点', type: 'fixed_per_unit',
      basis: 'net', priority: 30,
      rules: { perUnit: Math.max(0.5, round2(Number(skus[0].price_retail) * 0.004)) },
      remark: '演示样本：按进货件数定额（单价按行业比例化推导，不写死）'
    }
  ]
  for (const p of policies) {
    if (db.prepare('SELECT 1 AS h FROM rebate_policies WHERE code=?').get(p.code)) continue
    db.prepare(`
      INSERT INTO rebate_policies (code,name,type,dealer_level,channel_type,period,basis,rules,rebate_cap,priority,status,remark)
      VALUES (?,?,?,'all','all',NULL,?,?,0,?,'active',?)
    `).run(p.code, p.name, p.type, p.basis, JSON.stringify(p.rules), p.priority, p.remark)
  }
  log(`返利政策 ${policies.length} 条`)

  // ---------- 3. 返利：计提 → 确认 → 核销，三期三种状态 ----------
  //
  // 期别一律按**灌数时钟**倒推（最近三个月），不写死月份 ——
  // 写死的话，任何一个月之后重建，演示数据里"最近三个月"就全空了。
  const periods = [0, 1, 2].map((i) => {
    const d = new Date(base.getFullYear(), base.getMonth() - i, 1)
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  })
  const actor = { id: null, name: '演示灌数' }
  let accrued = 0
  let settled = 0
  let unoffsetSeen = 0

  // 计提对象：前 3 家（用于协议价演示）+ 有未核销应收的那一家
  const rebateDealers = dealers.slice(0, 3)
  if (richDealerRow && !rebateDealers.some((d) => d.id === richDealerRow.id)) rebateDealers.push(richDealerRow)

  for (const [i, p0] of periods.entries()) {
    for (const d of rebateDealers) {
      let out
      try {
        out = RB.accrueRebates(db, { dealerId: d.id, period: p0, actor })
      } catch (e) {
        // 期间格式/无政策等都不该让整段 seed 挂掉：如实记一条，继续造别的样本
        log(`计提跳过 ${d.name} ${p0}：${e.message}`)
        continue
      }
      accrued += out.created + out.updated
      // 最新一期留在 pending（演示"待核算"）；上两期推送确认
      if (i > 0 && out.lines.length) {
        for (const l of out.lines) {
          try { RB.confirmRebate(db, { id: l.id, actor, remark: '演示：期间已关账，确认入账' }) } catch { /* 已确认 */ }
        }
      }
    }
  }

  // 最老那一期做一次**完整核销**：冲应收 → 写核销单 → 回写。
  // 用最老一期是因为它最可能已经把应收核销掉了 —— 于是"应收不够冲"的
  // `unoffset_amount` 也会真实出现，正好演示"未冲减如实登记"这条口径。
  const oldest = periods[periods.length - 1]
  const settledDealers = []
  for (const d of rebateDealers) {
    try {
      const s = RB.settleRebates(db, { dealerId: d.id, period: oldest, actor, remark: `演示：${oldest} 返利核销` })
      settled += 1
      if (Number(s.unoffset_amount) > 0) unoffsetSeen += 1
      settledDealers.push(`${d.code} ${s.doc_no} 冲${s.ar_offset_amount}/未冲${s.unoffset_amount}`)
    } catch (e) {
      log(`核销跳过 ${d.name} ${oldest}：${e.message}`)
    }
  }

  const audit = RB.auditRebate(db)
  log(`返利计提 ${accrued} 行 / 核销单 ${settled} 张${unoffsetSeen ? `（其中 ${unoffsetSeen} 张有未冲减）` : ''} / 自证 ${audit.balanced ? 'ok' : 'FAIL'}`)

  return {
    skipped: false,
    agreements,
    policies: policies.length,
    accrued,
    settled,
    unoffset_seen: unoffsetSeen,
    audit,
    settled_dealers: settledDealers
  }
}

export default { seedDms }
