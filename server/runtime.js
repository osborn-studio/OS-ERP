/**
 * ============================================================================
 * 文件标识：server/runtime.js ｜ 运行模式及显式数据目录的统一校验
 * 修改前先运行 tests/runtime-isolation.test.mjs 并检查旧库保护。
 * ============================================================================
 */
/** OS EGP runtime policy. NODE_ENV controls tooling; this mode controls business data. */
import path from 'node:path'

export function runtimeMode(env = process.env) {
  const mode = env.GML_RUNTIME_MODE ?? 'production'
  if (!['production', 'demo', 'test'].includes(mode)) {
    throw Object.assign(new Error('GML_RUNTIME_MODE must be production, demo or test'), { code: 'RUNTIME_MODE_INVALID' })
  }
  return mode
}

export function requireDataDirectory(env = process.env) {
  runtimeMode(env)
  if (!env.GML_DATA_DIR || !path.isAbsolute(env.GML_DATA_DIR)) {
    throw Object.assign(new Error('Set an explicit absolute GML_DATA_DIR; implicit repository data is disabled'), { code: 'DATA_DIRECTORY_REQUIRED' })
  }
  return env.GML_DATA_DIR
}

export function requireDemoRuntime(env = process.env) {
  const mode = runtimeMode(env)
  if (mode === 'production') {
    throw Object.assign(new Error('Demo initialization and reset are forbidden in production mode'), { code: 'DEMO_OPERATION_FORBIDDEN' })
  }
  requireDataDirectory(env)
  return mode
}
