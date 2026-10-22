/**
 * ============================================================================
 * 文件标识：src/components/DataPage.tsx ｜ 列表页骨架（搜索 + 筛选 + 分页 + 新增/编辑/删除 + 导出）：大多数业务列表页由它驱动，改它等于改所有列表页
 * ============================================================================
 * 【职责】列表页骨架（搜索 + 筛选 + 分页 + 新增/编辑/删除 + 导出）：大多数业务列表页由它驱动，改它等于改所有列表页
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import { ReactNode, useEffect, useMemo, useState } from 'react'
import api from '../api/client'
import { Card, Field, Modal, Pagination, Table, toast, useList } from './ui'
import { Search, Plus, RefreshCw, Pencil, Trash2, Download } from 'lucide-react'

export type FieldType = 'text' | 'number' | 'select' | 'date' | 'textarea' | 'switch' | 'password'

export type FieldDef = {
  key: string
  label: string
  type?: FieldType
  options?: { value: any; label: string }[]
  /** 只读展示（表格列） */
  width?: number | string
  align?: 'left' | 'right' | 'center'
  render?: (row: any) => ReactNode
  /** 表单 */
  required?: boolean
  readOnly?: boolean
  /**
   * 只在**编辑**时只读（新建可填）。
   *
   * 为什么需要它：有些字段是「历史引用的键」—— 仓库编码、单据编号之类 ——
   * 建的时候必须自己填，改的时候**一个字都不能动**（改掉会让老单据指向一个查不到的对象）。
   * 后端也已经拒了（`WAREHOUSE_CODE_IMMUTABLE`）；这里只读是让用户**不用撞墙才知道**。
   */
  readOnlyOnEdit?: boolean
  placeholder?: string
  hint?: string
  default?: any
  /** 表格中隐藏 */
  formOnly?: boolean
  /** 表单中隐藏 */
  tableOnly?: boolean
  span?: 1 | 2
}

export function FilterBar({ children, onReset }: { children: ReactNode; onReset?: () => void }) {
  return (
    <Card className="mb-3" pad={false}>
      <div className="p-3 flex items-center gap-2 flex-wrap">
        <Search size={15} className="text-slate-400" />
        {children}
        {onReset && (
          <button className="btn-ghost btn-sm" onClick={onReset}>
            重置
          </button>
        )}
      </div>
    </Card>
  )
}

export function Inp({
  value,
  onChange,
  placeholder,
  w = 160,
  type = 'text',
  disabled,
  min,
  max
}: {
  value: any
  onChange: (v: string) => void
  placeholder?: string
  w?: number
  type?: string
  /** 只读/禁用：已审批的 BOM 不许改母件与用途，用 disabled 而不是「点了才报错」 */
  disabled?: boolean
  min?: number
  max?: number
}) {
  return (
    <input
      className="input input-sm disabled:bg-slate-50 disabled:text-slate-400"
      style={{ width: w }}
      type={type}
      value={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      min={min}
      max={max}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function Sel({
  value,
  onChange,
  options,
  placeholder = '全部',
  w = 160,
  disabled
}: {
  value: any
  onChange: (v: string) => void
  options: { value: any; label: string }[]
  placeholder?: string
  w?: number
  disabled?: boolean
}) {
  return (
    <select
      className="input input-sm disabled:bg-slate-50 disabled:text-slate-400"
      style={{ width: w }}
      value={value ?? ''}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">{placeholder}</option>
      {options.map((o) => (
        <option key={String(o.value)} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

export function DateRange({
  from,
  to,
  onFrom,
  onTo
}: {
  from: any
  to: any
  onFrom: (v: string) => void
  onTo: (v: string) => void
}) {
  return (
    <div className="flex items-center gap-1.5">
      <Inp type="date" w={140} value={from} onChange={onFrom} />
      <span className="text-slate-400 text-[12px]">至</span>
      <Inp type="date" w={140} value={to} onChange={onTo} />
    </div>
  )
}

/**
 * 通用数据管理页：筛选 + 列表 + 分页 + 新增/编辑/删除
 * 适用于主数据与简单单据
 */
export default function DataPage({
  title,
  desc,
  path,
  fields,
  filters,
  initParams = {},
  canWrite = true,
  rowActions,
  onRowClick,
  extraToolbar,
  summaryRender,
  allowDelete = true,
  excelName,
  hideHeader = false,
  onExtraChange,
  preparePayload,
  noCard = false
}: {
  title: string
  desc?: string
  path: string
  fields: FieldDef[]
  filters?: { key: string; type?: 'text' | 'select' | 'date'; label?: string; options?: { value: any; label: string }[]; w?: number }[]
  initParams?: Record<string, any>
  canWrite?: boolean
  rowActions?: (row: any, reload: () => void) => ReactNode
  onRowClick?: (row: any) => void
  extraToolbar?: ReactNode
  summaryRender?: (summary: any) => ReactNode
  allowDelete?: boolean
  excelName?: string
  hideHeader?: boolean
  onExtraChange?: (p: { keyword: string; filters: Record<string, any>; reload: () => void; total: number }) => void
  /** Optional page-specific request contract. Other pages retain their existing field serialization. */
  preparePayload?: (body: Record<string, any>, context: { isEditing: boolean }) => Record<string, any>
  noCard?: boolean
}) {
  const { list, total, loading, page, pageSize, filters: f, setFilters, setPage, reload, summary } = useList(path, initParams)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<any>({})
  const [saving, setSaving] = useState(false)
  const [keyword, setKeyword] = useState('')

  useEffect(() => {
    if (!open) return
    const init: any = {}
    for (const fd of fields) if (fd.default !== undefined) init[fd.key] = fd.default
    setForm((old: any) => ({ ...init, ...old }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const columns = useMemo(
    () =>
      fields
        .filter((fd) => !fd.formOnly)
        .map((fd) => ({
          key: fd.key,
          title: fd.label,
          width: fd.width,
          align: fd.align,
          render: fd.render
            ? (row: any) => fd.render!(row)
            : (row: any) => {
                const v = row[fd.key]
                if (v === null || v === undefined || v === '') return <span className="text-slate-300">—</span>
                if (fd.type === 'switch') return v ? '是' : '否'
                if (fd.options) return fd.options.find((o) => String(o.value) === String(v))?.label ?? v
                return String(v)
              }
        })),
    [fields]
  )

  const openCreate = () => {
    setForm({})
    setOpen(true)
  }
  const openEdit = (row: any) => {
    setForm({ ...row })
    setOpen(true)
  }

  const save = async () => {
    for (const fd of fields) {
      const locked = fd.readOnly || (fd.readOnlyOnEdit && !!form.id)
      if (fd.required && !locked && (form[fd.key] === undefined || form[fd.key] === '')) {
        toast(`请填写「${fd.label}」`, 'error')
        return
      }
    }
    setSaving(true)
    try {
      const body: any = {}
      for (const fd of fields) if (!fd.readOnly && !fd.tableOnly) body[fd.key] = form[fd.key] ?? null
      const payload = preparePayload ? preparePayload(body, { isEditing: !!form.id }) : body
      if (form.id) await api.put(`${path}/${form.id}`, payload)
      else await api.post(path, payload)
      toast(form.id ? '已保存' : '已新增')
      setOpen(false)
      reload()
    } catch (e: any) {
      toast(e.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const remove = async (row: any) => {
    if (!confirm(`确认删除「${row.name || row.code || row.id}」？`)) return
    try {
      await api.del(`${path}/${row.id}`)
      toast('已删除')
      reload()
    } catch (e: any) {
      toast(e.message || '删除失败', 'error')
    }
  }

  const exportCsv = () => {
    const cols = columns.filter((c: any) => typeof c.render !== 'function' || true)
    const head = cols.map((c: any) => c.title).join(',')
    const rows = list.map((r: any) =>
      cols
        .map((c: any) => {
          const v = r[c.key]
          return typeof v === 'string' && v.includes(',') ? `"${v}"` : v ?? ''
        })
        .join(',')
    )
    const blob = new Blob(['\ufeff' + [head, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${excelName || title}.csv`
    a.click()
  }

  return (
    <div>
      {!hideHeader && (
        <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
          <div>
            <h1 className="text-[17px] font-medium text-slate-800">{title}</h1>
            {desc && <p className="text-[12px] text-slate-400 mt-0.5">{desc}</p>}
          </div>
          <div className="flex items-center gap-2">
            {extraToolbar}
            <button className="btn-ghost btn-sm" onClick={() => reload()}>
              <RefreshCw size={13} /> 刷新
            </button>
            <button className="btn-ghost btn-sm" onClick={exportCsv}>
              <Download size={13} /> 导出
            </button>
            {canWrite && (
              <button className="btn-primary btn-sm" onClick={openCreate}>
                <Plus size={14} /> 新增
              </button>
            )}
          </div>
        </div>
      )}
      {hideHeader && (
        <div className="flex items-center justify-end gap-2 mb-2">
          <button className="btn-ghost btn-sm" onClick={() => reload()}>
            <RefreshCw size={13} /> 刷新
          </button>
          <button className="btn-ghost btn-sm" onClick={exportCsv}>
            <Download size={13} /> 导出
          </button>
          {canWrite && (
            <button className="btn-primary btn-sm" onClick={openCreate}>
              <Plus size={14} /> 新增
            </button>
          )}
        </div>
      )}

      {filters && filters.length > 0 && (
        <FilterBar
          onReset={() => {
            setFilters({})
            setKeyword('')
          }}
        >
          <Inp value={keyword} onChange={setKeyword} placeholder="关键词搜索" w={200} />
          {filters.map((ft) =>
            ft.type === 'select' ? (
              <Sel
                key={ft.key}
                value={f[ft.key]}
                onChange={(v) => setFilters({ ...f, [ft.key]: v })}
                options={ft.options || []}
                placeholder={ft.label || '全部'}
                w={ft.w}
              />
            ) : (
              <Inp
                key={ft.key}
                type={ft.type === 'date' ? 'date' : 'text'}
                value={f[ft.key]}
                onChange={(v) => setFilters({ ...f, [ft.key]: v })}
                placeholder={ft.label}
                w={ft.w}
              />
            )
          )}
          <button className="btn-primary btn-sm" onClick={() => setFilters({ ...f, keyword })}>
            查询
          </button>
        </FilterBar>
      )}

      {summaryRender?.(summary)}

      <Card pad={false}>
        <Table
          columns={
            canWrite || rowActions || allowDelete
              ? [
                  ...columns,
                  {
                    key: '__act',
                    title: '操作',
                    width: 150,
                    render: (row: any) => (
                      <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {rowActions?.(row, reload)}
                        {canWrite && (
                          <button className="link text-[12px] inline-flex items-center gap-1" onClick={() => openEdit(row)}>
                            <Pencil size={12} /> 编辑
                          </button>
                        )}
                        {canWrite && allowDelete && (
                          <button
                            className="text-[12px] text-red-500 hover:text-red-600 inline-flex items-center gap-1"
                            onClick={() => remove(row)}
                          >
                            <Trash2 size={12} /> 删除
                          </button>
                        )}
                      </div>
                    )
                  }
                ]
              : columns
          }
          data={list}
          loading={loading}
          onRowClick={onRowClick}
        />
        <div className="px-3 pb-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      <Modal
        open={open}
        title={form.id ? `编辑${title}` : `新增${title}`}
        onClose={() => setOpen(false)}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setOpen(false)}>
              取消
            </button>
            <button className="btn-primary" disabled={saving} onClick={save}>
              {saving ? '保存中…' : '保存'}
            </button>
          </>
        }
      >
        <div className="grid grid-cols-2 gap-x-4 gap-y-3">
          {fields
            .filter((fd) => !fd.tableOnly)
            .map((fd) => (
              <div key={fd.key} className={fd.span === 2 ? 'col-span-2' : ''}>
                <Field label={fd.label} required={fd.required} hint={fd.hint}>
                  {fd.readOnly || (fd.readOnlyOnEdit && !!form.id) ? (
                    <div className="input bg-slate-50 text-slate-500 flex items-center">{form[fd.key] ?? '—'}</div>
                  ) : fd.type === 'select' ? (
                    <select className="input" value={form[fd.key] ?? ''} onChange={(e) => setForm({ ...form, [fd.key]: e.target.value })}>
                      <option value="">请选择</option>
                      {(fd.options || []).map((o) => (
                        <option key={String(o.value)} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  ) : fd.type === 'textarea' ? (
                    <textarea
                      className="input h-20 py-2"
                      value={form[fd.key] ?? ''}
                      placeholder={fd.placeholder}
                      onChange={(e) => setForm({ ...form, [fd.key]: e.target.value })}
                    />
                  ) : fd.type === 'switch' ? (
                    <select className="input" value={form[fd.key] ?? 1} onChange={(e) => setForm({ ...form, [fd.key]: Number(e.target.value) })}>
                      <option value={1}>是</option>
                      <option value={0}>否</option>
                    </select>
                  ) : (
                    <input
                      className="input"
                      type={fd.type === 'number' ? 'number' : fd.type === 'date' ? 'date' : fd.type === 'password' ? 'password' : 'text'}
                      value={form[fd.key] ?? ''}
                      placeholder={fd.placeholder}
                      onChange={(e) =>
                        setForm({ ...form, [fd.key]: fd.type === 'number' ? (e.target.value === '' ? null : Number(e.target.value)) : e.target.value })
                      }
                    />
                  )}
                </Field>
              </div>
            ))}
        </div>
      </Modal>
    </div>
  )
}
