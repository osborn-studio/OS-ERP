/**
 * ============================================================================
 * 文件标识：src/pages/system/CodeRules.tsx ｜ 编码规则
 * ============================================================================
 * 【职责】编码规则（页面）
 * 【入口】/system/code-rules
 * 【主要接口】/docflow/no-rules、/docflow/no-preview
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
 * 页面：编码规则
 */

import { useState } from 'react'
import api from '../../api/client'
import { Card, Field, Modal, StatCard, Status, Table, fmtInt, toast, useFetch } from '../../components/ui'
import { Inp } from '../../components/DataPage'
import { RefreshCw, Pencil, Wand2, Hash } from 'lucide-react'

/**
 * 编码规则（模块 06）。
 *
 * 单号是唯一「一旦发出去就改不了」的数据：已经打印在单据上、已经同步给外部系统。
 * 所以这个页面做两件事：
 *  ① 改规则前先**试取号**（`/docflow/no-preview`）—— 公式写错在这里就能看出来，不用等真发单；
 *  ② 规则改了**只影响新单**，已有的号不会被回溯重编（`doc_no_counters` 只进不退）。
 *
 * 单个规则作用域是 (单据类型, 作用域类型, 作用域值)。演示系统只用 global，
 * 但表结构留了 org / warehouse 粒度 —— 将来多组织各自独立流水号时不用改表。
 */
const TOKENS = ['{PREFIX}', '{TYPE}', '{YYYY}', '{YY}', '{MM}', '{DD}', '{HH}', '{mm}', '{SS}', '{ORG}', '{WH}', '{STORE}', '{SEQ}', '{SEQ:5}', '{RAND:3}']
const PERIODS: { value: string; label: string }[] = [
  { value: 'day', label: '按日（每日从 seq_start 重编）' },
  { value: 'month', label: '按月' },
  { value: 'year', label: '按年' },
  { value: 'none', label: '不重置（全局连续）' }
]

export default function CodeRules() {
  const { data, loading, reload } = useFetch<any[]>('/docflow/no-rules')
  const [keyword, setKeyword] = useState('')
  const [edit, setEdit] = useState<any>(null)
  const list: any[] = (data || []).filter(
    (r) => !keyword || `${r.doc_type} ${r.doc_type_name || ''} ${r.pattern}`.toLowerCase().includes(keyword.toLowerCase())
  )
  const active = (data || []).filter((r: any) => r.status === 'active').length
  const counters = (data || []).reduce((s: number, r: any) => s + Number(r.counter_rows || 0), 0)

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">编码规则</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            单号公式与流水号周期。改规则只影响新单，已发出的号不回溯；改前先试取号
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={reload}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
        <StatCard label="规则条数" value={fmtInt((data || []).length)} sub="覆盖全部单据类型" tone="brand" />
        <StatCard label="启用中" value={fmtInt(active)} />
        <StatCard label="计数器行" value={fmtInt(counters)} sub="每行 = 一个 (类型, 周期) 的流水" />
        <StatCard label="流水段长度" value="默认 4 位" sub="SEQ:4 → 0001 ~ 9999" />
      </div>

      <Card className="mb-3" pad={false}>
        <div className="p-3 flex items-center gap-2">
          <Hash size={15} className="text-ink-400" />
          <Inp value={keyword} onChange={setKeyword} placeholder="单据类型 / 名称 / 公式" w={260} />
          <span className="text-[12px] text-ink-500 ml-2">共 {list.length} 条</span>
        </div>
      </Card>

      <Card pad={false}>
        <Table
          columns={[
            { key: 'doc_type', title: '单据类型', width: 190, render: (r) => `${r.doc_type_name || ''}（${r.doc_type}）` },
            { key: 'pattern', title: '编号公式', width: 280, render: (r) => <span className="font-mono text-[12px] bg-ink-50 px-1.5 py-0.5 rounded">{r.pattern}</span> },
            { key: 'period', title: '流水周期', width: 90, render: (r) => PERIODS.find((p) => p.value === r.period)?.label.split('（')[0] || r.period },
            { key: 'seq_pad', title: '补零位', width: 80, align: 'right' },
            { key: 'seq_start', title: '起始号', width: 80, align: 'right' },
            { key: 'scope_type', title: '作用域', width: 90, render: (r) => (r.scope_type === 'global' ? '全局' : `${r.scope_type}:${r.scope_value}`) },
            { key: 'counter_rows', title: '计数器', width: 90, align: 'right', render: (r) => fmtInt(r.counter_rows) },
            { key: 'status', title: '状态', width: 80, render: (r) => <Status value={r.status} /> },
            {
              key: '__act',
              title: '操作',
              width: 80,
              render: (r) => (
                <button className="link inline-flex items-center gap-1 text-[12px]" onClick={() => setEdit(r)}>
                  <Pencil size={12} /> 编辑
                </button>
              )
            }
          ]}
          data={list}
          loading={loading}
          empty="暂无编码规则"
        />
      </Card>

      <EditModal row={edit} onClose={() => setEdit(null)} onSaved={reload} />
    </div>
  )
}

function EditModal({ row, onClose, onSaved }: any) {
  const [form, setForm] = useState<any>({})
  const [sample, setSample] = useState<string>('')
  const [saving, setSaving] = useState(false)

  if (row && form.__id !== row.id) {
    setForm({
      __id: row.id,
      name: row.name ?? '',
      pattern: row.pattern,
      period: row.period,
      seq_pad: row.seq_pad,
      seq_start: row.seq_start,
      remark: row.remark ?? ''
    })
    setSample('')
  }

  const preview = async () => {
    try {
      const res = await api.post('/docflow/no-preview', {
        doc_type: row.doc_type,
        pattern: form.pattern,
        seq_pad: Number(form.seq_pad || 4)
      })
      setSample(res.data?.sample || '')
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const submit = async () => {
    if (!form.pattern) return toast('请填写编号公式', 'error')
    setSaving(true)
    try {
      await api.post('/docflow/no-rules', {
        doc_type: row.doc_type,
        name: form.name || undefined,
        scope_type: row.scope_type,
        scope_value: row.scope_value,
        pattern: form.pattern,
        period: form.period,
        seq_pad: Number(form.seq_pad),
        seq_start: Number(form.seq_start),
        remark: form.remark || undefined
      })
      toast('规则已保存（仅影响新单，已有单号不回溯）')
      onClose()
      onSaved()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal
      open={!!row}
      title={`编码规则 · ${row?.doc_type_name || ''}（${row?.doc_type || ''}）`}
      width={720}
      onClose={onClose}
      footer={
        <>
          <button className="btn-ghost" onClick={preview}>
            <Wand2 size={13} /> 试取号
          </button>
          <button className="btn-ghost" onClick={onClose}>取消</button>
          <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-4 mb-4">
        <Field label="规则名称" span={2}>
          <input className="input" value={form.name ?? ''} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </Field>
        <Field label="编号公式" required span={2} hint="点下方标签插入占位符；{SEQ:n} 表示补零到 n 位">
          <input className="input font-mono" value={form.pattern ?? ''} onChange={(e) => setForm({ ...form, pattern: e.target.value })} />
        </Field>
        <Field label="流水周期">
          <select className="input" value={form.period ?? 'day'} onChange={(e) => setForm({ ...form, period: e.target.value })}>
            {PERIODS.map((p) => (
              <option key={p.value} value={p.value}>{p.label}</option>
            ))}
          </select>
        </Field>
        <Field label="补零位">
          <input className="input" type="number" value={form.seq_pad ?? 4} onChange={(e) => setForm({ ...form, seq_pad: e.target.value })} />
        </Field>
        <Field label="起始序号">
          <input className="input" type="number" value={form.seq_start ?? 1} onChange={(e) => setForm({ ...form, seq_start: e.target.value })} />
        </Field>
        <Field label="备注">
          <input className="input" value={form.remark ?? ''} onChange={(e) => setForm({ ...form, remark: e.target.value })} />
        </Field>
      </div>

      <div className="mb-3">
        <div className="text-[12px] text-ink-500 mb-1.5">可用占位符（点击插入）</div>
        <div className="flex flex-wrap gap-1.5">
          {TOKENS.map((t) => (
            <button
              key={t}
              className="text-[12px] font-mono px-2 py-1 rounded border border-ink-300 hover:border-brand-400 hover:bg-brand-50/40"
              onClick={() => setForm({ ...form, pattern: `${form.pattern || ''}${t}` })}
            >
              {t}
            </button>
          ))}
        </div>
      </div>

      {sample && (
        <div className="rounded-md border border-teal-300 bg-teal-50/50 px-3 py-2 text-[13px]">
          试取号结果：<b className="font-mono text-teal-700">{sample}</b>
          <span className="text-[12px] text-ink-500 ml-2">（这只是预览，不会占用流水号）</span>
        </div>
      )}

      <p className="text-[12px] text-ink-500 mt-3">
        注意：修改公式后已发出的单号不会重编。如果新公式与旧号格式不兼容，可能出现新旧混排 ——
        演示环境建议在重置数据后再改。
      </p>
    </Modal>
  )
}
