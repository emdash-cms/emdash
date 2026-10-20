import { describe, expect, it } from "vitest";

import { indexTotals } from "../src/ingestion.js";

const none = { listedItems: 0, uploadFailures: [], droppedFailures: 0 };

describe("indexTotals", () => {
	it("counts queued, running, and outdated items as processing", () => {
		expect(
			indexTotals({ ...none, stats: { completed: 3, queued: 4, running: 2, outdated: 1 } }),
		).toEqual({ indexed: 3, processing: 7, failed: 0 });
	});

	it("counts skipped items and failed uploads as failed, not as processing", () => {
		expect(
			indexTotals({
				...none,
				stats: { completed: 8, error: 2, skipped: 1 },
				uploadFailures: [{}, {}, {}],
				droppedFailures: 1,
			}),
		).toEqual({ indexed: 8, processing: 0, failed: 7 });
	});

	it("counts a failed upload once, not also as the older item AI Search still holds", () => {
		expect(
			indexTotals({
				...none,
				stats: { completed: 12, running: 1, error: 1 },
				uploadFailures: [
					{ leftover: "indexed" },
					{ leftover: "indexed" },
					{ leftover: "processing" },
					{ leftover: "failed" },
					{},
				],
			}),
		).toEqual({ indexed: 10, processing: 0, failed: 5 });
	});

	it("counts listed items that AI Search's stats do not show yet as processing", () => {
		const listedItems = 7;
		expect(indexTotals({ ...none, listedItems, stats: { completed: 2 } }).processing).toBe(5);
		expect(
			indexTotals({
				...none,
				listedItems,
				stats: { completed: 5, error: 1, skipped: 1 },
			}).processing,
		).toBe(0);
	});

	it("counts uploads added to an index that already has items before the stats show them", () => {
		expect(indexTotals({ ...none, listedItems: 10, stats: { completed: 8 } })).toEqual({
			indexed: 8,
			processing: 2,
			failed: 0,
		});
	});

	it("is zero without an instance", () => {
		expect(indexTotals({ ...none, stats: null })).toEqual({
			indexed: 0,
			processing: 0,
			failed: 0,
		});
	});
});
