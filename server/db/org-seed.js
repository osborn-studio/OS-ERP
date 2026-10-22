/**
 * ============================================================================
 * 文件标识：server/db/org-seed.js ｜ 组织主体初始化：四层主体（总部 → 区域 → 门店 → 仓库/央厨）+ 货主绑定 + 存量回填
 * ============================================================================
 * 【职责】组织主体初始化：四层主体（总部 → 区域 → 门店 → 仓库/央厨）+ 货主绑定 + 存量回填
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 组织主体初始化：四层主体（总部 → 区域 → 门店 → 仓库/央厨）+ 货主绑定 + 存量回填
//
// 口径来源（第三轮）：
//   B1 四层主体：总部 → 区域 → 门店 → 仓/中央厨房
//   B2 加盟店是**独立主体**：自有货主、独立账
//   B3 中央厨房归总部（仓库 + 生产车间性质，不独立核算）
//   3.1 跨地区：含中国香港门店 → 多币种（CNY/HKD）+ 多税区
//   第二轮 3：餐饮多品牌，品牌要贯穿组织而非只贴商品标签
//
// 为什么必须独立成文件：
//   orgs 是模块 03（货主）、04（权限）、07/08（审批范围）、22（审批流）的共同前置。
//   新库 seed 时自动建；老库（美妆/服装）可在不重灌数据的前提下单独补组织并回填货主。

import { requireDemoDatabase } from './runtime-policy.js'
import { seedNow } from './seed-clock.js'

const INDUSTRY_TREES = {
  cosmetic: {
    group: { code: 'ORG_HQ', name: '演示美妆连锁总部', short: '总部', region: '华东' },
    regions: [
      {
        code: 'ORG_RG_EC', name: '华东大区', region: '华东',
        warehouses: [
          { match: 'WH01', role: 'central' },   // 上海中心总仓
          { match: 'WH03', role: 'ecom' }       // 电商云仓
        ],
        stores: ['ST001', 'ST002', 'ST003', 'ST004', 'ST005']
      },
      {
        code: 'ORG_RG_SC', name: '华南大区', region: '华南',
        warehouses: [{ match: 'WH02', role: 'region' }],  // 广州区域仓
        stores: []
      }
    ]
  },
  food: {
    group: { code: 'ORG_HQ', name: '演示连锁餐饮总部', short: '总部', region: '华东' },
    // 央厨（第三轮 B3）：总部下的仓库 + 生产车间，不独立核算。
    // warehouses 里的仓挂央厨组织，但 owner_org_id 归总部（央厨的货是总部的产权）。
    kitchen: { code: 'ORG_CK', name: '中央厨房', region: '华东', warehouses: ['WH90'] },
    // 20 家门店 = 直营 15 + 加盟 5；跨 6 个区域，含中国香港
    regions: [
      {
        code: 'ORG_RG_EC', name: '华东区域', region: '华东',
        warehouses: [
          { match: 'WH01', role: 'central' },
          { match: 'WH03', role: 'ecom' }
        ],
        stores: ['ST001', 'ST002', 'ST003', 'ST004', 'ST005', 'ST006', 'ST007', 'ST008', 'ST009', 'ST017']
      },
      {
        code: 'ORG_RG_NC', name: '华北区域', region: '华北',
        warehouses: [],
        stores: ['ST010', 'ST011', 'ST012']
      },
      {
        code: 'ORG_RG_SC', name: '华南区域', region: '华南',
        warehouses: [{ match: 'WH02', role: 'region' }],
        stores: ['ST013', 'ST014']
      },
      {
        code: 'ORG_RG_SW', name: '西南区域', region: '西南',
        warehouses: [],
        stores: ['ST015', 'ST016']
      },
      {
        code: 'ORG_RG_CN', name: '华中区域', region: '华中',
        warehouses: [],
        stores: ['ST018']
      },
      {
        code: 'ORG_RG_HK', name: '中国香港区域', region: '中国香港',
        warehouses: [],
        stores: ['ST019', 'ST020']
      }
    ]
  },
  apparel: {
    group: { code: 'ORG_HQ', name: '演示服装总部', short: '总部', region: '华东' },
    regions: [{ code: 'ORG_RG_EC', name: '华东大区', region: '华东', warehouses: [{ match: 'WH01', role: 'central' }], stores: ['ST001', 'ST002', 'ST003', 'ST004', 'ST005'] }]
  }
}

function nowStr() {
  return seedNow().toISOString().slice(0, 19).replace('T', ' ')
}
/** 幂等建组织节点，返回 id（已存在则复用并校正父子关系） */
function upsertOrg(db, { code, name, short, type, parentId = null, isLegal = 0, currency = 'CNY', region = null, taxRegion = null, brandId = null, ownerOrgId = null }) {
  const existing = db.prepare('SELECT id FROM orgs WHERE code=?').get(code)
  if (existing) {
    db.prepare(
      `UPDATE orgs SET name=?, short_name=?, type=?, parent_id=?, is_legal=?, currency=?, region=?, tax_region=?, brand_id=?, status='active'
       WHERE id=?`
    ).run(name, short || name, type, parentId, isLegal, currency, region, taxRegion, brandId, existing.id)
    return existing.id
  }
  const info = db
    .prepare(
      `INSERT INTO orgs (code, name, short_name, type, parent_id, level, path, is_legal, owner_org_id, currency, region, tax_region, brand_id, status, created_at)
       VALUES (?,?,?,?,?,1,'',?,?,?,?,?,?,'active',?)`
    )
    .run(code, name, short || name, type, parentId, isLegal, ownerOrgId, currency, region, taxRegion, brandId, nowStr())
  return Number(info.lastInsertRowid)
}

/** 重算 level 与 path（path 依赖 id，必须插入后回填） */
function rebuildPaths(db) {
  const rows = db.prepare('SELECT id, parent_id FROM orgs').all()
  const byId = new Map(rows.map((r) => [r.id, r]))
  const upd = db.prepare('UPDATE orgs SET level=?, path=? WHERE id=?')
  const seen = new Set()

  function resolve(id) {
    if (seen.has(id)) return byId.get(id).path || '/'
    const node = byId.get(id)
    if (!node) return '/'
    seen.add(id)
    let parentPath = '/'
    let level = 1
    if (node.parent_id != null && byId.has(node.parent_id)) {
      const p = byId.get(node.parent_id)
      const pp = resolve(node.parent_id)
      parentPath = pp.endsWith('/') ? pp : pp + '/'
      level = (p.level || 1) + 1
    }
    const path = `${parentPath}${id}/`.replace('//', '/')
    node.level = level
    node.path = path
    upd.run(level, path, id)
    return path
  }
  for (const r of rows) resolve(r.id)
}

export function seedOrgs(db, { industry = 'cosmetic', silent = false, log } = {}) {
  requireDemoDatabase(db)
  const say = (m) => { if (!silent) (log ? log(m) : console.log(m)) }
  const tree = INDUSTRY_TREES[industry] || INDUSTRY_TREES.cosmetic
  const stat = { orgs: 0, warehouses: 0, stores: 0, dealers: 0, backfilled: 0 }

  // ---------- 1. 总部（法人主体） ----------
  const hqId = upsertOrg(db, {
    code: tree.group.code, name: tree.group.name, short: tree.group.short,
    type: 'group', parentId: null, isLegal: 1, currency: 'CNY', region: tree.group.region
  })
  // 总部货主 = 自己
  db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=? AND (owner_org_id IS NULL OR owner_org_id=0)').run(hqId, hqId)

  // ---------- 2. 中央厨房（挂总部，不独立核算，货主归总部） ----------
  let kitchenId = null
  if (tree.kitchen) {
    kitchenId = upsertOrg(db, {
      code: tree.kitchen.code, name: tree.kitchen.name, type: 'kitchen',
      parentId: hqId, isLegal: 0, currency: 'CNY', region: tree.kitchen.region
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(hqId, kitchenId)
  }

  // ---------- 3. 区域 → 仓库 / 门店 ----------
  const regionOrgByRegion = new Map()
  const regionIds = []

  const attachWarehouse = (wh, parentOrgId, ownerOrgId, regionName) => {
    const whOrgId = upsertOrg(db, {
      code: `ORG_${wh.code}`, name: wh.name, type: 'warehouse', parentId: parentOrgId,
      isLegal: 0, currency: wh.currency || 'CNY', region: regionName, brandId: wh.brand_id || null
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(ownerOrgId, whOrgId)
    db.prepare('UPDATE warehouses SET org_id=?, default_owner_org_id=?, region=COALESCE(region,?) WHERE id=?')
      .run(whOrgId, ownerOrgId, regionName, wh.id)
    stat.warehouses += 1
  }

  // 门店：直营/专柜 → 货主归总部；加盟店是独立主体 → 货主 = 自己（第三轮 B2）
  // 品牌与币种/税区随门店带出（餐饮版 3 品牌贯穿组织、中国香港门店用 HKD）
  const attachStore = (st, parentOrgId, regionName) => {
    const isFranchise = st.type === 'franchise'
    const stOrgId = upsertOrg(db, {
      code: `ORG_${st.code}`, name: st.name, type: 'store', parentId: parentOrgId,
      isLegal: isFranchise ? 1 : 0,
      currency: st.currency || 'CNY', region: regionName, taxRegion: st.tax_region || null,
      brandId: st.brand_id || null
    })
    const owner = isFranchise ? stOrgId : hqId
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(owner, stOrgId)
    db.prepare('UPDATE stores SET org_id=?, owner_org_id=?, currency=COALESCE(currency,?), brand_id=COALESCE(brand_id,?) WHERE id=?')
      .run(stOrgId, owner, st.currency || 'CNY', st.brand_id || null, st.id)
    const storeWh = db.prepare('SELECT * FROM warehouses WHERE store_id=?').get(st.id)
    if (storeWh) attachWarehouse(storeWh, stOrgId, owner, regionName)
    stat.stores += 1
    return stOrgId
  }

  // ---------- 3.4 央厨仓 ----------
  // 中央厨房既是生产车间也是仓（第三轮 B3）：仓挂央厨组织，货主归总部。
  // 必须在下面的「兜底挂载」之前完成，否则央厨仓会被按地区挂到区域组织上 —— 归属就错了。
  for (const code of tree.kitchen?.warehouses || []) {
    const wh = db.prepare('SELECT * FROM warehouses WHERE code=?').get(code)
    if (wh) attachWarehouse(wh, kitchenId, hqId, tree.kitchen.region)
  }

  // 地区不存在则自动建区域组织（各行业主数据差异大，不能写死）
  const ensureRegion = (regionName) => {
    if (!regionName) return regionIds[0] || hqId
    if (regionOrgByRegion.has(regionName)) return regionOrgByRegion.get(regionName)
    const id = upsertOrg(db, {
      code: `ORG_RG_${regionName}`, name: `${regionName}大区`, type: 'region',
      parentId: hqId, isLegal: 0, currency: 'CNY', region: regionName
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(hqId, id)
    regionOrgByRegion.set(regionName, id)
    regionIds.push(id)
    return id
  }

  for (const rg of tree.regions) {
    const rgId = upsertOrg(db, {
      code: rg.code, name: rg.name, type: 'region', parentId: hqId,
      isLegal: 0, currency: 'CNY', region: rg.region
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(hqId, rgId)
    regionOrgByRegion.set(rg.region, rgId)
    regionIds.push(rgId)

    for (const w of rg.warehouses || []) {
      const wh = db.prepare('SELECT * FROM warehouses WHERE code=?').get(w.match)
      if (!wh) continue
      attachWarehouse(wh, rgId, hqId, rg.region)
    }
    for (const code of rg.stores || []) {
      const st = db.prepare('SELECT * FROM stores WHERE code=?').get(code)
      if (!st) continue
      attachStore(st, rgId, rg.region)
    }
  }

  // ---------- 3.5 兜底挂载 ----------
  // 主数据里存在、但组织树配置未显式列出的门店与仓库，一律按地区自动归位。
  // 起因：服装版主数据与美妆不同（门店是新天地/三里屯/太古里，仓库多出广州区域仓与电商云仓），
  //       写死配置会让 313 行库存的货主留在默认主体上。
  for (const st of db.prepare('SELECT * FROM stores WHERE org_id IS NULL').all()) {
    attachStore(st, ensureRegion(st.region), st.region)
  }
  for (const wh of db.prepare('SELECT * FROM warehouses WHERE org_id IS NULL AND (store_id IS NULL OR store_id = 0)').all()) {
    attachWarehouse(wh, ensureRegion(wh.region), hqId, wh.region)
  }
  for (const wh of db.prepare('SELECT * FROM warehouses WHERE org_id IS NULL').all()) {
    const st = wh.store_id ? db.prepare('SELECT org_id, owner_org_id FROM stores WHERE id=?').get(wh.store_id) : null
    attachWarehouse(wh, st?.org_id || ensureRegion(wh.region), st?.owner_org_id || hqId, wh.region)
  }

  // ---------- 4. 经销商组织（两级：公司可带旗下门店） ----------
  const dealers = db.prepare('SELECT * FROM dealers').all()
  for (const d of dealers) {
    const dOrgId = upsertOrg(db, {
      code: `ORG_D_${d.code}`, name: d.name, type: 'dealer', parentId: hqId,
      isLegal: 1, currency: 'CNY', region: d.region || null
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(dOrgId, dOrgId)
    db.prepare('UPDATE dealers SET org_id=? WHERE id=?').run(dOrgId, d.id)
    stat.dealers += 1
  }

  // ---------- 5. 供应商组织 ----------
  const suppliers = db.prepare('SELECT id, code, name FROM suppliers').all()
  for (const s of suppliers) {
    const sOrgId = upsertOrg(db, {
      code: `ORG_S_${s.code}`, name: s.name, type: 'supplier', parentId: null,
      isLegal: 1, currency: 'CNY'
    })
    db.prepare('UPDATE orgs SET owner_org_id=? WHERE id=?').run(sOrgId, sOrgId)
    db.prepare('UPDATE suppliers SET org_id=? WHERE id=?').run(sOrgId, s.id)
  }

  rebuildPaths(db)

  // ---------- 6. 存量库存与流水回填货主 ----------
  // 老库（美妆/服装）库存行的 owner_org_id 是 0（默认主体），按仓库的真实货主回填。
  const b1 = db.prepare(`
    UPDATE inventory_stocks
    SET owner_org_id = COALESCE((SELECT w.default_owner_org_id FROM warehouses w WHERE w.id = inventory_stocks.warehouse_id), 0)
    WHERE IFNULL(owner_org_id,0) = 0
      AND EXISTS (SELECT 1 FROM warehouses w WHERE w.id = inventory_stocks.warehouse_id AND w.default_owner_org_id IS NOT NULL)
  `).run()
  const b2 = db.prepare(`
    UPDATE inventory_transactions
    SET owner_org_id = COALESCE((SELECT w.default_owner_org_id FROM warehouses w WHERE w.id = inventory_transactions.warehouse_id), 0)
    WHERE IFNULL(owner_org_id,0) = 0
      AND EXISTS (SELECT 1 FROM warehouses w WHERE w.id = inventory_transactions.warehouse_id AND w.default_owner_org_id IS NOT NULL)
  `).run()
  stat.backfilled = b1.changes + b2.changes

  // 币种跟随仓库本位币
  db.prepare(`
    UPDATE inventory_stocks
    SET currency = COALESCE((SELECT w.currency FROM warehouses w WHERE w.id = inventory_stocks.warehouse_id), 'CNY')
    WHERE currency IS NULL OR currency = ''
  `).run()

  // ---------- 7. 用户挂组织 ----------
  const userOrgRule = (u) => {
    if (u.store_id) {
      const st = db.prepare('SELECT org_id FROM stores WHERE id=?').get(u.store_id)
      return st?.org_id || hqId
    }
    if (u.dealer_id) {
      const dl = db.prepare('SELECT org_id FROM dealers WHERE id=?').get(u.dealer_id)
      return dl?.org_id || hqId
    }
    return hqId
  }
  const users = db.prepare('SELECT id, role, store_id, dealer_id FROM users').all()
  const upUser = db.prepare('UPDATE users SET org_id=? WHERE id=?')
  const insUO = db.prepare('INSERT OR IGNORE INTO user_orgs (user_id, org_id, relation) VALUES (?,?,?)')
  const insUR = db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_code) VALUES (?,?)')
  for (const u of users) {
    const orgId = userOrgRule(u)
    upUser.run(orgId, u.id)
    insUO.run(u.id, orgId, 'member')
    if (u.role) insUR.run(u.id, u.role)
    // 门店角色的数据范围限定在本店
    if (u.role === 'store') db.prepare("UPDATE users SET data_scope='org' WHERE id=?").run(u.id)
    else if (u.role === 'dealer') db.prepare("UPDATE users SET data_scope='dealer' WHERE id=?").run(u.id)
  }

  // ---------- 8. 组织职能开关 ----------
  const insFn = db.prepare('INSERT OR IGNORE INTO org_functions (org_id, func_code, enabled) VALUES (?,?,1)')
  const fnByType = {
    group: ['purchase', 'sales', 'inventory', 'finance', 'ordering', 'production'],
    region: ['purchase', 'sales', 'inventory', 'ordering'],
    kitchen: ['production', 'inventory', 'purchase'],
    warehouse: ['inventory', 'wms'],
    store: ['pos', 'inventory', 'ordering', 'sales'],
    dealer: ['ordering', 'sales'],
    supplier: ['purchase']
  }
  for (const o of db.prepare('SELECT id, type FROM orgs WHERE id <> 0').all()) {
    for (const f of fnByType[o.type] || []) insFn.run(o.id, f)
  }

  const total = db.prepare('SELECT COUNT(*) c FROM orgs').get().c
  say(`[orgs:${industry}] 组织 ${total} 个（总部 1 / 区域 ${tree.regions.length}${kitchenId ? ' / 央厨 1' : ''} / 门店 ${stat.stores} / 仓 ${stat.warehouses} / 经销商 ${stat.dealers}），回填货主 ${stat.backfilled} 行`)
  return { ...stat, total }
}

export default { seedOrgs, INDUSTRY_TREES }
