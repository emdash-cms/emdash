/**
 * WordPress media import endpoint
 *
 * POST /_emdash/api/import/wordpress/media
 *
 * Downloads media attachments from WordPress URLs and uploads to EmDash storage.
 * Streams progress updates as newline-delimited JSON (NDJSON).
 * Each line is either a progress update or the final result.
 */

import * as path from "node:path";

import type { APIRoute } from "astro";
import { MediaRepository, computeContentHash } from "emdash";
import mime from "mime/lite";
import { ulid } from "ulidx";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { wpMediaImportBody } from "#api/schemas.js";
import { validateExternalUrl, ssrfSafeFetch, SsrfError } from "#import/ssrf.js";
import type { EmDashHandlers } from "#types";

import type { AttachmentInfo } from "./analyze.js";

export const prerender = false;

/** Progress update sent during streaming */
export interface MediaImportProgress {
	type: "progress";
	current: number;
	total: number;
	filename?: string;
	status: "downloading" | "uploading" | "done" | "skipped" | "failed";
	error?: string;
}

/** Final result sent at end of stream */
export interface MediaImportResult {
	type?: "result";
	/** Successfully imported items */
	imported: Array<{
		wpId?: number;
		originalUrl: string;
		newUrl: string;
		mediaId: string;
	}>;
	/** Failed items */
	failed: Array<{
		wpId?: number;
		originalUrl: string;
		error: string;
	}>;
	/** Map of old URLs to new URLs (for content rewriting) */
	urlMap: Record<string, string>;
}

export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "import:execute");
	if (denied) return denied;

	if (!emdash?.storage) {
		return apiError("NO_STORAGE", "Storage not configured. Media import requires storage.", 501);
	}

	if (!emdash?.db) {
		return apiError("NO_DB", "Database not initialized", 500);
	}

	try {
		const body = await parseBody(request, wpMediaImportBody);
		if (isParseError(body)) return body;

		const attachments = body.attachments as AttachmentInfo[];

		// Check if streaming is requested (default: true)
		const shouldStream = body.stream !== false;

		if (shouldStream) {
			// Stream progress updates as NDJSON
			const stream = new ReadableStream({
				async start(controller) {
					const encoder = new TextEncoder();
					const sendProgress = (progress: MediaImportProgress) => {
						controller.enqueue(encoder.encode(JSON.stringify(progress) + "\n"));
					};

					const result = await importMediaWithProgress(
						attachments,
						emdash.db,
						emdash.storage,
						sendProgress,
					);

					// Send final result
					controller.enqueue(encoder.encode(JSON.stringify({ ...result, type: "result" }) + "\n"));
					controller.close();
				},
			});

			return new Response(stream, {
				status: 200,
				headers: {
					"Content-Type": "application/x-ndjson",
					"Cache-Control": "private, no-store",
					"Transfer-Encoding": "chunked",
				},
			});
		}

		// Non-streaming mode
		const result = await importMediaWithProgress(
			attachments,
			emdash.db,
			emdash.storage,
			() => {}, // No-op progress callback
		);

		return apiSuccess(result);
	} catch (error) {
		return handleError(error, "Failed to import media", "IMPORT_ERROR");
	}
};

async function importMediaWithProgress(
	attachments: AttachmentInfo[],
	db: NonNullable<EmDashHandlers["db"]>,
	storage: NonNullable<EmDashHandlers["storage"]>,
	onProgress: (progress: MediaImportProgress) => void,
): Promise<MediaImportResult> {
	const repo = new MediaRepository(db);
	const total = attachments.length;

	const result: MediaImportResult = {
		imported: [],
		failed: [],
		urlMap: {},
	};

	for (let i = 0; i < attachments.length; i++) {
		const attachment = attachments[i];
		const current = i + 1;
		const filename = attachment.filename || `file-${attachment.id}`;

		if (!attachment.url) {
			result.failed.push({
				wpId: attachment.id,
				originalUrl: "",
				error: "No URL provided",
			});
			onProgress({
				type: "progress",
				current,
				total,
				filename,
				status: "failed",
				error: "No URL provided",
			});
			continue;
		}

		try {
			// SSRF: validate URL before fetching
			try {
				validateExternalUrl(attachment.url);
			} catch (e) {
				const msg = e instanceof SsrfError ? e.message : "Invalid URL";
				result.failed.push({
					wpId: attachment.id,
					originalUrl: attachment.url,
					error: `Blocked: ${msg}`,
				});
				onProgress({
					type: "progress",
					current,
					total,
					filename,
					status: "failed",
					error: `Blocked: ${msg}`,
				});
				continue;
			}

			// Report downloading
			onProgress({
				type: "progress",
				current,
				total,
				filename,
				status: "downloading",
			});

			// Download from WordPress (ssrfSafeFetch re-validates redirect targets)
			const response = await ssrfSafeFetch(attachment.url, {
				headers: {
					"User-Agent": "EmDash-Importer/1.0",
				},
			});

			if (!response.ok) {
				result.failed.push({
					wpId: attachment.id,
					originalUrl: attachment.url,
					error: `HTTP ${response.status}: ${response.statusText}`,
				});
				onProgress({
					type: "progress",
					current,
					total,
					filename,
					status: "failed",
					error: `HTTP ${response.status}`,
				});
				continue;
			}

			// Get content type from response or guess from filename
			const contentType =
				response.headers.get("content-type") || attachment.mimeType || "application/octet-stream";

			// Get the file data
			const buffer = await response.arrayBuffer();
			const size = buffer.byteLength;

			// Compute content hash for deduplication
			const contentHash = await computeContentHash(buffer);

			// Check if we already have this exact content
			const existing = await repo.findByContentHash(contentHash);
			if (existing) {
				// Same content already exists - reuse it
				const existingUrl = `/_emdash/api/media/file/${existing.storageKey}`;
				result.urlMap[attachment.url] = existingUrl;
				result.imported.push({
					wpId: attachment.id,
					originalUrl: attachment.url,
					newUrl: existingUrl,
					mediaId: existing.id,
				});
				onProgress({
					type: "progress",
					current,
					total,
					filename,
					status: "skipped",
				});
				continue;
			}

			// Report uploading
			onProgress({
				type: "progress",
				current,
				total,
				filename,
				status: "uploading",
			});

			// Generate storage key
			const id = ulid();
			const ext = attachment.filename
				? path.extname(attachment.filename)
				: getExtensionFromMimeType(contentType);
			const storageKey = `${id}${ext}`;

			// Upload to storage
			await storage.upload({
				key: storageKey,
				body: new Uint8Array(buffer),
				contentType,
			});

			// Create media record with content hash
			const mediaItem = await repo.create({
				filename: attachment.filename || `media-${attachment.id}${ext}`,
				mimeType: contentType,
				size,
				storageKey,
				contentHash,
				width: undefined,
				height: undefined,
			});

			// Build the new URL
			const newUrl = `/_emdash/api/media/file/${storageKey}`;

			result.imported.push({
				wpId: attachment.id,
				originalUrl: attachment.url,
				newUrl,
				mediaId: mediaItem.id,
			});

			// Add to URL map
			result.urlMap[attachment.url] = newUrl;

			// Report done
			onProgress({
				type: "progress",
				current,
				total,
				filename,
				status: "done",
			});
		} catch (error) {
			console.error(`Media import error for "${filename}":`, error);
			const errorMsg = "Failed to import media";
			result.failed.push({
				wpId: attachment.id,
				originalUrl: attachment.url,
				error: errorMsg,
			});
			onProgress({
				type: "progress",
				current,
				total,
				filename,
				status: "failed",
				error: errorMsg,
			});
		}
	}

	return result;
}

function getExtensionFromMimeType(mimeType: string): string {
	const ext = mime.getExtension(mimeType);
	return ext ? `.${ext}` : "";
}
