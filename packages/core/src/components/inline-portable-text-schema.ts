/**
 * The inline editor's extensions: the admin editor's Portable Text schema,
 * with node views for the visual-editing surface. Blocks the inline editor
 * can't edit show as placeholders and keep their content unchanged.
 */

import {
	GalleryNode,
	HtmlBlockNode,
	IframeBlockNode,
	PluginBlockNode,
	PortableTextFilledDefaults,
	PortableTextStarterKit,
	PortableTextTable,
	VideoBlockNode,
	portableTextExtensions,
} from "@emdash-cms/admin/internal/portable-text";
import type { AnyExtension, NodeViewRenderer } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

import { InlineCodeBlockExtension } from "./inline-code-block.js";
import { InlineImageExtension } from "./inline-image.js";

export const DEFAULT_TABLE_PLACEHOLDER = "Table (edit in admin)";

/**
 * Block types loaded as plugin blocks. The inline editor has no plugin
 * manifest, and a plugin may register its own `iframe` or `video` block, so
 * these keep every field they were loaded with.
 */
export const INLINE_PLUGIN_BLOCK_TYPES: ReadonlySet<string> = new Set(["iframe", "video"]);

/** A read-only view that shows `label(node)` in place of the node. */
function placeholderView(
	dataAttribute: string,
	label: (node: ProseMirrorNode) => string,
): NodeViewRenderer {
	return ({ node }) => {
		const dom = document.createElement("div");
		dom.className = "emdash-plugin-block-placeholder";
		dom.setAttribute("contenteditable", "false");
		dom.setAttribute(dataAttribute, "true");
		const render = (current: ProseMirrorNode) => {
			const blockType = current.attrs.blockType;
			if (typeof blockType === "string") dom.dataset.blockType = blockType;
			dom.textContent = label(current);
		};
		render(node);
		return {
			dom,
			update: (updated) => {
				if (updated.type !== node.type) return false;
				render(updated);
				return true;
			},
			ignoreMutation: () => true,
		};
	};
}

function pluginBlockLabel(type: string): string {
	return `Plugin block: ${type || "Block"} (edit in admin)`;
}

const InlinePluginBlockNode = PluginBlockNode.extend({
	addNodeView() {
		return placeholderView("data-emdash-plugin-block", (node) =>
			pluginBlockLabel(typeof node.attrs.blockType === "string" ? node.attrs.blockType : ""),
		);
	},
});

const InlineHtmlBlockNode = HtmlBlockNode.extend({
	addNodeView() {
		return placeholderView("data-emdash-html-block", () => "HTML block (edit in admin)");
	},
});

const InlineGalleryNode = GalleryNode.extend({
	addNodeView() {
		return placeholderView("data-emdash-plugin-block", () => pluginBlockLabel("gallery"));
	},
});

const InlineIframeBlockNode = IframeBlockNode.extend({
	addNodeView() {
		return placeholderView("data-emdash-plugin-block", () => pluginBlockLabel("iframe"));
	},
});

const InlineVideoBlockNode = VideoBlockNode.extend({
	addNodeView() {
		return placeholderView("data-emdash-plugin-block", () => pluginBlockLabel("video"));
	},
});

/**
 * The table keeps its rows and cells as editor content, so it saves
 * unchanged, but shows only a placeholder: tables are edited in the admin.
 * As an atom, the caret and arrow keys select it whole instead of moving
 * into cells the placeholder doesn't show.
 */
const InlineTable = PortableTextTable.extend<{ placeholder: string }>({
	atom: true,
	selectable: true,

	addOptions() {
		return { ...this.parent!(), placeholder: DEFAULT_TABLE_PLACEHOLDER };
	},
	addNodeView() {
		const { placeholder } = this.options;
		return placeholderView("data-emdash-table-block", () => placeholder);
	},
});

/** Every extension the inline editor's schema is built from, in the admin editor's order. */
export function inlinePortableTextExtensions({
	tablePlaceholder = DEFAULT_TABLE_PLACEHOLDER,
}: { tablePlaceholder?: string } = {}): AnyExtension[] {
	const replacements: Record<string, AnyExtension> = {
		starterKit: PortableTextStarterKit.configure({
			link: {
				HTMLAttributes: { class: "underline text-blue-600 dark:text-blue-400" },
			},
		}),
		codeBlock: InlineCodeBlockExtension,
		image: InlineImageExtension,
		htmlBlock: InlineHtmlBlockNode,
		iframeBlock: InlineIframeBlockNode,
		videoBlock: InlineVideoBlockNode,
		gallery: InlineGalleryNode,
		pluginBlock: InlinePluginBlockNode,
		table: InlineTable.configure({ placeholder: tablePlaceholder }),
	};
	return [
		...portableTextExtensions().map((extension) => replacements[extension.name] ?? extension),
		PortableTextFilledDefaults,
	];
}
