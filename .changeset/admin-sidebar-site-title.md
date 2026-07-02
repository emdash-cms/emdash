---
"emdash": minor
---

Brands the admin with the site's own title when no build-time `admin.siteName` is configured. The admin sidebar previously always showed "EmDash", so operators running several EmDash backends couldn't tell them apart at a glance. The manifest now falls back to the Site Title (Settings → General, then the title captured during setup), WordPress-style. An explicit `admin.siteName` still wins, and sites with neither keep the "EmDash" default.
