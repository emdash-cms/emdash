import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { render } from "../utils/render.js";

function TestEditor({ direction }: { direction: "ltr" | "rtl" }) {
	const text =
		direction === "rtl"
			? "تتكامل الصور الجيدة مع الكلمات المحيطة بها. تُظهر هذه الصورة كيف يحوّل الضوء التفاصيل البسيطة إلى أشكال مميزة. وتواصل الفقرة التالية القصة."
			: "The lava lamps in San Francisco have company. London has double pendulums, Austin has suspended rainbow mobiles, and Lisbon has a wall of wave machines.";
	const editor = useEditor({
		extensions: [StarterKit],
		editorProps: {
			attributes: { class: "prose prose-sm sm:prose-base flow-root", dir: direction },
		},
		content: `<p>${text}</p><p>${text}</p>`,
		immediatelyRender: true,
	});
	return (
		<div style={{ width: 480, maxWidth: "100%" }}>
			<EditorContent editor={editor} />
		</div>
	);
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Editor paragraph spacing", () => {
	it.each([
		{ width: 1280, direction: "ltr" },
		{ width: 390, direction: "ltr" },
		{ width: 1280, direction: "rtl" },
		{ width: 390, direction: "rtl" },
	] as const)(
		"separates paragraphs from wrapped lines at $width px in $direction",
		async ({ width, direction }) => {
			await page.viewport(width, 800);
			const screen = await render(<TestEditor direction={direction} />);
			await vi.waitFor(() => {
				expect(screen.container.querySelectorAll(".ProseMirror > p")).toHaveLength(2);
			});
			const host = screen.container.querySelector<HTMLElement>(".ProseMirror")!;
			const [first, second] = host.querySelectorAll("p");
			const range = document.createRange();
			range.selectNodeContents(first!);
			const lines = range.getClientRects();
			expect(lines.length).toBeGreaterThan(1);

			expect.soft(getComputedStyle(first!).fontSize).toBe("16px");
			expect.soft(lines[1]!.top - lines[0]!.top).toBeCloseTo(24, 0);
			expect
				.soft(second!.getBoundingClientRect().top - first!.getBoundingClientRect().bottom)
				.toBeCloseTo(16, 0);
			expect
				.soft(first!.getBoundingClientRect().top - host.getBoundingClientRect().top)
				.toBeCloseTo(0, 0);
			expect
				.soft(host.getBoundingClientRect().bottom - second!.getBoundingClientRect().bottom)
				.toBeCloseTo(0, 0);
		},
	);
});
