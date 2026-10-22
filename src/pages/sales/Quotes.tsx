/**
 * ============================================================================
 * 文件标识：src/pages/sales/Quotes.tsx ｜ Quotes（页面，未取到标题）
 * ============================================================================
 * 【职责】Quotes（页面，未取到标题）（页面）
 * 【入口】/sales/quotes
 * 【主要接口】/sales/quotes/meta、/sales/quotes/overview
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
 * 页面：Quotes（页面，未取到标题）
 */

import { useMemo, useState } from 'react'
import {
  Card, SectionTitle, StatCard, Table, Empty, Modal, Field, Tabs,
  fmtMoney, fmtNum, fmtInt, today, toast, useFetch
} from '../../components/ui'
import { FilterBar, Sel, Inp } from '../../components/DataPage'
import { useOpts } from '../../hooks/opts'
import {
  QUOTE_LIST, QUOTE_DETAIL, QUOTE_PRICE, QUOTE_CREATE, QUOTE_ACTION,
  QUOTE_CONVERT, QUOTE_COPY, QUOTE_EXPIRE, QUOTE_OVERVIEW, QUOTE_META,
  QUOTE_STATUS_CLS,
  type Quote, type QuoteItem
} from '../../api/quotes'
import { FileText, CheckCircle2, GitCompareArrows, Copy, Ban, Send, ShieldAlert, Clock3 } from 'lucide-react'

/**
 * 销售报价单（模块 08A）。
 *
 * 这一页把「报价」从一条消息变成一张单，四件事必须在界面上说清楚：
 *   ① 价从哪来 —— 每行带取价来源与规则，手工改过的行标「改价」；
 *   ② 管到哪天 —— 有效期列出来，过期/未审批的报价不出现「转订单」按钮；
 *   ③ 谁批的   —— 需要审批的单把原因写在卡片上，审批后记审批人；
 *   ④ 转成什么 —— 已转单的报价只显示「查看订单」，不允许再转一次。
 */
export default function Quotes() {
  const [tab, setTab] = useState<'list' | 'new'>('list')
  const [tick, setTick] = useState(0)
  const reload = () => setTick((t) => t + 1)
  const o = useOpts()

  const [status, setStatus] = useState('')
  const [keyword, setKeyword] = useState('')
  const [page, setPage] = useState(1)
  const [validOnly, setValidOnly] = useState(false)

  const { data: meta } = useFetch<any>('/sales/quotes/meta', undefined, [])
  const { data: ov } = useFetch<any>('/sales/quotes/overview', undefined, [tick])
  const { data: list, loading } = useFetch<{ rows: Quote[]; total: number; page: number; pageSize: number }>(
    '/sales/quotes',
    { status: status || undefined, keyword: keyword || undefined, valid_only: validOnly ? 1 : 0, page, pageSize: 20 },
    [tick, status, keyword, validOnly, page]
  )
  const rows = list?.rows || []
  const pageSize = list?.pageSize || 20

  const statusLabel = useMemo(() => {
    const m: Record<string, string> = {}
    for (const s of (meta as any)?.statuses || []) m[s.value] = s.label
    return m
  }, [meta])

  // ---- 详情 ----
  const [detail, setDetail] = useState<Quote | null>(null)
  const [busy, setBusy] = useState(false)

  const openDetail = async (id: number) => {
    try {
      setDetail(await QUOTE_DETAIL(id))
    } catch (e: any) {
      toast(e.message || '打开失败', 'error')
    }
  }

  const doAction = async (q: Quote, action: string, label: string) => {
    let remark: string | undefined
    if (action === 'reject' || action === 'cancel') {
      remark = prompt(`${label}原因（可留空）`) || undefined
    }
    setBusy(true)
    try {
      await QUOTE_ACTION(q.id, action, remark)
      toast(`${label}成功`)
      await openDetail(q.id)
      reload()
    } catch (e: any) {
      toast(e.message || `${label}失败`, 'error')
    } finally {
      setBusy(false)
    }
  }

  const doConvert = async (q: Quote, force = false) => {
    let reason: string | undefined
    if (force) {
      reason = prompt('超信特批：请填写放行理由（必填，会记入信用留痕）') || ''
      if (!reason.trim()) {
        toast('特批放行必须填写理由', 'error')
        return
      }
    }
    setBusy(true)
    try {
      const out = await QUOTE_CONVERT(q.id, { target: 'SO', force, reason })
      toast(
        out.reused
          ? `该报价已转过单：${out.order?.doc_no || ''}`
          : `已转为销售订单 ${out.order?.doc_no || ''}${force ? '（超信特批）' : ''}`
      )
      await openDetail(q.id)
      reload()
    } catch (e: any) {
      // 超信被拦时给一条明确的「去特批」的路，而不是只丢一个红字。
      // 业务码被**双写**（顶层 `error` + `detail.code`），所以两处都要认 ——
      // 这正是双写的意义：任一读法单独存在时都有漏判风险。
      // 注意 `e?.code` 不是业务码：顶层 `code` 是**数字**（1 / HTTP 状态码），
      // 业务码是字符串。原先写的 `e?.code === 'CREDIT_BLOCKED'` 是个**永远为假**的死分支。
      if (e?.error === 'CREDIT_BLOCKED' || e?.detail?.code === 'CREDIT_BLOCKED') {
        toast(e.message || '信用校验未通过', 'error')
        if (confirm(`${e.message}\n\n是否改用「超信特批」继续转单？（需填写理由并入留痕）`)) {
          setBusy(false)
          doConvert(q, true)
          return
        }
      } else {
        toast(e.message || '转单失败', 'error')
      }
    } finally {
      setBusy(false)
    }
  }

  const doCopy = async (q: Quote) => {
    setBusy(true)
    try {
      const n = await QUOTE_COPY(q.id)
      toast(`已生成新版本 ${n.doc_no}（v${n.version}）`)
      reload()
    } catch (e: any) {
      toast(e.message || '复制失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doExpire = async () => {
    setBusy(true)
    try {
      const out = await QUOTE_EXPIRE()
      toast(`已将 ${out.expired} 张过期报价置为「已过期」`)
      reload()
    } catch (e: any) {
      toast(e.message || '操作失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-3">
      <SectionTitle
        title="销售报价单"
        desc="报价是一张单：价由价格中心算出、带有效期、低于限价要审批，审批通过才能转订单；一张报价只能转一次单"
        right={
          <div className="flex gap-2">
            <button className="btn-ghost btn-sm" disabled={busy} onClick={doExpire}>
              <Clock3 size={14} /> 清理过期报价
            </button>
            <button className="btn-primary btn-sm" onClick={() => setTab(tab === 'new' ? 'list' : 'new')}>
              <FileText size={14} /> {tab === 'new' ? '返回列表' : '新建报价'}
            </button>
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <StatCard label="待审批" value={fmtInt(ov?.pending_approval || 0)} tone={(ov?.pending_approval || 0) > 0 ? 'warn' : 'default'} icon={<ShieldAlert size={16} />} />
        <StatCard label="已转单金额" value={fmtMoney(ov?.converted_amount || 0)} icon={<GitCompareArrows size={16} />} />
        <StatCard label="7 天内到期" value={fmtInt(ov?.expiring_soon?.length || 0)} sub="已审批未过期" icon={<Clock3 size={16} />} />
        <StatCard label="报价总数" value={fmtInt(list?.total || 0)} />
        <StatCard label="审批金额阈值" value={fmtMoney((meta as any)?.approval_amount_threshold || 0)} sub="超过即需审批" />
      </div>

      <Tabs
        tabs={[{ key: 'list', label: '报价列表' }, { key: 'new', label: '新建报价（含取价试算）' }]}
        value={tab}
        onChange={(k) => setTab(k as any)}
      />

      {tab === 'list' ? (
        <Card pad={false}>
          <div className="p-3">
            <FilterBar
              onReset={() => {
                setStatus('')
                setKeyword('')
                setValidOnly(false)
                setPage(1)
              }}
            >
              <Sel
                w={140}
                value={status}
                onChange={(v) => { setStatus(v); setPage(1) }}
                options={(meta as any)?.statuses || []}
                placeholder="全部状态"
              />
              <Inp w={180} value={keyword} onChange={(v) => { setKeyword(v); setPage(1) }} placeholder="单号 / 客户" />
              <label className="flex items-center gap-1.5 text-[13px] text-slate-600">
                <input type="checkbox" checked={validOnly} onChange={(e) => { setValidOnly(e.target.checked); setPage(1) }} />
                仅看可转单（已审批且未过期）
              </label>
            </FilterBar>
          </div>
          <Table
            loading={loading}
            data={rows}
            empty="还没有报价单"
            onRowClick={(r) => openDetail(r.id)}
            columns={[
              { key: 'doc_no', title: '报价单号', width: 150, render: (r: Quote) => <span className="font-mono text-[13px]">{r.doc_no}</span> },
              { key: 'customer', title: '客户', render: (r: Quote) => r.dealer_name || r.customer_name || r.store_name || '-' },
              { key: 'version', title: '版本', width: 60, align: 'center', render: (r: Quote) => `v${r.version}` },
              {
                key: 'valid',
                title: '有效期',
                width: 190,
                render: (r: Quote) => (
                  <span className={r.expired ? 'text-red-600' : 'text-slate-600'}>
                    {r.valid_from} ~ {r.valid_to}
                    {r.expired && <span className="ml-1 text-[12px]">已过期</span>}
                  </span>
                )
              },
              { key: 'total_amount', title: '报价金额', align: 'right', width: 120, render: (r: Quote) => fmtMoney(r.total_amount) },
              {
                key: 'gross_rate',
                title: '整单折扣',
                align: 'right',
                width: 100,
                render: (r: Quote) => (
                  <span className={r.below_min_count > 0 ? 'text-orange-600' : ''}>{fmtNum(r.gross_rate)}%</span>
                )
              },
              {
                key: 'status',
                title: '状态',
                width: 100,
                align: 'center',
                render: (r: Quote) => (
                  <span className={`px-2 py-0.5 rounded text-[12px] ${QUOTE_STATUS_CLS[r.status] || 'bg-slate-100 text-slate-600'}`}>
                    {statusLabel[r.status] || r.status}
                  </span>
                )
              },
              {
                key: 'need_approval',
                title: '审批',
                width: 220,
                render: (r: Quote) =>
                  r.need_approval ? (
                    <span className="text-[12px] text-orange-600" title={r.approval_reason || ''}>
                      需审批：{r.approval_reason}
                    </span>
                  ) : (
                    <span className="text-[12px] text-slate-400">免审批</span>
                  )
              },
              {
                key: 'op',
                title: '操作',
                width: 200,
                render: (r: Quote) => (
                  <div className="flex gap-1.5">
                    {r.status === 'draft' && (
                      <button className="btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doAction(r, 'submit', '提交') }}>
                        <Send size={13} /> 提交
                      </button>
                    )}
                    {r.status === 'submitted' && (
                      <>
                        <button className="btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doAction(r, 'approve', '审批通过') }}>
                          <CheckCircle2 size={13} /> 通过
                        </button>
                        <button className="btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doAction(r, 'reject', '驳回') }}>
                          <Ban size={13} /> 驳回
                        </button>
                      </>
                    )}
                    {r.status === 'rejected' && (
                      <button className="btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doAction(r, 'resubmit', '再提交') }}>
                        <Send size={13} /> 再提交
                      </button>
                    )}
                    {/* 只有「已审批 + 未过期」才出现转单按钮：不该让人点了才被告知不行 */}
                    {r.status === 'approved' && !r.expired && (
                      <button className="btn-primary btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doConvert(r) }}>
                        <GitCompareArrows size={13} /> 转订单
                      </button>
                    )}
                    {r.status === 'converted' && (
                      <span className="text-[12px] text-green-700">已转 {r.converted_doc_no}</span>
                    )}
                    {['draft', 'submitted', 'approved', 'rejected'].includes(r.status) && (
                      <button className="btn-ghost btn-sm" disabled={busy} onClick={(e) => { e.stopPropagation(); doCopy(r) }}>
                        <Copy size={13} /> 改版
                      </button>
                    )}
                  </div>
                )
              }
            ]}
          />
          {rows.length > 0 && (
            <div className="flex items-center justify-between px-3 py-2 text-[13px] text-slate-500">
              <span>共 {fmtInt(list?.total || 0)} 条</span>
              <div className="flex gap-1.5">
                <button className="btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>上一页</button>
                <button className="btn-ghost btn-sm" disabled={rows.length < pageSize} onClick={() => setPage(page + 1)}>下一页</button>
              </div>
            </div>
          )}
        </Card>
      ) : (
        <NewQuote
          onCreated={(q) => {
            toast(`已建报价 ${q.doc_no}（草稿）`)
            setTab('list')
            reload()
            openDetail(q.id)
          }}
          dealers={o.dealers}
          warehouses={o.warehouses}
          skus={o.skus}
          defaultValidDays={(meta as any)?.valid_days_default || 30}
        />
      )}

      {detail && (
        <QuoteDetailModal
          quote={detail}
          onClose={() => setDetail(null)}
          onRefresh={async () => {
            await openDetail(detail.id)
            reload()
          }}
          onConvert={(force) => doConvert(detail, force)}
          onAction={(action, label) => doAction(detail, action, label)}
          onCopy={() => doCopy(detail)}
          busy={busy}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// 新建报价：先取价试算，再落库
// ---------------------------------------------------------------------------
function NewQuote({
  onCreated, dealers, warehouses, skus, defaultValidDays
}: {
  onCreated: (q: Quote) => void
  dealers: any[]
  warehouses: any[]
  skus: any[]
  defaultValidDays: number
}) {
  const [dealerId, setDealerId] = useState<number | null>(null)
  const [warehouseId, setWarehouseId] = useState<number | null>(null)
  const [validDays, setValidDays] = useState(defaultValidDays)
  const [freight, setFreight] = useState(0)
  const [taxRate, setTaxRate] = useState(0)
  const [remark, setRemark] = useState('')
  const [lines, setLines] = useState<{ sku_id: number; qty: number; price?: number }[]>([])
  const [priced, setPriced] = useState<any>(null)
  const [busy, setBusy] = useState(false)

  const addLine = (skuId: number) => {
    if (!skuId) return
    const exist = lines.find((l) => l.sku_id === skuId)
    if (exist) {
      setLines(lines.map((l) => (l.sku_id === skuId ? { ...l, qty: Number(l.qty) + 1 } : l)))
    } else {
      setLines([...lines, { sku_id: skuId, qty: 1 }])
    }
    setPriced(null)
  }
  const updateLine = (i: number, patch: any) => {
    setLines(lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
    setPriced(null)
  }
  const removeLine = (i: number) => {
    setLines(lines.filter((_, idx) => idx !== i))
    setPriced(null)
  }

  const doPrice = async () => {
    if (!lines.length) {
      toast('请先添加报价商品', 'error')
      return
    }
    setBusy(true)
    try {
      const r = await QUOTE_PRICE({
        items: lines,
        customer_type: 'dealer',
        dealer_id: dealerId,
        warehouse_id: warehouseId,
        freight: Number(freight || 0),
        tax_rate: Number(taxRate || 0)
      })
      setPriced(r)
      toast(`试算完成：金额 ${fmtMoney(r.total_amount)}`)
    } catch (e: any) {
      toast(e.message || '取价失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const doCreate = async () => {
    if (!lines.length) {
      toast('请至少添加一行', 'error')
      return
    }
    setBusy(true)
    try {
      const q = await QUOTE_CREATE({
        customer_type: 'dealer',
        dealer_id: dealerId,
        warehouse_id: warehouseId,
        items: lines,
        valid_days: Number(validDays || 30),
        freight: Number(freight || 0),
        tax_rate: Number(taxRate || 0),
        remark: remark || undefined
      })
      onCreated(q)
    } catch (e: any) {
      toast(e.message || '建单失败', 'error')
    } finally {
      setBusy(false)
    }
  }

  const skuName = (id: number) => skus.find((s) => Number(s.value) === Number(id))?.label || `#${id}`

  return (
    <Card>
      <SectionTitle title="新建报价" desc="先选客户与商品，点「取价试算」看价格中心算出来的价，确认无误再保存为草稿" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <Field label="客户（经销商）">
          <select className="input input-sm" value={dealerId ?? ''} onChange={(e) => setDealerId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">请选择</option>
            {dealers.map((d) => (
              <option key={d.value} value={d.value}>{d.label}</option>
            ))}
          </select>
        </Field>
        <Field label="发货仓库">
          <select className="input input-sm" value={warehouseId ?? ''} onChange={(e) => setWarehouseId(e.target.value ? Number(e.target.value) : null)}>
            <option value="">不指定</option>
            {warehouses.map((w) => (
              <option key={w.value} value={w.value}>{w.label}</option>
            ))}
          </select>
        </Field>
        <Field label="有效期（天）">
          <input className="input input-sm" type="number" value={validDays} onChange={(e) => setValidDays(Number(e.target.value))} />
        </Field>
        <Field label="运费">
          <input className="input input-sm" type="number" value={freight} onChange={(e) => setFreight(Number(e.target.value))} />
        </Field>
        <Field label="税率（%）">
          <input className="input input-sm" type="number" value={taxRate} onChange={(e) => setTaxRate(Number(e.target.value))} />
        </Field>
      </div>

      <div className="flex items-center gap-2 my-3">
        <select
          className="input input-sm"
          value=""
          onChange={(e) => addLine(e.target.value ? Number(e.target.value) : 0)}
        >
          <option value="">+ 添加商品</option>
          {skus.slice(0, 300).map((s) => (
            <option key={s.value} value={s.value}>{s.label}</option>
          ))}
        </select>
        <button className="btn-ghost btn-sm" disabled={busy || !lines.length} onClick={doPrice}>
          取价试算
        </button>
        <button className="btn-primary btn-sm" disabled={busy || !lines.length} onClick={doCreate}>
          保存为草稿
        </button>
      </div>

      {lines.length === 0 ? (
        <Empty text="还没有报价明细" />
      ) : (
        <div className="table-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>商品</th>
                <th style={{ width: 100 }}>数量</th>
                <th style={{ width: 120 }}>挂牌价</th>
                <th style={{ width: 120 }}>成交价</th>
                <th style={{ width: 100 }}>折扣率</th>
                <th style={{ width: 120 }}>金额</th>
                <th style={{ width: 180 }}>价格来源</th>
                <th style={{ width: 60 }}></th>
              </tr>
            </thead>
            <tbody>
              {(priced?.lines || []).map((l: QuoteItem, i: number) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{l.sku_name || skuName(l.sku_id)}</td>
                  <td>
                    <input
                      className="input input-sm"
                      type="number"
                      value={lines[i]?.qty ?? l.qty}
                      onChange={(e) => updateLine(i, { qty: Number(e.target.value) })}
                    />
                  </td>
                  <td className="tabular-nums">{fmtMoney(l.list_price)}</td>
                  <td>
                    <input
                      className="input input-sm"
                      type="number"
                      value={lines[i]?.price ?? l.price}
                      onChange={(e) => updateLine(i, { price: Number(e.target.value) })}
                    />
                  </td>
                  <td className="tabular-nums">{fmtNum(l.discount_rate)}%</td>
                  <td className="tabular-nums">{fmtMoney(l.amount)}</td>
                  <td className="text-[12px]">
                    <div>{l.price_source === 'price_group' ? '价格组价' : l.price_source === 'member' ? '会员价' : l.price_source === 'promotion' ? '促销价' : '标准零售价'}</div>
                    <div className="text-slate-400">{l.price_trace}</div>
                    {l.below_min === 1 && <div className="text-orange-600">低于最低限价 {fmtMoney(l.min_price)}</div>}
                  </td>
                  <td>
                    <button className="btn-ghost btn-sm" onClick={() => removeLine(i)}>移除</button>
                  </td>
                </tr>
              ))}
              {!priced &&
                lines.map((l, i) => (
                  <tr key={`raw-${i}`}>
                    <td>{i + 1}</td>
                    <td>{skuName(l.sku_id)}</td>
                    <td className="tabular-nums">{l.qty}</td>
                    <td colSpan={5} className="text-slate-400 text-[12px]">点「取价试算」得到价格</td>
                    <td><button className="btn-ghost btn-sm" onClick={() => removeLine(i)}>移除</button></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      )}

      {priced && (
        <div className="mt-3 grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="货款" value={fmtMoney(priced.goods_amount)} />
          <StatCard label="整单折扣率" value={`${fmtNum(priced.gross_rate)}%`} tone={priced.below_min_count > 0 ? 'warn' : 'default'} />
          <StatCard label="价税合计" value={fmtMoney(priced.total_amount)} />
          <StatCard
            label="审批"
            value={priced.need_approval ? '需要审批' : '免审批'}
            tone={priced.need_approval ? 'warn' : 'good'}
            sub={priced.approval_reason || undefined}
          />
        </div>
      )}

      <div className="mt-3">
        <Field label="备注">
          <input className="input input-sm" value={remark} onChange={(e) => setRemark(e.target.value)} placeholder="报价说明（可选）" />
        </Field>
      </div>
    </Card>
  )
}

// ---------------------------------------------------------------------------
// 详情弹窗
// ---------------------------------------------------------------------------
function QuoteDetailModal({
  quote, onClose, onRefresh, onConvert, onAction, onCopy, busy
}: {
  quote: Quote
  onClose: () => void
  onRefresh: () => void
  onConvert: (force: boolean) => void
  onAction: (action: string, label: string) => void
  onCopy: () => void
  busy: boolean
}) {
  const items = quote.items || []
  const canConvert = quote.status === 'approved' && !quote.expired && !quote.converted
  return (
    <Modal
      open
      width={980}
      title={
        <div className="flex items-center gap-2">
          <span className="font-mono">{quote.doc_no}</span>
          <span className={`px-2 py-0.5 rounded text-[12px] ${QUOTE_STATUS_CLS[quote.status] || 'bg-slate-100 text-slate-600'}`}>
            {quote.status}
          </span>
          <span className="text-[12px] text-slate-500">v{quote.version}</span>
        </div>
      }
      onClose={onClose}
      footer={
        <div className="flex gap-2 justify-end">
          {quote.status === 'draft' && (
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => onAction('submit', '提交')}>提交审批</button>
          )}
          {quote.status === 'submitted' && (
            <>
              <button className="btn-primary btn-sm" disabled={busy} onClick={() => onAction('approve', '审批通过')}>审批通过</button>
              <button className="btn-ghost btn-sm" disabled={busy} onClick={() => onAction('reject', '驳回')}>驳回</button>
            </>
          )}
          {quote.status === 'rejected' && (
            <button className="btn-ghost btn-sm" disabled={busy} onClick={() => onAction('resubmit', '再提交')}>修改后再提交</button>
          )}
          {canConvert && (
            <button className="btn-primary btn-sm" disabled={busy} onClick={() => onConvert(false)}>转为销售订单</button>
          )}
          {['draft', 'submitted', 'approved', 'rejected'].includes(quote.status) && (
            <button className="btn-ghost btn-sm" disabled={busy} onClick={onCopy}>复制改版</button>
          )}
        </div>
      }
    >
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[13px] mb-3">
        <div><span className="text-slate-500">客户：</span>{quote.dealer_name || quote.customer_name || quote.store_name || '-'}</div>
        <div><span className="text-slate-500">报价日期：</span>{quote.quote_date}</div>
        <div>
          <span className="text-slate-500">有效期：</span>
          <span className={quote.expired ? 'text-red-600' : ''}>{quote.valid_from} ~ {quote.valid_to}</span>
        </div>
        <div><span className="text-slate-500">整单折扣：</span>{fmtNum(quote.gross_rate)}%</div>
        <div><span className="text-slate-500">货款：</span>{fmtMoney(quote.goods_amount)}</div>
        <div><span className="text-slate-500">运费：</span>{fmtMoney(quote.freight)}</div>
        <div><span className="text-slate-500">税额：</span>{fmtMoney(quote.tax_amount)}（{fmtNum(quote.tax_rate)}%）</div>
        <div><span className="text-slate-500">价税合计：</span><b>{fmtMoney(quote.total_amount)}</b></div>
      </div>

      {quote.need_approval ? (
        <div className="mb-3 p-2 rounded bg-orange-50 text-orange-700 text-[13px]">
          需审批：{quote.approval_reason}
          {quote.approved_by_name && <span className="ml-2">（{quote.approved_by_name} 于 {quote.approved_at} 批准）</span>}
        </div>
      ) : null}
      {quote.converted && (
        <div className="mb-3 p-2 rounded bg-green-50 text-green-700 text-[13px]">
          已转为{quote.converted_type === 'OC' ? '订货单' : '销售订单'}：{quote.converted_doc_no}（一张报价只能转一次单）
        </div>
      )}
      {quote.expired && quote.status === 'expired' && (
        <div className="mb-3 p-2 rounded bg-slate-100 text-slate-500 text-[13px]">
          该报价已过有效期（{quote.valid_to}），不能转单；可「复制改版」重新报价。
        </div>
      )}

      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>商品</th>
              <th style={{ width: 80 }}>数量</th>
              <th style={{ width: 110 }}>挂牌价</th>
              <th style={{ width: 110 }}>成交价</th>
              <th style={{ width: 90 }}>折扣率</th>
              <th style={{ width: 110 }}>最低限价</th>
              <th style={{ width: 120 }}>金额</th>
              <th>价格来源</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={i}>
                <td>{it.line_no ?? i + 1}</td>
                <td>
                  {it.sku_name || `#${it.sku_id}`}
                  <div className="text-[12px] text-slate-400">{it.sku_code}{it.spec ? ` · ${it.spec}` : ''}</div>
                </td>
                <td className="tabular-nums">{fmtNum(it.qty, 0)}</td>
                <td className="tabular-nums">{fmtMoney(it.list_price)}</td>
                <td className="tabular-nums">{fmtMoney(it.price)}</td>
                <td className="tabular-nums">{fmtNum(it.discount_rate)}%</td>
                <td className="tabular-nums">{fmtMoney(it.min_price)}</td>
                <td className="tabular-nums">{fmtMoney(it.amount)}</td>
                <td className="text-[12px]">
                  <div>{it.price_source === 'price_group' ? '价格组价' : it.price_source === 'member' ? '会员价' : it.price_source === 'promotion' ? '促销价' : '标准零售价'}</div>
                  <div className="text-slate-400">{it.price_trace || it.price_rule}</div>
                  {it.below_min === 1 && <div className="text-orange-600">低于限价</div>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Modal>
  )
}
