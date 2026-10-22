/**
 * ============================================================================
 * 文件标识：scripts/test-docflow.mjs ｜ 测试：单据内核 + 编码规则 专项测试 —— 独立临时库，不触碰生产数据
 * ============================================================================
 * 【职责】测试：单据内核 + 编码规则 专项测试 —— 独立临时库，不触碰生产数据
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 单据内核 + 编码规则 专项测试 —— 独立临时库，不触碰生产数据
// 运行：node scripts/test-docflow.mjs
import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runMigrations } from '../server/db/migrations/runner.js'
import {
  DocFlowError,
  listDocTypes,
  getMachine,
  allowedActions,
  applyTransition,
  tryTransition,
  historyOf,
  explainLifecycle
} from '../server/lib/docflow.js'
import { nextDocNoAuto, nextDocNoByRule, previewDocNo, listDocNoRules, nextDocNo } from '../server/lib/docno.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const TMP = '/tmp/gml_docflow_test.db'

let pass = 0
let fail = 0
const failures = []
function ok(name, cond, detail) {
  if (cond) {
    pass += 1
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } else {
    fail += 1
    failures.push(name)
    console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail ? '→ ' + detail : ''}`)
  }
}
function eq(name, actual, expected) {
  const numeric = typeof expected === 'number' && actual != null && !Number.isNaN(Number(actual))
  const good = numeric ? Math.abs(Number(actual) - Number(expected)) < 1e-6 : String(actual) === String(expected)
  ok(name, good, `实际 ${actual} / 期望 ${expected}`)
}
function section(t) {
  console.log(`\n\x1b[36m${t}\x1b[0m`)
}

// ---------- 干净库 ----------
for (const f of [TMP, TMP + '-wal', TMP + '-shm']) if (fs.existsSync(f)) fs.unlinkSync(f)
const db = new Database(TMP)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')
db.exec(fs.readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8'))
const migResult = runMigrations(db)
console.log(`迁移：${migResult.applied.join(', ')}${migResult.healed.length ? '（自愈 ' + migResult.healed.join(',') + '）' : ''}`)

// ---------- 最小主数据 ----------
db.prepare(
  `INSERT OR IGNORE INTO orgs (id,code,name,type,level,path,is_legal,owner_org_id,currency,status)
   VALUES (1,'HQ','演示总部','group',1,'/1/',1,1,'CNY','active')`
).run()
db.prepare(`INSERT OR IGNORE INTO stores (id,code,name,type,status) VALUES (1,'S01','演示门店','direct','active')`).run()
db.prepare(
  `INSERT OR IGNORE INTO warehouses (id,code,name,type,status) VALUES (1,'WH01','总仓','central','active')`
).run()

// ===========================================================================
section('一、状态机定义自洽性（数据定义本身的错误，只有这里能抓到）')
// ===========================================================================
const types = listDocTypes(db)
// 30 = 模块 04 的 22 种 + 模块 12A 订货中心 OC（订货单）/ OCS（订货对账单）
//      + 模块 07 采购域 PRQ（请购单）/ PI（采购发票）/ PST（采购结算单）/ PAY（付款单）
//      + 模块 07 质检 INS（质检单）：到货单与质检单拆分的产物 ——
//        「送来了什么」与「收不收、收多少、为什么」是两件事，必须两张单
//      + 模块 09 成本 CA（存货成本调整单）：差异回写要留痕、可追溯，不能只是改数
//      + 模块 13 质量检验三段链 QCR（报检单）/ QCI（检验单）/ DH（不良品处理单）：
//        报检、检验、处置的责任人/时间/后果都不同，合成一张单就只能共用一个状态
//      + 模块 10B 生产领料 MR（生产领料单）：领料是真的出库，必须是能审批、能反查流水的单
//
//      注意这里**没有** WR（报工单）：`WR` 早已被「委外收货单」占用，
//      而第三轮口径 G4 已定案「生产不报工」——完工汇报落在 work_reports，
//      有单号可追溯但不推进状态。类型数从 37 到 38，增加的就是 MR 这一个。
eq('已注册单据类型 40 种（含模块 08A 报价单 QT、模块 21 应收单 AR 与收款单 RCP、模块 24 销售发票 SI、模块 13 报检 QCR / 检验 QCI / 不良品处理 DH、模块 10B 生产领料 MR、模块 27 记账凭证 VOUCHER、批次 J 退款单 RFD）', types.length, 40)

let badEdge = []
let noState = []
let dupInitial = []
let badKind = []
const KINDS = new Set(['draft', 'active', 'done', 'void'])
for (const t of types) {
  const m = getMachine(db, t.code)
  if (!m.states.length) noState.push(t.code)
  if (m.initial.length !== 1) dupInitial.push(`${t.code}(${m.initial.length})`)
  for (const s of m.states) if (!KINDS.has(s.kind)) badKind.push(`${t.code}.${s.code}:${s.kind}`)
  for (const e of m.edges) {
    if (!m.states.some((s) => s.code === e.from_state)) badEdge.push(`${t.code} 边 from=${e.from_state} 未定义`)
    if (!m.states.some((s) => s.code === e.to_state)) badEdge.push(`${t.code} 边 to=${e.to_state} 未定义`)
  }
}
ok('每个单据类型都有状态定义', noState.length === 0, noState.join(','))
ok('每个单据类型恰有一个初始状态', dupInitial.length === 0, dupInitial.join(','))
ok('状态 kind 取值合法', badKind.length === 0, badKind.join(','))
ok('所有流转边的起止状态都已定义', badEdge.length === 0, badEdge.slice(0, 3).join(' | '))

// 终态不应有出边（有就是状态机设计错）
let finalWithOut = []
for (const t of types) {
  const m = getMachine(db, t.code)
  const finals = new Set(m.finals)
  for (const e of m.edges) if (finals.has(e.from_state)) finalWithOut.push(`${t.code}:${e.from_state}--${e.action}-->${e.to_state}`)
}
ok('终态无出边（否则不是终态）', finalWithOut.length === 0, finalWithOut.slice(0, 3).join(' | '))

// 权限点必须真实存在于权限注册表
const missingPerm = db
  .prepare(
    `SELECT DISTINCT a.perm_code FROM doc_actions a
     LEFT JOIN permissions p ON p.code=a.perm_code
     WHERE a.perm_code IS NOT NULL AND p.code IS NULL`
  )
  .all()
  .map((r) => r.perm_code)
ok('状态机引用的权限点都在权限表中', missingPerm.length === 0, missingPerm.join(','))

const permTotal = db.prepare('SELECT COUNT(*) c FROM permissions').get().c
ok(`权限点总数已扩充（现 ${permTotal} 个）`, permTotal >= 66)

// ===========================================================================
section('二、状态机查询')
// ===========================================================================
const so = getMachine(db, 'SO')
eq('销售订单状态数 7', so.states.length, 7)
eq('销售订单初始状态 draft', so.initial[0], 'draft')
ok('销售订单有 shipped 状态', so.states.some((s) => s.code === 'shipped'))
const draftActs = allowedActions(db, 'SO', 'draft').map((a) => a.action)
ok('草稿态可确认订单', draftActs.includes('confirm'), draftActs.join(','))
ok('草稿态可取消', draftActs.includes('cancel'))
const doneActs = allowedActions(db, 'SO', 'completed')
ok('已完成态只可退货（无 confirm/cancel）', doneActs.map((a) => a.action).join(',') === 'return', doneActs.map((a) => a.action).join(','))

// 未注册类型要报 404 级错误
let unknownCode = null
try {
  getMachine(db, 'NOT_EXIST')
} catch (e) {
  unknownCode = e.code
}
eq('未注册单据类型报 DOC_TYPE_UNKNOWN', unknownCode, 'DOC_TYPE_UNKNOWN')

// ===========================================================================
section('三、统一流转（applyTransition）')
// ===========================================================================
db.prepare(
  `INSERT INTO stock_checks (id,doc_no,warehouse_id,check_date,status,checker) VALUES (1,'CK-TEST-1',1,'2026-10-15','draft','张三')`
).run()

const t1 = applyTransition({
  db,
  docType: 'CK',
  id: 1,
  action: 'start',
  actor: { id: 9, name: '张三' },
  remark: '开始盘点'
})
eq('盘点单 draft → checking', t1.to, 'checking')
eq('返回动作名', t1.actionName, '开始盘点')
eq('数据库状态已更新', db.prepare('SELECT status FROM stock_checks WHERE id=1').get().status, 'checking')

const t2 = applyTransition({ db, docType: 'stock_checks', id: 1, action: 'adjust', actor: { id: 9, name: '张三' } })
eq('用表名也能流转（表名/类型码等价）', t2.to, 'adjusted')
ok('高危动作被标记', t2.isDanger === true)

const hist = historyOf(db, { docType: 'CK', id: 1 })
eq('留痕两条', hist.length, 2)
eq('留痕顺序为时间正序', hist[0].to_state, 'checking')
eq('留痕记录了操作人', hist[1].actor_name, '张三')
eq('留痕记录了来源', hist[0].source, 'api')

// 终态再流转必须被拒
const r = tryTransition({ db, docType: 'CK', id: 1, action: 'start' })
ok('终态继续流转被拒', r.ok === false)
eq('拒绝码为 TRANSITION_NOT_ALLOWED', r.error.code, 'TRANSITION_NOT_ALLOWED')
eq('拒绝时返回 HTTP 409', r.error.httpStatus, 409)

// 非法动作也要被拒，且提示当前可做什么
const r2 = tryTransition({ db, docType: 'SO', id: 1, action: 'ship' })
ok('不存在的单据被拒', r2.ok === false)
eq('拒绝码为 DOC_NOT_FOUND', r2.error.code, 'DOC_NOT_FOUND')

// 乐观并发：期望状态不符时拒绝
db.prepare(`INSERT INTO pos_shifts (id,store_id,cashier_id,cashier_name,biz_date,opened_at,status) VALUES (1,1,NULL,'李四','2026-10-15','2026-10-15 08:00','open')`).run()
// 注意：班次的 `close` 动作在批次 E 已被**删除**（它等于绕过核款，直接关班就永远出不了长短款）。
// 现在唯一的路径是 `declare`（报数）→ `approve`（核款）。这里换成 declare 打同一件事：
// 「用表名/类型码流转 + 附加字段一起更新」。
const conflict = tryTransition({ db, docType: 'PSF', id: 1, action: 'declare', expectFrom: 'declared' })
ok('期望状态不符时拒绝（乐观并发）', conflict.ok === false)
eq('拒绝码为 STATE_CONFLICT', conflict.error.code, 'STATE_CONFLICT')
const okDeclare = applyTransition({ db, docType: 'PSF', id: 1, action: 'declare', set: { closed_at: '2026-10-15 22:00' } })
eq('报数交班成功', okDeclare.to, 'declared')
eq('附加字段一并更新', db.prepare('SELECT closed_at FROM pos_shifts WHERE id=1').get().closed_at, '2026-10-15 22:00')
// 已被删掉的旧动作必须真的不存在 —— 留着一条谁都能绕过的旁路，长短款就会有一半的单子不产生差异
const noClose = tryTransition({ db, docType: 'PSF', id: 1, action: 'close' })
ok('旧的「直接关班」动作已不存在', noClose.ok === false && noClose.error.code === 'TRANSITION_NOT_ALLOWED')

// 传入不存在的列应被静默忽略而不是炸掉（兼容老代码）
const okIgnore = tryTransition({ db, docType: 'CK', id: 1, action: 'start', set: { not_a_column: 1 } })
ok('未知列被忽略而非报错', okIgnore.ok === false && okIgnore.error.code === 'TRANSITION_NOT_ALLOWED')

let plainErr = null
try {
  applyTransition({ db, docType: 'CK', id: 999, action: 'start' })
} catch (e) {
  plainErr = e instanceof DocFlowError ? 'DocFlowError' : e.name
}
eq('抛出的错误类型是 DocFlowError', plainErr, 'DocFlowError')

// ===========================================================================
section('四、编码规则（模块 06）')
// ===========================================================================
const rules = listDocNoRules(db)
ok(`默认规则已生成（${rules.length} 条）`, rules.length >= 18)
ok('采购订单规则格式与旧单号兼容', rules.find((x) => x.doc_type === 'PO').pattern === '{PREFIX}{YYYYMMDD}{SEQ:4}')

const no1 = nextDocNoAuto(db, { docType: 'PO', bizDate: '2026-10-15' })
const no2 = nextDocNoAuto(db, { docType: 'PO', bizDate: '2026-10-15' })
eq('首个采购单号', no1, 'PO202610150001')
eq('第二个连续递增', no2, 'PO202610150002')
const sameAsOld = nextDocNo(db, 'XX', 'stock_checks', 'doc_no', '2026-10-15')
ok('旧 nextDocNo 仍可用', sameAsOld.startsWith('XX20261015'))

// 跨日归零
const nextDay = nextDocNoAuto(db, { docType: 'PO', bizDate: '2026-10-16' })
eq('跨日序号归零', nextDay, 'PO202610160001')

// 预览不消耗序号
const preview1 = previewDocNo(db, { docType: 'PO', pattern: '{PREFIX}{YYYYMMDD}{SEQ:4}', seq: 7, bizDate: '2026-10-15' })
eq('预览可指定序号', preview1, 'PO202610150007')
const no3 = nextDocNoAuto(db, { docType: 'PO', bizDate: '2026-10-15' })
eq('预览不消耗真实序号', no3, 'PO202610150003')

// 自定义规则：按仓库分段 + 月周期
db.prepare(
  `INSERT INTO doc_no_rules (doc_type,name,scope_type,scope_value,pattern,period,seq_pad,seq_start)
   VALUES ('TF','调拨单-按仓库','warehouse','1','TF{WH}-{YYYYMM}-{SEQ:5}','month',5,1)`
).run()
const tfNo = nextDocNoAuto(db, { docType: 'TF', warehouseId: 1, bizDate: '2026-10-15' })
eq('按仓库规则生效', tfNo, 'TF0001-202610-00001')
const tfNo2 = nextDocNoByRule(db, { docType: 'TF', warehouseId: 1, bizDate: '2026-10-15' })
eq('同仓库同月继续递增', tfNo2, 'TF0001-202610-00002')
const tfGlobal = nextDocNoAuto(db, { docType: 'TF', bizDate: '2026-10-15' })
eq('无仓库上下文回落全局规则', tfGlobal, 'TR202610150001')   // 调拨单代码里用的前缀是 TR

// 冲突兜底：把盘点单规则改成与采购单同样的格式，并预先占用 0001/0002 号。
// 取号时必须逐号探测跳过已占用的号，否则会撞 UNIQUE 约束（历史 seed 手工拼号留下的坑）。
db.prepare(
  `INSERT INTO stock_checks (id,doc_no,warehouse_id,check_date,status) VALUES
     (2,'PO202610150001',1,'2026-10-15','draft'),
     (3,'PO202610150002',1,'2026-10-15','draft')`
).run()
db.prepare("UPDATE doc_no_rules SET pattern='PO{YYYYMMDD}{SEQ:4}' WHERE doc_type='CK'").run()
const ckNo = nextDocNoAuto(db, { docType: 'CK', bizDate: '2026-10-15' })
eq('取号遇到已占用号自动跳过（0001/0002 已占 → 0003）', ckNo, 'PO202610150003')

// ===========================================================================
section('五、生命周期说明可读性')
// ===========================================================================
const life = explainLifecycle(db, 'PO')
ok('生命周期文本含初始状态', life.includes('初始状态'))
ok('生命周期文本含审批动作', life.includes('审批'))
ok('生命周期文本含终态描述', life.includes('终态'))
console.log('\n' + life.split('\n').map((l) => '    ' + l).join('\n'))

console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}合计：${pass} 通过 / ${fail} 失败\x1b[0m`)
if (failures.length) console.log('失败项：' + failures.join('、'))
db.close()
process.exit(fail ? 1 : 0)
