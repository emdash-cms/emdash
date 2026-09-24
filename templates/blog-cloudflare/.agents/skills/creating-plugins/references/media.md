# Media access

Keep media authority as narrow as the plugin's behavior permits.

| Capability             | Access                                                     |
| ---------------------- | ---------------------------------------------------------- |
| `media:read`           | Ready-media metadata and authenticated ID-based asset URLs |
| `media:bytes:read`     | Bounded original bytes and content hashes                  |
| `media:metadata:write` | Alt text, caption, and complete focal-point updates        |
| `media:write`          | Upload and delete; implies `media:read`                    |

`media:read` metadata includes dimensions, alt text, caption, focal point, blurhash, dominant color, and folder ID. It excludes storage keys, author identity, content hashes, and bytes. Logged-out asset requests stop at authentication before the media lookup.

`ctx.media.readBytes(id, { maxBytes })` buffers from the configured storage adapter. The default limit is 10 MiB and callers cannot request more than 16 MiB. The host enforces the limit while consuming the stream rather than trusting stored size metadata.

`ctx.media.updateMetadata()` changes only alt text, caption, and a complete focal-point pair. It cannot upload, replace, move, or delete the underlying file.

With `media:write`, upload bytes through the bridge:

```typescript
const bytes = await source.arrayBuffer();
const uploaded = await ctx.media!.upload("report.pdf", "application/pdf", bytes);
```

Both sandbox runners write through the configured media adapter and create a ready record. A sandbox does not follow a presigned upload URL directly.
