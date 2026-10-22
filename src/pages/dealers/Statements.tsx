/**
 * ============================================================================
 * 文件标识：src/pages/dealers/Statements.tsx ｜ 经销商对账单
 * ============================================================================
 * 【职责】经销商对账单（页面）
 * 【入口】/dealers/statements
 * 【主要接口】/dealers/statements
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
 * 页面：经销商对账单
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, Pagination, StatCard, Status, Table, Tabs, fmtInt, fmtMoney, toast, useList } from '../../components/ui'
import { DateRange, FilterBar, Inp, Sel } from '../../components/DataPage'
import { useDict, useOpts } from '../../hooks/opts'
import { Plus, RefreshCw } from 'lucide-react'

export default function Statements() {
  const o = useOpts()
  const { statementStatus } = useDict()
  const [tab, setTab] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dealerId, setDealerId] = useState('')
  const [range, setRange] = useState({ from: '', to: '' })
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/dealers/statements', {})
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)

  const filtered = list.filter((r: any) => {
    if (tab && r.status !== tab) return false
    if (dealerId && String(r.dealer_id) !== String(dealerId)) return false
    if (range.from && r.period_end < range.from) return false
    if (range.to && r.period_start > range.to) return false
    if (keyword && !`${r.doc_no} ${r.dealer_name} ${r.dealer_code}`.toLowerCase().includes(keyword.toLowerCase())) return false
    return true
  })

  const sum = (key: string) => filtered.reduce((s: number, r: any) => s + Number(r[key] || 0), 0)

  const setStatus = async (row: any, status: string) => {
    if (!confirm(`确认将对账单 ${row.doc_no} 标记为「${{ confirmed: '已确认', sent: '已发送' }[status] || status}」？`)) return
    try {
      await api.post(`/dealers/statements/${row.id}/status`, { status })
      toast('已更新')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  // 结清：先按"钱真的收齐了"提交；服务端 409（期末应收未收齐）时，
  // 才问一句要不要走「业务判断手动结清」（force）——**必须写明理由**。
  // 这个次序是刻意的：默认路径永远走"收齐"，手动结清是一条显式的越权通道，
  // 不能被"顺手先问理由"变成等价的第二条路。
  const closeStatement = async (row: any) => {
    const reason = prompt(`结清对账单 ${row.doc_no}（可选：填写结清说明）`)
    if (reason === null) return
    try {
      await api.post(`/dealers/statements/${row.id}/close`, { reason: reason || null })
      toast('已结清')
      reload()
    } catch (e: any) {
      if (!String(e.message || '').includes('未收齐')) return toast(e.message, 'error')
      const why = prompt(`${e.message}\n\n走「业务判断手动结清」请写明理由（不少于 5 个字）：`)
      if (!why || why.trim().length < 5) return toast('已取消：手动结清必须写明理由', 'error')
      try {
        await api.post(`/dealers/statements/${row.id}/close`, { reason: why, force: true })
        toast('已手动结清')
        reload()
      } catch (e2: any) {
        toast(e2.message, 'error')
      }
    }
  }

  // 作废：只作废这份对账单凭证，**不动底层应收台账** —— 理由必填，与危险操作留痕同族。
  const voidStatement = async (row: any) => {
    const why = prompt(
      `作废对账单 ${row.doc_no}\n\n请写明作废理由（不少于 5 个字）：\n（作废只作废这份对账单凭证，不改动底层应收台账）`
    )
    if (!why || why.trim().length < 5) return toast('已取消：作废必须写明理由', 'error')
    try {
      await api.post(`/dealers/statements/${row.id}/void`, { reason: why })
      toast('已作废')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const create = async () => {
    if (!form.dealer_id || !form.period_start || !form.period_end) return toast('请选择经销商与对账期间', 'error')
    setSaving(true)
    try {
      await api.post('/dealers/statements', form)
      toast('对账单已生成')
      setOpen(false)
      setForm({})
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">经销商对账单</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">按期汇总期初应收、本期销售、本期回款与期末应收</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={() => setOpen(true)}>
            <Plus size={14} /> 生成对账单
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="对账单数" value={fmtInt(total)} sub="全部期间" />
        <StatCard label="本期销售合计" value={`¥${fmtMoney(sum('sales_amount'), 0)}`} sub="当前筛选范围" tone="brand" />
        <StatCard label="本期回款合计" value={`¥${fmtMoney(sum('received_amount'), 0)}`} sub="当前筛选范围" tone="green" />
        <StatCard label="期末应收合计" value={`¥${fmtMoney(sum('closing_amount'), 0)}`} sub="需持续跟进" tone="amber" />
      </div>

      <Card pad={false} className="mb-3">
        <div className="px-3 pt-2">
          <Tabs
            tabs={[{ key: '', label: '全部' }, ...statementStatus.map((s) => ({ key: String(s.value), label: s.label }))]}
            value={tab}
            onChange={setTab}
          />
        </div>
      </Card>

      <FilterBar
        onReset={() => {
          setKeyword('')
          setDealerId('')
          setRange({ from: '', to: '' })
        }}
      >
        <Inp value={keyword} onChange={setKeyword} placeholder="对账单号 / 经销商" w={220} />
        <Sel value={dealerId} onChange={setDealerId} options={o.dealers} placeholder="全部经销商" w={220} />
        <DateRange from={range.from} to={range.to} onFrom={(v) => setRange({ ...range, from: v })} onTo={(v) => setRange({ ...range, to: v })} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_no', title: '对账单号', width: 150 },
            { key: 'dealer_name', title: '经销商', width: 210 },
            { key: 'period', title: '对账期间', width: 200, render: (r) => `${r.period_start} ~ ${r.period_end}` },
            { key: 'opening_amount', title: '期初应收', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.opening_amount, 0)}` },
            { key: 'sales_amount', title: '本期销售', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.sales_amount, 0)}` },
            { key: 'return_amount', title: '本期退货', width: 110, align: 'right', render: (r) => `¥${fmtMoney(r.return_amount, 0)}` },
            { key: 'received_amount', title: '本期回款', width: 120, align: 'right', render: (r) => `¥${fmtMoney(r.received_amount, 0)}` },
            { key: 'closing_amount', title: '期末应收', width: 120, align: 'right', render: (r) => <span className="font-medium">¥${fmtMoney(r.closing_amount, 0)}</span> },
            { key: 'status', title: '状态', width: 90, render: (r) => (
              // 终局动作的"人 / 时间 / 理由"落在单据列上（closed_* / voided_*），
              // 这里用 title 直接展示 —— 打开列表就能答出"这份账什么时候结清的、谁结的、为什么"，
              // 不必去事件流里翻最后一条。
              <span
                title={
                  r.status === 'closed'
                    ? `结清：${r.closed_at || ''} ${r.closed_by_name || ''} ${r.close_reason || ''}`.trim()
                    : r.status === 'voided'
                      ? `作废：${r.voided_at || ''} ${r.voided_by_name || ''} ${r.void_reason || ''}`.trim()
                      : ''
                }
              >
                <Status value={r.status} text={statementStatus.find((x) => x.value === r.status)?.label} />
              </span>
            ) },
            {
              key: '__act',
              title: '操作',
              width: 160,
              render: (r) => (
                <div className="flex items-center gap-2 text-[12px]">
                  {r.status === 'draft' && <button className="link" onClick={() => setStatus(r, 'confirmed')}>确认</button>}
                  {r.status === 'confirmed' && <button className="link" onClick={() => setStatus(r, 'sent')}>发送客户</button>}
                  {(r.status === 'confirmed' || r.status === 'sent') && (
                    <button className="link" onClick={() => closeStatement(r)}>结清</button>
                  )}
                  {r.status !== 'closed' && r.status !== 'voided' && (
                    <button className="link" onClick={() => voidStatement(r)}>作废</button>
                  )}
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

      <Modal
        open={open}
        title="生成经销商对账单"
        width={600}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={create}>{saving ? '生成中…' : '生成对账单'}</button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-4">
          <Field label="经销商" required span={2}>
            <select className="input" value={form.dealer_id ?? ''} onChange={(e) => setForm({ ...form, dealer_id: e.target.value })}>
              <option value="">请选择</option>
              {o.dealers.map((d) => (
                <option key={d.value} value={d.value}>{d.label}</option>
              ))}
            </select>
          </Field>
          <Field label="期间开始" required>
            <input className="input" type="date" value={form.period_start ?? ''} onChange={(e) => setForm({ ...form, period_start: e.target.value })} />
          </Field>
          <Field label="期间结束" required>
            <input className="input" type="date" value={form.period_end ?? ''} onChange={(e) => setForm({ ...form, period_end: e.target.value })} />
          </Field>
        </div>
        <p className="text-[12px] text-ink-700 mt-3">
          说明：对账单按期间内销售订单、退货与回款自动汇总。生成后为草稿状态，确认后可发送给客户。
        </p>
      </Modal>
    </div>
  )
}
