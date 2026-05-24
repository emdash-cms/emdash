/**
 * Public media URL resolution.
 *
 * Used at render time by the Image components to decide whether a storage
 * key should be served from the configured `publicUrl` (R2 custom domain,
 * S3 CDN) or through the internal `/_emdash/api/media/file/{key}` route.
 */
import type { Storage } from "../storage/types.js";
import { INTERNAL_MEDIA_PREFIX } from "./normalize.js";

// Keys accepted by the public-URL rewrite: the `{ulid}{ext}` shape produced by
// the upload pipeline, with letters, digits, dots, dashes, and underscores.
// Slashes, `?`, `#`, and `%` are rejected so attacker-controlled content in a
// portable-text `asset.url` cannot traverse or reroute on the CDN origin.
const SAFE_STORAGE_KEY = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the public URL for a locally stored media key. Returns an empty
 * string when no key is given. When a storage adapter is supplied, defers to
 * `storage.getPublicUrl()`; otherwise returns the internal proxy route.
 */
export function resolvePublicMediaUrl(
	storage: Storage | null | undefined,
	storageKey: string,
): string {
	if (!storageKey) return "";
	if (storage) return storage.getPublicUrl(storageKey);
	return `/_emdash/api/media/file/${storageKey}`;
}

/**
 * Build the `getPublicMediaUrl` closure attached to `Astro.locals.emdash`.
 * Shared by the anonymous fast path and the full-runtime path in middleware.
 *
 * @internal
 */
export function createPublicMediaUrlResolver(
	storage: Storage | null | undefined,
): (key: string) => string {
	return (key) => resolvePublicMediaUrl(storage, key);
}

/** Input shape for {@link buildRenderMediaUrl}. */
export interface RenderMediaRef {
	/** Storage key with extension (the canonical shape from the upload pipeline). */
	storageKey?: string;
	/** Pre-baked URL (either an internal proxy URL or an external URL). */
	url?: string;
	/** Bare media id (ULID without extension); only the internal proxy can look this up. */
	id?: string;
}

/**
 * Build a render-time media URL. Prefers `storageKey`, then rewrites an
 * internal `url` via `resolve`, then falls back to the internal proxy for a
 * bare `id`. External URLs and non-matching internal-looking URLs pass
 * through untouched. Returns `""` when nothing usable is present.
 *
 * @internal
 */
export function buildRenderMediaUrl(
	resolve: ((key: string) => string) | undefined,
	ref: RenderMediaRef,
): string {
	const { storageKey, url, id } = ref;
	if (storageKey) {
		return resolve ? resolve(storageKey) : `${INTERNAL_MEDIA_PREFIX}${storageKey}`;
	}
	if (url) {
		if (resolve && url.startsWith(INTERNAL_MEDIA_PREFIX)) {
			const key = url.slice(INTERNAL_MEDIA_PREFIX.length);
			if (SAFE_STORAGE_KEY.test(key)) return resolve(key);
		}
		return url;
	}
	if (id) return `${INTERNAL_MEDIA_PREFIX}${id}`;
	return "";
}
