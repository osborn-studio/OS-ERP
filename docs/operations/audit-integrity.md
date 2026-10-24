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

## 5. 限制

- 能写库的人可以整链重算（含伪造锚点）；链只有配合“带外保存的 tip / 摘要”才抵抗这一点。
- 哈希不覆盖 `user_name`、`module`、`ip`。
- 详见 ADR-0049「限制」。
