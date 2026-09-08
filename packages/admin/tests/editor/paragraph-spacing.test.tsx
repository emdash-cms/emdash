import Placeholder from "@tiptap/extension-placeholder";
import { EditorContent, useEditor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { render } from "../utils/render.js";

function TestEditor({
	direction,
	showPlaceholder = false,
}: {
	direction: "ltr" | "rtl";
	showPlaceholder?: boolean;
}) {
	const placeholder =
		direction === "rtl"
			? "ابدأ الكتابة، أو اكتب '/' للأوامر"
			: "Start writing, or type '/' for commands";
	const text =
		direction === "rtl"
			? "تتكامل الصور الجيدة مع الكلمات المحيطة بها. تُظهر هذه الصورة كيف يحوّل الضوء التفاصيل البسيطة إلى أشكال مميزة. وتواصل الفقرة التالية القصة."
			: "The lava lamps in San Francisco have company. London has double pendulums, Austin has suspended rainbow mobiles, and Lisbon has a wall of wave machines.";
	const editor = useEditor({
		extensions: [StarterKit, Placeholder.configure({ placeholder })],
		editorProps: {
			attributes: { class: "prose prose-sm sm:prose-base flow-root", dir: direction },
		},
		content: showPlaceholder
			? `<p>Before</p><p></p><p>${placeholder}</p>`
			: `<p>${text}</p><p>${text}</p>`,
		immediatelyRender: true,
		onCreate: ({ editor: instance }) => {
			if (showPlaceholder) {
				instance.commands.setTextSelection(instance.state.doc.firstChild!.nodeSize + 1);
			}
		},
	});
	return (
		<div style={{ width: showPlaceholder ? 80 : 480, maxWidth: "100%" }}>
			<EditorContent editor={editor} />
		</div>
	);
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("Editor paragraph spacing", () => {
	it.each(["ltr", "rtl"] as const)(
		"reserves room for a wrapped placeholder in %s",
		async (direction) => {
			const screen = await render(<TestEditor direction={direction} showPlaceholder />);
			await vi.waitFor(() => {
				expect(screen.container.querySelector("p.is-empty")).not.toBeNull();
			});
			await document.fonts.ready;
			const empty = screen.container.querySelector<HTMLElement>("p.is-empty")!;
			const following = empty.nextElementSibling!;
			const hintHeight = following.getBoundingClientRect().height;
			expect(hintHeight).toBeGreaterThan(24);
			expect(empty.textContent).toBe("");
			expect(empty.getBoundingClientRect().height).toBeCloseTo(hintHeight, 0);
			expect(following.getBoundingClientRect().top - empty.getBoundingClientRect().top).toBeCloseTo(
				hintHeight + 16,
				0,
			);

			await page.elementLocator(empty).click();
			await userEvent.keyboard("Hello");
			expect(empty.textContent).toBe("Hello");
			expect(empty.getBoundingClientRect().height).toBeCloseTo(24, 0);
			expect(
				following.getBoundingClientRect().top - empty.getBoundingClientRect().bottom,
			).toBeCloseTo(16, 0);
		},
	);

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
