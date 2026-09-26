import { describe, expect, it } from "vitest";

import { TransferError } from "../../../src/transfer/errors.js";
import { decodeColumn, encodeColumn } from "../../../src/transfer/format/column-codec.js";
import type { ColumnCodec } from "../../../src/transfer/format/columns.js";

const DIALECTS = ["sqlite", "postgres"] as const;

describe("decodeColumn", () => {
	it("maps NULL to an absent value for every codec", () => {
		for (const codec of ["text", "integer", "real", "boolean", "json", "nativeJson"] as const) {
			expect(decodeColumn("sqlite", codec, null)).toBeUndefined();
			expect(decodeColumn("postgres", codec, undefined)).toBeUndefined();
		}
	});

	it("decodes booleans, bigints, and non-numeric integer text", () => {
		expect(decodeColumn("sqlite", "boolean", 0)).toBe(false);
		expect(decodeColumn("postgres", "boolean", 1)).toBe(true);
		expect(decodeColumn("postgres", "integer", "3000000000")).toBe(3_000_000_000);
		expect(decodeColumn("postgres", "integer", "90071992547409930")).toBe("90071992547409930");
		expect(decodeColumn("sqlite", "integer", "not a number")).toBe("not a number");
		expect(decodeColumn("sqlite", "json", "not json")).toBe("not json");
		expect(decodeColumn("sqlite", "nativeJson", 5)).toBe(5);
	});

	it("does not re-parse native JSON on Postgres", () => {
		expect(decodeColumn("postgres", "nativeJson", "123")).toBe("123");
		expect(decodeColumn("sqlite", "nativeJson", '"123"')).toBe("123");
	});
});

describe("encodeColumn", () => {
	it("inverts decodeColumn for every decoded value on both dialects", () => {
		const cases: Array<[ColumnCodec, unknown[]]> = [
			["text", ["", "hello", "{}"]],
			["integer", [0, -5, 3_000_000_000]],
			["real", [0.5, -1e-9]],
			["boolean", [true, false]],
			["json", ["plain", "123", '"quoted"', 7, true, null, { a: [1] }, []]],
			["nativeJson", ["plain", "123", 7, 2.5, false, { a: [1] }, []]],
		];
		for (const dialect of DIALECTS) {
			for (const [codec, values] of cases) {
				for (const value of values) {
					const stored = encodeColumn(dialect, codec, value);
					const raw =
						dialect === "postgres" && codec === "nativeJson" ? JSON.parse(String(stored)) : stored;
					const expected = value === null ? undefined : value;
					expect(
						decodeColumn(dialect, codec, raw),
						`${dialect} ${codec} ${JSON.stringify(value)}`,
					).toEqual(expected);
				}
			}
		}
	});

	it("stores strings in JSON columns as JSON text, including raw text that is not JSON", () => {
		for (const dialect of DIALECTS) {
			for (const codec of ["json", "nativeJson"] as const) {
				expect(decodeColumn(dialect, codec, "Golden Site")).toBe("Golden Site");
				expect(decodeColumn(dialect, "json", '"Golden Site"')).toBe("Golden Site");
				expect(encodeColumn(dialect, codec, "Golden Site")).toBe('"Golden Site"');
			}
		}
	});

	it("rejects values a column cannot hold", () => {
		const bad: Array<[ColumnCodec, unknown]> = [
			["text", 5],
			["boolean", 1],
			["integer", 1.5],
			["real", Number.NaN],
		];
		for (const [codec, value] of bad) {
			expect(() => encodeColumn("sqlite", codec, value)).toThrow(TransferError);
		}
		expect(() => encodeColumn("postgres", "integer", "abc")).toThrow(TransferError);
		expect(encodeColumn("sqlite", "integer", "abc")).toBe("abc");
	});
});
