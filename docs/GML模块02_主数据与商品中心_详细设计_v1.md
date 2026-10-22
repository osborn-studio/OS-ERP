# GML 模块 02 · 主数据与商品中心 — 详细设计

> 版本：v1 ｜ 日期：2026-10-14 ｜ 性质：内部设计稿，供逐模块评审
> 上游：《GML 系统总体框架与模块地图 v1.1》第五节「共享能力中心」
> 定位：L2 共享能力中心的第一个模块。**一切业务单据都以主数据为外键**，所以它必须先立。
> 声明：不含任何客户信息、真实价格或商业机密；不构成承诺。

---

## 一、目标与范围

**本模块要解决的一句话问题**：现在商品数据"能存"，但"讲不清楚"——同一个价格散在三个地方、渠道商品对不上内部 SKU、一件商品能不能在某家店卖没有依据。

**范围内**：商品（物料 / SPU / SKU / 渠道商品）、类目与品牌、属性与规格、多条码、多计量单位、经营范围、生命周期与变更留痕；组织、部门、人员；仓库与货位；往来单位；平台与店铺。

**范围外**（归其它模块，本文只约定接口）：
- 价格的计算与优先级 → 模块 06 / 取价引擎
- 库存数量与成本 → 模块 03 / 库存中心
- 促销与优惠 → 模块 13 / 促销引擎
- 单据的流转 → 模块 04 / 单据内核

---

## 二、现状盘点（2026-10-14 实测）

### 2.1 已有的表

| 表 | 行数 | 评价 |
|---|---|---|
| `products` | 26 | 物料 + SPU 混在一起；规格、色号硬编码成列 |
| `product_skus` | 41 | 可售最小单位，可用 |
| `brands` | 8 | 够用 |
| `categories` | 14 | 有 `parent_id`，可多级，够用 |
| `suppliers` | 8 | 够用 |
| `warehouses` | 8 | 有 `type`（central/region/store/ecom）+ `store_id` 绑定门店仓，设计不错 |
| `warehouse_locations` | 64 | 按仓建货位，够用 |
| `stores` | 5 | 够用 |
| `dealers` | 20 | 字段较全（等级、信用额度、价格级别、折扣率、返点率） |
| `platforms` | 10 | 有奇门字段（app_key / shop_code / qimen_url），够用 |
| `bundles` + `bundle_components` | 3 + 8 | 组合装，够用 |
| `serial_numbers` | 815 | 序列号全生命周期跟踪，做得不错 |
| `users` | — | `dept` 是字符串，无部门表 |

### 2.2 实测出的六个真问题

**问题 1 · 价格散落三处，没有优先级规则**（最严重）

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

### 2.3 附带发现（非商品域，一并列出）

- 没有**业务组织表**（`organizations` / 法人主体），只有仓库和门店
- 没有**部门表**，`users.dept` 是自由文本
- 供应商 / 经销商 / 门店**各自独立成表**，同一实体既是供应商又是客户时无法表达
- 主数据**没有服务出口**，各业务路由直接读表

---

## 三、参考口径

| 来源 | 学到的做法 | 我们怎么用 |
|---|---|---|
| 零售中台（商品中心） | **三层模型**：基础物料层 → 销售商品层 → 渠道商品层；"一处管理、全域生效" | 直接采用，补上缺的第三层 |
| 用友（物料档案） | 物料档案含**计量单位组、主/辅计量单位、换算率**；业务属性（采购/销售/库存）勾选 | 增加单位组，解决"箱/瓶" |
| 用友（存货 vs 商品） | 存货用于库存与成本，商品用于销售与营销，两者可分可合 | 演示期**合并**，留拆分余地 |
| 用友（基础数据） | 组织单元、部门档案、人员档案三级；往来单位统一管理 | 补组织与部门表，人员关联 `users` |
| 零售中台（变更管理） | 商品变更留痕、上下架策略总部统一 + 门店个性化 | 增加主数据变更日志 + 生效时间 |

---

## 四、目标模型

### 4.1 商品三层模型

```
L1 基础物料层  items（沿用 products）
   角色：采购、生产、库存、成本、内部核算的载体
   唯一标识：物料内码（spu_code）
   ├─ 谁在用：采购订单行、库存流水、成本计算、会计分录

L2 销售商品层  spus（商品）+ product_skus（SKU）
   角色：营销与销售的载体 —— 详情页、图文、类目品牌、价格
   唯一标识：SPU 码 / SKU 码
   ├─ 谁在用：商城详情页、POS 商品列表、促销、导购

L3 渠道商品层  channel_products（渠道商品）
   角色：内部 SKU ↔ 各平台商品 ID 的映射
   唯一标识：(channel_id, platform_sku_code)
   └─ 谁在用：OMS 订单归集、库存同步、对账
```

**为什么非要第三层**：没有它，平台订单归集就是字符串猜谜；有了它，`platform_sku_code` 一查就知道是哪个内部 SKU，归集率、对账差异都能算出来。

> ⚠️ 演示期把 **L1 与 L2 合并**到现有 `products` + `product_skus`（改名不动结构），避免大改。L3 是**新增**，无兼容负担。

### 4.2 属性与规格模型（解决"颜色×尺码"）

用**属性定义 + 属性值 + SKU 属性值**三张表，让两个行业共用一套结构：

| 行业 | 参与 SKU 组合的属性 | 结果 |
|---|---|---|
| 化妆品 | 规格（30ml / 50g）、色号（#01 正红） | 2 × 3 = 6 个 SKU |
| 服装 | 颜色（黑/白/驼）、尺码（S/M/L/XL） | 3 × 4 = 12 个 SKU |
| 洗护 | 规格（500ml） | 1 个 SKU（单维度） |

**SKU 不再需要 `color_no` / `spec` 两个硬编码列**——它们变成属性值，新增维度不用改表。

### 4.3 编码体系

| 码类型 | 归属表 | 用途 | 是否对外 |
|---|---|---|---|
| 物料内码 | `products.spu_code` | 内部唯一，业务外键 | 否 |
| SKU 码 | `product_skus.sku_code` | 内部唯一，业务外键 | 否 |
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

**变更留痕**：`master_data_logs`（实体、实体 ID、字段、旧值、新值、操作人、时间、生效时间）。改价、改状态、改分类自动落一条。

**生效时间**：价格与分类变更带 `effective_from`，支持"明天起生效"，不用半夜改配置。

### 4.7 价格归属（重要：本模块只做减法）

**商品侧不再持有价格。** 具体动作：

1. `products` / `product_skus` / `bundles` 的 `price_retail / price_dealer / price_member` 标记为**已废弃**（保留列做迁移兜底，代码不再读）
2. 统一到 `price_lists`（价目表）+ `price_list_items`（明细）
3. 价目表类型：零售价 / 会员价 / 经销价（按等级）/ 渠道价 / 协议价
4. **优先级由模块 06 取价引擎裁决**，本模块只负责"价格挂在哪"

> 这是模块 02 与模块 06 的分界线：02 定**数据结构**，06 定**取哪一条**。

### 4.8 其它主数据

| 对象 | 动作 | 优先级 |
|---|---|---|
| 业务组织 `orgs` | 新增（法人/业务组织，`parent_id` 支持多级） | P1 |
| 部门 `departments` | 新增，`users.dept` 字符串改为 `users.dept_id` | P1 |
| 人员 `employees` | 新增人员档案，`users.employee_id` 关联 | P1 |
| 往来单位 `partners` | 新增统一往来单位；`suppliers` / `dealers` / `stores` 通过 `partner_id` 挂角色 | **P2（可选）** |
| 仓库 / 货位 | 保持现状，补 `org_id` 归属 | P2 |
| 平台 / 店铺 | 保持现状 | — |

> 「往来单位统一」只有在你要演示**"同一实体既是供应商又是客户"**时才值得做，否则是纯结构洁癖。**建议先不做**，等你确认。见第九节决策点 3。

---

## 五、数据模型（DDL 草案）

> 全部使用**标准 SQL**，不使用 SQLite 私有语法，便于将来平滑换库。

```sql
-- ④ 计量单位组与单位
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
  is_base INTEGER NOT NULL DEFAULT 0,        -- 是否基础单位
  factor REAL NOT NULL DEFAULT 1,              -- 相对基础单位的折算率
  status TEXT NOT NULL DEFAULT 'active'
);

-- ② 属性与规格（替代 color_no / spec 硬编码列）
CREATE TABLE attributes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,                          -- 颜色 / 尺码 / 规格 / 色号
  input_type TEXT NOT NULL DEFAULT 'select',   -- select下拉 / input手填
  is_sku_dim INTEGER NOT NULL DEFAULT 1,       -- 是否参与 SKU 组合
  sort_no INTEGER DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
);

CREATE TABLE attribute_values (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  attribute_id INTEGER NOT NULL REFERENCES attributes(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  name TEXT NOT NULL,                          -- 黑 / S / 30ml / #01正红
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

-- ③ 多条码
CREATE TABLE barcodes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  barcode TEXT NOT NULL,
  sku_id INTEGER REFERENCES product_skus(id),
  product_id INTEGER REFERENCES products(id),
  type TEXT NOT NULL DEFAULT 'internal',       -- internal内部码 / ean13 / upc / platform
  is_primary INTEGER NOT NULL DEFAULT 0,       -- 是否主条码
  pack_factor REAL NOT NULL DEFAULT 1,         -- 该码对应的包装数量（箱码=24）
  unit_code TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  UNIQUE (barcode, sku_id)
);

-- ① 渠道商品映射（对齐内部 SKU 与平台商品）
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

-- ⑤ 经营范围
CREATE TABLE sku_scopes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sku_id INTEGER NOT NULL REFERENCES product_skus(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,                     -- store门店 / channel渠道 / warehouse仓库
  scope_id INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  effective_from TEXT,
  UNIQUE (sku_id, scope_type, scope_id)
);

-- ⑥ 主数据变更留痕
CREATE TABLE master_data_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity TEXT NOT NULL,                         -- product / sku / price_list / ...
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

-- 价格统一（归模块 06，此处先建结构）
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

-- 组织 / 部门 / 人员（P1）
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
-- products 增列
ALTER TABLE products ADD COLUMN base_unit_code TEXT;
ALTER TABLE products ADD COLUMN purchase_unit_code TEXT;
ALTER TABLE products ADD COLUMN sales_unit_code TEXT;
ALTER TABLE products ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';  -- 新生命周期
ALTER TABLE products ADD COLUMN org_id INTEGER;

-- product_skus 增列
ALTER TABLE product_skus ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active';

-- users 增列
ALTER TABLE users ADD COLUMN employee_id INTEGER;
```

> 现有 `products.color_no` / `spec` **先保留不删**，seed 数据迁到 `sku_attributes` 后再逐步停用。演示期两条路并存，读优先新表、旧表兜底。

---

## 六、迁移方案

分三步走，**每一步都可独立验收、可回滚**：

| 步骤 | 动作 | 风险 | 回滚 |
|---|---|---|---|
| **S1 建结构** | 新增 10 张表 + 6 个 ALTER，写进版本化迁移脚本 `migrations/0002_master_data.sql` | 无（纯新增） | 删表即可 |
| **S2 灌数据** | seed 时从 `products` / `product_skus` 生成 `barcodes`、`sku_attributes`、`unit_groups`、`units`、`price_lists`、`channel_products` | 低（可重复执行，幂等） | 清表重灌 |
| **S3 切读路径** | 业务路由改为读新表；旧列只读兜底 | 中（要改多处读法） | 开关切回旧列 |

**关键约束**：迁移脚本必须**可从零建库**，也必须**可在已有库上增量执行**（`schema_migrations` 表记录已执行版本）。

---

## 七、接口清单

所有接口统一前缀 `/api/master`，**统一分页与错误格式**（沿用现有 `lib/http.js`）。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/products` | 物料/商品列表（支持类目、品牌、生命周期、关键字筛选） |
| GET | `/products/:id` | 详情（含 SKU、属性、条码、渠道映射） |
| POST/PUT | `/products` `/products/:id` | 增改（自动写 `master_data_logs`） |
| GET | `/products/:id/skus` | SKU 列表 |
| POST | `/products/:id/skus/generate` | **按属性组合批量生成 SKU**（选颜色×尺码 → 一次生成 12 个） |
| GET | `/attributes` `/attribute-values` | 属性与属性值 |
| GET | `/barcodes` `/barcodes/lookup?code=` | 条码查询（收银/仓储扫码用，**高频，要建索引**） |
| GET | `/channels/:id/products` | 渠道商品映射 |
| POST | `/channels/:id/products/sync-preview` | **映射率预演**（多少平台商品还没对上内部 SKU） |
| GET | `/unit-groups` `/units` | 计量单位与折算 |
| GET | `/sku-scopes` | 经营范围 |
| GET | `/price-lists` `/price-lists/:id/items` | 价目表（结构归本模块，取价归模块 06） |
| GET | `/orgs` `/departments` `/employees` | 组织与人员 |
| GET | `/master-data-logs` | 变更留痕查询 |

**要新增的公开能力**（供其它模块调用，避免各路由再直接读表）：

```
resolveSkuByBarcode(barcode)            扫码 → SKU
resolveSkuByPlatformCode(channelId, code)  平台码 → SKU   ← 解决 OMS 归集
listSellableSkus(scopeType, scopeId)    门店/渠道可售清单  ← 解决商城与 POS
convertUnit(skuId, from, to, qty)       单位换算
getMasterSnapshot(skuId)                商品全息（聚合视图，给 AI 承接台用）
```

---

## 八、前端页面调整

| 页面 | 动作 |
|---|---|
| `master/Products.tsx` | 增加生命周期筛选、属性维度展示（替换硬编码的"色号/规格"两列） |
| `master/Products.tsx` | 新增**「按属性批量生成 SKU」**入口（选维度 → 笛卡尔积预览 → 确认生成） |
| `master/Products.tsx` | 新增「渠道映射」标签页，看各平台商品对应关系与**未映射清单** |
| `master/Barcode.tsx` | 改为读 `barcodes` 多码表，支持主码/箱码/平台码 |
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

---

## 十、待你确认的决策点

> 下面 5 个点会决定本模块的工作量，请逐条给方向。

| # | 决策点 | 选项 | 我的建议 |
|---|---|---|---|
| **1** | 商品层数 | A. 只补渠道商品层（最小改动）<br>B. 再拆出独立 SPU 层（三层做全） | **A**。演示期 `products` 兼任物料与 SPU 不冲突，拆开收益低、改动大 |
| **2** | 规格模型 | A. 做属性/规格模型（两个行业共用）<br>B. 保持硬编码列，服装单独加列 | **A**。这是唯一能"同一套代码跑两个行业"的路，且新增维度不用改表 |
| **3** | 往来单位统一 | A. 做 `partners` 统一层<br>B. 供应商/经销商/门店各自独立 | **B 先不做**。除非你要演示"同一实体既是供应商又是客户"，否则是纯结构洁癖 |
| **4** | 价格迁出商品表 | A. 全部迁到价目表，商品表价格列废弃<br>B. 保留商品表价格列做默认值 | **A**。价格散落是当前最严重的隐患，留一个兜底列表就永远说不清优先级 |
| **5** | 计量单位 | A. 做单位组 + 换算<br>B. 只加"销售单位/采购单位"两个字段，不做换算 | **A**。换算逻辑本身不复杂，但**采购按箱、销售按瓶**是真实场景，不做就演不出来 |

---

## 十一、与前序文档的关系

- 本文是《总体框架与模块地图 v1.1》第九节清单中 **第 02 项**的展开
- 本文完成后，**第 03 项「库存中心与成本层」**可直接引用本文的商品三层模型与外键
- 本文若确认决策点 4，**第 06 项「编码规则」**与**取价引擎**的边界需同步更新
