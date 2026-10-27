# E03：慢测试等待预算收敛

日期：2026-10-27。基线：main 98480e7cf93b01d56dafed6f2994cecdeb4a3d50。实现与本机开发检查完成，精确 PR HEAD 的完整 Linux 慢套件与耗时 artifact 待验证。

## 实现

将剩余 12 个 slow 文件里的用例/子进程/HTTP 上限及就绪、归档暂停、profile 轮询迁入 load-tolerance.mjs。已有 15/180/280 秒常量复用；SLOW_WAIT 补齐原来的 5/10/30/90/120/290/300 秒和 2400/250/600/100 次轮询上限。默认倍率 1 逐项保持不变，不根据短期噪声增加默认等待。

保留 TTL、模拟延迟、业务时间窗口、数据量、锁持有和重试次数；只缩放轮询次数，间隔不变，避免倍率平方。parseFactor 的既有正数契约不改，显式小于 1 会缩短等待，不用于托管验收；本次默认 1、开发探测 2。高负载跨越业务窗口仍可能真实失败，不能通过放宽业务窗口隐藏它。

## 验证与复审

- Node22 budget/tree policy 11/11：新进程核对默认数值、倍率 2、上限 20 与 WRITE_BENCH 不变。
- GML_TEST_LOAD_FACTOR=2 的五条代表性实际场景 5/5：归档 SIGKILL 恢复、密码变更会话撤销、权限映射、metrics HTTP 权限、候选 ZIP 生成与独立解包校验。
- 修改的 JS/MJS 逐个 node --check；file-header 4/4、helper-shape 78/78、diff 检查通过。检索 tests/slow 未见剩余数字形式的 timeout、AbortSignal.timeout 或就绪/marker/profile 轮询上限；有意保留的业务数字不属于等待迁移。
- osstack 首次验证误填不存在的 check-test-tree.mjs 路径，已改为实际 helper guard；task_34282342 success。历史失败保留，聚合 exit 2 不冒充当前任务失败或托管通过。
- 两轮 Claude CLI claude-haiku-5-5 工具禁用只读复审，is_error=false、canonicalModel 已核验，均无确认阻断。已保留 AH1 历史迁移清单、明确 profile 默认 5 秒、核对残留字面量；保留既有小倍率契约，不为迁移改变所有旧测试的配置语义。

这里只是等待预算归一，不宣称测试运行时间已缩短或所有偶发失败已消除。全套 Linux 慢测试、LIKE 回退重跑和每文件耗时仍以当前 HEAD 的 CI 为准。没有运行本机 Python，没有合并或部署。

## PR28 同步 main（2026-10-28 北京时间）

- 实现基线仍是 98480e7；本次从 PR28 d4ed532 普通 merge 同步 main aecdf2601b811438f334107eb06ef20bae490b97（含已合并 PR26、PR27），无冲突，不改写历史。共同修改的 release-candidate 慢测试保留 ZIP 超限拒绝及统一等待上限。
- Node22 同步影响检查 118 项：117 pass、0 fail、1 条无 FTS5 条件跳过；倍率 2 的 ZIP 超限拒绝及真实候选生成 2/2；helper 78/78、header 4/4、diff 检查通过。这些仅是本机开发证据，合并同步后的精确 HEAD 完整 Linux CI 待执行。
- Claude CLI claude-haiku-5-5 工具禁用只读复审：is_error=false，canonicalModel=claude-haiku-5-5，无确认阻断。审阅者只看所给 diff/context，未执行 Git 或测试；合并父提交及保留内容由执行器核对。
- 可选意见：区分实现基线与同步基线（已在此澄清）；为快速配置探针统一 10 秒启动上限、补小于 1 的配置测试暂不扩展本次同步。已有正数配置契约和默认预算不变，不把可选建议当已复现缺陷。
- 不合并 PR，不启用 auto-merge；旧 HEAD 的绿灯仅保留为历史记录。

## 当前 HEAD 浏览器失败修复（2026-10-28 北京时间）

- 旧 1bccb71 的 CI40573432014 浏览器场景22/23通过，唯一失败是 mcp-token-limits.mjs 刷新前配额断言 actual 1 / expected 0；当时隔离回归仍在运行，不能宣称该运行全绿。原始日志保存在 osstack 管理工作区 pr28-browser-failed.log。
- 源码定位：McpLimitsCard 挂载取数一次，父 McpOperations.load() 完成后增加 nonce 再取一次；原测试仅等首张卡就改配额，可能与第二次取数竞争。仅改浏览器测试：点击前订阅精确 limits 路径的两次初始化响应，检查状态和响应完成，再等精确 DOM 读数；修改配额后、手动刷新前断言请求数未增加，刷新后恰好增加一次。所有原始配额/429计数/授权/秘密不展示/清理断言保留，未增加等待上限或修改产品。
- 初版按钮可用+networkidle等待经 Haiku 复审被否决（不能证明 SPA 新请求结束），已弃用。第二轮要求补 DOM 提交同步，并核对无定时轮询；已补属性等待，完整 card/useFetch 确认只有挂载与 nonce 驱动。
- 本机 Node22 策略/API 23/23、语法/diff、helper78/78、header4/4通过；本机不执行 Linux-only 浏览器场景。真实浏览器复现与修复验收仍以推送后当前 HEAD 的 Linux CI 为准，不把静态分析当已复现证明。
- 三轮指定 Claude CLI claude-haiku-5-5 工具禁用复审均 is_error=false/canonicalModel 已核验；最终无确认阻断。最终条件意见核对：createAccount 返回 username/password，operations 标签按条件挂载，刷新记录按钮唯一。没有声称托管浏览器已通过。
