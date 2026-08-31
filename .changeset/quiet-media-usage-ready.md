---
"emdash": minor
"@emdash-cms/cloudflare": patch
---

Adds `handleMediaUsageActivationAdvance`, `handleMediaUsageProgress`, and `handleMediaUsageRepair` to the `emdash` package root so integrations can activate Media Usage, rebuild usage data, and check when indexing is ready. Playground sessions use these handlers so `Used in` results are ready when the admin opens.
