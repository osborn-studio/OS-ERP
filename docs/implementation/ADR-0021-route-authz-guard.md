# ADR-0021 路由授权清单守卫

状态：已采纳（2026-10-23）。工作流：W2（roadmap-v2）。

## 背景

"哪些路由只过了登录（`requireAuth`）、没过任何权限/范围闸门"此前只能靠人读代码。ADR-0017 收口了 7 条采购读路由，
剩余详情路由仍只有 `requireAuth`，没有清单就无从排期，也无法防回退。

## 决定

新增静态守卫 `scripts/check-route-authz.mjs`（登记为 `check:route-authz`，进入 `regress-all`）：

1. 解析 `server/routes/*.js` 的 `r.<verb>(path, ...中间件, 处理器)`，计算每条路由的**有效链** =
   `server/index.js` 的挂载层中间件 + 路由器层 `r.use(...)`（位于该路由之前且前缀覆盖）+ 路由自身中间件；
   本地 `const gate = [...]` / `(label) => [...]` 数组与 `...gate` 展开会解析；子路由器（master → warehouses、inv-txn-types）继承父闸门。
2. 分类：GATED（链里有 `requirePerm/Role/Internal/GlobalData/Store/Dealer/Mall` 之一）、AUTH_ONLY、NO_AUTH。
3. AUTH_ONLY / NO_AUTH 必须在 `ALLOW` 登记并写理由；**双向校验**：登记了却已加闸门或已不存在，同样失败。
4. 条目有 kind（public / meta / self / handler-scope / gap）；`gap` 与带 `pending` 的条目在输出里单列
   （`pending=W1` 归属采购链收口 ADR-0020；`pending=unassigned` 尚无排期）。
5. `tests/route-authz-guard.test.mjs` 在临时副本（`OSERP_ROUTE_AUTHZ_ROOT`）上证明：注入裸 `requireAuth` / 无鉴权路由会红，
   挂载层/路由器层/展开数组闸门不误报，多挂载点逐个独立评估，不可解析注册会红，方法限定的行内中间件不误闸其它动词，过期登记会红。

## 解析器边界

只认行首字面量 `r.<verb>(`；`r.route()` 与非字面量路径计入"不可解析"并使守卫失败（须改成字面量写法）；`crudRouter({...})` 工厂产出的路由不逐条扫描，
只验证挂载点已被强闸门覆盖；中间件按名字识别、不执行，不验证权限码是否合适；处理器内的手写权限判断不可见
（此类路由登记为 `handler-scope`，**需人工复核，不等于没有缺口**）；行内箭头函数中间件视为不透明，仅按其源码中的
`require*` 名字、`req.method` 与 `req.path ===` 豁免做有限推断（ai.js 挂载层、approval.js 路由器层即此形态）。

## 后果

- 新增只有 `requireAuth` 的路由，CI 立即红，除非写出理由。
- 现状清单（见脚本 `ALLOW`）把真实缺口显式化：采购链详情读路由（W1）、`POST /api/docflow/no-issue`、`GET /api/auth/orgs`、
  POS 全部 `requireAuth`-only 路由、销售读接口与订货中心对内部账号的组织数据范围未落实、奇门网关缺省 app_key 放行，均标 `gap` 或 `pending`。
- 守卫只防回退与可见性，不替代各域的授权测试。
