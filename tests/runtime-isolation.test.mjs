import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { runtimeMode, requireDataDirectory } from '../server/runtime.js'
import { jwtSecretPosture, PUBLIC_DEFAULT_SECRETS } from '../server/middleware/auth.js'
import { classifyEmptyDatabase } from '../server/db/runtime-policy.js'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const prodBoot = "const {bootAll}=await import('./server/db/production-boot.js');bootAll()"
const satelliteSeeds = [
  ['ar', 'seedAr'], ['demo', 'seedPosHistory'], ['demo', 'seedPartialFlows'], ['dms', 'seedDms'],
  ['finance', 'seedFinance'], ['invoice', 'seedInvoice'], ['mfg', 'seedManufacture'],
  ['oc', 'seedOrderCenter'], ['org', 'seedOrgs'], ['pos', 'seedPos'], ['pricing', 'seedPricing'],
  ['procure', 'seedProcurement'], ['promo', 'seedPromo'], ['qc', 'seedQc'], ['quote', 'seedQuoteCredit'],
  ['refund', 'seedRefund'], ['report', 'seedReport']
].map(([file, name]) => [`./server/db/${file}-seed.js`, name])
satelliteSeeds.push(['./server/mcp/tokens.js', 'ensureDemoTokens'])
function fixture(t) {
  const dir = mkdtempSync(path.join(tmpdir(), 'os-egp-runtime-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
function run(dir, source, mode, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_DATA_DIR: dir, GML_DB: '', ...extra }
  if (mode !== undefined) env.GML_RUNTIME_MODE = mode
  return spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024
  })
}
function success(result) {
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
}
function rejection(result, code) {
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, new RegExp(code))
}
function open(dir) { return new Database(path.join(dir, 'gml_cosmetic.db')) }
function sentinel(dir) {
  const db = open(dir)
  db.exec("CREATE TABLE keep_customer_data (value TEXT); INSERT INTO keep_customer_data VALUES ('retain-me')")
  db.close()
}
function retained(dir) {
  const db = open(dir)
  assert.equal(db.prepare('SELECT value FROM keep_customer_data').get().value, 'retain-me')
  db.close()
}

test('safe defaults and explicit absolute data path', () => {
  assert.equal(runtimeMode({}), 'production')
  assert.throws(() => runtimeMode({ GML_RUNTIME_MODE: 'prod' }), { code: 'RUNTIME_MODE_INVALID' })
  for (const env of [{}, { GML_DATA_DIR: 'data' }]) {
    assert.throws(() => requireDataDirectory(env), { code: 'DATA_DIRECTORY_REQUIRED' })
  }
})

test('production secret policy cannot be disabled by an absent or non-production NODE_ENV', () => {
  for (const mode of [undefined, 'production']) {
    for (const nodeEnv of [undefined, 'development', 'test', 'prod']) {
      for (const secret of [undefined, ...PUBLIC_DEFAULT_SECRETS]) {
        const env = { NODE_ENV: nodeEnv, GML_JWT_SECRET: secret }
        if (mode !== undefined) env.GML_RUNTIME_MODE = mode
        assert.equal(jwtSecretPosture(env).level, 'fatal', `${mode}/${nodeEnv}`)
      }
    }
  }
  for (const mode of ['demo', 'test']) {
    assert.equal(jwtSecretPosture({ GML_RUNTIME_MODE: mode }).level, 'warn')
    assert.equal(jwtSecretPosture({ GML_RUNTIME_MODE: mode, NODE_ENV: 'production' }).level, 'fatal')
  }
})

test('actual server refuses missing or public secret before listening or creating data', t => {
  const dir = fixture(t)
  for (const mode of [undefined, 'production']) {
    for (const nodeEnv of [undefined, 'development', 'test']) {
      for (const secret of [undefined, PUBLIC_DEFAULT_SECRETS[0]]) {
        const extra = { HOST: '127.0.0.1', PORT: '0' }
        if (nodeEnv !== undefined) extra.NODE_ENV = nodeEnv
        if (secret !== undefined) extra.GML_JWT_SECRET = secret
        const result = run(dir, "await import('./server/index.js')", mode, extra)
        rejection(result, 'JWT_SECRET_MISSING_IN_PRODUCTION')
        assert.doesNotMatch(result.stdout, /服务已启动/)
        assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
      }
    }
  }
})

test('missing data directory fails before creating a database', t => {
  const dir = fixture(t)
  rejection(run(dir, prodBoot, undefined, { GML_DATA_DIR: '' }), 'DATA_DIRECTORY_REQUIRED')
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
})

test('fresh production boot creates schema but no demo business rows or credentials; restart preserves data', t => {
  const dir = fixture(t)
  success(run(dir, prodBoot))
  for (const code of ['cosmetic', 'food', 'apparel']) {
    const db = new Database(path.join(dir, `gml_${code}.db`))
    for (const table of ['users', 'products', 'sales_orders', 'purchase_orders', 'agent_tokens']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0, `${code}.${table}`)
    }
    assert.equal(db.prepare('SELECT mode FROM os_egp_runtime').get().mode, 'production')
    db.close()
  }
  sentinel(dir)
  success(run(dir, prodBoot))
  retained(dir)
})

test('direct seed/reset and demo boot reject production before changing business data', t => {
  const dir = fixture(t)
  success(run(dir, prodBoot))
  sentinel(dir)
  for (const call of ['resetDatabase()', 'seedAll()']) {
    rejection(run(dir, `const {resetDatabase,seedAll}=await import('./server/db/seed.js');${call}`), 'DEMO_OPERATION_FORBIDDEN')
    retained(dir)
  }
  rejection(run(dir, "const {bootAll}=await import('./server/db/boot.js');bootAll({force:true})"), 'DEMO_OPERATION_FORBIDDEN')
  retained(dir)
})

test('changing environment to demo/test cannot reclassify production data', t => {
  const dir = fixture(t)
  success(run(dir, prodBoot))
  sentinel(dir)
  for (const mode of ['demo', 'test']) {
    rejection(run(dir, "const {resetDatabase}=await import('./server/db/seed.js');resetDatabase()", mode), 'DATABASE_MODE_MISMATCH')
    retained(dir)
  }
})

test('every public satellite seed and demo credential helper rejects production handles before writing', t => {
  const dir = fixture(t)
  success(run(dir, prodBoot))
  success(run(dir, `
    import assert from 'node:assert/strict';
    const {getDb}=await import('./server/db/index.js');const db=getDb();
    const before=db.serialize();
    for(const [file,name] of ${JSON.stringify(satelliteSeeds)}) {
      const module=await import(file);
      assert.throws(()=>module[name](db),{code:'DEMO_OPERATION_FORBIDDEN'},name);
    }
    for(const mode of ['demo','test']) {
      process.env.GML_RUNTIME_MODE=mode;
      for(const [file,name] of ${JSON.stringify(satelliteSeeds)}) {
        const module=await import(file);
        assert.throws(()=>module[name](db),{code:'DATABASE_MODE_MISMATCH'},name);
      }
    }
    assert.deepEqual(db.serialize(),before,'no seed may change any production database bytes');
  `))
})

test('seed-orgs CLI rejects production before schema or business writes', t => {
  const dir = fixture(t)
  const result = spawnSync(process.execPath, ['scripts/seed-orgs.mjs'], {
    cwd: ROOT, env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_DATA_DIR: dir, GML_DB: '' },
    encoding: 'utf8', timeout: 10000
  })
  rejection(result, 'DEMO_OPERATION_FORBIDDEN')
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
})

test('a caller whose filename ends in seed.js does not accidentally invoke direct seed CLI', t => {
  const dir = fixture(t)
  success(run(dir, "process.argv[1]='/tmp/another-seed.js';await import('./server/db/seed.js')", 'test'))
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
})

test('unclassified existing database is refused and preserved', t => {
  const dir = fixture(t)
  sentinel(dir)
  for (const mode of ['production', 'demo', 'test']) {
    rejection(run(dir, "const {getDb}=await import('./server/db/index.js');getDb()", mode), 'DATABASE_UNCLASSIFIED')
    retained(dir)
  }
  const db = open(dir)
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name='os_egp_runtime'").get().n, 0)
  db.close()
})

test('test database supports seed and reset while retaining its classification', t => {
  const dir = fixture(t)
  success(run(dir, `
    const {initSchema,getDb}=await import('./server/db/index.js');initSchema();
    const {seedAll,resetDatabase}=await import('./server/db/seed.js');seedAll();
    if(getDb().prepare('SELECT count(*) AS n FROM users').get().n===0) throw Error('seed failed');
    resetDatabase();initSchema();
    if(getDb().prepare('SELECT mode FROM os_egp_runtime').get().mode!=='test') throw Error('classification lost');
  `, 'test'))
  rejection(run(dir, prodBoot), 'DATABASE_MODE_MISMATCH')
})

test('corrupt database fails closed without replacement', t => {
  const dir = fixture(t)
  const file = path.join(dir, 'gml_cosmetic.db')
  const bytes = Buffer.from('not a database; retain this evidence')
  writeFileSync(file, bytes)
  assert.notEqual(run(dir, prodBoot).status, 0)
  assert.deepEqual(readFileSync(file), bytes)
})

test('view-only databases and missing/invalid classification rows fail closed', () => {
  for (const ddl of [
    'CREATE VIEW legacy_view AS SELECT 1 AS old_value',
    'CREATE TABLE os_egp_runtime (id INTEGER PRIMARY KEY, mode TEXT)',
    "CREATE TABLE os_egp_runtime (id INTEGER PRIMARY KEY, mode TEXT); INSERT INTO os_egp_runtime VALUES(1,'unknown')"
  ]) {
    const db = new Database(':memory:')
    try {
      db.exec(ddl)
      const before = db.serialize()
      assert.throws(() => classifyEmptyDatabase(db, 'production'))
      assert.deepEqual(db.serialize(), before)
    } finally { db.close() }
  }
})

test('competing processes cannot classify one empty database into two runtime modes', { timeout: 15000 }, async t => {
  const dir = fixture(t)
  const file = path.join(dir, 'competing.db')
  const children = ['production', 'demo'].map(mode => {
    const source = `
      import Database from 'better-sqlite3';
      import {once} from 'node:events';
      import {classifyEmptyDatabase} from './server/db/runtime-policy.js';
      const db=new Database(${JSON.stringify(file)});
      const start=once(process,'message');process.send('ready');await start;
      try {classifyEmptyDatabase(db,${JSON.stringify(mode)})}
      catch(error) {console.error(error.code);process.exitCode=1}
      finally {db.close();process.disconnect()}
    `
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      cwd: ROOT, env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    let error = ''
    child.stderr.on('data', data => { error += data.toString() })
    t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
    return { mode, child, ready: once(child, 'message'), closed: once(child, 'close'), error: () => error }
  })
  await Promise.all(children.map(x => x.ready))
  for (const item of children) item.child.send('start')
  const results = await Promise.all(children.map(async x => ({ ...x, status: (await x.closed)[0] })))
  const winners = results.filter(x => x.status === 0)
  assert.equal(winners.length, 1)
  const loser = results.find(x => x.status !== 0)
  assert.match(loser.error(), /DATABASE_MODE_MISMATCH/)
  const db = new Database(file)
  try { assert.equal(db.prepare('SELECT mode FROM os_egp_runtime').get().mode, winners[0].mode) }
  finally { db.close() }
})

test('cached connection rejects runtime or data directory changes', t => {
  const dir = fixture(t)
  success(run(dir, `
    import assert from 'node:assert/strict';
    const {getDb}=await import('./server/db/index.js');getDb();
    process.env.GML_RUNTIME_MODE='demo';
    assert.throws(()=>getDb(),{code:'DATABASE_MODE_MISMATCH'});
    process.env.GML_RUNTIME_MODE='production';process.env.GML_DATA_DIR+='/other';
    assert.throws(()=>getDb(),{code:'DATA_DIRECTORY_CHANGED'});
  `))
})

test('production bootstrap rejects force/reset option', t => {
  const dir = fixture(t)
  rejection(run(dir, "const {bootAll}=await import('./server/db/production-boot.js');bootAll({force:true})"), 'PRODUCTION_BOOT_INVALID')
  assert.equal(existsSync(path.join(dir, 'gml_cosmetic.db')), false)
})

test('actual HTTP entrypoint defaults to production and leaves empty business tables', { timeout: 30000 }, async t => {
  const dir = fixture(t)
  const probe = net.createServer()
  probe.listen(0, '127.0.0.1')
  await once(probe, 'listening')
  const port = probe.address().port
  await new Promise(resolve => probe.close(resolve))
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: ROOT,
    env: { PATH: process.env.PATH, HOME: dir, TMPDIR: dir, GML_DATA_DIR: dir, GML_DB: '',
      HOST: '127.0.0.1', PORT: String(port), NODE_ENV: 'production', GML_JWT_SECRET: randomBytes(32).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let output = ''
  child.stdout.on('data', data => { output += data.toString() })
  child.stderr.on('data', () => {})
  const stopped = once(child, 'close')
  try {
    for (let i = 0; i < 200 && !output.includes('服务已启动') && child.exitCode === null; i++) await delay(50)
    assert.ok(output.includes('服务已启动'), 'production server must become ready')
    const response = await fetch(`http://127.0.0.1:${port}/api`, { signal: AbortSignal.timeout(2000) })
    assert.equal(response.status, 200)
    const db = open(dir)
    for (const table of ['users', 'products', 'agent_tokens']) {
      assert.equal(db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n, 0)
    }
    db.close()
    assert.doesNotMatch(output, /正在生成演示数据|已签发 MCP Agent Token/)
  } finally {
    if (child.exitCode === null) child.kill('SIGTERM')
    await stopped
  }
})
