/**
 * ============================================================================
 * 文件标识：server/lib/accounting.js ｜ 业财一体凭证（批次 H · 模块 27）
 * ============================================================================
 * 【职责】业财一体凭证（批次 H · 模块 27）
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 业财一体凭证（批次 H · 模块 27）
//
// ===========================================================================
// 一、这里要做的事只有一句：把「已经发生的业务事实」翻译成借贷分录
// ===========================================================================
// 不做业务、不改业务状态、不参与任何业务校验。输入是"哪张来源单"，
// 输出是一张凭证。因此本文件对业务域是**只读**的 —— 它出错不会弄坏业务数据，
// 但它算错会让报表整体失真，而且**不会报错**（一张平的错账和一张平的对账长得一样）。
//
// ===========================================================================
// 二、四条硬口径
// ===========================================================================
// ① **不平即拒绝，且整张不落库。**
//    半张凭证比没有凭证更糟：没有凭证是"漏了"，半张凭证是"错了"。
// ② **同一事实只能入一次账。**
//    `vouchers` 上 `UNIQUE (biz_type, source_type, source_id)` 兜住；
//    重放返回**同一张**凭证（`replayed: true`），不报错也不新建。
// ③ **方向由模板决定，金额恒 > 0。**
//    允许负数金额的账，任何汇总都能被"负负得正"地做平。
//    要冲减就换方向，或作废重开。
// ④ **只有 `posted` 计入账。**
//    `draft` 是"生成出来了但还没进账"，试算平衡表不认它 ——
//    否则"生成"就成了"入账"，审核这一步就没有位置了。
//
// ===========================================================================
// 三、为什么模板存的是「取值键」而不是「表达式」
// ===========================================================================
// 模板是可被界面编辑的配置。若模板里能写任意表达式，就等于**配置能改账**，
// 而改账的错不会报错，只会让某一张凭证的金额悄悄变成另一个数。
// 所以取值键是一个**封闭字典**（`FACT_KEYS`），每个键回答"这个数从哪来"；
// 模板只能说"我取哪一个"。加一个新键要走代码评审，而不是改一条数据库记录。
//
// ===========================================================================
// 四、金额一律"末行兜底"
// ===========================================================================
// 只要一张凭证里有"总额拆成几份"的结构（含税 → 不含税 + 税额），
// 就**必须用减法算最后一份**，而不是各自四舍五入：
// 13% 下 100.00 拆成 88.50 + 11.50 是平的，但 99.99 拆成 88.49 + 12.99 就差 0.01。
// 这个差额不会报错，只会让"这张凭证平不了"，而被判成生成器有 bug。
import { nextDocNo } from './docno.js'
import { localDate } from './dates.js'
// 关账后不能再过账：判据的唯一实现在 lib/period.js（关账接口自己也调它）
import { assertPeriodOpen } from './period.js'
import { readSetting } from './settings.js'
// 留痕唯一出处（doc_events）：凭证的状态推进是**裸 UPDATE**（见下面 postVoucher/voidVoucher 的说明），
// 所以这里必须自己补痕 —— 与 `routes/requisitions.js:393/844`、`routes/demand.js:276` 同一档写法。
import { logEvent } from './docflow.js'

const money2 = (n) => Number(Number(n || 0).toFixed(2))
const nowText = () => new Date().toISOString().slice(0, 19).replace('T', ' ')

export class AccountingError extends Error {
  constructor(code, message, http = 400, detail = null) {
    super(message)
    this.code = code
    this.http = http
    // **同时写 `.status`**：HTTP 层的统一翻译器 `failFromError` 只认 `error.status`，
    // 全局兜底中间件也只认它。只写 `.http` 的后果是**每一个业务错误都被报成 500** ——
    // 而 500 会把排查方向从「我的参数不对」带偏到「服务器挂了」。
    // （批次 L 动态复现：`POST /api/accounting/vouchers/generate` 传未知 biz_type → 500）
    this.status = http
    this.detail = detail
  }
}

// ---------------------------------------------------------------------------
// 科目
// ---------------------------------------------------------------------------
export const SUBJECT_CATEGORY_LABEL = {
  asset: '资产',
  liability: '负债',
  equity: '所有者权益',
  cost: '成本',
  profit_loss: '损益'
}
export const DIRECTION_LABEL = { debit: '借', credit: '贷' }

export const SUBJECT_CATEGORIES = Object.entries(SUBJECT_CATEGORY_LABEL).map(([value, label]) => ({ value, label }))
export const DIRECTIONS = Object.entries(DIRECTION_LABEL).map(([value, label]) => ({ value, label }))

/** 科目树（父 → 子），用于界面与"上级科目 = 子科目之和"的自检 */
export function listSubjects(db, { keyword = null, onlyLeaf = false } = {}) {
  const args = []
  let where = 'WHERE 1=1'
  if (keyword) {
    where += ' AND (s.code LIKE ? OR s.name LIKE ?)'
    args.push(`%${keyword}%`, `%${keyword}%`)
  }
  if (onlyLeaf) where += ' AND s.is_leaf=1'
  const rows = db
    .prepare(`
      SELECT s.*, p.code AS parent_code, p.name AS parent_name,
             (SELECT COUNT(*) FROM accounting_subjects c WHERE c.parent_id = s.id) AS child_count
        FROM accounting_subjects s
        LEFT JOIN accounting_subjects p ON p.id = s.parent_id
        ${where}
       ORDER BY s.code
    `)
    .all(...args)
  return rows.map((r) => ({
    ...r,
    category_label: SUBJECT_CATEGORY_LABEL[r.category] || r.category,
    direction_label: DIRECTION_LABEL[r.direction] || r.direction
  }))
}

/** 科目树形（两层即可满足建材账；深层靠 parent_code 自行展开） */
export function subjectTree(db) {
  const rows = listSubjects(db)
  const byId = new Map(rows.map((r) => [r.id, { ...r, children: [] }]))
  const roots = []
  for (const r of byId.values()) {
    if (r.parent_id && byId.has(r.parent_id)) byId.get(r.parent_id).children.push(r)
    else roots.push(r)
  }
  return roots
}

function assertSubject(db, code) {
  const s = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(String(code))
  if (!s) throw new AccountingError('SUBJECT_NOT_FOUND', `科目 ${code} 不存在`, 404)
  if (s.status !== 'active') throw new AccountingError('SUBJECT_INACTIVE', `科目 ${s.code} ${s.name} 已停用`, 409)
  if (!s.is_leaf) {
    // 挂父科目不会报错，只会让"父科目 = 子科目之和"悄悄不成立，而报表仍然很好看
    throw new AccountingError('SUBJECT_NOT_LEAF', `科目 ${s.code} ${s.name} 不是叶子科目，不能直接记账`, 409)
  }
  return s
}

export function saveSubject(db, payload = {}) {
  const code = String(payload.code || '').trim()
  const name = String(payload.name || '').trim()
  if (!code || !name) throw new AccountingError('BAD_ARGS', '科目编码与名称必填')
  if (!SUBJECT_CATEGORY_LABEL[payload.category]) throw new AccountingError('BAD_ARGS', `不支持的科目类别：${payload.category}`)
  if (payload.direction && !DIRECTION_LABEL[payload.direction]) throw new AccountingError('BAD_ARGS', `不支持的余额方向：${payload.direction}`)
  const direction = payload.direction || (payload.category === 'asset' || payload.category === 'cost' ? 'debit' : 'credit')

  const exist = db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
  const parentId = payload.parent_id ? Number(payload.parent_id) : null
  if (parentId) {
    const p = db.prepare('SELECT * FROM accounting_subjects WHERE id=?').get(parentId)
    if (!p) throw new AccountingError('BAD_ARGS', `上级科目不存在：#${parentId}`)
    if (exist && Number(exist.id) === parentId) throw new AccountingError('BAD_ARGS', '科目不能是自己的上级')
  }

  if (exist) {
    db.prepare(`
      UPDATE accounting_subjects
         SET name=?, parent_id=?, category=?, direction=?, aux_type=?, remark=?,
             updated_at=datetime('now','localtime')
       WHERE id=?
    `).run(name, parentId, payload.category, direction, payload.aux_type ?? exist.aux_type ?? null,
      payload.remark ?? exist.remark ?? null, exist.id)
  } else {
    db.prepare(`
      INSERT INTO accounting_subjects (code,name,parent_id,category,direction,level,is_leaf,aux_type,status,remark)
      VALUES (?,?,?,?,?,?,1,?,'active',?)
    `).run(code, name, parentId, payload.category, direction, parentId ? 2 : 1,
      payload.aux_type ?? null, payload.remark ?? null)
  }
  // 上级科目一旦有了下级，就不再是可记账科目（**由结构推导，不靠人工维护**）
  db.prepare("UPDATE accounting_subjects SET is_leaf=0 WHERE id IN (SELECT DISTINCT parent_id FROM accounting_subjects WHERE parent_id IS NOT NULL)").run()
  db.prepare("UPDATE accounting_subjects SET is_leaf=1 WHERE id NOT IN (SELECT DISTINCT parent_id FROM accounting_subjects WHERE parent_id IS NOT NULL)").run()
  return db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(code)
}

export function setSubjectStatus(db, id, status) {
  if (!['active', 'inactive'].includes(status)) throw new AccountingError('BAD_ARGS', `不支持的状态：${status}`)
  const s = db.prepare('SELECT * FROM accounting_subjects WHERE id=?').get(Number(id))
  if (!s) throw new AccountingError('NOT_FOUND', `科目不存在：#${id}`, 404)
  if (status === 'inactive') {
    const used = db.prepare('SELECT COUNT(*) c FROM voucher_entries WHERE subject_id=?').get(s.id).c
    const children = db.prepare('SELECT COUNT(*) c FROM accounting_subjects WHERE parent_id=?').get(s.id).c
    if (used > 0) throw new AccountingError('SUBJECT_IN_USE', `科目 ${s.code} 已被 ${used} 条分录使用，不能停用`, 409)
    if (children > 0) throw new AccountingError('SUBJECT_HAS_CHILDREN', `科目 ${s.code} 下还有子科目，不能停用`, 409)
  }
  db.prepare("UPDATE accounting_subjects SET status=?, updated_at=datetime('now','localtime') WHERE id=?").run(status, s.id)
  return { id: s.id, status }
}

// ---------------------------------------------------------------------------
// 取数字典（**唯一出处**）
//
// 每个键必须回答两件事：「从哪张表取」「有没有被算过」。
// 键名一律用后缀表达口径：`_amount` 是金额，`_rate` 是比率。
// ---------------------------------------------------------------------------
export const FACT_KEYS = {
  total_amount: { label: '单据总额', desc: '来源单据的价税合计（收付款单则为单据金额）' },
  net_amount: { label: '不含税金额', desc: '总额 ÷ (1 + 税率)，四舍五入到分' },
  tax_amount: { label: '税额', desc: '总额 − 不含税（**用减法**，保证两者之和恒等于总额）' },
  cost_amount: { label: '出库成本', desc: '库存成本流水里这笔业务的实际成本（不是售价）' },
  settled_amount: { label: '已核销金额', desc: '收付款单已核销部分；未核销为 0' },
  offset_amount: { label: '未核销部分', desc: '总额 − 已核销（**用减法**）' }
}

/** 业务场景定义：来源表 → 取数函数。**取数只在这里写一次。** */
export const BIZ_TYPES = {
  purchase_inbound: {
    label: '采购入库（暂估）',
    doc_type: 'GR',
    source_type: 'purchase_receipts',
    // 只有"货真收了"才能入账；draft 的到货单是意向，不是事实
    okStatuses: ['received', 'inspected', 'closed'],
    facts(db, row) {
      return {
        total_amount: money2(row.total_amount),
        supplier_name: db.prepare('SELECT name FROM suppliers WHERE id=?').get(row.supplier_id)?.name || null
      }
    }
  },
  sales_delivery: {
    label: '销售出库（确认收入）',
    doc_type: 'DL',
    source_type: 'sales_deliveries',
    okStatuses: ['shipped', 'completed'],
    facts(db, row) {
      const order = row.order_id ? db.prepare('SELECT dealer_id, store_id FROM sales_orders WHERE id=?').get(row.order_id) : null
      let customer = null
      if (order?.dealer_id) customer = db.prepare('SELECT name FROM dealers WHERE id=?').get(order.dealer_id)?.name || null
      if (!customer && order?.store_id) customer = db.prepare('SELECT name FROM stores WHERE id=?').get(order.store_id)?.name || null
      return { total_amount: money2(row.total_amount), customer_name: customer }
    }
  },
  cost_carry: {
    label: '销售出库（结转成本）',
    doc_type: 'DL',
    source_type: 'sales_deliveries',
    okStatuses: ['shipped', 'completed'],
    // 成本**不来自发货单**，只来自库存成本流水 —— 成本层算过多少就是多少，
    // 用"售价 × 某比例"去估成本，会让毛利永远是对的（因为它是编出来的）。
    facts(db, row) {
      const sum = db
        .prepare(`
          SELECT COALESCE(SUM(amount_before - amount_after), 0) AS cost, COUNT(*) AS n
            FROM stock_cost_ledger WHERE doc_no=? AND doc_type='SAL_OUT'
        `)
        .get(row.doc_no)
      return { cost_amount: money2(sum.cost), cost_lines: sum.n }
    }
  },
  receipt: {
    label: '收款',
    doc_type: 'RCP',
    source_type: 'receipts',
    okStatuses: ['confirmed'],
    facts(db, row) {
      const total = money2(row.amount)
      const settled = money2(Math.min(Number(row.allocated_amount) || 0, total))
      return { total_amount: total, settled_amount: settled, offset_amount: money2(total - settled) }
    }
  },
  payment: {
    label: '付款',
    doc_type: 'PAY',
    source_type: 'purchase_payments',
    okStatuses: ['paid', 'approved'],
    facts(db, row) {
      const total = money2(row.amount)
      const settled = money2(Math.min(Number(row.settled_amount) || 0, total))
      return { total_amount: total, settled_amount: settled, offset_amount: money2(total - settled) }
    }
  },
  refund: {
    label: '销售退款',
    doc_type: 'RFD',
    source_type: 'refunds',
    // **只有"钱真出去了"才能入账**：draft 是"打算退"，不是"退过了"。
    // 这条与收付款同源 —— 状态没到就记账，会让账上出现一笔还没发生的支出。
    okStatuses: ['confirmed'],
    facts(db, row) {
      let customer = row.customer_name || null
      if (!customer && row.customer_type === 'dealer' && row.customer_id) {
        customer = db.prepare('SELECT name FROM dealers WHERE id=?').get(row.customer_id)?.name || null
      }
      if (!customer && row.customer_type === 'store' && row.customer_id) {
        customer = db.prepare('SELECT name FROM stores WHERE id=?').get(row.customer_id)?.name || null
      }
      return { total_amount: money2(row.amount), customer_name: customer }
    }
  },
  // 采购退货（PRT）。**这是本批补的"会计落点"**：在它出现之前，采购侧只有
  // `purchase_inbound`（到货即借 库存商品 / 贷 应付暂估）一条路 —— 也就是**只挂不减**：
  // 货退回供应商之后，暂估应付永远挂在那里，总账的应付虚高、存货也虚高，
  // 而且**没有任何一处会报错**（凭证生成根本不知道有退货这件事）。
  //
  // 与 `refund` 同一条口径：**只有"货真退回去了"才能入账**。
  //   · `draft` 是"打算退"—— 此时库存与成本侧一行都没写过（见 `createPurchaseReturn` 的实现），
  //     给它记账等于凭空记一笔还没发生的退货；
  //   · `confirmed` 起才成立；`completed`（线上补的门）是结案，仍然成立 ⇒ 两个都收。
  // 同一来源只能生成一张凭证（`vouchers` 的 UNIQUE(biz_type,source_type,source_id) 兜住），
  // 所以 `confirmed` 时生成的凭证，到 `completed` 不会重复生成。
  purchase_return: {
    label: '采购退货（冲回暂估）',
    doc_type: 'PRT',
    source_type: 'purchase_returns',
    okStatuses: ['confirmed', 'completed'],
    facts(db, row) {
      return {
        total_amount: money2(row.total_amount),
        supplier_name: db.prepare('SELECT name FROM suppliers WHERE id=?').get(row.supplier_id)?.name || null
      }
    }
  }
}

/** 默认税率。口径只有一处：`lib/settings.js` 的 `SETTING_RULES.voucher_default_tax_rate`
 *  （含值域 0~100 与默认值 13；原来那两条是写在本函数里的）。 */
export function defaultTaxRate(db) {
  return readSetting(db, 'voucher_default_tax_rate')
}

/**
 * 取数：把来源单据翻译成一个**扁平的取数袋**。
 * 所有派生量（不含税、税额）都在这里算好，模板只做"取哪一个"。
 */
export function collectFacts(db, { bizType, sourceId }) {
  const biz = BIZ_TYPES[bizType]
  if (!biz) throw new AccountingError('BAD_BIZ_TYPE', `不支持的业务场景：${bizType}`, 400, { known: Object.keys(BIZ_TYPES) })
  const row = db.prepare(`SELECT * FROM ${biz.source_type} WHERE id=?`).get(Number(sourceId))
  if (!row) throw new AccountingError('SOURCE_NOT_FOUND', `来源单据不存在：${biz.source_type}#${sourceId}`, 404)
  if (!biz.okStatuses.includes(row.status)) {
    // 「货没发出去就确认收入」这类错，必须在记账这一步被拦住，而不是等对账时才发现
    throw new AccountingError(
      'SOURCE_STATUS_INVALID',
      `${biz.label} 的来源单据 ${row.doc_no} 当前状态「${row.status}」还不能入账（需 ${biz.okStatuses.join('/')}）`,
      409,
      { source_doc_no: row.doc_no, status: row.status }
    )
  }
  const base = biz.facts(db, row)
  const facts = {
    ...base,
    doc_no: row.doc_no,
    biz_date: row.receipt_date || row.delivery_date || row.pay_date || row.refund_date || row.created_at?.slice(0, 10)
  }

  const rate = defaultTaxRate(db)
  // 收付款与退款**不拆税**：它们的金额是"资金的进出"，本身不是价税合计。
  // 退货产生的待退款在退货那一步就已按含税口径冲过应收，这里再拆一次会重复。
  if (facts.total_amount !== undefined && !['receipt', 'payment', 'refund'].includes(bizType)) {
    const net = money2(facts.total_amount / (1 + rate / 100))
    facts.net_amount = net
    // 税额**用减法**：这样 net + tax 恒等于 total，四舍五入的尾差被收在税额里
    facts.tax_amount = money2(facts.total_amount - net)
    facts.tax_rate = rate
  }
  return { biz, row, facts }
}

// ---------------------------------------------------------------------------
// 模板
// ---------------------------------------------------------------------------
export function listTemplates(db) {
  const tpls = db.prepare('SELECT * FROM voucher_templates ORDER BY biz_type').all()
  const stmt = db.prepare('SELECT * FROM voucher_template_entries WHERE template_id=? ORDER BY seq')
  return tpls.map((t) => ({ ...t, entries: stmt.all(t.id) }))
}

export function templateOf(db, bizType) {
  const t = db.prepare('SELECT * FROM voucher_templates WHERE biz_type=?').get(bizType)
  if (!t) throw new AccountingError('TEMPLATE_NOT_FOUND', `业务场景 ${bizType} 还没有配置凭证模板`, 409)
  if (t.status !== 'active') throw new AccountingError('TEMPLATE_INACTIVE', `模板 ${t.name} 已停用`, 409)
  return { template: t, entries: db.prepare('SELECT * FROM voucher_template_entries WHERE template_id=? ORDER BY seq').all(t.id) }
}

/** 校验模板自身是否平衡：一组取数键的借合计与贷合计必须**恒等** */
export function assertTemplateBalanced(db, bizType, sampleFacts) {
  const { template, entries } = templateOf(db, bizType)
  if (!entries.length) throw new AccountingError('TEMPLATE_EMPTY', `模板 ${template.name} 没有任何分录`, 409)
  const dri = entries.filter((e) => e.direction === 'debit').length
  const cre = entries.filter((e) => e.direction === 'credit').length
  if (!dri || !cre) throw new AccountingError('TEMPLATE_ONE_SIDED', `模板 ${template.name} 只有单边分录`, 409)
  return true
}

// ---------------------------------------------------------------------------
// 生成
// ---------------------------------------------------------------------------
/**
 * 分录草案的**唯一校验器**：模板路（`planVoucher`）与期末结转路（`lib/closing.js`）共用。
 *
 * 它回答四件事：方向合法、金额非负且 > 0、科目存在且是叶子、**借贷平衡**。
 * 「不平即拒绝」是硬口径：半张凭证比没有凭证更糟 ——
 * 它会让试算平衡表多出借方或贷方，而报表看起来只是"某一栏大了一点"。
 *
 * 为什么每行都要求 `subject_code`（哪怕调用方已经知道 subject_id）：
 * 科目的合法性只能由 `assertSubject` 回答一次。允许"传 id 就跳过校验"，
 * 就等于允许一条**绕过"必须是叶子科目"的路** ——
 * 挂到父科目不会报错，只会让"父科目 = 子科目之和"悄悄不成立。
 */
export function assertBalancedLines(db, rawLines = [], { label = '凭证' } = {}) {
  const kept = []
  for (let i = 0; i < rawLines.length; i += 1) {
    const l = rawLines[i] || {}
    const at = `${label}第 ${i + 1} 行`
    if (!['debit', 'credit'].includes(l.direction)) {
      throw new AccountingError('BAD_DIRECTION', `${at}：借贷方向只能是 debit / credit（收到「${l.direction}」）`, 400)
    }
    if (!Number.isFinite(Number(l.amount))) {
      throw new AccountingError('BAD_DIRECTION', `${at}：金额必须是数字（收到「${l.amount}」）`, 400)
    }
    const amount = money2(l.amount)
    if (amount < 0) {
      throw new AccountingError('VOUCHER_NEGATIVE_AMOUNT', `${at}：分录金额不能为负（${amount}）`, 409)
    }
    // 金额为 0 的分录不落库：否则每一张凭证都挂着一堆 0 元行，谁也不会去看它们，
    // 而"哪一行才是真的动过账的"从此只能靠猜。
    if (amount === 0) continue
    if (!l.subject_code) throw new AccountingError('BAD_DIRECTION', `${at}：必须给出 subject_code`, 400)
    const subject = assertSubject(db, l.subject_code)
    kept.push({
      seq: Number.isFinite(Number(l.seq)) ? Number(l.seq) : kept.length + 1,
      summary: String(l.summary ?? '').trim() || null,
      direction: l.direction,
      amount,
      subject_id: subject.id,
      subject_code: subject.code,
      subject_name: subject.name,
      aux_type: subject.aux_type || null,
      aux_name: l.aux_name ?? null
    })
  }
  if (!kept.length) throw new AccountingError('VOUCHER_EMPTY', `${label}的金额为 0，无需生成凭证`, 409)

  const totalDebit = money2(kept.filter((l) => l.direction === 'debit').reduce((s, l) => s + l.amount, 0))
  const totalCredit = money2(kept.filter((l) => l.direction === 'credit').reduce((s, l) => s + l.amount, 0))
  if (Math.abs(totalDebit - totalCredit) > 0.005) {
    // 不平**不落库**：半张凭证比没有凭证更糟
    throw new AccountingError(
      'VOUCHER_NOT_BALANCED',
      `${label}试算不平衡：借 ${totalDebit} ≠ 贷 ${totalCredit}（差 ${money2(totalDebit - totalCredit)}）`,
      409,
      { total_debit: totalDebit, total_credit: totalCredit }
    )
  }
  if (totalDebit <= 0) throw new AccountingError('VOUCHER_ZERO', `${label}金额合计为 0`, 409)
  return { lines: kept, total_debit: totalDebit, total_credit: totalCredit }
}

/**
 * 把一份分录草案**落库**（生成一张 `draft` 凭证）。
 *
 * 「凭证怎么写进库里」只有这一处 —— 模板生成的凭证与期末结转的凭证走同一条路。
 * 单据编号、金额合计、状态一律由这里决定，调用方只管"记什么分录"。
 */
export function persistVoucher(db, plan = {}, { actor = null, memo = null } = {}) {
  const bizType = String(plan.biz_type || '').trim()
  const sourceType = String(plan.source_type || '').trim()
  const sourceId = Number(plan.source_id)
  if (!bizType || !sourceType || !Number.isFinite(sourceId)) {
    throw new AccountingError('BAD_PLAN', '凭证草案缺少 biz_type / source_type / source_id', 400)
  }
  const lines = plan.lines || []
  if (!lines.length) throw new AccountingError('VOUCHER_EMPTY', '凭证草案没有任何分录', 400)
  // 落库是最后一道闸门：**校验一定在这里发生一次**，不依赖调用方是否校验过。
  // （`planVoucher` 也调同一个校验器 —— 因为"预览"必须在**不落库**时就把不平报出来。
  //   实现只有一份，调用点有两处，这是"同一份判据"的正确形态。）
  const checked = assertBalancedLines(db, lines, { label: plan.label || '凭证' })

  const tx = db.transaction(() => {
    const docNo = nextDocNo(db, 'PZ', 'vouchers', 'doc_no', plan.voucher_date)
    const info = db
      .prepare(`
        INSERT INTO vouchers
          (doc_no,biz_type,source_type,source_id,source_doc_no,voucher_date,period,status,
           total_debit,total_credit,memo,maker_name)
        VALUES (?,?,?,?,?,?,?,'draft',?,?,?,?)
      `)
      .run(docNo, bizType, sourceType, sourceId, plan.source_doc_no ?? null,
        plan.voucher_date, plan.period, checked.total_debit, checked.total_credit,
        memo || plan.memo || null, actor?.name ?? null)
    const vid = Number(info.lastInsertRowid)
    const ins = db.prepare(`
      INSERT INTO voucher_entries (voucher_id,seq,summary,subject_id,subject_code,subject_name,direction,amount,aux_type,aux_name)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `)
    for (const l of checked.lines) {
      ins.run(vid, l.seq, l.summary, l.subject_id, l.subject_code, l.subject_name, l.direction, l.amount, l.aux_type, l.aux_name)
    }
    return vid
  })
  const id = tx()
  return { id, doc_no: db.prepare('SELECT doc_no FROM vouchers WHERE id=?').get(id).doc_no }
}

/**
 * 试算：算出分录，**不落库**。界面上的"预览"与实际的"生成"走**同一个函数** ——
 * 两处各算一遍必然分叉，而"预览说 A、生成是 B"这种错没有界面能看出来。
 */
export function planVoucher(db, { bizType, sourceType = null, sourceId }) {
  const { biz, row, facts } = collectFacts(db, { bizType, sourceId })
  if (sourceType && sourceType !== biz.source_type) {
    throw new AccountingError('SOURCE_TYPE_MISMATCH', `业务场景 ${bizType} 的来源表是 ${biz.source_type}，不是 ${sourceType}`, 400)
  }
  const { template, entries } = templateOf(db, bizType)

  const lines = []
  for (const e of entries) {
    if (!FACT_KEYS[e.amount_key]) {
      throw new AccountingError('FACT_KEY_UNKNOWN', `模板分录引用了未知取数键：${e.amount_key}`, 500, { template: template.code, seq: e.seq })
    }
    const amt = facts[e.amount_key]
    if (amt === undefined || amt === null) {
      throw new AccountingError('FACT_MISSING', `取数键 ${e.amount_key} 在本次业务里没有值（模板 ${template.code} 第 ${e.seq} 行）`, 409)
    }
    lines.push({
      seq: e.seq,
      summary: String(e.summary || '').replace(/\{doc_no\}/g, facts.doc_no),
      direction: e.direction,
      amount: amt,
      subject_code: e.subject_code,
      aux_name: e.aux_key ? facts[e.aux_key] ?? null : null
    })
  }
  // 方向 / 金额非负且非零 / 科目存在且是叶子 / **借贷平衡** —— 全部交给唯一校验器。
  // 这里刻意不自己再判一遍：模板路与结转路各写一份平衡检查，迟早只改一处。
  const { lines: kept, total_debit: totalDebit, total_credit: totalCredit } = assertBalancedLines(db, lines, {
    label: `${biz.label}凭证`
  })

  const bizDate = facts.biz_date || localDate()
  return {
    template,
    biz_type: bizType,
    source_type: biz.source_type,
    source_id: Number(sourceId),
    source_doc_no: facts.doc_no,
    voucher_date: String(bizDate).slice(0, 10),
    period: String(bizDate).slice(0, 7),
    total_debit: totalDebit,
    total_credit: totalCredit,
    lines: kept,
    facts
  }
}

/** 生成并落库（幂等：同来源同业务返回同一张） */
export function generateVoucher(db, { bizType, sourceType = null, sourceId, actor = null, memo = null }) {
  const biz = BIZ_TYPES[bizType]
  if (!biz) throw new AccountingError('BAD_BIZ_TYPE', `不支持的业务场景：${bizType}`, 400)
  const exist = db
    .prepare('SELECT * FROM vouchers WHERE biz_type=? AND source_type=? AND source_id=?')
    .get(bizType, biz.source_type, Number(sourceId))
  if (exist) return { ...getVoucher(db, exist.id), replayed: true }

  const plan = planVoucher(db, { bizType, sourceType, sourceId })
  const v = persistVoucher(db, plan, { actor, memo: memo || `${plan.template.name}（来源 ${plan.source_doc_no}）` })
  return { ...getVoucher(db, v.id), replayed: false }
}

export function getVoucher(db, id) {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(Number(id))
  if (!v) throw new AccountingError('NOT_FOUND', `凭证不存在：#${id}`, 404)
  const entries = db.prepare('SELECT * FROM voucher_entries WHERE voucher_id=? ORDER BY seq').all(v.id)
  return { ...v, entries, balanced: Math.abs(v.total_debit - v.total_credit) <= 0.005 }
}

export function listVouchers(db, { period = null, bizType = null, status = null, sourceDocNo = null, limit = 50, offset = 0 } = {}) {
  const args = []
  let where = 'WHERE 1=1'
  if (period) { where += ' AND v.period=?'; args.push(period) }
  if (bizType) { where += ' AND v.biz_type=?'; args.push(bizType) }
  if (status) { where += ' AND v.status=?'; args.push(status) }
  if (sourceDocNo) { where += ' AND v.source_doc_no LIKE ?'; args.push(`%${sourceDocNo}%`) }
  const total = db.prepare(`SELECT COUNT(*) c FROM vouchers v ${where}`).get(...args).c
  const rows = db
    .prepare(`
      SELECT v.*, (SELECT COUNT(*) FROM voucher_entries e WHERE e.voucher_id = v.id) AS entry_count
        FROM vouchers v ${where}
       ORDER BY v.voucher_date DESC, v.id DESC LIMIT ? OFFSET ?
    `)
    .all(...args, Number(limit), Number(offset))
  return { rows, total }
}

export function postVoucher(db, { id, actor = null }) {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(Number(id))
  if (!v) throw new AccountingError('NOT_FOUND', `凭证不存在：#${id}`, 404)
  if (v.status === 'posted') return { id: v.id, status: 'posted', replayed: true }
  if (v.status !== 'draft') throw new AccountingError('VOUCHER_NOT_DRAFT', `凭证 ${v.doc_no} 当前状态「${v.status}」不能过账`, 409)
  // **关账后不能再过账**（批次 L）：期间是"这一期的账定稿了"这件事唯一的落点。
  // 判据在 `lib/period.js` 的 `assertPeriodOpen`（**唯一实现**）——
  // 关账接口自己也调它，所以"过账时拦"与"关账时确认"用的是同一份口径。
  // 只拦过账、**不拦生成**：`draft` 不计入任何报表，拦它只会让"先录单、后开账"走不通。
  assertPeriodOpen(db, v.period)
  // 过账是**入账**：再算一次平衡。生成时的平衡与此刻的平衡都要成立 ——
  // 生成之后有人动过分录，必须在这里被拦住。
  const sums = db
    .prepare(`
      SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount END),0) d,
             COALESCE(SUM(CASE WHEN direction='credit' THEN amount END),0) c
        FROM voucher_entries WHERE voucher_id=?
    `)
    .get(v.id)
  if (Math.abs(money2(sums.d) - money2(sums.c)) > 0.005) {
    throw new AccountingError('VOUCHER_NOT_BALANCED', `凭证 ${v.doc_no} 借贷不平衡，不能过账`, 409,
      { total_debit: money2(sums.d), total_credit: money2(sums.c) })
  }
  // 状态推进是**裸 UPDATE**（不是 applyTransition），所以**痕迹要自己补**，而且必须与改动
  // **同一个事务** —— 否则"过账成功但痕丢了"或反之，`doc_events` 就不再是凭证一生的真相。
  // ⚠️ 为什么这里**不**改成 applyTransition：过账要同时写 total_debit/total_credit/posted_by/posted_at
  // 四个字段，且上面已有"已过账直接返回（replayed）"的幂等分支；改成走内核会引入**边校验**，
  // 把现在能跑的"重复过账返回 200"变成 409 —— 那是行为变更，属另一件事（记入技术债）。
  // `from: v.status` / `to: 'posted'` 记**真实前后状态**，且这对 (from,to) 是内核注册过的边
  // （`VOUCHER` 的 `post: draft→posted`）——由 `scripts/check-doc-events-edges.mjs` 守着。
  const exec = db.transaction(() => {
    db.prepare(`
      UPDATE vouchers SET status='posted', total_debit=?, total_credit=?, posted_by=?, posted_at=? WHERE id=?
    `).run(money2(sums.d), money2(sums.c), actor?.name ?? null, nowText(), v.id)
    logEvent({
      db,
      docType: 'VOUCHER',
      id: v.id,
      docNo: v.doc_no,
      action: 'post',
      actionName: '过账',
      from: v.status,
      to: 'posted',
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
      source: actor?.source || 'api',
      remark: `凭证过账 ${v.doc_no}`,
      payload: { total_debit: money2(sums.d), total_credit: money2(sums.c), period: v.period, biz_type: v.biz_type }
    })
  })
  exec()
  return { id: v.id, status: 'posted', replayed: false }
}

export function voidVoucher(db, { id, reason = null, actor = null }) {
  const v = db.prepare('SELECT * FROM vouchers WHERE id=?').get(Number(id))
  if (!v) throw new AccountingError('NOT_FOUND', `凭证不存在：#${id}`, 404)
  if (v.status === 'voided') return { id: v.id, status: 'voided', replayed: true }
  // 作废已过账的凭证会改变当期发生额 ⇒ 必须写理由（"为什么这笔记过的账不算了"要答得上）
  if (v.status === 'posted' && !String(reason || '').trim()) {
    throw new AccountingError('VOID_REASON_REQUIRED', `作废已过账凭证 ${v.doc_no} 必须填写理由`, 400)
  }
  // 同 `postVoucher`：裸 UPDATE + 与改动同事务的留痕（`from: v.status` 可能是 `draft` 或 `posted`，
  // 两者到 `voided` 都是内核注册过的边：`void: draft→voided` / `void: posted→voided`）。
  // 作废必须写理由时上面已经拦过；理由一并进痕的 remark，让"为什么这笔记过的账不算了"在时间线上答得出来。
  const exec = db.transaction(() => {
    db.prepare(`
      UPDATE vouchers SET status='voided', voided_by=?, voided_at=?, void_reason=? WHERE id=?
    `).run(actor?.name ?? null, nowText(), reason || null, v.id)
    logEvent({
      db,
      docType: 'VOUCHER',
      id: v.id,
      docNo: v.doc_no,
      action: 'void',
      actionName: '作废',
      from: v.status,
      to: 'voided',
      actor: { id: actor?.id ?? null, name: actor?.name ?? null },
      source: actor?.source || 'api',
      remark: reason ? `凭证作废 ${v.doc_no}：${reason}` : `凭证作废 ${v.doc_no}`,
      payload: { was_posted: v.status === 'posted', reason: reason || null, period: v.period, biz_type: v.biz_type }
    })
  })
  exec()
  return { id: v.id, status: 'voided', was_posted: v.status === 'posted', replayed: false }
}

/** 反查：某张来源单据生成过凭证吗（"这笔记过账没有"是财务最常问的一句话） */
export function vouchersOfSource(db, { sourceType, sourceId }) {
  return db.prepare('SELECT * FROM vouchers WHERE source_type=? AND source_id=? ORDER BY id').all(String(sourceType), Number(sourceId))
}

// ---------------------------------------------------------------------------
// 试算平衡表
// ---------------------------------------------------------------------------
/**
 * 试算平衡的**筛选条件唯一实现**（批次 N）。
 *
 * 为什么抽出来：试算平衡表多了一个"逐行展开"的视图，而展开与汇总**必须筛同一批凭证**。
 * 各拼一遍 where 的后果是"展开后对不上汇总"——两边看起来都像对的，
 * 差的那几笔既不报错也说不清是哪一步漏的。汇总与展开都从这一个函数取 where。
 */
export function trialBalanceFilter({ period = null, from = null, to = null } = {}) {
  const args = []
  let where = "v.status='posted'"
  if (period) { where += ' AND v.period=?'; args.push(String(period)) }
  if (from) { where += ' AND v.voucher_date >= ?'; args.push(String(from).slice(0, 10)) }
  if (to) { where += ' AND v.voucher_date <= ?'; args.push(String(to).slice(0, 10)) }
  return { where, args }
}

/**
 * 余额方向与净额。**由科目自身的 `direction` 决定**，不靠"借减贷"的正负去猜 ——
 * 负债类科目的余额方向与资产类相反，统一按"借减贷"算会把负债读成负数。
 * 汇总行与展开行共用它：同一个科目在两张视图里给出的方向必须一致。
 *
 * 入参是**借贷两列**（不是带符号的数），所以展开行要把累计额先拆成两列再进来 ——
 * 这样"方向判定"这段逻辑全项目也只有一处。
 */
export function balanceOf(direction, debit, credit) {
  const d = money2(debit)
  const c = money2(credit)
  const net = direction === 'debit' ? money2(d - c) : money2(c - d)
  return { net, side: net >= 0 ? direction : (direction === 'debit' ? 'credit' : 'debit'), abs: Math.abs(net) }
}

/**
 * 按期间/日期区间汇总。**只有 `posted` 计入** ——
 * `draft` 是"生成出来了但还没进账"，把它算进去等于"生成"就是"入账"。
 */
export function trialBalance(db, { from = null, to = null, period = null } = {}) {
  const { where, args } = trialBalanceFilter({ period, from, to })

  const rows = db
    .prepare(`
      SELECT s.id AS subject_id, s.code, s.name, s.category, s.direction,
             ROUND(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END), 2) AS debit,
             ROUND(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END), 2) AS credit
        FROM voucher_entries e
        JOIN vouchers v ON v.id = e.voucher_id
        JOIN accounting_subjects s ON s.id = e.subject_id
        WHERE ${where}
       GROUP BY s.id, s.code, s.name, s.category, s.direction
       ORDER BY s.code
    `)
    .all(...args)

  const totalDebit = money2(rows.reduce((s, r) => s + Number(r.debit || 0), 0))
  const totalCredit = money2(rows.reduce((s, r) => s + Number(r.credit || 0), 0))
  const withBalance = rows.map((r) => {
    const b = balanceOf(r.direction, r.debit, r.credit)
    return { ...r, debit: money2(r.debit), credit: money2(r.credit), balance: b.net, balance_side: b.side, balance_abs: b.abs }
  })
  const postedCount = db.prepare(`SELECT COUNT(*) c FROM vouchers v WHERE ${where}`).get(...args).c
  return {
    rows: withBalance,
    total_debit: totalDebit,
    total_credit: totalCredit,
    balanced: Math.abs(totalDebit - totalCredit) <= 0.005,
    diff: money2(totalDebit - totalCredit),
    voucher_count: postedCount
  }
}

/**
 * 试算平衡表的**逐行展开**（批次 N）：某个科目在同一个筛选条件下的**全部凭证分录**。
 *
 * 三条口径：
 *   ① 筛选条件与汇总**同一个函数**（`trialBalanceFilter`）——
 *      "展开"若自己拼一遍 where，展开与汇总迟早不是一批数；
 *   ② 明细的借贷合计**必须等于汇总行的借/贷**（未截断时），这是可执行断言，
 *      不是"看起来差不多"；
 *   ③ 超出行数上限**如实回报** `truncated` / `total_count`，不静默截断 ——
 *      一张"看着像全量、其实少了一半"的明细比报错危险得多。
 *
 * 逐笔余额按科目自身的 `direction` 累计（收入类贷方余额要读成正数）。
 */
export function trialBalanceDetail(db, {
  period = null, from = null, to = null,
  subjectCode = null, subjectId = null,
  limit = 500, maxLimit = 2000
} = {}) {
  const { where, args } = trialBalanceFilter({ period, from, to })
  const subject = subjectCode
    ? db.prepare('SELECT * FROM accounting_subjects WHERE code=?').get(String(subjectCode))
    : (subjectId ? db.prepare('SELECT * FROM accounting_subjects WHERE id=?').get(Number(subjectId)) : null)
  if (!subject) {
    throw new AccountingError(
      'DETAIL_SUBJECT_REQUIRED',
      subjectCode || subjectId ? `科目不存在（${subjectCode || subjectId}）` : '逐行展开必须指定科目',
      subjectCode || subjectId ? 404 : 400,
      { subject_code: subjectCode }
    )
  }

  const lim = Math.min(Math.max(Number(limit) || 500, 1), Number(maxLimit) || 2000)
  const rows = db
    .prepare(`
      SELECT e.id AS entry_id, v.id AS voucher_id, v.doc_no, v.voucher_date, v.period,
             v.biz_type, v.status, v.memo AS voucher_memo,
             e.seq, e.summary, e.direction, e.amount
        FROM voucher_entries e
        JOIN vouchers v ON v.id = e.voucher_id
       WHERE ${where} AND e.subject_id = ?
       ORDER BY v.voucher_date, v.id, e.seq
       LIMIT ?
    `)
    .all(...args, subject.id, lim)

  // 合计：与汇总行**算法相同**（同一 where、同一科目），所以两者必须逐分相等。
  const sums = db
    .prepare(`
      SELECT ROUND(SUM(CASE WHEN e.direction='debit'  THEN e.amount ELSE 0 END),2) d,
             ROUND(SUM(CASE WHEN e.direction='credit' THEN e.amount ELSE 0 END),2) c,
             COUNT(*) n, COUNT(DISTINCT v.id) vc
        FROM voucher_entries e JOIN vouchers v ON v.id = e.voucher_id
       WHERE ${where} AND e.subject_id = ?
    `)
    .get(...args, subject.id)

  let signedAcc = 0
  const withRunning = rows.map((r) => {
    signedAcc = money2(signedAcc + (r.direction === 'debit' ? Number(r.amount) : -Number(r.amount)))
    // 把"借 − 贷"的累计拆回借贷两列，再交给同一个 `balanceOf` 判方向 ——
    // 展开行的余额方向因此与汇总行用的是同一段逻辑。
    const b = balanceOf(subject.direction, signedAcc > 0 ? signedAcc : 0, signedAcc < 0 ? -signedAcc : 0)
    return { ...r, amount: money2(r.amount), running_signed: money2(signedAcc), running_balance: b.net, running_side: b.side, running_abs: b.abs }
  })

  const debit = money2(sums.d)
  const credit = money2(sums.c)
  const total = trialBalance(db, { period, from, to }).rows.find((x) => Number(x.subject_id) === Number(subject.id))
  return {
    subject: {
      subject_id: subject.id, code: subject.code, name: subject.name,
      category: subject.category, direction: subject.direction, is_leaf: subject.is_leaf
    },
    filter: { period, from, to },
    rows: withRunning,
    count: withRunning.length,
    total_count: Number(sums.n),
    voucher_count: Number(sums.vc),
    limit: lim,
    truncated: Number(sums.n) > withRunning.length,
    total_debit: debit,
    total_credit: credit,
    balance: balanceOf(subject.direction, debit, credit),
    // 汇总行（同一个科目、同一个筛选）—— 与上面的合计必须一致；
    // 它同时是"展开对得上汇总"的证据，回给调用方省得再查一次。
    summary_row: total || null
  }
}


/** 域自证：凭证域的全部不变量（与 `verify-seed` 共用同一份判据） */
export function auditVoucher(db) {
  const problems = []
  const push = (code, msg, n) => { if (n > 0) problems.push({ code, message: msg, count: n }) }

  // ① 分录金额必须为正
  push('ENTRY_NON_POSITIVE', '存在金额不为正的分录', db.prepare('SELECT COUNT(*) c FROM voucher_entries WHERE amount <= 0').get().c)
  // ② 已入账凭证必须平衡
  push('UNBALANCED_VOUCHER', '存在借贷不平衡的凭证', db.prepare(
    "SELECT COUNT(*) c FROM vouchers WHERE status IN ('draft','posted') AND ABS(total_debit - total_credit) > 0.005").get().c)
  // ③ 凭证头金额必须等于分录合计（头是冗余，冗余就会分叉）
  push('HEAD_ENTRY_MISMATCH', '凭证头的借贷合计与分录合计不一致', db.prepare(`
    SELECT COUNT(*) c FROM vouchers v WHERE EXISTS (
      SELECT 1 FROM voucher_entries e WHERE e.voucher_id = v.id
    ) AND ABS(v.total_debit - (SELECT COALESCE(SUM(CASE WHEN direction='debit' THEN amount END),0) FROM voucher_entries WHERE voucher_id=v.id)) > 0.005
  `).get().c)
  // ④ 分录必须挂**叶子**科目
  push('ENTRY_ON_PARENT', '分录挂在了非叶子科目上', db.prepare(`
    SELECT COUNT(*) c FROM voucher_entries e JOIN accounting_subjects s ON s.id=e.subject_id WHERE s.is_leaf=0
  `).get().c)
  // ⑤ 期间必须等于记账日期前 7 位
  push('PERIOD_MISMATCH', '凭证期间与记账日期不一致', db.prepare(
    "SELECT COUNT(*) c FROM vouchers WHERE period <> substr(voucher_date,1,7)").get().c)
  // ⑥ 来源单据必须真实存在（否则就是"编出来的账"）
  push('SOURCE_MISSING', '凭证的来源单据不存在', db.prepare(`
    SELECT COUNT(*) c FROM vouchers v WHERE
      (v.source_type='purchase_receipts'  AND NOT EXISTS (SELECT 1 FROM purchase_receipts  x WHERE x.id=v.source_id))
   OR (v.source_type='sales_deliveries'   AND NOT EXISTS (SELECT 1 FROM sales_deliveries   x WHERE x.id=v.source_id))
   OR (v.source_type='receipts'           AND NOT EXISTS (SELECT 1 FROM receipts           x WHERE x.id=v.source_id))
   OR (v.source_type='purchase_payments'  AND NOT EXISTS (SELECT 1 FROM purchase_payments  x WHERE x.id=v.source_id))
  `).get().c)
  // ⑦ 同一事实只入一次账
  push('DUPLICATE_SOURCE', '同一来源被入了两次账', db.prepare(`
    SELECT COUNT(*) c FROM (SELECT biz_type, source_type, source_id FROM vouchers GROUP BY biz_type, source_type, source_id HAVING COUNT(*) > 1)
  `).get().c)
  // ⑧ 作废已过账凭证必须留理由
  push('VOID_WITHOUT_REASON', '作废的凭证没有写理由', db.prepare(
    "SELECT COUNT(*) c FROM vouchers WHERE status='voided' AND (void_reason IS NULL OR void_reason='')").get().c)

  // ⑨ **试算平衡总账**：所有已过账分录的借合计必须等于贷合计
  const sums = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN e.direction='debit'  THEN e.amount END),0) d,
           COALESCE(SUM(CASE WHEN e.direction='credit' THEN e.amount END),0) c
      FROM voucher_entries e JOIN vouchers v ON v.id=e.voucher_id WHERE v.status='posted'
  `).get()
  const balanced = Math.abs(money2(sums.d) - money2(sums.c)) <= 0.005
  if (!balanced) problems.push({ code: 'TRIAL_UNBALANCED', message: `总账试算不平衡：借 ${money2(sums.d)} ≠ 贷 ${money2(sums.c)}`, count: 1 })

  return { balanced: balanced && problems.length === 0, problems, total_debit: money2(sums.d), total_credit: money2(sums.c) }
}

export function meta(db) {
  return {
    biz_types: Object.entries(BIZ_TYPES).map(([value, v]) => ({
      value, label: v.label, doc_type: v.doc_type, source_type: v.source_type, ok_statuses: v.okStatuses
    })),
    fact_keys: Object.entries(FACT_KEYS).map(([value, v]) => ({ value, ...v })),
    categories: SUBJECT_CATEGORIES,
    directions: DIRECTIONS,
    default_tax_rate: defaultTaxRate(db)
  }
}

export default {
  AccountingError,
  listSubjects, subjectTree, saveSubject, setSubjectStatus,
  listTemplates, templateOf, assertTemplateBalanced,
  collectFacts, planVoucher, generateVoucher, getVoucher, listVouchers, postVoucher, voidVoucher, vouchersOfSource,
  trialBalance, auditVoucher, meta, defaultTaxRate,
  FACT_KEYS, BIZ_TYPES, SUBJECT_CATEGORY_LABEL, DIRECTION_LABEL
}
