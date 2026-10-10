---
"emdash": patch
"@emdash-cms/admin": patch
---

Fixes MCP tool names for plugins with scoped IDs such as `@acme/calendar`: their tools are listed as `acme__calendar__<tool>`, which MCP clients accept. Update saved calls that use the old scoped names. Plugins with plain IDs keep their names, and the admin plugin list displays the generated names before consent.

A plugin tool whose JSON Schema cannot be read no longer stops other tools from loading. Unreadable input schemas accept object inputs for route validation; unreadable output schemas are omitted. Duplicate generated names keep the first tool and log a warning instead of disabling the MCP endpoint.
