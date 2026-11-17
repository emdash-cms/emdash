/**
 * Block keys through the full editor: a block keeps its key from save to save
 * while blocks are added, split, pasted and copied around it, and no two
 * blocks share one.
 */

import { Plugin } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	_prosemirrorToPortableText as prosemirrorToPortableText,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { ownsPortableTextKey } from "../../src/portable-text/keys";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Block = {
	_type: string;
	_key: string;
	style?: string;
	listItem?: string;
	children?: Array<{ _key: string; text: string }>;
};

const textOf = (block: Block) => block.children?.map((child) => child.text).join("") ?? "";

async function renderEditor(value: PortableTextEditorProps["value"] = []) {
	let editor: Editor | null = null;
	const changes: Block[][] = [];
	await render(
		<PortableTextEditor
			value={value}
			onEditorReady={(instance) => {
				editor = instance;
			}}
			onChange={(blocks) => changes.push(blocks as Block[])}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	return { editor: editor!, changes };
}

async function focus(editor: Editor, position: number | "end") {
	editor.commands.focus(position);
	await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
}

function startOf(editor: Editor, text: string): number {
	let position = -1;
	editor.state.doc.descendants((node, pos) => {
		if (position === -1 && node.isTextblock && node.textContent === text) position = pos + 1;
	});
	return position;
}

/** The keys of the nodes that own one, which are present and unique. */
function documentKeys(editor: Editor): string[] {
	const keys: unknown[] = [];
	const { doc } = editor.state;
	doc.descendants((node, pos, parent) => {
		const trailing = pos + node.nodeSize === doc.content.size && node.content.size === 0;
		if (ownsPortableTextKey(node, parent) && !trailing) {
			keys.push(node.attrs.emdashPortableTextKey);
		}
	});
	expect(keys.every((key) => typeof key === "string" && key.length > 0)).toBe(true);
	expect(new Set(keys).size).toBe(keys.length);
	return keys as string[];
}

/** The saved Portable Text once it holds blocks with these texts, which have keys of their own. */
function saved(editor: Editor, changes: Block[][], texts: string[]): Promise<Block[]> {
	return vi.waitFor(() => {
		const blocks = changes.at(-1) ?? [];
		expect(blocks.map(textOf)).toEqual(texts);
		const keys = blocks.map((block) => block._key);
		expect(new Set(keys).size).toBe(keys.length);
		documentKeys(editor);
		return blocks;
	});
}

describe("Portable Text block keys", () => {
	it("keeps every block's key from save to save", async () => {
		const { editor, changes } = await renderEditor();
		await focus(editor, "end");

		await userEvent.keyboard("First");
		let blocks = await saved(editor, changes, ["First"]);
		const first = blocks[0]!;

		await userEvent.keyboard("{Enter}Second");
		blocks = await saved(editor, changes, ["First", "Second"]);
		expect(blocks[0]).toEqual(first);
		const second = blocks[1]!._key;

		await userEvent.keyboard("{Enter}- Item");
		blocks = await saved(editor, changes, ["First", "Second", "Item"]);
		expect(blocks.map((block) => block._key).slice(0, 2)).toEqual([first._key, second]);
		expect(blocks[2]!.listItem).toBe("bullet");
		const item = blocks[2]!._key;

		await focus(editor, startOf(editor, "Second") + 3);
		await userEvent.keyboard("{Enter}");
		blocks = await saved(editor, changes, ["First", "Sec", "ond", "Item"]);
		expect(blocks.map((block) => block._key)).toEqual([first._key, second, blocks[2]!._key, item]);
		const secondHalf = blocks[2]!._key;

		await focus(editor, startOf(editor, "First"));
		await userEvent.keyboard("{Enter}");
		blocks = await saved(editor, changes, ["", "First", "Sec", "ond", "Item"]);
		expect(blocks.slice(1).map((block) => block._key)).toEqual([
			first._key,
			second,
			secondHalf,
			item,
		]);
		expect(blocks[1]).toEqual(first);

		const secStart = startOf(editor, "Sec") - 1;
		const copied = editor.state.doc.slice(
			secStart,
			secStart + editor.state.doc.nodeAt(secStart)!.nodeSize,
		);
		const { dom } = editor.view.serializeForClipboard(copied);
		await focus(editor, startOf(editor, "ond") + 3);
		const clipboardData = new DataTransfer();
		clipboardData.setData("text/html", dom.innerHTML);
		editor.view.dom.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
		);
		blocks = await saved(editor, changes, ["", "First", "Sec", "ond", "Sec", "Item"]);
		expect(blocks.slice(1, 4).map((block) => block._key)).toEqual([first._key, second, secondHalf]);
		expect(blocks[5]!._key).toBe(item);

		// A copy that keeps the block's key, as dragging a copy does, gets a key of its own.
		const firstNode = editor.state.doc.nodeAt(startOf(editor, "First") - 1)!;
		const listPosition = startOf(editor, "Item") - 3;
		editor.view.dispatch(editor.state.tr.insert(listPosition, firstNode));
		blocks = await saved(editor, changes, ["", "First", "Sec", "ond", "Sec", "First", "Item"]);
		expect(blocks[1]).toEqual(first);
		const keys = blocks.map((block) => block._key);

		await focus(editor, startOf(editor, "Item") + 4);
		await userEvent.keyboard("!");
		blocks = await saved(editor, changes, ["", "First", "Sec", "ond", "Sec", "First", "Item!"]);
		expect(blocks.map((block) => block._key)).toEqual(keys);
		expect(prosemirrorToPortableText(editor.getJSON())).toEqual(blocks);
	});

	it("gives a block loaded without a key one when it is edited", async () => {
		const { editor, changes } = await renderEditor([
			{
				_type: "block",
				style: "normal",
				children: [{ _type: "span", _key: "loaded-span", text: "Loaded" }],
			} as unknown as NonNullable<PortableTextEditorProps["value"]>[number],
		]);

		await focus(editor, "end");
		await userEvent.keyboard("!");
		const [loaded] = await saved(editor, changes, ["Loaded!"]);

		await focus(editor, 1);
		await userEvent.keyboard("{Enter}");
		const blocks = await saved(editor, changes, ["", "Loaded!"]);
		expect(blocks[1]).toEqual(loaded);
	});

	it("keys a block typed with an input method once the composition ends", async () => {
		const { editor, changes } = await renderEditor();
		await focus(editor, "end");

		const session = cdp();
		await session.send("Input.imeSetComposition", {
			text: "n",
			selectionStart: 1,
			selectionEnd: 1,
		});
		await session.send("Input.imeSetComposition", {
			text: "に",
			selectionStart: 1,
			selectionEnd: 1,
		});
		await session.send("Input.insertText", { text: "日本" });
		const [typed] = await saved(editor, changes, ["日本"]);

		await focus(editor, 1);
		await userEvent.keyboard("{Enter}");
		const blocks = await saved(editor, changes, ["", "日本"]);
		expect(blocks[1]).toEqual(typed);
	});

	it("keeps a block's key when it is quoted and when its quote is split at the start", async () => {
		const block = (key: string, text: string, style = "normal") => ({
			_type: "block",
			_key: key,
			style,
			children: [{ _type: "span", _key: `${key}-span`, text }],
		});
		const { editor, changes } = await renderEditor([
			block("hello", "Hello"),
			block("between", "Between"),
			block("quote", "Quoted", "blockquote"),
		]);

		await focus(editor, startOf(editor, "Hello") + 2);
		editor.commands.toggleBlockquote();
		let blocks = await saved(editor, changes, ["Hello", "Between", "Quoted"]);
		expect(blocks.map(({ _key, style }) => [_key, style])).toEqual([
			["hello", "blockquote"],
			["between", "normal"],
			["quote", "blockquote"],
		]);

		await focus(editor, startOf(editor, "Quoted"));
		await userEvent.keyboard("{Enter}");
		blocks = await saved(editor, changes, ["Hello", "Between", "", "Quoted"]);
		expect(blocks[3]!._key).toBe("quote");
	});

	it("leaves an opened document unchanged when the empty last line is added", async () => {
		const { editor, changes } = await renderEditor([
			{
				_type: "block",
				_key: "intro",
				style: "normal",
				children: [{ _type: "span", _key: "intro-span", text: "Intro" }],
			},
			{ _type: "break", _key: "rule", style: "lineBreak" },
		]);

		editor.commands.setTextSelection(1);

		expect(editor.state.doc.lastChild?.type.name).toBe("paragraph");
		expect(editor.state.doc.childCount).toBe(3);
		expect(changes).toEqual([]);
	});

	it("settles when every line of an empty document is selected and restyled", async () => {
		const line = (key: string) => ({
			_type: "block",
			_key: key,
			style: "normal",
			children: [{ _type: "span", _key: `${key}-span`, text: "" }],
		});
		const { editor } = await renderEditor([line("one"), line("two")]);
		let rounds = 0;
		editor.registerPlugin(
			new Plugin({
				appendTransaction() {
					if (++rounds > 50) throw new Error("The editor's normalizers never settle");
					return null;
				},
			}),
		);
		editor.commands.setTextSelection({ from: 1, to: editor.state.doc.content.size - 1 });

		rounds = 0;
		editor.commands.setParagraph();

		expect(editor.state.doc.toJSON().content.map((node: { type: string }) => node.type)).toEqual([
			"paragraph",
			"paragraph",
		]);
		documentKeys(editor);
	});

	it("doesn't save a last line that was typed in and emptied again", async () => {
		const { editor, changes } = await renderEditor();
		await focus(editor, "end");

		await userEvent.keyboard("First{Enter}x");
		await saved(editor, changes, ["First", "x"]);

		await userEvent.keyboard("{Backspace}");
		await saved(editor, changes, ["First"]);
	});
});
