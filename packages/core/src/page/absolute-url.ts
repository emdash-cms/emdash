/**
 * Helpers for resolving relative media URLs to absolute URLs for SEO output.
 *
 * Social-card scrapers (Facebook, LinkedIn, Slack, Twitter) and JSON-LD
 * consumers expect absolute URLs in `og:image`, `twitter:image`, and
 * structured-data `image` fields. EmDash's media file route returns a
 * site-relative path (`/_emdash/api/media/file/...`), so anywhere the
 * resolved URL feeds into crawler-facing markup we have to join it with
 * the public site origin.
 */

import type { PublicPageContext } from "../plugins/types.js";

const HTTP_URL_RE = /^https?:\/\//i;
/**
 * Protocol-relative URLs (`//cdn.example.com/x.png`) are dropped outright.
 * They have no legitimate use in `og:image` (scrapers want a full URL) and
 * are a well-known SSRF vector when reflected through server-side
 * fetchers. Anything starting with `//` returns `null`.
 */
const PROTOCOL_RELATIVE_RE = /^\/\//;
/**
 * URL schemes we pass through unchanged because they are legitimately
 * useful as OG image values. `data:image/*` is sometimes used for inline
 * social cards (rare, but legal). Everything else with a scheme
 * (`mailto:`, `tel:`, `file:`, `blob:`, custom protocols) would be garbage
 * in an `og:image`; we return `null` so the caller can decide whether to
 * fall back or drop the tag.
 */
const PASSTHROUGH_SCHEME_RE = /^data:image\//i;
/**
 * Detects URLs that have a scheme other than http/https (and other than
 * the data:image/ form we pass through). Used to short-circuit garbage
 * input rather than treating it as a relative path.
 */
const OTHER_SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;
/**
 * Any ASCII whitespace or C0/C1 control character anywhere in the URL is
 * an injection signal — legitimate media URLs never contain them. Without
 * this guard, an input like `"  https://attacker/x"` would slip past the
 * scheme regexes (which are anchored at offset 0) and get joined as a
 * relative path with the site origin, producing
 * `https://site.example/  https://attacker/x` — confusing but not
 * exploitable, plus more pathological shapes like leading newlines that
 * could inject across header boundaries downstream.
 */
// eslint-disable-next-line eslint(no-control-regex) -- intentional: rejecting control chars is the whole point of this regex
const WHITESPACE_OR_CONTROL_RE = /[\s\u0000-\u001f\u007f-\u009f]/;
const TRAILING_SLASH_RE = /\/$/;

/**
 * `URL.origin` returns the literal string `"null"` (not the `null` value)
 * for opaque origins like `data:`, `blob:`, and `about:blank`. Treating
 * that as a valid origin would produce `null/og.png` in the output.
 */
function isUsableOrigin(origin: string): boolean {
	return origin !== "null" && origin !== "";
}

/**
 * Resolve the public origin to use when absolutizing a media URL.
 *
 * Precedence:
 *  1. The configured `SiteSettings.url` (admin-controlled, canonical).
 *  2. `PublicPageContext.siteUrl` (set by themes that override the origin,
 *     e.g. when running behind a reverse proxy).
 *  3. The origin parsed from `page.url`, which is the live request URL.
 *
 * Only `http:` and `https:` candidates count — anything else (e.g. `file:`,
 * `data:`, `blob:`) would yield an unusable origin and is skipped. Returns
 * `null` if no candidate parses to a usable HTTP(S) origin; callers should
 * treat that as "leave the URL relative" rather than throw.
 */
export function resolveSiteOrigin(
	configuredSiteUrl: string | undefined,
	page: PublicPageContext,
): string | null {
	const candidates = [configuredSiteUrl, page.siteUrl, page.url];
	for (const candidate of candidates) {
		if (!candidate || typeof candidate !== "string") continue;
		try {
			const parsed = new URL(candidate);
			if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
			if (!isUsableOrigin(parsed.origin)) continue;
			return parsed.origin;
		} catch {
			// Fall through to the next candidate. Configured URLs and page
			// URLs can be malformed (e.g. an admin pasted "example.com"
			// without a scheme); we don't want a bad config to break head
			// rendering.
		}
	}
	return null;
}

/**
 * Absolutize a media URL using the best available site origin.
 *
 * - Returns `null` for missing/empty input.
 * - Passes through already-absolute `http(s):` URLs unchanged.
 * - Passes through `data:image/*` URLs unchanged (rare but legal as OG
 *   image content).
 * - Returns `null` for protocol-relative URLs (`//cdn.com/x`): no
 *   legitimate `og:image` use case, and a known SSRF vector when reflected
 *   through server-side fetchers.
 * - Returns `null` for any other scheme (`mailto:`, `blob:`, `file:`,
 *   custom protocols): emitting those into `og:image` is worse than
 *   omitting the tag.
 * - Returns the original (relative) URL when no origin can be resolved —
 *   preferable to dropping `og:image` outright because scrapers that follow
 *   relative URLs are better off than ones that get nothing.
 *
 * @param url - The (possibly relative) media URL, e.g. `/_emdash/api/media/file/abc.jpg`.
 * @param configuredSiteUrl - `SiteSettings.url` value (admin-controlled).
 * @param page - The page context providing `siteUrl` and `url` fallbacks.
 */
export function absolutizeMediaUrl(
	url: string | undefined,
	configuredSiteUrl: string | undefined,
	page: PublicPageContext,
): string | null {
	if (!url) return null;

	// Any whitespace or control character means this isn't a real media URL.
	// Rejecting up front prevents scheme-regex evasion (`  https://x` would
	// otherwise fall through to the relative-path join below).
	if (WHITESPACE_OR_CONTROL_RE.test(url)) return null;

	if (HTTP_URL_RE.test(url)) return url;
	if (PASSTHROUGH_SCHEME_RE.test(url)) return url;

	// Reject protocol-relative URLs before any other handling. Order
	// matters: `OTHER_SCHEME_RE` wouldn't match `//x` (no leading scheme),
	// so a missing check here would fall through to the relative-path
	// join below and produce `https://site.example//cdn.evil.com/x`.
	if (PROTOCOL_RELATIVE_RE.test(url)) return null;

	// Any remaining `<scheme>:` form is something we'd silently mangle by
	// prepending an origin. Drop it.
	if (OTHER_SCHEME_RE.test(url)) return null;

	const origin = resolveSiteOrigin(configuredSiteUrl, page);
	if (!origin) return url;
	const safePath = url.startsWith("/") ? url : `/${url}`;
	return `${origin.replace(TRAILING_SLASH_RE, "")}${safePath}`;
}
