/**
 * EmDash UI Components
 *
 * Image component for rendering optimized images:
 *
 * ```astro
 * ---
 * import { Image } from "emdash/ui";
 * ---
 * <Image image={post.data.featured_image} />
 * ```
 *
 * Portable Text component for rich content:
 *
 * ```astro
 * ---
 * import { PortableText } from "emdash/ui";
 * ---
 * <PortableText value={post.data.content} />
 * ```
 *
 * Override specific Portable Text components:
 *
 * ```astro
 * <PortableText value={content} components={{ type: { image: MyImage } }} />
 * ```
 *
 * Render a blocks field with a component map:
 *
 * ```astro
 * ---
 * import { Blocks } from "emdash/ui";
 * import Hero from "./Hero.astro";
 * ---
 * <Blocks value={page.data.layout} components={{ hero: Hero }} />
 * ```
 */

import type { Block as PortableTextStyledBlock } from "astro-portabletext/types";

import { Block as BlockStyleComponent } from "./components/index.js";

export type { PortableTextProps, SomePortableTextComponents } from "astro-portabletext/types";
export type {
	TypedObject,
	ArbitraryTypedObject,
	PortableTextBlock,
	PortableTextMarkDefinition,
	PortableTextSpan,
	PortableTextListItemBlock,
} from "@portabletext/types";
export { usePortableText, mergeComponents } from "astro-portabletext";

// Local declarations share the name across the type and value namespaces.
export type Block = PortableTextStyledBlock;
export const Block = BlockStyleComponent;

// EmDash PortableText wrapper and components
export {
	// Main Image component for EmDash media
	EmDashImage as Image,
	// Unified media component that delegates rendering to the provider's getEmbed()
	EmDashMedia as Media,
	// Main component (wrapper with EmDash defaults)
	PortableText,
	Blocks,
	defineBlockComponents,
	// Widget components
	WidgetArea,
	// Components object for manual use
	emdashComponents,
	// Portable Text block types (prefixed to avoid collision with Image)
	Image as PTImage,
	Code,
	Embed,
	Gallery,
	Columns,
	Break,
	HtmlBlock,
	Iframe,
	Video,
	// Marks
	Superscript,
	Subscript,
	Underline,
	StrikeThrough,
	Link,
	// Public page contribution components
	EmDashHead,
	EmDashBodyStart,
	EmDashBodyEnd,
} from "./components/index.js";

export type {
	BlockComponent,
	BlockComponentProps,
	BlockComponents,
	BlockValue,
} from "./components/index.js";
