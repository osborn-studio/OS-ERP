# Integrated validation, 2026-10-28

Frozen application source: `a2d0b3826320e4e06e992a478c2385188cfd19ee`, main after PR28, including PR26/27/28. The task ref `codex/integration-acceptance-20261028` remains at this commit. This is not a production-readiness claim.

## Hosted runs (pending)

- V01: CI [40610463515](https://github.com/osborn-studio/OS-ERP/actions/runs/40610463515), manual rounds=3. All applicable jobs and three actual cosmetic/food rounds must pass.
- V02: capacity [40610467723](https://github.com/osborn-studio/OS-ERP/actions/runs/40610467723), large-ci, rehearsal=true, snapshot_upto=58, audit_fts=integrity-check. Inspect actual optional step outcomes, partial flags and reached scale; green aggregate alone is insufficient.
- V03: added opt-in `fts_benchmark_only` mode to the existing nightly workflow. A separately recorded workflow revision checks out the requested full 40-character application SHA and verifies HEAD before executing existing benchmarks. Scheduled/default capacity runs retain their behavior. Separate concurrency groups avoid blocking FTS behind long capacity jobs.

V03 runs steady 200 rows/s, 20 toggles, 20k seed rows; and burst 200, no gap, 5 toggles, 500k seed rows. Gate: all actual toggles, acknowledged rows, no exhausted writes, hash chain, final FTS row count/integrity. Only sanitized numeric/boolean and fixed-enum evidence is uploaded; raw logs/databases stay in disposable runner storage. Enable-wall p95 is measured across toggles (small sample), not HTTP p95; writer reports its existing p50/p99. Hosted timings are trends for this synthetic single-writer environment, not a customer capacity promise.

V04 waits for V01: exact frozen SHA dry-run, then full unsigned artifact-only candidate; inspect package hashes, evidence and packaged production-mode acceptance. V05 waits for capacity and requires a real >=30 minute mixed read/write/backup/MCP workload with errors, invariants, WAL/RSS and p95, not a short benchmark relabelled as soak. External A01–A04 sign-offs remain external.

## Review and development checks

Two tool-disabled Claude CLI reviews explicitly selected `claude-haiku-5-5`; both `is_error=false` and `modelUsage` canonical model verified. Round 1: hardened numeric/boolean gates and output keys. Request to hardcode a single SHA was not adopted: exact SHA is intentionally an explicit reusable input; this task binds dispatch to the recorded frozen main. Round 2: no confirmed blockers. Its incidental reference to git status is not independent tool evidence (tools disabled).

YAML parsed with Ruby; all run blocks pass bash syntax checks; sanitizer positive fixture passed, truthy-string result fixture rejected, path/secret fixture keys/values omitted; git diff --check passed. These are local configuration checks, not Linux benchmark acceptance. No product code changed, no test assertions relaxed, no release/tag/deployment/auto-merge created.
