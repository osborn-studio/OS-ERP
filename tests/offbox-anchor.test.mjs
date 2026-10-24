/**
 * ============================================================================
 * 文件标识：tests/offbox-anchor.test.mjs ｜ AD5 离机锚点（ADR-0055）：签名锚点文件、本地/ssh 目的地、日志与审计链的后代校验
 * ============================================================================
 * 【职责】证明 `scripts/offbox-anchor.mjs` 写出的 `anchor-<stamp>.json` 带 Ed25519 签名并覆盖透明日志尾与各库审计链尾；
 *   `audit-verify-chain --offbox` 与 `verify-release --log --offbox` 在改文件、换钥、去签名、尾部截断、整链重算、整份日志替换时失败；
 *   ssh 目的地只接受 `ssh://<既有别名>/<安全绝对路径>`，且只经替身 `OS_ERP_SSH` / `OS_ERP_SCP`（本测试从不连接真实主机）。
 *   全部在系统临时目录里建库、建钥；不监听端口，不碰仓库 data/。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runMigrations } from '../server/db/migrations/runner.js'
import { insertAuditRow, GENESIS } from '../server/lib/audit-trail.js'
import { GENESIS_PREV, entryLine } from '../scripts/lib/evidence-log.mjs'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SCHEMA = readFileSync(path.join(ROOT, 'server/db/schema.sql'), 'utf8')
const PATH = process.env.PATH
const ANCHOR = 'scripts/offbox-anchor.mjs'
const VERIFY_CHAIN = 'scripts/audit-verify-chain.mjs'
const VERIFY_RELEASE = 'scripts/verify-release.mjs'
const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex')

function tmp(t, prefix = 'os-ad5-') {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
const run = (script, args, env = {}) => spawnSync(process.execPath, [script, ...args], { cwd: ROOT, env: { PATH, GML_RUNTIME_MODE: 'test', ...env }, encoding: 'utf8', timeout: 120000 })

function mkDb(dir, file = 'gml_cosmetic.db') {
  const db = new Database(path.join(dir, file))
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  runMigrations(db, { mode: 'test' })
  return db
}
const fill = (db, n, start = 0) => db.transaction(() => { for (let i = start; i < start + n; i++) insertAuditRow(db, { userId: 1, userName: 'u', action: 'CREATE', module: 'sales', entity: 'order', entityId: i, detail: { n: i }, ip: '127.0.0.1' }) })()
function attackerRewrite(db, fromId, mutate) {
  const spec = (r, prev) => sha(JSON.stringify([r.id, r.created_at, r.user_id, r.action, r.entity, r.entity_id, r.detail, prev].map((v) => (v === null || v === undefined ? null : String(v)))))
  db.transaction(() => {
    const rows = db.prepare('SELECT * FROM audit_logs WHERE id >= ? ORDER BY id').all(fromId)
    let prev = fromId === 1 ? GENESIS : db.prepare('SELECT row_hash FROM audit_logs WHERE id=?').get(fromId - 1).row_hash
    for (const r of rows) {
      if (r.id === fromId) mutate(r)
      const h = spec(r, prev)
      db.prepare('UPDATE audit_logs SET detail=?, prev_hash=?, row_hash=? WHERE id=?').run(r.detail, prev, h, r.id)
      prev = h
    }
  })()
}

/** 合法透明日志 n 行（与 evidence-log.mjs 同一规范化与链接）。 */
function logText(n, { salt = '' } = {}) {
  let prev = GENESIS_PREV
  let out = ''
  for (let i = 0; i < n; i++) {
    const e = { schema: 1, name: `RC-1.0.${i}-abcdef${salt || '1'}`, evidence_sha256: sha(`ev${i}${salt}`), signature: null, built_by: 'local', timestamp: `2026-10-2${i % 9}T00:00:00.000Z`, prev }
    const line = entryLine(e)
    out += line + '\n'
    prev = sha(line)
  }
  return out
}
function keys(t) {
  const dir = path.join(tmp(t, 'os-ad5-keys-'), 'keys')
  const r = run('scripts/release-keygen.mjs', ['--out', dir])
  assert.equal(r.status, 0, r.stderr)
  return { priv: path.join(dir, 'release-sign.key.pem'), pub: path.join(dir, 'release-sign.pub.pem') }
}
/** 最小「已发行包」夹具：verify-release 以脚本所在目录为包根并要求 MANIFEST.json 覆盖包内每个文件。 */
function fixturePackage(t) {
  const pkg = tmp(t, 'os-ad5-pkg-')
  const put = (rel, content) => { mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); writeFileSync(path.join(pkg, rel), content) }
  for (const f of ['scripts/verify-release.mjs', ...readdirSync(path.join(ROOT, 'scripts/lib')).filter((x) => /^(evidence-sign|evidence-log|fs-fault|safe-path|tests-tree|offbox-anchor)\.mjs$/.test(x)).map((x) => `scripts/lib/${x}`)]) put(f, readFileSync(path.join(ROOT, f)))
  put('THIRD_PARTY_NOTICES.md', 'notices\n'); put('CHANGELOG.md', '<!-- generated -->\n')
  put('release/sbom.cdx.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'x', version: '1', 'bom-ref': 'x@1' }] }))
  const files = {}
  const walk = (d, pre = '') => { for (const e of readdirSync(d, { withFileTypes: true })) { const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), rel); else files[rel] = sha256File(path.join(d, e.name)) } }
  walk(pkg)
  put('MANIFEST.json', JSON.stringify({ version: '0.0.0', baseCommit: 'a'.repeat(40), files }))
  return pkg
}
const sha256File = (f) => createHash('sha256').update(readFileSync(f)).digest('hex')

function world(t, { logLines = 3 } = {}) {
  const dir = tmp(t)
  const data = path.join(dir, 'data')
  const dest = path.join(dir, 'dest')
  mkdirSync(data); mkdirSync(dest)
  const db = mkDb(data)
  fill(db, 6)
  const log = path.join(dir, 'EVIDENCE-LOG.jsonl')
  writeFileSync(log, logText(logLines))
  const k = keys(t)
  const anchor = (extra = [], env = {}) => run(ANCHOR, ['--data-dir', data, '--dest', dest, '--log', log, '--key', k.priv, ...extra], env)
  const files = () => readdirSync(dest).filter((f) => /^anchor-.*\.json$/.test(f))
  const first = () => path.join(dest, files()[0])
  const chain = (file, extra = []) => run(VERIFY_CHAIN, ['--data-dir', data, '--offbox', file, '--pubkey', k.pub, '--json', ...extra])
  const pkg = fixturePackage(t)
  const rel = (file, extra = []) => run(path.join(pkg, VERIFY_RELEASE), [`--log=${log}`, '--offbox', file, '--pubkey', k.pub, ...extra])
  return { dir, data, dest, db, log, k, pkg, anchor, files, first, chain, rel }
}

test('anchor: writes a signed anchor-<stamp>.json with log tail, per-industry chain tip and anchors digest', (t) => {
  const w = world(t)
  const r = w.anchor()
  assert.equal(r.status, 0, r.stderr)
  assert.equal(w.files().length, 1)
  assert.match(w.files()[0], /^anchor-\d{8}T\d{9}Z\.json$/)
  const doc = JSON.parse(readFileSync(w.first(), 'utf8'))
  const a = doc.anchor
  assert.equal(a.format, 'os-erp-offbox-anchor/1')
  assert.equal(a.log.present, true)
  assert.equal(a.log.lines, 3)
  const lines = readFileSync(w.log, 'utf8').trimEnd().split('\n')
  assert.equal(a.log.tail_hash, sha(lines[2]))
  const c = a.audit.cosmetic
  const tip = w.db.prepare('SELECT id, row_hash FROM audit_logs ORDER BY id DESC LIMIT 1').get()
  assert.deepEqual([c.status, c.rows, c.last_id, c.tip_hash], ['chain', 6, tip.id, tip.row_hash])
  assert.match(c.anchors_digest, /^[0-9a-f]{64}$/)
  assert.equal(a.audit.food.status, 'absent')
  assert.equal(a.signature.algorithm, 'ed25519')
  assert.match(doc.sig, /^[A-Za-z0-9+/]{86}==$/)
  assert.equal(readdirSync(w.dest).filter((f) => f.includes('tmp')).length, 0, 'no temp leftovers')
  assert.equal(w.chain(w.first()).status, 0)
  const rel = w.rel(w.first())
  assert.equal(rel.status, 0, rel.stdout + rel.stderr)
  w.db.close()
})

test('anchor: second run never overwrites the first (write-once) and the chain advancing still verifies the older anchor', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  const old = w.first()
  const before = readFileSync(old)
  fill(w.db, 4, 100)
  writeFileSync(w.log, readFileSync(w.log, 'utf8') + logText(5).split('\n').slice(3, 5).join('\n') + '\n')
  assert.equal(w.anchor().status, 0)
  assert.equal(w.files().length, 2)
  assert.deepEqual(readFileSync(old), before)
  assert.equal(w.chain(old).status, 0, 'older anchor still verifies after the chain advanced')
  assert.equal(w.rel(old).status, 0, 'older anchor still verifies after the log grew')
  const newest = path.join(w.dest, w.files().sort().at(-1))
  const j = JSON.parse(w.chain(newest).stdout)
  assert.equal(j.industries.cosmetic.offbox.status, 'ok')
  w.db.close()
})

test('signature: edited body, wrong key, stripped or malformed signature all fail on both verifiers', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  const doc = JSON.parse(readFileSync(w.first(), 'utf8'))
  const bad = (name, mutate) => {
    const d = structuredClone(doc); mutate(d)
    const f = path.join(w.dir, `${name}.json`); writeFileSync(f, JSON.stringify(d))
    assert.equal(w.chain(f).status, 1, `${name} fails audit-verify-chain`)
    assert.equal(w.rel(f).status, 1, `${name} fails verify-release`)
  }
  bad('tip', (d) => { d.anchor.audit.cosmetic.tip_hash = '0'.repeat(64) })
  bad('lines', (d) => { d.anchor.log.lines = 1 })
  bad('nosig', (d) => { delete d.sig })
  bad('nullmeta', (d) => { d.anchor.signature = null })
  bad('badsig', (d) => { d.sig = d.sig.slice(0, 80) + 'AAAAAA==' })
  bad('extra', (d) => { d.extra = 1 })
  bad('format', (d) => { d.anchor.format = 'os-erp-backup-audit-manifest/1' })
  const other = keys(t)
  assert.equal(run(VERIFY_CHAIN, ['--data-dir', w.data, '--offbox', w.first(), '--pubkey', other.pub, '--json']).status, 1)
  assert.equal(run(path.join(w.pkg, VERIFY_RELEASE), [`--log=${w.log}`, '--offbox', w.first(), '--pubkey', other.pub]).status, 1)
  const garbage = path.join(w.dir, 'garbage.json'); writeFileSync(garbage, 'not json')
  assert.equal(w.chain(garbage).status, 1)
  assert.equal(w.chain(path.join(w.dir, 'missing.json')).status, 1)
  w.db.close()
})

test('usage: --offbox needs --pubkey; verify-release also needs --log; a private key is refused as pubkey', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  assert.notEqual(run(VERIFY_CHAIN, ['--data-dir', w.data, '--offbox', w.first()]).status, 0)
  assert.notEqual(run(VERIFY_CHAIN, ['--data-dir', w.data, '--pubkey', w.k.pub]).status, 0)
  const V = path.join(w.pkg, VERIFY_RELEASE)
  assert.notEqual(run(V, ['--offbox', w.first(), '--pubkey', w.k.pub]).status, 0)
  assert.notEqual(run(V, [`--log=${w.log}`, '--offbox', w.first()]).status, 0)
  assert.equal(run(V, [`--log=${w.log}`, '--offbox', w.first(), '--pubkey', w.k.pub]).status, 0, 'fixture package itself verifies')
  assert.equal(run(VERIFY_CHAIN, ['--data-dir', w.data, '--offbox', w.first(), '--pubkey', w.k.priv]).status, 1)
  w.db.close()
})

test('audit descent: advanced ok; whole-chain recompute (rewrite) and tail truncation (behind) fail', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  const anchorFile = w.first()
  attackerRewrite(w.db, 3, (r) => { r.detail = '{"forged":true}' })
  assert.equal(run(VERIFY_CHAIN, ['--data-dir', w.data]).status, 0, 'plain verify is fooled by a recompute')
  const r = w.chain(anchorFile)
  assert.equal(r.status, 1)
  const o = JSON.parse(r.stdout).industries.cosmetic.offbox
  assert.deepEqual([o.status, o.kind], ['rewrite', 'tip-row-differs'])
  w.db.prepare('DELETE FROM audit_logs WHERE id > 2').run()
  const r2 = JSON.parse(w.chain(anchorFile).stdout).industries.cosmetic.offbox
  assert.deepEqual([r2.status, r2.kind], ['rewrite', 'behind'])
  w.db.close()
})

test('audit descent: a forged bridge anchor inside the anchored range cannot launder an edited past row (Codex AD5-H1)', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  const anchorFile = w.first()
  const spec = (r, prev) => sha(JSON.stringify([r.id, r.created_at, r.user_id, r.action, r.entity, r.entity_id, r.detail, prev].map((v) => (v === null || v === undefined ? null : String(v)))))
  const r1 = w.db.prepare('SELECT * FROM audit_logs WHERE id=1').get()
  const r2 = w.db.prepare('SELECT * FROM audit_logs WHERE id=2').get()
  const edited = { ...r1, detail: '{"forged":true}' }
  const newHash = spec(edited, GENESIS)
  w.db.prepare('UPDATE audit_logs SET detail=?, row_hash=? WHERE id=1').run(edited.detail, newHash)
  w.db.prepare("INSERT INTO audit_chain_anchors (kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason) VALUES ('retention', 2, ?, 1, ?, 'forged bridge')").run(r2.prev_hash, newHash)
  assert.equal(run(VERIFY_CHAIN, ['--data-dir', w.data]).status, 0, 'the live chain verifies on its own: the forged anchor bridges the edit')
  const r = w.chain(anchorFile)
  assert.equal(r.status, 1, r.stdout)
  const o = JSON.parse(r.stdout).industries.cosmetic.offbox
  assert.deepEqual([o.status, o.kind], ['rewrite', 'anchor-without-intent'], 'AE5: a bridge anchor needs a matching operation intent')
  assert.equal(o.anchors_added.length, 1)
  const accepted = w.chain(anchorFile, ['--accept-new-anchors'])
  assert.equal(accepted.status, 1, '--accept-new-anchors no longer accepts anchors that have no intent')
  assert.equal(JSON.parse(accepted.stdout).industries.cosmetic.offbox.kind, 'anchor-without-intent')
  w.db.close()
})

test('audit descent: anchored industry whose database disappeared fails; deleted anchor rows are reported', (t) => {
  const w = world(t)
  assert.equal(w.anchor().status, 0)
  w.db.close()
  rmSync(path.join(w.data, 'gml_cosmetic.db'))
  rmSync(path.join(w.data, 'gml_cosmetic.db-wal'), { force: true })
  rmSync(path.join(w.data, 'gml_cosmetic.db-shm'), { force: true })
  const r = w.chain(w.first())
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).industries.cosmetic.status, 'absent')
})

test('log descent: growth ok; truncation, whole-file replacement by another valid chain, edits and a missing log all fail', (t) => {
  const w = world(t, { logLines: 4 })
  assert.equal(w.anchor().status, 0)
  const anchorFile = w.first()
  const original = readFileSync(w.log, 'utf8')
  assert.equal(w.rel(anchorFile).status, 0)
  writeFileSync(w.log, original.split('\n').slice(0, 3).join('\n') + '\n')
  let r = w.rel(anchorFile)
  assert.equal(r.status, 1); assert.match(r.stderr, /anchor|offbox/i)
  writeFileSync(w.log, logText(4, { salt: 'x' }))
  assert.equal(w.rel(anchorFile).status, 1, 'a different but self-consistent chain with the same length is not the anchored one')
  writeFileSync(w.log, logText(9, { salt: 'x' }))
  assert.equal(w.rel(anchorFile).status, 1, 'longer replacement chain still fails')
  writeFileSync(w.log, original.replace('RC-1.0.1', 'RC-1.0.7'))
  assert.equal(w.rel(anchorFile).status, 1, 'edited line breaks the chain')
  rmSync(w.log)
  assert.equal(w.rel(anchorFile).status, 1, 'missing log with an anchored tail')
  w.db.close()
})

test('anchor refuses: broken audit chain, invalid log, relative / missing dest, dest inside the data dir, weak or in-repo key', (t) => {
  const w = world(t)
  const before = w.db.prepare('SELECT detail FROM audit_logs WHERE id=3').get()
  w.db.prepare("UPDATE audit_logs SET detail='{\"x\":1}' WHERE id=3").run()
  let r = w.anchor()
  assert.equal(r.status, 1); assert.equal(w.files().length, 0)
  w.db.prepare('UPDATE audit_logs SET detail=? WHERE id=3').run(before.detail)
  writeFileSync(w.log, readFileSync(w.log, 'utf8').replace('RC-1.0.1', 'RC-1.0.8'))
  r = w.anchor(); assert.equal(r.status, 1); assert.equal(w.files().length, 0)
  writeFileSync(w.log, logText(3))
  const call = (dest, key = w.k.priv) => run(ANCHOR, ['--data-dir', w.data, '--dest', dest, '--log', w.log, '--key', key])
  assert.notEqual(call('relative/dest').status, 0)
  assert.notEqual(call(path.join(w.dir, 'nope')).status, 0)
  assert.equal(existsSync(path.join(w.dir, 'nope')), false, 'never creates a missing destination (an unmounted disk would silently become local)')
  const inside = path.join(w.data, 'anchors'); mkdirSync(inside)
  assert.notEqual(call(inside).status, 0)
  const loose = path.join(path.dirname(w.k.priv), 'loose.pem'); copyFileSync(w.k.priv, loose); chmodSync(loose, 0o644)
  assert.notEqual(call(w.dest, loose).status, 0)
  assert.notEqual(call(w.dest, path.join(ROOT, 'package.json')).status, 0)
  assert.notEqual(run(ANCHOR, ['--data-dir', w.data, '--dest', w.dest, '--log', w.log]).status, 0, '--key is required')
  assert.notEqual(run(ANCHOR, ['--dest', w.dest, '--key', w.k.priv]).status, 0, '--data-dir is required')
  assert.notEqual(run(ANCHOR, ['--data-dir', w.data, '--dest', w.dest, '--key', w.k.priv, '--bogus', '1']).status, 0)
  assert.equal(w.files().length, 0)
  w.db.close()
})

test('anchor without --log uses the default repository log path and still writes a verifiable signed anchor', (t) => {
  const w = world(t)
  const r = run(ANCHOR, ['--data-dir', w.data, '--dest', w.dest, '--key', w.k.priv])
  // 默认日志路径是仓库内的 docs/release/EVIDENCE-LOG.jsonl（可能存在也可能不存在）；两种情况都要写出有效的签名锚点
  assert.equal(r.status, 0, r.stderr)
  assert.equal(w.chain(w.first()).status, 0)
  w.db.close()
})

// ---- ssh 目的地：只用替身 ssh/scp；远端目录由替身映射到临时目录 ----
function fakeRemote(t) {
  const dir = tmp(t, 'os-ad5-remote-')
  const remote = path.join(dir, 'remote'); mkdirSync(path.join(remote, 'backups', 'anchors'), { recursive: true })
  const calls = path.join(dir, 'calls.jsonl')
  const map = `const R=process.env.FAKE_REMOTE;const m=p=>R+p;const fs=require('fs');const log=a=>fs.appendFileSync(process.env.FAKE_CALLS,JSON.stringify(a)+'\\n');`
  writeFileSync(path.join(dir, 'ssh.cjs'), `#!${process.execPath}
${map}
const a=process.argv.slice(2);log({tool:'ssh',argv:a});
const i=a.indexOf('--');const alias=a[i+1];const cmd=a.slice(i+2).join(' ');
if(alias!=='backup-box'){console.error('ssh: Could not resolve hostname '+alias);process.exit(255)}
let x;
if((x=/^test -d '([^']+)'$/.exec(cmd))){process.exit(fs.existsSync(m(x[1]))&&fs.statSync(m(x[1])).isDirectory()?0:1)}
if((x=/^test ! -e '([^']+)' && mv -- '([^']+)' '([^']+)'$/.exec(cmd))&&x[1]===x[3]){if(fs.existsSync(m(x[1])))process.exit(1);fs.renameSync(m(x[2]),m(x[3]));process.exit(0)}
if((x=/^cat -- '([^']+)'$/.exec(cmd))){process.stdout.write(fs.readFileSync(m(x[1])));process.exit(0)}
if((x=/^rm -f -- '([^']+)'$/.exec(cmd))){fs.rmSync(m(x[1]),{force:true});process.exit(0)}
console.error('fake ssh: unexpected command '+cmd);process.exit(97)
`)
  writeFileSync(path.join(dir, 'scp.cjs'), `#!${process.execPath}
${map}
const a=process.argv.slice(2);log({tool:'scp',argv:a});
const i=a.indexOf('--');const src=a[i+1];const dst=a[i+2];const x=/^backup-box:(\\/[^:]*)$/.exec(dst);
if(!x){console.error('scp: bad target '+dst);process.exit(1)}
fs.copyFileSync(src,m(x[1]));process.exit(0)
`)
  chmodSync(path.join(dir, 'ssh.cjs'), 0o755); chmodSync(path.join(dir, 'scp.cjs'), 0o755)
  const env = { OS_ERP_SSH: path.join(dir, 'ssh.cjs'), OS_ERP_SCP: path.join(dir, 'scp.cjs'), FAKE_REMOTE: remote, FAKE_CALLS: calls }
  const called = () => (existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  return { remote, env, called }
}

test('ssh destination: uploads through ssh/scp with an existing alias, write-once, read-back verified; the remote copy verifies', (t) => {
  const w = world(t)
  const f = fakeRemote(t)
  const r = run(ANCHOR, ['--data-dir', w.data, '--dest', 'ssh://backup-box/backups/anchors', '--log', w.log, '--key', w.k.priv], f.env)
  assert.equal(r.status, 0, r.stderr + r.stdout)
  const landed = readdirSync(path.join(f.remote, 'backups/anchors')).filter((x) => /^anchor-.*\.json$/.test(x))
  assert.equal(landed.length, 1, 'only the final file remains (no .tmp)')
  assert.equal(readdirSync(path.join(f.remote, 'backups/anchors')).length, 1)
  assert.equal(w.chain(path.join(f.remote, 'backups/anchors', landed[0])).status, 0)
  for (const c of f.called()) {
    assert.ok(c.argv.includes('--'), 'end-of-options marker before alias/path')
    assert.ok(!c.argv.some((x) => /^-F|ProxyCommand|StrictHostKeyChecking|IdentityFile|UserKnownHostsFile/.test(x)), 'never touches SSH config/auth options')
    assert.ok(c.argv.includes('BatchMode=yes'), 'never prompts for a password')
  }
  assert.deepEqual([...new Set(f.called().map((c) => c.tool))].sort(), ['scp', 'ssh'])
  w.db.close()
})

test('ssh destination: hostile aliases and paths are rejected before any ssh/scp is spawned', (t) => {
  const w = world(t)
  const f = fakeRemote(t)
  const bad = [
    'ssh://-oProxyCommand=touch%20x/backups', 'ssh://user@backup-box/backups', 'ssh://backup-box:2222/backups', 'ssh://backup box/backups',
    'ssh://backup-box;id/backups', 'ssh://backup-box/', 'ssh://backup-box', 'ssh://backup-box/backups;touch x', "ssh://backup-box/ba'ckups",
    'ssh://backup-box/backups$(id)', 'ssh://backup-box/backups/../etc', 'ssh://backup-box/back ups', 'ssh://backup-box/backups`id`',
    'ssh://backup-box/backups\nrm', 'ssh://backup-box/~root', 'ssh://backup-box//backups', 'ssh://backup-box/backups/-rf', 'ssh://backup-box/ba*', 'ssh://[::1]/backups', 'ssh:///backups', 'sftp://backup-box/backups', 'backup-box:/backups'
  ]
  for (const dest of bad) {
    const r = run(ANCHOR, ['--data-dir', w.data, '--dest', dest, '--log', w.log, '--key', w.k.priv], f.env)
    assert.notEqual(r.status, 0, `rejected: ${JSON.stringify(dest)}`)
  }
  assert.deepEqual(f.called(), [], 'no process was spawned for any hostile destination')
  assert.deepEqual(readdirSync(path.join(f.remote, 'backups/anchors')), [])
  w.db.close()
})

test('ssh destination: unknown alias, missing remote directory, a failing scp, and OS_ERP_SSH without OS_ERP_SCP all fail without a partial anchor', (t) => {
  const w = world(t)
  const f = fakeRemote(t)
  const go = (dest, env = f.env) => run(ANCHOR, ['--data-dir', w.data, '--dest', dest, '--log', w.log, '--key', w.k.priv], env)
  assert.notEqual(go('ssh://other-alias/backups/anchors').status, 0)
  assert.notEqual(go('ssh://backup-box/backups/missing').status, 0)
  const { OS_ERP_SCP, ...sshOnly } = f.env
  const before = f.called().length
  assert.notEqual(go('ssh://backup-box/backups/anchors', sshOnly).status, 0, 'a real scp is never reached through a fake ssh')
  assert.equal(f.called().length, before, 'refused before spawning anything')
  const broken = path.join(path.dirname(f.env.OS_ERP_SCP), 'scp-fail.cjs')
  writeFileSync(broken, `#!${process.execPath}\nprocess.exit(1)\n`); chmodSync(broken, 0o755)
  assert.notEqual(go('ssh://backup-box/backups/anchors', { ...f.env, OS_ERP_SCP: broken }).status, 0)
  assert.deepEqual(readdirSync(path.join(f.remote, 'backups/anchors')), [])
  w.db.close()
})

test('AF5 docs: the daily procedure shows the full command set (anchor, intent key custody, verify with --require-signed-intents, against-backup) and no longer advertises the removed flag as a way to accept anchors', () => {
  const doc = readFileSync(new URL('../docs/operations/audit-integrity.md', import.meta.url), 'utf8')
  const daily = doc.slice(doc.indexOf('## 8. 每日锚点'), doc.indexOf('### 8b.'))
  for (const needle of ['release-keygen.mjs --out', '--purpose anchor-intent', 'GML_ANCHOR_INTENT_KEY', 'scripts/offbox-anchor.mjs', '--require-signed-intents', '--intent-pubkey', '--against-backup']) {
    assert.ok(daily.includes(needle) || doc.includes(needle), `audit-integrity.md mentions ${needle}`)
  }
  assert.match(daily, /--offbox [^\n]*--require-signed-intents/, 'the daily verify command carries --require-signed-intents')
  assert.match(daily, /--against-backup [^\n]*--require-signed-intents[^\n]*--intent-pubkey|--against-backup[^\n]*--intent-pubkey[^\n]*--require-signed-intents/, 'and so does the backup comparison')
  const b = doc.slice(doc.indexOf('### 8b.'))
  assert.doesNotMatch(b, /只接受“意图齐全，但印证它的审计行已被后来的归档搬出库”/)
  assert.match(b, /--accept-new-anchors[^\n]*(无效|不再)/)
  assert.doesNotMatch(b, /仍按 §6 列出/, 'the --against-backup limitation line is gone')
  assert.match(b, /--purpose anchor-intent/)
})
