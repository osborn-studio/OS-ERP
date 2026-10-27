# E02：重建检查点与受控审计删改协调

日期：2026-10-27。基线：main 98480e7cf93b01d56dafed6f2994cecdeb4a3d50。实现与本机 Node 验证完成；精确 PR HEAD 的 Linux CI 尚待通过，不作发布或生产验收。

## 改动与边界

分批 FTS 重建的检查点存在期间，清理或改写尚未入索引的审计行会让触发器向残缺索引发送无效操作。原有 LIKE 回退、interfered 和最终完整性检查保留，本次增加受控入口的写前拒绝：

- deleteAuditRowsAnchored 在调用者事务内检查；保留清理整行业事务回滚，包括通知和 MCP 日志。
- audit-archive 在 IMMEDIATE 事务内重新计划、导出或续做前检查；预先拿到归档口令也不能绕过。
- privacy-common.applyPlan 在任何 UPDATE 之前检查涉及 audit_logs 的计划，避免调用者捕获异常后留下部分抹除。隐私 CLI 沿用 ERASE_FAILED 包装并解释重建原因。
- 空检查点表也拒绝。状态查询失败不当作无检查点。DEFERRED 旧 WAL 快照即使未看到新检查点，也由写升级的 SQLITE_BUSY 拒绝；不得复用旧事务重试。
- 正常链式追加、LIKE 查询、不涉及审计行的隐私计划仍可用。直接 SQL 和裸 INSERT 孤儿行不属于本次受控入口保护；既有链/索引完整性防御继续生效。

恢复方式见 [audit-search](../operations/audit-search.md)：完成 resume、rebuild --restart，或带理由 disable；不要手工删真实检查点。rehashAuditRow 在 UPDATE 之后执行，生产调用者仅 applyPlan；守卫必须在写前，不能靠事后重算保护。

## 验证与失败记录

- 旧实现反例：retention/privacy 未拒绝，归档出现 SQLITE_CORRUPT_VTAB；没有据此声称真实客户数据丢失。
- 最终 Node22：audit-fts-maintain、retention、privacy-tools 三文件 66 项，65 通过、0 失败、1 项按无 FTS5 条件跳过；slow/audit-chain 91/91。合计 157 项，156 通过、1 跳过。
- 测试包含另一个进程创建真实分批检查点、拒绝时数据/检查点不变、归档无导出、正常追加、resume 后维护、审计链与 FTS 完整性、旧 WAL 快照和空检查点。
- tree policy 10/10、helper-shape 78/78、file-header 4/4、API 契约与 diff 检查通过；codemap 按生成器更新。
- 补测过程中修复的是测试夹具与断言：脱敏号码需 entity/entityId 确定关联；CLI 包装为 ERASE_FAILED；父进程无密钥时不能调用 planErase 作准备断言，改用 collect 纯读确认选中审计行。拒绝、无部分写入和恢复断言均保留。
- osstack 首次本机验证保留失败记录；修正后的 task_59526ffb success。聚合 exit 2 来自历史 escalated，不代表当前通过即可删除旧失败。曾误填不存在的 audit-trail 测试路径，最终记录只计实际执行的三文件及单独运行的 slow/audit-chain。

## Claude CLI 复审

三轮固定 claude-haiku-5-5，tools 为空、strict-mcp-config、safe-mode，仅审给定文本，均核验 is_error=false 与 canonicalModel=claude-haiku-5-5。第二轮指出新增 privacy 夹具未覆盖预期路径，已修；第三轮未发现确认阻断。

第三轮条件核查：归档确为 IMMEDIATE，catch 记录失败并关闭连接、不重用旧快照；rehash 的写前保护位置已说明；WAL 测试明确验证写升级失败。无 FTS5 及完整托管回归留给当前 HEAD 的 CI，不用本机替代。

原始本机日志与审查在 osstack scratch erp-closeout；本文件保存可随代码审阅的结论，未提交数据库或原始运行日志。
