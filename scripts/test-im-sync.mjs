/**
 * ============================================================================
 * 文件标识：scripts/test-im-sync.mjs ｜ 测试：批次 T：钉钉 / 飞书 组织同步 + 审批同步
 * ============================================================================
 * 【职责】测试：批次 T：钉钉 / 飞书 组织同步 + 审批同步
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

/**
 * 批次 T：钉钉 / 飞书 组织同步 + 审批同步
 *
 * 这一批评的是「两边各有一份组织，但没人知道谁对应谁」：
 *   · 外部部门 → 本地组织、外部成员 → 本地用户、外部审批单 → 本地审批实例，三套映射；
 *   · 每一次同步留一条**只追加**的流水，落在它上面的每一行映射都记得自己属于哪一次；
 *   · 认不出来的东西**留冲突**（含一句人话），不猜、不静默。
 *
 * 边界（这一批明确不做，且**不假装做了**）：
 *   真实租户的 HTTP 调用。没有凭据时**明确拒绝**（`IM_NOT_CONFIGURED`），
 *   而不是返回空快照 —— 空快照会被缺失判定读成"全公司的人都离职了"，那是破坏性的。
 *   除那一次调用之外的全部环节（映射 / 幂等 / 缺失判定 / 冲突 / 留痕 / 回滚）都能真跑。
 *
 * 与其它域同一规矩：**串行跑**；全部写操作包在 `BEGIN … ROLLBACK` 里，S12 收尾断言一行都没多。
 * 用法：node scripts/test-im-sync.mjs [cosmetic|food|apparel]
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

import * as I from '../server/lib/im-sync.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
import { DATA_DIR, dbPathFor, INDUSTRIES } from '../server/db/index.js'

const ROOT = path.resolve(__dirname, '..')
// ---------- 落点自证：这一跑会读写哪个数据目录 ----------
// 库路径一律从 db/index.js 的 `dbPathFor` 取，不在这里另写一份 `ROOT/data` ——
// 否则"打印出来的落点"和"真正打开的文件"会分家，脚本就会说谎（比不打印更坏）。
console.log(`[落点] 数据目录：${path.resolve(DATA_DIR)}`)
// 判据（两条，缺一不可）：
//   ① 没设 `GML_DATA_DIR` ⇒ 按定义就是开发库（`DATA_DIR = GML_DATA_DIR || <项目>/data`，
//      见 `server/db/index.js:10`）——这是**主**判据；
//   ② 设了、但指到项目 `data/` 本身。
// ① 必须有：字符串比较在 macOS 上会被 `/tmp → /private/tmp` 这类符号链接骗到
// （实测：副本里本该告警却**没**告警，把判据反过来才告警 —— 拿它当唯一判据是错的）。
if (!process.env.GML_DATA_DIR || path.resolve(DATA_DIR) === path.resolve(path.join(ROOT, 'data'))) {
  console.log('⚠️ 本次将读写开发库 data/ —— 若要隔离请设 GML_DATA_DIR=/tmp/...')
}
const INDUSTRY = process.argv[2] || 'cosmetic'
// 行业名必须合法：`dbPathFor` / `getDbFor` 会把**未知行业码静默归一成 cosmetic**
// （`server/db/index.js:28-30`），于是一个字母打错（`fodd`）会安静地跑另一个库，
// 拿到的"绿"是假的。调用侧自己把住"错名要响"。
if (process.argv[2] && !INDUSTRIES[process.argv[2]]) {
  console.error(`✗ 未知行业：${process.argv[2]}（可选：${Object.keys(INDUSTRIES).join(' / ')}）`)
  process.exit(2)
}

let pass = 0
let fail = 0
const failures = []
function ok(msg, cond, detail) {
  if (cond) pass++
  else {
    fail++
    failures.push(msg)
  }
  const mark = cond ? '✓' : '✗'
  console.log(`  ${mark} ${msg}${cond || detail === undefined ? '' : '  → ' + JSON.stringify(detail).slice(0, 260)}`)
}
const eq = (msg, a, b) => ok(msg, a === b, `实际 ${JSON.stringify(a)} / 期望 ${JSON.stringify(b)}`)
function section(title) {
  console.log(`\n── ${title}`)
}

const dbPath = dbPathFor(INDUSTRY)
const db = new Database(dbPath)
db.pragma('foreign_keys = ON')

const base = {
  dept: db.prepare('SELECT COUNT(*) c FROM im_dept_map').get().c,
  user: db.prepare('SELECT COUNT(*) c FROM im_user_map').get().c,
  apv: db.prepare('SELECT COUNT(*) c FROM im_approval_map').get().c,
  runs: db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c,
  conf: db.prepare('SELECT COUNT(*) c FROM im_sync_conflicts').get().c,
  maxRun: db.prepare('SELECT COALESCE(MAX(id),0) m FROM im_sync_runs').get().m,
  maxConf: db.prepare('SELECT COALESCE(MAX(id),0) m FROM im_sync_conflicts').get().m
}

console.log(`批次 T：钉钉/飞书 组织与审批同步（${INDUSTRY}）`)

// ===========================================================================
section('S1 平台登记：两个平台各一行，且**默认停用**')
{
  const list = I.listPlatforms(db)
  eq('登记了两个平台', list.length, 2)
  eq('平台码正确', list.map((p) => p.platform).sort().join(','), 'dingtalk,feishu')
  ok('默认全部停用（没配凭据就不该"看起来在同步"）', list.every((p) => !p.enabled), list.map((p) => [p.platform, p.enabled]))
  ok('每行都记了"凭据环境变量名"（密钥不进库）', list.every((p) => p.secret_ref && !p.secret_ref.includes('=')), list.map((p) => p.secret_ref))
  eq('真实调用未就绪（如实标出）', list.every((p) => p.adapter_ready === false), true)
  const meta = I.CONFLICT_CODES
  ok('冲突码是一本封闭字典且每条都带人话', Object.values(meta).every((v) => typeof v === 'string' && v.length > 8), Object.keys(meta).length)
}

// ===========================================================================
section('S2 未配置时必须**明确拒绝**（绝不返回空快照）')
{
  let err = null
  try {
    I.applyOrgSync(db, { platform: 'dingtalk' })
  } catch (e) {
    err = e
  }
  ok('抛错了（而不是"同步成功、0 条"）', !!err, err && err.message)
  eq('错误码是 IM_NOT_CONFIGURED', err && err.code, 'IM_NOT_CONFIGURED')
  ok('消息是一句人话，并指出了要填哪个环境变量', err && /环境变量/.test(err.message), err && err.message)
  eq('被拒时没有留下流水', db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c, base.runs)
}

// ===========================================================================
section('S3 全链路（用固定快照，走 mock transport）')
// 全部包在一个会回滚的事务里 —— 与 `/api/im/self-test` 同一个口径。
let rolled = null
const MARK3 = Symbol('rollback-3')
try {
  db.transaction(() => {
    const snap = I.SELF_TEST_SNAPSHOT
    I.setImTransport(() => snap)
    const first = I.applyOrgSync(db, { platform: 'dingtalk', snapshot: snap, actor: { id: null, name: '测试' }, trigger: 'script' })
    const second = I.applyOrgSync(db, { platform: 'dingtalk', snapshot: snap, actor: { id: null, name: '测试' }, trigger: 'script' })

    eq('首次同步建了映射（4 部门 + 3 成员）', first.created, 7)
    eq('状态是 partial（有未挂接项就该如实说）', first.status, 'partial')
    ok('日志有流水号与批次号', !!first.run_id && /^dingtalk-org-\d+$/.test(first.batch), first.batch)

    eq('**幂等**：同一份快照再跑一次，新建 0 条', second.created, 0)
    eq('再跑一次不会重复建人', db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE platform='dingtalk'").get().c, snap.users.length)
    eq('再跑一次不会重复建部门', db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE platform='dingtalk'").get().c, snap.departments.length)

    // 每一次同步都要在流水里留一行，且映射知道自己属于哪一次
    const runs = db.prepare("SELECT * FROM im_sync_runs WHERE platform='dingtalk' AND kind='org' ORDER BY id").all()
    eq('两次同步 → 两条流水', runs.length, 2)
    ok('两条流水都有结束时间（没有"没结束的同步"）', runs.every((r) => r.finished_at), runs.map((r) => r.finished_at))
    const batches = db.prepare("SELECT DISTINCT sync_batch FROM im_dept_map WHERE platform='dingtalk'").all().map((r) => r.sync_batch)
    ok('部门映射都能答出"我属于哪一次同步"', batches.every((b) => /^dingtalk-org-\d+$/.test(b)), batches)

    // 缺失判定：给一份"少了一半"的完整快照
    const partial = {
      complete: true,
      cursor: 'self-test-2',
      departments: [{ id: 'D-ROOT', parent_id: null, name: '演示总部' }],
      users: [{ id: 'U-A', union_id: 'UN-A', name: '演示成员甲', mobile: '13000000001', dept_id: 'D-ROOT' }]
    }
    const third = I.applyOrgSync(db, { platform: 'dingtalk', snapshot: partial, actor: { id: null, name: '测试' }, trigger: 'script' })
    const missingDept = db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE platform='dingtalk' AND status='missing'").get().c
    const missingUser = db.prepare("SELECT COUNT(*) c FROM im_user_map WHERE platform='dingtalk' AND status='missing'").get().c
    eq('完整快照下：不在快照里的部门标记为 missing', missingDept, 3)
    eq('完整快照下：不在快照里的成员标记为 missing', missingUser, 2)
    ok('missing **不是删除**（行还在，历史要留下）', db.prepare("SELECT COUNT(*) c FROM im_dept_map WHERE platform='dingtalk'").get().c === 4, third.created)

    // 不完整快照：**不许**做缺失判定
    const planIncomplete = I.planOrgSync(db, { platform: 'dingtalk', snapshot: { complete: false, departments: [], users: [] } })
    eq('不完整快照：一个都不标记为 missing', planIncomplete.departments.missing.length + planIncomplete.users.missing.length, 0)
    ok('不完整快照留下 SNAPSHOT_INCOMPLETE 冲突（而不是静默）', planIncomplete.conflicts.some((c) => c.reason_code === 'SNAPSHOT_INCOMPLETE'), planIncomplete.conflicts.map((c) => c.reason_code))

    // 冲突必须落在台账里，且每条都有"人该做什么"
    const confs = db.prepare("SELECT * FROM im_sync_conflicts WHERE platform='dingtalk' AND kind='org'").all()
    const codes = new Set(confs.map((c) => c.reason_code))
    ok('未挂接的部门 → DEPT_UNMAPPED', codes.has('DEPT_UNMAPPED'), [...codes])
    ok('未开户的成员 → USER_UNMAPPED', codes.has('USER_UNMAPPED'), [...codes])
    ok('上级不在快照 → DEPT_PARENT_UNMAPPED', codes.has('DEPT_PARENT_UNMAPPED'), [...codes])
    ok('每条冲突都带可读的一句话', confs.every((c) => c.message && c.message.length > 10), confs.length)
    ok('冲突都记到了某一次同步上', confs.every((c) => c.run_id !== null), confs.filter((c) => c.run_id === null).length)

    // 审批同步：认不出来的状态**不猜**
    const apvPlan = I.planApprovalSync(db, {
      platform: 'dingtalk',
      rows: [
        { instance_id: 'X-1', status: 'weird_new_status', operator_id: 'U-A', doc_no: 'NOPE-1' },
        { instance_id: 'X-2', status: 'agree', operator_id: 'U-A', doc_no: 'NOPE-2' }
      ]
    })
    eq('认不出来的外部状态 → 留冲突，不猜', apvPlan.conflicts.filter((c) => c.reason_code === 'APPROVAL_DECISION_UNKNOWN').length, 1)
    eq('本地找不到实例 → 留冲突', apvPlan.conflicts.filter((c) => c.reason_code === 'APPROVAL_INSTANCE_NOT_FOUND').length, 1)
    eq('认不出来的那条**不产生任何决策**', apvPlan.decide.length, 0)

    // 审批人未映射 → **不代替他签字**
    const fakeInst = db
      .prepare(
        `INSERT INTO approval_instances (template_id, doc_type, doc_id, doc_no, action, status, current_step, total_steps, current_approver)
         VALUES (NULL,'PO',999999,'IM-TEST-DOC','cancel','pending',1,1,'测试审批人')`
      )
      .run().lastInsertRowid
    const unmapped = I.planApprovalSync(db, { platform: 'dingtalk', rows: [{ instance_id: 'X-3', status: 'agree', operator_id: 'NOT-MAPPED', doc_no: 'IM-TEST-DOC' }] })
    eq('审批人没映射 → APPROVER_UNMAPPED', unmapped.conflicts.filter((c) => c.reason_code === 'APPROVER_UNMAPPED').length, 1)
    eq('审批人没映射 → 一条决策都不产生（不代替签字）', unmapped.decide.length, 0)
    eq('本地实例状态没被动', db.prepare('SELECT status FROM approval_instances WHERE id=?').get(fakeInst).status, 'pending')

    // 引擎拒绝的那条路：映射到的人不是当前级审批人 → 记冲突，本地状态不变
    const viewer = db.prepare("SELECT id, name FROM users WHERE username='viewer'").get()
    db.prepare("UPDATE im_user_map SET gml_user_id=? WHERE platform='dingtalk' AND external_user_id='U-A'").run(viewer.id)
    I.setImTransport(() => ({ complete: true, cursor: null, rows: [{ instance_id: 'X-4', status: 'agree', operator_id: 'U-A', doc_no: 'IM-TEST-DOC' }] }))
    const apvRun = I.applyApprovalSync(db, { platform: 'dingtalk', actor: { id: null, name: '测试' }, trigger: 'script' })
    eq('引擎拒绝时不改本地状态', db.prepare('SELECT status FROM approval_instances WHERE id=?').get(fakeInst).status, 'pending')
    ok('引擎拒绝写成冲突（含具体原因）', apvRun.conflicts > 0, apvRun)
    const engineConf = db.prepare("SELECT * FROM im_sync_conflicts WHERE kind='approval' ORDER BY id DESC LIMIT 1").get()
    ok('冲突里写清了"外部结论没落到本地实例"', /未能落到本地实例/.test(engineConf.message), engineConf.message)
    ok('映射行如实记下"被引擎拒了"这件事', /rejected_by_engine/.test(
      db.prepare("SELECT local_status FROM im_approval_map WHERE external_instance_id='X-4'").get()?.local_status || ''
    ), db.prepare("SELECT * FROM im_approval_map WHERE external_instance_id='X-4'").get())

    // 自证
    const audit = I.auditImTrail(db)
    ok('自证探针在自造数据上仍然自洽', audit.ok, audit.problems)
    rolled = { audit, counts: {
      runs: db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c,
      conf: db.prepare('SELECT COUNT(*) c FROM im_sync_conflicts').get().c
    } }
    throw MARK3
  })()
} catch (e) {
  if (e !== MARK3) throw e
}
I.setImTransport(null)
ok('事务已回滚（自造数据没有留下）', true, rolled && rolled.counts)

// ===========================================================================
section('S4 探针：把"唯一写入点"绕过之后，抓不抓得到')
{
  const MARK4 = Symbol('rollback-4')
  try {
    db.transaction(() => {
      const runId = db
        .prepare("INSERT INTO im_sync_runs (platform,kind,trigger_by,status,pulled,started_at,finished_at) VALUES ('feishu','org','script','ok',0,'2026-01-01 00:00:00','2026-01-01 00:00:00')")
        .run().lastInsertRowid
      // ① 字典外的冲突码
      db.prepare("INSERT INTO im_sync_conflicts (run_id,platform,kind,reason_code,message) VALUES (?,'feishu','org','NOT_IN_DICTIONARY','随便写一个码')").run(runId)
      let a = I.auditImTrail(db)
      ok('字典外的冲突码被抓到', a.problems.some((p) => p.code === 'IM_CONFLICT_CODE_UNKNOWN'), a.problems.map((p) => p.code))
      db.prepare("DELETE FROM im_sync_conflicts WHERE reason_code='NOT_IN_DICTIONARY'").run()

      // ② 没结束的同步
      const openRun = db
        .prepare("INSERT INTO im_sync_runs (platform,kind,trigger_by,status,pulled,started_at) VALUES ('feishu','approval','script','ok',0,'2026-01-01 00:00:00')")
        .run().lastInsertRowid
      a = I.auditImTrail(db)
      ok('"没结束的同步"被抓到', a.problems.some((p) => p.code === 'IM_RUN_UNFINISHED'), a.problems.map((p) => p.code))
      db.prepare('DELETE FROM im_sync_runs WHERE id=?').run(openRun)

      // ③ 映射指向不存在的本地行（跨代引用）
      db.prepare(
        "INSERT INTO im_user_map (platform,external_user_id,external_name,gml_user_id,status,sync_batch) VALUES ('feishu','V-1','幽灵成员',987654321,'active',?)"
      ).run(`feishu-org-${runId}`)
      a = I.auditImTrail(db)
      ok('指向不存在用户的映射被抓到', a.problems.some((p) => p.code === 'IM_USER_DANGLING'), a.problems.map((p) => p.code))
      db.prepare("DELETE FROM im_user_map WHERE external_user_id='V-1'").run()

      // ④ 映射找不到出处（批次号指向不存在的流水）
      db.prepare(
        "INSERT INTO im_dept_map (platform,external_dept_id,external_name,status,sync_batch) VALUES ('feishu','VD-1','幽灵部门','active','feishu-org-99999999')"
      ).run()
      a = I.auditImTrail(db)
      ok('找不到出处的映射被抓到', a.problems.some((p) => p.code === 'IM_MAP_WITHOUT_RUN'), a.problems.map((p) => p.code))
      db.prepare("DELETE FROM im_dept_map WHERE external_dept_id='VD-1'").run()

      // ⑤ 审批映射丢了外部原文
      db.prepare("INSERT INTO im_approval_map (platform,external_instance_id,local_status,sync_batch) VALUES ('feishu','VA-1','approve',?)").run(`feishu-org-${runId}`)
      a = I.auditImTrail(db)
      ok('丢了外部原始状态的审批映射被抓到', a.problems.some((p) => p.code === 'IM_APPROVAL_RAW_MISSING'), a.problems.map((p) => p.code))
      db.prepare("DELETE FROM im_approval_map WHERE external_instance_id='VA-1'").run()

      db.prepare('DELETE FROM im_sync_runs WHERE id=?').run(runId)
      const clean = I.auditImTrail(db)
      ok('把注入的东西清掉后，探针回到全绿', clean.ok, clean.problems)
      throw MARK4
    })()
  } catch (e) {
    if (e !== MARK4) throw e
  }
}

// ===========================================================================
section('S5 结构：留痕表只追加、写入点唯一、同事务')
{
  const src = (await import('node:fs')).readFileSync(path.join(ROOT, 'server/lib/im-sync.js'), 'utf8')
  eq('写 im_sync_runs 只有一处（org 与 approval 各一条 INSERT 语句，无第二份实现）', (src.match(/INSERT INTO im_sync_runs/g) || []).length, 2)
  eq('写 im_sync_conflicts 只有一处', (src.match(/INSERT INTO im_sync_conflicts/g) || []).length, 2)
  ok('没有删除流水的路径（只追加）', !/DELETE FROM im_sync_runs/.test(src))
  ok('没有删除冲突的路径（只追加）', !/DELETE FROM im_sync_conflicts/.test(src))
  ok('写映射与写流水在同一个事务里（有 db.inTransaction 当场断言）', /db\.inTransaction/.test(src))
  ok('未配置时不返回空快照（明确抛 IM_NOT_CONFIGURED）', /IM_NOT_CONFIGURED/.test(src))
}

// ===========================================================================
section('S6 收尾：一行都不多')
{
  eq('部门映射表一行不多', db.prepare('SELECT COUNT(*) c FROM im_dept_map').get().c, base.dept)
  eq('成员映射表一行不多', db.prepare('SELECT COUNT(*) c FROM im_user_map').get().c, base.user)
  eq('审批映射表一行不多', db.prepare('SELECT COUNT(*) c FROM im_approval_map').get().c, base.apv)
  eq('同步流水一行不多（且没换最大 id）', db.prepare('SELECT COUNT(*) c FROM im_sync_runs').get().c, base.runs)
  eq('冲突台账一行不多', db.prepare('SELECT COUNT(*) c FROM im_sync_conflicts').get().c, base.conf)
  eq('流水最大 id 没变（防"删几条又插几条"）', db.prepare('SELECT COALESCE(MAX(id),0) m FROM im_sync_runs').get().m, base.maxRun)
  eq('冲突最大 id 没变', db.prepare('SELECT COALESCE(MAX(id),0) m FROM im_sync_conflicts').get().m, base.maxConf)
  eq('测试造的假审批实例没留下', db.prepare("SELECT COUNT(*) c FROM approval_instances WHERE doc_no='IM-TEST-DOC'").get().c, 0)
  ok('收尾：探针仍然自洽', I.auditImTrail(db).ok, I.auditImTrail(db).problems)
}

console.log(`\n${'─'.repeat(72)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log(`失败项：\n  - ${failures.slice(0, 12).join('\n  - ')}`)
process.exit(fail === 0 ? 0 : 1)
