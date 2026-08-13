---
"@emdash-cms/admin": patch
"@emdash-cms/cloudflare": patch
"emdash": patch
---

Fix media previews for streaming providers such as Cloudflare Stream, whose items have no directly playable file URL.

Streaming items report their poster as `previewUrl` and their playback sources as `meta.playback = { hls, dash }`. Consumers assumed a flat, fetchable `src`, so provider-backed video showed no thumbnail in the library and a permanently-0:00 player in the detail panel.

- Media library grid and list rows no longer gate thumbnails on an `image/*` mime type — `previewUrl` is a poster that video items have too.
- The detail panel plays a streaming item's HLS/DASH sources and uses its thumbnail as the poster, instead of treating the thumbnail URL as a video file. Locally stored video is unchanged.
- Provider items may report `size` in `meta`; it is now read from there when absent as a first-class field, so streaming assets show a real file size.
- The Cloudflare Stream provider's `getEmbed()` now prefers `previewUrl` for the poster. `list()` and `get()` never set `meta.thumbnail`, so posters were dropped for every value produced by the media picker.
- `EmDashMedia` is now reachable as `Media` from `emdash/ui`. It resolves the media provider before rendering, so it can emit markup for video whose URLs are not a flat `src`. It was already in the public components barrel and `getMediaProvider` exists specifically so it can render on the frontend, but it was never re-exported from the `emdash/ui` entrypoint and there is no `./components` subpath to deep-import through — so no consumer could actually reach it. `Image` is not a substitute: it only handles `embed.type === "image"` and emits a broken `<img>` for a Stream value.

The detail panel relies on native HLS playback and ships no player library. Chromium and Safari both report `canPlayType("application/x-mpegURL") === "maybe"` and play a Stream manifest directly, verified on Chrome 150 and Chromium 148. The DASH source is a declarative fallback only, as Chromium reports no native support for `application/dash+xml`.
