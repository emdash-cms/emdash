---
"@emdash-cms/plugin-cli": patch
---

Fixes plugin builds failing when MCP tools use Zod schemas. The plugin CLI now evaluates those schemas when it extracts registry metadata, then omits schema code used only by MCP metadata from the sandbox runtime bundle. Hooks and routes can continue to use Zod at runtime, and plugin authors do not need to change their source.
