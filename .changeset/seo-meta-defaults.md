---
"emdash": minor
---

Adds `defaultTitle` and `defaultDescription` options to `getSeoMeta` so pages with computed titles or descriptions can pass their own fallbacks while values set in the admin SEO panel still take precedence. Previously such pages had to drop down to `getContentSeo` and merge panel values by hand.
