# ADR-0047：发行候选证据 Ed25519 签名（AB4）

状态：开发实现，尚非产品上线验收｜相关：Z5/AA7（发行候选与证据校验）、ADR-0040 之后的发行流程、`docs/release/README.md`

## 背景

`EVIDENCE.json` 的 `produced` 结果只有一致性与包绑定校验：能同时改证据与包的人可以手改后声称"已跑"（AA7 Codex P1）。需要一个让**持有私钥的构建者**为证据背书、让接收方用**带外获得的公钥**确认"证据自签发后未被改动"的机制。

## 决定

### 1. 签什么、怎么签
- 对**整份**证据对象（含 `signature` 元数据）取规范化 JSON 字节做 Ed25519 签名（`node:crypto`，无新依赖）。
- 规范化 v1（`sorted-keys-no-whitespace-v1`）：各层对象键按 UTF-16 码元序、无空白、数组保序、字符串用 `JSON.stringify` 转义；只接受 null/布尔/有限数/字符串/数组/普通对象。`undefined`、`NaN`、`Infinity`、BigInt、函数、`Date`、带原型对象、稀疏数组一律抛错，不静默改写被签内容。验签先 `JSON.parse` 再规范化，所以缩进与键序不同的等价文件仍通过，任何值变化都失败。
- `signature` 字段：未签名为 `null`；已签名为 `{algorithm:'ed25519', canonicalization, key_id, sig_file:'EVIDENCE.sig'}`。因为元数据在被签内容里，不能保留旧签名而改 `key_id`，也不能把 `signature` 改成 `null`（降级）。`key_id` 为公钥 SPKI DER 的 sha256。
- `EVIDENCE.sig` 是 64 字节签名的 base64（严格格式：88 字符、`==` 结尾、可往返），写在 `EVIDENCE.json` 旁。它**不进入 zip**：证据含 zip 的哈希，放进 zip 会自指；"入包"指随候选目录（`RC-….evidence/`）一起分发。

### 2. 构建（`release-candidate.mjs`）
- `GML_RELEASE_SIGN_KEY` = Ed25519 PKCS#8 私钥 PEM 的绝对路径。未设置：`signature: null`，照常构建。
- 设置了但不可用（空值、文件缺失、非普通文件、不是 Ed25519、位于任何 git 工作树内、对组/其它可读）：**在构建之前**失败，不留产物，**不**退回未签名。
- 构建末尾用同一把钥派生的公钥自验一次（`verify-release --evidence --pubkey`），失败则删除本次产物。

### 3. 验证（`verify-release.mjs`）
- `--evidence=<file> --pubkey <pem>`（也接受 `--pubkey=<pem>`）：验签并校验 `key_id`。给了公钥而证据 `signature` 为 `null`/缺失 ⇒ 失败（防降级）；缺 `EVIDENCE.sig`、签名格式不对、换钥、改动内容 ⇒ 失败。`--pubkey` 不带 `--evidence` ⇒ 用法错误。公钥参数若是私钥 PEM 直接拒绝。
- 不给 `--pubkey`：其余校验不变；若证据已签名，输出"signature not verified"提示，不假装验过。
- `signature` 字段成为必有字段（`null` 或对象）。

### 4. 密钥生成与保管
- `scripts/release-keygen.mjs --out <绝对路径的新目录>`：目录 0700、私钥 0600（`O_EXCL` 独占创建）、公钥 0644；拒绝相对路径、本仓库或任何 git 工作树内（含符号链接绕入）、非空目录；失败不留文件；不打印私钥。
- 保管要求写在 `docs/release/README.md`：私钥只在签发机器上、不进仓库/CI 日志/共享盘；公钥带外分发（随候选一起放的公钥没有意义）；轮换与吊销靠更换公钥与 `key_id`，旧候选按旧公钥验证。

## 诚实边界

- 签名证明"持有私钥者在构建时批准了这份证据"，**不**证明内容为真：`operator-attested` 结果仍只是声明。
- 未签名候选与以前一样只有一致性校验；是否要求签名由接收方是否使用 `--pubkey` 决定。
- 本机私钥被盗即可伪造；没有 HSM/硬件令牌、没有透明日志、没有时间戳签名（`built_at` 在被签内容里，但它由签发者自述）。
- 托管 CI 不持有私钥，CI 构建的候选是未签名的。

## 后果

- 新文件：`scripts/lib/evidence-sign.mjs`、`scripts/release-keygen.mjs`、`tests/release-signing.test.mjs`；`release-candidate.mjs`、`verify-release.mjs` 扩展。
