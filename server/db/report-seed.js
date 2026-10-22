/**
 * ============================================================================
 * 文件标识：server/db/report-seed.js ｜ 报表体系演示数据（批次 L · 模块 28）
 * ============================================================================
 * 【职责】报表体系演示数据（批次 L · 模块 28）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 报表体系演示数据（批次 L · 模块 28）
//
// 三件事：**报表口径**（会计政策，定义类）+ **期初余额**（一个平衡的期初试算表）+ **演示期间状态**。
//
// 为什么报表口径走 `lib/report.js` 的 `saveReportLine` 而不手工 INSERT：
//   ① 格式校验（区间 `A~B`、小计表达式只允许行号加减）与界面走的是同一份实现，
//      手工 INSERT 可以插进一条"看起来有配置、实际永远算 0"的行；
//   ② 报表口径改了要能被审计 —— 单一的写入口才好加留痕。
//
// 为什么期初余额要**一次整批写**：期初试算表不平，之后每一期的资产负债表都不平，
// 而差额的来源从此不可考。整批写才能"写入前对整批做平衡校验，不平就整批不落库"。
import { requireDemoDatabase } from './runtime-policy.js'
import * as R from '../lib/report.js'
import * as C from '../lib/closing.js'
// 口径变更链的初始化入口（批次 S）：给"库里有这一行、但一条历史都没有"的口径行补基线。
// 种子**刻意不留痕**（上面 `{ audit: false }`），历史统一由它给出 —— 见文件里的说明。
import { ensureReportConfigTrail } from '../lib/report-config-audit.js'

/** 三张报表的定义。`cash_subjects` 只有现金流量表用得上 —— 现金类科目是**配置**，不是常量。 */
const REPORTS = [
  {
    report_code: 'bs',
    name: '资产负债表',
    basis: 'balance',
    // 资产负债表要覆盖**全部**科目：它是"家底"的完整表述，少一个科目就少一块钱。
    cover_categories: 'asset,liability,equity,cost,profit_loss',
    remark: '按**期末余额**编制；负债与权益行取贷方口径（sign=−1）'
  },
  {
    report_code: 'pl',
    name: '利润表',
    basis: 'amount',
    // 利润表只需要覆盖**损益类**：资产科目本来就不该出现在利润表里。
    cover_categories: 'profit_loss',
    remark: '按**本期发生额**编制；收入行取贷方口径（sign=−1）'
  },
  {
    report_code: 'cf',
    name: '现金流量表',
    basis: 'cash_flow',
    cash_subjects: '1001,1002',
    // 不做穷尽覆盖检查：现金流量表的覆盖面由**兜底行**保证（复合凭证的净额本来就归不到任何一行）
    cover_categories: null,
    // 批次 U 起：分录上可以标「现金流量项目」，标了的按项目直接落行；
    // 没有标记的（存量凭证、以及标了却落不到行上的）才按对手科目分析填列。
    remark: '现金流量项目标记优先；未标记的按凭证对手科目分析填列'
  }
]

/**
 * 资产负债表。
 *
 * 两条口径必须一起看才成立：
 *   · 资产行 `sign=+1`、负债与权益行 `sign=−1` —— 因为 `signed = 借 − 贷`，
 *     贷方科目取反才显示成正数；
 *   · 第 14 行「未结转损益」把 6xxx 损益类科目的余额一并计入权益 ——
 *     本系统**没有做期末结转**，损益类科目期末仍有余额。
 *     不把它计入权益，资产负债表必然差一个"本期利润"（而且看起来只是"权益少了一块"）。
 *     做了期末结转之后这一行自然归零（余额被转到 4103），报表照样平 —— 口径是兼容的。
 */
const BS_LINES = [
  { line_no: 1, line_code: 'BS_CASH', line_name: '货币资金', line_type: 'item', sign: 1, subject_range: '1001~1002' },
  { line_no: 2, line_code: 'BS_AR', line_name: '应收账款', line_type: 'item', sign: 1, subject_range: '1122~1122' },
  { line_no: 3, line_code: 'BS_PREPAID', line_name: '预付款项', line_type: 'item', sign: 1, subject_range: '1123~1123' },
  { line_no: 4, line_code: 'BS_OTHER_AR', line_name: '其他应收款', line_type: 'item', sign: 1, subject_range: '1201~1201' },
  { line_no: 5, line_code: 'BS_INVENTORY', line_name: '存货', line_type: 'item', sign: 1, subject_range: '1403~1408' },
  { line_no: 6, line_code: 'BS_WIP', line_name: '生产成本（在制品）', line_type: 'item', sign: 1, subject_range: '5001~5001', remark: '成本类科目余额是**资产**（在制品），不是费用 —— 它不该出现在利润表里' },
  { line_no: 7, line_code: 'BS_FA', line_name: '固定资产', line_type: 'item', sign: 1, subject_range: '1601~1601' },
  { line_no: 8, line_code: 'BS_ASSETS_SUBTOTAL', line_name: '流动资产合计', line_type: 'subtotal', subtotal_expr: '1+2+3+4+5+6', level: 2 },
  { line_no: 9, line_code: 'BS_ASSETS_TOTAL', line_name: '资产总计', line_type: 'total', subtotal_expr: '8+7', level: 1 },
  { line_no: 10, line_code: 'BS_AP', line_name: '应付账款', line_type: 'item', sign: -1, subject_range: '2202~2202' },
  { line_no: 11, line_code: 'BS_ADVANCE', line_name: '预收款项', line_type: 'item', sign: -1, subject_range: '2203~2203' },
  { line_no: 12, line_code: 'BS_PAYROLL', line_name: '应付职工薪酬', line_type: 'item', sign: -1, subject_range: '2211~2211' },
  { line_no: 13, line_code: 'BS_TAX', line_name: '应交税费', line_type: 'item', sign: -1, subject_range: '2221~222199' },
  // 应付股利（批次 O）：宣告分配股利那一刻公司就欠了股东一笔钱，
  // 所以它落在**负债**这一侧（借 4104 / 贷 2232），不是权益。
  { line_no: 14, line_code: 'BS_DIVIDEND_PAYABLE', line_name: '应付股利', line_type: 'item', sign: -1, subject_range: '2232~2232' },
  { line_no: 15, line_code: 'BS_LIABILITIES_TOTAL', line_name: '负债合计', line_type: 'total', subtotal_expr: '10+11+12+13+14', level: 1 },
  { line_no: 16, line_code: 'BS_CAPITAL', line_name: '实收资本', line_type: 'item', sign: -1, subject_range: '4001~4001' },
  { line_no: 17, line_code: 'BS_RETAINED', line_name: '本年利润', line_type: 'item', sign: -1, subject_range: '4103~4103', remark: '每个期末把损益类科目结转到这一行；每个年末再把它结转到「未分配利润」，于是它每年归零一次' },
  // 未分配利润与盈余公积（批次 O）：年度结转的落点、法定提取的去处。
  // **新科目必须同时补上行** —— 少一行，兜底行就会有金额，而 `auditReport` 的
  // `FALLBACK_NONZERO` 会把它报出来（这正是"科目覆盖"这条探针存在的意义）。
  { line_no: 18, line_code: 'BS_RETAINED_ANNUAL', line_name: '未分配利润', line_type: 'item', sign: -1, subject_range: '4104~4104', remark: '年度结转把「本年利润」转到这一行，它是**跨年累积**的可分配利润（收益分配表的起点）' },
  { line_no: 19, line_code: 'BS_SURPLUS', line_name: '盈余公积', line_type: 'item', sign: -1, subject_range: '4105~4105', remark: '利润分配的常见去处之一（法定盈余公积按净利润 10% 提取）' },
  { line_no: 20, line_code: 'BS_UNCARRIED_PL', line_name: '未结转损益', line_type: 'item', sign: -1, subject_range: '6001~6999', remark: '损益类科目的余额直接计入所有者权益（做了期末结转之后本行自然归零；非 0 说明有期间没结转）' },
  { line_no: 21, line_code: 'BS_EQUITY_TOTAL', line_name: '所有者权益合计', line_type: 'total', subtotal_expr: '16+17+18+19+20', level: 1 },
  { line_no: 22, line_code: 'BS_LIAB_EQUITY_TOTAL', line_name: '负债和所有者权益总计', line_type: 'total', subtotal_expr: '15+21', level: 1 },
  // 兜底行：区间写得最宽、**排在最后**被计算，只接"没人认领的"科目。
  // 它的用途是"不让金额凭空消失"，不是"掩盖漏配" —— 对资产负债表它**应当恒为 0**，
  // 一旦有金额 `auditReport` 会报 `FALLBACK_NONZERO`。
  { line_no: 23, line_code: 'BS_UNCLASSIFIED', line_name: '未分类科目（兜底）', line_type: 'item', sign: 1, subject_range: '0000~9999', is_fallback: true, order_no: 90, remark: '兜底行：只接没有任何具体行认领的科目；金额非 0 即说明报表口径漏配' }
]

const PL_LINES = [
  { line_no: 1, line_code: 'PL_REVENUE', line_name: '一、营业收入', line_type: 'item', sign: -1, subject_range: '6001~6099' },
  { line_no: 2, line_code: 'PL_COST', line_name: '二、营业成本', line_type: 'item', sign: 1, subject_range: '6401~6401' },
  { line_no: 3, line_code: 'PL_SELLING', line_name: '三、销售费用', line_type: 'item', sign: 1, subject_range: '6601~6601' },
  { line_no: 4, line_code: 'PL_ADMIN', line_name: '四、管理费用', line_type: 'item', sign: 1, subject_range: '6602~6602' },
  { line_no: 5, line_code: 'PL_NET_PROFIT', line_name: '五、净利润', line_type: 'total', subtotal_expr: '1-2-3-4', level: 1, remark: '收入行本身已是正数，所以这里做减法' },
  // 兜底行的区间**只覆盖损益段**（6000~6999），不是 0000~9999 ——
  // 写成 0000~9999 的话，利润表的兜底行会把**全部资产、负债、权益科目**都接走，
  // 于是它永远有金额、`FALLBACK_NONZERO` 永远在响，而真正的漏配反而看不出来。
  { line_no: 6, line_code: 'PL_UNCLASSIFIED', line_name: '未分类损益（兜底）', line_type: 'item', sign: 1, subject_range: '6000~6999', is_fallback: true, order_no: 90, remark: '兜底行：金额非 0 即说明利润表口径漏配了损益类科目' }
]

/**
 * 现金流量表。行匹配的是**对手科目**，且带**方向过滤**。
 *
 * 为什么必须带方向：同一个科目在两个方向上语义不同 ——
 * 贷 `222101` 是"随货款代收的销项税"（属销售收现），借 `222101` 是"实际缴税"（属支付税费）。
 * 只靠科目区间无法区分这两件事。
 */
const CF_LINES = [
  { line_no: 1, line_code: 'CF_SALES_CASH', line_name: '销售商品、提供劳务收到的现金', line_type: 'item', only_direction: 'credit', subject_range: '1122~1122|2203~2203|6001~6099|222101~222101' },
  { line_no: 2, line_code: 'CF_OTHER_OP_IN', line_name: '收到的其他与经营活动有关的现金', line_type: 'item', only_direction: 'credit', subject_range: '1201~1201|6601~6602' },
  { line_no: 3, line_code: 'CF_PURCHASE_CASH', line_name: '购买商品、接受劳务支付的现金', line_type: 'item', only_direction: 'debit', subject_range: '2202~2202|1123~1123|1403~1408|5001~5001|222102~222102' },
  { line_no: 4, line_code: 'CF_PAYROLL_CASH', line_name: '支付给职工以及为职工支付的现金', line_type: 'item', only_direction: 'debit', subject_range: '2211~2211' },
  { line_no: 5, line_code: 'CF_TAX_CASH', line_name: '支付的各项税费', line_type: 'item', only_direction: 'debit', subject_range: '2221~222199' },
  { line_no: 6, line_code: 'CF_OTHER_OP_OUT', line_name: '支付其他与经营活动有关的现金', line_type: 'item', only_direction: 'debit', subject_range: '6601~6602|1201~1201' },
  { line_no: 7, line_code: 'CF_OP_NET', line_name: '经营活动产生的现金流量净额', line_type: 'subtotal', subtotal_expr: '1+2+3+4+5+6', level: 1 },
  { line_no: 8, line_code: 'CF_INVEST_IN', line_name: '收回投资、处置长期资产收到的现金净额', line_type: 'item', only_direction: 'credit', subject_range: '1601~1601' },
  { line_no: 9, line_code: 'CF_INVEST_OUT', line_name: '购建长期资产支付的现金', line_type: 'item', only_direction: 'debit', subject_range: '1601~1601' },
  { line_no: 10, line_code: 'CF_INVEST_NET', line_name: '投资活动产生的现金流量净额', line_type: 'subtotal', subtotal_expr: '8+9', level: 1 },
  { line_no: 11, line_code: 'CF_FINANCE_IN', line_name: '吸收投资收到的现金', line_type: 'item', only_direction: 'credit', subject_range: '4001~4001' },
  { line_no: 12, line_code: 'CF_FINANCE_OUT', line_name: '分配股利、利润或偿付利息支付的现金', line_type: 'item', only_direction: 'debit', subject_range: '4103~4103' },
  { line_no: 13, line_code: 'CF_FINANCE_NET', line_name: '筹资活动产生的现金流量净额', line_type: 'subtotal', subtotal_expr: '11+12', level: 1 },
  // 兜底行**会**有金额：复合凭证的净额本来就归不到任何一行，那是预期的（`complex_vouchers` 会回报张数）
  { line_no: 14, line_code: 'CF_UNCLASSIFIED', line_name: '其他（未能归类的现金收支）', line_type: 'item', subject_range: '0000~9999', is_fallback: true, order_no: 94, remark: '接走：① 复合凭证的净额；② 未被上面任何行认领的对手科目。它是"净增加额自证"能成立的保险' },
  { line_no: 15, line_code: 'CF_NET_INCREASE', line_name: '现金及现金等价物净增加额', line_type: 'total', subtotal_expr: '7+10+13+14', level: 1, order_no: 99, remark: '自证：本行 = 现金类科目期末余额 − 期初余额' }
]

/**
 * 期初试算表（登记在 **2026-05**，即"2026 年 5 月初"）。
 *
 * 数字是虚构的演示值，但**借贷必须相等** —— 这是唯一一条不能虚构的性质：
 * 一张不平的期初试算表会让之后每一期的资产负债表都不平，而差额来源从此不可考。
 *   借方 2,805,000 = 800,000 + 1,200,000 + 5,000 + 300,000 + 500,000
 *   贷方 2,805,000 = 900,000 + 100,000 + 1,500,000 + 5,000 + 300,000
 */
const OPENING_PERIOD = '2026-05'
const OPENING_ROWS = [
  { subject_code: '1001', debit_amount: 5000, credit_amount: 0 },      // 库存现金
  { subject_code: '1002', debit_amount: 1200000, credit_amount: 0 },   // 银行存款
  { subject_code: '1122', debit_amount: 300000, credit_amount: 0 },    // 应收账款
  { subject_code: '1405', debit_amount: 800000, credit_amount: 0 },    // 库存商品
  { subject_code: '1601', debit_amount: 500000, credit_amount: 0 },    // 固定资产
  { subject_code: '2202', debit_amount: 0, credit_amount: 900000 },    // 应付账款
  { subject_code: '2203', debit_amount: 0, credit_amount: 100000 },    // 预收账款
  { subject_code: '222101', debit_amount: 0, credit_amount: 5000 },    // 应交增值税-销项税额
  { subject_code: '4001', debit_amount: 0, credit_amount: 1500000 },   // 实收资本
  { subject_code: '4103', debit_amount: 0, credit_amount: 300000 }     // 本年利润
]

/**
 * 演示期间：登记 2026-05 ~ 2026-10（业务发生在这几个月），
 * 并把 **2026-04 关账** —— 演示里必须能同时看到「已关账」与「未关账」两种状态，
 * 否则"关账"这个能力在界面上完全看不出来。
 */
const OPEN_PERIODS = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
const CLOSED_PERIODS = ['2026-04']
// 做**真实期末结转**的期间。选 2026-07 是因为它是演示数据里唯一"本期损益发生额非 0"的期间
// （2026-05 / 2026-10 的凭证是收付款与成本结转，不含损益科目）——
// 拿一个损益为 0 的期间做结转，演示库会显示"已结转"却什么也没转，等于没演示。
const CARRY_PERIODS = ['2026-07']

export function seedReport(db, { silent = false } = {}) {
  requireDemoDatabase(db)
  const log = (m) => { if (!silent) console.log(`  [report-seed] ${m}`) }

  // ---------- 1 / 2. 报表定义与报表行：**已有就不动** ----------
  //
  // ⚠️ 这一条是批次 S 修的**真实缺陷**，不是顺手改的洁癖：
  // 原来这两步是**无条件**执行的（`saveReportDef` 覆盖写 + `DELETE FROM report_lines` 再整段重插），
  // 而 `seedReport` 在 `bootIndustry` 里是**每次服务启动都会跑**的（不像 `seedAll` 有 `needSeed` 闸门）。
  // 于是每重启一次服务：
  //   · `report_lines` 的自增 `id` 就换一代（实测 1~44 → 45~88）；
  //   · 人在界面上改过的口径被 seed **静默覆盖回去** —— 会计政策不是能被启动覆盖的东西。
  //
  // id 换代的后果不止是难看：任何"按 id 指向报表行"的记录都会指向**另一个世界**，
  // 而那个 id 是**合法存在**的，所以按 id 的孤儿检查一条都发现不了
  // （与 `mcp_idempotency` / `price_change_logs` 的跨代引用同一族）。
  // 这一批之前，"删除一行口径"的审计只记 `report_line:<id>` —— 服务重启一次，
  // 那条记录就指向了另一行，而它看起来完全正常。
  //
  // 所以口径与**期初余额**（第 3 步）用同一条口径：**已有登记就不再重写**。
  // 口径是**会计政策**，一旦库里有，它就是"人正在用的那一份"——
  // 想让库回到 seed 那份定义，走整库重建（`resetDatabase` 会把口径与日志一起清掉，
  // 于是这里重新写，并重新补基线）。
  //
  // `{ audit: false }`：这里灌的是"库的初始状态"，不是某个人的动作。
  // 它的历史由紧接着的 `ensureReportConfigTrail` 以一条 `baseline` 给出 ——
  // 这样**升级路径与重建路径的日志内容完全一致**（都只有基线，没有 create）。
  // 若在这里留痕，重建后的库会多出一百多条 `create`（actor = 演示数据），
  // 而升级上来的库只有基线 —— 两条路径的产物不一样，重放不变量就成了"看情况成立"。
  // 判据：**"口径已经建立"= 有报表定义且有口径行**。
  //   · 空库 / 整库重建（`resetDatabase` 把口径与日志一起清掉）：两侧都是 0 ⇒ 按 seed 写；
  //   · 正常启动：3 张定义 + 44 行口径 ⇒ **一行都不碰**；
  //   · 上一轮半途而废（定义写了、口径行没写）：`linesN === 0` ⇒ 重写一次（顺带自愈）。
  // 刻意**不**拿"口径行数与 seed 是否相等"当判据：删掉一行口径是**合法操作**（界面就能删，
  // 而且本批给它留了痕）。用"等于 seed 的行数"当判据，会让启动把人删掉的那一行**又加回来** ——
  // 那等于把一次有记录、有理由的会计政策变更悄悄撤销。
  const existingDefs = db.prepare('SELECT COUNT(*) c FROM report_defs').get().c
  const existingLines = db.prepare('SELECT COUNT(*) c FROM report_lines').get().c
  let lineCount = existingLines
  if (existingDefs === 0 || existingLines === 0) {
    for (const r of REPORTS) R.saveReportDef(db, r, { audit: false })
    // **整段写**而不是逐行 upsert：行号与行数都可能变（例如把一行拆成两行），
    // 逐行 upsert 会留下上一版的行 —— 而它还在参与小计表达式（`subtotal_expr` 指着旧行号）。
    // 这与凭证模板「分录整体重建」是同一条教训。（只在"口径尚未建立"时做，所以没有拆掉旧行的问题。）
    lineCount = 0
    for (const [code, lines] of [['bs', BS_LINES], ['pl', PL_LINES], ['cf', CF_LINES]]) {
      db.prepare('DELETE FROM report_lines WHERE report_code=?').run(code)
      for (const l of lines) {
        R.saveReportLine(db, { report_code: code, order_no: l.order_no ?? l.line_no, ...l }, { audit: false })
        lineCount += 1
      }
    }
    log(`报表 ${REPORTS.length} 张 / 报表行 ${lineCount} 行（口径尚未建立，按 seed 写入）`)
  } else {
    // 已有口径：**一行都不碰**。这也让"重放日志 == 现状"这条不变量能长期成立 ——
    // 否则每次启动换一批 id，日志里的整行快照就全部对不上（探针会报一整片假红）。
    log(`报表口径已存在（定义 ${existingDefs} 张 / 口径行 ${existingLines} 行），跳过写入`)
  }
  // 口径就绪后**立刻**补基线 —— 必须排在第 4 步的期末结转与第 5 步的关账**之前**：
  // 关账的前置是 `auditReport`，而它现在含着第 ⑫ 条（口径变更链自证）。
  // 基线没补上，`REPORT_CONFIG_UNTRACKED` 会报，于是**这一期的关账会失败** ——
  // 演示库里就会出现"期末结转过了、期间还是开着的"这种自相矛盾的状态。
  const trail = ensureReportConfigTrail(db)
  log(`报表口径变更链：本次补基线 ${trail.baselines} 条（合计定义 ${trail.defs} 张 / 口径行 ${trail.lines} 行）`)

  // ---------- 3. 期初余额 ----------
  // 已有登记就不再重写：期初余额是**人录进来的账**，不是每次启动都该被覆盖的派生数据。
  const hasOpening = db.prepare('SELECT COUNT(*) c FROM accounting_opening_balances WHERE period=?').get(OPENING_PERIOD).c
  if (hasOpening === 0) {
    const written = R.setOpeningBalances(db, { period: OPENING_PERIOD, rows: OPENING_ROWS, actor: { name: '演示数据' }, remark: '演示期初试算表' })
    log(`期初余额（${OPENING_PERIOD}）借 ${written.total_debit} / 贷 ${written.total_credit}，平衡=${written.balanced}`)
  } else {
    log(`期初余额（${OPENING_PERIOD}）已存在，跳过`)
  }

  // ---------- 4. 期末结转 ----------
  // 给**一个真正有损益发生额的期间**做一次真实结转，让演示库呈现"按期结转"的正常状态：
  //   · 损益科目归零（6001 的余额不再是"开业至今的全部收入"）；
  //   · 4103 本年利润 增加"本期净利润"；
  //   · 而**利润表与资产负债表的数字都不变** —— 结转只在权益内部搬动，
  //     `BS_UNCARRIED_PL`（未结转损益）与 `BS_RETAINED`（本年利润）两行此消彼长。
  // 用 `carryForward` 而不是手工插一张凭证：结转账由**科目余额**生成，
  // 手工插的那张一旦与余额脱节（以后演示数据改了就会脱节），
  // 它就会成为一张"看起来对、其实平不了"的票 —— 而错误要到下次关账才发现。
  let carried = 0
  for (const p of CARRY_PERIODS) {
    try {
      const out = C.carryForward(db, { period: p, actor: { name: '演示数据' } })
      if (!out.replayed) carried += 1
      log(
        `期末结转 ${p}：凭证 ${out.voucher.doc_no}（借 ${out.voucher.total_debit} / 贷 ${out.voucher.total_credit}）` +
          `，待结转损益净额 ${out.plan?.carry_profit ?? '—'}${out.replayed ? '（已存在，跳过）' : ''}`
      )
    } catch (e) {
      // 与关账同一个口径：演示数据少一块必须有说得出的原因，不能静默吞掉
      log(`期末结转 ${p} 跳过：${e.code || e.message}`)
    }
  }

  // ---------- 5. 期间状态 ----------
  for (const p of OPEN_PERIODS) R.ensurePeriod(db, p)
  let closed = 0
  for (const p of CLOSED_PERIODS) {
    try {
      const out = R.closePeriod(db, { period: p, actor: { name: '演示数据' }, remark: '演示：上期已结账' })
      if (!out.replayed) closed += 1
    } catch (e) {
      // 关账前置检查没过（报表自证不通过 / 有草稿凭证 / **损益未结转**）—— 不静默吞掉，
      // 否则界面上会出现一个"以为关过了、其实没有"的期间
      log(`关账 ${p} 跳过：${e.code || e.message}`)
    }
  }
  log(`期间：登记 ${OPEN_PERIODS.length + CLOSED_PERIODS.length} 个，期末结转 ${carried + (CARRY_PERIODS.length - carried)} 个（${CARRY_PERIODS.join(',')}），关账 ${CLOSED_PERIODS.length} 个（${CLOSED_PERIODS.join(',')}）`)

  // ---------- 6. 自证 ----------
  const audit = R.auditReport(db, { period: '2026-10' })
  if (!audit.ok) {
    // **不抛异常**：报表口径不自证时，让服务照常起（否则整个演示环境起不来），
    // 但把问题**打印出来** —— 与 finance-seed 的 `skipped` 同一个口径：
    // "演示数据少了一块"必须有一个说得出的原因。
    log(`⚠ 2026-10 报表自证未通过：${audit.problems.map((p) => p.message).join('；')}`)
  } else {
    log(`2026-10 报表自证通过：资产 ${audit.totals.assets} = 负债 ${audit.totals.liabilities} + 权益 ${audit.totals.equity}`)
  }

  return {
    reports: REPORTS.length,
    lines: lineCount,
    opening_period: OPENING_PERIOD,
    closed_periods: CLOSED_PERIODS,
    carried_periods: CARRY_PERIODS,
    audit_ok: audit.ok,
    audit_problems: audit.problems
  }
}

export default { seedReport }
