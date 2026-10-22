/**
 * ============================================================================
 * 文件标识：src/pages/demand/ProductionOrders.tsx ｜ 生产订单
 * ============================================================================
 * 【职责】生产订单（页面）
 * 【入口】/plan/production
 * 【主要接口】无（纯展示或纯表单）
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
 * 页面：生产订单
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Modal, Pagination, Status, Table, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { Factory, RefreshCw } from 'lucide-react'

const FLOW: Record<string, { action: string; label: string }[]> = {
  draft: [{ action: 'submit', label: '提交' }],
  submitted: [{ action: 'approve', label: '审批通过' }],
  approved: [{ action: 'start', label: '开工投产' }],
  in_progress: [{ action: 'close', label: '完工关闭' }],
  completed: [{ action: 'close', label: '关闭' }]
}

export default function ProductionOrders() {
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/demand/production/orders', {})
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const filtered = status ? list.filter((r: any) => r.status === status) : list

  const open = async (row: any) => {
    const r = await api.get(`/demand/production/orders/${row.id}`)
    setDetail(r.data)
  }

  const act = async (action: string) => {
    try {
      await api.post(`/demand/production/orders/${detail.id}/status`, { action })
      const r = await api.get(`/demand/production/orders/${detail.id}`)
      setDetail(r.data)
      reload()
      toast('已更新')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const STATUS_LABEL: Record<string, string> = {
    draft: '草稿', submitted: '待审批', approved: '已审批', in_progress: '生产中',
    completed: '已完工', closed: '已关闭', cancelled: '已取消'
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">生产订单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">净需求中「自制」部分生成的生产订单：成品产出 + 材料领用清单</p>
        </div>
        <button className="btn-ghost btn-sm" onClick={() => reload()}><RefreshCw size={13} /> 刷新</button>
      </div>

      <div className="flex items-center gap-2 mb-2">
        {[['', '全部'], ['draft', '草稿'], ['submitted', '待审批'], ['approved', '已审批'], ['in_progress', '生产中'], ['completed', '已完工']].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`px-2.5 py-1 rounded text-[12px] border ${status === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'}`}>{l}</button>
        ))}
      </div>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '生产单号', width: 150 },
            { key: 'product_name', title: '产出成品', width: 220, render: (r) => `${r.product_name} ${r.sku_name || ''}` },
            { key: 'warehouse_name', title: '完工入库仓', width: 140 },
            { key: 'plan_date', title: '计划开工', width: 110 },
            { key: 'qty', title: '计划产量', width: 90, align: 'right', render: (r) => fmtInt(r.qty) },
            { key: 'completed_qty', title: '已完工', width: 80, align: 'right', render: (r) => fmtInt(r.completed_qty) },
            { key: 'unit_cost', title: '单位成本', width: 100, align: 'right', render: (r) => `¥${fmtMoney(r.unit_cost)}` },
            { key: 'total_cost', title: '计划总成本', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.total_cost)}` },
            { key: 'status', title: '状态', width: 90, render: (r) => <Status value={r.status} text={STATUS_LABEL[r.status] || r.status} /> },
            { key: '__act', title: '操作', width: 80, render: (r) => <button className="link text-[12px]" onClick={() => open(r)}>详情</button> }
          ]}
          data={filtered}
          loading={loading}
          onRowClick={open}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={!!detail} title={`生产订单 ${detail?.doc_no || ''}`} width={880} onClose={() => setDetail(null)}
        footer={
          detail && (
            <div className="flex items-center gap-2">
              {(FLOW[detail.status] || []).map((f) => (
                <button key={f.action} className="btn-primary" onClick={() => act(f.action)}>
                  <Factory size={14} /> {f.label}
                </button>
              ))}
            </div>
          )
        }
      >
        {detail && (
          <div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 text-[12px]">
              <div><span className="text-slate-400">产出成品：</span>{detail.product_name} {detail.sku_name}</div>
              <div><span className="text-slate-400">入库仓：</span>{detail.warehouse_name}</div>
              <div><span className="text-slate-400">计划日期：</span>{detail.plan_date}</div>
              <div><span className="text-slate-400">状态：</span><Status value={detail.status} text={STATUS_LABEL[detail.status] || detail.status} /></div>
              <div><span className="text-slate-400">计划产量：</span>{fmtInt(detail.qty)}</div>
              <div><span className="text-slate-400">已完工：</span>{fmtInt(detail.completed_qty)}</div>
              <div><span className="text-slate-400">材料成本：</span>¥{fmtMoney(detail.material_cost)}</div>
              <div><span className="text-slate-400">总成本：</span>¥{fmtMoney(detail.total_cost)}</div>
            </div>
            <Table
              columns={[
                { key: 'role', title: '类型', width: 80, render: (r) => (r.role === 'product' ? <span className="tag bg-brand-50 text-brand-700">产出</span> : <span className="tag bg-slate-100 text-slate-600">领料</span>) },
                { key: 'sku_code', title: 'SKU', width: 120 },
                { key: 'sku_name', title: '商品', width: 220 },
                { key: 'qty', title: '数量', width: 100, align: 'right', render: (r) => fmtInt(r.qty) },
                { key: 'unit_cost', title: '单位成本', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.unit_cost)}` },
                { key: 'amount', title: '金额', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.amount)}` }
              ]}
              data={detail.items || []}
            />
            {detail.remark && <div className="mt-3 text-[12px] text-slate-500">备注：{detail.remark}</div>}
          </div>
        )}
      </Modal>
    </div>
  )
}
