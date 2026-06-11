---
"emdash": patch
---

perf(core): reduce sequential DB round trips during cold-isolate runtime init. Plugin-state and site-info reads now run concurrently, marketplace- and registry-installed plugin loads run concurrently when both are enabled, and exclusive hook resolution batches its per-hook option reads into a single query.
