/**
 * ============================================================================
 * 文件标识：server/lib/backup-alert.js ｜ 备份失败告警钩子：经现有通知渠道发送，成功静默（ADR-0029）
 * ============================================================================
 * 【职责】`scripts/db-backup.mjs` 有失败时，若 `GML_ALERT_CHANNEL` 指向一个**已存在**的通知渠道，
 *   就经 notify.js 的 `pushToChannel`（出站策略 ADR-0008 在其内部强制：协议/主机/DNS 逐地址/不跟重定向）发一条简短告警。
 *
 * 【内容边界】告警只含：标题、时间、失败的行业码、错误**码**（冒号前的 BACKUP_* 常量）、数据目录的**目录名**。
 *   不含错误原文（可能带路径）、不含任何密钥/URL/sha256/文件路径。
 *
 * 【失败不被吞】返回 { status, detail }：disabled / channel_missing / sent / failed / error，由脚本写 stderr；
 *   告警本身失败不改变备份的退出码（备份已因失败而非零）。发送器可注入，便于测试。
 * ============================================================================
 */
import path from 'node:path'
import { pushToChannel } from './notify.js'

const CODE_RE = /^[A-Z][A-Z0-9_]{2,63}$/

/** 从 `BACKUP_VERIFY_FAILED: ...原文...` 里只取错误码；取不到 ⇒ BACKUP_FAILED */
export function errorCodeOf(error) {
  const head = String(error || '').split(':')[0].trim()
  return CODE_RE.test(head) ? head : 'BACKUP_FAILED'
}

/** 组装告警摘要（notify 的 digest 形状：一组、每个失败库一行）。成功（无失败）⇒ null。 */
export function buildBackupAlert({ results, dataDir, now = new Date() }) {
  const failedRows = (results || []).filter((r) => r.status === 'failed')
  if (!failedRows.length) return null
  const items = failedRows.map((r) => ({ doc_no: `${String(r.code).slice(0, 32)}: ${errorCodeOf(r.error)}`, amount: 0 }))
  return {
    title: `备份失败告警（${path.basename(String(dataDir || '')) || 'data'}）`,
    generated_at: now.toISOString(),
    total: items.length,
    total_amount: 0,
    groups: [{ key: 'backup_failed', label: '备份失败的库', count: items.length, amount: 0, items }]
  }
}

/**
 * @param channelCode  GML_ALERT_CHANNEL 的值
 * @param lookup       (code) => { db, channel, close? } | null  找渠道（脚本侧按行业库依次找）
 * @param sender       默认 pushToChannel；测试注入
 */
export async function sendBackupAlert({ channelCode, results, dataDir, lookup, sender = pushToChannel }) {
  const code = String(channelCode || '').trim()
  if (!code) return { status: 'disabled' }
  const digest = buildBackupAlert({ results, dataDir })
  if (!digest) return { status: 'silent' } // 全部成功：不发
  let found = null
  try {
    found = lookup(code)
    if (!found?.channel) return { status: 'channel_missing', detail: `渠道「${code.slice(0, 64)}」不存在` }
    const r = await sender(found.db, found.channel, digest, { triggeredBy: 'db-backup' })
    return r?.status === 'success' ? { status: 'sent' } : { status: 'failed', detail: String(r?.error || r?.status || 'unknown').slice(0, 200) }
  } catch (e) {
    return { status: 'error', detail: String(e?.code || e?.message || e).slice(0, 200) }
  } finally {
    try { found?.close?.() } catch { /* 关库失败不影响告警结果 */ }
  }
}

export default { errorCodeOf, buildBackupAlert, sendBackupAlert }
