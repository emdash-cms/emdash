import { blurhashToDataUri } from "@unpic/placeholder";

/**
 * Inline CSS that paints a blurhash behind an image. The `background` size
 * must follow `<position> /`, or browsers drop the whole declaration.
 */
export function blurhashBackgroundStyle(blurhash: string): string {
	return `background: url("${blurhashToDataUri(blurhash)}") center / cover;`;
}
