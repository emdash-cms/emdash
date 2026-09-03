import type { APIRoute } from "astro";

import { requireOwnerPerm, requirePerm } from "#api/authorize.js";
import { apiError, apiSuccess, handleError, unwrapResult } from "#api/error.js";
import { DEFAULT_MAX_UPLOAD_SIZE, mediaReplaceMetadataForm } from "#api/schemas.js";
import { MUTABLE_MEDIA_CACHE_CONTROL } from "#media/image-endpoint.js";
import { normalizeMime } from "#media/mime.js";
import { computeContentHash } from "#utils/hash.js";

export const prerender = false;

const REPLACEABLE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

function preservesAspectRatio(
	width: number,
	height: number,
	sourceWidth: number,
	sourceHeight: number,
): boolean {
	return (
		Math.abs(width * sourceHeight - height * sourceWidth) <= Math.max(sourceWidth, sourceHeight)
	);
}

export const PUT: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const { id } = params;

	const editDenied = requirePerm(user, "media:edit_own");
	if (editDenied) return editDenied;
	if (!id) return apiError("INVALID_REQUEST", "Media ID required", 400);
	if (!emdash?.handleMediaGet || !emdash?.handleMediaReplaceMetadata) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}
	if (!emdash.storage) return apiError("NO_STORAGE", "Storage not configured", 500);

	const getResult = await emdash.handleMediaGet(id);
	if (!getResult.success) return unwrapResult(getResult);
	const media = getResult.data.item;
	const ownerDenied = requireOwnerPerm(
		user,
		media.authorId ?? "",
		"media:edit_own",
		"media:edit_any",
	);
	if (ownerDenied) return ownerDenied;
	if (media.status !== "ready") {
		return apiError("INVALID_STATE", "Only ready media can be replaced", 400);
	}

	const sourceMime = normalizeMime(media.mimeType);
	if (!REPLACEABLE_IMAGE_TYPES.has(sourceMime)) {
		return apiError("INVALID_TYPE", "Media type cannot be replaced", 400);
	}

	const rawMax = emdash.config.maxUploadSize ?? DEFAULT_MAX_UPLOAD_SIZE;
	if (!Number.isFinite(rawMax) || rawMax <= 0) {
		return apiError("CONFIGURATION_ERROR", "Invalid maxUploadSize configuration", 500);
	}
	const maxUploadSize = rawMax;
	const contentLength = request.headers.get("Content-Length");
	if (contentLength && parseInt(contentLength, 10) > maxUploadSize) {
		return apiError("PAYLOAD_TOO_LARGE", "Upload too large", 413);
	}

	try {
		const formData = await request.formData();
		const fileEntry = formData.get("file");
		const file = fileEntry instanceof File ? fileEntry : null;
		if (!file) return apiError("NO_FILE", "No file provided", 400);
		if (file.size === 0) return apiError("VALIDATION_ERROR", "Replacement file is empty", 400);
		if (file.size > maxUploadSize) {
			return apiError("PAYLOAD_TOO_LARGE", "Upload too large", 413);
		}

		const replacementMime = normalizeMime(file.type);
		if (!REPLACEABLE_IMAGE_TYPES.has(replacementMime) || replacementMime !== sourceMime) {
			return apiError("INVALID_TYPE", "Replacement file type must match the media item", 400);
		}

		const metadataResult = mediaReplaceMetadataForm.safeParse({
			width: formData.get("width"),
			height: formData.get("height"),
		});
		if (!metadataResult.success) {
			return apiError("VALIDATION_ERROR", "Invalid request data", 400, {
				issues: metadataResult.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			});
		}
		const { width, height } = metadataResult.data;
		if (
			(media.width !== null && width > media.width) ||
			(media.height !== null && height > media.height)
		) {
			return apiError("VALIDATION_ERROR", "Replacement dimensions cannot exceed the source", 400);
		}
		if (
			media.width !== null &&
			media.height !== null &&
			!preservesAspectRatio(width, height, media.width, media.height)
		) {
			return apiError("VALIDATION_ERROR", "Replacement aspect ratio must match the source", 400);
		}

		const bytes = new Uint8Array(await file.arrayBuffer());
		const contentHash = await computeContentHash(bytes);
		try {
			await emdash.storage.upload({
				key: media.storageKey,
				body: bytes,
				contentType: sourceMime,
				cacheControl: MUTABLE_MEDIA_CACHE_CONTROL,
			});
		} catch (error) {
			return handleError(error, "Failed to replace media", "MEDIA_REPLACE_ERROR");
		}

		const result = await emdash.handleMediaReplaceMetadata(id, media.storageKey, {
			size: file.size,
			width,
			height,
			contentHash,
		});
		if (!result.success) return unwrapResult(result);

		return apiSuccess({
			item: {
				...result.data.item,
				url: `/_emdash/api/media/file/${result.data.item.storageKey}`,
			},
		});
	} catch (error) {
		return handleError(error, "Failed to replace media", "MEDIA_REPLACE_ERROR");
	}
};
