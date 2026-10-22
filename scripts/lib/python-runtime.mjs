/**
 * ============================================================================
 * 文件标识：scripts/lib/python-runtime.mjs ｜ XLSX 独立验收所需 Python/openpyxl 前置校验
 * 显式 GML_PYTHON 不回退；没有第三方读取器必须失败，不能跳过断言。
 * ============================================================================
 */
import { spawnSync } from 'node:child_process'

const PROBE = 'import json,sys,openpyxl; print(json.dumps({"executable":sys.executable,"version":sys.version.split()[0],"openpyxl":openpyxl.__version__}))'

export function resolvePythonRuntime(env = process.env, spawn = spawnSync) {
  const explicit = String(env.GML_PYTHON || '').trim()
  const candidates = explicit ? [explicit] : ['python3', 'python']
  const failures = []
  for (const executable of candidates) {
    const result = spawn(executable, ['-c', PROBE], {
      env, encoding: 'utf8', timeout: 10000, maxBuffer: 64 * 1024
    })
    if (!result.error && result.status === 0) {
      try {
        const value = JSON.parse(result.stdout.trim())
        if (typeof value.executable === 'string' && value.executable && typeof value.openpyxl === 'string' && value.openpyxl && typeof value.version === 'string') return value
      } catch { /* Malformed metadata is not verification evidence. */ }
      failures.push(`${executable}: invalid interpreter metadata`)
    } else {
      const reason = result.error?.code || (/No module named ['"]openpyxl/.test(result.stderr || '') ? 'openpyxl missing' : `probe exited ${result.status}`)
      failures.push(`${executable}: ${reason}`)
    }
  }
  const error = new Error(`Python/openpyxl verification unavailable (${failures.join('; ')}). Set GML_PYTHON to the verified Linux virtualenv interpreter. ${explicit ? 'The explicit interpreter was not replaced.' : ''}`)
  error.code = 'PYTHON_VERIFIER_UNAVAILABLE'
  throw error
}
