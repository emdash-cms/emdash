---
"emdash": patch
---

Restores the existing OpenAPI, relation-definition, and content-reference HTTP endpoints in generated Astro sites. These handlers were shipped in the package but omitted from route injection, so requests returned Astro's generic `404 Not Found` instead of reaching the API.
