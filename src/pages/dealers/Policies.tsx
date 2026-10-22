/**
 * ============================================================================
 * 文件标识：src/pages/dealers/Policies.tsx ｜ 返点政策
 * ============================================================================
 * 【职责】返点政策（页面）
 * 【入口】/dealers/policies
 * 【主要接口】/dealers/policies、/dealers/rebates/preview、/dealers/rebates/calc
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
 * 页面：返点政策
 */

import { useState } from 'react'
import { Plus, RefreshCw, Calculator, Pencil, Trash2 } from 'lucide-react'
import api from '../../api/client'
import { Card, Field, Modal, Table, Pagination, toast, useList } from '../../components/ui'
import { FilterBar, Sel } from '../../components/DataPage'
import { useOpts, useDict } from '../../hooks/opts'

const TYPES = [
  { value: 'tiered', label: '阶梯比例返点' },
  { value: 'fixed_per_unit', label: '按件定额返点' },
  { value: 'growth', label: '同比增量返点' },
  { value: 'payback', label: '回款达标返点' },
  { value: 'category', label: '品类专向返点' },
  { value: 'seasonal', label: '档期任务返点' }
]
const TYPE_COLOR: Record<string, string> = {
  tiered: 'bg-brand-50 text-brand-700', fixed_per_unit: 'bg-amber-50 text-amber-600', growth: 'bg-emerald-50 text-emerald-600',
  payback: 'bg-blue-50 text-blue-600', category: 'bg-purple-50 text-purple-600', seasonal: 'bg-red-50 text-red-500'
}
const BASIS_LABEL: Record<string, string> = { net: '净销售（扣退货）', gross: '毛销售', pay: '回款额' }

const DEFAULT_RULES: Record<string, any> = {
  tiered: { tiers: [{ min: 0, max: 100000, rate: 2 }, { min: 100000, max: 300000, rate: 3 }, { min: 300000, max: null, rate: 4.5 }] },
  fixed_per_unit: { perUnit: 1.5 },
  growth: { rate: 3 },
  payback: { payRatio: 0.9, rate: 1.5 },
  category: { categoryId: null, rate: 5 },
  seasonal: { target: 200000, rate: 5 }
}

export default function Policies() {
  const o = useOpts()
  const dict = useDict()
  const { list, total, loading, page, pageSize, setPage, filters, setFilters, reload } = useList('/dealers/policies')
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState<any>({})
  const [rulesText, setRulesText] = useState('')
  const [preview, setPreview] = useState<any>(null)
  const [pv, setPv] = useState<any>({ dealer_id: '', period: new Date().toISOString().slice(0, 7) })

  const openCreate = () => {
    const t = 'tiered'
    setForm({ type: t, dealer_level: 'all', channel_type: 'all', basis: 'net', rebate_cap: 0, priority: 100 })
    setRulesText(JSON.stringify(DEFAULT_RULES[t], null, 2))
    setOpen(true)
  }
  const openEdit = (row: any) => {
    setForm({ ...row })
    setRulesText(typeof row.rules === 'string' ? row.rules : JSON.stringify(row.rules_json || {}, null, 2))
    setOpen(true)
  }
  const setType = (t: string) => {
    setForm({ ...form, type: t })
    setRulesText(JSON.stringify(DEFAULT_RULES[t] || {}, null, 2))
  }

  const submit = async () => {
    if (!form.name) return toast('请填写政策名称', 'error')
    let rules: any
    try {
      rules = JSON.parse(rulesText || '{}')
    } catch {
      return toast('规则体不是合法 JSON', 'error')
    }
    setSaving(true)
    try {
      const body = { ...form, rules }
      if (form.id) await api.put(`/dealers/policies/${form.id}`, body)
      else await api.post('/dealers/policies', body)
      toast(form.id ? '政策已更新' : '政策已创建')
      setOpen(false)
      reload()
    } catch (e: any) {
      toast(e.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: any) => {
    if (!confirm(`确认删除政策「${row.name}」？`)) return
    try {
      await api.del(`/dealers/policies/${row.id}`)
      toast('已删除')
      reload()
    } catch (e: any) {
      toast(e.message || '删除失败', 'error')
    }
  }

  const runPreview = async () => {
    if (!pv.dealer_id || !pv.period) return toast('请选择经销商与期间', 'error')
    try {
      const res = await api.post('/dealers/rebates/preview', pv)
      setPreview(res.data)
    } catch (e: any) {
      toast(e.message || '试算失败', 'error')
    }
  }

  const runCalc = async () => {
    if (!confirm('按当前政策对全部经销商核算本期返点？已有关联政策记录将被覆盖更新')) return
    try {
      const res = await api.post('/dealers/rebates/calc', { period: pv.period })
      toast(`核算完成：${res.data.policy_count} 政策 × ${res.data.dealer_count} 经销商，总返点 ¥${res.data.total_amount.toLocaleString()}`)
    } catch (e: any) {
      toast(e.message || '核算失败', 'error')
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="text-[17px] font-medium text-ink-900 title-serif">返点政策</h1>
          <p className="text-[12px] text-slate-400 mt-0.5">六种形式并行：阶梯 / 按件定额 / 同比增量 / 回款达标 / 品类专向 / 档期任务</p>
        </div>
        <div className="flex items-center gap-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-primary btn-sm" onClick={openCreate}>
            <Plus size={14} /> 新建政策
          </button>
        </div>
      </div>

      <Card className="mb-3" pad>
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="flex items-center gap-1 text-[13px] font-medium text-ink-900"><Calculator size={14} className="text-brand-700" /> 政策试算</span>
          <Sel value={pv.dealer_id} onChange={(v) => setPv({ ...pv, dealer_id: v })} options={o.dealers} placeholder="选择经销商" w={200} />
          <input className="input input-sm w-32" type="month" value={pv.period} onChange={(e) => setPv({ ...pv, period: e.target.value })} />
          <button className="btn-primary btn-sm" onClick={runPreview}>试算（不落库）</button>
          <button className="btn-ghost btn-sm" onClick={runCalc}>正式核算全部经销商</button>
        </div>
        {preview && (
          <div className="mt-3 border-t border-ink-300 pt-3">
            <div className="text-[12px] text-slate-500 mb-2">
              {preview.dealer.name} · {preview.period} · 政策适用 <b className="text-ink-900">{preview.policies.filter((x: any) => x.applicable).length}</b>/{preview.policies.length} ·
              预计总返点 <b className="text-brand-700 text-[14px]">¥{preview.total_rebate.toLocaleString()}</b>
            </div>
            <Table
              columns={[
                { key: 'policy_type_name', title: '政策形式', width: 130, render: (r: any) => (
                  <span className={`px-1.5 py-0.5 rounded text-[11px] ${TYPE_COLOR[r.policy_type] || ''}`}>{r.policy_type_name}</span>
                ) },
                { key: 'policy_name', title: '政策', width: 170 },
                { key: 'applicable', title: '适用', width: 60, align: 'center', render: (r: any) => r.applicable ? '✓' : <span className="text-slate-300">—</span> },
                { key: 'matched', title: '命中', width: 60, align: 'center', render: (r: any) => r.matched ? <span className="text-emerald-600">✓</span> : <span className="text-slate-300">—</span> },
                { key: 'basis_desc', title: '计返口径', render: (r: any) => <span className="text-[12px] text-slate-600">{r.basis_desc || '—'}</span> },
                { key: 'rebate_amount', title: '返点金额', width: 110, align: 'right', render: (r: any) => (
                  <span className={`font-medium ${r.rebate_amount > 0 ? 'text-brand-700' : 'text-slate-300'}`}>¥{r.rebate_amount.toLocaleString()}</span>
                ) }
              ]}
              data={preview.policies}
              loading={false}
            />
          </div>
        )}
      </Card>

      <FilterBar onReset={() => setFilters({})}>
        <Sel value={filters.type} onChange={(v) => setFilters({ ...filters, type: v })} options={TYPES} placeholder="全部形式" w={150} />
        <Sel value={filters.status} onChange={(v) => setFilters({ ...filters, status: v })} options={[
          { value: 'active', label: '启用' }, { value: 'inactive', label: '停用' }
        ]} placeholder="全部状态" w={110} />
      </FilterBar>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'code', title: '编码', width: 80, render: (r: any) => <span className="font-mono text-[11px]">{r.code}</span> },
            { key: 'name', title: '政策名称', width: 180 },
            { key: 'type', title: '形式', width: 120, render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${TYPE_COLOR[r.type] || ''}`}>{r.type_name}</span>
            ) },
            { key: 'dealer_level', title: '适用等级', width: 90, render: (r: any) => r.dealer_level === 'all' ? '全部' : dict.label('dealer_levels', r.dealer_level) },
            { key: 'channel_type', title: '适用渠道', width: 90, render: (r: any) => r.channel_type === 'all' ? '全部' : dict.label('dealer_channel', r.channel_type) },
            { key: 'period', title: '生效期', width: 90, render: (r: any) => r.period || '长期' },
            { key: 'basis', title: '计返基数', width: 110, render: (r: any) => BASIS_LABEL[r.basis] || r.basis },
            { key: 'rebate_cap', title: '封顶', width: 90, align: 'right', render: (r: any) => r.rebate_cap > 0 ? `¥${r.rebate_cap.toLocaleString()}` : '—' },
            { key: 'status', title: '状态', width: 70, align: 'center', render: (r: any) => (
              <span className={`px-1.5 py-0.5 rounded text-[11px] ${r.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                {r.status === 'active' ? '启用' : '停用'}
              </span>
            ) },
            { key: '__act', title: '操作', width: 120, render: (r: any) => (
              <div className="flex items-center gap-2 text-[12px]">
                <button className="link inline-flex items-center gap-1" onClick={() => openEdit(r)}><Pencil size={11} /> 编辑</button>
                <button className="text-red-500 inline-flex items-center gap-1" onClick={() => remove(r)}><Trash2 size={11} /> 删除</button>
              </div>
            ) }
          ]}
          data={list}
          loading={loading}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal open={open} title={form.id ? `编辑政策 · ${form.name}` : '新建返点政策'} onClose={() => setOpen(false)} width={640}
        footer={<>
          <button className="btn-ghost" onClick={() => setOpen(false)}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </>}>
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          <Field label="政策名称" required>
            <input className="input" value={form.name ?? ''} placeholder="如：季度阶梯返点" onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </Field>
          <Field label="政策形式" required>
            <select className="input" value={form.type ?? 'tiered'} onChange={(e) => setType(e.target.value)}>
              {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
            </select>
          </Field>
          <Field label="适用经销商等级">
            <select className="input" value={form.dealer_level ?? 'all'} onChange={(e) => setForm({ ...form, dealer_level: e.target.value })}>
              <option value="all">全部等级</option>
              {dict.dealerLevels.map((l: any) => <option key={l.value} value={l.value}>{l.label}</option>)}
            </select>
          </Field>
          <Field label="适用渠道">
            <select className="input" value={form.channel_type ?? 'all'} onChange={(e) => setForm({ ...form, channel_type: e.target.value })}>
              <option value="all">全部渠道</option>
              {dict.dealerChannel.map((c: any) => <option key={c.value} value={c.value}>{c.label}</option>)}
            </select>
          </Field>
          <Field label="生效期间" hint="留空=长期；支持 2026-10 或 2026-Q4">
            <input className="input" value={form.period ?? ''} placeholder="如 2026-Q4" onChange={(e) => setForm({ ...form, period: e.target.value })} />
          </Field>
          <Field label="计返基数">
            <select className="input" value={form.basis ?? 'net'} onChange={(e) => setForm({ ...form, basis: e.target.value })}>
              <option value="net">净销售（扣退货）</option>
              <option value="gross">毛销售</option>
              <option value="pay">回款额</option>
            </select>
          </Field>
          <Field label="单期封顶（0 不封顶）">
            <input className="input" type="number" value={form.rebate_cap ?? 0} onChange={(e) => setForm({ ...form, rebate_cap: e.target.value })} />
          </Field>
          <Field label="优先级">
            <input className="input" type="number" value={form.priority ?? 100} onChange={(e) => setForm({ ...form, priority: e.target.value })} />
          </Field>
          <Field label="规则体（JSON）" span={2} hint="阶梯 tiers / 每件单价 perUnit / 增量率 rate / 回款比 payRatio / 品类 categoryId / 档期目标 target">
            <textarea className="input font-mono text-[12px] h-40" value={rulesText} onChange={(e) => setRulesText(e.target.value)} spellCheck={false} />
          </Field>
          <Field label="备注" span={2}>
            <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
          </Field>
        </div>
      </Modal>
    </div>
  )
}
