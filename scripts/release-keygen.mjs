/**
 * ============================================================================
 * 文件标识：scripts/release-keygen.mjs ｜ 生成发行候选证据签名用的 Ed25519 密钥对（AB4，ADR-0047）
 * ============================================================================
 * 【用法】node scripts/release-keygen.mjs --out <绝对路径的新目录>
 * 【做什么】在该目录写 release-sign.key.pem（PKCS#8 私钥，0600，O_EXCL 独占创建）与 release-sign.pub.pem（SPKI 公钥，0644），
 *   并打印公钥 key_id。目录以 0700 创建。
 * 【拒绝】相对路径；位于本仓库或任何 git 工作树内（含经符号链接指进去）；已存在且非空（或不是目录）。失败时不留文件。
 *   私钥内容永不打印。保管方式见 docs/release/README.md。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { assertOutsideRepository, publicKeyId } from './lib/evidence-sign.mjs'
import { writeExclusive } from './lib/safe-path.mjs'

function main() {
  const argv = process.argv.slice(2)
  let out
  for (let i = 0; i < argv.length; i++) {
    const m = /^--out(?:=(.*))?$/.exec(argv[i])
    if (!m || out !== undefined) throw new Error(`Unknown or repeated argument: ${argv[i]} (usage: release-keygen.mjs --out <absolute new directory>)`)
    out = m[1] ?? argv[++i]
  }
  if (typeof out !== 'string' || !out || out.startsWith('--')) throw new Error('usage: release-keygen.mjs --out <absolute new directory>')
  if (!path.isAbsolute(out)) throw new Error('--out must be an absolute path')
  const dir = path.resolve(out)
  assertOutsideRepository(dir, '--out')
  if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`)
    if (fs.readdirSync(dir).length) throw new Error(`${dir} is not empty; refusing to write keys next to existing files`)
    fs.chmodSync(dir, 0o700)
  } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const privFile = path.join(dir, 'release-sign.key.pem')
  const pubFile = path.join(dir, 'release-sign.pub.pem')
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    writeExclusive(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }))
    fs.chmodSync(privFile, 0o600)
    fs.writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }), { flag: 'wx', mode: 0o644 })
    console.log(JSON.stringify({ private_key: privFile, public_key: pubFile, key_id: publicKeyId(publicKey), note: 'Keep the private key off the repository and off shared storage; distribute only the public key (out of band).' }, null, 2))
  } catch (error) {
    fs.rmSync(privFile, { force: true }); fs.rmSync(pubFile, { force: true })
    throw error
  }
}
try { main() } catch (error) { console.error(`[release-keygen] ${error.message}`); process.exitCode = 1 }
