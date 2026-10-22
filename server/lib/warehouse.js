/**
 * ============================================================================
 * 文件标识：server/lib/warehouse.js ｜ 仓库（warehouses）的**类型字典**、**可用性判据**、**「单据类型 → 允许仓库」白名单**的唯一出处。
 * ============================================================================
 * 【职责】仓库（warehouses）的**类型字典**、**可用性判据**、**「单据类型 → 允许仓库」白名单**的唯一出处。
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 仓库（warehouses）的**类型字典**、**可用性判据**、**「单据类型 → 允许仓库」白名单**的唯一出处。
//
// 依赖方向：本文件只依赖 `lib/settings.js`（它自己不 import 任何 db/ 模块），
// 所以 `stock.js` / `purchase.js` 引它都不会成环，也不新增到 `db/index.js` 的静态路径。
import { readSetting } from './settings.js'
//
// ===========================================================================
// 一、为什么类型必须枚举（客户口径：仓库要能自己建）
// ===========================================================================
// 客户原话：「仓库是可以客户自己新建的，出入库单据类型也是客户新建的，以应对多种情况。」
// 能新建 ⇒ 就一定会有人建出**拼错的类型**。而不枚举的后果不是报错，是**静默**：
//   · 仓建出来了、也停用不了（因为不知道该期待哪些值）；
//   · 界面上那一列渲染成一个没有名字的灰点（`routes/meta.js` 的字典里没有这个词）；
//   · 质量处置那条线按 `type` 找隔离仓（`lib/qc2.js` 的 `quarantineWarehouse`），
//     找到不到就**拒绝执行**，而用户完全看不出是自己把类型写错了一个字母。
// 所以类型在这里定死一份，界面文案、接口校验、隔离仓查找三方共用它。
//
// 三处历史定义在本文件合并（这是本次唯一要消灭的东西）：
//   · `routes/meta.js` 的 `warehouse_types`（界面文案）—— 现在从这里取；
//   · `lib/qc2.js` 的 `DISPOSITION_TARGET`（处置 → 目标仓类型）—— 取值必须 ∈ 本表；
//   · `db/schema.sql` 的列注释（`central/region/store/ecom`）—— 它只是注释，不含格式约束。
//
// ===========================================================================
// 二、`kitchen` / `normal` 为什么也在表里（不是凑数）
// ===========================================================================
//   · `kitchen`（中央厨房仓）：餐饮线的 `WH90 中央厨房·净菜中心` **就是**这个类型
//     （`db/org-seed.js` 的 kitchen 分支 + `db/procure-seed.js:331` 按它挑仓）。
//     它原来不在 `warehouse_types` 里 ⇒ 界面上显示的是裸串 `kitchen`。
//     **而且**：本表同时是「改仓」接口的取值域，表里没有它 ⇒ 那行仓**永远改不了**。
//   · `normal`：`db/schema.sql` 里 `warehouses.type` 的 **DEFAULT 就是 'normal'**。
//     任何绕过本接口插进去的仓都可能是它；把它排除在外，等于让这些行在界面上"看得见、改不动"。
//
// ===========================================================================
// 三、可用性判据（停用仓不许再被新单据选中）
// ===========================================================================
// 「停用仓不能建单」必须**只有一处判据**。写两份的下场本项目已经踩过：
// 界面上选不到、接口还收得下 —— 一份单据安静地落在了一个已经封存的仓上。
// 判据分两半，两半都要在，缺一半就漏一个入口：
//   · 界面**下拉不列它**：`routes/master.js` 的 `/master/options` 只出 `status='active'`；
//   · 后端**建单拒收它**：`assertWarehouseUsable()`（本文件），由建单入口调用。
// 后半段原先根本不存在（历史单据按 `warehouse_id` 存着，改状态不影响它们 ——
// 所以"停用"是安全的，而"停用后还能被选中"不是）。

/** 仓库类型字典：`code → 中文名`。**界面文案与取值域的唯一出处。** */
export const WAREHOUSE_TYPES = {
  central: '中心总仓',
  region: '区域仓',
  store: '门店仓',
  ecom: '电商仓',
  kitchen: '中央厨房仓',
  forward: '前置仓',
  cloud: '云仓',
  // 质量隔离仓：不良品处置（让步接收 / 返工）会自动生成调拨单把货挪进这两类仓。
  // 它们是「这批货为什么不在了」的答案，所以必须有名字。
  defect: '不合格品仓',
  quarantine: '待检品仓',
  normal: '普通仓'
}

/** 全部合法类型码（顺序 = 定义表顺序，界面上按它排） */
export const WAREHOUSE_TYPE_CODES = Object.keys(WAREHOUSE_TYPES)

/** 仓库状态的取值域。`inactive` 就是「停用」—— 不许物理删除（历史单据按仓库引用）。 */
export const WAREHOUSE_STATUS = { active: '启用', inactive: '停用' }

/**
 * **隔离仓类型**（不合格品仓 / 待检品仓）。
 *
 * 语义：隔离仓是**质量隔离**用的，不是经营仓 —— 货只能由质检处置的调拨单调进去，
 * **绝不能被"选发货仓 / 选货源仓"这类下拉选中**（否则一张销售单可以直接从不合格品仓发货，
 * 而且没有任何地方会报错）。所以这两个类型要从 `/master/options` 的仓库候选里排除。
 *
 * ⚠️ 为什么是**排除**而不是"只允许"：客户能自建类型（§2.1），将来的类型默认都是可经营的；
 *    只有明确属于"隔离"语义的类型才排除。这张表是"哪些类型是隔离仓"的唯一出处。
 */
export const ISOLATION_WAREHOUSE_TYPES = ['defect', 'quarantine']

export const isIsolationWarehouseType = (type) => ISOLATION_WAREHOUSE_TYPES.includes(String(type ?? ''))

// ---------------------------------------------------------------------------
// 「单据类型 → 允许的仓库集合」（最高层设计 §7.1 客户已拍的口径）
// ---------------------------------------------------------------------------
// 客户原话：「某一类单据进客户指定仓库。」
//
// 为什么要这张配置（而不是在各模块里写死）：
//   第 0 层的判据是"任何『能不能……』必须在第 0 层有唯一出处"（设计文档 §1）。
//   "这种单据能不能用这个仓"就是一条"能不能"，所以它只能在这里表达：
//     · **同一张配置**也用来表达"不合格品必须进不合格仓"（同一个形状的两个用例）——
//       不另造第二套机制（那是本项目最贵的一类缺陷，设计文档 §2.3）；
//     · 默认 `*` = **不限** ⇒ 与上线前的实际行为逐条一致（设计文档 §3 第②条）。
//
// 值的形状（`settings` 的 `inv_doc_warehouse_scope`，type=text）：
//     `*`                                    不限（默认值，= 改动前行为）
//     `PUR_IN=WH01|WH02;SAL_OUT=WH03`         按单据类型给白名单；没列到的类型 = 不限
//   单据类型的取值域与 `inv_txn_types.code` 同一套（出入库单据类型主数据），不另造一套码。
export const DOC_WAREHOUSE_SCOPE_KEY = 'inv_doc_warehouse_scope'
/** `*` = 不限。**它是默认值** —— 客户不改这个键时，判据必须一条都不生效。 */
export const DOC_WAREHOUSE_SCOPE_UNRESTRICTED = '*'

const DOC_TYPE_RE = /^[A-Z][A-Z0-9_]*$/
const WH_CODE_RE = /^[A-Za-z0-9._-]+$/

/**
 * 解析配置串。**永不抛** —— 把"哪里写错了"如实收进 `problems`，
 * 由调用方（`assertWarehouseAllowedForDoc`）**响亮拒绝**而不是静默当成"没配"。
 *
 * 为什么不能让坏值静默退化成"不限"：那等于**客户以为自己限制住了、其实一张单都没限制**，
 * 属于设计文档 §5 明令禁止的"读不到就用默认值"的静默兜底。
 */
export function parseDocWarehouseScope(raw) {
  const s = String(raw ?? '').trim()
  const problems = []
  const map = new Map()
  if (s === '' || s === DOC_WAREHOUSE_SCOPE_UNRESTRICTED) return { map, problems }
  for (const seg of s.split(/[;\n]/)) {
    const t = seg.trim()
    if (!t) continue
    const i = t.indexOf('=')
    if (i <= 0 || i === t.length - 1) {
      problems.push(`「${t}」不是「单据类型=仓编码」的形状`)
      continue
    }
    const docType = t.slice(0, i).trim().toUpperCase()
    const rest = t.slice(i + 1).trim()
    if (!DOC_TYPE_RE.test(docType)) {
      problems.push(`单据类型「${docType}」只允许大写字母 / 数字 / 下划线（与出入库单据类型码同一取值域）`)
      continue
    }
    if (rest === DOC_WAREHOUSE_SCOPE_UNRESTRICTED) {
      map.set(docType, null) // 这一类单据显式声明"不限"
      continue
    }
    const codes = rest.split('|').map((x) => x.trim()).filter(Boolean)
    if (!codes.length) {
      problems.push(`单据类型「${docType}」没给出任何仓编码`)
      continue
    }
    const bad = codes.filter((c) => !WH_CODE_RE.test(c))
    if (bad.length) {
      problems.push(`仓编码 ${bad.join('、')} 含非法字符（只允许字母 / 数字 / . _ -）`)
      continue
    }
    map.set(docType, new Set(codes.map((c) => c.toUpperCase())))
  }
  return { map, problems }
}

/** 读这张配置（**唯一读取点**）。返回 `{ map, problems }`。 */
export function docWarehouseScope(db) {
  return parseDocWarehouseScope(readSetting(db, DOC_WAREHOUSE_SCOPE_KEY))
}

/**
 * 某类单据允许的仓库集合。
 * @returns `{ allowed: Set<string>|null|undefined, problems: string[] }`
 *   · `Set`         —— 白名单（仓**编码**）
 *   · `null`        —— 这一类显式声明"不限"（写了 `TYPE=*`）
 *   · `undefined`   —— 这一类**没在配置里出现过** ⇒ 不限（默认行为）
 */
export function allowedWarehouseCodesForDoc(db, docType) {
  const { map, problems } = docWarehouseScope(db)
  const t = String(docType ?? '').trim().toUpperCase()
  return { allowed: map.has(t) ? map.get(t) : undefined, problems }
}

/**
 * **选仓处的强制点**：某类单据选了一个不在许可集里的仓 ⇒ 拒绝。
 *
 * @param {{ docType: string, warehouse: object|null, role?: string }} p
 *   · `warehouse` 传**仓行**（`{ code, name }`）而不是 id —— 判据比的是编码，
 *     而编码是历史单据与外部系统的引用键（`assertWarehouseCodeFree` / 编码不可改同一条理由）。
 * @returns true（放行）；拒绝时抛 `WAREHOUSE_NOT_ALLOWED_FOR_DOC`(409)
 */
export function assertWarehouseAllowedForDoc(db, { docType, warehouse, role = '仓库' }) {
  const t = String(docType ?? '').trim().toUpperCase()
  const { allowed, problems } = allowedWarehouseCodesForDoc(db, t)
  if (problems.length) {
    throw new WarehouseError(
      'WAREHOUSE_SCOPE_INVALID',
      `配置「单据类型允许仓库」（供应链参数）有 ${problems.length} 处写法不对：${problems.join('；')}。` +
        '在改对之前，任何单据都不会放行 —— 因为放行等于**静默忽略**客户配的限制。',
      409,
      { problem_count: problems.length, problems: problems.slice(0, 5), setting_key: DOC_WAREHOUSE_SCOPE_KEY }
    )
  }
  if (!allowed) return true // 不限（没配 / 显式 TYPE=*）
  const code = String(warehouse?.code ?? '').toUpperCase()
  if (allowed.has(code)) return true
  throw new WarehouseError(
    'WAREHOUSE_NOT_ALLOWED_FOR_DOC',
    `${role}「${warehouse?.code} ${warehouse?.name}」不在「${t}」这类单据允许的仓库里（允许：${[...allowed].join(' / ')}）。` +
      '这是「系统设置 → 供应链参数 → 单据类型允许仓库」配的，要放行请把该仓编码加进去。',
    409,
    { doc_type: t, warehouse_code: warehouse?.code, allowed: [...allowed], role }
  )
}

/** 与 `SettingError` / `PurchaseError` 同形状：`.status` + `.code`，由全局 errorHandler 翻译成响应 */
export class WarehouseError extends Error {
  constructor(code, message, httpStatus = 400, detail = null) {
    super(message)
    this.code = code
    this.status = httpStatus
    this.detail = detail
  }
}

/** 类型 → 中文名。**认不出就原样回显**（不编一个"未知仓"——那会把拼错的类型藏起来） */
export function warehouseTypeLabel(type) {
  const k = String(type ?? '')
  return WAREHOUSE_TYPES[k] || k
}

export function isWarehouseType(type) {
  return Object.hasOwn(WAREHOUSE_TYPES, String(type ?? ''))
}

/** 取值域校验。不合法 ⇒ 400 + 人话 + 候选清单（与 `industryError` 同一形状）。 */
export function assertWarehouseType(type) {
  const t = String(type ?? '').trim()
  if (!t) {
    throw new WarehouseError('WAREHOUSE_TYPE_REQUIRED', '仓库类型必填', 400, {
      allowed: WAREHOUSE_TYPE_CODES
    })
  }
  if (!isWarehouseType(t)) {
    throw new WarehouseError(
      'WAREHOUSE_TYPE_INVALID',
      `仓库类型「${t}」不是合法取值（可选：${WAREHOUSE_TYPE_CODES.map((c) => `${c}(${WAREHOUSE_TYPES[c]})`).join(' / ')}）`,
      400,
      { received: t, allowed: WAREHOUSE_TYPE_CODES }
    )
  }
  return t
}

/** 界面用：`[{ value, label }]`（顺序 = 定义表顺序） */
export function warehouseTypeOptions() {
  return WAREHOUSE_TYPE_CODES.map((value) => ({ value, label: WAREHOUSE_TYPES[value] }))
}

/** 取一个仓（含状态）。找不到返回 null —— 判据只有这里一处读 `warehouses`。 */
export function findWarehouse(db, id) {
  if (id === null || id === undefined || id === '') return null
  return db.prepare('SELECT id, code, name, type, status FROM warehouses WHERE id=?').get(Number(id)) || null
}

/**
 * 新建单据时校验「这个仓能用」。
 *
 * @param {object} db
 * @param {number|string} id  单据上填的 warehouse_id
 * @param {{ role?: string, required?: boolean }} [opt]
 *   · `role`      —— 报错文案里怎么称呼它（「入库仓」「调出仓」…），让用户知道是哪一格填错了；
 *   · `required`  —— true 时缺失也算错（默认 false：没填仓的单据由调用方各自决定要不要拦）。
 * @returns {object|null} 仓行（缺失且不要求时返回 null）
 *
 * ⚠️ 存在的仓但已停用 ⇒ **409**（不是 400）：这不是"参数写错了"，是"这个对象现在不能用了"。
 *    两者混成同一个码，用户会去改参数、而不是去换一个仓。
 */
export function assertWarehouseUsable(db, id, { role = '仓库', required = false } = {}) {
  if (id === null || id === undefined || id === '') {
    if (required) {
      throw new WarehouseError('WAREHOUSE_REQUIRED', `${role}必填`, 400, { role })
    }
    return null
  }
  const wh = findWarehouse(db, id)
  if (!wh) {
    throw new WarehouseError('WAREHOUSE_NOT_FOUND', `${role}不存在：id=${id}`, 400, { id, role })
  }
  if (wh.status !== 'active') {
    throw new WarehouseError(
      'WAREHOUSE_INACTIVE',
      `${role}「${wh.code} ${wh.name}」已停用，不能再用于新建单据。` +
        '历史单据不受影响；要重新启用请到「仓库与门店」把它改回「启用」。',
      409,
      // `code` 是 detail 上的**保留键**（见 `assertCodeFree` 的注释），所以用 warehouse_code
      { id: wh.id, warehouse_code: wh.code, name: wh.name, status: wh.status, role }
    )
  }
  return wh
}

export default {
  WAREHOUSE_TYPES,
  WAREHOUSE_TYPE_CODES,
  WAREHOUSE_STATUS,
  ISOLATION_WAREHOUSE_TYPES,
  DOC_WAREHOUSE_SCOPE_KEY,
  DOC_WAREHOUSE_SCOPE_UNRESTRICTED,
  WarehouseError,
  warehouseTypeLabel,
  warehouseTypeOptions,
  isWarehouseType,
  isIsolationWarehouseType,
  assertWarehouseType,
  findWarehouse,
  assertWarehouseUsable,
  parseDocWarehouseScope,
  docWarehouseScope,
  allowedWarehouseCodesForDoc,
  assertWarehouseAllowedForDoc
}
