---
"emdash": patch
---

Fixes MCP OAuth discovery and dynamic client registration so EmDash only advertises supported client registration mechanisms and rejects unsupported redirect URIs or token endpoint auth methods during client registration. Also exempts OAuth protocol endpoints (token, register, device code, device token) from the Origin-based CSRF check, since these endpoints are called cross-origin by design (MCP clients, CLIs, native apps) and carry no ambient credentials, and sends the required CORS headers so browser-based MCP clients can reach them.
