# ADR-0049 审计日志防篡改哈希链与归档（AB6）

状态：开发实现，尚非产品上线验收｜相关：ADR-0009（迁移校验和）、ADR-0010（审计与脱敏）、ADR-0030（保留与隐私工具）、ADR-0035（写路径并发）、ADR-0045（指标，AA10）

## 背景

`audit_logs` 是账务与权限变更的证据，但库管理员（或拿到库文件的人）可以直接 `UPDATE` / `DELETE` 而不留任何痕迹；备份只能证明“某个时刻的库长这样”，不能证明两次备份之间有没有被改过。目标不是阻止有库写权限的人（做不到），而是**让事后篡改可被发现并定位到第一处**。同时审计表只增不减，需要一条受控的“搬出去再删”的路径，而不是手写 `DELETE`。

## 决定

### 1. 数据模型（迁移 068）

- `audit_logs` 增 `prev_hash TEXT`、`row_hash TEXT`。
- `row_hash = sha256( JSON.stringify([id, created_at, user_id, action, entity, entity_id, detail, prev_hash]) )`：八个分量先转字符串（NULL 保持 `null`）再做 JSON 数组序列化；`prev_hash` = 前一行（按 id）的 `row_hash`，库里最早一行用 64 个 `0`（`GENESIS`）。唯一实现：`server/lib/audit-chain.cjs`（迁移、运行时写入、校验器共用）。
- 规范化选择：JSON 数组自带分量边界，`action='a|b',entity='c'` 与 `action='a',entity='b|c'` 不会碰撞，NULL 与字符串 `"null"` 不同；转字符串是为了让“写入时的绑定值”和“读回的列值”落在同一输入上（SQLite 列亲和性会把 `'5'` 存成 5）。
- `audit_chain_anchors(id, kind, at_row_id, anchor_hash, reason, created_at)`：合法断口登记（见 §3）。部分索引 `idx_audit_unchained ON audit_logs(id) WHERE row_hash IS NULL` 让 `verify()` 判断“有无未入链的行”不必扫全表（链健康时它是空的，不增加写放大）。
- 回填：迁移内按 id 升序、keyset 分批（2 万行/批）重算，从第一条 `row_hash IS NULL` 的行起到表尾。`up()` 幂等；`verify()` = 两列在、锚点表在、索引在、没有未入链的行，所以裸 SQL 塞进去的孤儿行下次启动会被自愈接上（其后的行一并重算）。与 AB3 的 FTS 影子表及触发器互不依赖：迁移只加列、建表、回填 `UPDATE`；若 067 的 `AFTER UPDATE` 触发器已存在，回填只是更慢。

### 2. 写入与并发（`insertAuditRow` 仍是唯一 INSERT 点）

`admin-bootstrap.js` 原来自带一条裸 `INSERT INTO audit_logs`，已改走 `insertAuditRow`（同一事务）；`tests/audit-chain.test.mjs` 有静态断言：`server/` 下只有 `lib/audit-trail.js` 含 `INSERT INTO audit_logs`。

链头必须在**写锁内**读取，否则两个写者会读到同一个尾哈希而分叉。选择：

1. 不在事务里 ⇒ `BEGIN IMMEDIATE` → 读“下一个 id、当前时间、尾哈希” → 一条 INSERT → `COMMIT`。读写之间没有别的写者。
2. 已在调用方事务里 ⇒ 不嵌套，沿用外层锁语义。外层是 `IMMEDIATE`（`withWriteRetry`、`retention`、`privacy-erase`）⇒ 读已在锁内。外层是 `DEFERRED` 且之前读过 ⇒ 若别的连接在此之后提交了新审计行，本次 INSERT 升级写锁得到 `SQLITE_BUSY_SNAPSHOT`——**写失败，不分叉**（`tests/audit-chain.test.mjs` 用两个连接复现）。
3. `id`（= `sqlite_sequence.seq + 1`，与 AUTOINCREMENT 自己会分配的值一致）和 `created_at` 在锁内定好，与哈希一起**一条 INSERT 写完**：没有“先 INSERT 再 UPDATE 填哈希”的半截状态，也不会触发 `audit_logs` 上的 `AFTER UPDATE` 触发器。`BEFORE INSERT … RAISE(IGNORE)` 触发器吞行（0 行）⇒ 原样返回 `changes=0`，`auditStrictRow` 照旧抛 503。
4. 语句缓存按连接复用（每次 prepare 是写审计最大的开销）。无 `row_hash` 列的旧库（迁移 068 之前、单测里的最小表）退化为原来的普通 INSERT。
5. 单进程内 better-sqlite3 同步，天然串行；跨进程（CLI、MCP 子进程）靠上面的锁。`tests/audit-chain.test.mjs` 起两个进程各写 300 条，校验 600 行一条链。

代价：审计写入多一次小查询和一次 SHA-256，实测见 capacity-baseline “AB6”。

### 3. 受控改链与锚点

链的价值在于“任何未登记的改动都被发现”，所以仓库里**合法**会动审计行的三处必须登记：

| 动作 | 入口 | 登记 |
|---|---|---|
| 保留清理删行（`retention.mjs`）| `deleteAuditRowsAnchored` | 每个被删区间之后的第一条存活行：`(at_row_id=该行 id, anchor_hash=该行 prev_hash)` |
| 归档删行（`audit-archive.mjs`）| 同一事务内删除并登记 | 边界行 ↔ 段尾 `row_hash`，`kind='archive'` |
| 隐私抹除改 `detail`（`privacy-erase.mjs`，经 `applyPlan`）| `rehashAuditRow` | 重算该行 `row_hash`，并给下一行登记（它的 `prev_hash` 仍指向旧哈希）|

校验器遇到 `prev_hash` 与前一行 `row_hash` 对不上时，仅当同 id 存在 `anchor_hash` 等于该行 `prev_hash` 的锚点才放行；行内容哈希永远要自洽。因此：删行必须留锚点，改内容必须走 `rehashAuditRow`，裸 `UPDATE`/`DELETE` 一律被报出第一个断点。

### 4. 校验：`scripts/audit-verify-chain.mjs --data-dir <dir> [--industry <行业>] [--expect-tip <hash>] [--json]`

只读，按 id 分批顺序走全表，报告**第一个**断点：`unchained`（有行没哈希）、`content`（内容与 `row_hash` 不符）、`link`（`prev_hash` 对不上且无锚点）、`tip`（与 `--expect-tip` 不符）。退出码 0 全部 OK / 1 有断点（含库未迁到 068）/ 2 用法错误。不创建缺失的行业库；拒绝仓库 `data/`。

### 5. 归档：`scripts/audit-archive.mjs --data-dir <dir> --before <YYYY-MM-DD> --out <dir> [--industry <行业>] [--confirm <口令>]`（危险操作）

1. 待归档段 = 第一条 `created_at >= <before> 00:00:00` 之前的**id 前缀**（只有前缀被拿走，剩下的才仍是连续的链；时钟回拨造成的“id 靠前、时间更晚”的行会让前缀在那里停住，宁可少归档）。所有行都更早时**保留最后一行**，表永远不被清空（链尾不丢）。
2. 先验证该段链完整，不通过 ⇒ 拒绝（退出 1，不动任何东西）：不把已被篡改的段“洗”成合法归档。
3. 导出 JSONL（全部列 + 哈希）与 `.digest.json`（行数、首末 id、首行 `row_hash`/`prev_hash`、段尾 `row_hash`、JSONL 的 SHA-256、边界 id）；**读回刚写出的文件再验链**。
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

- 新增：迁移 068、`server/lib/audit-chain.cjs`、`server/lib/audit-chain-verify.js`、`scripts/audit-verify-chain.mjs`、`scripts/audit-archive.mjs`、`scripts/lib/audit-chain-cli.mjs`、`tests/audit-chain.test.mjs`。
- 改动：`server/lib/audit-trail.js`（链式写入、两个受控改链入口）、`server/lib/admin-bootstrap.js`（改走唯一 INSERT 点）、`scripts/retention.mjs`（删行登记锚点）、`scripts/lib/privacy-common.mjs`（`applyPlan` 改写 audit_logs 后重算）。
- 运维：docs/operations/audit-integrity.md。
