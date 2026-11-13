---
title: Readable image URLs
type: rfc
status: proposed
authors:
  - Kevin Kyburz (@swissky)
champion: Kevin Kyburz (@swissky)
sponsor: Kevin Kyburz (@swissky)
discussions:
  - https://github.com/emdash-cms/emdash/discussions/1502
created: 2026-11-12
---

# Readable image URLs

## Summary

Optimized images of EmDash media get a path URL under the image endpoint that ends in a readable file name, such as `/_image/01M77BTW3VVBRX0ZSQDTRMCDPM/co-author-illustration-1200x536.webp`. The name comes from the media library. Existing `/_image?href=...` URLs keep working. This RFC asks the Maintainers to choose between two URL shapes: one that keeps the media ID in the path, and one that uses a unique media slug only, as WordPress does.

## Problem and user case

Site owners who move from WordPress expect image URLs that describe the image. [Google's image SEO best practices](https://developers.google.com/search/docs/appearance/google-images#use-descriptive-filenames-titles-and-alt-text) say the file name gives "very light clues" about the subject of an image and recommend short, descriptive names such as `my-new-black-kitten.jpg` over `IMG00023.JPG`. Alt text and page content matter more, and EmDash already supports both. The file name is the remaining signal EmDash cannot set today.

Today an EmDash image renders as:

```
/_image?href=https%3A%2F%2Fexample.com%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01M77BTW3VVBRX0ZSQDTRMCDPM.01M77BTWSXZF5EDPXH1HHD08SX.png&w=1200&h=536&f=webp&fit=cover&position=center
```

The path is always `/_image`. The only file name is the storage key inside a query parameter, and that key is a ULID, plus an upload-attempt ULID after a replaced or retried upload. The name the editor uploaded, such as `co-author-illustration.png`, is stored in `media.filename` but never appears in a public URL.

Discussion #1502 proposed putting a slug into the storage key on upload. That only helps new uploads, and the slug would still sit inside `href=`, not in the path. This RFC changes the rendered URL instead, so existing media benefits too and storage keys stay unchanged.

## Example

Media item `01M77BTW3VVBRX0ZSQDTRMCDPM`, uploaded as `Co-Author Illustration.png`, rendered at 1200x536 as WebP.

Option A (ID in the path):

```html
<img
	src="/_image/01M77BTW3VVBRX0ZSQDTRMCDPM/co-author-illustration-1200x536.webp"
	srcset="/_image/01M77BTW3VVBRX0ZSQDTRMCDPM/co-author-illustration-640x286.webp 640w, ..."
/>
```

Option B (unique slug only):

```html
<img
	src="/_image/co-author-illustration-1200x536.webp"
	srcset="/_image/co-author-illustration-640x286.webp 640w, ..."
/>
```

A second upload named `Co-Author Illustration.png` gets the slug `co-author-illustration-2` under option B. Under option A both keep `co-author-illustration`, because the IDs differ.

## Goals

- Optimized `<Image>`, `<Picture>`, srcset, gallery and Portable Text images of EmDash media render with a path URL whose last segment is a readable file name with dimensions and format.
- Existing media gets readable URLs without re-uploading or renaming stored objects.
- Every existing `/_image?href=...` URL keeps returning the same image.
- Node (sharp) and Cloudflare (`IMAGES` binding) behave the same.
- Logged-out page renders do not gain a query.

## Non-goals

- Changing storage keys or the `/_emdash/api/media/file/{key}` route. Admin, import and plugins keep using it.
- Readable URLs for remote images, project assets or external media providers.
- Prerendered pages, where Astro writes hashed files into `_astro/`.
- Editing the slug in the admin. Option B could add this later.
- Changing the image URLs in `og:image`, JSON-LD and the sitemap's `<image:loc>`. They point to the original file at `/_emdash/api/media/file/{key}`, not to `/_image`. See [Relation to the SEO foundation RFC](#relation-to-the-seo-foundation-rfc).

## Detailed design

### URL grammar

```
/_image/<id>/<name>-<width>x<height>[-<fit>][-q<quality>].<format>   (option A)
/_image/<slug>-<width>x<height>[-<fit>][-q<quality>].<format>        (option B)
```

- `<id>` is the media ID, a ULID, so the route can match it exactly.
- `<name>` (option A) is derived at render time from `MediaValue.filename`: extension removed, then the existing `slugify()`. When the result is empty, for example for a name made only of symbols, `<name>` is `image`.
- `<slug>` (option B) is a stored, unique media slug (see [Data model](#data-model)).
- `<width>x<height>` are the requested output dimensions, limited by `MAX_TRANSFORM_DIMENSION`. A missing dimension is written as `0`, for example `1200x0`.
- `<format>` is one of `ALLOWED_TRANSFORM_FORMATS`: `webp`, `avif`, `jpeg`, `png`.
- `fit` and `position` are omitted at their defaults (`cover`, `center`). Other values use short suffixes such as `-contain` or `-cover-top`. `q<n>` appears only for an explicit quality.

The endpoint parses the path back into the same `ImageTransformOptions` the query form produces. A path that does not match the grammar returns 404, so the path form cannot request a transform the query form rejects.

### URL generation

EmDash rewrites URLs where it already builds image URLs for its own media: `EmDashImage.astro`, `Image.astro`, `Gallery.astro` and `buildResponsiveImage()`. These already have the media ID, file name, storage key and dimensions from the stored `MediaValue`. They call Astro's `getImage()` as today, then rewrite each URL that points to an EmDash media key from the query form to the path form. Other URLs stay unchanged.

The rewrite lives in EmDash, not in a custom Astro image service. Sites keep their configured service, and remote and project images keep Astro's URLs.

### Endpoint

Astro registers `image.endpoint.route` as a single route without parameters, so `/_image/<anything>` does not reach it. EmDash injects one more route, `<image route>/[...path]`, backed by the same platform entrypoint: `emdash/internal/image-endpoint` on Node, `@emdash-cms/cloudflare/image-endpoint` on Cloudflare. The entrypoint gets one new step that turns a path into a storage key and transform options, then runs the existing transform code. A custom `image.endpoint.route` is respected.

Resolving the path to a storage key is one indexed query, by `id` (option A) or by `slug` (option B), limited to rows with `status = 'ready'`.

### Renames

Option A: the ID decides. A request whose `<name>` differs from the current slugified file name answers `301` to the current URL with the same dimensions and format. Renaming a file never breaks a URL, and search engines follow the redirect to one address.

Option B: the slug decides. Changing a slug needs a history table, `_emdash_media_slug_history`, so the old slug can answer `301`. Without it, a rename breaks indexed URLs.

### Data model

Option A: no change.

Option B:

- New column `media.slug`, text, unique, set on upload from the file name, with `-2`, `-3` on collision. Concurrent uploads rely on the unique constraint and retry with the next suffix.
- A backfill for existing rows in bounded batches, restartable after any completed statement, with collisions resolved deterministically by `created_at, id`.
- `MediaValue` gains `slug` so rendering needs no lookup. Content saved before the change has no `slug` in its stored values. Until such an entry is saved again, its images need either a batched render-time lookup, which adds a query to logged-out routes, or a fallback to the query URL.
- The slug history table described under [Renames](#renames).

### Relation to the SEO foundation RFC

The pending [SEO foundation RFC](https://github.com/emdash-cms/emdash/pull/4765) requires the graph's primary image and `og:image` to resolve to the same URL. Both use the original file URL, which this RFC leaves unchanged, so that rule still holds.

The original file URL still carries the storage key, not a readable name. A readable original URL, for example `/_image/<id>/<name>.<ext>` without dimensions returning the untransformed file, would let `og:image`, the primary image and `<image:loc>` carry the same name as the rendered `<img>`. This RFC leaves that open (see [Open questions](#open-questions)) rather than changing the URLs the SEO foundation RFC defines.

## Compatibility and migration

- `/_image?href=...` is unchanged and stays supported. Cached HTML, feeds and indexed URLs keep working.
- Storage keys, `/_emdash/api/media/file/{key}` and the plugin API are unchanged. Under option A, stored `MediaValue` data is unchanged too.
- The new route answers only below the image endpoint route. A site that serves its own pages under `/_image/` would conflict, so the changeset names the new route.
- Once pages have emitted path URLs, removing the path form breaks them. The path form cannot be rolled back after release.
- Option B adds a forward-only migration with a backfill.

## Security and privacy

- Every path segment is untrusted input. The parser accepts only the grammar above with the existing dimension, format and quality limits, so the path form cannot widen the transform surface.
- The lookup returns only `ready` media. Pending, failed and deleted uploads return 404.
- Media IDs are already public in today's URLs inside `href`, so option A exposes no new identifier.
- Both options make the slugified upload file name public. It is not public today. Editors sometimes upload files with internal names such as `draft-v3-client-x.png`, so the docs and changeset say that the file name now appears in image URLs and that renaming the media item changes it.
- Redirects only point to same-origin paths built from stored data.

## Performance

- Page render: option A adds no query, because ID, file name and dimensions are already in the stored `MediaValue`. Option B adds none for content saved after the change and needs the decision described under [Data model](#data-model) for older content.
- Image request: today the storage key is in `href`, so `/_image` runs no database query. The path form needs one query to resolve the path. Media responses use `max-age=0, must-revalidate`, so a revalidating client runs that query on every request, not only the first. The lookup is cached in the object cache when it is active and invalidated on replace, rename and delete.
- The pending plan [Cache media files in the route cache](https://github.com/emdash-cms/emdash/pull/4735) stores `/_image` variants in the route cache with the tag `emdash:media:<storageKey>`. If it is accepted, path-form responses carry the same tag and are purged by the same actions. Then the lookup runs only on a cache miss. A rename does not change the storage key, so it purges nothing, and the cached old path keeps answering until the cache entry expires. The `301` is served after that.
- The implementation PR includes before-and-after measurements on Node and D1, and adds the image route to `pnpm query-counts`.
- A `301` for a renamed image costs one extra round trip, only for old URLs.

## Failure handling

- Unknown ID or slug, or a path outside the grammar: 404.
- Media deleted after the page rendered: 404, as today.
- Database lookup failure: 500 with the existing `[emdash] image transform failed` log line.
- No transform available (no `IMAGES` binding or no sharp): serve the original, as the query form does today.

## Verification

- Unit tests for the grammar: round trip of every format, fit, position and quality value; rejected input such as oversized dimensions, unknown formats, extra segments, encoded slashes and `..`.
- Unit tests for name derivation: umlauts and accents (`Größe.png`), names made only of symbols, very long names, double extensions.
- Integration tests on SQLite and PostgreSQL for the lookup and its `ready` filter. For option B also slug uniqueness, concurrent uploads and a backfill restart after partial completion.
- A real D1 test in `tests/workerd/` for the lookup and its cache invalidation on replace and delete.
- Render tests that `EmDashImage`, `Gallery` and Portable Text images emit path URLs for EmDash media and keep Astro URLs for remote images.
- Endpoint tests on both platforms: path and query form return the same bytes, ETag and 304 behavior are unchanged, a renamed file answers `301`, and the old query form still works.
- Query-count snapshots show no increase on logged-out page routes.
- Manual check on a Cloudflare deployment that the edge caches path URLs like query URLs.

## Rollout and implementation

1. Grammar parser and name derivation in `emdash/media/image-endpoint`, with unit tests.
2. Injected `/_image/[...path]` route and the lookup in both platform entrypoints.
3. URL rewrite in the image components.
4. Docs for the new URLs and the file name exposure, plus changesets for `emdash` and `@emdash-cms/cloudflare`.

Option B adds the migration, backfill and history table before step 2. The feature ships enabled, because old URLs keep working and the change only affects newly rendered HTML. An `images.readableUrls: false` option is an open question.

## Alternatives

### Option A and option B

Both options end in the same descriptive file name. Google does not document whether a path segment before the file name, such as the media ID, affects how it reads the name, so this RFC assumes the SEO value is the same and the choice rests on the other rows.

|                    | A: ID in the path                                     | B: unique slug only                                                |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------ |
| URL                | `/_image/01M77…/co-author-illustration-1200x536.webp` | `/_image/co-author-illustration-1200x536.webp`                     |
| Matches WordPress  | No                                                    | Yes                                                                |
| Migration          | None                                                  | Unique column, backfill, history table                             |
| Existing content   | Works at once                                         | Needs a render-time lookup or a re-save                            |
| Logged-out queries | No change on page render                              | No change after re-save; otherwise one per page or no readable URL |
| Renames            | Automatic `301`                                       | Needs the history table                                            |
| Duplicate names    | Allowed                                               | `-2`, `-3` suffixes                                                |

### Slugged storage keys (discussion #1502)

Writing `<slug>-<ulid>.<ext>` as the storage key on upload keeps the slug inside `href=`, applies only to new uploads, and freezes the name at upload time. It also touches every upload path: direct, signed, plugin, seed and WordPress import.

### A custom Astro image service

An image service with its own `getURL()` and `parseURL()` could emit path URLs. Every caller would have to pass the media ID and file name as custom image props, and replacing the service would override the one a site has configured.

## Drawbacks

- A second public URL format under `/_image` that EmDash must support indefinitely.
- Image requests gain a lookup that the query form does not need.
- File names become public.
- Option B adds data that must stay consistent across uploads, renames and imports.

## Open questions

- Option A or option B?
- Option B: how should content saved before the change get readable URLs: a batched render-time lookup, a one-time content backfill, or the query URL until the next save?
- Should `fit`, `position` and `quality` be part of the file name or stay a short query string (`/_image/01M77…/co-author-illustration-1200x536.webp?fit=contain`)?
- Should old `/_image?href=...` URLs of EmDash media redirect to the path form? Google recommends referencing an image with the same URL across a site so it can be crawled once. Pages rendered after the change already do that. A redirect would also move already indexed URLs, but adds a lookup to every old URL.
- Is an opt-out option needed?
- Should the path form also serve the untransformed original, so `og:image`, JSON-LD and `<image:loc>` get readable URLs too? If yes, the SEO foundation RFC needs an amendment that names this URL as the one all three outputs use.
