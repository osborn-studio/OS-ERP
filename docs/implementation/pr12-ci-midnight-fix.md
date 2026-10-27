# PR #12: deterministic audit-window test across midnight

2026-10-27. Development CI repair; no PR merge or auto-merge.

## Failure and cause

- Failing HEAD: `16e7f4a7cfa9c86d4cd3156fbc9c2fef63c04d52`.
- Hosted run: <https://github.com/osborn-studio/OS-ERP/actions/runs/40420594841>, focused job `121913750383`.
- Focused suite: **1367 tests, 1364 passed, 1 failed, 2 skipped**. The sole failure was the AD3 explain-audit test in `tests/dashboard-perf.test.mjs`. The no-FTS5 job passed; Docker, browser and isolated regression were skipped because their prerequisite failed. Capacity and dependency-review were conditional manual-only skips.
- `STATEMENTS` binds representative date windows when `scripts/explain-audit.mjs` is imported. The assertion computed a fresh window later. The run began before UTC midnight; the assertion ran at 00:01 UTC, comparing cached `['2026-09-25', '2026-09-26']` with new-day `['2026-09-26', '2026-09-27']`.
- Injecting local midnight while retaining the original live-clock expectation reproduced that exact diff deterministically (`/tmp/osstack/pr12-ci-fix/red.log`).

## Fix and validation

The existing test now imports a fresh audit module under a test-scoped fixed Date, advances across local midnight, proves the clock crossed the boundary, and compares both 30- and 90-day parameters against the captured import instant. All SQL equality, expected-index, constrained-search, no-scan and dropped-index negative assertions remain. Production code and query behavior are unchanged.

osstack 0.22.1 task `task_770ce4f2` completed with all seven commands successful:

- Targeted midnight case: **1/1 each** under UTC, Asia/Shanghai and America/Los_Angeles.
- Full `dashboard-perf.test.mjs` and `explain-plan-guard.test.mjs`: **50 passed, 0 failed, 0 skipped**.
- File-header, data-path and analyze-source-scan guards passed.
- Additional Node 22 compatibility probe: **2/2**, confirming the next test sees the original Date constructor after a test-scoped mock ends.

Claude CLI `claude-haiku-5-5`, tools disabled and supplied-text-only review, returned `is_error=false`, `canonicalModel=claude-haiku-5-5`, and **no confirmed blocker**. Conditional concerns were checked: the second module evaluation constructs declarations only and does not enter the guarded CLI main; the affected cached-versus-current parameter comparisons are both fixed; the test fixture does not execute ANALYZE; the complete neighboring suite passes after clock restoration. SQL's own clock is not mocked, but these assertions inspect EXPLAIN plans, not time-dependent business query results. Existing separate date-window semantics tests remain intact.

Evidence is retained under `/tmp/osstack/pr12-ci-fix/`. All local runs use isolated synthetic paths and Node 22, without local Python. The new pushed HEAD must pass its own hosted Linux focused checks, no-FTS5 check, Docker, browser and isolated regression before CI acceptance; these local results are not a substitute.
