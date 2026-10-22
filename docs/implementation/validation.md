# 第一批开发验证记录

已验证候选为 `9c532f39183eede6a0c45ac4990d1742c57b65aa`。Linux 完整三轮于 2026-10-22 08:54:52.589001 UTC 启动、09:16:55.299864 UTC 结束，runner 退出 0；证据目录为 `evidence-9c532f3`。前两次候选失败均已定位、记录并回收本任务进程，未混入本次通过结果。

三轮每轮 **113/113 跑批项通过、0 失败**，合计 339 个跑批项。每轮旧式成功断言计数 8,291，累计 24,873；这是重复三轮的旧格式计数，不是独立用例总数，也不包含 TAP 断言统计。每轮 node:test 集合、库存类型 29/29、XLSX 51/51、smoke-api、tsc、Vite 均通过。三轮之前单独执行的 Linux XLSX 前置也为 51/51。

全套成功后额外顺序执行五个专项文件，实际 TAP 结果：**tests 44 / pass 44 / fail 0 / skipped 0 / cancelled 0 / todo 0**，退出 0，用时 97.298 秒。再次核对 444 个来源文件未改变。专项统计为运行模式 18、管理员初始化 9、能力门禁 5、授信 8、Python resolver mock 4；真实 Python/openpyxl 验证由完整回归内的 Excel 用例提供。

## 可核对的本地证据

- [逐项结果、三轮统计与失败历史](../evidence/linux-2026-10-22/validation-summary.json)
- [Linux 环境、工具来源与下载校验](../evidence/linux-2026-10-22/environment.json)
- [444 个文件的传输及执行副本 SHA256](../evidence/linux-2026-10-22/source-fingerprints.json)
- [证据文件 SHA256 索引](../evidence/linux-2026-10-22/artifact-sha256.json)
- [机器生成的简明摘要](../evidence/linux-2026-10-22/validation.md)

证据固定对应 9c 源码候选；后续交付提交只更新 `docs/` 和根 `handoff.md` 文档，不改变执行代码、测试、构建配置或依赖锁。不能把文档修订后的整个工作树声称为逐文件完全相同的测试快照。

## 基线与开发验证

用户指定平台分工前，原版 Node22/Mac mini 基线 112 项跑批中 109 通过、3 失败；两个 Excel 读取验证缺 openpyxl，一项订单授信断言为真实缺陷。修复后的原授信守卫在新临时数据上从 383 通过 / 1 失败变为 384 / 0，原断言未修改。

各实现分支在 Mac mini 的 Node 开发验证：runtime 18 项、capabilities 5 项、授信 8 项；bootstrap 原 8 项通过后补全新空目录并发 1 项单独通过。Python resolver 的 4 项使用 mock，不执行本机 Python。以上不能代替最终集成或 Linux 结果；Linux 跑批已包含全部 5 个专项文件。

独立只读复审发现并推动修复卫星 seed、默认生产 JWT 和 OMS 模拟库存推送等遗漏。复审不等于动态重跑。无 Claude Code 或跨模型审查声明。

## Linux 证据边界

用户明确指定 `dmserver`，通过已有 SSH 别名 `dmserver-ts` 连接。隔离目录：`/home/osborn/os-egp-validation-20261022-C9Nv8B`。Node 22.22.1 / npm 10.9.4，Python venv 3.10.12 / openpyxl 3.1.5 / et_xmlfile 2.0.0。没有 sudo、系统包变更、认证变更或运行器注册。

官方 Node 归档和 Python wheels 分别核对官方 SHASUMS/PyPI JSON SHA256。Linux 独立安装锁文件依赖，禁用默认生命周期脚本后仅重建 better-sqlite3/esbuild；原生文件确认 Linux x86-64 ELF，未复制 Mac 二进制。

三次集成候选的可执行源码快照均为 444 个文件；包括 server/src/scripts/tests/public/reusable 与根目录已跟踪文件。排除历史截图、docs 目录和交付 ZIP，与隔离 runner 的实际代码复制范围一致；根目录 README/handoff 等文件仍在快照内。这是源码回归，**不是完整仓库镜像、发行包或安装器验收**。

b6 候选传输归档 SHA256：`bdb8522932108fa9e5b4be2cf7e3615779d18124d702278821ed869bda495678`。3a 候选归档 SHA256：`7fdfb910e1613ef1de5d3b16e1b45ec92e42bfe4d4cbfd3370151cb8e20a3847`。9c 候选归档 SHA256：`3e9e8924259e2f83f4ee62b6194ca450d6893765463c398184c0d78619d35778`。依赖锁 SHA256：`89cdf9c56f848412be80d23a04856cdec7a2d4b26144a41d18cb2b6badeee1cb`。每个入包文件独立核对 SHA256。

快照无 `.git`，runner 的 source_head 不能伪造为已验证 Git checkout；准确提交来源由传输 manifest、逐文件 hash 与 runner copied hashes 对应证明。首轮尝试开始时间：2026-10-22 08:23:06 UTC。

执行：Linux 专属解释器、`GML_VERIFY_PLATFORM=linux`、随机测试 JWT 密钥、loopback 服务和新建任务临时副本，`regress-isolated.mjs --rounds=3 --industries=cosmetic,food`。runner 准备一次隔离数据后在同一任务副本串行三轮，具体用例再按各自规则创建/恢复夹具；不是三次全新系统安装。服装数据仅作兼容夹具，未做服装业务全量验收。

旧 runner 保存各跑批项退出码与旧式中文断言计数，但不保留成功 node:test 的 TAP 计数。因此三轮的新增专项集合通过状态与旧断言累计分开解释；全套结束后的额外一次专项 TAP 已用于记录准确 tests/pass/fail/skipped，不把静态测试数量当动态统计。

## b6 候选失败记录与修复

第一轮完整执行 113 项：111 通过、2 失败，旧断言成功计数 8,261；node:test 集合、tsc、Vite 与 smoke-api 通过。第二轮开始后主动中止，08:31:13 UTC 结束、退出码 143，全部已确认归属本任务的进程回收。不得将此尝试写成三轮通过。

- 库存类型 HTTP 用例在旧 20 秒就绪预算内失败，随后 ECONNREFUSED；旧脚本丢弃子服务输出，不能还原其内部状态。另一次全新独立冷启动诊断于 27.478 秒报告 ready、27.490 秒获得 health 200，证明该机器的三行业演示夹具冷启动确实可超过旧预算。
- XLSX 50 项通过、1 项失败，唯一失败是 `unzip -t` 旁证；Python/openpyxl 均正常，系统原本未安装 unzip。已将官方 Ubuntu 6.0-26ubuntu3.2 amd64 包按 APT 元数据 SHA256 校验后仅解压到任务 tools，不执行维护脚本或修改系统安装状态。

3a 候选仅改变两个运行/测试文件：库存用例改用唯一临时目录、随机 loopback 端口、90 秒有界就绪预算、单次探测 Abort、进程提前退出检测、失败短路、finally 确认子进程关闭后清理；隔离 runner 在建库前检查 unzip 并记录版本。业务断言未减少。Mac mini Node 专项正常 29/29，故意 1 秒超时正确失败且确认进程/目录回收；这仍不能替代新 Linux 三轮结果。

## 3a 候选失败记录与修复

第一轮完整 113 项：112 通过、1 失败，旧断言成功计数 8,290。库存类型 29/29、node:test 集合、smoke-api、tsc 与 Vite 均通过；XLSX 仍为 50/51。第二轮未完成任何跑批项，已停止明确归属的 runner 及 4 个后代，无孤儿进程。外层 driver 退出 1，子 runner 因主动 SIGTERM 为 -15；这是发现确定失败后的中止，不能表述为回归自然结束。

此次已核实 `PATH` 中 `unzip -v` 退出 0，而旧 XLSX 用例写死 `/usr/bin/unzip`，该绝对路径不存在（ENOENT）。因此不是 XLSX 文件损坏，也不是 Python/openpyxl 失败；前置检查与实际用例采用不同工具解析方式。9c 已统一为 PATH 解析并保留退出码/错误码诊断，先在 Linux 跑 XLSX 专项，再以新候选重跑完整三轮，均通过；没有创建系统链接或修改系统安装。

独立只读复审另指出库存 HTTP 用例最后一个响应后、清理前服务自行异常退出可能漏报；9c 候选已补区分测试主动停止与服务提前退出，并经非实现者静态确认。Mac mini Node 正常 29/29；外部 SIGKILL 故障反例正确非零退出，两次均确认无遗留子进程/目录。此为测试可信度修复，不改变业务断言。

## 未验证与继续开放的阻塞

没有执行 GitHub Actions（仓库尚无 runner）、Mac Studio/Swift、Windows、真实支付/连接器、性能容量、安装包、备份恢复或生产上线验收。`eva` 简写不能直接解析；通过已认证的 dmserver Tailscale 主机目录找到了在线的 EVA Mac Studio，但现有 SSH 用户 osborn 认证被拒。没有尝试其他账号、绕过校验或修改权限/认证。

原始日志可能含测试凭据，只在任务隔离目录保留；提交的证据必须是检查过的摘要与哈希白名单。原审计 F01–F16 与后续授信缺口按 backlog 保持实际状态。
