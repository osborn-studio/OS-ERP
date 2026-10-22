# GML 模块 02 · 主数据与商品中心 — 详细设计

> 版本：v2 ｜ 日期：2026-10-14 ｜ 性质：内部设计稿，供逐模块评审
> 上游：《GML 系统总体框架与模块地图 v1.1》第五节「共享能力中心」
> 定位：L2 共享能力中心的第一个模块。**一切业务单据都以主数据为外键**，所以它必须先立。
> **v2 变更**：按决策，商品层**拆出独立 SPU**（四层做全）、**往来单位统一**（`partners` + 角色扩展）；决策点 1、3 已定案。
> 声明：不含任何客户信息、真实价格或商业机密；不构成承诺。

---

## 一、目标与范围

**本模块要解决的一句话问题**：现在商品数据"能存"，但"讲不清楚"——同一个价格散在四个地方、渠道商品对不上内部 SKU、一件商品能不能在某家店卖没有依据、同一家公司既供货又进货却要建两条档案。

**范围内**：商品四层（物料 / SPU / SKU / 渠道商品）、类目与品牌、属性与规格、多条码、多计量单位、经营范围、生命周期与变更留痕；**往来单位统一主档**；组织、部门、人员；仓库与货位；平台与店铺。

**范围外**（归其它模块，本文只约定接口）：
- 价格的**计算与优先级** → 模块 06 / 取价引擎（本文只定"价格挂在哪"）
- 库存数量与成本 → 模块 03 / 库存中心
- 促销与优惠 → 模块 13 / 促销引擎
- 单据的流转 → 模块 04 / 单据内核

---

## 二、现状盘点（2026-10-14 实测）

### 2.1 已有的表

| 表 | 行数 | 评价 |
|---|---|---|
| `products` | 26 | **物料与商品混在一张表**（决策：拆开）；规格、色号硬编码成列 |
| `product_skus` | 41 | 可售最小单位，可用；缺 SPU 与物料的归属外键 |
| `brands` | 8 | 够用 |
| `categories` | 14 | 有 `parent_id`，可多级，够用 |
| `suppliers` | 8 | 够用，但**独立成表**（决策：挂到统一往来单位） |
| `warehouses` | 8 | 有 `type`（central/region/store/ecom）+ `store_id` 绑定门店仓，设计不错 |
| `warehouse_locations` | 64 | 按仓建货位，够用 |
| `stores` | 5 | 够用，但**独立成表**（决策：挂到统一往来单位） |
| `dealers` | 20 | 字段较全（等级、信用额度、价格级别、折扣率、返点率），**独立成表**（决策同上） |
| `platforms` | 10 | 有奇门字段（app_key / shop_code / qimen_url），够用 |
| `bundles` + `bundle_components` | 3 + 8 | 组合装，够用但**与单品走两条路**（拆出 SPU 后归位） |
| `serial_numbers` | 815 | 序列号全生命周期跟踪，做得不错 |
| `users` | — | `dept` 是字符串，无部门表 |

### 2.2 实测出的六个真问题

**问题 1 · 价格散落四处，没有优先级规则**（最严重）

`products` 有 `price_retail / price_dealer / price_member / cost_std`，
`product_skus` 有**同名同义**的 `price_retail / price_dealer / price_member / cost_std`，
`bundles` 又有 `price_retail / price_dealer / cost_std`。
再加上 `dealers.discount_rate` 和 `dealers.price_level`。

**同一件商品的价格存在 4 个地方，没有任何地方规定哪个生效。** 现在下单时取哪个，取决于各路由当时怎么写。这是最容易在演示时"同一个商品两个价"翻车的地方。

**问题 2 · 没有渠道商品映射表**（实测确认：无）

平台订单回来只有 `oms_order_items.platform_sku_code` 这个**裸字符串**。意思是：卖出去的那件东西，只能靠字符串硬猜是哪个内部 SKU。天猫叫「晨曦精华水 30ml 正装」、京东叫「晨曦 LANXU 精华水 30ml 补水保湿」，两者是同一个 `SKU-LX-001`，但系统不知道。

**问题 3 · 规格靠硬编码列，两个行业共用一套表就会打架**

`products.color_no`（色号/香型）+ `products.spec`（30ml/50g）——这是**化妆品**的规格维度。
但服装要的是**颜色 × 尺码矩阵**（黑/白/驼 × S/M/L/XL）。现在的表结构表达不了。

**问题 4 · 没有多计量单位**

`products.unit` 是单值（'瓶'）。现实中采购按「箱」、销售按「瓶」（1 箱 = 24 瓶）。现在无法表达，采购单只能录瓶数。

**问题 5 · 没有经营范围**

没有任何表说明「这个 SKU 能在哪些门店 / 哪些渠道卖」。所以商城首页、POS 商品列表只能全量查出来，没法做真正的"门店经营范围"。

**问题 6 · 没有变更留痕与生效时间**

改价、改分类、改状态都是**就地覆盖**，没有历史。演示时没人能回答"这个价什么时候改的、谁改的"。

### 2.3 附带发现

- 没有**业务组织表**（`organizations` / 法人主体），只有仓库和门店
- 没有**部门表**，`users.dept` 是自由文本
- 供应商 / 经销商 / 门店**各自独立成表**，同一实体既是供应商又是客户时无法表达 → **决策：统一到 `partners` 主档 + 角色扩展表**（见 4.8）
- 组合装（`bundles`）与单品（`products`）**走在两条路上**，促销、订单、渠道映射都要写两遍 → 拆出 SPU 后归位（见 4.1）
- 主数据**没有服务出口**，各业务路由直接读表

---

## 三、参考口径

| 来源 | 学到的做法 | 我们怎么用 |
|---|---|---|
| 零售中台（商品中心） | **商品模型**：基础物料 → 销售商品（SPU/SKU）→ 渠道商品；"一处管理、全域生效" | 采用，并把 SPU 独立成层（决策已定） |
| 用友（存货 vs 商品） | **存货**用于库存与成本，**商品**用于销售与营销，两者可分可合 | **分设**：`products` 作物料（存货）档案，`spus` 作销售商品，SKU 同时挂两边（决策已定） |
| 用友（物料档案） | 含**计量单位组、主/辅计量单位、换算率**；业务属性（采购/销售/库存）勾选 | 增加单位组与换算，解决"箱/瓶" |
| 用友（基础数据） | 组织单元、部门档案、人员档案三级；**往来单位统一管理**（一个单位可同时是供应商与客户） | 补组织与部门表；往来单位按用友口径**统一进 `partners`**，供应商/经销商/客户是它的**角色**而非独立实体 |
| 零售中台（变更管理） | 商品变更留痕、上下架策略总部统一 + 门店个性化 | 增加主数据变更日志 + 生效时间 |

---

## 四、目标模型

### 4.1 商品四层模型（v2：SPU 独立）

```
L1 物料层  items（沿用 products 表，加列）
   角色：采购、生产、库存、成本、内部核算的载体
   唯一标识：物料编码（沿用 products.spu_code）
   关键属性：单位组、计价方式、税率、批次/序列号标志、成本价
   └─ 谁在用：采购订单行、库存流水、成本计算、会计分录、生产 BOM

L2 商品层  spus（★ 新增）
   角色：营销与销售的标准产品单元，跨渠道统一身份
   唯一标识：SPU 码 spu_code
   关键属性：品牌、类目、属性模板、主图、卖点、图文详情、上市/停售日期、生命周期
   └─ 谁在用：商城详情页、促销、导购、推荐、内容运营

L3 SKU 层  product_skus（沿用，加 spu_id / item_id）
   角色：库存与销售的最小单位，属性维度的唯一组合
   唯一标识：SKU 码 sku_code
   关键属性：属性值组合、条码、价格归属、上下架
   └─ 谁在用：订单行、库存台账、POS 扫码、会员价

L4 渠道商品层  channel_products（★ 新增）
   角色：内部 SKU ↔ 各平台商品 ID 的映射
   唯一标识：(channel_id, platform_sku_code)
   └─ 谁在用：OMS 订单归集、库存同步、对账
```

**三层关系**（SKU 是枢纽，双外键同时挂物料与商品）：

```
                     ┌──────────────┐
        items(物料)  │  1       n   │  product_skus (SKU)
        采购·库存 ──┼──────────────┼── 1 ──n → channel_products (渠道商品)
        成本·BOM    │              │              平台映射·库存同步
                     └──────┬───────┘
                            │ n
                     spus (SPU) 1
                     营销·图文·类目品牌·促销
```

**为什么 SPU 非要独立成层**（原 v1 建议合并，现按决策拆开，三条实打实的收益）：

1. **生命周期解耦**：物料可能因停产而停用，但商品还挂在商城清库存；反之商品下架不影响物料继续用于采购。合并在一张表时，改一个状态会**同时影响采购与销售两侧**。
2. **组合装归位**：现在套装是 `bundles` 独立表，和单品走在两条路上——促销、订单、渠道映射都要写两遍。拆出 SPU 后，**套装 = 多物料 SPU，单品 = 单物料 SPU**，同一套表结构，业务侧不用再区分。
3. **接口语义干净**：采购/库存接口只碰 `items`，商城/促销接口只碰 `spus` + `skus`，两边字段不再互相污染（现在 `products` 里既有 `cost_std` 又有 `price_retail` 还有卖点）。

**代价与规避**：代价是外键多一跳。规避办法是**在 SKU 上同时冗余 `spu_id` 与 `item_id` 两个外键**，业务路由一次 JOIN 就拿全，不用链式查询。冗余在写入时由一个统一服务维护，不靠各路由自觉。

> 现有 `products` 表**继续承载物料层**（不重命名物理表，避免大范围改代码），语义上即本模型的 `items`。新增 `spus` 表承接销售语义。

### 4.2 属性与规格模型（解决"颜色×尺码"）

用**属性定义 + 属性值 + SKU 属性值**三张表，让两个行业共用一套结构：

| 行业 | 参与 SKU 组合的属性 | 结果 |
|---|---|---|
| 化妆品 | 规格（30ml / 50g）、色号（#01 正红） | 2 × 3 = 6 个 SKU |
| 服装 | 颜色（黑/白/驼）、尺码（S/M/L/XL） | 3 × 4 = 12 个 SKU |
| 洗护 | 规格（500ml） | 1 个 SKU（单维度） |

**SPU 通过「属性模板」（`attribute_sets`）声明自己用哪几个维度**，生成 SKU 时按模板取笛卡尔积。这样"化妆品用规格×色号、服装用颜色×尺码"是**数据差异，不是代码差异**。

**SKU 不再需要 `color_no` / `spec` 两个硬编码列**——它们变成属性值，新增维度不用改表。

### 4.3 编码体系

| 码类型 | 归属表 | 用途 | 是否对外 |
|---|---|---|---|
| 物料编码 | `products.spu_code` | 内部唯一，采购/库存/成本外键 | 否 |
| SPU 码 | `spus.spu_code` | 销售商品唯一标识 | 半对外（可给平台做商家编码） |
| SKU 码 | `product_skus.sku_code` | 内部唯一，订单与库存外键 | 否 |
| 条码 | **`barcodes`（新增，多码）** | 扫码收银、仓储扫描 | 是 |
| 平台商品码 | `channel_products.platform_sku_code` | 对接平台 | 是 |

**为什么条码要单独建表**：一品多码是常态——同一 SKU 的箱码与瓶码不同、不同批次条码可能不同、平台会自建条码。现在 `products.barcode` / `product_skus.barcode` 各一个字段，扫码场景不够用。

### 4.4 多计量单位

| 表 | 说明 |
|---|---|
| `unit_groups` | 计量单位组（如"瓶箱组"） |
| `units` | 单位（瓶 = 基础单位 factor 1；箱 = 辅单位 factor 24） |

`products` 增三个字段：`base_unit_code`（基础/主计量单位）、`purchase_unit_code`（采购默认单位）、`sales_unit_code`（销售默认单位）。
业务含义：采购按箱录 10 箱 = 240 瓶入库，库存以瓶计量。

### 4.5 经营范围（SKU × 门店 / 渠道 / 仓库）

`sku_scopes` 表：`sku_id + scope_type(store/channel/warehouse) + scope_id + status + effective_from`。

用途：
- 商城首页只展示**本渠道**在售的商品
- POS 商品列表只查**本店**经营范围
- 未配置 = 默认全部放开（保持向后兼容）

### 4.6 生命周期 · 生效时间 · 变更留痕

**生命周期状态机**（替换现在的 `active/inactive` 二值）：

```
draft 草稿 ──→ pending 待审 ──→ active 已上架 ──→ offline 已下架
                                     │                    │
                                     └────── frozen 停用 ←─┘
```

**物料与商品各有一套状态**（这正是拆层的好处）：物料停用不影响商品在售；商品下架不影响物料继续采购。

**变更留痕**：`master_data_logs`（实体、实体 ID、字段、旧值、新值、操作人、时间、生效时间）。改价、改状态、改分类自动落一条。

**生效时间**：价格与分类变更带 `effective_from`，支持"明天起生效"，不用半夜改配置。

### 4.7 价格归属（本模块只做减法）

**商品侧不再持有价格。** 具体动作：

1. `products` / `product_skus` / `bundles` 的 `price_retail / price_dealer / price_member` 标记为**已废弃**（保留列做迁移兜底，代码不再读）
2. 统一到 `price_lists`（价目表）+ `price_list_items`（明细）
3. 价目表类型：零售价 / 会员价 / 经销价（按等级）/ 渠道价 / 协议价
4. **优先级由模块 06 取价引擎裁决**，本模块只负责"价格挂在哪"

> 这是模块 02 与模块 06 的分界线：02 定**数据结构**，06 定**取哪一条**。

### 4.8 其它主数据

| 对象 | 动作 | 优先级 |
|---|---|---|
| **往来单位 `partners` + `partner_roles`** | **新增统一主档**；`suppliers` / `dealers` / `stores` / `mall_customers` 通过 `partner_id` 挂角色扩展 | **P0（决策已定）** |
| 业务组织 `orgs` | 新增（法人/业务组织，`parent_id` 支持多级） | P1 |
| 部门 `departments` | 新增，`users.dept` 字符串改为 `users.dept_id` | P1 |
| 人员 `employees` | 新增人员档案，`users.employee_id` 关联 | P1 |
| 仓库 / 货位 | 保持现状，补 `org_id` 归属 | P2 |
| 平台 / 店铺 | 保持现状 | — |

**往来单位统一的具体做法**（「主档 + 角色扩展」双表，用友口径）：

```
partners（统一主档）
   code · name · 税号 · 法人 · 地址 · 联系人与电话
   账期 credit_days · 信用额度 credit_limit · 结算方式 settlement_method · 价格级别 price_level
        │
        ├── partner_roles：角色绑定（一个单位可有多个角色）
        │      role_type = supplier / customer / dealer / store / logistics
        │      带 scope_type + scope_id（可限定作用域，如某经销区域、某门店）
        │
        └── 角色扩展表（保留各自专属字段，不搬迁）
               suppliers   ← partner_id + 采购专属（付款条件、供货目录）
               dealers     ← partner_id + 经销专属（等级、折扣率、返点率）
               stores      ← partner_id + 门店专属（门店类型、所属区域）
               mall_customers ← partner_id + 会员专属（会员等级、积分）
```

**为什么要做**（原来我判断"结构洁癖"，现按决策做，理由是它确实解决两个真问题）：

1. **同一实体双身份**：化妆品行业的经销商普遍**既进货又代销**（经销商把滞销品退给品牌方，同时品牌方委托其代销）。不统一时，这家公司在 `suppliers` 和 `dealers` 里各有一条档案，**对账要跑两张表 union，信用额度算两遍**，谁也不知道它到底欠多少钱。
2. **账期与信用口径统一**：账期、信用额度、结算方式、对账周期是**往来单位的属性，不是角色的属性**。现在这三套表各有一份类似字段且口径不一致，财务对账时口径打架。

**做法上不推倒重来的关键**：`suppliers` / `dealers` / `stores` **保留原表**（改造成角色扩展表），只加一个 `partner_id` 外键。这样现有路由的 SQL 一句不用改，新增的只是"主档层"；查询往来余额时以 `partners` 为轴聚合，不用改各业务表。

---

## 五、数据模型（DDL 草案）

> 全部使用**标准 SQL**，不使用 SQLite 私有语法，便于将来平滑换库。

```sql
-- ============ L2 商品层：SPU ============
CREATE TABLE spus (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spu_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  brand_id INTEGER REFERENCES brands(id),
  category_id INTEGER REFERENCES categories(id),
  attribute_set_id INTEGER REFERENCES attribute_sets(id),  -- 该 SPU 用哪几个维度生成 SKU
  main_image TEXT,
  selling_points TEXT,                          -- 卖点，给商城详情页
  detail_html TEXT,                             -- 图文详情
  unit_desc TEXT,                               -- 展示用规格描述（30ml×3 等）
  is_bundle INTEGER NOT NULL DEFAULT 0,         -- 1 = 组合装（多物料）
  lifecycle TEXT NOT NULL DEFAULT 'draft',      -- draft/pending/active/offline/frozen
  listing_at TEXT,                              -- 上市日期
  delisting_at TEXT,                            -- 停售日期
  org_id INTEGER REFERENCES orgs(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT
);
CREATE INDEX idx_spus_lifecycle ON spus(lifecycle);

-- SPU ↔ 物料（单品 1 条；组合装 n 条，替代原 bundles 的角色）
CREATE TABLE spu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  spu_id INTEGER NOT NULL REFERENCES spus(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES products(id),
  qty REAL NOT NULL DEFAULT 1,                  -- 该 SPU 含此物料的数量
  UNIQUE (spu_id, item_id)
);

-- 属性模板：声明"这类 SPU 用哪几个维度"
CREATE TABLE attribute_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,                           -- 化妆品规格色号集 / 服装颜色尺码集
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE attribute_set_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_set_id INTEGER NOT NULL REFERENCES attribute_sets(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  sort_no INTEGER DEFAULT 0,
  UNIQUE (attribute_set_id, attribute_id)
);

-- ============ 计量单位组与单位 ============
CREATE TABLE unit_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  group_id INTEGER NOT NULL REFERENCES unit_groups(id),
  is_base INTEGER NOT NULL DEFAULT 0,           -- 是否基础单位
  factor REAL NOT NULL DEFAULT 1,               -- 相对基础单位的折算率
  status TEXT NOT NULL DEFAULT 'active'
);

-- ============ 属性与规格（替代 color_no / spec 硬编码列）============
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,                           -- 颜色 / 尺码 / 规格 / 色号
  input_type TEXT NOT NULL DEFAULT 'select',    -- select下拉 / input手填
  is_sku_dim INTEGER NOT NULL DEFAULT 1,        -- 是否参与 SKU 组合
  sort_no INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE attribute_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,                           -- 黑 / S / 30ml / #01正红
  sort_no INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (attribute_id, code)
);

CREATE TABLE sku_attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id),
  attribute_value_id INTEGER NOT NULL REFERENCES attribute_values(id),
  UNIQUE (sku_id, attribute_id)
);

-- ============ 多条码 ============
CREATE TABLE barcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL,
  sku_id INTEGER REFERENCES product_skus(id),
  product_id INTEGER REFERENCES products(id),
  type TEXT NOT NULL DEFAULT 'internal',        -- internal内部码 / ean13 / upc / platform
  is_primary INTEGER NOT NULL DEFAULT 0,        -- 是否主条码
  pack_factor REAL NOT NULL DEFAULT 1,          -- 该码对应的包装数量（箱码=24）
  unit_code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (barcode, sku_id)
);
CREATE INDEX idx_barcodes_code ON barcodes(barcode);

-- ============ L4 渠道商品映射 ============
CREATE TABLE channel_products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES platforms(id),   -- 渠道（平台/自营商城）
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  platform_sku_code TEXT NOT NULL,              -- 平台商品ID / 商家编码（奇门 itemCode）
  platform_title TEXT,                          -- 平台上的商品标题
  platform_spec TEXT,                           -- 平台规格描述
  outer_id TEXT,                                -- 商家外部编码 outerId
  status TEXT NOT NULL DEFAULT 'active',        -- active在售 / offline下架
  sync_stock INTEGER NOT NULL DEFAULT 1,        -- 是否参与库存同步
  effective_from TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (channel_id, platform_sku_code)
);
CREATE INDEX idx_chp_sku ON channel_products(sku_id);

-- ============ 经营范围 ============
CREATE TABLE sku_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,                     -- store门店 / channel渠道 / warehouse仓库
  scope_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  effective_from TEXT,
  UNIQUE (sku_id, scope_type, scope_id)
);

-- ============ 主数据变更留痕 ============
CREATE TABLE master_data_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,                         -- item / spu / sku / price_list / partner
  entity_id INTEGER NOT NULL,
  entity_code TEXT,
  field TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  changed_by INTEGER REFERENCES users(id),
  changed_by_name TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  effective_at TEXT,
  remark TEXT
);
CREATE INDEX idx_mdl_entity ON master_data_logs(entity, entity_id);

-- ============ 价格统一（结构归本模块，取价归模块 06）============
CREATE TABLE price_lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,                           -- retail零售 / member会员 / dealer经销 / channel渠道 / agree协议
  dealer_level TEXT,                            -- 经销价适用等级：diamond/gold/silver/bronze
  currency TEXT NOT NULL DEFAULT 'CNY',
  effective_from TEXT,
  effective_to TEXT,
  priority INTEGER NOT NULL DEFAULT 100,        -- 取价优先级，越小越优先
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE price_list_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  price_list_id INTEGER NOT NULL REFERENCES price_lists(id) ON DELETE CASCADE,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id),
  min_qty REAL NOT NULL DEFAULT 1,              -- 阶梯价起订量
  price REAL NOT NULL DEFAULT 0,
  UNIQUE (price_list_id, sku_id, min_qty)
);

-- ============ 往来单位统一（主档 + 角色）============
CREATE TABLE partners (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  short_name TEXT,
  tax_no TEXT,
  legal_person TEXT,
  address TEXT,
  contact_name TEXT,
  phone TEXT,
  email TEXT,
  bank_name TEXT,
  bank_account TEXT,
  credit_limit REAL NOT NULL DEFAULT 0,         -- 信用额度
  credit_days INTEGER NOT NULL DEFAULT 0,       -- 账期天数
  settlement_method TEXT DEFAULT 'monthly',     -- 结算方式
  price_level TEXT,                             -- 默认价格级别
  org_id INTEGER REFERENCES orgs(id),
  status TEXT NOT NULL DEFAULT 'active',
  remark TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE partner_roles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  role_type TEXT NOT NULL,                      -- supplier / customer / dealer / store / logistics
  scope_type TEXT,                              -- 角色作用域类型（可选）
  scope_id INTEGER,                             -- 作用域 ID
  status TEXT NOT NULL DEFAULT 'active',
  effective_from TEXT,
  effective_to TEXT,
  UNIQUE (partner_id, role_type, scope_type, scope_id)
);
CREATE INDEX idx_prole_partner ON partner_roles(partner_id, role_type);

-- ============ 组织 / 部门 / 人员（P1）============
CREATE TABLE orgs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  parent_id INTEGER REFERENCES orgs(id),
  tax_no TEXT,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  org_id INTEGER REFERENCES orgs(id),
  parent_id INTEGER REFERENCES departments(id),
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE employees (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  dept_id INTEGER REFERENCES departments(id),
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

**改动既有表**（用 `ALTER TABLE` 增列，不动现有数据）：

```sql
-- products（物料层）增列
ALTER TABLE products ADD COLUMN base_unit_code TEXT;
ALTER TABLE products ADD COLUMN purchase_unit_code TEXT;
ALTER TABLE products ADD COLUMN sales_unit_code TEXT;
ALTER TABLE products ADD COLUMN pricing_method TEXT DEFAULT 'moving_avg';   -- 计价方式
ALTER TABLE products ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';   -- 物料生命周期
ALTER TABLE products ADD COLUMN org_id INTEGER;

-- product_skus（SKU 层）增列：双外键同时挂物料与商品
ALTER TABLE product_skus ADD COLUMN spu_id INTEGER REFERENCES spus(id);
ALTER TABLE product_skus ADD COLUMN item_id INTEGER REFERENCES products(id);
ALTER TABLE product_skus ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';

-- users 增列
ALTER TABLE users ADD COLUMN employee_id INTEGER;

-- 往来单位角色扩展：原表保留，只加主档外键
ALTER TABLE suppliers      ADD COLUMN partner_id INTEGER REFERENCES partners(id);
ALTER TABLE dealers        ADD COLUMN partner_id INTEGER REFERENCES partners(id);
ALTER TABLE stores         ADD COLUMN partner_id INTEGER REFERENCES partners(id);
ALTER TABLE mall_customers ADD COLUMN partner_id INTEGER REFERENCES partners(id);
```

> 现有 `products.color_no` / `spec` **先保留不删**，seed 数据迁到 `sku_attributes` 后再逐步停用。演示期两条路并存，读优先新表、旧表兜底。

---

## 六、迁移方案

分三步走，**每一步都可独立验收、可回滚**：

| 步骤 | 动作 | 风险 | 回滚 |
|---|---|---|---|
| **S1 建结构** | 新增 **17 张表** + **13 条 ALTER**，写进版本化迁移脚本 `migrations/0002_master_data.sql` | 无（纯新增） | 删表即可 |
| **S2 灌数据** | seed 生成 `spus` / `spu_items`（由 `products` 拆）+ `barcodes` / `sku_attributes` / `unit_groups` / `units` / `price_lists` / `channel_products` / `partners` / `partner_roles`（由 `suppliers`/`dealers`/`stores` 归一） | 低（可重复执行，幂等） | 清表重灌 |
| **S3 切读路径** | 业务路由改为读新表（商城读 `spus`、OMS 读 `channel_products`、对账读 `partners`）；旧列只读兜底 | 中（要改多处读法） | 开关切回旧列 |

**关键约束**：迁移脚本必须**可从零建库**，也必须**可在已有库上增量执行**（`schema_migrations` 表记录已执行版本）。

**SPU 拆分的迁移顺序**（S2 内部三步，避免半成品状态）：
1. 每个 `products` 生成一条对应 `spus`（`is_bundle = 0`，`spu_code` 沿用原物料码加后缀），建立 `spu_items` 一对一条目
2. 每个 `bundles` 生成一条 `spus`（`is_bundle = 1`），`bundle_components` 转 `spu_items`
3. `product_skus.spu_id` / `item_id` 回填；旧的 `bundles` 表保留只读

**往来单位归一的迁移顺序**：
1. 先给 `suppliers` / `dealers` / `stores` 各建一条 `partners`（编码沿用原编码），回填 `partner_id`
2. 按类型写 `partner_roles`（supplier / dealer / store）
3. 手工合并"同名但分属两表"的实体（演示数据里造一条**双身份**样例：既是供应商又是经销商的贸易公司）

---

## 七、接口清单

所有接口统一前缀 `/api/master`，**统一分页与错误格式**（沿用现有 `lib/http.js`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/items` | 物料列表（原 `/products`，保留兼容别名） |
| GET | `/spus` `/spus/:id` | **商品（SPU）列表与详情**（含品牌、类目、属性模板、SKU 清单） |
| POST/PUT | `/spus` `/spus/:id` | 增改 SPU（自动写 `master_data_logs`） |
| POST | `/spus/:id/skus/generate` | **按属性模板批量生成 SKU**（选颜色×尺码 → 一次生成 12 个） |
| GET | `/spus/:id/items` | SPU ↔ 物料构成（组合装用） |
| GET | `/attributes` `/attribute-values` `/attribute-sets` | 属性、属性值与属性模板 |
| GET | `/barcodes` `/barcodes/lookup?code=` | 条码查询（收银/仓储扫码用，**高频，已建索引**） |
| GET | `/channels/:id/products` | 渠道商品映射 |
| POST | `/channels/:id/products/sync-preview` | **映射率预演**（多少平台商品还没对上内部 SKU） |
| GET | `/unit-groups` `/units` | 计量单位与折算 |
| GET | `/sku-scopes` | 经营范围 |
| GET | `/price-lists` `/price-lists/:id/items` | 价目表（结构归本模块，取价归模块 06） |
| GET | `/partners` `/partners/:id` | **往来单位主档**（支持按角色筛选、按关键字查） |
| POST/PUT | `/partners` `/partners/:id` | 增改往来单位 |
| GET/POST/DELETE | `/partners/:id/roles` | **角色绑定**（给一个单位加/减 supplier、customer、dealer 角色） |
| GET | `/partners/:id/summary` | **往来总览**（该单位各角色下的单据数、应收应付、信用占用） |
| GET | `/orgs` `/departments` `/employees` | 组织与人员 |
| GET | `/master-data-logs` | 变更留痕查询 |

**要新增的公开能力**（供其它模块调用，避免各路由再直接读表）：

```
resolveSkuByBarcode(barcode)                扫码 → SKU
resolveSkuByPlatformCode(channelId, code)   平台码 → SKU        ← 解决 OMS 归集
listSellableSkus(scopeType, scopeId)        门店/渠道可售清单    ← 解决商城与 POS
listSkusBySpu(spuId)                        SPU → SKU 矩阵
getBomOfSpu(spuId)                          SPU → 物料构成      ← 组合装拆解
convertUnit(skuId, from, to, qty)           单位换算
resolvePartnerByRole(roleType, id)          角色实体 → 统一往来单位 ← 对账用
getMasterSnapshot(skuId)                    商品全息（聚合视图，给 AI 承接台用）
```

---

## 八、前端页面调整

| 页面 | 动作 |
|---|---|
| 新增 `master/Spus.tsx` | **商品（SPU）主档**：品牌、类目、属性模板、图文、上下架；含「按属性批量生成 SKU」入口（选维度 → 笛卡尔积预览 → 确认生成） |
| `master/Products.tsx` | 改为**物料主档**（去营销字段），增加生命周期筛选；原"色号/规格"两列改为读属性 |
| `master/Products.tsx` | 新增「渠道映射」标签页，看各平台商品对应关系与**未映射清单** |
| `master/Barcode.tsx` | 改为读 `barcodes` 多码表，支持主码/箱码/平台码 |
| 新增 `master/Partners.tsx` | **往来单位**：一页管理全部单位，角色多选（供应商/客户/经销商/门店），显示各角色下的单据数与应收应付 |
| `master/Org.tsx` | 从自由文本改为组织-部门-人员三级树 |
| 新增 `master/Prices.tsx` | 价目表维护（结构管理，不含取价逻辑） |

---

## 九、验收标准

**不以"菜单可见"验收，以可核对的样例验收**：

1. **价格唯一**：任取一个 SKU，全系统能回答"它的零售价/会员价/经销价分别来自哪张价目表"，且**只有一处**能改
2. **渠道可归集**：造一条模拟平台订单，`platform_sku_code` 能自动归集到内部 SKU，**未映射时明确报出"未找到映射"而不是静默丢弃**
3. **规格可组合**：为化妆品生成"规格×色号"、为服装生成"颜色×尺码"的 SKU 矩阵，**同一套表结构，不改代码**
4. **条码可扫**：一个 SKU 同时挂瓶码（factor 1）与箱码（factor 24），扫码后数量换算正确
5. **经营范围生效**：把某 SKU 从 ST001 门店移除后，该店 POS 商品列表立刻查不到
6. **变更可追**：改一次零售价，`master_data_logs` 有且仅有一条记录，含前后值
7. **迁移可靠**：空库跑迁移脚本能建出完整结构；已有库跑增量脚本不报错、不丢数据
8. **SPU 独立可验**：一个 SPU 下挂多 SKU（商城详情按 SPU 取图文、按 SKU 取价与库存，两者不串）；一个**组合装 SPU** 关联多物料，下单时能自动拆出物料构成
9. **双身份可验**：把同一个 `partner` 同时绑 `supplier` 与 `customer` 角色，采购单与销售单**都能选到它**；`/partners/:id/summary` 一张表把两侧金额合并汇总，信用占用只算一次

---

## 十、决策记录

| # | 决策点 | 结论 | 状态 |
|---|---|---|---|
| **1** | 商品层数 | **拆出独立 SPU 层**，四层做全（物料 / SPU / SKU / 渠道商品） | ✅ **已定案** |
| **2** | 规格模型 | 做属性/规格模型（属性 + 属性值 + 属性模板），两个行业共用一套结构 | 暂按建议执行，如无异议即生效 |
| **3** | 往来单位统一 | **做 `partners` 统一主档 + `partner_roles` 角色扩展**，原表保留只加外键 | ✅ **已定案** |
| **4** | 价格迁出商品表 | 全部迁到价目表，商品表价格列标记废弃（保留列做兜底） | 暂按建议执行，如无异议即生效 |
| **5** | 计量单位 | 做单位组 + 换算（瓶 / 箱），采购按箱、销售按瓶 | 暂按建议执行，如无异议即生效 |

> 决策 1 与 3 已由你定案，本模块工作量因此上浮：新增表从 14 张增至 17 张，ALTER 从 6 条增至 13 条，前端新增 2 个页面（SPU、往来单位）。这两个改动**都会向下游模块传导**——模块 03 库存中心以 `item_id` 为库存与成本的外键，模块 07 采购以 `partner` 为供应商来源，模块 19 经销商 DMS 以 `partner_roles` 为经销商圈定依据。

---

## 十一、与前序文档的关系

- 本文是《总体框架与模块地图 v1.1》第九节清单中 **第 02 项**的展开
- 本文完成后，**第 03 项「库存中心与成本层」**可直接引用本文的商品四层模型与外键（物料 `item_id` 管库存与成本，SPU/SKU 管销售）
- 本文确认的**决策 4**，会影响 **第 06 项「编码规则」**与**取价引擎**的边界
- 本文确认的**往来单位统一**，会成为 **第 07 采购域**、**第 19-20 经销商 DMS**、**第 21 结算对账** 的共同基础
- 变更点：v1 → v2 因决策 1、3 定案，§4.1（三层改四层）、§4.8（往来单位 P2 升 P0）、§5（新增 3 张表）、§6（迁移数）、§7/8/9（接口、页面、验收）已同步更新
