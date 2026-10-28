# Metrics scope oracle correction — integrated validation

Frozen main `a2d0b3826320e4e06e992a478c2385188cfd19ee`, manual CI [40610463515](https://github.com/osborn-studio/OS-ERP/actions/runs/40610463515), failed its focused prerequisite: 1144 test entries, 1141 pass, 2 fail (one child plus its parent), 1 skip. The isolated regression job failed its prerequisite; its three-round body did **not** execute. Docker/browser were skipped. This is not a failed three-round run.

## Diagnosis

`tests/metrics-perms.test.mjs:345` expected return_rate 1.50, received 1.51. Its independent SQL only counted returns linked to sales orders. The existing `salesScopeSql(..., 'return')` contract also includes standalone returns, scoped by their own warehouse or store.

Original test reproduced on local Node22 with temporary fixture-only UTC/GML_SEED_NOW=2026-10-28T00:53:40Z. Safe numeric diagnostics: scoped sales amount 4887457.96; linked returns 73529.44; omitted standalone returns 158 (one row). Including that row explains 1.51 versus 1.50. Rounding the denominator did not explain this failure. Diagnostic clocks and logging are not committed.

Three deterministic fixtures add standalone in-scope 10000, out-of-scope 100000 and cancelled in-scope 1000000. With the old oracle the local current-clock run fails 1.54 versus 1.29; this run has a different seed clock/data set from the fixed-UTC reproduction above, so those two sets of numbers must not be combined. The corrected independent SQL includes standalone own-party scope and continues to use source-order scope when linked. Original exact numerical and scope assertions remain intact; production code is unchanged.

## Review and verification

Explicit Claude CLI `claude-haiku-5-5`, tools disabled: `is_error=false`, canonicalModel verified, no confirmed blockers. Review confirmed SQL equivalence and requested that numerical evidence from different runs be distinguished; addressed above. Optional insert-status simplification and raw-vs-rounded denominator cleanup were not part of this narrowly diagnosed fix. No tolerance/retry/time-budget relaxation.

Local Node22 full metrics permissions file: 30/30 pass, 0 fail/skip. Metrics scope guard: 25 definitions, 0 issues; file headers4/4; diff check. Additional fixed-UTC diagnostic rerun is recorded in the osstack workspace. Local results are development evidence only. A new exact-source Linux three-round run must pass before V01 is accepted. PR29 must not be merged automatically; no production, release or authentication change is authorized.
