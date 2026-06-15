/**
 * Binding-based image transforms for same-origin (R2 / local) media.
 *
 * The responsive-srcset path in `responsive.ts` hands an **absolute** media URL
 * to Astro's image service (`astro:assets`), which makes the running server
 * `fetch()` that URL to load the source bytes before transforming. On
 * Cloudflare that absolute URL is the Worker's own origin, so the load is a
 * self-referential subrequest — and it fails whenever the origin is gated
 * (Cloudflare Access) or loopback fetches are disabled
 * (`global_fetch_strictly_public`), surfacing as a 404 from `/_image`.
 *
 * This module powers an alternative that never leaves the Worker: EmDash serves
 * transforms from its own route (`/_emdash/api/media/transform/{key}`), which
 * reads the source bytes straight from the storage adapter (the R2 binding) and
 * resizes them with a provided {@link ImageTransformer} (the Cloudflare `IMAGES`
 * binding). The browser requests that route directly — with its own auth cookie
 * when behind Access — so there is no server-side loopback fetch.
 *
 * The transformer itself is platform-specific and is injected at runtime via a
 * serializable descriptor (see `images` in EmDashConfig); this module stays
 * portable (no Cloudflare imports) so it can build URLs and run on Node too.
 */

import { INTERNAL_MEDIA_PREFIX } from "./normalize.js";
import { responsiveSizes, responsiveWidths, type ResponsiveImage } from "./responsive.js";

/** Route prefix that serves binding-based transforms. */
export const TRANSFORM_MEDIA_PREFIX = "/_emdash/api/media/transform/";

/** Output formats the transform route accepts. */
export const ALLOWED_TRANSFORM_FORMATS = ["webp", "avif", "jpeg", "png"] as const;

/** Default output format — broad support, strong compression. */
export const DEFAULT_TRANSFORM_FORMAT: ImageTransformFormat = "webp";

/**
 * Upper bound for a requested width. Caps the work a single request can ask the
 * binding to do and keeps the generated `srcset` candidate list bounded.
 */
export const MAX_TRANSFORM_WIDTH = 4000;

/** A format string accepted by {@link ImageTransformOptions.format}. */
export type ImageTransformFormat = (typeof ALLOWED_TRANSFORM_FORMATS)[number];

/** Options for a single transform. */
export interface ImageTransformOptions {
	/** Target width in pixels. */
	width?: number;
	/** Target height in pixels. Omit to preserve aspect ratio. */
	height?: number;
	/** Output format. Defaults to {@link DEFAULT_TRANSFORM_FORMAT}. */
	format?: ImageTransformFormat;
	/** Output quality (1-100). Adapter-defined default when omitted. */
	quality?: number;
}

/** Result of a transform: a fresh body stream plus its resolved MIME type. */
export interface TransformedImage {
	body: ReadableStream<Uint8Array>;
	contentType: string;
}

/**
 * Transforms image source bytes. Implemented by a platform adapter (e.g. the
 * Cloudflare `IMAGES` binding). Receives the source as a stream — exactly what
 * `Storage.download()` returns — so no intermediate buffering is required.
 */
export type TransformImageFn = (
	input: ReadableStream<Uint8Array>,
	options: ImageTransformOptions,
) => Promise<TransformedImage>;

/** Object form of {@link TransformImageFn}, returned by the runtime factory. */
export interface ImageTransformer {
	transform: TransformImageFn;
}

/**
 * Serializable descriptor for an image transformer, mirroring the storage
 * descriptor pattern: a config-time function returns `{ entrypoint, config }`,
 * and the runtime statically imports `createImageTransformer` from `entrypoint`.
 */
export interface ImageServiceDescriptor {
	/** Module path exporting `createImageTransformer`. */
	entrypoint: string;
	/** Serializable config passed to `createImageTransformer` at runtime. */
	config: unknown;
}

/** The factory each image-transformer entrypoint must export. */
export type CreateImageTransformerFn = (config: Record<string, unknown>) => ImageTransformer;

/** Storage keys safe to embed in a transform URL: a flat `{ulid}{ext}` shape. */
const SAFE_TRANSFORM_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Whether a storage key is safe to serve through the transform route. Rejects
 * anything with slashes, traversal, or query/fragment characters so the key
 * can't reroute or traverse on the storage backend.
 */
export function isSafeTransformKey(key: string): boolean {
	return SAFE_TRANSFORM_KEY.test(key);
}

/** Build the transform-route URL for a single rendition. */
export function buildTransformUrl(key: string, options: ImageTransformOptions): string {
	const params = new URLSearchParams();
	if (options.width) params.set("w", String(options.width));
	if (options.height) params.set("h", String(options.height));
	params.set("f", options.format ?? DEFAULT_TRANSFORM_FORMAT);
	if (options.quality) params.set("q", String(options.quality));
	return `${TRANSFORM_MEDIA_PREFIX}${encodeURIComponent(key)}?${params.toString()}`;
}

/**
 * Build a responsive `srcset` of transform-route URLs across the standard
 * breakpoints (up to 2x the rendered width), preserving aspect ratio when a
 * height is supplied.
 */
export function buildTransformSrcset(key: string, options: ImageTransformOptions): string {
	const width = options.width;
	if (!width) return "";
	const aspectRatio = width && options.height ? width / options.height : undefined;
	return responsiveWidths(width)
		.map((w) => {
			const h = aspectRatio ? Math.round(w / aspectRatio) : undefined;
			return `${buildTransformUrl(key, { ...options, width: w, height: h })} ${w}w`;
		})
		.join(", ");
}

/**
 * Build a {@link ResponsiveImage} that points at the transform route, or
 * `null` to fall back to the caller's existing path.
 *
 * Returns `null` unless all of these hold:
 *  - a transformer is available (`enabled`),
 *  - the rendered width is known (needed to size the `srcset`),
 *  - `src` is an internal same-origin media URL (`/_emdash/api/media/file/{key}`)
 *    with a safe key — external CDN/`publicUrl` media is a genuinely remote
 *    origin and is better served by the `astro:assets` path, which doesn't
 *    require a Worker self-fetch.
 */
export function buildTransformedImage(
	enabled: boolean,
	src: string,
	options: { width?: number; height?: number; format?: ImageTransformFormat },
): ResponsiveImage | null {
	if (!enabled || !options.width) return null;
	if (!src.startsWith(INTERNAL_MEDIA_PREFIX)) return null;
	const key = src.slice(INTERNAL_MEDIA_PREFIX.length);
	if (!key || !isSafeTransformKey(key)) return null;
	const transformOptions: ImageTransformOptions = {
		width: options.width,
		height: options.height,
		format: options.format ?? DEFAULT_TRANSFORM_FORMAT,
	};
	return {
		src: buildTransformUrl(key, transformOptions),
		srcset: buildTransformSrcset(key, transformOptions) || undefined,
		sizes: responsiveSizes(options.width),
	};
}

/** Outcome of parsing transform query params: validated options or an error. */
export type ParsedTransformParams =
	| { ok: true; options: ImageTransformOptions }
	| { ok: false; message: string };

/**
 * Parse and validate `?w=&h=&f=&q=` query params for the transform route.
 * Width is required; bounds are clamped/rejected so a request can't ask the
 * binding for an unbounded or nonsensical transform.
 */
export function parseTransformParams(params: URLSearchParams): ParsedTransformParams {
	const width = parseDimension(params.get("w"));
	if (width === null) return { ok: false, message: "Invalid or missing 'w' (width)" };
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

	const qualityRaw = params.get("q");
	let quality: number | undefined;
	if (qualityRaw !== null) {
		const q = Number(qualityRaw);
		if (!Number.isInteger(q) || q < 1 || q > 100) {
			return { ok: false, message: "Invalid 'q' (quality), expected 1-100" };
		}
		quality = q;
	}

	return { ok: true, options: { width, height, format, quality } };
}

/** Type guard for {@link ImageTransformFormat}. */
export function isTransformFormat(value: string): value is ImageTransformFormat {
	return (ALLOWED_TRANSFORM_FORMATS as readonly string[]).includes(value);
}

/**
 * Parse a dimension query value.
 * - `undefined`: param absent
 * - `null`: present but invalid (non-integer, out of range)
 * - `number`: valid, clamped to [1, MAX_TRANSFORM_WIDTH]
 */
function parseDimension(raw: string | null): number | undefined | null {
	if (raw === null) return undefined;
	const n = Number(raw);
	if (!Number.isInteger(n) || n < 1 || n > MAX_TRANSFORM_WIDTH) return null;
	return n;
}
