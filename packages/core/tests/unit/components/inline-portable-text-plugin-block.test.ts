/**
 * Inline editor plugin-block round-trip tests.
 *
 * Regression tests for the bug where the visual-editing inline editor
 * coerced unknown Portable Text block types (e.g. `marketing.hero`) into
 * `pluginBlock` ProseMirror nodes that only carried `{ blockType, id }`,
 * silently dropping every other field. On save, `pmToPortableText` then
 * serialised the block back as `{ _type, _key, id }`, persisting the data
 * loss.
 *
 * The fix preserves all non-well-known fields on a `data` attribute and
 * spreads them back out during the PM → PT direction. See
 * `InlinePortableTextEditor.tsx` `case "pluginBlock"` and the unknown-block
 * fallback in `convertPTBlock`.
 */

import { describe, it, expect } from "vitest";

import {
	_pmToPortableText as pmToPortableText,
	_portableTextToPM as portableTextToPM,
} from "../../../src/components/InlinePortableTextEditor.js";

function pmDoc(...content: unknown[]) {
	return { type: "doc", content };
}

describe("inline editor: PT → PM (unknown blocks)", () => {
	it("captures every non-well-known field into data", () => {
		const block = {
			_type: "marketing.hero",
			_key: "hero",
			headline: "Build products people want",
			subheadline: "The all-in-one platform",
			primaryCtaLabel: "Sign up",
			primaryCtaUrl: "/signup",
			centered: true,
		};

		const pm = portableTextToPM([block]);
		const node = pm.content?.[0] as {
			type: string;
			attrs: { blockType: string; id: string; data: Record<string, unknown> };
		};

		expect(node.type).toBe("pluginBlock");
		expect(node.attrs.blockType).toBe("marketing.hero");
		expect(node.attrs.id).toBe("");
		expect(node.attrs.data).toEqual({
			headline: "Build products people want",
			subheadline: "The all-in-one platform",
			primaryCtaLabel: "Sign up",
			primaryCtaUrl: "/signup",
			centered: true,
		});
	});

	it("strips _-prefixed keys from data to prevent accumulation", () => {
		const block = {
			_type: "embed",
			_key: "k1",
			_internal: "should-strip",
			caption: "should-keep",
		};

		const pm = portableTextToPM([block]);
		const node = pm.content?.[0] as { attrs: { data: Record<string, unknown> } };

		expect(node.attrs.data).toEqual({ caption: "should-keep" });
		expect(node.attrs.data).not.toHaveProperty("_internal");
	});

	it("uses url as a fallback for id", () => {
		const block = { _type: "youtube", _key: "k1", url: "https://youtu.be/abc" };

		const pm = portableTextToPM([block]);
		const node = pm.content?.[0] as { attrs: { id: string } };

		expect(node.attrs.id).toBe("https://youtu.be/abc");
	});
});

describe("inline editor: PM → PT (pluginBlock)", () => {
	it("spreads data fields back into the PT block", () => {
		const doc = pmDoc({
			type: "pluginBlock",
			attrs: {
				blockType: "marketing.hero",
				id: "",
				data: { headline: "Hi", centered: true },
			},
		});

		const blocks = pmToPortableText(doc);

		expect(blocks[0]).toMatchObject({
			_type: "marketing.hero",
			id: "",
			headline: "Hi",
			centered: true,
		});
	});

	it("data fields cannot overwrite _type or _key", () => {
		const doc = pmDoc({
			type: "pluginBlock",
			attrs: {
				blockType: "marketing.hero",
				id: "",
				data: { _type: "evil", _key: "evil", headline: "kept" },
			},
		});

		const blocks = pmToPortableText(doc);

		expect(blocks[0]!._type).toBe("marketing.hero");
		expect(blocks[0]!._key).not.toBe("evil");
		expect(blocks[0]).toMatchObject({ headline: "kept" });
	});

	it("falls back blockType to 'embed' when missing", () => {
		const doc = pmDoc({
			type: "pluginBlock",
			attrs: { blockType: null, id: "u", data: {} },
		});

		const blocks = pmToPortableText(doc);

		expect(blocks[0]!._type).toBe("embed");
	});

	it("handles non-object data gracefully", () => {
		// Defensive: data could be malformed if persisted from a buggy source.
		const doc = pmDoc({
			type: "pluginBlock",
			attrs: { blockType: "embed", id: "u", data: null },
		});

		const blocks = pmToPortableText(doc);

		expect(blocks[0]).toMatchObject({ _type: "embed", id: "u" });
	});
});

describe("inline editor: round-trip preserves plugin block payloads", () => {
	it("a marketing.hero-shaped block survives PT → PM → PT intact", () => {
		const original = {
			_type: "marketing.hero",
			_key: "hero",
			headline: "Build products people want",
			subheadline: "The all-in-one platform",
			primaryCtaLabel: "Sign up",
			primaryCtaUrl: "/signup",
			secondaryCtaLabel: "Watch demo",
			secondaryCtaUrl: "/demo",
			centered: true,
		};

		const pm = portableTextToPM([original]);
		const roundTripped = pmToPortableText(pm);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]).toMatchObject({
			_type: "marketing.hero",
			headline: "Build products people want",
			subheadline: "The all-in-one platform",
			primaryCtaLabel: "Sign up",
			primaryCtaUrl: "/signup",
			secondaryCtaLabel: "Watch demo",
			secondaryCtaUrl: "/demo",
			centered: true,
		});
	});

	it("nested objects in unknown fields survive round-trip", () => {
		const original = {
			_type: "marketing.hero",
			_key: "hero",
			primaryCta: { label: "Sign up", url: "/signup" },
			image: { url: "/hero.png", alt: "Hero" },
		};

		const pm = portableTextToPM([original]);
		const roundTripped = pmToPortableText(pm);

		expect(roundTripped[0]).toMatchObject({
			_type: "marketing.hero",
			primaryCta: { label: "Sign up", url: "/signup" },
			image: { url: "/hero.png", alt: "Hero" },
		});
	});

	it("repeated round-trips are stable (no _-key leakage)", () => {
		const original = {
			_type: "marketing.faq",
			_key: "faq",
			items: [{ question: "Q?", answer: "A." }],
		};

		const rt1 = pmToPortableText(portableTextToPM([original]));
		const rt2 = pmToPortableText(portableTextToPM(rt1));

		expect(rt2[0]).toMatchObject({
			_type: "marketing.faq",
			items: [{ question: "Q?", answer: "A." }],
		});
		expect(Object.keys(rt2[0]!).filter((k) => k.startsWith("_"))).toEqual(["_type", "_key"]);
	});
});
