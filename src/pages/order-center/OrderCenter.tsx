/**
 * ============================================================================
 * 文件标识：src/pages/order-center/OrderCenter.tsx ｜ OrderCenter（页面，未取到标题）
 * ============================================================================
 * 【职责】OrderCenter（页面，未取到标题）（页面）
 * 【入口】/order-center
 * 【主要接口】/order-center/overview、/order-center/orders、/order-center/statements、/order-center/flow、/order-center/policies
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
 * 页面：OrderCenter（页面，未取到标题）
 */

import { useEffect, useMemo, useState } from 'react'
import api from '../../api/client'
import {
  Card, Empty, Modal, Pagination, SectionTitle, StatCard, Status, Table, Tabs,
  fmtInt, fmtMoney, fmtNum, toast, useFetch, useList
} from '../../components/ui'
import {
  AlertTriangle, ArrowRight, CheckCircle2, ClipboardCheck, CreditCard, FileText,
  Layers, RefreshCw, Send, ShoppingBag, Truck, Users2, Warehouse, XCircle
} from 'lucide-react'

/**
 * 订货中心（模块 12A）：门店要货与经销商订货的统一入口。
 *
 * 页面组织按「谁的视角」分，而不是按表分：
 *   总览      —— 供货方看整体（待办、授信风险、业务流）
 *   订货单    —— 双方都看（订货方看自己的，供货方看全部），一张单走完整个生命周期
 *   订货方    —— 供货方管客户准入与交易条件
 *   对账      —— 双方都看，B2B 的主功能而非附属
 * 下单入口只有一个「新建订货单」，内部按客户类型自动切换取价维度、审批规则与分仓候选。
 */

const OC_STATUS_TABS = [
  { key: '', label: '全部' },
  { key: 'submitted', label: '待审批' },
  { key: 'approving', label: '审批中' },
  { key: 'approved', label: '已审核' },
  { key: 'allocated', label: '已分仓' },
  { key: 'shipped', label: '已发货' },
  { key: 'received', label: '已收货' },
  { key: 'completed', label: '已完成' },
  { key: 'cancelled', label: '已取消' }
]

/**
 * 订货单动作 → **一次调用**（覆盖 `doc_actions` 里 `doc_type='OC'` 的全部 9 个动作，**不拼 `/${action}`**）。
 *
 * 为什么写成函数表而不是"路径字符串表 + `api.post(path)`"：契约检查是按
 * "写在调用处的字面量路径"扫源码的，路径先进变量就从它眼里消失了（实测掉 5 条）。
 * 另一处同族的真事故：订货**对账单**的 `close`/`void` 后端没有路由、前端却能点到 ⇒ 必然 404。
 */
const OC_ORDER_ACTIONS: Record<string, (id: any) => Promise<any>> = {
  submit: (id) => api.post(`/order-center/orders/${id}/submit`, {}),
  review: (id) => api.post(`/order-center/orders/${id}/review`, {}),
  approve: (id) => api.post(`/order-center/orders/${id}/approve`, {}),
  reject: (id) => api.post(`/order-center/orders/${id}/reject`, {}),
  allocate: (id) => api.post(`/order-center/orders/${id}/allocate`, {}),
  ship: (id) => api.post(`/order-center/orders/${id}/ship`, {}),
  receive: (id) => api.post(`/order-center/orders/${id}/receive`, {}),
  complete: (id) => api.post(`/order-center/orders/${id}/complete`, {}),
  cancel: (id) => api.post(`/order-center/orders/${id}/cancel`, {})
}

const ACTION_META: Record<string, { label: string; icon: any; cls: string }> = {
  submit: { label: '提交订货', icon: Send, cls: 'btn-primary btn-sm' },
  review: { label: '进入审批', icon: ClipboardCheck, cls: 'btn-primary btn-sm' },
  approve: { label: '审核通过', icon: CheckCircle2, cls: 'btn-primary btn-sm' },
  reject: { label: '驳回', icon: XCircle, cls: 'btn-ghost btn-sm' },
  allocate: { label: '智能分仓', icon: Warehouse, cls: 'btn-ghost btn-sm' },
  ship: { label: '发货出库', icon: Truck, cls: 'btn-primary btn-sm' },
  receive: { label: '确认收货', icon: ClipboardCheck, cls: 'btn-ghost btn-sm' },
  complete: { label: '完成', icon: CheckCircle2, cls: 'btn-ghost btn-sm' },
  cancel: { label: '取消', icon: XCircle, cls: 'btn-ghost btn-sm' },
  confirm: { label: '确认对账', icon: ClipboardCheck, cls: 'btn-primary btn-sm' },
  close: { label: '结清', icon: CheckCircle2, cls: 'btn-ghost btn-sm' },
  void: { label: '作废', icon: XCircle, cls: 'btn-ghost btn-sm' }
}

/**
 * 对账单动作 → **一次调用**（与上面的 `OC_ORDER_ACTIONS` 同族：路径写死在调用处）。
 *
 * 为什么不用 `act(path, ...)` 拼接动作段：契约检查按"写在调用处的**字面量**路径"扫源码，
 * 动作名一旦进了变量/模板段，就从它眼里消失了 —— 本轮真实踩到：原先的
 * `api.post(\`/order-center/statements/${id}/${path}\`)` 被契约检查直接报
 * "前端调用未登记在 OpenAPI（动态段）"，而那时契约里写的是笼统的 `{id}/{action}`。
 * 两边都含糊 ⇒ 后端真缺 `close`/`void` 两条路由时**谁也没发现**（前端按钮却渲染着）。
 */
const STATEMENT_ACTIONS: Record<string, (id: any, body?: any) => Promise<any>> = {
  confirm: (id) => api.post(`/order-center/statements/${id}/confirm`, {}),
  settle: (id, body) => api.post(`/order-center/statements/${id}/settle`, body),
  close: (id, body) => api.post(`/order-center/statements/${id}/close`, body || {}),
  void: (id, body) => api.post(`/order-center/statements/${id}/void`, body)
}

const CHANNEL_LABEL: Record<string, string> = {
  direct: '直营门店',
  franchise: '加盟门店',
  dealer: '经销商',
  sub_dealer: '下游终端'
}
const SETTLE_LABEL: Record<string, string> = {
  credit: '账期',
  prepay: '现结',
  internal: '内部往来'
}
const ADMIT_LABEL: Record<string, string> = {
  active: '已准入',
  pending: '待审核',
  frozen: '已冻结'
}

export default function OrderCenter() {
  const [tab, setTab] = useState('overview')

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-[18px] font-semibold text-slate-800 flex items-center gap-2">
          <ShoppingBag size={19} className="text-brand-600" />
          订货中心
        </h1>
        <p className="text-[12.5px] text-slate-400 mt-1">
          门店要货与经销商订货的统一入口 —— 按客户取价 · 下单前校验授信与可售 · 条件审批 · 智能分仓 · 在线对账
        </p>
      </div>

      <Tabs
        tabs={[
          { key: 'overview', label: '总览' },
          { key: 'orders', label: '订货单' },
          { key: 'customers', label: '订货方' },
          { key: 'statements', label: '对账' },
          { key: 'flow', label: '业务流与规则' }
        ]}
        value={tab}
        onChange={setTab}
      />

      <div className="mt-4">
        {tab === 'overview' && <Overview onJump={setTab} />}
        {tab === 'orders' && <Orders />}
        {tab === 'customers' && <Customers />}
        {tab === 'statements' && <Statements />}
        {tab === 'flow' && <FlowPanel />}
      </div>
    </div>
  )
}

// =====================================================================
// 总览
// =====================================================================
function Overview({ onJump }: { onJump: (k: string) => void }) {
  const { data, loading, reload } = useFetch<any>('/order-center/overview')
  const t = data?.totals || {}
  const c = data?.customers || {}

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="订货单总数" value={fmtInt(t.orders)} sub={`金额 ¥${fmtMoney(t.amount, 0)}`} tone="brand" icon={<ShoppingBag size={16} />} />
        <StatCard label="订货客户" value={fmtInt(c.total)} sub={`已准入 ${c.active || 0} · 待审核 ${c.pending || 0} · 冻结 ${c.frozen || 0}`} icon={<Users2 size={16} />} />
        <StatCard label="待审批单据" value={fmtInt((data?.pendingApproval || []).length)} sub="按规则触发的审批链" tone="amber" icon={<ClipboardCheck size={16} />} />
        <StatCard label="授信预警客户" value={fmtInt((data?.creditRisk || []).filter((r: any) => r.utilization >= 0.8).length)} sub="使用率 ≥ 80%" tone="red" icon={<AlertTriangle size={16} />} />
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="状态分布" desc="一张单的一生：" right={<button className="btn-ghost btn-sm" onClick={reload}><RefreshCw size={13} /></button>} />
          {(t.byStatus || []).length === 0 ? (
            <Empty text="暂无订货单" />
          ) : (
            <div className="space-y-2">
              {t.byStatus.map((r: any) => (
                <div key={r.status} className="flex items-center gap-3">
                  <div className="w-24 shrink-0"><Status value={r.status} /></div>
                  <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                    <div className="h-full bg-brand-500" style={{ width: `${Math.min(100, (r.c / Math.max(1, t.byStatus[0]?.c || 1)) * 100)}%` }} />
                  </div>
                  <span className="w-8 text-right text-[13px] tabular-nums text-slate-600">{r.c}</span>
                  <span className="w-24 text-right text-[12px] tabular-nums text-slate-400">¥{fmtMoney(r.amt, 0)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card>
          <SectionTitle
            title="待审批（按规则触发）"
            desc="金额分级 · 超授信特批 · 缺货交期确认"
            right={<button className="btn-ghost btn-sm" onClick={() => onJump('orders')}>查看订货单 <ArrowRight size={13} /></button>}
          />
          {(data?.pendingApproval || []).length === 0 ? (
            <Empty text="没有待审批单据" />
          ) : (
            <div className="space-y-2">
              {data.pendingApproval.slice(0, 6).map((o: any) => (
                <div key={o.id} className="flex items-center justify-between border-b border-slate-100 last:border-0 pb-2 last:pb-0">
                  <div className="min-w-0">
                    <div className="text-[13px] text-slate-700 truncate">{o.doc_no} · {o.customer_name}</div>
                    <div className="text-[12px] text-slate-400 truncate">{o.approval_reason || '—'}</div>
                  </div>
                  <div className="text-[13px] tabular-nums text-slate-700 shrink-0 ml-3">¥{fmtMoney(o.total_amount, 0)}</div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      <Card>
        <SectionTitle title="授信使用率排行" desc="额度 = 未回款金额的上限；占用与台账逐笔可查" />
        {(data?.creditRisk || []).length === 0 ? (
          <Empty text="暂无账期客户" />
        ) : (
          <Table
            columns={[
              { key: 'name', title: '客户' },
              { key: 'level', title: '等级', width: 90 },
              { key: 'limit_amount', title: '授信额度', align: 'right', render: (r) => `¥${fmtMoney(r.limit_amount, 0)}` },
              { key: 'used', title: '已占用', align: 'right', render: (r) => `¥${fmtMoney(r.used, 0)}` },
              {
                key: 'utilization',
                title: '使用率',
                width: 180,
                render: (r) => {
                  const pct = Math.min(100, r.utilization * 100)
                  const danger = r.utilization >= 0.9
                  const warn = r.utilization >= 0.7
                  return (
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                        <div
                          className={`h-full ${danger ? 'bg-red-500' : warn ? 'bg-amber-500' : 'bg-brand-500'}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-12 text-right text-[12px] tabular-nums text-slate-500">{pct.toFixed(1)}%</span>
                    </div>
                  )
                }
              }
            ]}
            data={data?.creditRisk || []}
            loading={loading}
            empty="暂无数据"
          />
        )}
      </Card>
    </div>
  )
}

// =====================================================================
// 订货单
// =====================================================================
function Orders() {
  const [tab, setTab] = useState('')
  const { list, total, loading, page, pageSize, setPage, setFilters, reload } = useList('/order-center/orders', {})
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [creating, setCreating] = useState(false)

  useEffect(() => {
    setFilters(tab ? { status: tab } : {})
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab])

  const open = async (row: any) => {
    try {
      const r = await api.get(`/order-center/orders/${row.id}`)
      setDetail(r.data)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const doAction = async (action: string) => {
    if (!detail) return
    const meta = ACTION_META[action]
    if (['cancel', 'reject'].includes(action) && !confirm(`确认${meta?.label || action} ${detail.doc_no}？`)) return
    setBusy(true)
    try {
      const call = OC_ORDER_ACTIONS[action]
      if (!call) {
        toast(`未知动作 ${action}`, 'error')
        return
      }
      const r = await call(detail.id)
      setDetail(r.data.order)
      const p = r.data.transition
      toast(p?.partial ? `节点「${p.doneNode}」已通过，下一节点「${p.nextNode}」` : `${meta?.label || action}成功`)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Card className="mb-3" pad={false}>
        <div className="p-2 flex items-center gap-1.5 overflow-x-auto">
          {OC_STATUS_TABS.map((s) => (
            <button
              key={s.key || 'all'}
              className={`px-3 py-1.5 rounded-md text-[13px] whitespace-nowrap ${
                tab === s.key ? 'bg-brand-600 text-white' : 'text-slate-600 hover:bg-slate-100'
              }`}
              onClick={() => setTab(s.key)}
            >
              {s.label}
            </button>
          ))}
          <div className="flex-1" />
          <button className="btn-primary btn-sm shrink-0" onClick={() => setCreating(true)}>
            <ShoppingBag size={14} /> 新建订货单
          </button>
        </div>
      </Card>

      <Card pad={false}>
        <Table
          loading={loading}
          data={list}
          onRowClick={open}
          columns={[
            { key: 'doc_no', title: '单号', width: 160 },
            {
              key: 'customer_name',
              title: '订货方',
              render: (r) => (
                <div>
                  <div className="text-slate-700">{r.customer_name}</div>
                  <div className="text-[11.5px] text-slate-400">{CHANNEL_LABEL[r.channel] || r.channel || '—'} · {r.customer_type}</div>
                </div>
              )
            },
            { key: 'order_date', title: '订货日', width: 110 },
            { key: 'line_count', title: '行数', width: 60, align: 'center' },
            { key: 'total_amount', title: '金额', align: 'right', width: 110, render: (r) => `¥${fmtMoney(r.total_amount, 2)}` },
            {
              key: 'need_approval',
              title: '审批',
              width: 150,
              render: (r) =>
                r.need_approval ? (
                  <span className="text-[12px] text-amber-600">{r.approval_reason || '需审批'}{r.pending_nodes ? `（剩 ${r.pending_nodes} 级）` : ''}</span>
                ) : (
                  <span className="text-[12px] text-slate-400">免审批</span>
                )
            },
            { key: 'ship_warehouse', title: '发货仓', width: 150, render: (r) => r.ship_warehouse || '—' },
            { key: 'status', title: '状态', width: 100, render: (r) => <Status value={r.status} /> }
          ]}
        />
        <div className="px-3">
          <Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} />
        </div>
      </Card>

      {/* 单据详情 */}
      <Modal open={!!detail} title={detail ? `${detail.doc_no}｜${detail.customer_name}` : ''} onClose={() => setDetail(null)} width={960}>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Info label="状态" value={<Status value={detail.status} />} />
              <Info label="订货日 / 期望到货" value={`${detail.order_date} → ${detail.expect_date || '—'}`} />
              <Info label="金额 / 数量" value={`¥${fmtMoney(detail.total_amount, 2)} / ${fmtNum(detail.total_qty, 0)}`} />
              <Info label="发货仓" value={detail.ship_warehouse || '待分仓'} />
              <Info label="渠道 / 结算" value={`${CHANNEL_LABEL[detail.channel] || detail.channel} · ${SETTLE_LABEL[detail.settle_type] || detail.customer_type}`} />
              <Info label="授信占用" value={detail.credit_hold > 0 ? `¥${fmtMoney(detail.credit_hold, 2)}` : '未占用'} />
              <Info label="分仓说明" value={detail.allocate_note || '—'} />
              <Info label="来源" value={detail.source} />
            </div>

            {detail.need_approval === 1 && (
              <div>
                <SectionTitle title="审批链" desc={detail.approval_reason || ''} />
                <div className="space-y-1.5">
                  {(detail.approvals || []).map((a: any) => (
                    <div key={a.id} className="flex items-center gap-2 text-[13px]">
                      <span className="w-6 text-slate-400">{a.seq}.</span>
                      <span className="text-slate-700">{a.node}</span>
                      <span className="text-[12px] text-slate-400">({a.approver_role})</span>
                      <div className="flex-1" />
                      {a.decision === 'approved' && <span className="text-green-600 text-[12px]">已通过 {a.approver_name || ''}</span>}
                      {a.decision === 'pending' && <span className="text-amber-600 text-[12px]">待处理</span>}
                      {a.decision === 'rejected' && <span className="text-red-600 text-[12px]">已驳回 {a.reason || ''}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div>
              <SectionTitle title="订货明细" desc="价格来源与下单时可售量一并留痕" />
              <Table
                data={detail.items || []}
                columns={[
                  { key: 'line_no', title: '#', width: 40, align: 'center' },
                  { key: 'sku_code', title: '编码', width: 110 },
                  { key: 'sku_name', title: '商品' },
                  { key: 'qty', title: '数量', align: 'right', width: 80, render: (r) => fmtNum(r.qty, 0) },
                  { key: 'price', title: '单价', align: 'right', width: 90, render: (r) => `¥${fmtMoney(r.price, 2)}` },
                  { key: 'amount', title: '金额', align: 'right', width: 110, render: (r) => `¥${fmtMoney(r.amount, 2)}` },
                  {
                    key: 'price_source',
                    title: '取价来源',
                    width: 150,
                    render: (r) => (
                      <span className="text-[12px] text-slate-500">
                        {r.price_source === 'price_group' ? `价格组：${r.price_group || ''}` : r.price_source}
                      </span>
                    )
                  },
                  {
                    key: 'available_qty',
                    title: '可售',
                    align: 'right',
                    width: 80,
                    render: (r) => (
                      <span className={Number(r.available_qty) < Number(r.qty) ? 'text-amber-600' : 'text-slate-500'}>
                        {fmtNum(r.available_qty, 0)}
                      </span>
                    )
                  }
                ]}
              />
            </div>

            <div>
              <SectionTitle title="单据一生（流转留痕）" desc="谁、何时、把这张单从什么状态推到什么状态" />
              <div className="space-y-1 text-[12.5px]">
                {(detail.events || []).map((e: any) => (
                  <div key={e.id} className="flex items-center gap-2 text-slate-500">
                    <span className="tabular-nums w-32 shrink-0">{e.created_at}</span>
                    <span className="text-slate-700 w-24 shrink-0">{e.action_name || e.action}</span>
                    <span className="text-slate-400">
                      {e.from_state || '∅'} → {e.to_state}
                    </span>
                    <span className="text-slate-400">{e.actor_name || e.source}</span>
                    {e.remark && <span className="text-slate-400 truncate">· {e.remark}</span>}
                  </div>
                ))}
              </div>
            </div>

            <div className="flex flex-wrap gap-2 pt-1 border-t border-slate-100">
              {(detail.actions || []).map((a: any) => {
                const meta = ACTION_META[a.action] || { label: a.name, icon: ArrowRight, cls: 'btn-ghost btn-sm' }
                const Icon = meta.icon
                return (
                  <button key={a.action} className={meta.cls} disabled={busy} onClick={() => doAction(a.action)}>
                    <Icon size={14} /> {meta.label}
                  </button>
                )
              })}
              {(detail.actions || []).length === 0 && <span className="text-[12.5px] text-slate-400">该状态已无可执行动作</span>}
            </div>
          </div>
        )}
      </Modal>

      <CreateOrderModal open={creating} onClose={() => setCreating(false)} onDone={() => { setCreating(false); reload() }} />
    </div>
  )
}

function Info({ label, value }: { label: string; value: any }) {
  return (
    <div>
      <div className="text-[11.5px] text-slate-400">{label}</div>
      <div className="text-[13px] text-slate-700 mt-0.5">{value}</div>
    </div>
  )
}

// =====================================================================
// 新建订货单（试算 → 校验 → 审批预判 → 分仓建议 → 提交）
// =====================================================================
function CreateOrderModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const { data: custData } = useFetch<any>(open ? '/order-center/customers' : null, { pageSize: 500 })
  const customers = custData?.list || []
  const [customerId, setCustomerId] = useState<number | ''>('')
  const [keyword, setKeyword] = useState('')
  const [cart, setCart] = useState<Record<number, number>>({})
  const [quote, setQuote] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const { data: catData } = useFetch<any>(open && customerId ? '/order-center/catalog' : null, {
    customer_id: customerId || undefined,
    keyword: keyword || undefined,
    pageSize: 200
  })
  const catalog = catData?.list || []

  useEffect(() => {
    if (!open) {
      setCart({})
      setQuote(null)
      setCustomerId('')
    }
  }, [open])

  const items = useMemo(
    () => Object.entries(cart).filter(([, q]) => Number(q) > 0).map(([sku, qty]) => ({ sku_id: Number(sku), qty: Number(qty) })),
    [cart]
  )

  // 购物车变了就重新试算（取价 + 校验 + 审批预判 + 分仓建议都在服务端算，前端不重算规则）
  useEffect(() => {
    let alive = true
    if (!customerId || items.length === 0) {
      setQuote(null)
      return
    }
    api
      .post('/order-center/quote', { customer_id: customerId, items })
      .then((r) => alive && setQuote(r.data))
      .catch((e: any) => alive && toast(e.message, 'error'))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerId, JSON.stringify(items)])

  const submit = async () => {
    if (!customerId || items.length === 0) return toast('请选择订货方与商品', 'error')
    setBusy(true)
    try {
      const r = await api.post('/order-center/orders', { customer_id: customerId, items, source: 'web' })
      toast(`订货单 ${r.data.order.doc_no} 已提交`)
      onDone()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  const cust = quote?.customer
  const checks = quote?.check?.checks || []
  const blocking = quote?.check?.blocking || []

  return (
    <Modal open={open} title="新建订货单" onClose={onClose} width={1040}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-[12px] text-slate-500">订货方</label>
            <select
              className="inp w-full mt-1"
              value={customerId}
              onChange={(e) => { setCustomerId(Number(e.target.value) || ''); setCart({}) }}
            >
              <option value="">请选择</option>
              {customers.map((c: any) => (
                <option key={c.id} value={c.id}>
                  {c.name}｜{CHANNEL_LABEL[c.channel] || c.channel}｜{SETTLE_LABEL[c.settle_type]}
                  {c.settle_type === 'credit' ? `｜可用 ¥${fmtMoney(c.credit_available, 0)}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-[12px] text-slate-500">商品搜索（该订货方可见目录）</label>
            <input className="inp w-full mt-1" placeholder="商品名 / 编码" value={keyword} onChange={(e) => setKeyword(e.target.value)} />
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="md:col-span-2" pad={false}>
            <div className="px-3 py-2 border-b border-slate-100 text-[13px] text-slate-600">
              可见商品 {catalog.length} 个
              {customerId ? '（按客户等级与渠道过滤，价格因人而异）' : '（先选订货方）'}
            </div>
            <div className="max-h-[320px] overflow-auto">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>商品</th>
                    <th style={{ width: 110 }}>该客户价</th>
                    <th style={{ width: 150 }}>取价来源</th>
                    <th style={{ width: 110 }}>订货数量</th>
                  </tr>
                </thead>
                <tbody>
                  {catalog.map((s: any) => (
                    <tr key={s.sku_id}>
                      <td>
                        <div className="text-slate-700">{s.product_name}</div>
                        <div className="text-[11.5px] text-slate-400">{s.sku_code} {s.spec || ''} {s.uom || ''}</div>
                      </td>
                      <td className="tabular-nums">¥{fmtMoney(s.price, 2)}</td>
                      <td className="text-[12px] text-slate-500">
                        {s.priceSource === 'price_group' ? `价格组 ${s.priceGroup || ''}` : s.priceSource}
                      </td>
                      <td>
                        <input
                          className="inp w-24"
                          type="number"
                          min={0}
                          value={cart[s.sku_id] ?? ''}
                          onChange={(e) => setCart({ ...cart, [s.sku_id]: Number(e.target.value) })}
                        />
                      </td>
                    </tr>
                  ))}
                  {catalog.length === 0 && (
                    <tr><td colSpan={4} className="text-center py-8 text-slate-400">无可订商品</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <div className="space-y-3">
            <Card>
              <SectionTitle title="试算结果" desc="取价 + 可售量 + 金额" />
              {!quote ? (
                <div className="text-[12.5px] text-slate-400">选择商品并填数量后自动试算</div>
              ) : (
                <div className="space-y-1.5 text-[13px]">
                  <Row label="合计金额" value={`¥${fmtMoney(quote.totalAmount, 2)}`} strong />
                  <Row label="合计数量" value={fmtNum(quote.totalQty, 0)} />
                  <Row label="币种" value={quote.currency} />
                  {cust && <Row label="结算方式" value={SETTLE_LABEL[cust.settle_type] || cust.settle_type} />}
                  {quote.check?.credit && quote.check.credit.creditLimit > 0 && (
                    <>
                      <Row label="授信额度" value={`¥${fmtMoney(quote.check.credit.creditLimit, 0)}`} />
                      <Row label="可用授信" value={`¥${fmtMoney(quote.check.credit.creditAvailable, 0)}`} />
                    </>
                  )}
                </div>
              )}
            </Card>

            <Card>
              <SectionTitle title="下单前校验" desc="有阻断项就不能提交" />
              {checks.length === 0 ? (
                <div className="text-[12.5px] text-slate-400">暂无校验项</div>
              ) : (
                <div className="space-y-1.5">
                  {checks.map((c: any, i: number) => (
                    <div key={i} className="flex gap-2 text-[12.5px]">
                      <span
                        className={
                          c.severity === 'block' ? 'text-red-600' : c.severity === 'warn' ? 'text-amber-600' : 'text-slate-400'
                        }
                      >
                        {c.severity === 'block' ? '阻断' : c.severity === 'warn' ? '提示' : '说明'}
                      </span>
                      <span className="text-slate-600">{c.message}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>

            {quote?.approval?.needApproval && (
              <Card>
                <SectionTitle title="审批预判" desc="命中规则：审批是有条件的" />
                <div className="space-y-1 text-[12.5px]">
                  {quote.approval.chain.map((n: any, i: number) => (
                    <div key={i} className="flex items-center gap-2 text-slate-600">
                      <Layers size={13} className="text-amber-500" />
                      {i + 1}. {n.node} <span className="text-slate-400">({n.approverRole})</span>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {quote?.pick && (
              <Card>
                <SectionTitle title="分仓建议" desc="满足率 70% + 就近度 30%" />
                <div className="text-[12.5px] space-y-1">
                  <Row label="发货仓" value={quote.pick.name} strong />
                  <Row label="满足率" value={`${(quote.pick.fillRate * 100).toFixed(0)}%`} />
                  <Row label="足量行" value={`${quote.pick.fullLines}/${quote.pick.lineCount}`} />
                  <Row label="综合得分" value={String(quote.pick.score)} />
                </div>
              </Card>
            )}

            <button className="btn-primary w-full" disabled={busy || blocking.length > 0 || items.length === 0} onClick={submit}>
              <ShoppingBag size={14} /> {blocking.length > 0 ? '存在阻断项，不可提交' : '提交订货单'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  )
}

function Row({ label, value, strong }: { label: string; value: any; strong?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-400">{label}</span>
      <span className={strong ? 'font-medium text-slate-800 tabular-nums' : 'text-slate-600 tabular-nums'}>{value}</span>
    </div>
  )
}

// =====================================================================
// 订货方（客户准入与交易条件）
// =====================================================================
function Customers() {
  const { list, total, loading, page, pageSize, setPage, setFilters, reload } = useList('/order-center/customers', {})
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const open = async (row: any) => {
    try {
      const r = await api.get(`/order-center/customers/${row.id}`)
      setDetail(r.data)
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const admit = async (decision: string) => {
    if (!detail) return
    setBusy(true)
    try {
      const r = await api.post(`/order-center/customers/${detail.id}/admit`, { decision })
      setDetail({ ...detail, ...r.data, credit: detail.credit })
      toast('已更新准入状态')
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div>
      <Card className="mb-3">
        <div className="flex items-center gap-2 flex-wrap">
          <input className="inp w-56" placeholder="客户名称 / 编码" onChange={(e) => setFilters({ keyword: e.target.value })} />
          <select className="inp w-36" onChange={(e) => setFilters({ channel: e.target.value })}>
            <option value="">全部渠道</option>
            {Object.entries(CHANNEL_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <select className="inp w-36" onChange={(e) => setFilters({ admit_status: e.target.value })}>
            <option value="">全部准入状态</option>
            {Object.entries(ADMIT_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </select>
          <div className="flex-1" />
          <button className="btn-ghost btn-sm" onClick={reload}><RefreshCw size={13} /> 刷新</button>
        </div>
      </Card>

      <Card pad={false}>
        <Table
          loading={loading}
          data={list}
          onRowClick={open}
          columns={[
            { key: 'name', title: '订货方', render: (r) => (
              <div>
                <div className="text-slate-700">{r.name}</div>
                <div className="text-[11.5px] text-slate-400">{r.code}{r.parent_name ? ` · 上级：${r.parent_name}` : ''}</div>
              </div>
            ) },
            { key: 'channel', title: '渠道', width: 100, render: (r) => CHANNEL_LABEL[r.channel] || r.channel },
            { key: 'level', title: '等级', width: 90 },
            { key: 'settle_type', title: '结算', width: 100, render: (r) => SETTLE_LABEL[r.settle_type] || r.settle_type },
            { key: 'limit_amount', title: '授信额度', align: 'right', width: 110, render: (r) => (r.limit_amount > 0 ? `¥${fmtMoney(r.limit_amount, 0)}` : '—') },
            { key: 'credit_available', title: '可用', align: 'right', width: 110, render: (r) => (r.limit_amount > 0 ? `¥${fmtMoney(r.credit_available, 0)}` : '—') },
            { key: 'order_count', title: '订货单', align: 'right', width: 80 },
            { key: 'admit_status', title: '准入', width: 90, render: (r) => (
              <span className={`tag ${r.admit_status === 'active' ? 'bg-green-100 text-green-700' : r.admit_status === 'frozen' ? 'bg-red-100 text-red-600' : 'bg-amber-100 text-amber-700'}`}>
                {ADMIT_LABEL[r.admit_status] || r.admit_status}
              </span>
            ) }
          ]}
        />
        <div className="px-3"><Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} /></div>
      </Card>

      <Modal open={!!detail} title={detail ? `订货方｜${detail.name}` : ''} onClose={() => setDetail(null)} width={920}>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Info label="来源" value={`${detail.source_type}#${detail.source_id}`} />
              <Info label="渠道 / 等级" value={`${CHANNEL_LABEL[detail.channel] || detail.channel} · ${detail.level}`} />
              <Info label="结算方式" value={SETTLE_LABEL[detail.settle_type] || detail.settle_type} />
              <Info label="账期" value={detail.credit_days ? `${detail.credit_days} 天` : '—'} />
              <Info label="授信额度" value={`¥${fmtMoney(detail.credit?.creditLimit || 0, 0)}`} />
              <Info label="已占用" value={`¥${fmtMoney(detail.credit?.creditUsed || 0, 2)}`} />
              <Info label="可用" value={`¥${fmtMoney(detail.credit?.creditAvailable || 0, 2)}`} />
              <Info label="逾期天数" value={detail.credit?.overdueDays ? `${detail.credit.overdueDays} 天` : '无逾期'} />
            </div>

            <div className="flex gap-2">
              <button className="btn-primary btn-sm" disabled={busy} onClick={() => admit('approve')}><CheckCircle2 size={14} /> 准入通过</button>
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => admit('freeze')}><AlertTriangle size={14} /> 冻结</button>
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => admit('unfreeze')}><RefreshCw size={14} /> 解冻</button>
            </div>

            <div>
              <SectionTitle title="授信台账" desc="额度如何被用掉，一笔一笔可查" />
              <Table
                data={detail.creditLedger || []}
                columns={[
                  { key: 'created_at', title: '时间', width: 160 },
                  { key: 'change_type', title: '类型', width: 90, render: (r) => ({ occupy: '下单占用', release: '取消释放', repay: '回款释放', adjust: '人工调额' }[r.change_type] || r.change_type) },
                  { key: 'amount', title: '变动', align: 'right', width: 110, render: (r) => (
                    <span className={Number(r.amount) >= 0 ? 'text-red-600' : 'text-green-600'}>
                      {Number(r.amount) >= 0 ? '+' : ''}{fmtMoney(r.amount, 2)}
                    </span>
                  ) },
                  { key: 'balance_after', title: '余额', align: 'right', width: 110, render: (r) => fmtMoney(r.balance_after, 2) },
                  { key: 'doc_no', title: '关联单号', width: 160 },
                  { key: 'remark', title: '说明' }
                ]}
                empty="暂无台账"
              />
            </div>

            <div>
              <SectionTitle title="近期订货单" />
              <Table
                data={detail.orders || []}
                columns={[
                  { key: 'doc_no', title: '单号', width: 170 },
                  { key: 'order_date', title: '日期', width: 110 },
                  { key: 'total_amount', title: '金额', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.total_amount, 2)}` },
                  { key: 'status', title: '状态', width: 100, render: (r) => <Status value={r.status} /> }
                ]}
                empty="暂无订货单"
              />
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// =====================================================================
// 对账
// =====================================================================
function Statements() {
  const { list, total, loading, page, pageSize, setPage, reload } = useList('/order-center/statements', {})
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [payAmount, setPayAmount] = useState('')

  const open = async (row: any) => {
    try {
      const r = await api.get(`/order-center/statements/${row.id}`)
      setDetail(r.data)
      setPayAmount(String(r.data.diff_amount || ''))
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  const callStatement = async (action: string, body: any, msg: string) => {
    if (!detail) return
    const fn = STATEMENT_ACTIONS[action]
    if (!fn) return toast(`未知的对账单动作：${action}`, 'error')
    setBusy(true)
    try {
      const r = await fn(detail.id, body)
      setDetail(r.data.statement || r.data)
      toast(msg)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    } finally {
      setBusy(false)
    }
  }

  // 结清 / 作废要比别的动作多一步"收集理由"——服务端强制理由必填（400 REASON_REQUIRED），
  // 先问一次比让用户点了按钮再看红字省事。**但判据仍在服务端**（前端只是提前收集；
  // 绕过前端直接打接口一样会被拦）。
  //   · 结清：先按"账真的收齐了"提交；服务端 409（未收差额未结清）时才问是否走
  //     「业务判断手动结清」（force）。这个次序是刻意的 —— 默认路径永远走"收齐"。
  //   · 作废：理由必填，且**只作废这份对账单凭证**（不动订货单与授信台账）。
  const runStatementAction = async (a: any, meta: any) => {
    if (!detail) return
    if (a.action === 'void') {
      const why = prompt(
        `作废对账单 ${detail.doc_no}\n\n请写明作废理由（不少于 5 个字）：\n（作废只作废这份对账单凭证，不改动底层台账：订货单与授信占用都不动）`
      )
      if (!why || why.trim().length < 5) return toast('已取消：作废必须写明理由', 'error')
      return callStatement('void', { reason: why }, '已作废')
    }
    if (a.action === 'close') {
      setBusy(true)
      try {
        const r = await STATEMENT_ACTIONS.close(detail.id, {})
        setDetail(r.data.statement || r.data)
        toast('已结清')
        reload()
      } catch (e: any) {
        if (!String(e.message || '').includes('未结清')) toast(e.message, 'error')
        else {
          const why = prompt(`${e.message}\n\n走「业务判断手动结清」请写明理由（不少于 5 个字）：`)
          if (!why || why.trim().length < 5) toast('已取消：手动结清必须写明理由', 'error')
          else {
            try {
              const r2 = await STATEMENT_ACTIONS.close(detail.id, { reason: why, force: true })
              setDetail(r2.data.statement || r2.data)
              toast('已手动结清')
              reload()
            } catch (e2: any) {
              toast(e2.message, 'error')
            }
          }
        }
      } finally {
        setBusy(false)
      }
      return
    }
    return callStatement(a.action, {}, `${meta.label}成功`)
  }

  const createStatement = async () => {
    const cust = prompt('输入订货方 ID（可在「订货方」页签查看）')
    if (!cust) return
    const from = prompt('账期开始日期 YYYY-MM-DD', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10))
    const to = prompt('账期结束日期 YYYY-MM-DD', new Date().toISOString().slice(0, 10))
    if (!from || !to) return
    try {
      const r = await api.post('/order-center/statements', { customer_id: Number(cust), period_start: from, period_end: to })
      toast(`对账单 ${r.data.doc_no} 已生成`)
      reload()
    } catch (e: any) {
      toast(e.message, 'error')
    }
  }

  return (
    <div>
      <Card className="mb-3">
        <div className="flex items-center gap-2">
          <button className="btn-primary btn-sm" onClick={createStatement}><FileText size={14} /> 生成对账单</button>
          <div className="flex-1" />
          <button className="btn-ghost btn-sm" onClick={reload}><RefreshCw size={13} /> 刷新</button>
        </div>
      </Card>

      <Card pad={false}>
        <Table
          loading={loading}
          data={list}
          onRowClick={open}
          columns={[
            { key: 'doc_no', title: '对账单号', width: 170 },
            { key: 'customer_name', title: '订货方' },
            { key: 'period', title: '账期', width: 200, render: (r) => `${r.period_start} ~ ${r.period_end}` },
            { key: 'order_count', title: '单数', align: 'right', width: 70 },
            { key: 'total_amount', title: '应付', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.total_amount, 2)}` },
            { key: 'paid_amount', title: '已收', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.paid_amount, 2)}` },
            { key: 'diff_amount', title: '未收', align: 'right', width: 120, render: (r) => (
              <span className={Number(r.diff_amount) > 0.001 ? 'text-amber-600' : 'text-green-600'}>¥{fmtMoney(r.diff_amount, 2)}</span>
            ) },
            { key: 'status', title: '状态', width: 100, render: (r) => <Status value={r.status} /> }
          ]}
        />
        <div className="px-3"><Pagination page={page} pageSize={pageSize} total={total} onChange={setPage} /></div>
      </Card>

      <Modal open={!!detail} title={detail ? `对账单｜${detail.doc_no}` : ''} onClose={() => setDetail(null)} width={900}>
        {detail && (
          <div className="space-y-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <Info label="订货方" value={detail.customer_name} />
              <Info label="账期" value={`${detail.period_start} ~ ${detail.period_end}`} />
              <Info label="应付 / 已收 / 未收" value={`¥${fmtMoney(detail.total_amount, 2)} / ¥${fmtMoney(detail.paid_amount, 2)} / ¥${fmtMoney(detail.diff_amount, 2)}`} />
              <Info label="状态" value={<Status value={detail.status} />} />
            </div>

            <Table
              data={detail.items || []}
              columns={[
                { key: 'doc_no', title: '订货单号', width: 170 },
                { key: 'order_date', title: '日期', width: 110 },
                { key: 'amount', title: '金额', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.amount, 2)}` },
                { key: 'paid_amount', title: '已收', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.paid_amount, 2)}` },
                { key: 'diff_amount', title: '未收', align: 'right', width: 120, render: (r) => `¥${fmtMoney(r.diff_amount, 2)}` }
              ]}
              empty="无明细"
            />

            <div className="flex items-center gap-2 flex-wrap pt-1 border-t border-slate-100">
              {(detail.actions || []).map((a: any) => {
                const meta = ACTION_META[a.action] || { label: a.name, icon: ArrowRight, cls: 'btn-ghost btn-sm' }
                const Icon = meta.icon
                return (
                  <button key={a.action} className={meta.cls} disabled={busy} onClick={() => runStatementAction(a, meta)}>
                    <Icon size={14} /> {meta.label}
                  </button>
                )
              })}
              {detail.status !== 'draft' && (
                <div className="flex items-center gap-2 ml-auto">
                  <CreditCard size={14} className="text-slate-400" />
                  <input className="inp w-32" type="number" value={payAmount} onChange={(e) => setPayAmount(e.target.value)} placeholder="回款金额" />
                  <button className="btn-primary btn-sm" disabled={busy} onClick={() => callStatement('settle', { amount: Number(payAmount) }, '回款已登记')}>
                    登记回款
                  </button>
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}

// =====================================================================
// 业务流与规则
// =====================================================================
function FlowPanel() {
  const { data, loading } = useFetch<any>('/order-center/flow')
  const { data: pol } = useFetch<any>('/order-center/policies')
  const steps = data?.flow?.steps || []

  return (
    <div className="space-y-4">
      <Card>
        <SectionTitle title="订货中心主流程" desc={data?.flow?.remark || ''} />
        <div className="flex items-center gap-2 overflow-x-auto pb-2">
          {steps.map((s: any, i: number) => (
            <div key={s.seq} className="flex items-center gap-2 shrink-0">
              <div className={`px-3 py-2 rounded-lg border ${s.is_required ? 'border-brand-200 bg-brand-50' : 'border-slate-200 bg-slate-50'}`}>
                <div className="text-[13px] text-slate-700">{s.node_name}</div>
                <div className="text-[11.5px] text-slate-400">{s.doc_type} · {s.perm_code || '—'}{s.is_required ? '' : ' · 可选'}</div>
              </div>
              {i < steps.length - 1 && <ArrowRight size={15} className="text-slate-300 shrink-0" />}
            </div>
          ))}
          {steps.length === 0 && <span className="text-[13px] text-slate-400">{loading ? '加载中…' : '未登记业务流'}</span>}
        </div>
      </Card>

      <div className="grid md:grid-cols-2 gap-4">
        <Card>
          <SectionTitle title="订货单状态机" desc="合法状态与合法流转是数据，不是散落的 if" />
          <div className="space-y-1.5 text-[12.5px]">
            {(data?.machine?.OC?.states || []).map((s: any) => {
              const outs = (data.machine.OC.edges || []).filter((e: any) => e.from_state === s.code)
              return (
                <div key={s.code} className="flex gap-2">
                  <span className="w-24 shrink-0 text-slate-700">{s.name}</span>
                  <span className="text-slate-400 flex-1">
                    {outs.length ? outs.map((e: any) => `${e.action_name}→${e.to_state}`).join('，') : '终态'}
                  </span>
                </div>
              )
            })}
          </div>
        </Card>

        <Card>
          <SectionTitle title="审批规则" desc="命中即进审批链；规则可配，不是写死的阈值" />
          <Table
            data={pol?.approvalRules || []}
            columns={[
              { key: 'name', title: '规则' },
              { key: 'scope', title: '范围', width: 80, render: (r) => (r.scope === 'global' ? '全局' : r.scope === 'channel' ? `渠道：${CHANNEL_LABEL[r.channel] || r.channel}` : '指定客户') },
              { key: 'cond', title: '条件', width: 150, render: (r) => `${r.cond_field} ${r.cond_op} ${r.cond_value ?? ''}` },
              { key: 'node', title: '审批节点', width: 160 },
              { key: 'approver_role', title: '角色', width: 90 }
            ]}
            empty="暂无规则"
          />
        </Card>
      </div>

      <Card>
        <SectionTitle title="商品可见性规则" desc="同一商品，不同等级/渠道的客户看到的不一样" />
        <Table
          data={pol?.visibilityRules || []}
          columns={[
            { key: 'scope', title: '维度', width: 100, render: (r) => ({ level: '客户等级', channel: '渠道', customer: '指定客户' }[r.scope] || r.scope) },
            { key: 'scope_value', title: '取值', width: 140 },
            { key: 'category_id', title: '品类', width: 90, render: (r) => r.category_id || '—' },
            { key: 'brand_id', title: '品牌', width: 90, render: (r) => r.brand_id || '—' },
            { key: 'allowed', title: '结论', width: 90, render: (r) => (r.allowed ? <span className="text-green-600">可见</span> : <span className="text-red-600">隐藏</span>) },
            { key: 'remark', title: '说明' }
          ]}
          empty="暂无规则（全部商品可见）"
        />
      </Card>
    </div>
  )
}
