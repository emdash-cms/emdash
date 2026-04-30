/**
 * Unit tests for the seed-time Portable Text key normalizer.
 *
 * The integration coverage in
 * `tests/integration/seed-portable-text-keys.test.ts` exercises the
 * full seed -> DB -> validator round-trip. These unit tests cover the
 * pure-function edge cases without needing a database.
 */

import { describe, expect, it } from "vitest";

import { normalizePortableTextKeys } from "../../../src/seed/normalize-portable-text.js";

describe("normalizePortableTextKeys", () => {
	it("returns primitives, null, and undefined unchanged", () => {
		expect(normalizePortableTextKeys("hello" as unknown)).toBe("hello");
		expect(normalizePortableTextKeys(42 as unknown)).toBe(42);
		expect(normalizePortableTextKeys(true as unknown)).toBe(true);
		expect(normalizePortableTextKeys(null as unknown)).toBe(null);
		expect(normalizePortableTextKeys(undefined as unknown)).toBe(undefined);
	});

	it("does not mutate the input", () => {
		const input = {
			content: [{ _type: "block", children: [{ _type: "span", text: "hi" }] }],
		};
		const before = JSON.stringify(input);
		normalizePortableTextKeys(input);
		expect(JSON.stringify(input)).toBe(before);
	});

	it("injects _key on objects with a string _type", () => {
		const out = normalizePortableTextKeys({
			_type: "block",
			style: "normal",
		}) as Record<string, unknown>;
		expect(typeof out._key).toBe("string");
		expect((out._key as string).length).toBeGreaterThan(0);
	});

	it("recurses into arrays and nested objects", () => {
		const out = normalizePortableTextKeys([
			{
				_type: "block",
				children: [{ _type: "span", text: "a" }],
				markDefs: [{ _type: "link", href: "https://example.com" }],
			},
		]) as Array<Record<string, unknown>>;
		expect(typeof out[0]!._key).toBe("string");
		expect(typeof (out[0]!.children as Array<Record<string, unknown>>)[0]!._key).toBe("string");
		expect(typeof (out[0]!.markDefs as Array<Record<string, unknown>>)[0]!._key).toBe("string");
	});

	it("preserves existing _key values", () => {
		const out = normalizePortableTextKeys({
			_type: "block",
			_key: "explicit",
		}) as Record<string, unknown>;
		expect(out._key).toBe("explicit");
	});

	it("replaces empty-string _key (Zod still rejects '')", () => {
		const out = normalizePortableTextKeys({
			_type: "block",
			_key: "",
		}) as Record<string, unknown>;
		expect(out._key).not.toBe("");
		expect((out._key as string).length).toBeGreaterThan(0);
	});

	it("does not touch objects without a string _type", () => {
		const out = normalizePortableTextKeys({
			notATypedNode: { foo: "bar" },
			alsoNotPT: { _type: 123 }, // numeric _type is not PT
		}) as Record<string, unknown>;
		expect((out.notATypedNode as Record<string, unknown>)._key).toBeUndefined();
		expect((out.alsoNotPT as Record<string, unknown>)._key).toBeUndefined();
	});

	it("avoids generating a key that collides with an explicit key", () => {
		// `k0` is the first value the deterministic counter would produce.
		// The second block must not get assigned `k0` -- we reserve it.
		const out = normalizePortableTextKeys([
			{ _type: "block" }, // no key -> needs generation
			{ _type: "block", _key: "k0" }, // explicit key collides with first generation
		]) as Array<Record<string, unknown>>;

		expect(out[1]!._key).toBe("k0"); // explicit preserved
		expect(out[0]!._key).not.toBe("k0"); // generated value avoided collision
		expect(typeof out[0]!._key).toBe("string");
	});

	it("produces unique keys across the whole document", () => {
		const blocks: Array<Record<string, unknown>> = [];
		for (let i = 0; i < 50; i++) blocks.push({ _type: "block" });
		const out = normalizePortableTextKeys(blocks) as Array<Record<string, unknown>>;
		const keys = out.map((b) => b._key as string);
		expect(new Set(keys).size).toBe(50);
	});
});
