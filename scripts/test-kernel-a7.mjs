#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/test-kernel-a7.mjs ｜ 测试：【复现脚本】A7：审批"默认放行"必须与"直接调业务入口"结果一致（批次 V）
 * ============================================================================
 * 【职责】测试：【复现脚本】A7：审批"默认放行"必须与"直接调业务入口"结果一致（批次 V）
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// 【复现脚本】A7：审批"默认放行"必须与"直接调业务入口"结果一致（批次 V）
//
//   用法：GML_DATA_DIR=/tmp/xxx node scripts/test-kernel-a7.mjs [cosmetic|food|apparel]
//
// 复现的结论（审计 A7）：
//   修前 —— `PAY.void` 经审批放行后付款单变 voided，而结算单 paid_amount 仍是 43771.20；
//           `PI.void` 经审批放行后，关联采购订单的 invoice_amount 不归零。
//   修后 —— 两条路的派生字段**逐字相同**（脚本自己给 PASS/FAIL）。
//
// 做法：两条路各跑在**刚从仓库 data/ 只读备份出来的**隔离库上（各自一个子进程），然后逐字比对。
//   direct   = transitionPayment / transitionInvoice（业务正门）
//   approval = 启用 APV-PAY-VOID / APV-PI-VOID → 提交审批 → 财务审批通过（被测路径）
//
// 为什么是子进程：better-sqlite3 的连接池在模块级缓存，同一进程里"换库重跑"换不干净。
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_DATA = path.join(ROOT, 'data')

// 隔离规则（本项目硬纪律）：
//   · 未设 GML_DATA_DIR ⇒ **自落**到 /tmp/gml-kernel-<脚本名>（所以它也能被 regress-all 自动发现而不碰仓库 data/）
//   · 指向仓库 data/ 或任何非 /tmp 路径 ⇒ 当场 exit 2 拒跑
//   · 本脚本只**只读**地从仓库 data/ 备份到隔离目录，绝不写 data/
function requireIsolatedDataDir() {
  const name = path.basename(fileURLToPath(import.meta.url)).replace(/\.mjs$/, '')
  const raw = process.env.GML_DATA_DIR || ''
  const abs = raw ? path.resolve(raw) : path.join('/tmp', `gml-kernel-${name}`)
  if (abs === REPO_DATA || abs.startsWith(REPO_DATA + path.sep)) {
    console.error(`✗ 拒绝运行：隔离目录指向仓库 data/（${abs}）。本脚本只允许在 /tmp 下的副本上跑。`); process.exit(2)
  }
  if (!abs.startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：隔离目录必须在 /tmp 下（实得 ${abs}）；不设 GML_DATA_DIR 时会自落到 /tmp/gml-kernel-${name}。`); process.exit(2)
  }
  fs.mkdirSync(abs, { recursive: true })
  // ⚠️ **先钉 env、再 import** `server/db/index.js` —— 顺序不能反。
  //    `db/index.js:11` 的 `DATA_DIR = process.env.GML_DATA_DIR || <仓库>/data` 在**模块加载时**求值。
  //    子进程分支（`--mode`）会在本进程里 import 它 ⇒ 不钉的话，"自落 /tmp" 只是一句话，
  //    实际 `initSchemaFor()/getDb()` 落到**仓库 data/**（自愈还会写进去），而脚本照样打绿。
  process.env.GML_DATA_DIR = abs
  console.log(`${raw ? 'GML_DATA_DIR' : '未设 GML_DATA_DIR ⇒ 自落'} 隔离库目录：${abs}（仓库 data/ 不会被写）`)
  return abs
}

const isMode = process.argv.includes('--mode')

if (!isMode) {
  const dir = requireIsolatedDataDir()
  const industry = process.argv[2] && ['cosmetic', 'food', 'apparel'].includes(process.argv[2]) ? process.argv[2] : 'cosmetic'

  // 从仓库 data/ 只读备份（SQLite backup API：与 WAL 一致的快照；**不写 data/**）
  const Database = (await import('better-sqlite3')).default
  const refresh = async () => {
    const src = new Database(path.join(REPO_DATA, `gml_${industry}.db`), { readonly: true })
    const dst = path.join(dir, `gml_${industry}.db`)
    for (const ext of ['', '-wal', '-shm']) { const p = dst + ext; if (fs.existsSync(p)) fs.rmSync(p) }
    await src.backup(dst)
    src.close()
  }

  const runMode = async (mode) => {
    await refresh()
    // ⚠️ 这里**必须显式注入 `GML_DATA_DIR: dir`**，别改成"让子进程继承 process.env"。
    //    理由：子进程分支会在**自己的进程里** import `server/db/index.js`；隔离目录是在
    //    子进程内由 `requireIsolatedDataDir()` 重新解析的（有 env 才拿得到 dir）。
    //    虽然现在父进程也把 env 钉成了同一个 dir（继承也不会错），但把"注入口"改成隐式继承，
    //    下一个人只要动一下父进程的钉法就会静默落到仓库 data/。显式注入是这条链的承重点。
    let out
    try {
      out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), industry, '--mode', mode], {
        cwd: ROOT, env: { ...process.env, GML_DATA_DIR: dir }, encoding: 'utf8'
      })
    } catch (e) {
      // 子进程被闸门拒跑（exit 2）或自身抛错时，必须把**它的输出原样亮出来** ——
      // 否则外面只剩一段栈，看不到"DATA_DIR 落在仓库 data/"这句真正的结论。
      process.stderr.write(String(e.stdout || ''))
      process.stderr.write(String(e.stderr || ''))
      throw new Error(`子进程 ${mode} 退出码 ${e.status}（若为 2：多半是"隔离没生效"的闸门拒跑，见上面 DATA_DIR 原文）`)
    }
    // 子进程的"落点自证"必须被**父进程看见并复判**，否则它就是一句只写在纸上的话：
    // 子进程打印的这行取自它真实用的 `DATA_DIR`（db/index.js 的导出），父进程这里再判一次。
    // 抓不到这行 ⇒ 直接报错，不把"看不见"当成"没问题"。
    const gate = /实际使用 DATA_DIR=(\S+?)（已过 \/tmp 闸门）/.exec(out)
    if (!gate) throw new Error(`子进程 ${mode} 没有打印 DATA_DIR 闸门行 —— 无法确认它跑在隔离库上：\n${out.slice(0, 400)}`)
    if (!gate[1].startsWith('/tmp/')) throw new Error(`子进程 ${mode} 的 DATA_DIR=${gate[1]} 不在 /tmp 下`)
    if (!runMode.logged) { console.log(`子进程 db/index.js 实际使用 DATA_DIR=${gate[1]}（已过 /tmp 闸门）`); runMode.logged = true }

    const m = /\{[\s\S]*\}\s*$/.exec(out)
    if (!m) throw new Error(`${mode} 未产出 JSON：\n${out}`)
    return JSON.parse(m[0])
  }

  let fail = 0
  for (const docType of ['PAY', 'PI']) {
    const d = await runMode(`${docType}:direct`)
    const a = await runMode(`${docType}:approval`)
    const same = JSON.stringify(d.derived_after) === JSON.stringify(a.derived_after) && !a.err
    if (!same) fail++
    console.log(`\n[${docType}] 单据 ${d.doc.doc_no}：${d.doc.status} → ${d.doc.status_after}`)
    console.log(`  正门     : ${JSON.stringify(d.derived_after)}`)
    console.log(`  审批放行 : ${JSON.stringify(a.derived_after)}  applied=${JSON.stringify(a.applied)} err=${a.err}`)
    console.log(`  ${same ? '✓ 两条路逐字相同' : '✗ 两条路不一致'}`)
  }
  console.log(`\n${fail ? '✗ A7 复现失败' : '✓ A7 结论成立：审批放行与业务正门结果一致'}`)
  process.exit(fail ? 1 : 0)
} else {
  // ---- 子进程：单条路 ----
  requireIsolatedDataDir()
  const modeArg = process.argv[process.argv.indexOf('--mode') + 1]
  const [docType, mode] = modeArg.split(':')
  const industry = process.argv[2]

  const { runWithIndustry, initSchemaFor, getDb, DATA_DIR } = await import('../server/db/index.js')
  // 闸门（**启动即验**）：报告与实际必须同源 —— 判的就是模块**真实用的**那个 DATA_DIR。
  // 只要它不落在 /tmp 下就当场拒跑：否则 `initSchemaFor()/getDb()` 会打开并写**仓库 data/**，
  // 而两条路逐字比对照样可能"通过"（比的是一个被污染的库）。
  if (!String(DATA_DIR).startsWith('/tmp/')) {
    console.error(`✗ 拒绝运行：db/index.js 实际解析出的 DATA_DIR=${DATA_DIR} 不在 /tmp 下 —— 隔离没生效，会写仓库 data/。`)
    process.exit(2)
  }
  console.log(`db/index.js 实际使用 DATA_DIR=${DATA_DIR}（已过 /tmp 闸门）`)
  const { transitionPayment, transitionInvoice, invoiceOrderIds } = await import('../server/lib/purchase.js')
  const { submitApproval, decideApproval } = await import('../server/lib/approval.js')

  initSchemaFor(industry)
  runWithIndustry(industry, () => {
    const db = getDb()
    const actor = { id: null, name: 'repro-a7' }
    const me = (() => {
      const u = db.prepare("SELECT id,name FROM users WHERE role='finance' ORDER BY id LIMIT 1").get()
        || db.prepare('SELECT id,name FROM users ORDER BY id LIMIT 1').get()
      return { id: u.id, name: u.name }
    })()

    let docId, snapshot, applied = null, err = null
    if (docType === 'PAY') {
      const pay = db.prepare("SELECT * FROM purchase_payments WHERE status='approved' ORDER BY id LIMIT 1").get()
      const sids = db.prepare('SELECT DISTINCT settle_id FROM purchase_payment_items WHERE payment_id=? AND settle_id IS NOT NULL').all(pay.id).map((r) => r.settle_id)
      const snap = () => sids.map((sid) => db.prepare('SELECT id,doc_no,status,settle_amount,paid_amount FROM purchase_settlements WHERE id=?').get(sid))
      docId = pay.id
      snapshot = { before: snap(), doc: { id: pay.id, doc_no: pay.doc_no, status: pay.status } }
      if (mode === 'direct') transitionPayment(db, { id: pay.id, action: 'void', actor, remark: '正门作废' })
      if (mode !== 'direct') { /* approval 分支统一在下面 */ } else snapshot.after = snap()
    } else {
      const inv = db.prepare("SELECT * FROM purchase_invoices WHERE status IN ('submitted','verified') ORDER BY id LIMIT 1").get()
        || db.prepare("SELECT * FROM purchase_invoices WHERE status='draft' ORDER BY id LIMIT 1").get()
      const oids = invoiceOrderIds(db, inv.id)
      const snap = () => oids.map((oid) => db.prepare('SELECT id,doc_no,status,invoice_amount,settle_amount,close_invoice FROM purchase_orders WHERE id=?').get(oid))
      docId = inv.id
      snapshot = { before: snap(), doc: { id: inv.id, doc_no: inv.doc_no, status: inv.status }, order_ids: oids }
      if (mode === 'direct') transitionInvoice(db, { id: inv.id, action: 'void', actor, remark: '正门作废' })
      if (mode === 'direct') snapshot.after = snap()
    }

    if (mode === 'approval') {
      const tplCode = docType === 'PAY' ? 'APV-PAY-VOID' : 'APV-PI-VOID'
      db.prepare('UPDATE approval_templates SET enabled=1 WHERE code=?').run(tplCode)
      const inst = submitApproval(db, { docType, docId, docNo: snapshot.doc.doc_no, action: 'void', actor: me })
      try {
        const out = decideApproval(db, { instanceId: inst.id, decision: 'approve', comment: '同意作废', actor: me })
        applied = out.applied && { to: out.applied.to, from: out.applied.from }
        snapshot.after = docType === 'PAY'
          ? db.prepare('SELECT id,doc_no,status,settle_amount,paid_amount FROM purchase_settlements WHERE id=?').all(snapshot.before[0]?.id)
          : snapshot.order_ids.map((oid) => db.prepare('SELECT id,doc_no,status,invoice_amount,settle_amount,close_invoice FROM purchase_orders WHERE id=?').get(oid))
      } catch (e) { err = `${e.code || e.name}: ${e.message}` }
    }

    const docAfter = docType === 'PAY'
      ? db.prepare('SELECT id,doc_no,status FROM purchase_payments WHERE id=?').get(docId)
      : db.prepare('SELECT id,doc_no,status FROM purchase_invoices WHERE id=?').get(docId)
    console.log(JSON.stringify({
      industry, docType, mode,
      doc: { ...snapshot.doc, status_after: docAfter.status },
      derived_before: snapshot.before, derived_after: snapshot.after, applied, err
    }))
  })
}
