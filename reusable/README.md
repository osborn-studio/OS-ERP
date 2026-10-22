# GML 开源复用 · 落地包（可直接采用）

> 给「代码主编写」：**这三块是已经跑通的骨架，不是思路稿**。
> 来源：从 11 个开源仓库里筛出 7 个合规的（其余因许可风险已删），精读后按 GML 的技术栈重写。
> 原则：**抄骨不抄皮** —— 抄领域模型、状态机、算法与防坑经验，代码全部重写为 Node + better-sqlite3。
> 上游文档：`docs/GML开源复用评估表_v1_20261015.md`（选型）+ `docs/GML开源参考仓库_安全审计记录_v1_20261015.md`（安全）

## 一、先跑一遍，确认它能用

```bash
cd /Users/linxinlan/工作文档/gml
node reusable/test-reusable.mjs
# 期望：===== 结果：31 通过 / 0 失败 =====
```

这 31 条断言覆盖：同组互斥与优先级裁决、防超发、幂等登记、借贷平衡校验、红冲、期末结转、期间闸门、行级过滤编译、注入面拦截。

## 二、三块骨架，各自对应哪个模块

| 目录 | 对应 GML 模块 | 抄自（许可） | 当前状态 |
|---|---|---|---|
| `promotion/` | 商城促销引擎（P1） | medusa `packages/modules/promotion`（MIT） | 骨架 + 测试已通 |
| `ledger/` | 业财一体 / 总账（P2） | medici（MIT） | 骨架 + 测试已通 |
| `rbac/` | 模块 05 组织与权限（P0） | casbin（Apache-2.0）**只抄设计** | 骨架 + 测试已通 |

### ⏱ 采纳进度（双线督工记录，只追加）

| 时间 | 块 | 转正产出 | 状态 |
|---|---|---|---|
| 2026-10-15 17:45 | `promotion/` | `server/lib/promotion.js` · `scripts/test-promotion.mjs`（44/44）· `reusable/promotion/promotion-migration.cjs`（待采用的建表脚本） | ✅ 服务层与测试已转正；**建表让位批次 F（迁移 025）** |
| — | `ledger/` | 待接手 | ⏳ |
| — | `rbac/` | 待接手 | ⏳ |

> **为什么促销的建表没有直接落进 `server/db/migrations/`**：工程主笔的批次计划
> （`docs/GML剩余模块开发计划与进度安排_v1_20261015.md`）把促销定在**批次 F = 迁移 025**，
> 督工原先落的 `020_promotion.cjs` 与其 `020_ar_extend.cjs` 撞号，且 `promotions` /
> `promotion_rules` 表名与 025 批次重叠 —— 两处都建会被 `IF NOT EXISTS` 静默跳过、
> 留下「库里有表、代码按另一套列写」的不一致。故让位：脚本移入本目录，待 025 整体采用。
>
> ⛔ **采用前必须先改 `server/lib/pricing.js:60-72`**：该处用「`promotions` 表是否存在」
> 当促销价特性开关，并按 `price` / `sku_id` / `start_at` / `end_at` 查询；medusa 式模型没有这四列，
> 表一建出来取价引擎就抛 `no such column: price`，`seedOrderCenter` 随之崩溃、服务起不来
> （2026-10-15 smoke 已实测复现）。
>
> 转正时按骨架实现做的两处口径澄清，接手 ledger / rbac 时同样留意：
> ① `fixed` 的 value 是「本次应用对目标行/整单的固定减免额（分）」，**不随件数放大**（要「每件减 N 元」用 percentage）；
> ② 独占促销命中后不 `break`，继续走完循环只为把「被谁拦下」记进 `traced`，供界面解释 —— 计算结果与 break 等价。

## 三、⛔ 三条硬红线（违反即返工）

1. **medusa 是双许可**：促销可参考，**RBAC/SSO 是企业版需商业授权**。
   禁止参考 `packages/modules/rbac/`、`packages/core/framework/src/policies/`、`check-permissions.ts`、`rbac-field-filter.ts`、`define-policies.ts`、`packages/medusa/src/feature-flags/rbac*.ts`、`packages/admin/dashboard/src/routes/roles|policies/`。
   → GML 模块 05 只能参考 casbin。字段级脱敏在 medusa 里也是企业版，**必须自研**。
2. **权限策略不允许用 `eval`**：casbin 的行级规则靠 `eval(p.sub_rule)` 求值，策略表一旦被注入就是 RCE。
   `rbac/rbac.js` 已改为「受限表达式白名单 + 编译成 SQL WHERE 参数化绑定」，**不要改回 eval / new Function**。
3. **不许整段复制**：参考仓库在 `_ref/`（已被 gitignore），只作阅读用。抄进来的片段必须在文件头注明来源仓库、文件路径与许可。

## 四、采用步骤（建议一轮只吃一块）

### 通用四步
1. 把 `001_*.sql` 的内容**转成迁移脚本**：`server/db/migrations/NNN_xxx.cjs`（不要直接改 `schema.sql`，旧库要靠迁移升级）。
2. 把 `.js` 骨架移到 `server/lib/` 下对应位置，按 GML 现有约定改：`import { getDb } from '../db/index.js'`，错误用 `fail()`，事务用 `db.transaction(...).immediate()`。
3. 在 `server/routes/` 下接路由，接完补 `server/openapi.js` 的路径（当前 1.8.0 / 269 条）。
4. 把 `reusable/test-reusable.mjs` 的断言**复制成正式的 `scripts/test-*.mjs`**，让门禁能跑到。

### 促销引擎（建议第一块吃，P1 最缺）
- 必看源码：`_ref/medusa/packages/modules/promotion/src/utils/compute-actions/line-items.ts`（`appliedPromotionsMap` 防重复打折）、`buy-get.ts:645`（`sortByBuyGetType` 裁决器）、`services/promotion-module.ts:336-372`（`registerUsage` 加锁防超发）。
- **medusa 没有、GML 已补齐**：`priority` / `stack_group` / `is_exclusive` 三列 —— 就是你要的"叠加规则与优先级"。
- **SQLite 适配要点**：medusa 用 `SELECT ... FOR UPDATE` 行锁（且按 id 排序避免死锁）；SQLite 没行锁，改用 `BEGIN IMMEDIATE` + 条件式 `UPDATE ... WHERE used < limit` 并用 `changes` 判成败 —— 已实现并测过。
- 还差：券码发放与核销、会员等级、秒杀库存预占。

### 复式记账（第二块）
- 必看源码：`_ref/medici/src/models/transaction.ts`（借贷双列同表）、`src/helper/addReversedTransactions.ts:19-24`（红冲＝借贷互换）。
- **两个已踩过的坑，别再踩**：
  1. 红冲凭证必须用独立 `doc_type='VOID'` 且 `doc_id` 留空，否则撞上幂等唯一索引（测试里真炸过）。
  2. 余额查询**不能**过滤 `j.voided=0` —— 原凭证与红冲凭证都在账上互相抵消才为 0；过滤了会扣两次。
- **medici 没有、GML 已补齐**：期间闸门 `acct_periods`（不结转会把凭证写进已结账月份）、幂等唯一索引。
- 还差：账龄分桶（**必须按单据维度 FIFO 冲销**，不能用科目余额按日期区间算）、与应收应付的对账视图。

### 行级权限（第三块，配合模块 05）
- 抄 casbin 的三处设计：五元组 `sub,dom,obj,act,eft`（dom 映射组织/仓库）、`deny` 优先、角色继承。
- **不引 casbin 依赖**（理由写在 `rbac/rbac.js` 头部）：列表页逐行 enforce 必炸，已改成把规则反向编译成 SQL `WHERE`。
- 还差：字段级脱敏（casbin 与 medusa 都不给，需自研，放响应序列化层）、组织架构树。

## 五、门禁（提交前必跑）

```bash
npx tsc --noEmit          # 0 错误
npm run build             # vite 通过
node scripts/verify-migrations.mjs   # 三库迁移一致
node reusable/test-reusable.mjs      # 31/31
```

## 六、已知边界（别指望骨架里有什么）

- 促销：**没有**券码发放、秒杀预占、会员等级、赠品（buyget 的排序逻辑有，赠品生成没做）。
- 记账：**没有**账龄、多币种折算、辅助核算维度体系、报表。
- 权限：**没有**字段级脱敏、组织树、审批流联动。
- 三块都**没有**前端页面。

## 七、来源与许可留痕

| 仓库 | 许可 | 用了什么 |
|---|---|---|
| medusa | MIT（企业版除外） | 促销领域模型与裁决器算法 |
| medici | MIT | 复式记账数据结构与红冲语义 |
| node-casbin | Apache-2.0 | 权限五元组模型与 deny 优先（仅设计，未引依赖） |

其余 4 个仓库（idurar AGPL、wms-ts GPL、openboxes EPL、pos-offline 无许可）**已删除**，不得再引入。
