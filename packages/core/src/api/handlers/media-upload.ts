/**
 * Programmatic media upload handler (MCP `media_upload` tool).
 *
 * Accepts file bytes as base64, then runs the same pipeline as the multipart
 * REST upload route: allowlist + size validation, content-hash deduplication,
 * storage upload, image metadata enrichment, and record creation.
 */

import * as path from "node:path";

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import type { Database } from "../../database/types.js";
import { enrichImageMetadata } from "../../media/enrich.js";
import { matchesMimeAllowlist, normalizeMime } from "../../media/mime.js";
import type { Storage } from "../../storage/types.js";
import { decodeBase64Bytes } from "../../utils/base64.js";
import { computeContentHash } from "../../utils/hash.js";
import { CONTENT_TYPE_RE, DEFAULT_MAX_UPLOAD_SIZE, formatFileSize } from "../schemas/media.js";
import type { ApiResult } from "../types.js";
import { GLOBAL_UPLOAD_ALLOWLIST } from "./media-allowlist.js";

export interface MediaUploadInput {
	/** Original filename (e.g. 'logo.png'); the extension is kept on the storage key. */
	filename: string;
	/** Base64-encoded file contents. */
	base64: string;
	/** MIME type of the decoded bytes. */
	contentType: string;
	/** Alt text stored on the media record. */
	alt?: string;
	authorId?: string;
	/** Upload size limit in bytes (defaults to DEFAULT_MAX_UPLOAD_SIZE). */
	maxUploadSize?: number;
}

export type MediaUploadResult = ApiResult<{
	item: MediaItem & { url: string };
	deduplicated?: boolean;
}>;

export interface MediaUploadHooks {
	beforeUpload?(file: {
		name: string;
		type: string;
		size: number;
	}): Promise<{ name: string; type: string; size: number }>;
}

function fail(code: string, message: string): MediaUploadResult {
	return { success: false, error: { code, message } };
}

/** Same relative-URL shape the REST media routes return. */
function withUrl(item: MediaItem): MediaItem & { url: string } {
	return { ...item, url: `/_emdash/api/media/file/${item.storageKey}` };
}

/** Decode the file bytes after rejecting an oversized encoded payload. */
async function acquireBytes(
	input: MediaUploadInput,
	maxUploadSize: number,
): Promise<{ bytes: Uint8Array; mimeType: string } | MediaUploadResult> {
	// Cheap size precheck on the encoded string (decoded size is ~3/4 of
	// the base64 length) before allocating the decoded buffer.
	if ((input.base64.length * 3) / 4 > maxUploadSize) {
		return fail(
			"PAYLOAD_TOO_LARGE",
			`File exceeds maximum size of ${formatFileSize(maxUploadSize)}`,
		);
	}
	try {
		return { bytes: decodeBase64Bytes(input.base64), mimeType: input.contentType };
	} catch {
		return fail("VALIDATION_ERROR", "Invalid base64 data");
	}
}

/**
 * Upload a media file from base64 data.
 *
 * Mirrors the REST `POST /_emdash/api/media` route: global MIME allowlist,
 * size limit, content-hash dedupe (returns the existing item with
 * `deduplicated: true`), storage upload with cleanup on failure, and
 * image metadata enrichment (dimensions, blurhash, dominant color).
 */
export async function handleMediaUpload(
	db: Kysely<Database>,
	storage: Storage,
	input: MediaUploadInput,
	hooks: MediaUploadHooks = {},
): Promise<MediaUploadResult> {
	if (!input.base64 || !input.contentType) {
		return fail("VALIDATION_ERROR", "base64 and contentType are required");
	}

	const rawMax = input.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE;
	if (!Number.isFinite(rawMax) || rawMax <= 0) {
		return fail("CONFIGURATION_ERROR", "Invalid maxUploadSize configuration");
	}

	const acquired = await acquireBytes(input, rawMax);
	if ("success" in acquired) return acquired;
	const { bytes } = acquired;

	// Validate the raw MIME string before normalize/allowlist: normalizeMime
	// only strips parameters and matchesMimeAllowlist only checks startsWith,
	// so without this a crafted value like "image/png\r\nX-Evil: 1" would
	// reach the storage backend's ContentType header and be echoed by the
	// media file serving route.
	if (!CONTENT_TYPE_RE.test(acquired.mimeType)) {
		return fail("VALIDATION_ERROR", "Invalid content type");
	}
	let filename = input.filename;
	let mimeType = normalizeMime(acquired.mimeType);
	let size = bytes.byteLength;

	if (!matchesMimeAllowlist(mimeType, GLOBAL_UPLOAD_ALLOWLIST)) {
		return fail("INVALID_TYPE", "File type not allowed");
	}
	if (bytes.byteLength > rawMax) {
		return fail("PAYLOAD_TOO_LARGE", `File exceeds maximum size of ${formatFileSize(rawMax)}`);
	}

	try {
		if (hooks.beforeUpload) {
			const processed = await hooks.beforeUpload({
				name: filename,
				type: mimeType,
				size: bytes.byteLength,
			});
			filename = processed.name;
			mimeType = normalizeMime(processed.type);
			size = processed.size;
			if (!CONTENT_TYPE_RE.test(processed.type)) {
				return fail("VALIDATION_ERROR", "Invalid content type");
			}
			if (!matchesMimeAllowlist(mimeType, GLOBAL_UPLOAD_ALLOWLIST)) {
				return fail("INVALID_TYPE", "File type not allowed");
			}
		}
		const contentHash = await computeContentHash(bytes);
		const repo = new MediaRepository(db);

		const existing = await repo.findByContentHash(contentHash);
		if (existing) {
			return { success: true, data: { item: withUrl(existing), deduplicated: true } };
		}

		const storageKey = `${ulid()}${path.extname(filename)}`;
		await storage.upload({ key: storageKey, body: bytes, contentType: mimeType });

		try {
			const enriched = await enrichImageMetadata(bytes, mimeType);
			const item = await repo.create({
				filename,
				mimeType,
				size,
				width: enriched.width,
				height: enriched.height,
				alt: input.alt,
				storageKey,
				contentHash,
				blurhash: enriched.blurhash,
				dominantColor: enriched.dominantColor,
				authorId: input.authorId,
			});
			return { success: true, data: { item: withUrl(item) } };
		} catch (error) {
			// Don't leave an orphaned object in storage when record creation fails
			try {
				await storage.delete(storageKey);
			} catch {
				// Ignore cleanup errors
			}
			throw error;
		}
	} catch {
		return fail("UPLOAD_ERROR", "Upload failed");
	}
}
