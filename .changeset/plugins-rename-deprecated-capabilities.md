---
"@emdash-cms/plugin-atproto": patch
"@emdash-cms/plugin-audit-log": patch
"@emdash-cms/plugin-forms": patch
"@emdash-cms/plugin-webhook-notifier": patch
---

Updates declared capabilities to the current names (`content:read`, `content:write`, `media:read`, `media:write`, `network:request`, `network:request:unrestricted`) instead of the deprecated aliases. Plugin descriptors now report the package's own version instead of a stale hard-coded literal.
