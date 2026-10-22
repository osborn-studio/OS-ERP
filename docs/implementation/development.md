# OS ERP 开发与验证

目前是公开的开发预览版本，尚未达到生产交付条件。请使用 Node 22，与 `.nvmrc`、package engines 一致。Mac mini 上的 Node 开发检查与 dmserver 上的 Linux 集成验证分别记录；目标平台的实际结果见 [验证记录](validation.md)，不能互相替代。

## 依赖与本地开发

使用锁文件安装。首次审阅依赖生命周期脚本后，先 `npm ci --ignore-scripts --no-audit --no-fund`，再按环境需要执行 `npm rebuild better-sqlite3 esbuild --no-audit --no-fund`。本批没有升级依赖或修复已有依赖公告。镜像地址沿用原锁文件，供应链迁移另开任务。

仅在自己新建的临时数据目录开发演示：

```sh
export GML_RUNTIME_MODE=demo
export GML_DATA_DIR="$(mktemp -d /tmp/os-egp-demo.XXXXXX)"
export GML_DB=
export HOST=127.0.0.1
export GML_JWT_SECRET="$(node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('hex'))")"
npm run dev
```

上述每次新 shell 会生成独立密钥，仅供临时开发；不要据此设计生产密钥持久化。不要把终端环境或实际密钥粘到报告。演示模式会生成虚构数据，只能用于本机测试。

## 验证命令

```sh
npm run test:runtime
```

下列完整回归包含 Python/openpyxl，只在用户指定的 Linux 主机 dmserver 的任务隔离目录执行。`GML_PYTHON` 应指向已校验并安装锁定测试依赖的独立 venv 解释器；先激活该任务的验证环境：

```sh
export GML_VERIFY_PLATFORM=linux
: "${VIRTUAL_ENV:?先激活任务独立 Python venv}"
export GML_PYTHON="$VIRTUAL_ENV/bin/python"
node scripts/regress-isolated.mjs --rounds=3 --industries=cosmetic,food --output=artifacts/runtime-isolation
```

真实 HTTP 用例需要允许 loopback 监听。沙箱 `listen EPERM` 是环境阻断，不是通过证据。完整回归脚本会创建临时副本并在副本中建库，不要改成直接指向真实数据。新增专项测试已接入完整跑批。

原始测试日志、数据库与生成文件在 `artifacts/` / 临时目录保存，不提交；经过检查的汇总写进 `docs/implementation/validation.md`。原版演示日志可能包含测试 Token，因此不要上传原始日志到公共站点。

## 后续工作入口

ChatGPT 负责审阅 handoff 与证据、确定下一批范围；Codex/Claude Code 分别实现与独立审查，可轮换角色。分别使用工作树，不能同时写一个 checkout 或共用数据库/端口。当前尚未调用 Claude Code；独立审查来自本任务的只读审查代理。

本批已加入 [管理员 bootstrap](ADR-0003-admin-bootstrap.md)、[生产功能门禁](ADR-0002-capabilities.md) 及 [前端会话处理](ADR-0004-frontend-session.md)，需以集成验证记录确认实际结果。当前推进第二批会话/能力集成的独立复审和 Linux 验证，之后继续采购—库存—销售—往来闭环。一次 PR 只处理可独立验收的问题，未解决的原审计项继续保持 open。

手动 Actions 使用专用 Linux 自托管 runner；尚未注册 runner 时，不能把 SSH 跑批声称为 Actions 验收。仓库变量 `OS_ERP_LINUX_PYTHON` 指定该主机验证 venv 的解释器；为已有配置保留 `OS_EGP_LINUX_PYTHON` 回退，再回退 `python3`。这不修改数据库表名、浏览器 storage/event 名等兼容标识。

平台分工已由用户确认：Linux/Python 使用 `dmserver`（SSH `dmserver-ts`），macOS/Swift 使用 Mac Studio `eva`。已定位在线 EVA Mac Studio，但现有 SSH 用户 osborn 认证被拒，尚未完成该主机验收；本批没有 Swift 代码，不添加虚构 macOS 通过记录。
