/**
 * EmDash Portable Text Components
 *
 * Pre-built components for rendering Portable Text content from WordPress imports.
 *
 * Usage:
 * ```astro
 * ---
 * import { PortableText } from "emdash/ui";
 * ---
 * <PortableText value={post.data.content} />
 * ```
 *
 * The PortableText component uses EmDash's built-in renderers by default.
 * Pass custom components to override specific types:
 *
 * ```astro
 * <PortableText value={content} components={{ type: { image: MyImage } }} />
 * ```
 */

// Wrapper component with EmDash defaults
export { default as PortableText } from "./PortableText.astro";

// Comment components
export { default as Comments } from "./Comments.astro";
export { default as CommentForm } from "./CommentForm.astro";

// Widget components
export { default as WidgetArea } from "./WidgetArea.astro";

// Main Image component for EmDash media
export { default as EmDashImage } from "./EmDashImage.astro";

// Unified Media component (supports all providers)
export { default as EmDashMedia } from "./EmDashMedia.astro";

// Portable Text block type components
export { default as Image } from "./Image.astro";
export { default as Code } from "./Code.astro";
export { default as Embed } from "./Embed.astro";
export { default as Gallery } from "./Gallery.astro";
export { default as Columns } from "./Columns.astro";
export { default as Break } from "./Break.astro";
export { default as HtmlBlock } from "./HtmlBlock.astro";
export { default as Table } from "./Table.astro";
export { default as Button } from "./Button.astro";
export { default as Buttons } from "./Buttons.astro";
export { default as Cover } from "./Cover.astro";
export { default as File } from "./File.astro";
export { default as Pullquote } from "./Pullquote.astro";

// Mark components
export { default as Superscript } from "./marks/Superscript.astro";
export { default as Subscript } from "./marks/Subscript.astro";
export { default as Underline } from "./marks/Underline.astro";
export { default as StrikeThrough } from "./marks/StrikeThrough.astro";
export { default as Link } from "./marks/Link.astro";
export { default as CssClass } from "./marks/CssClass.astro";

import BlockComponent from "./Block.astro";
import BreakComponent from "./Break.astro";
import ButtonComponent from "./Button.astro";
import ButtonsComponent from "./Buttons.astro";
import CodeComponent from "./Code.astro";
import ColumnsComponent from "./Columns.astro";
import CoverComponent from "./Cover.astro";
import EmbedComponent from "./Embed.astro";
import FileComponent from "./File.astro";
import GalleryComponent from "./Gallery.astro";
import HtmlBlockComponent from "./HtmlBlock.astro";
// Pre-configured components object for PortableText
import ImageComponent from "./Image.astro";
import ListItemComponent from "./ListItem.astro";
import { emdashMarkComponents } from "./marks.js";
import PullquoteComponent from "./Pullquote.astro";
import TableComponent from "./Table.astro";

/**
 * Pre-configured components for EmDash Portable Text content
 *
 * Includes renderers for:
 * - Block types: image, code, embed, gallery, columns, break, htmlBlock, table,
 *   button, buttons, cover, file, pullquote
 * - Marks: superscript, subscript, underline, strike-through, link
 */
export const emdashComponents = {
	type: {
		image: ImageComponent,
		code: CodeComponent,
		embed: EmbedComponent,
		gallery: GalleryComponent,
		columns: ColumnsComponent,
		break: BreakComponent,
		htmlBlock: HtmlBlockComponent,
		table: TableComponent,
		button: ButtonComponent,
		buttons: ButtonsComponent,
		cover: CoverComponent,
		file: FileComponent,
		pullquote: PullquoteComponent,
	},
	// Block + ListItem overrides apply persisted block-level cssClasses to the
	// rendered element. Without these, plugin-defined block styles would never
	// reach the published HTML even though they round-trip through the editor.
	block: BlockComponent,
	listItem: ListItemComponent,
	mark: emdashMarkComponents,
};

// Public page contribution components
export { default as EmDashHead } from "./EmDashHead.astro";
export { default as EmDashBodyStart } from "./EmDashBodyStart.astro";
export { default as EmDashBodyEnd } from "./EmDashBodyEnd.astro";
