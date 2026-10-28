/**
 * ============================================================================ 文件标识：tests/mixed-soak.test.mjs ｜ Reject partial, failed and undersampled soak evidence. */
import test from 'node:test'
import assert from 'node:assert/strict'
import {quantile,verdict,validatePreflight,failureCode} from '../scripts/mixed-soak.mjs'
const good=()=>({elapsed_ms:1800000,invariants:true,write_integrity:true,operations:Object.fromEntries(['read','write','mcp','backup'].map(k=>[k,{success:6,errors:0,max_success_gap_ms:60000,first_success_ms:0,last_success_ms:1700000}])),samples:Array(60).fill({})})
test('no short or incomplete run passes',()=>{
 assert.equal(verdict(good()),true)
 for(const patch of [{elapsed_ms:1799999},{invariants:false},{write_integrity:false},{samples:[]}])assert.equal(verdict({...good(),...patch}),false)
 for(const k of ['read','write','mcp','backup']){const r=good();r.operations[k].errors=1;assert.equal(verdict(r),false);r.operations[k]={success:0,errors:0};assert.equal(verdict(r),false)}
 const r=good();r.operations.backup.success=5;assert.equal(verdict(r),false)
})
test('quantiles include tail latency and empty observations stay unknown',()=>{assert.equal(quantile([],0.95),null);assert.equal(quantile([8,1,3,2],0.95),8);assert.equal(quantile([8,1,3,2],0.5),2)})

test('early-only activity cannot pass a nominal thirty-minute clock',()=>{const r=good();r.operations.mcp.last_success_ms=60000;assert.equal(verdict(r),false)})

test('preflight guards reject other hosts, SHAs and existing or relative output',()=>{
 const sha='a'.repeat(40)
 validatePreflight('linux',sha,sha,'/tmp/new.json',false)
 for(const args of [['darwin',sha,sha,'/tmp/new.json',false],['linux',sha,'b'.repeat(40),'/tmp/new.json',false],['linux',sha,sha,'relative',false],['linux',sha,sha,'/tmp/old.json',true]])assert.throws(()=>validatePreflight(...args))
 assert.equal(failureCode(Error('/secret/path')),'unexpected_error');assert.equal(failureCode(Error('seed_incomplete')),'seed_incomplete')
 const r=good();r.samples=Array(29).fill({});assert.equal(verdict(r),false)
})

test('a silent mid-run gap fails even when early and late requests succeeded',()=>{const r=good();r.operations.read.max_success_gap_ms=300001;assert.equal(verdict(r),false)})

test('workflow resolves runner paths inside execution steps, not job-level env',async()=>{
 const fs=await import('node:fs')
 const y=fs.readFileSync(new URL('../.github/workflows/nightly-capacity.yml',import.meta.url),'utf8').split('\n  mixed-soak:')[1]
 assert.doesNotMatch(y.split('    steps:')[0],/runner\.temp/)
 assert.match(y,/export SOAK_OUTPUT="\$RUNNER_TEMP\/soak-evidence\.json"/)
 assert.match(y,/ref: \$\{\{ github.sha \}\}/)
})

test('synthetic copy retains production classification and rejects other modes',async()=>{
 const {default:Database}=await import('better-sqlite3')
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path')
 const {classifyEmptyDatabase,assertDatabaseMode}=await import('../server/db/runtime-policy.js')
 const {validateSoakCopy}=await import('../scripts/mixed-soak.mjs')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soak-mode-test-'))
 let source,copy
 try {
  source=new Database(path.join(dir,'source.db'));classifyEmptyDatabase(source,'production');source.close();source=null
  fs.copyFileSync(path.join(dir,'source.db'),path.join(dir,'copy.db'))
  copy=new Database(path.join(dir,'copy.db'))
  assert.throws(()=>assertDatabaseMode(copy,'test'),{code:'DATABASE_MODE_MISMATCH'})
  validateSoakCopy(copy);assert.doesNotThrow(()=>assertDatabaseMode(copy,'production'))
  copy.prepare("UPDATE os_egp_runtime SET mode='test'").run()
  assert.throws(()=>validateSoakCopy(copy),/seed_classification_invalid/)
  source=new Database(path.join(dir,'source.db'),{readonly:true});assert.doesNotThrow(()=>assertDatabaseMode(source,'production'))
 } finally {source?.close();copy?.close();fs.rmSync(dir,{recursive:true,force:true})}
})

test('production boot preserves synthetic business invariants',async()=>{
 const fs=await import('node:fs'),os=await import('node:os'),path=await import('node:path'),{execFileSync}=await import('node:child_process')
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'soak-production-'))
 const env={...process.env,GML_DATA_DIR:dir,GML_RUNTIME_MODE:'production',GML_DB:''}
 try {
  execFileSync(process.execPath,['scripts/synth-data.mjs','--skus','60','--docs','120','--txns','600','--quiet'],{env,stdio:'ignore'})
  execFileSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import Database from 'better-sqlite3';import {verifyInvariants} from './scripts/synth-data.mjs';import {bootAll} from './server/db/production-boot.js';const db=new Database(process.env.GML_DATA_DIR+'/gml_cosmetic.db');assert.equal((await verifyInvariants(db)).ok,true);bootAll();assert.equal((await verifyInvariants(db)).ok,true);process.exit(0)`],{env,stdio:'ignore',timeout:120000})
 }finally{fs.rmSync(dir,{recursive:true,force:true})}
})
