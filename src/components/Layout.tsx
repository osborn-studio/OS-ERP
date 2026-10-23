/**
 * ============================================================================
 * 文件标识：src/components/Layout.tsx ｜ 应用外壳（侧栏菜单 / 顶栏 / 用户菜单）
 * ============================================================================
 * 【菜单可见性有两个正交维度，别合成一个】
 *   · `roles`      —— 这个**人**能不能看（权限）；
 *   · `industries` —— 这个**行业版本**有没有这个概念（业务形态）。
 *   例：经销商是"美妆/服装有、连锁餐饮没有"，与"谁能看经销商"是两件事。
 *
 * 【隐藏菜单 ≠ 安全边界】
 *   这里只做**界面收敛**。接口侧该拒的仍然拒（`requirePerm` / `requireRole`）；
 *   行业级隐藏另有 `src/App.tsx` 的 `<DealerOnly>` 路由守卫兜"直接贴地址"。
 *
 * 【改这里要注意】
 *   · 新增菜单项：同时确认 `App.tsx` 有对应 `<Route>`，否则是死链；
 *   · 新增一级分组时想清楚它回答什么问题（这一栏是"业务域"还是"配置"），
 *     放错会让客户按业务找功能时找不到。
 * ============================================================================
 */
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { useEffect, useState } from 'react'
import {
  LayoutDashboard, Package, ShoppingCart, ShoppingBag, Boxes, Users2,
  Store, Globe, Settings, ChevronDown, LogOut, Menu, Factory, BarChart3, Sparkles, Wrench, ClipboardList, Wallet, ShieldCheck, Ticket, Bot
} from 'lucide-react'
import { useAuth, ROLE_LABEL } from '../store/auth'
// 产品名的唯一出处（见 src/constants/brand.ts）
import { PRODUCT_NAME, PRODUCT_SUBTITLE, PRODUCT_GLYPH } from '../constants/brand'
import { ToastHost } from './ui'
import { useRuntimeCapabilities, type RuntimeCapability } from '../store/runtime-capabilities'
import { CapabilityStatus } from './CapabilityGate'
import ChangePasswordDialog from './ChangePasswordDialog'

/**
 * 菜单项。
 *
 * `roles` / `industries` 是**两个独立的可见性维度**，不要合成一个：
 *   · `roles`      —— 这个**人**能不能看（权限）；
 *   · `industries` —— 这个**行业版本**有没有这个概念（业务形态）。
 * 两者是正交的：经销商是"美妆/服装有、连锁餐饮没有"（业务形态），
 * 而"谁能看经销商"是权限。混在一起写会让"餐饮管理员看不见经销商"被误读成权限不足。
 *
 * ⚠️ 隐藏菜单只是**界面收敛**，不是权限边界：接口侧该拒的仍然拒（见 `routes/*` 的 requirePerm/requireRole）。
 *    菜单藏起来但接口能调，是"看起来安全"；接口拦住而菜单留着，是"看得见用不了"——
 *    后者对客户更友好，所以本文件只做前者（收敛），不假装它是安全措施。
 */
type MenuChild = { key: string; label: string; path: string; roles?: string[]; industries?: string[]; capability?: RuntimeCapability }
type MenuItem = {
  key: string
  label: string
  icon?: any
  path?: string
  children?: MenuChild[]
  roles?: string[]
  /** 不填 = 所有行业都有；填了就是白名单 */
  industries?: string[]
  capability?: RuntimeCapability
}

/**
 * 角色族（菜单授权用）。
 *
 * 为什么不在每个菜单项里直接写角色名：
 *   10 个角色 × 17 个菜单 = 写一百多处，加一个新角色要改十几处，漏一处就是"这个角色点进去 403"。
 *   这里把角色按**职责族**归并，菜单只引用族名；新增角色时只改这一张表。
 *
 * ⚠️ `admin` 不在任何族里 —— `canSee()` 对 admin 直接放行（管理员看全部）。
 * ⚠️ 族里没有 `viewer`：访客只拿"能看懂演示"的那几组，单独挂在下面几个菜单上。
 */
const ROLE_GROUPS: Record<string, string[]> = {
  exec: ['boss'], // 老板：全公司只读 + 关键审批
  supply: ['scm', 'purchase'], // 供应链主管 + 采购员
  stock: ['scm', 'purchase', 'warehouse'], // 再加仓管
  sell: ['scm', 'sales'], // 销售（供应链主管看得到，便于回答"货去哪了"）
  money: ['finance'], // 财务
  shop: ['store'], // 门店店长
  dealer: ['dealer'], // 经销商
  viewer: ['viewer'] // 只读访客
}
/** 取若干族的角色并集（自动去重） */
const rolesOf = (...groups: string[]) => [...new Set(groups.flatMap((g) => ROLE_GROUPS[g] || []))]

/** 菜单表：**导出**给「角色与权限」页做"这个角色能看到哪些菜单"的预览 ——
 *  预览必须与真实渲染同源，否则那一页会变成"说明书和实物不一致"。 */
export const MENUS: MenuItem[] = [
  { key: 'dashboard', label: '经营看板', icon: LayoutDashboard, path: '/' },
  { key: 'ai', label: 'AI 数据承接台', icon: Sparkles, path: '/ai', roles: rolesOf('exec', 'supply', 'sell', 'money', 'viewer') },
  // 订货中心：门店要货与经销商订货的统一入口（模块 12A）
  { key: 'order-center', label: '订货中心', icon: ShoppingBag, path: '/order-center', roles: rolesOf('exec', 'supply', 'sell', 'shop', 'dealer') },
  {
    key: 'master', label: '主数据', icon: Package, roles: rolesOf('exec', 'supply', 'sell', 'stock'), children: [
      { key: 'products', label: '商品档案', path: '/master/products' },
      { key: 'bundles', label: '组合装档案', path: '/master/bundles' },
      { key: 'brands', label: '品牌与品类', path: '/master/brands' },
      { key: 'partners', label: '供应商 / 经销商', path: '/master/partners' },
      { key: 'org', label: '仓库与门店', path: '/master/org' },
      { key: 'barcode', label: '条码 / 序列号识别', path: '/master/barcode' },
      // 出入库单据类型：客户可自行新建（客户口径），所以它要出现在主数据里而不是藏在代码里
      { key: 'invtxntypes', label: '出入库单据类型', path: '/master/inv-txn-types' }
    ]
  },
  {
    key: 'purchase', label: '采购管理', icon: Factory, roles: rolesOf('exec', 'supply', 'stock', 'money'), children: [
      // 采购工作台放最前：它按九环节横排，是进采购域的门
      { key: 'pw', label: '采购工作台', path: '/purchase/workbench' },
      { key: 'prq', label: '请购单', path: '/purchase/requisitions' },
      { key: 'po', label: '采购订单', path: '/purchase/orders' },
      { key: 'pr', label: '收货单', path: '/purchase/receipts' },
      { key: 'qc', label: '采购质检', path: '/purchase/inspections' },
      { key: 'pi', label: '采购发票', path: '/purchase/invoices', roles: rolesOf('exec', 'supply', 'money') },
      { key: 'pst', label: '采购结算', path: '/purchase/settlements', roles: rolesOf('exec', 'supply', 'money') },
      { key: 'pay', label: '付款单', path: '/purchase/payments', roles: rolesOf('exec', 'supply', 'money') },
      { key: 'ap', label: '应付台账', path: '/purchase/payables', roles: rolesOf('exec', 'supply', 'money') },
      { key: 'cat', label: '供货目录', path: '/purchase/catalog' },
      { key: 'prt', label: '采购退货', path: '/purchase/returns' }
    ]
  },
  { key: 'outsourcing', label: '委外管理', icon: Wrench, path: '/outsourcing/orders', roles: rolesOf('exec', 'supply', 'stock') },
  {
    key: 'plan', label: '计划与生产', icon: ClipboardList, roles: rolesOf('exec', 'supply', 'stock'), children: [
      { key: 'summary', label: '净需求汇总', path: '/plan/summary' },
      { key: 'production', label: '生产订单', path: '/plan/production' },
      // 制造中心：BOM / 领料 / 完工入库。放在生产订单之后 ——
      // 前面几页回答「要做什么」，这一页回答「照什么做、领什么料、入什么库」。
      { key: 'mfg', label: '制造中心（BOM / 领料 / 完工）', path: '/manufacture' }
    ]
  },
  {
    // 质量管理独立成组：质检的来源已经不止采购（生产完工、在库复检都进来了），
    // 挂在采购菜单下会让人以为它只管到货。采购质检（模块 07）保留一个入口做存量查询。
    key: 'quality', label: '质量管理', icon: ShieldCheck, roles: rolesOf('exec', 'supply', 'stock'), children: [
      { key: 'qccenter', label: '质量中心', path: '/quality/qc' },
      { key: 'purchaseqc', label: '采购质检（存量）', path: '/purchase/inspections' }
    ]
  },
  {
    key: 'sales', label: '销售管理', icon: ShoppingCart, roles: rolesOf('exec', 'supply', 'sell', 'money'), children: [
      { key: 'so', label: '销售订单', path: '/sales/orders' },
      // 报价在订单之前：先有价，才有单
      { key: 'quotes', label: '销售报价单', path: '/sales/quotes' },
      { key: 'credit', label: '信用控制', path: '/sales/credit' },
      { key: 'sd', label: '发货单', path: '/sales/deliveries' },
      // 开票排在发货之后：货发了，才谈得上开票
      { key: 'si', label: '销售发票', path: '/sales/invoices', roles: rolesOf('exec', 'supply', 'sell', 'money') },
      { key: 'srt', label: '销售退货', path: '/sales/returns' }
    ]
  },
  {
    key: 'finance', label: '财务应收', icon: Wallet, roles: rolesOf('exec', 'money'), children: [
      // 应收与收款核销：钱收到了抵的是哪一笔，这里是唯一答案
      { key: 'ar', label: '应收与收款核销', path: '/finance/receivables' },
      // 业财一体凭证：业务做完之后**账上到底记了什么**。与"应收"分开成页 ——
      // 前者回答"谁欠我多少"，后者回答"这本账平不平"，两者的使用者与出错后果都不同。
      { key: 'accounting', label: '财务中心（凭证 / 试算平衡）', path: '/finance/accounting' },
      // 退款单：退货时登记的「待退款」在这里兑现成出账。
      // 与"应收"分开成页 —— 前者是**钱进来**（收款核销），这里是**钱出去**（退款），
      // 授权粒度也不同（谁能放钱）。
      { key: 'refunds', label: '退款管理', path: '/finance/refunds' },
      // 财务报表：与"财务中心"分开成页 ——
      // 前者回答"**账记对了吗**"（凭证平不平、总账平不平），
      // 本页回答"**账读出来是什么**"（有多少家底、赚了多少、钱怎么来的）。
      // 授权粒度也不同：看报表 / 改报表口径 / 关账 / 改期初是四个独立的权限点。
      { key: 'reports', label: '财务报表（资产负债 / 利润 / 现金流）', path: '/finance/reports' },
      // 报表口径：与「财务报表」分开成页 ——
      // 前者回答"**这份账读出来是什么**"（给看数的人），
      // 本页回答"**它的结构是谁定的、改过什么**"（给管会计政策的人）。
      // 授权也分开了：`finance.report.view` 看报表，`finance.report.config` 改口径。
      // 这一页在批次 S 之前根本不存在，而接口与文档早就写着"会计政策，可追溯改过什么"。
      { key: 'report-config', label: '报表口径（会计政策 · 变更留痕）', path: '/finance/report-config' }
    ]
  },
  {
    key: 'oms', label: '线上 OMS', icon: Globe, roles: rolesOf('exec', 'supply', 'sell'), children: [
      { key: 'platforms', label: '平台店铺', path: '/oms/platforms' },
      { key: 'orders', label: '线上订单', path: '/oms/orders' },
      { key: 'qimen', label: '奇门对接中心', path: '/oms/qimen', capability: 'qimen_gateway' },
      { key: 'logs', label: '同步日志', path: '/oms/logs' }
    ]
  },
  {
    // 营销独立成组：促销与会员是**定价与客户权益**，跟"线上订单从哪来"（OMS）是两件事。
    // 挂在 OMS 下会让人以为它只管线上渠道 —— 门店 POS 与经销商订货同样吃这套价格与等级。
    key: 'marketing', label: '营销管理', icon: Ticket, roles: rolesOf('exec', 'sell'), children: [
      { key: 'promo', label: '营销中心（促销 / 券 / 会员）', path: '/marketing/promo' }
    ]
  },
  {
    key: 'inventory', label: '存货管理', icon: Boxes, roles: rolesOf('exec', 'supply', 'stock', 'money', 'viewer'), children: [
      { key: 'stocks', label: '库存查询', path: '/inventory/stocks' },
      { key: 'availability', label: '可用量报表', path: '/inventory/availability' },
      { key: 'ledger', label: '收发存台账', path: '/inventory/ledger' },
      { key: 'costing', label: '存货核算与成本', path: '/inventory/costing' },
      { key: 'serials', label: '序列号管理', path: '/inventory/serials' },
      { key: 'assembly', label: '组装 / 拆卸', path: '/inventory/assembly' },
      { key: 'transfers', label: '调拨管理', path: '/inventory/transfers' },
      { key: 'checks', label: '盘点管理', path: '/inventory/checks' },
      { key: 'alerts', label: '库存预警', path: '/inventory/alerts' },
      { key: 'aging', label: '库龄 / 呆滞 / ABC', path: '/inventory/aging' }
    ]
  },
  {
    key: 'store', label: '线下门店', icon: Store, roles: rolesOf('exec', 'supply', 'shop'), children: [
      { key: 'monitor', label: 'POS 运营监控', path: '/store/monitor' },
      { key: 'req', label: '门店要货（历史单）', path: '/store/requisitions' },
      { key: 'ship', label: '门店发货单', path: '/store/shipments' },
      { key: 'posorders', label: '门店单据明细', path: '/store/pos-orders' }
    ]
  },
  {
    // 经销商是"美妆 / 服装"的分销形态；**连锁餐饮没有经销商**（总部直营门店 + 供应商），
    // 所以这一组在连锁餐饮版里整体不出现（客户 2026-10-17 口径）。
    key: 'dealers', label: '经销商管理', icon: Users2, industries: ['cosmetic', 'apparel'], roles: rolesOf('exec', 'supply', 'sell'), children: [
      { key: 'overview', label: '经销商总览', path: '/dealers' },
      { key: 'dreq', label: '要货申请与计划（历史单）', path: '/dealers/requisitions' },
      { key: 'rebates', label: '返利管理', path: '/dealers/rebates' },
      { key: 'policies', label: '返点政策', path: '/dealers/policies' },
      { key: 'statements', label: '对账单（旧）', path: '/dealers/statements' },
      // 协议价与返利核销：挂在经销商组下是对的（主体都是经销商），
      // 但**独立成页**：它是政策与结算，不是客户档案。
      { key: 'channel', label: '渠道中心（协议价 / 返利核销）', path: '/dms/channel' }
    ]
  },
  {
    // AI 与 MCP 控制台：独立成一级入口（客户口径「最后有菜单，明确展示任何单据都有 MCP」）。
    // 放在「系统管理」之前而不是塞进它里面：这是**能力说明 + 覆盖核对**页，
    // 不是配置项，塞进系统管理会被当成"又一个设置页"而没人点。
    // 权限：看得到全部单据结构与权限点，属配置级信息 ⇒ 仅管理员（后端同样用 system.mcp.manage 拦）。
    key: 'mcp', label: 'AI 与 MCP 控制台', icon: Bot, path: '/system/mcp', roles: ['admin'], capability: 'agent_access'
  },
  {
    key: 'system', label: '系统管理', icon: Settings, roles: ['admin'], children: [
      { key: 'users', label: '用户与权限', path: '/system/users' },
      // 角色与权限：用户页管"谁是这个角色"，这一页管"这个角色能做什么"
      { key: 'roles', label: '角色与权限', path: '/system/roles' },
      { key: 'kernel', label: '单据内核（状态机）', path: '/system/doc-kernel' },
      { key: 'codeno', label: '编码规则', path: '/system/code-rules' },
      { key: 'approval', label: '审批中心', path: '/system/approval' },
      { key: 'metrics', label: '数据口径字典', path: '/system/metrics' },
      // 系统参数：排在「口径字典」之后 —— 前者是"这个指标怎么算"，后者是"业务规则配成什么"。
      // 会计政策（结转目标科目 / 年结留存科目 / 应收口径）都在这页，改动必须写理由。
      { key: 'settings', label: '系统参数（配置与变更历史）', path: '/system/settings' },
      { key: 'notify', label: '消息推送', path: '/system/notify' },
      { key: 'imSync', label: '钉钉/飞书同步', path: '/system/im-sync' },
      { key: 'dict', label: '枚举字典', path: '/system/dict' },
      { key: 'ai', label: 'AI 查询日志', path: '/system/ai-logs' }
    ]
  },
  // 我的数据范围：不写 roles = 每个登录用户可见（Z6）。只描述调用者自己，所以不需要权限点。
  { key: 'my-scope', label: '我的数据范围', icon: ShieldCheck, path: '/system/my-scope' }
]

function canSee(roles: string[] | undefined, role: string) {
  if (!roles) return true
  return role === 'admin' || roles.includes(role)
}

/** 行业可见性：没写 `industries` = 所有行业都有；写了就是白名单 */
function inIndustry(industries: string[] | undefined, industry: string) {
  if (!industries) return true
  return industries.includes(industry)
}

/**
 * 按「人（role）+ 行业版本（industry）」收敛菜单。
 * 两个维度都在这里判，页面里不要再写一遍 —— 否则"某个入口在別处漏出来"就是必然。
 */
/** 对外导出：某角色在某行业下能看到的菜单（角色权限页的预览用，与真实渲染同一条判据） */
export function menusForRole(role: string, industry: string, enabled: (id: RuntimeCapability) => boolean = () => false): { key: string; label: string; children?: { key: string; label: string }[] }[] {
  return filterMenus(role, industry, MENUS, enabled).map((m) => ({
    key: m.key,
    label: m.label,
    children: m.children ? m.children.map((c) => ({ key: c.key, label: c.label })) : undefined
  }))
}

function filterMenus(role: string, industry: string, menus: MenuItem[], enabled: (id: RuntimeCapability) => boolean): MenuItem[] {
  const out: MenuItem[] = []
  for (const m of menus) {
    if (!canSee(m.roles, role) || !inIndustry(m.industries, industry) || (m.capability && !enabled(m.capability))) continue
    if (m.children) {
      const ch = m.children.filter((c) => canSee(c.roles, role) && inIndustry(c.industries, industry) && (!c.capability || enabled(c.capability)))
      if (!ch.length) continue
      out.push({ ...m, children: ch })
    } else {
      out.push(m)
    }
  }
  return out
}

export default function Layout() {
  const { user, logout, industry } = useAuth()
  const { enabled } = useRuntimeCapabilities()
  const [changingPassword, setChangingPassword] = useState(false)
  const [loggingOut, setLoggingOut] = useState(false)
  const loc = useLocation()
  const [collapsed, setCollapsed] = useState(false)
  const [openKeys, setOpenKeys] = useState<string[]>(['dashboard'])
  const [userMenu, setUserMenu] = useState(false)
  const [drawer, setDrawer] = useState(false)

  useEffect(() => {
    const hit = MENUS.find((m) => m.children?.some((c) => loc.pathname.startsWith(c.path)))
    if (hit && !openKeys.includes(hit.key)) setOpenKeys((k) => [...k, hit.key])
    setUserMenu(false)
    setDrawer(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc.pathname])

  const menus = filterMenus(user?.role || 'viewer', industry, MENUS, enabled)

  const toggle = (k: string) => setOpenKeys((ks) => (ks.includes(k) ? ks.filter((x) => x !== k) : [...ks, k]))

  const currentTitle = (() => {
    for (const m of menus) {
      if (m.path && (m.path === '/' ? loc.pathname === '/' : loc.pathname.startsWith(m.path))) return m.label
      // 子菜单按路径长度倒序匹配，避免 /dealers 抢走 /dealers/policies
      const children = [...(m.children || [])].sort((a, b) => b.path.length - a.path.length)
      for (const c of children) {
        if (loc.pathname === c.path || loc.pathname.startsWith(c.path + '/')) return `${m.label} · ${c.label}`
      }
    }
    return PRODUCT_NAME
  })()

  return (
    <div className="h-full flex">
      <ToastHost />
      {/* 移动端遮罩 */}
      {drawer && (
        <div className="fixed inset-0 bg-black/30 z-30 lg:hidden" onClick={() => setDrawer(false)} />
      )}
      {/* 侧边栏：小屏抽屉，大屏固定 */}
      <aside
        className={`fixed lg:static inset-y-0 left-0 z-40 ${drawer ? 'translate-x-0' : '-translate-x-full'} lg:translate-x-0 ${collapsed ? 'w-[60px]' : 'w-[212px]'} shrink-0 bg-white border-r border-slate-200 flex flex-col transition-transform lg:transition-all`}
      >
        <div className="h-14 flex items-center gap-2 px-3 border-b border-ink-300">
          <div
            className="w-7 h-7 rounded-md text-white flex items-center justify-center text-[13px] font-medium shrink-0 title-serif shadow-glow"
            style={{ background: 'linear-gradient(135deg,#185fa5 0%,#2b82c9 58%,#06b6d4 100%)' }}
          >
            {PRODUCT_GLYPH}
          </div>
          {!collapsed && (
            <div className="min-w-0">
              <div className="text-[13px] font-medium text-ink-900 truncate title-serif">{PRODUCT_NAME}</div>
              <div className="flex items-center gap-1 mt-0.5">
                <span className="text-[10px] leading-4 px-1 rounded border border-tech-200 bg-tech-50 text-tech-700 shrink-0">
                  {enabled('agent_access') ? 'MCP 演示可用' : '业务管理'}
                </span>
                <span className="text-[11px] text-ink-600 truncate" title={PRODUCT_SUBTITLE}>
                  {user?.industryName ? `${user.industryName}版` : industry === 'apparel' ? '服装版（开发中）' : industry === 'food' ? '连锁餐饮版' : '美妆连锁版'}
                </span>
              </div>
            </div>
          )}
        </div>
        <div className="h-[2px] shrink-0" style={{ background: 'linear-gradient(90deg,#185fa5 0%,#06b6d4 55%,transparent 100%)' }} />

        <nav className="flex-1 overflow-y-auto py-2">
          {menus.map((m) => {
            const Icon = m.icon
            if (m.path) {
              return (
                <NavLink
                  key={m.key}
                  to={m.path}
                  className={({ isActive }) =>
                    `flex items-center gap-2.5 mx-2 px-2.5 h-9 rounded-md text-[13px] ${
                      isActive ? 'bg-brand-50 text-brand-700 font-medium' : 'text-slate-600 hover:bg-slate-50'
                    }`
                  }
                >
                  {Icon && <Icon size={16} className="shrink-0" />}
                  {!collapsed && <span className="truncate">{m.label}</span>}
                </NavLink>
              )
            }
            const open = openKeys.includes(m.key)
            return (
              <div key={m.key}>
                <div
                  className="flex items-center gap-2.5 mx-2 px-2.5 h-9 rounded-md text-[13px] text-slate-600 hover:bg-slate-50 cursor-pointer"
                  onClick={() => (collapsed ? setCollapsed(false) : toggle(m.key))}
                >
                  {Icon && <Icon size={16} className="shrink-0" />}
                  {!collapsed && (
                    <>
                      <span className="flex-1 truncate">{m.label}</span>
                      <ChevronDown size={14} className={`transition-transform ${open ? '' : '-rotate-90'}`} />
                    </>
                  )}
                </div>
                {open && !collapsed && (
                  <div className="mt-0.5 mb-1">
                    {m.children!.map((c) => (
                      <NavLink
                        key={c.key}
                        to={c.path}
                        className={({ isActive }) =>
                          `flex items-center h-8 pl-9 pr-3 mx-2 rounded-md text-[13px] ${
                            isActive ? 'text-brand-700 font-medium bg-brand-50/70' : 'text-slate-500 hover:text-slate-700 hover:bg-slate-50'
                          }`
                        }
                      >
                        <span className="truncate">{c.label}</span>
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </nav>

        <div className="p-2 border-t border-slate-200">
          <button className="btn-ghost btn-sm w-full" onClick={() => setCollapsed((c) => !c)}>
            <Menu size={14} />
            {!collapsed && <span>收起菜单</span>}
          </button>
        </div>
      </aside>

      {/* 主区域 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <header className="h-14 bg-white border-b border-ink-300 flex items-center justify-between px-3 lg:px-4 shrink-0 gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <button className="lg:hidden w-8 h-8 flex items-center justify-center text-slate-500" onClick={() => setDrawer(true)}>
              <Menu size={18} />
            </button>
            <div className="text-[14px] font-medium text-ink-900 title-serif truncate">{currentTitle}</div>
          </div>
          <div className="flex items-center gap-2 lg:gap-3">
            <a href="/pos" target="_blank" rel="noreferrer" className="hidden sm:flex text-[12px] text-slate-400 hover:text-brand-700 items-center gap-1">
              <Store size={13} /> 门店 POS
            </a>
            {enabled('public_mall') && <a href="/mall" target="_blank" rel="noreferrer" className="hidden sm:flex text-[12px] text-slate-400 hover:text-brand-700 items-center gap-1">
              <Globe size={13} /> 线上商城
            </a>}
            <a href="/api/openapi.json" target="_blank" rel="noreferrer" className="hidden md:flex text-[12px] text-slate-400 hover:text-brand-700 items-center gap-1">
              <BarChart3 size={13} /> API 文档
            </a>
            <div className="relative">
              <button
                className="flex items-center gap-2 h-9 px-2 rounded-md hover:bg-slate-50"
                onClick={() => setUserMenu((v) => !v)}
              >
                <div className="w-7 h-7 rounded-full bg-brand-100 text-brand-700 flex items-center justify-center text-[12px] font-medium">
                  {(user?.name || 'U').slice(0, 1)}
                </div>
                <div className="text-left leading-tight">
                  <div className="text-[13px] text-slate-700">{user?.name}</div>
                  <div className="text-[11px] text-slate-400">{ROLE_LABEL[user?.role] || user?.role}</div>
                </div>
                <ChevronDown size={14} className="text-slate-400" />
              </button>
              {userMenu && (
                <div className="absolute right-0 top-11 w-44 bg-white border border-slate-200 rounded-md shadow-lg py-1 z-50">
                  <div className="px-3 py-2 text-[12px] text-slate-400 border-b border-slate-100">
                    {user?.username} · {ROLE_LABEL[user?.role] || user?.role}
                  </div>
                  <button className="w-full text-left px-3 py-2 text-[13px] text-slate-600 hover:bg-slate-50" onClick={() => { setUserMenu(false); setChangingPassword(true) }}>修改密码</button>
                  <button
                    className="w-full text-left px-3 py-2 text-[13px] text-slate-600 hover:bg-slate-50 flex items-center gap-2"
                    disabled={loggingOut}
                    onClick={async () => {
                      setLoggingOut(true)
                      try { await logout() } finally { setLoggingOut(false) }
                    }}
                  >
                    <LogOut size={14} /> {loggingOut ? '正在退出…' : '退出全部会话'}
                  </button>
                </div>
              )}
            </div>
          </div>
        </header>

        <main className="flex-1 overflow-y-auto p-3 lg:p-4">
          <CapabilityStatus />
          <Outlet />
          {changingPassword && <ChangePasswordDialog onClose={() => setChangingPassword(false)} />}
        </main>
      </div>
    </div>
  )
}
