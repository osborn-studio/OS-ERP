# 回归环境与基线失败记录

## 平台分工

按用户 2026-10-22 最新要求，Python 与 Linux Action 验证在指定 Linux 服务器执行；macOS/Swift 代码验证在 Mac Studio 执行。本子任务没有执行 Python、安装 openpyxl 或将 Mac mini 的结果标为 Linux 通过。

基线日志属于要求变更前的 Mac mini 执行，仅用于定位：`artifacts/baseline-loopback/runner.log` 记录原版一轮 112 个跑批项中 109 通过、3 失败。它不是 Linux、Windows 或商业上线验收。

## 三项失败的证据与状态

| 项目 | 已知原因/证据 | 状态 |
|---|---|---|
| `test-xlsx.mjs` | 44 通过 / 7 失败；第三方读取器报 `No module named 'openpyxl'` | 环境缺依赖。Linux 需装独立测试环境后重跑，不能跳过断言 |
| `test-export-excel.mjs` | 50 通过 / 52 失败；同一第三方 XLSX 验证依赖缺失 | 环境缺依赖；不是已证明导出产品缺陷，也不是通过 |
| `test-guards.mjs` | 383 通过 / 1 失败；A06“额度按占用时来源 SO 释放” | 已用 Node 独立样本复现并修复正向映射；Linux 集成验收待执行 |

A06 已在全新隔离三库及随机 loopback 端口以 Node 22.22.1 / Mac mini 复现：SO 的净授信占用 3199.91，回款 1 元核销到该订单的 SI 发票应收后，占用仍为 3199.91。根因不是夹具缓存：订单回款已用 `arOfOrder` 聚合 SO/SI 应收，`confirmReceipt` 却仍按 SI 来源释放授信；实际占用记在 SO。修复将关联 SI 的释放来源映射到其销售订单，只释放本次核销金额，并保留 `creditSettle` 对剩余占用的上限限制。未修改原 A06 断言。

`tests/credit-settlement.test.mjs` 新增 5 项 Node 内存数据库回归并通过：部分核销只影响所属订单；一订单多发票/跨订单核销分别释放；释放不超过剩余占用；重复确认拒绝；第二笔授信写入故障时，第一笔释放、应收余额、收款状态与事件全部事务回滚。直接 SO 应收兼容也在用例中覆盖。这是 Node 开发验证，不能替代 Linux 整体回归。

独立复审后补充并通过 3 项边界反例，专项现为 8/8：发票 ID 与另一销售订单 ID 相同时仍按 `invoice.order_id` 定位；第二客户不能核销第一客户应收且失败不留收款；无关联订单的手工发票保持 SI 来源，不因数字 ID 相同误释放 SO。

修复后在另一组全新三库重跑原 `test-guards.mjs cosmetic`，384 通过 / 0 失败（修复前 383 / 1）。本地原始证据在回归工作树 `artifacts/a06/` 与 `artifacts/a06-fixed/`；不提交可能含测试凭据的原始日志。

## 新确认的财务闭环阻塞（P1，尚未修复）

1. **统一授信在作废收款后未恢复。** `server/lib/ar.js:voidReceipt` 在回退应收后，仅针对 OC 调用 `ocReoccupyByOrder`；SO/SI 使用的统一 `credit_ledger` 未补对应反向记录。触发：确认收款已释放统一授信后再作废。影响：欠款恢复、占用不恢复，客户可用额度被虚增。置信度：静态确定路径缺失；未在本批补完整逆向。需迁移增加“收款/核销—实际授信释放”的稳定关联及反转唯一性，按实际释放量恢复，不能凭收款总额猜测，尤其存在封顶、部分核销、一订单多票与多次核销。
2. **预收抵账未统一释放 SO/SI 授信。** `server/lib/ar.js:applyPrepay` 的释放循环仅针对 OC 调用 `ocReleaseByOrder`，SO 分支只回写已收金额，SI 未映射统一授信。触发：已确认未核销收款之后通过 applyPrepay 抵 SO/SI 应收。影响：应收下降而信用占用保留，可用额度与真实债权不一致。置信度：静态确定路径缺失。下一步应让确认、后续抵账、撤销共用可追溯的结算分配记录及对称事务，加入重复请求、金额封顶、退款与并发验收。

以上两项继续阻断商业财务闭环验收。本批修复范围仅为正向确认收款的 SI→SO 来源对应，不声称整个回款、撤销、预收和退款链已可生产。

## Linux 执行准备

在 Linux 的独立 checkout 和隔离环境中执行，使用 Node 22。不要复制 macOS 的 `node_modules`；SQLite 原生模块需按 Linux 安装或构建。以下命令是待执行步骤，不是本次执行证明：

```sh
python3 -m venv .test-data/venv
.test-data/venv/bin/python -m pip install -r requirements-test.txt
export GML_PYTHON="$PWD/.test-data/venv/bin/python"
export GML_VERIFY_PLATFORM=linux
# Linux 主机必须在 PATH 提供 unzip；缺失时 runner 在建库前报错。
command -v unzip
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3 esbuild --no-audit --no-fund
node --test tests/python-runtime.test.mjs
node scripts/regress-isolated.mjs --rounds=3 --industries=cosmetic,food --output=artifacts/linux-regression
```

版本固定在 `requirements-test.txt`，尚未加入下载哈希锁定；运行时保存 Python/openpyxl 版本和安装记录。该环境只用于验证，不进入生产发行包。包管理器不能联网或无法安装时，应记录失败，不能使用 skip 替代。

`GML_VERIFY_PLATFORM=linux` 在调用 Python 之前检查平台；错误平台直接拒绝。`GML_PYTHON` 指定的解释器必须真实执行并成功导入 openpyxl，不可用时不回退。省略时只按 PATH 尝试 `python3` / `python`，不再携带上游个人电脑路径。完整隔离跑批在创建/灌数前检查该前提，并将解释器实际绝对路径、Python/openpyxl 版本、OS、架构写入 `manifest.json`。

全量跑批自动发现 `tests/*.test.mjs`，串行执行各文件，后续新增 runtime、capability、bootstrap 用例不会因未登记文件名而漏测。原有 scripts 下的 test/verify/check 与类型检查和构建保留。

专项修复完成后由集成负责人在 Linux 运行全量三轮；本子任务做了源码语法、diff 检查与上述纯 Node 开发回归，未调用 Python，未声称任何新 Linux 动态测试通过。

## Linux 首轮实证触发的测试基础设施整改

集成候选 b6 的 `test-inv-type-gate.mjs` D 节在原 20 秒就绪轮询后仍继续发登录请求，报 `ECONNREFUSED`。原实现丢弃服务输出、使用固定 `/tmp/gml_inv_type_gate_api` 与 44571 端口、异常时没有 finally，Linux 现场确认留下 PPID=1 的自有 Node 子进程，已由远端执行器回收。

另一次独立 Linux 冷启动诊断记录：全新三行业数据的日志 ready 为 **27.478 秒**，health 200 为 **27.490 秒**，服务没有异常退出。这证明该机器上真实冷启动可超过旧 20 秒预算；原失败时日志已被丢弃，不能断言其唯一原因就是超时。

测试现使用唯一 mkdtemp 目录及系统分配的 loopback 端口，显式 test 模式、独立密钥；默认冷启动预算 **90 秒**（`GML_TEST_STARTUP_MS` 可显式设置 1–180 秒）。子进程提前退出会立即失败；就绪探测单请求上限 1 秒，既要本子进程报告 listening 也要 health 200。失败保留有限、脱敏的诊断，停止后续业务请求。finally 先 TERM 等待 close，必要时 KILL 并再次等待；仅确认子进程关闭后才移除自己的临时目录。A–C 的直接 SQLite 夹具也不再共享固定文件名。原业务断言全部保留。

本机纯 Node 聚焦验证：正常路径（显式 60 秒预算）ready 14.202 秒，29 通过 / 0 失败；故意设置 1 秒预算时约 1002ms 报明确就绪失败，退出码 1，不继续登录/业务调用。两个进程结束后均独立通过 PID 存活探测和目录存在性检查：子进程不存在、夹具目录已删除。证据在回归工作树 `artifacts/inv-lifecycle/`。这不替代远端 Linux 后续三轮集成结果。

同一 Linux 轮次 `test-xlsx.mjs` 的 ZIP/XML/openpyxl 50 项通过，最后 `unzip -t` 失败；远端只读核验确认为缺少 unzip。远端执行器按官方 Ubuntu 包元数据校验 SHA 后只解包到用户目录，未系统安装。本 runner 新增实际 `unzip -v` 前置检查及 manifest 版本记录，缺少工具会在复制/灌数前失败，不改成跳过该旁证。

后续 Linux 候选 3a 揭示第二层路径问题：前置检查通过 PATH 找到用户目录 unzip，但旧 XLSX 用例仍硬编码 `/usr/bin/unzip`，因此仍为 50/51。用例现与 preflight 一致，通过 `spawnSync('unzip', ...)` 使用 PATH，并记录失败的 error.code/status；`No errors detected` 断言保留，增加 10 秒外部命令上限。本机没有执行 Python；实际 XLSX 复验由 Linux 执行器集中完成。

HTTP 夹具收尾进一步记录本测试实际请求的停止信号，等待 close 后核对退出结果。即使最后一次 HTTP 已完成，只要服务在受控停止前退出、以非零/正常退出码自行结束、或收到本测试未发出的信号，也不能被 finally 当成成功清理而掩盖失败。

该收尾修改经纯 Node 再验：正常 29/29；临时外部注入器在服务报告 listening 后发送 SIGKILL，脚本按预期 exit 1，报告 `signal=SIGKILL; requested=none`。两次结束后 PID 均不存在、夹具目录均删除，日志保留在 `artifacts/inv-exit-check/`。
