# GML 模块 03｜库存中心与成本层 · 详细设计 v1

> 版本：v1 ｜ 日期：2026-10-15 ｜ 性质：**设计稿**（非上线承诺、非报价依据）
> 依据：第一轮 12 条口径 + 第二轮第 0~4 条 + 第三轮 A~G 组定案 + `server/` 代码实测
> 前置模块：01 框架与分层（已完成）、02 主数据与商品中心（设计稿 v2 已出）
> 脱敏：全文不含任何真实客户名与品牌名

---

## 一、设计边界

### 1.1 本模块要解决的问题

库存中心是整套系统的**账实中枢**：所有单据最终都要落到"某货主、某仓库、某批次、某货品，在何时，增减了多少，值多少钱"。本模块定的是**这笔账怎么记、按什么规则记、被谁查**。

### 1.2 承接的已定口径

| 来源 | 口径 | 对本模块的传导 |
|---|---|---|
| 第一轮 | 库存**全渠道共享一盘货** | 现存量不按渠道切分，按**仓库 + 货主**切分 |
| 第一轮 | 成本**移动加权 + 毛利可查（不生成凭证）** | 批次成本价升级为**移动加权**，并落成本流水 |
| 第一轮 | 组织**单法人 + 多业务主体**、**主体决定货主** | 库存新增**货主维度** `owner_org_id` |
| 第二轮 1.2 | 食品线**FEFO 硬约束**、批次 + 效期 | 批次拣选**按行业可配**；过保禁售 |
| 第二轮 2.3 | 组合/生产/形态转换三类 | 统一投产出模型，成本规则分档 |
| 第三轮 3.1 | 内地 + 中国香港、**多币种多税制** | 库存成本支持**原币 + 本位币** |
| 第三轮 3.4 | 央厨 → 加盟店属**货权转移** | 调拨分「普通调拨」与「货权转移调拨」 |
| 第三轮 G5 | 菜品效期**精度到小时** | 批次效期字段升级为 **datetime** |

### 1.3 本模块**不做**（边界）

- 不做会计分录 / 凭证（P3，且已定"不生成凭证"）
- 不做 MRP 运算、工艺路线、工序报工
- 不做 WMS 真实对接（只留接口契约）
- 不做批次序列号的**采集硬件**对接（扫码枪走 POS 模块）

---

## 二、现状实测（代码事实，非推测）

> 来源：`server/db/schema.sql`（唯一 DDL，1042 行）、`server/lib/stock.js`（159 行）、`server/routes/inventory.js`（26 个接口）等，均已核对行号。

### 2.1 现有库存相关表

| 表 | 行号 | 职责 | 关键字段 |
|---|---|---|---|
| `inventory_stocks` | 356-372 | 批次维度库存台账 | `qty_on_hand` / `qty_reserved` / `qty_in_transit` / `qty_ordered` / `cost_price` / `produce_date` / `expire_date` / `entry_date` |
| `inventory_transactions` | 374-392 | 库存流水 | `direction` / `doc_type` / `qty` / `unit_cost` / `amount` / `balance_qty` |
| `stock_transfers` + items | 394-418 | 调拨 | `type`(normal/allocation) / `status` |
| `stock_checks` + items | 420-442 | 盘点 | `status`(draft/checking/adjusted) |
| `warehouse_locations` | 517-527 | 货位 | `type`(receive/storage/pick/defect) |
| `serial_numbers` | 530-549 | 序列号台账 | `status` / `holder` |
| `bundles` + `bundle_components` | 552-573 | 组合装定义 | — |
| `assembly_orders` + items | 576-601 | 组装拆卸 | `type`(assemble/disassemble) |

### 2.2 实测出的 8 个问题

| # | 问题 | 证据 | 后果 |
|---|---|---|---|
| **P1** | **无货主维度** | 全库无 `owner` 字段；`inventory_stocks` 唯一键为 `(warehouse_id, sku_id, batch_no)` | 委托代销 / 寄售仓 / 加盟店货权**无法区分** —— 业务性错误 |
| **P2** | **无多币种** | 无 `currency` 字段，金额字段为裸 `REAL` | 中国香港门店库存金额与内地混算 |
| **P3** | **成本是"入库覆盖式"，不是移动加权** | `stock.js:40-45` → `cost_price = CASE WHEN ?>0 THEN ? ELSE cost_price END` | 与已定口径「移动加权」**直接冲突**；毛利算不准 |
| **P4** | **无成本流水表** | 成本仅存在于 `inventory_stocks.cost_price` 与 `inventory_transactions.unit_cost` | 无法回溯"某次结存成本是怎么来的" |
| **P5** | **批次效期精度只到天** | `expire_date TEXT`（`2026-12-31`），无时分 | 餐饮"当日效期"做不了 |
| **P6** | **拣选规则写死** | `stock.js:136-156` 硬编码 `expire_date ASC` | 服装线本应 FIFO，却走 FEFO；且注释写"先进先出"与实际不符 |
| **P7** | **占用是汇总数，非明细** | `qty_reserved` 只有总量，无"被哪张单占用" | 释放时只能盲减，易出错、无法排查 |
| **P8** | **缺 `busy_timeout`** | `db/index.js:48-49` 只设 `WAL` + `foreign_keys` | POS 并发写会 `SQLITE_BUSY` 直接报错 |

### 2.3 现状的正面资产（要保留）

- 已有 `qty_on_hand / qty_reserved / qty_in_transit / qty_ordered` **四量模型**，方向正确，不用推翻。
- 已有 `DOC_TYPE_LABEL` **19 种库存事务类型**（`stock.js:2-22`），直接升格为字典表即可。
- 已有 26 个库存接口（含库龄、呆滞、ABC、可用量报表），**逻辑可下沉为 L2 能力函数**，不必重写。
- 批次台账已按 `expire_date` 排序，**FEFO 的骨架已经在了**，只需配置化。

---

## 三、目标数据模型

### 3.1 库存的五个维度

```
现存量 = 仓库 × 货品(SKU) × 批次 × 货主 × 币种
```

- **仓库**：物理位置（含门店仓、电商仓、寄售仓）
- **货品**：以 `sku_id` 为库存与成本的**外键**（模块 02 已定：SPU 层不参与库存）
- **批次**：批次号 + 生产日期 + 到期（**精确到小时**）+ 库龄基准
- **货主**：`owner_org_id` —— 产权主体，**≠ 物理所在**（已定口径）
- **币种**：`currency` + 汇率 —— 支持内地 / 中国香港

> **关键约定**：货主是**产权**，仓库是**位置**。寄售仓里放的是「总部（货主）的货」；加盟店仓里放的是「加盟店（货主）自己的货」。

### 3.2 改造 `inventory_stocks`（现存量）

新增/调整字段：

| 字段 | 类型 | 说明 |
|---|---|---|
| `owner_org_id` | INTEGER | **新增**，货主（业务主体）。默认取所在仓库的默认货主 |
| `currency` | TEXT | **新增**，币种，默认 `CNY` |
| `expire_at` | TEXT | **新增**，到期时间（`YYYY-MM-DD HH:mm`），保留 `expire_date` 兼容 |
| `cost_amount` | REAL | **新增**，结存成本金额（= 数量 × 移动平均单位成本） |
| `cost_price` | REAL | **语义修正**：从"最新入库价"改为"**移动加权单位成本**" |
| `last_in_at` / `last_out_at` | TEXT | **新增**，最后出入库时间（呆滞分析用，避免全表扫流水） |

唯一键调整：

```sql
-- 旧：UNIQUE (warehouse_id, sku_id, batch_no)
-- 新：
UNIQUE (warehouse_id, owner_org_id, sku_id, batch_no, currency)
```

### 3.3 改造 `inventory_transactions`（库存流水）

新增字段：

| 字段 | 说明 |
|---|---|
| `owner_org_id` | 货主 |
| `currency` / `fx_rate` | 原币与汇率 |
| `unit_cost_base` / `amount_base` | 本位币成本（跨地区合并报表用） |
| `cost_method` | 本次成本取值方式：`moving_avg` / `batch` / `std` / `manual` |
| `txn_type` | 统一事务类型码（由 `DOC_TYPE_LABEL` 升格） |
| `biz_time` | 业务发生时间（精确到分钟，替代纯 `biz_date`） |
| `source` | 来源：`web` / `pos` / `mall` / `mcp` / `import`（审计要求，MCP 写操作可追溯） |

> **流水只增不改**（append-only）。任何调整都靠**反向流水**，不 UPDATE 历史。

### 3.4 新增 `inventory_batches`（批次主档）

把散落在各表的批次信息收敛成主档，批次成为**独立实体**：

```sql
CREATE TABLE IF NOT EXISTS inventory_batches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_no      TEXT NOT NULL,
  sku_id        INTEGER NOT NULL REFERENCES product_skus(id),
  supplier_id   INTEGER REFERENCES suppliers(id),
  produce_at    TEXT,                              -- 生产时间（可到小时）
  expire_at     TEXT,                              -- 到期时间（精确到小时）
  shelf_life_hours INTEGER,                        -- 保质时长（小时），用于反推效期
  origin_doc_type TEXT,                            -- 来源单据类型
  origin_doc_no TEXT,                              -- 来源单据号
  qc_status     TEXT NOT NULL DEFAULT 'pending',   -- pending/qualified/rejected
  status        TEXT NOT NULL DEFAULT 'active',    -- active/frozen/expired/scrapped
  remark        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE (sku_id, batch_no)
);
```

**效期规则（食品线硬规则）**：生产产出物的 `expire_at` = **投入物料中最早的 `expire_at`**。

### 3.5 新增 `inventory_reservations`（预留明细）

解决 P7 —— 占用必须知道"被谁占"：

```sql
CREATE TABLE IF NOT EXISTS inventory_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  warehouse_id  INTEGER NOT NULL REFERENCES warehouses(id),
  owner_org_id  INTEGER,
  sku_id        INTEGER NOT NULL REFERENCES product_skus(id),
  batch_no      TEXT NOT NULL DEFAULT '',
  qty           REAL NOT NULL DEFAULT 0,
  source_doc_type TEXT NOT NULL,                   -- sales_order / oms_order / requisition ...
  source_doc_id INTEGER,
  source_doc_no TEXT,
  status        TEXT NOT NULL DEFAULT 'active',    -- active/released/consumed
  expire_at     TEXT,                              -- 预留过期时间（超时自动释放）
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

`inventory_stocks.qty_reserved` 保留为**汇总冗余**，由本表聚合维护；两者必须一致（可校验）。

### 3.6 新增 `stock_cost_ledger`（成本流水）

解决 P4 —— 让结存成本可回溯：

```sql
CREATE TABLE IF NOT EXISTS stock_cost_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  biz_date      TEXT NOT NULL,
  warehouse_id  INTEGER NOT NULL,
  owner_org_id  INTEGER,
  sku_id        INTEGER NOT NULL,
  batch_no      TEXT NOT NULL DEFAULT '',
  currency      TEXT NOT NULL DEFAULT 'CNY',
  direction     TEXT NOT NULL,                     -- in / out
  qty           REAL NOT NULL DEFAULT 0,
  unit_cost_before REAL,                           -- 变动前单位成本
  unit_cost_after  REAL,                           -- 变动后单位成本
  amount_before REAL,                              -- 变动前结存金额
  amount_after  REAL,                              -- 变动后结存金额
  cost_method   TEXT NOT NULL DEFAULT 'moving_avg',
  doc_type      TEXT,
  doc_no        TEXT,
  remark        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
```

### 3.7 新增 `inv_txn_types`（库存事务类型字典）

把 `stock.js:2-22` 的 19 种类型**落到数据库**，可配置、可扩展、可加中文名与方向：

```sql
CREATE TABLE IF NOT EXISTS inv_txn_types (
  code        TEXT PRIMARY KEY,        -- PUR_IN / SAL_OUT / TR_OUT ...
  name        TEXT NOT NULL,           -- 采购入库 / 销售出库 ...
  direction   TEXT NOT NULL,           -- in / out
  biz_category TEXT NOT NULL,          -- purchase/sales/transfer/check/produce/outsource/store/init
  cost_effect TEXT NOT NULL DEFAULT 'normal',  -- normal / transfer（货权转移）/ no_cost
  status      TEXT NOT NULL DEFAULT 'active',
  sort_order  INTEGER DEFAULT 0
);
```

---

## 四、成本层设计

### 4.1 成本方法（本模块定规则，模块 09 落实现）

| 场景 | 成本方法 | 规则 |
|---|---|---|
| 采购入库 | **移动加权** | 新单位成本 = (原结存金额 + 本次入库金额) / (原数量 + 本次数量) |
| 销售/领料出库 | **移动加权** | 按出库当时的移动平均单位成本计价 |
| 组合装（组装） | **组件加总** | 成品成本 = Σ(组件移动平均成本 × 用量)，**可逆** |
| 组合装（拆卸） | **组件加总** | 组件按各自移动平均成本回填 |
| 生产完工 | **材料 + 人工 + 损耗** | 材料按领料成本，人工/制费按工单归集 |
| 委外入库 | **材料 + 加工费 + 损耗** | 材料分摊 + 加工费，见现有 `outsourcing.js:377-378` 逻辑（可复用） |
| 形态转换 | **转出成本平移** | 转换后有损耗时，**成本不变、数量减少**，单位成本上升 |
| 调拨 | **成本平移** | 不移不增；**货权转移调拨**另计内部结算价（不影响成本，只影响内部往来） |
| 盘盈 | 按**当前移动平均**入账 | 盘盈金额 = 数量 × 移动平均成本 |
| 盘亏 | 按**当前移动平均**出账 | 同上 |

### 4.2 移动加权的落点

改造 `upsertStock`（`stock.js:34-46`）：

```
入库：newQty = qty + inQty
     newAmount = cost_amount + inQty × inUnitCost
     newUnitCost = newAmount / newQty          ← 这里替代原来的"直接覆盖"
出库：outUnitCost = cost_price（当前移动平均）
     newAmount = cost_amount − outQty × outUnitCost
     newQty = qty − outQty
     newUnitCost = newAmount / newQty（数量为 0 时保留原单位成本或归零，需定口径）
```

> **需定口径**：数量归零时单位成本是**归零**还是**保留**。建议：**保留最后一次单位成本**（便于下一批入库加权），但金额归零。

### 4.3 多币种成本

- 库存成本按**本位币**记账（人民币），同时保留**原币**与**汇率**。
- 中国香港门店：采购以港币发生 → 按发生日汇率折算人民币入账，原币金额留痕。
- 汇率表放模块 05 / 24（集成），本模块只**留字段**。

---

## 五、关键流程

### 5.1 入库

```
单据确认 → 写 inventory_batches（批次主档）
        → upsertStock（+qty，重算移动加权）
        → 写 inventory_transactions（in，含 owner_org_id / currency）
        → 写 stock_cost_ledger（记成本变动前后）
```

### 5.2 出库（FEFO 配置化）

改造 `pickBatches`，排序规则**按行业配置**：

| 行业 | 排序规则 |
|---|---|
| 餐饮食品 | `expire_at ASC`（FEFO 硬约束）+ 过保禁售 |
| 美妆 | `expire_at ASC`（FEFO） |
| 服装 | `entry_date ASC`（FIFO，无批次） |
| 通用 | 由商品属性 `cost_method` / 组织参数决定 |

同时：
- **过保禁售**：`expire_at < now` 的批次**不参与拣选**（现无此约束，需新增）。
- **可用量** = `qty_on_hand − qty_reserved`，拣选前必须按 `owner_org_id` 过滤（修复 P1）。

### 5.3 调拨：普通 vs 货权转移

**新增分流逻辑**（第三轮 3.4 定案）：

| 类型 | 触发 | 库存动作 | 结算 |
|---|---|---|---|
| `normal` 普通调拨 | 同货主内部移库 | 出 → 入，成本平移 | 不涉及 |
| `owner_change` **货权转移** | 央厨 → 加盟店、总部 → 经销商 | 出方减、入方增，**货主变更** | **生成内部结算单**（模块 21） |

判断依据：`from_owner_org_id ≠ to_owner_org_id` → 自动判定为货权转移。

### 5.4 盘点

沿用现有三态（`draft → checking → adjusted`），增加：

- **盘点方式**（待模块内定）：全盘 / 抽盘 / 循环盘
- **盘点期间锁定**：`checking` 状态下该仓库的出入库**是否禁止**（建议：允许，差异按账面快照算）
- 盘盈盘亏走 `ADJ_IN` / `ADJ_OUT`，成本按当前移动平均（见 4.1）

### 5.5 央厨半成品分发（餐饮）

```
央厨生产订单完工 → 入央厨仓（货主=总部）
                → 货权转移调拨到门店仓（直营：货主仍为总部；加盟：货主转为加盟店）
                → 直营门店：普通调拨（同货主）
                → 加盟门店：货权转移 + 内部结算
```

**这一条是对第三轮 3.4 的直接落地**：直营与加盟在同一张调拨单上，**因货主不同而走不同分支**。

---

## 六、变更清单汇总

### 6.1 ALTER（改造现有表）

| 表 | 新增字段 |
|---|---|
| `inventory_stocks` | `owner_org_id`、`currency`、`expire_at`、`cost_amount`、`last_in_at`、`last_out_at`；唯一键调整为五列 |
| `inventory_transactions` | `owner_org_id`、`currency`、`fx_rate`、`unit_cost_base`、`amount_base`、`cost_method`、`txn_type`、`biz_time`、`source` |
| `warehouses` | `default_owner_org_id`（默认货主）、`currency`、`region`（地区） |
| `stores` | `owner_org_id`（直营=总部，加盟=自身）、`brand_id`（品牌）、`region`、`currency` |

### 6.2 新增表（5 张）

1. `inventory_batches`（批次主档）
2. `inventory_reservations`（预留明细）
3. `stock_cost_ledger`（成本流水）
4. `inv_txn_types`（事务类型字典）
5. `inv_params`（库存参数：拣选规则、过保禁售开关、效期预警阈值，按组织/行业配置）

### 6.3 基础设施修复

| 项 | 动作 |
|---|---|
| P8 `busy_timeout` | `db/index.js` 增 `db.pragma('busy_timeout = 5000')` |
| P6 拣选规则 | `pickBatches` 排序按 `inv_params` 配置化 |
| 迁移机制 | 建立 `server/db/migrations/` 目录 + 版本表 `schema_migrations`（本模块是**第一次真正需要它**的模块） |

---

## 七、接口与能力函数

### 7.1 保留现有 26 个接口（`/api/inventory/*`），增加维度参数

所有查询接口增加可选参数：`ownerOrgId`、`currency`、`includeExpired`。

### 7.2 新增接口

| 接口 | 说明 |
|---|---|
| `GET /api/inventory/batches` | 批次主档查询（含效期、质检状态） |
| `GET /api/inventory/reservations` | 预留明细查询（按来源单据） |
| `GET /api/inventory/cost-ledger` | 成本流水查询（结存成本回溯） |
| `POST /api/inventory/transfers`（扩展） | 支持 `owner_change` 类型 |

### 7.3 L2 能力函数（供 MCP 层挂载）

按第 0 条口径，这些逻辑要先**下沉为能力函数**，再对外暴露 MCP tools：

```
inventory.queryStock      查询现存量（必带主体 → 决定货主范围）
inventory.queryBatch      查询批次与效期
inventory.queryAvailability 可用量
inventory.adjust         库存调整（高危，需人工确认）
inventory.transfer       调拨
inventory.ledger         收发存台帐
```

---

## 八、验收标准（本模块过关的硬线）

| # | 验收项 | 通过标准 |
|---|---|---|
| 1 | 货主隔离 | 同一仓库中，总部货与寄售货分别可查、互不抵扣 |
| 2 | 移动加权正确 | 两次不同价入库后，单位成本 = 加权值，非最后一次价 |
| 3 | 成本可回溯 | 任一笔结存成本可从 `stock_cost_ledger` 逐笔还原 |
| 4 | FEFO 生效 | 同 SKU 多批次，出库自动先出近效期；过保批次**不参与拣选** |
| 5 | 效期到小时 | 餐饮菜品批次效期精确到小时；产出效期 = 投入最短效期 |
| 6 | 货权转移可辨 | 央厨 → 加盟店的调拨被识别为 `owner_change` 并生成内部结算 |
| 7 | 多币种 | 中国香港门店库存以港币发生、人民币记账，两者可分别查 |
| 8 | 占用可追溯 | 每个 `qty_reserved` 都能对应到 `inventory_reservations` 明细 |
| 9 | 并发安全 | 连续并发出库 200 次无 `SQLITE_BUSY` 报错 |
| 10 | 迁移可重放 | 从空库执行迁移脚本，得到完整结构；重复执行幂等 |

---

## 九、风险与待确认

| # | 项 | 说明 |
|---|---|---|
| R1 | `orgs` 表尚未设计 | 本模块的 `owner_org_id` 依赖**模块 05（组织与权限）**先定 `orgs`。建议 05 提前，或本模块先建最小 `orgs` 占位 |
| R2 | 数量归零时单位成本口径 | 见 4.2，建议"保留最后单位成本、金额归零" |
| R3 | 成本试算方式 | 演示期是否需要"成本重算"功能 |
| R4 | 寄售仓的货主默认值 | `warehouses.default_owner_org_id` 由谁维护 |
| R5 | 效期预警阈值 | 现为硬编码 180 天（`inventory.js:219`），建议移到 `inv_params` |
| R6 | 盘点方式 | 全盘 / 抽盘 / 循环盘，待模块内确认 |
| R7 | 品牌维度落到库存 | 第三轮 3.2 定了品牌维度，库存是否按品牌切分查询（建议：查询维度，非存储维度） |

---

## 十、下一步

1. **模块 05（组织与权限）建议提前**，因为 `orgs` 是模块 03 的前置（R1）。
2. 或：本模块先建 `orgs` 最小占位（id / code / name / type / parent_id / currency / region），后续在 05 里补全。
3. 模块 04（单据内核：状态机 / 业务流 / 交易类型）与本模块的 `inv_txn_types`、`source`、`审批流`字段强耦合，建议紧随其后。
