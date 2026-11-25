/**
 * Clears an image's loading placeholder once the image loads or fails, so the
 * blurhash or dominant color doesn't show through transparent areas.
 *
 * Image components mark an `<img>` that carries a placeholder with
 * {@link IMAGE_PLACEHOLDER_ATTRIBUTE}. The placeholder lives in the inline
 * `style` beside any `object-position`, so only its properties are removed.
 */
export const IMAGE_PLACEHOLDER_ATTRIBUTE = "data-emdash-placeholder";

const PLACEHOLDER_PROPERTIES = ["background-image", "background-size", "background-color"];

function clear(image: HTMLImageElement): void {
	for (const property of PLACEHOLDER_PROPERTIES) image.style.removeProperty(property);
	image.removeAttribute(IMAGE_PLACEHOLDER_ATTRIBUTE);
}

export function clearImagePlaceholders(root: ParentNode = document): void {
	for (const image of root.querySelectorAll<HTMLImageElement>(
		`img[${IMAGE_PLACEHOLDER_ATTRIBUTE}]`,
	)) {
		if (image.complete) {
			clear(image);
			continue;
		}
		const done = () => clear(image);
		image.addEventListener("load", done, { once: true });
		image.addEventListener("error", done, { once: true });
	}
}
