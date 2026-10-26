# PR #12 main synchronization and conflict resolution

2026-10-26 UTC. Development integration only; no PR merge or auto-merge performed.

- Original `feat/batch-sixteen` HEAD: `0155244d74d42b53f202b25ee2d63523dc7768a1`.
- Main synchronized by ordinary merge: `975504994e07eaa1aa32ffabefc627836e03388d` (includes merged PR #11).
- `src/types/api-routes.ts`: regenerated from the merged OpenAPI source, retaining the PR's **1.44.0** version and **527 paths**, including main's role-matrix endpoint and batch sixteen's MCP quota endpoint. Both parents' 526-path sets are retained; repeat generation is byte-identical.
- `tests/offbox-anchor.test.mjs`: resolved the import conflict by retaining `createPublicKey` for AG5 key rotation and `lstatSync`/`readlinkSync` for main's destination-safety tests. Both parents' off-box and audit-chain test declarations remain present.
- Preserved main's exclusive anchor publication, owned-path cleanup, manifest verification-state/break checks and deterministic contention checks together with batch sixteen's key rotation, backup-report durability and scope behavior. No whole-file side selection or force push.

## Verification

osstack 0.22.1 finite task `task_76b65244`, with isolated synthetic data paths and loopback services, completed successfully:

- Node 22.22.1, nine test files (`offbox-anchor`, `audit-chain`, `write-contention`, `hq-roles`, `role-matrix`, `metrics-perms`, `fs-fault`, `db-backup`, `release-signing`): **288 passed, 0 failed, 0 skipped**.
- **12 additional checks passed**: metrics-scope, lock-registry, API contract, TypeScript, Vite build, file-header/data-path/route-authz/bizcode guards and changelog/codemap/role-matrix drift checks.
- API static analysis covers 454 frontend calls; its existing dynamic-call exclusion remains one call. Generated types describe paths/methods, not complete response schemas.
- Dependencies installed from this branch's lockfile with install scripts disabled; the matching better-sqlite3 11.10.0 Node 22 native binary was reused and loaded successfully. No local Python was invoked.
- No unmerged index entries or whitespace errors. Evidence: `/tmp/osstack/pr12-conflicts/validation.json`, command logs and `integration-checks.json`.

## Independent review and disposition

Claude CLI `claude-haiku-5-5`, tools disabled and supplied-text-only review, returned `is_error=false` with `canonicalModel=claude-haiku-5-5`: **no confirmed integration blocker**. This was an integration review, not a new audit of the entire sixteenth batch.

Conditional questions were checked against complete sources and the passing tests:

- Backup break JSON round trips pass for content/link/unchained failures, plain and encrypted; the manifest recomputation does not request an expected-tip comparison.
- The contention test has no remaining unbound `once`/`delay` calls; `withWriteRetry` accepts and invokes `opts.sleep`, including the deterministic BUSY barrier.
- AG5 explicit-key-set rejection and legacy implicit-key fallback remain distinct. The complete audit-chain/off-box/signing suites pass, including rotated keys, unknown keys, missing IDs and transition behavior; required CLI flags and helpers exist.
- `callerRestricted` has the one-argument signature. The AG10 scope/auth sources, browser registrations and metric helpers are unchanged by this merge. TypeScript, build and relevant role/metrics tests pass; browser execution remains a hosted check.
- The revised setting prose matches existing store/dealer/subject/HQ predicates. This merge does not change those authorization predicates or their MCP policy.
- The conflict versions above are explicit: PR 1.44.0, main 1.43.0. An audit concern about reversed version labels does not describe this record or the supplied resolution.
- Existing duplicate header prose, GNU-link portability, best-effort remote cleanup and no-hardlink fallback limitations were not introduced by this merge. Historical timing observations do not prove a current failure; the selected tests passed without widening timeouts or assertions.

The new post-push HEAD requires its own GitHub-hosted Linux CI: focused checks, no-FTS5 audit checks, Docker smoke, browser scenarios and isolated regression. Prior-HEAD success and these local Node checks are not substitutes for that result, release acceptance or production acceptance.
