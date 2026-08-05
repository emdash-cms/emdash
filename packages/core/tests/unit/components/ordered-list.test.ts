// @vitest-environment jsdom

import { Editor, type JSONContent } from "@tiptap/core";
import { type Node as ProseMirrorNode, Slice } from "@tiptap/pm/model";
import { NodeSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	EmDashOrderedList,
	normalizeOrderedListDocument,
	prepareCopiedSlice,
	remapMovedSlice,
	remapPastedSlice,
} from "../../../src/components/ordered-list.js";

const editors: Editor[] = [];

function list(attrs: Record<string, unknown>, labels: string[]): JSONContent {
	return {
		type: "orderedList",
		attrs,
		content: labels.map((label) => ({
			type: "listItem",
			content: [{ type: "paragraph", content: [{ type: "text", text: label }] }],
		})),
	};
}

function createEditor(content: JSONContent): Editor {
	const editor = new Editor({
		element: document.createElement("div"),
		extensions: [StarterKit.configure({ orderedList: false }), EmDashOrderedList],
		content,
	});
	editors.push(editor);
	return editor;
}

function orderedNodes(editor: Editor): Array<{ attrs: Record<string, unknown>; pos: number }> {
	const nodes: Array<{ attrs: Record<string, unknown>; pos: number }> = [];
	editor.state.doc.descendants((node, pos) => {
		if (node.type.name === "orderedList") nodes.push({ attrs: node.attrs, pos });
	});
	return nodes;
}

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
});

describe("EmDashOrderedList", () => {
	it("normalizes separated segments deterministically", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 1, listStart: 1, listId: "shared" }, ["Three"]),
			],
		});

		const changes = normalizeOrderedListDocument(editor.state.doc);
		expect(changes).toHaveLength(1);
		expect(changes[0]?.attrs.start).toBe(3);
	});

	it("continues and restarts the selected list tail", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "first" }, ["One"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 1, listStart: 1, listId: "second" }, ["Independent"]),
			],
		});
		let lists = orderedNodes(editor);
		editor.commands.setTextSelection(lists[1]!.pos + 2);
		expect(editor.can().continueOrderedList()).toBe(true);
		expect(editor.commands.continueOrderedList()).toBe(true);
		lists = orderedNodes(editor);
		expect(lists.map((node) => node.attrs.listId)).toEqual(["first", "first"]);
		expect(lists.map((node) => node.attrs.start)).toEqual([1, 2]);

		editor.commands.setTextSelection(lists[1]!.pos + 2);
		expect(editor.can().restartOrderedList()).toBe(true);
		expect(editor.commands.restartOrderedList()).toBe(true);
		lists = orderedNodes(editor);
		expect(lists[1]!.attrs.listId).not.toBe("first");
		expect(lists[1]!.attrs.start).toBe(1);
	});

	it("keeps lists in separate blockquotes independent", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				{
					type: "blockquote",
					content: [list({ start: 1, listStart: 1, listId: "first" }, ["One"])],
				},
				{
					type: "blockquote",
					content: [list({ start: 1, listStart: 1, listId: "second" }, ["Independent"])],
				},
			],
		});
		const lists = orderedNodes(editor);
		editor.commands.setTextSelection(lists[1]!.pos + 2);

		expect(editor.can().continueOrderedList()).toBe(false);
	});

	it("disables continuity commands for linked or multi-segment selections", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 2, listStart: 1, listId: "shared" }, ["Two"]),
			],
		});
		const lists = orderedNodes(editor);
		editor.commands.setTextSelection(lists[1]!.pos + 2);
		expect(editor.can().continueOrderedList()).toBe(false);

		editor.commands.setTextSelection({
			from: lists[0]!.pos + 2,
			to: lists[1]!.pos + 2,
		});
		expect(editor.can().continueOrderedList()).toBe(false);
		expect(editor.can().restartOrderedList()).toBe(false);
	});

	it("renumbers later segments after direct items are inserted or deleted", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "shared" }, ["Three"]),
			],
		});
		let first = orderedNodes(editor)[0]!;
		let firstNode = editor.state.doc.nodeAt(first.pos)!;
		const inserted = firstNode.child(0).copy(firstNode.child(0).content);
		editor.view.dispatch(editor.state.tr.insert(first.pos + firstNode.nodeSize - 1, inserted));
		expect(orderedNodes(editor).map((node) => node.attrs.start)).toEqual([1, 4]);

		first = orderedNodes(editor)[0]!;
		firstNode = editor.state.doc.nodeAt(first.pos)!;
		let lastOffset = 0;
		firstNode.forEach((_child, offset, index) => {
			if (index === firstNode.childCount - 1) lastOffset = offset;
		});
		const from = first.pos + 1 + lastOffset;
		editor.view.dispatch(editor.state.tr.delete(from, from + firstNode.lastChild!.nodeSize));
		expect(orderedNodes(editor).map((node) => node.attrs.start)).toEqual([1, 3]);
	});

	it("gives a newly toggled list a stable identity", () => {
		const editor = createEditor({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Item" }] }],
		});
		expect(editor.commands.toggleOrderedList()).toBe(true);
		const attrs = orderedNodes(editor)[0]!.attrs;
		expect(typeof attrs.listId).toBe("string");
		expect(attrs.listStart).toBe(1);
		expect(attrs.start).toBe(1);
	});

	it("creates an explicitly started list from a numeric input rule", () => {
		const editor = createEditor({ type: "doc", content: [{ type: "paragraph" }] });
		const { from, to } = editor.state.selection;
		const handled = editor.view.someProp("handleTextInput", (handler) =>
			handler(editor.view, from, to, "2. "),
		);

		expect(handled).toBe(true);
		expect(orderedNodes(editor)[0]?.attrs).toMatchObject({ start: 2, listStart: 2 });
		expect(typeof orderedNodes(editor)[0]?.attrs.listId).toBe("string");
	});

	it("restarts a standalone explicitly started list", () => {
		const editor = createEditor({
			type: "doc",
			content: [list({ start: 2, listStart: 2, listId: "started-at-two" }, ["Two"])],
		});
		const selected = orderedNodes(editor)[0]!;
		editor.commands.setTextSelection(selected.pos + 2);
		expect(editor.commands.restartOrderedList()).toBe(true);
		const attrs = orderedNodes(editor)[0]!.attrs;
		expect(attrs.listId).not.toBe("started-at-two");
		expect(attrs.listStart).toBe(1);
		expect(attrs.start).toBe(1);
	});

	it("never emits malformed list metadata into editor HTML", () => {
		const editor = createEditor({
			type: "doc",
			content: [list({ start: -5, listStart: 0, listId: " ".repeat(129) }, ["One"])],
		});
		const html = editor.getHTML();
		expect(html).not.toContain('start="-5"');
		expect(html).not.toContain("data-emdash-list-id");
		expect(html).not.toContain("data-emdash-list-start");
		expect(html).toContain('data-emdash-list-first="1"');
	});

	it("repairs a malformed cross-context identity using its canonical base", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["Root"]),
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Parent" }] },
								list({ start: 3, listStart: 1, listId: "shared" }, ["Moved continuation"]),
							],
						},
					],
				},
			],
		});

		const changes = normalizeOrderedListDocument(editor.state.doc);
		const nestedChange = changes.find((change) => change.attrs.listId !== "shared");
		expect(nestedChange?.attrs.listStart).toBe(1);
		expect(nestedChange?.attrs.start).toBe(1);
	});

	it("avoids collisions with deterministic repair identities", () => {
		const initial = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["Root"]),
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [
								{ type: "paragraph", content: [{ type: "text", text: "Parent" }] },
								list({ start: 1, listStart: 1, listId: "shared" }, ["Nested"]),
							],
						},
					],
				},
			],
		});
		const repairId = normalizeOrderedListDocument(initial.state.doc).find(
			(change) => change.attrs.listId !== "shared",
		)?.attrs.listId;
		expect(typeof repairId).toBe("string");

		const editor = createEditor({
			...initial.getJSON(),
			content: [
				...initial.getJSON().content!,
				{ type: "paragraph", content: [{ type: "text", text: "Boundary" }] },
				list({ start: 1, listStart: 1, listId: repairId }, ["Collision"]),
			],
		});
		const ids = normalizeOrderedListDocument(editor.state.doc)
			.map((change) => change.attrs.listId)
			.filter((id) => id !== "shared");
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("pastes a continuation as an independent list at its displayed start", () => {
		const editor = createEditor({ type: "doc", content: [{ type: "paragraph" }] });
		const slice = Slice.fromJSON(editor.schema, {
			content: [
				list({ start: 3, listStart: 1, listId: "source" }, ["Three"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 4, listStart: 1, listId: "source" }, ["Four"]),
			],
			openStart: 0,
			openEnd: 0,
		});

		const pasted = remapPastedSlice(slice).content.toJSON() as JSONContent[];
		const first = pasted[0]!.attrs!;
		const second = pasted[2]!.attrs!;
		expect(first.listId).not.toBe("source");
		expect(second.listId).toBe(first.listId);
		expect(first.listStart).toBe(3);
		expect(second.listStart).toBe(3);
	});

	it("assigns independent identities to external list runs", () => {
		const editor = createEditor({ type: "doc", content: [{ type: "paragraph" }] });
		const slice = Slice.fromJSON(editor.schema, {
			content: [
				list({ start: 7 }, ["Seven"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 9 }, ["Nine"]),
			],
			openStart: 0,
			openEnd: 0,
		});

		const pasted = remapPastedSlice(slice).content.toJSON() as JSONContent[];
		expect(pasted[0]?.attrs).toMatchObject({ start: 7, listStart: 7 });
		expect(pasted[2]?.attrs).toMatchObject({ start: 9, listStart: 9 });
		expect(pasted[0]?.attrs?.listId).not.toBe(pasted[2]?.attrs?.listId);
	});

	it("does not intercept a paste without an ordered list", () => {
		const editor = createEditor({
			type: "doc",
			content: [{ type: "paragraph", content: [{ type: "text", text: "Existing" }] }],
		});
		const slice = Slice.fromJSON(editor.schema, {
			content: [{ type: "paragraph", content: [{ type: "text", text: "Pasted" }] }],
			openStart: 0,
			openEnd: 0,
		});
		const before = editor.getJSON();
		const handled = editor.view.someProp("handlePaste", (handler) =>
			handler(editor.view, {} as ClipboardEvent, slice),
		);
		expect(handled).toBeUndefined();
		expect(editor.getJSON()).toEqual(before);
	});

	it("copies a partial list from its first selected item's displayed ordinal", () => {
		const editor = createEditor({
			type: "doc",
			content: [list({ start: 1, listStart: 1, listId: "source" }, ["One", "Two", "Three"])],
		});
		const selected = orderedNodes(editor)[0]!;
		const orderedList = editor.state.doc.nodeAt(selected.pos)!;
		let secondOffset = 0;
		orderedList.forEach((_child, offset, index) => {
			if (index === 1) secondOffset = offset;
		});
		const from = selected.pos + 1 + secondOffset + 2;
		editor.commands.setTextSelection({ from, to: from + 3 });
		const copied = prepareCopiedSlice(editor.state.selection.content(), editor.state);
		let copiedList: ProseMirrorNode | undefined;
		copied.content.descendants((node) => {
			if (!copiedList && node.type.name === "orderedList") copiedList = node;
		});
		expect(copiedList?.attrs.start).toBe(2);
		expect(copiedList?.attrs.listStart).toBe(1);

		const pasted = remapPastedSlice(copied);
		let pastedList: ProseMirrorNode | undefined;
		pasted.content.descendants((node) => {
			if (!pastedList && node.type.name === "orderedList") pastedList = node;
		});
		expect(pastedList?.attrs.listStart).toBe(2);
	});

	it("keeps split segments related when a partial copy spans a boundary", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "source" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "source" }, ["Three"]),
			],
		});
		const lists = orderedNodes(editor);
		const firstList = editor.state.doc.nodeAt(lists[0]!.pos)!;
		let secondOffset = 0;
		firstList.forEach((_child, offset, index) => {
			if (index === 1) secondOffset = offset;
		});
		const from = lists[0]!.pos + 1 + secondOffset + 2;
		const to = lists[1]!.pos + 4;
		editor.commands.setTextSelection({ from, to });
		const copied = prepareCopiedSlice(editor.state.selection.content(), editor.state);
		const pasted = remapPastedSlice(copied);
		const pastedLists: ProseMirrorNode[] = [];
		pasted.content.descendants((node) => {
			if (node.type.name === "orderedList") pastedLists.push(node);
		});
		expect(pastedLists).toHaveLength(2);
		expect(pastedLists.map((node) => node.attrs.listId)).toEqual([
			pastedLists[0]!.attrs.listId,
			pastedLists[0]!.attrs.listId,
		]);
		expect(pastedLists.map((node) => node.attrs.listStart)).toEqual([2, 2]);
	});

	it("gives a context-changing move a fresh identity at its displayed start", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "source" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "source" }, ["Three"]),
			],
		});
		const selected = orderedNodes(editor)[1]!;
		editor.commands.setTextSelection(selected.pos + 2);
		const nodeSize = editor.state.doc.nodeAt(selected.pos)!.nodeSize;
		const moved = remapMovedSlice(
			editor.state.doc.slice(selected.pos, selected.pos + nodeSize),
			editor.state,
		);
		let movedList: ProseMirrorNode | undefined;
		moved.content.descendants((node) => {
			if (!movedList && node.type.name === "orderedList") movedList = node;
		});
		expect(movedList?.attrs.listId).not.toBe("source");
		expect(movedList?.attrs.listStart).toBe(3);
		expect(movedList?.attrs.start).toBe(3);
	});

	it("merges adjacent segments with the same identity", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One"]),
				list({ start: 2, listStart: 1, listId: "shared" }, ["Two"]),
			],
		});
		editor.view.dispatch(editor.state.tr);
		const lists = orderedNodes(editor);
		expect(lists).toHaveLength(1);
		expect(editor.state.doc.nodeAt(lists[0]!.pos)?.childCount).toBe(2);
	});

	it("undoes and redoes a restart with the same identity", () => {
		const editor = createEditor({
			type: "doc",
			content: [list({ start: 1, listStart: 1, listId: "source" }, ["One"])],
		});
		const selected = orderedNodes(editor)[0]!;
		editor.commands.setTextSelection(selected.pos + 2);
		expect(editor.commands.restartOrderedList()).toBe(true);
		const restartedId = orderedNodes(editor)[0]!.attrs.listId;
		expect(restartedId).not.toBe("source");
		expect(editor.commands.undo()).toBe(true);
		expect(orderedNodes(editor)[0]!.attrs.listId).toBe("source");
		expect(editor.commands.redo()).toBe(true);
		expect(orderedNodes(editor)[0]!.attrs.listId).toBe(restartedId);
	});

	it("undoes an adjacent-segment merge with the boundary deletion", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "shared" }, ["One"]),
				{ type: "paragraph", content: [{ type: "text", text: "Boundary" }] },
				list({ start: 2, listStart: 1, listId: "shared" }, ["Two"]),
			],
		});
		const first = orderedNodes(editor)[0]!;
		const boundaryPos = first.pos + editor.state.doc.nodeAt(first.pos)!.nodeSize;
		const boundarySize = editor.state.doc.nodeAt(boundaryPos)!.nodeSize;
		expect(editor.commands.deleteRange({ from: boundaryPos, to: boundaryPos + boundarySize })).toBe(
			true,
		);
		expect(orderedNodes(editor)).toHaveLength(1);
		expect(editor.commands.undo()).toBe(true);
		expect(orderedNodes(editor)).toHaveLength(2);
		expect(editor.state.doc.nodeAt(boundaryPos)?.textContent).toBe("Boundary");
	});

	it("normalizes identically on two collaboration peers and then stabilizes", () => {
		const content: JSONContent = {
			type: "doc",
			content: [
				list({ start: 1 }, ["One"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 1 }, ["Independent"]),
			],
		};
		const first = createEditor(content);
		const second = createEditor(content);
		first.view.dispatch(first.state.tr.setMeta("remote", true));
		second.view.dispatch(second.state.tr.setMeta("remote", true));
		expect(first.getJSON()).toEqual(second.getJSON());
		expect(normalizeOrderedListDocument(first.state.doc)).toEqual([]);
		const normalized = first.getJSON();
		first.view.dispatch(first.state.tr.setMeta("remote", true));
		expect(first.getJSON()).toEqual(normalized);
	});

	it("remaps an actual cross-context drop but leaves same-context drops to ProseMirror", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "source" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "source" }, ["Three"]),
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							content: [{ type: "paragraph", content: [{ type: "text", text: "Target" }] }],
						},
					],
				},
			],
		});
		const source = orderedNodes(editor)[1]!;
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, source.pos)),
		);
		const slice = editor.state.selection.content();
		let targetPos = 0;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "listItem" && node.textContent === "Target") {
				targetPos = pos + node.nodeSize - 1;
				return false;
			}
			return true;
		});
		vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: targetPos, inside: -1 });
		const dropEvent = { clientX: 0, clientY: 0 } as DragEvent;
		const handled = editor.view.someProp("handleDrop", (handler) =>
			handler(editor.view, dropEvent, slice, true),
		);
		expect(handled).toBe(true);
		const lists = orderedNodes(editor);
		expect(lists).toHaveLength(2);
		expect(lists[0]!.attrs.listId).toBe("source");
		expect(lists[1]!.attrs.listId).not.toBe("source");
		expect(lists[1]!.attrs.listStart).toBe(3);
		expect(lists[1]!.attrs.start).toBe(3);

		const moved = lists[1]!;
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, moved.pos)),
		);
		const nestedSlice = editor.state.selection.content();
		vi.mocked(editor.view.posAtCoords).mockReturnValue({ pos: moved.pos, inside: -1 });
		const sameContextHandled = editor.view.someProp("handleDrop", (handler) =>
			handler(editor.view, dropEvent, nestedSlice, true),
		);
		expect(sameContextHandled).toBeUndefined();
	});

	it("remaps an ordered-list drag copy without changing the source", () => {
		const editor = createEditor({
			type: "doc",
			content: [
				list({ start: 1, listStart: 1, listId: "source" }, ["One", "Two"]),
				{ type: "paragraph", content: [{ type: "text", text: "Between" }] },
				list({ start: 3, listStart: 1, listId: "source" }, ["Three"]),
			],
		});
		const source = orderedNodes(editor)[1]!;
		editor.view.dispatch(
			editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, source.pos)),
		);
		const copied = prepareCopiedSlice(editor.state.selection.content(), editor.state);
		vi.spyOn(editor.view, "posAtCoords").mockReturnValue({
			pos: editor.state.doc.content.size,
			inside: -1,
		});
		const handled = editor.view.someProp("handleDrop", (handler) =>
			handler(editor.view, { clientX: 0, clientY: 0 } as DragEvent, copied, false),
		);
		expect(handled).toBe(true);
		const lists = orderedNodes(editor);
		expect(lists).toHaveLength(3);
		expect(lists.slice(0, 2).map((node) => node.attrs.listId)).toEqual(["source", "source"]);
		expect(lists[2]!.attrs.listId).not.toBe("source");
		expect(lists[2]!.attrs.listStart).toBe(3);
		expect(lists[2]!.attrs.start).toBe(3);
	});
});
