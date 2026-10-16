import { Editor, type JSONContent } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import * as React from "react";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it } from "vitest";

import {
	DocumentOutline,
	extractHeadings,
	findCurrentHeadingIndex,
} from "../../src/components/editor/DocumentOutline";
import { Sidebar, useSidebar } from "../../src/components/Sidebar";
import { render } from "../utils/render.tsx";

import "../../dist/styles.css";

const SCROLL_MARGIN_TOP = 96;

const editors: Editor[] = [];
const hosts: HTMLElement[] = [];

afterEach(() => {
	for (const editor of editors.splice(0)) editor.destroy();
	for (const host of hosts.splice(0)) host.remove();
});

function heading(level: number, text: string): JSONContent {
	return { type: "heading", attrs: { level }, content: [{ type: "text", text }] };
}

function paragraphs(count: number): JSONContent[] {
	return Array.from({ length: count }, (_value, index) => ({
		type: "paragraph",
		content: [{ type: "text", text: `Paragraph ${index + 1}` }],
	}));
}

function createEditor(content: JSONContent[]) {
	const scroller = document.createElement("div");
	scroller.style.height = "400px";
	scroller.style.overflowY = "auto";
	const element = document.createElement("div");
	scroller.append(element);
	document.body.append(scroller);
	hosts.push(scroller);

	const editor = new Editor({
		element,
		extensions: [StarterKit],
		content: { type: "doc", content },
		editorProps: { scrollMargin: { top: SCROLL_MARGIN_TOP, right: 5, bottom: 5, left: 5 } },
	});
	editors.push(editor);
	return { editor, scroller };
}

function headingElement(editor: Editor, text: string): HTMLElement {
	const element = [...editor.view.dom.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")].find(
		(candidate) => candidate.textContent === text,
	);
	if (!element) throw new Error(`No heading "${text}"`);
	return element;
}

function offsetFromScrollerTop(element: HTMLElement, scroller: HTMLElement): number {
	return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

function expectAtScrollMargin(editor: Editor, text: string, scroller: HTMLElement) {
	const offset = offsetFromScrollerTop(headingElement(editor, text), scroller);
	expect(Math.abs(offset - SCROLL_MARGIN_TOP)).toBeLessThanOrEqual(1);
}

function tap(element: Element) {
	element.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
	element.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
	element.dispatchEvent(
		new PointerEvent("click", { bubbles: true, detail: 1, pointerType: "touch" }),
	);
}

function nextFrames() {
	return new Promise<void>((resolve) => {
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
	});
}

const longDocument = [
	...paragraphs(10),
	heading(2, "Introduction"),
	...paragraphs(12),
	heading(3, "Install"),
	...paragraphs(12),
	heading(3, "Configure"),
	...paragraphs(12),
	heading(2, "Conclusion"),
	...paragraphs(2),
];

function SheetProbe() {
	const { openMobile, setOpenMobile } = useSidebar();
	return (
		<button type="button" data-open={openMobile} onClick={() => setOpenMobile(true)}>
			Open sheet
		</button>
	);
}

function renderOutline(editor: Editor, { mobile = false } = {}) {
	return render(
		<Sidebar.Provider mobileBreakpoint={mobile ? 10_000 : 100}>
			<SheetProbe />
			<DocumentOutline editor={editor} />
		</Sidebar.Provider>,
	);
}

describe("extractHeadings", () => {
	it("returns empty array when editor is null", () => {
		expect(extractHeadings(null)).toEqual([]);
	});

	it("skips headings with no text", () => {
		const { editor } = createEditor([
			heading(2, "Title"),
			{ type: "heading", attrs: { level: 2 } },
			heading(2, "   "),
			heading(2, "Valid"),
		]);

		expect(extractHeadings(editor).map((item) => item.text)).toEqual(["Title", "Valid"]);
	});

	it("nests headings by the document's structure rather than their absolute level", () => {
		const { editor } = createEditor([
			heading(2, "Introduction"),
			heading(3, "Why"),
			heading(4, "Level four"),
			heading(5, "Level five"),
			heading(6, "Level six"),
			heading(2, "Setup"),
			heading(4, "Skipped a level"),
			heading(1, "Stray H1"),
			heading(2, "Under the H1"),
		]);

		expect(extractHeadings(editor).map(({ text, depth }) => [text, depth])).toEqual([
			["Introduction", 0],
			["Why", 1],
			["Level four", 2],
			["Level five", 3],
			["Level six", 4],
			["Setup", 0],
			["Skipped a level", 1],
			["Stray H1", 0],
			["Under the H1", 1],
		]);
	});
});

describe("findCurrentHeadingIndex", () => {
	it("returns -1 while every heading is below the reading line", () => {
		expect(findCurrentHeadingIndex([200, 400], 100)).toBe(-1);
	});

	it("returns the last heading at or above the reading line", () => {
		expect(findCurrentHeadingIndex([-300, 50, 100, 400], 100)).toBe(2);
	});
});

describe("DocumentOutline", () => {
	it("puts the caret at the start of the clicked heading and scrolls it below the toolbar margin", async () => {
		const { editor, scroller } = createEditor(longDocument);
		const screen = await renderOutline(editor);

		await screen.getByRole("button", { name: "Configure" }).click();
		await nextFrames();

		const { $from } = editor.state.selection;
		expect($from.parent.type.name).toBe("heading");
		expect($from.parent.textContent).toBe("Configure");
		expect($from.parentOffset).toBe(0);
		expect(document.activeElement).toBe(editor.view.dom);
		expectAtScrollMargin(editor, "Configure", scroller);
		await expect
			.element(screen.getByRole("button", { name: "Configure" }))
			.toHaveAttribute("aria-current", "location");
	});

	it("marks the heading of the section scrolled to the top as current", async () => {
		const { editor, scroller } = createEditor(longDocument);
		const screen = await renderOutline(editor);
		await nextFrames();
		expect(screen.container.querySelector("[aria-current]")).toBeNull();

		scroller.scrollTop += offsetFromScrollerTop(headingElement(editor, "Install"), scroller) - 40;

		await expect
			.element(screen.getByRole("button", { name: "Install" }))
			.toHaveAttribute("aria-current", "location");

		scroller.scrollTop += offsetFromScrollerTop(headingElement(editor, "Configure"), scroller) - 40;

		await expect
			.element(screen.getByRole("button", { name: "Configure" }))
			.toHaveAttribute("aria-current", "location");
	});

	it("updates the current section when the editor reflows without scrolling", async () => {
		const { editor, scroller } = createEditor(longDocument);
		// Scroll anchoring would hold the content in place with a scroll.
		scroller.style.overflowAnchor = "none";
		const screen = await renderOutline(editor);
		scroller.scrollTop += offsetFromScrollerTop(headingElement(editor, "Install"), scroller) - 40;
		await expect
			.element(screen.getByRole("button", { name: "Install" }))
			.toHaveAttribute("aria-current", "location");

		scroller.style.fontSize = "2em";

		await expect
			.element(screen.getByRole("button", { name: "Introduction" }))
			.toHaveAttribute("aria-current", "location");
	});

	it("keeps a clicked heading current when it can't scroll up to the reading line", async () => {
		const { editor, scroller } = createEditor(longDocument);
		const screen = await renderOutline(editor);
		const conclusion = screen.getByRole("button", { name: "Conclusion" });

		await conclusion.click();
		await nextFrames();

		expect(offsetFromScrollerTop(headingElement(editor, "Conclusion"), scroller)).toBeGreaterThan(
			SCROLL_MARGIN_TOP + 1,
		);
		await expect.element(conclusion).toHaveAttribute("aria-current", "location");

		scroller.scrollTop -= 1;

		await expect
			.element(screen.getByRole("button", { name: "Configure" }))
			.toHaveAttribute("aria-current", "location");
	});

	it("keeps a clicked heading current when a heading above it is cleared", async () => {
		const { editor } = createEditor(longDocument);
		const screen = await renderOutline(editor);
		const conclusion = screen.getByRole("button", { name: "Conclusion" });
		await conclusion.click();
		await expect.element(conclusion).toHaveAttribute("aria-current", "location");

		const install = extractHeadings(editor).find((item) => item.text === "Install")!;
		editor.commands.deleteRange({
			from: install.pos + 1,
			to: install.pos + 1 + install.text.length,
		});

		await expect.element(screen.getByRole("button", { name: "Install" })).not.toBeInTheDocument();
		await nextFrames();
		expect(screen.container.querySelector("[aria-current]")?.textContent).toBe("Conclusion");
	});

	it("shows the current-heading indicator in place, then slides it between headings", async () => {
		const { editor } = createEditor(longDocument);
		const screen = await renderOutline(editor);
		const indicatorTop = () =>
			screen.container.querySelector("ul + [aria-hidden]")?.getBoundingClientRect().top ?? NaN;
		const row = (name: string) => screen.getByRole("button", { name }).element();
		await nextFrames();
		expect(screen.container.querySelector("[aria-current]")).toBeNull();

		flushSync(() => row("Configure").click());
		expect(indicatorTop()).toBeCloseTo(row("Configure").getBoundingClientRect().top, 0);

		flushSync(() => row("Introduction").click());
		const introductionTop = row("Introduction").getBoundingClientRect().top;
		expect(indicatorTop()).toBeGreaterThan(introductionTop + 1);
		await expect.poll(indicatorTop).toBeCloseTo(introductionTop, 0);
	});

	it("closes the settings sheet and focuses the editor when the sidebar is a sheet", async () => {
		const { editor, scroller } = createEditor(longDocument);
		const screen = await renderOutline(editor, { mobile: true });
		const sheetProbe = screen.getByRole("button", { name: "Open sheet" });
		await sheetProbe.click();
		await expect.element(sheetProbe).toHaveAttribute("data-open", "true");

		await screen.getByRole("button", { name: "Install" }).click();

		await expect.element(sheetProbe).toHaveAttribute("data-open", "false");
		await nextFrames();
		expect(document.activeElement).toBe(editor.view.dom);
		expect(editor.state.selection.$from.parent.textContent).toBe("Install");
		expectAtScrollMargin(editor, "Install", scroller);
	});

	it("moves the caret without focusing the editor when a heading is tapped", async () => {
		const { editor, scroller } = createEditor(longDocument);
		const screen = await renderOutline(editor);
		const install = screen.getByRole("button", { name: "Install" });

		tap(install.element());

		await expect.element(install).toHaveAttribute("aria-current", "location");
		await nextFrames();
		expect(document.activeElement).not.toBe(editor.view.dom);
		expect(editor.state.selection.$from.parent.textContent).toBe("Install");
		expectAtScrollMargin(editor, "Install", scroller);
	});
});
