# PR #6：写基准争用测试修复记录

2026-10-25，基于 PR HEAD `03949ca3a63fd730c6c932bb02ec7d4cfbf72c55`。

## 原始证据

- [运行 40186014013](https://github.com/osborn-studio/OS-ERP/actions/runs/40186014013)：尝试 1 隔离回归 114/115 跑批项通过，失败项为 `node:test` 中写基准 schema/integrity 用例；日志过滤丢失实际断言值。
- [尝试 2 作业 121162030699](https://github.com/osborn-studio/OS-ERP/actions/runs/40186014013/job/121162030699)：`node:test` 已通过（2054.3 秒），随后整轮被取消，summary.result=unavailable。这不是整轮通过，也不是再次确认同一断言失败。
- 本机 Node 22 原测试独立 8 次通过；原始 CLI 参数重复至第 26 次复现：36 次请求，35 成功、1 次调拨 HTTP 500；write_retry=13、exhausted=1，调拨 rows=11、stock_delta=11，完整性 true。用原 `errors === 0` 断言检查该报告失败。不能据此声称统计故障率或已恢复历史 CI 丢失的数据。

## 最小修复与边界

- 持续周期抢锁与有限重试不构成全成功保证。严格成功场景停用外部写者，仍验证每种操作 12 次成功、无错误、无耗尽及完整数据不变量。
- 独立周期争用场景保留原始 5/8/25/10 参数，要求仅 HTTP 200/500，所有错误数与耗尽计数一致，实际写入与成功数逐项一致。`--max-error-rate 0` 下任何错误仍要求 CLI 退出 1。
- 外部写者首次获得锁才确认 ready，避免压测先结束、worker 尚未启动；启动失败明确拒绝并回收，stop 读取最终统计；BUSY 计数延后到日志排空后。
- 失败摘要只输出安全数值、布尔值、断言行号，包含在 regress-all 的 not-ok 摘要中。原始服务日志/凭据/数据库不进入提交或 CI artifact。
- 没有修改生产事务重试策略、次数上限、HTTP 状态码或数据库业务逻辑。

## 验证

- Node 22 写事务与基准测试 21/21；修改后的两种写基准场景连续 8 轮（16 个用例）通过。
- 从实际测试提取验证逻辑，原始耗尽报告在严格 CLI 失败状态下被接受；9 个负向控制拒绝原错误全成功假设、重复写、失败后留行、错误库存差、错误收款数、漏计耗尽、403、错误 CLI 退出状态及有错误的成功基线。
- 第十批已有的 bizcode、file-header、data-paths、route-authz、api-contract、codemap、changelog、third-party-notices、test-helper-shape、env-pinning 检查，以及 TypeScript、Vite 构建通过。
- 交接文档列出的 audit-allowlist、metrics-scope、lock-registry、role-matrix 和 explain-audit --analyze-scan 属于更后批次，在第十批不存在/不支持，初次通用命令相应报错；不得记作通过。向后集成时执行后批次适用检查。
- 以上均为本机开发验证。新的精确 HEAD 托管 Linux CI（包括隔离回归）才是开发合并门禁，尚未据此宣称通过。

## Claude CLI Haiku 5.5 审查

指定 `claude-haiku-5-5`，工具禁用，只审给定文本；检查 is_error=false 及 modelUsage.canonicalModel。设计挑战、代码审查及修订复审的原始结果保留在本机 `/tmp/osstack/pr6-precise/`。

采纳：拆分成功基线与周期争用；修正可能遮蔽原异常的诊断构造；确认 SQLite 耗尽映射 HTTP 500；增加 BUSY 计数关系与基线零 BUSY 断言；记录启动/停止时限。

未采纳：每轮周期样本强制正重试数或成功百分比。这会重新引入调度概率假设；确定性 BEGIN 锁占用单测明确验证两次重试、一次提交，回滚、用尽、多进程集成测试均保留。周期场景只按实际结果严格核对完整性，不声称每轮必定出现争用或生产容量保证。

最终复审：无确认阻断缺陷。已按建议优先断言完整性，避免完整性错误被 CLI 退出码诊断遮蔽；直接核查 `inventory.js` 的 `createTransfer(...autoShip)` 位于单个 `withWriteRetry` 内，`transfer.js` 的 `shipTransfer` 在该函数返回前执行，受外层事务保护。审查还提示既有多进程用例的 400ms/重试数及成功比例断言可能受调度影响；此次没有复现该项，也没有改动该独立测试，保留为明确的剩余风险，不将其冒充已修。

## 后续：多进程启动同步修复（2026-10-25）

在 `e9da5d3` 上复核此前保留的多进程定时风险：仅将各进程收到 go 后的启动延迟设为 `600 + worker * 1500` ms，原用例的数据与成功率断言都通过，但最后报 `expected at least one retry per worker, got 0`。这确认了固定持锁 400ms 不能证明每个进程经历 BUSY；它是新复现的独立测试缺陷，不能当作已恢复历史 CI 的未知断言。

测试现改为每个进程首次实际 BUSY 进入 `withWriteRetry` 的 sleep 钩子时同步回报，停在临时目录的释放屏障；父进程收到全部确认后 COMMIT，再写释放文件。剩余尝试次数不在等待其他进程时耗尽。保留原 90% 成功率、失败/耗尽计数、唯一性、精确落库、调拨状态、流水及库存断言；将总重试数 >= N 加强为每个进程重试数 >= 1。错峰延迟作为永久回归条件保留。启动/屏障有 30 秒截止；子进程提前退出直接拒绝，finally 杀停/等待所有子进程并关闭数据库，再由原用例清理隔离目录。没有更改生产代码、重试上限或 CI 门禁。

本机 Node 22：相关测试 21/21，通过；旧定时逻辑在相同错峰输入下失败，修复后通过。故障注入的 ready 前退出、BUSY 前退出及缺少 BUSY 超时三种情况均准确报错并结束；这些是预期失败控制，不计入正常测试通过数。第十批 10 项适用静态守卫、TypeScript 与 Vite 构建通过。完整托管 Linux CI 仍等待新提交，以上不是 Linux 验收。

指定 Claude CLI `claude-haiku-5-5` 工具禁用复审：is_error=false、canonicalModel 已核验，无确认阻断。审查确认屏障顺序与逐进程重试断言，并提出启动截止、错误诊断和协议注释等非阻断建议。保留 30 秒失败边界；屏障异常仍由测试严格拒绝，未放宽任何结果断言。原始复现、故障注入及审查证据：`/tmp/osstack/pr6-lock-barrier/`。定时自动跟进仍取消，不合并、不重新开启 auto-merge。
