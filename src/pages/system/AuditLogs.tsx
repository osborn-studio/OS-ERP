/**
 * ============================================================================
 * 文件标识：src/pages/system/AuditLogs.tsx ｜ 审计日志查看器（过滤 + 分页 + CSV 导出 + 保留策略提示）
 * ============================================================================
 * 【职责】按模块 / 动作 / 操作人 / 对象 / 日期 / 关键字查询 `audit_logs`，并导出同一过滤的 CSV。
 * 【入口】/system/audit-logs
 * 【主要接口】/meta/audit-logs、/meta/audit-logs/export.csv（权限 system:audit:view）
 *
 * 【口径】
 *   · AC11：关键字提示（≥3 字符走全文检索、2 字符普通匹配）与“仅动作需模块”提示见 utils/audit-filter.ts，不满足时查询按钮置灰（服务端同口径 400 兜底）；
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
import { ACTION_NEEDS_MODULE_HINT, KEYWORD_HINTS, actionNeedsModule, effectiveKeywordLength, keywordMode, KEYWORD_MIN_CHARS } from '../../utils/audit-filter'

const AUDIT_COUNT_CAP = 10000 // 与 server/lib/audit-view.js 的 AUDIT_COUNT_CAP 一致
type Draft = { module: string; action: string; user: string; entity: string; entity_id: string; from: string; to: string; keyword: string }
type FtsState = { setting_enabled: boolean; index_present: boolean; env_disabled: boolean; active: boolean }
type AuditMeta = { retention?: any; max?: number; ok?: boolean; fts?: FtsState }
const EMPTY: Draft = { module: '', action: '', user: '', entity: '', entity_id: '', from: '', to: '', keyword: '' }

export default function AuditLogs() {
  const { list, total, page, pageSize, setPage, setFilters, filters, loading, error, errorStatus, errorCode, reload } =
    useList<any>('/meta/audit-logs', { pageSize: 50 })
  const [draft, setDraft] = useState<Draft>(EMPTY)
  const [exporting, setExporting] = useState(false)
  const [meta, setMeta] = useState<AuditMeta>({})
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

  // 关键字至少 2 个有效字符（与服务端 assertKeyword 同口径）：先在前端拦住，省一次必然 400 的请求
  const applyFilters = () => {
    if (draft.keyword && effectiveKeywordLength(draft.keyword) < KEYWORD_MIN_CHARS) return toast('关键字至少需要 2 个字符', 'error')
    // 仅按动作过滤既无索引、命中面又大：必须同时给模块（与服务端 AUDIT_ACTION_NEEDS_MODULE 同口径）
    if (actionNeedsModule(draft)) return toast('按动作过滤时必须同时填写模块（如 sales）', 'error')
    setFilters(Object.fromEntries(Object.entries(draft).filter(([, v]) => v)))
  }

  const kwMode = keywordMode(draft.keyword)
  const needModule = actionNeedsModule(draft)
  const invalidDraft = kwMode === 'too_short' || needModule

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
      {meta.ok && meta.fts && <FtsStateCard fts={meta.fts} />}
      <FilterBar
        onReset={() => {
          setDraft(EMPTY)
          setFilters({})
        }}
      >
        <Inp value={draft.module} onChange={set('module')} placeholder="模块（如 sales）" w={120} />
        <Inp value={draft.action} onChange={set('action')} placeholder="动作（须同时填模块）" w={130} />
        <Inp value={draft.user} onChange={set('user')} placeholder="操作人 / 用户 ID" w={130} />
        <Inp value={draft.entity} onChange={set('entity')} placeholder="对象类型" w={110} />
        <Inp value={draft.entity_id} onChange={set('entity_id')} placeholder="对象 ID" w={90} />
        <Inp type="date" value={draft.from} onChange={set('from')} w={140} />
        <span className="text-slate-400">至</span>
        <Inp type="date" value={draft.to} onChange={set('to')} w={140} />
        <Inp value={draft.keyword} onChange={set('keyword')} placeholder="关键字（≥3 字走全文检索）" w={230} />
        <button className="btn-primary btn-sm" disabled={invalidDraft} title={invalidDraft ? '先按下方提示修正过滤条件' : undefined} onClick={applyFilters}>
          查询
        </button>
      </FilterBar>
      {/* 提示常驻在过滤条下面：说明关键字走哪条检索路径、以及“只有动作需要模块”；不满足时查询按钮置灰（服务端同口径 400 兜底） */}
      {/* 只在服务端确认过本账号能读审计（meta 请求成功）之后才显示，避免无权限账号在 403 到达前闪现过滤提示 */}
      {meta.ok && <div className="mb-3 -mt-1 flex flex-col gap-0.5 text-[12px] text-slate-500">
        <div data-testid="audit-fts-hint" data-mode={kwMode} className={kwMode === 'too_short' ? 'text-red-600' : kwMode === 'fts' ? 'text-emerald-700' : undefined}>
          {KEYWORD_HINTS[kwMode]}
        </div>
        <div data-testid="audit-action-hint" data-needs-module={needModule ? '1' : '0'} className={needModule ? 'text-red-600' : undefined}>
          {ACTION_NEEDS_MODULE_HINT}
        </div>
      </div>}
      {/* 400 等校验错误：useList 失败时保留上一次的结果，不显式处理会让旧行看起来像是本次过滤的结果 */}
      {error && !loading && <div className="mb-3 rounded border border-red-200 bg-red-50 px-3 py-2 text-[13px] text-red-700">查询未执行：{error}。下方不显示旧结果。</div>}
      <Card pad={false}>
        <Table
          loading={loading}
          data={error ? [] : list}
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
      {/* AA6：总数是服务端封顶估算（最多 10,001）；超过 10,000 时只能翻到前 10,000 条，更早的请加过滤条件或导出 */}
      {total > AUDIT_COUNT_CAP && (
        <div className="mt-2 text-[12px] text-slate-500">命中超过 {AUDIT_COUNT_CAP.toLocaleString()} 条，总数是估算；下方“共 {AUDIT_COUNT_CAP.toLocaleString()} 条”指可翻阅的范围（最新 {AUDIT_COUNT_CAP.toLocaleString()} 条），不是命中总数。请加过滤条件缩小范围，或导出 CSV。</div>
      )}
      <Pagination page={page} pageSize={pageSize} total={Math.min(total, AUDIT_COUNT_CAP)} onChange={setPage} />
    </div>
  )
}

/**
 * 关键词索引（FTS5）状态，只读（AE11）。服务端 `fts` 字段四个布尔值合成一个可读结论：
 *   on（设置开 + 索引在）/ off（设置关）/ env（环境开关强制 LIKE）/ drift（设置开但索引表不在：无 FTS5 构建或尚未收敛）。
 * 维护动作只给命令提示，页面不提供开关（改索引要持写锁，须走脚本并写理由）。
 */
function ftsVerdict(f: FtsState): { state: 'on' | 'off' | 'env' | 'drift'; text: string; hint: string } {
  if (!f.setting_enabled) return { state: 'off', text: '已停用（设置 audit_fts_enabled = 关）：关键词一律走普通匹配（LIKE），命中稀少的关键词在大库上会更慢。', hint: '重新启用：node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> --enable --reason "<原因>"（重建并回填索引，大库上会持写锁，请避开业务高峰）。' }
  if (f.env_disabled) return { state: 'env', text: '设置为开，但环境变量 GML_AUDIT_FTS=0 强制关键词走普通匹配（LIKE）。', hint: '移除该环境变量并重启服务后恢复；这是运维演练开关，不改库里的设置。' }
  if (!f.index_present) return { state: 'drift', text: '设置为开，但库里没有关键词索引表：当前走普通匹配（LIKE）。常见于不带 FTS5 的构建，或设置刚改尚未收敛。', hint: '收敛：node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> --enable --reason "<原因>"，或重启让迁移 071 的自愈按设置收敛；构建本身不支持 FTS5 时请保持停用。' }
  return { state: 'on', text: '已启用：≥3 个字符且命中稀少的关键词走索引，其余走普通匹配（LIKE），两条路径结果一致。', hint: '停用（减少审计写入开销）：node scripts/audit-fts-maintain.mjs --data-dir <绝对路径> --industry <行业> --disable --reason "<原因>"；停用后检索仍可用，只是更慢。' }
}

function FtsStateCard({ fts }: { fts: FtsState }) {
  const v = ftsVerdict(fts)
  const tone = v.state === 'on' ? 'text-emerald-700' : v.state === 'off' ? 'text-slate-600' : 'text-amber-700'
  return (
    <Card className="mb-3">
      <div data-testid="audit-fts-state" data-state={v.state} data-setting={fts.setting_enabled ? '1' : '0'} data-index={fts.index_present ? '1' : '0'} className="text-[13px] leading-relaxed">
        <div className={tone}><b>关键词索引（FTS5）：</b><span data-testid="audit-fts-state-text">{v.text}</span></div>
        <div className="mt-1 text-[12px] text-slate-500" data-testid="audit-fts-maintain-hint">维护提示：{v.hint}</div>
      </div>
    </Card>
  )
}

function useMetaOnce(set: (m: AuditMeta) => void) {
  useEffect(() => {
    let live = true
    api
      .get('/meta/audit-logs', { page: 1, pageSize: 1 })
      .then((res: any) => live && set({ retention: res.data?.retention, max: res.data?.export_max_rows, fts: res.data?.fts, ok: true }))
      .catch(() => {})
    return () => {
      live = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
