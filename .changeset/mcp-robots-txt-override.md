---
"emdash": patch
---

Fixes the MCP `settings_update` tool reporting success for `seo.robotsTxt` and `seo.disallowAiTraining` on sites with their own `src/pages/robots.txt`. That file replaces EmDash's `/robots.txt`, so these settings never took effect. The tool now rejects changes to them with `ROBOTS_TXT_OVERRIDDEN` and stores nothing. Sending the stored values back unchanged, or clearing them with `""` or `false`, still works.
