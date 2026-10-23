# Source provenance and unresolved rights

Source: https://github.com/osborn-studio/gml
Commit: a80b007494b20e8dc801d063f285e87145cbe15e
Import: verified 777-file current-tree snapshot; no historical commits imported. Audit and upstream policy retained under docs/audit.

The user requested this private development repository. This does not establish permission for public open-source redistribution. No project license has been selected or invented.

Pending: original/contributor/contract rights; confirmation that the Medusa, Medici and Casbin versions pinned below are the ones the original authors actually consulted (the pins are the latest releases on or before 2026-10-15, not proof of what was read); notices; dependencies/native artifacts/frontend bundle; images, icons, documents and historical delivery archives. See handoff.md section 4 and the original commercial feasibility report.

## Upstream reuse provenance (X12)

This section records evidence only. It is not a legal opinion, a clearance, or a determination of copyright status; no conclusion about infringement, license compliance or ownership is stated or implied. Rights decisions remain with the owner and counsel.

### Pinned upstream versions

Selection rule: the latest non-draft, non-prerelease GitHub release whose `published_at` is on or before 2026-10-15, read with `gh api` (public repositories, read-only) on 2026-10-23. The license text at each commit is stored unmodified beside a `SOURCE.json` under `docs/legal/upstream/<project>/`.

| Project | Repository | Tag (published) | Commit | License as declared at that commit | Stored copies |
| --- | --- | --- | --- | --- | --- |
| Medusa | `medusajs/medusa` | `v2.21.2` (2026-09-28T10:08:32Z) | `020565398e436a2bc65777a3b1ad347b4735d6df` | `LICENSE` states the repository is MIT except Enterprise Edition materials identified in `ENTERPRISE-LICENSE.md`; the GitHub API reports `NOASSERTION` | `docs/legal/upstream/medusa/LICENSE`, `ENTERPRISE-LICENSE.md`, `SOURCE.json` |
| Medici | `flash-oss/medici` | `v7.2.0` (2025-07-11T03:04:46Z) | `bd97047ce4dc582ca506886e18bc99d7b4e583fa` | MIT | `docs/legal/upstream/medici/LICENSE`, `SOURCE.json` |
| node-casbin | `casbin/node-casbin` (GitHub redirects to `apache/casbin-node-casbin`) | `v5.51.1` (2026-06-25T15:58:12Z) | `2d90c7d8c3b522415605cf3d25481e763e73381e` | Apache-2.0 | `docs/legal/upstream/casbin/LICENSE`, `SOURCE.json` |

Recorded gaps and observations:

- Medusa: the later release `v2.22.0` (2026-10-21) is after the cutoff and was not used. `ENTERPRISE-LICENSE.md` at the pinned commit lists RBAC and SSO paths as Enterprise Materials. None of the three Medusa files referenced below is under a path listed there. That is a path-level observation of the listing, not a conclusion about the files' license status.
- node-casbin: no `NOTICE` file exists at the pinned commit (HTTP 404 on fetch); one exists on the default branch at fetch time. It is not stored, because it is not part of the pinned version. This is recorded in `SOURCE.json` `failures`.
- The original `_ref/` checkouts that the source comments refer to are not in this repository, so the version the original authors consulted is unknown. Line references in the source comments agree with the pinned files: `sortByBuyGetType` is at `buy-get.ts:645`; `appliedPromotionsMap` is used from `line-items.ts:127`; `registerUsage` has `orderBy("id")` + `forUpdate()` inside `promotion-module.ts:336-372`; the `eval(p.sub_rule...)` matcher is at `enforcer.test.ts:595`. This supports, but does not prove, that nearby versions were read.
- In `ledger.js` the comments name medici's `voidJournal`. At `v7.2.0` the method is `Book.void` in `src/Book.ts`; `src/Book.ts` is therefore included as referenced by description, not by path.
- Each upstream file's `sha256`, git blob SHA and byte size are in `SOURCE.json` so a re-fetch can be checked. The upstream source files themselves are deliberately not stored in this repository.

### Similarity method (read before using the numbers)

`scripts/upstream-similarity.mjs` strips comments, splits identifiers into lowercase sub-words (camelCase and snake_case alike), and compares two files by (a) Jaccard overlap of the distinct sub-word sets and (b) overlap of distinct 5-sub-word shingles, reported both as the share of the local file's shingles found in the upstream file ("local in upstream") and the share of the upstream file's shingles found in the local file ("upstream in local"). It does not parse syntax, ignores string contents and whitespace, and does not treat keywords specially.

What it cannot show: renaming, reordering, rewriting in another language (TypeScript to JavaScript) or restructuring lowers the numbers while an idea or structure can still be derived from the source; generic fragments raise them. A low value does not show independent creation and a high value does not show copying. Unigram Jaccard depends heavily on file length and shared vocabulary and is shown only for completeness; as a noise-floor reference, unrelated pairs (for example `rbac.js` against Medusa `buy-get.ts`, `ledger.js` against Medusa `line-items.ts`, `promotion-engine.js` and `ledger.js` against the Casbin test file) measured 0.00% on 5-shingles and 9.62% to 18.22% unigram Jaccard.

Labels used below are a documentation convention chosen for this table, not a legal or industry standard: "copy-and-adapt (复制改写)" is applied when "local in upstream" is at least 20%; otherwise "design reference (设计参考)". The label describes measured text overlap together with what the file's own header says; it is not a finding about rights.

### Per-file results

| Local file | Upstream file (at pinned commit) | 5-shingle local in upstream | 5-shingle upstream in local | Unigram Jaccard | Label |
| --- | --- | --- | --- | --- | --- |
| `reusable/promotion/promotion-engine.js` | `packages/modules/promotion/src/utils/compute-actions/buy-get.ts` | 0.41% (5/1216) | 0.28% (5/1786) | 29.82% | design reference |
| `server/lib/promotion.js` | `packages/modules/promotion/src/utils/compute-actions/buy-get.ts` | 0.19% (7/3717) | 0.39% (7/1786) | 25.19% | design reference |
| `reusable/promotion/promotion-engine.js` | `packages/modules/promotion/src/utils/compute-actions/line-items.ts` | 0.33% (4/1216) | 0.55% (4/732) | 31.15% | design reference |
| `server/lib/promotion.js` | `packages/modules/promotion/src/utils/compute-actions/line-items.ts` | 0.16% (6/3717) | 0.82% (6/732) | 23.96% | design reference |
| `reusable/promotion/promotion-engine.js` | `packages/modules/promotion/src/services/promotion-module.ts` | 0.00% (0/1216) | 0.00% (0/4564) | 32.30% | design reference |
| `server/lib/promotion.js` | `packages/modules/promotion/src/services/promotion-module.ts` | 0.03% (1/3717) | 0.02% (1/4564) | 30.70% | design reference |
| `reusable/ledger/ledger.js` | `src/helper/addReversedTransactions.ts` | 0.00% (0/712) | 0.00% (0/114) | 12.21% | design reference |
| `reusable/ledger/ledger.js` | `src/models/transaction.ts` | 0.00% (0/712) | 0.00% (0/309) | 19.75% | design reference |
| `reusable/ledger/ledger.js` | `src/Book.ts` | 0.00% (0/712) | 0.00% (0/1194) | 20.99% | design reference |
| `reusable/rbac/rbac.js` | `examples/rbac_with_domains_model.conf` | 0.00% (0/894) | 0.00% (0/42) | 4.71% | design reference |
| `reusable/rbac/rbac.js` | `test/enforcer.test.ts` | 0.00% (0/894) | 0.00% (0/2066) | 14.51% | design reference |

Per-file notes:

- Promotion: the header of `promotion-engine.js` says three designs were taken from Medusa (the buy-get ordering comparator, the per-line applied-amount map, the usage-registration locking) and rewritten for SQLite and integer cents; the code in `applyToItems` is described as following the skeleton of Medusa's `line-items.ts`. The measured overlap is small. The few shared 5-shingles (listed with `--shared`) are short fragments of domain vocabulary such as `method buy rules min quantity`, `allocation once remaining quota 0` and `map get item id`. `promotion-module.ts` shares nothing with `promotion-engine.js` and one fragment (`promotion rules promotion id rule`) with `server/lib/promotion.js`. The structural adaptation stated in the header is a design-level statement that this metric cannot confirm or refute.
- Ledger: the header describes adopting medici's data structure (journal and transaction tables, debit and credit on the same row, account path, reversal by writing an opposite journal). Measured text overlap is zero. The reversal in `addReversedTransactions.ts` (swap debit and credit) is a one-line idea that the comparison cannot distinguish from independent derivation.
- RBAC: the header states design reference only and no runtime dependency; measured overlap is zero. The Casbin test file is cited in the header only as the place where an `eval(p.sub_rule...)` matcher appears; `eval(p.sub_rule_1)` does appear at `test/enforcer.test.ts:595` of the pinned commit.
- Scope: only the files named in the source comments and `reusable/README.md` were compared. Other upstream files, other local files, earlier upstream versions and history were not compared, so absence of overlap here says nothing about them.

To reproduce a row: fetch the upstream file at the pinned commit (`gh api -H "Accept: application/vnd.github.raw" "repos/<repo>/contents/<path>?ref=<commit>"`), check its `sha256` against `SOURCE.json`, then run `node scripts/upstream-similarity.mjs <local-file> <upstream-file> [--shared]`.
