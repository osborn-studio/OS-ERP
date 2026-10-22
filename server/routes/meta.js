/**
 * ============================================================================
 * 文件标识：server/routes/meta.js ｜ 元数据路由：枚举字典、状态文案、字段选项、配置项定义 —— 界面上所有下拉框**从这里取**，不要在页面里写死
 * ============================================================================
 * 【职责】元数据路由：枚举字典、状态文案、字段选项、配置项定义 —— 界面上所有下拉框**从这里取**，不要在页面里写死
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自人工补充**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, wrap, fail, failFromError } from '../lib/http.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { DOC_TYPE_LABEL } from '../lib/stock.js'
// 仓库类型文案的**唯一出处**在 `lib/warehouse.js`（与"新建/改仓"接口的取值域同一份）——
// 分两份的后果实测过：餐饮线的 `kitchen` 不在字典里 ⇒ 界面上显示裸串 `kitchen`。
import { WAREHOUSE_TYPES } from '../lib/warehouse.js'
import { ROLES } from '../middleware/auth.js'
// 配置的唯一出处与唯一写入点（批次 R）：
//   · `SETTING_RULES` 定义全部键（标签 / 类型 / 默认值 / 值域 / 是否危险）；
//   · 读取一律走 `readSetting`，写入一律走 `writeSetting`（内部同事务写变更日志）；
//   · `ensureSettings` 只做初始化（补齐缺失键 + 补基线），幂等。
// **本文件不再直接写 `INSERT INTO settings`** —— 那是这一批要根治的东西：
// 原来那句裸 upsert 什么校验都不做、什么痕迹都不留。
import {
  SETTING_RULES,
  writeSetting,
  resetSetting,
  ensureSettings,
  listSettings,
  listSettingAudit,
  auditSettingTrail,
  meta as settingsMeta
} from '../lib/settings.js'

const r = Router()

/** 操作人（与 `routes/report.js` 的 `actorOf` 同形 —— 审计日志的 actor 必须一致） */
function actorOf(req, source = 'web') {
  return {
    id: req.user?.uid ?? null,
    name: req.user?.name || req.user?.username || null,
    source
  }
}

/**
 * 库存流水「业务类型」的下拉/显示文案。
 *
 * 为什么不能只返回 `DOC_TYPE_LABEL`（硬编码文案表）：**客户可以自己新建出入库类型**，
 * 那种码本来就不在硬编码表里 —— 只回表会让台账把新类型渲染成裸码（`REPAIR_OUT`），
 * 而用户给它起的中文名就在 `inv_txn_types.name` 里躺着。
 *
 * 优先级：**库里的名字优先**（客户可以在维护页改名，改名就该在界面上生效），
 * 硬编码表兜底（老库/表缺失时仍然有文案）。
 */
function stockDocTypes(db) {
  const map = { ...DOC_TYPE_LABEL }
  const has = db.prepare("SELECT 1 h FROM sqlite_master WHERE type='table' AND name='inv_txn_types'").get()
  if (has) {
    for (const r of db.prepare('SELECT code, name FROM inv_txn_types').all()) {
      if (String(r.name || '').trim()) map[r.code] = r.name
    }
  }
  return map
}

r.get(
  '/health',
  wrap((_req, res) => {
    const db = getDb()
    const tables = db.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c
    const products = db.prepare("SELECT COUNT(*) c FROM products").get().c
    return ok(res, {
      status: 'ok',
      service: 'gml-supply-chain',
      version: '1.0.0',
      time: new Date().toISOString(),
      database: { tables, products, seeded: products > 0 }
    })
  })
)

r.get(
  '/dict',
  wrap((_req, res) => {
    return ok(res, {
      roles: ROLES,
      dealer_levels: { diamond: '钻石经销商', gold: '金牌经销商', silver: '银牌经销商', bronze: '普通经销商' },
      dealer_channel: { cs: '日化专营', ka: '商超渠道', ecom: '电商渠道', med: '医疗美妆' },
      // 仓库类型：**直接引用 `lib/warehouse.js` 的那一份**（不再在这里抄一遍）。
      // 它同时是「新建仓库 / 改仓库」接口的取值域 —— 只有一份，才不会出现
      // "接口收得下、界面没有文案"（餐饮线 `kitchen` 就是这么变成裸串的）。
      // defect / quarantine：质量隔离仓（不合格品仓 / 待检品仓）。不良品处置
      // （让步接收 / 返工）会**自动生成一张调拨单**把货调进这两类仓 —— 没有文案时
      // 界面上会把它渲染成一个没有名字的灰点，而它恰恰是「这批货为什么不在了」的答案。
      warehouse_types: WAREHOUSE_TYPES,
      store_types: { direct: '直营店', franchise: '加盟店', counter: '商场专柜' },
      platform_types: { platform: '第三方平台', self: '自营商城', live: '直播电商', instant: '即时零售' },
      sales_channels: { dealer: '经销商分销', store: '门店零售', online: '自营商城', platform: '平台电商', live: '直播电商' },
      purchase_status: { draft: '草稿', submitted: '待审批', approved: '已审批', received: '已收货', closed: '已关闭', cancelled: '已取消' },
      sales_status: { draft: '草稿', confirmed: '已确认(占用库存)', picking: '部分发货', shipped: '已发货', completed: '已完成', cancelled: '已取消', returned: '已退货' },
      // OMS 订单状态文案。顺序即前端 Tab 顺序（`src/pages/oms/Orders.tsx` 用 `omsStatus` 生成页签）。
      // ⚠️ `cancelled` 是**内核认可**的终态（`STATES.OM` = pending/shipped/completed/refunded/cancelled），
      //    商城撤单走内核后写的就是它 —— 少了它，撤单单在界面上会以**裸值** `cancelled` 显示，
      //    而且列表里连"已取消"页签都不会出现（Tab 由本字典生成）。
      // ⚠️ `closed` **保留**（不是内核值、已无写入方）：历史库里的撤单单可能还是它，删掉会让老数据显示裸值。
      oms_status: { pending: '待发货', shipped: '已发货', completed: '已完成', refunding: '退款中', refunded: '已退款', cancelled: '已取消', closed: '已关闭' },
      // ⚠️ `submitted`（本批新可达）：内核 `STATES.TF` 有 `submitted`，但本批之前
      //    从 draft 只有 `ship` 一条出边、没有 `submit` 的门 ⇒ 这个状态**根本造不出来**，
      //    所以字典里一直没有它。本批把 `POST /inventory/transfers/:id/submit` 开出来之后，
      //    `submitted` 变成真实可达，而**本字典是调拨页页签的唯一来源** ⇒ 少了这一行，
      //    已提交的调拨单只能从「全部」里看到，页签里没有它（不是显示成裸值，是**整档消失**）。
      transfer_status: { draft: '待出库', submitted: '已提交', shipped: '在途', received: '已入库', cancelled: '已取消' },
      // 同理 `cancelled`：本批开出 `POST /inventory/checks/:id/cancel` 之前，
      // 盘点单从 draft 只能 `start`/`adjust`，作废不掉 ⇒ `cancelled` 从未出现。现在它会出现。
      check_status: { draft: '草稿', checking: '盘点中', adjusted: '已调整', cancelled: '已取消' },
      stock_doc_types: stockDocTypes(getDb()),
      direction: { in: '入库', out: '出库' },
      rebate_status: { pending: '待核算', confirmed: '已确认', paid: '已发放' },
      // 经销商对账单（DS）的生命周期文案。顺序即前端 Tab 顺序：
      //   出具过程 draft → confirmed → sent；终局结论 closed / voided。
      // 终局两个状态必须在这里补齐 —— 漏了会让前端把"已结清"渲染成一个没有名字的
      // 灰点（`Status` 组件拿不到文案），而这是**对账的最终结论**，不能没有名字。
      // ⚠️ 这份文案要与内核 `008_doc_kernel.cjs` 的 STATES.DS 名称一字不差：
      //    内核是"流转的合法性与名称"的唯一出处，这里是"界面文案"的出口，
      //    两处不一致时，用户看到的词和事件流里的词会对不上。
      statement_status: {
        draft: '草稿',
        confirmed: '已确认',
        sent: '已发送',
        closed: '已结清',
        voided: '已作废'
      },
      expire_level: { expired: '已过期', danger: '30 天内临期', warning: '90 天内临期', notice: '180 天内临期' }
    })
  })
)

// ---------------------------------------------------------------------------
// 配置（settings）：定义 + 当前值 + 变更历史
// ---------------------------------------------------------------------------
// 读取一律走 `listSettings`：它返回的是「定义 + 现状 + 是否偏离默认值」，
// 而不是原来那句 `SELECT * FROM settings`（后者只给出库里有的行 ——
// 于是三个"代码读、库里没有"的幽灵配置在界面上完全看不见）。
r.get(
  '/settings',
  requireAuth,
  requireRole('admin'),
  wrap((_req, res) => {
    const db = getDb()
    ensureSettings(db)
    return ok(res, listSettings(db))
  })
)

r.put(
  '/settings',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    ensureSettings(db)
    const { key, value, reason } = req.body || {}
    if (!key) return fail(res, '缺少 key')
    try {
      // 返回值里带 `changed`：值没变时不写日志、如实回答"这次没有变更"。
      // 界面上"点了一次保存但没改"是正常操作，所以不做成错误。
      return ok(res, writeSetting(db, { key, value, reason, actor: actorOf(req) }))
    } catch (e) {
      // `failFromError` 只认 `{ code, status }` —— `SettingError` 两个都有
      if (failFromError(res, e)) return
      throw e
    }
  })
)

r.post(
  '/settings/reset',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    ensureSettings(db)
    const { key, reason } = req.body || {}
    if (!key) return fail(res, '缺少 key')
    try {
      return ok(res, resetSetting(db, { key, reason, actor: actorOf(req) }))
    } catch (e) {
      if (failFromError(res, e)) return
      throw e
    }
  })
)

/** 配置的定义表（界面据此渲染表单；也是"有哪些键"的唯一出处） */
r.get(
  '/settings/defs',
  requireAuth,
  requireRole('admin'),
  wrap((_req, res) => {
    const db = getDb()
    return ok(res, {
      defs: Object.entries(SETTING_RULES).map(([key, v]) => ({
        key,
        label: v.label,
        group: v.group,
        type: v.type,
        default: v.default,
        is_danger: Boolean(v.is_danger),
        wired: Boolean(v.wired),
        impact: v.impact,
        enum: v.enum || null,
        min: v.min ?? null,
        max: v.max ?? null,
        gt: v.gt ?? null
      })),
      ...settingsMeta(db)
    })
  })
)

/** 配置变更历史 */
r.get(
  '/settings/audit',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    const { key, danger_only: dangerOnly, limit } = req.query || {}
    return ok(res, listSettingAudit(db, {
      key: key || null,
      dangerOnly: dangerOnly === '1' || dangerOnly === 'true',
      limit
    }))
  })
)

/** 配置审计链自证（与 `/reports/periods/audit/check` 同形） */
r.get(
  '/settings/audit/check',
  requireAuth,
  requireRole('admin'),
  wrap((_req, res) => {
    const db = getDb()
    ensureSettings(db)
    return ok(res, auditSettingTrail(db))
  })
)

export default r
