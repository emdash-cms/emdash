---
"emdash": patch
---

Fixes widget API mutations purging cached routes and returning before the object-cache epoch write has settled. Widget edits now wait for the backend write attempt before purging routes. Workers KV propagation delays, background change-marker updates, and isolate-local epoch reuse still apply; this does not guarantee immediate cross-isolate freshness.

Code that writes widget tables directly can await `invalidateWidgetObjectCache({ waitForPersist: true })` before purging routes. The same option is available on `invalidateObjectCache(namespace, { waitForPersist: true })`. Existing calls without options remain non-blocking. Epoch writes for all namespaces now use the configured cache timeout, logging failures without failing the mutation; change-marker updates and retries remain background work.
