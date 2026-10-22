/**
 * ============================================================================
 * 文件标识：src/pages/master/Barcode.tsx ｜ 条码/序列号识别
 * ============================================================================
 * 【职责】条码/序列号识别（页面）
 * 【入口】/master/barcode
 * 【主要接口】/master/scan
 *
 * 【说明】本块由 `scripts/check-file-header.mjs` 的批量补标识生成：职责**取自本页自己的标题**、
 *   入口取自 `src/App.tsx` 的路由表、接口取自本页实际调用的接口（**都不是新编的**）。
 *   人工完善时补：这页回答用户的什么问题 / 为什么这样组织 / 改它要注意什么。
 *
 * 【通用硬规矩】判据只有一处；下拉选项从 `/api/meta/*` 取，不要在页面里写死；
 *   改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */
/**
 * 页面：条码/序列号识别
 */

import { useState } from 'react'
import { ScanLine, Barcode as BarcodeIcon, PackageSearch, Boxes } from 'lucide-react'
import api from '../../api/client'
import { Card, Field, Table, toast } from '../../components/ui'

export default function Barcode() {
  const [code, setCode] = useState('')
  const [result, setResult] = useState<any>(null)
  const [loading, setLoading] = useState(false)
  const [history, setHistory] = useState<any[]>([])

  const scan = async () => {
    const c = code.trim()
    if (!c) return
    setLoading(true)
    try {
      const res = await api.get('/master/scan', { code: c })
      setResult(res.data)
      setHistory((h) => [{ code: c, type: res.data.type, msg: res.data.msg, at: new Date().toLocaleTimeString() }, ...h.filter((x) => x.code !== c)].slice(0, 12))
    } catch (e: any) {
      setResult(null)
      toast(e.message || '未识别', 'error')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div>
      <div className="mb-3">
        <h1 className="text-[17px] font-medium text-ink-900 title-serif">条码 / 序列号识别</h1>
        <p className="text-[12px] text-slate-400 mt-0.5">扫码枪或手工输入：商品条码（EAN）、SKU 编码、单品序列号 三合一识别</p>
      </div>

      <Card className="mb-3" pad>
        <div className="flex items-center gap-3">
          <div className="relative flex-1">
            <ScanLine size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-brand-700" />
            <input
              className="input pl-9 font-mono"
              placeholder="扫码 / 输入条码、SKU 编码或序列号，回车识别"
              value={code}
              autoFocus
              onChange={(e) => setCode(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && scan()}
            />
          </div>
          <button className="btn-primary" disabled={loading || !code.trim()} onClick={scan}>
            {loading ? '识别中…' : '识别'}
          </button>
        </div>
        <div className="mt-2.5 flex items-center gap-4 text-[11px] text-slate-400">
          <span className="flex items-center gap-1"><BarcodeIcon size={12} /> 商品条码：69 开头 EAN-13</span>
          <span className="flex items-center gap-1"><PackageSearch size={12} /> SKU 编码：SP10001-01</span>
          <span className="flex items-center gap-1"><Boxes size={12} /> 序列号：SNSP100010 0001</span>
        </div>
      </Card>

      {result && (
        <Card className="mb-3" pad>
          <div className="flex items-center gap-2 mb-3">
            <span className={`px-2 py-0.5 rounded text-[11px] font-medium ${result.type === 'serial' ? 'bg-brand-50 text-brand-700' : 'bg-amber-50 text-amber-600'}`}>
              {result.type === 'serial' ? '序列号命中' : '商品条码命中'}
            </span>
            <span className="text-[13px] text-slate-600">{result.msg}</span>
          </div>
          {result.type === 'serial' ? (
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[12px]">
              {[['序列号', result.data.serial_no], ['商品', `${result.data.product_name} ${result.data.sku_name || ''}`],
                ['SKU', result.data.sku_code], ['批次', result.data.batch_no || '—'],
                ['仓库 / 货位', `${result.data.warehouse_name || '—'}${result.data.location ? ' · ' + result.data.location : ''}`],
                ['状态', result.data.status === 'in_stock' ? '在库' : result.data.status === 'shipped' ? '已出库' : result.data.status],
                ['入库单', result.data.entry_doc_no || '—'], ['持有人', result.data.holder || '—']].map(([l, v]) => (
                <div key={String(l)} className="flex border-b border-dashed border-ink-300 pb-1.5">
                  <span className="text-slate-400 w-24 shrink-0">{l}</span>
                  <span className="text-ink-900 font-medium">{String(v)}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-[12px]">
              {[['商品', result.data.product_name], ['SKU 名称', result.data.name],
                ['SKU 编码', result.data.sku_code], ['条码', result.data.barcode || '—'],
                ['品牌', result.data.brand_name || '—'], ['单位', result.data.unit],
                ['现存量', (result.data.stock_qty || 0).toLocaleString()], ['可用量', (result.data.available_qty || 0).toLocaleString()],
                ['零售价', `¥${result.data.price_retail?.toLocaleString()}`], ['经销价', `¥${result.data.price_dealer?.toLocaleString()}`]].map(([l, v]) => (
                <div key={String(l)} className="flex border-b border-dashed border-ink-300 pb-1.5">
                  <span className="text-slate-400 w-24 shrink-0">{l}</span>
                  <span className="text-ink-900 font-medium">{String(v)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {history.length > 0 && (
        <Card pad={false}>
          <div className="px-3 py-2 text-[13px] font-medium text-ink-900 border-b border-ink-300">本次会话扫码记录</div>
          <Table
            columns={[
              { key: 'at', title: '时间', width: 100 },
              { key: 'code', title: '编码', width: 200, render: (r: any) => <span className="font-mono text-[11px] text-brand-700">{r.code}</span> },
              { key: 'type', title: '识别类型', width: 100, render: (r: any) => r.type === 'serial' ? '序列号' : '商品条码' },
              { key: 'msg', title: '结果' }
            ]}
            data={history}
            loading={false}
          />
        </Card>
      )}
    </div>
  )
}
