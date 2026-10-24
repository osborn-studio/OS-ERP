/**
 * ============================================================================
 * 文件标识：tests/release-signing.test.mjs ｜ 发行候选证据签名（AB4，ADR-0047）：规范化、Ed25519 签名/验签、密钥生成、降级与篡改拒绝
 * ============================================================================
 * 【职责】证明 `scripts/lib/evidence-sign.mjs` 的规范化 JSON（键排序、无空白、拒绝非有限数/undefined）与签名验证；
 *   `scripts/release-keygen.mjs` 只在仓库之外的空目录里生成 0600 私钥；`release-candidate` 在 GML_RELEASE_SIGN_KEY 设置时产出
 *   EVIDENCE.sig，未设置时 `signature: null` 仍可构建；`verify-release --evidence --pubkey` 对篡改、换钥、去签名（降级）、
 *   损坏签名都失败。密钥一律生成在临时目录，绝不写入仓库。
 *   AC6（ADR-0052）：scripts/lib/evidence-log.mjs 哈希链日志（改/删/重排/重复/空行/非规范行均失败）、`release-candidate --log` 追加、
 *   `verify-release --log` 校验链与包含关系、未签名候选的醒目警告与 `--require-signature`、hosted-ci 记 signature null。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { unzipSync } from 'fflate'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const PATH = process.env.PATH
const lib = () => import(pathToFileURL(path.join(ROOT, 'scripts/lib/evidence-sign.mjs')).href)

function tempDir(t, prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function put(dir, rel, content) {
  const file = path.join(dir, rel)
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, content)
}
const keygen = (out, extra = []) => spawnSync(process.execPath, ['scripts/release-keygen.mjs', '--out', out, ...extra], { cwd: ROOT, env: { PATH }, encoding: 'utf8' })
function newKeys(t) {
  const dir = path.join(tempDir(t, 'os-erp-sign-keys-'), 'keys')
  const r = keygen(dir)
  assert.equal(r.status, 0, r.stderr)
  return { dir, priv: path.join(dir, 'release-sign.key.pem'), pub: path.join(dir, 'release-sign.pub.pem') }
}

test('canonicalize sorts keys at every depth, drops whitespace, keeps array order, and rejects non-JSON values', async () => {
  const { canonicalize } = await lib()
  assert.equal(canonicalize({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: 'x y' } }), '{"a":{"c":"x y","d":[3,{"y":2,"z":1}]},"b":1}')
  assert.equal(canonicalize({ a: null, b: true }), '{"a":null,"b":true}')
  assert.equal(canonicalize('é "'), JSON.stringify('é "'))
  for (const bad of [NaN, Infinity, undefined, () => 1, { a: undefined }, { a: 1n }, [undefined], new Date(0), Object.create({ inherited: 1 })]) {
    assert.throws(() => canonicalize(bad), /canonical/i)
  }
  // 同一个对象，不同键序/缩进的文本 → 同一规范化字节
  const a = JSON.parse('{ "x": 1,\n "y": {"b":2,"a":1} }')
  const b = JSON.parse('{"y":{"a":1,"b":2},"x":1}')
  assert.equal(canonicalize(a), canonicalize(b))
})

test('keygen writes a 0600 Ed25519 pair into a fresh directory and refuses repo paths, non-empty dirs and bad usage', (t) => {
  const { dir, priv, pub } = newKeys(t)
  assert.deepEqual(readdirSync(dir).sort(), ['release-sign.key.pem', 'release-sign.pub.pem'])
  assert.equal(statSync(priv).mode & 0o777, 0o600)
  assert.match(readFileSync(priv, 'utf8'), /BEGIN PRIVATE KEY/)
  assert.doesNotMatch(readFileSync(pub, 'utf8'), /PRIVATE/)
  assert.equal(statSync(dir).mode & 0o077, 0, 'directory is not group/world accessible')
  // 非空目录
  const again = keygen(dir)
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /not empty/i)
  // 仓库内（含仓库内不存在的子目录、经符号链接绕过）
  for (const bad of [path.join(ROOT, 'tmp-keys-should-not-exist'), path.join(ROOT, 'docs', 'k')]) {
    const r = keygen(bad)
    assert.notEqual(r.status, 0)
    assert.match(r.stderr, /repository|git/i)
    assert.ok(!existsSync(bad), 'nothing created inside the repo')
  }
  const alias = path.join(tempDir(t, 'os-erp-sign-alias-'), 'alias')
  symlinkSync(ROOT, alias, 'dir')
  const viaLink = keygen(path.join(alias, 'k2'))
  assert.notEqual(viaLink.status, 0)
  assert.ok(!existsSync(path.join(ROOT, 'k2')))
  // 任意 git 工作树（不只是本仓库）
  const other = tempDir(t, 'os-erp-sign-git-')
  assert.equal(spawnSync('git', ['init', '-q'], { cwd: other }).status, 0)
  const inOther = keygen(path.join(other, 'keys'))
  assert.notEqual(inOther.status, 0)
  assert.ok(!existsSync(path.join(other, 'keys')))
  // 用法
  assert.notEqual(spawnSync(process.execPath, ['scripts/release-keygen.mjs'], { cwd: ROOT, encoding: 'utf8' }).status, 0)
  assert.notEqual(keygen('relative/dir').status, 0)
  assert.notEqual(keygen(path.join(tempDir(t, 'os-erp-sign-x-'), 'k'), ['--bogus']).status, 0)
})

test('sign/verify round-trip; any byte change, other key, malformed signature or downgrade is rejected', async (t) => {
  const { signEvidence, verifyEvidenceSignature, publicKeyId, loadSigningKey, loadPublicKey } = await lib()
  const k1 = newKeys(t); const k2 = newKeys(t)
  const priv = loadSigningKey(k1.priv)
  const pub = loadPublicKey(k1.pub)
  const base = { schema: 1, version: '1.0.0', b: [1, 2], a: { z: 1 } }
  const { evidence, sigBase64 } = signEvidence(base, priv)
  assert.equal(evidence.signature.algorithm, 'ed25519')
  assert.equal(evidence.signature.key_id, publicKeyId(pub))
  assert.equal(Buffer.from(sigBase64, 'base64').length, 64)
  assert.equal(verifyEvidenceSignature(evidence, sigBase64, pub).ok, true)
  // 键序/缩进不同的等价证据同样通过（签的是规范化字节）
  const reordered = Object.fromEntries(Object.entries(evidence).reverse())
  assert.equal(verifyEvidenceSignature(reordered, sigBase64, pub).ok, true)
  // 篡改任何字段
  assert.equal(verifyEvidenceSignature({ ...evidence, version: '1.0.1' }, sigBase64, pub).ok, false)
  assert.equal(verifyEvidenceSignature({ ...evidence, extra: 1 }, sigBase64, pub).ok, false)
  // 换钥
  const other = loadPublicKey(k2.pub)
  const wrongKey = verifyEvidenceSignature(evidence, sigBase64, other)
  assert.equal(wrongKey.ok, false)
  assert.match(wrongKey.reason, /key_id|key/i)
  // 签名格式
  for (const bad of ['', 'not base64!!', Buffer.alloc(63).toString('base64'), Buffer.alloc(64).toString('base64'), sigBase64 + 'AAAA']) {
    assert.equal(verifyEvidenceSignature(evidence, bad, pub).ok, false, bad)
  }
  // 降级：证据声称未签名 / 去掉 signature 元数据，不能用旧签名通过
  assert.equal(verifyEvidenceSignature({ ...evidence, signature: null }, sigBase64, pub).ok, false)
  const noSig = { ...evidence }; delete noSig.signature
  assert.equal(verifyEvidenceSignature(noSig, sigBase64, pub).ok, false)
  // 改 key_id 元数据（指向另一把钥）也不通过
  assert.equal(verifyEvidenceSignature({ ...evidence, signature: { ...evidence.signature, key_id: publicKeyId(other) } }, sigBase64, other).ok, false)
  // 非 Ed25519 密钥被拒绝
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const rsaFile = path.join(tempDir(t, 'os-erp-sign-rsa-'), 'rsa.pem')
  writeFileSync(rsaFile, rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  assert.throws(() => loadSigningKey(rsaFile), /ed25519/i)
  // 私钥不能当公钥用；私钥文件权限过宽被拒
  assert.throws(() => loadPublicKey(k1.priv), /private/i)
  chmodSync(k1.priv, 0o644)
  assert.throws(() => loadSigningKey(k1.priv), /permission|0600|readable/i)
  assert.throws(() => loadSigningKey(path.join(k1.dir, 'missing.pem')), /cannot read|ENOENT/i)
  // 仓库内的私钥路径被拒
  assert.throws(() => loadSigningKey(path.join(ROOT, 'package.json')), /repository/i)
})

// ---- 端到端：真实候选构建（桩源码树）----
const git = (cwd, ...argv) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...argv], { cwd, encoding: 'utf8' })
function minimalSource(t) {
  const src = tempDir(t, 'os-erp-sign-src-')
  for (const name of ['server', 'scripts']) cpSync(path.join(ROOT, name), path.join(src, name), { recursive: true })
  for (const name of ['package.json', 'package-lock.json', 'THIRD_PARTY_NOTICES.md', 'LICENSE', 'CHANGELOG.md']) cpSync(path.join(ROOT, name), path.join(src, name))
  cpSync(path.join(ROOT, 'docs/implementation'), path.join(src, 'docs/implementation'), { recursive: true })
  put(src, 'src/App.tsx', '// stub\n')
  put(src, 'reusable/README.md', '# stub\n')
  put(src, 'docs/本地交付/README.md', '# stub\n')
  put(src, 'dist/index.html', '<!doctype html><html><head><title>stub</title><script type="module" src="/assets/app.js"></script></head><body></body></html>')
  put(src, 'dist/assets/app.js', 'export {}\n')
  for (const page of ['install', 'manual']) put(src, `public/docs/${page}.html`, `<html><body>${page} stub</body></html>`)
  for (const f of ['index.html', 'vite.config.ts', 'tsconfig.json', 'tailwind.config.js', 'postcss.config.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore']) put(src, f, '# stub\n')
  symlinkSync(path.join(ROOT, 'node_modules'), path.join(src, 'node_modules'), 'dir')
  put(src, '.gitignore', 'node_modules\nrelease/\ndist/\n')
  assert.equal(git(src, 'init', '-q').status, 0)
  assert.equal(git(src, 'add', '-A').status, 0)
  assert.equal(git(src, 'commit', '-q', '-m', 'stub').status, 0)
  return src
}
const candidate = (src, out, env = {}, extra = [], env2 = {}) => spawnSync(process.execPath, ['scripts/release-candidate.mjs', `--output=${out}`, '--skip-build', '--skip-docs', '--reuse-node-modules', ...extra], { cwd: src, env: { PATH, ...env, ...env2 }, encoding: 'utf8', timeout: 280000 })

test('candidate signs EVIDENCE.json when GML_RELEASE_SIGN_KEY is set; verify-release --pubkey accepts it and rejects tamper, key swap and downgrade', { timeout: 590000 }, (t) => {
  const src = minimalSource(t)
  const keys = newKeys(t)
  const outRoot = tempDir(t, 'os-erp-sign-out-')
  const out = path.join(outRoot, 'release')
  const r = candidate(src, out, { GML_RELEASE_SIGN_KEY: keys.priv })
  assert.equal(r.status, 0, r.stderr.slice(-3000) + r.stdout.slice(-2000))
  const dir = path.join(out, readdirSync(out).find(f => f.endsWith('.evidence')))
  const evFile = path.join(dir, 'EVIDENCE.json')
  const sigFile = path.join(dir, 'EVIDENCE.sig')
  assert.ok(existsSync(sigFile), 'EVIDENCE.sig written next to EVIDENCE.json')
  const ev = JSON.parse(readFileSync(evFile, 'utf8'))
  assert.equal(ev.signature.algorithm, 'ed25519')
  assert.equal(ev.signature.sig_file, 'EVIDENCE.sig')
  assert.match(ev.signature.key_id, /^[0-9a-f]{64}$/)
  assert.doesNotMatch(readFileSync(evFile, 'utf8') + readFileSync(sigFile, 'utf8'), /PRIVATE/)
  // 私钥内容不进候选目录与包
  const zip = path.join(out, readdirSync(out).find(f => f.endsWith('.zip')))
  const privPem = readFileSync(keys.priv, 'utf8').trim()
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) assert.ok(!Buffer.from(bytes).toString('latin1').includes(privPem.split('\n')[1]), n)

  const pkg = tempDir(t, 'os-erp-sign-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const verify = (file, ...extra) => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${file}`, ...extra], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  const ok = verify(evFile, '--pubkey', keys.pub)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /signature verified/i)
  assert.equal(verify(evFile, `--pubkey=${keys.pub}`).status, 0, '--pubkey=<pem> form')
  // 不给公钥：通过但明说"未验签"
  const unchecked = verify(evFile)
  assert.equal(unchecked.status, 0)
  assert.match(unchecked.stdout + unchecked.stderr, /not verified/i)
  // 篡改（改一个字段、保留原 sig）
  const copy = (name, text, sig = readFileSync(sigFile, 'utf8')) => { const d = path.join(outRoot, name); mkdirSync(d, { recursive: true }); writeFileSync(path.join(d, 'EVIDENCE.json'), text); if (sig !== null) writeFileSync(path.join(d, 'EVIDENCE.sig'), sig); return path.join(d, 'EVIDENCE.json') }
  const tampered = JSON.parse(readFileSync(evFile, 'utf8')); tampered.regression = { source: 'forged', result: 'passed', origin: 'operator-attested' }
  const t1 = verify(copy('tamper', JSON.stringify(tampered, null, 2)), '--pubkey', keys.pub)
  assert.notEqual(t1.status, 0); assert.match(t1.stderr, /signature/i)
  // 重新排版（缩进/键序不同）但内容不变：仍然通过 ⇒ 签的是规范化字节
  const reflowed = JSON.stringify(Object.fromEntries(Object.entries(ev).reverse()))
  assert.equal(verify(copy('reflow', reflowed), '--pubkey', keys.pub).status, 0)
  // 换钥
  const swapped = newKeys(t)
  const t2 = verify(evFile, '--pubkey', swapped.pub)
  assert.notEqual(t2.status, 0); assert.match(t2.stderr, /signature/i)
  // 去签名：缺 EVIDENCE.sig / 空 sig / 证据改成 signature:null
  const t3 = verify(copy('nosig', readFileSync(evFile, 'utf8'), null), '--pubkey', keys.pub)
  assert.notEqual(t3.status, 0); assert.match(t3.stderr, /EVIDENCE\.sig/)
  assert.notEqual(verify(copy('emptysig', readFileSync(evFile, 'utf8'), ''), '--pubkey', keys.pub).status, 0)
  const downgraded = { ...ev, signature: null }
  const t4 = verify(copy('downgrade', JSON.stringify(downgraded)), '--pubkey', keys.pub)
  assert.notEqual(t4.status, 0); assert.match(t4.stderr, /unsigned|signature/i)
  // 重复的 --pubkey 不猜测信任哪一把
  const dup = verify(evFile, `--pubkey=${swapped.pub}`, '--pubkey', keys.pub)
  assert.notEqual(dup.status, 0); assert.match(dup.stderr, /more than once/)
  // 私钥当作 --pubkey 被拒
  assert.notEqual(verify(evFile, '--pubkey', keys.priv).status, 0)
  // 缺失的公钥文件
  assert.notEqual(verify(evFile, '--pubkey', path.join(outRoot, 'nope.pem')).status, 0)
})

test('without GML_RELEASE_SIGN_KEY the candidate still builds with signature null and no EVIDENCE.sig; --pubkey then fails the unsigned evidence', { timeout: 590000 }, (t) => {
  const src = minimalSource(t)
  const keys = newKeys(t)
  const outRoot = tempDir(t, 'os-erp-sign-out2-')
  const out = path.join(outRoot, 'release')
  const r = candidate(src, out)
  assert.equal(r.status, 0, r.stderr.slice(-3000))
  const dir = path.join(out, readdirSync(out).find(f => f.endsWith('.evidence')))
  assert.equal(JSON.parse(readFileSync(path.join(dir, 'EVIDENCE.json'), 'utf8')).signature, null)
  assert.ok(!existsSync(path.join(dir, 'EVIDENCE.sig')))
  const zip = path.join(out, readdirSync(out).find(f => f.endsWith('.zip')))
  const pkg = tempDir(t, 'os-erp-sign-pkg2-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const v = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${path.join(dir, 'EVIDENCE.json')}`, '--pubkey', keys.pub], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(v.status, 0)
  assert.match(v.stderr, /unsigned/i)
  // --pubkey 没有 --evidence ⇒ 用法错误，不是静默通过
  const lone = spawnSync(process.execPath, ['scripts/verify-release.mjs', '--pubkey', keys.pub], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(lone.status, 0)
  assert.match(lone.stderr, /--evidence/)
})

test('a configured but unusable signing key aborts the build and writes no candidate (never a silent unsigned fallback)', { timeout: 290000 }, (t) => {
  const src = minimalSource(t)
  const keys = newKeys(t)
  const out = path.join(tempDir(t, 'os-erp-sign-out3-'), 'release')
  for (const [label, key] of [['missing', path.join(keys.dir, 'nope.pem')], ['public key', keys.pub], ['inside repo', path.join(src, 'package.json')]]) {
    const r = candidate(src, out, { GML_RELEASE_SIGN_KEY: key })
    assert.notEqual(r.status, 0, label)
    assert.match(r.stderr, /GML_RELEASE_SIGN_KEY|sign/i, label)
    assert.ok(!existsSync(out) || readdirSync(out).length === 0, `${label}: nothing written`)
  }
  chmodSync(keys.priv, 0o644)
  const wide = candidate(src, out, { GML_RELEASE_SIGN_KEY: keys.priv })
  assert.notEqual(wide.status, 0)
  assert.ok(!existsSync(out) || readdirSync(out).length === 0)
})

// ---- AC6（ADR-0052）：追加式证据透明日志 ----
const logLib = () => import(pathToFileURL(path.join(ROOT, 'scripts/lib/evidence-log.mjs')).href)
const sha256hex = s => createHash('sha256').update(s).digest('hex')
const fakeEvidence = (n) => ({ schema: 1, version: '1.0.0', n, signature: null })

test('evidence log: genesis prev, canonical lines, chain links by sha256 of the previous line', async (t) => {
  const { appendEntry, verifyLog, GENESIS_PREV, entryLine } = await logLib()
  const { canonicalize } = await lib()
  const file = path.join(tempDir(t, 'os-erp-log-'), 'docs', 'EVIDENCE-LOG.jsonl')
  assert.match(GENESIS_PREV, /^[0-9a-f]{64}$/)
  const e1 = appendEntry(file, { name: 'RC-1.0.0-aaaaaaa', evidence: fakeEvidence(1), sigText: null, builtBy: 'hosted-ci', timestamp: '2026-10-24T00:00:00.000Z' })
  assert.equal(e1.prev, GENESIS_PREV)
  assert.equal(e1.signature, null)
  assert.equal(e1.evidence_sha256, sha256hex(canonicalize(fakeEvidence(1))))
  const sig = Buffer.alloc(64, 7).toString('base64')
  const e2 = appendEntry(file, { name: 'RC-1.0.0-bbbbbbb', evidence: fakeEvidence(2), sigText: `${sig}\n`, builtBy: 'key-holder', timestamp: '2026-10-24T00:00:01.000Z' })
  assert.equal(e2.signature, sha256hex(sig))
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  assert.equal(lines.pop(), '', 'ends with exactly one newline')
  assert.equal(lines.length, 2)
  assert.equal(e2.prev, sha256hex(lines[0]))
  assert.equal(lines[0], entryLine(e1), 'line is the canonical JSON')
  const v = verifyLog(text)
  assert.equal(v.ok, true, v.reason)
  assert.equal(v.entries.length, 2)
  assert.equal(verifyLog('').ok, true, 'an empty log is a valid (empty) chain')
})

test('evidence log: edit, delete-middle, reorder, duplicate, blank line, missing newline and non-canonical lines break the chain', async (t) => {
  const { appendEntry, verifyLog, entryLine } = await logLib()
  const file = path.join(tempDir(t, 'os-erp-log2-'), 'L.jsonl')
  for (let i = 1; i <= 3; i++) appendEntry(file, { name: `RC-1.0.0-${String(i).repeat(7)}`, evidence: fakeEvidence(i), sigText: null, builtBy: 'hosted-ci', timestamp: `2026-10-24T00:00:0${i}.000Z` })
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n')
  const join = a => a.join('\n') + '\n'
  const bad = (label, text, re) => { const v = verifyLog(text); assert.equal(v.ok, false, label); if (re) assert.match(v.reason, re, label) }
  bad('edit first', join([lines[0].replace('hosted-ci', 'key-holder'), lines[1], lines[2]]), /line 1|canonical|prev/i)
  const e1 = JSON.parse(lines[0]); e1.built_by = 'key-holder'
  bad('edit first re-canonicalized', join([entryLine(e1), lines[1], lines[2]]), /line 2.*prev/i)
  bad('delete middle', join([lines[0], lines[2]]), /line 2.*prev/i)
  bad('reorder', join([lines[0], lines[2], lines[1]]), /prev/i)
  bad('duplicate line', join([lines[0], lines[1], lines[1]]), /prev|duplicate/i)
  bad('blank line', join([lines[0], '', lines[1]]), /blank|empty/i)
  bad('no trailing newline', lines.join('\n'), /newline/i)
  bad('CRLF', join(lines).replace(/\n/g, '\r\n'), /canonical|parse|CR/i)
  bad('pretty-printed line', join([JSON.stringify(JSON.parse(lines[0]), null, 1).replace(/\n/g, ' '), lines[1], lines[2]]), /canonical/i)
  bad('not json', join(['{nope', lines[1]]), /parse|JSON/i)
  bad('wrong genesis', join([lines[1], lines[2]]), /line 1.*prev|genesis/i)
  // 同名候选不能出现两次（即使链有效）
  const dup = JSON.parse(lines[1]); dup.name = JSON.parse(lines[0]).name
  const reLinked = { ...dup, prev: sha256hex(lines[0]) }
  bad('duplicate candidate name', join([lines[0], entryLine(reLinked)]), /duplicate.*name|name.*already/i)
  // 时间倒流
  const back = JSON.parse(lines[1]); back.timestamp = '2020-01-01T00:00:00.000Z'
  bad('timestamp goes backwards', join([lines[0], entryLine(back)]), /timestamp/i)
  // 未知字段 / 缺字段
  const extra = { ...JSON.parse(lines[0]), extra: 1 }
  bad('unknown field', join([entryLine(extra)]), /field/i)
  const { name: _n, ...missing } = JSON.parse(lines[0])
  bad('missing field', join([entryLine(missing)]), /field/i)
  assert.equal(verifyLog(join(lines)).ok, true)
})

test('evidence log: append refuses a broken chain, a duplicate name and a bad built_by; the file is left untouched', async (t) => {
  const { appendEntry } = await logLib()
  const file = path.join(tempDir(t, 'os-erp-log3-'), 'L.jsonl')
  appendEntry(file, { name: 'RC-1.0.0-1111111', evidence: fakeEvidence(1), sigText: null, builtBy: 'hosted-ci', timestamp: '2026-10-24T00:00:01.000Z' })
  appendEntry(file, { name: 'RC-1.0.0-2222222', evidence: fakeEvidence(2), sigText: null, builtBy: 'local', timestamp: '2026-10-24T00:00:02.000Z' })
  const good = readFileSync(file, 'utf8')
  assert.throws(() => appendEntry(file, { name: 'RC-1.0.0-2222222', evidence: fakeEvidence(2), sigText: null, builtBy: 'local', timestamp: '2026-10-24T00:00:03.000Z' }), /already|duplicate/i)
  assert.throws(() => appendEntry(file, { name: 'RC-1.0.0-3333333', evidence: fakeEvidence(3), sigText: null, builtBy: 'someone', timestamp: '2026-10-24T00:00:03.000Z' }), /built_by/)
  assert.throws(() => appendEntry(file, { name: 'RC-1.0.0-3333333', evidence: fakeEvidence(3), sigText: 'not-a-signature', builtBy: 'key-holder', timestamp: '2026-10-24T00:00:03.000Z' }), /signature/i)
  assert.equal(readFileSync(file, 'utf8'), good)
  const tampered = good.replace('"hosted-ci"', '"key-holder"')
  writeFileSync(file, tampered)
  assert.throws(() => appendEntry(file, { name: 'RC-1.0.0-3333333', evidence: fakeEvidence(3), sigText: null, builtBy: 'local', timestamp: '2026-10-24T00:00:03.000Z' }), /chain/i)
  assert.equal(readFileSync(file, 'utf8'), tampered, 'a broken log is never extended or repaired')
})

test('candidate --log appends a chained entry; verify-release --log checks chain and presence; unsigned candidates get a loud warning; --require-signature fails them', { timeout: 590000 }, (t) => {
  const src = minimalSource(t)
  const outRoot = tempDir(t, 'os-erp-log-out-')
  const out = path.join(outRoot, 'release')
  const logFile = path.join(outRoot, 'EVIDENCE-LOG.jsonl')
  const keys = newKeys(t)
  const r1 = candidate(src, out, {}, ['--log=' + logFile])
  assert.equal(r1.status, 0, r1.stderr.slice(-3000))
  const dir = path.join(out, readdirSync(out).find(f => f.endsWith('.evidence')))
  const evFile = path.join(dir, 'EVIDENCE.json')
  const ev = JSON.parse(readFileSync(evFile, 'utf8'))
  assert.equal(ev.signature, null)
  assert.equal(ev.built_by, 'local')
  const entries = readFileSync(logFile, 'utf8').trimEnd().split('\n').map(l => JSON.parse(l))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, ev.artifact.name.replace(/\.zip$/, ''))
  assert.equal(entries[0].signature, null)
  assert.equal(entries[0].built_by, 'local')
  const zip = path.join(out, readdirSync(out).find(f => f.endsWith('.zip')))
  const pkg = tempDir(t, 'os-erp-log-pkg-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const verify = (...extra) => spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${evFile}`, ...extra], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  const ok = verify(`--log=${logFile}`)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /evidence log.*verified/i)
  // 未签名：醒目警告，退出码不变
  assert.match(ok.stderr, /WARNING.*UNSIGNED/s)
  assert.match(verify().stderr, /WARNING.*UNSIGNED/s, 'warning appears even without --log')
  // --require-signature 使未签名失败；也要求同时验过签名
  const req = verify('--require-signature')
  assert.notEqual(req.status, 0)
  assert.match(req.stderr, /require-signature|unsigned/i)
  // 日志缺该候选 / 链被改 / 日志文件不存在 / --log 无 --evidence
  const empty = path.join(outRoot, 'empty.jsonl'); writeFileSync(empty, '')
  const absent = verify(`--log=${empty}`)
  assert.notEqual(absent.status, 0); assert.match(absent.stderr, /not (present|found|in)|missing/i)
  const missing = verify(`--log=${path.join(outRoot, 'nope.jsonl')}`)
  assert.notEqual(missing.status, 0)
  const forged = path.join(outRoot, 'forged.jsonl'); writeFileSync(forged, readFileSync(logFile, 'utf8').replace('"local"', '"hosted-ci"'))
  const f1 = verify(`--log=${forged}`)
  assert.notEqual(f1.status, 0); assert.match(f1.stderr, /log/i)
  const lone = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--log=${logFile}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(lone.status, 0); assert.match(lone.stderr, /--evidence/)
  // 证据与条目不一致（证据被改动但日志里是旧哈希）
  const changed = { ...ev, regression: { source: 'forged', result: 'passed', origin: 'operator-attested' } }
  const cf = path.join(outRoot, 'changed', 'EVIDENCE.json'); put(path.join(outRoot, 'changed'), 'EVIDENCE.json', JSON.stringify(changed))
  const c1 = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${cf}`, `--log=${logFile}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(c1.status, 0); assert.match(c1.stderr, /evidence_sha256|does not match/i)
  // 第二次构建同一候选名：脚本拒绝（已存在的候选目录），日志不变
  const before = readFileSync(logFile, 'utf8')
  rmSync(out, { recursive: true, force: true })
  const again = candidate(src, out, {}, ['--log=' + logFile])
  assert.notEqual(again.status, 0)
  assert.match(again.stderr, /already|log/i)
  assert.equal(readFileSync(logFile, 'utf8'), before)
  assert.ok(!existsSync(out) || readdirSync(out).length === 0, 'no candidate left when the log refuses')
  // 日志链已坏：构建前就拒绝，不留产物
  writeFileSync(logFile, before.replace(/"prev":"[0-9a-f]{64}"/, `"prev":"${'0'.repeat(64)}"`))
  const broken = candidate(src, out, {}, ['--log=' + logFile])
  assert.notEqual(broken.status, 0)
  assert.match(broken.stderr, /chain/i)
  assert.ok(!existsSync(out) || readdirSync(out).length === 0)
  void keys
})

test('hosted CI candidates record built_by hosted-ci and signature null; a signed one records the signature digest and passes --require-signature with --pubkey', { timeout: 590000 }, (t) => {
  const src = minimalSource(t)
  const keys = newKeys(t)
  const outRoot = tempDir(t, 'os-erp-log-out2-')
  const logFile = path.join(outRoot, 'EVIDENCE-LOG.jsonl')
  const hosted = candidate(src, path.join(outRoot, 'ci'), {}, ['--log=' + logFile], { GITHUB_ACTIONS: 'true' })
  assert.equal(hosted.status, 0, hosted.stderr.slice(-3000))
  const e = JSON.parse(readFileSync(logFile, 'utf8').trimEnd().split('\n')[0])
  assert.equal(e.built_by, 'hosted-ci'); assert.equal(e.signature, null)
  const evDir = path.join(outRoot, 'ci', readdirSync(path.join(outRoot, 'ci')).find(f => f.endsWith('.evidence')))
  assert.equal(JSON.parse(readFileSync(path.join(evDir, 'EVIDENCE.json'), 'utf8')).built_by, 'hosted-ci')
  // 同一候选名在另一个输出目录重新由持钥者签发：同名已在日志里 ⇒ 拒绝（重签需新提交/新名字）
  const dup = candidate(src, path.join(outRoot, 'signed'), {}, ['--log=' + logFile], { GML_RELEASE_SIGN_KEY: keys.priv })
  assert.notEqual(dup.status, 0)
  assert.match(dup.stderr, /already/i)
  // 用新日志做持钥者构建
  const log2 = path.join(outRoot, 'LOG2.jsonl')
  const signed = candidate(src, path.join(outRoot, 'signed2'), {}, ['--log=' + log2], { GML_RELEASE_SIGN_KEY: keys.priv })
  assert.equal(signed.status, 0, signed.stderr.slice(-3000))
  const s = JSON.parse(readFileSync(log2, 'utf8').trimEnd().split('\n')[0])
  assert.equal(s.built_by, 'key-holder')
  const sdir = path.join(outRoot, 'signed2', readdirSync(path.join(outRoot, 'signed2')).find(f => f.endsWith('.evidence')))
  const sigText = readFileSync(path.join(sdir, 'EVIDENCE.sig'), 'utf8')
  assert.equal(s.signature, sha256hex(sigText.trim()))
  const zip = path.join(outRoot, 'signed2', readdirSync(path.join(outRoot, 'signed2')).find(f => f.endsWith('.zip')))
  const pkg = tempDir(t, 'os-erp-log-pkg2-')
  for (const [n, bytes] of Object.entries(unzipSync(new Uint8Array(readFileSync(zip))))) if (!n.endsWith('/')) put(pkg, n.split('/').slice(1).join('/'), bytes)
  const v = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${path.join(sdir, 'EVIDENCE.json')}`, `--log=${log2}`, '--pubkey', keys.pub, '--require-signature'], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.equal(v.status, 0, v.stderr)
  assert.doesNotMatch(v.stderr, /UNSIGNED/)
  // --require-signature 不带 --pubkey：签名没被验过 ⇒ 失败
  const noPub = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${path.join(sdir, 'EVIDENCE.json')}`, '--require-signature'], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(noPub.status, 0); assert.match(noPub.stderr, /--pubkey/)
  // 日志条目声称有签名而 EVIDENCE.sig 被换：失败
  const swapDir = path.join(outRoot, 'swap'); mkdirSync(swapDir)
  writeFileSync(path.join(swapDir, 'EVIDENCE.json'), readFileSync(path.join(sdir, 'EVIDENCE.json')))
  writeFileSync(path.join(swapDir, 'EVIDENCE.sig'), Buffer.alloc(64, 1).toString('base64') + '\n')
  const sw = spawnSync(process.execPath, ['scripts/verify-release.mjs', `--evidence=${path.join(swapDir, 'EVIDENCE.json')}`, `--log=${log2}`], { cwd: pkg, env: { PATH }, encoding: 'utf8' })
  assert.notEqual(sw.status, 0); assert.match(sw.stderr, /signature/i)
})

test('evidence log: appends are serialized by a lock file, a held lock refuses (never interleaves), and signature text must be strict', async (t) => {
  const { appendEntry, signatureDigest } = await logLib()
  const file = path.join(tempDir(t, 'os-erp-log4-'), 'L.jsonl')
  const entry = n => ({ name: `RC-1.0.0-${String(n).repeat(7)}`, evidence: fakeEvidence(n), sigText: null, builtBy: 'local', timestamp: `2026-10-24T00:00:0${n}.000Z` })
  appendEntry(file, entry(1))
  writeFileSync(`${file}.lock`, 'held')
  const before = readFileSync(file, 'utf8')
  assert.throws(() => appendEntry(file, entry(2)), /lock/i)
  assert.equal(readFileSync(file, 'utf8'), before)
  rmSync(`${file}.lock`)
  appendEntry(file, entry(2))
  assert.ok(!existsSync(`${file}.lock`), 'lock released after a successful append')
  assert.throws(() => appendEntry(file, entry(2)), /already/)
  assert.ok(!existsSync(`${file}.lock`), 'lock released after a refused append')
  // 与验签一致：只允许尾部空白
  const sig = Buffer.alloc(64, 9).toString('base64')
  assert.equal(signatureDigest(`${sig}\n`), signatureDigest(sig))
  assert.throws(() => signatureDigest(` ${sig}`), /signature/i)
})
