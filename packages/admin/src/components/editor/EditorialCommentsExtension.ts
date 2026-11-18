import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
	NodeSelection,
	Plugin,
	PluginKey,
	type EditorState,
	type Transaction,
} from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";

import {
	createTextAnchor,
	posToTextOffset,
	resolveAnchor,
	textOffsetToPos,
	type EditorialAnchor,
	type EditorialTextAnchor,
} from "../../editorial-anchors.js";
import { ownsPortableTextKey } from "../../portable-text/keys.js";
import { PORTABLE_TEXT_KEY_ATTR } from "./portableTextIdentity.js";

/** A thread's place in the open document. Block highlights span the whole node. */
export interface EditorialHighlight {
	threadId: string;
	kind: "text" | "block";
	from: number;
	to: number;
	/** Shown in a badge at the end of a text highlight while it is hovered or active. */
	badge?: string;
}

/** Where a comment being written will sit, highlighted until it is saved or cancelled. */
export type EditorialRange = Pick<EditorialHighlight, "kind" | "from" | "to">;

interface PluginState {
	highlights: EditorialHighlight[];
	pending: EditorialRange | null;
	activeThreadId: string | null;
	hoveredThreadId: string | null;
	decorations: DecorationSet;
}

type Meta = Partial<
	Pick<PluginState, "highlights" | "pending" | "activeThreadId" | "hoveredThreadId">
>;

/**
 * Callbacks from the editor to whoever renders the comments. Read on every
 * event, so the owner may replace them between renders.
 */
export interface EditorialCommentsBridge {
	/** The caret landed in a thread's highlight. */
	onActivate?: (threadId: string) => void;
	/** A click landed outside every highlight. */
	onDeactivate?: () => void;
	/** The user asked to comment on the selection with the keyboard shortcut. */
	onCommentShortcut?: () => void;
}

export const editorialCommentsKey = new PluginKey<PluginState>("emdashEditorialComments");

function buildDecorations(doc: PMNode, state: Omit<PluginState, "decorations">): DecorationSet {
	const decorations: Decoration[] = [];
	for (const highlight of state.highlights) {
		const active = highlight.threadId === state.activeThreadId;
		const hovered = highlight.threadId === state.hoveredThreadId;
		const classes = [`emdash-editorial-${highlight.kind}`];
		if (active) classes.push("emdash-editorial-active");
		if (hovered) classes.push("emdash-editorial-hover");
		const attrs = { class: classes.join(" "), "data-editorial-thread": highlight.threadId };
		if (highlight.kind === "block") {
			decorations.push(Decoration.node(highlight.from, highlight.to, attrs));
			continue;
		}
		decorations.push(Decoration.inline(highlight.from, highlight.to, attrs));
		const { badge } = highlight;
		if (badge && (active || hovered)) {
			decorations.push(
				Decoration.widget(highlight.to, () => createBadge(badge), {
					side: -1,
					key: `editorial-badge:${highlight.threadId}:${badge}`,
					ignoreSelection: true,
				}),
			);
		}
	}
	const { pending } = state;
	if (pending) {
		const attrs = { class: `emdash-editorial-${pending.kind} emdash-editorial-active` };
		decorations.push(
			pending.kind === "block"
				? Decoration.node(pending.from, pending.to, attrs)
				: Decoration.inline(pending.from, pending.to, attrs),
		);
	}
	return DecorationSet.create(doc, decorations);
}

/** A zero-width anchor, so the badge floats above the end of the text without moving it. */
function createBadge(label: string): HTMLElement {
	const anchor = document.createElement("span");
	anchor.className = "emdash-editorial-badge";
	anchor.setAttribute("aria-hidden", "true");
	const badge = document.createElement("span");
	badge.textContent = label;
	anchor.append(badge);
	return anchor;
}

function threadIdAt(view: EditorView, target: EventTarget | null): string | null {
	if (!(target instanceof Element)) return null;
	const highlight = target.closest("[data-editorial-thread]");
	if (!highlight || !view.dom.contains(highlight)) return null;
	return highlight.getAttribute("data-editorial-thread");
}

function setHoveredThread(view: EditorView, threadId: string | null): void {
	if (editorialCommentsKey.getState(view.state)?.hoveredThreadId === threadId) return;
	setEditorialHighlights(view.state, view.dispatch, { hoveredThreadId: threadId });
}

function mapRange<T extends EditorialRange>(tr: Transaction, range: T): T | null {
	const from = tr.mapping.mapResult(range.from, range.kind === "text" ? 1 : -1);
	const to = tr.mapping.mapResult(range.to, -1);
	if (from.deleted && to.deleted) return null;
	if (from.pos >= to.pos) return null;
	if (range.kind === "block" && tr.doc.nodeAt(from.pos)?.nodeSize !== to.pos - from.pos)
		return null;
	return { ...range, from: from.pos, to: to.pos };
}

function mapHighlights(tr: Transaction, highlights: EditorialHighlight[]): EditorialHighlight[] {
	return highlights.flatMap((highlight) => mapRange(tr, highlight) ?? []);
}

/**
 * The highlight under `pos`, preferring the shortest, so nested text wins over
 * its block. A click at either edge of a text highlight only places the caret
 * beside it, while a click on a block reports the position before it.
 */
function highlightAt(highlights: EditorialHighlight[], pos: number): EditorialHighlight | null {
	let best: EditorialHighlight | null = null;
	for (const highlight of highlights) {
		const inside =
			highlight.kind === "block"
				? pos >= highlight.from && pos < highlight.to
				: pos > highlight.from && pos < highlight.to;
		if (!inside) continue;
		if (!best || highlight.to - highlight.from < best.to - best.from) best = highlight;
	}
	return best;
}

const MAC_PLATFORM = /Mac|iPhone|iPad|iPod/;

/** Mod-Alt-M, matched by key position, since Alt changes the typed character on a Mac. */
function isCommentShortcut(event: KeyboardEvent): boolean {
	const mod = MAC_PLATFORM.test(navigator.platform) ? event.metaKey : event.ctrlKey;
	return mod && event.altKey && !event.shiftKey && event.code === "KeyM";
}

export function createEditorialCommentsExtension(bridge: { current: EditorialCommentsBridge }) {
	return Extension.create({
		name: "emdashEditorialComments",

		addKeyboardShortcuts() {
			return {
				"Mod-Alt-m": () => {
					if (!bridge.current.onCommentShortcut) return false;
					bridge.current.onCommentShortcut();
					return true;
				},
			};
		},

		addProseMirrorPlugins() {
			return [
				new Plugin<PluginState>({
					key: editorialCommentsKey,
					state: {
						init: (_, state) => {
							const empty = {
								highlights: [],
								pending: null,
								activeThreadId: null,
								hoveredThreadId: null,
							};
							return { ...empty, decorations: buildDecorations(state.doc, empty) };
						},
						apply(tr, previous) {
							// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only this plugin sets its meta
							const meta = tr.getMeta(editorialCommentsKey) as Meta | undefined;
							if (!meta && !tr.docChanged) return previous;
							let pending = previous.pending;
							if (tr.docChanged && pending) pending = mapRange(tr, pending);
							const next = {
								highlights: meta?.highlights ?? mapHighlights(tr, previous.highlights),
								pending: meta && "pending" in meta ? (meta.pending ?? null) : pending,
								activeThreadId:
									meta && "activeThreadId" in meta
										? (meta.activeThreadId ?? null)
										: previous.activeThreadId,
								hoveredThreadId:
									meta && "hoveredThreadId" in meta
										? (meta.hoveredThreadId ?? null)
										: previous.hoveredThreadId,
							};
							return { ...next, decorations: buildDecorations(tr.doc, next) };
						},
					},
					props: {
						decorations: (state) => editorialCommentsKey.getState(state)?.decorations,
						handleDOMEvents: {
							// The keymap only runs while the editor is editable.
							keydown: (view, event) => {
								if (view.editable || !isCommentShortcut(event)) return false;
								if (!bridge.current.onCommentShortcut) return false;
								event.preventDefault();
								bridge.current.onCommentShortcut();
								return true;
							},
							mouseover: (view, event) => {
								setHoveredThread(view, threadIdAt(view, event.target));
								return false;
							},
							mouseleave: (view) => {
								setHoveredThread(view, null);
								return false;
							},
						},
						handleClick(view, pos, event) {
							const state = editorialCommentsKey.getState(view.state);
							const threadId =
								(state ? highlightAt(state.highlights, pos)?.threadId : null) ??
								threadIdAt(view, event.target);
							if (threadId) bridge.current.onActivate?.(threadId);
							else bridge.current.onDeactivate?.();
							return false;
						},
					},
				}),
			];
		},
	});
}

export function setEditorialHighlights(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	meta: Meta,
): void {
	dispatch(state.tr.setMeta(editorialCommentsKey, meta).setMeta("addToHistory", false));
}

export function getEditorialHighlights(state: EditorState): EditorialHighlight[] {
	return editorialCommentsKey.getState(state)?.highlights ?? [];
}

/** Where the comment being written sits now, mapped through any edits since it started. */
export function getEditorialPending(state: EditorState): EditorialRange | null {
	return editorialCommentsKey.getState(state)?.pending ?? null;
}

interface DocTextBlock {
	key: string;
	/** The block has no Portable Text key yet, so `key` is a stand-in that is never stored. */
	unkeyed: boolean;
	node: PMNode;
	pos: number;
}

/**
 * Whether a node is saved as a Portable Text text block: a top-level paragraph
 * or heading, or a list item's or quote's paragraph. Code blocks and table
 * cells are saved differently, so text anchors never point into them.
 */
function isPortableTextTextblock(node: PMNode, parent: PMNode | null): boolean {
	return node.isTextblock && node.type.name !== "codeBlock" && ownsPortableTextKey(node, parent);
}

/**
 * Every Portable Text text block in document order. Content saved without
 * block keys still gets stand-in keys, so threads on it can be found by their quote.
 */
function documentTextblocks(doc: PMNode): DocTextBlock[] {
	const blocks: DocTextBlock[] = [];
	doc.descendants((node, pos, parent) => {
		if (!node.isTextblock) return true;
		if (!isPortableTextTextblock(node, parent)) return false;
		const key: unknown = node.attrs[PORTABLE_TEXT_KEY_ATTR];
		if (typeof key === "string" && key) blocks.push({ key, unkeyed: false, node, pos });
		else blocks.push({ key: `\u0000${pos}`, unkeyed: true, node, pos });
		return false;
	});
	return blocks;
}

function textOf(node: PMNode): string {
	let text = "";
	node.forEach((child) => {
		if (child.isText) text += child.text ?? "";
		else if (child.type.name === "hardBreak") text += "\n";
	});
	return text;
}

/**
 * The document's keyed textblocks as Portable Text blocks, with the same text
 * the saved value would have, so anchors resolve against unsaved edits too.
 */
function portableTextView(blocks: DocTextBlock[]) {
	return blocks.map((block) => ({
		_type: "block",
		_key: block.key,
		children: [{ _type: "span", text: textOf(block.node) }],
	}));
}

/** Where an anchor sits in the document, or `null` when it can't be found. */
export function locateAnchor(
	doc: PMNode,
	anchor: EditorialAnchor,
): { kind: "text" | "block"; from: number; to: number } | null {
	if (anchor.type === "block") {
		let found: { kind: "block"; from: number; to: number } | null = null;
		doc.descendants((node, pos) => {
			if (found) return false;
			if (node.attrs[PORTABLE_TEXT_KEY_ATTR] === anchor.blockKey) {
				found = { kind: "block", from: pos, to: pos + node.nodeSize };
				return false;
			}
			return true;
		});
		return found;
	}
	if (anchor.type !== "text") return null;
	const blocks = documentTextblocks(doc);
	const resolved = resolveAnchor(portableTextView(blocks), anchor);
	if (resolved.state !== "attached" || resolved.anchor.type !== "text") return null;
	const { blockKey, start, end } = resolved.anchor;
	const block = blocks.find((candidate) => candidate.key === blockKey);
	if (!block) return null;
	const contentStart = block.pos + 1;
	return {
		kind: "text",
		from: textOffsetToPos(block.node, contentStart, start, 1),
		to: textOffsetToPos(block.node, contentStart, end),
	};
}

/** The text anchor a highlight's current range describes, or `null` if it spans blocks. */
export function anchorForRange(
	doc: PMNode,
	field: string,
	from: number,
	to: number,
): EditorialTextAnchor | null {
	const blocks = documentTextblocks(doc);
	const block = blocks.find(
		(candidate) => from > candidate.pos && to < candidate.pos + candidate.node.nodeSize,
	);
	if (!block || block.unkeyed) return null;
	const contentStart = block.pos + 1;
	return createTextAnchor(
		portableTextView(blocks),
		field,
		block.key,
		posToTextOffset(block.node, contentStart, from),
		posToTextOffset(block.node, contentStart, to),
	);
}

export type SelectionAnchorResult =
	| { ok: true; anchor: EditorialAnchor; range: EditorialRange }
	| { ok: false; reason: "empty" | "multiple-blocks" | "too-long" | "unkeyed" | "unsupported" };

/** Whether a node is a top-level block other than a paragraph or heading, such as an image. */
export function isCommentableBlock(node: PMNode, parent: PMNode | null): boolean {
	if (node.isTextblock && node.type.name !== "codeBlock") return false;
	return ownsPortableTextKey(node, parent);
}

/**
 * An anchor for the current selection: a text anchor for text within one
 * block, or a block anchor for a selected block such as an image. A block
 * without a Portable Text key yet gets one, so the anchor and the next save
 * agree on it, unless `assignKey` is false, as in a read-only editor.
 */
export function anchorForSelection(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	field: string,
	generateKey: () => string,
	assignKey = true,
): SelectionAnchorResult {
	const { selection } = state;
	const { from, to, $from, $to } = selection;
	if (selection instanceof NodeSelection && isCommentableBlock(selection.node, $from.parent)) {
		const keyed = ensureKey(state, dispatch, from, generateKey, assignKey);
		if (!keyed) return { ok: false, reason: "unkeyed" };
		return {
			ok: true,
			anchor: { type: "block", field, blockKey: keyed.key },
			range: { kind: "block", from, to },
		};
	}
	if (from === to) return { ok: false, reason: "empty" };
	if (!$from.sameParent($to) || !$from.parent.isTextblock) {
		return { ok: false, reason: "multiple-blocks" };
	}
	if (!isPortableTextTextblock($from.parent, $from.node($from.depth - 1))) {
		// Text in a code block takes a comment on the whole block.
		const blockPos = $from.before();
		if (isCommentableBlock($from.parent, $from.node($from.depth - 1))) {
			const keyed = ensureKey(state, dispatch, blockPos, generateKey, assignKey);
			if (!keyed) return { ok: false, reason: "unkeyed" };
			return {
				ok: true,
				anchor: { type: "block", field, blockKey: keyed.key },
				range: { kind: "block", from: blockPos, to: blockPos + $from.parent.nodeSize },
			};
		}
		return { ok: false, reason: "unsupported" };
	}
	const keyed = ensureKey(state, dispatch, $from.before(), generateKey, assignKey);
	if (!keyed) return { ok: false, reason: "unkeyed" };
	const anchor = anchorForRange(keyed.doc, field, from, to);
	if (!anchor) return { ok: false, reason: "too-long" };
	return { ok: true, anchor, range: { kind: "text", from, to } };
}

/** The key of the block at `pos`, giving it one outside the undo history if it has none. */
function ensureKey(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	pos: number,
	generateKey: () => string,
	assignKey: boolean,
): { key: string; doc: PMNode } | null {
	const existing: unknown = state.doc.nodeAt(pos)?.attrs[PORTABLE_TEXT_KEY_ATTR];
	if (typeof existing === "string" && existing) return { key: existing, doc: state.doc };
	if (!assignKey) return null;
	const key = generateKey();
	const tr = state.tr
		.setNodeAttribute(pos, PORTABLE_TEXT_KEY_ATTR, key)
		.setMeta("addToHistory", false);
	dispatch(tr);
	return { key, doc: tr.doc };
}
