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
- `audit-verify-chain --offbox <文件> --pubkey <公钥PEM>`（二者必须同时给）：先验签（改文件、换钥、去签名、多余字段、`format` 不符都失败），再对每个被选中行业：在用链自身通过校验 + 锚定链尾是其祖先（沿用 AC7 `compareLiveToBackup`：`ok` / `rewrite`（`tip-row-differs`、`behind`、`anchors-removed`）/ `unverifiable`）；被锚定有链的行业库现已不存在 ⇒ 失败；锚点之后在**追加区间**（`at_row_id` 大于锚定链尾 id）新增的库内锚点是正常增长；但在**已锚定范围内**（`at_row_id` ≤ 锚定链尾 id）新增的库内锚点默认失败（`anchors-added/in-anchored-range`）并列出——伪造的"桥"锚点可以洗白对历史行的改写（见审计记录），而合法的保留清理 / 归档 / 隐私抹除在该范围内也会产生同样的锚点，所以由操作者对照操作记录后用 `--accept-new-anchors` 明确接受（或先做一次新锚点再比对）。锚定链尾被保留清理删除或归档搬出时需 `--archive-dir`，否则 `unverifiable`（失败）。
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
