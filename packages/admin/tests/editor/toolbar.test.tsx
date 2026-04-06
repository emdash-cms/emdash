import type { Editor } from "@tiptap/core";
import { userEvent } from "@vitest/browser/context";
import { describe, it, expect, vi } from "vitest";
import { render } from "vitest-browser-react";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";

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

const defaultValue = [
	{
		_type: "block" as const,
		_key: "1",
		style: "normal" as const,
		children: [{ _type: "span" as const, _key: "s1", text: "Hello world" }],
	},
];

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	let editorInstance: Editor | null = null;
	const onEditorReady = (editor: Editor) => {
		editorInstance = editor;
	};

	const screen = await render(
		<PortableTextEditor value={defaultValue} onEditorReady={onEditorReady} {...props} />,
	);

	// Wait for TipTap to initialize
	await vi.waitFor(
		() => {
			expect(document.querySelector(".ProseMirror")).toBeTruthy();
		},
		{ timeout: 3000 },
	);

	return { screen, editor: editorInstance! };
}

/** Focus the ProseMirror editor and select all text */
async function focusAndSelectAll(screen: Awaited<ReturnType<typeof render>>) {
	const prosemirror = screen.container.querySelector(".ProseMirror") as HTMLElement;
	prosemirror.focus();
	await vi.waitFor(() => expect(document.activeElement).toBe(prosemirror), { timeout: 1000 });
	// Use Control on Linux CI, Meta on macOS
	const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
	const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";
	await userEvent.keyboard(`${mod}{a}${modUp}`);
}

function getBoldButton(screen: Awaited<ReturnType<typeof render>>) {
	return screen.getByRole("toolbar", { name: "Text formatting" }).getByRole("button", { name: "Bold" });
}

// =============================================================================
// 1. Toolbar Presence and Structure
// =============================================================================

describe("Toolbar Presence and Structure", () => {
	it("has role='toolbar' with correct aria-label", async () => {
		const { screen } = await renderEditor();
		const toolbar = screen.getByRole("toolbar");
		await expect.element(toolbar).toHaveAttribute("aria-label", "Text formatting");
	});

	it("has all formatting buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(getBoldButton(screen)).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Italic" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Underline" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Strikethrough" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Inline Code" })).toBeVisible();
	});

	it("has all heading buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Heading 1" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Heading 2" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Heading 3" })).toBeVisible();
	});

	it("has all list buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Bullet List" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Numbered List" })).toBeVisible();
	});

	it("has all block buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Quote" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Code Block" })).toBeVisible();
	});

	it("has all alignment buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Align Left" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Align Center" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Align Right" })).toBeVisible();
	});

	it("has all insert buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Insert Link" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Insert Image" })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Insert Horizontal Rule" }))
			.toBeVisible();
	});

	it("has history buttons", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Undo" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Redo" })).toBeVisible();
	});

	it("has Spotlight Mode button", async () => {
		const { screen } = await renderEditor();
		await expect.element(screen.getByRole("button", { name: "Spotlight Mode" })).toBeVisible();
	});

	it("hides toolbar when minimal={true}", async () => {
		const { screen } = await renderEditor({ minimal: true });
		const toolbar = screen.container.querySelector('[role="toolbar"]');
		expect(toolbar).toBeNull();
	});
});

// =============================================================================
// 2. Formatting Button Toggle States
// =============================================================================

describe("Formatting Button Toggle States", () => {
	it("Bold: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getBoldButton(screen);
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Italic: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = screen.getByRole("button", { name: "Italic" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Underline: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = screen.getByRole("button", { name: "Underline" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Strikethrough: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = screen.getByRole("button", { name: "Strikethrough" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Inline Code: click toggles aria-pressed to true", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = screen.getByRole("button", { name: "Inline Code" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Heading 1: click toggles aria-pressed to true and changes to h1", async () => {
		const { screen, editor } = await renderEditor();
		// Focus editor and place cursor (block commands need cursor in a paragraph)
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Heading 1" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
			expect(editor.isActive("heading", { level: 1 })).toBe(true);
		});
	});

	it("Heading 2: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Heading 2" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Heading 3: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Heading 3" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Bullet List: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Bullet List" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Numbered List: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Numbered List" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Quote: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Quote" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Code Block: click toggles aria-pressed to true", async () => {
		const { screen, editor } = await renderEditor();
		editor.commands.focus();

		const btn = screen.getByRole("button", { name: "Code Block" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});
	});

	it("Toggle off: clicking Bold twice returns aria-pressed to false", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const btn = getBoldButton(screen);

		// First click: on
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});

		// Second click: off
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("false");
		});
	});
});

// =============================================================================
// 3. Text Alignment
// =============================================================================

describe("Text Alignment", () => {
	it("Align Center becomes pressed, Align Left becomes unpressed", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignCenter = screen.getByRole("button", { name: "Align Center" });

		alignCenter.element().click();

		await vi.waitFor(() => {
			expect(alignCenter.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("false");
		});
	});

	it("Align Right becomes pressed, others unpressed", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignCenter = screen.getByRole("button", { name: "Align Center" });
		const alignRight = screen.getByRole("button", { name: "Align Right" });

		alignRight.element().click();

		await vi.waitFor(() => {
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("false");
			expect(alignCenter.element().getAttribute("aria-pressed")).toBe("false");
		});
	});

	it("Align Left becomes pressed after switching from another alignment", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const alignLeft = screen.getByRole("button", { name: "Align Left" });
		const alignRight = screen.getByRole("button", { name: "Align Right" });

		// First switch to right
		alignRight.element().click();
		await vi.waitFor(() => {
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("true");
		});

		// Then switch back to left
		alignLeft.element().click();
		await vi.waitFor(() => {
			expect(alignLeft.element().getAttribute("aria-pressed")).toBe("true");
			expect(alignRight.element().getAttribute("aria-pressed")).toBe("false");
		});
	});
});

// =============================================================================
// 4. Undo/Redo
// =============================================================================

describe("Undo/Redo", () => {
	it("initially Undo and Redo are disabled", async () => {
		const { screen } = await renderEditor();

		const undo = screen.getByRole("button", { name: "Undo" });
		const redo = screen.getByRole("button", { name: "Redo" });

		await expect.element(undo).toBeDisabled();
		await expect.element(redo).toBeDisabled();
	});

	it("after making a change, Undo becomes enabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change - toggle bold
		getBoldButton(screen).element().click();

		const undo = screen.getByRole("button", { name: "Undo" });
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
	});

	it("after undo, Redo becomes enabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change
		getBoldButton(screen).element().click();

		const undo = screen.getByRole("button", { name: "Undo" });
		const redo = screen.getByRole("button", { name: "Redo" });

		// Wait for undo to be enabled, then click it
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		undo.element().click();

		await vi.waitFor(
			() => {
				expect(redo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
	});

	it("after redo, Undo is enabled and Redo is disabled", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		// Make a change
		getBoldButton(screen).element().click();

		const undo = screen.getByRole("button", { name: "Undo" });
		const redo = screen.getByRole("button", { name: "Redo" });

		// Undo
		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		undo.element().click();

		// Redo
		await vi.waitFor(
			() => {
				expect(redo.element().disabled).toBe(false);
			},
			{ timeout: 3000 },
		);
		redo.element().click();

		await vi.waitFor(
			() => {
				expect(undo.element().disabled).toBe(false);
				expect(redo.element().disabled).toBe(true);
			},
			{ timeout: 3000 },
		);
	});
});

// =============================================================================
// 5. Link Insertion (Toolbar Popover)
// =============================================================================

describe("Link Insertion", () => {
	it("clicking Insert Link opens a popover with URL input", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		const linkBtn = screen.getByRole("button", { name: "Insert Link" });
		linkBtn.element().click();

		await vi.waitFor(() => {
			const input = screen.container.querySelector('input[type="url"]');
			expect(input).toBeTruthy();
		});
	});

	it("popover has Cancel and Apply buttons", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
			expect(screen.getByRole("button", { name: "Apply" })).toBeTruthy();
		});
	});

	it("typing URL and clicking Apply sets the link", async () => {
		const { screen, editor } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.container.querySelector('input[type="url"]')).toBeTruthy();
		});

		const input = screen.container.querySelector('input[type="url"]') as HTMLInputElement;
		// Focus input and type URL
		input.focus();
		// Use native input value setter to trigger React's onChange
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(input, "https://example.com");
		input.dispatchEvent(new Event("input", { bubbles: true }));
		input.dispatchEvent(new Event("change", { bubbles: true }));

		screen.getByRole("button", { name: "Apply" }).element().click();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
		});
	});

	it("clicking Cancel closes the popover", async () => {
		const { screen } = await renderEditor();
		await focusAndSelectAll(screen);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.container.querySelector('input[type="url"]')).toBeTruthy();
		});

		screen.getByRole("button", { name: "Cancel" }).element().click();

		await vi.waitFor(() => {
			expect(screen.container.querySelector('input[type="url"]')).toBeNull();
		});
	});

	it("Remove button appears when link already exists", async () => {
		const { screen, editor } = await renderEditor();
		await focusAndSelectAll(screen);

		// Set a link programmatically
		editor.chain().focus().setLink({ href: "https://example.com" }).run();

		await vi.waitFor(() => {
			expect(editor.isActive("link")).toBe(true);
		});

		// Re-select all to ensure cursor is in the link
		const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
		const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";
		await userEvent.keyboard(`${mod}{a}${modUp}`);

		screen.getByRole("button", { name: "Insert Link" }).element().click();

		await vi.waitFor(() => {
			expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
		});
	});
});

// =============================================================================
// 6. Focus Mode Toggle
// =============================================================================

describe("Focus Mode Toggle", () => {
	it("initially Spotlight Mode aria-pressed is false", async () => {
		const { screen } = await renderEditor();
		const btn = screen.getByRole("button", { name: "Spotlight Mode" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "false");
	});

	it("clicking Spotlight Mode toggles aria-pressed to true and adds class", async () => {
		const { screen } = await renderEditor();
		const btn = screen.getByRole("button", { name: "Spotlight Mode" });

		btn.element().click();

		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
			// The wrapper div should have the spotlight-mode class
			const wrapper = screen.container.querySelector(".spotlight-mode");
			expect(wrapper).toBeTruthy();
		});
	});

	it("clicking Spotlight Mode again toggles back to false and removes class", async () => {
		const { screen } = await renderEditor();
		const btn = screen.getByRole("button", { name: "Spotlight Mode" });

		// Toggle on
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("true");
		});

		// Toggle off
		btn.element().click();
		await vi.waitFor(() => {
			expect(btn.element().getAttribute("aria-pressed")).toBe("false");
			expect(screen.container.querySelector(".spotlight-mode")).toBeNull();
		});
	});

	it("with controlled focusMode prop, reflects external state", async () => {
		const { screen } = await renderEditor({ focusMode: "spotlight" });

		// The button title changes to "Exit Spotlight Mode" when active
		const btn = screen.getByRole("button", { name: "Exit Spotlight Mode" });
		await expect.element(btn).toHaveAttribute("aria-pressed", "true");

		const wrapper = screen.container.querySelector(".spotlight-mode");
		expect(wrapper).toBeTruthy();
	});

	it("with onFocusModeChange callback, fires with correct mode", async () => {
		const onFocusModeChange = vi.fn();
		const { screen } = await renderEditor({
			focusMode: "normal",
			onFocusModeChange,
		});

		const btn = screen.getByRole("button", { name: "Spotlight Mode" });
		btn.element().click();

		await vi.waitFor(() => {
			expect(onFocusModeChange).toHaveBeenCalledWith("spotlight");
		});
	});
});

// =============================================================================
// 7. WAI-ARIA Keyboard Navigation
// =============================================================================

describe("WAI-ARIA Keyboard Navigation", () => {
	it("ArrowRight from Bold moves focus to Italic", async () => {
		const { screen } = await renderEditor();

		const bold = getBoldButton(screen);
		const italic = screen.getByRole("button", { name: "Italic" });

		// Focus the Bold button
		bold.element().focus();
		expect(document.activeElement).toBe(bold.element());

		// Press ArrowRight
		await userEvent.keyboard("{ArrowRight}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(italic.element());
		});
	});

	it("ArrowLeft from Italic moves focus to Bold", async () => {
		const { screen } = await renderEditor();

		const bold = getBoldButton(screen);
		const italic = screen.getByRole("button", { name: "Italic" });

		// Focus the Italic button
		italic.element().focus();
		expect(document.activeElement).toBe(italic.element());

		// Press ArrowLeft
		await userEvent.keyboard("{ArrowLeft}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(bold.element());
		});
	});

	it("Home moves focus to first button", async () => {
		const { screen } = await renderEditor();

		const bold = getBoldButton(screen);
		const alignCenter = screen.getByRole("button", { name: "Align Center" });

		// Focus a button in the middle
		alignCenter.element().focus();

		// Press Home
		await userEvent.keyboard("{Home}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(bold.element());
		});
	});

	it("End moves focus to last button", async () => {
		const { screen } = await renderEditor();

		const bold = getBoldButton(screen);

		// Focus the first button
		bold.element().focus();

		// Press End — last button is Spotlight Mode (or Exit Spotlight Mode)
		await userEvent.keyboard("{End}");

		await vi.waitFor(() => {
			const active = document.activeElement as HTMLElement;
			// Last button in the toolbar — its aria-label should be "Spotlight Mode"
			expect(active.getAttribute("aria-label")).toBe("Spotlight Mode");
		});
	});

	it("ArrowRight wraps from last to first button", async () => {
		const { screen } = await renderEditor();

		const spotlightBtn = screen.getByRole("button", { name: "Spotlight Mode" });
		const bold = getBoldButton(screen);

		// Focus the last button
		spotlightBtn.element().focus();

		// Press ArrowRight - should wrap to first
		await userEvent.keyboard("{ArrowRight}");

		await vi.waitFor(() => {
			expect(document.activeElement).toBe(bold.element());
		});
	});

	it("ArrowLeft wraps from first to last button", async () => {
		const { screen } = await renderEditor();

		const bold = getBoldButton(screen);

		// Focus the first button
		bold.element().focus();

		// Press ArrowLeft - should wrap to last
		await userEvent.keyboard("{ArrowLeft}");

		await vi.waitFor(() => {
			const active = document.activeElement as HTMLElement;
			expect(active.getAttribute("aria-label")).toBe("Spotlight Mode");
		});
	});
});
