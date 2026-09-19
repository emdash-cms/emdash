---
"emdash": minor
"@emdash-cms/admin": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds declared request and raw response contracts for sandboxed plugin routes across the native,
Cloudflare Worker Loader, and Node/workerd runtimes.

Use `methods` to have the host reject other HTTP methods with `405 Method Not Allowed`. Use
`request.body` with `json`, `text`, `bytes`, `form-data`, or `none` for bounded buffered parsing, and
list the safe request headers the handler needs. Undeclared routes retain their existing
method-agnostic JSON and query-string behavior.

Routes with `response: "raw"` return `pluginResponse()` with an unwrapped text or byte body, status,
and allowlisted representation, download, or redirect headers. Raw responses are limited to 8 MiB.
The host removes all other plugin-supplied headers, applies the route's cache and browser security
policy, and rejects active same-origin content types.

`pluginRoute()` infers a sandboxed handler's input from its declared body mode.
`definePluginRoute()` provides the equivalent inference for trusted native routes.
`createPluginRuntimeTestHost()` accepts `rawBody` for testing the production request parser with
text, bytes, URL-encoded data, and multipart form data.
