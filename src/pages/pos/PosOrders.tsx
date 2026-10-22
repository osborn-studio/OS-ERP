/**
 * ============================================================================
 * 文件标识：src/pages/pos/PosOrders.tsx ｜ 门店单据明细
 * ============================================================================
 * 【职责】门店单据明细（页面）
 * 【入口】/store/pos-orders、/pos/hq/orders
 * 【主要接口】/pos/hq/orders、/pos/hq/overview
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
 * 页面：门店单据明细
 */

import { useEffect, useState } from 'react'
import api from '../../api/client'
import { Card } from '../../components/ui'

const fmt = (n: number) => '¥' + Math.round(Number(n || 0)).toLocaleString()
const ST: any = { local: '本机未上传', synced: '已上传总部', voided: '已作废' }
const PAY: any = { cash: '现金', wxpay: '微信', alipay: '支付宝', unionpay: '银联', balance: '储值' }

/** 总部：门店 POS 单据明细 */
export default function PosOrders() {
  const [rows, setRows] = useState<any[]>([])
  const [stores, setStores] = useState<any[]>([])
  const [storeId, setStoreId] = useState('')
  const [status, setStatus] = useState('')

  const load = () =>
    api.get('/pos/hq/orders', { store_id: storeId || '' }).then((r: any) => {
      const l = (r.data || r) as any[]
      setRows(status ? l.filter((x) => x.status === status) : l)
    })
  useEffect(() => {
    api.get('/pos/hq/overview').then((r: any) => setStores((r.data || r).stores || []))
  }, [])
  useEffect(() => { load() }, [storeId, status])

  return (
    <div>
      <div className="mb-3">
        <h1 className="text-[17px] font-medium text-ink-900 title-serif">门店单据明细</h1>
        <p className="text-[12px] text-slate-400 mt-0.5">门店零售本机单与已上传总部的单据，含对应总部销售单号</p>
      </div>

      <Card className="mb-3" pad>
        <div className="flex items-center gap-2 flex-wrap">
          <select className="input w-auto min-w-[180px]" value={storeId} onChange={(e) => setStoreId(e.target.value)}>
            <option value="">全部门店</option>
            {stores.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          {[['', '全部状态'], ['local', '本机未上传'], ['synced', '已上传总部'], ['voided', '已作废']].map(([k, l]) => (
            <button key={k} onClick={() => setStatus(k)}
              className={`px-2.5 py-1.5 rounded text-[12px] border ${status === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'}`}>
              {l}
            </button>
          ))}
          <span className="ml-auto text-[12px] text-slate-400">共 {rows.length} 笔</span>
        </div>
      </Card>

      <Card>
        <div className="overflow-x-auto">
          <table className="w-full text-[12px] min-w-[900px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">单号</th>
                <th className="px-3 py-2 text-left font-medium">门店</th>
                <th className="px-3 py-2 text-left font-medium">业务日期</th>
                <th className="px-3 py-2 text-left font-medium">会员</th>
                <th className="px-3 py-2 text-right font-medium">金额</th>
                <th className="px-3 py-2 text-left font-medium">支付</th>
                <th className="px-3 py-2 text-left font-medium">状态</th>
                <th className="px-3 py-2 text-left font-medium">日结批次</th>
                <th className="px-3 py-2 text-left font-medium">收银</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-ink-100">
                  <td className="px-3 py-2 font-mono text-ink-900">{r.doc_no}</td>
                  <td className="px-3 py-2">{r.store_name}</td>
                  <td className="px-3 py-2 text-slate-500">{r.biz_date}</td>
                  <td className="px-3 py-2 text-slate-500">{r.member_phone || '散客'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-brand-700">{fmt(r.pay_amount)}</td>
                  <td className="px-3 py-2 text-slate-500">{PAY[r.pay_method] || r.pay_method}</td>
                  <td className="px-3 py-2">
                    <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.status === 'synced' ? 'bg-brand-50 text-brand-700' : r.status === 'local' ? 'bg-amber-50 text-amber-600' : 'bg-slate-100 text-slate-400'}`}>
                      {ST[r.status] || r.status}
                    </span>
                  </td>
                  <td className="px-3 py-2 font-mono text-[11px] text-slate-400">{r.sync_batch || '—'}</td>
                  <td className="px-3 py-2 text-slate-500">{r.cashier_name}</td>
                </tr>
              ))}
              {!rows.length && <tr><td colSpan={9} className="px-3 py-8 text-center text-slate-400">暂无单据</td></tr>}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
