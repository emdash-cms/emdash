---
"emdash": patch
---

Added condition to check if getLiveEntry error is Astro's `LiveEntryNotFoundError` inside localeChain loop. This make sure to check every possible language chain before returning `LiveEntryNotFoundError` to the `error` field.
