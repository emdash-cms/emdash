import { blurhashToDataUri } from "@unpic/placeholder";

/**
 * Inline CSS that paints a blurhash behind an image. The `background` size
 * must follow `<position> /`, or browsers drop the whole declaration. Pass the
 * image's `object-position` so the blur is cropped like the image.
 */
export function blurhashBackgroundStyle(blurhash: string, position = "center"): string {
	return `background: url("${blurhashToDataUri(blurhash)}") ${position} / cover;`;
}
