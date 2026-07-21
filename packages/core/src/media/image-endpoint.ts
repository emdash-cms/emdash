/**
 * Portable helpers shared by the platform image-endpoint modules.
 *
 * EmDash wraps Astro's image endpoint (`image.endpoint`) so that source bytes
 * for EmDash media are read straight from the storage adapter instead of being
 * fetched over HTTP. The platform endpoint modules (Node: sharp via
 * `astro:assets`; Cloudflare: the `IMAGES` binding) do the actual transform;
 * this module holds the platform-agnostic bits they share: recognizing an
 * EmDash media URL and validating transform query params.
 *
 * Kept free of `astro:*` / `virtual:emdash/*` imports so it stays in the
 * precompiled package and can be unit-tested directly.
 */

import { INTERNAL_MEDIA_PREFIX } from "./normalize.js";

/** Output formats the wrapped endpoint can produce on Cloudflare. */
export const ALLOWED_TRANSFORM_FORMATS = ["webp", "avif", "jpeg", "png"] as const;

/** Default output format -- broad support, strong compression. */
export const DEFAULT_TRANSFORM_FORMAT: ImageTransformFormat = "webp";

/**
 * Default output quality for lossy formats (WebP/AVIF/JPEG) when the request
 * doesn't specify one. Matches the default Cloudflare applies to URL-based
 * image transformations. The Images *binding* applies no default of its own
 * and encodes near-losslessly when quality is omitted (a 2048px WebP comes
 * out ~900 KB instead of ~100 KB), so the endpoint sends an explicit quality
 * for lossy output. PNG is exempt: an explicit PNG quality switches the
 * binding to lossy PNG8, which is not a safe default for a lossless format.
 */
export const DEFAULT_TRANSFORM_QUALITY = 85;

/** Upper bound for a requested dimension; caps the work a single request asks for. */
export const MAX_TRANSFORM_DIMENSION = 4000;

/** A format string accepted by {@link ImageTransformOptions.format}. */
export type ImageTransformFormat = (typeof ALLOWED_TRANSFORM_FORMATS)[number];

/** Validated options for a single transform. */
export interface ImageTransformOptions {
	width?: number;
	height?: number;
	format: ImageTransformFormat;
	/**
	 * Explicitly-requested quality (1-100), or `undefined` when the request
	 * carried no `q`. Callers apply their own default per format (see
	 * {@link DEFAULT_TRANSFORM_QUALITY}); lossless PNG deliberately gets none.
	 */
	quality?: number;
}

/** Long-lived immutable cache -- transform output is deterministic per key+params. */
export const IMMUTABLE_IMAGE_CACHE = "public, max-age=31536000, immutable";

/**
 * Raster types safe to render inline. Anything else (SVG, PDF, ...) is served
 * as an attachment so it can't execute as an active document. Mirrors the
 * `/_emdash/api/media/file/{key}` route's allowlist.
 */
const SAFE_INLINE_IMAGE_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/gif",
	"image/webp",
	"image/avif",
	"image/x-icon",
]);

/**
 * Headers for streaming **original** stored bytes (the no-transform fallback).
 * Carries the same stored-XSS protections as the media file route: a sandbox
 * CSP, `nosniff`, and `Content-Disposition: attachment` for anything not on the
 * inline raster allowlist (so a stored SVG can't run scripts in the site
 * origin). Transformed output is always generated raster and doesn't need this.
 */
export function originalMediaHeaders(contentType: string): Record<string, string> {
	return {
		"Content-Type": contentType,
		"Cache-Control": IMMUTABLE_IMAGE_CACHE,
		"X-Content-Type-Options": "nosniff",
		"Content-Security-Policy":
			"sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
		"Content-Disposition": SAFE_INLINE_IMAGE_TYPES.has(contentType) ? "inline" : "attachment",
	};
}

/** Storage keys safe to serve: the flat `{ulid}{ext}` shape, no slashes/traversal. */
const SAFE_STORAGE_KEY = /^[A-Za-z0-9._-]+$/;

/** Plain decimal digits only -- rejects "1e3", "0x10", "+5", whitespace. */
const DECIMAL_DIGITS = /^\d+$/;

/** Whether a storage key is safe to resolve against the storage backend. */
export function isSafeTransformKey(key: string): boolean {
	return SAFE_STORAGE_KEY.test(key);
}

/**
 * If `href` points at the internal EmDash media route
 * (`/_emdash/api/media/file/{key}`) with a safe key, return the key; otherwise
 * `null` (the endpoint then delegates to the stock image endpoint for bundled
 * assets, allowed remote, and `publicUrl` media).
 *
 * The component absolutizes same-origin media (Astro only optimizes absolute,
 * remote-allowed URLs), so `href` is typically `https://site/_emdash/...` but
 * may be relative. We match on the **pathname** only and never fetch `href` —
 * the key is read from our own storage — so the host is irrelevant and can't be
 * an SSRF vector. A dummy base resolves both absolute and relative forms and
 * strips any query/fragment.
 */
export function matchInternalMediaKey(href: string | null | undefined): string | null {
	if (!href) return null;
	let pathname: string;
	try {
		pathname = new URL(href, "http://localhost").pathname;
	} catch {
		return null;
	}
	if (!pathname.startsWith(INTERNAL_MEDIA_PREFIX)) return null;
	const key = pathname.slice(INTERNAL_MEDIA_PREFIX.length);
	if (!key || !isSafeTransformKey(key)) return null;
	return key;
}

/** Type guard for {@link ImageTransformFormat}. */
export function isTransformFormat(value: string): value is ImageTransformFormat {
	return (ALLOWED_TRANSFORM_FORMATS as readonly string[]).includes(value);
}

/** Outcome of parsing transform query params: validated options or an error. */
export type ParsedTransformParams =
	| { ok: true; options: ImageTransformOptions }
	| { ok: false; message: string };

/**
 * Resolve the quality to send to the image binding for a transform. An
 * explicitly-requested quality always wins. Otherwise lossy formats
 * (WebP/AVIF/JPEG) get {@link DEFAULT_TRANSFORM_QUALITY} because the Images
 * binding encodes near-losslessly when quality is omitted; lossless PNG gets
 * `undefined` because an explicit PNG quality switches the binding to lossy
 * PNG8, which is not a safe default for a lossless format.
 */
export function resolveTransformQuality(
	format: ImageTransformFormat,
	requested: number | undefined,
): number | undefined {
	if (requested !== undefined) return requested;
	return format === "png" ? undefined : DEFAULT_TRANSFORM_QUALITY;
}

/**
 * Parse and validate `?w=&h=&f=&q=` query params. Width is required (it sizes
 * the rendition); dimensions are bounded so a request can't ask for an
 * unbounded or nonsensical transform. Format falls back to
 * {@link DEFAULT_TRANSFORM_FORMAT} when not requested. `q` is validated when
 * present but otherwise left `undefined` so the caller can apply a per-format
 * default (lossy formats get one, lossless PNG does not — see
 * {@link DEFAULT_TRANSFORM_QUALITY}).
 */
export function parseTransformParams(params: URLSearchParams): ParsedTransformParams {
	const width = parseDimension(params.get("w"));
	if (width === null) return { ok: false, message: "Invalid 'w' (width)" };
	if (width === undefined) return { ok: false, message: "Missing 'w' (width)" };

	const height = parseDimension(params.get("h"));
	if (height === null) return { ok: false, message: "Invalid 'h' (height)" };

	const formatRaw = params.get("f");
	let format: ImageTransformFormat = DEFAULT_TRANSFORM_FORMAT;
	if (formatRaw !== null) {
		if (!isTransformFormat(formatRaw)) {
			return { ok: false, message: `Unsupported 'f' (format): ${formatRaw}` };
		}
		format = formatRaw;
	}

	let quality: number | undefined;
	const qualityRaw = params.get("q");
	if (qualityRaw !== null) {
		const q = Number(qualityRaw);
		if (!Number.isInteger(q) || q < 1 || q > 100) {
			return { ok: false, message: "Invalid 'q' (quality), expected 1-100" };
		}
		quality = q;
	}

	return { ok: true, options: { width, height, format, quality } };
}

/**
 * Parse a dimension query value.
 * - `undefined`: param absent
 * - `null`: present but invalid (non-integer, out of range)
 * - `number`: valid, within [1, MAX_TRANSFORM_DIMENSION]
 */
function parseDimension(raw: string | null): number | undefined | null {
	if (raw === null) return undefined;
	if (!DECIMAL_DIGITS.test(raw)) return null;
	const n = Number(raw);
	if (n < 1 || n > MAX_TRANSFORM_DIMENSION) return null;
	return n;
}
