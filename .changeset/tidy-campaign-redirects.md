---
"emdash": patch
---

Fixes redirect rules dropping request query strings, preserving campaign parameters such as `utm_source` and `gclid` on short and legacy URLs. Request parameters are passed through before any destination fragment unless the destination specifies its own query string (including an empty `?`), which takes precedence without merging. To discard incoming parameters for a rule, end its destination path with `?` before any fragment. Redirect responses opt out of route caching so cache keys that omit tracking parameters cannot mix visitors' query strings. Terminal 410 and 451 responses remain unchanged.
