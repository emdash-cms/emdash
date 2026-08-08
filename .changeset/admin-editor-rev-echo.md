---
"@emdash-cms/admin": patch
---

The admin content editor now echoes the `_rev` token from content API reads into its update requests, so the server's optimistic concurrency check can refuse a stale save with a 409 instead of silently overwriting a newer draft revision. On a conflict the stale token is dropped so the editor's refetch re-arms the check. Saves made before any read (no known token) still behave as before.
