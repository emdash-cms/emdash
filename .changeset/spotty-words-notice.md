---
"emdash": patch
---

Improves plugin safety: hooks log dependency cycles, timeouts clear timers, routes don't leak error internals, one-shot cron tasks retry with exponential backoff (max 5), marketplace downloads validate redirect targets.
