---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes the admin plugin registry showing "Handle unavailable" for every publisher and scrolling sideways, so verified publisher handles now appear and unresolved publisher identifiers stay inside their cards.

A publisher whose handle no longer resolves back to its account now shows **INVALID HANDLE**, and installing its plugins from the registry detail page is disabled until the publisher fixes the handle. Plugins that are already installed keep running.
