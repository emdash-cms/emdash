---
"emdash": patch
---

fix(core): apply baseline security headers set-if-absent so host-set values win (#1393)

`finalizeResponse()` unconditionally set `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` on every response. Because the middleware registers with `order: 'pre'` (#1282), on the response path it runs after the host app's own middleware, so it overwrote any of these headers the host had already set on its public routes — letting the CMS dictate the security headers of the entire host site.

These three headers are now applied set-if-absent (`if (!res.headers.has(name))`), matching the existing `Content-Security-Policy` guard, so a host that sets a stricter value (e.g. an extended `Permissions-Policy`) on its own routes wins. EmDash still provides its baseline defaults when the host sets nothing.
