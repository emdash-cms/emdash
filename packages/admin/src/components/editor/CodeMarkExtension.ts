/**
 * Inline code mark that can combine with other marks (e.g. link).
 *
 * TipTap's default Code mark sets `excludes: '_'`, which drops every other
 * mark on the same span. Portable Text allows decorator + annotation stacks,
 * so we ship our own mark with an empty excludes list.
 */

import { Mark, markInputRule, markPasteRule, mergeAttributes } from "@tiptap/core";

export interface CodeMarkOptions {
	HTMLAttributes: Record<string, unknown>;
}

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		code: {
			setCode: () => ReturnType;
			toggleCode: () => ReturnType;
			unsetCode: () => ReturnType;
		};
	}
}

const inputRegex = /(^|[^`])`([^`]+)`(?!`)$/;
const pasteRegex = /(^|[^`])`([^`]+)`(?!`)/g;

export const CodeMarkExtension = Mark.create<CodeMarkOptions>({
	name: "code",

	addOptions() {
		return {
			HTMLAttributes: {},
		};
	},

	excludes: "",

	code: true,

	exitable: true,

	parseHTML() {
		return [{ tag: "code" }];
	},

	renderHTML({ HTMLAttributes }) {
		return ["code", mergeAttributes(this.options.HTMLAttributes, HTMLAttributes), 0];
	},

	addCommands() {
		return {
			setCode:
				() =>
				({ commands }) =>
					commands.setMark(this.name),
			toggleCode:
				() =>
				({ commands }) =>
					commands.toggleMark(this.name),
			unsetCode:
				() =>
				({ commands }) =>
					commands.unsetMark(this.name),
		};
	},

	addKeyboardShortcuts() {
		return {
			"Mod-e": () => this.editor.commands.toggleCode(),
		};
	},

	addInputRules() {
		return [
			markInputRule({
				find: inputRegex,
				type: this.type,
			}),
		];
	},

	addPasteRules() {
		return [
			markPasteRule({
				find: pasteRegex,
				type: this.type,
			}),
		];
	},
});
