/**
 * ============================================================================
 * 文件标识：server/routes/inv-txn-types.js ｜ 出入库单据类型 —— **客户可维护的主数据**（模块 03 × 模块 27 的交叉点）
 * ============================================================================
 * 【职责】出入库单据类型 —— **客户可维护的主数据**（模块 03 × 模块 27 的交叉点）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 出入库单据类型 —— **客户可维护的主数据**（模块 03 × 模块 27 的交叉点）
//
// 客户口径（原话）：
//   「仓库是可以客户自己新建的，出入库单据类型也是客户新建的，以应对多种情况。」
//   「一般都是做一种类型的出库，然后这种出库对于一种类型的财务核算。」
//
// 在此之前 `inv_txn_types` 只能靠迁移文件改（`003` / `022` / `045`）——
// 客户看得见它（台账的"业务类型"列），却改不动它。
//
// 本文件把它变成可维护的：
//   · **新增**：客户自己起一个码（例：`REPAIR_OUT` 维修出库），立刻能用于新单据；
//   · **改名**：改的是**界面文案**（`name`），码不变 —— 历史流水按码引用，改名不动历史；
//   · **停用**：`status='inactive'`。**不物理删除**（历史流水还引用着它）；
//     停用之后**新流水会被硬拦**（判据在唯一写入口 `lib/stock.js` 的 `writeTxn`，
//     一处拦住 = API / MCP / POS / seed 全拦住），而不是只改个界面标签。
//
// 三个"业务选择"字段（都是客户口径的直接落点）：
//   · `direction`  —— 入 / 出。**建单时定，之后不可改**：流水里那一列是历史事实，
//                    允许改方向只会让"这个类型到底是进还是出"没有确定答案。
//   · `saleable_only` —— 是否受「可售性闸门」约束（原先是 `stock.js` 里的硬编码名单）。
//   · `ledger_subject_code` —— **预留位，任何入口都不可写** ——
//                    **`[未接线 · 依赖"出库类型 → 凭证模板"映射落地]`**
//                    （team-lead 最终裁定，2026-10-16；A 方案：严格包含"保留+明示"的全部优点，
//                     并且多消掉一条"写了没效果"的写路径）：
//                    列保留（将来改为指向"出库类型 → 凭证模板"，第 0 层 §7.2），但
//                    ① 界面上**只读展示 + 明示它不生效**（hint 已写清现状与原因）；
//                    ② **接口（POST/PUT）对非空写入一律拒**，码 `INV_TYPE_LEDGER_RESERVED`。
//                    为什么要拒接口而不只是"界面上不暴露"：**铁律 17 —— 「无意义的动作」必须由
//                    闸门明确拒绝 + 一句人话**。这一列写了不产生任何效果，接受它等于留一条
//                    **静默无反应的写路径**（与"界面能填却没反应"同一件事，只是入口换成接口）。
//                    空/缺省不算"写" ⇒ 放行，所以界面上那格只读展示不会把正常保存弄红。
//                    原先那套值域口径（照抄 `lib/settings.js` 的 `type:'subject'`：纯数字、≥3 位、
//                    **不校验科目是否存在**）**随本字段一起暂停**；等真正开始取科目时再按当时的
//                    口径重新引入，而不是现在留一份没人走的校验。
//                    ⚠️ **为什么不接进凭证生成**：现有凭证由**来源单据**驱动（`BIZ_TYPES` 六场景的
//                    `source_type` 全是单据表）。再挂一条"库存异动 → 凭证"的触发链，
//                    **同一笔业务会被记两遍账**（发货单一次、库存流水又一次）——
//                    而**重复记账比漏记更危险**：漏记能查出来（借贷不平/单据找不到凭证），
//                    **重复记账会让两套报表各自自洽地错**，谁也不发现。
//                    要接必须先定"谁负责记这笔、另一侧不记"（例如凭证一律由来源单据驱动，
//                    本列只作为取科目时的口径参与单据分录）—— 那是另一个决定。
//                    客户确认的粒度是"**一套凭证模板**"（第 0 层 §7.2）；模板实体已存在可复用。
//
// 权限：沿用既有角色门（`admin` / `warehouse`）—— **不新造权限点**。
//   理由：本项目权限点是"模块级菜单/动作"，而"维护出入库类型"与"维护仓库"同属仓储主数据，
//   仓库那几个接口用的就是 `requireRole('admin','warehouse')`（见 `routes/warehouses.js`
//   的 `WRITE`）—— 那两个常量逐字相同，不是巧合，是同一档主数据。
//
// 错误形状：本文件**只抛 `InvTypeError`**，不自己拼响应对象 ——
//   带业务码的响应只允许有一个构造点（`lib/http.js` 的 `bizFail`，由全局 `errorHandler` 调用）。
//   自己拼一份形状的后果是"业务码只落在顶层 `error`、`detail` 里没有"，调用方得写两套判断。
//   判据由 `scripts/check-bizcode-shape.mjs` 的静态/动态断言守着（本文件第一次交付时就因为
//   用了 `fail(res, msg, 409, 'CODE', …)` 的位置参数形态被它抓红）。
//
//   ⚠️ `detail` 里**不许再用 `code` 这个键名**：`bizFail` 把业务码写在 `detail.code` 上
//   （`{ ...err.detail, code }`）—— 我在 `detail` 里再放一个 `code`（装的是**类型码** `SAL_OUT`），
//   业务码会把它**静默覆盖**，调用方读到的 `detail.code` 是业务码、类型码凭空消失，
//   而"两个值不同"这件事不会报任何错（与 `lib/agreement.js` 拿 `code` 装协议号是同一个坑）。
//   所以类型码一律走 **`docType`**（与 `lib/stock.js` 的 `INV_TYPE_INACTIVE` 载荷同键名）。
import { Router } from 'express'
import { getDb } from '../db/index.js'
import { ok, wrap, pageParams, paged } from '../lib/http.js'
import { requireAuth, requireRole } from '../middleware/auth.js'
import { audit } from '../middleware/audit.js'
import { clearInvTypeCache } from '../lib/stock.js'

const r = Router()
const WRITERS = ['admin', 'warehouse']

/** 类型码：大写字母开头 + 大写字母/数字/下划线。与既有码（`SAL_OUT` / `MR` / `QC_RET_OUT`）同形 */
const CODE_RE = /^[A-Z][A-Z0-9_]{1,23}$/
const DIRECTIONS = ['in', 'out']

// 本表**没有** created_at / updated_at 列（`003_inv_dict.cjs` 建表时没建）。
// 不为此加列：这两个时间不属于本次要表达的"业务选择"，而加列要走迁移 —— 收益仅是好看。
const SELECT_COLS = 'code, name, direction, biz_category, cost_effect, status, sort_order, saleable_only, ledger_subject_code'

/** 本路由的领域错误：`{ message, status, code, detail }` —— 与 `WarehouseError` 同形 */
class InvTypeError extends Error {
  constructor(code, message, status = 400, detail = null) {
    super(message)
    this.code = code
    this.status = status
    this.detail = detail
  }
}

/** 行 → 接口形状。`id` 用 `code`：本表主键就是码，而 `DataPage` 按 `row.id` 拼详情路由 */
const toRow = (x) => ({ ...x, id: x.code, saleable_only: Number(x.saleable_only) === 1 })

/** 0/1 归一：只认 0/1（缺省 = 0 = 不受约束，与建列默认值一致） */
function normFlag(v) {
  if (v === undefined || v === null || v === '') return 0
  if (v === true || v === 1 || v === '1') return 1
  if (v === false || v === 0 || v === '0') return 0
  throw new InvTypeError('INV_TYPE_BAD_FLAG', `开关取值只能是 0 / 1，收到「${v}」`, 400, { received: v })
}

/**
 * 预留位：`ledger_subject_code` **任何非空写入都拒**（空 / 缺省不算"写"，因此放行）。
 *
 * 为什么连**接口**也拒（不只是界面上不暴露）：铁律 17 ——
 *   **「无意义的动作」必须由闸门明确拒绝 + 一句人话。**
 *   这一列现在写了**不产生任何效果**（没有接进凭证生成），接受它等于留一条
 *   **静默无反应的写路径**；那与"界面能填却没有任何反应"是同一件事，只是入口从界面换成了接口。
 *   ⇒ 代价（多一个只为占位存在的机制）换的是"没有静默无反应的写"，值。
 *
 * 为什么末尾不校验"科目是否存在"（原来那股口径的去向）：那套口径（纯数字、≥3 位、
 * 不查存在性）**连同这个字段一起暂停使用** —— 等"出库类型 → 凭证模板"落地、
 * 真正开始取科目时再按当时的口径重新引入，而不是现在留一份没人走的校验。
 */
function assertLedgerReserved(v) {
  if (v === undefined || v === null || v === '') return
  throw new InvTypeError(
    'INV_TYPE_LEDGER_RESERVED',
    '财务核算科目当前是预留位（尚未产生凭证），不可写入；'
      + '它将在「出库类型 → 凭证模板」映射落地时改为指向模板',
    400,
    { field: 'ledger_subject_code', received: v }
  )
}

const txnRowsOf = (db, code) =>
  db.prepare('SELECT COUNT(*) c FROM inventory_transactions WHERE doc_type=?').get(code).c

r.get(
  '/',
  requireAuth,
  wrap((req, res) => {
    const db = getDb()
    const { page, pageSize, offset } = pageParams(req)
    const where = []
    const params = []
    if (req.query.keyword) {
      where.push('(code LIKE ? OR name LIKE ?)')
      const kw = `%${req.query.keyword}%`
      params.push(kw, kw)
    }
    if (req.query.status) {
      where.push('status = ?')
      params.push(String(req.query.status))
    }
    if (req.query.direction) {
      where.push('direction = ?')
      params.push(String(req.query.direction))
    }
    if (req.query.saleable_only === '1' || req.query.saleable_only === 'true') where.push('saleable_only = 1')
    const w = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) c FROM inv_txn_types ${w}`).get(...params).c
    const rows = db
      .prepare(`SELECT ${SELECT_COLS} FROM inv_txn_types ${w} ORDER BY sort_order, code LIMIT ? OFFSET ?`)
      .all(...params, pageSize, offset)
    return paged(res, { rows: rows.map(toRow), total, page, pageSize })
  })
)

r.post(
  '/',
  requireAuth,
  requireRole(...WRITERS),
  wrap((req, res) => {
    const db = getDb()
    const b = req.body || {}
    const code = String(b.code || '').trim().toUpperCase()
    const name = String(b.name || '').trim()
    const direction = String(b.direction || '').trim()
    if (!CODE_RE.test(code)) {
      throw new InvTypeError('INV_TYPE_BAD_CODE', '类型编码只能是大写字母开头的 2–24 位大写字母 / 数字 / 下划线（例：REPAIR_OUT）', 400, { received: b.code })
    }
    if (!name) throw new InvTypeError('INV_TYPE_NAME_REQUIRED', '类型名称必填', 400)
    if (!DIRECTIONS.includes(direction)) {
      throw new InvTypeError('INV_TYPE_BAD_DIRECTION', '方向必须是 in（入库）或 out（出库）', 400, { received: b.direction })
    }
    if (db.prepare('SELECT 1 h FROM inv_txn_types WHERE code=?').get(code)) {
      throw new InvTypeError('INV_TYPE_CODE_EXISTS', `类型编码「${code}」已存在；编码建立后不可更改，请换一个`, 409, { docType: code })
    }
    const saleableOnly = normFlag(b.saleable_only)
    // 预留位：非空写入在这里就被拒（界面已只读、不发这个键；直连 API 才是这条判据的客户）
    assertLedgerReserved(b.ledger_subject_code)
    const nextSort = (db.prepare('SELECT COALESCE(MAX(sort_order),0) m FROM inv_txn_types').get().m || 0) + 10
    // `biz_category` / `cost_effect` **不开放给界面**：前者只影响分组展示，后者会改变成本口径
    // （`transfer` 成本平移 / `no_cost` 不结转）—— 让客户在类型维护页上误改分类会静默改账。
    // 新类型一律按最中性的取值落库：other + normal。
    db.prepare(
      `INSERT INTO inv_txn_types (code,name,direction,biz_category,cost_effect,status,sort_order,saleable_only,ledger_subject_code)
       VALUES (?,?,?,'other','normal','active',?,?,NULL)`
    ).run(code, name, direction, nextSort, saleableOnly)
    clearInvTypeCache(db)
    audit(req, { action: 'CREATE', module: 'master', entity: 'inv_txn_types', entityId: code, detail: name })
    return ok(res, toRow(db.prepare(`SELECT ${SELECT_COLS} FROM inv_txn_types WHERE code=?`).get(code)))
  })
)

r.put(
  '/:code',
  requireAuth,
  requireRole(...WRITERS),
  wrap((req, res) => {
    const db = getDb()
    const code = String(req.params.code || '').trim()
    const exist = db.prepare(`SELECT ${SELECT_COLS} FROM inv_txn_types WHERE code=?`).get(code)
    if (!exist) throw new InvTypeError('INV_TYPE_NOT_FOUND', `出入库类型不存在：${code}`, 404, { docType: code })
    const b = req.body || {}

    // 码与方向：**建单时定，之后不可改**。共同点是"历史流水已经按它记过账"：
    // 改码会让老流水指向一个不存在的类型（台账显示裸码、守卫 ① 判红、报表口径断掉）；
    // 改方向会让"这个类型是进还是出"在同一张表里有两个答案。
    if (b.code !== undefined && String(b.code).trim() !== '' && String(b.code).trim() !== code) {
      throw new InvTypeError('INV_TYPE_CODE_IMMUTABLE', `类型编码不可修改（历史流水按「${code}」引用它）。需要别的码请新增一条`, 409, { docType: code })
    }
    if (b.direction !== undefined && String(b.direction) !== exist.direction) {
      throw new InvTypeError('INV_TYPE_DIRECTION_IMMUTABLE', `方向不可修改（建单时定的「${exist.direction}」）。需要别的方向请新增一条`, 409, { docType: code, direction: exist.direction })
    }

    const sets = []
    const vals = []
    if (b.name !== undefined) {
      const name = String(b.name).trim()
      if (!name) throw new InvTypeError('INV_TYPE_NAME_REQUIRED', '类型名称不能为空', 400)
      sets.push('name=?')
      vals.push(name)
    }
    if (b.status !== undefined) {
      const status = String(b.status)
      if (!['active', 'inactive'].includes(status)) {
        throw new InvTypeError('INV_TYPE_BAD_STATUS', '状态只能是 active（启用）/ inactive（停用）', 400, { received: b.status })
      }
      sets.push('status=?')
      vals.push(status)
    }
    if (b.saleable_only !== undefined) {
      sets.push('saleable_only=?')
      vals.push(normFlag(b.saleable_only))
    }
    // 预留位：**PUT 同样拒**（非空值）。空/缺省不算"写"，因此界面上只读展示那一格不会把保存弄红。
    assertLedgerReserved(b.ledger_subject_code)
    if (b.sort_order !== undefined) {
      sets.push('sort_order=?')
      vals.push(Number(b.sort_order) || 0)
    }
    if (!sets.length) throw new InvTypeError('INV_TYPE_NO_FIELDS', '没有需要更新的字段', 400)
    db.prepare(`UPDATE inv_txn_types SET ${sets.join(', ')} WHERE code=?`).run(...vals, code)
    clearInvTypeCache(db)
    audit(req, { action: 'UPDATE', module: 'master', entity: 'inv_txn_types', entityId: code, detail: sets.join(',') })
    return ok(res, toRow(db.prepare(`SELECT ${SELECT_COLS} FROM inv_txn_types WHERE code=?`).get(code)))
  })
)

// 显式拒绝物理删除：库存流水/成本流水都按 `doc_type` 引用它，删了会让老单据变成孤儿。
// 定义这条路由**本身就是文档** —— 前端用 `allowDelete={false}` 不显示删除按钮，
// 但接口层不能靠"前端不显示"来保证数据不被删。
r.delete(
  '/:code',
  requireAuth,
  requireRole('admin'),
  wrap((req, res) => {
    const db = getDb()
    const code = String(req.params.code || '').trim()
    if (!db.prepare('SELECT 1 h FROM inv_txn_types WHERE code=?').get(code)) {
      throw new InvTypeError('INV_TYPE_NOT_FOUND', `出入库类型不存在：${code}`, 404, { docType: code })
    }
    const n = txnRowsOf(db, code)
    throw new InvTypeError(
      'INV_TYPE_NO_DELETE',
      `出入库类型不可删除（${n > 0 ? `已有 ${n} 条库存流水引用「${code}」` : '历史流水可能引用它'}` +
        '）。请把「状态」改为「停用」—— 停用后新单据不能再写这种类型，历史流水与报表不受影响。',
      409,
      { docType: code, txn_rows: n }
    )
  })
)

export default r
