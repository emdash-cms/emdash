---
"create-emdash": patch
---

Fix create-emdash to use all available templates from the new standalone templates repo. Templates are now selected in two steps: platform (Node.js or Cloudflare Workers) then template type (blog, starter, marketing, portfolio, blank). Downloads from `emdash-cms/templates` instead of the old monorepo path.
