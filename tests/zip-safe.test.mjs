/**
 * ============================================================================
 * 文件标识：tests/zip-safe.test.mjs ｜ zip 安全解压与 verify-release --extract-to 的单元 / CLI 测试（AH7）
 * ============================================================================
 * 【范围】用 fflate 现场生成的小 zip（含手工改写中央目录制造“说谎的声明大小”）：条目数 / 单文件 / 总字节上限、zip 炸弹、
 *   路径穿越、绝对路径、反斜杠、符号链接、重复条目、加密位、zip64 标记、目标目录非空；最后用 verify-release 的 CLI 标志走一遍。
 *   不联网；临时目录用完即删。
 * ============================================================================
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipSync, strToU8 } from 'fflate'
import { cleanEntryName, extractZipSafe, listZip, DEFAULT_LIMITS, ZipLimitError } from '../scripts/lib/zip-safe.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = (t, p = 'os-ah7-zip-') => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d }
const mk = (files, opts = {}) => Buffer.from(zipSync(files, opts))
const write = (dir, name, buf) => { const f = path.join(dir, name); fs.writeFileSync(f, buf); return f }
const refused = (fn, re) => assert.throws(fn, (e) => e instanceof ZipLimitError && re.test(e.message), String(re))

/** Find the central directory record of the first entry with this name and patch a u32 field (offset within the record). */
function patchCd(buf, name, fieldOff, value, size = 4) {
  const out = Buffer.from(buf)
  for (let i = 0; i + 46 < out.length; i++) {
    if (out.readUInt32LE(i) === 0x02014b50 && out.toString('utf8', i + 46, i + 46 + out.readUInt16LE(i + 28)) === name) {
      if (size === 4) out.writeUInt32LE(value, i + fieldOff); else out.writeUInt16LE(value, i + fieldOff)
      return out
    }
  }
  throw new Error('entry not found')
}

test('a normal archive extracts, stripping the top directory, with 0644 permissions restricted by umask', (t) => {
  const d = tmp(t)
  const z = write(d, 'a.zip', mk({ 'RC/MANIFEST.json': strToU8('{"a":1}'), 'RC/sub/x.txt': strToU8('hello'), 'RC/empty/': new Uint8Array(0) }))
  const r = extractZipSafe(z, path.join(d, 'out'), {}, { strip: 1 })
  assert.deepEqual([r.files, r.bytes], [2, 12])
  assert.equal(fs.readFileSync(path.join(d, 'out/sub/x.txt'), 'utf8'), 'hello')
  assert.ok(fs.statSync(path.join(d, 'out/empty')).isDirectory())
  assert.equal(fs.statSync(path.join(d, 'out/MANIFEST.json')).mode & 0o7777, 0o644 & ~process.umask())
})

test('defaults are finite and sane', () => {
  assert.ok(DEFAULT_LIMITS.maxEntries >= 1000 && DEFAULT_LIMITS.maxEntries <= 100000)
  assert.ok(DEFAULT_LIMITS.maxFileBytes < DEFAULT_LIMITS.maxTotalBytes)
  assert.ok(Object.isFrozen(DEFAULT_LIMITS))
})

test('entry-count limit is checked from the central directory before anything is inflated', (t) => {
  const d = tmp(t)
  const files = {}
  for (let i = 0; i < 11; i++) files[`RC/f${i}`] = strToU8('x')
  const z = write(d, 'a.zip', mk(files))
  refused(() => extractZipSafe(z, path.join(d, 'out'), { maxEntries: 10 }), /11 entries.*10 entry limit/)
  assert.ok(!fs.existsSync(path.join(d, 'out')), 'nothing created on refusal')
  assert.equal(extractZipSafe(z, path.join(d, 'ok'), { maxEntries: 11 }).files, 11)
})

test('per-file limit and total limit, on honest declarations', (t) => {
  const d = tmp(t)
  const z = write(d, 'a.zip', mk({ 'RC/a': new Uint8Array(600).fill(1), 'RC/b': new Uint8Array(600).fill(2) }))
  refused(() => extractZipSafe(z, path.join(d, 'o1'), { maxFileBytes: 500 }), /per-file limit/)
  refused(() => extractZipSafe(z, path.join(d, 'o2'), { maxFileBytes: 600, maxTotalBytes: 1000 }), /1200 bytes in total/)
  assert.equal(extractZipSafe(z, path.join(d, 'o3'), { maxFileBytes: 600, maxTotalBytes: 1200 }).bytes, 1200)
})

test('zip bomb: a tiny archive of highly compressible data is stopped by the real output size, not by the header', (t) => {
  const d = tmp(t)
  const z = write(d, 'bomb.zip', mk({ 'RC/zeros': new Uint8Array(4 * 1024 * 1024) }))
  assert.ok(fs.statSync(z).size < 8 * 1024, 'archive is tiny')
  refused(() => extractZipSafe(z, path.join(d, 'o1'), { maxFileBytes: 1024 * 1024 }), /per-file limit/)
  // lie: declare 10 bytes in the central directory while the data inflates to 4 MiB
  const lie = patchCd(fs.readFileSync(z), 'RC/zeros', 24, 10)
  const lz = write(d, 'lie.zip', lie)
  refused(() => extractZipSafe(lz, path.join(d, 'o2'), { maxFileBytes: 1024 * 1024, maxTotalBytes: 1024 * 1024 }), /inflates past the size limits/)
  assert.ok(!fs.existsSync(path.join(d, 'o2')), 'destination created by the call is removed on failure')
  // lie within the limits: the declaration must still equal the real size
  refused(() => extractZipSafe(lz, path.join(d, 'o3'), { maxFileBytes: 8 * 1024 * 1024, maxTotalBytes: 8 * 1024 * 1024 }), /differs from its declaration/)
})

test('total limit counts real bytes across entries even when each declaration is under the file limit', (t) => {
  const d = tmp(t)
  const z = write(d, 'a.zip', mk({ 'RC/a': new Uint8Array(1000), 'RC/b': new Uint8Array(1000) }))
  let lie = patchCd(fs.readFileSync(z), 'RC/a', 24, 1)
  lie = patchCd(lie, 'RC/b', 24, 1)
  refused(() => extractZipSafe(write(d, 'l.zip', lie), path.join(d, 'o'), { maxFileBytes: 1500, maxTotalBytes: 1500 }), /inflates past|exceed|differs from its declaration/)
})

test('CRC mismatch is refused', (t) => {
  const d = tmp(t)
  const z = fs.readFileSync(write(d, 'a.zip', mk({ 'RC/a': strToU8('hello world') })))
  refused(() => extractZipSafe(write(d, 'c.zip', patchCd(z, 'RC/a', 16, 0xdeadbeef)), path.join(d, 'o')), /CRC32 mismatch/)
})

test('path traversal, absolute paths, backslashes, dot segments and NUL are refused', (t) => {
  const d = tmp(t)
  for (const [name, re] of [['../evil', /traversal/], ['RC/../../evil', /traversal/], ['/etc/passwd', /absolute/], ['C:/x', /absolute/], ['RC\\..\\evil', /backslash/], ['RC/./x', /non-canonical/], ['RC//x', /non-canonical/], ['RC/a\0b', /NUL/]]) {
    const z = write(d, 'a.zip', mk({ [name]: strToU8('x') }))
    const out = path.join(d, 'out-' + Math.random().toString(36).slice(2))
    refused(() => extractZipSafe(z, out, {}, { strip: 0 }), re)
    assert.ok(!fs.existsSync(out))
  }
  refused(() => cleanEntryName(''), /empty/)
  assert.equal(cleanEntryName('RC/a/b', { strip: 1 }), 'a/b')
})

test('traversal that only appears after stripping cannot escape (strip happens after validation of every segment)', (t) => {
  const d = tmp(t)
  refused(() => extractZipSafe(write(d, 'a.zip', mk({ '../x/y': strToU8('x') })), path.join(d, 'o'), {}, { strip: 1 }), /traversal/)
  assert.ok(!fs.existsSync(path.join(d, 'x')))
})

test('symbolic links and special files are refused (Unix mode in the external attributes)', (t) => {
  const d = tmp(t)
  const link = write(d, 'l.zip', mk({ 'RC/ok': strToU8('x'), 'RC/link': [strToU8('/etc/passwd'), { os: 3, attrs: (0o120777 << 16) >>> 0 }] }))
  refused(() => extractZipSafe(link, path.join(d, 'o1')), /symbolic link/)
  assert.ok(!fs.existsSync(path.join(d, 'o1')))
  const fifo = write(d, 'f.zip', mk({ 'RC/pipe': [strToU8(''), { os: 3, attrs: (0o010644 << 16) >>> 0 }] }))
  refused(() => extractZipSafe(fifo, path.join(d, 'o2')), /special file/)
  const reg = write(d, 'r.zip', mk({ 'RC/file': [strToU8('x'), { os: 3, attrs: (0o100755 << 16) >>> 0 }] }))
  extractZipSafe(reg, path.join(d, 'o3'))
  assert.equal(fs.statSync(path.join(d, 'o3/RC/file')).mode & 0o7777, 0o644 & ~process.umask(), 'zip modes (setuid, exec) are not honoured; a restrictive umask is preserved')
})

test('duplicate entries (case-insensitive) and file/dir collisions are refused', (t) => {
  const d = tmp(t)
  refused(() => extractZipSafe(write(d, 'a.zip', mk({ 'RC/A': strToU8('1'), 'RC/a': strToU8('2') })), path.join(d, 'o1')), /duplicate/)
  assert.throws(() => extractZipSafe(write(d, 'b.zip', mk({ 'RC/a': strToU8('1'), 'RC/a/b': strToU8('2') })), path.join(d, 'o2')))
})

test('encrypted flag, zip64 markers, unsupported methods and non-zip input are refused', (t) => {
  const d = tmp(t)
  const z = fs.readFileSync(write(d, 'a.zip', mk({ 'RC/a': strToU8('hello world') })))
  refused(() => listZip(patchCd(z, 'RC/a', 8, 1, 2)), /encrypted/)
  refused(() => listZip(patchCd(z, 'RC/a', 20, 0xffffffff)), /zip64/)
  refused(() => listZip(patchCd(z, 'RC/a', 10, 12, 2)), /unsupported compression/)
  refused(() => listZip(Buffer.from('not a zip at all, just text of some length')), /not a zip/)
  refused(() => listZip(Buffer.alloc(5)), /too short/)
  refused(() => listZip(z, { maxArchiveBytes: 10 }), /byte limit/)
})

test('the destination must not exist or must be empty; limits must be positive integers', (t) => {
  const d = tmp(t)
  const z = write(d, 'a.zip', mk({ 'RC/a': strToU8('x') }))
  fs.mkdirSync(path.join(d, 'full')); fs.writeFileSync(path.join(d, 'full/keep'), 'k')
  refused(() => extractZipSafe(z, path.join(d, 'full')), /empty directory/)
  assert.equal(fs.readFileSync(path.join(d, 'full/keep'), 'utf8'), 'k')
  fs.mkdirSync(path.join(d, 'empty'))
  assert.equal(extractZipSafe(z, path.join(d, 'empty')).files, 1)
  refused(() => extractZipSafe(z, path.join(d, 'x'), { maxEntries: 0 }), /positive integer/)
  refused(() => extractZipSafe(z, path.join(d, 'y'), { maxFileBytes: 1.5 }), /positive integer/)
})

test('a pre-existing symlink inside the destination is never followed (wx + empty-destination rule)', (t) => {
  const d = tmp(t)
  const victim = path.join(d, 'victim'); fs.writeFileSync(victim, 'original')
  const dest = path.join(d, 'dest'); fs.mkdirSync(dest); fs.symlinkSync(victim, path.join(dest, 'a'))
  refused(() => extractZipSafe(write(d, 'a.zip', mk({ 'RC/a': strToU8('pwn') })), dest, {}, { strip: 1 }), /empty directory/)
  assert.equal(fs.readFileSync(victim, 'utf8'), 'original')
})

// ---- verify-release CLI ----------------------------------------------------------------------------------------------------
function fixturePackage(t) {
  const pkg = tmp(t, 'os-ah7-pkg-')
  const put = (rel, content) => { fs.mkdirSync(path.dirname(path.join(pkg, rel)), { recursive: true }); fs.writeFileSync(path.join(pkg, rel), content) }
  for (const f of ['scripts/verify-release.mjs', ...fs.readdirSync(path.join(ROOT, 'scripts/lib')).filter((x) => /^(evidence-sign|evidence-log|fs-fault|safe-path|tests-tree|offbox-anchor|sbom-diff|zip-safe)\.mjs$/.test(x)).map((x) => `scripts/lib/${x}`)]) put(f, fs.readFileSync(path.join(ROOT, f)))
  put('THIRD_PARTY_NOTICES.md', 'notices\n'); put('CHANGELOG.md', '<!-- generated -->\n')
  put('release/sbom.cdx.json', JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{ name: 'x', version: '1', 'bom-ref': 'x@1' }] }))
  const files = {}
  const walk = (dir, pre = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), rel); else files[rel] = createHash('sha256').update(fs.readFileSync(path.join(dir, e.name))).digest('hex') } }
  walk(pkg)
  put('MANIFEST.json', JSON.stringify({ version: '0.0.0', baseCommit: 'a'.repeat(40), files }))
  return pkg
}
const verify = (pkg, args) => spawnSync(process.execPath, [path.join(pkg, 'scripts/verify-release.mjs'), ...args], { cwd: pkg, encoding: 'utf8' })
function zipOf(pkg, extra = {}) {
  const files = {}
  const walk = (dir, pre = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), rel); else files[`RC-0.0.0-aaaaaaa/${rel}`] = new Uint8Array(fs.readFileSync(path.join(dir, e.name))) } }
  walk(pkg)
  return mk({ ...files, ...extra })
}

test('verify-release --extract-to extracts a matching archive and reports the limits in force', (t) => {
  const pkg = fixturePackage(t), out = tmp(t)
  const z = write(out, 'RC-0.0.0-aaaaaaa.zip', zipOf(pkg))
  const dest = path.join(out, 'x')
  const r = verify(pkg, [`--artifact=${z}`, `--extract-to=${dest}`, '--zip-max-entries', '500'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /archive extracted safely.*content matches MANIFEST\.json.*"maxEntries":500/)
  assert.ok(fs.existsSync(path.join(dest, 'MANIFEST.json')))
})

test('verify-release --extract-to fails on limits, traversal, a different MANIFEST, and bad flags', (t) => {
  const pkg = fixturePackage(t), out = tmp(t)
  const z = write(out, 'RC-0.0.0-aaaaaaa.zip', zipOf(pkg))
  let r = verify(pkg, [`--artifact=${z}`, `--extract-to=${path.join(out, 'a')}`, '--zip-max-entries=3'])
  assert.equal(r.status, 1); assert.match(r.stderr, /EXTRACT:.*entry limit/)
  r = verify(pkg, [`--artifact=${z}`, `--extract-to=${path.join(out, 'b')}`, '--zip-max-total-bytes=10'])
  assert.equal(r.status, 1); assert.match(r.stderr, /EXTRACT:/)
  const evil = write(out, 'evil.zip', zipOf(pkg, { '../escape': strToU8('x') }))
  r = verify(pkg, [`--artifact=${evil}`, `--extract-to=${path.join(out, 'c')}`])
  assert.equal(r.status, 1); assert.match(r.stderr, /traversal/)
  assert.ok(!fs.existsSync(path.join(out, 'escape')))
  const other = write(out, 'other.zip', zipOf(pkg, { 'RC-0.0.0-aaaaaaa/MANIFEST.json': strToU8('{"tampered":true}') }))
  r = verify(pkg, [`--artifact=${other}`, `--extract-to=${path.join(out, 'd')}`])
  assert.equal(r.status, 1); assert.match(r.stderr, /differs from this package/)
  r = verify(pkg, [`--extract-to=${path.join(out, 'e')}`]); assert.equal(r.status, 1); assert.match(r.stderr, /needs --artifact/)
  r = verify(pkg, ['--zip-max-entries=5']); assert.equal(r.status, 1); assert.match(r.stderr, /only make sense/)
  r = verify(pkg, [`--artifact=${z}`, `--extract-to=${path.join(out, 'f')}`, '--zip-max-entries=0']); assert.equal(r.status, 1); assert.match(r.stderr, /positive integer/)
  r = verify(pkg, [`--artifact=${z}`, `--extract-to=${path.join(out, 'g')}`, '--zip-max-entries=1e3']); assert.equal(r.status, 1); assert.match(r.stderr, /positive integer/)
})

test('verify-release --extract-to checks the extracted tree against MANIFEST: tampered, missing and unlisted files fail (Codex P1)', (t) => {
  const pkg = fixturePackage(t), out = tmp(t)
  const top = 'RC-0.0.0-aaaaaaa/'
  const build = (mutate) => {
    const files = JSON.parse(JSON.stringify({}))
    const walk = (dir, pre = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const rel = pre ? `${pre}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(dir, e.name), rel); else files[top + rel] = new Uint8Array(fs.readFileSync(path.join(dir, e.name))) } }
    walk(pkg); mutate(files)
    return mk(files)
  }
  const cases = [
    ['tampered', (f) => { f[top + 'CHANGELOG.md'] = strToU8('<!-- generated -->\nevil\n') }, /CHANGELOG\.md: hash mismatch/],
    ['missing', (f) => { delete f[top + 'THIRD_PARTY_NOTICES.md'] }, /THIRD_PARTY_NOTICES\.md: listed in MANIFEST\.json but missing/],
    ['unlisted', (f) => { f[top + 'extra.js'] = strToU8('x') }, /extra\.js: file in the archive is not listed/]
  ]
  for (const [name, mutate, re] of cases) {
    const z = write(out, `${name}.zip`, build(mutate))
    const r = verify(pkg, [`--artifact=${z}`, `--extract-to=${path.join(out, name)}`])
    assert.equal(r.status, 1, name + r.stdout); assert.match(r.stderr, re, name); assert.doesNotMatch(r.stdout, /extracted safely/)
  }
})

test('verify-release does not touch the filesystem when a limit argument is invalid (Codex P2)', (t) => {
  const pkg = fixturePackage(t), out = tmp(t)
  const z = write(out, 'RC-0.0.0-aaaaaaa.zip', zipOf(pkg))
  const dest = path.join(out, 'never')
  const r = verify(pkg, [`--artifact=${z}`, `--extract-to=${dest}`, '--zip-max-total-bytes=0'])
  assert.equal(r.status, 1); assert.match(r.stderr, /not extracting/)
  assert.ok(!fs.existsSync(dest))
})

test('verify-release without --extract-to behaves as before', (t) => {
  const pkg = fixturePackage(t)
  const r = verify(pkg, [])
  assert.equal(r.status, 0, r.stderr)
  assert.doesNotMatch(r.stdout, /extracted/)
})
