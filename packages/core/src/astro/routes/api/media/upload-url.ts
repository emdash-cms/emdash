/**
 * Media upload URL endpoint
 *
 * POST /_emdash/api/media/upload-url
 *
 * Returns a signed URL for direct upload to storage.
 * Creates a pending media record that must be confirmed after upload.
 */

import * as path from "node:path";

import type { APIRoute } from "astro";
import { MediaRepository } from "emdash";
import { ulid } from "ulidx";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { DEFAULT_MAX_UPLOAD_SIZE, mediaUploadUrlBody } from "#api/schemas.js";
import { resolvePublicMediaUrl } from "#media/url.js";

export const prerender = false;

interface UploadUrlResponse {
	uploadUrl: string;
	method: "PUT";
	headers: Record<string, string>;
	mediaId: string;
	storageKey: string;
	expiresAt: string;
}

/** Response when content already exists (deduplication) */
interface ExistingMediaResponse {
	existing: true;
	mediaId: string;
	storageKey: string;
	url: string;
}

/**
 * Get a signed upload URL for direct-to-storage upload
 */
export const POST: APIRoute = async ({ request, locals }) => {
	const { emdash, user } = locals;

	const denied = requirePerm(user, "media:upload");
	if (denied) return denied;

	if (!emdash?.storage) {
		return apiError(
			"NO_STORAGE",
			"Storage not configured. Signed URL uploads require S3-compatible storage.",
			501,
		);
	}

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		const maxSize = emdash.config.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE;
		if (!Number.isFinite(maxSize) || maxSize <= 0) {
			return apiError(
				"CONFIGURATION_ERROR",
				"Invalid maxUploadSize configuration. Expected a positive finite number.",
				500,
			);
		}
		const body = await parseBody(request, mediaUploadUrlBody(maxSize));
		if (isParseError(body)) return body;

		// Validate content type
		const allowedTypes = ["image/", "video/", "audio/", "application/pdf"];
		if (!allowedTypes.some((type) => body.contentType.startsWith(type))) {
			return apiError("INVALID_TYPE", "File type not allowed", 400);
		}

		const repo = new MediaRepository(emdash.db);

		// Check for existing content with same hash (deduplication)
		if (body.contentHash) {
			const existing = await repo.findByContentHash(body.contentHash);
			if (existing) {
				const response: ExistingMediaResponse = {
					existing: true,
					mediaId: existing.id,
					storageKey: existing.storageKey,
					url: resolvePublicMediaUrl(emdash.storage, existing.storageKey),
				};
				return apiSuccess(response);
			}
		}

		// Generate unique storage key
		const id = ulid();
		const ext = path.extname(body.filename) || "";
		const storageKey = `${id}${ext}`;

		// Create pending media record with content hash
		const mediaItem = await repo.createPending({
			filename: body.filename,
			mimeType: body.contentType,
			size: body.size,
			storageKey,
			contentHash: body.contentHash,
			authorId: user?.id,
		});

		// Get signed upload URL from storage
		const signedUrl = await emdash.storage.getSignedUploadUrl({
			key: storageKey,
			contentType: body.contentType,
			size: body.size,
			expiresIn: 3600, // 1 hour
		});

		const response: UploadUrlResponse = {
			uploadUrl: signedUrl.url,
			method: signedUrl.method,
			headers: signedUrl.headers,
			mediaId: mediaItem.id,
			storageKey,
			expiresAt: signedUrl.expiresAt,
		};

		return apiSuccess(response);
	} catch (error) {
		// Check if storage doesn't support signed URLs (e.g., local storage)
		if (
			error instanceof Error &&
			"code" in error &&
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- narrowing error to check custom code property after "code" in error guard
			(error as { code: string }).code === "NOT_SUPPORTED"
		) {
			return apiError(
				"NOT_SUPPORTED",
				"Storage does not support signed upload URLs. Use direct upload.",
				501,
			);
		}

		return handleError(error, "Failed to generate upload URL", "UPLOAD_URL_ERROR");
	}
};
