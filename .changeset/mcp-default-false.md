---
"emdash": patch
---

Fixes MCP server endpoint being enabled by default when the docs state it is disabled by default. The MCP route at `/_emdash/api/mcp` and its OAuth discovery endpoints are now only injected when `mcp: true` is explicitly set in the integration config, matching the documented behavior and the principle of least privilege.
