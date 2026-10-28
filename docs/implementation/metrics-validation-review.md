# Metrics scope oracle correction — integrated validation

Frozen main `a2d0b3826320e4e06e992a478c2385188cfd19ee`, manual CI [40610463515](https://github.com/osborn-studio/OS-ERP/actions/runs/40610463515), failed its focused prerequisite: 1144 test entries, 1141 pass, 2 fail (one child plus its parent), 1 skip. The isolated regression job failed its prerequisite; its three-round body did **not** execute. Docker/browser were skipped. This is not a failed three-round run.

## Diagnosis

`tests/metrics-perms.test.mjs:345` expected return_rate 1.50, received 1.51. Its independent SQL only counted returns linked to sales orders. The existing `salesScopeSql(..., 'return')` contract also includes standalone returns, scoped by their own warehouse or store.

Original test reproduced on local Node22 with temporary fixture-only UTC/GML_SEED_NOW=2026-10-28T00:53:40Z. Safe numeric diagnostics: scoped sales amount 4887457.96; linked returns 73529.44; omitted standalone returns 158 (one row). Including that row explains 1.51 versus 1.50. Rounding the denominator did not explain this failure. Diagnostic clocks and logging are not committed.

Three deterministic fixtures add standalone in-scope 10000, out-of-scope 100000 and cancelled in-scope 1000000. With the old oracle the local current-clock run fails 1.54 versus 1.29; this run has a different seed clock/data set from the fixed-UTC reproduction above, so those two sets of numbers must not be combined. The corrected independent SQL includes standalone own-party scope and continues to use source-order scope when linked. Original exact numerical and scope assertions remain intact; production code is unchanged.

## Review and verification

Explicit Claude CLI `claude-haiku-5-5`, tools disabled: `is_error=false`, canonicalModel verified, no confirmed blockers. Review confirmed SQL equivalence and requested that numerical evidence from different runs be distinguished; addressed above. Optional insert-status simplification and raw-vs-rounded denominator cleanup were not part of this narrowly diagnosed fix. No tolerance/retry/time-budget relaxation.

Local Node22 full metrics permissions file: 30/30 pass, 0 fail/skip. Metrics scope guard: 25 definitions, 0 issues; file headers4/4; diff check. Additional fixed-UTC diagnostic rerun is recorded in the osstack workspace. Local results are development evidence only. A new exact-source Linux three-round run must pass before V01 is accepted. PR29 must not be merged automatically; no production, release or authentication change is authorized.

## Three-round aggregate job budget

Run40614529636 on ff3ed2a passed all prerequisite jobs and completed round1, then was cancelled during round2. GitHub check122585977574 explicitly reports: `The job has exceeded the maximum execution time of 2h0m0s`. The regression job ran02:00:09–04:00:29 UTC; it was not a failed assertion.

Only a manual dispatch with rounds exactly3 now receives355 minutes aggregate job time; single-round events retain120. All test deadlines, round contents and failure gates remain unchanged. This does not claim that355 minutes has been empirically validated; the new three-round run must finish. Other manually supplied round counts remain outside this targeted change.

Node22 relevant CI policies39/39 and diff checks passed. Two tools-disabled Claude CLI Haiku5.5 reviews verified is_error=false/canonicalModel. The first review's job-identity concern was resolved with the complete regression block; the second retains hosted execution and budget sufficiency as validation requirements. Exact GitHub timeout annotation subsequently confirms cancellation cause. No completed three-round acceptance is claimed.

## Cookie regression follow-up (2026-10-28)

PR CI 40632754787 / job122643442870 completed 114/115 regression checks, 8981 assertions, with the cookie-mode CSRF test failing (not a job timeout). The filtered hosted output omits the individual assertion values, so the exact hosted cause is not proven.

A deterministic synthetic reproduction found a defect in the negative fixture: csrfFor('synthetic-599', 'synthetic-test-only') ends in AA; replacing its last two characters with AA leaves it unchanged and csrfValid correctly accepts it. The test now flips the first character, preserving length while guaranteeing inequality. A deterministic regression covers that suffix collision and both first-character branches. Product authentication/CSRF behavior and rejection assertions are unchanged. Full current-HEAD hosted regression remains required.

Node22 full security-headers file: 18 tests, 17 pass, 0 fail, 1 skipped (dist not built); this is development evidence, not Linux acceptance. Specified Claude CLI claude-haiku-5-5 text-only review returned is_error=false and canonicalModel=claude-haiku-5-5, no confirmed blockers. Raw review: pr30-cookie-haiku.json in the task management workspace. Hosted causality remains unconfirmed pending the new run.
