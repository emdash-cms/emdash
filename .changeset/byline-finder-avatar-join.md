---
"emdash": patch
---

Fixes byline profile pages having no way to render the byline's avatar ([#2613](https://github.com/emdash-cms/emdash/issues/2613)). `getByline`, `getBylineBySlug`, and the underlying single-row `BylineRepository` finders now resolve the avatar's media row in the same query, so `avatarStorageKey`, `avatarAlt`, `avatarBlurhash`, and `avatarDominantColor` are populated alongside `avatarMediaId`:

```astro
---
import { getBylineBySlug } from "emdash";

const byline = await getBylineBySlug(Astro.params.slug, { locale: Astro.currentLocale });
const avatar = byline?.avatarStorageKey
	? Astro.locals.emdash.getPublicMediaUrl(byline.avatarStorageKey)
	: null;
---
{avatar && <img src={avatar} alt={byline.avatarAlt ?? byline.displayName} />}
```

Previously these fields were populated only when a byline was hydrated as a credit on a content entry, so a page keyed on the byline itself — `/authors/<slug>` and the like — held a bare media id with no public API to turn it into a URL. Nothing else changes: the lookup still costs one query (the avatar is a `LEFT JOIN`, not a second round trip), and `findMany` still skips the join, so byline list pages are unaffected.
