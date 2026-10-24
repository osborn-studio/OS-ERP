/**
 * ============================================================================
 * 文件标识：scripts/release-keygen.mjs ｜ 生成发行候选证据签名用的 Ed25519 密钥对（AB4，ADR-0047）
 * ============================================================================
 * 【用法】node scripts/release-keygen.mjs --out <绝对路径的新目录> [--purpose release|anchor-intent]
 * 【做什么】在该目录写 <名>.key.pem（PKCS#8 私钥，0600，O_EXCL 独占创建）与 <名>.pub.pem（SPKI 公钥，0644），并打印公钥 key_id。目录以 0700 创建。
 *   · `--purpose release`（缺省）：release-sign.*，发行候选证据 / 离机锚点签名（`GML_RELEASE_SIGN_KEY`、`offbox-anchor --key`）。
 *   · `--purpose anchor-intent`（AF5，ADR-0055 补充 2）：anchor-intent.*，审计锚点操作意图签名（`GML_ANCHOR_INTENT_KEY`）。**与发行密钥分开保管**：
 *     意图私钥放在执行 retention / audit-archive / privacy-erase 的操作机上，公钥带外交给复核方（`audit-verify-chain --intent-pubkey`）。
 *   两种用途的拒绝规则完全相同；用途只决定文件名与提示，不改变密钥格式。
 * 【拒绝】相对路径；位于本仓库或任何 git 工作树内（含经符号链接指进去）；已存在且非空（或不是目录）。失败时不留文件。
 *   私钥内容永不打印。保管方式见 docs/release/README.md。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { assertOutsideRepository, publicKeyId } from './lib/evidence-sign.mjs'
import { writeExclusive } from './lib/safe-path.mjs'

const PURPOSES = {
  release: { name: 'release-sign', note: 'Keep the private key off the repository and off shared storage; distribute only the public key (out of band).' },
  'anchor-intent': { name: 'anchor-intent', note: 'Set GML_ANCHOR_INTENT_KEY to the private key path on the operator machine that runs retention / audit-archive / privacy-erase; keep it separate from GML_RELEASE_SIGN_KEY (do not reuse the release key), off the repository and off the business host. Give the public key to verifiers out of band (audit-verify-chain --intent-pubkey).' }
}

function main() {
  const argv = process.argv.slice(2)
  const USAGE = 'usage: release-keygen.mjs --out <absolute new directory> [--purpose release|anchor-intent]'
  let out
  let purpose
  for (let i = 0; i < argv.length; i++) {
    const m = /^--(out|purpose)(?:=(.*))?$/.exec(argv[i])
    if (!m) throw new Error(`Unknown or repeated argument: ${argv[i]} (${USAGE})`)
    if (m[1] === 'out') { if (out !== undefined) throw new Error(`Unknown or repeated argument: ${argv[i]} (${USAGE})`); out = m[2] ?? argv[++i] }
    else { if (purpose !== undefined) throw new Error(`Unknown or repeated argument: ${argv[i]} (${USAGE})`); purpose = m[2] ?? argv[++i] ?? '' }
  }
  purpose ??= 'release'
  const spec = Object.hasOwn(PURPOSES, purpose) ? PURPOSES[purpose] : null // 不能用 PURPOSES[purpose]：'constructor' / '__proto__' 会命中原型上的属性
  if (!spec) throw new Error(`--purpose must be one of: ${Object.keys(PURPOSES).join(', ')} (got ${JSON.stringify(purpose)})`)
  if (typeof out !== 'string' || !out || out.startsWith('--')) throw new Error(USAGE)
  if (!path.isAbsolute(out)) throw new Error('--out must be an absolute path')
  const dir = path.resolve(out)
  assertOutsideRepository(dir, '--out')
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`)
    if (fs.readdirSync(dir).length) throw new Error(`${dir} is not empty; refusing to write keys next to existing files`)
    fs.chmodSync(dir, 0o700)
  } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  assertOutsideRepository(fs.realpathSync(dir), '--out (after creation)') // 创建后按真实路径再判一次
  const privFile = path.join(dir, `${spec.name}.key.pem`)
  const pubFile = path.join(dir, `${spec.name}.pub.pem`)
  const created = []
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeExclusive(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    created.push(privFile)
    fs.chmodSync(privFile, 0o600)
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 })
    created.push(pubFile)
    console.log(JSON.stringify({ purpose, private_key: privFile, public_key: pubFile, key_id: publicKeyId(publicKey), note: spec.note }, null, 2))
  } catch (error) {
    for (const f of created) fs.rmSync(f, { force: true }) // 只删本次调用自己创建的文件
    throw error
  }
}
try { main() } catch (error) { console.error(`[release-keygen] ${error.message}`); process.exitCode = 1 }
