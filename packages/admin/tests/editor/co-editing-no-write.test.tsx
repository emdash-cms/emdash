/**
 * Opening an entry, and rendering what other clients changed, makes the
 * editor write nothing to the shared document: every client renders every
 * change, so a write there would be made by each of them.
 */

import { Editor as HeadlessEditor, Extension } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Selection, TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import {
	prosemirrorJSONToYXmlFragment,
	yXmlFragmentToProsemirrorJSON,
	ySyncPlugin,
} from "@tiptap/y-tiptap";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import {
	portableTextExtensions,
	portableTextSchema,
	portableTextToProsemirror,
	prosemirrorToPortableText,
} from "../../src/internal/portable-text";
import { PortableTextFilledDefaults } from "../../src/portable-text/schema";
import { PortableTextYSync } from "../../src/portable-text/y-sync";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Value = NonNullable<PortableTextEditorProps["value"]>;

const span = (key: string, text: string, marks: string[] = []) => ({
	_type: "span",
	_key: `${key}-s`,
	text,
	marks,
});
const block = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [span(key, text)],
	...extra,
});
const item = (key: string, text: string, listItem = "bullet", level = 1) =>
	block(key, text, { listItem, level });
const cell = (text: string) => ({
	_type: "tableCell",
	_key: `k-${text}`,
	content: [{ _type: "span", _key: `k-${text}-s`, text }],
});

const VALUE = [
	block("k-title", "Title", { style: "h2" }),
	block("k-intro", "Intro"),
	block("k-lines", "", { children: [span("k-lines", "Line one\nLine two", ["strong"])] }),
	item("k-one", "One"),
	item("k-two", "Two"),
	item("k-three", "Three"),
	item("k-first", "First", "number"),
	item("k-second", "Second", "number"),
	{
		_type: "table",
		_key: "k-table",
		rows: [
			{ _type: "tableRow", _key: "k-r1", cells: [cell("A"), cell("B")] },
			{ _type: "tableRow", _key: "k-r2", cells: [cell("C"), cell("D")] },
		],
	},
	block("k-quote", "Quoted", { style: "blockquote" }),
	{ _type: "code", _key: "k-code", code: "let x = 1;", language: "js" },
];

const FROM_PEER = Symbol("peer");

/** Y documents that send each update they make to every other, in order, once delivered. */
function network(count: number, value: unknown[]) {
	const seed = new Y.Doc();
	prosemirrorJSONToYXmlFragment(
		portableTextSchema(),
		portableTextToProsemirror(value as Value),
		seed.getXmlFragment("default"),
	);
	const docs = Array.from({ length: count }, (_, index) => {
		const doc = new Y.Doc();
		doc.clientID = index + 1;
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(seed), FROM_PEER);
		return doc;
	});
	const sent = new Map<Y.Doc, number>(docs.map((doc) => [doc, 0]));
	const pending: Array<{ to: Y.Doc; update: Uint8Array }> = [];
	for (const doc of docs) {
		doc.on("update", (update: Uint8Array, origin: unknown) => {
			if (origin === FROM_PEER) return;
			sent.set(doc, sent.get(doc)! + 1);
			for (const to of docs) if (to !== doc) pending.push({ to, update });
		});
	}
	return {
		docs,
		sent: (doc: Y.Doc) => sent.get(doc)!,
		deliver() {
			while (pending.length > 0) {
				const { to, update } = pending.shift()!;
				Y.applyUpdate(to, update, FROM_PEER);
			}
		},
	};
}

/** Another client: a headless editor with the shared schema. */
function peer(doc: Y.Doc) {
	return new HeadlessEditor({
		extensions: [
			...portableTextExtensions(),
			PortableTextFilledDefaults,
			PortableTextYSync,
			Extension.create({
				name: "peerSync",
				addProseMirrorPlugins: () => [ySyncPlugin(doc.getXmlFragment("default"))],
			}),
		],
	});
}

function position(
	editor: { state: { doc: ProseMirrorNode } },
	text: string,
	edge: "start" | "end",
) {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found !== -1 || !node.isTextblock || node.textContent !== text) return;
		found = edge === "start" ? pos + 1 : pos + 1 + node.content.size;
	});
	expect(found).toBeGreaterThan(-1);
	return found;
}

const shared = (doc: Y.Doc) => yXmlFragmentToProsemirrorJSON(doc.getXmlFragment("default"));

describe("co-editing", () => {
	it("writes nothing when it opens a document or renders other clients' changes", async () => {
		const net = network(3, VALUE);
		const [mine, other, third] = net.docs as [Y.Doc, Y.Doc, Y.Doc];

		let editor: Editor | null = null;
		await render(
			<PortableTextEditor
				value={VALUE as Value}
				onEditorReady={(instance) => {
					editor = instance;
				}}
			/>,
		);
		await vi.waitFor(() => expect(editor).toBeTruthy());
		const local = editor!;
		local.registerPlugin(ySyncPlugin(mine.getXmlFragment("default")));

		/** A selection change makes y-tiptap write whatever this client's document holds that Yjs doesn't. */
		const expectNoWrite = (step: string) => {
			const before = net.sent(mine);
			local.view.dispatch(local.state.tr.setSelection(Selection.atStart(local.state.doc)));
			expect(net.sent(mine), step).toBe(before);
			expect(prosemirrorToPortableText(local.getJSON()), step).toEqual(
				prosemirrorToPortableText(shared(mine)),
			);
		};
		expectNoWrite("open");

		const b = peer(other);
		const c = peer(third);

		b.chain()
			.setTextSelection(position(b, "Intro", "end"))
			.insertContent(" more")
			.run();
		net.deliver();
		expectNoWrite("typing");

		b.chain()
			.setTextSelection(position(b, "Intro more", "end"))
			.splitBlock()
			.insertContent("Fresh")
			.toggleBulletList()
			.run();
		net.deliver();
		expectNoWrite("new list");

		b.chain()
			.setTextSelection(position(b, "Two", "start"))
			.sinkListItem("listItem")
			.run();
		net.deliver();
		expectNoWrite("nested list");

		b.chain()
			.setTextSelection(position(b, "A", "start"))
			.addRowAfter()
			.run();
		b.chain()
			.setTextSelection(position(b, "B", "start"))
			.addColumnAfter()
			.run();
		net.deliver();
		expectNoWrite("table rows and columns");

		c.chain()
			.setTextSelection(c.state.doc.content.size - 1)
			.insertContent({ type: "image", attrs: { src: "https://example.com/a.png" } })
			.run();
		net.deliver();
		expect(local.state.doc.child(local.state.doc.childCount - 2).type.name).toBe("image");
		expectNoWrite("final image");

		const blocks = local.state.doc.childCount;
		const beforeEdit = net.sent(mine);
		local.view.dispatch(local.state.tr.insertText("!", position(local, "Title", "end")));
		expect(net.sent(mine)).toBeGreaterThan(beforeEdit);
		expect(local.state.doc.childCount).toBe(blocks);
		net.deliver();
		expectNoWrite("after a local edit");

		// One client deletes the first paragraph of the item that holds a nested list,
		// while another nests one more item in it.
		const one = position(b, "One", "start") - 1;
		b.view.dispatch(b.state.tr.delete(one, one + b.state.doc.nodeAt(one)!.nodeSize));
		c.chain()
			.setTextSelection(position(c, "Three", "start"))
			.sinkListItem("listItem")
			.run();
		net.deliver();
		expectNoWrite("list item without its paragraph");

		// Two clients each lift one item out of a list, which leaves it empty.
		b.chain()
			.setTextSelection(position(b, "First", "start"))
			.liftListItem("listItem")
			.run();
		c.chain()
			.setTextSelection(position(c, "Second", "start"))
			.liftListItem("listItem")
			.run();
		net.deliver();
		const lists: number[] = [];
		local.state.doc.forEach((node) => {
			if (node.type.name === "orderedList") lists.push(node.childCount);
		});
		expect(lists).toEqual([0]);
		expectNoWrite("emptied list");

		local.view.dispatch(
			local.state.tr.setSelection(
				TextSelection.create(
					local.state.doc,
					Selection.atStart(local.state.doc).from,
					Selection.atEnd(local.state.doc).to,
				),
			),
		);
		b.chain().selectAll().deleteSelection().run();
		net.deliver();
		expectNoWrite("select all and delete");

		b.destroy();
		c.destroy();
	});

	it("keeps each item once when two clients lift items out of the same list", () => {
		const net = network(2, [
			block("k-intro", "Intro"),
			item("k-first", "First", "number"),
			item("k-second", "Second", "number"),
			block("k-after", "After"),
		]);
		const [b, c] = net.docs.map(peer) as [HeadlessEditor, HeadlessEditor];

		b.chain()
			.setTextSelection(position(b, "First", "start"))
			.liftListItem("listItem")
			.run();
		c.chain()
			.setTextSelection(position(c, "Second", "start"))
			.liftListItem("listItem")
			.run();
		net.deliver();

		const blocks = (editor: HeadlessEditor) =>
			editor.state.doc.children.map((node) =>
				node.type.name === "orderedList"
					? `orderedList of ${node.childCount}`
					: `${node.type.name} ${node.textContent}`,
			);
		for (const [editor, doc] of [
			[b, net.docs[0]!],
			[c, net.docs[1]!],
		] as const) {
			expect(blocks(editor)).toEqual([
				"paragraph Intro",
				"paragraph First",
				"orderedList of 0",
				"paragraph Second",
				"paragraph After",
			]);
			expect(prosemirrorToPortableText(shared(doc))).toEqual(
				prosemirrorToPortableText(editor.getJSON()),
			);
		}

		b.destroy();
		c.destroy();
	});

	it("keeps another client's edit inside a list when a lift adds a block before it", () => {
		const net = network(2, [
			block("k-intro", "Intro"),
			item("k-first", "First", "number"),
			item("k-second", "Second", "number"),
			block("k-after", "After"),
		]);
		const [b, c] = net.docs.map(peer) as [HeadlessEditor, HeadlessEditor];

		b.chain()
			.setTextSelection(position(b, "First", "start"))
			.liftListItem("listItem")
			.run();
		c.chain()
			.setTextSelection(position(c, "Second", "end"))
			.insertContent("!!")
			.run();
		net.deliver();

		for (const [editor, doc] of [
			[b, net.docs[0]!],
			[c, net.docs[1]!],
		] as const) {
			expect(
				editor.state.doc.children.map((node) => `${node.type.name} ${node.textContent}`),
			).toEqual(["paragraph Intro", "paragraph First", "orderedList Second!!", "paragraph After"]);
			expect(prosemirrorToPortableText(shared(doc))).toEqual(
				prosemirrorToPortableText(editor.getJSON()),
			);
		}

		b.destroy();
		c.destroy();
	});
});
