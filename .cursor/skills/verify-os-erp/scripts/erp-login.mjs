#!/usr/bin/env node
// erp-login.mjs — verification scaffolding. Logs in through POST /api/auth/login (the same call the Login page makes)
// and prints only the bearer token to stdout for the caller's pipe. Credentials come from the run.env exported by
// verify-os-erp.sh; nothing is written to disk.
// env: ERP_URL, ERP_USER, ERP_INDUSTRY, MODE, ADMIN_USER, ADMIN_PASSWORD | DEMO_ADMIN_PASSWORD, DEMO_ROLE_PASSWORD
export function passwordFor(user, env = process.env) {
  if (env.MODE === 'production') {
    if (user !== env.ADMIN_USER) throw new Error(`production run only knows ${env.ADMIN_USER}; create other users via the UI first`)
    return env.ADMIN_PASSWORD
  }
  return user === 'admin' ? env.DEMO_ADMIN_PASSWORD : env.DEMO_ROLE_PASSWORD
}

export async function login(user, industry, env = process.env) {
  const res = await fetch(`${env.ERP_URL}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: passwordFor(user, env), industry })
  })
  const j = await res.json().catch(() => ({}))
  if (!res.ok || !j?.data?.token) throw new Error(`login ${user}@${industry} failed: HTTP ${res.status} ${j?.message ?? ''}`)
  return j.data.token
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { process.stdout.write(await login(process.env.ERP_USER, process.env.ERP_INDUSTRY || 'cosmetic') + '\n') }
  catch (e) { console.error(e.message); process.exit(1) }
}
