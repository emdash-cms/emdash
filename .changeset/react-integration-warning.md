---
"emdash": patch
---

Warns at build time when `@astrojs/react` is not registered in the Astro config. Without it the admin UI builds successfully but never hydrates, leaving the page stuck on "Loading EmDash..." with no error.
