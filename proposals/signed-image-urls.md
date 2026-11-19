---
title: Signed image transform URLs
type: rfc
status: proposed
authors:
  - Zach Bimson (@bimsonz)
champion: Zach Bimson (@bimsonz)
sponsor: null
discussions:
  - https://github.com/emdash-cms/emdash/discussions/XXX
created: 2026-11-19
---

# Signed image transform URLs

## Summary

An opt-in setting, `images: { signedUrls: true }`, makes EmDash sign every image transform URL it serves for stored media, and refuse transform requests that are not signed. The image endpoint then creates only the variants the site itself rendered, instead of whatever widths and heights a request asks for.

EmDash signs where every server-rendered transform URL is built: the configured Astro image service's `getURL`. EmDash wraps the stock runtime service, so `<Image>` from `emdash/ui`, Astro's `<Image>` and `<Picture>`, and direct `getImage()` calls all produce signed URLs without template changes. The signature is an HMAC-SHA256 over the canonical query introduced by #4911. Its key is a site secret resolved by the existing secrets module. The endpoint verifies the signature before it reads storage or transforms anything.

Contributors and above need no signature. The media library and the visual editor's picker build thumbnail URLs in the browser, so they keep working.

## Problem and user case

EmDash's image endpoint creates whatever variant a request names for any stored image whose URL appears in a page. On Cloudflare, `parseTransformParams` accepts any width and height from 1 to 4000 (`MAX_TRANSFORM_DIMENSION`), any quality from 1 to 100, and the supported formats. Each new width and height is a new Images transformation. (The endpoint does not read `fit`, `position` or `background` today. [#2449](https://github.com/emdash-cms/emdash/pull/2449) would add the first two.)

Cloudflare bills a transformation once per unique combination of source image and parameters per calendar month. Format and quality don't count towards uniqueness; width and height do. [EmDash's Cloudflare guide](https://docs.emdashcms.com/deployment/cloudflare/#image-transformation) records the consequence for the Images Free plan: past 5,000 unique transformations in a month, cached variants are still served, but new ones fail with error `9422`.

Anyone who can read a page can therefore:

- on the Free plan, use up the month's allowance with a few thousand requests that vary `w`. Every new variant the site needs then fails until the month ends, including variants for images published later in the month.
- on a paid plan, run up transformation charges at $0.50 per 1,000 unique variants.

The accepted [media route cache plan](./media-route-cache.md) left this out on purpose. Its non-goals defer "limiting which widths, heights, formats or qualities `/_image` accepts" to "a separate plan together with issue #4214". Under edge cases, it notes that "Normalization does not bound the number of valid variants". [Issue #4214](https://github.com/emdash-cms/emdash/issues/4214) asks for exactly that bound, under "Bound variant generation". The issue is open, two other production sites have reported the same experience there, and triage concluded it "needs a design/RFC before implementation".

Sites that care about this build their own protection, each in its own way. Boulder Brighton (EmDash 1.4.0 on Cloudflare, live since 9 November 2026) appends an HMAC to every variant URL in site code and refuses unsigned requests in middleware. Then #4911 shipped a canonical redirect that drops parameters it doesn't read. On current `main` that redirects every one of the site's variants to an unsigned URL, which the site's middleware then refuses, so every picture breaks. The protection belongs in EmDash, where it can be part of the canonical query instead of colliding with it.

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

| Request                                                              | Response                                                       |
| -------------------------------------------------------------------- | -------------------------------------------------------------- |
| A URL from the page, unchanged                                       | `200` with the variant, or the cached variant                  |
| The same URL with `w=1201`                                           | `403`, no storage read and no transform                        |
| The same URL with its parameters reordered                           | `301` to the canonical form, keeping `_emdash_sig`, then `200` |
| No `_emdash_sig`, from a visitor or a Subscriber                     | `403`                                                          |
| No `_emdash_sig`, from a Contributor or above (a library thumbnail)  | `200`, kept out of the shared cache as today (#4475)           |
| `href` naming a bundled asset or an allowed non-storage remote image | handled as today, unsigned                                     |

## Goals

- When enabled, `/_image` creates variants of stored media only for URLs the site built, whether the media is addressed by the internal route or by the storage's `publicUrl`.
- Every built-in way of producing a transform URL in a server-rendered page is signed without template changes: `emdash/ui` components, and Astro's `<Image>`, `<Picture>` and `getImage()`.
- The media library and the visual editor's picker keep working for the roles that use them.
- A signed URL is deterministic: the same image and options give the same URL, so the route cache and browser caches keep working.
- Rotating the secret through `EMDASH_IMAGE_SECRET` doesn't break pages already cached under the previous value.
- Disabled, which is the default, behavior is identical to today.
- One mechanism for Node and Cloudflare, with no secret needed at build time.

## Non-goals

- Bounding variants of bundled assets (`/_astro/…`) or of remote images that are not in the site's storage. Those transforms belong to Astro and the site's own `remotePatterns`.
- Changing which variants EmDash renders, or snapping widths to a fixed list. See [Alternatives](#alternatives).
- Expiring URLs or controlling who may view an image. The signature bounds which variants exist. It does not authorize viewing, and signed URLs are as public as the pages that carry them.
- Custom image services. Signing applies to the stock runtime services whose URL format EmDash knows: `astro/assets/services/sharp` on Node and `@astrojs/cloudflare/image-service-workerd` on Cloudflare. These are the services that #4911 normalizes.
- Content-addressed or versioned media URLs, and persisting variants in storage. Both stay with #4214.
- Turning signing on by default. That breaks any site that writes `/_image` URLs by hand, so it waits for a major version; see [Rollout and implementation](#rollout-and-implementation).

## Detailed design

### Configuration

`images` accepts its current boolean or an object:

```ts
images?: boolean | {
	/**
	 * Sign image transform URLs for stored media and refuse unsigned ones.
	 * Applies to the stock image services. Default `false`.
	 */
	signedUrls?: boolean;
};
```

`images: true` and `images: {}` both mean what `images: true` means today. `images: false` still leaves Astro's image endpoint untouched, so nothing is signed. The options schema (`config/options-schema.ts`) accepts both shapes. With a custom runtime image service, `signedUrls: true` logs a build-time warning that signing does not apply, and the site behaves as if signing were off.

### What counts as stored media

A transform `href` names stored media when it matches either of:

- the internal media route, as `matchInternalMediaKey` decides today; or
- the storage adapter's `publicUrl` followed by a key, when the adapter has one (R2 with a custom domain, or S3-compatible storage with a CDN). The integration already reads this prefix to add it to `image.remotePatterns`. It now also records the prefix in the virtual config, so the signer and the endpoint use the same test.

Every other `href` is untouched by this RFC.

### The secret

The secrets module (`packages/core/src/config/secrets.ts`) resolves a new `imageSigningSecret`, following the preview secret's pattern:

- `EMDASH_IMAGE_SECRET`, read from `process.env` and never from `import.meta.env`. A comma-separated list supports rotation: the first value signs, and every listed value verifies.
- Otherwise, a value generated on first need and persisted in the options table as `emdash:image_secret`. Every isolate and deployment that uses the same database shares it.

The secret is distinct from the preview secret and from `EMDASH_ENCRYPTION_KEY`, so rotating one never affects the others. Resolution is cached per isolate with the module's existing single-flight cache, and so are the imported `CryptoKey`s.

Overlapping rotation is available through the environment variable only. The persisted option holds one value, and each isolate keeps the value it resolved until it restarts. Replacing it means deleting the option and redeploying. URLs signed with the old value then fail, so cached pages must be purged in the same step. The documentation says so. A site that expects to rotate sets `EMDASH_IMAGE_SECRET`.

No secret is needed at build time. During a build, Astro replaces every transform URL from a local image service with a static file it generates (`astro/dist/assets/internal.js`, static image collection). Prerendered HTML therefore never carries `/_image` URLs for these services.

### Signing at URL creation

During `astro:config:setup`, the adapter has already set `image.service`, because its setup hook runs before EmDash's. The integration replaces the stock runtime service with `emdash/image-service`, and records the original entrypoint and configuration in the virtual config. The build-time service, which only feeds static image collection, is left as it is.

`emdash/image-service` spreads the original service and overrides `getURL`. Astro allows `getURL` to return a promise, and awaits it for `src` and for every `srcset` candidate:

```ts
const service: LocalImageService = {
	...stock,
	async getURL(options, imageConfig, logger) {
		const url = await stock.getURL(options, imageConfig, logger);
		if (!isStoredMediaTransform(url) || !inRequest()) return url;
		return signTransformUrl(url);
	},
};
```

Spreading `baseService` and overriding a method is the extension pattern Astro documents for image services.

- `inRequest()` is true while EmDash is rendering a request (its request context is set). Outside a request, the URL is returned unsigned. On Node, a single sharp service serves both builds and requests, and a build calls `getURL` before discarding its output. Returning the URL unsigned there is correct.
- #4911's stock-service checks in both endpoints read the recorded original entrypoint instead of `imageConfig.service.entrypoint`, so normalization and media caching continue unchanged.

`signTransformUrl`:

1. computes the canonical query exactly as the endpoint does (`canonicalTransformSearch`), without the adapter's `assetQueryParams`, which can change between deployments;
2. computes `HMAC-SHA256(secret, "emdash-image-v1\n" + canonicalQuery)` with WebCrypto, where the version prefix leaves room to change the algorithm later;
3. truncates the result to 128 bits, encodes it as unpadded base64url (22 characters), and appends it as `_emdash_sig` after the canonical parameters and any `assetQueryParams`.

The parameter name follows the existing `_emdash_media` convention, so it can't collide with Astro's parameters or an adapter's. The signature covers every canonical parameter, including the `href` with its origin and the `fit` and `position` values the endpoint does not read yet. It therefore stays correct when the endpoint starts reading them.

### Verification in the endpoint

When signing is enabled, `_emdash_sig` joins the canonical parameter list as its last entry.

Both endpoints, `packages/core/src/astro/image-endpoint.ts` and `packages/cloudflare/src/image-endpoint.ts`, gain one step. It runs when signing is enabled and the `href` names stored media, before canonicalization and before a storage-backed or `publicUrl` request is handed on to the adapter's transform endpoint:

1. If the requester holds `media:upload` (Contributor and above), skip verification. The image request path already knows the user. Responses for signed-in users are already kept out of the shared route cache (#4475). Subscribers, including self-registered ones, are verified like visitors.
2. Otherwise, recompute the MAC over the request's canonical query for each verifying secret. Compare each result with `_emdash_sig` in constant time, using the SHA-256-then-XOR comparison EmDash already uses for CSRF tokens in `oauth/authorize.ts`, extracted into a shared helper. That comparison is used because `crypto.subtle.timingSafeEqual` exists only on Workers.
3. A missing or wrong signature gets a `403` with the error code `IMAGE_SIGNATURE_INVALID`. The response sets no cache intent, and the endpoint reads no storage and calls no transform. A valid signature on a non-canonical query gets #4911's `301` to the canonical form, which keeps the signature.

### Client-built thumbnails

`getMediaThumbnailUrl` in `@emdash-cms/admin` and `thumbnailUrl` in the visual editor's media picker keep building unsigned URLs. Both run in the browser for people using the media library or the picker, and those users hold `media:upload`. No signing endpoint is added.

## Compatibility and migration

The change is additive. With `signedUrls` unset or `false`, nothing changes: no signature is added, no request is verified, and `_emdash_sig` is not a canonical parameter.

Enabling it changes three things:

- **Hand-written `/_image` URLs for stored media**, in site code, content or other systems, start answering `403` to visitors. Build them with `getImage()` instead. The changeset and the image documentation say so.
- **Pages cached before the deploy that enables signing** hold unsigned URLs. Visitors can't load those images once the variant falls out of the cache. A site whose route cache outlives a deploy purges its cached pages when it enables signing. The documentation gives the steps, including for the manual-invalidation plan (#4587) once it ships.
- **Other deployments sharing the database,** such as a preview Worker, share the persisted secret automatically. With `EMDASH_IMAGE_SECRET`, they need the same value.

Disabling the setting restores today's behavior, and pages rendered while it was on keep loading. With signing off, `_emdash_sig` is not a canonical parameter, so #4911 redirects a signed URL to its unsigned form, which serves the same variant. That costs one redirect per variant until those pages are re-rendered.

No schema changes. The generated secret is one new row in the options table.

## Security and privacy

- **Trust boundary.** The secret never leaves the server. URLs are signed only while rendering a request, and no route returns a signature for parameters the caller chooses.
- **Forgery.** A 128-bit truncated HMAC-SHA256 gives no practical chance of forging a signature for parameters the site did not render. Comparison is constant-time.
- **Replay.** Replaying a signed URL serves a variant the site already uses, which is the intended behavior, and is usually a cache hit.
- **Exempt roles.** Contributors and above can still create arbitrary variants. They are already trusted to upload media, and their responses never enter the shared cache.
- **Secret exposure.** A leaked secret restores today's unbounded behavior until it is rotated.
- **Privacy.** No new data about visitors is collected or stored.

## Performance

- **Rendering.** One HMAC per transform URL in a request. A page with 20 images, each with 10 `srcset` candidates in two formats, signs 400 URLs. HMAC-SHA256 over a short string takes microseconds with WebCrypto, and the key is imported once per isolate. The prototype will measure this on Workers.
- **Endpoint.** One HMAC per cache miss. Cache hits from Workers Cache never reach the Worker.
- **Page weight.** Each URL gains 35 characters (`&_emdash_sig=` plus 22). On the 400-URL page above, that is about 14 KB before compression. The signatures are random, so they compress poorly.
- **Database.** No database work on the hot path once the secret has been resolved and cached in the isolate.

## Failure handling

- **No secret at runtime.** The secrets module persists one on first need. If the database is unavailable, the page can't render anyway.
- **Mismatched secrets across deployments.** Each deployment's URLs answer `403` on the other. The documentation for multi-deployment setups mirrors the preview secret's.
- **Observability.** Each `403` logs at `debug` whether the signature was missing or invalid, and the storage key. It never logs the expected signature.

## Verification

- **Unit:**
  - The MAC is stable across parameter order and encoding, changes with any parameter, and excludes `assetQueryParams`.
  - Rotation lists sign with the first value and verify with every value.
  - Stored-media matching covers both the internal route and a `publicUrl` prefix, and does not match a look-alike host.
  - The constant-time helper behaves correctly on equal and unequal inputs.
- **Endpoints, on Node and on workerd:**
  - A signed URL is served.
  - Altered, missing or truncated signatures answer `403` before storage is read.
  - A Contributor's request without a signature is served and not cached. A Subscriber's is refused.
  - `publicUrl` media is verified before it is handed to the adapter.
  - Non-storage `href`s are unaffected.
  - With signing off, responses are unchanged, and a signed URL redirects to its unsigned form.
- **Service wrapper:**
  - `getImage()` and `<Image>` emit signed URLs for stored media in a server-rendered page, under the Cloudflare adapter and under Node with sharp.
  - Bundled and non-storage remote images are not signed.
  - A prerender build with signing on needs no secret, passes, and its HTML contains no `/_image` URLs.
  - #4911's normalization and media caching still apply.
  - A custom service gets the warning, and no signing.
- **End to end.** With signing on, a Contributor sees media library and picker thumbnails, and a visitor's page loads every image.
- **Manual, on Cloudflare.** An edited `w` answers `403`. The page's own URLs show a cache `HIT` after the first request.

## Rollout and implementation

1. The secret in `config/secrets.ts`, the signing and verification helpers, and the shared constant-time comparison.
2. Verification in both endpoints behind the setting, with `_emdash_sig` in the canonical list and the `publicUrl` match.
3. The service wrapper, its record of the original service in the virtual config, and the move of #4911's stock-service checks onto that record.
4. Documentation for the image endpoint, the Cloudflare guide's transformation section, and multi-deployment secrets. Minor changesets for `emdash` and `@emdash-cms/cloudflare`.

Each slice lands with its tests. The setting has no effect until slice 3. Making `signedUrls` default to `true` is left to the next major version, as its own decision.

## Alternatives

- **An allow-list of widths, qualities and formats, rejecting or snapping other values.** This is the approach in #4214's report, and Next.js's `deviceSizes`, `imageSizes` and `qualities`. EmDash's renderers request exact sizes: `responsiveWidths` adds each image's rendered width and its 2× or original width to the breakpoint list, and heights follow each template's aspect ratio. A list either refuses URLs EmDash itself builds, or grows large enough to bound little. Making it work means snapping EmDash's output to the list, which changes how every site renders images. Next.js can use lists because it controls a fixed width ladder.
- **Named presets**, like Cloudflare Images' predefined variants or Cloudflare's advice to name a preset in the URL. Presets suit a fixed set of renditions. EmDash's `Image` API takes arbitrary widths and heights, so presets would change the public API and every template.
- **Signing only in EmDash's own components.** Astro's `<Image>` and `getImage()` are common in EmDash templates for stored media. They would emit unsigned URLs that break.
- **Expiring tokens**, as in Cloudflare's signed-request example and WAF token authentication. Expiry controls access, which is not the goal here. It would also break cached pages and browser caches whenever a token lapses.
- **A report-only mode that signs URLs but serves unsigned requests.** It leaves the endpoint unbounded for as long as it is on, and adds a mode to maintain. Purging cached pages when signing is enabled achieves the same rollout without the exposure.
- **Rate limiting or WAF rules.** They work only on Cloudflare, sit outside EmDash, and slow abuse down without bounding it.
- **Leaving it to sites.** This is today's position, and it fails: each site reinvents the mechanism, and core changes such as #4911 break it.

## Drawbacks

- EmDash starts wrapping the configured runtime image service. That is a new integration step, and it couples EmDash to Astro's image service interface.
- There is a secret to manage. Overlapping rotation needs the environment variable, and deployments with their own secrets must share its value.
- Enabling signing breaks hand-written `/_image` URLs, and may need cached pages to be purged.
- Each URL is about 35 characters longer.
- Exempt roles are not bounded.

## Open questions

- **Wrapper feasibility.** Replacing the runtime service under the Cloudflare adapter, with `prerenderEnvironment: "workerd"` and the default `cloudflare-binding` mode, is untested. So is recording the original service for #4911's checks. A prototype in a fork will report its findings on the design PR before this RFC asks for acceptance.
- **Cached pages across a deploy.** Does Workers Cache on Cloudflare keep page entries from the previous Worker version? If it does not, enabling signing through a deploy needs no purge on Cloudflare, and the migration steps get simpler. The prototype will measure this.
- **Default.** Should `signedUrls` default to `true` in the next major version, or for new sites created by `create-emdash` before then?
