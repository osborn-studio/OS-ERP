/**
 * ============================================================================
 * 文件标识：server/lib/bom.js ｜ BOM 服务层（模块 10B · 一个 BOM + 三类执行单）
 * ============================================================================
 * 【职责】BOM 服务层（模块 10B · 一个 BOM + 三类执行单）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// BOM 服务层（模块 10B · 一个 BOM + 三类执行单）
//
// 一句话说清本模块要解决的：**「投入什么、产出什么」只能有一个答案。**
//
// 此前「投入产出」在四处各描述一遍 —— 采购的供货目录、委外的发料清单、
// 促销的组合装、成本的料工费归集。改一处漏三处是迟早的事。本模块把它收成一个 BOM：
//   组合装 / 自制 / 委外共用 `boms` + `bom_items`，靠 `usage` 区分（第二轮已定案）。
//
// 三条口径（写死在代码里，不靠人自觉）：
//   ① **一个母件一个用途只有一个 BOM** —— 由库结构的 UNIQUE 约束保证，不是靠人记得。
//      换版只能「作废旧版 + 新建新版」，否则两个人都建了一版、各领各的料，系统两个都认。
//   ② **只有已审批且在生效期内的 BOM 能用来展开**。草稿 BOM 的用量是还没审的数，
//      拿它发料等于按草稿生产，而事后完全查不出「这批料是照哪版领的」。
//   ③ **替代料的选择必须可解释**。同组内有库存的优先、其次看优先级；
//      但无论选谁，都要把「为什么没选主料」一起返回（`reason`）——
//      只返回结果不返回理由，出了问题没人能复盘。
//
// 一处**刻意的设计**：展开返回的用量已经**含损耗**。
//   `用量 × (1 + 损耗率) × 生产数量 ÷ 基准批量`
// 让调用点各自乘 `(1+loss_rate)` 意味着每个调用点都要记得这件事，
// 而漏乘的表现是「料总是不够用」——一个不会报错、只会让人以为库存不准的失效。

import { nextDocNo } from './docno.js'

export class BomError extends Error {
  constructor(message, { code = 'BOM_ERROR', httpStatus = 400, detail = null } = {}) {
    super(message)
    this.name = 'BomError'
    this.code = code
    this.httpStatus = httpStatus
    this.status = httpStatus
    this.detail = detail
  }
}

export const USAGE_LABEL = { self_made: '自制', outsourced: '委外', combo: '组合装' }
export const BOM_STATUS_LABEL = { draft: '草稿', approved: '已审批', obsolete: '已作废' }
export const PRODUCE_WAY_LABEL = { self_made: '自制', outsourced: '委外' }

const num = (v) => Number(v) || 0
const round4 = (n) => Math.round(num(n) * 10000) / 10000
const round2 = (n) => Math.round(num(n) * 100) / 100

// 本地日期/时间统一来自 dates.js（本项目只留一处实现，见该文件模块注释）。
// 这里保留 re-export：bom 的历史调用方是按 `localDate` 从本模块取的。
export { localDate, localNow } from './dates.js'
import { localDate, localNow } from './dates.js'

const actorOf = (a) => (a && typeof a === 'object' ? a : {})
const nowText = () => localNow()

// SKU 的资料分散在两张表：编码与规格在 `product_skus`（列名是 **sku_code**，不是 code），
// 单位在 `products`。本模块里要取 SKU 资料的地方有七八处，
// 各写各的 join 迟早有一处漏掉单位 —— 所以口径收在这一个函数里。
const SKU_SQL = `SELECT sk.id, sk.sku_code AS code, sk.name, sk.spec, p.unit, p.spu_code
                   FROM product_skus sk LEFT JOIN products p ON p.id = sk.product_id
                  WHERE sk.id = ?`
export function getSkuInfo(db, skuId) {
  return db.prepare(SKU_SQL).get(Number(skuId)) || null
}

// ---------------------------------------------------------------------------
// 取 BOM：唯一口径
// ---------------------------------------------------------------------------

/**
 * 取某母件在某用途下的**生效** BOM（已审批 + 在生效期内）。
 * 这是全项目「用什么 BOM」的唯一入口 —— 任何地方要展开需求，都从这里拿。
 * @returns {object|null}
 */
export function resolveBom(db, { skuId, usage = 'self_made', date = null }) {
  const d = date || localDate()
  const row = db
    .prepare(
      `SELECT * FROM boms
        WHERE product_sku_id = ? AND usage = ? AND status = 'approved'
          AND (effective_from IS NULL OR effective_from <= ?)
          AND (effective_to   IS NULL OR effective_to   >= ?)
        LIMIT 1`
    )
    .get(skuId, usage, d, d)
  if (!row) return null
  const items = db
    .prepare('SELECT * FROM bom_items WHERE bom_id=? ORDER BY line_no')
    .all(row.id)
  return { ...row, items }
}

/** 该母件有哪些用途的 BOM（供前端提示「这个人没建委外 BOM」） */
export function bomUsagesOf(db, skuId) {
  return db
    .prepare('SELECT id,code,usage,version,status,effective_from,effective_to FROM boms WHERE product_sku_id=? ORDER BY usage, id')
    .all(skuId)
}

// ---------------------------------------------------------------------------
// 库存可用量（展开时判断替代料够不够，只读，不动库存）
// ---------------------------------------------------------------------------

/** 某 SKU 在某仓的总可用量（跨批次，空批次与有批次一并算） */
export function skuAvailable(db, warehouseId, skuId, ownerOrgId = null) {
  if (!warehouseId) return null
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(qty_on_hand - qty_reserved), 0) AS qty
         FROM inventory_stocks
        WHERE warehouse_id = ? AND sku_id = ?
          AND (? IS NULL OR owner_org_id = ?)`
    )
    .get(warehouseId, skuId, ownerOrgId, ownerOrgId)
  return round4(row?.qty || 0)
}

// ---------------------------------------------------------------------------
// BOM 展开：本模块的核心
// ---------------------------------------------------------------------------

/**
 * 把 BOM 展开成「要领哪些料、各多少」。
 *
 * 替代料规则（同 `substitute_group` 内互为替代）：
 *   1. 有仓库上下文时：**先挑库存能满足整笔需求的**，其中取优先级最高的那个；
 *   2. 库存都不满足时：取可用量最大的（至少让部分开工），并在 `reason` 里说清；
 *   3. 没有仓库上下文时（如只做报价试算）：取优先级最高的（priority 小者），最可预测。
 *
 * @param {object} p
 * @param {number} p.qty         计划生产数量
 * @param {number} [p.warehouseId] 生产仓（给了才能判断替代料库存）
 * @param {boolean} [p.allowSubstitute=true] 是否启用替代料
 */
export function expandBom(db, p = {}) {
  const qty = num(p.qty)
  if (!(qty > 0)) throw new BomError('生产数量必须大于 0', { code: 'BOM_QTY_INVALID' })

  let bom = null
  if (p.bomId) {
    const head = db.prepare('SELECT * FROM boms WHERE id=?').get(Number(p.bomId))
    if (!head) throw new BomError('BOM 不存在', { code: 'BOM_NOT_FOUND', httpStatus: 404 })
    bom = { ...head, items: db.prepare('SELECT * FROM bom_items WHERE bom_id=? ORDER BY line_no').all(head.id) }
  } else if (p.skuId) {
    const usage = p.usage || 'self_made'
    bom = resolveBom(db, { skuId: Number(p.skuId), usage, date: p.date || null })
    if (!bom) {
      throw new BomError(
        `未找到 SKU#${p.skuId} 的${USAGE_LABEL[usage] || usage} BOM（需已审批且在生效期内）`,
        { code: 'BOM_NOT_EFFECTIVE', httpStatus: 404, detail: { skuId: p.skuId, usage, candidates: bomUsagesOf(db, p.skuId) } }
      )
    }
  } else {
    throw new BomError('需要指定 bom_id 或 sku_id', { code: 'BOM_PARAM_MISSING' })
  }

  if (bom.status !== 'approved') {
    throw new BomError(`BOM ${bom.code} 未审批（当前 ${BOM_STATUS_LABEL[bom.status] || bom.status}），不能用于展开`, {
      code: 'BOM_NOT_APPROVED'
    })
  }

  const base = num(bom.base_qty) || 1
  const factor = qty / base
  const items = bom.items || []
  if (!items.length) throw new BomError(`BOM ${bom.code} 没有组件行，无法展开`, { code: 'BOM_EMPTY' })

  // 分组：有替代组的按组，没有的各自成组（组名保持稳定，便于测试与展示）
  const groups = new Map()
  for (const it of items) {
    const key = it.substitute_group ? `g:${it.substitute_group}` : `s:${it.line_no}`
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(it)
  }

  const allowSub = p.allowSubstitute !== false
  const lines = []
  const groupInfo = []

  // 按组的**首个行号**排序输出 —— 保证展开结果的顺序稳定可复现（不依赖 Map 迭代顺序）
  const orderedKeys = [...groups.keys()].sort((a, b) => {
    const al = groups.get(a).reduce((m, x) => Math.min(m, x.line_no), Infinity)
    const bl = groups.get(b).reduce((m, x) => Math.min(m, x), Infinity)
    return al - bl
  })

  for (const key of orderedKeys) {
    const members = [...groups.get(key)].sort((a, b) => a.priority - b.priority || a.line_no - b.line_no)
    const isGroup = key.startsWith('g:')
    const needOf = (it) => round4(num(it.qty) * (1 + num(it.loss_rate)) * factor)

    // 候选评估：每个成员算出「若用它需领多少 + 当前可用量能不能覆盖」
    const candidates = members.map((it) => {
      const need = needOf(it)
      const avail = skuAvailable(db, p.warehouseId, it.sku_id, p.ownerOrgId || null)
      return {
        line_no: it.line_no,
        sku_id: it.sku_id,
        sku_code: it.sku_code,
        sku_name: it.sku_name,
        priority: it.priority,
        need_qty: need,
        available: avail,
        enough: avail == null ? null : avail + 1e-9 >= need
      }
    })

    let chosen = candidates[0]
    let reason = isGroup ? '主料（优先级最高）' : '非替代料'

    if (isGroup && allowSub && candidates.length > 1) {
      const stocked = candidates.filter((c) => c.enough === true)
      if (stocked.length) {
        // 有能满足的：其中取优先级最高的。主料本身就够时自然还是主料。
        chosen = stocked.sort((a, b) => a.priority - b.priority || a.line_no - b.line_no)[0]
        reason =
          chosen.line_no === candidates[0].line_no
            ? '主料库存充足'
            : `主料不足（可用 ${candidates[0].available ?? '-'} < 需求 ${candidates[0].need_qty}），改用替代料`
      } else if (p.warehouseId) {
        // 谁都不够：取可用量最大的，让部分开工；把差距写清楚
        chosen = [...candidates].sort(
          (a, b) => num(b.available) - num(a.available) || a.priority - b.priority || a.line_no - b.line_no
        )[0]
        reason = `所有替代料库存均不足，取可用量最大者（可用 ${chosen.available ?? 0} < 需求 ${chosen.need_qty}）`
      }
    }

    const chosenItem = members.find((x) => x.line_no === chosen.line_no) || members[0]
    const isSubstitute = isGroup && chosen.line_no !== candidates[0].line_no
    lines.push({
      line_no: chosenItem.line_no,
      bom_line_no: chosenItem.line_no,
      sku_id: chosenItem.sku_id,
      sku_code: chosenItem.sku_code,
      sku_name: chosenItem.sku_name,
      spec: chosenItem.spec,
      unit: chosenItem.unit,
      qty: chosen.need_qty,
      base_qty: num(chosenItem.qty),
      loss_rate: num(chosenItem.loss_rate),
      available: chosen.available,
      shortage: chosen.available == null ? null : round4(Math.max(0, chosen.need_qty - chosen.available)),
      substitute_group: chosenItem.substitute_group || null,
      is_substitute: isSubstitute,
      substitute_for: isSubstitute ? candidates[0].line_no : null,
      issue_way: chosenItem.issue_way || 'by_bom',
      remark: chosenItem.remark || null
    })

    if (isGroup) {
      groupInfo.push({
        group: chosenItem.substitute_group,
        required_qty: chosen.need_qty,
        chosen_line_no: chosen.line_no,
        chosen_sku_id: chosen.sku_id,
        reason,
        candidates
      })
    }
  }

  const shortageCount = lines.filter((l) => l.shortage != null && l.shortage > 0).length
  return {
    bom: {
      id: bom.id,
      code: bom.code,
      version: bom.version,
      usage: bom.usage,
      usage_label: USAGE_LABEL[bom.usage] || bom.usage,
      base_qty: base,
      product_sku_id: bom.product_sku_id,
      product_sku_code: bom.product_sku_code,
      product_sku_name: bom.product_sku_name,
      warehouse_id: bom.warehouse_id,
      effective_from: bom.effective_from,
      effective_to: bom.effective_to
    },
    qty,
    lines,
    groups: groupInfo,
    summary: {
      line_count: lines.length,
      group_count: groupInfo.length,
      substituted: lines.filter((l) => l.is_substitute).length,
      shortage_count: shortageCount
    }
  }
}

// ---------------------------------------------------------------------------
// BOM 维护
// ---------------------------------------------------------------------------

function nextBomCode(db, dateStr) {
  return nextDocNo(db, 'BOM', 'boms', 'code', dateStr)
}

/** 校验行数据：用量必须大于 0，损耗率不能为负也不能离谱 */
function normalizeItems(db, items) {
  if (!Array.isArray(items) || !items.length) {
    throw new BomError('BOM 至少需要一行组件', { code: 'BOM_ITEM_REQUIRED' })
  }
  const seen = new Set()
  return items.map((it, i) => {
    const skuId = Number(it.sku_id)
    if (!skuId) throw new BomError(`第 ${i + 1} 行未指定组件 SKU`, { code: 'BOM_ITEM_SKU_REQUIRED' })
    const qty = num(it.qty)
    if (!(qty > 0)) throw new BomError(`第 ${i + 1} 行用量必须大于 0`, { code: 'BOM_ITEM_QTY_INVALID' })
    const loss = num(it.loss_rate)
    if (loss < 0) throw new BomError(`第 ${i + 1} 行损耗率不能为负`, { code: 'BOM_ITEM_LOSS_INVALID' })
    // 损耗率 ≥ 100% 意味着「投一倍的料全坏了」，几乎总是把百分比填成了小数（填 5 而非 0.05）
    if (loss >= 1) {
      throw new BomError(
        `第 ${i + 1} 行损耗率 ${loss} 看起来是百分比写成了小数：损耗 5% 应填 0.05，而不是 5`,
        { code: 'BOM_ITEM_LOSS_SUSPECT' }
      )
    }
    const dupKey = `${skuId}#${it.substitute_group || ''}#${num(it.priority)}`
    if (seen.has(dupKey)) {
      throw new BomError(`第 ${i + 1} 行与前面的行重复（同一 SKU + 同一替代组 + 同一优先级）`, { code: 'BOM_ITEM_DUPLICATE' })
    }
    seen.add(dupKey)

    const sku = getSkuInfo(db, skuId)
    return {
      line_no: i + 1,
      sku_id: skuId,
      sku_code: sku?.code || it.sku_code || null,
      sku_name: sku?.name || it.sku_name || null,
      spec: sku?.spec || it.spec || null,
      unit: sku?.unit || it.unit || null,
      qty,
      loss_rate: loss,
      substitute_group: it.substitute_group ? String(it.substitute_group) : null,
      priority: Number.isFinite(Number(it.priority)) ? Number(it.priority) : 0,
      issue_way: it.issue_way || 'by_bom',
      remark: it.remark || null
    }
  })
}

function writeItems(db, bomId, rows) {
  db.prepare('DELETE FROM bom_items WHERE bom_id=?').run(bomId)
  const ins = db.prepare(
    `INSERT INTO bom_items (bom_id,line_no,sku_id,sku_code,sku_name,spec,unit,qty,loss_rate,
       substitute_group,priority,issue_way,remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
  for (const it of rows) {
    ins.run(
      bomId, it.line_no, it.sku_id, it.sku_code, it.sku_name, it.spec, it.unit,
      it.qty, it.loss_rate, it.substitute_group, it.priority, it.issue_way, it.remark
    )
  }
  db.prepare('UPDATE boms SET item_count=?, updated_at=? WHERE id=?').run(rows.length, nowText(), bomId)
}

export function createBom(db, p = {}) {
  const actor = actorOf(p.actor)
  const skuId = Number(p.productSkuId || p.product_sku_id)
  if (!skuId) throw new BomError('必须指定母件 SKU', { code: 'BOM_PRODUCT_REQUIRED' })
  const sku = getSkuInfo(db, skuId)
  if (!sku) throw new BomError('母件 SKU 不存在', { code: 'BOM_PRODUCT_NOT_FOUND', httpStatus: 404 })

  const usage = p.usage || 'self_made'
  if (!USAGE_LABEL[usage]) throw new BomError(`未知 BOM 用途 ${usage}`, { code: 'BOM_USAGE_INVALID' })

  // 口径①的落地：不是「先查再插」那种有竞态的检查，而是让库的 UNIQUE 去挡。
  // 但这里仍要先给出**可读的**错误 —— 用户看到 UNIQUE constraint failed 是没法处理的。
  const exists = db.prepare('SELECT id,code,status FROM boms WHERE product_sku_id=? AND usage=?').get(skuId, usage)
  if (exists) {
    throw new BomError(
      `SKU ${sku.code} 已有${USAGE_LABEL[usage]} BOM（${exists.code}，${BOM_STATUS_LABEL[exists.status]}）：一个母件同一用途只能有一个 BOM，换版请先作废旧版`,
      { code: 'BOM_ALREADY_EXISTS', detail: { existsId: exists.id, existsCode: exists.code } }
    )
  }

  const items = normalizeItems(db, p.items)
  const baseQty = num(p.baseQty || p.base_qty) || 1
  if (!(baseQty > 0)) throw new BomError('基准批量必须大于 0', { code: 'BOM_BASE_INVALID' })

  const code = p.code || nextBomCode(db, p.effectiveFrom || p.effective_from || null)
  const now = nowText()
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO boms (code,product_sku_id,product_sku_code,product_sku_name,version,usage,base_qty,
           produce_way,warehouse_id,status,effective_from,effective_to,remark,created_by,created_by_name,
           created_at,updated_at)
         VALUES (?,?,?,?,?,?,?,?,?, 'draft', ?,?,?,?,?,?,?)`
      )
      .run(
        code, skuId, sku.code, sku.name,
        p.version || 'V1.0', usage, baseQty,
        p.produceWay || p.produce_way || (usage === 'outsourced' ? 'outsourced' : 'self_made'),
        p.warehouseId != null || p.warehouse_id != null ? Number(p.warehouseId ?? p.warehouse_id) : null,
        p.effectiveFrom || p.effective_from || localDate(),
        p.effectiveTo || p.effective_to || null,
        p.remark || null, actor.id ?? null, actor.name ?? null, now, now
      )
    writeItems(db, info.lastInsertRowid, items)
    return info.lastInsertRowid
  })
  const id = tx()
  return getBom(db, id)
}

export function updateBom(db, p = {}) {
  const id = Number(p.id)
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(id)
  if (!bom) throw new BomError('BOM 不存在', { code: 'BOM_NOT_FOUND', httpStatus: 404 })
  // 已审批的 BOM 不允许原地改：改了用量却不留痕，「上月按什么用量发的料」就查不出来了。
  // 换版走「作废旧版 + 新建新版」，历史单据引用的始终是当时那一版。
  if (bom.status === 'approved') {
    throw new BomError('已审批的 BOM 不能修改：请作废后新建版本，已发生的领料要能对得上当时那一版', {
      code: 'BOM_APPROVED_IMMUTABLE'
    })
  }
  if (bom.status === 'obsolete') {
    throw new BomError('已作废的 BOM 不能修改', { code: 'BOM_OBSOLETE_IMMUTABLE' })
  }

  const now = nowText()
  db.transaction(() => {
    db.prepare(
      `UPDATE boms SET version=?, base_qty=?, produce_way=?, warehouse_id=?, effective_from=?, effective_to=?,
         remark=?, updated_at=? WHERE id=?`
    ).run(
      p.version || bom.version,
      p.baseQty != null || p.base_qty != null ? num(p.baseQty ?? p.base_qty) : bom.base_qty,
      p.produceWay || p.produce_way || bom.produce_way,
      p.warehouseId != null || p.warehouse_id != null ? Number(p.warehouseId ?? p.warehouse_id) : bom.warehouse_id,
      p.effectiveFrom || p.effective_from || bom.effective_from,
      p.effectiveTo !== undefined || p.effective_to !== undefined
        ? (p.effectiveTo ?? p.effective_to ?? null)
        : bom.effective_to,
      p.remark !== undefined ? p.remark : bom.remark,
      now, id
    )
    if (p.items) writeItems(db, id, normalizeItems(db, p.items))
  })()
  return getBom(db, id)
}

export function auditBom(db, { id, actor = {}, remark = null } = {}) {
  const a = actorOf(actor)
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(Number(id))
  if (!bom) throw new BomError('BOM 不存在', { code: 'BOM_NOT_FOUND', httpStatus: 404 })
  if (bom.status === 'approved') return getBom(db, bom.id)
  if (bom.status !== 'draft') throw new BomError(`当前状态（${BOM_STATUS_LABEL[bom.status]}）不能审批`, { code: 'BOM_STATUS_INVALID' })

  const count = db.prepare('SELECT COUNT(*) AS c FROM bom_items WHERE bom_id=?').get(bom.id).c
  if (!count) throw new BomError('BOM 没有组件行，不能审批', { code: 'BOM_EMPTY' })

  db.prepare(
    `UPDATE boms SET status='approved', audited_by=?, audited_by_name=?, audited_at=?, audit_remark=?, updated_at=?
      WHERE id=?`
  ).run(a.id ?? null, a.name ?? null, nowText(), remark || null, nowText(), bom.id)
  return getBom(db, bom.id)
}

export function obsoleteBom(db, { id, actor = {}, remark = null } = {}) {
  const a = actorOf(actor)
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(Number(id))
  if (!bom) throw new BomError('BOM 不存在', { code: 'BOM_NOT_FOUND', httpStatus: 404 })
  if (bom.status === 'obsolete') return getBom(db, bom.id)
  db.prepare("UPDATE boms SET status='obsolete', audit_remark=COALESCE(?,audit_remark), updated_at=? WHERE id=?").run(
    remark || null, nowText(), bom.id
  )
  return getBom(db, bom.id)
}

export function deleteBom(db, { id } = {}) {
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(Number(id))
  if (!bom) throw new BomError('BOM 不存在', { code: 'BOM_NOT_FOUND', httpStatus: 404 })
  // 只有草稿能删 —— 审批过就被生产/领料引用过，删掉会让历史单据指向空
  if (bom.status !== 'draft') {
    throw new BomError('只有草稿 BOM 可以删除，已审批的请作废', { code: 'BOM_DELETE_FORBIDDEN' })
  }
  db.prepare('DELETE FROM bom_items WHERE bom_id=?').run(bom.id)
  db.prepare('DELETE FROM boms WHERE id=?').run(bom.id)
  return { id: bom.id, deleted: true }
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------

export function getBom(db, id) {
  const bom = db.prepare('SELECT * FROM boms WHERE id=?').get(Number(id))
  if (!bom) return null
  const items = db.prepare('SELECT * FROM bom_items WHERE bom_id=? ORDER BY line_no').all(bom.id)
  return {
    ...bom,
    usage_label: USAGE_LABEL[bom.usage] || bom.usage,
    status_label: BOM_STATUS_LABEL[bom.status] || bom.status,
    items
  }
}

export function listBoms(db, q = {}) {
  const where = []
  const args = []
  if (q.status) { where.push('b.status = ?'); args.push(q.status) }
  if (q.usage) { where.push('b.usage = ?'); args.push(q.usage) }
  if (q.keyword) {
    where.push('(b.code LIKE ? OR b.product_sku_code LIKE ? OR b.product_sku_name LIKE ?)')
    const k = `%${q.keyword}%`
    args.push(k, k, k)
  }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
  const page = Math.max(1, Number(q.page) || 1)
  const pageSize = Math.min(200, Math.max(1, Number(q.pageSize) || 20))
  const total = db.prepare(`SELECT COUNT(*) AS c FROM boms b ${w}`).get(...args).c
  const list = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM bom_items i WHERE i.bom_id=b.id) AS item_count
         FROM boms b ${w}
        ORDER BY b.id DESC LIMIT ? OFFSET ?`
    )
    .all(...args, pageSize, (page - 1) * pageSize)
  return {
    list: list.map((b) => ({
      ...b,
      usage_label: USAGE_LABEL[b.usage] || b.usage,
      status_label: BOM_STATUS_LABEL[b.status] || b.status
    })),
    total,
    page,
    pageSize
  }
}

/** BOM 总览：给制造页首屏用 */
export function bomOverview(db) {
  const one = (sql, ...a) => db.prepare(sql).get(...a)
  const counts = one(`
    SELECT COUNT(*) AS total,
           SUM(CASE WHEN status='draft'    THEN 1 ELSE 0 END) AS draft,
           SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) AS approved,
           SUM(CASE WHEN status='obsolete' THEN 1 ELSE 0 END) AS obsolete,
           SUM(CASE WHEN usage='self_made'  THEN 1 ELSE 0 END) AS self_made,
           SUM(CASE WHEN usage='outsourced' THEN 1 ELSE 0 END) AS outsourced,
           SUM(CASE WHEN usage='combo'      THEN 1 ELSE 0 END) AS combo
      FROM boms`)
  // 「能生产但没 BOM」的成品有多少 —— 这是最该被看见的一个数：
  // 净需求算出要自产，点进去却没有 BOM，只能靠人临时手填用量。
  const producible = one(`
    SELECT COUNT(DISTINCT po.product_sku_id) AS sku_count
      FROM production_orders po
     WHERE po.product_sku_id NOT IN (SELECT product_sku_id FROM boms WHERE status='approved')`)
  const subGroups = one(`
    SELECT COUNT(DISTINCT bom_id || '#' || substitute_group) AS c
      FROM bom_items WHERE substitute_group IS NOT NULL`)
  return {
    total: counts.total || 0,
    by_status: { draft: counts.draft || 0, approved: counts.approved || 0, obsolete: counts.obsolete || 0 },
    by_usage: { self_made: counts.self_made || 0, outsourced: counts.outsourced || 0, combo: counts.combo || 0 },
    substitute_groups: subGroups.c || 0,
    producible_without_bom: producible.sku_count || 0
  }
}

export default {
  BomError, USAGE_LABEL, BOM_STATUS_LABEL, PRODUCE_WAY_LABEL,
  resolveBom, bomUsagesOf, skuAvailable, expandBom,
  createBom, updateBom, auditBom, obsoleteBom, deleteBom,
  getBom, listBoms, bomOverview
}
