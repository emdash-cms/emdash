import { describe, it, expect } from "vitest";

import {
	applySynonyms,
	compileSynonyms,
	flattenContentRecord,
	packTitleDescription,
	unpackTitleDescription,
} from "../../src/plugins/ai-search.js";

describe("packTitleDescription() / unpackTitleDescription()", () => {
	it("round-trips a normal title and multi-word description", () => {
		const packed = packTitleDescription("My Post", "A short summary of the post");
		expect(unpackTitleDescription(packed)).toEqual({
			title: "My Post",
			description: "A short summary of the post",
		});
	});

	it("handles an empty description", () => {
		expect(unpackTitleDescription(packTitleDescription("Hello", ""))).toEqual({
			title: "Hello",
			description: "",
		});
	});

	it("handles an empty title", () => {
		expect(unpackTitleDescription(packTitleDescription("", "some desc"))).toEqual({
			title: "",
			description: "some desc",
		});
	});

	it("handles both empty", () => {
		expect(unpackTitleDescription(packTitleDescription("", ""))).toEqual({
			title: "",
			description: "",
		});
	});

	it("preserves a separator inside the description (splits on first only)", () => {
		expect(unpackTitleDescription(packTitleDescription("T", "a\u001Fb"))).toEqual({
			title: "T",
			description: "a\u001Fb",
		});
	});

	it("treats a value with no separator as a bare title", () => {
		expect(unpackTitleDescription("legacy raw string")).toEqual({
			title: "legacy raw string",
			description: "",
		});
	});

	it("unpacks an empty string", () => {
		expect(unpackTitleDescription("")).toEqual({ title: "", description: "" });
	});

	it("round-trips unicode titles and punctuation descriptions exactly", () => {
		const title = "Café ☕ del Mar — Título";
		const description = "Well, hello! (yes) — it's here: 100%.";
		expect(unpackTitleDescription(packTitleDescription(title, description))).toEqual({
			title,
			description,
		});
	});

	it("caps the packed metadata at 500 characters by truncating the description", () => {
		const title = "T".repeat(165);
		const description = "description ".repeat(40).trim();
		const packed = packTitleDescription(title, description);
		const unpacked = unpackTitleDescription(packed);

		expect(packed.length).toBeLessThanOrEqual(500);
		expect(unpacked.title).toBe(title);
		expect(unpacked.description.length).toBeLessThan(description.length);
		expect(unpacked.description).toMatch(/…$/);
	});

	it("keeps the separator within the limit when the title consumes the budget", () => {
		const title = "T".repeat(499);
		const packed = packTitleDescription(title, "No room for this description");

		expect(packed).toHaveLength(500);
		expect(unpackTitleDescription(packed)).toEqual({ title, description: "" });
	});
});

describe("compileSynonyms() / applySynonyms()", () => {
	it("rewrites whole words case-insensitively", () => {
		const rewriter = compileSynonyms([{ from: "autorag", to: "AI Search" }]);

		expect(applySynonyms("What is AutoRAG?", rewriter)).toBe("What is AI Search?");
		expect(applySynonyms("autoragged", rewriter)).toBe("autoragged");
	});

	it("prefers longer phrases and escapes regular-expression characters", () => {
		const rewriter = compileSynonyms([
			{ from: "AI", to: "artificial intelligence" },
			{ from: "AI Search", to: "AutoRAG" },
			{ from: "C++", to: "C plus plus" },
		]);

		expect(applySynonyms("AI Search and C++", rewriter)).toBe("AutoRAG and C plus plus");
	});

	it("returns the original query when no synonyms are configured", () => {
		expect(applySynonyms("unchanged", compileSynonyms([]))).toBe("unchanged");
	});
});

describe("flattenContentRecord()", () => {
	it("lifts editable fields out of `.data` (the content-hook shape)", () => {
		const hookContent = {
			id: "01H",
			slug: "hello-world",
			status: "published",
			locale: "fr",
			data: { title: "Bonjour le monde", body: "Le renard brun rapide" },
		};
		const record = flattenContentRecord(hookContent);
		expect(record.title).toBe("Bonjour le monde");
		expect(record.body).toBe("Le renard brun rapide");
		// System columns at the top level are preserved.
		expect(record.slug).toBe("hello-world");
		expect(record.status).toBe("published");
		expect(record.locale).toBe("fr");
	});

	it("is a no-op when there is no `.data` object", () => {
		expect(flattenContentRecord({ id: "1", title: "Flat" })).toEqual({ id: "1", title: "Flat" });
		expect(flattenContentRecord({ id: "1", data: null })).toEqual({ id: "1", data: null });
	});
});
