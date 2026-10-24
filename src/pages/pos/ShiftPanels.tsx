/**
 * ============================================================================
 * 文件标识：src/pages/pos/ShiftPanels.tsx ｜ ShiftPanels（页面，未取到标题）
 * ============================================================================
 * 【职责】ShiftPanels（页面，未取到标题）（页面）
 * 【入口】非菜单直挂（详情页 / 子页 / 登录页）
 * 【主要接口】/pos/shifts/open、/pos/daily-closes、/pos/daily-close、/pos/cash-drops/pending-shifts、/pos/cash-drops、/pos/stock-checks
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
 * 页面：ShiftPanels（页面，未取到标题）
 */

import { useEffect, useMemo, useState } from 'react'
import api from '../../api/client'
import { Modal, Empty, toast } from '../../components/ui'
import ScopeNotice, { type FetchFailure } from '../../components/ScopeNotice'
import { selectPosActions, type PosActionState } from '../../utils/pos-actions'
import { usePosPermissions, toFailure } from './usePosPermissions'
import {
  Banknote, Smartphone, CreditCard, Wallet, MoreHorizontal,
  RefreshCw, Lock, ClipboardCheck, RotateCcw, PackageMinus, ShieldCheck, Plus
} from 'lucide-react'

/**
 * 门店交班 / 缴款 / 退货盘点 三块面板。
 *
 * 为什么单独一个文件而不是塞进 PosApp：
 *   PosApp 是「收银台 + 触屏布局」，这里全是「后台核对动作」——
 *   前者给收银员用、卡的是手速，后者给店长用、卡的是**口径**。
 *   放一起会让「收银页越改越慢」和「核对页没人敢改」同时发生。
 *
 * 三条口径在前端也要保持一致，不能只写在服务端：
 *   ① 长短款 = 实点 − 系统应收（方向反了就变成"长款是问题、短款是正常"）
 *   ② **按支付方式拆开看**：现金差额是人的问题，移动支付差额是系统/网络问题
 *   ③ 备用金不参与长短款（它单列 `opening_float`）
 */

export const PAY_METHODS = [
  { key: 'cash', label: '现金', icon: Banknote },
  { key: 'wxpay', label: '微信', icon: Smartphone },
  { key: 'alipay', label: '支付宝', icon: CreditCard },
  { key: 'unionpay', label: '银联', icon: Wallet },
  { key: 'balance', label: '储值', icon: Wallet },
  { key: 'other', label: '其它', icon: MoreHorizontal }
] as const

export const PAY_LABEL: Record<string, string> = Object.fromEntries(PAY_METHODS.map((m) => [m.key, m.label]))

const money = (v: any) => `¥${Number(v || 0).toFixed(2)}`
/** 按钮被禁用时的可见原因（不只靠 title：触屏没有悬停） */
function Why({ a }: { a: PosActionState }) {
  return !a.enabled && a.reason ? <div role="note" data-testid="pos-action-reason" className="text-[11px] text-amber-700 mt-1 max-w-[260px]">{a.reason}</div> : null
}

/** 权限加载失败时的提示 + 重试（失败时所有受控按钮都被隐藏，必须给用户一条路） */
function PermRetry({ failed, retry }: { failed: boolean; retry: () => void }) {
  if (!failed) return null
  return (
    <div role="status" data-testid="pos-perms-failed" className="rounded-lg border border-amber-200 bg-amber-50 text-amber-800 text-[12px] p-2 mb-3">
      权限信息加载失败，相关操作按钮暂时隐藏（不代表没有权限）。<button className="underline ml-2" onClick={retry}>重试</button>
    </div>
  )
}

/** 差异着色沿用中国习惯：正数（长款）用红，负数（短款）用绿 —— 这里按"钱多了"标红提醒 */
const vColor = (v: number) => (Math.abs(v) < 0.005 ? 'text-slate-500' : v > 0 ? 'text-red-600' : 'text-emerald-600')

const SHIFT_STATUS: Record<string, { text: string; cls: string }> = {
  open: { text: '营业中', cls: 'bg-brand-50 text-brand-700 border-brand-600/30' },
  declared: { text: '已报数 · 待核款', cls: 'bg-amber-50 text-amber-700 border-amber-500/30' },
  closed: { text: '已核款', cls: 'bg-emerald-50 text-emerald-700 border-emerald-600/30' },
  cancelled: { text: '已作废', cls: 'bg-slate-100 text-slate-500 border-slate-300' }
}

const HANDLE_LABEL: Record<string, string> = {
  charge: '责任人承担',
  absorb: '公司承担',
  pending: '挂账待总部处理'
}

// ===========================================================================
// 一、交班核款中心：开班 → 报数 → 核款 → 长短款落案 → 日结
// ===========================================================================

export function ShiftCenter({ ctx, reloadCtx }: { ctx: any; reloadCtx: () => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [status, setStatus] = useState('')
  const [detail, setDetail] = useState<any>(null)
  const [modal, setModal] = useState<'' | 'open' | 'declare' | 'approve' | 'settle' | 'reject'>('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<FetchFailure>({})
  const { permissions, currentUser, failed: permsFailed, retry: retryPerms } = usePosPermissions()
  const act = selectPosActions({ permissions, currentUser })

  const load = () => {
    api
      .get('/pos/shifts', { status: status || '', pageSize: 60 })
      .then((r: any) => { setRows(r.data || r); setFailure({}) })
      .catch((e: any) => setFailure(toFailure(e)))
  }
  useEffect(() => { load() }, [status])

  const openDetail = async (id: number) => {
    try {
      const r: any = await api.get(`/pos/shifts/${id}`)
      setDetail(r.data || r)
    } catch (e: any) {
      setFailure(toFailure(e))
      toast(e.message || '加载失败', 'error')
    }
  }

  const after = async (msg: string) => {
    toast(msg)
    setModal('')
    load()
    reloadCtx()
    if (detail?.shift?.shift_id) await openDetail(detail.shift.shift_id)
  }

  const cur = ctx?.shift
  const sys = ctx?.shift_system
  const curAct = selectPosActions({ permissions, currentUser, shift: cur })

  return (
    <div className="p-3 h-full overflow-auto">
      <ScopeNotice failure={failure} loading={false} />
      <PermRetry failed={permsFailed} retry={retryPerms} />
      {/* 当前班次 */}
      <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="min-w-0">
            <div className="text-[13px] font-medium text-ink-900 title-serif">当前班次</div>
            {cur ? (
              <div className="text-[12px] text-slate-500 mt-1 leading-5">
                <span className="font-mono text-ink-900">{cur.doc_no}</span> · {cur.biz_date} ·{' '}
                {SHIFT_STATUS[cur.status]?.text || cur.status} · 备用金 {money(cur.opening_float)}
                <div className="text-[11px] text-slate-400">
                  本班订单 {sys?.order_count ?? 0} 单 · 系统应收 {money(sys?.order_amount)}{' '}
                  （现金 {money(sys?.sys_cash)}）
                </div>
              </div>
            ) : (
              <div className="text-[12px] text-slate-400 mt-1">
                当前没有营业中的班次。**开单必须先开班** —— 订单靠班次归属，
                没有班次的话这笔钱就不知道该算进谁的现金应收。
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {!cur && act.shift_open.visible && (
              <button className="btn-primary btn-sm" onClick={() => setModal('open')}>
                <Lock size={13} /> 开班
              </button>
            )}
            {cur?.status === 'open' && act.shift_declare.visible && (
              <button className="btn-primary btn-sm" onClick={() => setModal('declare')}>
                <ClipboardCheck size={13} /> 报数交班
              </button>
            )}
            {cur?.status === 'declared' && curAct.shift_approve.visible && (
              <div>
                <button className="btn-primary btn-sm" disabled={!curAct.shift_approve.enabled} title={curAct.shift_approve.reason || undefined}
                  onClick={() => openDetail(cur.id).then(() => setModal('approve'))}>
                  <ShieldCheck size={13} /> 核款
                </button>
                <Why a={curAct.shift_approve} />
              </div>
            )}
            <button className="btn-ghost btn-sm" onClick={() => { load(); reloadCtx(); retryPerms() }}>
              <RefreshCw size={13} /> 刷新
            </button>
          </div>
        </div>
      </div>

      {/* 日结上传（放在核款下面：核款是日结的前提，顺序不能反） */}
      <DailyCloseBlock ctx={ctx} permissions={permissions} currentUser={currentUser} />

      {/* 班次列表 */}
      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-paper border-b border-ink-100 flex items-center gap-2 flex-wrap">
          <span className="text-[12px] text-slate-500 mr-1">班次记录</span>
          {[['', '全部'], ['open', '营业中'], ['declared', '待核款'], ['closed', '已核款'], ['cancelled', '已作废']].map(([k, l]) => (
            <button
              key={k}
              onClick={() => setStatus(k)}
              className={`px-2 py-0.5 rounded text-[11px] border ${
                status === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'
              }`}
            >
              {l}
            </button>
          ))}
        </div>
        {rows.map((s) => {
          const st = SHIFT_STATUS[s.status] || { text: s.status, cls: 'bg-slate-100 text-slate-500 border-slate-300' }
          const v = Number(s.variance || 0)
          return (
            <button
              key={s.id}
              onClick={() => openDetail(s.id)}
              className="w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-paper flex items-center gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-mono text-ink-900">{s.doc_no || `#${s.id}`}</div>
                <div className="text-[11px] text-slate-400 truncate">
                  {s.biz_date} · {s.cashier_name || '—'} · {s.order_count ?? 0} 单 · 支付方式 {s.pay_method_count ?? 0} 种
                  {s.cash_drop_amount > 0 ? ` · 已缴 ${money(s.cash_drop_amount)}` : ''}
                </div>
              </div>
              {s.status === 'closed' && (
                <div className="text-right shrink-0">
                  <div className={`text-[12px] tabular-nums font-medium ${vColor(v)}`}>
                    {Math.abs(v) < 0.005 ? '持平' : `${v > 0 ? '长款' : '短款'} ${money(Math.abs(v))}`}
                  </div>
                  <div className="text-[11px] text-slate-400">{HANDLE_LABEL[s.variance_handled] || '—'}</div>
                </div>
              )}
              <span className={`text-[11px] px-2 py-0.5 rounded border shrink-0 ${st.cls}`}>{st.text}</span>
            </button>
          )
        })}
        {!rows.length && <Empty text="暂无班次" />}
      </div>

      <OpenShiftModal open={modal === 'open'} onClose={() => setModal('')} onDone={() => after('已开班')} />
      <DeclareModal
        open={modal === 'declare'}
        shift={cur}
        sys={sys}
        payMethods={ctx?.pay_methods || []}
        onClose={() => setModal('')}
        onDone={() => after('已报数交班，等待店长核款')}
      />
      <ApproveModal
        open={modal === 'approve'}
        detail={detail}
        onClose={() => setModal('')}
        onDone={() => after('核款完成')}
      />
      <Modal open={modal === 'reject'} title="退回重报" onClose={() => setModal('')}>
        <RejectForm
          busy={busy}
          onSubmit={async (remark: string) => {
            // 注意：不要在这里写可选链（`${a?.b}`）—— 契约漂移检查脚本按 `?` 切查询串，
            // 可选链会被当成查询参数切掉，表现为「前端调用未登记在 OpenAPI」的假报警。
            const sid = detail?.shift?.shift_id
            setBusy(true)
            try {
              await api.post(`/pos/shifts/${sid}/reject`, { remark })
              await after('已退回重报（该次报数明细已清空）')
            } catch (e: any) {
              toast(e.message || '操作失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        />
      </Modal>

      {detail && !modal && (
        <ShiftDetailModal
          detail={detail}
          onClose={() => setDetail(null)}
          onDeclare={() => setModal('declare')}
          onApprove={() => setModal('approve')}
          onReject={() => setModal('reject')}
          onSettle={() => setModal('settle')}
          onChanged={() => after('已处理')}
          permissions={permissions}
          currentUser={currentUser}
        />
      )}

      {detail && modal === 'settle' && (
        <SettleVarianceModal
          shift={detail.shift}
          onClose={() => setModal('')}
          onDone={() => after('已落案')}
        />
      )}
    </div>
  )
}

/** 开班 */
function OpenShiftModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => void }) {
  const [float, setFloat] = useState('200')
  const [device, setDevice] = useState('')
  const [bizDate, setBizDate] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={open} title="开班" onClose={onClose}>
      <div className="space-y-3">
        <div className="text-[12px] text-slate-500 leading-5">
          一次开一个钱箱。同一收银员同一天不能重复开班 —— 判据是<b>收银员</b>不是门店，
          一家店允许几个收银员各管一个钱箱。
        </div>
        <label className="block">
          <span className="text-[12px] text-slate-500">钱箱备用金（<b>不参与长短款</b>）</span>
          <input className="input mt-1" type="number" value={float} onChange={(e) => setFloat(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[12px] text-slate-500">营业日（留空取今天；营业日 ≠ 自然日）</span>
          <input className="input mt-1" placeholder="YYYY-MM-DD" value={bizDate} onChange={(e) => setBizDate(e.target.value)} />
        </label>
        <label className="block">
          <span className="text-[12px] text-slate-500">收银机编号</span>
          <input className="input mt-1" value={device} onChange={(e) => setDevice(e.target.value)} />
        </label>
        <button
          className="btn-primary w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.post('/pos/shifts/open', {
                opening_float: Number(float || 0),
                device_no: device || undefined,
                biz_date: bizDate || undefined
              })
              onDone()
            } catch (e: any) {
              toast(e.message || '开班失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '开班中…' : '确认开班'}
        </button>
      </div>
    </Modal>
  )
}

/** 报数交班：按支付方式逐项报数 */
function DeclareModal({
  open, onClose, onDone, shift, sys, payMethods
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
  shift: any
  sys: any
  payMethods: { code: string; label: string }[]
}) {
  const [vals, setVals] = useState<Record<string, string>>({})
  const [remark, setRemark] = useState('')
  const [busy, setBusy] = useState(false)

  const methods = payMethods.length ? payMethods : PAY_METHODS.map((m) => ({ code: m.key, label: m.label }))

  useEffect(() => {
    if (!open) return
    const init: Record<string, string> = {}
    for (const m of methods) {
      const amt = Number(sys?.byMethod?.[m.code]?.sys_amount || 0)
      if (amt !== 0) init[m.code] = String(amt)
    }
    setVals(init)
    setRemark('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const rows = methods
    .map((m) => {
      const sysAmt = Number(sys?.byMethod?.[m.code]?.sys_amount || 0)
      const typed = vals[m.code] === undefined || vals[m.code] === '' ? null : Number(vals[m.code])
      // **现金的差异在这一步恒为 0** —— 没人实点现金，报的就是系统应收。
      // 这里不显示现金差异列，是为了让"现金差额必须等核款"这件事在界面上也成立。
      const diff = m.code === 'cash' || typed === null ? null : typed - sysAmt
      return { ...m, sysAmt, typed, diff }
    })
    .filter((r) => r.sysAmt !== 0 || r.typed !== null)

  return (
    <Modal open={open} title="报数交班" onClose={onClose} width={760}>
      <div className="space-y-3">
        <div className="text-[12px] text-slate-500 leading-5">
          班次 <b className="font-mono">{shift?.doc_no}</b>。按支付方式逐项报数：
          <b>报数阶段现金差异恒为 0</b>（没人实点），非现金差异会立即成立 ——
          移动支付的差额是系统/网络问题，和现金差额（人的问题）必须分开看。
        </div>
        <div className="border border-ink-300 rounded overflow-hidden">
          <table className="w-full text-[12px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">支付方式</th>
                <th className="px-3 py-1.5 text-right font-medium">系统应收</th>
                <th className="px-3 py-1.5 text-right font-medium w-32">报数金额</th>
                <th className="px-3 py-1.5 text-right font-medium">差异</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.code} className="border-t border-ink-100">
                  <td className="px-3 py-1.5">{r.label}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{money(r.sysAmt)}</td>
                  <td className="px-3 py-1.5 text-right">
                    <input
                      className="input h-8 text-right tabular-nums"
                      type="number"
                      value={vals[r.code] ?? ''}
                      onChange={(e) => setVals((v) => ({ ...v, [r.code]: e.target.value }))}
                    />
                  </td>
                  <td className={`px-3 py-1.5 text-right tabular-nums ${r.diff === null ? 'text-slate-400' : vColor(r.diff)}`}>
                    {r.diff === null ? (r.code === 'cash' ? '— 待核款' : '—') : `${r.diff > 0 ? '+' : ''}${r.diff.toFixed(2)}`}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr><td colSpan={4} className="px-3 py-6 text-center text-slate-400">本班还没有任何订单</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <label className="block">
          <span className="text-[12px] text-slate-500">备注</span>
          <input className="input mt-1" value={remark} onChange={(e) => setRemark(e.target.value)} />
        </label>
        <button
          className="btn-primary w-full"
          disabled={busy || !shift}
          onClick={async () => {
            setBusy(true)
            try {
              const payments = Object.entries(vals)
                .filter(([, v]) => v !== '' && v !== undefined)
                .map(([method, declared_amount]) => ({ method, declared_amount: Number(declared_amount) }))
              await api.post(`/pos/shifts/${shift.id}/declare`, { payments, remark: remark || undefined })
              onDone()
            } catch (e: any) {
              toast(e.message || '报数失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '提交中…' : '确认交班'}
        </button>
      </div>
    </Modal>
  )
}

/** 核款：唯一算出长短款的动作 */
function ApproveModal({
  open, onClose, onDone, detail
}: {
  open: boolean
  onClose: () => void
  onDone: () => void
  detail: any
}) {
  const s = detail?.shift
  const limit = Number(detail?.variance_limit ?? 500)
  const [counted, setCounted] = useState('')
  const [note, setNote] = useState('')
  const [handled, setHandled] = useState('charge')
  const [floatBack, setFloatBack] = useState(true)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!open) return
    setCounted(String(Number(s?.declared_cash ?? s?.sys_cash ?? 0)))
    setNote(s?.variance_note || '')
    const d = Number(s?.declared_cash ?? 0) - Number(s?.sys_cash ?? 0)
    setHandled(Math.abs(d) > limit ? 'pending' : 'charge')
    setFloatBack(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const countedNum = Number(counted || 0)
  const sysCash = Number(s?.sys_cash || 0)
  // 长短款 = 实点 − 系统应收（方向写反就会把短款当成正常）
  const variance = countedNum - sysCash
  const over = Math.abs(variance) > limit
  const needNote = Math.abs(variance) >= 0.005

  return (
    <Modal open={open} title="核款（店长实点）" onClose={onClose} width={760}>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-2">
          {[
            ['系统应收现金', money(sysCash), '按本班订单汇总'],
            ['收银员报数', money(s?.declared_cash), '交班时填的'],
            ['店长实点', money(countedNum), '数钱为准']
          ].map(([l, v, d]) => (
            <div key={l} className="bg-paper border border-ink-300 rounded p-2.5">
              <div className="text-[11px] text-slate-400">{l}</div>
              <div className="text-[14px] font-medium tabular-nums text-ink-900">{v}</div>
              <div className="text-[10px] text-slate-400">{d}</div>
            </div>
          ))}
        </div>

        <label className="block">
          <span className="text-[12px] text-slate-500">实点现金（必填 —— 不填就等于让长短款凭空消失）</span>
          <input className="input mt-1" type="number" value={counted} onChange={(e) => setCounted(e.target.value)} />
        </label>

        <div className={`p-2.5 rounded border text-[12px] ${Math.abs(variance) < 0.005 ? 'bg-paper border-ink-300 text-slate-500' : 'bg-amber-50 border-amber-500/30 text-amber-700'}`}>
          {Math.abs(variance) < 0.005 ? (
            <>现金持平，无需说明。</>
          ) : (
            <>
              现金<b>{variance > 0 ? '长款' : '短款'}</b> <b className="tabular-nums">{money(Math.abs(variance))}</b>
              （实点 {money(countedNum)} − 系统应收 {money(sysCash)}）。
              {over && <span className="block mt-1 text-red-600">超过门店自结上限 {money(limit)}，必须挂账交总部处理。</span>}
            </>
          )}
        </div>

        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-[12px] text-slate-500">
            <input type="checkbox" checked={floatBack} onChange={(e) => setFloatBack(e.target.checked)} />
            备用金已归位（不勾则备用金留在实点里）
          </label>
        </div>

        {needNote && (
          <>
            <label className="block">
              <span className="text-[12px] text-slate-500">差异原因（有差异必填）</span>
              <input className="input mt-1" placeholder="如：找零差错 / 收款码未到账 / 顾客抹零" value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
            <label className="block">
              <span className="text-[12px] text-slate-500">归属（有差异必填）</span>
              <div className="grid grid-cols-3 gap-2 mt-1">
                {['charge', 'absorb', 'pending'].map((h) => {
                  const dis = over && h !== 'pending'
                  return (
                    <button
                      key={h}
                      disabled={dis}
                      onClick={() => setHandled(h)}
                      className={`py-1.5 rounded border text-[12px] ${
                        handled === h ? 'border-brand-600 text-brand-700 bg-brand-50' : 'border-ink-300 text-slate-500'
                      } ${dis ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      {HANDLE_LABEL[h]}
                    </button>
                  )
                })}
              </div>
            </label>
          </>
        )}

        <button
          className="btn-primary w-full"
          disabled={busy || counted === ''}
          onClick={async () => {
            if (needNote && !note.trim()) return toast('有差异必须填原因', 'error')
            setBusy(true)
            try {
              await api.post(`/pos/shifts/${s.shift_id}/approve`, {
                counted_cash: countedNum,
                variance_note: note || null,
                variance_handled: needNote ? handled : null,
                float_returned: floatBack
              })
              onDone()
            } catch (e: any) {
              toast(e.message || '核款失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '提交中…' : '确认核款'}
        </button>
      </div>
    </Modal>
  )
}

function RejectForm({ busy, onSubmit }: { busy: boolean; onSubmit: (remark: string) => void }) {
  const [remark, setRemark] = useState('')
  return (
    <div className="space-y-3">
      <div className="text-[12px] text-slate-500 leading-5">
        退回后该班次回到「营业中」，<b>本次报数明细会被清空</b> —— 不清干净下次核款就会拿旧数字。
      </div>
      <input className="input" placeholder="退回原因（必填）" value={remark} onChange={(e) => setRemark(e.target.value)} />
      <button className="btn-primary w-full" disabled={busy || !remark.trim()} onClick={() => onSubmit(remark)}>
        {busy ? '处理中…' : '确认退回'}
      </button>
    </div>
  )
}

/** 班次详情：三段钱 + 按支付方式的差异 + 关联订单 + 缴款。
 *
 *  ⚠️ 这里的动作按钮**不能顺手调 `onClose()`**。
 *  `onClose` 会把 `detail` 置空，而核款/落案弹窗正是从 `detail` 里取
 *  「系统应收 / 收银员报数 / 阈值」的 —— 清掉之后弹窗会显示一整套 **0.00**，
 *  并给出「现金持平，无需说明」的提示，于是店长会在一个假的"没问题"上按确认核款。
 *  这是一个**不会报错、界面看着完全正常**的失效（截图时才发现）。
 *  改成：详情弹窗在动作弹窗打开期间隐藏（`detail && !modal`），`detail` 一直留着。
 */
function ShiftDetailModal({
  detail, onClose, onDeclare, onApprove, onReject, onSettle, onChanged, permissions, currentUser
}: {
  detail: any
  onClose: () => void
  onDeclare: () => void
  onApprove: () => void
  onReject: () => void
  onSettle: () => void
  onChanged: () => void
  permissions: string[] | null
  currentUser: { id?: any; name?: any; username?: any } | null
}) {
  const s = detail.shift
  const v = Number(s.variance || 0)
  const act = selectPosActions({ permissions, currentUser, shift: s })

  return (
    <Modal open title={`班次 ${s.doc_no || s.shift_id}`} onClose={onClose} width={920}>
      <div className="space-y-3">
        <div className="flex items-center gap-2 flex-wrap text-[12px]">
          <span className={`px-2 py-0.5 rounded border ${(SHIFT_STATUS[s.status] || {}).cls || ''}`}>
            {(SHIFT_STATUS[s.status] || {}).text || s.status}
          </span>
          <span className="text-slate-400">{s.biz_date} · {s.cashier_name || '—'} · 收银机 {s.device_no || '—'}</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          {[
            ['系统应收（现金）', money(s.sys_cash), '按班次订单汇总'],
            ['收银员报数', money(s.declared_cash), '交班填的'],
            ['店长实点', money(s.counted_cash), '数钱为准'],
            ['长短款', Math.abs(v) < 0.005 ? '持平' : `${v > 0 ? '长款' : '短款'} ${money(Math.abs(v))}`, '实点 − 系统应收']
          ].map(([l, val, d], i) => (
            <div key={l} className="bg-paper border border-ink-300 rounded p-2.5">
              <div className="text-[11px] text-slate-400">{l}</div>
              <div className={`text-[14px] font-medium tabular-nums ${i === 3 ? vColor(v) : 'text-ink-900'}`}>{val}</div>
              <div className="text-[10px] text-slate-400">{d}</div>
            </div>
          ))}
        </div>

        {(s.variance_note || s.variance_handled) && (
          <div className="text-[12px] text-slate-500 bg-amber-50 border border-amber-500/30 rounded p-2.5">
            差异归于 <b>{HANDLE_LABEL[s.variance_handled] || '—'}</b>
            {s.variance_note ? `，原因：${s.variance_note}` : ''}
            {s.approved_by_name ? ` · 核款人 ${s.approved_by_name}` : ''}
          </div>
        )}

        {/* 按支付方式拆开的差异：现金 vs 非现金要分开看 */}
        <div className="border border-ink-300 rounded overflow-hidden">
          <div className="px-3 py-1.5 bg-paper text-[11px] text-slate-500 border-b border-ink-100">
            按支付方式拆分 —— <b>现金差额是人的问题，移动支付差额是系统/网络问题</b>，不能合并成一个数
          </div>
          <table className="w-full text-[12px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">支付方式</th>
                <th className="px-3 py-1.5 text-right font-medium">系统应收</th>
                <th className="px-3 py-1.5 text-right font-medium">报数</th>
                <th className="px-3 py-1.5 text-right font-medium">实点</th>
                <th className="px-3 py-1.5 text-right font-medium">差异</th>
              </tr>
            </thead>
            <tbody>
              {(detail.payments || []).map((p: any) => {
                const d = Number(p.diff || 0)
                return (
                  <tr key={p.id} className="border-t border-ink-100">
                    <td className="px-3 py-1.5">{PAY_LABEL[p.method] || p.method}{p.method === 'cash' ? '（数钱）' : ''}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(p.sys_amount)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{money(p.declared_amount)}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums">{s.counted_cash === null || s.counted_cash === undefined ? '—' : money(p.counted_amount)}</td>
                    <td className={`px-3 py-1.5 text-right tabular-nums ${vColor(d)}`}>
                      {Math.abs(d) < 0.005 ? '0.00' : `${d > 0 ? '+' : ''}${d.toFixed(2)}`}
                    </td>
                  </tr>
                )
              })}
              {!(detail.payments || []).length && (
                <tr><td colSpan={5} className="px-3 py-5 text-center text-slate-400">还没有报数明细</td></tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="grid grid-cols-2 gap-2 text-[12px]">
          <div className="bg-paper border border-ink-300 rounded p-2.5">
            <div className="text-slate-400 text-[11px] mb-1">本班有效订单</div>
            <div className="tabular-nums">{s.live_order_count ?? s.order_count ?? 0} 单 · {money(s.live_order_amount)}</div>
          </div>
          <div className="bg-paper border border-ink-300 rounded p-2.5">
            <div className="text-slate-400 text-[11px] mb-1">现金缴款</div>
            <div className="tabular-nums">
              {detail.cash_drop
                ? <>{detail.cash_drop.doc_no} · {money(detail.cash_drop.amount)} · {detail.cash_drop.drop_status === 'received' ? '已点收' : detail.cash_drop.drop_status === 'pending' ? '待点收' : '已取消'}</>
                : s.cash_drop_amount > 0 ? `已占用 ${money(s.cash_drop_amount)}` : '尚未缴款'}
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap pt-1">
          {s.status === 'open' && act.shift_declare.visible && <button className="btn-ghost btn-sm" onClick={onDeclare}>报数交班</button>}
          {s.status === 'declared' && act.shift_approve.visible && (
            <>
              <button className="btn-primary btn-sm" disabled={!act.shift_approve.enabled} title={act.shift_approve.reason || undefined} onClick={onApprove}>核款</button>
              <button className="btn-ghost btn-sm" disabled={!act.shift_reject.enabled} title={act.shift_reject.reason || undefined} onClick={onReject}>退回重报</button>
            </>
          )}
          {detail.can_settle && act.variance_settle.visible && (
            <button className="btn-primary btn-sm" onClick={onSettle}>长短款落案</button>
          )}
          {s.status !== 'closed' && s.status !== 'cancelled' && act.shift_cancel.visible && (
            <button
              className="btn-ghost btn-sm text-red-600 ml-auto"
              onClick={async () => {
                if (!confirm('作废该班次？有有效订单的班次不允许作废。')) return
                try {
                  await api.post(`/pos/shifts/${s.shift_id}/cancel`, {})
                  onClose()
                  onChanged()
                } catch (e: any) {
                  toast(e.message || '作废失败', 'error')
                }
              }}
            >
              作废班次
            </button>
          )}
        </div>
        {s.status === 'declared' && <Why a={act.shift_approve} />}
      </div>
    </Modal>
  )
}

/** 长短款落案（从详情弹窗独立出来：详情关掉之后它仍需要 detail 里的金额与班次号） */
function SettleVarianceModal({ shift, onClose, onDone }: { shift: any; onClose: () => void; onDone: () => void }) {
  const v = Number(shift?.variance || 0)
  const [handled, setHandled] = useState('charge')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <Modal open title="长短款落案" onClose={onClose} width={520}>
      <div className="space-y-3">
        <div className="text-[12px] text-slate-500 leading-5">
          <span className="font-mono text-ink-900">{shift?.doc_no}</span> 总额{' '}
          <b className={vColor(v)}>{v > 0 ? '长款' : '短款'} {money(Math.abs(v))}</b>。
          落案<b>不是状态流转</b> —— 班次已停在终态，这里只改归属并留痕。
        </div>
        <div className="grid grid-cols-2 gap-2">
          {['charge', 'absorb'].map((h) => (
            <button
              key={h}
              onClick={() => setHandled(h)}
              className={`py-2 rounded border text-[12px] ${handled === h ? 'border-brand-600 text-brand-700 bg-brand-50' : 'border-ink-300 text-slate-500'}`}
            >
              {HANDLE_LABEL[h]}
            </button>
          ))}
        </div>
        <input className="input" placeholder="落案说明" value={note} onChange={(e) => setNote(e.target.value)} />
        <button
          className="btn-primary w-full"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await api.post(`/pos/shifts/${shift.shift_id}/settle-variance`, { handled, note: note || null })
              onDone()
            } catch (e: any) {
              toast(e.message || '落案失败', 'error')
            } finally {
              setBusy(false)
            }
          }}
        >
          {busy ? '提交中…' : '确认落案'}
        </button>
      </div>
    </Modal>
  )
}

/** 日结上传（核款门禁在前） */
function DailyCloseBlock({ ctx, permissions, currentUser }: { ctx: any; permissions: string[] | null; currentUser: { id?: any; name?: any; username?: any } | null }) {
  const [closes, setCloses] = useState<any[]>([])
  const [result, setResult] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const load = () => api.get('/pos/daily-closes').then((r: any) => setCloses(r.data || r)).catch(() => {})
  useEffect(() => { load() }, [])
  const gate = ctx?.daily_close_gate
  const blocked = gate && gate.ok === false
  const dc = selectPosActions({ permissions, currentUser, dailyCloseGate: gate }).daily_close

  return (
    <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <div className="text-[13px] font-medium text-ink-900 title-serif">日结上传总部</div>
          <p className="text-[12px] text-slate-500 leading-5 mt-1">
            把本营业日的本地单打包上传：总部生成门店渠道销售单并<b>按批次先进先出扣门店仓库存</b>，同时落本日三段现金数。
            失败整体回滚。
          </p>
          {blocked && (
            <div className="text-[12px] text-amber-700 bg-amber-50 border border-amber-500/30 rounded px-2 py-1.5 mt-2">
              还有 <b>{gate.blocking?.length ?? 0}</b> 个班次未核款 —— 未核款不得日结（否则这段现金的去向在账上就没位置了）
            </div>
          )}
        </div>
        {dc.visible && <button className="btn-primary btn-sm shrink-0" disabled={busy || !dc.enabled} title={dc.reason || undefined} onClick={async () => {
          setBusy(true)
          try {
            const r: any = await api.post('/pos/daily-close', {})
            setResult(r.data)
            load()
          } catch (e: any) {
            toast(e.message || '日结失败', 'error')
          } finally {
            setBusy(false)
          }
        }}>
          {busy ? '上传中…' : '立即日结上传'}
        </button>}
      </div>

      {result && (
        <div className="mt-3 p-2.5 bg-brand-50 border border-brand-600/20 rounded text-[12px] text-brand-700">
          批次 <b>{result.batchNo}</b>：上传 {result.orderCount} 单 · 净额 {money(result.netAmount)} ·
          生成总部销售单 {result.soIds?.length} 张
        </div>
      )}

      {closes.length > 0 && (
        <div className="mt-3 border-t border-ink-100 pt-2">
          <div className="text-[11px] text-slate-400 mb-1">历史日结批次</div>
          {closes.slice(0, 6).map((c) => (
            <div key={c.id} className="flex items-center justify-between py-1 text-[12px]">
              <span className="font-mono text-ink-900">{c.batch_no}</span>
              <span className="text-slate-400 text-[11px]">
                {c.biz_date} · {c.uploaded_orders} 单 · 现金 系统 {money(c.sys_cash)} / 实点 {money(c.counted_cash)}
              </span>
              <span className="text-brand-700 tabular-nums">{money(c.net_amount)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ===========================================================================
// 二、缴款：一个班次只能缴一次，缴款人与接收人不能是同一人
// ===========================================================================

export function CashDropPanel() {
  const [pend, setPend] = useState<any[]>([])
  const [drops, setDrops] = useState<any[]>([])
  const [picked, setPicked] = useState<number[]>([])
  const [ref, setRef] = useState('')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<FetchFailure>({})
  const { permissions, currentUser, failed: permsFailed, retry: retryPerms } = usePosPermissions()
  const act = selectPosActions({ permissions, currentUser })

  const load = () => {
    api.get('/pos/cash-drops/pending-shifts').then((r: any) => { setPend(r.data || r); setFailure({}) }).catch((e: any) => setFailure(toFailure(e)))
    api.get('/pos/cash-drops').then((r: any) => setDrops(r.data || r)).catch((e: any) => setFailure(toFailure(e)))
  }
  useEffect(() => { load() }, [])

  const pickedRows = useMemo(() => pend.filter((p) => picked.includes(p.id)), [pend, picked])
  const pickedTotal = pickedRows.reduce(
    (s, p) => s + Math.max(0, Number(p.counted_cash || 0) - Number(p.cash_drop_amount || 0)),
    0
  )

  return (
    <div className="p-3 h-full overflow-auto">
      <ScopeNotice failure={failure} loading={false} />
      <PermRetry failed={permsFailed} retry={retryPerms} />
      <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
        <div className="text-[13px] font-medium text-ink-900 title-serif mb-1">现金缴款</div>
        <p className="text-[12px] text-slate-500 leading-5 mb-2">
          只对<b>已核款</b>的班次缴款；<b>一个班次只能缴一次</b>。点收时缴款人与接收人必须是两个人 ——
          钱从谁手里交到谁手里，账上要留两个名字。
        </p>
        {pend.length === 0 ? (
          <div className="text-[12px] text-slate-400 py-2">没有待缴款的班次</div>
        ) : (
          <>
            <div className="border border-ink-300 rounded overflow-hidden mb-2">
              {pend.map((p) => {
                const owe = Math.max(0, Number(p.counted_cash || 0) - Number(p.cash_drop_amount || 0))
                return (
                  <label key={p.id} className="flex items-center gap-2 px-3 py-1.5 border-b border-ink-100 last:border-0 text-[12px]">
                    <input
                      type="checkbox"
                      checked={picked.includes(p.id)}
                      onChange={(e) => setPicked((s) => (e.target.checked ? [...s, p.id] : s.filter((x) => x !== p.id)))}
                    />
                    <span className="font-mono text-ink-900">{p.doc_no}</span>
                    <span className="text-slate-400">{p.biz_date} · {p.cashier_name || '—'}</span>
                    <span className="ml-auto tabular-nums text-slate-500">待缴 {money(owe)}</span>
                  </label>
                )
              })}
            </div>
            <div className="flex items-center gap-2">
              <input className="input h-8 max-w-[200px]" placeholder="押运 / 银行凭据号" value={ref} onChange={(e) => setRef(e.target.value)} />
              <span className="text-[12px] text-slate-500">已选 {picked.length} 个班次 · 合计 <b className="text-brand-700 tabular-nums">{money(pickedTotal)}</b></span>
              {act.cashdrop_create.visible && <button
                className="btn-primary btn-sm ml-auto"
                disabled={busy || !picked.length}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.post('/pos/cash-drops', { shift_ids: picked, reference_no: ref || undefined })
                    setPicked([]); setRef('')
                    toast('缴款单已提交，等待总部点收')
                    load()
                  } catch (e: any) {
                    toast(e.message || '缴款失败', 'error')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                {busy ? '提交中…' : '生成缴款单'}
              </button>}
            </div>
          </>
        )}
      </div>

      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-paper text-[12px] text-slate-500 border-b border-ink-100">缴款记录</div>
        {drops.map((d) => (
          <div key={d.id} className="px-3 py-2 border-b border-ink-100 text-[12px]">
            <div className="flex items-center gap-3">
              <span className="font-mono text-ink-900">{d.doc_no}</span>
              <span className="text-slate-400">{d.drop_date} · {d.handed_by_name || '—'} 交</span>
              <span className="ml-auto tabular-nums font-medium text-brand-700">{money(d.amount)}</span>
              <span className={`text-[11px] px-2 py-0.5 rounded border ${
                d.status === 'received' ? 'bg-emerald-50 text-emerald-700 border-emerald-600/30'
                : d.status === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-500/30'
                : 'bg-slate-100 text-slate-500 border-slate-300'
              }`}>
                {d.status === 'received' ? '已点收' : d.status === 'pending' ? '待点收' : '已取消'}
              </span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {(d.items || []).map((i: any) => i.shift_no).join(' / ') || '—'}
              {d.received_by_name ? ` · 接收人 ${d.received_by_name}` : ''}
              {d.reference_no ? ` · 凭据 ${d.reference_no}` : ''}
            </div>
            {d.status === 'pending' && (() => {
              const da = selectPosActions({ permissions, currentUser, cashDrop: d })
              return (
              <div className="flex items-center gap-3 mt-1 flex-wrap">
                {da.cashdrop_receive.visible && <button
                  className="text-[11px] text-brand-700 disabled:opacity-50"
                  disabled={!da.cashdrop_receive.enabled}
                  title={da.cashdrop_receive.reason || undefined}
                  onClick={async () => {
                    try { await api.post(`/pos/cash-drops/${d.id}/receive`, {}); toast('已点收'); load() }
                    catch (e: any) { toast(e.message, 'error') }
                  }}
                >
                  总部点收
                </button>}
                {da.cashdrop_cancel.visible && <button
                  className="text-[11px] text-red-500"
                  onClick={async () => {
                    if (!confirm('取消该缴款单？会把班次已缴金额退回，钱重新回到待缴里。')) return
                    try { await api.post(`/pos/cash-drops/${d.id}/cancel`, {}); toast('已取消'); load() }
                    catch (e: any) { toast(e.message, 'error') }
                  }}
                >
                  取消
                </button>}
                <Why a={da.cashdrop_receive} />
              </div>
              )
            })()}
          </div>
        ))}
        {!drops.length && <Empty text="暂无缴款记录" />}
      </div>
    </div>
  )
}

// ===========================================================================
// 三、门店退货 + 门店盘点
// ===========================================================================

export function StoreOps({ ctx }: { ctx: any }) {
  const [tab, setTab] = useState<'return' | 'check'>('check')
  return (
    <div className="p-3 h-full overflow-auto">
      <div className="flex items-center gap-2 mb-3">
        {([['check', '门店盘点', ClipboardCheck], ['return', '门店退货', PackageMinus]] as const).map(([k, l, Icon]) => (
          <button
            key={k}
            onClick={() => setTab(k as any)}
            className={`px-3 py-1.5 rounded text-[12px] border flex items-center gap-1.5 ${
              tab === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'
            }`}
          >
            <Icon size={13} /> {l}
          </button>
        ))}
      </div>
      {tab === 'check' ? <StoreCheckPanel /> : <StoreReturnPanel ctx={ctx} />}
    </div>
  )
}

/** 门店盘点：建单 → 录实盘 → 过账（账面数一律取自库里） */
function StoreCheckPanel() {
  const [rows, setRows] = useState<any[]>([])
  const [detail, setDetail] = useState<any>(null)
  const [busy, setBusy] = useState(false)
  const [reason, setReason] = useState('')
  const [failure, setFailure] = useState<FetchFailure>({})
  const { permissions, currentUser, failed: permsFailed, retry: retryPerms } = usePosPermissions()
  const act = selectPosActions({ permissions, currentUser })

  const load = () => api.get('/pos/stock-checks').then((r: any) => { setRows(r.data || r); setFailure({}) }).catch((e: any) => setFailure(toFailure(e)))
  useEffect(() => { load() }, [])

  const openDetail = async (id: number) => {
    const r: any = await api.get(`/pos/stock-checks/${id}`)
    setDetail(r.data || r)
  }

  const setActual = (itemId: number, v: string) =>
    setDetail((d: any) => ({
      ...d,
      items: d.items.map((i: any) => (i.id === itemId ? { ...i, actual_qty: v, _diff: v === '' ? null : Number(v) - Number(i.book_qty) } : i))
    }))

  // 合计差异：已编辑的行用本地 `_diff`，未编辑的行要回退到服务端的 `diff_qty`。
  // 只认 `_diff` 的话，刚打开（还没动任何输入框）时合计恒为 0.00，
  // 而下面每一行的差异列又是对的 —— 表头与明细自相矛盾，且不会报错。
  const diffSum = (detail?.items || []).reduce(
    (s: number, i: any) => s + Number(i._diff ?? i.diff_qty ?? 0),
    0
  )

  return (
    <div className="space-y-3">
      <ScopeNotice failure={failure} loading={false} />
      <PermRetry failed={permsFailed} retry={retryPerms} />
      <div className="bg-white border border-ink-300 rounded-lg p-3">
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div>
            <div className="text-[13px] font-medium text-ink-900 title-serif">门店盘点</div>
            <p className="text-[12px] text-slate-500 leading-5 mt-1">
              建单时只带<b>账面数</b>，实盘数由店里录。<b>账面数一律从库里取</b>，
              前端传什么都不算 —— 否则把账面数报成实盘数就能让差异恒为 0，盘点单上完全看不出异常。
              过账是唯一动库存的动作（盘盈入库 / 盘亏出库）。
            </p>
          </div>
          {act.stock_check_create.visible && <button
            className="btn-primary btn-sm shrink-0"
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              try {
                const r: any = await api.post('/pos/stock-checks', {})
                toast('盘点单已建，去录实盘数')
                load()
                openDetail(r.data?.id ?? r.id)
              } catch (e: any) {
                toast(e.message || '建单失败', 'error')
              } finally {
                setBusy(false)
              }
            }}
          >
            <Plus size={13} /> 新建全盘单
          </button>}
        </div>
      </div>

      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-paper text-[12px] text-slate-500 border-b border-ink-100">盘点单</div>
        {rows.map((c) => (
          <button key={c.id} onClick={() => openDetail(c.id)} className="w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-paper text-[12px]">
            <div className="flex items-center gap-3">
              <span className="font-mono text-ink-900">{c.doc_no}</span>
              <span className="text-slate-400">{c.check_date} · {c.item_count} 行</span>
              <span className="ml-auto text-[11px] text-slate-500">
                {c.status === 'adjusted' ? '已过账' : c.status === 'counting' ? '盘点中' : c.status}
              </span>
              <span className={`text-[11px] ${c.diff_count > 0 ? 'text-amber-700' : 'text-slate-400'}`}>差异 {c.diff_count} 行</span>
            </div>
          </button>
        ))}
        {!rows.length && <Empty text="暂无盘点单" />}
      </div>

      {detail && (
        <Modal open title={`盘点单 ${detail.check.doc_no}`} onClose={() => setDetail(null)} width={920}>
          <div className="space-y-3">
            <div className="text-[12px] text-slate-500">
              {detail.check.check_date} · 仓 {detail.check.warehouse_id} · 状态 {detail.check.status}
              {detail.check.status !== 'adjusted' && <span className="ml-2 text-amber-700">合计差异 <b>{diffSum.toFixed(2)}</b></span>}
            </div>
            <div className="border border-ink-300 rounded overflow-hidden max-h-[50vh] overflow-y-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-paper text-slate-500 sticky top-0">
                  <tr>
                    <th className="px-3 py-1.5 text-left font-medium">商品</th>
                    <th className="px-3 py-1.5 text-left font-medium">批次</th>
                    <th className="px-3 py-1.5 text-right font-medium">账面</th>
                    <th className="px-3 py-1.5 text-right font-medium w-24">实盘</th>
                    <th className="px-3 py-1.5 text-right font-medium">差异</th>
                    <th className="px-3 py-1.5 text-left font-medium w-32">原因</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.items.map((i: any) => {
                    const d = i._diff ?? (i.diff_qty === null || i.diff_qty === undefined ? null : Number(i.diff_qty))
                    const locked = detail.check.status === 'adjusted'
                    return (
                      <tr key={i.id} className="border-t border-ink-100">
                        <td className="px-3 py-1.5 truncate max-w-[180px]">{i.product_name} <span className="text-slate-400">{i.sku_name}</span></td>
                        <td className="px-3 py-1.5 font-mono text-slate-500">{i.batch_no || '—'}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{i.book_qty}</td>
                        <td className="px-3 py-1.5 text-right">
                          {locked ? <span className="tabular-nums">{i.actual_qty}</span> : (
                            <input className="input h-7 text-right tabular-nums" type="number"
                              value={i.actual_qty ?? ''} onChange={(e) => setActual(i.id, e.target.value)} />
                          )}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${d && Math.abs(d) > 0.0001 ? 'text-amber-700' : 'text-slate-400'}`}>
                          {d === null ? '—' : d.toFixed(2)}
                        </td>
                        <td className="px-3 py-1.5">
                          {locked ? <span className="text-slate-400">{i.reason || '—'}</span> : (
                            <input className="input h-7" placeholder="如 破损/丢失" value={i.reason || ''}
                              onChange={(e) => setDetail((x: any) => ({ ...x, items: x.items.map((y: any) => (y.id === i.id ? { ...y, reason: e.target.value } : y)) }))} />
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
            {detail.check.status !== 'adjusted' && (act.stock_check_create.visible || act.stock_check_adjust.visible) && (
              <div className="flex items-center gap-2">
                <input className="input h-8 max-w-[220px]" placeholder="差异备注（可选）" value={reason} onChange={(e) => setReason(e.target.value)} />
                {act.stock_check_create.visible && <button
                  className="btn-ghost btn-sm"
                  disabled={busy}
                  onClick={async () => {
                    setBusy(true)
                    try {
                      await api.put(`/pos/stock-checks/${detail.check.id}/items`, {
                        items: detail.items.map((i: any) => ({ id: i.id, actual_qty: i.actual_qty === '' || i.actual_qty === null ? 0 : Number(i.actual_qty), reason: i.reason || undefined }))
                      })
                      toast('实盘数已保存')
                      load(); openDetail(detail.check.id)
                    } catch (e: any) { toast(e.message || '保存失败', 'error') } finally { setBusy(false) }
                  }}
                >
                  保存实盘数
                </button>}
                {act.stock_check_adjust.visible && <button
                  className="btn-primary btn-sm ml-auto"
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm('过账后将按差异调整门店仓库存（盘盈入库 / 盘亏出库），且不可再改。确认？')) return
                    setBusy(true)
                    try {
                      const r: any = await api.post(`/pos/stock-checks/${detail.check.id}/adjust`, {})
                      toast(`已过账，涉及 ${r.data?.adjusted ?? r.adjusted ?? 0} 行`)
                      setDetail(null); load()
                    } catch (e: any) { toast(e.message || '过账失败', 'error') } finally { setBusy(false) }
                  }}
                >
                  <ShieldCheck size={13} /> 过账调整库存
                </button>}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  )
}

/** 门店退货：货回门店仓（按当前成本价）+ 负数零售单冲减班次应收 */
function StoreReturnPanel({ ctx }: { ctx: any }) {
  const [kw, setKw] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [cart, setCart] = useState<any[]>([])
  const [rows, setRows] = useState<any[]>([])
  const [reason, setReason] = useState('')
  const [refund, setRefund] = useState('cash')
  const [busy, setBusy] = useState(false)

  const search = (q: string) => {
    setKw(q)
    api.get('/pos/products', { kw: q }).then((r: any) => setProducts(r.data || r)).catch(() => {})
  }
  const load = () => api.get('/pos/returns').then((r: any) => setRows(r.data || r)).catch(() => {})
  useEffect(() => { search(''); load() }, [])

  const add = (p: any) =>
    setCart((c) => (c.find((x) => x.sku_id === p.sku_id)
      ? c.map((x) => (x.sku_id === p.sku_id ? { ...x, qty: x.qty + 1 } : x))
      : [...c, { sku_id: p.sku_id, name: `${p.product_name} ${p.sku_name}`, qty: 1 }]))

  return (
    <div className="space-y-3">
      <div className="bg-white border border-ink-300 rounded-lg p-3">
        <div className="text-[13px] font-medium text-ink-900 title-serif">门店退货</div>
        <p className="text-[12px] text-slate-500 leading-5 mt-1 mb-2">
          货<b>回门店仓</b>、按门店仓<b>当前成本价</b>入库（不用售价 —— 用售价会让门店库存金额虚增一整块毛利），
          同时写一条负数零售单<b>冲减当前班次的系统应收</b>，所以退货会自然进入长短款口径。
        </p>
        <input className="input mb-2" placeholder="搜索要退的商品" value={kw} onChange={(e) => search(e.target.value)} />
        {products.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-1.5 max-h-40 overflow-y-auto mb-2">
            {products.slice(0, 24).map((p) => (
              <button key={p.sku_id} onClick={() => add(p)} className="text-left border border-ink-300 rounded px-2 py-1.5 text-[11px] hover:border-brand-600">
                <div className="truncate text-ink-900">{p.product_name}</div>
                <div className="text-slate-400 truncate">{p.sku_name}</div>
              </button>
            ))}
          </div>
        )}
        {cart.length > 0 && (
          <>
            <div className="border border-ink-300 rounded overflow-hidden mb-2">
              {cart.map((x) => (
                <div key={x.sku_id} className="flex items-center gap-2 px-2.5 py-1.5 border-b border-ink-100 last:border-0 text-[12px]">
                  <span className="flex-1 truncate">{x.name}</span>
                  <button className="w-6 h-6 rounded border border-ink-300" onClick={() => setCart((c) => c.map((y) => y.sku_id === x.sku_id ? { ...y, qty: Math.max(1, y.qty - 1) } : y))}>-</button>
                  <span className="w-6 text-center tabular-nums">{x.qty}</span>
                  <button className="w-6 h-6 rounded border border-ink-300" onClick={() => setCart((c) => c.map((y) => y.sku_id === x.sku_id ? { ...y, qty: y.qty + 1 } : y))}>+</button>
                  <button className="text-slate-300" onClick={() => setCart((c) => c.filter((y) => y.sku_id !== x.sku_id))}>×</button>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input className="input h-8 max-w-[200px]" placeholder="退货原因" value={reason} onChange={(e) => setReason(e.target.value)} />
              <select className="input h-8 max-w-[120px]" value={refund} onChange={(e) => setRefund(e.target.value)}>
                {PAY_METHODS.map((m) => <option key={m.key} value={m.key}>原路退回：{m.label}</option>)}
              </select>
              <button
                className="btn-primary btn-sm"
                disabled={busy || !ctx?.shift}
                title={!ctx?.shift ? '没有营业中班次，退货的钱冲减不到任何班次' : ''}
                onClick={async () => {
                  setBusy(true)
                  try {
                    await api.post('/pos/returns', {
                      items: cart.map((x) => ({ sku_id: x.sku_id, qty: x.qty })),
                      reason: reason || undefined,
                      refund_method: refund
                    })
                    toast('退货已登记，货已回门店仓')
                    setCart([]); setReason('')
                    load()
                  } catch (e: any) {
                    toast(e.message || '退货失败', 'error')
                  } finally {
                    setBusy(false)
                  }
                }}
              >
                <RotateCcw size={13} /> 确认退货
              </button>
              {!ctx?.shift && <span className="text-[11px] text-amber-700">当前没有营业中班次，退货冲减不到班次应收</span>}
            </div>
          </>
        )}
      </div>

      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <div className="px-3 py-2 bg-paper text-[12px] text-slate-500 border-b border-ink-100">退货记录</div>
        {rows.map((t) => (
          <div key={t.id} className="px-3 py-2 border-b border-ink-100 flex items-center gap-3 text-[12px]">
            <span className="font-mono text-ink-900">{t.doc_no}</span>
            <span className="text-slate-400 truncate">{t.return_date} · {t.item_count} 行 · {t.reason || '—'}</span>
            <span className="ml-auto text-brand-700 tabular-nums">{money(t.total_amount)}</span>
          </div>
        ))}
        {!rows.length && <Empty text="暂无退货记录" />}
      </div>
    </div>
  )
}
