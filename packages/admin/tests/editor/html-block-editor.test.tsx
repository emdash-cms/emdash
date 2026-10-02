/**
 * HTML block editing through the full editor: the tabbed code editor, the
 * block menu, placement at the top level, focus and delayed writes.
 */

import { i18n } from "@lingui/core";
import { GapCursor } from "@tiptap/pm/gapcursor";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

import "../../src/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: ({
		editor,
		onInsertBlock,
	}: {
		editor: Editor;
		onInsertBlock?: (position: number) => void;
	}) => (
		<button type="button" onClick={() => onInsertBlock?.(editor.state.doc.content.size)}>
			Test gutter insert
		</button>
	),
}));

type Block = { _type: string; _key: string; [key: string]: unknown };

const paragraph = (key: string, text: string): Block => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}-span`, text, marks: [] }],
});

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editor: Editor | null = null;
	const changes: Block[][] = [];
	const screen = await render(
		<PortableTextEditor
			onEditorReady={(instance) => {
				editor = instance;
			}}
			onChange={(value) => changes.push(value as Block[])}
			{...props}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	const pm = document.querySelector<HTMLElement>(".ProseMirror")!;
	const latest = (): Block[] => changes.at(-1) ?? ((props.value ?? []) as Block[]);
	return { screen, editor: editor!, pm, latest };
}

function htmlBlocks(value: Block[]): Block[] {
	return value.filter((block) => block._type === "htmlBlock");
}

function codeEditors(): HTMLElement[] {
	return [...document.querySelectorAll<HTMLElement>(".html-block .cm-content")];
}

async function waitForCodeEditorFocus(index = 0) {
	await vi.waitFor(() => {
		expect(codeEditors()[index]).toBeDefined();
		expect(document.activeElement).toBe(codeEditors()[index]);
	});
}

async function insertFromSlashMenu(pm: HTMLElement) {
	pm.focus();
	await userEvent.keyboard("/html");
	await vi.waitFor(() => expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy());
	await userEvent.keyboard("{Enter}");
	await waitForCodeEditorFocus();
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("HTML block editor", () => {
	it("inserts an isolated block from /html and types into its HTML editor", async () => {
		const { pm, latest } = await renderEditor();

		await insertFromSlashMenu(pm);
		await userEvent.keyboard("Hello world");

		await vi.waitFor(() => {
			const blocks = htmlBlocks(latest());
			expect(blocks).toHaveLength(1);
			expect(blocks[0]).toMatchObject({ html: "Hello world", isolated: true });
		});
		expect(latest().some((block) => block._type === "block")).toBe(false);
	});

	it("writes the CSS and JS tabs to their fields", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);

		await screen.getByRole("tab", { name: "CSS" }).click();
		await userEvent.click(codeEditors()[0]!);
		await userEvent.keyboard("p {{ color: red; }");
		await screen.getByRole("tab", { name: "JS" }).click();
		await userEvent.click(codeEditors()[0]!);
		await userEvent.keyboard("let answer = 42;");

		await vi.waitFor(() =>
			expect(htmlBlocks(latest())[0]).toMatchObject({
				css: "p { color: red; }",
				js: "let answer = 42;",
			}),
		);
	});

	it("adds a second block from the toolbar while a code editor has focus", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("first");

		await screen.getByRole("button", { name: "Insert HTML" }).click();
		await waitForCodeEditorFocus(1);
		await userEvent.keyboard("second");

		await vi.waitFor(() =>
			expect(htmlBlocks(latest()).map((block) => block.html)).toEqual(["first", "second"]),
		);
	});

	it("adds a block right after the focused block when text follows it", async () => {
		const saved: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
		const { screen, latest } = await renderEditor({ value: [saved, paragraph("after", "After")] });
		await screen.getByRole("tab", { name: "HTML" }).click();
		await userEvent.click(codeEditors()[0]!);

		await screen.getByRole("button", { name: "Insert HTML" }).click();
		await waitForCodeEditorFocus(1);

		await vi.waitFor(() =>
			expect(latest().map((block) => block._type)).toEqual(["htmlBlock", "htmlBlock", "block"]),
		);
		expect(latest()[0]).toEqual(saved);
	});

	it("adds a block right after the focused block when another block follows it", async () => {
		const first: Block = { _type: "htmlBlock", _key: "first", html: "<p>First</p>" };
		const second: Block = { _type: "htmlBlock", _key: "second", html: "<p>Second</p>" };
		const { screen, latest } = await renderEditor({ value: [first, second] });
		await screen.getByRole("tab", { name: "HTML" }).first().click();
		await userEvent.click(codeEditors()[0]!);

		await screen.getByRole("button", { name: "Insert HTML" }).click();
		await waitForCodeEditorFocus(1);

		await vi.waitFor(() =>
			expect(htmlBlocks(latest()).map((block) => block._key)).toEqual([
				"first",
				expect.any(String),
				"second",
			]),
		);
	});

	it("adds a block right after the focused block when a table follows it", async () => {
		const saved: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
		const table: Block = {
			_type: "table",
			_key: "table",
			rows: [
				{
					_type: "tableRow",
					_key: "row",
					cells: [
						{
							_type: "tableCell",
							_key: "cell",
							content: [{ _type: "span", _key: "cell-span", text: "Cell" }],
						},
					],
				},
			],
		};
		const { screen, latest } = await renderEditor({ value: [saved, table] });
		await screen.getByRole("tab", { name: "HTML" }).click();
		await vi.waitFor(() => expect(codeEditors()).toHaveLength(1));
		await userEvent.click(codeEditors()[0]!);

		await screen.getByRole("button", { name: "Insert HTML" }).click();
		await waitForCodeEditorFocus(1);

		await vi.waitFor(() =>
			expect(latest().map((block) => block._type)).toEqual(["htmlBlock", "htmlBlock", "table"]),
		);
	});

	it("places a block inserted from a list item after the list", async () => {
		const listItem = { ...paragraph("item", "Item"), listItem: "bullet", level: 1 };
		const { screen, editor, latest } = await renderEditor({ value: [listItem] });
		editor.commands.setTextSelection(5);

		await screen.getByRole("button", { name: "Insert HTML" }).click();
		await waitForCodeEditorFocus();

		await vi.waitFor(() =>
			expect(latest().map((block) => [block._type, block.listItem])).toEqual([
				["block", "bullet"],
				["htmlBlock", undefined],
			]),
		);
	});

	it("keeps a selected block out of a quote", async () => {
		const block: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
		const { screen, editor, latest } = await renderEditor({
			value: [block, paragraph("after", "After")],
		});
		editor.commands.setNodeSelection(0);

		await screen.getByRole("button", { name: "Quote" }).click();

		expect(editor.getJSON().content?.some((node) => node.type === "blockquote")).toBe(false);
		expect(htmlBlocks(latest())).toEqual([block]);
	});

	it("leaves the code editor on Escape and returns on Enter", async () => {
		const { editor, pm } = await renderEditor();
		await insertFromSlashMenu(pm);

		await userEvent.keyboard("{Escape}");

		await vi.waitFor(() => expect(document.activeElement).toBe(pm));
		const { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("htmlBlock");

		await userEvent.keyboard("{Enter}");
		await waitForCodeEditorFocus();
	});

	it("moves Tab from a selected block to that block's tabs", async () => {
		const first: Block = { _type: "htmlBlock", _key: "first", html: "<p>First</p>" };
		const second: Block = { _type: "htmlBlock", _key: "second", html: "<p>Second</p>" };
		const { editor, pm } = await renderEditor({ value: [first, second] });
		editor.commands.setNodeSelection(editor.state.doc.firstChild!.nodeSize);
		pm.focus();

		await userEvent.keyboard("{Tab}");

		const blocks = document.querySelectorAll(".html-block");
		expect(document.activeElement?.getAttribute("role")).toBe("tab");
		expect(blocks[1]?.contains(document.activeElement)).toBe(true);
	});

	it("switches the render mode from the block menu", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);

		await screen.getByRole("button", { name: "HTML block options" }).click();
		await screen.getByRole("menuitemradio", { name: /^Inline/ }).click();

		await vi.waitFor(() => expect(htmlBlocks(latest())[0]).not.toHaveProperty("isolated"));
		expect(screen.getByRole("tab", { name: "CSS" }).query()).toBeNull();

		await screen.getByRole("button", { name: "HTML block options" }).click();
		await screen.getByRole("menuitemradio", { name: /^Isolated frame/ }).click();

		await vi.waitFor(() => expect(htmlBlocks(latest())[0]).toMatchObject({ isolated: true }));
		await expect.element(screen.getByRole("tab", { name: "CSS" })).toBeVisible();
		await expect.element(screen.getByRole("tab", { name: "JS" })).toBeVisible();
	});

	it("deletes the block from its menu and keeps focus in the editor", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("gone");

		await screen.getByRole("button", { name: "HTML block options" }).click();
		await screen.getByRole("menuitem", { name: "Delete block" }).click();

		await vi.waitFor(() => expect(htmlBlocks(latest())).toHaveLength(0));
		await vi.waitFor(() => expect(pm.contains(document.activeElement)).toBe(true));
	});

	it("shows the earlier code after undo in the editor", async () => {
		const { pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("one");
		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("one"));
		await pause(600);
		await userEvent.keyboard(" two");
		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("one two"));

		await userEvent.keyboard("{Escape}");
		await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");

		await vi.waitFor(() => expect(codeEditors()[0]?.textContent).toBe("one"));
	});

	it("undoes the latest typing from the toolbar without losing it to an older step", async () => {
		const { screen, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("one");
		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("one"));
		await pause(600);

		await userEvent.keyboard(" two");
		await screen.getByRole("button", { name: "Undo" }).click();

		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("one"));
		await pause(400);
		expect(htmlBlocks(latest())[0]?.html).toBe("one");
	});

	it("writes typing that waited while the editor was read-only", async () => {
		const { screen, editor, pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		await userEvent.keyboard("kept");
		editor.setEditable(false);
		await pause(400);
		editor.setEditable(true);

		await screen.getByRole("tab", { name: "CSS" }).click();

		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("kept"));
	});

	it("lays out its controls in the interface direction, not the content's", async () => {
		const previousLocale = i18n.locale;
		const previousDir = document.documentElement.dir;
		i18n.load("ar", {});
		i18n.activate("ar");
		document.documentElement.dir = "rtl";
		try {
			const saved: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
			const { screen } = await renderEditor({ value: [paragraph("text", "English"), saved] });

			await vi.waitFor(() =>
				expect(getComputedStyle(screen.getByRole("tablist").element()).direction).toBe("rtl"),
			);
		} finally {
			document.documentElement.dir = previousDir;
			i18n.activate(previousLocale);
		}
	});

	it("shows read-only code and no menu when the editor is read-only", async () => {
		const block: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
		const { screen } = await renderEditor({ value: [block], editable: false });
		await screen.getByRole("tab", { name: "HTML" }).click();

		await vi.waitFor(() => expect(codeEditors()[0]?.textContent).toBe("<p>Saved</p>"));
		expect(codeEditors()[0]?.getAttribute("contenteditable")).toBe("false");
		expect(screen.getByRole("button", { name: "HTML block options" }).query()).toBeNull();
	});

	it("lets Delete act at a gap cursor before the block", async () => {
		const block: Block = { _type: "htmlBlock", _key: "saved", html: "<p>Saved</p>" };
		const { editor, pm } = await renderEditor({ value: [block, paragraph("after", "After")] });
		pm.focus();
		editor.view.dispatch(editor.state.tr.setSelection(new GapCursor(editor.state.doc.resolve(0))));
		expect(editor.state.selection).toBeInstanceOf(GapCursor);

		await userEvent.keyboard("{Delete}");

		const { selection } = editor.state;
		expect(selection instanceof NodeSelection && selection.node.type.name).toBe("htmlBlock");
	});

	it("sends text dropped on the code editor to the code, not the document", async () => {
		const { pm, latest } = await renderEditor();
		await insertFromSlashMenu(pm);
		const target = codeEditors()[0]!;
		const box = target.getBoundingClientRect();
		const dataTransfer = new DataTransfer();
		dataTransfer.setData("text/plain", "dropped");

		target.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				clientX: box.left + 20,
				clientY: box.top + 10,
				dataTransfer,
			}),
		);

		await vi.waitFor(() => expect(htmlBlocks(latest())[0]?.html).toBe("dropped"));
		expect(latest().some((block) => block._type === "block")).toBe(false);
	});

	it("lets a block dragged from the handle drop onto a code editor", async () => {
		const { editor, pm } = await renderEditor({ value: [paragraph("moved", "Moved")] });
		await insertFromSlashMenu(pm);
		const target = codeEditors()[0]!;
		const box = target.getBoundingClientRect();
		editor.view.dragging = { slice: editor.state.doc.slice(0, 7), move: true };

		target.dispatchEvent(
			new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				clientX: box.left + 20,
				clientY: box.top + 10,
				dataTransfer: new DataTransfer(),
			}),
		);

		expect(editor.view.dragging).toBeNull();
	});

	it("undoes a block inserted from the gutter in one step", async () => {
		const { screen, editor } = await renderEditor({ value: [paragraph("hello", "Hello")] });
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		const item = [...menu.querySelectorAll("button")].find(
			(button) => button.querySelector(".font-medium")?.textContent === "HTML",
		);
		item!.click();
		await waitForCodeEditorFocus();
		await userEvent.keyboard("{Escape}");
		await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");

		expect(editor.getJSON()).toEqual(before);
	});
});

function previewFrame(): HTMLIFrameElement | null {
	return document.querySelector<HTMLIFrameElement>("iframe[title='HTML block preview']");
}

function nextMessageFrom(frame: () => HTMLIFrameElement | null, data: unknown): Promise<void> {
	return new Promise((resolve) => {
		const onMessage = (event: MessageEvent) => {
			if (event.source !== frame()?.contentWindow || event.data !== data) return;
			window.removeEventListener("message", onMessage);
			resolve();
		};
		window.addEventListener("message", onMessage);
	});
}

describe("HTML block preview", () => {
	it("opens a saved block on Preview, sized to its content", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "saved",
			html: '<div style="height: 240px">Tall</div>',
			isolated: true,
		};
		const { screen } = await renderEditor({ value: [block] });

		await expect
			.element(screen.getByRole("tab", { name: "Preview" }))
			.toHaveAttribute("aria-selected", "true");
		await vi.waitFor(() =>
			expect(Math.round(previewFrame()!.getBoundingClientRect().height)).toBe(240),
		);
	});

	it("runs a saved block's JavaScript after Run preview, and edited code right away", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "saved",
			html: "<p>Script</p>",
			js: 'parent.postMessage("ran", "*");',
			isolated: true,
		};
		const { screen } = await renderEditor({ value: [block] });
		await expect.element(screen.getByRole("button", { name: "Run preview" })).toBeVisible();
		expect(previewFrame()).toBeNull();

		const ran = nextMessageFrom(previewFrame, "ran");
		await screen.getByRole("button", { name: "Run preview" }).click();
		await ran;

		await screen.getByRole("tab", { name: "JS" }).click();
		await userEvent.click(codeEditors()[0]!);
		await userEvent.keyboard("{End} ");
		const ranAgain = nextMessageFrom(previewFrame, "ran");
		await screen.getByRole("tab", { name: "Preview" }).click();

		await ranAgain;
		expect(screen.getByRole("button", { name: "Run preview" }).query()).toBeNull();
	});

	it("waits for Run preview when a saved block's HTML holds a script or a frame", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "saved",
			html: "<iframe srcdoc=\"&lt;script&gt;parent.parent.postMessage(1, '*')&lt;/script&gt;\"></iframe>",
			isolated: true,
		};
		const { screen } = await renderEditor({ value: [block] });

		await expect.element(screen.getByRole("button", { name: "Run preview" })).toBeVisible();
		expect(previewFrame()).toBeNull();
	});

	it("keeps and removes the same markup in an inline preview as the site", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "inline",
			html: '<img src="data:image/png;base64,AA" alt="x"><iframe src="//www.youtube.com/embed/abc"></iframe><table width="100%"><tbody><tr><td width="50">Cell</td></tr></tbody></table><video>Fallback</video><textarea>Hidden</textarea><noscript><p>No script</p></noscript><a href="javascript:alert(1)">Link</a>',
		};
		const site =
			'<img alt="x" /><iframe src="//www.youtube.com/embed/abc"></iframe><table><tbody><tr><td>Cell</td></tr></tbody></table>Fallback<p>No script</p><a>Link</a>';
		await renderEditor({ value: [block] });

		await vi.waitFor(() => expect(previewFrame()).not.toBeNull());
		const parse = (html: string) => new DOMParser().parseFromString(html, "text/html").body;
		expect(parse(previewFrame()!.srcdoc).innerHTML).toBe(parse(site).innerHTML);
	});

	it("cleans an inline block's preview the way the site does", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "inline",
			html: '<style>p { color: red; }</style><p style="color: red" onclick="steal()">Kept</p><script>steal()</script>',
		};
		const { screen } = await renderEditor({ value: [block] });

		await vi.waitFor(() => expect(previewFrame()).not.toBeNull());
		const body = new DOMParser().parseFromString(previewFrame()!.srcdoc, "text/html").body;
		expect(body.querySelector("script, style")).toBeNull();
		expect(body.querySelector("p")?.getAttributeNames()).toEqual([]);
		expect(body.textContent).toBe("Kept");
		await expect.element(screen.getByText(/^Inline blocks use your site's styles/)).toBeVisible();
	});

	it("says there is nothing to preview for a new block", async () => {
		const { screen, pm } = await renderEditor();
		await insertFromSlashMenu(pm);

		await screen.getByRole("tab", { name: "Preview" }).click();

		await expect.element(screen.getByText("Nothing to preview yet.")).toBeVisible();
	});

	it("notes resources the security policy blocked", async () => {
		const block: Block = {
			_type: "htmlBlock",
			_key: "saved",
			html: "<p>Blocked</p>",
			js: [
				'const policy = document.createElement("meta");',
				'policy.httpEquiv = "Content-Security-Policy";',
				"policy.content = \"img-src 'none'\";",
				"document.head.append(policy);",
				"const image = new Image();",
				'image.src = "data:image/gif;base64,R0lGODlhAQABAAAAACw=";',
				"document.body.append(image);",
			].join("\n"),
			isolated: true,
		};
		const { screen } = await renderEditor({ value: [block] });

		await screen.getByRole("button", { name: "Run preview" }).click();

		await expect
			.element(screen.getByText(/^The admin's security policy blocked some resources/))
			.toBeVisible();
	});
});
