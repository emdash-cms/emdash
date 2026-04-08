/**
 * Block Style Extension
 *
 * Extends TipTap's paragraph, heading, blockquote, listItem, codeBlock,
 * horizontalRule, and image nodes with a `cssClasses` attribute for applying
 * arbitrary CSS classes at the block level.
 *
 * In Portable Text, stored as a `cssClasses` property on the block object.
 *
 * Note: image styling is plumbed through the same mechanism but is surfaced
 * exclusively via the per-image detail panel (ImageDetailPanel) rather than
 * the document toolbar — see EditorStyleToolbar's image-only filter.
 */
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, type EditorState } from "@tiptap/pm/state";

declare module "@tiptap/core" {
	interface Commands<ReturnType> {
		blockStyle: {
			/**
			 * Set CSS classes on the styled block at the current selection.
			 * If `allowedTypes` is provided, only nodes whose type name is in
			 * that list are eligible.
			 */
			setBlockCssClasses: (classes: string, allowedTypes?: string[]) => ReturnType;
			/**
			 * Remove CSS classes from the styled block at the current selection.
			 */
			unsetBlockCssClasses: (allowedTypes?: string[]) => ReturnType;
			/**
			 * Toggle a CSS class string on the styled block at the current selection.
			 * If the block already has this exact class string, remove it.
			 * Otherwise, set it.
			 */
			toggleBlockCssClasses: (classes: string, allowedTypes?: string[]) => ReturnType;
		};
	}
}

export const STYLED_BLOCK_TYPES = [
	"paragraph",
	"heading",
	"blockquote",
	"listItem",
	"codeBlock",
	"horizontalRule",
	"image",
] as const;

const STYLED_BLOCK_TYPE_SET: ReadonlySet<string> = new Set(STYLED_BLOCK_TYPES);

/**
 * Resolve which node should receive `cssClasses` for the current selection.
 *
 * - If the selection is a NodeSelection, the selected node is the target
 *   (this is how horizontalRule and other atom blocks are styled).
 * - Otherwise, walk from the deepest ancestor outward looking for a match.
 *   Inside a list item, **prefer the listItem ancestor over the inner
 *   paragraph** when both are eligible (`listItem` is in `allowedTypes`,
 *   either explicitly or via the default set). This aligns the resolver
 *   with the PT↔PM converters: `convertListItem` (PM→PT) merges classes
 *   from both the listItem and its inner paragraph and stores them on the
 *   PT block, and the PT→PM converter restores them onto the listItem
 *   node — never the inner paragraph. If we targeted the inner paragraph
 *   here, classes would "jump" from `<p>` to `<li>` after a save/reload,
 *   confusing both the toolbar's active-state and any CSS rules scoped to
 *   the chosen element.
 * - Outside lists, return the innermost ancestor whose type is in
 *   `allowedTypes` (or the default styled-block set).
 *
 * Returns `null` if no suitable target exists.
 */
export function resolveStyledBlock(
	state: EditorState,
	allowedTypes?: readonly string[],
): { pos: number; node: PMNode } | null {
	const allowed: ReadonlySet<string> =
		allowedTypes && allowedTypes.length > 0 ? new Set(allowedTypes) : STYLED_BLOCK_TYPE_SET;

	const { selection } = state;

	if (selection instanceof NodeSelection) {
		if (allowed.has(selection.node.type.name)) {
			return { pos: selection.from, node: selection.node };
		}
		return null;
	}

	const { $from } = selection;
	const listItemAllowed = allowed.has("listItem");
	let listItemMatch: { pos: number; node: PMNode } | null = null;
	let innermostMatch: { pos: number; node: PMNode } | null = null;

	for (let depth = $from.depth; depth >= 0; depth--) {
		const node = $from.node(depth);
		// $from.before(depth) is the position immediately before the node
		// at this depth. depth=0 is the doc, which has no "before" — guard it.
		const pos = depth === 0 ? 0 : $from.before(depth);

		if (!innermostMatch && allowed.has(node.type.name)) {
			innermostMatch = { pos, node };
		}
		if (!listItemMatch && listItemAllowed && node.type.name === "listItem") {
			listItemMatch = { pos, node };
		}
		// Early exit once we have both candidates.
		if (innermostMatch && (listItemMatch || !listItemAllowed)) break;
	}

	// Prefer the listItem when one exists in the chain — keeps the
	// editor target consistent with where the converters persist classes.
	return listItemMatch ?? innermostMatch;
}

export const BlockStyleExtension = Extension.create({
	name: "blockStyle",

	addGlobalAttributes() {
		return [
			{
				types: [...STYLED_BLOCK_TYPES],
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
				(classes: string, allowedTypes?: string[]) =>
				({ state, tr, dispatch }) => {
					const target = resolveStyledBlock(state, allowedTypes);
					if (!target) return false;
					if (dispatch) {
						tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, cssClasses: classes });
						dispatch(tr);
					}
					return true;
				},
			unsetBlockCssClasses:
				(allowedTypes?: string[]) =>
				({ state, tr, dispatch }) => {
					const target = resolveStyledBlock(state, allowedTypes);
					if (!target) return false;
					if (dispatch) {
						tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, cssClasses: null });
						dispatch(tr);
					}
					return true;
				},
			toggleBlockCssClasses:
				(classes: string, allowedTypes?: string[]) =>
				({ state, tr, dispatch }) => {
					const target = resolveStyledBlock(state, allowedTypes);
					if (!target) return false;
					const current = target.node.attrs.cssClasses;
					const next = current === classes ? null : classes;
					if (dispatch) {
						tr.setNodeMarkup(target.pos, undefined, { ...target.node.attrs, cssClasses: next });
						dispatch(tr);
					}
					return true;
				},
		};
	},
});
