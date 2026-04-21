/**
 * Plugin Block Conversion Tests
 *
 * Tests the Portable Text ↔ ProseMirror conversion for plugin blocks (embeds).
 * Covers round-trip fidelity, data isolation, and edge cases that caused
 * bugs in the initial implementation.
 */

import { describe, it, expect } from "vitest";

import {
	_prosemirrorToPortableText as prosemirrorToPortableText,
	_portableTextToProsemirror as portableTextToProsemirror,
} from "../../src/components/PortableTextEditor";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a ProseMirror doc with the given content nodes */
function pmDoc(...content: unknown[]) {
	return { type: "doc", content };
}

/** Build a ProseMirror pluginBlock node */
function pmPluginBlock(blockType: string, id: string, data: Record<string, unknown> = {}) {
	return {
		type: "pluginBlock",
		attrs: { blockType, id, data },
	};
}

/** Build a Portable Text plugin block (unknown _type → embed) */
function ptPluginBlock(type: string, id: string, extra: Record<string, unknown> = {}) {
	return {
		_type: type,
		_key: "k1",
		id,
		...extra,
	};
}

// =============================================================================
// ProseMirror → Portable Text (convertPMNode pluginBlock case)
// =============================================================================

describe("PM → PT: plugin blocks", () => {
	it("converts a basic plugin block", () => {
		const doc = pmDoc(pmPluginBlock("youtube", "https://youtu.be/abc"));
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks).toHaveLength(1);
		expect(blocks[0]).toMatchObject({
			_type: "youtube",
			id: "https://youtu.be/abc",
		});
		expect(blocks[0]!._key).toBeTruthy();
	});

	it("spreads data fields into the PT block", () => {
		const doc = pmDoc(pmPluginBlock("chart", "chart-1", { color: "red", size: 42 }));
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks[0]).toMatchObject({
			_type: "chart",
			id: "chart-1",
			color: "red",
			size: 42,
		});
	});

	it("data fields cannot overwrite _type", () => {
		const doc = pmDoc(pmPluginBlock("youtube", "vid-1", { _type: "malicious" }));
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks[0]!._type).toBe("youtube");
	});

	it("data fields cannot overwrite _key", () => {
		const doc = pmDoc(pmPluginBlock("youtube", "vid-1", { _key: "evil" }));
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks[0]!._key).not.toBe("evil");
	});

	it("handles empty data gracefully", () => {
		const doc = pmDoc(pmPluginBlock("tweet", "https://twitter.com/x/status/1"));
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks[0]).toMatchObject({
			_type: "tweet",
			id: "https://twitter.com/x/status/1",
		});
	});

	it("falls back blockType to 'embed' when missing", () => {
		const doc = pmDoc({
			type: "pluginBlock",
			attrs: { blockType: null, id: "url", data: {} },
		});
		const blocks = prosemirrorToPortableText(doc);

		expect(blocks[0]!._type).toBe("embed");
	});
});

// =============================================================================
// Portable Text → ProseMirror (convertPTBlock default case)
// =============================================================================

describe("PT → PM: plugin blocks", () => {
	it("converts an unknown block type with id to pluginBlock", () => {
		const pm = portableTextToProsemirror([ptPluginBlock("youtube", "https://youtu.be/abc")]);
		const node = pm.content?.[0] as { type: string; attrs: Record<string, unknown> };

		expect(node.type).toBe("pluginBlock");
		expect(node.attrs.blockType).toBe("youtube");
		expect(node.attrs.id).toBe("https://youtu.be/abc");
	});

	it("stores extra fields as data", () => {
		const pm = portableTextToProsemirror([
			ptPluginBlock("chart", "chart-1", { color: "red", size: 42 }),
		]);
		const node = pm.content?.[0] as { type: string; attrs: { data: Record<string, unknown> } };

		expect(node.attrs.data).toEqual({ color: "red", size: 42 });
	});

	it("filters _-prefixed keys from data", () => {
		const pm = portableTextToProsemirror([
			ptPluginBlock("youtube", "vid-1", {
				_internal: "should-be-stripped",
				_foo: "also-stripped",
				caption: "keep-this",
			}),
		]);
		const node = pm.content?.[0] as { type: string; attrs: { data: Record<string, unknown> } };

		expect(node.attrs.data).toEqual({ caption: "keep-this" });
		expect(node.attrs.data).not.toHaveProperty("_internal");
		expect(node.attrs.data).not.toHaveProperty("_foo");
	});

	it("handles url field as fallback for id", () => {
		const block = { _type: "embed", _key: "k1", url: "https://example.com" };
		const pm = portableTextToProsemirror([block]);
		const node = pm.content?.[0] as { type: string; attrs: Record<string, unknown> };

		expect(node.type).toBe("pluginBlock");
		expect(node.attrs.id).toBe("https://example.com");
	});

	it("treats blocks without id, url, or data as unknown (paragraph fallback)", () => {
		const block = { _type: "mystery", _key: "k1" };
		const pm = portableTextToProsemirror([block]);
		const node = pm.content?.[0] as { type: string };

		expect(node.type).toBe("paragraph");
	});

	it("converts blocks with field data but no id/url to pluginBlock", () => {
		const block = { _type: "emdash-form", _key: "k1", formId: "abc-123" };
		const pm = portableTextToProsemirror([block]);
		const node = pm.content?.[0] as {
			type: string;
			attrs: { blockType: string; id: string; data: Record<string, unknown> };
		};

		expect(node.type).toBe("pluginBlock");
		expect(node.attrs.blockType).toBe("emdash-form");
		expect(node.attrs.id).toBe("");
		expect(node.attrs.data).toEqual({ formId: "abc-123" });
	});

	it("converts blocks with empty id and field data to pluginBlock", () => {
		const block = { _type: "emdash-form", _key: "k1", id: "", formId: "abc-123" };
		const pm = portableTextToProsemirror([block]);
		const node = pm.content?.[0] as {
			type: string;
			attrs: { blockType: string; id: string; data: Record<string, unknown> };
		};

		expect(node.type).toBe("pluginBlock");
		expect(node.attrs.blockType).toBe("emdash-form");
		expect(node.attrs.id).toBe("");
		expect(node.attrs.data).toEqual({ formId: "abc-123" });
	});
});

// =============================================================================
// Round-trip: PT → PM → PT
// =============================================================================

describe("Plugin block round-trip", () => {
	it("basic plugin block survives round-trip", () => {
		const original = [ptPluginBlock("youtube", "https://youtu.be/abc")];
		const pm = portableTextToProsemirror(original);
		const roundTripped = prosemirrorToPortableText(pm);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]).toMatchObject({
			_type: "youtube",
			id: "https://youtu.be/abc",
		});
	});

	it("plugin block with data survives round-trip", () => {
		const original = [ptPluginBlock("chart", "chart-1", { color: "red", size: 42 })];
		const pm = portableTextToProsemirror(original);
		const roundTripped = prosemirrorToPortableText(pm);

		expect(roundTripped[0]).toMatchObject({
			_type: "chart",
			id: "chart-1",
			color: "red",
			size: 42,
		});
	});

	it("_-prefixed keys do not accumulate across round-trips", () => {
		// Simulate a block that somehow has _-prefixed keys in data
		const withLeakyKeys = [
			ptPluginBlock("youtube", "vid-1", {
				_createdAt: "2024-01-01",
				caption: "test",
			}),
		];

		// First round-trip should strip _-prefixed keys
		const pm1 = portableTextToProsemirror(withLeakyKeys);
		const rt1 = prosemirrorToPortableText(pm1);

		expect(rt1[0]).toMatchObject({ _type: "youtube", id: "vid-1", caption: "test" });
		expect(rt1[0]).not.toHaveProperty("_createdAt");

		// Second round-trip should be stable
		const pm2 = portableTextToProsemirror(rt1);
		const rt2 = prosemirrorToPortableText(pm2);

		expect(rt2[0]).toMatchObject({ _type: "youtube", id: "vid-1", caption: "test" });
		expect(Object.keys(rt2[0]!).filter((k) => k.startsWith("_"))).toEqual(["_type", "_key"]);
	});

	it("field-data block (no id) survives round-trip", () => {
		const original = [{ _type: "emdash-form", _key: "k1", formId: "abc-123" }];
		const pm = portableTextToProsemirror(original);
		const roundTripped = prosemirrorToPortableText(pm);

		expect(roundTripped).toHaveLength(1);
		expect(roundTripped[0]).toMatchObject({
			_type: "emdash-form",
			id: "",
			formId: "abc-123",
		});
	});

	it("data with _type/_key fields cannot overwrite block identity after round-trip", () => {
		// Start from PM where data contains _type/_key as data fields
		const doc = pmDoc(
			pmPluginBlock("youtube", "vid-1", { _type: "evil", _key: "evil", caption: "test" }),
		);

		// PM → PT: fix 5 ensures _type/_key are set after data spread
		const pt = prosemirrorToPortableText(doc);
		expect(pt[0]!._type).toBe("youtube");
		expect(pt[0]!._key).not.toBe("evil");

		// PT → PM → PT: fix 6 strips _-prefixed keys, so they don't persist
		const pm2 = portableTextToProsemirror(pt);
		const rt = prosemirrorToPortableText(pm2);
		expect(rt[0]!._type).toBe("youtube");
		expect(rt[0]).toMatchObject({ caption: "test" });
	});
});
