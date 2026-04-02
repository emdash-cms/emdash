/**
 * CSS Class Mark Extension
 *
 * A generic TipTap mark that applies arbitrary CSS classes to inline text.
 * In Portable Text, stored as a `cssClass` markDef with a `classes` field.
 *
 * Supports multiple classes (space-separated) and nesting — a span can have
 * multiple cssClass marks with different class sets.
 */
import { Mark, mergeAttributes } from "@tiptap/core";

export interface CssClassMarkOptions {
	HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		cssClass: {
			/**
			 * Set a CSS class mark on the current selection
			 */
			setCssClass: (classes: string) => ReturnType;
			/**
			 * Toggle a CSS class mark on the current selection
			 */
			toggleCssClass: (classes: string) => ReturnType;
			/**
			 * Remove a CSS class mark from the current selection
			 */
			unsetCssClass: (classes: string) => ReturnType;
		};
	}
}

export const CssClassMark = Mark.create<CssClassMarkOptions>({
	name: "cssClass",

	addOptions() {
		return {
			HTMLAttributes: {},
		};
	},

	addAttributes() {
		return {
			classes: {
				default: null,
				parseHTML: (element) => element.getAttribute("data-css-classes"),
				renderHTML: (attributes) => {
					if (!attributes.classes) return {};
					return {
						"data-css-classes": attributes.classes,
						class: attributes.classes,
					};
				},
			},
		};
	},

	parseHTML() {
		return [
			{
				tag: "span[data-css-classes]",
			},
		];
	},

	renderHTML({ HTMLAttributes }) {
		return ["span", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
	},

	// Allow multiple instances with different classes to coexist
	excludes: "",

	addCommands() {
		return {
			setCssClass:
				(classes: string) =>
				({ commands }) => {
					return commands.setMark(this.name, { classes });
				},
			toggleCssClass:
				(classes: string) =>
				({ commands }) => {
					return commands.toggleMark(this.name, { classes });
				},
			unsetCssClass:
				(_classes: string) =>
				({ commands }) => {
					return commands.unsetMark(this.name);
				},
		};
	},
});
