import type { Kysely } from "kysely";

import {
	MediaRepository,
	type MediaItem as RepositoryMediaItem,
} from "../database/repositories/media.js";
import type { Database } from "../database/types.js";
import { isValidFocalPointUpdate } from "../media/focal-point.js";
import type { Storage } from "../storage/types.js";
import type { MediaBytes, MediaItem, MediaMetadataPatch } from "./types.js";

export const DEFAULT_PLUGIN_MEDIA_READ_BYTES = 10 * 1024 * 1024;
export const MAX_PLUGIN_MEDIA_READ_BYTES = 16 * 1024 * 1024;

function mediaUrl(item: RepositoryMediaItem): string {
	return `/_emdash/api/media/asset/${encodeURIComponent(item.id)}/${encodeURIComponent(item.filename)}`;
}

export function toPluginMediaItem(item: RepositoryMediaItem): MediaItem {
	return {
		id: item.id,
		filename: item.filename,
		mimeType: item.mimeType,
		size: item.size,
		url: mediaUrl(item),
		createdAt: item.createdAt,
		width: item.width,
		height: item.height,
		alt: item.alt,
		caption: item.caption,
		focalX: item.focalX,
		focalY: item.focalY,
		blurhash: item.blurhash,
		dominantColor: item.dominantColor,
		folderId: item.folderId ?? null,
		status: "ready",
	};
}

function resolveByteLimit(maxBytes: number | undefined): number {
	const limit = maxBytes ?? DEFAULT_PLUGIN_MEDIA_READ_BYTES;
	if (!Number.isSafeInteger(limit) || limit <= 0 || limit > MAX_PLUGIN_MEDIA_READ_BYTES) {
		throw new RangeError(
			`media.readBytes maxBytes must be a positive integer no greater than ${MAX_PLUGIN_MEDIA_READ_BYTES}`,
		);
	}
	return limit;
}

async function readStreamWithLimit(
	body: ReadableStream<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array> {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) {
				try {
					await reader.cancel();
				} catch {}
				throw new PluginMediaByteLimitError(`Media exceeds the requested ${maxBytes}-byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

class PluginMediaByteLimitError extends RangeError {}

export async function readPluginMediaBytes(
	db: Kysely<Database>,
	storage: Pick<Storage, "download"> | undefined,
	id: string,
	options?: { maxBytes?: number },
): Promise<MediaBytes> {
	if (!storage) throw new Error("Media storage is not configured");
	const limit = resolveByteLimit(options?.maxBytes);
	const item = await new MediaRepository(db).findById(id);
	if (!item || item.status !== "ready") {
		throw new Error("Media item is not ready or does not exist");
	}
	let bytes: Uint8Array;
	try {
		const download = await storage.download(item.storageKey);
		bytes = await readStreamWithLimit(download.body, limit);
	} catch (error) {
		if (error instanceof PluginMediaByteLimitError) throw error;
		// oxlint-disable-next-line preserve-caught-error -- adapter errors may contain private storage keys
		throw new Error("Failed to read media bytes");
	}
	return {
		bytes,
		filename: item.filename,
		mimeType: item.mimeType,
		size: bytes.byteLength,
		...(item.contentHash ? { contentHash: item.contentHash } : {}),
	};
}

export async function updatePluginMediaMetadata(
	db: Kysely<Database>,
	id: string,
	patch: MediaMetadataPatch,
): Promise<MediaItem> {
	const parsed = parsePluginMediaMetadataPatch(patch);
	const item = await new MediaRepository(db).updateReadyMetadata(id, parsed);
	if (!item) throw new Error("Media item is not ready or does not exist");
	return toPluginMediaItem(item);
}

const MEDIA_METADATA_KEYS = new Set(["alt", "caption", "focalX", "focalY"]);

export function parsePluginMediaMetadataPatch(value: unknown): MediaMetadataPatch {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("media.updateMetadata patch must be an object");
	}
	const keys = Object.keys(value);
	if (keys.length === 0) {
		throw new TypeError("media.updateMetadata must change at least one metadata field");
	}
	for (const key of keys) {
		if (!MEDIA_METADATA_KEYS.has(key)) {
			throw new TypeError(`media.updateMetadata cannot change ${key}`);
		}
	}
	const alt = Reflect.get(value, "alt");
	const caption = Reflect.get(value, "caption");
	const focalX = Reflect.get(value, "focalX");
	const focalY = Reflect.get(value, "focalY");
	if (alt !== undefined && alt !== null && typeof alt !== "string") {
		throw new TypeError("media.updateMetadata alt must be a string or null");
	}
	if (caption !== undefined && caption !== null && typeof caption !== "string") {
		throw new TypeError("media.updateMetadata caption must be a string or null");
	}
	if (focalX !== undefined && focalX !== null && typeof focalX !== "number") {
		throw new TypeError("media.updateMetadata focalX must be a number or null");
	}
	if (focalY !== undefined && focalY !== null && typeof focalY !== "number") {
		throw new TypeError("media.updateMetadata focalY must be a number or null");
	}
	const patch: MediaMetadataPatch = {};
	if (alt !== undefined) patch.alt = alt;
	if (caption !== undefined) patch.caption = caption;
	if (focalX !== undefined) patch.focalX = focalX;
	if (focalY !== undefined) patch.focalY = focalY;
	if (!isValidFocalPointUpdate(patch)) {
		throw new TypeError("focalX and focalY must both be valid numbers or both be null");
	}
	return patch;
}
