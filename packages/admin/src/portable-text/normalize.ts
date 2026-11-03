/**
 * Normalizers that act only on what this client's own transactions changed.
 * Every client renders every other client's changes, so a normalizer that
 * wrote while rendering one would have every client write the same fix, and
 * Yjs keeps each client's copy.
 *
 * Server-safe: nothing here touches the DOM, React or `crypto` when loaded.
 */

import { Extension, type AnyExtension } from "@tiptap/core";
import { isChangeOrigin } from "@tiptap/extension-collaboration";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, Transaction, type EditorState } from "@tiptap/pm/state";
import type { Step } from "@tiptap/pm/transform";

export interface ChangedRange {
	from: number;
	to: number;
}

function numberField(step: Step, field: string): number | undefined {
	const value: unknown = Reflect.get(step, field);
	return typeof value === "number" ? value : undefined;
}

/** The ranges of the final document that the transactions' steps changed. */
export function changedRanges(transactions: readonly Transaction[]): ChangedRange[] {
	const ranges: ChangedRange[] = [];
	for (const transaction of transactions) {
		for (const step of transaction.steps) {
			const map = step.getMap();
			for (const range of ranges) {
				range.from = map.map(range.from, -1);
				range.to = map.map(range.to, 1);
			}
			const stepRanges: ChangedRange[] = [];
			map.forEach((_oldFrom, _oldTo, from, to) => stepRanges.push({ from, to }));
			if (stepRanges.length === 0) {
				// Mark and attribute steps have empty maps. They're read by shape:
				// the editor bundles more than one prosemirror-transform, so
				// instanceof can miss them.
				const from = numberField(step, "from");
				const to = numberField(step, "to");
				const pos = numberField(step, "pos");
				if (from !== undefined && to !== undefined) stepRanges.push({ from, to });
				else if (pos !== undefined) stepRanges.push({ from: pos, to: pos + 1 });
			}
			ranges.push(...stepRanges);
		}
	}
	return ranges;
}

/** The transaction a plugin's `appendTransaction` answered, or the transaction itself. */
export function rootOf(transaction: Transaction): Transaction {
	const root: unknown = transaction.getMeta("appendedTransaction");
	return root instanceof Transaction ? root : transaction;
}

/** Whether the transaction renders another client's change, or answers one that does. */
export function isRemote(transaction: Transaction): boolean {
	return isChangeOrigin(transaction) || isChangeOrigin(rootOf(transaction));
}

type AppendCondition = (
	transactions: readonly Transaction[],
	oldState: EditorState,
	newState: EditorState,
) => boolean;

/**
 * `plugin` with an `appendTransaction` that answers only this client's own
 * transactions, and only when `onlyIf` holds for them.
 */
export function localOnly<T>(plugin: Plugin<T>, onlyIf?: AppendCondition): Plugin<T> {
	const append = plugin.spec.appendTransaction;
	if (!append) return plugin;
	return new Plugin<T>({
		...plugin.spec,
		appendTransaction(transactions, oldState, newState) {
			if (transactions.some(isRemote)) return null;
			if (onlyIf && !onlyIf(transactions, oldState, newState)) return null;
			return append.call(this, transactions, oldState, newState);
		},
	});
}

/** `extension` with each plugin it adds made local-only. */
export function withLocalOnlyPlugins(
	extension: AnyExtension,
	onlyIf?: AppendCondition,
): AnyExtension {
	return extension.extend({
		addProseMirrorPlugins() {
			return (this.parent?.() ?? []).map((plugin: Plugin) => localOnly(plugin, onlyIf));
		},
	});
}

const FILLED_WHEN_EMPTIED = new Set([
	"bulletList",
	"orderedList",
	"blockquote",
	"tableCell",
	"tableHeader",
]);

const REMOVED_WHEN_EMPTIED = new Set(["listItem", "bulletList", "orderedList", "blockquote"]);

const clamp = (doc: ProseMirrorNode, { from, to }: ChangedRange): ChangedRange => {
	const size = doc.content.size;
	return { from: Math.max(0, Math.min(from, size)), to: Math.max(0, Math.min(to, size)) };
};

/** A list item without a leading paragraph, or an empty list, quote or cell. */
function misshapen(node: ProseMirrorNode | null | undefined): boolean {
	if (!node) return false;
	if (node.type.name === "listItem") return node.firstChild?.type.name !== "paragraph";
	return node.childCount === 0 && FILLED_WHEN_EMPTIED.has(node.type.name);
}

/**
 * Where the node that starts at `pos` after the transactions started before
 * them, or null when they inserted or replaced it.
 */
function positionBefore(transactions: readonly Transaction[], pos: number): number | null {
	const maps = transactions.flatMap((transaction) => transaction.mapping.maps);
	let mapped = pos;
	for (const map of maps.toReversed()) {
		const result = map.invert().mapResult(mapped, 1);
		if (result.deleted) return null;
		mapped = result.pos;
	}
	return mapped;
}

/**
 * Gives back the shapes a local edit took from containers. A list item it left
 * without a leading paragraph gets one, and an empty list, quote or cell it
 * added gets an item or a paragraph. A list, list item or quote it emptied is
 * removed, as it was when they couldn't be empty, and so is a list or list item
 * that removal leaves empty; a cell it emptied gets a paragraph. A container
 * that already had its shape, such as one a merge left, is left alone, and only
 * what the edit itself emptied is removed, so this can't remove what another
 * client added.
 */
function reshapeContainers(
	state: EditorState,
	oldState: EditorState,
	transactions: readonly Transaction[],
	tr: Transaction,
) {
	const { doc } = state;
	const refills = new Set<number>();
	const removals = new Set<number>();
	for (const range of changedRanges(transactions)) {
		const { from, to } = clamp(doc, range);
		doc.nodesBetween(from, to, (node, pos) => {
			if (node.isTextblock) return false;
			if (!misshapen(node)) return true;
			const before = positionBefore(transactions, pos);
			const previous = before === null ? null : oldState.doc.nodeAt(before);
			if (
				node.childCount === 0 &&
				REMOVED_WHEN_EMPTIED.has(node.type.name) &&
				previous?.type === node.type &&
				previous.childCount > 0
			) {
				removals.add(pos);
			} else if (previous?.type !== node.type || !misshapen(previous)) {
				refills.add(pos);
			}
			return true;
		});
	}
	const { listItem, paragraph } = state.schema.nodes;
	for (const pos of [...refills, ...removals].toSorted((a, b) => b - a)) {
		const mapped = tr.mapping.mapResult(pos);
		if (mapped.deleted) continue;
		const $inside = tr.doc.resolve(mapped.pos + 1);
		if (removals.has(pos)) {
			let depth = $inside.depth;
			while (
				depth > 1 &&
				$inside.node(depth - 1).childCount === 1 &&
				REMOVED_WHEN_EMPTIED.has($inside.node(depth - 1).type.name)
			) {
				depth--;
			}
			tr.delete($inside.before(depth), $inside.after(depth));
			continue;
		}
		const name = $inside.parent.type.name;
		const isList = name === "bulletList" || name === "orderedList";
		tr.insert(
			$inside.pos,
			isList ? listItem!.create(null, paragraph!.create()) : paragraph!.create(),
		);
	}
}

/** Yjs stores no marks on a line break, so the breaks a local edit marks lose them. */
function unmarkLineBreaks(
	state: EditorState,
	transactions: readonly Transaction[],
	tr: Transaction,
) {
	const marked = new Map<number, ProseMirrorNode>();
	for (const range of changedRanges(transactions)) {
		const { from, to } = clamp(state.doc, range);
		state.doc.nodesBetween(from, to, (node, pos) => {
			if (node.type.name !== "hardBreak") return true;
			if (node.marks.length > 0) marked.set(pos, node);
			return false;
		});
	}
	for (const [pos, node] of marked) {
		for (const mark of node.marks) tr.removeNodeMark(pos, mark.type);
	}
}

function shapePlugin(): Plugin {
	return new Plugin({
		appendTransaction(transactions, oldState, state) {
			if (!transactions.some((transaction) => transaction.docChanged)) return null;
			const tr = state.tr;
			unmarkLineBreaks(state, transactions, tr);
			reshapeContainers(state, oldState, transactions, tr);
			return tr.docChanged ? tr : null;
		},
	});
}

/**
 * TipTap's `clearDocument` turns a document whose text was all selected and
 * then deleted into one paragraph. Another client emptying the document isn't
 * this client's deletion.
 */
function keepRemotelyEmptiedDocuments(): Plugin {
	return new Plugin({
		filterTransaction(transaction) {
			if (isRemote(transaction)) transaction.setMeta("preventClearDocument", true);
			return true;
		},
	});
}

export const PortableTextNormalizers = Extension.create({
	name: "emdashPortableTextNormalizers",

	addProseMirrorPlugins() {
		return [keepRemotelyEmptiedDocuments(), localOnly(shapePlugin())];
	},
});
