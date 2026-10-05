/**
 * The image block's empty state through the full editor: inserting from /image,
 * the toolbar and the gutter opens the picker, closing it leaves a placeholder
 * to fill later, and the placeholder's keyboard, toolbar and read-only states.
 */

import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { fetchMediaItem, type MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render";

import "../../src/styles.css";

const picker = vi.hoisted(() => ({ item: null as unknown }));

vi.mock("../../src/components/MediaPickerModal", async () => {
	const { createPortal } = await import("react-dom");
	const { useEffect, useRef } = await import("react");
	return {
		MediaPickerModal: function MediaPickerModal({
			open,
			title,
			onSelect,
			onOpenChange,
		}: {
			open: boolean;
			title?: string;
			onSelect: (item: unknown) => void;
			onOpenChange: (open: boolean) => void;
		}) {
			// Like the real dialog, closing returns focus to where it was when the picker opened.
			const opener = useRef<Element | null>(null);
			useEffect(() => {
				if (open) opener.current = document.activeElement;
			}, [open]);
			const close = () => {
				onOpenChange(false);
				if (opener.current instanceof HTMLElement) opener.current.focus();
			};
			return open
				? createPortal(
						<div role="dialog" aria-label={title}>
							<button
								type="button"
								onClick={() => {
									onSelect(picker.item);
									close();
								}}
							>
								Choose image
							</button>
							<button type="button" onClick={close}>
								Cancel
							</button>
						</div>,
						document.body,
					)
				: null;
		},
	};
});
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
vi.mock("../../src/lib/api/media.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/media.js")>(
		"../../src/lib/api/media.js",
	);
	return { ...actual, fetchMediaItem: vi.fn() };
});

type Block = { _type: string; _key: string; [key: string]: unknown };

const INTRO: Block = {
	_type: "block",
	_key: "intro",
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "intro-span", text: "Intro", marks: [] }],
};

const OUTRO: Block = {
	...INTRO,
	_key: "outro",
	children: [{ _type: "span", _key: "outro-span", text: "Outro", marks: [] }],
};

const EMPTY: Block = { _type: "image", _key: "image1", asset: { _ref: "", url: "" } };

const PHOTO: MediaItem = {
	id: "01IMAGE",
	filename: "photo.png",
	mimeType: "image/png",
	url: "/_emdash/api/media/file/01IMAGE.png",
	storageKey: "01IMAGE.png",
	size: 2048,
	width: 1200,
	height: 800,
	createdAt: "2026-10-05T00:00:00.000Z",
};

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	vi.mocked(fetchMediaItem).mockRejectedValue(new Error("Not in this test"));
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

function images(value: Block[]): Block[] {
	return value.filter((block) => block._type === "image");
}

function selectedNodeName(editor: Editor): string | null {
	const { selection } = editor.state;
	return selection instanceof NodeSelection ? selection.node.type.name : null;
}

/** Each top-level block's text, or the node's name for a block without text, like an image. */
function blockTexts(editor: Editor): string[] {
	const texts: string[] = [];
	editor.state.doc.forEach((block) =>
		texts.push(block.isAtom ? block.type.name : block.textContent),
	);
	return texts;
}

/** Wait out anything a key press started, so a test can tell that nothing happened. */
async function settle() {
	for (let frame = 0; frame < 2; frame++) {
		await new Promise((resolve) => requestAnimationFrame(resolve));
	}
}

function selectImageAt(editor: Editor, index: number) {
	let position = -1;
	let seen = 0;
	editor.state.doc.forEach((node, offset) => {
		if (node.type.name === "image" && seen++ === index) position = offset;
	});
	editor.view.focus();
	editor.commands.setNodeSelection(position);
}

type Screen = Awaited<ReturnType<typeof renderEditor>>["screen"];

/** Click the placeholder after writing in the paragraph above, then close the picker it opens. */
async function focusPlaceholder(screen: Screen, editor: Editor) {
	const placeholder = screen.getByRole("button", { name: "Upload or choose an image" });
	editor.view.focus();
	editor.commands.setTextSelection(3);
	await userEvent.click(placeholder);
	await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
	expect(document.activeElement).toBe(placeholder.element());
}

async function insertFromSlashMenu(editor: Editor) {
	editor.view.focus();
	editor.commands.setTextSelection(editor.state.doc.content.size - 1);
	await userEvent.keyboard("{Enter}/image");
	await vi.waitFor(() => expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy());
	await userEvent.keyboard("{Enter}");
}

describe("Image placeholder", () => {
	it("adds an image from /image through the picker that opens right away", async () => {
		picker.item = PHOTO;
		const { screen, editor, pm, latest } = await renderEditor({ value: [INTRO] });

		await insertFromSlashMenu(editor);
		await expect.element(screen.getByRole("dialog", { name: "Select image" })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));

		await vi.waitFor(() =>
			expect(images(latest())).toEqual([
				expect.objectContaining({
					asset: expect.objectContaining({ _ref: "01IMAGE", url: PHOTO.url }),
				}),
			]),
		);
		expect(document.querySelector("[data-media-placeholder]")).toBeNull();
		expect(selectedNodeName(editor)).toBe("image");
		expect(document.activeElement).toBe(pm);
	});

	it("keeps an empty image to fill later when the picker that opened is closed", async () => {
		const { screen, editor, pm, latest } = await renderEditor({ value: [INTRO] });

		await insertFromSlashMenu(editor);
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		await expect
			.element(screen.getByRole("button", { name: "Upload or choose an image" }))
			.toBeVisible();
		await vi.waitFor(() =>
			expect(images(latest())).toEqual([
				{ _type: "image", _key: expect.any(String), asset: { _ref: "", url: "" } },
			]),
		);
		expect(selectedNodeName(editor)).toBe("image");
		expect(document.activeElement).toBe(pm);
		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByRole("dialog", { name: "Select image" })).toBeVisible();
	});

	it("shows a saved empty image as a placeholder, and opens the picker only when it's clicked", async () => {
		const { screen, editor, latest } = await renderEditor({ value: [INTRO, EMPTY] });
		const placeholder = screen.getByRole("button", { name: "Upload or choose an image" });

		await expect.element(placeholder).toBeVisible();
		expect(document.querySelector('[role="dialog"]')).toBeNull();
		await userEvent.click(placeholder);
		await expect.element(screen.getByRole("dialog", { name: "Select image" })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));

		expect(selectedNodeName(editor)).toBe("image");
		expect(images(latest())).toEqual([EMPTY]);
	});

	it("stores a canonical provider when an external image URL is chosen", async () => {
		picker.item = {
			id: "",
			filename: "remote.jpg",
			mimeType: "image/jpeg",
			url: "https://media.example/remote.jpg",
			provider: "external-url",
			size: 0,
			createdAt: "2026-10-05T00:00:00.000Z",
		} satisfies MediaItem;
		const { screen, editor } = await renderEditor({ value: [INTRO, EMPTY] });

		await userEvent.click(screen.getByRole("button", { name: "Upload or choose an image" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose image" }));

		await vi.waitFor(() => {
			const image = editor.getJSON().content?.find((node) => node.type === "image");
			expect(image?.attrs).toMatchObject({
				src: "https://media.example/remote.jpg",
				mediaId: "",
				provider: "external",
			});
		});
	});

	it("adds an empty image from the toolbar and opens its picker", async () => {
		const { screen, editor, latest } = await renderEditor({ value: [INTRO] });
		editor.commands.focus("end");

		await userEvent.click(screen.getByRole("button", { name: "Insert Image" }));

		await expect.element(screen.getByRole("dialog", { name: "Select image" })).toBeVisible();
		await vi.waitFor(() => expect(images(latest())).toHaveLength(1));
	});

	it("undoes an image added from the gutter in one step", async () => {
		const { screen, editor } = await renderEditor({ value: [INTRO] });
		const before = editor.getJSON();

		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		const item = [...menu.querySelectorAll("button")].find(
			(button) => button.querySelector(".font-medium")?.textContent === "Image",
		);
		item!.click();
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await expect
			.element(screen.getByRole("button", { name: "Upload or choose an image" }))
			.toBeVisible();
		expect(document.activeElement).toBe(editor.view.dom);
		await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");

		expect(editor.getJSON()).toEqual(before);
	});

	it("deletes only the empty image when Backspace is pressed on its placeholder", async () => {
		const { screen, editor, latest } = await renderEditor({ value: [INTRO, EMPTY, OUTRO] });

		await focusPlaceholder(screen, editor);
		await userEvent.keyboard("{Backspace}");

		await vi.waitFor(() => expect(images(latest())).toEqual([]));
		expect(blockTexts(editor)).toEqual(["Intro", "Outro"]);
	});

	it("moves to the placeholder with Tab, and back to the block with Escape or Shift+Tab", async () => {
		const { screen, editor, pm } = await renderEditor({ value: [INTRO, EMPTY] });
		const placeholder = screen.getByRole("button", { name: "Upload or choose an image" }).element();

		selectImageAt(editor, 0);
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(placeholder);
		await userEvent.keyboard("{Escape}");
		expect(document.activeElement).toBe(pm);
		expect(selectedNodeName(editor)).toBe("image");

		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(placeholder);
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expect(document.activeElement).toBe(pm);
		expect(selectedNodeName(editor)).toBe("image");
	});

	it("leaves the text around an empty image alone for input method text on its placeholder", async () => {
		const { screen, editor } = await renderEditor({ value: [INTRO, EMPTY, OUTRO] });

		await focusPlaceholder(screen, editor);
		await cdp().send("Input.imeSetComposition", { text: "k", selectionStart: 1, selectionEnd: 1 });
		await cdp().send("Input.insertText", { text: "か" });
		await settle();

		expect(blockTexts(editor)).toEqual(["Intro", "image", "Outro"]);
	});

	it("shows the image toolbar for a selected image, but not for an empty one", async () => {
		const filled: Block = {
			_type: "image",
			_key: "image2",
			asset: { _ref: "01IMAGE", url: PHOTO.url },
		};
		const { screen, editor } = await renderEditor({ value: [EMPTY, filled] });
		const toolbar = screen.getByRole("group", { name: "Image controls" });

		selectImageAt(editor, 1);
		await expect.element(toolbar).toBeVisible();
		selectImageAt(editor, 0);
		await expect.element(toolbar).not.toBeInTheDocument();
	});

	it("highlights an empty image under dragged files, without an insertion line", async () => {
		const { screen } = await renderEditor({ value: [INTRO, EMPTY] });
		const placeholder = screen.getByRole("button", { name: "Upload or choose an image" }).element();
		const dataTransfer = new DataTransfer();
		dataTransfer.items.add(new File([new Uint8Array(8)], "photo.png", { type: "image/png" }));
		const rect = placeholder.getBoundingClientRect();
		for (const type of ["dragenter", "dragover"]) {
			placeholder.dispatchEvent(
				new DragEvent(type, {
					bubbles: true,
					cancelable: true,
					dataTransfer,
					clientX: rect.left + rect.width / 2,
					clientY: rect.top + rect.height / 2,
				}),
			);
		}

		await expect.element(screen.getByRole("button", { name: "Drop to upload" })).toBeVisible();
		expect(document.querySelector(".prosemirror-dropcursor-block")).toBeNull();
	});

	it("shows an empty image as a plain box in a read-only entry", async () => {
		const { screen } = await renderEditor({ value: [EMPTY], editable: false });

		await expect.element(screen.getByText("No image")).toBeVisible();
		expect(document.querySelector("[data-media-placeholder]")).toBeNull();
	});

	it("keeps its label out of the direction the editor reads from the text", async () => {
		const arabic: Block = {
			...INTRO,
			_key: "arabic",
			children: [{ _type: "span", _key: "arabic-span", text: "مرحبا بالعالم", marks: [] }],
		};
		const { screen, pm } = await renderEditor({ value: [EMPTY, arabic] });

		await expect.element(screen.getByText("Upload or choose an image")).toBeVisible();
		expect(getComputedStyle(pm).direction).toBe("rtl");
	});
});
