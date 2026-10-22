/**
 * ============================================================================
 * 文件标识：server/db/production-boot.js ｜ 生产 schema/config 初始化，隔离演示灌数
 * 修改前先运行 tests/runtime-isolation.test.mjs 并检查旧库保护。
 * ============================================================================
 */
/** Production schema/config boot. Never import demo boot or seed modules here. */
import { INDUSTRIES, initSchemaFor, dbPathFor } from './index.js'
import { runtimeMode, requireDataDirectory } from '../runtime.js'
import { ensureSettings } from '../lib/settings.js'

export function bootAll({ log, force = false } = {}) {
  if (runtimeMode() !== 'production' || force) {
    throw Object.assign(new Error('Production bootstrap requires production mode and forbids force/reset'), { code: 'PRODUCTION_BOOT_INVALID' })
  }
  requireDataDirectory()
  return Object.keys(INDUSTRIES).map((industry) => {
    const db = initSchemaFor(industry)
    ensureSettings(db)
    log?.(`Production schema ready: ${industry}; no demo business data or agent credentials generated`)
    return { industry, dbPath: dbPathFor(industry), seeded: false, rebuilt: false, tokens: 0 }
  })
}
