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

const IMAGE_URL_PATTERN = /\.(jpe?g|png|gif|webp|avif|svg)(?:\?|#|$)/i;

function collectImageUrlsFromAttrs(
	attrs: Record<string, unknown>,
): Array<{ url: string; alt?: string }> {
	const images: Array<{ url: string; alt?: string }> = [];
	const seen = new Set<string>();

	const visit = (value: unknown, carriedAlt?: string): void => {
		if (typeof value === "string") {
			if (IMAGE_URL_PATTERN.test(value) && !seen.has(value)) {
				seen.add(value);
				images.push({ url: value, alt: carriedAlt });
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const item of value) visit(item);
			return;
		}
		if (value && typeof value === "object") {
			const obj = value as Record<string, unknown>;
			const alt = typeof obj.alt === "string" ? obj.alt : undefined;
			for (const [key, child] of Object.entries(obj)) {
				if (key === "alt") continue;
				visit(child, alt);
			}
		}
	};

	visit(attrs);
	return images;
}

export const fallbackTransformer: BlockTransformer = (
	block,
	_options,
	context,
): PortableTextBlock[] => {
	// Custom theme blocks often wrap content around image URLs in their attrs
	// (hero sections, marquees, sliders). Keep the imagery so nothing is lost.
	const imageBlocks: PortableTextBlock[] = collectImageUrlsFromAttrs(block.attrs).map((img) => ({
		_type: "image",
		_key: context.generateKey(),
		asset: {
			_type: "reference",
			_ref: img.url,
			url: img.url,
		},
		alt: img.alt,
	}));

	if (imageBlocks.length === 0 && !block.innerHTML.trim() && block.innerBlocks.length === 0) {
		return [];
	}

	if (block.innerBlocks.length > 0) {
		return [...imageBlocks, ...context.transformBlocks(block.innerBlocks)];
	}

	if (imageBlocks.length > 0) {
		return imageBlocks;
	}

	return [
		{
			_type: "htmlBlock",
			_key: context.generateKey(),
			html: block.innerHTML,
			originalBlockName: block.blockName,
			originalAttrs: Object.keys(block.attrs).length > 0 ? block.attrs : undefined,
		},
	];
};

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
