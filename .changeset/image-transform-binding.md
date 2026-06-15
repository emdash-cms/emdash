---
"emdash": minor
"@emdash-cms/cloudflare": minor
---

Adds a binding-based image transform service so responsive images work behind Cloudflare Access.

Previously, resizing R2/local media routed through Astro's `/_image` endpoint, which made the server fetch the media's own URL to load the source bytes — a self-referential request that fails when the site is behind Cloudflare Access or has loopback fetches disabled, surfacing as 404s on transformed images. EmDash now serves transforms from `/_emdash/api/media/transform/{key}`, reading bytes straight from the storage adapter and resizing them with a configured transformer, so no server-side fetch of the media URL is made.

To enable it on Cloudflare, add an `IMAGES` binding to your wrangler config and wire it up:

```ts
import { imageBinding } from "@emdash-cms/cloudflare";

emdash({
  storage: r2({ binding: "MEDIA" }),
  images: imageBinding({ binding: "IMAGES" }),
});
```

When `images` is not configured, behavior is unchanged.
