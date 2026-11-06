import { Schema } from "@tiptap/pm/model";
import { describe, expect, it } from "vitest";

import {
	createTextAnchor,
	locateQuote,
	posToTextOffset,
	resolveAnchor,
	sameAnchor,
	textOffsetToPos,
	type EditorialTextAnchor,
} from "../../src/editorial-anchors.js";

function block(key: string, ...texts: string[]) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: texts.map((text, i) => ({ _type: "span", _key: `${key}s${i}`, text, marks: [] })),
	};
}

const FOX = "The quick brown fox jumps over the lazy dog.";

function anchorOn(value: unknown, blockKey: string, quote: string): EditorialTextAnchor {
	const target = (value as ReturnType<typeof block>[]).find((b) => b._key === blockKey)!;
	const text = target.children.map((c) => c.text).join("");
	const start = text.indexOf(quote);
	return createTextAnchor(value, "content", blockKey, start, start + quote.length)!;
}

describe("createTextAnchor", () => {
	it("takes the quote and its context from across spans", () => {
		const value = [block("b1", "The quick ", "brown fox", " jumps")];

		expect(createTextAnchor(value, "content", "b1", 4, 15)).toEqual({
			type: "text",
			field: "content",
			blockKey: "b1",
			start: 4,
			end: 15,
			quote: "quick brown",
			prefix: "The ",
			suffix: " fox jumps",
		});
	});

	it("limits context to 64 code units without splitting a surrogate pair", () => {
		const before = `😀${"a".repeat(63)}`;
		const value = [block("b1", `${before}quote${"b".repeat(63)}😀`)];

		const anchor = createTextAnchor(value, "content", "b1", before.length, before.length + 5)!;

		expect(anchor.prefix).toBe("a".repeat(63));
		expect(anchor.suffix).toBe("b".repeat(63));
	});

	it("refuses empty, out-of-range and unknown ranges", () => {
		const value = [block("b1", FOX), { _type: "image", _key: "img" }];

		expect(createTextAnchor(value, "content", "b1", 3, 3)).toBeNull();
		expect(createTextAnchor(value, "content", "b1", 40, 50)).toBeNull();
		expect(createTextAnchor(value, "content", "img", 0, 1)).toBeNull();
		expect(createTextAnchor(value, "content", "nope", 0, 1)).toBeNull();
	});
});

describe("resolveAnchor", () => {
	it("keeps an anchor whose text hasn't moved", () => {
		const value = [block("b1", FOX)];
		const anchor = anchorOn(value, "b1", "brown");

		expect(resolveAnchor(value, anchor)).toEqual({ state: "attached", anchor });
	});

	it("follows the quote when text is inserted before it", () => {
		const original = [block("b1", FOX)];
		const anchor = anchorOn(original, "b1", "brown");
		const edited = [block("b1", `Look! ${FOX}`)];

		const resolved = resolveAnchor(edited, anchor);

		expect(resolved).toMatchObject({
			state: "attached",
			anchor: {
				blockKey: "b1",
				start: anchor.start + 6,
				end: anchor.end + 6,
				prefix: "Look! The quick ",
			},
		});
	});

	it("follows a block that moved", () => {
		const original = [block("b1", "Intro."), block("b2", FOX)];
		const anchor = anchorOn(original, "b2", "lazy");

		const resolved = resolveAnchor([block("b2", FOX), block("b1", "Intro.")], anchor);

		expect(resolved).toEqual({ state: "attached", anchor });
	});

	it("finds the quote in another block when its block's key changed", () => {
		const anchor = anchorOn([block("b1", FOX)], "b1", "lazy dog");

		const resolved = resolveAnchor([block("b9", FOX)], anchor);

		expect(resolved).toMatchObject({
			state: "attached",
			anchor: { blockKey: "b9", start: anchor.start, quote: "lazy dog" },
		});
	});

	it("orphans an anchor whose quote was deleted", () => {
		const anchor = anchorOn([block("b1", FOX)], "b1", "brown");

		expect(resolveAnchor([block("b1", "The quick fox.")], anchor)).toEqual({ state: "orphaned" });
	});

	it("prefers the duplicate with matching context, then the nearest", () => {
		const original = [block("b1", "red cat, red dog, red cat")];
		const lastCat: EditorialTextAnchor = {
			...createTextAnchor(original, "content", "b1", 22, 25)!,
		};
		const edited = [block("b1", "red cat, big red dog, red cat, red cat")];

		const resolved = resolveAnchor(edited, lastCat);
		expect(resolved).toMatchObject({ state: "attached", anchor: { start: 26, end: 29 } });

		const bare: EditorialTextAnchor = { ...lastCat, prefix: "", suffix: "", start: 33, end: 36 };
		expect(resolveAnchor([block("b1", "cat cat cat cat")], bare)).toMatchObject({
			state: "attached",
			anchor: { start: 12 },
		});
	});

	it("matches right-to-left text by code units", () => {
		const value = [block("b1", "مرحبا بالعالم الجميل")];
		const anchor = anchorOn(value, "b1", "بالعالم");
		const edited = [block("b1", "قال: مرحبا بالعالم الجميل")];

		expect(resolveAnchor(edited, anchor)).toMatchObject({
			state: "attached",
			anchor: { start: anchor.start + 5, quote: "بالعالم" },
		});
	});

	it("doesn't match a quote against a different combining sequence", () => {
		const precomposed = "caf\u00e9";
		const decomposed = "cafe\u0301";
		const anchor = anchorOn([block("b1", `${precomposed} au lait`)], "b1", precomposed);

		expect(resolveAnchor([block("b1", `${decomposed} au lait`)], anchor)).toEqual({
			state: "orphaned",
		});
	});

	it("resolves block anchors by key and keeps entry and field anchors", () => {
		const value = [block("b1", FOX)];

		expect(resolveAnchor(value, { type: "block", field: "content", blockKey: "b1" }).state).toBe(
			"attached",
		);
		expect(resolveAnchor(value, { type: "block", field: "content", blockKey: "b2" }).state).toBe(
			"orphaned",
		);
		expect(resolveAnchor(undefined, { type: "entry" }).state).toBe("attached");
		expect(resolveAnchor(undefined, { type: "field", field: "title" }).state).toBe("attached");
	});
});

describe("locateQuote", () => {
	const value = [block("b1", "One fish, two fish."), block("b2", "Red fish, blue fish.")];

	it("finds a unique quote", () => {
		expect(locateQuote(value, "content", "blue")).toMatchObject({
			status: "found",
			anchor: { blockKey: "b2", start: 10, end: 14 },
		});
	});

	it("uses context to pick between duplicates and reports a tie", () => {
		expect(locateQuote(value, "content", "fish", { prefix: "blue " })).toMatchObject({
			status: "found",
			anchor: { blockKey: "b2", start: 15 },
		});
		expect(locateQuote(value, "content", "fish")).toEqual({ status: "ambiguous" });
		expect(locateQuote(value, "content", "whale")).toEqual({ status: "missing" });
	});
});

describe("sameAnchor", () => {
	it("compares every part of a text anchor", () => {
		const anchor = anchorOn([block("b1", FOX)], "b1", "fox");

		expect(sameAnchor(anchor, { ...anchor })).toBe(true);
		expect(sameAnchor(anchor, { ...anchor, prefix: "" })).toBe(false);
		expect(sameAnchor(anchor, { type: "entry" })).toBe(false);
	});
});

describe("ProseMirror position conversion", () => {
	const schema = new Schema({
		nodes: {
			doc: { content: "block+" },
			paragraph: { group: "block", content: "inline*" },
			text: { group: "inline" },
			hardBreak: { group: "inline", inline: true },
			mention: { group: "inline", inline: true, atom: true },
		},
	});
	const paragraph = schema.node("paragraph", null, [
		schema.text("ab"),
		schema.node("hardBreak"),
		schema.text("cd"),
		schema.node("mention"),
		schema.text("e"),
	]);
	const contentStart = 1;

	it("counts a hard break as the newline Portable Text stores for it", () => {
		// Portable Text text: "ab\ncde"
		expect(textOffsetToPos(paragraph, contentStart, 0)).toBe(1);
		expect(textOffsetToPos(paragraph, contentStart, 2)).toBe(3);
		expect(textOffsetToPos(paragraph, contentStart, 3)).toBe(4);
		expect(textOffsetToPos(paragraph, contentStart, 5)).toBe(6);
		expect(textOffsetToPos(paragraph, contentStart, 6)).toBe(8);

		expect(posToTextOffset(paragraph, contentStart, 1)).toBe(0);
		expect(posToTextOffset(paragraph, contentStart, 4)).toBe(3);
		expect(posToTextOffset(paragraph, contentStart, 6)).toBe(5);
		expect(posToTextOffset(paragraph, contentStart, 7)).toBe(5);
		expect(posToTextOffset(paragraph, contentStart, 8)).toBe(6);
	});

	it("round-trips every offset", () => {
		for (let offset = 0; offset <= 6; offset++) {
			const pos = textOffsetToPos(paragraph, contentStart, offset);
			expect(posToTextOffset(paragraph, contentStart, pos)).toBe(offset);
		}
	});

	it("places offsets past the end at the end of the block", () => {
		expect(textOffsetToPos(paragraph, contentStart, 99)).toBe(
			contentStart + paragraph.content.size,
		);
	});
});
