#!/usr/bin/env node
/**
 * ============================================================================
 * 文件标识：scripts/audit-verify-chain.mjs ｜ 审计日志哈希链校验：顺序走一遍，报告第一个断点（ADR-0049）
 * ============================================================================
 * 【职责】只读打开各行业库，对 `audit_logs` 跑 `verifyChain`：内容被改（content）、中间行被删 / 插入 / 重排（link）、
 *   有行没入链（unchained）都会指出**第一个**出问题的行 id。保留清理 / 归档 / 隐私抹除登记的锚点被承认为合法断口。
 *
 * 【用法】node scripts/audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <64 位十六进制>] [--json]
 *            [--against-backup <备份文件或 .audit-manifest.json> [--archive-dir <归档目录>] [--strict-anchors]]
 *   · `--expect-tip`：与链尾 row_hash 比对。链本身发现不了"整段尾部被截掉"，运维应把每次校验打印的 tip 带外保存，下次传进来。
 *   · `--against-backup`（AC7，ADR-0049 补充）：读备份清单（`db-backup.mjs` 写的 `<备份>.audit-manifest.json` / `.enc`；加密备份需 GML_BACKUP_KEY），
 *     先交叉核对清单与备份内容，再要求在用链是备份链尾的**后代**。在用链能通过自身校验却不是后代 ⇒ 整链被重算（`rewrite`）。行业取自清单。
 *     链尾已被归档搬出库时，用 `--archive-dir` 指向归档摘要目录证明。`--strict-anchors`：备份之后新增 / 消失的锚点也算失败。
 *     AF5（ADR-0055 补充 2）：备份之后在备份链尾范围内（`at_row_id` ≤ 备份链尾 id）新增的锚点同样要求匹配的操作意图 + 审计行印证（同 `--offbox`），
 *     否则 `rewrite`（anchor-without-intent / intent-uncorroborated / …，`intent_problems` 逐条列出）；链尾之后追加区间里的锚点是正常增长。
 *     已被后来的归档搬出库的锚点（只剩在归档摘要里）也同样对账，需要 `--archive-dir`（连得上在用库的验证通过的摘要链）；基线时存活的行被归档搬出过库而没有这条链 ⇒ `unverifiable/archive-evidence-missing`，退出 1。
 *     意图签名用 `--intent-pubkey <公钥PEM>` 验证；`--require-signed-intents` 在这个模式下必须同时给 `--intent-pubkey`（没有 `--pubkey` 可回落）。
 *   · `--offbox <anchor-*.json> --pubkey <公钥PEM>`（AD5，ADR-0055）：验 `offbox-anchor.mjs` 写出的签名锚点（改文件 / 换钥 / 去签名都失败），
 *     并要求每个被锚定的行业库的在用链是锚定链尾的**后代**（同 `--against-backup` 的 ok / rewrite / unverifiable 口径；`--archive-dir` 同样适用）。
 *     被锚定为有链的行业库现已不存在 ⇒ 失败。只检查本次选中的行业。
 *     AE5（ADR-0055 补充）：在已锚定范围内新增的库内锚点必须各有一条匹配的 `audit_anchor_intents` 意图（保留清理 / 归档 / 隐私抹除在新增锚点的同一事务里写），
 *     且意图被 RETENTION_PURGE / AUDIT_ARCHIVE / PRIVACY_ERASE 审计行印证，否则判 `rewrite`（anchor-without-intent / intent-hash-mismatch / intent-uncorroborated / …）。
 *     AF5（ADR-0055 补充 2）：`--accept-new-anchors` 已无效果（打印提示后忽略）：它原先唯一能放行的“印证行已被归档”路径经证明不可达（归档在同一事务里删除
     被印证的范围内锚点），保留它只会给伪造的“意图 + 已归档行”留一个开关。
 *     AG5（ADR-0055 补充 3）：`--pubkey` / `--intent-pubkey` 可重复，参数也可以是目录（取其中的 `*.pub.pem`）——轮换后的公钥集合；离机锚点按其签名元数据的 key_id 选 `--pubkey`，
 *     意图按记录的 key_id 选 `--intent-pubkey`（明确给了集合而 key_id 不在其中 ⇒ `intent-key-unknown` ⇒ rewrite）。没有 key_id 的旧签名意图按过渡规则对集合里每把试；
 *     `--require-intent-key-id` 结束过渡（此类意图判 `intent-key-id-missing`）。见 docs/operations/audit-integrity.md §8c。
 *     AH5（ADR-0055 补充 4）：`--require-intent-key-id` 的缺省随运行模式（`GML_RUNTIME_MODE`，未设 = production）：production 从 `GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER`
 *     （YYYY-MM-DD，UTC，含当天；缺省 2026-12-01；非法 ⇒ 退出 2）起强制，demo/test 不按日期强制；显式开关永远强制。输出的 `intent_key_id_rule` / “intent key_id:” 行说明用了哪条规则。
 *     `--require-signed-intents`：意图必须带可验证的签名（公钥取 `--intent-pubkey`，缺省同 `--pubkey`；签名密钥见 `GML_ANCHOR_INTENT_KEY`，生成见 `release-keygen --purpose anchor-intent`）。
 *   退出码：0 全部 OK；1 有断点（或库未迁移到 068、`--against-backup` 非 ok）；2 参数 / 环境错误。
 * 【边界】不改库、不创建缺失的行业库；不覆盖 user_name / module / ip 三列（规格如此，见 ADR-0049「限制」）。
 * ============================================================================
 */
import path from 'node:path'
import Database from 'better-sqlite3'
import { parseArgs, locateDatabases, die } from './lib/audit-chain-cli.mjs'

const args = parseArgs(process.argv.slice(2), { values: ['--data-dir', '--industry', '--expect-tip', '--against-backup', '--archive-dir', '--offbox'], multi: ['--pubkey', '--intent-pubkey'], flags: ['--json', '--strict-anchors', '--accept-new-anchors', '--require-signed-intents', '--require-intent-key-id'] })
if (!args['data-dir'] && !process.env.GML_DATA_DIR) die('USAGE', '用法：audit-verify-chain.mjs --data-dir <绝对路径> [--industry <行业>] [--expect-tip <hash>] [--json]')
if (args['expect-tip'] && !/^[0-9a-f]{64}$/.test(args['expect-tip'])) die('USAGE', '--expect-tip 必须是 64 位小写十六进制')
if (args['expect-tip'] && !args.industry) die('USAGE', '--expect-tip 只对单个行业有意义，请同时给 --industry')

if ((args['require-signed-intents'] || args['require-intent-key-id'] || args['intent-pubkey']) && !args.offbox && !args['against-backup']) die('USAGE', '--require-signed-intents / --require-intent-key-id / --intent-pubkey 只与 --offbox 或 --against-backup 一起使用')
if (args['require-signed-intents'] && !args['intent-pubkey'] && !args.pubkey) die('USAGE', '--require-signed-intents 需要公钥：--against-backup 模式下请给 --intent-pubkey（带外获得的意图签名公钥）')
// AF5：--accept-new-anchors 唯一能放行的“印证行已被归档”路径不可达，已删除；旧脚本里的开关不再报错，但明确告知它不起作用（对账只会更严）
if (args['accept-new-anchors']) console.error('提示：--accept-new-anchors 已无效（AF5，ADR-0055 补充 2）：没有意图 / 没有被审计行印证的锚点一律判 rewrite；请改为在操作之后立刻做一份新的离机锚点。')
if (!!args.offbox !== !!args.pubkey) die('USAGE', '--offbox 与 --pubkey 必须同时给出（公钥须带外获得）')
if ((args['archive-dir'] || args['strict-anchors']) && !args['against-backup'] && !(args['archive-dir'] && args.offbox && !args['strict-anchors'])) die('USAGE', '--archive-dir / --strict-anchors 只与 --against-backup 一起使用')

const { verifyChain, chainColumnsPresent } = await import('../server/lib/audit-chain-verify.js')
const { loadBackupManifest, compareLiveToBackup, openArchiveIndex, archiveEvidence, archivedAnchorsSince, archivedRowLookup } = await import('../server/lib/audit-anchor-manifest.js')
const { loadBackupKey } = await import('../server/lib/backup-crypto.js')
const { loadPublicKeySet, publicKeyId } = await import('./lib/evidence-sign.mjs')
const { loadAnchor, asManifest } = await import('./lib/offbox-anchor.mjs')
const { verifyAnchorIntents, resolveKeyIdRequirement } = await import('../server/lib/audit-anchor-intent.js')

/**
 * 基线（离机锚点 / 备份清单）之后在“已锚定范围内”（at_row_id ≤ 基线链尾 id）新增的锚点逐个做操作意图对账（--offbox 与 --against-backup 共用）。
 * `cmp` 是 compareLiveToBackup 的结果（原地补字段）；只在 cmp.status === 'ok' 时对账。`base` = { first_id, last_id, anchors }（基线链摘要）；链尾为空 ⇒ 没有已锚定范围。
 * 两类来源：① 仍在库里的新增锚点；② （AF5）已被后来的归档搬出库、但仍记在验证通过的归档摘要里的锚点——伪造的桥锚点可以借一次归档洗出库而躲过 ①。
 * ② 需要连得上在用库的归档摘要链（--archive-dir）；基线时存活的行被归档搬出过库却没有这条链 ⇒ `unverifiable/archive-evidence-missing`（失败闭合，不静默跳过）。
 * 基线有链尾却没有锚点清单 ⇒ `unverifiable/baseline-anchor-list-missing`。
 */
function reconcileInRange(db, code, cmp, base, notes) {
  if (cmp.status !== 'ok') return
  const lastId = base.last_id ?? null
  // 基线链尾存在却没有锚点清单：分不出“基线之后”新增了哪些锚点——不能当作没有，失败闭合
  if (lastId != null && !Array.isArray(base.anchors)) {
    cmp.status = 'unverifiable'
    cmp.kind = 'baseline-anchor-list-missing'
    cmp.message = '基线（离机锚点 / 备份清单）没有锚点清单，无法分辨基线之后新增的锚点；请用新的离机锚点 / 备份重做基线'
    return
  }
  const live = (cmp.anchors_added || []).filter((a) => lastId != null && a.at_row_id <= lastId)
  const archiveDir = args['archive-dir'] ? path.resolve(args['archive-dir']) : null
  const index = archiveDir ? openArchiveIndex(archiveDir, code) : { digests: [], fileOk: () => null }
  // 基线时存活的行如果后来被归档搬出过库，就必须有连得上的归档证据（摘要 + JSONL）才能对账那段；没有 ⇒ unverifiable，而不是静默当作没有
  const ev = archiveEvidence(db, index, base)
  if (ev.needed && !ev.ok) {
    cmp.status = 'unverifiable'
    cmp.kind = 'archive-evidence-missing'
    cmp.message = `基线之后，基线时存活的行被归档搬出过库（在用库第一行是 archive 边界），但${archiveDir ? `${archiveDir} 里没有一条验证通过、连得到在用库的归档摘要链` : '没有给 --archive-dir'}：已被搬出库的锚点无法对账。请用 --archive-dir 指向离机保存的归档摘要目录，或在归档之后重做离机锚点 / 备份作为新基线`
    return
  }
  const archived = ev.needed ? archivedAnchorsSince(ev.chain, base) : []
  const inRange = [...live, ...archived]
  cmp.anchors_added_in_range = inRange.length
  if (archived.length) cmp.archived_anchors_in_range = archived.length
  if (!inRange.length) return
  const iv = verifyAnchorIntents(db, inRange, { publicKeys: intentKeys, explicitKeys: !!args['intent-pubkey'], requireSigned: !!args['require-signed-intents'], requireKeyId: keyIdRule.required, minAuditRowId: lastId, archivedRow: ev.needed ? archivedRowLookup(ev.chain, index) : null })
  cmp.intents_checked = iv.checked
  if (!intentKeys.length) cmp.notes = [...(notes || []), '意图签名未验证：没有给公钥（--intent-pubkey）；未签名的意图只能挡住只改了锚点表的伪造']
  if (iv.ok) return
  cmp.status = 'rewrite'
  cmp.kind = iv.problems[0].kind
  cmp.intent_problems = iv.problems.map((p) => ({ kind: p.kind, anchor: `${p.anchor.kind}@${p.anchor.at_row_id}`, message: p.message }))
  cmp.message = `基线之后在已锚定范围内新增了 ${inRange.length} 条锚点（其中 ${archived.length} 条已被归档搬出库），其中 ${iv.problems.length} 条没有通过操作意图对账：${iv.problems.map((p) => `${p.anchor.kind}@${p.anchor.at_row_id}=${p.kind}`).join(', ')}（伪造的桥锚点？或操作发生在迁移 072 之前——对照操作记录，必要时重新做一份离机锚点 / 备份）`
}

// 离机锚点先验签：验不过就是失败，不是跳过
let offbox = null
if (args.offbox) {
  let loaded
  try { loaded = loadAnchor(path.resolve(args.offbox), loadPublicKeySet(args.pubkey.map((p) => path.resolve(p)))) } catch (e) { loaded = { ok: false, reason: e.message } }
  if (!loaded.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, offbox: { status: 'invalid', message: loaded.reason } }, null, 2))
    else console.log(`OFFBOX-INVALID ${loaded.reason}`)
    process.exit(1)
  }
  offbox = loaded
}

// AH5（ADR-0055 补充 4）：key_id 要求的有效值——显式开关 > production 的日期规则 > demo/test 不强制；只在会对账意图的模式里取（非法配置 ⇒ 退出 2，不静默）
let keyIdRule = { required: false, rule: 'not-applicable', mode: null, after: null }
if (args.offbox || args['against-backup']) {
  try { keyIdRule = resolveKeyIdRequirement({ flag: !!args['require-intent-key-id'] }) } catch (e) { die(e.code || 'USAGE', e.message) }
}

// 意图公钥集合（AG5）：明确给的 --intent-pubkey（可多次 / 目录）；没给时 --offbox 模式回落到 --pubkey 的集合（此时 key_id 对不上不算 key-unknown，沿用 AE5 口径）
let intentKeys = []
if (args.offbox || args['intent-pubkey']) {
  try { intentKeys = loadPublicKeySet((args['intent-pubkey'] || args.pubkey).map((p) => path.resolve(p))) } catch (e) { die('USAGE', e.message) }
}

// 备份清单先读（它决定行业）；清单读不出来 / 与备份对不上就是失败，不是通过
let backupCheck = null
if (args['against-backup']) {
  let key = null
  try { key = loadBackupKey() } catch (e) { die(e.code || 'USAGE', e.message) }
  const loaded = loadBackupManifest(path.resolve(args['against-backup']), key)
  if (!loaded.ok) {
    if (args.json) console.log(JSON.stringify({ ok: false, against_backup: { status: loaded.status, message: loaded.message } }, null, 2))
    else console.log(`${loaded.status.toUpperCase()} ${args['against-backup']}: ${loaded.message}`)
    process.exit(1)
  }
  const ind = loaded.manifest.industry
  if (args.industry && args.industry !== ind) die('USAGE', `--industry ${args.industry} 与清单行业 ${ind} 不一致`)
  args.industry = ind
  backupCheck = loaded
}

const { targets, absent } = await locateDatabases(args)
const report = { ok: true, industries: {}, ...(offbox ? { offbox: { file: path.resolve(args.offbox), created_at: offbox.anchor.created_at, key_id: offbox.key_id } } : {}), ...(args.offbox || args['against-backup'] ? { intent_key_id_rule: keyIdRule } : {}), ...(intentKeys.length ? { intent_keys: intentKeys.map((k) => publicKeyId(k).slice(0, 16)) } : {}) }
for (const code of absent) {
  report.industries[code] = { status: 'absent' }
  if (offbox?.anchor.audit[code]?.status === 'chain') { report.ok = false; report.industries[code].status = 'absent'; report.industries[code].offbox = { status: 'missing', message: '锚点记录该行业有审计链，但现在没有该行业库（库被删除 / 换了数据目录？）' } }
}
for (const { code, file } of targets) {
  const db = new Database(file, { readonly: true })
  try {
    if (!chainColumnsPresent(db)) {
      report.ok = false
      report.industries[code] = { status: 'not-migrated', message: 'audit_logs 没有 prev_hash/row_hash 列（迁移 068 未执行）' }
      continue
    }
    const r = verifyChain(db, { expectTip: args['expect-tip'] })
    if (!r.ok) report.ok = false
    let against = null
    if (backupCheck && r.ok) {
      against = { ...compareLiveToBackup(db, backupCheck.manifest, { archiveDir: args['archive-dir'] ? path.resolve(args['archive-dir']) : null }), manifest_source: backupCheck.source, notes: backupCheck.notes }
      reconcileInRange(db, code, against, backupCheck.manifest.audit_chain, backupCheck.notes)
      if (against.status !== 'ok') report.ok = false
      else if (args['strict-anchors'] && (against.anchors_added?.length || against.anchors_removed?.length)) { against.status = 'anchors-changed'; report.ok = false }
    }
    let off = null
    if (offbox && r.ok) {
      const entry = offbox.anchor.audit[code]
      if (!entry) off = { status: 'not-anchored', message: '锚点里没有该行业（锚点之后新增的行业库？）' }
      else if (entry.status !== 'chain') off = { status: 'ok', note: `锚点记录该行业为 ${entry.status}` }
      else {
        off = compareLiveToBackup(db, asManifest(code, entry), { archiveDir: args['archive-dir'] ? path.resolve(args['archive-dir']) : null })
        // 锚点之后新增、但落在已锚定范围内（at_row_id <= 锚定链尾 id）的库内锚点：伪造的"桥"锚点可以洗白一次对历史行的改写
        // （改第 k 行并重算它，再登记一条把新哈希接回第 k+1 行原 prev_hash 的锚点；链校验与链尾比对都会通过）。
        // AE5（ADR-0055 补充）：合法的保留清理 / 归档 / 隐私抹除在新增锚点的同一事务里写 audit_anchor_intents，并由 RETENTION_PURGE / AUDIT_ARCHIVE /
        // PRIVACY_ERASE 审计行引用；这里逐个要求匹配的意图 + 审计行印证（+ 签名，若有）。没有 ⇒ rewrite。
        // AF5：--accept-new-anchors 已无效果。锚点之后的追加区间里新增的锚点是正常增长，不在此列。
        reconcileInRange(db, code, off, entry, null)
      }
      if (off.status !== 'ok' && off.status !== 'not-anchored') report.ok = false
    } else if (offbox) report.ok = false
    report.industries[code] = { status: r.ok ? 'ok' : 'broken', rows: r.rows, first_id: r.firstId, last_id: r.lastId, tip_hash: r.tipHash, anchors_used: r.anchorsUsed, ...(r.brk ? { break: r.brk } : {}), ...(against ? { against_backup: against } : {}), ...(off ? { offbox: off } : {}) }
  } finally {
    db.close()
  }
}

if (backupCheck && !Object.values(report.industries).some((r) => r.against_backup)) report.ok = false // 没能比对（库缺失 / 未迁移 / 链已断）不算通过

if (args.json) console.log(JSON.stringify(report, null, 2))
else {
  if (report.intent_key_id_rule) {
    const k = report.intent_key_id_rule
    console.log(`intent key_id: ${k.required ? 'enforced' : 'not enforced'} (${k.rule}${k.after ? `, after ${k.after}` : ''}${k.mode ? `, mode ${k.mode}` : ''})`)
  }
  for (const [code, r] of Object.entries(report.industries)) {
    if (r.status === 'ok') console.log(`OK    ${code}: ${r.rows} 行，id ${r.first_id ?? '-'}..${r.last_id ?? '-'}，锚点 ${r.anchors_used}，tip=${r.tip_hash ?? '(空表)'}`)
    if (r.against_backup) {
      const a = r.against_backup
      console.log(`${a.status === 'ok' ? 'OK   ' : 'FAIL '} ${code} 对比备份 tip（id=${a.backup_tip_id}）：${a.status}${a.kind ? `/${a.kind}` : ''}${a.message ? ' — ' + a.message : ''}${a.advanced_rows !== undefined ? `；此后前进 ${a.advanced_rows} 行` : ''}`)
      if (a.anchors_added?.length) console.log(`      备份之后新增锚点 ${a.anchors_added.length} 条（保留清理 / 隐私抹除 / 归档会产生；请对照操作记录）：${a.anchors_added.map((x) => `${x.kind}@${x.at_row_id}`).join(', ')}`)
      for (const n of a.notes || []) console.log(`      注：${n}`)
    }
    if (r.offbox) console.log(`${r.offbox.status === 'ok' || r.offbox.status === 'not-anchored' ? 'OK   ' : 'FAIL '} ${code} 对比离机锚点：${r.offbox.status}${r.offbox.kind ? `/${r.offbox.kind}` : ''}${r.offbox.message ? ' — ' + r.offbox.message : ''}${r.offbox.advanced_rows !== undefined ? `；此后前进 ${r.offbox.advanced_rows} 行` : ''}`)
    if (r.status === 'ok') continue
    if (r.status === 'broken') console.log(`BREAK ${code}: 第一个断点 id=${r.break.id} 类型=${r.break.kind}（期望 ${r.break.expected}，实得 ${r.break.actual}）；此前 ${r.rows} 行正常`)
    else console.log(`${r.status.toUpperCase()} ${code}${r.message ? ': ' + r.message : ''}`)
  }
}
process.exit(report.ok ? 0 : 1)
