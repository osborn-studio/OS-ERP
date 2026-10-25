/**
 * ============================================================================
 * 文件标识：src/pages/system/Settings.tsx ｜ 系统参数
 * ============================================================================
 * 【职责】系统参数（页面）
 * 【入口】/system/settings
 * 【主要接口】/meta/settings、/meta/settings/audit/check、/meta/settings/audit、/meta/settings/reset
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
 * 页面：系统参数
 */

// 系统参数（批次 R）：配置的定义、当前值与**变更历史**
//
// 这一页在此之前**根本不存在**：`GET/PUT /settings` 早就有了，但没有任何界面用它 ——
// 配置只能靠直连数据库或裸调 API 改，改完也没有任何痕迹。
//
// 三个要点直接反映在界面上：
//   ① **定义只有一个出处**（`server/lib/settings.js` 的 `SETTING_RULES`）：
//      标签 / 类型 / 默认值 / 值域 / 是否危险 / 影响说明都由服务端给，前端不自己分类。
//   ② **危险配置改它必须写理由** —— 会计政策（结转目标科目、年结留存科目）、
//      应收口径、门店长短款阈值。这些改动会改变**已经结出来的账**怎么解释。
//   ③ **变更历史是只追加的**：界面只读它，没有删除/编辑入口；
//      顶部的自证横幅回答"库里的现状能不能由这些历史重放出来"。
import { useMemo, useState } from 'react'
import { Card, SectionTitle, Modal, Field, Tabs, toast, useFetch, Empty, Status } from '../../components/ui'
import { api } from '../../api/client'
import BackupReportCard from '../../components/BackupReportCard'

type EnumOpt = { value: string; label: string }
type SettingItem = {
  key: string
  label: string
  group: string
  type: string
  default: string
  is_danger: boolean
  wired: boolean
  impact: string
  enum: EnumOpt[] | null
  min: number | null
  max: number | null
  gt: number | null
  value_raw: string
  value: any
  persisted: boolean
  is_default: boolean
  updated_at: string | null
  history_count: number
  changed_count: number
  last_changed_at: string | null
}
type Group = { key: string; label: string; note: string; items: SettingItem[] }
type SettingsData = { groups: Group[]; items: SettingItem[]; total: number; changed: number; note: string }
type AuditRow = {
  id: number; key: string; key_label: string; action: string; action_label: string
  group_key: string; value_before: string | null; value_after: string | null
  is_danger: boolean; reason: string | null; actor_name: string | null
  actor_source: string; actor_label: string; created_at: string
}

/** 把库里的字符串渲染成人读的样子（bool → 开/关，enum → 中文名） */
function displayValue(it: SettingItem, raw: string | null | undefined) {
  if (raw === null || raw === undefined || raw === '') return '—'
  if (it.type === 'bool') return raw === '1' ? '开' : '关'
  if (it.type === 'enum') {
    const hit = (it.enum || []).find((e) => e.value === raw)
    return hit ? `${hit.label}（${raw}）` : raw
  }
  return raw
}

export default function Settings() {
  const [tab, setTab] = useState('defs')
  const [editing, setEditing] = useState<SettingItem | null>(null)
  const [form, setForm] = useState({ value: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const [dangerOnly, setDangerOnly] = useState(false)

  const { data, loading, reload } = useFetch<SettingsData>('/meta/settings')
  const check = useFetch<any>('/meta/settings/audit/check')
  const audit = useFetch<any>('/meta/settings/audit', dangerOnly ? { danger_only: 1, limit: 200 } : { limit: 200 })

  const groups = data?.groups || []
  const auditRows: AuditRow[] = audit.data?.rows || []
  const problems: any[] = check.data?.problems || []

  const openEdit = (it: SettingItem) => {
    setEditing(it)
    setForm({ value: it.value_raw, reason: '' })
  }

  const submit = async () => {
    if (!editing) return
    if (editing.is_danger && !form.reason.trim()) {
      toast('这是会计政策/业务口径，修改必须写理由', 'error')
      return
    }
    setSaving(true)
    try {
      const res: any = await api.put('/meta/settings', {
        key: editing.key,
        value: form.value,
        reason: form.reason.trim() || undefined
      })
      const d = res?.data || {}
      // 值没变时服务端如实回答 changed=false（那不算一次变更，不该写历史）
      toast(d.changed ? `已更新：${editing.label}` : '值与当前一致，未发生变更', d.changed ? 'success' : 'info')
      setEditing(null)
      reload()
      audit.reload()
      check.reload()
    } catch (e: any) {
      toast(e?.message || '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const reset = async () => {
    if (!editing) return
    if (editing.is_danger && !form.reason.trim()) {
      toast('恢复默认值同样是一次变更，必须写理由', 'error')
      return
    }
    setSaving(true)
    try {
      const res: any = await api.post('/meta/settings/reset', {
        key: editing.key,
        reason: form.reason.trim() || undefined
      })
      const d = res?.data || {}
      toast(d.changed ? `已恢复默认值：${editing.label}` : '当前就是默认值，未发生变更', d.changed ? 'success' : 'info')
      setEditing(null)
      reload()
      audit.reload()
      check.reload()
    } catch (e: any) {
      toast(e?.message || '恢复失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const tabs = useMemo(
    () => [
      { key: 'defs', label: '配置项', count: data?.total },
      { key: 'audit', label: '变更历史', count: audit.data?.total }
    ],
    [data?.total, audit.data?.total]
  )

  return (
    <div>
      <div className="mb-3">
        <h1 className="title-serif text-[19px] font-medium text-ink-900">系统参数</h1>
        <p className="text-[12px] text-ink-700 mt-0.5">
          配置的定义（标签 / 类型 / 默认值 / 值域 / 是否危险）只有一个出处；每一次改动都留一条只追加的变更记录，
          可从日志重放出当前的配置值。
        </p>
      </div>

      <BackupReportCard />

      {/* 自证横幅：这一条回答"库里的现状能不能由历史解释得出来" */}
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
              配置变更链自洽：核 {check.data.keys_checked} 项配置 / {check.data.entries_checked} 条变更记录，
              重放日志可得到当前值；登记 {check.data.registered_keys} 项，库里的键集合与登记表一致。
            </span>
          ) : (
            <span>
              配置变更链**不自洽**（{problems.length} 处）——
              {problems.slice(0, 3).map((p) => p.message).join('；')}
            </span>
          )}
        </div>
      )}

      <div className="mb-3">
        <Tabs tabs={tabs} value={tab} onChange={setTab} />
      </div>

      {tab === 'defs' && (
        <>
          <div className="mb-2 text-[12px] text-ink-700">
            共 {data?.total ?? 0} 项，其中 <b>{data?.changed ?? 0}</b> 项已偏离默认值。
            <span className="text-slate-400 ml-1">（带 ⚠ 的是危险配置：改动必须写理由）</span>
          </div>
          {loading && !data && <div className="text-[12px] text-slate-400 py-6">加载中…</div>}
          {!loading && groups.length === 0 && <Empty text="没有登记任何配置项" />}
          <div className="space-y-3">
            {groups.map((g) => (
              <Card key={g.key} pad={false}>
                <div className="px-4 pt-4">
                  <SectionTitle
                    title={g.label}
                    desc={g.note}
                    right={<span className="text-[11px] text-slate-400">{g.items.length} 项</span>}
                  />
                </div>
                <div className="table-wrap">
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th style={{ width: 200 }}>配置</th>
                        <th style={{ width: 220 }}>当前值</th>
                        <th style={{ width: 150 }}>默认值</th>
                        <th>影响</th>
                        <th style={{ width: 130 }}>最近变更</th>
                        <th style={{ width: 70 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {g.items.map((it) => (
                        <tr key={it.key} className={it.is_danger ? 'bg-amber-50/40' : ''}>
                          <td>
                            <div className="flex items-center gap-1">
                              {it.is_danger && <span title="危险配置：改动必须写理由" className="text-amber-600">⚠</span>}
                              <span className="text-[12px] font-medium text-ink-900">{it.label}</span>
                            </div>
                            <div className="font-mono text-[10px] text-slate-400 mt-0.5">{it.key}</div>
                          </td>
                          <td>
                            <span className={`text-[12px] ${it.is_default ? 'text-ink-700' : 'text-orange-700 font-medium'}`}>
                              {displayValue(it, it.value_raw)}
                            </span>
                            {!it.wired && (
                              <div className="text-[10px] text-slate-400 mt-0.5">登记待接：当前代码无读取点</div>
                            )}
                          </td>
                          <td className="text-[12px] text-slate-500">{displayValue(it, it.default)}</td>
                          <td className="text-[11px] text-ink-700 leading-relaxed">{it.impact}</td>
                          <td>
                            {it.changed_count > 0 ? (
                              <div>
                                <div className="text-[11px] text-ink-700">被改过 {it.changed_count} 次</div>
                                <div className="text-[10px] text-slate-400">{(it.last_changed_at || '').slice(0, 16)}</div>
                              </div>
                            ) : (
                              <span className="text-[11px] text-slate-400">仍是默认</span>
                            )}
                          </td>
                          <td>
                            <button className="text-[12px] text-brand-600 hover:underline" onClick={() => openEdit(it)}>
                              修改
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            ))}
          </div>
        </>
      )}

      {tab === 'audit' && (
        <Card pad={false}>
          <div className="px-4 pt-4">
            <SectionTitle
              title="变更历史"
              desc="只追加，没有修改与删除路径。基线（baseline）是初始化时按现状补记的，不表示任何人的动作。"
              right={
                <label className="text-[12px] text-ink-700 flex items-center gap-1.5 cursor-pointer">
                  <input type="checkbox" checked={dangerOnly} onChange={(e) => setDangerOnly(e.target.checked)} />
                  只看危险配置
                </label>
              }
            />
          </div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>时间</th>
                  <th style={{ width: 110 }}>动作</th>
                  <th style={{ width: 180 }}>配置</th>
                  <th style={{ width: 200 }}>变化</th>
                  <th>理由</th>
                  <th style={{ width: 110 }}>操作人</th>
                </tr>
              </thead>
              <tbody>
                {auditRows.length === 0 && (
                  <tr>
                    <td colSpan={6} className="text-center py-4 text-slate-400">暂无变更记录</td>
                  </tr>
                )}
                {auditRows.map((r) => (
                  <tr key={r.id} className={r.is_danger ? 'bg-amber-50/40' : ''}>
                    <td className="text-[11px] text-ink-700">{(r.created_at || '').slice(0, 19)}</td>
                    <td>
                      <Status
                        value={r.action}
                        text={r.action_label}
                      />
                    </td>
                    <td>
                      <div className="text-[12px] text-ink-900">{r.key_label}</div>
                      <div className="font-mono text-[10px] text-slate-400">{r.key}</div>
                    </td>
                    <td className="text-[11px]">
                      <span className="text-slate-400">{r.value_before ?? '（无）'}</span>
                      <span className="mx-1 text-slate-400">→</span>
                      <span className="text-ink-900">{r.value_after ?? '（无）'}</span>
                    </td>
                    <td className="text-[11px] text-ink-700 leading-relaxed">
                      {r.reason || <span className="text-slate-400">—</span>}
                    </td>
                    <td className="text-[11px] text-ink-700">{r.actor_label}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {audit.data?.truncated && (
            <div className="px-4 py-2 text-[11px] text-slate-400 border-t border-slate-100">
              仅显示最近 {auditRows.length} 条（共 {audit.data.total} 条）
            </div>
          )}
        </Card>
      )}

      <Modal
        open={!!editing}
        title={editing ? `修改配置：${editing.label}` : ''}
        onClose={() => setEditing(null)}
        width={620}
        footer={
          <>
            <button className="btn-ghost" onClick={() => setEditing(null)}>取消</button>
            <button className="btn-ghost" disabled={saving} onClick={reset}>恢复默认值</button>
            <button className="btn-primary" disabled={saving} onClick={submit}>{saving ? '保存中…' : '保存'}</button>
          </>
        }
      >
        {editing && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3">
              <Field label="配置键">
                <div className="font-mono text-[12px] text-ink-700 py-1.5">{editing.key}</div>
              </Field>
              <Field
                label="值"
                required
                hint={
                  editing.type === 'bool'
                    ? '开 / 关'
                    : editing.type === 'number' || editing.type === 'int'
                    ? `数字${editing.gt !== undefined && editing.gt !== null ? `，必须大于 ${editing.gt}` : ''}${
                        editing.min !== null ? `，不小于 ${editing.min}` : ''
                      }${editing.max !== null ? `，不大于 ${editing.max}` : ''}`
                    : editing.type === 'subject'
                    ? '科目编码（纯数字）'
                    : undefined
                }
              >
                {editing.type === 'bool' ? (
                  <select className="input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}>
                    <option value="1">开</option>
                    <option value="0">关</option>
                  </select>
                ) : editing.type === 'enum' ? (
                  <select className="input" value={form.value} onChange={(e) => setForm({ ...form, value: e.target.value })}>
                    {(editing.enum || []).map((o) => (
                      <option key={o.value} value={o.value}>{`${o.label}（${o.value}）`}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    className="input"
                    value={form.value}
                    onChange={(e) => setForm({ ...form, value: e.target.value })}
                  />
                )}
              </Field>
              <Field
                label="理由"
                required={editing.is_danger}
                hint={editing.is_danger ? '这是会计政策 / 业务口径：改动会让已经结出来的账换一种解释，必须答得出为什么' : '可选'}
              >
                <textarea
                  className="input"
                  rows={2}
                  value={form.reason}
                  onChange={(e) => setForm({ ...form, reason: e.target.value })}
                  placeholder={editing.is_danger ? '例如：口径调整：下半年起并入留存收益' : '（可不填）'}
                />
              </Field>
            </div>
            <div className="rounded border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-ink-700 leading-relaxed">
              <div><b>当前值</b>：{displayValue(editing, editing.value_raw)}　<b>默认值</b>：{displayValue(editing, editing.default)}</div>
              <div className="mt-1"><b>影响</b>：{editing.impact}</div>
              <div className="mt-1 text-slate-400">保存后会在「变更历史」里留下一条只追加的记录（含改前/改后与理由）。</div>
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
