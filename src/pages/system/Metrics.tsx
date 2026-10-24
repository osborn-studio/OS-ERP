/**
 * ============================================================================
 * 文件标识：src/pages/system/Metrics.tsx ｜ 数据口径字典
 * ============================================================================
 * 【职责】数据口径字典（页面）
 * 【入口】/system/metrics
 * 【主要接口】/metrics/stale
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
 * 页面：数据口径字典
 */

import { useMemo, useState } from 'react'
import { Card, Field, Modal, SectionTitle, StatCard, Table, Tabs, fmtInt, toast, useFetch } from '../../components/ui'
import { useAuth } from '../../store/auth'
import OpsCountersCard from '../../components/OpsCountersCard'
import { RefreshCw, ShieldCheck, ShieldAlert, Calculator, Search, Layers } from 'lucide-react'
import {
  fmtMetricValue, isMetricError, syncMetricDefs,
  type MetricGroup, type MetricItem
} from '../../api/metrics'

/**
 * 数据口径字典（模块 23）。
 *
 * 这一页要回答的是**业务口径问题**，不是技术问题：
 *   「这个数怎么来的？」「不算哪些？」「取自哪？」「什么时候会踩坑？」
 * 所以每一行都必须把「口径」与「按口径算出来的数」并排呈现 ——
 * 只列数字的页面，吵架时没人能赢；只列口径的页面，没人愿意看。
 *
 * 两个 Tab 的分工：
 *   指标字典 —— 业务视角：每个指标叫什么、算什么、现在是多少
 *   自检治理 —— 治理视角：表里的定义有没有落后于代码（落后说明有人只改了一边）
 */

const CATEGORY_TONE: Record<string, string> = {
  规模: 'tag bg-blue-50 text-blue-700',
  效率: 'tag bg-emerald-50 text-emerald-700',
  资金: 'tag bg-amber-50 text-amber-700',
  风险: 'tag bg-red-50 text-red-600',
  流程: 'tag bg-violet-50 text-violet-700'
}

export default function Metrics() {
  const { is } = useAuth()
  const canSync = is('admin')
  const [tab, setTab] = useState('dict')
  const [days, setDays] = useState(30)
  const [kw, setKw] = useState('')
  const [detail, setDetail] = useState<MetricItem | null>(null)
  const [busy, setBusy] = useState(false)

  const { data, loading, reload } = useFetch<{ days: number; groups: MetricGroup[]; total: number; modules: string[] }>(
    '/metrics',
    { days: Math.max(1, Number(days) || 30), with_values: 1 },
    [days]
  )
  const { data: stale, reload: reloadStale } = useFetch<any>('/metrics/stale', undefined, [])

  const groups = data?.groups || []
  const total = data?.total || 0
  const modules = data?.modules || []

  const filtered = useMemo(() => {
    const k = kw.trim().toLowerCase()
    if (!k) return groups
    return groups
      .map((g) => ({
        ...g,
        items: g.items.filter(
          (m) =>
            m.key.toLowerCase().includes(k) ||
            m.name.toLowerCase().includes(k) ||
            (m.formula || '').toLowerCase().includes(k) ||
            (m.source || '').toLowerCase().includes(k)
        )
      }))
      .filter((g) => g.items.length > 0)
  }, [groups, kw])

  const errCount = groups.flatMap((g) => g.items).filter((m) => isMetricError(m.value)).length

  const doSync = async () => {
    setBusy(true)
    try {
      const r: any = await syncMetricDefs()
      toast(`已按代码重新投影 ${r?.synced ?? 0} 条口径`)
      reload()
      reloadStale()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">数据口径字典</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            每个指标的口径与算法写在<strong>同一处</strong>，页面上的数字就是按这行口径现算的
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-ink-600">窗口</span>
          <select className="input input-sm" style={{ width: 110 }} value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            <option value="7">近 7 天</option>
            <option value="30">近 30 天</option>
            <option value="90">近 90 天</option>
            <option value="180">近 180 天</option>
            <option value="365">近 365 天</option>
          </select>
          <button className="btn-ghost btn-sm" onClick={() => { reload(); reloadStale() }}>
            <RefreshCw size={13} /> 刷新
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <StatCard label="指标数" value={fmtInt(total)} icon={<Calculator size={15} />} sub="定义与算法同源" />
        <StatCard label="覆盖模块" value={fmtInt(modules.length)} icon={<Layers size={15} />} sub={modules.slice(0, 2).join(' / ') + (modules.length > 2 ? ' …' : '')} />
        <StatCard
          label="定义一致性"
          value={stale?.stale ? '不一致' : '一致'}
          tone={stale?.stale ? 'red' : 'green'}
          icon={stale?.stale ? <ShieldAlert size={15} /> : <ShieldCheck size={15} />}
          sub={`代码 ${stale?.in_code ?? 0} 条 / 表 ${stale?.in_table ?? 0} 条`}
        />
        <StatCard
          label="算不出的指标"
          value={fmtInt(errCount)}
          tone={errCount > 0 ? 'amber' : 'default'}
          sub={errCount > 0 ? '缺表或缺数据，不是「等于 0」' : '全部可计算'}
        />
      </div>

      <Tabs
        tabs={[
          { key: 'dict', label: '指标字典', count: total },
          { key: 'gov', label: '自检与治理' }
        ]}
        value={tab}
        onChange={setTab}
      />

      {tab === 'dict' && (
        <>
          <div className="mb-3 flex items-center gap-2 flex-wrap">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-400" />
              <input
                className="input pl-7"
                style={{ width: 300 }}
                placeholder="按指标名 / key / 口径 / 来源表搜索"
                value={kw}
                onChange={(e) => setKw(e.target.value)}
              />
            </div>
            <span className="text-[11px] text-ink-400">点任意一行查看完整口径（怎么算 / 不算什么 / 取自哪 / 什么时候会踩坑）</span>
          </div>

          {loading && <Card><div className="py-10 text-center text-ink-400 text-[13px]">加载中…</div></Card>}

          {!loading && filtered.length === 0 && (
            <Card><div className="py-10 text-center text-ink-400 text-[13px]">没有匹配的指标</div></Card>
          )}

          {!loading && filtered.map((g) => (
            <Card key={g.module} className="mb-3">
              <SectionTitle title={g.module} desc={`${g.items.length} 个指标`} />
              <Table
                data={g.items}
                rowKey={(r) => r.key}
                onRowClick={(r) => setDetail(r as MetricItem)}
                columns={[
                  // TODO(AD1): 本分支的 MetricDef 还没有 `scoped` 字段（AD1 引入）。AD1 合入后，`scoped === false` 的指标在此处加
                  //   <span className="tag bg-violet-100 text-violet-700">全局口径</span>，说明该数不随账号数据范围收窄。
                  { key: 'name', title: '指标', width: 180, render: (r) => (
                    <div>
                      <div className="text-ink-900">{r.name}</div>
                      <div className="text-[10px] text-ink-400 font-mono">{r.key}</div>
                    </div>
                  ) },
                  { key: 'category', title: '分类', width: 76, render: (r) =>
                    r.category ? <span className={CATEGORY_TONE[r.category] || 'tag bg-slate-100 text-slate-500'}>{r.category}</span> : '—' },
                  { key: 'value', title: '当前值', width: 160, align: 'right', render: (r) => {
                    if (isMetricError(r.value)) return <span className="text-amber-600" title={(r.value as any).error}>算不出</span>
                    return <strong className={r.value === 0 ? 'text-ink-400' : 'text-ink-900'}>{fmtMetricValue(r.value, r.unit)}</strong>
                  } },
                  { key: 'formula', title: '计算口径', render: (r) => (
                    <span className="text-[12px] text-ink-700 font-mono break-all">{r.formula}</span>
                  ) },
                  { key: 'exclusions', title: '不含什么', width: 270, render: (r) => (
                    <span className="text-[11px] text-red-600">{r.exclusions || '—'}</span>
                  ) }
                ]}
              />
            </Card>
          ))}
        </>
      )}

      {tab === 'gov' && (
        <>
        <Card>
          <SectionTitle
            title="定义一致性自检"
            desc="代码是唯一源，metric_defs 表只是投影 —— 这里检查投影有没有落后于代码"
            right={canSync ? (
              <button className="btn-primary btn-sm" disabled={busy} onClick={doSync}>
                <RefreshCw size={13} className={busy ? 'animate-spin' : ''} /> 按代码重新投影
              </button>
            ) : undefined}
          />

          <div className="text-[12px] text-ink-700 leading-relaxed space-y-3">
            <div className={stale?.stale ? 'text-red-600' : 'text-green-600'}>
              {stale?.stale
                ? '⚠ 表里的定义与代码不一致 —— 有人只改了一边。按上方按钮重新投影即可对齐。'
                : '✓ 表里的定义与代码逐字一致（formula / exclusions / source / note 全部对齐）。'}
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 pt-1">
              <div>
                <div className="kpi-label">代码里的指标</div>
                <div className="kpi-value text-brand-700">{stale?.in_code ?? '—'}</div>
              </div>
              <div>
                <div className="kpi-label">表里的指标</div>
                <div className="kpi-value text-slate-800">{stale?.in_table ?? '—'}</div>
              </div>
              <div>
                <div className="kpi-label">表里缺的</div>
                <div className={`kpi-value ${(stale?.missing_in_table || []).length ? 'text-red-600' : 'text-slate-800'}`}>
                  {(stale?.missing_in_table || []).length}
                </div>
              </div>
              <div>
                <div className="kpi-label">表里多的</div>
                <div className={`kpi-value ${(stale?.extra_in_table || []).length ? 'text-amber-600' : 'text-slate-800'}`}>
                  {(stale?.extra_in_table || []).length}
                </div>
              </div>
            </div>

            {(stale?.missing_in_table || []).length > 0 && (
              <div>
                <div className="label">代码里有、表里没有（会表现为「SQL 查不到口径」）</div>
                <div className="font-mono text-[11px] text-red-600 break-all">{(stale.missing_in_table as string[]).join(', ')}</div>
              </div>
            )}
            {(stale?.extra_in_table || []).length > 0 && (
              <div>
                <div className="label">表里有、代码里已删除（重新投影会清掉）</div>
                <div className="font-mono text-[11px] text-amber-600 break-all">{(stale.extra_in_table as string[]).join(', ')}</div>
              </div>
            )}
          </div>

          <div className="mt-4 pt-3 border-t border-slate-200 text-[11px] text-ink-500 leading-relaxed">
            <strong className="text-ink-600">为什么要有这页：</strong>
            口径进表的目的是让它能被 SQL 直查、能被 AI 读懂（否则 AI 会以为「销售额」就是
            SUM 全部订单）、能靠 updated_at 比对「哪天动过」。
            但写两份必然分家，所以定义与算法只写在代码里一处，表是投影，这页负责证明两者没分家。
          </div>
        </Card>
        {canSync && <OpsCountersCard />}
        </>
      )}

      <Modal
        open={!!detail}
        title={detail ? `${detail.name}（${detail.key}）` : ''}
        onClose={() => setDetail(null)}
        width={760}
      >
        {detail && (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className={CATEGORY_TONE[detail.category || ''] || 'tag bg-slate-100 text-slate-500'}>{detail.category || '未分类'}</span>
              <span className="tag bg-slate-100 text-slate-500">{detail.module}</span>
              {detail.unit && <span className="tag bg-slate-100 text-slate-500">单位：{detail.unit}</span>}
              <span className="ml-auto text-[13px]">
                <span className="text-ink-400 mr-2">当前值（近 {data?.days ?? days} 天）</span>
                <strong className="text-ink-900">{fmtMetricValue(detail.value, detail.unit)}</strong>
              </span>
            </div>

            <Field label="① 怎么算（口径）">
              <div className="font-mono text-[12px] break-all bg-slate-50 border border-slate-200 rounded-md p-3 text-ink-700">
                {detail.formula}
              </div>
            </Field>
            <Field label="② 不算什么（排除项）" hint="排除项比包含项更容易出错，所以必须写出来">
              <div className="text-[12.5px] text-red-600 leading-relaxed">{detail.exclusions || '—'}</div>
            </Field>
            <Field label="③ 取自哪些表">
              <div className="font-mono text-[12px] text-ink-700 break-all">{detail.source || '—'}</div>
            </Field>
            <Field label="④ 什么时候会踩坑 / 为什么这么定">
              <div className="text-[12.5px] text-ink-700 leading-relaxed">{detail.note || '—'}</div>
            </Field>

            {isMetricError(detail.value) && (
              <div className="text-[12px] text-amber-700 bg-amber-50 rounded px-3 py-2">
                这条现在算不出来：{(detail.value as any).error}
                <div className="text-[11px] mt-1 text-amber-600">
                  页面刻意把它显示成「算不出」而不是 0 —— 0 会被当成「真的是 0」，那是更坏的谎言。
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </div>
  )
}
