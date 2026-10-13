import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";

import {
	ImageDetailPanel,
	type ImagePanelAttributes,
} from "../../src/components/editor/ImageDetailPanel";
import {
	PortableTextEditor,
	type BlockSidebarPanel,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import type { MediaItem } from "../../src/lib/api";
import { fetchMediaItem, type LocalMediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

const REPLACEMENT: MediaItem = {
	id: "new-media",
	filename: "bike.jpg",
	mimeType: "image/jpeg",
	url: "/_emdash/api/media/file/bike.jpg",
	size: 100,
	width: 800,
	height: 600,
	alt: "A red bike",
	createdAt: "2026-09-29T00:00:00.000Z",
};

type PortableTextBlock = NonNullable<PortableTextEditorProps["value"]>[number];

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({
		open,
		onOpenChange,
		onSelect,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (item: MediaItem) => void;
	}) =>
		open ? (
			<div role="dialog" aria-label="Media picker">
				<button
					type="button"
					autoFocus
					onClick={() => {
						onSelect(REPLACEMENT);
						onOpenChange(false);
					}}
				>
					Choose replacement
				</button>
			</div>
		) : null,
}));

vi.mock("../../src/lib/api/media.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/media.js")>(
		"../../src/lib/api/media.js",
	);
	// Media items stay loading unless a test resolves them.
	return { ...actual, fetchMediaItem: vi.fn(() => new Promise<never>(() => {})) };
});

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

function imageBlock(fields: Record<string, unknown> = {}): PortableTextBlock {
	return {
		_type: "image",
		_key: "image-1",
		asset: { _ref: "cf-1", url: "/img.jpg", provider: "cloudflare-images" },
		alt: "Example",
		width: 400,
		height: 300,
		...fields,
	} as PortableTextBlock;
}

function paragraph(key: string, text: string): PortableTextBlock {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-span`, text }],
	} as PortableTextBlock;
}

function Host({
	value,
	withSettings,
	onReady,
	onPanel,
	onChange,
}: {
	value: PortableTextBlock[];
	withSettings: boolean;
	onReady: (editor: Editor | null) => void;
	onPanel: (panel: BlockSidebarPanel | null) => void;
	onChange: (value: PortableTextBlock[]) => void;
}) {
	const [panel, setPanel] = React.useState<BlockSidebarPanel | null>(null);
	React.useEffect(() => onPanel(panel), [onPanel, panel]);
	const close = React.useCallback(() => {
		setPanel((previous) => {
			previous?.onClose();
			return null;
		});
	}, []);
	return (
		<>
			<input aria-label="Title" />
			<PortableTextEditor
				value={value}
				onChange={onChange}
				onEditorReady={onReady}
				onBlockSidebarOpen={withSettings ? setPanel : undefined}
				onBlockSidebarClose={withSettings ? close : undefined}
			/>
			{panel && (
				<ImageDetailPanel
					attributes={panel.attrs as ImagePanelAttributes}
					onUpdate={panel.onUpdate}
					onReplace={panel.onReplace}
					onDelete={panel.onDelete}
					onClose={close}
				/>
			)}
		</>
	);
}

async function setup({
	image = {},
	withSettings = true,
	extraImage = false,
}: { image?: Record<string, unknown>; withSettings?: boolean; extraImage?: boolean } = {}) {
	let editor: Editor | null = null;
	let panel: BlockSidebarPanel | null = null;
	let saved: PortableTextBlock[] = [];
	await render(
		<Host
			value={[
				paragraph("p1", "Before"),
				imageBlock(image),
				paragraph("p2", "After"),
				...(extraImage ? [imageBlock({ _key: "image-2", alt: "Second" })] : []),
			]}
			withSettings={withSettings}
			onReady={(instance) => {
				editor = instance;
			}}
			onPanel={(value) => {
				panel = value;
			}}
			onChange={(value) => {
				saved = value;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeTruthy());
	const img = document.querySelector<HTMLImageElement>(".ProseMirror img")!;
	return {
		editor: editor!,
		pm: editor!.view.dom as HTMLElement,
		img,
		getPanel: () => panel,
		getSaved: () => saved,
		caption: document.querySelector<HTMLTextAreaElement>(
			'.ProseMirror textarea[aria-label="Caption"]',
		)!,
	};
}

function toolbarElement() {
	return document.querySelector<HTMLElement>("[data-emdash-image-bubble-menu]");
}

async function selectImage(img: HTMLElement) {
	await userEvent.click(img);
	return waitForToolbar();
}

async function waitForToolbar() {
	await vi.waitFor(() => expect(toolbarElement()).toBeVisible());
	return toolbarElement()!;
}

/** The text formatting bubble shows 120 ms after a non-empty selection. */
function pastTextBubbleDelay() {
	return new Promise((resolve) => setTimeout(resolve, 300));
}

function button(toolbar: HTMLElement, label: string) {
	const found = toolbar.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
	if (found) return found;
	const byText = [...toolbar.querySelectorAll<HTMLButtonElement>("button")].find(
		(candidate) => candidate.textContent === label,
	);
	if (!byText) throw new Error(`No "${label}" button in the image toolbar`);
	return byText;
}

function imageAttrs(editor: Editor) {
	let attrs: Record<string, unknown> | undefined;
	editor.state.doc.descendants((node) => {
		if (node.type.name === "image") attrs = node.attrs;
		return !attrs;
	});
	return attrs;
}

function expectImageSelected(editor: Editor) {
	const { selection } = editor.state;
	expect(selection instanceof NodeSelection && selection.node.type.name === "image").toBe(true);
}

describe("Image toolbar", () => {
	it("shows the image toolbar instead of the text formatting bubble for a clicked image", async () => {
		const { img } = await setup({ withSettings: false });
		const toolbar = await selectImage(img);

		for (const label of ["Replace", "Alt text", "Add link", "Delete image"]) {
			expect(button(toolbar, label)).toBeVisible();
		}
		expect(toolbar.querySelector('[aria-label="Image settings"]')).toBeNull();
		await pastTextBubbleDelay();
		expect(document.querySelector("[data-emdash-inline-bubble-menu]")).toBeNull();
	});

	it("keeps exactly one alignment pressed", async () => {
		const { editor, img } = await setup();
		const toolbar = await selectImage(img);
		const group = toolbar.querySelector<HTMLElement>('[role="group"][aria-label="Alignment"]')!;
		const pressed = () =>
			Array.from(group.querySelectorAll('[aria-pressed="true"]'), (el) =>
				el.getAttribute("aria-label"),
			);

		expect(pressed()).toEqual(["None"]);
		await userEvent.click(button(group, "Left"));
		await vi.waitFor(() => expect(pressed()).toEqual(["Left"]));
		expect(imageAttrs(editor)?.alignment).toBe("left");

		await userEvent.click(button(group, "Left"));
		expect(imageAttrs(editor)?.alignment).toBe("left");
		expect(pressed()).toEqual(["Left"]);

		await userEvent.click(button(group, "None"));
		await vi.waitFor(() => expect(pressed()).toEqual(["None"]));
		expect(imageAttrs(editor)?.alignment).toBeNull();
	});

	it("edits alt text in the toolbar", async () => {
		const { editor, pm, img, getPanel } = await setup();
		const toolbar = await selectImage(img);
		await userEvent.click(button(toolbar, "Image settings"));
		await vi.waitFor(() => expect(getPanel()).not.toBeNull());

		await userEvent.click(button(toolbar, "Alt text"));
		const input = toolbar.querySelector<HTMLInputElement>('input[aria-label="Alt text"]')!;
		await vi.waitFor(() => expect(document.activeElement).toBe(input));
		expect(input.value).toBe("Example");
		await userEvent.keyboard("Discarded{Escape}");

		expect(document.activeElement).toBe(pm);
		expectImageSelected(editor);
		expect(imageAttrs(editor)?.alt).toBe("Example");
		expect(getPanel()).not.toBeNull();

		await userEvent.click(button(toolbar, "Alt text"));
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(toolbar.querySelector('input[aria-label="Alt text"]')),
		);
		await userEvent.keyboard("  A red bike  {Enter}");

		await vi.waitFor(() => expect(imageAttrs(editor)?.alt).toBe("A red bike"));
		expect(document.activeElement).toBe(pm);
		expectImageSelected(editor);
		await vi.waitFor(() => expect(getPanel()).toBeNull());
	});

	it("cancels link editing without changing the link", async () => {
		const { editor, pm, img } = await setup({ image: { link: { href: "/old" } } });
		const toolbar = await selectImage(img);
		await userEvent.click(button(toolbar, "Edit link"));
		await vi.waitFor(() => expect(toolbar.querySelector('[role="combobox"]')).toHaveFocus());
		await userEvent.keyboard("/new");
		await userEvent.click(button(toolbar, "Cancel"));

		expect(imageAttrs(editor)?.link).toEqual({ href: "/old" });
		expect(button(toolbar, "Edit link")).toBeVisible();
		expect(document.activeElement).toBe(pm);
	});

	it("replaces the image like the settings panel and returns focus to Replace", async () => {
		const { editor, img } = await setup({
			image: { caption: "Old caption", title: "Old title", alignment: "center" },
		});
		const toolbar = await selectImage(img);
		button(toolbar, "Replace").focus();
		await userEvent.keyboard("{Enter}");

		const choose = document.querySelector<HTMLButtonElement>('[aria-label="Media picker"] button')!;
		await vi.waitFor(() => expect(document.activeElement).toBe(choose));
		expect(toolbar.parentElement!.hidden).toBe(false);
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(imageAttrs(editor)?.mediaId).toBe("new-media"));
		expect(imageAttrs(editor)).toMatchObject({
			src: REPLACEMENT.url,
			alt: "A red bike",
			mediaId: "new-media",
			alignment: "center",
		});
		expect(imageAttrs(editor)?.caption ?? null).toBeNull();
		expect(imageAttrs(editor)?.title ?? null).toBeNull();

		button(toolbar, "Replace").focus();
		expect(document.activeElement).toBe(button(toolbar, "Replace"));
		expect(toolbar).toBeVisible();
	});

	it("deletes the image and closes its settings", async () => {
		const { editor, img, getPanel } = await setup();
		const toolbar = await selectImage(img);
		await userEvent.click(button(toolbar, "Image settings"));
		await vi.waitFor(() => expect(getPanel()).not.toBeNull());

		await userEvent.click(button(toolbar, "Delete image"));

		await vi.waitFor(() => expect(imageAttrs(editor)).toBeUndefined());
		await vi.waitFor(() => expect(getPanel()).toBeNull());
	});

	it("opens and closes the image's settings, also after selecting everything", async () => {
		const { editor, img, getPanel } = await setup({ extraImage: true });
		editor.commands.selectAll();
		await vi.waitFor(() =>
			expect(document.querySelectorAll(".ProseMirror .ProseMirror-selectednode")).toHaveLength(2),
		);
		const toolbar = await selectImage(img);

		await userEvent.click(button(toolbar, "Image settings"));
		await vi.waitFor(() =>
			expect(getPanel()?.attrs).toMatchObject({ alt: "Example", provider: "cloudflare-images" }),
		);

		await userEvent.click(button(toolbar, "Image settings"));
		await vi.waitFor(() => expect(getPanel()).toBeNull());
	});

	it("closes the settings only for changes made outside them", async () => {
		const { editor, img, getPanel } = await setup();
		const toolbar = await selectImage(img);
		await userEvent.click(button(toolbar, "Image settings"));
		await vi.waitFor(() => expect(getPanel()).not.toBeNull());

		getPanel()!.onUpdate({ src: "/edited.jpg" });
		await vi.waitFor(() => expect(img).toHaveAttribute("src", "/edited.jpg"));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(getPanel()).not.toBeNull();

		await userEvent.click(button(toolbar, "Right"));
		await vi.waitFor(() => expect(getPanel()).toBeNull());
		expect(imageAttrs(editor)?.alignment).toBe("right");
	});

	it("rings the selected image only while focus is in the editor", async () => {
		const { img, caption } = await setup();
		const ringed = () => getComputedStyle(img).boxShadow !== "none";
		await selectImage(img);
		expect(ringed()).toBe(true);
		await userEvent.click(caption);
		expect(ringed()).toBe(true);

		await userEvent.click(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!);
		await vi.waitFor(() => expect(ringed()).toBe(false));
		await userEvent.click(img);
		await vi.waitFor(() => expect(ringed()).toBe(true));
	});

	it("hides when focus leaves a toolbar control for another field", async () => {
		const { img } = await setup();
		const toolbar = await selectImage(img);
		await userEvent.keyboard("{Tab}{Tab}");
		expect(document.activeElement).toBe(button(toolbar, "Replace"));

		await userEvent.click(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!);
		await vi.waitFor(() => expect(toolbar).not.toBeVisible());

		await userEvent.click(img);
		await waitForToolbar();
	});

	it("fits every control on a narrow screen without scrolling", async () => {
		await page.viewport(334, 800);
		try {
			const { img } = await setup();
			const toolbar = await selectImage(img);
			const menu = toolbar.parentElement!;
			expect(menu.scrollWidth).toBeLessThanOrEqual(menu.clientWidth);
			for (const control of toolbar.querySelectorAll("button")) {
				const box = control.getBoundingClientRect();
				expect(box.left).toBeGreaterThanOrEqual(0);
				expect(box.right).toBeLessThanOrEqual(window.innerWidth);
			}
			const top = (label: string) => button(toolbar, label).getBoundingClientRect().top;
			expect(top("Right")).toBe(top("Replace"));
			expect(top("Add link")).toBeGreaterThan(top("Replace"));
		} finally {
			await page.viewport(1280, 800);
		}
	});

	it("moves focus image, caption, toolbar with Tab, and back with Shift+Tab and Escape", async () => {
		const { editor, pm, img, caption } = await setup();
		editor.chain().focus().setTextSelection(3).run();
		await vi.waitFor(() => expect(document.activeElement).toBe(pm));
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).not.toBe(caption);

		const toolbar = await selectImage(img);
		const expectFocus = (element: Element) => {
			expect(document.activeElement).toBe(element);
			expect(toolbar).toBeVisible();
			expectImageSelected(editor);
		};
		await userEvent.keyboard("{Tab}");
		expectFocus(caption);
		await userEvent.keyboard("{Tab}");
		expectFocus(button(toolbar, "Replace"));
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expectFocus(caption);
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expectFocus(pm);

		await userEvent.keyboard("{Tab}{Escape}");
		expectFocus(pm);
		await userEvent.keyboard("{Tab}{Tab}{Tab}{Escape}");
		expectFocus(pm);
	});

	it("opens the alt text and link rows from the keyboard", async () => {
		const { pm, img } = await setup();
		const toolbar = await selectImage(img);

		await userEvent.keyboard("{Tab}{Tab}{Tab}{Enter}");
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(toolbar.querySelector('input[aria-label="Alt text"]')),
		);
		expect(toolbar).toBeVisible();

		await userEvent.keyboard("{Escape}");
		expect(document.activeElement).toBe(pm);
		button(toolbar, "Add link").focus();
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() =>
			expect(document.activeElement).toBe(toolbar.querySelector('[role="combobox"]')),
		);
		expect(toolbar).toBeVisible();
	});

	it("saves a caption typed under the image and keeps the toolbar showing", async () => {
		const { editor, img, caption, getSaved } = await setup({ image: { caption: "Red bike" } });
		const toolbar = await selectImage(img);
		await userEvent.click(caption);
		caption.setSelectionRange(3, 3);
		await userEvent.keyboard("dish");

		expect(caption).toHaveValue("Reddish bike");
		expect(caption.selectionStart).toBe(7);
		expect(imageAttrs(editor)?.caption).toBe("Reddish bike");
		await vi.waitFor(() =>
			expect(getSaved().find((block) => block._type === "image")).toMatchObject({
				caption: "Reddish bike",
			}),
		);
		await pastTextBubbleDelay();
		expect(toolbar).toBeVisible();
	});

	it("shows the toolbar when a caption is clicked from another field", async () => {
		const { editor, caption } = await setup();
		await userEvent.click(document.querySelector<HTMLInputElement>('input[aria-label="Title"]')!);
		await userEvent.click(caption);

		expect(document.activeElement).toBe(caption);
		expectImageSelected(editor);
		await waitForToolbar();
	});

	it("keeps text dropped on a caption out of the document", async () => {
		const { editor, caption } = await setup();
		const data = new DataTransfer();
		data.setData("text/plain", "Dropped words");
		const box = caption.getBoundingClientRect();
		const at = { clientX: box.x + box.width / 2, clientY: box.y + box.height / 2 };
		for (const type of ["dragover", "drop"]) {
			caption.dispatchEvent(
				new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data, ...at }),
			);
		}

		expect(editor.state.doc.textContent).not.toContain("Dropped words");
	});

	it("starts a new paragraph after the image when Enter is pressed in the caption", async () => {
		const { editor, pm, img, caption } = await setup({ image: { caption: "Kept" } });
		await selectImage(img);
		await userEvent.click(caption);
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => expect(document.activeElement).toBe(pm));
		expect(caption).toHaveValue("Kept");
		const { $from } = editor.state.selection;
		expect($from.parent.type.name).toBe("paragraph");
		expect($from.parent.textContent).toBe("");
		expect(editor.state.doc.childBefore($from.before()).node?.type.name).toBe("image");
	});

	it.each(["", "   "])(
		"lights Alt text only once an image with alt %j is described",
		async (alt) => {
			const { editor, img } = await setup({ image: { alt } });
			let toolbar = await selectImage(img);
			expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "false");
			await userEvent.hover(button(toolbar, "Alt text"));
			await vi.waitFor(() => expect(document.body).toHaveTextContent("No description yet"));
			editor.commands.setTextSelection(1);
			await vi.waitFor(() => expect(document.body).not.toHaveTextContent("No description yet"));

			toolbar = await selectImage(img);
			await userEvent.click(button(toolbar, "Alt text"));
			await userEvent.keyboard("A red bike{Enter}");

			await vi.waitFor(() =>
				expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "true"),
			);
			await userEvent.hover(button(toolbar, "Alt text"));
			await vi.waitFor(() => expect(document.body).toHaveTextContent("A red bike"));
		},
	);

	it("treats a file name as no description, also while the media item loads", async () => {
		let resolveMedia: (item: LocalMediaItem) => void = () => {};
		vi.mocked(fetchMediaItem)
			.mockReset()
			.mockReturnValue(new Promise((resolve) => (resolveMedia = resolve)));
		const { img } = await setup({
			image: { asset: { _ref: "local-1", url: "/img.jpg" }, alt: "IMG_2041.jpg" },
		});
		const toolbar = await selectImage(img);
		expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "false");

		resolveMedia({
			id: "local-1",
			filename: "IMG_2041.jpg",
			mimeType: "image/jpeg",
			url: "/img-current.jpg",
			storageKey: "IMG_2041.jpg",
			size: 100,
			status: "ready",
			authorId: null,
			folderId: null,
			createdAt: "2026-09-29T00:00:00.000Z",
		} satisfies LocalMediaItem);
		await vi.waitFor(() => expect(img.getAttribute("src")).toContain("/img-current.jpg"));
		expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "false");
		expect(fetchMediaItem).toHaveBeenCalledOnce();

		await userEvent.click(button(toolbar, "Alt text"));
		await userEvent.keyboard("A red bike{Enter}");
		await vi.waitFor(() =>
			expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "true"),
		);
	});

	it("knows a replacement image's description before its media item loads", async () => {
		vi.mocked(fetchMediaItem).mockReset();
		const { editor, img } = await setup();
		const toolbar = await selectImage(img);
		await userEvent.click(button(toolbar, "Replace"));
		await userEvent.click(page.getByRole("button", { name: "Choose replacement" }));

		await vi.waitFor(() => expect(imageAttrs(editor)?.mediaId).toBe("new-media"));
		expect(button(toolbar, "Alt text")).toHaveAttribute("aria-pressed", "true");
	});
});
