---
"emdash": patch
---

Fixes the admin stylesheet leaking onto public routes in `astro dev`. The compiled Kumo/Tailwind theme was injected into every page's `<head>`, overriding host `:root` tokens (`--text-base`, `--text-lg`, ...) and styling otherwise-unstyled pages. The admin shell now loads its stylesheet as a route-scoped `<link>`, so public routes are unaffected — matching production behaviour.
