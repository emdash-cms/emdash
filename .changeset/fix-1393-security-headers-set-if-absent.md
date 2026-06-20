---
"emdash": patch
---

Fixes EmDash overriding security headers set by the host site (#1393). The baseline `X-Content-Type-Options`, `Referrer-Policy`, and `Permissions-Policy` headers were applied unconditionally, overwriting stricter values a host had already set on its own routes. These headers are now applied only when the host hasn't set them — matching the existing `Content-Security-Policy` behavior — so a host's own values win while EmDash still provides defaults when none are set.
