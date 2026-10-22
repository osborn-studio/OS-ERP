# 商用整改跟踪

记录日期：2026-10-22。依据：[原审阅报告](../audit/GML_商用可行性源码审阅报告_2026-10-21.md)及[固定源码证据索引](../audit/证据索引.md)。

这是开发中的状态表；所有项目均未获得完整商业上线关闭结论。`partial` 表示已有针对性实现或正在集成的缩小暴露面措施，不代表原问题被全面解决。只有当前提交的代码、负向测试和对应产品验收齐全，主执行器才能更新为 closed。

| 编号 | 原严重度 | 当前状态 | 当前工作与仍需完成的验收 |
|---|---|---|---|
| F01 权属链 | P0 | open | 用户已授权本项目采用 MIT，根 LICENSE 和来源通知已加入；贡献者/复用/依赖资源准确授权和通知仍待核实。MIT 声明不消除第三方未决权属，旧仓库敏感对象仍私有；全新公开仓库不导入其历史。 |
| F02 商城演示登录 | P0 | partial | 生产商城服务端门禁已集成，并通过开发 HTTP 负向测试。关闭不等于实现短信验证；需真实 HTTP 确认固定验证码路径不可达及后台业务仍可用。 |
| F03 奇门模拟网关 | P0 | partial | 生产默认关闭模拟网关及未验收同步路径，已集成。必须验证未认证读取/模拟成功均被拒；真实签名、重放防护和客户范围暂未实现。 |
| F04 演示重建 | P0 | partial | 已有独立生产 boot、持久数据库模式、旧库/损坏库拒绝、底层重置和卫星 seed 保护。独立审查与运行隔离专项已完成；自愈迁移配置、副作用与恢复重启还需验收。 |
| F05 通知越权预览 | P1 | partial（第三批已实现） | 预览/推送/日志/总览统一要求内部角色 + `system:notify:*` 权限 + 全局数据范围，否则 403（`purchase_orders`/`approval_instances` 无 org_id，无法诚实按组织过滤，故选 403 而非空摘要）。负向测试覆盖门店/经销商/采购子树/销售角色。见 [ADR-0008](ADR-0008-notify-hardening.md)。待托管 CI 回归与最低权限角色产品验收。 |
| F06 密码/会话 | P1 | partial | 一次性管理员 bootstrap、生产 JWT 姿态、auth_version 撤销、改密/安全变更事务、持久登录节流和统一失败信息已集成；第二批 Linux 验收待完成，复审发现的表单契约及会话切换页面残留正在补齐。 |
| F07 MCP 委托授权 | P1 | partial（第三批已实现） | 有主 Token 视为所有者委托：每次调用重读所有者存在/启用/当前权限与数据范围并取交集；签发时记录所有者 `auth_version`，任何 ADR-0004 版本提升令旧 Token 永久失效；停用账号在同一事务吊销其全部 Token；仅接受 Bearer 头；写/危险工具的审计写入与业务同事务。迁移 053。见 [ADR-0011](ADR-0011-mcp-delegated-token-scope.md)。生产仍关闭 MCP；重新开放前需产品级验收。 |
| F08 Webhook 出站限制 | P1 | partial（第三批已实现） | `server/lib/outbound-url.js`：生产仅 https、拒绝回环/私网/链路本地/保留段（含 IPv4-mapped/NAT64/6to4）、逐 DNS 应答检查并固定已检查地址、不跟随重定向、总超时覆盖响应体、256KB 体积上限、可选 `GML_WEBHOOK_ALLOWED_HOSTS` 只能收窄。保存与发送两处执行。待真实 https 目标联调。 |
| F09 Token 日志/秘密存储 | P1 | partial（第三批已实现） | 启动日志不输出 Token（已核实）；通知渠道秘密以 AES-256-GCM（`enc:v1:` 前缀，密钥来自 `GML_SECRET_KEY` 或 JWT 密钥 HKDF 派生）落库，接口只返回 `has_secret`/`secret_last4`，旧明文读取兼容并在下次写入时升级；`GML_SECRET_KEY_PREVIOUS` 支持轮换。历史已进入日志的凭据处置仍需运维执行。 |
| F10 资金闭环 | P1 | open，拟限制暴露面 | 首版排除公共商城在线资金能力，生产已关闭相关入口。后台手工往来仍需凭证/复核/对账验收。 |
| F11 客户租户隔离 | P1 | open，范围限定 | 目标限定一企业一实例；行业库不是 SaaS 租户。独立密钥、目录、备份和实例部署还需实际安装验收。 |
| F12 备份升级恢复 | P1 | partial（第三批已实现） | `db-backup.mjs` 默认校验（integrity/foreign_key/表数/迁移数/烟雾查询）通过后才轮转，失败文件隔离为 `.db.failed` 并以非零退出；输出 JSON 报告；备份目录相对 `GML_DATA_DIR`。迁移运行器记录每个迁移的 sha256，生产模式校验不一致即拒绝启动（`MIGRATION_CHECKSUM_MISMATCH`），旧行可 `--adopt-checksums`。见 [ADR-0009](ADR-0009-backup-verification-and-migration-checksums.md)。第四批新增 `scripts/db-restore-drill.mjs`、`scripts/upgrade-rollback-drill.mjs` 与恢复手册（ADR-0016）；夹具规模 RTO 约 2 秒，生产规模与目标主机实测仍 open。 |
| F13 审计/错误泄露 | P1 | partial（第三批已实现） | 后台 JWT 不再接受 query 参数；`server/lib/redact.js` 统一脱敏（审计 detail、日志 URL）；生产 5xx 仅返回通用信息 + `incident_id`，完整错误按事件号记服务端日志；`auditStrict` 在事务内写审计，失败则业务回滚（设置、经销商授信/返利、账号安全变更已接入）。见 [ADR-0010](ADR-0010-audit-and-error-hygiene.md)。 |
| F14 供应链/容器 | P1 | partial（第三批已实现） | 多阶段 Dockerfile：运行镜像仅生产依赖、非 root（uid 10001）、基础镜像按摘要固定、HEALTHCHECK、只读根文件系统；compose 仅发布 127.0.0.1、具名数据卷、密钥只经环境变量。本机 Docker 实际构建并启动验证通过（arm64）。静态策略测试守住上述约束。braces 公告仍无修复，运行镜像不含该开发链。见 [ADR-0012](ADR-0012-container-and-version-contract.md)。第四批起托管 CI 构建 linux/amd64 镜像并跑 `docker-smoke.mjs`；目标主机未验。 |
| F15 可重复验收 | P1 | partial | dmserver 固定候选 9c 三轮源码回归各 113/113、合计 339 项通过；手动 Actions 配置已提交但未注册 runner/未触发。源码哈希证据与发行包验收分开，后者和实际 Actions 仍未完成。 |
| F16 API/版本契约 | P2 | partial（第三批已实现） | `server/version.js` 单一版本来源（package.json + `GML_BUILD_SHA`/发行 MANIFEST）供 `/api`、健康、AI manifest、MCP serverInfo 使用；商城取消返回持久化状态 `cancelled`；Vite 代理补 `/mcp`。 |

## 本批分工与合入验收条件

| 工作流 | 负责分支 | 本批交付 | 合入前最低条件 |
|---|---|---|---|
| 运行模式与安全默认 | codex/runtime | JWT 模式统一、卫星 seed/旧句柄绕过回归 | 生产默认安全矩阵、直接入口拒绝、模式标记与旧数据保护测试 |
| 生产能力边界 | codex/capabilities | 商城/奇门/模拟连接器/MCP 生产门禁 | 真实 HTTP 负向测试、demo/test 兼容和明确的错误码 |
| 首管理员初始化 | codex/bootstrap | 显式生产 CLI、事务化管理员/企业初始化 | 不泄露密码、重复/并发/失败回滚、实际登录与权限 |
| 基线故障定位 | codex/regression | Python 前置检查、旧回归故障诊断、所有专项接入 | Linux 环境命令、不得跳过失败断言、根执行器完整重跑 |
| CI 与交付状态 | codex/delivery | 手动 Linux 自托管工作流、平台/证据规则、本表 | 静态校验、runner 核实、Linux 实际执行后再记录通过 |
| 集成与独立复审 | 主执行器 | 按提交集成、完整验证、可审查 PR | 不丢失未完成项目，不以各路单测代替集成结果 |

这些分支名是本次协作分工，不是已经合并或测试通过的证据。Claude Code 尚未实际参与，不把同系统 subagent 的审查称为跨模型验收。

## 后续顺序

第一批集成和 Linux 三轮源码验证已完成；第二批实现已集成，正在独立复审整改和目标平台验证。接续 [第二批规格](next-batch.md)，优先解决 F05/F06/F08/F12/F13 的真实业务阻断；随后按 handoff 的采购—收货—库存—销售—退货—往来闭环逐条验收。权属调查并行推进。用户已授权改名、MIT 并选择全新公开仓库快照；Release、生产部署仍未授权。成本和完成时间需根据失败回归及业务样本更新，目前不承诺精确工期。

## 开发过程中新增确认的授信阻塞

以下不改变原 F01–F16 编号，均为后续 P1 商业上线阻塞；本批只修复正向发票回款的 SO 映射。

| 情况 | 固定证据 | 影响与验收要求 |
|---|---|---|
| 作废已确认收款 | [ar.js:729](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/server/lib/ar.js#L729) | AR 债务恢复但仅 OC 恢复占用，统一信用账本不恢复。须记录每笔释放的来源/金额，按原归属逆向，重复作废拒绝、部分核销/多票/故障回滚与账务对账通过。不可根据总金额猜恢复。 |
| 预收抵扣 | [ar.js:1202](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/server/lib/ar.js#L1202) | applyPrepay 只释放 OC，SO/SI 对应统一授信仍可滞留；需同一来源映射/逐笔归属台账、上限及逆向恢复规则，并覆盖跨客户拒绝。 |

这两项未通过生产业务闭环验收，不得因正向 A06 守卫已绿而关闭财务/授信风险。

第三批（2026-10-22）已按逐笔来源台账实现逆向：新增 `credit_release_ledger`（迁移 052）记录每次收款确认/预收抵扣释放的来源单据、客户与金额；作废收款按台账逐笔恢复统一授信与 OC 占用，重复作废、跨客户、超额恢复均拒绝，中途失败整体回滚。见 [ADR-0013](ADR-0013-credit-release-ledger.md)。迁移前已确认的收款无台账行，作废时只按旧路径恢复 OC 并标记 `legacy:true`。第四批已修：`credit.js` 写台账时同事务投影 `sales_orders.credit_hold`，`reconcileOrderHolds` 接入 test-quote-credit 与 verify-seed（ADR-0014）；`test-quote-credit` 两库全绿。
