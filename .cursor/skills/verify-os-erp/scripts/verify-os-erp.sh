#!/usr/bin/env bash
# verify-os-erp.sh — verification scaffolding for OS ERP (osborn-studio/OS-ERP). Not product code.
# Launches an isolated instance (own GML_DATA_DIR, own loopback port, own JWT secret / admin password)
# from this checkout, drives it, writes redacted evidence outside the repo, and tears down only what it started.
# Usage: RUN_ID=<id> verify-os-erp.sh build|launch [demo|production]|doctor|env|ui|api|db|mcp|cleanup ...
# Never run with `set -x` / `bash -x`: the run's secrets pass through variables.
set -euo pipefail

SKILL_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO="$(cd "$SKILL_DIR/../../.." && pwd)"
RUN_ID="${RUN_ID:-default}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "RUN_ID must match [A-Za-z0-9_.-]+" >&2; exit 2; }
SCRATCH="${OSERP_VERIFY_SCRATCH:-/tmp/os-erp-verify}/$RUN_ID"
EVIDENCE="${OSERP_VERIFY_EVIDENCE:-$HOME/os-erp-verify-evidence}/$RUN_ID"
RUNENV="$SCRATCH/run.env"     # secrets live here only (mode 600), never in evidence
DATA="$SCRATCH/data"          # GML_DATA_DIR: gml_cosmetic.db / gml_food.db / gml_apparel.db

die() { echo "verify-os-erp: $*" >&2; exit 1; }
log() { echo "[$(date +%H:%M:%S)] $*"; }

# Node 22 is required (package.json engines ">=22.2 <23"; better-sqlite3 is built against it).
pick_node() {
  local cand
  for cand in "${OSERP_NODE:-}" "$(command -v node 2>/dev/null || true)" "$HOME/.local/node22/bin/node"; do
    [[ -n "$cand" && -x "$cand" ]] || continue
    if [[ "$("$cand" -p 'process.versions.node.split(".")[0]')" == 22 ]]; then
      NODE="$cand"; export PATH="$(dirname "$cand"):$PATH"; return; fi
  done
  die "Node 22 not found (engines >=22.2 <23). Put Node 22 first on PATH or set OSERP_NODE=/path/to/node22"
}

free_port() { "$NODE" -e 'const s=require("net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})'; }
hex() { "$NODE" -p "require('crypto').randomBytes($1).toString('hex')"; }
load_env() { [[ -f "$RUNENV" ]] || die "no instance for RUN_ID=$RUN_ID (run launch first)"; set -a; . "$RUNENV"; set +a; }

# Redact a stream: run secrets, demo role passwords shown as "user / pwd", Bearer/JWT/agent tokens, long opaque strings.
redact() { load_env; "$NODE" "$SKILL_DIR/scripts/redact.mjs"; }

pid_ok() { # pid_ok -> our server pid alive, cmdline server/index.js, cwd = this checkout
  local pid; pid="$(cat "$SCRATCH/server.pid" 2>/dev/null || true)"; [[ -n "$pid" && -d /proc/$pid ]] || return 1
  tr '\0' ' ' </proc/$pid/cmdline | grep -qF -- "server/index.js" || return 1
  [[ "$(readlink /proc/$pid/cwd)" == "$REPO" ]]
}

# login_token <user> [industry] -> prints bearer token to stdout (never to evidence)
login_token() {
  load_env
  ERP_USER="$1" ERP_INDUSTRY="${2:-cosmetic}" "$NODE" "$SKILL_DIR/scripts/erp-login.mjs"
}

cmd_build() {
  pick_node; cd "$REPO"
  npm ci --ignore-scripts --no-audit --no-fund
  npm rebuild better-sqlite3 esbuild --no-audit --no-fund
  npm run docs:build
  npm run build
  git rev-parse HEAD > "$REPO/dist/.verify-build-rev"   # dist/ is gitignored
  log "build ok at $(cat dist/.verify-build-rev) with node $("$NODE" -v)"
}

cmd_launch() {
  local mode="${1:-demo}"
  [[ "$mode" == demo || "$mode" == production ]] || die "launch mode must be demo or production"
  pick_node
  [[ -f "$REPO/dist/index.html" && -f "$REPO/node_modules/better-sqlite3/package.json" ]] || die "no build; run: $0 build"
  [[ ! -e "$SCRATCH" ]] || die "$SCRATCH exists; run cleanup for RUN_ID=$RUN_ID first (or pick a new RUN_ID)"
  mkdir -p "$DATA" "$EVIDENCE"; chmod 700 "$SCRATCH" "$DATA"
  local port; port="$(free_port)"
  umask 077
  {
    echo "MODE=$mode"
    echo "PORT=$port"
    echo "ERP_URL=http://127.0.0.1:$port"
    echo "JWT_SECRET=$(hex 32)"
    if [[ $mode == production ]]; then
      echo "ADMIN_USER=verify-admin"
      echo "ADMIN_PASSWORD=$(hex 16)"
    else
      # Public demo credentials from server/db/seed.js (README). Kept here so evidence can be scrubbed of them.
      echo "ADMIN_USER=admin"
      echo "DEMO_ADMIN_PASSWORD=12345"
      echo "DEMO_ROLE_PASSWORD=123456"
    fi
  } >"$RUNENV"
  umask 022
  load_env
  local sha; sha="$(git -C "$REPO" rev-parse HEAD)"
  if [[ $mode == production ]]; then
    # Real first-run path (docs/本地交付/01_安装手册.md §5): empty production DB + bootstrap-admin, password via stdin.
    ( cd "$REPO"; printf '%s\n' "$ADMIN_PASSWORD" | env -i PATH="$PATH" HOME="$SCRATCH" GML_RUNTIME_MODE=production GML_DATA_DIR="$DATA" GML_DB= \
        "$NODE" scripts/bootstrap-admin.mjs --industry cosmetic --company-code VERIFY_CO --company-name "Verify Co $RUN_ID" \
        --username "$ADMIN_USER" --name "Verify Admin" ) >"$SCRATCH/bootstrap.out" 2>&1 || { redact <"$SCRATCH/bootstrap.out" >&2; die "bootstrap-admin failed"; }
    redact <"$SCRATCH/bootstrap.out" >"$EVIDENCE/bootstrap.json"
  fi
  log "starting server/index.js mode=$mode on 127.0.0.1:$port data=$DATA"
  cd "$REPO"
  # GML_LOGIN_IP_LIMIT raised like scripts/browser-ci.mjs: every journey logs in from 127.0.0.1 and the
  # default 60/min/IP limit would turn later steps into 429s. The per-account limit stays default.
  env -i PATH="$PATH" HOME="$SCRATCH" TMPDIR="$SCRATCH" LANG=C.UTF-8 TZ="${TZ:-Asia/Shanghai}" \
    HOST=127.0.0.1 PORT="$port" GML_RUNTIME_MODE="$mode" GML_DATA_DIR="$DATA" GML_DB= \
    GML_JWT_SECRET="$JWT_SECRET" GML_BUILD_SHA="$sha" GML_LOGIN_IP_LIMIT=10000 \
    setsid "$NODE" server/index.js >"$SCRATCH/server.log" 2>&1 </dev/null &
  echo $! >"$SCRATCH/server.pid"
  local i
  for i in $(seq 1 240); do
    grep -q '服务已启动' "$SCRATCH/server.log" 2>/dev/null && break
    pid_ok || { redact <"$SCRATCH/server.log" | tail -30 >&2; die "server exited during boot"; }
    sleep 0.5; [[ $i == 240 ]] && die "server not ready after 120s"
  done
  # usable, not just up: health is ours, SPA is served, admin can log in, and the data matches the mode
  curl -fsS "$ERP_URL/api/meta/health" | grep -q "\"build_sha\":\"$sha\"" || die "health does not report build_sha=$sha"
  curl -fsS "$ERP_URL/login" | grep -q '<div id="root">' || die "SPA index not served (dist missing?)"
  local tok; tok="$(login_token "$ADMIN_USER" cosmetic)" || die "admin login failed"
  local total
  total="$(curl -fsS "$ERP_URL/api/master/products?page=1&pageSize=1" -H "Authorization: Bearer $tok" -H 'x-industry: cosmetic' \
    | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const j=JSON.parse(s);console.log(j.data?.total ?? j.total ?? (Array.isArray(j.data)?j.data.length:-1))})')"
  if [[ $mode == demo ]]; then [[ "$total" -gt 0 ]] || die "demo seed produced no products (total=$total)";
  else [[ "$total" == 0 ]] || die "production DB should start empty (products total=$total)"; fi
  redact <"$SCRATCH/server.log" >"$EVIDENCE/server-launch.log"
  log "ready: url=$ERP_URL mode=$mode products(cosmetic)=$total build=$sha data=$DATA evidence=$EVIDENCE"
}

cmd_doctor() {
  pick_node; load_env; local ok=1 pid; pid="$(cat "$SCRATCH/server.pid" 2>/dev/null || echo none)"
  chk() { if eval "$2" >/dev/null 2>&1; then echo "  ok   $1"; else echo "  FAIL $1"; ok=0; fi; }
  echo "doctor RUN_ID=$RUN_ID mode=$MODE repo=$REPO"
  chk "server pid $pid alive, is node server/index.js, cwd = this checkout" pid_ok
  chk "port $PORT owned by pid $pid" "ss -ltnpH 'sport = :$PORT' | grep -q 'pid=$pid,'"
  chk "pid $pid uses GML_DATA_DIR=$DATA" "tr '\\0' '\\n' </proc/$pid/environ | grep -qx 'GML_DATA_DIR=$DATA'"
  chk "pid $pid runs GML_RUNTIME_MODE=$MODE" "tr '\\0' '\\n' </proc/$pid/environ | grep -qx 'GML_RUNTIME_MODE=$MODE'"
  chk "/api/meta/health status ok" "curl -fsS $ERP_URL/api/meta/health | grep -q '\"status\":\"ok\"'"
  chk "SPA served at /login" "curl -fsS $ERP_URL/login | grep -q 'id=\"root\"'"
  chk "admin ($ADMIN_USER) can log in to cosmetic" "login_token '$ADMIN_USER' cosmetic"
  local head running built
  head="$(git -C "$REPO" rev-parse HEAD)"
  running="$(curl -fsS "$ERP_URL/api/meta/health" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>console.log(JSON.parse(s).data.build_sha))' 2>/dev/null || true)"
  built="$(cat "$REPO/dist/.verify-build-rev" 2>/dev/null || echo unknown)"
  [[ "$running" == "$head" ]] || echo "  WARN server build_sha=$running != HEAD=$head (server code changed since launch → cleanup + launch)"
  [[ "$built" == "$head" ]] || echo "  WARN dist built at $built != HEAD=$head (UI may be stale → build)"
  git -C "$REPO" diff --quiet -- server src scripts || echo "  WARN uncommitted changes under server/ src/ scripts/ — running code may not be HEAD"
  if [[ $ok == 1 ]]; then echo "doctor: healthy ($ERP_URL, mode=$MODE)"; else echo "doctor: NOT healthy — do not drive"; return 1; fi
}

cmd_env() {
  load_env
  echo "export ERP_URL=$ERP_URL ERP_MODE=$MODE ERP_DATA_DIR=$DATA ERP_EVIDENCE=$EVIDENCE ERP_ADMIN_USER=$ADMIN_USER"
}

cmd_ui() { # ui <label> <journey.json>
  local label="${1:?label}" steps="${2:?journey json}"; pick_node; load_env
  mkdir -p "$EVIDENCE/ui"
  ERP_RUN_ID="$RUN_ID" ERP_REPO="$REPO" ERP_OUT="$EVIDENCE/ui" ERP_LABEL="$label" \
    "$NODE" "$SKILL_DIR/scripts/erp-browser.mjs" "$steps"
}

cmd_api() { # api <label> <user> <METHOD> </api/path> [json] [industry]
  local label="${1:?label}" user="${2:?user}" method="${3:?METHOD}" path="${4:?/api/path}" body="${5:-}" industry="${6:-cosmetic}"
  pick_node; load_env; mkdir -p "$EVIDENCE/api"
  # percent-encode non-ASCII (e.g. Chinese keywords) so curl sends a valid request line
  path="$("$NODE" -e 'process.stdout.write(process.argv[1].replace(/[^\x00-\x7f]+/gu, encodeURIComponent))' "$path")"
  local tok; tok="$(login_token "$user" "$industry")" || die "login failed for $user"
  printf '%s %s (as %s, industry %s)\n%s\n' "$method" "$path" "$user" "$industry" "$body" >"$EVIDENCE/api/$label.req.txt"
  local args=(-sS -o "$SCRATCH/api.body" -w '%{http_code}' -X "$method" "$ERP_URL$path" -H "Authorization: Bearer $tok" -H "x-industry: $industry")
  [[ -n "$body" ]] && args+=(-H 'Content-Type: application/json' --data "$body")
  curl "${args[@]}" >"$EVIDENCE/api/$label.status"
  redact <"$SCRATCH/api.body" >"$EVIDENCE/api/$label.body.json"; rm -f "$SCRATCH/api.body"
  echo "api $label: HTTP $(cat "$EVIDENCE/api/$label.status") -> $EVIDENCE/api/$label.body.json"
}

cmd_db() { # db <label> <industry> "SELECT ..."   (read-only)
  local label="${1:?label}" industry="${2:?industry}" sql="${3:?sql}"; pick_node; load_env; mkdir -p "$EVIDENCE/db"
  printf '%s\n' "$sql" >"$EVIDENCE/db/$label.sql"
  ( cd "$REPO"; DB="$DATA/gml_$industry.db" SQL="$sql" "$NODE" -e '
      const Database=require("better-sqlite3");const db=new Database(process.env.DB,{readonly:true,fileMustExist:true});
      const rows=db.prepare(process.env.SQL).all();console.log(JSON.stringify(rows,null,2));' ) | redact >"$EVIDENCE/db/$label.out"
  echo "db $label -> $EVIDENCE/db/$label.out"; cat "$EVIDENCE/db/$label.out"
}

cmd_mcp() { # mcp [industry] — issue a read-only agent token as admin, run scripts/mcp-readonly-demo.mjs, revoke
  local industry="${1:-cosmetic}"; pick_node; load_env; mkdir -p "$EVIDENCE/cli"
  local tok; tok="$(login_token "$ADMIN_USER" "$industry")" || die "admin login failed"
  local issued; issued="$(curl -sS -X POST "$ERP_URL/api/mcp/tokens" -H "Authorization: Bearer $tok" -H "x-industry: $industry" \
      -H 'Content-Type: application/json' --data "{\"name\":\"verify-os-erp $RUN_ID\",\"scopes\":\"read\"}")"
  printf '%s' "$issued" | redact >"$EVIDENCE/cli/mcp-token-issue.json"
  local agent id; agent="$(printf '%s' "$issued" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).data.token||"")}catch{console.log("")}})')"
  id="$(printf '%s' "$issued" | "$NODE" -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{console.log(JSON.parse(s).data.id||"")}catch{console.log("")}})')"
  [[ -n "$agent" ]] || die "token issue failed (see $EVIDENCE/cli/mcp-token-issue.json; production mode gates agent_access)"
  local rc=0
  ( cd "$REPO"; GML_AGENT_TOKEN="$agent" GML_MCP_URL="$ERP_URL/mcp" "$NODE" scripts/mcp-readonly-demo.mjs ) >"$SCRATCH/mcp.out" 2>"$SCRATCH/mcp.err" || rc=$?
  redact <"$SCRATCH/mcp.out" >"$EVIDENCE/cli/mcp.stdout"; redact <"$SCRATCH/mcp.err" >"$EVIDENCE/cli/mcp.stderr"; echo "$rc" >"$EVIDENCE/cli/mcp.exit"
  rm -f "$SCRATCH/mcp.out" "$SCRATCH/mcp.err"
  curl -sS -X DELETE "$ERP_URL/api/mcp/tokens/$id" -H "Authorization: Bearer $tok" -H "x-industry: $industry" | redact >"$EVIDENCE/cli/mcp-token-revoke.json"
  echo "mcp exit=$rc -> $EVIDENCE/cli/mcp.*"; head -3 "$EVIDENCE/cli/mcp.stdout"; return "$rc"
}

cmd_cleanup() {
  [[ -d "$SCRATCH" ]] || { echo "nothing to clean for RUN_ID=$RUN_ID"; return 0; }
  pick_node
  if [[ -f "$RUNENV" ]]; then
    local pid; pid="$(cat "$SCRATCH/server.pid" 2>/dev/null || true)"
    if pid_ok; then
      [[ -f "$SCRATCH/server.log" ]] && redact <"$SCRATCH/server.log" >"$EVIDENCE/server-final.log"
      kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true   # setsid => pid is the group leader
      for _ in $(seq 1 20); do [[ -d /proc/$pid ]] || break; sleep 0.25; done
      [[ -d /proc/$pid ]] && kill -KILL -- "-$pid" 2>/dev/null || true
      log "stopped server pid $pid"
    elif [[ -n "$pid" && -d /proc/$pid ]]; then
      echo "pid $pid is not this run's server/index.js — not killing it" >&2
    fi
  fi
  rm -rf "$SCRATCH"
  log "removed $SCRATCH (data dir + secrets); evidence kept at $EVIDENCE"
}

case "${1:-}" in
  build) shift; cmd_build "$@" ;;
  launch) shift; cmd_launch "$@" ;;
  doctor) shift; cmd_doctor "$@" ;;
  env) shift; cmd_env "$@" ;;
  ui) shift; cmd_ui "$@" ;;
  api) shift; cmd_api "$@" ;;
  db) shift; cmd_db "$@" ;;
  mcp) shift; cmd_mcp "$@" ;;
  cleanup) shift; cmd_cleanup "$@" ;;
  *) echo "usage: RUN_ID=<id> $0 build|launch [demo|production]|doctor|env|ui <label> <journey.json>|api <label> <user> <METHOD> </api/path> [json] [industry]|db <label> <industry> <SELECT>|mcp [industry]|cleanup" >&2; exit 2 ;;
esac
