---
"emdash": patch
---

Fixes sites using `d1()` or `durableObjects()` with `session` enabled, or `hyperdrive()`, reading the preview secret and IP salt from the database on every editor page view, preview link, and comment request. `durableObjects()` without `session` did the same on write requests, such as comment submissions and reactions. Both values are now read once per isolate, as with other database adapters, so rotating one by deleting its `options` row takes effect after a redeploy.
