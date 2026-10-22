/**
 * ============================================================================
 * 文件标识：server/db/pricing-seed.js ｜ 价格组演示数据：四维自由组合的价格本
 * ============================================================================
 * 【职责】价格组演示数据：四维自由组合的价格本
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 价格组演示数据：四维自由组合的价格本
//
// 刻意造出「宽组合 + 细组合」并存的场景，用来验证取价引擎的匹配度打分：
//   华东金牌经销商 同时命中「经销商金牌价」(2维) 与「华东金牌经销商专价」(3维)，
//   引擎应取更具体的那个 —— 这是「不设主维」能否成立的关键。

import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow } from './seed-clock.js'

const GROUPS = [
  // code, 名称, 渠道, 门店类型, 经销商等级, 区域, priority, 相对零售价系数, 备注
  ['PG_ONLINE',    '线上渠道价',       'online',    null,       null,     null,   60, 0.95, '电商渠道统一定价'],
  ['PG_COUNTER',   '专柜价',           null,        'counter',  null,     null,   60, 1.05, '专柜服务溢价'],
  ['PG_DIRECT',    '直营门店价',       'direct',    null,       null,     null,   60, 0.98, '直营体系统一价'],
  ['PG_FRANCHISE', '加盟店供货价',     'franchise', null,       null,     null,   50, 0.75, '加盟店是独立主体，按供货价结算'],
  ['PG_DEALER_SILVER', '经销商银牌价', 'dealer',    null,       'silver', null,   40, 0.70, '银牌经销商'],
  ['PG_DEALER_GOLD',   '经销商金牌价', 'dealer',    null,       'gold',   null,   40, 0.62, '金牌经销商'],
  ['PG_EC_GOLD',   '华东金牌经销商专价', 'dealer',  null,       'gold',   '华东', 30, 0.58, '更具体的组合，优先级高于通用金牌价']
]

const LADDER = [
  // 金牌经销商满 100 件再降 3 个点
  { groupCode: 'PG_DEALER_GOLD', minQty: 100, factor: 0.59 }
]

function nowStr() {
  return seedNow().toISOString().slice(0, 19).replace('T', ' ')
}

export function seedPricing(db, { industry = 'cosmetic', silent = false, log } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) (log ? log(m) : console.log(m)) }
  const skus = db.prepare('SELECT id, price_retail, price_dealer, price_member FROM product_skus WHERE status=\'active\'').all()
  if (!skus.length) { say('[pricing] 无 SKU，跳过'); return { groups: 0, items: 0 } }

  const insGroup = db.prepare(`
    INSERT INTO price_groups (code, name, channel, store_type, dealer_level, region, priority, status, remark)
    VALUES (?,?,?,?,?,?,?,'active',?)
    ON CONFLICT(code) DO UPDATE SET name=excluded.name, channel=excluded.channel,
      store_type=excluded.store_type, dealer_level=excluded.dealer_level, region=excluded.region,
      priority=excluded.priority, remark=excluded.remark
  `)
  const getGroup = db.prepare('SELECT id, code FROM price_groups WHERE code=?')
  const insItem = db.prepare(`
    INSERT INTO price_group_items (group_id, sku_id, price, min_qty) VALUES (?,?,?,?)
    ON CONFLICT(group_id, sku_id, min_qty) DO UPDATE SET price=excluded.price
  `)

  let itemCount = 0
  for (const [code, name, ch, st, dl, rg, prio, factor, remark] of GROUPS) {
    insGroup.run(code, name, ch, st, dl, rg, prio, remark)
    const g = getGroup.get(code)
    for (const s of skus) {
      const base = Number(s.price_retail || 0) || 100
      insItem.run(g.id, s.id, Number((base * factor).toFixed(2)), 1)
      itemCount += 1
    }
    for (const l of LADDER.filter((x) => x.groupCode === code)) {
      for (const s of skus) {
        const base = Number(s.price_retail || 0) || 100
        insItem.run(g.id, s.id, Number((base * l.factor).toFixed(2)), l.minQty)
        itemCount += 1
      }
    }
  }

  // 会员价：普通会员 95 折、金卡会员 88 折（会员中心未上线，先建基础两档）
  const insMember = db.prepare(`
    INSERT INTO member_prices (sku_id, member_level, price) VALUES (?,?,?)
    ON CONFLICT(sku_id, member_level) DO UPDATE SET price=excluded.price
  `)
  for (const s of skus) {
    const base = Number(s.price_retail || 0) || 100
    insMember.run(s.id, 'normal', Number((base * 0.95).toFixed(2)))
    insMember.run(s.id, 'gold', Number((base * 0.88).toFixed(2)))
  }

  const total = db.prepare('SELECT COUNT(*) c FROM price_groups').get().c
  const items = db.prepare('SELECT COUNT(*) c FROM price_group_items').get().c
  say(`[pricing:${industry}] 价格组 ${total} 个 / 明细 ${items} 条 / 覆盖 SKU ${skus.length} 个`)
  return { groups: total, items, skus: skus.length }
}

export default { seedPricing, GROUPS }
