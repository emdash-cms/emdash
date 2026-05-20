---
"@emdash-cms/admin": minor
"emdash": minor
---

Adds the registry plugin lifecycle: uninstall, update (with capability + public-route re-consent), and update check. Closes #1036.

- **`POST /_emdash/api/admin/plugins/registry/:id/uninstall`** removes the R2 bundle, optionally drops `_plugin_storage` rows (`deleteData: true`), and deletes the state row. Refuses non-registry sources so a marketplace plugin sharing the id namespace can't be trashed.
- **`POST /_emdash/api/admin/plugins/registry/:id/update`** re-runs the install pipeline at a newer version. Mirrors the marketplace gates: `CAPABILITY_ESCALATION` when the new version declares new capabilities and the admin has not consented, and `ROUTE_VISIBILITY_ESCALATION` when it newly exposes a public (unauthenticated) route.
- **`GET /_emdash/api/admin/plugins/updates`** is now cross-source: marketplace + registry update-check results are returned in one merged list. Either source's failure is isolated so an aggregator outage does not blank marketplace updates and vice versa.
- The admin plugin manager now renders the uninstall + update buttons for registry-source plugins (the "uninstall not yet available" placeholder is removed).
- The install handler now classifies aggregator-response errors with dedicated codes (`AGGREGATOR_RESPONSE_INVALID` for non-conforming envelopes, `AGGREGATOR_HTTP_ERROR` for non-2xx) instead of folding them into the generic `INSTALL_FAILED`.

Also backfills test coverage deferred from PR #1011: `makeRegistryPluginId` collision resistance + determinism, `verifyChecksum` hex + multibase + algorithm-mismatch paths, plus the new lifecycle handlers' error-path tests.
