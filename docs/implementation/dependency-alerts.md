# 依赖告警记录：Dependabot #1

状态：**open；对应商用审阅 F14 仍 open。** 本记录不关闭或忽略告警，不证明当前系统无风险。

核查完成时间：**2026-10-22 08:24:55 UTC**。使用 Mac mini 已有正常 `gh` 认证进行只读 API 查询，并通过 npm 官方注册表读取版本元数据；没有提取凭据、更改权限、执行漏洞输入、安装/升级依赖或改变告警状态。

源码核查对象：OS EGP `b6cb84933672848ff5d1bd6b2832647374506e4a`。该提交当时已冻结作为 Linux 三轮回归候选；本文为独立文档增补，不改变该候选运行源码。仓库为私有开发状态，当前任务没有生产部署。

## 已确认的公告与版本

| 字段 | 核查结果 |
|---|---|
| 仓库告警 | [osborn-studio/os-egp Dependabot #1](https://github.com/osborn-studio/os-egp/security/dependabot/1)，`state=open` |
| GitHub 公告 | [GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm) |
| CVE | CVE-2026-93687 |
| 包与范围 | npm `braces`，受影响范围 `<= 3.0.3` |
| 严重度 | high；公告 CVSS v3 为 7.5、v4 为 8.7 |
| 当前锁定版本 | `braces 3.0.3`，传递依赖，`scope=development`，锁文件 `dev:true` |
| 首个修复版本 | 公告 API 与仓库告警 API 均返回 **`first_patched_version: null`** |
| 公告状态 | `withdrawn_at: null`；更新时间 `2026-10-02T22:36:34Z` |
| 最新发布 | npm 官方注册表 `braces` 的 `version/latest` 仍为 **3.0.3**；上游最新列出的标签也是 3.0.3 |

因此，核查时没有可直接升级的已发布修复版本。不能编造 `3.0.4`、盲加 override，或声称运行一次自动修复命令即可消除此告警。

主来源：

- [GitHub Advisory REST 数据](https://api.github.com/advisories/GHSA-vfj7-8cjw-p6xm)。
- [私有仓库告警 REST 地址](https://api.github.com/repos/osborn-studio/os-egp/dependabot/alerts/1)（需要相应仓库权限）。
- [npm 官方注册表 braces 元数据](https://registry.npmjs.org/braces)；本次执行的是只读 `npm view braces version --registry=https://registry.npmjs.org`，不是安装。
- [上游议题 #70](https://github.com/micromatch/braces/issues/70)，核查时仍 open。
- 上游 3.0.3 标签对应提交 [`74b2db2938fad48a2ea54a9c8bf27a37a62c350d`](https://github.com/micromatch/braces/tree/74b2db2938fad48a2ea54a9c8bf27a37a62c350d)。

## 固定源码证据与依赖路径

[package-lock.json:1655–1666](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/package-lock.json#L1655-L1666) 锁定 `braces 3.0.3`，来源 tarball 为既有 npmmirror 镜像，包含 integrity，`dev:true`。本次没有替换镜像或重新生成锁文件。

锁文件中确认的引入路径：

1. `tailwindcss 3.4.19 → chokidar 3.6.0 → braces 3.0.3`。证据：[Tailwind 依赖](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/package-lock.json#L4489-L4517)、[chokidar 依赖](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/package-lock.json#L1831-L1845)。
2. `tailwindcss 3.4.19 → micromatch 4.0.8 → braces 3.0.3`。证据：[micromatch 依赖](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/package-lock.json#L3204-L3216)。
3. `tailwindcss 3.4.19 → fast-glob 3.3.3 → micromatch 4.0.8 → braces 3.0.3`。证据：[fast-glob 依赖](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/package-lock.json#L2520-L2535)。

构建入口：PostCSS 配置[加载 Tailwind](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/postcss.config.js#L1-L6)；Tailwind 的扫描模式来自[固定源码配置](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/tailwind.config.js#L23-L25)，即 `./index.html` 与 `./src/**/*.{ts,tsx}`。

## 安装暴露与实际可达性

公告描述深度嵌套的 brace 模式导致同步递归调用栈耗尽，未捕获时可能终止 Node 进程。相关上游代码为 [compile 的递归遍历](https://github.com/micromatch/braces/blob/74b2db2938fad48a2ea54a9c8bf27a37a62c350d/lib/compile.js#L49-L53)、[expand 的递归遍历](https://github.com/micromatch/braces/blob/74b2db2938fad48a2ea54a9c8bf27a37a62c350d/lib/expand.js#L102-L105)、[parse 的字符长度限制](https://github.com/micromatch/braces/blob/74b2db2938fad48a2ea54a9c8bf27a37a62c350d/lib/parse.js#L38-L40)。本次没有执行复现载荷。

对 `server/`、`src/` 及开发/构建入口的静态检索未发现业务服务器直接加载上述 glob 构建依赖链，也未找到将 HTTP 请求输入传给 braces 的路径。当前固定 Tailwind 扫描模式没有显示由终端用户控制。这一结论是**静态未证实服务端请求可达**，不是完整依赖调用图验证，不等于无风险或可关闭告警。

同时存在明确的部署制品风险：[Dockerfile:10](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/Dockerfile#L10) 安装完整依赖，[Dockerfile:28](https://github.com/osborn-studio/os-egp/blob/b6cb84933672848ff5d1bd6b2832647374506e4a/Dockerfile#L28) 将完整 `node_modules` 复制到运行镜像，未裁剪开发依赖。按该构建定义产出的镜像会携带此包；本次没有构建镜像验证，也没有把“包在镜像里”表述成“公网 API 已被证明可利用”。

上游一位项目 MEMBER 在[讨论回复](https://github.com/micromatch/braces/issues/70#issuecomment-5995348316)中质疑实际威胁模型，并强调限制输入长度及避免接受不受信任 glob。该争议不改变 GitHub 公告当前未撤回、告警仍 open、没有首个修复版本的事实。

## 后续独立整改与验收

1. **先缩小运行制品。** 后续单独 PR 在前端构建完成后裁剪开发依赖，或以独立阶段安装生产依赖，再复制运行镜像。候选改法包括构建后 `npm prune --omit=dev --ignore-scripts`，但不能只凭命令成功作验收。须在最终 Linux 镜像检查依赖树及文件，确认无 braces/chokidar/micromatch/tailwindcss，并验证原生 SQLite、启动、登录与核心业务正常。当前冻结候选不做此改动。
2. **保留构建防线。** 只在隔离构建账户处理已审阅代码与固定模式，限制资源及执行时间，不增加用户自定义 glob 接口。该措施不消除开发依赖锁文件告警。
3. **另评估彻底移除路径。** 如需清除依赖树中的该包，单独评估构建工具升级/迁移或受维护的兼容替代，完成 CSS、配置、开发监听与生产构建回归。没有证据表明当前可做无兼容影响的补丁升级。
4. **持续跟踪而非自动豁免。** 待上游发布修复版本，核实实际修复提交、支持范围与锁文件结果，再独立更新。当前不关闭、不 dismiss、不虚称安全告警清零。

F14 后续关闭还包含运行镜像最小化、非 root、镜像摘要固定、供应链清单等原有要求；本条告警记录不替代这些工作，也不证明系统具备生产部署能力。

## 2026-10-23 依赖刷新（Z11）复核

- **braces 链仍未修复。** npm 官方注册表 `braces` 最新版仍为 3.0.3（无首个修复版本）；`tailwindcss` 3.x 最新为 3.4.19（即当前锁定版本），其 `chokidar 3.6.0` 与 `micromatch 4.0.8` 仍依赖 `braces ^3.0.3`。无 Tailwind 3.4.x 补丁或可用的 `overrides` 目标版本；不为该包添加 override（没有可指向的已修复版本，强行覆盖到不存在的版本或到 braces 2.x/4.x 属于遮蔽而非修复，且 2.x 有更多旧公告）。升到 Tailwind 4 属大版本迁移，不在本次范围。因此维持"开发期传递依赖、告警 open"的状态，`tests/dockerfile-policy.test.mjs` 仍断言该链为 devDependency-only 且不进入运行时安装。
- **补丁/次版本刷新**（`npm update`，不升大版本；`package.json` 的范围与精确固定均未放宽；锁文件 resolved 仍为既有 npmmirror 地址）：生产：`body-parser` 1.20.8→1.20.9、`on-finished` 2.4.1→2.4.2、`qs` 6.16.0→6.16.1、`node-abi` 3.98.0→3.100.0；开发：`rollup` 及全部平台包 4.64.6→4.65.0、`postcss` 8.5.30→8.5.31、`browserslist` 4.29.3→4.29.4、`caniuse-lite` 1.0.30001816→1.0.30001819、`electron-to-chromium` 1.5.455→1.5.463、`baseline-browser-mapping` 2.11.28→2.11.31、`node-releases` 2.0.58→2.0.60、`fast-equals` 5.4.4→5.4.5、`lilconfig` 3.1.3→3.1.4。精确固定 `playwright` 1.64.0→1.64.1（同一次版本内补丁，仅开发/浏览器测试用，随 `playwright-core` 同升）；`vite 6.4.5`、`react-router-dom 7.18.4`、`fflate 0.8.3`、`postcss-selector-parser 7.1.7` override 保持不动（vite/fflate/react-router-dom 在其次版本内无更新）。
- 其余可用的更新均为大版本（express 5、react 19、tailwind 4、vite 8、zod 4、recharts 3 等），按约束未升。
- `npm audit --omit=dev`：0 个漏洞（官方注册表）。`THIRD_PARTY_NOTICES.md` 与 SBOM（170 组件）已重新生成，`--check` 通过。此记录不关闭告警、不证明无风险。
