---
"@emdash-cms/admin": minor
---

Adds an offline caching and synchronization layer using IndexedDB and optimistic mutations. Serves cached data instantly via a new `useCachedQuery` hook, syncs cache invalidation across open tabs using the Broadcast Channel API, introduces background sync logic, and supports optimistic mutation rollbacks on error.
