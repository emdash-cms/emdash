/**
 * PortableTextEditor component tests.
 *
 * Tests the TipTap-based rich text editor in vitest browser mode,
 * covering Portable Text ↔ ProseMirror round-trip conversion,
 * toolbar behaviour, focus modes, and editor lifecycle.
 */

import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import type { PluginBlockDef } from "../../src/components/PortableTextEditor";
import { PortableTextEditor } from "../../src/components/PortableTextEditor";
import { render } from "../utils/render.tsx";
import { TestWrapper } from "../utils/test-helpers.js";

// ---------------------------------------------------------------------------
// Mocks — heavy components that need network / Astro context
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

const SPOTLIGHT_MODE_PATTERN = /Spotlight Mode/i;

/** Wait for the ProseMirror editor to mount inside the container */
async function waitForEditor(): Promise<HTMLElement> {
	let pm: HTMLElement | null = null;
	await vi.waitFor(
		() => {
			pm = document.querySelector(".ProseMirror") as HTMLElement | null;
			expect(pm).toBeTruthy();
		},
		{ timeout: 3000 },
	);
	return pm!;
}

/** Focus the ProseMirror contenteditable and wait for it to be focused */
async function focusEditor(pm: HTMLElement) {
	pm.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(pm), { timeout: 1000 });
}

/**
 * Render the editor, wait for it to initialize, and return the Editor instance.
 * Useful for tests that need to type or manipulate content programmatically.
 */
async function renderAndGetEditor(props: Partial<Parameters<typeof PortableTextEditor>[0]> = {}) {
	let capturedEditor: Editor | null = null;
	const screen = await render(
		<PortableTextEditor
			onEditorReady={(editor) => {
				capturedEditor = editor;
			}}
			{...props}
		/>,
		{ wrapper: TestWrapper },
	);
	const pm = await waitForEditor();
	await vi.waitFor(() => expect(capturedEditor).toBeTruthy(), { timeout: 2000 });
	return { screen, editor: capturedEditor!, pm };
}

/**
 * Simulate typing text into the editor via TipTap's API.
 * This avoids browser keyboard API issues and is more reliable in tests.
 */
function typeIntoEditor(editor: Editor, text: string) {
	editor.chain().focus().insertContent(text).run();
}

// Shorthand block builders
function textBlock(
	text: string,
	opts: {
		style?: "normal" | "h1" | "h2" | "h3" | "blockquote";
		marks?: string[];
		listItem?: "bullet" | "number";
		level?: number;
		markDefs?: Array<{ _type: string; _key: string; [k: string]: unknown }>;
	} = {},
) {
	return {
		_type: "block" as const,
		_key: Math.random().toString(36).slice(2, 9),
		style: opts.style ?? "normal",
		...(opts.listItem ? { listItem: opts.listItem, level: opts.level ?? 1 } : {}),
		children: [
			{
				_type: "span" as const,
				_key: Math.random().toString(36).slice(2, 9),
				text,
				marks: opts.marks,
			},
		],
		markDefs: opts.markDefs,
	};
}

// =============================================================================
// 1. Portable Text ↔ ProseMirror Conversion (via component)
// =============================================================================

describe("Portable Text ↔ ProseMirror conversion", () => {
	it("renders a paragraph from PT value", async () => {
		await render(<PortableTextEditor value={[textBlock("Hello world")]} />, {
			wrapper: TestWrapper,
		});
		const pm = await waitForEditor();
		const p = pm.querySelector("p");
		expect(p).toBeTruthy();
		expect(p!.textContent).toBe("Hello world");
	});

	it("renders an h1 heading", async () => {
		await render(<PortableTextEditor value={[textBlock("Title", { style: "h1" })]} />);
		const pm = await waitForEditor();
		const h1 = pm.querySelector("h1");
		expect(h1).toBeTruthy();
		expect(h1!.textContent).toBe("Title");
	});

	it("renders bold text", async () => {
		await render(<PortableTextEditor value={[textBlock("Bold text", { marks: ["strong"] })]} />);
		const pm = await waitForEditor();
		const strong = pm.querySelector("strong");
		expect(strong).toBeTruthy();
		expect(strong!.textContent).toBe("Bold text");
	});

	it("renders a link from markDef", async () => {
		const linkKey = "lnk1";
		await render(
			<PortableTextEditor
				value={[
					textBlock("Click me", {
						marks: [linkKey],
						markDefs: [{ _type: "link", _key: linkKey, href: "https://example.com" }],
					}),
				]}
			/>,
		);
		const pm = await waitForEditor();
		const anchor = pm.querySelector("a");
		expect(anchor).toBeTruthy();
		expect(anchor!.textContent).toBe("Click me");
		expect(anchor!.getAttribute("href")).toBe("https://example.com");
	});

	it("renders a bullet list", async () => {
		await render(
			<PortableTextEditor
				value={[
					textBlock("Item one", { listItem: "bullet" }),
					textBlock("Item two", { listItem: "bullet" }),
				]}
			/>,
		);
		const pm = await waitForEditor();
		const ul = pm.querySelector("ul");
		expect(ul).toBeTruthy();
		const items = ul!.querySelectorAll("li");
		expect(items.length).toBe(2);
		expect(items[0]!.textContent).toBe("Item one");
		expect(items[1]!.textContent).toBe("Item two");
	});

	it("renders an ordered list", async () => {
		await render(
			<PortableTextEditor
				value={[
					textBlock("First", { listItem: "number" }),
					textBlock("Second", { listItem: "number" }),
				]}
			/>,
		);
		const pm = await waitForEditor();
		const ol = pm.querySelector("ol");
		expect(ol).toBeTruthy();
		const items = ol!.querySelectorAll("li");
		expect(items.length).toBe(2);
	});

	it("renders a blockquote", async () => {
		await render(
			<PortableTextEditor value={[textBlock("A wise quote", { style: "blockquote" })]} />,
		);
		const pm = await waitForEditor();
		const bq = pm.querySelector("blockquote");
		expect(bq).toBeTruthy();
		expect(bq!.textContent).toBe("A wise quote");
	});

	it("renders a code block", async () => {
		await render(
			<PortableTextEditor
				value={[{ _type: "code", _key: "c1", code: "const x = 1", language: "js" }]}
			/>,
		);
		const pm = await waitForEditor();
		const pre = pm.querySelector("pre");
		expect(pre).toBeTruthy();
		expect(pre!.textContent).toContain("const x = 1");
	});

	it("renders an image block", async () => {
		await render(
			<PortableTextEditor
				value={[
					{
						_type: "image",
						_key: "img1",
						asset: { _ref: "img-1", url: "/test.jpg" },
						alt: "Test image",
					},
				]}
			/>,
		);
		const pm = await waitForEditor();
		// The mock ImageExtension renders as <img>
		const img = pm.querySelector("img");
		expect(img).toBeTruthy();
		expect(img!.getAttribute("src")).toBe("/test.jpg");
	});

	it("renders a horizontal rule", async () => {
		await render(
			<PortableTextEditor
				value={[
					textBlock("Above"),
					{ _type: "break", _key: "hr1", style: "lineBreak" },
					textBlock("Below"),
				]}
			/>,
		);
		const pm = await waitForEditor();
		const hr = pm.querySelector("hr");
		expect(hr).toBeTruthy();
	});

	it("renders empty editor when value is empty array", async () => {
		await render(<PortableTextEditor value={[]} placeholder="Write here..." />);
		const pm = await waitForEditor();
		// Empty editor should have a single empty paragraph
		const paragraphs = pm.querySelectorAll("p");
		expect(paragraphs.length).toBeGreaterThanOrEqual(1);
		// Placeholder should appear
		expect(pm.textContent).toBe("");
	});

	it("renders empty editor when value is undefined", async () => {
		await render(<PortableTextEditor placeholder="Start..." />);
		const pm = await waitForEditor();
		expect(pm).toBeTruthy();
		// Empty editor — no meaningful text
		const textContent = pm.textContent ?? "";
		expect(textContent.trim()).toBe("");
	});

	it("renders bold+italic text with multiple marks", async () => {
		await render(
			<PortableTextEditor value={[textBlock("Bold italic", { marks: ["strong", "em"] })]} />,
		);
		const pm = await waitForEditor();
		const strong = pm.querySelector("strong");
		const em = pm.querySelector("em");
		expect(strong).toBeTruthy();
		expect(em).toBeTruthy();
		// The text is wrapped in both marks
		expect(pm.textContent).toContain("Bold italic");
	});

	it("fires onChange with valid PT blocks when typing", async () => {
		const onChange = vi.fn();
		const { editor } = await renderAndGetEditor({ onChange });

		typeIntoEditor(editor, "Hello");

		await vi.waitFor(
			() => {
				expect(onChange).toHaveBeenCalled();
			},
			{ timeout: 2000 },
		);

		const lastCall = onChange.mock.calls.at(-1)!;
		const blocks = lastCall[0] as Array<{ _type: string }>;
		expect(blocks.length).toBeGreaterThan(0);
		expect(blocks[0]!._type).toBe("block");
	});
});

// =============================================================================
// 2. Editor Component Behaviour
// =============================================================================

describe("Editor component behaviour", () => {
	it("shows placeholder text in empty editor", async () => {
		await render(<PortableTextEditor placeholder="Write something..." />);
		const pm = await waitForEditor();
		// TipTap sets placeholder via data-placeholder or a .is-empty class
		// Check for the placeholder content in a before pseudo-element or attribute
		const placeholderEl = pm.querySelector("[data-placeholder]");
		if (placeholderEl) {
			expect(placeholderEl.getAttribute("data-placeholder")).toBe("Write something...");
		} else {
			// Fallback: check the class-based placeholder
			const emptyNode = pm.querySelector(".is-empty, .is-editor-empty");
			expect(emptyNode).toBeTruthy();
		}
	});

	it("sets contenteditable=false when editable is false", async () => {
		await render(<PortableTextEditor editable={false} value={[textBlock("Read only")]} />);
		const pm = await waitForEditor();
		expect(pm.getAttribute("contenteditable")).toBe("false");
	});

	it("sets contenteditable=true by default", async () => {
		await render(<PortableTextEditor value={[textBlock("Editable")]} />);
		const pm = await waitForEditor();
		expect(pm.getAttribute("contenteditable")).toBe("true");
	});

	it("applies spotlight-mode class when focusMode is spotlight", async () => {
		await render(<PortableTextEditor focusMode="spotlight" value={[textBlock("Focused")]} />);
		await waitForEditor();
		const wrapper = document.querySelector(".spotlight-mode");
		expect(wrapper).toBeTruthy();
	});

	it("does not apply spotlight-mode class when focusMode is normal", async () => {
		await render(<PortableTextEditor focusMode="normal" value={[textBlock("Normal")]} />);
		await waitForEditor();
		const wrapper = document.querySelector(".spotlight-mode");
		expect(wrapper).toBeNull();
	});

	it("calls onFocusModeChange when spotlight button is clicked", async () => {
		const onFocusModeChange = vi.fn();
		const screen = await render(
			<PortableTextEditor
				focusMode="normal"
				onFocusModeChange={onFocusModeChange}
				value={[textBlock("Test")]}
			/>,
		);
		await waitForEditor();

		// The spotlight button has aria-label containing "Spotlight Mode"
		const spotlightBtn = screen.getByRole("button", { name: SPOTLIGHT_MODE_PATTERN });
		await spotlightBtn.click();
		expect(onFocusModeChange).toHaveBeenCalledWith("spotlight");
	});

	it("hides toolbar and footer in minimal mode", async () => {
		await render(<PortableTextEditor minimal={true} value={[textBlock("Minimal")]} />);
		await waitForEditor();
		// Toolbar has role="toolbar" — should not exist
		const toolbar = document.querySelector('[role="toolbar"]');
		expect(toolbar).toBeNull();
		// Footer shows word count — should not exist
		const footer = document.querySelector(".border-t");
		expect(footer).toBeNull();
	});

	it("calls onEditorReady with Editor instance", async () => {
		const onEditorReady = vi.fn();
		await render(<PortableTextEditor onEditorReady={onEditorReady} value={[textBlock("Ready")]} />);
		await waitForEditor();

		await vi.waitFor(() => expect(onEditorReady).toHaveBeenCalledTimes(1), { timeout: 2000 });

		const editorArg = onEditorReady.mock.calls[0]![0] as Editor;
		expect(editorArg).toBeTruthy();
		expect(typeof editorArg.getJSON).toBe("function");
		expect(typeof editorArg.chain).toBe("function");
	});

	it("shows word count and character count in footer", async () => {
		await render(<PortableTextEditor value={[textBlock("One two three")]} />);
		await waitForEditor();

		await vi.waitFor(
			() => {
				const text = document.body.textContent ?? "";
				expect(text).toContain("words");
				expect(text).toContain("characters");
				expect(text).toContain("min read");
			},
			{ timeout: 2000 },
		);
	});
});

// =============================================================================
// 3. Toolbar
// =============================================================================

describe("Toolbar", () => {
	async function renderWithToolbar() {
		const screen = await render(<PortableTextEditor value={[textBlock("Toolbar test")]} />);
		await waitForEditor();
		return screen;
	}

	it("renders a toolbar with text formatting aria-label", async () => {
		const screen = await renderWithToolbar();
		const toolbar = screen.getByRole("toolbar");
		await expect.element(toolbar).toHaveAttribute("aria-label", "Text formatting");
	});

	it("has inline formatting buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Bold" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Italic" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Underline" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Strikethrough" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Inline Code" })).toBeInTheDocument();
	});

	it("has heading buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Heading 1" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Heading 2" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Heading 3" })).toBeInTheDocument();
	});

	it("has list buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Bullet List" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Numbered List" })).toBeInTheDocument();
	});

	it("has block buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Quote" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Code Block" })).toBeInTheDocument();
	});

	it("has alignment buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Align Left" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Align Center" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Align Right" })).toBeInTheDocument();
	});

	it("has insert buttons", async () => {
		const screen = await renderWithToolbar();
		await expect.element(screen.getByRole("button", { name: "Insert Link" })).toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Insert Image" })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Insert Horizontal Rule" }))
			.toBeInTheDocument();
	});

	it("has history buttons (initially disabled)", async () => {
		const screen = await renderWithToolbar();
		const undoBtn = screen.getByRole("button", { name: "Undo" });
		const redoBtn = screen.getByRole("button", { name: "Redo" });
		await expect.element(undoBtn).toBeInTheDocument();
		await expect.element(redoBtn).toBeInTheDocument();
		await expect.element(undoBtn).toBeDisabled();
		await expect.element(redoBtn).toBeDisabled();
	});

	it("has spotlight mode button", async () => {
		const screen = await renderWithToolbar();
		await expect
			.element(screen.getByRole("button", { name: SPOTLIGHT_MODE_PATTERN }))
			.toBeInTheDocument();
	});

	it("toggles bold aria-pressed when clicked", async () => {
		const screen = await renderWithToolbar();
		const pm = document.querySelector(".ProseMirror") as HTMLElement;
		await focusEditor(pm);

		const boldBtn = screen.getByRole("button", { name: "Bold" });
		await expect.element(boldBtn).toHaveAttribute("aria-pressed", "false");

		await boldBtn.click();

		await vi.waitFor(
			async () => {
				await expect.element(boldBtn).toHaveAttribute("aria-pressed", "true");
			},
			{ timeout: 2000 },
		);
	});

	it("toggles italic aria-pressed when clicked", async () => {
		const screen = await renderWithToolbar();
		const pm = document.querySelector(".ProseMirror") as HTMLElement;
		await focusEditor(pm);

		const italicBtn = screen.getByRole("button", { name: "Italic" });
		await expect.element(italicBtn).toHaveAttribute("aria-pressed", "false");

		await italicBtn.click();

		await vi.waitFor(
			async () => {
				await expect.element(italicBtn).toHaveAttribute("aria-pressed", "true");
			},
			{ timeout: 2000 },
		);
	});

	it("toggles Heading 1 aria-pressed when clicked", async () => {
		const screen = await renderWithToolbar();
		const pm = document.querySelector(".ProseMirror") as HTMLElement;
		await focusEditor(pm);

		const h1Btn = screen.getByRole("button", { name: "Heading 1" });
		await expect.element(h1Btn).toHaveAttribute("aria-pressed", "false");

		await h1Btn.click();

		await vi.waitFor(
			async () => {
				await expect.element(h1Btn).toHaveAttribute("aria-pressed", "true");
			},
			{ timeout: 2000 },
		);
	});

	it("enables Undo after typing and Redo after undoing", async () => {
		let editorRef: Editor | null = null;
		const screen = await render(
			<PortableTextEditor
				value={[textBlock("Toolbar test")]}
				onEditorReady={(editor) => {
					editorRef = editor;
				}}
			/>,
		);
		await waitForEditor();
		await vi.waitFor(() => expect(editorRef).toBeTruthy(), { timeout: 2000 });

		const undoBtn = screen.getByRole("button", { name: "Undo" });
		const redoBtn = screen.getByRole("button", { name: "Redo" });

		// Initially both disabled
		await expect.element(undoBtn).toBeDisabled();
		await expect.element(redoBtn).toBeDisabled();

		// Type something via editor API
		typeIntoEditor(editorRef!, "Some text");

		// Undo should become enabled
		await vi.waitFor(
			async () => {
				await expect.element(undoBtn).toBeEnabled();
			},
			{ timeout: 2000 },
		);

		// Click undo
		await undoBtn.click();

		// Redo should become enabled
		await vi.waitFor(
			async () => {
				await expect.element(redoBtn).toBeEnabled();
			},
			{ timeout: 2000 },
		);
	});

	it("toggles spotlight mode button aria-pressed", async () => {
		const onFocusModeChange = vi.fn();
		const screen = await render(
			<PortableTextEditor
				focusMode="normal"
				onFocusModeChange={onFocusModeChange}
				value={[textBlock("Test")]}
			/>,
		);
		await waitForEditor();

		const btn = screen.getByRole("button", { name: SPOTLIGHT_MODE_PATTERN });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
	});

	it("spotlight button shows pressed when focusMode is spotlight", async () => {
		const screen = await render(
			<PortableTextEditor
				focusMode="spotlight"
				onFocusModeChange={() => {}}
				value={[textBlock("Focused")]}
			/>,
		);
		await waitForEditor();

		const btn = screen.getByRole("button", { name: SPOTLIGHT_MODE_PATTERN });
		await expect.element(btn).toHaveAttribute("aria-pressed", "true");
	});

	it("toolbar not present in minimal mode", async () => {
		await render(<PortableTextEditor minimal={true} value={[textBlock("Minimal")]} />);
		await waitForEditor();
		const toolbar = document.querySelector('[role="toolbar"]');
		expect(toolbar).toBeNull();
	});
});

// =============================================================================
// 4. Slash Commands
// =============================================================================

describe("Slash commands", () => {
	it("renders without errors with default commands", async () => {
		await render(<PortableTextEditor value={[textBlock("Slash test")]} />);
		const pm = await waitForEditor();
		expect(pm).toBeTruthy();
	});

	it("renders without errors with pluginBlocks prop", async () => {
		const pluginBlocks: PluginBlockDef[] = [
			{ type: "youtube", pluginId: "embeds", label: "YouTube Video" },
			{ type: "tweet", pluginId: "social", label: "Tweet" },
		];
		await render(
			<PortableTextEditor value={[textBlock("Plugin test")]} pluginBlocks={pluginBlocks} />,
		);
		const pm = await waitForEditor();
		expect(pm).toBeTruthy();
	});

	it("editor accepts pluginBlocks without crashing when typing", async () => {
		const pluginBlocks: PluginBlockDef[] = [
			{ type: "youtube", pluginId: "embeds", label: "YouTube Video" },
		];
		const onChange = vi.fn();
		const { editor } = await renderAndGetEditor({
			pluginBlocks,
			onChange,
		});

		typeIntoEditor(editor, "Hello");

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });
	});
});

// =============================================================================
// 5. Round-trip: onChange output shape
// =============================================================================

describe("onChange output shape", () => {
	it("onChange returns blocks with _type and _key", async () => {
		const onChange = vi.fn();
		const { editor } = await renderAndGetEditor({ onChange });

		typeIntoEditor(editor, "Test");

		await vi.waitFor(() => expect(onChange).toHaveBeenCalled(), { timeout: 2000 });

		const blocks = onChange.mock.calls.at(-1)![0] as Array<{
			_type: string;
			_key: string;
			children?: Array<{ _type: string; text: string }>;
		}>;
		expect(blocks.length).toBeGreaterThan(0);
		const block = blocks[0]!;
		expect(block._type).toBe("block");
		expect(typeof block._key).toBe("string");
		expect(block.children).toBeDefined();
		expect(block.children!.length).toBeGreaterThan(0);
		expect(block.children![0]!._type).toBe("span");
		expect(block.children![0]!.text).toContain("Test");
	});

	it("heading value roundtrips through onEditorReady", async () => {
		let capturedEditor: Editor | null = null;
		const value = [textBlock("My Heading", { style: "h1" })];

		await render(
			<PortableTextEditor
				value={value}
				onEditorReady={(editor) => {
					capturedEditor = editor;
				}}
			/>,
		);
		await waitForEditor();

		await vi.waitFor(() => expect(capturedEditor).toBeTruthy(), { timeout: 2000 });

		// Verify the editor has a heading node
		const json = capturedEditor!.getJSON();
		const headingNode = json.content?.find((n: { type: string }) => n.type === "heading");
		expect(headingNode).toBeTruthy();
		expect((headingNode as { attrs?: { level?: number } }).attrs?.level).toBe(1);
	});

	it("code block value roundtrips through onEditorReady", async () => {
		let capturedEditor: Editor | null = null;
		const value = [{ _type: "code" as const, _key: "c1", code: "let a = 1;", language: "js" }];

		await render(
			<PortableTextEditor
				value={value}
				onEditorReady={(editor) => {
					capturedEditor = editor;
				}}
			/>,
		);
		await waitForEditor();

		await vi.waitFor(() => expect(capturedEditor).toBeTruthy(), { timeout: 2000 });

		const json = capturedEditor!.getJSON();
		const codeNode = json.content?.find((n: { type: string }) => n.type === "codeBlock");
		expect(codeNode).toBeTruthy();
	});

	it("list value roundtrips through onEditorReady", async () => {
		let capturedEditor: Editor | null = null;
		const value = [
			textBlock("Alpha", { listItem: "bullet" }),
			textBlock("Beta", { listItem: "bullet" }),
		];

		await render(
			<PortableTextEditor
				value={value}
				onEditorReady={(editor) => {
					capturedEditor = editor;
				}}
			/>,
		);
		await waitForEditor();

		await vi.waitFor(() => expect(capturedEditor).toBeTruthy(), { timeout: 2000 });

		const json = capturedEditor!.getJSON();
		const listNode = json.content?.find((n: { type: string }) => n.type === "bulletList");
		expect(listNode).toBeTruthy();
	});
});
