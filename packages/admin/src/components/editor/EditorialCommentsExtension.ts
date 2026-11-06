import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import {
	createTextAnchor,
	posToTextOffset,
	resolveAnchor,
	textOffsetToPos,
	type EditorialAnchor,
	type EditorialTextAnchor,
} from "../../editorial-anchors.js";
import { PORTABLE_TEXT_KEY_ATTR } from "./portableTextIdentity.js";

/** A thread's place in the open document. Block highlights span the whole node. */
export interface EditorialHighlight {
	threadId: string;
	kind: "text" | "block";
	from: number;
	to: number;
}

interface PluginState {
	highlights: EditorialHighlight[];
	pending: { from: number; to: number } | null;
	activeThreadId: string | null;
	decorations: DecorationSet;
}

type Meta = Partial<Pick<PluginState, "highlights" | "pending" | "activeThreadId">>;

/**
 * Callbacks from the editor to whoever renders the comments. Read on every
 * event, so the owner may replace them between renders.
 */
export interface EditorialCommentsBridge {
	/** The caret landed in a thread's highlight. */
	onActivate?: (threadId: string) => void;
	/** The user asked to comment on the selection with the keyboard shortcut. */
	onCommentShortcut?: () => void;
}

export const editorialCommentsKey = new PluginKey<PluginState>("emdashEditorialComments");

function buildDecorations(doc: PMNode, state: Omit<PluginState, "decorations">): DecorationSet {
	const decorations: Decoration[] = [];
	for (const highlight of state.highlights) {
		const active = highlight.threadId === state.activeThreadId;
		const attrs = {
			class: active
				? `emdash-editorial-${highlight.kind} emdash-editorial-active`
				: `emdash-editorial-${highlight.kind}`,
			"data-editorial-thread": highlight.threadId,
		};
		decorations.push(
			highlight.kind === "text"
				? Decoration.inline(highlight.from, highlight.to, attrs)
				: Decoration.node(highlight.from, highlight.to, attrs),
		);
	}
	if (state.pending) {
		decorations.push(
			Decoration.inline(state.pending.from, state.pending.to, {
				class: "emdash-editorial-text emdash-editorial-active",
			}),
		);
	}
	return DecorationSet.create(doc, decorations);
}

function mapHighlights(tr: Transaction, highlights: EditorialHighlight[]): EditorialHighlight[] {
	const mapped: EditorialHighlight[] = [];
	for (const highlight of highlights) {
		const from = tr.mapping.mapResult(highlight.from, highlight.kind === "text" ? 1 : -1);
		const to = tr.mapping.mapResult(highlight.to, -1);
		if (from.deleted && to.deleted) continue;
		if (from.pos >= to.pos) continue;
		mapped.push({ ...highlight, from: from.pos, to: to.pos });
	}
	return mapped;
}

/** The highlight under `pos`, preferring the shortest, so nested text wins over its block. */
function highlightAt(highlights: EditorialHighlight[], pos: number): EditorialHighlight | null {
	let best: EditorialHighlight | null = null;
	for (const highlight of highlights) {
		if (pos < highlight.from || pos > highlight.to) continue;
		if (!best || highlight.to - highlight.from < best.to - best.from) best = highlight;
	}
	return best;
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
							const empty = { highlights: [], pending: null, activeThreadId: null };
							return { ...empty, decorations: buildDecorations(state.doc, empty) };
						},
						apply(tr, previous) {
							// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- only this plugin sets its meta
							const meta = tr.getMeta(editorialCommentsKey) as Meta | undefined;
							if (!meta && !tr.docChanged) return previous;
							let pending = previous.pending;
							if (tr.docChanged && pending) {
								const from = tr.mapping.map(pending.from, 1);
								const to = tr.mapping.map(pending.to, -1);
								pending = from < to ? { from, to } : null;
							}
							const next = {
								highlights: meta?.highlights ?? mapHighlights(tr, previous.highlights),
								pending: meta && "pending" in meta ? (meta.pending ?? null) : pending,
								activeThreadId:
									meta && "activeThreadId" in meta
										? (meta.activeThreadId ?? null)
										: previous.activeThreadId,
							};
							return { ...next, decorations: buildDecorations(tr.doc, next) };
						},
					},
					props: {
						decorations: (state) => editorialCommentsKey.getState(state)?.decorations,
						handleClick(view, pos) {
							const state = editorialCommentsKey.getState(view.state);
							const hit = state ? highlightAt(state.highlights, pos) : null;
							if (hit) bridge.current.onActivate?.(hit.threadId);
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

interface DocTextBlock {
	key: string;
	node: PMNode;
	pos: number;
}

/** Textblocks that carry a Portable Text key, in document order. */
function keyedTextblocks(doc: PMNode): DocTextBlock[] {
	const blocks: DocTextBlock[] = [];
	doc.descendants((node, pos) => {
		if (!node.isTextblock) return true;
		const key: unknown = node.attrs[PORTABLE_TEXT_KEY_ATTR];
		if (typeof key === "string" && key) blocks.push({ key, node, pos });
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
	const blocks = keyedTextblocks(doc);
	const resolved = resolveAnchor(portableTextView(blocks), anchor);
	if (resolved.state !== "attached" || resolved.anchor.type !== "text") return null;
	const { blockKey, start, end } = resolved.anchor;
	const block = blocks.find((candidate) => candidate.key === blockKey);
	if (!block) return null;
	const contentStart = block.pos + 1;
	return {
		kind: "text",
		from: textOffsetToPos(block.node, contentStart, start),
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
	const blocks = keyedTextblocks(doc);
	const block = blocks.find(
		(candidate) => from > candidate.pos && to < candidate.pos + candidate.node.nodeSize,
	);
	if (!block) return null;
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
	| { ok: true; anchor: EditorialTextAnchor; from: number; to: number }
	| { ok: false; reason: "empty" | "multiple-blocks" | "too-long" };

/**
 * A text anchor for the current selection. A block without a Portable Text
 * key yet gets one, so the anchor and the next save agree on it.
 */
export function anchorForSelection(
	state: EditorState,
	dispatch: (tr: Transaction) => void,
	field: string,
	generateKey: () => string,
): SelectionAnchorResult {
	const { from, to, $from, $to } = state.selection;
	if (from === to) return { ok: false, reason: "empty" };
	if (!$from.sameParent($to) || !$from.parent.isTextblock) {
		return { ok: false, reason: "multiple-blocks" };
	}
	let doc = state.doc;
	if (!$from.parent.attrs[PORTABLE_TEXT_KEY_ATTR]) {
		const tr = state.tr.setNodeAttribute($from.before(), PORTABLE_TEXT_KEY_ATTR, generateKey());
		dispatch(tr);
		doc = tr.doc;
	}
	const anchor = anchorForRange(doc, field, from, to);
	if (!anchor) return { ok: false, reason: "too-long" };
	return { ok: true, anchor, from, to };
}
