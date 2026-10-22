/**
 * ============================================================================
 * 文件标识：server/version.js ｜ 版本与构建 SHA 的**唯一出处**（/api、健康检查、AI 清单、MCP serverInfo 共用）
 * ============================================================================
 * 【这块解决什么问题】
 *   审阅 F16：`/api` 写 1.2.0、`/api/meta/health` 与 AI manifest 写 1.0.0、package.json 另有一套，
 *   运维按健康检查判断发布版本时**判不准**。版本只能有一处：`package.json`，这里读一次、全站引用。
 *
 * 【为什么这样设计】
 *   · 版本：启动时同步读 `package.json`（ESM 下不用 import assertion，避免 Node 版本差异）；
 *   · 构建 SHA：**不猜、不自己跑 git**。优先 `GML_BUILD_SHA`（容器构建时由 `--build-arg` 注入），
 *     其次发行包根目录 `MANIFEST.json` 的 `baseCommit`（`scripts/package-release.mjs` 生成），
 *     都没有 ⇒ `null`，接口照实返回 null，不编一个值。
 *   · SHA 只接受 7–64 位十六进制（去空白、小写化），其它一律视为"没有"——
 *     运行时错误配置不该变成看起来像版本号的垃圾。
 *
 * 【改它要注意】
 *   · 新增对外暴露版本的接口一律 `import { versionInfo }`，不要再写字面量；
 *   · `tests/version-contract.test.mjs` 断言 /api、health、manifest、MCP 四处与 package.json 一致。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SHA_PATTERN = /^[0-9a-f]{7,64}$/

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8'))
  } catch {
    return null
  }
}

/** 应用版本：`package.json` 的 `version`，启动时读一次。 */
export const VERSION = String(readJson('package.json')?.version || '0.0.0')

function normalizeSha(value) {
  const sha = String(value ?? '').trim().toLowerCase()
  return SHA_PATTERN.test(sha) ? sha : null
}

/**
 * 构建 SHA：`GML_BUILD_SHA` 环境变量优先；其次发行包 `MANIFEST.json.baseCommit`；没有就是 `null`。
 * 环境变量**给了但不合法**时也返回 null（不回落到 MANIFEST，避免两处来源混用）。
 */
export function buildSha(env = process.env) {
  if (env.GML_BUILD_SHA !== undefined) return normalizeSha(env.GML_BUILD_SHA)
  return normalizeSha(readJson('MANIFEST.json')?.baseCommit)
}

/** 统一对外形状：`{ version, build_sha }`。 */
export function versionInfo(env = process.env) {
  return { version: VERSION, build_sha: buildSha(env) }
}
