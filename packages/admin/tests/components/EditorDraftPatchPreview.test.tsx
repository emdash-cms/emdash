import { describe, expect, it } from "vitest";

import { EditorDraftPatchPreview } from "../../src/components/EditorDraftPatchPreview.js";
import { render } from "../utils/render.js";

const paragraph = {
	_type: "block",
	_key: "p1",
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: "s1", text: "Figures follow.", marks: [] }],
};

async function review(before: unknown, after: unknown, kind = "portableText") {
	const screen = await render(
		<EditorDraftPatchPreview
			operations={[{ field: "content", op: "set", value: after }]}
			fields={{ content: { label: "Content", kind } }}
			currentValues={{ content: before }}
			onApply={() => {}}
			onClose={() => {}}
		/>,
	);
	const values = screen
		.getByRole("dialog", { name: "Review proposed changes" })
		.getByRole("definition");
	await expect.element(values.first()).toBeVisible();
	const shown = {
		before: values.first().element().textContent,
		after: values.last().element().textContent,
	};
	await screen.unmount();
	return shown;
}

describe("EditorDraftPatchPreview", () => {
	it("shows rich-text blocks that hold no text", async () => {
		const htmlBlock = {
			_type: "htmlBlock",
			_key: "h1",
			html: '<a href="https://example.com/login">Sign in again</a>',
		};
		const shown = await review([paragraph], [paragraph, htmlBlock]);

		expect(shown.before).toBe("Figures follow.");
		expect(shown.after).toBe(`Figures follow.\n${JSON.stringify(htmlBlock)}`);
	});

	it("shows where rich-text links lead", async () => {
		const linked = (href: string) => ({
			...paragraph,
			markDefs: [{ _type: "link", _key: "l1", href }],
			children: [{ _type: "span", _key: "s1", text: "Figures follow.", marks: ["l1"] }],
		});
		const shown = await review(
			[linked("https://example.com/figures")],
			[linked("https://example.net/figures")],
		);

		expect(shown.before).toContain("https://example.com/figures");
		expect(shown.after).toContain("https://example.net/figures");
	});

	it("shows which rich text a link covers", async () => {
		const linkedAt = (index: number) => ({
			...paragraph,
			markDefs: [{ _type: "link", _key: "l1", href: "https://example.com/docs" }],
			children: ["Read ", "the docs", ". ", "Sign in", "."].map((text, position) => ({
				_type: "span",
				_key: `s${position}`,
				text,
				marks: position === index ? ["l1"] : [],
			})),
		});
		const shown = await review([linkedAt(1)], [linkedAt(3)]);

		expect(shown.after).not.toBe(shown.before);
	});

	it("shows rich-text formatting changes", async () => {
		const bold = {
			...paragraph,
			children: [{ ...paragraph.children[0], marks: ["strong"] }],
		};
		const changes = [
			{ ...paragraph, style: "h1" },
			bold,
			{ ...paragraph, listItem: "bullet", level: 1 },
		];

		for (const changed of changes) {
			const shown = await review([paragraph], [changed]);
			expect(shown.before).toBe("Figures follow.");
			expect(shown.after).toBe(JSON.stringify(changed));
		}
	});

	it("shows long values to their end", async () => {
		const text = `${"Figures follow. ".repeat(40)}The last word.`;
		const image = { id: "media-1", alt: "A chart. ".repeat(40), src: "https://example.com/a.png" };
		const paragraphs = Array.from({ length: 40 }, (_, index) => ({
			...paragraph,
			_key: `p${index}`,
			children: [{ _type: "span", _key: `s${index}`, text: `Paragraph ${index}.`, marks: [] }],
		}));

		expect((await review("", text, "string")).after).toBe(text);
		expect((await review(null, image, "image")).after).toBe(JSON.stringify(image));
		expect((await review([], paragraphs)).after).toContain("Paragraph 39.");
	});

	it("shows every property of a text-block-shaped item outside rich text", async () => {
		const items = [{ ...paragraph, href: "https://example.com/login" }];

		expect((await review(null, items, "json")).after).toBe(JSON.stringify(items));
	});
});
