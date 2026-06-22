/**
 * Responsive image helpers shared by the public Image components.
 *
 * These build a `srcset` for locally-stored / R2-stored media by delegating to
 * Astro's configured image service (`astro:assets`). On Cloudflare that is the
 * Images binding; on Node it is sharp; if neither is available it is a no-op
 * passthrough. The calling `.astro` component passes Astro's `getImage` in so
 * this module stays free of the `astro:assets` virtual import (which only
 * resolves inside an Astro project, not in this precompiled package).
 */

/** Standard responsive breakpoints. Matches CDN-provider srcset generation. */
export const RESPONSIVE_BREAKPOINTS = [640, 750, 828, 960, 1080, 1280, 1600, 1920];

/** Matches absolute http(s) URLs — the only shape Astro's image services optimize. */
const ABSOLUTE_HTTP_URL = /^https?:\/\//i;

/**
 * Pick the srcset widths to generate for an image rendered at `maxWidth`.
 * Includes breakpoints up to 2x (retina) plus the rendered width itself, so the
 * browser always has an exact-fit candidate.
 */
export function responsiveWidths(maxWidth: number): number[] {
	const cap = maxWidth * 2;
	const widths = new Set(RESPONSIVE_BREAKPOINTS.filter((w) => w <= cap));
	widths.add(maxWidth);
	return [...widths].toSorted((a, b) => a - b);
}

/** Build the `sizes` attribute for an image with a known display width. */
export function responsiveSizes(width: number | undefined): string {
	return width ? `(min-width: ${width}px) ${width}px, 100vw` : "100vw";
}

/**
 * Make a same-origin media URL absolute so Astro's image service can optimize it.
 *
 * Astro only optimizes absolute http(s) URLs; a same-origin proxy path like
 * `/_emdash/api/media/file/x.jpg` is otherwise treated as an unoptimizable
 * public asset. Resolving it against the site's public origin (and authorizing
 * that origin via `image.remotePatterns`) lets the service transform it.
 *
 * Only **same-origin** root-relative paths are resolved. Protocol-relative
 * URLs (`//evil.com/x`) and backslash tricks (`/\evil.com`) also start with `/`
 * but resolve to a different origin -- a classic SSRF vector once a
 * remotePattern authorizes the media path -- so anything that escapes the
 * origin is returned unchanged (and then skipped by `buildResponsiveImage`,
 * which only accepts absolute http(s) URLs). Already-absolute URLs (CDN/public
 * bucket) and non-path values (`data:`, `blob:`) are returned unchanged too.
 */
export function toAbsoluteMediaUrl(src: string, origin: string | undefined): string {
	if (!src || !origin || !src.startsWith("/")) return src;
	try {
		const resolved = new URL(src, origin);
		if (resolved.origin !== new URL(origin).origin) return src;
		return resolved.href;
	} catch {
		return src;
	}
}

/**
 * Minimal structural subset of Astro's `getImage`. Astro's `ImageTransform`
 * carries a `[key: string]: any` index signature, so the real `getImage` is
 * assignable to this narrower type.
 */
export type GetImage = (options: {
	src: string;
	width?: number;
	height?: number;
	widths?: number[];
	sizes?: string;
}) => Promise<{ src: string; srcSet?: { attribute?: string } | undefined }>;

export interface ResponsiveImage {
	src: string;
	srcset?: string;
	sizes?: string;
}

/**
 * Generate a responsive `src`/`srcset`/`sizes` for a media URL via Astro's
 * configured image service.
 *
 * Astro's image services (sharp, Cloudflare `/cdn-cgi/image`, and the default
 * Cloudflare `cloudflare-binding` service) only optimize **absolute** URLs whose
 * host is authorized via `image.domains` / `image.remotePatterns`. Anything else
 * is passed through unchanged, which would yield a useless srcset (the same URL
 * at every width descriptor). We therefore only attempt optimization for
 * absolute http(s) URLs and verify the service actually rewrote the URL.
 *
 * Returns `null` so callers fall back to a plain `<img>` when:
 *  - dimensions are unknown (avoids an inferSize fetch on every render),
 *  - the URL is relative (a same-origin proxy/public asset Astro won't optimize),
 *  - the host isn't authorized (the service passed the URL through unchanged),
 *  - no image service is configured / `getImage` throws.
 */
export async function buildResponsiveImage(
	getImage: GetImage,
	opts: { src: string; width?: number; height?: number },
): Promise<ResponsiveImage | null> {
	const { src, width, height } = opts;
	if (!src || !width || !height) return null;
	if (!ABSOLUTE_HTTP_URL.test(src)) return null;
	try {
		const sizes = responsiveSizes(width);
		const result = await getImage({
			src,
			width,
			height,
			widths: responsiveWidths(width),
			sizes,
		});
		// Passthrough: the service returned the source unchanged (unauthorized
		// host or no optimization available). Don't emit a no-op srcset.
		if (!result.src || result.src === src) return null;
		return {
			src: result.src,
			srcset: result.srcSet?.attribute || undefined,
			sizes,
		};
	} catch {
		return null;
	}
}
