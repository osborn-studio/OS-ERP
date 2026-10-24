/**
 * ============================================================================
 * 文件标识：scripts/lib/anchor-intent-signer.mjs ｜ 锚点操作意图的签名私钥加载（AE5，ADR-0055 补充）
 * ============================================================================
 * 【职责】retention / audit-archive / privacy-erase 在写 `audit_anchor_intents` 前取签名私钥：环境变量 `GML_ANCHOR_INTENT_KEY`
 *   优先，其次 `GML_RELEASE_SIGN_KEY`；都没配 ⇒ 返回 null（意图不签名，仍然写）。配置了却读不出来（不存在、权限过宽、在仓库内、不是 Ed25519）
 *   ⇒ **抛错**，由调用方在动手改库之前退出：宁可不执行，也不悄悄写出没签名的意图。加载规则与证据签名完全一致（evidence-sign.mjs 的 loadSigningKey）。
 * 【边界】私钥只存在于调用进程内存里，不写库、不进日志；库里只留 key_id（公钥指纹）与签名。
 * ============================================================================
 */
import { loadSigningKey } from './evidence-sign.mjs'

export const INTENT_KEY_ENV = 'GML_ANCHOR_INTENT_KEY'
export const FALLBACK_KEY_ENV = 'GML_RELEASE_SIGN_KEY'

export function loadIntentSigner(env = process.env) {
  const file = env[INTENT_KEY_ENV] || env[FALLBACK_KEY_ENV]
  if (!file) return null
  const which = env[INTENT_KEY_ENV] ? INTENT_KEY_ENV : FALLBACK_KEY_ENV
  try { return loadSigningKey(file) } catch (e) { throw Object.assign(new Error(`${which}: ${e.message}`), { code: 'INTENT_KEY_INVALID' }) }
}
