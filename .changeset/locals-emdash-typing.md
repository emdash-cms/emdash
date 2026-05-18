---
"emdash": patch
---

Fixes `Astro.locals.emdash` typing. The shipped type declaration referenced a build artifact that does not exist, so `locals.emdash` silently fell back to `any` in every EmDash site — losing autocomplete and type-checking on the handlers API in your pages and endpoints. It is now correctly typed as `EmDashHandlers`.
