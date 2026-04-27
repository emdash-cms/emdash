/**
 * Local Media Provider Runtime
 *
 * This is the runtime implementation loaded by the entrypoint.
 * It wraps the existing MediaRepository and storage adapter.
 *
 * Note: This provider is special because it needs access to the database
 * and storage adapter. The createMediaProvider function receives these
 * via the config object, injected by the runtime.
 */

import type { Kysely } from "kysely";

import { MediaRepository } from "../database/repositories/media.js";
import type { Database } from "../database/types.js";
import type { Storage } from "../index.js";
import type {
	CreateMediaProviderFn,
	MediaProvider,
	MediaListOptions,
	MediaProviderItem,
	MediaValue,
	EmbedResult,
	EmbedOptions,
} from "./types.js";
import { resolvePublicMediaUrl } from "./url.js";

export interface LocalMediaRuntimeConfig {
	enabled?: boolean;
	// These are injected by the runtime, not from user config
	db?: Kysely<Database>;
	storage?: Storage;
}

/**
 * Create the local media provider
 */
export const createMediaProvider: CreateMediaProviderFn<LocalMediaRuntimeConfig> = (config) => {
	const { db, storage } = config;

	if (!db) {
		throw new Error("Local media provider requires database connection");
	}

	const repo = new MediaRepository(db);

	const provider: MediaProvider = {
		async list(options: MediaListOptions) {
			const result = await repo.findMany({
				cursor: options.cursor,
				limit: options.limit,
				mimeType: options.mimeType,
				// TODO: Add search support when capabilities.search is true
			});

			return {
				items: result.items.map((item) => ({
					id: item.id,
					filename: item.filename,
					mimeType: item.mimeType,
					size: item.size ?? undefined,
					width: item.width ?? undefined,
					height: item.height ?? undefined,
					alt: item.alt ?? undefined,
					previewUrl: resolvePublicMediaUrl(storage, item.storageKey),
					meta: {
						storageKey: item.storageKey,
						caption: item.caption,
						blurhash: item.blurhash,
						dominantColor: item.dominantColor,
					},
				})),
				nextCursor: result.nextCursor,
			};
		},

		async get(id: string) {
			const item = await repo.findById(id);
			if (!item) return null;

			return {
				id: item.id,
				filename: item.filename,
				mimeType: item.mimeType,
				size: item.size ?? undefined,
				width: item.width ?? undefined,
				height: item.height ?? undefined,
				alt: item.alt ?? undefined,
				previewUrl: resolvePublicMediaUrl(storage, item.storageKey),
				meta: {
					storageKey: item.storageKey,
					caption: item.caption,
					blurhash: item.blurhash,
					dominantColor: item.dominantColor,
				},
			};
		},

		async upload(_input) {
			if (!storage) {
				throw new Error("Storage not configured for local media provider");
			}

			// This is handled by the existing media upload endpoint
			// The provider interface is used by external providers
			// For local, we delegate to the existing system
			throw new Error("Local upload should use /_emdash/api/media endpoint");
		},

		async delete(id: string) {
			const item = await repo.findById(id);
			if (!item) return;

			// Delete from storage if available
			if (storage) {
				try {
					await storage.delete(item.storageKey);
				} catch {
					// Ignore storage deletion errors
				}
			}

			await repo.delete(id);
		},

		getEmbed(value: MediaValue, _options?: EmbedOptions): EmbedResult {
			const storageKey =
				typeof value.meta?.storageKey === "string" ? value.meta.storageKey : value.id;
			const src = resolvePublicMediaUrl(storage, storageKey);
			const mimeType = value.mimeType || "";

			// Determine embed type based on MIME type
			if (mimeType.startsWith("image/")) {
				return {
					type: "image",
					src,
					width: value.width,
					height: value.height,
					alt: value.alt,
				};
			}

			if (mimeType.startsWith("video/")) {
				return {
					type: "video",
					src,
					width: value.width,
					height: value.height,
					controls: true,
					preload: "metadata",
				};
			}

			if (mimeType.startsWith("audio/")) {
				return {
					type: "audio",
					src,
					controls: true,
					preload: "metadata",
				};
			}

			// Fallback: treat as image (for unknown types)
			return {
				type: "image",
				src,
				width: value.width,
				height: value.height,
				alt: value.alt,
			};
		},

		getThumbnailUrl(id: string, _mimeType?: string) {
			// For local media, return the file URL via the configured storage
			// adapter (honors CDN/custom-domain) or the built-in file route.
			return resolvePublicMediaUrl(storage, id);
		},
	};

	return provider;
};

/**
 * Helper to convert a MediaRepository item to MediaProviderItem
 */
export function repoItemToProviderItem(
	item: {
		id: string;
		filename: string;
		mimeType: string;
		size: number | null;
		width: number | null;
		height: number | null;
		alt: string | null;
		caption: string | null;
		storageKey: string;
		blurhash: string | null;
		dominantColor: string | null;
	},
	storage?: import("../storage/types.js").Storage | null,
): MediaProviderItem {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		size: item.size ?? undefined,
		width: item.width ?? undefined,
		height: item.height ?? undefined,
		alt: item.alt ?? undefined,
		previewUrl: resolvePublicMediaUrl(storage, item.storageKey),
		meta: {
			storageKey: item.storageKey,
			caption: item.caption,
			blurhash: item.blurhash,
			dominantColor: item.dominantColor,
		},
	};
}
