/**
 * ============================================================================
 * 文件标识：src/App.tsx ｜ 前端路由表（谁能进哪个页面）
 * ============================================================================
 * 【这里有三层拦截，顺序不能反】
 *   1) 未登录 → `<Navigate to="/login" />`；
 *   2) 行业能力（如"经销商只有美妆/服装有"）→ `<DealerOnly>` 守卫，**直接贴地址也回首页**；
 *   3) 页面内部再按 `roles` 收敛按钮（见各页）。
 *   菜单隐藏只是"点不到"，路由守卫才是"进不去"—— 两者都要有，客户不会只点菜单。
 *
 * 【改这里要注意】
 *   · 新增页面：这里加 `<Route>` + `src/components/Layout.tsx` 加菜单项（**两处都要**，漏一处就是死页）；
 *   · 经销商/行业相关页面：包 `<DealerOnly>`，不要自己在页面里判 `industry`；
 *   · 路由路径是契约的一部分（`check-contract-routes` 会比对接口，不比对页面，但页面路径变了要同步文档）。
 * ============================================================================
 */
import { Navigate, Route, Routes } from 'react-router-dom'
import { useEffect, useState } from 'react'
import api from './api/client'
import { ToastHost } from './components/ui'
import CapabilityGate from './components/CapabilityGate'
import SessionBoundary from './components/SessionBoundary'
// 行业能力（经销商只有美妆/服装有）：菜单藏起来只挡得住点击，挡不住直接贴地址
import { hasDealer } from './constants/capabilities'
import { useAuth } from './store/auth'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import AiConsole from './pages/AiConsole'
import Products from './pages/master/Products'
import Brands from './pages/master/Brands'
import Partners from './pages/master/Partners'
import Org from './pages/master/Org'
import PurchaseOrders from './pages/purchase/Orders'
import PurchaseOrderDetail from './pages/purchase/OrderDetail'
import PurchaseReceipts from './pages/purchase/Receipts'
import PurchaseReturns from './pages/purchase/Returns'
import Inspections from './pages/purchase/Inspections'
// 模块 13：质量检验独立成单（报检 / 检验 / 不良品处理）
import QcCenter from './pages/quality/QcCenter'
// 模块 10B：生产制造（BOM / 领料 / 完工入库）
import MfgCenter from './pages/manufacture/MfgCenter'
// 模块 18：营销中心（促销 / 券 / 会员等级积分储值 / 试算器）
import PromoCenter from './pages/marketing/PromoCenter'
import PurchaseWorkbench from './pages/purchase/Workbench'
import Requisitions from './pages/purchase/Requisitions'
import Invoices from './pages/purchase/Invoices'
import Settlements from './pages/purchase/Settlements'
import Payments from './pages/purchase/Payments'
import Payables from './pages/purchase/Payables'
import PurchaseCatalog from './pages/purchase/Catalog'
import SalesOrders from './pages/sales/Orders'
import SalesOrderDetail from './pages/sales/OrderDetail'
import SalesDeliveries from './pages/sales/Deliveries'
import SalesReturns from './pages/sales/Returns'
import OmsPlatforms from './pages/oms/Platforms'
import OmsOrders from './pages/oms/Orders'
import OmsLogs from './pages/oms/Logs'
import StockList from './pages/inventory/Stocks'
import Ledger from './pages/inventory/Ledger'
import Costing from './pages/inventory/Costing'
// 模块 08A：销售报价单 + 信用控制
import Quotes from './pages/sales/Quotes'
import Credit from './pages/sales/Credit'
// 模块 21：应收与收款核销
import Receivables from './pages/finance/Receivables'
// 模块 24：销售发票（销售链最后一环；与采购发票 Invoices 重名，故另起别名）
import SalesInvoices from './pages/sales/Invoices'
import Transfers from './pages/inventory/Transfers'
import Checks from './pages/inventory/Checks'
import Alerts from './pages/inventory/Alerts'
import Serials from './pages/inventory/Serials'
import Availability from './pages/inventory/Availability'
import Aging from './pages/inventory/Aging'
import Assembly from './pages/inventory/Assembly'
import Bundles from './pages/master/Bundles'
import Barcode from './pages/master/Barcode'
import InvTxnTypes from './pages/master/InvTxnTypes'
import Qimen from './pages/oms/Qimen'
import Policies from './pages/dealers/Policies'
import DealerOverview from './pages/dealers/Overview'
import DealerProfile from './pages/dealers/Profile'
import Rebates from './pages/dealers/Rebates'
// 模块 26：渠道中心（协议价 / 返利计提与核销）
import ChannelCenter from './pages/dms/ChannelCenter'
import Accounting from './pages/finance/Accounting'
import Refunds from './pages/finance/Refunds'
import Reports from './pages/finance/Reports'
import ReportConfig from './pages/finance/ReportConfig'
import Statements from './pages/dealers/Statements'
import Users from './pages/system/Users'
import MyScope from './pages/system/MyScope'
import Dict from './pages/system/Dict'
import AiLogs from './pages/system/AiLogs'
import AuditLogs from './pages/system/AuditLogs'
import DocKernel from './pages/system/DocKernel'
import CodeRules from './pages/system/CodeRules'
import Notify from './pages/system/Notify'
import ImSync from './pages/system/ImSync'
import Approval from './pages/system/Approval'
import Metrics from './pages/system/Metrics'
// 批次 R：系统参数（配置的定义 / 当前值 / 变更历史）。
// 别名 `SystemSettings`：本文件与 `Layout.tsx` 里都有 lucide 的 `Settings` 图标名，
// 直接叫 `Settings` 会撞名（TS 会在 import 处报重复标识符，而不是在用到的地方）。
import SystemSettings from './pages/system/Settings'
// AI 与 MCP 控制台：把「哪些单据能被 AI 读/写、哪些必须人工确认」摊开成一张表
import McpCenter from './pages/system/McpCenter'
// 角色与权限：功能权限矩阵（可改）+ 该角色可见菜单（只读预览）
import Roles from './pages/system/Roles'
import PosApp from './pages/pos/PosApp'
import HqMonitor from './pages/pos/HqMonitor'
import PosOrders from './pages/pos/PosOrders'
import MallApp from './pages/mall/MallApp'
import StoreRequisitions from './pages/requisitions/StoreRequisitions'
import StoreShipments from './pages/requisitions/StoreShipments'
import OrderCenterPage from './pages/order-center/OrderCenter'
import OutsourcingOrders from './pages/outsourcing/Orders'
import DealerRequisitions from './pages/demand/DealerRequisitions'
import DemandSummary from './pages/demand/Summary'
import ProductionOrders from './pages/demand/ProductionOrders'

function RequireAuth({ children }: { children: JSX.Element }) {
  const { token } = useAuth()
  if (!token) return <Navigate to="/login" replace />
  return <SessionBoundary>{children}</SessionBoundary>
}

function HomePage() {
  const { token } = useAuth()
  const [destination, setDestination] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    setDestination(null)
    api.get('/auth/me').then((r: any) => {
      if (!live) return
      const me = r.data
      const home: Record<string, string> = {
        store: '/pos', dealer: '/order-center', purchase: '/purchase/workbench',
        warehouse: '/inventory/stocks', sales: '/sales/orders'
      }
      setDestination(me.role === 'store' || me.role === 'dealer' || me.orgScope?.scope !== 'all'
        ? home[me.role] || '/order-center' : '/')
    }).catch(() => { if (live) setDestination('/login') })
    return () => { live = false }
  }, [token])
  if (destination === null) return null
  return destination === '/' ? <Dashboard /> : <Navigate to={destination} replace />
}

function GlobalPage({ children, permissions, requireGlobalScope = true }: { children: JSX.Element; permissions: string[]; requireGlobalScope?: boolean }) {
  const { token } = useAuth()
  const [allowed, setAllowed] = useState<boolean | null>(null)
  const key = permissions.join(',')
  useEffect(() => {
    let live = true
    setAllowed(null)
    api.get('/auth/me').then((r: any) => {
      if (live) setAllowed((!requireGlobalScope || r.data.orgScope?.scope === 'all') && key.split(',').some(p => r.data.permissions?.includes(p)))
    }).catch(() => { if (live) setAllowed(false) })
    return () => { live = false }
  }, [token, key, requireGlobalScope])
  if (allowed === null) return null
  return allowed ? children : <Navigate to="/" replace />
}

/**
 * 经销商专属页的守卫：**没有这个概念的行业直接回首页**。
 *
 * 为什么要有它（而不是只靠菜单隐藏）：菜单只影响能不能点到，不影响直接贴地址。
 * 客户口径是「连锁餐饮版里的经销商全部去掉」—— 那么直接访问 /dealers 也不该出现内容。
 * 注意：这不替代后端权限，接口侧该拒的仍拒；这里只保证「界面不出现这一块」。
 */
function DealerOnly({ children }: { children: any }) {
  const { industry } = useAuth()
  if (!hasDealer(industry)) return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* 门店 POS 收银（独立触屏界面，店员登录） */}
      <Route path="/pos" element={<SessionBoundary><PosApp /><ToastHost /></SessionBoundary>} />
      {/* H5 线上商城（手机端，免登录浏览，下单手机号标识） */}
      <Route path="/mall" element={<CapabilityGate capability="public_mall" label="线上商城"><MallApp /></CapabilityGate>} />
      <Route
        element={
          <RequireAuth>
            <Layout />
          </RequireAuth>
        }
      >
        <Route path="/" element={<HomePage />} />
        <Route path="/ai" element={<GlobalPage permissions={['ai.chat']}><AiConsole /></GlobalPage>} />
        <Route path="/master/products" element={<Products />} />
        <Route path="/master/brands" element={<Brands />} />
        <Route path="/master/partners" element={<Partners />} />
        <Route path="/master/org" element={<Org />} />
        <Route path="/master/bundles" element={<Bundles />} />
        <Route path="/master/barcode" element={<Barcode />} />
        <Route path="/master/inv-txn-types" element={<InvTxnTypes />} />
        <Route path="/purchase/workbench" element={<PurchaseWorkbench />} />
        <Route path="/purchase/requisitions" element={<Requisitions />} />
        <Route path="/purchase/orders" element={<PurchaseOrders />} />
        <Route path="/purchase/orders/:id" element={<PurchaseOrderDetail />} />
        <Route path="/purchase/receipts" element={<PurchaseReceipts />} />
        <Route path="/purchase/invoices" element={<Invoices />} />
        <Route path="/purchase/settlements" element={<Settlements />} />
        <Route path="/purchase/payments" element={<Payments />} />
        <Route path="/purchase/payables" element={<Payables />} />
        <Route path="/purchase/catalog" element={<PurchaseCatalog />} />
        <Route path="/purchase/returns" element={<PurchaseReturns />} />
        <Route path="/purchase/inspections" element={<Inspections />} />
        <Route path="/quality/qc" element={<QcCenter />} />
        <Route path="/sales/orders" element={<SalesOrders />} />
        <Route path="/sales/orders/:id" element={<SalesOrderDetail />} />
        <Route path="/sales/quotes" element={<Quotes />} />
        <Route path="/sales/credit" element={<Credit />} />
        <Route path="/finance/receivables" element={<Receivables />} />
        <Route path="/sales/deliveries" element={<SalesDeliveries />} />
        <Route path="/sales/invoices" element={<SalesInvoices />} />
        <Route path="/sales/returns" element={<SalesReturns />} />
        <Route path="/oms/platforms" element={<OmsPlatforms />} />
        <Route path="/oms/orders" element={<OmsOrders />} />
        <Route path="/oms/logs" element={<OmsLogs />} />
        <Route path="/oms/qimen" element={<CapabilityGate capability="qimen_gateway" label="奇门对接"><Qimen /></CapabilityGate>} />
        <Route path="/inventory/stocks" element={<StockList />} />
        <Route path="/inventory/ledger" element={<Ledger />} />
        <Route path="/inventory/costing" element={<Costing />} />
        <Route path="/inventory/transfers" element={<Transfers />} />
        <Route path="/inventory/checks" element={<Checks />} />
        <Route path="/inventory/alerts" element={<Alerts />} />
        <Route path="/inventory/serials" element={<Serials />} />
        <Route path="/inventory/availability" element={<Availability />} />
        <Route path="/inventory/aging" element={<Aging />} />
        <Route path="/inventory/assembly" element={<Assembly />} />
        <Route path="/dealers" element={<DealerOnly><DealerOverview /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/dealers/rebates" element={<DealerOnly><Rebates /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/dealers/policies" element={<DealerOnly><Policies /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/dms/channel" element={<DealerOnly><ChannelCenter /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/finance/accounting" element={<GlobalPage permissions={['finance.subject.view', 'finance.voucher.view']}><Accounting /></GlobalPage>} />
        <Route path="/finance/refunds" element={<Refunds />} />
        <Route path="/finance/reports" element={<Reports />} />
        <Route path="/finance/report-config" element={<ReportConfig />} />
        <Route path="/dealers/statements" element={<DealerOnly><Statements /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/dealers/:id" element={<DealerOnly><DealerProfile /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/store/monitor" element={<HqMonitor />} />
        <Route path="/order-center" element={<OrderCenterPage />} />
        <Route path="/store/requisitions" element={<StoreRequisitions />} />
        <Route path="/store/shipments" element={<StoreShipments />} />
        <Route path="/store/pos-orders" element={<PosOrders />} />
        <Route path="/outsourcing/orders" element={<OutsourcingOrders />} />
        <Route path="/dealers/requisitions" element={<DealerOnly><DealerRequisitions /></DealerOnly>} />{/* 经销商专属：{path}（连锁餐饮无此概念，直接贴地址也回首页） */}
        <Route path="/plan/summary" element={<DemandSummary />} />
        <Route path="/plan/production" element={<ProductionOrders />} />
        <Route path="/manufacture" element={<MfgCenter />} />
        <Route path="/marketing/promo" element={<PromoCenter />} />
        <Route path="/pos/hq/orders" element={<PosOrders />} />
        <Route path="/system/users" element={<Users />} />
        <Route path="/system/my-scope" element={<MyScope />} />
        <Route path="/system/roles" element={<Roles />} />
        <Route path="/system/dict" element={<Dict />} />
        <Route path="/system/ai-logs" element={<AiLogs />} />
        <Route path="/system/audit-logs" element={<AuditLogs />} />
        <Route path="/system/doc-kernel" element={<DocKernel />} />
        <Route path="/system/code-rules" element={<CodeRules />} />
        <Route path="/system/notify" element={<Notify />} />
        <Route path="/system/im-sync" element={<ImSync />} />
        <Route path="/system/approval" element={<Approval />} />
        <Route path="/system/metrics" element={<Metrics />} />
        <Route path="/system/settings" element={<SystemSettings />} />
        <Route path="/system/mcp" element={<CapabilityGate capability="agent_access" label="AI 与 MCP 控制台"><GlobalPage permissions={['system.mcp.manage']} requireGlobalScope={false}><McpCenter /></GlobalPage></CapabilityGate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  )
}
