import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import "../../dist/styles.css";
import { GalleryExtension } from "../../src/components/editor/GalleryNode.js";
import { render } from "../utils/render.js";

const imageSrc = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="gray"/></svg>')}`;
const longCaption =
	"Duty Manager, Incident Response and Customer Escalations for the Northern Region and all surrounding districts throughout the year";

function TestEditor({
	columns,
	direction,
	ready,
}: {
	columns: number | undefined;
	direction: "ltr" | "rtl";
	ready: (editor: Editor) => void;
}) {
	const editor = useEditor({
		extensions: [StarterKit, GalleryExtension],
		editorProps: { attributes: { class: "prose prose-sm sm:prose-base" } },
		content: {
			type: "doc",
			content: [
				{
					type: "gallery",
					attrs: {
						columns,
						images: Array.from({ length: 4 }, (_, index) => ({
							_key: `image-${index}`,
							asset: { url: imageSrc },
							caption: index === 1 ? longCaption : `Image ${index + 1}`,
						})),
					},
				},
			],
		},
		onCreate: ({ editor: instance }) => ready(instance),
	});
	return (
		<div dir={direction} style={{ width: 538, maxWidth: "100%" }}>
			<EditorContent editor={editor} />
		</div>
	);
}

describe.each(["ltr", "rtl"] as const)("Gallery layout in %s", (direction) => {
	it.each([undefined, 1, 4])(
		"keeps columns even and truncates long captions with columns=%s",
		async (columns) => {
			let editor: Editor | undefined;
			await render(
				<TestEditor
					columns={columns}
					direction={direction}
					ready={(value) => {
						editor = value;
					}}
				/>,
			);
			await vi.waitFor(() => expect(editor).toBeDefined());
			const host = editor!.view.dom;
			await vi.waitFor(() => expect(host.querySelectorAll("figure")).toHaveLength(4));
			await Promise.all(Array.from(host.querySelectorAll("img"), (image) => image.decode()));
			const figures = [...host.querySelectorAll("figure")];
			const grid = figures[0]!.parentElement!;
			const gridBounds = grid.getBoundingClientRect();
			expect(grid.scrollWidth).toBeLessThanOrEqual(grid.clientWidth);
			expect(host.scrollWidth).toBeLessThanOrEqual(host.clientWidth);
			const columnCount = columns ?? 3;
			const gap = Number.parseFloat(getComputedStyle(grid).columnGap);
			const expectedWidth = (grid.clientWidth - (columnCount - 1) * gap) / columnCount;
			for (const figure of figures) {
				const bounds = figure.getBoundingClientRect();
				expect(bounds.width).toBeCloseTo(expectedWidth, 0);
				expect(bounds.left).toBeGreaterThanOrEqual(gridBounds.left - 1);
				expect(bounds.right).toBeLessThanOrEqual(gridBounds.right + 1);
			}
			const caption = figures[1]!.querySelector("figcaption")!;
			expect(caption.textContent).toBe(longCaption);
			expect(caption.scrollWidth).toBeGreaterThan(caption.clientWidth);
			expect(getComputedStyle(caption).textOverflow).toBe("ellipsis");
			expect(getComputedStyle(caption).whiteSpace).toBe("nowrap");
			expect(getComputedStyle(caption).overflowX).toBe("hidden");
		},
	);
});
