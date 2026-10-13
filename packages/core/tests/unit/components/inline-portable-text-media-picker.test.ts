// @vitest-environment jsdom

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
	InlinePortableTextEditor,
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

const actGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };

type PortableTextValue = React.ComponentProps<typeof InlinePortableTextEditor>["value"];
type SavedBlock = Record<string, unknown> & { _type: string };

type TestEditor = {
	state: {
		doc: {
			content: { size: number };
			descendants: (
				visit: (node: { type: { name: string }; text?: string }, pos: number) => void,
			) => void;
		};
	};
	view: { focus: () => void };
	commands: {
		setTextSelection: (position: number) => boolean;
		setNodeSelection: (position: number) => boolean;
		insertContent: (value: string) => boolean;
		splitBlock: () => boolean;
		splitListItem: (type: string) => boolean;
	};
};

interface LibraryItem {
	id: string;
	filename: string;
	mimeType: string;
	url: string;
	storageKey: string;
	width: number;
	height: number;
	alt?: string;
}

// Fifteen images: a full page of nine and a page of six.
const LIBRARY: LibraryItem[] = Array.from({ length: 15 }, (_, index) => ({
	id: `media-${index + 1}`,
	filename: index === 0 ? "IMG_2034.jpg" : `photo-${index + 1}.jpg`,
	mimeType: "image/jpeg",
	url: `/_emdash/api/media/file/photo-${index + 1}.jpg`,
	storageKey: `photo-${index + 1}.jpg`,
	width: 1200,
	height: 800,
	...(index === 1 ? { alt: "Sunrise over a ridge" } : {}),
}));

function block(key: string, text: string, style = "normal", listItem?: "bullet") {
	return {
		_type: "block" as const,
		_key: key,
		style,
		markDefs: [],
		children: [{ _type: "span" as const, _key: `${key}-1`, text, marks: [] }],
		...(listItem ? { listItem, level: 1 } : {}),
	};
}

/** The position just past the end of `text`. */
function endOf(editor: TestEditor, text: string): number {
	let end = -1;
	editor.state.doc.descendants((node, pos) => {
		if (node.text === text) end = pos + text.length;
	});
	return end;
}

const IMAGE_BLOCK = {
	_type: "image",
	_key: "img",
	asset: { _ref: "media-1", url: "/_emdash/api/media/file/photo-1.jpg" },
	alt: "The old picture",
	caption: "Morning light",
	title: "Old title",
	width: 1200,
	height: 800,
};

// The component does not expose its editor, so this uses the instance
// Tiptap's core attaches to its view's root element (`view.dom.editor`).
function editorOf(editable: HTMLElement): TestEditor {
	const editor = (editable as HTMLElement & { editor?: TestEditor }).editor;
	expect(editor).toBeDefined();
	return editor!;
}

function setFieldValue(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
	const prototype =
		field instanceof HTMLTextAreaElement
			? HTMLTextAreaElement.prototype
			: HTMLInputElement.prototype;
	Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, value);
	field.dispatchEvent(new Event("input", { bubbles: true }));
}

function press(target: Element, key: string) {
	target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
}

async function click(element: Element) {
	await act(async () => {
		(element as HTMLElement).click();
	});
}

describe("inline Portable Text image picker and image toolbar", () => {
	const mounted: Array<{ container: HTMLDivElement; root: Root }> = [];
	let requests: string[];
	let puts: Array<{ url: string; blocks: SavedBlock[] }>;

	beforeAll(() => {
		// ProseMirror measures ranges to place the toolbars; jsdom has no layout.
		Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
		Range.prototype.getBoundingClientRect ??= () => new DOMRect();
	});

	beforeEach(() => {
		actGlobal.IS_REACT_ACT_ENVIRONMENT = true;
		requests = [];
		puts = [];
	});

	afterEach(async () => {
		for (const { container, root } of mounted.splice(0)) {
			await act(async () => root.unmount());
			container.remove();
		}
		delete actGlobal.IS_REACT_ACT_ENVIRONMENT;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	function stubMedia({
		library = LIBRARY,
		providers = [],
		providerItems = {},
	}: {
		library?: LibraryItem[];
		providers?: Array<{ id: string; name: string; capabilities: Record<string, boolean> }>;
		providerItems?: Record<string, unknown[]>;
	} = {}) {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (init?.method === "PUT" && typeof init.body === "string") {
					const body = JSON.parse(init.body) as { data: { body: SavedBlock[] } };
					puts.push({ url, blocks: body.data.body });
					return Response.json({ data: {} });
				}
				requests.push(url);
				const { pathname, searchParams } = new URL(url, "http://localhost");
				if (pathname === "/_emdash/api/media/providers") {
					return Response.json({ data: { items: providers } });
				}
				if (pathname === "/_emdash/api/media") {
					const page = Number(searchParams.get("page"));
					const limit = Number(searchParams.get("limit"));
					return Response.json({
						data: {
							items: library.slice((page - 1) * limit, page * limit),
							totalCount: library.length,
						},
					});
				}
				const provider = pathname.startsWith("/_emdash/api/media/providers/")
					? decodeURIComponent(pathname.slice("/_emdash/api/media/providers/".length))
					: undefined;
				if (provider) return Response.json({ data: { items: providerItems[provider] ?? [] } });
				throw new Error(`Unexpected request: ${url}`);
			}),
		);
	}

	async function mount(value: PortableTextValue, entryId = "post-1") {
		const container = document.createElement("div");
		document.body.append(container);
		const root = createRoot(container);
		mounted.push({ container, root });
		await act(async () => {
			root.render(
				React.createElement(InlinePortableTextEditor, {
					value: structuredClone(value),
					collection: "posts",
					entryId,
					field: "body",
				}),
			);
		});
		const editable = container.querySelector<HTMLElement>(".ProseMirror");
		expect(editable).not.toBeNull();
		return editable!;
	}

	/**
	 * Types `/image` on a new line, which `newLine` starts or else follows the
	 * last block, and chooses Image.
	 */
	async function typeImageCommand(
		editable: HTMLElement,
		newLine: (editor: TestEditor) => void = (editor) => {
			editor.commands.setTextSelection(editor.state.doc.content.size - 1);
			editor.commands.splitBlock();
		},
	) {
		const editor = editorOf(editable);
		// Not commands.focus(), which focuses a frame later and could take focus from the picker.
		await act(async () => {
			editor.view.focus();
			newLine(editor);
			editor.commands.insertContent("/image");
		});
		await vi.waitFor(() =>
			expect(document.querySelector('.emdash-slash-menu [aria-current="true"]')?.textContent).toBe(
				"Image",
			),
		);
		await act(async () => press(editable, "Enter"));
		return picker("Insert image");
	}

	function picker(label: string) {
		return vi.waitFor(() => {
			const dialog = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="${label}"]`);
			expect(dialog).not.toBeNull();
			return dialog!;
		});
	}

	function option(dialog: HTMLElement, name: string) {
		return vi.waitFor(() => {
			const tile = dialog.querySelector<HTMLElement>(`[role="option"][aria-label="${name}"]`);
			expect(tile).not.toBeNull();
			return tile!;
		});
	}

	function sourceTab(dialog: HTMLElement, name: string) {
		return vi.waitFor(() => {
			const tab = [...dialog.querySelectorAll<HTMLElement>('[role="tab"]')].find(
				(candidate) => candidate.textContent === name,
			);
			expect(tab).toBeDefined();
			return tab!;
		});
	}

	function count(dialog: HTMLElement) {
		return dialog.querySelector(".emdash-inline-ui-picker-count")?.textContent;
	}

	/** The picker's first image, once focus has moved to it. */
	function firstImageFocused(dialog: HTMLElement) {
		return vi.waitFor(() => {
			const tile = dialog.querySelector<HTMLElement>('[role="option"][data-index="0"]');
			expect(tile).not.toBeNull();
			expect(document.activeElement).toBe(tile);
			return tile!;
		});
	}

	async function selectImage(editable: HTMLElement) {
		const editor = editorOf(editable);
		let position = -1;
		editor.state.doc.descendants((node, pos) => {
			if (node.type.name === "image") position = pos;
		});
		// The view writes the selection to the page as it takes focus. Focusing
		// the element instead puts jsdom's caret at its start, before the image.
		await act(async () => {
			editor.commands.setNodeSelection(position);
			editor.view.focus();
		});
		return vi.waitFor(() => {
			const toolbar = document.querySelector<HTMLElement>(
				'[role="toolbar"][aria-label="Image controls"]',
			);
			expect(toolbar?.isConnected).toBe(true);
			return toolbar!;
		});
	}

	function toolbarButton(toolbar: HTMLElement, name: string) {
		const match = [...toolbar.querySelectorAll<HTMLElement>("button")].find(
			(candidate) =>
				(candidate.getAttribute("aria-label") ??
					candidate.querySelector(".emdash-inline-ui-text-button-label")?.textContent) === name,
		);
		expect(match).toBeDefined();
		return match!;
	}

	/** The query of the picker's latest request for library images. */
	function lastLibraryQuery() {
		const url = requests.findLast((request) => request.startsWith("/_emdash/api/media?"));
		expect(url).toBeDefined();
		return Object.fromEntries(new URL(url!, "http://localhost").searchParams);
	}

	/** A control elsewhere on the page, for focus to move to. */
	function elsewhere() {
		const outside = document.createElement("button");
		document.body.append(outside);
		return outside;
	}

	function savedBlocks() {
		return vi.waitFor(() => {
			expect(puts).toHaveLength(1);
			return puts[0]!.blocks;
		});
	}

	/** Moves focus out of the editor, which saves it. */
	async function saved(editable: HTMLElement) {
		const outside = document.createElement("button");
		document.body.append(outside);
		await act(async () => {
			editable.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: outside }));
		});
		outside.remove();
		return savedBlocks();
	}

	it("canonicalizes a legacy direct URL provider when an existing image is saved", () => {
		const pm = portableTextToPM([
			{
				_type: "image",
				_key: "external-image",
				asset: {
					_ref: "",
					url: "https://media.example/external.jpg",
					provider: "external-url",
				},
			},
		]);

		const restored = pmToPortableText(pm);
		expect((restored[0] as { asset?: { provider?: string } }).asset?.provider).toBe("external");
	});

	it("opens a picker only in the editor where /image was typed", async () => {
		stubMedia();
		await mount([block("a", "First field.")], "post-1");
		const second = await mount([block("b", "Second field.")], "post-2");

		await typeImageCommand(second);

		expect(document.querySelectorAll('[role="dialog"][aria-label="Insert image"]')).toHaveLength(1);
	});

	it("inserts the chosen image and saves it, without the file name as its alt text", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), block("b", "After.")]);
		const dialog = await typeImageCommand(editable, (editor) => {
			editor.commands.setTextSelection(endOf(editor, "Intro."));
			editor.commands.splitBlock();
		});

		await click(await option(dialog, "IMG_2034.jpg"));

		const blocks = await savedBlocks();
		expect(blocks).toHaveLength(3);
		expect(blocks[0]).toMatchObject({ _type: "block", children: [{ text: "Intro." }] });
		expect(blocks[1]).toMatchObject({
			_type: "image",
			asset: { _ref: "media-1", url: "/_emdash/api/media/file/photo-1.jpg" },
			width: 1200,
			height: 800,
		});
		expect(blocks[1]).not.toHaveProperty("alt");
		expect(blocks[2]).toMatchObject({ _type: "block", children: [{ text: "After." }] });
		expect(dialog.isConnected).toBe(false);
	});

	it("puts an image typed in a quote after the quote, which keeps only text", async () => {
		stubMedia();
		const editable = await mount([block("q", "Quoted line.", "blockquote"), block("a", "After.")]);
		const dialog = await typeImageCommand(editable, (editor) => {
			editor.commands.setTextSelection(endOf(editor, "Quoted line."));
			editor.commands.splitBlock();
		});

		await click(await option(dialog, "photo-2.jpg"));

		const blocks = await savedBlocks();
		expect(blocks.map((savedBlock) => savedBlock._type)).toEqual(["block", "image", "block"]);
		expect(blocks[0]).toMatchObject({ style: "blockquote", children: [{ text: "Quoted line." }] });
		expect(blocks[1]).toMatchObject({ asset: { _ref: "media-2" }, alt: "Sunrise over a ridge" });
	});

	it("puts an image typed in a list after the list, which keeps only text", async () => {
		stubMedia();
		const editable = await mount([
			block("a", "First item.", "normal", "bullet"),
			block("b", "Second item.", "normal", "bullet"),
		]);
		const dialog = await typeImageCommand(editable, (editor) => {
			editor.commands.setTextSelection(endOf(editor, "Second item."));
			editor.commands.splitListItem("listItem");
		});

		await click(await option(dialog, "photo-2.jpg"));

		const blocks = await savedBlocks();
		expect(blocks.slice(0, 3)).toMatchObject([
			{ listItem: "bullet", children: [{ text: "First item." }] },
			{ listItem: "bullet", children: [{ text: "Second item." }] },
			{ _type: "image", asset: { _ref: "media-2" } },
		]);
		expect(blocks.filter((savedBlock) => savedBlock.listItem === "bullet")).toHaveLength(2);
	});

	it("pages through the library nine images at a time", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 1–9 of 15"));
		expect(dialog.querySelectorAll('[role="option"]')).toHaveLength(9);
		expect(lastLibraryQuery()).toMatchObject({ page: "1", limit: "9" });
		await firstImageFocused(dialog);
		const fifth = await option(dialog, "photo-5.jpg");
		await act(async () => fifth.focus());

		await click(dialog.querySelector('[aria-label="Next page"]')!);

		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 10–15 of 15"));
		expect(dialog.querySelectorAll('[role="option"]')).toHaveLength(6);
		expect(lastLibraryQuery()).toMatchObject({ page: "2", limit: "9" });
		expect(dialog.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!.disabled).toBe(
			true,
		);
		expect(dialog.querySelector<HTMLInputElement>('[aria-label="Page number"]')!.value).toBe("2");
		// Focus on an image of the first page moves to the first image of the second.
		const first = await firstImageFocused(dialog);
		expect(first.getAttribute("aria-label")).toBe("photo-10.jpg");
		expect(first.getAttribute("aria-selected")).toBe("true");
	});

	it("offers to try again when a page of images can't load", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 1–9 of 15"));
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await click(dialog.querySelector('[aria-label="Next page"]')!);

		await vi.waitFor(() => expect(dialog.textContent).toContain("Images couldn't load"));
		await click(
			[...dialog.querySelectorAll("button")].find((button) => button.textContent === "Try again")!,
		);
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 10–15 of 15"));
	});

	it("keeps the images on show when refreshing them on coming back to the tab fails", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 1–9 of 15"));
		const calls = vi.mocked(fetch).mock.calls.length;
		vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));

		await act(async () => document.dispatchEvent(new Event("visibilitychange")));
		await vi.waitFor(() => expect(vi.mocked(fetch).mock.calls.length).toBe(calls + 1));
		// Lets the failed refresh land.
		await act(async () => {});

		expect(dialog.textContent).not.toContain("Images couldn't load");
		expect(count(dialog)).toBe("Showing 1–9 of 15");
	});

	it("points an empty library to the admin's media library", async () => {
		stubMedia({ library: [] });
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);

		const link = await vi.waitFor(() => {
			const anchor = dialog.querySelector<HTMLAnchorElement>("a");
			expect(anchor).not.toBeNull();
			return anchor!;
		});
		expect(dialog.textContent).toContain("No images yet");
		expect(link.getAttribute("href")).toBe("/_emdash/admin/media");
		expect(link.target).toBe("_blank");
		expect(dialog.querySelector('[aria-label="Next page"]')).toBeNull();
	});

	it("closes the picker with Escape and goes back to the editor", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		const first = await firstImageFocused(dialog);

		await act(async () => press(first, "Escape"));

		expect(dialog.isConnected).toBe(false);
		expect(document.activeElement).toBe(editable);
	});

	it("closes the picker when focus moves elsewhere on the page, saving the editor", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable, (editor) => {
			editor.commands.setTextSelection(endOf(editor, "Intro."));
			editor.commands.insertContent(" More.");
			editor.commands.splitBlock();
		});
		await firstImageFocused(dialog);
		const outside = elsewhere();

		await act(async () => outside.focus());

		expect(dialog.isConnected).toBe(false);
		const blocks = await savedBlocks();
		expect(blocks[0]).toMatchObject({ children: [{ text: "Intro. More." }] });
		outside.remove();
	});

	it("puts focus on the first image once the images load", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);

		const first = await firstImageFocused(dialog);

		expect(first.getAttribute("aria-label")).toBe("IMG_2034.jpg");
		expect(first.getAttribute("aria-selected")).toBe("true");
	});

	it("highlights the image that Tab moves to", async () => {
		// Four pages, so the second page keeps Next and Last on.
		stubMedia({
			library: Array.from({ length: 30 }, (_, index) => ({
				...LIBRARY[index % LIBRARY.length]!,
				id: `media-${index + 1}`,
			})),
		});
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		const first = await firstImageFocused(dialog);
		const next = dialog.querySelector<HTMLButtonElement>('[aria-label="Next page"]')!;
		await act(async () => next.focus());
		await click(next);
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 10–18 of 30"));
		expect(document.activeElement).toBe(next);
		expect(first.getAttribute("aria-selected")).toBe("false");
		const last = dialog.querySelector<HTMLButtonElement>('[aria-label="Last page"]')!;
		await act(async () => last.focus());

		// Tab goes around from the last control to the images.
		await act(async () => press(last, "Tab"));

		expect(document.activeElement).toBe(first);
		expect(first.getAttribute("aria-selected")).toBe("true");
	});

	it("moves focus with the pointer from image to image", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await firstImageFocused(dialog);
		const hovered = await option(dialog, "photo-5.jpg");

		await act(async () => {
			hovered.dispatchEvent(new MouseEvent("pointermove", { bubbles: true }));
		});

		expect(document.activeElement).toBe(hovered);
		expect(hovered.getAttribute("aria-selected")).toBe("true");
	});

	async function expectSavedProvider(provider: string, storedProvider: string) {
		stubMedia({
			providers: [
				{
					id: provider,
					name: "Test Provider",
					capabilities: { browse: true, search: true, upload: true, delete: true },
				},
			],
			providerItems: {
				[provider]: [
					{
						id: "provider-image",
						filename: "provider.jpg",
						mimeType: "image/jpeg",
						previewUrl: "https://media.example/provider.jpg",
						width: 1200,
						height: 800,
					},
				],
			},
		});
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await click(await sourceTab(dialog, "Test Provider"));

		await click(await option(dialog, "provider.jpg"));

		const blocks = await savedBlocks();
		expect(blocks[1]).toMatchObject({
			_type: "image",
			asset: {
				_ref: "provider-image",
				url: "https://media.example/provider.jpg",
				provider: storedProvider,
			},
		});
	}

	it("saves the configured provider for an inserted image", () =>
		expectSavedProvider("cloudflare-images", "cloudflare-images"));

	it("canonicalizes the legacy direct URL provider for an inserted image", () =>
		expectSavedProvider("external-url", "external"));

	it("pages through a provider's images from the one request", async () => {
		stubMedia({
			providers: [
				{ id: "cloudflare-images", name: "Cloudflare Images", capabilities: { browse: true } },
			],
			providerItems: {
				"cloudflare-images": Array.from({ length: 12 }, (_, index) => ({
					id: `provider-${index + 1}`,
					filename: `provider-${index + 1}.jpg`,
					mimeType: "image/jpeg",
					previewUrl: `https://media.example/provider-${index + 1}.jpg`,
				})),
			},
		});
		const editable = await mount([block("a", "Intro.")]);
		const dialog = await typeImageCommand(editable);
		await click(await sourceTab(dialog, "Cloudflare Images"));
		await vi.waitFor(() => expect(count(dialog)).toBe("Showing 1–9 of 12"));

		await click(dialog.querySelector('[aria-label="Next page"]')!);

		expect(count(dialog)).toBe("Showing 10–12 of 12");
		expect(
			Array.from(dialog.querySelectorAll('[role="option"]'), (tile) =>
				tile.getAttribute("aria-label"),
			),
		).toEqual(["provider-10.jpg", "provider-11.jpg", "provider-12.jpg"]);
		expect(requests.filter((url) => url.startsWith("/_emdash/api/media/providers/"))).toHaveLength(
			1,
		);
	});

	it("replaces an image, keeping its caption and taking the new image's alt text", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		const toolbar = await selectImage(editable);

		await click(toolbarButton(toolbar, "Replace"));
		const dialog = await picker("Replace image");
		// The image being replaced is marked in the grid.
		await option(dialog, "IMG_2034.jpg (current image)");
		await click(await option(dialog, "photo-2.jpg"));

		const blocks = await savedBlocks();
		expect(blocks[1]).toMatchObject({
			_type: "image",
			asset: { _ref: "media-2", url: "/_emdash/api/media/file/photo-2.jpg" },
			alt: "Sunrise over a ridge",
			caption: "Morning light",
		});
		expect(blocks[1]).not.toHaveProperty("title");
		expect(toolbar.isConnected).toBe(true);
	});

	it("leaves an image as it was when Replace chooses the image it shows", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		const toolbar = await selectImage(editable);
		await click(toolbarButton(toolbar, "Replace"));
		const dialog = await picker("Replace image");

		await click(await option(dialog, "IMG_2034.jpg (current image)"));

		expect(dialog.isConnected).toBe(false);
		const image = editable.querySelector("figure.emdash-image img")!;
		expect(image.getAttribute("alt")).toBe("The old picture");
		expect(image.getAttribute("title")).toBe("Old title");
	});

	it("keeps a replaced image's display width, in the new image's shape", async () => {
		stubMedia({ library: [{ ...LIBRARY[1]!, width: 800, height: 1200 }] });
		const editable = await mount([
			block("a", "Intro."),
			{ ...IMAGE_BLOCK, displayWidth: 600, displayHeight: 400 },
		]);
		const toolbar = await selectImage(editable);
		await click(toolbarButton(toolbar, "Replace"));

		await click(await option(await picker("Replace image"), "photo-2.jpg"));

		const blocks = await savedBlocks();
		expect(blocks[1]).toMatchObject({ width: 800, height: 1200, displayWidth: 600 });
		expect(blocks[1]).not.toHaveProperty("displayHeight");
	});

	it.each([
		{ size: "a display height alone", display: { displayHeight: 400 } },
		{
			size: "a display size that crops the image on purpose",
			display: { displayWidth: 300, displayHeight: 300 },
		},
	])("keeps $size when replacing an image", async ({ display }) => {
		stubMedia({ library: [{ ...LIBRARY[1]!, width: 800, height: 1200 }] });
		const editable = await mount([block("a", "Intro."), { ...IMAGE_BLOCK, ...display }]);
		const toolbar = await selectImage(editable);
		await click(toolbarButton(toolbar, "Replace"));

		await click(await option(await picker("Replace image"), "photo-2.jpg"));

		const blocks = await savedBlocks();
		expect(blocks[1]).toMatchObject({ asset: { _ref: "media-2" }, ...display });
	});

	it("goes from the Replace picker to the alt text field, keeping the toolbar", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		const toolbar = await selectImage(editable);
		await click(toolbarButton(toolbar, "Replace"));
		const dialog = await picker("Replace image");
		await firstImageFocused(dialog);

		const altText = toolbarButton(toolbar, "Alt text");
		// A tap on a touch screen, whose mouse events and click follow the pointer
		// events once what those set off has run.
		const tap = (type: string) => {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true });
			if (type.startsWith("pointer"))
				Object.defineProperty(event, "pointerType", { value: "touch" });
			altText.dispatchEvent(event);
		};
		await act(async () => {
			tap("pointerdown");
			tap("pointerup");
		});
		await act(async () => {
			tap("mousedown");
			tap("mouseup");
			altText.click();
		});

		expect(dialog.isConnected).toBe(false);
		await vi.waitFor(() =>
			expect(document.activeElement?.getAttribute("aria-label")).toBe("Alt text"),
		);
		expect(toolbar.isConnected).toBe(true);
	});

	it("hides the image's toolbar once focus leaves, after Replace was used from the caption", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		const toolbar = await selectImage(editable);
		const caption = editable.querySelector<HTMLTextAreaElement>("figcaption textarea")!;
		await act(async () => caption.focus());
		await vi.waitFor(() => expect(toolbar.isConnected).toBe(true));
		// A press on the toolbar keeps focus in the caption.
		const replace = toolbarButton(toolbar, "Replace");
		await act(async () => {
			replace.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
			replace.click();
		});
		await click(await option(await picker("Replace image"), "photo-2.jpg"));
		expect(document.activeElement).toBe(replace);
		const outside = elsewhere();

		await act(async () => outside.focus());

		await vi.waitFor(() => expect(toolbar.isConnected).toBe(false));
		outside.remove();
	});

	it("describes an image from its toolbar", async () => {
		stubMedia();
		const editable = await mount([{ ...IMAGE_BLOCK, alt: undefined }]);
		const toolbar = await selectImage(editable);
		const altText = toolbarButton(toolbar, "Alt text");
		expect(altText.getAttribute("aria-pressed")).toBe("false");

		await click(altText);
		const input = await vi.waitFor(() => {
			const field = toolbar.querySelector<HTMLInputElement>('input[aria-label="Alt text"]');
			expect(field).not.toBeNull();
			return field!;
		});
		await act(async () => setFieldValue(input, "  A ridge at sunrise "));
		await act(async () => press(input, "Enter"));

		expect(document.activeElement).toBe(editable);
		expect(toolbarButton(toolbar, "Alt text").getAttribute("aria-pressed")).toBe("true");
		const blocks = await saved(editable);
		expect(blocks[0]).toMatchObject({ _type: "image", alt: "A ridge at sunrise" });
	});

	it("types the caption under the image", async () => {
		stubMedia();
		const editable = await mount([{ ...IMAGE_BLOCK, caption: undefined }]);
		const caption = await vi.waitFor(() => {
			const field = editable.querySelector<HTMLTextAreaElement>("figcaption textarea");
			expect(field).not.toBeNull();
			return field!;
		});
		expect(caption.placeholder).toBe("Add a caption");

		await act(async () => {
			caption.focus();
			setFieldValue(caption, "Morning light");
		});

		const blocks = await saved(editable);
		expect(blocks[0]).toMatchObject({ _type: "image", caption: "Morning light" });
	});

	it("starts a paragraph after the image on Enter in its caption", async () => {
		stubMedia();
		const editable = await mount([IMAGE_BLOCK, block("a", "After.")]);
		const caption = editable.querySelector<HTMLTextAreaElement>("figcaption textarea")!;
		await act(async () => caption.focus());

		await act(async () => press(caption, "Enter"));
		await act(async () => editorOf(editable).commands.insertContent("New line."));

		const blocks = await saved(editable);
		expect(blocks).toMatchObject([
			{ _type: "image", caption: "Morning light" },
			{ _type: "block", children: [{ text: "New line." }] },
			{ _type: "block", children: [{ text: "After." }] },
		]);
	});

	it("goes from a selected image to its caption with Tab, and back with Escape", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		await selectImage(editable);
		const caption = editable.querySelector<HTMLTextAreaElement>("figcaption textarea")!;

		await act(async () => press(editable, "Tab"));
		expect(document.activeElement).toBe(caption);

		await act(async () => press(caption, "Escape"));
		expect(document.activeElement).toBe(editable);
	});

	it("deletes an image from its toolbar", async () => {
		stubMedia();
		const editable = await mount([IMAGE_BLOCK, block("a", "After.")]);
		const toolbar = await selectImage(editable);
		const deleteButton = toolbarButton(toolbar, "Delete image");
		await act(async () => deleteButton.focus());

		await click(deleteButton);

		expect(document.activeElement).toBe(editable);
		const blocks = await saved(editable);
		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({ _type: "block", children: [{ text: "After." }] });
	});

	it("selects an image a finger taps, but not one it scrolls the page from", async () => {
		stubMedia();
		const editable = await mount([block("a", "Intro."), IMAGE_BLOCK]);
		const editor = editorOf(editable);
		await act(async () => {
			editor.commands.setTextSelection(endOf(editor, "Intro."));
			editor.view.focus();
		});
		const image = editable.querySelector<HTMLElement>("figure.emdash-image img")!;
		const touch = (type: string) => {
			const event = new MouseEvent(type, { bubbles: true, cancelable: true });
			Object.defineProperties(event, {
				pointerType: { value: "touch" },
				isPrimary: { value: true },
			});
			image.dispatchEvent(event);
		};

		// The browser takes over a finger that moves, to scroll the page.
		await act(async () => {
			touch("pointerdown");
			touch("pointercancel");
		});
		expect(editable.querySelector(".ProseMirror-selectednode")).toBeNull();

		await act(async () => {
			touch("pointerdown");
			touch("pointerup");
			image.click();
		});
		expect(editable.querySelector(".ProseMirror-selectednode")).not.toBeNull();
	});
});
