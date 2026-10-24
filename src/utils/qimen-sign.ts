/**
 * ============================================================================
 * 文件标识：src/utils/qimen-sign.ts ｜ 奇门网关签名（调试台用）：canonical JSON + HMAC-SHA256，与 server/lib/qimen-auth.js 同一契约（ADR-0033）
 * ============================================================================
 * 【职责】按契约生成 `sign`：HMAC-SHA256(平台密钥, app_key\nmethod\ntimestamp\nnonce\nsha256hex(canonicalJson(request)))，大写十六进制。
 * 【为什么在前端】调试台让管理员粘贴刚签发的密钥来联调；密钥只在内存里参与计算，不写 localStorage、不发给任何后端接口
 *   （发给网关的只有签名结果）。浏览器 `crypto.subtle` 仅在 HTTPS / localhost 可用，不可用时抛出可读错误。
 * 【改它要注意什么】契约以服务端为准；改规则时同步 `server/lib/qimen-auth.js` 与 `tests/qimen-auth.test.mjs`。
 * ============================================================================
 */

const MAX_DEPTH = 32

/** 递归键名升序、无空白的 JSON；超深抛错。 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > MAX_DEPTH) throw new Error('request 嵌套过深')
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value)
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v, depth + 1)).join(',')}]`
  const obj = value as Record<string, unknown>
  const parts: string[] = []
  for (const k of Object.keys(obj).sort()) {
    if (obj[k] === undefined) continue
    parts.push(`${JSON.stringify(k)}:${canonicalJson(obj[k], depth + 1)}`)
  }
  return `{${parts.join(',')}}`
}

const hex = (buf: ArrayBuffer) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('')

export interface QimenSignParts {
  appKey: string
  method: string
  timestamp: string
  nonce: string
  request?: unknown
}

export async function signQimen(secret: string, p: QimenSignParts): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (!subtle) throw new Error('当前页面环境不支持 WebCrypto（需要 HTTPS 或 localhost）')
  const enc = new TextEncoder()
  const digest = hex(await subtle.digest('SHA-256', enc.encode(canonicalJson(p.request ?? {}))))
  const canonical = [p.appKey, p.method, p.timestamp, p.nonce, digest].join('\n')
  const key = await subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return hex(await subtle.sign('HMAC', key, enc.encode(canonical))).toUpperCase()
}

/** 32 位十六进制随机 nonce */
export function newNonce(): string {
  const b = new Uint8Array(16)
  globalThis.crypto.getRandomValues(b)
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')
}
