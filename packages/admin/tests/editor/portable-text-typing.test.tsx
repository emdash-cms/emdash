/**
 * Lists, list items, quotes and cells may be empty, so that merges stay valid,
 * and typing still gives the documents it gave when they couldn't be: the
 * editor refills or removes what its own edits leave empty. What another
 * client's edit leaves empty stays as it is.
 */

import type { JSONContent } from "@tiptap/core";
import type { Editor } from "@tiptap/react";
import { ySyncPluginKey } from "@tiptap/y-tiptap";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import type { Section } from "../../src/lib/api";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
const sectionPicker = vi.hoisted(() => ({ select: null as ((section: Section) => void) | null }));
vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: ({ onSelect }: { onSelect: (section: Section) => void }) => {
		sectionPicker.select = onSelect;
		return null;
	},
}));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Value = NonNullable<PortableTextEditorProps["value"]>;

const block = (key: string, text: string, extra: Record<string, unknown> = {}) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-s`, text }],
	...extra,
});
const item = (key: string, text: string, level = 1, listItem = "bullet") =>
	block(key, text, { listItem, level });

async function renderEditor(value: unknown[]) {
	let editor: Editor | null = null;
	await render(
		<PortableTextEditor
			value={value as Value}
			onEditorReady={(instance) => {
				editor = instance;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	return editor!;
}

async function focus(editor: Editor, position: number) {
	editor.commands.focus(position);
	await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
}

function textPosition(editor: Editor, text: string, edge: "start" | "end"): number {
	let position = -1;
	editor.state.doc.descendants((node, pos) => {
		if (position !== -1 || !node.isTextblock || node.textContent !== text) return;
		position = edge === "start" ? pos + 1 : pos + 1 + node.content.size;
	});
	expect(position).toBeGreaterThan(-1);
	return position;
}

const SHORT_NAMES: Record<string, string> = {
	paragraph: "p",
	listItem: "li",
	bulletList: "ul",
	orderedList: "ol",
	blockquote: "quote",
	heading: "h",
	tableRow: "tr",
	tableCell: "td",
	tableHeader: "th",
	hardBreak: "br",
};
const KEY_ATTRS = ["emdashPortableTextKey", "emdashKey"];

/**
 * The document and the selection, as `type#key{attrs}(children)@from-to`.
 * Keys and list ids the editor generated show as `new`.
 */
function outline(editor: Editor): string {
	const mask = (name: string, value: unknown) =>
		[...KEY_ATTRS, "listId"].includes(name) && typeof value === "string" && !value.startsWith("k-")
			? "new"
			: value;
	const attrs = (values: Record<string, unknown> | undefined, skip: string[] = []) => {
		const shown = Object.entries(values ?? {})
			.filter(
				([name, value]) =>
					!skip.includes(name) &&
					value !== null &&
					value !== undefined &&
					!(Array.isArray(value) && value.length === 0),
			)
			.map(([name, value]) => {
				const masked = mask(name, value);
				return `${name}=${typeof masked === "string" ? masked : JSON.stringify(masked)}`;
			});
		return shown.length > 0 ? `{${shown.join(" ")}}` : "";
	};
	const line = (node: JSONContent): string => {
		if (node.type === "text") {
			const marks = (node.marks ?? []).map((mark) =>
				mark.type === "emdashPortableTextSpan"
					? `~${String(mark.attrs?.key)}${attrs(mark.attrs, ["key"])}`
					: `+${mark.type}${attrs(mark.attrs)}`,
			);
			return JSON.stringify(node.text) + marks.join("");
		}
		let out = SHORT_NAMES[node.type!] ?? node.type!;
		for (const name of KEY_ATTRS) {
			if (node.attrs?.[name] != null) out += `#${String(mask(name, node.attrs[name]))}`;
		}
		out += attrs(node.attrs, KEY_ATTRS);
		if (node.content) out += `(${node.content.map(line).join(", ")})`;
		return out;
	};
	const { from, to } = editor.state.selection;
	return `${line(editor.getJSON())}@${from === to ? from : `${from}-${to}`}`;
}

function expectShape(editor: Editor, expected: string, name?: string) {
	expect(outline(editor), name).toBe(expected);
}

describe("typing", () => {
	it("Enter splits a paragraph", async () => {
		const editor = await renderEditor([block("k-p", "Hello world")]);
		await focus(editor, textPosition(editor, "Hello world", "start") + 5);
		await userEvent.keyboard("{Enter}");
		expectShape(editor, 'doc(p#k-p("Hello"~k-p-s), p#new(" world"~k-p-s))@8');
	});

	it("keeps bold on the line Enter starts, before another line", async () => {
		const editor = await renderEditor([block("k-p", "Hello"), block("k-q", "After")]);
		await focus(editor, textPosition(editor, "Hello", "end"));
		editor.commands.toggleBold();
		await userEvent.keyboard("B{Enter}C");
		expectShape(
			editor,
			'doc(p#k-p("Hello"~k-p-s, "B"+bold), p#new("C"+bold), p#k-q("After"~k-q-s))@10',
		);
	});

	it("keeps bold on the line Enter starts at the end", async () => {
		const editor = await renderEditor([block("k-p", "Hello")]);
		await focus(editor, textPosition(editor, "Hello", "end"));
		editor.commands.toggleBold();
		await userEvent.keyboard("B{Enter}C");
		expectShape(editor, 'doc(p#k-p("Hello"~k-p-s, "B"+bold), p#new("C"+bold))@10');
	});

	it("Enter adds a list item, and again leaves the list", async () => {
		const editor = await renderEditor([item("k-a", "One"), item("k-b", "Two")]);
		await focus(editor, textPosition(editor, "One", "end"));
		await userEvent.keyboard("{Enter}");
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s)), li(p#new), li(p#k-b("Two"~k-b-s))), p)@10');
		await userEvent.keyboard("{Enter}");
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s))), p#new, ul(li(p#k-b("Two"~k-b-s))), p)@10');
	});

	it("Backspace at the start of a list item lifts it, and again joins it to the item before", async () => {
		const second = await renderEditor([item("k-a", "One"), item("k-b", "Two")]);
		await focus(second, textPosition(second, "Two", "start"));
		await userEvent.keyboard("{Backspace}");
		expectShape(second, 'doc(ul(li(p#k-a("One"~k-a-s))), p#k-b("Two"~k-b-s), p)@10');
		await userEvent.keyboard("{Backspace}");
		expectShape(second, 'doc(ul(li(p#k-a("One"~k-a-s, "Two"~k-b-s))), p)@6');
	});

	it("Backspace at the start of the first list item", async () => {
		const first = await renderEditor([item("k-a", "One"), item("k-b", "Two")]);
		await focus(first, textPosition(first, "One", "start"));
		await userEvent.keyboard("{Backspace}");
		expectShape(first, 'doc(p#k-a("One"~k-a-s), ul(li(p#k-b("Two"~k-b-s))), p)@1');
	});

	it("Backspace at the start of an item that holds a nested list", async () => {
		const editor = await renderEditor([
			item("k-a", "One"),
			item("k-b", "Two"),
			item("k-c", "Three", 2),
		]);
		await focus(editor, textPosition(editor, "Two", "start"));
		await userEvent.keyboard("{Backspace}");
		expectShape(
			editor,
			'doc(ul(li(p#k-a("One"~k-a-s))), p#k-b("Two"~k-b-s), ul(li(p#k-c("Three"~k-c-s))), p)@10',
		);
		await userEvent.keyboard("{Backspace}");
		expectShape(
			editor,
			'doc(ul(li(p#k-a("One"~k-a-s, "Two"~k-b-s))), ul(li(p#k-c("Three"~k-c-s))), p)@6',
		);
	});

	it("Backspace at the start of a nested list item", async () => {
		const editor = await renderEditor([item("k-a", "One"), item("k-b", "Two", 2)]);
		await focus(editor, textPosition(editor, "Two", "start"));
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s))), p)@10');
	});

	it("Tab nests a list item and Shift-Tab lifts it back", async () => {
		const editor = await renderEditor([item("k-a", "One"), item("k-b", "Two")]);
		await focus(editor, textPosition(editor, "Two", "start") + 1);
		await userEvent.keyboard("{Tab}");
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s), ul(li(p#k-b("Two"~k-b-s))))), p)@11');
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s))), p)@11');
	});

	it("Shift-Tab lifts the first item of a nested list", async () => {
		const editor = await renderEditor([
			item("k-a", "One"),
			item("k-b", "Two", 2),
			item("k-c", "Three", 2),
		]);
		await focus(editor, textPosition(editor, "Two", "start"));
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expectShape(
			editor,
			'doc(ul(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s), ul(li(p#k-c("Three"~k-c-s))))), p)@10',
		);
	});

	it("toggles lists", async () => {
		const editor = await renderEditor([block("k-a", "One"), block("k-b", "Two")]);
		await focus(editor, textPosition(editor, "One", "start"));
		editor.commands.setTextSelection({
			from: textPosition(editor, "One", "start"),
			to: textPosition(editor, "Two", "end"),
		});
		editor.commands.toggleBulletList();
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s))), p)@3-13');
		editor.commands.toggleBulletList();
		expectShape(editor, 'doc(p#k-a("One"~k-a-s), p#k-b("Two"~k-b-s), p)@1-9');
		editor.commands.toggleOrderedList();
		expectShape(
			editor,
			'doc(ol{start=1 listId=new listStart=1}(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s))), p)@3-13',
		);
		editor.commands.toggleBulletList();
		expectShape(editor, 'doc(ul(li(p#k-a("One"~k-a-s)), li(p#k-b("Two"~k-b-s))), p)@3-13');
	});

	it("inserts a table and adds a row", async () => {
		const editor = await renderEditor([block("k-a", "Before")]);
		await focus(editor, textPosition(editor, "Before", "end"));
		editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: true });
		expectShape(
			editor,
			'doc(p#k-a("Before"~k-a-s), table#new(tr#new(th#new{colspan=1 rowspan=1}(p), th#new{colspan=1 rowspan=1}(p)), tr#new(td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p))), p)@12',
		);
		editor.commands.addRowAfter();
		expectShape(
			editor,
			'doc(p#k-a("Before"~k-a-s), table#new(tr#new(th#new{colspan=1 rowspan=1}(p), th#new{colspan=1 rowspan=1}(p)), tr#new(td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p)), tr#new(td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p))), p)@12',
		);
		editor.commands.addColumnAfter();
		expectShape(
			editor,
			'doc(p#k-a("Before"~k-a-s), table#new(tr#new(th#new{colspan=1 rowspan=1}(p), th#new{colspan=1 rowspan=1}(p), th#new{colspan=1 rowspan=1}(p)), tr#new(td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p)), tr#new(td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p), td#new{colspan=1 rowspan=1}(p))), p)@12',
		);
	});

	it("deletes across list items", async () => {
		const editor = await renderEditor([
			item("k-a", "One"),
			item("k-b", "Two"),
			item("k-c", "Three"),
		]);
		await focus(editor, textPosition(editor, "One", "start"));
		editor.commands.setTextSelection({
			from: textPosition(editor, "One", "start") + 1,
			to: textPosition(editor, "Three", "start") + 2,
		});
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, 'doc(ul(li(p#k-a("O"~k-a-s, "ree"~k-c-s))), p)@4');
	});

	it("deletes the text of a quote, then the quote", async () => {
		const editor = await renderEditor([
			block("k-a", "Before"),
			block("k-q", "Quoted", { style: "blockquote" }),
		]);
		await focus(editor, textPosition(editor, "Quoted", "start"));
		editor.commands.setTextSelection({
			from: textPosition(editor, "Quoted", "start"),
			to: textPosition(editor, "Quoted", "end"),
		});
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, 'doc(p#k-a("Before"~k-a-s), quote(p#k-q), p)@10');
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, 'doc(p#k-a("Before"~k-a-s), p#k-q, p)@9');
	});

	it("deletes everything", async () => {
		const editor = await renderEditor([
			block("k-h", "Title", { style: "h2" }),
			item("k-a", "One"),
			item("k-b", "Two"),
			item("k-c", "Three", 2),
			block("k-q", "Quoted", { style: "blockquote" }),
			{
				_type: "table",
				_key: "k-t",
				rows: [
					{
						_type: "tableRow",
						_key: "k-r",
						cells: [
							{
								_type: "tableCell",
								_key: "k-c1",
								content: [{ _type: "span", _key: "k-c1s", text: "A" }],
							},
							{
								_type: "tableCell",
								_key: "k-c2",
								content: [{ _type: "span", _key: "k-c2s", text: "B" }],
							},
						],
					},
				],
			},
			block("k-z", "Last"),
		]);
		await focus(editor, textPosition(editor, "Title", "start"));
		editor.commands.selectAll();
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, "doc(p)@1");
		await userEvent.keyboard("x");
		expectShape(editor, 'doc(p#new("x"))@2');
	});

	it("selects from the first to the last letter and deletes", async () => {
		const editor = await renderEditor([
			item("k-a", "One"),
			item("k-b", "Two"),
			block("k-q", "Quoted", { style: "blockquote" }),
		]);
		await focus(editor, textPosition(editor, "One", "start"));
		editor.commands.setTextSelection({
			from: textPosition(editor, "One", "start"),
			to: textPosition(editor, "Quoted", "end"),
		});
		await userEvent.keyboard("{Backspace}");
		expectShape(editor, "doc(ul(li(p#k-a)), p)@3");
	});

	const nested = () =>
		renderEditor([
			block("k-before", "before"),
			item("k-a", "a"),
			item("k-b", "b"),
			item("k-b1", "b1", 2),
			item("k-b2", "b2", 2),
			item("k-c", "c"),
			block("k-after", "after"),
		]);
	const select = (editor: Editor, from: number, to = from) =>
		editor.commands.setTextSelection({ from, to });

	it("edits around a nested list", async () => {
		const cases: Array<[string, string, (editor: Editor) => Promise<void>]> = [
			[
				"nested-backspace-twice-at-b",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s, "b"~k-b-s))), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s))), ul(li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@12',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"));
					await userEvent.keyboard("{Backspace}{Backspace}");
				},
			],
			[
				"nested-empty-b-backspace-twice",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s))), p#k-b, ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s))), ul(li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@16',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"), textPosition(editor, "b", "end"));
					await userEvent.keyboard("{Backspace}{Backspace}");
				},
			],
			[
				"nested-delete-at-end-of-a",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s, "b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@12',
				async (editor) => {
					select(editor, textPosition(editor, "a", "end"));
					await userEvent.keyboard("{Delete}");
				},
			],
			[
				"nested-select-a-to-b1-backspace",
				'doc(p#k-before("before"~k-before-s), ul(li(p#new, ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@15',
				async (editor) => {
					select(editor, textPosition(editor, "a", "start"), textPosition(editor, "b1", "start"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-select-end-of-a-to-b1-backspace",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s, "b1"~k-b1-s), ul(li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@12',
				async (editor) => {
					select(editor, textPosition(editor, "a", "end"), textPosition(editor, "b1", "start"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-tab-at-b1",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b("b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@21',
				async (editor) => {
					select(editor, textPosition(editor, "b1", "start"));
					await userEvent.keyboard("{Tab}");
				},
			],
			[
				"nested-shift-tab-at-b",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s))), p#k-b("b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s))), ul(li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@16',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"));
					await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
				},
			],
			[
				"nested-enter-at-start-of-b",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#new), li(p#k-b("b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@20',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"));
					await userEvent.keyboard("{Enter}");
				},
			],
			[
				"nested-enter-in-emptied-b",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b), li(p#new, ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@20',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"), textPosition(editor, "b", "end"));
					await userEvent.keyboard("{Backspace}{Enter}");
				},
			],
			[
				"nested-toggle-bullet-at-b",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s))), p#k-b("b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s))), ul(li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@16',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"));
					editor.commands.toggleBulletList();
				},
			],
			[
				"nested-toggle-ordered-at-b1",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b("b"~k-b-s), ol{start=1 listId=new listStart=1}(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@21',
				async (editor) => {
					select(editor, textPosition(editor, "b1", "start"));
					editor.commands.toggleOrderedList();
				},
			],
			[
				"nested-backspace-at-start-of-after",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b("b"~k-b-s), ul(li(p#k-b1("b1"~k-b1-s)), li(p#k-b2("b2"~k-b2-s)))), li(p#k-c("c"~k-c-s, "after"~k-after-s))), p)@36',
				async (editor) => {
					select(editor, textPosition(editor, "after", "start"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-select-before-to-c-backspace",
				'doc(p#k-before("before"~k-before-s, "c"~k-c-s), p#k-after("after"~k-after-s))@7',
				async (editor) => {
					select(editor, textPosition(editor, "before", "end"), textPosition(editor, "c", "start"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-select-b-to-c-backspace",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b)), p#k-after("after"~k-after-s))@16',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"), textPosition(editor, "c", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
		];
		for (const [name, expected, run] of cases) {
			const editor = await nested();
			await focus(editor, textPosition(editor, "a", "start"));
			await run(editor);
			expectShape(editor, expected, name);
		}
	});

	it("deletes in tables and quotes", async () => {
		const table = {
			_type: "table",
			_key: "k-t",
			rows: [
				{
					_type: "tableRow",
					_key: "k-r1",
					cells: ["A", "B"].map((text) => ({
						_type: "tableCell",
						_key: `k-${text}`,
						content: [{ _type: "span", _key: `k-${text}-s`, text }],
					})),
				},
				{
					_type: "tableRow",
					_key: "k-r2",
					cells: ["C", "D"].map((text) => ({
						_type: "tableCell",
						_key: `k-${text}`,
						content: [{ _type: "span", _key: `k-${text}-s`, text }],
					})),
				},
			],
		};
		const quote = [
			block("k-q1", "First", { style: "blockquote" }),
			block("k-q2", "Second", { style: "blockquote" }),
		];
		const cases: Array<[string, string, unknown[], (editor: Editor) => Promise<void>]> = [
			[
				"table-delete-cell-text",
				'doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#k-A{colspan=1 rowspan=1 emdashData={}}(p), td#k-B{colspan=1 rowspan=1 emdashData={}}(p("B"~k-B-s))), tr#k-r2{emdashData={}}(td#k-C{colspan=1 rowspan=1 emdashData={}}(p("C"~k-C-s)), td#k-D{colspan=1 rowspan=1 emdashData={}}(p("D"~k-D-s)))), p)@4',
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "A", "start"), textPosition(editor, "A", "end"));
					await userEvent.keyboard("{Backspace}{Backspace}");
				},
			],
			[
				"table-delete-cells",
				'doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#new{colspan=1 rowspan=1}(p), td#k-A{colspan=1 rowspan=1 emdashData={}}(p)), tr#k-r2{emdashData={}}(td#k-C{colspan=1 rowspan=1 emdashData={}}(p("C"~k-C-s)), td#k-D{colspan=1 rowspan=1 emdashData={}}(p("D"~k-D-s)))), p)@8',
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "A", "start"), textPosition(editor, "B", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"table-delete-row",
				'doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#k-A{colspan=1 rowspan=1 emdashData={}}(p("A"~k-A-s)), td#k-B{colspan=1 rowspan=1 emdashData={}}(p("B"~k-B-s)))), p)@10',
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "C", "start"));
					editor.commands.deleteRow();
				},
			],
			[
				"table-delete-column",
				'doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#k-A{colspan=1 rowspan=1 emdashData={}}(p("A"~k-A-s))), tr#k-r2{emdashData={}}(td#k-C{colspan=1 rowspan=1 emdashData={}}(p("C"~k-C-s)))), p)@11',
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "B", "start"));
					editor.commands.deleteColumn();
				},
			],
			[
				"table-split-and-merge",
				'doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#k-A{colspan=1 rowspan=1 emdashData={}}(p("A"~k-A-s)), td#k-B{colspan=1 rowspan=1 emdashData={}}(p("B"~k-B-s))), tr#k-r2{emdashData={}}(td#k-C{colspan=1 rowspan=1 emdashData={}}(p("C"~k-C-s)), td#k-D{colspan=1 rowspan=1 emdashData={}}(p("D"~k-D-s)))), p)@4-17',
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "A", "start"), textPosition(editor, "C", "end"));
					editor.commands.mergeCells();
					editor.commands.splitCell();
				},
			],
			[
				"quote-backspace-at-second",
				'doc(quote(p#k-q1("First"~k-q1-s)), p#k-q2("Second"~k-q2-s), p)@10',
				quote,
				async (editor) => {
					select(editor, textPosition(editor, "Second", "start"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"quote-backspace-twice-at-second",
				'doc(quote(p#k-q1("First"~k-q1-s, "Second"~k-q2-s)), p)@13',
				quote,
				async (editor) => {
					select(editor, textPosition(editor, "Second", "start"));
					await userEvent.keyboard("{Backspace}{Backspace}");
				},
			],
			[
				"quote-select-across-backspace",
				"doc(p#k-q1, p)@1",
				quote,
				async (editor) => {
					select(
						editor,
						textPosition(editor, "First", "start"),
						textPosition(editor, "Second", "end"),
					);
					await userEvent.keyboard("{Backspace}{Backspace}");
				},
			],
			[
				"quote-enter-twice-at-end",
				'doc(quote(p#k-q1("First"~k-q1-s), p#k-q2("Second"~k-q2-s)), p#new, p)@18',
				quote,
				async (editor) => {
					select(editor, textPosition(editor, "Second", "end"));
					await userEvent.keyboard("{Enter}{Enter}");
				},
			],
			[
				"quote-select-all-text-backspace",
				'doc(p#k-before("before"~k-before-s), quote(p#k-q1), p#k-after("after"~k-after-s))@10',
				[block("k-before", "before"), ...quote, block("k-after", "after")],
				async (editor) => {
					select(
						editor,
						textPosition(editor, "First", "start"),
						textPosition(editor, "Second", "end"),
					);
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"list-select-one-item-backspace",
				'doc(ul(li(p#k-a("a"~k-a-s)), li(p#k-b), li(p#k-c("c"~k-c-s))), p)@8',
				[item("k-a", "a"), item("k-b", "b"), item("k-c", "c")],
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"), textPosition(editor, "b", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"table-select-all-text-backspace",
				"doc(table#k-t{emdashData={}}(tr#k-r1{emdashData={}}(td#k-A{colspan=1 rowspan=1 emdashData={}}(p))), p)@4",
				[table],
				async (editor) => {
					select(editor, textPosition(editor, "A", "start"), textPosition(editor, "D", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
		];
		for (const [name, expected, value, run] of cases) {
			const editor = await renderEditor(value);
			await focus(editor, 1);
			await run(editor);
			expectShape(editor, expected, name);
		}
	});

	it("removes the list or list item a deletion empties", async () => {
		const cases: Array<[string, string, (editor: Editor) => Promise<void>]> = [
			[
				"nested-select-b-to-b2-backspace",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@16',
				async (editor) => {
					select(editor, textPosition(editor, "b", "start"), textPosition(editor, "b2", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-select-b1-to-b2-backspace",
				'doc(p#k-before("before"~k-before-s), ul(li(p#k-a("a"~k-a-s)), li(p#k-b("b"~k-b-s)), li(p#k-c("c"~k-c-s))), p#k-after("after"~k-after-s))@21',
				async (editor) => {
					select(editor, textPosition(editor, "b1", "start"), textPosition(editor, "b2", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"nested-select-a-to-c-backspace",
				'doc(p#k-before("before"~k-before-s), p#k-after("after"~k-after-s))@9',
				async (editor) => {
					select(editor, textPosition(editor, "a", "start"), textPosition(editor, "c", "end"));
					await userEvent.keyboard("{Backspace}");
				},
			],
		];
		for (const [name, expected, run] of cases) {
			const editor = await nested();
			await focus(editor, textPosition(editor, "a", "start"));
			await run(editor);
			expectShape(editor, expected, name);
		}

		const list = await renderEditor([
			block("k-before", "before"),
			item("k-a", "a"),
			item("k-b", "b"),
			block("k-after", "after"),
		]);
		await focus(list, textPosition(list, "a", "start"));
		select(list, textPosition(list, "a", "start"), textPosition(list, "b", "end"));
		await userEvent.keyboard("{Backspace}");
		expectShape(list, 'doc(p#k-before("before"~k-before-s), p#k-after("after"~k-after-s))@9');

		const only = await renderEditor([
			block("k-before", "before"),
			item("k-a", "a"),
			item("k-a1", "a1", 2),
			block("k-after", "after"),
		]);
		await focus(only, textPosition(only, "a", "start"));
		select(only, textPosition(only, "a", "start"), textPosition(only, "a1", "end"));
		await userEvent.keyboard("{Backspace}");
		expectShape(only, 'doc(p#k-before("before"~k-before-s), p#k-after("after"~k-after-s))@9');
	});

	it("edits at the start of an item that holds a nested list", async () => {
		const cases: Array<[string, string, (editor: Editor) => Promise<void>]> = [
			[
				"paste-list-at-start-of-item",
				'doc(p#k-intro("intro"~k-intro-s), ul(li(p#k-b("bb"~k-b-s), ul(li(p#k-c("cc"~k-c-s)))), li(p#new("x1")), li(p#new("x2", "dd"~k-d-s)), li(p#k-e("ee"~k-e-s))), p)@32',
				async (editor) => {
					select(editor, textPosition(editor, "dd", "start"));
					editor.view.pasteHTML("<ul><li>x1</li><li>x2</li></ul>");
				},
			],
			[
				"select-into-nested-text-backspace",
				'doc(p#k-intro("intro"~k-intro-s), ul(li(p#k-c("c"~k-c-s)), li(p#k-d("dd"~k-d-s)), li(p#k-e("ee"~k-e-s))), p)@10',
				async (editor) => {
					select(
						editor,
						textPosition(editor, "bb", "start"),
						textPosition(editor, "cc", "start") + 1,
					);
					await userEvent.keyboard("{Backspace}");
				},
			],
			[
				"select-into-nested-text-enter",
				'doc(p#k-intro("intro"~k-intro-s), ul(li(p#new, p#k-c("c"~k-c-s)), li(p#k-d("dd"~k-d-s)), li(p#k-e("ee"~k-e-s))), p)@12',
				async (editor) => {
					select(
						editor,
						textPosition(editor, "bb", "start"),
						textPosition(editor, "cc", "start") + 1,
					);
					await userEvent.keyboard("{Enter}");
				},
			],
			[
				"delete-at-end-of-paragraph-before-list",
				'doc(p#k-intro("intro"~k-intro-s), ul(li(p#k-b("bb"~k-b-s), ul(li(p#k-c("cc"~k-c-s)))), li(p#k-d("dd"~k-d-s)), li(p#k-e("ee"~k-e-s))), p)@6',
				async (editor) => {
					select(editor, textPosition(editor, "intro", "end"));
					await userEvent.keyboard("{Delete}");
				},
			],
		];
		for (const [name, expected, run] of cases) {
			const editor = await renderEditor([
				block("k-intro", "intro"),
				item("k-b", "bb"),
				item("k-c", "cc", 2),
				item("k-d", "dd"),
				item("k-e", "ee"),
			]);
			await focus(editor, textPosition(editor, "intro", "start"));
			await run(editor);
			expectShape(editor, expected, name);
		}
	});

	it("keeps a list another client's deletion empties", async () => {
		const editor = await renderEditor([
			block("k-before", "before"),
			item("k-a", "a"),
			item("k-b", "b"),
			block("k-after", "after"),
		]);
		const list = editor.state.doc.firstChild!.nodeSize;
		const { nodeSize } = editor.state.doc.nodeAt(list)!;
		editor.view.dispatch(
			editor.state.tr
				.delete(list + 1, list + nodeSize - 1)
				.setMeta(ySyncPluginKey, { isChangeOrigin: true }),
		);
		expectShape(editor, 'doc(p#k-before("before"~k-before-s), ul, p#k-after("after"~k-after-s))@1');
	});

	it("inserts a section that ends with a list without an empty paragraph after it", async () => {
		const editor = await renderEditor([block("k-a", "Before"), block("k-z", "After")]);
		await focus(editor, textPosition(editor, "Before", "end"));
		sectionPicker.select!({ content: [item("k-s1", "One"), item("k-s2", "Two")] } as Section);
		expectShape(
			editor,
			'doc(p#k-a("Before"~k-a-s), ul(li(p#k-s1("One"~k-s1-s)), li(p#k-s2("Two"~k-s2-s))), p#k-z("After"~k-z-s))@21',
		);
	});
});
