# GML 模块 08A/08B：销售报价与信用控制 — 详细设计（v1）

> 版本：v1｜日期：2026-10-15｜状态：已上线（含演示数据与自动化测试）
> 关联：模块 05A 价格中心（取价）、模块 12A 订货中心（信用占用同口径）、模块 04 单据内核（报价单 QT 为第 31 种单据）、模块 09 存货核算（转单后走库存/成本主链路）

---

## 0. 一句话定位

报价是把「一条消息」变成「一张单」：价由价格中心算出、带有效期、低于限价要审批、审批通过才能转订单、一张报价只能转一次。
信用控制是把「额度」变成「唯一真相」：已用 = 台账 + 订货中心同主体占用；超信默认拦住；特批放行必须填理由、全留痕。

---

## 1. 业务背景与三条硬口径

### 1.1 为什么要做报价单
经销商 / 门店要货前的真实动作是「询价 → 报价 → 谈妥 → 下单」。以前报价散落在微信、电话里，价格随口说，转单时对不上。报价单要解决的：

1. **价从哪来**：每一行标注取价来源（价格中心规则 / 客户政策 / 手工改价），手工改价单独标识；
2. **管到哪天**：报价有有效期，过期、未审批的报价不允许转订单；
3. **谁批的**：低于限价或超金额阈值的报价必须审批，审批记人、记时间、记原因；
4. **转成什么**：审批通过才能「转订单」，一张报价只转一次，转完锁定、不可再转。

### 1.2 为什么信用要同口径
销售订单（销售域）和订货中心（12A）都会吃掉同一个经销商的额度。如果两套各算各的，额度就不是真相。本模块的硬约束：

- **已用额度只有一条账**：信用台账（credit_ledger）+ 订货中心同主体占用的交集口径，前端/拦截/报表都用同一个 `accountSnapshot()`；
- **超信默认拦截**：确认销售订单 / 报价转订单时做信用校验，超额默认 `CREDIT_LIMIT_EXCEEDED` 拦住；
- **特批必须留痕**：带 `override_reason` 的放行写进 `credit_check_logs`，谁放的、为什么放、放了多少，永久可查。

### 1.3 三条硬口径（验收标准）

1. **额度口径唯一**：任意时刻 `快照.已用 = Σ台账占用 − Σ台账释放 + 订货中心占用`，拦截判断与界面显示一致；
2. **报价流转闭环**：draft → submitted → approved → converted 单向推进；rejected 可 resubmit 回到 submitted；cancelled 终结；每一步走单据内核留痕；
3. **拦截可解释**：每次校验（无论通过/拦截/放行）都留一行 check log，含额度、已用、本单金额、超出额、结论与理由。

---

## 2. 数据模型

### 2.1 报价单（迁移 018，单据内核注册 QT）

```
sales_quotes
  id / quote_no(QT+日期+序号) / version / parent_quote_id(改版本链)
  customer_type(dealer|store) / customer_id / channel
  status(draft|submitted|approved|rejected|converted|expired|cancelled)
  total_amount / discount_rate / list_amount / approval_required(0|1)
  approval_reason / approved_by / approved_at / rejected_reason
  valid_from / valid_until / converted_so_id / converted_so_no / converted_at
  credit_check_result / credit_override_reason / remark
  created_by / created_at / updated_at

sales_quote_items
  id / quote_id / sku_id / qty / unit_price / list_price / discount_rate
  price_source(rule|policy|manual) / price_rule_code / price_rule_name
  manual_adjusted(0|1) / amount / sort_no
```

**内核注册**：`doc_types` 增 QT（第 31 种）；状态 7 种；动作 submit/approve/reject/resubmit/convert/cancel/expire；业务流 `FLOW_QUOTE`：报价单 → 销售订单。

**销售订单新增列**：`quote_id / quote_no / credit_hold(本单占用额度快照) / credit_checked_at`。

### 2.2 信用账户（迁移 018）

```
credit_accounts
  id / subject_type(dealer|store) / subject_id / credit_limit / payment_days
  temp_limit / temp_limit_until / frozen(0|1) / frozen_reason / frozen_at / frozen_by
  created_at / updated_at
  UNIQUE(subject_type, subject_id)

credit_ledger（占用台账，额度唯一真相）
  id / account_id / doc_type / doc_id / doc_no
  change_type(occupy|release|settle|adjust) / amount / balance_after
  ref_doc_type / ref_doc_no / operator / remark / created_at

credit_check_logs（校验留痕）
  id / subject_type / subject_id / doc_type / doc_no / amount
  credit_limit / used_before / available / exceed_amount
  result(pass|blocked|override) / override_reason / operator / created_at
```

### 2.3 已用额度的定义（唯一口径）

```
已用 = Σ(credit_ledger 中 occupy/adjust 正项 − release/settle 释放项，余额 balance_after 最新值)
     + 订货中心同主体（customer 指向同一经销商）的未结算占用
```

- **占用**：销售订单确认时按 `receivable_amount` 记 occupy；订货中心下单时同口径记占用（记 `doc_type='OC'`）；
- **释放**：订单取消 / 核销 → release；回款 → settle（按回款金额减占用）；
- **调整**：管理员在信用账户页手工 adjust（正负皆可，必须填原因）。

**临时额度**：`temp_limit + temp_limit_until`，有效期内叠加到 `credit_limit`，过期自动失效（判定时按当前日期比较，不做定时任务）。

**冻结**：`frozen=1` 时一切占用动作直接 `CREDIT_FROZEN` 拦截；冻结必须填原因；解冻留痕。

---

## 3. 报价引擎（server/lib/quote.js）

### 3.1 取价（price engine）

```
listPriceOf(sku, channel):
  dealer  → price_dealer（无则 price_retail）
  online/pos/franchise → price_member（无则 price_retail）
  其他 → price_retail
```

逐行取价顺序（每一行独立，来源透明）：
1. 价格中心规则命中 → `price_source='rule'`，记 `price_rule_code/name`；
2. 客户政策价（经销商协议折扣）→ `price_source='policy'`；
3. 渠道标准价 → `price_source='list'`；
4. 用户手工改价 → `manual_adjusted=1`，界面标「改价」。

**取价试算**（`POST /api/sales/quotes/price`）：只算不落库，给「新建报价」页实时看价格与折扣。

### 3.2 审批规则

`approval_required=1` 的触发条件（任一命中即需审批，`approval_reason` 拼出全部原因）：
- 报价总额 ≥ `settings.approval_amount_threshold`（默认 200,000，可在 meta 端点配置）；
- 任一行折扣率低于客户政策折扣下限；
- 任一行手工改价且低于渠道限价。

审批动作走单据内核：`submit（草稿→已提交）→ approve / reject`，驳回后 `resubmit` 回到已提交。

### 3.3 转订单（核心闭环）

`POST /api/sales/quotes/:id/convert`：

1. 状态必须是 approved，且未过期、未转过（`converted_so_id IS NULL`）；
2. **信用校验**：调 `checkCredit(db, {subjectType, subjectId, amount})`，返回 `pass/blocked`；
   - blocked → 拒绝转单，写 check log（result='blocked'）；
   - 带 `override_reason` 重试 → 允许，写 check log（result='override'，理由必填）；
3. 通过则调订货中心 `createOrder` 生成销售订单，回写 `quote_id/quote_no/credit_hold/credit_checked_at`；
4. 信用台账记 occupy（金额 = 订单应收）；
5. 报价状态 → converted，内核留痕。

### 3.4 过期与清理

- 过期判定实时：`valid_until < 今天` 的 submitted/approved 报价在查询时标记 expired（不落定时任务）；
- `POST /api/sales/quotes/expire`：批量把已过期且未转单的报价置为 expired（管理员手动触发，按钮在列表页）；
- `copy`：复制任何一张报价生成新版本草稿（版本链 parent_quote_id）。

---

## 4. 信用引擎（server/lib/credit.js）

### 4.1 核心函数

| 函数 | 说明 |
| --- | --- |
| `ensureAccount(db, type, id)` | 无账户则按主数据默认额度建户（幂等） |
| `accountSnapshot(db, accountId)` | 唯一真相快照：额度/临时额度/已用/可用/使用率/逾期 |
| `checkCredit(db, {subjectType, subjectId, amount, docType?, docNo?})` | 校验：冻结→frozen；超额→blocked（含超出额）；否则 pass |
| `occupy / release / settle / adjust` | 台账四类变动，全部带 balance_after |
| `updateAccount` | 额度/账期/临时额度/冻结维护（冻结必填原因） |
| `listRiskAccounts` | 风险榜：超额/使用率≥90%/逾期/冻结 |
| `auditCredit` | 对账：台账余额 vs 订单占用快照（credit_hold） |

### 4.2 销售订单生命周期挂钩（server/routes/sales.js）

- **确认订单**：事务内先 `checkCredit`，超额默认拦（`CREDIT_LIMIT_EXCEEDED`）；带 `credit_override_reason` 则放行并留痕。通过后 occupy + 回写 `credit_hold/credit_checked_at`；
- **取消订单**：release 对应占用；
- **回款**：settle 按回款额减占用（不超额）；
- **订货中心**：下单同口径占用（doc_type='OC'），结算后释放。

### 4.3 校验留痕

每次 `checkCredit` 无论结论都写 `credit_check_logs`（或至少在 blocked/override 时写）：
`result ∈ pass | blocked | override`，blocked/override 必带 `exceed_amount`；override 必带 `override_reason`。界面「校验与放行留痕」页签直接读这张表。

---

## 5. 接口清单（OpenAPI 1.7.0）

### 销售报价（/api/sales/quotes）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /meta | 阈值、有效期默认值、状态字典 |
| GET | /overview | 待审批数、已转单金额、7天内到期数、总数 |
| GET | / | 列表（状态/关键字/仅看可转单/分页） |
| POST | /price | 取价试算（不落库） |
| POST | / | 新建报价 |
| GET | /:id | 详情（行明细+取价来源+审批信息+留痕） |
| POST | /:id/action | submit/approve/reject/resubmit/cancel |
| POST | /:id/convert | 转销售订单（信用闸门） |
| POST | /:id/copy | 复制改版 |
| POST | /expire | 批量过期清理 |

### 信用控制（/api/credit）
| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | /meta | 主体类型字典、默认阈值 |
| GET | /overview | 账户数/授信总额/已用/逾期户/冻结户/风险榜 |
| GET | /accounts | 台账列表（含快照列） |
| GET | /accounts/:id | 详情（快照+台账流水+校验留痕） |
| POST | /accounts/:id | 维护额度/账期/临时额度/冻结 |
| POST | /check | 手工试算校验（不落占用） |
| GET | /ledger | 台账流水（按账户/类型过滤） |
| GET | /checks | 校验留痕 |
| POST | /settle | 手工结算释放 |
| POST | /adjust | 手工调整（必填原因） |
| POST | /release | 手工释放 |
| GET | /audit | 额度对账 |

---

## 6. 前端（src/pages/sales）

- **Quotes.tsx（销售报价单）**：两个页签「报价列表 / 新建报价（含取价试算）」。列表列：单号/客户/版本/有效期/金额/整单折扣/状态/审批原因/操作；详情弹窗含行明细（取价来源、改价标）、审批卡片、转订单按钮（仅 approved 且未过期可见）。
- **Credit.tsx（信用控制）**：三个页签「风险概览 / 信用账户 / 校验与放行留痕」。账户行内维护额度、账期、临时额度、冻结/解冻；详情弹窗 = 快照 + 台账流水 + 校验留痕。
- 菜单：销售管理 → 销售报价单、信用控制；路由 `/sales/quotes`、`/sales/credit`。

---

## 7. 演示数据（quote-seed.js，三行业库同构）

每库固定造出可讲的故事线：
1. 一张「大额报价被信用拦截 → 特批放行 → 转单成功」的完整链路（两次 check log：blocked 与 override 各一）；
2. 一张已过期的报价（验证转单按钮消失）；
3. 一张需审批的报价（超阈值，approval_reason 写清原因）；
4. 一张驳回后再提交的报价（版本链）；
5. 信用账户：1 户冻结（带原因）、1 户逾期（45 天，占用 15,435.57）、临时额度示例；
6. 台账：occupy/release/settle/adjust 四类至少各 1 条。

脱敏：客户一律「华东经销甲/华南经销乙」类虚构名，零真实品牌。

---

## 8. 测试与验收

`scripts/test-quote-credit.mjs`（三库串行，每库 ≥100 断言）覆盖：
- 报价：取价三来源、审批触发三条件、有效期判定、转单闭环、只转一次、过期拦截、复制改版；
- 信用：快照口径 = 台账 + 订货中心占用、超额拦截、特批放行留痕、冻结拦截、临时额度生效/失效、取消释放、回款结算、对账零漂移；
- 内核：QT 31 种单据注册、动作合法流转、留痕完整（无孤儿事件）。

回归：docflow 50 / qc 96 / purchase 102 / metrics 61 / costing 112×3 / stock-v2 48 / pricing 30 / org-perm 13 / mcp 33 / flows 40 / oc 70 / notify 45 / approval 45 全绿；契约 252 接口、前端 176 处调用 100% 覆盖；vite build 通过；界面截图 7 张（quote-01~03、credit-01~04）。

---

## 9. 与既有模块的接缝

- **05A 价格中心**：报价取价全部走价格引擎，规则命中写 code/name，可追溯；
- **12A 订货中心**：信用占用同口径（OC 单据也进 credit_ledger）；报价转单复用订货中心 createOrder；
- **04 单据内核**：QT 注册后，状态机、动作、留痕、编码规则（QT 前缀）全部复用；
- **09 存货核算**：报价转单后即进入库存/成本主链路，本模块不碰成本。

---

## 10. 已知边界与后续

1. 逾期判定按「最早未回款订单 + 账期」简化计算，未做逐单核销的账龄表（模块 10 应收应付再做）；
2. 临时额度到期靠查询时实时判定，没有定时失效任务（够用，且幂等）；
3. 订货中心占用与订单占用在做「同主体归并」时按 customer_id 精确匹配，门店直配场景后续并入；
4. 报价审批目前单级，多级审批走通用审批中心（approval.js）的接入点已预留（approval_required + reason）。
