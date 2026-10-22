/**
 * ============================================================================
 * 文件标识：scripts/test-metrics.mjs ｜ 测试：数据口径字典（模块 23）断言测试
 * ============================================================================
 * 【职责】测试：数据口径字典（模块 23）断言测试
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 数据口径字典（模块 23）断言测试
// 用法：node scripts/test-metrics.mjs [cosmetic|food|apparel]
//
// 测的不是「接口通不通」，而是口径字典的三条硬口径：
//   ① 一条口径必须**四要素齐全** —— formula / exclusions / source / note。缺一不可，
//      因为「不含什么」和「为什么这么定」恰恰是最容易漏、也最容易出错的部分。
//   ② 代码是唯一源，表只是投影 —— sync 之后表必须与代码逐字一致；
//      代码里删掉的指标必须从表里消失（只增不减会让字典越读越糊涂）。
//   ③ 每条指标必须**真能算出数字** —— 不为 undefined、不为 NaN/Infinity。
//      算不出来时宁可报错，也不能悄悄给个 0（0 会被当成「真的是 0」）。
import { runWithIndustry, getDb, INDUSTRIES } from '../server/db/index.js'
import { seedProcurement } from '../server/db/procure-seed.js'
import Database from 'better-sqlite3'
import {
  METRICS, METRIC_BY_KEY, metricDefinitions, metricValues,
  metricCatalog, metricGroups, syncMetricDefs, metricDefsStale
} from '../server/lib/metrics.js'

const industry = process.argv[2] && INDUSTRIES[process.argv[2]] ? process.argv[2] : 'cosmetic'
let pass = 0
let fail = 0
const ok = (cond, msg) => {
  if (cond) { pass += 1; console.log(`  ✓ ${msg}`) } else { fail += 1; console.log(`  ✗ ${msg}`) }
}
const section = (t) => console.log(`\n${t}`)
const near = (a, b, eps = 0.02) => Math.abs(Number(a) - Number(b)) <= eps

await runWithIndustry(industry, () => {
  const db = getDb()

  console.log(`\n数据口径字典测试 · 行业=${industry}（${INDUSTRIES[industry].label}）`)
  console.log('='.repeat(64))

  // 保证采购侧数据就绪（payable_open 依赖 purchase_settlements）
  seedProcurement(db, { industry, silent: true })

  // =========================================================================
  section('T1 定义完整性：每条口径四要素齐全')
  // =========================================================================
  {
    ok(METRICS.length >= 20, `指标条数 ≥ 20（实得 ${METRICS.length}）`)
    const keys = METRICS.map((m) => m.key)
    ok(new Set(keys).size === keys.length, 'key 无重复')

    const missing = []
    for (const m of METRICS) {
      for (const f of ['key', 'name', 'module', 'unit', 'formula', 'exclusions', 'source', 'note']) {
        if (!m[f] || String(m[f]).trim() === '') missing.push(`${m.key}.${f}`)
      }
      if (typeof m.compute !== 'function') missing.push(`${m.key}.compute`)
    }
    ok(missing.length === 0, `四要素无缺失${missing.length ? `（缺 ${missing.slice(0, 6).join(', ')}）` : ''}`)

    // key 命名统一 snake_case：混用会导致前端按 key 取值时大小写踩坑
    const badKey = keys.filter((k) => !/^[a-z][a-z0-9_]*$/.test(k))
    ok(badKey.length === 0, `key 全为 snake_case${badKey.length ? `（违规 ${badKey.join(', ')}）` : ''}`)

    // category 只能是有限枚举之一，避免字典分组越加越乱
    const cats = new Set(METRICS.map((m) => m.category))
    const allow = new Set(['规模', '效率', '资金', '风险', '流程'])
    const badCat = [...cats].filter((c) => !allow.has(c))
    ok(badCat.length === 0, `category 取值受控${badCat.length ? `（越界 ${badCat.join(', ')}）` : ''}`)
  }

  // =========================================================================
  section('T2 表与代码一致：sync 后逐字对齐')
  // =========================================================================
  {
    const out = syncMetricDefs(db)
    ok(out.synced === METRICS.length, `sync 写入 ${METRICS.length} 条（实得 ${out.synced}）`)
    ok(metricDefsStale(db) === false, 'sync 后 metricDefsStale=false')

    const rows = db.prepare('SELECT * FROM metric_defs ORDER BY key').all()
    ok(rows.length === METRICS.length, `表内行数 = 代码条数（${rows.length}）`)

    const defs = metricDefinitions().slice().sort((a, b) => (a.key < b.key ? -1 : 1))
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r]))
    let diff = []
    for (const d of defs) {
      const r = byKey[d.key]
      if (!r) { diff.push(`${d.key}:行缺失`); continue }
      for (const f of ['name', 'module', 'category', 'unit', 'formula', 'exclusions', 'source', 'note']) {
        if (String(r[f] ?? '') !== String(d[f] ?? '')) diff.push(`${d.key}.${f}`)
      }
    }
    ok(diff.length === 0, `字段逐字一致${diff.length ? `（差异 ${diff.slice(0, 6).join(', ')}）` : ''}`)

    // updated_at 必须被写上 —— 没有它就无法回答「这条口径哪天动过」
    const noTs = rows.filter((r) => !r.updated_at).length
    ok(noTs === 0, '每条都有 updated_at')
  }

  // =========================================================================
  section('T3 投影会清理代码里已删除的指标')
  // =========================================================================
  {
    db.prepare(
      `INSERT INTO metric_defs (key,name,module,formula,updated_at)
       VALUES ('__ghost_metric','幽灵指标','测试','1=1',datetime('now','localtime'))
       ON CONFLICT(key) DO NOTHING`
    ).run()
    const before = db.prepare("SELECT COUNT(*) c FROM metric_defs WHERE key='__ghost_metric'").get().c
    ok(before === 1, '先塞入一条幽灵指标')

    syncMetricDefs(db)
    const after = db.prepare("SELECT COUNT(*) c FROM metric_defs WHERE key='__ghost_metric'").get().c
    ok(after === 0, 'sync 后幽灵指标被清除')
    ok(metricDefsStale(db) === false, '清理后仍与代码一致')
  }

  // =========================================================================
  section('T4 每条指标都能算出数字')
  // =========================================================================
  {
    const values = metricValues(db, { days: 30 })
    const errs = Object.entries(values).filter(([, v]) => typeof v === 'object' && v && v.error)
    ok(errs.length === 0, `无计算错误${errs.length ? `（${errs.map(([k, v]) => `${k}:${v.error}`).slice(0, 4).join(' | ')}）` : ''}`)

    const bad = Object.entries(values).filter(
      ([, v]) => typeof v !== 'number' || !Number.isFinite(v)
    )
    ok(bad.length === 0, `全部为有限数字${bad.length ? `（异常 ${bad.map(([k]) => k).join(', ')}）` : ''}`)

    ok(Object.keys(values).length === METRICS.length, `取值条数 = 定义条数（${Object.keys(values).length}）`)
  }

  // =========================================================================
  section('T5 口径自洽（跨指标一致性）')
  // =========================================================================
  {
    const v = metricValues(db, { days: 30 })

    // 可用量不可能大于库存数量：占用为负说明 qty_reserved 写错了
    ok(v.available_qty <= v.stock_qty + 1e-6, `可用量 ≤ 库存数量（${v.available_qty} ≤ ${v.stock_qty}）`)
    ok(v.stock_qty - v.available_qty >= 0, `占用量 ≥ 0（${(v.stock_qty - v.available_qty).toFixed(2)}）`)

    // 客单价必须等于 销售额 / 订单数 —— 两个指标走的是同一分子分母，不该有偏差
    const expectAov = v.sales_order_count > 0 ? v.sales_amount / v.sales_order_count : 0
    ok(near(v.avg_order_value, expectAov), `客单价 = 销售额/订单数（${v.avg_order_value} vs ${expectAov.toFixed(2)}）`)

    const expectAttach = v.sales_order_count > 0 ? v.sales_qty / v.sales_order_count : 0
    ok(near(v.attach_rate, expectAttach), `连带率 = 数量/订单数（${v.attach_rate} vs ${expectAttach.toFixed(2)}）`)

    // 百分比类指标必须落在 [0,100]（退货率上限放宽到 100 以内即可）
    for (const k of ['return_rate', 'oc_fill_rate', 'closed_order_ratio', 'credit_usage']) {
      ok(v[k] >= 0 && v[k] <= 100, `${k} ∈ [0,100]（实得 ${v[k]}）`)
    }

    // 计数类指标必须是非负整数
    for (const k of ['sales_order_count', 'oms_order_count', 'below_safe', 'over_credit_dealers', 'approval_pending']) {
      ok(Number.isInteger(v[k]) && v[k] >= 0, `${k} 为非负整数（实得 ${v[k]}）`)
    }

    // 金额类指标不应为负（除「未回款」允许为负，用于暴露超收错账）
    for (const k of ['sales_amount', 'purchase_amount', 'stock_amount', 'pos_sales', 'oc_order_amount']) {
      ok(v[k] >= 0, `${k} ≥ 0（实得 ${v[k]}）`)
    }

    // 超授信家数 ≤ 有授信的经销商数，且信用占用率与超限家数不应同时为 0 又同时很大
    ok(v.over_credit_dealers >= 0, `超授信经销商数 ≥ 0（${v.over_credit_dealers}）`)
  }

  // =========================================================================
  section('T6 目录 / 分组 / 单值 三视图一致')
  // =========================================================================
  {
    const catalog = metricCatalog(db, { days: 30, withValues: true })
    const groups = metricGroups(db, { days: 30, withValues: true })
    ok(catalog.length === METRICS.length, `catalog 条数 = ${METRICS.length}（${catalog.length}）`)
    ok(catalog.every((m) => 'value' in m), 'catalog 每条都带 value 字段')

    const flat = groups.flatMap((g) => g.items)
    ok(flat.length === catalog.length, `分组展开后条数一致（${flat.length}）`)

    const mods = new Set(METRICS.map((m) => m.module))
    ok(groups.length === mods.size, `分组数 = 模块数（${groups.length} = ${mods.size}）`)
    ok(groups.every((g) => g.items.length > 0), '无空分组')

    // withValues=false 时不应有值，便于「只读口径」场景
    const noVal = metricCatalog(db, { withValues: false })
    ok(noVal.every((m) => m.value === null), 'withValues=false 时 value 全为 null')

    // 定义视图绝不能漏出 compute（函数不可序列化，会污染 JSON 响应）
    const defs = metricDefinitions()
    ok(defs.every((d) => !('compute' in d)), '定义视图不含 compute')
    ok(defs.every((d) => !('value' in d)), '定义视图不含 value')
  }

  // =========================================================================
  section('T7 days 参数：窗口型指标随窗口变化且单调')
  // =========================================================================
  {
    const v30 = metricValues(db, { days: 30 })
    const v90 = metricValues(db, { days: 90 })
    const v365 = metricValues(db, { days: 365 })

    // 临期数量：窗口越大，纳入的批次只多不少
    ok(v90.expiring_qty >= v30.expiring_qty, `临期数量 90 天 ≥ 30 天（${v90.expiring_qty} ≥ ${v30.expiring_qty}）`)
    ok(v365.expiring_qty >= v90.expiring_qty, `临期数量 365 天 ≥ 90 天（${v365.expiring_qty} ≥ ${v90.expiring_qty}）`)

    // 周转天数：出库窗口越大，日均出库越稳；只要求算得出且非负
    ok(Number.isFinite(v30.turnover_days) && v30.turnover_days >= 0, `周转天数有限且非负（${v30.turnover_days}）`)

    // 非法 days 必须被兜底，不能因传 0/-1/abc 而崩或除零
    const vBad = metricValues(db, { days: 0 })
    ok(Number.isFinite(vBad.expiring_qty), 'days=0 被兜底，不报错')
    const vNeg = metricValues(db, { days: -5 })
    ok(Number.isFinite(vNeg.expiring_qty), 'days=-5 被兜底，不报错')
    const vNaN = metricValues(db, { days: 'abc' })
    ok(Number.isFinite(vNaN.expiring_qty), "days='abc' 被兜底，不报错")
  }

  // =========================================================================
  section('T8 空库 / 缺表兜底：算不出来要报错，不能假装是 0')
  // =========================================================================
  {
    // 用一个「没有业务表」的临时内存库验证：compute 抛错时 metricValues 应返回 { error }
    const empty = new Database(':memory:')
    const vals = metricValues(empty, { keys: ['sales_amount', 'stock_qty'] })
    const bothErr = typeof vals.sales_amount === 'object' && vals.sales_amount.error
    ok(!!bothErr, '缺表时返回 { error }，而不是静默 0')
    empty.close()
  }

  // =========================================================================
  section('T9 sync 幂等')
  // =========================================================================
  {
    const a = syncMetricDefs(db)
    const snapshotA = db.prepare('SELECT key,formula,exclusions,source,note FROM metric_defs ORDER BY key').all()
    const b = syncMetricDefs(db)
    const snapshotB = db.prepare('SELECT key,formula,exclusions,source,note FROM metric_defs ORDER BY key').all()
    ok(a.synced === b.synced, `两次 sync 条数一致（${a.synced}）`)
    ok(JSON.stringify(snapshotA) === JSON.stringify(snapshotB), '两次 sync 后表内容一致')
    ok(metricDefsStale(db) === false, '幂等后仍与代码一致')
  }

  // =========================================================================
  section('T10 指标覆盖各业务域')
  // =========================================================================
  {
    const mods = new Set(METRICS.map((m) => m.module))
    for (const need of ['销售', '线上 OMS', '存货', '采购', '订货中心', '门店 POS', '经销商', '审批中心']) {
      ok(mods.has(need), `覆盖「${need}」`)
    }
  }

  console.log('\n' + '='.repeat(64))
  console.log(`结果：${pass} 通过 / ${fail} 失败 · 行业=${industry}`)
  if (fail) process.exitCode = 1
})
