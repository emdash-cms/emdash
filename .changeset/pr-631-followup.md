---
"emdash": patch
---

Fixes two correctness issues from the #631 cold-start work:

- `ensureSearchHealthy()` now runs against the runtime's singleton database instead of the per-request session-bound one. The verify step reads, but a corrupted index triggers a rebuild write, and D1 Sessions on a GET request uses `first-unconstrained` routing that's free to land on a replica. The singleton goes through the default binding, which the adapter correctly promotes to `first-primary` for writes.
- The playground request-context middleware now sets `dbIsIsolated: true`. Without it, schema-derived caches (manifest, taxonomy defs, byline/term existence probes) could carry values across playground sessions that have independent schemas.
