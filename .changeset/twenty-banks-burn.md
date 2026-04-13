---
"emdash": minor
---

Enables the MCP server endpoint by default. The endpoint at `/_emdash/api/mcp` requires bearer token auth, so it has no effect unless a client is configured. Set `mcp: false` to disable.

Fixes MCP server crash ("exports is not defined") on Cloudflare in dev mode by pre-bundling the MCP SDK's CJS dependencies for workerd.
