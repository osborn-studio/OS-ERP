/**
 * ============================================================================
 * 文件标识：src/pages/mall/MallApp.tsx ｜ MallApp（页面，未取到标题）
 * ============================================================================
 * 【职责】MallApp（页面，未取到标题）（页面）
 * 【入口】/mall
 * 【主要接口】/mall/cart、/mall/home、/mall/products、/mall/cart/update、/mall/coupons、/mall/quote
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
 * 页面：MallApp（页面，未取到标题）
 */

import { useEffect, useMemo, useState } from 'react'
import api, { getMallToken, setMallToken } from '../../api/client'
import {
  Search, ShoppingCart, User, Home as HomeIcon, LayoutGrid, Package,
  ChevronRight, Plus, Minus, Trash2, CheckCircle, MapPin, LogIn
} from 'lucide-react'

/** H5 线上门店（商城）：手机优先，下单统一进入总部 OMS 通道 */
export default function MallApp() {
  const [tab, setTab] = useState<'home' | 'mall' | 'cart' | 'mine'>('home')
  const [page, setPage] = useState<{ name: string; skuId?: number; categoryId?: number }>({ name: 'home' })
  // phone 只用于**显示**（"你好，138****"）与登录表单；身份一律由 C 端会话承载。
  // 把 phone 当身份传接口是 A16 的缺陷原形 —— 手机号是公开标识，不是凭据。
  const [phone, setPhone] = useState(localStorage.getItem('gml_mall_phone') || '')
  const [cartCount, setCartCount] = useState(0)

  const refreshCart = () => {
    if (!getMallToken()) { setCartCount(0); return }
    api.get('/mall/cart').then((r: any) => {
      const l = r.data || r
      setCartCount(Array.isArray(l) ? l.reduce((s: number, x: any) => s + x.qty, 0) : 0)
    }).catch(() => {})
  }
  useEffect(() => { refreshCart() }, [phone])

  const go = (name: string, extra: any = {}) => { setPage({ name, ...extra }); window.scrollTo(0, 0) }

  return (
    <div className="min-h-screen bg-paper text-ink-900">
      {/* 移动端容器：桌面预览时居中显示手机宽度 */}
      <div className="mx-auto max-w-[480px] min-h-screen bg-white pb-16 relative shadow-sm">
        {page.name === 'home' && <Home go={go} />}
        {page.name === 'category' && <CategoryList categoryId={page.categoryId} go={go} />}
        {page.name === 'detail' && <Detail skuId={page.skuId!} phone={phone} go={go} onCart={refreshCart} />}
        {page.name === 'cart' && <Cart phone={phone} go={go} onCart={refreshCart} onLogin={setPhone} />}
        {page.name === 'checkout' && <Checkout phone={phone} go={go} onCart={refreshCart} />}
        {page.name === 'orders' && <Orders phone={phone} go={go} />}
        {page.name === 'login' && <Login onLogin={(p) => { setPhone(p); go('mine') }} />}
        {page.name === 'mine' && <Mine phone={phone} go={go} onLogout={() => { localStorage.removeItem('gml_mall_phone'); setMallToken(''); setPhone(''); go('home') }} />}

        {/* 底部 Tab */}
        <nav className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-ink-300 flex z-20">
          {([
            ['home', '首页', HomeIcon],
            ['mall', '全部商品', LayoutGrid],
            ['cart', '购物车', ShoppingCart],
            ['mine', '我的', User]
          ] as const).map(([k, label, Icon]) => (
            <button key={k} onClick={() => { setTab(k as any); go(k === 'mall' ? 'category' : k) }}
              className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-[10px] ${tab === k ? 'text-brand-700 font-medium' : 'text-slate-400'}`}>
              <div className="relative">
                <Icon size={19} />
                {k === 'cart' && cartCount > 0 && (
                  <span className="absolute -top-1 -right-2 bg-brand-700 text-white text-[9px] rounded-full w-3.5 h-3.5 flex items-center justify-center">{cartCount}</span>
                )}
              </div>
              {label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  )
}

function fmt(n: number) { return '¥' + Number(n || 0).toFixed(0) }

/** 首页 */
function Home({ go }: { go: (n: string, e?: any) => void }) {
  const [data, setData] = useState<any>(null)
  const [kw, setKw] = useState('')
  useEffect(() => { api.get('/mall/home').then((r: any) => setData(r.data || r)).catch(() => {}) }, [])
  const cats = (data?.categories || []).filter((c: any) => !c.parent_id)
  return (
    <div>
      <div className="bg-brand-800 text-white px-4 pt-5 pb-6">
        <div className="text-[11px] text-white/60 mb-0.5">{data?.shop?.brand || '品牌官方 · 正品直营'}</div>
        <div className="text-[17px] font-medium title-serif mb-3">{data?.shop?.title || '线上官方商城'}</div>
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-white/50" />
          <input className="w-full h-9 rounded-full bg-white/15 border border-white/20 pl-9 pr-3 text-[12px] text-white placeholder:text-white/50 outline-none"
            placeholder="搜索商品" value={kw} onChange={(e) => setKw(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go('category', { categoryId: undefined, kw })} />
        </div>
      </div>
      <div className="px-4 -mt-3">
        <div className="bg-white rounded-xl border border-ink-300 p-3 mb-3 flex items-center gap-2 text-[11px] text-brand-700">
          <CheckCircle size={14} /> {data?.notice || '全场满 ¥199 包邮 · 新客首单享会员价'}
        </div>
        <Section title="商品分类" onMore={() => go('category')} />
        <div className="grid grid-cols-4 gap-2 mb-4">
          {cats.slice(0, 8).map((c: any) => (
            <button key={c.id} onClick={() => go('category', { categoryId: c.id })}
              className="bg-paper rounded-lg py-3 text-[11px] text-ink-900 border border-ink-100">
              {c.name.slice(0, 4)}
            </button>
          ))}
        </div>
        <Section title="热销推荐" onMore={() => go('category')} />
        <div className="grid grid-cols-2 gap-2.5">
          {(data?.hot || []).map((p: any) => <ProductCard key={p.sku_id} p={p} onClick={() => go('detail', { skuId: p.sku_id })} />)}
        </div>
        <Section title="新品上架" />
        <div className="grid grid-cols-2 gap-2.5 pb-4">
          {(data?.news || []).map((p: any) => <ProductCard key={p.sku_id} p={p} onClick={() => go('detail', { skuId: p.sku_id })} />)}
        </div>
      </div>
    </div>
  )
}

function Section({ title, onMore }: { title: string; onMore?: () => void }) {
  return (
    <div className="flex items-center justify-between mb-2 mt-1">
      <div className="text-[13px] font-medium title-serif text-ink-900">{title}</div>
      {onMore && <button className="text-[11px] text-slate-400 flex items-center" onClick={onMore}>更多 <ChevronRight size={12} /></button>}
    </div>
  )
}

function ProductCard({ p, onClick }: { p: any; onClick: () => void }) {
  return (
    <button onClick={onClick} className="bg-white border border-ink-300 rounded-lg overflow-hidden text-left hover:border-brand-600 transition">
      <div className="h-24 bg-gradient-to-br from-brand-50 to-tech-50 flex items-center justify-center text-[26px]">
        {p.product_name?.slice(0, 1) || '商'}
      </div>
      <div className="p-2">
        <div className="text-[12px] text-ink-900 line-clamp-2 min-h-[30px]">{p.product_name}</div>
        <div className="text-[10px] text-slate-400 truncate">{p.sku_name}</div>
        <div className="flex items-baseline gap-1 mt-1">
          <span className="text-[13px] font-medium text-brand-700 tabular-nums">{fmt(p.price_member || p.price_retail)}</span>
          {p.price_member && p.price_member !== p.price_retail && (
            <span className="text-[10px] text-slate-400 line-through tabular-nums">{fmt(p.price_retail)}</span>
          )}
        </div>
      </div>
    </button>
  )
}

/** 商品列表 */
function CategoryList({ categoryId, go }: { categoryId?: number; go: (n: string, e?: any) => void }) {
  const [rows, setRows] = useState<any[]>([])
  const [cats, setCats] = useState<any[]>([])
  const [cur, setCur] = useState<number | undefined>(categoryId)
  const [kw, setKw] = useState('')
  useEffect(() => {
    api.get('/mall/home').then((r: any) => setCats((r.data || r).categories?.filter((c: any) => !c.parent_id) || []))
  }, [])
  useEffect(() => {
    api.get('/mall/products', { category_id: cur || '', kw, pageSize: 40 }).then((r: any) => setRows((r.data || r).rows || [])).catch(() => {})
  }, [cur, kw])
  return (
    <div>
      <div className="sticky top-0 bg-white border-b border-ink-300 z-10 px-3 py-2">
        <div className="relative mb-2">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
          <input className="input pl-9 h-9" placeholder="搜索商品" value={kw} onChange={(e) => setKw(e.target.value)} />
        </div>
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          <button onClick={() => setCur(undefined)}
            className={`px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border ${!cur ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-500'}`}>全部</button>
          {cats.map((c) => (
            <button key={c.id} onClick={() => setCur(c.id)}
              className={`px-2.5 py-1 rounded-full text-[11px] whitespace-nowrap border ${cur === c.id ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-500'}`}>{c.name}</button>
          ))}
        </div>
      </div>
      <div className="p-3 grid grid-cols-2 gap-2.5">
        {rows.map((p) => <ProductCard key={p.sku_id} p={p} onClick={() => go('detail', { skuId: p.sku_id })} />)}
        {!rows.length && <div className="col-span-2 text-center text-[12px] text-slate-400 py-10">暂无商品</div>}
      </div>
    </div>
  )
}

/** 商品详情 */
function Detail({ skuId, phone, go, onCart }: { skuId: number; phone: string; go: any; onCart: () => void }) {
  const [d, setD] = useState<any>(null)
  const [qty, setQty] = useState(1)
  useEffect(() => { api.get(`/mall/products/${skuId}`).then((r: any) => setD(r.data || r)).catch(() => {}) }, [skuId])
  const addCart = async () => {
    if (!getMallToken()) return go('login')
    // 不再传 phone：身份由会话承载，服务端也不再读请求里的 phone
    try { await api.post('/mall/cart', { sku_id: skuId, qty }); onCart(); go('cart') } catch (e: any) { alert(e.message) }
  }
  if (!d) return <div className="p-6 text-center text-[12px] text-slate-400">加载中…</div>
  const s = d.sku
  return (
    <div>
      <div className="h-56 bg-gradient-to-br from-brand-50 to-tech-50 flex items-center justify-center text-[60px]">
        {s.product_name?.slice(0, 1)}
      </div>
      <div className="p-4">
        <div className="text-[16px] font-medium text-ink-900">{s.product_name}</div>
        <div className="text-[12px] text-slate-400 mt-0.5">{s.sku_name} · {s.brand_name}</div>
        <div className="flex items-baseline gap-2 mt-2">
          <span className="text-[22px] font-medium text-brand-700 tabular-nums">{fmt(s.price_member || s.price_retail)}</span>
          {s.price_member && s.price_member !== s.price_retail && (
            <span className="text-[12px] text-slate-400 line-through tabular-nums">¥{s.price_retail}</span>
          )}
          <span className="ml-auto text-[11px] text-slate-400">云仓可售 {d.available}</span>
        </div>
        <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-[11px] text-slate-500 bg-paper rounded-lg p-3">
          {[['规格', s.spec || '—'], ['单位', s.unit], ['条码', s.barcode || '—'], ['系列', s.series || '—']].map(([k, v]) => (
            <div key={k} className="flex gap-2"><span className="text-slate-400">{k}</span><span className="text-ink-900">{v}</span></div>
          ))}
        </div>
        {!!d.siblings?.length && (
          <div className="mt-3">
            <div className="text-[12px] text-slate-500 mb-1.5">其它规格</div>
            <div className="flex flex-wrap gap-1.5">
              {d.siblings.map((x: any) => (
                <button key={x.sku_id} onClick={() => go('detail', { skuId: x.sku_id })}
                  className="px-2.5 py-1 rounded border border-ink-300 text-[11px] text-slate-600">{x.sku_name}</button>
              ))}
            </div>
          </div>
        )}
      </div>
      <div className="fixed bottom-0 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-ink-300 p-2.5 flex items-center gap-2 z-20">
        <div className="flex items-center gap-2 border border-ink-300 rounded px-1">
          <button className="w-7 h-7 flex items-center justify-center" onClick={() => setQty(Math.max(1, qty - 1))}><Minus size={13} /></button>
          <span className="w-5 text-center text-[12px] tabular-nums">{qty}</span>
          <button className="w-7 h-7 flex items-center justify-center" onClick={() => setQty(qty + 1)}><Plus size={13} /></button>
        </div>
        <button className="flex-1 h-9 rounded bg-brand-700 text-white text-[13px]" onClick={addCart}>
          加入购物车 · {fmt((s.price_member || s.price_retail) * qty)}
        </button>
      </div>
      <div className="h-14" />
    </div>
  )
}

/** 购物车 */
function Cart({ phone, go, onCart, onLogin }: any) {
  const [rows, setRows] = useState<any[]>([])
  const load = () => getMallToken() ? api.get('/mall/cart').then((r: any) => setRows(r.data || r)) : setRows([])
  useEffect(() => { load() }, [phone])
  const total = rows.reduce((s, x) => s + (x.price_member || x.price_retail) * x.qty, 0)
  if (!getMallToken()) return <div className="p-6 text-center"><div className="text-[12px] text-slate-400 mb-3">请先登录</div><button className="btn-primary" onClick={() => go('login')}>登录</button></div>
  return (
    <div className="p-3">
      {rows.map((x) => (
        <div key={x.id} className="bg-white border border-ink-300 rounded-lg p-2.5 mb-2 flex items-center gap-2">
          <div className="w-12 h-12 rounded bg-paper flex items-center justify-center text-[18px] shrink-0">{x.product_name?.slice(0, 1)}</div>
          <div className="flex-1 min-w-0">
            <div className="text-[12px] text-ink-900 truncate">{x.product_name}</div>
            <div className="text-[11px] text-slate-400">{x.sku_name} · {fmt(x.price_member || x.price_retail)}</div>
          </div>
          <div className="flex items-center gap-1">
            <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
              onClick={async () => { await api.post('/mall/cart/update', { sku_id: x.sku_id, qty: x.qty - 1 }); load(); onCart() }}><Minus size={11} /></button>
            <span className="w-5 text-center text-[12px] tabular-nums">{x.qty}</span>
            <button className="w-6 h-6 rounded border border-ink-300 flex items-center justify-center"
              onClick={async () => { await api.post('/mall/cart/update', { sku_id: x.sku_id, qty: x.qty + 1 }); load(); onCart() }}><Plus size={11} /></button>
            <button className="w-6 h-6 text-slate-300"
              onClick={async () => { await api.post('/mall/cart/update', { sku_id: x.sku_id, qty: 0 }); load(); onCart() }}><Trash2 size={12} /></button>
          </div>
        </div>
      ))}
      {!rows.length && <div className="text-center text-[12px] text-slate-400 py-14">购物车是空的</div>}
      {rows.length > 0 && (
        <div className="fixed bottom-16 left-1/2 -translate-x-1/2 w-full max-w-[480px] bg-white border-t border-ink-300 p-2.5 flex items-center gap-3">
          <div className="text-[12px] text-slate-500">合计 <b className="text-[15px] text-brand-700 tabular-nums">{fmt(total)}</b></div>
          <button className="flex-1 h-9 rounded bg-brand-700 text-white text-[13px]" onClick={() => go('checkout')}>去结算</button>
        </div>
      )}
    </div>
  )
}

/** 结算：金额一律取服务端试算（`/mall/quote`），不在前端自己算 */
function Checkout({ phone, go, onCart }: any) {
  const [rows, setRows] = useState<any[]>([])
  const [form, setForm] = useState({ receiver: '', receiver_phone: phone, address: '', remark: '' })
  const [order, setOrder] = useState<any>(null)
  const [q, setQ] = useState<any>(null)      // 当前选券/积分下的试算
  const [base, setBase] = useState<any>(null) // 不选券/不用积分的试算（用于取"本单最多能抵多少分"）
  const [coupons, setCoupons] = useState<any>({ usable: [], blocked: [] })
  const [useCoupon, setUseCoupon] = useState('')
  const [usePointsOn, setUsePointsOn] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    if (!getMallToken()) return
    api.get('/mall/cart').then((r: any) => setRows(r.data || r)).catch(() => {})
    api.get('/mall/coupons').then((r: any) => setCoupons(r.data || { usable: [], blocked: [] })).catch(() => {})
  }, [phone])

  const items = rows.map((x) => ({ sku_id: x.sku_id, qty: x.qty }))
  const itemsKey = JSON.stringify(items)

  // 第一遍：不带券、不用积分 —— 它给出「本单最多能抵多少分」（抵扣上限按**优惠后金额**推导）
  useEffect(() => {
    if (!items.length) return
    api.post('/mall/quote', { items }).then((r: any) => setBase(r.data || r)).catch(() => {})
  }, [itemsKey])

  const maxPts = base?.points_quote?.maxPoints || 0
  // 第二遍：把选券与积分抵扣一起算进去 —— 这就是最终要收的钱
  useEffect(() => {
    if (!items.length) return
    setErr('')
    api.post('/mall/quote', {
      items, coupon_codes: useCoupon ? [useCoupon] : [], use_points: usePointsOn ? maxPts : 0
    }).then((r: any) => setQ(r.data || r)).catch((e: any) => { setQ(null); setErr(e.message) })
  }, [itemsKey, useCoupon, usePointsOn, maxPts])

  const submit = async () => {
    try {
      // 与试算**同一份参数**：券、积分都用界面上选的那一套；身份取会话，不传 phone
      const r: any = await api.post('/mall/orders', {
        ...form, items, coupon_codes: useCoupon ? [useCoupon] : [], use_points: usePointsOn ? maxPts : 0
      })
      setOrder(r.data); onCart()
    } catch (e: any) { alert(e.message) }
  }
  if (order) return (
    <div className="p-6 text-center">
      <CheckCircle size={40} className="text-brand-700 mx-auto mb-3" />
      <div className="text-[15px] font-medium text-ink-900 mb-1">下单成功</div>
      <div className="text-[12px] text-slate-500 mb-1">订单号 <span className="font-mono">{order.order_no}</span></div>
      <div className="text-[12px] text-slate-500 mb-1">
        应付 <b className="text-brand-700 tabular-nums">¥{order.pay_amount}</b>（运费 ¥{order.freight}）
      </div>
      {order.discount_amount > 0 && (
        <div className="text-[11px] text-slate-400 mb-1">
          已优惠 ¥{order.discount_amount}
          {order.points_earned > 0 ? ` · 得 ${order.points_earned} 积分` : ''}
        </div>
      )}
      <div className="text-[11px] text-slate-400 mb-4">订单已进入总部 OMS，由 OMS 统一转销售单发货</div>
      <button className="btn-primary" onClick={() => go('orders')}>查看我的订单</button>
    </div>
  )
  if (!rows.length) return <div className="p-6 text-center text-[12px] text-slate-400">购物车是空的</div>
  return (
    <div className="p-3">
      <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
        <div className="text-[12px] font-medium text-ink-900 mb-2 flex items-center gap-1"><MapPin size={13} /> 收货信息</div>
        {[['receiver', '收货人'], ['receiver_phone', '手机号'], ['address', '收货地址'], ['remark', '留言']].map(([k, l]) => (
          <input key={k} className="input mb-2" placeholder={l} value={(form as any)[k]}
            onChange={(e) => setForm({ ...form, [k]: e.target.value })} />
        ))}
      </div>

      {/* 可用券：只列出**本单真能用**的；被挡住的要说明原因（否则客户只会问"我的券去哪了"） */}
      {(coupons.usable?.length > 0 || coupons.blocked?.length > 0) && (
        <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
          <div className="text-[12px] font-medium text-ink-900 mb-2">优惠券</div>
          <div className="flex flex-wrap gap-1.5">
            <button onClick={() => setUseCoupon('')}
              className={`px-2.5 py-1 rounded border text-[11px] ${!useCoupon ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-500'}`}>不使用</button>
            {(coupons.usable || []).map((c: any) => (
              <button key={c.coupon_code} onClick={() => setUseCoupon(c.coupon_code)}
                className={`px-2.5 py-1 rounded border text-[11px] ${useCoupon === c.coupon_code ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-600'}`}>
                {c.coupon_name}
              </button>
            ))}
          </div>
          {(coupons.blocked || []).slice(0, 3).map((b: any) => (
            <div key={b.coupon_code} className="text-[10px] text-slate-400 mt-1">{b.coupon_code}：{b.message || b.reason}</div>
          ))}
        </div>
      )}

      {/* 积分抵扣：上限由服务端按"优惠后金额"推导，界面**不自己算** */}
      {maxPts > 0 && (
        <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3 flex items-center justify-between">
          <div>
            <div className="text-[12px] text-ink-900">积分抵现</div>
            <div className="text-[11px] text-slate-400">本单最多可抵 {maxPts} 分（¥{(maxPts / 100).toFixed(2)}）</div>
          </div>
          <button onClick={() => setUsePointsOn(!usePointsOn)}
            className={`px-3 py-1 rounded border text-[11px] ${usePointsOn ? 'bg-brand-700 text-white border-brand-700' : 'border-ink-300 text-slate-500'}`}>
            {usePointsOn ? '已使用' : '使用'}
          </button>
        </div>
      )}

      <div className="bg-white border border-ink-300 rounded-lg p-3 mb-3">
        {rows.map((x) => (
          <div key={x.id} className="flex justify-between text-[12px] py-1">
            <span className="text-slate-600 truncate">{x.product_name} × {x.qty}</span>
            <span className="tabular-nums">{fmt((x.price_member || x.price_retail) * x.qty)}</span>
          </div>
        ))}
        <div className="border-t border-ink-100 mt-2 pt-2 space-y-0.5">
          <Line label="商品金额" v={fmt(q?.goods_amount ?? 0)} />
          {!!q?.member_discount && <Line label="会员折扣" v={`-${fmt(q.member_discount / 100)}`} brand />}
          {!!q?.promotion_discount && <Line label="活动优惠" v={`-${fmt(q.promotion_discount / 100)}`} brand />}
          {!!q?.points_discount && <Line label={`积分抵扣（${q.points_used} 分）`} v={`-${fmt(q.points_discount / 100)}`} brand />}
          <Line label={`运费${q?.freight === 0 ? '（已免）' : ''}`} v={`¥${q?.freight ?? 0}`} />
        </div>
      </div>
      {err && <div className="text-[11px] text-red-500 mb-2">{err}</div>}
      <button className="btn-primary w-full" onClick={submit}
        disabled={!form.receiver || !form.address || !q || !!err}>
        提交订单 · {fmt(q?.pay_amount ?? 0)}
      </button>
      <div className="text-[10px] text-slate-400 mt-2 text-center">
        金额由结算域实时试算（会员等级折扣 → 活动 → 券 → 积分），与提交后实际收取一致
      </div>
    </div>
  )
}

function Line({ label, v, brand }: { label: string; v: string; brand?: boolean }) {
  return (
    <div className={`flex justify-between text-[12px] ${brand ? 'text-brand-700' : 'text-slate-500'}`}>
      <span>{label}</span><span className="tabular-nums">{v}</span>
    </div>
  )
}

/** 我的订单 */
function Orders({ phone, go }: any) {
  const [rows, setRows] = useState<any[]>([])
  const load = () => { if (getMallToken()) api.get('/mall/orders').then((r: any) => setRows(r.data || r)).catch(() => {}) }
  useEffect(() => { load() }, [phone])
  const cancel = async (o: any) => {
    if (!confirm(`确认撤销订单 ${o.order_no}？已使用的券与积分会一并退回。`)) return
    try { await api.post(`/mall/orders/${o.id}/cancel`); load() } catch (e: any) { alert(e.message) }
  }
  const ST: any = { pending: '待发货', shipped: '已发货', completed: '已完成', refunding: '退款中', refunded: '已退款', closed: '已关闭' }
  if (!getMallToken()) return <div className="p-6 text-center text-[12px] text-slate-400">请先登录</div>
  return (
    <div className="p-3">
      {rows.map((o) => (
        <div key={o.id} className="bg-white border border-ink-300 rounded-lg p-3 mb-2">
          <div className="flex items-center justify-between mb-1">
            <span className="font-mono text-[11px] text-slate-500">{o.order_no}</span>
            <span className="text-[11px] text-brand-700">{ST[o.status] || o.status}</span>
          </div>
          <div className="text-[12px] text-ink-900">{o.item_count} 件商品 · 应付 <b className="tabular-nums">{fmt(o.pay_amount)}</b></div>
          <div className="text-[11px] text-slate-400 mt-0.5">{o.order_time}</div>
          {o.express_company && <div className="text-[11px] text-slate-400">{o.express_company} {o.express_no}</div>}
          {/* 只有"还没转销售单发货"的单能撤 —— 与服务端的门保持一致 */}
          {o.status === 'pending' && !o.sales_order_id && (
            <button className="mt-2 text-[11px] text-slate-500 border border-ink-300 rounded px-2 py-0.5" onClick={() => cancel(o)}>
              撤销订单
            </button>
          )}
        </div>
      ))}
      {!rows.length && <div className="text-center text-[12px] text-slate-400 py-14">暂无订单</div>}
    </div>
  )
}

/** 登录（手机号 + 验证码） */
function Login({ onLogin }: { onLogin: (p: string) => void }) {
  const [p, setP] = useState('')
  const [c, setC] = useState('')
  const login = async () => {
    try {
      // 登录返回 C 端会话令牌 —— 之后所有"我的数据"都靠它，不再靠手机号
      const r: any = await api.post('/mall/login', { phone: p, code: c })
      setMallToken(r?.data?.token || '')
      localStorage.setItem('gml_mall_phone', p)
      onLogin(p)
    } catch (e: any) { alert(e.message) }
  }
  return (
    <div className="p-6">
      <div className="text-[17px] font-medium text-ink-900 mb-1 title-serif">登录</div>
      <p className="text-[12px] text-slate-400 mb-5">手机号即会员（与线下门店一账通）</p>
      <input className="input mb-2" placeholder="手机号" value={p} onChange={(e) => setP(e.target.value)} />
      <input className="input mb-2" placeholder="验证码（演示固定 1234）" value={c} onChange={(e) => setC(e.target.value)} />
      <button className="btn-primary w-full" onClick={login}>登录</button>
      <div className="mt-4 text-[11px] text-slate-400">演示会员：13901390001 / 13901390002 / 13901390003 / 13901390004</div>
    </div>
  )
}

/** 我的 */
function Mine({ phone, go, onLogout }: any) {
  const [m, setM] = useState<any>(null)
  const [cp, setCp] = useState<any>({ all: [] })
  const [showCoupons, setShowCoupons] = useState(false)
  useEffect(() => {
    if (!getMallToken()) return
    api.get('/mall/member').then((r: any) => setM(r.data || r)).catch(() => {})
    api.get('/mall/coupons').then((r: any) => setCp(r.data || { all: [] })).catch(() => {})
  }, [phone])
  if (!getMallToken()) return <div className="p-6 text-center"><div className="text-[12px] text-slate-400 mb-3">未登录</div><button className="btn-primary" onClick={() => go('login')}><LogIn size={14} /> 登录 / 注册</button></div>
  // 会员等级与权益由服务端账本推导（`member_accounts`），这里只做展示 ——
  // 前端不自己算等级、不算积分，否则又会分裂出第二套口径。
  const lvLabel = m?.level_code ? (LEVEL_LABEL[m.level_code] || m.level_code) : '—'
  const usableCount = (cp.all || []).filter((c: any) => c.status === 'unused').length
  return (
    <div className="p-4">
      <div className="bg-brand-800 text-white rounded-xl p-4 mb-3">
        <div className="text-[15px] font-medium">{m?.name || '会员'} <span className="text-[12px] text-white/60">{phone}</span></div>
        <div className="text-[11px] text-white/60 mt-0.5">{lvLabel}{m?.level_name ? ` · ${m.level_name}` : ''}</div>
        <div className="grid grid-cols-3 gap-2 mt-3 text-center">
          {[['积分', m?.points ?? 0], ['订单', m?.total_orders ?? 0], ['累计消费', fmt(m?.total_amount ?? 0)]].map(([l, v]) => (
            <div key={String(l)}>
              <div className="text-[15px] font-medium tabular-nums">{v}</div>
              <div className="text-[11px] text-white/60">{l}</div>
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white border border-ink-300 rounded-lg overflow-hidden">
        <button onClick={() => go('orders')} className="w-full px-3 py-3 flex items-center justify-between text-[12px] border-b border-ink-100">
          <span>我的订单</span><ChevronRight size={14} className="text-slate-300" />
        </button>
        <button onClick={() => setShowCoupons(!showCoupons)} className="w-full px-3 py-3 flex items-center justify-between text-[12px] border-b border-ink-100">
          <span>我的优惠券 <span className="text-slate-400">（可用 {usableCount} 张）</span></span>
          <ChevronRight size={14} className={`text-slate-300 transition ${showCoupons ? 'rotate-90' : ''}`} />
        </button>
        {showCoupons && (cp.all || []).map((c: any) => (
          <div key={c.coupon_code} className="px-3 py-2 border-b border-ink-100 last:border-0 flex items-center justify-between">
            <div>
              <div className="text-[12px] text-ink-900">{c.coupon_name}</div>
              <div className="text-[10px] text-slate-400 font-mono">{c.coupon_code}{c.expires_at ? ` · 至 ${String(c.expires_at).slice(0, 10)}` : ''}</div>
            </div>
            <span className="text-[11px] text-brand-700">{COUPON_ST[c.status] || c.status}</span>
          </div>
        ))}
        <button onClick={() => go('cart')} className="w-full px-3 py-3 flex items-center justify-between text-[12px]">
          <span>购物车</span><ChevronRight size={14} className="text-slate-300" />
        </button>
      </div>
      <button className="btn-ghost w-full mt-3" onClick={onLogout}>退出登录</button>
    </div>
  )
}

/** 券状态标签 —— 与服务端 `coupon_instances.status` 一一对应，不推导、不合并 */
const COUPON_ST: Record<string, string> = {
  unused: '未使用', used: '已核销', expired: '已过期', void: '已作废'
}
const LEVEL_LABEL: Record<string, string> = {
  normal: '普通会员', silver: '银牌会员', gold: '金牌会员', platinum: '铂金会员'
}
