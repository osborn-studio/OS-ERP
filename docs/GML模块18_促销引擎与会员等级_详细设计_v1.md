# GML 模块 18：商城促销引擎与会员等级 — 详细设计（v1）

> 版本：v1 · 2026-10-15
> 迁移：`025_promo_member.cjs`
> 后端：`server/lib/promotion.js`（1000 行）/ `member.js`（745）/ `coupon.js`（586）/ `checkout.js`（480）
> 路由：`server/routes/promo.js`（648 行，`/api/promo` 共 40 个端点，OpenAPI 1.14.0）
> 前端：`src/pages/marketing/PromoCenter.tsx`（1725 行，`/marketing/promo` 六个页签）
> 测试：`scripts/test-promo.mjs`（三库各 114 条断言）

---

## 0. 一句话定位

**把「这一单该收多少钱」从一句报价，拆成一条可逐段核对、可逐行追溯、可当场解释的算式。**

在模块 18 之前，商城只有一条线：取价引擎（模块 05A）回答「这件商品卖多少钱」。
它回答不了三件事，而这三件事恰好是商城每一天都在被问的：

| 问题 | 没有本模块时的现实 |
|---|---|
| 这一单该减多少、为什么减、还能再减吗？ | 只在订单头上落一个 `discount_amount`，没人知道它从哪来 |
| 这个人是几级会员、手里那张券还能用吗？ | 等级靠一张 Excel，券靠客服记在本子上 |
| 积分是怎么来的、花到哪去了？ | 账户上只有一个余额数字，改一次就成了悬案 |

所以本模块的产出不是「能做促销」，而是**三条可以被验证的硬口径**，以及围着它们建起来的四条防事故约束。

---

## 1. 三条硬口径

### 口径一：算钱顺序固定 —— 会员折扣（原价）→ 促销（会员价）→ 积分（最终价）

顺序写反一位，结果会差钱，而且**不会报错**。这就是它必须被写死成一个函数、并在界面上拆成四段显示的原因。

```
① 商品原价合计   = Σ 行小计
② 会员折扣       = 可打折行的原价合计 × (10000 − discount_pct) / 10000
③ 促销优惠       = 促销引擎在「已减掉②的会员价」上继续算
④ 积分抵扣       = 只作用于「已减掉②③的最终成交价」，且不超过它
应付 = ① − ② − ③ − ④
```

实现落在 `server/lib/checkout.js` 的 `quote()`。②→③ 的接缝是**唯一需要解释的一处**：

```js
// 会员折扣先按行摊掉再交给促销引擎：促销引擎的 baseOf 读 `it.subtotal - 已优惠`，
// 所以这里把会员折扣也写进 items 的 subtotal，让促销在**会员价**上继续打折。
const afterMember = distribute(lines, memberDiscount)
const promoItems  = lines.map((it, i) => ({ ...it, subtotal: afterMember[i] }))
```

如果直接把原价交给促销引擎，会员折扣与促销折扣会**各自作用于原价**，于是同一件商品被打折两次
——这正是「同一件商品会不会被两个活动各打一次折」这个老问题的另一种形态。

**为什么积分必须排在最后**：积分是**客户资产**，它换的是钱；而折扣是**商家让利**，它改的是价。
先扣积分再打折，等于让客户用自己的钱去买一个还没打折的价。顺序反了不会报错，只会让客户少拿一点。

### 口径二：优惠必须摊到行 —— 行优惠合计恒等于整单优惠

`quote()` 返回 `line_discounts[]`，每行含 `subtotal / member_discount / promotion_discount / points_discount / payable`，
并且有两道自证：

```js
// 分摊自证（一）：行促销优惠 + 整单促销优惠必须等于引擎给的总优惠
if (sumLine + orderLevelDiscount !== promotionDiscount) throw bad(..., 'PROMOTION_ALLOCATION_MISMATCH', 500)
// 分摊自证（二）：行应付合计必须等于整单应付
if (sumPayable !== payable) throw bad(..., 'ALLOCATION_MISMATCH', 500)
```

**为什么落到行而不是只在订单头记一个总额**：订单头那个数字回答不了「减在哪几行」，
于是退货时算不出「这一行实付多少」——只能按比例反推，而反推出来的数与当初实际优惠经常差几分钱，
差额会攒成一笔说不清的钱（本项目在成本域见过同一个形态）。

**为什么是三段而不是一段总和**：三段的退款策略不同 —— 会员折扣是客户权益（退货收回额度但不退钱）、
促销是商家让利（退货应当退回额度）、积分是客户资产（退货应当退分）。
混成一段，退货时就只能给出一个笼统的「这行曾优惠 12.34 元」，三种处理方式分不开。

落地：迁移 025 给 `oms_order_items` 加了三列（`member_discount` / `promotion_discount` / `points_discount`）。

### 口径三：余额不是真相，流水才是

`member_accounts.points` / `balance_cents` 是**派生余额**，真相在 `member_points_ledger` / `member_balance_ledger`。
每一次变动都写一行流水，并带上**变动后余额** `balance_after_*`：

```
可用它逐行复算：上一行 balance_after + 本行 change = 本行 balance_after
```

`member.js` 的 `assertLedgerConsistent()` 与 `auditMember()` 就是这条口径的守卫，
`verify-seed.mjs` 第 13 节用窗口函数复算了一遍。

---

## 2. 四条防事故约束

这四条不是「功能」，是**针对具体出过的错**加的闸。每一条都对应一次「不报错的错」。

| 约束 | 出错时的表现（无本约束） | 落点 |
|---|---|---|
| **券默认不自动使用** | 一句普通试算顺手把客户券包用光，落单时全部核销，客户没选也没看见 | `coupon.js::codesForCustomer` 只认显式传入的 `couponCodes`；`auto: true` 才带上客户名下的券 |
| **优惠有最低价地板** | 叠加几层折扣后出现 0 元单（甚至负数），财务对不上 | `checkout.js::buildItems` 读 `product_skus.price_min` 成 `price_min_cents`，引擎逐件抵到地板为止 |
| **撤单退分按余额封顶** | 客户把积分花掉了，撤单时「分不够退」→ 整笔撤单失败，留下半撤的脏单 | `checkout.js::unsettle` 退到余额为止，差额报成 `shortfall` |
| **券的优惠额只由促销引擎算** | 运维改券上的 `value` 以为能改优惠，实际一分钱没变 | 券表 `type`/`value` **仅展示**；算钱的唯一入口是它绑定的 `promotions` 规则 |

**关于「券默认不自动使用」的原文（`coupon.js`）**：

> 曾经这里无条件把客户名下所有未用券也一起塞进来，后果是：
> 一句普通的购物车试算就会"自动帮我用掉全部券"，落单时全部核销 ——
> 客户没选、也没看见，券就没了。而且它**不会报错**，只会让券包莫名其妙变空。

---

## 3. 数据模型（迁移 025）

### 3.1 十四张表 + 一个视图

**促销域（7 张）**

| 表 | 作用 | 关键列 |
|---|---|---|
| `promotion_campaigns` | 活动：促销的归属容器，可承载预算 | `code` UNIQUE、`starts_at` / `ends_at` |
| `promotion_campaign_budgets` | 活动预算 | `campaign_id` |
| `promotions` | 促销主体 | `priority` · `stack_group` · `is_exclusive` · `usage_limit` · `used` · `is_automatic` |
| `promotion_rules` | 规则，按 `rule_group` 分三组 | `rules` / `target_rules` / `buy_rules` |
| `promotion_methods` | 优惠方式（1:1 促销） | `type` · `target_type` · `allocation` · `value` · `max_quantity` · `gift_sku_id` |
| `promotion_usages` | 使用登记 | `idempotency_key` UNIQUE |
| `promotion_adjustments` | **订单行优惠留痕** | `order_id` · `order_item_id` · `promotion_id` · `amount` |

**券域（2 张）**：`coupons`（模板）· `coupon_instances`（实例，`coupon_code` UNIQUE）

**会员域（4 张）**：`member_levels`（定义表）· `member_accounts`（派生余额）·
`member_points_ledger` / `member_balance_ledger`（两本流水）

**视图（1 个）**：`v_member_overview` —— 把账户 JOIN 客户 JOIN 等级，并预先算好「未用券数 / 已用券数」两列，
列表页不必逐行 JOIN。

### 3.2 三列是本项目自研补齐的

表结构领域模型参考了 medusa `packages/modules/promotion`（MIT，只作阅读、未整段复制，
按 SQLite 方言重写）。medusa 没有**「多个活动撞在一起谁生效」**这一层，本项目补了三列：

- `priority` —— 数值小者先算；
- `stack_group` —— 同组互斥，一组只取最先命中的那张；
- `is_exclusive` —— 命中即拦截本单其余所有活动。

第四列 `gift_sku_id`（买赠赠品）同样是自研补齐。

⛔ 未参考 medusa 的 RBAC / SSO 相关路径（企业版需商业授权），权限设计一律参考 casbin。

### 3.3 金额口径：本域一律用「分」

GML 其它表的价格多是 `REAL`（元），**促销域刻意不用** —— 折扣要反复按比例摊到行、还要除回去，
用浮点累计会出现「分摊尾差导致总优惠对不上单据」的经典问题（本项目在成本域踩过）。
会员域的储值余额同样按分存整数，积分抵扣上限按**万分比**存整数。

**跨域换算只在边界做一次**：前端一律用元、提交前 `toCents()`；后端一律用分；
单表里不混。

### 3.4 采用前必须先做的一件事（已复现，必须最先做）

`server/lib/pricing.js` 原先用**「`promotions` 表是否存在」**当促销价特性开关，
命中后按 `price` / `sku_id` / `start_at` / `end_at` 四列查询。
而本迁移的 `promotions` 是 medusa 模型（优惠方式在 `promotion_methods`，时间列叫 `starts_at` / `ends_at`），
**没有**这四列 ⇒ 表一建出来，取价引擎每次调用即抛 `no such column: price`，
`seedOrderCenter` 随之崩溃、**服务起不来**。

已改为**探测列形状**（`pragma_table_info('promotions')` 里有没有 `price`），两种模型因此可以共存。
这条被排成批次 F 的第 0 步（`#49`），因为它是「新迁移把旧引擎打崩」的典型：破坏发生在**另一个域**，
报错信息与真实原因毫无关系。

### 3.5 设置项与等级基线

```
promo_points_per_yuan         = 10   // 消费 1 元得多少积分（与等级倍率相乘）
promo_points_per_yuan_deduct  = 100  // 多少积分抵 1 元
promo_points_deduct_max       = 5000 // 积分抵扣上限的全局兜底（万分比，占订单金额）
member_upgrade_auto           = 1    // 自动升降级开关
```

等级四档（`normal` / `silver` / `gold` / `platinum`）由迁移用
`INSERT ... ON CONFLICT(code) DO UPDATE` 灌入 —— 等级权益是**配置**，改了就该生效；
只插入不更新会让「改了 `benefits` 界面没变」变成一次人工查库。

> `settings` 表只有 `(key, value, updated_at)` 三列，**没有 `remark` 列**。
> 别在那里写「带说明的 INSERT」，那会在建表后第一次启动就报 `table settings has no column named remark`。

---

## 4. 促销引擎

### 4.1 唯一的算钱入口

`promotion.js::computePromotionActions(db, ctx)` 是**唯一**的算钱函数。
`quote` / `explainPromotion` / `settle` 全都调它，界面能存的东西与引擎认得的东西因此不会分成两套。

`ctx = { items, customer, subtotal, codes, now }`；返回 `{ actions, appliedCodes, totalDiscount, traced }`。

### 4.2 三种「谁生效」的判定

按 `priority` 升序逐条试算，每条给出四种结局之一：**生效** / **被跳过**（带原因）/ **被独占拦截** / **未命中**。
原因枚举与界面文案一一对应（`SKIP_LABEL`，前端也维护同一份，不自己造词）：

```
need_code            需要券码
no_method            未配置优惠方式
order_rule           不满足适用条件
stack_group          同组已有更优活动生效
usage_limit          已达使用次数上限
exclusive_hit        已被独占活动拦截
no_target            没有可作用的商品行
no_effect            未产生优惠额
buy_rules            买的不够（买赠门槛）
buyget_misconfigured 买赠配置不完整（缺门槛或赠出件数）
```

**为什么每条都要留痕**：用户看到「券没用上」时的第一反应是「系统坏了」。
把这些原因逐条吐出来，是这一页唯一能避免"客服靠猜"的办法。

### 4.3 `value` 的口径：**减免率**的万分比，不是折数

这是本模块**踩得最狠的一个坑，而且它在四个地方各犯了一次**：

| 位置 | 错误写法 | 后果 |
|---|---|---|
| `promo-seed.js` `AUTO_PCT95` | `value: 9500` | 减 95%（本该减 5%），差 19 倍 |
| `promo-seed.js` `GRP_PCT_B` | `value: 9000` | 同上 |
| `openapi.js` schema 描述 | "9 折 = 9000" | 文档把错的教给下一个人 |
| `routes/promo.js` C 端 `method_label` | `value / 1000` | 界面把 500 显示成「0.5 折」 |

统一后的口径：

```
500   = 减 5%  → 实付 95%  → 9.5 折
1000  = 减 10% → 实付 90%  → 9 折
10000 = 全免
算钱：discount = base * value / 10000
```

**方向搞反不报错**，只会让优惠额差十倍。所以 `test-promo.mjs` 的 T4 是专门的方向探针。

### 4.4 买赠（`buyget`）口径

```
触发 = 参与行数量合计 ≥ buy_rules_min_quantity
次数 = floor(合计 ÷ 门槛)
免件数 = 次数 × apply_to_quantity
从**最低单价**件开始免，每件抵到 price_min 地板为止
```

「从最低单价件开始免」是刻意的：如果从最贵的那件免，同一份配置会因为购物车顺序不同给出不同的优惠额
——那是最容易引起客诉的一类不确定性。

### 4.5 规则属性白名单

`RULE_ATTRS = ['sku_id','category_id','qty','unit_price','subtotal','shipping_fee','level','level_code','customer_id']`

**不接受任意 key**：属性名会被当成 `ctxObj` 的键去取值，开放任意 key 等于让调用方探任意对象属性
（同权限域 eval 注入的坑）。白名单同时通过 `/promo/meta` 下发给前端 —— 前端不该自己维护一份（会漂移）。

---

## 5. 会员：等级 / 积分 / 储值

### 5.1 升级门槛是「与」关系

```
升到某级：points_total ≥ min_points  且  total_spent_cents ≥ min_spent_yuan × 100
```

两个门槛必须**同时**满足，所以会员详情页的「距下一级」也分开给两个差值
—— 只显示一个会让客户以为满足了就能升级。

### 5.2 `points_total`（累计积分）只增，且**不等于**「正变动之和」

这一条曾经让 `auditMember` 误报。原因：`setMemberLevel()`（**人工指定等级**）会
把累计门槛**抬到达标线**，否则下一单送分会被自动判定冲回。

这是一次**没有流水支撑的抬高**，所以口径只能是「不低于」，不能要求严格相等：

```js
// 累计积分只增；口径是「不低于正变动之和」
const totalDrift = rows.filter((r) => Number(r.points_total) < Number(r.points_earned))
```

`verify-seed.mjs` 第 13 节与 `test-promo.mjs` 的 T10 都按这个口径写。

而 `points`（**可用积分**）必须严格等于流水合计 —— 它是能被花掉的，差一分就是账不平。

### 5.3 两条独立的钱路：充值 vs 调整

`POST /members/:id/balance` 按 `kind` 分流：

- `kind: 'recharge'` → `rechargeBalance()`，记 `doc_no`，走财务；
- 其余 → `adjustBalance()`，纠错，**必须留理由**。

混成一个接口会让「这笔钱怎么进来的」查不清。前端也据此分成两个选项，且界面上写明了区别。

### 5.4 等级折扣存的是「实付万分比」

`member_levels.discount_pct` —— `10000` 表示不打折，`9500` 表示实付 95%（9.5 折）。
界面上让运营填「实付比例 95」，提交前 `Math.round(pay_pct * 100)` 转成万分比。
方向与促销的 `value`（**减免率**）恰好相反 —— 所以两个字段的注释里都写了对方的名字，防止互抄。

---

## 6. 券生命周期

```
模板（coupons） → 发放/领取（issueCoupons / claimCoupon） → 实例（coupon_instances）
                                                              ↓
                     校验 validateCoupon → 核销 redeemCoupon → 退回 releaseCoupon
                                                              ↓
                                          过期 expireCoupons → 作废 voidInstance
```

### 6.1 幂等有两道防线，错误码分两层

```js
/**
 * ① 前置 `validateCoupon` → `COUPON_NOT_USABLE` + `reason='used'`（正常路径走这条）；
 * ② 条件式 UPDATE 的 `changes===0` → `COUPON_ALREADY_USED`，这一层是并发兜底。
 * 两道都不可省：只有 ① 会在并发下漏；只有 ② 会让调用方拿到"意料之外"的码。
 */
```

### 6.2 防超发给的不是「先查后写」，而是唯一键 + 条件式更新

`promotion_usages.idempotency_key`（`order:<id>:promo:<code>`）唯一；
券的发放量走 `UPDATE ... WHERE issued_qty < total_qty` 的条件式更新。
**判断与写入在同一条语句里**，否则两个并发请求都会读到"还有名额"。

### 6.3 券与促销的接缝只在一处

券实例码（`CP_xxx-000001`）与促销码（`COUPON_FULL`）是**两套编号**。
`coupon.js::codesForCustomer` 负责把前者翻成后者 —— 而不是把券码塞进促销引擎让它自己找。
这条接缝是「券解锁促销」这个模型的全部实现。

---

## 7. 接口清单（OpenAPI 1.14.0，`/api/promo` 共 40 个端点）

独立前缀而不并进 `/api/mall`：`/api/mall` 是**面向 C 端顾客**的免登录通道（手机号即身份），
而活动配置、发券、调积分是**面向内部员工**、要按权限管控的。两类调用者、两种信任级别塞进一个前缀，
权限就没法按路由粒度收口。C 端要用的 4 个端点单独放在 `/shop/*` 分组里，一眼能看出信任级别不同。

**字典与总览（3）**：`GET /meta` · `GET /overview` · `GET /audit`

**会员等级（2）**：`GET /levels` · `PUT /levels/:code`

**活动（3）**：`GET /campaigns` · `POST /campaigns` · `POST /campaigns/:id/status`

**促销（8）**：`GET /promotions` · `POST /promotions/validate` · `POST /promotions` ·
`GET|PUT /promotions/:id` · `POST /promotions/:id/status` · `DELETE /promotions/:id` · `POST /targets/preview`

**试算与结算（4）**：`POST /quote` · `POST /explain` · `POST /settle` · `POST /unsettle`

**券（9）**：`GET|POST /coupons` · `POST /coupons/expire` · `GET|PUT /coupons/:id` ·
`POST /coupons/:id/status` · `POST /coupons/:id/issue` · `GET /coupon-instances` · `POST /coupon-instances/:id/void`

**会员（7）**：`GET /members` · `GET /members/:customerId` · `GET /members/:customerId/ledger` ·
`POST /members/:customerId/{points,balance,level,sync,coupons}`

**C 端（4，免登录）**：`GET /shop/member` · `GET /shop/promotions` · `POST /shop/quote` · `POST /shop/claim`

### 7.1 路径顺序：所有静态段必须注册在 `/:id` 之前

`/promotions/validate` 会被 `/promotions/:id` 吃掉；`/coupons/expire` 会被 `/coupons/:id` 吃掉。
本项目已在别的模块踩过两次，这里一律先静态后动态。

### 7.2 分页出参必须转一次名字

各 `list*` 返回 `{ list, total, page, pageSize }`，而 `paged()` 取的是 **`rows`** ——
名字对不上时它会静默发出 `list: undefined`，前端拿到空列表却不报错。统一走 `pagedList()`。

### 7.3 查询参数是**蛇形**

`customer_id` / `coupon_id` / `level_code`。前端 `promo.ts` 里写驼峰会被原样拼进 query，
后端 `req.query.customer_id` 取不到 → 静默返回**全站**数据（"某客户的券包"显示成所有人的券）。
本轮把 `promotion.ts` 侧的两处驼峰改回蛇形。

---

## 8. 演示数据（`server/db/promo-seed.js`，479 行，三库同构）

```
2 个活动 · 10 张促销 · 3 张券模板 · 7~15 张演示订单
4 位会员（normal / silver / gold / platinum 各一）· 券四态齐全（expired 1 / unused 4 / used 1 / void 1）
```

十张促销各自承担一条演示线：

| 编码 | 演示的东西 |
|---|---|
| `AUTO_EXCLUSIVE` | **独占**：命中即拦截其余全部（含券解锁的那张） |
| `AUTO_LIMITED` | **限量**：使用次数打满后不再登记（条件式 UPDATE 兜底） |
| `AUTO_FULL` | 满减，跨活动叠加 |
| `COUPON_FULL` | **非自动**：没有券码一律不参与 |
| `COUPON_NEWBIE` | 低门槛券，演示「同一单里两张券只挑能生效的那张」 |
| `AUTO_PCT95` | 比例减，方向探针（500 = 减 5%） |
| `GRP_FULL_A` / `GRP_PCT_B` | **同组互斥**：一组只取先命中的那张 |
| `BUYGET_3G1` | **买赠**：买 3 件送 1 件 |
| `ENDED_STOCK` | 已结束的活动（状态与时间窗口自洽） |

### 8.1 三个非显而易见的时序/单位问题（全部踩过）

**① 券的发放必须排在造单之前。**
时序是关键：`placeOrder` 会去查客户**当前可用**的券；如果券还没发，它一张都找不到
→ 订单里 `couponCodes` 为空 → 券永远停在 `unused`，「券核销」这条演示线整个消失，**而且不报错**
（无券下单本来就是合法路径）。这正是本模块要防的那类缺陷：不是崩，是静默少了一段。

**② 券的领取时刻必须按「灌数时钟」回填，不能用真实时钟。**
演示订单是按灌数时钟**倒推**的（最近 18 天内）；券若用真实时钟，反而"晚于"订单，
`validateCoupon` 会判 `not_started`（券尚未生效）→ 券永远核销不掉，**且不报错**。
`backdate()` 统一回填，同时解决「重建可复现」。

**③ 过期样本要按客户定位，不能"取 id 最小的一张"。**
否则会误伤那张即将被核销的券，让「已核销样本」变成「已过期样本」。
另外 `expireCoupons()` 必须在 seed 收尾真的调一次 —— 只把 `expires_at` 推到过去、
不改状态列的话，界面上「已过期」这一态是**推导**出来的，筛选与统计都会与列表对不上。

### 8.2 会员造数：从「固定余量一次算」改为「按需追加直到跨过门槛」

早先按 `1.35 × 门槛` 一次性算目标额，在美妆库只累到 2.3 万 < 铂金 3 万门槛 → **铂金永远到不了**。
现在改成闭环：

```js
while (spentOf(customer.id) < needCents && guard < 12) {
  const gap = Math.max(1, needCents - spentOf(customer.id))
  const wantPer = Math.max(Math.round(avgPrice * 20 * 100), Math.ceil(gap * (1.5 + guard * 0.15) / 2))
  const per = Math.min(needCents, wantPer)          // 防「普通会员一单冲到银牌」
  placeOrder({ customer, amountTarget: ..., useCoupon })
  guard += 1
}
```

三个关键点：
- `Math.min(needCents, wantPer)` —— 缺了它，`avgPrice * 20` 的下限大于普通会员的目标额，
  普通会员会被一单顶成银牌；
- `/ 2` 拆细订单，让会员时间线丰满（一单冲上去的会员没有流水可看）；
- `couponFloor = ceil(min_subtotal × 1.15)` —— 用券那一单必须够得到**券门槛**，
  否则结算以 `below_min` 拒掉它。服装库券门槛 ≈ 3976 元 > 银牌目标 2000 元，真实踩到。

---

## 9. 测试与验收

### 9.1 `scripts/test-promo.mjs`：三库各 114 条断言

14 个测试域：

| 域 | 测什么 |
|---|---|
| T1 | 促销 CRUD 与草稿校验（9 类拦截） |
| T2 | **算钱顺序**：会员（原价）→ 促销（会员价）→ 积分（最终价） |
| T3 | **优惠摊到行**：行优惠合计恒等于整单优惠 |
| T4 | **`percentage` 方向探针** |
| T5 | 买赠：按件数触发、从最低单价起免 |
| T6 | **券默认不自动使用** |
| T7 | 最低价地板闸住 0 元单 |
| T8 | 独占与同组互斥 |
| T9 | 限量为防超发 |
| T10 | 会员等级：门槛是「与」、人工改级要理由且抬门槛 |
| T11 | 积分与储值：余额 = 流水 |
| T12 | 券生命周期 + **可用券门槛单位是分**（不是 ×100） |
| T13 | 结算端到端 + 撤单封顶（含 `shortfall`） |
| T14 | 解释链与列表口径 |

**可重复跑**：本轮会真的建促销、建券、发券、落单、送分、核销 —— 全部带标记，
开跑前先按标记把自己上一轮的残留删干净（子表在前）。标记：
促销 `TP-` / 券 `TC-` / 活动 `TCMP-` / 客户手机号 `199%` / 订单 remark `【TEST-PROMO】`。

为了让断言只受**被测促销**影响，全程把库里其它促销临时停用，跑完按开跑时的**状态快照逐一还原**
——而不是笼统地全设 `active`（那会改坏别人手工停用的促销）。并且挂了 `process.on('exit')` 兜底钩子：
中途抛错也要还原，否则下一轮快照到的就是"全被停用"的坏状态（真实踩到，
把 10 张演示促销永久留成 `inactive`，而之后的快照又把这个坏状态当基线）。

`clean()` 按标记删。跑完自检两件事：**测试促销残留为 0**、**既有促销状态漂移为 0**。

### 9.2 业务时刻不能用"过去的固定时刻"

```js
// 券的领取时刻是 `issueCoupons` 按真实时钟打的 —— 用过去的固定时刻当 `at`，
// 券会一律被判 `not_started`（还没发就想用）
const AT = new Date(Date.now() + 5000).toISOString().slice(0, 19).replace('T', ' ')
```

### 9.3 `verify-seed.mjs` 第 13 节：促销与会员自洽（17 条）

积分余额 = 流水合计 · 累计积分不低于正变动之和 · 积分/储值流水逐行 `balance_after` 可用窗口函数复算 ·
会员等级冗余列一致 · 促销 `used` = 使用登记数 · 行优惠合计 = 优惠留痕合计 · 留痕均指向真实订单行 ·
券四态与时间自洽 · 券发行量 = 实例数，以及**覆盖度**：四个等级都有样本、券四态都有样本、买赠 `used > 0`。

### 9.4 `smoke-api.mjs` 新增「营销域返回形状」（9 条）

> 为什么单独查**形状**：`/promo/overview` 曾经漏了一个 `.all()`，`by_level` 于是不是数组
> 而是 better-sqlite3 的 `Statement` 对象。HTTP 200、字段名也在、控制台不报错 ——
> 但前端 `by_level.map` 直接抛异常把**整页打崩**（表现是"点哪个页签都不动"）。
> 这类"形状对但类型错"的返回，只有断言到**类型**才抓得住，只看状态码是抓不住的。

断言含：`by_level` 是数组 · 计数是数字（不是 null / 对象）· `meta.levels`/`settings` 是数组 ·
等级 ≥ 4 档 · 列表返回 `{list[], total}` · **`level_code` 筛选真的生效（蛇形参数名）** · 自洽审计通过。

### 9.5 `scripts/regress-all.mjs`：全量回归跑批

本项目的回归是「21 套 `test-*.mjs` × 三库 + 4 个自检脚本 + 类型检查 + 构建」这样一组命令，
逐条手工敲有两个问题：**会漏**（最容易漏掉那些"没改到、所以觉得不用跑"的域，
而本项目出过的缺陷恰恰多是"改 A 域弄坏 B 域"）；**跑错库**（每套测试的行业参数是 `process.argv[2]`，
漏传就静默只用 cosmetic 跑一遍，输出里看不出来）。

所以脚本把「哪些测试要 × 三库」这件事**从源码里读出来**（有没有读 `process.argv[2]`），而不是靠人记。
必须**串行** —— 多个脚本并发写同一个 SQLite 会 WAL 竞争，报出来的错与真实原因无关。

```
node scripts/regress-all.mjs            # 默认 3 轮
ROUNDS=1 node scripts/regress-all.mjs   # 只跑一轮
ONLY=promo node scripts/regress-all.mjs # 只跑文件名含 promo 的（调试用）
```

---

## 10. 前端页面（`/marketing/promo`，六个页签）

菜单挂在新的「营销管理」组下，而不是「线上 OMS」—— 促销与会员是**定价与客户权益**，
门店 POS 与经销商订货同样吃这套价格与等级；挂在 OMS 下会让人以为它只管线上渠道。

| 页签 | 内容 |
|---|---|
| 总览 | 四张 KPI + **会员等级分布** + **自洽审计**九项 + 全局口径 |
| 活动 | 列表 / 新建 / 启停 |
| 促销 | 筛选分页 / 详情弹窗（优惠方式 + 三组规则 + 使用汇总）/ 新建（先校验后落库）/ 启停 / 删除 |
| 券 | 券模板（含「到期落库」）/ 券实例（券包，可按客户与状态筛）/ 发券 / 作废 |
| 会员 | 列表 / 等级权益编辑 / 详情弹窗（概览与操作 · 券包 · 积分储值流水）/ 人工调整项四项 |
| 试算器 | 购物车 + 客户与优惠 + **四段拆显示** + 行级优惠 + 券的参与情况 + 促销命中链 + 解释链 |

### 10.1 界面上钉死的五条口径

1. **算钱顺序拆成四段显示**，而不是合并成一个"优惠了多少" —— 合并之后没人看得出
   "这 30 块是会员折的还是促销减的"，退货时的退款策略也没法解释；
2. **行级优惠列表**（原价 / 会员 / 促销 / 积分 / 行应付），并当场自证「行应付合计 = 整单应付 ✓ 平」；
3. **会员流水逐行显示 `balance_after`**，配一句"余额不是真相，流水才是"；
4. **券必须显式勾选**（或显式勾选"自动选券"），默认什么都不选 = 一张都不用；
5. **券的 `type`/`value` 只作展示**，页面上直接写明"改券上的金额不会改优惠额"。

### 10.2 「券的参与情况」的措辞修正

`accepted` 的正确含义是**券码被接受**（解锁了对应促销码），**不是**"优惠已发生"——
促销还要过自己的规则（门槛 / 时间 / 用量 / 独占）。

早先把 `accepted` 直接写成「已参与」，于是页面上一处说"已参与"、
另一处命中链说"未生效：不满足适用条件"——**同一页自相矛盾**，用户只会得出"系统算错了"的结论。
现在按 `applied_codes` 交叉判定，分「✅ 已生效」与「⏳ 券码被接受但促销未生效（原因见命中链）」两种展示。

### 10.3 截图（`scripts/shot-promo.mjs`，headless Chrome + CDP，10 张）

`promo-01` 总览 · `02` 活动 · `03` 促销列表 · `04` 促销详情 · `05` 券模板 · `06` 券实例 ·
`07` 会员列表 · `08` 会员详情 · `09` 会员流水 · `10` 试算器结果。收尾做 md5 查重（同页面连拍两次会拍出逐字节相同的图）。

**这份脚本里踩到的四个坑**（都写进了注释）：

| 坑 | 表现 | 修法 |
|---|---|---|
| 点页签用全等匹配 | 页签文案后面挂着数量徽标（「促销10」），永远点不中 | 按**开头**匹配 `.tab` |
| 精确匹配与包含匹配合并后再排序 | "DOM 最小"把没有图标的「试算 + 解释链」顶到最前，压过带图标的「试算」→ 两个按钮点成同一个 | 两组**分开选**，精确组非空就只在精确组里挑 |
| 用位置索引找输入框 | 本想填「使用积分」，值落到了「搜索商品」上；积分抵扣一段永远是 0，而脚本一行报错都没有 | 按 `<label>` 文字定位，行内数量框按"同行有 `<select>`"的结构特征认 |
| 购物车金额没落在窗口里 | `AUTO_EXCLUSIVE`（独占）先命中 → 券解锁的促销被拦 → 截图只能证明"券码被接受" | 从接口读**券门槛**与**独占门槛**，动态把数量算进 `[券门槛, 独占门槛)` 区间 |

修完之后的一次实测：原价 ¥3,360 → 会员 −¥168（9.5 折）→ 促销 −¥1,177.40（4 条活动生效，
含券解锁的 `COUPON_FULL` −¥404）→ 积分 −¥8（800 分）→ 应付 ¥2,006.60，
行应付合计 = 整单应付 ✓ 平，命中链 9 条生效 / 10 条未生效且条条给出原因。

---

## 11. 本轮修掉的缺陷清单（按发现顺序）

| # | 缺陷 | 危害等级 | 根因类别 |
|---|---|---|---|
| 1 | `percentage` 的 `value` 方向反了（共 4 处） | 高（差 10 倍） | 口径在文档与代码间漂移 |
| 2 | seed 券发放时序在造单之后 | 高（整条演示线消失） | **静默少了一段** |
| 3 | 券领取时刻用真实时钟 | 高（券永远核销不掉） | 时钟口径不统一 |
| 4 | `expireCoupons` 没被调用 | 中（"已过期"只在时间列上） | 状态列与推导不一致 |
| 5 | 过期样本定位错人 | 中（误伤将核销的券） | 抽样条件写成了"id 最小" |
| 6 | 铂金等级永远到不了 | 中（覆盖度缺一档） | 固定余量的算法假设 |
| 7 | 缺 `Math.min` 把普通会员顶成银牌 | 中 | 下限大于目标额 |
| 8 | 服装库券没核销 | 中（券门槛 > 目标额） | 跨库数值差异 |
| 9 | `auditMember` 的 `totalDrift` 误报 | 低（误报） | 口径表述过严 |
| 10 | `/promo/overview` 漏 `.all()` → `by_level` 是 Statement | **高（整页白屏）** | 形状对、类型错 |
| 11 | 券门槛 `min_subtotal × 100` | 中（差 100 倍） | 单位口径重复换算 |
| 12 | 前端两处查询参数写成驼峰 | 中（筛选静默失效） | 命名约定跨层不一致 |
| 13 | 截图脚本点错按钮 / 填错输入框 / 购物车没落进窗口 | 中（交付物失真） | 自动化脚本的定位方式不可靠 |
| 14 | **`test-pricing.mjs` 把共享库的真 `promotions` 表 DROP 掉** | **高（污染整个演示库）** | 测试在共享库上做破坏性 DDL |
| 15 | **「今天」有两个来源：JS 取 UTC、SQL 取 localtime** | 中（账龄合计差一笔） | 日期口径未收敛到一处 |
| 16 | **服装库「普通会员」被"凑目标额"的购物车顶过银牌门槛**（¥2111 ≥ ¥2000） | 中（等级覆盖度缺一档） | 用"目标值"实现了"上界" |

其中 **#2 / #3 / #10 / #11 / #12 / #16** 是同一类：**没有报错，只是结果不对**。
本模块的测试与自检脚本，绝大多数篇幅是在对付这一类。

> 编号对照：本文用 #N 编号，`bugcheck-log.md` 用连续的「缺陷 N」编号。
> 本模块的 14 条内部缺陷对应 `bugcheck-log.md` 的 **缺陷三十八 ~ 缺陷五十**，
> #14 / #15 / #16 对应 **缺陷五十一 / 五十二 / 五十三**。

### 11.1 #14 / #15 / #16 是"收尾那一环"揪出来的，单模块测试永远测不到

这三条都不是做功能时想出来的，而是**把批次 F 放进全量回归、并给 `verify-seed` 补上覆盖度断言**
之后才暴露的 —— #14 / #15 还都发生在**促销域之外**。它们恰好证明了收尾三件事的必要性。

**#16 覆盖度断言上线即抓到。**

`verify-seed.mjs` 第 13 节新加的 `四个会员等级都有样本` 报 `缺 normal`，
实况 `会员账户 4 个（gold 1 / platinum 1 / silver 2）`——**普通会员这一档的样本不存在了**。
美妆与餐饮正常，只有服装库越档。

根因是**用"目标值"实现了"上界"**：

```js
// 这一档的约束是「停在下一档门槛之下」，但实现只写了"想造到多少"
const needCents = code === 'normal' ? nextUp.min_spent_yuan * 0.4 * 100 : lv.min_spent_yuan * 100
const per = Math.min(needCents, wantPer)     // ← 只压住了目标
```

而 `placeOrder` 的购物车是"凑到目标额为止"，**最后一件事必然超出目标**，
超出多少取决于客单价 —— 服装库一件就顶几百元，于是普通会员的累计消费做到 **¥2111 ≥ 银牌 ¥2000**。

这正是缺陷 #44（"缺 `Math.min` 把普通会员顶成银牌"）的**复发**：
#44 的修法是把**目标值**压小，而目标值管的是"停在哪"，管不住"冲过头"。
所以正确的修法是给 `placeOrder` 加**硬天花板** `ceilingCents`（凑目标额可以超出，但绝不允许把货值撑过它），
由调用方按"下一档门槛 × 0.6"传入。好处是这条约束从此**可证明**：

```
payable ≤ 货值 ≤ hardCap(0.6 × 下一档门槛) < 下一档门槛
```

> 教训：**"目标值"和"上界"是两种约束，别用前者实现后者。**
> 凡是"某个样本必须停在某条线以下"的造数，都要有一个**能证明**的上界，
> 而不是"目标调小一点、应该不会超"。
> 这条同时说明：**覆盖度断言必须真的存在** —— 这个缺陷从第一天就在库里，
> 界面上只表现为"会员列表少了普通会员"，没有任何报错，
> 也没有任何"数值自洽"类断言能发现它。

**#14 `test-pricing.mjs` 把共享库的真表删了。**

该脚本的 T8 要验证「取价引擎探测 `promotions` 的列形状」，
于是直接 `db.exec('DROP TABLE promotions')` —— 但那句 DDL 落在一个**共享的演示库**上，
而 `promotions` 正是模块 18 的真表。连锁反应有三层，一层比一层远：

```
① 同一轮里后跑的 test-promo [cosmetic]           → no such table: promotions
② 服务下次启动 initSchema 把空表补回来，
   而 promotion_campaigns 没被动过                 → seedPromo 以为"库里没促销"照常重灌
                                                    → DUPLICATE_CODE: CMP_AUTUMN
③ smoke-api 起不来（服务 240s 未就绪），
   报错信息是「活动编码已存在」，
   与真实原因（一个取价测试删了别人的表）毫无关系
```

修法用的是 SQLite 的**事务性 DDL**：把「删真表 → 造两种假形状 → 取价 → 删假表」
整段包进 `BEGIN` / `ROLLBACK`，真表连同数据一字不差地还回来。
并补了两条**还原自检**（`promotions` 表在、行数 > 0）——
因为「库被改坏」这件事**只有当轮的测试通过不了才会被发现**，
而下一轮的报错点会在完全无关的地方。

> 教训：**测试在共享库上做破坏性 DDL，等于让测试去改别人的现场。**
> 要么在事务里做并回滚，要么在副本上做。这条与"整库重建要可复现"是同一族：
> **测试必须对现场零副作用**。

**#15 「今天」有两个来源。**

`lib/ar.js::aging()` 用 `new Date().toISOString().slice(0,10)` 算「今天」，
取的是 **UTC 日期**；而 `v_ar_aging_detail` 视图用 `date('now','localtime')`。
东八区在**本地 00:00–08:00** 之间，UTC 还没跨日 —— 每天都有这八小时。

后果：一张**本地今天到期**的应收单，在逐笔账龄里算未逾期、在汇总账龄里算逾期。
两个入口都 200、字段名都在、行数一样，**只是合计差一笔**：

```
aging.overdue            = 100000.96
agingDetail.total_overdue = 100083.28     差值 82.32 = 那一笔的余额
```

修法不是"把这一处改掉"，而是**把日期收敛成一个出处**：
新增 `server/lib/dates.js`（`localDate` / `localNow` / `addDays` / `diffDays`），
并把 `server/lib/**` 与 `server/routes/**` 里**凡是从「现在」派生日期**的地方全部改过去。

同一族一次扫出 6 处（详见 `bugcheck-log.md` 缺陷五十二），其中三处是**独立重犯**：

- `lib/credit.js::addDays` 与 `lib/quote.js::addDays` 各自实现了一份日期加法，
  都带着 `toISOString()` 的老毛病 → **每个账期 / 每份报价有效期都短一天**；
- `lib/docflow.js::nowText` 的注释写着"替代 `datetime('now','localtime')`"，
  实现却是 `toISOString()` → 流转留痕比单据时间早 8 小时，界面「流转时间」对不上；
- `lib/pos2.js` 五处门店业务日同样是 UTC → 凌晨开店，班次 / 日结 / 退货 / 盘点
  的业务日全部落到**昨天**，日结里找不到今天的班次。

> 教训：**「一个出处」这条规则对时间同样成立。**
> 本项目早就为「灌数时钟」立过这条规矩（`db/seed-clock.js`），
> 但「业务日」这一层有至少六份手写实现，而它们**全都不会报错**——
> 只是在每天凌晨那八小时里安静地少算一天。

---

## 12. 与其它模块的关系

| 模块 | 关系 |
|---|---|
| 05A 价格中心 | 促销域与取价引擎**共存但互不越界**：取价回答"卖多少钱"，促销回答"再减多少"。`pricing.js` 改为按列形状探测，两者可共存（3.4） |
| 09 存货核算与成本 | 优惠**不影响成本**。行优惠只改应收，不改出库成本口径 —— 成本恒等式里的"出"仍按原价结转 |
| 21 应收与收款核销 | 促销优惠减少应收发生额，两者在 `settlement` 口径上对齐 |
| 24 销售发票 | 开票金额以**优惠后**的应付为基准 |
| 17 门店 POS | POS 与商城共用同一套促销引擎与会员等级（这也是「营销管理」独立成组的原因） |
| 12A 订货中心 / 26 渠道协议价 | 经销商走**协议价**（模块 26），与面向消费者的促销是两条线，不叠加 |

---

## 13. 已知边界与下一步

**边界（本模块不做）**

1. **不做优惠券的转赠与分享** —— 券实例与客户是 1:1 绑定，转赠需要"券码重签"与风控，属下一批；
2. **不做积分有效期** —— 积分只增不减（除抵扣与撤单回退），有效期需要批量过期任务与"先过期哪一批"的口径；
3. **不做跨渠道促销隔离** —— 促销目前不区分渠道，POS 与商城共享；要隔离需要给 `promotions` 加渠道维度；
4. **不做促销审批流** —— 促销的启停直接生效，没有接审批内核（模块 22 已具备，接入成本低）；
5. **`promotion_campaign_budgets`（活动预算）只有表，没有消耗逻辑** —— 预算是"活动级别"的额度，
   需要与 `promotion_adjustments` 逐日汇总结转，属下一批。

**下一步（批次 G / H 相关）**

- 批次 G：DMS 渠道协议价 + 返利核销闭环（模块 26）—— 经销商侧的"价格与返利"是另一条独立的线，
  本模块的 `promotion_adjustments` 留痕口径可以复用；
- 批次 H：业财一体凭证（模块 027）—— 促销优惠在凭证上如何入账（销售折让 / 销售费用），
  需要把 `promotion_adjustments` 按 `promotion_id` 汇总成一张凭证行来源。

---

## 附：文件清单

```
server/db/migrations/025_promo_member.cjs     532 行   14 表 + 1 视图 + 4 权限 + 4 设置 + 4 等级
server/db/promo-seed.js                       479 行   2 活动 / 10 促销 / 3 券模板 / 4 会员
server/lib/promotion.js                      1000 行   引擎 + CRUD + 校验 + 解释链
server/lib/member.js                          745 行   等级 / 积分 / 储值 / 两本流水 / 对账
server/lib/coupon.js                          586 行   模板 / 实例 / 校验 / 核销 / 退回 / 过期 / 作废
server/lib/checkout.js                        480 行   quote / settle / unsettle / 分摊
server/routes/promo.js                        648 行   40 端点（36 后台 + 4 C 端）
src/api/promo.ts                              483 行   前端接口层 + 类型 + 展示辅助
src/pages/marketing/PromoCenter.tsx          1725 行   六个页签
scripts/test-promo.mjs                        640 行   三库各 114 条断言
scripts/shot-promo.mjs                         ~430 行  10 张截图 + md5 查重
scripts/regress-all.mjs                        ~180 行  全量回归跑批
```
