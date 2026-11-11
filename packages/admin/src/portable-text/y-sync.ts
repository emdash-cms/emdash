/**
 * Works around two y-tiptap behaviors that lose or misplace another client's
 * work.
 *
 * It keeps y-tiptap from replacing a shared block when a local change adds a
 * block before it.
 *
 * When a change adds a block before a block it also changes, as lifting the
 * first item out of a list does, y-tiptap pairs the new block with the changed
 * block's element by position. Their types differ, so it deletes the element
 * and inserts a copy: another client's concurrent change inside the element
 * is lost, and content that client moved out of it is duplicated. Before
 * y-tiptap writes, this updates each such element from the node of the same
 * type, counting from the end of the changed run, so y-tiptap finds it
 * unchanged and keeps it.
 *
 * It also keeps the caret with its text when another client edits the same
 * paragraph. After a remote change, y-tiptap treats a caret in a paragraph
 * whose text changed as misplaced and puts it back at its old offset, so text
 * typed before it pushes the caret off its word. While the caret's text node
 * still exists, its relative position is exact, and the caret goes there.
 * y-tiptap's own recovery still handles a caret whose text node is gone.
 *
 * Server-safe: nothing here touches the DOM, React or `crypto` when loaded.
 */

import { Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, type EditorState } from "@tiptap/pm/state";
import {
	type BindingMetadata,
	type ProsemirrorBinding,
	updateYFragment,
	ySyncPluginKey,
} from "@tiptap/y-tiptap";
import * as Y from "yjs";

import { markRemote } from "./normalize.js";

type YChild = ReturnType<Y.XmlFragment["toArray"]>[number];

const sameType = (yChild: YChild | undefined, node: ProseMirrorNode | undefined) =>
	yChild instanceof Y.XmlElement && node !== undefined && yChild.nodeName === node.type.name;

/**
 * The children y-tiptap keeps in place: those still mapped to a node of the
 * new document, in the longest run that keeps their order, as y-tiptap finds
 * them.
 */
function anchors(yChildren: YChild[], nodes: readonly ProseMirrorNode[], meta: BindingMetadata) {
	const indexOf = new Map<ProseMirrorNode, number>();
	nodes.forEach((node, index) => {
		if (!indexOf.has(node)) indexOf.set(node, index);
	});
	const candidates: Array<{ y: number; p: number }> = [];
	yChildren.forEach((yChild, y) => {
		const mapped = meta.mapping.get(yChild);
		const p = Array.isArray(mapped) ? undefined : mapped && indexOf.get(mapped);
		if (p !== undefined) candidates.push({ y, p });
	});
	const previous: number[] = [];
	const tails: number[] = [];
	candidates.forEach((candidate, index) => {
		let low = 0;
		let high = tails.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if (candidates[tails[middle]!]!.p < candidate.p) low = middle + 1;
			else high = middle;
		}
		previous[index] = low > 0 ? tails[low - 1]! : -1;
		tails[low] = index;
	});
	const run: Array<{ y: number; p: number }> = [];
	for (let index = tails.at(-1) ?? -1; index !== -1; index = previous[index]!) {
		run.push(candidates[index]!);
	}
	return run.toReversed();
}

function alignChildren(
	doc: Y.Doc,
	yParent: Y.XmlFragment,
	node: ProseMirrorNode,
	meta: BindingMetadata,
) {
	if (node.inlineContent) return;
	const yChildren = yParent.toArray();
	const nodes = node.children;
	const gaps = [...anchors(yChildren, nodes, meta), { y: yChildren.length, p: nodes.length }];
	let y = 0;
	let p = 0;
	for (const end of gaps) {
		const paired = Math.min(end.y - y, end.p - p);
		let left = 0;
		while (left < paired && sameType(yChildren[y + left], nodes[p + left])) left++;
		let right = 0;
		if (end.y - y !== end.p - p) {
			while (
				left + right < paired &&
				sameType(yChildren[end.y - 1 - right], nodes[end.p - 1 - right])
			) {
				right++;
			}
		}
		// y-tiptap pairs the rest by position and updates those of the same type.
		for (let index = 0; index < paired - right; index++) {
			const yChild = yChildren[y + index];
			const child = nodes[p + index];
			if (yChild instanceof Y.XmlElement && child && sameType(yChild, child)) {
				alignChildren(doc, yChild, child, meta);
			}
		}
		for (let index = 1; index <= right; index++) {
			const yChild = yChildren[end.y - index];
			const child = nodes[end.p - index];
			if (!(yChild instanceof Y.XmlElement) || !child) continue;
			alignChildren(doc, yChild, child, meta);
			updateYFragment(doc, yChild, child, meta);
		}
		y = end.y + 1;
		p = end.p + 1;
	}
}

const aligned = new WeakSet<ProsemirrorBinding>();

const showsSnapshot = (state: EditorState) => {
	const sync = ySyncPluginKey.getState(state);
	return sync?.snapshot != null || sync?.prevSnapshot != null;
};

/**
 * Works around https://github.com/ueberdosis/tiptap/issues/8735. Remove it once the y-tiptap pin
 * includes a fix.
 */
function alignBeforeWrites(binding: ProsemirrorBinding) {
	if (aligned.has(binding)) return;
	aligned.add(binding);
	const write = binding._prosemirrorChanged.bind(binding);
	binding._prosemirrorChanged = (doc) => {
		const view = binding.prosemirrorView;
		// y-tiptap maps the root to each document it writes, and forgets it on remote changes, so
		// a selection-only update has nothing to align.
		const unchanged = binding.mapping.get(binding.type) === doc;
		if (unchanged || binding.invalidContentError !== null || !view || showsSnapshot(view.state)) {
			write(doc);
			return;
		}
		binding.doc.transact(() => {
			alignChildren(binding.doc, binding.type, doc, binding);
			write(doc);
		}, ySyncPluginKey);
	};
}

/** Whether a relative position is in a text node that still exists. */
function inLiveText(binding: ProsemirrorBinding, relative: Y.RelativePosition): boolean {
	const decoded = Y.createAbsolutePositionFromRelativePosition(relative, binding.doc);
	if (!decoded || !(decoded.type instanceof Y.XmlText)) return false;
	let item: Y.Item | null = decoded.type._item;
	while (item) {
		if (item.deleted) return false;
		item = item.parent instanceof Y.AbstractType ? item.parent._item : null;
	}
	return true;
}

const followed = new WeakSet<ProsemirrorBinding>();

/**
 * Works around https://github.com/ueberdosis/tiptap/issues/8594. Remove it once the y-tiptap pin
 * includes a fix, such as https://github.com/ueberdosis/tiptap/pull/8617.
 *
 * y-tiptap moves the selection by its old absolute positions only while they are in the old
 * document, so putting them out of it for a caret whose text node survived leaves the caret at its
 * relative position.
 */
function followRemoteEdits(binding: ProsemirrorBinding) {
	if (followed.has(binding)) return;
	followed.add(binding);
	const observe = binding._observeFunction;
	const observeAndFollow: typeof observe = (events, transaction) => {
		const selection = binding.beforeTransactionSelection;
		if (
			selection?.type === "text" &&
			transaction.origin !== ySyncPluginKey &&
			!(transaction.origin instanceof Y.UndoManager) &&
			inLiveText(binding, selection.anchor) &&
			inLiveText(binding, selection.head)
		) {
			binding.beforeTransactionSelection = { ...selection, absAnchor: -1, absHead: -1 };
		}
		observe(events, transaction);
	};
	// y-tiptap observes with the function it bound when it was made, and starts once it has a view.
	if (binding.prosemirrorView) {
		binding.type.unobserveDeep(observe);
		binding.type.observeDeep(observeAndFollow);
	}
	(binding as { _observeFunction: typeof observe })._observeFunction = observeAndFollow;
}

/**
 * Marks each transaction y-tiptap dispatches as remote for the normalizers. Its priority puts its
 * filter before theirs.
 */
const PortableTextRemoteChanges = Extension.create({
	name: "emdashPortableTextRemoteChanges",
	priority: 10_000,

	addProseMirrorPlugins() {
		return [
			new Plugin({
				filterTransaction(transaction) {
					if (transaction.getMeta(ySyncPluginKey)) markRemote(transaction);
					return true;
				},
			}),
		];
	},
});

/**
 * The two workarounds above, and the marks `isRemote` reads. It isn't in `portableTextExtensions()`,
 * which sites load on the server.
 */
export const PortableTextYSync = Extension.create({
	name: "emdashPortableTextYSync",

	addExtensions() {
		return [PortableTextRemoteChanges];
	},

	addProseMirrorPlugins() {
		return [
			new Plugin({
				view(view) {
					const binding = ySyncPluginKey.getState(view.state)?.binding;
					if (binding) {
						alignBeforeWrites(binding);
						followRemoteEdits(binding);
					}
					return {};
				},
			}),
		];
	},
});
