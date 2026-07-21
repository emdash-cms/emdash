import { Mark } from "@tiptap/core";

/**
 * Subscript mark for TipTap.
 *
 * Wraps selected text in a <sub> element. Implemented as a custom mark so
 * no new workspace dependencies are required.
 */
export const Subscript = Mark.create({
	name: "subscript",

	parseHTML() {
		return [{ tag: "sub" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["sub", HTMLAttributes, 0];
	},
});

/**
 * Superscript mark for TipTap.
 *
 * Wraps selected text in a <sup> element. Implemented as a custom mark so
 * no new workspace dependencies are required.
 */
export const Superscript = Mark.create({
	name: "superscript",

	parseHTML() {
		return [{ tag: "sup" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["sup", HTMLAttributes, 0];
	},
});
