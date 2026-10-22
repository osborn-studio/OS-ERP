/**
 * ============================================================================
 * 文件标识：src/pages/finance/ReportConfig.tsx ｜ 报表口径
 * ============================================================================
 * 【职责】报表口径（页面）
 * 【入口】/finance/report-config
 * 【主要接口】/reports/config/meta、/reports/config/audit/check、/reports/meta、/reports/defs、/reports/config/audit、/reports/lines
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
 * 页面：报表口径
 */

// 报表口径（批次 S）：报表结构本身的定义、当前值与**变更历史**
//
// 这一页在此之前**不存在** —— `PUT /reports/defs/{code}` / `POST /reports/lines` /
// `DELETE /reports/lines/{id}` 三个接口早就有了，接口文档里也写着"会计政策，可审计、
// 可追溯改过什么"，但没有任何界面用它们，而 `db/seed.js` 的注释还写着"它们在界面上可改"。
// 于是口径只能靠直连数据库或裸调 API 改 —— 而那是**决定同一份账能算出多少利润**的东西。
//
// 四个要点直接反映在界面上（全部来自服务端，前端不自己定义）：
//   ① **危险字段的清单只有一个出处**（`/reports/config/meta` 的 `danger_fields`）：
//      改到它们就是会计政策变更，必须写理由；只改行名 / 显示行次 / 缩进 / 排序**不用**。
//   ② **删除必须写理由** —— `report_lines` 是物理删除，删掉的那一行只剩日志里的整行快照。
//   ③ **变更历史只读**：没有编辑/删除入口；删除记录会把"删掉的那一行原来是什么"整行摊开。
//   ④ 顶部横幅回答"库里的现状能不能由这些历史重放出来"（八条探针，与关账前置共用一份）。
import { useMemo, useState } from 'react'
import { Card, SectionTitle, Modal, Field, Tabs, toast, useFetch, Empty, Status } from '../../components/ui'
import { api } from '../../api/client'

type Opt = { value: string; label: string }
type CfgMeta = {
  actions: { key: string; label: string; effect: string }[]
  targets: { key: string; label: string }[]
  danger_fields: { def: string[]; line: string[] }
  snapshot_fields: { def: string[]; line: string[] }
  field_labels: Record<string, string>
  entries: number
  baselines: number
}
type DefRow = {
  id: number
  report_code: string
  name: string
  basis: string
  basis_label: string
  cash_subjects: string | null
  cover_categories: string | null
  remark: string | null
  status: string
  line_count: number
}
type LineRow = {
  id: number
  report_code: string
  line_code: string
  line_no: number
  display_no: string | null
  line_name: string
  line_type: string
  line_type_label: string
  level: number
  subject_range: string | null
  sign: number
  only_direction: string | null
  subtotal_expr: string | null
  is_fallback: number
  order_no: number
  remark: string | null
}
type AuditRow = {
  id: number
  target_type: string
  target_label: string
  report_code: string
  line_code: string | null
  action: string
  action_label: string
  title: string
  changed: { field: string; label: string; before: any; after: any; danger: boolean }[]
  snapshot_before: any
  snapshot_after: any
  is_danger: boolean
  reason: string | null
  actor_name: string | null
  actor_source: string
  created_at: string
}

/** 行编辑表单：**字段名与后端 `SNAPSHOT_FIELDS.line` 同名**，改动差分才能直接对着算 */
type LineForm = {
  line_code: string
  line_no: string
  display_no: string
  line_name: string
  line_type: string
  level: string
  subject_range: string
  subtotal_expr: string
  only_direction: string
  sign: string
  is_fallback: boolean
  order_no: string
  remark: string
  reason: string
}
type DefForm = {
  name: string
  basis: string
  cash_subjects: string
  cover_categories: string
  remark: string
  status: string
  reason: string
}

const emptyLineForm = (): LineForm => ({
  line_code: '',
  line_no: '',
  display_no: '',
  line_name: '',
  line_type: 'item',
  level: '1',
  subject_range: '',
  subtotal_expr: '',
  only_direction: '',
  sign: '1',
  is_fallback: false,
  order_no: '',
  remark: '',
  reason: ''
})

const formOfLine = (r: LineRow): LineForm => ({
  line_code: r.line_code,
  line_no: String(r.line_no),
  display_no: r.display_no ?? '',
  line_name: r.line_name,
  line_type: r.line_type,
  level: String(r.level),
  subject_range: r.subject_range ?? '',
  subtotal_expr: r.subtotal_expr ?? '',
  only_direction: r.only_direction ?? '',
  sign: String(r.sign),
  is_fallback: Number(r.is_fallback) === 1,
  order_no: String(r.order_no),
  remark: r.remark ?? '',
  reason: ''
})

const formOfDef = (d: DefRow): DefForm => ({
  name: d.name,
  basis: d.basis,
  cash_subjects: d.cash_subjects ?? '',
  cover_categories: d.cover_categories ?? '',
  remark: d.remark ?? '',
  status: d.status,
  reason: ''
})

export default function ReportConfig() {
  const [tab, setTab] = useState('lines')
  const [code, setCode] = useState('bs')

  const meta = useFetch<CfgMeta>('/reports/config/meta')
  const check = useFetch<any>('/reports/config/audit/check')
  const rmeta = useFetch<any>('/reports/meta')
  const defs = useFetch<any>('/reports/defs')
  const lines = useFetch<any>(`/reports/defs/${code}/lines`)
  const audit = useFetch<any>('/reports/config/audit', { report_code: code, limit: 200 })

  const [lineEdit, setLineEdit] = useState<{ row: LineRow | null; form: LineForm } | null>(null)
  const [defEdit, setDefEdit] = useState<DefForm | null>(null)
  const [delTarget, setDelTarget] = useState<LineRow | null>(null)
  const [delReason, setDelReason] = useState('')
  const [saving, setSaving] = useState(false)

  const defRows: DefRow[] = defs.data?.rows || []
  const lineRows: LineRow[] = lines.data?.rows || []
  const auditRows: AuditRow[] = audit.data?.rows || []
  const problems: any[] = check.data?.problems || []
  const currentDef = defRows.find((d) => d.report_code === code)
  const basisOpts: Opt[] = rmeta.data?.basis || []
  const typeOpts: Opt[] = rmeta.data?.line_types || []
  const dangerLine: string[] = meta.data?.danger_fields?.line || []
  const dangerDef: string[] = meta.data?.danger_fields?.def || []
  const labels: Record<string, string> = meta.data?.field_labels || {}

  /**
   * 「这次改动算不算会计政策变更」的**提示**。
   *
   * 判据来自服务端（`danger_fields`），前端只做差分与提示 —— 真正的闸门在
   * `lib/report-config-audit.js` 的 `isDangerChange`，界面判断错了也不会放行
   * （服务端会返回 `REPORT_CONFIG_REASON_REQUIRED`）。
   * 因为"哪些字段危险"只有一份定义，前端读的正是那一份，所以两边不可能分叉。
   */
  const touchedDanger = (fields: string[], danger: string[], before: any, after: any) =>
    fields.filter((f) => String(before?.[f] ?? '') !== String(after?.[f] ?? ''))

  const lineFormDanger = useMemo(() => {
    if (!lineEdit) return { fields: [] as string[], danger: false }
    const before = lineEdit.row
    const f = lineEdit.form
    const after: any = {
      line_code: f.line_code,
      line_no: f.line_no,
      display_no: f.display_no,
      line_name: f.line_name,
      line_type: f.line_type,
      level: f.level,
      subject_range: f.line_type === 'item' ? f.subject_range : null,
      subtotal_expr: f.line_type === 'item' ? null : f.subtotal_expr,
      only_direction: f.only_direction || null,
      sign: f.sign,
      is_fallback: f.is_fallback ? 1 : 0,
      order_no: f.order_no,
      remark: f.remark
    }
    if (!before) return { fields: dangerLine, danger: true } // 新增：见下方说明
    const fields = touchedDanger(
      Object.keys(after),
      dangerLine,
      before as any,
      after
    )
    return { fields, danger: fields.length > 0 }
  }, [lineEdit, dangerLine])

  const defFormDanger = useMemo(() => {
    if (!defEdit || !currentDef) return { fields: [] as string[], danger: false }
    const fields = touchedDanger(
      ['name', 'basis', 'cash_subjects', 'cover_categories', 'remark', 'status'],
      dangerDef,
      currentDef as any,
      defEdit
    )
    return { fields, danger: fields.filter((x) => dangerDef.includes(x)).length > 0 }
  }, [defEdit, currentDef, dangerDef])

  const labelOf = (f: string) => labels[f] || f

  const reloadAll = () => {
    defs.reload()
    lines.reload()
    audit.reload()
    check.reload()
    meta.reload()
  }

  const saveLine = async () => {
    if (!lineEdit) return
    const f = lineEdit.form
    if (lineFormDanger.danger && !f.reason.trim()) {
      toast('这次改动动了会计政策字段（或新增了一行），必须写理由', 'error')
      return
    }
    setSaving(true)
    try {
      const res: any = await api.post('/reports/lines', {
        report_code: code,
        line_code: f.line_code,
        line_no: Number(f.line_no),
        display_no: f.display_no || null,
        line_name: f.line_name,
        line_type: f.line_type,
        level: Number(f.level || 1),
        subject_range: f.line_type === 'item' ? f.subject_range : null,
        subtotal_expr: f.line_type === 'item' ? null : f.subtotal_expr,
        only_direction: f.only_direction || null,
        sign: Number(f.sign),
        is_fallback: f.is_fallback,
        order_no: Number(f.order_no || f.line_no || 0),
        remark: f.remark || null,
        reason: f.reason.trim() || undefined
      })
      const d = res?.data || {}
      toast(d.changed ? `已保存：${d.line_name}` : '与当前口径一致，未发生变更', d.changed ? 'success' : 'info')
      setLineEdit(null)
      reloadAll()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveDef = async () => {
    if (!defEdit) return
    if (defFormDanger.danger && !defEdit.reason.trim()) {
      toast('这次改动动了取数口径 / 覆盖科目 / 状态，必须写理由', 'error')
      return
    }
    setSaving(true)
    try {
      const res: any = await api.put(`/reports/defs/${code}`, {
        name: defEdit.name,
        basis: defEdit.basis,
        cash_subjects: defEdit.cash_subjects || null,
        cover_categories: defEdit.cover_categories || null,
        remark: defEdit.remark || null,
        status: defEdit.status,
        reason: defEdit.reason.trim() || undefined
      })
      const d = res?.data || {}
      toast(d.changed ? `已保存报表定义：${d.name}` : '与当前定义一致，未发生变更', d.changed ? 'success' : 'info')
      setDefEdit(null)
      reloadAll()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async () => {
    if (!delTarget) return
    if (!delReason.trim()) {
      toast('删除一行口径不可逆（只剩日志里的快照），必须写理由', 'error')
      return
    }
    setSaving(true)
    try {
      const res: any = await api.del(`/reports/lines/${delTarget.id}`, { reason: delReason.trim() })
      const d = res?.data || {}
      toast(d.line_name ? `已删除：${d.line_name}` : '已删除', 'success')
      setDelTarget(null)
      setDelReason('')
      reloadAll()
    } catch (e: any) {
      toast(e?.message || '删除失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const tabs = useMemo(
    () => [
      { key: 'lines', label: '报表口径', count: lineRows.length },
      { key: 'audit', label: '变更历史', count: audit.data?.total }
    ],
    [lineRows.length, audit.data?.total]
  )

  const dangerHint = (fields: string[]) =>
    fields.map((x) => labelOf(x)).join('、')

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">报表口径</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">
          报表结构（科目区间 / 方向口径 / 小计表达式）是<b>会计政策</b>，不是展示配置 —— 改一行能让同一份账算出不同的利润。
          每一次改动都留一条只追加的变更记录（含<b>改动前后的整行快照</b>），可从日志重放出当前口径。
        </p>
      </div>

      {/* 自证横幅：回答"库里的现状能不能由这些历史重放出来"。八条探针，与关账前置共用一份判据。 */}
      {check.data && (
        <div
          className={`mb-3 rounded-md border px-4 py-2.5 text-[12px] ${
            check.data.ok
              ? 'border-emerald-200 bg-emerald-50/70 text-emerald-800'
              : 'border-red-200 bg-red-50/70 text-red-800'
          }`}
        >
          {check.data.ok ? (
            <span>
              报表口径变更链自洽：核 {check.data.entries_checked} 条记录 / 定义 {check.data.defs_checked} 张 /
              口径行 {check.data.lines_checked} 行，重放日志可得到当前口径。
            </span>
          ) : (
            <span>
              报表口径变更链<b>不自洽</b>（{problems.length} 处）——
              {problems.slice(0, 3).map((p) => p.message).join('；')}
            </span>
          )}
        </div>
      )}

      <div className="mb-3">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>

      {/* 报表切换：三张主表的口径各自独立（危险字段集共用一份） */}
      <div className="mb-3 flex items-center gap-2 flex-wrap">
        {defRows.map((d) => (
          <button
            key={d.report_code}
            className={`px-3 py-1.5 rounded border text-[12px] ${
              code === d.report_code
                ? 'border-brand-500 bg-brand-50 text-brand-700 font-medium'
                : 'border-slate-200 bg-white text-ink-700 hover:border-slate-300'
            }`}
            onClick={() => setCode(d.report_code)}
          >
            {d.name}
            <span className="ml-1.5 text-slate-400">{d.line_count} 行</span>
          </button>
        ))}
        {currentDef && (
          <button className="ml-auto text-[12px] text-brand-600 hover:underline" onClick={() => setDefEdit(formOfDef(currentDef))}>
            编辑报表定义（取数口径 / 覆盖科目 / 状态）
          </button>
        )}
      </div>

      {currentDef && (
        <div className="mb-3 rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-ink-700 leading-relaxed">
          <div>
            <b>取数口径</b>：{currentDef.basis_label}（{currentDef.basis}）
            {'　'}
            <b>状态</b>：{currentDef.status === 'active' ? '启用' : '停用'}
          </div>
          <div className="mt-0.5">
            <b>现金类科目</b>：{currentDef.cash_subjects || '—'}
            {'　'}
            <b>必须穷尽覆盖</b>：{currentDef.cover_categories || '（不做覆盖检查）'}
          </div>
        </div>
      )}

      {tab === 'lines' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title="报表口径行"
              desc="行号是小计表达式的引用锚点；小计表达式只允许「行号 + 加减号」—— 能被界面编辑的配置一旦能写表达式，就等于配置能改账。"
              right={
                <button
                  className="btn-primary text-[12px]"
                  onClick={() => {
                    const maxNo = lineRows.reduce((m, r) => Math.max(m, Number(r.line_no) || 0), 0)
                    setLineEdit({ row: null, form: { ...emptyLineForm(), line_no: String(maxNo + 1) } })
                  }}
                >
                  新增一行
                </button>
              }
            />
          </div>
          {(meta.data?.danger_fields?.line || []).length > 0 && (
            <div className="px-4 pb-2 text-[11px] text-slate-400">
              带 ⚠ 的字段是会计政策字段：改动必须写理由。当前报表的危险字段集：
              {dangerHint(dangerLine)}。
            </div>
          )}
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 60 }}>行号</th>
                  <th style={{ width: 60 }}>行次</th>
                  <th style={{ width: 200 }}>行名称</th>
                  <th style={{ width: 80 }}>类型</th>
                  <th>科目区间 / 小计表达式</th>
                  <th style={{ width: 80 }}>方向</th>
                  <th style={{ width: 60 }}>系数</th>
                  <th style={{ width: 90 }}>兜底</th>
                  <th style={{ width: 110 }}></th>
                </tr>
              </thead>
              <tbody>
                {lineRows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="text-center py-4 text-slate-400">这张报表还没有口径行</td>
                  </tr>
                )}
                {lineRows.map((r) => (
                  <tr key={r.id} className={Number(r.is_fallback) === 1 ? 'bg-amber-50/40' : ''}>
                    <td className="text-[12px] font-mono text-ink-900">{r.line_no}</td>
                    <td className="text-[12px] text-slate-500">{r.display_no || '—'}</td>
                    <td>
                      <div className="text-[12px] text-ink-900" style={{ paddingLeft: Math.max(0, (Number(r.level) || 1) - 1) * 10 }}>
                        {r.line_name}
                      </div>
                      <div className="font-mono text-[10px] text-slate-400">{r.line_code}</div>
                    </td>
                    <td className="text-[11px] text-ink-700">{r.line_type_label}</td>
                    <td className="font-mono text-[11px] text-ink-700">{r.subject_range || r.subtotal_expr || '—'}</td>
                    <td className="text-[11px]">{r.only_direction ? (r.only_direction === 'credit' ? '仅流入' : '仅流出') : '—'}</td>
                    <td className={`text-[12px] ${Number(r.sign) === -1 ? 'text-orange-700 font-medium' : 'text-ink-700'}`}>{r.sign}</td>
                    <td className="text-[11px]">{Number(r.is_fallback) === 1 ? '兜底行' : '—'}</td>
                    <td>
                      <button className="text-[12px] text-brand-600 hover:underline mr-2" onClick={() => setLineEdit({ row: r, form: formOfLine(r) })}>
                        修改
                      </button>
                      <button className="text-[12px] text-red-600 hover:underline" onClick={() => { setDelTarget(r); setDelReason('') }}>
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {tab === 'audit' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title="变更历史"
              desc="只追加，没有修改与删除路径。删除记录会把被删掉的那一行整行摊开 —— 口径行是物理删除，快照是它唯一还能被查到的地方。"
              right={<span className="text-[11px] text-slate-400">共 {audit.data?.total ?? 0} 条（基线 {meta.data?.baselines ?? 0} 条）</span>}
            />
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>时间</th>
                  <th style={{ width: 100 }}>动作</th>
                  <th style={{ width: 110 }}>类型</th>
                  <th style={{ width: 190 }}>目标</th>
                  <th>改了什么（改前 → 改后）</th>
                  <th>理由</th>
                  <th style={{ width: 100 }}>操作人</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.length === 0 && (
                  <tr>
                    <td colSpan={7} className="text-center py-4 text-slate-400">这张报表暂无变更记录</td>
                  </tr>
                )}
                {auditRows.map((r) => (
                  <tr key={r.id} className={r.is_danger ? 'bg-amber-50/40' : ''}>
                    <td className="text-[11px] text-ink-700">{(r.created_at || '').slice(0, 19)}</td>
                    <td>
                      <Status value={r.action} text={r.action_label} />
                    </td>
                    <td className="text-[11px] text-slate-500">{r.target_label}</td>
                    <td>
                      <div className="text-[12px] text-ink-900">{r.title}</div>
                      <div className="font-mono text-[10px] text-slate-400">
                        {r.report_code}
                        {r.line_code ? ` / ${r.line_code}` : ''}
                      </div>
                    </td>
                    <td className="text-[11px] leading-relaxed">
                      {r.action === 'delete' ? (
                        // **删除记录的重点**：这一行在 report_lines 里已经没有了，
                        // 这里把快照摊开 —— 这就是"删掉的是什么"的唯一答案。
                        <div className="text-red-700">
                          整行被删除：
                          {['line_no', 'line_name', 'line_type', 'subject_range', 'subtotal_expr', 'sign', 'only_direction', 'is_fallback']
                            .filter((f) => r.snapshot_before && r.snapshot_before[f] !== null && r.snapshot_before[f] !== undefined)
                            .map((f) => `${labelOf(f)}=${r.snapshot_before[f]}`)
                            .join('，')}
                        </div>
                      ) : r.action === 'baseline' ? (
                        <span className="text-slate-400">初始化时的现状快照（不是谁的动作）</span>
                      ) : r.changed.length === 0 ? (
                        <span className="text-slate-400">—</span>
                      ) : (
                        r.changed.map((c) => (
                          <div key={c.field} className={c.danger ? 'text-orange-800' : 'text-ink-700'}>
                            {c.danger ? '⚠ ' : ''}
                            {c.label}：
                            <span className="text-slate-400">{c.before ?? '（无）'}</span>
                            <span className="mx-1 text-slate-400">→</span>
                            <span>{c.after ?? '（无）'}</span>
                          </div>
                        ))
                      )}
                    </td>
                    <td className="text-[11px] text-ink-700 leading-relaxed">{r.reason || <span className="text-slate-400">—</span>}</td>
                    <td className="text-[11px] text-ink-700">{r.actor_name || r.actor_source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data?.filtered !== undefined && audit.data?.total > audit.data?.filtered && (
            <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
              仅显示最近 {audit.data.filtered} 条（按该报表筛选后共 {audit.data.total} 条）
            </div>
          )}
        </Card>
      )}

      {/* ---------- 行编辑 ---------- */}
      <Modal
        open={!!lineEdit}
        title={lineEdit?.row ? `修改口径行：${lineEdit.row.line_name}` : '新增一行口径'}
        onClose={() => setLineEdit(null)}
        width={720}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setLineEdit(null)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={saveLine}>{saving ? '保存中…' : '保存'}</button>
          </>
        }
      >
        {lineEdit && (
          <div className="space-y-3">
            <div className="grid grid-cols-3 gap-3">
              <Field label="行号" required hint="小计表达式按它引用；已被小计引用的行号不能挪">
                <input className="input" value={lineEdit.form.line_no} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, line_no: e.target.value } })} />
              </Field>
              <Field label="行机器键" required hint={lineEdit.row ? '身份键，不可改（改了等于新增一行）' : '如 BS_CASH'}>
                <input
                  className="input font-mono"
                  value={lineEdit.form.line_code}
                  disabled={!!lineEdit.row}
                  onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, line_code: e.target.value } })}
                />
              </Field>
              <Field label="显示行次" hint="如「一」/「1」，可空">
                <input className="input" value={lineEdit.form.display_no} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, display_no: e.target.value } })} />
              </Field>
              <Field label="行名称" required span={2}>
                <input className="input" value={lineEdit.form.line_name} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, line_name: e.target.value } })} />
              </Field>
              <Field label="行类型" required>
                <select className="input" value={lineEdit.form.line_type} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, line_type: e.target.value } })}>
                  {typeOpts.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </Field>
              {lineEdit.form.line_type === 'item' ? (
                <Field label="科目区间" required span={3} hint="形如 1001~1002；多段用 | 分隔，如 1122~1122|2203~2203">
                  <input className="input font-mono" value={lineEdit.form.subject_range} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, subject_range: e.target.value } })} />
                </Field>
              ) : (
                <Field label="小计表达式" required span={3} hint="只允许「行号 + 加减号」，如 1+2+3-4 —— 能写表达式的配置就等于配置能改账">
                  <input className="input font-mono" value={lineEdit.form.subtotal_expr} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, subtotal_expr: e.target.value } })} />
                </Field>
              )}
              <Field label="方向系数" required hint="+1 / −1，作用于本行金额">
                <select className="input" value={lineEdit.form.sign} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, sign: e.target.value } })}>
                  <option value="1">+1</option>
                  <option value="-1">−1</option>
                </select>
              </Field>
              <Field label="方向过滤" hint="只在现金流量表上有意义">
                <select className="input" value={lineEdit.form.only_direction} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, only_direction: e.target.value } })}>
                  <option value="">不限</option>
                  <option value="credit">仅流入（credit）</option>
                  <option value="debit">仅流出（debit）</option>
                </select>
              </Field>
              <Field label="缩进层级" hint="只影响观感">
                <input className="input" value={lineEdit.form.level} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, level: e.target.value } })} />
              </Field>
              <Field label="排序号">
                <input className="input" value={lineEdit.form.order_no} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, order_no: e.target.value } })} />
              </Field>
              <Field label="兜底行" hint="只在其它行都不认领时才接；金额非 0 即说明口径漏配">
                <label className="flex items-center gap-2 text-[12px] py-1.5">
                  <input type="checkbox" checked={lineEdit.form.is_fallback} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, is_fallback: e.target.checked } })} />
                  <span>是兜底行</span>
                </label>
              </Field>
              <Field label="备注">
                <input className="input" value={lineEdit.form.remark} onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, remark: e.target.value } })} />
              </Field>
            </div>

            <Field
              label="理由"
              required={lineFormDanger.danger}
              hint={
                lineFormDanger.danger
                  ? `这次动了会计政策字段（${lineEdit.row ? dangerHint(lineFormDanger.fields) : '新增一行会让报表多一块'}），必须答得出为什么`
                  : '只改了展示字段（行名 / 行次 / 缩进 / 排序 / 备注），可以不填'
              }
            >
              <textarea
                className="input"
                rows={2}
                value={lineEdit.form.reason}
                onChange={(e) => setLineEdit({ ...lineEdit, form: { ...lineEdit.form, reason: e.target.value } })}
                placeholder={lineFormDanger.danger ? '例如：口径调整：下半年起并入留存收益' : '（可不填）'}
              />
            </Field>

            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-ink-700 leading-relaxed">
              <div>
                <b>这次会被判为</b>：
                {lineFormDanger.danger ? (
                  <span className="text-orange-800">风险改动（动到 {dangerHint(lineFormDanger.fields)}）</span>
                ) : (
                  <span className="text-emerald-700">展示改动（不动任何金额）</span>
                )}
              </div>
              <div className="mt-1 text-slate-400">
                判据在服务端（lib/report-config-audit.js 的 danger_fields 加差分），界面只做提示 —— 界面判断错了也放行不了。
                保存后会在「变更历史」里留下一条含<b>整行快照</b>的只追加记录。
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- 报表定义编辑 ---------- */}
      <Modal
        open={!!defEdit}
        title={`编辑报表定义：${currentDef?.name || ''}`}
        onClose={() => setDefEdit(null)}
        width={640}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDefEdit(null)}>取消</button>
            <button className="btn-primary" disabled={saving} onClick={saveDef}>{saving ? '保存中…' : '保存'}</button>
          </>
        }
      >
        {defEdit && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <Field label="报表名称" required>
                <input className="input" value={defEdit.name} onChange={(e) => setDefEdit({ ...defEdit, name: e.target.value })} />
              </Field>
              <Field label="取数口径" required hint="换它等于换一套会计政策">
                <select className="input" value={defEdit.basis} onChange={(e) => setDefEdit({ ...defEdit, basis: e.target.value })}>
                  {basisOpts.map((o) => (
                    <option key={o.value} value={o.value}>{`${o.label}（${o.value}）`}</option>
                  ))}
                </select>
              </Field>
              <Field label="状态">
                <select className="input" value={defEdit.status} onChange={(e) => setDefEdit({ ...defEdit, status: e.target.value })}>
                  <option value="active">启用</option>
                  <option value="disabled">停用</option>
                </select>
              </Field>
              <Field label="备注">
                <input className="input" value={defEdit.remark} onChange={(e) => setDefEdit({ ...defEdit, remark: e.target.value })} />
              </Field>
              <Field label="现金类科目" span={2} hint="仅现金流量表用：逗号分隔，如 1001,1002">
                <input className="input font-mono" value={defEdit.cash_subjects} onChange={(e) => setDefEdit({ ...defEdit, cash_subjects: e.target.value })} />
              </Field>
              <Field label="必须穷尽覆盖的科目大类" span={2} hint="逗号分隔；空 = 不做覆盖检查。少覆盖一个大类就是少一块钱">
                <input className="input font-mono" value={defEdit.cover_categories} onChange={(e) => setDefEdit({ ...defEdit, cover_categories: e.target.value })} />
              </Field>
            </div>
            <Field
              label="理由"
              required={defFormDanger.danger}
              hint={defFormDanger.danger ? `这次动了 ${dangerHint(defFormDanger.fields.filter((f) => dangerDef.includes(f)))}，必须写理由` : '只改了名称 / 备注，可以不填'}
            >
              <textarea
                className="input"
                rows={2}
                value={defEdit.reason}
                onChange={(e) => setDefEdit({ ...defEdit, reason: e.target.value })}
              />
            </Field>
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-ink-700">
              <b>危险字段</b>：{dangerDef.map((f) => labelOf(f)).join('、')}
            </div>
          </div>
        )}
      </Modal>

      {/* ---------- 删除 ---------- */}
      <Modal
        open={!!delTarget}
        title={delTarget ? `删除口径行：${delTarget.line_name}` : ''}
        onClose={() => setDelTarget(null)}
        width={560}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setDelTarget(null)}>取消</button>
            <button className="btn-primary" disabled={saving || !delReason.trim()} onClick={doDelete}>
              {saving ? '删除中…' : '确认删除'}
            </button>
          </>
        }
      >
        {delTarget && (
          <div className="space-y-3">
            <div className="rounded border border-red-200 bg-red-50/70 px-3 py-2 text-[11px] text-red-800 leading-relaxed">
              删除是<b>物理删除</b>且不可逆：这一行会从 <span className="font-mono">report_lines</span> 里消失。
              它之后唯一还能被查到的地方是本次留下的<b>整行快照</b>（变更历史里能看到删掉的是什么）。
              {delTarget.subtotal_expr ? ' 它是一条小计行 —— 删掉会让引用它的合计少一块。' : ''}
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-ink-700 leading-relaxed">
              <div>行号 <b>{delTarget.line_no}</b>　类型 <b>{delTarget.line_type_label}</b></div>
              <div className="mt-0.5 font-mono">
                {delTarget.subject_range || delTarget.subtotal_expr || '—'}
              </div>
            </div>
            <Field label="理由" required hint="删掉一行口径会让报表少一块，必须答得出为什么">
              <textarea className="input" rows={2} value={delReason} onChange={(e) => setDelReason(e.target.value)} placeholder="例如：口径拆分：这一行拆成两行分别列示" />
            </Field>
          </div>
        )}
      </Modal>

      {defRows.length === 0 && !defs.loading && <Empty text="还没有报表定义" />}
    </div>
  )
}
