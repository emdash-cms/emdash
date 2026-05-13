---
"emdash": minor
"@emdash-cms/admin": minor
---

Adds experimental support for the decentralized plugin registry (see RFC #694). Configure with `experimental.registry.aggregatorUrl` in `astro.config.mjs`; the admin UI then uses the registry instead of the centralized marketplace for browse and install. Marketplace behavior is unchanged when the option is not set.

The experimental config accepts a `policy.minimumReleaseAge` duration (e.g. `"48h"`) that holds back releases below that age from install and update prompts, with a `policy.minimumReleaseAgeExclude` allowlist for trusted publishers or specific packages. The minimum-release-age check is enforced both client-side (for UX) and server-side (in the install endpoint), so stale browser tabs and deep links still hit the gate.
