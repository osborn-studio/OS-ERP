# MCP / Agent 只读访问

OS ERP exposes a JSON-RPC MCP endpoint at `/mcp` for agents holding a `gml_…` agent token, plus an admin console AI 与 MCP 控制台 (`/system/mcp`). Server: `server/mcp/`; token API `/api/mcp/tokens`; demo client `scripts/mcp-readonly-demo.mjs`.

## Sub-features

- Token issue (`POST /api/mcp/tokens`, scopes, industry, expiry), list, revoke (`DELETE /api/mcp/tokens/:id`), sweep.
- `/mcp` `initialize`, `tools/list`, read-only tool calls.
- AI 与 MCP 控制台: capability catalogue, token list and revoke, audit — it does not issue tokens.
- Capability gate `agent_access`: on in demo/test, off in production unless enabled.

## How to get to it (user POV)

Admin sidebar → AI 与 MCP 控制台 to see tools and tokens. Agents connect to `<server>/mcp` with `Authorization: Bearer gml_…`.

## Driving it with verify-os-erp.sh

Preconditions: launched server; `demo` for a positive run, `production` to prove the gate.

```bash
$V mcp            # issues a read-scope token named "verify-os-erp $RUN_ID", runs mcp-readonly-demo.mjs, revokes it
```

Pass (demo) = `cli/mcp.stdout` lists the tools, `cli/mcp.exit` is 0, and `cli/mcp-token-revoke.json` shows the token revoked. Expected in production = issue returns `FEATURE_DISABLED` (`agent_access`).

## Gotchas

- The token is printed once by the API; the script keeps it in memory only and evidence is redacted (`gml_…` pattern).
- The console's help text says to issue tokens in 「用户与权限 / MCP 令牌」, but no SPA screen calls `POST /api/mcp/tokens`; issuing is API-only today.
- Connectors needing real third-party keys (奇门 / platform OMS) are out of scope and **not verified**.
