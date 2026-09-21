import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { ImageAttributes } from "../../src/components/editor/ImageDetailPanel.js";
import { ImageExtension } from "../../src/components/editor/ImageNode.js";
import { render } from "../utils/render.js";

const imageSrc = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="gray"/></svg>')}`;

function TestEditor({
	attrs,
	ready,
}: {
	attrs: Partial<ImageAttributes>;
	ready: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: [StarterKit, ImageExtension],
		editorProps: { attributes: { class: "prose prose-sm sm:prose-base flow-root" } },
		content: {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: imageSrc,
						alt: "Diagram",
						width: 1200,
						height: 800,
						...attrs,
					},
				},
				{ type: "paragraph", content: [{ type: "text", text: "Following text" }] },
			],
		},
		onCreate: ({ editor: instance }) => ready(instance),
	});
	return (
		<div style={{ width: 480, maxWidth: "100%" }}>
			<EditorContent editor={editor} />
		</div>
	);
}

async function renderImage(attrs: Partial<ImageAttributes> = {}) {
	let editor: Editor | undefined;
	const screen = await render(
		<TestEditor
			attrs={attrs}
			ready={(value) => {
				editor = value;
			}}
		/>,
	);
	await vi.waitFor(() => expect(editor).toBeDefined());
	const image = screen.getByRole("img", { name: "Diagram" }).element() as HTMLImageElement;
	await image.decode();
	return { editor: editor!, image, host: editor!.view.dom };
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Editor image alignment", () => {
	it.each([
		{ width: 1280, caption: "" },
		{ width: 1280, caption: "Diagram caption" },
		{ width: 390, caption: "" },
		{ width: 390, caption: "Diagram caption" },
	])(
		"keeps image spacing compact at $width px with caption '$caption'",
		async ({ width, caption }) => {
			await page.viewport(width, 800);
			const { editor, image, host } = await renderImage({ caption });
			editor.commands.insertContentAt(0, {
				type: "paragraph",
				content: [{ type: "text", text: "Preceding text" }],
			});
			const before = host.querySelector("p")!;
			const after = host.querySelector("p:last-child")!;
			const figcaption = host.querySelector("figcaption");
			const imageBounds = image.getBoundingClientRect();

			expect(imageBounds.top - before.getBoundingClientRect().bottom).toBeCloseTo(16, 0);
			expect(
				after.getBoundingClientRect().top - (figcaption ?? image).getBoundingClientRect().bottom,
			).toBeCloseTo(16, 0);
			if (caption) {
				expect(figcaption).not.toBeNull();
				const captionGap = figcaption!.getBoundingClientRect().top - imageBounds.bottom;
				expect(captionGap).toBeGreaterThan(0);
				expect(captionGap).toBeLessThan(16);
			}
		},
	);

	it.each([
		{ displayWidth: 1200, displayHeight: 800, ratio: 1.5 },
		{ displayWidth: 1200, displayHeight: 600, ratio: 2 },
		{ displayWidth: 900, displayHeight: undefined, ratio: 1.5 },
		{ displayWidth: undefined, displayHeight: 600, ratio: 1.5 },
	])(
		"preserves the configured ratio for constrained $displayWidth × $displayHeight",
		async ({ ratio, ...attrs }) => {
			const { image, host } = await renderImage(attrs);
			const bounds = image.getBoundingClientRect();
			expect(bounds.width).toBeLessThanOrEqual(host.clientWidth);
			expect(bounds.width / bounds.height).toBeCloseTo(ratio, 2);
		},
	);

	it.each([
		{ displayWidth: 300, displayHeight: 300 },
		{ displayWidth: 600, displayHeight: 200 },
	])("crops without distorting a $displayWidth × $displayHeight image", async (attrs) => {
		const source = document.createElement("canvas");
		source.width = 1200;
		source.height = 800;
		const sourceContext = source.getContext("2d")!;
		sourceContext.fillStyle = "black";
		sourceContext.fillRect(0, 0, 1200, 800);
		sourceContext.fillStyle = "red";
		sourceContext.fillRect(500, 300, 200, 200);
		const { image } = await renderImage({ ...attrs, src: source.toDataURL() });
		const bounds = image.getBoundingClientRect();
		expect(bounds.width / bounds.height).toBeCloseTo(attrs.displayWidth / attrs.displayHeight, 2);

		const screenshot = new Image();
		screenshot.src = `data:image/png;base64,${await page.screenshot({ element: image, save: false })}`;
		await screenshot.decode();
		const canvas = document.createElement("canvas");
		canvas.width = screenshot.naturalWidth;
		canvas.height = screenshot.naturalHeight;
		const context = canvas.getContext("2d")!;
		context.drawImage(screenshot, 0, 0);
		const { data } = context.getImageData(0, 0, canvas.width, canvas.height);
		const redAt = (x: number, y: number) => {
			const offset = (y * canvas.width + x) * 4;
			return data[offset]! > 200 && data[offset + 1]! < 50 && data[offset + 2]! < 50;
		};
		let horizontal = 0;
		let vertical = 0;
		for (let x = 0; x < canvas.width; x++) {
			if (redAt(x, Math.floor(canvas.height / 2))) horizontal++;
		}
		for (let y = 0; y < canvas.height; y++) {
			if (redAt(Math.floor(canvas.width / 2), y)) vertical++;
		}
		const expectedSide = 200 * Math.max(canvas.width / 1200, canvas.height / 800);
		expect(Math.abs(horizontal - expectedSide)).toBeLessThanOrEqual(2);
		expect(Math.abs(vertical - expectedSide)).toBeLessThanOrEqual(2);
	});

	it.each(["ltr", "rtl"])("distinguishes None from Center in %s", async (direction) => {
		const { image, editor, host } = await renderImage({ displayWidth: 120, displayHeight: 80 });
		host.dir = direction;
		const initial = image.getBoundingClientRect();
		const container = host.getBoundingClientRect();
		expect(direction === "ltr" ? initial.left : initial.right).toBeCloseTo(
			direction === "ltr" ? container.left : container.right,
			0,
		);
		editor.commands.setNodeSelection(0);
		editor.commands.updateAttributes("image", { alignment: "center" });
		await vi.waitFor(() => {
			const centered = image.getBoundingClientRect();
			expect(centered.left + centered.width / 2).toBeCloseTo(
				container.left + container.width / 2,
				0,
			);
		});
	});

	it.each(["left", "right"] as const)("unfloats %s images on narrow screens", async (alignment) => {
		const { image, host } = await renderImage({ alignment });
		const block = image.closest<HTMLElement>("[data-node-view-wrapper]")!;
		expect(getComputedStyle(block).float).toBe(alignment);
		expect(image.getBoundingClientRect().width).toBeLessThanOrEqual(host.clientWidth / 2);
		await page.viewport(640, 800);
		await vi.waitFor(() => expect(getComputedStyle(block).float).toBe("none"));
		expect(image.getBoundingClientRect().width).toBeCloseTo(host.clientWidth, 0);
	});
});
