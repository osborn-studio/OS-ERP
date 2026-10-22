/**
 * ============================================================================
 * 文件标识：src/hooks/opts.ts ｜ 下拉选项 hook：把 `/api/meta/*` 的字典与主数据包装成 `{value,label}`，统一调用口径
 * ============================================================================
 * 【职责】下拉选项 hook：把 `/api/meta/*` 的字典与主数据包装成 `{value,label}`，统一调用口径
 *
 * 【说明】职责取自人工补充或本文件原有注释（不是新编的）。
 *
 * 【通用硬规矩】判据只有一处；接口只走 `src/api/client.ts`；改完跑 `npm run build` 与 `node scripts/regress-all.mjs`。
 * ============================================================================
 */

import { useFetch } from '../components/ui'

export type Opt = { value: any; label: string; [k: string]: any }

/** 主数据下拉选项（一次请求，多页复用） */
export function useOpts() {
  const { data } = useFetch<any>('/master/options', undefined, [])
  const d = data || {}
  const map = (k: string): Opt[] => (d[k] || []).map((x: any) => ({ value: x.value, label: x.label, ...x }))
  return {
    raw: d,
    brands: map('brands'),
    categories: map('categories'),
    warehouses: map('warehouses'),
    stores: map('stores'),
    suppliers: map('suppliers'),
    dealers: map('dealers'),
    platforms: map('platforms'),
    skus: map('skus'),
    bundles: map('bundles')
  }
}

/** 通用键值字典 */
export function useDict() {
  const { data } = useFetch<any>('/meta/dict', undefined, [])
  const d = data || {}
  const toOpts = (obj: any): Opt[] =>
    Object.entries(obj || {}).map(([value, label]) => ({ value, label: String(label) }))
  return {
    raw: d,
    roles: toOpts(d.roles),
    dealerLevels: toOpts(d.dealer_levels),
    dealerChannel: toOpts(d.dealer_channel),
    warehouseTypes: toOpts(d.warehouse_types),
    storeTypes: toOpts(d.store_types),
    platformTypes: toOpts(d.platform_types),
    salesChannels: toOpts(d.sales_channels),
    purchaseStatus: toOpts(d.purchase_status),
    salesStatus: toOpts(d.sales_status),
    omsStatus: toOpts(d.oms_status),
    transferStatus: toOpts(d.transfer_status),
    checkStatus: toOpts(d.check_status),
    stockDocTypes: toOpts(d.stock_doc_types),
    rebateStatus: toOpts(d.rebate_status),
    statementStatus: toOpts(d.statement_status),
    label: (group: string, key: string) => (d[group] || {})[key] || key
  }
}

export default useOpts
