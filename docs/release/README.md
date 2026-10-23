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
node scripts/release-candidate.mjs [--run-guards] [--ci-run=<run id>] \
  [--focused-result=passed --focused-source="<where it ran>"] \
  [--regression-result=passed --regression-source="<where it ran>"] [--reuse-node-modules]
```

`--reuse-node-modules` makes acceptance use this checkout's `node_modules` instead of installing from the network; the
evidence records it (`acceptance.reuse_node_modules`).

## EVIDENCE.json

| Field | Meaning |
| --- | --- |
| `version`, `commit`, `built_at`, `node` | From `package.json`, `git rev-parse HEAD`, the build time, and the Node that ran the script. `commit` must equal the package's `baseCommit`. |
| `artifact` | Zip name, sha256, size, file count. |
| `focused_tests`, `regression` | `{source, result, origin}`. `not run` unless the operator passes `--*-result` and `--*-source`; then `origin` is `operator-attested`. The script does not run or verify these. A `failed` result aborts the build. |
| `guards` | tsc and the four `check-*` guards. `not run` unless `--run-guards`, in which case the script runs them (`origin: produced`). |
| `ci_run_id` | The `--ci-run` value or `null`. It is a reference supplied by the operator and is not looked up on GitHub. |
| `synthetic_drill` | Names and sha256 of the committed capacity-evidence files (shipped in the package). These are synthetic rehearsals on a development host, not target-host results. |
| `verify_release`, `acceptance`, `secret_scan` | Produced by the script on the fresh extraction. |
| `not_a_release` | Always `true`. |

`verify-release --evidence` rejects a missing field, a version/commit that disagrees with `MANIFEST.json`, a `passed`
result without origin (or without source for operator-supplied ones), any `failed` result, a malformed `ci_run_id`, and
drill hashes that do not match the files in the package. It checks consistency, not truth: operator-attested results are
only as good as the operator.

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
