import { Extension, isNodeEmpty } from "@tiptap/core";
import type { Node } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

interface PlaceholderContext {
	node: Node;
	parent: Node | null;
	hasAnchor: boolean;
}

export function createTextBlockPlaceholder(
	getPlaceholder: (context: PlaceholderContext) => string,
) {
	return Extension.create({
		name: "textBlockPlaceholder",
		addProseMirrorPlugins() {
			return [
				new Plugin({
					key: new PluginKey("textBlockPlaceholder"),
					props: {
						decorations: ({ doc, selection }) => {
							if (!this.editor.isEditable) return null;
							const decorations: Decoration[] = [];
							const emptyDoc = isNodeEmpty(doc);

							// Traverse the supplied document so parent context and positions stay in sync.
							doc.descendants((node, pos, parent) => {
								if (node.type.name !== "paragraph" && node.type.name !== "heading") return;
								if (!isNodeEmpty(node)) return false;
								const hasAnchor =
									selection.anchor >= pos && selection.anchor <= pos + node.nodeSize;
								decorations.push(
									Decoration.node(pos, pos + node.nodeSize, {
										class: emptyDoc ? "is-empty is-editor-empty" : "is-empty",
										"data-placeholder": getPlaceholder({ node, parent, hasAnchor }),
									}),
								);
								return false;
							});
							return DecorationSet.create(doc, decorations);
						},
					},
				}),
			];
		},
	});
}
