/**
 * ============================================================================
 * 文件标识：scripts/mixed-soak.mjs ｜ Fresh synthetic same-database mixed-load soak.
 * Owns a temporary instance; never accepts an existing database. Summary only is publishable.
 * Hosted 30-minute evidence is scoped to one source SHA, not production acceptance.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { spawn, execFileSync } from 'node:child_process'
import { randomBytes, createHash } from 'node:crypto'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
export function quantile(values, p) {
  if (!values.length) return null
  return [...values].sort((a,b) => a-b)[Math.ceil(values.length*p)-1]
}
export function verdict(r) {
  return r.elapsed_ms >= 1800000 && r.invariants === true && r.write_integrity === true &&
    ['read','write','mcp','backup'].every(k => r.operations[k].success > 0 && r.operations[k].errors === 0 && r.operations[k].max_success_gap_ms <= 300000 && r.operations[k].last_success_ms-r.operations[k].first_success_ms >= 1620000) &&
    r.operations.backup.success >= 6 && r.samples.length >= 30
}
const children=new Set()
let aborter
const sleep=ms=>delay(ms,undefined,{signal:aborter?.signal})
const FAILURE_CODES=new Set(['linux_required','source_sha_mismatch','fresh_absolute_output_required','seed_incomplete','seed_classification_invalid','seed_copy_incomplete','baseline_invariants_failed','mcp_preflight_failed','startup_failed','login_failed','worker_failed','sampling_failed','child_command_failed','soak_failed','cancelled'])
export const failureCode=e=>FAILURE_CODES.has(e?.message)?e.message:'unexpected_error'
export function requestDiagnostic(status, body) {
  const allowed=new Set(['FEATURE_DISABLED','MCP_RATE_LIMITED','TOKEN_RATE_LIMITED','TOKEN_INVALID','TOKEN_OWNER_PERM_DENIED','SQLITE_BUSY','SQLITE_BUSY_SNAPSHOT'])
  const code=[body?.error,body?.code,body?.error?.data?.code,body?.detail?.code].find(x=>typeof x==='string' && allowed.has(x))
  return {status:Number.isInteger(status)&&status>=100&&status<=599?status:null,code:code||'request_failed'}
}
export function validatePreflight(platform,source,expected,output,exists){
  if(platform!=='linux')throw Error('linux_required')
  if(source!==expected || !/^[a-f0-9]{40}$/.test(source))throw Error('source_sha_mismatch')
  if(!output || !path.isAbsolute(output) || exists)throw Error('fresh_absolute_output_required')
}
async function command(args, env, timeout = 1200000) {
  const child = spawn(process.execPath, args, { cwd: ROOT, env, stdio: 'ignore' })
  children.add(child)
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout)
  try { const [code] = await once(child, 'close'); if (code !== 0) throw Error('child_command_failed') }
  finally { clearTimeout(timer);children.delete(child) }
}
export function validateSoakCopy(db) {
  if(db.prepare('SELECT mode FROM os_egp_runtime WHERE id=1').get()?.mode!=='production')throw Error('seed_classification_invalid')

}
export async function run() {
  const source = execFileSync('git', ['rev-parse','HEAD'], { cwd: ROOT, encoding:'utf8' }).trim()
  const output = process.env.SOAK_OUTPUT
  validatePreflight(process.platform,source,process.env.SOAK_SOURCE_SHA,output,output && fs.existsSync(output))
  aborter=new AbortController()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'os-erp-soak-'))
  let data = path.join(dir, 'data')
  const password = randomBytes(24).toString('hex')
  const env = { PATH:process.env.PATH, HOME:dir, TMPDIR:dir, GML_DATA_DIR:data, GML_DB:'', GML_RUNTIME_MODE:'production', GML_SYNTH_ADMIN_PASSWORD:password }
  let server, closed, db
  let stopping = false, cancelRequested = false
  const r = { schema:1, source_sha:source, harness_sha: /^[a-f0-9]{40}$/.test(process.env.SOAK_HARNESS_SHA||'')?process.env.SOAK_HARNESS_SHA:null, harness_sha256:createHash('sha256').update(fs.readFileSync(fileURLToPath(import.meta.url))).digest('hex'), duration_target_ms:1800000, elapsed_ms:0, invariants:false, write_integrity:false,
    operations:Object.fromEntries(['read','write','mcp','backup'].map(k=>[k,{success:0,errors:0,max_success_gap_ms:0,first_success_ms:null,last_success_ms:null,error_counts:{},latency_ms:[]} ])), samples:[], ok:false }
  const cancel=()=>{cancelRequested=true;stopping=true;aborter.abort();for(const child of children)child.kill('SIGKILL');if(server)server.kill('SIGKILL')}
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel)
  try {
    r.phase='seed'
    await command(['scripts/synth-data.mjs','--skus','10000','--docs','10000','--txns','100000','--seed','20261028','--quiet','--out',path.join(dir,'seed.json')],env)
    const seed=JSON.parse(fs.readFileSync(path.join(dir,'seed.json')))
    if(seed.partial || seed.invariants?.ok !== true || seed.reached.skus < 10000 || seed.reached.txns < 100000) throw Error('seed_incomplete')
    r.seed={skus:seed.reached.skus,docs:seed.reached.docs,txns:seed.reached.txns}
    // Keep the owned synthetic copy production-classified: demo boot mutates business data.
    const benchData=path.join(dir,'bench-copy');fs.mkdirSync(benchData,{mode:0o700})
    const sourceWal=path.join(data,'gml_cosmetic.db-wal')
    if(fs.existsSync(sourceWal) && fs.statSync(sourceWal).size>0)throw Error('seed_copy_incomplete')
    fs.copyFileSync(path.join(data,'gml_cosmetic.db'),path.join(benchData,'gml_cosmetic.db'))
    data=benchData;env.GML_DATA_DIR=data
    // Imports happen only after the owned instance environment is fixed.
    Object.assign(process.env,{GML_DATA_DIR:data,GML_DB:'',GML_RUNTIME_MODE:'production'})
    const {default:Database}=await import('better-sqlite3')
    const {createToken}=await import('../server/mcp/tokens.js')
    const {verifyInvariants}=await import('./synth-data.mjs')
    const dbPath=path.join(data,'gml_cosmetic.db')
    db=new Database(dbPath); db.pragma('busy_timeout=5000')
    const preBoot={skus:db.prepare('SELECT COUNT(*) n FROM product_skus').get().n,txns:db.prepare('SELECT COUNT(*) n FROM inventory_transactions').get().n}
    if(preBoot.skus!==seed.reached.skus || preBoot.txns!==seed.reached.txns)throw Error('seed_copy_incomplete')
    validateSoakCopy(db)
    const owner=db.prepare("SELECT id FROM users WHERE username='synthadmin'").get()
    const agent=createToken(db,{name:'synthetic-soak',ownerUserId:owner.id,industry:'cosmetic',scopes:'read',allowTools:'inventory.query_stock'}).token
    const target=db.prepare('SELECT warehouse_id,sku_id,batch_no FROM inventory_stocks WHERE qty_on_hand>0 ORDER BY id LIMIT 1').get()
    const stock=()=>db.prepare('SELECT SUM(qty_on_hand) q FROM inventory_stocks WHERE warehouse_id=? AND sku_id=? AND batch_no=?').get(target.warehouse_id,target.sku_id,target.batch_no).q
    let before
    const marker='soak-'+randomBytes(8).toString('hex')
    const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve))
    r.phase='startup'
    server=spawn(process.execPath,['server/index.js'],{cwd:ROOT,env:{...env,GML_RUNTIME_MODE:'production',GML_JWT_SECRET:randomBytes(32).toString('hex'),HOST:'127.0.0.1',PORT:String(port)},stdio:['ignore','pipe','pipe']})
    closed=once(server,'close');let ready=false
    server.stdout.on('data',d=>{if(d.toString().includes('服务已启动'))ready=true});server.stderr.resume()
    const boot=performance.now()
    while(!ready && server.exitCode===null && performance.now()-boot<600000) await sleep(100)
    if(!ready)throw Error('startup_failed')
    r.startup_ms=Math.round(performance.now()-boot)
    const call=async(route,token,body)=>{
      if(server.exitCode!==null || server.signalCode!==null) throw Error('server_exit')
      const res=await fetch(`http://127.0.0.1:${port}${route}`,{method:body?'POST':'GET',headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(30000)})
      let b
      try { b=await res.json() } catch { throw Object.assign(Error('request_failed'),{diagnostic:requestDiagnostic(res.status,null)}) }
      if(!res.ok || b.success===false || b.error || b.result?.isError)throw Object.assign(Error('request_failed'),{diagnostic:requestDiagnostic(res.status,b)})
      return b
    }
    const login=await call('/api/auth/login',null,{username:'synthadmin',password,industry:'cosmetic'})
    const token=login.data?.token;if(!token)throw Error('login_failed')
    if(!(await verifyInvariants(db)).ok)throw Error('baseline_invariants_failed')
    before=stock()
    r.dataset={pre_boot:preBoot,synthetic_copy:true,runtime_mode:'production',skus:db.prepare('SELECT COUNT(*) n FROM product_skus').get().n,txns:db.prepare('SELECT COUNT(*) n FROM inventory_transactions').get().n}

    r.dataset.overlay_delta={skus:r.dataset.skus-preBoot.skus,txns:r.dataset.txns-preBoot.txns}
    r.phase='preflight'
    try { await call('/mcp',agent,{jsonrpc:'2.0',id:0,method:'tools/call',params:{name:'inventory.query_stock',arguments:{limit:5}}}) }
    catch(e){r.preflight_error=e.diagnostic||{status:null,code:'request_failed'};throw Error('mcp_preflight_failed')}
    r.phase='workload'
    const started=performance.now(), deadline=started+1800000
    const task=async(name,fn,interval)=>{while(!stopping && performance.now()<deadline){const t=performance.now();try{await fn();r.operations[name].success++;const ms=Math.round(performance.now()-started);r.operations[name].max_success_gap_ms=Math.max(r.operations[name].max_success_gap_ms,ms-(r.operations[name].last_success_ms??0));r.operations[name].first_success_ms ??= ms;r.operations[name].last_success_ms=ms}catch(e){r.operations[name].errors++;const d=e.diagnostic||{status:null,code:'request_failed'};const key=String(d.status)+':'+d.code;r.operations[name].error_counts[key]=(r.operations[name].error_counts[key]||0)+1}r.operations[name].latency_ms.push(performance.now()-t);await sleep(Math.min(interval,Math.max(0,deadline-performance.now())))}}
    let rpc=0
    const sampler=async()=>{try { while(!stopping && performance.now()<deadline){const status=fs.readFileSync(`/proc/${server.pid}/status`,'utf8');const rss=Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1]);if(!Number.isFinite(rss))throw Error('rss_unavailable');r.samples.push({elapsed_ms:Math.round(performance.now()-started),rss_bytes:rss*1024,wal_bytes:fs.existsSync(dbPath+'-wal')?fs.statSync(dbPath+'-wal').size:0});await sleep(Math.min(30000,Math.max(0,deadline-performance.now())))}} catch { stopping=true; throw Error('sampling_failed') }}
    const outcomes = await Promise.allSettled([
      task('read',()=>call('/api/inventory/stocks',token),500),
      task('write',()=>call('/api/inventory/adjust',token,{...target,qty:1,direction:'in',reason:marker}),1000),
      task('mcp',()=>call('/mcp',agent,{jsonrpc:'2.0',id:++rpc,method:'tools/call',params:{name:'inventory.query_stock',arguments:{limit:5}}}),1000),
      task('backup',()=>command(['scripts/db-backup.mjs','cosmetic','--keep=2'],{...env,GML_RUNTIME_MODE:'production'},120000),60000),
      sampler()
    ])
    const rejected=outcomes.find(x=>x.status==='rejected');if(rejected)throw rejected.reason
    r.elapsed_ms=Math.round(performance.now()-started)
    for(const op of Object.values(r.operations))op.max_success_gap_ms=Math.max(op.max_success_gap_ms,r.elapsed_ms-(op.last_success_ms??0))
    server.kill('SIGTERM');const killTimer=setTimeout(()=>server.kill('SIGKILL'),10000);await closed;clearTimeout(killTimer)
    r.phase='verify'
    r.invariants=(await verifyInvariants(db)).ok
    const count=db.prepare("SELECT COUNT(*) n FROM inventory_transactions WHERE remark=? AND doc_type='ADJ_IN'").get(marker).n
    r.write_integrity=count===r.operations.write.success && Math.abs(stock()-before-count)<0.0001
    r.growth={rss_bytes:r.samples.at(-1).rss_bytes-r.samples[0].rss_bytes,wal_bytes:r.samples.at(-1).wal_bytes-r.samples[0].wal_bytes}
    r.ok=verdict(r)
  } catch(e) { r.failure=cancelRequested?'cancelled':failureCode(e) }
  finally {
    try {
    if(server && server.exitCode===null && server.signalCode===null){server.kill('SIGKILL');await closed.catch(()=>{})}
    if(db)try{db.close()}catch{r.ok=false;r.failure='cleanup_failed'}
    for(const op of Object.values(r.operations)){op.p50_ms=quantile(op.latency_ms,0.5);op.p95_ms=quantile(op.latency_ms,0.95);op.p99_ms=quantile(op.latency_ms,0.99);delete op.latency_ms}
    fs.writeFileSync(output,JSON.stringify(r,null,2)+'\n',{flag:'wx'})
    } finally {
      process.removeListener('SIGINT',cancel);process.removeListener('SIGTERM',cancel)
      fs.rmSync(dir,{recursive:true,force:true})
    }
  }
  if(!r.ok)throw Error('soak_failed')
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url))run().catch(e=>{console.error('Mixed soak failed: '+failureCode(e));process.exitCode=1})
