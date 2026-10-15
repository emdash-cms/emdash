import type { Editor, JSONContent } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { TopBlockDocument } from "../../src/components/editor/EmbedBlockShell.js";
import { ImageExtension } from "../../src/components/editor/ImageNode.js";
import {
	ImageUploadExtension,
	type ImageUploadOptions,
} from "../../src/components/editor/ImageUploadExtension.js";
import { VideoExtension } from "../../src/components/editor/VideoNode.js";
import { render } from "../utils/render.js";

import "../../dist/styles.css";

const PNG_BYTES = Uint8Array.from(
	atob(
		"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	),
	(char) => char.charCodeAt(0),
);

function imageFile(name: string) {
	return new File([PNG_BYTES], name, { type: "image/png" });
}

function videoFile(name: string) {
	return new File([new Uint8Array(16)], name, { type: "video/mp4" });
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function attrsFor(file: File) {
	return {
		src: `/_emdash/api/media/file/${file.name}`,
		alt: file.name,
		mediaId: `media-${file.name}`,
	};
}

function textBlock(text: string) {
	return { type: "paragraph", content: [{ type: "text", text }] };
}

const TWO_PARAGRAPHS = [textBlock("First"), textBlock("Second")];

function TestEditor({
	upload,
	acceptsVideo,
	editable = true,
	content = TWO_PARAGRAPHS,
	onReady,
}: {
	upload: ImageUploadOptions["upload"];
	acceptsVideo?: () => boolean;
	editable?: boolean;
	content?: JSONContent[];
	onReady: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: acceptsVideo
			? [
					StarterKit.configure({ document: false }),
					TopBlockDocument,
					ImageExtension,
					VideoExtension,
					ImageUploadExtension.configure({ upload, acceptsVideo }),
				]
			: [StarterKit, ImageExtension, ImageUploadExtension.configure({ upload })],
		content: { type: "doc", content },
		editable,
		immediatelyRender: true,
	});
	React.useEffect(() => {
		if (editor) onReady(editor);
	}, [editor, onReady]);
	if (!editor) return null;
	return <EditorContent editor={editor} />;
}

async function setup(
	upload: ImageUploadOptions["upload"],
	options: { editable?: boolean; content?: JSONContent[]; acceptsVideo?: () => boolean } = {},
) {
	let editor: Editor | undefined;
	await render(
		<TestEditor
			upload={upload}
			acceptsVideo={options.acceptsVideo}
			editable={options.editable}
			content={options.content}
			onReady={(instance) => {
				editor = instance;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeDefined());
	return editor!;
}

function paragraph(text: string) {
	const element = [...document.querySelectorAll<HTMLElement>(".ProseMirror p")].find(
		(node) => node.textContent === text,
	);
	if (!element) throw new Error(`Paragraph "${text}" not found`);
	return element;
}

function dropFiles(target: HTMLElement, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	const rect = target.getBoundingClientRect();
	const event = new DragEvent("drop", {
		bubbles: true,
		cancelable: true,
		dataTransfer,
		clientX: rect.left + rect.width - 2,
		clientY: rect.top + rect.height / 2,
	});
	target.dispatchEvent(event);
	return event;
}

function pasteData(target: HTMLElement, data: { files?: File[]; html?: string; text?: string }) {
	const clipboardData = new DataTransfer();
	for (const file of data.files ?? []) clipboardData.items.add(file);
	if (data.html) clipboardData.setData("text/html", data.html);
	if (data.text) clipboardData.setData("text/plain", data.text);
	const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData });
	target.dispatchEvent(event);
	return event;
}

function blockTypes(editor: Editor) {
	return (editor.getJSON().content ?? []).map((node) => {
		if (node.type === "image") return `image:${String(node.attrs?.mediaId)}`;
		if (node.type === "videoBlock") return `video:${String(node.attrs?.mediaId)}`;
		return node.type === "paragraph" ? node.content?.[0]?.text : node.type;
	});
}

function textEnd(editor: Editor, text: string) {
	let end: number | undefined;
	editor.state.doc.descendants((node, pos) => {
		if (node.text === text) end = pos + text.length;
	});
	if (end === undefined) throw new Error(`Text "${text}" not found`);
	return end;
}

function waitForPlaceholder() {
	return vi.waitFor(() => {
		const element = document.querySelector<HTMLElement>("[data-image-upload-placeholder]");
		expect(element).not.toBeNull();
		return element!;
	});
}

describe("ImageUploadExtension", () => {
	it("shows a preview placeholder while uploading, then inserts the image between blocks", async () => {
		const pending = deferred<Record<string, unknown>>();
		const upload = vi.fn(() => pending.promise);
		const editor = await setup(upload);

		dropFiles(paragraph("First"), [imageFile("cat.png")]);

		const placeholder = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>("[data-image-upload-placeholder]");
			expect(element).not.toBeNull();
			return element!;
		});
		expect(placeholder.querySelector("img")?.getAttribute("src")).toMatch(/^blob:/);
		expect(placeholder.textContent).toContain("Uploading image…");
		expect(blockTypes(editor)).toEqual(["First", "Second"]);
		expect(upload).toHaveBeenCalledTimes(1);

		pending.resolve(attrsFor(imageFile("cat.png")));

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "image:media-cat.png", "Second"]),
		);
		expect(document.querySelector("[data-image-upload-placeholder]")).toBeNull();
	});

	it("shows a spinner hidden from screen readers and unmounts it with the placeholder", async () => {
		const pending = deferred<Record<string, unknown>>();
		const editor = await setup(() => pending.promise);

		dropFiles(paragraph("First"), [imageFile("cat.png")]);
		const placeholder = await waitForPlaceholder();
		const spinner = await vi.waitFor(() => {
			const element = placeholder.querySelector<HTMLElement>("[aria-hidden='true']:has(svg)");
			expect(element).not.toBeNull();
			return element!;
		});
		expect(
			placeholder.querySelector("[role='status']:not([aria-hidden='true'] *)")?.textContent,
		).toBe("Uploading image…");

		pending.resolve(attrsFor(imageFile("cat.png")));

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "image:media-cat.png", "Second"]),
		);
		await vi.waitFor(() => expect(spinner.childElementCount).toBe(0));
	});

	it("uploads images the browser can't display without a broken preview", async () => {
		const upload = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
		await setup(upload);

		dropFiles(paragraph("First"), [new File([PNG_BYTES], "photo.heic", { type: "image/heic" })]);

		const placeholder = await waitForPlaceholder();
		expect(placeholder.textContent).toContain("Uploading image…");
		expect(placeholder.querySelector("img")).toBeNull();
		expect(upload).toHaveBeenCalledTimes(1);
	});

	it("finishes an upload when another plugin registers while it is running", async () => {
		const pending = deferred<Record<string, unknown>>();
		const editor = await setup((_file, signal) => {
			signal.addEventListener("abort", () => pending.reject(signal.reason));
			return pending.promise;
		});

		dropFiles(paragraph("First"), [imageFile("cat.png")]);
		await vi.waitFor(() =>
			expect(document.querySelector("[data-image-upload-placeholder]")).not.toBeNull(),
		);
		editor.registerPlugin(new Plugin({ key: new PluginKey("late-menu"), view: () => ({}) }));
		pending.resolve(attrsFor(imageFile("cat.png")));

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "image:media-cat.png", "Second"]),
		);
	});

	it("keeps dropped images in the order they were dropped", async () => {
		const editor = await setup(async (file) => attrsFor(file));

		dropFiles(paragraph("First"), [
			imageFile("one.png"),
			imageFile("two.png"),
			imageFile("three.png"),
		]);

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual([
				"First",
				"image:media-one.png",
				"image:media-two.png",
				"image:media-three.png",
				"Second",
			]),
		);
	});

	it("shows the upload error in place until dismissed", async () => {
		const editor = await setup(async () => {
			throw new Error("File exceeds the 10 MB limit");
		});

		dropFiles(paragraph("First"), [imageFile("big.png")]);

		const alert = await vi.waitFor(() => {
			const element = document.querySelector<HTMLElement>(
				"[data-image-upload-placeholder] [role='alert']",
			);
			expect(element).not.toBeNull();
			return element!;
		});
		expect(alert.textContent).toContain("File exceeds the 10 MB limit");
		expect(blockTypes(editor)).toEqual(["First", "Second"]);

		document.querySelector<HTMLButtonElement>("[data-image-upload-placeholder] button")!.click();

		await vi.waitFor(() =>
			expect(document.querySelector("[data-image-upload-placeholder]")).toBeNull(),
		);
		expect(blockTypes(editor)).toEqual(["First", "Second"]);
	});

	it("explains that only images can be dropped and uploads nothing", async () => {
		const upload = vi.fn(async (file: File) => attrsFor(file));
		const editor = await setup(upload);

		const event = dropFiles(paragraph("First"), [
			new File(["%PDF"], "report.pdf", { type: "application/pdf" }),
		]);

		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-image-upload-placeholder] [role='alert']")?.textContent,
			).toContain("Only image files can be uploaded here."),
		);
		expect(upload).not.toHaveBeenCalled();
		expect(blockTypes(editor)).toEqual(["First", "Second"]);
	});

	it("uploads a pasted screenshot", async () => {
		const editor = await setup(async (file) => attrsFor(file));
		editor.commands.setTextSelection(6);

		const event = pasteData(editor.view.dom, { files: [imageFile("screenshot.png")] });

		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "image:media-screenshot.png", "Second"]),
		);
	});

	it("leaves rich pastes that also carry a picture of the selection to the normal paste", async () => {
		const upload = vi.fn(async (file: File) => attrsFor(file));
		const editor = await setup(upload);
		editor.commands.setTextSelection(6);

		pasteData(editor.view.dom, {
			files: [imageFile("word-render.png")],
			html: "<p>Pasted from Word</p>",
			text: "Pasted from Word",
		});

		await vi.waitFor(() => expect(editor.getText()).toContain("Pasted from Word"));
		expect(upload).not.toHaveBeenCalled();
	});

	it("keeps an upload's place when the next block is reformatted while it runs", async () => {
		const pending = deferred<Record<string, unknown>>();
		const editor = await setup(() => pending.promise, {
			content: [textBlock("First"), textBlock("Second"), textBlock("Third")],
		});

		dropFiles(paragraph("First"), [imageFile("cat.png")]);
		await waitForPlaceholder();
		editor.chain().setTextSelection(textEnd(editor, "Second")).setHeading({ level: 2 }).run();
		pending.resolve(attrsFor(imageFile("cat.png")));

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "image:media-cat.png", "heading", "Third"]),
		);
	});

	it("keeps the drop order when the blocks around the uploads are joined", async () => {
		const gate = deferred<void>();
		const editor = await setup(
			async (file) => {
				await gate.promise;
				return attrsFor(file);
			},
			{ content: [textBlock("First paragraph"), textBlock("Second"), textBlock("Third")] },
		);

		dropFiles(paragraph("First paragraph"), [imageFile("one.png"), imageFile("two.png")]);
		await waitForPlaceholder();
		const secondStart = textEnd(editor, "Second") - "Second".length;
		editor.chain().setTextSelection(secondStart).joinBackward().run();
		gate.resolve();

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual([
				"First paragraphSecond",
				"image:media-one.png",
				"image:media-two.png",
				"Third",
			]),
		);
	});

	it("puts an image pasted inside a list after the list, where Portable Text can save it", async () => {
		const editor = await setup(async (file) => attrsFor(file), {
			content: [
				textBlock("First"),
				{ type: "bulletList", content: [{ type: "listItem", content: [textBlock("Step")] }] },
				textBlock("Second"),
			],
		});
		editor.commands.setTextSelection(textEnd(editor, "Step"));

		pasteData(editor.view.dom, { files: [imageFile("screenshot.png")] });

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual([
				"First",
				"bulletList",
				"image:media-screenshot.png",
				"Second",
			]),
		);
	});

	it("accepts files dropped onto an upload that is still running", async () => {
		const upload = vi.fn(() => new Promise<Record<string, unknown>>(() => {}));
		await setup(upload);

		dropFiles(paragraph("First"), [imageFile("one.png")]);
		const event = dropFiles(await waitForPlaceholder(), [imageFile("two.png")]);

		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(document.querySelectorAll("[data-image-upload-placeholder]")).toHaveLength(2),
		);
	});

	it("leaves the content alone when the editor turns read-only before an upload finishes", async () => {
		const pending = deferred<Record<string, unknown>>();
		const editor = await setup(() => pending.promise);

		dropFiles(paragraph("First"), [imageFile("cat.png")]);
		await waitForPlaceholder();
		editor.setEditable(false);
		pending.resolve(attrsFor(imageFile("cat.png")));

		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-image-upload-placeholder] [role='alert']")?.textContent,
			).toContain("read-only"),
		);
		expect(blockTypes(editor)).toEqual(["First", "Second"]);
	});

	it("ignores dropped files when the editor is read-only", async () => {
		const upload = vi.fn(async (file: File) => attrsFor(file));
		await setup(upload, { editable: false });

		dropFiles(paragraph("First"), [imageFile("cat.png")]);

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(upload).not.toHaveBeenCalled();
		expect(document.querySelector("[data-image-upload-placeholder]")).toBeNull();
	});
});

describe("ImageUploadExtension with videos", () => {
	const acceptsVideo = () => true;

	function videoAttrsFor(file: File) {
		return { src: `/_emdash/api/media/file/${file.name}`, mediaId: `media-${file.name}` };
	}

	it("shows a video-shaped placeholder while uploading, then inserts a video block between blocks", async () => {
		const pending = deferred<Record<string, unknown>>();
		const editor = await setup(() => pending.promise, { acceptsVideo });

		dropFiles(paragraph("First"), [videoFile("launch.mp4")]);

		const placeholder = await waitForPlaceholder();
		expect(placeholder.textContent).toContain("Uploading video…");
		expect(placeholder.querySelector("img")).toBeNull();
		const { width, height } = placeholder.getBoundingClientRect();
		expect(width / height).toBeCloseTo(16 / 9, 1);

		pending.resolve(videoAttrsFor(videoFile("launch.mp4")));
		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "video:media-launch.mp4", "Second"]),
		);
	});

	it("keeps dropped images and videos in the order they were dropped", async () => {
		const editor = await setup(
			async (file) => (file.type.startsWith("video/") ? videoAttrsFor(file) : attrsFor(file)),
			{ acceptsVideo },
		);

		dropFiles(paragraph("First"), [imageFile("a.png"), videoFile("b.mp4"), imageFile("c.png")]);

		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual([
				"First",
				"image:media-a.png",
				"video:media-b.mp4",
				"image:media-c.png",
				"Second",
			]),
		);
	});

	it("uploads a pasted video", async () => {
		const editor = await setup(async (file) => videoAttrsFor(file), { acceptsVideo });
		editor.commands.setTextSelection(6);

		const event = pasteData(editor.view.dom, { files: [videoFile("clip.mp4")] });

		expect(event.defaultPrevented).toBe(true);
		await vi.waitFor(() =>
			expect(blockTypes(editor)).toEqual(["First", "video:media-clip.mp4", "Second"]),
		);
	});

	it("says images and videos can be dropped when a file is neither", async () => {
		const upload = vi.fn(async (file: File) => videoAttrsFor(file));
		await setup(upload, { acceptsVideo });

		dropFiles(paragraph("First"), [new File(["%PDF"], "report.pdf", { type: "application/pdf" })]);

		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-image-upload-placeholder] [role='alert']")?.textContent,
			).toContain("Only images and videos can be uploaded here."),
		);
		expect(upload).not.toHaveBeenCalled();
	});

	it("refuses videos while the editor doesn't take them", async () => {
		const upload = vi.fn(async (file: File) => videoAttrsFor(file));
		const editor = await setup(upload, { acceptsVideo: () => false });

		dropFiles(paragraph("First"), [videoFile("launch.mp4")]);

		await vi.waitFor(() =>
			expect(
				document.querySelector("[data-image-upload-placeholder] [role='alert']")?.textContent,
			).toContain("Only image files can be uploaded here."),
		);
		expect(upload).not.toHaveBeenCalled();
		expect(blockTypes(editor)).toEqual(["First", "Second"]);
	});
});
