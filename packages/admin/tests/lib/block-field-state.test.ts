import { describe, expect, it } from "vitest";

import type { BlockType } from "../../src/lib/api/schema.js";
import {
	createBlockValue,
	duplicateBlockValue,
	moveBlockValue,
	updateBlockFieldValue,
} from "../../src/lib/block-field-state.js";

const type: BlockType = {
	id: "type-1",
	slug: "hero",
	label: "Hero",
	currentVersion: 2,
	source: "user",
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	versions: [
		{
			id: "version-1",
			blockTypeId: "type-1",
			version: 1,
			fields: [],
			fingerprint: "one",
			active: false,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
		{
			id: "version-2",
			blockTypeId: "type-1",
			version: 2,
			fields: [{ slug: "heading", label: "Heading", type: "string", defaultValue: "Hello" }],
			fingerprint: "two",
			active: true,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		},
	],
};

describe("block field state", () => {
	it("creates new blocks at the active version with immediate identity", () => {
		expect(createBlockValue(type, "new-key")).toEqual({
			_type: "hero",
			_version: 2,
			_key: "new-key",
			heading: "Hello",
		});
	});

	it("duplicates content while preserving type and version and replacing only the key", () => {
		const original = { _type: "hero", _version: 1, _key: "old-key", nested: { value: 1 } };
		const duplicate = duplicateBlockValue(original, "new-key");

		expect(duplicate).toEqual({ ...original, _key: "new-key" });
		expect(duplicate.nested).not.toBe(original.nested);
	});

	it("uses the same identity-preserving move for pointer and keyboard reorder", () => {
		const blocks = [
			{ _type: "hero", _version: 1, _key: "one" },
			{ _type: "hero", _version: 2, _key: "two" },
			{ _type: "hero", _version: 1, _key: "three" },
		];

		expect(moveBlockValue(blocks, 0, 2)).toEqual([blocks[1], blocks[2], blocks[0]]);
		expect(moveBlockValue(blocks, 0, 2).map(({ _key, _version }) => [_key, _version])).toEqual([
			["two", 2],
			["three", 1],
			["one", 1],
		]);
	});

	it("updates a nested field without changing block identity or order", () => {
		const blocks = [
			{ _type: "hero", _version: 1, _key: "one", heading: "Before" },
			{ _type: "hero", _version: 2, _key: "two", heading: "Other" },
		];
		const next = updateBlockFieldValue(blocks, "one", "heading", "After");

		expect(next).toEqual([
			{ _type: "hero", _version: 1, _key: "one", heading: "After" },
			blocks[1],
		]);
	});
});
