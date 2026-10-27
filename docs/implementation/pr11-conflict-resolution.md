# PR #11 main synchronization and conflict resolution

2026-10-26. Development integration only; no PR merge or auto-merge authorized by this repair.

- Original PR branch `feat/batch-fifteen`: `0454f5dda52b33683c681c5e6a510fcc7c15d4fa`.
- Main synchronized by ordinary merge: `668237c8fbb33128fcaf1e3e58a3398dcdd7d86e` (includes merged PR #10).
- The sole textual conflict was the generated API contract version in `src/types/api-routes.ts`. Regenerated from merged `server/openapi.js`, preserving **1.43.0 and 526 routes**, including role-matrix, MCP limits and per-token limits endpoints. Regeneration is byte-identical; no hand-edited generated contract.
- Preserved main's manifest verification-state/break checks, exclusive off-box anchor publication and deterministic contention checks alongside batch fifteen's archive/intent reconciliation, backup durability and scope-aware metrics behavior. No whole-file side selection or force push.

## Verification

osstack 0.22.1 finite task `task_4c691b19`, isolated synthetic paths and loopback services, Node 22 development checks:

- Eight files (`offbox-anchor`, `audit-chain`, `write-contention`, `hq-roles`, `role-matrix`, `metrics-perms`, `fs-fault`, `db-backup`): **244 passed, 0 failed, 0 skipped**.
- API contract, TypeScript, Vite build, file-header/data-path/route-authz/bizcode guards and changelog/codemap/role-matrix drift checks: **10 passed**.
- No unmerged index entries; staged whitespace check clean. No local Python or customer data operations.
- Full evidence: `/tmp/osstack/pr11-conflicts/validation.json` and per-command logs. These local results do not establish hosted Linux acceptance.

## Independent review and disposition

Claude CLI `claude-haiku-5-5`, tools disabled and supplied-text-only review, returned `is_error=false` and `canonicalModel=claude-haiku-5-5`: **no confirmed integration blocker**.

Conditional checks were independently resolved against complete sources and test results:

- `callerRestricted`/`showsScopedMarker` exist in `src/api/metrics.ts`; TypeScript, build and metrics tests pass. Actual browser behavior remains a hosted CI check.
- Archive evidence helpers feed `scripts/audit-verify-chain.mjs`; signed-intent and against-backup tests cover their reconciliation and key requirements.
- The changed docflow setting text describes existing PS/PSF store and DR dealer predicates in `server/lib/docflow.js`; this merge changes the description, not those authorization predicates.
- Backup verification recomputes the chain without an expected-tip option. Its content/link/unchained break round-trip checks pass for plain and encrypted backups.
- The fixture includes the existing `sbom-diff.mjs` imported by `verify-release.mjs`; off-box fixture tests pass. The daily-procedure documentation checks pass.
- The generated API file was regenerated again without drift. Existing GNU `ln -T`, best-effort SSH cleanup and local no-hardlink crash-visibility limitations remain unchanged and documented.

The previous PR HEAD's hosted CI was green before synchronization. The new post-push HEAD must run its own Linux checks, including real GNU-link behavior, browser scenarios, Docker smoke and isolated regression. No release or production acceptance is claimed.
