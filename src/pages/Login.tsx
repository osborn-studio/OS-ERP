/**
 * ============================================================================
 * 文件标识：src/pages/Login.tsx ｜ 全站**唯一**登录页（行业版本 + 角色 + 账号密码）
 * ============================================================================
 * 【这一页回答什么】
 *   「我该用哪个账号进去？这个账号能看到什么？」
 *
 * 【为什么全站只有一个登录页】
 *   历史上有两个入口：`public/enter.html`（选行业后**自动用 admin 登录**）与 `/login`。
 *   后果是：演示时无论谁点入口页，都以 `admin` 进去 —— 客户根本看不到"不同角色菜单不同"，
 *   而且两套登录逻辑各写一遍，改密码规则要改两处。
 *   ⇒ 现在 `enter.html` **只做跳转**（保留旧链接可用），真正登录只在这里发生。
 *
 * 【三个区块的顺序是有意的】
 *   ① 行业版本（决定连哪个库）→ ② 角色（决定菜单与权限）→ ③ 账号密码（可手填，也可由②带入）。
 *   顺序反了就会让人先想账号，而演示现场真正想表达的是"这个版本、这个角色"。
 *
 * 【演示角色卡片的口径】
 *   卡片上的「能看到什么」与 `src/components/Layout.tsx` 的角色族、以及后端 `role_permissions`
 *   是同一件事的三种呈现。**这里不写死权限清单**，只写一句人话范围；
 *   真实菜单以登录后侧栏为准（登录页写细了必然与代码分叉）。
 *
 * 【改它要注意】
 *   · 新增角色：这里加一张卡 + `server/db/seed.js` 建账号 + `Layout.tsx` 的角色族加一行；
 *   · 餐饮版没有经销商 ⇒ 卡片按 `industries` 过滤（不是权限，是业务形态）；
 *   · 密码只能写在演示卡片上（演示环境），正式环境必须删掉这一块。
 * ============================================================================
 */

import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useAuth } from '../store/auth'
import { useRuntimeCapabilities } from '../store/runtime-capabilities'
import { CapabilityStatus } from '../components/CapabilityGate'
import api from '../api/client'
import { Field, toast } from '../components/ui'
import { PRODUCT_NAME, PRODUCT_SUBTITLE, PRODUCT_GLYPH } from '../constants/brand'
import { Sparkles, PlayCircle, BookOpen, Monitor } from 'lucide-react'

/**
 * 演示角色。
 * `industries` 不填 = 所有行业都有；填了就是白名单（经销商只有美妆/服装有）。
 */
const DEMO_ROLES: {
  u: string
  p: string
  label: string
  scope: string
  industries?: string[]
}[] = [
  { u: 'admin', p: '12345', label: '系统管理员', scope: '全部菜单 · 系统设置 · AI 与 MCP 控制台' },
  { u: 'boss', p: '123456', label: '老板 / 总经理', scope: '全部数据只读 + 关键审批（无系统设置）' },
  { u: 'scm', p: '123456', label: '供应链主管', scope: '采购 / 存货 / 生产 / 质检；销售财务只读' },
  { u: 'purchase', p: '123456', label: '采购主管', scope: '采购 / 收货 / 供应商 / 存货查询' },
  { u: 'sales', p: '123456', label: '销售主管', scope: '销售 / 经销商 / 订货中心 / 线上 OMS' },
  { u: 'warehouse', p: '123456', label: '仓储主管', scope: '存货 / 调拨 / 盘点 / 收货 / 质检' },
  { u: 'finance', p: '123456', label: '财务', scope: '应收核销 / 凭证 / 报表 / 应付' },
  { u: 'store01', p: '123456', label: '门店店长', scope: '仅本门店：POS 收银 / 库存 / 要货', industries: ['cosmetic', 'apparel', 'food'] },
  { u: 'dealer01', p: '123456', label: '经销商', scope: '仅本单位：订货中心 + 对账单', industries: ['cosmetic', 'apparel'] },
  { u: 'viewer', p: '123456', label: '只读访客', scope: '看板 + 只读查询，不能改任何数据' }
]

// 行业版本视觉提示
const INDUSTRY_META: Record<string, { emoji: string; tag: string; sample: string }> = {
  cosmetic: { emoji: '💄', tag: '美妆个护', sample: '精华面霜 · 彩妆香氛 · 洗护防晒' },
  food: { emoji: '🍜', tag: '连锁餐饮', sample: '门店现制 · 中央厨房 · 食材效期' },
  apparel: { emoji: '👗', tag: '服饰鞋包', sample: '颜色尺码 · 季节面料 · 搭配组合装' }
}

export default function Login() {
  const { login, loading, sessionNotice, dismissSessionNotice } = useAuth()
  const { isDemo, enabled } = useRuntimeCapabilities()
  const nav = useNavigate()
  const [form, setForm] = useState({ username: '', password: '' })
  const [industries, setIndustries] = useState<{ code: string; name: string; label: string }[]>([])
  const [industry, setIndustry] = useState('cosmetic')
  const [picked, setPicked] = useState('')

  useEffect(() => {
    api
      .get('/auth/industries')
      .then((r) => {
        // 只展示 `visible !== false` 的行业（服装版后台保留、前端不出现 —— 客户 2026-10-17 口径）。
        const list = (r.data || []).filter((x: any) => x.visible !== false)
        setIndustries(list)
        // 优先级：URL 上的 ?industry= > 上次登录记住的行业 > 列表第一个。
        // 旧入口页 `/enter.html?industry=food` 就是靠这个参数把行业带过来的。
        const fromUrl = new URLSearchParams(window.location.search).get('industry')
        if (fromUrl && list.some((x: any) => x.code === fromUrl)) {
          setIndustry(fromUrl)
          return
        }
        const saved = localStorage.getItem('gml_industry')
        if (saved && list.some((x: any) => x.code === saved)) setIndustry(saved)
        else if (list[0]) setIndustry(list[0].code)
      })
      .catch(() => setIndustries([{ code: 'cosmetic', name: '美妆连锁', label: '美妆连锁版' }]))
  }, [])

  const meta = INDUSTRY_META[industry] || INDUSTRY_META.cosmetic
  // 餐饮版没有经销商 —— 这是业务形态，不是权限
  const roles = DEMO_ROLES.filter((r) => !r.industries || r.industries.includes(industry))

  useEffect(() => {
    if (!isDemo && picked) { setPicked(''); setForm({ username: '', password: '' }) }
  }, [isDemo, picked])

  const pickRole = (r: (typeof DEMO_ROLES)[number]) => {
    if (!isDemo) return
    setPicked(r.u)
    setForm({ username: r.u, password: r.p })
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (picked && !isDemo) return
    try {
      const u = await login(form.username, form.password, industry)
      toast('登录成功')
      // 门店店长登录后直达 POS 收银台
      nav(u?.role === 'store' ? '/pos' : '/')
    } catch (err: any) {
      toast(err.message || '登录失败', 'error')
    }
  }

  return (
    <div className="h-full flex">
      {/* ---------------- 左：品牌区 ---------------- */}
      <div
        className="hidden lg:flex w-[44%] text-white flex-col justify-between p-10 relative overflow-hidden"
        style={{ background: 'linear-gradient(150deg,#0b3d68 0%,#185fa5 55%,#2b82c9 100%)' }}
      >
        <div className="relative z-10 flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center font-medium title-serif"
            style={{ background: 'rgba(255,255,255,.16)', border: '1px solid rgba(134,188,237,.5)' }}
          >
            {PRODUCT_GLYPH}
          </div>
          <div>
            <div className="text-[15px] font-medium title-serif">{PRODUCT_NAME}</div>
            <div className="text-[11.5px] text-white/55 mt-0.5">{PRODUCT_SUBTITLE}</div>
          </div>
        </div>

        <div className="relative z-10 max-w-md">
          <div className="w-12 h-[2px] mb-5" style={{ background: 'linear-gradient(90deg,#67e8f9,transparent)' }} />
          <h1 className="title-serif text-[27px] leading-10 font-medium mb-4">
            采购、库存与销售
            <br />
            让业务记录清楚可查
          </h1>
          <p className="text-[13px] text-white/75 leading-6 mb-6">
            线上 OMS · 采购闭环 · 多渠道销售 · 批次效期存货 · 门店 POS 与日结 · 经销商政策与对账 ·
            业财一体凭证。{enabled('agent_access') ? '当前演示开放 MCP，操作仍受角色权限与人工确认约束。' : '功能以当前实例已启用的范围为准。'}
          </p>
          <div className="grid grid-cols-2 gap-3">
            {[
              ['采购', '订单与到货记录'],
              ['库存', '批次与出入库明细'],
              ['销售', '订单与发货记录'],
              ['权限', '按角色划分操作范围']
            ].map(([n, t]) => (
              <div
                key={t}
                className="rounded-lg p-3"
                style={{ background: 'rgba(255,255,255,.09)', border: '1px solid rgba(134,188,237,.28)' }}
              >
                <div className="text-[19px] font-medium title-serif text-white">{n}</div>
                <div className="text-[11.5px] text-white/65 mt-0.5">{t}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="relative z-10">
          <div className="inline-flex items-center gap-1.5 text-[11.5px] px-2 py-1 rounded border border-cyan-300/40 bg-white/10">
            <Sparkles size={12} /> {isDemo ? 'DEMO 演示环境 · 数据为程序生成的虚构样例' : 'OS EGP · 企业业务管理'}
          </div>
        </div>
        <div className="absolute -right-24 -bottom-24 w-96 h-96 rounded-full bg-white/5" />
        <div className="absolute -right-10 -top-20 w-72 h-72 rounded-full bg-cyan-300/10" />
      </div>

      {/* ---------------- 右：登录表单 ---------------- */}
      <div className="flex-1 flex items-start lg:items-center justify-center p-6 overflow-y-auto">
        <div className="w-full max-w-[620px] py-6">
          <div className="lg:hidden mb-5 flex items-center gap-2.5">
            <div
              className="w-9 h-9 rounded-lg text-white flex items-center justify-center font-medium title-serif"
              style={{ background: 'linear-gradient(135deg,#185fa5 0%,#2b82c9 60%,#06b6d4 100%)' }}
            >
              {PRODUCT_GLYPH}
            </div>
            <div>
              <div className="text-[15px] font-medium text-ink-900 title-serif">{PRODUCT_NAME}</div>
              <div className="text-[11px] text-ink-500">{PRODUCT_SUBTITLE}</div>
            </div>
          </div>

          <h2 className="title-serif text-[21px] font-medium text-ink-900 mb-1">登录</h2>
          <p className="text-[13px] text-ink-600 mb-5">
            {isDemo ? '选择行业和演示角色，或使用自己的账号登录。' : '选择所属行业，使用管理员为你开通的账号登录。'}
          </p>

          {sessionNotice && <div role="status" className="mb-4 rounded border p-3 text-sm">{sessionNotice}<button className="link ml-3" onClick={dismissSessionNotice}>关闭提示</button></div>}
          <CapabilityStatus />
          {/* ① 行业版本 */}
          <div className="mb-5">
            <div className="text-[12px] text-slate-500 mb-2">
              ① 行业版本 <span className="text-slate-400">· 各行业独立数据库</span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              {industries.map((x) => {
                const m = INDUSTRY_META[x.code] || INDUSTRY_META.cosmetic
                const active = x.code === industry
                return (
                  <button
                    key={x.code}
                    type="button"
                    onClick={() => setIndustry(x.code)}
                    className="text-left rounded-lg px-3 py-2.5 transition"
                    style={{
                      background: active ? 'linear-gradient(135deg,#185fa5 0%,#2b82c9 100%)' : '#fff',
                      border: active ? '1px solid #185fa5' : '1px solid #e2e8f0',
                      boxShadow: active ? '0 4px 14px rgba(24,95,165,.22)' : 'none'
                    }}
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-[16px] leading-none">{m.emoji}</span>
                      <span className={`text-[13px] font-medium ${active ? 'text-white' : 'text-slate-700'}`}>{x.label}</span>
                    </div>
                    <div className={`text-[11px] mt-1 leading-4 ${active ? 'text-white/75' : 'text-slate-400'}`}>{isDemo ? m.sample : '按企业已配置的数据使用'}</div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* ② 演示角色仅在服务器确认的 demo/test 模式展示 */}
          {isDemo && <div className="mb-5">
            <div className="text-[12px] text-slate-500 mb-2">
              ② 演示角色 <span className="text-slate-400">· 点一张卡片即自动填入账号密码（共 {roles.length} 个）</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {roles.map((r) => {
                const on = picked === r.u
                return (
                  <button
                    key={r.u}
                    type="button"
                    onClick={() => pickRole(r)}
                    className="text-left rounded-lg px-3 py-2 transition"
                    style={{
                      background: on ? '#f1f8ff' : '#fff',
                      border: on ? '1px solid #2b82c9' : '1px solid #e2e8f0',
                      boxShadow: on ? '0 0 0 3px rgba(43,130,201,.10)' : 'none'
                    }}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className={`text-[13px] font-medium ${on ? 'text-brand-700' : 'text-slate-700'}`}>{r.label}</span>
                      <span className="text-[10.5px] text-slate-400 tabular-nums shrink-0">
                        {r.u} / {r.p}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5 leading-4">{r.scope}</div>
                  </button>
                )
              })}
            </div>
            {industry === 'food' && (
              <div className="text-[11px] text-slate-400 mt-1.5">
                连锁餐饮版为总部直营门店，<b>没有经销商</b>，所以不列经销商账号 —— 这是业务形态差异，不是权限没配。
              </div>
            )}
          </div>}

          {/* ③ 账号密码 */}
          <form onSubmit={submit} className="flex flex-col gap-3">
            <div className="text-[12px] text-slate-500 -mb-1">账号密码</div>
            <Field label="账号" required>
              <input
                className="input"
                value={picked && !isDemo ? '' : form.username}
                onChange={(e) => {
                  setForm({ ...form, username: e.target.value })
                  setPicked('')
                }}
                placeholder="请输入账号"
                autoComplete="username"
              />
            </Field>
            <Field label="密码" required>
              <input
                className="input"
                type="password"
                value={picked && !isDemo ? '' : form.password}
                onChange={(e) => {
                  setForm({ ...form, password: e.target.value })
                  setPicked('')
                }}
                placeholder="请输入密码"
                autoComplete="current-password"
              />
            </Field>
            <button className="btn-primary w-full h-10" disabled={loading}>
              {loading ? '登录中…' : '登 录'}
            </button>
          </form>

          {/* 其他入口 */}
          <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
            <a href="/pos" target="_blank" rel="noreferrer"
              className="border border-brand-200 bg-brand-50/60 rounded-md px-2.5 py-2 hover:bg-brand-50 transition">
              <div className="text-[12px] font-medium text-brand-700 flex items-center gap-1"><Monitor size={12} /> 门店 POS</div>
              <div className="text-[10.5px] text-slate-500 mt-0.5">店员收银台</div>
            </a>
            {enabled('public_mall') && <a href="/mall" target="_blank" rel="noreferrer"
              className="border border-brand-200 bg-brand-50/60 rounded-md px-2.5 py-2 hover:bg-brand-50 transition">
              <div className="text-[12px] font-medium text-brand-700">线上商城 H5</div>
              <div className="text-[10.5px] text-slate-500 mt-0.5">订单进 OMS</div>
            </a>}
            {isDemo && <a href="/docs/demo-flow.html" target="_blank" rel="noreferrer"
              className="border border-tech-200 bg-tech-50/60 rounded-md px-2.5 py-2 hover:bg-tech-50 transition">
              <div className="text-[12px] font-medium text-tech-700 flex items-center gap-1"><PlayCircle size={12} /> 演示手册</div>
              <div className="text-[10.5px] text-slate-500 mt-0.5">按角色排的剧本</div>
            </a>}
            <a href="/docs/manual.html" target="_blank" rel="noreferrer"
              className="border border-tech-200 bg-tech-50/60 rounded-md px-2.5 py-2 hover:bg-tech-50 transition">
              <div className="text-[12px] font-medium text-tech-700 flex items-center gap-1"><BookOpen size={12} /> 操作手册</div>
              <div className="text-[10.5px] text-slate-500 mt-0.5">19 个模块</div>
            </a>
          </div>

          {isDemo && <div className="mt-4 text-[11px] text-slate-400 leading-5">
            本系统为<b>演示环境</b>：商品、客户、门店、单据均为程序生成的虚构样例，不含真实商业数据。
            账号密码见上方角色卡片（重建数据后恢复默认）。
          </div>}
        </div>
      </div>
    </div>
  )
}
