/**
 * The admin editor's ProseMirror schema, as the TipTap extensions it is built
 * from. The editor extends these nodes with node views, commands and its own
 * clipboard handling, so a document valid here is valid in the editor.
 *
 * Server-safe: nothing here touches the DOM, React or `crypto` when loaded.
 */

import { Extension, Mark, Node, getSchema, mergeAttributes, type AnyExtension } from "@tiptap/core";
import CodeBlock from "@tiptap/extension-code-block";
import Subscript from "@tiptap/extension-subscript";
import Superscript from "@tiptap/extension-superscript";
import TextAlign from "@tiptap/extension-text-align";
import type { Fragment, Node as ProseMirrorNode, Schema } from "@tiptap/pm/model";
import type { EditorState, Transaction } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";

import { CodeMarkExtension } from "../components/editor/CodeMarkExtension.js";
import { EmDashOrderedList } from "../components/editor/ordered-list.js";
import {
	PORTABLE_TEXT_BLOCK_ATTR,
	PORTABLE_TEXT_KEY_ATTR,
	PORTABLE_TEXT_SPAN_MARK,
} from "../components/editor/portableTextIdentity.js";
import {
	EmDashTable,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	TableIdentity,
} from "../components/editor/TableExtensions.js";
import { isDimension, isString } from "../internal/video-block.js";
import { TABLE_CELL_MIN_WIDTH } from "../portable-text-table.js";
import { PortableTextKeys } from "./keys.js";
import { PortableTextNormalizers, withLocalOnlyPlugins } from "./normalize.js";

export {
	CodeMarkExtension,
	EmDashOrderedList,
	EmDashTableCell,
	EmDashTableHeader,
	EmDashTableRow,
	PortableTextKeys,
	PortableTextNormalizers,
	TableIdentity,
};

const URL_SCHEME_REGEX = /^[a-z][a-z0-9+.-]*:/i;
const WWW_PREFIX_REGEX = /^www\./i;

export const PortableTextIdentityExtension = Extension.create({
	name: "emdashPortableTextIdentity",

	addGlobalAttributes() {
		const hiddenAttribute = { default: null, rendered: false };
		return [
			{
				types: [
					"paragraph",
					"heading",
					"blockquote",
					"codeBlock",
					"htmlBlock",
					"iframeBlock",
					"image",
					"videoBlock",
					"horizontalRule",
					"gallery",
					"table",
					"tableRow",
					"tableCell",
					"tableHeader",
					"pluginBlock",
					"hardBreak",
				],
				attributes: { [PORTABLE_TEXT_KEY_ATTR]: hiddenAttribute },
			},
			{
				types: ["pluginBlock"],
				attributes: { [PORTABLE_TEXT_BLOCK_ATTR]: hiddenAttribute },
			},
		];
	},
});

// ProseMirror text nodes cannot carry schema attributes, so a non-rendered mark
// keeps each Portable Text span's key and referenced mark definitions attached.
export const PortableTextSpanIdentity = Mark.create({
	name: PORTABLE_TEXT_SPAN_MARK,
	inclusive: false,
	spanning: false,

	addAttributes() {
		return {
			key: { default: null, rendered: false },
			markDefs: { default: [], rendered: false },
		};
	},

	parseHTML() {
		return [];
	},

	renderHTML() {
		return ["span", 0];
	},
});

const changedLastBlock = (
	transactions: readonly Transaction[],
	oldState: EditorState,
	newState: EditorState,
) =>
	transactions.some((transaction) => transaction.docChanged) &&
	oldState.doc.lastChild !== newState.doc.lastChild;

/**
 * Quotes and list items hold only what Portable Text stores for them: quoted
 * paragraphs, and list item text with nested lists.
 *
 * Lists, list items, quotes, tables and cells may be empty, and a list item
 * may start with a nested list: y-tiptap deletes a merged node the schema
 * rejects, with everything other clients put in it. The editor gives back the
 * shapes its own edits take from them (`PortableTextNormalizers`).
 */
export const PortableTextStarterKit = StarterKit.extend({
	addExtensions() {
		return (this.parent?.() ?? []).map((extension) => {
			if (extension.name === "blockquote") return extension.extend({ content: "paragraph*" });
			if (extension.name === "bulletList") return extension.extend({ content: "listItem*" });
			if (extension.name === "listItem") {
				return extension.extend({ content: "(paragraph | bulletList | orderedList)*" });
			}
			if (extension.name === "trailingNode")
				return withLocalOnlyPlugins(extension, changedLastBlock);
			if (extension.name === "link") return withLocalOnlyPlugins(extension);
			return extension;
		});
	},
}).configure({
	// Replaced with TopBlockDocument so top-level-only blocks can't be nested.
	document: false,
	heading: {
		levels: [1, 2, 3, 4, 5, 6],
	},
	dropcursor: {
		color: "#3b82f6",
		width: 2,
	},
	// Replaced with CodeBlockNode (the editor's CodeBlockExtension adds a language picker).
	codeBlock: false,
	// Replaced with CodeMarkExtension so inline code can combine with link/etc.
	code: false,
	orderedList: false,
	// StarterKit v3 includes Link and Underline
	link: {
		shouldAutoLink: (url) => URL_SCHEME_REGEX.test(url) || WWW_PREFIX_REGEX.test(url),
		openOnClick: false,
		// TipTap's Link extension defaults HTMLAttributes.target to "_blank".
		// Without an explicit override every link created via setLink would be
		// serialized as blank: true, even though there is no UI to enable it.
		HTMLAttributes: {
			target: null,
			class: "text-kumo-link underline",
		},
	},
	underline: {},
});

/**
 * Document node that also accepts `topBlock` nodes. Quotes, list items and
 * table cells accept only `block`, so ProseMirror can't nest a top-level
 * block there, where the Portable Text converters would drop it.
 */
export const TopBlockDocument = Node.create({
	name: "doc",
	topNode: true,
	content: "(block | topBlock)+",
});

/** The editor's code block has the same schema, on top of `CodeBlockLowlight`. */
export const CodeBlockNode = CodeBlock.configure({
	defaultLanguage: "plaintext",
	enableTabIndentation: true,
	tabSize: 4,
});

/** A top-level atom. The editor's global drag handle moves it. */
export const HtmlBlockNode = Node.create({
	name: "htmlBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			html: {
				default: "",
				// Store the raw markup in a semantic `data-html-content` attribute
				// rather than leaking it as a bare `html="..."` attribute on every
				// DOM/clipboard serialization (drag, copy, paste).
				parseHTML: (element) => element.getAttribute("data-html-content") ?? "",
				renderHTML: (attributes) => {
					const html = typeof attributes.html === "string" ? attributes.html : "";
					if (!html) return {};
					return { "data-html-content": html };
				},
			},
			css: {
				default: "",
				parseHTML: (element) => element.getAttribute("data-html-css") ?? "",
				renderHTML: (attributes) =>
					typeof attributes.css === "string" && attributes.css
						? { "data-html-css": attributes.css }
						: {},
			},
			js: {
				default: "",
				parseHTML: (element) => element.getAttribute("data-html-js") ?? "",
				renderHTML: (attributes) =>
					typeof attributes.js === "string" && attributes.js
						? { "data-html-js": attributes.js }
						: {},
			},
			isolated: {
				default: false,
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "div[data-html-block]",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-html-block": "" })];
	},
});

/** A top-level atom. The editor's global drag handle moves it. */
export const IframeBlockNode = Node.create({
	name: "iframeBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			src: { default: "" },
			title: { default: "" },
			width: { default: null },
			height: { default: null },
			allow: { default: "" },
			allowFullscreen: { default: false },
		};
	},

	parseHTML() {
		return [{ tag: "div[data-iframe-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-iframe-block": "" })];
	},
});

function videoTextAttribute(name: string, attribute: string, fallback: string | null) {
	return {
		default: fallback,
		parseHTML: (element: HTMLElement) =>
			element.getAttribute(`data-video-${attribute}`) ?? fallback,
		renderHTML: (attributes: Record<string, unknown>) => {
			const value = attributes[name];
			return isString(value) && value ? { [`data-video-${attribute}`]: value } : {};
		},
	};
}

function videoNumberAttribute(name: string) {
	return {
		default: null,
		parseHTML: (element: HTMLElement) => {
			const value = Number(element.getAttribute(`data-video-${name}`));
			return isDimension(value) ? value : null;
		},
		renderHTML: (attributes: Record<string, unknown>) =>
			isDimension(attributes[name]) ? { [`data-video-${name}`]: String(attributes[name]) } : {},
	};
}

/**
 * A top-level atom. The editor's global drag handle moves it, so dragging the
 * player's seek bar can't move the block.
 */
export const VideoBlockNode = Node.create({
	name: "videoBlock",
	group: "topBlock",
	atom: true,
	draggable: false,
	selectable: true,

	addAttributes() {
		return {
			src: videoTextAttribute("src", "src", ""),
			mediaId: videoTextAttribute("mediaId", "media-id", null),
			provider: videoTextAttribute("provider", "provider", null),
			caption: videoTextAttribute("caption", "caption", ""),
			width: videoNumberAttribute("width"),
			height: videoNumberAttribute("height"),
		};
	},

	parseHTML() {
		return [{ tag: "figure[data-video-block]" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["figure", mergeAttributes(HTMLAttributes, { "data-video-block": "" })];
	},
});

export const GalleryNode = Node.create({
	name: "gallery",

	group: "block",

	atom: true,

	draggable: true,

	addAttributes() {
		return {
			images: {
				default: [],
			},
			columns: {
				default: null,
			},
		};
	},

	parseHTML() {
		return [{ tag: 'div[data-type="gallery"]' }];
	},

	renderHTML() {
		return ["div", { "data-type": "gallery" }];
	},
});

export const ImageNode = Node.create({
	name: "image",

	addOptions() {
		return {
			inline: false,
			allowBase64: false,
			HTMLAttributes: {},
		};
	},

	inline() {
		return this.options.inline;
	},

	group() {
		return this.options.inline ? "inline" : "block";
	},

	draggable: true,

	addAttributes() {
		return {
			src: {
				default: null,
			},
			alt: {
				default: null,
			},
			title: {
				default: null,
			},
			caption: {
				default: null,
			},
			mediaId: {
				default: null,
			},
			/** Provider ID for external media (e.g., "cloudflare-images") */
			provider: {
				default: null,
			},
			width: {
				default: null,
			},
			height: {
				default: null,
			},
			blurhash: {
				default: null,
			},
			dominantColor: {
				default: null,
			},
			displayWidth: {
				default: null,
			},
			displayHeight: {
				default: null,
			},
			alignment: {
				default: null,
			},
			link: {
				default: null,
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "img[src]",
			},
		];
	},

	renderHTML({ HTMLAttributes }: { HTMLAttributes: Record<string, unknown> }) {
		return ["img", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes)];
	},
});

export const PluginBlockNode = Node.create({
	name: "pluginBlock",
	group: "block",
	atom: true,
	draggable: true,
	selectable: true,

	addAttributes() {
		return {
			blockType: {
				default: null,
			},
			id: {
				default: null,
			},
			data: {
				default: {},
				parseHTML: (el: HTMLElement) => JSON.parse(el.getAttribute("data-plugin-data") || "{}"),
				renderHTML: (attrs: Record<string, unknown>) => ({
					"data-plugin-data": JSON.stringify(attrs.data),
				}),
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "div[data-plugin-block]",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return ["div", mergeAttributes(HTMLAttributes, { "data-plugin-block": "" })];
	},
});

export const SubscriptMark = Subscript.extend({ excludes: "superscript" });
export const SuperscriptMark = Superscript.extend({ excludes: "subscript" });

export const PortableTextTable = EmDashTable.configure({
	allowTableNodeSelection: true,
	cellMinWidth: TABLE_CELL_MIN_WIDTH,
	resizable: false,
});

export const PortableTextTextAlign = TextAlign.configure({
	types: ["heading", "paragraph"],
});

const FILLED_DEFAULTS: Record<string, (schema: Schema) => ProseMirrorNode> = {
	listItem: (schema) => schema.nodes.paragraph!.create(),
	bulletList: (schema) => schema.nodes.listItem!.create(null, schema.nodes.paragraph!.create()),
	orderedList: (schema) => schema.nodes.listItem!.create(null, schema.nodes.paragraph!.create()),
	blockquote: (schema) => schema.nodes.paragraph!.create(),
	tableCell: (schema) => schema.nodes.paragraph!.create(),
	tableHeader: (schema) => schema.nodes.paragraph!.create(),
};

const isEmptyContent = (
	content: Fragment | ProseMirrorNode | readonly ProseMirrorNode[] | null | undefined,
) =>
	!content ||
	("type" in content ? false : "size" in content ? content.size === 0 : content.length === 0);

/**
 * Makes `createAndFill` fill the containers that may be empty as it did when
 * they couldn't be, so commands that build them, such as `insertTable` and
 * `splitListItem`, still leave a paragraph for the caret.
 */
export function keepFilledDefaults(schema: Schema): void {
	for (const [name, fill] of Object.entries(FILLED_DEFAULTS)) {
		const type = schema.nodes[name];
		if (!type) continue;
		const createAndFill = type.createAndFill.bind(type);
		type.createAndFill = (attrs, content, marks) =>
			createAndFill(attrs, isEmptyContent(content) ? fill(schema) : content, marks);
	}
}

/** The editor's `keepFilledDefaults`. Server code never fills nodes, so only the editor adds it. */
export const PortableTextFilledDefaults = Extension.create({
	name: "emdashPortableTextFilledDefaults",

	onBeforeCreate() {
		keepFilledDefaults(this.editor.schema);
	},
});

/**
 * Every extension the schema is built from, in the editor's order. Plugins
 * and keymaps run in this order, and node and mark order is schema order.
 */
export function portableTextExtensions(): AnyExtension[] {
	return [
		PortableTextIdentityExtension,
		PortableTextSpanIdentity,
		PortableTextStarterKit,
		TopBlockDocument,
		EmDashOrderedList,
		CodeMarkExtension,
		CodeBlockNode,
		HtmlBlockNode,
		IframeBlockNode,
		VideoBlockNode,
		GalleryNode,
		ImageNode,
		PluginBlockNode,
		SubscriptMark,
		SuperscriptMark,
		PortableTextTable,
		EmDashTableRow,
		EmDashTableHeader,
		EmDashTableCell,
		TableIdentity,
		PortableTextNormalizers,
		PortableTextKeys,
		PortableTextTextAlign,
	];
}

export function portableTextSchema(): Schema {
	return getSchema(portableTextExtensions());
}
