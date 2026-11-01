#!/usr/bin/env node
// redact.mjs — verification scaffolding (not product code). stdin -> stdout with secrets removed.
// Removes: this run's secrets (JWT_SECRET, ADMIN_PASSWORD from run.env, passed via env), demo role passwords
// rendered as "user / pwd" (login role cards, server banner), Bearer/JWT/agent tokens and long opaque strings.
// Also exported as a function for erp-browser.mjs.
import { fileURLToPath } from 'node:url'

export function secretsFromEnv(env = process.env) {
  return [env.JWT_SECRET, env.ADMIN_PASSWORD].filter((s) => s && s.length >= 8)
}

export function redact(text, secrets = secretsFromEnv()) {
  let out = String(text)
  for (const s of secrets) out = out.split(s).join('[REDACTED]')
  return out
    .replace(/([A-Za-z0-9_]+ ?\/ ?)(12345|123456)\b/g, '$1[REDACTED]')          // "admin / 12345" role cards & banner
    .replace(/((?:密码|口令|password)\s*[:：=]?\s*)(12345|123456)\b/gi, '$1[REDACTED]') // "其余角色账号密码 123456"
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, '[REDACTED_JWT]')
    .replace(/\bgml_[A-Za-z0-9_-]{8,}/g, 'gml_[REDACTED]')                      // MCP agent tokens
    .replace(/("(?:token|password|secret|agent_token|access_token)"\s*:\s*")[^"]*"/gi, '$1[REDACTED]"')
    .replace(/[A-Za-z0-9_-]{48,}/g, '[REDACTED_LONG]')
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let s = ''
  process.stdin.setEncoding('utf8').on('data', (c) => { s += c }).on('end', () => process.stdout.write(redact(s)))
}
