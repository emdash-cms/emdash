/**
 * Rich-text editors bound to a co-editing room, through the session and replica the page uses
 * and a loopback room that relays like the real one.
 */

import { Editor as HeadlessEditor, Extension } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { SuggestionPluginKey } from "@tiptap/suggestion";
import {
	prosemirrorJSONToYXmlFragment,
	yUndoPluginKey,
	ySyncPlugin,
	ySyncPluginKey,
} from "@tiptap/y-tiptap";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { editorSchema, fragmentName, readField, writeField } from "../../src/co-editing/layout";
import { insertTable } from "../../src/components/editor/TableControls";
import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import {
	portableTextExtensions,
	portableTextToProsemirror,
	prosemirrorToPortableText,
	type PortableTextBlock,
} from "../../src/internal/portable-text";
import { uploadMedia } from "../../src/lib/api/media";
import type { RoomEditing } from "../../src/lib/co-editing/types";
import { PortableTextFilledDefaults } from "../../src/portable-text/schema";
import { PortableTextYSync } from "../../src/portable-text/y-sync";
import { LoopbackRoom, settle } from "../co-editing/loopback-room";
import {
	resetTransportHealth,
	startSession,
	type TestSession,
} from "../co-editing/session-harness";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: ({
		editor,
		onInsertBlock,
	}: {
		editor: Editor;
		onInsertBlock?: (insertPos: number) => void;
	}) => (
		<button type="button" onClick={() => onInsertBlock?.(editor.state.doc.content.size)}>
			Test gutter insert
		</button>
	),
}));
vi.mock("../../src/lib/api/media.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/media.js")>(
		"../../src/lib/api/media.js",
	);
	return {
		...actual,
		fetchMediaItem: vi.fn(() => Promise.reject(new Error("Not in this test"))),
		uploadMedia: vi.fn(),
	};
});

const BODY = { slug: "body", type: "portableText" } as const;
const PLUGIN_BLOCKS: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.hero",
		pluginId: "test-blocks",
		label: "Test Hero",
		fields: [{ type: "text_input", action_id: "heading", label: "Heading" }],
	},
];
const PLUGIN_TYPES = new Set(PLUGIN_BLOCKS.map((block) => block.type));

const block = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text, marks: [] }],
	...extra,
});
const item = (key: string, text: string, level = 1) =>
	block(key, text, { listItem: "bullet", level });

let sessions: TestSession[] = [];
let peerEditors: HeadlessEditor[] = [];
let unmounts: Array<() => Promise<void>> = [];

beforeEach(resetTransportHealth);
afterEach(async () => {
	// oxlint-disable-next-line no-await-in-loop -- React's act() calls must not overlap
	for (const unmount of unmounts) await unmount();
	for (const editor of peerEditors) editor.destroy();
	for (const { session } of sessions) session.dispose();
	unmounts = [];
	peerEditors = [];
	sessions = [];
	resetTransportHealth();
	vi.mocked(uploadMedia).mockReset();
});

/** A room holding `value` in the body field, written as the server writes it. */
function roomWith(value: unknown[]) {
	return new LoopbackRoom({
		seed: (doc) =>
			prosemirrorJSONToYXmlFragment(
				editorSchema(),
				portableTextToProsemirror(value as PortableTextBlock[], PLUGIN_TYPES),
				doc.getXmlFragment(fragmentName(BODY.slug)),
			),
	});
}

async function join(room: LoopbackRoom, richTextFields?: readonly string[]) {
	const session = startSession(room, {}, richTextFields);
	sessions.push(session);
	await settle();
	const view = session.view();
	if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
	const socket = room.sockets.at(-1)!;
	return Object.assign(session, {
		editing: view.room,
		/** Updates this client sent to the room. */
		sentUpdates: () => socket.received.filter((message) => message.type === "sync-update").length,
	});
}

async function mount(
	editing: RoomEditing,
	props: Partial<PortableTextEditorProps> = {},
): Promise<{ editor: Editor; screen: Awaited<ReturnType<typeof render>> }> {
	let editor: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			collaboration={editing.richText(BODY.slug)}
			pluginBlocks={PLUGIN_BLOCKS}
			onEditorReady={(instance) => {
				editor ??= instance;
			}}
			{...props}
		/>,
	);
	unmounts.push(() => screen.unmount());
	await vi.waitFor(() => expect(editor).toBeTruthy());
	await settle();
	return { editor: editor!, screen };
}

/** Another client typing in the room, on a document wired straight to it. */
function peer(room: LoopbackRoom): HeadlessEditor {
	const doc = room.peer();
	const editor = new HeadlessEditor({
		extensions: [
			...portableTextExtensions(),
			PortableTextFilledDefaults,
			PortableTextYSync,
			Extension.create({
				name: "peerSync",
				addProseMirrorPlugins: () => [ySyncPlugin(doc.getXmlFragment(fragmentName(BODY.slug)))],
			}),
		],
	});
	peerEditors.push(editor);
	return editor;
}

/** The room writes a merge into the body, as it does after an outside save. */
function merge(room: LoopbackRoom, change: (blocks: PortableTextBlock[]) => PortableTextBlock[]) {
	const current = readField(room.doc, BODY) as PortableTextBlock[];
	expect(writeField(room.doc, BODY, change(current), [...PLUGIN_TYPES], "merge")).toBe(true);
}

const portableText = (editor: Editor) => prosemirrorToPortableText(editor.getJSON() as never);
const texts = (editor: Editor) => {
	const result: string[] = [];
	editor.state.doc.forEach((node) => result.push(node.textContent));
	return result;
};

function textEnd(editor: { state: Editor["state"] }, text: string): number {
	let found = -1;
	editor.state.doc.descendants((node, pos) => {
		if (found === -1 && node.isTextblock && node.textContent === text) {
			found = pos + 1 + node.content.size;
		}
	});
	expect(found, text).toBeGreaterThan(-1);
	return found;
}

/** Starts a new undo step, as a pause in typing does. */
function pause(editor: Editor) {
	yUndoPluginKey.getState(editor.state).undoManager.stopCapturing();
}

describe("a rich-text editor bound to a room", () => {
	it("sends no update when it opens an entry or renders a merge or a peer's edit", async () => {
		const value = [
			block("k-title", "Title", { style: "h2" }),
			block("k-intro", "Intro"),
			item("k-one", "One"),
			item("k-two", "Two"),
			block("k-quote", "Quoted", { style: "blockquote" }),
			{ _type: "test.hero", heading: "Hero" },
			{ _type: "code", _key: "k-code", code: "let x = 1;", language: "js" },
		];
		const room = roomWith(value);
		const a = await join(room);
		const onChange = vi.fn();
		const { editor } = await mount(a.editing, { value: [], onChange });
		const opened = portableText(editor);
		/** A selection change makes y-tiptap write whatever the editor holds that the room doesn't. */
		const expectNoWrite = async (step: string) => {
			editor.view.dispatch(editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)));
			await settle();
			expect(a.sentUpdates(), step).toBe(0);
			expect(portableText(editor), step).toEqual(readField(room.doc, BODY));
		};

		expect(opened).toEqual(readField(room.doc, BODY));
		expect(texts(editor)).toEqual(["Title", "Intro", "OneTwo", "Quoted", "", "let x = 1;", ""]);
		await expectNoWrite("open");

		merge(room, (blocks) => [
			...blocks.slice(0, 2),
			{ ...blocks[2]!, children: [{ _type: "span", _key: "k-one-s", text: "One merged" }] },
			item("k-nested", "Nested", 2),
			...blocks.slice(3),
			block("k-added", "Added by a merge"),
		]);
		await settle();
		expect(texts(editor)).toContain("Added by a merge");
		await expectNoWrite("merge");

		const other = peer(room);
		other.chain().setTextSelection(textEnd(other, "Intro")).insertContent(" more").run();
		await settle();
		expect(texts(editor)).toContain("Intro more");
		await expectNoWrite("peer");
		expect(onChange).not.toHaveBeenCalled();
	});

	it("records itself with the replica while it's mounted", async () => {
		const room = roomWith([block("k-a", "Alpha")]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		expect(a.editing.richText(BODY.slug)).toBe(a.editing.richText(BODY.slug));

		await vi.waitFor(() => expect(a.replica().editors.get(BODY.slug)).toBe(editor));
		await screen.unmount();
		await vi.waitFor(() => expect(a.replica().editors.has(BODY.slug)).toBe(false));
	});

	it("undoes only its own edits, keeping a peer's and a merge's", async () => {
		const room = roomWith([block("k-a", "Alpha"), block("k-b", "Beta"), block("k-c", "Gamma")]);
		const a = await join(room);
		const { editor } = await mount(a.editing);

		editor.view.dispatch(editor.state.tr.insertText(" mine", textEnd(editor, "Alpha")));
		await settle();
		expect(a.sentUpdates()).toBeGreaterThan(0);
		const other = peer(room);
		other.chain().setTextSelection(textEnd(other, "Beta")).insertContent(" theirs").run();
		merge(room, (blocks) =>
			blocks.map((each) =>
				each._key === "k-c"
					? { ...each, children: [{ _type: "span", _key: "k-c-s", text: "Gamma merged" }] }
					: each,
			),
		);
		await settle();
		expect(texts(editor)).toEqual(["Alpha mine", "Beta theirs", "Gamma merged"]);

		expect(editor.commands.undo()).toBe(true);

		expect(texts(editor)).toEqual(["Alpha", "Beta theirs", "Gamma merged"]);
		expect(editor.can().undo()).toBe(false);
		await settle();
		expect(readField(room.doc, BODY)).toEqual(portableText(editor));
	});

	it("gives back keys and the shapes its normalizers made when it undoes and redoes", async () => {
		const room = roomWith([
			block("k-intro", "Intro"),
			item("k-one", "One"),
			block("k-outro", "Outro"),
		]);
		const a = await join(room);
		const { editor } = await mount(a.editing);
		const opened = portableText(editor);

		editor
			.chain()
			.setTextSelection(textEnd(editor, "Intro") - 2)
			.splitBlock()
			.run();
		const split = portableText(editor);
		pause(editor);
		const list = editor.state.doc.child(2);
		expect(list.type.name).toBe("bulletList");
		const listPos = editor.state.doc.child(0).nodeSize + editor.state.doc.child(1).nodeSize;
		// Deleting the only item leaves an empty list, which the normalizers remove.
		editor.view.dispatch(editor.state.tr.delete(listPos + 1, listPos + list.nodeSize - 1));
		const emptied = portableText(editor);

		const keys = (blocks: PortableTextBlock[]) => blocks.map((each) => each._key);
		expect(keys(split)).toEqual(["k-intro", expect.any(String), "k-one", "k-outro"]);
		expect(new Set(keys(split)).size).toBe(4);
		expect(keys(emptied)).toEqual(keys(split).filter((key) => key !== "k-one"));
		expect(editor.state.doc.childCount).toBe(3);

		expect(editor.commands.undo()).toBe(true);
		expect(portableText(editor)).toEqual(split);
		expect(editor.commands.undo()).toBe(true);
		expect(portableText(editor)).toEqual(opened);
		expect(editor.commands.redo()).toBe(true);
		expect(portableText(editor)).toEqual(split);
		expect(editor.commands.redo()).toBe(true);
		expect(portableText(editor)).toEqual(emptied);
		expect(editor.state.doc.childCount).toBe(3);
		await settle();
		expect(readField(room.doc, BODY)).toEqual(emptied);
		expect(readField(a.replica().doc, BODY)).toEqual(emptied);
	});

	it("keeps the insert button's slash line out of the undo history", async () => {
		const room = roomWith([]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		editor.chain().focus().insertContent("First").run();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await slashMenu();
		expect(texts(editor)).toEqual(["First", "/"]);
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => expect(slashMenuElement()).toBeNull());

		expect(texts(editor)).toEqual(["First"]);
		expect(editor.commands.undo()).toBe(true);
		expect(texts(editor)).toEqual([""]);
	});

	it("keeps an upload that lands while the insert button's slash menu is open", async () => {
		const room = roomWith([block("k-intro", "Intro")]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		editor.commands.focus();
		const insert = screen.getByRole("button", { name: "Test gutter insert" }).element();
		// Within the undo manager's capture window, which joins local changes by time alone.
		(insert as HTMLButtonElement).click();
		const uploaded = editor.schema.nodes.paragraph!.create(null, editor.schema.text("Uploaded"));
		editor.view.dispatch(editor.state.tr.insert(0, uploaded));
		await slashMenu();
		expect(texts(editor)).toEqual(["Uploaded", "Intro", "/"]);
		await userEvent.keyboard("{Escape}");

		await vi.waitFor(() => expect(slashMenuElement()).toBeNull());
		expect(texts(editor)).toEqual(["Uploaded", "Intro"]);
	});

	it("takes the insert button's slash line back out after a peer's edit above it", async () => {
		const room = roomWith([block("k-intro", "Intro")]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		editor.commands.focus();
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		await slashMenu();

		const other = peer(room);
		other
			.chain()
			.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Peer" }] })
			.run();
		await settle();
		expect(texts(editor)).toEqual(["Peer", "Intro", "/"]);
		await userEvent.keyboard("{Escape}");

		await vi.waitFor(() => expect(slashMenuElement()).toBeNull());
		expect(texts(editor)).toEqual(["Peer", "Intro"]);
	});

	it("keeps a dismissed slash menu closed through a peer's edit above it", async () => {
		const room = roomWith([block("k-intro", "Intro"), block("k-empty", "")]);
		const a = await join(room);
		const { editor } = await mount(a.editing);
		editor
			.chain()
			.focus()
			.setTextSelection(textEnd(editor, "Intro") + 2)
			.run();
		editor.commands.insertContent("/hea");
		await slashMenu();
		await userEvent.keyboard("{Escape}");
		await vi.waitFor(() => expect(slashMenuElement()).toBeNull());

		const other = peer(room);
		other
			.chain()
			.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Peer" }] })
			.run();
		await settle();
		expect(texts(editor)).toEqual(["Peer", "Intro", "/hea"]);

		expect(SuggestionPluginKey.getState(editor.state)?.active).toBe(false);
		expect(slashMenuElement()).toBeNull();
	});

	it("turns an empty line into the chosen block from the insert button, in one undo step", async () => {
		const room = roomWith([]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		editor.chain().focus().insertContent("First").run();
		pause(editor);
		const { tr, schema } = editor.state;
		editor.view.dispatch(tr.insert(tr.doc.content.size, schema.nodes.paragraph!.create()));

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await slashMenu();
		expect(texts(editor)).toEqual(["First", "/"]);
		[...menu.querySelectorAll<HTMLElement>("button[data-index]")]
			.find(
				(button) => button.querySelector("[data-slash-item-title]")?.textContent === "Heading 1",
			)
			?.click();
		await vi.waitFor(() => expect(slashMenuElement()).toBeNull());

		expect(editor.state.doc.child(1).type.name).toBe("heading");
		expect(editor.commands.undo()).toBe(true);
		expect(texts(editor)).toEqual(["First", ""]);
		expect(editor.state.doc.child(1).type.name).toBe("paragraph");
		expect(editor.commands.undo()).toBe(true);
		expect(texts(editor)).toEqual(["First"]);
	});

	it("keeps an inserted table in the undo history", async () => {
		const room = roomWith([block("k-intro", "Intro")]);
		const a = await join(room);
		const { editor } = await mount(a.editing);
		editor.commands.setTextSelection(textEnd(editor, "Intro"));

		expect(insertTable(editor, 2, 2, true)).toBe(true);
		expect(editor.state.doc.child(1).type.name).toBe("table");

		expect(editor.commands.undo()).toBe(true);
		expect(texts(editor)).toEqual(["Intro"]);
	});

	it("saves the plugin block modal after a peer's keystroke, to a block stored without a key", async () => {
		const room = roomWith([block("k-intro", "Intro"), { _type: "test.hero", heading: "Before" }]);
		const a = await join(room);
		const { editor, screen } = await mount(a.editing);
		await screen.getByRole("button", { name: "Edit" }).click();
		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeVisible();

		const other = peer(room);
		other.chain().setTextSelection(textEnd(other, "Intro")).insertContent("!").run();
		await settle();
		expect(texts(editor)[0]).toBe("Intro!");
		await dialog.getByRole("textbox").fill("After");
		dialog.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		const hero = editor.state.doc.child(1);
		expect(hero.attrs.data).toEqual({ heading: "After" });
		await settle();
		expect(readField(room.doc, BODY)).toEqual([
			expect.objectContaining({ _key: "k-intro" }),
			{ _type: "test.hero", _key: hero.attrs.emdashPortableTextKey, heading: "After" },
		]);
	});

	it("keeps an upload's placeholder in place through a peer's edit above it", async () => {
		let finish: (item: unknown) => void = () => {};
		vi.mocked(uploadMedia).mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		const room = roomWith([block("k-a", "Alpha"), block("k-b", "Beta")]);
		const a = await join(room);
		const { editor } = await mount(a.editing);
		const alpha = editor.view.dom.querySelector("p")!;
		const files = new DataTransfer();
		files.items.add(new File([new Uint8Array(16)], "photo.png", { type: "image/png" }));
		const { right, top, height } = alpha.getBoundingClientRect();
		alpha.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: files,
				clientX: right - 2,
				clientY: top + height / 2,
			}),
		);
		await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledTimes(1));

		const other = peer(room);
		other
			.chain()
			.insertContentAt(0, { type: "paragraph", content: [{ type: "text", text: "Peer" }] })
			.run();
		other.chain().setTextSelection(textEnd(other, "Alpha")).insertContent(" more").run();
		await settle();
		expect(texts(editor)).toEqual(["Peer", "Alpha more", "Beta"]);
		finish({
			id: "01IMAGE",
			filename: "photo.png",
			mimeType: "image/png",
			url: "https://example.com/photo.png",
			storageKey: "photo.png",
			size: 16,
			width: 10,
			height: 10,
			createdAt: "2026-11-06T00:00:00.000Z",
		});

		await vi.waitFor(() => expect(editor.state.doc.childCount).toBe(4));
		const types: string[] = [];
		editor.state.doc.forEach((node) => types.push(node.type.name));
		expect(types).toEqual(["paragraph", "paragraph", "image", "paragraph"]);
		expect(texts(editor)[3]).toBe("Beta");
	});

	it("draws another person's cursor with their name", async () => {
		const room = roomWith([block("k-a", "Alpha")]);
		const a = await join(room);
		const b = await join(room);
		const { editor: mine } = await mount(a.editing);
		const { editor: theirs } = await mount(b.editing);

		mine.chain().focus().setTextSelection(textEnd(mine, "Alpha")).run();

		const name = `User ${a.replica().awareness.clientID}`;
		await vi.waitFor(() =>
			expect(theirs.view.dom.querySelector(".emdash-remote-caret")?.textContent).toContain(name),
		);
		expect(mine.view.dom.querySelector(".emdash-remote-caret")).toBeNull();
	});

	it("leaves out the single-editor undo history and keeps the editor's paste and divider rules", async () => {
		const room = roomWith([
			block("k-intro", "Intro"),
			block("k-empty", ""),
			item("k-item", "Item"),
		]);
		const a = await join(room);
		const { editor } = await mount(a.editing);
		const names = editor.extensionManager.extensions.map((extension) => extension.name);
		expect(names).toContain("collaboration");
		expect(names).not.toContain("undoRedo");

		editor.commands.setTextSelection(textEnd(editor, "Intro") + 2);
		const clipboardData = {
			files: [],
			items: [],
			types: ["text/html", "text/plain"],
			getData: (type: string) =>
				type === "text/html" ? "<blockquote><h3>Heading</h3><p>one</p></blockquote>" : "",
		};
		const paste = new Event("paste", { bubbles: true, cancelable: true });
		Object.defineProperty(paste, "clipboardData", { value: clipboardData });
		editor.view.dom.dispatchEvent(paste);
		await vi.waitFor(() => expect(texts(editor)).toContain("Heading"));
		expect(portableText(editor).map((each) => [each.listItem ?? each.style, each._key])).toEqual([
			["normal", "k-intro"],
			["h3", expect.any(String)],
			["blockquote", expect.any(String)],
			["bullet", "k-item"],
		]);

		editor
			.chain()
			.focus()
			.setTextSelection(textEnd(editor, "Item"))
			.splitListItem("listItem")
			.run();
		for (const char of "---") {
			const { from, to } = editor.state.selection;
			const insertText = () => editor.state.tr.insertText(char, from, to);
			const handled = editor.view.someProp("handleTextInput", (handler) =>
				handler(editor.view, from, to, char, insertText),
			);
			if (!handled) editor.view.dispatch(insertText());
		}
		const blocks: string[] = [];
		editor.state.doc.forEach((node) => blocks.push(node.type.name));
		expect(blocks).toEqual([
			"paragraph",
			"heading",
			"blockquote",
			"bulletList",
			"horizontalRule",
			"paragraph",
		]);
		expect(editor.state.doc.child(3).childCount).toBe(1);
	});
});

describe("an editor-draft patch in a room", () => {
	const SUMMARY = { slug: "summary", type: "portableText" } as const;

	function roomWithFields() {
		return new LoopbackRoom({
			seed: (doc) => {
				for (const [field, value] of [
					[BODY, [block("k-a", "Alpha"), block("k-b", "Beta")]],
					[SUMMARY, [block("k-s", "Short")]],
				] as const) {
					prosemirrorJSONToYXmlFragment(
						editorSchema(),
						portableTextToProsemirror(value, PLUGIN_TYPES),
						doc.getXmlFragment(fragmentName(field.slug)),
					);
				}
				doc.getMap("fields").set("title", "Title");
			},
		});
	}

	it("lands in one transaction, which each rich-text editor undoes in one step", async () => {
		const room = roomWithFields();
		const a = await join(room, [BODY.slug, SUMMARY.slug]);
		const { editor: body } = await mount(a.editing);
		const { editor: summary } = await mount(a.editing, {
			collaboration: a.editing.richText(SUMMARY.slug),
		});
		// Typing right before the patch, inside the undo manager's capture window.
		body.view.dispatch(body.state.tr.insertText(" mine", textEnd(body, "Alpha")));
		const transactions: unknown[] = [];
		a.replica().doc.on("afterTransaction", (transaction: { origin: unknown }) =>
			transactions.push(transaction.origin),
		);

		expect(
			a.editing.applyPatch({
				body: [block("k-a", "Alpha mine"), block("k-p", "Patched")],
				summary: [block("k-s", "A longer summary")],
				title: "Patched title",
			}),
		).toBe(true);
		expect(transactions).toEqual([ySyncPluginKey]);
		expect(texts(body)).toEqual(["Alpha mine", "Patched"]);
		expect(texts(summary)).toEqual(["A longer summary"]);
		expect(a.editing.fields.get("title")).toBe("Patched title");

		// The binding maps the patched blocks, so an edit in one lands in that block of the fragment.
		body.view.dispatch(body.state.tr.insertText("!", textEnd(body, "Patched")));
		await settle();
		expect(readField(room.doc, BODY)).toEqual(portableText(body));
		expect(texts(body)).toEqual(["Alpha mine", "Patched!"]);

		expect(body.commands.undo()).toBe(true);
		expect(texts(body)).toEqual(["Alpha mine", "Patched"]);
		expect(body.commands.undo()).toBe(true);
		expect(texts(body)).toEqual(["Alpha mine", "Beta"]);
		expect(texts(summary)).toEqual(["A longer summary"]);
		expect(body.commands.undo()).toBe(true);
		expect(texts(body)).toEqual(["Alpha", "Beta"]);
		expect(body.can().undo()).toBe(false);

		expect(summary.commands.undo()).toBe(true);
		expect(texts(summary)).toEqual(["Short"]);
		expect(summary.can().undo()).toBe(false);
		await settle();
		expect(readField(room.doc, BODY)).toEqual(portableText(body));
		expect(readField(room.doc, SUMMARY)).toEqual(portableText(summary));
	});

	it("writes nothing when its rich text has marks the editor can't represent", async () => {
		const room = roomWithFields();
		const a = await join(room, [BODY.slug, SUMMARY.slug]);
		const { editor } = await mount(a.editing);
		const unsupported = {
			...block("k-a", "Alpha"),
			children: [{ _type: "span", _key: "k-a-s", text: "Alpha", marks: ["glow"] }],
		};

		expect(a.editing.applyPatch({ title: "Patched title", body: [unsupported] })).toBe(false);
		await settle();
		expect(a.editing.fields.get("title")).toBe("Title");
		expect(texts(editor)).toEqual(["Alpha", "Beta"]);
		expect(a.sentUpdates()).toBe(0);
	});
});

function slashMenuElement(): HTMLElement | null {
	return document.querySelector<HTMLElement>("[data-slash-command-menu]");
}

async function slashMenu(): Promise<HTMLElement> {
	return vi.waitFor(() => {
		const menu = slashMenuElement();
		expect(menu).toBeTruthy();
		return menu!;
	});
}
