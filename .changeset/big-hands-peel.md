---
"@emdash-cms/plugin-cli": minor
---

Adds `emdash-plugin update-profile`, a CLI command for editing an already-published plugin profile (license, authors, security contacts, name, description, keywords) without cutting a new release. Without `--yes` it prints a diff and exits without writing. With `--yes` it writes the updated profile to the publisher's PDS and bumps `lastUpdated`. Renaming a plugin via the manifest now surfaces a clear "looks like a rename" message instead of a generic not-found, so publishers don't accidentally orphan releases under the old slug.
