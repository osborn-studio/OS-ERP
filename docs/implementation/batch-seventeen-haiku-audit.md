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
