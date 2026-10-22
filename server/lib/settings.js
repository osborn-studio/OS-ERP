/**
 * ============================================================================
 * 文件标识：server/lib/settings.js ｜ 配置（settings）的唯一出处（批次 R）
 * ============================================================================
 * 【职责】配置（settings）的唯一出处（批次 R）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 配置（settings）的唯一出处（批次 R）
//
// ===========================================================================
// 一、这一批补的是「配置改了，但没人知道它改过」
// ===========================================================================
// `settings` 表从模块 20 起就在长：应收口径、备份目录、促销积分、积分抵扣上限、
// 门店长短款阈值、默认税率、结转目标科目、年结留存科目…… 十几个键。
// 但它的写入路径只有一条、且**什么都不做**（`routes/meta.js` 的 `PUT /settings`）：
//
//     INSERT INTO settings (key,value,updated_at) VALUES (?,?,...)
//       ON CONFLICT(key) DO UPDATE SET value=excluded.value, ...
//
// 于是 `settings.closing_profit_subject`（期末结转到哪个科目）被从 4103 改成别的，
// 事后没人答得出「谁改的、什么时候、原来是什么、为什么」—— 而那是**会计政策**。
//
// 这一批要做两件事，而它们是同一件事的两半：
//   · **把配置项的集合定死**（本文件的 `SETTING_RULES`）；
//   · **对它的每一次变更留痕**（`setting_audit_log`，只追加，可重放）。
//
// ===========================================================================
// 二、为什么必须先把「集合」定死 —— 摸底时查出的四个真实缺口
// ===========================================================================
// 只加一张日志表是没用的：一天之后它就会退化成一个"只有界面点过的那些键才有历史"的表。
// 摸底时逐条读了全部读取点，查出四件事：
//
//   ① **同一个键，四处各写一遍默认值**。
//      `credit.js` / `quote.js` / `member.js` / `pos2.js` 各带一个 `setting()` 私有函数，
//      每份都有自己对"读到了但值不合法"的理解：
//        · `quote.js` 要求 `Number.isFinite(v) && v > 0`；
//        · `member.js` 不要求（`promo_points_per_yuan` 配成 0 会直接除零，
//          它在**另一个地方**单独兜了一次）；
//        · `credit.js` 连数值都不转，原样返回字符串，由调用方自己 `Number(...)`；
//        · `pos2.js` 要求 `n >= 0`。
//      同一个键被四套规则解释 —— 这就是「同一份判据有两个实现」的老账。
//
//   ② **三个"幽灵配置"**：代码读它、库里没有、界面看不到、改了也不生效。
//        · `credit.overdue_block_days`（逾期多少天开始硬拦截）
//        · `quote.approval_amount`（报价触发审批的金额阈值）
//        · `quote.valid_days`（报价有效期天数）
//      它们带着**点号命名**，与其余键的下划线风格不一致 —— 说明它们是在一个
//      "随手加个开关"的下午被写进代码的，从来没人给它们在库里落过位。
//      表现是：**功能看起来可配，实际不可配**（读不到就永远走默认）。
//
//   ③ **一个"登记了但没人读"的配置**：`ar_prepay_auto`。
//      挪到这份定义表里并标成 `wired: false`，让"登记了但还没接上"看得出来 ——
//      与 `lib/period-audit.js` 的 `meta()` 给动作标 `implemented` 同一条理由。
//
//   ④ **配置的"定义"散在四处**：020 迁移里一份 `[key, value, 说明]` 数组、
//      `docs/` 里一份表格、各模块代码里一份常量、`scripts/db-backup.mjs` 又直接写
//      SQL 读一遍。四份定义迟早只改一处。
//
// 所以本批的口径是：**`SETTING_RULES` 是全项目唯一的「配置定义」，
// 未登记的键不许写入**（`SETTING_UNKNOWN`）。这比"允许写任意键"更严，
// 但它换来一条可验证的不变量：**库里的键集合 == 登记表里的键集合**（探针守它）。
//
// 保留原名不改（`credit.overdue_block_days` 也照旧带点）—— 改名会**改变行为**
// （如果谁的库里手工插过那个键，改名之后它就失效了）。命名不统一是**如实记的代价**，
// 不在这批消化。
//
// ===========================================================================
// 三、为什么留痕要"可重放"（而不是只记一条流水）
// ===========================================================================
// 与批次 Q 的期间审计链完全同构：`settings` 表上的行是**现状指针**，
// `setting_audit_log` 是**历史事实**（只追加）。两者的关系是一条不变量：
//
//     从空状态开始，按 id 顺序应用每一条日志，得到的必须是今天库里的样子。
//
// 两条路径的**出处不同**（现状来自各处的 `INSERT ... ON CONFLICT`，历史来自
// `logSettingChange`），所以它抓得到"改了没记""记了没改"。
// 盲区同样要划清：它抓不到"有人既没改也没记" —— 而那种情况在配置上**不存在**
// （配置没有"状态"，只有值），所以不需要像期间那样再补一条"凭证表"式的第三路径。
//
// ===========================================================================
// 四、基线：`ensureSettings` 是配置的初始化入口，也是基线的唯一出处
// ===========================================================================
// 迁移 038 **只建表**，不碰 `settings`。配置的初始化（补齐登记表里登记、
// 库里还缺的键 + 给"有值但无历史"的键补一条 `baseline`）统一由 `ensureSettings` 做。
//
// 为什么不像 037 那样把基线写在迁移里？因为两者的"驱动"不同：
//   · 期间的状态是被**动作**驱动的（关账/结转/年结），迁移只能"按现状补记"；
//   · 配置没有驱动者 —— 它在**库建起来的那一刻**就该是完整的。
// 把初始化写成运行时的一个入口，好处是**升级路径与重建路径走同一条代码**：
//   · 升级既有库：迁移建表 → 服务启动 `ensureSettings` → 补基线；
//   · 整库重建：`resetDatabase()` 把 settings 与日志表一起 DROP（两个都在清理清单里）
//     → 迁移自愈重灌 settings → `ensureSettings` 补基线。
// 两条路径的产物完全一致（这正是 `docs/evidence` 里那两个指纹要证明的事）。
//
// `ensureSettings` 内部走 `logSettingChange`（全项目唯一的 INSERT），
// 所以"唯一写入点"这条口径在初始化路径上也成立。
//
// ===========================================================================
// 五、危险配置：改它必须说得出为什么
// ===========================================================================
// `is_danger: true` 的键（会计政策 / 应收口径 / 门店自结阈值）改动时**必须写理由**，
// 与"撤销一个已定稿的动作"同一个道理：这类改动会改变**已经结出来的账**的解释。
// 判据在 `SETTING_RULES[x].is_danger`，调用方只报"我改了什么"。

export class SettingError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // 与 `lib/report.js` 的 `ReportError`、`lib/period-audit.js` 的 `PeriodAuditError`
    // 同一条：HTTP 层只认 `.status`
    this.status = http
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 一、配置定义表 —— **全项目唯一的「配置定义」**
// ---------------------------------------------------------------------------
/**
 * 字段含义：
 *   · `group`    —— 界面上按它分组（也是唯一出处，界面不自己分类）；
 *   · `label`    —— 中文名；
 *   · `type`     —— `text` / `subject` / `enum` / `int` / `number` / `bool`。
 *                   决定**值的形态**与**校验规则**（两者必须是同一出处，
 *                   否则"允许写进去"与"读出来能用"会分叉）；
 *   · `default`  —— 库里缺这个键时 `readSetting` 返回它，也是 `reset` 的目标值；
 *   · `is_danger`—— 改动必须写理由（见文件头第五节）；
 *   · `enum`     —— `type='enum'` 时的取值域；
 *   · `min` / `max` / `gt` —— 数值域（`gt` = 严格大于，用于"不能是 0"这类）；
 *   · `wired`    —— 当前代码里**有读取点**。`false` 表示登记了但还没接上；
 *   · `impact`   —— 一句话说明"改了会发生什么"，直接给界面显示。
 *
 * 顺序即界面顺序（`Object.entries` 保序）。**默认值必须与本批之前的实际默认值一致** ——
 * 这一批只收敛口径，不改行为。
 */
export const SETTING_RULES = {
  // ---- 会计政策（危险：改它会改变已结出来的账怎么解释） ----
  closing_profit_subject: {
    group: 'finance', label: '期末结转目标科目', type: 'subject', default: '4103', is_danger: true, wired: true,
    impact: '期末把损益类（6xxx）余额结转到哪个科目。改成别的科目后，历史结转凭证仍指向原科目，报表口径会与既往不一致。'
  },
  annual_retained_subject: {
    group: 'finance', label: '年度结转留存款科目', type: 'subject', default: '4104', is_danger: true, wired: true,
    impact: '年结时"本年利润"往哪个权益科目结转。改它会让已年结年度的余额构成无法与新年度的口径衔接。'
  },
  voucher_default_tax_rate: {
    group: 'finance', label: '默认税率（%）', type: 'number', default: '13', is_danger: true, wired: true,
    min: 0, max: 100,
    impact: '凭证模板做价税拆分时的缺省税率。它不影响已生成的凭证（税率在生成时就落进分录了）。'
  },
  'fiscal.start_month': {
    group: 'finance', label: '会计年度起始月', type: 'int', default: '1', is_danger: true, wired: true,
    min: 1, max: 12,
    impact: '报表的**年初边界**：本年累计、同比累计都从这一月起算（1 = 自然年）。'
      + '改它会让同一份账在不同期间算出不同的"本年累计"——这是报表口径变更，必须写理由。'
      + '⚠️ 年结与利润分配只在起始月为 1 时可用（跨自然年的年结未实现），改成非 1 月后年结会被明确拒绝。'
  },

  // ---- 应收口径（危险：直接决定应收单从哪来） ----
  ar_source_of_truth: {
    group: 'ar', label: '应收生成口径', type: 'enum', default: 'SO', is_danger: true, wired: true,
    enum: [{ value: 'SO', label: '按销售订单' }, { value: 'SI', label: '按销售发票' }],
    impact: '应收单在哪个环节成立：订单确认时，还是发票开出时。切换口径后，两种口径下已生成的应收单不会互相迁移。'
  },
  ar_oc_enabled: {
    group: 'ar', label: '订货单收货并入应收', type: 'bool', default: '1', is_danger: true, wired: true,
    impact: '订货单在「确认收货」时是否自动并入应收（收款权成立）。关掉它，订货单收款只能手工登记。'
  },
  ar_prepay_auto: {
    group: 'ar', label: '预收自动抵新应收', type: 'bool', default: '0', is_danger: false, wired: false,
    impact: '预收款是否在产生新应收时自动核销。**当前代码里没有读取点**（登记待接），改动暂不生效。'
  },

  // ---- 促销与会员 ----
  promo_points_per_yuan: {
    group: 'promo', label: '每元得积分', type: 'number', default: '10', is_danger: false, wired: true,
    gt: 0,
    impact: '消费 1 元得多少基础积分。配成 0 或负数会让积分恒为 0（本表直接拒绝）。'
  },
  promo_points_per_yuan_deduct: {
    group: 'promo', label: '抵扣 1 元所需积分', type: 'number', default: '100', is_danger: false, wired: true,
    gt: 0,
    impact: '抵扣 1 元需要多少积分。配成 0 会让抵扣计算除零（本表直接拒绝）。'
  },
  promo_points_deduct_max: {
    group: 'promo', label: '积分抵扣上限（万分比）', type: 'number', default: '5000', is_danger: false, wired: true,
    min: 0, max: 10000,
    impact: '单笔订单积分抵扣金额占订单金额的上限，万分比。'
  },
  member_upgrade_auto: {
    group: 'promo', label: '会员等级自动升降', type: 'bool', default: '1', is_danger: false, wired: true,
    impact: '结算后是否按规则自动重判会员等级。关掉后只能人工改等级。'
  },

  // ---- 门店 ----
  pos_variance_limit: {
    group: 'pos', label: '交班长短款容忍阈值（元）', type: 'number', default: '500', is_danger: true, wired: true,
    min: 0,
    impact: '长短款绝对值超过它，门店不能自行交班（需上级确认）。放大它等于放宽门店的资金差错容忍度。'
  },

  // ---- 供应链参数（客户口径：仓库与出入库的口径要能自己设） ----
  // ⚠️ 这两条**原来在 `inv_params` 表里**（迁移 003 的 `negative_stock` + 004 的
  // `allow_negative_for`），读取点是 `lib/stock.js` 的 `applyStockOut`。
  // 现在把判据收到本表：**唯一出处** —— 一份口径两个存储的下场是
  // "改了配置中心不生效、改了库没人知道"，而它管的是**账实是否一致**。
  inv_allow_negative: {
    group: 'inv', label: '允许负库存', type: 'bool', default: '0', is_danger: true, wired: true,
    impact: '打开后，出库数量可以超过该仓该批次的可用库存（结存转负）。'
      + '**默认关** —— 与本次改动之前的实际行为一致（原来 `inv_params.negative_stock=0`）。'
      + '⚠️ 它不是"总开关就够"：还要明细分行的来源（source）等于「负库存例外来源」才会放行，'
      + '两者都满足才走负库存（这是原来的口径，未改）。打开它会让账实可能出现负结存，改动必须写理由。'
  },
  inv_allow_negative_for: {
    group: 'inv', label: '负库存例外来源', type: 'text', default: 'pos_offline', is_danger: true, wired: true,
    impact: '只有明细行的来源等于这个字符串时才允许超发（默认 `pos_offline` = POS 离线补单）。'
      + '留空表示**不设例外**（任何来源都不放行，与本次改动前的默认一致）。'
      + '来源取值由各业务入口自己写（`web` / `pos_offline` / `mcp` 等），不是枚举。'
  },
  inv_doc_warehouse_scope: {
    group: 'inv', label: '单据类型允许仓库', type: 'text', default: '*', is_danger: true, wired: true,
    impact: '按单据类型限定"这一单能用哪个仓"（最高层设计 §7.1：某一类单据进客户指定的仓库）。'
      + '格式：`单据类型=仓编码|仓编码;单据类型=仓编码`，例如 `PUR_IN=WH01|WH02;SAL_OUT=WH03`。'
      + '**`*` = 不限（默认，= 上线前的实际行为）**；没在配置里出现的单据类型也 = 不限。'
      + '单据类型的取值域与出入库单据类型码（`inv_txn_types.code`）同一套。'
      + '⚠️ 仓编码的大小写不敏感（都按大写比）；值不能为空 —— 要清空请点「恢复默认值」。'
      + '⚠️ 写法不对时**不放行任何单据**（响亮拒绝），因为放行等于静默忽略客户配的限制。'
      // 语义边界（有意如此，别当成漏了）：它只约束**用户选仓的入口**。
      // **系统自动决定的仓不受它约束** —— 最典型的例子是质检处置（让步接收 / 返工）自动生成的那张
      // 调拨单，目标仓是系统按 `DISPOSITION_TARGET` 定的隔离仓，**不是用户选的**。
      // 若把它也纳进这条白名单：客户配一个 `TR_IN=WH01`（想把调拨都收在总仓），
      // 就会把**系统自动流程**一起拦死 ⇒ 处置做不下去，而客户根本没打算限制它。
      + '⚠️ 它只约束**人选的仓**；**系统自动决定目标仓的流程（如质检处置自动调拨到隔离仓）不受它约束**。'
      // 显式代价：这条配置的正确性**依赖一条不变量**（这也是为什么它按编码存、而不是按 id 存）。
      // 依赖不写下来，就是没人管的假设 —— 将来谁把"编码不可改"松开（或直接改库），
      // 这条限制会**静默失配**：限制生效在一个客户没选的仓上，而两边都不会报错。
      // 守着那条不变量的断言在 `routes/warehouses.js`（`WAREHOUSE_CODE_IMMUTABLE`），这里写明依赖关系。
      + '⚠️ 本配置按**仓库编码**存 —— 它依赖「**仓库编码不可改**」（改仓接口对该字段报 `WAREHOUSE_CODE_IMMUTABLE`）。'
      + '若将来允许改编码，本条会**静默失配**（限制落到别的仓上），届时必须一起改这里与那条不变量。'
      // 粒度陷阱（写下来，否则客户会踩）：单据类型是**通用码**时，一个码被多种业务共用。
      // 实测例子：`TR_IN` 同时是"正常调拨入库 / 门店铺货入库 / 质检处置自动调拨入库"写的事务类型码。
      // 给这种码配白名单 ⇒ **所有**用它的业务一起被锁，而客户以为只限制了其中一种。
      // 当前实现**没有**"按业务再细分"的维度 —— 要细分，得先把键升成复合粒度（`TR_IN:qc_disposition=…`）。
      // 这条是 fix-disp 在验收时提出的技术反对（粒度不匹配），结论是"先不接、把陷阱写明"。
      + '⚠️ **粒度提醒**：单据类型是**通用码**时会**被多种业务共用** —— 例如 `TR_IN`/`TR_OUT`（调拨）同时被'
      + '「正常调拨 / 门店铺货 / 质检处置自动调拨」写；`ADJ_IN`/`ADJ_OUT`（盘点）同理。'
      + '给这类码配白名单会把**用同一个码的所有业务一起限制**（如 `TR_IN=QC01|QC02` 会把"所有调拨入库"都锁到隔离仓）。'
      + '当前版本**没有**"按业务再细分"这一维度；要只限制某一类业务，必须先给本键加一层复合粒度'
      + '（形如 `TR_IN:业务码=仓编码`），**不要拿通用码硬配**。'
  },
  // 采购退货**是否抵减结算**（客户 2026-10-17 口径：「退货是否递减这种你都可以做到供应链设置里，
  // 客户选择是，就递减，不设就不抵，这个供应链设置可以全局覆盖」）。
  //
  // 为什么它必须是一条**配置**而不是一个写死的实现：本批之前的行为是「不抵减」——
  // 退货既不生成凭证（本轮已补 `purchase_return` 模板）、也不进结算，
  // 于是 `buildSettlement` 算出来的应结金额**含退货虚高**。而"要不要抵、怎么抵"
  // （按单抵 / 按期间抵 / 已审结算是否追溯）在会计上**三种都合法**，
  // 取决于客户与供应商的实际约定 —— 这是**业务规则**，不是实现细节。
  // 写死任何一种是替客户做决定；而"停下来等客户拍"会让整条链卡住。
  // ⇒ 做成配置：**默认关（= 上线前的实际行为）**，客户选"是"才生效。
  //
  // ⚠️ 键名不带 `inv_` 前缀是**有意**的：分组（`group`）只是**界面归类**，
  // 键名按**业务域**命名。本键管的是采购结算，不属于"库存口径"，
  // 硬套 `inv_` 会让后来人以为它影响库存数量。
  purchase_return_offset: {
    group: 'inv', label: '采购退货抵减结算', type: 'bool', default: '0', is_danger: true, wired: true,
    impact: '**打开**：生成采购结算单时，把「同供应商、同期间内**已确认/已完成**的采购退货」从应结金额里抵减，'
      + '并在结算明细里记 `source_type=return` 的**负数行**，单头 `return_amount` 记抵减总额（存正数）。'
      + '**关闭（默认）**：退货不参与结算 —— 与本次改动之前的实际行为一致。'
      + '⚠️ **关掉不等于"没有退货"**：只是"退货不抵减"。此时台账上的"未付"含退货虚高，'
      + '`GET /api/purchase/payables` 的 `returns` 块会把这块**披露出来**（看得见，只是不自动扣）。'
      + '⚠️ **一单一结**：一张退货单只能被一张**未作废**的结算单引用（与入库单同一条规则），'
      + '所以关掉再打开、或反复生成，都不会抵两次。'
      + '⚠️ **不追溯**：只对**新建**的结算单生效。已生成（含已审/已付）的结算单一律不动 —— '
      + '给已付过款的结算单补一笔抵减，会让账上多出一笔"退过但没记账"的钱，而两边都不报错。'
      + '⚠️ 抵减后应结金额**不允许为负**：算出来是负数时整张结算单**拒绝生成**（`PST_RETURN_OVERFLOW`），'
      + '不静默截成 0 —— 那会把"退得比进的多"这件事藏起来，而那是一条真实的业务信号。'
  },

  // ---- 报价 ----
  'quote.approval_amount': {
    group: 'quote', label: '报价审批金额阈值（元）', type: 'number', default: '200000', is_danger: false, wired: true,
    gt: 0,
    impact: '整单金额达到它就需要走报价审批。'
  },
  'quote.valid_days': {
    group: 'quote', label: '报价有效期（天）', type: 'int', default: '30', is_danger: false, wired: true,
    gt: 0,
    impact: '新建报价单时的默认有效期天数。'
  },

  // ---- 信用 ----
  'credit.overdue_block_days': {
    group: 'credit', label: '逾期几天开始硬拦截', type: 'int', default: '30', is_danger: false, wired: true,
    min: 0,
    impact: '应收逾期超过它，该主体的新单会被硬拦截。配成 0 表示一逾期就拦。'
  },

  // ---- 运维 ----
  backup_dir: {
    group: 'ops', label: '备份输出目录', type: 'text', default: 'data/backups', is_danger: false, wired: true,
    impact: '`scripts/db-backup.mjs` / `db-reset.mjs` 的备份目录：绝对路径原样用，相对路径落在 GML_DATA_DIR 内（旧值 data/backups 等价于 backups；ADR-0009）。'
  },
  backup_keep: {
    group: 'ops', label: '每库保留备份份数', type: 'int', default: '10', is_danger: false, wired: true,
    gt: 0,
    impact: '备份数超出它时按时间清理最旧的（只清本工具命名规则生成的文件）。'
  }
}

/** 分组的中文名与顺序（界面按它渲染）。分组清单同样是唯一出处。 */
export const SETTING_GROUPS = [
  { key: 'finance', label: '会计政策', note: '改动会改变已结出来的账怎么解释（含会计年度边界）—— 修改必须写理由' },
  { key: 'ar', label: '应收口径', note: '决定应收单从哪来、什么时候成立' },
  { key: 'promo', label: '促销与会员', note: '积分与等级的换算口径' },
  { key: 'pos', label: '门店', note: '交班与资金差错' },
  { key: 'inv', label: '供应链参数', note: '仓库与出入库的库存口径 —— 改它会动账/动库存行为，修改必须写理由' },
  { key: 'quote', label: '销售报价', note: '报价的审批与有效期' },
  { key: 'credit', label: '信用控制', note: '逾期拦截' },
  { key: 'ops', label: '运维', note: '备份等本地工具参数' }
]

/** 全部登记键（顺序 = 定义表顺序） */
export const SETTING_KEYS = Object.keys(SETTING_RULES)

/**
 * 配置变更动作。**全项目唯一的「动作 ↔ 效果」定义**（与 `PERIOD_ACTIONS` 同构）。
 *
 * 三种动作的**效果都是"把 key 设成 `value_after`"**，那它们为什么要分开？
 * 因为在审计里它们回答的是**不同的问题**：
 *   · `baseline` —— "这个键在我们开始记日志之前是什么"（不是任何人的动作）；
 *   · `set`      —— "谁把它改成了什么"；
 *   · `reset`    —— "谁把它恢复成了默认值"（与"手工填了一个恰好等于默认值的值"是两件事：
 *                   前者会在默认值变更时跟着变，后者不会）。
 * 三态必须能分开，否则"恢复默认"与"改成了默认值"在日志里长得一模一样。
 */
export const SETTING_ACTIONS = {
  baseline: { label: '基线（初始化时现状快照）', effect: { write: 'snapshot' } },
  set: { label: '修改配置', effect: { write: 'value' } },
  reset: { label: '恢复默认值', effect: { write: 'default' } }
}

/** 键的定义；未登记返回 null */
export const settingDef = (key) => SETTING_RULES[key] || null

// ---------------------------------------------------------------------------
// 二、值的形态：一处转型 + 一处校验
// ---------------------------------------------------------------------------
/** 把任意输入归一到"落库的字符串形态"。
 *  **这是值进入 `settings` 的唯一入口**（`writeSetting` 与 `resetSetting` 都走它）。 */
export function normalizeSettingValue(def, raw) {
  if (!def) throw new SettingError('SETTING_UNKNOWN', `未登记的配置键：${raw}`, 400)
  if (raw === null || raw === undefined) {
    throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」不能为空`, 400, { key: null })
  }
  const s = String(raw).trim()
  switch (def.type) {
    case 'bool': {
      const low = s.toLowerCase()
      if (['1', 'true', 'yes', 'on'].includes(low)) return '1'
      if (['0', 'false', 'no', 'off', ''].includes(low)) return '0'
      throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」只能是开(1)或关(0)，收到「${s}」`, 400, { received: s })
    }
    case 'enum': {
      const hit = (def.enum || []).find((e) => e.value === s || e.label === s)
      if (!hit) {
        throw new SettingError(
          'SETTING_VALUE_INVALID',
          `配置「${def.label}」的取值必须是 ${(def.enum || []).map((e) => `${e.value}(${e.label})`).join(' / ')}，收到「${s}」`,
          400, { received: s }
        )
      }
      return hit.value
    }
    case 'int': {
      if (!/^-?\d+$/.test(s)) {
        throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」必须是整数，收到「${s}」`, 400, { received: s })
      }
      const n = Number(s)
      assertRange(def, n)
      return String(n)
    }
    case 'number': {
      const n = Number(s)
      if (!Number.isFinite(n)) {
        throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」必须是数字，收到「${s}」`, 400, { received: s })
      }
      assertRange(def, n)
      return String(n)
    }
    case 'subject': {
      // 会计科目编码：纯数字串。不校验"科目是否存在" —— 那是 `lib/closing.js` 的职责
      // （它会在实际结转时给出 `CLOSING_SUBJECT_NOT_FOUND` 并把人话指过来）。
      // 在这里查一次 exist 会把"配置能不能存"与"科目建了没"两个问题搅在一起。
      if (!/^\d{3,}$/.test(s)) {
        throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」必须是科目编码（纯数字），收到「${s}」`, 400, { received: s })
      }
      return s
    }
    default: {
      if (!s) throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」不能为空`, 400, { received: s })
      return s
    }
  }
}

function assertRange(def, n) {
  if (def.gt !== undefined && !(n > def.gt)) {
    throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」必须大于 ${def.gt}，收到 ${n}`, 400, { received: n })
  }
  if (def.min !== undefined && n < def.min) {
    throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」不能小于 ${def.min}，收到 ${n}`, 400, { received: n })
  }
  if (def.max !== undefined && n > def.max) {
    throw new SettingError('SETTING_VALUE_INVALID', `配置「${def.label}」不能大于 ${def.max}，收到 ${n}`, 400, { received: n })
  }
}

/** 库里存的字符串 → 代码用的类型化值。`readSetting` 的转型内核。 */
export function castSettingValue(def, stored) {
  const s = stored === null || stored === undefined ? null : String(stored)
  if (s === null || s === '') return def.type === 'bool' ? def.default === '1' : castDefault(def, def.default)
  switch (def.type) {
    case 'bool': return s === '1' || s.toLowerCase() === 'true'
    case 'int': case 'number': {
      const n = Number(s)
      return Number.isFinite(n) ? n : castDefault(def, def.default)
    }
    case 'enum': return (def.enum || []).some((e) => e.value === s) ? s : def.default
    default: return s
  }
}

function castDefault(def, d) {
  switch (def.type) {
    case 'bool': return d === '1'
    case 'int': case 'number': return Number(d)
    default: return d
  }
}

// ---------------------------------------------------------------------------
// 三、唯一读取点
// ---------------------------------------------------------------------------
/**
 * 读一个配置。**全项目唯一的读取点** —— 各模块不再各写一份 `setting()`。
 *
 * 三件事一起做，它们必须在一起（否则又是"同一份判据两个实现"）：
 *   ① 走 `SETTING_RULES` 拿定义与默认值；
 *   ② 转型（bool → boolean / int → number）；
 *   ③ **值不合法时回落默认值**（不是抛错）——读路径要能容错，否则一个配错的键
 *      会让整个模块在运行时炸；而不合法的**事实**由探针 `SETTING_VALUE_INVALID` 报出来。
 *
 * `@param db` / `@param key` / `@param fallback` 可覆盖默认值（只给测试与极端兼容场景用；
 * 业务代码不该传它 —— 传了就是在本表之外又定义了一个默认值）。
 */
export function readSetting(db, key, fallback) {
  const def = SETTING_RULES[key]
  if (!def) {
    // 读一个未登记的键：宁可炸，也不要安静地返回一个"某个默认值" ——
    // 那正是 `credit.overdue_block_days` 那三个幽灵配置的成因。
    throw new SettingError(
      'SETTING_UNKNOWN',
      `读取了未登记的配置键「${key}」。配置必须在 lib/settings.js 的 SETTING_RULES 里登记（新增配置时在同一处登记默认值与值域）`,
      500, { key }
    )
  }
  let row = null
  try {
    row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
  } catch {
    /* settings 表还没建出来时（极早期启动）按默认值处理 */
  }
  const base = fallback === undefined ? def.default : fallback
  if (!row) return castDefault(def, base)
  try {
    return castSettingValue(def, normalizeSettingValue(def, row.value))
  } catch {
    // 库里存了一个不满足值域的值（有人直接改库，或者值域在本批收紧了）。
    // 读路径**不抛**，回落默认值；不合法这件事由探针报。
    return castDefault(def, base)
  }
}

/** 库里有没有这个键（与 `readSetting` 回落到默认值是两件事） */
export function settingRow(db, key) {
  try {
    return db.prepare('SELECT key, value, updated_at FROM settings WHERE key=?').get(key) || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// 四、唯一写入点
// ---------------------------------------------------------------------------
/**
 * 写一条配置变更日志。**全项目唯一**的写法（只有一个 INSERT），
 * 与 `lib/period-audit.js` 的 `logPeriodChange` 同构。
 *
 * 三条约定都会被**当场断言**（不是文档里的建议）：
 *   ① 必须在事务里 —— 日志与改值同生共死，否则会出现"值改了、日志没写"；
 *   ② `action` 必须是 `SETTING_ACTIONS` 里的名字；
 *   ③ 危险配置（`is_danger`）的 `set` / `reset` 必须带 `reason`。
 *      `baseline` **不需要**理由 —— 它不是谁的动作。
 */
export function logSettingChange(db, {
  key,
  action,
  valueBefore = null,
  valueAfter = null,
  reason = null,
  actor = null,
  detail = null
} = {}) {
  const spec = SETTING_ACTIONS[action]
  if (!spec) {
    throw new SettingError(
      'SETTING_AUDIT_UNKNOWN_ACTION',
      `配置审计不认识动作「${action}」；动作名必须来自 lib/settings.js 的 SETTING_ACTIONS`,
      500, { action, key }
    )
  }
  const def = SETTING_RULES[key]
  if (!def) {
    throw new SettingError(
      'SETTING_UNKNOWN',
      `未登记的配置键「${key}」不能写审计日志 —— 配置必须在 SETTING_RULES 里登记`,
      500, { key }
    )
  }
  if (!db.inTransaction) {
    throw new SettingError(
      'AUDIT_OUTSIDE_TX',
      `配置「${def.label}」的变更日志必须在事务内写入 —— 否则会出现"值改了、日志没写"或反之`,
      500, { key, action }
    )
  }
  const why = String(reason ?? '').trim()
  if (def.is_danger && action !== 'baseline' && !why) {
    throw new SettingError(
      'SETTING_REASON_REQUIRED',
      `配置「${def.label}」属于会计政策/业务口径，修改必须写理由 —— 改它会让已经结出来的账换一种解释`,
      400, { key, action }
    )
  }

  const info = db
    .prepare(`
      INSERT INTO setting_audit_log
        (key, action, action_label, group_key, value_before, value_after,
         is_danger, reason, actor_id, actor_name, actor_source, detail)
      VALUES (?,?,?,?,?,?, ?,?,?,?,?,?)
    `)
    .run(
      key, action, spec.label, def.group, valueBefore, valueAfter,
      def.is_danger ? 1 : 0, why || null,
      actor?.id ?? null, actor?.name ?? null, actor?.source || 'web',
      detail ? JSON.stringify(detail) : null
    )
  return Number(info.lastInsertRowid)
}

/**
 * 改一个配置。**唯一的配置写入点**。
 *
 * 与 `routes/meta.js` 原来那句裸 `INSERT ... ON CONFLICT` 的区别：
 *   · 校验（`SETTING_VALUE_INVALID`）—— 原来写什么进去都接收；
 *   · 留痕（同事务写 `setting_audit_log`）；
 *   · **值没变时返回 `changed:false` 且不写日志** —— "点了一次保存但没改"不是一次变更，
 *     写进历史只会让日志变成一串重复值（`SETTING_NO_CHANGE` 不做成错误，
 *     因为界面上"确认一下当前值"是正常操作；但它必须以 `changed:false` 如实回答）。
 */
export function writeSetting(db, { key, value, reason = null, actor = null, source = null } = {}) {
  const def = SETTING_RULES[key]
  if (!def) {
    throw new SettingError(
      'SETTING_UNKNOWN',
      `未登记的配置键「${key}」。配置不能随手新增 —— 请在 lib/settings.js 的 SETTING_RULES 里登记（标签、类型、默认值、值域、是否危险）后再写入`,
      400, { key, known: SETTING_KEYS }
    )
  }
  const next = normalizeSettingValue(def, value)

  const tx = db.transaction(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    const before = row ? String(row.value) : null
    if (before === next) return { key, value: next, changed: false, logged: false }

    db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(key, next)

    const entryId = logSettingChange(db, {
      key, action: 'set', valueBefore: before, valueAfter: next,
      reason, actor: { ...(actor || {}), source: source || actor?.source || 'web' }
    })
    return { key, value: next, changed: true, logged: true, entry_id: entryId, value_before: before }
  })
  return tx()
}

/** 把一个配置恢复成登记表里的默认值。与 `set` 的区别只在日志的 `action` 上（见 `SETTING_ACTIONS`）。 */
export function resetSetting(db, { key, reason = null, actor = null, source = null } = {}) {
  const def = SETTING_RULES[key]
  if (!def) throw new SettingError('SETTING_UNKNOWN', `未登记的配置键「${key}」`, 400, { key })

  const tx = db.transaction(() => {
    const row = db.prepare('SELECT value FROM settings WHERE key=?').get(key)
    const before = row ? String(row.value) : null
    if (before === def.default) return { key, value: def.default, changed: false, logged: false }

    db.prepare(
      `INSERT INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`
    ).run(key, def.default)

    // **不**给 `reason` 填一句"恢复默认值"兜底 —— 那会让危险项的"必须写理由"失效：
    // "它回到了默认值"不是理由，理由是"**为什么**要让它回到默认值"
    // （会计政策从 4105 退回 4103，得答得出为什么）。"恢复默认"这件事
    // 由 `action='reset'` 表达，不需要编一句文案冒充理由。
    const entryId = logSettingChange(db, {
      key, action: 'reset', valueBefore: before, valueAfter: def.default,
      reason, actor: { ...(actor || {}), source: source || actor?.source || 'web' }
    })
    return { key, value: def.default, changed: true, logged: true, entry_id: entryId, value_before: before }
  })
  return tx()
}

// ---------------------------------------------------------------------------
// 五、初始化入口（补齐缺失键 + 补基线）
// ---------------------------------------------------------------------------
/**
 * 把库里的配置对齐到登记表：**补齐缺失的键**，并给"有值但没有历史"的键补一条基线。
 *
 * 幂等：已有一条日志（任意动作）的键不会再补。所以它可以挂在每个读配置的入口上。
 * **整库重建路径必须能跑到它** —— 重建会把 settings 与 setting_audit_log 一起清掉。
 */
export function ensureSettings(db, { actor = null } = {}) {
  const tx = db.transaction(() => {
    let inserted = 0
    let baselines = 0
    const hasLog = db.prepare('SELECT 1 AS hit FROM setting_audit_log WHERE key=? LIMIT 1')
    const insSetting = db.prepare(
      `INSERT OR IGNORE INTO settings (key,value,updated_at) VALUES (?,?,datetime('now','localtime'))`
    )
    const getValue = db.prepare('SELECT value FROM settings WHERE key=?')

    for (const [key, def] of Object.entries(SETTING_RULES)) {
      const info = insSetting.run(key, def.default)
      if (info.changes > 0) inserted += 1
      // 基线只为"**从未有过历史**"的键补。注意基线**可以**为一个刚补进去的键写 ——
      // 它回答的是"在我们开始记日志之前，这个键是什么"。
      //
      // 而"有历史、但行被手工删掉了"的键**不补**：这种情况下补一条基线会把
      // "有人绕过写入点把配置行删了"这件事伪装成"它本来就是默认值"。
      // 探针 `SETTING_AUDIT_DESYNC` 会报出来（重放得到旧值、现状是默认值）——
      // 那才是正确的：**绕过唯一写入点就该被发现**（与批次 Q 不给"补一条基线"做运维入口同源）。
      if (hasLog.get(key)) continue
      const row = getValue.get(key)
      logSettingChange(db, {
        key,
        action: 'baseline',
        valueBefore: null,
        valueAfter: row ? String(row.value) : def.default,
        actor: actor || { id: null, name: null, source: 'system' },
        detail: { seeded: info.changes > 0 }
      })
      baselines += 1
    }
    return { inserted, baselines, keys: SETTING_KEYS.length }
  })
  return tx()
}

// ---------------------------------------------------------------------------
// 六、重放与自证
// ---------------------------------------------------------------------------
/**
 * 从日志重放，得到每个键"应该是什么值"。
 *
 * `entries` 可注入（与 `replayEntries` / `auditComparison` 同一个用法）：
 * 测试要能拿一份**造出来的**日志去问"如果日志是这样，重放会不会与现状对不上"。
 */
export function replaySettings(db, { entries = null } = {}) {
  const log = entries || db.prepare('SELECT * FROM setting_audit_log ORDER BY id').all()
  const state = {}
  for (const e of log) {
    const spec = SETTING_ACTIONS[e.action]
    // 未知动作跳过（由 `SETTING_AUDIT_UNKNOWN_ACTION` 单独报）—— 在这里再炸一次
    // 只会让同一个问题以两种面目出现。
    if (!spec) continue
    // 三种动作的效果都是"把这个键设成 value_after"（`effect.write` 区分语义，不改变落点）
    if (e.value_after === null || e.value_after === undefined) delete state[e.key]
    else state[e.key] = String(e.value_after)
  }
  return state
}

/** `settings` 表里的现状（与重放结果同形，便于直接比对） */
export function settingsStateOf(db) {
  const rows = db.prepare('SELECT key, value FROM settings').all()
  const out = {}
  for (const r of rows) out[r.key] = String(r.value)
  return out
}

/** 配置审计链的全部不变量。**全库扫描**，不是"只查界面上正在看的那几条"。 */
export function auditSettingTrail(db, { log = null, settings = null } = {}) {
  const problems = []
  const push = (code, message, detail = null) => problems.push({ code, message, detail })

  const known = Object.keys(SETTING_ACTIONS)
  const allLog = log || db.prepare('SELECT * FROM setting_audit_log ORDER BY id').all()
  const allSet = settings || db.prepare('SELECT key, value FROM settings ORDER BY key').all()

  // ① 动作名必须是代码认识的
  const unknownActions = [...new Set(allLog.map((r) => r.action))].filter((a) => !known.includes(a))
  if (unknownActions.length) {
    push('SETTING_AUDIT_UNKNOWN_ACTION', `配置审计日志里出现了代码不认识的动作：${unknownActions.join('、')}（唯一的写入点是 lib/settings.js 的 logSettingChange）`, { actions: unknownActions })
  }

  // ② 危险配置的变更必须有理由。"谁改的"与"为什么改"是同一件事的两半。
  const noReason = allLog.filter(
    (r) => r.action !== 'baseline' && r.is_danger && !String(r.reason ?? '').trim()
  )
  if (noReason.length) {
    push('SETTING_AUDIT_REASON_REQUIRED', `有 ${noReason.length} 条危险配置的变更没写理由（如 ${noReason[0].key} 在 ${noReason[0].created_at}）：改会计政策却不写为什么，等于把审计链断在这里`, { entries: noReason.slice(0, 5).map((x) => ({ key: x.key, action: x.action, at: x.created_at })) })
  }

  // ③ 库里出现了登记表之外的键。
  //    这是**本批要根治的那类问题**的反向（幽灵配置是"代码读、库里没有"；
  //    这里是"库里有、代码不认"）—— 两种都必须报：配置的集合必须是确定的。
  const unregistered = allSet.map((r) => r.key).filter((k) => !SETTING_RULES[k])
  if (unregistered.length) {
    push('SETTING_KEY_UNKNOWN', `settings 表里有 ${unregistered.length} 个未登记的键：${unregistered.join('、')} —— 未登记的配置没有标签/默认值/值域，读它的代码只能自己编一套（这正是幽灵配置的成因）`, { keys: unregistered })
  }

  // ④ 日志里出现了登记表之外的键（曾经登记过、后来从表里删掉）
  const logUnknown = [...new Set(allLog.map((r) => r.key))].filter((k) => !SETTING_RULES[k])
  if (logUnknown.length) {
    push('SETTING_AUDIT_ORPHAN', `配置变更日志里有 ${logUnknown.length} 个已不在登记表里的键：${logUnknown.join('、')} —— 它们的历史还在，但代码已经不认它们了`, { keys: logUnknown })
  }

  // ⑤ 登记表里登记、库里却没有的键（初始化没跑全）
  const missingKeys = SETTING_KEYS.filter((k) => !allSet.some((r) => r.key === k))
  if (missingKeys.length) {
    push('SETTING_KEY_MISSING', `登记表里有 ${missingKeys.length} 个键在 settings 表里不存在：${missingKeys.join('、')} —— 它们会一直走默认值，看起来"可配"其实不可配（ensureSettings 负责补齐）`, { keys: missingKeys })
  }

  // ⑥ 现状值不满足值域。有人直接改库，或者值域在本批收紧了 ——
  //    它的表现是"读的时候安静地回落默认值"，界面上却显示着那个非法值。
  const invalid = []
  for (const r of allSet) {
    const def = SETTING_RULES[r.key]
    if (!def) continue
    try {
      normalizeSettingValue(def, r.value)
    } catch (e) {
      invalid.push(`${r.key} = 「${r.value}」（${e.message}）`)
    }
  }
  if (invalid.length) {
    push('SETTING_VALUE_INVALID', `有 ${invalid.length} 个配置的当前值不满足值域：${invalid.slice(0, 3).join('；')}`, { items: invalid })
  }

  // ⑦ 重放 ≠ 现状（两条路径互证）。出处不同：现状来自各处的 upsert，历史来自唯一写入点。
  const want = replaySettings(db, { entries: allLog })
  const got = {}
  for (const r of allSet) got[r.key] = String(r.value)
  const desync = []
  for (const k of new Set([...Object.keys(want), ...Object.keys(got)])) {
    if (want[k] !== got[k]) {
      desync.push(`${k}：重放日志得到 ${want[k] === undefined ? '（无）' : `「${want[k]}」`}，settings 表上是 ${got[k] === undefined ? '（无）' : `「${got[k]}」`}`)
    }
  }
  if (desync.length) {
    push('SETTING_AUDIT_DESYNC', `settings 表的现状无法由配置变更日志重放出来（${desync.length} 处）：${desync.slice(0, 3).join('；')} —— 说明有改动没留下日志（或日志写了值没改）`, { items: desync })
  }

  return {
    ok: problems.length === 0,
    problems,
    keys_checked: allSet.length,
    entries_checked: allLog.length,
    registered_keys: SETTING_KEYS.length
  }
}

// ---------------------------------------------------------------------------
// 七、查询（界面用）
// ---------------------------------------------------------------------------
/** 全部配置：定义 + 当前值 + 是否已被改过（与默认值不同） */
export function listSettings(db) {
  ensureSettings(db)
  const histCount = db
    .prepare(`SELECT key, COUNT(*) c FROM setting_audit_log GROUP BY key`)
    .all()
  const histMap = new Map(histCount.map((r) => [r.key, r.c]))
  const changedAt = db
    .prepare(`
      SELECT key, MAX(created_at) at, COUNT(*) c FROM setting_audit_log
       WHERE action <> 'baseline' GROUP BY key
    `)
    .all()
  const changedMap = new Map(changedAt.map((r) => [r.key, r]))

  const items = Object.entries(SETTING_RULES).map(([key, def]) => {
    const row = settingRow(db, key)
    // 用**库里的字符串**判断"是否偏离默认值"，不用转型后的值 ——
    // 后者在值不合法时会回落默认值，于是"配了个非法值"会看起来"没改过"。
    const rawValue = row ? String(row.value) : def.default
    const ch = changedMap.get(key)
    return {
      key,
      label: def.label,
      group: def.group,
      type: def.type,
      default: def.default,
      is_danger: Boolean(def.is_danger),
      wired: Boolean(def.wired),
      impact: def.impact,
      enum: def.enum || null,
      min: def.min ?? null,
      max: def.max ?? null,
      gt: def.gt ?? null,
      value_raw: rawValue,
      value: readSetting(db, key),
      persisted: Boolean(row),
      is_default: rawValue === def.default,
      updated_at: row?.updated_at ?? null,
      history_count: histMap.get(key) || 0,
      changed_count: ch?.c || 0,
      last_changed_at: ch?.at ?? null
    }
  })
  return {
    groups: SETTING_GROUPS.map((g) => ({
      ...g,
      items: items.filter((x) => x.group === g.key)
    })),
    items,
    total: items.length,
    changed: items.filter((x) => !x.is_default).length,
    note: '配置的定义（标签 / 类型 / 默认值 / 值域 / 是否危险）只有一个出处：server/lib/settings.js 的 SETTING_RULES。'
      + '**未登记的键不许写入** —— 这一步换来一条可验证的不变量：库里的键集合 == 登记表里的键集合。'
  }
}

/** 配置变更历史 */
export function listSettingAudit(db, { key = null, dangerOnly = false, limit = 200 } = {}) {
  const args = []
  let where = 'WHERE 1=1'
  if (key) { where += ' AND key = ?'; args.push(String(key)) }
  if (dangerOnly) where += ' AND is_danger = 1'
  const cap = Math.min(Math.max(Number(limit) || 200, 1), 1000)
  const rows = db
    .prepare(`SELECT * FROM setting_audit_log ${where} ORDER BY id DESC LIMIT ${cap}`)
    .all(...args)
  const total = db.prepare(`SELECT COUNT(*) c FROM setting_audit_log ${where}`).get(...args).c
  return {
    rows: rows.map((r) => ({
      ...r,
      is_danger: Boolean(r.is_danger),
      action_label: r.action_label || SETTING_ACTIONS[r.action]?.label || r.action,
      actor_label: ['system', 'migration'].includes(r.actor_source) ? '系统初始化' : (r.actor_name || '—'),
      key_label: SETTING_RULES[r.key]?.label || r.key
    })),
    total,
    limit: cap,
    truncated: rows.length < total,
    actions: meta(db).actions
  }
}

export function meta(db) {
  const counts = db.prepare('SELECT action, COUNT(*) c FROM setting_audit_log GROUP BY action').all()
  const byAction = new Map(counts.map((r) => [r.action, r.c]))
  return {
    log_table: 'setting_audit_log',
    actions: Object.entries(SETTING_ACTIONS).map(([value, v]) => ({
      value, label: v.label, count: byAction.get(value) || 0
    })),
    groups: SETTING_GROUPS,
    keys: SETTING_KEYS,
    danger_keys: SETTING_KEYS.filter((k) => SETTING_RULES[k].is_danger),
    note: '配置变更日志**只追加**：没有修改与删除路径。settings 表上的行是「现状指针」，日志是「历史事实」；'
      + '自证的方式是从空状态按序重放日志，结果必须等于 settings 表的现状。'
  }
}

export default {
  SETTING_RULES,
  SETTING_GROUPS,
  SETTING_KEYS,
  SETTING_ACTIONS,
  SettingError,
  settingDef,
  normalizeSettingValue,
  castSettingValue,
  readSetting,
  settingRow,
  logSettingChange,
  writeSetting,
  resetSetting,
  ensureSettings,
  replaySettings,
  settingsStateOf,
  auditSettingTrail,
  listSettings,
  listSettingAudit,
  meta
}
