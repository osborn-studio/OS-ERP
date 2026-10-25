# 依赖安全记录：braces 链（无官方修复）

记录日期：2026-10-23。基线：`batch-ten`（`package.json` 版本 0.2.0-alpha.1）。对应路线图 v7 的 AB12。面向交付与运维人员；面向客户的口径见 `docs/本地交付/06_依赖安全说明.md`（网页版 `/docs/security.html`）。

**2026-10-24 更新（AC10）**：GHSA-vfj7-8cjw-p6xm 已被 GitHub **撤回**（Withdrawn Advisory，理由：不是实际可利用的漏洞），见第 8 节。下文第 1–7 节是撤回前的历史评估，保留作记录；"保留告警"的表述不再适用。

本文最初只记录**一条**无官方修复的公告及其影响评估，不替代完整安全测评。评估是对当前代码路径的判断，不是"漏洞已修复"的结论。

## 1. 公告

| 项目 | 内容 |
|---|---|
| 依赖 | `braces` 3.0.3（锁文件当前版本） |
| 公告 | GHSA-vfj7-8cjw-p6xm，CVE-2026-93687（编号摘自 `06_依赖安全说明.md` 对 GitHub 公告的转述，本次未重新联网核对） |
| 性质 | 特制的深层嵌套花括号模式可能耗尽调用栈，使 Node 进程退出：拒绝服务 |
| 官方修复 | 公告标注受影响范围含 3.0.3 及以下，修复版本为 None |
| 本仓库处理 | 保留 GitHub 告警，不标记"误报"或"已解决"；`scripts/test-dependency-security.mjs` 的文件头注释明确保留"braces 无官方修复"这一事实（该脚本本身不断言 braces 版本号） |

## 2. 依赖链（取自 `package-lock.json`）

命令（在仓库根目录，Node 22）：

```bash
npm ls braces --all --package-lock-only          # 全部依赖
npm ls braces --all --package-lock-only --omit=dev   # 仅运行依赖
```

必须带 `--package-lock-only`：不带时 `npm ls` 读的是 `node_modules`，在 `node_modules` 为符号链接或未安装的检出里会得到"extraneous"之类的误导结果（本次在工作树里就遇到了，因此以锁文件为准）。

全部依赖的输出：

```
os-erp@0.2.0-alpha.1
`-- tailwindcss@3.4.19
  +-- chokidar@3.6.0
  | `-- braces@3.0.3
  `-- micromatch@4.0.8
    `-- braces@3.0.3 deduped
```

仅运行依赖（`--omit=dev`）的输出：`(empty)`，即运行依赖树里**没有** braces。

锁文件中直接依赖 braces 或把它带进来的条目（逐项读取 `package-lock.json` 的 `packages` 得到）：

| 包 | 版本 | 依赖 | 锁文件 `dev` 标记 |
|---|---|---|---|
| `braces` | 3.0.3 | 仅 `fill-range ^7.1.1`（与本公告无关的下游包） | `true` |
| `chokidar` | 3.6.0 | `braces ~3.0.2` | `true` |
| `micromatch` | 4.0.8 | `braces ^3.0.3` | `true` |
| `fast-glob` | 3.3.3 | `micromatch ^4.0.8` | `true` |
| `tailwindcss` | 3.4.19 | `micromatch`、`chokidar`、`fast-glob` | `true` |

唯一的入口是 `devDependencies` 里的 `tailwindcss`（`^3.4.15`，锁定 3.4.19）。`dependencies` 中的运行依赖（bcryptjs、better-sqlite3、cors、dayjs、express、jsonwebtoken、nanoid；AD7 之前还有未使用的 zod，已移除，见第 9 节）都不依赖 braces、micromatch、chokidar 或 fast-glob。

附：全依赖的 `npm audit` 会把 braces 及 chokidar、fast-glob、micromatch、tailwindcss 共 5 个包列为受影响，它们来自**同一条**公告，不是 5 个独立漏洞（`06_依赖安全说明.md` 第三节）。

## 3. 可达性：开发/构建，还是运行时

| 位置 | 是否包含 braces | 依据 |
|---|---|---|
| 服务端运行代码（`server/`、`scripts/`） | 否 | 对 `server/`、`scripts/`、`src/` 搜索 `braces`、`micromatch`、`chokidar`、`fast-glob`、`tailwindcss` 的 import/require：无命中 |
| 运行依赖树（`npm ci --omit=dev`） | 否 | 上节 `--omit=dev` 输出为空；`local-manage.mjs setup` 使用 `npm ci --omit=dev`（安装手册第四章） |
| Docker 运行镜像 | 否 | `Dockerfile` 的 `runtime-deps` 阶段是 `npm ci --omit=dev --ignore-scripts`，运行阶段只从该阶段复制 `node_modules` |
| 发行包的运行时 SBOM 与 `THIRD_PARTY_NOTICES.md` | 否 | `THIRD_PARTY_NOTICES.md` 中无 braces；这两者按"锁文件中非 dev 的包 加 被 `vite build` 打进前端的依赖闭包"生成，braces 不在其中 |
| 构建（`npm run build` = `vite build`） | **是** | `postcss.config.js` 启用 `tailwindcss`，构建时 Tailwind 按 `tailwind.config.js` 的 `content` 扫描源文件 |
| 开发服务器（`npm run dev`、`dev:web`） | **是** | 同一条 PostCSS/Tailwind 链；Tailwind 的文件监听用 chokidar |
| 已构建的 `dist/` 与浏览器包 | 否 | 构建产物是静态资源，不含构建工具 |

结论：braces 只在**开发机和构建环境**可达，不在客户的运行进程里。

## 4. 影响评估

- **攻击面**：该缺陷需要攻击者控制传给 braces 的**花括号模式字符串**。本仓库里模式来自 `tailwind.config.js` 的 `content: ['./index.html', './src/**/*.{ts,tsx}']`（由维护者控制的源码文件）和 Tailwind 内部对源码中类名的扫描；业务 API、表单、上传内容、MCP 工具参数都不会被送进这条链。
- **后果**：最坏是执行构建或开发服务器的 Node 进程崩溃（拒绝服务），无数据泄露、无代码执行；不影响线上服务的可用性，因为线上进程不加载它。
- **前置条件**：攻击者要能改动被构建的源码或构建配置——这已经等同于对构建环境有写权限，风险主要是供应链与构建机权限问题，而不是这条公告本身。
- **风险判断**：对客户运行实例，**当前代码路径下未发现可达**；对开发/CI 构建，**低**（输入可信，后果限于构建失败）。这是对本次检出的判断，会随代码变化失效。

## 5. 暂行限制（继续有效）

- 不把开发服务器暴露到公网，`npm run dev` 不作为客户运行方式（Vite 开发服务器显式监听 127.0.0.1）。
- 不把用户上传内容、业务字段或外部传入字符串拼进 Tailwind 的文件匹配模式或 `content` 配置。
- 只在可信源码目录构建，不监听未知来源或外部人员可写的目录。
- 客户安装只用已构建 `dist/` 加 `npm ci --omit=dev`；Docker 只用多阶段镜像。
- 不用升级到有变动风险的 Tailwind 主版本来"消除告警"：这会影响全站生成样式，需单独安排界面回归。

## 6. 何时重新评估

- 上游发布 braces 的修复版本，或 Tailwind/micromatch/chokidar 发布不再依赖受影响 braces 范围的版本：升级后重跑 `npm ls braces --all --package-lock-only`、`node scripts/test-dependency-security.mjs`，并更新本文与 `06_依赖安全说明.md`。
- 任何代码开始在运行时 import `braces`、`micromatch`、`fast-glob`、`chokidar` 或 `tailwindcss`，或把外部输入送入 glob/花括号展开：本评估立即失效，需重新评估并优先处理。
- 运行依赖树出现 braces（`--omit=dev` 输出不再为空）：同上。
- 改变构建方式（例如在客户机器上构建样式）。

## 7. 本次未验证

- **公告状态可能已变**：本文写作后的代码评审（Codex）报告 GitHub 已在 2026-10-23 撤回该公告并称其不具实际可利用性；本次**没有**联网独立核实。有网络时请打开公告页确认当前状态；若确已撤回，应同步修改本文与 `06_依赖安全说明.md` 中"保留告警"的表述。第 3、4 节的可达性结论来自本仓库的锁文件与代码，不依赖公告状态。
- 本次没有联网运行 `npm audit`，也没有核对 GitHub 上该告警的当前状态；公告编号、受影响范围与"无修复版本"均沿用 `06_依赖安全说明.md` 的记录，需在有网络时复核。
- 没有对该公告做利用复现；"后果限于进程崩溃"来自公告描述，不是本地实测。
- 没有检查 Windows、Linux 构建环境的差异。

## 8. 复核结果（AC10，2026-10-24）

- **公告状态（已联网核对）**：`gh api /advisories/GHSA-vfj7-8cjw-p6xm` 返回标题 `Withdrawn Advisory: braces vulnerable to stack-exhaustion denial of service through deeply nested patterns`，正文称因"不是实际可利用的漏洞"而撤回，链接仅为保留外部引用。CVE-2026-93687 仍存在于 NVD 引用中，但 GitHub 公告库已不再把它当作告警。
- **`npm audit` 实测**（官方 registry：`npm audit --json --registry=https://registry.npmjs.org`；仓库 `.npmrc` 指向的镜像不实现审计接口，会返回 404）：全依赖审计里**不再出现** braces、chokidar、fast-glob、micromatch、tailwindcss；唯一条目是运行依赖 `zod`（GHSA-mrhx-c7xc-m3w5，high）。
- **是否消除旧 braces 链**：**不做**。公告已撤回，`npm overrides` 或升级 tailwind/chokidar/micromatch 不再有收益，却会改动 `package-lock.json` 并带来样式回归风险；braces 3.0.3 仍是 devDependency 链上的普通包。第 5 节中与"消除告警"相关的限制可放宽，但"不把外部输入拼进构建 glob"仍是良好做法。
- **新发现的 zod 告警**：`zod` 3.25.76 在 `package.json` 声明，但仓库内没有任何文件 import 它（`git grep -i zod` 仅命中 `package.json` 与 `server/lib/xlsx.js` 的一行注释），因此该公告所述的数组校验内存耗尽当前不可达。修复版本是 4.x 主版本。处置：登记到 `docs/security/audit-allowlist.json`，到期日 2026-12-15；后续应移除未使用的依赖（会同步改变运行依赖清单、SBOM 与 THIRD_PARTY_NOTICES.md，需单独安排）。
- **CI 门禁**：`ci.yml` checks job 的 `node scripts/check-audit-allowlist.mjs` 运行 `npm audit --omit=dev --audit-level=high --json`，每条 high/critical 公告必须在白名单里且有 `reason`、未过期的 `expires`（不超过 180 天）；审计接口出错、输出异常、白名单格式不合法都判失败。白名单是限期豁免，不是"已修复"。该步骤需要访问 npm 官方 registry。
- 未验证：本机没有重跑 CI 上的该步骤；没有对 zod 做利用复现。

## 9. 移除未使用的 zod（AD7，2026-10-24）

- **确认无引用**：`git grep -i zod` 在移除前只命中 `package.json`、锁文件、`THIRD_PARTY_NOTICES.md`、`server/lib/xlsx.js` 的一行注释、测试夹具与文档；没有任何 `import`/`require`，构建与脚本也不引用。
- **改动**：从 `package.json` 的 `dependencies` 删除 `zod`；`package-lock.json` 仅删去根包声明与 `node_modules/zod` 条目（无其他包变化，没有升级任何依赖）；重新生成 `THIRD_PARTY_NOTICES.md`；`docs/security/audit-allowlist.json` 的 `allow` 清空为 `[]`，GHSA-mrhx-c7xc-m3w5 不再需要豁免；运行时依赖清单现为 7 个。`release/sbom.cdx.json` 在打包时由锁文件现场生成，仓库内没有提交的 SBOM 文件。
- （AG7 之后 `.npmrc` 已改回官方 registry，见第 11 节；本条为 AD7 当时状态。）
- 第 8 节中关于 zod 白名单的描述保留为历史记录，已被本节取代。

## 10. 依赖复查节奏与开发依赖审计（AE7，2026-10-24）

**两道审计，范围不同**

| 模式 | 命令 | 门槛 | 白名单段 | 何时跑 |
|---|---|---|---|---|
| 运行依赖（默认） | `node scripts/check-audit-allowlist.mjs` | high 及以上 | `allow` | 每次 CI 的 checks job |
| 开发依赖 | `node scripts/check-audit-allowlist.mjs --include-dev` | 仅 critical | `dev` | `dependency-review` job（AH7 起：每个 PR、push 到 main 与手动 `workflow_dispatch`），本地可随时跑 |

- 两段白名单互不通用：`allow` 里的条目不能豁免开发模式，`dev` 里的条目也不能豁免运行模式。条目格式相同（`advisory` GHSA 编号、`reason` 至少 20 字符、`expires` 晚于今天且不超过 180 天）；`dev` 段缺失或不是数组时，开发模式失败（失败即关闭）。
- 开发依赖只以 critical 为门槛：它们不进客户运行进程、不进发行包，high 级公告只会出现在审计输出里，不挡 CI。这是策略选择，不是"开发依赖安全"的结论。
- 审计需要访问 npm 官方 registry（仓库 `.npmrc` 的镜像不实现审计接口，脚本已显式覆盖）。

**复查节奏**

- 每月手动触发一次 CI 的 `dependency-review`（Actions 页面 Run workflow，选 `main`）。两种模式都会运行，任一失败则 job 失败，但摘要无论成败都会上传。
- 白名单条目到期即失败：到期前要么确认仍无修复并重写 `reason` 后续期（最长再给 180 天），要么升级或移除依赖并删除条目。"白名单里已不再出现的公告"会被提示，应顺手删除。
- 发现 critical 时先判断可达性（同第 3、4 节的方法：依赖链、入口、输入是否可信），再决定升级、替换或限期豁免；豁免必须写清真实理由，不能只写"开发依赖"。

**怎么读摘要**

artifact 名 `os-erp-dependency-review-<run id>-<attempt>`，保留 30 天，含两个文件：`audit-runtime.json`、`audit-dev.json`。字段：

- `mode`（`runtime`/`dev`）、`threshold`（`high`/`critical`）
- `ok`：该模式是否通过
- `failures`：未登记的公告、已过期或格式错误的条目、审计接口出错等，每条一句话；`ok` 为 false 时才非空
- `covered`：被白名单豁免的公告及其 `expires`
- `unused`：白名单里有、审计里已没有的条目（应删除）

`failures` 里出现 `audit unusable` 或 `cannot obtain audit output` 说明没有拿到审计结果（网络、registry），不是"没有漏洞"。

**首次本地运行（2026-10-24，Node 22，官方 registry）**

- `npm audit --json`（全部依赖）：info/low/moderate/high/critical 均为 0，总计 0；开发模式与运行模式都通过，`dev` 与 `allow` 段均为空。因此当前没有需要豁免的 critical 开发依赖，也没有登记任何条目。
- 未验证：`dependency-review` job 尚未在 GitHub 上运行；公告库随时间变化，结果只对该时刻有效。

## 11. 锁文件统一到 npmjs 官方 registry（AG7，2026-10-24）

**决定：方案 (a)，`.npmrc` 改为 `registry=https://registry.npmjs.org`，`package-lock.json` 的所有 `resolved` 指向 `registry.npmjs.org`。**

背景：此前 `.npmrc` 指向 `registry.npmmirror.com`，锁文件 377 条 `resolved` 里 341 条来自镜像、36 条来自 npmjs（平台二进制包等）。镜像没有审计/签名接口，AF7 的 `npm audit signatures` 步骤因此只能（大概率）覆盖 npmjs 的条目。

**为什么选 (a) 而不是 (b)（CI 里对临时锁文件重新解析）**

| 指标（本机 Mac mini，Node 22 / npm 10.9.4，冷缓存 `npm ci --ignore-scripts`） | npmmirror（改前锁文件） | npmjs（改后锁文件） |
|---|---|---|
| 安装 327 个包 | 12.3 s | 12.1 s |
| `resolved` 主机分布 | npmmirror 341 / npmjs 36 | npmjs 377 |
| `npm audit signatures` | 此前约 42 个，镜像条目大概率未覆盖 | 审计 327 个，327 个签名已验证，58 个有 attestation |

安装时间与可达性在本机没有差异（官方 registry 响应约 0.7 s），因此没有理由为保留镜像而维护 (b) 的第二条解析路径（(b) 核验的是重新解析出的版本，而不是实际安装的锁文件）。如果将来某个环境无法访问 npmjs，可在本地用 `--allow <host>` 放行镜像做开发，但 CI 与候选构建必须保持官方源。

**改动范围（可审阅）**

- `.npmrc`：一行。
- `package-lock.json`：341 行 `resolved` 的主机从 `registry.npmmirror.com` 换成 `registry.npmjs.org`，**只改这一个字段**：版本、`integrity`、依赖树不变（改前改后的 diff 把主机名归一化后逐行相同；其余 0 行变化）。之后 `npm install --package-lock-only` 无进一步变化。`npm ci` 会按 `integrity` 校验 tarball，所以官方源与镜像内容一致已被实测确认。
- `scripts/check-lock-registry.mjs`（新）：统计各主机的 `resolved` 条目数并打印；主机不在白名单（默认只有 `registry.npmjs.org`）、非 https、带用户信息、缺 `integrity`、没有 `resolved` 且不是 link、锁文件无法解析或为空，一律退出码 1。`--allow <host>` 只用于本地镜像，主机必须是纯主机名（不接受通配符、协议、路径）；`--summary <file>` 写 JSON。用法：`node scripts/check-lock-registry.mjs`。
- `.github/workflows/release-candidate.yml`：candidate job 在 AF7 两步之后增加一步 `Lock registry guard`，对仓库锁文件和候选包内的 `package-lock.json` 各跑一次，不带 `--allow`。
- 单元测试：`tests/check-lock-registry.test.mjs`（固定夹具，含真实锁文件的一条断言）。

**验证记录（本机）**：`npm ci` + `npm rebuild better-sqlite3 esbuild`、`npm run build`、`npx tsc --noEmit` 通过；`gen-third-party-notices --check` 无漂移；`check-audit-allowlist` 运行与开发两种模式都通过；守卫对真实锁文件输出 `377 registry.npmjs.org`。

**未验证 / 注意**

- 没有在 GitHub 托管 runner 上跑；`ci.yml` 的 `npm ci` 现在也走官方源（托管 runner 本来就能访问）。
- `docs/audit/evidence/dependency-lock-inventory.csv` 与更早章节里的 npmmirror 字样是历史记录，没有改写。
- AF7 的 `release-candidate.yml` 注释和 `audit-signatures.txt` 的 echo 行仍写着"npmmirror 没有签名接口"，这描述的是改前状态，保留是因为 `tests/candidate-supply-chain-policy.test.mjs` 断言了它们；后续可以连同测试一起清理。
- 守卫只检查 `resolved` 主机，不替代 `npm ci` 的 integrity 校验，也不防止 `package.json` 里使用 git/tarball URL 依赖（这类 `resolved` 会因主机不在白名单而被拒绝）。

## 12. 签名核验进 PR 门禁、zip 解压硬上限、大陆安装路径（AH7，2026-10-24）

**1. `ci.yml` 的 `dependency-review` job 对 `ci.yml` 的每个事件都运行（PR、push 到 main、手动触发；不带 job 级 `if`，所以可以设为 required check）**，只读令牌、无 secrets、`pull_request`（不是特权变体）。步骤顺序：

1. `node scripts/check-lock-registry.mjs`（离线；锁文件每个 `resolved` 必须是 `registry.npmjs.org`，不传 `--allow`）；
2. `npm ci --ignore-scripts --no-audit --no-fund`（不运行任何生命周期脚本）；
3. `node scripts/check-install-registry.mjs`（见下）；
4. `npm audit signatures --registry=https://registry.npmjs.org`；
5. 原有的运行 / 开发两种 `check-audit-allowlist`（`if: ${{ !cancelled() }}`：前面的门禁失败时仍会跑并上传摘要，job 仍以失败收尾）。

**`npm audit signatures` 到底证明什么（读了 npm 10.9.4 的 `lib/utils/verify-signatures.js`）**：它对每个已安装包的 `name@version` 向 registry 取清单，用 registry 公钥验证 registry 给出的签名（以及可用时的 provenance attestation）。它**不**比较“registry 的 integrity”与“锁文件里的 integrity”，也不读已安装 tarball 的字节。所以：

- 保证：registry 对这个 `name@version` 的元数据没有被篡改（需能访问 npmjs 与其密钥）。
- 不保证：锁文件里的 integrity 就是 registry 签名的那个值；已安装文件与签名有关。这两条的链接靠 `npm ci` 按**锁文件** integrity 校验 tarball，加上锁文件在 PR 评审中可见——没有机器检查把“锁文件 integrity == registry 签名的 integrity”这一步自动化（未做）。
- 没有签名端点的 registry（镜像）上，它要么报“缺少签名”要么跳过，结果不能当作镜像内容可信的证据；因此命令固定指向 npmjs。
- 没有 attestation 的包（多数包）只有 registry 签名，没有 provenance。

**2. `verify-release` 的 zip 安全解压（`--extract-to=<空目录> --artifact=<RC-*.zip>`）。** 实现在 `scripts/lib/zip-safe.mjs`，zip 视为不可信数据：先只读中央目录，在解压任何字节前检查条目数与声明大小；解压时用 `zlib.inflateRawSync(maxOutputLength)` 限制**实际**输出（声明大小可以说谎，已用手工改写中央目录的 zip 炸弹测试），并核对 CRC32 与声明大小。默认上限与参数：

| 上限 | 默认 | 参数 |
|---|---|---|
| 条目数 | 5000 | `--zip-max-entries` |
| 单文件解压字节 | 64 MiB | `--zip-max-file-bytes` |
| 总解压字节 | 512 MiB | `--zip-max-total-bytes` |
| zip 文件本身 | 256 MiB | `--zip-max-archive-bytes` |

另外一律拒绝：绝对路径（`/`、盘符）、反斜杠、`..` 与 `.` 段、NUL、重复条目（大小写不敏感）、Unix 符号链接与其他特殊文件类型、加密条目、zip64、分卷、除 stored / deflate 以外的压缩方式、非空目标目录。文件以 `wx` 创建、权限固定 0644（不沿用 zip 里的 setuid 位）。解压后要求 zip 内的 `MANIFEST.json` 与当前包的逐字节一致。默认值不是从真实候选包量出来的容量预算，只是保守的有限值；正式使用前应以候选包实际大小的数倍收紧。

**未覆盖**：`scripts/release-candidate.mjs` 内部的 `extractZip`（用 `fflate.unzipSync`，有路径越界检查但没有条目 / 字节上限，且没有符号链接判断）以及 `release-candidate.yml` 里的 `unzip -p … | head -c`（已有 32 MiB 上限）没有改动；前者属于后续工作。

**3. `scripts/check-install-registry.mjs`**：逐包比较 `node_modules/.package-lock.json`（npm 安装后写下的隐藏锁文件）与 `package-lock.json` 的 `version`、`resolved`、`integrity`，不同、多装了锁文件里没有的包、文件缺失或为空则失败。本机的共享 `node_modules` 是 AG7 之前用镜像装的，该脚本对它正确地报告了 `resolved` 不一致（`npm ci` 重装后才会通过）；在用本地回环 registry 装出来的最小项目上通过。

**大陆部署路径：`npm ci --registry <镜像>` 的真实行为（本机用回环 HTTP 镜像实测，npm 10.9.4）**

- npm 默认 `replace-registry-host=npmjs`：锁文件里 `registry.npmjs.org` 的 tarball 请求被改发到 `--registry` 指定的镜像（路径保持不变）。实测请求确实只到了镜像。
- **下载来源会变，隐藏锁文件不变**：安装后的 `node_modules/.package-lock.json` 仍写着 `registry.npmjs.org`。因此 `check-install-registry` **无法**看出字节来自哪台主机；它只证明 node_modules 是按这份锁文件装的。
- **integrity 仍按锁文件校验**：镜像返回内容不同的 tarball 时 `npm ci` 以 `EINTEGRITY` 失败（实测；npm 会先重试两次，约 1 分钟），没有留下 node_modules。保证来自 `npm ci` 对锁文件 `integrity` 的校验，前提是锁文件每个条目都有 integrity（`check-lock-registry` 检查）；`--registry` 本身不削弱它。
- **不保证**：镜像上的元数据 / 签名（`npm audit signatures` 要访问 npmjs 与其密钥，在大陆可能很慢或不可达）；镜像是否及时同步；`npm ci` 以外的命令（`npm install` 会重新解析并可能改写锁文件，不要在部署里用）；镜像对 `.npmrc` 里 `registry=` 的覆盖由命令行参数决定，不要把镜像写进仓库 `.npmrc`（`check-lock-registry` 守的是锁文件，不是 `.npmrc`）。
- 建议流程：在能访问 npmjs 的机器上跑 CI（已含签名核验）；大陆服务器上用 `npm ci --ignore-scripts --registry <镜像>`，装完跑 `node scripts/check-install-registry.mjs`。docs 里没有为镜像速度做任何评估（未测）。

**验证与未验证**：`tests/zip-safe.test.mjs`（17 条，现场生成的小 zip）、`tests/check-install-registry.test.mjs`（7 条）、`tests/dependency-review-policy.test.mjs`（10 条）；`dependency-review` 新步骤尚未在 GitHub 托管 runner 上运行过（本机没有触发 workflow）。

