---
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": patch
"@emdash-cms/admin": patch
"emdash": minor
---

Fixes registry installs failing with "Plugin manifest has changed since you consented" for plugins that declare hook-registration capabilities (email transport, email events, page fragments) or read user records. Plugin bundles now declare their access as a structured `declaredAccess` contract that the registry record, the install-consent dialog, and the sandbox all read consistently, so every capability a plugin declares is shown for consent and enforced — no capability is silently dropped. Re-publish affected plugins to adopt the new bundle format; existing installs are unaffected.
