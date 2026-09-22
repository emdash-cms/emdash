---
"emdash": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/registry-verification": patch
"@emdash-cms/admin": patch
---

Fixes registry plugins appearing in discovery but failing installation when their signed profiles predated repository metadata.

Profiles without the optional repository extension permit releases without provenance. Manual publishing adds an available canonical HTTPS repository with optional provenance, preserves explicit profile policies on later releases, and refuses manual releases when the publisher requires provenance. EmDash routes installation verification correctly and shows site administrators actionable publisher guidance when signed records fail verification.
