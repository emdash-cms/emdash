---
"emdash": patch
---

Fixes MCP server endpoint being enabled by default when the docs state it is disabled by default. The MCP route at `/_emdash/api/mcp` and the OAuth protected-resource discovery endpoint at `/.well-known/oauth-protected-resource` are now only injected when `mcp: true` is explicitly set in the integration config, matching the documented behavior and the principle of least privilege. The authorization-server metadata at `/.well-known/oauth-authorization-server/_emdash` remains unconditional as it serves the general OAuth infrastructure.
