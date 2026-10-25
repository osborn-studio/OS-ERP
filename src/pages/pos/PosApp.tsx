/**
 * ============================================================================
 * 文件标识：src/pages/pos/PosApp.tsx ｜ PosApp（页面，未取到标题）
 * ============================================================================
 * 【职责】PosApp（页面，未取到标题）（页面）
 * 【入口】/pos
 * 【主要接口】/auth/login、/pos/context、/pos/products、/pos/quote、/pos/orders、/pos/stocks
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
 * 页面：PosApp（页面，未取到标题）
 */

import { useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import api, { getUser } from '../../api/client'
import { useAuth } from '../../store/auth'
import { useRuntimeCapabilities } from '../../store/runtime-capabilities'
import { CapabilityStatus } from '../../components/CapabilityGate'
import {
  Search, ShoppingBag, Package, LogOut, ClipboardList, Warehouse,
  Upload, Plus, Minus, Trash2, User, Inbox,
  ClipboardCheck, Banknote, PackageMinus
} from 'lucide-react'
import { PAY_METHODS, ShiftCenter, CashDropPanel, StoreOps } from './ShiftPanels'
import { ScopeBlocked, isBlocked, type FetchFailure } from '../../components/ScopeNotice'
import { toFailure, usePosPermissions } from './usePosPermissions'
import { selectPosActions } from '../../utils/pos-actions'

/** 依赖 /pos/context（需要 pos.view）的页签；库存 / 要货 / 收货 / 缴款 / 订单各有自己的权限点与失败提示，不能被 context 的 403 一并挡掉 */
const CTX_TABS: string[] = ['cash', 'shift', 'storeop']

/** 门店 POS 收银：独立触屏界面，本地单 + 日结上传总部 */
export default function PosApp() {
  const nav = useNavigate()
  const { token, user, login: authenticate, logout, sessionNotice } = useAuth()
  const { isDemo } = useRuntimeCapabilities()
  const [ctx, setCtx] = useState<any>(null)
  const [ctxFailure, setCtxFailure] = useState<FetchFailure>({})
  const [sp] = useSearchParams()
  // 支持 /pos?tab=receive 直达指定页签（演示 / 分享链接）。
  // `close` 是老链接里的「日结上传」——批次 E 之后日结并入「交班核款」，
  // 这里保留别名做重定向，否则书签和截图脚本会打到一个空页签上。
  const TAB_KEYS = ['cash', 'shift', 'drop', 'storeop', 'stock', 'requisition', 'receive', 'orders'] as const
  type TabKey = (typeof TAB_KEYS)[number]
  const initialTab = ((): TabKey => {
    const t = sp.get('tab') || ''
    if (t === 'close') return 'shift'
    return (TAB_KEYS as readonly string[]).includes(t) ? (t as TabKey) : 'cash'
  })()
  const [tab, setTab] = useState<TabKey>(initialTab)

  // 登录态
  const [u, setU] = useState('')
  const [p, setP] = useState('')
  const [loginErr, setLoginErr] = useState('')

  const login = async () => {
    try {
      await authenticate(u, p)
      setP('')
      setLoginErr('')
    } catch (e: any) {
      setLoginErr(e.message || '登录失败')
    }
  }

  useEffect(() => {
    if (!token) return
    api.get('/pos/context').then((r: any) => { setCtx(r.data || r); setCtxFailure({}) }).catch((e: any) => setCtxFailure(toFailure(e)))
  }, [token])

  if (!token || !user) {
    return (
      <div className="min-h-screen bg-paper flex items-center justify-center p-4">
        <div className="w-full max-w-sm bg-white rounded-xl border border-ink-300 p-6 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <div className="w-8 h-8 rounded-lg bg-brand-700 text-white flex items-center justify-center font-medium">P</div>
            <div className="text-[15px] font-medium text-ink-900 title-serif">门店收银 POS</div>
          </div>
          <p className="text-[12px] text-slate-400 mb-5">请使用门店店员账号登录{isDemo && '（演示：store01 ~ store05 / 123456）'}</p>
          <CapabilityStatus />
          <input className="input mb-2" placeholder="账号" value={u} onChange={(e) => setU(e.target.value)} autoFocus />
          <input className="input mb-3" type="password" placeholder="密码" value={p}
            onChange={(e) => setP(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && login()} />
          {sessionNotice && <p role="status" className="mb-3 text-sm text-amber-700">{sessionNotice}</p>}
          {loginErr && <div className="text-[12px] text-red-500 mb-2">{loginErr}</div>}
          <button className="btn-primary w-full" onClick={login} disabled={!u || !p}>登录</button>
          <button className="btn-ghost w-full mt-2" onClick={() => nav('/login')}>总部管理后台入口</button>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-paper flex flex-col">
      {/* 顶栏 */}
      <header className="h-13 bg-brand-800 text-white flex items-center justify-between px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <div className="w-7 h-7 rounded bg-white/15 flex items-center justify-center text-[12px] shrink-0">P</div>
          <div className="min-w-0">
            <div className="text-[13px] font-medium truncate">{ctx?.store?.name || '门店'}</div>
            <div className="text-[11px] text-white/60 truncate">
              {user?.name} · {ctx?.warehouse?.name || '—'}
              {ctx?.shift ? ' · 营业中' : ' · 未开班'}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-white/70 tabular-nums">待上传 {ctx?.local_orders ?? 0} 单</span>
          <button className="text-[12px] px-2 py-1 rounded bg-white/15 hover:bg-white/25"
            onClick={() => nav('/login')}>后台</button>
          <button className="text-white/70 px-1"
            aria-label="退出全部后台会话" onClick={() => { void logout() }}>
            <LogOut size={15} />
          </button>
        </div>
      </header>

      {/* 内容区 */}
      <div className="flex-1 overflow-hidden">
        {isBlocked(ctxFailure) && CTX_TABS.includes(tab) && (
          <div className="p-3">
            <ScopeBlocked failure={ctxFailure} onRetry={() => api.get('/pos/context').then((r: any) => { setCtx(r.data || r); setCtxFailure({}) }).catch((e: any) => setCtxFailure(toFailure(e)))} />
          </div>
        )}
        {!(isBlocked(ctxFailure) && CTX_TABS.includes(tab)) && <>
        {tab === 'cash' && <Cashier ctx={ctx} onSynced={() => api.get('/pos/context').then((r: any) => setCtx(r.data || r))} />}
        {tab === 'shift' && <ShiftCenter ctx={ctx} reloadCtx={() => api.get('/pos/context').then((r: any) => setCtx(r.data || r)).catch(() => {})} />}
        {tab === 'drop' && <CashDropPanel />}
        {tab === 'storeop' && <StoreOps ctx={ctx} />}
        {tab === 'stock' && <StoreStock />}
        {tab === 'requisition' && <StoreRequisition />}
        {tab === 'receive' && <StoreReceive />}
        {tab === 'orders' && <LocalOrders />}
        </>}
      </div>

      {/* 底部 Tab（触屏友好）。8 个页签在手机宽度下放不下 —— 横向可滚，
          而不是缩成谁也点不准的 4px 间隙。 */}
      <nav className="bg-white border-t border-ink-300 flex shrink-0 overflow-x-auto">
        {([
          ['cash', '收银', ShoppingBag],
          ['shift', '交班核款', ClipboardCheck],
          ['drop', '缴款', Banknote],
          ['storeop', '退货盘点', PackageMinus],
          ['stock', '店内库存', Warehouse],
          ['requisition', '要货申请', Package],
          ['receive', '门店收货', Inbox],
          ['orders', '本机单据', ClipboardList]
        ] as const).map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k as any)}
            className={`flex-1 min-w-[72px] py-2.5 flex flex-col items-center gap-0.5 text-[11px] whitespace-nowrap ${tab === k ? 'text-brand-700 font-medium' : 'text-slate-400'}`}>
            <Icon size={18} />
            {label}
          </button>
        ))}
      </nav>
    </div>
  )
}

/** 收银台 */
function Cashier({ ctx, onSynced }: { ctx: any; onSynced: () => void }) {
  const [kw, setKw] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [cart, setCart] = useState<any[]>([])
  const [member, setMember] = useState('')
  const [pay, setPay] = useState('wxpay')
  const [discount, setDiscount] = useState(0)
  const [busy, setBusy] = useState(false)
  const [lastOrder, setLastOrder] = useState<any>(null)

  const search = (q: string) => {
    setKw(q)
    api.get('/pos/products', { kw: q }).then((r: any) => setProducts(r.data || r)).catch(() => {})
  }
  useEffect(() => { search('') }, [])

  const add = (p: any) => {
    const price = member && p.price_member ? p.price_member : p.price_retail
    setCart((c) => {
      const hit = c.find((x) => x.sku_id === p.sku_id)
      if (hit) return c.map((x) => (x.sku_id === p.sku_id ? { ...x, qty: x.qty + 1, amount: (x.qty + 1) * price } : x))
      return [...c, { sku_id: p.sku_id, sku_code: p.sku_code, name: `${p.product_name} ${p.sku_name}`, spec: p.spec, price, qty: 1, amount: price, store_stock: p.store_stock }]
    })
  }
  const changeQty = (id: number, d: number) =>
    setCart((c) => c.map((x) => (x.sku_id === id ? { ...x, qty: x.qty + d, amount: (x.qty + d) * x.price } : x)).filter((x) => x.qty > 0))

  const totalQty = cart.reduce((s, x) => s + x.qty, 0)
  const totalAmount = cart.reduce((s, x) => s + x.amount, 0)

  // 应收**不由前端算**：向服务端要试算（与落单同一份算钱判据）——
  // 会员等级折扣 / 活动 / 券 / 积分都在那儿推导。
  const [q, setQ] = useState<any>(null)
  const itemsKey = JSON.stringify(cart.map((x) => ({ sku_id: x.sku_id, qty: x.qty })))
  useEffect(() => {
    if (!cart.length) { setQ(null); return }
    api.post('/pos/quote', {
      items: JSON.parse(itemsKey),
      member_phone: member || undefined,
      discount_amount: Number(discount || 0)
    }).then((r: any) => setQ(r.data || r)).catch(() => setQ(null))
  }, [itemsKey, member, discount])

  const payAmount = q?.pay_amount ?? Math.max(0, totalAmount - Number(discount || 0))

  const submit = async () => {
    if (!cart.length) return
    setBusy(true)
    try {
      const res: any = await api.post('/pos/orders', {
        items: cart.map((x) => ({ sku_id: x.sku_id, qty: x.qty })),
        member_phone: member || undefined,
        pay_method: pay,
        // 手工让利（店长现场决定）与营销优惠并存；营销那部分由服务端推导并留痕
        discount_amount: Number(discount || 0)
      })
      setLastOrder({ ...res.data, items: cart })
      setCart([])
      setDiscount(0)
      setMember('')
      onSynced()
      search('')
    } catch (e: any) {
      alert(e.message || '开单失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* 左：商品选择 */}
      <div className="flex-1 flex flex-col min-w-0 border-r border-ink-300">
        <div className="p-2.5 bg-white border-b border-ink-300">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" placeholder="扫码或输入商品名称 / 条码 / 编码" value={kw}
              onChange={(e) => search(e.target.value)} autoFocus />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2.5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 content-start">
          {products.map((p) => (
            <button key={p.sku_id} onClick={() => add(p)}
              className="bg-white border border-ink-300 rounded-lg p-2.5 text-left hover:border-brand-600 hover:shadow-sm transition">
              <div className="text-[12px] font-medium text-ink-900 line-clamp-2 min-h-[32px]">{p.product_name}</div>
              <div className="text-[11px] text-slate-400 truncate">{p.sku_name}</div>
              <div className="flex items-end justify-between mt-1.5">
                <span className="text-[14px] font-medium text-brand-700 tabular-nums">¥{p.price_retail}</span>
                <span className="text-[10px] text-slate-400 tabular-nums">库存 {p.store_stock ?? 0}</span>
              </div>
            </button>
          ))}
          {!products.length && <div className="col-span-full text-center text-[12px] text-slate-400 py-10">未找到商品</div>}
        </div>
      </div>

      {/* 右：购物车与结算 */}
      <div className="w-full lg:w-[330px] xl:w-[380px] bg-white flex flex-col shrink-0 max-h-[50vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-ink-300">
          <div className="relative">
            <User size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-8 h-9" placeholder="会员手机号（可享会员价）" value={member}
              onChange={(e) => setMember(e.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-auto">
          {cart.length === 0 && <div className="text-center text-[12px] text-slate-400 py-10">点击左侧商品加入购物车</div>}
          {cart.map((x) => (
            <div key={x.sku_id} className="px-3 py-2 border-b border-ink-100 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink-900 truncate">{x.name}</div>
                <div className="text-[11px] text-slate-400 tabular-nums">¥{x.price} × {x.qty}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
                  onClick={() => changeQty(x.sku_id, -1)}><Minus size={12} /></button>
                <span className="w-6 text-center text-[12px] tabular-nums">{x.qty}</span>
                <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
                  onClick={() => changeQty(x.sku_id, 1)}><Plus size={12} /></button>
                <button className="w-6 h-6 text-slate-300 hover:text-red-500"
                  onClick={() => setCart((c) => c.filter((i) => i.sku_id !== x.sku_id))}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-ink-300 p-3">
          <div className="flex items-center justify-between text-[12px] text-slate-500 mb-1.5">
            <span>共 {totalQty} 件</span>
            <span>合计 <b className="text-[15px] text-brand-700 tabular-nums">¥{totalAmount.toFixed(2)}</b></span>
          </div>
          {/* 优惠拆段显示：会员折扣 / 活动 / 积分 由服务端推导，手工让利是收银员当场输入的 */}
          {q && (q.member_discount > 0 || q.promotion_discount > 0 || q.points_discount > 0) && (
            <div className="text-[11px] text-brand-700 space-y-0.5 mb-1.5">
              {q.member_discount > 0 && <div className="flex justify-between"><span>会员折扣{q.member?.level_name ? `（${q.member.level_name}）` : ''}</span><span className="tabular-nums">-¥{q.member_discount.toFixed(2)}</span></div>}
              {q.promotion_discount > 0 && <div className="flex justify-between"><span>活动优惠{q.applied_codes?.length ? `（${q.applied_codes.join('、')}）` : ''}</span><span className="tabular-nums">-¥{q.promotion_discount.toFixed(2)}</span></div>}
              {q.points_discount > 0 && <div className="flex justify-between"><span>积分抵现（{q.points_used} 分）</span><span className="tabular-nums">-¥{q.points_discount.toFixed(2)}</span></div>}
            </div>
          )}
          <div className="flex items-center gap-2 mb-2">
            <span className="text-[12px] text-slate-500">手工让利</span>
            <input className="input h-8 w-24" type="number" value={discount || ''} placeholder="0"
              onChange={(e) => setDiscount(Number(e.target.value))} />
            <span className="text-[12px] text-slate-500 ml-auto">应收 <b className="text-brand-700 tabular-nums">¥{payAmount.toFixed(2)}</b></span>
          </div>
          {q?.over_discounted && (
            <div className="text-[10px] text-amber-600 mb-1.5">手工让利已超过结算后应付，将按 ¥0 收取（差额会写进单据备注）</div>
          )}
          <div className="grid grid-cols-5 gap-1 mb-2">
            {PAY_METHODS.map((m) => {
              const Icon = m.icon
              return (
                <button key={m.key} onClick={() => setPay(m.key)}
                  className={`py-1.5 rounded border text-[11px] flex flex-col items-center gap-0.5 ${pay === m.key ? 'border-brand-600 text-brand-700 bg-brand-50' : 'border-ink-300 text-slate-500'}`}>
                  <Icon size={14} />{m.label}
                </button>
              )
            })}
          </div>
          <button className="btn-primary w-full" disabled={!cart.length || busy} onClick={submit}>
            {busy ? '提交中…' : `收款 ¥${payAmount.toFixed(2)}`}
          </button>
          {lastOrder && (
            <div className="mt-2 p-2 bg-brand-50 border border-brand-600/20 rounded text-[11px] text-brand-700">
              已开单 {lastOrder.doc_no} · ¥{lastOrder.pay_amount}（本机单，日结时上传总部）
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

/** 门店库存 */
function StoreStock() {
  const [rows, setRows] = useState<any[]>([])
  const [kw, setKw] = useState('')
  useEffect(() => { api.get('/pos/stocks').then((r: any) => setRows(r.data || r)).catch(() => {}) }, [])
  const list = useMemo(() => (kw ? rows.filter((r) => `${r.product_name}${r.sku_code}`.includes(kw)) : rows), [kw, rows])
  return (
    <div className="p-3 h-full overflow-auto">
      <div className="flex items-center gap-2 mb-2.5">
        <input className="input max-w-xs" placeholder="搜索商品" value={kw} onChange={(e) => setKw(e.target.value)} />
        <span className="text-[12px] text-slate-400">共 {list.length} 个批次 · 本店仓实际库存</span>
      </div>
      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead className="bg-paper text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left font-medium">商品</th>
                <th className="px-3 py-2 text-left font-medium">SKU</th>
                <th className="px-3 py-2 text-left font-medium">批次</th>
                <th className="px-3 py-2 text-right font-medium">现存</th>
                <th className="px-3 py-2 text-right font-medium">可用</th>
                <th className="px-3 py-2 text-left font-medium">到期日</th>
              </tr>
            </thead>
            <tbody>
              {list.map((r, i) => (
                <tr key={i} className="border-t border-ink-100">
                  <td className="px-3 py-1.5">{r.product_name} <span className="text-slate-400">{r.sku_name}</span></td>
                  <td className="px-3 py-1.5 font-mono text-slate-500">{r.sku_code}</td>
                  <td className="px-3 py-1.5 font-mono text-slate-500">{r.batch_no}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums">{r.qty_on_hand}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-brand-700">{r.qty_available}</td>
                  <td className="px-3 py-1.5 text-slate-500">{r.expire_date || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

/** 本机单据 */
function LocalOrders() {
  const { permissions, currentUser } = usePosPermissions()
  const canVoid = selectPosActions({ permissions, currentUser }).order_void.visible
  const [rows, setRows] = useState<any[]>([])
  const [status, setStatus] = useState('local')
  const load = () => api.get('/pos/orders', { status }).then((r: any) => setRows(r.data || r)).catch(() => {})
  useEffect(() => { load() }, [status])
  const voidOrder = async (id: number) => {
    try { await api.post(`/pos/orders/${id}/void`, {}); load() } catch (e: any) { alert(e.message) }
  }
  return (
    <div className="p-3 h-full overflow-auto">
      <div className="flex items-center gap-2 mb-2.5">
        {[['local', '本机未上传'], ['synced', '已上传总部'], ['voided', '已作废']].map(([k, l]) => (
          <button key={k} onClick={() => setStatus(k)}
            className={`px-3 py-1 rounded text-[12px] border ${status === k ? 'bg-brand-700 text-white border-brand-700' : 'bg-white border-ink-300 text-slate-500'}`}>{l}</button>
        ))}
      </div>
      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        {rows.map((r) => (
          <div key={r.id} className="px-3 py-2 border-b border-ink-100 flex items-center gap-3 text-[12px]">
            <div className="flex-1 min-w-0">
              <div className="font-mono text-ink-900">{r.doc_no}</div>
              <div className="text-[11px] text-slate-400">
                {r.biz_date} · {r.item_count} 件 · {r.member_phone ? `会员 ${r.member_phone}` : '散客'}
                {r.sync_batch ? ` · 批次 ${r.sync_batch}` : ''}
              </div>
            </div>
            <div className="text-right">
              <div className="text-brand-700 font-medium tabular-nums">¥{r.pay_amount}</div>
              <div className="text-[11px] text-slate-400">{PAY_METHODS.find((m) => m.key === r.pay_method)?.label}</div>
            </div>
            {r.status === 'local' && canVoid && (
              <button className="text-[11px] text-red-500" onClick={() => voidOrder(r.id)}>作废</button>
            )}
          </div>
        ))}
        {!rows.length && <div className="text-center text-[12px] text-slate-400 py-10">暂无单据</div>}
      </div>
    </div>
  )
}

/** 门店向总部要货（补货申请 → 总部受理 → 转采购 / 配货调拨） */
function StoreRequisition() {
  const [kw, setKw] = useState('')
  const [products, setProducts] = useState<any[]>([])
  const [cart, setCart] = useState<any[]>([])
  const [myReqs, setMyReqs] = useState<any[]>([])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')
  const [urgency, setUrgency] = useState('normal')

  const search = (q: string) => {
    setKw(q)
    api.get('/pos/products', { kw: q }).then((r: any) => setProducts(r.data || r)).catch(() => {})
  }
  const loadMine = () => api.get('/requisitions/store/mine').then((r: any) => setMyReqs(r.data || r)).catch(() => {})
  useEffect(() => {
    search('')
    loadMine()
  }, [])

  const add = (p: any) =>
    setCart((c) => {
      const hit = c.find((x) => x.sku_id === p.sku_id)
      if (hit) return c.map((x) => (x.sku_id === p.sku_id ? { ...x, qty: x.qty + 5 } : x))
      return [...c, { sku_id: p.sku_id, name: `${p.product_name} ${p.sku_name}`, sku_code: p.sku_code, qty: 10, store_stock: p.store_stock }]
    })
  const setQty = (id: number, q: number) =>
    setCart((c) => c.map((x) => (x.sku_id === id ? { ...x, qty: q } : x)))

  const submit = async () => {
    const items = cart.filter((x) => x.qty > 0).map((x) => ({ sku_id: x.sku_id, qty: x.qty }))
    if (!items.length) return
    setBusy(true)
    try {
      const r: any = await api.post('/requisitions/store', { items, urgency })
      setMsg(`要货单 ${r.data?.doc_no} 已提交，等待总部受理`)
      setCart([])
      loadMine()
    } catch (e: any) {
      setMsg(e.message || '提交失败')
    } finally {
      setBusy(false)
    }
  }

  const STATUS_TEXT: Record<string, string> = {
    submitted: '待受理', processing: '处理中', transferred: '已转采购',
    allocated: '已配货', completed: '已完成', rejected: '已驳回', cancelled: '已取消'
  }

  return (
    <div className="flex flex-col lg:flex-row h-full">
      <div className="flex-1 flex flex-col min-w-0 border-r border-ink-300">
        <div className="p-2.5 bg-white border-b border-ink-300">
          <div className="relative">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
            <input className="input pl-9" placeholder="搜索要货商品（名称 / 条码 / 编码）" value={kw}
              onChange={(e) => search(e.target.value)} />
          </div>
        </div>
        <div className="flex-1 overflow-auto p-2.5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2 content-start">
          {products.map((p) => (
            <button key={p.sku_id} onClick={() => add(p)}
              className="bg-white border border-ink-300 rounded-lg p-2.5 text-left hover:border-brand-600 hover:shadow-sm transition">
              <div className="text-[12px] font-medium text-ink-900 line-clamp-2 min-h-[32px]">{p.product_name}</div>
              <div className="text-[11px] text-slate-400 truncate">{p.sku_name}</div>
              <div className="text-[10px] text-slate-400 tabular-nums mt-1.5">店内现存 {p.store_stock ?? 0}</div>
            </button>
          ))}
          {!products.length && <div className="col-span-full text-center text-[12px] text-slate-400 py-10">未找到商品</div>}
        </div>
      </div>

      <div className="w-full lg:w-[340px] xl:w-[390px] bg-white flex flex-col shrink-0 max-h-[50vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-ink-300 flex items-center justify-between">
          <div className="text-[13px] font-medium text-ink-900 title-serif">要货清单</div>
          <select className="input h-8 w-24 text-[12px]" value={urgency} onChange={(e) => setUrgency(e.target.value)}>
            <option value="normal">正常</option>
            <option value="urgent">紧急</option>
          </select>
        </div>
        <div className="flex-1 overflow-auto">
          {cart.length === 0 && <div className="text-center text-[12px] text-slate-400 py-8">点击左侧商品加入要货清单</div>}
          {cart.map((x) => (
            <div key={x.sku_id} className="px-3 py-2 border-b border-ink-100 flex items-center gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] text-ink-900 truncate">{x.name}</div>
                <div className="text-[11px] text-slate-400 font-mono">{x.sku_code}</div>
              </div>
              <div className="flex items-center gap-1">
                <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
                  onClick={() => setQty(x.sku_id, Math.max(1, x.qty - 5))}><Minus size={12} /></button>
                <input className="w-12 h-6 text-center text-[12px] border border-ink-300 rounded tabular-nums" value={x.qty}
                  onChange={(e) => setQty(x.sku_id, Number(e.target.value) || 0)} />
                <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
                  onClick={() => setQty(x.sku_id, x.qty + 5)}><Plus size={12} /></button>
                <button className="w-6 h-6 text-slate-300 hover:text-red-500"
                  onClick={() => setCart((c) => c.filter((i) => i.sku_id !== x.sku_id))}><Trash2 size={13} /></button>
              </div>
            </div>
          ))}
        </div>
        <div className="border-t border-ink-300 p-3">
          <div className="text-[12px] text-slate-500 mb-2 tabular-nums">
            共 {cart.length} 个 SKU / {cart.reduce((s, x) => s + Number(x.qty || 0), 0)} 件
          </div>
          <button className="btn-primary w-full" disabled={!cart.length || busy} onClick={submit}>
            {busy ? '提交中…' : '提交要货申请'}
          </button>
          {msg && <div className="mt-2 p-2 bg-brand-50 border border-brand-600/20 rounded text-[11px] text-brand-700">{msg}</div>}

          <div className="mt-3 border-t border-ink-200 pt-2">
            <div className="text-[12px] font-medium text-ink-900 mb-1.5">我的要货单</div>
            <div className="max-h-40 overflow-auto">
              {myReqs.slice(0, 10).map((r) => (
                <div key={r.id} className="py-1.5 border-b border-ink-100 flex items-center justify-between text-[11px]">
                  <div className="min-w-0">
                    <div className="font-mono text-ink-900 truncate">{r.doc_no}</div>
                    <div className="text-slate-400">{r.req_date} · {r.item_count} 项 · {r.total_qty} 件</div>
                  </div>
                  <span className={`shrink-0 px-1.5 py-0.5 rounded ${
                    r.status === 'rejected' ? 'bg-red-50 text-red-600'
                      : ['transferred', 'allocated', 'completed'].includes(r.status) ? 'bg-green-50 text-green-700'
                        : 'bg-amber-50 text-amber-700'}`}>
                    {STATUS_TEXT[r.status] || r.status}
                  </span>
                </div>
              ))}
              {!myReqs.length && <div className="text-[11px] text-slate-400 py-2">暂无要货记录</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

/** 门店收货：总部发货到店后按实际到货选择性收货（支持勾选部分行 / 短收，差异自动登记） */
function StoreReceive() {
  const [pending, setPending] = useState<any[]>([])
  const [history, setHistory] = useState<any[]>([])
  const [cur, setCur] = useState<any>(null)
  const [checked, setChecked] = useState<Record<number, boolean>>({})
  const [recv, setRecv] = useState<Record<number, number>>({})
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState('')

  const load = () =>
    api
      .get('/requisitions/store/shipments/mine')
      .then((r: any) => {
        const d = r.data || r
        const p = d.pending || []
        setPending(p)
        setHistory(d.history || [])
        return p
      })
      .catch(() => [])

  useEffect(() => {
    load().then((p: any[]) => {
      if (p?.[0]) open(p[0])
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resetForm = (d: any) => {
    const c: Record<number, boolean> = {}
    const q: Record<number, number> = {}
    for (const it of d.items || []) {
      if (it.recv_qty == null) {
        c[it.id] = true
        q[it.id] = Number(it.ship_qty)
      }
    }
    setChecked(c)
    setRecv(q)
  }

  const open = async (row: any) => {
    setMsg('')
    try {
      const r: any = await api.get(`/requisitions/store/shipments/${row.id}`)
      const d = r.data || r
      setCur(d)
      resetForm(d)
    } catch (e: any) {
      setMsg(e.message || '加载失败')
    }
  }

  const submit = async () => {
    if (!cur) return
    const lines = Object.keys(checked)
      .filter((k) => checked[Number(k)])
      .map((k) => ({ item_id: Number(k), recv_qty: Number(recv[Number(k)] ?? 0) }))
    if (!lines.length) {
      setMsg('请选择要收货的明细行')
      return
    }
    setBusy(true)
    setMsg('')
    try {
      const r: any = await api.post(`/requisitions/store/shipments/${cur.id}/receive`, {
        lines,
        receiver: getUser()?.name
      })
      const d = r.data || r
      setCur(d)
      resetForm(d)
      const left = d.items?.filter((i: any) => i.recv_qty == null).length || 0
      setMsg(left ? `已收货，仍有 ${left} 行待收` : '收货完成，已全部入库')
      load()
    } catch (e: any) {
      setMsg(e.message || '收货失败')
    } finally {
      setBusy(false)
    }
  }

  const recvTotal = Object.keys(checked)
    .filter((k) => checked[Number(k)])
    .reduce((s, k) => s + (Number(recv[Number(k)]) || 0), 0)
  const pendingRows = cur?.items?.filter((i: any) => i.recv_qty == null) || []

  return (
    <div className="flex flex-col lg:flex-row h-full">
      {/* 左：待收货 + 历史 */}
      <div className="w-full lg:w-[330px] xl:w-[380px] bg-white border-r border-ink-300 flex flex-col shrink-0 max-h-[45vh] lg:max-h-none">
        <div className="px-3 py-2 border-b border-ink-300">
          <div className="text-[13px] font-medium text-ink-900 title-serif">待收货发货单</div>
          <div className="text-[11px] text-slate-400 mt-0.5">总部已发货到店，请按实际到货清点收货</div>
        </div>
        <div className="flex-1 overflow-auto">
          {pending.map((r) => (
            <button
              key={r.id}
              onClick={() => open(r)}
              className={`w-full text-left px-3 py-2.5 border-b border-ink-100 hover:bg-brand-50/40 ${
                cur?.id === r.id ? 'bg-brand-50' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-ink-900">{r.doc_no}</span>
                <span
                  className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] ${
                    r.status === 'partial' ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  {r.status_name}
                </span>
              </div>
              <div className="text-[11px] text-slate-400 mt-1">
                {r.ship_date} · 发货 {r.total_qty} 件 · 待收 {r.pending_count} 行
              </div>
              <div className="text-[10px] text-slate-400 truncate mt-0.5">
                来源要货单 {r.requisition_doc_no || '—'} · {r.from_warehouse_name}
              </div>
            </button>
          ))}
          {!pending.length && <div className="text-center text-[12px] text-slate-400 py-10">暂无待收货发货单</div>}

          <div className="px-3 py-2 bg-slate-50 border-y border-ink-200 text-[12px] font-medium text-ink-900">
            收货历史
          </div>
          {history.slice(0, 8).map((r) => (
            <button key={r.id} onClick={() => open(r)} className="w-full text-left px-3 py-2 border-b border-ink-100 hover:bg-slate-50">
              <div className="flex items-center justify-between gap-2">
                <span className="font-mono text-[12px] text-slate-600">{r.doc_no}</span>
                <span className="shrink-0 px-1.5 py-0.5 rounded text-[10px] bg-green-50 text-green-700">{r.status_name}</span>
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                发货 {r.total_qty} · 实收 {r.received_qty}
                {Number(r.diff_qty) ? <span className="text-red-500"> · 差异 {-Number(r.diff_qty)}</span> : null}
              </div>
            </button>
          ))}
          {!history.length && <div className="text-center text-[11px] text-slate-400 py-4">暂无收货记录</div>}
        </div>
      </div>

      {/* 右：收货操作 */}
      <div className="flex-1 flex flex-col min-w-0">
        {!cur && <div className="flex-1 flex items-center justify-center text-[13px] text-slate-400">请从左侧选择一张发货单开始收货</div>}
        {cur && (
          <>
            <div className="px-3 py-2.5 bg-white border-b border-ink-300">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-[13px] font-medium text-ink-900 title-serif">发货单 {cur.doc_no}</div>
                  <div className="text-[11px] text-slate-400 mt-0.5">
                    {cur.from_warehouse_name} → {cur.to_warehouse_name} · 发货日期 {cur.ship_date}
                    {cur.carrier ? ` · ${cur.carrier} ${cur.express_no || ''}` : ''}
                  </div>
                </div>
                <div className="text-[11px] text-slate-400 text-right">
                  <div>来源要货单 {cur.requisition_doc_no || '—'}</div>
                  <div>发货 {cur.total_qty} 件 · 已收 {cur.received_qty || 0} 件</div>
                </div>
              </div>
            </div>

            <div className="flex-1 overflow-auto">
              <table className="w-full text-[12px]">
                <thead className="bg-slate-50 text-slate-500 sticky top-0">
                  <tr>
                    <th className="text-left px-3 py-2 font-normal w-12">收货</th>
                    <th className="text-left px-2 py-2 font-normal">商品</th>
                    <th className="text-right px-2 py-2 font-normal w-20">发货量</th>
                    <th className="text-right px-2 py-2 font-normal w-24">实收数量</th>
                    <th className="text-right px-2 py-2 font-normal w-20">差异</th>
                    <th className="text-left px-2 py-2 font-normal w-28">状态</th>
                  </tr>
                </thead>
                <tbody>
                  {(cur.items || []).map((it: any) => {
                    const done = it.recv_qty != null
                    const val = recv[it.id] ?? 0
                    const diff = done ? Number(it.diff_qty || 0) : Number(val) - Number(it.ship_qty)
                    return (
                      <tr key={it.id} className="border-b border-ink-100">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            disabled={done}
                            checked={!!checked[it.id]}
                            onChange={(e) => setChecked({ ...checked, [it.id]: e.target.checked })}
                          />
                        </td>
                        <td className="px-2 py-2">
                          <div className="text-ink-900">{it.product_name} {it.sku_name || ''}</div>
                          <div className="text-[11px] text-slate-400 font-mono">{it.sku_code}</div>
                          {it.batch_list?.length ? (
                            <div className="text-[10px] text-slate-400">
                              批次 {it.batch_list.map((b: any) => `${b.batchNo}×${b.qty}`).join(', ')}
                            </div>
                          ) : null}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">{it.ship_qty}</td>
                        <td className="px-2 py-2 text-right">
                          {done ? (
                            <span className="tabular-nums text-green-700">{it.recv_qty}</span>
                          ) : (
                            <input
                              className="w-16 h-7 text-center text-[12px] border border-ink-300 rounded tabular-nums"
                              type="number"
                              min={0}
                              max={Number(it.ship_qty)}
                              value={val}
                              disabled={!checked[it.id]}
                              onChange={(e) => setRecv({ ...recv, [it.id]: Number(e.target.value) })}
                            />
                          )}
                        </td>
                        <td className="px-2 py-2 text-right tabular-nums">
                          {diff ? <span className="text-red-600">{diff > 0 ? `+${diff}` : diff}</span> : <span className="text-slate-300">0</span>}
                        </td>
                        <td className="px-2 py-2">
                          {done ? (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-green-50 text-green-700">已收</span>
                          ) : (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-50 text-amber-700">待收</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div className="border-t border-ink-300 bg-white p-3">
              {msg && (
                <div className="mb-2 p-2 bg-brand-50 border border-brand-600/20 rounded text-[11px] text-brand-700">{msg}</div>
              )}
              <div className="flex items-center justify-between gap-3">
                <div className="text-[12px] text-slate-500 tabular-nums">
                  本次收货 {Object.values(checked).filter(Boolean).length} 行 / {recvTotal} 件
                  {pendingRows.length ? ` · 剩余待收 ${pendingRows.length} 行` : ' · 已全部收完'}
                </div>
                <button className="btn-primary" disabled={busy || !['shipped', 'partial'].includes(cur.status)} onClick={submit}>
                  {busy ? '提交中…' : '确认收货入库'}
                </button>
              </div>
              {!['shipped', 'partial'].includes(cur.status) && (
                <div className="mt-2 text-[11px] text-slate-400">该发货单当前状态为「{cur.status_name}」，不可再收货。</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
