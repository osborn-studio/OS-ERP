---
name: verify-os-erp
description: Drive the real OS ERP (osborn-studio/OS-ERP, 伴圆 AI 原生 ERP) from this checkout and prove behavior with evidence. The product is a React 18 + Vite SPA (src/, built to dist/) served by one Express 4 process (server/index.js) with per-industry SQLite databases (better-sqlite3) under GML_DATA_DIR, a REST API at /api/*, and a JSON-RPC MCP endpoint at /mcp. Use when you need to launch an isolated instance (own data dir, loopback port, JWT secret; demo seed or empty production DB with a bootstrapped admin), log in and click through 主数据/采购/存货/系统 pages like a user in headless Chrome, read back via API and SQLite, check audit_logs, exercise the MCP read-only client, and keep redacted proof after teardown — e.g. before a PR touching src/pages, server/routes, server/lib, seeds or MCP tools.
---

# Verify OS ERP (os-erp)

OS ERP 0.2.0-alpha (MIT, not production-ready; derived from `osborn-studio/gml`). Surfaces, in order of importance:

1. **Web UI (后台)** — `http://127.0.0.1:$PORT`. `/login` (pick 行业 `美妆连锁版`/`连锁餐饮版`, then 账号/密码), then a left sidebar (`<aside>`) of groups: 经营看板、AI 数据承接台、订货中心、主数据、采购管理、委外管理、计划与生产、质量管理、销售管理、财务应收、线上 OMS、营销管理、存货管理、线下门店、经销商管理（美妆/服装）、AI 与 MCP 控制台、系统管理 (admin) Menu table: `MENUS` in `src/components/Layout.tsx`; routes: `src/App.tsx`. Most list pages are `src/components/DataPage.tsx` (button `新增`, search placeholder `关键词搜索`, button `查询`, modal `新增<title>` with fields wrapped in `<label>`, button `保存`, toasts `已新增`/`已保存`/`已删除`).
2. **Other browser apps** — 门店 POS `/pos`, 商城 `/mall` (capability `public_mall`), docs `/docs/*.html`. Not mapped yet.
3. **REST API** — `/api/*` with `Authorization: Bearer <token>` from `POST /api/auth/login {username,password,industry}`; health `/api/meta/health` (reports `version`, `build_sha`); OpenAPI `/api/openapi.json`.
4. **MCP** — `POST /mcp` (JSON-RPC 2.0) with an Agent Token (`gml_…`, not the login JWT), driven by the repo's own `scripts/mcp-readonly-demo.mjs`.

Two runtime modes matter (`server/runtime.js`, ADR-0001):

- `demo` — on first boot `server/db/boot.js` seeds all three industry DBs (cosmetic/food/apparel) with fictitious data and the public demo users from `server/db/seed.js` (`admin`, `boss`, `scm`, `purchase`, `sales`, `warehouse`, `finance`, `store01..05`, `dealer01`, `viewer`). Use for business journeys.
- `production` (the product default) — empty schema, no demo users, MCP/mall/qimen gated off by `server/capabilities.js`. The first admin comes from `scripts/bootstrap-admin.mjs` (password on stdin). Use to prove first-run/boot/auth and capability gating.

Not covered (do not claim): Docker path (`docker-compose.yml`, `scripts/docker-smoke.mjs`), the release ZIP/installer (`scripts/test-local-delivery.mjs`, `install*.command`/`.bat`), Windows/macOS launchers, real payment/SMS/bank/IM/qimen/LLM connectors (need real third-party credentials — never invent them), the Python/openpyxl regression (`scripts/regress-isolated.mjs`, runs on dmserver per AGENTS.md).

**Hard rules.** Every run gets its own `GML_DATA_DIR`, port and secrets; never point this at someone's `data/` or a running `local-manage.mjs` instance on :3001, and never drive an instance you did not launch. Never write a password, JWT, JWT secret or `gml_` token into evidence or a PR (the helpers redact; don't bypass them with your own `tee`). Never debug the helper with `set -x`/`bash -x`: secrets pass through variables.

Helpers (executable, in `scripts/`):

- `scripts/verify-os-erp.sh` — `build | launch [demo|production] | doctor | env | ui | api | db | mcp | cleanup`, all keyed by `RUN_ID`.
- `scripts/erp-browser.mjs` — headless Chrome via the repo's `node_modules/playwright-core`; runs a JSON step list (`login`, `nav`, `click`, `fill`, `select`, `fillPlaceholder`, `waitText`, `expectUrl`, `expectText`, `selectIn`/`fillIn` (CSS, for unlabeled table cells), `shot`…; documented at the top of the file). Each `shot` writes PNG + innerText + ARIA snapshot, after scrubbing secrets from the DOM. Called by `ui`.
- `scripts/erp-login.mjs` — logs in via `POST /api/auth/login` and prints only the bearer token to a pipe. `scripts/redact.mjs` — the evidence scrubber.
- `journeys/*.json` — ready-made step lists referenced from `features/`: `products-create`, `purchase-receive`, `login-session`.

Set once per run (repo root):

```bash
export RUN_ID=verify-$(date +%Y%m%d-%H%M%S)   # unique => parallel runs never share data dir, port, or scratch
V=.cursor/skills/verify-os-erp/scripts/verify-os-erp.sh
```

Prerequisites: **Node 22** (`engines >=22.2 <23`; the helper picks `$OSERP_NODE`, then `node` on PATH, then `~/.local/node22/bin/node`, and refuses other majors), npm, Chrome/Chromium (`CHROME_BIN`, else Playwright's Chromium, else `/usr/bin/google-chrome`), `curl`, `ss`, `git`. No Docker or external DB: SQLite files live in the run's data dir.

## Launch

```bash
$V build              # npm ci --ignore-scripts, npm rebuild better-sqlite3 esbuild, docs:build, vite build (~15s warm); records HEAD in dist/.verify-build-rev
$V launch demo        # ~20s: seeds 3 industry DBs. Or: $V launch production  (~3s, empty DB + bootstrapped admin)
# prints: ready: url=http://127.0.0.1:<port> mode=<mode> products(cosmetic)=<n> build=<sha> data=<dir> evidence=<dir>
```

`launch` does, from an empty data dir:

1. Writes `/tmp/os-erp-verify/$RUN_ID/run.env` (mode 600): random free loopback `PORT`, random 32-byte `JWT_SECRET`; production also `ADMIN_USER=verify-admin` + random `ADMIN_PASSWORD`; demo records the public demo passwords so they can be scrubbed.
2. production only: `scripts/bootstrap-admin.mjs --industry cosmetic --company-code VERIFY_CO …` with the password piped on stdin (the documented first-run path, 安装手册 §5) → `bootstrap.json`.
3. Starts `node server/index.js` under `setsid` with a clean env (`env -i`): `HOST=127.0.0.1 PORT GML_RUNTIME_MODE GML_DATA_DIR=<scratch>/data GML_DB= GML_JWT_SECRET GML_BUILD_SHA=<HEAD> GML_LOGIN_IP_LIMIT=10000` (same raise as `scripts/browser-ci.mjs`; every journey logs in from 127.0.0.1).
4. Returns only when **usable**: log line `服务已启动`; `/api/meta/health` reports `build_sha=HEAD`; `/login` serves the SPA; the admin logs in to `cosmetic`; `/api/master/products` total is `>0` (demo) or `0` (production).

Shell access: `eval "$($V env)"` exports `ERP_URL ERP_MODE ERP_DATA_DIR ERP_EVIDENCE ERP_ADMIN_USER` (no secrets).

Teardown: `$V cleanup`.

## Doctor

```bash
$V doctor
```

Read-only. Checks: the recorded pid is alive, is `node server/index.js`, cwd is this checkout; the port is owned by that pid (`ss -ltnp`); the process env has this run's `GML_DATA_DIR` and `GML_RUNTIME_MODE`; health `status=ok`; SPA served; admin login works. Warns when health `build_sha` ≠ `HEAD`, `dist/.verify-build-rev` ≠ `HEAD`, or `server/ src/ scripts/` have uncommitted changes (→ `build`, `cleanup`, `launch`). Ends with `doctor: healthy (...)` or `doctor: NOT healthy — do not drive` (exit 1). Run it first and whenever output looks odd.

## Drive

Per-feature recipes: [`features/README.md`](features/README.md). Mechanics:

- **Browser:** `$V ui <label> <journey.json>` → `ui/<label>.<shot>.{png,text.txt,aria.txt}` + `ui/<label>.steps.log`; on failure a `fail-<n>` shot and exit 1. Before that shot the log records `at failure: matches=… loading=… pendingApi=…` (the shot waits for networkidle, so a late row can appear in it), and any API call ≥2s is logged as `slow <ms>` — read these before calling a wait timeout a UI fault. `${RUN_ID}` and `${ADMIN_USER}` are substituted in journeys. Stable handles from this repo:
  - Login: `{"login":"${ADMIN_USER}","industry":"cosmetic"}` opens `/login?industry=…`, types into placeholders `请输入账号`/`请输入密码`, clicks `登 录`, waits to leave `/login` (store users land on `/pos`).
  - Sidebar: `{"nav":["主数据","商品档案"]}` — groups are click-to-open `<div>`s, children are `NavLink`s inside `<aside>`; labels exactly as in `MENUS`.
  - DataPage pages: `{"click":"新增","role":"button"}`, modal heading `新增<title>`, fields `{"fill":"<字段 label>"}` / `{"select":"<label>","option"|"index"}`, `{"click":"保存","role":"button","exact":true}`, toast `已新增`; search with `{"fillPlaceholder":"关键词搜索"}` + `查询`; assert rows with `"within":"table"`. Row buttons: `编辑`, `删除` (confirm auto-accepted).
  - Unlabeled line grids (e.g. 采购订单 SKU picker): `{"selectIn":"table select","index":1}`, `{"fillIn":"table input[type=number]","value":"7"}`; newest document is `tbody tr:first-child`; 提交/审批 confirms are auto-accepted.
  - Header user menu: `{"click":"系统管理员","within":"header"}` → `修改密码`, `退出全部会话`.
- **API (second view):** `$V api <label> <user> <METHOD> </api/path> [json] [industry]` → `api/<label>.{req.txt,status,body.json}` (token never written). Production runs only know `${ADMIN_USER}`; demo knows every seeded user.
- **DB (side effects):** `$V db <label> <industry> "SELECT …"` opens `<data>/gml_<industry>.db` read-only → `db/<label>.{sql,out}`. Useful tables: `products`, `product_skus`, `purchase_orders`, `purchase_order_items`, `inventory_stocks`, `inventory_transactions`, `users`, `audit_logs` (`action/module/entity/entity_id/detail`), `agent_tokens`.
- **MCP:** `$V mcp [industry]` issues a read-only Agent Token as admin (`POST /api/mcp/tokens`), runs `scripts/mcp-readonly-demo.mjs` (`tools/list` + `doc.list_types`), then revokes the token → `cli/mcp.{stdout,stderr,exit}`, `cli/mcp-token-{issue,revoke}.json`.

## Evidence

Location: `${OSERP_VERIFY_EVIDENCE:-$HOME/os-erp-verify-evidence}/$RUN_ID/` — outside the repo and outside scratch, so cleanup never removes it and git never sees it.

```
server-launch.log  server-final.log  bootstrap.json (production)
ui/<label>.<shot>.png|.text.txt|.aria.txt   ui/<label>.steps.log
api/<label>.req.txt|.status|.body.json
db/<label>.sql|.out
cli/mcp.stdout|.stderr|.exit  cli/mcp-token-issue.json  cli/mcp-token-revoke.json
```

Proof standards:

- Exercise the real user path: the browser for UI features, `mcp-readonly-demo.mjs` for MCP. `api`/`db` are second views, not the action. Don't seed rows with SQL or call `server/lib` directly as proof.
- Capture the action and the result: shots before, during (form filled) and after; then API readback as the same user and a `db` SELECT of the row plus its `audit_logs` entry.
- Verify side effects (row, SKU auto-created, stock/ledger rows, audit row, token revoked) — not just the toast (it disappears after ~2.6s; wait for it right after the click).
- Name fixtures with the `RUN_ID` (e.g. `验证商品-$RUN_ID`) so assertions can't match seed data.
- Role scoping is behavior: when a change touches permissions, prove it from two users (e.g. `admin` vs `viewer` in demo).
- Report a journey that cannot run with the exact command, exit code and unmet precondition (e.g. production has no brands; MCP is `FEATURE_DISABLED` in production). Never weaken a journey to make it pass.
- Before sharing, grep the evidence for secrets: `grep -rnE 'eyJ[A-Za-z0-9_-]{10,}|gml_[A-Za-z0-9_-]{8,}|\b12345\b|\b123456\b' "$ERP_EVIDENCE"` should print nothing.

## Cleanup

```bash
$V cleanup
```

Stops only this run's server (verifies the pid's cmdline/cwd first, then TERM to its `setsid` process group, KILL after 5s), copies a redacted `server-final.log` into evidence, and deletes `/tmp/os-erp-verify/$RUN_ID` (data dir + `run.env` secrets). Evidence stays. Never `pkill node`. Run it after failed iterations too, then use a new `RUN_ID` (launch refuses an existing scratch dir).

## Helpers

```bash
V=.cursor/skills/verify-os-erp/scripts/verify-os-erp.sh
$V build
$V launch demo                       # or: $V launch production
$V doctor
$V ui products-create .cursor/skills/verify-os-erp/journeys/products-create.json
$V api products-readback admin GET "/api/master/products?keyword=验证商品-$RUN_ID"   # non-ASCII is percent-encoded for you
$V db products-row cosmetic "SELECT id,spu_code,name,price_retail,status FROM products WHERE name='验证商品-$RUN_ID'"
$V db products-audit cosmetic "SELECT user_name,action,module,entity,entity_id,detail FROM audit_logs WHERE entity='products' AND detail='验证商品-$RUN_ID'"
$V mcp cosmetic
$V cleanup
```

Env knobs: `OSERP_NODE`, `OSERP_VERIFY_SCRATCH` (default `/tmp/os-erp-verify`), `OSERP_VERIFY_EVIDENCE` (default `~/os-erp-verify-evidence`), `CHROME_BIN`.

Known traps (box this was proven on: Debian, Node 22.23.4, Chrome 156):

- The demo server banner prints the demo passwords and the login page shows them on role cards; `redact.mjs` and the browser's DOM scrub remove `user / 12345`-style strings and `密码 123456`. If you add another place that shows credentials, extend both.
- `formOnly` fields `SKU` and `库存` appear as editable empty inputs in 新增商品档案; leave them empty (the server derives them).
- 美妆 is the default industry; a token is bound to the industry it logged into, so pass the same industry to `api`/`db`.
- The repo's own `scripts/browser-ci.mjs` scenarios mostly intercept the API with fixtures; they are not a substitute for driving a launched instance.

Maintenance: keep `features/` honest as the app changes with `/maintain-verification-skill`.
