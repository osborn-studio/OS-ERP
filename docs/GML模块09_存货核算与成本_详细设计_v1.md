# GML 模块 09 · 存货核算与成本（三层成本、暂估差异回写、期末结转）详细设计 v1

- 日期：2026-10-15
- 状态：已实现并通过三库全量回归（112 项/库）
- 上游依赖：模块 03 库存中心（inventory_transactions / inventory_stocks / stock_cost_ledger）、模块 04 单据内核（applyTransition）、模块 07 采购域（purchase_settlements 的 final_cost）
- 下游：模块 24 框架文档、财务报表类指标

## 一、这个模块要解决的是什么问题

### 1.1 财务每个月必问的三个问题

一个供应链系统走到「有采购、有销售、有库存」之后，财务每个月一定会来问三件事：

1. **这个月的成本是多少？** —— 不是「库存还有多少」，而是「期初多少 + 本期进来多少 − 本期出去多少 = 期末多少」这条账。答不出这条账，毛利就是一笔糊涂账。
2. **暂估和实票差了多少？差在哪？** —— 货到单未到时按订单价暂估入账，月底票到了金额对不上。差异必须被显式回写到批次成本上，而不是「下个月 magically 就对了」。
3. **账能不能对上？** —— 流水累计算出来的结存金额，和 inventory_stocks 里存的金额，必须相等。不等就是有人绕过引擎直接改了数。

模块 03 的 stock_cost_ledger 只回答了「每次出入库让结存从多少变成多少」；本模块把这条台账升级成完整的**期间成本账**。

### 1.2 为什么不能「在库存上直接改单价」

成本调整如果只是 `UPDATE inventory_stocks SET cost_price=...`，会同时丢掉三样东西：**谁调的、为什么调、调之前是多少**。差异被静默吞掉，正是本模块要消灭的事。所以成本调整必须是一张**走单据内核的单**（CA），回写必须写**成本台账**（direction='adj'）。

## 二、核心设计判断

### 2.1 三层成本恒等式（含两段容易被忽略的延伸）

    期初 + 本期入 − 本期出 + 本期调整 = 截至期末
    现存量 − (截至期末 + 期末之后流水) = 0   ← 残差恒等式

三层本身是常识；本模块真正守住的是三个容易漏的口径：

- **现存量是「今天」的，期末是「期末那一天」的**。期间没结转时两者本来就该差一段「期末之后的流水」（实测服装库有 2 笔日期 2026-11-03 的入库单，净 29 件 / 22,980.80 —— 最初它表现为一个没人解释得清的残差）。把这一段单独归因为 `later` 层之后，残差恒为 0，**非 0 才是真有账实不符**。
- **成本调整不写 inventory_transactions，只写 stock_cost_ledger 的 adj 行**。调整只改金额不动数量 —— 但三层如果只从 transactions 算，任何一次真实的调整都会让现存量凭空多出回写金额，残差从此永不归零、结转被禁用（实测 +1504.9）。所以恒等式必须**含调整项**：期初倒推、本期、期末之后三段都要并入 adj 净额。
- **结转快照必须与三层同源**。快照逐维度取「截至期末日的流水累计 + 调整净额」，不用现存量 —— 同源才能保证下期期初与本期的期末是同一个数；不一致宁可结账失败（`COST_SNAPSHOT_DRIFT`）。

### 2.2 暂估差异的两个口径，混用会让核心动作变成空转

实测踩过：界面显示「待调整 566,866.88」，点进去建出来一张 **0 元调整单**。

- **发票口径 invoice_diff** = 结算单头部 diff_amount = 入库暂估 − 已开票。它是供应商-期间级的数，回答「这期还有多少货没拿到票」；发票行**没有字段指回批次**，所以它**不能**回写库存成本。
- **成本口径 cost_diff** = Σ(入库行 qty × final_cost) − Σ(入库行 amount)。费用发票的运费/卸货费在结算时摊到入库行，final_cost 与暂估单价的差**带着仓库与批次**，能精确落到 inventory_stocks 的那一行 —— 只有它能回写。

结论：**待办只列成本口径**（`only=adjustable`）；发票口径的差额单列展示（财务要看，但不是成本待办）。做不到的事不在待办里承诺 —— 与模块 07「宁可少算，绝不重复算」同源。

### 2.3 差异的三段去向：回写 + 已售不追溯 + 未处理

    差异 = 已回写（进库存） + 已售出不追溯（进本期损益） + 仍未处理

- **只调仍在库部分**：每行可调整数量 = min(批次现存量, 本行入库量)。上界取入库量是因为批次可能被多张入库单共用（批次号会撞），拿批次现存量会替别的单多调（实测食品库 24 行里若干行中招）。
- **已售出部分不追溯**：追回去改历史出库成本等于重写历史毛利，下游报表全部失真。但必须**算出来单列**（sold_amount），否则「差异去哪了」没人答得上。
- **已售不追溯的部分永远不进待办**：少了这条，只要一张单涉及已售数量，待办里就永久挂着一截谁也做不掉的尾巴（实测：差异 1557.2，回写 1504.9，剩 52.3 永远是「待调整」）。

### 2.4 期间与闸门

- `cost_periods` / `cost_period_balances`：期间状态 + 期末快照。快照是「结转那一刻的结存」，也是下期的期初。
- **期间闸门挂在出入库入口**（`stock.js` 的 applyStockIn / applyStockOut 调 `assertPeriodWritable`）：已结转期间不允许再写流水 —— 否则「期末」两个字失去意义。闸门放入口而不是放报表，是因为绕过入口的写入才最危险。
- **没走完的期间不能结**（`PERIOD_NOT_FINISHED`）：期末日还没到就关账，后面每天的出入库都会让这个「期末」看起来是错的。
- **不重复结转**（`PERIOD_ALREADY_CLOSED`）；重结必须显式 reopen（先删快照）。

### 2.5 计价方式：支持集合，其它显式拒绝

`inv_params.cost_method` 只认 `moving_avg` / `batch_actual`。写成 `lifo` 时**显式 409 `COST_METHOD_UNSUPPORTED`**，而不是默默按移动平均算 —— 报表上写着「先进先出」而数字是加权平均，这类错不报错，只让所有成本口径变成假的。

## 三、单据定义（内核）

### 3.1 成本调整单 CA

定义写在 `008_doc_kernel.cjs`（定义归内核，结构归各自迁移 —— 否则内核 heal 会把定义抹掉）：

- DOC_TYPES：`['CA','存货成本调整单','inventory','cost_adjustments','CA',1,33]`
- STATES（三个，kind 齐备）：draft（draft）/ adjusted（done）/ cancelled（void）
- ACTIONS：`adjust`（唯一有后果）+ `cancel`。**没有 void 动作** —— 已调整的单不可作废，要纠正开反向调整单；这与「差异不能被静默吞掉」是同一条理由。

### 3.2 权限点

`cost.view`（看）与 `cost.adjust`（调与结转）分立；admin/finance 两个都有，boss/warehouse/viewer 只读。结转是财务动作，仓库不该有权。

## 四、数据模型（迁移 017_costing.cjs）

- `cost_periods`：期间 + 状态 + 结转人/时间 + 三层快照合计 + 残差记录
- `cost_period_balances`：期末快照，逐维度（仓库/货主/币种/SKU/批次），是下期期初
- `cost_adjustments`：调整单表头（settle_id/settle_no 快照、差异、回写金额、已售金额、期间）
- `cost_adjustment_items`：行级明细（入库量/在库/已售三数、暂估价/实价、回写金额、**unit_before/unit_after、amount_before/amount_after**）

行级 before/after 两对字段是本模块的关键留痕：回滚（procure-seed 清孤儿单）与界面展示（「单价 从多少 → 到多少」）都依赖它。

## 五、接口设计（/api/costing，11 个端点）

    GET  /meta                    状态/计价方式/调整类型枚举
    GET  /overview                一屏看懂：三层 + 待调整 + 自洽审计 + 期间状态
    GET  /layers                  三层明细（可按仓库/SKU/批次下钻）
    GET  /audit                   成本自洽审计（流水累计+调整净额 vs 结存金额）
    GET  /periods                 期间列表
    POST /periods/close           期末结转（锁期间；reopen 才允许重结）
    GET  /variances               暂估差异台账；?only=adjustable 只回能回写的
    GET  /adjustments             调整单列表（分页）
    POST /adjustments             从结算单开调整单（草稿，不改成本）
    GET  /adjustments/:id         调整单详情（行级前后单价与金额）
    POST /adjustments/:id/adjust  确认调整 —— 唯一有后果的动作
    POST /adjustments/:id/cancel  取消草稿

错误码约定：顶层 `code` 是数字（0 成功/1 失败），业务码在 `detail.code` —— `PERIOD_CLOSED` / `PERIOD_NOT_FINISHED` / `PERIOD_ALREADY_CLOSED` / `COST_SNAPSHOT_DRIFT` / `COST_METHOD_UNSUPPORTED` / `COST_ADJ_DUPLICATE` / `COST_NO_VARIANCE` / `COST_SETTLE_NOT_READY` / `COST_SOURCE_GONE` 等。

## 六、本轮被成本核算「照出来」的真实缺陷

这一节是本模块最有价值的部分 —— 它们全部是先在界面上表现为「数字不对」、再被恒等式定位的：

### 6.1 调整一旦真实生效，三层残差永不归零（真缺陷，已修）

`threeLayers` / `closePeriod` / `auditCostIntegrity` / `recompute` 原来都只认 inventory_transactions 的 in/out。而 `adjustCost` 只写 adj 台账、只改结存金额。后果：**任何一次真实的调整**（HTTP 端到端验证时调整了 1504.9）之后，现存量比「截至期末 + 之后流水」永久多出回写金额 → `balanced=false` → 结转被禁用、审计报 7 行 broken。修法：四处口径全部并入 adj 净额；三层新增 `adj` 层展示。

### 6.2 procure-seed 清孤儿调整单时留下「无源成本」（真缺陷，已修）

`seedProcurement` 幂等清空重建结算单时，会把指向旧结算单的调整单当孤儿删掉 —— 但**调整造成的后果还在**：结存金额被改过、adj 台账有行、留痕还在。单没了、钱还在，三层从此差一块（+1504.9 实测复现路径：HTTP 建单确认 → 跑 test-purchase → 调整单被清）。修法：删单前按 id **倒序**回退（连续调整时最新的 before 就是上一张的 after），结存金额回到 amount_before（带守卫：只退确认后没再被动过的行），连带删 adj 台账行与 CA 留痕。

### 6.3 已售不追溯的尾巴让待办永远清不掉（真缺陷，已修）

待调整 = 差异 − 已回写。但已售出部分**本来就不该回写**，于是只要单子涉及已售数量，待办永远剩一截。修法：待调整 = 差异 − 已回写 − 已售不追溯（`estimateVariances` 的 `sold_not_traced` 与概览统计同步扣减）。

### 6.4 餐饮库的暂估差异链路整个是空的（真缺陷，已修）

procure-seed 把费用发票（运费摊入 → final_cost → 成本口径差异）写死给「第一个可结算供应商」，餐饮版第一个供应商恰好无可结算单据 → 建不出费用结算 → **餐饮库待办恒为 0，整条链路没得演示**。修法：费用模式逐供应商试，第一个结算成功的用费用模式（发票也只给这家开）。修后三库各有 1 张可回写差异单（约 1,546–1,577 元）。

### 6.5 test-qc 拆夹具漏删 PRT 留痕（连带查出）

dropReceipt 删退货单时没删它的流转留痕 → 每跑一轮测试留 2 条 PRT 孤儿，且下一张退货单复用 id 后会把旧留痕「认领」走。修法：拆夹具连带 `DELETE FROM doc_events WHERE doc_type='PRT' AND doc_id=?`。零孤儿从此成为可断言不变量（test-costing T7 / verify-seed 第 8 项）。

## 七、前端页面（/inventory/costing）

- 菜单：存货管理 → 存货核算与成本（收发存台账之后）
- `src/api/costing.ts`：类型化客户端 + 口径注释（两个差异口径、残差含义写在代码里）
- 页面四个页签：
  - **本期成本**：三层表（期初/入/出/调整/截至期末/期末之后/现存量）+ 残差行；残差非 0 时顶部红字警示并**禁用结转按钮**
  - **暂估差异**：只列可回写口径；发票口径差额在说明里单列；「开调整单」一键从结算单建草稿
  - **调整单**：列表 + 详情弹窗（行级三数、单价 前→后）；草稿可确认/取消
  - **期间结转**：期间列表 + 结转按钮（未结转且残差归零才可点）

## 八、验证

### 8.1 scripts/test-costing.mjs（三库各 112 项）

覆盖：三层闭合与残差归零、期间解析边界（periodOf 曾经把 Date 切成 "Thu Oct"）、计价方式拒绝、期间闸门（结转后建调整单被拦 `PERIOD_CLOSED`）、结转三条约束、暂估差异双口径、草稿调整单不计入已回写（单列「草稿待确认」）、调整全链路（草稿不改成本 → 确认写台账 → 台账金额变动合计 = 回写金额 → 结存增量 = 回写金额 → 已售不计入库存 → 已调整不可取消 → 同一结算单已有草稿时返回草稿而非报错 → 取消后可重建）、行级三数闭合、回滚夹具自校验、T7 留痕与重建卫生（CA 零孤儿、全库零孤儿、调整单零孤儿指向结算单、台账不跨代累积）。

### 8.2 HTTP 端到端（真实服务）

建单 → 详情（7 行明细）→ 确认调整 → 已调整后取消被内核拦 `TRANSITION_NOT_ALLOWED` → 当期结转被拦 `PERIOD_NOT_FINISHED`。前端四页签截图通过，控制台仅 favicon 404。

### 8.3 全量回归（串行，2026-10-15）

    docflow 50 · stock-v2 48 · pricing 30 · org-perm 13 · mcp 33 · flows 40 · oc 70
    notify 45 · approval 45 · purchase 三库 102 · metrics 三库 61 · qc 三库 96 · costing 三库 112
    verify-seed 三库全绿（含留痕对账零孤儿）· smoke-api 2xx 218 / 4xx 18 / 5xx 0 / 异常 0
    check:api 契约 1.6.0 · 232 条接口 · 前端 154 处调用 100% 覆盖 · vite build 通过

本轮同时完成演示数据脱敏：`server/db/datasets.js` 中三行业供应商、经销商、门店、仓库地址、城市、品牌/商品前缀已统一替换为虚构中性名，避免真实客户/品牌名出现在界面与截图中。

## 九、已知边界

- 快照只并回「有流水组」的维度：数量已全部消耗的批次不进流水组（HAVING 拦掉），它的调整金额也不进快照 —— 那批货已不在账上，带着金额反而是错。若出现口径裂缝，快照与三层的同源校验会直接结账失败，不静默。
- procure-seed 回退孤儿调整单时只退「确认调整后没再被动过」的行；被动过的留着，由成本自洽审计把差异亮出来。
- 手工调整单（settle_id 为空）在 procure-seed 重建时一律保留。

## 十、文件清单

    server/db/migrations/017_costing.cjs        4 张表 + 权限点 + 定义指纹
    server/db/migrations/008_doc_kernel.cjs     CA 类型/状态/动作（+1 类型，29 → 30）
    server/db/migrations/003_inv_dict.cjs       cost_method 参数口径备注
    server/lib/costing.js                       全部业务（约 1100 行）
    server/lib/stock.js                         出入库入口挂期间闸门
    server/routes/costing.js                    11 个端点
    server/openapi.js                           契约 1.5.0 → 1.6.0
    src/api/costing.ts · src/pages/inventory/Costing.tsx · App.tsx · Layout.tsx
    server/db/seed.js · procure-seed.js         重建清理清单 + 孤儿调整单回退 + 费用结算逐供应商
    scripts/test-costing.mjs（112×3）· scripts/probe-costing.mjs · scripts/probe-orphans.mjs
    scripts/test-docflow.mjs（29 → 30 类型断言）· scripts/test-qc.mjs（拆夹具补删 PRT 留痕）
