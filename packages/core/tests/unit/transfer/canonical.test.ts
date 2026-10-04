import { describe, expect, it } from "vitest";

import {
	canonicalJson,
	CanonicalJsonError,
	measureJsonDepth,
	parseCanonicalJson,
} from "../../../src/transfer/format/canonical.js";

function nest(depth: number): unknown {
	let value: unknown = 1;
	for (let i = 0; i < depth; i++) value = [value];
	return value;
}

describe("canonicalJson", () => {
	it("sorts keys by UTF-16 code unit, not code point or locale", () => {
		const value = { "￿": 1, "\u{1F600}": 2, b: 3, B: 4, a: 5, é: 6, "": 7 };
		// "\u{1F600}" is the surrogate pair D83D DE00, which sorts below U+FFFF by
		// code unit even though its code point is larger.
		expect(canonicalJson(value)).toBe('{"":7,"B":4,"a":5,"b":3,"é":6,"😀":2,"￿":1}');
	});

	it("sorts nested objects and keeps array order", () => {
		expect(canonicalJson({ z: [{ b: 1, a: 2 }, 3], a: { d: null, c: true } })).toBe(
			'{"a":{"c":true,"d":null},"z":[{"a":2,"b":1},3]}',
		);
	});

	it("encodes strings and numbers exactly like JSON.stringify", () => {
		const value = {
			s: 'quote " back \\ nl \n tab \t ctrl \u0001 lone \uD800',
			n: [1e21, 0.1, -0, 5e-7],
		};
		expect(canonicalJson(value)).toBe(
			`{"n":${JSON.stringify(value.n)},"s":${JSON.stringify(value.s)}}`,
		);
	});

	it("omits undefined properties", () => {
		expect(canonicalJson({ a: undefined, b: 1 })).toBe('{"b":1}');
	});

	it("rejects undefined array items, non-finite numbers, and non-JSON values", () => {
		expect(() => canonicalJson([1, undefined])).toThrow(CanonicalJsonError);
		expect(() => canonicalJson({ a: Number.NaN })).toThrow(CanonicalJsonError);
		expect(() => canonicalJson({ a: Number.POSITIVE_INFINITY })).toThrow(CanonicalJsonError);
		expect(() => canonicalJson({ a: 1n })).toThrow(CanonicalJsonError);
		expect(() => canonicalJson({ a: () => 1 })).toThrow(CanonicalJsonError);
		expect(() => canonicalJson({ a: new Date(0) })).toThrow(CanonicalJsonError);
		expect(() => canonicalJson(new Map())).toThrow(CanonicalJsonError);
	});

	it("reports where a value was rejected", () => {
		expect(() => canonicalJson({ a: { b: [0, Number.NaN] } })).toThrow("$.a.b[1]");
	});

	it("accepts 64 levels of nesting and rejects 65", () => {
		expect(() => canonicalJson(nest(64))).not.toThrow();
		expect(() => canonicalJson(nest(65))).toThrow(/Nesting deeper than 64/);
	});

	it("rejects cyclic structures through the depth limit", () => {
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		expect(() => canonicalJson(cyclic)).toThrow(CanonicalJsonError);
	});
});

describe("measureJsonDepth", () => {
	it("counts container nesting and ignores brackets inside strings", () => {
		expect(measureJsonDepth('{"a":[1,{"b":"[[[{{{"}]}')).toBe(3);
		expect(measureJsonDepth('"\\"["')).toBe(0);
	});

	it("stops at the limit", () => {
		expect(measureJsonDepth("[".repeat(100_000), 64)).toBe(Number.POSITIVE_INFINITY);
	});
});

describe("parseCanonicalJson", () => {
	it("round-trips canonical text", () => {
		const text = canonicalJson({ b: [1, "x"], a: { c: null } });
		expect(parseCanonicalJson(text)).toEqual({ a: { c: null }, b: [1, "x"] });
	});

	it("rejects whitespace, unsorted keys, duplicate keys, and invalid JSON", () => {
		expect(() => parseCanonicalJson('{"a": 1}')).toThrow(CanonicalJsonError);
		expect(() => parseCanonicalJson('{"b":1,"a":2}')).toThrow(CanonicalJsonError);
		expect(() => parseCanonicalJson('{"a":1,"a":2}')).toThrow(CanonicalJsonError);
		expect(() => parseCanonicalJson("{")).toThrow(CanonicalJsonError);
		expect(() => parseCanonicalJson("1.0")).toThrow(CanonicalJsonError);
	});

	it("never quotes the rejected text", () => {
		for (const text of ['{"a":"SENTINEL_d41c', "SENTINEL_d41c", '{"SENTINEL_d41c":1,}']) {
			let caught: unknown;
			try {
				parseCanonicalJson(text);
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(CanonicalJsonError);
			expect((caught as Error).message).not.toContain("SENTINEL");
		}
	});

	it("rejects over-deep documents before parsing them", () => {
		expect(() => parseCanonicalJson(`${"[".repeat(200_000)}${"]".repeat(200_000)}`)).toThrow(
			/Nesting deeper than 64/,
		);
	});
});
