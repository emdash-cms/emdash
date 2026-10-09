import { describe, expect, it } from "vitest";

import {
	blockText,
	diffPortableText,
	diffWords,
	isPortableText,
} from "../../src/lib/revision-diff.js";

const para = (key: string, text: string) => ({
	_type: "block",
	_key: key,
	style: "normal",
	markDefs: [],
	children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
});

describe("blockText", () => {
	it("puts a link's address after its text", () => {
		expect(
			blockText({
				_type: "block",
				style: "normal",
				markDefs: [{ _key: "l1", _type: "link", href: "/articles/x" }],
				children: [
					{ _type: "span", text: "Read ", marks: [] },
					{ _type: "span", text: "our guide", marks: ["l1"] },
					{ _type: "span", text: ".", marks: [] },
				],
			}),
		).toBe("Read our guide [/articles/x].");
	});

	it("marks headings, list items, images and other blocks", () => {
		expect(blockText({ ...para("a", "Title"), style: "h2" })).toBe("## Title");
		expect(blockText({ ...para("a", "One"), listItem: "bullet" })).toBe("• One");
		expect(blockText({ ...para("a", "One"), listItem: "number" })).toBe("1. One");
		expect(blockText({ _type: "image", alt: "A horse", caption: "Photo: X" })).toBe(
			"[image: A horse | Photo: X]",
		);
		expect(blockText({ _type: "youtube", id: "abc" })).toBe("[youtube]");
	});
});

describe("isPortableText", () => {
	it("recognises an array of typed blocks and nothing else", () => {
		expect(isPortableText([para("a", "x")])).toBe(true);
		expect(isPortableText(["a", "b"])).toBe(false);
		expect(isPortableText("text")).toBe(false);
	});
});

describe("diffWords", () => {
	it("marks only the words that changed", () => {
		expect(diffWords("The race carries a place.", "The race carried a place.")).toEqual([
			["=", "The race "],
			["-", "carries"],
			["+", "carried"],
			["=", " a place."],
		]);
	});
});

describe("diffPortableText", () => {
	it("reports only the changed blocks, matched by text even when every key changed", () => {
		const before = [para("a1", "First."), para("a2", "Second, old."), para("a3", "Third.")];
		const after = [para("b1", "First."), para("b2", "Second, new."), para("b3", "Third.")];
		const result = diffPortableText(before, after);
		expect(result?.unchanged).toBe(2);
		expect(result?.changes).toEqual([
			{
				kind: "changed",
				segments: [
					["=", "Second, "],
					["-", "old."],
					["+", "new."],
				],
			},
		]);
	});

	it("lists added and removed blocks that have no counterpart", () => {
		const result = diffPortableText(
			[para("a", "Keep."), para("b", "Drop.")],
			[para("a", "Keep."), para("c", "New one."), { _type: "image", alt: "Barn" }],
		);
		expect(result?.changes).toEqual([
			{ kind: "removed", text: "Drop." },
			{ kind: "added", text: "New one." },
			{ kind: "added", text: "[image: Barn]" },
		]);
	});

	it("shows a rewritten block as old then new rather than interleaved words", () => {
		const result = diffPortableText(
			[para("a", "Same."), para("b", "The quick brown fox jumps over the lazy dog.")],
			[para("a", "Same."), para("c", "Totally different sentence about horses instead.")],
		);
		expect(result?.changes).toEqual([
			{ kind: "removed", text: "The quick brown fox jumps over the lazy dog." },
			{ kind: "added", text: "Totally different sentence about horses instead." },
		]);
	});

	it("finds no changes in identical bodies", () => {
		const body = [para("a", "Same."), para("b", "Also same.")];
		expect(diffPortableText(body, structuredClone(body))).toEqual({ changes: [], unchanged: 2 });
	});
});
