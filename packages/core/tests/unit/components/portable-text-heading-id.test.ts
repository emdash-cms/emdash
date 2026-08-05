import { describe, expect, it } from "vitest";

import {
	allocateHeadingId,
	assignHeadingIds,
	headingPlainText,
	isSafeHtmlId,
} from "../../../src/components/portable-text-heading-id.js";

function span(text: string) {
	return { _type: "span" as const, _key: "s", text, marks: [] as string[] };
}

function heading(text: string, opts: { key?: string; id?: string; style?: string } = {}) {
	return {
		_type: "block" as const,
		_key: opts.key ?? "k1",
		style: opts.style ?? "h2",
		...(opts.id ? { id: opts.id } : {}),
		children: [span(text)],
	};
}

describe("headingPlainText", () => {
	it("joins span text", () => {
		expect(headingPlainText([span("Hello "), span("World")])).toBe("Hello World");
	});

	it("walks nested mark-tree children", () => {
		expect(
			headingPlainText([
				{
					_type: "span",
					markType: "strong",
					children: [{ _type: "span", text: "Bold" }],
				},
				{ _type: "span", text: " plain" },
			]),
		).toBe("Bold plain");
	});

	it("returns empty for non-arrays", () => {
		expect(headingPlainText(undefined)).toBe("");
		expect(headingPlainText(null)).toBe("");
	});
});

describe("isSafeHtmlId", () => {
	it("accepts typical slugs and keys", () => {
		expect(isSafeHtmlId("this-is-a-new-heading")).toBe(true);
		expect(isSafeHtmlId("block_abc123")).toBe(true);
		expect(isSafeHtmlId("_private")).toBe(true);
	});

	it("rejects empty, spaces, and injection-shaped values", () => {
		expect(isSafeHtmlId("")).toBe(false);
		expect(isSafeHtmlId("has space")).toBe(false);
		expect(isSafeHtmlId("1starts-with-digit")).toBe(false);
		expect(isSafeHtmlId('x" onload="alert(1)')).toBe(false);
		expect(isSafeHtmlId("a".repeat(129))).toBe(false);
	});
});

describe("allocateHeadingId", () => {
	it("slugs heading text", () => {
		const used = new Set<string>();
		const result = allocateHeadingId({
			style: "h2",
			children: [span("This is a new heading")],
			blockKey: "blk1",
			usedIds: used,
		});
		expect(result).toEqual({
			id: "this-is-a-new-heading",
			extraIds: ["blk1"],
		});
		expect(used.has("this-is-a-new-heading")).toBe(true);
		expect(used.has("blk1")).toBe(true);
	});

	it("keeps an existing id as an extra target alongside the text slug", () => {
		const used = new Set<string>();
		const result = allocateHeadingId({
			style: "h1",
			children: [span("Introduction")],
			blockKey: "k9",
			existingId: "custom-anchor",
			usedIds: used,
		});
		expect(result?.id).toBe("introduction");
		expect(result?.extraIds).toEqual(["custom-anchor", "k9"]);
	});

	it("disambiguates duplicate slugs within a document", () => {
		const used = new Set<string>();
		const first = allocateHeadingId({
			style: "h2",
			children: [span("Overview")],
			blockKey: "a",
			usedIds: used,
		});
		const second = allocateHeadingId({
			style: "h2",
			children: [span("Overview")],
			blockKey: "b",
			usedIds: used,
		});
		expect(first?.id).toBe("overview");
		expect(second?.id).toBe("overview-2");
	});

	it("does not emit heading ids for non-heading styles", () => {
		expect(
			allocateHeadingId({
				style: "normal",
				children: [span("Not a heading")],
				usedIds: new Set(),
			}),
		).toBeUndefined();
	});

	it("falls back when text slugifies to empty", () => {
		const result = allocateHeadingId({
			style: "h3",
			children: [span("!!!")],
			blockKey: "empty-text-key",
			usedIds: new Set(),
		});
		expect(result).toEqual({ id: "empty-text-key", extraIds: [] });
	});

	it("ignores unsafe existing ids and keys", () => {
		const result = allocateHeadingId({
			style: "h2",
			children: [span("Safe Title")],
			blockKey: "bad key",
			existingId: 'x" onclick="evil',
			usedIds: new Set(),
		});
		expect(result).toEqual({ id: "safe-title", extraIds: [] });
	});

	it("prefixes digit-leading slugs so the id stays isSafeHtmlId", () => {
		const used = new Set<string>();
		const result = allocateHeadingId({
			style: "h2",
			children: [span("1st Post")],
			blockKey: "k1",
			usedIds: used,
		});
		expect(result?.id).toBe("h-1st-post");
		expect(isSafeHtmlId(result!.id)).toBe(true);
		expect(result?.extraIds).toEqual(["k1"]);
	});
});

describe("assignHeadingIds", () => {
	it("stamps headings without mutating the input array", () => {
		const input = [
			heading("First Section", { key: "k1" }),
			{
				_type: "block" as const,
				_key: "p1",
				style: "normal",
				children: [span("body")],
			},
			heading("First Section", { key: "k2" }),
		];
		const frozen = structuredClone(input);
		const out = assignHeadingIds(input);

		expect(input).toEqual(frozen);
		expect(out).not.toBe(input);

		const h1 = out[0] as { id?: string; _headingExtraIds?: string[] };
		const p = out[1] as { id?: string };
		const h2 = out[2] as { id?: string; _headingExtraIds?: string[] };

		expect(h1.id).toBe("first-section");
		expect(h1._headingExtraIds).toEqual(["k1"]);
		expect(p.id).toBeUndefined();
		expect(h2.id).toBe("first-section-2");
		expect(h2._headingExtraIds).toEqual(["k2"]);
	});

	it("preserves an existing id in addition to the text slug", () => {
		const out = assignHeadingIds([heading("Renamed Later", { key: "stable", id: "old-name" })]);
		const h = out[0] as { id?: string; _headingExtraIds?: string[] };
		expect(h.id).toBe("renamed-later");
		expect(h._headingExtraIds).toEqual(["old-name", "stable"]);
	});

	it("returns non-arrays unchanged", () => {
		const single = heading("Alone");
		expect(assignHeadingIds(single)).toBe(single);
	});

	it("keeps digit-leading heading slugs unique across a document", () => {
		const out = assignHeadingIds([
			heading("1st Post", { key: "a" }),
			heading("1st Post", { key: "b" }),
		]);
		const h1 = out[0] as { id?: string; _headingExtraIds?: string[] };
		const h2 = out[1] as { id?: string; _headingExtraIds?: string[] };
		expect(h1.id).toBe("h-1st-post");
		expect(h2.id).toBe("h-1st-post-2");
		expect(isSafeHtmlId(h1.id!)).toBe(true);
		expect(isSafeHtmlId(h2.id!)).toBe(true);
		expect(h1._headingExtraIds).toEqual(["a"]);
		expect(h2._headingExtraIds).toEqual(["b"]);
	});
});
