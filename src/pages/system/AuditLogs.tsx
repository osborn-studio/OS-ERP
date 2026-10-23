/**
 * ============================================================================
 * 文件标识：src/pages/system/AuditLogs.tsx ｜ 审计日志查看器（过滤 + 分页 + CSV 导出 + 保留策略提示）
 * ============================================================================
 * 【职责】按模块 / 动作 / 操作人 / 对象 / 日期 / 关键字查询 `audit_logs`，并导出同一过滤的 CSV。
 * 【入口】/system/audit-logs
 * 【主要接口】/meta/audit-logs、/meta/audit-logs/export.csv（权限 system:audit:view）
 *
 * 【口径】
 *   · 明细由服务端读取时再脱敏；本页只展示，不做任何还原；
 *   · 保留提示取自服务端返回的 `retention`（读 `retention_audit_days`，ADR-0030），不在页面里写死天数；
 *   · 导出受服务端行数上限约束，被截断时会有提示，导出动作本身会写入审计。
 * ============================================================================
 */
import { useEffect, useState } from 'react'
import api from '../../api/client'
import { ScopeBlocked, isBlocked } from '../../components/ScopeNotice'
import { Card, Pagination, SectionTitle, Table, fmtInt, toast, useList } from '../../components/ui'
import { FilterBar, Inp } from '../../components/DataPage'
import { Download } from 'lucide-react'

type Draft = { module: string; action: string; user: string; entity: string; entity_id: string; from: string; to: string; keyword: string }
const EMPTY: Draft = { module: '', action: '', user: '', entity: '', entity_id: '', from: '', to: '', keyword: '' }

export default function AuditLogs() {
  const { list, total, page, pageSize, setPage, setFilters, filters, loading, errorStatus, errorCode, reload } =
    useList<any>('/meta/audit-logs', { pageSize: 50 })
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [exporting, setExporting] = useState(false)
  const [meta, setMeta] = useState<{ retention?: any; max?: number }>({})
  const set = (k: keyof Draft) => (v: string) => setDraft((d) => ({ ...d, [k]: v }))

  // 保留提示与导出上限随列表一起返回；useList 只暴露 list，故单独取一次元信息（pageSize=1，开销可忽略）
  useMetaOnce(setMeta)

  const exportCsv = async () => {
    setExporting(true)
    try {
      const r = await api.download('/meta/audit-logs/export.csv', filters, 'audit-logs.csv')
      toast(`已导出 ${r.filename}`)
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setExporting(false)
    }
  }

  if (isBlocked({ errorStatus, errorCode })) return <ScopeBlocked failure={{ errorStatus, errorCode }} onRetry={reload} />

  return (
    <div>
      <SectionTitle
        title="审计日志"
        desc="所有单据操作与主数据变更的留痕。明细读取时已再次脱敏；导出动作本身也会被记录。"
        right={
          <button className="btn-primary btn-sm" disabled={exporting} onClick={exportCsv}>
            <Download size={14} /> {exporting ? '导出中…' : '导出 CSV'}
          </button>
        }
      />
      {meta.retention && (
        <Card className="mb-3">
          <div className="text-[13px] text-slate-600">
            <b>保留策略：</b>审计日志保留窗口 {meta.retention.audit_days} 天（系统参数 retention_audit_days）。{meta.retention.note}
            {meta.max ? ` 单次导出最多 ${fmtInt(meta.max)} 行，超出会被截断（响应头 X-Export-Truncated）。` : ''}
          </div>
        </Card>
      )}
      <FilterBar
        onReset={() => {
          setDraft(EMPTY)
          setFilters({})
        }}
      >
        <Inp value={draft.module} onChange={set('module')} placeholder="模块（如 sales）" w={120} />
        <Inp value={draft.action} onChange={set('action')} placeholder="动作（如 CREATE）" w={130} />
        <Inp value={draft.user} onChange={set('user')} placeholder="操作人 / 用户 ID" w={130} />
        <Inp value={draft.entity} onChange={set('entity')} placeholder="对象类型" w={110} />
        <Inp value={draft.entity_id} onChange={set('entity_id')} placeholder="对象 ID" w={90} />
        <Inp type="date" value={draft.from} onChange={set('from')} w={140} />
        <span className="text-slate-400">至</span>
        <Inp type="date" value={draft.to} onChange={set('to')} w={140} />
        <Inp value={draft.keyword} onChange={set('keyword')} placeholder="关键字" w={150} />
        <button className="btn-primary btn-sm" onClick={() => setFilters(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)))}>
          查询
        </button>
      </FilterBar>
      <Card pad={false}>
        <Table
          loading={loading}
          data={list}
          columns={[
            { key: 'created_at', title: '时间', width: 165 },
            { key: 'user_name', title: '操作人', width: 110 },
            { key: 'module', title: '模块', width: 100 },
            { key: 'action', title: '动作', width: 140 },
            { key: 'entity', title: '对象', width: 120 },
            { key: 'entity_id', title: '对象 ID', width: 90 },
            { key: 'detail', title: '明细（已脱敏）', render: (r) => <span className="break-all text-[12px] text-slate-600">{r.detail ?? '-'}</span> },
            { key: 'ip', title: 'IP', width: 120 }
          ]}
        />
      </Card>
      <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
    </div>
  )
}

function useMetaOnce(set: (m: { retention?: any; max?: number }) => void) {
  useEffect(() => {
    let live = true
    api
      .get('/meta/audit-logs', { page: 1, pageSize: 1 })
      .then((res: any) => live && set({ retention: res.data?.retention, max: res.data?.export_max_rows }))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
