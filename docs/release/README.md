# Release candidates

`node scripts/release-candidate.mjs` builds a **release candidate** from a clean, committed tree. A candidate is
**not a published release**: nothing is tagged, no GitHub release is created, nothing is deployed, and it carries no
claim of production or commercial readiness. Acceptance status lives in `docs/implementation/backlog.md`.

## What the script does

1. Refuses a dirty working tree (modified, staged or untracked files), before and after the build. There is no override flag.
2. Runs `npm run release` into a temporary directory and checks that `MANIFEST.baseCommit` equals `HEAD`, that the
   package does not include uncommitted changes, and that the version matches `package.json`.
3. Writes `release/RC-<version>-<shortsha>.zip` and `.zip.sha256`.
4. On a fresh extraction of that zip: `verify-release`, a secret/database scan, and the production acceptance
   (`scripts/test-local-delivery.mjs`, mode production). Any failure deletes the candidate and exits non-zero.
5. Writes `release/RC-<version>-<shortsha>.evidence/EVIDENCE.json` and `RELEASE-NOTES.md`, then validates the evidence
   with `verify-release --evidence=...`.

```
node scripts/release-candidate.mjs [--run-tests] [--run-guards] [--ci-run=<run id>|auto] \
  [--focused-result=passed --focused-source="<where it ran>"] \
  [--regression-result=passed --regression-source="<where it ran>"] [--reuse-node-modules]
```

`--run-tests` makes the script itself run the focused suite (`node --test --test-concurrency=1 tests/*.test.mjs`) and the
five guards, before the acceptance step. `--ci-run=auto` looks up the CI run (see below). Both are optional; without them
the corresponding fields stay `not run` / `null`. `--run-tests` cannot be combined with `--focused-result`.

`--reuse-node-modules` makes acceptance use this checkout's `node_modules` instead of installing from the network; the
evidence records it (`acceptance.reuse_node_modules`).

## EVIDENCE.json

| Field | Meaning |
| --- | --- |
| `version`, `commit`, `built_at`, `node` | From `package.json`, `git rev-parse HEAD`, the build time, and the Node that ran the script. `commit` must equal the package's `baseCommit`. |
| `artifact` | Zip name, sha256, size, file count. |
| `focused_tests` | With `--run-tests`: `{result: 'passed', origin: 'produced', command, files, duration_ms, summary_counts: {tests, pass, fail, cancelled, skipped, todo}, tests_tree_sha256, tests_files}`. The counts are parsed from the runner's own summary (the suite runs against the clean checkout of `HEAD`, which `MANIFEST.baseCommit` must equal; HEAD and the tree are re-checked afterwards); if they cannot be parsed, or the suite is not a clean pass, the build aborts rather than recording a result. `tests_tree_sha256` is the sha256 over every file under `tests/` (sorted `path\0sha256` lines), computed before and after the run and required to equal the listing shipped in the package. Without `--run-tests`: operator-attested via `--focused-result`/`--focused-source`, else `not run`. |
| `regression` | `{source, result, origin}`. `not run` unless the operator passes `--regression-result` and `--regression-source`; then `origin` is `operator-attested`. The script does not run or verify it. A `failed` result aborts the build. |
| `guards` | tsc and the four `check-*` guards. `not run` unless `--run-guards` or `--run-tests`, in which case the script runs them (`origin: produced`, with `duration_ms`). |
| `ci_run_id`, `ci_lookup` | `--ci-run=<id>`: the operator's reference, not looked up (`ci_lookup.mode: operator-supplied`). `--ci-run=auto`: `gh run list --commit <HEAD> --workflow ci.yml --json databaseId,conclusion,...`; the newest run with `conclusion: success` for exactly this commit. If `gh` is missing or not logged in, no run exists for the commit, or none succeeded, `ci_run_id` is `null` and `ci_lookup.reason` says why; nothing is guessed. No flag: `null`, `ci_lookup.mode: none`. |
| `synthetic_drill` | Names and sha256 of the committed capacity-evidence files (shipped in the package). These are synthetic rehearsals on a development host, not target-host results. |
| `verify_release`, `acceptance`, `secret_scan` | Produced by the script on the fresh extraction. |
| `not_a_release` | Always `true`. |

`verify-release --evidence` rejects a missing field, a version/commit that disagrees with `MANIFEST.json`, a `passed`
result without origin (or without source for operator-supplied ones), any `failed` result, a malformed `ci_run_id`, and
drill hashes that do not match the files in the package. For a `produced` focused result it also rejects missing or
inconsistent `summary_counts`, a missing `duration_ms`, and a `tests_tree_sha256` that differs from the hash recomputed
from `release/tests-tree.json` in the package (`tests/` itself is not shipped because it holds TLS key fixtures; the listing
is covered by MANIFEST hashes). An auto-resolved `ci_run_id` must carry `ci_lookup` from `gh run list` with conclusion
`success`, a `null` one must state its reason, and counts must add up (`tests = pass + fail + cancelled + skipped + todo`). If `OS_ERP_GH` (a test seam that substitutes the `gh` binary) was set, the lookup records `gh_override: true` and `verify-release` warns. It checks consistency, not truth: someone who can edit the evidence file
and the package together can still forge it, and operator-attested results are only as good as the operator.

## RELEASE-NOTES.md

The `CHANGELOG.md` section whose heading contains the version, else the newest batch section (stated in the notes),
under a header that repeats the commit and that this is a candidate.

## Manual steps that remain

- Run the focused suite and the isolated regression on the designated hosts (Linux on `dmserver`, Mac-specific on Mac Studio) and record them with the `--*-result` flags or compare against hosted CI.
- Confirm the hosted CI run for this commit and pass its id with `--ci-run`.
- Run acceptance on the target platform; the candidate's acceptance ran on the building machine only.
- Review `RELEASE-NOTES.md`, the dependency alerts and the open items in the backlog.
- Explicit owner authorization to tag, publish a GitHub release, or deploy. None of that is done by this script.
- Transfer the zip with its `.sha256` and re-check the hash on the receiving side.
