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
