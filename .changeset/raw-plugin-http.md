---
"emdash": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
---

Adds raw request bodies and custom HTTP responses to the Plugin API for native and sandboxed routes.

Set `body: "text"` or `body: "bytes"` on a route to receive a UTF-8 string or the original body bytes in `ctx.input` (`routeCtx.input` for sandboxed handlers). Body modes infer `string` or `Uint8Array` handler inputs. Omit the option to keep existing JSON and query-string decoding.

Both body modes buffer the request body. For webhook signatures, use bytes mode, verify the original bytes, then parse and validate the payload.

Return a Web API `Response` to serve text, XML, binary data, redirects, or custom status codes and headers without the JSON envelope. The Node sandbox buffers response bodies for transport. Successful GET/HEAD responses honor the route's `cacheControl` option, then an explicit response header, and default to `Cache-Control: private, no-store`. Route URLs remain under `/_emdash/api/plugins/<slug>/`.

Rebuild sandboxed plugins after setting a body mode so their generated manifests include the option.
