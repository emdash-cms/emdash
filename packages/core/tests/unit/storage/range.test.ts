import { describe, expect, it } from "vitest";

import { parseRangeHeader, resolveByteRange } from "../../../src/storage/range.js";

describe("parseRangeHeader", () => {
	it.each([
		["bytes=0-499", { offset: 0, length: 500 }],
		["bytes=500-", { offset: 500 }],
		["bytes=-500", { suffix: 500 }],
		["bytes=-0", { suffix: 0 }],
		["Bytes=4-4", { offset: 4, length: 1 }],
		["bytes=0-1, ", { offset: 0, length: 2 }],
	])("parses %s", (header, range) => {
		expect(parseRangeHeader(header)).toEqual(range);
	});

	it.each([
		["no header", null],
		["several ranges", "bytes=0-1,4-5"],
		["a reversed range", "bytes=5-2"],
		["an empty range", "bytes=-"],
		["another unit", "items=0-1"],
		["a missing unit", "0-1"],
		["non-digits", "bytes=0x10-"],
		["an extra dash", "bytes=1-2-3"],
		["a position past the safe integer range", "bytes=99999999999999999999-"],
	])("ignores %s", (_label, header) => {
		expect(parseRangeHeader(header)).toBeNull();
	});
});

describe("resolveByteRange", () => {
	it.each([
		[
			{ offset: 2, length: 3 },
			{ offset: 2, length: 3 },
		],
		[{ offset: 7 }, { offset: 7, length: 3 }],
		[
			{ offset: 8, length: 100 },
			{ offset: 8, length: 2 },
		],
		[{ suffix: 3 }, { offset: 7, length: 3 }],
		[{ suffix: 100 }, { offset: 0, length: 10 }],
	])("resolves %o against 10 bytes", (range, resolved) => {
		expect(resolveByteRange(range, 10)).toEqual(resolved);
	});

	it.each([
		[{ offset: 10 }, 10],
		[{ suffix: 0 }, 10],
		[{ offset: 0 }, 0],
	])("rejects %o against %i bytes", (range, size) => {
		expect(resolveByteRange(range, size)).toBeNull();
	});
});
