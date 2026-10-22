/**
 * ============================================================================
 * 文件标识：server/capabilities.js ｜ 未验收网络能力的生产门禁
 * 默认生产关闭演示通道；这不是身份/权限修复，也不提供环境变量强行开启的旁路。
 * ============================================================================
 */
import { runtimeMode } from './runtime.js'
import { bizFail } from './lib/http.js'

export const RESTRICTED_CAPABILITIES = Object.freeze([
  { id: 'public_mall', paths: ['/api/mall', '/api/promo/shop'], label: '公开商城与模拟支付' },
  { id: 'qimen_gateway', paths: ['/api/qimen'], label: '奇门模拟网关' },
  { id: 'oms_simulation', paths: [
    '/api/oms/sync', '/api/oms/stock-push', '/api/oms/qimen-message', '/api/oms/qimen-stock-message',
    '/api/oms/orders/:id/ship', '/api/oms/orders/:id/refund'
  ], label: 'OMS 模拟同步、平台回传与奇门演示报文' },
  { id: 'im_connector', paths: ['/api/im/sync', '/api/im/self-test'], label: '未验收 IM 同步与自检' },
  { id: 'agent_access', paths: ['/mcp', '/api/mcp'], label: 'Agent 工具与凭据管理' }
])

/** Runtime availability only; a true value in demo/test is not a security acceptance. */
export function runtimeCapabilities(env = process.env) {
  const enabled = runtimeMode(env) !== 'production'
  return Object.fromEntries(RESTRICTED_CAPABILITIES.map(({ id }) => [id, { enabled }]))
}

export function installCapabilityGates(app) {
  for (const capability of RESTRICTED_CAPABILITIES) {
    for (const prefix of capability.paths) {
      app.use(prefix, (_req, res, next) => {
        if (runtimeMode() !== 'production') return next()
        return bizFail(res, {
          status: 503,
          code: 'FEATURE_DISABLED',
          message: `${capability.label}尚未通过生产验收，本版本未启用`,
          detail: { capability: capability.id }
        })
      })
    }
  }
}
