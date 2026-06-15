/**
 * Cloudflare Images binding — image transformer RUNTIME ENTRY.
 *
 * Resizes media source bytes with the Cloudflare `IMAGES` binding. Imported at
 * runtime via the `images` descriptor (see `imageBinding()`); the EmDash
 * transform route reads bytes from storage and passes them here, so no public
 * fetch of the media URL is required.
 *
 * This module imports from `cloudflare:workers` to access the binding. Do NOT
 * import it at config time — use `imageBinding()` from `@emdash-cms/cloudflare`.
 */

import { env } from "cloudflare:workers";
import type { CreateImageTransformerFn, ImageTransformFormat, TransformedImage } from "emdash";

/** Map EmDash's short format names to the MIME types the binding expects. */
const FORMAT_MIME: Record<ImageTransformFormat, ImageOutputOptions["format"]> = {
	webp: "image/webp",
	avif: "image/avif",
	jpeg: "image/jpeg",
	png: "image/png",
};

/**
 * Create the Cloudflare Images binding transformer.
 *
 * Resolves the binding by name from the Worker env at request time.
 */
export const createImageTransformer: CreateImageTransformerFn = (config) => {
	const bindingName =
		typeof config.binding === "string" && config.binding ? config.binding : "IMAGES";

	// env from cloudflare:workers has no index signature, so a cast is needed.
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Images binding accessed from untyped env object
	const images = (env as Record<string, unknown>)[bindingName] as ImagesBinding | undefined;

	if (!images) {
		throw new Error(
			`Cloudflare Images binding "${bindingName}" not found. ` +
				`Add it to wrangler.jsonc:\n` +
				`{\n  "images": {\n    "binding": "${bindingName}"\n  }\n}`,
		);
	}

	return {
		async transform(input, options): Promise<TransformedImage> {
			const mime = FORMAT_MIME[options.format ?? "webp"] ?? "image/webp";

			const transform: ImageTransform = {};
			if (options.width) transform.width = options.width;
			if (options.height) transform.height = options.height;

			const output: ImageOutputOptions = { format: mime };
			if (options.quality) output.quality = options.quality;

			const result = await images.input(input).transform(transform).output(output);
			const response = result.response();
			if (!response.body) {
				throw new Error("Cloudflare Images transform produced an empty body");
			}

			return {
				body: response.body,
				contentType: response.headers.get("Content-Type") ?? mime,
			};
		},
	};
};
