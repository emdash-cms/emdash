---
"emdash": minor
---

Adds a `WebMcpSearch` component (`emdash/ui/webmcp-search`) that lets AI agents in a visitor's browser search your published content. In browsers that support WebMCP, it registers a read-only `search_site` tool backed by the public search API and returns titles, absolute URLs, and plain-text excerpts. It accepts the same `collections`, `locale`, `limit`, and `routeMap` props as `LiveSearch` and does nothing in other browsers.
