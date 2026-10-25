# 第十七批：Claude Haiku 5.5 挑战审计与验证设计

日期：2026-10-24（America/Los_Angeles）。审查起点：AH2–AH12 集成 `026b276` 加 AH1 合并结果；集成提交 `04d22ac`，文档/API 同步 `f78f3aa`。PR #13 为草稿；托管 Linux CI 是开发合并门禁，不是生产或发行包验收。

## 方法与证据边界

通过 Claude CLI 2.1.291 执行两轮独立只读挑战：CI/测试拆分，以及核心 FTS、权限、配额、备份与供应链差异；第三轮复审下述修复。显式 `--model claude-haiku-5-5 --disable-slash-commands --tools '' --strict-mcp-config`，提示从文件 stdin 传入；复审另用 `--safe-mode` 排除本地自定义上下文。三轮 JSON 均 `is_error=false`，`modelUsage` 的 canonicalModel 为 `claude-haiku-5-5`。CLI 的 `unrecognized_model` 警告没有导致请求失败。模型未执行任何测试，审计意见须由主执行器复现/核对，不能当作测试通过。

原始回答和提示保留于本次任务临时目录 `/tmp/osstack/erp-haiku-audit/`，不提交可能含环境信息的完整 CLI JSON/日志。以下保留实质发现及逐项处置。

## 确认并修复

| 来源 | 问题与复现 | 修复 / 验证 |
|---|---|---|
| CI C3 | timing 子进程没有 GML_DATA_DIR，隔离保证依赖每个测试自行设置；新夹具对该变量断言失败 | 每文件新建 HOME/TMPDIR/GML_DATA_DIR，结束清理；夹具写出路径并验证已删除 |
| CI C2 | timing 失败只打印文件名，不暴露失败用例；新增诊断断言失败 | 最多 10 个脱敏失败用例名称、进程错误码/信号；不打印原始断言数据；测试验证不泄漏长 token 或异常载荷 |
| CI C5 | GML_AUDIT_FTS=0 从必需 checks 移入非必需 slow-tests；完整回归只覆盖正常模式 | 保留既有 required regression 名称，依赖 checks+slow-tests，always() 后先检查两者 success；失败/取消/跳过不能静默通过，无需改仓库设置 |
| Core 1 | 重建第一批后更新尚未索引的行，剩余计数归零但索引损坏，原脚本仍退出 0 | 最后一批同一写事务内用 FTS5 integrity-check rank=1 对照内容表，成功才删除检查点；失败回滚并保留检查点 |
| Core 4 | 批间删插入触发器、写入高水位后新行、恢复触发器，原脚本仍退出 0 | 同一最终完整性检查发现漏行，查询保持 LIKE；新增确定性夹具 |
| Core 3 | 查询前后检查点均不存在，但重建可在查询期间开始并结束，原实现返回空结果 | 检查点判断与物化查询放在同一延迟读事务快照；双连接 WAL 测试复现旧实现漏行并证明修复 |
| Core 2 | 检查点表存在但行被外部删除时，原 gone 分支可报告 ok | 缺行明确失败；新增批间删除检查点行测试。直接 DROP 表原本就会报错，未夸大此路径 |

前五个行为复现（隔离、诊断、两种索引损坏、查询快照窗口）均在修复前失败。修复没有修改已发布迁移；没有关闭数据完整性断言。最后一批增加完整索引核验，旧的批耗时数字不再代表其持锁上限，已在运维说明中标明需重新测量。

第三轮原话结论：**“No confirmed blocker in the supplied diff.”** 其附带核查项已查源码：slow-tests/checks 无条件跳过规则；SQL 是 FTS5 `INSERT ... rank=1` 而非 PRAGMA；服务数据库使用 WAL；所有 plan.run 回调同步调用 `.all()`/`.get()`，未返回惰性迭代器；finished 仍由 r.done 置真。此结论仅限所给差异，不是完整产品认证。

## 排除、保留或降级的意见

- CI C1/C7/H3：初审引用的未解决冲突状态已过期；依赖策略里的 job 已在模块级定义；file-header 守卫允许 slow 理由行。当前 Git 索引无冲突，109 项初始策略检查通过。
- CI H1：tests-tree 递归哈希所有普通文件，移动后仍被覆盖。实际移动为 14 个文件，交接所述 15 个不准确；无旧/新同名双份。
- CI C4/C6/C8/C10：负载倍率默认 1 是保守选择；timings JSON 是历史基线，不能证明新增文件速度。正常 FTS、GML_AUDIT_FTS=0、真正无 FTS5 构建是不同验证维度。耗时治理、缺少新文件实时测量、符号链接脚本入口兼容仍属后续改进，不改成放宽断言或伪造耗时。
- Core 5/7/13：http.js 的统一错误序列化补 detail.code；atomic() 已用 immediate()；verify-release 的 listed 在模块级定义，所述变量/响应问题不成立。
- Core 6/8/10/11/16：confirm_primary 可选、无角色视为 inactive、分页默认 100、非 Unix 链接属性被写为普通文件、自定义 key_id 生效日期，均需按既有契约解释。没有把管理员可配置生效日期当成未授权绕过；没有声称 ZIP 会创建该链接。
- Core 9/12/15：午夜末页可能要求刷新、artifact 校验的默认归档大小上限与可调提取上限不一致、partial 最小年龄设为 0 会干扰并行备份，保留为后续边界改进。
- Core 14：加密备份强杀可遗留 0600 明文临时文件，是 restore-runbook 已明确的限制（更强保证要求加密卷），不是本批新增且未披露的保证。不能声称覆盖即物理擦除或所有崩溃都不留明文。
- Core 17–19：计数成本、审批逐行范围判断保留性能评估；scopeless 对象的消费者已同步更新并通过守卫。

## 验证矩阵

| 层 | 执行与失败判据 | 状态边界 |
|---|---|---|
| 合并结构 | 无冲突索引、无重复移动测试、文件头/契约/路由/生成物检查 | 本机 Node 开发检查 |
| 确定性负向测试 | FTS 更新/触发器间隙/检查点缺行/查询快照；timing 隔离/脱敏诊断；CI 依赖结果校验 | 必须先复现，再修复后通过 |
| 完整源码 | tests 根目录与全部 14 个 slow 文件；正常和强制禁用 FTS；TypeScript/Vite | 本机长套件不是目标平台验收；任何失败需单列 |
| Linux 开发门禁 | PR #12 对第十六批、PR #13 对第十七批，各跑 fresh isolated cosmetic/food regression；slow/no-FTS、真实无 FTS5、浏览器、Docker、fs-fault、签名门禁 | 以对应 SHA 的 Actions 完整结果为准，失败项自动修复；不使用交接中的中止副本 |
| 候选/试点 | 规定的三轮回归、精确发行包验证、权属与业务验收、目标主机性能 | 本次不得宣称完成；不部署、不发布、不合并 PR |

当前分支保护实测必需项为 Typecheck/build/focused、Isolated regression、Docker；不是交接摘要写的 browser。未修改保护规则或现有 PR 的 auto-merge 设置。所有新增结果继续登记到本文件及 PR #13。

## 修复验证记录

修复提交：`b965ac8`（FTS 完整性/快照）与 `0a702c7`（timing 隔离/诊断和 CI 闸门）。

- 修复前复现：4 个隔离/诊断/完整性用例失败，另 1 个查询快照用例失败。修复后均通过。
- audit-fts-maintain + test-timings + test-tree-policy：44 项，43 通过、1 跳过（本机 SQLite 含 FTS5，无 FTS5 构建路径交给 CI）。
- `GML_AUDIT_FTS=0` audit-logs-view：35 项，30 通过、5 按 FTS 模式跳过，0 失败。
- 路径守卫曾识别新测试的仓库 data 路径拼接（仅负向断言）；已改成更强的“位于整个检出之外”断言，未增加豁免，5/5 通过。
- 文件头 4/4、业务码 31/31、TypeScript 通过；API 1.45.0 契约与生成物一致。
- 全量焦点和其余慢套件从集成版本开始运行，期间进行了定向修复，故只作为开发反馈，不当作冻结最终 SHA 的完整验收；最终完整结果以托管 PR HEAD 为准。
- 全量焦点运行发现 release-candidate-policy 仍只允许手动触发型 job 条件，拒绝新 regression 的 always()；该次运行有 1 项失败，不能记为全绿。现已仅允许 regression 使用 always()，保留其他 job 的条件跳过限制；全部策略及 timing 用例重跑 **112/112 通过、0 跳过**。
- 本机完整焦点运行结束：1105 项，1103 通过、1 失败（上述 always() 策略，已定向修复）、1 构建能力跳过。其余 12 个慢文件：280 项，279 通过、1 失败；失败是 release-candidate 夹具只统计顶层测试，漏掉 7 个 slow 桩，实际报告 53 项而断言预期 46。改为递归统计夹具后该用例重跑 1/1 通过，仍校验完整 tests-tree 哈希，没有降低断言。
- 修改查询快照后的正常 FTS audit-logs-view 重跑：35 项，34 通过、1 构建能力跳过、0 失败。所有本机长运行均已结束；不能把包含失败的原运行改记为通过。最终完整验收仍等待托管 Linux 当前 HEAD。

## Current-head CI follow-up (2026-10-25 UTC)

Run [40166240054](https://github.com/osborn-studio/OS-ERP/actions/runs/40166240054), head `798d62e18cbc50c6f69fbb01ae5b60918b73cee9`: focused checks, Docker, true no-FTS5 build, backup fault injection and dependency review passed. Slow tests failed in the old AF4 drop-during-query expectation. Browser passed 22/23 scenarios; `role-deactivate-preview` timed out finding the created user on the first page. Regression was blocked by the slow-test prerequisite and **did not run**; capacity smoke was skipped (manual only).

- The FTS fixture now uses WAL, matching the service. It asserts that the in-flight read retains its snapshot, then a subsequent read returns identical rows via exactly one LIKE fallback. The other failure/retry assertions remain. Full `tests/slow/audit-fts-races.test.mjs`: 12/12 pass on Mac Node 22 (development checks only).
- Browser fixture now searches its generated username and locates the exact username cell before checking the inactive-role tag. `/auth/users` orders by ascending ID and paginates, so preceding scenarios can place this account beyond page one. Linux browser rerun remains required.
- Claude CLI `claude-haiku-5-5` follow-up: first invocation emitted unusable textual tool calls with tools disabled; it is not counted as an audit verdict. Second tool-less review returned **No confirmed blocker** in supplied text; its conditional substring-selection concern was addressed with exact-cell matching. No server search semantics were changed. Local policy/tree tests: 106/106; all static guards, contract, generated documentation checks, audit allowlist and query-source scan pass.
- PR #6 run [40163480627](https://github.com/osborn-studio/OS-ERP/actions/runs/40163480627), head `c7b57a163558ad410e0dfa4cbc7207e3f86f7ab5`: regression 114/115 runner items passed, `node:test` failed. Its old log filter suppressed the case name/location; root cause is **not yet established**. Narrow TAP diagnostic fields were added at batch ten and merged forward; batch-ten policies 41/41 pass. The next hosted run must identify the failure before claiming a fix. Remaining in-flight PR runs are retained until completion before pushing their diagnostic-only merge commits.

## Fixture cleanup follow-up (2026-10-25 07:20 UTC)

- PR #10 head `59f50b20bfcee7b0f2c4bafbb9ceb844e445eec7`, run [40169975817](https://github.com/osborn-studio/OS-ERP/actions/runs/40169975817): focused tests 1137 total, 1134 passed, 1 failed, 2 skipped. Failure was an after-hook `ENOTEMPTY` removing `os-erp-rc-src-*/.git/objects` in the dirty-tree refusal fixture, not a failed business assertion.
- Mitigation `fb25f6a` originates in batch nine (lowest affected monitored branch): set repository-local `gc.auto=0` and `maintenance.auto=false` immediately after initializing the disposable source fixture. Both configuration commands must succeed. No real checkout/global Git settings or assertions changed, and cleanup failures remain visible. Merged forward through batch seventeen, following the file relocation to `tests/slow/`.
- Detached Git maintenance is a suspected concurrent writer, **not a proven root cause**. Claude CLI Haiku 5.5 read-only review found the mitigation appropriate but explicitly retained this evidence limit. Its macOS-specific speculation does not apply to the actual Linux CI failure. The failing directory is the configured `minimalSource` fixture; the candidate script does not initialize or clone another Git repository. If Linux repeats the cleanup failure, investigate remaining writers rather than declaring it solved.
- Mac Node development validation: batch-nine entire candidate suite 6/6; batch-seventeen dirty-tree refusal 1/1; policy/tree 106/106; static guards, audit allowlist, generated-document checks and query-source scan passed. Hosted reruns on new HEADs are still required.
- PR #6 head `1fde7d8973d57c4f60205a5a38a13879ce5b6dca`, run [40168451466](https://github.com/osborn-studio/OS-ERP/actions/runs/40168451466), passed all four checks including regression. Its earlier unnamed assertion failure was not reproduced and cannot be attributed to this cleanup race.
- PR #12 head `9c5896ceafc5e1ab7adeafa9da8882d67c64c803`, run [40163480374](https://github.com/osborn-studio/OS-ERP/actions/runs/40163480374), passed all five applicable checks including isolated regression (capacity/dependency review skipped); result recorded in PR comment before forwarding changes.
- PR #13 head `678d513911f641a88968d09b7ceed5ae6caddda8` passed seven checks including Linux slow tests and browser scenarios. Its isolated regression was still pending before this new shared fixture mitigation; previous successes do not validate the subsequent HEAD.

## Isolated regression integration failures (2026-10-25 08:11 UTC)

Superseded head `678d513911f641a88968d09b7ceed5ae6caddda8`, run [40168500810](https://github.com/osborn-studio/OS-ERP/actions/runs/40168500810): overall workflow marked cancelled, but the regression job exited 1 with a failed manifest, 113/116 runner items passing. Seven other jobs passed; manual capacity skipped. The failed items were node:test (two ZIP assertions), the accidental no-argument timing CLI invocation, and helper-shape inventory coverage.

- Reproduced ZIP assertions under `umask 077`: actual0600 versus expected0644. The extractor correctly preserves a restrictive umask; only the expected permission and misleading comment change. Tests now compare `mode & 07777` against `0644 & ~umask`, also covering forbidden special permission bits. Extractor code and path/symlink/special-file rejection remain unchanged. ZIP suite under077: 19/19 pass; ZIP+timing+tree checks under normal umask:35/35 pass.
- Exclude the measurement CLI `scripts/test-timings.mjs` only from legacy no-argument business-test discovery. Its node:test tests and dedicated slow CI execution remain. Register its absent legacy helpers as null/null so the shape scan still examines it: guard78/78 pass after reproducing the missing-entry failure.
- Policy/tree106/106 and all static/generated checks pass. No local Python or full Linux acceptance is claimed. New current-head hosted regression is required before ready-for-review.
- Claude CLI `claude-haiku-5-5` supplied-diff review (`is_error=false`) assessed this as correct/minimal with no security regression. Verified its conditions: `test-timings.test.mjs` exists and passed, CI slow job calls `--run`, null helper entries pass the live scan, and extraction uses `wx` plus mode0644 with no chmod. Retained ambient umask assertions and explicitly ran077 rather than pinning022, which would miss the regression environment that exposed this failure.

## 2026-10-25 用户要求的最终遗漏/回归审查（原 HEAD a628d38）

本次以 GitHub 实际 base main `3ac0b8c87c65cd395d86fa0fd0501de2e7e22f82` 为基线，累计运行时代码差异分六个文件边界块交给 Claude CLI **claude-haiku-5-5**；随后两轮修复复审。全部禁用工具、只读给定文本，JSON `is_error=false`、modelUsage 确认为指定模型。模型的猜测逐条对照完整源码和测试，不直接当成漏洞。审查工作与原始响应由 osstack 工作区 `/tmp/osstack/erp-final-review` 管理；初次120秒执行超时被记录为失败，恢复收齐六份响应后验证成功，不把采集成功当作代码通过。

确认并修复：

1. **MCP trace 库存流水遗漏仓库范围交集。** 原处理仅过滤货主，同一货主的其他组织仓库流水可泄露。最低受监控批九修复并向后传递；复用 `warehouseInScope`，保留后续批次已有单据权限、绑定、同号歧义保护。新增实际 handler 复现覆盖异组织货主/仓库、NULL/缺失仓库、无单据流水、空范围和全范围。修前失败，修后通过。
2. **release verifier 空格参数被静默忽略。** `--evidence path` / `--artifact path` 现与等号形式一致，缺值/空值/重复值拒绝；仅指定 artifact 未指定 evidence 也拒绝，不能退化为 manifest-only 检查。批九修复并传递。负向复现和正向真实候选包绑定均验证。
3. **备份报告 sweep 删除其他存活写者临时文件。** 批十六开始修复：新临时名记录 PID，仅清扫已退出的本机 PID 普通文件；存活、EPERM、PID复用和旧格式无法确认归属时保留人工检查。第十七批保留 AH6 清理计数；故障注入验证退出后的清扫与存活时的保留。此方案针对本机备份目录，不声称跨主机锁或并发备份全流程互斥。
4. **AH2 遗漏负向覆盖已补。** 既有管理员令牌在 approval_manager_global 关闭后立即收窄，指标与 overview 一致，普通全局管理员不变，重新开启恢复；finally 恢复开关。这是既有行为的测试补充，未改权限政策。

复审取舍：unsigned anchor intent 的信任边界及 strict 模式已明确记录；metrics 自定义鉴权有运行时覆盖；SBOM 读取已有32MiB限制；safe-path 已做真实路径解析；admin 在 permContext 映射为 isSuper；MCP 严格绑定为既有契约；限速满容量拒绝为 fail-closed。其余 malformed-server-output、worker-level crash、扫描路径等假设没有复现为本次阻断，不以猜测改动安全策略。独立审查不是无遗漏保证。

本机 Node 22 开发验证：批九新回归5/5、candidate6/6；批十六报告定向6/6；批十七修复及完整 fs-fault80/80、完整 MCP 文档权限49/49、候选包与相关策略45/45、全部 policy/tree106/106、helper-shape78/78、AH2负向1/1、真实候选包空格参数绑定1/1。静态文件头、路由鉴权、数据路径、API契约、metrics范围及生成文档检查通过；全新隔离 seed 后 MCP覆盖29/29、库存字典25/25通过（未启用已知另有失败的 strict 档）。新增行号变化的 codemap 由生成器重生成。

如实记录本机修复过程：一次合并文本编辑残留分隔符导致测试语法失败，推送前修正并重跑80/80；首次守卫未配置/创建 seed 数据库导致拒绝运行，配置独立 `/tmp/osstack` 数据后重跑通过。没有运行本机 Python，没有使用客户数据。

PR #13 已恢复 draft。以上均非 Linux 验收；新 HEAD 必须重新通过托管 CI 的全部适用检查及隔离回归才可恢复 ready。原 a628d38 的全绿不代替新结果；不合并、不改变 auto-merge、不发布部署。
