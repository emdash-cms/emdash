---
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/registry-client": minor
"@emdash-cms/admin": patch
"emdash": patch
---

Adds a fail-closed first-release exemption to the plugin registry's optional minimum release age policy. A package's first release can install immediately only when the aggregator reports exactly one retained release and confirms that it continuously observed the package's release history.

Existing packages, backfilled packages, and packages with missing or incomplete history remain subject to the configured holdback. Deleted releases still count, and explicit publisher or package exemptions continue to work.
