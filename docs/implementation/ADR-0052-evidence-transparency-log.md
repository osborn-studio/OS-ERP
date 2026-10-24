# ADR-0052：发行证据透明日志与 CI 签名口径（AC6）

状态：开发实现，尚非产品上线验收｜相关：ADR-0047（证据签名）、Z5/AA7（发行候选）、`docs/release/README.md`、roadmap-v8 AC6

## 背景

ADR-0047 的签名没有时间戳也没有公开记录：持钥者之外无法知道"某个候选何时、由谁、以什么证据哈希被签发过"，托管 CI 又没有私钥，CI 产出的候选一直是未签名的，而 `verify-release` 对未签名候选只是安静通过。

## 决定

### 1. 追加式哈希链日志
- `docs/release/EVIDENCE-LOG.jsonl`，一行一个候选：`{schema:1, name, evidence_sha256, signature, built_by, timestamp, prev}`。
- `evidence_sha256` = 规范化 EVIDENCE.json（ADR-0047 规范化 v1，与签名相同的字节）的 sha256；`signature` = `EVIDENCE.sig` 文本（去首尾空白）的 sha256 或 `null`；`prev` = 上一行原文（不含换行）的 sha256，首行为常量 `sha256("OS-ERP EVIDENCE-LOG v1 genesis")`。
- 行必须等于自身解析结果的规范化 JSON（拒绝缩进、键序、CRLF、多余空白）；字段集合固定；不允许空行；文件以单个换行结尾；名称唯一；时间戳为规范 UTC ISO 且不倒退；`hosted-ci` 条目不得带签名。
- `release-candidate --log[=<file>]`：构建**前**校验链并拒绝同名候选（链坏则失败，**不自动修复**）；证据自验通过后才追加；追加失败则删除本次产物。追加会改动被跟踪文件，下次构建前须先提交。
- `verify-release --evidence=… --log[=<file>]`：链完整、本候选在日志中、`evidence_sha256`/签名摘要/`built_by` 与手上的证据一致。`--log` 必须配 `--evidence`。

### 2. built_by 与 CI 口径
- `GITHUB_ACTIONS=true` ⇒ `hosted-ci`，并拒绝 `GML_RELEASE_SIGN_KEY`（托管 CI 不持钥）；签名构建 ⇒ `key-holder`；其余 ⇒ `local`。`built_by` 写入证据（因此被签名覆盖）和日志。它是构建进程自述，不是认证。
- 当前 `ci.yml` 不构建候选；该口径是为将来 CI 构建候选预先定下的契约，并由测试（环境变量模拟）固定。

### 3. 未签名候选不再静默
- `verify-release --evidence` 对 `signature: null` 向 stderr 输出醒目的 `WARNING: UNSIGNED CANDIDATE` 横幅，退出码不变。
- `--require-signature`（必须同时给 `--pubkey`）：未签名失败；给了公钥时沿用 ADR-0047 的验签与防降级。
- 正式发行必须由持钥者在受控机器上对同一提交重建并重签（README）；托管 CI 候选只是开发候选。

## 诚实边界

- 哈希链只发现中间改动；**截掉最新几行**、或**整份文件被另一条有效链替换**不会被链本身发现，靠 git 历史与带外保存链尾哈希。单行日志的唯一一行被改写后仍自洽（与证据比对才会发现，`verify-release --log` 会比对）。
- `timestamp` 是构建者自述，不是时间戳权威；没有第三方锚定。
- 日志不证明证据为真，也不替代 ADR-0047 的签名。

## 后果

- 新文件：`scripts/lib/evidence-log.mjs`；`release-candidate.mjs`、`verify-release.mjs`、`gen-changelog.mjs`（第十一批 46–49、第十二批 50–64）、`docs/release/README.md`、`tests/release-signing.test.mjs` 扩展。

## 审计记录

（Codex 审计结果见下）
