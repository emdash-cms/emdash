/**
 * Programmatic media upload handler (MCP `media_upload` tool).
 *
 * Accepts file bytes as base64 or fetches them from an external URL
 * (SSRF-guarded), then runs the same pipeline as the multipart REST
 * upload route: allowlist + size validation, content-hash deduplication,
 * storage upload, image metadata enrichment, and record creation.
 */

import * as path from "node:path";

import type { Kysely } from "kysely";
import { ulid } from "ulidx";

import { MediaRepository, type MediaItem } from "../../database/repositories/media.js";
import type { Database } from "../../database/types.js";
import { enrichImageMetadata } from "../../media/enrich.js";
import { matchesMimeAllowlist, normalizeMime } from "../../media/mime.js";
import { SsrfError, ssrfSafeFetch } from "../../security/ssrf.js";
import type { Storage } from "../../storage/types.js";
import { decodeBase64Bytes } from "../../utils/base64.js";
import { computeContentHash } from "../../utils/hash.js";
import { CONTENT_TYPE_RE, DEFAULT_MAX_UPLOAD_SIZE, formatFileSize } from "../schemas/media.js";
import type { ApiResult } from "../types.js";
import { GLOBAL_UPLOAD_ALLOWLIST } from "./media-allowlist.js";

export interface MediaUploadInput {
	/** Original filename (e.g. 'logo.png'); the extension is kept on the storage key. */
	filename: string;
	/** Base64-encoded file contents. Exactly one of `base64` / `url` must be set. */
	base64?: string;
	/** External http(s) URL to fetch the file from. Exactly one of `base64` / `url` must be set. */
	url?: string;
	/**
	 * MIME type. Required with `base64`; optional with `url` (falls back to
	 * the response's Content-Type header).
	 */
	contentType?: string;
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

function fail(code: string, message: string): MediaUploadResult {
	return { success: false, error: { code, message } };
}

/** Same relative-URL shape the REST media routes return. */
function withUrl(item: MediaItem): MediaItem & { url: string } {
	return { ...item, url: `/_emdash/api/media/file/${item.storageKey}` };
}

/** Strip parameters from a Content-Type header value (e.g. '; charset=...'). */
function bareMime(headerValue: string): string {
	return (headerValue.split(";")[0] ?? "").trim();
}

/**
 * Acquire the file bytes and MIME type from either the base64 payload or
 * the external URL. Returns an error result on any validation failure.
 */
async function acquireBytes(
	input: MediaUploadInput,
	maxUploadSize: number,
): Promise<{ bytes: Uint8Array; mimeType: string } | MediaUploadResult> {
	if (input.base64) {
		if (!input.contentType) {
			return fail("VALIDATION_ERROR", "contentType is required when uploading base64 data");
		}
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

	// url mode — the caller guarantees exactly one source, so url is set here
	const url = input.url;
	if (!url) {
		return fail("VALIDATION_ERROR", "Provide exactly one of 'base64' or 'url'");
	}
	let response: Response;
	try {
		response = await ssrfSafeFetch(url, { headers: { accept: "*/*" } });
	} catch (error) {
		if (error instanceof SsrfError) {
			return fail("VALIDATION_ERROR", `URL not allowed: ${error.message}`);
		}
		return fail("FETCH_ERROR", "Failed to fetch file from URL");
	}
	if (!response.ok) {
		return fail("FETCH_ERROR", `Failed to fetch file from URL (HTTP ${response.status})`);
	}

	const contentLength = response.headers.get("Content-Length");
	if (contentLength && parseInt(contentLength, 10) > maxUploadSize) {
		return fail(
			"PAYLOAD_TOO_LARGE",
			`File exceeds maximum size of ${formatFileSize(maxUploadSize)}`,
		);
	}

	const mimeType = input.contentType ?? bareMime(response.headers.get("Content-Type") ?? "");
	if (!mimeType) {
		return fail("VALIDATION_ERROR", "Could not determine MIME type — pass contentType explicitly");
	}

	const bytes = new Uint8Array(await response.arrayBuffer());
	return { bytes, mimeType };
}

/**
 * Upload a media file from base64 data or an external URL.
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
): Promise<MediaUploadResult> {
	if (!input.base64 === !input.url) {
		return fail("VALIDATION_ERROR", "Provide exactly one of 'base64' or 'url'");
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
	const mimeType = normalizeMime(acquired.mimeType);

	if (!matchesMimeAllowlist(mimeType, GLOBAL_UPLOAD_ALLOWLIST)) {
		return fail("INVALID_TYPE", "File type not allowed");
	}
	if (bytes.byteLength > rawMax) {
		return fail("PAYLOAD_TOO_LARGE", `File exceeds maximum size of ${formatFileSize(rawMax)}`);
	}

	try {
		const contentHash = await computeContentHash(bytes);
		const repo = new MediaRepository(db);

		const existing = await repo.findByContentHash(contentHash);
		if (existing) {
			return { success: true, data: { item: withUrl(existing), deduplicated: true } };
		}

		const storageKey = `${ulid()}${path.extname(input.filename)}`;
		await storage.upload({ key: storageKey, body: bytes, contentType: mimeType });

		try {
			const enriched = await enrichImageMetadata(bytes, mimeType);
			const item = await repo.create({
				filename: input.filename,
				mimeType,
				size: bytes.byteLength,
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
