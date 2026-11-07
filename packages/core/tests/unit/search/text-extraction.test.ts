import { describe, expect, it } from "vitest";

import { extractPlainText, extractSearchableFields } from "../../../src/search/text-extraction.js";

describe("extractPlainText", () => {
	it("includes video captions", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				caption: "Keynote recording",
			},
		]);

		expect(text).toBe("Keynote recording");
	});

	it("leaves the caption of a plugin's video block alone", () => {
		const text = extractPlainText([
			{
				_type: "video",
				_key: "video1",
				asset: { _ref: "01VIDEO" },
				autoplay: true,
				caption: "Internal note",
			},
		]);

		expect(text).toBe("");
	});
});

describe("extractSearchableFields with blocks fields", () => {
	const prose = (text: string) => [
		{ _type: "block", _key: "p", children: [{ _type: "span", _key: "s", text }] },
	];
	const layout = [
		{
			_type: "prose",
			_key: "a",
			body: prose("Opening paragraph"),
			admin_label: "Intro",
			url: "https://example.com/x",
			variant: "wide",
			count: 3,
		},
		{ _type: "two_column", _key: "b", left: prose("Left column"), right: prose("Right column") },
	];

	it("extracts Portable Text sub-fields of each block", () => {
		const result = extractSearchableFields({ layout }, ["layout"], { layout: "blocks" });
		expect(result.layout).toBe("Opening paragraph\nLeft column\nRight column");
	});

	it("skips _-prefixed keys and non-text sub-fields", () => {
		const result = extractSearchableFields({ layout }, ["layout"], { layout: "blocks" });
		expect(result.layout).not.toContain("prose");
		expect(result.layout).not.toContain("two_column");
		expect(result.layout).not.toContain("3");
	});

	it("does not emit string, select, or url sub-fields", () => {
		const result = extractSearchableFields({ layout }, ["layout"], { layout: "blocks" });
		for (const noise of ["Intro", "example.com", "wide"]) {
			expect(result.layout).not.toContain(noise);
		}
	});

	it("does not emit string sub-fields inside repeater rows", () => {
		const withRows = [
			{
				_type: "gallery",
				_key: "g",
				items: [{ _key: "r1", caption: "Row caption" }],
				body: prose("Gallery intro"),
			},
		];
		const result = extractSearchableFields({ layout: withRows }, ["layout"], { layout: "blocks" });
		expect(result.layout).toBe("Gallery intro");
	});

	it("accepts a JSON string value and tolerates empty or invalid values", () => {
		const types = { layout: "blocks" };
		expect(
			extractSearchableFields({ layout: JSON.stringify(layout) }, ["layout"], types).layout,
		).toContain("Left column");
		expect(extractSearchableFields({ layout: [] }, ["layout"], types).layout).toBe("");
		expect(extractSearchableFields({ layout: "not json" }, ["layout"], types).layout).toBe("");
		expect(extractSearchableFields({ layout: null }, ["layout"], types).layout).toBe("");
	});

	it("keeps Portable Text and plain fields unchanged when types are given", () => {
		const result = extractSearchableFields(
			{ title: "Hello", body: prose("World") },
			["title", "body"],
			{ title: "string", body: "portableText" },
		);
		expect(result).toEqual({ title: "Hello", body: "World" });
	});
});
