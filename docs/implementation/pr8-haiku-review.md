# PR #8 审查修复记录

日期：2026-10-26。审查基线 `1938a7a1af3ae1505a546c0daf19bf17d06c3131`，目标 main `5acd8659263a6c28358160d1e2046be904ba56ec`。仅开发验证，不代表 Linux、发行或生产验收。

## 已修复

1. **P2：断链备份可被清单伪装为有效基线。** `loadBackupManifest` 原来只比较链尾、行数和锚点摘要，没有核对重算的 `verified` 与 `break`。已复现：两行链的第二行损坏，备份保存有效前缀；恢复 live 库后，仅将清单 `verified` 改为 true，备份字节与 sha256 不变，CLI 原来退出 0。现在严格比较验证状态和断点结构，不符返回 `manifest-mismatch` / 退出 1。诚实的断链备份仍可创建、读取，但 `compareLiveToBackup` 继续返回 `backup-chain-broken`，不能作为基线。
2. **设置说明遗漏 AC3 集成范围。** `docflow_strict_store_binding` 文案只列 RC/YQ/SH，且笼统声称关闭恢复旧行为。修正设置说明与 ADR-0051：未绑定检查覆盖 RC/YQ/SH/PS/PSF 和 DR；关闭只取消该检查。已绑定账号、OC/OCS 订货主体、DS/RB 总部专属及 MCP 的限制继续生效。没有放宽权限或改动授权逻辑。

## 复现与验证

- 新增 8 个篡改场景：明文/加密各覆盖伪造验证状态、伪造状态并隐藏断点、单独隐藏断点、改动断点。旧实现的伪造验证状态场景实际退出 0；仅修改断点的场景原来也退出 1，但载入器未识别清单不一致。修复后全部返回 `manifest-mismatch`。
- 加密场景使用测试密钥重新加密伪造清单，使两份清单一致且认证通过，证明拒绝来自备份内容重算，而非明密文不一致；备份本身始终不变。
- 新增 6 个兼容场景：明文/加密下的 content、link、unchained 断点，包含首行断裂、空有效前缀。真实断点经 JSON 往返后仍可加载且不能成为有效基线。
- 本机 Node v22.22.1：`audit-chain.test.mjs` + `db-backup.test.mjs` **73/73**；`hq-roles.test.mjs` **11/11**；`mcp-doc-perms.test.mjs` 的 AC3 范围 **10/10**。均无失败、无跳过。
- 静态守卫、codemap/changelog 检查、TypeScript、Vite 已通过。完整托管 Linux CI 须等待推送后的精确 HEAD，不能用上述本机结果或旧 HEAD 替代。

## Claude CLI Haiku 5.5 审查与取舍

PR 代码/测试/CI diff 审查及补丁复审均使用 `claude-haiku-5-5`、禁用工具，仅审给定文本；两次 `is_error=false`、`canonicalModel=claude-haiku-5-5`。补丁复审未发现确定阻断。条件逐项核验：

- 清单首次引入提交 `febc82a` 即生成 `verified`，没有已知本项目旧格式缺失该字段；content/link/unchained 的 JSON 兼容性已补测。
- `encryptFile` 导出与测试依赖存在；加密失败清理其自行创建的 `.partial`，不会留下成功命名的 `.enc`。现有备份故障测试通过。
- `invFilter` 已定义；MCP `buildContext → effectiveScope` 总是生成范围对象，有限范围无组织集合会失败关闭。辅助函数省略 scope 的历史全局语义未扩大。
- 默认仓库缺失时 summary 的库存分支及响应已有空值处理；所需 allowlist 和 alerts 文件均被 Git 跟踪。
- 孤立明文清单只能自身校验并注明未经认证，是 ADR-0049 已接受的离机清单模式；此次没有将其宣称为认证证据，也没有擅自改变模式。
- 普通归档与 `--resume` 的语义不同；幂等续做和崩溃恢复的已有用例通过。FTS 探针对争用测量的影响仍为未复现的性能假设，未据此改变锁等待阈值。
- ADR-0050 已登记的全局 metrics 范围、复合工具字段权限等既有未完成项保持原记录；此次审查不宣称整个产品安全验收或商业就绪。

原始日志、模型输出、osstack 状态保存在本机 `/tmp/osstack/pr8-review/`。GitHub 审查意见的重新批准仍由独立审查者完成；不合并、不启用 auto-merge、不恢复定时任务。
