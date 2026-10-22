/**
 * ============================================================================
 * 文件标识：src/pages/demand/DealerRequisitions.tsx ｜ 经销商要货
 * ============================================================================
 * 【职责】经销商要货（页面）
 * 【入口】/dealers/requisitions
 * 【主要接口】/demand/dealer/plans
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
 * 页面：经销商要货
 */

import { useEffect, useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList, useFetch } from '../../components/ui'
import { RefreshCw } from 'lucide-react'

export default function DealerRequisitions() {
  const [tab, setTab] = useState('req')
  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">经销商要货</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">经销商要货申请与滚动要货计划，是总部按时间段汇总净需求的输入来源</p>
        </div>
      </div>
      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: 'req', label: '要货申请' }, { key: 'plan', label: '要货计划' }]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>
      {tab === 'req' ? <Requisitions /> : <Plans />}
    </div>
  )
}

function Requisitions() {
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/demand/dealer/requisitions', {})
  const [detail, setDetail] = useState<any>(null)
  const open = async (row: any) => {
    const r = await api.get(`/demand/dealer/requisitions/${row.id}`)
    setDetail(r.data)
  }
  const setStatus = async (status: string) => {
    try {
      const r = await api.post(`/demand/dealer/requisitions/${detail.id}/status`, { status })
      setDetail(r.data)
      reload()
      toast('状态已更新')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }
  return (
    <>
      <div className="flex justify-end mb-2">
        <button className="btn-ghost btn-sm" onClick={() => reload()}><RefreshCw size={13} /> 刷新</button>
      </div>
      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '申请单号', width: 150 },
            { key: 'dealer_name', title: '经销商', width: 210 },
            { key: 'region', title: '区域', width: 80 },
            { key: 'level', title: '等级', width: 90 },
            { key: 'req_date', title: '申请日期', width: 110 },
            { key: 'expect_date', title: '期望到货', width: 110 },
            { key: 'item_count', title: '行数', width: 60, align: 'right' },
            { key: 'total_qty', title: '要货数量', width: 90, align: 'right', render: (r) => fmtInt(r.total_qty) },
            { key: 'total_amount', title: '金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_amount)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} text={r.status_name} /> },
            { key: '__act', title: '操作', width: 80, render: (r) => <button className="link text-[12px]" onClick={() => open(r)}>查看</button> }
          ]}
          data={list}
          loading={loading}
          onRowClick={open}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={!!detail} title={`要货申请 ${detail?.doc_no || ''}`} width={880} onClose={() => setDetail(null)}
        footer={
          detail && (
            <div className="flex items-center gap-2">
              {['submitted'].includes(detail.status) && (
                <>
                  <button className="btn-ghost" onClick={() => setStatus('approved')}>确认</button>
                  <button className="btn-ghost text-red-600" onClick={() => setStatus('rejected')}>驳回</button>
                </>
              )}
            </div>
          )
        }
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4 text-[12px]">
              <div><span className="text-slate-400">经销商：</span>{detail.dealer_name}</div>
              <div><span className="text-slate-400">区域：</span>{detail.region} · {detail.city}</div>
              <div><span className="text-slate-400">状态：</span><Status value={detail.status} text={detail.status_name} /></div>
              <div><span className="text-slate-400">申请日期：</span>{detail.req_date}</div>
              <div><span className="text-slate-400">期望到货：</span>{detail.expect_date || '—'}</div>
              <div><span className="text-slate-400">申请人：</span>{detail.applicant || '—'}</div>
            </div>
            <Table
              columns={[
                { key: 'sku_code', title: 'SKU', width: 120 },
                { key: 'product_name', title: '商品', width: 220, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
                { key: 'qty', title: '要货量', width: 90, align: 'right', render: (r) => fmtInt(r.qty) },
                { key: 'price', title: '单价', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.price)}` },
                { key: 'amount', title: '金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` }
              ]}
              data={detail.items || []}
            />
            {detail.linked_order_nos && <div className="mt-3 text-[12px] text-slate-500">已转单据：{detail.linked_order_nos}</div>}
          </div>
        )}
      </Modal>
    </>
  )
}

function Plans() {
  const [period, setPeriod] = useState('')
  const { data, loading, reload } = useFetch<any>('/demand/dealer/plans', period ? { period } : {}, [period])
  const byDealer = data?.byDealer || []
  const rows = data?.rows || []
  const periods = data?.periods || []
  useEffect(() => {
    if (!period && periods.length) setPeriod(periods[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periods.length])
  const totalQty = rows.reduce((s: number, x: any) => s + Number(x.plan_qty || 0), 0)
  const totalAmt = rows.reduce((s: number, x: any) => s + Number(x.plan_amount || 0), 0)
  return (
    <div>
      <Card pad={false} className="mb-3">
        <div className="p-3 flex items-center gap-3 flex-wrap">
          <span className="text-[12px] text-slate-500">要货期间</span>
          <select className="input input-sm" style={{ width: 140 }} value={period} onChange={(e) => setPeriod(e.target.value)}>
            <option value="">全部期间</option>
            {periods.map((p: string) => <option key={p} value={p}>{p}</option>)}
          </select>
          <span className="text-[12px] text-slate-400">共 {byDealer.length} 个经销商-期间组合 · 计划 {fmtInt(totalQty)} 件 · ¥{fmtMoney(totalAmt)}</span>
          <button className="btn-ghost btn-sm ml-auto" onClick={() => reload()}><RefreshCw size={13} /> 刷新</button>
        </div>
      </Card>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Card pad={false}>
          <div className="px-3 py-2 text-[13px] font-medium text-slate-700 border-b border-ink-100">按经销商 / 期间汇总</div>
          <Table
            columns={[
              { key: 'dealer_name', title: '经销商', width: 200 },
              { key: 'period', title: '期间', width: 90 },
              { key: 'sku_lines', title: 'SKU 数', width: 80, align: 'right' },
              { key: 'plan_qty', title: '计划数量', width: 100, align: 'right', render: (r) => fmtInt(r.plan_qty) },
              { key: 'plan_amount', title: '计划金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.plan_amount)}` }
            ]}
            data={byDealer}
            loading={loading}
          />
        </Card>
        <Card pad={false}>
          <div className="px-3 py-2 text-[13px] font-medium text-slate-700 border-b border-ink-100">计划明细（Top 50）</div>
          <Table
            columns={[
              { key: 'dealer_name', title: '经销商', width: 170 },
              { key: 'product_name', title: '商品', width: 190, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
              { key: 'period', title: '期间', width: 90 },
              { key: 'plan_qty', title: '计划量', width: 90, align: 'right', render: (r) => fmtInt(r.plan_qty) },
              { key: 'plan_amount', title: '金额', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.plan_amount)}` }
            ]}
            data={rows.slice(0, 50)}
            loading={loading}
          />
        </Card>
      </div>
    </div>
  )
}
