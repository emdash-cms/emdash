import { describe, expect, it } from "vitest";

import { chunks, SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";

describe("chunks", () => {
	it("returns empty array for empty input", () => {
		expect(chunks([], 10)).toEqual([]);
	});

	it("returns single chunk when array fits within size", () => {
		expect(chunks([1, 2, 3], 5)).toEqual([[1, 2, 3]]);
	});

	it("splits array into even chunks", () => {
		expect(chunks([1, 2, 3, 4], 2)).toEqual([
			[1, 2],
			[3, 4],
		]);
	});

	it("handles remainder in last chunk", () => {
		expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
	});

	it("handles chunk size of 1", () => {
		expect(chunks([1, 2, 3], 1)).toEqual([[1], [2], [3]]);
	});

	it("handles array exactly equal to chunk size", () => {
		expect(chunks([1, 2, 3], 3)).toEqual([[1, 2, 3]]);
	});
});

describe("SQL_BATCH_SIZE", () => {
	it("is 50", () => {
		expect(SQL_BATCH_SIZE).toBe(50);
	});
});
