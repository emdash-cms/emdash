---
"emdash": patch
---

Fixes admin branding (logo, siteName, favicon) configured via the integration's `admin` option not being delivered to the React admin SPA. The `/_emdash/api/manifest` route now reads admin branding from the per-request config plumbed through middleware (the same source `admin.astro` already used), instead of a build-time global that was never assigned.
