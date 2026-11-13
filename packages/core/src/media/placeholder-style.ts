import { blurhashToDataUri } from "@unpic/placeholder";

/**
 * Inline CSS that paints a blurhash behind an image until it loads.
 * `@unpic/placeholder`'s `blurhashToImageCssString` emits `url(...) cover`,
 * which browsers reject as an invalid `background` shorthand.
 */
export function blurhashBackgroundStyle(blurhash: string): string {
	return `background: url("${blurhashToDataUri(blurhash)}") center / cover;`;
}
