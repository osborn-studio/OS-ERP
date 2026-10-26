# PR #9 main 同步与 Haiku 5.5 复审

日期：2026-10-26。范围：第十三批 AD1–AD12 相对 main `edb881f8df7af400e9744e9683dd73c52567ce87` 的开发审查；不合并 PR，不代表发行包或生产验收。

## 同步与已修复问题

- 本地从 `640b8b56dd9ba403634722f1c34e85611d48c9b8` 合入上述 main，无冲突。期间远端也产生了同步提交 `fb790c0d096b1892246924e621944fa94d300d54`，两次合并的树完全一致；提交历史以普通 merge 保留，不强推。
- **SSH 锚点覆盖竞争**：原 `test ! -e final && mv tmp final` 在检查之后、移动之前允许另一写入者创建终名，随后覆盖旧锚点。隔离替身在该窗口插入旧内容，原实现确定性失败。改为 GNU `ln -T -- tmp final` 原子独占发布；同名文件、目录和符号链接均拒绝，硬链接不支持则失败，不退回覆盖式移动。Linux 测试分支调用真实 GNU `ln`；本机 macOS 分支使用 `fs.linkSync`，不能冒充 GNU/Linux 验收。
- **本地回退写入错误与清理遗漏**：无硬链接时原 `writeFileSync(final, ..., wx)` 遇 ENOSPC 留下不完整终名；catch 内 `die()` 的 `process.exit` 还跳过 finally，使临时文件残留。修复为先独占打开、按文件描述符写入，仅在已取得创建权且写失败时删除本次终名；临时清理完成后才退出。旧实现的三个定向用例为 1 通过、2 失败，修复后均通过。已有竞争者锚点不被删除。进程异常终止（如 SIGTERM/SIGKILL）不在可捕获错误清理保证内；非硬链接回退不保证崩溃原子性，文档要求使用前验签。
- **契约遗漏**：补齐已有 `/api/meta/role-matrix` 登录接口的 OpenAPI 声明并重新生成客户端路径类型（524 条路径）；这是本批尚未发布的 1.41.0 契约补全。
- 删除 Metrics 页已过时的 TODO；实际 `scoped === false` 的“全局口径”标签已存在。SSH 发布结果因断线不确定时，错误提示现在要求检查远端终名；临时文件清理描述为尽力处理。

## 独立审查与条件性意见核验

Claude CLI 使用完整模型 ID `claude-haiku-5-5`，工具禁用、safe-mode、只审给定文本。每轮核验 `is_error=false` 与 `modelUsage` 内 `canonicalModel=claude-haiku-5-5`；没有用别名或其他模型替代。首次审阅完整代码/测试/CI 差异，随后多轮复审聚焦修复及故障清理。确认的关闭失败、清理错误掩盖原始异常、临时名所有权和读回错误也已补强：保留原始失败，报告可能残留路径，只清理 wx 成功创建的文件，读回失败保留产物供核验并以 WRITE 非零退出。。原始输入输出保存在本任务 `/tmp/osstack/pr9-review/haiku-*-*.{txt,json,log}`，临时证据不提交。

最终复审结果：完整审查的确认问题已处理，最后一轮对最终本地发布路径未发现阻断缺陷或回归；不替代精确 HEAD 的 hosted Linux 验收。读回一致性不等于断电持久性，本补丁没有新增 fsync 保证。临时清理失败时即便终名已发布仍退出 1，并在 stderr 明示发布状态和残留路径，属于有意的失败报告。

已逐项核验的条件性意见：

- 根 package-lock 与源码均无残余 zod 依赖；`package-release.mjs` 递归打包 scripts，包含新导入模块。
- demand 路由的 HQ 是独立字面量（不含 boss）；docflow 的 boss 例外符合 ADR-0051 AD2，HQ 权限回归通过。`permContext` 将 admin 角色视为 isSuper；角色矩阵没有所猜测的 admin 分歧。
- `initSchemaFor` 不灌 demo 数据，不会与矩阵生成器 org=1 夹具冲突；生成器 `--check` 通过。角色矩阵测试已有匿名 401、非管理员仅自己的角色列、无其他主体/权限码泄露及每格独立推导。
- FTS migration 067 只在缺表/触发器时 rebuild；MCP 日限额的 created_at 原定义使用 localtime，查询边界一致。
- 测试用登录 IP 上限环境变量实际存在；CI 按 event_name 区分并发、候选作业独立串行是明确设计。

保留的边界：ADR-0053 的受限账号全局指标仍仅标 `scoped:false`，不是数据隔离完成声明；桥接锚点接受依赖显式操作员参数；MCP 429 是 ADR-0056 契约，未验所有客户端；候选 tag/manual 作业只读 GH_TOKEN 仍被其可信测试子进程继承，无已确认泄露，但更窄环境传递可后续加固；备份 `.partial` 是恢复残留且不计作有效备份，普通并发命名由写冻结及 partial 保留名避免碰撞，不承诺抵御目的目录的外部恶意写入者；测试日志正则并非通用秘密脱敏器。这些不应被写作生产就绪。

## 验证证据

本机 Node 22 开发检查（无本机 Python，无客户数据、真实 SSH 或外部付费服务）：

- 合并影响：audit-chain、write-contention、hq-roles **82/82**，0 跳过。
- 六文件焦点检查：offbox-anchor、fs-fault、mcp-rate-limit、role-matrix、authz-followups、audit-fts-maintain **108 项，107 通过、0 失败、1 跳过**。跳过项要求不含 FTS5 的 SQLite 编译，由 hosted `audit-no-fts5` 作业执行。
- 最后修复后离机锚点完整测试 **29/29**，0 跳过，包括十二个本地发布故障/成功用例（含关闭失败、双重错误、清理被拒、临时写满/冲突、真实硬链接 EEXIST、读回错误/不匹配）及远端碰撞/不支持用例。
- TypeScript、Vite build、12 项守卫、changelog/codemap/role-matrix 漂移检查通过。两项数据守卫第一次因未设数据目录退出 2，随后 inventory 守卫因空 schema 没有流水拒绝；这两次不能算通过。改用三行业全新合成 demo 数据后：inventory 25/25、MCP 每行业 29/29 通过。
- 扩展 preload 夹具初次误把 Node ESM loader 的 URL 参数交给 path.basename，导致 12 个夹具用例失败；已限定路径识别的输入类型后重跑。这是测试接缝错误，不作为产品缺陷复现证据。关闭/清理错误各有独立修复前反例。
- osstack 0.22.1 有限任务保留了上述失败及恢复证据；历史 escalated 仍可能使聚合退出码为 2，以具体新任务与验证结果为准，不把采集/验证任务成功当 CI 通过。

最终提交的 hosted Linux 完整 CI（含焦点、无 FTS5、Docker、浏览器、隔离回归）需另行核验精确 HEAD，并在 PR 评论记录运行链接和通过/失败/跳过范围。旧 HEAD 的绿色不替代新提交。
