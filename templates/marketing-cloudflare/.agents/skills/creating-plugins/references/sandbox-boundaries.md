# Sandbox boundaries

Registry plugins run against a capability-gated host API, not the complete trusted EmDash runtime. Design within the exported `PluginContext` and hook vocabulary. Do not infer a sandbox API from an internal repository or admin endpoint.

## Cross-runner transport caveats

### Encrypted settings require operator key material

The generated admin form and sandbox `ctx.settings` share one plugin-scoped namespace across both runners. A field declared as `secret` is encrypted with `EMDASH_ENCRYPTION_KEY` and remains write-only in admin responses. If the matching key is unavailable or the envelope is tampered with, reads fail instead of returning ciphertext or an empty value. Restore the database together with the encryption-key list. Existing `ctx.kv.get("settings:<key>")` reads remain a compatibility alias through EmDash 0.x.

### Cloudflare HTTP response bodies are text-decoded

`ctx.http.fetch()` returns a real WHATWG `Response` in both runners. Node/workerd transports the upstream response bytes as base64 and reconstructs the response from bytes. The Cloudflare bridge calls `text()` and reconstructs the response from that string.

Use `text()` and `json()` for portable responses. Arbitrary binary data read through `arrayBuffer()` or `blob()` is not byte-preserving on Cloudflare yet.

### `page:fragments` is excluded at runtime

The sandbox authoring type and manifest schema accept `page:fragments`, and the plugin CLI emits a trusted-only warning rather than rejecting the bundle. The host sandbox proxy drops the hook before registration. Registry plugins can use validated `page:metadata` contributions, but cannot inject raw HTML, scripts, or styles.

## APIs that are not available

The following surfaces do not exist in the current sandbox contract. Do not invent bridge calls, use internal REST routes as substitutes, or claim registry portability for them.

### Content lifecycle and policy

- `ctx.content` has `get`, `list`, `create`, `update`, and `delete`. It has no publish, unpublish, schedule, unschedule, trash, or restore methods.
- Content hooks observe saves, deletes, and completed publication-state changes. There are no pre-publish, pre-unpublish, pre-schedule, or pre-restore policy hooks that can approve, reject, or transform those operations.
- Content save events may include `actor: { id, role }`, but they do not include the actor's origin. A hook cannot distinguish REST, visual editing, MCP, or another authenticated path from the actor snapshot.
- `ctx.content.create()` accepts `{ locale, translationOf }` to add an active locale to an existing entry's translation group. It cannot create a second active entry for the same group and locale. `ctx.content.getTranslations()` lists the active locale siblings.

### Schema and taxonomies

- There is no schema or collection-definition listing API on `PluginContext`.
- `ctx.taxonomies` is read-only. It cannot create, update, delete, reorder, or assign terms.

### Comments and media

- `ctx.comments` excludes trashed comments and linked user-account IDs. It cannot delete comments or replace statuses in bulk. `setStatus()` accepts only `approved`, `pending`, and `spam` and requires the status observed by the caller.
- `ctx.media.get()` and `list()` return ready-media metadata and an authenticated ID-based asset URL without storage keys, author identity, content hashes, or bytes. Logged-out asset requests stop in authentication middleware before the route queries media.
- `media:bytes:read` grants buffered byte reads from ready media. Reads default to 10 MiB, cannot request more than 16 MiB, and enforce the limit while consuming the storage stream. Content hashes are returned only with this authority.
- `media:metadata:write` changes only alt text, caption, and a complete focal-point pair. Upload, replacement, movement, and deletion remain under other authority.

### Routes, public access, and admin UI

- Plugin routes return JSON-serializable data inside EmDash's API envelope. There is no raw or unwrapped route response that controls the status, stream, or arbitrary headers.
- `public: true` removes host authentication from the route. There is no separate safe-public-view abstraction that automatically limits fields or capabilities; validate requests and return the minimum public data.
- Block Kit has buttons and form controls, but no navigation-link element and no content-editor panel extension point.
- The sandbox context exposes the site locale, not the current administrator's UI locale. Registry plugins receive no admin-locale context or translation catalog callback.

## Runner-only methods are not portable

The Node/workerd wrapper currently contains `ctx.content.createMany()`, `updateMany()`, and `deleteMany()`. These methods are absent from the public types and Cloudflare wrapper. Do not use them in a registry plugin.
