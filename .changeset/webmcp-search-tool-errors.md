---
"emdash": patch
---

Fixes the `WebMcpSearch` component's `search_site` tool so agents can tell a failed search from an empty one. An empty query, an HTTP error or a network failure now fails the tool call, where it previously reached the agent as a successful result. Results now arrive as a JSON array of `{ title, url, collection, excerpt }` objects, without a JSON-encoded string nested inside.
