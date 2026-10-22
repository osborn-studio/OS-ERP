/**
 * ============================================================================
 * 文件标识：src/components/ui.tsx ｜ 通用 UI 组件库：Card / Table / Tabs / Modal / Field / Status / StatCard / Pagination / useFetch / useList —— **全站视觉与交互的唯一出处**
 * ============================================================================
 * 【职责】通用 UI 组件库：Card / Table / Tabs / Modal / Field / Status / StatCard / Pagination / useFetch / useList —— **全站视觉与交互的唯一出处**
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import { ReactNode, useCallback, useEffect, useState } from 'react'
import api from '../api/client'

// ============ 格式化 ============
export const fmtMoney = (v: any, digits = 2) => {
  const n = Number(v || 0)
  return n.toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
export const fmtInt = (v: any) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: 0 })
export const fmtNum = (v: any, d = 2) => Number(v || 0).toLocaleString('zh-CN', { maximumFractionDigits: d })
export const fmtPct = (v: any, d = 1) => `${Number(v || 0).toFixed(d)}%`
export const today = () => new Date().toISOString().slice(0, 10)
export const dayAgo = (n: number) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)

// ============ 状态徽标 ============
const STATUS_MAP: Record<string, { text: string; cls: string }> = {
  draft: { text: '草稿', cls: 'bg-slate-100 text-slate-600' },
  submitted: { text: '待审批', cls: 'bg-amber-100 text-amber-700' },
  approving: { text: '审批中', cls: 'bg-indigo-100 text-indigo-700' },
  // 采购域（模块 07）新增状态：请购 / 发票 / 结算 / 付款
  converted: { text: '已转单', cls: 'bg-cyan-100 text-cyan-700' },
  verified: { text: '已认证', cls: 'bg-teal-100 text-teal-700' },
  posted: { text: '已入账', cls: 'bg-blue-100 text-blue-700' },
  audited: { text: '已审核', cls: 'bg-blue-100 text-blue-700' },
  settled: { text: '已结清', cls: 'bg-green-100 text-green-700' },
  open: { text: '未结清', cls: 'bg-amber-100 text-amber-700' },
  rejected: { text: '已驳回', cls: 'bg-red-100 text-red-600' },
  allocated: { text: '已分仓', cls: 'bg-cyan-100 text-cyan-700' },
  voided: { text: '已作废', cls: 'bg-slate-100 text-slate-400' },
  partial: { text: '部分收货', cls: 'bg-amber-100 text-amber-700' },
  approved: { text: '已审批', cls: 'bg-blue-100 text-blue-700' },
  received: { text: '已收货', cls: 'bg-teal-100 text-teal-700' },
  // 到货单与质检单拆分（模块 07）后新增：质检单（INS）与到货单（GR）都会用到
  inspected: { text: '已质检', cls: 'bg-teal-100 text-teal-700' },
  closed: { text: '已关闭', cls: 'bg-slate-100 text-slate-500' },
  cancelled: { text: '已取消', cls: 'bg-slate-100 text-slate-400' },
  confirmed: { text: '已确认', cls: 'bg-blue-100 text-blue-700' },
  picking: { text: '部分发货', cls: 'bg-indigo-100 text-indigo-700' },
  shipped: { text: '已发货', cls: 'bg-teal-100 text-teal-700' },
  completed: { text: '已完成', cls: 'bg-green-100 text-green-700' },
  returned: { text: '已退货', cls: 'bg-orange-100 text-orange-700' },
  pending: { text: '待发货', cls: 'bg-amber-100 text-amber-700' },
  refunding: { text: '退款中', cls: 'bg-orange-100 text-orange-700' },
  refunded: { text: '已退款', cls: 'bg-red-100 text-red-600' },
  checking: { text: '盘点中', cls: 'bg-blue-100 text-blue-700' },
  adjusted: { text: '已调整', cls: 'bg-green-100 text-green-700' },
  paid: { text: '已发放', cls: 'bg-green-100 text-green-700' },
  sent: { text: '已发送', cls: 'bg-teal-100 text-teal-700' },
  success: { text: '成功', cls: 'bg-green-100 text-green-700' },
  fail: { text: '失败', cls: 'bg-red-100 text-red-600' },
  active: { text: '启用', cls: 'bg-green-100 text-green-700' },
  inactive: { text: '停用', cls: 'bg-slate-100 text-slate-500' },
  expired: { text: '已过期', cls: 'bg-red-100 text-red-600' },
  danger: { text: '临期', cls: 'bg-orange-100 text-orange-700' },
  warning: { text: '关注', cls: 'bg-amber-100 text-amber-700' },
  notice: { text: '提示', cls: 'bg-slate-100 text-slate-600' }
}

export function Status({ value, text }: { value: string; text?: string }) {
  const m = STATUS_MAP[value] || { text: value, cls: 'bg-slate-100 text-slate-600' }
  return <span className={`tag ${m.cls}`}>{text || m.text}</span>
}

// ============ 基础组件 ============
export function Card({ children, className = '', pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <div className={`card ${pad ? 'card-pad' : ''} ${className}`}>{children}</div>
}

export function SectionTitle({ title, desc, right }: { title: string; desc?: string; right?: ReactNode }) {
  return (
    <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
      <div>
        <h2 className="text-[15px] font-medium text-slate-800">{title}</h2>
        {desc && <p className="text-[12px] text-slate-400 mt-0.5">{desc}</p>}
      </div>
      {right}
    </div>
  )
}

export function StatCard({
  label,
  value,
  sub,
  tone = 'default',
  icon
}: {
  label: string
  value: ReactNode
  sub?: ReactNode
  tone?: 'default' | 'brand' | 'green' | 'red' | 'amber' | 'bad' | 'warn' | 'good'
  icon?: ReactNode
}) {
  const tones: Record<string, string> = {
    default: 'text-slate-800',
    brand: 'text-brand-700',
    green: 'text-green-600',
    red: 'text-red-600',
    amber: 'text-amber-600',
    bad: 'text-red-600',
    warn: 'text-amber-600',
    good: 'text-green-600'
  }
  return (
    <div className="kpi">
      <div className="flex items-center justify-between">
        <span className="kpi-label">{label}</span>
        {icon && <span className="text-slate-300">{icon}</span>}
      </div>
      <div className={`kpi-value ${tones[tone]}`}>{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export function Table({
  columns,
  data,
  loading,
  empty = '暂无数据',
  rowKey = (r: any, i: number) => r.id ?? i,
  onRowClick
}: {
  columns: { key: string; title: ReactNode; width?: number | string; align?: 'left' | 'right' | 'center'; render?: (row: any, index: number) => ReactNode }[]
  data: any[]
  loading?: boolean
  empty?: string
  rowKey?: (row: any, i: number) => any
  onRowClick?: (row: any) => void
}) {
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} style={{ width: c.width }} className={c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : ''}>
                {c.title}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-10 text-slate-400">
                加载中…
              </td>
            </tr>
          ) : data.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="text-center py-10 text-slate-400">
                {empty}
              </td>
            </tr>
          ) : (
            data.map((row, i) => (
              <tr key={rowKey(row, i)} className={onRowClick ? 'cursor-pointer' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((c) => (
                  <td key={c.key} className={c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : ''}>
                    {c.render ? c.render(row, i) : (row[c.key] ?? '-')}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  )
}

export function Pagination({ page, pageSize, total, onChange }: { page: number; pageSize: number; total: number; onChange: (p: number) => void }) {
  const pages = Math.max(Math.ceil(total / pageSize), 1)
  if (total === 0) return null
  return (
    <div className="flex items-center justify-between px-1 pt-3 text-[13px] text-slate-500">
      <span>
        共 {fmtInt(total)} 条 · 第 {page}/{pages} 页
      </span>
      <div className="flex gap-1.5">
        <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => onChange(page - 1)}>
          上一页
        </button>
        <button className="btn-ghost btn-sm" disabled={page >= pages} onClick={() => onChange(page + 1)}>
          下一页
        </button>
      </div>
    </div>
  )
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width = 720
}: {
  open: boolean
  title: ReactNode
  onClose: () => void
  children: ReactNode
  footer?: ReactNode
  width?: number
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-slate-900/40 p-6 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-lg shadow-xl w-full my-6" style={{ maxWidth: width }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-4 h-12 border-b border-slate-200">
          <h3 className="text-[14px] font-medium text-slate-800">{title}</h3>
          <button className="text-slate-400 hover:text-slate-600 text-xl leading-none" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="p-4 max-h-[70vh] overflow-y-auto">{children}</div>
        {footer && <div className="px-4 py-3 border-t border-slate-200 flex justify-end gap-2">{footer}</div>}
      </div>
    </div>
  )
}

export function Field({
  label,
  children,
  hint,
  required,
  span
}: {
  label: string
  children: ReactNode
  hint?: string
  required?: boolean
  span?: 1 | 2 | 3
}) {
  return (
    <label className={`form-row ${span === 2 ? 'col-span-2' : span === 3 ? 'col-span-3' : ''}`}>
      <span className="label">
        {label} {required && <span className="text-red-500">*</span>}
      </span>
      {children}
      {hint && <span className="text-[11px] text-slate-400 mt-1">{hint}</span>}
    </label>
  )
}

export function Tabs({ tabs, value, onChange }: { tabs: { key: string; label: string; count?: number }[]; value: string; onChange: (k: string) => void }) {
  return (
    <div className="flex border-b border-slate-200 mb-3 overflow-x-auto">
      {tabs.map((t) => (
        <div key={t.key} className={`tab ${value === t.key ? 'tab-active' : ''}`} onClick={() => onChange(t.key)}>
          {t.label}
          {t.count !== undefined && <span className="ml-1.5 text-slate-400">{t.count}</span>}
        </div>
      ))}
    </div>
  )
}

export function Empty({ text = '暂无数据', action }: { text?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center py-14 text-slate-400 gap-3">
      <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center text-slate-300 text-xl">∅</div>
      <span className="text-[13px]">{text}</span>
      {action}
    </div>
  )
}

// ============ 消息提示 ============
let toastFn: ((msg: string, type?: 'success' | 'error' | 'info') => void) | null = null
export function toast(msg: string, type: 'success' | 'error' | 'info' = 'success') {
  toastFn?.(msg, type)
}

export function ToastHost() {
  const [list, setList] = useState<{ id: number; msg: string; type: string }[]>([])
  useEffect(() => {
    toastFn = (msg, type = 'success') => {
      const id = Date.now() + Math.random()
      setList((l) => [...l, { id, msg, type }])
      setTimeout(() => setList((l) => l.filter((x) => x.id !== id)), 2600)
    }
    return () => {
      toastFn = null
    }
  }, [])
  const cls: Record<string, string> = {
    success: 'bg-slate-900 text-white',
    error: 'bg-red-600 text-white',
    info: 'bg-brand-700 text-white'
  }
  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] flex flex-col gap-2 items-center pointer-events-none">
      {list.map((t) => (
        <div key={t.id} className={`px-4 py-2 rounded-md text-[13px] shadow-lg ${cls[t.type] || cls.success}`}>
          {t.msg}
        </div>
      ))}
    </div>
  )
}

// ============ 数据请求 hook ============
export function useFetch<T = any>(path: string | null, params?: Record<string, any>, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const reload = useCallback(async () => {
    if (!path) return
    setLoading(true)
    setError(null)
    try {
      const res = await api.get(path, params)
      setData(res.data)
    } catch (e: any) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, JSON.stringify(params || {})])

  useEffect(() => {
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, ...deps])

  return { data, loading, error, reload, setData }
}

export function useList<T = any>(path: string, initParams: Record<string, any> = {}) {
  const [page, setPage] = useState(1)
  const [pageSize] = useState(initParams.pageSize || 20)
  const [filters, setFilters] = useState<Record<string, any>>({})
  const params = { ...initParams, ...filters, page, pageSize }
  const { data, loading, reload } = useFetch<any>(path, params, [page, JSON.stringify(filters)])
  return {
    list: (data?.list || []) as T[],
    total: data?.total || 0,
    summary: data?.summary,
    loading,
    page,
    pageSize,
    filters,
    setFilters: (f: Record<string, any>) => {
      setFilters(f)
      setPage(1)
    },
    setPage,
    reload
  }
}

// ============ 简易柱状/折线（SVG，避免引入重型图表依赖时的兜底） ============
export function MiniBars({ data, height = 120, color = '#2568a6' }: { data: { label: string; value: number }[]; height?: number; color?: string }) {
  const max = Math.max(...data.map((d) => d.value), 1)
  return (
    <div className="flex items-end gap-1" style={{ height }}>
      {data.map((d, i) => (
        <div key={i} className="flex-1 flex flex-col items-center justify-end group" title={`${d.label}: ${fmtNum(d.value)}`}>
          <div
            className="w-full rounded-t transition-all"
            style={{ height: `${Math.max((d.value / max) * (height - 18), 2)}px`, background: color, opacity: 0.85 }}
          />
          <span className="text-[10px] text-slate-400 mt-1 truncate w-full text-center">{d.label}</span>
        </div>
      ))}
    </div>
  )
}
