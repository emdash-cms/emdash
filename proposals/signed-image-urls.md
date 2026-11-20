---
title: Signed image transform URLs
type: rfc
status: proposed
authors:
  - Zach Bimson (@bimsonz)
champion: Zach Bimson (@bimsonz)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/4983
created: 2026-11-19
---

# Signed image transform URLs

## Summary

An opt-in setting, `images: { signedUrls: true }`, makes EmDash sign every image transform URL it renders, and refuse transform requests that are not signed. The image endpoint then creates only the variants the site itself rendered, instead of whatever widths and heights a request asks for.

EmDash signs where every server-rendered transform URL is built: the configured Astro image service's `getURL`. EmDash wraps the stock runtime service, so `<Image>` from `emdash/ui`, Astro's `<Image>` and `<Picture>`, and direct `getImage()` calls all produce signed URLs without template changes. The signature is an HMAC-SHA256 over the canonical query introduced by [#4911](https://github.com/emdash-cms/emdash/pull/4911). Its key is a site secret resolved by the existing secrets module. The endpoint verifies the signature before it reads storage, fetches a source or transforms anything.

Contributors and above need no signature. The media library and the visual editor's picker build thumbnail URLs in the browser, so they keep working for the people who upload media.

## Problem and user case

EmDash's image endpoint creates whatever variant a request names for any image source it accepts, and a page carries the source URLs. On Cloudflare, `parseTransformParams` accepts any width and height from 1 to 4000 (`MAX_TRANSFORM_DIMENSION`), any quality from 1 to 100, and the supported formats. Each new width and height is a new Images transformation. (The endpoint does not read `fit`, `position` or `background` today. [#2449](https://github.com/emdash-cms/emdash/pull/2449) would add the first two.)

Cloudflare bills a transformation once per unique combination of source image and parameters per calendar month. Format and quality don't count towards uniqueness; width and height do. [EmDash's Cloudflare guide](https://docs.emdashcms.com/deployment/cloudflare/#image-transformation) records the consequence for the Images Free plan: past 5,000 unique transformations in a month, cached variants are still served, but new ones fail with error `9422`.

Anyone who can read a page can therefore:

- on the Free plan, use up the month's allowance with a few thousand requests that vary `w`. Every new variant the site needs then fails until the month ends, including variants for images published later in the month.
- on a paid plan, run up transformation charges at $0.50 per 1,000 unique variants.

The accepted [media route cache plan](./media-route-cache.md) left this out on purpose. Its non-goals defer "limiting which widths, heights, formats or qualities `/_image` accepts" to "a separate plan together with issue #4214". Under edge cases, it notes that "Normalization does not bound the number of valid variants". [Issue #4214](https://github.com/emdash-cms/emdash/issues/4214) asks for exactly that bound, under "Bound variant generation". The issue is open, two other production sites have reported the same experience there, and triage concluded it "needs a design/RFC before implementation".

Sites that care about this build their own protection, each in its own way. One production EmDash site on Cloudflare appends an HMAC to every variant URL in site code and refuses unsigned requests in middleware. #4911's canonical redirect drops parameters it doesn't read, as its plan states, so on current `main` it strips that signature from every variant and the site's middleware refuses the result. The protection belongs in EmDash, where it can be part of the canonical query instead of colliding with it.

## Example

```js title="astro.config.mjs"
export default defineConfig({
	adapter: cloudflare(),
	integrations: [
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
			images: { signedUrls: true },
		}),
	],
});
```

Templates render images as before:

```astro
<Image image={post.data.featured_image} width={1200} height={675} />
```

The `href` stays absolute, against the site's public origin, as today. Every transform URL now ends in a signature:

```html
<img
	src="/_image?href=https%3A%2F%2Fexample.com%2F_emdash%2Fapi%2Fmedia%2Ffile%2F01JABC.jpg&w=1200&h=675&f=webp&_emdash_sig=Yk3mQ8rT0vN2pL7xC4aZ9g"
	srcset="/_image?href=…&w=640&h=360&f=webp&_emdash_sig=… 640w, …"
/>
```

| Request                                                          | Response                                                                                 |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| A URL from the page, unchanged                                   | `200` with the variant, or the cached variant                                            |
| The same URL with `w=1201`                                       | `403`, no storage read, no fetch and no transform                                        |
| The same URL with its parameters reordered                       | stored media: `301` to the canonical form, keeping `_emdash_sig`; other sources: `200`, verified over the canonical query |
| No `_emdash_sig`, from a visitor or a Subscriber                 | `403`                                                                                    |
| No `_emdash_sig`, from a Contributor or above (a library thumbnail) | `200`, kept out of the shared cache as today (#4475)                                  |
| A bundled asset or an allowed remote image, rendered by the site | signed like any other transform URL, so `200`                                            |
| Any `/_image` URL written by hand                                | `403` for visitors and Subscribers                                                       |

## Goals

- When enabled, `/_image` creates variants only for URLs the site built, whatever the source: stored media through the internal route or the storage's `publicUrl`, bundled assets, or allowed remote images.
- Every built-in way of producing a transform URL in a server-rendered page is signed without template changes: `emdash/ui` components, and Astro's `<Image>`, `<Picture>` and `getImage()`.
- The media library and the visual editor's picker keep working for the roles that upload media.
- A signed URL is deterministic: the same image and options give the same URL, so the route cache and browser caches keep working.
- Rotating the secret through `EMDASH_IMAGE_SECRET` doesn't break pages already cached under the previous value.
- Disabled, which is the default, behavior is identical to today.
- One mechanism for Node and Cloudflare. A build needs a secret only in the one case described under [The secret](#the-secret).
- No new database query on logged-out pages.

## Non-goals

- Changing which variants EmDash renders, or snapping widths to a fixed list. See [Alternatives](#alternatives).
- Expiring URLs or controlling who may view an image. The signature bounds which variants exist. It does not authorize viewing, and signed URLs are as public as the pages that carry them.
- Custom image services. Signing applies to the stock runtime services whose URL format EmDash knows: `astro/assets/services/sharp` on Node and `@astrojs/cloudflare/image-service-workerd` on Cloudflare. These are the services that #4911 normalizes.
- Cloudflare's `compile` and `custom` image modes, for now. See [Alternatives](#alternatives).
- Content-addressed or versioned media URLs, and persisting variants in storage. Both stay with #4214.
- Turning signing on by default. That breaks hand-written `/_image` URLs and adds a build-time secret for some Cloudflare sites, so it waits for a major version; see [Rollout and implementation](#rollout-and-implementation).

## Detailed design

### Configuration

`images` accepts its current boolean or an object:

```ts
images?: boolean | {
	/**
	 * Sign every image transform URL the stock image service builds, and refuse unsigned ones.
	 * Applies to the stock image services. Default `false`.
	 */
	signedUrls?: boolean;
};
```

`images: true` and `images: {}` both mean what `images: true` means today. `images: false` still leaves Astro's image endpoint untouched, so nothing is signed. The options schema (`config/options-schema.ts`) accepts both shapes, rejects unknown keys in the object so a typo can't silently leave signing off, and gives the union its own error message, as the other boolean-or-object options do. `EmDashConfig["images"]` widens from `boolean` to this union.

With a custom runtime image service, a custom image endpoint, or Cloudflare's `compile` or `custom` image mode, `signedUrls: true` logs a build-time warning that signing does not apply, and the site behaves as if signing were off. So does an integration that replaces the image service after EmDash.

### What is signed

Every transform URL the stock image service builds while EmDash renders a page is signed, whatever its `href` names: stored media through the internal route or the storage's `publicUrl`, a bundled asset, or an allowed remote image. With signing on, the endpoint refuses every unsigned request from a requester below Contributor, whatever its `href`. Signing only stored media was considered and rejected; see [Alternatives](#alternatives).

A URL is signed while EmDash renders a request, and while a prerender emits a transform URL into its HTML. Contributors get signed URLs too, so URLs stay deterministic. URLs never expire.

### The secret

The secrets module (`packages/core/src/config/secrets.ts`) resolves the image signing secret, following the preview secret's pattern:

- `EMDASH_IMAGE_SECRET`, read from `process.env` and never from `import.meta.env`. A comma-separated list supports rotation: the first value signs, and every listed value verifies.
- Otherwise, a value generated on first need and persisted in the options table as `emdash:image_secret`. Every isolate and deployment that uses the same database shares it. Sites with signing off never create it.

The secret is distinct from the preview secret and from `EMDASH_ENCRYPTION_KEY`, so rotating one never affects the others. It is resolved and imported once per isolate for the site's database; an isolated database, such as a preview session's, resolves its own. Without `EMDASH_IMAGE_SECRET`, it is read in the options query the runtime already makes once per isolate, so rendering signed pages adds no query; the first request after signing is enabled inserts the row once. A prerender never reads or creates it. An `/_image` request that reaches a fresh isolate before any page has rendered reads it once, because the image endpoint skips the runtime's start-up. With `EMDASH_IMAGE_SECRET`, signing and verification never touch the database.

Overlapping rotation is available through the environment variable only. The persisted option holds one value, and each isolate keeps the value it resolved until it restarts. Replacing it means deleting the option and redeploying. URLs signed with the old value then fail, so cached pages must be purged in the same step. A site that expects to rotate sets `EMDASH_IMAGE_SECRET`.

**At build time.** A build usually needs no secret: when static image collection is installed, Astro replaces a local service's transform URLs with files it generates, so prerendered HTML carries no `/_image` URLs. That is the case on Node, and on Cloudflare with `imageService: { build: "cloudflare-binding" }`. Cloudflare's default image mode (`cloudflare-binding`) installs no static image collection in its prerender, so prerendered pages keep runtime `/_image` URLs. EmDash signs those at build with the first value of `EMDASH_IMAGE_SECRET`, never with the persisted secret, because a build's local database holds a different one. Without the variable, the build fails with an error that names `EMDASH_IMAGE_SECRET` and says where to set it, instead of shipping URLs that answer `403`. The exception is a `getImage()` call made outside the page render, such as in `getStaticPaths`: with no request context it is signed with `EMDASH_IMAGE_SECRET` when that is set, and otherwise left unsigned. The prerender runs in workerd and reads the Worker's environment, not the build shell's, so such a site lists the variable under `secrets.required` in its Wrangler configuration, exports it when building, and sets the same value as a Worker secret.

### Signing at URL creation

During `astro:config:setup`, the adapter has already set `image.service`. When EmDash installs its image endpoint and the service is one of the stock services, EmDash replaces it with a wrapper that delegates every method to the stock service and signs the URL `getURL` returns. Astro awaits `getURL` for `src` and for every `srcset` candidate, and `<Picture>` calls `getImage` once per format, so every format's URLs are signed. An untransformed source (a URL `getURL` returns unchanged) stays as it is.

`signTransformUrl`:

1. computes the canonical query exactly as the endpoint does (`canonicalTransformSearch`), without the adapter's `assetQueryParams`, which can change between deployments;
2. computes `HMAC-SHA256(secret, "emdash-image-v1\n" + canonicalQuery)` with WebCrypto, where the version prefix leaves room to change the algorithm later;
3. truncates the result to 128 bits, encodes it as unpadded base64url (22 characters), and appends it as `_emdash_sig` after the canonical parameters and any `assetQueryParams`.

The parameter name follows the existing `_emdash_media` convention, so it can't collide with Astro's parameters or an adapter's. The signature covers every canonical parameter, including the `href` with its origin and the `fit` and `position` values the endpoint does not read yet. It therefore stays correct when the endpoint starts reading them.

#4911's stock-service checks in both endpoints read the recorded original service instead of the configured one, so normalization and media caching continue unchanged. [Appendix B](#appendix-b-implementation-notes) has the mechanics.

### Verification in the endpoint

When signing is enabled, `_emdash_sig` joins the canonical parameter list as its last entry.

Both endpoints, `packages/core/src/astro/image-endpoint.ts` and `packages/cloudflare/src/image-endpoint.ts`, gain one step. It runs on every request when signing is enabled, whatever the `href` names, before canonicalization, any storage read, any handoff to the adapter's transform endpoint and any fetch of a remote or same-origin source:

1. If the requester holds `media:upload` (Contributor and above), skip verification. The image request path already knows the user. Responses for signed-in users are already kept out of the shared route cache (#4475). Subscribers, including self-registered ones, are verified like visitors.
2. Otherwise, recompute the truncated MAC over the request's canonical query for each verifying secret and compare it with `_emdash_sig` in constant time, by hashing both values with SHA-256 and comparing the digests. `crypto.subtle.verify` can't check a truncated MAC, and `crypto.subtle.timingSafeEqual` exists only on Workers.
3. A missing or wrong signature gets a `403` with the error code `IMAGE_SIGNATURE_INVALID`. The response sets no cache intent, and the endpoint reads no storage, fetches nothing and calls no transform. A valid signature on a non-canonical query for stored media gets #4911's `301` to the canonical form, which keeps the signature. Other sources are handed on with only the canonical parameters and the adapter's `assetQueryParams`, so the stock endpoint never reads a parameter the signature doesn't cover.

If the secret can't be resolved (no `EMDASH_IMAGE_SECRET` and no reachable database), the endpoint answers `503` with `IMAGE_SIGNING_UNAVAILABLE`, sets no cache intent and transforms nothing.

### Client-built thumbnails

`getMediaThumbnailUrl` in `@emdash-cms/admin` and `thumbnailUrl` in the visual editor's media picker keep building unsigned URLs. Both run in the browser. The picker needs edit mode, which needs an Author or above, who hold `media:upload`. The media library's page is open to Subscribers, who hold `media:read` but not `media:upload`: their thumbnails answer `403`, and the library's existing `onError` fallback then loads the full-size original. No signing endpoint is added.

## Compatibility and migration

The change is additive. With `signedUrls` unset or `false`, nothing changes: no signature is added, no request is verified, no secret is created, and `_emdash_sig` is not a canonical parameter.

Enabling it changes four things:

- **Hand-written `/_image` URLs**, for stored media, bundled assets or remote images, in site code, content or other systems, start answering `403` to visitors. Build them with `getImage()` instead. A page that renders an image at a size taken from the request would sign whatever the caller asks for, so sizes come from the template or the content.
- **Pages cached before the deploy that enables signing** hold unsigned URLs. Visitors can't load those images once the variant falls out of the cache. Whether that happens depends on the cache:
  - **Workers Cache, default configuration:** the Worker version is part of the cache key, as Cloudflare documents, so the deploy that enables signing starts from an empty cache and no purge is needed ([Appendix A](#appendix-a-prototype-findings)).
  - **Workers Cache with `cache.cross_version_cache: true`:** the new version serves the previous version's cached pages until they expire, so the site purges after the deploy (`ctx.cache.purge({ purgeEverything: true })`, or #4587's manual invalidation once it ships).
  - **Other providers** whose entries outlive a deploy: purge when enabling signing.
  - **Gradual deployments:** while two versions serve traffic, a page from the version without signing can request images from the version with it, and those answer `403`. Enable signing with a full deploy.
- **Prerendered pages under Cloudflare's default image mode** need `EMDASH_IMAGE_SECRET` at build and at runtime; see [The secret](#the-secret).
- **Other deployments bound to the same database** share the persisted secret automatically. With `EMDASH_IMAGE_SECRET`, they need the same value. Preview sessions that run on their own database snapshot use their own secret, consistently within the session.

Disabling the setting restores today's behavior, and pages rendered while it was on keep loading. With signing off, `_emdash_sig` is not a canonical parameter, so #4911 redirects a signed stored-media URL to its unsigned form, which serves the same variant; other sources are served as they are. That costs one redirect per variant until those pages are re-rendered. The redirect is permanent, so a browser that cached it keeps loading the unsigned URL if signing is turned back on, and that URL answers `403` until the browser's cache clears.

No schema changes. The generated secret is one new row in the options table.

## Security and privacy

- **Trust boundary.** The secret never leaves the server. URLs are signed only while rendering a page, at request time or in a prerender, and no route returns a signature for parameters the caller chooses.
- **Forgery.** A 128-bit truncated HMAC-SHA256 gives no practical chance of forging a signature for parameters the site did not render. Comparison is constant-time.
- **Replay.** Replaying a signed URL serves a variant the site already uses, which is the intended behavior, and is usually a cache hit.
- **Exempt roles.** Contributors and above can still create arbitrary variants. They are already trusted to upload media, and their responses never enter the shared cache.
- **Secret exposure.** A leaked secret restores today's unbounded behavior until it is rotated.
- **Privacy.** No new data about visitors is collected or stored.

## Performance

- **Rendering.** One HMAC per transform URL in a request, with the key imported once per isolate. On the prototype under `wrangler dev`, that cost about 8–10 µs per URL: 3.4 to 4.2 ms on a page with 420 transform URLs. Production Workers were not measured.
- **Endpoint.** One HMAC per cache miss. Cache hits from Workers Cache never reach the Worker.
- **Page weight.** Each URL gains `&_emdash_sig=` and 22 characters, which is 39 bytes in HTML, where `&` is written `&amp;`. The 420-URL page grew by 16.4 KB, or by 7.9 KB gzipped. The signatures are random, so they compress poorly.
- **Database.** Logged-out pages run no added query; the secret rides on the options query the runtime already makes. See [The secret](#the-secret) for the one cold-isolate read on `/_image`.

## Failure handling

- **No secret for a prerender that needs one.** The build fails, naming `EMDASH_IMAGE_SECRET` and where to set it.
- **No secret at runtime.** The secrets module persists one on first need. If the database is unavailable and `EMDASH_IMAGE_SECRET` is unset, pages can't render, and visitors' image requests answer `503` instead of being transformed unverified.
- **Different secrets at build and at runtime.** Under Cloudflare's default image mode, a secret set at build but missing or different at runtime makes prerendered images answer `403`, with nothing at build to warn about it. The documentation says to set the same value in both places.
- **Mismatched secrets across deployments.** Each deployment's URLs answer `403` on the other. The documentation for multi-deployment setups mirrors the preview secret's.
- **Observability.** Each `403` logs at `debug` whether the signature was missing or invalid, where the secret came from, and the requested `href`, escaped and truncated. It never logs the expected signature.

## Verification

- **Unit:**
  - The MAC is stable across parameter order and encoding, changes with any parameter, and excludes `assetQueryParams`.
  - Rotation lists sign with the first value and verify with every value. Missing, empty, truncated or duplicated signatures fail.
  - The constant-time helper behaves correctly on equal and unequal inputs.
  - Two cold resolutions of the persisted secret converge on one value, and a site with signing off never creates it.
- **The check:** a Contributor's unsigned request passes and a Subscriber's is refused; with no secret and no database the check answers `503`; with `EMDASH_IMAGE_SECRET` it needs no database.
- **Endpoints,** in `packages/core` and `packages/cloudflare`:
  - A signed URL is served. A non-canonical signed URL for stored media redirects to the canonical form and keeps its signature.
  - Missing or wrong signatures answer `403` before any storage read, adapter handoff, fetch or transform, whatever the `href`: stored media and its encoded, trailing-slash, port, scheme-only and `base` variants, bundled assets, remote images and a redirecting path.
  - The stock endpoint receives only the canonical, signed parameters (plus the adapter's `assetQueryParams`); any other parameter is dropped before the handoff.
  - With signing off, responses are unchanged, and a signed stored-media URL redirects to its unsigned form.
- **Service wrapper:**
  - Every method reaches the stock service with that service's own configuration. `src` and every `srcset` candidate from Astro's real `getImage` are signed, and every parameter Astro's real `parseURL` reads from them is in the canonical list.
  - While prerendering, a URL that Astro replaces with a static file stays unsigned and no secret is read; any other URL is signed with `EMDASH_IMAGE_SECRET`, and without it the build fails, through EmDash's image components too.
  - Running the real `@astrojs/cloudflare` setup hook in each image mode leads to wrapping in the `cloudflare-binding` modes and to a warning with signing off in `compile` and `custom`.
  - A custom service gets the warning, and no signing.
  - In the implementation, CI runs these against the oldest and newest Astro and `@astrojs/cloudflare` versions EmDash supports. The prototype verified Astro 7.3.2 and `@astrojs/cloudflare` 14.3.1.
- **Query counts:** the implementation adds a signing-on fixture to `pnpm query-counts`, and logged-out pages match the snapshot. In the prototype, measured with a temporary fixture, signing first added up to five queries to a cold render, and reading the secret with the runtime's options brought every route back to the snapshot. A unit test pins the options read.
- **End to end,** in Playwright (`e2e/tests/`, against `e2e/fixture` and `e2e/fixture-cloudflare`): with signing on, pages render only signed URLs that load logged out, an edited `w` is refused, and a Contributor's library thumbnails load. A production build with `imageService: { build: "cloudflare-binding" }` prerenders with no secret.

The prototype ran the end-to-end checks by hand; see [Appendix A](#appendix-a-prototype-findings).

## Rollout and implementation

1. The secret in `config/secrets.ts`, the signing and verification helpers, and the constant-time comparison.
2. Verification of every transform request in both endpoints behind the setting, with `_emdash_sig` in the canonical list.
3. The service wrapper, its record of the original service, and the move of #4911's stock-service checks onto that record.
4. Documentation: the `images` option, the Cloudflare guide's transformation section (including the prerender secret under `secrets.required` and the unsupported image modes), and the image secret beside the other secrets. Minor changesets for `emdash` and `@emdash-cms/cloudflare`.

Each slice lands with its tests. The options schema accepts `signedUrls` only from slice 3, so no release verifies requests it doesn't sign. Making `signedUrls` default to `true` is left to the next major version, as its own decision.

## Alternatives

- **Signing and verifying only stored-media `href`s.** This was the first draft. An endpoint that verifies only stored media has to decide, from the `href` alone, whether the fetch that follows will reach stored media. The prototype's review found six ways to get a stored image transformed without a signature while that test said "not stored media". Five worked because Astro's generic endpoint, the Cloudflare transform or Astro's router resolved the `href` differently from the test:
  - a trailing slash on the key (`/_emdash/api/media/file/abc.jpg/`);
  - a percent-encoded key (`%61bc.jpg`, double-encoded `%2561bc.jpg`), which the router decodes;
  - the `publicUrl` host on another port (`:8443`), which Astro's remote pattern allows because it pins host and protocol but not port;
  - scheme-only forms (`http:media.example.com/…`, `https:/_emdash/…`), which resolve differently against `http:` and `https:` bases;
  - a configured Astro `base` (`/blog/_emdash/api/media/file/…`), which the router strips (on Node).

  The sixth was a redirect on the site (for example, one an editor created) from any path to a media URL: Astro's fetch follows it, and no `href` test can see it. Signing every transform URL removes the test, and also bounds transforms of remote images, which cost the same on Cloudflare.
- **An allow-list of widths, qualities and formats, rejecting or snapping other values.** This is the approach in #4214's report, and Next.js's `deviceSizes`, `imageSizes` and `qualities`. EmDash's renderers request exact sizes: `responsiveWidths` adds each image's rendered width and its 2× or original width to the breakpoint list, and heights follow each template's aspect ratio. A list either refuses URLs EmDash itself builds, or grows large enough to bound little. Making it work means snapping EmDash's output to the list, which changes how every site renders images. Next.js can use lists because it controls a fixed width ladder.
- **Named presets**, like Cloudflare Images' predefined variants or Cloudflare's advice to name a preset in the URL. Presets suit a fixed set of renditions. EmDash's `Image` API takes arbitrary widths and heights, so presets would change the public API and every template.
- **Signing only in EmDash's own components.** Astro's `<Image>` and `getImage()` are common in EmDash templates for stored media. They would emit unsigned URLs that break.
- **Rewriting `/_image` URLs in rendered HTML from middleware.** It avoids wrapping the image service, but it buffers or parses streamed responses, has no HTMLRewriter on Node, and would sign URLs a page prints from the request.
- **A signing hook in Astro or `@astrojs/cloudflare`.** That is the better long-term home: a hook for transform URLs would remove the wrapper and its coupling. It doesn't exist today, and the bound is needed now; EmDash will bring this use case to Astro.
- **Supporting Cloudflare's `compile` and `custom` image modes now.** In those modes the adapter imports the configured service in Node during the build to collect static images, which a wrapper of the workerd service can't serve. Supporting them needs `@astrojs/cloudflare` to keep its build-time service separate from the runtime one, or to expose its resolved mode; EmDash will raise that with the adapter. Until then those modes warn and leave signing off.
- **Expiring tokens**, as in Cloudflare's signed-request example and WAF token authentication. Expiry controls access, which is not the goal here. It would also break cached pages and browser caches whenever a token lapses.
- **A report-only mode that signs URLs but serves unsigned requests.** It leaves the endpoint unbounded for as long as it is on, and adds a mode to maintain. Purging cached pages when signing is enabled achieves the same rollout without the exposure.
- **Rate limiting or WAF rules.** They work only on Cloudflare, sit outside EmDash, and slow abuse down without bounding it.
- **Leaving it to sites.** This is today's position, and it fails: each site reinvents the mechanism, and core changes such as #4911 break it.

## Drawbacks

- EmDash starts wrapping the configured runtime image service. That is a new integration step, and it couples EmDash to Astro's image service interface and to two internals: the condition under which Astro replaces a URL with a static file, and the Cloudflare adapter's resolved image mode. Tests run the real Astro and adapter code, so an upgrade that changes either fails CI. An adapter whose mode EmDash can't read gets a warning and no signing, and a transform parameter a future Astro adds outside the canonical list is dropped before the stock endpoint sees it, so it fails safe until EmDash adds it.
- There is a secret to manage. Overlapping rotation needs the environment variable, and deployments with their own secrets must share its value.
- Enabling signing breaks hand-written `/_image` URLs for every source, and may need cached pages to be purged.
- Each URL is 35 characters longer, 39 bytes in HTML.
- Exempt roles are not bounded.
- Subscribers who open the media library download every original in full, after their thumbnails are refused.
- Under `astro dev` the Cloudflare adapter doesn't report its image mode, so `compile` and `custom` sites sign in development but not in production builds.
- On Node, `console.debug` is printed, so refused requests write log lines, at a throttled rate.

## Open questions

- **A Maintainer sponsor.**
- **Default.** Should `signedUrls` default to `true` in the next major version, or for new sites created by `create-emdash` before then?

## Appendix A: Prototype findings

The prototype is [`proto/signed-image-urls`](https://github.com/bimsonz/emdash/tree/proto/signed-image-urls) on `bimsonz/emdash` (head [`c046e6c0d976635eee5b45abefbc687bcbc73beb`](https://github.com/bimsonz/emdash/commit/c046e6c0d976635eee5b45abefbc687bcbc73beb)). Production builds of scratch copies of the two starter templates, with test pages added, were checked with `curl`, in a browser, and with an independent HMAC computation: Astro 7.3.2 with `@astrojs/cloudflare` 14.3.1 under `wrangler dev` 4.125.0, and `@astrojs/node` 11.1.5 with sharp 0.35.4. The rows below come from a full run at `f3ab82ecb` and a smoke run at `7f2bd5a8c`, after the changes review asked for; the one later commit keeps the request's origin when a path starts with `//`.

| Check                                                         | Cloudflare                                                        | Node                                             |
| ------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------ |
| Rendered transform URLs signed, `_emdash_sig` last            | 206 URLs, 100 unique; at head 23 of 23                            | 147 URLs, 73 unique; at head 127 of 127          |
| Unique URLs, logged out                                       | `200` (100 of 100; at head 20 of 20)                              | `200` (73 of 73; at head 75 of 75)               |
| Edited `w`; signature stripped                                | `403`; `403`                                                      | `403` (75 of 75 each, at head)                   |
| Reordered stored-media URL                                    | `301` keeping the signature, then `200`                           | `301` keeping the signature (30 of 30, at head)  |
| Signed bundled or remote URL with an extra parameter          | `200` (at head)                                                   | `200` (45 of 45, at head)                        |
| Independent HMAC over the canonical query                     | 100 of 100 match; 0 with another secret                           |                                                  |
| `EMDASH_IMAGE_SECRET` with the database binding broken        | signed `200`, edited `403`; without the secret `503` (at head)    |                                                  |
| Non-root `base`, `assetQueryParams`, streaming, rotation      |                                                                   | all served `200`, no redirect                    |
| Prerender with no secret                                      | build fails naming `EMDASH_IMAGE_SECRET` (default mode)           | passes; no `/_image` URLs                        |
| Prerender with the secret under `secrets.required`            | signed and `200`; a different runtime secret `403`                |                                                  |
| Secret row written by a prerender build                       | none (at head)                                                    | none (at head)                                   |
| `getImage()` in `getStaticPaths`                              |                                                                   | replaced by a static file, with or without the secret |
| `compile` and `custom` modes                                  | build, warn naming `cloudflare-binding`, signing off              |                                                  |
| Unsigned thumbnail: anonymous, Contributor, Subscriber        | `403`, `200`, `403` (production build, at head)                   |                                                  |
| Persisted secret across a restart                             |                                                                   | `200` before any render; byte-identical HTML     |
| Queries on a cold render of `/`, signing off and on           |                                                                   | 12 and 12; the first request after enabling adds the one insert |
| Signing off                                                   | no signature, no secret row after 34 requests                     | no signature, no secret row after 120 requests   |
| 420 signed URLs, median of 5 runs                             | `curl` 6.2 → 10.4 ms; Worker span 4 → 8 ms; HTML +16.4 KB, gzip +7.9 KB |                                          |

A throwaway Worker on `workers.dev`, serving `Cache-Control: public, max-age=3600`, was deployed four times and then deleted. Under the default configuration, a page cached by the previous version was a `MISS` after a deploy. With `cache.cross_version_cache: true`, the new version served the previous version's page as a `HIT` (`age: 25`); turning the setting on was itself a cold start.

On one Cloudflare test page with no `<head>`, the responsive-image `<style>` disappeared with signing on. The cause is Astro's build before 7.4.6 ([withastro/astro#18565](https://github.com/withastro/astro/pull/18565)): a production page with no `<head>` whose imports reach `astro:config/server` loses all its head content. Importing from `emdash` already does that with signing off; on Cloudflare, signing adds one more such path through the image service. Pages with a `<head>`, which includes every EmDash template, are unaffected, and Astro 7.4.6 fixes it.

## Appendix B: Implementation notes

- **The wrapper** is `emdash/internal/image-service`. The integration records the stock entrypoint and configuration, and a `virtual:emdash/stock-image-service` module re-exports the recorded entrypoint so the wrapper can delegate to it. Each method passes the stock service its own configuration.
- **Which key `getURL` uses.** While EmDash renders a request, the request's key, cached per isolate. While prerendering, the rule under [The secret](#the-secret): no key when Astro will replace the URL with a static file (static image collection installed), otherwise the first `EMDASH_IMAGE_SECRET` value, otherwise the build fails. With no request context at all (for example in `getStaticPaths`, or an error page Astro renders without middleware), the first `EMDASH_IMAGE_SECRET` value when it is set, otherwise the URL is left unsigned. A failure to resolve the request's key propagates from `getURL`; Astro's components then fail the render, and EmDash's components render the original image, as they do today for any `getImage` error. The prerender state is a request-context field set by the runtime middleware.
- **Cloudflare image modes.** In `compile` and `custom`, the adapter imports the configured service in Node at build. A wrapper that re-exports a virtual module can't load there, and the adapter would transform with the workerd service instead of sharp. EmDash reads the adapter's resolved mode from its configuration module; a mode it can't read gets a warning naming the adapter version, and no signing.
- **Endpoints** read the recorded original service for #4911's stock-service checks, and import the check from `emdash/internal/image-signing`, so the public `emdash/media/image-endpoint` entry stays free of virtual modules. With signing on, they hand the stock endpoint a copy of the request URL that carries only the canonical parameters, the adapter's `assetQueryParams` and the signature.
- **A later integration that replaces the image service** is caught in `astro:config:done`, before Vite starts: EmDash warns and turns signing off, so the endpoints don't refuse URLs the replacement service builds unsigned.
