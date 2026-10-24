/**
 * ============================================================================
 * 文件标识：scripts/release-keygen.mjs ｜ 生成发行候选证据签名用的 Ed25519 密钥对（AB4，ADR-0047）
 * ============================================================================
 * 【用法】node scripts/release-keygen.mjs --out <绝对路径的新目录> [--purpose release|anchor-intent]
 *          node scripts/release-keygen.mjs --out <已有的保管目录> --purpose anchor-intent --rotate
 * 【做什么】在该目录写 <名>.key.pem（PKCS#8 私钥，0600，O_EXCL 独占创建）与 <名>.pub.pem（SPKI 公钥，0644），并打印公钥 key_id。目录以 0700 创建。
 *   · `--purpose release`（缺省）：release-sign.*，发行候选证据 / 离机锚点签名（`GML_RELEASE_SIGN_KEY`、`offbox-anchor --key`）。
 *   · `--purpose anchor-intent`（AF5，ADR-0055 补充 2）：anchor-intent.*，审计锚点操作意图签名（`GML_ANCHOR_INTENT_KEY`）。**与发行密钥分开保管**：
 *     意图私钥放在执行 retention / audit-archive / privacy-erase 的操作机上，公钥带外交给复核方（`audit-verify-chain --intent-pubkey`）。
 *   两种用途的拒绝规则完全相同；用途只决定文件名与提示，不改变密钥格式。
 * 【轮换】`--rotate`（AG5，ADR-0055 补充 3）：`--out` 必须是**已存在**的保管目录，且其中已有本用途的公钥（`<名>.pub.pem` 或 `<名>-<指纹>.pub.pem`，必须都能解析）。
 *   在同一目录新建一对 `<名>-<key_id 前 16 位十六进制>.key.pem` / `.pub.pem`；旧的私钥与公钥原样保留（私钥永不覆盖，O_EXCL），输出里列出保留的公钥 key_id。
 *   旧私钥该留还是销毁由操作者决定（见 docs/operations/audit-integrity.md §8c）；整个目录可以直接当作 `--intent-pubkey` 的公钥集合。
 *   轮换同样拒绝仓库 / git 工作树内（含符号链接）、相对路径、对组 / 其他可写的目录；失败时不留本次创建的文件。
 * 【拒绝】相对路径；位于本仓库或任何 git 工作树内（含经符号链接指进去）；已存在且非空（或不是目录）。失败时不留文件。
 *   私钥内容永不打印。保管方式见 docs/release/README.md。
 * ============================================================================
 */
import fs from 'node:fs'
import path from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { assertOutsideRepository, loadPublicKey, publicKeyId } from './lib/evidence-sign.mjs'

const PURPOSES = {
  release: { name: 'release-sign', note: 'Keep the private key off the repository and off shared storage; distribute only the public key (out of band).' },
  'anchor-intent': { name: 'anchor-intent', note: 'Set GML_ANCHOR_INTENT_KEY to the private key path on the operator machine that runs retention / audit-archive / privacy-erase; keep it separate from GML_RELEASE_SIGN_KEY (do not reuse the release key), off the repository and off the business host. Give the public key to verifiers out of band (audit-verify-chain --intent-pubkey).' }
}

function main() {
  const argv = process.argv.slice(2)
  const USAGE = 'usage: release-keygen.mjs --out <absolute new directory> [--purpose release|anchor-intent] | --out <existing custody directory> [--purpose ...] --rotate'
  let out
  let purpose
  let rotate = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--rotate') { if (rotate) throw new Error(`Unknown or repeated argument: ${argv[i]} (${USAGE})`); rotate = true; continue }
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
  let retained = []
  if (rotate) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`--rotate needs the existing custody directory; ${dir} does not exist or is not a directory (create the first pair without --rotate)`)
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error(`${dir} is a symbolic link; pass the real custody directory to --rotate`)
    assertOutsideRepository(fs.realpathSync(dir), '--out (after resolving)')
    if (process.platform !== 'win32' && (fs.statSync(dir).mode & 0o022) !== 0) throw new Error(`${dir} is writable by group/others; refusing to rotate keys in it (chmod 700)`)
    const own = new RegExp(`^${spec.name}(?:-[0-9a-f]{16})?\\.pub\\.pem$`)
    for (const n of fs.readdirSync(dir).filter((x) => own.test(x)).sort()) retained.push({ file: path.join(dir, n), key_id: publicKeyId(loadPublicKey(path.join(dir, n))) })
    if (!retained.length) throw new Error(`${dir} holds no previous ${spec.name} public key; --rotate keeps the previous public key, so there is nothing to rotate (create the first pair without --rotate)`)
  } else if (fs.existsSync(dir)) {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} exists and is not a directory`)
    if (fs.readdirSync(dir).length) throw new Error(`${dir} is not empty; refusing to write keys next to existing files`)
    fs.chmodSync(dir, 0o700)
  } else fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (!rotate) assertOutsideRepository(fs.realpathSync(dir), '--out (after creation)') // 创建后按真实路径再判一次
  const created = []
  try {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const stem = rotate ? `${spec.name}-${publicKeyId(publicKey).slice(0, 16)}` : spec.name // 轮换出的新文件名带指纹，永远不会与旧文件同名
    const privFile = path.join(dir, `${stem}.key.pem`)
    const pubFile = path.join(dir, `${stem}.pub.pem`)
    // 先独占创建（成功后立刻登记）再写内容：写到一半失败（如磁盘满）时，残留的半截文件也会被清理；EEXIST 时不会登记，也就不会误删别人的文件（Codex AG5-M3）
    const make = (file, data, mode) => { const fd = fs.openSync(file, 'wx', mode); created.push(file); try { fs.writeSync(fd, data) } finally { fs.closeSync(fd) } }
    make(privFile, privateKey.export({ type: 'pkcs8', format: 'pem' }), 0o600)
    fs.chmodSync(privFile, 0o600)
    make(pubFile, publicKey.export({ type: 'spki', format: 'pem' }), 0o644)
    console.log(JSON.stringify({ purpose, private_key: privFile, public_key: pubFile, key_id: publicKeyId(publicKey), ...(rotate ? { rotated: true, retained_public_keys: retained } : {}), note: spec.note }, null, 2))
  } catch (error) {
    for (const f of created) fs.rmSync(f, { force: true }) // 只删本次调用自己创建的文件
    throw error
  }
}
try { main() } catch (error) { console.error(`[release-keygen] ${error.message}`); process.exitCode = 1 }
