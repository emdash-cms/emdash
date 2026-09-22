---
"emdash": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": patch
---

Adds binary-safe `ctx.http.fetch()` behavior to sandboxed plugins on Cloudflare Worker Loader and Node/workerd. Request and response bodies are buffered with an 8 MiB decoded limit, and the returned WHATWG `Response` preserves bytes, status text, headers, final URL, redirect state, and clones across both runners.

Redirected requests follow Fetch method and body rules. The Node/workerd runner also applies the installed version's current network capability and host list immediately after a plugin update.

#### Reading binary responses

Read bytes from the buffered response with the standard Response API:

```ts
const response = await ctx.http!.fetch("https://api.example.com/report");
const bytes = new Uint8Array(await response.arrayBuffer());
```

#### Testing external HTTP

`createPluginRuntimeTestHost()` adds `http.respond()`, `http.requests()`, and `http.clear()` for deterministic production-bridge tests:

```ts
await host.http.respond("https://api.example.com/report", new Response(new Uint8Array([0, 255])));
await host.transport.invokeRoute("import-report");
expect(host.http.requests()).toContainEqual(
	expect.objectContaining({ url: "https://api.example.com/report" }),
);
```
