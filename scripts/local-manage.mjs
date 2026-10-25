/**
 * ============================================================================
 * 文件标识：scripts/local-manage.mjs | 跨平台本地安装、启动、诊断与一致性备份。
 * ============================================================================
 * 所有数据固定在**实例目录**内，不继承外部 GML_DB / GML_DATA_DIR / GML_JWT_SECRET。
 * 一个企业 = 一个实例目录 = 一份 data/ + 一份 .local/config.json（端口 + 签名密钥，0600）+ 一份 backups/。
 * 实例目录默认就是本代码副本的根（原行为不变）；要在同一份代码上跑第二个企业，用
 *   `GML_LOCAL_INSTANCE=/absolute/dir`（或 `--instance=/absolute/dir`，优先）+ `GML_LOCAL_PORT=<端口>`。
 * 相对路径一律拒绝（ADR-0001 / ADR-0019 同一口径）。代码副本里的 dist/ 与 node_modules 仍按 ROOT 找。
 */
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import { randomBytes } from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { assessDataSeparation } from './lib/data-separation.mjs'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const command = process.argv[2] || 'start'
const rawArgs = process.argv.slice(3)
const instanceArg = rawArgs.find(a => a.startsWith('--instance='))?.slice('--instance='.length)
const args = new Set(rawArgs.filter(a => !a.startsWith('--instance=')))
function instanceDir() {
  const requested = instanceArg ?? process.env.GML_LOCAL_INSTANCE
  if (requested === undefined || requested === '') return ROOT
  if (!path.isAbsolute(requested)) throw new Error('GML_LOCAL_INSTANCE / --instance must be an absolute directory path')
  return path.resolve(requested)
}
let INSTANCE
try { INSTANCE = instanceDir() } catch (error) { console.error(`[error] ${error.message}`); process.exit(1) }
const LOCAL = path.join(INSTANCE, '.local')
const CONFIG = path.join(LOCAL, 'config.json')
const DATA = path.join(INSTANCE, 'data')
const BACKUPS = path.join(INSTANCE, 'backups')
process.chdir(ROOT)

function run(executable, argv, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, { cwd: ROOT, stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited ${code}`)))
  })
}
function config() {
  fs.mkdirSync(LOCAL, { recursive: true, mode: 0o700 })
  if (!fs.existsSync(CONFIG)) {
    fs.writeFileSync(CONFIG, JSON.stringify({ port: 3001, jwtSecret: randomBytes(48).toString('hex') }, null, 2), { flag: 'wx', mode: 0o600 })
  }
  const value = JSON.parse(fs.readFileSync(CONFIG, 'utf8'))
  const port = Number(process.env.GML_LOCAL_PORT || value.port)
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Port must be an integer between 1024 and 65535')
  if (typeof value.jwtSecret !== 'string' || value.jwtSecret.length < 64) throw new Error('Invalid .local/config.json jwtSecret; restore the original configuration')
  return { ...value, port }
}
function nativeReady() {
  try {
    const dependencies = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).dependencies
    for (const name of Object.keys(dependencies)) require.resolve(name)
    const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.close(); return true
  } catch { return false }
}
async function setup() {
  if (Number(process.versions.node.split('.')[0]) !== 22) throw new Error('Please install Node.js 22.x LTS (including npm), then retry')
  if (fs.existsSync(path.join(ROOT, 'MANIFEST.json'))) await run(process.execPath, ['scripts/verify-release.mjs'])
  if (!nativeReady()) {
    console.log('[install] Installing locked runtime dependencies; internet access is required...')
    const argv = ['ci', '--omit=dev', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org']
    if (process.platform === 'win32') await run('npm.cmd', argv, { shell: true })
    else await run('npm', argv)
    if (!nativeReady()) throw new Error('SQLite native module failed to load; see the installation manual')
  }
  fs.mkdirSync(INSTANCE, { recursive: true, mode: 0o700 })
  config()
  fs.mkdirSync(DATA, { recursive: true })
  if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('Missing dist/index.html; developer: npm ci --include=dev && npm run build')
  console.log('[install] Ready. Start: node scripts/local-manage.mjs start')
}
async function freePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', error => reject(new Error(`Port ${port} unavailable (${error.code}). Set GML_LOCAL_PORT to another port. No existing service was stopped.`)))
    server.listen(port, '127.0.0.1', () => server.close(resolve))
  })
}
function openBrowser(url) {
  const exe = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open'
  const argv = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url]
  const browser = spawn(exe, argv, { stdio: 'ignore' })
  browser.on('error', () => console.log(`Open in your browser: ${url}`))
  browser.unref()
}
async function start() {
  await setup()
  const cfg = config()
  await freePort(cfg.port)
  const base = `http://127.0.0.1:${cfg.port}`
  console.log(`[start] Local access only: ${base}/login\n[start] Instance: ${INSTANCE}\n[start] Data: ${DATA}\n[start] Press Ctrl+C to stop.`)
  const child = spawn(process.execPath, ['server/index.js'], { cwd: ROOT, stdio: 'inherit', env: {
    ...process.env, NODE_ENV: 'production', HOST: '127.0.0.1', PORT: String(cfg.port),
    GML_DB: '', GML_DATA_DIR: DATA, GML_JWT_SECRET: cfg.jwtSecret, JWT_SECRET: ''
  } })
  let ended = false
  let stopping = false
  let ready = false
  const stop = () => { stopping = true; child.kill('SIGTERM') }
  process.once('SIGINT', stop)
  process.once('SIGTERM', stop)
  const completed = new Promise((resolve, reject) => {
    child.once('error', error => { ended = true; reject(error) })
    child.once('close', (code, signal) => { ended = true; resolve({ code, signal }) })
  })
  // 不用固定延迟打开页面：三库首次初始化完成、健康检查成功后才打开。
  const deadline = Date.now() + 180000
  while (!ended && !stopping && Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/meta/health`, { signal: AbortSignal.timeout(1500) })
      const body = await response.json()
      if (response.ok && body.data?.status === 'ok') { ready = true; break }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  if (ready) {
    console.log(`[ready] ${base}/login\n[manuals] ${base}/docs/install.html`)
    if (!args.has('--no-browser')) openBrowser(`${base}/login`)
  } else if (!ended && !stopping) { child.kill('SIGTERM'); console.error('[start] Health check timed out') }
  const result = await completed
  process.removeListener('SIGINT', stop)
  process.removeListener('SIGTERM', stop)
  if (!stopping && (!ready || result.code !== 0)) throw new Error(`Server stopped: ${result.code ?? result.signal}`)
}
async function backup() {
  if (!nativeReady()) throw new Error('Run setup before backup')
  if (!fs.existsSync(CONFIG)) throw new Error('No local configuration; run setup first')
  const files = fs.existsSync(DATA) ? fs.readdirSync(DATA).filter(name => /^gml_(cosmetic|food|apparel)\.db$/.test(name)) : []
  if (!files.length) throw new Error('No databases yet; start the system once before backing up')
  const dir = path.join(BACKUPS, new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomBytes(3).toString('hex'))
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const Database = require('better-sqlite3')
  for (const file of files) {
    const db = new Database(path.join(DATA, file), { readonly: true })
    try { await db.backup(path.join(dir, file)) } finally { db.close() }
  }
  fs.copyFileSync(CONFIG, path.join(dir, 'config.json'))
  fs.chmodSync(path.join(dir, 'config.json'), 0o600)
  console.log(`[backup] ${dir}\nKeep this private: it contains database contents and your signing secret. For cross-industry point-in-time consistency, stop the service before backup.`)
}
async function doctor() {
  const cfg = config()
  const result = { node: process.version, supportedNode: process.versions.node.startsWith('22.'), platform: process.platform,
    sqlite: nativeReady(), frontend: fs.existsSync(path.join(ROOT, 'dist/index.html')), instance: INSTANCE, dataDirectory: DATA, backupDirectory: BACKUPS, port: cfg.port,
    // AH5（ADR-0055 补充 4）：谁能直接写库——只报告，不改变退出码
    dataSeparation: assessDataSeparation({ dataDir: DATA }) }
  try { const response = await fetch(`http://127.0.0.1:${cfg.port}/api/meta/health`, { signal: AbortSignal.timeout(2000) }); result.health = await response.json() }
  catch { result.health = 'not running (normal before start)' }
  console.log(JSON.stringify(result, null, 2))
  if (!result.supportedNode || !result.sqlite || !result.frontend) process.exitCode = 1
}
try {
  if (!['setup', 'start', 'doctor', 'backup'].includes(command)) throw new Error('Usage: node scripts/local-manage.mjs setup|start|doctor|backup [--no-browser] [--instance=/absolute/dir]')
  await ({ setup, start, doctor, backup })[command]()
} catch (error) { console.error(`[error] ${error.message}`); process.exitCode = 1 }
