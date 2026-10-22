/**
 * ============================================================================
 * 文件标识：src/components/Lines.tsx ｜ 模块 Lines（按文件名推断，待人工完善）
 * ============================================================================
 * 【职责】模块 Lines（按文件名推断，待人工完善）
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import { ReactNode } from 'react'
import { Plus, Trash2 } from 'lucide-react'
import { fmtMoney } from './ui'

export type Line = {
  sku_id?: number | ''
  qty?: number
  price?: number
  tax_rate?: number
  remark?: string
  [k: string]: any
}

/** 单据明细行编辑器 */
export function LinesEditor({
  lines,
  onChange,
  skus,
  priceKey = 'price_dealer',
  showTax = false,
  extraCols
}: {
  lines: Line[]
  onChange: (l: Line[]) => void
  skus: { value: any; label: string; sku_code?: string; [k: string]: any }[]
  priceKey?: string
  showTax?: boolean
  extraCols?: { title: string; width?: number; render: (line: Line, update: (patch: Partial<Line>) => void) => ReactNode }[]
}) {
  const update = (i: number, patch: Partial<Line>) => {
    const next = lines.map((l, idx) => (idx === i ? { ...l, ...patch } : l))
    onChange(next)
  }
  const pickSku = (i: number, skuId: string) => {
    const sku = skus.find((s) => String(s.value) === String(skuId))
    update(i, {
      sku_id: skuId ? Number(skuId) : '',
      price: sku ? Number(sku?.[priceKey] || sku?.price_retail || 0) : 0
    })
  }
  const total = lines.reduce((s, l) => s + Number(l.qty || 0) * Number(l.price || 0), 0)

  return (
    <div>
      <div className="table-wrap border border-ink-300 rounded-md">
        <table className="tbl">
          <thead>
            <tr>
              <th style={{ width: 260 }}>商品 SKU</th>
              <th style={{ width: 90 }}>数量</th>
              <th style={{ width: 110 }}>单价</th>
              {showTax && <th style={{ width: 80 }}>税率%</th>}
              <th style={{ width: 110 }}>金额</th>
              {extraCols?.map((c) => (
                <th key={c.title} style={{ width: c.width }}>
                  {c.title}
                </th>
              ))}
              <th style={{ width: 50 }}></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 && (
              <tr>
                <td colSpan={5 + (showTax ? 1 : 0) + (extraCols?.length || 0)} className="text-center py-6 text-slate-400">
                  尚未添加明细
                </td>
              </tr>
            )}
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select className="input input-sm" value={l.sku_id ?? ''} onChange={(e) => pickSku(i, e.target.value)}>
                    <option value="">选择商品</option>
                    {skus.map((s) => (
                      <option key={s.value} value={s.value}>
                        {s.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.qty ?? ''}
                    onChange={(e) => update(i, { qty: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                </td>
                <td>
                  <input
                    className="input input-sm text-right"
                    type="number"
                    value={l.price ?? ''}
                    onChange={(e) => update(i, { price: e.target.value === '' ? undefined : Number(e.target.value) })}
                  />
                </td>
                {showTax && (
                  <td>
                    <input
                      className="input input-sm text-right"
                      type="number"
                      value={l.tax_rate ?? 13}
                      onChange={(e) => update(i, { tax_rate: Number(e.target.value) })}
                    />
                  </td>
                )}
                <td className="text-right tabular-nums">¥{fmtMoney(Number(l.qty || 0) * Number(l.price || 0))}</td>
                {extraCols?.map((c) => (
                  <td key={c.title}>{c.render(l, (patch) => update(i, patch))}</td>
                ))}
                <td className="text-center">
                  <button className="text-red-500 hover:text-red-600" onClick={() => onChange(lines.filter((_, idx) => idx !== i))}>
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center justify-between mt-2">
        <button className="btn-ghost btn-sm" onClick={() => onChange([...lines, { qty: 1, tax_rate: 13 }])}>
          <Plus size={13} /> 添加一行
        </button>
        <div className="text-[13px] text-slate-600">
          合计金额：<span className="font-medium tabular-nums">¥{fmtMoney(total)}</span>
        </div>
      </div>
    </div>
  )
}

export default LinesEditor
