---
"emdash": patch
---

Fixes registry plugin updates ignoring `policy.minimumReleaseAge`. Updating an installed plugin to a release younger than the configured age, or to a release without a valid index timestamp, is now refused, just as installing it is. Publishers and packages listed in `minimumReleaseAgeExclude` remain exempt.

The admin update endpoint (`POST /_emdash/api/admin/plugins/registry/:id/update`) now refuses a `version` older than the installed one with `DOWNGRADE_NOT_ALLOWED`; the admin dashboard never sends one, so dashboard updates are unaffected. Updates without `version` still follow the aggregator's latest release, which can be older than the installed one after a publisher withdraws the newest release. To roll back to an older release, uninstall the plugin and install that version.
