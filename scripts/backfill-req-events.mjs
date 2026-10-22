#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/backfill-req-events.mjs ｜ 收尾：为 legacy 要货单补登流转留痕（一次性回填脚本）
 * ============================================================================
 * 【职责】收尾：为 legacy 要货单补登流转留痕（一次性回填脚本）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 收尾：为 legacy 要货单补登流转留痕（一次性回填脚本）
 *
 * 背景：门店要货单（YQ）与经销商要货单（DR）早在内核注册，但历史路由直接
 * UPDATE 状态，从来没有写过 doc_events —— 一张「已收货」的要货单在留痕里
 * 像凭空出现的一样。这个脚本按内核定义的合法链路，把每张存量单据的
 * 流转轨迹补登出来（source='backfill'，可分辨、可重复执行幂等）。
 *
 * 口径：补登只写留痕、不改单据状态；链路必须只使用 doc_actions 里存在的
 * 合法动作，宁可少补一段也不编造内核不承认的流转。
 *
 * 用法：node scripts/backfill-req-events.mjs [industry ...]（默认三库）
 */
import { getDbFor } from '../server/db/index.js'
import { logEvent, getMachine } from '../server/lib/docflow.js'

const industries = process.argv.slice(2).length ? process.argv.slice(2) : ['cosmetic', 'food', 'apparel']

/** YQ 到各终态的标准链路（draft 之后的全部合法动作序列） */
const YQ_CHAIN = {
  draft: [],
  submitted: ['submit'],
  processing: ['submit', 'process'],
  allocated: ['submit', 'process', 'allocate'],
  transferred: ['submit', 'process', 'transfer'],
  shipped: ['submit', 'process', 'allocate', 'ship'],
  received: ['submit', 'process', 'allocate', 'ship', 'receive'],
  completed: ['submit', 'process', 'allocate', 'ship', 'receive', 'complete'],
  rejected: ['submit', 'reject']
}

/** DR 到各终态的标准链路 */
const DR_CHAIN = {
  draft: [],
  submitted: ['submit'],
  approved: ['submit', 'approve'],
  rejected: ['submit', 'reject'],
  converted: ['submit', 'approve', 'convert'],
  cancelled: [] // 内核没有 cancel 动作（DR 无 cancelled 状态），只补登记、不补链路
}

function backfill(db, { docType, table, chains, remark }) {
  const machine = getMachine(db, docType)
  const rows = db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()
  let docs = 0
  let events = 0
  let skipped = 0
  let invalid = 0
  for (const row of rows) {
    const exists = db.prepare('SELECT COUNT(*) c FROM doc_events WHERE doc_type=? AND doc_id=?').get(docType, row.id).c
    if (exists > 0) {
      skipped += 1
      continue
    }
    const chain = chains[row.status]
    if (!chain) {
      invalid += 1
      console.warn(`  ⚠️ ${table}#${row.id} 状态「${row.status}」不在内核状态里，只补登记`)
    }
    // 基线时间：优先取业务日期（req_date）—— 留痕应该长得像「那天真发生了」，
    // 而不是像「今天导入的」；链路每步往后推 2 小时（演示数据，只为让轨迹可讲）
    const base = new Date(`${row.req_date || String(row.created_at || '').slice(0, 10)}T09:00:00`)
    let t = Number.isNaN(base.getTime()) ? new Date() : base
    const bump = () => {
      t = new Date(t.getTime() + 2 * 3600 * 1000)
      return t.toISOString().replace('T', ' ').slice(0, 19)
    }
    const actor = { id: null, name: row.applicant || row.created_by || null }
    // ① 建单
    logEvent({
      db, docType, id: row.id, docNo: row.doc_no,
      action: 'create', actionName: '建单（补登）', from: null, to: 'draft',
      actor, source: 'backfill', remark,
      createdAt: t.toISOString().replace('T', ' ').slice(0, 19)
    })
    events += 1
    // ② 沿链路补登：每一步都要能在内核里找到对应动作，找不到就停在这里
    let from = 'draft'
    let broke = false
    for (const action of chain || []) {
      const def = (machine.edges || []).find((a) => a.action === action && a.from_state === from)
      if (!def) {
        console.warn(`  ⚠️ ${table}#${row.id} 内核无动作 ${from} --${action}-->，链路在第 ${events} 条后截断`)
        broke = true
        break
      }
      logEvent({
        db, docType, id: row.id, docNo: row.doc_no,
        action, actionName: `${def.action_name || def.name || action}（补登）`,
        from, to: def.to_state, actor, source: 'backfill', remark,
        createdAt: bump()
      })
      events += 1
      from = def.to_state
    }
    if (!broke && from !== row.status) {
      console.warn(`  ⚠️ ${table}#${row.id} 链路终点「${from}」与单据状态「${row.status}」不一致`)
      invalid += 1
    } else if (!broke) {
      docs += 1
    }
  }
  return { docs, events, skipped, invalid, total: rows.length }
}

for (const ind of industries) {
  const db = getDbFor(ind)
  const tx = db.transaction(() => {
    const yq = backfill(db, {
      docType: 'YQ', table: 'store_requisitions', chains: YQ_CHAIN,
      remark: '补登历史流转（建单时未走单据内核）'
    })
    const dr = backfill(db, {
      docType: 'DR', table: 'dealer_requisitions', chains: DR_CHAIN,
      remark: '补登历史流转（建单时未走单据内核）'
    })
    return { yq, dr }
  })
  const r = tx()
  console.log(`[${ind}] YQ 补登 ${r.yq.docs}/${r.yq.total} 张 / ${r.yq.events} 条（跳过已有 ${r.yq.skipped}，异常 ${r.yq.invalid}）`)
  console.log(`[${ind}] DR 补登 ${r.dr.docs}/${r.dr.total} 张 / ${r.dr.events} 条（跳过已有 ${r.dr.skipped}，异常 ${r.dr.invalid}）`)
}
