---
"emdash": patch
---

Fixes the setup wizard staying on "Loading EmDash..." on sites whose Astro `security.csp` sets `scriptDirective.strictDynamic`. The setup page now gets the same Content-Security-Policy as the rest of the admin.
