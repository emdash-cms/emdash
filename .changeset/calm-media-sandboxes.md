---
"emdash": minor
"@emdash-cms/plugin-types": minor
"@emdash-cms/cloudflare": minor
"@emdash-cms/sandbox-workerd": minor
"@emdash-cms/plugin-test": minor
"@emdash-cms/plugin-cli": minor
"@emdash-cms/registry-lexicons": minor
"@emdash-cms/admin": minor
---

Adds separate sandboxed-plugin capabilities for reading media bytes and editing media metadata.

Declare `media:bytes:read` to use `ctx.media.readBytes()`. Reads are available only for ready media, default to a 10 MiB limit, enforce the caller's limit while consuming the storage stream, and cannot request more than 16 MiB. The result includes the content hash; ordinary `media:read` metadata excludes content hashes, storage keys, and author identity.

Ready-media metadata URLs use an authenticated media ID route. Authenticated callers with the `media:read` permission can fetch the asset without receiving its storage key; logged-out requests are rejected before the route queries media.

Declare `media:metadata:write` to use `ctx.media.updateMetadata()` for alt text, captions, and focal points. This capability cannot upload, replace, move, or delete media. It does not imply `media:read` or `media:bytes:read`.

`@emdash-cms/plugin-test` also provides binary media fixtures and inspection through the runtime-backed host so plugin tests can exercise the production Worker Loader bridge.
