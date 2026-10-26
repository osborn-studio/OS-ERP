/**
 * ============================================================================
 * 文件标识：server/lib/audit-anchor-manifest.js ｜ 审计链尾 / 锚点摘要的离机清单：生成、读取、与在用库比对（ADR-0049 补充，AC7）
 * ============================================================================
 * 【职责】
 *   · `summarizeAuditChain(db)`：对一个库（备份快照或在用库）跑链校验，给出 { present, verified, rows, first_id, last_id, tip_hash,
 *     anchors_count, anchors_digest, anchors }。`db-backup.mjs` 把它写进备份清单（报告 + `<备份>.audit-manifest.json`，加密模式再加
 *     `<备份>.audit-manifest.enc`）；这份数据是**离机保存**的对象：能写库的人可以整链重算，只有库外的 tip 才拆得穿。
 *   · `loadBackupManifest(set, key)`：读清单并交叉核对——明文 vs 密文清单、清单 vs 备份文件本身（明文备份直接读；密文备份有密钥就解到 0600 临时文件读、读完擦除）。
 *     任何一处对不上 ⇒ `manifest-mismatch`（清单被改，或备份被换）。
 *   · `compareLiveToBackup(db, manifest, opts)`：在用链是否是备份链尾的**后代**：在用库里同 id 的行 row_hash 相同 ⇒ ok；不同 ⇒ rewrite
 *     （`tip-row-differs`）；在用链比备份还短 ⇒ rewrite（`behind`）；尾行已被归档搬走 ⇒ 需要 `archiveDir` 里的摘要 + JSONL 证明
 *     （按 `boundary_id` / `first_prev_hash` 一路接到在用库的 `archive` 锚点），否则 `unverifiable`。锚点只做**增删清单**：新增的列出来
 *     （合法来源：保留清理 / 隐私抹除 / 归档；伪造的锚点也长这样，所以 `--strict-anchors` 可让它们失败），备份里有而在用链范围内消失的算 rewrite。
 * 【不做】不修改任何库；不保存密钥；临时明文只在 `os.tmpdir()` 下的 0600 文件里短暂存在并被 shred。
 * 【边界】清单本身与链一样不防“同时改库和清单”的攻击者——离机保存才是关键（docs/operations/audit-integrity.md §6）。
 * ============================================================================
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import Database from 'better-sqlite3'
import { verifyChain, verifyJsonlSegment, chainColumnsPresent } from './audit-chain-verify.js'
import { decryptFile, shredFile } from './backup-crypto.js'

export const MANIFEST_FORMAT = 'os-erp-backup-audit-manifest/1'
const ANCHOR_COLS = 'kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason, created_at'

const anchorKey = (a) => JSON.stringify([a.kind, a.at_row_id, a.anchor_hash, a.prev_id ?? null, a.prev_row_hash ?? null])

export function anchorsDigest(list) {
  const canon = list.map((a) => [a.kind, a.at_row_id, a.anchor_hash, a.prev_id ?? null, a.prev_row_hash ?? null, a.reason ?? null, a.created_at ?? null])
  return createHash('sha256').update(JSON.stringify(canon), 'utf8').digest('hex')
}

export function sha256FileSync(file) {
  const h = createHash('sha256')
  const fd = fs.openSync(file, 'r')
  try {
    const buf = Buffer.allocUnsafe(1 << 20)
    for (let n = fs.readSync(fd, buf, 0, buf.length, null); n > 0; n = fs.readSync(fd, buf, 0, buf.length, null)) h.update(buf.subarray(0, n))
  } finally {
    fs.closeSync(fd)
  }
  return h.digest('hex')
}

/** 逐行读 JSONL（分块，内存与文件大小无关）；回调返回 false 提前结束 */
export function forEachJsonlRow(file, cb) {
  const fd = fs.openSync(file, 'r')
  try {
    const chunk = Buffer.allocUnsafe(1 << 20)
    let carry = Buffer.alloc(0)
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null)
      if (n === 0) break
      let start = 0
      const data = chunk.subarray(0, n)
      for (let nl = data.indexOf(10, start); nl !== -1; nl = data.indexOf(10, start)) {
        const line = (carry.length ? Buffer.concat([carry, data.subarray(start, nl)]) : data.subarray(start, nl)).toString('utf8')
        carry = Buffer.alloc(0)
        start = nl + 1
        if (line && cb(JSON.parse(line)) === false) return
      }
      if (start < data.length) carry = Buffer.concat([carry, data.subarray(start)])
    }
    if (carry.length) cb(JSON.parse(carry.toString('utf8')))
  } finally {
    fs.closeSync(fd)
  }
}

export function summarizeAuditChain(db) {
  const hasTable = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_logs'").get()
  if (!hasTable || !chainColumnsPresent(db)) return { present: false }
  const anchors = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='audit_chain_anchors'").get()
    ? db.prepare(`SELECT ${ANCHOR_COLS} FROM audit_chain_anchors ORDER BY id`).all()
    : []
  const v = verifyChain(db)
  return {
    present: true, verified: v.ok, rows: v.rows, first_id: v.firstId, last_id: v.lastId, tip_hash: v.tipHash,
    anchors_count: anchors.length, anchors_digest: anchorsDigest(anchors), anchors,
    ...(v.brk ? { break: v.brk } : {})
  }
}

/** 报告里放的版本：不带锚点明细（清单侧车里才有） */
export const withoutAnchorList = ({ anchors, ...rest }) => rest

export function buildManifest({ industry, backupFile, backupSha256, summary }) {
  return { format: MANIFEST_FORMAT, industry, backup_file: path.basename(backupFile), backup_sha256: backupSha256, created_at: new Date().toISOString(), audit_chain: summary }
}

function withTempPlain(set, key, fn) {
  const tmp = path.join(os.tmpdir(), `.os-erp-audit-manifest-${randomBytes(6).toString('hex')}.plain.tmp`)
  try {
    decryptFile(set, tmp, key)
    return fn(tmp)
  } finally {
    shredFile(tmp)
  }
}

/**
 * 读清单 + 交叉核对。返回 { ok:true, manifest, source, notes } 或 { ok:false, status, message }。
 * `set` = 备份文件（.db / .db.enc）或其 `.audit-manifest.json`。
 */
export function loadBackupManifest(set, key) {
  const plainPath = set.endsWith('.audit-manifest.json') ? set : `${set}.audit-manifest.json`
  const backupFile = plainPath.slice(0, -'.audit-manifest.json'.length)
  const encPath = `${backupFile}.audit-manifest.enc`
  const bad = (status, message) => ({ ok: false, status, message })
  let plain = null
  let enc = null
  try { if (fs.existsSync(plainPath)) plain = JSON.parse(fs.readFileSync(plainPath, 'utf8')) } catch (e) { return bad('manifest-mismatch', `明文清单无法解析：${e.message}`) }
  const notes = []
  // 密文产物存在而没有密钥 ⇒ 无法认证 / 重算，不能让明文清单单独放行（否则改明文清单即可伪造"后代"）
  if (!key && (fs.existsSync(encPath) || (backupFile.endsWith('.enc') && fs.existsSync(backupFile)))) {
    return bad('key-required', '备份 / 清单是加密的：需要设置 GML_BACKUP_KEY 才能认证清单并从备份内容重算（拒绝只信明文清单）')
  }
  if (fs.existsSync(encPath)) {
    if (key) {
      try { enc = withTempPlain(encPath, key, (tmp) => JSON.parse(fs.readFileSync(tmp, 'utf8'))) } catch (e) { return bad('manifest-mismatch', `加密清单认证 / 解析失败：${e.code || e.message}`) }
    }
  }
  const manifest = enc || plain
  if (!manifest) return bad('manifest-missing', `找不到备份清单：${plainPath}`)
  if (manifest.format !== MANIFEST_FORMAT || !manifest.audit_chain) return bad('manifest-mismatch', '清单格式不符')
  if (plain && enc && JSON.stringify(plain) !== JSON.stringify(enc)) return bad('manifest-mismatch', '明文清单与加密清单不一致（明文清单被改？）')
  const source = enc ? 'encrypted' : 'plain'
  const chain = manifest.audit_chain
  if (chain.present) {
    // 锚点明细必须与摘要自洽：否则可以保留原摘要、把明细换成伪造的在用锚点，让"新增 / 消失"清单全空
    if (!Array.isArray(chain.anchors) || chain.anchors.length !== chain.anchors_count || anchorsDigest(chain.anchors) !== chain.anchors_digest) {
      return bad('manifest-mismatch', '清单里的锚点明细与其 anchors_digest / anchors_count 不自洽')
    }
  }
  if (fs.existsSync(backupFile)) {
    if (manifest.backup_sha256 && sha256FileSync(backupFile) !== manifest.backup_sha256) return bad('manifest-mismatch', '备份文件 sha256 与清单不符（备份被替换或改动）')
    // 以备份内容本身为准重算：清单被改、或清单来自另一份备份都在这里现形
    const recompute = (file) => {
      const db = new Database(file, { readonly: true })
      try { return summarizeAuditChain(db) } finally { db.close() }
    }
    let actual = null
    actual = backupFile.endsWith('.enc') ? withTempPlain(backupFile, key, recompute) : recompute(backupFile)
    if (actual) {
      // 断链摘要只描述有效前缀；不能让清单把此前缀伪装成已验证的完整基线。
      const same = chain.present === actual.present &&
        (!chain.present || (chain.verified === actual.verified && isDeepStrictEqual(chain.break ?? null, actual.break ?? null) &&
          chain.tip_hash === actual.tip_hash && chain.last_id === actual.last_id && chain.rows === actual.rows && chain.anchors_digest === actual.anchors_digest))
      if (!same) return bad('manifest-mismatch', '清单中的链验证状态 / 断点 / 链尾 / 锚点摘要与备份内容重算结果不一致')
      notes.push('已从备份内容重算并与清单一致')
    }
  } else notes.push('备份文件不在本机，仅核对了清单自身' + (enc ? '' : '（明文清单未经认证）'))
  return { ok: true, manifest, source, notes }
}

/**
 * 打开 archiveDir 的归档摘要索引：只收本行业、格式正确的摘要；`fileOk(d)` 对 JSONL 逐行重算哈希并核对摘要的行数 / 端点 / 首行 prev_hash / 段尾（带缓存）。
 * 摘要和 JSONL 都在可被改的介质上，所以除 sha256 外必须逐行验链；验不过的摘要不被任何用途采信。
 */
export function openArchiveIndex(archiveDir, industry) {
  const digests = []
  for (const f of archiveDir && fs.existsSync(archiveDir) ? fs.readdirSync(archiveDir) : []) {
    if (!f.endsWith('.digest.json')) continue
    try {
      const d = JSON.parse(fs.readFileSync(path.join(archiveDir, f), 'utf8'))
      if (d.format === 'os-erp-audit-archive/1' && d.industry === industry) digests.push(d)
    } catch { /* 无法解析的文件忽略 */ }
  }
  const okFiles = new Map()
  const fileOk = (d) => {
    if (!okFiles.has(d)) {
      const p = path.join(archiveDir, path.basename(d.file))
      let good = null
      if (fs.existsSync(p) && sha256FileSync(p) === d.file_sha256) {
        const v = verifyJsonlSegment(p, Array.isArray(d.anchors) ? d.anchors : [])
        if (v.ok && v.rows === d.rows && v.firstId === d.first_id && v.lastId === d.last_id && v.firstPrevHash === d.first_prev_hash && v.tipHash === d.tip_row_hash) good = p
      }
      okFiles.set(d, good)
    }
    return okFiles.get(d)
  }
  return { digests, fileOk }
}

/**
 * 与在用库**连得上**的归档摘要链（AF5）：从在用库第一行的 `archive` 锚点（at_row_id = 在用库最小审计行 id，anchor_hash = 摘要段尾）往回，
 * 沿 `boundary_id` / `first_prev_hash` / `tip_row_hash` 一段一段接上去，每段 JSONL 都必须验证通过。不在这条链上的摘要（目录里被人放进来的、
 * 自洽但不属于本库的文件）既不能提供锚点清单也不能提供印证行。返回 [最新段, …, 最旧段]；在用库第一行不是 archive 边界 ⇒ []。
 */
export function connectedArchive(live, index) {
  const first = live.prepare('SELECT MIN(id) AS id FROM audit_logs').get().id
  if (first == null) return []
  const hashes = new Set(live.prepare("SELECT anchor_hash FROM audit_chain_anchors WHERE kind='archive' AND at_row_id=?").all(first).map((r) => r.anchor_hash))
  const chain = []
  let cur = index.digests.find((d) => d.boundary_id === first && hashes.has(d.tip_row_hash) && index.fileOk(d))
  while (cur && !chain.includes(cur)) {
    chain.push(cur)
    cur = index.digests.find((d) => d.boundary_id === chain.at(-1).first_id && d.tip_row_hash === chain.at(-1).first_prev_hash && index.fileOk(d))
  }
  return chain
}

/**
 * 基线（备份清单 / 离机锚点条目 `base` = { first_id, last_id, anchors }）之后，基线时存活的行是否被归档搬出过库、因而需要归档证据（AF5）：
 * 在用库第一行是 `archive` 锚点的边界、且 id 大于基线 first_id。需要时 `connectedArchive` 必须一路接到覆盖 `base.first_id` 的那一段，否则对账是盲的。
 * 返回 { needed, ok, chain }。
 */
export function archiveEvidence(live, index, base) {
  const first = live.prepare('SELECT MIN(id) AS id FROM audit_logs').get().id
  if (base.first_id == null || base.last_id == null || first == null || first <= base.first_id) return { needed: false, ok: true, chain: [] }
  const boundary = live.prepare("SELECT 1 FROM audit_chain_anchors WHERE kind='archive' AND at_row_id=? LIMIT 1").get(first)
  const chain = connectedArchive(live, index)
  if (!boundary) return { needed: false, ok: true, chain }
  return { needed: true, ok: chain.length > 0 && chain.at(-1).first_id <= base.first_id, chain }
}

/**
 * 基线之后被归档搬出库的锚点（AF5）：在**连得上、验证通过的**摘要（`connectedArchive`）里、`first_id ≤ at_row_id ≤ last_id`（基线时存活行上的锚点）
 * 且不在基线锚点清单里的锚点。早于基线的归档只涉及 `< first_id` 的行，不在此列；基线之后的追加区间（`> last_id`）是正常增长。
 * 这些锚点已不在库里，却仍被摘要用来承认 JSONL 里的断口——伪造的桥锚点可以借一次归档洗出库，所以也要做意图对账。
 * `chain` = connectedArchive 的结果。
 */
export function archivedAnchorsSince(chain, { first_id: firstId, last_id: lastId, anchors }) {
  if (firstId == null || lastId == null || !Array.isArray(anchors)) return []
  const had = new Set(anchors.map(anchorKey))
  const out = []
  const seen = new Set()
  for (const d of chain) {
    if (!Array.isArray(d.anchors)) continue
    for (const a of d.anchors) {
      if (!a || typeof a !== 'object' || !Number.isSafeInteger(a.at_row_id) || a.at_row_id < firstId || a.at_row_id > lastId) continue
      const k = anchorKey(a)
      if (had.has(k) || seen.has(k)) continue
      seen.add(k)
      out.push(a)
    }
  }
  return out
}

/** 在连得上的归档链的 JSONL 里按 id 找审计行（{ id, action, detail }）；没有 ⇒ null */
export function archivedRowLookup(chain, index) {
  return (id) => {
    for (const d of chain) {
      if (!(d.first_id <= id && id <= d.last_id)) continue
      const file = index.fileOk(d)
      if (!file) continue
      let found = null
      forEachJsonlRow(file, (r) => { if (r.id === id) { found = { id: r.id, action: r.action, detail: r.detail }; return false } return true })
      if (found) return found
    }
    return null
  }
}

/** 在 archiveDir 里找摘要，证明"备份尾行 T 在被归档的段里、行哈希相同，且该段一路接到在用库的 archive 锚点" */
function proveViaArchive(live, T, tipHash, archiveDir, industry, liveFirstId) {
  if (!archiveDir) return { status: 'unverifiable', message: '备份尾行已被归档搬出库；请用 --archive-dir 指向归档摘要目录' }
  const { digests, fileOk } = openArchiveIndex(archiveDir, industry)
  let cur = digests.find((d) => d.first_id <= T && T <= d.last_id && fileOk(d))
  if (!cur) return { status: 'unverifiable', message: `${archiveDir} 里没有覆盖 id=${T} 且 JSONL 校验通过的归档摘要` }
  let rowHash = null
  forEachJsonlRow(fileOk(cur), (r) => { if (r.id === T) { rowHash = r.row_hash; return false } return true })
  if (rowHash !== tipHash) return { status: 'rewrite', kind: 'tip-row-differs', message: `归档里 id=${T} 的 row_hash 与备份不同` }
  for (let hops = 0; hops <= digests.length; hops++) {
    if (cur.boundary_id === liveFirstId) {
      const a = live.prepare("SELECT 1 FROM audit_chain_anchors WHERE kind='archive' AND at_row_id=? AND anchor_hash=?").get(liveFirstId, cur.tip_row_hash)
      return a ? { status: 'ok', via: 'archive' } : { status: 'rewrite', kind: 'archive-not-anchored', message: '归档摘要的段尾与在用库的 archive 锚点不符' }
    }
    const next = digests.find((d) => d.first_id === cur.boundary_id && d.first_prev_hash === cur.tip_row_hash && fileOk(d))
    if (!next) return { status: 'unverifiable', message: `归档摘要链在 boundary_id=${cur.boundary_id} 处中断（缺少后续摘要）` }
    cur = next
  }
  return { status: 'unverifiable', message: '归档摘要链循环' }
}

export function compareLiveToBackup(live, manifest, { archiveDir = null } = {}) {
  const B = manifest.audit_chain
  const out = { backup_tip_id: B.last_id ?? null, backup_tip_hash: B.tip_hash ?? null, backup_verified: !!B.verified }
  if (!B.present) return { ...out, status: 'unverifiable', message: '备份时库里没有审计哈希链（迁移 068 之前），没有可比对的链尾' }
  if (B.verified !== true) return { ...out, status: 'unverifiable', kind: 'backup-chain-broken', message: `备份时链校验就未通过（${JSON.stringify(B.break ?? null)}）：不能把它当作基线` }
  const span = live.prepare('SELECT MAX(id) AS last, MIN(id) AS first FROM audit_logs').get()
  const at = B.tip_hash ? live.prepare('SELECT row_hash FROM audit_logs WHERE id=?').get(B.last_id) : null
  let verdict
  // 空链基线没有可比对的链尾，但仍要做下面的锚点增删清单（--strict-anchors 不能因为基线为空就失效，Codex AF5）
  if (!B.tip_hash) {
    verdict = { status: 'ok', note: '备份时审计链为空（已校验），无可比对的链尾' }
  } else if (at) {
    verdict = at.row_hash === B.tip_hash
      ? { status: 'ok', via: 'live' }
      : { status: 'rewrite', kind: 'tip-row-differs', message: `在用库 id=${B.last_id} 的 row_hash 与备份记录不同（链被改写并重算？也可能是备份之后做过隐私抹除，需对照操作记录）`, live_row_hash: at.row_hash }
  } else if (span.last === null || span.last < B.last_id) {
    verdict = { status: 'rewrite', kind: 'behind', message: `在用链尾 id=${span.last} 落后于备份链尾 id=${B.last_id}：尾部被截断，或库被回滚到更早的状态` }
  } else if (span.first > B.last_id) {
    verdict = proveViaArchive(live, B.last_id, B.tip_hash, archiveDir, manifest.industry, span.first)
  } else {
    verdict = { status: 'unverifiable', message: `备份链尾 id=${B.last_id} 在在用库的 id 范围内但已不存在（被保留清理删除？）；无法证明后代关系` }
  }
  const result = { ...out, ...verdict }
  if (verdict.status === 'ok' && B.tip_hash) result.advanced_rows = live.prepare('SELECT COUNT(*) AS n FROM audit_logs WHERE id > ?').get(B.last_id).n
  if (Array.isArray(B.anchors)) {
    const liveAnchors = live.prepare(`SELECT ${ANCHOR_COLS} FROM audit_chain_anchors ORDER BY id`).all()
    const had = new Set(B.anchors.map(anchorKey))
    const has = new Set(liveAnchors.map(anchorKey))
    result.anchors_added = liveAnchors.filter((a) => !had.has(anchorKey(a)))
    result.anchors_removed = B.anchors.filter((a) => !has.has(anchorKey(a)) && (span.first === null || a.at_row_id >= span.first))
    result.anchors_digest_equal = anchorsDigest(liveAnchors) === B.anchors_digest
    if (result.anchors_removed.length && result.status === 'ok') {
      result.status = 'rewrite'
      result.kind = 'anchors-removed'
      result.message = '备份里登记过的锚点在在用库范围内消失'
    }
  }
  return result
}
