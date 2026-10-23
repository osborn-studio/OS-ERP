/**
 * ============================================================================
 * 文件标识：scripts/package-release.mjs | 完整源码本地发行包。
 * ============================================================================
 * 不读取、不重建、不导出当前工作库。生产默认：接收方用 bootstrap-admin 建立首个管理员，不生成样本数据；
 * 演示样本仅在显式 GML_RUNTIME_MODE=demo 时出现。
 * 选项：--output=<dir>、--skip-build（复用现有 dist/）、--skip-docs（不重建网页手册；仅供 tests/release-package.test.mjs 的最小包使用）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { zipSync } from 'fflate'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const stamp = new Date().toISOString().slice(0, 10).replaceAll('-', '')
const args = process.argv.slice(2)
const outArg = args.find(arg => arg.startsWith('--output='))
const output = path.resolve(outArg?.slice(9) || path.join(ROOT, 'release'))
const name = `BanyuanERP-Local-${stamp}-${Date.now().toString().slice(-6)}`
const dest = path.join(output, name)
const run = argv => execFileSync(process.execPath, argv, { cwd: ROOT, stdio: 'inherit' })

// 变更记录必须与 ADR 同步（漂移即拒绝出包）；SBOM 由锁文件现场生成并随包交付。
run(['scripts/gen-changelog.mjs', '--check'])
if (!args.includes('--skip-docs')) run(['scripts/build-docs-wiki.mjs'])
if (!args.includes('--skip-build')) run(['node_modules/vite/bin/vite.js', 'build'])
if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('Build frontend first')
fs.mkdirSync(dest, { recursive: true })
const excluded = /(^|\/)(?:node_modules|\.git|\.local|backups|release|evidence|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|\.(?:db|db3|sqlite3?)(?:-|\.|$)|\.log$|\.DS_Store$|\.(?:mp4|mov|mp3|wav)$/i
function copy(relative, to = relative) {
  fs.cpSync(path.join(ROOT, relative), path.join(dest, to), { recursive: true, filter: source => {
    const rel = path.relative(ROOT, source).split(path.sep).join('/')
    return !excluded.test(rel) && !fs.lstatSync(source).isSymbolicLink()
  } })
}
for (const dir of ['src', 'server', 'scripts', 'public', 'dist', 'reusable']) copy(dir)
for (const file of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
  'tailwind.config.js', 'postcss.config.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'CHANGELOG.md']) copy(file)
fs.mkdirSync(path.join(dest, 'release'), { recursive: true })
run(['scripts/gen-sbom.mjs', '--out', path.join(dest, 'release/sbom.cdx.json')])
copy('docs/本地交付', 'docs/本地交付')
copy('public/docs', '手册')
const write = (file, content, mode = 0o644) => fs.writeFileSync(path.join(dest, file), content, { mode })
for (const [file, command] of [['install.command', 'setup'], ['start.command', 'start'], ['backup.command', 'backup']]) {
  write(file, `#!/bin/bash\ncd "$(dirname "$0")" || exit 1\nexport PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"\nif ! command -v node >/dev/null 2>&1; then\n  echo "Install Node.js 22.x LTS from https://nodejs.org first."\n  read -r -p "Press Enter to exit..."\n  exit 1\nfi\nnode scripts/local-manage.mjs ${command}\nresult=$?\nif [ "$result" -ne 0 ]; then read -r -p "Failed. Press Enter to exit..."; fi\nexit "$result"\n`, 0o755)
}
for (const [file, command] of [['install-windows.bat', 'setup'], ['start-windows.bat', 'start'], ['backup-windows.bat', 'backup']]) {
  write(file, `@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n echo Install Node.js 22.x LTS including npm from https://nodejs.org\r\n pause\r\n exit /b 1\r\n)\r\nnode scripts/local-manage.mjs ${command}\r\nset "RESULT=%ERRORLEVEL%"\r\nif not "%RESULT%"=="0" pause\r\nexit /b %RESULT%\r\n`)
}
const guide = `# 伴圆AI原生ERP 本地安装交付包

版本日期 ${stamp}。包含当前完整前后端源码、预构建网页、测试脚本与手册。默认**生产模式**：不含也不生成任何样本数据或默认账号。

## 开始使用（单企业单实例）

1. 完整解压到普通本地目录，不要在压缩包内运行。安装 Node.js 22.x LTS（含 npm）。
2. 选一个**绝对路径**的实例目录（数据、密钥、备份都在里面，建议放在代码目录之外），例如 /srv/os-erp-instance。
3. 安装：node scripts/local-manage.mjs setup --instance=/srv/os-erp-instance（首次需要联网下载依赖）。
4. 建立首个管理员（密码只能经 stdin 管道传入，不要写进命令行或环境变量，规则见手册）：
   GML_RUNTIME_MODE=production GML_DATA_DIR=/srv/os-erp-instance/data GML_DB= node scripts/bootstrap-admin.mjs --industry=cosmetic --company-code=<编码> --company-name=<企业名> --username=<账号> --name=<姓名>
5. 启动：node scripts/local-manage.mjs start --instance=/srv/os-erp-instance，用第 4 步的账号登录 http://127.0.0.1:3001/login（端口见实例目录 .local/config.json）。
6. 备份：node scripts/local-manage.mjs backup --instance=...；恢复演练：scripts/db-restore-drill.mjs（见手册）。

停止：在启动窗口按 Ctrl+C。macOS/Windows 的 .command/.bat 双击入口使用代码目录作为实例目录，仍需先完成第 4 步。

## 手册入口

- 安装手册：手册/install.html（可离线双击打开）
- 操作手册：手册/manual.html
- 演示手册：手册/demo-flow.html（仅演示模式）
- 开发与MCP接手：手册/dev.html
- 可编辑原文：docs/本地交付/

## 重要边界

生产模式下未验收的网络能力（公开商城、奇门/OMS 模拟、IM 同步、Agent 工具）返回 503 FEATURE_DISABLED。包内保留的演示数据生成代码只在显式 GML_RUNTIME_MODE=demo 时运行，仅用于方案演示，演示账号不得用于生产或暴露公网。不包含原机数据库、真实密钥、客户资料、Node运行时或 node_modules；不承诺完全离线首次安装。默认只监听本机。服装不在本次交付验收范围。外部大模型服务及真实支付、短信、IM、ERP连接器需单独配置和验证。

## 完整性与来源

node scripts/verify-release.mjs 校验源码与构建产物（MANIFEST.json 记录逐文件 SHA256，并含 baseCommit、THIRD_PARTY_NOTICES.md、CHANGELOG.md 与 release/sbom.cdx.json，后者必须是可解析的 CycloneDX）。健康检查 /api/meta/health 返回的 build_sha 即 baseCommit。自身修改源码后，使用开发启动方式并重新构建；重新分发前重新打包生成清单。

## 权属

许可证见 LICENSE，第三方声明见 THIRD_PARTY_NOTICES.md，运行时依赖清单（CycloneDX SBOM）见 release/sbom.cdx.json，变更记录见 CHANGELOG.md（由 ADR 生成，不代表验收结论）。
`
write('00_先读我.md', guide)
write('README.md', guide)
const files = {}
function hashDir(dir, prefix = '') {
  for (const item of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const rel = prefix ? `${prefix}/${item.name}` : item.name
    if (item.isDirectory()) hashDir(path.join(dir, item.name), rel)
    else files[rel] = createHash('sha256').update(fs.readFileSync(path.join(dir, item.name))).digest('hex')
  }
}
hashDir(dest)
let head = ''
let dirty = true
try {
  head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
  dirty = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim().length > 0
} catch {}
// 发行包必须可追溯到一个提交：没有 git 提交就拒绝出包，而不是写 'unavailable'。
if (!/^[0-9a-f]{7,64}$/.test(head)) throw new Error('Cannot determine git HEAD; refusing to build a release without baseCommit')
write('MANIFEST.json', JSON.stringify({ product: 'Banyuan ERP', version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, builtAt: new Date().toISOString(), baseCommit: head,
  includesUncommittedFixes: dirty, node: '22.x', data: 'none shipped; production instance is bootstrapped by the recipient (scripts/bootstrap-admin.mjs)', files }, null, 2))
// fflate 写入标准 UTF-8 文件名，避免 macOS 系统 zip 未设置编码位导致 Windows 解压乱码。
const archiveEntries = {}
for (const relative of [...Object.keys(files), 'MANIFEST.json']) {
  const target = path.join(dest, relative)
  const stat = fs.statSync(target)
  archiveEntries[`${name}/${relative}`] = [fs.readFileSync(target), { os: 3, attrs: (stat.mode & 0xffff) << 16, mtime: stat.mtime }]
}
fs.writeFileSync(`${dest}.zip`, zipSync(archiveEntries, { level: 6 }))
const zipHash = createHash('sha256').update(fs.readFileSync(`${dest}.zip`)).digest('hex')
fs.writeFileSync(`${dest}.zip.sha256`, `${zipHash}  ${name}.zip\n`)
console.log(JSON.stringify({ folder: dest, archive: `${dest}.zip`, sha256: zipHash, files: Object.keys(files).length }, null, 2))
