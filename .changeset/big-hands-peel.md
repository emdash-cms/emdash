---
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-client": minor
---

Adds `emdash-plugin update-package`, a CLI command for editing an already-published plugin's registry record (license, authors, security contacts, name, description, keywords) without cutting a new release. Without `--yes` it prints a diff and exits without writing; with `--yes` it writes the updated record to the publisher's PDS using atproto's `swapRecord` precondition (concurrent writes surface as `STALE_RECORD` instead of silently overwriting each other) and bumps `lastUpdated`. Optional fields use a "manifest absent = no change" policy: removing a key from the manifest doesn't wipe the published value, matching `publish` semantics. Renaming a plugin via the manifest now surfaces a "looks like a rename" message listing the publisher's existing packages instead of a generic not-found, so publishers don't accidentally orphan releases under the old slug.

The publishing client (`@emdash-cms/registry-client`) gains a `swapRecord` parameter on `putRecord` and `unsafePutRecord` for callers needing optimistic-concurrency writes.
