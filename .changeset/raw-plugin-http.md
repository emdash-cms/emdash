---
"emdash": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds raw request bodies and custom HTTP responses to the Plugin API for native and sandboxed routes.

Set `body: "text"` or `body: "bytes"` on a route to receive a UTF-8 string or the original body bytes in `ctx.input` (`routeCtx.input` for sandboxed handlers). Body modes infer `string` or `Uint8Array` handler inputs when no schema is declared. Omit the option to keep existing JSON and query-string decoding.

An optional `input` schema validates or transforms the decoded value before the handler runs. Sandboxed routes also enforce their declared schemas: requests that previously bypassed validation now return HTTP 400 with `VALIDATION_ERROR` when invalid. Update callers to send input matching the declared schema, or remove a schema that is not intended to be enforced. For webhook signatures, use bytes mode without an input schema, verify the original bytes, then parse and validate the payload. Both body modes buffer the request body.

Return a Web API `Response` to serve text, XML, binary data, redirects, or custom status codes and headers without the JSON envelope. The Node sandbox buffers response bodies for transport. Private routes, errors, and non-GET/HEAD responses retain `Cache-Control: private, no-store`. Public GET/HEAD responses honor the route's `cacheControl` option, then the response's header. Route URLs remain under `/_emdash/api/plugins/<slug>/`.

Rebuild sandboxed plugins after setting a body mode so their generated manifests include the option.
