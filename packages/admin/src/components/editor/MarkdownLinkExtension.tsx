/**
 * Markdown Link Extension for TipTap
 *
 * Converts markdown link syntax into proper link marks:
 * - Typing `[text](url)` converts on closing paren
 * - Pasting text containing `[text](url)` converts inline
 * - Rejects disallowed protocols (e.g. `javascript:`) via Link's allowlist
 *
 * Augments the existing Link mark from StarterKit — no new marks added.
 */

import { Extension, InputRule, PasteRule } from "@tiptap/core";
import { isAllowedUri } from "@tiptap/extension-link";
import type { EditorState } from "@tiptap/pm/state";

// Matches [link text](https://url.com) — typed (input rule, end-anchored)
// match[1] = link text, match[2] = href
const MARKDOWN_LINK_INPUT_REGEX = /\[([^\]]+)\]\(([^)]+)\)$/;

// Matches [link text](https://url.com) — pasted (paste rule, global)
// match[1] = link text, match[2] = href
const MARKDOWN_LINK_PASTE_REGEX = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Shared handler context — InputRule and PasteRule use the same shape. */
interface RuleMatch {
	state: EditorState;
	range: { from: number; to: number };
	match: RegExpMatchArray;
}

/**
 * Replace a `[text](url)` match with `text` carrying the link mark.
 * Returns null (no-op) if the URL fails the protocol allowlist.
 *
 * Shared by both the input rule and paste rule — the handler signature
 * for InputRule and PasteRule is identical.
 */
function handleMarkdownLink({ state, range, match }: RuleMatch): null | void {
	const linkType = state.schema.marks["link"];
	const linkText = match[1];
	const href = match[2]?.trim();

	if (!linkType || !linkText || !href || !isAllowedUri(href)) return null;

	const { tr } = state;
	const mark = linkType.create({ href });

	tr.replaceWith(range.from, range.to, state.schema.text(linkText, [mark]));
	tr.removeStoredMark(linkType);
}

/**
 * Adds markdown link syntax support to the TipTap editor.
 *
 * Typing `[text](url)` and completing the closing `)` converts the syntax
 * into a proper link mark. Pasting text containing `[text](url)` patterns
 * also converts them. URLs that fail the protocol allowlist (e.g. `javascript:`)
 * are silently ignored, leaving the markdown syntax as literal text.
 *
 * Uses raw InputRule/PasteRule rather than the markInputRule/markPasteRule
 * helpers because those helpers unconditionally use the last capture group as
 * the replacement text — we need group 1 (text) as content and group 2 (href)
 * as the attribute, so we write the transaction by hand.
 *
 * This augments the Link mark already provided by StarterKit — no new
 * dependencies required.
 */
export const MarkdownLinkExtension = Extension.create({
	name: "markdownLink",

	addInputRules() {
		return [
			new InputRule({
				find: MARKDOWN_LINK_INPUT_REGEX,
				handler: handleMarkdownLink,
			}),
		];
	},

	addPasteRules() {
		return [
			new PasteRule({
				find: MARKDOWN_LINK_PASTE_REGEX,
				handler: handleMarkdownLink,
			}),
		];
	},
});
