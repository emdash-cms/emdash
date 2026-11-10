import type { PluginContext } from "emdash/plugin";

import { requireHttp, uploadBlob, type BlobRef } from "./atproto.js";
import { getContentData, getString } from "./content.js";

const MAX_IMAGE_BYTES = 1_000_000;
const MEDIA_BYTE_LIMIT_ERROR = /exceeds the requested \d+-byte limit/;
const IMAGE_MIME_TYPE = /^image\/[^\s/]+$/;
const URL_LIKE = /^(?:[a-z][a-z\d+.-]*:|\/)/i;
const OVERSIZED_IMAGE = "The image exceeds 1,000,000 bytes. Choose a smaller image.";
const MEDIA_PERMISSION = "Approve the plugin’s media byte access permission and try again.";

class CoverImageWarning extends Error {}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export async function uploadCoverImage(
	ctx: PluginContext,
	content: Record<string, unknown>,
	siteUrl: string,
	pdsHost: string,
	accessJwt: string,
): Promise<{ blob?: BlobRef; warning?: string }> {
	const data = getContentData(content);
	const image = [
		data.cover_image,
		content.cover_image,
		data.featured_image,
		content.featured_image,
	].find((candidate) => candidate !== undefined && candidate !== null && candidate !== "");
	if (image === undefined) return {};

	try {
		const value = asRecord(image);
		const provider = value && getString(value, "provider");
		const src = typeof image === "string" ? image : value && getString(value, "src");
		const srcId = src && !URL_LIKE.test(src) ? src : undefined;
		const id = value && getString(value, "id");
		const localId = !provider || provider === "local" ? srcId || id : undefined;
		let bytes: ArrayBuffer;
		let mimeType: string;
		if (localId) {
			if (!ctx.media?.readBytes) throw new CoverImageWarning(MEDIA_PERMISSION);
			const media = await ctx.media
				.readBytes(localId, { maxBytes: MAX_IMAGE_BYTES })
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					let warning = "Media could not be read. Check media storage and try again.";
					if (message.includes("Missing capability: media:bytes:read")) warning = MEDIA_PERMISSION;
					else if (MEDIA_BYTE_LIMIT_ERROR.test(message)) warning = OVERSIZED_IMAGE;
					else if (message.includes("Media item is not ready or does not exist")) {
						warning =
							"The media ID is unavailable or not ready. Select the image again from the media library.";
					}
					throw new CoverImageWarning(warning, { cause: error });
				});
			bytes = new Uint8Array(media.bytes).buffer;
			mimeType = media.mimeType;
		} else {
			if (!src) throw new CoverImageWarning("The image has no readable media ID or URL.");
			const url = new URL(src, siteUrl);
			if (url.protocol !== "http:" && url.protocol !== "https:")
				throw new CoverImageWarning("The image URL must use HTTP or HTTPS.");
			const res = await requireHttp(ctx).fetch(url.href);
			if (!res.ok) throw new CoverImageWarning(`Image download failed (HTTP ${res.status}).`);
			if (!res.body) throw new CoverImageWarning("Image download returned an empty response.");
			const reader = res.body.getReader();
			const chunks: Uint8Array[] = [];
			let length = 0;
			try {
				while (true) {
					const { done, value: chunk } = await reader.read();
					if (done) break;
					length += chunk.byteLength;
					if (length > MAX_IMAGE_BYTES) {
						await reader.cancel();
						throw new CoverImageWarning(OVERSIZED_IMAGE);
					}
					chunks.push(chunk);
				}
			} finally {
				reader.releaseLock();
			}
			const body = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				body.set(chunk, offset);
				offset += chunk.byteLength;
			}
			bytes = body.buffer;
			mimeType = res.headers.get("content-type") || "image/jpeg";
		}
		mimeType = mimeType.split(";")[0]!.trim().toLowerCase();
		if (bytes.byteLength > MAX_IMAGE_BYTES) throw new CoverImageWarning(OVERSIZED_IMAGE);
		if (!IMAGE_MIME_TYPE.test(mimeType))
			throw new CoverImageWarning("The media must have an image content type.");
		return { blob: await uploadBlob(ctx, pdsHost, accessJwt, bytes, mimeType) };
	} catch (error) {
		ctx.log.warn("Failed to upload cover image, skipping", error);
		return {
			warning:
				error instanceof CoverImageWarning
					? `Cover image skipped: ${error.message}`
					: "Cover image skipped: download or upload failed. Check the image URL and PDS connection.",
		};
	}
}
