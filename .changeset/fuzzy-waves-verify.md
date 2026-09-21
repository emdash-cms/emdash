---
"emdash": patch
"@emdash-cms/plugin-cli": patch
"@emdash-cms/registry-verification": patch
"@emdash-cms/admin": patch
---

Fixes registry plugins published with `emdash-plugin publish` appearing in discovery but failing installation because their signed profiles lacked verification metadata.

Manual publishing now detects or requires a canonical HTTPS source repository, writes the repository anchor on first publish, preserves profile extensions on later releases, and refuses manual releases when the publisher policy requires provenance. EmDash hides incomplete profiles from public discovery, routes installation verification correctly, and shows site administrators actionable publisher guidance when signed records fail verification.
