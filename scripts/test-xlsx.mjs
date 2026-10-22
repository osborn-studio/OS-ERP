/**
 * ============================================================================
 * 文件标识：scripts/test-xlsx.mjs ｜ 测试：XLSX 写入器回归：server/lib/xlsx.js
 * ============================================================================
 * 【职责】测试：XLSX 写入器回归：server/lib/xlsx.js
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自原首行注释**，
 *   不是新编的，原文保留在下面。人工完善时补三件事：
 *   这个文件守住什么判据 / 为什么这样设计 / 改它要注意什么。
 *
 * 【通用硬规矩】测试与守卫必须**可重跑、零副作用**；断言要能证明"改坏会红"，
 *   否则不算证据。跑批入口：`node scripts/regress-all.mjs`。
 * ============================================================================
 */

// XLSX 写入器回归：server/lib/xlsx.js
//
// 为什么用 Python 来验：**独立验证**。
//   「自己写个读取器验自己写的写入器」是同源验证 —— 我把 ZIP 的 CRC 字段解释错了，
//   读取器大概率也会按同样错的方式解释，于是两边一致、测试全绿、文件在 Excel 里
//   打不开。所以这里把产物交给**第三方实现**（CPython 标准库 zipfile /
//   xml.etree.ElementTree）去判：CRC 对不对、ZIP 结构完不完整、XML 合不合法，
//   全是别人的判据。Python 只做"读 + 断言"，不做任何修复。
//
// 运行：node scripts/test-xlsx.mjs
// 约定：串行、可重跑、零副作用（临时文件只在 /tmp，收尾删除）
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildXlsx, XlsxError, XLSX_CODES } from '../server/lib/xlsx.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

// 第三方读取器必须能实际 import openpyxl；显式解释器失败不得回退。
import { resolvePythonRuntime } from './lib/python-runtime.mjs'
const PY_ENV = process.env.GML_PYTHON?.trim() || null
let PY = null
let PY_WHY = null
try { PY = resolvePythonRuntime().executable } catch (error) { PY_WHY = error.message }
// 用 spawnSync + 临时 .py 文件（不用 `-c` 拼长串）：`-c` 的引号转义在 zsh / Node 两层里
// 都容易被吃掉，而且出错时报的行号对应不到可读的源码。

let pass = 0, fail = 0
const failed = []
function ok(name, cond, detail) {
  // 自保（铁律 27 第二次撞车后立的规矩）：参数写反时**当场崩**，而不是「永远绿」。
  // ⚠️ 本文件的形参顺序是 (name, cond, detail) —— 与 (cond, msg, detail) 那一族**相反**；
  //    守卫因此写在**第二个**形参上（就是我被这个差异坑过的那次）。
  if (typeof cond !== 'boolean') throw new Error(`ok() 的条件必须是布尔值，收到 ${typeof cond}（参数顺序写反了？）`)
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`) }
  else { fail++; failed.push(name); console.log(`  \x1b[31m✗\x1b[0m ${name}  ${detail !== undefined ? '→ ' + detail : ''}`) }
}
const section = (t) => console.log(`\n\x1b[36m${t}\x1b[0m`)

const TMP = `/tmp/gml-test-xlsx-${process.pid}`
const XLSX_PATH = `${TMP}.xlsx`
const PY_PATH = `${TMP}.py`

// ── 夹具 ─────────────────────────────────────────────────────────────────
// 一张表把所有分支都覆盖到：数字 / 字符串 / XML 特殊字符 / 控制字符 / 布尔 /
// null / undefined / 超长行（验证截断）/ 空行（验证补空）/ 负数 / 科学计数法 /
// NaN / Infinity / 首尾空格 / 0（0 与空单元格的区别）
const CTRL_RAW = '含控制字符\u0000\u0007文本' // 期望落盘为：含控制字符文本
const STR_SPECIAL = '应收 & < > " \' 账款'
const SHEET1 = {
  name: '资产负债表',
  columns: [
    { label: '行次', width: 8 },
    { label: '项目', width: 20 },
    { label: '金额', width: 12.5 }
  ],
  rows: [
    ['行次', '项目', '金额'],
    [1, '货币资金', 1234.5],
    [2, STR_SPECIAL, true],
    [3, CTRL_RAW, null],
    [4, null, undefined],
    [5, '这一行比列定义长', 6, 7, 8], // 5 个值 vs 3 列 → 截断
    [], // 空行
    [6, -0.5, 1e21],
    [7, NaN, Infinity],
    [8, ' 首尾空格 ', 0]
  ]
}
// 第二张表故意**不给 columns**：验证"退化成按最长行定宽"
const SHEET2 = { name: '利润表', rows: [['项目', '本期', '上期', '备注'], [1, 2, 3, 4]] }

const wb = { sheets: [SHEET1, SHEET2] }
const buf = buildXlsx(wb)

// ── Node 侧：接口形状与边界（不需要第三方解释器）──────────────────────────
section('接口形状 / 边界（Node 侧）')
ok('buildXlsx 返回 Buffer 或 Uint8Array', Buffer.isBuffer(buf) || buf instanceof Uint8Array, typeof buf)
ok('输出以 ZIP local header 魔数 PK\\x03\\x04 开头',
  Buffer.from(buf.subarray(0, 4)).toString('hex') === '504b0304',
  Buffer.from(buf.subarray(0, 4)).toString('hex'))
ok('输出非空（> 500 字节，说明真的写了部件而不是空壳）', buf.length > 500, buf.length)
// 同样的输入必须产出同样的字节：ZIP 里的时间戳被固定成常量，否则同一张报表
// 两次导出哈希不同，任何基于哈希的缓存 / 去重 / 回归对比都会莫名"变红"
ok('同样输入的两次构建字节完全相同（时间戳固定，可复现）',
  Buffer.compare(Buffer.from(buf), Buffer.from(buildXlsx(wb))) === 0)

const throwsWith = (name, code, fn) => {
  try { fn(); ok(name, false, '没有抛错') }
  catch (e) {
    ok(name, e instanceof XlsxError && e.code === code, `${e.name}/${e.code}: ${e.message}`)
  }
}
// 31 是 Excel 的字符数上限，32 必须拒
throwsWith('sheet 名 32 个字符 → 抛 BAD_SHEET_NAME', XLSX_CODES.BAD_SHEET_NAME,
  () => buildXlsx({ sheets: [{ name: '名'.repeat(32), rows: [[1]] }] }))
ok('sheet 名正好 31 个字符 → 通过（不误伤边界内）',
  buildXlsx({ sheets: [{ name: '名'.repeat(31), rows: [[1]] }] }).length > 0)

// 非法字符逐个验：并且要求错误信息里**带上那个字符** ——
// 若静默改写（换成下划线），调用方拿到的文件名会和它给的名字悄悄不同
for (const ch of ['[', ']', ':', '*', '?', '/', '\\']) {
  try {
    buildXlsx({ sheets: [{ name: `表A${ch}B`, rows: [[1]] }] })
    ok(`sheet 名含 "${ch}" → 抛 BAD_SHEET_NAME（拒绝而非改写）`, false, '没有抛错')
  } catch (e) {
    ok(`sheet 名含 "${ch}" → 抛 BAD_SHEET_NAME（拒绝而非改写）`,
      e instanceof XlsxError && e.code === XLSX_CODES.BAD_SHEET_NAME && e.message.includes(ch),
      `${e.code}: ${e.message}`)
  }
}
throwsWith('sheet 名为空字符串 → 抛 BAD_SHEET_NAME', XLSX_CODES.BAD_SHEET_NAME,
  () => buildXlsx({ sheets: [{ name: '', rows: [[1]] }] }))
throwsWith('sheet 名为 undefined → 抛 BAD_SHEET_NAME', XLSX_CODES.BAD_SHEET_NAME,
  () => buildXlsx({ sheets: [{ rows: [[1]] }] }))
throwsWith('sheet 重名 → 抛 DUP_SHEET_NAME（Excel 会弹修复，必须在生成前拦）',
  XLSX_CODES.DUP_SHEET_NAME,
  () => buildXlsx({ sheets: [{ name: 'A', rows: [] }, { name: 'A', rows: [] }] }))
throwsWith('sheets 为空数组 → 抛 NO_SHEET', XLSX_CODES.NO_SHEET, () => buildXlsx({ sheets: [] }))
throwsWith('sheets 不是数组 → 抛 BAD_INPUT', XLSX_CODES.BAD_INPUT, () => buildXlsx({ sheets: 'x' }))
throwsWith('workbook 为 null → 抛 BAD_INPUT', XLSX_CODES.BAD_INPUT, () => buildXlsx(null))
ok('单 sheet 且无 columns / 无 rows 也能构建（最小工作簿）',
  buildXlsx({ sheets: [{ name: 'S' }] }).length > 0)

// ── 落盘，交给 Python 独立验证 ─────────────────────────────────────────────
fs.writeFileSync(XLSX_PATH, Buffer.from(buf))

// 断言名清单**在 Python 里显式列出**，并在收尾扫一遍"没执行到的"补记失败。
// 为什么要这样：先前版本里 zipfile 一崩，后面 19 条断言连 print 都跑不到，
// 统计器只看到"通过 21 / 失败 2" —— 大量失败被**藏起来**了。断言的总数必须
// 恒定，一条不少，否则"变红几条"这个数字本身不可信。
const PY_SRC = String.raw`
import json, sys, zipfile
import xml.etree.ElementTree as ET

XLSX = sys.argv[1]
NS = '{http://schemas.openxmlformats.org/spreadsheetml/2006/main}'
OUT, SEEN = [], set()

def rep(name, ok, detail=''):
    if name in SEEN:   # 同名只上报一次，保证总数恒定
        return
    SEEN.add(name)
    OUT.append({'name': name, 'ok': bool(ok), 'detail': str(detail)})

N = {
 'testzip':  u'Python\u00b7zipfile.testzip() \u4e3a None\uff08\u6240\u6709\u6761\u76ee CRC32 \u6b63\u786e\u3001\u80fd\u5b8c\u6574\u89e3\u538b\uff09',
 'parts':    u'Python\u00b7\u90e8\u4ef6\u6e05\u5355\u542b 5 \u4e2a\u5fc5\u9700\u90e8\u4ef6 + \u591a sheet \u7684 sheet2.xml',
 'sh1parse': u'Python\u00b7ElementTree \u80fd\u89e3\u6790 xl/worksheets/sheet1.xml\uff08XML \u5408\u6cd5\uff09',
 'num':      u'Python\u00b7\u6570\u5b57\u5355\u5143\u683c\u662f\u6570\u503c\u5355\u5143\u683c\uff08\u65e0 t \u5c5e\u6027 + <v>\uff09',
 'str':      u'Python\u00b7\u5b57\u7b26\u4e32\u5355\u5143\u683c\u662f\u5185\u8054\u5b57\u7b26\u4e32 t="inlineStr"',
 'esc':      u'Python\u00b7& < > " \u540e\u4ecd\u80fd\u53d6\u56de\u539f\u5b57\u7b26\u4e32',
 'width':    u'Python\u00b7\u5217\u5bbd <cols> \u4e0e\u7ed9\u5b9a width \u4e00\u81f4\uff088 / 20 / 12.5\uff09',
 'null':     u'Python\u00b7null / undefined \u843d\u6210\u7a7a\u5355\u5143\u683c\uff08<c> \u65e0\u5b50\u5143\u7d20\u3001\u65e0 t\uff09',
 'ctrl':     u'Python\u00b7\u975e\u6cd5\u63a7\u5236\u5b57\u7b26\u5df2\u5254\u9664\uff0c\u6587\u672c\u5176\u4f59\u90e8\u5206\u5b8c\u597d',
 'trunc':    u'Python\u00b7\u884c\u6bd4 columns \u957f \u2192 \u622a\u65ad\u5230 columns.length',
 'pad':      u'Python\u00b7\u884c\u6bd4 columns \u77ed / \u7a7a\u884c \u2192 \u8865\u7a7a\u5230 columns.length',
 'rowcount': u'Python\u00b7<row> \u6570\u91cf == rows.length\uff08\u7a7a\u884c\u4e5f\u4fdd\u7559\uff09',
 'bool':     u'Python\u00b7\u5e03\u5c14\u5355\u5143\u683c t="b" \u4e14\u503c\u4e3a 1',
 'numf':     u'Python\u00b7\u6570\u503c\u5355\u5143\u683c\u7684\u6587\u672c\u53ef float() \u4e14\u7b49\u4e8e\u539f\u503c\uff08Excel \u80fd\u6c42\u548c\uff09',
 'nan':      u'Python\u00b7NaN / Infinity \u4e0d\u5199\u6210\u975e\u6cd5\u6570\u503c\uff08\u843d\u6210\u7a7a\u5355\u5143\u683c\uff09',
 'sci':      u'Python\u00b7\u8d1f\u6570\u4e0e 1e21 \u4ecd\u662f\u6570\u503c\u5355\u5143\u683c',
 'sh2':      u'Python\u00b7sheet2 \u72ec\u7acb\u53ef\u89e3\u6790\uff1b\u65e0 columns \u65f6\u6309\u6700\u957f\u884c\u5b9a\u5bbd',
 'wbname':   u'Python\u00b7workbook.xml \u7684\u5de5\u4f5c\u8868\u540d\u4e0e\u987a\u5e8f\u6b63\u786e\uff08\u4e2d\u6587\u540d\u539f\u6837\u4fdd\u7559\uff09',
 'rels':     u'Python\u00b7xl/_rels/workbook.xml.rels \u7684 rId1..N \u2192 sheet1..N.xml',
 'ct':       u'Python\u00b7[Content_Types].xml \u542b workbook main \u4e0e worksheet \u58f0\u660e',
 'opx_load':  u'openpyxl\u00b7\u7b2c\u4e09\u65b9\u8bfb\u53d6\u5668\u80fd\u6253\u5f00\u8be5\u5de5\u4f5c\u7c3f',
 'opx_names': u'openpyxl\u00b7sheet \u540d\u4e0e\u987a\u5e8f\u6b63\u786e\uff08\u4e2d\u6587\u540d\u539f\u6837\uff09',
 'opx_nums':  u'openpyxl\u00b7\u6570\u5b57\u8bfb\u6210 int/float\uff08\u771f\u6b63\u7684\u6570\u503c\u5355\u5143\u683c\uff0c\u80fd\u6c42\u548c\uff09',
 'opx_str':   u'openpyxl\u00b7\u5b57\u7b26\u4e32\u8bfb\u56de\u539f\u503c\uff08\u542b & < > " \u4e0e\u5254\u63a7\u540e\u6587\u672c\uff09',
 'opx_empty': u'openpyxl\u00b7\u7a7a\u5355\u5143\u683c\u8bfb\u6210 None\uff1bmax_row/max_column \u7b49\u4e8e 10/3',
 'opx_width': u'openpyxl\u00b7\u8bfb\u5230\u5217\u5bbd 8 / 20 / 12.5',
 'opx_bool':  u'openpyxl\u00b7\u5e03\u5c14\u8bfb\u6210 True',
}
ORDER = ['testzip', 'parts', 'sh1parse', 'num', 'str', 'esc', 'width', 'null', 'ctrl',
         'trunc', 'pad', 'rowcount', 'bool', 'numf', 'nan', 'sci', 'sh2', 'wbname', 'rels', 'ct',
         'opx_load', 'opx_names', 'opx_nums', 'opx_str', 'opx_empty', 'opx_width', 'opx_bool']

def main():
    z = zipfile.ZipFile(XLSX)
    bad = z.testzip()
    rep(N['testzip'], bad is None, bad)

    names = z.namelist()
    need = ['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml',
            'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']
    miss = [n for n in need if n not in names]
    rep(N['parts'], not miss, 'missing=' + repr(miss) + ' have=' + repr(names))

    def parse(part):
        return ET.fromstring(z.read(part))

    sh1 = None
    try:
        sh1 = parse('xl/worksheets/sheet1.xml')
        rep(N['sh1parse'], True)
    except Exception as e:
        rep(N['sh1parse'], False, repr(e))

    if sh1 is not None:
        rows = sh1.find(NS + 'sheetData').findall(NS + 'row')
        def cell(ri, ci):
            return rows[ri].findall(NS + 'c')[ci]

        c = cell(1, 0)
        v = c.find(NS + 'v')
        rep(N['num'], c.get('t') is None and v is not None and v.text == '1',
            't=%r v=%r' % (c.get('t'), None if v is None else v.text))

        t = cell(1, 1).find(NS + 'is/' + NS + 't')
        rep(N['str'], cell(1, 1).get('t') == 'inlineStr' and t is not None and t.text == u'\u8d27\u5e01\u8d44\u91d1',
            't=%r text=%r' % (cell(1, 1).get('t'), None if t is None else t.text))

        want = u'\u5e94\u6536 & < > " \' \u8d26\u6b3e'
        t = cell(2, 1).find(NS + 'is/' + NS + 't')
        rep(N['esc'], t is not None and t.text == want,
            'want=%r got=%r' % (want, None if t is None else t.text))

        cols = sh1.find(NS + 'cols')
        got = [] if cols is None else [(float(e.get('width')), e.get('min'), e.get('max')) for e in cols]
        rep(N['width'], got == [(8.0, '1', '1'), (20.0, '2', '2'), (12.5, '3', '3')], repr(got))

        e1, e2 = cell(4, 1), cell(4, 2)
        rep(N['null'], len(list(e1)) == 0 and e1.get('t') is None and len(list(e2)) == 0 and e2.get('t') is None,
            'e1 t=%r children=%d; e2 t=%r children=%d' % (e1.get('t'), len(list(e1)), e2.get('t'), len(list(e2))))

        t = cell(3, 1).find(NS + 'is/' + NS + 't')
        txt = '' if t is None or t.text is None else t.text
        ctrl = [ord(ch) for ch in txt if ord(ch) < 0x20 and ch not in '\t\n\r']
        rep(N['ctrl'], ctrl == [] and txt == u'\u542b\u63a7\u5236\u5b57\u7b26\u6587\u672c',
            'ctrl=%r text=%r' % (ctrl, txt))

        long_row = rows[5].findall(NS + 'c')
        rep(N['trunc'], len(long_row) == 3 and long_row[2].find(NS + 'v').text == '6',
            'cells=%d' % len(long_row))

        empty_row = rows[6].findall(NS + 'c')
        rep(N['pad'], len(empty_row) == 3 and all(len(list(x)) == 0 and x.get('t') is None for x in empty_row),
            'cells=%d' % len(empty_row))

        rep(N['rowcount'], len(rows) == 10, 'rows=%d' % len(rows))

        bc = cell(2, 2)
        bv = bc.find(NS + 'v')
        rep(N['bool'], bc.get('t') == 'b' and bv is not None and bv.text == '1',
            't=%r v=%r' % (bc.get('t'), None if bv is None else bv.text))

        want_nums = {(1, 0): 1.0, (1, 2): 1234.5, (7, 1): -0.5, (7, 2): 1e21, (9, 2): 0.0}
        wrong = []
        for (ri, ci), exp in want_nums.items():
            cc = cell(ri, ci)
            vv = cc.find(NS + 'v')
            if cc.get('t') is not None or vv is None or float(vv.text) != exp:
                wrong.append(((ri, ci), exp, cc.get('t'), None if vv is None else vv.text))
        rep(N['numf'], not wrong, repr(wrong))

        rep(N['nan'], len(list(cell(8, 1))) == 0 and len(list(cell(8, 2))) == 0,
            't=%r children=%d' % (cell(8, 1).get('t'), len(list(cell(8, 1)))))

        neg = cell(7, 1).find(NS + 'v')
        sci = cell(7, 2)
        sci_v = sci.find(NS + 'v')
        rep(N['sci'], neg is not None and neg.text == '-0.5' and sci.get('t') is None and
            sci_v is not None and float(sci_v.text) == 1e21,
            'neg=%r sci=%r/%r' % (None if neg is None else neg.text, sci.get('t'), None if sci_v is None else sci_v.text))

    try:
        sh2 = parse('xl/worksheets/sheet2.xml')
        lens = [len(r.findall(NS + 'c')) for r in sh2.find(NS + 'sheetData').findall(NS + 'row')]
        no_cols = sh2.find(NS + 'cols')
        rep(N['sh2'], lens == [4, 4] and no_cols is None, 'lens=%r cols=%r' % (lens, no_cols))
    except Exception as e:
        rep(N['sh2'], False, repr(e))

    try:
        shs = [(e.get('name'), e.get('sheetId'), e.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id'))
               for e in parse('xl/workbook.xml').find(NS + 'sheets')]
        rep(N['wbname'], shs == [(u'\u8d44\u4ea7\u8d1f\u503a\u8868', '1', 'rId1'),
                                 (u'\u5229\u6da6\u8868', '2', 'rId2')], repr(shs))
    except Exception as e:
        rep(N['wbname'], False, repr(e))

    try:
        pairs = sorted((e.get('Id'), e.get('Target')) for e in parse('xl/_rels/workbook.xml.rels'))
        rep(N['rels'], pairs == [('rId1', 'worksheets/sheet1.xml'), ('rId2', 'worksheets/sheet2.xml')], repr(pairs))
    except Exception as e:
        rep(N['rels'], False, repr(e))

    try:
        ct = z.read('[Content_Types].xml').decode('utf-8')
        rep(N['ct'], 'spreadsheetml.sheet.main+xml' in ct and 'spreadsheetml.worksheet+xml' in ct and
            '/xl/worksheets/sheet2.xml' in ct, ct[:200])
    except Exception as e:
        rep(N['ct'], False, repr(e))

FATAL = None
try:
    main()
except Exception as e:
    FATAL = repr(e)

# ── 第三重交叉验证：openpyxl（真正的 xlsx 读取器）────────────────────────────
# zipfile + ElementTree 只能证明"ZIP 合法 + XML 合法"，证明不了"按 OOXML 语义
# 读出来的东西对不对"（比如 inlineStr / t="b" 用错了，XML 依然合法）。
# openpyxl 是按 schema 语义解析的第三方实现，它的读数是"这份文件在 Excel 里长什么
# 样"的最接近的旁证。它不可用时全部记失败并说明原因 —— 不静默跳过。
def stage_openpyxl():
    ks = ['opx_load', 'opx_names', 'opx_nums', 'opx_str', 'opx_empty', 'opx_width', 'opx_bool']
    try:
        import openpyxl
    except Exception as e:
        for k in ks:
            rep(N[k], False, u'openpyxl \u4e0d\u53ef\u7528\uff1a' + repr(e))
        return
    try:
        wb = openpyxl.load_workbook(XLSX)
    except Exception as e:
        for k in ks:
            rep(N[k], False, u'openpyxl \u6253\u5f00\u5931\u8d25\uff1a' + repr(e))
        return
    rep(N['opx_load'], True)
    rep(N['opx_names'], wb.sheetnames == [u'\u8d44\u4ea7\u8d1f\u503a\u8868', u'\u5229\u6da6\u8868'], repr(wb.sheetnames))
    ws = wb[u'\u8d44\u4ea7\u8d1f\u503a\u8868']
    a2, c2 = ws.cell(2, 1).value, ws.cell(2, 3).value
    rep(N['opx_nums'],
        isinstance(a2, int) and not isinstance(a2, bool) and a2 == 1 and
        isinstance(c2, float) and c2 == 1234.5, 'A2=%r C2=%r' % (a2, c2))
    want = u'\u5e94\u6536 & < > " \' \u8d26\u6b3e'
    b3, b4 = ws.cell(3, 2).value, ws.cell(4, 2).value
    rep(N['opx_str'], b3 == want and b4 == u'\u542b\u63a7\u5236\u5b57\u7b26\u6587\u672c', 'B3=%r B4=%r' % (b3, b4))
    rep(N['opx_empty'],
        ws.cell(5, 2).value is None and ws.cell(5, 3).value is None and
        ws.max_row == 10 and ws.max_column == 3, 'max=%d/%d B5=%r' % (ws.max_row, ws.max_column, ws.cell(5, 2).value))
    def w(k):
        d = ws.column_dimensions.get(k)
        return None if d is None else d.width
    rep(N['opx_width'], [w('A'), w('B'), w('C')] == [8.0, 20.0, 12.5], repr([w('A'), w('B'), w('C')]))
    rep(N['opx_bool'], ws.cell(3, 3).value is True, repr(ws.cell(3, 3).value))

try:
    stage_openpyxl()
except Exception as e:
    FATAL = repr(e)

# 收尾扫尾：没执行到的断言一律记失败（并说明原因）。跳过 = 把失败藏起来。
for k in ORDER:
    rep(N[k], False, u'\u65ad\u8a00\u672a\u6267\u884c\uff1a' + (FATAL or u'\u672a\u8dd1\u5230'))

for o in OUT:
    print('@@' + json.dumps(o, ensure_ascii=False))
print('##COUNT %d' % len(OUT))
`
fs.writeFileSync(PY_PATH, PY_SRC)

section('独立验证：CPython zipfile + xml.etree.ElementTree + openpyxl')
// 找不到解释器时**不许静默跳过**：本文件最硬的那条证据就是"交给第三方实现去判"。
// 用一个带 error 的假结果顶上去，走同一条失败路径（`ok(false)` + 写出原因），
// 于是① 计数行照常打印；② 失败原因读得出来；③ 不会 `spawnSync(undefined)` 崩掉整套。
const py = PY
  ? spawnSync(PY, [PY_PATH, XLSX_PATH], { encoding: 'utf8', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
  : { error: new Error(PY_WHY), status: -1, stdout: '', stderr: '' }
if (py.error) {
  ok('Python 解释器可执行', false, String(py.error))
} else if (py.status !== 0) {
  ok('Python 脚本正常退出（不应有未捕获异常）', false, `status=${py.status} stderr=${(py.stderr || '').slice(0, 800)}`)
} else {
  const out = py.stdout || ''
  const lines = out.split('\n').filter((l) => l.startsWith('@@'))
  const count = Number((out.match(/##COUNT (\d+)/) || [])[1] || 0)
  ok('Python 断言总数恒定（27 条，且与实际上报条数一致）', count === 27 && lines.length === 27,
    `count=${count} lines=${lines.length}`)
  for (const l of lines) {
    const o = JSON.parse(l.slice(2))
    ok(o.name, o.ok, o.ok ? undefined : o.detail)
  }
}

// 第三把尺子：系统 unzip（既不是本模块的写入器，也不是 Python 的 zipfile）
section('旁证：系统 unzip -t')
const unzip = spawnSync('unzip', ['-t', XLSX_PATH], { encoding: 'utf8', timeout: 10000 })
ok('系统 unzip -t 报 "No errors detected"',
  unzip.status === 0 && /No errors detected/i.test(unzip.stdout || ''),
  `error=${unzip.error?.code || 'none'} status=${unzip.status}; ` + ((unzip.stdout || '') + (unzip.stderr || '')).slice(0, 400))

// ── 收尾：临时文件自还原（串行可重跑的前提）────────────────────────────────
section('用例自还原')
fs.rmSync(XLSX_PATH, { force: true })
fs.rmSync(PY_PATH, { force: true })
ok('用例自还原：临时 .xlsx 与 .py 已删除',
  !fs.existsSync(XLSX_PATH) && !fs.existsSync(PY_PATH))

// =========================================================================
// 收尾自证：应到 / 实到断言数
// =========================================================================
// ⚠️ `EXPECTED_TOTAL` 是**时点的函数**：增删/合并断言必须同步改这里，
//    否则这一条会红（它红了不代表实现坏了，只代表"条数变了而预期没跟着改"）。
// 恒定的前提是上面那条「Python 断言总数恒定（27 条）」——Python 侧少报一条，总数就对不上。
const EXPECTED_TOTAL = 51
const soFar = pass + fail
ok(`应到 ${EXPECTED_TOTAL} 条断言，实到 ${soFar + 1} 条（增删断言必须同步改文件里的 EXPECTED_TOTAL）`,
  soFar === EXPECTED_TOTAL - 1, `实到 ${soFar + 1} / 应到 ${EXPECTED_TOTAL}`)

console.log(`\n${'─'.repeat(56)}`)
console.log(`通过 ${pass} / 失败 ${fail}`)
if (fail) console.log('失败项：\n - ' + failed.join('\n - '))
setTimeout(() => process.exit(fail ? 1 : 0), 100)
