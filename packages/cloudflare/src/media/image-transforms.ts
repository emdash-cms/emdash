import type { MediaTransformDescriptor } from "emdash";

export interface CloudflareImageTransformsConfig {
	/** Name of the Images binding in wrangler.jsonc. */
	binding: string;
	/** Maximum time to wait for a transformation before serving the original file. */
	timeoutMs?: number;
	/** Default resize width when the request does not include a valid `?width=`. */
	defaultWidth?: number;
	/** Maximum allowed resize width. */
	maxWidth?: number;
	/** Output quality passed to Cloudflare Images. */
	quality?: number;
}

export const CLOUDFLARE_IMAGE_TRANSFORM_TYPES = [
	"image/jpeg",
	"image/png",
	"image/webp",
	"image/avif",
];

export function cloudflareImageTransforms(
	config: CloudflareImageTransformsConfig,
): MediaTransformDescriptor {
	return {
		entrypoint: "@emdash-cms/cloudflare/media/image-transforms",
		config,
		contentTypes: CLOUDFLARE_IMAGE_TRANSFORM_TYPES,
	};
}
