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
				(classes: string) =>
				({ state, tr, dispatch }) => {
					const { from, to, empty } = state.selection;
					const markType = state.schema.marks[this.name];
					if (!markType) return false;

					if (empty) {
						// Remove only the matching stored mark so other cssClass marks remain active
						const stored = state.storedMarks ?? state.selection.$from.marks();
						const match = stored.find((m) => m.type === markType && m.attrs?.classes === classes);
						if (match && dispatch) {
							tr.removeStoredMark(match);
							dispatch(tr);
						}
						return !!match;
					}

					let removed = false;
					state.doc.nodesBetween(from, to, (node, pos) => {
						if (!node.isInline) return;
						for (const mark of node.marks) {
							if (mark.type === markType && mark.attrs?.classes === classes) {
								const start = Math.max(pos, from);
								const end = Math.min(pos + node.nodeSize, to);
								tr.removeMark(start, end, mark);
								removed = true;
							}
						}
					});

					if (removed && dispatch) dispatch(tr);
					return removed;
				},
		};
	},
});
