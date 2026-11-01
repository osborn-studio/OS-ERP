# OS ERP feature map

Each file here describes one user-facing feature of OS ERP: what it contains, how a user reaches it, how to drive it with `scripts/verify-os-erp.sh`, and what bites. Read the matching file before verifying a change in that area; update it in the same PR when the feature moves.

## Baseline preconditions

- Built `dist/` at the commit under test (`$V build`; `$V doctor` warns when `dist/.verify-build-rev` ≠ `HEAD`).
- A launched, doctor-clean server for this `RUN_ID`. Mode matters:
  - `demo` — seeded fixtures (brands, suppliers, warehouses, SKUs, POs, stock). Use for business journeys.
  - `production` — empty DB, first admin from `scripts/bootstrap-admin.mjs`, capabilities `agent_access` / `public_mall` / `qimen` off. Use for first-run, auth and capability gating.
- Default industry is `cosmetic`; journeys and `api`/`db` take an explicit industry. Each industry is a separate SQLite file (`gml_<industry>.db`).

## Driving conventions

- UI: `$V ui <label> journeys/<name>.json`. Steps address elements by accessible name, label or placeholder (Chinese UI text), never by CSS class; the only CSS escape hatches are `within`, `selectIn`, `fillIn` for unlabeled table cells.
- Make every created record carry `${RUN_ID}` (name, remark) so readbacks find exactly one row.
- Read back through a second surface: `$V api` (HTTP, same as the SPA) and `$V db` (read-only SQLite). A toast alone is not proof.
- Never put a password in a journey file or on a command line; `login` steps read it from `run.env`.

## Proof and skip reporting

Report each feature as **verified** (journey PASS + readback agrees, evidence path given), **failed** (step number + fail shot), or **not verified** (say why: needs real third-party keys, platform not available on the box, not executed). Never upgrade "the page rendered" into "the feature works".

## Entry contract

A feature file has an H1 and one paragraph, then exactly these H2s in order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-os-erp.sh` (first line `Preconditions:`), `Gotchas`. Keep it to things a verifier needs; link code paths instead of restating them.

## Index

| Feature | File | Last proven (box, 2026-11-01) |
|---|---|---|
| Login, session, route guard | [login-session.md](login-session.md) | verified in `production` (journey `login-session`) |
| 商品档案 (product master) | [master-products.md](master-products.md) | verified in `demo` (journey `products-create` + api + db + audit log) |
| 采购订单 → 收货入库 | [purchase-orders.md](purchase-orders.md) | verified in `demo` (journey `purchase-receive` + db) |
| 库存查询 / 收发存台账 | [inventory-stocks.md](inventory-stocks.md) | readback via db only; no dedicated journey yet |
| MCP / Agent 只读访问 | [mcp-agent.md](mcp-agent.md) | verified in `demo` (`$V mcp`); gated off in `production` as designed |
