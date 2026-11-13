import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { hashValue } from "../../../src/rooms/hash.js";
import { CanonicalJsonError } from "../../../src/transfer/format/canonical.js";

function sha256Hex(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

function nested(depth: number): unknown {
	let value: unknown = "leaf";
	for (let level = 0; level < depth; level++) value = [value];
	return value;
}

describe("hashValue", () => {
	it("ignores key order at every level", () => {
		expect(hashValue({ a: 1, b: { c: [1, { e: 2, d: 3 }], f: null } })).toBe(
			hashValue({ b: { f: null, c: [1, { d: 3, e: 2 }] }, a: 1 }),
		);
	});

	it("hashes the RFC 8785 serialization of numbers", () => {
		const value = {
			numbers: [
				Number("333333333.33333329"),
				1e30,
				4.5,
				2e-3,
				0.000000000000000000000000001,
				-0,
				1e21,
			],
			literals: [null, true, false],
		};

		expect(hashValue(value)).toBe(
			sha256Hex(
				'{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27,0,1e+21]}',
			),
		);
	});

	it("sorts keys by UTF-16 code units, as RFC 8785 does", () => {
		const value = {
			"€": "Euro Sign",
			"\r": "Carriage Return",
			דּ: "Hebrew Letter Dalet With Dagesh",
			"1": "One",
			"😀": "Emoji: Grinning Face",
			"\u0080": "Control",
			ö: "Latin Small Letter O With Diaeresis",
		};
		const order = ["\r", "1", "\u0080", "ö", "€", "😀", "דּ"] as const;
		const canonical = `{${order.map((key) => `${JSON.stringify(key)}:${JSON.stringify(value[key])}`).join(",")}}`;

		expect(hashValue(value)).toBe(sha256Hex(canonical));
	});

	it("tells values of different types apart", () => {
		expect(hashValue("1")).not.toBe(hashValue(1));
		expect(hashValue([])).not.toBe(hashValue({}));
		expect(hashValue(null)).not.toBe(hashValue("null"));
	});

	it("hashes undefined as null", () => {
		expect(hashValue(undefined)).toBe(hashValue(null));
		expect(hashValue(undefined)).toBe(sha256Hex("null"));
	});

	it("hashes nesting up to 1,000 levels and refuses deeper", () => {
		expect(hashValue(nested(1000))).toMatch(/^[0-9a-f]{64}$/);
		expect(() => hashValue(nested(1001))).toThrow(CanonicalJsonError);
	});
});
