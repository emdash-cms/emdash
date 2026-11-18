import type { PluginBridgeEnv } from "./bridge.js";

export async function deleteMedia(
	env: PluginBridgeEnv,
	id: string,
): Promise<{ deleted: boolean; cacheKey?: string }> {
	const media = await env.DB.prepare("SELECT storage_key, mime_type FROM media WHERE id = ?")
		.bind(id)
		.first<{ storage_key: string; mime_type: string }>();
	if (!media) return { deleted: false };

	const result = await env.DB.prepare("DELETE FROM media WHERE id = ?").bind(id).run();
	let cacheKey: string | undefined;
	if (env.MEDIA && media.storage_key) {
		let storageDeleted = false;
		try {
			await env.MEDIA.delete(media.storage_key);
			storageDeleted = true;
		} catch {
			console.warn(`[plugin-bridge] Failed to delete R2 object: ${media.storage_key}`);
		}
		if (storageDeleted) {
			// Loaded lazily to keep the image endpoint out of the Worker's startup modules.
			const { isRouteCachedMedia } = await import("emdash/media/image-endpoint");
			if (isRouteCachedMedia(media.storage_key, media.mime_type)) cacheKey = media.storage_key;
		}
	}
	return { deleted: (result.meta?.changes ?? 0) > 0, cacheKey };
}
