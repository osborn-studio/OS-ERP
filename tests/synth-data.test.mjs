/**
 * ============================================================================
 * 文件标识：tests/synth-data.test.mjs ｜ 测试：合成大库生成器（Y10）最小规模冒烟 + 不变量 + 确定性 + 安全拒绝
 * ============================================================================
 * 【职责】用真实子进程跑 scripts/synth-data.mjs 的最小规模，断言：生成的库是生产分类、库存 = 流水净额、
 *   授信投影经 reconcileOrderHolds 对账为空、无孤儿行；同种子两次运行业务摘要相同；
 *   缺显式目录 / 仓库 data/ / 非空目录 / 非生产模式 / GML_DB 改道一律以退出码 2 拒绝且不写任何文件。
 *   另用独立只读连接重算不变量（不信生成器自己的 verify），并证明"篡改库存会红"。
 * 【改它要注意什么】子进程环境白名单；每个目录都是 mkdtemp 的新目录，用后删除。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, readdirSync, existsSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { parseArgs, makeRng, verifyInvariants } from '../scripts/synth-data.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SYNTH = path.join(ROOT, 'scripts/synth-data.mjs')
const tmp = (t, prefix) => { const d = mkdtempSync(path.join(tmpdir(), prefix)); t.after(() => rmSync(d, { recursive: true, force: true })); return d }
const run = (args, env) => spawnSync(process.execPath, [SYNTH, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 240000, env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), ...env }
})
const prodEnv = (dir, extra = {}) => ({ GML_RUNTIME_MODE: 'production', GML_DATA_DIR: dir, GML_DB: '', GML_SYNTH_ADMIN_PASSWORD: 'Synthetic-Pass-0123456789', ...extra })
const DB_NAME = 'gml_cosmetic.db'
const SMALL = ['--skus', '24', '--txns', '240', '--docs', '60', '--quiet']

test('parseArgs validates ranges and rng is deterministic', () => {
  assert.equal(parseArgs([]).skus, 60)
  assert.throws(() => parseArgs(['--skus', '0']), /skus/)
  assert.throws(() => parseArgs(['--docs', 'x']), /整数/)
  assert.throws(() => parseArgs(['--bogus']), /未知参数/)
  assert.throws(() => parseArgs(['--anchor', '2026-13-99']), /anchor/)
  const a = makeRng(7); const b = makeRng(7)
  assert.deepEqual([a(), a(), a()], [b(), b(), b()])
  assert.notEqual(makeRng(7)(), makeRng(8)())
})

test('smallest scale builds a production-classified DB whose invariants hold (verified independently)', { timeout: 240000 }, async (t) => {
  const dir = tmp(t, 'os-synth-a-')
  const out = path.join(tmp(t, 'os-synth-out-'), 'summary.json')
  const r = run([...SMALL, '--out', out], prodEnv(path.join(dir, 'data')))
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const summary = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(summary.invariants.ok, true, JSON.stringify(summary.invariants.checks.filter((c) => !c.ok)))
  const names = summary.invariants.checks.map((c) => c.name)
  for (const n of ['stock_equals_txn_net', 'credit_hold_reconciles(reconcileOrderHolds)', 'no_orphan_rows(foreign_key_check)', 'credit_ledger_balanced(auditCredit)']) assert.ok(names.includes(n), n)
  assert.ok(summary.table_counts.inventory_transactions >= 240, 'txn target reached')
  assert.ok(summary.counts.purchase_orders > 0 && summary.counts.sales_orders > 0 && summary.counts.delivered > 0 && summary.counts.cancelled >= 0)
  assert.ok(summary.table_counts.credit_ledger > 0, 'credit ledger exercised')

  // 独立核对：不经过生成器自己的 verifyInvariants 实现之外的路径——只读打开，分类标记 + 逐项再算
  const file = path.join(dir, 'data', DB_NAME)
  const db = new Database(file, { readonly: true })
  t.after(() => db.close())
  assert.equal(db.prepare('SELECT mode FROM os_egp_runtime WHERE id=1').get().mode, 'production')
  assert.equal(db.prepare('SELECT COUNT(*) c FROM users').get().c, 1)
  const bad = db.prepare(`SELECT COUNT(*) c FROM inventory_stocks s WHERE ABS(s.qty_on_hand -
    COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN qty ELSE -qty END) FROM inventory_transactions t
      WHERE t.warehouse_id=s.warehouse_id AND t.sku_id=s.sku_id AND COALESCE(t.batch_no,'')=COALESCE(s.batch_no,'')),0)) > 0.0001`).get().c
  assert.equal(bad, 0)
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [])
  assert.equal(db.prepare("SELECT COUNT(*) c FROM sales_orders WHERE status NOT IN ('cancelled','draft') AND credit_hold>0").get().c > 0, true)
  // 迁移全部由真实运行器写入
  assert.ok(db.prepare('SELECT COUNT(*) c FROM schema_migrations').get().c >= 50)
  // 数据目录里除库文件外只有 0 个密码文件（密码来自环境）
  assert.equal(existsSync(path.join(dir, 'data', 'synth-admin-password.txt')), false)
})

test('verifyInvariants goes red when stock is tampered with or a hold is faked', { timeout: 240000 }, async (t) => {
  const dir = tmp(t, 'os-synth-b-')
  const r = run(SMALL, prodEnv(path.join(dir, 'data')))
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const db = new Database(path.join(dir, 'data', DB_NAME))
  t.after(() => db.close())
  assert.equal((await verifyInvariants(db)).ok, true)
  db.prepare('UPDATE inventory_stocks SET qty_on_hand = qty_on_hand + 5 WHERE id = (SELECT MIN(id) FROM inventory_stocks)').run()
  const red = await verifyInvariants(db)
  assert.equal(red.ok, false)
  assert.equal(red.checks.find((c) => c.name === 'stock_equals_txn_net').ok, false)
  db.prepare('UPDATE inventory_stocks SET qty_on_hand = qty_on_hand - 5 WHERE id = (SELECT MIN(id) FROM inventory_stocks)').run()
  db.prepare("UPDATE sales_orders SET credit_hold = credit_hold + 1 WHERE id = (SELECT MIN(id) FROM sales_orders WHERE credit_hold>0)").run()
  const red2 = await verifyInvariants(db)
  assert.equal(red2.checks.find((c) => c.name === 'credit_hold_reconciles(reconcileOrderHolds)').ok, false)
})

test('same seed twice gives the same business digest; a different seed differs', { timeout: 480000 }, (t) => {
  const digestOf = (extra) => {
    const dir = tmp(t, 'os-synth-d-')
    const r = run([...SMALL, ...extra], prodEnv(path.join(dir, 'data')))
    assert.equal(r.status, 0, r.stderr + r.stdout)
    return JSON.parse(r.stdout.trim().split('\n').at(-1)).digest
  }
  const a = digestOf([]); const b = digestOf([])
  assert.equal(a, b)
  assert.notEqual(a, digestOf(['--seed', '99']))
})

test('refuses unsafe environments with exit 2 and writes nothing', (t) => {
  const none = run(SMALL, { GML_RUNTIME_MODE: 'production' })
  assert.equal(none.status, 2)
  assert.equal(run(SMALL, prodEnv('relative/dir')).status, 2)
  const repoData = run(SMALL, prodEnv(path.resolve(ROOT, 'data')))
  assert.equal(repoData.status, 2)
  assert.match(repoData.stderr, /data/)
  const repoSub = run(SMALL, prodEnv(path.resolve(ROOT, 'data', 'synth-x')))
  assert.equal(repoSub.status, 2)
  assert.equal(existsSync(path.resolve(ROOT, 'data', 'synth-x')), false)

  const nonEmpty = tmp(t, 'os-synth-ne-')
  const before = readdirSync(nonEmpty)
  writeFileLike(nonEmpty)
  assert.equal(run(SMALL, prodEnv(nonEmpty)).status, 2, 'non-empty dir (could be a live instance) refused')
  assert.deepEqual(readdirSync(nonEmpty).filter((f) => !before.includes(f)), ['live.db'])

  const fresh = tmp(t, 'os-synth-m-')
  assert.equal(run(SMALL, prodEnv(path.join(fresh, 'x'), { GML_RUNTIME_MODE: 'demo' })).status, 2)
  assert.equal(run(SMALL, prodEnv(path.join(fresh, 'x'), { GML_RUNTIME_MODE: undefined })).status, 2)
  assert.equal(run(SMALL, prodEnv(path.join(fresh, 'x'), { GML_DB: path.join(fresh, 'other.db') })).status, 2)
  assert.equal(existsSync(path.join(fresh, 'x')), false)
  assert.equal(existsSync(path.join(fresh, 'other.db')), false)
  assert.equal(run([...SMALL, '--out', path.resolve(ROOT, 'data', 's.json')], prodEnv(path.join(fresh, 'x'))).status, 2)
  assert.equal(statSync(fresh).isDirectory(), true)
})

test('symlinks cannot smuggle generation or output into repository data or over another file', (t) => {
  const base = tmp(t, 'os-synth-link-')
  // 指向仓库 data/ 的（可能悬空的）符号链接，下面再套一个尚不存在的子目录
  const alias = path.join(base, 'alias')
  symlinkSync(path.resolve(ROOT, 'data'), alias)
  assert.equal(run(SMALL, prodEnv(path.join(alias, 'new-run'))).status, 2)
  assert.equal(run(SMALL, prodEnv(alias)).status, 2)
  assert.equal(existsSync(path.resolve(ROOT, 'data', 'new-run')), false)
  assert.equal(pipe(['--dir', path.join(alias, 'new-run')]).status, 2)
  // 输出文件是指向别的文件的符号链接 / 已存在文件：拒绝且目标原样
  const victim = path.join(base, 'victim.db')
  writeFileSync(victim, 'precious')
  const link = path.join(base, 'out.json')
  symlinkSync(victim, link)
  assert.equal(run([...SMALL, '--out', link], prodEnv(path.join(base, 'g1'))).status, 2)
  assert.equal(run([...SMALL, '--out', victim], prodEnv(path.join(base, 'g2'))).status, 2)
  assert.equal(pipe(['--dir', path.join(base, 'p1'), '--out', link]).status, 2)
  assert.equal(pipe(['--dir', path.join(base, 'p2'), '--out', victim]).status, 2)
  assert.equal(readFileSync(victim, 'utf8'), 'precious')
  assert.equal(existsSync(path.join(base, 'g1')) || existsSync(path.join(base, 'p1')), false)
  // GML_DATA_DIR 自身是链接（即使指向空目录）也拒绝
  const real = path.join(base, 'real'); mkdirSync(real)
  const selfLink = path.join(base, 'self')
  symlinkSync(real, selfLink)
  assert.equal(run(SMALL, prodEnv(selfLink)).status, 2)
})

function writeFileLike(dir) {
  const db = new Database(path.join(dir, 'live.db'))
  db.exec('CREATE TABLE marker(x)')
  db.close()
}

const PIPE = path.join(ROOT, 'scripts/synth-pipeline.mjs')
const pipe = (args, env = {}) => spawnSync(process.execPath, [PIPE, ...args], {
  cwd: ROOT, encoding: 'utf8', timeout: 600000, env: { PATH: process.env.PATH, HOME: tmpdir(), TMPDIR: tmpdir(), ...env }
})

test('pipeline refuses relative, repository-data and non-empty directories', (t) => {
  assert.equal(pipe([]).status, 2)
  assert.equal(pipe(['--dir', 'rel/dir']).status, 2)
  assert.equal(pipe(['--dir', path.resolve(ROOT, 'data', 'pipe')]).status, 2)
  assert.equal(existsSync(path.resolve(ROOT, 'data', 'pipe')), false)
  const ne = tmp(t, 'os-pipe-ne-')
  writeFileLike(ne)
  assert.equal(pipe(['--dir', ne]).status, 2)
})

test('pipeline runs generate, plain+encrypted backup, both restore drills, explain-audit and bench end to end', { timeout: 600000 }, (t) => {
  const work = tmp(t, 'os-pipe-run-')
  const out = path.join(tmp(t, 'os-pipe-out-'), 'report.json')
  const r = pipe(['--dir', path.join(work, 'w'), '--skus', '24', '--txns', '240', '--docs', '60', '--iterations', '5', '--concurrency', '2', '--out', out])
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const rep = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(rep.ok, true)
  assert.match(rep.scope_notice, /NOT a target-host/)
  assert.equal(rep.dataset.invariants_ok, true)
  for (const s of ['backup_plain', 'backup_encrypted', 'restore_drill_plain', 'restore_drill_encrypted', 'explain_audit', 'bench_api']) assert.equal(rep.steps[s].ok, true, s)
  assert.equal(rep.steps.backup_plain.encrypted, false)
  assert.equal(rep.steps.backup_encrypted.encrypted, true)
  assert.ok(rep.steps.restore_drill_plain.probes.every((p) => p.match) && rep.steps.restore_drill_encrypted.probes.every((p) => p.match))
  assert.equal(rep.steps.restore_drill_plain.probes.find((p) => p.name === 'purchase_orders').expected, rep.dataset.table_counts.purchase_orders)
  assert.equal(rep.steps.bench_api.totals.errors, 0)
  assert.equal(rep.steps.bench_api.endpoints.length, 10)
  assert.equal(rep.steps.explain_audit.violations, 0)
  assert.match(rep.source.git_head, /^[0-9a-f]{40}$/)
  assert.equal(typeof rep.source.git_dirty, 'boolean')
  assert.match(rep.source.sqlite_version, /^3\./)
  assert.ok(rep.bench_dataset.table_counts.inventory_transactions >= rep.dataset.table_counts.inventory_transactions, 'bench copy composition is recorded separately')
  assert.match(rep.bench_dataset.note, /demo-seed overlay/)
  // 秘密不进报告
  assert.doesNotMatch(readFileSync(out, 'utf8'), /Synthetic-Pass|GML_BACKUP_KEY/)
  assert.equal(existsSync(path.join(work, 'w')), false, 'working dir removed when --out given without --keep')
})
