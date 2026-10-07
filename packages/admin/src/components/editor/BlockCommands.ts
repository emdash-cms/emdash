/**
 * Block-level commands for the block menu, which moves the current
 * top-level block(s) up or down or duplicates them, and keyboard selection
 * of whole blocks, the way the block handle selects them.
 */

import { Extension, type Editor } from "@tiptap/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import {
	AllSelection,
	NodeSelection,
	Plugin,
	PluginKey,
	Selection,
	TextSelection,
	type EditorState,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { SuggestionPluginKey } from "@tiptap/suggestion";

export interface BlockRange {
	from: number;
	to: number;
}

/** The top-level blocks the selection touches, or `null` for a whole-document selection. */
export function selectedBlockRange(state: EditorState): BlockRange | null {
	const { selection, doc } = state;
	if (selection instanceof NodeSelection && selection.$from.depth === 0) {
		return { from: selection.from, to: selection.to };
	}
	const { $from, $to } = selection;
	if ($from.depth === 0 || $to.depth === 0) {
		if (selection.from === 0 && selection.to === doc.content.size) return null;
		const node = doc.nodeAt(selection.from);
		return node ? { from: selection.from, to: selection.from + node.nodeSize } : null;
	}
	return { from: $from.before(1), to: $to.after(1) };
}

/**
 * Swaps the range with its neighbouring block. The neighbour moves rather
 * than the range, so node views inside the range keep their state and the
 * selection maps along with it.
 */
export function moveBlocks(
	editor: Editor,
	direction: "up" | "down",
	range = selectedBlockRange(editor.state),
): boolean {
	if (!range || !editor.isEditable) return false;
	const { state } = editor;
	const { doc } = state;
	if (direction === "up") {
		const $from = doc.resolve(range.from);
		const index = $from.index(0);
		if (index === 0) return false;
		const previous = doc.child(index - 1);
		const previousStart = range.from - previous.nodeSize;
		const tr = state.tr
			.delete(previousStart, range.from)
			.insert(range.to - previous.nodeSize, previous)
			.scrollIntoView();
		editor.view.dispatch(tr);
		return true;
	}
	const $to = doc.resolve(range.to);
	const index = $to.index(0);
	if (index >= doc.childCount) return false;
	const next = doc.child(index);
	const tr = state.tr
		.delete(range.to, range.to + next.nodeSize)
		.insert(range.from, next)
		.scrollIntoView();
	editor.view.dispatch(tr);
	return true;
}

/**
 * Where a new block goes instead of the selection: after a block selected
 * whole, which it would otherwise replace, after a block holding text, which
 * it would otherwise split, or after the list or quote holding the caret,
 * which can only hold text. `null` means it replaces the empty line at the
 * caret.
 */
export function blockInsertPosition(selection: Selection): number | null {
	if (selection instanceof NodeSelection && selection.$from.depth === 0) return selection.to;
	const { $from } = selection;
	if ($from.depth === 0) return null;
	for (let depth = $from.depth; depth > 0; depth--) {
		const { name } = $from.node(depth).type;
		if (name === "listItem" || name === "blockquote") return $from.after(1);
	}
	return $from.parent.content.size > 0 ? $from.after(1) : null;
}

export function duplicateBlocks(editor: Editor, range = selectedBlockRange(editor.state)): boolean {
	if (!range || !editor.isEditable) return false;
	const { state } = editor;
	const slice = state.doc.slice(range.from, range.to);
	editor.view.dispatch(state.tr.insert(range.to, slice.content).scrollIntoView());
	return true;
}

/**
 * Tracks whether a whole block was selected from the block handle or the
 * keyboard. While it is, the arrow keys move between blocks. A click that
 * selects an image doesn't count, so the arrow keys still leave the image
 * as usual.
 */
const blockSelectionKey = new PluginKey<boolean>("emdashBlockSelection");
/** Which side of a selected block the caret was on, when a key press selected it from beside it. */
const selectedFromKey = new PluginKey<-1 | 1 | null>("emdashSelectedFrom");

/** The key code browsers report for key presses an IME is handling. */
const IME_KEY_CODE = 229;
const TEXT_INPUT_TYPES = new Set(["insertText", "insertReplacementText"]);

function topLevelNodeSelection(state: EditorState): NodeSelection | null {
	const { selection } = state;
	return selection instanceof NodeSelection && selection.$from.depth === 0 ? selection : null;
}

function isBlockSelectionActive(state: EditorState): boolean {
	return blockSelectionKey.getState(state) === true;
}

/**
 * Typing, dictation, and paste can't replace a block selected whole, such as
 * an image, a divider, or a table selected with Backspace.
 */
function isSelectedBlockProtected(state: EditorState): boolean {
	return topLevelNodeSelection(state) !== null;
}

/** Treats an existing whole-block selection, like the block handle's, as keyboard block selection. */
export function enterBlockSelection(editor: Editor): boolean {
	return editor.commands.setMeta(blockSelectionKey, true);
}

/**
 * Puts the caret at the start of the document. When the document opens with
 * an image or divider, the caret goes above it rather than selecting it, so
 * the next key can't replace it.
 */
export function focusDocumentStart(editor: Editor): void {
	const { state, view } = editor;
	const first = Selection.atStart(state.doc);
	const selection = first instanceof NodeSelection ? new GapCursor(state.doc.resolve(0)) : first;
	view.dispatch(state.tr.setSelection(selection).scrollIntoView());
	view.focus();
}

/** Selects the top-level block at `pos` as a whole. */
function selectBlock(editor: Editor, pos: number): boolean {
	const { state } = editor;
	const node = state.doc.nodeAt(pos);
	if (!node || !NodeSelection.isSelectable(node)) return false;
	editor.view.dispatch(
		state.tr
			.setSelection(NodeSelection.create(state.doc, pos))
			.setMeta(blockSelectionKey, true)
			.scrollIntoView(),
	);
	return true;
}

/** Selects the block around the caret, or does nothing if the selection spans several blocks. */
function selectCurrentBlock(editor: Editor): boolean {
	const { state } = editor;
	const { selection } = state;
	if (selection instanceof AllSelection) return false;
	if (topLevelNodeSelection(state)) {
		return !isBlockSelectionActive(state) && enterBlockSelection(editor);
	}
	const { $from, $to } = selection;
	if ($from.depth === 0 || $to.depth === 0 || $from.before(1) !== $to.before(1)) return false;
	return selectBlock(editor, $from.before(1));
}

function selectNeighbourBlock(editor: Editor, direction: -1 | 1): boolean {
	const { state } = editor;
	const selection = topLevelNodeSelection(state);
	if (!selection) return false;
	const { doc } = state;
	const index = selection.$from.index(0) + direction;
	if (index < 0 || index >= doc.childCount) return true;
	let pos = 0;
	for (let i = 0; i < index; i++) pos += doc.child(i).nodeSize;
	selectBlock(editor, pos);
	return true;
}

/** Puts the caret in a new empty paragraph after the selected block. */
function moveAfterSelectedBlock(view: EditorView): void {
	const { tr } = view.state;
	const position = blockInsertPosition(tr.selection);
	if (position === null) return;
	tr.insert(position, tr.doc.type.schema.nodes.paragraph!.create());
	tr.setSelection(TextSelection.create(tr.doc, position + 1));
	view.dispatch(tr.scrollIntoView());
}

/**
 * Deleting a selected block leaves the caret in the text beside it, so the
 * next press doesn't select the following block and delete that too. The
 * caret goes back where it was when Backspace or Delete selected the block,
 * and otherwise to the side the key deletes towards. Between two images or
 * dividers, it's a gap cursor where the block was.
 */
function deleteSelectedBlock(view: EditorView, direction: -1 | 1): boolean {
	const selection = topLevelNodeSelection(view.state);
	if (!selection) return false;
	const side = selectedFromKey.getState(view.state) ?? direction;
	const tr = view.state.tr.deleteSelection();
	const $gap = tr.doc.resolve(tr.mapping.map(selection.from));
	const textOn = (towards: -1 | 1) => {
		const node = towards > 0 ? $gap.nodeAfter : $gap.nodeBefore;
		return node && !node.isAtom ? Selection.findFrom($gap, towards, true) : null;
	};
	const opposite: -1 | 1 = side < 0 ? 1 : -1;
	tr.setSelection(textOn(side) ?? textOn(opposite) ?? new GapCursor($gap));
	view.dispatch(tr.scrollIntoView());
	return true;
}

/**
 * Backspace at the start of a block after an image, divider, or embed, or
 * Delete at the end of a block before one, selects it rather than deleting
 * it unseen. An empty block is deleted as usual, which selects its neighbour.
 */
function selectAtomBeside(view: EditorView, direction: -1 | 1): boolean {
	const { selection, doc } = view.state;
	if (!(selection instanceof TextSelection) || !selection.empty) return false;
	const { $from } = selection;
	const size = $from.parent.content.size;
	if ($from.depth !== 1 || size === 0) return false;
	if ($from.parentOffset !== (direction < 0 ? 0 : size)) return false;
	const $edge = doc.resolve(direction < 0 ? $from.before() : $from.after());
	const atom = direction < 0 ? $edge.nodeBefore : $edge.nodeAfter;
	if (!atom?.isAtom || !NodeSelection.isSelectable(atom)) return false;
	const pos = direction < 0 ? $edge.pos - atom.nodeSize : $edge.pos;
	view.dispatch(view.state.tr.setSelection(NodeSelection.create(doc, pos)).scrollIntoView());
	return true;
}

/** Enter on a selected block goes back to writing at the end of it. */
function editSelectedBlock(editor: Editor): boolean {
	const { state } = editor;
	const selection = topLevelNodeSelection(state);
	if (!selection || selection.node.isAtom) return false;
	const end = TextSelection.findFrom(state.doc.resolve(selection.to), -1, true);
	if (!end || end.from < selection.from) return false;
	editor.view.dispatch(state.tr.setSelection(end).scrollIntoView());
	return true;
}

/**
 * Select All first selects just the text of the block holding the caret,
 * like Notion, so it can be copied or cleared on its own. Pressing it again
 * selects the whole document.
 */
function selectTextblockText(editor: Editor): boolean {
	const { state } = editor;
	const { selection } = state;
	if (!(selection instanceof TextSelection)) return false;
	const { $from, $to } = selection;
	if (!$from.sameParent($to) || !$from.parent.isTextblock) return false;
	const start = $from.start();
	const end = $from.end();
	if (start === end || (selection.from === start && selection.to === end)) return false;
	editor.view.dispatch(state.tr.setSelection(TextSelection.create(state.doc, start, end)));
	return true;
}

/** A menu or popover opened from the editor's controls takes Escape first. */
function hasOpenPopup(view: EditorView): boolean {
	const root = view.dom.closest("[data-emdash-editor-floating-root]");
	return root?.querySelector('[aria-expanded="true"]') != null;
}

function isAtDocumentStart(view: EditorView): boolean {
	const { selection, doc } = view.state;
	if (selection instanceof GapCursor) return selection.from === 0;
	if (!(selection instanceof TextSelection) || !selection.empty) return false;
	const first = Selection.atStart(doc);
	return first.$from.parent === selection.$from.parent && view.endOfTextblock("up");
}

function selectedBlockDecorations(doc: ProseMirrorNode): DecorationSet {
	const decorations: Decoration[] = [];
	doc.forEach((node, offset) => {
		decorations.push(
			Decoration.node(offset, offset + node.nodeSize, { class: "emdash-block-selected" }),
		);
	});
	return DecorationSet.create(doc, decorations);
}

export interface BlockSelectionOptions {
	/** Called when ArrowUp leaves the first line of the document. Return `true` if it moved focus. */
	onArrowUpAtStart: (() => boolean) | null;
}

export const BlockSelection = Extension.create<BlockSelectionOptions>({
	name: "emdashBlockSelection",
	// Ahead of TipTap's Enter, which would add a paragraph beside a selected block.
	priority: 1000,

	addOptions() {
		return { onArrowUpAtStart: null };
	},

	addProseMirrorPlugins() {
		const { editor, options } = this;
		// Whether a key press is being handled, so a block it selects records the caret's side.
		let pressingKey = false;
		return [
			new Plugin<-1 | 1 | null>({
				key: selectedFromKey,
				state: {
					init: () => null,
					apply: (tr, side, oldState, newState) => {
						if (tr.docChanged) return null;
						if (!tr.selectionSet) return side;
						const block = topLevelNodeSelection(newState);
						const { $from, empty } = oldState.selection;
						if (!pressingKey || !block || !empty || $from.depth === 0) return null;
						if ($from.before(1) === block.to) return 1;
						return $from.after(1) === block.from ? -1 : null;
					},
				},
			}),
			new Plugin<boolean>({
				key: blockSelectionKey,
				state: {
					init: () => false,
					apply: (tr, active, _oldState, newState) => {
						if (!topLevelNodeSelection(newState)) return false;
						const meta: unknown = tr.getMeta(blockSelectionKey);
						if (typeof meta === "boolean") return meta;
						return tr.selectionSet ? false : active;
					},
				},
				props: {
					handleKeyDown: (view, event) => {
						pressingKey = true;
						queueMicrotask(() => {
							pressingKey = false;
						});
						if (event.defaultPrevented || !editor.isEditable) return false;
						const blockMode = isBlockSelectionActive(view.state);
						if (event.isComposing || event.keyCode === IME_KEY_CODE) {
							// An IME can't be stopped, so it writes at the end of the block, or after it, instead.
							if (isSelectedBlockProtected(view.state) && !editSelectedBlock(editor)) {
								moveAfterSelectedBlock(view);
							}
							return false;
						}
						if (SuggestionPluginKey.getState(view.state)?.active) return false;
						if (event.key === "Backspace" || event.key === "Delete") {
							const direction = event.key === "Backspace" ? -1 : 1;
							return deleteSelectedBlock(view, direction) || selectAtomBeside(view, direction);
						}
						const plain = !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
						if (!plain) return false;
						switch (event.key) {
							case "Escape":
								return !hasOpenPopup(view) && selectCurrentBlock(editor);
							case "ArrowUp":
								if (blockMode) return selectNeighbourBlock(editor, -1);
								return isAtDocumentStart(view) && (options.onArrowUpAtStart?.() ?? false);
							case "ArrowDown":
								return blockMode && selectNeighbourBlock(editor, 1);
							case "Enter":
								return blockMode && editSelectedBlock(editor);
							default:
								return false;
						}
					},
					handleTextInput: (view) => isSelectedBlockProtected(view.state),
					// The pasted content goes after the selected block instead.
					handlePaste: (view) => {
						if (isSelectedBlockProtected(view.state)) moveAfterSelectedBlock(view);
						return false;
					},
					handleDOMEvents: {
						// As in Notion, a click where there's no line for the caret, such as
						// between two embeds, leaves the caret where it was instead of putting
						// a gap cursor there.
						mousedown: (view, event) => {
							if (event.button !== 0 || event.shiftKey || event.target !== view.dom) return false;
							const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
							if (!pos || pos.inside > -1) return false;
							const $pos = view.state.doc.resolve(pos.pos);
							const selection = view.someProp("createSelectionBetween", (create) =>
								create(view, $pos, $pos),
							);
							if (!(selection instanceof GapCursor)) return false;
							event.preventDefault();
							return true;
						},
						// Dictation, emoji pickers, and autocorrect insert text without a key press.
						beforeinput: (view, event) => {
							if (!isSelectedBlockProtected(view.state) || !TEXT_INPUT_TYPES.has(event.inputType)) {
								return false;
							}
							event.preventDefault();
							return true;
						},
					},
					decorations: (state) =>
						state.selection instanceof AllSelection ? selectedBlockDecorations(state.doc) : null,
					attributes: (state): Record<string, string> =>
						state.selection instanceof AllSelection ? { "data-emdash-block-selection": "all" } : {},
				},
			}),
		];
	},
});

/**
 * Select All scoped to the block holding the caret. Runs ahead of TipTap's
 * own Select All, which takes over on the second press.
 */
export const BlockSelectAll = Extension.create({
	name: "emdashBlockSelectAll",
	priority: 1000,

	addKeyboardShortcuts() {
		return {
			"Mod-a": () => selectTextblockText(this.editor),
		};
	},
});

/** Whether a text selection holds nothing visible: only line breaks, spaces, or dividers. */
function isLineBreakSelection(selection: Selection, doc: ProseMirrorNode): boolean {
	if (!(selection instanceof TextSelection) || selection.empty) return false;
	const text = doc.textBetween(selection.from, selection.to, "\n", "\n");
	return text.includes("\n") && !text.trim();
}

const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

/** Where the word ending at `pos` starts, if the double click landed on its last letter. */
function clickedWordStart(view: EditorView, pos: number, event: MouseEvent): number | null {
	const $pos = view.state.doc.resolve(pos);
	if (!$pos.nodeBefore?.isText) return null;
	const end = view.coordsAtPos(pos, -1);
	const start = view.coordsAtPos(pos - 1, 1);
	const onLastLetter =
		event.clientY >= end.top &&
		event.clientY <= end.bottom &&
		event.clientX >= Math.min(start.left, end.left) &&
		event.clientX <= Math.max(start.left, end.left);
	if (!onLastLetter) return null;
	const before = $pos.parent.textBetween(0, $pos.parentOffset, undefined, "\ufffc");
	const word = [...wordSegmenter.segment(before)].at(-1)?.segment;
	return word?.trim() ? pos - word.length : null;
}

/** Set from a double click's second press until DoubleClickLineEnd settles its selection. */
const doubleClickKey = new PluginKey<boolean>("emdashDoubleClick");

/**
 * Double-clicking the right half of a line's last letter, or past the end of
 * the line, selects only the line break after it. That looks like a caret,
 * but the next keystroke would join the line to the next one. A click on the
 * letter selects its word instead, and a click past the end leaves a caret.
 */
export const DoubleClickLineEnd = Extension.create({
	name: "emdashDoubleClickLineEnd",

	addProseMirrorPlugins() {
		return [
			new Plugin<boolean>({
				key: doubleClickKey,
				state: {
					init: () => false,
					apply: (tr, pending) => {
						const meta: unknown = tr.getMeta(doubleClickKey);
						return typeof meta === "boolean" ? meta : pending;
					},
				},
				props: {
					handleDOMEvents: {
						mousedown: (view, event) => {
							const pending = event.detail === 2;
							if (pending !== doubleClickKey.getState(view.state)) {
								view.dispatch(view.state.tr.setMeta(doubleClickKey, pending));
							}
							return false;
						},
						dblclick: (view, event) => {
							// The browser's word selection reaches the editor state after this event.
							setTimeout(() => {
								if (view.isDestroyed) return;
								const { selection, doc } = view.state;
								const { $from } = selection;
								const tr = view.state.tr.setMeta(doubleClickKey, false);
								// At the end of a block, Chrome can also leave just a caret there.
								const caretAtEnd =
									selection.empty && $from.parentOffset === $from.parent.content.size;
								if (isLineBreakSelection(selection, doc) || caretAtEnd) {
									const wordStart = clickedWordStart(view, selection.from, event);
									if (wordStart !== null) {
										tr.setSelection(TextSelection.create(doc, wordStart, selection.from));
									} else if (!caretAtEnd) {
										// The caret goes on the line that was clicked, which can be the one after a line break.
										const onLaterLine = event.clientY >= view.coordsAtPos(selection.to).top;
										tr.setSelection(
											TextSelection.create(doc, onLaterLine ? selection.to : selection.from),
										);
									}
								}
								view.dispatch(tr);
							});
							return false;
						},
					},
				},
			}),
		];
	},
});

function lineBreakMarker(): HTMLElement {
	const marker = document.createElement("span");
	marker.className = "emdash-selected-line-break";
	return marker;
}

/**
 * Browsers draw nothing for a selected line break, or for a divider inside a
 * selection, though the next keystroke deletes them. A selection that holds
 * only line breaks marks each selected line end, and a divider inside any
 * selection is tinted like selected text.
 */
export const SelectionHighlights = Extension.create({
	name: "emdashSelectionHighlights",

	addProseMirrorPlugins() {
		return [
			new Plugin({
				props: {
					decorations: (state) => {
						const { selection, doc } = state;
						if (!(selection instanceof TextSelection) || selection.empty) return null;
						// A double click past a line end selects its break until DoubleClickLineEnd collapses it.
						const markLineEnds =
							doubleClickKey.getState(state) !== true && isLineBreakSelection(selection, doc);
						const decorations: Decoration[] = [];
						doc.nodesBetween(selection.from, selection.to, (node, pos) => {
							const end = pos + node.nodeSize - 1;
							if (node.type.name === "horizontalRule") {
								decorations.push(
									Decoration.node(pos, pos + node.nodeSize, { class: "emdash-in-selection" }),
								);
							} else if (markLineEnds && node.isTextblock && end < selection.to) {
								decorations.push(Decoration.widget(end, lineBreakMarker, { side: -1 }));
							}
							return !node.isTextblock;
						});
						return decorations.length > 0 ? DecorationSet.create(doc, decorations) : null;
					},
				},
			}),
		];
	},
});
