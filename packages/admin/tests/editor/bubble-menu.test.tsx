/**
 * Bubble menu tests.
 *
 * Tests the inline formatting bubble menu that appears when text is selected.
 * Covers formatting buttons (bold, italic, underline, strikethrough, code),
 * link insertion/editing, and menu visibility.
 *
 * The bubble menu uses TipTap's BubbleMenu component and only appears
 * when there's a text selection in the editor.
 */

import { CellSelection } from "@tiptap/pm/tables";
import type { Editor } from "@tiptap/react";
import { userEvent } from "@vitest/browser/context";
import { describe, it, expect, vi } from "vitest";

import type { PortableTextEditorProps } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

vi.mock("../../src/components/editor/ImageNode", async () => {
	const { Node } = await import("@tiptap/core");
	const ImageExtension = Node.create({
		name: "image",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				src: { default: null },
				alt: { default: "" },
				title: { default: "" },
				caption: { default: "" },
				mediaId: { default: null },
				provider: { default: "local" },
				width: { default: null },
				height: { default: null },
				displayWidth: { default: null },
				displayHeight: { default: null },
			};
		},
		parseHTML() {
			return [{ tag: "img[src]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["img", HTMLAttributes];
		},
	});
	return { ImageExtension };
});

vi.mock("../../src/components/editor/PluginBlockNode", async () => {
	const { Node } = await import("@tiptap/core");
	const PluginBlockExtension = Node.create({
		name: "pluginBlock",
		group: "block",
		atom: true,
		addAttributes() {
			return {
				blockType: { default: "embed" },
				id: { default: "" },
				data: { default: {} },
			};
		},
		parseHTML() {
			return [{ tag: "div[data-plugin-block]" }];
		},
		renderHTML({ HTMLAttributes }) {
			return ["div", { ...HTMLAttributes, "data-plugin-block": "" }];
		},
	});
	return {
		PluginBlockExtension,
		getEmbedMeta: () => ({ label: "Embed", Icon: () => null }),
		registerPluginBlocks: () => {},
		resolveIcon: () => () => null,
	};
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const defaultValue = [
	{
		_type: "block" as const,
		_key: "1",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s1", text: "Hello world" }],
	},
];

const tableValue = [
	{
		_type: "table" as const,
		_key: "table-1",
		hasHeaderRow: true,
		rows: [
			{
				_type: "tableRow" as const,
				_key: "row-1",
				cells: [
					{
						_type: "tableCell" as const,
						_key: "cell-1",
						content: [{ _type: "span" as const, _key: "table-span-1", text: "Header" }],
						isHeader: true,
					},
					{
						_type: "tableCell" as const,
						_key: "cell-2",
						content: [{ _type: "span" as const, _key: "table-span-2", text: "Other" }],
						isHeader: true,
					},
				],
			},
			{
				_type: "tableRow" as const,
				_key: "row-2",
				cells: [
					{
						_type: "tableCell" as const,
						_key: "cell-3",
						content: [{ _type: "span" as const, _key: "table-span-3", text: "Body" }],
					},
					{
						_type: "tableCell" as const,
						_key: "cell-4",
						content: [{ _type: "span" as const, _key: "table-span-4", text: "Cell" }],
					},
				],
			},
		],
	},
];

async function renderEditor(props: Partial<PortableTextEditorProps> = {}, scrollContainerTop = 0) {
	let editorInstance: Editor | null = null;

	const screen = await render(
		<div
			style={{
				marginTop: scrollContainerTop,
				maxHeight: scrollContainerTop ? 500 : undefined,
				overflowY: scrollContainerTop ? "auto" : undefined,
			}}
		>
			<PortableTextEditor
				value={defaultValue}
				onEditorReady={(editor) => {
					editorInstance = editor;
				}}
				{...props}
			/>
		</div>,
	);

	await vi.waitFor(
		() => {
			expect(document.querySelector(".ProseMirror")).toBeTruthy();
			expect(editorInstance).toBeTruthy();
		},
		{ timeout: 3000 },
	);

	const pm = document.querySelector(".ProseMirror") as HTMLElement;
	return { screen, editor: editorInstance!, pm };
}

/** Focus the editor and select all text using TipTap commands */
async function focusAndSelectAll(editor: Editor, pm: HTMLElement) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
	editor.commands.focus();
	editor.commands.selectAll();
}

function getTextPosition(editor: Editor, text: string): number {
	let textPosition = 0;
	editor.state.doc.descendants((node, position) => {
		if (node.isText && node.text === text) {
			textPosition = position;
			return false;
		}
		return undefined;
	});
	return textPosition;
}

async function focusTableCell(editor: Editor, pm: HTMLElement, text = "Header") {
	pm.focus();
	editor.chain().focus().setTextSelection(getTextPosition(editor, text)).run();
	await vi.waitFor(() => expect(editor.isActive("table")).toBe(true));
}

async function waitForTableToolbar(): Promise<HTMLElement> {
	let toolbar: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			toolbar = document.querySelector('[role="group"][aria-label="Table controls"]');
			expect(toolbar).toBeTruthy();
		},
		{ timeout: 3000 },
	);
	return toolbar!;
}

/**
 * Find the bubble menu element.
 * TipTap's BubbleMenu renders as a div with role=presentation (tippy.js).
 * Our menu has the class "bg-kumo-base" and contains aria-label buttons.
 */
function getBubbleMenu(): HTMLElement | null {
	// The BubbleMenu from @tiptap/react/menus renders inline.
	// Look for the container with our known class pattern.
	const candidates = document.querySelectorAll('[class*="bg-kumo-base"]');
	for (const el of candidates) {
		// Bubble menu has formatting buttons with specific aria-labels
		if (el.querySelector('[aria-label="Bold"]') && el.querySelector('[aria-label="Italic"]')) {
			return el as HTMLElement;
		}
	}
	// Also check for link input mode (has Apply link button)
	for (const el of candidates) {
		if (el.querySelector('[aria-label="Apply link"]')) {
			return el as HTMLElement;
		}
	}
	return null;
}

/** Wait for bubble menu to appear */
async function waitForBubbleMenu(): Promise<HTMLElement> {
	let menu: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			menu = getBubbleMenu();
			expect(menu).toBeTruthy();
		},
		{ timeout: 3000 },
	);
	return menu!;
}

/** Get a bubble menu button by aria-label */
function getBubbleButton(menu: HTMLElement, label: string): HTMLButtonElement | null {
	return menu.querySelector(`[aria-label="${label}"]`);
}

// =============================================================================
// Bubble Menu
// =============================================================================

describe("Bubble Menu", () => {
	it("registers stable, independent plugins for both bubble menus", async () => {
		const { editor, pm } = await renderEditor({ value: [...tableValue, ...defaultValue] });
		const expectBubbleMenuPlugins = () => {
			const pluginKeys = editor.state.plugins.map((plugin) => plugin.key);
			expect(pluginKeys.filter((key) => key.startsWith("emdashInlineBubbleMenu"))).toHaveLength(1);
			expect(pluginKeys.filter((key) => key.startsWith("emdashTableBubbleMenu"))).toHaveLength(1);
		};

		await vi.waitFor(expectBubbleMenuPlugins);
		await focusTableCell(editor, pm);
		await waitForTableToolbar();
		expectBubbleMenuPlugins();

		editor.chain().focus().setTextSelection(getTextPosition(editor, "Hello world")).run();
		await vi.waitFor(() => {
			expect(document.querySelector('[aria-label="Table controls"]')).toBeNull();
		});
		expectBubbleMenuPlugins();

		await focusTableCell(editor, pm);
		await waitForTableToolbar();
		expectBubbleMenuPlugins();
	});

	it("appears when text is selected", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		expect(menu).toBeTruthy();
	});

	it("flips below a top-line selection when the sticky toolbar blocks the preferred position", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const toolbar = document.querySelector<HTMLElement>(
			'[role="toolbar"][aria-label="Text formatting"]',
		);
		expect(toolbar).toBeTruthy();

		await vi.waitFor(() => {
			const selection = window.getSelection();
			expect(selection?.rangeCount).toBe(1);
			const selectionRect = selection!.getRangeAt(0).getBoundingClientRect();
			const menuRect = menu.getBoundingClientRect();
			expect(menuRect.top).toBeGreaterThanOrEqual(selectionRect.bottom);
			expect(menuRect.top).toBeGreaterThanOrEqual(toolbar!.getBoundingClientRect().bottom);
		});
	});

	it("stays above the selection when there is room below the sticky toolbar", async () => {
		const value = ["First line", "Second line", "Third line"].map((text, index) => ({
			_type: "block" as const,
			_key: String(index),
			style: "normal" as const,
			children: [{ _type: "span" as const, _key: `span-${index}`, text }],
		}));
		const { editor, pm } = await renderEditor({ value }, 58);
		pm.focus();

		let textPosition = 0;
		editor.state.doc.descendants((node, position) => {
			if (node.isText && node.text === "Third line") {
				textPosition = position;
				return false;
			}
			return undefined;
		});
		editor
			.chain()
			.focus()
			.setTextSelection({ from: textPosition, to: textPosition + 10 })
			.run();

		const menu = await waitForBubbleMenu();
		await vi.waitFor(() => {
			const selection = window.getSelection();
			expect(selection?.rangeCount).toBe(1);
			const selectionRect = selection!.getRangeAt(0).getBoundingClientRect();
			const menuRect = menu.getBoundingClientRect();
			expect(menuRect.bottom).toBeLessThanOrEqual(selectionRect.top);
		});
	});

	it("keeps table controls mounted, unclipped, and below obstructing sticky chrome", async () => {
		const { screen, editor, pm } = await renderEditor({ value: tableValue });
		await focusTableCell(editor, pm);

		const tableToolbar = await waitForTableToolbar();
		const floatingRoot = screen.container.querySelector("[data-emdash-editor-floating-root]");
		const clippedSurface = screen.container.querySelector("[data-emdash-editor-surface]");
		expect(floatingRoot).toBeTruthy();
		expect(floatingRoot?.contains(tableToolbar)).toBe(true);
		expect(clippedSurface?.contains(tableToolbar)).toBe(false);

		await vi.waitFor(() => {
			const selection = window.getSelection();
			expect(selection?.rangeCount).toBe(1);
			const selectionRect = selection!.getRangeAt(0).getBoundingClientRect();
			const menuRect = tableToolbar.getBoundingClientRect();
			const formattingToolbar = document.querySelector<HTMLElement>(
				'[role="toolbar"][aria-label="Text formatting"]',
			);
			expect(menuRect.top).toBeGreaterThanOrEqual(selectionRect.bottom);
			expect(menuRect.top).toBeGreaterThanOrEqual(
				formattingToolbar!.getBoundingClientRect().bottom,
			);
		});
	});

	it("shows only inline formatting for a non-empty text selection inside a table", async () => {
		const { editor, pm } = await renderEditor({ value: tableValue });
		pm.focus();
		const textPosition = getTextPosition(editor, "Body");
		editor
			.chain()
			.focus()
			.setTextSelection({ from: textPosition, to: textPosition + 4 })
			.run();

		await waitForBubbleMenu();
		await vi.waitFor(() => {
			expect(document.querySelector('[aria-label="Table controls"]')).toBeNull();
		});
	});

	it("shows only table controls for a cell selection", async () => {
		const { editor, pm } = await renderEditor({ value: tableValue });
		pm.focus();
		const cellPositions: number[] = [];
		editor.state.doc.descendants((node, position) => {
			if (node.type.name === "tableHeader" || node.type.name === "tableCell") {
				cellPositions.push(position);
			}
		});
		editor.view.dispatch(
			editor.state.tr.setSelection(
				CellSelection.create(editor.state.doc, cellPositions[0]!, cellPositions[3]!),
			),
		);
		expect(editor.state.selection).toBeInstanceOf(CellSelection);

		await waitForTableToolbar();
		await vi.waitFor(() => expect(getBubbleMenu()).toBeNull());
	});

	it("hides inline formatting controls when the editor becomes read-only", async () => {
		const { editor, pm } = await renderEditor();
		editor.setEditable(false);
		pm.tabIndex = 0;
		pm.focus();
		editor.commands.selectAll();
		await new Promise((resolve) => setTimeout(resolve, 350));

		expect(document.activeElement).toBe(pm);
		expect(getBubbleMenu()).toBeNull();
	});

	it("exposes accessible table actions and toggle state", async () => {
		const { screen, editor, pm } = await renderEditor({ value: tableValue });
		await focusTableCell(editor, pm);
		await waitForTableToolbar();

		const addBefore = screen.getByRole("button", { name: "Add column before" });
		const headerToggle = screen.getByRole("button", { name: "Toggle header row" });
		await expect.element(addBefore).toBeVisible();
		expect(addBefore.element().hasAttribute("aria-pressed")).toBe(false);
		await expect.element(headerToggle).toHaveAttribute("aria-pressed", "true");
	});

	it("uses purpose-built icons for table insertion actions", async () => {
		const { screen, editor, pm } = await renderEditor({ value: tableValue });
		await focusTableCell(editor, pm);
		await waitForTableToolbar();

		for (const name of [
			"Add column before",
			"Add column after",
			"Add row before",
			"Add row after",
		]) {
			const button = screen.getByRole("button", { name }).element();
			expect(button.querySelectorAll("svg")).toHaveLength(1);
			expect(button.querySelector(".absolute")).toBeNull();
		}

		const beforeIcon = screen
			.getByRole("button", { name: "Add column before" })
			.element()
			.querySelector("svg");
		expect(beforeIcon?.getAttribute("class")).toContain("rtl:-scale-x-100");
	});

	it("shows formatting buttons: Bold, Italic, Underline, Strikethrough, Code", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();

		expect(getBubbleButton(menu, "Bold")).toBeTruthy();
		expect(getBubbleButton(menu, "Italic")).toBeTruthy();
		expect(getBubbleButton(menu, "Underline")).toBeTruthy();
		expect(getBubbleButton(menu, "Strikethrough")).toBeTruthy();
		expect(getBubbleButton(menu, "Code")).toBeTruthy();
	});

	it("shows Add link button", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		expect(getBubbleButton(menu, "Add link")).toBeTruthy();
	});

	it("toggles bold when Bold button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const boldBtn = getBubbleButton(menu, "Bold")!;
		expect(boldBtn.getAttribute("aria-pressed")).toBe("false");

		boldBtn.click();

		await vi.waitFor(() => {
			expect(editor.isActive("bold")).toBe(true);
			expect(boldBtn.getAttribute("aria-pressed")).toBe("true");
		});

		// Verify the text is wrapped in <strong>
		expect(pm.querySelector("strong")).toBeTruthy();
	});

	it("toggles italic when Italic button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const italicBtn = getBubbleButton(menu, "Italic")!;

		italicBtn.click();

		await vi.waitFor(() => {
			expect(editor.isActive("italic")).toBe(true);
		});

		expect(pm.querySelector("em")).toBeTruthy();
	});

	it("toggles underline when Underline button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const underlineBtn = getBubbleButton(menu, "Underline")!;

		underlineBtn.click();

		await vi.waitFor(() => {
			expect(editor.isActive("underline")).toBe(true);
		});

		expect(pm.querySelector("u")).toBeTruthy();
	});

	it("toggles strikethrough when Strikethrough button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const strikeBtn = getBubbleButton(menu, "Strikethrough")!;

		strikeBtn.click();

		await vi.waitFor(() => {
			expect(editor.isActive("strike")).toBe(true);
		});

		expect(pm.querySelector("s")).toBeTruthy();
	});

	it("toggles inline code when Code button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const codeBtn = getBubbleButton(menu, "Code")!;

		codeBtn.click();

		await vi.waitFor(() => {
			expect(editor.isActive("code")).toBe(true);
		});

		expect(pm.querySelector("code")).toBeTruthy();
	});

	it("shows link input when Add link button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const linkBtn = getBubbleButton(menu, "Add link")!;

		linkBtn.click();

		// The bubble menu should now show the link input
		await vi.waitFor(() => {
			const applyBtn = getBubbleButton(menu, "Apply link");
			expect(applyBtn).toBeTruthy();
		});

		// Should have a URL input with placeholder
		const input = menu.querySelector('input[type="url"]');
		expect(input).toBeTruthy();
		expect(input?.getAttribute("aria-label")).toBe("URL");
	});

	it("applies link URL when Apply button is clicked", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const linkBtn = getBubbleButton(menu, "Add link")!;
		linkBtn.click();

		await vi.waitFor(() => {
			expect(menu.querySelector('input[type="url"]')).toBeTruthy();
		});

		// Type a URL into the input
		const input = menu.querySelector('input[type="url"]') as HTMLInputElement;
		input.focus();
		// Use native value setter + input event for React controlled input
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(input, "https://example.com");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		// Click Apply
		const applyBtn = getBubbleButton(menu, "Apply link")!;
		applyBtn.click();

		// The editor should now have a link
		await vi.waitFor(() => {
			const link = pm.querySelector("a");
			expect(link).toBeTruthy();
			expect(link!.getAttribute("href")).toBe("https://example.com");
		});
	});

	it("applies link on Enter key in URL input", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		getBubbleButton(menu, "Add link")!.click();

		await vi.waitFor(() => {
			expect(menu.querySelector('input[type="url"]')).toBeTruthy();
		});

		const input = menu.querySelector('input[type="url"]') as HTMLInputElement;
		input.focus();
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(input, "https://test.org");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		// Press Enter
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			const link = pm.querySelector("a");
			expect(link).toBeTruthy();
			expect(link!.getAttribute("href")).toBe("https://test.org");
		});
	});

	it("shows Edit link and Remove link buttons when cursor is on a link", async () => {
		const linkValue = [
			{
				_type: "block" as const,
				_key: "1",
				style: "normal" as const,
				children: [
					{
						_type: "span" as const,
						_key: "s1",
						text: "Click here",
						marks: ["link1"],
					},
				],
				markDefs: [{ _type: "link", _key: "link1", href: "https://example.com" }],
			},
		];

		const { editor, pm } = await renderEditor({ value: linkValue });
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();

		// Should show "Edit link" instead of "Add link"
		expect(getBubbleButton(menu, "Edit link")).toBeTruthy();

		// Click Edit link to show input
		getBubbleButton(menu, "Edit link")!.click();

		await vi.waitFor(() => {
			expect(getBubbleButton(menu, "Remove link")).toBeTruthy();
		});
	});

	it("removes link when Remove link button is clicked", async () => {
		const linkValue = [
			{
				_type: "block" as const,
				_key: "1",
				style: "normal" as const,
				children: [
					{
						_type: "span" as const,
						_key: "s1",
						text: "Click here",
						marks: ["link1"],
					},
				],
				markDefs: [{ _type: "link", _key: "link1", href: "https://example.com" }],
			},
		];

		const { editor, pm } = await renderEditor({ value: linkValue });
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();

		// Click Edit link to open link input mode
		getBubbleButton(menu, "Edit link")!.click();

		await vi.waitFor(() => {
			expect(getBubbleButton(menu, "Remove link")).toBeTruthy();
		});

		// Click Remove link
		getBubbleButton(menu, "Remove link")!.click();

		await vi.waitFor(() => {
			expect(pm.querySelector("a")).toBeNull();
		});
	});

	it("closes link input on Escape and returns focus to editor", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		getBubbleButton(menu, "Add link")!.click();

		await vi.waitFor(() => {
			expect(menu.querySelector('input[type="url"]')).toBeTruthy();
		});

		const input = menu.querySelector('input[type="url"]') as HTMLInputElement;
		input.focus();

		// Press Escape
		await userEvent.keyboard("{Escape}");

		// Should return to the formatting buttons view
		await vi.waitFor(() => {
			expect(getBubbleButton(menu, "Bold")).toBeTruthy();
		});
	});

	it("unsets link when Apply is clicked with empty URL", async () => {
		const linkValue = [
			{
				_type: "block" as const,
				_key: "1",
				style: "normal" as const,
				children: [
					{
						_type: "span" as const,
						_key: "s1",
						text: "Click here",
						marks: ["link1"],
					},
				],
				markDefs: [{ _type: "link", _key: "link1", href: "https://example.com" }],
			},
		];

		const { editor, pm } = await renderEditor({ value: linkValue });
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		getBubbleButton(menu, "Edit link")!.click();

		await vi.waitFor(() => {
			expect(menu.querySelector('input[type="url"]')).toBeTruthy();
		});

		// Clear the input
		const input = menu.querySelector('input[type="url"]') as HTMLInputElement;
		input.focus();
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(input, "");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		// Click Apply
		getBubbleButton(menu, "Apply link")!.click();

		// Link should be removed
		await vi.waitFor(() => {
			expect(pm.querySelector("a")).toBeNull();
		});
	});

	it("can apply multiple formatting marks", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();

		// Apply bold + italic
		getBubbleButton(menu, "Bold")!.click();
		getBubbleButton(menu, "Italic")!.click();

		await vi.waitFor(() => {
			expect(editor.isActive("bold")).toBe(true);
			expect(editor.isActive("italic")).toBe(true);
		});

		expect(pm.querySelector("strong")).toBeTruthy();
		expect(pm.querySelector("em")).toBeTruthy();
	});

	it("toggles off formatting when clicked twice", async () => {
		const { editor, pm } = await renderEditor();
		await focusAndSelectAll(editor, pm);

		const menu = await waitForBubbleMenu();
		const boldBtn = getBubbleButton(menu, "Bold")!;

		// Apply bold
		boldBtn.click();
		await vi.waitFor(() => expect(editor.isActive("bold")).toBe(true));

		// Re-select (bold toggle may deselect)
		editor.commands.selectAll();

		// Remove bold
		boldBtn.click();
		await vi.waitFor(() => expect(editor.isActive("bold")).toBe(false));

		expect(pm.querySelector("strong")).toBeNull();
	});
});
