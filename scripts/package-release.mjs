/**
 * ============================================================================
 * 文件标识：scripts/package-release.mjs | 完整源码本地发行包。
 * ============================================================================
 * 不读取、不重建、不导出当前工作库；接收方首次启动生成独立的虚构样本。
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

run(['scripts/build-docs-wiki.mjs'])
if (!args.includes('--skip-build')) run(['node_modules/vite/bin/vite.js', 'build'])
if (!fs.existsSync(path.join(ROOT, 'dist/index.html'))) throw new Error('Build frontend first')
fs.mkdirSync(dest, { recursive: true })
const excluded = /(^|\/)(?:node_modules|\.git|\.local|backups|release|evidence|__pycache__)(\/|$)|(^|\/)\.env(?:\.|$)|\.db(?:-|$)|\.log$|\.DS_Store$|\.(?:mp4|mov|mp3|wav)$/i
function copy(relative, to = relative) {
  fs.cpSync(path.join(ROOT, relative), path.join(dest, to), { recursive: true, filter: source => {
    const rel = path.relative(ROOT, source).split(path.sep).join('/')
    return !excluded.test(rel) && !fs.lstatSync(source).isSymbolicLink()
  } })
}
for (const dir of ['src', 'server', 'scripts', 'public', 'dist', 'reusable']) copy(dir)
for (const file of ['package.json', 'package-lock.json', 'index.html', 'vite.config.ts', 'tsconfig.json',
  'tailwind.config.js', 'postcss.config.js', 'Dockerfile', 'docker-compose.yml', '.dockerignore', '.gitignore']) copy(file)
copy('docs/本地交付', 'docs/本地交付')
copy('public/docs', '手册')
const write = (file, content, mode = 0o644) => fs.writeFileSync(path.join(dest, file), content, { mode })
for (const [file, command] of [['install.command', 'setup'], ['start.command', 'start'], ['backup.command', 'backup']]) {
  write(file, `#!/bin/bash\ncd "$(dirname "$0")" || exit 1\nexport PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"\nif ! command -v node >/dev/null 2>&1; then\n  echo "Install Node.js 22.x LTS from https://nodejs.org first."\n  read -r -p "Press Enter to exit..."\n  exit 1\nfi\nnode scripts/local-manage.mjs ${command}\nresult=$?\nif [ "$result" -ne 0 ]; then read -r -p "Failed. Press Enter to exit..."; fi\nexit "$result"\n`, 0o755)
}
for (const [file, command] of [['install-windows.bat', 'setup'], ['start-windows.bat', 'start'], ['backup-windows.bat', 'backup']]) {
  write(file, `@echo off\r\ncd /d "%~dp0"\r\nwhere node >nul 2>nul\r\nif errorlevel 1 (\r\n echo Install Node.js 22.x LTS including npm from https://nodejs.org\r\n pause\r\n exit /b 1\r\n)\r\nnode scripts/local-manage.mjs ${command}\r\nset "RESULT=%ERRORLEVEL%"\r\nif not "%RESULT%"=="0" pause\r\nexit /b %RESULT%\r\n`)
}
const guide = `# 伴圆AI原生ERP 本地安装交付包\n\n版本日期 ${stamp}。包含当前完整前后端源码、预构建网页、测试脚本与手册。\n\n## 开始使用\n\n1. 完整解压到普通本地目录，不要在压缩包内运行。安装 Node.js 22.x LTS（含 npm）。\n2. macOS 双击 install.command，再双击 start.command。Windows 使用 install-windows.bat 和 start-windows.bat。\n3. Linux 运行 node scripts/local-manage.mjs setup，再运行 node scripts/local-manage.mjs start。\n4. 浏览器健康检查通过后自动打开 http://127.0.0.1:3001/login。管理员 admin / 12345。\n5. 停止：在启动窗口按 Ctrl+C。首次安装需要联网下载依赖，后续基础业务可离线运行。\n\n## 手册入口\n\n- 安装手册：手册/install.html（可离线双击打开）\n- 操作手册：手册/manual.html\n- 演示手册：手册/demo-flow.html\n- 开发与MCP接手：手册/dev.html\n- 可编辑原文：docs/本地交付/\n\n## 重要边界\n\n仅用于本地演示与方案验证，样本数据首次启动在本副本 data/ 内生成。不包含原机数据库、真实密钥、客户资料、Node运行时或 node_modules；不承诺完全离线首次安装。默认只监听本机。服装不在本次交付验收范围。外部大模型服务及真实支付、短信、IM、ERP连接器需单独配置和验证。默认账号不能直接暴露公网。\n\n## 完整性\n\nnode scripts/verify-release.mjs 校验源码与构建产物。MANIFEST.json 记录逐文件 SHA256。自身修改源码后，使用开发启动方式并重新构建；重新分发前重新打包生成清单。\n\n## 权属\n\n交付源码供接收方安装和经授权维护，不自动赋予开源或再分发许可；第三方依赖遵循各自许可。\n`
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
let head = 'unavailable'
try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim() } catch {}
write('MANIFEST.json', JSON.stringify({ product: 'Banyuan ERP', version: JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version, builtAt: new Date().toISOString(), baseCommit: head,
  includesUncommittedFixes: true, node: '22.x', data: 'generated on first launch; no source database copied', files }, null, 2))
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
