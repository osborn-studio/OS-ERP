# ADR-0049 审计日志防篡改哈希链与归档（AB6）

状态：开发实现，尚非产品上线验收｜相关：ADR-0009（迁移校验和）、ADR-0010（审计与脱敏）、ADR-0030（保留与隐私工具）、ADR-0035（写路径并发）、ADR-0045（指标，AA10）

## 背景

`audit_logs` 是账务与权限变更的证据，但库管理员（或拿到库文件的人）可以直接 `UPDATE` / `DELETE` 而不留任何痕迹；备份只能证明“某个时刻的库长这样”，不能证明两次备份之间有没有被改过。目标不是阻止有库写权限的人（做不到），而是**让事后篡改可被发现并定位到第一处**。同时审计表只增不减，需要一条受控的“搬出去再删”的路径，而不是手写 `DELETE`。

## 决定

### 1. 数据模型（迁移 068）

- `audit_logs` 增 `prev_hash TEXT`、`row_hash TEXT`。
- `row_hash = sha256( JSON.stringify([id, created_at, user_id, action, entity, entity_id, detail, prev_hash]) )`：八个分量先转字符串（NULL 保持 `null`）再做 JSON 数组序列化；`prev_hash` = 前一行（按 id）的 `row_hash`，库里最早一行用 64 个 `0`（`GENESIS`）。唯一实现：`server/db/migrations/_audit_chain.cjs`（迁移、运行时写入、校验器共用；放在迁移目录是因为升级演练/基准会整目录复制迁移，迁移不能依赖目录外的相对路径）。
- 规范化选择：JSON 数组自带分量边界，`action='a|b',entity='c'` 与 `action='a',entity='b|c'` 不会碰撞，NULL 与字符串 `"null"` 不同；转字符串是为了让“写入时的绑定值”和“读回的列值”落在同一输入上。SQLite 列亲和性仍会改写个别值（`'005'` 存成 5），所以写入后**按读回的存储值再算一次**，不同则只改 `row_hash`（罕见路径；与校验器同一口径）。
- `audit_chain_anchors(id, kind, at_row_id, anchor_hash, prev_id, prev_row_hash, reason, created_at)`：合法断口登记（见 §3）。迁移不在 `audit_logs` 上建任何索引（判断“表尾有无待接链的行”只需主键倒序取第一条已入链行，不增加写放大，也不动 AA6 的三棵索引）。
- 回填 = `adoptOrphans`：只接**最后一条已入链行之后**的行（首次迁移 = 整表，按 id 升序、keyset 分批 2 万行/批）。`up()` 幂等；`verify()` = 两列在、锚点表在、表尾没有待接链的行。裸 SQL 留在表尾的孤儿行下次启动被自愈接上（`insertAuditRow` 追加前也会先接上尾部孤儿）；**夹在已入链行中间的空 `row_hash` 不会被重算**——那是已建立的链被破坏，自愈若重算就等于把被改过的内容洗成合法哈希（Codex 审计 H2）。它继续被校验器报为 `unchained`。与 AB3 的 FTS 影子表及触发器互不依赖：迁移只加列、建表、回填 `UPDATE`；若 067 的 `AFTER UPDATE` 触发器已存在，回填只是更慢。

### 2. 写入与并发（`insertAuditRow` 仍是唯一 INSERT 点）

`admin-bootstrap.js` 原来自带一条裸 `INSERT INTO audit_logs`，已改走 `insertAuditRow`（同一事务）；`tests/audit-chain.test.mjs` 有静态断言：`server/` 下只有 `lib/audit-trail.js` 含 `INSERT INTO audit_logs`。

链头必须在**写锁内**读取，否则两个写者会读到同一个尾哈希而分叉。选择：

1. 不在事务里 ⇒ `BEGIN IMMEDIATE` → 读“下一个 id、当前时间、尾哈希” → 一条 INSERT → `COMMIT`。读写之间没有别的写者。
2. 已在调用方事务里 ⇒ 沿用外层锁语义，并用 `SAVEPOINT` 包住“读槽位 + INSERT + 可能的哈希校正”：任何一步抛错整体撤销本行，调用方即使吞掉异常继续提交也不会留下哈希不对的半成品（Codex 二轮）。外层是 `IMMEDIATE`（`withWriteRetry`、`retention`、`privacy-erase`）⇒ 读已在锁内。外层是 `DEFERRED` 且之前读过 ⇒ 若别的连接在此之后提交了新审计行，本次 INSERT 升级写锁得到 `SQLITE_BUSY_SNAPSHOT`——**写失败，不分叉**（`tests/audit-chain.test.mjs` 用两个连接复现）。
3. `id`（= `sqlite_sequence.seq + 1`，与 AUTOINCREMENT 自己会分配的值一致）和 `created_at` 在锁内定好，与哈希一起**一条 INSERT 写完**：没有“先 INSERT 再 UPDATE 填哈希”的半截状态，也不会触发 `audit_logs` 上的 `AFTER UPDATE` 触发器。`BEFORE INSERT … RAISE(IGNORE)` 触发器吞行（0 行）⇒ 原样返回 `changes=0`，`auditStrictRow` 照旧抛 503。
4. 语句缓存按连接复用（每次 prepare 是写审计最大的开销）。无 `row_hash` 列的旧库（迁移 068 之前、单测里的最小表）退化为原来的普通 INSERT。
5. 单进程内 better-sqlite3 同步，天然串行；跨进程（CLI、MCP 子进程）靠上面的锁。`tests/audit-chain.test.mjs` 起两个进程各写 300 条，校验 600 行一条链。

代价：审计写入多一次小查询和一次 SHA-256，实测见 capacity-baseline “AB6”。

### 3. 受控改链与锚点

链的价值在于“任何未登记的改动都被发现”，所以仓库里**合法**会动审计行的三处必须登记。登记前先验链：`deleteAuditRowsAnchored` 先对整条链跑 `verifyChain`，`rehashAuditRow` 先验“本行与下一行之间是连着的”，不通过就抛 `AUDIT_CHAIN_BROKEN`（409）并整体回滚——否则登记锚点会把链里本来就有的未登记缺口一并洗白（Codex 二轮 H）。实际后果：链已有断点时，`retention.mjs --execute` 与 `privacy-erase.mjs --confirm` 会对该库失败，先用 `audit-verify-chain` 查清断点。

| 动作 | 入口 | 登记 |
|---|---|---|
| 保留清理删行（`retention.mjs`）| `deleteAuditRowsAnchored` | 每个被删区间之后的第一条存活行：`(at_row_id=该行 id, anchor_hash=该行 prev_hash, 前驱=区间前最近的存活行 / 无)` |
| 归档删行（`audit-archive.mjs`）| 同一事务内删除并登记 | 边界行（成为表里第一行，前驱 = 无），`kind='archive'`；被归档行上的旧锚点随摘要导出后从库里删除 |
| 隐私抹除改 `detail`（`privacy-erase.mjs`，经 `applyPlan`）| `rehashAuditRow` | 重算该行 `row_hash`，并给下一行登记（它的 `prev_hash` 仍指向旧哈希，前驱 = 本行新哈希）|

锚点同时绑定两件事：该行的 `prev_hash`（`anchor_hash`）和**实际前驱行**（`prev_id` + `prev_row_hash`；表里没有前驱 ⇒ 两者为 NULL）。校验器遇到 `prev_hash` 与前一行 `row_hash` 对不上时，仅当该行上有锚点两者都对得上才放行；行内容哈希永远要自洽。只绑哈希的话，已有锚点会连带放过锚点旁边被额外删掉的行（Codex 审计 H1）。因此：删行必须留锚点，改内容必须走 `rehashAuditRow`（同一行被改写多次就追加多条锚点，各绑当时的新哈希），裸 `UPDATE`/`DELETE` 一律被报出第一个断点。

### 4. 校验：`scripts/audit-verify-chain.mjs --data-dir <dir> [--industry <行业>] [--expect-tip <hash>] [--json]`

只读，在一个读事务（同一快照）里按 id 分批顺序走全表，报告**第一个**断点：`unchained`（有行没哈希）、`content`（内容与 `row_hash` 不符）、`link`（`prev_hash` 对不上且无锚点）、`tip`（与 `--expect-tip` 不符）。退出码 0 全部 OK / 1 有断点（含库未迁到 068）/ 2 用法错误。不创建缺失的行业库；拒绝仓库 `data/`。

### 5. 归档：`scripts/audit-archive.mjs --data-dir <dir> --before <YYYY-MM-DD> --out <dir> [--industry <行业>] [--confirm <口令>]`（危险操作）

1. 待归档段 = 第一条 `created_at >= <before> 00:00:00` 之前的**id 前缀**（只有前缀被拿走，剩下的才仍是连续的链；时钟回拨造成的“id 靠前、时间更晚”的行会让前缀在那里停住，宁可少归档）。所有行都更早时**保留最后一行**，表永远不被清空（链尾不丢）。
2. 先验证该段链完整，不通过 ⇒ 拒绝（退出 1，不动任何东西）：不把已被篡改的段“洗”成合法归档。
3. 导出 JSONL（全部列 + 哈希）与 `.digest.json`（行数、首末 id、首行 `row_hash`/`prev_hash`、段尾 `row_hash`、JSONL 的 SHA-256、边界 id、段内锚点）；**读回刚写出的文件再验链**（流式分块读，内存与文件大小无关；段内被锚点承认的断口用摘要里的锚点判）。两个文件、导出目录以及每个本次新建目录的父目录都 `fsync`（失败即上抛、整体回滚）之后才提交删除——否则崩溃可能留下“库里已删、文件没落盘”（Codex 审计 H3）。导出过程中任何一步失败都删除本次创建的文件，不挡重试。边界行与段尾要么直接衔接，要么在边界处有绑定“前驱 = 段尾”的锚点。
4. 同一 `IMMEDIATE` 事务内：锁内重算计划（必须与口令一致）→ 导出 → 删除 → 登记 `kind='archive'` 锚点 → 写 `AUDIT_ARCHIVE` 严格审计（只含计数与摘要）→ 对剩余链再验一遍。任一步失败整体回滚并删除已写出的导出文件。
5. 确认机制：默认只演练，打印每个行业的计划与口令（`ARCHIVE-` + 摘要前 16 位，绑定行业、`--before`、行数、首末 id、段尾哈希）；`--confirm` 必须与执行时重算一致（演练后数据变了 ⇒ 口令失效）。多行业时口令为各行业口令的合并摘要。导出目录不得在数据目录内、不覆盖已有文件、文件权限 0600。
6. 执行期间持写锁（单事务含导出与读回），其它写入等 `busy_timeout`；请在低峰执行，100 万行实测见 capacity-baseline “AB6”。

## 限制（诚实边界）

- **能写库的攻击者可以整链重算**（含伪造锚点）。链只在“摘要被带外保存”时才能抵抗这一点：运维应把 `audit-verify-chain` 打印的 `tip`、归档的 `.digest.json` 转存到库之外（对象存储、另一台机器、纸面），下次校验用 `--expect-tip`。链本身**发现不了尾部截断**（删最后 N 行不破坏前面的链），只有 `--expect-tip` 能发现。
- 哈希**不覆盖** `user_name`、`module`、`ip` 三列（规格如此）；这三列被改，校验仍通过。后续如要覆盖需新迁移重算全链。
- 归档导出文件是被归档内容的唯一副本，必须转存到带外介质；本机删除前确认 `file_sha256`。
- 没有哈希链列的旧库（068 之前）`insertAuditRow` 退化为普通 INSERT，`audit-verify-chain` 报 `not-migrated`。
- 回填、归档都持写锁；大库请在维护窗口执行。
- `retention.mjs` 仍只清理白名单模块（ADR-0030）；变化只是删除时登记锚点。

## 后果

- 新增：迁移 068、`server/db/migrations/_audit_chain.cjs`、`server/lib/audit-chain-verify.js`、`scripts/audit-verify-chain.mjs`、`scripts/audit-archive.mjs`、`scripts/lib/audit-chain-cli.mjs`、`tests/audit-chain.test.mjs`。
- 改动：`server/lib/audit-trail.js`（链式写入、两个受控改链入口）、`server/lib/admin-bootstrap.js`（改走唯一 INSERT 点）、`scripts/retention.mjs`（删行登记锚点）、`scripts/lib/privacy-common.mjs`（`applyPlan` 改写 audit_logs 后重算）。
- 运维：docs/operations/audit-integrity.md。
