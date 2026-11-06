---
"emdash": patch
---

Fixes widget API mutations purging cached routes and returning before the object-cache epoch write has settled. Widget edits now wait for the epoch-write attempt before purging routes. This orders the epoch write only: isolates that revalidate through the site-wide change marker can still reuse an old widget epoch until the background marker update becomes visible. Workers KV propagation delays and isolate-local epoch reuse also remain; this does not guarantee immediate cross-isolate freshness.

Code that writes widget tables directly can await `invalidateWidgetObjectCache({ waitForPersist: true })` before purging routes. The same option is available on `invalidateObjectCache(namespace, { waitForPersist: true })`. Existing calls without options remain non-blocking. Epoch writes for all namespaces now use the configured cache timeout, logging failures without failing the mutation; a timed-out backend write may still complete later. Change-marker updates and retries remain background work.
