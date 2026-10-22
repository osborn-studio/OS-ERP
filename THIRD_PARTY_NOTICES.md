# OS ERP — provenance and third-party notices

On 2026-10-22, the project owner instructed that this repository be renamed
from `osborn-studio/os-egp` to `osborn-studio/os-erp` and adopt the MIT License.
The root [LICENSE](LICENSE) records that project licensing decision. Existing
third-party copyright notices and applicable licenses remain in effect; this
decision does not relicense third-party dependencies or assets.

## Source provenance

The initial tree was imported from `osborn-studio/gml` at
`a80b007494b20e8dc801d063f285e87145cbe15e`. Original attribution, source comments
and the historical audit under `docs/audit/` are retained. The audit describes
the source as it existed before the owner's MIT decision; it must not be read
as a current license declaration or as proof of complete third-party clearance.

## Reference implementations identified in source

| Local paths | Declared reference and license | Verification boundary |
| --- | --- | --- |
| `reusable/promotion/promotion-engine.js`, `server/lib/promotion.js` | Medusa, `packages/modules/promotion`, MIT for the referenced component | Source comments describe a SQLite rewrite; exact referenced upstream commit and copying boundaries remain unverified. |
| `reusable/ledger/ledger.js` | Medici, MIT | Source comments describe design adaptation; exact referenced upstream commit and copying boundaries remain unverified. |
| `reusable/rbac/rbac.js` | node-casbin, Apache-2.0 | Source comments state design reference rather than a runtime dependency; exact referenced upstream commit and copying boundaries remain unverified. |

These are retained source declarations, not a completed legal determination.
Any copied third-party code must retain that version's required copyright,
license and NOTICE material. Do not replace an existing third-party notice
with the project's copyright notice.

## Dependencies, documents and media

`package-lock.json` records dependency versions and available license metadata.
The historical inventory is under `docs/audit/evidence/`. Each dependency's
actual distributed license governs that dependency; metadata alone is not a
complete license review. Images, fonts, screenshots, archived distributions
and contributed documents are not presumed to be owned by the project merely
because they appear in its tree. Unconfirmed provenance remains tracked in F01.

## Publication status

The owner has authorized public visibility. Visibility remains temporarily
private pending removal of credential-bearing historical logs and archived
runtime databases from publishable history. Adopting MIT does not certify
production readiness, authorize exposure of personal data, or close the
security findings in the audit.
