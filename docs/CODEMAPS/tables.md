# 数据表代码地图

<!-- generated -->
<!-- 由 `node scripts/gen-codemap.mjs` 生成，勿手改；CI 校验不漂移 -->

共 199 张表、65 个迁移。“建于”= schema.sql / 迁移编号 / 运行时建表的文件；“改于”= ALTER、addColumn（无后缀）、建索引（·idx）、触发器（·trg）、DROP（·drop）所在迁移编号。“触达”= 该文件的 SQL 文本里出现这张表（server/db/ 下的种子与启动文件不计）。

## 扫描边界（必读）

本文件由静态文本扫描生成，不执行代码，不是调用图证明。看不到：动态分发（`handlers[x]()`、注册表、docflow 流转表）、把函数当参数传出去后在别处调用、`FROM ${变量}` 与逗号连接的表、小写 SQL。
“经 lib 触达的表”沿跨文件调用最多 3 跳，是**可能触达**的上界。完整清单见 [scripts/gen-codemap.mjs](../../scripts/gen-codemap.mjs) 文件头。

## 表索引

| 表 | 建于 | 改于 | lib / mcp / 中间件 / 其它直接触达 | 路由文件内直接 SQL |
|---|---|---|---|---|
| `accounting_opening_balances` | 034 | 034·idx | lib/annual.js, lib/report.js | — |
| `accounting_periods` | 034 | 035·idx, 036·idx | lib/annual.js, lib/closing.js, lib/period-audit.js, lib/period.js, lib/report.js | — |
| `accounting_subjects` | 032 | 032·idx | lib/accounting.js, lib/annual.js, lib/closing.js, lib/report.js | routes/accounting.js |
| `agent_token_roles` | 006 | — | — | — |
| `agent_tokens` | 006 | 006·idx, 053, 055 | mcp/admin.js, mcp/server.js, mcp/tokens.js | — |
| `ai_query_logs` | schema.sql | — | — | routes/ai.js |
| `approval_instances` | 014 | 014·idx | lib/approval.js, lib/im-sync.js, lib/metrics.js, mcp/tools.js | — |
| `approval_records` | 014 | 014·idx | lib/approval.js | — |
| `approval_steps` | 014 | 014·idx | lib/approval.js | routes/approval.js |
| `approval_templates` | 014 | 014·idx | lib/approval.js | routes/approval.js |
| `ar_documents` | 019 | 019·idx, 020·idx | lib/ar.js, lib/credit-release.js, lib/docflow.js, lib/invoice.js, lib/report.js | routes/ar.js |
| `assembly_order_items` | schema.sql | — | — | routes/inventory.js |
| `assembly_orders` | schema.sql | — | lib/docflow.js | routes/inventory.js, routes/master.js |
| `audit_chain_anchors` | 068 | 068·idx | lib/audit-anchor-manifest.js, lib/audit-chain-verify.js, lib/audit-trail.js | — |
| `audit_logs` | schema.sql | 067·trg, 068 | lib/audit-anchor-manifest.js, lib/audit-chain-verify.js, lib/audit-trail.js, lib/audit-view.js | routes/auth.js, routes/meta.js |
| `biz_flow_steps` | 008 | — | lib/order-center.js | routes/docflow.js, routes/order-center.js, routes/purchase-chain.js |
| `biz_flows` | 008 | — | lib/order-center.js | routes/docflow.js, routes/order-center.js, routes/purchase-chain.js |
| `bom_items` | 023 | 023·idx | lib/bom.js | — |
| `boms` | 023 | 023·idx | lib/bom.js | — |
| `brands` | schema.sql | — | lib/dashboard-sql.js, lib/order-center.js, lib/purchase.js, mcp/tools.js | routes/ai.js, routes/dealers.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/pos.js, routes/requisitions.js, routes/sales.js |
| `bundle_components` | schema.sql | — | — | routes/inventory.js, routes/master.js |
| `bundles` | schema.sql | — | — | routes/inventory.js, routes/master.js |
| `cash_flow_items` | 041 | 041·idx | lib/report.js | — |
| `categories` | schema.sql | — | lib/agreement.js, lib/order-center.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/dealers.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/pos.js |
| `cost_adjustment_items` | 017 | 017·idx | lib/costing.js | — |
| `cost_adjustments` | 017 | 017·idx | lib/costing.js, lib/docflow.js | — |
| `cost_period_balances` | 017 | 017·idx | lib/costing.js | — |
| `cost_periods` | 017 | 017·idx | lib/costing.js | — |
| `coupon_instances` | 025 | 025·idx, 030·idx | lib/checkout.js, lib/coupon.js, lib/member.js | routes/mall.js, routes/promo.js |
| `coupons` | 025 | 025·idx | lib/coupon.js, lib/member.js, lib/promotion.js | routes/mall.js, routes/promo.js |
| `credit_accounts` | 018 | 018·idx | lib/credit-release.js, lib/credit.js, lib/sales-order.js | routes/ar.js, routes/credit.js, routes/sales.js |
| `credit_check_logs` | 018 | 018·idx | lib/credit.js | routes/credit.js |
| `credit_ledger` | 018 | 018·idx | lib/credit-release.js, lib/credit.js | — |
| `credit_release_ledger` | 052 | 052·idx | lib/credit-release.js | — |
| `dealer_rebates` | schema.sql | — | lib/docflow.js, lib/rebate.js | routes/ai.js, routes/dealers.js |
| `dealer_requisition_items` | schema.sql | — | — | routes/demand.js |
| `dealer_requisition_plans` | schema.sql | — | — | routes/demand.js |
| `dealer_requisitions` | schema.sql | — | lib/docflow.js | routes/demand.js |
| `dealer_statements` | schema.sql | — | lib/dealer-statement.js, lib/docflow.js | routes/dealers.js |
| `dealers` | schema.sql | 005 | lib/accounting.js, lib/agreement.js, lib/credit.js, lib/dashboard-sql.js, lib/docflow.js, lib/invoice.js, lib/metrics.js, lib/order-center.js, lib/quote.js, lib/rebate.js, lib/refund.js, mcp/tools.js | routes/ai.js, routes/ar.js, routes/auth.js, routes/dashboard.js, routes/dealers.js, routes/demand.js, routes/dms.js, routes/master.js, routes/order-center.js, routes/sales.js |
| `demand_plan_runs` | schema.sql | — | — | routes/demand.js |
| `doc_actions` | 008 | 008·idx | lib/approval.js, lib/docflow.js, lib/returns.js, mcp/catalog.js, mcp/tools.js | routes/approval.js, routes/docflow.js, routes/order-center.js |
| `doc_events` | 008 | 008·idx | lib/approval.js, lib/costing.js, lib/docflow.js, lib/mfg.js, lib/order-center.js, lib/pos2.js, lib/purchase.js, lib/qc.js, lib/qc2.js, lib/quote.js, mcp/tools.js | routes/docflow.js |
| `doc_no_counters` | 009 | — | lib/docno.js | — |
| `doc_no_rules` | 009 | 009·idx | lib/docno.js | routes/docflow.js |
| `doc_states` | 008 | 008·idx | lib/docflow.js, mcp/catalog.js, mcp/tools.js | routes/docflow.js, routes/order-center.js |
| `doc_transition_policy` | 027 | — | lib/approval.js, lib/docflow.js | — |
| `doc_types` | 008 | — | lib/approval.js, lib/docflow.js, lib/docno.js, lib/order-center.js, lib/role-matrix.js, mcp/catalog.js, mcp/tools.js | routes/approval.js, routes/docflow.js, routes/purchase-chain.js |
| `im_approval_map` | 040 | 040·idx | lib/im-sync.js | routes/im.js |
| `im_dept_map` | 040 | 040·idx | lib/im-sync.js | routes/im.js |
| `im_platform_cfg` | 040 | — | lib/im-sync.js | — |
| `im_sync_conflicts` | 040 | 040·idx | lib/im-sync.js | routes/im.js |
| `im_sync_runs` | 040 | 040·idx | lib/im-sync.js | routes/im.js |
| `im_user_map` | 040 | 040·idx | lib/im-sync.js | routes/im.js |
| `inv_params` | 003 | — | lib/costing.js, lib/stock.js, mcp/server.js | — |
| `inv_txn_types` | 003 | — | lib/stock.js | routes/inv-txn-types.js, routes/meta.js |
| `inventory_batches` | 002 | 002·idx | lib/qc2.js, lib/stock.js, mcp/tools.js | — |
| `inventory_reservations` | 002 | 002·idx | lib/stock.js | — |
| `inventory_stocks` | schema.sql | 002·drop·idx | lib/bom.js, lib/catalog.js, lib/costing.js, lib/dashboard-sql.js, lib/metrics.js, lib/order-center.js, lib/pos2.js, lib/qc2.js, lib/quote.js, lib/report.js, lib/returns.js, lib/stock.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/demand.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/oms.js, routes/pos.js, routes/qimen.js, routes/requisitions.js |
| `inventory_stocks_v2` | 002 | 002·drop | — | — |
| `inventory_transactions` | schema.sql | 002·idx | lib/costing.js, lib/dashboard-sql.js, lib/metrics.js, lib/mfg.js, lib/qc2.js, lib/report.js, lib/returns.js, lib/stock.js, mcp/tools.js | routes/ai.js, routes/inv-txn-types.js, routes/inventory.js, routes/warehouses.js |
| `invoice_ar_links` | 021 | 021·idx | lib/invoice.js | — |
| `login_throttle_buckets` | 运行时 lib/login-throttle.js | — | lib/login-throttle.js | — |
| `login_throttle_meta` | 运行时 lib/login-throttle.js | — | lib/login-throttle.js, lib/ops-status.js | — |
| `mall_cart_items` | schema.sql | — | — | routes/mall.js |
| `mall_customers` | schema.sql | 025 | lib/coupon.js, lib/member.js, lib/pos2.js, middleware/mall-session.js | routes/mall.js, routes/promo.js |
| `material_issue_items` | 023 | 023·idx | lib/mfg.js | — |
| `material_issues` | 023 | 023·idx | lib/docflow.js, lib/mfg.js | — |
| `mcp_call_logs` | 006 | 006·idx | lib/mcp-rate-limit.js, mcp/admin.js, mcp/server.js, mcp/tokens.js | — |
| `mcp_confirmations` | 006 | 006·idx | mcp/admin.js, mcp/server.js | — |
| `mcp_idempotency` | 006 | 006·idx, 026·idx | mcp/server.js | — |
| `member_accounts` | 025 | 025·idx | lib/member.js | routes/promo.js |
| `member_balance_ledger` | 025 | 025·idx | lib/member.js | — |
| `member_levels` | 025 | — | lib/checkout.js, lib/member.js | routes/mall.js, routes/promo.js |
| `member_points_ledger` | 025 | 025·idx, 030·idx | lib/checkout.js, lib/member.js | — |
| `member_prices` | 007 | — | lib/pricing.js | — |
| `metric_defs` | 015 | 015·idx | lib/metrics.js | routes/metrics.js |
| `notify_channels` | 013 | — | lib/notify.js | — |
| `notify_logs` | 013 | 013·idx | lib/notify.js | — |
| `oc_addresses` | 010 | 010·idx | lib/order-center.js | routes/order-center.js |
| `oc_approval_rules` | 010 | — | lib/order-center.js | routes/order-center.js |
| `oc_credit_ledger` | 010 | 010·idx | lib/credit-release.js, lib/credit.js, lib/oc-credit.js, lib/order-center.js | routes/order-center.js |
| `oc_customers` | 010 | 010·idx | lib/ar.js, lib/credit.js, lib/order-center.js, lib/quote.js, lib/sales-order.js, mcp/doc-perms.js | routes/order-center.js |
| `oc_order_approvals` | 010 | 010·idx | lib/order-center.js | routes/order-center.js |
| `oc_order_items` | 010 | 010·idx | lib/order-center.js | routes/order-center.js |
| `oc_orders` | 010 | 010·idx | lib/ar.js, lib/credit-release.js, lib/docflow.js, lib/metrics.js, lib/oc-credit.js, lib/order-center.js, lib/quote.js | routes/order-center.js |
| `oc_statement_items` | 010 | 010·idx | lib/order-center.js | — |
| `oc_statements` | 010 | 010·idx | lib/docflow.js, lib/order-center.js | routes/order-center.js |
| `oc_visibility_rules` | 010 | — | lib/order-center.js | routes/order-center.js |
| `oms_order_items` | schema.sql | 025 | — | routes/mall.js, routes/oms.js |
| `oms_orders` | schema.sql | — | lib/dashboard-sql.js, lib/docflow.js, lib/metrics.js | routes/ai.js, routes/dashboard.js, routes/mall.js, routes/oms.js |
| `oms_sync_logs` | schema.sql | — | — | routes/mall.js, routes/oms.js, routes/qimen.js |
| `org_brands` | 005 | — | — | — |
| `org_functions` | 001 | — | lib/admin-bootstrap.js | — |
| `orgs` | 001 | 001·idx | lib/admin-bootstrap.js, lib/im-sync.js, mcp/delegation.js, mcp/tokens.js, mcp/tools.js, middleware/auth.js | routes/auth.js, routes/im.js |
| `os_egp_admin_bootstrap` | 运行时 lib/admin-bootstrap.js | — | lib/admin-bootstrap.js | — |
| `outsourcing_material_items` | schema.sql | — | — | routes/outsourcing.js |
| `outsourcing_materials` | schema.sql | — | lib/docflow.js | routes/outsourcing.js |
| `outsourcing_order_items` | schema.sql | — | — | routes/demand.js, routes/outsourcing.js |
| `outsourcing_orders` | schema.sql | — | lib/docflow.js | routes/demand.js, routes/outsourcing.js |
| `outsourcing_receipt_items` | schema.sql | — | — | routes/outsourcing.js |
| `outsourcing_receipts` | schema.sql | — | lib/docflow.js | routes/outsourcing.js |
| `payment_release_ledger` | 057 | 057·idx | lib/purchase.js | — |
| `period_audit_log` | 037 | 037·idx | lib/period-audit.js | — |
| `permissions` | 005 | 005·idx | lib/account-security.js, lib/approval.js, middleware/auth.js | routes/approval.js, routes/auth.js |
| `platforms` | schema.sql | 060 | lib/dashboard-sql.js, lib/qimen-auth.js, lib/sales-order.js | routes/ai.js, routes/dashboard.js, routes/mall.js, routes/master.js, routes/oms.js, routes/qimen.js, routes/sales.js |
| `pos_cash_drop_items` | 024 | 024·idx | lib/pos2.js | routes/pos.js |
| `pos_cash_drops` | 024 | 024·idx | lib/pos2.js | routes/pos.js |
| `pos_daily_closes` | schema.sql | 024 | lib/docflow.js, lib/pos2.js | routes/pos.js |
| `pos_order_items` | schema.sql | — | lib/pos2.js | routes/pos.js |
| `pos_orders` | schema.sql | 024·idx | lib/docflow.js, lib/metrics.js, lib/pos2.js | routes/pos.js |
| `pos_shift_payments` | 024 | 024·idx | lib/pos2.js | routes/pos.js |
| `pos_shifts` | schema.sql | 024·idx | lib/docflow.js, lib/pos2.js | routes/pos.js |
| `price_agreements` | 031 | 031·idx | lib/agreement.js | — |
| `price_change_logs` | 007 | 007·idx | lib/pricing.js | routes/pricing.js |
| `price_group_items` | 007 | 007·idx | lib/pricing.js | routes/pricing.js |
| `price_group_targets` | 007 | — | lib/pricing.js | — |
| `price_groups` | 007 | 007·idx | lib/pricing.js | routes/pricing.js |
| `price_rules` | 007 | — | — | routes/pricing.js |
| `product_skus` | schema.sql | 007 | lib/agreement.js, lib/bom.js, lib/catalog.js, lib/checkout.js, lib/costing.js, lib/dashboard-sql.js, lib/invoice.js, lib/mfg.js, lib/order-center.js, lib/pos2.js, lib/pricing.js, lib/purchase.js, lib/qc.js, lib/qc2.js, lib/quote.js, lib/rebate.js, lib/returns.js, lib/stock.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/dealers.js, routes/demand.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/oms.js, routes/outsourcing.js, routes/pos.js, routes/pricing.js, routes/purchase-chain.js, routes/purchase.js, routes/qimen.js, routes/requisitions.js, routes/sales.js |
| `production_order_items` | schema.sql | — | lib/mfg.js | routes/demand.js |
| `production_orders` | schema.sql | — | lib/bom.js, lib/docflow.js, lib/mfg.js, lib/qc2.js | routes/demand.js |
| `products` | schema.sql | 007 | lib/agreement.js, lib/bom.js, lib/catalog.js, lib/checkout.js, lib/dashboard-sql.js, lib/mfg.js, lib/order-center.js, lib/pos2.js, lib/purchase.js, lib/quote.js, lib/rebate.js, lib/stock.js, mcp/tools.js | routes/ai.js, routes/dealers.js, routes/demand.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/meta.js, routes/oms.js, routes/outsourcing.js, routes/pos.js, routes/purchase-chain.js, routes/purchase.js, routes/requisitions.js, routes/sales.js |
| `promotion_adjustments` | 025 | 025·idx, 030·idx | lib/checkout.js, lib/promotion.js | routes/promo.js |
| `promotion_campaign_budgets` | 025 | 025·idx | lib/checkout.js, lib/promotion.js | — |
| `promotion_campaigns` | 025 | — | lib/promotion.js | — |
| `promotion_methods` | 025 | — | lib/promotion.js | routes/promo.js |
| `promotion_rules` | 025 | 025·idx | lib/promotion.js | routes/promo.js |
| `promotion_usages` | 025 | 025·idx, 030·idx | lib/checkout.js, lib/promotion.js | routes/promo.js |
| `promotions` | 025 | 025·idx | lib/checkout.js, lib/coupon.js, lib/pricing.js, lib/promotion.js | routes/promo.js |
| `purchase_inspection_items` | 016 | 016·idx | lib/qc.js | — |
| `purchase_inspections` | 016 | 016·idx | lib/docflow.js, lib/qc.js | — |
| `purchase_invoice_items` | 011 | 011·idx | lib/purchase.js | routes/purchase-chain.js |
| `purchase_invoices` | 011 | 011·idx | lib/docflow.js, lib/purchase.js, mcp/tools.js | routes/purchase-chain.js |
| `purchase_order_items` | schema.sql | — | lib/purchase.js, mcp/tools.js | routes/ai.js, routes/demand.js, routes/purchase-chain.js, routes/purchase.js, routes/requisitions.js |
| `purchase_orders` | schema.sql | 011 | lib/dashboard-sql.js, lib/docflow.js, lib/metrics.js, lib/purchase.js, lib/qc.js, lib/qc2.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/demand.js, routes/purchase-chain.js, routes/purchase.js, routes/requisitions.js |
| `purchase_payment_items` | 011 | 011·idx, 012·idx | lib/purchase.js | routes/purchase-chain.js |
| `purchase_payments` | 011 | 011·idx, 012·idx | lib/accounting.js, lib/docflow.js, lib/funds-review.js, lib/purchase.js, mcp/tools.js | routes/purchase-chain.js |
| `purchase_receipt_items` | schema.sql | — | lib/costing.js, lib/purchase.js, lib/qc.js, lib/qc2.js, lib/report.js | routes/purchase-chain.js, routes/purchase.js |
| `purchase_receipts` | schema.sql | 011 | lib/accounting.js, lib/costing.js, lib/docflow.js, lib/purchase.js, lib/qc.js, lib/qc2.js, lib/report.js, mcp/tools.js | routes/purchase-chain.js, routes/purchase.js |
| `purchase_requisition_items` | 011 | 011·idx | lib/purchase.js | — |
| `purchase_requisitions` | 011 | 011·idx | lib/docflow.js, lib/purchase.js, mcp/tools.js | — |
| `purchase_return_items` | schema.sql | — | lib/purchase.js, lib/qc.js | — |
| `purchase_returns` | schema.sql | — | lib/docflow.js, lib/purchase.js, lib/qc.js, lib/qc2.js, mcp/tools.js | routes/purchase-chain.js, routes/purchase.js |
| `purchase_settlement_items` | 011 | 011·idx, 012·idx | lib/costing.js, lib/purchase.js | routes/purchase-chain.js |
| `purchase_settlements` | 011 | 011·idx, 012·idx | lib/costing.js, lib/docflow.js, lib/metrics.js, lib/purchase.js, lib/report.js, mcp/tools.js | routes/purchase-chain.js |
| `qc_defect_handlings` | 022 | 022·idx | lib/docflow.js, lib/qc2.js | — |
| `qc_inspections` | 022 | 022·idx | lib/docflow.js, lib/qc2.js | — |
| `qc_request_items` | 022 | 022·idx | lib/qc2.js | — |
| `qc_requests` | 022 | 022·idx | lib/docflow.js, lib/qc2.js | — |
| `qimen_nonces` | 060 | 060·idx | lib/qimen-auth.js | — |
| `rebate_policies` | schema.sql | — | lib/rebate.js | routes/dealers.js, routes/dms.js |
| `rebate_settlement_items` | 031 | 031·idx | lib/rebate.js | — |
| `rebate_settlements` | 031 | 031·idx | lib/rebate.js | — |
| `receipt_allocations` | 019 | 019·idx | lib/ar.js | — |
| `receipts` | 019 | 019·idx, 020·idx | lib/accounting.js, lib/ar.js, lib/docflow.js, lib/funds-review.js | — |
| `refund_items` | 033 | 033·idx | lib/refund.js | — |
| `refunds` | 033 | 033·idx | lib/docflow.js, lib/refund.js | — |
| `report_config_audit_log` | 039 | 039·idx | lib/report-config-audit.js | — |
| `report_defs` | 034 | — | lib/report-config-audit.js, lib/report.js | — |
| `report_lines` | 034 | 034·idx | lib/report-config-audit.js, lib/report.js | — |
| `role_permissions` | 005 | — | lib/account-security.js, lib/role-matrix.js, middleware/auth.js | routes/auth.js |
| `roles` | 005 | — | lib/account-security.js, lib/admin-bootstrap.js, lib/approval.js, lib/role-matrix.js, middleware/auth.js | routes/approval.js, routes/auth.js |
| `sales_deliveries` | schema.sql | — | lib/accounting.js, lib/docflow.js, lib/invoice.js, lib/report.js, lib/returns.js, lib/sales-order.js | routes/invoice.js, routes/oms.js, routes/sales.js |
| `sales_delivery_items` | schema.sql | — | lib/invoice.js, lib/report.js, lib/returns.js | routes/oms.js, routes/sales.js |
| `sales_invoice_items` | 021 | 021·idx | lib/invoice.js | — |
| `sales_invoices` | 021 | 021·idx | lib/ar.js, lib/credit-release.js, lib/docflow.js, lib/invoice.js | — |
| `sales_order_items` | schema.sql | — | lib/dashboard-sql.js, lib/invoice.js, lib/pos2.js, lib/quote.js, lib/rebate.js, lib/returns.js, lib/sales-order.js, mcp/tools.js | routes/ai.js, routes/dealers.js, routes/inventory.js, routes/master.js, routes/oms.js, routes/sales.js |
| `sales_orders` | schema.sql | — | lib/accounting.js, lib/ar.js, lib/credit-release.js, lib/credit.js, lib/dashboard-sql.js, lib/dealer-statement.js, lib/docflow.js, lib/invoice.js, lib/metrics.js, lib/pos2.js, lib/quote.js, lib/rebate.js, lib/returns.js, lib/sales-order.js, mcp/tools.js | routes/ai.js, routes/ar.js, routes/dashboard.js, routes/dealers.js, routes/inventory.js, routes/oms.js, routes/sales.js |
| `sales_quote_items` | 018 | 018·idx | lib/quote.js | — |
| `sales_quotes` | 018 | 018·idx | lib/docflow.js, lib/quote.js, lib/sales-order.js | — |
| `sales_return_items` | schema.sql | 028·idx | lib/pos2.js, lib/returns.js | routes/pos.js |
| `sales_returns` | schema.sql | 028·idx | lib/dealer-statement.js, lib/docflow.js, lib/metrics.js, lib/pos2.js, lib/rebate.js, lib/refund.js, lib/returns.js, lib/sales-order.js | routes/dealers.js, routes/pos.js, routes/sales.js |
| `serial_numbers` | schema.sql | — | — | routes/inventory.js, routes/master.js |
| `setting_audit_log` | 038 | 038·idx | lib/settings.js | — |
| `settings` | schema.sql | — | lib/mcp-rate-limit.js, lib/ops-status.js, lib/settings.js | routes/promo.js |
| `stock_check_items` | schema.sql | — | lib/pos2.js | routes/inventory.js, routes/pos.js |
| `stock_checks` | schema.sql | 024 | lib/docflow.js, lib/pos2.js | routes/inventory.js, routes/pos.js |
| `stock_cost_ledger` | 002 | 002·idx | lib/accounting.js, lib/costing.js, lib/stock.js | — |
| `stock_transfer_items` | schema.sql | — | lib/transfer.js | routes/inventory.js, routes/requisitions.js |
| `stock_transfers` | schema.sql | — | lib/docflow.js, lib/qc2.js, lib/transfer.js | routes/inventory.js, routes/requisitions.js |
| `store_requisition_items` | schema.sql | — | — | routes/requisitions.js |
| `store_requisitions` | schema.sql | — | lib/docflow.js | routes/requisitions.js |
| `store_shipment_items` | schema.sql | — | — | routes/requisitions.js |
| `store_shipments` | schema.sql | — | lib/docflow.js | routes/requisitions.js |
| `stores` | schema.sql | 001 | lib/accounting.js, lib/credit.js, lib/dashboard-sql.js, lib/docflow.js, lib/invoice.js, lib/order-center.js, lib/pos2.js, lib/quote.js, lib/refund.js, lib/sales-order.js, mcp/tools.js | routes/ai.js, routes/ar.js, routes/auth.js, routes/dashboard.js, routes/master.js, routes/pos.js, routes/requisitions.js, routes/sales.js |
| `supplier_price_logs` | 011 | 011·idx | lib/purchase.js | — |
| `supplier_products` | 011 | 011·idx | lib/purchase.js | routes/purchase-chain.js |
| `suppliers` | schema.sql | 005 | lib/accounting.js, lib/approval.js, lib/costing.js, lib/dashboard-sql.js, lib/purchase.js, lib/qc.js, lib/qc2.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/inventory.js, routes/master.js, routes/outsourcing.js, routes/purchase-chain.js, routes/purchase.js |
| `user_orgs` | 005 | 005·idx | lib/account-security.js, lib/admin-bootstrap.js | — |
| `user_roles` | 005 | 005·idx | lib/account-security.js, lib/admin-bootstrap.js, lib/approval.js, middleware/auth.js | — |
| `users` | schema.sql | 005, 050 | lib/account-security.js, lib/admin-bootstrap.js, lib/approval.js, lib/im-sync.js, lib/qc2.js, lib/role-matrix.js, mcp/delegation.js, mcp/doc-perms.js, mcp/tokens.js, mcp/tools.js, middleware/auth.js | routes/approval.js, routes/auth.js, routes/im.js, routes/sales.js |
| `voucher_entries` | 032 | 032·idx, 041·idx | lib/accounting.js, lib/annual.js, lib/closing.js, lib/report.js | — |
| `voucher_template_entries` | 032 | 032·idx | lib/accounting.js | — |
| `voucher_templates` | 032 | — | lib/accounting.js | — |
| `vouchers` | 032 | 032·idx, 034·idx | lib/accounting.js, lib/annual.js, lib/closing.js, lib/docflow.js, lib/period-audit.js, lib/report.js | — |
| `warehouse_locations` | schema.sql | — | — | routes/master.js |
| `warehouses` | schema.sql | 001 | lib/costing.js, lib/dashboard-sql.js, lib/docflow.js, lib/mfg.js, lib/order-center.js, lib/pos2.js, lib/purchase.js, lib/qc.js, lib/qc2.js, lib/quote.js, lib/returns.js, lib/sales-order.js, lib/stock.js, lib/transfer.js, lib/warehouse.js, mcp/tools.js | routes/ai.js, routes/dashboard.js, routes/demand.js, routes/docflow.js, routes/inventory.js, routes/mall.js, routes/master.js, routes/oms.js, routes/outsourcing.js, routes/pos.js, routes/purchase-chain.js, routes/purchase.js, routes/qimen.js, routes/requisitions.js, routes/sales.js, routes/warehouses.js |
| `work_reports` | 023 | 023·idx | lib/mfg.js, lib/qc2.js | — |

## 迁移索引

| 编号 | 文件 | 名称 | 建表 | 改表 |
|---|---|---|---|---|
| 001 | `001_orgs.cjs` | 组织主体 orgs 与业务主体职责 | org_functions, orgs | orgs, stores, warehouses |
| 002 | `002_stock_five_dims.cjs` | 库存五维与成本层（货主/币种/批次主档/成本流水/预留明细） | inventory_batches, inventory_reservations, inventory_stocks_v2, stock_cost_ledger | inventory_batches, inventory_reservations, inventory_stocks, inventory_stocks_v2, inventory_transactions, stock_cost_ledger |
| 003 | `003_inv_dict.cjs` | 库存事务类型字典 inv_txn_types 与库存参数 inv_params | inv_params, inv_txn_types | — |
| 004 | `004_org_default_and_transfer.cjs` | 默认主体与货主回填、货权转移事务类型 | — | — |
| 005 | `005_org_permission.cjs` | 组织与权限模型（角色 / 权限点 / 用户多组织多角色 / 数据权限范围） | org_brands, permissions, role_permissions, roles, user_orgs, user_roles | dealers, permissions, suppliers, user_orgs, user_roles, users |
| 006 | `006_mcp.cjs` | MCP 能力层（Agent Token / 调用日志 / 幂等键 / 高危二次确认） | agent_token_roles, agent_tokens, mcp_call_logs, mcp_confirmations, mcp_idempotency | agent_tokens, mcp_call_logs, mcp_confirmations, mcp_idempotency |
| 007 | `007_pricing.cjs` | 价格中心（价格组/阶梯价/取价规则/调价留痕） | member_prices, price_change_logs, price_group_items, price_group_targets, price_groups, price_rules | price_change_logs, price_group_items, price_groups, product_skus, products |
| 008 | `008_doc_kernel.cjs` | 单据内核 doc_types / doc_states / doc_actions / doc_events / biz_flows | biz_flow_steps, biz_flows, doc_actions, doc_events, doc_states, doc_types | doc_actions, doc_events, doc_states |
| 009 | `009_docno_rules.cjs` | 编码规则 doc_no_rules 与编号计数器 doc_no_counters | doc_no_counters, doc_no_rules | doc_no_rules |
| 010 | `010_order_center.cjs` | 订货中心 oc_customers / oc_orders / oc_statements | oc_addresses, oc_approval_rules, oc_credit_ledger, oc_customers, oc_order_approvals, oc_order_items, oc_orders, oc_statement_items, oc_statements, oc_visibility_rules | oc_addresses, oc_credit_ledger, oc_customers, oc_order_approvals, oc_order_items, oc_orders, oc_statement_items, oc_statements |
| 011 | `011_purchase.cjs` | 采购域 请购/发票/结算/付款 + 供货目录 | purchase_invoice_items, purchase_invoices, purchase_payment_items, purchase_payments, purchase_requisition_items, purchase_requisitions, purchase_settlement_items, purchase_settlements, supplier_price_logs, supplier_products | purchase_invoice_items, purchase_invoices, purchase_orders, purchase_payment_items, purchase_payments, purchase_receipts, purchase_requisition_items, purchase_requisitions, purchase_settlement_items, purchase_settlements, supplier_price_logs, supplier_products |
| 012 | `012_payment_paid_at.cjs` | 付款单实际付款时间 + 采购后段索引 | — | purchase_payment_items, purchase_payments, purchase_settlement_items, purchase_settlements |
| 013 | `013_notify.cjs` | 待办推送：通知渠道 + 推送日志 | notify_channels, notify_logs | notify_logs |
| 014 | `014_approval.cjs` | 通用审批流：模板 / 级次 / 实例 / 记录 | approval_instances, approval_records, approval_steps, approval_templates | approval_instances, approval_records, approval_steps, approval_templates |
| 015 | `015_metrics.cjs` | 数据口径字典：指标定义 | metric_defs | metric_defs |
| 016 | `016_qc.cjs` | 采购质检单：到货单与质检单拆分 | purchase_inspection_items, purchase_inspections | purchase_inspection_items, purchase_inspections |
| 017 | `017_costing.cjs` | 存货核算与成本：期间 / 期末快照 / 成本调整单 | cost_adjustment_items, cost_adjustments, cost_period_balances, cost_periods | cost_adjustment_items, cost_adjustments, cost_period_balances, cost_periods |
| 018 | `018_quote_credit.cjs` | 销售报价与信用控制：报价单 / 信用账户 / 信用台账 / 校验留痕 | credit_accounts, credit_check_logs, credit_ledger, sales_quote_items, sales_quotes | credit_accounts, credit_check_logs, credit_ledger, sales_quote_items, sales_quotes |
| 019 | `019_ar_receipt.cjs` | 应收与收款核销：应收单 / 收款单 / 核销明细 | ar_documents, receipt_allocations, receipts | ar_documents, receipt_allocations, receipts |
| 020 | `020_ar_extend.cjs` | 应收域扩展与数据库加固：逐笔账龄视图 / 订货中心待并入视图 / 派生索引 / 运维参数 | — | ar_documents, receipts |
| 021 | `021_sales_invoice.cjs` | 销售发票：发票头 / 发票行 / 发票-应收关联 + 开票关闭列 | invoice_ar_links, sales_invoice_items, sales_invoices | invoice_ar_links, sales_invoice_items, sales_invoices |
| 022 | `022_quality_inspection.cjs` | 质量检验：报检 / 检验 / 不良品处理 三单独立成链 | qc_defect_handlings, qc_inspections, qc_request_items, qc_requests | qc_defect_handlings, qc_inspections, qc_request_items, qc_requests |
| 023 | `023_bom_and_work.cjs` | BOM 与报工领料：BOM 展开 / 生产领料 / 完工汇报 | bom_items, boms, material_issue_items, material_issues, work_reports | bom_items, boms, material_issue_items, material_issues, work_reports |
| 024 | `024_pos_shift_cash.cjs` | POS 交班缴款：班次核款字段 / 支付方式差异 / 缴款单 / 日结现金汇总 / 门店盘点范围 | pos_cash_drop_items, pos_cash_drops, pos_shift_payments | pos_cash_drop_items, pos_cash_drops, pos_daily_closes, pos_orders, pos_shift_payments, pos_shifts, stock_checks |
| 025 | `025_promo_member.cjs` | 商城促销与会员：活动 / 预算 / 促销 / 规则 / 方式 / 使用登记 / 优惠留痕 / 券 / 等级 / 积分储值账 | coupon_instances, coupons, member_accounts, member_balance_ledger, member_levels, member_points_ledger, promotion_adjustments, promotion_campaign_budgets, promotion_campaigns, promotion_methods, promotion_rules, promotion_usages, promotions | coupon_instances, coupons, mall_customers, member_accounts, member_balance_ledger, member_points_ledger, oms_order_items, promotion_adjustments, promotion_campaign_budgets, promotion_rules, promotion_usages, promotions |
| 026 | `026_mcp_guard.cjs` | MCP 安全闸加固（确认单绑定 + 幂等载荷指纹 + 确认权限点） | — | mcp_idempotency |
| 027 | `027_transition_policy.cjs` | 流转入口闸门（通用流转默认拒绝 + 效果归属声明） | doc_transition_policy | — |
| 028 | `028_sales_return_closure.cjs` | 销售退货闭环（来源行绑定 / 退量上限 / 成本追溯 / 应收冲减 / 幂等键） | — | sales_return_items, sales_returns |
| 029 | `029_mcp_confirm_actor.cjs` | MCP 确认单签字人（D5：确认人 = 审批签字人） | — | — |
| 030 | `030_settlement_source.cjs` | 结算留痕来源通道（A14：商城/POS 接入结算域的前置） | — | coupon_instances, member_points_ledger, promotion_adjustments, promotion_usages |
| 031 | `031_dealer_agreement_rebate.cjs` | DMS 渠道协议价 + 返利核销闭环（协议价档案 / 核销单 / 应收冲减） | price_agreements, rebate_settlement_items, rebate_settlements | price_agreements, rebate_settlement_items, rebate_settlements |
| 032 | `032_voucher.cjs` | 业财一体凭证（会计科目 / 凭证模板 / 凭证与分录 / 试算平衡） | accounting_subjects, voucher_entries, voucher_template_entries, voucher_templates, vouchers | accounting_subjects, voucher_entries, voucher_template_entries, vouchers |
| 033 | `033_refund.cjs` | 退款单（销售退货待退款兑现 / 上限判据 / 幂等 / 账务后果） | refund_items, refunds | refund_items, refunds |
| 034 | `034_report.cjs` | 报表体系（资产负债表 / 利润表 / 现金流量表 / 会计期间 / 期初余额） | accounting_opening_balances, accounting_periods, report_defs, report_lines | accounting_opening_balances, report_lines, vouchers |
| 035 | `035_period_closing.cjs` | 期末结转与结账（损益结转 / 结转留痕 / 结转账从发生额口径中剔除） | — | accounting_periods |
| 036 | `036_annual_closing.cjs` | 年度结转与利润分配（4103→4104 · 分配决议 · 封整年） | — | accounting_periods |
| 037 | `037_period_audit.cjs` | 期间审计链（关账/结转/年结/分配的变更日志 · 只追加 · 可重放） | period_audit_log | period_audit_log |
| 038 | `038_setting_audit.cjs` | 配置变更留痕（settings 的变更日志 · 只追加 · 可重放） | setting_audit_log | setting_audit_log |
| 039 | `039_report_config_audit.cjs` | 报表口径变更留痕（会计政策的每一次改动 · 整行快照 · 只追加 · 可重放） | report_config_audit_log | report_config_audit_log |
| 040 | `040_im_sync.cjs` | 钉钉/飞书 组织与审批同步（映射表 · 同步流水 · 冲突台账） | im_approval_map, im_dept_map, im_platform_cfg, im_sync_conflicts, im_sync_runs, im_user_map | im_approval_map, im_dept_map, im_sync_conflicts, im_sync_runs, im_user_map |
| 041 | `041_cash_flow_item.cjs` | 现金流量项目辅助核算（项目字典 + 分录上的项目标记） | cash_flow_items | cash_flow_items, voucher_entries |
| 042 | `042_product_require_qc.cjs` | 成品「启用质检」开关（products.require_qc） | — | — |
| 043 | `043_statement_actions.cjs` | 对账单终局动作：结清 / 作废（dealer_statements 终局列） | — | — |
| 045 | `045_inv_txn_doc_types.cjs` | 库存事务类型字典补录 MR / MO / PUR_IN_REV | — | — |
| 046 | `046_oc_statement_actions.cjs` | 订货对账单终局动作：结清 / 作废（oc_statements 终局列） | — | — |
| 047 | `047_inv_txn_types_master.cjs` | 出入库单据类型主数据化：saleable_only / ledger_subject_code | — | — |
| 048 | `048_purchase_settlement_return_amount.cjs` | 采购结算单补退货抵减额（purchase_settlements.return_amount） | — | — |
| 049 | `049_scm_role.cjs` | 新增「供应链主管」角色（scm）与其权限 | — | — |
| 050 | `050_user_auth_version.cjs` | 账号会话撤销版本 | — | users |
| 052 | `052_credit_release_ledger.cjs` | 授信释放台账（收款/预收释放逐笔归属，作废逐笔恢复） | credit_release_ledger | credit_release_ledger |
| 053 | `053_agent_token_owner_version.cjs` | Agent Token 记录签发时所有者的会话版本 | — | agent_tokens |
| 055 | `055_agent_token_revoke_reason.cjs` | Agent Token 记录吊销原因与时间 | — | agent_tokens |
| 056 | `056_funds_maker_checker.cjs` | 收付款证据与二人复核（evidence_* / review_* 列 + finance.funds.review 权限点） | — | — |
| 057 | `057_payment_release_ledger.cjs` | 付款释放台账（付款生效逐笔冲减应付，作废逐笔逆向） | payment_release_ledger | payment_release_ledger |
| 058 | `058_pos_permissions.cjs` | 门店 POS 权限点补全（pos.view / pos.cashdrop.receive）与内置角色授权 | — | — |
| 059 | `059_indexes.cjs` | 索引审计补缺（外键列 / 状态+日期 / 月度聚合表达式索引） | — | — |
| 060 | `060_qimen_secrets.cjs` | 奇门网关每平台密钥（封存）、防重放 nonce 表与 oms.platform.manage 权限点 | qimen_nonces | platforms, qimen_nonces |
| 061 | `061_hot_query_indexes.cjs` | 大库热点查询索引（低库存预警 / 看板待办计数） | — | — |
| 062 | `062_audit_view_permission.cjs` | 审计日志查看权限点 system:audit:view | — | — |
| 063 | `063_approval_template_perm.cjs` | 审批模板维护权限点 system:approval:template | — | — |
| 065 | `065_audit_log_indexes.cjs` | 审计日志检索索引（module/user/entity） | — | — |
| 066 | `066_pos_settle_permission.cjs` | 交班差异结案权限点 pos.shift.settle | — | — |
| 067 | `067_audit_fts.cjs` | 审计日志关键词检索（FTS5 外部内容表 + 触发器） | — | audit_logs, temp |
| 068 | `068_audit_hash_chain.cjs` | 审计日志哈希链（prev_hash/row_hash + 锚点表） | audit_chain_anchors | audit_chain_anchors, audit_logs |
| 069 | `069_qimen_clear_demo_secret.cjs` | 清除库内公开奇门演示签名常量并记录事实 | — | — |
