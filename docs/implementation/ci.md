# CI 与验证主机分工

状态：工作流配置已编写；尚未在 Linux Actions runner 上执行。创建配置不等于 CI 已通过。

## 2026-10-22 托管 Actions 决定

用户决定：仓库公开且尚未开始收费期间，Linux/Node/Python 验证使用 GitHub 托管 runner（`.github/workflows/ci.yml`，`ubuntu-latest`）。触发方式：push 到 main、pull request、手动 dispatch（可指定回归轮数）。工作流分四段（`checks` / `regression` / `docker` / `browser`）：

1. `checks`：锁文件安装、显式重建 better-sqlite3/esbuild、`tsc --noEmit`、Vite 构建、`npm run test:focused`。
2. `regression`：在独立 venv 安装 `requirements-test.txt` 固定版本的 openpyxl，执行 `scripts/regress-isolated.mjs`（PR/push 默认 1 轮；手动 dispatch 默认 3 轮），只打印白名单汇总行并上传 `summary.json`，原始日志不上传。
3. `docker`（依赖 `checks`，15 分钟超时）：`docker build --platform linux/amd64 --build-arg GML_BUILD_SHA=$GITHUB_SHA -t os-erp:ci .`（不登录、不推送任何 registry），然后执行 `node scripts/docker-smoke.mjs --image os-erp:ci --expect-sha $GITHUB_SHA`。冒烟内容与 ADR-0012「验证」的手工步骤一致：(a) 不给 `GML_JWT_SECRET` ⇒ 非零退出且日志含 `JWT_SECRET_MISSING_IN_PRODUCTION`；(b) 给公开已知值 ⇒ 同样拒绝；(c) 随机密钥 + 命名卷 `/data` + 只读根 + `cap_drop ALL` + `no-new-privileges` + 只发布到 `127.0.0.1:<随机空闲端口>` ⇒ `/api/meta/health` 200 且 `version` 等于 package.json、`build_sha` 等于提交 SHA；`POST /mcp` 返回 503 `FEATURE_DISABLED`；`docker exec id -u` 为 10001；PID 1 为 tini；`touch /app/…` 报只读；`/data` 内已有 SQLite 库；容器日志不含随机密钥。脚本只用 Node 内建模块、以数组参数调用 `docker` CLI（不经 shell），随机密钥只经 `-e GML_JWT_SECRET`（不带值，从脚本进程环境继承）传入，输出只有 `ok:` / `FAIL:` / `smoke:` 定格行，失败诊断块对 32 位以上不透明串打码；无论成败 `finally` 里删除容器与卷。`tests/docker-smoke-policy.test.mjs` 静态守卫：job 存在且 `needs: checks`、Actions 全部按 40 位 SHA 固定、无 push/login、脚本从不回显密钥。维护者本机可直接复跑同一脚本（Mac mini 为 linux/arm64；**linux/amd64 只在托管 runner 上实际构建与运行**）。通过只代表该提交的运行镜像满足启动闸门与运行契约，不是生产部署验收。

4. `browser`（依赖 `checks`，25 分钟超时，X6）：在 `ubuntu-latest` 上跑 `tests/browser/*.mjs` 的真实 Chromium 场景。流程：`npm ci --ignore-scripts` + 显式重建 better-sqlite3/esbuild → `npx --no-install playwright install --with-deps chromium` → `npm run build` → `node scripts/browser-ci.mjs --out=artifacts/browser-ci`。
   - **Chromium 来源**：`playwright` 作为**精确版本**（1.64.0，发布于 2026-10-07）的 devDependency 写入 `package.json` 与 `package-lock.json`（`playwright` / `playwright-core` 两条，带 sha512 完整性），所以 `npm ci` 校验的就是锁定的包；浏览器二进制由 `playwright install` 按该版本下载，系统库用 `--with-deps`（托管 runner 上的 apt，一次性虚拟机）。不使用 `npx playwright@latest`。锁文件改动是在本机用 `npm install --package-lock-only --ignore-scripts` 生成的，**本机没有 `npm ci` 校验过**，以托管 runner 的 `npm ci` 为准。
   - **驱动脚本** `scripts/browser-ci.mjs`：先探测 Chromium 沙箱（开启可用则保持开启；若 runner 内核策略禁止非特权 userns 才回退到 `GML_CHROMIUM_SANDBOX=0`，并把取值写进摘要）；再在全新临时 `GML_DATA_DIR`（演示种子）、随机回环端口、随机 `GML_JWT_SECRET`、`GML_RUNTIME_MODE=test` 下启动 `server/index.js`；然后依次运行 5 个场景：`runtime-capabilities` / `session` / `user-editor`（既有，拦截式夹具）与 `funds-review` / `scope-notice`（新增，连真实服务）。场景与服务端的原始输出被捕获，只打印 `PASS` 行和脱敏尾部（32 位以上不透明串打码）；结束时无论成败都停服务并删除临时目录。
   - **funds-review**（ADR-0018）：两个新建 finance 账号（随机密码）；发起人在收款单详情无凭证点「确认收款」→ 服务端 400 `FUNDS_EVIDENCE_REQUIRED` 且仍是草稿；填凭证号再确认 → 响应 `pending_review`、状态仍 draft、应收核销为 0，界面显示「你是发起人，需由另一人复核」，没有「复核通过」按钮和授信效果面板；发起人调复核接口 → 409 `FUNDS_SELF_REVIEW`；第二人在界面点「复核通过」→ 响应 `confirmed` / `approved` 且复核人是第二人，授信效果面板出现、带本单单号，且行数/空态与响应里的 `credit_released` 一致（夹具是手工应收、无授信占用，所以释放为 0，不证明非零释放），应收核销金额等于收款金额，再次批准 → 409 `FUNDS_NOT_PENDING`、金额不变。
   - **scope-notice**（ADR-0017 / W3）：无组织的受限账号（`purchase`、`data_scope=org`）访问采购工作台 → 接口 200 且总览为 0，页面 `data-kind=empty_scope`（非阻断，标题仍在）；对照 admin 同页面没有范围提示；门店账号（`store`，绑定一家演示门店）→ 接口 403，页面 `data-kind=forbidden`（阻断，工作台标题不渲染，也不被画成空范围）。
   - **上传**：只上传白名单文件 `summary.json`（场景名、结果、耗时、Chromium 版本、沙箱取值）、`evidence-<场景>.json`（场景名与浏览器版本；`session` 与 `user-editor` 各写一份，因为它们用独占创建）和失败时的 `screenshots/failure-<场景>-<序号>.png`（文件名不含账号、单号或令牌）。原始 stdout/stderr、服务端日志、数据库、环境变量一律不上传。
   - `tests/browser-ci-policy.test.mjs` 静态守卫：job 存在且 `needs: checks`、25 分钟、Actions 固定 SHA、Chromium 只来自锁定的 playwright、上传路径等于白名单、驱动脚本用随机密钥/临时目录/回环端口且不继承输出、tests/browser 下每个场景都登记且语法有效、新场景断言的是服务端状态而不只是文案。
   - **状态：这 5 个浏览器场景（尤其新增的两个）尚未在托管 runner 上执行。** 本机是 macOS，场景断言 `linux`，只做了 `node --check` 与静态守卫；选择器、文案和时序是否与真实页面一致，要等第一次托管 CI 运行才知道，失败时按摘要与截图修场景，不得放宽断言。通过只代表该提交的源码级浏览器证据，不是发行包验收或生产就绪。

开始收费后切回专用 Linux 主机 `dmserver`（下文 `linux-validation.yml`）。托管 runner 的通过只代表对应提交的隔离源码回归，不是发行包验收或生产就绪。

## 平台边界

用户明确要求：Python 和 Linux 的 Actions 验证使用 Linux 服务器；macOS 与 Swift 构建/测试使用 Mac Studio。Mac mini 可以进行本项目的源码开发和集成，但其结果不能标为 Linux 或 Mac Studio 平台验收。

本项目目前是 Node/React/SQLite 应用，Excel 导出交叉验证需要 Python/openpyxl，没有 Swift 产品代码。因此本次只配置 Linux 工作流，没有空的 macOS/Swift job。以后出现 macOS/Swift 验收需求，必须使用确认属于 Mac Studio 的自托管标签，不能使用 `macos-latest` 或本机替代。

## 运行器尚待核实

`.github/workflows/linux-validation.yml` 仅支持 `workflow_dispatch`，不会因 push、PR 或 `pull_request_target` 自动运行。运行时必须给出已经核实的专用 Linux 自托管标签，并确认所选 ref 已审阅。`runs-on` 同时约束 `self-hosted`、`Linux` 和输入标签，不能仅凭自定义名字误调 Mac。

本批主线程已用 GitHub API 确认仓库没有已注册的 Actions runner；用户确认的 `dmserver` 通过现有 SSH 别名 `dmserver-ts` 连接，实际为 Linux x86_64。初始环境有 Python 3.10、没有 Node/openpyxl/unzip；已在任务独立目录准备并校验运行时，具体版本、失败尝试和最终结果见 [验证记录](validation.md)。本轮直接通过 SSH 验证；SSH 测试通过也不等于 Actions 工作流通过。

尚无已确认的 runner 标签或成功 Actions run。未注册 runner、未修改组织权限、未触发工作流。后续需要用户批准并配置专用 runner；不能将“排队等待匹配 runner”写成“验证已启动”。

当前文件在开发分支，`workflow_dispatch` 的可用性还取决于工作流进入默认分支。合并本身不包含在本次 CI 配置动作内。

Linux 主机最低前置条件：

- 专用、可丢弃的验证账户或 runner 实例；不携带生产数据库、云管理凭据或常驻客户服务。
- Node 22.x、npm、Git、Python 3 与 `requirements-test.txt` 固定版本的 openpyxl/et_xmlfile、unzip；better-sqlite3 所需原生运行库/编译环境。Python 依赖在 Linux 专用 venv 中准备，工作流不执行系统级 pip 安装。
- 能访问锁文件中的依赖地址，且可以监听本机 `127.0.0.1`。
- 有足够临时磁盘空间保存三轮样本库与日志；各次运行保留策略由主机管理员设置。
- 如果 Python 不在默认 PATH，设置仓库变量 `OS_EGP_LINUX_PYTHON` 为已验证的解释器路径。缺少依赖会明确失败，不跳过 Excel 验证，也不在工作流中修改系统 Python。

不得在共享生产主机上盲目安装依赖或运行任意待审分支。手动触发只是降低误执行概率，不替代隔离账户、受控出口与对执行代码的审阅。

## 验证内容及证据

1. 核验 Linux、Node 22、Python/openpyxl 与 unzip，并对照 `requirements-test.txt` 检查实际 Python 包版本。`GML_VERIFY_PLATFORM=linux` 还让整合后的 runner 在调用 Python 前拒绝非 Linux 平台。
2. 按锁文件执行无生命周期脚本的 `npm ci`，仅显式重建已选择的 better-sqlite3/esbuild 原生依赖。
3. 执行 `scripts/regress-isolated.mjs --rounds=3 --industries=cosmetic,food`。整合后的跑批必须包含 `tests/*.test.mjs` 新专项测试、现有业务回归、TypeScript 检查与 Vite 构建；主线程合并时检查 runner 与工作流契约。
4. 三轮使用隔离数据，整个工作流串行，避免旧测试固定端口在不同 ref 的任务间冲突。这个 concurrency 只覆盖本仓库工作流，不能管理同主机其他项目，所以仍需专用 runner。
5. 上传白名单摘要和代码哈希清单：提交 SHA、阶段结果、运行平台与 Node 版本、计划轮数、行业范围、最终 manifest 结果。三轮中的实际通过/失败明细保存在主机原始日志，未经检查不上传。

原始 stdout/stderr、环境变量、JWT、数据库、npm 日志、原始 manifest 路径及异常信息不作为 artifact 上传。原日志可能含历史用例的测试 Token；本工作流重定向输出并只打印阶段结果。随机测试 JWT 在结束步骤删除；日志/数据库保留于专用 runner 临时目录，由维护者按保留策略清理。工作流不会全盘清理 `/tmp` 或结束其他服务。

官方 Actions 固定到只读核实的提交：checkout v4.2.2 `11bd71901bbe5b1630ceea73d27597364c9af683`；upload-artifact v4.6.2 `ea165f8d65b6e75b540449e92b4886f43607fa02`。仅授予 `contents: read`，checkout 不持久保存 Git 凭据。

## 验收层次

通过这份工作流仅意味着对应源码提交完成声明的隔离回归。它不证明发行 ZIP/容器正确、备份可恢复、外部支付真实到账、租户隔离完成，也不证明已取得开源授权。精确发行包测试、恢复演练、客户场景验收和权属确认仍按 handoff 继续。

本次仅做配置静态检查，没有在 Mac mini 上运行 Python 或伪造 Linux 结果。若依赖检查或跑批失败，应保留具体阶段和退出结果，修改后重跑同一验收范围，不能通过删除测试或调整成功判据获得绿色结果。

已完成的静态检查：Ruby YAML 语法解析；Node 检查手动触发、Linux 及只读权限、固定 Actions SHA 和 artifact 路径白名单；Bash `-n` 检查各 shell 块；Node VM 仅编译内嵌 JavaScript。内嵌 Python 未在 Mac mini 执行，须在 Linux 前置检查中实际验证。
