/**
 * ============================================================================
 * 文件标识：src/utils/credit-effect.ts ｜ 收款确认 / 作废 / 预收抵扣响应里授信效果的展示格式化（纯函数）
 * ============================================================================
 * 【职责】把 ADR-0013 响应里的 `credit_released` / `credit_reversal`
 *   （`{ entries, unified, oc, rows, legacy? }`）整理成页面能直接渲染的行与摘要。
 *   只做展示：金额合计**取后端给的 unified / oc 原值**，不在前端重新求和；
 *   `legacy: true`（迁移 052 之前确认的收款单，没有释放台账行）要如实说清
 *   "只按旧口径回补了订货中心占用，统一授信没有恢复，需人工按 credit.adjust 处理"。
 *
 * 【为什么单独成文件】Receivables.tsx 三处（确认 / 作废 / 预收抵扣）共用一个口径，
 *   并且纯函数可以在 node --test 里不起浏览器就守住五种形态（空 / 统一 / OC / 混合 / legacy）。
 *
 * 【改它要注意什么】测试在 tests/credit-effect-format.test.mjs；改措辞请同步改断言里的关键词。
 * ============================================================================
 */

/** 释放台账一行（server/lib/credit-release.js `record` 的返回形状；字段为后端原名） */
export interface CreditEffectRow {
  id?: number
  receipt_id?: number
  ar_id?: number | null
  trigger?: 'confirm' | 'prepay' | string
  /** 'credit' = 统一授信台账；'oc' = 订货中心台账 */
  ledger: 'credit' | 'oc' | string
  account_id?: number | null
  customer_type?: string
  customer_id?: number
  source_type?: string
  source_id?: number | null
  doc_no?: string | null
  amount: number
  ledger_id?: number | null
  reversal_ref?: string | null
}

/** `credit_released` / `credit_reversal` 的共同形状 */
export interface CreditEffect {
  entries: number
  unified: number
  oc: number
  rows?: CreditEffectRow[]
  /** 仅作废响应：true = 迁移前收款单，旧口径回补 OC，统一授信未恢复 */
  legacy?: boolean
  receipt_id?: number
}

export type CreditEffectKind = 'released' | 'reversal'

export interface CreditEffectLine {
  doc_no: string
  type: string
  ledger: 'unified' | 'oc'
  ledger_label: string
  amount: number
}

export interface CreditEffectView {
  kind: CreditEffectKind
  /** 对本次操作的动词：释放授信 / 恢复占用 */
  verb: string
  /** 没有任何授信变动（也不是 legacy 回补） */
  empty: boolean
  legacy: boolean
  lines: CreditEffectLine[]
  totals: { unified: number; oc: number }
  /** legacy 情形的说明文字；其余为空串 */
  note: string
}

const LEDGER_LABEL: Record<'unified' | 'oc', string> = { unified: '统一授信', oc: '订货中心' }

const VERB: Record<CreditEffectKind, string> = { released: '释放授信', reversal: '恢复占用' }

export const LEGACY_NOTE =
  '这张收款单在迁移前确认，没有释放台账行：作废只按旧口径回补了订货中心占用，统一授信未恢复，需人工按「信用管理 → 手工调整」补占用。'

const num = (v: unknown) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0
}

const fmt = (v: number) => v.toFixed(2)

function toLine(r: CreditEffectRow): CreditEffectLine {
  const ledger: 'unified' | 'oc' = r.ledger === 'oc' ? 'oc' : 'unified'
  const type = r.source_type || (ledger === 'oc' ? 'OC' : 'SO')
  const doc_no = r.doc_no || (r.source_id != null ? `${type}#${r.source_id}` : '—')
  return { doc_no, type, ledger, ledger_label: LEDGER_LABEL[ledger], amount: num(r.amount) }
}

/** 响应 → 可渲染视图；effect 缺失时按"未触及授信"处理 */
export function formatCreditEffect(effect: CreditEffect | null | undefined, kind: CreditEffectKind): CreditEffectView {
  const legacy = kind === 'reversal' && !!effect?.legacy
  const lines = (effect?.rows || []).map(toLine)
  const totals = { unified: num(effect?.unified), oc: num(effect?.oc) }
  const empty = !legacy && lines.length === 0 && totals.unified === 0 && totals.oc === 0
  return { kind, verb: VERB[kind], empty, legacy, lines, totals, note: legacy ? LEGACY_NOTE : '' }
}

/** 一句话摘要（给 toast 用） */
export function creditEffectSummary(effect: CreditEffect | null | undefined, kind: CreditEffectKind): string {
  const v = formatCreditEffect(effect, kind)
  if (v.empty) return '本次未触及授信占用'
  const parts: string[] = []
  if (v.totals.unified > 0) parts.push(`${LEDGER_LABEL.unified} ${fmt(v.totals.unified)}`)
  if (v.totals.oc > 0) parts.push(`${LEDGER_LABEL.oc} ${fmt(v.totals.oc)}`)
  const body = `${v.verb}：${parts.join('、') || '0.00'}`
  return v.legacy ? `${body}（迁移前收款单，旧口径只回补订货中心，统一授信未恢复）` : body
}
