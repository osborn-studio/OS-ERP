/**
 * ============================================================================
 * 文件标识：scripts/build-docs-wiki.mjs ｜ 把交付手册（MD）编译成站内 Wiki 页
 * ============================================================================
 * 【职责】把 `docs/演示手册_*.md` 与 `docs/操作手册_*.md` 编译成 `public/docs/*.html`
 *
 * 【为什么要有这一步】
 *   文档要能"在系统里点开看"，而不是发一个 Word 让客户自己找。
 *   客户口径（2026-10-17）：「最后再主页上做一个链接……点开后类似一个 wiki 东西」。
 *   ⇒ 所以产出是**带左侧目录 + 搜索**的静态页，由 Express 的静态目录直接托管。
 *
 * 【为什么自己写一个极简 Markdown 渲染，而不是装一个库】
 *   1) 只支持这两份文档实际用到的语法（标题 / 表格 / 代码块 / 列表 / 引用 / 行内样式），
 *      不需要完整 CommonMark；
 *   2) 依赖越多，离线安装包越大（本系统要能"拿到就装"，能少一个 npm 包就少一个）；
 *   3) 渲染规则集中在本文件，出问题只有一处要改。
 *
 * 【改它要注意】
 *   · 标题锚点用 GitHub 风格 slug（中文保留、空格转 `-`、其余标点去掉），
 *     因为文档正文里的目录链接就是按这个规则写的 —— 改了锚点规则，目录会全断；
 *   · 生成的 HTML **要提交进仓库**（`public/docs/`）：部署时不跑构建也能看；
 *   · 文档改了记得重跑：`npm run docs:build`。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 源文档 → 输出页。标题写在这里，页面自报家门时用它。 */
const DOCS = [
  {
    src: 'docs/本地交付/03_演示手册.md',
    out: 'public/docs/demo-flow.html',
    title: '完整演示手册',
    tag: '演示剧本',
    desc: '按角色排的演示顺序：先讲什么、后讲什么、每一步点哪里'
  },
  {
    src: 'docs/本地交付/04_开发与MCP接手.md',
    out: 'public/docs/dev.html',
    title: '开发说明手册',
    tag: '开发文档',
    desc: '面向程序员的接手手册：架构分层、目录职责、单据内核、改造任务清单'
  },
  {
    src: 'docs/本地交付/02_操作手册.md',
    out: 'public/docs/manual.html',
    title: '功能模块操作手册',
    tag: '操作手册',
    desc: '按模块排：每个页面回答什么问题、字段什么含义、状态怎么流转'
  },
  {
    src: 'docs/本地交付/01_安装手册.md',
    out: 'public/docs/install.html',
    title: '本地安装手册',
    tag: '安装维护',
    desc: '环境准备、安装启动、备份恢复与故障排查'
  },
  {
    src: 'docs/本地交付/06_依赖安全说明.md',
    out: 'public/docs/security.html',
    title: '依赖安全说明',
    tag: '安全状态',
    desc: '已修复依赖、剩余高危告警及运行限制'
  }
]

/** 转义 HTML（正文与代码块都要过；属性场景额外转引号） */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** GitHub 风格 slug：中文保留、空格转 -、其余标点去掉 */
function slug(text) {
  return String(text)
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^\w\u4e00-\u9fa5-]/g, '')
}

/** 行内：`code` / **bold** / [text](url) / ~~del~~ */
function inline(s) {
  let out = esc(s)
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>')
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>')
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (m, t, href) => `<a href="${href}">${t}</a>`)
  return out
}

/** 把表格的一段行渲染成 <table> */
function renderTable(rows) {
  const cells = (line) =>
    line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim())
  const head = cells(rows[0])
  const body = rows.slice(2).map(cells)
  const th = head.map((h) => `<th>${inline(h)}</th>`).join('')
  const tb = body
    .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
    .join('\n')
  return `<div class="table-wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`
}

/**
 * 渲染 Markdown → { html, toc }
 * toc 只取 h2 / h3（h1 是文档标题，h4 太细，进目录会喧宾夺主）
 */
function render(md) {
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  const out = []
  const toc = []
  let i = 0
  let inCode = false
  let codeBuf = []
  let listType = null // 'ul' | 'ol'
  let listBuf = []

  const flushList = () => {
    if (!listType) return
    out.push(`<${listType}>${listBuf.join('')}</${listType}>`)
    listType = null
    listBuf = []
  }

  while (i < lines.length) {
    const raw = lines[i]
    const line = raw.trimEnd()

    // 代码块
    if (/^```/.test(line)) {
      if (!inCode) {
        flushList()
        inCode = true
        codeBuf = []
      } else {
        out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
        inCode = false
      }
      i += 1
      continue
    }
    if (inCode) {
      codeBuf.push(raw)
      i += 1
      continue
    }

    // 空行
    if (!line.trim()) {
      flushList()
      i += 1
      continue
    }

    // 表格：当前行以 | 开头，且下一行是分隔行
    // ⚠️ 分隔行的字符类必须写成 `[\s:|-]` —— 写成 `[\s:-|]` 会被 JS 解析成区间 `:`..`|`（58~124），
    //    连字符（45）不在区间内，于是 `|---|` 永远匹配不上，表格整张退化成段落。
    if (/^\|/.test(line) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
      flushList()
      const rows = []
      while (i < lines.length && /^\|/.test(lines[i].trim())) {
        rows.push(lines[i])
        i += 1
      }
      out.push(renderTable(rows))
      continue
    }

    // 标题
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flushList()
      const level = h[1].length
      const text = h[2].trim()
      const id = slug(text)
      if (level <= 3) toc.push({ level, text, id })
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`)
      i += 1
      continue
    }

    // 分隔线
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      flushList()
      out.push('<hr />')
      i += 1
      continue
    }

    // 引用
    if (/^>\s?/.test(line)) {
      flushList()
      const buf = []
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''))
        i += 1
      }
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`)
      continue
    }

    // 列表
    const ul = /^[-*]\s+(.*)$/.exec(line)
    const ol = /^(\d+)\.\s+(.*)$/.exec(line)
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol'
      if (listType && listType !== want) flushList()
      listType = want
      const text = ul ? ul[1] : ol[2]
      listBuf.push(`<li>${inline(text)}</li>`)
      i += 1
      continue
    }

    // 段落
    flushList()
    out.push(`<p>${inline(line.trim())}</p>`)
    i += 1
  }
  flushList()
  if (inCode) out.push(`<pre><code>${esc(codeBuf.join('\n'))}</code></pre>`)
  return { html: out.join('\n'), toc }
}

/** 整页外壳：左目录 + 右侧正文 + 顶部搜索（纯前端过滤，不联网） */
function page(doc, html, toc) {
  // 二级 + 三级混排（三级缩进），且三级只挂到它所属的二级下面 ——
  let cursor = -1
  const tocTree = toc
    .map((t, idx) => ({ ...t, idx }))
    .filter((t) => t.level === 2 || t.level === 3)
    .map((t) => {
      if (t.level === 2) {
        cursor = t.idx
        return `<a class="toc-l2" data-depth="2" href="#${t.id}">${esc(t.text)}</a>`
      }
      if (t.idx < cursor) return ''
      return `<a class="toc-l3" data-depth="3" href="#${t.id}">${esc(t.text)}</a>`
    })
    .join('\n')

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${esc(doc.title)} · 伴圆AI原生ERP系统</title>
<meta name="description" content="${esc(doc.desc)}" />
<style>
  :root{
    --brand:#185fa5; --brand-600:#2b82c9; --tech:#06b6d4;
    --ink-900:#0f172a; --ink-700:#334155; --ink-500:#64748b; --ink-300:#cbd5e1;
    --bg:#f6f9fc; --line:#e2e8f0;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink-900);
    font:15px/1.75 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",system-ui,sans-serif}
  a{color:var(--brand);text-decoration:none}
  a:hover{text-decoration:underline}
  header.top{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.92);
    backdrop-filter:saturate(180%) blur(8px);border-bottom:1px solid var(--line)}
  .top-in{max-width:1280px;margin:0 auto;padding:10px 20px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
  .logo{width:30px;height:30px;border-radius:8px;color:#fff;display:flex;align-items:center;justify-content:center;
    font-weight:600;font-size:14px;background:linear-gradient(135deg,#185fa5 0%,#2b82c9 58%,#06b6d4 100%);
    box-shadow:0 6px 16px rgba(24,95,165,.28)}
  .brand{font-size:14.5px;font-weight:600}
  .brand small{display:block;font-weight:400;font-size:11.5px;color:var(--ink-500)}
  .tag{font-size:11px;padding:1px 7px;border-radius:999px;border:1px solid var(--line);color:var(--brand);
    background:#eff6fd}
  .spacer{flex:1}
  .back{font-size:12.5px;color:var(--ink-500)}
  .back:hover{color:var(--brand)}
  .search{width:220px;border:1px solid var(--line);border-radius:8px;padding:6px 10px;font-size:13px;
    outline:none;background:#fff}
  .search:focus{border-color:var(--brand-600);box-shadow:0 0 0 3px rgba(43,130,201,.12)}
  .wrap{max-width:1280px;margin:0 auto;padding:20px;display:grid;grid-template-columns:270px minmax(0,1fr);gap:24px;align-items:start}
  nav.toc{position:sticky;top:76px;max-height:calc(100vh - 96px);overflow:auto;
    background:#fff;border:1px solid var(--line);border-radius:12px;padding:12px 10px}
  nav.toc .t{font-size:11.5px;letter-spacing:.08em;color:var(--ink-500);padding:0 8px 8px}
  nav.toc a{display:block;padding:4px 8px;border-radius:7px;font-size:13px;color:var(--ink-700);line-height:1.5}
  nav.toc a.toc-l3{font-size:12.3px;color:var(--ink-500);padding-left:20px}
  nav.toc a:hover{background:#f1f6fc;color:var(--brand);text-decoration:none}
  nav.toc a.active{background:#e8f2fd;color:var(--brand);font-weight:600}
  main{background:#fff;border:1px solid var(--line);border-radius:14px;padding:28px 34px;min-width:0;
    box-shadow:0 1px 2px rgba(15,23,42,.04)}
  main h1{font-size:26px;line-height:1.35;margin:0 0 6px}
  main h2{font-size:19px;margin:34px 0 10px;padding-top:14px;border-top:1px solid var(--line)}
  main h2:first-of-type{border-top:0;padding-top:0;margin-top:22px}
  main h3{font-size:15.5px;margin:22px 0 8px;color:#0b3d68}
  main h4{font-size:14px;margin:18px 0 6px;color:var(--ink-700)}
  main p{margin:9px 0;color:#1e293b}
  main ul,main ol{margin:8px 0 8px 4px;padding-left:20px}
  main li{margin:3px 0}
  main blockquote{margin:12px 0;padding:10px 14px;background:#f3f8fe;border-left:3px solid var(--brand-600);
    border-radius:0 8px 8px 0;color:#0b3d68}
  main blockquote p{margin:0;color:inherit}
  main code{background:#f1f5f9;border:1px solid #e2e8f0;border-radius:5px;padding:1px 5px;font-size:12.5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
  main pre{background:#0f2032;color:#dbeafe;border-radius:10px;padding:14px 16px;overflow:auto;font-size:12.5px;line-height:1.6}
  main pre code{background:none;border:0;color:inherit;padding:0}
  main hr{border:0;border-top:1px solid var(--line);margin:26px 0}
  .table-wrap{overflow:auto;margin:12px 0;border:1px solid var(--line);border-radius:10px}
  table{border-collapse:collapse;width:100%;font-size:13px}
  th,td{border-bottom:1px solid var(--line);padding:7px 10px;text-align:left;vertical-align:top}
  th{background:#f7fafc;color:var(--ink-700);font-weight:600;white-space:nowrap}
  tr:last-child td{border-bottom:0}
  tbody tr:hover{background:#fbfdff}
  .foot{max-width:1280px;margin:0 auto;padding:0 20px 40px;color:var(--ink-500);font-size:12px}
  @media print{
    header.top,nav.toc,.foot{display:none}
    body{background:#fff;font-size:11pt}
    .wrap{display:block;padding:0}
    main{border:0;border-radius:0;box-shadow:none;padding:0}
    pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f3f4f6!important;color:#111!important}
    pre code{color:#111!important}
    h2,h3{break-after:avoid}
    tr{break-inside:avoid}
    .table-wrap{overflow:visible}
  }
  @media (max-width:1000px){
    .wrap{grid-template-columns:1fr}
    nav.toc{position:static;max-height:none;order:2}
    main{padding:20px}
    .search{width:100%}
  }
</style>
</head>
<body>
<header class="top">
  <div class="top-in">
    <div class="logo">伴</div>
    <div class="brand">伴圆AI原生ERP系统<small>AI 伴你，企业信息化管理圆满</small></div>
    <span class="tag">${esc(doc.tag)}</span>
    <div class="spacer"></div>
    <input class="search" id="q" placeholder="搜索目录…" />
    <a class="back" href="install.html">安装</a>
    <a class="back" href="manual.html">操作</a>
    <a class="back" href="demo-flow.html">演示</a>
    <a class="back" href="dev.html">开发与MCP</a>
    <a class="back" href="security.html">安全说明</a>
    <a class="back" href="http://127.0.0.1:3001/login">返回系统</a>
  </div>
</header>
<div class="wrap">
  <nav class="toc" id="toc">
    <div class="t">${esc(doc.title)}</div>
    ${tocTree}
  </nav>
  <main id="doc">
${html}
  </main>
</div>
<div class="foot">
  ${esc(doc.title)} · 伴圆AI原生ERP系统 · 演示环境说明：本文档中的数据均为虚构样例。
</div>
<script>
  // 目录搜索：只在目录里过滤，不碰正文（正文里有大量"搜索"二字，进去会让人以为坏了）
  var q = document.getElementById('q')
  var links = [].slice.call(document.querySelectorAll('#toc a'))
  q.addEventListener('input', function () {
    var v = q.value.trim().toLowerCase()
    links.forEach(function (a) {
      a.style.display = !v || a.textContent.toLowerCase().indexOf(v) >= 0 ? '' : 'none'
    })
  })

  // 滚动高亮：用 IntersectionObserver 而不是 scroll 事件（长文档滚动时前者更省）
  var hs = [].slice.call(document.querySelectorAll('#doc h2, #doc h3'))
  var map = new Map()
  links.forEach(function (a) { map.set(decodeURIComponent(a.getAttribute('href').slice(1)), a) })
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return
      links.forEach(function (a) { a.classList.remove('active') })
      var a = map.get(e.target.id)
      if (a) a.classList.add('active')
    })
  }, { rootMargin: '-72px 0px -70% 0px', threshold: 0 })
  hs.forEach(function (h) { io.observe(h) })
</script>
</body>
</html>
`
}

let built = 0
for (const doc of DOCS) {
  const srcPath = path.join(ROOT, doc.src)
  if (!fs.existsSync(srcPath)) {
    console.error(`✗ 源文档不存在：${doc.src}`)
    process.exitCode = 1
    continue
  }
  const md = fs.readFileSync(srcPath, 'utf8')
  const { html, toc } = render(md)
  const outPath = path.join(ROOT, doc.out)
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, page(doc, html, toc), 'utf8')
  console.log(`✓ ${doc.out}  ←  ${doc.src}（${md.split('\n').length} 行 / 目录 ${toc.filter((t) => t.level === 2).length} 节）`)
  built += 1
}
console.log(`\n完成：编译 ${built} 份文档 → public/docs/`)
