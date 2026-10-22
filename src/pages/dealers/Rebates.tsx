/**
 * ============================================================================
 * 文件标识：src/pages/dealers/Rebates.tsx ｜ 返利管理
 * ============================================================================
 * 【职责】返利管理（页面）
 * 【入口】/dealers/rebates
 * 【主要接口】/dealers/rebates/calc
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
 * 页面：返利管理
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Pagination, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { FilterBar, Inp } from '../../components/DataPage'
import { useDict } from '../../hooks/opts'
import { Calculator, RefreshCw } from 'lucide-react'

export default function Rebates() {
  const { rebateStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [period, setPeriod] = useState(new Date().toISOString().slice(0, 7))
  const [busy, setBusy] = useState(false)
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/dealers/rebates', {})

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (keyword && !`${r.dealer_name} ${r.dealer_code} ${r.period}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const calc = async () => {
    if (!confirm(`按 ${period} 期间销售数据重新核算全部经销商返利？`)) return
    setBusy(true)
    try {
      const res: any = await api.post('/dealers/rebates/calc', { period })
      toast(`返利核算完成，共 ${res.data?.count ?? 0} 家经销商`)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const setStatus = async (row: any, status: string) => {
    if (!confirm(`确认将 ${row.dealer_name} 的 ${row.period} 返利标记为「${status === 'paid' ? '已发放' : '已确认'}」？`)) return
    try {
      await api.put(`/dealers/rebates/${row.id}`, { status })
      toast('已更新')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const sum = (key: string) => list.reduce((s: number, r: any) => s + Number(r[key] || 0), 0)

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">返利管理</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">按经销商等级与期间销售净额核算返利，退货自动冲减基数</p>
        </div>
        <div className="flex items-center gap-2">
          <input className="input input-sm" type="month" style={{ width: 140 }} value={period} onChange={(e) => setPeriod(e.target.value)} />
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" disabled={busy} onClick={calc}>
            <Calculator size={13} /> {busy ? '核算中…' : '重新核算返利'}
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="返利记录数" value={fmtInt(total)} sub="全部期间" />
        <StatCard label="销售净额合计" value={`¥${fmtMoney(sum('net_amount'), 0)}`} sub="销售 − 退货" tone="brand" />
        <StatCard label="应返利金额" value={`¥${fmtMoney(sum('rebate_amount'), 0)}`} sub="按当前列表合计" tone="green" />
        <StatCard label="待核算 / 待发放" value={fmtInt(filtered.filter((r: any) => r.status !== 'paid').length)} sub="需跟进处理" tone="amber" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...rebateStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar onReset={() => setKeyword('')}>
        <Inp value={keyword} onChange={setKeyword} placeholder="经销商 / 期间" w={220} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'period', title: '返利期间', width: 100 },
            { key: 'dealer_name', title: '经销商', width: 210 },
            { key: 'dealer_code', title: '编码', width: 100 },
            { key: 'level', title: '等级', width: 90 },
            { key: 'sales_amount', title: '销售金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.sales_amount, 0)}` },
            { key: 'return_amount', title: '退货金额', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.return_amount, 0)}` },
            { key: 'net_amount', title: '净额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.net_amount, 0)}` },
            { key: 'rebate_rate', title: '返利率', width: 80, align: 'right', render: (r) => `${r.rebate_rate}%` },
            { key: 'rebate_amount', title: '返利金额', width: 120, align: 'right', render: (r) => <span className="font-medium">¥{fmtMoney(r.rebate_amount)}</span> },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} text={rebateStatus.find((x) => x.value === r.status)?.label} /> },
            {
              key: '__act',
              title: '操作',
              width: 110,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  {r.status === 'pending' && <button className="link" onClick={() => setStatus(r, 'confirmed')}>确认</button>}
                  {r.status === 'confirmed' && <button className="link" onClick={() => setStatus(r, 'paid')}>标记发放</button>}
                </div>
              )
            }
          ]}
          data={filtered}
          loading={loading}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>
    </div>
  )
}
