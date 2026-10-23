/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Payables.tsx ｜ 应付账款台账
 * ============================================================================
 * 【职责】应付账款台账（页面）
 * 【入口】/purchase/payables
 * 【主要接口】/purchase/payables
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自本页自己的标题**、
 *   入口取自 `src/App.tsx` 的路由表、接口取自本页实际调用的接口（**都不是新编的**）。
 *   人工完善时补：这页回答用户的什么问题 / 为什么这样组织 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处；下拉选项从 `/api/meta/*` 取，不要在页面里写死；
 *   改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */
/**
 * 页面：应付账款台账
 */

import { useState } from 'react'
import ScopeNotice, { ScopeBlocked, firstFailure, isBlocked } from '../../components/ScopeNotice'
import { Card, StatCard, Table, fmtInt, fmtMoney, useFetch } from '../../components/ui'
import { Inp } from '../../components/DataPage'
import { RefreshCw, AlertTriangle } from 'lucide-react'

/**
 * 应付账款台账（模块 07）。
 *
 * 一页回答财务三个问题：欠谁 / 欠多少 / 其中多少是还没到票的暂估。
 * 与结算单同一口径：`未结清 = 结算金额 − 已付`，而「已付」永远是按**生效核销明细**汇出来的。
 *
 * 暂估差异（diff_amount）单独一列展示、**不进任何合计** —— 它只是「票面与入库的差额」的账面留痕，
 * 跟「欠多少」不是一回事；把它并进应付会让人误以为要按差异金额付钱。
 */
export default function Payables() {
  const { data, loading, reload, errorStatus, errorCode } = useFetch<any>('/purchase/payables')
  const failure = { errorStatus, errorCode }
  const [keyword, setKeyword] = useState('')
  const rows: any[] = (data?.list || []).filter(
    (r: any) => !keyword || `${r.supplier_code} ${r.supplier_name}`.toLowerCase().includes(keyword.toLowerCase())
  )
  const total = data?.total || {}
  const shown = rows.reduce(
    (a, x) => ({
      settle_amount: a.settle_amount + Number(x.settle_amount || 0),
      paid_amount: a.paid_amount + Number(x.paid_amount || 0),
      open_amount: a.open_amount + Number(x.open_amount || 0),
      diff_amount: a.diff_amount + Number(x.diff_amount || 0)
    }),
    { settle_amount: 0, paid_amount: 0, open_amount: 0, diff_amount: 0 }
  )
  const t = keyword ? shown : total

  if (isBlocked(failure)) return <ScopeBlocked failure={failure} onRetry={reload} />

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">应付账款台账</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            按供应商汇总已结算 / 已付 / 未结清；暂估差异单独列示，不进应付合计
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reload}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <ScopeNotice failure={failure} rows={data ? data.list || [] : null} loading={loading} />

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="累计已结算" value={`¥${fmtMoney(t.settle_amount, 0)}`} sub={`${rows.length} 个供应商`} tone="brand" />
        <StatCard label="累计已付" value={`¥${fmtMoney(t.paid_amount, 0)}`} sub="按生效核销明细汇总" tone="red" />
        <StatCard label="应付未结清" value={`¥${fmtMoney(t.open_amount, 0)}`} sub="结算金额 − 已付" tone="amber" />
        <StatCard label="暂估差异" value={`¥${fmtMoney(t.diff_amount, 0)}`} sub="单独列示，不进合计" />
      </div>

      <Card className="mb-3" pad={false}>
        <div className="p-3 flex items-center gap-2">
          <Inp value={keyword} onChange={setKeyword} placeholder="供应商编码 / 名称" w={240} />
          {keyword && <span className="text-[12px] text-ink-500">已按关键字筛选（合计随筛选变化）</span>}
        </div>
      </Card>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'supplier_code', title: '供应商编码', width: 110 },
            { key: 'supplier_name', title: '供应商', width: 230 },
            { key: 'settle_type', title: '结算方式', width: 120 },
            { key: 'settle_count', title: '结算单数', width: 90, align: 'right' },
            { key: 'settle_amount', title: '已结算金额', width: 130, align: 'right', render: (r) => `¥${fmtMoney(r.settle_amount)}` },
            { key: 'paid_amount', title: '已付金额', width: 130, align: 'right', render: (r) => `¥${fmtMoney(r.paid_amount)}` },
            {
              key: 'open_amount',
              title: '应付未结清',
              width: 140,
              align: 'right',
              render: (r) => (
                <span className={Number(r.open_amount) > 0.01 ? 'text-amber-700 font-medium' : 'text-ink-400'}>¥{fmtMoney(r.open_amount)}</span>
              )
            },
            {
              key: 'diff_amount',
              title: '暂估差异',
              width: 130,
              align: 'right',
              render: (r) => (Math.abs(Number(r.diff_amount)) > 0.01 ? `¥${fmtMoney(r.diff_amount)}` : '—')
            }
          ]}
          data={rows}
          loading={loading}
          empty="暂无应付数据"
        />
        <div className="px-3 pb-3 pt-2 text-[12px] text-ink-500 flex items-center gap-1.5">
          <AlertTriangle size={12} />
          暂估差异列只作留痕，不参与「应付未结清」的加总；要按差异调账请走结算单的重结或红字发票。
        </div>
      </Card>
    </div>
  )
}
