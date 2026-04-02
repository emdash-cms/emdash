/**
 * Block Style Extension
 *
 * Extends TipTap's Paragraph and Heading nodes with a `cssClasses` attribute
 * for applying arbitrary CSS classes at the block level.
 *
 * In Portable Text, stored as a `cssClasses` property on the block object.
 */
import { Extension } from "@tiptap/core";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		blockStyle: {
			/**
			 * Set CSS classes on the current block
			 */
			setBlockCssClasses: (classes: string) => ReturnType;
			/**
			 * Remove CSS classes from the current block
			 */
			unsetBlockCssClasses: () => ReturnType;
			/**
			 * Toggle a CSS class string on the current block.
			 * If the block already has this exact class string, remove it.
			 * Otherwise, set it.
			 */
			toggleBlockCssClasses: (classes: string) => ReturnType;
		};
	}
}

export const BlockStyleExtension = Extension.create({
	name: "blockStyle",

	addGlobalAttributes() {
		return [
			{
				types: ["paragraph", "heading"],
				attributes: {
					cssClasses: {
						default: null,
						parseHTML: (element) => element.getAttribute("data-css-classes") || null,
						renderHTML: (attributes) => {
							if (!attributes.cssClasses) return {};
							return {
								"data-css-classes": attributes.cssClasses,
								class: attributes.cssClasses,
							};
						},
					},
				},
			},
		];
	},

	addCommands() {
		return {
			setBlockCssClasses:
				(classes: string) =>
				({ commands }) => {
					return (
						commands.updateAttributes("paragraph", { cssClasses: classes }) ||
						commands.updateAttributes("heading", { cssClasses: classes })
					);
				},
			unsetBlockCssClasses:
				() =>
				({ commands }) => {
					return (
						commands.updateAttributes("paragraph", { cssClasses: null }) ||
						commands.updateAttributes("heading", { cssClasses: null })
					);
				},
			toggleBlockCssClasses:
				(classes: string) =>
				({ editor, commands }) => {
					const { $from } = editor.state.selection;
					const node = $from.parent;
					const current = node.attrs.cssClasses;
					if (current === classes) {
						return commands.updateAttributes(node.type.name, { cssClasses: null });
					}
					return commands.updateAttributes(node.type.name, { cssClasses: classes });
				},
		};
	},
});
