# 依赖安全记录：braces 链（无官方修复）

记录日期：2026-10-23。基线：`batch-ten`（`package.json` 版本 0.2.0-alpha.1）。对应路线图 v7 的 AB12。面向交付与运维人员；面向客户的口径见 `docs/本地交付/06_依赖安全说明.md`（网页版 `/docs/security.html`）。

本文只记录**一条**未修复公告及其影响评估，不替代完整安全测评。评估是对当前代码路径的判断，不是"漏洞已修复"的结论。

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

唯一的入口是 `devDependencies` 里的 `tailwindcss`（`^3.4.15`，锁定 3.4.19）。`dependencies` 中的 8 个运行依赖（bcryptjs、better-sqlite3、cors、dayjs、express、jsonwebtoken、nanoid、zod）都不依赖 braces、micromatch、chokidar 或 fast-glob。

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
