/**
 * ============================================================================
 * 文件标识：server/lib/stock.js ｜ 存货核心 v2 —— 五维库存（仓库 × 货主 × SKU × 批次 × 币种）+ 移动加权成本 + 成本流水
 * ============================================================================
 * 【职责】存货核心 v2 —— 五维库存（仓库 × 货主 × SKU × 批次 × 币种）+ 移动加权成本 + 成本流水
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 存货核心 v2 —— 五维库存（仓库 × 货主 × SKU × 批次 × 币种）+ 移动加权成本 + 成本流水
//
// 相对 v1 的行为变更（模块 03 设计稿）：
//   1. 成本：由「入库价覆盖」改为「移动加权平均」，出库按当前均价，结存金额可回溯
//   2. 维度：新增货主（owner_org_id）与币种（currency），支持一盘货多主体、中国香港多币种
//   3. 拣选：FIFO/FEFO 由 inv_params.pick_rule 决定（原先注释写 FIFO、实现却是 FEFO，自相矛盾）
//   4. 效期：支持 expire_at 精确到小时（餐饮短保），过保批次按 inv_params.block_expired 禁止拣选
//   5. 流水：每次出入库写 inventory_transactions（含成本维度）+ stock_cost_ledger（成本变动明细）
//   6. 预留：除汇总数外写 inventory_reservations 明细，可回答「被谁占的」
//
// 向后兼容：所有函数签名保留 v1 形式，新参数（ownerOrgId / currency / opts）一律可选。
//          未传时由仓库的 default_owner_org_id 与 currency 自动解析，旧调用点无需改动。

// 依赖方向刻意保持单向：stock.js 是最底层的引擎，全文件此前没有 import，
// 唯一新增的依赖是「成本期间」这一条口径（已结转期间禁止再写流水）。
// costing.js 不反向依赖 stock.js（它直接读 inventory_stocks / inventory_transactions），
// 所以这里不会成环。口径只有一处定义 —— 别在本文件里再写一遍期间判断。
import { assertPeriodOpen } from './costing.js'
// 「允许负库存」的口径来自配置中心（`lib/settings.js` 的 `SETTING_RULES`）。
// 为什么不继续读 `inv_params`：客户要在**配置中心**看到并审计这个开关，而"参数表一套、
// 配置中心一套"意味着两份判据 —— 改了一处不生效、另一处没人知道。
// settings.js 不 import 任何 db/ 下的模块，所以这条依赖不会成环，也不新增到 db/index.js 的静态路径。
import { readSetting } from './settings.js'

// ---------------------------------------------------------------------------
// 「现在」的来源。
//
// 流水表 `inventory_transactions` 有两列时间：`biz_time`（业务发生时间）与 `created_at`，
// 库存行的 `updated_at` 也来自同一次取值。运行时这些都应当取**真实墙上时间**。
//
// 但灌数时必须能接管：否则整库重建两次得到的 `biz_time` 相差几秒，逐表比对永远合不上，
// 「同一份 seed + 同一份数据集 → 同一张库」这句话就不成立（批次 C 收尾排查出的最后一处）。
// 于是把「取现在」收敛成一个可替换的提供者：默认真实时间，seed 启动时换成冻结时钟
// （见 db/seed-clock.js），灌完立刻换回 —— 运行时行为一丝不变。
//
// 刻意不 import db/ 下的任何模块：stock.js 是底层引擎，依赖方向必须保持单向（db → lib）。
let _nowProvider = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

/** 替换「现在」的提供者；传 null 恢复真实时间。仅供灌数链路使用 */
export function setStockNowProvider(fn) {
  _nowProvider = fn || (() => new Date().toISOString().slice(0, 19).replace('T', ' '))
}

/** 取「现在」（YYYY-MM-DD HH:mm:ss） */
const nowStr = () => _nowProvider()

/** 金额取 2 位、数量取 4 位 —— 与库内金额/数量精度一致，避免汇总时浮点尾巴外溢 */
const round2 = (n) => Number((Number(n) || 0).toFixed(2))
const round4 = (n) => Number((Number(n) || 0).toFixed(4))

// ---------------------------------------------------------------------------
// 不可售批次的出库闸门（A13）
//
// 缺陷的形状：**"我就要这个批次"是绕过一切闸门的万能钥匙。**
//   · `pickBatches` 会跳过冻结 / 报废 / 过保的批次（它至少做了这一层）；
//   · 但只要调用方**显式传了 `batch_no`**，`applyStockOut` 就直接去那行库存扣数，
//     完全不看批次的冻结、效期与检验结论。
//   于是同一批货"自动拣选时不可用、指名要用时可用"—— 两套结论，一处生效。
//
// 而且 `inventory_batches.qc_status` **从来没有被任何代码写过**（一直是默认的 pending），
// 所以"不合格批次仍可拣选"这句话的根因不是"少判了一个 if"，
// 而是**检验结论根本没有落回批次**。本批两件事一起做：
//   ① 出库（含显式指定批次）拦"不可售"；
//   ② 质检处置把结论写回批次（见 lib/qc2.js）。
//
// 判据只拦**把货当可售货消耗掉**的那几类出库：
// 报废（SCRAP_OUT）、退料/退货（QC_RET_OUT / PUR_RET）、盘亏调整（ADJ_OUT）、
// 调拨（TR_OUT）这些的目的本来就是"把不可用的货弄出去/挪走"，当然要放行 ——
// 否则"发现不合格 → 报废"这条路会被自己拦住。
//
// 集合成员**必须是有写入点的码**：这条闸门的报错文案是按当前集合动态生成的
// （下面 assertBatchUsable 里 `${[...saleableOnlyOut(db)].join(' / ')}`），
// 集合里放一个永远写不出来的码，就等于**在报错里对用户宣称一个不会发生的出库类型**。
//
// `POS_OUT` / `MALL_OUT` 两个码即因此被移除（2026-10-16）：
//   · 全仓 `docType: '<LIT>'` 字面量穷举（server+scripts+src）里 0 次出现；
//   · 写 `inventory_transactions` 的唯一入口是 `writeTxn`，只被 applyStockIn/applyStockOut
//     调用 —— 逐个调用点核对，值域只有 24 个码，不含这两个；
//   · 三库 + 历史备份存量均为 0 行（`WWS_OUT` 同期实测 9/0/9 行 ⇒ 它是活的）；
//   · 没有"客户端传 doc_type"的写入路径（唯一从请求取 `doc_type` 的是
//     `mcp/tools.js:664`，那是只读过滤条件）。
// ⇒ 这两个码是**死防御**：既拦不到任何东西，又污染了用户可见的文案。
// ⚠️ 若将来真的上线 POS / 商城侧的出库流程，**它必须被标成 `saleable_only=1`** ——
// 否则那条流程会静默绕过可售性闸门（这正是本集合存在的意义）。
//
// ---------------------------------------------------------------------------
// 名单的**权威出处已经搬到主数据**（客户口径：出入库单据类型由客户自己新建）
// ---------------------------------------------------------------------------
// 从这一版起，"哪种出库要把货当可售货消耗"由 `inv_txn_types.saleable_only` 决定
// （迁移 `047_inv_txn_types_master.cjs` 落列并**按改列前的行为逐条回填**；
//   客户可在「出入库单据类型」维护页自行改）。下面这份常量**只剩下一个用途**：
//   **列缺失时的回落** —— 老库还没跑到 047 的那一次启动，闸门必须照旧工作。
//   它的值 = 047 回填的同一份名单，所以"回落"等于"与改列前逐条一致"；
//   绝不能因为少一列就把闸门整个关掉（那是静默开漏）。
const SALEABLE_ONLY_OUT_FALLBACK = ['SAL_OUT', 'SHP_OUT', 'MR', 'WWS_OUT']

// 类型主数据的进程内缓存。与 `inv_params` 同一条纪律（见下面 A12）：**按 db 分桶**，
// 不能让"美妆库的类型配置"在餐饮库的出库里生效 —— 三库共用一个模块实例。
let txnTypeCache = new WeakMap()

/** 清类型缓存：传 db 只清那个库；不传则整体重置。维护接口写完必须调它。 */
export function clearInvTypeCache(db = null) {
  if (db) txnTypeCache.delete(db)
  else txnTypeCache = new WeakMap()
}

/** 只报"缺列/缺表" —— 别的错（比如库锁住）要照抛，不能被回落掩盖成"配置就是这个"。 */
const isMissingColumnError = (e) => /no such (column|table)/i.test(String(e && e.message))

/**
 * 读整份类型主数据：`code → { saleableOnly, status, name, direction, ledgerSubjectCode }`。
 * 一次查询供三个判据共用（闸门成员 / 是否停用 / 名字兜底），并缓存，避免每次出库都查库。
 * 返回 `{ byCode: Map, fallback: boolean }` —— `fallback=true` 表示列/表缺失，用了回落口径。
 */
function invTypeIndex(db) {
  const cached = txnTypeCache.get(db)
  if (cached) return cached
  let out
  try {
    const rows = db
      .prepare('SELECT code,name,direction,status,saleable_only,ledger_subject_code FROM inv_txn_types')
      .all()
    out = {
      fallback: false,
      byCode: new Map(
        rows.map((r) => [
          r.code,
          {
            name: r.name,
            direction: r.direction,
            status: r.status,
            saleableOnly: Number(r.saleable_only) === 1,
            ledgerSubjectCode: r.ledger_subject_code || null
          }
        ])
      )
    }
  } catch (e) {
    if (!isMissingColumnError(e)) throw e
    // 缺列/缺表 ⇒ 只能回落：闸门按改列前的名单，状态视为全部启用（不能凭空拦死）。
    out = {
      fallback: true,
      byCode: new Map(
        SALEABLE_ONLY_OUT_FALLBACK.map((code) => [code, { status: 'active', saleableOnly: true }])
      )
    }
  }
  txnTypeCache.set(db, out)
  return out
}

/** 「受可售性闸门约束」的当前集合（主数据 + 缺列回落） */
function saleableOnlyOut(db) {
  const { byCode, fallback } = invTypeIndex(db)
  if (fallback) return new Set([...byCode.keys()].sort())
  // **按码排序**：这份集合会被拼进用户可见的报错文案，顺序必须是确定的 ——
  // 跟着库里的行序（sort_order / rowid）走会让"同一份配置"打印出两种顺序，
  // 而这属于"看起来变了、其实没变"的噪音，排查时最容易被当成回归。
  const on = []
  for (const [code, t] of byCode) if (t.saleableOnly) on.push(code)
  return new Set(on.sort())
}

/**
 * 闸门报错文案里的「当前拦截集」文字。
 *
 * 形状是 **中文名 + 码**（`销售出库 SAL_OUT`）：这句话是**给用户看的**
 * （它出现在 409 的 message 里、前端直接 toast 出来），只写码等于让用户去猜；
 * 只写中文又会在报障时对不上日志与流水里的码。两个都写，读的人和查的人都不吃亏。
 *
 * 名字优先级：**字典里的 `name`（客户可改名/新建）→ `DOC_TYPE_LABEL`（硬编码文案）→ 码本身**。
 * 与守卫④同一条口径（第 0 层 §3 第 ⑦ 条）：客户新建的类型没有硬编码文案，
 * 但它在字典里有名字 —— **缺省要能回落**，而不是显示一个裸码或干脆不显示。
 */
function gateTextOf(db) {
  const { byCode } = invTypeIndex(db)
  return [...saleableOnlyOut(db)]
    .map((c) => {
      const name = (byCode.get(c) && byCode.get(c).name) || DOC_TYPE_LABEL[c]
      return name ? `${name} ${c}` : c
    })
    .join(' / ')
}

/**
 * 停用的类型不允许再写新流水。
 *
 * 主数据化的另一半：客户可以**停用**一条类型（历史流水还引用着它，所以不物理删除），
 * 而"停用"要真的有效 —— 否则它只是一个界面上的标签。判据放在**唯一写入入口** `writeTxn`：
 * 一处拦住，所有出/入库路径（含 MCP、POS、seed）都拦得住。
 * 未登记在字典里的码**不判**（那是守卫 ① 的活：值域归属，不是启用状态）。
 */
function assertTypesActive(db, p) {
  const { byCode, fallback } = invTypeIndex(db)
  if (fallback) return // 缺列回落：没有状态可判，不凭空拦
  const codes = [...new Set([p.docType, p.txnType].filter((c) => c != null && c !== ''))]
  const dead = []
  for (const c of codes) {
    const t = byCode.get(String(c))
    if (t && t.status !== 'active') dead.push(`${c}（${t.name || c}）`)
  }
  if (!dead.length) return
  const err = new Error(
    `出入库单据类型已停用，不能再用于新单据：${dead.join('、')}。` +
      `请在「主数据 → 出入库单据类型」里把它改回启用，或改用其它类型。`
  )
  err.status = 409
  err.code = 'INV_TYPE_INACTIVE'
  err.detail = { docType: p.docType, txnType: p.txnType || null }
  throw err
}

// ---------------------------------------------------------------------------
// 「检验结论能不能卖」的唯一判据（A13 扩：成品的「启用质检」开关）
//
// 客户口径：成品属性里开启质检 ⇒ 这批货**必须走完质检流程（判定合格）才能出售**；
// 不开启 ⇒ 可售。于是判据由**两个来源**合成，而它必须在**同一个地方**合成 ——
// 曾经 `pickBatches`（自动拣选）与 `assertBatchUsable`（指名批次出库）各写一份 if，
// 同一批货"自动拣选时不可用、指名要用时可用"。现在两处都调 `qcPolicy` / `qcSaleBlock`，
// 以后只会改一处。
//
//   require_qc=1：只有 `qualified` 可售。`pending`（待检）与 `rejected`（不合格）都拒，
//                 且**两条拒因文案不同** —— 合并成一句"不可售"会让用户不知道该去报检
//                 还是该去处置，而这两件事的责任人与动作完全不同。
//   require_qc=0：完全沿用全局参数（`block_rejected_qc` 默认 1、`block_pending_qc` 默认 0）。
// ---------------------------------------------------------------------------

/** 该 SKU 所属商品是否开启质检（`products.require_qc`）；查不到按不启用 —— 与列默认值一致 */
function productRequireQc(db, skuId) {
  if (skuId == null || skuId === '') return false
  const row = db
    .prepare('SELECT p.require_qc FROM product_skus s JOIN products p ON p.id=s.product_id WHERE s.id=?')
    .get(skuId)
  return Number(row?.require_qc) === 1
}

/** 把「这个 SKU 的质检口径」算成一份策略（SKU 级、与批次无关），供逐批判定复用 */
function qcPolicy(db, skuId) {
  return {
    requireQc: productRequireQc(db, skuId),
    blockRejected: paramFlag(db, 'block_rejected_qc', true),
    blockPending: paramFlag(db, 'block_pending_qc', false)
  }
}

/** 纯函数：给定策略与批次检验结论，返回拒因文案；可售返回 null */
function qcSaleBlock(policy, qcStatus) {
  const status = String(qcStatus || 'pending')
  if (policy.requireQc) {
    if (status === 'qualified') return null
    if (status === 'rejected') return '检验不合格（本商品已启用质检，须检验合格后方可出售）'
    return `尚在待检（本商品已启用质检，须走完质检流程并判定合格后才能出售；当前为 ${status}）`
  }
  if (status === 'rejected' && policy.blockRejected) return '检验不合格'
  if (status === 'pending' && policy.blockPending) return '尚在待检'
  return null
}

/** 显式指定批次出库时的"可售性"闸门 */
function assertBatchUsable(db, { warehouseId, ownerOrgId = null, skuId, batchNo, docType }) {
  if (!batchNo) return
  if (!saleableOnlyOut(db).has(String(docType || ''))) return
  const b = db
    .prepare('SELECT status, qc_status FROM inventory_batches WHERE sku_id=? AND batch_no=?')
    .get(skuId, batchNo)
  const stock = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo })
  const batchStatus = b?.status || 'active'
  const qcStatus = b?.qc_status || 'pending'
  const expAt = stock?.expire_at || stock?.expire_date
  const expired = !!expAt && String(expAt) <= nowStr()

  const reasons = []
  if (batchStatus === 'frozen') reasons.push('已冻结')
  if (batchStatus === 'scrapped') reasons.push('已报废')
  if (expired && paramFlag(db, 'block_expired', true)) reasons.push(`已过效期（${expAt}）`)
  // 检验结论那一条与自动拣选**同源**（qcPolicy + qcSaleBlock），不再各写一份
  const qcReason = qcSaleBlock(qcPolicy(db, skuId), qcStatus)
  if (qcReason) reasons.push(qcReason)
  if (!reasons.length) return

  const err = new Error(
    `批次 ${batchNo || '-'} 不能用于「${docType}」出库：${reasons.join('、')}。` +
      // 文案按**当前拦截集**动态生成：原来写死「只能走报废 / 退料 / 调拨类出库」，
      // 而拦截集里还有 MR（生产领料）与 WWS_OUT（委外发料）—— 于是提示把用户往一条
      // 实际也会被拦的路上指。集合改了文案也跟着变，不会再分叉（[13]）。
      `本闸门只拦「把货当可售货消耗」的出库（${gateTextOf(db)}）；` +
      `报废 / 退料 / 调拨 / 盘亏这类「把不可用的货弄出去、挪走」的出库不在其列。`
  )
  err.status = 409
  err.code = 'BATCH_NOT_SELLABLE'
  err.detail = { skuId, batchNo, docType, batchStatus, qcStatus, expired: expired || false, reasons }
  throw err
}

export const DOC_TYPE_LABEL = {
  PUR_IN: '采购入库',
  PUR_IN_REV: '采购入库回滚',
  PUR_RET: '采购退货出库',
  SAL_OUT: '销售出库',
  SAL_RET: '销售退货入库',
  TR_OUT: '调拨出库',
  TR_IN: '调拨入库',
  ADJ_IN: '盘盈调整',
  ADJ_OUT: '盘亏调整',
  ASM_OUT: '组装组件出库',
  ASM_IN: '组装成品入库',
  DSM_OUT: '拆卸成品出库',
  DSM_IN: '拆卸组件入库',
  WWS_OUT: '委外发料出库',
  WWS_IN: '委外收货入库',
  SHP_OUT: '门店发货出库',
  SHP_IN: '门店收货入库',
  PRD_IN: '生产完工入库',
  PRD_OUT: '生产领料出库',
  // MR / MO 是制造链把「单据类型码」写进 `doc_type` 的既有取值，不是笔误：
  //   · 领料出库 `lib/mfg.js:460` 传 `docType:'MR'` + `txnType:'PRD_OUT'`；
  //   · 完工入库 `lib/mfg.js:835` 传 `docType:'MO'` + `txnType:'PRD_IN'`。
  // 基线三库里是**真实存量**（MR 8/5/7 行、MO 2/1/2 行），且有两处反查依赖这两个码
  // （`lib/mfg.js:1017` 的重复入库判据、`lib/qc2.js:200` 取完工批次）。
  // ⇒ 采「登记跟代码」：在此补文案、由迁移 `045` 补进 `inv_txn_types`，而不是改写出值。
  // 文案与 PRD_OUT / PRD_IN 同义（同一个业务类型、同一个码的两种形态），这是有意的。
  MR: '生产领料出库',
  MO: '生产完工入库',
  INIT: '期初库存',
  TR_OWN_OUT: '货权转移出库',
  TR_OWN_IN: '货权转移入库',
  SUP_IN: '受托代销入库',
  SUP_OUT: '受托代销出库',
  CST_IN: '寄售入库',
  CST_OUT: '寄售出库',
  SAMPLE_OUT: '样品领用出库',
  SCRAP_OUT: '报废出库',
  // 022 只把 QC_RET_OUT 补进了 `inv_txn_types`，漏了这份文案 —— 「只改一处」的活样本
  // （`lib/qc2.js:999` 出库时写 `docType:'QC_RET_OUT'`）。现在由
  // `scripts/check-inv-txn-dict.mjs` 的双向闭合判据钉住：字典有码、文案必有词。
  QC_RET_OUT: '质检退料出库'
}

// 内部调拨：成本随货平移，不产生损益
const TRANSFER_TYPES = new Set(['TR_OUT', 'TR_IN', 'SHP_OUT', 'SHP_IN'])
// 货权转移：跨主体，等同销售 + 采购
const OWNERSHIP_TYPES = new Set(['TR_OWN_OUT', 'TR_OWN_IN'])
// 不计成本：如样品领用（按设计稿，样品出库不冲减成本口径由参数决定，默认仍按成本出）
const NO_COST_TYPES = new Set(['SAMPLE_OUT'])

const DEFAULT_ORG = 0
const CURRENCY_DEFAULT = 'CNY'

// ============================================================
// 一、库存参数读取（inv_params，带进程内缓存）
// ============================================================
//
// A12：缓存键原来只有 `key::scopeValue`，**不含数据库**。
// 而三个行业（美妆 / 餐饮 / 服装）是**三个独立的 SQLite 文件**，
// 却共用同一个模块实例 ⇒ 「美妆库的 pick_rule=fifo」会被当成"全局事实"，
// 在餐饮库的拣选里生效。实测：三库配置不同策略（FEFO / 过保禁售 / 待检禁售）时，
// **先读哪个库就决定了后面所有库的行为**，而且交错调用时结果来回变。
// （注：「允许负库存」原本也是这里的一个例子，现在它已迁到配置中心
//  `lib/settings.js` 的 `inv_allow_negative` / `_for`，不再走 `inv_params` 与本缓存。）
//
// 修法：缓存按**数据库连接**分桶（WeakMap）—— 键里带上"这是哪个库"，
// 而不是靠调用方记得传 industry。用 WeakMap 而不是往键里拼库名：
// 同一份文件被两个连接打开时它本来就该各读一次，且连接销毁后缓存自动释放。
let paramCache = new WeakMap()

function cacheOf(db) {
  let m = paramCache.get(db)
  if (!m) {
    m = new Map()
    paramCache.set(db, m)
  }
  return m
}

/** 清缓存：传 db 只清那个库；不传则整体重置（"所有库的参数都可能变了"） */
export function clearParamCache(db = null) {
  if (db) paramCache.delete(db)
  else paramCache = new WeakMap()
}

/** 读取库存参数；scope 优先 org → industry → global */
export function getInvParam(db, key, fallback = null, scopeValue = null) {
  const cache = cacheOf(db)
  const cacheKey = `${key}::${scopeValue == null ? '' : scopeValue}`
  if (cache.has(cacheKey)) return cache.get(cacheKey)

  let row = null
  if (scopeValue != null) {
    row = db
      .prepare('SELECT param_value FROM inv_params WHERE param_key=? AND scope_value=? ORDER BY id DESC LIMIT 1')
      .get(key, String(scopeValue))
  }
  if (!row) {
    // 同一键出现多行 `scope='global'` 时，**以最新那一行为准**（`ORDER BY id DESC`）。
    //
    // 为什么必须显式写 ORDER BY：SQLite 在**没有** ORDER BY 时按 rowid 升序返回行，
    // 于是 `LIMIT 1` 拿到的是**最早**那一行 —— 也就是说"后来补了一行新配置"会**确定性地
    // 不生效**（不是"看运气"）：现场与验收最常见的一个操作就是手工补一行，
    // 走的就是这条路。口径与上面的 scope_value 分支保持一致：同一件事不能有两个写法。
    row = db
      .prepare("SELECT param_value FROM inv_params WHERE param_key=? AND scope='global' ORDER BY id DESC LIMIT 1")
      .get(key)
  }
  const val = row && row.param_value != null ? row.param_value : fallback
  cache.set(cacheKey, val)
  return val
}

function paramFlag(db, key, fallback = false) {
  const v = getInvParam(db, key, fallback ? '1' : '0')
  return v === '1' || v === 'true' || v === true
}

// ============================================================
// 二、货主与币种解析
// ============================================================

/** 货主解析优先级：显式传入 → 仓库默认货主 → 仓库所属组织 → 系统默认主体(0) */
export function resolveOwnerOrg(db, warehouseId, explicit = null) {
  if (explicit != null && explicit !== '') return Number(explicit)
  if (warehouseId == null) return DEFAULT_ORG
  const wh = db
    .prepare('SELECT COALESCE(default_owner_org_id, org_id) AS owner FROM warehouses WHERE id=?')
    .get(warehouseId)
  return wh && wh.owner != null ? Number(wh.owner) : DEFAULT_ORG
}

/** 币种解析优先级：显式传入 → 仓库本位币 → CNY */
export function resolveCurrency(db, warehouseId, explicit = null) {
  if (explicit) return String(explicit)
  if (warehouseId == null) return CURRENCY_DEFAULT
  const wh = db.prepare('SELECT currency FROM warehouses WHERE id=?').get(warehouseId)
  return (wh && wh.currency) || CURRENCY_DEFAULT
}

function normOwner(v) {
  return v == null || v === '' ? DEFAULT_ORG : Number(v)
}

// ============================================================
// 三、五维库存行读写
// ============================================================

export function getStockRow(db, { warehouseId, ownerOrgId = null, skuId, batchNo = '', currency = null }) {
  // 货主未显式指定时按仓库默认货主解析（与 applyStockIn 同一套规则）。
  // 注意这里**不能**用 normOwner() 兜底成 0：模块 05 落地后库存行已带真实货主，
  // 若默认成 0，凡是「不传货主」的调用点（占用/释放/取成本）都会查不到货。
  const owner = resolveOwnerOrg(db, warehouseId, ownerOrgId)
  // 币种未显式指定时按仓库本位币解析，否则中国香港仓（HKD）永远查不到货
  const cur = resolveCurrency(db, warehouseId, currency)
  return db
    .prepare(
      `SELECT * FROM inventory_stocks
       WHERE warehouse_id=? AND IFNULL(owner_org_id,0)=? AND sku_id=? AND IFNULL(batch_no,'')=? AND currency=?`
    )
    .get(warehouseId, owner, skuId, batchNo || '', cur)
}

/** 入库：移动加权重算均价 */
function applyInWithCost(db, { warehouseId, ownerOrgId, skuId, batchNo, currency, qty, unitCost, produceDate, expireDate, expireAt, now }) {
  const owner = normOwner(ownerOrgId)
  const row = getStockRow(db, { warehouseId, ownerOrgId: owner, skuId, batchNo, currency })
  const inQty = Number(qty)
  const inCost = Number(unitCost || 0)

  if (!row) {
    const amt = Number((inQty * inCost).toFixed(4))
    const unit = inQty > 0 ? Number((amt / inQty).toFixed(4)) : inCost
    db.prepare(
      `INSERT INTO inventory_stocks
         (warehouse_id, owner_org_id, sku_id, batch_no, currency, produce_date, expire_date, expire_at,
          qty_on_hand, qty_reserved, qty_in_transit, qty_ordered, cost_price, cost_amount,
          entry_date, last_in_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,0,0,0,?,?,?,?,?)`
    ).run(
      warehouseId, owner, skuId, batchNo || '', currency,
      produceDate || null, expireDate ? String(expireDate).slice(0, 10) : null, expireAt || expireDate || null,
      inQty, unit, amt, String(now).slice(0, 10), now, now
    )
    return { before: { qty: 0, unit: 0, amount: 0 }, after: { qty: inQty, unit, amount: amt } }
  }

  const oQty = Number(row.qty_on_hand || 0)
  const oAmt = Number(row.cost_amount != null ? row.cost_amount : oQty * (row.cost_price || 0))
  const nQty = oQty + inQty
  const nAmt = Number((oAmt + inQty * inCost).toFixed(4))
  const nUnit = nQty > 0 ? Number((nAmt / nQty).toFixed(4)) : inCost

  db.prepare(
    `UPDATE inventory_stocks SET
       qty_on_hand=?, cost_price=?, cost_amount=?,
       produce_date=COALESCE(?, produce_date),
       expire_date=COALESCE(?, expire_date),
       expire_at=COALESCE(?, expire_at),
       last_in_at=?, updated_at=?
     WHERE id=?`
  ).run(
    nQty, nUnit, nAmt,
    produceDate || null,
    expireDate ? String(expireDate).slice(0, 10) : null,
    expireAt || null,
    now, now, row.id
  )
  return { before: { qty: oQty, unit: row.cost_price || 0, amount: oAmt }, after: { qty: nQty, unit: nUnit, amount: nAmt } }
}

/**
 * 出库单价的取值口径（G4）。
 *
 * **「没填」与「就是 0」必须能分开。** `0` 是合法单价（赠品 / 试用品 / 报废品确实可以按零成本出），
 * 但它同时又是「没填」最常见的落库形态：表单空字段是 `''`、`null`、JSON 里缺字段是 `undefined`。
 * 两者一旦合流，后果不是"少算一次"——
 *   出库金额算成 0 ⇒ 结存金额**不冲减**，而 `nUnit = nAmt / nQty` 再把均价**抬高**。
 * 实测：10 件 @100 出库 2 件传 0 ⇒ 剩 8 件仍记 1000 元（均价 125），
 * 应为 800 元 / 均价 100。错得**不报错、账也平**，只有对账时才发现钱多挂在库存上。
 *
 * 所以口径定死为：**`null` / `undefined` / 空串 = 未指定 → 回落结存均价；数字（含 `0`）= 显式指定。**
 * 调用方「没填」时**不要传 0**，要传 `null` / `undefined`
 * （既有写法可参照 `mcp/tools.js` 的 `unitCost: pk.unitCost ?? undefined`）。
 */
function resolveOutUnit(unitCost, fallbackUnit) {
  if (unitCost == null || unitCost === '') return fallbackUnit
  const n = Number(unitCost)
  return Number.isNaN(n) ? fallbackUnit : n
}

/** 出库：均价不变，仅冲减数量与金额 */
function applyOutWithCost(db, { warehouseId, ownerOrgId, skuId, batchNo, currency, qty, unitCost, now }) {
  const owner = normOwner(ownerOrgId)
  const row = getStockRow(db, { warehouseId, ownerOrgId: owner, skuId, batchNo, currency })
  const oQty = Number(row.qty_on_hand || 0)
  const oAmt = Number(row.cost_amount != null ? row.cost_amount : oQty * (row.cost_price || 0))
  const oUnit = Number(row.cost_price || 0)

  const outQty = Number(qty)
  // 单价取值优先级：显式传入（加权成本法下的批次成本）→ 库存均价。口径见 resolveOutUnit 的注释。
  const useUnit = resolveOutUnit(unitCost, oUnit)

  const nQty = Number((oQty - outQty).toFixed(6))
  const outAmt = Number((outQty * useUnit).toFixed(4))
  let nAmt = Number((oAmt - outAmt).toFixed(4))

  // 数量归零口径（inv_params.zero_qty_cost）
  let nUnit
  if (Math.abs(nQty) < 1e-6) {
    const keep = getInvParam(db, 'zero_qty_cost', 'keep_last') === 'keep_last'
    nUnit = keep ? oUnit : 0
    nAmt = 0
  } else {
    nUnit = Number((nAmt / nQty).toFixed(4))
  }

  db.prepare(
    `UPDATE inventory_stocks SET qty_on_hand=?, cost_price=?, cost_amount=?, last_out_at=?, updated_at=? WHERE id=?`
  ).run(nQty, nUnit, nAmt, now, now, row.id)

  return { before: { qty: oQty, unit: oUnit, amount: oAmt }, after: { qty: nQty, unit: nUnit, amount: nAmt }, usedUnit: useUnit, outAmount: outAmt }
}

// ============================================================
// 四、流水落账（业务流水 + 成本流水）
// ============================================================

function writeTxn(db, p, dir, { ownerOrgId, currency, unitCost, amount, balanceQty, now }) {
  // 停用的类型不许落新流水。放在这里而不是每个调用点：这是**唯一**的写入口，
  // 一处拦住，所有路径（API / MCP / POS / seed）都拦得住。
  assertTypesActive(db, p)
  db.prepare(
    `INSERT INTO inventory_transactions
       (biz_date, biz_time, doc_type, txn_type, doc_no, doc_id, warehouse_id, owner_org_id, sku_id, batch_no,
        direction, qty, unit_cost, amount, balance_qty, currency, fx_rate, unit_cost_base, amount_base,
        cost_method, counterparty, operator, remark, source)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    p.bizDate || now.slice(0, 10),
    p.bizTime || now,
    p.docType,
    p.txnType || p.docType,
    p.docNo || null,
    p.docId || null,
    p.warehouseId,
    normOwner(ownerOrgId),
    p.skuId,
    p.batchNo || '',
    dir,
    Number(p.qty),
    Number(unitCost || 0),
    Number(amount.toFixed ? amount.toFixed(4) : amount),
    balanceQty,
    currency,
    Number(p.fxRate || 1),
    p.fxRate ? Number((Number(unitCost || 0) * Number(p.fxRate)).toFixed(4)) : Number(unitCost || 0),
    p.fxRate ? Number((Number(amount) * Number(p.fxRate)).toFixed(4)) : Number(Number(amount).toFixed(4)),
    getInvParam(db, 'cost_method', 'moving_avg'),
    p.counterparty || null,
    p.operator || null,
    p.remark || null,
    p.source || 'web'
  )
}

function writeCostLedger(db, p, dir, { ownerOrgId, currency, qty, before, after, now }) {
  db.prepare(
    `INSERT INTO stock_cost_ledger
       (biz_date, warehouse_id, owner_org_id, sku_id, batch_no, currency, direction, qty,
        unit_cost_before, unit_cost_after, amount_before, amount_after, cost_method, doc_type, doc_no, remark)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    p.bizDate || now.slice(0, 10),
    p.warehouseId,
    normOwner(ownerOrgId),
    p.skuId,
    p.batchNo || '',
    currency,
    dir,
    Number(qty),
    before.unit, after.unit,
    before.amount, after.amount,
    getInvParam(db, 'cost_method', 'moving_avg'),
    p.docType,
    p.docNo || null,
    p.remark || null
  )
}

/** 统一准备上下文 */
function ctx(db, p) {
  const warehouseId = p.warehouseId
  const ownerOrgId = resolveOwnerOrg(db, warehouseId, p.ownerOrgId)
  const currency = resolveCurrency(db, warehouseId, p.currency)
  const now = p.bizTime || nowStr()
  return { warehouseId, ownerOrgId, currency, now }
}

// ============================================================
// 五、对外接口
// ============================================================

/** 期间闸门的薄封装：错误码与口径定义都在 costing.js，这里只负责调用 */
function assertPeriodWritable(db, bizDate) {
  assertPeriodOpen(db, bizDate)
}

/**
 * 出入库数量的符号闸门（收尾批次 A17b）。
 *
 * 引擎**必须自己拒绝非正数量**，不能指望调用方 —— 这是"账实不符"最隐蔽的一条路：
 *   · `applyStockOut(-5)` 在旧实现里不会报"库存不足"（`可用 < -5` 恒为假），
 *     而是拿着 -5 去出库：库存**反向增加** 5 件，还写了一条出库流水；
 *   · `applyStockIn(-5)` 同理，入库把库存**减掉** 5 件。
 * 两条都**不报错、账也平**（流水与余额一起反着走），只有盘点时才发现某天凭空多/少了 5 件。
 * 要冲销请走各自的逆向单据（退货 / 调整单），不要靠负数量。
 */
function assertPositiveQty(qtyIn, { docType = null, docNo = null, action = '出入库' } = {}) {
  const qty = Number(qtyIn)
  if (!Number.isFinite(qty) || qty <= 0) {
    const err = new Error(`${action}数量必须大于 0（收到 ${qtyIn}）`)
    err.status = 400
    err.code = 'STOCK_BAD_QTY'
    err.detail = { qty: qtyIn, docType, docNo }
    throw err
  }
  return qty
}

export function applyStockIn(db, p) {
  const { warehouseId, ownerOrgId, currency, now } = ctx(db, p)
  // 数量符号闸门放在最前：先于期间闸门（数量都不对时，"期间能不能写"没有意义）
  const qtyChecked = assertPositiveQty(p.qty, { docType: p.docType, docNo: p.docNo, action: '入库' })
  // 成本期间闸门：**放在入口**，不靠事后对账。
  // 往已结转的期间补单据，会让上一期已经结出来的期末金额与今天算出来的不一致，
  // 而两张报表都能打开、都像是对的 —— 这类不一致在演示现场没法解释。
  assertPeriodWritable(db, p.bizDate || now)
  const batchNo = p.batchNo || ''
  const qty = qtyChecked
  const unitCost = Number(p.unitCost || 0)

  const { before, after } = applyInWithCost(db, {
    warehouseId, ownerOrgId, skuId: p.skuId, batchNo, currency,
    qty, unitCost,
    produceDate: p.produceDate,
    expireDate: p.expireDate,
    expireAt: p.expireAt,
    now
  })

  // 入库金额：以实际入库数量 × 入库单价计（移动加权下金额守恒）
  const inAmount = Number((qty * unitCost).toFixed(4))

  writeTxn(db, { ...p, warehouseId, batchNo, qty }, 'in', {
    ownerOrgId, currency, unitCost, amount: inAmount, balanceQty: after.qty, now
  })
  writeCostLedger(db, { ...p, warehouseId, batchNo }, 'in', {
    ownerOrgId, currency, qty, before, after, now
  })

  // 批次主档（效期/质检）
  if (batchNo) {
    db.prepare(
      `INSERT INTO inventory_batches (batch_no, sku_id, supplier_id, produce_at, expire_at, shelf_life_hours,
        origin_doc_type, origin_doc_no, qc_status, status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?, 'active', ?)
       ON CONFLICT(sku_id, batch_no) DO UPDATE SET
         expire_at = COALESCE(excluded.expire_at, inventory_batches.expire_at),
         produce_at = COALESCE(excluded.produce_at, inventory_batches.produce_at),
         origin_doc_no = COALESCE(inventory_batches.origin_doc_no, excluded.origin_doc_no)`
    ).run(
      batchNo, p.skuId, p.supplierId || null,
      p.produceDate || p.produceAt || null,
      p.expireAt || p.expireDate || null,
      p.shelfLifeHours || null,
      p.docType, p.docNo || null,
      p.qcStatus || 'pending', now
    )
  }

  return { batchNo, balance: after.qty, unitCost: after.unit, costAmount: after.amount, ownerOrgId, currency }
}

/** Shared inventory-gain policy for HQ, POS and MCP. New dimensions explicitly start at zero cost. */
export function applyStockGain(db, p) {
  return db.transaction(() => {
    const row = getStockRow(db, p)
    const unitCost = Number(row?.cost_price || 0)
    const result = applyStockIn(db, { ...p, unitCost })
    return { ...result, gainUnitCost: unitCost, costSource: row ? 'current_avg' : 'new_row_zero_cost' }
  })()
}

export function applyStockOut(db, p) {
  const qtyReq = assertPositiveQty(p.qty, { docType: p.docType, docNo: p.docNo, action: '出库' })
  // 成本期间闸门（与入库同一个入口约束，见 applyStockIn）
  assertPeriodWritable(db, p.bizDate || nowStr())
  // A13：指名要某个批次时也必须过"可售性"闸门（自动拣选那条路由 pickBatches 负责）
  assertBatchUsable(db, {
    warehouseId: p.warehouseId, ownerOrgId: p.ownerOrgId,
    skuId: p.skuId, batchNo: p.batchNo, docType: p.docType
  })

  // 未指定批次时按拣选规则跨批次出库（FEFO/FIFO 由 inv_params.pick_rule 决定）。
  // 背景：调拨单、门店发货这类单据只关心数量，不指定批次；旧实现会去找「批次为空」的
  // 那一行，找不到就报「库存不足」，等于这些单据只能手工填批次才能出库。
  // 这里只在拣选结果确实跨多批次时才拆分，单批次场景完全走原路径（行为不变）。
  if (!p.batchNo && !p.__split && qtyReq > 0) {
    const probe = pickBatches(db, p.warehouseId, p.skuId, qtyReq, {
      ownerOrgId: p.ownerOrgId,
      currency: p.currency
    })
    const picked = probe.picks.reduce((n, x) => n + Number(x.qty || 0), 0)
    // 拣得够就按拣选结果逐批次出库（可能落到一个批次，也可能跨批次拆分）；
    // 拣不够则不在这里报错，交回原逻辑抛出带「可用量」的库存不足，错误信息更可读
    if (probe.picks.length >= 1 && picked + 1e-9 >= qtyReq) {
      const parts = probe.picks.map((pk) =>
        applyStockOut(db, {
          ...p,
          batchNo: pk.batchNo,
          qty: pk.qty,
          ownerOrgId: pk.ownerOrgId,
          currency: pk.currency,
          __split: true
        })
      )
      const last = parts[parts.length - 1]
      // A11：跨批次出库的**金额与单价必须由各批次汇总**，不能照抄最后一个批次。
      //   原来 `return { ...last, batches: [...{batchNo, qty}] }` —— unitCost 只来自末批，
      //   而 batches[] 连单价/金额都不带。上游 `mfg.js` 用 `qty * unitCost` 算整行材料成本，
      //   于是「10 元 5 件 + 20 元 5 件」被算成 10 件 × 20 元 = 200（应为 150）。
      //   两批价格差得越多，错得越多，而且**不报错、账也平**（出库流水按批次是对的，
      //   只有汇总口径错了）—— 正是"平账但错数"这类最难发现的问题。
      const qtySum = parts.reduce((n, r) => n + Number(r.qty || 0), 0)
      const amtSum = parts.reduce((n, r) => n + Number(r.outAmount || 0), 0)
      return {
        ...last,
        qty: round4(qtySum),
        outAmount: round2(amtSum),
        // 加权平均单价：既是"这次出库的真实单价"，也让 `qty × unitCost` 恰好等于总额
        unitCost: qtySum > 0 ? round4(amtSum / qtySum) : last.unitCost,
        split: parts.length > 1,
        batches: parts.map((r) => ({
          batchNo: r.batchNo,
          qty: r.qty,
          unitCost: r.unitCost,
          outAmount: r.outAmount
        })),
        skippedExpired: probe.skippedExpired
      }
    }  }

  const { warehouseId, ownerOrgId, currency, now } = ctx(db, p)
  const batchNo = p.batchNo || ''
  const qty = Number(p.qty)

  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId: p.skuId, batchNo, currency })
  const available = row ? row.qty_on_hand - row.qty_reserved : 0
  // 「允许负库存」= 总开关 **且** 来源命中例外 —— 两个条件都是**配置中心的键**（唯一出处）。
  // 口径与改动前逐字一致（原先读 `inv_params` 的同名两键）：默认 `0` + `pos_offline` ⇒ 永远不放行。
  // 所以「默认值 = 改动前的实际行为」这条不变量，落在 `SETTING_RULES` 的 default 上。
  const allowNegative =
    readSetting(db, 'inv_allow_negative') &&
    readSetting(db, 'inv_allow_negative_for') === String(p.source || 'web')

  if (!row || (available < qty && !allowNegative)) {
    const err = new Error(
      `库存不足：SKU#${p.skuId} 批次${batchNo || '-'} 可用 ${available}，需要 ${qty}`
    )
    err.status = 400
    err.code = 'INSUFFICIENT_STOCK'
    err.detail = { skuId: p.skuId, batchNo, available, required: qty, warehouseId, ownerOrgId, currency }
    throw err
  }

  const { before, after, usedUnit, outAmount } = applyOutWithCost(db, {
    warehouseId, ownerOrgId, skuId: p.skuId, batchNo, currency, qty,
    unitCost: p.unitCost, now
  })

  // 货权转移 / 内部调拨：成本随货平移，出库单价取原货主成本
  const finalUnit = OWNERSHIP_TYPES.has(p.docType) || TRANSFER_TYPES.has(p.docType) ? usedUnit : usedUnit
  writeTxn(db, { ...p, warehouseId, batchNo, qty }, 'out', {
    ownerOrgId, currency, unitCost: finalUnit, amount: outAmount, balanceQty: after.qty, now
  })
  writeCostLedger(db, { ...p, warehouseId, batchNo }, 'out', {
    ownerOrgId, currency, qty, before, after, now
  })

  return { batchNo, qty, balance: after.qty, unitCost: finalUnit, costAmount: after.amount, outAmount, ownerOrgId, currency }
}

/**
 * 出货转货权转移：一步完成「原货主出 + 新货主进」，
 * 用于中央厨房 → 加盟店（加盟店是独立主体，不能走内部调拨）。
 */
export function applyOwnershipTransfer(db, {
  fromWarehouseId, fromOwnerOrgId, toWarehouseId, toOwnerOrgId,
  skuId, batchNo = '', qty, unitCost, currencyFrom, currencyTo,
  docNo, docId, bizDate, operator, remark, source
}) {
  const out = applyStockOut(db, {
    warehouseId: fromWarehouseId, ownerOrgId: fromOwnerOrgId, currency: currencyFrom,
    skuId, batchNo, qty, unitCost, docType: 'TR_OWN_OUT', docNo, docId, bizDate, operator, remark, source
  })
  const inRes = applyStockIn(db, {
    warehouseId: toWarehouseId, ownerOrgId: toOwnerOrgId, currency: currencyTo,
    skuId, batchNo, qty, unitCost: out.unitCost, docType: 'TR_OWN_IN', docNo, docId, bizDate, operator,
    remark: remark || `货权转移入（源出库成本 ${out.unitCost}）`, source
  })
  return { out, in: inRes, unitCost: out.unitCost }
}

export function reserveStock(db, { warehouseId, skuId, batchNo = '', qty, ownerOrgId = null, currency = null, sourceDocType, sourceDocId, sourceDocNo, expireAt }) {
  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo, currency })
  if (!row) {
    const err = new Error(`库存不存在：SKU#${skuId}`)
    err.status = 400
    throw err
  }
  const now = nowStr()
  db.prepare("UPDATE inventory_stocks SET qty_reserved=qty_reserved+?, updated_at=? WHERE id=?").run(
    Number(qty), now, row.id
  )
  // 预留明细：可回答「被谁占的」
  if (sourceDocType) {
    db.prepare(
      `INSERT INTO inventory_reservations
        (warehouse_id, owner_org_id, sku_id, batch_no, qty, source_doc_type, source_doc_id, source_doc_no, status, expire_at, created_at)
       VALUES (?,?,?,?,?,?,?,?,'active',?,?)`
    ).run(
      warehouseId, normOwner(row.owner_org_id), skuId, batchNo, Number(qty),
      sourceDocType, sourceDocId || null, sourceDocNo || null, expireAt || null, now
    )
  }
}

export function releaseStock(db, { warehouseId, skuId, batchNo = '', qty, ownerOrgId = null, currency = null, sourceDocType, sourceDocId }) {
  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo, currency })
  if (!row) return
  const now = nowStr()
  db.prepare('UPDATE inventory_stocks SET qty_reserved=MAX(qty_reserved-?,0), updated_at=? WHERE id=?').run(
    Number(qty), now, row.id
  )
  if (sourceDocType) {
    db.prepare(
      `UPDATE inventory_reservations SET status='released'
       WHERE warehouse_id=? AND sku_id=? AND IFNULL(batch_no,'')=? AND source_doc_type=?
         AND (? IS NULL OR source_doc_id=?) AND status='active'`
    ).run(warehouseId, skuId, batchNo || '', sourceDocType, sourceDocId || null, sourceDocId || null)
  }
}

export function availableQty(db, warehouseId, skuId, batchNo = '', ownerOrgId = null, currency = null) {
  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo, currency })
  if (!row) return 0
  return row.qty_on_hand - row.qty_reserved
}

// ============================================================
// 五之二、预留的登记、读出、消费（A05）
// ============================================================
// 问题的形状：`reserveStock` / `releaseStock` 早就带了 `sourceDocType/sourceDocId`
// 参数，**但没有任何调用方传过** —— 于是 `inventory_reservations` 从建成那天起
// 一行都没写过（实测 0 行）。预留只剩库存行上的一个 `qty_reserved` 数字：
//   · 说不出"这 10 件是替哪张单占的"  ⇒ 释放只能**重新按当前库存再拣一次**；
//   · 而"当前库存"已经不是"当时那批"了 —— 于是发货拣不到货，
//     结果是**一张 0 数量的发货单**，同时那 10 件预留**永远挂着**（幽灵预留）。
//
// 三条规矩：
//   ① **占库必须登记来源**（reserveForDoc）—— 否则预留无从追溯；
//   ② **发货消费的是"本单占住的那批货"**，不是"现在再拣一次"（planShipment）；
//   ③ **取消按明细释放**，不是重新拣一次。
// 三者都按"来源单据"读写同一张明细表，所以判据只有一处。

/** 预留明细读出（唯一读出点）：某来源单据当前持有哪些批次的多少货 */
export function reservationsOf(db, { sourceDocType, sourceDocId, warehouseId = null }) {
  const args = [String(sourceDocType), Number(sourceDocId)]
  let sql = `SELECT * FROM inventory_reservations
              WHERE source_doc_type=? AND source_doc_id=? AND status='active'`
  if (warehouseId != null) {
    sql += ' AND warehouse_id=?'
    args.push(Number(warehouseId))
  }
  return db.prepare(`${sql} ORDER BY id`).all(...args)
}

/**
 * 为来源单据占库（**唯一的占库入口**）：拣选 → 预留 → 登记明细。
 * 数量不足直接抛 `INSUFFICIENT_STOCK`（调用方通常已在事务里，会整体回滚）。
 * @param {Array} items [{ skuId, qty }]
 * @returns {{ picks: Array }} 实际占下的批次明细
 */
export function reserveForDoc(db, { sourceDocType, sourceDocId, sourceDocNo = null, warehouseId, items = [], ownerOrgId = null, currency = null }) {
  const all = []
  for (const it of items) {
    const qty = Number(it.qty)
    if (!(qty > 0)) continue
    const { picks, shortage } = pickBatches(db, warehouseId, it.skuId, qty, { ownerOrgId, currency })
    if (shortage > 0) {
      const err = new Error(`库存不足，无法确认：SKU#${it.skuId} 缺 ${shortage}`)
      err.status = 400
      err.code = 'INSUFFICIENT_STOCK'
      err.detail = { skuId: it.skuId, shortage, warehouseId }
      throw err
    }
    for (const p of picks) {
      reserveStock(db, {
        warehouseId,
        skuId: it.skuId,
        batchNo: p.batchNo,
        qty: p.qty,
        ownerOrgId: p.ownerOrgId,
        currency: p.currency,
        // ↓ 关键：登记"谁占的"。少了这三个字段，预留就只是一个数字，无从释放、无从消费。
        sourceDocType,
        sourceDocId,
        sourceDocNo
      })
      all.push({ ...p, skuId: it.skuId })
    }
  }
  return { picks: all }
}

/**
 * 消费一笔预留（明细置 consumed + 库存行 qty_reserved 递减）。
 * **必须与出库成对使用，且先于出库** —— `applyStockOut` 的可用量判据是
 * `qty_on_hand - qty_reserved`，预留不减就出不了货（这正是幽灵预留的成因）。
 */
export function consumeStock(db, { sourceDocType, sourceDocId, warehouseId, skuId, batchNo = '', qty, ownerOrgId = null, currency = null }) {
  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo, currency })
  if (row) {
    db.prepare('UPDATE inventory_stocks SET qty_reserved=MAX(qty_reserved-?,0), updated_at=? WHERE id=?').run(
      Number(qty), nowStr(), row.id
    )
  }
  db.prepare(
    `UPDATE inventory_reservations SET status='consumed'
      WHERE source_doc_type=? AND source_doc_id=? AND sku_id=? AND IFNULL(batch_no,'')=? AND status='active'`
  ).run(String(sourceDocType), Number(sourceDocId), skuId, batchNo || '')
}

/**
 * 发货计划（A05 的核心）：**先消费本单据自己的预留**；不够就是"缺口"，**不抢别人的预留**。
 *
 * 为什么不复用它人的预留：两个订单竞争同一批货时，A 已经占住了货，
 * B 却能在发货时把 A 的预留抢走 —— 那 A 的发货就变成"0 数量发货单"，
 * 而 A 的预留永远挂着。**预留的意义就是"这货已经有主了"**。
 *
 * 历史兼容：确认早于本次修复的单据**没有预留明细**（那时代码从不写这张表），
 * 此时退回"按当前可用量拣选 + 释放旧占用"，否则这些单永远发不出去。
 *
 * @returns {{ plan: Array, shortage: number, mode: 'reservation'|'legacy' }}
 *   plan 元素：{ batchNo, qty, ownerOrgId, currency, unitCost }
 */
export function planShipment(db, { sourceDocType, sourceDocId, warehouseId, skuId, needQty, ownerOrgId = null, currency = null }) {
  const need = Number(needQty)
  if (!(need > 0)) return { plan: [], shortage: 0, mode: 'reservation' }

  const mine = reservationsOf(db, { sourceDocType, sourceDocId, warehouseId }).filter(
    (r) => Number(r.sku_id) === Number(skuId)
  )
  if (mine.length) {
    const plan = []
    let remain = need
    for (const r of mine) {
      if (remain <= 1e-9) break
      const take = Math.min(Number(r.qty), remain)
      if (!(take > 0)) continue
      // 先消费预留（qty_reserved 递减），再让调用方出库 —— 顺序不能反
      consumeStock(db, {
        sourceDocType, sourceDocId, warehouseId,
        skuId, batchNo: r.batch_no, qty: take, ownerOrgId: r.owner_org_id
      })
      const st = getStockRow(db, { warehouseId, ownerOrgId: r.owner_org_id, skuId, batchNo: r.batch_no })
      plan.push({
        batchNo: r.batch_no,
        qty: take,
        ownerOrgId: r.owner_org_id,
        currency: st?.currency ?? null,
        unitCost: st?.cost_price ?? undefined
      })
      remain -= take
    }
    return { plan, shortage: remain > 1e-9 ? Number(remain.toFixed(6)) : 0, mode: 'reservation' }
  }

  // 兼容路径：无预留明细（历史单据 —— 确认早于本次修复，那时代码从不写这张表）。
  // 先用**未被任何人占用**的货，不够的部分才动用 `qty_reserved` 里的货：
  // 历史单据的"占用"只体现在库存行的 qty_reserved 上，没有明细，
  // 所以它确实有权动那部分；但先花"无主的"，能少动一次别人的预留。
  const free = pickBatches(db, warehouseId, skuId, need, { ownerOrgId, currency })
  const plan = []
  let remain = need - free.picks.reduce((n, x) => n + Number(x.qty || 0), 0)
  for (const p of free.picks) {
    releaseStock(db, { warehouseId, skuId, batchNo: p.batchNo, qty: p.qty, ownerOrgId: p.ownerOrgId, currency: p.currency })
    plan.push({ batchNo: p.batchNo, qty: p.qty, ownerOrgId: p.ownerOrgId, currency: p.currency, unitCost: p.unitCost })
  }
  if (remain > 1e-9) {
    const withReserved = pickBatches(db, warehouseId, skuId, remain, { ownerOrgId, currency, includeReserved: true })
      .picks.filter((p) => !plan.some((x) => x.batchNo === p.batchNo))
    for (const p of withReserved) {
      releaseStock(db, { warehouseId, skuId, batchNo: p.batchNo, qty: p.qty, ownerOrgId: p.ownerOrgId, currency: p.currency })
      plan.push({ batchNo: p.batchNo, qty: p.qty, ownerOrgId: p.ownerOrgId, currency: p.currency, unitCost: p.unitCost })
      remain -= Number(p.qty || 0)
      if (remain <= 1e-9) break
    }
  }
  return { plan, shortage: remain > 1e-9 ? Number(remain.toFixed(6)) : 0, mode: 'legacy' }
}

/**
 * 取消/作废时的释放（**按明细释放，不重新拣选**）。
 * 无明细（历史单据）时退回"按当前可用量拣选并释放"，与旧行为一致。
 * @returns {{ released: number, mode: 'reservation'|'legacy' }}
 */
export function releaseForDoc(db, { sourceDocType, sourceDocId, warehouseId, skuId = null, needQty = null, ownerOrgId = null, currency = null }) {
  const rows = reservationsOf(db, { sourceDocType, sourceDocId, warehouseId }).filter(
    (r) => skuId == null || Number(r.sku_id) === Number(skuId)
  )
  if (rows.length) {
    let released = 0
    for (const r of rows) {
      releaseStock(db, {
        warehouseId, skuId: r.sku_id, batchNo: r.batch_no, qty: r.qty,
        ownerOrgId: r.owner_org_id, sourceDocType, sourceDocId
      })
      released += Number(r.qty)
    }
    return { released, mode: 'reservation' }
  }
  if (skuId == null || needQty == null) return { released: 0, mode: 'legacy' }
  const { picks } = pickBatches(db, warehouseId, skuId, Number(needQty), { ownerOrgId, currency })
  let released = 0
  for (const p of picks) {
    releaseStock(db, { warehouseId, skuId, batchNo: p.batchNo, qty: p.qty, ownerOrgId: p.ownerOrgId, currency: p.currency })
    released += Number(p.qty)
  }
  return { released, mode: 'legacy' }
}

/**
 * 批次拣选：规则由 inv_params.pick_rule 决定
 *   fefo（默认）— 先到期先出；fifo — 先进先出（按 entry_date / id）
 * 过保批次：inv_params.block_expired = 1 时排除
 */
export function pickBatches(db, warehouseId, skuId, needQty, opts = {}) {
  const { ownerOrgId = null, currency = null, includeExpired = false, includeReserved = false } = opts
  const rule = String(getInvParam(db, 'pick_rule', 'fefo')).toLowerCase()
  const blockExpired = paramFlag(db, 'block_expired', true) && !includeExpired

  const dims = []
  const args = [warehouseId, skuId]
  if (ownerOrgId != null && ownerOrgId !== '') {
    dims.push('IFNULL(s.owner_org_id,0) = ?')
    args.push(normOwner(ownerOrgId))
  }
  if (currency) {
    dims.push('s.currency = ?')
    args.push(String(currency))
  }
  const availExpr = includeReserved ? 's.qty_on_hand' : '(s.qty_on_hand - s.qty_reserved)'

  const orderBy =
    rule === 'fifo'
      ? `CASE WHEN s.entry_date IS NULL THEN 1 ELSE 0 END, s.entry_date ASC, s.id ASC`
      : `CASE WHEN COALESCE(s.expire_at, s.expire_date) IS NULL THEN 1 ELSE 0 END,
         COALESCE(s.expire_at, s.expire_date) ASC, s.id ASC`

  const now = nowStr()
  // 过保批次不在 SQL 层过滤，改在遍历时判定 —— 这样才能统计「有几个批次因过保被跳过」
  // 并向前端/Agent 返回告警（食品线临期呆滞的关键信号），代价只是多捞几行。
  const sql = `
    SELECT s.*, b.qc_status, b.status AS batch_status
    FROM inventory_stocks s
    LEFT JOIN inventory_batches b ON b.sku_id = s.sku_id AND b.batch_no = s.batch_no
    WHERE s.warehouse_id = ? AND s.sku_id = ? AND ${availExpr} > 0
      ${dims.length ? 'AND ' + dims.join(' AND ') : ''}
    ORDER BY ${orderBy}`

  const rows = db.prepare(sql).all(...args)

  const picks = []
  let remain = Number(needQty)
  let skippedExpired = 0
  let skippedUnusable = 0
  // 本 SKU 的质检口径只算一次（与 `assertBatchUsable` 调的是同一个函数）
  const qc = qcPolicy(db, skuId)
  for (const r of rows) {
    if (remain <= 0) break
    const batchStatus = r.batch_status || 'active'
    if (batchStatus === 'frozen' || batchStatus === 'scrapped') { skippedUnusable += 1; continue }
    // A13：检验结论要真的挡住出库。判据与 `assertBatchUsable`（指名批次出库）**同源** ——
    // 同一个 `qcPolicy` 算口径、同一个 `qcSaleBlock` 判可售，避免"自动拣选一套、指名一套"。
    //   商品开启质检（`require_qc=1`）时，`pending`（待检）与 `rejected`（不合格）都被排除，
    //   只有 `qualified` 可拣 —— 这就是"开启质检 ⇒ 这批货必须走完质检流程才能出售"。
    //   商品未开启质检时，行为完全由全局参数决定（`rejected` 默认拦、`pending` 默认放行）。
    const qcStatus = r.qc_status || 'pending'
    if (qcSaleBlock(qc, qcStatus)) { skippedUnusable += 1; continue }
    const expAt = r.expire_at || r.expire_date
    const isExpired = !!expAt && String(expAt) <= now
    if (batchStatus === 'expired' || (blockExpired && isExpired)) { skippedExpired += 1; continue }
    const avail = includeReserved ? r.qty_on_hand : r.qty_on_hand - r.qty_reserved
    const take = Math.min(avail, remain)
    if (take > 0) {
      picks.push({
        batchNo: r.batch_no,
        qty: take,
        unitCost: r.cost_price,
        expireDate: r.expire_date,
        expireAt: r.expire_at,
        ownerOrgId: r.owner_org_id,
        currency: r.currency,
        stockId: r.id
      })
      remain -= take
    }
  }
  const warns = []
  if (skippedExpired > 0) warns.push(`${skippedExpired} 个批次因过保被跳过`)
  if (skippedUnusable > 0) warns.push(`${skippedUnusable} 个批次因冻结或质检结论不可售被跳过`)
  return {
    picks,
    shortage: remain > 0 ? Number(remain.toFixed(6)) : 0,
    rule,
    skippedExpired,
    skippedUnusable,
    ...(warns.length ? { warn: warns.join('；') } : {})
  }
}

// ============================================================
// 六、结存与成本查询（供报表 / MCP 能力层使用）
// ============================================================

/** 五维结存查询 */
export function queryBalance(db, { warehouseId, ownerOrgId, skuId, batchNo, currency, onlyPositive = true } = {}) {
  const where = []
  const args = []
  if (warehouseId != null) { where.push('warehouse_id = ?'); args.push(warehouseId) }
  if (ownerOrgId != null) { where.push('IFNULL(owner_org_id,0) = ?'); args.push(normOwner(ownerOrgId)) }
  if (skuId != null) { where.push('sku_id = ?'); args.push(skuId) }
  if (batchNo != null) { where.push("IFNULL(batch_no,'') = ?"); args.push(batchNo || '') }
  if (currency) { where.push('currency = ?'); args.push(currency) }
  if (onlyPositive) where.push('qty_on_hand != 0')
  const sql = `SELECT * FROM inventory_stocks ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id`
  return db.prepare(sql).all(...args)
}

/** 指定维度上的结存成本，用于凭证/报表 */
export function costOf(db, { warehouseId, ownerOrgId = null, skuId, batchNo = '', currency = null }) {
  const row = getStockRow(db, { warehouseId, ownerOrgId, skuId, batchNo, currency })
  if (!row) return { qty: 0, unitCost: 0, amount: 0 }
  return {
    qty: row.qty_on_hand,
    unitCost: row.cost_price || 0,
    amount: row.cost_amount != null ? row.cost_amount : Number((row.qty_on_hand * (row.cost_price || 0)).toFixed(4)),
    ownerOrgId: row.owner_org_id,
    currency: row.currency
  }
}

// ============================================================
// 组织范围（ADR-0038）：库存按**仓库所属组织**（`warehouses.org_id`）收口
// ============================================================

/**
 * 库存域 SQL 范围谓词（完整谓词，无前导 AND）。判据与 `purchaseScopeSql` / `salesScopeSql` 同源：
 *   · 不传或 `all` ⇒ `1=1`（全库，admin / 全局范围 / lib 内部调用口径不变）；
 *   · `dealer` / `none` / 空集合 ⇒ `1=0` 并置 `empty: true`（空范围不许变成全库）；
 *   · 其余 ⇒ `<alias>.<column> IN (SELECT id FROM warehouses WHERE org_id IN (…))`；
 *     仓库的 `org_id` 为 NULL 对受限范围不可见（宁可看不到，也不放行）。
 * `alias` 给带表别名的查询用；`column` 缺省 `warehouse_id`（调拨单用 `from_warehouse_id` / `to_warehouse_id`，
 * 仓库表自身用 `id`）。
 */
export function stockScopeSql(orgScope, alias = '', column = 'warehouse_id') {
  if (!orgScope || orgScope.scope === 'all') return { sql: '1=1', params: [], empty: false }
  const ids = Array.isArray(orgScope.orgIds) ? orgScope.orgIds.map(Number).filter(Number.isFinite) : []
  if (orgScope.scope === 'dealer' || orgScope.scope === 'none' || !ids.length) return { sql: '1=0', params: [], empty: true }
  const col = alias ? `${alias}.${column}` : column
  return { sql: `${col} IN (SELECT id FROM warehouses WHERE org_id IN (${ids.map(() => '?').join(',')}))`, params: ids, empty: false }
}

/** 仓库是否在范围内（全局恒真；不存在 / org 为 NULL / 范围外 ⇒ false）。 */
export function warehouseInScope(db, warehouseId, orgScope) {
  if (!orgScope || orgScope.scope === 'all') return true
  const sc = stockScopeSql(orgScope, 'w', 'id')
  if (sc.empty || !Number.isFinite(Number(warehouseId))) return false
  return !!db.prepare(`SELECT 1 FROM warehouses w WHERE w.id=? AND ${sc.sql}`).get(Number(warehouseId), ...sc.params)
}

/** 写路径的目标仓校验：范围外（含不存在、org 为 NULL）⇒ 403 `TARGET_OUT_OF_SCOPE`；全局范围恒通过。 */
export function assertWarehouseInScope(db, warehouseId, orgScope) {
  if (warehouseInScope(db, warehouseId, orgScope)) return
  const e = new Error('所选仓库不在您的组织数据范围内')
  e.status = 403
  e.code = 'TARGET_OUT_OF_SCOPE'
  throw e
}

/** 按仓取单据行并判范围：范围外与不存在同形 404（`DOC_NOT_FOUND`）。`table` / `column` 由调用方写死，不接受用户输入。 */
export function assertStockDocInScope(db, table, id, orgScope, { column = 'warehouse_id', notFound = '单据不存在' } = {}) {
  const sc = stockScopeSql(orgScope, 't', column)
  const row = Number.isFinite(Number(id))
    ? db.prepare(`SELECT t.* FROM ${table} t WHERE t.id=? AND ${sc.sql}`).get(Number(id), ...sc.params)
    : null
  if (!row) {
    const e = new Error(notFound)
    e.status = 404
    e.code = 'DOC_NOT_FOUND'
    throw e
  }
  return row
}

export default {
  applyStockIn,
  applyStockOut,
  applyOwnershipTransfer,
  reserveStock,
  releaseStock,
  availableQty,
  reservationsOf,
  reserveForDoc,
  consumeStock,
  planShipment,
  releaseForDoc,
  pickBatches,
  queryBalance,
  costOf,
  resolveOwnerOrg,
  resolveCurrency,
  getInvParam,
  clearParamCache,
  clearInvTypeCache,
  getStockRow,
  stockScopeSql,
  warehouseInScope,
  assertWarehouseInScope,
  assertStockDocInScope,
  DOC_TYPE_LABEL
}
