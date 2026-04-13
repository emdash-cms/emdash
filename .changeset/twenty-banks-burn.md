---
"emdash": patch
---

Fixes MCP server crash ("exports is not defined") on Cloudflare in dev mode by pre-bundling the MCP SDK's CJS dependencies for workerd.
