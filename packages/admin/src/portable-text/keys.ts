/**
 * Portable Text block keys in the editor's document. Each block's `_key` is
 * held by the node it is saved from, so a block keeps its key from save to save.
 *
 * Server-safe: nothing here touches the DOM, React or `crypto` when loaded.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";

import { PORTABLE_TEXT_KEY_ATTR } from "../components/editor/portableTextIdentity.js";
import { changedRanges, localOnly, rootOf, type ChangedRange } from "./normalize.js";

export function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}

const TOP_LEVEL_BLOCKS = new Set([
	"paragraph",
	"heading",
	"codeBlock",
	"htmlBlock",
	"iframeBlock",
	"videoBlock",
	"image",
	"gallery",
	"horizontalRule",
	"pluginBlock",
]);

/** The nodes that can hold a node that owns a key. */
const KEYED_CONTAINERS = new Set(["blockquote", "bulletList", "orderedList", "listItem"]);

/**
 * Whether `node`, a child of `parent`, holds the `_key` of a Portable Text
 * block: a top-level text block or block atom, or a list item's or quote's
 * paragraph. Tables keep their keys in `emdashKey`.
 */
export function ownsPortableTextKey(
	node: ProseMirrorNode,
	parent: ProseMirrorNode | null,
): boolean {
	if (!parent) return false;
	if (parent.type === parent.type.schema.topNodeType) return TOP_LEVEL_BLOCKS.has(node.type.name);
	if (node.type.name !== "paragraph") return false;
	return parent.type.name === "listItem" || parent.type.name === "blockquote";
}

function keyOf(node: ProseMirrorNode): string | undefined {
	const key: unknown = node.attrs[PORTABLE_TEXT_KEY_ATTR];
	return typeof key === "string" && key ? key : undefined;
}

const hasContent = (node: ProseMirrorNode) => !node.isTextblock || node.content.size > 0;

/**
 * An empty last paragraph, such as TrailingNode's after a final block, isn't
 * content: the converter drops it only while it has no key.
 */
function isTrailingParagraph(doc: ProseMirrorNode, pos: number, node: ProseMirrorNode): boolean {
	return (
		node.type.name === "paragraph" &&
		node.childCount === 0 &&
		pos + node.nodeSize === doc.content.size
	);
}

function assignPortableTextKeys(
	state: EditorState,
	ranges: readonly ChangedRange[],
): Transaction | null {
	const { doc } = state;
	const changed = new Map<number, ProseMirrorNode>();
	for (const { from, to } of ranges) {
		doc.nodesBetween(from, to, (node, pos, parent) => {
			if (ownsPortableTextKey(node, parent)) changed.set(pos, node);
			return KEYED_CONTAINERS.has(node.type.name);
		});
	}
	if (changed.size === 0) return null;

	const holders = new Map<string, number[]>();
	doc.descendants((node, pos, parent) => {
		const key = keyOf(node);
		if (key && ownsPortableTextKey(node, parent)) {
			const positions = holders.get(key);
			if (positions) positions.push(pos);
			else holders.set(key, [pos]);
		}
		return KEYED_CONTAINERS.has(node.type.name);
	});

	const needsKey: number[] = [];
	const dropsKey: number[] = [];
	for (const [pos, node] of changed) {
		const key = keyOf(node);
		if (isTrailingParagraph(doc, pos, node)) {
			if (key) dropsKey.push(pos);
			continue;
		}
		if (!key) {
			needsKey.push(pos);
			continue;
		}
		const positions = holders.get(key) ?? [];
		if (positions.length < 2) continue;
		// A holder the transactions didn't touch had the key first, so a copy gives it up.
		const keeper = positions.some((position) => !changed.has(position))
			? undefined
			: (positions.find((position) => hasContent(changed.get(position)!)) ?? positions[0]);
		if (pos !== keeper) needsKey.push(pos);
	}
	if (needsKey.length === 0 && dropsKey.length === 0) return null;

	const transaction = state.tr;
	for (const pos of dropsKey) transaction.setNodeAttribute(pos, PORTABLE_TEXT_KEY_ATTR, null);
	const used = new Set(holders.keys());
	for (const pos of needsKey) {
		let key: string;
		do key = generateKey();
		while (used.has(key));
		used.add(key);
		transaction.setNodeAttribute(pos, PORTABLE_TEXT_KEY_ATTR, key);
	}
	return transaction;
}

const composes = (transaction: Transaction) => Boolean(rootOf(transaction).getMeta("composition"));

export const portableTextKeysPluginKey = new PluginKey<ChangedRange[]>("emdashPortableTextKeys");

/**
 * Gives each block the local transactions created or changed a key of its
 * own: a block with no key, or a copy of another block's, gets a new one.
 * Splitting a block leaves the key with the half that keeps the text.
 *
 * Changing a block while an input method composes text in it ends the
 * composition, so the ranges input method transactions change wait in the
 * plugin's state until it has ended.
 */
export function portableTextKeysPlugin(): Plugin<ChangedRange[]> {
	const plugin = new Plugin<ChangedRange[]>({
		key: portableTextKeysPluginKey,
		state: {
			init: () => [],
			apply(transaction, deferred) {
				if (transaction.getMeta(portableTextKeysPluginKey)) return [];
				const mapped = deferred.map(({ from, to }) => ({
					from: transaction.mapping.map(from, -1),
					to: transaction.mapping.map(to, 1),
				}));
				return composes(transaction) ? [...mapped, ...changedRanges([transaction])] : mapped;
			},
		},
		appendTransaction(transactions, _oldState, newState) {
			const deferred = portableTextKeysPluginKey.getState(newState) ?? [];
			const keyed = assignPortableTextKeys(newState, [...deferred, ...changedRanges(transactions)]);
			if (!keyed && deferred.length === 0) return null;
			const transaction = (keyed ?? newState.tr).setMeta(portableTextKeysPluginKey, true);
			// A step clears stored marks, so typing after Enter would lose the line's bold.
			if (newState.storedMarks) transaction.setStoredMarks(newState.storedMarks);
			// TipTap's clearDocument answers every change while an emptied document stays
			// selected, and drops the keys given here, so the two would answer each other
			// forever. Only the edit that emptied the document starts it.
			if (transactions.every((tr) => rootOf(tr) !== tr)) {
				transaction.setMeta("preventClearDocument", true);
			}
			return transaction;
		},
		props: {
			handleDOMEvents: {
				compositionend(view) {
					setTimeout(() => {
						if (view.isDestroyed || view.composing) return;
						if (portableTextKeysPluginKey.getState(view.state)?.length)
							view.dispatch(view.state.tr);
					});
					return false;
				},
			},
		},
	});
	return localOnly(plugin, (transactions) => !transactions.some(composes));
}

export const PortableTextKeys = Extension.create({
	name: "emdashPortableTextKeys",

	addProseMirrorPlugins() {
		return [portableTextKeysPlugin()];
	},
});
