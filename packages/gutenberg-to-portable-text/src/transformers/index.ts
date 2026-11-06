/**
 * Block transformers registry
 */

import type { BlockTransformer, PortableTextBlock } from "../types.js";
import * as core from "./core.js";
import * as embed from "./embed.js";

/**
 * Default block transformers for core WordPress blocks
 */
export const defaultTransformers: Record<string, BlockTransformer> = {
	// Text blocks
	"core/paragraph": core.paragraph,
	"core/heading": core.heading,
	"core/list": core.list,
	"core/quote": core.quote,
	"core/code": core.code,
	"core/preformatted": core.preformatted,
	"core/pullquote": core.pullquote,
	"core/verse": core.verse,

	// Media blocks
	"core/image": core.image,
	"core/gallery": core.gallery,
	"core/file": core.file,
	"core/media-text": core.mediaText,
	"core/cover": core.cover,

	// Layout blocks
	"core/columns": core.columns,
	"core/group": core.group,
	"core/separator": core.separator,
	"core/spacer": core.separator,
	"core/table": core.table,
	"core/buttons": core.buttons,
	"core/button": core.button,

	// Structural blocks
	"core/more": core.more,
	"core/nextpage": core.nextpage,

	// Pass-through blocks (preserve as HTML)
	"core/html": core.html,
	"core/shortcode": core.shortcode,

	// Embed blocks
	"core/embed": embed.embed,
	"core/video": embed.video,
	"core/audio": embed.audio,

	// Legacy embed block names (WP < 5.6)
	"core-embed/youtube": embed.youtube,
	"core-embed/twitter": embed.twitter,
	"core-embed/vimeo": embed.vimeo,
	"core-embed/facebook": embed.embed,
	"core-embed/instagram": embed.embed,
	"core-embed/soundcloud": embed.embed,
	"core-embed/spotify": embed.embed,
};

/**
 * Fallback transformer for unknown blocks
 * Stores the original HTML for manual review
 */
export const fallbackTransformer: BlockTransformer = (
	block,
	_options,
	context,
): PortableTextBlock[] => {
	let html = block.innerHTML;

	if (!html.trim() && block.innerBlocks.length === 0) {
		// Whitespace between blocks parses as a block without a name
		if (!block.blockName) {
			return [];
		}
		// A dynamic block has no saved markup because WordPress renders it
		// on the server, so keep its block comment as a placeholder.
		html = serializeBlockComment(block.blockName, block.attrs);
	}

	// If it has inner blocks, try to transform those
	if (block.innerBlocks.length > 0) {
		return context.transformBlocks(block.innerBlocks);
	}

	// Store as HTML fallback
	return [
		{
			_type: "htmlBlock",
			_key: context.generateKey(),
			html,
			originalBlockName: block.blockName,
			originalAttrs: Object.keys(block.attrs).length > 0 ? block.attrs : undefined,
		},
	];
};

/**
 * Serialize a block as a self-closing block comment, escaping the attributes
 * the same way WordPress does so the JSON cannot end the HTML comment.
 */
function serializeBlockComment(blockName: string, attrs: Record<string, unknown>): string {
	const name = blockName.startsWith("core/") ? blockName.slice("core/".length) : blockName;
	const json =
		Object.keys(attrs).length > 0
			? JSON.stringify(attrs)
					.replaceAll("--", "\\u002d\\u002d")
					.replaceAll("<", "\\u003c")
					.replaceAll(">", "\\u003e")
					.replaceAll("&", "\\u0026")
					.replaceAll('\\"', "\\u0022")
			: "";
	return `<!-- wp:${name} ${json ? `${json} ` : ""}/-->`;
}

/**
 * Get transformer for a block
 */
export function getTransformer(
	blockName: string | null,
	customTransformers?: Record<string, BlockTransformer>,
): BlockTransformer {
	if (!blockName) {
		return fallbackTransformer;
	}

	// Check custom transformers first
	if (customTransformers?.[blockName]) {
		return customTransformers[blockName];
	}

	// Check default transformers
	if (defaultTransformers[blockName]) {
		return defaultTransformers[blockName];
	}

	return fallbackTransformer;
}
