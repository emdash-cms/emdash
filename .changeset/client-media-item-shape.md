---
"emdash": patch
---

Fixes the `MediaItem` type returned by `EmDashClient` so it describes the media items the API sends. `storageKey`, `status`, `contentHash`, `blurhash`, `dominantColor` and `authorId` are now typed, and `mediaList()` and `mediaUpload()` return items with their file `url`.

Code that reads these items may need small type changes; runtime values are unchanged:

- `key` and `updatedAt` are removed. The API never returned them, so they were always `undefined`. Read `item.storageKey`, or use `item.url` to link to the file.
- `size`, `width`, `height`, `alt` and `caption` are typed `T | null` instead of optional `T`, because the API sends `null` when they are unset. Use `item.alt ?? undefined` where a `string | undefined` is expected.
