/**
 * ============================================================================
 * 文件标识：tests/verify-release-args.test.mjs ｜ 发行验证参数不能静默跳过证据与归档校验
 * ============================================================================
 * 【职责】在临时最小包中验证空格/等号参数等价，以及缺值/重复参数失败关闭；不构建、不联网、不接触业务数据。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
const ROOT = fileURLToPath(new URL('../', import.meta.url))
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-verify-args-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const pkg = path.join(dir, 'pkg')
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true })
  fs.copyFileSync(path.join(ROOT, 'scripts/verify-release.mjs'), path.join(pkg, 'scripts/verify-release.mjs'))
  fs.cpSync(path.join(ROOT, 'scripts/lib'), path.join(pkg, 'scripts/lib'), { recursive: true })
  fs.writeFileSync(path.join(pkg, 'THIRD_PARTY_NOTICES.md'), 'notices')
  fs.writeFileSync(path.join(pkg, 'CHANGELOG.md'), '<!-- generated -->')
  fs.mkdirSync(path.join(pkg, 'release'))
  fs.writeFileSync(path.join(pkg, 'release/sbom.cdx.json'), JSON.stringify({ bomFormat: 'CycloneDX', specVersion: '1.5', components: [{name:'fixture',version:'1','bom-ref':'fixture@1'}] }))
  const files = {}
  const walk = (dir, prefix = '') => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const rel = prefix + e.name; if (e.isDirectory()) walk(path.join(dir,e.name), rel+'/'); else files[rel] = createHash('sha256').update(fs.readFileSync(path.join(dir,e.name))).digest('hex') } }
  walk(pkg)
  fs.writeFileSync(path.join(pkg, 'MANIFEST.json'), JSON.stringify({ version:'0.0.0',baseCommit:'a'.repeat(40),files }))
  const run = (args) => spawnSync(process.execPath, [path.join(pkg,'scripts/verify-release.mjs'),...args], { cwd:pkg, encoding:'utf8', env:{ PATH:process.env.PATH,HOME:dir,TMPDIR:dir } })
  return {dir,pkg,files,run}
}
test('evidence space and equals forms both inspect the supplied file', (t) => {
  const {dir,run} = fixture(t)
  assert.equal(run([]).status,0)
  const missing = path.join(dir,'missing-evidence.json')
  for (const args of [[`--evidence=${missing}`],['--evidence',missing]]) {
    const r=run(args); assert.notEqual(r.status,0); assert.match(r.stderr,/EVIDENCE: cannot read/)
  }
})
test('artifact space and equals forms both bind the archive to evidence', (t) => {
  const {dir,files,run} = fixture(t)
  const evidence=path.join(dir,'evidence.json'), archive=path.join(dir,'RC-missing.zip')
  fs.writeFileSync(evidence,JSON.stringify({ artifact:{name:'RC-missing.zip',sha256:'a'.repeat(64),files:Object.keys(files).length},guards:{} }))
  for(const args of [[`--artifact=${archive}`],['--artifact',archive]]) {
    const r=run([`--evidence=${evidence}`,...args]); assert.notEqual(r.status,0); assert.match(r.stderr,/artifact: cannot read/)
  }
})
test('missing, empty and duplicate evidence/artifact arguments fail closed', (t) => {
  const {run}=fixture(t)
  for(const flag of ['--evidence','--artifact']) for(const args of [[flag],[flag+'='],[flag,'--require-signature'],[flag+'=one',flag,'two']]) {
    const r=run(args); assert.notEqual(r.status,0,JSON.stringify(args)); assert.match(r.stderr,/needs a value|given more than once/)
  }
})

test('artifact without evidence cannot silently run manifest-only validation', (t) => {
  const {run}=fixture(t)
  for (const args of [['--artifact=archive.zip'],['--artifact','archive.zip']]) {
    const r=run(args); assert.notEqual(r.status,0); assert.match(r.stderr,/artifact requires --evidence/)
  }
})
