import { describe, expect, it } from "vitest";

import { copyEditsText } from "../../src/lib/co-editing/copy-edits";

function block(text: string, extra: Record<string, unknown> = {}) {
	return {
		_type: "block",
		_key: text,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${text}-span`, text, marks: [] }],
		...extra,
	};
}

describe("copyEditsText", () => {
	it("writes each field with text under its label, in form order", () => {
		const values: Record<string, unknown> = {
			title: "Spring launch",
			price: 42,
			tags: ["news", "launch"],
			featured: true,
			cover: { id: "media_1", alt: "A cover" },
			author: "entry_ada",
			meta: { theme: "dark" },
			subtitle: "On March 3",
		};

		const text = copyEditsText(
			{
				title: { kind: "string", label: "Title" },
				price: { kind: "number", label: "Price" },
				tags: { kind: "multiSelect", label: "Tags" },
				featured: { kind: "boolean", label: "Featured" },
				cover: { kind: "image", label: "Cover" },
				author: { kind: "reference", label: "Author" },
				meta: { kind: "json", label: "Meta" },
				subtitle: { kind: "string" },
			},
			(name) => values[name],
		);

		expect(text).toBe(
			"Title\nSpring launch\n\nPrice\n42\n\nTags\nnews, launch\n\nsubtitle\nOn March 3",
		);
	});

	it("reads rich text as paragraphs, list items and code", () => {
		const body = [
			block("The new collection lands on March 3."),
			block("Small batches", { listItem: "bullet", level: 1 }),
			block("Recycled cotton", { listItem: "bullet", level: 1 }),
			block("Open the doors", { listItem: "number", level: 1 }),
			block("Send the list", { listItem: "number", level: 1 }),
			{ _type: "image", _key: "image", asset: { _ref: "media_1" } },
			{ _type: "code", _key: "code", language: "js", code: "launch();" },
			block("See you there."),
		];

		const text = copyEditsText({ body: { kind: "portableText", label: "Body" } }, () => body);

		expect(text).toBe(
			[
				"Body",
				"The new collection lands on March 3.",
				"",
				"- Small batches",
				"- Recycled cotton",
				"1. Open the doors",
				"2. Send the list",
				"",
				"launch();",
				"",
				"See you there.",
			].join("\n"),
		);
	});

	it("numbers lists as the editor does", () => {
		const body = [
			block("Plan", { listItem: "number", level: 1, listId: "a", listStart: 1 }),
			block("Draft", { listItem: "number", level: 2, listId: "a1", listStart: 1 }),
			block("Review", { listItem: "number", level: 2, listId: "a1", listStart: 1 }),
			block("Build", { listItem: "number", level: 1, listId: "a", listStart: 1 }),
			block("A note between the steps."),
			block("Ship", { listItem: "number", level: 1, listId: "a", listStart: 1 }),
			block("Countdown", { listItem: "number", level: 1, listId: "b", listStart: 5 }),
			block("Untracked", { listItem: "number", level: 1 }),
			{ _type: "image", _key: "image", asset: { _ref: "media_1" } },
			block("Starts again", { listItem: "number", level: 1 }),
		];

		const text = copyEditsText({ body: { kind: "portableText", label: "Body" } }, () => body);

		expect(text).toBe(
			[
				"Body",
				"1. Plan",
				"  1. Draft",
				"  2. Review",
				"2. Build",
				"",
				"A note between the steps.",
				"",
				"3. Ship",
				"5. Countdown",
				"1. Untracked",
				"",
				"1. Starts again",
			].join("\n"),
		);
	});

	it("writes a select's labels, not its stored values", () => {
		const options = [
			{ value: "draft-ready", label: "Ready for review" },
			{ value: "news", label: "News" },
		];
		const values: Record<string, unknown> = { stage: "draft-ready", topics: ["news", "other"] };

		const text = copyEditsText(
			{
				stage: { kind: "select", label: "Stage", options },
				topics: { kind: "multiSelect", label: "Topics", options },
			},
			(name) => values[name],
		);

		expect(text).toBe("Stage\nReady for review\n\nTopics\nNews, other");
	});

	it("reads a table as rows of tab-separated cells", () => {
		const cell = (text: string) => ({
			_type: "tableCell",
			_key: `cell-${text}`,
			content: text ? [{ _type: "span", _key: `span-${text}`, text }] : [],
		});
		const row = (key: string, ...texts: string[]) => ({
			_type: "tableRow",
			_key: key,
			cells: texts.map(cell),
		});
		const body = [
			block("Sizes in stock:"),
			{
				_type: "table",
				_key: "sizes",
				rows: [
					row("head", "Size", "Count"),
					row("empty", "", ""),
					row("small", "S\tsmall", "12\nin store"),
				],
			},
		];

		const text = copyEditsText({ body: { kind: "portableText", label: "Body" } }, () => body);

		expect(text).toBe("Body\nSizes in stock:\n\nSize\tCount\nS small\t12 in store");
	});

	it("leaves out empty values", () => {
		const values: Record<string, unknown> = {
			title: "Kept",
			subtitle: "",
			blank: "   ",
			tags: [],
			body: [block("")],
			missing: undefined,
		};

		const text = copyEditsText(
			{
				subtitle: { kind: "string", label: "Subtitle" },
				blank: { kind: "string", label: "Blank" },
				title: { kind: "string", label: "Title" },
				tags: { kind: "multiSelect", label: "Tags" },
				body: { kind: "portableText", label: "Body" },
				missing: { kind: "number", label: "Missing" },
			},
			(name) => values[name],
		);

		expect(text).toBe("Title\nKept");
	});
});
