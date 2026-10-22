# GML 模块 05 · 组织与权限 详细设计 v1

> 文档性质：详细设计（已落地实现并实测通过）
> 口径来源：第二轮第 3 条、第三轮 B1~B5 与 3.1
> 前置依赖：无（本模块是所有模块的前置）
> 关联文档：《GML 系统总体框架与模块地图 v1》《GML 口径确认 v1 第三轮 问答纪要》

---

## 一、为什么这个模块必须最先做

原计划里模块 05 排在模块 04 之后。实际动手时发现这是错的，理由是**硬依赖**：

| 下游模块 | 依赖 orgs 的什么 |
|---|---|
| 03 库存中心 | 货主（`owner_org_id`）——没有组织，五维库存的货主维度无处安放 |
| 04 单据与状态机 | 单据的归属主体、按主体的数据隔离 |
| 07/08 采购与销售 | 采购申请主体、销售出库主体 |
| 12A 订货中心 | 门店与经销商都是组织节点 |
| 21 结算与对账 | 结算主体 = 组织 |
| 22 审批流 | 审批范围 = 组织子树 |

实测印证：库存五维做完后，餐饮库 404 行库存的货主**全部落在兜底的"系统默认主体"上**——货主维度等于空转。所以本轮把 05 提前，先立骨架。

---

## 二、组织模型

### 2.1 四层主体（第三轮 B1）

```
总部（法人主体，is_legal=1）
├── 区域（大区 / 片区）
│   ├── 门店（直营 / 专柜 / 加盟）
│   │   └── 门店仓（随门店自动建立）
│   └── 仓库（中央仓 / 区域仓 / 电商仓）
└── 中央厨房（餐饮线，挂总部，不独立核算）
```

`orgs` 表关键字段：

| 字段 | 含义 |
|---|---|
| `code` / `name` / `short_name` | 编码与名称 |
| `type` | group 总部 / region 区域 / store 门店 / warehouse 仓库 / kitchen 中央厨房 / dealer 经销商 / supplier 供应商 |
| `parent_id` / `level` / `path` | 层级与路径（`/1/3/12/`），子树查询靠 path 前缀 |
| `is_legal` | 是否法人主体（加盟店 = 1） |
| `owner_org_id` | **货主**：本节点的库存产权归属哪个主体 |
| `currency` | 本位币（CNY / HKD） |
| `region` / `tax_region` | 地区与税区（中国香港单独税区） |
| `brand_id` | 品牌（餐饮多品牌贯穿组织） |

另有 `org_functions` 表：同一组织可开不同职能开关（purchase / sales / inventory / pos / wms / ordering / finance / production），避免为每种组合建一张组织表。

### 2.2 货主规则（关键口径）

货主 ≠ 物理所在地。规则如下：

| 场景 | 货主 | 依据 |
|---|---|---|
| 总部仓 / 区域仓 / 电商仓 | 总部 | 一盘货，产权在总部 |
| 直营店 / 专柜的门店仓 | 总部 | 门店是销售点，不是产权主体 |
| **加盟店的门店仓** | **加盟店自身** | 第三轮 B2：加盟店是独立主体 |
| 中央厨房 | 总部 | 第三轮 B3：央厨是仓库+生产车间，不独立核算 |
| 经销商 | 经销商自身 | 独立法人 |

**这条规则直接决定了一件事**：中央厨房把半成品送到加盟店，**不能走内部调拨**（内部调拨成本平移、不产生损益），必须走**货权转移**（等同一次销售 + 一次采购）。库存引擎已提供 `applyOwnershipTransfer()` 一步完成双向记账，并落了 `TR_OWN_OUT` / `TR_OWN_IN` 两种事务类型。

### 2.3 多币种与多地区（第三轮 3.1）

餐饮版含中国香港门店，因此：

- 币种跟随仓库本位币，**调用方无需传**——`resolveCurrency()` 自动解析（这条在本轮实测中抓出一个真 bug：`costOf()` 曾把中国香港仓按 CNY 查，导致库存金额恒为 0）
- `inventory_stocks` 唯一键含币种，人民币与港币库存互不混算
- 库存流水带 `currency` / `fx_rate` / `unit_cost_base` / `amount_base`，为本位币与报表折算预留

### 2.4 自适应兜底挂载

组织树配置是声明式的，但**各行业主数据并不一致**：美妆门店是"南京西路 / 静安嘉里 / 淮海中路"，服装门店是"新天地 / 三里屯 / 太古里"，且服装多出广州区域仓与电商云仓。

写死配置的后果实测过：**服装库 313 行库存的货主悬空**。

因此加了兜底层：凡主数据存在、配置未列出的门店与仓库，一律按 `region` 自动归位；地区不存在则自动建区域组织。三个库实测**遗留 0 行**。

---

## 三、权限模型

### 3.1 两轴正交

这是本模块最重要的设计判断：

```
功能权限（能不能做）  ×  数据权限（能看到谁的数据）
```

两轴必须分开，否则会出现两种经典故障：
- 有菜单但看不到数据（功能开了、数据范围没开）
- 看得到数据但动不了（数据范围够、功能没开）

### 3.2 功能权限：66 个权限点

覆盖 12 个模块，形如 `inventory.stock.view`、`purchase.order.approve`。分类：

| 类别 | 示例 |
|---|---|
| master | `master.product.edit`、`master.price.edit` |
| purchase / sales | `purchase.order.approve`、`sales.outbound` |
| inventory | `inventory.adjust`、`inventory.cost.view`、`inventory.params` |
| produce | `produce.bom.edit`、`produce.issue` |
| pos | `pos.cashier`、`pos.dailyclose`、`pos.offline` |
| oms / mall | `oms.order.route`、`mall.member.edit` |
| dms | `dms.dealer.approve`、`dms.policy.edit` |
| order（订货中心） | `order.place`、`order.confirm`、`order.statement.view` |
| finance | `finance.settle.edit`、`finance.cost.view` |
| approval | `approval.instance.act`、`approval.flow.edit` |
| system | `system.user.edit`、`system.mcp.manage` |
| ai | `ai.chat` |

### 3.3 角色与数据范围

| 角色 | 数据范围 | 权限数 | 说明 |
|---|---|---|---|
| admin 系统管理员 | all | 66 | 超级管理员，`is_super` 全开 |
| boss 老板/总经理 | all | 31 | 全数据只读 + 关键审批 |
| purchase 采购员 | subtree | 19 | 采购全流程 + 生产委外 |
| sales 销售员 | subtree | 21 | 销售 + 渠道 + 订货 |
| warehouse 仓管员 | subtree | 21 | 库存与出入库，**无审批权**（职责分离） |
| finance 财务 | all | 12 | 应收应付 + 成本可见 |
| store 店长 | org | 14 | 仅本店：收银 / 库存 / 要货 |
| dealer 经销商 | dealer | 7 | 仅本经销商：订货 + 对账 |
| viewer 访客 | all | 8 | 纯只读，**看不到成本** |

数据范围五档：`all` 全部 / `subtree` 本组织及下级 / `org` 仅本组织 / `self` 仅本人 / `dealer` 仅本经销商。

### 3.4 向下兼容

原有 8 个扁平角色（`users.role` + `requireRole()`）**全部保留可用**，新体系在其上扩展：

- `users.role` 字段保留，老代码 `requireRole('admin')` 不改
- 新增 `user_roles` 支持一人多角色，`user_orgs` 支持一人多组织
- 新增 `requirePerm(...)` 做权限点校验，逐模块迁移

---

## 四、落地实现

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `server/db/migrations/005_org_permission.cjs` | 权限模型建表 + 66 权限点 + 9 角色 + 存量用户回填 |
| `server/db/org-seed.js` | 组织树声明式配置 + 挂载 + 货主回填（幂等，可对老库单独执行） |
| `server/middleware/auth.js`（扩展） | `requirePerm` / `resolveOrgScope` / `orgScopeFilter` / `attachOrgScope` |
| `scripts/seed-orgs.mjs` | 组织初始化入口 |
| `scripts/test-org-perm.mjs` | 多角色权限与数据范围验证 |

### 4.2 关键接口

| 接口 | 说明 |
|---|---|
| `GET /api/auth/me` | 返回用户 + 组织 + 权限点列表 + 数据范围 |
| `GET /api/auth/org-tree` | 组织树，**按数据范围裁剪并保留祖先**（否则前端拼不出层级） |
| `GET /api/auth/my-permissions` | 前端据此渲染菜单与按钮 |
| `GET /api/auth/roles-permissions` | 角色及权限（管理员） |
| `PUT /api/auth/roles/:code/permissions` | 编辑角色权限 |

### 4.3 越权防护的一个细节

`orgScopeFilter()` 在无可见组织时返回 `AND 1=0` 短路，而不是返回空条件。原因是：**漏掉条件会导致越权全量**——这是数据权限实现里最常见的事故模式，必须用"默认拒绝"而非"默认放行"。

---

## 五、实测结果

三库组织规模：

| 行业库 | 组织总数 | 构成 | 货主回填 |
|---|---|---|---|
| 美妆 | 45 | 总部1 / 区域2 / 门店5 / 仓8 / 经销商20 / 供应商8 | 1207 行，**遗留 0** |
| 餐饮 | 46 | 上述 + 中央厨房 1 | 1171 行，**遗留 0** |
| 服装 | 44 | 总部1 / 区域1 / 门店5 / 仓8 / 经销商20 | 691 行，**遗留 0** |

加盟店货权判定 5/5 正确（上海五角场店 `is_legal=1`，货主 = 自身）。

多角色实测（`scripts/test-org-perm.mjs`，13 项断言全通过）：

| 账号 | 权限数 | 可见组织 | 数据范围 |
|---|---|---|---|
| admin | 66 | 44 | all |
| purchase | 19 | 36 | subtree |
| warehouse | 21 | 36 | subtree |
| finance | 12 | 44 | all |
| store01 | 14 | **3** | org |
| dealer01 | 7 | **2** | dealer |
| viewer | 8 | 44 | all（但无成本权） |

---

## 六、待确认（不阻塞）

1. **中国香港门店账号怎么设**——《账号需求表》第三节已列出待填
2. **加盟店是否独立登录看自己的账**——当前口径是独立主体，理论上应可登录；若不需要则关闭其登录入口
3. **经销商外部账号规模**——当前每行业 1 个演示账号，实际要开多少家
4. **价格组四维组合的主次**——第三轮定为"自由组合 + 优先级排序"，具体命名规范待模块 06 细化

---

## 七、下一步

- 模块 06 主数据与价格中心（价格组四维组合、往来单位统一模型落地）
- 模块 04 单据与状态机统一（当前 21 种散落状态值需要收敛）
- 餐饮版专属数据（当前餐饮库 seed 内容是美妆的副本，需要按 20 店 + 央厨 + 3 品牌重做）
