/**
 * ============================================================================
 * 文件标识：scripts/lib/tests-tree.mjs ｜ tests/ 目录的确定性哈希（AA7：把"跑过的测试"绑定到包内清单）
 * ============================================================================
 * 【这是什么】对 tests/ 下每个普通文件取 sha256，再对排序后的 "<相对路径>\0<sha256>\n" 行取总哈希。
 *   发行包不携带 tests/（含 TLS 私钥夹具，不应随包分发），所以 package-release 写入 release/tests-tree.json
 *   （逐文件哈希清单，本身受 MANIFEST 逐文件哈希保护）；verify-release --evidence 由该清单重算总哈希，
 *   与 EVIDENCE.focused_tests.tests_tree_sha256 比对。
 * 【边界】符号链接一律拒绝（不跟随）。哈希只证明"跑的是这棵测试树"，不证明测试通过——通过与否是脚本亲自运行的结果。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'

const sha = bytes => createHash('sha256').update(bytes).digest('hex')

/** 返回 [{path, sha256}]，按 path 字节序排序；目录不存在返回 []。 */
export function listTestsTree(root, dir = 'tests') {
  const base = path.join(root, dir)
  if (!fs.existsSync(base)) return []
  const out = []
  const walk = (abs, rel) => {
    for (const item of fs.readdirSync(abs, { withFileTypes: true })) {
      const r = `${rel}/${item.name}`
      const full = path.join(abs, item.name)
      if (item.isSymbolicLink()) throw new Error(`${r}: symbolic links are not allowed in ${dir}/`)
      if (item.isDirectory()) walk(full, r)
      else if (item.isFile()) out.push({ path: r, sha256: sha(fs.readFileSync(full)) })
    }
  }
  walk(base, dir)
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** 由清单计算总哈希（与文件系统无关，verify-release 用包内清单调用它）。 */
export function hashEntries(entries) {
  const list = [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
  return sha(list.map(e => `${e.path}\0${e.sha256}\n`).join(''))
}

export const hashTestsTree = (root, dir = 'tests') => hashEntries(listTestsTree(root, dir))
export const TESTS_TREE_FILE = 'release/tests-tree.json'
