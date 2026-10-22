/**
 * ============================================================================
 * 文件标识：src/pages/purchase/Workbench.tsx ｜ 采购工作台
 * ============================================================================
 * 【职责】采购工作台（页面）
 * 【入口】/purchase/workbench
 * 【主要接口】/purchase/chain/overview、/purchase/chain/flow、/purchase/chain/todos
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
 * 页面：采购工作台
 */

import { useNavigate } from 'react-router-dom'
import api from '../../api/client'
import { Card, StatCard, Status, fmtInt, fmtMoney, toast, useFetch } from '../../components/ui'
import { RefreshCw, ArrowRight, Factory } from 'lucide-react'

/**
 * 采购工作台（模块 07）。
 *
 * 这一页解决的问题：采购不是「一张订单」，而是**九个环节的账**。
 * 以前只能从采购订单一个入口看，看不到「请购批了没 / 票认了没 / 钱付了没」。
 * 这里按业务流的九个节点横排，每个节点挂它自己的待办数，点进去就是那个环节的单据列表。
 *
 * 口径来源：`/purchase/chain/flow`（业务流定义）+ `/purchase/chain/overview`（各环节计数）
 * + `/purchase/chain/todos`（待办，已按权限过滤）。
 */

/** 业务流节点 → 前端落地页。没落到页面的节点（如纯过账）就不给跳转。 */
const STEP_LINK: Record<string, string> = {
  request: '/purchase/requisitions',
  req_approve: '/purchase/requisitions',
  order: '/purchase/orders',
  approve: '/purchase/orders',
  receipt: '/purchase/orders',
  inbound: '/purchase/orders',
  invoice: '/purchase/invoices',
  settle: '/purchase/settlements',
  pay: '/purchase/payments'
}

/** 待办类型 → 中文 + 落地页。
 *  ⚠️ kind 必须与后端 `purchaseTodos` 里推的字面量逐字一致（payment_pay 不是 pay_execute），
 *  否则界面会把原始 key 当成标题吐出来 —— 这类不一致不会报错，只会显示得很难看。 */
const TODO_META: Record<string, { label: string; path: string; tone: 'amber' | 'brand' | 'red' }> = {
  req_approve: { label: '请购单待审批', path: '/purchase/requisitions', tone: 'amber' },
  req_convert: { label: '请购单待转采购订单', path: '/purchase/requisitions', tone: 'brand' },
  po_approve: { label: '采购订单待审批', path: '/purchase/orders', tone: 'amber' },
  po_receive: { label: '采购订单待到货', path: '/purchase/orders', tone: 'brand' },
  invoice_verify: { label: '采购发票待校验', path: '/purchase/invoices', tone: 'amber' },
  settle_audit: { label: '采购结算待审核', path: '/purchase/settlements', tone: 'amber' },
  payment_pay: { label: '付款单待执行', path: '/purchase/payments', tone: 'red' }
}

export default function PurchaseWorkbench() {
  const nav = useNavigate()
  const { data: ov, reload: r1, loading } = useFetch<any>('/purchase/chain/overview')
  const { data: flow, reload: r2 } = useFetch<any>('/purchase/chain/flow')
  const { data: todos, reload: r3 } = useFetch<any>('/purchase/chain/todos')
  const refresh = () => {
    r1()
    r2()
    r3()
  }

  const steps: any[] = flow?.steps || []
  const list: any[] = todos?.list || []
  const req = ov?.requisition || {}
  const order = ov?.order || {}
  const inv = ov?.invoice || {}
  const st = ov?.settlement || {}
  const pay = ov?.payment || {}

  /** 每个业务流节点挂的待办数（按 kind 归并，界面上一眼看出堵在哪） */
  const pendingByStep: Record<string, number> = {}
  const kindByNode: Record<string, string[]> = {
    request: [],
    req_approve: ['req_approve'],
    order: ['req_convert'],
    approve: ['po_approve'],
    receipt: ['po_receive'],
    inbound: [],
    invoice: ['invoice_verify'],
    settle: ['settle_audit'],
    pay: ['payment_pay']
  }
  for (const t of list) {
    for (const [node, kinds] of Object.entries(kindByNode)) {
      if (kinds.includes(t.kind)) pendingByStep[node] = (pendingByStep[node] || 0) + 1
    }
  }

  const grouped: Record<string, any[]> = list.reduce((acc: Record<string, any[]>, t: any) => {
    ;(acc[t.kind] = acc[t.kind] || []).push(t)
    return acc
  }, {})

  return (
    <div>
      <div className="flex items-end justify-between mb-3 gap-3 flex-wrap">
        <div>
          <h1 className="title-serif text-[19px] font-medium text-ink-900">采购工作台</h1>
          <p className="text-[12px] text-ink-700 mt-0.5">
            请购 → 采购订单 → 到货 → 入库 → 发票 → 三单结算 → 付款核销：九个环节各自的账，一页看完
          </p>
        </div>
        <button className="btn-ghost btn-sm" onClick={refresh}>
          <RefreshCw size={13} /> 刷新
        </button>
      </div>

      {/* ---- 九环节业务流 ---- */}
      <Card className="mb-3">
        <div className="flex items-center gap-2 mb-3">
          <Factory size={15} className="text-brand-500" />
          <span className="text-[13px] font-medium text-ink-900">{flow?.flow?.name || '采购主流程'}</span>
          <span className="text-[12px] text-ink-700">{flow?.flow?.remark}</span>
        </div>
        <div className="flex items-stretch gap-1.5 overflow-x-auto pb-1">
          {steps.map((s: any, i: number) => {
            const link = STEP_LINK[s.node_type]
            const n = pendingByStep[s.node_type] || 0
            return (
              <div key={s.seq} className="flex items-center gap-1.5 shrink-0">
                <div
                  onClick={() => link && nav(link)}
                  className={`min-w-[104px] rounded-md border px-3 py-2 ${
                    link ? 'cursor-pointer hover:border-brand-400 hover:bg-brand-50/40' : ''
                  } ${n > 0 ? 'border-amber-300 bg-amber-50/50' : 'border-ink-300 bg-white'}`}
                >
                  <div className="text-[11px] text-ink-500">环节 {s.seq}</div>
                  <div className="text-[13px] text-ink-900 leading-tight mt-0.5">{s.node_name}</div>
                  <div className="text-[11px] mt-1">
                    {n > 0 ? (
                      <span className="text-amber-700">待办 {n}</span>
                    ) : (
                      <span className="text-ink-400">无待办</span>
                    )}
                  </div>
                </div>
                {i < steps.length - 1 && <ArrowRight size={14} className="text-ink-300 shrink-0" />}
              </div>
            )
          })}
          {steps.length === 0 && <span className="text-[12px] text-ink-400 py-3">{loading ? '加载中…' : '业务流未定义'}</span>}
        </div>
      </Card>

      {/* ---- 各环节 KPI ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 mb-3">
        <StatCard label="请购单" value={fmtInt(req.total)} sub={`待审批 ${fmtInt(req.submitted)} · 待转单 ${fmtInt(req.approved)}`} tone="amber" />
        <StatCard
          label="采购订单"
          value={fmtInt(order.total)}
          sub={`在途 ¥${fmtMoney(order.amount, 0)} · 待到货 ${fmtInt(order.pending_arrival)}`}
          tone="brand"
        />
        <StatCard label="采购发票" value={fmtInt(inv.total)} sub={`¥${fmtMoney(inv.amount, 0)} · 待认证 ${fmtInt(inv.submitted)}`} />
        <StatCard
          label="结算未付"
          value={`¥${fmtMoney(st.open, 0)}`}
          sub={`已结 ¥${fmtMoney(st.amount, 0)} · 暂估差异 ¥${fmtMoney(st.diff, 0)}`}
          tone="red"
        />
        <StatCard label="付款单" value={fmtInt(pay.total)} sub={`¥${fmtMoney(pay.amount, 0)} · 待审批 ${fmtInt(pay.draft)}`} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        {/* ---- 待办 ---- */}
        <Card className="lg:col-span-2" pad={false}>
          <div className="flex items-center justify-between px-3 h-11 border-b border-ink-200">
            <span className="text-[13px] font-medium text-ink-900">我的采购待办</span>
            <span className="text-[12px] text-ink-500">已按权限过滤 · {list.length} 条</span>
          </div>
          <div className="p-3 space-y-3 max-h-[460px] overflow-y-auto">
            {list.length === 0 && <div className="text-center py-10 text-ink-400 text-[13px]">没有待办，链路通畅</div>}
            {Object.entries(grouped).map(([kind, items]) => {
              const meta = TODO_META[kind] || { label: kind, path: '', tone: 'brand' as const }
              const sum = items.reduce((s, x: any) => s + Number(x.amount || 0), 0)
              return (
                <div key={kind}>
                  <div className="flex items-center justify-between mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] text-ink-900">{meta.label}</span>
                      <span className="tag bg-ink-100 text-ink-700">{items.length}</span>
                    </div>
                    <span className="text-[12px] text-ink-500">金额 ¥{fmtMoney(sum, 0)}</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {items.slice(0, 12).map((t: any) => (
                      <button
                        key={`${t.doc_type}-${t.doc_id}`}
                        className="text-[12px] px-2 py-1 rounded border border-ink-300 hover:border-brand-400 hover:bg-brand-50/40"
                        onClick={() => meta.path && nav(meta.path)}
                      >
                        {t.doc_no}
                      </button>
                    ))}
                    {items.length > 12 && <span className="text-[12px] text-ink-400 px-2 py-1">…另 {items.length - 12} 条</span>}
                  </div>
                </div>
              )
            })}
          </div>
        </Card>

        {/* ---- Top 供应商 ---- */}
        <Card pad={false}>
          <div className="flex items-center justify-between px-3 h-11 border-b border-ink-200">
            <span className="text-[13px] font-medium text-ink-900">采购额 Top 供应商</span>
            <button className="text-[12px] link" onClick={() => nav('/purchase/payables')}>
              应付台账
            </button>
          </div>
          <div className="p-3 space-y-2">
            {(ov?.top_suppliers || []).map((s: any, i: number) => (
              <div key={s.id} className="flex items-center justify-between text-[12px]">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`w-5 h-5 rounded text-center leading-5 text-[11px] ${i < 3 ? 'bg-brand-100 text-brand-700' : 'bg-ink-100 text-ink-600'}`}>
                    {i + 1}
                  </span>
                  <span className="truncate text-ink-900">{s.name}</span>
                </div>
                <span className="tabular-nums text-ink-700 shrink-0 ml-2">¥{fmtMoney(s.amount, 0)}</span>
              </div>
            ))}
            {!(ov?.top_suppliers || []).length && <div className="text-center py-8 text-ink-400 text-[13px]">暂无数据</div>}
          </div>
        </Card>
      </div>

      {/* ---- 各环节状态分布 ---- */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-3">
        <Card>
          <div className="text-[12px] text-ink-500 mb-2">请购单状态</div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['draft', req.draft],
              ['submitted', req.submitted],
              ['approved', req.approved],
              ['converted', req.converted],
              ['rejected', req.rejected]
            ].map(([k, v]) =>
              v ? (
                <span key={String(k)} className="text-[12px]">
                  <Status value={String(k)} /> <b className="text-ink-700">{v}</b>
                </span>
              ) : null
            )}
          </div>
        </Card>
        <Card>
          <div className="text-[12px] text-ink-500 mb-2">发票状态</div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['draft', inv.draft],
              ['submitted', inv.submitted],
              ['verified', inv.verified],
              ['posted', inv.posted]
            ].map(([k, v]) =>
              v ? (
                <span key={String(k)} className="text-[12px]">
                  <Status value={String(k)} /> <b className="text-ink-700">{v}</b>
                </span>
              ) : null
            )}
          </div>
        </Card>
        <Card>
          <div className="text-[12px] text-ink-500 mb-2">结算单状态</div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['draft', st.draft],
              ['audited', st.audited],
              ['settled', st.settled]
            ].map(([k, v]) =>
              v ? (
                <span key={String(k)} className="text-[12px]">
                  <Status value={String(k)} /> <b className="text-ink-700">{v}</b>
                </span>
              ) : null
            )}
          </div>
        </Card>
        <Card>
          <div className="text-[12px] text-ink-500 mb-2">付款单状态</div>
          <div className="flex flex-wrap gap-1.5">
            {[
              ['draft', pay.draft],
              ['approved', pay.approved],
              ['paid', pay.paid]
            ].map(([k, v]) =>
              v ? (
                <span key={String(k)} className="text-[12px]">
                  <Status value={String(k)} text={String(k) === 'paid' ? '已付款' : undefined} /> <b className="text-ink-700">{v}</b>
                </span>
              ) : null
            )}
          </div>
        </Card>
      </div>

      <p className="text-[12px] text-ink-500 mt-3">
        口径提示：付款单「已审批」即形成核销（用友口径）；草稿付款单上的核销只是计划，不计入已付。
        暂估差异 <b>单独一列</b>，不进任何合计。
      </p>
    </div>
  )
}
