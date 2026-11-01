# Login, session and route guard

The `/login` page authenticates a user for one industry (美妆 / 食品 / 服装), stores a bearer token in the SPA, and every other route redirects back to `/login` without it. The header user menu ends all sessions. Server side: `server/routes/auth.js`, rate limits via `GML_LOGIN_IP_LIMIT`.

## Sub-features

- Industry picker + username/password form (`POST /api/auth/login {username,password,industry}` → `data.token`).
- Demo role cards on the login page (demo mode only) that prefill public demo accounts.
- Header user menu → 退出全部会话 (revokes tokens, returns to `/login`).
- Route guard: deep links such as `/master/products` redirect to `/login` when signed out.
- Production first admin created only by `scripts/bootstrap-admin.mjs` (password on stdin, ≥16 chars, company code uppercase).

## How to get to it (user POV)

Open the server root → redirected to `/login` → pick industry, type username and password → land on `/` with 经营看板 in the sidebar. Click the user name in the header (系统管理员 for the bootstrap/demo admin) → 退出全部会话.

## Driving it with verify-os-erp.sh

Preconditions: launched server (either mode); in `production` the launch step has already run bootstrap-admin and written the generated password to the 600-mode `run.env`.

```bash
$V launch production
$V ui login-session .cursor/skills/verify-os-erp/journeys/login-session.json
$V api login-me "$ADMIN_USER" GET /api/auth/me   # optional readback; token never written to evidence
```

Pass = journey PASS, `login-session.home.png` shows the dashboard, `after-logout` and `guarded-route` show the 登录 heading at `/login`.

## Gotchas

- The server banner and the demo login cards print the public demo passwords; `redact.mjs` and the DOM scrub hide them in evidence. Keep both when editing.
- Many fast logins from 127.0.0.1 hit the IP limiter; launch sets `GML_LOGIN_IP_LIMIT=10000` like `scripts/browser-ci.mjs`.
- In `production` only the bootstrap admin exists; demo usernames fail by design.
- Token is stored client-side; a stale tab after `cleanup` shows network errors, not a logout.
