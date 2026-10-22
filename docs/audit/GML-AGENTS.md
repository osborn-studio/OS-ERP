# GML Delivery Rules

For every completed code update requested by Lin Xinlan:

- Update the product version in package.json and package-lock.json as appropriate, and maintain docs/本地交付/07_版本记录与交付规范.md.
- Verify in isolated copies without overwriting existing demo or customer databases. Report failed or untested scope honestly.
- Commit only task-related files and synchronize the completed changes to osborn-studio/gml on GitHub. Never force-push or discard unrelated changes.
- Produce one versioned full delivery ZIP containing the source installation package, all current manuals, release notes, safe verification records, and SHA256 checksums.
- Publish the matching versioned GitHub Release and provide both the local delivery link and release URL. Preserve previous release packages and distinguish the latest version.
- Do not include databases, real customer data, credentials, environment secrets, or logs containing tokens in the delivery.
- Do not describe delivery as complete until the remote commit and published package have been verified. If GitHub synchronization is blocked, report it explicitly.

Use the detailed checklist in docs/本地交付/07_版本记录与交付规范.md.
