/**
 * ============================================================================
 * 文件标识：server/db/boot.js ｜ 单个行业库的启动序列：建结构 → 首次灌基础数据 → 派生数据 → 口径字典 → 接入凭据
 * ============================================================================
 * 【职责】单个行业库的启动序列：建结构 → 首次灌基础数据 → 派生数据 → 口径字典 → 接入凭据
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 单个行业库的启动序列：建结构 → 首次灌基础数据 → 派生数据 → 口径字典 → 接入凭据
//
// 为什么单独立一个文件：
//   这段顺序是**有依赖的**，而且顺序错了**不会报错**，只会灌出一库「看起来正常、实则对不上」的数据：
//     · seedOrgs          依赖 seedAll 造出的仓库/门店（货主要绑到主体上）
//     · seedPricing       依赖商品与 SKU
//     · seedOrderCenter   依赖 stores/dealers（订货客户从它们派生）与价格组
//     · seedProcurement   依赖已经存在的采购订单与收货单
//     · syncMetricDefs    依赖表结构（口径字典是投影，代码是唯一源）
//     · ensureDemoTokens  依赖 users（Token 有创建人）
//   以前它只散在 server/index.js 里，于是「整库重建」就只有「起一次服务」这一条路 ——
//   命令行想重建，只能手工按顺序敲六个命令，敲错顺序没人拦你，要等演示现场才发现数据对不上。
//   抽出来之后，服务启动与 scripts/reseed-all.mjs **共用同一条序列**：顺序只有一处定义。
//
// 注意这里**显式引入审批引擎**（副作用导入）：它在加载时把闸门注册进单据内核。
// 正式服务启动时它也是先于灌数被加载的（server/index.js 顶部），所以这里保持一致 ——
// 否则「命令行重建」与「服务启动重建」会得到两套不同的流转结果。

import { initSchema, getDb, isSeeded, INDUSTRIES, runWithIndustry, dbPathFor } from './index.js'
import { seedAll } from './seed.js'
import { seedOrgs } from './org-seed.js'
import { seedPricing } from './pricing-seed.js'
import { seedOrderCenter } from './oc-seed.js'
import { seedProcurement } from './procure-seed.js'
// 销售报价与信用控制（模块 08A）：依赖经销商档案、商品 SKU、价格组与订货中心的客户身份，
// 因此必须排在 seedProcurement 之后（信用主体由经销商派生，并要并入订货中心的占用）
import { seedQuoteCredit } from './quote-seed.js'
// 应收与收款核销（模块 21）：依赖信用账户（账期）与销售订单（来源单据），排在报价/信用之后
import { seedAr } from './ar-seed.js'
// 销售发票（模块 24）：依赖销售发货单（待开票队列来源）与经销商档案，排在应收之后
import { seedInvoice } from './invoice-seed.js'
// 生产制造（模块 10B）：BOM 主数据 + 领料出库 + 完工汇报 + 完工入库。
// 必须排在 **seedQc 之前**：制造链会把部分生产订单推到「已完工」，
// 而质检的待检来源视图 `v_qc_pending_source` 正是按 `po.status='completed'` 取生产完工的。
// 顺序颠倒的后果是「生产完工的那批货永远不进待检清单」，且不报错。
import { seedManufacture } from './mfg-seed.js'
// 质量检验（模块 13）：依赖采购到货单（已收货）、生产订单（已完成）与库存（在库复检），
// 必须排在采购与生产之后；它会产生采购退货与库存出库，所以也放在最后
import { seedQc } from './qc-seed.js'
// 门店 POS 交班缴款（模块 17）：依赖门店与门店仓（来自 seedAll）与商品 SKU，
// 只做门店范围内的收银/核款/缴款/日结，与采购、生产、质检都不耦合。
// 位置放在最后：它会对门店仓做出入库（日结出库、退货入库、盘点调整），
// 放在中间会让后面的步骤站在一个「刚被改过库存」的门店仓上，难以复现。
import { seedPos } from './pos-seed.js'
// 官网演示剧本（批次 W）：连续零售日报（每天都有营业/日结）+ 门店补货调拨。
// **必须紧跟 seedPos**：它要读 pos-seed 造出来的门店仓库存与班次口径；
// 而它自己产生的日结会生成 `completed` 的销售订单，后面 seedAr 派生应收时能自然带上。
import { seedPosHistory } from './demo-seed.js'
import { seedPromo } from './promo-seed.js'
// 渠道协议价与返利核销（批次 G）：与「经销商主档 + 销售订单」同源，必须排在它们之后
import { seedDms } from './dms-seed.js'
// 退款单（批次 J）：要在**已收款订单**上退货才会产生待退款额，
// 所以它必须排在 `seedAr`（造应收与收款）之后；而它的出账凭证要等 `seedFinance`，
// 又必须排在 `seedFinance` 之前。位置正好卡在两者之间。
import { seedRefund } from './refund-seed.js'
// 业财一体凭证（批次 H）：科目表 + 凭证模板 + **从真实业务单生成**的演示凭证
import { seedFinance } from './finance-seed.js'
import { seedReport } from './report-seed.js'
// 演示剧本第二段（批次 W）：部分发货 / 部分开票 / 部分收款 + 采购部分入库 / 部分待检。
// 放在**所有既有 seed 之后**：它要挑"已确认、一件未发"的订单和"已审批、一件未收"的采购单，
// 前面任何一步提前消耗掉这些候选，都会让中间态样本变少甚至为零。
// 它自己经 `lib/*` 写账，所以派生字段（invoice_status / ar.allocated_amount / received_qty）都是服务层算的。
import { seedPartialFlows } from './demo-seed.js'
import { syncMetricDefs } from '../lib/metrics.js'
// 配置初始化（批次 R）：把库里的 settings 对齐到 `lib/settings.js` 的登记表 ——
// 补齐缺失的键，并给"有值但无历史"的键补一条 `baseline`。
// **必须排在 `seedAll` 之后**：`resetDatabase()` 会把 settings 与 setting_audit_log
// 一起清掉（两者都在清理清单里），所以整库重建之后配置是由这一步灌回来的，
// 而不是由迁移 —— 迁移只负责建表（见 038 的文件头第三节）。
// 放在所有 seed 之后、`syncMetricDefs` 之前：口径字典是投影，而配置是它的**输入之一**
// （`pos_variance_limit` 这类阈值会被口径说明引用）。
import { ensureSettings } from '../lib/settings.js'
// 报表口径变更链初始化（批次 S）：与 `ensureSettings` 同一条理由 ——
// `resetDatabase()` 会把 `report_lines` / `report_defs` 与 `report_config_audit_log`
// 一起清掉（三者都在清理清单里），所以重建之后口径的历史是由这一步补回来的。
import { ensureReportConfigTrail } from '../lib/report-config-audit.js'
// IM（钉钉/飞书）平台配置初始化（批次 T）：与 `ensureSettings` 同一条理由 ——
// `im_platform_cfg` 在 `KEEP_TABLES` 里（重建不清），所以这一步主要是"升级既有库"时
// 把后来新增的平台补上；幂等，已有行不动（**刻意不覆盖 enabled** ——
// 有人手工停用了某个平台，重启一次不该把它又打开）。
import { ensureImPlatforms } from '../lib/im-sync.js'
import { ensureDemoTokens } from '../mcp/tokens.js'
import { endSeedClock } from './seed-clock.js'
import { requireDemoRuntime } from '../runtime.js'
import '../lib/approval.js'

/**
 * 初始化（或重建）一个行业库。
 * @param code   行业代号（cosmetic / food / apparel）
 * @param force  true = 无视库里有没有数据，整库重建（演示数据重灌）
 * @param log    日志回调；不传则静默
 * @returns {{ industry, seeded, rebuilt, tokens, dbPath }}
 */
export function bootIndustry(code, { force = false, log } = {}) {
  requireDemoRuntime()
  if (!INDUSTRIES[code]) throw new Error(`未知行业：${code}`)
  const say = (m) => { if (log) log(m) }
  const label = INDUSTRIES[code].label

  return runWithIndustry(code, () => {
    try {
      initSchema()
      // 演示数据只在「空库」时生成，除非显式要求重建 ——
      // 无条件重灌会把用户点出来的单据（以及库存流水）全部抹掉。
      const needSeed = force || !isSeeded()
      if (needSeed) {
        say(`「${label}」${force ? '按请求整库重建' : '首次启动'}，正在生成演示数据...`)
        seedAll({ silent: !log })
        say(`「${label}」演示数据生成完成`)
      }
      // 配置初始化（批次 R）：**必须紧跟 `seedAll`**。
      // `resetDatabase()` 会 `DROP TABLE settings`，所以重建之后配置是空的，
      // 而迁移不会重跑（`schema_migrations` 里已记录）—— 配置得由这一步灌回来。
      // 放在这里而不是放进 `seed.js`：`settings` 是**配置**不是演示数据，
      // 它的内容由 `lib/settings.js` 的登记表决定，与行业、与随机种子都无关。
      // 无条件执行（`needSeed` 为假时也要跑——它负责的是补基线，不是补数据）。
      const cfg = ensureSettings(getDb())
      if (needSeed || cfg.inserted || cfg.baselines) {
        say(`「${label}」配置就绪：登记 ${cfg.keys} 项，补齐 ${cfg.inserted} 项，基线 ${cfg.baselines} 条`)
      }
      // IM 平台配置（批次 T）：幂等补齐缺失的平台行；**已有行一律不动**
      // （`enabled` 是人手工设的，重启不应改变它）。
      const imc = ensureImPlatforms(getDb())
      if (needSeed || imc.added) {
        say(`「${label}」IM 平台就绪：补齐 ${imc.added} 个平台配置（默认停用）`)
      }
      // 组织主体与货主绑定：幂等，主数据就绪后执行（货主依赖仓库/门店已存在）
      seedOrgs(getDb(), { industry: code })
      // 价格组：四维自由组合的价格本，幂等 upsert
      seedPricing(getDb(), { industry: code, silent: true })
      // 订货中心：客户准入与订货单。依赖 stores/dealers 与价格组，必须放在两者之后
      seedOrderCenter(getDb(), { industry: code, silent: true })
      // 采购域：请购 / 发票 / 结算 / 付款 / 供货目录 / 质检样本。依赖采购订单与收货单
      seedProcurement(getDb(), { industry: code, silent: true })
      // 销售报价与信用控制：报价单 + 信用账户与台账。依赖经销商档案与已存在的销售订单
      seedQuoteCredit(getDb(), { industry: code, silent: true })
      // 应收与收款核销：由销售订单派生应收单，再决定收款与核销
      seedAr(getDb(), { industry: code, silent: true })
      // 销售发票：由销售发货单派生发票（已确认 / 待确认 / 红冲三种形态各留样本）
      seedInvoice(getDb(), { industry: code, silent: true })
      // 生产制造：BOM 主数据 + 领料 → 出库 → 完工汇报 → 完工入库（料工费在此归集）
      seedManufacture(getDb(), { industry: code, silent: true })
      // 质量检验：报检 → 检验 → 不良品处理三单各留样本（四路处置都造一条）
      seedQc(getDb(), { industry: code, silent: true })
      // 门店 POS：早晚班交班核款、长短款样本、缴款单、日结批次、门店退货与盘点。
      // 幂等：库里已有班次就跳过，不会覆盖演示现场真点出来的单据。
      seedPos(getDb(), { silent: true })
      // 零售历史（演示剧本）：把"最近 22 天每天都营业、每天都日结"补上。
      // 为什么放在 seedPos 之后：pos-seed 负责 D-2 / D-1 / D0 的**差异样本**（短款/长款/在途），
      // 这里负责 D-21 ~ D-3 的**连续经营曲线** —— 两者日期不重叠，拼起来才是完整的日报。
      // 幂等：库里已有 D-21 的日结就跳过（那个日期只可能由这一步产生）。
      seedPosHistory(getDb(), { silent: true })
      // 商城促销与会员：活动 / 促销 / 券 / 会员等级 / 积分与储值。
      // 必须排在「商城客户」之后（会员账户挂在 `mall_customers` 上），
      // 且自己会造几张真实 H5 订单并**真正走一遍结算** ——
      // 手工插出来的优惠留痕最容易与真实流程分叉（漏掉 `promotions.used` 计数器、
      // 漏写 `used_qty`），而那种分叉不报错，只会让「限量券明明没人用却显示已用满」。
      // 幂等：库里已有促销就跳过。
      seedPromo(getDb(), { silent: true })
      // 渠道协议价与返利核销：
      //   协议价要读商品售价（product_skus.price_retail）与经销商档案，
      //   返利要读这一期的**真实销售订单**（净销售 / 回款率 / 进货件数）——
      //   两条依赖都在前面就绪了，所以排在这里。
      //   内部**真正走一遍**「计提 → 确认 → 核销 → 冲应收」，
      //   与界面点击同一条代码路径；幂等：库里已有协议就跳过。
      seedDms(getDb(), { silent: true })
      // 退款单：在**已收款订单**上退货 → 登记待退款 → 登记退款单 → 确认出账。
      // 内部先补一笔真实收款（refund_due 只在"应收不够冲"时出现），
      // 再走 createSalesReturn / createRefund / confirmRefund —— 与界面同一条路径。
      // 幂等：库里已有退款单就跳过。
      seedRefund(getDb(), { silent: true })
      // 业财一体凭证：科目表 + 凭证模板 + 演示凭证。
      // 排在最后 —— 它要读的**正是前面所有业务域造出来的单**
      // （到货单 / 发货单 / 收款单 / 付款单），并且演示凭证一律**从这些真单生成**
      // （不平即拒绝，不手工插分录）。幂等：同一来源重复生成返回同一张。
      seedFinance(getDb(), { silent: true })
      // 报表体系：报表口径（会计政策）+ 期初余额 + 期间状态。
      // 排在 `seedFinance` **之后** —— 它要读的正是那些**已过账的凭证**
      // （关账前的"报表自证"要跑一遍资产负债表 / 利润表 / 现金流量表）。
      // 幂等：报表口径覆盖写；期初余额只在没有登记时写入。
      // 它内部会在口径写完后**立刻**补口径变更链的基线（批次 S）——
      // 必须早于它自己的第 5 步关账（关账前置 `auditReport` 含着第 ⑫ 条探针）。
      seedReport(getDb(), { silent: true })
      // 演示剧本第二段：中间态单据（部分发货 / 部分开票 / 部分收款 / 部分入库 / 部分待检）。
      // 为什么排在这里而不是更早：它挑的是"还没被动过"的订单与采购单，
      // 任何更早的位置都会被前面的 seed 先消耗掉候选；而且它不参与其它 seed 的取数，
      // 放最后不会改变已有演示数据的形态（重建依然逐表可比）。
      seedPartialFlows(getDb(), { silent: true })
      // 凭证再生成一次：`seedFinance` 按来源幂等（同一来源重复生成返回同一张），
      // 所以这一步只会给**刚造出来的**发货单 / 收款单补凭证，不会重复记账。
      // 不补的话，财务页里的凭证会比业务单据少一截 —— 那正是"业财一体"最不该出现的画面。
      seedFinance(getDb(), { silent: true })
      // 报表口径变更链初始化（批次 S）：**无条件执行**，与 `ensureSettings` 同一条理由 ——
      // `needSeed` 为假时（升级既有库 / 服务重启）种子不会跑，基线得由这里补。
      // 幂等：只给"一条历史都没有"的口径行补基线，已有历史的行不动。
      const rcfg = ensureReportConfigTrail(getDb())
      if (needSeed || rcfg.baselines) {
        say(`「${label}」报表口径变更链就绪：定义 ${rcfg.defs} 张 / 口径行 ${rcfg.lines} 行，补基线 ${rcfg.baselines} 条`)
      }
      // 数据口径字典：把代码里的指标定义投影进 metric_defs。幂等，且会清掉代码里已删除的指标
      syncMetricDefs(getDb())
      // 演示接入凭据仍保留原有初始化语义，但明文不得进入启动日志。
      const tokens = ensureDemoTokens(getDb(), { industry: code })
      if (tokens.length) {
        say(`「${label}」已签发 MCP Agent Token（凭据不写日志）`)
        for (const t of tokens) say(`        ${t.name}   权限 ${t.scopes}（凭据不写日志）`)
      }
      return { industry: code, label, seeded: true, rebuilt: needSeed, tokens: tokens.length, dbPath: dbPathFor(code) }
    } finally {
      // 灌数结束，交还真实时间。**必须放在 finally**：
      // 前面任何一步抛错都不能把冻结时钟留给后面的服务运行 ——
      // 否则「演示库里所有新写的库存流水时间都停在灌数那一刻」，
      // 而且这种错误在界面上完全看不出来（时间只是不往前走而已）。
      endSeedClock()
    }
  })
}

/** 依次初始化全部行业库（供服务启动与命令行重建共用） */
export function bootAll({ force = false, log } = {}) {
  return Object.keys(INDUSTRIES).map((code) => bootIndustry(code, { force, log }))
}

export default { bootIndustry, bootAll }
