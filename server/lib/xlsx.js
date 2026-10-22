/**
 * ============================================================================
 * 文件标识：server/lib/xlsx.js ｜ 零依赖 XLSX（Excel 工作簿）写入器 —— 给"财务报表导出 Excel"用的底层能力。
 * ============================================================================
 * 【职责】零依赖 XLSX（Excel 工作簿）写入器 —— 给"财务报表导出 Excel"用的底层能力。
 *
 * 【这个标识块是怎么来的】由 `scripts/check-file-header.mjs` 的批量补标识生成 ——
 *   职责**取自本文件原有的首行注释**（不是新编的），原文保留在下面。
 *   人工完善时建议补三件事：这块解决什么问题 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用注意】本项目的硬规矩：判据只有一处（不要在第二个地方再抄一遍条件）；
 *   改完必须跑 `node scripts/regress-all.mjs`（3 轮）与相关 `test-*.mjs`。
 * ============================================================================
 */

// 零依赖 XLSX（Excel 工作簿）写入器 —— 给"财务报表导出 Excel"用的底层能力。
//
// ── 为什么自己写 ZIP / OOXML，而不是加一个 xlsx 库 ──────────────────────────
// 1. 本项目运行时依赖是**冻结**的（bcryptjs / better-sqlite3 / cors / dayjs /
//    express / jsonwebtoken / nanoid / zod）。xlsx / exceljs / jszip 任何一个
//    都会带进一条新的供应链（含传递依赖），为"导出一张表"付这个代价不划算。
// 2. 报表导出只需要 OOXML 里极小的一块子集：静态值、列宽、多工作表。
//    不需要公式、样式、图表、共享字符串、冻结窗格 —— 用不到的解析器就是
//    用不到的攻击面和用不到的 bug。
// 3. 我们只**写**不**读**。写 OOXML 的全部复杂度就是把字符串按规范拼对；
//    读才需要解析无限种别人产出的文件。
//
// ── 为什么用内联字符串（t="inlineStr"）而不是 sharedStrings.xml ─────────────
// sharedStrings 是一个"旁路表"：单元格里放**下标**，真正的文本在另一个部件里。
// 于是多出一整个部件、多一套去重逻辑、多一个"下标写错就串行"的失败模式，
// 换来的只是文件小一点（报表量级下是几十 KB 的差别）。
// 用 inlineStr 后：单元格文本就在单元格里，**少一个部件就少一处能错的地方**。
//
// ── 支持的 OOXML 特性（有意的全集）─────────────────────────────────────────
//   · 静态字符串（inlineStr）/ 数字（数值单元格，可被 Excel 求和）/ 布尔（t="b"）
//   · 空单元格 / 每行列数
//   · 列宽（xl:worksheet 的 <cols>）
//   · 多工作表（sheet1.xml / sheet2.xml ...）+ UTF-8 工作表名
// 明确**不支持**：样式与字体/数字格式（日期就是数字或字符串，见下）、
//   合并单元格、公式、批注、超链接、冻结窗格、自动筛选、图片、Zip64。
//
// 关于日期：Excel 的日期本质是"带日期数字格式的序列号"，没有样式部件就没有
//   日期；所以日期请调用方自己格式化成字符串传进来（报表场景下这是主流做法，
//   且避免"1899-12-30 基准 + 1900 闰年 bug"这类经典坑）。
import { deflateRawSync } from 'node:zlib'

// ── 错误码 ────────────────────────────────────────────────────────────────
// 带 code 的错误：让调用方（路由层）能按类型映射成 HTTP 400 并把 code 透出去，
// 而不是靠匹配 message 文本（文本随时会改）。
export const XLSX_CODES = {
  BAD_INPUT: 'XLSX_BAD_INPUT', // workbook 结构不对（不是对象、sheets 不是数组）
  NO_SHEET: 'XLSX_NO_SHEET', // sheets 为空 —— Excel 不允许零工作表的工作簿
  BAD_SHEET_NAME: 'XLSX_BAD_SHEET_NAME', // 工作表名非法（空 / 超 31 字符 / 含禁用字符）
  DUP_SHEET_NAME: 'XLSX_DUP_SHEET_NAME' // 工作表重名 —— Excel 会进"修复"对话框
}

export class XlsxError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'XlsxError'
    this.code = code
  }
}

// ── XML 工具 ──────────────────────────────────────────────────────────────

// XML 1.0 的 Char 产生式**不允许**大部分 C0 控制字符：
//   合法： #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
// 非法： #x0-#x8 | #xB | #xC | #xE-#x1F，以及 #xFFFE/#xFFFF
// 为什么必须剔而不是转义：控制字符**没有**对应的实体引用，`&#x7;` 这种写法本身
// 就违反规范，Excel 打开时会直接判定文件损坏并弹"修复"。而业务里这些字符很常见
// —— 从 ERP/邮件/手工粘贴粘进来的数据里带 \u0000-\u001F 是家常便饭。
// 所以策略是：**静默剔除**（唯一一处"静默"，因为它不改变"表里有什么数据"这个
// 问题的答案，只是把根本不能存在于 XML 里的字节扔掉），并在下面留注释。
const ILLEGAL_CTRL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g

export function sanitizeXmlText(s) {
  return String(s).replace(ILLEGAL_CTRL, '')
}

// 转义 & < > " ' 五个 XML 特殊字符。
// 顺序有讲究：**必须**先换 `&`，否则后面替换产生的 `&` 会被再转义一次
// （`&lt;` → `&amp;lt;`，Excel 里就显示成字面量 `&lt;`）。
export function escapeXml(s) {
  return sanitizeXmlText(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// 1 → A、26 → Z、27 → AA（单元格引用用）
function colName(n) {
  let s = ''
  let i = n
  while (i > 0) {
    const r = (i - 1) % 26
    s = String.fromCharCode(65 + r) + s
    i = Math.floor((i - 1) / 26)
  }
  return s
}

// ── CRC32（ZIP 每个条目都要） ──────────────────────────────────────────────
// 表只算一次并缓存：报表导出会调很多次，每次重算 256 项是纯浪费。
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ── 最小 ZIP 写入器 ───────────────────────────────────────────────────────
// 结构：每个条目 [Local file header + 文件名 + 压缩数据]，
//       然后是 Central directory 的若干条目，最后是 EOCD。
// 压缩一律用 method 8（deflate raw）。不走 Zip64 —— 报表导出不可能到
// 4GB/65535 条目；真到了会因为 size 字段溢出而明显出错，不会静默写坏。
//
// 时间戳固定为 2020-01-01 00:00:00（DOS 格式）：让**同样的输入产出同样的字节**。
// 用当前时间的话，同一张报表两次导出的文件哈希不同，做缓存/去重/回归对比
// 都会莫名其妙地"变红"，而这不是数据问题。
const DOS_DATE = ((2020 - 1980) << 9) | (1 << 5) | 1
const DOS_TIME = 0

function buildZip(entries) {
  const parts = []
  const central = []
  let offset = 0

  for (const e of entries) {
    const nameBuf = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8')
    const comp = deflateRawSync(raw)
    const crc = crc32(raw)

    const lfh = Buffer.alloc(30)
    lfh.writeUInt32LE(0x04034b50, 0) // Local file header 签名
    lfh.writeUInt16LE(20, 4) // 解压所需版本 2.0
    lfh.writeUInt16LE(0x0800, 6) // 通用位标志：bit 11 = 文件名是 UTF-8
    lfh.writeUInt16LE(8, 8) // 压缩方法 8 = deflate
    lfh.writeUInt16LE(DOS_TIME, 10)
    lfh.writeUInt16LE(DOS_DATE, 12)
    lfh.writeUInt32LE(crc, 14)
    lfh.writeUInt32LE(comp.length, 18)
    lfh.writeUInt32LE(raw.length, 22)
    lfh.writeUInt16LE(nameBuf.length, 26)
    lfh.writeUInt16LE(0, 28) // extra field 长度

    parts.push(lfh, nameBuf, comp)
    central.push({ nameBuf, crc, compSize: comp.length, rawSize: raw.length, offset })
    offset += 30 + nameBuf.length + comp.length
  }

  const cdOffset = offset
  for (const c of central) {
    const h = Buffer.alloc(46)
    h.writeUInt32LE(0x02014b50, 0) // Central directory 签名
    h.writeUInt16LE(20, 4) // 创建者版本（MS-DOS 2.0，不写 unix 权限位）
    h.writeUInt16LE(20, 6) // 解压所需版本
    h.writeUInt16LE(0x0800, 8) // 同样的 UTF-8 标志，必须与 local header 一致
    h.writeUInt16LE(8, 10)
    h.writeUInt16LE(DOS_TIME, 12)
    h.writeUInt16LE(DOS_DATE, 14)
    h.writeUInt32LE(c.crc, 16)
    h.writeUInt32LE(c.compSize, 20)
    h.writeUInt32LE(c.rawSize, 24)
    h.writeUInt16LE(c.nameBuf.length, 28)
    h.writeUInt16LE(0, 30) // extra
    h.writeUInt16LE(0, 32) // comment
    h.writeUInt16LE(0, 34) // 起始磁盘号
    h.writeUInt16LE(0, 36) // 内部属性
    h.writeUInt32LE(0, 38) // 外部属性
    h.writeUInt32LE(c.offset, 42) // 对应 local header 的偏移
    parts.push(h, c.nameBuf)
    offset += 46 + c.nameBuf.length
  }

  const cdSize = offset - cdOffset
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0) // EOCD 签名
  eocd.writeUInt16LE(0, 4) // 本磁盘号
  eocd.writeUInt16LE(0, 6) // central directory 起始磁盘号
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(cdSize, 12)
  eocd.writeUInt32LE(cdOffset, 16)
  eocd.writeUInt16LE(0, 20) // 注释长度

  return Buffer.concat([...parts, eocd])
}

// ── OOXML 部件 ────────────────────────────────────────────────────────────
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n'
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'

function contentTypesXml(sheetCount) {
  const overrides = []
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(
      `<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    )
  }
  return (
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    // 两个 Default：.rels 与 .xml —— 有这两条，绝大部分部件就不用逐个写 Override
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    // workbook 与每个 worksheet 用 Override 明确类型（Excel 判断"这是不是 xlsx"
    // 的第一依据就是 [Content_Types].xml 里的这条 main+xml）
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    overrides.join('') +
    '</Types>'
  )
}

function rootRelsXml() {
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>'
  )
}

function workbookXml(sheets) {
  const items = sheets
    .map(
      (s, i) =>
        `<sheet name="${escapeXml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
    )
    .join('')
  return (
    XML_DECL +
    `<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>${items}</sheets></workbook>`
  )
}

function workbookRelsXml(sheetCount) {
  const items = []
  for (let i = 1; i <= sheetCount; i++) {
    items.push(
      `<Relationship Id="rId${i}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${i}.xml"/>`
    )
  }
  return (
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    items.join('') +
    '</Relationships>'
  )
}

function cellXml(ref, v) {
  if (v === null || v === undefined) return `<c r="${ref}"/>`
  if (typeof v === 'number') {
    // Excel 没有 NaN/Infinity（<v>NaN</v> 会触发"修复"），落成空单元格。
    // 这是**有损**的，但比产出一个打不开的文件好；调用方要区分"0"和"算不出来"
    // 就自己传字符串。
    if (!Number.isFinite(v)) return `<c r="${ref}"/>`
    // 数值单元格：无 t 属性 + <v> —— Excel 据此当数字处理，可参与求和
    return `<c r="${ref}"><v>${v}</v></c>`
  }
  if (typeof v === 'boolean') return `<c r="${ref}" t="b"><v>${v ? 1 : 0}</v></c>`
  // 其余（含意外类型如对象/数组）一律按文本落，避免"某一格类型不对就整个导出 500"
  const s = typeof v === 'string' ? v : String(v)
  // xml:space="preserve" 保留首尾空格：Excel 默认会吃掉它们，
  // 而"行次"这类字段里前导空格是有意义的对齐/编码，不能悄悄丢
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(s)}</t></is></c>`
}

function sheetXml(sheet) {
  const columns = Array.isArray(sheet.columns) ? sheet.columns : []
  const rows = Array.isArray(sheet.rows) ? sheet.rows : []

  // 列数口径：**以 columns.length 为准**。
  //   · 行比列短 → 补空单元格（见下）
  //   · 行比列长 → 截断（不抛错）
  // 为什么不抛错：列定义来自报表模板，行来自数据库。多出来的格子没有列宽、
  // 没有表头、下游按列下标取值也取不到它；抛错会让"模板少配一列"这种小疏忽
  // 直接炸掉整个导出页，而正确行为（导出模板定义的列）本可以照常给出。
  // 另外 Excel 的列数由**最长行**决定，放进去的孤儿列会把整张表的列宽布局顶错位。
  //
  // columns 为空时（调用方只给了 rows）退化成"按最长行定宽"，好过导出一张空表。
  let width = columns.length
  if (width === 0) {
    for (const r of rows) if (Array.isArray(r) && r.length > width) width = r.length
  }

  const sheetData = []
  for (let ri = 0; ri < rows.length; ri++) {
    const r = Array.isArray(rows[ri]) ? rows[ri] : []
    const cells = []
    for (let ci = 0; ci < width; ci++) {
      // 空单元格也**显式**写出来（`<c r="A1"/>`）而不是省略：
      // 稀疏省略会让不同行的 <c> 个数不一致，下游按"第几个 c"取值就会错位；
      // 写满后每行列数恒等于 width，行号/列号在 XML 里是自证的。
      cells.push(cellXml(`${colName(ci + 1)}${ri + 1}`, ci < r.length ? r[ci] : null))
    }
    sheetData.push(`<row r="${ri + 1}">${cells.join('')}</row>`)
  }

  // 列宽：只给 width 是正有限数的列写 <col>，每列一条（不做相邻合并 ——
  // 合并只是省几个字节，却多一段容易写错的区间归并逻辑）
  const cols = []
  for (let i = 0; i < width; i++) {
    const w = columns[i] && columns[i].width
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      cols.push(`<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    }
  }
  const colsXml = cols.length ? `<cols>${cols.join('')}</cols>` : ''

  return (
    XML_DECL +
    `<worksheet xmlns="${NS_MAIN}">${colsXml}<sheetData>${sheetData.join('')}</sheetData></worksheet>`
  )
}

// ── 工作表名校验 ──────────────────────────────────────────────────────────
// 规则来自 Excel 自身：1–31 字符，且不含 [ ] : * ? / \，不以撇号开头或结尾，
// 不叫 "History"（保留名）。这里**拒绝**而不是改写。
// 为什么不改写（把非法字符换成下划线、截断到 31 字符）：那样"我导出的这份文件里
// 工作表叫什么"就变成一个没人能预先知道答案的问题 —— 前端要按名字定位工作表、
// 用户要按名字在文档里找，任何一处的假设都可能落空，而且失败得很安静。
// 抛错让调用方把问题顶到用户面前（"这张报表的工作表名超长"），是可发现的。
const BAD_NAME_CHARS = /[\[\]:*?/\\]/
const RESERVED_NAMES = ['history']

function checkSheetName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new XlsxError(XLSX_CODES.BAD_SHEET_NAME, '工作表名必须是非空字符串')
  }
  // 用**字符数**（码点）而不是字节数：Excel 的限制是 31 个字符，
  // 中文一个字算一个，"资产负债表"是 5 个字符不是 15 个字节。
  const chars = [...name].length
  if (chars > 31) {
    throw new XlsxError(
      XLSX_CODES.BAD_SHEET_NAME,
      `工作表名超过 31 个字符（当前 ${chars} 个）：${name}`
    )
  }
  const bad = name.match(BAD_NAME_CHARS)
  if (bad) {
    throw new XlsxError(
      XLSX_CODES.BAD_SHEET_NAME,
      `工作表名不能包含 [ ] : * ? / \\ 这些字符，实际包含 "${bad[0]}"：${name}`
    )
  }
  if (name.startsWith("'") || name.endsWith("'")) {
    throw new XlsxError(
      XLSX_CODES.BAD_SHEET_NAME,
      `工作表名不能以撇号开头或结尾：${name}`
    )
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    throw new XlsxError(XLSX_CODES.BAD_SHEET_NAME, `工作表名 "${name}" 是 Excel 保留名`)
  }
  return name
}

/**
 * 把一张"矩阵"渲染成 xlsx 字节流。
 *
 * @param {{ sheets: Array<{ name: string, columns?: Array<{label?: string, width?: number}>, rows?: Array<Array<string|number|boolean|null|undefined>> }> }} workbook
 * @returns {Buffer} .xlsx 文件内容
 * @throws {XlsxError} 带 code：NO_SHEET / BAD_SHEET_NAME / DUP_SHEET_NAME / BAD_INPUT
 *
 * 约定：`columns[].label` **不**写入文件 —— 表头由调用方作为第一行 rows 传进来。
 * 理由：本模块只做"矩阵 → XML"一件事，一旦它自作主张插一行表头，调用方若已经
 * 在 rows 里放了表头就会出现两行表头，而这种重复只有在打开文件时才看得见。
 */
export function buildXlsx(workbook) {
  if (!workbook || typeof workbook !== 'object') {
    throw new XlsxError(XLSX_CODES.BAD_INPUT, 'workbook 必须是对象')
  }
  const sheets = workbook.sheets
  if (!Array.isArray(sheets)) {
    throw new XlsxError(XLSX_CODES.BAD_INPUT, 'workbook.sheets 必须是数组')
  }
  // 零工作表的工作簿不是合法 xlsx（Excel 打不开），必须拦在生成之前
  if (sheets.length === 0) {
    throw new XlsxError(XLSX_CODES.NO_SHEET, '至少需要一张工作表')
  }

  const seen = new Set()
  for (const s of sheets) {
    const name = checkSheetName(s && s.name)
    // 重名同样不是合法工作簿（Excel 会弹"修复"）。同样拒绝而不加 (2) 后缀改写。
    const key = name.toLowerCase() // Excel 判重不区分大小写
    if (seen.has(key)) {
      throw new XlsxError(XLSX_CODES.DUP_SHEET_NAME, `工作表重名：${name}`)
    }
    seen.add(key)
  }

  const entries = [
    // [Content_Types].xml 放第一个：绝大多数读取器（含 Excel）先看它决定怎么解析
    { name: '[Content_Types].xml', data: contentTypesXml(sheets.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'xl/workbook.xml', data: workbookXml(sheets) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(sheets.length) }
  ]
  sheets.forEach((s, i) => {
    entries.push({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s || {}) })
  })

  return buildZip(entries)
}

export default { buildXlsx, XlsxError, XLSX_CODES, escapeXml, sanitizeXmlText, crc32 }
