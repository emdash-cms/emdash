---
"emdash": patch
---

Fixes the MCP `settings_update` tool to reject `seo.robotsTxt` with a clear error when the host project overrides the injected `/robots.txt` route with its own `src/pages/robots.txt.*` file. Previously the write succeeded and was silently ignored because the injected route — the only consumer of that setting — was suppressed.
