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
import { ulid } from "ulidx";

import { requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError } from "#api/error.js";
import { GLOBAL_UPLOAD_ALLOWLIST, resolveFieldAllowlist } from "#api/handlers/media-allowlist.js";
import { isParseError, parseBody } from "#api/parse.js";
import { DEFAULT_MAX_UPLOAD_SIZE, mediaUploadUrlBody } from "#api/schemas.js";
import { MediaRepository } from "#db/repositories/media.js";
import { matchesMimeAllowlist, normalizeMime } from "#media/mime.js";

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

function isUnsupportedSignedUpload(error: unknown): boolean {
	return error instanceof Error && "code" in error && error.code === "NOT_SUPPORTED";
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
		const normalizedContentType = normalizeMime(body.contentType);

		// Validate content type (field-aware widening)
		const fieldAllowlist = body.fieldId
			? await resolveFieldAllowlist(emdash.db, body.fieldId)
			: null;
		const allowlist = fieldAllowlist ?? [...GLOBAL_UPLOAD_ALLOWLIST];

		if (!matchesMimeAllowlist(body.contentType, allowlist)) {
			return apiError("INVALID_TYPE", "File type not allowed", 400);
		}

		const repo = new MediaRepository(emdash.db);

		// Check for existing content with same hash (deduplication)
		if (body.deduplicate !== false && body.contentHash && body.size > 0) {
			const existing = await repo.findByContentHash(body.contentHash);
			if (existing && existing.mimeType === normalizedContentType && existing.size === body.size) {
				const response: ExistingMediaResponse = {
					existing: true,
					mediaId: existing.id,
					storageKey: existing.storageKey,
					url: `/_emdash/api/media/file/${existing.storageKey}`,
				};
				return apiSuccess(response);
			}
		}
		const filename = body.ensureUniqueFilename
			? await repo.findAvailableFilename(body.filename)
			: body.filename;

		// Generate unique storage key
		const id = ulid();
		const ext = path.extname(filename) || "";
		const storageKey = `${id}${ext}`;

		let signedUrl: Awaited<ReturnType<typeof emdash.storage.getSignedUploadUrl>> | null;
		try {
			signedUrl = await emdash.storage.getSignedUploadUrl({
				key: storageKey,
				contentType: body.contentType,
				size: body.size,
				expiresIn: 3600,
			});
		} catch (error) {
			if (!isUnsupportedSignedUpload(error)) throw error;
			signedUrl = null;
		}

		const mediaItem = await repo.createPending({
			filename,
			mimeType: normalizedContentType,
			size: body.size,
			storageKey,
			authorId: user?.id,
			folderId: body.folderId,
		});

		const response: UploadUrlResponse = {
			uploadUrl: signedUrl?.url ?? `/_emdash/api/media/${mediaItem.id}/upload`,
			method: signedUrl?.method ?? "PUT",
			headers: signedUrl?.headers ?? {
				"Content-Type": normalizedContentType,
				"X-EmDash-Request": "1",
			},
			mediaId: mediaItem.id,
			storageKey,
			expiresAt: signedUrl?.expiresAt ?? new Date(Date.now() + 3600 * 1000).toISOString(),
		};

		return apiSuccess(response);
	} catch (error) {
		return handleError(error, "Failed to generate upload URL", "UPLOAD_URL_ERROR");
	}
};
