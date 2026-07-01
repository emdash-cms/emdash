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
 */

// Re-export types and utilities from astro-portabletext
export {
	type PortableTextProps,
	type TypedObject,
	type SomePortableTextComponents,
	type Block,
	type ArbitraryTypedObject,
	type PortableTextBlock,
	type PortableTextMarkDefinition,
	type PortableTextSpan,
	type PortableTextListItemBlock,
	usePortableText,
	mergeComponents,
} from "astro-portabletext";

// EmDash PortableText wrapper and components
export {
	// Main Image component for EmDash media
	EmDashImage as Image,
	// Main component (wrapper with EmDash defaults)
	PortableText,
	// Block style override (paragraph/heading/blockquote — emits
	// `has-text-align-*` class when the block carries `textAlign`).
	// Shares the name with the `type Block` re-export above; the
	// type and the component live in different namespaces.
	Block,
	// Comment components
	Comments,
	CommentForm,
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
