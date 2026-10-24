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
5. Writes `release/RC-<version>-<shortsha>.evidence/EVIDENCE.json` (optionally with `EVIDENCE.sig`, see below) and `RELEASE-NOTES.md`, then validates the evidence
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
| `built_by` | `hosted-ci`, `key-holder` or `local` (see the transparency log). Part of the signed content. |
| `signature` | `null` (unsigned) or `{algorithm, canonicalization, key_id, sig_file}` when signed with `GML_RELEASE_SIGN_KEY`. |
| `not_a_release` | Always `true`. |

`verify-release --evidence` rejects a missing field, a version/commit that disagrees with `MANIFEST.json`, a `passed`
result without origin (or without source for operator-supplied ones), any `failed` result, a malformed `ci_run_id`, and
drill hashes that do not match the files in the package. For a `produced` focused result it also rejects missing or
inconsistent `summary_counts`, a missing `duration_ms`, and a `tests_tree_sha256` that differs from the hash recomputed
from `release/tests-tree.json` in the package (`tests/` itself is not shipped because it holds TLS key fixtures; the listing
is covered by MANIFEST hashes). An auto-resolved `ci_run_id` must carry `ci_lookup` from `gh run list` with conclusion
`success`, a `null` one must state its reason, and counts must add up (`tests = pass + fail + cancelled + skipped + todo`). If `OS_ERP_GH` (a test seam that substitutes the `gh` binary) was set, the lookup records `gh_override: true` and `verify-release` warns. It checks consistency, not truth: someone who can edit the evidence file
and the package together can still forge it, and operator-attested results are only as good as the operator.

## Signing the evidence (ADR-0047)

Without a key the candidate builds exactly as before and `EVIDENCE.json` carries `"signature": null`. With
`GML_RELEASE_SIGN_KEY=<absolute path to an Ed25519 private key PEM>` the script signs the canonicalized evidence
(keys sorted at every depth, no whitespace; the whole object including the `signature` metadata is signed) and writes
`EVIDENCE.sig` (base64, 64-byte signature) next to `EVIDENCE.json` in `RC-<version>-<shortsha>.evidence/`. The signature
is not inside the zip, because the evidence contains the zip's hash. If the variable is set but the key is unusable
(missing, not Ed25519, inside any git working tree, readable by group/others) the build stops before building anything; it never
falls back to unsigned.

```
node scripts/release-keygen.mjs --out /absolute/path/to/new/empty/dir     # release-sign.key.pem (0600) + release-sign.pub.pem
GML_RELEASE_SIGN_KEY=/absolute/path/release-sign.key.pem node scripts/release-candidate.mjs ...
node scripts/verify-release.mjs --evidence=<EVIDENCE.json> --pubkey <release-sign.pub.pem>   # run inside the extracted package
```

`--pubkey` fails on a changed evidence file, another key, a missing/malformed `EVIDENCE.sig`, and on unsigned evidence
(a signed candidate cannot be downgraded by setting `signature` to `null`). Without `--pubkey`, signed evidence is accepted
with a "signature not verified" notice.

Key custody:
- Generate the pair on the machine that signs, in a directory outside every repository (the keygen refuses repository paths
  and non-empty directories). Never commit, attach to CI logs, email or place the private key on shared storage; the
  secret scan and `.gitignore` are a backstop, not a control.
- Keep one copy of the private key in the owner's offline backup. Hosted CI does not hold it, so CI-built candidates are unsigned.
- Distribute the public key out of band (not inside the candidate it verifies). Record its `key_id`
  (sha256 of the SPKI DER, printed by keygen and stored in `EVIDENCE.json`) with the receiving side.
- Rotation: generate a new pair, publish the new public key and `key_id`; old candidates keep verifying with the old public key.
  If the private key may be exposed, stop trusting its `key_id` and re-issue candidates.
- A signature shows that the key holder approved this exact evidence; it does not make `operator-attested` results true.

## Evidence transparency log (ADR-0052)

`docs/release/EVIDENCE-LOG.jsonl` is an append-only, hash-chained log in the repository: one JSON line per candidate with
`name` (`RC-<version>-<shortsha>`), `evidence_sha256` (sha256 of the canonicalized `EVIDENCE.json`, the same bytes that are
signed), `signature` (sha256 of the `EVIDENCE.sig` text, or `null`), `built_by`, `timestamp` and `prev` (sha256 of the previous
line's exact text; the first line uses a fixed genesis constant). Lines must be in canonical form; blank lines, reordering,
edits, duplicates and backwards timestamps break the chain.

```
node scripts/release-candidate.mjs --log [...]                 # or --log=<file>; checks the chain and the name before building, appends after self-verification
node scripts/verify-release.mjs --evidence=<EVIDENCE.json> --log[=<file>]   # chain intact, this candidate present and matching
```

- `built_by`: `hosted-ci` when `GITHUB_ACTIONS=true` (the script then refuses `GML_RELEASE_SIGN_KEY`: hosted CI holds no key and
  records `signature: null`), `key-holder` for a signed local build, `local` for an unsigned local build. It is self-reported
  by the building process and also stored in the signed evidence.
- The append modifies a tracked file: commit the new line before the next build (the dirty-tree check applies as usual).
- Appends take an exclusive lock file (`<log>.lock`); a held lock makes the build fail instead of interleaving. A lock left by a crashed process must be removed by hand after checking nothing is appending.
- Crash semantics of the append (AD6; full table in `docs/operations/audit-integrity.md` section 5b): the line is written and fsynced inside the lock, and a failed write or fsync truncates the file back to its length before the append. If the process is killed (or loses power) instead: a stale `<log>.lock` is left (remove by hand), the log is either still a valid chain (the entry counts as appended; rebuilding the same name is refused, use a new commit) or has a torn last line (the log is rejected and never repaired: restore the committed file with git and rebuild). Fault points `log.after-lock`, `log.after-write-before-fsync`, `log.after-fsync-before-unlock` exist for tests only (`GML_TEST_FS_FAULT`, `GML_RUNTIME_MODE=test`); with the variable set in any other mode `release-candidate --log` fails before building.
- A candidate name can appear once. Re-signing a candidate means a new commit, hence a new name.
- Limits: a hash chain detects edits in the middle, not removal of the newest lines or replacement of the whole file by another
  valid chain; git history and an out-of-band copy of the latest line's hash cover that. The log does not prove the evidence true.

### Unsigned candidates and formal releases

`verify-release --evidence` prints a prominent `WARNING: UNSIGNED CANDIDATE` banner to stderr when `signature` is `null`; the
exit code is unchanged. `--require-signature` (needs `--pubkey`) turns it into a failure and also fails a signed candidate whose
signature was not verified. **A formal release must be re-signed by the key holder on a controlled machine**: build there
with `GML_RELEASE_SIGN_KEY` set (and `--log`) from a clean checkout; because a candidate name (`RC-<version>-<shortsha>`) can appear in
the log only once, re-signing a commit that is already logged (for example by hosted CI) requires a new commit, which gets a new name; distribute the public key out of band, and verify with
`--pubkey --require-signature --log`. Hosted-CI candidates are development candidates only and are never release-grade.

### Hosted CI candidate (AD10)

The `candidate` job in `.github/workflows/release-candidate.yml` (AF1: moved out of `ci.yml`) builds a candidate on a GitHub-hosted runner. It runs only for
`workflow_dispatch` and for pushes of tags matching `v*` (never for pull requests or branch pushes; the workflow has no other trigger), at most one at a time (own concurrency group `candidate-<repo>`, read-only token, no secrets),
within 90 minutes. It runs `release-candidate --run-tests --ci-run=auto --log=<runner temp> --output=<runner temp>`, then
`verify-release --evidence --artifact --log` on the extracted package, and uploads exactly three files as a workflow artifact
kept for 14 days: `RC-<version>-<shortsha>.zip`, `EVIDENCE.json` and `evidence-log-line.jsonl` (the log line this build would
append). It creates no tag, no GitHub Release, and does not commit the log line back.

`ci.yml` has no tag trigger and no ref-based job skips (AF1; before AF1 a tag push ran `ci.yml` with its four main jobs skipped, and GitHub treats a
skipped job as a passing status context for the SHA, which could stand in for checks that never ran). A `v*` tag push now starts only
`release-candidate.yml`; pull requests and pushes to `main` run `ci.yml` exactly as before, so the checks branch protection requires keep
their normal meaning. Still tag only commits that have already passed `ci.yml` on `main`. `--ci-run=auto` accepts only a `ci.yml` run
with `event` `pull_request`, or `push` on `main` (the only branch `ci.yml` pushes run on), `conclusion: success` and `headSha` equal to the commit; `workflow_dispatch` runs,
legacy `v*` tag-push runs from before AF1 and runs for other commits are ignored. Because no successful `ci.yml` run
exists for a tagged commit in that case, `--ci-run=auto` falls back (hosted CI only, `GITHUB_ACTIONS=true` and a numeric `GITHUB_RUN_ID`
for this commit) to recording the current run with `ci_lookup.ci_run_origin: "hosted-ci-self"` and a `SELF-REFERENTIAL` note. That run
was still in progress when recorded: it is a pointer to the build itself, **not** evidence that the `ci.yml` checks passed, carries no
`conclusion`, and `verify-release` prints a warning for it. Outside hosted CI no such record is invented (`ci_run_id` stays `null`).

**Maintainer flow: download artifact, ingest, commit.** The log line is never pushed back by CI:

```
gh run download <run-id> --dir <empty dir>                                           # untrusted download; inspect before use
node scripts/evidence-log-ingest.mjs --line <empty dir>/<artifact>/evidence-log-line.jsonl   # optional: --log <repo log> (default docs/release/EVIDENCE-LOG.jsonl)
git diff docs/release/EVIDENCE-LOG.jsonl     # then stage and commit the one new line
```

`evidence-log-ingest` appends under the same lock as `release-candidate --log` and refuses (exit 1, log unchanged) unless the file is
exactly one canonical line with `built_by: hosted-ci` and `signature: null`, `prev` equal to the current log tail hash (genesis for an
empty log), a candidate name not yet in the log and a non-decreasing timestamp. It does not download, sign or commit anything and does
not prove the evidence true: check the line against the run that produced it.

**托管候选未签名，正式发行须持钥者在受控机器重签** (hosted candidates are unsigned: `built_by: hosted-ci`, `signature: null`;
the job never holds `GML_RELEASE_SIGN_KEY`). The artifact is a development candidate, not release or production acceptance.

**Status (AF1, 2026-10-24): not run; no run is recorded.** The workflow file exists only on unmerged branches, and `workflow_dispatch` uses the
workflow file on the ref, so it cannot be dispatched on `main` until merged; nothing was dispatched, there is no run
id, and no hosted-candidate result is recorded here. After the merge, dispatch it once (`gh workflow run release-candidate.yml --ref main`),
poll with `gh run view <id>`, and record run id, conclusion, duration and the three uploaded files; the first run is unverified.

**Status (AF8, 2026-10-24): still not run; no run is recorded.** `main` (commit `a524d3b`) still has only `checks`, `docker` and
`regression` in `ci.yml` (no `candidate`, `capacity-smoke`, `dependency-review` or `audit-no-fts5`) and no `nightly-capacity.yml`.
PRs #1 to #3 are merged; #4 to #9 are open and unmerged; `gh` cannot find a PR #10. Dispatched 0 times; no run id exists.

**Status (AG8, 2026-10-24): still not run; no run is recorded.** `main` (commit `a524d3b`) has only `ci.yml` (`checks`, `docker`,
`regression`) and `linux-validation.yml`; `release-candidate.yml` and `nightly-capacity.yml` return HTTP 404 there. PRs #1 to #3 are
merged; #4 to #10 are open and unmerged; PR #11 could not be found (HTTP 404). Dispatched 0 times (no `dry_run` run, no full run); no run id exists.

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

## Supply-chain self-checks (AF7)

Two steps of the hosted candidate job (after the self-verify step, before the upload) check the dependency supply chain. Both are
read-only toward the repository and need network access.

- **`npm audit signatures --registry=https://registry.npmjs.org`** verifies the registry signatures (and provenance attestations
  where published) of the installed packages. A verification failure **fails the job**. The registry is given on the command line
  because `.npmrc` points installs at `registry.npmmirror.com`, which has no audit or signature endpoint. Consequence, stated
  honestly: with that override, a local run audited 42 packages against 36 npmjs.org lockfile entries (341 entries resolve from
  npmmirror), so the npmmirror-resolved entries are probably **not** covered, but npm's selection logic is not a guarantee and the
  check verifies registry metadata by name and version; it does not bind the installed tarball to the signed integrity. `audit-signatures.txt` therefore ends with the lockfile entry count per registry
  host next to npm's own "audited N packages" summary. A local run on 2026-10-24 reported 42 packages with verified signatures and
  13 with verified attestations (lockfile: 36 npmjs.org entries, 341 npmmirror.com entries). Moving the remaining entries to the
  npmjs registry is a separate decision (it changes `package-lock.json` and install reachability).
- **SBOM diff vs the previous candidate artifact.** The step looks up the newest earlier successful run of the candidate workflow
  on `main` or on a `v*` tag with event `push` or `workflow_dispatch` (pull-request runs and runs from other branches are ignored, the current run is excluded), downloads its
  `os-erp-candidate-*` artifact with `gh run download`, and diffs its SBOM (`sbom.cdx.json`, or for artifacts from before AF7 the single
  `<package>/release/sbom.cdx.json` entry of the zip) against this package's SBOM with `scripts/sbom-diff.mjs`. If no such run or
  artifact exists (14-day retention), the output says **first candidate**. The downloaded content is treated as data only: it is
  parsed as JSON with a 32 MB cap, never executed, and the table is sanitised against control characters. A malformed previous SBOM is
  reported in `sbom-diff.txt` and as a warning but does not fail the build. The uploaded artifact additionally carries
  `sbom.cdx.json`, `sbom-diff.json`, `sbom-diff.txt` and `audit-signatures.txt`.

Manual use, anywhere:

```
node scripts/verify-release.mjs --sbom-diff <previous.cdx.json>          # run in the extracted package; prints the table and a sbom-diff-json line
node scripts/sbom-diff.mjs <previous.cdx.json> [<current.cdx.json>] [--json-out=<file>] [--table-out=<file>]
```

Both use `scripts/lib/sbom-diff.mjs`. Components are keyed by `group/name`; a name only on one side is added/removed, a different
version set is a `version` change, and the same `name@version` with a different integrity hash on both sides is an `integrity`
change (the one to look at first). Exit code is 0 with or without differences; it is non-zero only when the previous (or current)
SBOM is missing, unreadable or not a structurally valid CycloneDX 1.x document (or, for `verify-release`, when any other check fails).
This is an informational comparison, not a vulnerability or licence analysis, and the hosted steps have not run on GitHub yet.
