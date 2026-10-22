/**
 * ============================================================================
 * 文件标识：src/pages/sales/Credit.tsx ｜ Credit（页面，未取到标题）
 * ============================================================================
 * 【职责】Credit（页面，未取到标题）（页面）
 * 【入口】/sales/credit
 * 【主要接口】/credit/overview、/credit/meta、/credit/checks
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
 * 页面：Credit（页面，未取到标题）
 */

import { useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs,
  fmtMoney, fmtNum, fmtInt, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import {
  CREDIT_META, CREDIT_ACCOUNT, CREDIT_UPDATE_ACCOUNT, CREDIT_SETTLE, CREDIT_ADJUST,
  CHECK_RESULT_CLS, ledgerAmountCls,
  type CreditAccount, type CreditLedgerRow, type CreditCheckRow
} from '../../api/quotes'
import { ShieldCheck, AlertTriangle, Snowflake, Wallet, ArrowDownRight } from 'lucide-react'

/**
 * 信用控制（模块 08A）。
 *
 * 三个页签对应三种用法：
 *   ① 总览：额度用了多少、谁在风险榜上、有没有账对不上的地方；
 *   ② 账户：逐户看额度 / 账期 / 已用 / 可用 / 逾期，并能维护额度与冻结；
 *   ③ 留痕：每一次「能不能下单」的判断都记着 —— 特别是超信被拦与被特批放行的那几次。
 *
 * 界面上必须钉死的一条：**已用额不是经销商档案上的那个缓存数**，
 * 它等于统一台账 + 订货中心同主体占用。所以账户行里把它拆成两列显示，
 * 让人看见「这家的额度是被线下订单占了，还是被线上订货占了」。
 */
export default function Credit() {
  const [tab, setTab] = useState<'overview' | 'accounts' | 'logs'>('overview')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)

  const { data: ov } = useFetch<any>('/credit/overview', undefined, [tick])
  const { data: meta } = useFetch<any>('/credit/meta', undefined, [])
  const audit = ov?.audit

  const [subjectType, setSubjectType] = useState('')
  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const { data: accData, loading } = useFetch<{ rows: CreditAccount[]; total: number }>(
    '/credit/accounts',
    { subject_type: subjectType || undefined, status: status || undefined, keyword: keyword || undefined, page: 1, pageSize: 50 },
    [tick, subjectType, status, keyword]
  )
  const accounts = accData?.rows || []

  const { data: logs } = useFetch<CreditCheckRow[]>('/credit/checks', { limit: 100 }, [tick])
  const checkRows = logs || []
  const resultLabel = (v: string) => (meta as any)?.check_results?.find((x: any) => x.value === v)?.label || v
  const changeLabel = (v: string) => (meta as any)?.change_types?.find((x: any) => x.value === v)?.label || v

  // ---- 账户详情 ----
  const [detail, setDetail] = useState<{ account: CreditAccount; ledger: CreditLedgerRow[]; checks: CreditCheckRow[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const openDetail = async (id: number) => {
    try {
      setDetail(await CREDIT_ACCOUNT(id))
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  const doUpdate = async (acc: CreditAccount, patch: any) => {
    setBusy(true)
    try {
      await CREDIT_UPDATE_ACCOUNT(acc.account_id, patch)
      toast('已保存')
      await openDetail(acc.account_id)
      reload()
    } catch (e: any) {
      toast(e.message || '保存失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <SectionTitle
        title="信用控制"
        desc="额度只有一个真相：已用 = 统一台账 + 订货中心同主体占用；超信默认拦住，特批放行必须填理由并留痕"
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="信用账户" value={fmtInt(ov?.account_count || 0)} icon={<Wallet size={16} />} />
        <StatCard label="授信总额度" value={fmtMoney(ov?.total_limit || 0)} />
        <StatCard label="已占用" value={fmtMoney(ov?.total_used || 0)} sub={`可用 ${fmtMoney(ov?.total_available || 0)}`} />
        <StatCard label="逾期户数" value={fmtInt(ov?.overdue_count || 0)} tone={(ov?.overdue_count || 0) > 0 ? 'bad' : 'default'} icon={<AlertTriangle size={16} />} />
        <StatCard label="冻结户数" value={fmtInt(ov?.frozen_count || 0)} tone={(ov?.frozen_count || 0) > 0 ? 'warn' : 'default'} icon={<Snowflake size={16} />} />
      </div>

      {audit && !audit.balanced && (
        <Card className="border-red-200 bg-red-50">
          <div className="text-red-700 text-[13px]">
            信用自洽异常：台账余额漂移 {audit.ledger_balance_drift?.length || 0} 笔、单据占用与台账差异 {audit.order_hold_diff?.length || 0} 条。
            这说明占用与释放没有成对发生，额度数字已经不可信，请先到「留痕」里定位最近一笔异常。
          </div>
        </Card>
      )}

      <Tabs
        tabs={[{ key: 'overview', label: '风险概览' }, { key: 'accounts', label: '信用账户' }, { key: 'logs', label: '校验与放行留痕' }]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'overview' && (
        <Card pad={false}>
          <div className="p-3 text-[13px] text-slate-500">
            风险榜：超额占用、使用率 ≥ 90%、存在逾期、被冻结的账户会进榜
          </div>
          <Table
            data={ov?.risk || []}
            empty="没有风险账户"
            onRowClick={(r) => openDetail(r.account_id)}
            columns={[
              { key: 'name', title: '客户', render: (r: any) => r.name || `${r.subject_type}#${r.subject_id}` },
              { key: 'limit', title: '额度', align: 'right', width: 120, render: (r: any) => fmtMoney(r.limit) },
              {
                key: 'used',
                title: '已用（台账 / 订货中心）',
                align: 'right',
                width: 200,
                render: (r: any) => (
                  <span>
                    {fmtMoney(r.used)}
                    <span className="text-[12px] text-slate-400 ml-1">
                      （{fmtMoney(r.own_used)} / {fmtMoney(r.oc_used)}）
                    </span>
                  </span>
                )
              },
              {
                key: 'available',
                title: '可用',
                align: 'right',
                width: 120,
                render: (r: any) => <span className={r.available < 0 ? 'text-red-600' : ''}>{fmtMoney(r.available)}</span>
              },
              {
                key: 'usage_rate',
                title: '使用率',
                align: 'right',
                width: 110,
                render: (r: any) => `${fmtNum(r.usage_rate * 100)}%`
              },
              {
                key: 'overdue',
                title: '逾期',
                width: 130,
                render: (r: any) =>
                  r.overdue_days > 0 ? (
                    <span className="text-red-600">{r.overdue_days} 天 / {fmtMoney(r.overdue_amount)}</span>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )
              },
              {
                key: 'reasons',
                title: '风险原因',
                render: (r: any) => <span className="text-[12px] text-orange-700">{r.reasons?.join('；')}</span>
              }
            ]}
          />
          <div className="p-3">
            <div className="text-[13px] text-slate-500 mb-2">最近的拦截与特批放行</div>
            <Table
              data={(ov?.exceptions || []).slice(0, 10)}
              empty="还没有超信记录"
              columns={[
                { key: 'account_name', title: '客户', width: 160, render: (r: CreditCheckRow) => r.account_name || '-' },
                { key: 'doc_no', title: '单据', width: 150, render: (r: CreditCheckRow) => r.doc_no || '-' },
                { key: 'amount', title: '金额', align: 'right', width: 110, render: (r: CreditCheckRow) => fmtMoney(r.amount) },
                { key: 'over_amount', title: '超出', align: 'right', width: 110, render: (r: CreditCheckRow) => fmtMoney(r.over_amount) },
                {
                  key: 'result',
                  title: '结论',
                  width: 100,
                  align: 'center',
                  render: (r: CreditCheckRow) => (
                    <span className={`px-2 py-0.5 rounded text-[12px] ${CHECK_RESULT_CLS[r.result] || 'bg-slate-100'}`}>
                      {resultLabel(r.result)}
                    </span>
                  )
                },
                { key: 'reason', title: '说明', render: (r: CreditCheckRow) => <span className="text-[12px]">{r.reason || '-'}</span> },
                { key: 'operator', title: '操作人', width: 100, render: (r: CreditCheckRow) => r.operator || '-' }
              ]}
            />
          </div>
        </Card>
      )}

      {tab === 'accounts' && (
        <Card pad={false}>
          <div className="p-3">
            <FilterBar onReset={() => { setSubjectType(''); setStatus(''); setKeyword('') }}>
              <Sel w={140} value={subjectType} onChange={setSubjectType} options={(meta as any)?.subject_types || []} placeholder="全部主体" />
              <Sel w={120} value={status} onChange={setStatus} options={(meta as any)?.account_status || []} placeholder="全部状态" />
              <Inp w={180} value={keyword} onChange={setKeyword} placeholder="名称 / 编码" />
            </FilterBar>
          </div>
          <Table
            loading={loading}
            data={accounts}
            empty="还没有信用账户"
            onRowClick={(r) => openDetail(r.account_id)}
            columns={[
              { key: 'name', title: '客户', render: (r: CreditAccount) => r.name || `${r.subject_type}#${r.subject_id}` },
              { key: 'code', title: '编码', width: 110, render: (r: CreditAccount) => r.code || '-' },
              { key: 'credit_limit', title: '额度', align: 'right', width: 110, render: (r: CreditAccount) => fmtMoney(r.credit_limit) },
              {
                key: 'temp_limit',
                title: '临时额度',
                align: 'right',
                width: 130,
                render: (r: CreditAccount) =>
                  r.temp_limit > 0 ? (
                    <span title={r.temp_expire_at || ''}>{fmtMoney(r.temp_limit)}（至 {r.temp_expire_at || '-'}）</span>
                  ) : (
                    <span className="text-slate-400">-</span>
                  )
              },
              { key: 'credit_days', title: '账期', align: 'right', width: 80, render: (r: CreditAccount) => `${r.credit_days} 天` },
              {
                key: 'used',
                title: '已用（台账 / 订货）',
                align: 'right',
                width: 190,
                render: (r: CreditAccount) => (
                  <span>
                    {fmtMoney(r.used)}
                    <span className="text-[12px] text-slate-400 ml-1">（{fmtMoney(r.own_used)} / {fmtMoney(r.oc_used)}）</span>
                  </span>
                )
              },
              {
                key: 'available',
                title: '可用',
                align: 'right',
                width: 120,
                render: (r: CreditAccount) => <span className={r.available < 0 ? 'text-red-600' : ''}>{fmtMoney(r.available)}</span>
              },
              {
                key: 'usage',
                title: '使用率',
                align: 'right',
                width: 120,
                render: (r: CreditAccount) => (
                  <div className="flex items-center justify-end gap-2">
                    <div className="w-16 h-1.5 bg-slate-100 rounded">
                      <div
                        className={`h-1.5 rounded ${r.usage_rate >= 0.9 ? 'bg-red-500' : r.usage_rate >= 0.7 ? 'bg-amber-500' : 'bg-green-500'}`}
                        style={{ width: `${Math.min(100, r.usage_rate * 100)}%` }}
                      />
                    </div>
                    <span className="tabular-nums text-[12px]">{fmtNum(r.usage_rate * 100, 0)}%</span>
                  </div>
                )
              },
              {
                key: 'status',
                title: '状态',
                width: 90,
                align: 'center',
                render: (r: CreditAccount) =>
                  r.status === 'frozen' ? (
                    <span className="px-2 py-0.5 rounded text-[12px] bg-slate-200 text-slate-700" title={r.frozen_reason || ''}>已冻结</span>
                  ) : (
                    <span className="px-2 py-0.5 rounded text-[12px] bg-green-100 text-green-700">正常</span>
                  )
              }
            ]}
          />
        </Card>
      )}

      {tab === 'logs' && (
        <Card pad={false}>
          <div className="p-3 text-[13px] text-slate-500">
            每一次「能不能下单」的判断都在这里。拦截是常态，特批放行必须写清理由与操作人 —— 事后要能追责。
          </div>
          <Table
            data={checkRows}
            empty="还没有校验记录"
            columns={[
              { key: 'account_name', title: '客户', width: 160, render: (r: CreditCheckRow) => r.account_name || '-' },
              { key: 'scene', title: '场景', width: 140, render: (r: CreditCheckRow) => r.scene },
              { key: 'doc_no', title: '单据', width: 150, render: (r: CreditCheckRow) => r.doc_no || '-' },
              { key: 'amount', title: '本单金额', align: 'right', width: 110, render: (r: CreditCheckRow) => fmtMoney(r.amount) },
              { key: 'available', title: '当时可用', align: 'right', width: 110, render: (r: CreditCheckRow) => fmtMoney(r.available) },
              { key: 'over_amount', title: '超出', align: 'right', width: 100, render: (r: CreditCheckRow) => fmtMoney(r.over_amount) },
              {
                key: 'result',
                title: '结论',
                width: 100,
                align: 'center',
                render: (r: CreditCheckRow) => (
                  <span className={`px-2 py-0.5 rounded text-[12px] ${CHECK_RESULT_CLS[r.result] || 'bg-slate-100'}`}>
                    {resultLabel(r.result)}
                  </span>
                )
              },
              { key: 'reason', title: '说明', render: (r: CreditCheckRow) => <span className="text-[12px]">{r.reason || '-'}</span> },
              { key: 'operator', title: '操作人', width: 100, render: (r: CreditCheckRow) => r.operator || '-' },
              { key: 'created_at', title: '时间', width: 160, render: (r: CreditCheckRow) => r.created_at }
            ]}
          />
        </Card>
      )}

      {detail && (
        <Modal
          open
          width={960}
          title={
            <div className="flex items-center gap-2">
              <span>{detail.account.name || `${detail.account.subject_type}#${detail.account.subject_id}`}</span>
              <span className="text-[12px] text-slate-500">
                额度 {fmtMoney(detail.account.limit)} · 已用 {fmtMoney(detail.account.used)} · 可用 {fmtMoney(detail.account.available)}
              </span>
            </div>
          }
          onClose={() => setDetail(null)}
          footer={
            <div className="flex gap-2 justify-end">
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  const v = prompt('调整信用额度（元）', String(detail.account.credit_limit))
                  if (v == null) return
                  const n = Number(v)
                  if (!Number.isFinite(n) || n < 0) return toast('额度必须是非负数字', 'error')
                  doUpdate(detail.account, { credit_limit: n })
                }}
              >
                调整额度
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  const v = prompt('账期天数（0 = 现结）', String(detail.account.credit_days))
                  if (v == null) return
                  const n = Number(v)
                  if (!Number.isFinite(n) || n < 0) return toast('账期必须是非负整数', 'error')
                  doUpdate(detail.account, { credit_days: Math.round(n) })
                }}
              >
                调整账期
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={() => {
                  const v = prompt('临时额度（元，0 表示取消）', String(detail.account.temp_limit || 0))
                  if (v == null) return
                  const n = Number(v)
                  if (!Number.isFinite(n) || n < 0) return toast('临时额度必须是非负数字', 'error')
                  const exp = n > 0 ? prompt('临时额度到期日（YYYY-MM-DD）', '') : null
                  doUpdate(detail.account, { temp_limit: n, temp_expire_at: n > 0 ? exp : null })
                }}
              >
                临时额度
              </button>
              <button
                className={`btn-sm ${detail.account.status === 'frozen' ? 'btn-primary' : 'btn-ghost'}`}
                disabled={busy}
                onClick={() => {
                  if (detail.account.status === 'frozen') {
                    doUpdate(detail.account, { status: 'active', frozen_reason: null })
                  } else {
                    const why = prompt('冻结原因（必填）')
                    if (!why) return toast('冻结必须填写原因', 'error')
                    doUpdate(detail.account, { status: 'frozen', frozen_reason: why })
                  }
                }}
              >
                {detail.account.status === 'frozen' ? '解除冻结' : '冻结授信'}
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  const v = prompt('回款核销金额（元）：只有钱到了才释放额度')
                  if (!v) return
                  const srcId = Number(prompt('对应的销售订单 id（可留空表示整户核销）', '') || 0)
                  try {
                    await CREDIT_SETTLE({
                      account_id: detail.account.account_id,
                      amount: Number(v),
                      source_id: srcId || null,
                      remark: '界面回款核销'
                    })
                    toast('已核销并释放占用')
                    await openDetail(detail.account.account_id)
                    reload()
                  } catch (e: any) {
                    toast(e.message || '核销失败', 'error')
                  }
                }}
              >
                <ArrowDownRight size={13} /> 回款核销
              </button>
              <button
                className="btn-ghost btn-sm"
                disabled={busy}
                onClick={async () => {
                  const v = prompt('人工调整占用金额（正=加占用，负=减占用）')
                  if (!v) return
                  const why = prompt('调整原因（必填）')
                  if (!why) return toast('人工调整必须填写原因', 'error')
                  try {
                    await CREDIT_ADJUST({ account_id: detail.account.account_id, amount: Number(v), remark: why })
                    toast('已调整')
                    await openDetail(detail.account.account_id)
                    reload()
                  } catch (e: any) {
                    toast(e.message || '调整失败', 'error')
                  }
                }}
              >
                人工调整
              </button>
            </div>
          }
        >
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[13px] mb-3">
            <div><span className="text-slate-500">固定额度：</span>{fmtMoney(detail.account.credit_limit)}</div>
            <div><span className="text-slate-500">临时额度：</span>{fmtMoney(detail.account.temp_limit)}{detail.account.temp_expire_at ? `（至 ${detail.account.temp_expire_at}）` : ''}</div>
            <div><span className="text-slate-500">账期：</span>{detail.account.credit_days} 天</div>
            <div><span className="text-slate-500">结算方式：</span>{detail.account.settle_type || '-'}</div>
            <div><span className="text-slate-500">统一台账占用：</span>{fmtMoney(detail.account.own_used)}</div>
            <div><span className="text-slate-500">订货中心占用：</span>{fmtMoney(detail.account.oc_used)}</div>
            <div><span className="text-slate-500">逾期：</span>
              {detail.account.overdue_days > 0
                ? <span className="text-red-600">{detail.account.overdue_days} 天 / {fmtMoney(detail.account.overdue_amount)}</span>
                : '无'}
            </div>
            <div><span className="text-slate-500">状态：</span>{detail.account.status === 'frozen' ? `已冻结（${detail.account.frozen_reason || ''}）` : '正常'}</div>
          </div>

          <div className="text-[13px] text-slate-500 mb-1">信用台账（占用为正、释放与核销为负）</div>
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th style={{ width: 150 }}>时间</th>
                  <th style={{ width: 100 }}>类型</th>
                  <th style={{ width: 160 }}>来源单据</th>
                  <th style={{ width: 110 }}>金额</th>
                  <th style={{ width: 110 }}>占用后余额</th>
                  <th style={{ width: 110 }}>应收到期</th>
                  <th>说明</th>
                  <th style={{ width: 90 }}>操作人</th>
                </tr>
              </thead>
              <tbody>
                {detail.ledger.length === 0 ? (
                  <tr><td colSpan={8} className="text-center py-6 text-slate-400">还没有台账记录</td></tr>
                ) : (
                  detail.ledger.map((l) => (
                    <tr key={l.id}>
                      <td>{l.created_at}</td>
                      <td>{changeLabel(l.change_type)}</td>
                      <td>
                        {l.doc_no || '-'}
                        <span className="text-[12px] text-slate-400 ml-1">{l.source_type}</span>
                      </td>
                      <td className={`tabular-nums ${ledgerAmountCls(l.amount)}`}>{l.amount > 0 ? '+' : ''}{fmtMoney(l.amount)}</td>
                      <td className="tabular-nums">{fmtMoney(l.balance_after)}</td>
                      <td>{l.due_date || '-'}</td>
                      <td className="text-[12px]">{l.remark || '-'}</td>
                      <td>{l.operator || '-'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </Modal>
      )}
    </div>
  )
}
