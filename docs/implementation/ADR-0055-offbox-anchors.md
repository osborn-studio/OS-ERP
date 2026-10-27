# ADR-0055：透明日志与审计链的离机签名锚点（AD5）

状态：开发实现，尚非产品上线验收｜相关：ADR-0047（证据签名）、ADR-0049（审计哈希链，AC7 备份清单）、ADR-0052（证据透明日志）、`docs/operations/audit-integrity.md` §8、roadmap-v9 AD5

## 背景

透明日志（`EVIDENCE-LOG.jsonl`）的哈希链发现不了"删最新几行"或"整份文件换成另一条有效链"；审计链的 `--against-backup` 依赖备份清单被带外保存，但没有一个每天都能做、由持钥者签名、并且两种链一起覆盖的离机副本。

## 决定

### 1. 锚点文件
`scripts/offbox-anchor.mjs --data-dir <abs> --dest <abs 目录 | ssh://别名/绝对路径> --key <私钥PEM> [--log <EVIDENCE-LOG>]` 写出 `anchor-<stamp>.json`（`stamp` 为 UTC 毫秒时间戳）：
`{"anchor": {format, created_at, log, audit, signature}, "sig": "<base64>"}`。
- `log` = `{present, lines, tail_hash}`：日志前 `lines` 行的链尾（第 `lines` 行原文的 sha256；0 行为日志创世常量）。
- `audit[行业]` = `{status:"absent"|"not-migrated"}` 或 `{status:"chain", rows, first_id, last_id, tip_hash, anchors_count, anchors_digest, anchors[]}`（锚点明细一并签名，便于发现锚点被删）。
- 签名：ADR-0047 的规范化 JSON v1 + Ed25519（同一密钥与 `loadSigningKey` 检查：仓库外、0600、Ed25519），覆盖整个 `anchor`（含 `format` 与 `signature` 元数据）；`format` 与证据文件不同，两类签名不可互相冒充。`sig` 在被签内容之外。
- 出锚点前先验：透明日志必须是有效链、各库审计链必须通过 `verifyChain`；坏链不出锚点（退出 1），不给断点背书。`--log` 缺省为仓库内日志，文件不存在则 `log.present=false`；显式给出却无效或不存在则失败。

### 2. 目的地与远端安全
- 本地：必须是**已存在**的绝对目录（不创建——盘没挂载时静默落到本机盘正是离机的反面），不得在数据目录之内。先写 `.tmp`，用 `link` 发布（目标已存在即 `EEXIST`，永不覆盖；文件系统不支持硬链接时退到 `wx` 独占创建），再读回比对。独占创建后的可捕获写入错误会删除本次不完整终名，且错误退出前先清理临时文件；已有终名不会被删除。清理本身失败时以非零退出码报告原始错误与可能残留的路径。无硬链接回退写入期间终名可见，使用者须验签；该回退不保证进程异常终止（如 SIGTERM/SIGKILL）时终名完整，使用前仍须验签。
- `ssh://别名/路径`：别名按 `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`（拒绝 `-` 开头、`user@host`、端口、方括号、空白），路径必须是绝对路径、每段只含 `[A-Za-z0-9._-]` 且不以 `-` 开头、无 `.`/`..`/空段。**校验失败时不 spawn 任何进程**。之后一律以参数数组调用 `ssh`/`scp`（无本机 shell），带 `-o BatchMode=yes -o ConnectTimeout=15` 与 `--`；远端命令里的路径已被白名单限制并再加单引号，所以远端 shell 无从注入。从不传 `-F`/`-i`/`ProxyCommand`/`StrictHostKeyChecking`/`UserKnownHostsFile`，不改 SSH 配置或认证；别名必须是用户**已有**的。
- 远端写入序列：`test -d` 目录 → `scp` 到 `.anchor-….tmp` → `ln -T -- tmp 终名` 原子独占发布 → 清理临时名 → `cat` 读回比对。远端要求 GNU `ln -T` 与同目录硬链接；不支持时失败，不退回覆盖式移动。任何一步失败都尽力清理本次临时文件。PR #9 复审确认旧的 `test ! -e … && mv` 存在检查与移动之间的竞争窗口，已用并发同名写入反例修正。
- 测试接缝：`OS_ERP_SSH` / `OS_ERP_SCP` 指向替身（与 `OS_ERP_GH` 同类）。只设 `OS_ERP_SSH` 不设 `OS_ERP_SCP` 时拒绝，避免真 `scp` 经替身 `ssh` 出网。测试从不连接真实主机。

### 3. 校验
- `audit-verify-chain --offbox <文件> --pubkey <公钥PEM>`（二者必须同时给）：先验签（改文件、换钥、去签名、多余字段、`format` 不符都失败），再对每个被选中行业：在用链自身通过校验 + 锚定链尾是其祖先（沿用 AC7 `compareLiveToBackup`：`ok` / `rewrite`（`tip-row-differs`、`behind`、`anchors-removed`）/ `unverifiable`）；被锚定有链的行业库现已不存在 ⇒ 失败；锚点之后在**追加区间**（`at_row_id` 大于锚定链尾 id）新增的库内锚点是正常增长；但在**已锚定范围内**（`at_row_id` ≤ 锚定链尾 id）新增的库内锚点默认失败（`anchors-added/in-anchored-range`）并列出——伪造的"桥"锚点可以洗白对历史行的改写（见审计记录），而合法的保留清理 / 归档 / 隐私抹除在该范围内也会产生同样的锚点，所以由操作者对照操作记录后用 `--accept-new-anchors` 明确接受（或先做一次新锚点再比对）。**（该语义已被文末「补充（AE5）」取代：现在要求操作意图对账，`--accept-new-anchors` 不再放行无意图的锚点。）**锚定链尾被保留清理删除或归档搬出时需 `--archive-dir`，否则 `unverifiable`（失败）。
- `verify-release --log=<日志> --offbox <文件> --pubkey <公钥PEM>`（三者必须同时给；可不带 `--evidence`）：验签后要求现日志自身是有效链、行数不少于锚定行数，且第 `lines` 行的哈希等于锚定的 `tail_hash`——截尾、整份替换为另一条有效链、改中间行、日志被删都失败。裸 `--log`（不带 `=`）沿用既有语义，指仓库默认日志。`verify-release` 不接数据目录，因此审计链部分只由 `audit-verify-chain` 校验。

## 诚实边界
- 锚点证明"持钥者在 `created_at` 时看到过这个链尾"；同时拿到私钥和离机副本的攻击者、或离机目的地本身被攻破（可删最新锚点——此时只剩较旧锚点的保护）不在防护范围。`created_at` 是持钥者机器的自述时间，不是时间戳权威。
- 公钥必须带外获得；与锚点放在一起的公钥没有意义。
- 本地目录的"离机"取决于运维把它挂在另一块盘 / 另一台机器上；脚本只能拒绝数据目录内的路径，无法证明物理隔离。
- 锚点之间的窗口内（例如每天一次）发生的改写再恢复不会被发现；被锚定之后才写入的审计行只受链本身保护，直到下一个锚点。
- `ssh` 目的地的真实连通性、主机密钥确认和认证由运维既有配置负责，本工作流只在替身上验证；未在真实主机上验证。

## 后果
- 新文件：`scripts/offbox-anchor.mjs`、`scripts/lib/offbox-anchor.mjs`、`tests/offbox-anchor.test.mjs`；`audit-verify-chain.mjs`（`--offbox`/`--pubkey`）、`verify-release.mjs`（`--offbox`）、`check-file-header.mjs`（登记）、`gen-changelog.mjs`（第十二批 50–52，第十三批 53–64）、运维手册 §8"每日锚点"。
- 锚点内含审计链尾哈希与锚点明细，不含审计内容；文件本身不是机密，但应放在不能被业务主机写的位置。

## 审计记录
Codex 审计（gpt-6.1-sol，只读，针对相对 batch-twelve 的差异）：
- 高：`audit-verify-chain --offbox` 丢弃了 `anchors_added`，攻击者可改第 k 行并重算，再往库里插一条把新哈希接回第 k+1 行原 `prev_hash` 的桥锚点；链校验与链尾比对都通过（审计方在内存库中复现）⇒ 已修：已锚定范围内新增的库内锚点默认失败并列出，需 `--accept-new-anchors` 明确接受；回归测试 `forged bridge anchor` 先红后绿。局限：接受该开关后的桥锚点仍无法与合法清理区分，只能靠操作记录。
- 审计确认：未发现经 `--dest ssh://别名/路径` 的命令 / 选项注入（别名与路径白名单、`--` 终止选项、参数数组调用、远端路径单引号）；未发现私钥泄露路径（私钥只经 `loadSigningKey`，不写入锚点、不进命令行输出）。

## 补充（AE5）：锚点操作意图对账

状态：开发实现，尚非产品上线验收｜相关：roadmap-v10 AE5、迁移 072、`server/lib/audit-anchor-intent.js`、`docs/operations/audit-integrity.md` §8b

### 背景
AD5 的修复让“已锚定范围内新增的库内锚点”默认失败、由操作者用 `--accept-new-anchors` 接受。但接受之后，伪造的桥锚点与合法的保留清理 / 归档 / 隐私抹除锚点仍不可区分，只能靠人对照操作记录。

### 决定
1. **迁移 072 `audit_anchor_intents`**：`id, created_at, operation ∈ {retention, archive, erase}（CHECK）, range_desc, operator_user_id, operator_name, anchors_json, intent_hash, key_id, signature, audit_row_id`。`intent_hash = sha256(JSON([格式标识, operation, range_desc, operator_user_id, operator_name, created_at, 锚点元组列表]))`，锚点元组 = `[kind, at_row_id, anchor_hash, prev_id, prev_row_hash]`；配置了 `GML_ANCHOR_INTENT_KEY`（缺省 `GML_RELEASE_SIGN_KEY`）时对 `格式标识:intent_hash` 做 Ed25519 签名（可空）。`up()` 缺表建表、缺列补列，`verify()` = 表与全部列在，二者一致。不对 `audit_logs` 建外键或索引。
2. **写入同事务**：`retention.mjs`、`audit-archive.mjs`、`privacy-erase.mjs` 在操作前记锚点自增水位（`anchorMark`），操作后把水位之后新增的**全部**锚点记成一条意图（`recordAnchorIntent`，不在事务内抛 `AUDIT_OUTSIDE_TX`），把 `{id, hash}` 放进自己的操作审计行明细的 `anchor_intent`，再把审计行 id 回填到意图（`linkIntentAuditRow`）。审计写不进（`SECURITY_AUDIT_UNAVAILABLE`）时整个事务回滚，意图与锚点一起撤销（测试：`BEFORE INSERT` 触发器吞掉 `RETENTION_PURGE`）。没有新增锚点则不写意图。签名私钥配置了却读不出来 ⇒ 脚本在改库之前退出。
   - 与路线图措辞的差异：路线图写“`AUDIT_*` 审计行”。保留清理 / 归档 / 隐私抹除原本就各写一条严格审计（`RETENTION_PURGE` / `AUDIT_ARCHIVE` / `PRIVACY_ERASE`），本次**复用这三条**并在明细里加引用，而不是再多写一行（再写一行会改变既有审计行数口径与测试）。印证时按操作类型核对 action。
3. **校验（`audit-verify-chain --offbox`）**：对 AD5 已有的“锚点之后在已锚定范围内新增”的每个库内锚点（`at_row_id ≤ 锚定链尾 id`）要求：匹配意图（五元组全等）→ 意图哈希重算一致（`intent-hash-mismatch`）→ 有签名且有匹配公钥时验签（`intent-signature-invalid`）→ 被审计行印证（`intent-uncorroborated`：`audit_row_id` 缺失 / 不晚于锚定链尾 / 行不存在 / action 与操作不符 / 明细引用的 id 与哈希不符）。缺意图 = `anchor-without-intent`。任何一项失败 ⇒ `offbox.status = rewrite`，退出 1，并在 `intent_problems` 里列出每个锚点的问题。`--require-signed-intents`（公钥 `--intent-pubkey`，缺省 `--pubkey`）要求签名存在且可验（`intent-unsigned` / `intent-signature-unverifiable`）。
4. **`--accept-new-anchors` 语义变更**：旧——放行所有已锚定范围内的新增锚点；新——**不放行没有意图的锚点**，只接受意图齐全、但印证它的审计行已被后来的归档搬出库（`corroboration-archived`，`audit_row_id` 小于库内最小审计行 id）的锚点。正常的清理 / 归档 / 抹除不再需要任何开关。AD5 回归测试 `forged bridge anchor` 相应改为：无意图 ⇒ `rewrite/anchor-without-intent`，带 `--accept-new-anchors` 仍失败。
5. **升级**：迁移 072 之前、且发生在某份离机锚点之后的锚点没有意图，会被判 `anchor-without-intent`；处理方式是核对后重新做一份离机锚点。

### 诚实边界
- 意图不签名时，能同时写库并通过 `insertAuditRow` 追加审计行的攻击者，可以造出“桥锚点 + 意图 + 引用它的审计行”三件自洽的东西；这些审计行落在锚定链尾之后，会留下可见的痕迹，但校验器不能凭自己证明它们是伪造的。签名意图（私钥不在业务主机）与 `--require-signed-intents` 才能挡住它。
- 印证行被后来的归档搬出库后，意图只能靠 `--accept-new-anchors` + 人工核对归档摘要；`audit_row_id` 不进哈希（审计行明细里的引用与它互指，但回填的 id 本身可被改，改动后的指向仍需通过 action / 明细引用检查）。
- `--against-backup` 比对没有做意图对账（仍按 ADR-0049 §AC7 列出备份之后新增的锚点）。
- 意图只在锚点比对时参与；`verifyChain` 自身对锚点的承认规则不变。

### 审计记录（AE5）
Codex 审计（gpt-6.1-sol，只读，针对相对 batch-thirteen 的差异，聚焦意图伪造 / 事务原子性 / 校验绕过）：无高危；三条中危、一条低危，均已修：
- 中：`corroboration-archived` 只要求 `audit_row_id < 库内最小审计行 id`，一个从未存在的 id 也能借此通过 `--accept-new-anchors` ⇒ 已修：还要求库里存在 `kind=archive` 且 `at_row_id` 大于该 id 的归档锚点（归档的边界确实越过了它），否则 `intent-uncorroborated`；回归 `missing audit row without archive evidence`。另注：归档会删除 `at_row_id ≤ 段尾` 的全部旧锚点，而印证行必晚于离机锚点的链尾，所以正常流程里这条路径几乎不可达，`--accept-new-anchors` 只是一个收窄后的安全阀。
- 中：072 `up()` 给残表补 `created_at` 用了非常量默认值，对有数据的表 `ALTER ADD COLUMN` 会失败 ⇒ 已修：补列用常量默认值，新建表仍默认 `datetime('now','localtime')`。
- 中：`verify()` 不检查 `id` 列，缺 `id` 的表被判健康而运行时 `ORDER BY id` 报错 ⇒ 已修：`id` 纳入 `verify()`；缺 `id` 无法 ALTER 补，`up()` 重建为标准形态。
- 低：补列修出来的残表没有 `operation` 的 CHECK ⇒ 已修：`verify()` 检查 DDL 含该 CHECK，`up()` 重建表（保留行）。回归 `repairs a populated partial table`。
- 审计确认：锚点自增水位在删除最高锚点、事务回滚时都正确；数字 / 字符串类型差异不会误匹配；锚定链尾之后的锚点按设计不在对账范围；`key_id` 与提供的公钥不符时跳过验签属于“签名可选”的既定口径（`--require-signed-intents` 下失败）；意图列表比实际锚点多出的元组不授权任何未匹配的实际锚点。未发现三个脚本的原子性缺陷。

## 补充 2（AF5）：`--against-backup` 意图对账、删除“印证行已归档”路径、意图密钥保管

状态：开发实现，尚非产品上线验收｜相关：roadmap-v11 AF5、`docs/operations/audit-integrity.md` §6 / §8 / §8b

### 决定
1. **`--against-backup` 做同样的意图对账**。备份之后新增、且 `at_row_id` ≤ 备份链尾 id 的库内锚点，逐个要求匹配的 `audit_anchor_intents` 意图 + 操作审计行印证（审计行 id 必须大于备份链尾）；否则 `against_backup.status = rewrite`，`kind` 为 `anchor-without-intent` / `intent-hash-mismatch` / `intent-uncorroborated` / `intent-signature-*`，`intent_problems` 逐条列出，退出 1。备份链尾之后追加区间里的锚点是正常增长，只在 `anchors_added` 里列出。与 `--offbox` 共用同一个 `reconcileInRange`，没有第二套规则。`--strict-anchors` 语义不变。
   - 签名：`--intent-pubkey` 现在也可与 `--against-backup` 一起用；`--require-signed-intents` 在该模式下必须同时给 `--intent-pubkey`（没有 `--pubkey` 可回落，缺则退出 2）。`--against-backup` 下没给公钥且确有锚点被对账时，输出 `notes` 注明“意图签名未验证”（`--offbox` 的 `--pubkey` 兼作意图公钥，不出现该注）。
   - 备份的 `anchors` 明细已被 `loadBackupManifest` 强制与 `anchors_digest` / `anchors_count` 自洽，所以“新增”清单不能靠换明细清空（AC7 既有检查）；对账不引入新的信任输入。
2. **删除 `corroboration-archived` / `acceptArchived`**。AE5 的补充留了一条“印证行已被后来的归档搬出库 ⇒ 仅 `--accept-new-anchors` 放行”的路径，并自称“几乎不可达”。AF5 证明它对**库内锚点**严格不可达：被印证的锚点满足 `at_row_id ≤ 基线链尾 < 印证行 id`；印证行要被归档搬走，那次归档的段尾 `lastId ≥` 印证行 id，而 `audit-archive` 在同一事务里 `DELETE FROM audit_chain_anchors WHERE at_row_id <= lastId`，该锚点必然一起被删。其他删行途径也造不成这种组合：保留清理只删 `module ∈ {master, notify}` 的行，操作审计行不在其列。回归 `the "corroborating row was archived" path is unreachable`：真实跑两次归档，印证行与库内范围内锚点同时消失；再补回一条范围内锚点 + 指向已归档行的伪造意图，**无论带不带 `--accept-new-anchors`** 都是 `rewrite/intent-uncorroborated`。删除前，这个伪造在带开关时会通过（红测试证实），保留这条路径是一个可用的绕过口。
   - 行为变化：`--accept-new-anchors` 不再有任何作用；脚本打印一行提示后忽略它（不报用法错误，避免旧运维脚本直接失效；结果只会更严）。
   - 这不意味着“被归档的锚点无需对账”，见下一条。
2b. **被归档搬出库的锚点改由摘要对账（Codex AF5 高危的修复，二轮收紧）**。库内不可达 ≠ 无需检查：归档把段内锚点导出进摘要后从库里删掉，伪造的桥锚点若先于一次合法归档登记，就会随这次归档“洗出”库，对账看到零个范围内锚点。修复：
   - `openArchiveIndex`（摘要 + JSONL 逐行重算哈希，验不过的不采信）→ `connectedArchive`：只收**一路连到在用库**的摘要链（从在用库第一行的 `archive` 锚点往回，沿 `boundary_id` / `first_prev_hash` / `tip_row_hash` 接）。目录里被放进来的、自洽但不连在用库的摘要既不能提供锚点清单，也不能提供印证行（二轮 Codex：伪造的单行 JSONL 可以“印证”伪造意图；多出的无意图锚点也可以让合法归档被误拒）。
   - `archivedAnchorsSince`：链上摘要里 `first_id ≤ at_row_id ≤ last_id`（基线时存活行上的锚点）且不在基线锚点清单里的锚点，与库内新增锚点一起走同一套意图对账；印证行也已被归档时，`verifyAnchorIntents` 的 `archivedRow`（`archivedRowLookup`，只查连得上的链）从归档 JSONL 里取。早于基线的归档只涉及 `< first_id` 的行，不算新增。
   - **失败闭合**（二轮 Codex：缺目录/坏 JSONL 时静默跳过会让同一伪造躲过）：`archiveEvidence` 判断基线时存活的行是否被归档搬出过库（在用库第一行是 `archive` 边界且 id 大于基线 first_id）；是则必须有覆盖基线 first_id 的连通链，否则 `unverifiable/archive-evidence-missing`（退出 1）。基线有链尾却没有锚点清单 ⇒ `unverifiable/baseline-anchor-list-missing`（此前分不出新增锚点却当作没有）。
   - 行为变化：归档之后复核必须带 `--archive-dir`，或在归档后重做离机锚点 / 备份作为新基线（新基线 first_id 越过被归档的行就不再需要）。AE5 里“归档不需要任何开关”的说法只对不需要归档证据的情形成立。
   - 回归：`laundered … archive digest`（两种比对，含缺目录 / 空目录 / JSONL 被改 ⇒ `archive-evidence-missing`）、`planted … archive segment`、`planted digest carrying an unrelated anchor`、`a legitimate retention-style anchor that was later archived …`、以及“两次归档”夹具里第一次归档的锚点现在经第二次归档的摘要 + 归档 JSONL 里的印证行通过对账。
3. **意图密钥保管**。`release-keygen.mjs --purpose anchor-intent` 写 `anchor-intent.key.pem`（0600、O_EXCL）+ `anchor-intent.pub.pem`；`--purpose release`（缺省）行为不变。拒绝规则共用同一实现（相对路径、仓库 / 任何 git 工作树内含符号链接、非空目录）；未知 / 重复 / 缺值的 `--purpose`（含 `constructor` / `toString` / `__proto__` 这类原型属性名，用 `Object.hasOwn` 判断）在创建任何东西之前失败。输出多一个 `purpose`，提示把私钥放在执行清理 / 归档 / 抹除的操作机上、与发行密钥分开、不放业务主机。`GML_ANCHOR_INTENT_KEY` 的加载规则（`loadIntentSigner`）不变，测试加了“keygen 出来的钥匙能被它加载、仓库内的路径被拒”。
4. **每日流程**：`audit-integrity.md` §8 给出完整命令集（两把密钥生成、`GML_ANCHOR_INTENT_KEY`、`offbox-anchor` 两种目的地、`--offbox` 与 `--against-backup` 复核均带 `--intent-pubkey --require-signed-intents`），并说明不带该开关时未签名意图也算通过。`offbox-anchor.mjs` 头注释指向同一流程。文档策略测试断言这些命令仍在。
5. 同步更新 `docs/本地交付/02_操作手册.md` 里仍写着“`--accept-new-anchors` 人工放行”的一条。

### 诚实边界（更新）
- 未给 `--intent-pubkey` 时签名不被验证（只在输出里注明）；不带 `--require-signed-intents` 时没有签名的意图仍可通过。能同时写库与审计链的攻击者在不签名的口径下仍可造出自洽的“桥锚点 + 意图 + 引用它的审计行”。推荐口径是日常总带 `--require-signed-intents`。
- AE5 诚实边界里“`--against-backup` 没有意图对账”一条作废。
- 空链基线（备份时审计链为空）此前在锚点增删清单之前就返回 ok，`--strict-anchors` 对它失效（Codex AF5 中危，AC7 起就有）；已改为先做清单再返回，回归 `empty-chain baseline still reports added anchors`。
- 备份之前就存在的锚点（早于迁移 072 的清理 / 归档）不会被对账——它们在清单里，不在 `anchors_added`。

### 审计记录（AF5）
Codex 审计（gpt-6.1-sol，只读，防御性审查，针对 AF5 提交）：
- 高：已归档的桥锚点躲过对账（只检查库内锚点；`audit-archive` 把现存桥锚点原样导出进摘要再删库内副本，随后的合法归档可把它带出对账范围；`proveViaArchive` 也信任摘要里的锚点清单承认 JSONL 断口）⇒ 已修（2b）：摘要锚点纳入对账，印证行从验证通过的归档 JSONL 取。这是 AD5/AE5 起就有的缺口，AF5 的 `--against-backup` 对账同样会漏掉它，所以一并修。
- 二轮（针对修复提交）两条高：① 缺 `--archive-dir` / 目录为空 / JSONL 被损坏时静默跳过，同一伪造照样躲过 ⇒ 已改为失败闭合（`archive-evidence-missing`，原先“只在 notes 里注明”的做法撤销）；② 目录里被放入的自洽但不连在用库的摘要可以伪造印证行、或用多余锚点让合法归档误拒 ⇒ 已改为只采信连到在用库的摘要链。另提示：离机锚点条目没有 `anchors` 清单时被静默跳过 ⇒ 已改为 `baseline-anchor-list-missing`（失败闭合）；该分支只有手工构造的锚点能到达，未单独造测试。
- 中：空链基线绕过 `--strict-anchors` ⇒ 已修（见上）。
- 低：`--purpose constructor|toString|__proto__` 命中原型属性、生成了奇怪文件名的密钥 ⇒ 已修（`Object.hasOwn`），回归覆盖。
- 低：ADR 补充对签名验证提示的描述不准（`--offbox` 的 `--pubkey` 兼作意图公钥；提示只在有锚点被对账时出现）⇒ 已更正。
- 审计确认：“印证行已归档”路径在三个受支持流程（归档 / 保留清理 / 隐私抹除）下对库内锚点确实不可达，删除它不产生对合法流程的误拒；keygen 的路径拒绝与独占创建对支持的用途没有发现绕过。
- 未验证：审计沙箱的 Node ABI 与 `better-sqlite3` 不匹配，审计方没有跑测试，结论来自读码与内存库试验；测试结果以本仓库实跑为准。

## 补充 3（AG5）：意图 / 锚点签名密钥轮换与多密钥校验

状态：开发实现，尚非产品上线验收｜相关：roadmap-v12 AG5、`docs/operations/audit-integrity.md` §8c

### 决定
1. **`key_id` 沿用完整 SHA-256 指纹（64 位十六进制）**。AE5 起 `audit_anchor_intents.key_id` 与锚点 `signature.key_id` 就是公钥 SPKI DER 的 sha256 全长，已有测试与已写入的数据都按这个长度；截成 16 位会让已有行对不上，并把选钥建立在 64 位前缀上。16 位前缀只用于**文件名**（`anchor-intent-<前 16 位>.*.pem`）和人读输出。
2. **公钥集合**。`audit-verify-chain` 的 `--pubkey`、`--intent-pubkey` 可重复，参数可以是目录（只取其中 `*.pub.pem` 普通文件，不递归）；`loadPublicKeySet` 按 key_id 去重，空集合 / 没有公钥的目录 / 私钥内容 / 非 Ed25519 一律是用法错误（退出 2）。输出 JSON 多一个 `intent_keys`（各钥 key_id 前 16 位）。
3. **按 key_id 选钥，不逐把试**。意图：`key_id` 在集合里 ⇒ 用那一把验（失败 `intent-signature-invalid`）；明确给了 `--intent-pubkey` 而 `key_id` 不在集合 ⇒ **`intent-key-unknown`**（rewrite，与是否 `--require-signed-intents` 无关）。这改变了 AE5/AF5 的口径：原先公钥对不上只在 `--require-signed-intents` 下失败（`intent-signature-unverifiable`）。回落用的 `--pubkey`（`--offbox` 模式没给 `--intent-pubkey`）仍沿用旧口径，因为那把钥原本是锚点签名钥。离机锚点：按 `signature.key_id` 从 `--pubkey` 集合里选，集合里没有 ⇒ `OFFBOX-INVALID`。
4. **过渡规则**：带签名而 `key_id` 为空的意图（早于记录 key_id 的数据，或被写库者清空）对集合里每一把试，任何一把通过即可；都不过 ⇒ `intent-signature-invalid`。**结束条件**：库里不再有 `signature` 非空而 `key_id` 为空的需对账意图，且复核方用 `--require-intent-key-id` 跑通一轮之后，把该开关写进日常命令；此后这类意图是 `intent-key-id-missing`。
5. **`release-keygen --rotate`**：`--out` 必须是已存在、含本用途旧公钥（都能解析）、非组 / 其他可写、不在仓库内的保管目录；新建 `<名>-<key_id 前 16 位>.key.pem` / `.pub.pem`（`wx` 独占，私钥 0600），旧文件不动；输出 `rotated: true` 与 `retained_public_keys`。不带 `--rotate` 的行为不变（非空目录照旧拒绝）；`--rotate` 重复或带值是用法错误。
6. **`offbox-anchor`**：锚点的签名元数据早已内嵌 `key_id`（签名覆盖它，改不了）；现在输出里打印其前 16 位，用轮换后的新私钥出锚点即可。运维手册 §8c 写了完整轮换步骤、选钥口径、撤销、过渡规则与结束条件。

### 诚实边界
- `key_id` 不在被签内容里（签名输入沿用 `格式标识:intent_hash`，改动会使已有意图全部失效）：它是选钥提示而非信任来源。写库者能清空 `key_id` 走过渡路径，所以被撤销（泄露）的旧钥必须从公钥集合里拿掉，且过渡结束后用 `--require-intent-key-id`。
- 公钥集合本身须带外保管；随库或随锚点放的公钥没有意义。
- 没有为意图增加撤销时间戳：撤销 = 从集合里移除，旧钥签过的意图随之整体不可验，需要重做基线。

### 审计记录（AG5）
Codex 审计（gpt-6.1-sol，只读，防御性审查，针对 AG5 提交 04d95f9）：
- 高（接受并写明，不改行为）：回落模式（`--offbox` 没给 `--intent-pubkey`，用 `--pubkey` 兼作意图公钥）下，写库者把匹配的 `key_id` 改成未知值或清空，可让一条签名无效的意图被放行。这是 AE5 起就有的“签名可选”口径，不是本次引入的退化：同一个写库者本来就可以直接写一条**无签名**的意图，在不带 `--require-signed-intents` 时同样通过；带 `--require-signed-intents` 时清空 / 改 `key_id` 得到的是 `intent-signature-unverifiable`（失败）。不能改成“公钥验不过就失败”，因为回落公钥是锚点签名钥，用单独意图钥签名的合法意图在这里本来就验不了。处理：运维手册 §8c 与本节写明——带意图签名的环境**总是显式给 `--intent-pubkey`** 并带 `--require-signed-intents`；显式口径下三种变体（key_id 改成另一把、改成未知、清空）分别是 `intent-signature-invalid` / `intent-key-unknown` / 过渡规则下 `intent-signature-invalid`，有测试覆盖。
- 中（已修）：目录公钥集合会跟随目录内的符号链接，链接目标在受信目录之外 ⇒ 目录里出现符号链接一律拒绝（显式传入的文件参数仍可是链接）。回归 `loadPublicKeySet … symbolic link`。
- 中（部分修）：`--rotate` 校验目录后仍按路径写入，祖先目录被替换可重定向写入 ⇒ 保管目录本身是符号链接时拒绝；祖先目录可被他人替换属于“能写祖先目录的人已经控制了保管目录”，不在防护范围，手册要求保管目录放在 0700 的自有路径下。
- 中（已修）：写到一半失败（如磁盘满）会残留半截密钥文件，且残留的损坏 `*.pub.pem` 会阻止后续轮换与目录校验 ⇒ 改为 `openSync(..., 'wx')` 成功后立刻登记再写内容，失败时清理；`EEXIST` 不登记，不会误删别人的文件。未单独造“磁盘满”的测试（需要故障注入接缝），由读码与既有失败清理测试覆盖。
- 审计确认：显式意图公钥下按 key_id 选钥没有绕过（伪造成另一把受信 key_id 验签失败）；离机锚点的 key_id 在被签元数据里；重复公钥去重；`*.pub.pem` 里放私钥内容被拒绝。审计方没有跑仓库测试（沙箱 Node 版本不同）。

## 补充 4（AH5）：过渡期结束的日期规则与“能写库者”威胁模型边界

状态：开发实现，尚非产品上线验收｜相关：roadmap-v13 AH5、`docs/operations/audit-integrity.md` §8d

### 决定
1. **`--require-intent-key-id` 的有效值随运行模式**（`resolveKeyIdRequirement`，`server/lib/audit-anchor-intent.js`）：显式开关永远强制（没有“显式关闭”，所以不存在被环境变量放松的路径）；否则 `demo` / `test` 不强制；`production`（`GML_RUNTIME_MODE` 未设按 production，与 `runtimeMode()` 一致）在当前 **UTC** 时间 ≥ 截止日零点（含当天）起强制。截止日取 `GML_ANCHOR_INTENT_KEY_ID_REQUIRED_AFTER`，缺省 **2026-12-01**。
2. **失败闭合的解析**：日期必须是严格 `YYYY-MM-DD` 且经 `setUTCFullYear` 往返核对是真实日历日（拒绝 `2026-02-30`、`2026-12-1`、带时间 / 空白 / 换行、`20261201`）；空串视为未设；非法值抛 `INTENT_KEY_ID_AFTER_INVALID`，非法运行模式抛 `RUNTIME_MODE_INVALID`，复核命令退出 2，绝不回落到“不强制”。时钟不可用同样抛错。时钟没有环境变量或参数接缝（生产路径上不留可伪造“现在”的入口）；测试用显式的过去 / 未来日期，函数级单测注入 `now`。demo / test 下日期不读取也不校验。
3. **只在会对账意图的模式里求值**（`--offbox` / `--against-backup`），结果写进输出：文本第一行 `intent key_id: …`，JSON 顶层 `intent_key_id_rule`，说明用了 `flag` / `mode-not-enforcing` / `production-date-not-reached` / `production-date-reached` 哪条。
4. **`baseline-anchor-list-missing` 有了测试**：用同一把钥给“去掉 `anchors` 清单”的离机锚点条目重新签名（签名有效，走到对账而不是 `OFFBOX-INVALID`），断言 `unverifiable/baseline-anchor-list-missing`、退出 1，且叠加伪造桥锚点时仍不放行；带清单的对照通过。`--against-backup` 路径上清单缺锚点明细在 `loadBackupManifest` 就以 `manifest-mismatch` 失败，不会走到该分支。
5. **安装检查**（`scripts/lib/data-separation.mjs`，`local-manage doctor` 的 `dataSeparation`）：对数据目录与 `gml_*.db`（含 -wal / -shm）lstat（不跟随符号链接），按世界可写 ⇒ `exposed`、组可写 ⇒ `group-shared`、符号链接 / stat 失败 ⇒ `unknown`、属另一账号且当前账号不可写 ⇒ `separated`、其余 ⇒ `single-account`；Windows 或取不到账号 id ⇒ `skipped`（明确消息，不当作通过）；目录不存在 ⇒ `not-created`。**只报告，不强制**：`enforced:false`，退出码与文件权限都不动。

### 威胁模型边界（诚实声明）
- **能直接写数据库的人可以伪造未签名的意图。** 他能同时写业务行、审计行（重算哈希链）、`audit_chain_anchors` 与 `audit_anchor_intents`，造出自洽的“意图 + 审计行”；`key_id`、本补充的日期规则、意图哈希都不挡他——它们是格式与过渡管理，不是信任来源。唯一实质的缓解有两层：① **签名**：私钥在业务主机之外（`GML_ANCHOR_INTENT_KEY`），复核方带 `--intent-pubkey` + `--require-signed-intents`；写库者没有私钥就造不出有效签名，只能让复核失败；② **OS 级账号隔离**：库文件只属于运维账号、不对组 / 其他开放写权限，应用账号不具备伪造所需的写权限。
- **文件级隔离的实际上限**：当前是单个 SQLite 文件，应用账号为写业务数据必然能写这个文件，所以“意图表仅 CLI 账号可写、应用账号只读”在文件级**做不到**（SQLite 没有表级权限）。真正做到需要把意图表（与相关锚点写入）挪到只有 CLI 账号可写的独立库或服务——未实现，列入后续。本补充的安装检查只能如实报告现状（谁拥有、谁能写、是否对外开放），并不制造隔离。
- 同一账号既运行服务又做维护（本机单用户安装的常态）= `single-account`：此时只有离机签名能抵抗“服务被攻破后伪造意图”。
- 日期规则的环境变量由复核方自己的环境提供；能改复核环境的人可以把截止日推迟，所以输出打印生效规则与日期，变更应记入运维记录。

### 审计记录（AH5）
Codex 审计（gpt-6.1-sol，只读，针对 `batch-sixteen...97e6c28`）：无高 / 严重发现；日期解析、UTC 含当天比较、未设模式按 production、非法模式抛错、显式开关强制均确认无 fail-open。
- 中（已修）：`separated` 未考虑上一级目录可写（可改名替换整个 data 目录）⇒ 上一级目录当前账号可写时降为 `single-account` 并给 `parent-writable-by-this-account` 发现，回归测试已加。更高层祖先目录被替换仍不在检查范围。
- 低（已修）：日期规则测试只覆盖 `--offbox` ⇒ 补 `--against-backup` 路径的前 / 后用例。
- 审计方沙箱只读，未跑 CLI 集成测试；这些由本地测试覆盖。
