import { describe, expect, it } from "vitest";

import { groupEntriesByPublishedAt } from "../../../src/widgets/archives.js";

function entry(publishedAt: unknown) {
	return { data: { publishedAt } };
}

describe("groupEntriesByPublishedAt", () => {
	it("groups Date publishedAt values by month instead of skipping them", () => {
		const groups = groupEntriesByPublishedAt(
			[entry(new Date(2026, 2, 15)), entry(new Date(2026, 2, 20)), entry(new Date(2026, 1, 1))],
			{ type: "monthly" },
		);

		expect(groups).toEqual([
			{
				label: "March 2026",
				count: 2,
				url: "/archives/2026/03",
			},
			{
				label: "February 2026",
				count: 1,
				url: "/archives/2026/02",
			},
		]);
	});

	it("still accepts ISO date strings", () => {
		const groups = groupEntriesByPublishedAt([entry("2026-07-04T12:00:00.000Z")], {
			type: "monthly",
		});

		expect(groups).toHaveLength(1);
		expect(groups[0]?.count).toBe(1);
		expect(groups[0]?.url).toMatch(/^\/archives\/\d{4}\/\d{2}$/);
	});

	it("groups by year when type is yearly", () => {
		const groups = groupEntriesByPublishedAt(
			[entry(new Date(2026, 6, 1)), entry(new Date(2026, 0, 1)), entry(new Date(2025, 11, 1))],
			{ type: "yearly" },
		);

		expect(groups).toEqual([
			{ label: "2026", count: 2, url: "/archives/2026" },
			{ label: "2025", count: 1, url: "/archives/2025" },
		]);
	});

	it("skips missing and invalid publishedAt values", () => {
		const groups = groupEntriesByPublishedAt(
			[
				entry(null),
				entry(undefined),
				entry(""),
				entry("not-a-date"),
				entry(new Date(Number.NaN)),
				entry(new Date(2026, 4, 1)),
			],
			{ type: "monthly" },
		);

		expect(groups).toEqual([
			{
				label: "May 2026",
				count: 1,
				url: "/archives/2026/05",
			},
		]);
	});

	it("respects the limit", () => {
		const groups = groupEntriesByPublishedAt(
			[entry(new Date(2026, 0, 1)), entry(new Date(2026, 1, 1)), entry(new Date(2026, 2, 1))],
			{ type: "monthly", limit: 2 },
		);

		expect(groups).toHaveLength(2);
		expect(groups.map((group) => group.url)).toEqual(["/archives/2026/01", "/archives/2026/02"]);
	});
});
