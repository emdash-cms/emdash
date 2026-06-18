---
"emdash": patch
---

Fix logged-in pages hanging indefinitely on Cloudflare Workers (#1274). A request cancelled mid-`session.get("user")` could leave the session-store read as a promise that never settles, poisoning the isolate so every later session-bearing request hung (0-CPU, multi-minute, `canceled`) — reliably reproducible on fresh isolates right after a deploy. The auth middleware now anchors the session read with `after()` so a cancelled request still drives it to completion (preventing the isolate poisoning), with a fail-closed timeout backstop that degrades a still-stalled read to "unauthenticated for this request" rather than hanging.
