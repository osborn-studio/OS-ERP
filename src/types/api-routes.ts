// ⚠️ 本文件由 scripts/gen-api-types.mjs 自动生成，请勿手改。
// 改接口请改 server/openapi.js，然后执行：npm run gen:api
//
// 生成源：server/openapi.js ｜ OpenAPI 3.0.3 ｜ 契约版本 1.44.0
//
// ============================================================================
// 文件标识：src/types/api-routes.ts ｜ 【自动生成，勿手改】接口路径与标签的类型定义
// ============================================================================
// 【职责】把 openapi 的路径、标签生成为前端可直接 import 的联合类型，让调用方拿到路径约束
// 【入口】生成源是 server/openapi.js；重生成用 npm run gen:api（**不要手改本文件**）
// 【注意】本文件由脚本写出：**文件标识块也必须由脚本输出**，否则下次 gen:api 会把它冲掉 ——
//   "登记了不等于守住了"。改格式请改 scripts/gen-api-types.mjs。
// ============================================================================
// 路径 526 条 ｜ 标签 34 个
//
// 用法：
//   import { typedGet, typedPost } from '../api/typed'
//   typedGet('/api/purchase/chain/overview')   // 路径写错编译期就报

export const OPENAPI_VERSION = '1.44.0'
export const API_ROUTE_COUNT = 526

/** 全部已登记的接口路径 */
export type ApiRoute =
  | '/api/accounting/audit'
  | '/api/accounting/meta'
  | '/api/accounting/subjects'
  | '/api/accounting/subjects/tree'
  | '/api/accounting/subjects/{id}'
  | '/api/accounting/subjects/{id}/status'
  | '/api/accounting/templates'
  | '/api/accounting/templates/{bizType}'
  | '/api/accounting/trial-balance'
  | '/api/accounting/trial-balance/detail'
  | '/api/accounting/vouchers'
  | '/api/accounting/vouchers/by-source/{sourceType}/{sourceId}'
  | '/api/accounting/vouchers/generate'
  | '/api/accounting/vouchers/plan'
  | '/api/accounting/vouchers/{id}'
  | '/api/accounting/vouchers/{id}/post'
  | '/api/accounting/vouchers/{id}/void'
  | '/api/ai/logs'
  | '/api/ai/manifest'
  | '/api/ai/metrics'
  | '/api/ai/query'
  | '/api/ai/schema'
  | '/api/approval/check'
  | '/api/approval/instances'
  | '/api/approval/instances/{id}'
  | '/api/approval/instances/{id}/cancel'
  | '/api/approval/instances/{id}/decide'
  | '/api/approval/meta'
  | '/api/approval/overview'
  | '/api/approval/pending'
  | '/api/approval/templates'
  | '/api/approval/templates/{id}/toggle'
  | '/api/approval/todos'
  | '/api/ar/aging'
  | '/api/ar/aging/detail'
  | '/api/ar/aging/subjects'
  | '/api/ar/audit'
  | '/api/ar/documents'
  | '/api/ar/documents/generate'
  | '/api/ar/documents/{id}'
  | '/api/ar/meta'
  | '/api/ar/oc/pending'
  | '/api/ar/oc/sync'
  | '/api/ar/overview'
  | '/api/ar/prepay'
  | '/api/ar/prepay/apply'
  | '/api/ar/prepay/detail'
  | '/api/ar/recalc'
  | '/api/ar/receipts'
  | '/api/ar/receipts/{id}'
  | '/api/ar/receipts/{id}/confirm'
  | '/api/ar/receipts/{id}/review'
  | '/api/ar/receipts/{id}/void'
  | '/api/ar/statement'
  | '/api/auth/change-password'
  | '/api/auth/industries'
  | '/api/auth/login'
  | '/api/auth/logout-all'
  | '/api/auth/me'
  | '/api/auth/my-permissions'
  | '/api/auth/my-scope'
  | '/api/auth/permissions'
  | '/api/auth/roles-permissions'
  | '/api/auth/roles/{code}/permissions'
  | '/api/auth/users'
  | '/api/costing/adjustments'
  | '/api/costing/adjustments/{id}'
  | '/api/costing/adjustments/{id}/adjust'
  | '/api/costing/adjustments/{id}/cancel'
  | '/api/costing/audit'
  | '/api/costing/layers'
  | '/api/costing/meta'
  | '/api/costing/overview'
  | '/api/costing/periods'
  | '/api/costing/periods/close'
  | '/api/costing/variances'
  | '/api/credit/accounts'
  | '/api/credit/accounts/{id}'
  | '/api/credit/adjust'
  | '/api/credit/audit'
  | '/api/credit/check'
  | '/api/credit/checks'
  | '/api/credit/ledger'
  | '/api/credit/meta'
  | '/api/credit/overview'
  | '/api/credit/release'
  | '/api/credit/settle'
  | '/api/dashboard/channel'
  | '/api/dashboard/inventory-dist'
  | '/api/dashboard/recent'
  | '/api/dashboard/summary'
  | '/api/dashboard/todos'
  | '/api/dashboard/top'
  | '/api/dashboard/trend'
  | '/api/dealers/overview'
  | '/api/dealers/policies'
  | '/api/dealers/policies/{id}'
  | '/api/dealers/rebates'
  | '/api/dealers/rebates/calc'
  | '/api/dealers/rebates/preview'
  | '/api/dealers/rebates/{id}'
  | '/api/dealers/statements'
  | '/api/dealers/statements/{id}'
  | '/api/dealers/statements/{id}/close'
  | '/api/dealers/statements/{id}/status'
  | '/api/dealers/statements/{id}/void'
  | '/api/dealers/{id}/credit'
  | '/api/dealers/{id}/profile'
  | '/api/dealers/{id}/purchase-analysis'
  | '/api/demand/dealer/plans'
  | '/api/demand/dealer/plans/mine'
  | '/api/demand/dealer/requisitions'
  | '/api/demand/dealer/requisitions/mine'
  | '/api/demand/dealer/requisitions/{id}'
  | '/api/demand/dealer/requisitions/{id}/status'
  | '/api/demand/dealer/summary'
  | '/api/demand/dealer/summary/runs'
  | '/api/demand/dealer/summary/to-orders'
  | '/api/demand/production/orders'
  | '/api/demand/production/orders/{id}'
  | '/api/demand/production/orders/{id}/status'
  | '/api/dms/agreements'
  | '/api/dms/agreements/explain'
  | '/api/dms/agreements/{id}'
  | '/api/dms/agreements/{id}/status'
  | '/api/dms/meta'
  | '/api/dms/policies'
  | '/api/dms/rebate-audit'
  | '/api/dms/rebates'
  | '/api/dms/rebates/accrue'
  | '/api/dms/rebates/plan'
  | '/api/dms/rebates/settle'
  | '/api/dms/rebates/{id}/confirm'
  | '/api/dms/settlements'
  | '/api/dms/settlements/{id}'
  | '/api/docflow/no-issue'
  | '/api/docflow/no-preview'
  | '/api/docflow/no-rules'
  | '/api/im/audit'
  | '/api/im/conflicts'
  | '/api/im/mappings'
  | '/api/im/meta'
  | '/api/im/platforms'
  | '/api/im/runs'
  | '/api/im/self-test'
  | '/api/im/status'
  | '/api/im/sync/approval'
  | '/api/im/sync/org'
  | '/api/inventory/adjust'
  | '/api/inventory/alerts'
  | '/api/inventory/assembly'
  | '/api/inventory/assembly/{id}'
  | '/api/inventory/assembly/{id}/cancel'
  | '/api/inventory/assembly/{id}/confirm'
  | '/api/inventory/checks'
  | '/api/inventory/checks/{id}'
  | '/api/inventory/checks/{id}/adjust'
  | '/api/inventory/checks/{id}/cancel'
  | '/api/inventory/checks/{id}/items'
  | '/api/inventory/ledger'
  | '/api/inventory/serials/trace/{serialNo}'
  | '/api/inventory/stats'
  | '/api/inventory/stocks'
  | '/api/inventory/stocks/by-sku'
  | '/api/inventory/transactions'
  | '/api/inventory/transfers'
  | '/api/inventory/transfers/{id}'
  | '/api/inventory/transfers/{id}/cancel'
  | '/api/inventory/transfers/{id}/receive'
  | '/api/inventory/transfers/{id}/ship'
  | '/api/inventory/transfers/{id}/submit'
  | '/api/invoices/audit'
  | '/api/invoices/from-delivery'
  | '/api/invoices/list'
  | '/api/invoices/manual'
  | '/api/invoices/meta'
  | '/api/invoices/overview'
  | '/api/invoices/pending'
  | '/api/invoices/pending/{deliveryId}'
  | '/api/invoices/refresh-close'
  | '/api/invoices/{id}'
  | '/api/invoices/{id}/confirm'
  | '/api/invoices/{id}/red-chart'
  | '/api/invoices/{id}/submit'
  | '/api/invoices/{id}/void'
  | '/api/mall/cart'
  | '/api/mall/cart/update'
  | '/api/mall/coupons'
  | '/api/mall/home'
  | '/api/mall/login'
  | '/api/mall/member'
  | '/api/mall/orders'
  | '/api/mall/orders/{id}/cancel'
  | '/api/mall/products'
  | '/api/mall/products/{skuId}'
  | '/api/mall/quote'
  | '/api/mall/session'
  | '/api/manufacture/audit'
  | '/api/manufacture/boms'
  | '/api/manufacture/boms/by-sku'
  | '/api/manufacture/boms/{id}'
  | '/api/manufacture/boms/{id}/audit'
  | '/api/manufacture/boms/{id}/expand'
  | '/api/manufacture/boms/{id}/obsolete'
  | '/api/manufacture/issues'
  | '/api/manufacture/issues/{id}'
  | '/api/manufacture/issues/{id}/approve'
  | '/api/manufacture/issues/{id}/cancel'
  | '/api/manufacture/issues/{id}/issue'
  | '/api/manufacture/issues/{id}/submit'
  | '/api/manufacture/meta'
  | '/api/manufacture/orders'
  | '/api/manufacture/orders/{id}'
  | '/api/manufacture/orders/{id}/complete'
  | '/api/manufacture/orders/{id}/complete-preview'
  | '/api/manufacture/orders/{id}/requirement'
  | '/api/manufacture/orders/{id}/start'
  | '/api/manufacture/overview'
  | '/api/manufacture/reports'
  | '/api/manufacture/reports/{id}'
  | '/api/master/brands'
  | '/api/master/bundles'
  | '/api/master/bundles/{id}'
  | '/api/master/categories'
  | '/api/master/dealers'
  | '/api/master/inv-txn-types'
  | '/api/master/inv-txn-types/{code}'
  | '/api/master/options'
  | '/api/master/overview'
  | '/api/master/platforms'
  | '/api/master/products'
  | '/api/master/products/{id}'
  | '/api/master/scan'
  | '/api/master/skus'
  | '/api/master/stores'
  | '/api/master/suppliers'
  | '/api/master/warehouses'
  | '/api/master/warehouses/{id}'
  | '/api/mcp/catalog'
  | '/api/mcp/confirmations'
  | '/api/mcp/confirmations/{token}/approve'
  | '/api/mcp/confirmations/{token}/reject'
  | '/api/mcp/limits'
  | '/api/mcp/limits/quota'
  | '/api/mcp/limits/tokens'
  | '/api/mcp/logs'
  | '/api/mcp/scopes'
  | '/api/mcp/tokens'
  | '/api/mcp/tokens/sweep'
  | '/api/mcp/tokens/{id}'
  | '/api/mcp/tools'
  | '/api/meta/audit-logs'
  | '/api/meta/audit-logs/export.csv'
  | '/api/meta/dict'
  | '/api/meta/health'
  | '/api/meta/metrics'
  | '/api/meta/settings'
  | '/api/meta/settings/audit'
  | '/api/meta/settings/audit/check'
  | '/api/meta/settings/defs'
  | '/api/meta/settings/reset'
  | '/api/metrics'
  | '/api/metrics/catalog'
  | '/api/metrics/defs'
  | '/api/metrics/stale'
  | '/api/metrics/sync'
  | '/api/metrics/values'
  | '/api/notify/channels'
  | '/api/notify/channels/{id}/toggle'
  | '/api/notify/logs'
  | '/api/notify/meta'
  | '/api/notify/overview'
  | '/api/notify/preview'
  | '/api/notify/push'
  | '/api/oms/orders'
  | '/api/oms/orders/convert-batch'
  | '/api/oms/orders/{id}'
  | '/api/oms/orders/{id}/complete'
  | '/api/oms/orders/{id}/convert'
  | '/api/oms/orders/{id}/refund'
  | '/api/oms/orders/{id}/ship'
  | '/api/oms/platforms'
  | '/api/oms/stats'
  | '/api/oms/stock-push'
  | '/api/oms/sync-logs'
  | '/api/oms/sync/{platformId}'
  | '/api/order-center/customers/{id}'
  | '/api/order-center/customers/{id}/admit'
  | '/api/order-center/orders'
  | '/api/order-center/orders/{id}'
  | '/api/order-center/orders/{id}/{action}'
  | '/api/order-center/statements'
  | '/api/order-center/statements/{id}'
  | '/api/order-center/statements/{id}/close'
  | '/api/order-center/statements/{id}/confirm'
  | '/api/order-center/statements/{id}/settle'
  | '/api/order-center/statements/{id}/void'
  | '/api/outsourcing/materials'
  | '/api/outsourcing/orders'
  | '/api/outsourcing/orders/{id}'
  | '/api/outsourcing/orders/{id}/issue'
  | '/api/outsourcing/orders/{id}/receive'
  | '/api/outsourcing/orders/{id}/status'
  | '/api/outsourcing/receipts'
  | '/api/outsourcing/receipts/{id}/inspect'
  | '/api/outsourcing/settlements'
  | '/api/outsourcing/stats'
  | '/api/pos/cash-drops'
  | '/api/pos/cash-drops/pending-shifts'
  | '/api/pos/cash-drops/{id}/cancel'
  | '/api/pos/cash-drops/{id}/receive'
  | '/api/pos/context'
  | '/api/pos/daily-close'
  | '/api/pos/daily-closes'
  | '/api/pos/daily-closes/{id}/confirm'
  | '/api/pos/hq/cash-inflight'
  | '/api/pos/hq/daily-closes'
  | '/api/pos/hq/orders'
  | '/api/pos/hq/overview'
  | '/api/pos/hq/shifts'
  | '/api/pos/hq/shifts/{id}'
  | '/api/pos/orders'
  | '/api/pos/orders/{id}'
  | '/api/pos/orders/{id}/void'
  | '/api/pos/products'
  | '/api/pos/quote'
  | '/api/pos/returns'
  | '/api/pos/shifts'
  | '/api/pos/shifts/close'
  | '/api/pos/shifts/open'
  | '/api/pos/shifts/{id}'
  | '/api/pos/shifts/{id}/approve'
  | '/api/pos/shifts/{id}/cancel'
  | '/api/pos/shifts/{id}/declare'
  | '/api/pos/shifts/{id}/reject'
  | '/api/pos/shifts/{id}/settle-variance'
  | '/api/pos/stock-checks'
  | '/api/pos/stock-checks/{id}'
  | '/api/pos/stock-checks/{id}/adjust'
  | '/api/pos/stock-checks/{id}/items'
  | '/api/pos/stocks'
  | '/api/promo/audit'
  | '/api/promo/campaigns'
  | '/api/promo/campaigns/{id}/status'
  | '/api/promo/coupon-instances'
  | '/api/promo/coupon-instances/{id}/void'
  | '/api/promo/coupons'
  | '/api/promo/coupons/expire'
  | '/api/promo/coupons/{id}'
  | '/api/promo/coupons/{id}/issue'
  | '/api/promo/coupons/{id}/status'
  | '/api/promo/explain'
  | '/api/promo/levels'
  | '/api/promo/levels/{code}'
  | '/api/promo/members'
  | '/api/promo/members/{customerId}'
  | '/api/promo/members/{customerId}/balance'
  | '/api/promo/members/{customerId}/coupons'
  | '/api/promo/members/{customerId}/ledger'
  | '/api/promo/members/{customerId}/level'
  | '/api/promo/members/{customerId}/points'
  | '/api/promo/members/{customerId}/sync'
  | '/api/promo/meta'
  | '/api/promo/overview'
  | '/api/promo/promotions'
  | '/api/promo/promotions/validate'
  | '/api/promo/promotions/{id}'
  | '/api/promo/promotions/{id}/status'
  | '/api/promo/quote'
  | '/api/promo/settle'
  | '/api/promo/shop/claim'
  | '/api/promo/shop/member'
  | '/api/promo/shop/promotions'
  | '/api/promo/shop/quote'
  | '/api/promo/unsettle'
  | '/api/purchase/catalog'
  | '/api/purchase/chain/actions'
  | '/api/purchase/chain/flow'
  | '/api/purchase/chain/overview'
  | '/api/purchase/chain/todos'
  | '/api/purchase/inspections'
  | '/api/purchase/inspections/meta'
  | '/api/purchase/inspections/overview'
  | '/api/purchase/inspections/pending'
  | '/api/purchase/inspections/receipt/{receiptId}'
  | '/api/purchase/inspections/{id}'
  | '/api/purchase/inspections/{id}/cancel'
  | '/api/purchase/inspections/{id}/close'
  | '/api/purchase/inspections/{id}/submit'
  | '/api/purchase/invoices'
  | '/api/purchase/invoices-available-lines'
  | '/api/purchase/invoices/{id}'
  | '/api/purchase/invoices/{id}/{action}'
  | '/api/purchase/orders'
  | '/api/purchase/orders/{id}'
  | '/api/purchase/orders/{id}/closes'
  | '/api/purchase/orders/{id}/receive'
  | '/api/purchase/orders/{id}/receive-check'
  | '/api/purchase/orders/{id}/receive-suggest'
  | '/api/purchase/orders/{id}/status'
  | '/api/purchase/payables'
  | '/api/purchase/payment-plan'
  | '/api/purchase/payments'
  | '/api/purchase/payments/{id}'
  | '/api/purchase/payments/{id}/review'
  | '/api/purchase/payments/{id}/{action}'
  | '/api/purchase/price'
  | '/api/purchase/price-preview'
  | '/api/purchase/receipts'
  | '/api/purchase/receipts/{id}'
  | '/api/purchase/receipts/{id}/close'
  | '/api/purchase/requisitions'
  | '/api/purchase/requisitions/{id}'
  | '/api/purchase/requisitions/{id}/convert'
  | '/api/purchase/requisitions/{id}/{action}'
  | '/api/purchase/returns'
  | '/api/purchase/returns/{id}/cancel'
  | '/api/purchase/returns/{id}/complete'
  | '/api/purchase/settlement-preview'
  | '/api/purchase/settlements'
  | '/api/purchase/settlements/{id}'
  | '/api/purchase/settlements/{id}/{action}'
  | '/api/purchase/stats'
  | '/api/purchase/supplier-last-price'
  | '/api/qc/audit'
  | '/api/qc/handlings'
  | '/api/qc/handlings/{id}'
  | '/api/qc/handlings/{id}/cancel'
  | '/api/qc/handlings/{id}/confirm'
  | '/api/qc/inspections'
  | '/api/qc/inspections/{id}'
  | '/api/qc/inspections/{id}/cancel'
  | '/api/qc/inspections/{id}/close'
  | '/api/qc/inspections/{id}/submit'
  | '/api/qc/meta'
  | '/api/qc/overview'
  | '/api/qc/pending'
  | '/api/qc/pending/detail'
  | '/api/qc/requests'
  | '/api/qc/requests/{id}'
  | '/api/qc/requests/{id}/cancel'
  | '/api/qc/requests/{id}/close'
  | '/api/qc/requests/{id}/submit'
  | '/api/qc/sample-plan'
  | '/api/qimen/platforms/{id}/secret'
  | '/api/refunds'
  | '/api/refunds/audit'
  | '/api/refunds/meta'
  | '/api/refunds/refundables'
  | '/api/refunds/{id}'
  | '/api/refunds/{id}/confirm'
  | '/api/refunds/{id}/void'
  | '/api/reports/annual'
  | '/api/reports/annual/{year}'
  | '/api/reports/annual/{year}/carry-forward'
  | '/api/reports/annual/{year}/distribute'
  | '/api/reports/annual/{year}/distribution'
  | '/api/reports/annual/{year}/reverse-closing'
  | '/api/reports/annual/{year}/reverse-distribution'
  | '/api/reports/audit'
  | '/api/reports/cashflow-items'
  | '/api/reports/cashflow-items/meta'
  | '/api/reports/closing/{period}'
  | '/api/reports/config/audit'
  | '/api/reports/config/audit/check'
  | '/api/reports/config/meta'
  | '/api/reports/defs'
  | '/api/reports/defs/{code}'
  | '/api/reports/defs/{code}/lines'
  | '/api/reports/lines'
  | '/api/reports/lines/{id}'
  | '/api/reports/meta'
  | '/api/reports/opening'
  | '/api/reports/operating'
  | '/api/reports/periods'
  | '/api/reports/periods/audit'
  | '/api/reports/periods/audit/check'
  | '/api/reports/periods/{period}/carry-forward'
  | '/api/reports/periods/{period}/close'
  | '/api/reports/periods/{period}/reopen'
  | '/api/reports/periods/{period}/reverse-closing'
  | '/api/reports/subject-balances'
  | '/api/reports/vouchers/{id}/tag-cashflow'
  | '/api/reports/{code}'
  | '/api/reports/{code}/compare'
  | '/api/reports/{code}/compare/audit'
  | '/api/reports/{code}/export'
  | '/api/reports/{code}/multi-year'
  | '/api/reports/{code}/multi-year/audit'
  | '/api/reports/{code}/range/audit'
  | '/api/requisitions/shipments'
  | '/api/requisitions/shipments/{id}'
  | '/api/requisitions/shipments/{id}/cancel'
  | '/api/requisitions/shipments/{id}/ship'
  | '/api/requisitions/store'
  | '/api/requisitions/store/board'
  | '/api/requisitions/store/mine'
  | '/api/requisitions/store/shipments/mine'
  | '/api/requisitions/store/shipments/{id}'
  | '/api/requisitions/store/shipments/{id}/receive'
  | '/api/requisitions/store/{id}'
  | '/api/requisitions/store/{id}/status'
  | '/api/requisitions/store/{id}/to-purchase'
  | '/api/requisitions/store/{id}/to-transfer'
  | '/api/sales/deliveries'
  | '/api/sales/deliveries/{id}'
  | '/api/sales/deliveries/{id}/receive'
  | '/api/sales/orders'
  | '/api/sales/orders/{id}'
  | '/api/sales/orders/{id}/cancel'
  | '/api/sales/orders/{id}/complete'
  | '/api/sales/orders/{id}/confirm'
  | '/api/sales/orders/{id}/deliver'
  | '/api/sales/orders/{id}/payment'
  | '/api/sales/quotes'
  | '/api/sales/quotes/expire'
  | '/api/sales/quotes/meta'
  | '/api/sales/quotes/overview'
  | '/api/sales/quotes/price'
  | '/api/sales/quotes/{id}'
  | '/api/sales/quotes/{id}/action'
  | '/api/sales/quotes/{id}/convert'
  | '/api/sales/quotes/{id}/copy'
  | '/api/sales/returns'
  | '/api/sales/returns/{id}/complete'
  | '/api/sales/stats'

/** 路径 → 支持的方法 */
export type ApiRouteMap = {
  '/api/accounting/audit': { get: true }
  '/api/accounting/meta': { get: true }
  '/api/accounting/subjects': { get: true; post: true }
  '/api/accounting/subjects/tree': { get: true }
  '/api/accounting/subjects/{id}': { put: true }
  '/api/accounting/subjects/{id}/status': { post: true }
  '/api/accounting/templates': { get: true }
  '/api/accounting/templates/{bizType}': { get: true }
  '/api/accounting/trial-balance': { get: true }
  '/api/accounting/trial-balance/detail': { get: true }
  '/api/accounting/vouchers': { get: true }
  '/api/accounting/vouchers/by-source/{sourceType}/{sourceId}': { get: true }
  '/api/accounting/vouchers/generate': { post: true }
  '/api/accounting/vouchers/plan': { post: true }
  '/api/accounting/vouchers/{id}': { get: true }
  '/api/accounting/vouchers/{id}/post': { post: true }
  '/api/accounting/vouchers/{id}/void': { post: true }
  '/api/ai/logs': { get: true }
  '/api/ai/manifest': { get: true }
  '/api/ai/metrics': { get: true }
  '/api/ai/query': { post: true }
  '/api/ai/schema': { get: true }
  '/api/approval/check': { get: true }
  '/api/approval/instances': { get: true; post: true }
  '/api/approval/instances/{id}': { get: true }
  '/api/approval/instances/{id}/cancel': { post: true }
  '/api/approval/instances/{id}/decide': { post: true }
  '/api/approval/meta': { get: true }
  '/api/approval/overview': { get: true }
  '/api/approval/pending': { get: true }
  '/api/approval/templates': { get: true; post: true }
  '/api/approval/templates/{id}/toggle': { post: true }
  '/api/approval/todos': { get: true }
  '/api/ar/aging': { get: true }
  '/api/ar/aging/detail': { get: true }
  '/api/ar/aging/subjects': { get: true }
  '/api/ar/audit': { get: true }
  '/api/ar/documents': { get: true; post: true }
  '/api/ar/documents/generate': { post: true }
  '/api/ar/documents/{id}': { get: true }
  '/api/ar/meta': { get: true }
  '/api/ar/oc/pending': { get: true }
  '/api/ar/oc/sync': { post: true }
  '/api/ar/overview': { get: true }
  '/api/ar/prepay': { get: true }
  '/api/ar/prepay/apply': { post: true }
  '/api/ar/prepay/detail': { get: true }
  '/api/ar/recalc': { post: true }
  '/api/ar/receipts': { get: true; post: true }
  '/api/ar/receipts/{id}': { get: true }
  '/api/ar/receipts/{id}/confirm': { post: true }
  '/api/ar/receipts/{id}/review': { post: true }
  '/api/ar/receipts/{id}/void': { post: true }
  '/api/ar/statement': { get: true }
  '/api/auth/change-password': { post: true }
  '/api/auth/industries': { get: true }
  '/api/auth/login': { post: true }
  '/api/auth/logout-all': { post: true }
  '/api/auth/me': { get: true }
  '/api/auth/my-permissions': { get: true }
  '/api/auth/my-scope': { get: true }
  '/api/auth/permissions': { get: true }
  '/api/auth/roles-permissions': { get: true }
  '/api/auth/roles/{code}/permissions': { put: true }
  '/api/auth/users': { get: true; post: true }
  '/api/costing/adjustments': { get: true; post: true }
  '/api/costing/adjustments/{id}': { get: true }
  '/api/costing/adjustments/{id}/adjust': { post: true }
  '/api/costing/adjustments/{id}/cancel': { post: true }
  '/api/costing/audit': { get: true }
  '/api/costing/layers': { get: true }
  '/api/costing/meta': { get: true }
  '/api/costing/overview': { get: true }
  '/api/costing/periods': { get: true }
  '/api/costing/periods/close': { post: true }
  '/api/costing/variances': { get: true }
  '/api/credit/accounts': { get: true; post: true }
  '/api/credit/accounts/{id}': { get: true; post: true }
  '/api/credit/adjust': { post: true }
  '/api/credit/audit': { get: true }
  '/api/credit/check': { post: true }
  '/api/credit/checks': { get: true }
  '/api/credit/ledger': { get: true }
  '/api/credit/meta': { get: true }
  '/api/credit/overview': { get: true }
  '/api/credit/release': { post: true }
  '/api/credit/settle': { post: true }
  '/api/dashboard/channel': { get: true }
  '/api/dashboard/inventory-dist': { get: true }
  '/api/dashboard/recent': { get: true }
  '/api/dashboard/summary': { get: true }
  '/api/dashboard/todos': { get: true }
  '/api/dashboard/top': { get: true }
  '/api/dashboard/trend': { get: true }
  '/api/dealers/overview': { get: true }
  '/api/dealers/policies': { get: true; post: true }
  '/api/dealers/policies/{id}': { put: true; delete: true }
  '/api/dealers/rebates': { get: true }
  '/api/dealers/rebates/calc': { post: true }
  '/api/dealers/rebates/preview': { post: true }
  '/api/dealers/rebates/{id}': { put: true }
  '/api/dealers/statements': { get: true; post: true }
  '/api/dealers/statements/{id}': { get: true }
  '/api/dealers/statements/{id}/close': { post: true }
  '/api/dealers/statements/{id}/status': { post: true }
  '/api/dealers/statements/{id}/void': { post: true }
  '/api/dealers/{id}/credit': { post: true }
  '/api/dealers/{id}/profile': { get: true }
  '/api/dealers/{id}/purchase-analysis': { get: true }
  '/api/demand/dealer/plans': { get: true; post: true }
  '/api/demand/dealer/plans/mine': { get: true }
  '/api/demand/dealer/requisitions': { get: true; post: true }
  '/api/demand/dealer/requisitions/mine': { get: true }
  '/api/demand/dealer/requisitions/{id}': { get: true }
  '/api/demand/dealer/requisitions/{id}/status': { post: true }
  '/api/demand/dealer/summary': { post: true }
  '/api/demand/dealer/summary/runs': { get: true }
  '/api/demand/dealer/summary/to-orders': { post: true }
  '/api/demand/production/orders': { get: true; post: true }
  '/api/demand/production/orders/{id}': { get: true }
  '/api/demand/production/orders/{id}/status': { post: true }
  '/api/dms/agreements': { get: true; post: true }
  '/api/dms/agreements/explain': { get: true }
  '/api/dms/agreements/{id}': { get: true; put: true }
  '/api/dms/agreements/{id}/status': { post: true }
  '/api/dms/meta': { get: true }
  '/api/dms/policies': { get: true; post: true }
  '/api/dms/rebate-audit': { get: true }
  '/api/dms/rebates': { get: true }
  '/api/dms/rebates/accrue': { post: true }
  '/api/dms/rebates/plan': { post: true }
  '/api/dms/rebates/settle': { post: true }
  '/api/dms/rebates/{id}/confirm': { post: true }
  '/api/dms/settlements': { get: true }
  '/api/dms/settlements/{id}': { get: true }
  '/api/docflow/no-issue': { post: true }
  '/api/docflow/no-preview': { post: true }
  '/api/docflow/no-rules': { get: true; post: true }
  '/api/im/audit': { get: true }
  '/api/im/conflicts': { get: true }
  '/api/im/mappings': { get: true }
  '/api/im/meta': { get: true }
  '/api/im/platforms': { get: true }
  '/api/im/runs': { get: true }
  '/api/im/self-test': { post: true }
  '/api/im/status': { get: true }
  '/api/im/sync/approval': { post: true }
  '/api/im/sync/org': { post: true }
  '/api/inventory/adjust': { post: true }
  '/api/inventory/alerts': { get: true }
  '/api/inventory/assembly': { get: true; post: true }
  '/api/inventory/assembly/{id}': { get: true }
  '/api/inventory/assembly/{id}/cancel': { post: true }
  '/api/inventory/assembly/{id}/confirm': { post: true }
  '/api/inventory/checks': { get: true; post: true }
  '/api/inventory/checks/{id}': { get: true }
  '/api/inventory/checks/{id}/adjust': { post: true }
  '/api/inventory/checks/{id}/cancel': { post: true }
  '/api/inventory/checks/{id}/items': { put: true }
  '/api/inventory/ledger': { get: true }
  '/api/inventory/serials/trace/{serialNo}': { get: true }
  '/api/inventory/stats': { get: true }
  '/api/inventory/stocks': { get: true }
  '/api/inventory/stocks/by-sku': { get: true }
  '/api/inventory/transactions': { get: true }
  '/api/inventory/transfers': { get: true; post: true }
  '/api/inventory/transfers/{id}': { get: true }
  '/api/inventory/transfers/{id}/cancel': { post: true }
  '/api/inventory/transfers/{id}/receive': { post: true }
  '/api/inventory/transfers/{id}/ship': { post: true }
  '/api/inventory/transfers/{id}/submit': { post: true }
  '/api/invoices/audit': { get: true }
  '/api/invoices/from-delivery': { post: true }
  '/api/invoices/list': { get: true }
  '/api/invoices/manual': { post: true }
  '/api/invoices/meta': { get: true }
  '/api/invoices/overview': { get: true }
  '/api/invoices/pending': { get: true }
  '/api/invoices/pending/{deliveryId}': { get: true }
  '/api/invoices/refresh-close': { post: true }
  '/api/invoices/{id}': { get: true }
  '/api/invoices/{id}/confirm': { post: true }
  '/api/invoices/{id}/red-chart': { post: true }
  '/api/invoices/{id}/submit': { post: true }
  '/api/invoices/{id}/void': { post: true }
  '/api/mall/cart': { get: true; post: true }
  '/api/mall/cart/update': { post: true }
  '/api/mall/coupons': { get: true }
  '/api/mall/home': { get: true }
  '/api/mall/login': { post: true }
  '/api/mall/member': { get: true }
  '/api/mall/orders': { get: true; post: true }
  '/api/mall/orders/{id}/cancel': { post: true }
  '/api/mall/products': { get: true }
  '/api/mall/products/{skuId}': { get: true }
  '/api/mall/quote': { post: true }
  '/api/mall/session': { get: true }
  '/api/manufacture/audit': { get: true }
  '/api/manufacture/boms': { get: true; post: true }
  '/api/manufacture/boms/by-sku': { get: true }
  '/api/manufacture/boms/{id}': { get: true; put: true; delete: true }
  '/api/manufacture/boms/{id}/audit': { post: true }
  '/api/manufacture/boms/{id}/expand': { post: true }
  '/api/manufacture/boms/{id}/obsolete': { post: true }
  '/api/manufacture/issues': { get: true; post: true }
  '/api/manufacture/issues/{id}': { get: true }
  '/api/manufacture/issues/{id}/approve': { post: true }
  '/api/manufacture/issues/{id}/cancel': { post: true }
  '/api/manufacture/issues/{id}/issue': { post: true }
  '/api/manufacture/issues/{id}/submit': { post: true }
  '/api/manufacture/meta': { get: true }
  '/api/manufacture/orders': { get: true }
  '/api/manufacture/orders/{id}': { get: true }
  '/api/manufacture/orders/{id}/complete': { post: true }
  '/api/manufacture/orders/{id}/complete-preview': { get: true }
  '/api/manufacture/orders/{id}/requirement': { get: true }
  '/api/manufacture/orders/{id}/start': { post: true }
  '/api/manufacture/overview': { get: true }
  '/api/manufacture/reports': { get: true; post: true }
  '/api/manufacture/reports/{id}': { get: true; put: true; delete: true }
  '/api/master/brands': { get: true; post: true }
  '/api/master/bundles': { get: true; post: true }
  '/api/master/bundles/{id}': { get: true; put: true }
  '/api/master/categories': { get: true; post: true }
  '/api/master/dealers': { get: true; post: true }
  '/api/master/inv-txn-types': { get: true; post: true }
  '/api/master/inv-txn-types/{code}': { put: true; delete: true }
  '/api/master/options': { get: true }
  '/api/master/overview': { get: true }
  '/api/master/platforms': { get: true; post: true }
  '/api/master/products': { get: true; post: true }
  '/api/master/products/{id}': { get: true; put: true; delete: true }
  '/api/master/scan': { get: true }
  '/api/master/skus': { get: true; post: true }
  '/api/master/stores': { get: true; post: true }
  '/api/master/suppliers': { get: true; post: true }
  '/api/master/warehouses': { get: true; post: true }
  '/api/master/warehouses/{id}': { get: true; put: true; delete: true }
  '/api/mcp/catalog': { get: true }
  '/api/mcp/confirmations': { get: true }
  '/api/mcp/confirmations/{token}/approve': { post: true }
  '/api/mcp/confirmations/{token}/reject': { post: true }
  '/api/mcp/limits': { get: true }
  '/api/mcp/limits/quota': { get: true }
  '/api/mcp/limits/tokens': { get: true }
  '/api/mcp/logs': { get: true }
  '/api/mcp/scopes': { get: true }
  '/api/mcp/tokens': { get: true; post: true }
  '/api/mcp/tokens/sweep': { post: true }
  '/api/mcp/tokens/{id}': { get: true; delete: true }
  '/api/mcp/tools': { get: true }
  '/api/meta/audit-logs': { get: true }
  '/api/meta/audit-logs/export.csv': { get: true }
  '/api/meta/dict': { get: true }
  '/api/meta/health': { get: true }
  '/api/meta/metrics': { get: true }
  '/api/meta/settings': { get: true; put: true }
  '/api/meta/settings/audit': { get: true }
  '/api/meta/settings/audit/check': { get: true }
  '/api/meta/settings/defs': { get: true }
  '/api/meta/settings/reset': { post: true }
  '/api/metrics': { get: true }
  '/api/metrics/catalog': { get: true }
  '/api/metrics/defs': { get: true }
  '/api/metrics/stale': { get: true }
  '/api/metrics/sync': { post: true }
  '/api/metrics/values': { get: true }
  '/api/notify/channels': { get: true; post: true }
  '/api/notify/channels/{id}/toggle': { post: true }
  '/api/notify/logs': { get: true }
  '/api/notify/meta': { get: true }
  '/api/notify/overview': { get: true }
  '/api/notify/preview': { get: true }
  '/api/notify/push': { post: true }
  '/api/oms/orders': { get: true }
  '/api/oms/orders/convert-batch': { post: true }
  '/api/oms/orders/{id}': { get: true }
  '/api/oms/orders/{id}/complete': { post: true }
  '/api/oms/orders/{id}/convert': { post: true }
  '/api/oms/orders/{id}/refund': { post: true }
  '/api/oms/orders/{id}/ship': { post: true }
  '/api/oms/platforms': { get: true }
  '/api/oms/stats': { get: true }
  '/api/oms/stock-push': { post: true }
  '/api/oms/sync-logs': { get: true }
  '/api/oms/sync/{platformId}': { post: true }
  '/api/order-center/customers/{id}': { get: true }
  '/api/order-center/customers/{id}/admit': { post: true }
  '/api/order-center/orders': { get: true; post: true }
  '/api/order-center/orders/{id}': { get: true }
  '/api/order-center/orders/{id}/{action}': { post: true }
  '/api/order-center/statements': { get: true; post: true }
  '/api/order-center/statements/{id}': { get: true }
  '/api/order-center/statements/{id}/close': { post: true }
  '/api/order-center/statements/{id}/confirm': { post: true }
  '/api/order-center/statements/{id}/settle': { post: true }
  '/api/order-center/statements/{id}/void': { post: true }
  '/api/outsourcing/materials': { get: true }
  '/api/outsourcing/orders': { get: true; post: true }
  '/api/outsourcing/orders/{id}': { get: true; put: true }
  '/api/outsourcing/orders/{id}/issue': { post: true }
  '/api/outsourcing/orders/{id}/receive': { post: true }
  '/api/outsourcing/orders/{id}/status': { post: true }
  '/api/outsourcing/receipts': { get: true }
  '/api/outsourcing/receipts/{id}/inspect': { post: true }
  '/api/outsourcing/settlements': { get: true }
  '/api/outsourcing/stats': { get: true }
  '/api/pos/cash-drops': { get: true; post: true }
  '/api/pos/cash-drops/pending-shifts': { get: true }
  '/api/pos/cash-drops/{id}/cancel': { post: true }
  '/api/pos/cash-drops/{id}/receive': { post: true }
  '/api/pos/context': { get: true }
  '/api/pos/daily-close': { post: true }
  '/api/pos/daily-closes': { get: true }
  '/api/pos/daily-closes/{id}/confirm': { post: true }
  '/api/pos/hq/cash-inflight': { get: true }
  '/api/pos/hq/daily-closes': { get: true }
  '/api/pos/hq/orders': { get: true }
  '/api/pos/hq/overview': { get: true }
  '/api/pos/hq/shifts': { get: true }
  '/api/pos/hq/shifts/{id}': { get: true }
  '/api/pos/orders': { get: true; post: true }
  '/api/pos/orders/{id}': { get: true }
  '/api/pos/orders/{id}/void': { post: true }
  '/api/pos/products': { get: true }
  '/api/pos/quote': { post: true }
  '/api/pos/returns': { get: true; post: true }
  '/api/pos/shifts': { get: true }
  '/api/pos/shifts/close': { post: true }
  '/api/pos/shifts/open': { get: true; post: true }
  '/api/pos/shifts/{id}': { get: true }
  '/api/pos/shifts/{id}/approve': { post: true }
  '/api/pos/shifts/{id}/cancel': { post: true }
  '/api/pos/shifts/{id}/declare': { post: true }
  '/api/pos/shifts/{id}/reject': { post: true }
  '/api/pos/shifts/{id}/settle-variance': { post: true }
  '/api/pos/stock-checks': { get: true; post: true }
  '/api/pos/stock-checks/{id}': { get: true }
  '/api/pos/stock-checks/{id}/adjust': { post: true }
  '/api/pos/stock-checks/{id}/items': { put: true }
  '/api/pos/stocks': { get: true }
  '/api/promo/audit': { get: true }
  '/api/promo/campaigns': { get: true; post: true }
  '/api/promo/campaigns/{id}/status': { post: true }
  '/api/promo/coupon-instances': { get: true }
  '/api/promo/coupon-instances/{id}/void': { post: true }
  '/api/promo/coupons': { get: true; post: true }
  '/api/promo/coupons/expire': { post: true }
  '/api/promo/coupons/{id}': { get: true; put: true }
  '/api/promo/coupons/{id}/issue': { post: true }
  '/api/promo/coupons/{id}/status': { post: true }
  '/api/promo/explain': { post: true }
  '/api/promo/levels': { get: true }
  '/api/promo/levels/{code}': { put: true }
  '/api/promo/members': { get: true }
  '/api/promo/members/{customerId}': { get: true }
  '/api/promo/members/{customerId}/balance': { post: true }
  '/api/promo/members/{customerId}/coupons': { post: true }
  '/api/promo/members/{customerId}/ledger': { get: true }
  '/api/promo/members/{customerId}/level': { post: true }
  '/api/promo/members/{customerId}/points': { post: true }
  '/api/promo/members/{customerId}/sync': { post: true }
  '/api/promo/meta': { get: true }
  '/api/promo/overview': { get: true }
  '/api/promo/promotions': { get: true; post: true }
  '/api/promo/promotions/validate': { post: true }
  '/api/promo/promotions/{id}': { get: true; put: true; delete: true }
  '/api/promo/promotions/{id}/status': { post: true }
  '/api/promo/quote': { post: true }
  '/api/promo/settle': { post: true }
  '/api/promo/shop/claim': { post: true }
  '/api/promo/shop/member': { get: true }
  '/api/promo/shop/promotions': { get: true }
  '/api/promo/shop/quote': { post: true }
  '/api/promo/unsettle': { post: true }
  '/api/purchase/catalog': { get: true; post: true }
  '/api/purchase/chain/actions': { get: true }
  '/api/purchase/chain/flow': { get: true }
  '/api/purchase/chain/overview': { get: true }
  '/api/purchase/chain/todos': { get: true }
  '/api/purchase/inspections': { get: true; post: true }
  '/api/purchase/inspections/meta': { get: true }
  '/api/purchase/inspections/overview': { get: true }
  '/api/purchase/inspections/pending': { get: true }
  '/api/purchase/inspections/receipt/{receiptId}': { get: true }
  '/api/purchase/inspections/{id}': { get: true }
  '/api/purchase/inspections/{id}/cancel': { post: true }
  '/api/purchase/inspections/{id}/close': { post: true }
  '/api/purchase/inspections/{id}/submit': { post: true }
  '/api/purchase/invoices': { get: true; post: true }
  '/api/purchase/invoices-available-lines': { get: true }
  '/api/purchase/invoices/{id}': { get: true }
  '/api/purchase/invoices/{id}/{action}': { post: true }
  '/api/purchase/orders': { get: true; post: true }
  '/api/purchase/orders/{id}': { get: true; put: true }
  '/api/purchase/orders/{id}/closes': { get: true }
  '/api/purchase/orders/{id}/receive': { post: true }
  '/api/purchase/orders/{id}/receive-check': { post: true }
  '/api/purchase/orders/{id}/receive-suggest': { get: true }
  '/api/purchase/orders/{id}/status': { post: true }
  '/api/purchase/payables': { get: true }
  '/api/purchase/payment-plan': { get: true }
  '/api/purchase/payments': { get: true; post: true }
  '/api/purchase/payments/{id}': { get: true }
  '/api/purchase/payments/{id}/review': { post: true }
  '/api/purchase/payments/{id}/{action}': { post: true }
  '/api/purchase/price': { get: true }
  '/api/purchase/price-preview': { post: true }
  '/api/purchase/receipts': { get: true }
  '/api/purchase/receipts/{id}': { get: true }
  '/api/purchase/receipts/{id}/close': { post: true }
  '/api/purchase/requisitions': { get: true; post: true }
  '/api/purchase/requisitions/{id}': { get: true }
  '/api/purchase/requisitions/{id}/convert': { post: true }
  '/api/purchase/requisitions/{id}/{action}': { post: true }
  '/api/purchase/returns': { get: true; post: true }
  '/api/purchase/returns/{id}/cancel': { post: true }
  '/api/purchase/returns/{id}/complete': { post: true }
  '/api/purchase/settlement-preview': { get: true }
  '/api/purchase/settlements': { get: true; post: true }
  '/api/purchase/settlements/{id}': { get: true }
  '/api/purchase/settlements/{id}/{action}': { post: true }
  '/api/purchase/stats': { get: true }
  '/api/purchase/supplier-last-price': { post: true }
  '/api/qc/audit': { get: true }
  '/api/qc/handlings': { get: true; post: true }
  '/api/qc/handlings/{id}': { get: true }
  '/api/qc/handlings/{id}/cancel': { post: true }
  '/api/qc/handlings/{id}/confirm': { post: true }
  '/api/qc/inspections': { get: true }
  '/api/qc/inspections/{id}': { get: true }
  '/api/qc/inspections/{id}/cancel': { post: true }
  '/api/qc/inspections/{id}/close': { post: true }
  '/api/qc/inspections/{id}/submit': { post: true }
  '/api/qc/meta': { get: true }
  '/api/qc/overview': { get: true }
  '/api/qc/pending': { get: true }
  '/api/qc/pending/detail': { get: true }
  '/api/qc/requests': { get: true; post: true }
  '/api/qc/requests/{id}': { get: true }
  '/api/qc/requests/{id}/cancel': { post: true }
  '/api/qc/requests/{id}/close': { post: true }
  '/api/qc/requests/{id}/submit': { post: true }
  '/api/qc/sample-plan': { get: true }
  '/api/qimen/platforms/{id}/secret': { post: true }
  '/api/refunds': { get: true; post: true }
  '/api/refunds/audit': { get: true }
  '/api/refunds/meta': { get: true }
  '/api/refunds/refundables': { get: true }
  '/api/refunds/{id}': { get: true }
  '/api/refunds/{id}/confirm': { post: true }
  '/api/refunds/{id}/void': { post: true }
  '/api/reports/annual': { get: true }
  '/api/reports/annual/{year}': { get: true }
  '/api/reports/annual/{year}/carry-forward': { post: true }
  '/api/reports/annual/{year}/distribute': { post: true }
  '/api/reports/annual/{year}/distribution': { get: true }
  '/api/reports/annual/{year}/reverse-closing': { post: true }
  '/api/reports/annual/{year}/reverse-distribution': { post: true }
  '/api/reports/audit': { get: true }
  '/api/reports/cashflow-items': { get: true }
  '/api/reports/cashflow-items/meta': { get: true }
  '/api/reports/closing/{period}': { get: true }
  '/api/reports/config/audit': { get: true }
  '/api/reports/config/audit/check': { get: true }
  '/api/reports/config/meta': { get: true }
  '/api/reports/defs': { get: true }
  '/api/reports/defs/{code}': { put: true }
  '/api/reports/defs/{code}/lines': { get: true }
  '/api/reports/lines': { post: true }
  '/api/reports/lines/{id}': { delete: true }
  '/api/reports/meta': { get: true }
  '/api/reports/opening': { get: true; put: true }
  '/api/reports/operating': { get: true }
  '/api/reports/periods': { get: true }
  '/api/reports/periods/audit': { get: true }
  '/api/reports/periods/audit/check': { get: true }
  '/api/reports/periods/{period}/carry-forward': { post: true }
  '/api/reports/periods/{period}/close': { post: true }
  '/api/reports/periods/{period}/reopen': { post: true }
  '/api/reports/periods/{period}/reverse-closing': { post: true }
  '/api/reports/subject-balances': { get: true }
  '/api/reports/vouchers/{id}/tag-cashflow': { post: true }
  '/api/reports/{code}': { get: true }
  '/api/reports/{code}/compare': { get: true }
  '/api/reports/{code}/compare/audit': { get: true }
  '/api/reports/{code}/export': { get: true }
  '/api/reports/{code}/multi-year': { get: true }
  '/api/reports/{code}/multi-year/audit': { get: true }
  '/api/reports/{code}/range/audit': { get: true }
  '/api/requisitions/shipments': { get: true; post: true }
  '/api/requisitions/shipments/{id}': { get: true }
  '/api/requisitions/shipments/{id}/cancel': { post: true }
  '/api/requisitions/shipments/{id}/ship': { post: true }
  '/api/requisitions/store': { get: true; post: true }
  '/api/requisitions/store/board': { get: true }
  '/api/requisitions/store/mine': { get: true }
  '/api/requisitions/store/shipments/mine': { get: true }
  '/api/requisitions/store/shipments/{id}': { get: true }
  '/api/requisitions/store/shipments/{id}/receive': { post: true }
  '/api/requisitions/store/{id}': { get: true }
  '/api/requisitions/store/{id}/status': { post: true }
  '/api/requisitions/store/{id}/to-purchase': { post: true }
  '/api/requisitions/store/{id}/to-transfer': { post: true }
  '/api/sales/deliveries': { get: true }
  '/api/sales/deliveries/{id}': { get: true }
  '/api/sales/deliveries/{id}/receive': { post: true }
  '/api/sales/orders': { get: true; post: true }
  '/api/sales/orders/{id}': { get: true; put: true }
  '/api/sales/orders/{id}/cancel': { post: true }
  '/api/sales/orders/{id}/complete': { post: true }
  '/api/sales/orders/{id}/confirm': { post: true }
  '/api/sales/orders/{id}/deliver': { post: true }
  '/api/sales/orders/{id}/payment': { post: true }
  '/api/sales/quotes': { get: true; post: true }
  '/api/sales/quotes/expire': { post: true }
  '/api/sales/quotes/meta': { get: true }
  '/api/sales/quotes/overview': { get: true }
  '/api/sales/quotes/price': { post: true }
  '/api/sales/quotes/{id}': { get: true }
  '/api/sales/quotes/{id}/action': { post: true }
  '/api/sales/quotes/{id}/convert': { post: true }
  '/api/sales/quotes/{id}/copy': { post: true }
  '/api/sales/returns': { get: true; post: true }
  '/api/sales/returns/{id}/complete': { post: true }
  '/api/sales/stats': { get: true }
}

/** 已登记的接口标签（模块划分） */
export const API_TAGS = ['财务凭证', 'AI 承接', '审批中心', '应收与收款', '认证', '存货核算', '信用控制', '看板', '经销商', '计划与生产', '渠道管理', '系统', 'IM 同步', '存货', '销售发票', '线上 OMS', '生产制造', '主数据', 'AI 与 MCP', '系统参数', '数据口径', '通知中心', '门店要货', '委外管理', '门店 POS', '促销与会员', '采购域', '质检', '采购', '质量检验', '退款管理', '财务报表', '销售', '销售报价'] as const
export type ApiTag = (typeof API_TAGS)[number]

/** 路径是否已登记 */
export function isApiRoute(p: string): p is ApiRoute {
  return (API_ROUTES as readonly string[]).includes(p)
}

export const API_ROUTES: readonly ApiRoute[] = [
  '/api/accounting/audit',
  '/api/accounting/meta',
  '/api/accounting/subjects',
  '/api/accounting/subjects/tree',
  '/api/accounting/subjects/{id}',
  '/api/accounting/subjects/{id}/status',
  '/api/accounting/templates',
  '/api/accounting/templates/{bizType}',
  '/api/accounting/trial-balance',
  '/api/accounting/trial-balance/detail',
  '/api/accounting/vouchers',
  '/api/accounting/vouchers/by-source/{sourceType}/{sourceId}',
  '/api/accounting/vouchers/generate',
  '/api/accounting/vouchers/plan',
  '/api/accounting/vouchers/{id}',
  '/api/accounting/vouchers/{id}/post',
  '/api/accounting/vouchers/{id}/void',
  '/api/ai/logs',
  '/api/ai/manifest',
  '/api/ai/metrics',
  '/api/ai/query',
  '/api/ai/schema',
  '/api/approval/check',
  '/api/approval/instances',
  '/api/approval/instances/{id}',
  '/api/approval/instances/{id}/cancel',
  '/api/approval/instances/{id}/decide',
  '/api/approval/meta',
  '/api/approval/overview',
  '/api/approval/pending',
  '/api/approval/templates',
  '/api/approval/templates/{id}/toggle',
  '/api/approval/todos',
  '/api/ar/aging',
  '/api/ar/aging/detail',
  '/api/ar/aging/subjects',
  '/api/ar/audit',
  '/api/ar/documents',
  '/api/ar/documents/generate',
  '/api/ar/documents/{id}',
  '/api/ar/meta',
  '/api/ar/oc/pending',
  '/api/ar/oc/sync',
  '/api/ar/overview',
  '/api/ar/prepay',
  '/api/ar/prepay/apply',
  '/api/ar/prepay/detail',
  '/api/ar/recalc',
  '/api/ar/receipts',
  '/api/ar/receipts/{id}',
  '/api/ar/receipts/{id}/confirm',
  '/api/ar/receipts/{id}/review',
  '/api/ar/receipts/{id}/void',
  '/api/ar/statement',
  '/api/auth/change-password',
  '/api/auth/industries',
  '/api/auth/login',
  '/api/auth/logout-all',
  '/api/auth/me',
  '/api/auth/my-permissions',
  '/api/auth/my-scope',
  '/api/auth/permissions',
  '/api/auth/roles-permissions',
  '/api/auth/roles/{code}/permissions',
  '/api/auth/users',
  '/api/costing/adjustments',
  '/api/costing/adjustments/{id}',
  '/api/costing/adjustments/{id}/adjust',
  '/api/costing/adjustments/{id}/cancel',
  '/api/costing/audit',
  '/api/costing/layers',
  '/api/costing/meta',
  '/api/costing/overview',
  '/api/costing/periods',
  '/api/costing/periods/close',
  '/api/costing/variances',
  '/api/credit/accounts',
  '/api/credit/accounts/{id}',
  '/api/credit/adjust',
  '/api/credit/audit',
  '/api/credit/check',
  '/api/credit/checks',
  '/api/credit/ledger',
  '/api/credit/meta',
  '/api/credit/overview',
  '/api/credit/release',
  '/api/credit/settle',
  '/api/dashboard/channel',
  '/api/dashboard/inventory-dist',
  '/api/dashboard/recent',
  '/api/dashboard/summary',
  '/api/dashboard/todos',
  '/api/dashboard/top',
  '/api/dashboard/trend',
  '/api/dealers/overview',
  '/api/dealers/policies',
  '/api/dealers/policies/{id}',
  '/api/dealers/rebates',
  '/api/dealers/rebates/calc',
  '/api/dealers/rebates/preview',
  '/api/dealers/rebates/{id}',
  '/api/dealers/statements',
  '/api/dealers/statements/{id}',
  '/api/dealers/statements/{id}/close',
  '/api/dealers/statements/{id}/status',
  '/api/dealers/statements/{id}/void',
  '/api/dealers/{id}/credit',
  '/api/dealers/{id}/profile',
  '/api/dealers/{id}/purchase-analysis',
  '/api/demand/dealer/plans',
  '/api/demand/dealer/plans/mine',
  '/api/demand/dealer/requisitions',
  '/api/demand/dealer/requisitions/mine',
  '/api/demand/dealer/requisitions/{id}',
  '/api/demand/dealer/requisitions/{id}/status',
  '/api/demand/dealer/summary',
  '/api/demand/dealer/summary/runs',
  '/api/demand/dealer/summary/to-orders',
  '/api/demand/production/orders',
  '/api/demand/production/orders/{id}',
  '/api/demand/production/orders/{id}/status',
  '/api/dms/agreements',
  '/api/dms/agreements/explain',
  '/api/dms/agreements/{id}',
  '/api/dms/agreements/{id}/status',
  '/api/dms/meta',
  '/api/dms/policies',
  '/api/dms/rebate-audit',
  '/api/dms/rebates',
  '/api/dms/rebates/accrue',
  '/api/dms/rebates/plan',
  '/api/dms/rebates/settle',
  '/api/dms/rebates/{id}/confirm',
  '/api/dms/settlements',
  '/api/dms/settlements/{id}',
  '/api/docflow/no-issue',
  '/api/docflow/no-preview',
  '/api/docflow/no-rules',
  '/api/im/audit',
  '/api/im/conflicts',
  '/api/im/mappings',
  '/api/im/meta',
  '/api/im/platforms',
  '/api/im/runs',
  '/api/im/self-test',
  '/api/im/status',
  '/api/im/sync/approval',
  '/api/im/sync/org',
  '/api/inventory/adjust',
  '/api/inventory/alerts',
  '/api/inventory/assembly',
  '/api/inventory/assembly/{id}',
  '/api/inventory/assembly/{id}/cancel',
  '/api/inventory/assembly/{id}/confirm',
  '/api/inventory/checks',
  '/api/inventory/checks/{id}',
  '/api/inventory/checks/{id}/adjust',
  '/api/inventory/checks/{id}/cancel',
  '/api/inventory/checks/{id}/items',
  '/api/inventory/ledger',
  '/api/inventory/serials/trace/{serialNo}',
  '/api/inventory/stats',
  '/api/inventory/stocks',
  '/api/inventory/stocks/by-sku',
  '/api/inventory/transactions',
  '/api/inventory/transfers',
  '/api/inventory/transfers/{id}',
  '/api/inventory/transfers/{id}/cancel',
  '/api/inventory/transfers/{id}/receive',
  '/api/inventory/transfers/{id}/ship',
  '/api/inventory/transfers/{id}/submit',
  '/api/invoices/audit',
  '/api/invoices/from-delivery',
  '/api/invoices/list',
  '/api/invoices/manual',
  '/api/invoices/meta',
  '/api/invoices/overview',
  '/api/invoices/pending',
  '/api/invoices/pending/{deliveryId}',
  '/api/invoices/refresh-close',
  '/api/invoices/{id}',
  '/api/invoices/{id}/confirm',
  '/api/invoices/{id}/red-chart',
  '/api/invoices/{id}/submit',
  '/api/invoices/{id}/void',
  '/api/mall/cart',
  '/api/mall/cart/update',
  '/api/mall/coupons',
  '/api/mall/home',
  '/api/mall/login',
  '/api/mall/member',
  '/api/mall/orders',
  '/api/mall/orders/{id}/cancel',
  '/api/mall/products',
  '/api/mall/products/{skuId}',
  '/api/mall/quote',
  '/api/mall/session',
  '/api/manufacture/audit',
  '/api/manufacture/boms',
  '/api/manufacture/boms/by-sku',
  '/api/manufacture/boms/{id}',
  '/api/manufacture/boms/{id}/audit',
  '/api/manufacture/boms/{id}/expand',
  '/api/manufacture/boms/{id}/obsolete',
  '/api/manufacture/issues',
  '/api/manufacture/issues/{id}',
  '/api/manufacture/issues/{id}/approve',
  '/api/manufacture/issues/{id}/cancel',
  '/api/manufacture/issues/{id}/issue',
  '/api/manufacture/issues/{id}/submit',
  '/api/manufacture/meta',
  '/api/manufacture/orders',
  '/api/manufacture/orders/{id}',
  '/api/manufacture/orders/{id}/complete',
  '/api/manufacture/orders/{id}/complete-preview',
  '/api/manufacture/orders/{id}/requirement',
  '/api/manufacture/orders/{id}/start',
  '/api/manufacture/overview',
  '/api/manufacture/reports',
  '/api/manufacture/reports/{id}',
  '/api/master/brands',
  '/api/master/bundles',
  '/api/master/bundles/{id}',
  '/api/master/categories',
  '/api/master/dealers',
  '/api/master/inv-txn-types',
  '/api/master/inv-txn-types/{code}',
  '/api/master/options',
  '/api/master/overview',
  '/api/master/platforms',
  '/api/master/products',
  '/api/master/products/{id}',
  '/api/master/scan',
  '/api/master/skus',
  '/api/master/stores',
  '/api/master/suppliers',
  '/api/master/warehouses',
  '/api/master/warehouses/{id}',
  '/api/mcp/catalog',
  '/api/mcp/confirmations',
  '/api/mcp/confirmations/{token}/approve',
  '/api/mcp/confirmations/{token}/reject',
  '/api/mcp/limits',
  '/api/mcp/limits/quota',
  '/api/mcp/limits/tokens',
  '/api/mcp/logs',
  '/api/mcp/scopes',
  '/api/mcp/tokens',
  '/api/mcp/tokens/sweep',
  '/api/mcp/tokens/{id}',
  '/api/mcp/tools',
  '/api/meta/audit-logs',
  '/api/meta/audit-logs/export.csv',
  '/api/meta/dict',
  '/api/meta/health',
  '/api/meta/metrics',
  '/api/meta/settings',
  '/api/meta/settings/audit',
  '/api/meta/settings/audit/check',
  '/api/meta/settings/defs',
  '/api/meta/settings/reset',
  '/api/metrics',
  '/api/metrics/catalog',
  '/api/metrics/defs',
  '/api/metrics/stale',
  '/api/metrics/sync',
  '/api/metrics/values',
  '/api/notify/channels',
  '/api/notify/channels/{id}/toggle',
  '/api/notify/logs',
  '/api/notify/meta',
  '/api/notify/overview',
  '/api/notify/preview',
  '/api/notify/push',
  '/api/oms/orders',
  '/api/oms/orders/convert-batch',
  '/api/oms/orders/{id}',
  '/api/oms/orders/{id}/complete',
  '/api/oms/orders/{id}/convert',
  '/api/oms/orders/{id}/refund',
  '/api/oms/orders/{id}/ship',
  '/api/oms/platforms',
  '/api/oms/stats',
  '/api/oms/stock-push',
  '/api/oms/sync-logs',
  '/api/oms/sync/{platformId}',
  '/api/order-center/customers/{id}',
  '/api/order-center/customers/{id}/admit',
  '/api/order-center/orders',
  '/api/order-center/orders/{id}',
  '/api/order-center/orders/{id}/{action}',
  '/api/order-center/statements',
  '/api/order-center/statements/{id}',
  '/api/order-center/statements/{id}/close',
  '/api/order-center/statements/{id}/confirm',
  '/api/order-center/statements/{id}/settle',
  '/api/order-center/statements/{id}/void',
  '/api/outsourcing/materials',
  '/api/outsourcing/orders',
  '/api/outsourcing/orders/{id}',
  '/api/outsourcing/orders/{id}/issue',
  '/api/outsourcing/orders/{id}/receive',
  '/api/outsourcing/orders/{id}/status',
  '/api/outsourcing/receipts',
  '/api/outsourcing/receipts/{id}/inspect',
  '/api/outsourcing/settlements',
  '/api/outsourcing/stats',
  '/api/pos/cash-drops',
  '/api/pos/cash-drops/pending-shifts',
  '/api/pos/cash-drops/{id}/cancel',
  '/api/pos/cash-drops/{id}/receive',
  '/api/pos/context',
  '/api/pos/daily-close',
  '/api/pos/daily-closes',
  '/api/pos/daily-closes/{id}/confirm',
  '/api/pos/hq/cash-inflight',
  '/api/pos/hq/daily-closes',
  '/api/pos/hq/orders',
  '/api/pos/hq/overview',
  '/api/pos/hq/shifts',
  '/api/pos/hq/shifts/{id}',
  '/api/pos/orders',
  '/api/pos/orders/{id}',
  '/api/pos/orders/{id}/void',
  '/api/pos/products',
  '/api/pos/quote',
  '/api/pos/returns',
  '/api/pos/shifts',
  '/api/pos/shifts/close',
  '/api/pos/shifts/open',
  '/api/pos/shifts/{id}',
  '/api/pos/shifts/{id}/approve',
  '/api/pos/shifts/{id}/cancel',
  '/api/pos/shifts/{id}/declare',
  '/api/pos/shifts/{id}/reject',
  '/api/pos/shifts/{id}/settle-variance',
  '/api/pos/stock-checks',
  '/api/pos/stock-checks/{id}',
  '/api/pos/stock-checks/{id}/adjust',
  '/api/pos/stock-checks/{id}/items',
  '/api/pos/stocks',
  '/api/promo/audit',
  '/api/promo/campaigns',
  '/api/promo/campaigns/{id}/status',
  '/api/promo/coupon-instances',
  '/api/promo/coupon-instances/{id}/void',
  '/api/promo/coupons',
  '/api/promo/coupons/expire',
  '/api/promo/coupons/{id}',
  '/api/promo/coupons/{id}/issue',
  '/api/promo/coupons/{id}/status',
  '/api/promo/explain',
  '/api/promo/levels',
  '/api/promo/levels/{code}',
  '/api/promo/members',
  '/api/promo/members/{customerId}',
  '/api/promo/members/{customerId}/balance',
  '/api/promo/members/{customerId}/coupons',
  '/api/promo/members/{customerId}/ledger',
  '/api/promo/members/{customerId}/level',
  '/api/promo/members/{customerId}/points',
  '/api/promo/members/{customerId}/sync',
  '/api/promo/meta',
  '/api/promo/overview',
  '/api/promo/promotions',
  '/api/promo/promotions/validate',
  '/api/promo/promotions/{id}',
  '/api/promo/promotions/{id}/status',
  '/api/promo/quote',
  '/api/promo/settle',
  '/api/promo/shop/claim',
  '/api/promo/shop/member',
  '/api/promo/shop/promotions',
  '/api/promo/shop/quote',
  '/api/promo/unsettle',
  '/api/purchase/catalog',
  '/api/purchase/chain/actions',
  '/api/purchase/chain/flow',
  '/api/purchase/chain/overview',
  '/api/purchase/chain/todos',
  '/api/purchase/inspections',
  '/api/purchase/inspections/meta',
  '/api/purchase/inspections/overview',
  '/api/purchase/inspections/pending',
  '/api/purchase/inspections/receipt/{receiptId}',
  '/api/purchase/inspections/{id}',
  '/api/purchase/inspections/{id}/cancel',
  '/api/purchase/inspections/{id}/close',
  '/api/purchase/inspections/{id}/submit',
  '/api/purchase/invoices',
  '/api/purchase/invoices-available-lines',
  '/api/purchase/invoices/{id}',
  '/api/purchase/invoices/{id}/{action}',
  '/api/purchase/orders',
  '/api/purchase/orders/{id}',
  '/api/purchase/orders/{id}/closes',
  '/api/purchase/orders/{id}/receive',
  '/api/purchase/orders/{id}/receive-check',
  '/api/purchase/orders/{id}/receive-suggest',
  '/api/purchase/orders/{id}/status',
  '/api/purchase/payables',
  '/api/purchase/payment-plan',
  '/api/purchase/payments',
  '/api/purchase/payments/{id}',
  '/api/purchase/payments/{id}/review',
  '/api/purchase/payments/{id}/{action}',
  '/api/purchase/price',
  '/api/purchase/price-preview',
  '/api/purchase/receipts',
  '/api/purchase/receipts/{id}',
  '/api/purchase/receipts/{id}/close',
  '/api/purchase/requisitions',
  '/api/purchase/requisitions/{id}',
  '/api/purchase/requisitions/{id}/convert',
  '/api/purchase/requisitions/{id}/{action}',
  '/api/purchase/returns',
  '/api/purchase/returns/{id}/cancel',
  '/api/purchase/returns/{id}/complete',
  '/api/purchase/settlement-preview',
  '/api/purchase/settlements',
  '/api/purchase/settlements/{id}',
  '/api/purchase/settlements/{id}/{action}',
  '/api/purchase/stats',
  '/api/purchase/supplier-last-price',
  '/api/qc/audit',
  '/api/qc/handlings',
  '/api/qc/handlings/{id}',
  '/api/qc/handlings/{id}/cancel',
  '/api/qc/handlings/{id}/confirm',
  '/api/qc/inspections',
  '/api/qc/inspections/{id}',
  '/api/qc/inspections/{id}/cancel',
  '/api/qc/inspections/{id}/close',
  '/api/qc/inspections/{id}/submit',
  '/api/qc/meta',
  '/api/qc/overview',
  '/api/qc/pending',
  '/api/qc/pending/detail',
  '/api/qc/requests',
  '/api/qc/requests/{id}',
  '/api/qc/requests/{id}/cancel',
  '/api/qc/requests/{id}/close',
  '/api/qc/requests/{id}/submit',
  '/api/qc/sample-plan',
  '/api/qimen/platforms/{id}/secret',
  '/api/refunds',
  '/api/refunds/audit',
  '/api/refunds/meta',
  '/api/refunds/refundables',
  '/api/refunds/{id}',
  '/api/refunds/{id}/confirm',
  '/api/refunds/{id}/void',
  '/api/reports/annual',
  '/api/reports/annual/{year}',
  '/api/reports/annual/{year}/carry-forward',
  '/api/reports/annual/{year}/distribute',
  '/api/reports/annual/{year}/distribution',
  '/api/reports/annual/{year}/reverse-closing',
  '/api/reports/annual/{year}/reverse-distribution',
  '/api/reports/audit',
  '/api/reports/cashflow-items',
  '/api/reports/cashflow-items/meta',
  '/api/reports/closing/{period}',
  '/api/reports/config/audit',
  '/api/reports/config/audit/check',
  '/api/reports/config/meta',
  '/api/reports/defs',
  '/api/reports/defs/{code}',
  '/api/reports/defs/{code}/lines',
  '/api/reports/lines',
  '/api/reports/lines/{id}',
  '/api/reports/meta',
  '/api/reports/opening',
  '/api/reports/operating',
  '/api/reports/periods',
  '/api/reports/periods/audit',
  '/api/reports/periods/audit/check',
  '/api/reports/periods/{period}/carry-forward',
  '/api/reports/periods/{period}/close',
  '/api/reports/periods/{period}/reopen',
  '/api/reports/periods/{period}/reverse-closing',
  '/api/reports/subject-balances',
  '/api/reports/vouchers/{id}/tag-cashflow',
  '/api/reports/{code}',
  '/api/reports/{code}/compare',
  '/api/reports/{code}/compare/audit',
  '/api/reports/{code}/export',
  '/api/reports/{code}/multi-year',
  '/api/reports/{code}/multi-year/audit',
  '/api/reports/{code}/range/audit',
  '/api/requisitions/shipments',
  '/api/requisitions/shipments/{id}',
  '/api/requisitions/shipments/{id}/cancel',
  '/api/requisitions/shipments/{id}/ship',
  '/api/requisitions/store',
  '/api/requisitions/store/board',
  '/api/requisitions/store/mine',
  '/api/requisitions/store/shipments/mine',
  '/api/requisitions/store/shipments/{id}',
  '/api/requisitions/store/shipments/{id}/receive',
  '/api/requisitions/store/{id}',
  '/api/requisitions/store/{id}/status',
  '/api/requisitions/store/{id}/to-purchase',
  '/api/requisitions/store/{id}/to-transfer',
  '/api/sales/deliveries',
  '/api/sales/deliveries/{id}',
  '/api/sales/deliveries/{id}/receive',
  '/api/sales/orders',
  '/api/sales/orders/{id}',
  '/api/sales/orders/{id}/cancel',
  '/api/sales/orders/{id}/complete',
  '/api/sales/orders/{id}/confirm',
  '/api/sales/orders/{id}/deliver',
  '/api/sales/orders/{id}/payment',
  '/api/sales/quotes',
  '/api/sales/quotes/expire',
  '/api/sales/quotes/meta',
  '/api/sales/quotes/overview',
  '/api/sales/quotes/price',
  '/api/sales/quotes/{id}',
  '/api/sales/quotes/{id}/action',
  '/api/sales/quotes/{id}/convert',
  '/api/sales/quotes/{id}/copy',
  '/api/sales/returns',
  '/api/sales/returns/{id}/complete',
  '/api/sales/stats',
] as const

/** 某路径支持的方法 */
export const ROUTE_METHODS: Record<ApiRoute, string[]> = {
  '/api/accounting/audit': ['get'],
  '/api/accounting/meta': ['get'],
  '/api/accounting/subjects': ['get', 'post'],
  '/api/accounting/subjects/tree': ['get'],
  '/api/accounting/subjects/{id}': ['put'],
  '/api/accounting/subjects/{id}/status': ['post'],
  '/api/accounting/templates': ['get'],
  '/api/accounting/templates/{bizType}': ['get'],
  '/api/accounting/trial-balance': ['get'],
  '/api/accounting/trial-balance/detail': ['get'],
  '/api/accounting/vouchers': ['get'],
  '/api/accounting/vouchers/by-source/{sourceType}/{sourceId}': ['get'],
  '/api/accounting/vouchers/generate': ['post'],
  '/api/accounting/vouchers/plan': ['post'],
  '/api/accounting/vouchers/{id}': ['get'],
  '/api/accounting/vouchers/{id}/post': ['post'],
  '/api/accounting/vouchers/{id}/void': ['post'],
  '/api/ai/logs': ['get'],
  '/api/ai/manifest': ['get'],
  '/api/ai/metrics': ['get'],
  '/api/ai/query': ['post'],
  '/api/ai/schema': ['get'],
  '/api/approval/check': ['get'],
  '/api/approval/instances': ['get', 'post'],
  '/api/approval/instances/{id}': ['get'],
  '/api/approval/instances/{id}/cancel': ['post'],
  '/api/approval/instances/{id}/decide': ['post'],
  '/api/approval/meta': ['get'],
  '/api/approval/overview': ['get'],
  '/api/approval/pending': ['get'],
  '/api/approval/templates': ['get', 'post'],
  '/api/approval/templates/{id}/toggle': ['post'],
  '/api/approval/todos': ['get'],
  '/api/ar/aging': ['get'],
  '/api/ar/aging/detail': ['get'],
  '/api/ar/aging/subjects': ['get'],
  '/api/ar/audit': ['get'],
  '/api/ar/documents': ['get', 'post'],
  '/api/ar/documents/generate': ['post'],
  '/api/ar/documents/{id}': ['get'],
  '/api/ar/meta': ['get'],
  '/api/ar/oc/pending': ['get'],
  '/api/ar/oc/sync': ['post'],
  '/api/ar/overview': ['get'],
  '/api/ar/prepay': ['get'],
  '/api/ar/prepay/apply': ['post'],
  '/api/ar/prepay/detail': ['get'],
  '/api/ar/recalc': ['post'],
  '/api/ar/receipts': ['get', 'post'],
  '/api/ar/receipts/{id}': ['get'],
  '/api/ar/receipts/{id}/confirm': ['post'],
  '/api/ar/receipts/{id}/review': ['post'],
  '/api/ar/receipts/{id}/void': ['post'],
  '/api/ar/statement': ['get'],
  '/api/auth/change-password': ['post'],
  '/api/auth/industries': ['get'],
  '/api/auth/login': ['post'],
  '/api/auth/logout-all': ['post'],
  '/api/auth/me': ['get'],
  '/api/auth/my-permissions': ['get'],
  '/api/auth/my-scope': ['get'],
  '/api/auth/permissions': ['get'],
  '/api/auth/roles-permissions': ['get'],
  '/api/auth/roles/{code}/permissions': ['put'],
  '/api/auth/users': ['get', 'post'],
  '/api/costing/adjustments': ['get', 'post'],
  '/api/costing/adjustments/{id}': ['get'],
  '/api/costing/adjustments/{id}/adjust': ['post'],
  '/api/costing/adjustments/{id}/cancel': ['post'],
  '/api/costing/audit': ['get'],
  '/api/costing/layers': ['get'],
  '/api/costing/meta': ['get'],
  '/api/costing/overview': ['get'],
  '/api/costing/periods': ['get'],
  '/api/costing/periods/close': ['post'],
  '/api/costing/variances': ['get'],
  '/api/credit/accounts': ['get', 'post'],
  '/api/credit/accounts/{id}': ['get', 'post'],
  '/api/credit/adjust': ['post'],
  '/api/credit/audit': ['get'],
  '/api/credit/check': ['post'],
  '/api/credit/checks': ['get'],
  '/api/credit/ledger': ['get'],
  '/api/credit/meta': ['get'],
  '/api/credit/overview': ['get'],
  '/api/credit/release': ['post'],
  '/api/credit/settle': ['post'],
  '/api/dashboard/channel': ['get'],
  '/api/dashboard/inventory-dist': ['get'],
  '/api/dashboard/recent': ['get'],
  '/api/dashboard/summary': ['get'],
  '/api/dashboard/todos': ['get'],
  '/api/dashboard/top': ['get'],
  '/api/dashboard/trend': ['get'],
  '/api/dealers/overview': ['get'],
  '/api/dealers/policies': ['get', 'post'],
  '/api/dealers/policies/{id}': ['put', 'delete'],
  '/api/dealers/rebates': ['get'],
  '/api/dealers/rebates/calc': ['post'],
  '/api/dealers/rebates/preview': ['post'],
  '/api/dealers/rebates/{id}': ['put'],
  '/api/dealers/statements': ['get', 'post'],
  '/api/dealers/statements/{id}': ['get'],
  '/api/dealers/statements/{id}/close': ['post'],
  '/api/dealers/statements/{id}/status': ['post'],
  '/api/dealers/statements/{id}/void': ['post'],
  '/api/dealers/{id}/credit': ['post'],
  '/api/dealers/{id}/profile': ['get'],
  '/api/dealers/{id}/purchase-analysis': ['get'],
  '/api/demand/dealer/plans': ['get', 'post'],
  '/api/demand/dealer/plans/mine': ['get'],
  '/api/demand/dealer/requisitions': ['get', 'post'],
  '/api/demand/dealer/requisitions/mine': ['get'],
  '/api/demand/dealer/requisitions/{id}': ['get'],
  '/api/demand/dealer/requisitions/{id}/status': ['post'],
  '/api/demand/dealer/summary': ['post'],
  '/api/demand/dealer/summary/runs': ['get'],
  '/api/demand/dealer/summary/to-orders': ['post'],
  '/api/demand/production/orders': ['get', 'post'],
  '/api/demand/production/orders/{id}': ['get'],
  '/api/demand/production/orders/{id}/status': ['post'],
  '/api/dms/agreements': ['get', 'post'],
  '/api/dms/agreements/explain': ['get'],
  '/api/dms/agreements/{id}': ['get', 'put'],
  '/api/dms/agreements/{id}/status': ['post'],
  '/api/dms/meta': ['get'],
  '/api/dms/policies': ['get', 'post'],
  '/api/dms/rebate-audit': ['get'],
  '/api/dms/rebates': ['get'],
  '/api/dms/rebates/accrue': ['post'],
  '/api/dms/rebates/plan': ['post'],
  '/api/dms/rebates/settle': ['post'],
  '/api/dms/rebates/{id}/confirm': ['post'],
  '/api/dms/settlements': ['get'],
  '/api/dms/settlements/{id}': ['get'],
  '/api/docflow/no-issue': ['post'],
  '/api/docflow/no-preview': ['post'],
  '/api/docflow/no-rules': ['get', 'post'],
  '/api/im/audit': ['get'],
  '/api/im/conflicts': ['get'],
  '/api/im/mappings': ['get'],
  '/api/im/meta': ['get'],
  '/api/im/platforms': ['get'],
  '/api/im/runs': ['get'],
  '/api/im/self-test': ['post'],
  '/api/im/status': ['get'],
  '/api/im/sync/approval': ['post'],
  '/api/im/sync/org': ['post'],
  '/api/inventory/adjust': ['post'],
  '/api/inventory/alerts': ['get'],
  '/api/inventory/assembly': ['get', 'post'],
  '/api/inventory/assembly/{id}': ['get'],
  '/api/inventory/assembly/{id}/cancel': ['post'],
  '/api/inventory/assembly/{id}/confirm': ['post'],
  '/api/inventory/checks': ['get', 'post'],
  '/api/inventory/checks/{id}': ['get'],
  '/api/inventory/checks/{id}/adjust': ['post'],
  '/api/inventory/checks/{id}/cancel': ['post'],
  '/api/inventory/checks/{id}/items': ['put'],
  '/api/inventory/ledger': ['get'],
  '/api/inventory/serials/trace/{serialNo}': ['get'],
  '/api/inventory/stats': ['get'],
  '/api/inventory/stocks': ['get'],
  '/api/inventory/stocks/by-sku': ['get'],
  '/api/inventory/transactions': ['get'],
  '/api/inventory/transfers': ['get', 'post'],
  '/api/inventory/transfers/{id}': ['get'],
  '/api/inventory/transfers/{id}/cancel': ['post'],
  '/api/inventory/transfers/{id}/receive': ['post'],
  '/api/inventory/transfers/{id}/ship': ['post'],
  '/api/inventory/transfers/{id}/submit': ['post'],
  '/api/invoices/audit': ['get'],
  '/api/invoices/from-delivery': ['post'],
  '/api/invoices/list': ['get'],
  '/api/invoices/manual': ['post'],
  '/api/invoices/meta': ['get'],
  '/api/invoices/overview': ['get'],
  '/api/invoices/pending': ['get'],
  '/api/invoices/pending/{deliveryId}': ['get'],
  '/api/invoices/refresh-close': ['post'],
  '/api/invoices/{id}': ['get'],
  '/api/invoices/{id}/confirm': ['post'],
  '/api/invoices/{id}/red-chart': ['post'],
  '/api/invoices/{id}/submit': ['post'],
  '/api/invoices/{id}/void': ['post'],
  '/api/mall/cart': ['get', 'post'],
  '/api/mall/cart/update': ['post'],
  '/api/mall/coupons': ['get'],
  '/api/mall/home': ['get'],
  '/api/mall/login': ['post'],
  '/api/mall/member': ['get'],
  '/api/mall/orders': ['get', 'post'],
  '/api/mall/orders/{id}/cancel': ['post'],
  '/api/mall/products': ['get'],
  '/api/mall/products/{skuId}': ['get'],
  '/api/mall/quote': ['post'],
  '/api/mall/session': ['get'],
  '/api/manufacture/audit': ['get'],
  '/api/manufacture/boms': ['get', 'post'],
  '/api/manufacture/boms/by-sku': ['get'],
  '/api/manufacture/boms/{id}': ['get', 'put', 'delete'],
  '/api/manufacture/boms/{id}/audit': ['post'],
  '/api/manufacture/boms/{id}/expand': ['post'],
  '/api/manufacture/boms/{id}/obsolete': ['post'],
  '/api/manufacture/issues': ['get', 'post'],
  '/api/manufacture/issues/{id}': ['get'],
  '/api/manufacture/issues/{id}/approve': ['post'],
  '/api/manufacture/issues/{id}/cancel': ['post'],
  '/api/manufacture/issues/{id}/issue': ['post'],
  '/api/manufacture/issues/{id}/submit': ['post'],
  '/api/manufacture/meta': ['get'],
  '/api/manufacture/orders': ['get'],
  '/api/manufacture/orders/{id}': ['get'],
  '/api/manufacture/orders/{id}/complete': ['post'],
  '/api/manufacture/orders/{id}/complete-preview': ['get'],
  '/api/manufacture/orders/{id}/requirement': ['get'],
  '/api/manufacture/orders/{id}/start': ['post'],
  '/api/manufacture/overview': ['get'],
  '/api/manufacture/reports': ['get', 'post'],
  '/api/manufacture/reports/{id}': ['get', 'put', 'delete'],
  '/api/master/brands': ['get', 'post'],
  '/api/master/bundles': ['get', 'post'],
  '/api/master/bundles/{id}': ['get', 'put'],
  '/api/master/categories': ['get', 'post'],
  '/api/master/dealers': ['get', 'post'],
  '/api/master/inv-txn-types': ['get', 'post'],
  '/api/master/inv-txn-types/{code}': ['put', 'delete'],
  '/api/master/options': ['get'],
  '/api/master/overview': ['get'],
  '/api/master/platforms': ['get', 'post'],
  '/api/master/products': ['get', 'post'],
  '/api/master/products/{id}': ['get', 'put', 'delete'],
  '/api/master/scan': ['get'],
  '/api/master/skus': ['get', 'post'],
  '/api/master/stores': ['get', 'post'],
  '/api/master/suppliers': ['get', 'post'],
  '/api/master/warehouses': ['get', 'post'],
  '/api/master/warehouses/{id}': ['get', 'put', 'delete'],
  '/api/mcp/catalog': ['get'],
  '/api/mcp/confirmations': ['get'],
  '/api/mcp/confirmations/{token}/approve': ['post'],
  '/api/mcp/confirmations/{token}/reject': ['post'],
  '/api/mcp/limits': ['get'],
  '/api/mcp/limits/quota': ['get'],
  '/api/mcp/limits/tokens': ['get'],
  '/api/mcp/logs': ['get'],
  '/api/mcp/scopes': ['get'],
  '/api/mcp/tokens': ['get', 'post'],
  '/api/mcp/tokens/sweep': ['post'],
  '/api/mcp/tokens/{id}': ['get', 'delete'],
  '/api/mcp/tools': ['get'],
  '/api/meta/audit-logs': ['get'],
  '/api/meta/audit-logs/export.csv': ['get'],
  '/api/meta/dict': ['get'],
  '/api/meta/health': ['get'],
  '/api/meta/metrics': ['get'],
  '/api/meta/settings': ['get', 'put'],
  '/api/meta/settings/audit': ['get'],
  '/api/meta/settings/audit/check': ['get'],
  '/api/meta/settings/defs': ['get'],
  '/api/meta/settings/reset': ['post'],
  '/api/metrics': ['get'],
  '/api/metrics/catalog': ['get'],
  '/api/metrics/defs': ['get'],
  '/api/metrics/stale': ['get'],
  '/api/metrics/sync': ['post'],
  '/api/metrics/values': ['get'],
  '/api/notify/channels': ['get', 'post'],
  '/api/notify/channels/{id}/toggle': ['post'],
  '/api/notify/logs': ['get'],
  '/api/notify/meta': ['get'],
  '/api/notify/overview': ['get'],
  '/api/notify/preview': ['get'],
  '/api/notify/push': ['post'],
  '/api/oms/orders': ['get'],
  '/api/oms/orders/convert-batch': ['post'],
  '/api/oms/orders/{id}': ['get'],
  '/api/oms/orders/{id}/complete': ['post'],
  '/api/oms/orders/{id}/convert': ['post'],
  '/api/oms/orders/{id}/refund': ['post'],
  '/api/oms/orders/{id}/ship': ['post'],
  '/api/oms/platforms': ['get'],
  '/api/oms/stats': ['get'],
  '/api/oms/stock-push': ['post'],
  '/api/oms/sync-logs': ['get'],
  '/api/oms/sync/{platformId}': ['post'],
  '/api/order-center/customers/{id}': ['get'],
  '/api/order-center/customers/{id}/admit': ['post'],
  '/api/order-center/orders': ['get', 'post'],
  '/api/order-center/orders/{id}': ['get'],
  '/api/order-center/orders/{id}/{action}': ['post'],
  '/api/order-center/statements': ['get', 'post'],
  '/api/order-center/statements/{id}': ['get'],
  '/api/order-center/statements/{id}/close': ['post'],
  '/api/order-center/statements/{id}/confirm': ['post'],
  '/api/order-center/statements/{id}/settle': ['post'],
  '/api/order-center/statements/{id}/void': ['post'],
  '/api/outsourcing/materials': ['get'],
  '/api/outsourcing/orders': ['get', 'post'],
  '/api/outsourcing/orders/{id}': ['get', 'put'],
  '/api/outsourcing/orders/{id}/issue': ['post'],
  '/api/outsourcing/orders/{id}/receive': ['post'],
  '/api/outsourcing/orders/{id}/status': ['post'],
  '/api/outsourcing/receipts': ['get'],
  '/api/outsourcing/receipts/{id}/inspect': ['post'],
  '/api/outsourcing/settlements': ['get'],
  '/api/outsourcing/stats': ['get'],
  '/api/pos/cash-drops': ['get', 'post'],
  '/api/pos/cash-drops/pending-shifts': ['get'],
  '/api/pos/cash-drops/{id}/cancel': ['post'],
  '/api/pos/cash-drops/{id}/receive': ['post'],
  '/api/pos/context': ['get'],
  '/api/pos/daily-close': ['post'],
  '/api/pos/daily-closes': ['get'],
  '/api/pos/daily-closes/{id}/confirm': ['post'],
  '/api/pos/hq/cash-inflight': ['get'],
  '/api/pos/hq/daily-closes': ['get'],
  '/api/pos/hq/orders': ['get'],
  '/api/pos/hq/overview': ['get'],
  '/api/pos/hq/shifts': ['get'],
  '/api/pos/hq/shifts/{id}': ['get'],
  '/api/pos/orders': ['get', 'post'],
  '/api/pos/orders/{id}': ['get'],
  '/api/pos/orders/{id}/void': ['post'],
  '/api/pos/products': ['get'],
  '/api/pos/quote': ['post'],
  '/api/pos/returns': ['get', 'post'],
  '/api/pos/shifts': ['get'],
  '/api/pos/shifts/close': ['post'],
  '/api/pos/shifts/open': ['get', 'post'],
  '/api/pos/shifts/{id}': ['get'],
  '/api/pos/shifts/{id}/approve': ['post'],
  '/api/pos/shifts/{id}/cancel': ['post'],
  '/api/pos/shifts/{id}/declare': ['post'],
  '/api/pos/shifts/{id}/reject': ['post'],
  '/api/pos/shifts/{id}/settle-variance': ['post'],
  '/api/pos/stock-checks': ['get', 'post'],
  '/api/pos/stock-checks/{id}': ['get'],
  '/api/pos/stock-checks/{id}/adjust': ['post'],
  '/api/pos/stock-checks/{id}/items': ['put'],
  '/api/pos/stocks': ['get'],
  '/api/promo/audit': ['get'],
  '/api/promo/campaigns': ['get', 'post'],
  '/api/promo/campaigns/{id}/status': ['post'],
  '/api/promo/coupon-instances': ['get'],
  '/api/promo/coupon-instances/{id}/void': ['post'],
  '/api/promo/coupons': ['get', 'post'],
  '/api/promo/coupons/expire': ['post'],
  '/api/promo/coupons/{id}': ['get', 'put'],
  '/api/promo/coupons/{id}/issue': ['post'],
  '/api/promo/coupons/{id}/status': ['post'],
  '/api/promo/explain': ['post'],
  '/api/promo/levels': ['get'],
  '/api/promo/levels/{code}': ['put'],
  '/api/promo/members': ['get'],
  '/api/promo/members/{customerId}': ['get'],
  '/api/promo/members/{customerId}/balance': ['post'],
  '/api/promo/members/{customerId}/coupons': ['post'],
  '/api/promo/members/{customerId}/ledger': ['get'],
  '/api/promo/members/{customerId}/level': ['post'],
  '/api/promo/members/{customerId}/points': ['post'],
  '/api/promo/members/{customerId}/sync': ['post'],
  '/api/promo/meta': ['get'],
  '/api/promo/overview': ['get'],
  '/api/promo/promotions': ['get', 'post'],
  '/api/promo/promotions/validate': ['post'],
  '/api/promo/promotions/{id}': ['get', 'put', 'delete'],
  '/api/promo/promotions/{id}/status': ['post'],
  '/api/promo/quote': ['post'],
  '/api/promo/settle': ['post'],
  '/api/promo/shop/claim': ['post'],
  '/api/promo/shop/member': ['get'],
  '/api/promo/shop/promotions': ['get'],
  '/api/promo/shop/quote': ['post'],
  '/api/promo/unsettle': ['post'],
  '/api/purchase/catalog': ['get', 'post'],
  '/api/purchase/chain/actions': ['get'],
  '/api/purchase/chain/flow': ['get'],
  '/api/purchase/chain/overview': ['get'],
  '/api/purchase/chain/todos': ['get'],
  '/api/purchase/inspections': ['get', 'post'],
  '/api/purchase/inspections/meta': ['get'],
  '/api/purchase/inspections/overview': ['get'],
  '/api/purchase/inspections/pending': ['get'],
  '/api/purchase/inspections/receipt/{receiptId}': ['get'],
  '/api/purchase/inspections/{id}': ['get'],
  '/api/purchase/inspections/{id}/cancel': ['post'],
  '/api/purchase/inspections/{id}/close': ['post'],
  '/api/purchase/inspections/{id}/submit': ['post'],
  '/api/purchase/invoices': ['get', 'post'],
  '/api/purchase/invoices-available-lines': ['get'],
  '/api/purchase/invoices/{id}': ['get'],
  '/api/purchase/invoices/{id}/{action}': ['post'],
  '/api/purchase/orders': ['get', 'post'],
  '/api/purchase/orders/{id}': ['get', 'put'],
  '/api/purchase/orders/{id}/closes': ['get'],
  '/api/purchase/orders/{id}/receive': ['post'],
  '/api/purchase/orders/{id}/receive-check': ['post'],
  '/api/purchase/orders/{id}/receive-suggest': ['get'],
  '/api/purchase/orders/{id}/status': ['post'],
  '/api/purchase/payables': ['get'],
  '/api/purchase/payment-plan': ['get'],
  '/api/purchase/payments': ['get', 'post'],
  '/api/purchase/payments/{id}': ['get'],
  '/api/purchase/payments/{id}/review': ['post'],
  '/api/purchase/payments/{id}/{action}': ['post'],
  '/api/purchase/price': ['get'],
  '/api/purchase/price-preview': ['post'],
  '/api/purchase/receipts': ['get'],
  '/api/purchase/receipts/{id}': ['get'],
  '/api/purchase/receipts/{id}/close': ['post'],
  '/api/purchase/requisitions': ['get', 'post'],
  '/api/purchase/requisitions/{id}': ['get'],
  '/api/purchase/requisitions/{id}/convert': ['post'],
  '/api/purchase/requisitions/{id}/{action}': ['post'],
  '/api/purchase/returns': ['get', 'post'],
  '/api/purchase/returns/{id}/cancel': ['post'],
  '/api/purchase/returns/{id}/complete': ['post'],
  '/api/purchase/settlement-preview': ['get'],
  '/api/purchase/settlements': ['get', 'post'],
  '/api/purchase/settlements/{id}': ['get'],
  '/api/purchase/settlements/{id}/{action}': ['post'],
  '/api/purchase/stats': ['get'],
  '/api/purchase/supplier-last-price': ['post'],
  '/api/qc/audit': ['get'],
  '/api/qc/handlings': ['get', 'post'],
  '/api/qc/handlings/{id}': ['get'],
  '/api/qc/handlings/{id}/cancel': ['post'],
  '/api/qc/handlings/{id}/confirm': ['post'],
  '/api/qc/inspections': ['get'],
  '/api/qc/inspections/{id}': ['get'],
  '/api/qc/inspections/{id}/cancel': ['post'],
  '/api/qc/inspections/{id}/close': ['post'],
  '/api/qc/inspections/{id}/submit': ['post'],
  '/api/qc/meta': ['get'],
  '/api/qc/overview': ['get'],
  '/api/qc/pending': ['get'],
  '/api/qc/pending/detail': ['get'],
  '/api/qc/requests': ['get', 'post'],
  '/api/qc/requests/{id}': ['get'],
  '/api/qc/requests/{id}/cancel': ['post'],
  '/api/qc/requests/{id}/close': ['post'],
  '/api/qc/requests/{id}/submit': ['post'],
  '/api/qc/sample-plan': ['get'],
  '/api/qimen/platforms/{id}/secret': ['post'],
  '/api/refunds': ['get', 'post'],
  '/api/refunds/audit': ['get'],
  '/api/refunds/meta': ['get'],
  '/api/refunds/refundables': ['get'],
  '/api/refunds/{id}': ['get'],
  '/api/refunds/{id}/confirm': ['post'],
  '/api/refunds/{id}/void': ['post'],
  '/api/reports/annual': ['get'],
  '/api/reports/annual/{year}': ['get'],
  '/api/reports/annual/{year}/carry-forward': ['post'],
  '/api/reports/annual/{year}/distribute': ['post'],
  '/api/reports/annual/{year}/distribution': ['get'],
  '/api/reports/annual/{year}/reverse-closing': ['post'],
  '/api/reports/annual/{year}/reverse-distribution': ['post'],
  '/api/reports/audit': ['get'],
  '/api/reports/cashflow-items': ['get'],
  '/api/reports/cashflow-items/meta': ['get'],
  '/api/reports/closing/{period}': ['get'],
  '/api/reports/config/audit': ['get'],
  '/api/reports/config/audit/check': ['get'],
  '/api/reports/config/meta': ['get'],
  '/api/reports/defs': ['get'],
  '/api/reports/defs/{code}': ['put'],
  '/api/reports/defs/{code}/lines': ['get'],
  '/api/reports/lines': ['post'],
  '/api/reports/lines/{id}': ['delete'],
  '/api/reports/meta': ['get'],
  '/api/reports/opening': ['get', 'put'],
  '/api/reports/operating': ['get'],
  '/api/reports/periods': ['get'],
  '/api/reports/periods/audit': ['get'],
  '/api/reports/periods/audit/check': ['get'],
  '/api/reports/periods/{period}/carry-forward': ['post'],
  '/api/reports/periods/{period}/close': ['post'],
  '/api/reports/periods/{period}/reopen': ['post'],
  '/api/reports/periods/{period}/reverse-closing': ['post'],
  '/api/reports/subject-balances': ['get'],
  '/api/reports/vouchers/{id}/tag-cashflow': ['post'],
  '/api/reports/{code}': ['get'],
  '/api/reports/{code}/compare': ['get'],
  '/api/reports/{code}/compare/audit': ['get'],
  '/api/reports/{code}/export': ['get'],
  '/api/reports/{code}/multi-year': ['get'],
  '/api/reports/{code}/multi-year/audit': ['get'],
  '/api/reports/{code}/range/audit': ['get'],
  '/api/requisitions/shipments': ['get', 'post'],
  '/api/requisitions/shipments/{id}': ['get'],
  '/api/requisitions/shipments/{id}/cancel': ['post'],
  '/api/requisitions/shipments/{id}/ship': ['post'],
  '/api/requisitions/store': ['get', 'post'],
  '/api/requisitions/store/board': ['get'],
  '/api/requisitions/store/mine': ['get'],
  '/api/requisitions/store/shipments/mine': ['get'],
  '/api/requisitions/store/shipments/{id}': ['get'],
  '/api/requisitions/store/shipments/{id}/receive': ['post'],
  '/api/requisitions/store/{id}': ['get'],
  '/api/requisitions/store/{id}/status': ['post'],
  '/api/requisitions/store/{id}/to-purchase': ['post'],
  '/api/requisitions/store/{id}/to-transfer': ['post'],
  '/api/sales/deliveries': ['get'],
  '/api/sales/deliveries/{id}': ['get'],
  '/api/sales/deliveries/{id}/receive': ['post'],
  '/api/sales/orders': ['get', 'post'],
  '/api/sales/orders/{id}': ['get', 'put'],
  '/api/sales/orders/{id}/cancel': ['post'],
  '/api/sales/orders/{id}/complete': ['post'],
  '/api/sales/orders/{id}/confirm': ['post'],
  '/api/sales/orders/{id}/deliver': ['post'],
  '/api/sales/orders/{id}/payment': ['post'],
  '/api/sales/quotes': ['get', 'post'],
  '/api/sales/quotes/expire': ['post'],
  '/api/sales/quotes/meta': ['get'],
  '/api/sales/quotes/overview': ['get'],
  '/api/sales/quotes/price': ['post'],
  '/api/sales/quotes/{id}': ['get'],
  '/api/sales/quotes/{id}/action': ['post'],
  '/api/sales/quotes/{id}/convert': ['post'],
  '/api/sales/quotes/{id}/copy': ['post'],
  '/api/sales/returns': ['get', 'post'],
  '/api/sales/returns/{id}/complete': ['post'],
  '/api/sales/stats': ['get'],
}
