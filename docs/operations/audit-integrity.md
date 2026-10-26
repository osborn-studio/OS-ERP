# 审计日志完整性：哈希链校验与归档

适用：ADR-0049（迁移 068）。`audit_logs` 每行带 `prev_hash` / `row_hash`，串成一条链；任何未登记的改动都会被校验脚本定位到第一处。

## 1. 日常校验

```sh
node scripts/audit-verify-chain.mjs --data-dir /abs/path/to/data            # 所有行业库
node scripts/audit-verify-chain.mjs --data-dir /abs/path/to/data --industry cosmetic --json
```

- 退出码 0 = 链完整；1 = 有断点（输出第一个断点的 id 与类型）；2 = 用法 / 环境错误。库没有升级到迁移 068 会报 `NOT-MIGRATED` 并退出 1。
- 断点类型：`content` 该行内容被改；`link` 中间行被删 / 插入（无锚点登记）；`unchained` 有行没进链（裸 SQL 写入）：若它们在表尾，下次服务启动 / 下一条审计写入会把它们接上，但在那之前它就是告警；若夹在已入链的行中间，系统**不会**自愈（避免把篡改洗白），它会一直被报出来；`tip` 与 `--expect-tip` 不符。
- 100 万行约 3–4 s（只读，不阻塞写入）。建议随备份校验每天跑一次，并**把输出里的 `tip=` 值带外保存**（另一台机器 / 对象存储 / 工单）。

### 发现尾部截断

链本身看不出“最后几行被删”。把上次保存的 tip 传进来：

```sh
node scripts/audit-verify-chain.mjs --data-dir /abs/path/to/data --industry cosmetic --expect-tip <上次的 tip>
```

注意：合法的归档 / 保留清理之后 tip 会随新审计行前进，`--expect-tip` 应使用**最近一次校验**记录的值，且校验与记录之间若有新行写入，tip 当然不同——所以这条用在“同一时刻停写后的对账”或“把上一份 `.digest.json` 的 `tip_row_hash` 与归档当时的链尾对照”。日常以趋势为准：`last_id` 只增不减。

## 2. 归档（危险操作）

把 `--before` 日期之前的审计行搬出库、导出为 JSONL，并在库里重新锚定。**不可逆**：被归档的行只剩导出文件。

```sh
# 1) 演练：不写任何东西，打印每个行业的计划和口令
node scripts/audit-archive.mjs --data-dir /abs/data --industry cosmetic --before 2025-01-01 --out /abs/archive-dir
# 2) 确认：把演练输出的口令原样传回
node scripts/audit-archive.mjs --data-dir /abs/data --industry cosmetic --before 2025-01-01 --out /abs/archive-dir --confirm ARCHIVE-XXXXXXXXXXXXXXXX
```

要点：
- 先在低峰执行：整个归档（验证、导出、读回、删除）在一个写事务里，100 万行约 28 s（Mac mini，见 capacity-baseline “AB6”），期间其它写入等待 `busy_timeout`（默认 5 s）。
- `--out` 必须在数据目录**之外**，不覆盖已有文件；产物是 `audit-archive-<行业>-<日期>-<首id>-<末id>.jsonl`（0600）与同名 `.digest.json`。
- 拒绝条件（退出 1，什么都不动）：待归档段链校验失败；边界行与段尾不衔接且无锚点；导出文件读回校验失败；归档后剩余链校验失败（整个事务回滚、导出文件被删，可重试）。执行时重算的计划与口令不一致退出 2。
- 导出文件与目录项在提交删除前已 fsync；`.digest.json` 里的 `anchors` 是该段内保留清理 / 隐私抹除留下的合法断口，离线复核要一起用。
- 只会搬走 id 前缀，且库里永远至少保留最后一行；归档后库里写入一条 `AUDIT_ARCHIVE` 审计（只含计数与摘要）。
- **导出文件和摘要必须转存到带外介质**（它们是被归档内容的唯一副本，也是以后证明“这一段没被改过”的依据），确认 `.digest.json` 里的 `file_sha256` 后再清理本机。
- 归档后立刻跑一次第 1 节的校验，应为 `OK` 且“锚点”计数 ≥ 1。

## 3. 保留清理与隐私抹除对链的影响

- `scripts/retention.mjs --execute` 删除白名单模块的过期审计行时，会在每个被删区间之后登记锚点；校验仍为 OK，输出的锚点计数会增加。**链已有断点时它会拒绝执行**（该库失败、什么都不删），先用第 1 节查清。
- `scripts/privacy-erase.mjs --confirm` 改写含号码的审计行 `detail` 时，会重算该行哈希并给下一行登记锚点；被改写行与下一行之间若本来就断了，会拒绝并回滚。
- 其它任何直接改 / 删 `audit_logs` 的操作（手写 SQL、第三方工具）都会被报成断点。需要这么做时，走归档或保留清理，不要手写。

## 4. 恢复与排障

- 断点 id 指出**第一处**不一致，之后的行全受连累。对照备份（`db-restore-drill`）确认该 id 附近是谁在何时改动；链本身不能还原被改的内容。
- `unchained` 在表尾：通常来自绕过 `insertAuditRow` 的裸 `INSERT`；重启服务（迁移 068 的 `verify()`）或下一条正常审计写入会把它们接上链。这个自愈本身不写审计，所以先保留校验输出作为证据。
- `unchained` 在表中间：有人把已入链行的 `row_hash` 清空了。系统不会自愈；以备份为准核对该 id 的内容，需要重建链时走明确的运维流程（先保留证据）。
- 备份恢复到旧快照后，链是自洽的旧链（`last_id` 回退）；如保存过 tip，与之比较可得知回退了多少。

## 5. 归档中断后续做（`--resume`）

归档在一个写事务里先导出（fsync）再删除。进程在“导出已落盘、删除未提交”之间被杀（`kill -9`、断电）时，库原样回滚、导出文件完整。表现：重跑原命令报 `OUT_EXISTS … 用 --resume 续做`。处理：

```sh
# 1) 演练：核对导出文件与库里这一段逐字节一致，给出口令（不改任何东西）
node scripts/audit-archive.mjs --data-dir /abs/data --industry cosmetic --before 2025-01-01 --out /abs/archive-dir --resume
# 2) 确认
node scripts/audit-archive.mjs --data-dir /abs/data --industry cosmetic --before 2025-01-01 --out /abs/archive-dir --resume --confirm ARCHIVE-XXXXXXXXXXXXXXXX
```

- 续做**不重写**导出，只做核对 + 删除 + 登记锚点 + `AUDIT_ARCHIVE` 审计。核对项：摘要字段与当前计划一致；JSONL 的 SHA-256 等于摘要；读回链校验通过；JSONL 与库里该段逐字节相同（`user_name` / `module` / `ip` 不进哈希，只有这一步能发现它们在崩溃后被改）；段内锚点与摘要一致。任何一项不符：退出 1，库与文件都不动，`EXPORT_DIGEST_MISMATCH` / `EXPORT_VERIFY_MISMATCH` / `EXPORT_DB_MISMATCH`——先查清谁动了文件或库，不要删导出文件。
- `RESUME_INCOMPLETE`：只有 JSONL 没有摘要（崩在导出途中）；人工确认库未变后删掉残留文件，按第 2 节做新归档。`RESUME_NOTHING`：`--out` 里没有对应导出，`--resume` 不会当成新归档。
- 续做在删除前会再对导出文件与目录项 fsync。
- 幂等：已归档完成时再跑 `--resume` 输出 `already-archived`、退出 0，不再删除、不再写审计。
- 故障注入 `GML_TEST_ARCHIVE_PAUSE_AFTER_EXPORT=1` 只给测试用（仅 `GML_RUNTIME_MODE=test`），生产设置它会被拒绝。

## 5b. 写入序列的故障注入与恢复语义（AD6）

`scripts/lib/fs-fault.mjs` 在多步写入序列的相邻两步之间放了命名注入点。`GML_TEST_FS_FAULT=<点名>` 命中时按 `GML_TEST_FS_FAULT_MODE=throw`（默认，走脚本自己的失败清理）或 `abort`（`process.abort()`，SIGABRT，不跑 `finally` / 退出处理器，最接近断电）终止。**只在 `GML_RUNTIME_MODE=test` 下可用**：其他模式下只要设置了该变量（或模式变量），三个脚本在做任何写入之前就以 `FS_FAULT_FORBIDDEN` 失败（audit-archive、db-backup 退出 2；`release-candidate --log` 在构建前失败）；点名拼错 ⇒ `FS_FAULT_UNKNOWN`。测试 `tests/fs-fault.test.mjs` 对每个点 × 两种模式起子进程，断言崩后状态属下表之一，且下一次正常运行 / `--resume` 安全、幂等地接续。`abort` 只能模拟“进程死了、页缓存还在”；真正掉电丢失尚未 fsync 的字节，靠表里“撕裂尾部”一行与各步骤的 fsync 顺序保证。

### audit-archive（导出 → fsync → 删除 → 锚定，一个 IMMEDIATE 事务）

| 注入点 | 位置 | abort 后磁盘状态 | throw 后 | 恢复 |
| --- | --- | --- | --- | --- |
| `archive.after-export-write` | JSONL 已写、未 fsync | 库不动；只有（可能不完整的）JSONL，无摘要 | 脚本删除本次创建的文件，库不动 | abort：`--resume` 报 `RESUME_INCOMPLETE`，正常重跑报 `OUT_EXISTS`；人工确认库未变后删掉孤儿 JSONL，再按第 2 节做新归档。throw：直接重跑 |
| `archive.after-export-fsync` | JSONL 已 fsync、摘要未写 | 同上（完整 JSONL，无摘要） | 同上 | 同上 |
| `archive.before-delete` | 导出与摘要都已落盘、尚未 DELETE | 库不动；JSONL + 摘要完整 | 事务回滚，新建的导出文件被删除 | abort：`--resume` 演练 → `--resume --confirm`；续做不重写导出。throw：直接重跑 |
| `archive.after-delete` | 段已删、锚点未登记（事务未提交） | 同上（SQLite 回滚未提交的删除） | 同上 | 同上 |
| `archive.after-anchor` | 锚点与 `AUDIT_ARCHIVE` 审计已写、事务未提交 | 同上 | 同上 | 同上 |

任何状态下库里都不会出现“段已删但锚点缺失”：删除、锚点、审计在同一事务里，提交之前崩溃一律回滚。`--resume` 完成后再跑一次 `--resume` 输出 `already-archived`、退出 0，不再删除、不再写审计。

### db-backup（快照 → 校验 → 终名 + 目录 fsync → 清单 fsync → 清理计划 → 持久化报告 → 删除 + 目录 fsync → 终版报告）

阶段顺序（AF6）：冻结窗口内所有库先生成快照 →（3a）**所有库**逐个校验、落终名并 fsync 目录项（加密模式再擦除明文）→（3b）逐库写清单（文件 fsync，再 fsync 目录）→（AG6）算出清理计划（旧备份 + 孤儿清单）记入条目 → 把含该计划的 **pre-prune 报告**持久化（临时文件 fsync → rename → 目录 fsync）→ 删除（备份先、清单后）→ 目录 fsync → 写 **final 终版报告**（同样的 fsync/rename/目录 fsync 序列）。没有要删的东西时只写终版一份。注入点按此顺序：

| 注入点 | 位置 | abort 后磁盘状态 | throw 后 | 恢复 |
| --- | --- | --- | --- | --- |
| `backup.after-db-copy` | `VACUUM INTO` 已完成、尚未校验 | 无密钥：`<终名>.partial`（**没有终名 `.db`**，不会被裁剪当成备份）；有密钥：0600 的 `.plain.tmp` 明文临时文件 | 快照失败路径：`.db.failed`（有密钥时擦除明文），本次非零退出 | 之前的备份不受影响；下一次正常运行照常完成。残留的 `.partial` / `.plain.tmp` 由运维清理（`.plain.tmp` 须擦除，见 ADR-0022） |
| `backup.after-enc-rename-fsync`（AF6） | 3a 结束：所有库的终名已 fsync 目录项（加密模式：密文已回读认证、明文已擦除）；任何库都还没有清单 | 每个库一份已验证的终名备份，**没有任何清单**（可用，缺链清单）；加密模式无任何明文 | 终名备份被删除，`BACKUP_FINALIZE_FAILED`，非零退出 | 重新备份；孤儿终名备份确认后可删，否则按 keep 规则被裁剪 |
| `backup.before-sidecar` | 3b 开始、第一个库的清单未写 | 同上（已验证的终名、无清单） | 清单失败路径删除这份半成品备份，`BACKUP_MANIFEST_FAILED`，非零退出 | 下一次正常运行生成带清单的新备份；孤儿 `.db` 确认后可手工删除，否则按 keep 规则被裁剪 |
| `backup.after-manifest-fsync`（AF6） | 第一个库的 `.audit-manifest.json`（及加密模式的 `.audit-manifest.enc`）已写、清单文件已 fsync、目录已 fsync；裁剪与报告未做 | 备份 + 清单完整（含清单的目录项已 fsync），没有本次报告；其余库（如有）只有终名、无清单 | 清单失败路径删除该库的备份与清单（`BACKUP_MANIFEST_FAILED`） | abort：备份可用；下一次正常运行写新报告并按 keep 裁剪。throw：重跑 |
| `backup.after-sidecar` | 备份与清单都已落盘、报告未写 | 备份 + 清单完整，没有本次报告 | 同左（未捕获异常，进程非零退出） | 备份可用；下一次正常运行写出新报告并按 keep 裁剪 |
| `backup.after-report-write-before-rename`（AG6） | 一份报告的临时文件 `.backup-report-<stamp>.json.<rand>.tmp` 已写完且已 fsync，尚未 rename；每次写报告前都会触发（有清理计划时先是 pre-prune 那份，其后是终版那份）。pre-prune 那份触发时**还没删任何文件** | 新备份 + 清单完整；旧报告原样保留（报告名下没有半截文件）；留下一个内容完整的 `.backup-report-*.tmp`（点文件，不匹配报告名规则）；有清理计划时旧备份**一个都没删** | 该次报告写入失败：删掉自己的临时文件、打印“报告写入失败”、非零退出；备份与清单完整；若是 pre-prune 那份失败，该目录的清理被跳过（`prune_state=skipped`，不删任何文件） | 备份可用。下一次正常运行先清扫遗留的 `.backup-report-*.tmp`，再照常写报告并按 keep 裁剪。临时文件内容就是本次本该落地的报告，可用于事后查看 |
| `backup.after-prune-delete-before-dirsync`（AG6） | 清理已 `unlink` 旧备份与其清单、**目录未 fsync**；pre-prune 报告（`report_phase=pre-prune`，条目 `prune_state=planned`，`pruned` 列出本次要删/已删的文件名）已持久化；终版报告未写。仅当本次确实删了文件才触发 | 新备份 + 清单完整；报告是 pre-prune 版（盘上同时可能因断电“复活”部分旧备份——无害，下次按 keep 再裁）；`pruned` 里的名字要么已删要么将删 | 清理捕获为失败：条目 `prune_state=failed`、`prune_error=BACKUP_PRUNE_FAILED…`，终版报告照常写出，非零退出（备份本身仍是 `ok`） | 备份可用。下一次正常运行继续：按 keep 规则裁剪仍超额的旧备份，并清扫**上一份报告里 `prune_state` 为 `planned` / `failed` 的 `pruned` 所列备份**对应的“备份已不在、清单还在”孤儿清单（条目 `pruned_orphans`）；与被打断的清理无关的孤儿清单（如备份被搬到机外、清单留作审计基线）**不会**被自动清扫。删了备份没来得及删清单的状态由此自愈 |

无密钥模式下终名 `.db` 只在 fsync + 校验通过后经 rename 出现，因此“磁盘上有终名 `.db`”总是意味着该快照通过过完整性校验。

#### 加密模式（`GML_BACKUP_KEY`）下同七个注入点（AE6 / AF6 / AG6）

加密模式不写 `.partial` / 终名 `.db` / `.failed`：明文只存在于 0600 的 `.plain.tmp`，密文直接写 `<终名>.db.enc`。`tests/fs-fault.test.mjs` 对每点 × 两种模式断言：备份目录里（含点文件）除 `after-db-copy` 的 abort 外**没有任何以 `SQLite format 3` 开头的明文文件**，且 `.db.enc` / `.audit-manifest.enc` 能用当前密钥认证解开。

| 注入点 | abort 后磁盘状态 | throw 后 | 恢复 |
| --- | --- | --- | --- |
| `backup.after-db-copy` | 唯一明文窗口：一个 0600 `.plain.tmp`（abort 跑不了退出处理器）；无 `.db.enc` | 退出处理器 / 失败路径擦除明文，无 `.failed`；`BACKUP_SNAPSHOT_FAILED`，非零退出 | 之前的密文备份不受影响；abort 遗留的 `.plain.tmp` 必须由运维**擦除**（不是普通删除），之后正常运行即可；本次运行不会新增明文 |
| `backup.after-enc-rename-fsync` | 已通过回读认证的 `.db.enc`（目录项已 fsync），明文已擦除；无任何清单 | 删掉 `.db.enc`；`BACKUP_FINALIZE_FAILED` | 重新备份；孤儿 `.db.enc` 确认后可删，否则按 keep 裁剪 |
| `backup.before-sidecar` | 同上 | 清单失败路径删掉这份 `.db.enc`；`BACKUP_MANIFEST_FAILED` | 同上 |
| `backup.after-manifest-fsync` | `.db.enc` + `.audit-manifest.json` + `.audit-manifest.enc` 齐全（清单已 fsync、目录已 fsync），无明文临时文件；缺报告 | 删掉该库的 `.db.enc` 与两份清单；`BACKUP_MANIFEST_FAILED` | abort：备份可用，下次正常运行写报告；throw：重跑 |
| `backup.after-sidecar` | 同 `after-manifest-fsync` 的 abort 状态 | 未捕获异常、非零退出，磁盘状态同左 | 备份可用；下一次正常运行写报告并按 keep 裁剪 |
| `backup.after-report-write-before-rename`（AG6） | `.db.enc` + 两份清单齐全，无明文；旧报告不变；遗留一个完整的报告 `.tmp`（报告只含元数据与密文 sha256，不含明文数据） | 同上，自己的 `.tmp` 被删，非零退出 | 同明文表：下次运行清扫 `.tmp` 并写报告 |
| `backup.after-prune-delete-before-dirsync`（AG6） | 旧 `.db.enc` 与其两份清单已删（目录未 fsync），新 `.db.enc` + 清单完整，无明文；pre-prune 报告已列出 `pruned` | `prune_state=failed`，终版报告写出，非零退出 | 同明文表：下次运行继续裁剪并清扫孤儿清单 |

**多库（默认三库一起备份）**：三库的明文快照在同一冻结窗口内先全部生成（kill -9 / 断电落在窗口内时三份 0600 `.plain.tmp` 都可能留盘）。AF6 起，窗口之后**所有库先完成加密、目录 fsync 并擦除明文**，才进入清单阶段，所以 `after-enc-rename-fsync` / `before-sidecar` / `after-manifest-fsync` / `after-sidecar` 的 abort 与 throw 都不会留下任何库的明文（`tests/fs-fault.test.mjs` 的 `all three industries` 用例对这四个点断言：无 `.plain.tmp`、目录里无任何明文 SQLite、三份 `.db.enc` 都能解开）。三库时的清单阶段：`before-sidecar` / `after-manifest-fsync` 的 **throw** 对每个库各触发一次，三个库的半成品备份与清单全部被清掉（报告 `failed=3`）；`after-sidecar` 的 abort 与 throw 是进程级终止，第一个库有备份 + 清单，**其余两个库只有已验证的终名备份、没有清单**（可用，缺链清单，按上文孤儿处理）。意外异常（fsync/rename 本身出错）：无密钥路径的终名阶段出错会删除该库的终名并记 `BACKUP_FINALIZE_FAILED`；加密路径的出错走 `BACKUP_ENCRYPT_FAILED`；清单阶段的出错走 `BACKUP_MANIFEST_FAILED`。仍然存在的明文窗口：`after-db-copy`（其后到该库加密完成之间）与冻结窗口至加密阶段结束之间的 kill -9 / 断电——恢复时检查并**擦除**备份目录里所有 `*.plain.tmp`。（AE6 的旧结论“其余库的 `.plain.tmp` 在 `before-sidecar` / `after-sidecar` 的 abort 后仍在盘上”已不再成立。）

注意 `.audit-manifest.json` 在加密模式下仍是明文，内容固定为 `format / industry / backup_file / backup_sha256 / created_at / audit_chain`（`audit_chain` 为链尾 id / 行哈希 / 行数与锚点明细，含锚点 reason 与时间戳；不含业务行数据；测试断言键集合），设计如此；需要机密性的离机副本用 `.audit-manifest.enc`。

#### 持久性声明：进程崩溃 vs 断电（AF6）

- **进程崩溃（kill -9 / SIGABRT / 异常退出，内核存活）**：上表即全部结论，由 abort 模式的注入测试逐点验证；页缓存里的数据不丢。
- **断电 / 内核崩溃**：脚本按下列顺序发起 fsync，**在 Linux ext4/xfs 上**这些顺序使得“到达某一注入点”意味着此前的步骤已持久：快照文件 fsync → 改终名 → **目录 fsync** →（加密模式）擦除明文；清单文件 fsync（明文清单；密文清单由 `encryptFile` 在 rename 前 fsync）→ **目录 fsync**（覆盖两种清单的目录项）→ 报告（AG6：临时文件 fsync → rename → 目录 fsync；有清理计划时这是 pre-prune 报告）→ 删除旧备份与清单 → **目录 fsync** → 终版报告。`tests/fs-fault.test.mjs` 的 `fsync order` 用例用只读的 fs 追踪器断言这些**调用顺序**（密文/清单临时文件先 fsync 再 rename、目录 fsync 先于第一次明文覆写、新建目录的父目录 fsync、清单 fsync + 目录 fsync 先于报告 rename；AG6：报告临时文件 fsync → rename → 目录 fsync，pre-prune 报告先于第一次 `unlink`，删除后的目录 fsync 先于终版报告；它证明脚本发起了 fsync，不证明硬件落盘）。
- **macOS**：`fsync` 只保证到磁盘缓存，不等于 `F_FULLFSYNC`（Node 不暴露），所以在 macOS 上这些 fsync 是尽力而为，不能据此声称断电持久。
- **新建目录**：首次运行创建备份目录（含嵌套的 `backup_dir`）时，脚本逐级 fsync 每个新目录的父目录；已存在的目录层级不重复处理，其自身的持久性是前提。
- **未覆盖**：① （AG6 已收口，不再属于未覆盖）报告文件现在是临时文件 → fsync → rename → 目录 fsync，裁剪删除之后也 fsync 目录；清理前先把“将删除清单”持久化进 pre-prune 报告。仍然成立的限制：报告是诊断记录，不是恢复所需对象——它的持久化只保证：一旦命令走过“报告 rename + 目录 fsync”这一步，报告在 Linux ext4/xfs 上断电后仍在（macOS 仍是尽力而为）；在此之前断电或被杀，本次运行仍可能没有报告（备份与清单不受影响）；旧报告的**清理**（超出保留份数的 `backup-report-*.json`）删除后虽然 fsync 了目录，但没有对应的“记录先于删除”（旧报告本身就是被淘汰的诊断记录）；② 断电后目录项未落盘的删除可能“复活”已裁剪的旧备份（无害，下次按 keep 再裁，并会清扫其孤儿清单）；③ 被擦除的明文只做了零填充 + fsync，文件系统/SSD 层面的残留不在保证内；④ 没有做过真实断电实验——只有进程级 abort 与调用顺序断言。断电之后，离机保存清单前应对最近一份备份再跑一次校验（`--against-backup` 或重新备份）。

#### 平台差异：macOS 与 Linux（AE6）

脚本只依赖下列原语；`tests/fs-fault.test.mjs` 的 `platform:` 用例逐条验证（macOS 开发机已跑；Linux 由 CI `checks` job 在 ubuntu-latest 上跑同一文件，本地未验证）：

| 原语 | macOS (APFS) | Linux (ext4/xfs/overlayfs) | 脚本的依赖 |
| --- | --- | --- | --- |
| 同目录 `rename` 覆盖已有文件 | 原子；已打开的读者保留旧 inode | 同 | `.partial` → 终名、报告覆盖；两平台一致，严格断言 |
| `rename` 文件到目录 / 目录到非空目录 | `EISDIR` / `ENOTEMPTY`（或 `EEXIST`） | 同 | 被拒绝而非合并；严格断言 |
| 目录 `fsync`（只读打开目录） | 成功，但 `fsync` 只保证到磁盘缓存，不保证落盘（需 `F_FULLFSYNC`，Node 不暴露） | 持久化目录项 | db-backup 在 `.partial` → 终名、加密路径的密文改名、清单写入之后都会 fsync 目录（AF6），在 macOS 上是尽力而为；`abort` 模拟（进程死、内核存活）对两者结论相同。**本测试只验证进程崩溃与 fsync 调用顺序，不验证断电持久性**（详见上文“持久性声明”）；断电后的备份仍应再跑一次校验（`--against-backup` / 重新备份） |
| 以写方式打开目录 | `EISDIR` | 同 | 目录 fsync 必须只读打开 |
| 大小写 | 默认大小写不敏感（可格式化为敏感） | 敏感 | 所有备份/报告名都是小写库名 + 数字时间戳 + 固定后缀，冲突检测在两者上一致 |
| `open(..., 'wx')` / `link` 到已存在名 | `EEXIST` | 同 | 清单边车用 `wx`，不会覆盖遗留清单 |

注意：Windows 不在支持范围（目录 fsync 被跳过，`rename` 覆盖语义不同）。运行时间：故障矩阵（`tests/fs-fault.test.mjs` 全部用例，AG6 后 63 个）本机约 45–80 秒空闲机；AG6 当天整机负载 40–60 时 208–224 秒（超出空闲机的 3 分钟预算，纯属负载所致，见 capacity-baseline.md AG6 记录）；每个子进程有 120 秒超时，用例级超时 180 秒。

### 证据日志追加（`release-candidate --log` → `appendEntry`）

追加在独占锁 `<log>.lock` 内进行：读-校验 → 写一行 → fsync → 解锁。

| 注入点 | 位置 | abort 后状态 | throw 后 | 恢复 |
| --- | --- | --- | --- | --- |
| `log.after-lock` | 锁已取得，尚未读日志 | 日志不动；残留锁文件 | 锁释放，日志不动 | abort：确认无进程在追加后手工删除 `<log>.lock`，重跑 |
| `log.after-write-before-fsync` | 新行已写、未 fsync | 残留锁；新行在页缓存里通常已存在（进程死不丢字节）；真正掉电可能只剩半行 | 文件被截回追加前长度，锁释放：日志与追加前逐字节相同 | abort：删锁；日志有效 ⇒ 该候选已入账，重跑会报“already in the evidence log”（新 commit 换新候选名，或从 git 恢复日志后重建）；半行 ⇒ 日志被拒绝（不自动修复），`git checkout` 已提交的日志再重跑 |
| `log.after-fsync-before-unlock` | 新行已 fsync、锁未删 | 残留锁；该行已入账 | 锁释放；该行已入账（fsync 之后即算提交） | abort：删锁；该候选已入账，处理同上 |

`release-candidate` 在追加失败时会清理候选产物；追加在 fsync 之后才抛的错误带 `committed=true`，此时**保留**候选产物（行已入账，清理会让同名重建被日志拒绝）。进程被杀的情形下产物可能已被留在 `--output` 里：行已入账 ⇒ 提交这一行并保留产物；行未入账 ⇒ 删除产物后重跑。写入用循环写满（短写不会被当成成功）。

## 6. 离机保存：链尾、锚点摘要与归档摘要

能写库的人可以改内容后整链重算（含伪造锚点），库内的链和锚点对他无效；只有**库外**的记录能拆穿。需要离机保存三样东西：

| 对象 | 来源 | 保存什么 |
|---|---|---|
| 备份清单 | 每次 `db-backup.mjs` 在备份旁写 `<备份>.audit-manifest.json`（加密模式另有 `.audit-manifest.enc`），报告条目也带 `audit_chain` | 链尾 id / `tip_hash`、行数、`anchors_digest`（锚点明细在清单文件里） |
| 归档摘要 | `audit-archive.mjs` 的 `.digest.json` 与 `.jsonl` | 两个文件一起；`file_sha256`、`tip_row_hash` 另记一份 |
| 日常 tip | `audit-verify-chain.mjs` 输出的 `tip=` | 时间 + tip |

流程（建议每天备份后立即执行）：

1. 备份完成后把 `backups/` 里**新备份的清单**（`*.audit-manifest.json`，加密模式连同 `.audit-manifest.enc`）复制到另一台机器 / 对象存储 / 只追加的介质，并把 `tip_hash` 写进工单或台账。备份文件本身按原有流程离机。**不要只放在同一块盘上**——攻击者能写库通常也能写本机备份目录。
2. 归档后立刻把 `audit-archive-*.jsonl` 与 `.digest.json` 转存离机，核对 `file_sha256`，再清理本机副本。
3. 复核（可定期，也可事故时）：把离机保存的清单取回，与本机在用库对比：

```sh
node scripts/audit-verify-chain.mjs --data-dir /abs/data --against-backup /path/to/gml_cosmetic_20261024-020000.db.enc   # 加密备份需 GML_BACKUP_KEY
node scripts/audit-verify-chain.mjs --data-dir /abs/data --against-backup /path/to/…db.audit-manifest.json --archive-dir /abs/archive-dir --strict-anchors
```

- 先交叉核对清单：明文 vs 密文清单、清单 vs 备份内容（备份在本机时从备份本身重算）、锚点明细 vs `anchors_digest`。对不上 = `manifest-mismatch`，说明清单或备份被动过。**密文备份 / 密文清单必须设置 `GML_BACKUP_KEY`**，否则 `key-required`（退出 1）——不会只凭明文清单放行。备份时链就已不通过（`verified:false`）的备份不能当基线（`unverifiable`）。
- 再要求在用链是备份链尾的**后代**：同 id 行的 `row_hash` 相同 = `ok`（输出备份之后前进的行数）；不同 = `rewrite/tip-row-differs`（链被改写并重算；备份之后若做过隐私抹除需对照操作记录）；在用链尾落后于备份 = `rewrite/behind`（尾部截断或回滚到更早状态）。
- 备份链尾已被归档搬走：必须给 `--archive-dir`（含对应 `.digest.json` + `.jsonl`），脚本校验 JSONL 的 SHA-256、逐行哈希与链衔接（并与摘要的行数 / 端点 / 段尾一致），并沿 `boundary_id` 接到在用库的 `archive` 锚点；缺摘要 = `unverifiable`（退出 1，不当作通过）。
- 锚点：输出备份之后**新增**的锚点。AF5 起，其中落在备份链尾范围内（`at_row_id` ≤ 备份链尾 id）的锚点与 `--offbox` 一样要做**操作意图对账**（§8b）：没有匹配意图、或意图没有被备份之后的审计行印证 ⇒ `rewrite`（`anchor-without-intent` / `intent-uncorroborated` / …，`intent_problems` 逐条列出），退出 1；备份链尾之后追加区间里的新锚点是正常增长，只列出。`--intent-pubkey <公钥PEM>` 验意图签名，`--require-signed-intents`（此模式下必须同时给 `--intent-pubkey`）要求每条意图都带可验证签名；没给公钥（`--offbox` 模式下 `--pubkey` 兼作意图公钥，所以只会出现在 `--against-backup`）且确实有锚点被对账时，输出会注明“意图签名未验证”。`--strict-anchors` 仍让新增 / 消失的锚点（含追加区间里的）也算失败。备份里登记过、现在仍在 id 范围内却消失的锚点 = `rewrite/anchors-removed`。
- 退出码：0 通过；1 任一非 `ok`（含清单缺失、`unverifiable`）；2 用法错误。
- 局限：同时改库、清单、备份与离机副本的攻击者不在防护范围；清单明文含链尾哈希和锚点，不含审计内容。

## 7. 限制

- 能写库的人可以整链重算（含伪造锚点）；链只有配合“带外保存的 tip / 摘要”才抵抗这一点。
- 哈希不覆盖 `user_name`、`module`、`ip`。
- 详见 ADR-0049「限制」。

## 8. 每日锚点（离机签名副本，ADR-0055）

§6 的清单要靠人带外保存；每日锚点把**证据透明日志尾**和**各行业库审计链尾**一起签名写到另一处，由持钥者执行。

前提：已用 `scripts/release-keygen.mjs` 在仓库外生成 Ed25519 密钥（私钥 0600、只在持钥机器；**公钥另行带外保存**，验证时才用）。

密钥分两把，**分开保管**（不要共用一把）：

```sh
# 一次性，在持钥机器上、仓库之外的新目录（同样的拒绝：相对路径 / 仓库或任何 git 工作树内 / 非空目录）
node scripts/release-keygen.mjs --out /abs/keys                                   # 发行 / 离机锚点签名：release-sign.key.pem + release-sign.pub.pem
node scripts/release-keygen.mjs --out /abs/intent-keys --purpose anchor-intent   # 锚点操作意图签名：anchor-intent.key.pem + anchor-intent.pub.pem
```

每日（建议备份之后）完整命令集：

```sh
# 1) 操作机上执行保留清理 / 归档 / 隐私抹除时带意图签名私钥（缺省回落 GML_RELEASE_SIGN_KEY，生产应单独一把）
export GML_ANCHOR_INTENT_KEY=/abs/intent-keys/anchor-intent.key.pem
# 2) 离机锚点。目的地 A：另一块盘 / 已挂载的远端共享（必须是已存在的绝对目录，脚本不会创建，也不许在数据目录之内）
node scripts/offbox-anchor.mjs --data-dir /abs/data --dest /Volumes/OFFBOX/os-erp-anchors --key /abs/keys/release-sign.key.pem
#    目的地 B：经 ssh/scp 的远端。别名必须是 ~/.ssh/config 里已有的；脚本不改 SSH 配置或认证，只用 BatchMode（不会弹密码）
node scripts/offbox-anchor.mjs --data-dir /abs/data --dest ssh://backup-box/srv/os-erp-anchors --key /abs/keys/release-sign.key.pem
# 3) 复核（复核方持两把公钥，带外获得）：对最新锚点 / 最新备份清单各验一次，**推荐总是带 --require-signed-intents，并在做过归档时带 --archive-dir**（离机保存的归档摘要目录；见 §8b）
node scripts/audit-verify-chain.mjs --data-dir /abs/data --offbox /path/anchor-20261024T020000000Z.json --pubkey /abs/keys/release-sign.pub.pem --intent-pubkey /abs/intent-keys/anchor-intent.pub.pem --require-signed-intents --archive-dir /abs/archive-dir
node scripts/audit-verify-chain.mjs --data-dir /abs/data --against-backup /path/gml_cosmetic_20261024-020000.db.enc --intent-pubkey /abs/intent-keys/anchor-intent.pub.pem --require-signed-intents --archive-dir /abs/archive-dir   # 加密备份需 GML_BACKUP_KEY
```

- `--require-signed-intents` 是推荐的日常口径：不带它时未签名的意图也算通过，只能挡住“只改了锚点表”的伪造（§8b 密钥保管）。意图是否带签名取决于执行清理 / 归档 / 抹除的那台机器有没有配置 `GML_ANCHOR_INTENT_KEY`——没配的机器写出的意图会在 `--require-signed-intents` 下失败（`intent-unsigned`），这是有意的。
- 产物 `anchor-<UTC时间戳>.json`，一次写入、永不覆盖，写完读回比对。可加 `--log <EVIDENCE-LOG.jsonl>`；缺省用仓库 `docs/release/EVIDENCE-LOG.jsonl`（不存在则只锚审计链）。
- SSH 目的地需要 GNU `ln -T` 和支持同目录硬链接的文件系统，用于原子独占发布；不支持或同名文件已存在时失败并清理本次临时上传，不覆盖旧锚点。
- 链已断或日志无效时**不出锚点**（退出 1）：先用 `audit-verify-chain` 找断点。目的地写满 / 别名失效 / 远端目录不存在同样退出 1；可捕获的本地写入失败会尝试清理本次不完整文件，清理失败以非零退出码报告可能残留的路径，远端临时文件尽力清理。SSH 在发布后断线时可能已留下完整锚点，请核验目标文件；不支持硬链接的本地回退在写入期间终名可见，在进程异常终止（如 SIGTERM/SIGKILL）时仍可能留下不完整终名，使用前须验签。请当日处理错误，不要跳过。
- 远端路径只允许 `[A-Za-z0-9._-]` 组成的绝对路径，别名不接受 `user@host`、端口或选项。需要这些就在 `~/.ssh/config` 里为该主机起一个别名。

复核（定期，或怀疑被动过时）：把最近几个锚点取回，用**带外获得的公钥**：

```sh
node scripts/audit-verify-chain.mjs --data-dir /abs/data --offbox /path/anchor-20261024T020000000Z.json --pubkey /abs/keys/release-sign.pub.pem --intent-pubkey /abs/intent-keys/anchor-intent.pub.pem --require-signed-intents --archive-dir /abs/archive-dir
node scripts/verify-release.mjs --log=/abs/repo/docs/release/EVIDENCE-LOG.jsonl --offbox /path/anchor-20261024T020000000Z.json --pubkey /abs/keys/release-sign.pub.pem   # 在发行包里执行
```

- 审计链：在用链必须是锚定链尾的后代。`rewrite/tip-row-differs` = 整链被改写并重算（隐私抹除后需对照操作记录）；`rewrite/behind` = 尾部被截或库被回滚；`unverifiable` = 锚定链尾已被保留清理删除或归档（给 `--archive-dir`）。被锚定的行业库不见了也算失败。锚点之后在已锚定范围内新增的库内锚点（保留清理 / 归档 / 隐私抹除都会产生）必须各有一条匹配的**操作意图**（§8b）；没有、或意图没有被审计行印证，一律 `rewrite`（`anchor-without-intent` / `intent-hash-mismatch` / `intent-uncorroborated` / `intent-signature-invalid`），没有“人工对照后一键放行”。
- 透明日志：必须仍包含锚定的尾（截尾、整份换成另一条有效链、日志被删都失败）；之后新增的行是正常增长。
- 不通过时**保留所有锚点与当前库 / 日志的副本**再排查；不要用新锚点覆盖旧证据。验证用旧锚点（几天前的）也应通过——它们是更难被同时篡改的参照。
- 局限：锚点之间的窗口无保护；离机目的地被攻破可删最新锚点；时间是持钥机自述。

### 8b. 锚点操作意图（AE5，ADR-0055 补充，迁移 072）

保留清理（`retention.mjs --execute`）、归档（`audit-archive.mjs --confirm`）和隐私抹除（`privacy-erase.mjs --confirm`）每次**新增**审计锚点时，在同一个事务里写一行 `audit_anchor_intents`（操作类型、范围描述、操作者、本次新增的全部锚点、意图哈希、可选签名），并把意图 id 与哈希写进该操作自己的审计行（`RETENTION_PURGE` / `AUDIT_ARCHIVE` / `PRIVACY_ERASE` 的明细里的 `anchor_intent`），再把审计行 id 回填到意图。三者同提交同回滚：审计写不进，意图与锚点一起撤销。

- `audit-verify-chain --offbox` 对“锚点之后在已锚定范围内新增”的每个锚点要求：有匹配意图 → 意图哈希按字段重算一致 → （有签名且有对应公钥时）验签通过 → 意图指向的审计行存在、晚于离机锚点的链尾、action 与操作类型对应、明细引用的意图 id 与哈希一致。任何一环缺失 = `rewrite`。**正常的清理 / 抹除不需要任何开关**即可通过；归档之后见下一条（需要 `--archive-dir`）。
- **`--accept-new-anchors` 已无效（AF5 删除）**：AE5 时它只放行“意图齐全、但印证它的审计行已被后来的归档搬出库”（`corroboration-archived`）的**库内**锚点。AF5 证明这条路径对库内锚点不可达：印证行的 id 必晚于离机锚点 / 备份的链尾，要被归档搬出库，那次归档的段尾就 ≥ 它；归档在同一事务里删除 `at_row_id` ≤ 段尾的全部旧锚点，被印证的库内锚点（`at_row_id` ≤ 链尾）因此一起消失。能让它们同时出现的只有伪造，所以代码路径连同这个开关的作用一起删除：旧脚本里写着 `--accept-new-anchors` 不会报错，但只会打印提示、不改变结果。
- **被归档搬出库的锚点（AF5）**：归档把段内的锚点导出到摘要（`.digest.json` 的 `anchors`）再从库里删除；伪造的桥锚点若先于一次合法归档被登记，就会从库里消失，只留在摘要里。所以：基线时存活的行如果后来被归档搬出过库（在用库第一行是 `archive` 边界且 id 大于基线 first_id），复核**必须**带 `--archive-dir`（离机保存的归档摘要目录），且目录里要有一条**验证通过、一路连到在用库**的摘要链（每段 JSONL 逐行重算哈希，沿 `boundary_id` / `first_prev_hash` 接到在用库的 archive 锚点，直到覆盖基线 first_id）；缺目录、缺段、JSONL 被改都是 `unverifiable/archive-evidence-missing`（退出 1，失败闭合）。有了这条链，摘要里 `first_id ≤ at_row_id ≤ last_id`、不在基线锚点清单里的锚点同样要求意图，印证行也已被归档时从这条链的 JSONL 里取。目录里被放进来的、不连在用库的摘要既不提供锚点清单也不提供印证行。早于基线的归档只涉及 `< first_id` 的行，不算新增。归档之后的补救也可以是：立刻重做离机锚点 / 备份作为新基线（新基线的 first_id 已越过被归档的行，就不再需要旧归档）。基线没有锚点清单（`baseline-anchor-list-missing`）同样失败闭合。
- 签名（可选，但推荐）：设置 `GML_ANCHOR_INTENT_KEY`（缺省回落 `GML_RELEASE_SIGN_KEY`，生产应单独一把）指向 Ed25519 私钥（与证据签名同一套检查：仓库外、0600）时，三个脚本给意图签名；配置了却读不出来则脚本在动手前退出，不会写出无签名的意图。复核时 `--require-signed-intents` 要求每个意图都带可验证签名，公钥取 `--intent-pubkey`（`--offbox` 模式缺省同 `--pubkey`；`--against-backup` 模式必须显式给）。
- **意图密钥保管（AF5）**：
  - 生成：`node scripts/release-keygen.mjs --out <仓库外的新目录> --purpose anchor-intent` → `anchor-intent.key.pem`（0600，O_EXCL）+ `anchor-intent.pub.pem`。拒绝规则与发行密钥完全相同：相对路径、仓库或任何 git 工作树内（含经符号链接）、已存在且非空的目录、未知 / 重复 / 缺值的 `--purpose` 都会失败且不留文件；私钥内容永不打印。
  - 放哪：私钥只放在**执行清理 / 归档 / 抹除的操作机**上（`GML_ANCHOR_INTENT_KEY` 指向它），**不要放在业务主机上**——能写业务主机的攻击者拿到私钥就能给伪造的意图签名，签名就只剩装饰；不要提交进仓库、不要放共享存储、不要与发行私钥共用同一把。公钥带外交给复核方，与离机锚点公钥分开记录。
  - 轮换 / 丢失：轮换流程、公钥集合与按 `key_id` 选钥见 §8c（AG5）；旧意图用旧公钥验，所以**旧公钥要保留**在集合里。私钥丢失 ⇒ 生成新密钥并做一份新的离机锚点 / 备份作为新基线。
  - 诚实边界：意图签名只证明“持有意图私钥的机器签过这条意图”，不证明操作本身合理；私钥与业务主机同时被攻破不在防护范围。
- 升级前（迁移 072 之前）产生、且发生在某份离机锚点之后的锚点没有意图：这份旧锚点会判 `anchor-without-intent`。处理：核对操作记录后，做一份新的离机锚点，以后用新锚点复核。
- 范围：`--offbox` 与 `--against-backup`（AF5）共用同一套对账：基线（离机锚点 / 备份清单）链尾范围内新增的锚点（含已被归档搬出库的，见上）要对账，链尾之后追加区间里的新锚点是正常增长。`verifyChain` 自身对锚点的承认规则不变。

### 8c. 意图 / 锚点签名密钥轮换（AG5，ADR-0055 补充 3）

**key_id 是什么。** 签名者公钥 SPKI DER 的 SHA-256（64 位十六进制）。`audit_anchor_intents.key_id` 在意图被签名时一并写入；离机锚点的签名元数据 `signature.key_id` 同理（`offbox-anchor` 还会打印它的前 16 位）。`release-keygen` 轮换出的文件名带前 16 位：`anchor-intent-<前 16 位>.key.pem` / `.pub.pem`，方便对照。

**轮换步骤（意图密钥；发行 / 锚点密钥同理，换 `--purpose`）。**
1. 在保管目录（第一次 `release-keygen --out <仓库外的新目录> --purpose anchor-intent` 建的那个，0700）里：`node scripts/release-keygen.mjs --out <该目录> --purpose anchor-intent --rotate`。要求目录已存在、里面已有本用途的公钥、不是对组 / 其他可写、不在仓库或任何 git 工作树内；新建一对带指纹的文件，**旧私钥与旧公钥原样保留，私钥永不覆盖**；输出列出保留的公钥 key_id。
2. 操作机把 `GML_ANCHOR_INTENT_KEY` 改指新私钥（`anchor-intent-<指纹>.key.pem`）。此后新写的意图记录新的 `key_id`。确认旧私钥不再被任何脚本使用后，由操作者决定销毁或离线封存；不要把旧私钥留在业务主机上。
3. 把新公钥带外交给复核方，**加进**他们的公钥集合（不要替换旧的）。复核命令把集合整体交给 `--intent-pubkey`：可以重复给（`--intent-pubkey a.pub.pem --intent-pubkey b.pub.pem`），也可以直接给保管目录的拷贝（只读取其中的 `*.pub.pem`，不递归，私钥与其他文件被忽略；目录里没有公钥、或某个 `*.pub.pem` 其实是私钥 / 不是 Ed25519 都是用法错误，退出 2）。离机锚点公钥 `--pubkey` 同样可重复 / 给目录，按锚点的 `signature.key_id` 选钥，集合里没有签名者 ⇒ `OFFBOX-INVALID`。
4. 轮换之后做一份新的离机锚点（`offbox-anchor --key <新私钥>`）并用新集合复核一遍，确认退出码 0。

**复核时怎么选钥。** 意图按自己记录的 `key_id` 在集合里找**那一把**来验，不会把集合里的钥逐把试：
- `key_id` 在集合里 ⇒ 用它验；验不过 ⇒ `intent-signature-invalid`（包括 `key_id` 被改成另一把受信公钥的情形）。
- 明确给了 `--intent-pubkey` 而 `key_id` 不在集合里 ⇒ `intent-key-unknown`，`rewrite`，退出 1（无论是否带 `--require-signed-intents`）：要么公钥没带全，要么这把钥已被你从集合里撤掉。**撤销**一把泄露的旧钥 = 把它的公钥从集合里拿掉；它签过的意图随即全部判 `intent-key-unknown`，需要对照操作记录后重做基线。
- 没给 `--intent-pubkey`、`--offbox` 模式回落用 `--pubkey` 当意图公钥时，`key_id` 对不上不算 `intent-key-unknown`（那把公钥本来是锚点签名钥，不是意图钥），沿用 AE5：默认跳过，`--require-signed-intents` 下 `intent-signature-unverifiable`。所以带意图签名时**总是显式给 `--intent-pubkey` 并带 `--require-signed-intents`**：回落口径下写库者清空或改掉 `key_id` 能让一条签名无效的意图在不带 `--require-signed-intents` 时通过（效果等同于直接写一条无签名意图）。公钥目录里的符号链接会被拒绝；保管目录必须放在 0700 的自有路径下，`--rotate` 也拒绝本身是符号链接的路径。

**过渡规则（旧意图没有 key_id）。** 本变更之前写的签名意图没有可靠的 `key_id` 概念（AE5 已写 `key_id`，但更早或被手工清空的行可能为空；`key_id` 不在被签内容里，库的写入者能把它清掉）。规则：带签名、`key_id` 为空的意图，对集合里的**每一把**试，任何一把验过就通过；都不过 ⇒ `intent-signature-invalid`。风险：被撤销前的泄露旧钥仍在集合里时，攻击者可以清空 `key_id` 让它走这条路径——所以撤销泄露的钥必须把公钥拿出集合，而不是只靠 `key_id`。

**结束条件。** 当同时满足：(a) 库里所有带签名的意图都有 `key_id`（`SELECT COUNT(*) FROM audit_anchor_intents WHERE signature IS NOT NULL AND (key_id IS NULL OR key_id='')` 为 0，或这些行都已经落在最新离机锚点 / 备份的基线之前、不再需要对账），且 (b) 复核方已用 `--require-intent-key-id` 完整跑通一轮每日复核——之后把 `--require-intent-key-id` 写进日常命令。从此没有 `key_id` 的签名意图一律 `intent-key-id-missing`（`rewrite`），过渡规则不再适用。

**限制。** 签名不覆盖 `key_id`（沿用 AE5 的签名输入 `格式标识:intent_hash`，改签名输入会让所有已有意图失效）；它只是选钥提示，不是信任来源。信任来源只有复核方带外保管的公钥集合。
