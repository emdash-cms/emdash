---
"emdash": patch
---

Adds an optional `urlTemplate` prop to the `core:recent-posts` widget (e.g. `"/blog/:slug"` or `"/:slug"` for catch-all routes), using the same `:collection`, `:id`, `:slug`, and `:path` tokens as LiveSearch's `routeMap`. Without a template the widget links exactly as before.
