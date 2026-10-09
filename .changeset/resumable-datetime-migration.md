---
"emdash": patch
---

Fixes the datetime normalization migration taking hours on large Cloudflare D1 sites and starting over after every interruption. It now writes changed rows in batches, and running `emdash migrate` again after a failed write continues from the last written batch.
