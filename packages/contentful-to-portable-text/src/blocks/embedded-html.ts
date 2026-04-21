/**
 * blogEmbeddedHtml → PT htmlBlock
 *
 * Contentful fields: { customHtml: string }
 * PT output: { _type: "htmlBlock", html: string }
 *
 * HTML is preserved verbatim — sanitization (if desired) is the renderer's
 * responsibility, not the converter's. The converter's job is lossless
 * transformation.
 */
import type { ContentfulEntry, PTBlock } from "../types.js";

export function transformEmbeddedHtml(
	entry: ContentfulEntry,
	key: string,
): PTBlock {
	return {
		_type: "htmlBlock",
		_key: key,
		html: (entry.fields.customHtml as string) ?? "",
	};
}
