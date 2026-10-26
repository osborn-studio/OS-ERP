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
