/**
 * Public media URL resolution.
 *
 * Used at render time by the Image components to decide whether a storage
 * key should be served from the configured `publicUrl` (R2 custom domain,
 * S3 CDN) or through the internal `/_emdash/api/media/file/{key}` route.
 */
import type { Storage } from "../storage/types.js";

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
