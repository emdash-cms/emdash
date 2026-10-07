/**
 * Video block editing through the full editor: adding a video from /video
 * and the add-block menu, the caption, the Replace and Delete actions, keyboard
 * order, the broken state, the clipboard, plugin video blocks, and conversion.
 */

import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cdp, userEvent } from "vitest/browser";

import { BlockMenu } from "../../src/components/editor/BlockMenu";
import {
	PortableTextEditor,
	_portableTextToProsemirror as portableTextToProsemirror,
	_prosemirrorToPortableText as prosemirrorToPortableText,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { fetchMediaItem, uploadMedia, type MediaItem } from "../../src/lib/api/media.js";
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
							<input aria-label="Search media" />
							<button
								type="button"
								onClick={() => {
									onSelect(picker.item);
									close();
								}}
							>
								Choose video
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
		<button
			type="button"
			// Like the real insert button, a click leaves focus in the editor.
			onMouseDown={(event) => event.preventDefault()}
			onClick={() => onInsertBlock?.(editor.state.doc.content.size)}
		>
			Test gutter insert
		</button>
	),
}));
vi.mock("../../src/lib/api/media.js", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/media.js")>(
		"../../src/lib/api/media.js",
	);
	return { ...actual, fetchMediaItem: vi.fn(), uploadMedia: vi.fn() };
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

let playableUrl = "";

/** Record a short clip the browser can play, so no test waits on a missing file. */
async function recordClip(): Promise<string> {
	const canvas = document.createElement("canvas");
	canvas.width = 32;
	canvas.height = 18;
	const context = canvas.getContext("2d")!;
	const recorder = new MediaRecorder(canvas.captureStream(10), { mimeType: "video/webm" });
	const chunks: Blob[] = [];
	recorder.ondataavailable = (event) => chunks.push(event.data);
	recorder.start();
	for (let frame = 0; frame < 4; frame++) {
		context.fillStyle = frame % 2 ? "#f60" : "#06f";
		context.fillRect(0, 0, 32, 18);
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	const stopped = new Promise((resolve) => {
		recorder.onstop = resolve;
	});
	recorder.stop();
	await stopped;
	return URL.createObjectURL(new Blob(chunks, { type: "video/webm" }));
}

function mediaItem(id: string, url: string): MediaItem {
	return {
		id,
		filename: `${id}.webm`,
		mimeType: "video/webm",
		url,
		storageKey: `${id}.webm`,
		size: 1024,
		width: 1920,
		height: 1080,
		createdAt: "2026-10-02T00:00:00.000Z",
	};
}

function videoBlock(fields: Partial<Block> = {}): Block {
	return {
		_type: "video",
		_key: "video1",
		asset: { _ref: "01VIDEO", url: playableUrl },
		width: 1920,
		height: 1080,
		...fields,
	};
}

beforeAll(async () => {
	playableUrl = await recordClip();
});

afterEach(() => {
	vi.mocked(fetchMediaItem).mockReset();
	vi.mocked(uploadMedia).mockReset();
});

function dropFiles(target: HTMLElement, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	const rect = target.getBoundingClientRect();
	target.dispatchEvent(
		new DragEvent("drop", {
			bubbles: true,
			cancelable: true,
			dataTransfer,
			clientX: rect.left + rect.width - 2,
			clientY: rect.top + rect.height / 2,
		}),
	);
}

function videoFile(name: string) {
	return new File([new Uint8Array(16)], name, { type: "video/webm" });
}

async function renderEditor(props: Partial<PortableTextEditorProps> = {}) {
	if (!vi.mocked(fetchMediaItem).getMockImplementation()) {
		vi.mocked(fetchMediaItem).mockRejectedValue(new Error("Not in this test"));
	}
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

function videos(value: Block[]): Block[] {
	return value.filter((block) => block._type === "video");
}

function player(): HTMLVideoElement {
	const element = document.querySelector<HTMLVideoElement>(".ProseMirror video");
	if (!element) throw new Error("No video player in the editor");
	return element;
}

function caption(): HTMLTextAreaElement {
	return document.querySelector<HTMLTextAreaElement>(".ProseMirror figure textarea")!;
}

function videoPosition(editor: Editor): number {
	let position = -1;
	editor.state.doc.forEach((node, offset) => {
		if (node.type.name === "videoBlock" && position === -1) position = offset;
	});
	return position;
}

/** Select the video block with the editor focused, as clicking its gutter handle does. */
function selectVideo(editor: Editor) {
	editor.view.focus();
	editor.commands.setNodeSelection(videoPosition(editor));
}

/** Each top-level block's text, or the node's name for a block without text, like a video. */
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

function selectedNodeName(editor: Editor): string | null {
	const { selection } = editor.state;
	return selection instanceof NodeSelection ? selection.node.type.name : null;
}

describe("Video block editor", () => {
	async function insertFromSlashMenu(editor: Editor) {
		editor.view.focus();
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		await userEvent.keyboard("{Enter}/video");
		await vi.waitFor(() =>
			expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy(),
		);
		await userEvent.keyboard("{Enter}");
	}

	it("adds a video from /video once one is chosen in the picker", async () => {
		picker.item = mediaItem("01VIDEO", playableUrl);
		const { screen, editor, pm, latest } = await renderEditor({ value: [INTRO] });

		await insertFromSlashMenu(editor);
		await expect.element(screen.getByRole("dialog", { name: "Select video" })).toBeVisible();
		expect(blockTexts(editor)).toEqual(["Intro", ""]);
		await userEvent.click(screen.getByRole("button", { name: "Choose video" }));

		await vi.waitFor(() =>
			expect(videos(latest())).toEqual([
				{
					_type: "video",
					_key: expect.any(String),
					asset: { _ref: "01VIDEO", url: playableUrl },
					width: 1920,
					height: 1080,
				},
			]),
		);
		expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", ""]);
		expect(player().getAttribute("src")).toBe(playableUrl);
		expect(selectedNodeName(editor)).toBe("videoBlock");
		expect(document.activeElement).toBe(pm);
	});

	it("adds nothing from /video when the picker is closed", async () => {
		const { screen, editor, pm, latest } = await renderEditor({ value: [INTRO] });

		await insertFromSlashMenu(editor);
		await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
		await settle();

		expect(document.querySelector('[role="dialog"]')).toBeNull();
		expect(blockTexts(editor)).toEqual(["Intro", ""]);
		expect(videos(latest())).toEqual([]);
		expect(document.activeElement).toBe(pm);
	});

	it("adds a video chosen from the gutter where its line was, and undoes it in one step", async () => {
		picker.item = mediaItem("01VIDEO", playableUrl);
		const { screen, editor } = await renderEditor({ value: [INTRO] });
		const before = editor.getJSON();

		editor.view.focus();
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		const item = [...menu.querySelectorAll("button")].find(
			(button) => button.querySelector("[data-slash-item-title]")?.textContent === "Video",
		);
		item!.click();
		await expect.element(screen.getByRole("dialog", { name: "Select video" })).toBeVisible();
		expect(blockTexts(editor)).toEqual(["Intro"]);
		await userEvent.click(screen.getByRole("button", { name: "Choose video" }));
		await vi.waitFor(() => expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", ""]));
		expect(document.activeElement).toBe(editor.view.dom);
		await userEvent.keyboard("{ControlOrMeta>}z{/ControlOrMeta}");

		expect(editor.getJSON()).toEqual(before);
	});

	it("adds a video chosen from the gutter after an upload lands while its picker is open", async () => {
		picker.item = mediaItem("01VIDEO", playableUrl);
		let finishUpload: (item: MediaItem) => void = () => {};
		vi.mocked(uploadMedia).mockImplementation(
			() =>
				new Promise((resolve) => {
					finishUpload = resolve;
				}),
		);
		const { screen, editor, pm } = await renderEditor({ value: [INTRO, OUTRO] });
		dropFiles(pm.querySelector("p")!, [videoFile("demo.webm")]);
		await vi.waitFor(() => expect(vi.mocked(uploadMedia)).toHaveBeenCalledTimes(1));

		editor.view.focus();
		await screen.getByRole("button", { name: "Test gutter insert" }).click();
		const menu = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		const item = [...menu.querySelectorAll("button")].find(
			(button) => button.querySelector("[data-slash-item-title]")?.textContent === "Video",
		);
		item!.click();
		await expect.element(screen.getByRole("dialog", { name: "Select video" })).toBeVisible();
		finishUpload(mediaItem("03VIDEO", playableUrl));
		await vi.waitFor(() => expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", "Outro"]));
		await userEvent.click(screen.getByRole("button", { name: "Choose video" }));

		await vi.waitFor(() =>
			expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", "Outro", "videoBlock", ""]),
		);
	});

	const press = (keys: string) => () => userEvent.keyboard(keys);
	const compose = async () => {
		await cdp().send("Input.imeSetComposition", { text: "k", selectionStart: 1, selectionEnd: 1 });
		await cdp().send("Input.insertText", { text: "か" });
	};

	it.each([
		["a letter on the player", press("x"), "VIDEO", () => videoBlock()],
		["Backspace on the player", press("{Backspace}"), "VIDEO", () => videoBlock()],
		["input method text on the player", compose, "VIDEO", () => videoBlock()],
	])("leaves the text around the block alone for %s", async (_, input, focused, block) => {
		const { editor } = await renderEditor({ value: [INTRO, block(), OUTRO] });

		selectVideo(editor);
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement?.tagName).toBe(focused);
		await input();
		await settle();

		expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", "Outro"]);
	});

	it("still plays the focused player with Space", async () => {
		const { editor } = await renderEditor({ value: [INTRO, videoBlock(), OUTRO] });
		await vi.waitFor(() => expect(player().readyState).toBeGreaterThan(0));
		const played = new Promise((resolve) =>
			player().addEventListener("play", resolve, { once: true }),
		);

		selectVideo(editor);
		await userEvent.keyboard("{Tab}");
		await userEvent.keyboard(" ");

		await played;
		expect(blockTexts(editor)).toEqual(["Intro", "videoBlock", "Outro"]);
	});

	it("saves a caption and keeps writing below it on Enter", async () => {
		const { editor, latest } = await renderEditor({ value: [videoBlock()] });

		await userEvent.click(caption());
		await userEvent.keyboard("Launch day");
		await vi.waitFor(() => expect(videos(latest())[0]?.caption).toBe("Launch day"));

		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() => expect(document.activeElement).toBe(editor.view.dom));
		await userEvent.keyboard("Next");
		const below = editor.state.doc.child(1);
		expect(below.type.name).toBe("paragraph");
		expect(below.textContent).toBe("Next");
		expect(videos(latest())[0]?.caption).toBe("Launch day");
	});

	it("replaces the video and keeps its caption", async () => {
		picker.item = {
			...mediaItem("02VIDEO", `${playableUrl}#replacement`),
			width: 720,
			height: 1280,
		};
		const { screen, editor, latest } = await renderEditor({
			value: [videoBlock({ caption: "Launch day" })],
		});

		selectVideo(editor);
		await userEvent.click(screen.getByRole("button", { name: "Replace video" }));
		await userEvent.click(screen.getByRole("button", { name: "Choose video" }));

		await vi.waitFor(() =>
			expect(videos(latest())).toEqual([
				{
					_type: "video",
					_key: "video1",
					asset: { _ref: "02VIDEO", url: `${playableUrl}#replacement` },
					caption: "Launch day",
					width: 720,
					height: 1280,
				},
			]),
		);
	});

	it("selects the block when Replace is pressed, so the picker can return focus to it", async () => {
		const { screen, editor } = await renderEditor({ value: [INTRO, videoBlock()] });

		await userEvent.hover(document.querySelector(".ProseMirror figure")!);
		await userEvent.click(screen.getByRole("button", { name: "Replace video" }));

		expect(selectedNodeName(editor)).toBe("videoBlock");
		await expect.element(screen.getByRole("button", { name: "Replace video" })).toBeVisible();
	});

	it("leaves the video alone once the entry is read-only", async () => {
		const { screen, editor } = await renderEditor({ value: [INTRO, videoBlock()] });
		selectVideo(editor);
		const remove = screen.getByRole("button", { name: "Delete video" }).element();

		editor.setEditable(false);
		(remove as HTMLButtonElement).click();

		expect(editor.state.doc.child(1).type.name).toBe("videoBlock");
	});

	it("deletes the video from its actions", async () => {
		const { screen, editor, latest } = await renderEditor({ value: [INTRO, videoBlock()] });

		selectVideo(editor);
		await userEvent.click(screen.getByRole("button", { name: "Delete video" }));

		await vi.waitFor(() => expect(videos(latest())).toEqual([]));
		expect(document.querySelector(".ProseMirror figure")).toBeNull();
	});

	it("names a selected video in its block menu", async () => {
		const { editor } = await renderEditor({ value: [INTRO, videoBlock()] });

		selectVideo(editor);
		const screen = await render(
			<BlockMenu
				editor={editor}
				anchorElement={document.querySelector<HTMLElement>(".ProseMirror figure")}
				isOpen
				onClose={() => {}}
			/>,
		);

		await expect.element(screen.getByRole("group", { name: "Video", exact: true })).toBeVisible();
	});

	it("draws no selection tint over a selected video, as with images", async () => {
		const { editor, pm } = await renderEditor({ value: [INTRO, videoBlock()] });

		selectVideo(editor);
		const block = document.querySelector<HTMLElement>(".ProseMirror > .ProseMirror-selectednode")!;

		expect(document.activeElement).toBe(pm);
		expect(block.querySelector("video")).toBeTruthy();
		expect(getComputedStyle(block, "::after").content).toBe("none");
	});

	it("moves through the player, caption and actions with Tab, and back to the block", async () => {
		const { editor, pm, screen } = await renderEditor({ value: [INTRO, videoBlock()] });
		const replace = screen.getByRole("button", { name: "Replace video" }).element();
		const remove = screen.getByRole("button", { name: "Delete video" }).element();

		selectVideo(editor);
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(player());
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(caption());
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(replace);
		await userEvent.keyboard("{Tab}");
		expect(document.activeElement).toBe(remove);

		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expect(document.activeElement).toBe(replace);
		await userEvent.keyboard("{Escape}");
		expect(document.activeElement).toBe(pm);
		expect(selectedNodeName(editor)).toBe("videoBlock");

		await userEvent.keyboard("{Tab}");
		await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
		expect(document.activeElement).toBe(pm);
		expect(selectedNodeName(editor)).toBe("videoBlock");
	});

	it("leaves keys in the Replace picker to the picker", async () => {
		const { screen, editor } = await renderEditor({ value: [videoBlock()] });

		selectVideo(editor);
		await userEvent.click(screen.getByRole("button", { name: "Replace video" }));
		const search = screen.getByRole("textbox", { name: "Search media" });
		await userEvent.click(search);
		const selection = editor.state.selection;
		await userEvent.keyboard("{Escape}{Tab}");

		expect(editor.state.selection.eq(selection)).toBe(true);
		expect(document.activeElement).not.toBe(caption());
		expect(document.querySelector('[role="dialog"]')?.contains(document.activeElement)).toBe(true);
	});

	it("says when a video can't be played", async () => {
		const { screen } = await renderEditor({
			value: [videoBlock({ asset: { _ref: "01GONE", url: "/_emdash/api/media/file/01GONE.mp4" } })],
		});

		await expect.element(screen.getByText("This video can't be played.")).toBeVisible();
		expect(player().getAttribute("src")).toBe("/_emdash/api/media/file/01GONE.mp4");
	});

	it("keeps the unplayable message out of the direction the editor reads from the text", async () => {
		const block = videoBlock({
			asset: { _ref: "01GONE", url: "/_emdash/api/media/file/01GONE.mp4" },
		});
		const arabic: Block = {
			...INTRO,
			_key: "arabic",
			children: [{ _type: "span", _key: "arabic-span", text: "مرحبا بالعالم", marks: [] }],
		};
		const { screen, pm } = await renderEditor({ value: [block, arabic] });

		await expect.element(screen.getByText("This video can't be played.")).toBeVisible();
		expect(getComputedStyle(pm).direction).toBe("rtl");
	});

	it("calls a block saved without a file URL unplayable, as the site does", async () => {
		const saved: Block = { _type: "video", _key: "video1", asset: { _ref: "01VIDEO" } };
		const { url: _url, ...item } = mediaItem("01VIDEO", "");
		vi.mocked(fetchMediaItem).mockResolvedValue(item as Awaited<ReturnType<typeof fetchMediaItem>>);
		const { screen } = await renderEditor({ value: [saved] });

		await expect.element(screen.getByText("This video can't be played.")).toBeVisible();
		await vi.waitFor(() => expect(vi.mocked(fetchMediaItem)).toHaveBeenCalled());
		expect(player().getAttribute("src")).toBeNull();
		expect(prosemirrorToPortableText(portableTextToProsemirror([saved]))).toStrictEqual([saved]);
	});

	it("uploads a video dropped into the text into a video block", async () => {
		vi.mocked(uploadMedia).mockResolvedValue(mediaItem("03VIDEO", playableUrl));
		const { pm, latest } = await renderEditor({ value: [INTRO] });

		dropFiles(pm.querySelector("p")!, [videoFile("demo.webm")]);

		await vi.waitFor(() =>
			expect(videos(latest())).toEqual([
				{
					_type: "video",
					_key: expect.any(String),
					asset: { _ref: "03VIDEO", url: playableUrl },
					width: 1920,
					height: 1080,
				},
			]),
		);
		expect(vi.mocked(uploadMedia)).toHaveBeenCalledTimes(1);
	});

	it("keeps a video through copy and paste", async () => {
		const { editor, latest } = await renderEditor({
			value: [videoBlock({ caption: "Launch day" }), INTRO],
		});

		selectVideo(editor);
		const { dom } = editor.view.serializeForClipboard(editor.state.selection.content());
		editor.commands.setTextSelection(editor.state.doc.content.size - 1);
		const clipboardData = new DataTransfer();
		clipboardData.setData("text/html", dom.innerHTML);
		editor.view.dom.dispatchEvent(
			new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
		);

		await vi.waitFor(() => expect(videos(latest())).toHaveLength(2));
		const [, pasted] = videos(latest());
		expect(pasted).toEqual({ ...videoBlock({ caption: "Launch day" }), _key: expect.any(String) });
	});
});

describe("Video block with a plugin's video block", () => {
	it("keeps the plugin's block and leaves out the built-in command", async () => {
		const saved = videoBlock();
		const { editor, latest } = await renderEditor({
			value: [INTRO, saved],
			pluginBlocks: [{ type: "video", pluginId: "acme", label: "Acme video" }],
		});

		await vi.waitFor(() => expect(document.querySelector(".plugin-block")).toBeTruthy());
		expect(document.querySelector(".ProseMirror video")).toBeNull();

		editor.view.focus();
		editor.commands.setTextSelection(1);
		await userEvent.keyboard("{Enter}/video");
		const menu = await vi.waitFor(() => {
			const element = document.querySelector("[data-slash-command-menu]");
			expect(element).toBeTruthy();
			return element!;
		});
		expect(menu.textContent).toContain("Acme video");
		expect(menu.textContent).not.toContain("Upload or choose a video");
		await userEvent.keyboard("{Escape}");
		expect(videos(latest())).toEqual([saved]);
	});

	it("doesn't upload dropped video files", async () => {
		const { pm } = await renderEditor({
			value: [INTRO],
			pluginBlocks: [{ type: "video", pluginId: "acme", label: "Acme video" }],
		});

		dropFiles(pm.querySelector("p")!, [videoFile("demo.webm")]);

		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-image-upload-placeholder] [role='alert']")?.textContent,
			).toContain("Only image files can be uploaded here."),
		);
		expect(vi.mocked(uploadMedia)).not.toHaveBeenCalled();
	});
});

describe("Video block conversion", () => {
	it("round-trips every field and leaves a plugin's video block alone", () => {
		const native = videoBlock({
			caption: "Launch day",
			asset: { _ref: "uid42", provider: "cloudflare-stream" },
		});
		const minimal = videoBlock({ _key: "video2", asset: { _ref: "01VIDEO" } });
		const empty: Block = { _type: "video", _key: "video3" };
		const plugin = videoBlock({ _key: "plugin1", autoplay: true });
		const pluginSize = videoBlock({ _key: "plugin2", width: "100%" });

		const pm = portableTextToProsemirror([native, minimal, empty, plugin, pluginSize]);

		expect(pm.content?.map((node) => (node as { type: string }).type)).toEqual([
			"videoBlock",
			"videoBlock",
			"videoBlock",
			"pluginBlock",
			"pluginBlock",
		]);
		expect(prosemirrorToPortableText(pm)).toStrictEqual([
			native,
			minimal,
			empty,
			plugin,
			pluginSize,
		]);
	});
});
