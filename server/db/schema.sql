-- GML 供应链协同系统 · 数据库结构 (SQLite)
-- 模块：主数据 / 采购 / 销售 / 存货 / 经销商 / 门店 / 线上 OMS

PRAGMA foreign_keys = ON;

-- ========== 系统与权限 ==========
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer',          -- admin/purchase/sales/warehouse/dealer/store/viewer
  dept TEXT,
  phone TEXT,
  dealer_id INTEGER,
  store_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER,
  user_name TEXT,
  action TEXT NOT NULL,
  module TEXT,
  entity TEXT,
  entity_id TEXT,
  detail TEXT,
  ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ========== 主数据：商品 ==========
CREATE TABLE IF NOT EXISTS brands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  en_name TEXT,
  origin TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id INTEGER,
  sort_no INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spu_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand_id INTEGER REFERENCES brands(id),
  category_id INTEGER REFERENCES categories(id),
  series TEXT,
  spec TEXT,                                    -- 规格：30ml / 50g
  unit TEXT DEFAULT '瓶',
  barcode TEXT,
  shelf_life_months INTEGER DEFAULT 36,         -- 保质期（月）
  batch_managed INTEGER DEFAULT 1,              -- 是否批次管理
  tax_rate REAL DEFAULT 13,
  price_retail REAL DEFAULT 0,                  -- 零售价
  price_dealer REAL DEFAULT 0,                  -- 经销价
  price_member REAL DEFAULT 0,                  -- 会员价
  cost_std REAL DEFAULT 0,                      -- 标准成本
  safe_stock INTEGER DEFAULT 0,
  procurement_type TEXT NOT NULL DEFAULT 'buy',  -- 供货方式：buy外购/self自制/outsource委外（净需求分流依据）
  item_type TEXT NOT NULL DEFAULT 'product',     -- 物料类型：product成品/material原料包材（POS/销售仅售成品）
  status TEXT NOT NULL DEFAULT 'active',
  image_emoji TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS product_skus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color_no TEXT,                                -- 色号 / 香型
  spec TEXT,
  barcode TEXT,
  price_retail REAL DEFAULT 0,
  price_dealer REAL DEFAULT 0,
  price_member REAL DEFAULT 0,
  cost_std REAL DEFAULT 0,
  safe_stock INTEGER DEFAULT 0,
  min_stock INTEGER DEFAULT 0,                 -- 最低库存（短缺预警线，用友口径）
  max_stock INTEGER DEFAULT 0,                 -- 最高库存（超储预警线）
  serial_managed INTEGER DEFAULT 0,            -- 是否序列号管理（礼盒/仪器类单品一码）
  status TEXT NOT NULL DEFAULT 'active'
);

-- ========== 主数据：组织与往来 ==========
CREATE TABLE IF NOT EXISTS warehouses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'normal',          -- central总仓/region区域仓/store门店仓/ecom电商仓
  store_id INTEGER,
  address TEXT,
  manager TEXT,
  phone TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS stores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'direct',          -- direct直营/franchise加盟/counter专柜
  region TEXT,
  city TEXT,
  address TEXT,
  manager TEXT,
  phone TEXT,
  open_date TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE IF NOT EXISTS suppliers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT,                                -- 原料/OEM/包材/物流
  contact TEXT,
  phone TEXT,
  address TEXT,
  tax_no TEXT,
  bank_account TEXT,
  settle_type TEXT DEFAULT '月结30天',
  credit_days INTEGER DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dealers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  level TEXT NOT NULL DEFAULT 'silver',         -- diamond钻石/gold金牌/silver银牌/bronze普通
  region TEXT,
  city TEXT,
  channel_type TEXT DEFAULT 'cs',               -- cs日化专营/ka商超/ecom电商/med医疗美妆
  contact TEXT,
  phone TEXT,
  address TEXT,
  tax_no TEXT,
  credit_limit REAL DEFAULT 0,                  -- 信用额度
  credit_used REAL DEFAULT 0,
  price_level TEXT DEFAULT 'dealer',            -- 价格级别
  discount_rate REAL DEFAULT 100,               -- 折扣率（%），100=不打折
  rebate_rate REAL DEFAULT 0,                   -- 返利点位（%）
  settle_type TEXT DEFAULT '月结30天',
  onboard_date TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT
);

-- ========== 采购 ==========
CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  order_date TEXT NOT NULL,
  expect_date TEXT,
  buyer TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/submitted/approved/received/closed/cancelled
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  tax_amount REAL DEFAULT 0,
  settle_type TEXT,
  fulfill_type TEXT DEFAULT 'hq',                -- 履约方式：hq总部入库/direct直运门店仓
  target_store_id INTEGER,                       -- 直运时的目标门店
  target_warehouse_id INTEGER,                   -- 直运时的收货门店仓
  source_requisition_id INTEGER,                 -- 来源门店要货单（由要货转采购）
  source_type TEXT DEFAULT 'manual',             -- 来源类型：manual手工/requisition门店要货/dealer_summary经销汇总
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  tax_rate REAL DEFAULT 13,
  amount REAL DEFAULT 0,
  received_qty REAL DEFAULT 0,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS purchase_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES purchase_orders(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  receipt_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',      -- draft/received/checked
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  inspector TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES purchase_receipts(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  produce_date TEXT,
  expire_date TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS purchase_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  return_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/confirmed/completed
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS purchase_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

-- ========== 销售 ==========
CREATE TABLE IF NOT EXISTS sales_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  channel TEXT NOT NULL DEFAULT 'dealer',       -- dealer经销商/store门店/online自营电商/platform平台电商
  dealer_id INTEGER REFERENCES dealers(id),
  store_id INTEGER REFERENCES stores(id),
  platform_id INTEGER,
  oms_order_no TEXT,
  order_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/confirmed/picking/shipped/completed/cancelled
  total_qty REAL DEFAULT 0,
  goods_amount REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  freight REAL DEFAULT 0,
  receivable_amount REAL DEFAULT 0,
  paid_amount REAL DEFAULT 0,
  receiver TEXT,
  receiver_phone TEXT,
  receiver_address TEXT,
  express_company TEXT,
  express_no TEXT,
  salesperson TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id),
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS sales_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,
  price REAL NOT NULL DEFAULT 0,
  discount REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  shipped_qty REAL DEFAULT 0,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS sales_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES sales_orders(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  delivery_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'shipped',       -- draft/shipped/signed
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  express_company TEXT,
  express_no TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sales_delivery_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  delivery_id INTEGER NOT NULL REFERENCES sales_deliveries(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS sales_returns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES sales_orders(id),
  channel TEXT DEFAULT 'dealer',
  dealer_id INTEGER REFERENCES dealers(id),
  store_id INTEGER REFERENCES stores(id),
  warehouse_id INTEGER REFERENCES warehouses(id),
  return_date TEXT NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/confirmed/completed
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS sales_return_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  return_id INTEGER NOT NULL REFERENCES sales_returns(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

-- ========== 存货 ==========
CREATE TABLE IF NOT EXISTS inventory_stocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT NOT NULL DEFAULT '',
  produce_date TEXT,
  expire_date TEXT,
  entry_date TEXT,                             -- 入库日期（库龄计算基准）
  location TEXT,                               -- 货位编码
  qty_on_hand REAL NOT NULL DEFAULT 0,          -- 现存量（用友口径）
  qty_reserved REAL NOT NULL DEFAULT 0,         -- 冻结量/占用量
  qty_in_transit REAL NOT NULL DEFAULT 0,       -- 在途量（调拨在途，预计入库量之一）
  qty_ordered REAL NOT NULL DEFAULT 0,          -- 待发货量（已确认未发货，预计出库量）
  cost_price REAL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (warehouse_id, sku_id, batch_no)
);

CREATE TABLE IF NOT EXISTS inventory_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date TEXT NOT NULL,
  doc_type TEXT NOT NULL,                       -- 出/入库类型：**取值以 `inv_txn_types` 为准**（客户可自建），此处不再列举（旧注释只列了 8 个、已过期；守卫见 scripts/check-inv-txn-dict.mjs）
  doc_no TEXT NOT NULL,
  doc_id INTEGER,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  direction TEXT NOT NULL,                      -- in / out
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  balance_qty REAL DEFAULT 0,
  counterparty TEXT,
  operator TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  transfer_date TEXT NOT NULL,
  type TEXT DEFAULT 'normal',                   -- 唯一出处 server/lib/transfer.js 的 TRANSFER_TYPES：normal普通调拨/allocation铺货调拨/qc_disposition质检处置调拨
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/shipped/received/cancelled
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  applicant TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS stock_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  check_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/checking/adjusted
  checker TEXT,
  total_diff_qty REAL DEFAULT 0,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS stock_check_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_id INTEGER NOT NULL REFERENCES stock_checks(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  book_qty REAL DEFAULT 0,
  actual_qty REAL DEFAULT 0,
  diff_qty REAL DEFAULT 0,
  reason TEXT
);

-- ========== 线上 OMS ==========
CREATE TABLE IF NOT EXISTS platforms (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  platform_code TEXT,                          -- 奇门平台编码 TB/JD/DYXD/PDD/KS/XHS/WX/MT
  name TEXT NOT NULL,
  shop_name TEXT,
  type TEXT DEFAULT 'platform',                 -- platform第三方平台/self自营商城/live直播/instant即时零售
  adapter TEXT DEFAULT 'qimen',                -- qimen奇门标准/jushuitan聚水潭/direct直连API
  app_key TEXT,
  app_secret_masked TEXT,
  qimen_url TEXT,                              -- 奇门网关地址
  qimen_wh TEXT,                               -- 奇门仓库编码（WMS 分配）
  shop_code TEXT,                              -- 店铺编码（奇门 shopCode）
  sync_stock INTEGER DEFAULT 1,
  sync_order INTEGER DEFAULT 1,
  warehouse_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  last_sync_at TEXT,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS oms_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id INTEGER NOT NULL REFERENCES platforms(id),
  platform_order_no TEXT NOT NULL,
  buyer_nick TEXT,
  order_time TEXT,
  pay_time TEXT,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending待发货/shipped已发货/completed已完成/refunding退款中/refunded已退款/closed已关闭
  goods_amount REAL DEFAULT 0,
  freight REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  pay_amount REAL DEFAULT 0,
  receiver TEXT,
  receiver_phone TEXT,
  receiver_address TEXT,
  express_company TEXT,
  express_no TEXT,
  sync_at TEXT,
  sales_order_id INTEGER,
  remark TEXT,
  UNIQUE (platform_id, platform_order_no)
);

CREATE TABLE IF NOT EXISTS oms_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  oms_order_id INTEGER NOT NULL REFERENCES oms_orders(id) ON DELETE CASCADE,
  platform_sku_code TEXT,
  sku_id INTEGER REFERENCES product_skus(id),
  title TEXT,
  spec TEXT,
  qty REAL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oms_sync_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  platform_id INTEGER REFERENCES platforms(id),
  sync_type TEXT NOT NULL,                      -- order/stock/shipment/refund/price
  direction TEXT NOT NULL DEFAULT 'in',         -- in拉取/out推送
  status TEXT NOT NULL DEFAULT 'success',       -- success/fail
  total_count INTEGER DEFAULT 0,
  success_count INTEGER DEFAULT 0,
  fail_count INTEGER DEFAULT 0,
  message TEXT,
  payload TEXT,
  cost_ms INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ========== 货位（用友：货位管理，分级/固定/动态） ==========
CREATE TABLE IF NOT EXISTS warehouse_locations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  code TEXT NOT NULL,
  name TEXT,
  type TEXT DEFAULT 'storage',                 -- receive收货区/storage存储区/pick拣选区/defect不合格品区
  max_capacity INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  UNIQUE (warehouse_id, code)
);

-- ========== 序列号管理（单品一码，全链路追溯） ==========
CREATE TABLE IF NOT EXISTS serial_numbers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial_no TEXT NOT NULL UNIQUE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  barcode TEXT,
  warehouse_id INTEGER REFERENCES warehouses(id),
  location TEXT,
  batch_no TEXT,
  status TEXT NOT NULL DEFAULT 'in_stock',     -- in_stock在库/reserved已占用/shipped已出库/returned已退回/scrapped报废
  entry_doc_no TEXT,
  entry_date TEXT,
  supplier_id INTEGER,
  holder TEXT,                                 -- 出库后持有人（经销商/客户昵称）
  exit_doc_no TEXT,
  exit_date TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sn_sku ON serial_numbers(sku_id);
CREATE INDEX IF NOT EXISTS idx_sn_status ON serial_numbers(status);

-- ========== 组合装（BOM：礼盒 / 套装 / 促销装） ==========
CREATE TABLE IF NOT EXISTS bundles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT DEFAULT 'giftbox',                 -- giftbox礼盒/set套装/promo促销装
  parent_sku_id INTEGER REFERENCES product_skus(id),
  price_retail REAL DEFAULT 0,
  price_dealer REAL DEFAULT 0,
  cost_std REAL DEFAULT 0,
  barcode TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS bundle_components (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bundle_id INTEGER NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  component_sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 1,
  remark TEXT
);

-- ========== 组装 / 拆卸单（用友：组装拆卸业务） ==========
CREATE TABLE IF NOT EXISTS assembly_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'assemble',       -- assemble组装/disassemble拆卸
  bundle_id INTEGER NOT NULL REFERENCES bundles(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  biz_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',        -- draft待确认/confirmed已过账
  qty REAL NOT NULL DEFAULT 1,
  total_cost REAL DEFAULT 0,
  operator TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS assembly_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES assembly_orders(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                          -- parent成品/component组件
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

-- ========== 经销商政策与对账 ==========
CREATE TABLE IF NOT EXISTS rebate_policies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'tiered',         -- tiered阶梯比例/fixed_per_unit按件定额/growth同比增量/payback回款达标/category品类专返/seasonal档期任务
  dealer_level TEXT DEFAULT 'all',             -- all/diamond/gold/silver/bronze
  channel_type TEXT DEFAULT 'all',             -- all/cs/ka/ecom/med
  period TEXT,                                 -- 生效期间 2026-Q4 / 2026-10
  basis TEXT DEFAULT 'net',                    -- net净销售(扣退货)/gross毛销售/pay回款额
  rules TEXT,                                  -- JSON 规则体：阶梯/单价/同比基数等
  rebate_cap REAL DEFAULT 0,                   -- 单期封顶（0=不封顶）
  priority INTEGER DEFAULT 100,                -- 计算优先级
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dealer_rebates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id),
  period TEXT NOT NULL,                         -- 2026-09
  policy_id INTEGER DEFAULT 0,                  -- 关联 rebate_policies，0=手工
  policy_name TEXT,
  calc_basis TEXT,                              -- 计返基数说明
  sales_amount REAL DEFAULT 0,
  return_amount REAL DEFAULT 0,
  net_amount REAL DEFAULT 0,
  rebate_rate REAL DEFAULT 0,
  rebate_amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',       -- pending待核算/confirmed已确认/paid已发放
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (dealer_id, period, policy_id)
);

CREATE TABLE IF NOT EXISTS dealer_statements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  opening_amount REAL DEFAULT 0,
  sales_amount REAL DEFAULT 0,
  return_amount REAL DEFAULT 0,
  received_amount REAL DEFAULT 0,
  closing_amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft',         -- draft/confirmed/sent
  confirmed_at TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ========== AI FDE 承接 ==========
CREATE TABLE IF NOT EXISTS ai_query_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT,
  intent TEXT,
  api_path TEXT,
  params TEXT,
  result_rows INTEGER,
  cost_ms INTEGER,
  user_id INTEGER,
  source TEXT DEFAULT 'api',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_it_sku ON inventory_transactions(sku_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_it_wh ON inventory_transactions(warehouse_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_it_doc ON inventory_transactions(doc_no);
CREATE INDEX IF NOT EXISTS idx_so_status ON sales_orders(status, order_date);
CREATE INDEX IF NOT EXISTS idx_so_dealer ON sales_orders(dealer_id, order_date);
CREATE INDEX IF NOT EXISTS idx_po_status ON purchase_orders(status, order_date);
CREATE INDEX IF NOT EXISTS idx_oms_status ON oms_orders(status, order_time);
CREATE INDEX IF NOT EXISTS idx_stock_sku ON inventory_stocks(sku_id);

-- ========== 线下门店 POS（本地单 + 日结上传总部）==========
CREATE TABLE IF NOT EXISTS pos_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),   -- 门店仓
  cashier_id INTEGER REFERENCES users(id),
  cashier_name TEXT,
  biz_date TEXT NOT NULL,
  member_phone TEXT,                                          -- 会员手机号（一账通主键）
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  discount_amount REAL DEFAULT 0,
  pay_amount REAL DEFAULT 0,
  pay_method TEXT DEFAULT 'cash',                             -- cash现金/wxpay微信/alipay支付宝/unionpay银联/balance储值
  status TEXT NOT NULL DEFAULT 'local',                       -- local本机/voided已作废/synced已上传总部
  sync_batch TEXT,                                            -- 日结批次号
  sync_at TEXT,
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS pos_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pos_order_id INTEGER NOT NULL REFERENCES pos_orders(id),
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  sku_code TEXT, sku_name TEXT,
  price REAL DEFAULT 0,                                       -- 成交单价（含会员价逻辑）
  qty REAL DEFAULT 0,
  amount REAL DEFAULT 0
);

-- 班次与日结：门店一天一结，集中上传总部
CREATE TABLE IF NOT EXISTS pos_shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  cashier_id INTEGER REFERENCES users(id),
  cashier_name TEXT,
  biz_date TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  status TEXT NOT NULL DEFAULT 'open',                        -- open营业中/closed已交班
  opening_float REAL DEFAULT 0,                               -- 备用金
  remark TEXT
);

CREATE TABLE IF NOT EXISTS pos_daily_closes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no TEXT NOT NULL UNIQUE,                              -- 日结批次 RBJ-xxx
  store_id INTEGER NOT NULL REFERENCES stores(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  biz_date TEXT NOT NULL,
  order_count INTEGER DEFAULT 0,
  sales_amount REAL DEFAULT 0,
  refund_amount REAL DEFAULT 0,
  net_amount REAL DEFAULT 0,
  pay_breakdown TEXT,                                         -- JSON：{cash:..,wxpay:..}
  uploaded_orders INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'uploaded',                    -- uploaded已上传/voided作废
  hq_sales_order_ids TEXT,                                    -- 上传后生成的总部销售单ID串
  operator TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ========== H5 线上门店（商城）==========
CREATE TABLE IF NOT EXISTS mall_customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL UNIQUE,                                 -- 会员一账通主键
  name TEXT,
  points INTEGER DEFAULT 0,
  total_orders INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  last_active_at TEXT
);

CREATE TABLE IF NOT EXISTS mall_cart_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT NOT NULL,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty INTEGER DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (phone, sku_id)
);

CREATE INDEX IF NOT EXISTS idx_pos_store ON pos_orders(store_id, biz_date);
CREATE INDEX IF NOT EXISTS idx_pos_sync ON pos_orders(status);
CREATE INDEX IF NOT EXISTS idx_pdc_store ON pos_daily_closes(store_id, biz_date);

-- ==================================================================
-- 门店要货（门店 → 总部受理 → 采购 / 配货 → 发货 → 门店收货）
-- ==================================================================
CREATE TABLE IF NOT EXISTS store_requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  store_id INTEGER NOT NULL REFERENCES stores(id),
  store_warehouse_id INTEGER REFERENCES warehouses(id),   -- 收货门店仓
  req_date TEXT NOT NULL,
  expect_date TEXT,
  applicant TEXT,
  urgency TEXT NOT NULL DEFAULT 'normal',                 -- normal正常/urgent紧急
  status TEXT NOT NULL DEFAULT 'submitted',               -- submitted待受理/processing处理中/shipped已发货/partial部分收货/received已收货/transferred已转采购/allocated已配货/completed已完成/rejected已驳回/cancelled已取消
  source TEXT NOT NULL DEFAULT 'pos',                     -- pos门店自助/hq总部建议
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  linked_po_ids TEXT,                                     -- 转采购生成的采购单ID串
  linked_transfer_id INTEGER,                             -- 走调拨配货时的调拨单ID
  linked_shipment_ids TEXT,                               -- 发货单ID串
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS store_requisition_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES store_requisitions(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,                            -- 申请数量
  approved_qty REAL DEFAULT 0,                            -- 核减后数量
  store_stock REAL DEFAULT 0,                             -- 要货时门店现存量快照
  price REAL DEFAULT 0,                                   -- 成本参考价
  status TEXT NOT NULL DEFAULT 'pending',                 -- pending待处理/approved已批准/short缺货
  remark TEXT
);

-- ==================================================================
-- 门店发货与收货（总部参考要货单发货 → 门店选择性收货，形成闭环）
-- ==================================================================
CREATE TABLE IF NOT EXISTS store_shipments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  requisition_id INTEGER REFERENCES store_requisitions(id),      -- 来源要货单
  store_id INTEGER NOT NULL REFERENCES stores(id),
  from_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),  -- 发货仓（中心仓）
  to_warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),    -- 收货门店仓
  ship_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',                          -- draft待发货/shipped已发货/partial部分收货/received已收货/closed已关闭/cancelled已取消
  total_qty REAL DEFAULT 0,                                      -- 本次发货数量合计
  received_qty REAL DEFAULT 0,                                   -- 门店实收数量合计
  diff_qty REAL DEFAULT 0,                                       -- 差异数量合计（实收-发货）
  total_amount REAL DEFAULT 0,
  receiver TEXT,                                                 -- 门店收货人
  carrier TEXT,
  express_no TEXT,
  shipped_at TEXT,
  received_at TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS store_shipment_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shipment_id INTEGER NOT NULL REFERENCES store_shipments(id) ON DELETE CASCADE,
  requisition_item_id INTEGER REFERENCES store_requisition_items(id),
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  req_qty REAL DEFAULT 0,                                        -- 对应要货数量
  ship_qty REAL NOT NULL DEFAULT 0,                              -- 本次发货数量
  recv_qty REAL,                                                 -- 门店实收数量（NULL=未收货）
  diff_qty REAL,                                                 -- 差异 = 实收 - 发货
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  batches TEXT,                                                  -- 发货批次明细 JSON（收货按序分摊入库）
  remark TEXT
);

CREATE INDEX IF NOT EXISTS idx_ss_store ON store_shipments(store_id, ship_date);
CREATE INDEX IF NOT EXISTS idx_ss_status ON store_shipments(status);
CREATE INDEX IF NOT EXISTS idx_ssi_ship ON store_shipment_items(shipment_id);

-- ==================================================================
-- 总部委外（参照用友委外标准业务：委外订单 → 委外发料 → 委外收货）
-- ==================================================================
CREATE TABLE IF NOT EXISTS outsourcing_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),  -- 委外加工商
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),-- 成品入库仓
  material_warehouse_id INTEGER REFERENCES warehouses(id),-- 材料发料仓
  order_date TEXT NOT NULL,
  expect_date TEXT,
  buyer TEXT,
  status TEXT NOT NULL DEFAULT 'draft',                   -- draft/submitted/approved/issued已发料/part_received/received/closed/cancelled
  out_type TEXT NOT NULL DEFAULT 'normal',                -- normal一般委外/process工序委外
  product_qty REAL DEFAULT 0,                             -- 应回收成品数量
  product_amount REAL DEFAULT 0,                          -- 成品标准成本金额
  material_qty REAL DEFAULT 0,                            -- 应发材料数量
  material_amount REAL DEFAULT 0,                         -- 材料成本金额
  process_fee REAL DEFAULT 0,                             -- 加工费合计
  total_amount REAL DEFAULT 0,
  settle_type TEXT DEFAULT '月结30天',
  source_type TEXT DEFAULT 'manual',                      -- manual手工/plan净需求汇总
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS outsourcing_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES outsourcing_orders(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                     -- product成品/material材料
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,                                   -- 成品：加工费单价；材料：成本单价
  amount REAL DEFAULT 0,
  issued_qty REAL DEFAULT 0,                              -- 已发料数量（材料行）
  received_qty REAL DEFAULT 0,                            -- 已收货数量（成品行）
  remark TEXT
);

CREATE TABLE IF NOT EXISTS outsourcing_materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES outsourcing_orders(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  issue_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'issued',                  -- issued已发料
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  operator TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS outsourcing_material_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  issue_id INTEGER NOT NULL REFERENCES outsourcing_materials(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  qty REAL NOT NULL DEFAULT 0,
  cost_price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  remark TEXT
);

CREATE TABLE IF NOT EXISTS outsourcing_receipts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES outsourcing_orders(id),
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
  receipt_date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'received',                -- received已收货
  total_qty REAL DEFAULT 0,
  process_fee REAL DEFAULT 0,                             -- 本次加工费
  total_amount REAL DEFAULT 0,
  inspector TEXT,
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS outsourcing_receipt_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  receipt_id INTEGER NOT NULL REFERENCES outsourcing_receipts(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no TEXT,
  produce_date TEXT,
  expire_date TEXT,
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,                                   -- 单位加工费
  amount REAL DEFAULT 0,
  remark TEXT
);

-- ==================================================================
-- 经销商要货申请与计划（总部按时间段汇总 → 净需求 → 采购/生产/委外）
-- ==================================================================
CREATE TABLE IF NOT EXISTS dealer_requisitions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id),
  req_date TEXT NOT NULL,
  expect_date TEXT,
  applicant TEXT,
  status TEXT NOT NULL DEFAULT 'submitted',               -- submitted待受理/approved已确认/converted已转单/rejected已驳回/cancelled已取消
  total_qty REAL DEFAULT 0,
  total_amount REAL DEFAULT 0,
  linked_order_nos TEXT,                                  -- 转单生成的采购/生产/委外单号串
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS dealer_requisition_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requisition_id INTEGER NOT NULL REFERENCES dealer_requisitions(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,
  price REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  remark TEXT
);

-- 经销商要货计划（滚动月度预测，总部按期间汇总）
CREATE TABLE IF NOT EXISTS dealer_requisition_plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  dealer_id INTEGER NOT NULL REFERENCES dealers(id),
  period TEXT NOT NULL,                                   -- 要货期间 2026-11
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  plan_qty REAL NOT NULL DEFAULT 0,
  plan_amount REAL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'forecast',                -- forecast预测/confirmed已确认/closed已关闭
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (dealer_id, period, sku_id)
);

-- 生产订单（净需求自产部分；表头+成品/材料明细）
CREATE TABLE IF NOT EXISTS production_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  product_sku_id INTEGER NOT NULL REFERENCES product_skus(id),  -- 生产成品
  warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),      -- 完工入库仓
  plan_date TEXT NOT NULL,
  expect_date TEXT,
  status TEXT NOT NULL DEFAULT 'draft',                   -- draft/submitted/approved/in_progress/completed/closed/cancelled
  qty REAL NOT NULL DEFAULT 0,
  completed_qty REAL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  material_cost REAL DEFAULT 0,
  total_cost REAL DEFAULT 0,
  source_type TEXT DEFAULT 'manual',                      -- manual手工/plan净需求汇总
  remark TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS production_order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  role TEXT NOT NULL,                                     -- product成品/material材料
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  qty REAL NOT NULL DEFAULT 0,
  unit_cost REAL DEFAULT 0,
  amount REAL DEFAULT 0,
  remark TEXT
);

-- 净需求汇总建议（总部按时间段汇总后生成的运算结果，可追溯生成去向）
CREATE TABLE IF NOT EXISTS demand_plan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_no TEXT NOT NULL UNIQUE,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  warehouse_id INTEGER,
  rule TEXT,                                              -- JSON：分流规则（自制/委外/外购判断）
  total_sku INTEGER DEFAULT 0,
  total_demand REAL DEFAULT 0,
  total_shortage REAL DEFAULT 0,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sr_store ON store_requisitions(store_id, req_date);
CREATE INDEX IF NOT EXISTS idx_sr_status ON store_requisitions(status);
CREATE INDEX IF NOT EXISTS idx_dr_dealer ON dealer_requisitions(dealer_id, req_date);
CREATE INDEX IF NOT EXISTS idx_drp_period ON dealer_requisition_plans(period, sku_id);
CREATE INDEX IF NOT EXISTS idx_os_status ON outsourcing_orders(status, order_date);
CREATE INDEX IF NOT EXISTS idx_prod_status ON production_orders(status, plan_date);
